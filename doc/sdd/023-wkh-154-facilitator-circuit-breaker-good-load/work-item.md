# Work Item — [WKH-154] Circuit breaker: no confundir contención de simulate con chain-unavailable

> **SUPERSEDE** a `doc/sdd/022-wkh-154-facilitator-settle-concurrency/work-item.md`.
> Ese work-item quedó MAL ESCOPADO: asumía que la causa raíz del $0 de Chaski
> multi-step era una colisión de nonce (ya mitigada, commit `15884bd4`, mutex
> `runExclusive` + `nonceManager` — funciona, 0 reverts en 40 txs on-chain,
> nonces monótonos 628→629→630 verificados). Ese hallazgo de F0 fue correcto
> pero el WKH quedó reducido a "agregar cobertura de test para Fuji", que NO
> es el eslabón final del $0. Esta HU (023) reemplaza el scope de 022 con la
> causa raíz real, confirmada por auditoría e2e con verificación on-chain:
> **el circuit-breaker tira settles buenos durante bursts porque cuenta
> fallos de simulación/contención igual que fallos de transporte/RPC**. El
> folder 022 se conserva como registro histórico (no se borra), pero su
> `work-item.md` NO representa el trabajo pendiente real — usar este (023).

## Resumen
Chaski multi-agente daba $0 en settles multi-step. WKH-151/153 (gateway a2a)
ya fixed+deployed. El mutex de nonce (`runExclusive`, commit `15884bd4`) YA
está deployado y funciona — cerrado, no se toca. El eslabón final: el circuit
breaker per-chain (`src/chains/circuit-breaker.ts`, cockatiel `SamplingBreaker`,
threshold 0.5 / ventana 30s / reset 10s) cuenta CADA fallo de `simulateContract`
(incluido el error `gas required exceeds allowance` — artefacto de
`eth_estimateGas` de coreth durante contención same-account, NO un problema
real de gas/saldo/fee) como si fuera una falla de disponibilidad de chain. En
un burst multi-step (~70% de los settles fallan en simulate por contención)
el breaker se ABRE y devuelve `503 CHAIN_UNAVAILABLE` a settles BUENOS
durante ~10s — un fallo parcial se convierte en fallo total del batch → $0.
La cadena está sana: todo lo que se broadcastea, mina (0 reverts on-chain).

## Sizing
- SDD_MODE: QUALITY (money-path resiliency — un fix mal hecho puede debilitar
  la protección real contra un outage de chain genuino; requiere AR+CR)
- Estimación: M (clasificador de errores nuevo + tests deterministas del
  clasificador + verificación de que los tests existentes de breaker/
  concurrencia siguen verdes; NO reimplementación del mutex, que se preserva)
- Branch sugerido: `fix/154-facilitator-cb-transport-vs-business`

## Confirmación de causa raíz (código leído, F1)
- `src/chains/base-adapter.ts:452-463` (`settle()`) y `:234-245` (`verify()`):
  el wrapper llama `this._breaker.execute(async () => { const result = await
  this._settleRaw(params); if (!result.ok && (result.error.code ===
  'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')) {
  throw new BusinessFailureError(result, result.error.code); } return
  result; })`. CUALQUIER `SIMULATION_FAILED`/`TRANSACTION_FAILED` se convierte
  en un `throw` DENTRO del lambda que corre `_breaker.execute`.
- `src/chains/circuit-breaker.ts:252-259`: la policy se construye como
  `circuitBreaker(handleAll, { breaker: new SamplingBreaker({ threshold: 0.5,
  duration: rollingWindowMs, minimumRps }) })`. `handleAll` (cockatiel) cuenta
  **TODO** throw dentro de `policy.execute(fn)` como una falla hacia el
  sampling window — sin distinguir tipo de error. Este es el punto EXACTO
  donde un `SIMULATION_FAILED` de contención cuenta 1:1 igual que un fallo de
  RPC real.
- `src/chains/base-adapter.ts:608-632` (`simulateContract` try/catch dentro de
  `_settleRaw`): hoy captura y mapea a `SIMULATION_FAILED` **cualquier**
  excepción — tanto un revert de negocio genuino (auth ya usada, firma
  inválida a nivel contrato) como un error de transporte/RPC-level (timeout,
  conexión rechazada) como el artefacto de contención de `eth_estimateGas`
  bajo llamadas concurrentes same-account. Mismo problema en `:634-643`
  (`writeContract` → `TRANSACTION_FAILED`) y `:645-661`
  (`waitForTransactionReceipt` → `TRANSACTION_FAILED` / `'receipt timeout'`).
  **Hoy no existe ninguna sub-clasificación** — todos estos catch-alls
  colapsan a los mismos 2 códigos, sea la causa un revert real o un problema
  de RPC/nodo. Este es el gap que el fix debe cerrar.
- Consecuencia: el breaker fue diseñado (comentarios WFAC-41 / AR-BLQ-ALTO-1)
  para dar "clean 1:1 accounting" de fallos — logró ESO, pero a costa de
  tratar simulate-fails de contención igual que outages reales. La cadena
  nunca estuvo caída; el breaker protegía contra un problema que no existía y
  penalizó tráfico sano.

## Acceptance Criteria (EARS)

- AC-1: WHEN `_settleRaw`/`_verifyRaw` retorna un fallo clasificado como
  business/simulación (revert de contrato, `SIMULATION_FAILED` originado en
  contención de `estimateGas` same-account, o cualquier `TRANSACTION_FAILED`
  que NO tenga firma de fallo de transporte/RPC), the system SHALL excluir
  ese fallo del conteo del circuit breaker — el `SamplingBreaker` de
  cockatiel NO debe incrementar su ratio de fallos para ese caso.

- AC-2: WHEN ocurre un fallo genuino de transporte/RPC (timeout de conexión,
  RPC caído, error de red al llamar al nodo — NO un revert de contrato ni un
  artefacto de estimateGas por contención), the system SHALL seguir contando
  ese fallo hacia el circuit breaker exactamente como hoy, preservando la
  protección real contra un outage de chain genuino.

- AC-3: WHILE un burst de settles concurrentes al mismo chain produce N-1
  fallos de simulate por contención same-account (SIMULATION_FAILED,
  business) y 1 settle exitoso, the system SHALL mantener el breaker en
  estado CLOSED y el settle bueno SHALL completar sin recibir
  `503 CHAIN_UNAVAILABLE` — un fallo parcial de contención NO debe
  convertirse en un fallo total del batch.

- AC-4: WHEN se ejecuta la suite de tests, the system SHALL mantener en verde
  `circuit-breaker.test.ts` (39/39 casos existentes, T-CB-1..T-CB-13 +
  `readCbNumber`/`readCbBool`) y `concurrency.settle.test.ts` (CC-1..CC-15)
  sin modificar sus assertions existentes, Y SHALL incluir un test nuevo
  determinista del clasificador de errores (mock de los tipos de error
  transporte vs business) que pruebe AC-1/AC-2/AC-3 sin RPC real ni fondos.

- AC-5: IF el clasificador no puede determinar con certeza si un error es de
  transporte o de negocio (caso ambiguo / tipo de error desconocido), THEN
  the system SHALL tratarlo como fallo contable hacia el breaker (fail-safe
  conservador — default a "SÍ cuenta", nunca a "no cuenta", para no abrir un
  hueco de detección de outage real por un caso no previsto).

## Scope IN
- `src/chains/circuit-breaker.ts` — el punto de conteo (`execute()`,
  `circuitBreaker(handleAll, {...})` línea 252) es donde se debe aplicar (o
  desde donde se debe excluir) el nuevo criterio de clasificación. Puede
  requerir cambiar `handleAll` por un `handleWhen(predicate)` de cockatiel, o
  mantener `handleAll` pero evitar que los business-fails lleguen a
  `policy.execute` en absoluto (decisión de diseño para F2/architect).
- `src/chains/base-adapter.ts` — el punto de clasificación real de la causa
  del error: dentro de los catch de `_settleRaw`/`_verifyRaw` (líneas
  608-632, 634-643, 645-661) y/o en el wrapper `settle()`/`verify()`
  (líneas 234-245, 452-463) donde hoy `SIMULATION_FAILED`/`TRANSACTION_FAILED`
  se tratan como un bloque monolítico. El fix requiere inspeccionar la causa
  subyacente (tipo/nombre de error de viem, cadena `.cause`, mensajes de
  transporte conocidos) ANTES de decidir si cuenta hacia el breaker.
- Tests: `src/__tests__/unit/chains/circuit-breaker.test.ts`,
  `src/__tests__/unit/concurrency.settle.test.ts` (verificar que siguen
  verdes) + archivo de test NUEVO para el clasificador (nombre a definir en
  F2, p.ej. `error-classifier.test.ts` o extensión de
  `circuit-breaker.test.ts`).

## Scope OUT
- `src/chains/chain-mutex.ts` / `runExclusive` — el mutex de serialización de
  settles per-chain YA FUNCIONA (0 reverts en 40 txs on-chain, nonces
  monótonos verificados). NO TOCAR.
- `wasiai-a2a` (gateway): reducir la contención de simulate en la raíz —
  el gateway dispara settles concurrentes + retries que se apilan y generan
  el burst same-account. Es la causa de POR QUÉ hay contención, pero reducir
  esa contención es un fix complementario en el gateway (otra HU en
  `wasiai-a2a`, fuera de este repo). Documentado como follow-up abajo.
- Cambiar los thresholds del breaker (`CB_FAILURE_THRESHOLD`,
  `CB_ROLLING_WINDOW_MS`, `CB_RESET_TIMEOUT_MS`) — el fix es de
  CLASIFICACIÓN de qué cuenta, no de ajustar los números del breaker.
- `doc/sdd/022-wkh-154-facilitator-settle-concurrency/` — no se borra, queda
  como registro histórico del hallazgo F0 sobre el mutex (que sigue siendo
  válido), pero deja de representar el trabajo pendiente de WKH-154.
- Settle real en Fuji/testnet como parte de la validación de esta HU (gasta
  fondos reales).

## Decisiones técnicas (DT-N)
- DT-1: El mutex `runExclusive` + `nonceManager` (commit `15884bd4`) está
  CONFIRMADO deployado y funcionando (evidencia on-chain: nonces 628→629→630
  monótonos, 0 reverts en 40 txs). No es la causa del $0 remanente — se
  preserva sin cambios.
- DT-2: `circuitBreaker(handleAll, {...})` (`circuit-breaker.ts:252`) es
  actualmente ciego al tipo de error — cuenta cualquier throw dentro de
  `policy.execute(fn)` por igual. El fix requiere introducir una
  clasificación explícita ANTES de que el error llegue (o no) a
  `policy.execute`.
- DT-3: Los catch-alls en `_settleRaw` (simulate/write/waitForReceipt) hoy
  colapsan errores de transporte y de negocio en los mismos 2 códigos
  (`SIMULATION_FAILED`, `TRANSACTION_FAILED`). El clasificador necesita
  inspeccionar la excepción ORIGINAL (antes de mapearla a esos códigos, o
  agregando metadata al `AdapterResult`) para distinguir señales de
  transporte (timeouts, errores de conexión, tipos de error de viem como
  `HttpRequestError`/`TimeoutError`/`WebSocketRequestError`, códigos de red
  ECONNREFUSED/ECONNRESET/ETIMEDOUT) de señales de negocio/contención
  (reverts de contrato, `EstimateGasExecutionError` con razón de revert,
  mensajes tipo "gas required exceeds allowance" en contexto de llamadas
  concurrentes same-account).
- DT-4 `[NEEDS CLARIFICATION — resolver en F2/SDD]`: la heurística EXACTA de
  clasificación (qué tipos/mensajes de error de viem cuentan como transporte
  vs business) no está definida en este work-item — es una decisión de
  diseño que el Architect debe tomar en el SDD, con el default conservador de
  AC-5 (ambiguo → cuenta) como red de seguridad.
- DT-5: Alternativa de diseño a evaluar en F2: en vez de modificar
  `handleAll` → `handleWhen(predicate)` en cockatiel, se puede mantener el
  wrapper actual pero NO envolver el business-fail en `BusinessFailureError`
  dentro de `_breaker.execute()` — en su lugar, devolver el `AdapterResult`
  de negocio directamente desde fuera del `execute()` (sin pasar por
  cockatiel en absoluto) y sólo invocar `_breaker.execute()` alrededor de las
  llamadas RPC reales. Cualquiera de los dos enfoques satisface los ACs; la
  elección es del Architect en F2 (impacto en AR-BLQ-ALTO-1 "clean 1:1
  accounting" a revisar).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO debilitar la protección real del breaker contra un outage
  de chain genuino — AC-2 y AC-5 (fail-safe conservador) son innegociables.
  AR debe verificar explícitamente que un fallo de transporte/RPC real SIGUE
  abriendo el breaker después del fix.
- CD-2: PROHIBIDO tocar `src/chains/chain-mutex.ts` / `runExclusive` — el
  mutex funciona, está fuera de scope.
- CD-3: PROHIBIDO introducir doble-settle o reordenar el lock de idempotencia
  (`core/idempotency.ts`) respecto al breaker o al mutex — el orden
  lock→breaker→mutex→broadcast existente no cambia.
- CD-4: OBLIGATORIO que el clasificador sea determinista y testeable sin RPC
  real — cualquier test nuevo usa mocks de los tipos de error (viem/cockatiel
  simulados), siguiendo el patrón existente de `circuit-breaker.test.ts`
  (`forceOpen` / `recordBusinessFailure`) y `concurrency.settle.test.ts`.
- CD-5: PROHIBIDO gastar fondos reales / hacer settle real en Fuji como parte
  de la validación de esta HU. El smoke real (batch multi-settle sin 503) es
  POST-DEPLOY, fuera del pipeline de Dev/QA.
- CD-6: OBLIGATORIO que los 39 tests existentes de `circuit-breaker.test.ts`
  y los de `concurrency.settle.test.ts` sigan pasando SIN modificar sus
  assertions — si el fix requiere cambiar el comportamiento de
  `recordBusinessFailure` o de `execute()`, CR debe verificar que ningún test
  existente fue editado para "hacer pasar" el cambio (sólo se permite AGREGAR
  tests nuevos).
- CD-7: PROHIBIDO cerrar esta HU como DONE sin que QA F4 cite archivo:línea
  del punto de clasificación implementado y del test que prueba el escenario
  AC-3 (burst con N-1 business-fails + 1 ok → breaker CLOSED, settle bueno
  sin 503).

## Missing Inputs
- `[resuelto en F1]` Confirmación de que el mutex de nonce funciona y no es
  la causa raíz — SÍ, verificado on-chain (nonces monótonos, 0 reverts).
- `[NEEDS CLARIFICATION — resuelto parcialmente por DT-4/AC-5]` Heurística
  exacta de clasificación transporte vs business (qué tipos de error de viem,
  qué mensajes). Default conservador aplicado (AC-5): ambiguo → cuenta hacia
  el breaker. El Architect debe completar la tabla exacta en el SDD (F2).
- `[bloqueante para el cierre narrativo "Chaski $0 resuelto al 100%", NO para
  Dev]` Smoke real post-deploy: disparar un batch multi-step real contra
  Fuji/testnet y confirmar que NINGÚN settle bueno recibe 503 durante el
  burst. Explícitamente fuera del pipeline QA de esta HU (CD-5); se
  documenta como siguiente paso operativo.

## Análisis de paralelismo
- Esta HU es standalone dentro del backlog del facilitator; no bloquea otro
  trabajo del facilitator.
- Puede correr en paralelo con cualquier trabajo en `wasiai-a2a` (gateway),
  incluyendo el follow-up de reducir contención de simulate en la raíz (ver
  abajo) — son cambios independientes en repos distintos.
- Reemplaza/supersede a `doc/sdd/022-wkh-154-facilitator-settle-concurrency/`
  como el trabajo activo de WKH-154 en este repo. El folder 022 no se borra
  (registro histórico del hallazgo del mutex, que sigue siendo válido).

## Follow-up documentado (fuera de scope de esta HU)
- **Reducir la contención de simulate en la raíz**: el gateway `wasiai-a2a`
  dispara settles concurrentes + retries (WKH-130 adaptive-retry) que se
  apilan sobre el mismo chain/cuenta operadora, generando el burst que hoy
  satura `eth_estimateGas`. Aunque el fix de este WKH evita que esa
  contención tire tráfico bueno, la contención en sí (latencia extra por
  simulates que fallan y no cuentan hacia el breaker pero sí consumen tiempo/
  RPC) sigue existiendo. Se recomienda abrir una HU separada en `wasiai-a2a`
  para evaluar backoff/jitter en el disparo de settles concurrentes del
  mismo corridor/chain. NO es parte de WKH-154.

## Cómo se valida sin gastar plata
- CI (Dev/AR/CR): test nuevo determinista del clasificador — mocks de error
  de transporte (p.ej. simular `HttpRequestError`/timeout) vs error de
  negocio (revert / `EstimateGasExecutionError` simulado) alimentados al
  wrapper `execute()`/`_settleRaw`, verificando AC-1/AC-2/AC-5 sin RPC real.
- CI: escenario de burst (AC-3) simulado con N-1 mocks de fallo de simulate
  por contención + 1 mock de éxito, verificando que `getState()` permanece
  `'CLOSED'` y que el settle bueno no recibe `BreakerOpenError`.
- Regresión: `circuit-breaker.test.ts` (39 casos) y `concurrency.settle.test.ts`
  (CC-1..CC-15) corridos sin modificaciones a sus assertions (CD-6).
- El smoke real (disparar un batch de N settles reales contra Fuji/testnet
  durante un burst y confirmar 0×503 en los settles buenos) es explícitamente
  POST-DEPLOY (CD-5) — se documenta como siguiente paso operativo, no como AC
  bloqueante para DONE.
