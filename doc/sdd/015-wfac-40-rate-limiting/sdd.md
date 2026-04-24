# SDD — [WFAC-40] Rate Limiting Redis-backed

**HU**: WFAC-40
**Mode**: QUALITY (security-critical)
**Branch**: `feat/015-wfac-40-rate-limiting`
**Status**: F2 — awaiting `SPEC_APPROVED`
**Inputs**: `doc/sdd/015-wfac-40-rate-limiting/work-item.md`

---

## 1. Context & Goals

### 1.1 Problem

El facilitator expone `POST /verify`, `POST /settle`, `GET /supported` sin control
de flujo. Un atacante puede:

- Saturar `/settle` y causar denegación de servicio on-chain (RPC provider rate-limit
  → alza de costos, invalidación de nonces, disponibilidad degradada para clientes
  legítimos).
- Brute-force-scan `/verify` para timing side-channels sobre firmas EIP-3009.
- Scrapear `/supported` sin límite (menor severidad, pero costo de CPU en registry).

### 1.2 Outcome

Rate limit por IP con límites diferenciados por ruta, respaldado por Redis
(contadores compartidos entre instancias horizontales), **fail-open** si Redis
está caído, con respuesta x402-spec-compatible (JSON `{ error: { code, message, http } }`)
y headers `X-RateLimit-*`. Configurable vía env (5 vars nuevas). Audit hook
(WFAC-33) captura el 429 sin cambios al audit.

### 1.3 Scope boundaries

- **IN**: plugin registration en `buildApp()`, 5 env vars, per-route `config.rateLimit`,
  helper compartido `extractClientIp`, tests.
- **OUT**: RLS Postgres, per-user/per-api-key limits, sliding window, IP allowlist,
  dynamic updates sin restart.

---

## 2. Context Map — archivos leídos + patrones extraídos

| Archivo | Por qué se leyó | Patrón extraído |
|---------|-----------------|-----------------|
| `src/app.ts` | exemplar de `buildApp` + hook `onResponse` con extracción proxy-aware de IP (líneas 84-121) | Lógica XFF-first / `request.ip`-fallback ya inline; rotuladre: `const xff = request.headers['x-forwarded-for']`; `const first = xff.split(',')[0]?.trim() ?? null` |
| `src/infra/redis.ts` | firma `getRedisClient(): Redis \| null` + lifecycle idempotente | Caller debe tolerar `null`. `Redis` re-export desde `ioredis/index.d.ts` funciona en runtime y type position |
| `src/infra/env.ts` | Zod schema + `parseEnv()` fail-fast (process.exit(1) + stderr) | `z.coerce.number().int().min(...).default(...)`; defaults explícitos; WFAC-5 superRefine como patrón para cross-field si fuera necesario |
| `src/routes/verify.ts` | route plugin pattern + `VerifyRouteErrorCode` union local | `'INVALID_PAYLOAD'` vive como string literal en la union local, NO en `X402ErrorCode`. Precedente directo para `'RATE_LIMITED'` |
| `src/routes/settle.ts` | idempotency + audit flow; confirma que route maneja su propio shape | Mismo patrón que verify; no invalida nada del rate-limit |
| `src/routes/supported.ts` | ruta simple GET sin side effects | Un solo `app.get(...)`; agregar `config.rateLimit` en línea 30 es trivial |
| `src/routes/health.ts` | **exemplar de `config: { rateLimit: false }`** (línea 37) | Idéntico pattern se replica en `openapi.ts`; docstring WFAC-2 CD-9 confirma el patrón forward-compatible |
| `src/routes/openapi.ts` | ruta GET con respuesta estática | Sin `config` actual; ADD `config: { rateLimit: false }` |
| `src/core/errors.ts` | `X402ErrorCode` + `HTTP_BY_CODE` + `buildX402Error` | NO extender el union (CD-1). El 429 no es spec x402 |
| `src/index.ts` | `parseEnv(process.env)` → `buildApp({ env })` | Single-parse pattern (MNR-1). Nuestra HU no lo rompe (sólo extiende `EnvSchema`) |
| `node_modules/@fastify/rate-limit/types/index.d.ts` | confirmar API pública | `RateLimitPluginOptions.redis` es `any` — acepta ioredis directo. `errorResponseBuilderContext` expone `{ statusCode, ban, after, max, ttl }` — **no incluye `key` ni el IP** (perfecto para CD-4 PII). `FastifyContextConfig.rateLimit` es `RateLimitOptions \| false` |
| `node_modules/@fastify/rate-limit/index.js` (líneas 115-124) | comportamiento del plugin con `settings.redis` | Usa `new RedisStore(..., settings.redis, settings.nameSpace)` — pasa la instancia **directamente**. Si `settings.redis` es undefined cae a `LocalStore`. Shape confirmado: `@fastify/rate-limit v10.3.0` acepta `ioredis.Redis` sin wrapper |
| `node_modules/@fastify/rate-limit/store/RedisStore.js` | cómo usa la instancia | Llama `this.redis.defineCommand('rateLimit', ...)` — interfaz de ioredis nativa. **Confirmado: shape OK**. Si `skipOnError=true`, el callback de `incr()` llama `cb(err, null)` y el plugin deja pasar el request (ver `index.js` línea ~250 `onRequestFn`) |
| `src/__tests__/unit/routes.verify.test.ts` (líneas 36-85) | patrón de mock para `ioredis` + `core/audit.js` + `app.inject()` | Reutilizable para rate-limit tests: el `RedisMock` ya soporta `on(event, handler)`; hay que extender con `defineCommand` / `rateLimit` stub |
| `src/__tests__/unit/env.test.ts` | patrón para tests de `parseEnv` con `process.exit` stub | Copiar para las nuevas env vars |
| `doc/sdd/014-wfac-33-audit-log/auto-blindaje.md` | lecciones recientes | `light-my-request` inyecta UA default `'lightMyRequest'`; `idempotencyKey` shape real incluye prefijo. Ninguno aplica directamente — ver §10 CD-LESSONS |
| `doc/sdd/013-wfac-32-settlement-ledger/auto-blindaje.md` | lecciones recientes | ESLint `no-unused-vars` fix requiere `grep` global antes de commit. `eslint-plugin-no-secrets` trips en JSDoc con strings entropy-like. Ver §10 CD-LESSONS |
| `doc/sdd/012-wfac-23-openapi-spec/auto-blindaje.md` | lecciones recientes | `security/detect-object-injection` exige `// eslint-disable-next-line` con justificación. `prettier --write` antes de `format:check`. Ver §10 CD-LESSONS |
| `OWNERS.md` | boundaries | `src/core/` MAY importar `src/infra/*`. `src/routes/` MAY importar `src/core/*` + `src/infra/*`. Helper `extractClientIp` en `src/core/network.ts` puede ser consumido desde `src/app.ts` (que no tiene boundary restringido) |

---

## 3. Architecture Decisions

### 3.1 Deferred resueltos (del work-item)

#### DT-8 — `extractClientIp` helper location: `src/core/network.ts` (NEW file)

**Decisión**: nuevo módulo `src/core/network.ts` exporta `extractClientIp(request: FastifyRequest): string | null`.

**Justificación**:
1. **DRY**: hoy la lógica vive inline en `src/app.ts` líneas 88-99 para el audit
   hook. El keyGenerator del rate-limit necesita exactamente la misma extracción.
   Duplicar la lógica viola la lección de `redactRedisUrl` (WFAC-5): utilidades
   de extracción de strings sensibles van a un único punto.
2. **Boundary correcto (OWNERS.md)**:
   - `src/core/*` MAY import `src/infra/*` + primitives → sin violación.
   - `src/app.ts` importa de `src/core/*` y `src/infra/*` → sin violación.
   - No está en `src/middleware/` porque el helper es `pure` (no un plugin);
     aplica la regla [1] de OWNERS (zero runtime deps más allá de tipos Fastify).
3. **Futuro-compatible**: futuras HUs de security (geo-block, allowlist, CIDR
   match) construyen sobre este helper.
4. **Alternativa descartada (Opción B — inline en `app.ts`)**: duplica código y
   fuerza que cualquier refactor (ej. soporte para `Forwarded` RFC 7239) toque
   dos lugares. Violaría DRY + lección `redactRedisUrl`.

**Contenido del módulo**: 1 función pura + 0 runtime deps + 0 side effects.

```ts
// src/core/network.ts — ZERO runtime deps, pure
import type { FastifyRequest } from 'fastify';

/**
 * Extract the client IP using the proxy-aware convention.
 *
 * Precedence (per WFAC-33 DT-2, reused here):
 *   1. First element of `X-Forwarded-For` (when header present and non-empty),
 *      left-trimmed.
 *   2. `request.ip` (Fastify default; respects `trustProxy` config).
 *   3. `null` if neither yields a non-empty string.
 *
 * Pure — no logging, no throw, no I/O.
 *
 * Consumers:
 *   - `src/app.ts` onResponse audit hook (WFAC-33).
 *   - `src/app.ts` rate-limit plugin keyGenerator (WFAC-40).
 */
export function extractClientIp(request: FastifyRequest): string | null {
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
    const first = xff[0].split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  if (typeof request.ip === 'string' && request.ip.length > 0) return request.ip;
  return null;
}
```

**Refactor de `src/app.ts`**: el audit hook reemplaza el bloque inline (líneas 88-99)
por `const ipRaw = extractClientIp(request);`. El comportamiento observable NO
cambia (tests actuales de audit siguen verdes).

---

#### DT-9 — ioredis client shape acceptance: **compatible directamente**

**Decisión**: pasar la instancia de `getRedisClient()` (tipo `Redis | null`) como
`redis: <ioredisInstance>` en las opciones del plugin `@fastify/rate-limit`.
NO wrapper, NO `{ client: ... }`, NO adapter.

**Evidencia empírica** (lectura directa de `node_modules`):
- `@fastify/rate-limit/index.js` líneas 119-123: `new RedisStore(..., settings.redis, ...)` — pasa la referencia tal cual.
- `@fastify/rate-limit/store/RedisStore.js` línea 40-45: llama `this.redis.defineCommand(...)` (API nativa de ioredis v5 — https://github.com/redis/ioredis#lua-scripting).
- `@fastify/rate-limit/types/index.d.ts` línea 157: `redis?: any` (tipo abierto por diseño — ya acepta `ioredis.Redis`).
- `@fastify/rate-limit/package.json` requiere `ioredis` como peer (histórico).

**Implicación**:
- En desarrollo/producción (`REDIS_URL` presente): `getRedisClient()` → `Redis` instance → plugin usa `RedisStore`.
- En test (`REDIS_URL` absent): `getRedisClient()` → `null` → plugin recibe `redis: null`, cae al `LocalStore` in-memory — **sin afectar los tests existentes que no piensan en rate-limit** (porque el global `max` queda muy alto para test o se desactiva con `RATE_LIMIT_ENABLED=false`).

---

#### DT-10 — Fail-open cuando Redis down: `skipOnError: true` + LocalStore fallback

**Decisión**: combinación de dos mecanismos:

1. **Plugin config `skipOnError: true`**: si una llamada a `store.incr()` falla
   (Redis down mid-request), el plugin llama al handler normal sin 429.
   Confirmed via `@fastify/rate-limit/index.js` línea 108 (lee la opción) y
   comportamiento documented en README.md del plugin.
2. **LocalStore fallback en boot**: si `getRedisClient()` devuelve `null` al
   momento de registrar el plugin (REDIS_URL absent — test env), no pasamos
   `redis` al plugin. El plugin entonces usa `LocalStore` (in-memory),
   permitiendo la bootstrap sin crash.

**AC-10 literal**: "IF the Redis store is unavailable or the connection times out
during rate-limit counter read/write, THEN the system SHALL fail-open". Con
`skipOnError: true`, esta garantía se cumple **en runtime** (Redis se cae
después del boot). Con LocalStore fallback se cumple **en boot** (REDIS_URL
nunca estuvo). Ambas ramas cubiertas.

**Alternativa descartada (fail-closed)**: bloquear toda la API si Redis down es
peor que permitir tráfico sin límite durante outage. Consistente con WFAC-5
(idempotency fail-open) y con el espíritu del work-item.

---

#### DT-11 — `errorResponseBuilder` produce body spec-literal + emite log `warn`

**Decisión**: proveer un callback custom `errorResponseBuilder(req, ctx)` en la
config global del plugin. El body devuelto es EXACTO:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later", "http": 429 } }
```

**Mecánica** (confirmed via `types/index.d.ts` líneas 59-66 + `index.js` líneas 100-106):

- El callback recibe `(req: FastifyRequest, context: errorResponseBuilderContext)`.
  El contexto expone `{ statusCode, ban, after, max, ttl }` — **no incluye IP**
  (perfecto para CD-4).
- Si el callback retorna un objeto, Fastify lo serializa a JSON automáticamente
  (behavior confirmed en Fastify v5 + el plugin con `isCustomErrorMessage: true`).
- El **log `warn`** (AC-9) se emite ANTES del return, usando `req.log.warn(...)`
  con `request_id` + `path` (proxy-aware via `req.routeOptions.url`).
  **Sin IP en el payload estructurado** (CD-4).

**Implementación**:

```ts
// src/app.ts — dentro de buildApp, antes de registrar rutas
await app.register(rateLimit, {
  global: true,
  max: env.RATE_LIMIT_VERIFY_MAX, // global fallback (overridden per-route)
  timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000, // seconds → ms
  skipOnError: true,                             // DT-10
  redis: getRedisClient() ?? undefined,          // DT-9 (null → LocalStore)
  keyGenerator: (req) => extractClientIp(req) ?? req.ip, // DT-8 + defensive fallback
  enableDraftSpec: false, // DT-12 — use default headers (X-RateLimit-*)
  errorResponseBuilder: (req, context) => {
    req.log.warn(
      {
        request_id: req.id,
        path: req.routeOptions?.url ?? req.url,
        rate_limit_max: context.max,
        rate_limit_ttl_ms: context.ttl,
      },
      'rate limit exceeded',
    );
    // Note: request.auditMeta is NOT set here — the plugin intercepts the
    // request at the `onRequest` hook, BEFORE the route handler runs. The
    // audit hook in `onResponse` runs anyway (Fastify v5 lifecycle — AC-11)
    // and will record statusCode=429 + path + request_id without errorCode.
    // If a future HU wants errorCode='RATE_LIMITED' in the audit row, a new
    // `onRequest` hook registered AFTER the plugin would need to set
    // `request.auditMeta.errorCode` on 429-marked requests — deferred.
    return {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
        http: 429,
      },
    };
  },
});
```

**`RATE_LIMITED` literal**: vive SÓLO dentro de este callback, como string en
posición literal (sin interfaz TS, sin constante exportada). No extiende
`X402ErrorCode` (CD-1).

---

#### DT-12 — Headers X-RateLimit-*: usar la variante default (NO draft spec)

**Decisión**: `enableDraftSpec: false` (o simplemente omitir — default is false).

**Justificación**:
- AC-5 literal: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
  (con prefijo `X-`, convención informal pero más implementada).
- `enableDraftSpec: true` emitiría `RateLimit-Limit` etc. (IETF draft sin el
  prefijo `X-`).
- El work-item cita los headers con prefijo `X-` → la opción default aplica.

Confirmed via `@fastify/rate-limit/index.js` líneas 13-18 (defaultHeaders) vs
líneas 20-25 (draftSpecHeaders).

---

#### DT-13 — Per-route config pattern: `config.rateLimit = { max: env.X, timeWindow: env.Y * 1000 }`

**Decisión**: cada ruta pública afectada declara su propio `config.rateLimit`
leyendo valores del `env` capturado en el closure del plugin de ruta.

**Mecánica técnica**:

- `FastifyPluginAsync` recibe `app: FastifyInstance`, no el env directamente.
- Hoy las rutas NO tienen acceso a `env` porque no lo necesitan.
- **Aproximación recomendada**: extender la firma del plugin para aceptar
  `env` por `opts` de `app.register()`, O pasar `env` vía decorator
  (`app.decorate('env', env)`).
- **Decisión**: **decorator**, idéntico patrón a cómo hoy `app.log` está
  disponible globalmente. Simple, sin cambiar firmas de route plugins.

```ts
// src/app.ts
app.decorate('env', env);

// src/routes/verify.ts (y settle.ts, supported.ts)
export const verifyRoute: FastifyPluginAsync = async (app) => {
  const env = (app as FastifyInstance & { env: EnvConfig }).env;
  app.post(
    '/verify',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_VERIFY_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => { /* handler actual unchanged */ },
  );
};
```

**TypeScript augmentation** (opcional pero recomendado — evita cast):

```ts
// src/app.ts, al tope del archivo
declare module 'fastify' {
  interface FastifyInstance {
    env: EnvConfig;
  }
}
```

**Alternativa descartada (pasar `env` vía `app.register(verifyRoute, { env })`)**:
fuerza cambio de firma en `buildApp` para cada ruta y en los tests existentes
(routes.verify.test.ts importa `verifyRoute` y lo registra con `{ }`). Ruptura
innecesaria.

---

#### DT-14 — `RATE_LIMIT_ENABLED=false` bypass global

**Decisión**: cuando `env.RATE_LIMIT_ENABLED === false`, **no se registra** el
plugin. Las rutas que declaran `config.rateLimit` lo declaran siempre, pero
Fastify ignora esa config si el plugin nunca agregó el hook `onRoute`.

**Mecánica** (confirmed via `@fastify/rate-limit/index.js` línea 142):
- El plugin registra `fastify.addHook('onRoute', ...)` que procesa
  `routeOptions.config.rateLimit` ONLY si el plugin está cargado.
- Si el plugin no se carga → las rutas tienen `config.rateLimit` declarado pero
  nadie lo lee → zero-overhead bypass.

```ts
// src/app.ts
if (env.RATE_LIMIT_ENABLED) {
  await app.register(rateLimit, { /* ... */ });
}
```

**Alternativa descartada (registrar el plugin con `max: Infinity`)**: aún ejecuta
el hook `onRequest` en cada request (overhead constante) y aún llama a Redis
(carga innecesaria). El bypass por no-registration es más limpio.

---

### 3.2 Decisiones heredadas del work-item (confirmadas, sin cambios)

- **DT-1**: usar `@fastify/rate-limit` v10.3.0 (ya en `package.json`). Confirmado.
- **DT-2**: NO extender `X402ErrorCode` con `'RATE_LIMITED'`. Confirmado (CD-1).
- **DT-3**: fail-open. Confirmado y expandido en DT-10.
- **DT-4**: IP extraction reuse. Confirmado y resuelto en DT-8.
- **DT-5**: plugin registration order: antes de `app.register(routes)`.
  Confirmado — W1 en §8.
- **DT-6**: per-route config vía `config.rateLimit`. Confirmado y expandido en DT-13.
- **DT-7**: `errorResponseBuilder` global. Confirmado y expandido en DT-11.

---

## 4. Env Schema additions

### 4.1 5 nuevas vars — contrato exacto para `EnvSchema`

| Env var | Tipo Zod | Default | Mín | Max | Validación |
|---------|----------|---------|-----|-----|------------|
| `RATE_LIMIT_ENABLED` | `z.string().transform(v => v === 'true').default('true')` — accepts literal `'true'/'false'` strings; defaults to `true` | `true` | — | — | coerción explícita string→boolean |
| `RATE_LIMIT_WINDOW_SEC` | `z.coerce.number().int().min(1).default(60)` | `60` | `1` | — | segundos, min 1 |
| `RATE_LIMIT_VERIFY_MAX` | `z.coerce.number().int().min(1).default(60)` | `60` | `1` | — | requests/window |
| `RATE_LIMIT_SETTLE_MAX` | `z.coerce.number().int().min(1).default(30)` | `30` | `1` | — | requests/window (más restrictivo — on-chain write) |
| `RATE_LIMIT_SUPPORTED_MAX` | `z.coerce.number().int().min(1).default(120)` | `120` | `1` | — | requests/window (más laxo — discovery read-only) |

### 4.2 Patch propuesto sobre `EnvSchema`

```ts
export const EnvSchema = z
  .object({
    // ... existing fields ...

    // WFAC-40 — rate limiting (§4.1 of SDD).
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_SETTLE_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_SUPPORTED_MAX: z.coerce.number().int().min(1).default(120),
  })
  .superRefine((data, ctx) => { /* existing WFAC-5 check unchanged */ });
```

**Por qué `z.enum(['true','false']).default('true').transform(...)`** en vez de
`z.boolean()`:
- `process.env.X` siempre es `string | undefined`. `z.boolean()` sólo acepta
  `true/false` reales (no string).
- `z.coerce.boolean()` coerciona `'false'` como truthy (cualquier string
  non-empty) — **bug sutil, prohibido** (AC-6 requiere que `RATE_LIMIT_ENABLED=false`
  bypassee el rate limit; `z.coerce.boolean()` lo interpretaría como `true`).
- La enum + transform es explícita y se alinea con el patrón usado en otros
  proyectos wasiai para booleans-en-env.

**AC-12 cubierto**: un `RATE_LIMIT_WINDOW_SEC=-1` o `RATE_LIMIT_VERIFY_MAX=0`
hace fail-fast en `parseEnv` (process.exit(1) + stderr con mensaje human-readable).

---

## 5. Plugin registration strategy en `app.ts`

### 5.1 Orden en `buildApp()`

```
1. parseEnv / use env
2. createLogger
3. initRedis(env, logger)
4. initSupabase(env, logger)
5. const app = Fastify({...})
6. app.decorate('env', env)              ← NEW (DT-13)
7. if (env.RATE_LIMIT_ENABLED) {         ← NEW (DT-14)
     await app.register(rateLimit, {...}) ← DT-5 — antes de rutas
   }
8. await app.register(healthRoute)
9. await app.register(verifyRoute)
10. await app.register(settleRoute)
11. await app.register(supportedRoute)
12. await app.register(openapiRoute)
13. app.addHook('onResponse', /* audit WFAC-33 */)
14. app.addHook('onClose', /* redis quit WFAC-5 */)
```

**Por qué el plugin va entre `app.decorate('env')` y las rutas**: el plugin se
lee `config.rateLimit` de cada ruta en el hook `onRoute`, que se dispara
cuando cada ruta se registra. Si el plugin estuviera **después**, las rutas
ya registradas no tendrían el hook aplicado.

### 5.2 Options completas del register

```ts
const redisClient = getRedisClient(); // Redis | null

await app.register(rateLimit, {
  global: true,
  // Fallbacks globales — sólo activos si una ruta NO declara config.rateLimit.
  // Las 3 rutas públicas SÍ declaran el suyo (verify/settle/supported), así
  // que estos valores nunca son los que efectivamente se usan; existen como
  // defensive default por si alguien agrega una ruta nueva sin config.
  max: env.RATE_LIMIT_VERIFY_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
  skipOnError: true, // DT-10
  // DT-9: ioredis instance directamente. `?? undefined` → LocalStore fallback
  // cuando getRedisClient() devuelve null (test env).
  redis: redisClient ?? undefined,
  keyGenerator: (req) => {
    // DT-8 — delega al helper central. Defensive fallback `req.ip` por si
    // extractClientIp retorna null (no debería en requests HTTP reales).
    return extractClientIp(req) ?? req.ip ?? 'unknown';
  },
  enableDraftSpec: false, // DT-12 — mantener headers X-RateLimit-*
  errorResponseBuilder: (req, context) => {
    req.log.warn(
      {
        request_id: req.id,
        path: req.routeOptions?.url ?? req.url,
        rate_limit_max: context.max,
        rate_limit_ttl_ms: context.ttl,
      },
      'rate limit exceeded',
    );
    return {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
        http: 429,
      },
    };
  },
});
```

### 5.3 Import statements a agregar

```ts
// src/app.ts — nuevas imports al tope
import rateLimit from '@fastify/rate-limit';
import { extractClientIp } from './core/network.js';
```

---

## 6. Per-route config changes

### 6.1 `src/routes/verify.ts` — cambio mínimo

**Antes** (línea 62):
```ts
app.post('/verify', async (request, reply) => { /* ... */ });
```

**Después**:
```ts
const env = (app as FastifyInstance & { env: EnvConfig }).env;
app.post(
  '/verify',
  {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_VERIFY_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
      },
    },
  },
  async (request, reply) => { /* handler intact */ },
);
```

**Nota**: si el TypeScript augmentation de §3.1 DT-13 se declara en `src/app.ts`,
el cast no es necesario. Preferible: declarar el augmentation en un nuevo
file `src/core/fastify-augment.ts` o al tope de `src/app.ts`.

### 6.2 `src/routes/settle.ts` — idéntico patrón, env var = `RATE_LIMIT_SETTLE_MAX`

### 6.3 `src/routes/supported.ts` — idéntico, env var = `RATE_LIMIT_SUPPORTED_MAX`

### 6.4 `src/routes/openapi.ts` — agregar `config: { rateLimit: false }`

**Antes** (línea 56):
```ts
app.get('/openapi.json', async (_request, reply) => { /* ... */ });
```

**Después**:
```ts
app.get(
  '/openapi.json',
  { config: { rateLimit: false } }, // WFAC-40 CD-6 — mirrors /health
  async (_request, reply) => { /* handler intact */ },
);
```

### 6.5 `src/routes/health.ts` — SIN CAMBIOS

Línea 37 ya declara `config: { rateLimit: false }` desde WFAC-2 (CD-9).
Sólo confirmar en tests que sigue funcionando post-WFAC-40.

---

## 7. `extractClientIp` helper + audit hook refactor

### 7.1 Nuevo módulo — `src/core/network.ts`

Ya especificado en §3.1 DT-8. Zero runtime deps más allá de tipo Fastify.

### 7.2 Refactor de `src/app.ts` onResponse hook

**Antes** (líneas 88-99):
```ts
const xff = request.headers['x-forwarded-for'];
let ipRaw: string | null = null;
if (typeof xff === 'string' && xff.length > 0) {
  const first = xff.split(',')[0];
  ipRaw = first ? first.trim() : null;
} else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
  const first = xff[0].split(',')[0];
  ipRaw = first ? first.trim() : null;
} else if (typeof request.ip === 'string' && request.ip.length > 0) {
  ipRaw = request.ip;
}
```

**Después**:
```ts
import { extractClientIp } from './core/network.js';
// ...
const ipRaw = extractClientIp(request);
```

**Tests de audit**: `src/__tests__/unit/audit.test.ts` y `routes.verify.test.ts`
deben seguir verdes **sin cambios** (comportamiento observable idéntico).
Si algún test falla, significa que el helper no es equivalente — parar y revisar.

---

## 8. Waves de implementación

### Wave 1 (SERIAL) — Env + helper + plugin skeleton + types augmentation

**Objetivo**: infra lista. Sin per-route config todavía. App arranca con
rate-limit global aplicándose a todas las rutas con defaults.

**Archivos tocados**:
- `src/infra/env.ts` — agregar 5 vars al `EnvSchema`.
- `src/core/network.ts` — NEW, export `extractClientIp`.
- `src/app.ts`:
  - Import `rateLimit` + `extractClientIp`.
  - Declare module `'fastify'` augmentation (`FastifyInstance.env`).
  - `app.decorate('env', env)` después del `Fastify({...})`.
  - Registrar `rateLimit` condicionalmente en `env.RATE_LIMIT_ENABLED`.
  - Refactor audit hook a usar `extractClientIp(request)`.

**Tests W1**:
- `env.test.ts`: 5 nuevos tests — defaults, override, fail-fast en valores inválidos.
- `audit.test.ts` (o equivalente de integration): smoke — audit hook sigue funcionando post-refactor.
- NEW `network.test.ts`: unit tests puros de `extractClientIp` (XFF string, XFF array, fallback `request.ip`, empty inputs → null).

**Done Criteria W1**:
- `npm run typecheck` OK.
- `npm test` pasa (sin romper nada previo).
- `parseEnv({ RATE_LIMIT_WINDOW_SEC: '-1' })` → process.exit(1).

---

### Wave 2 (PARALELIZABLE) — Per-route config

**Objetivo**: cada ruta pública declara su `config.rateLimit`. `openapi.ts`
declara `rateLimit: false`.

**Archivos tocados** (independientes entre sí):
- `src/routes/verify.ts` — agregar `config.rateLimit` + leer env.
- `src/routes/settle.ts` — idem, env var distinto.
- `src/routes/supported.ts` — idem.
- `src/routes/openapi.ts` — agregar `config: { rateLimit: false }`.
- `src/routes/health.ts` — **no tocar** (W1 ya está — confirmar vía test).

**Tests W2**:
- `routes.verify.test.ts`: nuevo test — enviar `RATE_LIMIT_VERIFY_MAX + 1`
  requests, expect 429 en el último + headers `X-RateLimit-*` presentes.
- `routes.settle.test.ts`: idem con `RATE_LIMIT_SETTLE_MAX`.
- `routes.supported.test.ts`: idem con `RATE_LIMIT_SUPPORTED_MAX`.
- `routes.openapi.test.ts`: 1 test — 200 requests rápidas a `/openapi.json`
  nunca retornan 429.
- `health.test.ts`: actualmente tiene el test de línea 216 (`route config has rateLimit: false`) — confirmar que sigue verde.

**Done Criteria W2**:
- Todos los tests W2 pasan.
- `npm run qa` OK.

---

### Wave 3 (SERIAL) — Edge cases + integration + negative tests

**Objetivo**: cubrir AC residuales.

**Archivos tocados** (tests únicamente):
- NEW `src/__tests__/unit/rate-limit.test.ts` — tests cross-cutting (ver §9).

**Tests W3**:
- T-RL-1: 429 body shape EXACTO `{ error: { code: 'RATE_LIMITED', message, http: 429 } }`
  (JSON.parse del body; no extra keys) — AC-4.
- T-RL-2: 429 incluye headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` — AC-5.
- T-RL-3: `RATE_LIMIT_ENABLED=false` → N+1 requests todas 200 — AC-6.
- T-RL-4: `/health` no tiene headers `X-RateLimit-*` y nunca retorna 429 — AC-7.
- T-RL-5: `/openapi.json` no tiene headers `X-RateLimit-*` y nunca retorna 429 — AC-7.
- T-RL-6: con `REDIS_URL` absent (test env default) la app arranca — AC-10 rama fail-open boot.
- T-RL-7: con Redis mock que tira error en `defineCommand`/`rateLimit` eval (simulando
  runtime outage), el request NO retorna 429 (proceeds to handler) — AC-10 rama fail-open runtime.
- T-RL-8: 429 emite `warn` log con `request_id` + `path`, SIN campo `ip` en
  el payload estructurado — AC-9 + CD-4.
- T-RL-9: 429 emite row en audit (`status_code=429`) — AC-11 (requiere audit mock
  + verificar `persistAuditEntry` llamado con `statusCode: 429`).
- T-RL-10: IP de `X-Forwarded-For` se usa como key (dos IPs distintas en XFF
  no comparten cuota) — AC-8.

**Done Criteria W3 = Done Criteria HU**:
- `npm run qa` OK.
- `npm test:coverage` — los nuevos archivos con ≥80% de cobertura de líneas.
- Manual smoke: levantar el server con `npm run dev`, hacer `curl -X POST /verify`
  61 veces → #61 retorna 429 con el body spec exacto.

---

## 9. Test Plan por AC

| AC | Descripción | Test(s) | Ubicación |
|----|-------------|---------|-----------|
| AC-1 | 429 en `/verify` > `RATE_LIMIT_VERIFY_MAX` | T-RL-verify-1 | `routes.verify.test.ts` (W2) |
| AC-2 | 429 en `/settle` > `RATE_LIMIT_SETTLE_MAX` | T-RL-settle-1 | `routes.settle.test.ts` (W2) |
| AC-3 | 429 en `/supported` > `RATE_LIMIT_SUPPORTED_MAX` | T-RL-supported-1 | `routes.supported.test.ts` (W2) |
| AC-4 | 429 body shape exact | T-RL-1 | `rate-limit.test.ts` (W3) |
| AC-5 | Headers X-RateLimit-* presentes en 429 | T-RL-2 | `rate-limit.test.ts` (W3) |
| AC-6 | `RATE_LIMIT_ENABLED=false` bypass | T-RL-3 | `rate-limit.test.ts` (W3) |
| AC-7 | `/health` y `/openapi.json` exentas | T-RL-4, T-RL-5 | `rate-limit.test.ts` (W3), `health.test.ts` (confirm), `routes.openapi.test.ts` (W2) |
| AC-8 | XFF first element para la key | T-RL-10 | `rate-limit.test.ts` (W3) + `network.test.ts` (W1 — unidad del helper) |
| AC-9 | Warn log con request_id + path, sin IP | T-RL-8 | `rate-limit.test.ts` (W3) — con CaptureStream |
| AC-10 | Fail-open Redis down | T-RL-6, T-RL-7 | `rate-limit.test.ts` (W3) — mock ioredis throwing |
| AC-11 | Audit row con `status_code=429` | T-RL-9 | `rate-limit.test.ts` (W3) — con audit mock |
| AC-12 | Fail-fast en env inválido | T-env-rate-limit-invalid-* (5 tests) | `env.test.ts` (W1) |

**Cobertura total esperada**: ≥12 tests nuevos (4 en W1, ≥4 en W2, ≥10 en W3).

---

## 10. Constraint Directives — heredados + extensiones

### 10.1 Heredados del work-item (sin cambios)

- **CD-1**: PROHIBIDO extender `X402ErrorCode` con `'RATE_LIMITED'`.
- **CD-2**: OBLIGATORIO fail-open cuando Redis no está disponible.
- **CD-3**: Response body EXACTAMENTE `{ error: { code, message, http } }` — sin campos extra.
- **CD-4**: PROHIBIDO PII (IP) en logs estructurados de Pino (payload).
- **CD-5**: OBLIGATORIO registrar el plugin ANTES de rutas.
- **CD-6**: OBLIGATORIO `config: { rateLimit: false }` en `/openapi.json`.
- **CD-7**: PROHIBIDO magic numbers — siempre via `env.RATE_LIMIT_*`.
- **CD-8**: OBLIGATORIO env var validation en `parseEnv` — fail-fast.

### 10.2 Extensiones específicas del SDD

- **CD-9 (NEW)**: `extractClientIp` vive EXCLUSIVAMENTE en `src/core/network.ts`.
  Prohibido reimplementar la lógica XFF-first en ningún otro archivo
  (audit hook, rate-limit keyGenerator, futuros consumers). Cualquier diff
  que agregue `request.headers['x-forwarded-for'].split(',')` en otro archivo
  → AR BLOQUEANTE.

- **CD-10 (NEW)**: el `errorResponseBuilder` del plugin DEBE emitir el body
  construyendo el objeto EXPLÍCITAMENTE (`{ error: { code: 'RATE_LIMITED', message: '...', http: 429 } }`),
  NO via spread de context o helper externo. Lección: auto-blindaje W1 de
  WFAC-20 (explicit object build para evitar extra-field leaks).

- **CD-11 (NEW)**: `RATE_LIMITED` NO tiene interfaz, constante exportada, ni
  tipo TS asociado. Vive 100% como string literal en la función
  `errorResponseBuilder` y (opcionalmente) en la unión de tipos local del
  route si fuera necesario tests — pero preferentemente sólo en el callback.
  Lección: DT-7 WFAC-20 (`INVALID_PAYLOAD` vive como literal local).

- **CD-12 (NEW)**: el `RATE_LIMIT_ENABLED` env var DEBE usar `z.enum(['true','false']).transform(v => v === 'true')`.
  PROHIBIDO usar `z.coerce.boolean()` (interpreta `'false'` como truthy).
  Justificación en §4.2.

- **CD-13 (NEW)**: el plugin se registra condicionalmente — si
  `env.RATE_LIMIT_ENABLED === false`, `app.register(rateLimit, ...)` NO
  se llama. PROHIBIDO registrar el plugin con `max: Infinity` o similar.

### 10.3 CD-LESSONS — aprendizajes de auto-blindajes recientes

- **CD-LESSON-1** (de WFAC-33 auto-blindaje): `light-my-request` inyecta
  `user-agent: 'lightMyRequest'` por default. Si un test quiere ejercer el
  path "header ausente", usar `headers: { 'user-agent': '' }` explícito.
  Aplicable a los tests T-RL-8 si se quiere validar ausencia de UA en el log
  structured (pero como AC-9 sólo exige ausencia de IP, no de UA, es
  menos probable que aparezca).

- **CD-LESSON-2** (de WFAC-32 auto-blindaje): al borrar una variable/symbol
  en fix ESLint `no-unused-vars`, correr `rg <name> src/` antes del commit
  para encontrar referencias residuales. Aplica si en W3 limpiamos tests
  intermedios.

- **CD-LESSON-3** (de WFAC-23 auto-blindaje): si ESLint
  `security/detect-object-injection` dispara sobre lookups dinámicos en
  `Record<_, _>`, agregar `// eslint-disable-next-line` con justificación.
  Aplicable al lookup `context.max` / `context.ttl` en el
  `errorResponseBuilder` si ESLint lo marca.

- **CD-LESSON-4** (de WFAC-23 auto-blindaje): correr `npx prettier --write`
  en archivos nuevos antes de `npm run format:check`. Obligatorio para
  `src/core/network.ts`, `src/__tests__/unit/network.test.ts`,
  `src/__tests__/unit/rate-limit.test.ts`.

---

## 11. Exemplar verification

Todos verificados con `Read` y `Glob` durante §2 Context Map.

| Exemplar | Path | Verificado | Uso |
|----------|------|------------|-----|
| XFF extraction inline | `src/app.ts:87-99` | ✅ Read | se refactoriza a `extractClientIp` |
| Redis singleton return type | `src/infra/redis.ts:82` (`getRedisClient(): Redis \| null`) | ✅ Read | plugin recibe `Redis \| undefined` |
| Env Zod coerce pattern | `src/infra/env.ts:16` (`z.coerce.number().int().min(1).max(65535).default(3002)`) | ✅ Read | replicar para las 4 vars numéricas |
| Route plugin con `config.rateLimit: false` | `src/routes/health.ts:37` | ✅ Read | replicar en `openapi.ts` |
| Route plugin con handler simple | `src/routes/supported.ts:30-54` | ✅ Read | menor superficie para agregar config |
| Union local route-error | `src/routes/verify.ts:37-48` | ✅ Read | mentality: `RATE_LIMITED` sigue el mismo pattern a nivel callback (no union aquí) |
| Fastify hook lifecycle onResponse post-429 | `src/app.ts:84` + Fastify v5 docs | ✅ confirmado via audit hook behavior | AC-11 requiere que `onResponse` corra — SI corre |
| Plugin internal API | `node_modules/@fastify/rate-limit/index.js:100-158` + `types/index.d.ts` | ✅ Read | confirmado `redis: any`, `errorResponseBuilder(req, ctx)`, `skipOnError`, `config.rateLimit: false` |
| Test pattern mock ioredis + audit | `src/__tests__/unit/routes.verify.test.ts:36-90` | ✅ Read | reutilizable en `rate-limit.test.ts` con extensión `defineCommand`/`rateLimit` stubs |
| Test pattern parseEnv + process.exit | `src/__tests__/unit/env.test.ts:22-44` | ✅ Read | replicar para AC-12 |

---

## 12. Readiness Check

| Checklist item | Status |
|----------------|--------|
| Work-item leído completamente | ✅ |
| `project-context.md` (via OWNERS.md + CLAUDE.md) | ✅ |
| Scope IN matches work-item | ✅ 7 archivos prod + ≥3 tests |
| Scope OUT explícito | ✅ RLS, per-user, allowlist, dynamic updates |
| Todos los AC tienen al menos 1 test mapeado | ✅ (§9) |
| Todos los `[NEEDS CLARIFICATION]` del work-item resueltos | ✅ DT-8 (ubicación helper), DT-9 (ioredis shape) |
| Exemplars verificados con Glob/Read | ✅ (§11) |
| CDs heredadas + extensiones documentadas | ✅ (§10) |
| Waves claras con archivos exactos por wave | ✅ (§8) |
| Test plan detallado por AC | ✅ (§9) |
| Auto-blindaje lessons extraídas de últimas HUs DONE | ✅ (CD-LESSON-1..4) |
| Ningún `[NEEDS CLARIFICATION]` en el SDD | ✅ |
| Boundaries OWNERS.md respetados | ✅ `src/core/network.ts` es imported desde `src/app.ts` (permitido) |
| Stack fijo (Fastify v5, ioredis v5, Zod v3, @fastify/rate-limit v10.3.0) respetado | ✅ |

**READY FOR SPEC_APPROVED**: ✅

---

## 13. Resumen ejecutivo (para el orquestador)

- **Deferred 1 (IP helper location)**: `src/core/network.ts` (new file, zero deps). Consumido por audit hook + rate-limit keyGenerator.
- **Deferred 2 (ioredis shape)**: compatible directamente. Evidencia en `node_modules/@fastify/rate-limit/index.js:119` + `RedisStore.js:40-45`. Se pasa como `redis: getRedisClient() ?? undefined`.
- **Fail-open**: doble mecanismo — `skipOnError: true` (runtime) + LocalStore fallback cuando Redis null en boot.
- **Response shape spec-literal**: via `errorResponseBuilder` con body explícito (CD-10). `'RATE_LIMITED'` vive ONLY en ese callback (CD-1, CD-11).
- **`RATE_LIMIT_ENABLED=false` bypass**: no se registra el plugin (zero overhead).
- **Per-route config**: env accesible en rutas via `app.decorate('env', env)` + TypeScript module augmentation.
- **AC-11 audit**: zero cambios al audit hook — Fastify v5 garantiza que `onResponse` corre post-429.
- **Waves**: 3 waves (env+helper+plugin, per-route, edge-cases). Waves 2 son paralelizables entre archivos.
- **Tests**: ≥20 tests nuevos en total, cubren los 12 ACs.

**Artefacto**: `doc/sdd/015-wfac-40-rate-limiting/sdd.md` (este archivo).
