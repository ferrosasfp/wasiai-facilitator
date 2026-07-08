# Work Item — [WKH-148] Error explícito `OPERATOR_FUNDING_LOW` en /settle

## Resumen
Cuando el settle falla porque el wallet operador (relayer) se quedó sin gas en
una chain, hoy el facilitator devuelve el error RPC crudo de viem (ej. "gas
required exceeds allowance") — críptico y costoso de diagnosticar (esta sesión
tardó en identificar que era gas KITE agotado, no un problema de allowance).
WKH-148 agrega un check preventivo, read-only, del balance nativo del
operador en `_settleRaw()` **antes** de `simulateContract`: si está por debajo
de un umbral configurable, el facilitator devuelve `OPERATOR_FUNDING_LOW`
(HTTP 503) en vez del error RPC oscuro, y loguea chain + dirección + balance
para que ops sepa al toque que hay que recargar. Companion de WKH-71 (gas
monitoring/alerting — vive en otro mecanismo/repo); WKH-148 es la
"detección en el momento del fallo", no el poller.

## Sizing
- SDD_MODE: mini (FAST+AR) — precedente directo: WFAC-11 (`core/errors.ts`,
  agregar un código x402) y WFAC-41 (agregar `CHAIN_UNAVAILABLE` como
  extensión no-spec) ambas corrieron FAST+AR. Superficie acotada, sin
  endpoints nuevos, read-only, backward-compatible.
- Estimación: S
- Branch sugerido: `fix/148-operator-funding-low`

## F0 — Grounding (archivo:línea)

1. **Settle path real**: `src/chains/base-adapter.ts` `_settleRaw()`
   (líneas 503–716). El bloque on-chain (simulate→write→waitReceipt) vive
   dentro de `runExclusive(this.metadata.chainId, ...)` en la línea 618. El
   `publicClient`/`walletClient` se obtienen en líneas 620–621, **antes** de
   entrar al `runExclusive` en la práctica (son locales dentro del callback,
   pero `getPublicClient()`/`getWalletClient()` son métodos públicos de la
   clase — se pueden llamar antes de adquirir el mutex).
2. **`error-classifier.ts`** (`src/chains/error-classifier.ts`, WKH-154)
   clasifica `transport` vs `business` sobre errores RPC/viem crudos
   (`classifyChainError`, línea 221). `OPERATOR_FUNDING_LOW` **NO** es una
   3ª categoría del clasificador — es un **check previo** (read-only) que
   corre ANTES de que exista ningún error RPC que clasificar. El
   clasificador se reutiliza SIN modificar solo para el caso borde en que el
   propio `getBalance()` falle por transporte (ver DT-6/CD-6 abajo).
3. **Balance del operador**: `getOperatorAccount()` en `src/infra/wallet.ts`
   (línea 46) devuelve el `Account` viem cacheado — `.address` es la
   dirección del operador (ya usado indirectamente en
   `getWalletClient()`, `base-adapter.ts` línea 210). El `publicClient`
   (`getPublicClient()`, `base-adapter.ts` líneas 192–202) es un viem
   `PublicClient` estándar — expone `getBalance({ address })` nativo
   (read-only, no requiere código nuevo de infraestructura).
4. **Mapeo error → HTTP**: `src/core/types.ts` (línea 33, `X402ErrorCode`
   union) + `src/core/errors.ts` (`HTTP_BY_CODE`/`DEFAULT_MESSAGE_BY_CODE`,
   ambos `Record<X402ErrorCode, ...>` **exhaustivos** — el compilador
   rechaza agregar un código a `X402ErrorCode` sin agregarlo también a
   ambos Records). `src/routes/settle.ts` mapea `Result<SettleResult>` →
   HTTP en el Step 5 (líneas 319–369) usando `result.error.code`/`.http`
   directo — pero mantiene un **segundo union manual**
   `SettleRouteErrorCode` (líneas 44–60) que hay que extender también.
   Precedente exacto: `CHAIN_UNAVAILABLE` (WFAC-41, `core/types.ts` líneas
   44–47, `core/errors.ts` línea 57 y línea 83) ya extendió los 10 códigos
   x402 spec con un 11º código facilitator-specific — `X402-CONFORMANCE.md`
   línea 71 ya lista "**Wallet balance monitoring — alerts when operator
   wallet low on gas**" como "security addition beyond spec" (documentado,
   nunca implementado) — este WKH-148 es exactamente eso.
5. **Helper reutilizable de WKH-71**: NO existe ningún helper de
   gas/balance en este repo (`Glob` de `*gas*.ts`/`*balance*.ts` → vacío).
   WKH-71 (gas monitoring/alerting, mencionado en memoria como parte del
   "trípode de observabilidad") vive en otro mecanismo — este WKH-148 es la
   PRIMERA pieza de balance-check en `wasiai-facilitator`.

## Acceptance Criteria (EARS)

- AC-1: WHEN un settle entra al bloque on-chain de `_settleRaw` (después de
  las validaciones off-chain) AND el balance nativo del operador en esa
  chain está por debajo de `OPERATOR_MIN_BALANCE_WEI`, the system SHALL
  devolver `{ ok: false, error: { code: 'OPERATOR_FUNDING_LOW', http: 503 } }`
  SIN llamar `simulateContract` ni `writeContract`.
- AC-2: WHEN un settle falla con `OPERATOR_FUNDING_LOW`, the system SHALL
  loguear (server-side, `app.log.warn`, NUNCA en el body HTTP) el chainId,
  la dirección del operador y el balance actual vs el umbral configurado.
- AC-3: WHILE el balance del operador está en o por encima de
  `OPERATOR_MIN_BALANCE_WEI`, the system SHALL continuar el settle
  exactamente igual que hoy (cero cambio observable en el happy path,
  salvo una llamada `getBalance` adicional).
- AC-4: WHERE el operador no configuró `OPERATOR_MIN_BALANCE_WEI`, the
  system SHALL aplicar un default hardcodeado sano (sin requerir
  configuración nueva para funcionar igual que hoy).
- AC-5: IF la lectura de balance (`getBalance`) en sí falla (error de
  RPC/transporte), THEN the system SHALL clasificarlo con el
  `classifyChainError` existente (WKH-154) — NO reportarlo como
  `OPERATOR_FUNDING_LOW` — preservando la contabilidad del circuit breaker.
- AC-6: WHILE se chequea el balance del operador, the system SHALL usar
  exclusivamente una llamada de lectura (`publicClient.getBalance`) — cero
  escrituras/transacciones/movimiento de fondos.
- AC-7: WHEN un settle falla por razones NO relacionadas a gas (firma
  inválida, revert de negocio, nonce), the system SHALL clasificar/reportar
  esos errores exactamente igual que antes de este cambio (sin regresión a
  la clasificación transport/business de WKH-154).

## Scope IN
- `src/chains/base-adapter.ts` — nuevo paso de pre-check en `_settleRaw()`
  (antes de `runExclusive`/`simulateContract`).
- `src/core/types.ts` — agregar `OPERATOR_FUNDING_LOW` a `X402ErrorCode`.
- `src/core/errors.ts` — entradas en `HTTP_BY_CODE` (503) y
  `DEFAULT_MESSAGE_BY_CODE` (mensaje genérico, sin PII).
- `src/routes/settle.ts` — agregar `OPERATOR_FUNDING_LOW` al union local
  `SettleRouteErrorCode`; línea de log estructurado con chain+address+balance.
- `src/infra/env.ts` — nueva env var `OPERATOR_MIN_BALANCE_WEI` con default.
- `doc/architecture/X402-CONFORMANCE.md` — marcar la línea 71 ("Wallet
  balance monitoring") como implementada + documentar el 12º código
  (patrón `CHAIN_UNAVAILABLE`).
- Tests: `base-adapter` settle (balance bajo / balance OK / getBalance
  throw), `core/errors.ts` (nuevo código exhaustivo), `env.ts`, y
  `routes.settle.test.ts` (mapeo HTTP + log).

## Scope OUT
- WKH-71 — el poller/alerting de gas (mecanismo/repo separado). WKH-148 es
  la detección reactiva en el momento del settle, no el monitoreo continuo.
- `src/chains/chain-mutex.ts` (`runExclusive`) — sin cambios.
- `src/chains/error-classifier.ts` (WKH-154) — se REUTILIZA, no se modifica.
- `src/core/settle.ts` (orquestador) — sin cambios; el nuevo `AdapterResult`
  fluye sin tocar esta capa (igual que `NETWORK_MISMATCH`/`INVALID_AMOUNT`
  hoy).
- `POST /verify` — no gasta gas, no aplica el check.
- Umbrales diferenciados por chain (`KITE_MIN_BALANCE_WEI`, etc.) — un solo
  default global alcanza para V1 (ver DT-5); follow-up si se necesita.
- `Retry-After` header para `OPERATOR_FUNDING_LOW` — a diferencia de
  `CHAIN_UNAVAILABLE`, no hay un tiempo de reintento conocido (depende de
  que un humano recargue gas).

## Decisiones técnicas (DT-N)

- DT-1: El check es **preventivo**, ubicado ANTES de `runExclusive()` en
  `_settleRaw` — no reactivo-solo-sobre-error-RPC. Una lectura proactiva
  evita adquirir el mutex por-chain para un settle que no puede tener
  éxito, y da una respuesta explícita inmediata en vez de pagar el costo
  de un `simulateContract` fallido.
- DT-2: Reusar `getOperatorAccount().address` (ya importado en
  `base-adapter.ts` línea 56) en vez de `walletClient.account` — evita el
  gap de tipo `Account | undefined` que tiene `WalletClient` sin el
  generic `Account`.
- DT-3: Nuevo `X402ErrorCode` = `OPERATOR_FUNDING_LOW`, HTTP **503**.
  Precedente: `CHAIN_UNAVAILABLE` (WFAC-41) ya extendió los 10 códigos
  spec con un 11º código facilitator-specific; este es el 12º. 503 (no
  500) porque la condición es transitoria y accionable por el operador
  (recargar gas, sin cambio de código) — a diferencia de
  `SIMULATION_FAILED`/`TRANSACTION_FAILED` que son errores de ejecución
  genuinos.
- DT-4: El mensaje del body HTTP es **genérico / sin PII** (sin dirección,
  sin balance exacto) — sigue la convención documentada en
  `errors.ts` (`DEFAULT_MESSAGE_BY_CODE` "free of PII: no addresses, no
  values, no chain IDs"). El detalle accionable (chain + address + balance)
  va SOLO en el log estructurado server-side (`app.log.warn`), igual que
  `facilitator_key_id` se loguea pero nunca se devuelve en el body.
- DT-5: Env var global única `OPERATOR_MIN_BALANCE_WEI`, default
  `10000000000000000` (0.01 token nativo @ 18 decimales). Todos los
  tokens de gas soportados hoy (KITE, AVAX, ETH-Base) usan 18 decimales,
  así que un umbral único en wei es comparable entre chains sin config
  por-chain. Umbrales diferenciados quedan como follow-up (Scope OUT).
- DT-6: Si `getBalance()` en sí falla (RPC caído), NO se asume
  `OPERATOR_FUNDING_LOW` por default — se reutiliza `classifyChainError`
  (ya importado) exactamente como en los catches existentes de
  `simulateContract`/`writeContract`, así una caída real de RPC sigue
  contando para el circuit breaker (invariante de WKH-154 preservada).
- DT-7: `error-classifier.ts` NO se toca en absoluto (CD-1). El nuevo path
  retorna directo, sin pasar por `classifyChainError`/`tagBusiness` — igual
  que `NETWORK_MISMATCH`/`INVALID_AMOUNT` hoy bypasean el breaker en
  `_settleRaw` (el wrapper `settle()` solo intercepta
  `SIMULATION_FAILED`/`TRANSACTION_FAILED`; cualquier otro código simplemente
  se retorna dentro de `breaker.execute()` sin throw → cuenta como resuelto,
  NUNCA como fallo del breaker).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar `src/chains/circuit-breaker.ts`,
  `src/chains/chain-mutex.ts` o `src/chains/error-classifier.ts`.
- CD-2: OBLIGATORIO — el check de balance es SOLO LECTURA
  (`publicClient.getBalance`). PROHIBIDO cualquier `writeContract`/tx/
  movimiento de fondos dentro del check.
- CD-3: OBLIGATORIO — `OPERATOR_MIN_BALANCE_WEI` tiene default hardcodeado
  sano; el settle NO debe requerir configuración nueva para funcionar
  igual que hoy (misma filosofía que el resto de `env.ts`: fail-safe por
  default, opt-in para tunear).
- CD-4: PROHIBIDO exponer la dirección del operador o el balance exacto en
  el body HTTP de la respuesta de error (`DEFAULT_MESSAGE_BY_CODE` debe
  seguir siendo PII-free). Esos datos van solo a logs server-side.
- CD-5: OBLIGATORIO — el happy path (balance ≥ umbral) debe seguir
  devolviendo el mismo output que hoy; los tests de contrato/settle
  existentes NO deben romperse por la llamada `getBalance` extra.
- CD-6: OBLIGATORIO — un fallo de RPC en el `getBalance` check se
  clasifica con `classifyChainError` existente; PROHIBIDO inventar una
  tercera categoría de clasificación fuera de `transport`/`business`.
- CD-7: VERIFICAR en F2/CR que `toCacheableSettle`
  (`src/core/idempotency.ts`) trata `OPERATOR_FUNDING_LOW` igual que los
  demás 5xx (`SIMULATION_FAILED`/`TRANSACTION_FAILED`/`CHAIN_UNAVAILABLE`)
  — es decir, que NO se cachea en Redis como respuesta idempotente
  (confirmar el filtro exacto, no asumido en F1).

## Missing Inputs

- [resuelto en F2, con recomendación] Valor exacto del default
  `OPERATOR_MIN_BALANCE_WEI`: propuesto `10000000000000000` (0.01 token
  @ 18 decimales). Architect debe validar contra el costo típico de una tx
  `transferWithAuthorization` en Kite testnet / Avalanche Fuji / Base
  Sepolia y ajustar si es muy agresivo o muy laxo.
- [resuelto en F2, con recomendación] Umbrales por-chain (env vars
  `KITE_MIN_BALANCE_WEI`, etc.): recomendación es DIFERIR (un default
  global alcanza para V1, ver DT-5) — confirmar en F2 si algún chain
  necesita un umbral muy distinto por su gas price real.
- [NEEDS CLARIFICATION] HTTP status 503 vs 500 para
  `OPERATOR_FUNDING_LOW`: recomendación 503 (DT-3) — Architect debe
  confirmarlo contra `X402-CONFORMANCE.md` en F2 antes de codear.
- [NEEDS CLARIFICATION] Si el pre-check debe correr también en `/verify`:
  recomendación NO (Scope OUT) — `/verify` nunca gasta gas.

## Análisis de paralelismo

- No bloquea ninguna otra HU — cambios acotados a `chains/base-adapter.ts`,
  `core/types.ts`, `core/errors.ts`, `routes/settle.ts`, `infra/env.ts`.
- Puede correr en paralelo con cualquier trabajo que no toque esos 5
  archivos.
- Depende conceptualmente de WKH-154 (`error-classifier.ts`) — ya DONE y
  mergeado (`doc/sdd/023-...`), así que no hay bloqueo real, solo reuso.
- Es companion de WKH-71 (gas monitoring/alerting, vive en otro
  repo/mecanismo) — independiente, no bloqueante en ninguna dirección.
