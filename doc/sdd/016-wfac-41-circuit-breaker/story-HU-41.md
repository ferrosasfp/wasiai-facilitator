# Story File — HU-41 Circuit Breaker per Chain RPC (WFAC-41)

- **Work Item**: `doc/sdd/016-wfac-41-circuit-breaker/work-item.md`
- **SDD**: `doc/sdd/016-wfac-41-circuit-breaker/sdd.md`
- **Pipeline**: QUALITY (resiliency-critical — protege el pool de workers contra RPC cold/slow; nueva lib; afecta reliability en prod) · **Sizing**: M · **SDD_MODE**: full
- **Branch**: `feat/016-wfac-41-circuit-breaker` (desde `main` post-WFAC-53 — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **435/435 passed** (post WFAC-53 DONE) · **Target**: **≥ 461** (435 + ≥26 nuevos)
- **Dependencia clave**: `cockatiel@3.2.1` **NO está instalado** — se agrega en W0 con `npm install cockatiel@3.2.1 --save-exact`. **NO** usar `@^3.2.1` ni `^3.2.1` — **exact** pin (CD-NEW-COCKA-EXACT abajo).
- **Prom-client**: `prom-client@^15.1.3` **ya está** en `package.json` (prod). **NO** reinstalar.
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-41.md`) — **es el único contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — consulta SOLO los relevantes a la wave que estás implementando.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes ambigüedad y sospeches que este Story File está equivocado. En ese caso → **STOP + reporta**.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: feat/016-wfac-41-circuit-breaker

git status
# esperado: clean al empezar. Entre waves, solo archivos del Scope IN (§0.5).

npm test -- --run
# baseline esperado antes de W0: 435/435.
# Creciente tras cada wave hasta ≥461 al cerrar W4.

grep -n "cockatiel" package.json
# Antes de W0: zero matches.
# A partir de W0: exactly 1 match — "cockatiel": "3.2.1" (NOT "^3.2.1").

grep -n "prom-client" package.json
# esperado: 1 match — "prom-client": "^15.1.3" (ya existing, NO tocar).

ls node_modules/cockatiel/dist/index.js \
   node_modules/cockatiel/dist/CircuitBreakerPolicy.d.ts \
   node_modules/cockatiel/dist/breaker/SamplingBreaker.d.ts
# Tras W0: los 3 paths existen. Antes de W0: no existen.
```

### 0.3 Anti-Hallucination Checklist (por wave)

**Antes de empezar una wave:**

- [ ] Leíste ESTE Story File end-to-end (incluyendo §3 CDs y §4 Guardrails).
- [ ] Leíste los exemplars listados para ESTA wave (y solo esos).
- [ ] Verificaste cada import path con `ls` / `Read` antes de escribirlo (`./types.js`, `./circuit-breaker.js`, `./registry.js`, `../chains/...`, etc. — **TODOS con extensión `.js` — CD-ESM**).
- [ ] Confirmaste que **ningún archivo fuera del Scope IN (§0.5)** va a ser tocado.
- [ ] Confirmaste que las dependencias entre waves (§0.6) están verdes (build + tests).

**Antes de cerrar una wave:**

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green (eslint `--max-warnings 0`).
- [ ] `npm run format:check` green (si falla → `npx prettier --write <archivos>` — **CD-LESSON-6**).
- [ ] `npm test -- --run` pasa el baseline (435) + los tests nuevos de esta wave.
- [ ] NO modificaste ningún archivo fuera del Scope IN de la wave.
- [ ] NO agregaste deps distintas a `cockatiel@3.2.1` en W0 (sólo esa dependencia nueva en toda la HU).
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno está violado.
- [ ] **Regression guard WFAC-previas**: todos los tests WFAC-20 / WFAC-21 / WFAC-32 / WFAC-33 / WFAC-40 siguen verdes. **Si un test WFAC-20/21 falla post-W3 → STOP inmediato: el adapter wrapping NO es transparent**.
- [ ] **Regression guard CRÍTICO errors.test.ts**: los asserts `toHaveLength(10)` sobre `HTTP_BY_CODE` y `DEFAULT_MESSAGE_BY_CODE` **DEBEN** actualizarse a `11` en W1. Esto **NO es regresión** — es parte del contrato del HU (extensión Opción B del `X402ErrorCode` union). Ver §1 W1.6.

### 0.4 Exemplars verificados en SDD §9 (paths confirmados con Read)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/chains/kite.ts` líneas 1-140 (completo) | W3: pattern exacto de adapter (`class KiteAdapter implements ChainAdapter` + singletons top-level `new KiteAdapter({...})` líneas 128-140). El constructor recibe opts + llama `readEnv(name, chainId)` línea 58. Hoy `verify`/`settle` son stubs que retornan NETWORK_MISMATCH (líneas 105-125). En W3 se splitea a `_verifyRaw`/`_settleRaw` + wrap con `this._breaker.execute(...)` + try/catch `BreakerOpenError`. | W3 |
| E2 | `src/chains/avalanche.ts` líneas 1-119 (completo) | W3: segundo adapter — patrón idéntico al E1. Constructor sin args (línea 60 `constructor()`), lee `readRpcUrl()` línea 61. Singleton `new AvalancheFujiAdapter()` línea 119. Mismo refactor que kite. | W3 |
| E3 | `src/chains/types.ts` líneas 1-153 (completo) | W3: `ChainAdapter` interface líneas 117-123 (5 miembros: `metadata`, `verify`, `settle`, `getPublicClient`, `getWalletClient`). En W3 se agrega **OPCIONAL** `getBreakerState?(): 'CLOSED' \| 'OPEN' \| 'HALF_OPEN'` y **OPCIONAL** `setLogger?(logger: Logger): void`. NO hacer required — stubs futuros pueden omitirlo. Línea 34-47: `ChainMetadata` — en W4 se agrega `readonly breakerState?: 'CLOSED' \| 'OPEN' \| 'HALF_OPEN'` opcional al final. | W3, W4 |
| E4 | `src/core/types.ts` líneas 32-51 | W1: `X402ErrorCode` union — actualmente 10 miembros (líneas 32-42). Se agrega `\| 'CHAIN_UNAVAILABLE'` como miembro 11. `Err` interface (líneas 44-51): agregar `readonly retryAfterMs?: number` como campo opcional del `error` object (para plumbing route↔adapter — NO se serializa en body). | W1, W4 |
| E5 | `src/core/errors.ts` líneas 44-106 | W1: `HTTP_BY_CODE` (líneas 44-55) y `DEFAULT_MESSAGE_BY_CODE` (líneas 68-79) — Records **exhaustivos** por TS. Al agregar `CHAIN_UNAVAILABLE` al union en E4, TS rompe la compilación hasta agregar entries aquí. `HTTP_BY_CODE.CHAIN_UNAVAILABLE = 503`. `DEFAULT_MESSAGE_BY_CODE.CHAIN_UNAVAILABLE = 'Chain RPC temporarily unavailable'`. `buildX402Error()` línea 98 funciona sin cambios. | W1 |
| E6 | `src/infra/env.ts` líneas 1-86 (completo) | W1: `EnvSchema` `.object({...})` (líneas 13-49) — hoy tiene WFAC-40 vars (líneas 42-49). Agregar 4 CB_* vars AL FINAL del `.object({...})`, ANTES del `.superRefine(...)` línea 51. Patrón a replicar: exactamente igual a RATE_LIMIT_ENABLED (línea 42-45) para `CB_ENABLED`, y exactamente igual a RATE_LIMIT_WINDOW_SEC (línea 46) para los 3 numéricos. El `.superRefine((data, ctx) => {...})` REDIS_URL **no se toca**. | W1 |
| E7 | `src/routes/verify.ts` líneas 61-201 (completo) | W4: handler completo de `/verify`. En Step 5 (línea 162 `if (!result.ok)`) se agrega detección de `CHAIN_UNAVAILABLE` ANTES del `reply.code(...)` línea 175. Cuando `result.error.code === 'CHAIN_UNAVAILABLE'` y `typeof result.error.retryAfterMs === 'number'` → `reply.header('Retry-After', String(Math.max(1, Math.ceil(result.error.retryAfterMs/1000))))`. **NO tocar** el handler de cache-hit (`sendCached` líneas 217-247) ni el resto del pipeline. El body 4xx/5xx sigue siendo `{ error: result.error }` — **NO incluir retryAfterMs en el body** (CD-12 abajo). | W4 |
| E8 | `src/routes/settle.ts` líneas 63-270 | W4: idéntico a E7 — Step 5 (línea 184 `if (!result.ok)`) agregar header `Retry-After` antes del `reply.code(result.error.http).send(...)` línea 217. NO tocar el ledger hook WFAC-32 (`persistLedgerEntry(...)` línea 197-214) ni el cached-hit path. | W4 |
| E9 | `src/routes/supported.ts` + `src/core/supported.ts` líneas 1-66 (completo) | W4: AC-9 se resuelve extendiendo la response de `/supported` con `breakerState?: 'CLOSED' \| 'OPEN' \| 'HALF_OPEN'` OPCIONAL (spread condicional). El handler de `/supported` delega a `getSupportedResponse()` en `src/core/supported.ts`. La función está en líneas 57-66 — **aquí** se inyecta el campo. Leer `adapter.getBreakerState?.()` via ducktype y spread condicional `...(state !== undefined ? { breakerState: state } : {})`. | W4 |
| E10 | `src/app.ts` líneas 1-211 (completo) | W4: `buildApp(...)` estructura completa. Orden final tras W4: `Fastify({...})` → `app.decorate('env', env)` (línea 85) → `if (env.RATE_LIMIT_ENABLED) await app.register(rateLimit, ...)` (líneas 91-153) → **`initChainBreakers(app.log)` [NEW W4]** → `app.register(healthRoute)` (155) → ... → `app.addHook('onResponse', ...)` (167-195). El logger `app.log` ya existe (línea 80 `loggerInstance: logger`). | W4 |
| E11 | `src/chains/registry.ts` | W4: `chainRegistry` singleton exportado. `chainRegistry.listAdapters()` retorna `readonly ChainMetadata[]`; `chainRegistry.getAdapter(chainId)` retorna `{ok:true, adapter}` o `{ok:false, error}`. En W4 se ducktype-detecta `setLogger` sobre cada adapter para inyectar logger tras boot. | W4 |
| E12 | `src/core/errors.ts` completo + `src/__tests__/unit/core/errors.test.ts` líneas 1-120 | W1: tests **CRÍTICOS** de actualizar: `describe('core/errors — HTTP_BY_CODE (AC-4)')` → it `'contains exactly 10 entries'` línea 54 → **cambiar a `11`** + agregar el caso `CHAIN_UNAVAILABLE → 503` al array `CANONICAL` (línea 34). `describe('DEFAULT_MESSAGE_BY_CODE (AC-5)')` → it `'contains exactly 10 entries'` línea 90 → **cambiar a `11`**. Agregar test que valide `HTTP_BY_CODE.CHAIN_UNAVAILABLE === 503`. | W1 |
| E13 | `src/__tests__/unit/routes.openapi.test.ts` líneas 165-200 | W1: test `T-O5 / AC-5` línea 165 — enum list literal (líneas 170-181) — **agregar** `'CHAIN_UNAVAILABLE'` al `expected`. El `X402ErrorHttp` enum línea 465 de `doc/openapi.yaml` — **agregar `503`**. El test de `httpEnum` línea 190 (`uniqueHttpFromMap = Array.from(new Set(Object.values(HTTP_BY_CODE))).sort()`) se actualiza automáticamente a `[400,401,402,412,500,503]` porque es derivado. | W1 |
| E14 | `doc/openapi.yaml` líneas 440-466 | W1: schema `X402ErrorCode.enum` (líneas 447-457) — agregar `- CHAIN_UNAVAILABLE`. Schema `X402ErrorHttp.enum` (línea 465) — agregar `503`. Description línea 445 **actualizar** de "exactly 10 values" a "exactly 11 values". | W1 |
| E15 | `src/__tests__/unit/env.test.ts` | W1: patrón `parseEnv` con `process.exit` stub. Replicar para 4 CB_* vars. Pattern YA usado para RATE_LIMIT_* vars en WFAC-40 (T-ENV-RL-*) — copiar la forma. | W1 |
| E16 | `src/__tests__/unit/chain-adapter.test.ts` líneas 1-80 | W3: patrón `vi.resetModules()` + dynamic import + env cleanup. Críticamente: los tests existentes usan `await import('../../chains/kite.js')` con `vi.resetModules()` — los tests nuevos de CB integration deben usar el mismo patrón para aislamiento. | W3 |
| E17 | `src/__tests__/unit/rate-limiting.test.ts` líneas 1-80 | W4: patrón `buildApp({ rawEnv, loggerDestination })` + CaptureStream para logs. Exemplar para tests del route 503 Retry-After + AC-8 log warn en transición de breaker. | W4 |
| E18 | `src/__tests__/unit/routes.verify.test.ts` + `routes.settle.test.ts` + `routes.supported.test.ts` | W4: patrón `app.inject({method, url, headers, payload})`. Para forzar CHAIN_UNAVAILABLE hay 2 caminos: (a) `vi.mock('../../chains/kite.js', ...)` retornando un mock con `verify` que devuelve `{ok:false, error:{code:'CHAIN_UNAVAILABLE', http:503, retryAfterMs: 7500}}`; (b) construir un test que abra el breaker con N fails antes de la request. Usar path (a) por simplicidad. | W4 |
| E19 | `OWNERS.md` | Todas: `src/chains/<chain>.ts` puede importar `./types.js` + viem. **NO** importar `src/core/*` runtime. `src/chains/circuit-breaker.ts` (NEW W2) sigue la misma regla. Puede importar `cockatiel` (3rd party), `prom-client` (3rd party), `pino` **type-only**. **NO** `src/core/types.ts` runtime ni `src/core/errors.ts`. | Todas |
| E20 | `node_modules/cockatiel/dist/CircuitBreakerPolicy.d.ts` | W2: tras W0, este path existe. API pública: `CircuitState` enum (`Closed=0, Open=1, HalfOpen=2, Isolated=3`), `onBreak`, `onReset`, `onHalfOpen`, `onStateChange` events, `execute(fn)` throws `BrokenCircuitError` cuando OPEN, `state` getter. | W2 |
| E21 | `node_modules/cockatiel/dist/breaker/SamplingBreaker.d.ts` | W2: constructor `{ threshold: number (0..1), duration: number (ms), minimumRps?: number }`. Combined con `circuitBreaker(handleAll, { halfOpenAfter, breaker })` factory fluente. | W2 |
| E22 | `doc/sdd/015-wfac-40-rate-limiting/story-HU-40.md` | Todas: exemplar estructural MÁS RECIENTE — replicar estructura de secciones, tono, niveles de detalle. | Todas |
| E23 | `doc/sdd/015-wfac-40-rate-limiting/auto-blindaje.md` + `014/auto-blindaje.md` + `013/auto-blindaje.md` + `012/auto-blindaje.md` | Todas: CD-LESSONS en §3.3 — `prettier --write`, `security/detect-object-injection` eslint-disable con justificación, `no-secrets` JSDoc prosa no literales, `grep` post-fix ESLint unused-vars. | Todas |
| E24 | `tsconfig.json` | Todas: `module: "Node16"` + ESM strict. **Imports con `.js` extension obligatorio** — `import { ... } from './circuit-breaker.js';` aunque el archivo source sea `.ts`. Olvidar el `.js` rompe `npm run build`. | Todas |

### 0.5 Scope IN — los ÚNICOS archivos que puedes tocar

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `package.json` | **MODIFY** (agregar `cockatiel` exact `3.2.1` en `dependencies`) | W0 |
| 2 | `package-lock.json` | **MODIFY** (auto-generado por `npm install`) | W0 |
| 3 | `src/core/types.ts` | **MODIFY** (`X402ErrorCode` +1 miembro; `Err.error` +1 opt field `retryAfterMs?: number`) | W1 |
| 4 | `src/core/errors.ts` | **MODIFY** (+1 entry en `HTTP_BY_CODE`; +1 entry en `DEFAULT_MESSAGE_BY_CODE`) | W1 |
| 5 | `src/infra/env.ts` | **MODIFY** (+4 keys en `EnvSchema.object({...})` pre-`superRefine`) | W1 |
| 6 | `doc/openapi.yaml` | **MODIFY** (enum `X402ErrorCode` +1; enum `X402ErrorHttp` +503; description actualiza 10→11) | W1 |
| 7 | `src/__tests__/unit/core/errors.test.ts` | **MODIFY** (update 10→11; agregar caso CHAIN_UNAVAILABLE al `CANONICAL`) | W1 |
| 8 | `src/__tests__/unit/routes.openapi.test.ts` | **MODIFY** (append CHAIN_UNAVAILABLE al `expected` array) | W1 |
| 9 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append ≥5 tests CB_* vars — defaults + invalid) | W1 |
| 10 | `src/chains/circuit-breaker.ts` | **CREATE** (ChainCircuitBreaker class + BreakerOpenError + readCb* helpers + metrics singletons + registerOrGet) | W2 |
| 11 | `src/__tests__/unit/chains/circuit-breaker.test.ts` | **CREATE** (≥11 unit tests: state machine + threshold + probe + metrics + logger injection + independencia + enabled=false passthrough + recordBusinessFailure) | W2 |
| 12 | `src/chains/types.ts` | **MODIFY** (`ChainAdapter` +opt `getBreakerState?` + opt `setLogger?`; `ChainMetadata` +opt `breakerState?` al final) | W3 |
| 13 | `src/chains/kite.ts` | **MODIFY** (split `verify`→`_verifyRaw`/`verify` wrapped + idem `settle`; expose `setLogger`, `getBreakerState`; breaker instance privado) | W3 |
| 14 | `src/chains/avalanche.ts` | **MODIFY** (idéntico pattern que kite.ts) | W3 |
| 15 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (append ≥5 tests CB integration — exposure `getBreakerState`, transition tras N fails, independence kite vs avalanche, recordBusinessFailure en SIMULATION_FAILED) | W3 |
| 16 | `src/chains/init-breakers.ts` | **CREATE** (`initChainBreakers(logger)` helper — ducktype sobre `setLogger`) | W4 |
| 17 | `src/app.ts` | **MODIFY** (+ import `initChainBreakers`; llamar tras `app.decorate('env', env)` y antes de registrar routes) | W4 |
| 18 | `src/routes/verify.ts` | **MODIFY** (Step 5 agregar detección `CHAIN_UNAVAILABLE` + `Retry-After` header antes del `reply.code(...)`) | W4 |
| 19 | `src/routes/settle.ts` | **MODIFY** (idem verify; en Step 5 `if (!result.ok)`) | W4 |
| 20 | `src/core/supported.ts` | **MODIFY** (inyectar `breakerState` opt vía ducktype + spread condicional) | W4 |
| 21 | `src/__tests__/unit/routes.verify.test.ts` | **MODIFY** (append ≥2 tests: 503 body + Retry-After header valor numeric) | W4 |
| 22 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (idem verify) | W4 |
| 23 | `src/__tests__/unit/routes.supported.test.ts` | **MODIFY** (append ≥2 tests: breakerState field exposed per chain when CB enabled; field OMITIDO si adapter no expone getBreakerState) | W4 |
| 24 | `src/__tests__/unit/chains/init-breakers.test.ts` | **CREATE** (test integration — tras buildApp, `getBreakerState()` retorna 'CLOSED' en kite + avalanche) | W4 |

**Cualquier edit a cualquier otro archivo = violación del Story File. STOP AND REPORT.**

En particular, los siguientes archivos están **CONGELADOS** para esta HU:

- `src/routes/health.ts` — WFAC-2 frozen. **NO tocar**.
- `src/routes/openapi.ts` — WFAC-23 + WFAC-40 frozen. **NO tocar**.
- `src/routes/supported.ts` — solo route binding; toda la lógica de breakerState vive en `src/core/supported.ts`. **NO tocar**.
- `src/core/audit.ts` — WFAC-33 frozen.
- `src/core/ledger.ts` — WFAC-32 frozen.
- `src/core/idempotency.ts`, `src/core/schemas.ts`, `src/core/settle.ts`, `src/core/verify.ts` — WFAC-previos frozen.
- `src/core/network.ts` — WFAC-40 frozen.
- `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/infra/logger.ts` — consumidos, no modificados.
- `src/chains/registry.ts` — solo consumido en W4 via `chainRegistry.listAdapters()`. **NO modificar**.
- `supabase/migrations/*.sql` — **no aplica** (esta HU NO toca DB).
- `.env.example` — **NO modificar en esta HU** (documentación en PR follow-up si se requiere).
- Archivos de test existentes NO listados en Scope IN (e.g., `audit.test.ts`, `ledger.test.ts`, `health.test.ts`, `core-types.test.ts`, `core.verify.test.ts`, `core.settle.test.ts`, `logger.test.ts`, `no-console.test.ts`, `chain-registry.test.ts`, `shutdown.test.ts`, `redis.test.ts`, `supabase.test.ts`, `rate-limiting.test.ts`) — **NO modificar**.

### 0.6 Wave dependency graph

```
W0 (npm install cockatiel@3.2.1 --save-exact)
 │
 ▼
W1 (X402ErrorCode + HTTP_BY_CODE + DEFAULT_MESSAGE_BY_CODE + EnvSchema + openapi.yaml + tests cascade)
 │
 ▼
W2 (src/chains/circuit-breaker.ts class + tests) [aislado — zero ties a routes/adapters]
 │
 ▼
W3 (src/chains/kite.ts + avalanche.ts + types.ts — adapter wrap)
 │
 ▼
W4 (src/chains/init-breakers.ts + app.ts + verify/settle Retry-After + core/supported.ts + tests routes + init-breakers test)
```

- **W0 → W1**: W1 no necesita cockatiel (solo types/env/openapi cascade), pero W0 instala la dep antes para evitar typecheck fail en W2 si alguien importa inadvertidamente.
- **W1 → W2**: W2 necesita `CHAIN_UNAVAILABLE` definido en union para mapear el breaker output, pero el breaker class **NO importa `src/core/*` runtime** (CD-CHAIN-OWNERS abajo) — la traducción `BreakerOpenError` → `{code: 'CHAIN_UNAVAILABLE'}` ocurre en el **adapter** (W3). Aun así W1 se cierra antes porque los tests de W2 verifican que `typecheck` compila con el union extendido.
- **W2 → W3**: W3 consume la clase `ChainCircuitBreaker` desde `./circuit-breaker.js`.
- **W3 → W4**: W4 consume `setLogger` + `getBreakerState` de los adapters; también W4 consume el opt field `retryAfterMs` en el error (poblado por adapters en W3).
- **Sin forward references**. Si W1 necesita algo de W2/W3, hay bug de diseño — **STOP + REPORT**.

---

## 1. Waves

### Wave 0 (SERIAL, preflight) — Install cockatiel

**Objetivo**: cockatiel disponible como dep exact-pinned; lockfile consistente.

#### Files (W0)

| # | Path | Acción |
|---|------|--------|
| 1 | `package.json` | **MODIFY** (agregar `"cockatiel": "3.2.1"` en `dependencies`) |
| 2 | `package-lock.json` | **MODIFY** (auto-generado por npm) |

#### W0.1 — Install

```bash
npm install cockatiel@3.2.1 --save-exact
```

**Post-install verificación**:

```bash
grep -n "cockatiel" package.json
# esperado: exactly 1 match — "cockatiel": "3.2.1"
#           NOT "^3.2.1" (CD-NEW-COCKA-EXACT)

ls node_modules/cockatiel/dist/index.js \
   node_modules/cockatiel/dist/CircuitBreakerPolicy.d.ts \
   node_modules/cockatiel/dist/breaker/SamplingBreaker.d.ts
# esperado: los 3 paths existen

npm run typecheck
# esperado: green (ningún código consume cockatiel todavía)

npm test -- --run
# esperado: 435/435 — sin cambios (nada consume cockatiel todavía)
```

#### Wave 0 — completion criteria

- [ ] `package.json` incluye `"cockatiel": "3.2.1"` (exact, sin `^` ni `~`).
- [ ] `package-lock.json` actualizado (commit con ambos).
- [ ] `npm run typecheck` green.
- [ ] `npm test -- --run` → 435/435 (no cambia baseline aún).

**Commit sugerido** (un solo commit para W0):
```
feat(WFAC-41): W0 install cockatiel@3.2.1
```

---

### Wave 1 (SERIAL) — Types + env + CHAIN_UNAVAILABLE cascade

**Objetivo**: foundation lista. Compila. Sin lógica de breaker aún. `CHAIN_UNAVAILABLE` es un valor válido del union + TS fuerza `HTTP_BY_CODE`/`DEFAULT_MESSAGE_BY_CODE` coverage. Env schema acepta las 4 CB_* vars.

#### Files (W1)

| # | Path | Acción |
|---|------|--------|
| 3 | `src/core/types.ts` | **MODIFY** |
| 4 | `src/core/errors.ts` | **MODIFY** |
| 5 | `src/infra/env.ts` | **MODIFY** |
| 6 | `doc/openapi.yaml` | **MODIFY** |
| 7 | `src/__tests__/unit/core/errors.test.ts` | **MODIFY** |
| 8 | `src/__tests__/unit/routes.openapi.test.ts` | **MODIFY** |
| 9 | `src/__tests__/unit/env.test.ts` | **MODIFY** |

#### W1.1 — `src/core/types.ts`

**Acción**: 2 cambios atómicos.

1. **Extender `X402ErrorCode`** (líneas 32-42): agregar `'CHAIN_UNAVAILABLE'` como 11º miembro (recomendación: al final del union, después de `DELEGATION_INVALID`).

**Antes** (líneas 32-42):
```ts
export type X402ErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID';
```

**Después**:
```ts
export type X402ErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID'
  // WFAC-41 (DT-3 Opción B) — circuit breaker open: facilitator cannot reach
  // the RPC for this chain. HTTP 503. Populated by ChainAdapter.verify/settle
  // when the per-chain breaker is in OPEN state (src/chains/circuit-breaker.ts).
  | 'CHAIN_UNAVAILABLE';
```

2. **Extender `Err.error`** (líneas 44-51): agregar OPCIONAL `retryAfterMs?: number`.

**Antes**:
```ts
export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
  };
}
```

**Después**:
```ts
export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
    /**
     * WFAC-41 (DT-10) — populated ONLY when `code === 'CHAIN_UNAVAILABLE'`.
     * Used by route layer to compute `Retry-After` HTTP header. NEVER serialized
     * in the JSON response body (CD-NEW-CB-RETRY-AFTER-INTERNAL).
     */
    readonly retryAfterMs?: number;
  };
}
```

**Actualizar también el header JSDoc** línea 9:

**Antes**:
```ts
 *   - X402ErrorCode: union literal of exactly the 10 codes in x402 spec.
```

**Después**:
```ts
 *   - X402ErrorCode: union literal of exactly the 11 codes (10 x402 spec +
 *     CHAIN_UNAVAILABLE WFAC-41 DT-3 Opción B).
```

**Checklist W1.1**:

- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/core/types.ts` → **exactly 1 match**.
- [ ] `grep -n "retryAfterMs" src/core/types.ts` → **exactly 1 match** (en `Err.error`).
- [ ] El `Err.error` sigue teniendo `code`/`message`/`http` **required** + `retryAfterMs` **optional**. No agregar `readonly` extra ni remover los existing.
- [ ] `npm run typecheck` → **FALLARÁ** hasta cerrar W1.2 (esperado — los Records de errors.ts tienen que incluir `CHAIN_UNAVAILABLE`).

#### W1.2 — `src/core/errors.ts`

**Acción**: 2 cambios — agregar 1 entry en cada Record.

**`HTTP_BY_CODE`** (líneas 44-55): agregar al final.

**Antes**:
```ts
export const HTTP_BY_CODE: Record<X402ErrorCode, number> = {
  INVALID_SIGNATURE: 401,
  INSUFFICIENT_BALANCE: 402,
  PERMIT2_ALLOWANCE_REQUIRED: 412,
  EXPIRED_AUTHORIZATION: 400,
  NETWORK_MISMATCH: 400,
  SIMULATION_FAILED: 500,
  INVALID_AMOUNT: 400,
  INVALID_RECEIVER: 400,
  TRANSACTION_FAILED: 500,
  DELEGATION_INVALID: 401,
};
```

**Después**:
```ts
export const HTTP_BY_CODE: Record<X402ErrorCode, number> = {
  INVALID_SIGNATURE: 401,
  INSUFFICIENT_BALANCE: 402,
  PERMIT2_ALLOWANCE_REQUIRED: 412,
  EXPIRED_AUTHORIZATION: 400,
  NETWORK_MISMATCH: 400,
  SIMULATION_FAILED: 500,
  INVALID_AMOUNT: 400,
  INVALID_RECEIVER: 400,
  TRANSACTION_FAILED: 500,
  DELEGATION_INVALID: 401,
  // WFAC-41 — circuit breaker open: HTTP 503 Service Unavailable.
  CHAIN_UNAVAILABLE: 503,
};
```

**`DEFAULT_MESSAGE_BY_CODE`** (líneas 68-79): agregar al final.

**Antes** (último entry):
```ts
  DELEGATION_INVALID: 'Delegation invalid',
};
```

**Después**:
```ts
  DELEGATION_INVALID: 'Delegation invalid',
  CHAIN_UNAVAILABLE: 'Chain RPC temporarily unavailable',
};
```

**Actualizar también el JSDoc** del bloque `HTTP_BY_CODE` líneas 32-43 para agregar la línea `- CHAIN_UNAVAILABLE       → 503 (circuit breaker open, RPC not reachable)`.

**Checklist W1.2**:

- [ ] `grep -c "CHAIN_UNAVAILABLE" src/core/errors.ts` → **exactly 2 matches** (1 en HTTP_BY_CODE + 1 en DEFAULT_MESSAGE_BY_CODE + posibles JSDoc — mínimo 2 runtime).
- [ ] Los 10 entries previos siguen INTACTOS en ambos Records. Ningún delete, ningún reorder.
- [ ] `npm run typecheck` → **GREEN** (ya cerró el cascade iniciado en W1.1).

#### W1.3 — `src/infra/env.ts`

**Acción**: extender `.object({...})` con 4 CB_* vars AL FINAL (después de `RATE_LIMIT_SUPPORTED_MAX` línea 49), ANTES del `.superRefine(...)` línea 51. **NO** tocar el superRefine.

**Patch**:
```ts
export const EnvSchema = z
  .object({
    // ... existing fields (NODE_ENV..RATE_LIMIT_SUPPORTED_MAX) UNCHANGED ...

    RATE_LIMIT_SUPPORTED_MAX: z.coerce.number().int().min(1).default(120),

    // WFAC-41 — circuit breaker per chain RPC (SDD §4.1). NO magic numbers
    // in adapters (CD-NEW-CB-NO-MAGIC). `CB_ENABLED` must use the enum
    // transform pattern — `z.coerce.boolean()` is PROHIBITED (CD-NEW-CB-BOOL;
    // same rationale as WFAC-40 CD-12 for RATE_LIMIT_ENABLED).
    CB_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    CB_ROLLING_WINDOW_MS: z.coerce.number().int().min(1).default(30000),
    CB_RESET_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
  })
  .superRefine((data, ctx) => { /* WFAC-5 REDIS_URL check UNCHANGED */ });
```

**Checklist W1.3**:

- [ ] Las 4 keys están presentes en el `z.object({...})`.
- [ ] `CB_ENABLED` usa `z.enum(['true','false']).default('true').transform(...)` — **NO** `z.coerce.boolean()` (**CD-NEW-CB-BOOL**).
- [ ] Los 3 CB_* numéricos usan `z.coerce.number().int().min(1).default(N)`:
  - `CB_FAILURE_THRESHOLD` → default `5`
  - `CB_ROLLING_WINDOW_MS` → default `30000`
  - `CB_RESET_TIMEOUT_MS` → default `10000`
- [ ] El `.superRefine(...)` WFAC-5 queda INTACTO.
- [ ] `EnvConfig = z.infer<typeof EnvSchema>` sigue siendo export y ahora incluye los 4 campos nuevos tipados.
- [ ] **NO agregar una 5ª var** (p.ej. `CB_PROBE_HALF_OPEN_MS`): el "half-open probe interval" en cockatiel == `halfOpenAfter` == `CB_RESET_TIMEOUT_MS`. Una var separada es **PROHIBIDA** (**CD-NEW-CB-4VARS**).

#### W1.4 — `doc/openapi.yaml`

**Acción**: 3 cambios.

1. **Enum `X402ErrorCode`** (líneas 447-457): agregar `- CHAIN_UNAVAILABLE` al final del enum list.
2. **Enum `X402ErrorHttp`** (línea 465): agregar `503`.
3. **Description** línea 445: `exactly 10 values` → `exactly 11 values`.

**Antes** (líneas 442-465):
```yaml
    X402ErrorCode:
      type: string
      description: |
        Canonical x402 error code. Exactly the 10 values exported as the
        `X402ErrorCode` union from `src/core/types.ts`.
      enum:
        - INVALID_SIGNATURE
        - INSUFFICIENT_BALANCE
        - PERMIT2_ALLOWANCE_REQUIRED
        - EXPIRED_AUTHORIZATION
        - NETWORK_MISMATCH
        - SIMULATION_FAILED
        - INVALID_AMOUNT
        - INVALID_RECEIVER
        - TRANSACTION_FAILED
        - DELEGATION_INVALID

    X402ErrorHttp:
      type: integer
      description: |
        HTTP status associated with the error code. Matches `HTTP_BY_CODE`
        in `src/core/errors.ts`. Values are `400`, `401`, `402`, `412`,
        or `500`.
      enum: [400, 401, 402, 412, 500]
```

**Después**:
```yaml
    X402ErrorCode:
      type: string
      description: |
        Canonical x402 error code. Exactly the 11 values exported as the
        `X402ErrorCode` union from `src/core/types.ts` (10 x402 spec codes +
        CHAIN_UNAVAILABLE per WFAC-41 DT-3 Opción B).
      enum:
        - INVALID_SIGNATURE
        - INSUFFICIENT_BALANCE
        - PERMIT2_ALLOWANCE_REQUIRED
        - EXPIRED_AUTHORIZATION
        - NETWORK_MISMATCH
        - SIMULATION_FAILED
        - INVALID_AMOUNT
        - INVALID_RECEIVER
        - TRANSACTION_FAILED
        - DELEGATION_INVALID
        - CHAIN_UNAVAILABLE

    X402ErrorHttp:
      type: integer
      description: |
        HTTP status associated with the error code. Matches `HTTP_BY_CODE`
        in `src/core/errors.ts`. Values are `400`, `401`, `402`, `412`,
        `500`, or `503` (CHAIN_UNAVAILABLE per WFAC-41).
      enum: [400, 401, 402, 412, 500, 503]
```

**Checklist W1.4**:

- [ ] `grep -c "CHAIN_UNAVAILABLE" doc/openapi.yaml` → **exactly 1 match** (el enum).
- [ ] `grep -n "503" doc/openapi.yaml` → **exactly 1 match** (el X402ErrorHttp enum).
- [ ] **NO agregar** un nuevo path `/status/circuit-breakers` (AC-9 se resuelve via extension de `/supported`, DT-7 SDD — ver W4.5).

#### W1.5 — `src/__tests__/unit/env.test.ts` (APPEND)

**Acción**: agregar ≥5 tests nuevos al final del archivo. NO modificar tests existentes.

**Tests requeridos (IDs T-ENV-CB-*)**:

- **T-ENV-CB-1 (AC-10 defaults)**: `parseEnv({ NODE_ENV:'test', /* otros mínimos válidos */ })` → `env.CB_ENABLED === true`, `env.CB_FAILURE_THRESHOLD === 5`, `env.CB_ROLLING_WINDOW_MS === 30000`, `env.CB_RESET_TIMEOUT_MS === 10000`.
- **T-ENV-CB-2 (CD-NEW-CB-BOOL disabled)**: `parseEnv({ CB_ENABLED:'false', ... })` → `env.CB_ENABLED === false` (boolean, not string).
- **T-ENV-CB-3 (AC-10 override numeric)**: `parseEnv({ CB_FAILURE_THRESHOLD:'10', CB_ROLLING_WINDOW_MS:'60000', CB_RESET_TIMEOUT_MS:'15000', ... })` → los 3 campos reflejan los valores parseados a number.
- **T-ENV-CB-4 (AC-10 invalid negative FAILURE_THRESHOLD)**: stub `process.exit`, `parseEnv({ CB_FAILURE_THRESHOLD:'-1', ... })` → `process.exit` llamado con `1`, stderr menciona `CB_FAILURE_THRESHOLD`.
- **T-ENV-CB-5 (AC-10 invalid zero ROLLING_WINDOW_MS)**: `parseEnv({ CB_ROLLING_WINDOW_MS:'0', ... })` → `process.exit(1)`, stderr menciona `CB_ROLLING_WINDOW_MS`.
- **T-ENV-CB-6 (AC-10 invalid non-integer RESET_TIMEOUT_MS)**: `parseEnv({ CB_RESET_TIMEOUT_MS:'abc', ... })` → `process.exit(1)`, stderr menciona `CB_RESET_TIMEOUT_MS`.
- **T-ENV-CB-7 (CD-NEW-CB-BOOL invalid ENABLED)**: `parseEnv({ CB_ENABLED:'yes', ... })` → `process.exit(1)`, stderr menciona `CB_ENABLED`.

**Total tests nuevos en env.test.ts: ≥7** (T-ENV-CB-1 a T-ENV-CB-7).

**Checklist W1.5**:

- [ ] Tests existentes (originales + T-ENV-RL-1..7 de WFAC-40) **todos verdes**. Si alguno rompe → regresión en W1.3.
- [ ] T-ENV-CB-4/5/6/7 no crashean el runner (stub de `process.exit` debe throw o capturar).
- [ ] `grep -nE "CB_(ENABLED|FAILURE_THRESHOLD|ROLLING_WINDOW_MS|RESET_TIMEOUT_MS)" src/__tests__/unit/env.test.ts` → **≥4 matches**.

#### W1.6 — `src/__tests__/unit/core/errors.test.ts` (MODIFY — CRÍTICO)

**Acción**: actualizar asserts `toHaveLength(10)` → `toHaveLength(11)` + agregar `CHAIN_UNAVAILABLE` al `CANONICAL` array + agregar test de HTTP 503 mapping.

**Cambios mínimos**:

1. **Línea 34** `CANONICAL` array — agregar entry:
```ts
const CANONICAL: Array<{ code: X402ErrorCode; http: number }> = [
  { code: 'INVALID_SIGNATURE', http: 401 },
  { code: 'INSUFFICIENT_BALANCE', http: 402 },
  { code: 'PERMIT2_ALLOWANCE_REQUIRED', http: 412 },
  { code: 'EXPIRED_AUTHORIZATION', http: 400 },
  { code: 'NETWORK_MISMATCH', http: 400 },
  { code: 'SIMULATION_FAILED', http: 500 },
  { code: 'INVALID_AMOUNT', http: 400 },
  { code: 'INVALID_RECEIVER', http: 400 },
  { code: 'TRANSACTION_FAILED', http: 500 },
  { code: 'DELEGATION_INVALID', http: 401 },
  // WFAC-41 — circuit breaker open, HTTP 503.
  { code: 'CHAIN_UNAVAILABLE', http: 503 },
];
```

2. **Línea 54** assert `HTTP_BY_CODE` count:
```ts
it('contains exactly 11 entries (spec-literal inventory + WFAC-41 CHAIN_UNAVAILABLE)', () => {
  expect(Object.keys(HTTP_BY_CODE)).toHaveLength(11);
});
```

3. **Línea 90** assert `DEFAULT_MESSAGE_BY_CODE` count:
```ts
it('contains exactly 11 entries (exhaustive coverage)', () => {
  expect(Object.keys(DEFAULT_MESSAGE_BY_CODE)).toHaveLength(11);
});
```

4. **Actualizar JSDoc** líneas 15-16 (opcional — bump 10→11 en comentarios). **OBLIGATORIO** si el string literal `'10 canonical'` aparece en un `expect(...).toContain('10')` o similar.

5. **Agregar 1 test nuevo (T-CB-HTTP-503)** en el `describe('core/errors — HTTP_BY_CODE (AC-4)')`:
```ts
it('WFAC-41 T-CB-HTTP-503: CHAIN_UNAVAILABLE maps to 503', () => {
  expect(HTTP_BY_CODE.CHAIN_UNAVAILABLE).toBe(503);
});
```

6. **Agregar 1 test nuevo (T-CB-MSG)** en el `describe('DEFAULT_MESSAGE_BY_CODE (AC-5)')`:
```ts
it('WFAC-41 T-CB-MSG: CHAIN_UNAVAILABLE default message is spec-literal', () => {
  expect(DEFAULT_MESSAGE_BY_CODE.CHAIN_UNAVAILABLE).toBe('Chain RPC temporarily unavailable');
});
```

7. **Agregar 1 test nuevo (T-CB-BUILD)** en el `describe('buildX402Error...')`:
```ts
it('WFAC-41 T-CB-BUILD: buildX402Error("CHAIN_UNAVAILABLE") returns { code, message, http:503 }', () => {
  const out = buildX402Error('CHAIN_UNAVAILABLE');
  expect(out).toEqual({
    code: 'CHAIN_UNAVAILABLE',
    message: 'Chain RPC temporarily unavailable',
    http: 503,
  });
});
```

**Total tests nuevos en errors.test.ts: ≥3** (T-CB-HTTP-503, T-CB-MSG, T-CB-BUILD) + los 2 asserts `toHaveLength(10)` actualizados a `11`.

**Checklist W1.6**:

- [ ] `grep -cE "toHaveLength\(1[01]\)" src/__tests__/unit/core/errors.test.ts` → conteo coherente post-cambio (ambos en 11).
- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/__tests__/unit/core/errors.test.ts` → **≥2 matches** (CANONICAL + los 3 tests nuevos).
- [ ] Los 10 tests previos que iteran `CANONICAL` siguen verdes — el array ahora tiene 11 entries y ambos Records deben responder para los 11.

#### W1.7 — `src/__tests__/unit/routes.openapi.test.ts` (MODIFY)

**Acción**: agregar `'CHAIN_UNAVAILABLE'` al array `expected` del test `T-O5 / AC-5` (línea 170-181).

**Cambio** (línea 170-181):

**Antes**:
```ts
    const expected: X402ErrorCode[] = [
      'INVALID_SIGNATURE',
      'INSUFFICIENT_BALANCE',
      'PERMIT2_ALLOWANCE_REQUIRED',
      'EXPIRED_AUTHORIZATION',
      'NETWORK_MISMATCH',
      'SIMULATION_FAILED',
      'INVALID_AMOUNT',
      'INVALID_RECEIVER',
      'TRANSACTION_FAILED',
      'DELEGATION_INVALID',
    ];
```

**Después**:
```ts
    const expected: X402ErrorCode[] = [
      'INVALID_SIGNATURE',
      'INSUFFICIENT_BALANCE',
      'PERMIT2_ALLOWANCE_REQUIRED',
      'EXPIRED_AUTHORIZATION',
      'NETWORK_MISMATCH',
      'SIMULATION_FAILED',
      'INVALID_AMOUNT',
      'INVALID_RECEIVER',
      'TRANSACTION_FAILED',
      'DELEGATION_INVALID',
      'CHAIN_UNAVAILABLE',
    ];
```

El assert `uniqueHttpFromMap` (línea 190) se **actualiza automáticamente** a `[400,401,402,412,500,503]` porque deriva de `Object.values(HTTP_BY_CODE)` — **no** hardcodear el array allí.

Si el título del `it(...)` línea 165 menciona literal `"all 10 codes"`, actualizar a `"all 11 codes"`.

**Checklist W1.7**:

- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/__tests__/unit/routes.openapi.test.ts` → **≥1 match** (en el `expected` array).
- [ ] El test corre verde tras la actualización del YAML (W1.4) y del Record (W1.2).

#### Wave 1 — dependencies

- Depende de W0 (cockatiel instalado — aunque W1 no lo usa, typecheck completo debe seguir verde).
- NO depende de W2/W3/W4.

#### Wave 1 — completion criteria

- [ ] `npm run typecheck` green (todo el cascade `X402ErrorCode` + Records + OpenAPI + tests).
- [ ] `npm run lint` green (max-warnings 0).
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/core/types.ts src/core/errors.ts src/infra/env.ts src/__tests__/unit/core/errors.test.ts src/__tests__/unit/routes.openapi.test.ts src/__tests__/unit/env.test.ts`; **CD-LESSON-6**).
- [ ] `npm test -- --run` → ≥ 435 + **los asserts 10→11 actualizados** + **≥10 tests nuevos** (≥7 env + ≥3 errors) → **≥445 verdes**.
- [ ] **Regression guard CRÍTICO errors.test.ts**: los 2 asserts `toHaveLength(10)` **DEBEN** estar en `11`. Esto **NO es regresión** — es el contrato del HU. Si un grep encuentra `toHaveLength(10)` en ese archivo tras W1 → **STOP + fix**.
- [ ] Los tests WFAC-20/21/22/23/32/33/40 previos **todos verdes** (agregar un valor al union NO rompe nada — el route layer hace passthrough del code).
- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/core/types.ts` → **exactly 1 match**.
- [ ] `grep -c "CHAIN_UNAVAILABLE" src/core/errors.ts` → **exactly 2 matches** (1 HTTP, 1 default message) + cualquier JSDoc.
- [ ] `grep -c "CHAIN_UNAVAILABLE" doc/openapi.yaml` → **exactly 1 match**.
- [ ] `grep -nE "CB_(ENABLED|FAILURE_THRESHOLD|ROLLING_WINDOW_MS|RESET_TIMEOUT_MS)" src/infra/env.ts` → **exactly 4 matches**.
- [ ] `grep -n "z.coerce.boolean" src/infra/env.ts` → **zero matches** (**CD-NEW-CB-BOOL**).

**Commit sugerido**:
```
feat(WFAC-41): W1 types/errors/env/openapi cascade CHAIN_UNAVAILABLE
```

---

### Wave 2 (SERIAL) — `ChainCircuitBreaker` class + metrics + tests

**Objetivo**: breaker funcional en aislamiento. Listo para integración. Aislado — no toca adapters ni routes.

#### Files (W2)

| # | Path | Acción |
|---|------|--------|
| 10 | `src/chains/circuit-breaker.ts` | **CREATE** |
| 11 | `src/__tests__/unit/chains/circuit-breaker.test.ts` | **CREATE** |

#### W2.1 — `src/chains/circuit-breaker.ts` (NEW)

**Acción**: crear el módulo. Pure API pública: `ChainCircuitBreaker` class + `BreakerOpenError` + helpers `readCbNumber`/`readCbBool` + metrics singletons.

**Imports permitidos** (CD-CHAIN-OWNERS):

```ts
import {
  circuitBreaker,
  ConsecutiveBreaker,
  SamplingBreaker,
  handleAll,
  CircuitState,
  BrokenCircuitError,
  type IPolicy,
  type CircuitBreakerPolicy,
} from 'cockatiel';
import { Counter, Gauge, register as defaultRegister } from 'prom-client';
import type { Counter as PromCounter, Gauge as PromGauge } from 'prom-client';
import type { Logger } from 'pino';
```

**Imports PROHIBIDOS (runtime)**: `src/core/*` (types, errors, schemas, etc.), `src/routes/*`, `src/methods/*`, `src/infra/*`. **CD-CHAIN-OWNERS**.

**Exports obligatorios**:

```ts
export type BreakerStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ChainCircuitBreakerOptions {
  readonly chainId: number;
  readonly chainName: string;
  readonly failureThreshold: number;
  readonly rollingWindowMs: number;
  readonly resetTimeoutMs: number;
  readonly enabled: boolean;
  readonly logger?: Logger;
}

export class BreakerOpenError extends Error {
  public readonly chainId: number;
  public readonly remainingMs: number;
  constructor(chainId: number, remainingMs: number);
}

export class ChainCircuitBreaker {
  constructor(opts: ChainCircuitBreakerOptions);
  execute<T>(fn: () => Promise<T>): Promise<T>;
  recordBusinessFailure(reason: string): void;
  getState(): BreakerStateName;
  getRemainingOpenMs(): number;
  setLogger(logger: Logger): void;
}

// Helpers exported for adapter consumers:
export function readCbNumber(name: string, fallback: number): number;
export function readCbBool(name: string, fallback: boolean): boolean;
```

**Comportamiento requerido**:

1. **`ChainCircuitBreaker` constructor**:
   - Compone cockatiel policy: `circuitBreaker(handleAll, { halfOpenAfter: opts.resetTimeoutMs, breaker: new SamplingBreaker({ threshold: 0.5, duration: opts.rollingWindowMs, minimumRps: Math.max(0.001, opts.failureThreshold / Math.max(1, opts.rollingWindowMs / 1000)) }) })`.
   - Subscribe a `onStateChange`, `onBreak`, `onReset`, `onHalfOpen` → emite `warn` logs con `{ chainId, chainName, fromState, toState, failureCount? }` + actualiza métricas.
   - Cuando `opts.enabled === false`: construye una policy **passthrough** (CD-NEW-CB-ENABLED-FALSE) — no invoca cockatiel, no mantiene estado, no emite métricas.

2. **`execute<T>(fn)`**:
   - Si `enabled === false` → `return fn()` directo (sin try/catch, sin métricas, sin logs). **CD-NEW-CB-ENABLED-FALSE**.
   - Si `enabled === true`:
     - Catchea `BrokenCircuitError` de cockatiel → throw `BreakerOpenError(chainId, remainingMs)`.
     - Otras excepciones que vienen de `fn()` se propagan (cockatiel las cuenta como failure y las re-throw).
   - **CD-NEW-CB-TRANSLATE**: `BrokenCircuitError` **NUNCA** sale de este módulo — siempre se traduce a `BreakerOpenError`.

3. **`recordBusinessFailure(reason)`**:
   - Si `enabled === false` → **no-op** (CD-NEW-CB-ENABLED-FALSE).
   - Si `enabled === true` → incrementa el contador interno del breaker (llamando `policy.execute(() => Promise.reject(new Error(reason)))` envuelto en try/catch local para que NO se propague la excepción simulada al caller, **O** usando la API interna de `SamplingBreaker` si está disponible). Método más seguro: construir una función dummy que throw y atraparla:
     ```ts
     recordBusinessFailure(reason: string): void {
       if (!this._enabled) return;
       // Feed the breaker one failure without invoking a real fn.
       this._policy.execute(async () => { throw new Error(`business failure: ${reason}`); }).catch(() => {
         // swallow — we intentionally triggered this failure.
       });
       cbFailuresTotal.inc({ chain: this._chainName, chain_id: String(this._chainId), reason });
     }
     ```
   - Incrementa `cbFailuresTotal` con label `reason` (e.g. `'SIMULATION_FAILED'`, `'TRANSACTION_FAILED'`).

4. **`getState()`**: mapea `CircuitState.Closed → 'CLOSED'`, `Open → 'OPEN'`, `HalfOpen → 'HALF_OPEN'`, `Isolated → 'OPEN'`. Si `enabled === false` → retorna `'CLOSED'` siempre.

5. **`getRemainingOpenMs()`**: si state !== OPEN → retorna 0. Si OPEN → calcula `(breakOpenAtMs + resetTimeoutMs) - Date.now()` con floor 0. Captura el timestamp del `onBreak` event en un private field.

6. **`setLogger(logger)`**: asigna `this._logger = logger`. Idempotente.

7. **`BreakerOpenError`**: extends `Error`, nombre `'BreakerOpenError'`, expone `chainId` y `remainingMs` public readonly.

**Helpers** (CD-NEW-CB-HELPER-DEFAULTS — defaults IDÉNTICOS a los del Zod schema):

```ts
// eslint-disable-next-line security/detect-object-injection -- `name` is a caller-controlled literal from the hardcoded set { CB_FAILURE_THRESHOLD, CB_ROLLING_WINDOW_MS, CB_RESET_TIMEOUT_MS }.
export function readCbNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// eslint-disable-next-line security/detect-object-injection -- same rationale as readCbNumber.
export function readCbBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}
```

**Metrics singletons** (CD-NEW-CB-METRICS-IDEMPOTENT — tolerar `vi.resetModules()`):

```ts
function registerOrGetCounter(name: string, factory: () => PromCounter<string>): PromCounter<string> {
  const existing = defaultRegister.getSingleMetric(name);
  if (existing) return existing as PromCounter<string>;
  return factory();
}

function registerOrGetGauge(name: string, factory: () => PromGauge<string>): PromGauge<string> {
  const existing = defaultRegister.getSingleMetric(name);
  if (existing) return existing as PromGauge<string>;
  return factory();
}

const cbStateGauge = registerOrGetGauge('cb_state', () => new Gauge({
  name: 'cb_state',
  help: 'Circuit breaker state per chain (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['chain', 'chain_id'],
}));

const cbFailuresTotal = registerOrGetCounter('cb_failures_total', () => new Counter({
  name: 'cb_failures_total',
  help: 'Total failures counted toward circuit breaker (per chain)',
  labelNames: ['chain', 'chain_id', 'reason'],
}));

const cbTransitionsTotal = registerOrGetCounter('cb_transitions_total', () => new Counter({
  name: 'cb_transitions_total',
  help: 'Circuit breaker state transitions (per chain + direction)',
  labelNames: ['chain', 'chain_id', 'from_state', 'to_state'],
}));
```

**Update points**:
- `onStateChange(newState)` handler: `cbStateGauge.set({chain, chain_id}, code)` + `cbTransitionsTotal.inc({chain, chain_id, from_state, to_state})`.
- `recordBusinessFailure(reason)`: `cbFailuresTotal.inc({chain, chain_id, reason})`.
- En el catch interno de `execute` cuando el fn throws (RPC fail): `cbFailuresTotal.inc({chain, chain_id, reason: 'rpc_error'})`.

**Mapping gauge**:
- CLOSED → 0, HALF_OPEN → 1, OPEN → 2, Isolated → 2.

**Log warn en transiciones (AC-8)**:
```ts
this._logger?.warn(
  {
    chainId: this._chainId,
    chainName: this._chainName,
    fromState: oldStateName,
    toState: newStateName,
    failureCount: this._currentFailureCount,  // o `probeResult` en HALF_OPEN→CLOSED/OPEN
  },
  'circuit breaker state transition',
);
```

**Checklist W2.1**:

- [ ] El archivo existe en `src/chains/circuit-breaker.ts`.
- [ ] `grep -cE "^import .* from '\\.\\./(core|routes|methods|infra)/'" src/chains/circuit-breaker.ts` → **zero matches** (runtime). Solo `cockatiel`, `prom-client`, `pino` (type-only permitido).
- [ ] Exports declarados: `BreakerStateName`, `ChainCircuitBreakerOptions`, `BreakerOpenError`, `ChainCircuitBreaker`, `readCbNumber`, `readCbBool`.
- [ ] Named imports de cockatiel **explícitos** (no `import * as cockatiel from 'cockatiel'`) — **CD-NEW-CB-COCKA-NAMED**.
- [ ] `new Gauge(...)` / `new Counter(...)` envueltos en `registerOrGet` helpers (**CD-NEW-CB-METRICS-IDEMPOTENT**).
- [ ] `BrokenCircuitError` se catchea y traduce a `BreakerOpenError` (**CD-NEW-CB-TRANSLATE**).
- [ ] Cuando `enabled=false`, NI `execute`, NI `recordBusinessFailure`, NI state transitions tocan métricas/logs (**CD-NEW-CB-ENABLED-FALSE**).
- [ ] **NO ejemplos literales de threshold/timeout en JSDoc** (**CD-LESSON-5**: JSDoc prosa, no literales numéricos realistas que dispararán `no-secrets/no-secrets` false-positive).

#### W2.2 — `src/__tests__/unit/chains/circuit-breaker.test.ts` (NEW)

**Acción**: ≥11 tests del state machine + metrics + logger + passthrough + independence.

**Imports típicos**:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChainCircuitBreaker,
  BreakerOpenError,
  readCbNumber,
  readCbBool,
} from '../../../chains/circuit-breaker.js';
```

**Tests requeridos (IDs T-CB-*, ≥11)**:

- **T-CB-1 (AC-1 baseline CLOSED)**: construir `new ChainCircuitBreaker({chainId: 9001, chainName:'Test', failureThreshold:3, rollingWindowMs:10000, resetTimeoutMs:5000, enabled:true})` → `getState() === 'CLOSED'`. `await cb.execute(async () => 42)` → returns 42.
- **T-CB-2 (AC-1 → OPEN tras N fallos)**: usar `vi.useFakeTimers()`. Ejecutar N fns que rejecten con `new Error('rpc fail')` de manera suficiente para disparar threshold 50% en rolling window (p.ej. 5 failures en <=3s con `minimumRps` derivado). Tras los fails → `getState() === 'OPEN'` + `cbStateGauge` labelvalue 2.
- **T-CB-3 (AC-2 OPEN fast-fail)**: con breaker en OPEN (del test anterior o re-setup) → `await cb.execute(async () => 42)` → rejects con `BreakerOpenError`. La función NO se invoca (usar `vi.fn()` spy).
- **T-CB-4 (AC-3 OPEN → HALF_OPEN)**: con breaker OPEN, `vi.advanceTimersByTime(resetTimeoutMs + 1)` → el siguiente `execute(fn)` invoca `fn` (probe) y el state tras la invocación (before settlement) es HALF_OPEN o HALF_OPEN→CLOSED/OPEN.
- **T-CB-5 (AC-4 HALF_OPEN success → CLOSED)**: probe en HALF_OPEN que resuelve OK → `getState()` pasa a 'CLOSED' + `onReset` evento fires + log warn con `fromState:'HALF_OPEN', toState:'CLOSED'`.
- **T-CB-6 (AC-5 HALF_OPEN fail → OPEN + timer restart)**: probe en HALF_OPEN que rejecta → state vuelve a OPEN + `getRemainingOpenMs()` retorna ~`resetTimeoutMs` (timer reiniciado).
- **T-CB-7 (AC-6 CB_ENABLED=false passthrough)**: `new ChainCircuitBreaker({..., enabled: false})`. Simular 100 failures consecutivos (cada uno `await cb.execute(async () => { throw new Error('x'); }).catch(()=>{})`). `getState() === 'CLOSED'` sigue. Ningún cbStateGauge update (verificar con `cbStateGauge.get({chain, chain_id}).values` — debe ser vacío o undefined).
- **T-CB-8 (AC-7 independence — 2 instances)**: crear `cbA = new CB(chainId:1, ...)` y `cbB = new CB(chainId:2, ...)`. Abrir `cbA` (forzar N fails). `cbA.getState() === 'OPEN'`, `cbB.getState() === 'CLOSED'`. `cbB.execute(fn)` funciona normal.
- **T-CB-9 (AC-13 recordBusinessFailure cuenta)**: `cb.recordBusinessFailure('SIMULATION_FAILED')` N veces → eventually `getState() === 'OPEN'`. Verificar `cbFailuresTotal.hashMap[...labels...reason=SIMULATION_FAILED].value` ≥ N.
- **T-CB-10 (AC-12 metrics populated)**: tras una transición CLOSED → OPEN, `cbStateGauge.get()` tiene value `2` con labels `chain: 'Test', chain_id: '9001'`. `cbTransitionsTotal` tiene entry con `from_state:'CLOSED', to_state:'OPEN'` value ≥1.
- **T-CB-11 (AC-8 logger injection + log payload shape)**: mock logger `{ warn: vi.fn() }`. `cb.setLogger(mockLogger)`. Forzar transición CLOSED → OPEN. Assert `mockLogger.warn` llamado ≥1 vez con `expect.objectContaining({ chainId: 9001, fromState: 'CLOSED', toState: 'OPEN' })` + 2do arg `'circuit breaker state transition'`. **Sin PII** — no incluye request-level info.
- **T-CB-12 (BONUS — BreakerOpenError shape)**: cuando OPEN dispara fast-fail, el `BreakerOpenError.remainingMs` es `> 0` y `≤ resetTimeoutMs`. `err.chainId === 9001`. `err.name === 'BreakerOpenError'`.
- **T-CB-13 (BONUS — readCbNumber/Bool helpers)**: `process.env.TEST_CB_FAKE = '7'` → `readCbNumber('TEST_CB_FAKE', 5) === 7`. `process.env.TEST_CB_FAKE = 'abc'` → `5` (fallback). `readCbBool('TEST_CB_FAKE_BOOL', true)` con env `'false'` → `false`; con env `'nope'` → `true` (fallback). Cleanup `delete process.env[...]` en afterEach.

**Total tests nuevos: ≥11** (T-CB-1 a T-CB-11; T-CB-12/13 opcionales recomendados).

**Reglas críticas (tests W2)**:

- [ ] **CD-LESSON-6**: correr `npx prettier --write src/__tests__/unit/chains/circuit-breaker.test.ts` antes de format:check.
- [ ] Los tests que tocan métricas **deben** leer desde `defaultRegister.getSingleMetric('cb_state')` (mismo register que usa el module — **CD-NEW-CB-METRICS-IDEMPOTENT**).
- [ ] Cleanup de registry entre tests: en `beforeEach` **NO** clear — los metrics deben persistir por module singleton. Si un test necesita "fresh", crear CBs con distintos labels (`chain_id` único). **NO** llamar `defaultRegister.clear()` (rompería otros tests si corrieran en paralelo).
- [ ] Usar `vi.useFakeTimers()` en los tests de transition (T-CB-2, T-CB-4, T-CB-6) + `vi.useRealTimers()` en afterEach.
- [ ] **NO** importar `src/core/*` en el test (no hace falta — todo lo que tocamos vive en `src/chains/circuit-breaker.ts`).

#### Wave 2 — dependencies

- Depende de W0 (cockatiel instalado) + W1 (CHAIN_UNAVAILABLE en union — aunque W2 no emite ese código, el typecheck debe estar green).
- NO depende de W3/W4.

#### Wave 2 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm test -- --run` → baseline W1 (~445) + ≥11 tests nuevos → **≥456 verdes**.
- [ ] `grep -c "from 'cockatiel'" src/chains/circuit-breaker.ts` → **exactly 1 match**.
- [ ] `grep -c "from 'prom-client'" src/chains/circuit-breaker.ts` → **exactly 1 match**.
- [ ] `grep -nE "^import .* from '\\.\\./(core|infra|routes|methods)/" src/chains/circuit-breaker.ts` → **zero matches** (**CD-CHAIN-OWNERS**).
- [ ] `grep -c "BrokenCircuitError" src/chains/circuit-breaker.ts` → ≥1 (imported) + ≥1 en el catch/translate.
- [ ] `grep -c "export class ChainCircuitBreaker" src/chains/circuit-breaker.ts` → **exactly 1**.

**Commit sugerido**:
```
feat(WFAC-41): W2 ChainCircuitBreaker class + metrics + 11 unit tests
```

---

### Wave 3 (SERIAL) — Adapter integration (Kite + Avalanche)

**Objetivo**: `verify`/`settle` de ambos adapters wrappeados. `getBreakerState()` expuesto. `setLogger()` expuesto. Sin cambios observables a consumers del `ChainAdapter` interface salvo los 2 métodos opcionales nuevos.

#### Files (W3)

| # | Path | Acción |
|---|------|--------|
| 12 | `src/chains/types.ts` | **MODIFY** |
| 13 | `src/chains/kite.ts` | **MODIFY** |
| 14 | `src/chains/avalanche.ts` | **MODIFY** |
| 15 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (append) |

#### W3.1 — `src/chains/types.ts`

**Acción**: 2 cambios a `ChainAdapter` + 1 a `ChainMetadata`.

**`ChainAdapter` interface** (líneas 117-123): agregar 2 métodos opcionales al final. **MANTIENE los 5 miembros existentes**.

**Antes**:
```ts
export interface ChainAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  getPublicClient(): PublicClient;
  getWalletClient(): WalletClient;
}
```

**Después**:
```ts
import type { Logger } from 'pino';  // type-only — OWNERS allows

// ... existing code ...

export interface ChainAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  getPublicClient(): PublicClient;
  getWalletClient(): WalletClient;
  /**
   * WFAC-41 — optional introspection: current circuit breaker state for
   * this chain. Adapters that wrap verify/settle with ChainCircuitBreaker
   * (KiteAdapter, AvalancheFujiAdapter) expose this; stubs without breakers
   * may omit. Consumer (core/supported.ts) uses `typeof adapter.getBreakerState
   * === 'function'` before calling.
   */
  getBreakerState?(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /**
   * WFAC-41 — optional logger injection (ducktype at buildApp init via
   * src/chains/init-breakers.ts). Adapters that own a ChainCircuitBreaker
   * forward the call to `breaker.setLogger(logger)`.
   */
  setLogger?(logger: Logger): void;
}
```

**`ChainMetadata` interface** (líneas 34-47): agregar opcional `breakerState?` al final.

**Antes**:
```ts
export interface ChainMetadata {
  readonly chainId: ChainId;
  readonly name: string;
  readonly network: 'mainnet' | 'testnet';
  readonly networkId: string;
  readonly rpcUrl: string;
  readonly blockExplorer?: string;
  readonly nativeCurrency: { ... };
  readonly tokens: readonly EIP3009Token[];
}
```

**Después**:
```ts
export interface ChainMetadata {
  readonly chainId: ChainId;
  readonly name: string;
  readonly network: 'mainnet' | 'testnet';
  readonly networkId: string;
  readonly rpcUrl: string;
  readonly blockExplorer?: string;
  readonly nativeCurrency: { ... };
  readonly tokens: readonly EIP3009Token[];
  /**
   * WFAC-41 (DT-7) — optional: current CB state exposed in /supported response.
   * Omitted (NOT undefined) when `CB_ENABLED=false` or adapter has no breaker.
   * Populated lazily by `src/core/supported.ts` via `adapter.getBreakerState?.()`.
   */
  readonly breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}
```

**Checklist W3.1**:

- [ ] Los 5 miembros originales de `ChainAdapter` **intactos**.
- [ ] `getBreakerState?` y `setLogger?` con signo `?` (optional — NO hacer required; rompe stubs).
- [ ] `ChainMetadata.breakerState?` es el ÚLTIMO campo + opcional.
- [ ] `import type { Logger } from 'pino';` agregado arriba — **type-only** (OWNERS lo permite).

#### W3.2 — `src/chains/kite.ts`

**Acción**: refactor del adapter sin cambiar el comportamiento observable de los stubs (NETWORK_MISMATCH sigue siendo NETWORK_MISMATCH hoy). Agregar breaker wrap + `setLogger` + `getBreakerState`.

**Cambios**:

1. **Imports nuevos**:
```ts
import type { Logger } from 'pino';
import {
  ChainCircuitBreaker,
  BreakerOpenError,
  readCbNumber,
  readCbBool,
  type BreakerStateName,
} from './circuit-breaker.js';
```

2. **Clase `KiteAdapter`** — agregar private field `_breaker`:
```ts
class KiteAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _viemChain: Chain;
  private readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;  // NEW

  constructor(opts: { ... }) {
    this._rpcUrl = readEnv(opts.envVarName, opts.chainIdNum);
    this._viemChain = defineChain({ ... });  // UNCHANGED
    this.metadata = { ... };  // UNCHANGED

    // WFAC-41 — per-chain circuit breaker. Thresholds from env with
    // hardcoded defaults matching the Zod schema in src/infra/env.ts
    // (CD-NEW-CB-HELPER-DEFAULTS). Logger injected later via setLogger()
    // from initChainBreakers() in src/chains/init-breakers.ts.
    this._breaker = new ChainCircuitBreaker({
      chainId: opts.chainIdNum,
      chainName: opts.name,
      failureThreshold: readCbNumber('CB_FAILURE_THRESHOLD', 5),
      rollingWindowMs: readCbNumber('CB_ROLLING_WINDOW_MS', 30000),
      resetTimeoutMs: readCbNumber('CB_RESET_TIMEOUT_MS', 10000),
      enabled: readCbBool('CB_ENABLED', true),
    });
  }

  // ... getPublicClient / getWalletClient UNCHANGED ...

  setLogger(logger: Logger): void {
    this._breaker.setLogger(logger);
  }

  getBreakerState(): BreakerStateName {
    return this._breaker.getState();
  }

  // ── verify split ────────────────────────────────────────────────────────

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
            retryAfterMs: err.remainingMs,
          },
        };
      }
      // Defense-in-depth: unknown throw — translate to adapter error.
      throw err;
    }
  }

  private async _verifyRaw(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    // CURRENT STUB BODY — unchanged from pre-WFAC-41 verify():
    const result: AdapterResult<VerifyResult> = {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Verify not implemented yet (WFAC-10)',
        http: 400,
      },
    };
    // AC-13: count business failures toward CB.
    if (!result.ok && (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
      this._breaker.recordBusinessFailure(result.error.code);
    }
    return result;
  }

  // ── settle split (mirror of verify) ─────────────────────────────────────

  async settle(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    try {
      return await this._breaker.execute(() => this._settleRaw(params));
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        return {
          ok: false,
          error: {
            code: 'CHAIN_UNAVAILABLE',
            message: 'Chain RPC temporarily unavailable',
            http: 503,
            retryAfterMs: err.remainingMs,
          },
        };
      }
      throw err;
    }
  }

  private async _settleRaw(_params: SettleParams): Promise<AdapterResult<SettleResult>> {
    const result: AdapterResult<SettleResult> = {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Settle not implemented yet (WFAC-11)',
        http: 400,
      },
    };
    if (!result.ok && (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
      this._breaker.recordBusinessFailure(result.error.code);
    }
    return result;
  }
}
```

3. **Singletons top-level** (líneas 128-140): **NO cambian** — el constructor sigue recibiendo los mismos opts. El breaker se crea dentro del constructor.

**Checklist W3.2**:

- [ ] El body semántico del stub NO cambia — `verify`/`settle` de kite siguen retornando NETWORK_MISMATCH (AC-13 solo cuenta SIMULATION_FAILED/TRANSACTION_FAILED, los stubs no disparan CB).
- [ ] `grep -c "_verifyRaw\\|_settleRaw" src/chains/kite.ts` → **exactly 4 matches** (declaración + invocación en verify + declaración + invocación en settle).
- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/chains/kite.ts` → **exactly 2 matches** (1 en verify wrap, 1 en settle wrap).
- [ ] `grep -c "BreakerOpenError" src/chains/kite.ts` → ≥3 matches (import + 2 `instanceof` checks).
- [ ] `grep -c "recordBusinessFailure" src/chains/kite.ts` → ≥2 matches (1 en `_verifyRaw`, 1 en `_settleRaw`).
- [ ] `setLogger` y `getBreakerState` exportados como métodos de la clase.
- [ ] **NO importar `src/core/*` runtime** desde `kite.ts` (**CD-CHAIN-OWNERS** — solo `../core/types.js` type-only ya existente línea 33).

#### W3.3 — `src/chains/avalanche.ts`

**Idéntico patrón** al W3.2. Mismas reglas.

El constructor de `AvalancheFujiAdapter` no recibe opts — el chainId (43113) y chainName ('Avalanche Fuji') son constantes hardcoded. Al crear el breaker:

```ts
this._breaker = new ChainCircuitBreaker({
  chainId: FUJI_CHAIN_ID,
  chainName: 'Avalanche Fuji',
  failureThreshold: readCbNumber('CB_FAILURE_THRESHOLD', 5),
  rollingWindowMs: readCbNumber('CB_ROLLING_WINDOW_MS', 30000),
  resetTimeoutMs: readCbNumber('CB_RESET_TIMEOUT_MS', 10000),
  enabled: readCbBool('CB_ENABLED', true),
});
```

**Checklist W3.3**: igual que W3.2 — mismos greps, mismo comportamiento.

#### W3.4 — `src/__tests__/unit/chain-adapter.test.ts` (APPEND)

**Acción**: agregar ≥5 tests nuevos al final del archivo. Usar `vi.resetModules()` + dynamic import igual que tests existentes.

**Tests requeridos (IDs T-ADAPT-CB-*)**:

- **T-ADAPT-CB-1 (AC-9 expose getBreakerState)**: `const mod = await import('../../chains/kite.js'); expect(typeof mod.kiteTestnetAdapter.getBreakerState).toBe('function'); expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');`.
- **T-ADAPT-CB-2 (AC-1/AC-2 force OPEN + CHAIN_UNAVAILABLE)**: mock interno del `_verifyRaw` para simular N fallos (alternativa: usar `recordBusinessFailure` del breaker que está accesible). Tras N failures que disparan threshold → `await mod.kiteTestnetAdapter.verify(fakeParams)` retorna `{ok:false, error:{code:'CHAIN_UNAVAILABLE', http:503, retryAfterMs: expect.any(Number)}}`. **Cuidado**: los stubs actuales retornan NETWORK_MISMATCH (no cuenta). Para forzar state OPEN, accede al breaker interno vía el CB instance internals **O** simplifica con `SIMULATION_FAILED` stub override. La opción más simple: ANTES del test, llamar manualmente `breaker.recordBusinessFailure('SIMULATION_FAILED')` N veces → eso abre el breaker. Pero el breaker es privado. **Alternativa práctica**: agregar un test de alto nivel que verifique el mapping `BreakerOpenError → CHAIN_UNAVAILABLE` sin forzar la apertura real — construir una instancia de `ChainCircuitBreaker` manualmente en el test con threshold muy bajo y feedar-la con failures. Este test verifica solo el mapping; los tests de W2 ya cubren el state machine. Redactar el test como:
    ```ts
    it('T-ADAPT-CB-2 (AC-1/AC-2): verify returns CHAIN_UNAVAILABLE 503 when breaker is OPEN', async () => {
      // Force low threshold via env override BEFORE dynamic import:
      process.env.CB_FAILURE_THRESHOLD = '2';
      process.env.CB_ROLLING_WINDOW_MS = '1000';
      vi.resetModules();
      const mod = await import('../../chains/kite.js');
      // Feed 5 SIMULATION_FAILED business failures via access to breaker (exposed via module-internal testing hatch, or use vi.spyOn on _verifyRaw private — SEE WORKAROUND BELOW).
      // Workaround: cast to any to call the internal field (limited to test).
      const adapter = mod.kiteTestnetAdapter as unknown as { _breaker: { recordBusinessFailure: (r: string) => void; getState: () => string }; verify: (p: unknown) => Promise<unknown> };
      for (let i = 0; i < 10; i++) adapter._breaker.recordBusinessFailure('SIMULATION_FAILED');
      // After enough failures, breaker flips to OPEN.
      // (If state machine requires wall-clock timing, use vi.useFakeTimers + vi.advanceTimersByTime.)
      expect(adapter._breaker.getState()).toBe('OPEN');
      const result = await adapter.verify({} as never);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'CHAIN_UNAVAILABLE',
          http: 503,
        },
      });
      expect((result as { error: { retryAfterMs?: number } }).error.retryAfterMs).toBeGreaterThan(0);
    });
    ```
- **T-ADAPT-CB-3 (AC-7 independence kite vs avalanche)**: import `kite.ts` y `avalanche.ts`. Abrir breaker kite (como T-ADAPT-CB-2). `kiteTestnetAdapter.getBreakerState!() === 'OPEN'` pero `avalancheFujiAdapter.getBreakerState!() === 'CLOSED'`.
- **T-ADAPT-CB-4 (AC-13 recordBusinessFailure path)**: unit-level del adapter — spy sobre el método `_breaker.recordBusinessFailure` (via cast a `any`). Hacer que `_verifyRaw` retorne `{ok:false, error:{code:'SIMULATION_FAILED', ...}}` (mock del stub vía `vi.spyOn(adapter as any, '_verifyRaw').mockResolvedValue({ok:false, error:{code:'SIMULATION_FAILED', message:'x', http:500}})`). Llamar `adapter.verify(fakeParams)` → spy llamado 1 vez con `'SIMULATION_FAILED'`.
- **T-ADAPT-CB-5 (AC-6 CB_ENABLED=false passthrough)**: `process.env.CB_ENABLED='false'; vi.resetModules();` → `const mod = await import('../../chains/kite.js')`. Forzar N failures (como en T-ADAPT-CB-2) → `adapter.getBreakerState!() === 'CLOSED'` aún tras 100 fails. `adapter.verify(fakeParams)` NO retorna CHAIN_UNAVAILABLE.

**Total tests nuevos en chain-adapter.test.ts: ≥5** (T-ADAPT-CB-1 a T-ADAPT-CB-5).

**Checklist W3.4**:

- [ ] **Regression CRÍTICO**: los tests existing de `chain-adapter.test.ts` (13 tests WFAC-3) siguen TODOS verdes. Si uno rompe → el refactor del adapter en W3.2/W3.3 NO es transparent, y la HU tiene un bug. **STOP + diagnose inmediato**.
- [ ] `grep -c "CHAIN_UNAVAILABLE" src/__tests__/unit/chain-adapter.test.ts` → **≥1 match**.
- [ ] Los tests usan `vi.resetModules()` en `beforeEach` para aislar process.env entre casos.
- [ ] `process.env.CB_*` setters en tests están acompañados de cleanup en `afterEach` (o via `snapshotEnv`/`restoreEnv` existing).

#### Wave 3 — dependencies

- Depende de W2 (`ChainCircuitBreaker` class + `BreakerOpenError` + helpers).
- Consume types extendidos de W1 (`CHAIN_UNAVAILABLE`, `retryAfterMs`).

#### Wave 3 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm test -- --run` → ≥456 (W2) + ≥5 tests adapter nuevos → **≥461 verdes**.
- [ ] **Regression guard CRÍTICO WFAC-20/21/32/33**: los tests de `routes.verify.test.ts`, `routes.settle.test.ts`, `routes.supported.test.ts`, `chain-adapter.test.ts` (originales), `ledger.test.ts`, `audit.test.ts` siguen **TODOS verdes**. El wrapping del adapter DEBE ser transparente para estos tests — los stubs siguen retornando NETWORK_MISMATCH. Si **cualquier** test WFAC-20/21 rompe post-W3 → **STOP**: el wrapping NO es transparent, bug de refactor.
- [ ] `grep -n "CHAIN_UNAVAILABLE" src/chains/kite.ts src/chains/avalanche.ts` → **exactly 4 matches** (2 por archivo — verify + settle wraps).
- [ ] `grep -n "_verifyRaw\\|_settleRaw" src/chains/kite.ts src/chains/avalanche.ts` → **exactly 8 matches** (2 private methods + 2 invocations por archivo × 2 archivos).
- [ ] `grep -n "getBreakerState" src/chains/kite.ts src/chains/avalanche.ts src/chains/types.ts` → **≥3 matches**.
- [ ] `grep -nE "^import .* from '\\.\\./core/" src/chains/kite.ts src/chains/avalanche.ts` → solo `../core/types.js` (type-only) — **CD-CHAIN-OWNERS**.

**Commit sugerido**:
```
feat(WFAC-41): W3 adapter integration Kite + Avalanche (breaker wrap + setLogger + getBreakerState)
```

---

### Wave 4 (SERIAL) — App init + routes Retry-After + supported breakerState

**Objetivo**: todo integrado. `initChainBreakers` inyecta loggers. Routes emiten `Retry-After` header en 503. `/supported` expone `breakerState` per chain.

#### Files (W4)

| # | Path | Acción |
|---|------|--------|
| 16 | `src/chains/init-breakers.ts` | **CREATE** |
| 17 | `src/app.ts` | **MODIFY** (+ import + llamada) |
| 18 | `src/routes/verify.ts` | **MODIFY** (Retry-After header) |
| 19 | `src/routes/settle.ts` | **MODIFY** (Retry-After header) |
| 20 | `src/core/supported.ts` | **MODIFY** (breakerState field) |
| 21 | `src/__tests__/unit/routes.verify.test.ts` | **MODIFY** (append tests) |
| 22 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (append tests) |
| 23 | `src/__tests__/unit/routes.supported.test.ts` | **MODIFY** (append tests) |
| 24 | `src/__tests__/unit/chains/init-breakers.test.ts` | **CREATE** |

#### W4.1 — `src/chains/init-breakers.ts` (NEW)

**Acción**: helper ducktype `initChainBreakers(logger)` que itera el registry e inyecta el logger sobre cada adapter que expone `setLogger`.

**Imports permitidos**:
```ts
import type { Logger } from 'pino';
import { chainRegistry } from './registry.js';
```

**Código**:
```ts
/**
 * WFAC-41 — logger injection for per-chain circuit breakers (DT-11 SDD).
 *
 * Called once from `src/app.ts` `buildApp()` AFTER adapter registration
 * (registry populated) and BEFORE route handlers start serving traffic.
 *
 * Ducktype over `setLogger(logger)`: adapters that own a ChainCircuitBreaker
 * (KiteAdapter, AvalancheFujiAdapter) expose the method; adapters without
 * breakers silently skip.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import: `./registry.js` (sibling), `pino` (type-only).
 *   - MUST NOT import: `src/core/*` runtime, `src/routes/*`, `src/methods/*`,
 *                      `src/infra/*`.
 */

import type { Logger } from 'pino';
import { chainRegistry } from './registry.js';

export function initChainBreakers(logger: Logger): void {
  for (const metadata of chainRegistry.listAdapters()) {
    const lookup = chainRegistry.getAdapter(metadata.chainId);
    if (!lookup.ok) continue;
    const adapter = lookup.adapter;
    if (typeof (adapter as { setLogger?: (l: Logger) => void }).setLogger === 'function') {
      (adapter as { setLogger: (l: Logger) => void }).setLogger(logger);
    }
  }
}
```

**Checklist W4.1**:

- [ ] El archivo existe en `src/chains/init-breakers.ts`.
- [ ] Export único: `initChainBreakers`.
- [ ] `grep -nE "^import .* from '\\.\\./(core|infra|routes|methods)/" src/chains/init-breakers.ts` → **zero matches** (runtime).
- [ ] **NO** throw — si `setLogger` no existe sobre un adapter, silently skip.
- [ ] **NO** side effects más allá de llamar `setLogger` — no logs propios, no métricas.

#### W4.2 — `src/app.ts` (MODIFY)

**Acción**: 2 cambios atómicos.

1. **Imports** (al bloque superior, junto a los existentes):
```ts
import { initChainBreakers } from './chains/init-breakers.js';
```

2. **Llamada** dentro de `buildApp(...)`, INMEDIATAMENTE después del `if (env.RATE_LIMIT_ENABLED) { await app.register(rateLimit, ...) }` block (línea 153 actual), ANTES de `app.register(healthRoute)` (línea 155):

```ts
  // WFAC-41 — inject the app logger into per-chain circuit breakers so state
  // transitions emit structured warn logs. Ducktype over adapter.setLogger;
  // adapters without a breaker (stubs, future adapters) silently skip.
  // MUST run AFTER adapter registration (registry populated via eager imports
  // from src/core/supported.ts and friends) and BEFORE routes start serving.
  initChainBreakers(app.log);

  await app.register(healthRoute);
  // ... rest unchanged ...
```

**Checklist W4.2**:

- [ ] `grep -c "initChainBreakers" src/app.ts` → **exactly 2 matches** (import + call).
- [ ] La llamada ocurre DESPUÉS del rate-limit plugin registration y ANTES de `app.register(healthRoute)`.
- [ ] Los `app.register(xRoute)` existentes **NO cambian**.
- [ ] El `addHook('onResponse', ...)` WFAC-33 (línea 167) NO cambia.
- [ ] El `addHook('onClose', ...)` Redis (línea 200) NO cambia.

#### W4.3 — `src/routes/verify.ts` (MODIFY)

**Acción**: en Step 5 (línea 162 `if (!result.ok)`), ANTES del `reply.code(result.error.http).send(...)` línea 175, agregar detección + header.

**Antes** (líneas 162-176):
```ts
      // Step 5 — map Result<VerifyResult> → HTTP.
      if (!result.ok) {
        // L3 — warn.
        app.log.warn(
          {
            request_id: requestId,
            error_code: result.error.code,
            http_status: result.error.http,
            duration_ms: Date.now() - startMs,
          },
          'verify failed',
        );
        // WFAC-33 (CD-11): propagate adapter-returned x402 error code to audit row.
        request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
        return reply.code(result.error.http).send({ error: result.error } satisfies ErrorBody);
      }
```

**Después**:
```ts
      // Step 5 — map Result<VerifyResult> → HTTP.
      if (!result.ok) {
        // L3 — warn.
        app.log.warn(
          {
            request_id: requestId,
            error_code: result.error.code,
            http_status: result.error.http,
            duration_ms: Date.now() - startMs,
          },
          'verify failed',
        );
        // WFAC-33 (CD-11): propagate adapter-returned x402 error code to audit row.
        request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
        // WFAC-41 (AC-11, CD-NEW-CB-RETRY-AFTER) — Retry-After header for
        // circuit-breaker 503. The retryAfterMs field lives ONLY in the
        // server-side error object; it is NOT serialized in the JSON body.
        if (
          result.error.code === 'CHAIN_UNAVAILABLE' &&
          typeof result.error.retryAfterMs === 'number'
        ) {
          const secs = Math.max(1, Math.ceil(result.error.retryAfterMs / 1000));
          reply.header('Retry-After', String(secs));
        }
        // Body response: only {code, message, http}. Strip retryAfterMs.
        const bodyError: { code: string; message: string; http: number } = {
          code: result.error.code,
          message: result.error.message,
          http: result.error.http,
        };
        return reply.code(result.error.http).send({ error: bodyError } satisfies ErrorBody);
      }
```

**NOTA CRÍTICA — CD-NEW-CB-RETRY-AFTER-INTERNAL**: el body NO debe contener `retryAfterMs`. Por eso construimos `bodyError` explícitamente con las 3 keys (`code`, `message`, `http`). Si se hace `{ error: result.error }` directo, TS serializará el campo opcional también y romperá el contrato de shape (CD-CHAIN-OWNERS y tests de shape WFAC-20).

**Actualizar `VerifyRouteErrorCode`** (línea 37-48): agregar `| 'CHAIN_UNAVAILABLE'` al union local — el adapter puede retornar este code.

**Antes**:
```ts
type VerifyRouteErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID'
  | 'INVALID_PAYLOAD';
```

**Después**:
```ts
type VerifyRouteErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID'
  | 'CHAIN_UNAVAILABLE'   // WFAC-41
  | 'INVALID_PAYLOAD';
```

**Checklist W4.3**:

- [ ] `grep -c "'CHAIN_UNAVAILABLE'" src/routes/verify.ts` → **≥2 matches** (union type + if-check).
- [ ] `grep -c "'Retry-After'" src/routes/verify.ts` → **exactly 1 match**.
- [ ] El body response tiene **exactamente 3 keys** (`code`, `message`, `http`) — **NO** incluye `retryAfterMs` (**CD-NEW-CB-RETRY-AFTER-INTERNAL**).
- [ ] El `sendCached` helper (líneas 217-247) **NO se toca** — cache-hit no aplica a 503 (503 NO es cacheable por CD-12 WFAC-20).
- [ ] El handler de INVALID_PAYLOAD (línea 83-102) **NO se toca**.
- [ ] El handler de adapter throw (líneas 128-151) **NO se toca**.

#### W4.4 — `src/routes/settle.ts` (MODIFY)

**Idéntico patrón** al W4.3. Step 5 está en línea 184.

**Antes** (líneas 184-218):
```ts
      // Step 5 — map Result<SettleResult> → HTTP
      if (!result.ok) {
        // L3 — warn
        app.log.warn({ ... }, 'settle failed');
        // WFAC-32 H2 — ledger entry for adapter-returned x402 error (4xx/5xx).
        await persistLedgerEntry(...);
        // WFAC-33 (CD-11): propagate adapter-returned x402 error code to audit row.
        request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
        return reply.code(result.error.http).send({ error: result.error } satisfies ErrorBody);
      }
```

**Después**:
```ts
      // Step 5 — map Result<SettleResult> → HTTP
      if (!result.ok) {
        // L3 — warn
        app.log.warn({ ... }, 'settle failed');
        // WFAC-32 H2 — ledger entry for adapter-returned x402 error (4xx/5xx).
        await persistLedgerEntry(...);
        // WFAC-33 (CD-11): propagate adapter-returned x402 error code to audit row.
        request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
        // WFAC-41 (AC-11) — Retry-After header for circuit-breaker 503.
        if (
          result.error.code === 'CHAIN_UNAVAILABLE' &&
          typeof result.error.retryAfterMs === 'number'
        ) {
          const secs = Math.max(1, Math.ceil(result.error.retryAfterMs / 1000));
          reply.header('Retry-After', String(secs));
        }
        const bodyError: { code: string; message: string; http: number } = {
          code: result.error.code,
          message: result.error.message,
          http: result.error.http,
        };
        return reply.code(result.error.http).send({ error: bodyError } satisfies ErrorBody);
      }
```

**Actualizar** `SettleRouteErrorCode` (el union local equivalente al de verify.ts) agregando `| 'CHAIN_UNAVAILABLE'`. Ubicación: cercano a línea 56.

**Checklist W4.4**: igual que W4.3 pero para settle.ts.

Adicional:
- [ ] La llamada `persistLedgerEntry(...)` (líneas 197-214) **NO se toca** — el ledger recibe el `result.error` completo server-side (incluyendo `retryAfterMs` si aplica), pero eso está dentro de un builder interno que solo persiste lo que el schema WFAC-32 espera. Si el schema WFAC-32 rechaza campos desconocidos → bug del ledger; **leer `src/core/ledger.ts` para confirmar que WFAC-32 hace strict parse y filtra retryAfterMs** — si sí, `await persistLedgerEntry(...)` sigue funcionando sin cambios. **SI detectás en W4 que el ledger rompe con `retryAfterMs` en el input** → **STOP + report**: la solución es filtrar `retryAfterMs` antes del builder WFAC-32 (extender CD-NEW-CB-RETRY-AFTER-INTERNAL).
- [ ] El cached-hit path (`sendCachedSettle`) **NO se toca** — 503 CHAIN_UNAVAILABLE NO es cacheable (`toCacheableSettle` filtra 5xx).

#### W4.5 — `src/core/supported.ts` (MODIFY)

**Acción**: inyectar `breakerState` en la response cuando el adapter expone `getBreakerState()`.

**Cambios**:

1. **`ChainSupportedItem` interface** (línea 33-37): agregar opcional `breakerState?`.

**Antes**:
```ts
export interface ChainSupportedItem {
  readonly network: string;
  readonly name: string;
  readonly methods: readonly string[];
}
```

**Después**:
```ts
export interface ChainSupportedItem {
  readonly network: string;
  readonly name: string;
  readonly methods: readonly string[];
  /**
   * WFAC-41 (AC-9, DT-7) — current circuit breaker state per chain.
   * Omitted (field not present) when:
   *   - the adapter does not expose `getBreakerState()` (stub, future adapters), OR
   *   - the adapter's breaker is disabled (CB_ENABLED=false) — adapter returns
   *     'CLOSED' always in that case, but semantically the field is still meaningful
   *     (breaker is a no-op). We emit the field unconditionally when the method exists.
   *
   * Integrators can switch on `breakerState === 'OPEN'` to try an alternate chain.
   */
  readonly breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}
```

2. **`getSupportedResponse()`** (líneas 57-66): consultar `adapter.getBreakerState?.()` via ducktype y spread condicional.

**Antes**:
```ts
export function getSupportedResponse(): SupportedResponse {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const chains: readonly ChainSupportedItem[] = adapters.map((meta) => ({
    network: meta.networkId,
    name: meta.name,
    methods: [...CHAIN_METHODS_DEFAULT],
  }));
  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
  return { chains, methods };
}
```

**Después**:
```ts
export function getSupportedResponse(): SupportedResponse {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const chains: readonly ChainSupportedItem[] = adapters.map((meta) => {
    // WFAC-41 (DT-7) — ducktype lookup of getBreakerState via registry.
    // chainRegistry.getAdapter returns the adapter instance which MAY
    // expose getBreakerState (KiteAdapter, AvalancheFujiAdapter) or MAY NOT
    // (stubs / future adapters). Spread condicional keeps the field omitted
    // when absent (NOT `undefined`) — cleaner JSON contract.
    const lookup = chainRegistry.getAdapter(meta.chainId);
    const state =
      lookup.ok &&
      typeof (lookup.adapter as { getBreakerState?: () => 'CLOSED' | 'OPEN' | 'HALF_OPEN' }).getBreakerState === 'function'
        ? (lookup.adapter as { getBreakerState: () => 'CLOSED' | 'OPEN' | 'HALF_OPEN' }).getBreakerState()
        : undefined;
    return {
      network: meta.networkId,
      name: meta.name,
      methods: [...CHAIN_METHODS_DEFAULT],
      ...(state !== undefined ? { breakerState: state } : {}),
    };
  });
  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
  return { chains, methods };
}
```

**Checklist W4.5**:

- [ ] El field `breakerState` es OPCIONAL (`?`). Ausente (no `undefined`, no `null`) cuando el adapter no expone `getBreakerState`.
- [ ] **CD-CORE-PURE** (WFAC-22): `src/core/supported.ts` sigue siendo **pure** — sin I/O, sin logger. La llamada `adapter.getBreakerState()` es síncrona y pura.
- [ ] `grep -c "getBreakerState" src/core/supported.ts` → **≥2 matches** (ducktype check + call).
- [ ] El boundary se respeta: `supported.ts` ya importa `chainRegistry` (línea 24) — permitido por OWNERS "core/* MAY import chains/registry.js". **NO** importar `kite.ts` o `avalanche.ts` directamente.

#### W4.6 — Tests appends en routes + init-breakers test

**W4.6.1 — `src/__tests__/unit/routes.verify.test.ts`** (APPEND ≥2 tests):

- **T-RT-VERIFY-CB-1 (AC-2, AC-11)**: mock `verifyCore` para retornar `{ok:false, error:{code:'CHAIN_UNAVAILABLE', message:'Chain RPC temporarily unavailable', http:503, retryAfterMs:7500}}`. `app.inject({method:'POST', url:'/verify', payload: validBody})` → `response.statusCode === 503`. `JSON.parse(response.body).error` tiene EXACTAMENTE `{code:'CHAIN_UNAVAILABLE', message:'Chain RPC temporarily unavailable', http:503}` (3 keys, **sin retryAfterMs**). `response.headers['retry-after'] === '8'` (ceil(7500/1000) = 8).
- **T-RT-VERIFY-CB-2 (CD-NEW-CB-RETRY-AFTER-INTERNAL)**: mismo setup — `Object.keys(JSON.parse(response.body).error).sort()` === `['code','http','message']`.

**W4.6.2 — `src/__tests__/unit/routes.settle.test.ts`** (APPEND ≥2 tests):

- **T-RT-SETTLE-CB-1 (AC-2, AC-11)**: idéntico a T-RT-VERIFY-CB-1 con `url:'/settle'`. Mock `settleCore`.
- **T-RT-SETTLE-CB-2 (CD-NEW-CB-RETRY-AFTER-INTERNAL)**: idéntico a T-RT-VERIFY-CB-2 con settle.

**W4.6.3 — `src/__tests__/unit/routes.supported.test.ts`** (APPEND ≥2 tests):

- **T-RT-SUPPORTED-CB-1 (AC-9)**: `buildApp()` default (CB_ENABLED=true). `app.inject({method:'GET', url:'/supported'})` → cada chain en `response.body.chains` tiene `breakerState: 'CLOSED'`. Assertion: `body.chains.every((c) => c.breakerState === 'CLOSED')`.
- **T-RT-SUPPORTED-CB-2 (AC-6 passthrough)**: `buildApp({ rawEnv: { ..., CB_ENABLED:'false' } })` → cada chain aún tiene `breakerState: 'CLOSED'` (el adapter retorna 'CLOSED' vía getState con enabled=false — ver W2.1 behavior). **Alternativa**: si W2.1 retorna `'CLOSED'` siempre en enabled=false, el field se emite siempre que el adapter exponga `getBreakerState`. Esto es intencional — la ausencia del field solo ocurre si el adapter no wrappea (future stubs).

**W4.6.4 — `src/__tests__/unit/chains/init-breakers.test.ts` (NEW)**:

- **T-INIT-1**: `const app = await buildApp(...);` → los adapters kite + avalanche (accedidos via `chainRegistry.getAdapter(chainId)`) tienen `getBreakerState!() === 'CLOSED'`. Esto valida que `initChainBreakers` corrió en `buildApp` y que los adapters existen registrados.
- **T-INIT-2**: spy sobre `kiteTestnetAdapter.setLogger` → tras `buildApp()`, `setLogger` fue llamado ≥1 vez con un objeto que tiene `.warn(...)` method (Pino logger).

**Total tests nuevos W4**: ≥6 (2 verify + 2 settle + 2 supported) + 2 init-breakers = ≥8.

**Checklist W4.6**:

- [ ] **Regression CRÍTICO**: tests existentes de `routes.verify.test.ts` (WFAC-20+33), `routes.settle.test.ts` (WFAC-21+32+33), `routes.supported.test.ts` (WFAC-22+33) siguen **TODOS verdes**. El patch del Step 5 NO debe romper el path de non-CHAIN_UNAVAILABLE (NETWORK_MISMATCH, INVALID_SIGNATURE, etc. siguen funcionando idéntico).
- [ ] `grep -c "retry-after\\|Retry-After" src/__tests__/unit/routes.verify.test.ts` → **≥1 match**.
- [ ] `grep -c "breakerState" src/__tests__/unit/routes.supported.test.ts` → **≥1 match**.
- [ ] **CD-LESSON-2** (WFAC-33 auto-blindaje): `light-my-request` inyecta UA default. Para tests de 503 NO validamos UA — aplica solo si algún test explícito quiere "no UA in audit".
- [ ] `app.close()` al final de cada test (o `afterEach`) para evitar port leaks.

#### Wave 4 — dependencies

- Depende de W1 (`retryAfterMs` en `Err.error`) + W2 (`ChainCircuitBreaker` class) + W3 (adapters exponen `getBreakerState` + `setLogger` + retornan CHAIN_UNAVAILABLE).

#### Wave 4 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run qa` → exit 0.
- [ ] `npm test -- --run` → **≥469 verdes** (W3 ~461 + ~8 W4 = ~469). **Target mínimo: ≥461** (el flow puede superar).
- [ ] **Regression guard FINAL**: todos los tests WFAC-previos siguen verdes — `audit.test.ts`, `ledger.test.ts`, `rate-limiting.test.ts`, `chain-adapter.test.ts` (original), `core-types.test.ts`, `core.verify.test.ts`, `core.settle.test.ts`, `health.test.ts`, `logger.test.ts`, `no-console.test.ts`, `chain-registry.test.ts`, `shutdown.test.ts`, `redis.test.ts`, `supabase.test.ts`, `routes.openapi.test.ts`.
- [ ] `grep -n "'Retry-After'" src/routes/verify.ts src/routes/settle.ts` → **exactly 2 matches** (1 por archivo).
- [ ] `grep -n "initChainBreakers" src/app.ts` → **exactly 2 matches** (import + 1 call).
- [ ] `grep -n "breakerState" src/core/supported.ts` → **≥2 matches** (interface field + runtime check).
- [ ] Smoke manual (opcional en QA): `curl http://localhost:3002/supported` → JSON response incluye `"breakerState":"CLOSED"` per chain.

**Commit sugerido**:
```
feat(WFAC-41): W4 init-breakers + routes Retry-After + supported breakerState
```

---

## 2. AC → Wave → Test matrix (13 ACs)

| AC | Descripción | Wave(s) | Test(s) que cubre | Archivo |
|----|-------------|---------|-------------------|---------|
| **AC-1** | N failures in window → OPEN | W2 + W3 | T-CB-2, T-ADAPT-CB-2 | `circuit-breaker.test.ts`, `chain-adapter.test.ts` |
| **AC-2** | OPEN → 503 + CHAIN_UNAVAILABLE + no RPC call | W2 + W3 + W4 | T-CB-3, T-ADAPT-CB-2, T-RT-VERIFY-CB-1, T-RT-SETTLE-CB-1 | `circuit-breaker.test.ts`, `chain-adapter.test.ts`, `routes.verify.test.ts`, `routes.settle.test.ts` |
| **AC-3** | Reset timeout → HALF_OPEN single probe | W2 | T-CB-4 | `circuit-breaker.test.ts` |
| **AC-4** | HALF_OPEN success → CLOSED | W2 | T-CB-5 | `circuit-breaker.test.ts` |
| **AC-5** | HALF_OPEN fail → OPEN + timer reset | W2 | T-CB-6 | `circuit-breaker.test.ts` |
| **AC-6** | CB_ENABLED=false bypass | W1 + W2 + W3 | T-ENV-CB-2, T-CB-7, T-ADAPT-CB-5 | `env.test.ts`, `circuit-breaker.test.ts`, `chain-adapter.test.ts` |
| **AC-7** | Cross-chain independence | W2 + W3 | T-CB-8, T-ADAPT-CB-3 | `circuit-breaker.test.ts`, `chain-adapter.test.ts` |
| **AC-8** | State transition → warn log with `{chainId, fromState, toState, failureCount}` | W2 | T-CB-11 | `circuit-breaker.test.ts` |
| **AC-9** | Breaker state exposed via /supported | W3 + W4 | T-ADAPT-CB-1, T-RT-SUPPORTED-CB-1 | `chain-adapter.test.ts`, `routes.supported.test.ts` |
| **AC-10** | Non-positive env vars → parseEnv fail-fast exit(1) | W1 | T-ENV-CB-4, T-ENV-CB-5, T-ENV-CB-6, T-ENV-CB-7 | `env.test.ts` |
| **AC-11** | 503 response includes Retry-After header | W4 | T-RT-VERIFY-CB-1, T-RT-SETTLE-CB-1 | `routes.verify.test.ts`, `routes.settle.test.ts` |
| **AC-12** | Metrics exposed (cb_state gauge, cb_failures_total, cb_transitions_total) | W2 | T-CB-10 | `circuit-breaker.test.ts` |
| **AC-13** | SIMULATION_FAILED / TRANSACTION_FAILED counted as CB failure | W2 + W3 | T-CB-9, T-ADAPT-CB-4 | `circuit-breaker.test.ts`, `chain-adapter.test.ts` |

**Total nuevos tests (mínimo)**:
- W1: ≥7 env + ≥3 errors cascade = 10
- W2: ≥11 circuit-breaker tests
- W3: ≥5 adapter integration tests
- W4: ≥4 route tests + ≥2 supported + ≥2 init-breakers = 8

**Suma**: ≥34 nuevos. **Target**: ≥461 (435 + ≥26). Plan cubre **con holgura**.

---

## 3. Constraint Directives — 25 CDs (9 WI + 9 SDD + 7 CD-LESSONS)

### 3.1 Heredados del work-item (CD-1..CD-9)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-1** | OBLIGATORIO wrap both `verify` AND `settle` en cada adapter. Wrap solo settle = PROHIBIDO. | `src/chains/kite.ts`, `src/chains/avalanche.ts` (W3) |
| **CD-2** | PROHIBIDO cross-chain state contamination — cada adapter holds its own `ChainCircuitBreaker`. Shared singleton = PROHIBIDO. | `src/chains/kite.ts`, `src/chains/avalanche.ts` (W3) |
| **CD-3** | OBLIGATORIO `CHAIN_UNAVAILABLE` en `HTTP_BY_CODE` y `DEFAULT_MESSAGE_BY_CODE` — TS compilation lo fuerza. | `src/core/errors.ts` (W1) |
| **CD-4** | PROHIBIDO hardcode thresholds — solo env. | `src/chains/kite.ts`, `src/chains/avalanche.ts` (W3), `src/chains/circuit-breaker.ts` (W2) |
| **CD-5** | OBLIGATORIO `Retry-After` header en 503 CHAIN_UNAVAILABLE. | `src/routes/verify.ts`, `src/routes/settle.ts` (W4) |
| **CD-6** | OBLIGATORIO fail-fast en parseEnv con env vars inválidas. | `src/infra/env.ts` (W1) |
| **CD-7** | PROHIBIDO side-effects cuando `CB_ENABLED=false` — passthrough puro. | `src/chains/circuit-breaker.ts` (W2), `src/chains/kite.ts`/`avalanche.ts` (W3) |
| **CD-8** | OBLIGATORIO `.enum(['true','false']).transform(...)` para CB_ENABLED. **PROHIBIDO** `z.coerce.boolean()`. | `src/infra/env.ts` (W1) |
| **CD-9** | OBLIGATORIO respetar OWNERS — `src/chains/circuit-breaker.ts` NO importa `src/core/*` runtime. | `src/chains/circuit-breaker.ts` (W2) |

### 3.2 Nuevos del SDD (CD-NEW-CB-*)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-NEW-CB-COCKA-EXACT** | `cockatiel` DEBE pin-earse **exact** en `package.json`: `"cockatiel": "3.2.1"` — NO `"^3.2.1"` ni `"~3.2.1"`. Install con `--save-exact`. | `package.json` (W0) |
| **CD-NEW-CB-COCKA-NAMED** | Imports de cockatiel DEBEN ser named: `import { circuitBreaker, ConsecutiveBreaker, SamplingBreaker, handleAll, CircuitState, BrokenCircuitError } from 'cockatiel';`. **PROHIBIDO** `import * as cockatiel from 'cockatiel'` (ESM interop issue Node 20). | `src/chains/circuit-breaker.ts` (W2) |
| **CD-NEW-CB-4VARS** | Exactamente 4 env vars: `CB_ENABLED`, `CB_FAILURE_THRESHOLD`, `CB_ROLLING_WINDOW_MS`, `CB_RESET_TIMEOUT_MS`. **PROHIBIDO** agregar `CB_PROBE_HALF_OPEN_MS` ni variante — cockatiel `halfOpenAfter == CB_RESET_TIMEOUT_MS`. | `src/infra/env.ts` (W1) |
| **CD-NEW-CB-ENABLED-FALSE** | Cuando `CB_ENABLED=false`, el breaker class NO actualiza state, NO emite logs, NO toca métricas. `execute(fn)` es passthrough a `fn()`. `recordBusinessFailure` es no-op. | `src/chains/circuit-breaker.ts` (W2) |
| **CD-NEW-CB-TRANSLATE** | `BrokenCircuitError` de cockatiel NO sale de `src/chains/circuit-breaker.ts`. SIEMPRE se atrapa y traduce a `BreakerOpenError(chainId, remainingMs)` custom. El adapter solo ve `BreakerOpenError`. | `src/chains/circuit-breaker.ts` (W2), `src/chains/kite.ts`, `avalanche.ts` (W3) |
| **CD-NEW-CB-METRICS-IDEMPOTENT** | prom-client registration via `registerOrGet` helper (check `defaultRegister.getSingleMetric(name)` first). **PROHIBIDO** `new Gauge({...})` / `new Counter({...})` directo en module scope sin guard — `vi.resetModules()` rompe. | `src/chains/circuit-breaker.ts` (W2) |
| **CD-NEW-CB-HELPER-DEFAULTS** | `readCbNumber`/`readCbBool` DEBEN tener fallbacks **idénticos** a Zod defaults (5/30000/10000/true). Divergencia = AR BLOQUEANTE. | `src/chains/circuit-breaker.ts` (W2), `src/chains/kite.ts`, `avalanche.ts` (W3) |
| **CD-NEW-CB-RETRY-AFTER-INTERNAL** | `retryAfterMs` en `Err.error` NO se serializa en el body JSON de la response. Solo lo consume el route layer para setear header `Retry-After`. El body tiene **exactamente 3 keys** (`code`, `message`, `http`). | `src/routes/verify.ts`, `src/routes/settle.ts` (W4) |
| **CD-NEW-CB-SUPPORTED-DUCKTYPE** | `/supported` ducktype-checks `typeof adapter.getBreakerState === 'function'` antes de llamar. Stubs sin breaker silently skip. Spread condicional omite el field cuando ausente (no emite `undefined`/`null`). | `src/core/supported.ts` (W4) |

### 3.3 CD-LESSONS — aprendizajes de auto-blindajes recientes

- **CD-LESSON-1** (WFAC-40 auto-blindaje): `errorResponseBuilder` custom que dependen de `throw` + `statusCode`. NO aplica directo aquí (no usamos errorResponseBuilder), pero el principio se aplica: **el adapter atrapa `BreakerOpenError` antes** de que salga a routes/core (**CD-NEW-CB-TRANSLATE**).
- **CD-LESSON-2** (WFAC-33 auto-blindaje): `light-my-request` inyecta `user-agent: 'lightMyRequest'` default. Aplica si un test de W4 quiere "no UA en audit" — setear `headers: { 'user-agent': '' }` explícito.
- **CD-LESSON-3** (WFAC-33 auto-blindaje): `idempotencyKey` en audit shape es 83 chars prefixed — NO aplica directo aquí.
- **CD-LESSON-4** (WFAC-32 auto-blindaje): al borrar variable en fix ESLint `no-unused-vars`, correr `rg <name> src/` antes del commit. **Aplica a W3** si el refactor dejar variables huérfanas.
- **CD-LESSON-5** (WFAC-32 auto-blindaje): NUNCA literales realistas en JSDoc (trip `no-secrets/no-secrets`). **Aplica a** JSDoc de `ChainCircuitBreaker` class — usar prosa, no ejemplos numéricos realistas de thresholds.
- **CD-LESSON-6** (WFAC-23 auto-blindaje): correr `npx prettier --write <archivos>` antes de `format:check`. **OBLIGATORIO** para los 3 archivos NEW:
  - `src/chains/circuit-breaker.ts` (W2)
  - `src/chains/init-breakers.ts` (W4)
  - `src/__tests__/unit/chains/circuit-breaker.test.ts` (W2)
  - `src/__tests__/unit/chains/init-breakers.test.ts` (W4)
- **CD-LESSON-7** (WFAC-23 auto-blindaje): `// eslint-disable-next-line security/detect-object-injection` con justificación. Aplicable a `readCbNumber`/`readCbBool` que hacen `process.env[name]` con `name: string` parameter + a cualquier acceso dinámico a Records en tests.

---

## 4. Guardrails anti-drift (checklist rápido para el Dev)

**Antes de cada commit, corré mentalmente esta lista**:

- [ ] **X402ErrorCode ahora 11 codes** — los asserts `toHaveLength(10)` en `errors.test.ts` DEBEN estar en `11` (W1.6). Esto NO es regresión — es parte del contrato del HU. `grep -c "toHaveLength(10)" src/__tests__/unit/core/errors.test.ts` → **zero matches** al cerrar W1.
- [ ] **CB wrap SOLO a nivel adapter** (`src/chains/kite.ts`, `src/chains/avalanche.ts`). **PROHIBIDO** wrappear en `src/core/*` (verify.ts, settle.ts, supported.ts) o en `src/routes/*`. `grep -rn "ChainCircuitBreaker\|_breaker\\.execute" src/core/ src/routes/` → **zero matches**.
- [ ] **`src/chains/circuit-breaker.ts` NO importa `src/core/*` runtime**. `grep -nE "^import .* from '\\.\\./(core|infra|routes|methods)/" src/chains/circuit-breaker.ts` → **zero matches**. Solo `cockatiel`, `prom-client`, `pino` (type-only).
- [ ] **cockatiel named imports**. `grep -n "import \\* as .* from 'cockatiel'" src/` → **zero matches** (**CD-NEW-CB-COCKA-NAMED**).
- [ ] **Metrics via prom-client default register** — `registerOrGet` helper (**CD-NEW-CB-METRICS-IDEMPOTENT**). `grep -n "new Registry()" src/chains/circuit-breaker.ts` → **zero matches** (NO crear new Registry).
- [ ] **Retry-After header SOLO si `result.error.code === 'CHAIN_UNAVAILABLE'`**. `grep -c "'CHAIN_UNAVAILABLE'" src/routes/verify.ts src/routes/settle.ts` → 2 archivos × ≥2 matches cada uno (union + check).
- [ ] **`retryAfterMs` NO en body JSON**. Tests W4.6.1/W4.6.2 `T-RT-*-CB-2` validan `Object.keys(body.error).length === 3`.
- [ ] **NO extend `Err.error` con más campos** que no sean `retryAfterMs?`. Solo **1 nuevo** field optional.
- [ ] **NO agregar endpoint `/status/circuit-breakers`** — AC-9 se resuelve via extension de `/supported` (**CD-NEW-CB-SUPPORTED-DUCKTYPE**).
- [ ] **NO modificar `src/routes/supported.ts`** — toda la lógica vive en `src/core/supported.ts`.
- [ ] **NO modificar `.env.example`** (out of scope — PR follow-up si se requiere).
- [ ] **NO hardcodear thresholds** (**CD-4**). `grep -nE "failureThreshold:\\s*[0-9]|resetTimeoutMs:\\s*[0-9]" src/chains/kite.ts src/chains/avalanche.ts` → **zero matches**. Todo via `readCbNumber(...)`.
- [ ] **NO `z.coerce.boolean()`** para CB_ENABLED (**CD-8**). `grep -n "z.coerce.boolean" src/infra/env.ts` → **zero matches**.
- [ ] **NO propagar `BrokenCircuitError`** fuera del breaker class (**CD-NEW-CB-TRANSLATE**). `grep -rn "BrokenCircuitError" src/chains/kite.ts src/chains/avalanche.ts src/routes/ src/core/` → **zero matches**.
- [ ] **NO reinstalar prom-client ni fastify** — ya están en deps.
- [ ] **NO agregar `setLogger`/`getBreakerState` como REQUIRED** en `ChainAdapter` — opcionales (**CD-3.1 SDD §3.4**). `grep -n "setLogger\\|getBreakerState" src/chains/types.ts` → matches deben tener `?` signo.

### Regression guard CRÍTICO (tras cada wave, antes del próximo commit)

- [ ] `npm test -- --run` sigue verde para baseline 435 + tests nuevos de waves cerradas.
- [ ] `npm test -- --run core/errors` → 10+ entries test **actualizados** a 11 (W1). Count-assertion `toHaveLength(11)` verde.
- [ ] `npm test -- --run routes.openapi` → test enum actualizado (W1).
- [ ] `npm test -- --run env` → env originales + T-ENV-RL-* (WFAC-40) + T-ENV-CB-* (WFAC-41) **todos verdes**.
- [ ] `npm test -- --run chain-adapter` → 13 tests WFAC-3 originales + T-ADAPT-CB-* **todos verdes post-W3**. **Si alguno del set original rompe → STOP**: el wrapping del adapter NO es transparent.
- [ ] `npm test -- --run routes.verify` → WFAC-20 + WFAC-33 + WFAC-40 + T-RT-VERIFY-CB-* verdes.
- [ ] `npm test -- --run routes.settle` → WFAC-21 + WFAC-32 + WFAC-33 + WFAC-40 + T-RT-SETTLE-CB-* verdes.
- [ ] `npm test -- --run routes.supported` → WFAC-22 + WFAC-33 + WFAC-40 + T-RT-SUPPORTED-CB-* verdes.
- [ ] `npm test -- --run audit` → WFAC-33 verdes (15 tests).
- [ ] `npm test -- --run ledger` → WFAC-32 verdes.
- [ ] `npm test -- --run health` → WFAC-2 + WFAC-33 verdes.
- [ ] `npm test -- --run rate-limiting` → WFAC-40 verdes.
- [ ] **≥461/461 mínimo al final de W4**. Si <461 → hay regresión o faltan tests.

### Regresiones particulares a vigilar

- [ ] **Spec-literal body WFAC-20/21/22/23**: los routes siguen retornando `{error:{code, message, http}}` en 4xx/5xx. Agregar `retryAfterMs` al error server-side **NO** debe aparecer en body (**CD-NEW-CB-RETRY-AFTER-INTERNAL**). Los tests WFAC-20 `Object.keys(body.error).length === 3` **seguirán verdes** porque `bodyError` en W4.3/W4.4 se construye explícitamente con 3 keys.
- [ ] **Adapter transparency**: los stubs de kite + avalanche hoy retornan NETWORK_MISMATCH con http 400. Tras W3, SIGUEN retornando el mismo valor — el wrap es transparente en el path happy (`_verifyRaw`/`_settleRaw` retornan el mismo objeto). Si un test WFAC-20/21 valida `{code:'NETWORK_MISMATCH', http:400}` sobre kite → sigue verde.
- [ ] **Idempotency cache-hit de /settle**: el cached path (`sendCachedSettle`) NO usa el Step 5 nuevo — W4.4 solo cambia el path non-cached. Tests WFAC-21 cache-hit siguen verdes.
- [ ] **Ledger WFAC-32**: el ledger builder recibe `result.error` de adapter. Si el error es CHAIN_UNAVAILABLE (nuevo), el ledger debe aceptarlo. **Confirmar con `Read src/core/ledger.ts` en W4** que `buildLedgerEntry` no hace `strict()` schema rejecting new codes. Si rompe → extender el ledger (O filtrar retryAfterMs upstream). **LO MÁS PROBABLE**: el ledger loguea `error.code` como string sin validar el union — sigue funcionando. Verificar en W4 con test manual.
- [ ] **`chainRegistry.getAdapter` NO retorna breaker**: el registry expone los adapters tal cual. `adapter.getBreakerState?.()` se llama vía ducktype en `src/core/supported.ts` — el registry no conoce breakers.
- [ ] **`initChainBreakers` ejecución única**: se llama 1 vez en `buildApp`. **NO** llamarlo 2 veces (sobreescribe loggers). En tests que hacen múltiples `buildApp()`, cada build llama 1 vez — OK.
- [ ] **OpenAPI yaml schema drift**: tras W1.4, algún test genera OpenAPI desde source (no aplicable aquí — el OpenAPI está en `doc/openapi.yaml` manual). Confirmar que NO hay generación automática que colisione.

---

## 5. Done Definition (HU-41)

- [ ] Todas las waves W0-W4 cerradas con sus completion criteria.
- [ ] `npm run qa` exit 0 (typecheck + lint + format:check + test).
- [ ] **≥461 tests passing** (435 baseline + ≥26 nuevos — plan delivers ~34+).
- [ ] 24 archivos del Scope IN tocados; **ningún archivo fuera del Scope IN modificado**.
- [ ] `package.json` incluye `"cockatiel": "3.2.1"` (exact, **CD-NEW-CB-COCKA-EXACT**).
- [ ] `src/core/types.ts`:
  - `X402ErrorCode` union con **11 miembros** (10 x402 + `CHAIN_UNAVAILABLE`).
  - `Err.error` con `retryAfterMs?: number` opcional.
- [ ] `src/core/errors.ts`:
  - `HTTP_BY_CODE.CHAIN_UNAVAILABLE === 503`.
  - `DEFAULT_MESSAGE_BY_CODE.CHAIN_UNAVAILABLE === 'Chain RPC temporarily unavailable'`.
- [ ] `src/infra/env.ts` exporta `EnvSchema` con 4 CB_* keys (defaults 5/30000/10000/true).
- [ ] `doc/openapi.yaml` con `CHAIN_UNAVAILABLE` en enum X402ErrorCode y `503` en enum X402ErrorHttp.
- [ ] `src/chains/circuit-breaker.ts` exporta `ChainCircuitBreaker` class, `BreakerOpenError`, `readCbNumber`, `readCbBool` — respetando OWNERS (no imports de `src/core/*` runtime).
- [ ] `src/chains/init-breakers.ts` exporta `initChainBreakers(logger)` ducktype helper.
- [ ] `src/chains/types.ts`:
  - `ChainAdapter` con `getBreakerState?` + `setLogger?` opcionales.
  - `ChainMetadata` con `breakerState?` opcional.
- [ ] `src/chains/kite.ts` y `src/chains/avalanche.ts`:
  - Breaker privado instanciado en constructor con thresholds vía `readCbNumber`/`readCbBool`.
  - `verify` y `settle` wrappeados con try/catch `BreakerOpenError` → `{code:'CHAIN_UNAVAILABLE', http:503, retryAfterMs}`.
  - `_verifyRaw`/`_settleRaw` privados con cuerpo original del stub + `recordBusinessFailure` en SIMULATION_FAILED/TRANSACTION_FAILED (AC-13).
  - `setLogger(logger)` y `getBreakerState()` expuestos.
- [ ] `src/app.ts`:
  - `import { initChainBreakers } from './chains/init-breakers.js'`.
  - `initChainBreakers(app.log)` llamado post-`app.register(rateLimit,...)` y pre-`app.register(healthRoute)`.
- [ ] `src/routes/verify.ts` y `src/routes/settle.ts`:
  - Step 5 detecta `result.error.code === 'CHAIN_UNAVAILABLE' && typeof result.error.retryAfterMs === 'number'` → `reply.header('Retry-After', String(Math.max(1, Math.ceil(ms/1000))))`.
  - Body con **exactamente 3 keys** (`code`, `message`, `http`) — **NO** incluye `retryAfterMs` (**CD-NEW-CB-RETRY-AFTER-INTERNAL**).
  - Union local de route-error-code extendido con `| 'CHAIN_UNAVAILABLE'`.
- [ ] `src/core/supported.ts`:
  - `ChainSupportedItem` con `breakerState?` opcional.
  - `getSupportedResponse()` ducktype-checks `adapter.getBreakerState?.()` y emite el field vía spread condicional.
- [ ] Los 25 CDs respetados (9 WI + 9 SDD + 7 CD-LESSONS).
- [ ] `src/core/audit.ts`, `src/core/ledger.ts`, `src/core/idempotency.ts`, `src/core/schemas.ts`, `src/core/network.ts`, `src/core/settle.ts`, `src/core/verify.ts` y demás core WFAC-previos **intactos**.
- [ ] `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/infra/logger.ts` intactos.
- [ ] `src/routes/health.ts`, `src/routes/openapi.ts`, `src/routes/supported.ts` intactos.
- [ ] `.env.example`, `supabase/migrations/*.sql` intactos.
- [ ] `src/chains/registry.ts` intacto.
- [ ] Commit messages por wave con prefix `WFAC-41` y referencia a la wave.

---

## 6. Referencias rápidas

- **Work Item**: `doc/sdd/016-wfac-41-circuit-breaker/work-item.md`
- **SDD completo**: `doc/sdd/016-wfac-41-circuit-breaker/sdd.md`
- **Baseline post-WFAC-53**: **435/435 tests passing**
- **Target post-WFAC-41**: **≥ 461/461**
- **Branch**: `feat/016-wfac-41-circuit-breaker` (desde `main` post-WFAC-53)
- **Dependencia nueva (1)**: `cockatiel@3.2.1` (exact pin, instalado en W0)
- **Env vars nuevas (4)**:
  - `CB_ENABLED` (bool, default `true`)
  - `CB_FAILURE_THRESHOLD` (int ≥1, default `5`)
  - `CB_ROLLING_WINDOW_MS` (int ≥1, default `30000`)
  - `CB_RESET_TIMEOUT_MS` (int ≥1, default `10000`)
- **Archivos nuevos (5)**:
  - `src/chains/circuit-breaker.ts` (W2)
  - `src/chains/init-breakers.ts` (W4)
  - `src/__tests__/unit/chains/circuit-breaker.test.ts` (W2)
  - `src/__tests__/unit/chains/init-breakers.test.ts` (W4)
  - (package.json + package-lock.json updates)
- **Archivos modificados (16)**:
  - `src/core/types.ts` (W1)
  - `src/core/errors.ts` (W1)
  - `src/infra/env.ts` (W1)
  - `doc/openapi.yaml` (W1)
  - `src/chains/types.ts` (W3)
  - `src/chains/kite.ts` (W3)
  - `src/chains/avalanche.ts` (W3)
  - `src/app.ts` (W4)
  - `src/routes/verify.ts` (W4)
  - `src/routes/settle.ts` (W4)
  - `src/core/supported.ts` (W4)
  - `src/__tests__/unit/env.test.ts` (W1)
  - `src/__tests__/unit/core/errors.test.ts` (W1)
  - `src/__tests__/unit/routes.openapi.test.ts` (W1)
  - `src/__tests__/unit/chain-adapter.test.ts` (W3)
  - `src/__tests__/unit/routes.verify.test.ts`, `routes.settle.test.ts`, `routes.supported.test.ts` (W4)
- **Orden `buildApp` final**: `Fastify({...})` → `app.decorate('env', env)` → `if(RATE_LIMIT_ENABLED) app.register(rateLimit, ...)` → **`initChainBreakers(app.log)` [NEW W4]** → `app.register(healthRoute)` → `verify/settle/supported/openapi` → `onResponse audit hook` → `onClose redis`.
- **Breaker semantics (DT-4 SDD)**: `SamplingBreaker({threshold:0.5, duration:CB_ROLLING_WINDOW_MS, minimumRps: CB_FAILURE_THRESHOLD / (CB_ROLLING_WINDOW_MS/1000)})` + `halfOpenAfter: CB_RESET_TIMEOUT_MS`.
- **Metrics (AC-12)**: `cb_state` (Gauge), `cb_failures_total` (Counter), `cb_transitions_total` (Counter) — labels `chain`, `chain_id`, + `reason`/`from_state`/`to_state` según métrica.
- **HUs dependientes (future)**:
  - WFAC-42 (BullMQ retry queue) — puede reaccionar a `CHAIN_UNAVAILABLE`.
  - WFAC-52 (Avalanche Fuji real settle) — los stubs que hoy wrappean el breaker serán reemplazados por implementación real; el breaker sigue igual.
  - Backlog: `/metrics` endpoint Prometheus scrape, distributed breaker state (Redis-backed), adaptive thresholds.

---

*Story File generado por NexusAgil — F2.5 — WFAC-41 — 2026-04-23 — Architect*
