# Story File — WFAC-AUDIT (SDD #020)

> Contrato autocontenido para el Dev (F3). **NO re-leas el SDD ni el codebase**: todo lo
> necesario está aquí. Si algo falta, parar y escalar — no inventes paths ni APIs.
> Branch: `feat/020-wfac-audit-remediation`. SPEC_APPROVED: sí.

---

## 0. Contexto compacto

`wasiai-facilitator` mueve **dinero real** (x402 / EIP-3009). El bar de seguridad excede a un
CRUD. Esta HU cierra 6 hallazgos de auditoría B+:

1. **AC-1** — auth de caller en `/settle` + `/verify` (bearer `FACILITATOR_API_KEY`, `timingSafeEqual`).
2. **AC-2** — rate-limit keyed por IP real (`trustProxy` + `request.ip`), elimina el bypass por `X-Forwarded-For` forjado.
3. **AC-3** — lock in-flight `SET NX EX` para idempotencia de settle (best-effort; el nonce on-chain es la salvaguarda última).
4. **AC-4** — checks faltantes `amount>0` / `payTo==to` / `validAfter` en los adapters live.
5. **AC-5** — base class `BaseEip3009Adapter` que deduplica kite/avalanche/base (behavior-preserving).
6. **AC-6** — `checkSettleAmountCap` fail-**closed** ante error de parseo `BigInt`.

**Regla de oro de esta HU:** los ~591 tests existentes deben seguir **verdes** sin tocar
assertions (CD-1). La única excepción documentada es R-1 (tests de XFF-keying bajo trustProxy,
ver §Wave 2).

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

**Producción (crear):**
- `src/middleware/auth.ts` (NUEVO)
- `src/chains/base-adapter.ts` (NUEVO)

**Producción (modificar):**
- `src/routes/settle.ts`
- `src/routes/verify.ts`
- `src/app.ts`
- `src/core/network.ts`
- `src/core/idempotency.ts`
- `src/core/settle-cap.ts`
- `src/chains/kite.ts`
- `src/chains/avalanche.ts`
- `src/chains/base.ts`
- `src/infra/env.ts`
- `.env.example`

**Tests (crear):**
- `src/__tests__/unit/routes.settle.auth.test.ts`
- `src/__tests__/unit/rate-limiting.xff-bypass.test.ts`
- `src/__tests__/unit/routes.settle.inflight.test.ts`

**Tests (modificar/ampliar):**
- `src/__tests__/unit/core.settle-cap.test.ts`
- `src/__tests__/unit/rate-limiting.test.ts` (solo re-expresar bajo R-1)
- `src/__tests__/unit/chains.kite.test.ts` / `chains.avalanche.test.ts` / `chains.base.test.ts` (ampliar T11-T15)
- `src/__tests__/unit/chain-adapter.test.ts` (T16 intacto; T17 opcional sin tocar assertions existentes)

**PROHIBIDO tocar (CD-6):** `src/methods/eip3009/verify.ts`, `src/methods/eip3009/settle.ts`.
**PROHIBIDO tocar:** cualquier archivo fuera de esta lista.

---

## 2. Anti-Hallucination Checklist (verificado contra el codebase)

Estos hechos están **confirmados** leyendo el código. NO los re-derives, NO los cambies:

- [ ] El env se accede vía `app.env` (decorator: `app.decorate('env', env)` en `app.ts:103`). NUNCA importar `env.ts` runtime desde `middleware/`.
- [ ] El shape de error en todas las rutas es `{ error: { code, message, http } }` (ver `settle.ts:56-62`, `app.ts:199-205`).
- [ ] `timingSafeEqual` viene de `node:crypto`. Throwea si los buffers difieren en longitud → pre-check de longitud antes (R-3).
- [ ] `extractClientIp` (`src/core/network.ts:26-39`) HOY prioriza el 1er elemento de `X-Forwarded-For` (L27-36) sobre `request.ip` (L37). **Esto ES el bypass.**
- [ ] El `keyGenerator` del rate-limit es `(req) => extractClientIp(req) ?? req.ip ?? 'unknown'` (`app.ts:171`).
- [ ] `Fastify({...})` se construye en `app.ts:98-101` SIN `trustProxy`. El rate-limit se registra DESPUÉS, en `app.ts:153-215`. **trustProxy debe ir en el constructor, ANTES (CD-5).**
- [ ] `setCachedSettleResponse` usa `client.set(key, JSON.stringify(payload), 'EX', SETTLE_IDEMPOTENCY_TTL_SEC)` (`idempotency.ts:319-330`). **Para el lock se agrega `'NX'`: `client.set(inflightKey, '1', 'EX', SETTLE_IDEMPOTENCY_TTL_SEC, 'NX')`.**
- [ ] Constantes existentes en `idempotency.ts`: `SETTLE_IDEMPOTENCY_TTL_SEC = 120` (L220), `SETTLE_IDEMPOTENCY_KEY_PREFIX = 'settle:idempotency:'` (L223), `buildSettleIdempotencyKey` (L285-289).
- [ ] `isRedisAvailable()` y `getRedisClient()` ya existen en `idempotency.ts` / `infra/redis.js`.
- [ ] `checkSettleAmountCap` (`settle-cap.ts:47-60`): el `catch` HOY retorna `{ ok: true }` (fail-OPEN, el bug). Tipo `AmountCapResult = { ok: true } | { ok: false; limit: bigint }` (L28).
- [ ] `methods/eip3009/verify.ts:96-132` tiene la semántica EXACTA de los 3 checks faltantes (ver §Wave 4). Es read-only (CD-6) — solo se COPIA la semántica a la base class.
- [ ] Los 3 adapters comparten `_verifyRaw`/`_settleRaw`/`verify`/`settle`/`getPublicClient`/`getWalletClient`/`setLogger`/`getBreakerState`/`sanitize` byte-equivalentes (confirmado contra `kite.ts:63-588`). Exports a preservar: `kiteTestnetAdapter`, `kiteMainnetAdapter`, `avalancheFujiAdapter`/`avalancheMainnetAdapter`, `baseSepoliaAdapter`/`baseMainnetAdapter` (los nombres exactos están al final de cada archivo, ~L591+).
- [ ] El env de los tests se pasa de DOS formas según el harness: `buildApp({ rawEnv })` (string record, parsea env) — usado en `rate-limiting.test.ts:84` — o `buildApp({ env })` (EnvConfig ya parseado) — usado en `routes.verify.test.ts:204-210`. Respetar el harness de cada test.
- [ ] `npm test` → `vitest run`. `npm run build` → `tsc`. `npm run typecheck` → `tsc --noEmit`.

---

## 3. Money-Safety (NO negociable)

- El refactor (W3) **NO altera** `recover` (`recoverTypedDataAddress`) ni `simulate` (`simulateContract`) ni el `recovered == from`. Se MUEVE byte-equivalente. Único cambio de comportamiento autorizado: los 3 checks ADICIONALES de W4, que solo RECHAZAN más, nunca aceptan lo que antes se rechazaba.
- El preHandler de auth **NUNCA loguea** la API key (ni `provided`, ni `configured`, ni el header `authorization`) — CD-NEW-AUTH-NOLOG. Ni en el path de error.
- El lock in-flight es best-effort. La salvaguarda última contra double-spend es el **nonce EIP-3009 on-chain**. Por eso el lock es fail-open ante Redis down (CD-7) — documentarlo en el JSDoc de `idempotency.ts`.
- Los money-checks (amount>0, value>=accepted, payTo==to, ventana temporal) van ANTES de `simulateContract` y ANTES del recover.

---

## 4. Orden de Waves (ESTRICTO)

```
W0  baseline verde (~591 tests)          → confirmar antes de tocar nada
W1  AC-6 (settle-cap)  ∥  AC-1 (auth + env)   (ortogonales)
W2  AC-2 (trustProxy + network + tests)
W3  AC-5 (base class, behavior-preserving)   ← COMMIT SEPARADO, SIN checks nuevos
W4  AC-4 (checks en la base class)            ← COMMIT SEPARADO, sobre W3
W5  AC-3 (in-flight lock)
```

**CRÍTICO (CD-2):** W3 y W4 son commits **distintos**. Primero extraer la base class
manteniendo comportamiento EXACTO (W3 = refactor puro, los ~591 tests pasan sin tocar
assertions). DESPUÉS, en W4, agregar los 3 checks en `_verifyRaw`/`_settleRaw` de la base.
**Si mezclás refactor + checks en el mismo commit, es BLOQUEANTE en AR.**

---

## WAVE 0 — Baseline (Serial Gate)

**Acción:** correr la suite completa y registrar el número exacto de tests verdes.

```bash
npm test
```

- Anotá el total (≈591). Es el baseline para validar CD-1/CD-2 en W3/W4.
- Si algún test ya falla en `main` → parar y escalar (no es trabajo de esta HU arreglarlo a ciegas).

---

## WAVE 1 — AC-6 (settle-cap fail-closed) + AC-1 (auth)

> W1.1 y W1.2 son ortogonales (archivos distintos). Pueden ir en cualquier orden.

### W1.1 — AC-6: `checkSettleAmountCap` fail-closed

**Archivo:** `src/core/settle-cap.ts`

**Cambio concreto** (sobre `settle-cap.ts:47-60`):
1. En el `catch` (hoy `return { ok: true }`) → `return { ok: false, limit: 0n }`.
2. Agregar guard `amount <= 0n` ANTES del check `amount > cap`: si `amount <= 0n` → `return { ok: false, limit: 0n }` (cubre T21).
3. Reemplazar el comentario fail-open por: `// fail-closed — un cap (o amount) imparseable/no-positivo es misconfig; bloquear es el default seguro.`

Patrón final esperado:
```ts
export function checkSettleAmountCap(amountAtomic: string, capAtomic: string): AmountCapResult {
  try {
    const amount = BigInt(amountAtomic);
    const cap = BigInt(capAtomic);
    if (amount <= 0n) return { ok: false, limit: 0n };   // NUEVO (T21)
    if (amount > cap) return { ok: false, limit: cap };
    return { ok: true };
  } catch {
    return { ok: false, limit: 0n };                      // CAMBIO: fail-closed
  }
}
```
> NO tocar `incrementAndCheckDailyCap` (su fail-mode es independiente, controlado por env).

**Tests:** `src/__tests__/unit/core.settle-cap.test.ts` — AMPLIAR (no reescribir):
- **T19**: `checkSettleAmountCap('abc', '100')` → `{ ok: false, limit: 0n }`.
- **T20**: `checkSettleAmountCap('100', 'abc')` → `{ ok: false, limit: 0n }`.
- **T21**: `checkSettleAmountCap('0', '100')` → `{ ok: false, limit: 0n }`.
- **T22**: `checkSettleAmountCap('50', '100')` → `{ ok: true }` (regression happy path).
- Caso extra recomendado: `('1.5', '100')` y `('', '100')` → `{ ok: false, limit: 0n }`.

**Verificación W1.1:** `npx tsc --noEmit && npm test` — settle-cap verde + suite verde.

---

### W1.2 — AC-1: auth middleware + env + preHandlers

**Archivo 1:** `src/infra/env.ts` — agregar `FACILITATOR_API_KEY`.

- En `EnvSchema` (junto a `OPERATOR_PRIVATE_KEY`, ~L67-70):
  ```ts
  // WFAC-AUDIT — caller auth. Optional at Zod level; .superRefine enforces
  // presence for non-test env (same pattern as OPERATOR_PRIVATE_KEY). NEVER logged.
  FACILITATOR_API_KEY: z.string().min(1).optional(),
  ```
- En el `.superRefine` (junto al de `OPERATOR_PRIVATE_KEY`, L151-157), agregar:
  ```ts
  if (!data.FACILITATOR_API_KEY && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FACILITATOR_API_KEY'],
      message: 'FACILITATOR_API_KEY is required when NODE_ENV is not "test"',
    });
  }
  ```
> Patrón EXACTO copiado de `OPERATOR_PRIVATE_KEY` (env.ts:67-70 + 151-157). NO usar `z.coerce.boolean()` (no aplica — es string).

**Archivo 2:** `src/middleware/auth.ts` — CREAR. (`src/middleware/` hoy solo tiene `.gitkeep`.)

Firma exacta del preHandler (Fastify v5):
```ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireFacilitatorKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const configured = request.server.env.FACILITATOR_API_KEY;

  // DT-7 bypass: only possible en NODE_ENV==='test' (superRefine garantiza
  // presencia en prod). Sin key configurada → no auth.
  if (configured === undefined) return;

  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return unauthorized(reply);
  }
  const provided = header.slice('Bearer '.length);

  // R-3: timingSafeEqual throwea si las longitudes difieren. El length no es
  // secreto → si difieren, 401 directo (sin comparar bytes).
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return unauthorized(reply);
  }
  // match → return (continúa el pipeline).
}

function unauthorized(reply: FastifyReply): void {
  reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', http: 401 },
  });
}
```

Reglas:
- **CD-NEW-AUTH-NOLOG**: cero `log.*` con `provided`/`configured`/`authorization`. Ni en error.
- **CD-4**: `timingSafeEqual`, NUNCA `===` para comparar.
- **CD-14**: respondemos con `reply.code(401).send()` DIRECTO (no `throw`). NO introducir un throw que dependa de `error.statusCode`.
- **OWNERS / boundary**: `src/middleware/` MAY importar `node:crypto` + tipos de `fastify`. MUST NOT importar `src/core/*`, `src/methods/*`, `src/chains/*`, ni `src/infra/env.ts` runtime. La key se lee SOLO vía `request.server.env`.
- `code: 'UNAUTHORIZED'` es route/middleware-local (NO está en `X402ErrorCode`; igual que `RATE_LIMITED`/`SERVICE_UNAVAILABLE` lo son).

**Archivo 3:** `src/routes/settle.ts` — agregar `preHandler` al `app.post`.

Sobre `settle.ts:70-79`, cambiar el objeto de opciones del `app.post('/settle', {...})` para incluir:
```ts
import { requireFacilitatorKey } from '../middleware/auth.js';
// ...
app.post(
  '/settle',
  {
    preHandler: requireFacilitatorKey,           // NUEVO (AC-1)
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_SETTLE_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
      },
    },
  },
  async (request, reply) => { /* ... handler sin cambios en W1 ... */ },
);
```
> El `import` debe respetar el orden de imports existente. El `.js` en el path es obligatorio (NodeNext/ESM, como todos los imports del repo).

**Archivo 4:** `src/routes/verify.ts` — idéntico: agregar `preHandler: requireFacilitatorKey` al `app.post('/verify', {...})` (verify.ts:68-77), importar de `'../middleware/auth.js'`.

> NO agregar auth a `/health`, `/supported`, `/openapi.json`, `/metrics` (se aplica per-route, NO hook global).

**Archivo 5:** `.env.example` — documentar (CD-8), junto a `OPERATOR_PRIVATE_KEY` (L27):
```
# Caller authentication for /settle and /verify (WFAC-AUDIT).
# REQUIRED in production (NODE_ENV != test). Sent by clients as
# `Authorization: Bearer <FACILITATOR_API_KEY>`. Compared with timingSafeEqual.
# SECURITY: rotate if leaked; never commit a real value; never logged.
FACILITATOR_API_KEY=replace-with-a-long-random-secret
```

**Tests:** `src/__tests__/unit/routes.settle.auth.test.ts` — CREAR.
Harness: copiar el patrón de `routes.verify.test.ts:180-211` (`makeEnv()` + `buildAppWithAdapter()` + `app.inject()`). El `buildApp({ env })` recibe un `EnvConfig`; pasá `FACILITATOR_API_KEY: 'test-secret-key'` en el override de `makeEnv` para los tests que necesitan key, y NO lo pongas para el test de bypass.
- **T1**: POST `/settle` SIN header `Authorization` (con key configurada) → 401, body `{ error: { code:'UNAUTHORIZED', http:401 } }`.
- **T2**: POST `/settle` con `Authorization: Bearer wrong-key` → 401.
- **T3**: POST `/settle` con `Authorization: Bearer test-secret-key` válido → pasa el preHandler → llega al pipeline (el fake adapter / mock retorna ok, o devuelve un error de negocio NO-401).
- **T4**: POST `/verify` SIN header (con key configurada) → 401 (mismo preHandler).
- **T5**: `FACILITATOR_API_KEY` ausente en env de test → preHandler bypass → request procede normal (no 401).

**Verificación W1.2:** `npx tsc --noEmit && npm test` — auth tests verdes + suite verde.

---

## WAVE 2 — AC-2 (trustProxy + IP keying)

> W2 toca `app.ts`, `network.ts`, `env.ts` y los tests de rate-limit. **R-1 aplica aquí.**

**Archivo 1:** `src/infra/env.ts` — agregar `TRUST_PROXY`.
```ts
// WFAC-AUDIT — Fastify trustProxy hop count. Railway = 1 hop ('1').
// If Cloudflare sits in front, bump to '2' via env (no code change, CD-3).
// In tests set 'false' to avoid depending on proxy infra (R-1).
TRUST_PROXY: z.string().default('1'),
```
> `TRUST_PROXY` es string. NO `z.coerce.boolean()`. La coerción a number/boolean ocurre en `app.ts` (ver `parseTrustProxy` abajo).

**Archivo 2:** `src/app.ts` — configurar `trustProxy` en el constructor (CD-5).

Sobre `app.ts:98-101`:
```ts
const app = Fastify({
  loggerInstance: logger,
  disableRequestLogging: false,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),   // NUEVO — ANTES del rate-limit (CD-5)
});
```
Helper local en `app.ts` (no exportar):
```ts
// 'false'/'true' → boolean; numeric string → number (hop count); otro → string.
function parseTrustProxy(raw: string): boolean | number | string {
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : raw;
}
```
> El `keyGenerator` (`app.ts:171`) NO necesita cambiar su forma — `extractClientIp(req) ?? req.ip ?? 'unknown'` queda igual; tras el cambio de `network.ts` ambos términos colapsan a `req.ip`.

**Archivo 3:** `src/core/network.ts` — invertir precedencia (eliminar el vector de bypass).

Sobre `network.ts:26-39`, reemplazar TODO el cuerpo de `extractClientIp` por:
```ts
export function extractClientIp(request: FastifyRequest): string | null {
  // WFAC-AUDIT — under trustProxy, Fastify already resolves request.ip from the
  // correct XFF hop. Parsing the raw first XFF element here WAS the spoofing
  // vector (an attacker rotates X-Forwarded-For to dodge the rate-limit bucket).
  // We now trust Fastify's resolved request.ip exclusively.
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}
```
> Actualizá el bloque de comentario "Precedence" del header del archivo (L8-13) para reflejar la nueva semántica (single source: `request.ip`). El contrato `string | null` y "pure, no throw" se preserva.

**Tests nuevos:** `src/__tests__/unit/rate-limiting.xff-bypass.test.ts` — CREAR.
Harness: copiar `makeApp({...})` de `rate-limiting.test.ts:70-85` (usa `buildApp({ rawEnv })`). Para que el XFF se traduzca a `request.ip` en `app.inject`, el rawEnv debe tener `TRUST_PROXY: 'true'` (con `inject` el peer es loopback/`127.0.0.1`, que con trustProxy=true es trusted → Fastify resuelve `request.ip` desde XFF).
- **T6**: con `RATE_LIMIT_VERIFY_MAX:'2'` y `TRUST_PROXY:'true'`, enviar 3 requests con XFF **rotante** (`1.1.1.1`, `2.2.2.2`, `3.3.3.3`) pero el MISMO peer → Fastify resuelve la misma `request.ip` (loopback) para todas (el atacante no controla el peer) → la 3ª recibe **429**. (Demuestra que rotar XFF NO evade el bucket.)
  - Nota de diseño: bajo `inject`, todas comparten el peer loopback, por lo que `request.ip` es estable independientemente del XFF → mismo bucket. ESE es el comportamiento deseado.
- **T7**: assert que `request.ip` (vía un endpoint de eco o leyendo el log/keyGenerator) refleja la IP resuelta por Fastify, no el XFF crudo del atacante.

**Tests a re-expresar (R-1 — cambio INTENCIONAL, documentar):** `src/__tests__/unit/rate-limiting.test.ts`

> **R-1 (del SDD §7) — declaración explícita de cambio de semántica:**
> Bajo `trustProxy`, el primer elemento crudo de `X-Forwarded-For` ya NO separa buckets de
> rate-limit. Por defecto en tests `TRUST_PROXY='false'` → `request.ip` = peer (loopback)
> para TODAS las inject calls. Los tests que dependían de XFF distinto para separar cuotas
> **cambian de semántica a propósito** — NO es una regresión silenciosa, es el fix de AC-2.

Acciones concretas:
- **T-RL-10** (`rate-limiting.test.ts:263-293`, "distinct XFF IPs consume separate quotas"): bajo trustProxy esto YA NO es cierto vía XFF crudo. Re-expresar para separar buckets por el peer real usando el `remoteAddress` de `app.inject` (light-my-request acepta `remoteAddress` en el objeto de inject) en lugar de `x-forwarded-for`. Ej:
  ```ts
  await app.inject({ method:'POST', url:'/verify', remoteAddress:'1.1.1.1', payload: ANY_PAYLOAD });
  await app.inject({ method:'POST', url:'/verify', remoteAddress:'2.2.2.2', payload: ANY_PAYLOAD });
  ```
  Con `TRUST_PROXY:'false'` en `makeApp`, `request.ip` = `remoteAddress` → buckets separados. Mantener la assertion semántica (dos IPs reales distintas → cuotas separadas), cambiando el VECTOR (peer real, no XFF).
- **T-RL-1..T-RL-9, T-RL-11**: usan XFF distinto SOLO como ruido inofensivo (cada test arma su propio `app` con LocalStore aislada, así que la separación por XFF no era necesaria para el aislamiento entre tests — solo importa el conteo DENTRO de cada test, que usa el mismo XFF/peer). Estos tests deben seguir pasando SIN cambios porque dentro de cada test el peer es estable. **Verificar uno por uno tras el cambio de `network.ts`.** Si alguno se rompe porque asumía que el XFF se reflejaba en `request.ip` o en un log, ajustarlo mínimamente y documentarlo en el commit (mismo criterio R-1).
- Actualizá el bloque "AC coverage" del header (`rate-limiting.test.ts:17-31`) para anotar que AC-8/T-RL-10 ahora usa `remoteAddress` (R-1).

**Verificación W2:** `npx tsc --noEmit && npm test` — XFF-bypass verde + suite verde (con T-RL-10 re-expresado).

---

## WAVE 3 — AC-5 (base class, behavior-preserving) — COMMIT SEPARADO

> **REGLA INVIOLABLE (CD-2):** W3 es refactor PURO. CERO lógica nueva. Los ~591 tests pasan
> SIN tocar assertions. Los checks de AC-4 van en W4 (commit aparte). Si agregás un check acá,
> es BLOQUEANTE.

**Archivo nuevo:** `src/chains/base-adapter.ts`

`export abstract class BaseEip3009Adapter implements ChainAdapter`.

**Constructor** recibe `BaseAdapterOpts`:
```ts
interface BaseAdapterOpts {
  chainIdNum: number;
  name: string;
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  viemChain: Chain;
  token: EIP3009Token;          // { address, symbol, decimals, name, eip712Name, eip712Version }
  blockExplorer?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}
```
El constructor construye `this.metadata` (idéntico a `kite.ts:144-169`) y `this._breaker`
(idéntico a `kite.ts:175-182`, con `readCbNumber`/`readCbBool`).

**Métodos a MOVER a la base class (byte-equivalentes — copiar de `kite.ts`):**

| Método | Origen exemplar | Notas |
|--------|-----------------|-------|
| `sanitize` (helper de módulo) | `kite.ts:63-66` | función de módulo, no método |
| `getPublicClient()` | `kite.ts:185-193` | usa `this._viemChain`, `this._rpcUrl` |
| `getWalletClient()` | `kite.ts:195-205` | `getOperatorAccount()` |
| `setLogger(logger)` | `kite.ts:207-209` | |
| `getBreakerState()` | `kite.ts:211-213` | |
| `verify(params)` | `kite.ts:224-257` | CB + BusinessFailureError wrapping |
| `settle(params)` | `kite.ts:401-430` | CB + BusinessFailureError wrapping |
| `_verifyRaw(params)` | `kite.ts:263-398` | **byte-equivalente, SIN checks nuevos en W3** |
| `_settleRaw(params)` | `kite.ts:437-588` | **byte-equivalente, SIN checks nuevos en W3** |

Imports compartidos (de `kite.ts:19-56`): `viem` (`createPublicClient`, `createWalletClient`,
`http`, `isAddressEqual`, `recoverTypedDataAddress`, `getAddress`), tipos viem, `./types.js`,
`./circuit-breaker.js`, `./abi/fiat-token.js`, `./abi/signature.js`, `../infra/wallet.js`,
`../core/types.js` (type-only `asChainId`).

> `_verifyRaw`/`_settleRaw` NO se hacen abstractos — hay UNA sola implementación en la base
> (DT-5/§4.3-D). Las subclases NO los overridean.

**Boundary (PROHIBIDO):** `base-adapter.ts` NO importa `src/core/*` runtime (solo el type-only
`asChainId` de `../core/types.js`), NO importa `src/methods/*`, NO importa `src/routes/*` — igual
que los adapters hoy.

**Archivos a migrar — convertir cada adapter en thin wrapper (<100 líneas):**

`src/chains/kite.ts` — `class KiteAdapter extends BaseEip3009Adapter`. RETIENE únicamente:
- `readEnv` (`KiteRpcEnvName`, kite.ts:73-89), `readUsdcAddress` (kite.ts:604-620), `readEnabledFlag` (kite.ts:635-645).
- El constructor construye su `viemChain` con `defineChain` (kite.ts:125-134), arma el `token` (defaults PYUSD, kite.ts:138-167) y llama `super({...})`.
- `nativeCurrency` Kite (`{ name:'Kite', symbol:'KITE', decimals:18 }`).
- Exports `kiteTestnetAdapter` (kite.ts:647-653) y `kiteMainnetAdapter` (kite.ts:666-684) — **nombres y shape IDÉNTICOS** (R-2).

`src/chains/avalanche.ts` — `class AvalancheAdapter extends BaseEip3009Adapter`. RETIENE:
- `USDC_FUJI`/`USDC_AVALANCHE_MAINNET` (avalanche.ts:83-102), `readRpcUrl`/`readEnabledFlag`.
- `viemChain` desde `viem/chains` (`avalanche`, `avalancheFuji`), `token` por constructor, `nativeCurrency` AVAX (`{ name:'Avalanche', symbol:'AVAX', decimals:18 }`).
- Exports `avalancheFujiAdapter`/`avalancheMainnetAdapter` (avalanche.ts:~599-622) — nombres/shape idénticos.

`src/chains/base.ts` — `class BaseAdapter extends BaseEip3009Adapter`. RETIENE:
- `USDC_BASE_SEPOLIA`/`USDC_BASE_MAINNET` (base.ts:96-116), `readRpcUrl`/`readEnabledFlag`.
- `viemChain` desde `viem/chains` (`base`, `baseSepolia`), `token` por constructor, `nativeCurrency` ETH (`{ name:'Ether', symbol:'ETH', decimals:18 }`).
- Exports `baseSepoliaAdapter`/`baseMainnetAdapter` (base.ts:~606-639) — nombres/shape idénticos.

> **R-2 / CD-13:** ANTES de cambiar exports o el nombre de clase, grepear TODOS los consumidores
> con la regex ampliada: `KiteAdapter\s*[).\[]`, `kiteTestnetAdapter`, etc. — incluyendo
> `.toHaveLength`, `[N]`, `for...of`, `.map`, `.forEach`. Los tests instancian estas clases
> (`chain-adapter.test.ts`). NO renombrar ni cambiar el shape de las exports.
> `src/chains/index.ts` importa los exports y hace `chainRegistry.register(...)` — debe seguir
> compilando sin cambios.

**Tests:**
- **T16**: `chain-adapter.test.ts` (1387 líneas) corre INTACTO. NO tocar assertions. Es el guardrail behavior-preserving.
- **T17** (opcional): podés agregar un test que instancie `BaseEip3009Adapter` vía una subclase mock con token mock y verifique `_verifyRaw`. NO modificar tests existentes para ello.
- **T18** (LOC): confirmar `wc -l` de `kite.ts`/`avalanche.ts`/`base.ts` < 100 c/u, con la lógica en `base-adapter.ts`.

**Verificación W3 (BLOQUEANTE):**
```bash
npx tsc --noEmit
npm test          # los ~591 deben pasar SIN cambiar assertions
wc -l src/chains/kite.ts src/chains/avalanche.ts src/chains/base.ts   # < 100 c/u
```
**Commit W3 aquí (refactor puro). NO seguir a W4 en el mismo commit.**

---

## WAVE 4 — AC-4 (checks en la base class) — COMMIT SEPARADO sobre W3

> Solo se toca `src/chains/base-adapter.ts` (`_verifyRaw` y `_settleRaw`). Una sola
> implementación → un solo lugar. Semántica COPIADA de `methods/eip3009/verify.ts:96-132`
> (read-only, CD-6).

### Orden EXACTO de checks en `_verifyRaw` (DT-6 / CD-NEW-ORDER)

Insertar los 3 checks NUEVOS (marcados ⟵NUEVO) en este orden exacto. Todo con `BigInt`
(BLQ-MED-1: `validBefore`/`validAfter`/`value` son uint256 strings, `Number()` pierde precisión):

| # | Check | Condición de rechazo | code / message / http |
|---|-------|----------------------|------------------------|
| 1 | token presente | `!token` | `NETWORK_MISMATCH` / 'Chain has no registered token' / 400 |
| 2 | network match | `accepted.network !== metadata.networkId` | `NETWORK_MISMATCH` / 'Network does not match chain' / 400 |
| 3 | asset match | `!isAddressEqual(accepted.asset, token.address)` | `NETWORK_MISMATCH` / 'Asset not found in chain token registry' / 400 |
| 4 ⟵NUEVO | **amount > 0** | `BigInt(accepted.amount) <= 0n` | `INVALID_AMOUNT` / 'Accepted amount must be greater than zero' / 400 |
| 5 | value >= accepted | `BigInt(authorization.value) < acceptedAmount` | `INVALID_AMOUNT` / 'Authorized value is below accepted amount' / 400 |
| 6 ⟵NUEVO | **payTo == to** | `!isAddressEqual(authorization.to, accepted.payTo)` | `INVALID_RECEIVER` / 'Receiver does not match payTo' / 400 |
| 7 | validBefore (expired) | `BigInt(authorization.validBefore) <= nowSec` | `EXPIRED_AUTHORIZATION` / 'Authorization expired' / 400 |
| 8 ⟵NUEVO | **validAfter (not yet valid)** | `BigInt(authorization.validAfter) > nowSec` | `EXPIRED_AUTHORIZATION` / 'Authorization not yet valid' / 400 |
| 9 | normalize sig | `!sig.ok` | `sig.error` (INVALID_SIGNATURE) |
| 10 | recover | throw | `INVALID_SIGNATURE` / 'Failed to recover typed data address' / 401 |
| 11 | recovered == from | `!isAddressEqual(recovered, authorization.from)` | `INVALID_SIGNATURE` / 'Recovered address does not match sender' / 401 |

> Semántica idéntica a `methods/eip3009/verify.ts`: amount>0 (L98-103), value>=accepted (L104-109), payTo==to (L112-117), validBefore (L124-126), validAfter (L127-132). `nowSec = BigInt(Math.floor(Date.now() / 1000))`.

### `_settleRaw` — mismos 3 checks nuevos

Agregar los checks 4, 6, 8 (mismo code/message/http/orden) en el bloque defense-in-depth de
`_settleRaw` (hoy pasos 1-4: network → asset → value → validBefore, ver `kite.ts:454-495`), ANTES
del normalize-sig + simulate. Orden resultante en `_settleRaw`: network → asset → **amount>0** →
value>=accepted → **payTo==to** → validBefore → **validAfter** → normalize → simulate → write → receipt.

> NO tocar `simulateContract`, `writeContract`, `waitForTransactionReceipt`, `sanitize` ni el
> mapeo de éxito (kite.ts:497-588). Solo INSERTAR los 3 checks.

**Tests (T11-T15):** ampliar `chains.kite.test.ts` / `chains.avalanche.test.ts` / `chains.base.test.ts`
(harness de fixtures EIP-712 reales + mock clients, patrón `chains.base.test.ts:1-60`):
- **T11**: `_verifyRaw` con `accepted.amount = '0'` (o `value='0'`) → `INVALID_AMOUNT` 400.
- **T12**: `_verifyRaw` con `authorization.to != accepted.payTo` → `INVALID_RECEIVER` 400.
- **T13**: `_verifyRaw` con `validAfter` en el futuro (not-yet-valid) → `EXPIRED_AUTHORIZATION` 400 — distinto de validBefore-expired (verificar el mensaje 'Authorization not yet valid').
- **T14**: las mismas T11-T13 para `_settleRaw` (rechazo ANTES del simulate, sin gastar gas).
- **T15**: path de success con todos los campos válidos sigue pasando (regression).

> **R-6:** si algún test de adapter EXISTENTE asumía comportamiento laxo (fixture con `validAfter`
> futuro o `to != payTo` que antes pasaba), ajustá el FIXTURE (no la assertion de seguridad) y
> documentalo en el commit. Esos checks solo rechazan más; nunca aceptan lo que antes se rechazaba.

**Verificación W4:**
```bash
npx tsc --noEmit
npm test    # T11-T15 verdes + suite verde
```
**Commit W4 aquí (separado de W3).**

---

## WAVE 5 — AC-3 (in-flight lock)

**Archivo 1:** `src/core/idempotency.ts` — agregar el lock.

Junto a las constantes settle (idempotency.ts:219-223):
```ts
/** Prefix for in-flight settle locks (distinct from idempotency entries). */
export const SETTLE_INFLIGHT_KEY_PREFIX = 'settle:inflight:';
```
Derivar la inflight-key reemplazando el prefix idempotency por el inflight (mismo hash canónico):
```ts
function toInflightKey(idempotencyKey: string): string {
  // idempotencyKey = `${SETTLE_IDEMPOTENCY_KEY_PREFIX}${hash}`
  return idempotencyKey.startsWith(SETTLE_IDEMPOTENCY_KEY_PREFIX)
    ? `${SETTLE_INFLIGHT_KEY_PREFIX}${idempotencyKey.slice(SETTLE_IDEMPOTENCY_KEY_PREFIX.length)}`
    : `${SETTLE_INFLIGHT_KEY_PREFIX}${idempotencyKey}`;
}
```
Façade (mismo patrón swallow-on-error que `setCachedSettleResponse`, idempotency.ts:319-330):
```ts
/**
 * Acquire an in-flight lock for a settle request.
 *
 * Returns:
 *   - 'acquired' → lock set (SET NX OK) → caller dispatches settleCore.
 *   - 'held'     → lock already exists (concurrent identical request in-flight)
 *                  → caller responds HTTP 409.
 *   - 'skipped'  → Redis unavailable / error → caller proceeds WITHOUT lock.
 *
 * SAFETY: This lock is a BEST-EFFORT server-side optimization. The ULTIMATE
 * double-spend safeguard is the EIP-3009 on-chain nonce — a second
 * transferWithAuthorization with the same nonce reverts on-chain. That is why
 * fail-open on Redis outage (CD-7) is safe here: the chain is the source of truth.
 */
export async function setInflightSettleLock(
  idempotencyKey: string,
): Promise<'acquired' | 'held' | 'skipped'> {
  const client = getRedisClient();
  if (!client) return 'skipped';
  try {
    const res = await client.set(
      toInflightKey(idempotencyKey), '1', 'EX', SETTLE_IDEMPOTENCY_TTL_SEC, 'NX',
    );
    return res !== null ? 'acquired' : 'held';
  } catch {
    return 'skipped';   // fail-open (CD-7)
  }
}

export async function releaseInflightSettleLock(idempotencyKey: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.del(toInflightKey(idempotencyKey));
  } catch {
    // swallow — TTL (120s) is the backstop.
  }
}
```
> El `client.set(..., 'EX', ttl, 'NX')` es la firma de ioredis. TTL reusa `SETTLE_IDEMPOTENCY_TTL_SEC` (120s).

**Archivo 2:** `src/routes/settle.ts` — insertar el lock.

Insertar ENTRE el cache-miss (settle.ts:126-129, rama `else` del `if (redisUp)`) y el daily-cap
(Step 2.5, settle.ts:131). Lógica:
```ts
// AC-3 — in-flight lock (only when Redis is up). Best-effort; on-chain nonce
// is the ultimate safeguard (see idempotency.ts doc).
let lockAcquired = false;
if (redisUp) {
  const lock = await setInflightSettleLock(idempotencyKey);
  if (lock === 'held') {
    const body: ErrorBody = {
      error: { code: 'CONFLICT', message: 'Settlement already in-flight', http: 409 },
    };
    request.auditMeta = { ...request.auditMeta, errorCode: 'CONFLICT' };
    return reply.code(409).send(body);
  }
  if (lock === 'skipped') {
    app.log.warn({ request_id: requestId }, 'in-flight lock skipped — Redis unavailable');
  } else {
    lockAcquired = true;
  }
}
```
**Release en TODOS los paths terminales (R-4)** — el lock NUNCA debe quedar colgado 120s y
bloquear un retry legítimo. Llamar `if (lockAcquired) await releaseInflightSettleLock(idempotencyKey);`:
- En el `catch` del adapter-throw (settle.ts:191-233) ANTES del `return reply.code(500)`.
- En la rama de error de negocio (settle.ts:244-293) ANTES del `return reply.code(result.error.http)`.
- En el path de éxito, tras `setCachedSettleResponse` (settle.ts:236-241) y antes del `reply.code(200)`.
- Tip: usar un `try/finally` alrededor del bloque post-lock, o liberar explícitamente en cada `return`. El `del` es swallow-on-error, así que es seguro llamarlo siempre que `lockAcquired`.

Agregar `'CONFLICT'` al union `SettleRouteErrorCode` (settle.ts:40-54) — es route-local (NO en `X402ErrorCode`, igual que `SERVICE_UNAVAILABLE`/`RATE_LIMITED`):
```ts
  | 'SERVICE_UNAVAILABLE'
  | 'CONFLICT'; // WFAC-AUDIT AC-3 — route-local, NOT in X402ErrorCode
```
Imports: agregar `setInflightSettleLock, releaseInflightSettleLock, SETTLE_INFLIGHT_KEY_PREFIX` (si se usa) al import de `'../core/idempotency.js'` (settle.ts:26-33).

**Tests:** `src/__tests__/unit/routes.settle.inflight.test.ts` — CREAR.
Harness: patrón de `routes.settle.test.ts:1-55` (`buildApp` + fake adapter + `app.inject()`) + mock de Redis para controlar `set NX`. Mockear `setInflightSettleLock` (o el `getRedisClient`) para forzar cada rama.
- **T8**: dos requests idénticas concurrentes → la 1ª despacha `settleCore`, la 2ª (lock `'held'`) → **409** `{ error: { code:'CONFLICT', http:409 } }`. Verificar que `settleCore` se invocó UNA sola vez.
- **T9**: Redis down (`getRedisClient()` → null → lock `'skipped'`) → request procede normal (no 409), warn emitido, sin PII.
- **T10**: el JSDoc de `setInflightSettleLock` en `idempotency.ts` describe el lock como best-effort y el nonce on-chain como salvaguarda última (assert textual sobre el doc, o test que documenta la garantía). Cubre AC-3 doc requirement.

**Verificación W5:** `npx tsc --noEmit && npm test` — T8-T10 verdes + suite completa verde.

---

## 5. Done Definition (por AC)

| AC | DoD | Evidencia |
|----|-----|-----------|
| AC-1 | `/settle` y `/verify` → 401 sin bearer válido ANTES de business logic; key válida → pipeline; test env sin key → bypass. NUNCA loguea la key. | `routes.settle.auth.test.ts` T1-T5 verdes |
| AC-2 | rate-limit keyed por `request.ip` (post-trustProxy); XFF rotante desde mismo peer → mismo bucket. `extractClientIp` sin parseo de XFF crudo. | `rate-limiting.xff-bypass.test.ts` T6-T7 + T-RL-10 re-expresado |
| AC-3 | `SET NX EX` antes de `settleCore`; `'held'` → 409; release en todos los paths; doc nonce on-chain. Fail-open Redis down. | `routes.settle.inflight.test.ts` T8-T10 |
| AC-4 | `_verifyRaw`/`_settleRaw` checan amount>0 / payTo==to / validAfter en el orden DT-6, idéntico a `methods/eip3009/verify.ts`. | T11-T15 en chains.*.test.ts |
| AC-5 | `BaseEip3009Adapter` con la lógica compartida UNA vez; 3 adapters <100 líneas; ~591 tests sin tocar assertions. | T16 intacto + T18 (wc -l) |
| AC-6 | `checkSettleAmountCap` fail-closed (`{ ok:false, limit:0n }`) ante parse error y amount<=0. | core.settle-cap.test.ts T19-T22 |

**Comandos de cierre (todos deben pasar):**
```bash
npm run build        # tsc
npx tsc --noEmit     # typecheck estricto, sin `any`
npm test             # vitest run — ~591 baseline + nuevos, TODO verde
```

**Reglas de commit:**
- W3 (refactor) y W4 (checks) son **commits SEPARADOS** (CD-2). No mezclar.
- R-1 (re-expresión de T-RL-10) se documenta en el mensaje de commit de W2 como cambio intencional, no regresión.
- Golden Path: sin hardcodes (key/proxy desde env), sin secrets en código, TypeScript strict sin `any`.

---

## 6. Constraint Directives heredados (resumen — detalle en SDD §5)

- **CD-1**: refactor behavior-preserving; ~591 tests verdes sin tocar assertions. Fallo = BLOQUEANTE.
- **CD-2**: refactor (W3) y checks (W4) en commits separados. Refactor PRIMERO.
- **CD-3**: PROHIBIDO hardcodear `FACILITATOR_API_KEY` / `TRUST_PROXY` — solo desde env.
- **CD-4**: `timingSafeEqual` para la API key. `===` PROHIBIDO.
- **CD-5**: `trustProxy` en el constructor `Fastify({...})` ANTES del registro de rate-limit.
- **CD-6**: PROHIBIDO modificar `src/methods/eip3009/*`.
- **CD-7**: lock in-flight fail-open ante Redis down (warn).
- **CD-8**: documentar `FACILITATOR_API_KEY` + `TRUST_PROXY` en `.env.example`.
- **CD-13**: al mover símbolos consumidos por tests, grep ampliado de consumidores (`SYMBOL\s*[).\[]`).
- **CD-NEW-AUTH-NOLOG**: el preHandler NUNCA loguea la API key.
- **CD-NEW-ORDER**: orden de checks en `_verifyRaw`/`_settleRaw` exactamente DT-6.

---

*Story File generado por NexusAgil F2.5 — contrato autocontenido para F3.*
