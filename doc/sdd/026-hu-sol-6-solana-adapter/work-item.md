# Work Item — [WKH-205] Facilitator: adaptador Solana (verify + dedup)

## Resumen
Registrar detrás de la interfaz `SettlementAdapter` (WKH-204) el adaptador
concreto que verifica una transacción Solana ya confirmada (`chains/solana-adapter.ts`),
para que `solana:devnet` / `solana:mainnet` dejen de responder `CHAIN_UNAVAILABLE`
en `POST /verify` (y `/settle`, ver Scope OUT) y el facilitator pueda cobrar el
método `exact` sobre USDC-SPL. HU ampliada por auditoría con 4 requisitos de
seguridad no negociables (mint-pubkey exacto, monto por delta-balance, precisión
bigint, dedup durable fail-closed).

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: feat/026-wkh-205-solana-adapter

## Acceptance Criteria (EARS)

- AC-1 (mint-pubkey exacto + program-id pin — AL-5): WHEN el adaptador verifica
  una tx Solana, the system SHALL comparar el **mint pubkey** de la ATA
  destino contra `SOLANA_USDC_MINT` por igualdad EXACTA de pubkey (nunca por
  símbolo/nombre/metadata del token) Y validar que el `owner`/program-id de la
  cuenta de token es el SPL Token Program clásico configurado (`SOLANA_TOKEN_PROGRAM_ID`),
  rechazando (`NETWORK_MISMATCH` o `INVALID_ASSET` — TBD código exacto en F2)
  cualquier mint o program-id distinto, incluyendo un mint falso con el mismo
  símbolo/decimales o un token Token-2022 con transfer-fee no soportado.

- AC-2 (monto por delta de balance, NO "one transfer" — AL-5): WHEN el
  adaptador calcula el monto pagado, the system SHALL derivarlo del **delta
  entre `meta.preTokenBalances` y `meta.postTokenBalances`** de la ATA
  destino (`payTo`) para el mint configurado — NUNCA asumiendo "exactamente
  una instrucción Transfer" (una tx Solana puede empaquetar N instrucciones).
  IF existe una instrucción posterior en la misma tx que retira/vacía fondos
  de la ATA destino (transferencia compensatoria) de modo que el delta neto
  final sea menor al monto esperado, THEN the system SHALL rechazar la
  verificación con el monto neto real, no con el monto de la instrucción de
  crédito aislada.

- AC-3 (precisión bigint — footgun WKH-196): the system SHALL representar
  todo monto (`expectedValueMinor`, deltas de balance, `accepted.amount`)
  como `bigint` o `string` decimal en TODO el pipeline de verify — WHERE
  se lea `preTokenBalances[i].uiTokenAmount.amount` / `postTokenBalances[i].uiTokenAmount.amount`
  (strings de RPC), the system SHALL parsear con `BigInt(...)`, NUNCA con
  `Number(...)` ni `uiAmount` (float), dado que u64 excede
  `Number.MAX_SAFE_INTEGER` (2^53).

- AC-4 (dedup durable fail-CLOSED — CR-3): WHEN una tx Solana ya fue
  verificada exitosamente (mismo `signature`/`reference`, definición exacta
  en F2), the system SHALL rechazar el replay leyendo de un **unique index
  Postgres** (no solo Redis) ANTES de aceptar la verificación como válida —
  a diferencia de EVM (donde el nonce on-chain revierte el replay y Redis
  puede fallar abierto), en Solana verify-only NO existe ese backstop
  on-chain, por lo que Redis caído/latente SHALL producir rechazo
  (`DUPLICATE_TRANSACTION` o equivalente — TBD código exacto en F2), NUNCA
  aceptación silenciosa de un duplicado.

- AC-5 (commitment finalized): WHEN el adaptador consulta la tx vía RPC
  (`getTransaction` / equivalente), the system SHALL solicitar
  `commitment: 'finalized'` explícitamente — WHILE la tx no esté en estado
  `finalized`, the system SHALL tratarla como no verificable (rechazo, no
  reintento silencioso con datos de un commitment más débil).

- AC-6 (no-crash / no-regresión EVM): WHEN se registra el adaptador Solana
  en `chainRegistry` junto a los adaptadores EVM existentes (Kite/Avalanche/Base),
  the system SHALL mantener el comportamiento de verify/settle de TODOS los
  chains `eip155:*` sin cambios (regression suite EVM en verde) — IF
  `SOLANA_RPC_URL` o `SOLANA_USDC_MINT` no están configurados en el entorno,
  THEN the system SHALL omitir el registro del adaptador Solana (boot
  silencioso, mismo patrón que los adaptadores EVM opt-in) en lugar de
  fallar el arranque del proceso.

## Scope IN
- `src/chains/solana-adapter.ts` (nuevo) — implementación del adaptador
  Solana detrás de `SettlementAdapter`.
- Registro del adaptador en `src/chains/registry.ts` / `src/chains/index.ts`
  (o el mecanismo que decida el Architect en F2 dado el gap de tipos — ver
  Missing Inputs).
- Nuevas env vars: `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`,
  `SOLANA_TOKEN_PROGRAM_ID` (con default al SPL Token Program clásico),
  añadidas a `src/infra/env.ts` (schema Zod, mismo patrón opt-in que
  `KITE_MAINNET_ENABLED` — sin `.superRefine` obligatorio).
- Migración SQL nueva (`supabase/migrations/003_*.sql` o siguiente NNN libre)
  para el unique index de dedup durable (tabla/columna exacta: decisión de
  F2, ver Missing Inputs).
- Dependencia nueva `@solana/web3.js` en `package.json` (NO está en deps hoy
  — confirmado en F0).
- Tests unitarios del adaptador (mock de `Connection.getTransaction`) +
  tests de dedup (unique index / conflicto de inserción) + test de
  regresión EVM (`chainRegistry` con Solana + EVM adapters simultáneos).

## Scope OUT
- Verificación del vault / estado del escrow on-chain (HU-SOL-13).
- Implementación de `settle()` real / gasless / broadcast desde el
  facilitator (HU-SOL-14) — ver Missing Inputs sobre qué hace `settle()`
  en esta HU dado que Solana es verify-only por diseño (WKH-204).
- Lógica de negocio de Chaski (agentes remit-*, KYC, FX, payout).
- RPC failover / circuit breaker multi-RPC para Solana (el CB existente es
  EVM-específico vía `ChainCircuitBreaker`; extenderlo a Solana es
  out-of-scope salvo que F2 decida lo contrario).
- Soporte de Token-2022 con transfer-fee (explícitamente rechazado por AC-1,
  no soportado, no solo "fuera de scope implementarlo").

## Decisiones técnicas (DT-N)
- DT-1: el dedup durable es la novedad arquitectónica central de esta HU —
  Redis (`getCachedVerifyResponse`/`setCachedVerifyResponse` en
  `core/idempotency.ts`) sigue existiendo como cache de baja latencia, pero
  la fuente de verdad anti-replay es un `UNIQUE` constraint Postgres,
  análogo a `idempotency_key UNIQUE` en `facilitator_settlements`
  (`supabase/migrations/001_facilitator_settlements.sql`), NO reemplazable
  por TTL de Redis.
- DT-2: los montos u64 de Solana se tratan con el mismo cuidado que
  `NUMERIC(78,0)` para uint256 EVM (lección WKH-196: `::text` cast en
  cualquier select Postgres de esta columna vía supabase-js, para evitar
  que PostgREST devuelva JSON number y pierda precisión >2^53).
- DT-3: el adaptador Solana vive detrás de la interfaz `SettlementAdapter`
  (no `ChainAdapter` completo) tal como documentó WKH-204 en
  `src/chains/types.ts:130-136` — pero el registry actual
  (`chainRegistry.register()` / `_isValidAdapter()` en
  `src/chains/registry.ts:35-65,142-156`) exige `getPublicClient` /
  `getWalletClient` (viem, EVM-específico) porque tipa el Map como
  `Map<string, ChainAdapter>`. Esta HU probablemente requiere que el
  Architect decida entre (a) relajar el registry para aceptar
  `SettlementAdapter` puro, o (b) el adaptador Solana implementa stubs de
  esos dos métodos que lanzan/rechazan explícitamente. Ver Missing Inputs.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO comparar el asset Solana por símbolo, nombre o metadata —
  SOLO por pubkey exacta del mint (AC-1).
- CD-2: PROHIBIDO derivar el monto verificado de "contar instrucciones
  Transfer" — SOLO por delta de `pre/postTokenBalances` de la ATA destino
  (AC-2).
- CD-3: PROHIBIDO usar `number`/`uiAmount` (float) en cualquier punto del
  cálculo de monto — SOLO `bigint`/string decimal (AC-3).
- CD-4: PROHIBIDO que el dedup de Solana falle abierto (fail-open) ante una
  caída de Redis — el unique index Postgres es la barrera dura, no
  opcional, no negociable (AC-4). Esto es una inversión explícita respecto
  al patrón EVM (`SETTLE_CAP_FAIL_MODE` default `'open'`, ver
  `src/infra/env.ts:206-247` y el incidente 2026-06-29 documentado ahí) —
  NO copiar esa justificación fail-open para Solana; el nonce on-chain que
  la sustenta en EVM no existe aquí.
- CD-5: OBLIGATORIO `commitment: 'finalized'` en toda lectura de tx Solana
  usada para verify (AC-5) — prohibido `confirmed`/`processed` para esta
  ruta.
- CD-6: OBLIGATORIO mantener el boundary OWNERS.md existente
  (`src/chains/*` sin imports runtime de `src/infra/*` salvo lo ya permitido
  — confirmar patrón exacto para `SOLANA_RPC_URL`/`SOLANA_USDC_MINT` en F2,
  mismo problema que ya documentó `base-adapter.ts:76-85` para
  `OPERATOR_MIN_BALANCE_WEI`).

## Missing Inputs
- [bloqueante-F2] Shape exacto de `settle()` para el adaptador Solana: dado
  que `core/settle.ts` despacha `solana:*` al mismo `adapter.settle()` que
  verify (línea 60 de `src/core/settle.ts`), y que WKH-204 documenta que
  Solana "auto-broadcasts from the client wallet" (no hay wallet operador
  que emita la tx), ¿`settle()` en esta HU es (a) un alias de `verify()`
  que además persiste en el ledger, (b) un stub que retorna
  `CHAIN_UNAVAILABLE`/`METHOD_NOT_SUPPORTED` explícito, o (c) queda fuera de
  scope y el título "verify + dedup" implica que solo `verify()` se
  implementa completo? El Architect debe resolverlo en F2 — no asumido acá.
- [bloqueante-F2] Definición exacta de la clave de dedup: ¿`signature`
  (firma de la tx Solana, análogo a tx_hash) o `reference` (patrón x402
  Solana de referencia embebida en memo/instrucción, como usan otros
  facilitators x402-Solana)? Determina el DDL del unique index.
- [bloqueante-F2] Cómo resolver la tensión DT-3 (registry tipado a
  `ChainAdapter` con métodos viem-específicos) sin romper
  `chainRegistry._isValidAdapter()` — el Architect debe decidir el diseño
  concreto (relajar el type guard vs. stubs) antes de F2.5.
- [resuelto en F2] Código de error x402 exacto para "mint/asset mismatch"
  y "duplicate transaction" (AC-1, AC-4) — hoy `X402ErrorCode` no tiene
  literal específico para Solana; confirmar si se reutiliza
  `NETWORK_MISMATCH`/`INVALID_AMOUNT` o se agrega uno nuevo.
- [informativo] `@solana/web3.js` NO está en `package.json` (confirmado F0)
  — se agrega en esta HU. Versión exacta a decidir en F2 (recomendado:
  última estable compatible con Node >=22, mismo engine que el resto del
  repo).

## Análisis de paralelismo
- Depende de HU-SOL-2 (WKH-204) — DONE, mergeado, deployado (fila 025 del
  `_INDEX.md`, estado "DONE (HELD — no merge; prod/Railway)" — nota: el
  estado real en prod confirma que el dispatch por namespace ya está en
  producción, así que esta HU no bloquea ni es bloqueada por trabajo de
  infraestructura pendiente).
- Bloquea HU-SOL-13 (verificación de vault/escrow — necesita el adaptador
  base) y HU-SOL-14 (gasless).
- Puede correr en paralelo con cualquier HU que NO toque `src/chains/registry.ts`,
  `src/core/verify.ts`, `src/core/settle.ts`, `src/infra/env.ts` ni
  `supabase/migrations/*` simultáneamente (riesgo de conflicto de migración
  si otra HU también agrega un archivo `003_*.sql`+ en paralelo — coordinar
  el número de migración con el Architect antes de F3).
- No tiene relación con el track Chaski/remit-* (repos separados).
