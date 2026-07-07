# SDD #023: [BUG] Circuit breaker — no confundir contención de simulate con chain-unavailable (WKH-154)

> SPEC_APPROVED: no
> Fecha: 2026-07-07
> Tipo: bugfix (money-path resiliency hardening)
> SDD_MODE: bugfix + QUALITY (waves + test plan completos; AR + CR obligatorios)
> Branch: `fix/154-facilitator-cb-transport-vs-business`
> Artefactos: `doc/sdd/023-wkh-154-facilitator-circuit-breaker-good-load/`
> Repo: `wasiai-facilitator`

---

## 1. Resumen del bug

Chaski multi-step daba **$0** en settles concurrentes. Causa raíz final (verificada
on-chain): el **circuit breaker per-chain** del facilitator abre ante **contención de
simulación** y devuelve `503 CHAIN_UNAVAILABLE` a settles **buenos** durante ~10s,
convirtiendo un fallo parcial de un batch en un fallo total.

El breaker (`circuit-breaker.ts:252`, cockatiel `circuitBreaker(handleAll, …)`) cuenta
**cualquier** throw dentro de `policy.execute(fn)` como una falla de disponibilidad de
chain. El adapter (`base-adapter.ts:452-463`) convierte **todo** `SIMULATION_FAILED` /
`TRANSACTION_FAILED` en un `throw BusinessFailureError` dentro de `_breaker.execute(...)`.
El artefacto `gas required exceeds allowance (24468/11800/62584)` de `eth_estimateGas`
(coreth) bajo llamadas concurrentes same-account es un **fallo determinístico de
contención**, NO un outage de RPC — pero hoy cuenta 1:1 igual que un RPC caído. En un
burst multi-step (~70% de los simulates fallan por contención) el `SamplingBreaker` cruza
el umbral 0.5 y **se abre**, tirando el tráfico sano.

**Fix (sin código en este SDD):** clasificar la causa del error en el punto donde el
error crudo de viem está disponible (los `catch` de `_settleRaw`) y **excluir del conteo
del breaker** los fallos de negocio/contención, **manteniendo** el conteo de los fallos
genuinos de transporte/RPC. Diseño resuelto en §5 (DT-4).

El mutex de nonce (`chain-mutex.ts` / `runExclusive`, commit `15884bd4`) está confirmado
funcionando (0 reverts en 40 txs, nonces monótonos) — **NO se toca** (CD-2).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 023 (WKH-154) |
| **Tipo** | bugfix / money-path-hardening |
| **SDD_MODE** | bugfix + QUALITY |
| **Objetivo** | Que la contención de `simulateContract` NO abra el breaker, mientras que un outage genuino de RPC SÍ lo abra. |
| **Reglas de negocio** | Fail-safe conservador (AC-5): ambiguo → cuenta. Nunca debilitar la detección de outage real (CD-1). |
| **Scope IN** | `src/chains/error-classifier.ts` (NUEVO), `src/chains/base-adapter.ts` (clasificación en los `catch` de `_settleRaw` + gate en el wrapper `settle()`/`verify()`), tests nuevos deterministas. |
| **Scope OUT** | `chain-mutex.ts`/`runExclusive`; thresholds del breaker; `wasiai-a2a` gateway; settle real en Fuji; folder `022`. |
| **Missing Inputs** | DT-4 (heurística exacta transporte-vs-business) — **RESUELTO en este SDD, §5**. Smoke real post-deploy — fuera del pipeline (CD-5). |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN `_settleRaw` retorna un fallo clasificado como business/contención
  (revert de contrato, `SIMULATION_FAILED` por contención de `estimateGas` same-account,
  o `TRANSACTION_FAILED` sin firma de transporte/RPC), THE system SHALL excluir ese fallo
  del conteo del `SamplingBreaker` (no incrementa su ratio).
- **AC-2**: WHEN ocurre un fallo genuino de transporte/RPC (timeout de conexión, RPC
  caído, error de red), THE system SHALL seguir contando ese fallo hacia el breaker,
  preservando la protección contra un outage real.
- **AC-3**: WHILE un burst produce N-1 fallos de simulate por contención + 1 settle
  exitoso, THE system SHALL mantener el breaker CLOSED y el settle bueno SHALL completar
  sin `503 CHAIN_UNAVAILABLE`.
- **AC-4**: WHEN corre la suite, THE system SHALL mantener verdes `circuit-breaker.test.ts`
  y `concurrency.settle.test.ts` **sin modificar sus assertions**, Y SHALL incluir un test
  nuevo determinista del clasificador (mocks transporte-vs-business, sin RPC real).
- **AC-5**: IF el clasificador no puede determinar con certeza la causa, THEN THE system
  SHALL tratarlo como fallo contable (default a "SÍ cuenta").

---

## 3. Reproducción

### Repro (conceptual, sin gastar fondos)
1. Disparar N settles concurrentes al mismo chain/cuenta operadora (batch multi-step).
2. El mutex serializa la sección on-chain; mientras una tx está in-flight, los
   `simulateContract` de las siguientes fallan con `gas required exceeds allowance
   (X/Y/Z)` (artefacto de `eth_estimateGas` de coreth por contención same-account).
3. Cada uno se mapea a `SIMULATION_FAILED` → `throw BusinessFailureError` →
   cockatiel cuenta +1 failure.
4. Con >50% de fallos en la ventana de 30s, el `SamplingBreaker` **abre**.

### Actual
Los settles buenos posteriores reciben `503 CHAIN_UNAVAILABLE` durante `resetTimeoutMs`
(~10s). El batch falla completo → **$0**. La chain estaba sana (0 reverts on-chain).

### Expected
La contención (fallo determinístico, no-outage) NO cuenta hacia el breaker → el breaker
permanece CLOSED → los settles buenos completan. Un outage REAL de RPC (timeouts,
conexión rechazada, 5xx) SIGUE abriendo el breaker.

---

## 4. Context Map (Codebase Grounding)

### Archivos leídos
| Archivo | Por qué | Hallazgo |
|---------|---------|----------|
| `src/chains/circuit-breaker.ts` | Punto de conteo | `circuitBreaker(handleAll, …)` (l.252) cuenta **cualquier** throw en `policy.execute`. `execute()` (l.305-324) traduce `BrokenCircuitError`→`BreakerOpenError`. `recordBusinessFailure` (l.333) es API legacy solo-tests. `BusinessFailureError` (l.104) es el sentinel que hoy cuenta business-fails. |
| `src/chains/base-adapter.ts` | Punto de clasificación | `settle()` (l.452-481) envuelve `_settleRaw` en `_breaker.execute` y hace `throw BusinessFailureError` para **todo** `SIMULATION_FAILED`/`TRANSACTION_FAILED`. Los `catch` de `_settleRaw` (simulate l.627-632, write l.638-643, receipt l.652-661) colapsan **cualquier** excepción a esos 2 códigos vía `sanitize(e)` — el error crudo `e` de viem está disponible ahí y se descarta. `runExclusive` envuelve la sección on-chain (l.603-686). `_verifyRaw` NO hace RPC (recover local) → nunca produce `SIMULATION_FAILED`/`TRANSACTION_FAILED`. |
| `src/chains/chain-mutex.ts` | Confirmar release-on-throw | `runExclusive` (l.42-71) encadena `previous.then(fn, fn)`; propaga el rejection de `fn` al caller (`return run`) y avanza el tail con `.then(()=>undefined,()=>undefined)` → un throw dentro del callback **se propaga** y **no envenena** la cola. Un `throw` desde `_settleRaw` es seguro. **No se modifica (CD-2).** |
| `src/__tests__/unit/chains/circuit-breaker.test.ts` | Regresión CD-6 | `forceOpen` usa `recordBusinessFailure` (plain error). Tests fuerzan open con **errores planos** → deben seguir contando. |
| `src/__tests__/unit/concurrency.settle.test.ts` (l.400-506) | Regresión CD-6 | CC-12/13/14 abren el breaker con `cb.execute(async()=>{throw new Error('boom')})` — **errores planos ambiguos** → deben contar (fail-safe). |
| `src/__tests__/unit/chain-adapter.test.ts` (l.1019-1117, l.608-648) | **Guardianes de regresión críticos** | **T-ADAPT-CB-6** mockea `_verifyRaw` para **RETORNAR** `SIMULATION_FAILED` (sin error viem) y exige que el breaker **ABRA** → un `SIMULATION_FAILED` retornado **sin tag** debe seguir contando. **T-CB-ACCOUNTING (AC-15)** mockea `simulateContract.mockRejectedValue(new Error('sim fail'))` (error plano ambiguo) y exige que el breaker ABRA → ambiguo debe contar. |
| `src/__tests__/unit/chains/settle.failinjection.test.ts` (l.142-211) | Patrón de test + regresión | Inyecta reverts de negocio (`'execution reverted: FiatTokenV2: authorization is used'`, `'nonce too low / replacement transaction underpriced'`) pero **solo** asserta el código retornado + money-safety, **NO** el estado del breaker → clasificarlos business no rompe nada. `makeMockClients` + `vi.spyOn(getPublicClient/getWalletClient)` es el **exemplar** para el test de integración nuevo. |
| `doc/sdd/016-wfac-41-circuit-breaker/auto-blindaje.md` | Aprendizaje histórico | AR-BLQ-ALTO-1: la invariante SamplingBreaker es **1 call ↔ 1 outcome**; el patrón "inner execute fire-and-forget" (+1success/+1failure) NUNCA abría el breaker. Mi diseño la preserva (§5). También: usar `import type` top-level para tipos externos; no dejar `eslint-disable` sin uso (`--max-warnings 0`). |

### Exemplars verificados (Glob/Read confirmados)
| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/chains/error-classifier.ts` (NUEVO) | `src/chains/chain-mutex.ts` (módulo puro, sin imports runtime de core/routes/methods/infra) | Respeta OWNERS: `chains/*` no importa capas superiores. Clasificador puro y determinista. |
| `_settleRaw` catch blocks (modificar) | El propio `catch` actual (l.627-661) + `sanitize(e)` (l.64-67) | El `e` crudo ya está en scope; solo se agrega la clasificación + tag. |
| `settle()`/`verify()` wrapper (modificar) | El propio wrapper actual (l.452-481 / l.234-267) + `BusinessFailureError` | Se agrega un gate: business-tagged → no throw; resto → throw legacy. |
| `src/__tests__/unit/chains/error-classifier.test.ts` (NUEVO) | `circuit-breaker.test.ts` (unit puro, mocks) | Clasificador testeado con objetos error mockeados (duck-typed). |
| `src/__tests__/unit/chains/settle.breaker-classification.test.ts` (NUEVO) | `settle.failinjection.test.ts` (`makeMockClients` + spyOn clients) | Integración a través del `settle()` real con clients mockeados que lanzan errores viem tipados. |

### Estado de BD relevante
N/A — cambio puro de lógica in-process. No hay cambios de schema.

### Componentes reutilizables encontrados
- `sanitize(e)` (`base-adapter.ts:64`) — reutilizar para el mensaje del error; el
  clasificador consume el `e` crudo (antes de sanitizar).
- `BusinessFailureError` (`circuit-breaker.ts:104`) — se **reutiliza tal cual** como el
  sentinel de "cuenta" (no se renombra → no rompe imports). Semántica: ahora significa
  "fallo contable" (transporte/ambiguo/legacy), no "business". Se documenta en el código.
- `makeMockClients` (`settle.failinjection.test.ts`) — patrón de mock de clients viem.

---

## 5. Análisis de causa raíz + Diseño del fix (resuelve DT-4)

### 5.1 Dónde está el bug
| Archivo | Zona | Qué está mal |
|---------|------|-------------|
| `base-adapter.ts` | `settle()` l.456-461 | `throw BusinessFailureError` para **todo** `SIMULATION_FAILED`/`TRANSACTION_FAILED`, sin distinguir la causa. |
| `base-adapter.ts` | `_settleRaw` catch l.627-661 | Colapsa transporte y business al mismo código; descarta el `e` crudo de viem que lleva la señal de causa. |
| `circuit-breaker.ts` | l.252 `handleAll` | Cuenta cualquier throw. (Se decide **NO tocar** este archivo — ver 5.4.) |

### 5.2 DT-4 RESUELTO — el clasificador `classifyChainError`

**Módulo nuevo:** `src/chains/error-classifier.ts` (puro, sin imports runtime; duck-typing
por `name`/`code`/`status`/mensaje — **NO `instanceof`**).

> **Por qué duck-typing y no `instanceof`:** (a) los transportes `fallback([...])` de viem
> re-envuelven errores y `instanceof` a través de wrappers/realms es frágil; (b) permite
> tests con objetos planos mockeados (CD-4 determinista); (c) desacopla de la versión de
> viem (`~2.52.2`). Se inspecciona la **cadena de causas** (`.cause`) porque viem envuelve
> el error real (RPC/revert) dentro de `EstimateGasExecutionError`/`ContractFunctionExecutionError`.

**Firma:**
```
export type ChainErrorClass = 'transport' | 'business';
export function classifyChainError(err: unknown): ChainErrorClass;
```

**Algoritmo (orden ESTRICTO — business primero):**

1. **Walk** la cadena `err → err.cause → …` (cap de profundidad ~10, guard anti-ciclos).
   Por cada nodo recolectar: `name` (string), `code` (string|number, p.ej. Node
   `ECONNREFUSED` o RPC `-32603`/`3`), `status` (HTTP, de `HttpRequestError.status`), y un
   blob de texto lowercased = `message` + `shortMessage` + `details` + `metaMessages.join(' ')`.
2. **BUSINESS (no cuenta) — se evalúa PRIMERO.** Retornar `'business'` si CUALQUIER nodo:
   - `name` ∈ { `ExecutionRevertedError`, `ContractFunctionRevertedError`,
     `ContractFunctionZeroDataError`, `InsufficientFundsError`, `NonceTooLowError`,
     `NonceTooHighError`, `NonceMaxValueError`, `IntrinsicGasTooLowError`,
     `IntrinsicGasTooHighError`, `TipAboveFeeCapError`, `FeeCapTooLowError`,
     `FeeCapTooHighError` }
     — **NOTA:** los wrappers `EstimateGasExecutionError` / `ContractFunctionExecutionError`
     / `CallExecutionError` **NO** están en este set: se clasifican por su **causa** (walk)
     + substrings, para no marcar business un wrapper cuya causa real es transporte.
   - `code` === `3` (EVM execution reverted) o `code` === `'CALL_EXCEPTION'`.
   - el blob contiene ALGUNA substring de negocio/contención:
     `gas required exceeds allowance` · `execution reverted` · `insufficient funds` ·
     `nonce too low` · `nonce too high` · `already known` ·
     `replacement transaction underpriced` · `authorization is used` ·
     `authorization used` · `transfer amount exceeds balance` · `intrinsic gas too low`.
   > **`gas required exceeds allowance` es el crux Chaski.** Llega como error JSON-RPC
   > (HTTP 200 + body de error → viem lo parsea a `RpcRequestError`/`EstimateGasExecutionError`),
   > NO como fallo HTTP. Por eso el **match por substring de business ANTES que el nombre de
   > transporte** es esencial: un `RpcRequestError` que lleva "gas required exceeds allowance"
   > debe ganar como business, no como transporte.
3. **TRANSPORT (cuenta).** Si no matcheó business, retornar `'transport'` si CUALQUIER nodo:
   - `name` ∈ { `HttpRequestError`, `TimeoutError`, `SocketClosedError`,
     `WebSocketRequestError`, `RpcRequestError`, `InternalRpcError`,
     `ResourceUnavailableRpcError`, `LimitExceededRpcError`, `ParseRpcError`,
     `ProviderDisconnectedError`, `ChainDisconnectedError`, `UnknownRpcError` }
   - `status` (HTTP) ≥ 500
   - `code` ∈ { `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`,
     `EPIPE`, `ECONNABORTED`, `EHOSTUNREACH`, `ENETUNREACH` } (Node system errors)
   - el blob contiene: `fetch failed` · `econnrefused` · `econnreset` · `etimedout` ·
     `enotfound` · `eai_again` · `socket hang up` · `connection refused` ·
     `connection reset` · `network error` · `request timed out` · `took too long` · `timeout`.
4. **DEFAULT — AC-5 fail-safe conservador** → `'transport'` (cuenta). Cualquier caso no
   clasificado (error plano `new Error('x')`, string, `undefined`) cae acá.

**Tabla resumen viem-error → categoría (con evidencia de nombres en `node_modules/viem/_esm/errors/`):**

| Señal (name / code / substring) | Fuente viem | Categoría | ¿Cuenta? |
|---|---|---|---|
| `gas required exceeds allowance (…)` | `estimateGas.js` / `rpc.js` (msg) | **business** (contención Chaski) | NO |
| `ExecutionRevertedError`, code `3` | `node.js` | business | NO |
| `ContractFunctionRevertedError`, `authorization is used` | `contract.js` (msg) | business | NO |
| `InsufficientFundsError`, `insufficient funds` | `node.js` | business | NO |
| `NonceTooLowError` / `already known` / `replacement … underpriced` | `node.js` (msg) | business (contención) | NO |
| `HttpRequestError` (status ≥ 500) | `request.js` | **transport** | SÍ |
| `TimeoutError` / `took too long` | `request.js` | transport | SÍ |
| `SocketClosedError`, `WebSocketRequestError` | `request.js` | transport | SÍ |
| `RpcRequestError` / `InternalRpcError` (-32603) sin substring business | `request.js`/`rpc.js` | transport | SÍ |
| Node `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND` (en `.cause.code`) | Node/undici | transport | SÍ |
| `fetch failed` | undici | transport | SÍ |
| `EstimateGasExecutionError` **envolviendo** RpcError con `gas required exceeds allowance` | `estimateGas.js` | business (por cause+substring) | NO |
| `EstimateGasExecutionError` **envolviendo** `TimeoutError` | `estimateGas.js` | transport (por cause name) | SÍ |
| `new Error('sim fail')` / string / desconocido | — | **transport (fail-safe AC-5)** | SÍ |

### 5.3 Dónde se aplica — TAG en el resultado + gate en el wrapper (NO tocar circuit-breaker.ts)

**Decisión (DT-5 resuelto): NO cambiar `handleAll` → `handleWhen`.** Razón dura de CD-6:
los tests existentes del breaker (`recordBusinessFailure`, CC-12/13/14) alimentan **errores
planos** al breaker y **esperan que cuenten**. Un `handleWhen(isTransport)` a nivel breaker
requeriría que esos planos NO cuenten → rompería ~5 tests sin editarlos → **imposible por CD-6**.
Además tocar la construcción de la policy es el punto de mayor riesgo de regresión.

**Enfoque elegido — tag + gate, todo dentro de `base-adapter.ts`:**

1. En `error-classifier.ts`, exportar un marcador **símbolo no-enumerable** + helpers:
   - `const BREAKER_CLASS: unique symbol = Symbol('breakerClass')`
   - `tagBusiness(result)`: `Object.defineProperty(result, BREAKER_CLASS, { value: 'business', enumerable: false, configurable: true })`
   - `isTaggedBusiness(result): boolean`
   > **Por qué no-enumerable:** un símbolo no-enumerable es invisible a `toEqual` /
   > `toMatchObject` (vitest 4) / `JSON.stringify` / spread `{...result}` de claves string.
   > Así el tag **no filtra** al caller ni a la serialización HTTP (routes/methods) ni rompe
   > los tests que assertan la forma exacta del `AdapterResult` de `_settleRaw`.

2. En cada `catch` de `_settleRaw` (simulate/write/receipt), tras construir el `AdapterResult`
   de error, calcular `classifyChainError(e)` y, **solo si es `'business'`**, aplicar
   `tagBusiness(result)`. (Transporte/ambiguo → **sin tag** → el default del wrapper cuenta.)

3. En el wrapper `settle()` (y por simetría `verify()`), reemplazar la condición de throw:
   - Si `result` es `SIMULATION_FAILED`/`TRANSACTION_FAILED` **Y** `isTaggedBusiness(result)`
     → **`return result`** (NO throw → cockatiel ve un resultado resuelto → **no cuenta**).
   - En caso contrario (sin tag: legacy, mock, transporte, ambiguo) → **`throw
     BusinessFailureError(result, code)`** → cockatiel cuenta 1 failure (comportamiento
     legacy preservado). El outer catch sigue desenvolviendo `err.result` → el caller ve
     el `AdapterResult` idéntico a hoy.

**Por qué esto satisface simultáneamente todos los ACs y CD-6:**
- **AC-1 / AC-3 (contención no cuenta):** `simulateContract` lanza el error de contención
  → `classifyChainError` = business → tag → wrapper hace `return` → cockatiel registra un
  **outcome resuelto** (no failure) → en un burst N-1 business + 1 ok, cockatiel ve N
  outcomes no-fallidos → ratio 0% → breaker **CLOSED** → el settle bueno completa.
- **AC-2 (transporte sí cuenta):** RPC caído → `classifyChainError` = transport → **sin
  tag** → wrapper hace `throw BusinessFailureError` → cockatiel cuenta failure → con >50%
  el breaker **abre** (protección de outage intacta).
- **AC-5 (ambiguo cuenta):** default transport → sin tag → throw → cuenta.
- **CD-6 (T-ADAPT-CB-6):** el mock **retorna** `SIMULATION_FAILED` sin pasar por el
  `catch` de `_settleRaw` → **sin tag** → wrapper hace throw → cuenta → breaker abre. **Pasa
  sin editar.**
- **CD-6 (T-CB-ACCOUNTING / AC-15):** `new Error('sim fail')` → ambiguo → sin tag → cuenta
  → breaker abre. **Pasa sin editar.**
- **CD-6 (failinjection reverts):** business → tag → no cuenta, pero esos tests solo
  assertan el código retornado + money-safety (no el estado del breaker) → **pasan.**

### 5.4 Invariante SamplingBreaker preservada (auto-blindaje 016 / AR-BLQ-ALTO-1)
Cada `settle()` produce **exactamente un** outcome hacia cockatiel: o un `throw` (1 failure)
o un `return` (1 success). Nunca ambos. No se reintroduce el patrón +1success/+1failure. Un
business-fail cuenta como **success** de cockatiel — es intencional y correcto: la ventana de
sampling debe ver "la chain respondió (con un no-outage)". Durante un outage real, casi todos
los simulates fallan con errores de transporte → todos `throw` → el ratio cruza el umbral.

---

## 6. Constraint Directives

### Heredados del work-item (INVIOLABLES)
- **CD-1**: PROHIBIDO debilitar la protección del breaker contra un outage genuino. AR debe
  verificar que un fallo de transporte/RPC real SIGUE abriendo el breaker tras el fix (AC-2).
- **CD-2**: PROHIBIDO tocar `src/chains/chain-mutex.ts` / `runExclusive`.
- **CD-3**: PROHIBIDO introducir doble-settle o reordenar el lock de idempotencia respecto
  al breaker/mutex. Orden `lock→breaker→mutex→broadcast` intacto.
- **CD-4**: OBLIGATORIO clasificador determinista y testeable sin RPC real (mocks de tipos
  de error).
- **CD-5**: PROHIBIDO gastar fondos reales / settle real en Fuji. Smoke real = post-deploy.
- **CD-6**: OBLIGATORIO que los tests existentes de `circuit-breaker.test.ts`,
  `concurrency.settle.test.ts`, `chain-adapter.test.ts`, `chains.base.test.ts` y
  `settle.failinjection.test.ts` sigan verdes **sin modificar sus assertions**. Solo AGREGAR
  tests. Guardianes específicos: **T-ADAPT-CB-6**, **T-CB-ACCOUNTING (AC-15)**, **CC-12/13/14**.
- **CD-7**: PROHIBIDO cerrar DONE sin que QA cite archivo:línea del punto de clasificación y
  del test que prueba AC-3 (burst N-1 business + 1 ok → breaker CLOSED, settle sin 503).

### Nuevos de este SDD
- **CD-8**: PROHIBIDO tocar `src/chains/circuit-breaker.ts`. La clasificación vive
  íntegramente en `base-adapter.ts` + `error-classifier.ts`. `handleAll` se mantiene.
- **CD-9**: OBLIGATORIO que `error-classifier.ts` sea un módulo **puro** — sin imports
  runtime de `src/core/*`, `src/routes/*`, `src/methods/*`, `src/infra/*` (OWNERS). Sin
  `instanceof` de viem; duck-typing por `name`/`code`/`status`/mensaje.
- **CD-10**: OBLIGATORIO que el tag (`BREAKER_CLASS`) sea un símbolo **no-enumerable**;
  PROHIBIDO agregar cualquier campo **enumerable** al `AdapterResult`/`error` (filtraría a la
  respuesta HTTP y rompería tests de forma). El caller ve el `AdapterResult` idéntico a hoy.
- **CD-11**: OBLIGATORIO preservar la invariante 1-call↔1-outcome del SamplingBreaker
  (auto-blindaje 016). PROHIBIDO llamar `recordBusinessFailure` dentro de `_breaker.execute`.
- **CD-12**: OBLIGATORIO que el clasificador matchee **business antes que transport** (orden
  estricto), para que `gas required exceeds allowance` transportado por un `RpcRequestError`
  se clasifique business.
- **CD-13**: OBLIGATORIO `import type` top-level para cualquier tipo externo (viem/pino) en
  source y tests; PROHIBIDO `import()` inline y `eslint-disable` sin uso (`--max-warnings 0`)
  (auto-blindaje 016).
- **CD-14**: PROHIBIDO agregar dependencias nuevas. Solo viem (ya presente) y TS nativo.

---

## 7. Waves de implementación

### Wave 0 — Serial Gate (contratos/tipos, sin wiring)
- **W0.1**: Crear `src/chains/error-classifier.ts` con: `ChainErrorClass`, `classifyChainError`,
  `BREAKER_CLASS` (símbolo), `tagBusiness`, `isTaggedBusiness`. Lógica completa de §5.2/§5.3.
  → Exemplar: `src/chains/chain-mutex.ts` (módulo puro). Verificación: `npm run typecheck`
  + `npm run lint` verdes.

### Wave 1 — Parallelizable (test del clasificador)
- **W1.1**: `src/__tests__/unit/chains/error-classifier.test.ts` — casos EC-1..EC-13 (§9).
  → Exemplar: `circuit-breaker.test.ts`. Verificación: el test nuevo corre verde contra W0.

### Wave 2 — Serial (wiring, depende de W0)
- **W2.1**: Modificar `base-adapter.ts`:
  (a) importar `classifyChainError`, `tagBusiness`, `isTaggedBusiness` de `./error-classifier.js`;
  (b) en los 3 `catch` de `_settleRaw`, tras armar el error result, `if (classifyChainError(e)
  === 'business') tagBusiness(result)`;
  (c) en el wrapper `settle()` (y por simetría `verify()`), cambiar la condición: business-tagged
  → `return result`; resto → `throw BusinessFailureError`.
  → Exemplar: el propio wrapper actual (l.452-481). Verificación: `typecheck` + suite existente
  **verde sin edición de assertions** (CD-6).

### Wave 3 — Final (integración + regresión)
- **W3.1**: `src/__tests__/unit/chains/settle.breaker-classification.test.ts` — BC-1..BC-5 (§9).
  → Exemplar: `settle.failinjection.test.ts` (`makeMockClients` + spyOn). 
- **W3.2**: Correr la suite completa (`npm test`) + `typecheck` + `lint`. Confirmar guardianes
  T-ADAPT-CB-6 / T-CB-ACCOUNTING / CC-12/13/14 verdes.

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.1 | W0.1 | testea el clasificador |
| W2.1 | W0.1 | usa los helpers |
| W3.1 | W2.1 | integración a través del `settle()` ya cableado |
| W3.2 | W1.1, W2.1, W3.1 | regresión global |

### Archivos involucrados
| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/chains/error-classifier.ts` | No | Crear | W0.1 | `src/chains/chain-mutex.ts` |
| `src/chains/base-adapter.ts` | Sí | Modificar | W2.1 | wrapper actual l.452-481 |
| `src/__tests__/unit/chains/error-classifier.test.ts` | No | Crear | W1.1 | `circuit-breaker.test.ts` |
| `src/__tests__/unit/chains/settle.breaker-classification.test.ts` | No | Crear | W3.1 | `settle.failinjection.test.ts` |

---

## 8. Flujos

### Happy path (burst multi-step — AC-3)
1. N settles concurrentes al mismo chain; mutex serializa la sección on-chain.
2. Mientras la tx del ganador está in-flight, los `simulateContract` de los demás lanzan
   `gas required exceeds allowance (X/Y/Z)`.
3. `_settleRaw` catch → `classifyChainError` = business → `tagBusiness(result)` →
   `SIMULATION_FAILED` tagueado.
4. Wrapper `settle()` → `isTaggedBusiness` true → `return result` (no throw) → cockatiel:
   outcome no-fallido.
5. El settle ganador completa (`settled:true`). El breaker permanece **CLOSED** → los N-1
   pueden reintentar (retry del gateway) sin recibir 503. **$0 resuelto.**

### Flujo de error (outage real — AC-2)
1. RPC caído/timeout → `simulateContract`/`writeContract` lanza `HttpRequestError`(5xx) /
   `TimeoutError` / `ECONNRESET`.
2. `classifyChainError` = transport → **sin tag**.
3. Wrapper → `throw BusinessFailureError` → cockatiel cuenta failure.
4. Con >50% en la ventana → breaker **OPEN** → settles siguientes reciben `CHAIN_UNAVAILABLE
   503` + `retryAfterMs`. Protección de outage **intacta**.

---

## 9. Test Plan

> Framework: **vitest** (`~4.1.8`). Todos deterministas, sin RPC real ni fondos (CD-4/CD-5).

### 9.1 `error-classifier.test.ts` (unit puro — W1.1)
| Test | AC | Escenario (input mock → esperado) |
|------|----|-----------------------------------|
| EC-1 | AC-1 | `{name:'EstimateGasExecutionError', details:'gas required exceeds allowance (24468/11800/62584)'}` → `'business'` (crux Chaski) |
| EC-2 | AC-1 | `{name:'ContractFunctionRevertedError', message:'execution reverted: FiatTokenV2: authorization is used'}` → `'business'` |
| EC-3 | AC-1 | `{name:'InsufficientFundsError', message:'insufficient funds'}` → `'business'` |
| EC-4 | AC-1 | `{name:'NonceTooLowError', message:'nonce too low'}` / `'already known'` → `'business'` |
| EC-5 | AC-2 | `{name:'HttpRequestError', status:503}` → `'transport'` |
| EC-6 | AC-2 | `{name:'TimeoutError', message:'took too long'}` → `'transport'` |
| EC-7 | AC-2 | `{cause:{code:'ECONNREFUSED'}}` / `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` → `'transport'` |
| EC-8 | AC-2 | `{message:'fetch failed'}` → `'transport'` |
| EC-9 | AC-2 | `{name:'RpcRequestError', message:'internal error', code:-32603}` (sin substring business) → `'transport'` |
| EC-10 | AC-5 | `new Error('some weird thing')` → `'transport'` (fail-safe) |
| EC-11 | AC-5 | `'raw string'` / `undefined` / `null` → `'transport'` (fail-safe, no throw) |
| EC-12 | AC-1/CD-12 | `{name:'EstimateGasExecutionError', cause:{name:'RpcRequestError', message:'gas required exceeds allowance'}}` → `'business'` (business gana sobre transport-name) |
| EC-13 | AC-2 | `{name:'EstimateGasExecutionError', cause:{name:'TimeoutError', message:'took too long'}}` → `'transport'` |

### 9.2 `settle.breaker-classification.test.ts` (integración `settle()` real — W3.1)
| Test | AC | Escenario |
|------|----|-----------|
| BC-1 | AC-1 | `simulateContract` lanza error de contención business N veces → breaker **CLOSED**, ningún `CHAIN_UNAVAILABLE`. |
| BC-2 | AC-2/CD-1 | `simulateContract` lanza `HttpRequestError{status:503}`/`TimeoutError` N veces → breaker **OPEN** → settle siguiente = `CHAIN_UNAVAILABLE 503` + `retryAfterMs>0`. |
| BC-3 | AC-3 | Burst: N-1 sim-fails de contención (business) + 1 `simulateContract` OK que broadcastea → `getState()==='CLOSED'` y el settle bueno retorna `settled:true` (sin 503). |
| BC-4 | AC-5 | `simulateContract` lanza `new Error('sim fail')` (ambiguo) N veces → breaker **OPEN** (fail-safe cuenta) — refleja legacy. |
| BC-5 | AC-1 | Business sim-fail → el caller sigue recibiendo `SIMULATION_FAILED` (forma preservada; solo cambia el accounting; el tag es invisible). |

### 9.3 Regresión (sin editar — W3.2)
- `circuit-breaker.test.ts` (T-CB-1..T-CB-13) verde.
- `concurrency.settle.test.ts` (CC-1..CC-15, esp. CC-12/13/14) verde.
- `chain-adapter.test.ts` (esp. **T-ADAPT-CB-6**, **T-CB-ACCOUNTING/AC-15**) verde.
- `chains.base.test.ts`, `settle.failinjection.test.ts` verdes.
- El work-item cita "39/39" en `circuit-breaker.test.ts`: la métrica operativa es la suite
  completa verde sin edición de assertions.

---

## 10. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Un tag enumerable filtra a la respuesta HTTP / rompe `toEqual` de forma | B | A | CD-10: símbolo **no-enumerable** (invisible a toEqual/toMatchObject/JSON/spread). BC-5 verifica forma del caller. Dev corre suite completa en W3.2. |
| Clasificar business un error que era un outage enmascarado (debilita CD-1) | B | A | Business solo por señales de **ejecución/semántica** (reverts, gas-allowance, nonce) que un socket muerto NO emite. Default = transport (AC-5). EC-13 prueba que un wrapper con causa transport → cuenta. |
| Romper T-ADAPT-CB-6 / T-CB-ACCOUNTING (mocks que esperan que SIM_FAILED cuente) | M | A | Diseño tag+gate: retorno **sin tag** (mock) o error ambiguo → cuenta (legacy). Verificado en Context Map. W3.2 los corre. |
| viem no expone `.status`/`.details`/`.metaMessages` como se asume | B | M | Verificado en `node_modules/viem/_esm/errors/request.js` (`HttpRequestError.status`) y `base.js` (`.walk()`, `.cause`). Duck-typing tolera ausencia (default fail-safe). |
| Un throw desde `_settleRaw` envenena la cola del mutex | B | A | Verificado: `runExclusive` (`chain-mutex.ts:48-59`) propaga rejection y avanza el tail con `.then(,,)` → no envenena. CD-2: no se toca. |
| `gas required exceeds allowance` sea a veces gas real del operador | B | B | Es un no-outage determinístico igual → correcto no-contar hacia un breaker de disponibilidad; el gas del operador se monitorea aparte (observabilidad WKH-71). Documentado. |

---

## 11. Dependencias
- Ninguna externa nueva. viem `~2.52.2` y cockatiel `3.2.1` ya presentes.
- El mutex `runExclusive` debe seguir propagando throws (verificado, no se toca).

## 12. Uncertainty Markers
| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | DT-4 **RESUELTO** en §5.2/§5.3. Sin `[NEEDS CLARIFICATION]` pendientes. | No |

> Smoke real post-deploy (batch multi-step vs Fuji sin 503) queda como paso operativo
> fuera del pipeline (CD-5), no es AC bloqueante para DONE.

---

## 13. Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado (AC-1..AC-5 → error-classifier.ts + base-adapter.ts + 2 tests)
[x] Cada archivo tiene Exemplar verificado con Read/Glob (chain-mutex.ts, wrapper actual, circuit-breaker.test.ts, settle.failinjection.test.ts)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-4 resuelto en §5)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1..CD-14)
[x] Context Map tiene ≥2 archivos leídos (8 archivos + auto-blindaje 016)
[x] Scope IN/OUT explícitos y no ambiguos (§2)
[x] BD: N/A (sin cambios de schema) — declarado
[x] Happy Path completo (§8, AC-3 burst)
[x] Flujo de error definido (§8, AC-2 outage)
[x] Regresión CD-6 verificada por lectura de los guardianes (T-ADAPT-CB-6, T-CB-ACCOUNTING, CC-12/13/14)
[x] Invariante SamplingBreaker 1↔1 preservada (auto-blindaje 016)
```

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil (nexus-architect) — F2 BUGFIX+QUALITY — WKH-154 / #023*
