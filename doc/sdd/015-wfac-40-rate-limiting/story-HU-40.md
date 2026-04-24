# Story File — HU-40 Rate Limiting Redis-backed (WFAC-40)

- **Work Item**: `doc/sdd/015-wfac-40-rate-limiting/work-item.md`
- **SDD**: `doc/sdd/015-wfac-40-rate-limiting/sdd.md`
- **Pipeline**: QUALITY (security-critical — DoS protection, env vars nuevas, nuevo plugin Fastify global sobre 3 rutas productivas) · **Sizing**: M · **SDD_MODE**: full
- **Branch**: `feat/015-wfac-40-rate-limiting` (ya creada desde `main` post-WFAC-33 — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **403/403 passed** (post WFAC-33 DONE) · **Target**: **≥ 423** (403 + ≥ 20 nuevos)
- **Dependencia clave**: `@fastify/rate-limit` **v10.3.0** ya instalado en `package.json` (confirmed línea 26). **NO** agregar dependencias.
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-40.md`) — **es el único contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — consulta SOLO los relevantes a la wave que estás implementando.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes una ambigüedad y sospeches que este Story File está equivocado. En ese caso, STOP + reporta.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: feat/015-wfac-40-rate-limiting

git status
# esperado: clean al empezar. Entre waves, solo archivos del Scope IN (§0.5).

npm test -- --run
# esperado: 403/403 en baseline; creciente hasta ≥423 al cerrar W3.

grep -n "@fastify/rate-limit" package.json
# esperado: 1 match — "@fastify/rate-limit": "^10.3.0",
# Si NO aparece → STOP. Algo se rompió; la HU asume que YA está instalado.

ls node_modules/@fastify/rate-limit/types/index.d.ts \
   node_modules/@fastify/rate-limit/index.js \
   node_modules/@fastify/rate-limit/store/RedisStore.js
# esperado: las 3 rutas existen.
```

### 0.3 Anti-Hallucination Checklist (por wave)

**Antes de empezar una wave:**

- [ ] Leíste ESTE Story File end-to-end (incluyendo §3 CDs y §4 Guardrails).
- [ ] Leíste los exemplars listados para ESTA wave (y solo esos).
- [ ] Verificaste cada import path con `ls` / `Read` antes de escribirlo.
- [ ] Confirmaste que **ningún archivo fuera del Scope IN (§0.5)** va a ser tocado.
- [ ] Confirmaste que las dependencias entre waves (§0.6) están verdes (build + tests).

**Antes de cerrar una wave:**

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green (eslint `--max-warnings 0`).
- [ ] `npm run format:check` green (si falla, `npx prettier --write <archivo>` — **CD-LESSON-4**).
- [ ] `npm test -- --run` pasa el baseline (403) + los tests nuevos de esta wave.
- [ ] NO modificaste ningún archivo fuera del Scope IN de la wave.
- [ ] NO agregaste dependencias nuevas — `@fastify/rate-limit` v10.3.0 YA está en `package.json`.
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno está violado.
- [ ] **Regression guard WFAC-33**: `ledger.test.ts`, `audit.test.ts`, `routes.settle.test.ts`, `routes.verify.test.ts`, `routes.supported.test.ts`, `health.test.ts`, `routes.openapi.test.ts` SIGUEN verdes en su conteo original. Si alguno falla → **STOP + diagnose** (regresión audit = bloqueante).

### 0.4 Exemplars verificados en SDD §11 (paths confirmados con Read)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/app.ts` líneas 1-137 (completo) | W1 + W3: cómo se estructura `buildApp(options)`, dónde van los imports, dónde va `initRedis`/`initSupabase`, dónde está el `onResponse` hook WFAC-33 (líneas 84-121) — **es justamente el bloque XFF que se refactoriza en W1**. Cambio en W1: reemplazar bloque inline (líneas 88-99) por `const ipRaw = extractClientIp(request);`. | W1, W3 |
| E2 | `src/infra/redis.ts` líneas 70-110 | W1: firma `getRedisClient(): Redis \| null` + comportamiento null-safe. El plugin recibe `getRedisClient() ?? undefined`. | W1 |
| E3 | `src/infra/env.ts` completo (72 LOC) | W1: patrón Zod `z.coerce.number().int().min(...).default(...)`, `z.enum([...])`, `.superRefine(...)`. **NO modificar el bloque `superRefine` WFAC-5**; solo extender el `z.object({...})` con 5 keys más. | W1 |
| E4 | `src/routes/verify.ts` líneas 61-185 | W2: handler completo de `/verify`. En W2 se agrega SOLO el `config: { rateLimit: { max, timeWindow } }` en el `app.post('/verify', ...)` (línea 62). El handler interno no cambia. La línea 86, 134, 159 (WFAC-33 auditMeta populations) permanecen INTACTAS. | W2 |
| E5 | `src/routes/settle.ts` líneas 1-120 | W2: idéntico a verify — agregar solo el `config` en el primer `app.post('/settle', ...)` (línea 64). Las líneas 88, 98 (WFAC-33 auditMeta populations) permanecen intactas. | W2 |
| E6 | `src/routes/supported.ts` (56 LOC completo) | W2: ruta simple GET. Agregar el `config` en el único `app.get('/supported', ...)` (línea 30). | W2 |
| E7 | `src/routes/openapi.ts` (60 LOC completo) | W2: ruta GET estática. Agregar `{ config: { rateLimit: false } }` como 2do arg del `app.get('/openapi.json', ...)` (línea 56). | W2 |
| E8 | `src/routes/health.ts` línea 37 (`config: { rateLimit: false }`) | W2 (solo lectura): **NO modificar**. Sirve como exemplar del patrón exacto a replicar en `openapi.ts`. | W2 |
| E9 | `node_modules/@fastify/rate-limit/types/index.d.ts` (~165 LOC) | W1: firma `RateLimitPluginOptions` — campos `max`, `timeWindow`, `skipOnError`, `redis?: any`, `keyGenerator`, `errorResponseBuilder`, `enableDraftSpec`. El context recibido por `errorResponseBuilder` es `{ statusCode, ban, after, max, ttl }` — **NO incluye IP** (perfecto para CD-4). | W1 |
| E10 | `node_modules/@fastify/rate-limit/index.js` líneas 100-160 | W1 (solo lectura): confirma que `settings.redis` se pasa directo al `RedisStore`. Confirma que `skipOnError: true` bypass 429 cuando Redis falla (runtime fail-open). Confirma que `errorResponseBuilder(req, ctx)` se invoca con objeto context sin IP. | W1 |
| E11 | `src/__tests__/unit/env.test.ts` | W1: patrón `parseEnv` tests — cómo stubbear `process.exit`. Replicar para las 5 nuevas vars (válidas + inválidas). | W1 |
| E12 | `src/__tests__/unit/audit.test.ts` (baseline post-WFAC-33) | W3 (solo lectura): referencia de mock shape `vi.mock('../../infra/supabase.js', ...)`. NO se copia directo — los tests de rate-limit usan mocks propios de ioredis. | W3 |
| E13 | `src/__tests__/unit/routes.verify.test.ts` líneas 36-90 | W3 (solo lectura): patrón `app.inject({ method, url, headers, payload })`. Es el patrón a seguir para los integration tests de 429. | W3 |
| E14 | `src/__tests__/unit/routes.openapi.test.ts` | W2: patrón de tests existentes para `/openapi.json`. W2 agrega 1 test adicional confirmando que **NO** retorna 429 tras N requests. | W2 |
| E15 | `OWNERS.md` | Todas: `src/core/*` MAY import `src/infra/*` + `fastify` type-only. El helper `src/core/network.ts` nuevo cumple esta regla — zero runtime deps más allá de Fastify types. | Todas |
| E16 | `src/core/audit.ts` líneas 1-50 (header + imports) | W1: convención de header de módulo en `src/core/*` — JSDoc summary + boundaries + CDs referenciados. Replicar el formato (abreviado) en `src/core/network.ts`. | W1 |
| E17 | `tsconfig.json` | W1: `module: "Node16"` + ESM strict. **Imports con `.js` extension obligatorio** — `import { extractClientIp } from './core/network.js';`. Fallar en olvidar el `.js` rompe build. | W1 |

### 0.5 Scope IN — los ÚNICOS archivos que puedes tocar

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `src/infra/env.ts` | **MODIFY** (+ 5 keys en EnvSchema, dentro del `.object({...})`) | W1 |
| 2 | `src/core/network.ts` | **CREATE** (new module — `extractClientIp`) | W1 |
| 3 | `src/app.ts` | **MODIFY** (+ 2 imports, + module augmentation, + `app.decorate('env', env)`, + condicional `app.register(rateLimit, ...)`, refactor audit hook a usar `extractClientIp`) | W1 |
| 4 | `src/routes/verify.ts` | **MODIFY** (+ leer `app.env`, agregar `config: { rateLimit }` en el post) | W2 |
| 5 | `src/routes/settle.ts` | **MODIFY** (+ leer `app.env`, agregar `config: { rateLimit }` en el post) | W2 |
| 6 | `src/routes/supported.ts` | **MODIFY** (+ leer `app.env`, agregar `config: { rateLimit }` en el get) | W2 |
| 7 | `src/routes/openapi.ts` | **MODIFY** (+ `{ config: { rateLimit: false } }` en el get) | W2 |
| 8 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append ≥5 tests para las nuevas vars — defaults + invalid) | W1 |
| 9 | `src/__tests__/unit/core/network.test.ts` | **CREATE** (≥6 tests unit puros para `extractClientIp`) | W1 |
| 10 | `src/__tests__/unit/rate-limiting.test.ts` | **CREATE** (≥15 tests cross-cutting — 429 body/headers, disabled, excluded, fail-open, XFF, log, audit propagation) | W3 |

**Cualquier edit a cualquier otro archivo = violación del Story File. STOP AND REPORT.**

En particular, los siguientes archivos están **CONGELADOS** para esta HU:

- `src/routes/health.ts` — ya tiene `config: { rateLimit: false }` (WFAC-2 CD-9). **NO tocar** ni siquiera para "armonizar comentarios".
- `src/core/audit.ts` — consumido indirectamente. **NO modificar** (WFAC-33 frozen).
- `src/core/errors.ts` — `X402ErrorCode` spec-literal. **NO extender con `'RATE_LIMITED'`** (CD-1).
- `src/core/types.ts` — idem. `'RATE_LIMITED'` vive SOLO como literal en el `errorResponseBuilder` de `app.ts`.
- `src/core/ledger.ts`, `src/core/idempotency.ts`, `src/core/schemas.ts`, `src/core/settle.ts`, `src/core/verify.ts`, `src/core/supported.ts` — sin cambios.
- `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/infra/logger.ts` — sin cambios.
- `supabase/migrations/*.sql` — **no aplica** (esta HU no toca DB).
- `package.json` — `@fastify/rate-limit` YA está. **NO agregar deps**.
- `.env.example` — **NO modificar en esta HU** (si alguien quiere documentar las 5 vars, que vaya en un PR follow-up separado — OUT of scope).
- Archivos de test existentes NO listados en el Scope IN (e.g., `routes.verify.test.ts`, `routes.settle.test.ts`, `routes.supported.test.ts`, `audit.test.ts`, `health.test.ts`, `routes.openapi.test.ts`, `ledger.test.ts`, etc.) — **NO modificar**. Los tests cross-cutting van en el nuevo `rate-limiting.test.ts`.

### 0.6 Wave dependency graph

```
W1 (env.ts + core/network.ts + app.ts refactor + plugin register + env tests + network tests)
       │
       ▼
W2 (per-route config.rateLimit en verify/settle/supported + openapi.rateLimit:false)
       │
       ▼
W3 (src/__tests__/unit/rate-limiting.test.ts — tests cross-cutting)
```

- **W1 → W2**: W2 lee `app.env` (decorator creado en W1). El plugin rate-limit está registrado (condicional en W1); W2 agrega la config per-route que el plugin ya sabe leer vía `onRoute` hook.
- **W2 → W3**: W3 ejerce el pipeline completo (plugin + routes con config). Algunos tests de W3 usan `buildApp()` real, pasando env overrides como `{ RATE_LIMIT_VERIFY_MAX: 2, RATE_LIMIT_WINDOW_SEC: 60 }` y haciendo 3 `app.inject` seguidos para disparar 429 en el 3ro.
- **Sin forward references**. Si W1 necesita algo de W2/W3, hay bug de diseño — STOP AND REPORT.

---

## 1. Waves

### Wave 1 — Env + helper `extractClientIp` + plugin registration + audit-hook refactor

**Objetivo**: tener las 5 env vars validadas, el helper `extractClientIp` vivo y consumido desde el audit hook (DRY), y el plugin `@fastify/rate-limit` registrado condicionalmente en `buildApp`. Al cerrar W1 los 403 tests existentes siguen verdes + los nuevos tests de env + network pasan.

#### Files (W1)

| # | Path | Acción |
|---|------|--------|
| 1 | `src/infra/env.ts` | **MODIFY** |
| 2 | `src/core/network.ts` | **CREATE** |
| 3 | `src/app.ts` | **MODIFY** |
| 8 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append) |
| 9 | `src/__tests__/unit/core/network.test.ts` | **CREATE** |

#### W1.1 — `src/infra/env.ts`

**Acción**: extender el `.object({...})` con 5 keys nuevas, **DENTRO** del bloque existing (antes del `.superRefine(...)`). NO tocar el `superRefine` WFAC-5 ni nada previo.

**Patch conceptual** (Dev ubica la posición exacta — recomendación: AL FINAL del `z.object({...})`, después de `SUPABASE_SERVICE_KEY`):

```ts
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // ... existing fields UNCHANGED ...
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),

    // WFAC-40 — rate limiting (SDD §4.1). NO magic numbers in routes (CD-7).
    // RATE_LIMIT_ENABLED: accepts literal 'true'/'false' strings from env;
    // transforms to boolean. `z.coerce.boolean()` is PROHIBITED (CD-12) —
    // it would interpret 'false' as truthy (any non-empty string).
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_SETTLE_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_SUPPORTED_MAX: z.coerce.number().int().min(1).default(120),
  })
  .superRefine((data, ctx) => { /* existing WFAC-5 check — UNCHANGED */ });
```

**Checklist W1.1**:

- [ ] Las 5 keys están presentes en el `z.object({...})`.
- [ ] `RATE_LIMIT_ENABLED` usa `z.enum(['true','false']).default('true').transform(...)` — **NO** `z.coerce.boolean()` (CD-12).
- [ ] Los 4 `RATE_LIMIT_*_MAX` / `WINDOW_SEC` usan `z.coerce.number().int().min(1).default(N)` con defaults: `WINDOW_SEC=60`, `VERIFY_MAX=60`, `SETTLE_MAX=30`, `SUPPORTED_MAX=120`.
- [ ] El `.superRefine((data, ctx) => ...)` existing queda INTACTO (WFAC-5 REDIS_URL check).
- [ ] `EnvConfig = z.infer<typeof EnvSchema>` sigue siendo export y ahora incluye los 5 campos nuevos tipados correctamente.

#### W1.2 — `src/core/network.ts` (NEW)

**Acción**: crear el módulo desde cero. Pure function. Zero runtime deps más allá de Fastify types.

**Imports permitidos** (OWNERS: `src/core/*` MAY import type-only):

```ts
import type { FastifyRequest } from 'fastify';
```

**Imports PROHIBIDOS**: cualquier runtime import. `ioredis`, `viem`, `pino`, `@supabase/supabase-js`, `src/infra/*`, `src/routes/*`, `src/chains/*`, `src/methods/*`, `node:*`. **Ninguno** necesario.

**Exports obligatorios** (1):

```ts
export function extractClientIp(request: FastifyRequest): string | null;
```

**Comportamiento requerido** (SDD §3.1 DT-8):

1. Leer `request.headers['x-forwarded-for']`.
2. Si es `string` no-vacío → split por coma → trim del primer elemento → si length > 0 retornar ese string.
3. Si es array no-vacío y primer elemento es string → split por coma → trim → si length > 0 retornar.
4. Si ninguno yields → fallback a `request.ip` si es string no-vacío.
5. Si nada yields → retornar `null`.
6. **NO logging, NO throw, NO I/O**. Pure.

**Archivo template completo**:

```ts
/**
 * Proxy-aware client IP extraction — pure helper (WFAC-40).
 *
 * Used by:
 *   - `src/app.ts` audit hook (WFAC-33 — refactored from inline block).
 *   - `src/app.ts` rate-limit plugin keyGenerator (WFAC-40).
 *
 * Precedence (SDD §3.1 DT-8):
 *   1. First element of `X-Forwarded-For` header when present and non-empty
 *      (left-trimmed, comma-split). Handles both string and string[] cases
 *      (Fastify v5 normalizes but defense-in-depth keeps both branches).
 *   2. `request.ip` (Fastify default; respects `trustProxy` config).
 *   3. `null` if neither yields a non-empty string.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import: `fastify` (type-only).
 *   - MUST NOT import: ANY runtime module (this helper must stay pure).
 *
 * Contracts:
 *   - Pure — no logging, no throw, no I/O (WFAC-40 CD-9).
 *   - Same input ⇒ same output. Always returns `string | null`.
 */

import type { FastifyRequest } from 'fastify';

export function extractClientIp(request: FastifyRequest): string | null {
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0];
    const trimmed = first ? first.trim() : '';
    if (trimmed.length > 0) return trimmed;
  } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
    const first = xff[0].split(',')[0];
    const trimmed = first ? first.trim() : '';
    if (trimmed.length > 0) return trimmed;
  }
  if (typeof request.ip === 'string' && request.ip.length > 0) return request.ip;
  return null;
}
```

**Checklist W1.2**:

- [ ] El archivo existe en `src/core/network.ts`.
- [ ] Única export: `extractClientIp`.
- [ ] Zero imports runtime (`import type` OK).
- [ ] `grep -n "logger\\|console\\." src/core/network.ts` → zero matches.
- [ ] `grep -n "throw " src/core/network.ts` → zero matches.
- [ ] `grep -nE "from '\\.\\./(infra|routes|chains|methods)/" src/core/network.ts` → zero matches.

#### W1.3 — `src/app.ts`

**Acción**: 5 cambios atómicos:

1. **Agregar imports** (en el bloque superior, junto a los existing):
   ```ts
   import rateLimit from '@fastify/rate-limit';
   import { extractClientIp } from './core/network.js';
   ```
   (`'./core/network.js'` con extension `.js` por CD-ESM — tsconfig Node16.)

2. **Agregar module augmentation** (inmediatamente después de los imports, ANTES de la const `AUDIT_EXCLUDED_PATHS`):
   ```ts
   /**
    * WFAC-40 — expose the parsed EnvConfig to route plugins via decorator.
    * Consumed by `verify.ts`, `settle.ts`, `supported.ts` to read per-route
    * rate-limit caps without changing plugin signatures (DT-13 in SDD).
    */
   declare module 'fastify' {
     interface FastifyInstance {
       env: EnvConfig;
     }
   }
   ```

3. **Decorar `app.env`** dentro de `buildApp(...)`, **INMEDIATAMENTE** después de `const app = Fastify({...})` (entre línea 70 actual `Fastify({...})` y la línea 72 `app.register(healthRoute)`):
   ```ts
     app.decorate('env', env);
   ```
   Si Fastify avisa sobre tipo (`Property 'env' is missing in type 'FastifyInstance'`), el module augmentation del paso 2 resuelve. Si aun así quejas: `app.decorate<EnvConfig>('env', env);` o cast local `(app as FastifyInstance & { env: EnvConfig })` — preferible el module augmentation (ya declarado).

4. **Registrar el plugin** CONDICIONALMENTE, **ANTES** de los `app.register(xRoute)` existing (entre `app.decorate('env', env)` y `app.register(healthRoute)`):
   ```ts
     // WFAC-40 — rate-limit plugin (DT-5 SDD: BEFORE route registration
     // so the plugin's onRoute hook reads per-route config.rateLimit).
     // Conditional registration (DT-14): when RATE_LIMIT_ENABLED=false,
     // the plugin is NOT registered → zero-overhead global bypass (AC-6).
     if (env.RATE_LIMIT_ENABLED) {
       const redisClient = getRedisClient();
       await app.register(rateLimit, {
         global: true,
         // Defensive fallback caps — the 3 public routes OVERRIDE these via
         // per-route config.rateLimit in W2. Any future route without a
         // config inherits these.
         max: env.RATE_LIMIT_VERIFY_MAX,
         timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
         // DT-10: fail-open on Redis runtime outage. If the incr() call on
         // the store rejects, the plugin lets the request through.
         skipOnError: true,
         // DT-9 + DT-10 boot-time: when getRedisClient() returns null
         // (test env, REDIS_URL absent), pass undefined → plugin falls
         // back to LocalStore (in-memory) without crashing.
         redis: redisClient ?? undefined,
         // DT-8: reuse the centralized extractor. Defensive `?? req.ip ??
         // 'unknown'` fallback ensures the plugin always has a key.
         keyGenerator: (req) => extractClientIp(req) ?? req.ip ?? 'unknown',
         // DT-12: default headers (X-RateLimit-*). Draft-spec variant
         // (RateLimit-*) not used — work-item AC-5 cites X- prefixed names.
         enableDraftSpec: false,
         // DT-7 + DT-11: spec-literal body + warn log without PII (CD-3, CD-4).
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
     }
   ```

5. **Refactor del audit hook** (WFAC-33 — líneas 84-121 actuales). Reemplazar el bloque XFF inline (líneas 88-99) por una única llamada al helper. El resto del hook permanece idéntico.

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

   **Después** (reemplazo exacto, ~1 línea):
   ```ts
       const ipRaw = extractClientIp(request);
   ```

   **CRÍTICO**: el resto del hook (líneas 101-121 — user-agent extraction, `meta = request.auditMeta`, `buildAuditEntry(...)`, `await persistAuditEntry(...)`) **NO cambia**. El comportamiento observable del audit es idéntico — todos los tests `audit.test.ts` + `routes.*.test.ts` WFAC-33 deben seguir verdes.

**Reglas críticas para `src/app.ts` (W1)**:

- [ ] **CD-5**: `app.register(rateLimit, ...)` ocurre ANTES de los `app.register(xRoute)` existing. Orden final: `app.decorate('env', env)` → `if (env.RATE_LIMIT_ENABLED) { await app.register(rateLimit, ...) }` → `app.register(healthRoute)` → ... → `app.register(openapiRoute)` → `app.addHook('onResponse', ...)`.
- [ ] **CD-13**: `app.register(rateLimit, ...)` envuelto en `if (env.RATE_LIMIT_ENABLED)`. **NO** registrar con `max: Infinity` o similar.
- [ ] **CD-1**: el string literal `'RATE_LIMITED'` aparece **únicamente** dentro del `errorResponseBuilder`. `grep -n "RATE_LIMITED" src/app.ts` → **exactly 1 match**.
- [ ] **CD-10 + CD-3**: el body del `errorResponseBuilder` se construye EXPLÍCITAMENTE como `{ error: { code: 'RATE_LIMITED', message: '...', http: 429 } }`. **NO** spread, **NO** helper, **NO** campos extra (`retryAfter`, `limit`, `reset`, etc.).
- [ ] **CD-4**: el `req.log.warn(...)` del builder NO incluye `ip`, `user_agent`, `userAgent` ni ningún PII en el payload estructurado. Solo `request_id`, `path`, `rate_limit_max`, `rate_limit_ttl_ms`.
- [ ] **CD-9**: la lógica XFF en el audit hook ha sido **removida** y reemplazada por `extractClientIp(request)`. `grep -n "x-forwarded-for" src/app.ts` → **zero matches** (la única ocurrencia vive ahora en `src/core/network.ts`).
- [ ] El `Math.round(reply.elapsedTime)` del audit hook (línea 110 actual) sigue siendo `Math.round` — no cambiar a floor/ceil.
- [ ] NO agregar `app.decorateRequest` — solo `app.decorate('env', env)`.
- [ ] NO tocar `initRedis`, `initSupabase`, `Fastify({...})`, ni el `addHook('onClose', ...)` existing.

#### W1.4 — `src/__tests__/unit/env.test.ts` (APPEND)

**Acción**: agregar ≥5 tests nuevos al final del archivo. NO modificar tests existing.

**Tests requeridos (IDs T-ENV-RL-*)**:

- **T-ENV-RL-1 (AC-12 defaults)**: `parseEnv({ NODE_ENV:'test' })` (o equivalente con mínimos válidos) → retorna `env` con `RATE_LIMIT_ENABLED === true`, `RATE_LIMIT_WINDOW_SEC === 60`, `RATE_LIMIT_VERIFY_MAX === 60`, `RATE_LIMIT_SETTLE_MAX === 30`, `RATE_LIMIT_SUPPORTED_MAX === 120`.
- **T-ENV-RL-2 (AC-6, disabled)**: `parseEnv({ NODE_ENV:'test', RATE_LIMIT_ENABLED:'false' })` → `env.RATE_LIMIT_ENABLED === false` (boolean, not string).
- **T-ENV-RL-3 (CD-12 explicit true)**: `parseEnv({ RATE_LIMIT_ENABLED:'true', ... })` → `env.RATE_LIMIT_ENABLED === true`.
- **T-ENV-RL-4 (AC-12 override numeric)**: `parseEnv({ RATE_LIMIT_WINDOW_SEC:'120', RATE_LIMIT_VERIFY_MAX:'100', RATE_LIMIT_SETTLE_MAX:'50', RATE_LIMIT_SUPPORTED_MAX:'200', ... })` → los 4 campos numéricos reflejan los valores parseados a number.
- **T-ENV-RL-5 (AC-12 invalid negative WINDOW_SEC)**: stub `process.exit` (mocked), `parseEnv({ RATE_LIMIT_WINDOW_SEC:'-1', ... })` → `process.exit` llamado con 1, y stderr menciona `RATE_LIMIT_WINDOW_SEC`. Patrón idéntico a tests existing de `PORT` inválido.
- **T-ENV-RL-6 (AC-12 invalid zero VERIFY_MAX)**: igual pero `RATE_LIMIT_VERIFY_MAX:'0'` → `process.exit(1)`.
- **T-ENV-RL-7 (CD-12 invalid ENABLED)**: `parseEnv({ RATE_LIMIT_ENABLED:'yes', ... })` → `process.exit(1)` con stderr mencionando `RATE_LIMIT_ENABLED`. (Valida que `z.enum(['true','false'])` rechaza strings arbitrarios — **CD-12 defense against `z.coerce.boolean()` footgun**.)

**Total tests nuevos en env.test.ts: ≥7** (T-ENV-RL-1 a T-ENV-RL-7).

**Checklist W1.4**:

- [ ] Los tests existing (pre-WFAC-40) **todos verdes**. Si alguno rompe → regresión en W1.1.
- [ ] T-ENV-RL-5/6 no crashean el process del test runner (el stub de `process.exit` debe throw o capturar).
- [ ] `grep -nE "RATE_LIMIT_" src/__tests__/unit/env.test.ts` → ≥5 matches.

#### W1.5 — `src/__tests__/unit/core/network.test.ts` (NEW)

**Acción**: crear archivo nuevo. Pure unit tests para `extractClientIp` — sin Fastify app, sin inject, sin mocks. Se construye un fake `FastifyRequest` con los campos mínimos que consume el helper (`headers`, `ip`).

**Patrón**:

```ts
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../../../core/network.js';

function makeReq(headers: Record<string, string | string[]>, ip?: string): FastifyRequest {
  return { headers, ip: ip ?? '' } as unknown as FastifyRequest;
}

describe('extractClientIp', () => {
  it('T-NET-1: XFF string single IP → returns that IP', () => { /* ... */ });
  // ...
});
```

**Tests requeridos (IDs T-NET-*, ≥6)**:

- **T-NET-1 (AC-8 string single)**: `makeReq({ 'x-forwarded-for':'203.0.113.5' }, '10.0.0.1')` → `'203.0.113.5'`.
- **T-NET-2 (AC-8 string comma list)**: `makeReq({ 'x-forwarded-for':'203.0.113.5, 10.0.0.1, 172.16.0.1' }, '127.0.0.1')` → `'203.0.113.5'` (**primer** elemento, trimmed).
- **T-NET-3 (AC-8 array variant)**: `makeReq({ 'x-forwarded-for': ['203.0.113.6, 10.0.0.2'] }, '127.0.0.1')` → `'203.0.113.6'`.
- **T-NET-4 (AC-8 XFF absent → request.ip)**: `makeReq({}, '127.0.0.1')` → `'127.0.0.1'`.
- **T-NET-5 (empty XFF string → request.ip)**: `makeReq({ 'x-forwarded-for':'' }, '127.0.0.1')` → `'127.0.0.1'`.
- **T-NET-6 (XFF whitespace-only → request.ip)**: `makeReq({ 'x-forwarded-for':'   ' }, '127.0.0.1')` → `'127.0.0.1'` (porque el trim del first da string vacío).
- **T-NET-7 (XFF array empty → request.ip)**: `makeReq({ 'x-forwarded-for': [] }, '127.0.0.1')` → `'127.0.0.1'`.
- **T-NET-8 (null case — nothing)**: `makeReq({}, '')` → `null`.
- **T-NET-9 (CD-9 pure: no logger, no throw)**: llamar 10 veces con cualquier input → no excepciones. (Implícito, no se testea explícitamente — pero sí se valida con try/catch wrapper opcional.)

**Total tests nuevos en network.test.ts: ≥8** (T-NET-1 a T-NET-8).

**Checklist W1.5**:

- [ ] El archivo existe en `src/__tests__/unit/core/network.test.ts` (carpeta `core/` dentro de `unit/` — ya existe para otros tests).
- [ ] `grep -n "extractClientIp" src/__tests__/unit/core/network.test.ts` → ≥1 import match.
- [ ] Los 8 tests pasan en aislamiento.

#### Wave 1 — dependencies

- Depende solo de `main` post-WFAC-33 (baseline 403 tests).
- NO depende de W2/W3.

#### Wave 1 — completion criteria

- [ ] `npm run typecheck` green — module augmentation `FastifyInstance.env` tipa correctamente en los 3 route plugins (aunque en W1 no se usan aún — la declaración existe y compila).
- [ ] `npm run lint` green (max-warnings 0).
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/infra/env.ts src/core/network.ts src/app.ts src/__tests__/unit/env.test.ts src/__tests__/unit/core/network.test.ts`; **CD-LESSON-4**).
- [ ] `npm test -- --run` → **≥ 403 + ≥15 nuevos = 418+ tests verdes**.
- [ ] **Regression guard WFAC-33**: `audit.test.ts` (15 tests) siguen verdes sin cambios. `routes.settle.test.ts`, `routes.verify.test.ts`, `routes.supported.test.ts`, `health.test.ts`, `routes.openapi.test.ts` siguen verdes. Si alguno rompe → el refactor del audit hook en W1.3 es defectuoso. STOP + diagnose.
- [ ] `grep -n "x-forwarded-for" src/app.ts` → **zero matches** (DRY — la lógica vive ahora en `src/core/network.ts`).
- [ ] `grep -n "x-forwarded-for" src/core/network.ts` → **≥1 match**.
- [ ] `grep -n "extractClientIp" src/app.ts` → **≥2 matches** (import + uso en audit hook + uso en keyGenerator).
- [ ] `grep -nE "RATE_LIMITED" src/app.ts` → **exactly 1 match** (dentro del `errorResponseBuilder`).
- [ ] `grep -nE "RATE_LIMITED" src/core/errors.ts src/core/types.ts` → **zero matches** (**CD-1**).
- [ ] `grep -n "z.coerce.boolean" src/infra/env.ts` → **zero matches** (**CD-12**).
- [ ] `grep -nE "app\\.register\\(rateLimit" src/app.ts` → **exactly 1 match**, dentro de un `if (env.RATE_LIMIT_ENABLED)` (**CD-13**).
- [ ] `grep -nE "logger\\.(info|warn|debug)\\(" src/core/network.ts` → **zero matches** (**CD-9 pure**).

---

### Wave 2 — Per-route `config.rateLimit` + excluir `/openapi.json`

**Objetivo**: cada ruta pública (`verify`, `settle`, `supported`) declara su propio `config.rateLimit` con valores de env. `/openapi.json` agrega `config: { rateLimit: false }` (mirror de `/health`).

#### Files (W2)

| # | Path | Acción |
|---|------|--------|
| 4 | `src/routes/verify.ts` | **MODIFY** |
| 5 | `src/routes/settle.ts` | **MODIFY** |
| 6 | `src/routes/supported.ts` | **MODIFY** |
| 7 | `src/routes/openapi.ts` | **MODIFY** |

#### W2.1 — `src/routes/verify.ts`

**Acción**: agregar 2 líneas al plugin — (a) leer `env` via el decorator dentro de la función del plugin, (b) agregar `config: { rateLimit: { max, timeWindow } }` al `app.post(...)`. **NO** cambiar imports (salvo type-only si TS lo exige), **NO** cambiar el handler interno.

**Posición del cambio**: dentro de `export const verifyRoute: FastifyPluginAsync = async (app) => { ... }` (línea 61 actual), justo al inicio del callback.

**Antes** (línea 61-62):
```ts
export const verifyRoute: FastifyPluginAsync = async (app) => {
  app.post('/verify', async (request, reply) => {
```

**Después**:
```ts
export const verifyRoute: FastifyPluginAsync = async (app) => {
  // WFAC-40 — per-route rate-limit config (DT-6 + DT-13 SDD). Values come
  // from env via FastifyInstance augmentation declared in src/app.ts.
  // When env.RATE_LIMIT_ENABLED=false, the plugin is never registered and
  // this config is silently ignored by Fastify (AC-6 + DT-14 SDD).
  const env = app.env;
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
    async (request, reply) => {
      // ... handler body UNCHANGED (lines 63-184) ...
    },
  );
};
```

**Reglas críticas para `verify.ts`**:

- [ ] NO tocar el handler interno (líneas 63-184 — Zod validation, idempotency, dispatch, auditMeta WFAC-33 population en 3 paths). Los tests `routes.verify.test.ts` WFAC-20 + WFAC-33 deben seguir verdes.
- [ ] NO importar `env` ni `EnvConfig` directamente desde `src/infra/env.js`. El acceso es **SOLO** via `app.env` (decorator). Si TS quejas sobre `app.env`, es bug del module augmentation en `app.ts` (W1.3) — STOP + revisar.
- [ ] `grep -n "env\\.RATE_LIMIT_VERIFY_MAX\\|env\\.RATE_LIMIT_WINDOW_SEC" src/routes/verify.ts` → **exactly 2 matches** (el `max` y el `timeWindow`).
- [ ] **CD-7** (no magic numbers): `grep -nE "\\brateLimit:\\s*\\{\\s*max:\\s*[0-9]" src/routes/verify.ts` → **zero matches** (los números vienen de env, no hardcoded).
- [ ] El `sendCached(reply, cached, ctx)` helper (líneas 195-225) **no se toca** — cache-hit path sigue funcionando idéntico.

#### W2.2 — `src/routes/settle.ts`

**Idéntico patrón a W2.1**, con `RATE_LIMIT_SETTLE_MAX` en lugar de `VERIFY_MAX`.

**Posición del cambio**: dentro de `export const settleRoute: FastifyPluginAsync = async (app) => { ... }` (línea 63 actual), justo al inicio.

**Después**:
```ts
export const settleRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  app.post(
    '/settle',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SETTLE_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      // ... handler body UNCHANGED (lines 64-247) ...
    },
  );
};
```

**Reglas críticas para `settle.ts`**:

- [ ] NO tocar el handler (líneas 64-247 — incluye WFAC-32 ledger hooks + WFAC-33 auditMeta populations en 5 puntos). Los tests `routes.settle.test.ts` WFAC-21 + WFAC-32 + WFAC-33 deben seguir verdes.
- [ ] `grep -n "env\\.RATE_LIMIT_SETTLE_MAX" src/routes/settle.ts` → **exactly 1 match**.
- [ ] `env.RATE_LIMIT_SETTLE_MAX` se usa — **NO** `VERIFY_MAX` ni `SUPPORTED_MAX` por copy-paste error.

#### W2.3 — `src/routes/supported.ts`

**Idéntico patrón**, con `RATE_LIMIT_SUPPORTED_MAX` y método `.get`.

**Posición**: dentro de `export const supportedRoute: FastifyPluginAsync = async (app) => { ... }` (línea 29 actual).

**Después**:
```ts
export const supportedRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  app.get(
    '/supported',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SUPPORTED_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      // ... handler body UNCHANGED (lines 31-53) ...
    },
  );
};
```

**Reglas críticas para `supported.ts`**:

- [ ] NO tocar el handler. `grep -n "chain_count\\|response.chains" src/routes/supported.ts` → matches siguen existiendo.
- [ ] `grep -n "env\\.RATE_LIMIT_SUPPORTED_MAX" src/routes/supported.ts` → **exactly 1 match**.

#### W2.4 — `src/routes/openapi.ts`

**Acción**: agregar `{ config: { rateLimit: false } }` como segundo argumento del `app.get(...)`. **Mirror exacto** del patrón de `src/routes/health.ts` línea 37.

**Posición del cambio**: línea 56 actual.

**Antes**:
```ts
export const openapiRoute: FastifyPluginAsync = async (app) => {
  app.get('/openapi.json', async (_request, reply) => {
    return reply.code(200).type('application/json').send(OPENAPI_SPEC);
  });
};
```

**Después**:
```ts
export const openapiRoute: FastifyPluginAsync = async (app) => {
  // WFAC-40 CD-6 — mirror the pattern from src/routes/health.ts line 37.
  // /openapi.json is a static discovery doc; rate-limiting it would break
  // legitimate tooling (Swagger UI, OpenAPI generators) that poll it.
  app.get(
    '/openapi.json',
    { config: { rateLimit: false } },
    async (_request, reply) => {
      return reply.code(200).type('application/json').send(OPENAPI_SPEC);
    },
  );
};
```

**Reglas críticas para `openapi.ts`**:

- [ ] El handler interno (`return reply.code(200).type('application/json').send(OPENAPI_SPEC)`) **no cambia**.
- [ ] `grep -n "rateLimit: false" src/routes/openapi.ts` → **exactly 1 match** (**CD-6**).
- [ ] NO usar `{ config: { rateLimit: { max: Infinity } } }` ni similar — **false literal** (bypass total por el plugin).

#### Wave 2 — dependencies

- Depende de W1 (`app.decorate('env', env)` + module augmentation).
- NO depende de W3.

#### Wave 2 — completion criteria

- [ ] `npm run typecheck` green. Especialmente: `app.env.RATE_LIMIT_*` tipa correctamente en las 3 routes.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/routes/verify.ts src/routes/settle.ts src/routes/supported.ts src/routes/openapi.ts`).
- [ ] `npm test -- --run` → sigue ≥418 verdes (W1 counts) **sin regresión**. **Los tests existing de `routes.*.test.ts` deben seguir pasando sin tocar fixtures** — el `config.rateLimit` per-route no afecta tests en `NODE_ENV=test` porque los límites default (60/30/120) son altos y los tests hacen 1-5 inyecciones por archivo.
- [ ] **Regression CRÍTICO**: `routes.verify.test.ts` (WFAC-20 + WFAC-33 — N tests), `routes.settle.test.ts` (WFAC-21 + WFAC-32 + WFAC-33 — N tests), `routes.supported.test.ts` (WFAC-22 + WFAC-33 — N tests), `routes.openapi.test.ts` (WFAC-23 + WFAC-33 — N tests), `health.test.ts`, `audit.test.ts` → **todos verdes**. Si alguno rompe → el `env = app.env` no se está resolviendo (problema del decorator o del module augmentation de W1.3). STOP.
- [ ] `grep -nE "config:\\s*\\{\\s*rateLimit" src/routes/verify.ts src/routes/settle.ts src/routes/supported.ts` → **3 matches** (1 por archivo).
- [ ] `grep -nE "rateLimit:\\s*false" src/routes/openapi.ts src/routes/health.ts` → **2 matches** (openapi NEW + health preservado).
- [ ] `grep -nE "RATE_LIMIT_(VERIFY|SETTLE|SUPPORTED)_MAX" src/routes/*.ts` → **3 matches** (1 por archivo público).

---

### Wave 3 — `src/__tests__/unit/rate-limiting.test.ts` (cross-cutting)

**Objetivo**: cubrir los 12 ACs y los CDs con ≥15 tests en un archivo dedicado. Usar `buildApp({ env, rawEnv })` construyendo el app real con overrides de env **bajos** (ej: `VERIFY_MAX=2`) para forzar 429 con pocas `app.inject` consecutivas.

#### Files (W3)

| # | Path | Acción |
|---|------|--------|
| 10 | `src/__tests__/unit/rate-limiting.test.ts` | **CREATE** |

#### W3.1 — `src/__tests__/unit/rate-limiting.test.ts` (NEW, ≥15 tests)

**Imports y setup típico**:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';

// Helper: construir app con env overrides sin tocar process.env.
async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const rawEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    // WFAC-32/33 Supabase vars omitted — the ledger/audit mocks in downstream
    // tests don't apply here; audit inserts fail-open if SUPABASE_URL absent
    // (WFAC-33 CD-1), rate-limit tests don't need Supabase.
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_SEC: '60',
    RATE_LIMIT_VERIFY_MAX: '2',
    RATE_LIMIT_SETTLE_MAX: '2',
    RATE_LIMIT_SUPPORTED_MAX: '2',
    ...overrides,
  };
  return await buildApp({ rawEnv });
}
```

**Tests requeridos (IDs T-RL-*, ≥15)**:

- **T-RL-1 (AC-1, /verify 429 on max+1)**: `makeApp({ RATE_LIMIT_VERIFY_MAX:'2' })` → hacer 3 `app.inject({ method:'POST', url:'/verify', payload: validOrInvalidBody })` en secuencia desde la **misma IP** (forced vía `headers: { 'x-forwarded-for':'9.9.9.9' }`). Primera 2 responses NO son 429 (pueden ser 400 por Zod o 200 — irrelevante). La 3ra response `statusCode === 429`.
- **T-RL-2 (AC-2, /settle 429 on max+1)**: idéntico con `RATE_LIMIT_SETTLE_MAX:'2'` y `url:'/settle'`.
- **T-RL-3 (AC-3, /supported 429 on max+1)**: idéntico con `RATE_LIMIT_SUPPORTED_MAX:'2'`, `method:'GET'`, `url:'/supported'`.
- **T-RL-4 (AC-4 body shape exacto)**: tras disparar 429 → `JSON.parse(response.body)` tiene EXACTAMENTE `{ error: { code:'RATE_LIMITED', message:'Too many requests, please try again later', http:429 } }`. Assertion:
  ```ts
  const body = JSON.parse(response.body);
  expect(body).toEqual({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
      http: 429,
    },
  });
  expect(Object.keys(body.error).sort()).toEqual(['code', 'http', 'message']);
  ```
  El último assert es **CD-3**: EXACTAMENTE 3 keys, sin `retryAfter`/`limit`/etc.
- **T-RL-5 (AC-4 Content-Type)**: tras disparar 429 → `response.headers['content-type']` empieza con `'application/json'`.
- **T-RL-6 (AC-5 headers X-RateLimit-*)**: tras disparar 429 → `response.headers` contiene `'x-ratelimit-limit'`, `'x-ratelimit-remaining'`, `'x-ratelimit-reset'` (case-insensitive; `light-my-request` normaliza a lowercase). Los 3 valores son strings numericos (`"2"`, `"0"`, algún número positivo).
- **T-RL-7 (AC-6 disabled bypass)**: `makeApp({ RATE_LIMIT_ENABLED:'false', RATE_LIMIT_VERIFY_MAX:'2' })` → hacer **5** `app.inject({ url:'/verify', ... })` → **todas** NO-429 (pueden ser 200/400/500 según payload, pero **nunca** 429). Assertion: `responses.every(r => r.statusCode !== 429)`.
- **T-RL-8 (AC-7 /health exempt)**: `makeApp({ RATE_LIMIT_VERIFY_MAX:'1' })` → hacer 5 `app.inject({ method:'GET', url:'/health' })` → todas 200, ninguna con headers `x-ratelimit-*`, ninguna 429. Assertion: `responses.every(r => r.statusCode === 200 && !r.headers['x-ratelimit-limit'])`.
- **T-RL-9 (AC-7 /openapi.json exempt)**: `makeApp({ RATE_LIMIT_VERIFY_MAX:'1' })` → hacer 5 `app.inject({ method:'GET', url:'/openapi.json' })` → todas 200, ninguna 429, ninguna con header `x-ratelimit-*`.
- **T-RL-10 (AC-8 XFF is the key)**: `makeApp({ RATE_LIMIT_VERIFY_MAX:'2' })` → hacer 2 `app.inject({ url:'/verify', headers:{'x-forwarded-for':'1.1.1.1'}, ... })` (ambas NO-429) + 1 `app.inject({ url:'/verify', headers:{'x-forwarded-for':'2.2.2.2'}, ... })` (primera para `2.2.2.2` → NO 429). Esto prueba que dos IPs distintas **NO comparten cuota**. Assertion: la 3ra response `statusCode !== 429`.
- **T-RL-11 (AC-9 warn log emitted, no PII)**: capturar logs vía Pino `DestinationStream`. Tras disparar 429 → existe **exactamente 1** entry con `msg === 'rate limit exceeded'`, level `warn` (o equivalente según pino), contiene keys `request_id`, `path`, NO contiene `ip` ni `user_agent` ni `userAgent`. Assertion:
  ```ts
  const logEntry = capturedLogs.find((l) => l.msg === 'rate limit exceeded');
  expect(logEntry).toBeDefined();
  expect(logEntry).toHaveProperty('request_id');
  expect(logEntry).toHaveProperty('path');
  expect(logEntry).not.toHaveProperty('ip');
  expect(logEntry).not.toHaveProperty('user_agent');
  expect(logEntry).not.toHaveProperty('userAgent');
  ```
  **Patrón CaptureStream**: pasar `loggerDestination` a `buildApp({ rawEnv, loggerDestination })` — Pino acepta `DestinationStream`. Ver `src/app.ts` líneas 34-35 y `src/__tests__/unit/logger.test.ts` si existe patrón previo. Si no, crear:
  ```ts
  const captured: any[] = [];
  const dest = { write: (s: string) => { captured.push(JSON.parse(s)); } };
  const app = await buildApp({ rawEnv, loggerDestination: dest });
  ```
- **T-RL-12 (AC-10 fail-open on boot — Redis null)**: `makeApp()` sin `REDIS_URL` definido (default en test env) → la app **arranca sin throw**. `app.inject({ method:'GET', url:'/health' })` → 200. Esto prueba el LocalStore fallback boot-time (DT-10).
- **T-RL-13 (AC-10 runtime fail-open via skipOnError)**: skip test por complejidad o implementar con mock avanzado. **Alternativa aceptable**: test que valida que `skipOnError: true` está en el registration (requiere spy sobre `app.register`, o lectura del source). **Este test es OPCIONAL** si el setup es muy costoso — dejar comment `// skipped: covered by T-RL-12 boot-path + plugin internals (manual smoke)`. Si se implementa, usar `vi.mock('ioredis', ...)` con `defineCommand` que rechaza → verificar que tras un 429-trigger el request aun resuelve 200.
- **T-RL-14 (AC-11 audit captures 429)**: `makeApp({ RATE_LIMIT_VERIFY_MAX:'1' })` + mock de `../../core/audit.js` (mismo patrón `__persistSpy`/`__buildSpy` que `routes.settle.test.ts` WFAC-33) → disparar 429 en `/verify` → `__buildSpy.mock.calls[last]` incluye `{ statusCode: 429, path:'/verify' }`. Este test valida que el `onResponse` hook corre incluso cuando la respuesta proviene del rate-limit plugin (no del handler de la ruta).
- **T-RL-15 (CD-11 no RATE_LIMITED in X402ErrorCode)**: test meta — `import type { X402ErrorCode } from '../../core/types.js'` y asegurar que `'RATE_LIMITED'` NO es asignable. Esto es un type-level assertion con helper:
  ```ts
  import type { X402ErrorCode } from '../../core/types.js';
  // @ts-expect-error — RATE_LIMITED must NOT be part of the x402 spec union (CD-1)
  const _bad: X402ErrorCode = 'RATE_LIMITED';
  ```
  Si el test compila sin el `@ts-expect-error` → CD-1 violado (alguien extendió el union).
- **T-RL-16 (AC-4 + CD-3 sin campos extra)**: 429 body **NO** contiene `retryAfter`, `limit`, `remaining`, `reset`. (Complementa T-RL-4.)

**Total tests nuevos en rate-limiting.test.ts: ≥15** (T-RL-1 a T-RL-16; T-RL-13 opcional).

**Reglas críticas para `rate-limiting.test.ts`**:

- [ ] **CD-LESSON-1** (WFAC-33 auto-blindaje): `light-my-request` inyecta `user-agent: 'lightMyRequest'` por default. Si un test quiere ejercer ausencia de UA, pasar `headers: { 'user-agent': '' }` explícito. En estos tests de rate-limit NO validamos UA — aplica solo si algún test quiere "no UA en log payload".
- [ ] **CD-LESSON-3** (WFAC-23 auto-blindaje): si ESLint `security/detect-object-injection` tira sobre accesos a `response.headers[key]`, agregar `// eslint-disable-next-line security/detect-object-injection` con justificación corta.
- [ ] **CD-LESSON-4** (WFAC-23 auto-blindaje): `npx prettier --write src/__tests__/unit/rate-limiting.test.ts` antes de `npm run format:check`.
- [ ] **No** agregar tests de `/settle` / `/verify` / `/supported` a sus archivos de test originales. Todos los tests cross-cutting de rate-limit van EXCLUSIVAMENTE en este archivo nuevo.
- [ ] `app.close()` al final de cada test (o en `afterEach`) — si buildApp() crea apps sin cerrar, los ports / hooks quedan colgados en vitest. Patrón: `await app.close()`.
- [ ] **CD-13 sanity**: test que haga `makeApp({ RATE_LIMIT_ENABLED:'false' })` y verifique en sources (grep) que el plugin NO se registró NO es posible sin exposer state interno — el comportamiento observable (T-RL-7) es suficiente.

#### Wave 3 — dependencies

- Depende de W1 + W2 (plugin registrado + routes con `config.rateLimit`).

#### Wave 3 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/__tests__/unit/rate-limiting.test.ts`; **CD-LESSON-4**).
- [ ] **`npm test -- --run` → total ≥ 423/423** (403 baseline + ≥20 nuevos: ≥7 env + ≥8 network + ≥15 rate-limiting = **≥30 nuevos ideal**).
- [ ] **Regression guard CRÍTICO**: los 403 tests previos (incluyendo `audit.test.ts`, `routes.*.test.ts`, `ledger.test.ts`, `supabase.test.ts`, `health.test.ts`, `env.test.ts` originales) siguen **todos verdes**. Los NUEVOS tests de env/network en W1 también verdes. Si `audit.test.ts` rompe → el audit flow tiene una regresión (probablemente en W1.3 refactor del hook). STOP + diagnose.
- [ ] **Integration check**: `npm test -- --run rate-limiting` → ≥15 tests verdes.
- [ ] Coverage de `src/core/network.ts` ≥ 90% (pure function, fácil de cubrir).
- [ ] Coverage de la rama `if (env.RATE_LIMIT_ENABLED)` en `src/app.ts` ≥ 80% (cubierta por T-RL-7 false branch + T-RL-1..12 true branch).

---

## 2. AC → Wave → Test matrix (12 ACs)

| AC | Descripción | Wave(s) | Test(s) que cubre | Archivo |
|----|-------------|---------|-------------------|---------|
| **AC-1** | 429 en `/verify` > `RATE_LIMIT_VERIFY_MAX`, stop pre-core | W2 + W3 | T-RL-1 | `rate-limiting.test.ts` |
| **AC-2** | 429 en `/settle` > `RATE_LIMIT_SETTLE_MAX`, stop pre-onchain | W2 + W3 | T-RL-2 | `rate-limiting.test.ts` |
| **AC-3** | 429 en `/supported` > `RATE_LIMIT_SUPPORTED_MAX` | W2 + W3 | T-RL-3 | `rate-limiting.test.ts` |
| **AC-4** | Body 429 shape exacto `{ error: { code:'RATE_LIMITED', message, http:429 } }` + Content-Type JSON | W1 + W3 | T-RL-4, T-RL-5, T-RL-16 | `rate-limiting.test.ts` |
| **AC-5** | Headers X-RateLimit-Limit/Remaining/Reset presentes | W1 + W3 | T-RL-6 | `rate-limiting.test.ts` |
| **AC-6** | `RATE_LIMIT_ENABLED=false` → bypass global | W1 + W3 | T-RL-7, T-ENV-RL-2 | `rate-limiting.test.ts`, `env.test.ts` |
| **AC-7** | `/health` + `/openapi.json` exemptas | W2 + W3 | T-RL-8, T-RL-9 | `rate-limiting.test.ts` |
| **AC-8** | XFF first element como keyGenerator; fallback `request.ip` | W1 + W3 | T-NET-1..T-NET-8, T-RL-10 | `network.test.ts`, `rate-limiting.test.ts` |
| **AC-9** | Warn log con `request_id` + `path`, SIN IP en payload | W1 + W3 | T-RL-11 | `rate-limiting.test.ts` |
| **AC-10** | Fail-open boot (Redis null → LocalStore) + runtime (skipOnError) | W1 + W3 | T-RL-12 (boot), T-RL-13 (runtime — opcional) | `rate-limiting.test.ts` |
| **AC-11** | Audit row con `status_code=429` (WFAC-33 hook corre) | W3 | T-RL-14 | `rate-limiting.test.ts` |
| **AC-12** | Fail-fast en env inválido (startup exit(1)) | W1 | T-ENV-RL-1..7 | `env.test.ts` |

**Total nuevos tests (mínimo)**: ≥7 (env) + ≥8 (network) + ≥15 (rate-limiting) = **≥30 nuevos ≥ 20 target**. Final test count: **≥ 423 + stretch ~ 433**.

---

## 3. Constraint Directives — 13 CDs (8 heredados WI + 5 nuevos SDD)

### 3.1 Heredados del work-item (CD-1..CD-8)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-1** | PROHIBIDO extender `X402ErrorCode` con `'RATE_LIMITED'` — vive solo como string literal en `errorResponseBuilder` de `src/app.ts` | `src/app.ts` (W1), `src/core/errors.ts` + `src/core/types.ts` (frozen) |
| **CD-2** | OBLIGATORIO fail-open cuando Redis no está disponible — NO bloquear tráfico por outage | `src/app.ts` (W1 — `skipOnError:true` + LocalStore fallback) |
| **CD-3** | Response body 429 EXACTAMENTE `{ error: { code, message, http } }` — PROHIBIDO agregar campos (`retryAfter`, `limit`, etc.) | `src/app.ts` errorResponseBuilder (W1) |
| **CD-4** | PROHIBIDO PII en logs estructurados — IP va a DB (audit row), NO a stdout | `src/app.ts` errorResponseBuilder (W1) |
| **CD-5** | OBLIGATORIO registrar plugin ANTES de `app.register(route)` | `src/app.ts` (W1) |
| **CD-6** | OBLIGATORIO `config: { rateLimit: false }` en `/openapi.json` (mirror `/health`) | `src/routes/openapi.ts` (W2) |
| **CD-7** | PROHIBIDO magic numbers — `max` y `timeWindow` SIEMPRE desde `env.RATE_LIMIT_*` | `src/routes/*.ts` (W2), `src/app.ts` (W1) |
| **CD-8** | OBLIGATORIO env var validation en `parseEnv` — fail-fast en valores inválidos | `src/infra/env.ts` (W1) |

### 3.2 Nuevos del SDD (CD-9..CD-13)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-9** (SDD §10.2) | `extractClientIp` vive EXCLUSIVAMENTE en `src/core/network.ts` — prohibido reimplementar XFF-first en cualquier otro archivo (audit hook, keyGenerator, futuros consumers) | `src/core/network.ts` (W1), `src/app.ts` (W1 — audit hook refactor) |
| **CD-10** (SDD §10.2) | El `errorResponseBuilder` construye el body 429 EXPLÍCITAMENTE (no spread, no helper) | `src/app.ts` (W1) |
| **CD-11** (SDD §10.2) | `RATE_LIMITED` NO tiene interface, constante exportada ni tipo TS asociado — literal en `errorResponseBuilder` | `src/app.ts` (W1), `src/core/types.ts` (frozen) |
| **CD-12** (SDD §10.2) | `RATE_LIMIT_ENABLED` DEBE usar `z.enum(['true','false']).transform(v=>v==='true')` — PROHIBIDO `z.coerce.boolean()` (bug sutil: string `'false'` → truthy) | `src/infra/env.ts` (W1) |
| **CD-13** (SDD §10.2) | Plugin registrado CONDICIONALMENTE — si `env.RATE_LIMIT_ENABLED===false`, `app.register(rateLimit,...)` NO se llama. PROHIBIDO registrar con `max:Infinity` | `src/app.ts` (W1) |

### 3.3 CD-LESSONS — aprendizajes de auto-blindajes recientes

- **CD-LESSON-1** (WFAC-33 auto-blindaje): `light-my-request` inyecta `user-agent: 'lightMyRequest'` por default. Si un test quiere ejercer ausencia de UA, usar `headers: { 'user-agent': '' }` explícito. Aplicable si T-RL-11 quisiera validar ausencia de UA en log payload — no es estrictamente necesario (AC-9 solo exige ausencia de IP).
- **CD-LESSON-2** (WFAC-32 auto-blindaje): al borrar variable/symbol en fix ESLint `no-unused-vars`, correr `rg <name> src/` antes del commit. Aplica si en W3 se limpian tests intermedios o si W1 refactoriza el audit hook dejando `xff` residual en algún log.
- **CD-LESSON-3** (WFAC-23 auto-blindaje): ESLint `security/detect-object-injection` sobre lookups dinámicos → `// eslint-disable-next-line security/detect-object-injection` con justificación. Aplicable a `context.max` / `context.ttl` en errorResponseBuilder (probablemente NO — son keys literales), y a accesos a `response.headers['x-ratelimit-limit']` en tests (POSIBLE — usar camelCase via destructuring si quejas).
- **CD-LESSON-4** (WFAC-23 auto-blindaje): correr `npx prettier --write <archivos>` antes de `npm run format:check`. Obligatorio para los 3 archivos NEW: `src/core/network.ts`, `src/__tests__/unit/core/network.test.ts`, `src/__tests__/unit/rate-limiting.test.ts`.

---

## 4. Guardrails anti-drift (checklist rápido para el Dev)

**Antes de cada commit, corré mentalmente esta lista**:

- [ ] **NO extender `X402ErrorCode`** con `'RATE_LIMITED'`. `grep -n "RATE_LIMITED" src/core/types.ts src/core/errors.ts` → zero matches. (**CD-1**)
- [ ] **NO importar `@fastify/rate-limit`** desde `src/routes/*` — solo desde `src/app.ts`. `grep -rn "@fastify/rate-limit" src/routes/` → zero matches. (**arquitectura**)
- [ ] **NO hardcodear números** en `config.rateLimit` de routes — siempre `env.RATE_LIMIT_*`. (**CD-7**)
- [ ] **NO fallar** cuando Redis está down — `skipOnError:true` (runtime) + `redis: redisClient ?? undefined` (boot). (**CD-2 + AC-10**)
- [ ] **NO usar `z.coerce.boolean()`** para `RATE_LIMIT_ENABLED` — interpreta `'false'` como truthy. Usar `z.enum(['true','false']).transform(...)`. (**CD-12**)
- [ ] **NO agregar campos extra** al body 429 (`retryAfter`, `limit`, `reset`, `remaining`, `window`, etc.). Exactamente 3 keys: `code`, `message`, `http`. (**CD-3**)
- [ ] **NO incluir `ip` ni `user_agent`** en `req.log.warn(...)` payload del errorResponseBuilder. (**CD-4**)
- [ ] **NO registrar el plugin con `max:Infinity`** — usar `if (env.RATE_LIMIT_ENABLED) await app.register(...)`. (**CD-13**)
- [ ] **NO construir el body vía spread** — `return { error: { code: 'RATE_LIMITED', message: '...', http: 429 } }` literal. (**CD-10**)
- [ ] **NO reimplementar XFF** en ningún archivo fuera de `src/core/network.ts`. `grep -rn "x-forwarded-for" src/ | grep -v core/network.ts | grep -v __tests__` → zero matches. (**CD-9**)
- [ ] **NO importar `src/chains/*`, `src/methods/*`, `src/routes/*`** desde `src/core/network.ts`. (**CD-9 pure**)
- [ ] **NO loguear** en `src/core/network.ts` — pure function. (**CD-9 pure**)
- [ ] **NO modificar `src/routes/health.ts`** — ya tiene `config: { rateLimit: false }`. (**Scope IN / frozen**)
- [ ] **NO modificar `src/core/audit.ts`, `src/core/ledger.ts`, `src/core/idempotency.ts`, `src/core/schemas.ts`, `src/core/errors.ts`, `src/core/types.ts`, `src/core/settle.ts`, `src/core/verify.ts`, `src/core/supported.ts`** — core puro WFAC-previo. (**Scope IN**)
- [ ] **NO modificar `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/infra/logger.ts`** — consumidos, no modificados. (**Scope IN**)
- [ ] **NO agregar deps** en `package.json`. `@fastify/rate-limit` ya está. (**Scope IN**)
- [ ] **NO modificar `.env.example`** — documentación en PR follow-up separado si se requiere. (**Scope IN**)
- [ ] **NO cambiar** `Math.round(reply.elapsedTime)` del audit hook WFAC-33 a floor/ceil. (**WFAC-33 frozen behavior**)
- [ ] **NO usar `request.url`** en el rate-limit `errorResponseBuilder` para loguear path — usar `req.routeOptions?.url` (igual que WFAC-33 CD-12). (**CD-12 WFAC-33 heredado**)

### Regression guard CRÍTICO (tras cada wave, antes del próximo commit)

- [ ] `npm test -- --run` sigue verde para el baseline 403 tests previos.
- [ ] `npm test -- --run audit` → 15 tests WFAC-33 existing siguen verdes. **Si rompe**, el refactor del audit hook en W1.3 es defectuoso — el `extractClientIp` no retorna el mismo `ipRaw` que la lógica inline anterior. STOP + diagnose.
- [ ] `npm test -- --run routes.settle` → WFAC-21 + WFAC-32 + WFAC-33 verdes.
- [ ] `npm test -- --run routes.verify` → WFAC-20 + WFAC-33 verdes.
- [ ] `npm test -- --run routes.supported` → WFAC-22 + WFAC-33 verdes.
- [ ] `npm test -- --run routes.openapi` → WFAC-23 verdes + el test que confirma `rateLimit:false` config.
- [ ] `npm test -- --run health` → WFAC-2 + WFAC-33 verdes.
- [ ] `npm test -- --run ledger` → WFAC-32 verdes.
- [ ] `npm test -- --run supabase` → WFAC-32 verdes.
- [ ] `npm test -- --run env` → env tests originales + T-ENV-RL-1..7 verdes.
- [ ] `npm test -- --run redis` → WFAC-5 verdes.
- [ ] **≥423/423 mínimo al final de W3**. Si ves <423 → hay regresión o faltan tests, STOP + diagnose.

### Regresiones particulares a vigilar

- [ ] **Spec-literal body de WFAC-20/21/22/23**: los routes `/verify`, `/settle`, `/supported`, `/openapi.json` tienen body spec-literal definido en WFAC-20/21/22/23 CD-2. Agregar `config.rateLimit` NO debe cambiar el body de una respuesta 2xx. Si un test de shape spec-literal rompe → el plugin está modificando el reply o el `app.env` está poblando algo incorrecto.
- [ ] **Idempotency cache-hit**: los tests de WFAC-21/22 que validan cache-hit responses deben seguir verdes. El rate-limit plugin no debe interferir con el cache-hit path (que responde antes del rate-limit? — NO: rate-limit hook corre en `onRequest`, ANTES del handler que consulta cache. Si la request está bajo el límite, el handler corre y hace cache-lookup. Si supera, 429 directo. Ambos paths cubiertos por los tests existing con límites altos default en test env). **Si un test de cache-hit rompe post-W2 con env defaults** → bug.
- [ ] **Audit row de /settle success**: los tests WFAC-33 que validan `idempotencyKey` propagado al audit row deben seguir verdes. El rate-limit no interfiere porque el audit hook corre en `onResponse` (post-flush) y el auditMeta se setea en el handler antes del reply.send.

---

## 5. Done Definition (HU-40)

- [ ] Todas las waves W1-W3 cerradas con sus completion criteria.
- [ ] `npm run qa` exit 0 (typecheck + lint + format:check + test).
- [ ] **≥ 423 tests passing** (403 baseline + ≥20 nuevos, target ≥30).
- [ ] 10 archivos del Scope IN tocados; **ningún archivo fuera del Scope IN modificado**.
- [ ] `src/infra/env.ts` exporta `EnvSchema` con las 5 keys nuevas (`RATE_LIMIT_ENABLED`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_VERIFY_MAX`, `RATE_LIMIT_SETTLE_MAX`, `RATE_LIMIT_SUPPORTED_MAX`), defaults y validaciones min(1).
- [ ] `src/core/network.ts` exporta `extractClientIp(request): string | null` — pure, sin deps runtime.
- [ ] `src/app.ts`:
  - declara `declare module 'fastify' { interface FastifyInstance { env: EnvConfig } }`
  - llama `app.decorate('env', env)` post-`Fastify({...})` y pre-rutas
  - registra `@fastify/rate-limit` CONDICIONALMENTE dentro de `if (env.RATE_LIMIT_ENABLED)` con opciones `{ global:true, max, timeWindow, skipOnError:true, redis: getRedisClient()??undefined, keyGenerator: extractClientIp-based, enableDraftSpec:false, errorResponseBuilder }`
  - el `errorResponseBuilder` emite body literal `{ error: { code:'RATE_LIMITED', message:'Too many requests, please try again later', http:429 } }` + `req.log.warn({ request_id, path, rate_limit_max, rate_limit_ttl_ms }, 'rate limit exceeded')`
  - audit hook WFAC-33 refactorizado a usar `const ipRaw = extractClientIp(request);` (removido bloque XFF inline)
- [ ] `src/routes/verify.ts`, `settle.ts`, `supported.ts` declaran `config: { rateLimit: { max: env.RATE_LIMIT_X_MAX, timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000 } }` leyendo `env = app.env` al inicio del plugin.
- [ ] `src/routes/openapi.ts` declara `{ config: { rateLimit: false } }` mirror de `/health`.
- [ ] `src/routes/health.ts` intacto (WFAC-2 CD-9 frozen).
- [ ] Los 13 CDs respetados (8 heredados WI + 5 nuevos SDD) + 4 CD-LESSONS documentadas.
- [ ] `src/core/audit.ts`, `src/core/ledger.ts`, `src/core/errors.ts`, `src/core/types.ts` y demás core WFAC-previos intactos.
- [ ] `src/infra/redis.ts`, `src/infra/supabase.ts` intactos.
- [ ] `package.json` intacto (sin deps nuevas).
- [ ] `.env.example` intacto.
- [ ] `supabase/migrations/*.sql` intactos.
- [ ] Commit messages con prefix `WFAC-40` y referencia a la wave (ej: `WFAC-40 W1: env vars + extractClientIp helper + plugin registration`).

---

## 6. Referencias rápidas

- **Work Item**: `doc/sdd/015-wfac-40-rate-limiting/work-item.md`
- **SDD completo**: `doc/sdd/015-wfac-40-rate-limiting/sdd.md`
- **Baseline post-WFAC-33**: 403/403 tests passing
- **Target post-WFAC-40**: ≥ 423/423
- **Branch**: `feat/015-wfac-40-rate-limiting` (desde `main` post-WFAC-33)
- **Plugin**: `@fastify/rate-limit` v10.3.0 (ya en `package.json`)
- **Env vars nuevas (5)**:
  - `RATE_LIMIT_ENABLED` (bool, default `true`)
  - `RATE_LIMIT_WINDOW_SEC` (int ≥1, default `60`)
  - `RATE_LIMIT_VERIFY_MAX` (int ≥1, default `60`)
  - `RATE_LIMIT_SETTLE_MAX` (int ≥1, default `30`)
  - `RATE_LIMIT_SUPPORTED_MAX` (int ≥1, default `120`)
- **Orden plugin en buildApp**: `Fastify({})` → `app.decorate('env',env)` → `if(ENABLED) app.register(rateLimit,...)` → `app.register(healthRoute)` → `verify/settle/supported/openapi` → `onResponse audit hook` → `onClose redis`.
- **Patrón referencia**: `src/core/ledger.ts` (pure + boundaries estrictos) + `src/routes/health.ts` línea 37 (`rateLimit:false`) + SDD §5.2 (options completas del register).
- **HUs dependientes (future)**: per-user rate limiting (backlog), sliding window algorithm (backlog), IP allowlist/denylist (backlog), dynamic updates sin restart (backlog).

---

*Story File generado por NexusAgil — F2.5 — WFAC-40 — 2026-04-23 — Architect*
