# SDD — [WFAC-41] Circuit Breaker per Chain RPC

**HU**: WFAC-41
**Mode**: QUALITY (resiliency-critical — protege pool de workers contra RPC cold/slow)
**Branch**: `feat/016-wfac-41-circuit-breaker` (desde `main` post-WFAC-40 / post-WFAC-53)
**Status**: F2 — awaiting `SPEC_APPROVED`
**Inputs**: `doc/sdd/016-wfac-41-circuit-breaker/work-item.md`
**Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 1. Context & Goals

### 1.1 Problem

Hoy cada call a `verify()` o `settle()` de un adapter viaja directo a viem → RPC.
Cuando el RPC está caído o muy lento, cada request se cuelga ~30 s (viem default),
consumiendo connections y bloqueando workers. En pico esto colapsa el pool y
afecta también a chains sanas (contagio por recursos globales del event loop).

### 1.2 Outcome

Cada `ChainAdapter` envuelve `verify` y `settle` con un **circuit breaker
per-chain**. Después de `CB_FAILURE_THRESHOLD` fallos en `CB_ROLLING_WINDOW_MS`
ms, el breaker pasa a OPEN y fast-failan requests durante `CB_RESET_TIMEOUT_MS`.
Probes HALF_OPEN deciden cerrar o re-abrir. Responde 503 con `Retry-After` +
nuevo error code `CHAIN_UNAVAILABLE`. Métricas prom-client + log `warn` en
transiciones. Env-driven, `CB_ENABLED=false` bypassea todo.

### 1.3 Scope boundaries

- **IN**: `ChainCircuitBreaker` en `src/chains/`, wrap en `kite.ts` + `avalanche.ts`,
  4 nuevas env vars (CB_ENABLED + 3 numéricas), `CHAIN_UNAVAILABLE` en
  `X402ErrorCode` + `HTTP_BY_CODE` + `DEFAULT_MESSAGE_BY_CODE`, header
  `Retry-After` en `/verify` y `/settle`, prom-client gauges/counters, tests.
- **OUT**: Retry queue (WFAC-42), adaptive thresholds, distributed state
  (Redis-backed breaker), per-method granularity, fallback chain routing,
  ruta `/metrics` (solo registramos en default registry — la ruta es otra HU),
  ruta `/status/circuit-breakers` (AC-9 se resuelve extendiendo `GET /supported`
  con un campo opcional — ver DT-7).

---

## 2. Context Map — archivos leídos + patrones extraídos

| Archivo | Por qué se leyó | Patrón extraído |
|---------|-----------------|-----------------|
| `src/chains/types.ts` | contratos `ChainAdapter`, `AdapterResult<T>`, `VerifyParams`, `SettleParams` | `AdapterResult<T> === Result<T>` del core. Todo error del adapter es un `{ok:false, error:{code, message, http}}` tipado. Para extender el union de códigos TS-enforced hay que tocar `src/core/types.ts` (DT-3 Opción B) |
| `src/chains/kite.ts` | estructura del adapter + singletons top-level (`new KiteAdapter({...})`) | Adapters se instancian al cargar el módulo via `new KiteAdapter(opts)`. `readEnv(name, chainId)` lee `process.env[name]` directo; no reciben env parseado. Para CB_* thresholds: **mismo patrón — leer en constructor con defaults hardcodeados idénticos al Zod schema**, NO `EnvConfig` inyectado |
| `src/chains/avalanche.ts` | segundo adapter a wrappear | Misma estructura que kite. `verify`/`settle` son stubs que hoy devuelven NETWORK_MISMATCH — el breaker envolverá el stub tal cual (stubs NO disparan CB failure por AC-13 — NETWORK_MISMATCH no está en la lista) |
| `src/chains/registry.ts` | cómo se registran adapters | Registry es un Map<ChainId, ChainAdapter>. Las líneas 61-62 muestran que los adapters se registran via `chainRegistry.register(adapter)` en `src/app.ts` (futuro) o `src/core/*` tras import. El breaker vive **dentro** de cada adapter — el registry no cambia |
| `src/core/types.ts` líneas 32-42 | `X402ErrorCode` union — 10 miembros literal | Para DT-3 Opción B: agregar `'CHAIN_UNAVAILABLE'` como miembro 11. El `Record<X402ErrorCode, number>` en `errors.ts` romperá compilación hasta agregar la entry correspondiente → CD-3 garantizada |
| `src/core/errors.ts` | `HTTP_BY_CODE`, `DEFAULT_MESSAGE_BY_CODE`, `buildX402Error` | Los dos Records son `Record<X402ErrorCode, T>` — exhaustivos por TS. Agregar `CHAIN_UNAVAILABLE: 503` en HTTP_BY_CODE y `'Chain RPC temporarily unavailable'` en DEFAULT_MESSAGE_BY_CODE. `buildX402Error` funciona sin cambios |
| `src/infra/env.ts` líneas 13-85 | patrón Zod + superRefine + `parseEnv` + `z.enum(['true','false']).transform(v => v === 'true')` | Exemplar para las 4 CB vars. `RATE_LIMIT_ENABLED` WFAC-40 usa **exactamente** el pattern a replicar para `CB_ENABLED`. `z.coerce.number().int().min(1).default(N)` para las numéricas |
| `src/app.ts` completo | cómo se cablea Fastify + decorator `env` + orden de registers | W4 va a llamar a `initChainBreakers(env)` (nuevo helper) **antes** de `app.register(healthRoute)` y después de `app.decorate('env', env)`. Logger ya está disponible como `app.log` |
| `src/routes/verify.ts` + `src/routes/settle.ts` | cómo mapear `AdapterResult` → HTTP + donde meter el header `Retry-After` | Ambos rutan `result.error.code + result.error.http`. Para AC-11: cuando `result.error.code === 'CHAIN_UNAVAILABLE'`, agregar `reply.header('Retry-After', String(secs))` antes del `reply.code(result.error.http).send(...)`. El valor viene del propio error (propagado desde el breaker via field opcional `retryAfterSec` en el body del error, O vía `getBreakerState(chainId)`) |
| `package.json` | prom-client v15.1.3 ya en deps; cockatiel NO está | `prom-client` disponible sin install. **Cockatiel v3.2.1** — SE INSTALA en W0 vía `npm install cockatiel@^3.2.1` |
| `src/__tests__/unit/rate-limiting.test.ts` | patrón de integration tests de plugin nuevo + CaptureStream para logs | Reutilizable para T-CB-11 (log warn en transición) y T-CB-13 (audit/metrics propagation). `buildApp({ rawEnv, loggerDestination })` con rawEnv override y CaptureStream |
| `src/__tests__/unit/chain-adapter.test.ts` | patrón de tests de adapters con `vi.resetModules()` + `vi.resetModules()` entre tests | Exemplar para tests de `kite.ts` / `avalanche.ts` con breaker: `vi.resetModules()` + dynamic import → cada test estrena adapter/breaker |
| `src/__tests__/unit/env.test.ts` | patrón para tests de `parseEnv` con process.exit stub | Replicar para 4 CB vars. 1 happy path + 4 invalid (uno por cada numérica + uno por ENABLED not-'true'/'false') |
| `doc/sdd/015-wfac-40-rate-limiting/sdd.md` | exemplar MÁS RECIENTE de SDD aprobado (WFAC-40) — estructura, tabla CD, test plan | Replicar estructura §1-13. El Story File F2.5 va a refinar ACs en tests |
| `doc/sdd/015-wfac-40-rate-limiting/auto-blindaje.md` | lección de errorResponseBuilder throwing objects | No aplica al CB (no usamos errorResponseBuilder), pero hereda **CD-LESSON**: si algún custom error vira por throw (BrokenCircuitError de cockatiel), catchearlo en el adapter — NO propagar |
| `doc/sdd/014-wfac-33-audit-log/auto-blindaje.md` | lección `light-my-request` inyecta UA default | Aplicable si algún test de CB hace `app.inject` sin headers |
| `doc/sdd/013-wfac-32-settlement-ledger/auto-blindaje.md` | lección `grep` antes de commit cuando fix ESLint unused-vars; JSDoc entropy false positive | Aplica a la implementación — CD-LESSON |
| `doc/sdd/012-wfac-23-openapi-spec/auto-blindaje.md` | lección `prettier --write` antes de `format:check`; `// eslint-disable-next-line security/detect-object-injection` con justificación | Aplica a archivos nuevos + lookups dinámicos sobre Record |
| `OWNERS.md` matriz + reglas | `src/chains/<chain>.ts` puede importar `src/chains/types.ts` + viem; NO puede importar `src/core/*`, `src/methods/*`, `src/routes/*`, `src/infra/*` | `src/chains/circuit-breaker.ts` sigue la misma regla. Puede importar `cockatiel` + `./types.js` + `prom-client` (3rd party, permitido) + `pino` type-only (inyectado como dependency). **NO `src/core/types.ts` ni `src/core/errors.ts` runtime** — el breaker define internamente un symbol/brand para marcar su error (mapeo a `CHAIN_UNAVAILABLE` ocurre cuando el adapter traduce la excepción a AdapterResult) |
| `node_modules/cockatiel/dist/CircuitBreakerPolicy.d.ts` | API pública de cockatiel v3.2.1 | `CircuitState` enum (Closed=0, Open=1, HalfOpen=2, Isolated=3). `onBreak`, `onReset`, `onHalfOpen`, `onStateChange` events. `execute(fn)` throws `BrokenCircuitError` cuando OPEN. `state` getter. `ConsecutiveBreaker(threshold)` + `SamplingBreaker({threshold, duration, minimumRps?})` |
| `node_modules/cockatiel/dist/breaker/SamplingBreaker.d.ts` | `SamplingBreaker` matches "N failures in rolling window" semantics | `threshold` es % (0..1), **NO count**. Para cumplir AC-1 literal ("failure count exceeds threshold in window") usamos `SamplingBreaker` con `threshold = CB_FAILURE_THRESHOLD / expectedMinRequests` — pero esto es frágil. **Decisión en DT-4: usamos un wrapper custom sobre `ConsecutiveBreaker` + sliding window interno** o modelamos el AC-1 como "N consecutive failures" (cockatiel `ConsecutiveBreaker`). Ver DT-4 |
| `package.json` probe `/tmp/cockatiel-probe` (smoke test tsx + vitest) | Verificación de ESM compat (DT-1 resolver) | ✅ `tsx smoke.ts` + `vitest smoke.test.ts` ambos pasaron — Node 20's CJS→ESM interop resuelve named imports de cockatiel v3.2.1. ESM OK |

---

## 3. Architecture Decisions

### 3.1 Blockers del work-item — RESUELTOS en F2

#### DT-1 (BLOCKER) — cockatiel v3.2.1 ESM compat: **VERIFICADO OK → se usa cockatiel**

**Decisión**: usar `cockatiel@^3.2.1`. NO custom state machine, NO opossum.

**Evidencia empírica** (probe `/tmp/cockatiel-probe`):
- `package.json` de cockatiel 3.2.1: `main: "dist/index.js"`, `module: "dist/esm/index.js"`, **sin** `exports` field.
- En Node 20 + `"type":"module"` del consumer: Node ignora `module` (sólo bundlers lo usan). Carga `dist/index.js` (CJS) y aplica **CJS→ESM interop**: `import { ConsecutiveBreaker, circuitBreaker, handleAll, CircuitState, BrokenCircuitError } from 'cockatiel'` funciona (Node 20 parsea `module.exports = { ... }` sintácticamente y expone named exports).
- Smoke test real:
  - `npx tsx smoke.ts` → executes `pol.execute(async () => 42)`, state Closed (0). ✅
  - `npx vitest run smoke.test.ts` → 2 tests pass (execute fn + opens after N failures + throws `BrokenCircuitError`). ✅
- Zero engines conflict: cockatiel requiere `node >=16`; nuestro proyecto Node 20.
- `sideEffects: false` — tree-shakable.

**Implicación**:
- W0 task: `npm install cockatiel@^3.2.1 --save-exact` → agrega `"cockatiel": "3.2.1"` a `dependencies`.
- Uso `circuitBreaker(policy, { halfOpenAfter, breaker })` como factory fluente.
- **NO usar** `SamplingBreaker` (ver DT-4).

**Fallback path descartado (custom state machine ~80 LOC)**: no se necesita, cockatiel OK. Si en el futuro aparece un bug de interop, el `ChainCircuitBreaker` class encapsula la API → reemplazar internals es trivial (`new ConsecutiveBreaker(...)` → custom).

---

#### DT-3 (BLOCKER) — Error code: **Opción B (extender `X402ErrorCode`)** — RATIFICADA

El work-item eligió Opción B (extender el union) y el orquestador pidió reconsiderar Opción C (literal local a-la WFAC-40 `RATE_LIMITED`). **La decisión final del Architect es mantener Opción B**.

**Trade-offs evaluados**:

| Aspecto | Opción B (extend union) | Opción C (literal local) |
|---------|-------------------------|--------------------------|
| Cascade de archivos | `types.ts` + `errors.ts` + tests exhaustividad + `openapi.yaml` enum | ninguno fuera de chains/circuit-breaker.ts |
| Contrato TS | `AdapterResult<T>` sigue tipado al 100% — `code: X402ErrorCode` exhaustivo | **rompe** tipo del `AdapterResult<T>`: el adapter tendría que retornar `code` como `string` O un nuevo union, violando el contrato de 12 route-handlers y 3 core modules que asumen `X402ErrorCode` |
| Consistencia con spec x402 | El 503 "cadena inalcanzable" ES un estado semántico del facilitator ("no puedo llegar al RPC") — pertenece al dominio x402 | `RATE_LIMITED` es 100% infrastructural (rate limit no es spec x402 — es plumbing HTTP). CHAIN_UNAVAILABLE ES diferente: el cliente necesita saber si debe reintentar en otra chain o esperar |
| Impacto en consumers externos | OpenAPI enum +1 valor: integrators pueden switch-case exhaustivo | Integrators verán un `code` string que no aparece en la spec publicada — sorpresa |
| Riesgo de cascade rompe tests | Compilador forzará actualización de `HTTP_BY_CODE`, `DEFAULT_MESSAGE_BY_CODE`, tests de `errors.ts`, OpenAPI test de enum exhaustivity | Cero cascade — pero paga con tipado débil |
| Paralelo al precedente | Spec x402 ya define 10 codes **canónicos del protocolo**. Extenderlo NO es lo mismo que inventar un valor — es decir "el facilitator necesita expresar otra condición spec-relevante" | WFAC-40 `RATE_LIMITED` fue literal local específicamente porque HTTP 429 es infra genérica. CHAIN_UNAVAILABLE tiene semántica x402 (por qué no pagaste) |
| Rollback / futuro | Si mañana el facilitator-spec oficial agrega su propio `CHAIN_UNAVAILABLE` con otra HTTP, nuestra versión diverge — riesgo bajo pero existe | Trivial de remover |

**Por qué B y no C — razones decisivas**:

1. **Contrato tipado de `AdapterResult<T>` es sagrado**. Hoy `src/chains/types.ts:130` define `AdapterResult<T> === Result<T>` y `Result.error.code: X402ErrorCode`. Un literal local forzaría o bien castear `as X402ErrorCode` (prohibido por CD-9 de proyecto — no `as unknown`) o refactorizar todos los consumers a un union más amplio. Cascade **mayor** que la de Opción B.

2. **Semántica diferente a RATE_LIMITED**. El 429 es puramente HTTP infra. El 503 CHAIN_UNAVAILABLE es **domain-level** ("la red X no está disponible para settlement ahora"). Un cliente x402 legítimo debería poder hacer `switch(error.code) { case 'CHAIN_UNAVAILABLE': try_alternate_chain(); }` — es info de negocio.

3. **Cascade Opción B acotado y TS-enforced**. Al tocar `X402ErrorCode`, el compilador nos guía exactamente a los 2 sitios requeridos (`HTTP_BY_CODE`, `DEFAULT_MESSAGE_BY_CODE`) — cero chance de olvido. El route layer NO necesita cambios (`reply.code(result.error.http).send(...)` sigue funcionando). Tests de "exactly 10 codes" se actualizan a "exactly 11 codes" + 1 nuevo caso. OpenAPI enum +1 valor.

4. **DRY con Adversary Review de WFAC-40**. El AR de WFAC-40 aceptó RATE_LIMITED literal porque 429 es HTTP-infra y no forma parte del dominio x402. CHAIN_UNAVAILABLE no cumple ese criterio.

**Impacto completo (W1)**:
- `src/core/types.ts`: agregar `| 'CHAIN_UNAVAILABLE'` al union.
- `src/core/errors.ts`: 1 entry en `HTTP_BY_CODE` (`CHAIN_UNAVAILABLE: 503`) + 1 entry en `DEFAULT_MESSAGE_BY_CODE` (`'Chain RPC temporarily unavailable'`).
- `src/__tests__/unit/core/errors.test.ts`: agregar caso `CHAIN_UNAVAILABLE → 503` + actualizar count-assertion si existe (verificar en W1).
- `doc/openapi.yaml`: agregar `CHAIN_UNAVAILABLE` al enum `X402ErrorCode` (schema `components.schemas.X402Error.properties.code.enum`).
- `src/__tests__/unit/routes.openapi.test.ts`: si hay un test "enum tiene exactamente 10", actualizar a 11 + assert inclusion.

---

#### DT-7 (DEFERRED del work-item, AC-9) — breaker state en `GET /supported` como campo opcional

**Decisión**: AC-9 se resuelve extendiendo `ChainMetadata` con un **campo opcional**
`breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN'` computado on-demand. **NO**
agregamos endpoint `/status/circuit-breakers` separado.

**Justificación**:
- Endpoint separado duplica info (la metadata de cada chain ya vive en /supported).
- Integrators que usan discovery ya poseen el contrato del /supported — evolución suave.
- El spec x402 permite extender el `GET /supported` con campos no-breakings (la spec solo define los campos **mínimos**; campos adicionales son ignorados por clientes legacy).
- `CB_ENABLED=false` → el campo no se emite (omitido con spread condicional).

**Mecánica**:
- `src/chains/types.ts`: agregar `readonly breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN'` como último campo opcional de `ChainMetadata`.
- `src/core/supported.ts`: cuando arma la respuesta, consulta `adapter.getBreakerState?()` — si el adapter expone el método, inyecta el campo; si no, lo omite.
- `ChainAdapter` interface: agregar método opcional `getBreakerState?(): 'CLOSED' | 'OPEN' | 'HALF_OPEN'`.
- Kite + Avalanche implementan el método; stubs del futuro pueden omitirlo.

**OpenAPI**: agregar campo opcional al schema `ChainMetadata`.

---

### 3.2 DT-4 — Breaker semantics: `SamplingBreaker` con `threshold` count-based wrapper

**Decisión**: cockatiel expone `SamplingBreaker` que requiere `threshold` como **percentage (0..1)**,
NO count absoluto. Para expresar AC-1 literal ("failure count within
`CB_ROLLING_WINDOW_MS` exceeds `CB_FAILURE_THRESHOLD`") usamos `SamplingBreaker`
con los parámetros derivados:

- `duration = CB_ROLLING_WINDOW_MS` (directo).
- `threshold = 0.5` (50% — configuración estándar de cockatiel).
- `minimumRps = CB_FAILURE_THRESHOLD / (CB_ROLLING_WINDOW_MS / 1000)` —
  forzamos que el breaker necesite ≥ CB_FAILURE_THRESHOLD requests totales
  en la ventana antes de abrir, y que el 50% sean failures.

**Sin embargo** esto es más laxo que el AC-1 literal (requiere 50% de una
masa mínima, no "N failures absolute"). **Refinamiento pragmático**: usamos
`ConsecutiveBreaker(CB_FAILURE_THRESHOLD)` — trip después de N fallos
**consecutivos**. Este es el modelo más defensible operacionalmente:

- Si el RPC tiene un flap de 3 fallos intercalados con 20 éxitos, NO queremos
  abrir (sistema sano intermittente).
- Si el RPC está dead, van a llegar N fallos seguidos casi siempre.
- Más barato de testear deterministicamente (sin depender de timings de
  sampling window).
- `CB_ROLLING_WINDOW_MS` se usa para **reset del counter en caso de intermittencia**:
  si pasan más de `CB_ROLLING_WINDOW_MS` sin nuevo fallo, `ConsecutiveBreaker`
  internamente mantiene contador — **sin embargo** cockatiel `ConsecutiveBreaker`
  NO tiene reset temporal (es puramente consecutive). Para cumplir el AC-1
  literal ("rolling window"), agregamos **manualmente** un `setTimeout` que
  llama `breaker.success()` dummy cada `CB_ROLLING_WINDOW_MS` si no hubo
  failures en la ventana — **RECHAZADO** (hack, fragile).

**Decisión final** (documentada para el work-item refinement):
- Usar `SamplingBreaker({ threshold: 0.5, duration: CB_ROLLING_WINDOW_MS, minimumRps: CB_FAILURE_THRESHOLD / (CB_ROLLING_WINDOW_MS / 1000) })`.
- El AC-1 se **refina levemente**: "after `CB_FAILURE_THRESHOLD` failures
  representing ≥50% of requests in `CB_ROLLING_WINDOW_MS`". Esto es operacionalmente
  más robusto que "N failures absolute" (evita tripping en traffic normal con
  transients). La semántica del work-item se preserva en espíritu.
- `minimumRps` ajustado: `Math.max(0.001, CB_FAILURE_THRESHOLD / Math.max(1, CB_ROLLING_WINDOW_MS / 1000))`.

**Contracargo aceptado**: QA en F4 verificará AC-1 con tests que inyecten N
failures en M requests totales en ventana — no "exact N failures open". Los
tests documentan la semántica refinada.

**Defaults recomendados** (reflejados en env vars §4):
- `CB_FAILURE_THRESHOLD = 5` (5 failures)
- `CB_ROLLING_WINDOW_MS = 30000` (30 s window)
- `CB_RESET_TIMEOUT_MS = 10000` (10 s hasta HALF_OPEN probe)

Con estos defaults + 50% threshold + minimumRps=5/30≈0.17 → se abre cuando
ocurren 5+ failures que representan ≥50% del traffic en 30 s. Razonable.

---

### 3.3 DT-5 — `ChainCircuitBreaker` class: wrapper pattern + lazy lifecycle

**Decisión**: `src/chains/circuit-breaker.ts` expone una clase `ChainCircuitBreaker`
que wraps la `CircuitBreakerPolicy` de cockatiel + maneja el state para el
adapter. Firma pública:

```ts
// src/chains/circuit-breaker.ts (signature only — DEV implementa)
import type { Logger } from 'pino';

export type BreakerStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ChainCircuitBreakerOptions {
  readonly chainId: number;                  // for logs + metrics label
  readonly chainName: string;                // e.g., "Kite Testnet" (for log context)
  readonly failureThreshold: number;         // CB_FAILURE_THRESHOLD
  readonly rollingWindowMs: number;          // CB_ROLLING_WINDOW_MS
  readonly resetTimeoutMs: number;           // CB_RESET_TIMEOUT_MS
  readonly enabled: boolean;                 // CB_ENABLED — when false, execute passthrough
  readonly logger?: Logger;                  // injected via setLogger() at app boot
}

export class BreakerOpenError extends Error {
  public readonly remainingMs: number;       // for Retry-After header computation
  constructor(chainId: number, remainingMs: number);
}

export class ChainCircuitBreaker {
  constructor(opts: ChainCircuitBreakerOptions);

  /**
   * Execute fn through the breaker. When OPEN/HALF_OPEN, throws BreakerOpenError
   * (fast-fail). Otherwise awaits fn() and records success/failure.
   *
   * When `enabled=false`, this function is effectively passthrough: it awaits fn()
   * and returns the result without touching state, counters, or metrics (CD-7).
   */
  execute<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Manually record a business-logic failure (e.g., adapter returned
   * `ok:false` with code SIMULATION_FAILED — spec-compliant but still
   * counts as CB failure per AC-13).
   *
   * When `enabled=false`, this is a no-op (CD-7).
   */
  recordBusinessFailure(reason: string): void;

  /** Current public state name (for getBreakerState on adapter + metrics). */
  getState(): BreakerStateName;

  /** Remaining ms until HALF_OPEN (valid only when state===OPEN); 0 otherwise. */
  getRemainingOpenMs(): number;

  /** Attach logger after construction (matches ChainRegistry.setLogger pattern). */
  setLogger(logger: Logger): void;

  /** Test-only utility — resets state & counters. Throws if NODE_ENV!=='test'. */
  _resetForTesting(): void;
}
```

**Key mechanics**:
- El breaker internamente compone: `circuitBreaker(handleAll, { halfOpenAfter: resetTimeoutMs, breaker: new SamplingBreaker({...}) })`.
- Subscribe a `onStateChange`, `onBreak`, `onReset`, `onHalfOpen` → emite logs (AC-8) + actualiza métricas prom-client (AC-12).
- `execute` atrapa `BrokenCircuitError` de cockatiel → traduce a `BreakerOpenError(chainId, remainingMs)` con su propio type (para que el adapter lo matchee — ver DT-6).
- `recordBusinessFailure(reason)` incrementa el counter del breaker **sin** llamar `fn` (útil para AC-13: cuando adapter devolvió `ok:false` SIMULATION_FAILED/TRANSACTION_FAILED, el adapter llama `recordBusinessFailure` manualmente).
  - Implementación: expone el `SamplingBreaker` internamente; llama `breaker.failure(state)`. Alternativa: envolver con un `fn` que throw → catched. Elegimos path directo por claridad.
- `getState()` mapea `CircuitState.Closed→'CLOSED'`, `Open→'OPEN'`, `HalfOpen→'HALF_OPEN'`, `Isolated→'OPEN'` (tratar `Isolated` como OPEN externamente; no lo usamos en este HU).

---

### 3.4 DT-6 — Wrap point & adapter integration pattern

**Decisión**: cada adapter (`KiteAdapter`, `AvalancheFujiAdapter`) tiene **una**
instancia de `ChainCircuitBreaker` como campo privado. `verify` y `settle`
envuelven via `this._breaker.execute(() => this._verifyRaw(params))` (método
privado que hace el trabajo real).

**Estructura del adapter refactored** (pseudocódigo — DEV implementa):

```ts
class KiteAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _breaker: ChainCircuitBreaker;
  // ... existing _viemChain, _rpcUrl, clients ...

  constructor(opts: KiteAdapterOpts) {
    // ... existing init ...
    this._breaker = new ChainCircuitBreaker({
      chainId: opts.chainIdNum,
      chainName: opts.name,
      failureThreshold: readCbNumber('CB_FAILURE_THRESHOLD', 5),
      rollingWindowMs:  readCbNumber('CB_ROLLING_WINDOW_MS', 30000),
      resetTimeoutMs:   readCbNumber('CB_RESET_TIMEOUT_MS', 10000),
      enabled:          readCbBool('CB_ENABLED', true),
      // logger injected later via setLogger() from app.ts
    });
  }

  // Called by app.ts during buildApp, between app.decorate('env', env) and
  // route registration, via initChainBreakers(logger).
  setLogger(logger: Logger): void { this._breaker.setLogger(logger); }

  getBreakerState(): BreakerStateName { return this._breaker.getState(); }

  async verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    try {
      return await this._breaker.execute(() => this._verifyRaw(params));
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        return {
          ok: false,
          error: {
            code: 'CHAIN_UNAVAILABLE',
            message: 'Chain RPC temporarily unavailable',
            http: 503,
          },
        };
      }
      throw err;  // unexpected throw (defense-in-depth)
    }
  }

  private async _verifyRaw(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    // existing stub body — eventually WFAC-10 real logic.
    // IMPORTANT (AC-13): if result.ok===false with code SIMULATION_FAILED or
    // TRANSACTION_FAILED, manually call this._breaker.recordBusinessFailure().
    const result = await this._doRpcCall(_params);  // the real thing
    if (!result.ok && (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
      this._breaker.recordBusinessFailure(result.error.code);
    }
    return result;
  }

  // settle() mirrors verify() — same wrap pattern.
}
```

**Por qué NO `_breaker.execute(this._verifyRaw.bind(this))`**: `bind` + cockatiel
funciona, pero la closure arrow es más legible en testing. Ambas ok.

**Por qué NO wrap en registry-level**: work-item DT-2 ya justifica esto. Ratificado.

**Per-chain isolation (AC-7)**: cada KiteAdapter/AvalancheFujiAdapter instancia
un nuevo `ChainCircuitBreaker` → states totalmente independientes. Confirmed.

**AC-13 — business-failure counting**: NETWORK_MISMATCH y demás **NO** cuentan
(hoy los stubs retornan NETWORK_MISMATCH → breaker no abre en tests-time). Solo
SIMULATION_FAILED y TRANSACTION_FAILED. La lógica vive en `_verifyRaw`/`_settleRaw`
tras el call — el breaker de cockatiel no discrimina por código x402 (ve success
o exception), así que el adapter tiene la responsabilidad de traducir "error
semántico del x402 que ES RPC failure" → `recordBusinessFailure`.

---

### 3.5 DT-8 — Lazy env reading en adapters: funciones helper `readCbNumber` / `readCbBool`

**Problema identificado**: adapters se instancian en top-level del módulo
(`kite.ts:128` `new KiteAdapter({...})`). Import-order no garantiza que
`parseEnv` ya haya corrido cuando los adapters se construyen — en tests
parseEnv puede estar bypasseado.

**Decisión**: `src/chains/circuit-breaker.ts` exporta 2 helpers que leen
`process.env[VAR]` con **defaults idénticos al Zod schema en `src/infra/env.ts`**.
Los adapters los usan directamente en el constructor.

```ts
// src/chains/circuit-breaker.ts — exported helpers
export function readCbNumber(name: string, fallback: number): number {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a caller-controlled literal from the hardcoded set { CB_FAILURE_THRESHOLD, CB_ROLLING_WINDOW_MS, CB_RESET_TIMEOUT_MS }.
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readCbBool(name: string, fallback: boolean): boolean {
  // eslint-disable-next-line security/detect-object-injection -- same rationale as readCbNumber.
  const raw = process.env[name];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}
```

**Defaults sincronizados con Zod schema**:
| Var | Zod default | Helper fallback |
|-----|------------|-----------------|
| `CB_ENABLED` | `true` | `true` |
| `CB_FAILURE_THRESHOLD` | `5` | `5` |
| `CB_ROLLING_WINDOW_MS` | `30000` | `30000` |
| `CB_RESET_TIMEOUT_MS` | `10000` | `10000` |

**Semántica defensiva**: si el Zod schema ya se corrió en `parseEnv`, los
defaults **no** se activan (porque env ya tiene el valor explícito). Si
parseEnv **no** se corrió (test setup parcial), los adapters caen a fallback.
En NINGÚN caso el adapter crashea por CB vars missing — cumple AC-10 **a nivel
de parseEnv** (que rechaza valores inválidos explícitos).

**Contrato con AC-10**: AC-10 literal dice "non-positive integer → parseEnv fails". Esto lo cumple Zod via `z.coerce.number().int().min(1)`. Los helpers del adapter son **defense-in-depth** — no son la validación primaria. Tests de AC-10 van a `env.test.ts` (Zod-level).

**Boundary OWNERS check**: `circuit-breaker.ts` usa `process.env` — permitido en `src/chains/<chain>.ts` (exemplar: `kite.ts:36` `readEnv(name, chainId)`).

---

### 3.6 DT-9 — Metrics integration (prom-client)

**Decisión**: el breaker registra métricas en el `register` default de
`prom-client` (no creamos un Registry propio). Las métricas se declaran
como **module-level singletons** en `src/chains/circuit-breaker.ts`, **una vez**
por proceso, con labels `chain` (nombre human-readable) + `chain_id` (numeric).

```ts
// src/chains/circuit-breaker.ts — module scope (defined once)
import { Counter, Gauge, register as defaultRegister } from 'prom-client';

// idempotent registration — tests with vi.resetModules() may reload.
// prom-client throws "already registered" on duplicate name; guard:
function registerOrGet<T extends Counter | Gauge>(factory: () => T, name: string): T {
  const existing = defaultRegister.getSingleMetric(name);
  if (existing) return existing as T;
  return factory();
}

const cbStateGauge = registerOrGet(
  () => new Gauge({
    name: 'cb_state',
    help: 'Circuit breaker state per chain (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
    labelNames: ['chain', 'chain_id'],
  }),
  'cb_state',
);

const cbFailuresTotal = registerOrGet(
  () => new Counter({
    name: 'cb_failures_total',
    help: 'Total failures counted toward circuit breaker (per chain)',
    labelNames: ['chain', 'chain_id', 'reason'],
  }),
  'cb_failures_total',
);

const cbTransitionsTotal = registerOrGet(
  () => new Counter({
    name: 'cb_transitions_total',
    help: 'Circuit breaker state transitions (per chain + direction)',
    labelNames: ['chain', 'chain_id', 'from_state', 'to_state'],
  }),
  'cb_transitions_total',
);
```

**Update points** (dentro de `ChainCircuitBreaker`):
- En `onStateChange(newState)`: `cbStateGauge.set({chain, chain_id}, numericCode)` + `cbTransitionsTotal.inc({chain, chain_id, from_state, to_state})`.
- En `recordBusinessFailure(reason)` y en el catch interno de `execute`: `cbFailuresTotal.inc({chain, chain_id, reason})`.

**Mapeo gauge** (AC-12 literal menciona "gauge/enum"):
- CLOSED → 0
- HALF_OPEN → 1
- OPEN → 2
- Isolated (cockatiel-only, no usado) → 2

**Registry exposure**: NO creamos ruta `/metrics` en esta HU (fuera de scope del
work-item Scope IN). Las métricas quedan en `prom-client`'s default register;
cuando una HU futura agregue `GET /metrics`, estarán disponibles.

**Test-safe**: `registerOrGet` idempotencia evita "already registered" en
`vi.resetModules()` suites.

---

### 3.7 DT-10 — Header `Retry-After` en routes (AC-11, CD-5)

**Decisión**: el header `Retry-After` se agrega en el **route layer** (no en el
adapter). El route detecta `result.error.code === 'CHAIN_UNAVAILABLE'` y consulta
el breaker state del chain vía un helper.

**Problema**: el route actualmente no conoce qué adapter servió la request
(`core.verify()` despacha por chainId transparente al route). Necesitamos una
forma de pasar `remainingMs` desde el adapter al route sin cambiar el shape de
`AdapterResult` (romper types cascade) ni exponer el breaker al route.

**Solución**: el adapter, cuando retorna `CHAIN_UNAVAILABLE`, incluye
`remainingMs` como **parte del message** o como **campo opcional** en el error.

**Opción elegida**: **agregar `retryAfterMs?: number` como campo opcional del
error** (solo para CHAIN_UNAVAILABLE). Esto es una **extensión mínima al shape
`Err['error']`**:

```ts
// src/core/types.ts — extensión mínima
export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
    readonly retryAfterMs?: number;  // NEW — only populated for CHAIN_UNAVAILABLE
  };
}
```

**Por qué NO en el message**: parsing strings en el route es frágil.

**Por qué NO pasar el breaker instance al route**: viola OWNERS (routes no
importan chains).

**Mecánica en el route** (pseudocódigo):

```ts
// src/routes/verify.ts — Step 5 extension
if (!result.ok) {
  if (result.error.code === 'CHAIN_UNAVAILABLE' && typeof result.error.retryAfterMs === 'number') {
    const secs = Math.ceil(result.error.retryAfterMs / 1000);
    reply.header('Retry-After', String(Math.max(1, secs)));
  }
  // ... existing error logging + auditMeta ...
  return reply.code(result.error.http).send({ error: {
    code: result.error.code,
    message: result.error.message,
    http: result.error.http,
    // NOTA: retryAfterMs NO se serializa en el body (no está en el contrato
    // spec x402). Se consume SOLO para setear Retry-After header.
  }});
}
```

**NOTA crítica** — el body response **NO** incluye `retryAfterMs` (solo 3 keys:
code/message/http). El campo existe solo para plumbing route↔adapter.

**CD-3 preservada**: `{ error: { code, message, http } }` sigue siendo el shape
spec del body. Unit tests verifican que `JSON.parse(body).error` tiene
exactamente las 3 keys.

**Impacto en tests existentes**: ninguno — el campo es opcional. Tests que
hoy hacen `expect(body.error).toEqual({ code, message, http })` siguen verdes
porque no hay `retryAfterMs` en el body (solo en el error server-side).

---

### 3.8 DT-11 — `initChainBreakers(app, env)` — where logger is injected

**Decisión**: nuevo helper `src/chains/init-breakers.ts` que se llama desde
`src/app.ts` durante `buildApp`, inmediatamente después de `app.decorate('env', env)`
y antes de registrar routes.

```ts
// src/chains/init-breakers.ts (new file)
import type { Logger } from 'pino';
import { chainRegistry } from './registry.js';

/**
 * Inject the app logger into every registered adapter's circuit breaker.
 * Must be called AFTER adapters are registered (registry is populated) and
 * BEFORE routes start handling traffic.
 */
export function initChainBreakers(logger: Logger): void {
  for (const metadata of chainRegistry.listAdapters()) {
    const lookup = chainRegistry.getAdapter(metadata.chainId);
    if (!lookup.ok) continue;
    const adapter = lookup.adapter;
    // Ducktype: if adapter exposes setLogger(), call it.
    if (typeof (adapter as { setLogger?: (l: Logger) => void }).setLogger === 'function') {
      (adapter as { setLogger: (l: Logger) => void }).setLogger(logger);
    }
  }
}
```

**Por qué ducktype y no extender `ChainAdapter` interface**: mantener el
contrato `ChainAdapter` **mínimo y estable**. Es más limpio agregar una
mixin/checking en el consumer que imponer `setLogger` como requirement a
todos los adapters (rompería stubs existentes sin breaker).

**Alternativa considerada (agregar `setLogger` required al interface)**: fuerza
modificar todos los tests y potencialmente adapters de terceros. Rechazada.

---

### 3.9 DT-12 — Adapter registration order

**Decisión**: `src/app.ts` ya no registra adapters directamente (hoy el
registry se popula en otros sitios — ver `src/core/supported.ts:24` import).
**Este SDD NO modifica el flow de registración**.

`initChainBreakers(logger)` se llama tras asumir que los adapters ya están
registrados (via imports eager). Los adapters se importan por cadena desde
`src/core/supported.ts` y `src/core/*` → al momento de `app.register(supportedRoute)`,
todos los adapters ya viven en el registry.

**Verificación en W4**: agregamos tests que confirmen que tras `buildApp()`, los
adapters tienen `getBreakerState()` retornando `'CLOSED'` (logger injected).

---

## 4. Env Schema additions (`src/infra/env.ts`)

### 4.1 4 nuevas vars — contrato exacto

| Env var | Tipo Zod | Default | Mín | Validación |
|---------|----------|---------|-----|------------|
| `CB_ENABLED` | `z.enum(['true','false']).default('true').transform(v => v === 'true')` | `true` | — | string→boolean explícito (CD-8 heredada WFAC-40 CD-12) |
| `CB_FAILURE_THRESHOLD` | `z.coerce.number().int().min(1).default(5)` | `5` | `1` | AC-10 fail-fast |
| `CB_ROLLING_WINDOW_MS` | `z.coerce.number().int().min(1).default(30000)` | `30000` | `1` | AC-10 fail-fast |
| `CB_RESET_TIMEOUT_MS` | `z.coerce.number().int().min(1).default(10000)` | `10000` | `1` | AC-10 fail-fast |

**NOTA sobre la 5ª var mencionada por el orquestador (`CB_PROBE_HALF_OPEN_MS`)**:
NO se agrega. El "half-open probe interval" NO es un parámetro separado en
cockatiel — es controlado por `halfOpenAfter = CB_RESET_TIMEOUT_MS` directamente.
Work-item menciona 4 env vars (CD-4 lista los 3 numéricos sin sufijo). 4 vars
total es correcto.

### 4.2 Patch sobre `EnvSchema`

```ts
export const EnvSchema = z
  .object({
    // ... existing fields (WFAC-2..WFAC-40) unchanged ...

    // WFAC-41 — circuit breaker per chain RPC (§4.1 of SDD).
    CB_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    CB_ROLLING_WINDOW_MS: z.coerce.number().int().min(1).default(30000),
    CB_RESET_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
  })
  .superRefine((data, ctx) => { /* existing WFAC-5 REDIS_URL refine unchanged */ });
```

### 4.3 `.env.example` additions

```bash
# WFAC-41 — circuit breaker per chain RPC
CB_ENABLED=true
CB_FAILURE_THRESHOLD=5
CB_ROLLING_WINDOW_MS=30000
CB_RESET_TIMEOUT_MS=10000
```

---

## 5. Archivos tocados — resumen

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `src/core/types.ts` | MODIFY — `X402ErrorCode` +1 member `CHAIN_UNAVAILABLE`; `Err['error']` +1 opt field `retryAfterMs?: number` | W1 |
| 2 | `src/core/errors.ts` | MODIFY — `HTTP_BY_CODE['CHAIN_UNAVAILABLE']=503`; `DEFAULT_MESSAGE_BY_CODE['CHAIN_UNAVAILABLE']='Chain RPC temporarily unavailable'` | W1 |
| 3 | `src/infra/env.ts` | MODIFY — +4 keys en EnvSchema | W1 |
| 4 | `src/__tests__/unit/core/errors.test.ts` | MODIFY — agregar caso + actualizar count-assertion si existe | W1 |
| 5 | `src/__tests__/unit/env.test.ts` | MODIFY — 5 tests nuevos (1 happy + 4 inválidos CB vars) | W1 |
| 6 | `doc/openapi.yaml` | MODIFY — enum `X402ErrorCode` +1 `CHAIN_UNAVAILABLE`; opt field `breakerState` en `ChainMetadata` schema | W1 |
| 7 | `src/__tests__/unit/routes.openapi.test.ts` | MODIFY — si hay test "enum tiene N codes" actualizar | W1 |
| 8 | `src/chains/circuit-breaker.ts` | **CREATE** — ChainCircuitBreaker class + BreakerOpenError + readCb* helpers + metrics singletons | W2 |
| 9 | `src/__tests__/unit/chains/circuit-breaker.test.ts` | **CREATE** — unit tests del class (state machine, threshold, half-open probe, metrics, logger injection) | W2 |
| 10 | `src/chains/types.ts` | MODIFY — `ChainAdapter` +opt method `getBreakerState?(): 'CLOSED' \| 'OPEN' \| 'HALF_OPEN'`; `setLogger?(l: Logger): void` opt method; `ChainMetadata` +opt field `breakerState` | W3 |
| 11 | `src/chains/kite.ts` | MODIFY — wrap verify/settle con breaker; expose `setLogger`, `getBreakerState`; split to `_verifyRaw`/`_settleRaw` | W3 |
| 12 | `src/chains/avalanche.ts` | MODIFY — idéntico pattern | W3 |
| 13 | `src/__tests__/unit/chain-adapter.test.ts` | MODIFY — agregar tests de `getBreakerState` exposure + CB integration | W3 |
| 14 | `src/chains/init-breakers.ts` | **CREATE** — `initChainBreakers(logger)` helper | W4 |
| 15 | `src/app.ts` | MODIFY — import + call `initChainBreakers(app.log)` después de `app.decorate('env', env)` | W4 |
| 16 | `src/routes/verify.ts` | MODIFY — detectar `CHAIN_UNAVAILABLE`, setear `Retry-After` header | W4 |
| 17 | `src/routes/settle.ts` | MODIFY — idem | W4 |
| 18 | `src/core/supported.ts` | MODIFY — inyectar `breakerState` en la response cuando adapter expone `getBreakerState()` | W4 |
| 19 | `src/__tests__/unit/routes.verify.test.ts` | MODIFY — test 503 + Retry-After present | W4 |
| 20 | `src/__tests__/unit/routes.settle.test.ts` | MODIFY — idem | W4 |
| 21 | `src/__tests__/unit/routes.supported.test.ts` | MODIFY — test breakerState field exposed when CB_ENABLED=true | W4 |
| 22 | `src/__tests__/unit/chains/init-breakers.test.ts` | **CREATE** — integration test logger injection | W4 |
| 23 | `package.json` | MODIFY — `+ "cockatiel": "3.2.1"` en deps | W0 |

**Total**: 23 archivos (16 MODIFY + 5 CREATE + package.json + npm install + tests coverage across waves).

---

## 6. Waves de implementación

### Wave 0 (SERIAL, preflight) — Install cockatiel

**Objetivo**: cockatiel disponible; lockfile consistente.

**Commands**:
```bash
npm install cockatiel@3.2.1 --save-exact
npm run typecheck
```

**Done Criteria W0**:
- `package.json` incluye `"cockatiel": "3.2.1"`.
- `package-lock.json` actualizado.
- `npm run typecheck` passes.

---

### Wave 1 (SERIAL) — Types extension + env vars + CHAIN_UNAVAILABLE cascade

**Objetivo**: foundation types listos. Compila. Sin lógica.

**Archivos**:
- `src/core/types.ts`
- `src/core/errors.ts`
- `src/infra/env.ts`
- `doc/openapi.yaml`
- Tests: `env.test.ts`, `core/errors.test.ts`, `routes.openapi.test.ts`

**Tests W1**:
- `env.test.ts`: 1 happy (defaults) + 1 per CB_* override + 4 invalid (CB_FAILURE_THRESHOLD=0, CB_ROLLING_WINDOW_MS=-1, CB_RESET_TIMEOUT_MS='abc', CB_ENABLED='yes' — todos process.exit(1)).
- `core/errors.test.ts`: `buildX402Error('CHAIN_UNAVAILABLE')` → `{code, message, http: 503}`; verificar exhaustividad si hay test.
- `routes.openapi.test.ts`: OpenAPI enum contains `CHAIN_UNAVAILABLE`; count-assertion actualizada.

**Done Criteria W1**:
- `npm run typecheck` OK.
- `npm test` pasa (todos los previous tests siguen verdes + nuevos).
- No se puede construir un `Err` con `code: 'CHAIN_UNAVAILABLE'` sin que TS lo acepte.

---

### Wave 2 (SERIAL) — `ChainCircuitBreaker` class + metrics + tests

**Objetivo**: breaker functional en aislamiento. Listo para integración.

**Archivos**:
- `src/chains/circuit-breaker.ts` (NEW)
- `src/__tests__/unit/chains/circuit-breaker.test.ts` (NEW)

**Tests W2** (≥9 tests):
- T-CB-1: CLOSED state, execute(fn) → returns fn result.
- T-CB-2: N consecutive failures (simulated with SamplingBreaker thresholds) → state CLOSED → OPEN; `onBreak` event fires.
- T-CB-3: En OPEN, execute(fn) throws `BreakerOpenError` with correct `remainingMs`; fn NO invocado.
- T-CB-4: Transición OPEN → HALF_OPEN tras `resetTimeoutMs` (usando `vi.useFakeTimers` + `vi.advanceTimersByTime`).
- T-CB-5: En HALF_OPEN, probe success → CLOSED (onReset fires).
- T-CB-6: En HALF_OPEN, probe failure → OPEN (onBreak fires again, timer restarted).
- T-CB-7: `enabled=false` — execute(fn) passthrough, state queda CLOSED, no metrics updated.
- T-CB-8: Two instances independent — state en instance A no afecta B (AC-7 unit level).
- T-CB-9: `recordBusinessFailure('SIMULATION_FAILED')` — increments counter + eventually opens breaker.
- T-CB-10: Metrics updated — `cbStateGauge.get({chain: 'Test'})` devuelve 0/1/2 apropiadamente.
- T-CB-11: Logger injection — `setLogger(mockLogger)` — transitions emit `warn` log with `{chainId, fromState, toState, failureCount}`.

**Done Criteria W2**:
- `npm run typecheck` OK.
- `npm run lint` OK (max-warnings 0).
- Los 11+ tests passing.

---

### Wave 3 (SERIAL) — Adapter integration (Kite + Avalanche)

**Objetivo**: `verify`/`settle` wrapped. `getBreakerState()` exposed.

**Archivos**:
- `src/chains/types.ts` (agregar opt methods al interface)
- `src/chains/kite.ts`
- `src/chains/avalanche.ts`
- `src/__tests__/unit/chain-adapter.test.ts`

**Tests W3** (≥5 nuevos tests):
- T-KITE-CB-1: `kiteTestnetAdapter.getBreakerState() === 'CLOSED'` tras construcción fresca.
- T-KITE-CB-2: Forzar N fallos internos (mock `_verifyRaw` throw) → state → OPEN; siguiente verify retorna `{ok:false, error:{code:'CHAIN_UNAVAILABLE', http:503, retryAfterMs: number}}`.
- T-KITE-CB-3: Tras `vi.advanceTimersByTime(resetTimeoutMs+1)` → state → HALF_OPEN; próximo verify invoca `_verifyRaw`.
- T-KITE-CB-4: `avalancheFujiAdapter` independiente de `kiteTestnetAdapter` (AC-7 integration level).
- T-KITE-CB-5: `recordBusinessFailure` cuando `_verifyRaw` retorna SIMULATION_FAILED — AC-13.

**Done Criteria W3**:
- `npm run qa` OK.
- Los tests W3 + W2 + W1 verdes.

---

### Wave 4 (SERIAL) — App wiring + routes `Retry-After` + `/supported` breakerState

**Objetivo**: todo integrado. Smoke test end-to-end.

**Archivos**:
- `src/chains/init-breakers.ts` (NEW)
- `src/app.ts`
- `src/routes/verify.ts`
- `src/routes/settle.ts`
- `src/core/supported.ts`
- Tests: `routes.verify.test.ts`, `routes.settle.test.ts`, `routes.supported.test.ts`, `init-breakers.test.ts` (new)

**Tests W4** (≥4 nuevos tests):
- T-RT-VERIFY-503: forzar adapter a retornar `CHAIN_UNAVAILABLE` (via mock breaker OPEN) → response 503 + `Retry-After` header >=1.
- T-RT-SETTLE-503: idem.
- T-RT-SUPPORTED-BREAKER-FIELD: `GET /supported` response includes `breakerState: 'CLOSED'` per chain when CB_ENABLED=true.
- T-INIT-BREAKERS: tras `buildApp()`, loggers están inyectados — simulable con spy en `setLogger` del adapter.

**Done Criteria W4 = Done Criteria HU**:
- `npm run qa` OK.
- `npm test:coverage` — archivos nuevos ≥80% líneas.
- Smoke manual: `curl -X POST /verify` con RPC fake down 5 veces → request #6 retorna 503 + `Retry-After: 10` (o valor del reset).

---

## 7. Test Plan por AC

| AC | Descripción | Test(s) | Ubicación |
|----|-------------|---------|-----------|
| AC-1 | N failures in window → OPEN | T-CB-2 (unit) + T-KITE-CB-2 (integration) | W2 + W3 |
| AC-2 | OPEN state → 503 + CHAIN_UNAVAILABLE + no RPC call | T-CB-3, T-KITE-CB-2, T-RT-VERIFY-503 | W2 + W3 + W4 |
| AC-3 | Reset timeout → HALF_OPEN single probe | T-CB-4, T-KITE-CB-3 | W2 + W3 |
| AC-4 | HALF_OPEN success → CLOSED | T-CB-5 | W2 |
| AC-5 | HALF_OPEN fail → OPEN + timer reset | T-CB-6 | W2 |
| AC-6 | CB_ENABLED=false bypass | T-CB-7 (unit, no state transitions) + T-RT-SUPPORTED with CB_ENABLED=false (campo breakerState omitido) | W2 + W4 |
| AC-7 | Cross-chain independence | T-CB-8 (unit) + T-KITE-CB-4 (integration) | W2 + W3 |
| AC-8 | State transition → warn log (chainId, fromState, toState, failureCount) | T-CB-11 (mock logger + assert payload shape) | W2 |
| AC-9 | breaker state exposed via /supported | T-RT-SUPPORTED-BREAKER-FIELD | W4 |
| AC-10 | non-positive env vars → parseEnv fail-fast | env.test.ts (4 cases) | W1 |
| AC-11 | 503 response includes Retry-After | T-RT-VERIFY-503, T-RT-SETTLE-503 | W4 |
| AC-12 | metrics exposed (cb_state gauge, cb_failures_total, cb_transitions_total) | T-CB-10 | W2 |
| AC-13 | SIMULATION_FAILED/TRANSACTION_FAILED counted as CB failure | T-CB-9 (unit) + T-KITE-CB-5 (integration) | W2 + W3 |

**Tests nuevos totales esperados**: ≥19 (4 env + 1 errors + 1 openapi + 11 W2 + 5 W3 + 4 W4 = 26+). Coverage cómoda.

---

## 8. Constraint Directives — heredados + extensiones

### 8.1 Heredados del work-item (CD-1 a CD-9 original)

- **CD-1**: OBLIGATORIO wrap both `verify` AND `settle` en cada adapter.
- **CD-2**: PROHIBIDO cross-chain state contamination — each adapter holds its own breaker.
- **CD-3**: OBLIGATORIO `CHAIN_UNAVAILABLE` en `HTTP_BY_CODE` y `DEFAULT_MESSAGE_BY_CODE` — TS compilation lo fuerza.
- **CD-4**: PROHIBIDO hardcode thresholds — solo env.
- **CD-5**: OBLIGATORIO `Retry-After` header en 503.
- **CD-6**: OBLIGATORIO fail-fast en parseEnv con env vars inválidas.
- **CD-7**: PROHIBIDO side-effects cuando `CB_ENABLED=false` — passthrough puro.
- **CD-8**: OBLIGATORIO `.enum(['true','false']).transform(...)` para CB_ENABLED (NO `z.coerce.boolean()`).
- **CD-9**: OBLIGATORIO respetar OWNERS — `src/chains/circuit-breaker.ts` no importa de `src/core/*` runtime.

### 8.2 Extensiones específicas del SDD

- **CD-10 (NEW)**: `ChainCircuitBreaker` DEBE usar `SamplingBreaker` de cockatiel (NO `ConsecutiveBreaker`). Justificación en DT-4.

- **CD-11 (NEW)**: Los helpers `readCbNumber`/`readCbBool` DEBEN tener defaults **idénticos** a los del Zod schema. Si un future PR cambia el default de `CB_FAILURE_THRESHOLD` en `env.ts`, DEBE cambiar también en `circuit-breaker.ts`. AR BLOQUEANTE si detecta divergencia.

- **CD-12 (NEW)**: El `retryAfterMs` field en `Err['error']` SE POBLA ÚNICAMENTE cuando `code === 'CHAIN_UNAVAILABLE'`. PROHIBIDO populate en otros códigos. PROHIBIDO incluirlo en el body JSON de la response HTTP (solo consumido para setear header `Retry-After`).

- **CD-13 (NEW)**: El body 503 del route **mantiene exactamente 3 keys**: `{code, message, http}`. El `retryAfterMs` queda en el error object server-side pero NO se serializa. Tests validan `Object.keys(body.error).length === 3`.

- **CD-14 (NEW)**: prom-client metrics **DEBEN** usar `registerOrGet` helper (idempotent) para tolerar `vi.resetModules()` en tests. PROHIBIDO `new Gauge({...})` directo en module scope sin guard.

- **CD-15 (NEW)**: `BrokenCircuitError` de cockatiel DEBE catchearse en el adapter y traducirse a `BreakerOpenError` (wrapper custom). PROHIBIDO propagar excepciones de cockatiel fuera de `src/chains/circuit-breaker.ts`. Los callers (adapters) solo ven `BreakerOpenError`.

- **CD-16 (NEW)**: el `getBreakerState()` method en `ChainAdapter` es **opcional** en el interface TS. Los adapters concretos (Kite, Avalanche) lo implementan; stubs futuros pueden omitirlo. `src/core/supported.ts` DEBE chequear `typeof adapter.getBreakerState === 'function'` antes de invocar.

- **CD-17 (NEW)**: `initChainBreakers(logger)` se llama EXACTAMENTE UNA VEZ por `buildApp()`, después de `app.decorate('env', env)` y ANTES de cualquier `app.register(route)`. Llamarlo dos veces sobreescribe loggers; llamarlo tarde significa que los primeros requests tienen breakers sin logger.

- **CD-18 (NEW)**: La extensión de `ChainMetadata` con `breakerState?: BreakerStateName` es **opcional** en el tipo. Cuando `CB_ENABLED=false` O el adapter no expone `getBreakerState()`, el campo se OMITE (no `undefined`, no `null`) — spread condicional `...(state !== undefined ? { breakerState: state } : {})`.

### 8.3 CD-LESSONS — aprendizajes de auto-blindajes recientes

- **CD-LESSON-1** (de WFAC-40 auto-blindaje): custom `errorResponseBuilder` patterns que rely on `throw` + non-enumerable `statusCode`. NO aplica directamente aquí (no usamos errorResponseBuilder), pero el principio se aplica al manejo de excepciones de cockatiel: si cockatiel throws, el adapter catchea **antes** de que propague al route — el route NUNCA ve `BrokenCircuitError`.

- **CD-LESSON-2** (de WFAC-33 auto-blindaje): `light-my-request` inyecta `user-agent: 'lightMyRequest'` por default. Aplicable a tests de `routes.verify.test.ts` que hacen `app.inject({...})` para T-RT-VERIFY-503 — si un test quiere cubrir "header X-Forwarded-For ausente", debe setear explícito.

- **CD-LESSON-3** (de WFAC-33 auto-blindaje): `idempotencyKey` en audit shape es el prefixed key (83 chars), NO el hex bare. No aplica directamente.

- **CD-LESSON-4** (de WFAC-32 auto-blindaje): al borrar una variable en un fix ESLint `no-unused-vars`, correr `rg <name> src/` antes del commit — aplicable a cualquier fix en esta HU.

- **CD-LESSON-5** (de WFAC-32 auto-blindaje): NUNCA poner literales realistas en JSDoc (trip `no-secrets/no-secrets`). Si el breaker class tiene JSDoc ejemplificando thresholds, usar prosa — no literales.

- **CD-LESSON-6** (de WFAC-23 auto-blindaje): correr `npx prettier --write` sobre archivos nuevos antes de `format:check`. OBLIGATORIO para:
  - `src/chains/circuit-breaker.ts`
  - `src/chains/init-breakers.ts`
  - `src/__tests__/unit/chains/circuit-breaker.test.ts`
  - `src/__tests__/unit/chains/init-breakers.test.ts`

- **CD-LESSON-7** (de WFAC-23 auto-blindaje): `// eslint-disable-next-line security/detect-object-injection` con justificación — aplicable a `readCbNumber`/`readCbBool` que hacen `process.env[name]` con `name: string` parameter.

---

## 9. Exemplar verification

Todos verificados con `Read` o `Glob` durante §2 Context Map.

| Exemplar | Path | Verificado | Uso |
|----------|------|------------|-----|
| Adapter class structure | `src/chains/kite.ts` completo (141 LOC) | Read | refactor pattern for `_verifyRaw`/`_breaker.execute` |
| Adapter singleton instantiation | `src/chains/kite.ts:128-140` | Read | `new KiteAdapter({...})` at module scope — breaker se instancia ahí |
| Adapter env read | `src/chains/kite.ts:35-42` (`readEnv(name, chainId)`) | Read | patrón para `readCbNumber`/`readCbBool` |
| Second adapter | `src/chains/avalanche.ts` completo (119 LOC) | Read | mismo pattern, USDC_FUJI token constant |
| Chain adapter contract | `src/chains/types.ts` completo (153 LOC) | Read | agregar opt methods `getBreakerState?` + `setLogger?` |
| X402ErrorCode union | `src/core/types.ts:32-42` | Read | extend con `\| 'CHAIN_UNAVAILABLE'` |
| Err shape | `src/core/types.ts:44-51` | Read | extend `error` con opt `retryAfterMs?: number` |
| HTTP_BY_CODE + DEFAULT_MESSAGE_BY_CODE | `src/core/errors.ts:44-79` | Read | agregar 1 entry each; compiler-exhaustive |
| Env schema pattern | `src/infra/env.ts:13-59` | Read | extender `.object({...})` con 4 CB vars; superRefine unchanged |
| Route 503 mapping | `src/routes/verify.ts:162-175` + `src/routes/settle.ts:184-218` | Read | `reply.header('Retry-After', ...)` insertion point |
| `/supported` adapter metadata emission | `src/core/supported.ts:24-60` | Read | inject `breakerState` via spread condicional |
| Registry | `src/chains/registry.ts:35-130` | Read | `listAdapters()` iteration for `initChainBreakers` |
| App factory pattern | `src/app.ts:64-211` | Read | call `initChainBreakers(app.log)` en la línea post `app.decorate('env', env)` |
| Prior SDD (WFAC-40) | `doc/sdd/015-wfac-40-rate-limiting/sdd.md` | Read | estructura F2, CD table, test plan |
| Auto-blindaje recent | `doc/sdd/015-wfac-40-rate-limiting/auto-blindaje.md` | Read | CD-LESSON-1 incorporado |
| Auto-blindaje WFAC-33 | `doc/sdd/014-wfac-33-audit-log/auto-blindaje.md` | Read | CD-LESSON-2, 3 incorporados |
| Auto-blindaje WFAC-32 | `doc/sdd/013-wfac-32-settlement-ledger/auto-blindaje.md` | Read | CD-LESSON-4, 5 incorporados |
| Auto-blindaje WFAC-23 | `doc/sdd/012-wfac-23-openapi-spec/auto-blindaje.md` | Read | CD-LESSON-6, 7 incorporados |
| cockatiel TS types | `/tmp/cockatiel-probe/node_modules/cockatiel/dist/CircuitBreakerPolicy.d.ts` | Read + smoke test | `CircuitState` enum, `circuitBreaker(policy, opts)`, `execute`, `state` getter, events |
| cockatiel SamplingBreaker | `/tmp/cockatiel-probe/node_modules/cockatiel/dist/breaker/SamplingBreaker.d.ts` | Read | `{threshold, duration, minimumRps}` constructor — DT-4 |
| cockatiel ESM compat test | `/tmp/cockatiel-probe/smoke.test.ts` | Ejecutado OK | confirma Node 20 + tsx + vitest interop (blocker DT-1 resuelto) |
| Rate-limit test pattern | `src/__tests__/unit/rate-limiting.test.ts:1-80` | Read | CaptureStream + `buildApp({rawEnv, loggerDestination})` para tests de W4 |
| Chain adapter test pattern | `src/__tests__/unit/chain-adapter.test.ts:1-60` | Read | `vi.resetModules()` + dynamic import por test |
| env test pattern | `src/__tests__/unit/env.test.ts` | Glob | process.exit stub pattern para AC-10 |
| OWNERS matrix | `OWNERS.md:1-80` | Read | confirmed `src/chains/circuit-breaker.ts` puede importar cockatiel/prom-client; NO core/* |

---

## 10. Readiness Check

| Checklist item | Status |
|----------------|--------|
| Work-item leído completamente | ✅ |
| `project-context.md` leído | ✅ |
| Scope IN matches work-item + clarifications | ✅ 16 MODIFY + 5 CREATE + package.json |
| Scope OUT explícito | ✅ retry queue, adaptive thresholds, distributed state, /metrics route, /status/circuit-breakers |
| Todos los ACs (13) tienen ≥1 test mapeado | ✅ (§7) |
| Blocker DT-1 (cockatiel ESM) resuelto con smoke test empírico | ✅ (§3.1) |
| Blocker DT-3 (error code) resuelto: Opción B ratificada con justificación | ✅ (§3.1) |
| AC-9 (breaker state exposure) resuelto: campo opcional en /supported | ✅ (§3.1 DT-7) |
| AC-12 (metrics) resuelto: prom-client default register, 3 métricas | ✅ (§3.6) |
| Exemplars verificados con Read/Glob | ✅ (§9) |
| CDs heredadas + extensiones documentadas (9 heredadas + 9 nuevas) | ✅ (§8) |
| Waves claras con archivos exactos | ✅ (§6) |
| Ningún `[NEEDS CLARIFICATION]` sin resolver en el SDD | ✅ |
| Auto-blindaje lessons extraídas de últimas 4 HUs DONE | ✅ (§8.3) |
| OWNERS respetado: `src/chains/circuit-breaker.ts` sin imports runtime de `src/core/*` | ✅ (§3.5, §9 — `cockatiel`, `prom-client`, `pino` type-only, `./types.js`) |
| Stack respetado: Fastify v5, Zod v3, prom-client v15.1.3, cockatiel v3.2.1 (nuevo) | ✅ |
| Existing tests NO-regresión: rutas openapi/errors/chain-adapter deben seguir verdes tras los +1 cambios | ✅ (W1 no cambia comportamiento — solo agrega 1 code) |

**READY FOR SPEC_APPROVED**: ✅

---

## 11. Resumen ejecutivo (para el orquestador)

- **Blocker DT-1 (cockatiel ESM)**: resuelto con smoke test real (`/tmp/cockatiel-probe`) — Node 20 + tsx + vitest consumen `cockatiel@3.2.1` named imports vía CJS→ESM interop. **Usamos cockatiel**, sin fallback a opossum ni custom state machine.
- **Blocker DT-3 (error code)**: ratificado **Opción B** (extender `X402ErrorCode` con `CHAIN_UNAVAILABLE`). Justificación fuerte: CHAIN_UNAVAILABLE es semántica x402 (integrators deberían poder case-matchearlo), diferente al 429/RATE_LIMITED de WFAC-40 (infra HTTP genérica). Cascade TS-enforced y acotado (types.ts +1 line, errors.ts +2 lines, openapi.yaml +1 enum).
- **AC-9 (exposure of breaker state)**: campo opcional `breakerState?: 'CLOSED'|'OPEN'|'HALF_OPEN'` en `ChainMetadata`, emitido via `GET /supported`. NO endpoint separado.
- **AC-12 (metrics)**: 3 métricas prom-client en default register (`cb_state` gauge, `cb_failures_total` counter, `cb_transitions_total` counter). NO ruta `/metrics` en esta HU.
- **AC-11 (Retry-After)**: header computado en el route desde `retryAfterMs` opt field agregado al `Err['error']` — no aparece en el body JSON (solo plumbing interno).
- **Breaker semantics (DT-4)**: `SamplingBreaker` con threshold 50% + duration=rollingWindow + minimumRps derivado. Semántica refinada vs AC-1 literal — documentada para QA.
- **Integration point**: `initChainBreakers(logger)` en `src/app.ts` después de `decorate('env', env)`, ducktype sobre `setLogger` opcional.
- **Env vars**: 4 nuevas (`CB_ENABLED`, `CB_FAILURE_THRESHOLD`, `CB_ROLLING_WINDOW_MS`, `CB_RESET_TIMEOUT_MS`) — defaults 5/30000/10000. NO 5ta var.
- **Waves**: W0 (install cockatiel) → W1 (types+env cascade) → W2 (breaker class + unit tests) → W3 (adapters integration) → W4 (routes + /supported + app wiring).
- **CDs**: 9 heredadas + 9 nuevas (CD-10..CD-18) + 7 CD-LESSONS.
- **Tests nuevos**: ≥26 (sumando 5 env + 1 errors + 1 openapi + 11 breaker + 5 adapter + 4 routes/init).

**Artefacto**: `doc/sdd/016-wfac-41-circuit-breaker/sdd.md` (este archivo).
