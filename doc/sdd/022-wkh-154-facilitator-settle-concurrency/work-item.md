> ## ⚠️ SUPERSEDED — este work-item quedó MAL ESCOPADO
>
> El hallazgo de F0 sobre el mutex de nonce (`runExclusive` + `nonceManager`,
> commit `15884bd4`) sigue siendo VÁLIDO — ese mutex está deployado y
> funciona (0 reverts en 40 txs on-chain, nonces monótonos 628→629→630). Pero
> ese mutex NO era la causa raíz del $0 remanente de Chaski multi-step. La
> causa raíz real (confirmada por auditoría e2e con verificación on-chain) es
> que el **circuit breaker per-chain cuenta fallos de simulación/contención
> same-account igual que fallos de transporte/RPC**, y se abre durante bursts
> de settle concurrentes tirando settles BUENOS con `503 CHAIN_UNAVAILABLE`.
>
> El trabajo activo de WKH-154 es **`doc/sdd/023-wkh-154-facilitator-circuit-breaker-good-load/work-item.md`**.
> Este archivo se conserva sin cambios de contenido abajo como registro
> histórico del análisis F0/F1 original (el análisis del mutex, que sigue
> siendo correcto — no se toca en 023).

---

# Work Item — [WKH-154] Concurrencia de settle multi-step (nonce collision) — Fuji/Avalanche

## Resumen
Chaski multi-agente daba $0 por una cadena de 3 bugs (WKH-151 plan vacío, WKH-153
input — ambos ya FIXED+deployed en el gateway a2a). El eslabón final reportado por
el orquestador es una colisión de nonce en settles concurrentes del mismo chain en
el **facilitator** (evidencia: logs Railway con "settle ok" + 2×"settle failed" por
ráfaga de 3 agentes, error `gas required exceeds allowance` desde el relayer
0xf432 en step 1/corridor, NO por falta de gas real).

**Hallazgo central de F0** (ver DT-1/DT-2 abajo): la mitigación exacta que este
WKH pedía implementar — mutex per-chain (`runExclusive`) + viem `nonceManager` en
la cuenta operadora — **ya está implementada, testeada y mergeada a `main`**
(commit `15884bd4`, `fix(audit2/R-1,OP-03): serialize settles per-chain to
prevent nonce collisions`), y **Avalanche Fuji SÍ la usa** (hereda de
`BaseEip3009Adapter` igual que Kite/Base). Este WKH se reduce entonces a: cerrar
un gap concreto de cobertura de tests (Fuji nunca se ejercitó directamente en el
test de serialización de nonces, solo Kite), documentar el hallazgo, y dejar
explícita la verificación pendiente de que el fix esté efectivamente en el deploy
que sirvió los logs citados.

## Sizing
- SDD_MODE: QUALITY (money-path — requiere AR/CR aunque el alcance de código nuevo es chico)
- Estimación: S (test-gap-closing + verificación, NO reimplementación — la lógica central ya existe)
- Branch sugerido: `fix/154-facilitator-settle-concurrency-fuji-coverage`

## Acceptance Criteria (EARS)

- AC-1: WHEN el facilitator recibe N settles concurrentes con nonces EIP-3009
  distintos para el MISMO chainId (p.ej. Avalanche Fuji 43113), the system SHALL
  serializar el segmento simulate→write→receipt de cada settle vía
  `runExclusive(chainId, fn)` de modo que cada broadcast reciba un nonce de cuenta
  operadora distinto y contiguo, sin colisión `nonce too low` / `gas required
  exceeds allowance`.

- AC-2: the system SHALL despachar TODO settle EIP-3009 (Kite, Base, Avalanche
  Fuji/Mainnet) exclusivamente a través de `BaseEip3009Adapter._settleRaw`
  (`src/chains/base-adapter.ts:488-687`), sin rutas alternativas de broadcast —
  el módulo `src/methods/eip3009/settle.ts` permanece marcado como dead code, no
  wireado a runtime.

- AC-3: WHILE dos o más settles DISTINTOS están en curso en chains DIFERENTES,
  the system SHALL permitir que corran en paralelo (nonces por chain son
  independientes; NO se bloquean entre sí).

- AC-4: IF Redis no está disponible o el in-flight lock (`setInflightSettleLock`)
  falla y retorna `'skipped'` (fail-open), THEN el mutex per-chain in-process
  (`runExclusive`) SHALL seguir siendo la barrera activa contra colisión de nonce
  — su funcionamiento NO depende de Redis.

- AC-5: WHEN se ejecuta la suite `settle.nonce-serialization.test.ts`, the system
  SHALL incluir un caso que ejercite directamente `avalancheFujiAdapter` (no solo
  `kiteTestnetAdapter`/`kiteMainnetAdapter` como hoy) con un burst de N settles
  concurrentes distintos, verificando nonces contiguos sin colisión — cerrando el
  gap de cobertura identificado en F0.

- AC-6: the system SHALL preservar la idempotencia existente (in-flight lock
  SET NX + cache de respuesta) sin doble-settle y sin deadlock entre el lock de
  idempotencia y el mutex per-chain — el lock de idempotencia se evalúa ANTES de
  entrar a `runExclusive` (orden actual en `routes/settle.ts` → `core/settle.ts`
  → `adapter.settle()`), nunca anidado de forma cruzada.

- AC-7: the system SHALL dejar registrado como pendiente de verificación (F4/QA,
  no F0/F1) que el commit `15884bd4` está efectivamente activo en el deploy de
  Railway que sirvió los settles fallidos citados por el orquestador — esta HU no
  puede confirmarlo sin acceso al dashboard/logs con timestamp de deploy.

## Scope IN
- `src/chains/chain-mutex.ts` — verificación de la garantía "no poison the
  queue" (ya presente, líneas 42-71); sin cambios funcionales esperados.
- `src/chains/base-adapter.ts` — verificación del wiring `runExclusive` dentro de
  `_settleRaw` (líneas 594-686); sin cambios funcionales esperados.
- `src/infra/wallet.ts` — verificación del `nonceManager` wireado a la cuenta
  operadora (líneas 21-54); sin cambios funcionales esperados.
- `src/chains/avalanche.ts` — confirmación de que `AvalancheAdapter extends
  BaseEip3009Adapter` (línea 108) — YA CONFIRMADO en F0, sin cambios esperados.
- `src/__tests__/unit/chains/settle.nonce-serialization.test.ts` — AGREGAR
  caso(s) Fuji-specific (NS-4/NS-5) espejando NS-1/NS-2 pero contra
  `avalancheFujiAdapter`.
- `railway.json` — solo lectura/verificación de que no hay `numReplicas`/config
  multi-instancia (confirmado: ausente → default Railway = 1 réplica).

## Scope OUT
- `wasiai-a2a` (gateway): lógica de `orchestrate.ts`/`compose.ts`, retries
  (WKH-130 adaptive-retry), circuit breaker del gateway — NO se toca en este WKH.
- Cambiar el modelo de pago (x402 por llamada vs agent key prepaga).
- Lock/queue cross-réplica (BullMQ o Redis distributed lock) para coordinar
  MÚLTIPLES instancias del facilitator — es la mejora "eventual" ya documentada
  en `chain-mutex.ts:17-22` como DEFER-TO-HU; se abre como TD si se confirma
  escalado horizontal real.
- Cambios a thresholds del circuit breaker (`CB_FAILURE_THRESHOLD` etc.).
- Settle real en Fuji/testnet como parte de la validación de esta HU (gasta
  fondos reales — ver CD-4).

## Decisiones técnicas (DT-N)
- DT-1: La causa raíz reportada (colisión de nonce en settles concurrentes del
  mismo chain) YA tiene mitigación mergeada a `main` — commit `15884bd4`
  (`fix(audit2/R-1,OP-03): serialize settles per-chain to prevent nonce
  collisions`, branch `fix/audit2-facilitator`, fast-forwarded a main). Evidencia
  de código: `chain-mutex.ts:1-26` (diseño documentado), `base-adapter.ts:594-603`
  (comentario R-1/OP-03 + `return runExclusive(...)`), `wallet.ts:26-34`
  (comentario nonceManager) + `wallet.ts:53` (`privateKeyToAccount(pk, {
  nonceManager: operatorNonceManager })`). Tests existentes que lo prueban:
  `settle.nonce-serialization.test.ts` (NS-1, NS-2, NS-3, RE-1..RE-4) y
  `concurrency.settle.test.ts` (CC-1..CC-15, foco en idempotencia/cap/breaker).
- DT-2: Avalanche Fuji (43113) usa la MISMA clase base — `AvalancheAdapter
  extends BaseEip3009Adapter` (`avalanche.ts:108`) — por lo que hereda
  automáticamente mutex + nonceManager sin código nuevo. Confirmado por lectura
  directa; NO requiere refactor.
- DT-3: `railway.json` no define `numReplicas` ni autoscaling → Railway despliega
  1 réplica por defecto, consistente con el supuesto "single-instance" que
  `chain-mutex.ts:17-22` documenta explícitamente como límite conocido del mutex
  in-process. Si esto cambia (escalado horizontal), el mutex deja de cubrir la
  colisión cross-réplica — gap conocido, no cerrado aquí (ver TD).
- DT-4: El único gap CONCRETO de este WKH es de TEST COVERAGE:
  `settle.nonce-serialization.test.ts` ejercita el mutex vía
  `kiteTestnetAdapter`/`kiteMainnetAdapter` (NS-1..NS-3) pero nunca directamente
  `avalancheFujiAdapter` — que es el adapter específicamente mencionado en la
  evidencia de logs de Chaski. Ambos comparten la misma clase base (riesgo real
  bajo), pero cerrar la cobertura da evidencia directa para AC-5 y para que QA
  F4 pueda citar archivo:línea sobre el adapter real en cuestión.
- DT-5: No se puede confirmar, sin acceso al dashboard de Railway, si el commit
  `15884bd4` estaba activo en el deploy que sirvió los settles fallidos citados
  por el orquestador. Cronológicamente el commit es ANTERIOR a los 3 commits
  `fix(WKH-131)` de Redis (líneas de `.git/logs/HEAD` 341-343, timestamps
  1783271225–1783280346 vs 1782803187 del fix de nonce) que la memoria de sesión
  confirma como deployados y validados en vivo — indicio (no prueba) de que el
  fix de nonce también está en producción. Queda como Missing Input bloqueante
  para el cierre (AC-7), no para el desarrollo de esta HU.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el modelo de idempotencia (`core/idempotency.ts`) o
  el orden lock→cap→broadcast existente en `routes/settle.ts`/`core/settle.ts`.
- CD-2: PROHIBIDO introducir un lock/queue cross-réplica (BullMQ, Redis
  distributed lock) en esta HU — fuera de scope; trackear como TD futura si se
  confirma multi-instancia real.
- CD-3: OBLIGATORIO que cualquier test nuevo agregado sea determinístico (viem
  mockeado, sin RPC real), siguiendo el patrón exacto de
  `settle.nonce-serialization.test.ts` (`makeNonceTrackingClients`).
- CD-4: PROHIBIDO gastar fondos reales / hacer settle real en Fuji como parte de
  la validación de esta HU. La validación es 100% en CI con mocks; el smoke real
  (batch multi-settle sin fallos) es POST-DEPLOY y queda fuera del pipeline de
  Dev/QA de esta HU (ver "Cómo se valida" abajo).
- CD-5: OBLIGATORIO preservar la garantía de no-deadlock de `runExclusive`:
  cualquier excepción dentro de `fn()` debe resolver el tail de la cola sin
  poison (ya garantizado en `chain-mutex.ts:48-59`) — CR debe verificar
  explícitamente que ningún cambio rompa esa garantía si se toca el archivo.
- CD-6: PROHIBIDO doble-settle: el in-flight lock (SET NX) debe seguir
  evaluándose ANTES de `runExclusive` en la cadena de llamadas — no reordenar.
- CD-7: PROHIBIDO marcar esta HU como DONE sin que QA F4 registre evidencia
  archivo:línea de los tests NS-4/NS-5 (Fuji) pasando en CI Y una nota explícita
  sobre el estado de AC-7 (verificado/no verificable-sin-Railway).

## Missing Inputs
- [bloqueante para DONE, NO para Dev] Confirmar en Railway (fuera del alcance de
  este agente — requiere dashboard/logs con timestamp de deploy) que el commit
  `15884bd4` estaba activo en el momento de los settles fallidos citados por el
  orquestador. Default conservador aplicado: se asume que SÍ está deployado
  (es anterior a los fixes WKH-131 de Redis, confirmados deployados en memoria de
  sesión), pero QA F4 debe intentar revalidarlo con un batch real post-deploy
  antes de cerrar la narrativa "Chaski $0" como 100% resuelta.
- [resuelto en F0] ¿Fuji usa runExclusive+nonceManager? SÍ — confirmado
  (`avalanche.ts:108`, `base-adapter.ts:603`, `wallet.ts:53`).
- [NEEDS CLARIFICATION — default conservador: 1 instancia] Escala real de
  Railway (número de réplicas activas). `railway.json` no configura
  multi-réplica; se asume 1 (default de Railway). Si en el futuro se escala
  horizontalmente, el mutex in-process deja de ser suficiente por sí solo →
  TD futura (cola distribuida).
- [resuelto en F0, parcial] Fuente de la concurrencia (batch real de N steps del
  orchestrator vs retry-storm de WKH-130 adaptive-retry/circuit breaker del
  gateway antes de que la tx original mine): AMBOS escenarios quedan cubiertos
  por el mismo mutex per-chain, porque `runExclusive` serializa CUALQUIER
  llamada concurrente a `settle()` sobre el mismo `chainId`, sin importar si el
  origen es un batch real o un reintento. No se puede determinar la proporción
  exacta entre ambos sin instrumentación adicional en el gateway (fuera de
  scope — `wasiai-a2a` no forma parte de este repo/HU).

## Análisis de paralelismo
- Esta HU es standalone dentro del backlog del facilitator; no bloquea otras HUs
  del facilitator ni del gateway.
- Puede correr en paralelo con cualquier trabajo en `wasiai-a2a` (gateway) porque
  el scope está estrictamente contenido al facilitator y no requiere cambios en
  el gateway.
- Bloquea (soft, no técnico) el cierre narrativo de "Chaski $0 resuelto al 100%"
  hasta que QA F4 registre el intento de verificación de AC-7.

## Cómo se valida sin gastar plata
- CI (Dev/AR/CR): tests NS-4/NS-5 nuevos en `settle.nonce-serialization.test.ts`
  con `avalancheFujiAdapter` y viem completamente mockeado (mismo patrón que
  NS-1/NS-2 para Kite) — determinístico, sin RPC real, sin fondos.
- El smoke real (disparar un batch de N settles reales contra Fuji y confirmar
  N ok / 0 fallos por nonce) es explícitamente POST-DEPLOY y queda fuera del
  pipeline QA de esta HU (CD-4) — se documenta como siguiente paso operativo,
  no como AC bloqueante para DONE.
