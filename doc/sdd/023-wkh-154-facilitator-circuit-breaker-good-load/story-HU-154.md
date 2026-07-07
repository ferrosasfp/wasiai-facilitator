# Story File — HU-154 Circuit breaker: no confundir contención de simulate con chain-unavailable (WKH-154)

- **Work Item**: `doc/sdd/023-wkh-154-facilitator-circuit-breaker-good-load/work-item.md`
- **SDD**: `doc/sdd/023-wkh-154-facilitator-circuit-breaker-good-load/sdd.md`
- **Pipeline**: QUALITY (money-path resiliency — un fix mal hecho debilita la protección real contra un outage de chain genuino; AR+CR obligatorios) · **Sizing**: M · **SDD_MODE**: bugfix + QUALITY
- **Branch**: `fix/154-facilitator-cb-transport-vs-business` (desde `main` — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **798 passed** (confirmá el número exacto con `npm test` antes de W0; el target es baseline + los tests nuevos de W1/W3, todos verdes, **sin editar ninguna assertion existente**).
- **Repo**: `wasiai-facilitator` · **Architect**: nexus-architect · **Fecha**: 2026-07-07

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-154.md`) — **es el único contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — consultá SOLO los relevantes a la wave en curso.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes una ambigüedad y sospeches que este Story File está equivocado. En ese caso → **STOP + reportá al orquestador**.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: fix/154-facilitator-cb-transport-vs-business

git status
# esperado: clean al empezar. Entre waves, solo archivos del Scope IN (§0.5).

npm test -- --run
# baseline esperado antes de W0: 798/798 (confirmá el número real).
# Creciente tras W1 y W3. NUNCA debe bajar el count previo (CD-6: no se borran tests).

npm run typecheck   # tsc --noEmit → 0 errores
npm run lint        # eslint --max-warnings 0 → 0 warnings
```

### 0.3 Anti-Hallucination Checklist (por wave)

**Antes de empezar una wave:**

- [ ] Leíste ESTE Story File end-to-end (incluyendo §3 Constraint Directives y §4 Guardrails).
- [ ] Leíste los exemplars listados para ESTA wave (y solo esos).
- [ ] Verificaste cada import path con `ls`/`Read` antes de escribirlo. **TODOS los imports internos con extensión `.js`** aunque el source sea `.ts` (`./error-classifier.js`, `./chain-mutex.js`, `./circuit-breaker.js`) — ESM `Node16` (CD-ESM). Olvidar el `.js` rompe `npm run build`.
- [ ] Confirmaste que **ningún archivo fuera del Scope IN (§0.5)** va a ser tocado.
- [ ] Confirmaste que las dependencias entre waves (§0.6) están verdes.

**Antes de cerrar una wave:**

- [ ] `npm run typecheck` green (0 errores).
- [ ] `npm run lint` green (eslint `--max-warnings 0`, 0 warnings).
- [ ] `npm run format:check` green (si falla → `npx prettier --write <archivos-de-la-wave>`).
- [ ] `npm test -- --run` pasa el baseline (798) + los tests nuevos de esta wave.
- [ ] **NO modificaste ninguna assertion de test existente** (CD-6). Solo AGREGAR archivos/tests nuevos.
- [ ] **NO agregaste dependencias nuevas** (CD-14). Solo viem (`~2.52.2`) y TS nativo.
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno está violado.

### 0.4 Exemplars verificados (paths confirmados con Read/Glob)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/chains/chain-mutex.ts` (completo, 3.3K) | W0: patrón de **módulo puro** — sin imports runtime de `core/routes/methods/infra`, solo tipos type-only. `error-classifier.ts` sigue exactamente esta disciplina de imports (CD-9). **NO TOCAR este archivo** (CD-2). | W0 |
| E2 | `src/chains/base-adapter.ts` líneas **452-481** (`settle()` wrapper) + **234-267** (`verify()` wrapper) | W2: la forma EXACTA del wrapper actual. El `try { return await this._breaker.execute(async () => { const result = await this._settleRaw(params); if (!result.ok && (code==='SIMULATION_FAILED'||code==='TRANSACTION_FAILED')) throw new BusinessFailureError(result, code); return result; }); } catch (err) { … }` es lo que se modifica en W2.1(c). El `catch` con `BusinessFailureError`→unwrap y `BreakerOpenError`→`CHAIN_UNAVAILABLE 503` **queda intacto**. | W2 |
| E3 | `src/chains/base-adapter.ts` líneas **627-632** (simulate catch), **638-643** (write catch), **652-661** (receipt catch) + `sanitize(e)` líneas **64-67** | W2: los 3 `catch (e)` de `_settleRaw` donde el `e` crudo de viem está en scope. Ahí (y SOLO ahí) se agrega el tag. El error-result se construye con `{ code:'SIMULATION_FAILED'\|'TRANSACTION_FAILED', message: sanitize(e), http:500 }`. `sanitize` se reutiliza tal cual. | W2 |
| E4 | `src/chains/base-adapter.ts` líneas **41-48** (import block de `./circuit-breaker.js`) | W2: dónde agregar el `import` de `./error-classifier.js`. `BusinessFailureError` ya se importa (línea 44) — se reutiliza tal cual, no se renombra. | W2 |
| E5 | `src/chains/circuit-breaker.ts` línea **104** (`class BusinessFailureError`) + línea **77** (`BreakerOpenError`) + línea **252** (`circuitBreaker(handleAll, …)`) | W2 (solo lectura): entender el sentinel `BusinessFailureError(result, code)` que se reutiliza. **PROHIBIDO TOCAR este archivo** (CD-8) — `handleAll` se mantiene. | W2 |
| E6 | `src/__tests__/unit/chains/circuit-breaker.test.ts` (completo, 12.8K) | W1: patrón de unit test puro con mocks/objetos planos + `describe`/`it`/`expect` (vitest). Exemplar estructural para `error-classifier.test.ts`. **NO editar sus assertions** (CD-6, guardián). | W1 |
| E7 | `src/__tests__/unit/chains/settle.failinjection.test.ts` (completo, 16.9K) — esp. `makeMockClients()` (l.62-78) + el patrón `vi.spyOn(mod.kiteTestnetAdapter,'getPublicClient').mockReturnValue(publicClient)` + `vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(...)` (l.145-236) | W3: exemplar EXACTO para `settle.breaker-classification.test.ts`. Import dinámico `await import('../../../chains/kite.js')`, spyOn de `getPublicClient`/`getWalletClient`, `mockRejectedValue`/`mockResolvedValue` sobre `simulateContract`/`writeContract`/`waitForTransactionReceipt`. **NO editar sus assertions** (CD-6). | W3 |
| E8 | `src/__tests__/unit/concurrency.settle.test.ts` (23.6K) — CC-12/13/14 (l.400-506) | W3 (solo lectura, regresión): CC-12/13/14 abren el breaker con `cb.execute(async()=>{throw new Error('boom')})` (errores planos ambiguos → deben SEGUIR contando). **NO editar sus assertions** (CD-6, guardián). | W3 |
| E9 | `src/__tests__/unit/chain-adapter.test.ts` — **T-ADAPT-CB-6** (l.1019-1117) + **T-CB-ACCOUNTING/AC-15** (l.608-648) | W3 (solo lectura, regresión CRÍTICA): T-ADAPT-CB-6 mockea `_verifyRaw` para **RETORNAR** `SIMULATION_FAILED` (sin error viem) y exige que el breaker **ABRA**. T-CB-ACCOUNTING mockea `simulateContract.mockRejectedValue(new Error('sim fail'))` (plano ambiguo) y exige que el breaker ABRA. Ambos DEBEN seguir verdes **sin editar** — el diseño tag+gate lo garantiza (result sin tag → throw → cuenta). | W3 |
| E10 | `doc/sdd/016-wfac-41-circuit-breaker/story-HU-41.md` | Todas: exemplar estructural del Story File más cercano (mismo dominio breaker). Tono, secciones, nivel de detalle. | Todas |
| E11 | `doc/sdd/016-wfac-41-circuit-breaker/auto-blindaje.md` (AR-BLQ-ALTO-1) | Todas: la invariante SamplingBreaker **1 call ↔ 1 outcome** (nunca +1success/+1failure). También: `import type` top-level para tipos externos; no dejar `eslint-disable` sin uso (`--max-warnings 0`). CD-11 / CD-13 nacen de acá. | Todas |

### 0.5 Scope IN — los ÚNICOS archivos que podés tocar

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `src/chains/error-classifier.ts` | **CREATE** (`ChainErrorClass`, `classifyChainError`, `BREAKER_CLASS` símbolo, `tagBusiness`, `isTaggedBusiness`) | W0 |
| 2 | `src/__tests__/unit/chains/error-classifier.test.ts` | **CREATE** (EC-1..EC-13, unit puro con objetos planos) | W1 |
| 3 | `src/chains/base-adapter.ts` | **MODIFY** (import del classifier; tag en los 3 catch de `_settleRaw`; gate en `settle()` y `verify()`) | W2 |
| 4 | `src/__tests__/unit/chains/settle.breaker-classification.test.ts` | **CREATE** (BC-1..BC-5, integración a través de `settle()` real con clients mockeados) | W3 |

**Cualquier edit a cualquier otro archivo = violación del Story File. STOP AND REPORT.**

En particular, estos archivos están **CONGELADOS** para esta HU:

- `src/chains/circuit-breaker.ts` — **PROHIBIDO TOCAR (CD-8)**. `handleAll` se mantiene. NADA de cambiarlo a `handleWhen`. `recordBusinessFailure` no se toca.
- `src/chains/chain-mutex.ts` / `runExclusive` — **PROHIBIDO TOCAR (CD-2)**. El mutex funciona (0 reverts en 40 txs, nonces monótonos).
- `src/core/idempotency.ts` y el orden `lock→breaker→mutex→broadcast` — **PROHIBIDO reordenar (CD-3)**.
- `src/__tests__/unit/chains/circuit-breaker.test.ts`, `src/__tests__/unit/concurrency.settle.test.ts`, `src/__tests__/unit/chain-adapter.test.ts`, `src/__tests__/unit/chains/settle.failinjection.test.ts`, `chains.base.test.ts` — **PROHIBIDO editar sus assertions (CD-6)**. Solo se AGREGAN los 2 archivos de test nuevos (Scope IN #2 y #4).
- `wasiai-a2a` (gateway), thresholds del breaker (`CB_*` env vars), folder `022/` — fuera de scope.

### 0.6 Wave dependency graph

```
W0 (src/chains/error-classifier.ts — módulo puro, contratos/tipos)
 │
 ├─────────────► W1 (error-classifier.test.ts — testea W0 en aislamiento)
 │
 ▼
W2 (base-adapter.ts — import + tag en los 3 catch + gate en settle()/verify())
 │
 ▼
W3 (settle.breaker-classification.test.ts — integración vía settle() real
      + regresión global: guardianes T-ADAPT-CB-6 / T-CB-ACCOUNTING / CC-12/13/14)
```

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1 | W0 | testea el clasificador recién creado |
| W2 | W0 | usa `classifyChainError`/`tagBusiness`/`isTaggedBusiness` |
| W3 | W2 | integración a través del `settle()` ya cableado |

- **Sin forward references.** Si W0/W1 necesitan algo de W2/W3, hay bug de diseño → **STOP + REPORT**.

---

## 1. Waves

### Wave 0 (SERIAL, gate) — `src/chains/error-classifier.ts` (CREATE)

**Objetivo**: módulo puro, determinista, con el clasificador + el tag no-enumerable. Sin wiring todavía. Compila y lintea limpio.

#### Files (W0)

| # | Path | Acción |
|---|------|--------|
| 1 | `src/chains/error-classifier.ts` | **CREATE** |

#### W0.1 — Imports permitidos (CD-9)

Módulo **puro**. PROHIBIDO importar runtime de `src/core/*`, `src/routes/*`, `src/methods/*`, `src/infra/*`. Tipos externos (viem/pino) SOLO `import type` top-level (CD-13). En la práctica este módulo **no necesita ningún import** — es lógica pura sobre `unknown`. No agregues imports que no uses (`--max-warnings 0`).

#### W0.2 — API pública exacta

```ts
export type ChainErrorClass = 'transport' | 'business';

export function classifyChainError(err: unknown): ChainErrorClass;

// Marcador no-enumerable (CD-10). NO string key, NO enumerable.
// unique symbol — invisible a toEqual / toMatchObject / JSON.stringify / spread.
export function tagBusiness<T extends object>(result: T): T;   // muta y retorna result
export function isTaggedBusiness(result: unknown): boolean;
```

- El símbolo: `const BREAKER_CLASS: unique symbol = Symbol('breakerClass');` (módulo-privado, NO exportar el símbolo directamente — exportá solo `tagBusiness`/`isTaggedBusiness`).
- `tagBusiness(result)`:
  `Object.defineProperty(result, BREAKER_CLASS, { value: 'business', enumerable: false, configurable: true });` y `return result;`
- `isTaggedBusiness(result)`: guard de tipo `result !== null && typeof result === 'object'`, luego leer `(result as Record<symbol, unknown>)[BREAKER_CLASS] === 'business'`.

#### W0.3 — Algoritmo `classifyChainError` (orden ESTRICTO — business PRIMERO, CD-12)

1. **Walk de la cadena de causas** `err → err.cause → err.cause.cause → …`:
   - Cap de profundidad ~10; guard anti-ciclos (p.ej. `Set` de nodos visitados o simplemente el cap de 10).
   - Por cada nodo, extraé de forma defensiva (duck-typing, **NO `instanceof`** — CD-9):
     - `name`: `string` (de `node.name`).
     - `code`: `string | number` (Node `ECONNREFUSED`, o RPC `-32603`/`3`).
     - `status`: `number` (HTTP, de `HttpRequestError.status`).
     - `blob`: texto lowercased = concatenación de `message` + `shortMessage` + `details` + (`metaMessages` si es array → `.join(' ')`). Todo lo que falte se ignora sin throw.
   - `err` puede ser `undefined`/`null`/string/número → tolerarlo sin throw (cae al default fail-safe, EC-11).

2. **BUSINESS (no cuenta) — se evalúa PRIMERO.** Retornar `'business'` si CUALQUIER nodo cumple alguna de:
   - `name` ∈ {
     `ExecutionRevertedError`, `ContractFunctionRevertedError`, `ContractFunctionZeroDataError`,
     `InsufficientFundsError`, `NonceTooLowError`, `NonceTooHighError`, `NonceMaxValueError`,
     `IntrinsicGasTooLowError`, `IntrinsicGasTooHighError`, `TipAboveFeeCapError`,
     `FeeCapTooLowError`, `FeeCapTooHighError` }
     — **NOTA:** `EstimateGasExecutionError` / `ContractFunctionExecutionError` / `CallExecutionError` **NO** están en este set (son wrappers; se clasifican por su causa + substrings).
   - `code === 3` (EVM execution reverted) **o** `code === 'CALL_EXCEPTION'`.
   - `blob` contiene ALGUNA substring:
     `gas required exceeds allowance` · `execution reverted` · `insufficient funds` ·
     `nonce too low` · `nonce too high` · `already known` ·
     `replacement transaction underpriced` · `authorization is used` · `authorization used` ·
     `transfer amount exceeds balance` · `intrinsic gas too low`.
   > **`gas required exceeds allowance` es el crux Chaski.** Llega como error JSON-RPC (HTTP 200 + body de error → viem lo parsea a `RpcRequestError`/`EstimateGasExecutionError`), NO como fallo HTTP. Por eso el match por substring de business ANTES que el nombre de transporte es esencial (CD-12): un `RpcRequestError` que lleva "gas required exceeds allowance" debe ganar como **business**.

3. **TRANSPORT (cuenta).** Si no matcheó business, retornar `'transport'` si CUALQUIER nodo:
   - `name` ∈ {
     `HttpRequestError`, `TimeoutError`, `SocketClosedError`, `WebSocketRequestError`,
     `RpcRequestError`, `InternalRpcError`, `ResourceUnavailableRpcError`, `LimitExceededRpcError`,
     `ParseRpcError`, `ProviderDisconnectedError`, `ChainDisconnectedError`, `UnknownRpcError` }
   - `status` (HTTP) `>= 500`
   - `code` ∈ { `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `ECONNABORTED`, `EHOSTUNREACH`, `ENETUNREACH` }
   - `blob` contiene: `fetch failed` · `econnrefused` · `econnreset` · `etimedout` · `enotfound` ·
     `eai_again` · `socket hang up` · `connection refused` · `connection reset` · `network error` ·
     `request timed out` · `took too long` · `timeout`.

4. **DEFAULT — AC-5 fail-safe conservador** → `return 'transport'` (cuenta). Cualquier caso no clasificado (`new Error('x')`, string, `undefined`, `null`) cae acá. **NUNCA default a business.**

> **Recomendación de implementación:** recolectá primero TODOS los nodos en un array (walk único), luego evaluá el predicado business sobre todos los nodos, y si ninguno matchea, evaluá el predicado transport sobre todos. Así garantizás business-antes-transport a nivel global (no por-nodo), que es lo que exige EC-12 (`EstimateGasExecutionError` con causa `RpcRequestError` + substring business → business).

#### Wave 0 — completion criteria

- [ ] `src/chains/error-classifier.ts` existe con `ChainErrorClass`, `classifyChainError`, `tagBusiness`, `isTaggedBusiness` exportados.
- [ ] `BREAKER_CLASS` es un `unique symbol` **no exportado**, usado con `enumerable: false` (CD-10).
- [ ] **CERO `instanceof`** en el archivo (`grep -c "instanceof" src/chains/error-classifier.ts` → 0). Solo duck-typing (CD-9).
- [ ] **CERO imports runtime** de `core/routes/methods/infra` (CD-9). `grep -nE "from '\.\./(core|routes|methods|infra)/" src/chains/error-classifier.ts` → 0 matches.
- [ ] `npm run typecheck` green · `npm run lint` green · `npm run format:check` green.

---

### Wave 1 (parallelizable con W2, pero recomendado primero) — `error-classifier.test.ts` (CREATE)

**Objetivo**: probar el clasificador en aislamiento con objetos error planos (duck-typed), sin RPC real (CD-4).

#### Files (W1)

| # | Path | Acción |
|---|------|--------|
| 2 | `src/__tests__/unit/chains/error-classifier.test.ts` | **CREATE** |

#### W1.1 — Tests EC-1..EC-13 (input mock → esperado)

Import: `import { classifyChainError, tagBusiness, isTaggedBusiness } from '../../../chains/error-classifier.js';` (verificá la profundidad de `../` contra `E6`/`E7` — los tests en `src/__tests__/unit/chains/` usan `../../../chains/…`).

| Test | AC | Input (objeto plano) → esperado |
|------|----|-----|
| EC-1 | AC-1 | `{ name:'EstimateGasExecutionError', details:'gas required exceeds allowance (24468/11800/62584)' }` → `'business'` (crux Chaski) |
| EC-2 | AC-1 | `{ name:'ContractFunctionRevertedError', message:'execution reverted: FiatTokenV2: authorization is used' }` → `'business'` |
| EC-3 | AC-1 | `{ name:'InsufficientFundsError', message:'insufficient funds' }` → `'business'` |
| EC-4 | AC-1 | `{ name:'NonceTooLowError', message:'nonce too low' }` → `'business'`; y `{ message:'already known' }` → `'business'` |
| EC-5 | AC-2 | `{ name:'HttpRequestError', status:503 }` → `'transport'` |
| EC-6 | AC-2 | `{ name:'TimeoutError', message:'took too long' }` → `'transport'` |
| EC-7 | AC-2 | `{ cause:{ code:'ECONNREFUSED' } }` → `'transport'`; idem `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` |
| EC-8 | AC-2 | `{ message:'fetch failed' }` → `'transport'` |
| EC-9 | AC-2 | `{ name:'RpcRequestError', message:'internal error', code:-32603 }` (sin substring business) → `'transport'` |
| EC-10 | AC-5 | `new Error('some weird thing')` → `'transport'` (fail-safe) |
| EC-11 | AC-5 | `'raw string'` → `'transport'`; `undefined` → `'transport'`; `null` → `'transport'` (fail-safe, **sin throw**) |
| EC-12 | AC-1 / CD-12 | `{ name:'EstimateGasExecutionError', cause:{ name:'RpcRequestError', message:'gas required exceeds allowance' } }` → `'business'` (business gana sobre transport-name) |
| EC-13 | AC-2 | `{ name:'EstimateGasExecutionError', cause:{ name:'TimeoutError', message:'took too long' } }` → `'transport'` (wrapper con causa transport → cuenta) |

Agregá además **2 tests del tag** (mismo archivo):
- **EC-TAG-1 (CD-10)**: `const r = { ok:false, error:{ code:'SIMULATION_FAILED' } }; tagBusiness(r);` → `isTaggedBusiness(r) === true` **Y** `Object.keys(r)` NO incluye el tag **Y** `JSON.parse(JSON.stringify(r))` no lo contiene **Y** `expect({ ...r }).toEqual(r)` (el spread de claves string es idéntico) — demuestra invisibilidad a serialización/forma.
- **EC-TAG-2 (CD-10)**: un objeto sin taggear → `isTaggedBusiness(r) === false`; `isTaggedBusiness(undefined)` / `isTaggedBusiness('x')` → `false` sin throw.

#### Wave 1 — completion criteria

- [ ] 13 tests EC-* + 2 tests EC-TAG-* verdes contra W0.
- [ ] `npm run typecheck` / `lint` / `format:check` green.
- [ ] Baseline previo intacto (ningún test existente editado).

---

### Wave 2 (SERIAL) — wiring en `base-adapter.ts` (MODIFY)

**Objetivo**: taguear los fallos de negocio en el punto donde el `e` crudo de viem existe, y gatear el wrapper para que los business-tagged NO cuenten hacia el breaker, preservando el conteo legacy para todo lo demás.

#### Files (W2)

| # | Path | Acción |
|---|------|--------|
| 3 | `src/chains/base-adapter.ts` | **MODIFY** |

#### W2.1(a) — Import del classifier

Junto al import de `./circuit-breaker.js` (líneas 41-48, ver E4), agregá:

```ts
import { classifyChainError, tagBusiness, isTaggedBusiness } from './error-classifier.js';
```

`BusinessFailureError` **ya está importado** (línea 44) — reutilizalo tal cual, NO lo renombres.

#### W2.1(b) — Tag en los 3 `catch (e)` de `_settleRaw`

En CADA uno de los 3 catch donde el `e` crudo está en scope (E3: simulate l.627-632, write l.638-643, receipt l.652-661), **antes de retornar** el error-result, clasificá y tagueá **solo si es business**:

Patrón (aplicá a los 3, adaptando el `code`/`message` que ya construye cada bloque):

```ts
} catch (e) {
  const result: AdapterResult<SettleResult> = {
    ok: false,
    error: { code: 'SIMULATION_FAILED', message: sanitize(e), http: 500 },
  };
  if (classifyChainError(e) === 'business') tagBusiness(result);
  return result;
}
```

- Simulate catch → `code: 'SIMULATION_FAILED'`, `message: sanitize(e)` (idéntico a hoy).
- Write catch → `code: 'TRANSACTION_FAILED'`, `message: sanitize(e)`.
- Receipt catch → `code: 'TRANSACTION_FAILED'`, `message: msg` (mantené la lógica actual del `msg` = `'receipt timeout'` para `WaitForTransactionReceiptTimeoutError`, sino `sanitize(e)`). Clasificá con `classifyChainError(e)` (el `e` crudo, no el `msg`).
- **NO taguees** el caso de `receipt.status === 'reverted'` (l.664-673): ahí NO hay `e` crudo. Queda sin tag → el wrapper lo throwea → cuenta (comportamiento legacy preservado; y T-ADAPT-CB style guardianes lo esperan). No lo toques más allá de dejarlo como está.
- **Transporte/ambiguo → sin tag** → el default del wrapper (W2.1(c)) lo cuenta.

#### W2.1(c) — Gate en `settle()` (y por simetría `verify()`)

En el wrapper `settle()` (E2, l.454-463), reemplazá la condición de throw. **Antes:**

```ts
return await this._breaker.execute(async () => {
  const result = await this._settleRaw(params);
  if (!result.ok && (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
    throw new BusinessFailureError(result, result.error.code);
  }
  return result;
});
```

**Después:**

```ts
return await this._breaker.execute(async () => {
  const result = await this._settleRaw(params);
  if (!result.ok && (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
    // WKH-154: contención/negocio tagueada en _settleRaw NO cuenta hacia el
    // breaker (return = outcome resuelto para cockatiel). Transporte/ambiguo
    // (sin tag) SÍ cuenta (throw legacy). Preserva la invariante 1↔1 (CD-11).
    if (isTaggedBusiness(result)) {
      return result;
    }
    throw new BusinessFailureError(result, result.error.code);
  }
  return result;
});
```

- El `catch (err)` externo (l.464-480) **queda intacto**: `BusinessFailureError`→unwrap `err.result`, `BreakerOpenError`→`CHAIN_UNAVAILABLE 503` + `retryAfterMs`. El caller ve el `AdapterResult` idéntico a hoy (el tag es invisible, CD-10).
- Aplicá **el mismo cambio por simetría** en `verify()` (E2, l.236-245). En la práctica `_verifyRaw` no hace RPC → nunca taguea → `isTaggedBusiness(result)` siempre `false` → throw legacy → comportamiento **idéntico** a hoy (cambio behavior-preserving; se hace por consistencia y para blindar el path si `_verifyRaw` ganara RPC en el futuro).

#### W2.1 — restricciones duras

- **PROHIBIDO** tocar `src/chains/circuit-breaker.ts` (CD-8). `handleAll` se mantiene.
- **PROHIBIDO** llamar `recordBusinessFailure` dentro de `_breaker.execute` (CD-11).
- **PROHIBIDO** agregar cualquier campo **enumerable** al `AdapterResult`/`error` (CD-10). El único marcador es el símbolo no-enumerable via `tagBusiness`.
- **PROHIBIDO** reordenar `lock→breaker→mutex→broadcast` o tocar `runExclusive` (CD-2/CD-3).

#### Wave 2 — completion criteria

- [ ] Los 3 catch de `_settleRaw` tagean **solo** cuando `classifyChainError(e) === 'business'`.
- [ ] `settle()` y `verify()` hacen `return result` si `isTaggedBusiness(result)`, sino `throw BusinessFailureError`.
- [ ] `grep -c "instanceof" src/chains/circuit-breaker.ts` sin cambios (archivo intacto — CD-8). `git diff --stat` NO debe listar `circuit-breaker.ts` ni `chain-mutex.ts`.
- [ ] `npm run typecheck` / `lint` / `format:check` green.
- [ ] **Suite existente verde SIN editar assertions** (CD-6): `npm test -- --run` — en particular `circuit-breaker.test.ts`, `concurrency.settle.test.ts` (CC-12/13/14), `chain-adapter.test.ts` (T-ADAPT-CB-6, T-CB-ACCOUNTING/AC-15), `settle.failinjection.test.ts`, `chains.base.test.ts`. Si alguno rompe → STOP: el diseño tag+gate está mal aplicado (revisá que transporte/ambiguo quede SIN tag).

---

### Wave 3 (SERIAL, final) — `settle.breaker-classification.test.ts` (CREATE) + regresión global

**Objetivo**: probar el accounting a través del `settle()` real con clients viem mockeados que lanzan errores tipados, + correr la suite completa.

#### Files (W3)

| # | Path | Acción |
|---|------|--------|
| 4 | `src/__tests__/unit/chains/settle.breaker-classification.test.ts` | **CREATE** |

#### W3.1 — Tests BC-1..BC-5

Seguí EXACTAMENTE el patrón de `settle.failinjection.test.ts` (E7): `makeMockClients()`, `await import('../../../chains/kite.js')`, `vi.spyOn(mod.kiteTestnetAdapter,'getPublicClient'/'getWalletClient').mockReturnValue(...)`, `vi.mocked(publicClient.simulateContract).mockRejectedValue(...)`. Para leer el estado del breaker usá el getter público del adapter (`getBreakerState()` — verificá el nombre exacto en `chain-adapter.test.ts`/`circuit-breaker.ts`; el SDD lo refiere como `getState()`/`getBreakerState()`). Sin RPC real ni fondos (CD-4/CD-5).

| Test | AC | Escenario → esperado |
|------|----|-----|
| BC-1 | AC-1 | `simulateContract.mockRejectedValue(<error contención business>)` (p.ej. `Object.assign(new Error('gas required exceeds allowance (24468/11800/62584)'), { name:'EstimateGasExecutionError' })`), disparar N `settle()` → breaker **CLOSED**, ningún resultado `CHAIN_UNAVAILABLE`. |
| BC-2 | AC-2 / CD-1 | `simulateContract.mockRejectedValue(<HttpRequestError status:503 / TimeoutError>)` N veces → breaker **OPEN** → el siguiente `settle()` retorna `error.code === 'CHAIN_UNAVAILABLE'`, `http:503`, `retryAfterMs > 0`. **Este test protege CD-1: outage real SIGUE abriendo el breaker.** |
| BC-3 | AC-3 | Burst: N-1 sim-fails de contención (business) + 1 `simulateContract` que resuelve OK y broadcastea (`writeContract`→hash, `waitForTransactionReceipt`→`status:'success'`) → `getBreakerState() === 'CLOSED'` **Y** el settle bueno retorna `settled:true` / `ok:true` (sin 503). **Este es el AC crítico (CD-7): burst N-1 business + 1 ok → CLOSED, settle bueno sin 503.** |
| BC-4 | AC-5 | `simulateContract.mockRejectedValue(new Error('sim fail'))` (ambiguo) N veces → breaker **OPEN** (fail-safe cuenta) — refleja legacy. |
| BC-5 | AC-1 / CD-10 | Un business sim-fail → el caller recibe `error.code === 'SIMULATION_FAILED'` con la forma **idéntica** a hoy (el tag es invisible: `Object.keys(result.error)` sin claves extra; `JSON.stringify(result)` sin el tag). Solo cambió el accounting. |

> Nota de aislamiento: replicá el `beforeEach`/`afterEach` con `vi.restoreAllMocks()`/reset de breaker que use `settle.failinjection.test.ts`, para que N settles cuenten sobre un breaker limpio por test. Verificá el mecanismo de reset del breaker que usan los tests existentes (no inventes uno).

#### W3.2 — Regresión global (sin editar assertions — CD-6)

```bash
npm run typecheck      # 0 errores
npm run lint           # 0 warnings (--max-warnings 0)
npm run format:check   # green
npm test -- --run      # baseline (798) + EC-* (W1) + BC-* (W3), todo verde
```

Confirmá explícitamente verdes los **guardianes**:
- `circuit-breaker.test.ts` (el work-item cita 39/39 — la métrica operativa es: verde sin editar assertions).
- `concurrency.settle.test.ts` — **CC-12/13/14** (errores planos ambiguos → cuentan).
- `chain-adapter.test.ts` — **T-ADAPT-CB-6** (SIMULATION_FAILED retornado sin error viem → cuenta → abre) + **T-CB-ACCOUNTING/AC-15** (`new Error('sim fail')` → cuenta → abre).
- `settle.failinjection.test.ts` + `chains.base.test.ts`.

Si CUALQUIER guardián requiere editar su assertion para pasar → **STOP + REPORT**: el fix está mal (viola CD-6).

#### Wave 3 — completion criteria

- [ ] BC-1..BC-5 verdes.
- [ ] Suite completa verde (baseline + EC-* + BC-*), 0 assertions existentes editadas.
- [ ] `npm run qa` (typecheck + lint + format:check + test) green de punta a punta.
- [ ] `git diff --stat` lista SOLO los 4 archivos del Scope IN (§0.5).

---

## 2. Patrones a seguir (referencia rápida)

- **Módulo puro** (`error-classifier.ts`): imita `chain-mutex.ts` (E1) — sin imports runtime de capas superiores; tipos externos type-only.
- **Duck-typing, no `instanceof`** (CD-9): inspeccioná `name`/`code`/`status`/mensaje. Nunca `err instanceof HttpRequestError`.
- **Tag no-enumerable** (CD-10): `Object.defineProperty(..., { enumerable:false, configurable:true })`. Nunca una clave string enumerable.
- **Tests de integración**: `makeMockClients()` + `vi.spyOn(adapter,'getPublicClient'/'getWalletClient')` + `vi.mocked(client.method).mockRejectedValue(...)` (E7). Import dinámico `await import('../../../chains/kite.js')`.
- **ESM `.js`** en todos los imports internos (E7 usa `../../../chains/kite.js`).

## 3. Constraint Directives (heredados — INVIOLABLES)

- **CD-1**: PROHIBIDO debilitar la protección contra outage genuino. Outage transporte/RPC SIGUE abriendo el breaker (AC-2). → verificado por **BC-2**.
- **CD-2**: PROHIBIDO tocar `chain-mutex.ts` / `runExclusive`.
- **CD-3**: PROHIBIDO doble-settle o reordenar `lock→breaker→mutex→broadcast`.
- **CD-4**: OBLIGATORIO clasificador determinista, testeable sin RPC real (mocks).
- **CD-5**: PROHIBIDO gastar fondos / settle real en Fuji.
- **CD-6**: OBLIGATORIO tests existentes verdes **sin editar assertions**. Solo AGREGAR. Guardianes: T-ADAPT-CB-6, T-CB-ACCOUNTING/AC-15, CC-12/13/14.
- **CD-7**: PROHIBIDO DONE sin QA citando archivo:línea del punto de clasificación + del test AC-3 (BC-3: burst N-1 business + 1 ok → CLOSED, sin 503).
- **CD-8**: PROHIBIDO tocar `circuit-breaker.ts`. `handleAll` se mantiene. Clasificación 100% en `base-adapter.ts` + `error-classifier.ts`.
- **CD-9**: `error-classifier.ts` puro (sin imports runtime de core/routes/methods/infra); duck-typing, no `instanceof`.
- **CD-10**: tag = símbolo **no-enumerable**; PROHIBIDO campos enumerables en `AdapterResult`/`error`.
- **CD-11**: preservar invariante 1-call↔1-outcome (auto-blindaje 016). PROHIBIDO `recordBusinessFailure` dentro de `_breaker.execute`.
- **CD-12**: matchear **business ANTES que transport** (orden estricto) — `gas required exceeds allowance` transportado por `RpcRequestError` → business.
- **CD-13**: `import type` top-level para tipos externos; PROHIBIDO `import()` inline y `eslint-disable` sin uso (`--max-warnings 0`).
- **CD-14**: PROHIBIDO deps nuevas. Solo viem (presente) + TS nativo.
- **CD-ESM**: imports internos con extensión `.js` (Node16/ESM).

## 4. Guardrails anti-drift

1. `git diff --stat` al cerrar cada wave: SOLO los archivos del Scope IN (§0.5). Cualquier otro → STOP.
2. `circuit-breaker.ts` y `chain-mutex.ts` NUNCA aparecen en el diff (CD-2/CD-8).
3. Ninguna assertion de test existente editada (CD-6). Solo se crean `error-classifier.test.ts` + `settle.breaker-classification.test.ts`.
4. Cero `instanceof` en `error-classifier.ts`; cero imports runtime de capas superiores (CD-9).
5. El tag es no-enumerable — `Object.keys` / `JSON.stringify` / spread nunca lo revelan (CD-10), probado en EC-TAG-1 y BC-5.
6. Default del clasificador = `'transport'` (cuenta), nunca `'business'` (CD-1/AC-5).
7. `npm run qa` verde antes de reportar DONE de la wave.

## 5. Done Definition (F3 completa cuando)

- [ ] Los 4 archivos del Scope IN creados/modificados exactamente como se especifica.
- [ ] `npm run typecheck` = 0 errores · `npm run lint` = 0 warnings · `npm run format:check` green.
- [ ] `npm test -- --run` = baseline (798) + EC-1..EC-13 + EC-TAG-1/2 + BC-1..BC-5, **todo verde, 0 assertions existentes editadas**.
- [ ] Guardianes verdes: T-ADAPT-CB-6, T-CB-ACCOUNTING/AC-15, CC-12/13/14, `circuit-breaker.test.ts`, `settle.failinjection.test.ts`, `chains.base.test.ts`.
- [ ] AC-1..AC-5 cubiertos: AC-1→EC-1..4/BC-1/BC-5; AC-2→EC-5..9/EC-13/BC-2; AC-3→BC-3; AC-4→suite verde + tests nuevos; AC-5→EC-10/11/BC-4.
- [ ] `git diff --stat` lista solo los 4 archivos del Scope IN.
- [ ] Reportá al orquestador: archivos tocados + resultado de la suite + confirmación de guardianes.

---

*Story File generado por NexusAgil (nexus-architect) — F2.5 — WKH-154 / #023. El Dev sigue este contrato al pie de la letra; no lee work-item.md ni sdd.md salvo ambigüedad detectada.*
