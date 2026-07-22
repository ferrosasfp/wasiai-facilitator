# SDD — [WKH-205 / HU-SOL-6] Facilitator: adaptador Solana (verify + dedup)

- **SDD_MODE**: full
- **Mode**: QUALITY + AR (money-adjacent — dedup durable + registry money-path)
- **Gate previo**: HU_APPROVED (OK)
- **Input**: `doc/sdd/026-hu-sol-6-solana-adapter/work-item.md` (6 ACs EARS, DT-1..3, CD-1..6, Missing Inputs)
- **Migración asignada**: `003_facilitator_solana_dedup.sql` (siguiente NNN libre; existen 001, 002)

---

## 0. Resolución de las 4 Clarifications (bloqueantes-F2) — CERRADAS

| # | Clarification | Resolución F2 |
|---|---------------|---------------|
| 1 | Shape de `settle()` Solana | **verify-only + dedup-mark durable + ledger persist**. `settle()` = corre toda la validación de `verify()` + INSERT atómico de la `signature` en la tabla de dedup (que **es** el ledger de settlements Solana) + fail-CLOSED en unique-violation o error de store. NO broadcastea nada. Hereda auth/rate-limit/audit de `/settle`. Ver DT-5. |
| 2 | Clave de dedup durable | **`signature` (firma base58 de la tx Solana)** como columna del `UNIQUE` index — ancla inmutable de prueba on-chain. ADEMÁS se valida `reference` (Solana Pay) como binding del pago, pero la barrera dura es `UNIQUE(signature)`. Ver DT-1, DDL en §7. |
| 3 | Tensión de tipos del registry | **Opción (a)**: el Map interno pasa a `Map<string, SettlementAdapter>`; `register(SettlementAdapter)`; `_isValidAdapter` valida shape base (`metadata`/`verify`/`settle`); `getAdapter(chainId)` **conserva su contrato `ChainAdapter` O(1) EVM** vía narrowing duck-typed (cero ripple a consumidores EVM que llaman `getPublicClient`). Ver DT-3. |
| 4 | Códigos de error x402 | **Reuso de códigos existentes, CERO valores nuevos en `X402ErrorCode`** (lección WFAC-148 + auto-blindaje 024#W0): mint/program-id/reference mismatch → `NETWORK_MISMATCH` (400); duplicado/replay + store-outage fail-closed + tx-no-finalizada → `TRANSACTION_FAILED` (500, consistente con EVM: replay de nonce EIP-3009 revierte → TRANSACTION_FAILED; además 500 NO cachea por CD-12 → ideal fail-closed); shortfall de monto → `INVALID_AMOUNT` (400); payTo/ATA mismatch → `INVALID_RECEIVER` (400). Ver DT-6 + tabla §6. **Flag opcional al gate** (no tomado): un `DUPLICATE_TRANSACTION` dedicado (409) sería más limpio pero obliga a editar las dos uniones route-local + los dos `Record` de `core/errors.ts` + auditar ripple (025#W3) → se difiere a la HU de wire-format (§8). |

**No blockers restantes.** Las 4 clarifications quedan cerradas; el único gap conocido (wire-format HTTP Solana) está fuera de scope y flaggeado en §8 — no bloquea ninguno de los 6 ACs (todos son adapter-internos).

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/chains/types.ts` | Contrato `SettlementAdapter` (WKH-204) + `ChainAdapter extends SettlementAdapter` + `VerifyResult`/`SettleResult` | `SettlementAdapter` = `{ metadata, verify, settle, getBreakerState?, setLogger? }` (SIN viem clients). `VerifyResult`/`SettleResult` tienen campos branded `Address = \`0x${string}\``. |
| `src/chains/registry.ts` | Generalización del registry (steer #3) | Map YA está keyed por `networkId: string` (`_adapters.set(networkId, ...)`); `getAdapter(chainId)` es wrapper `eip155:${id}` + `Map.get` (O(1)); `_isValidAdapter` exige `getPublicClient`/`getWalletClient` (EVM-only — hay que relajar). |
| `src/chains/base-adapter.ts` | Exemplar de adapter EVM + lectura de env por el boundary OWNERS | Un `src/chains/*` LEE `process.env` DIRECTO (`readOperatorMinBalanceWei` → `process.env['OPERATOR_MIN_BALANCE_WEI']`), NO importa `src/infra/env.ts`. BigInt para montos u64/uint256 (nunca Number). Verify devuelve `AdapterResult` sin lanzar. |
| `src/core/verify.ts` / `src/core/settle.ts` | Dispatch namespace (WKH-204 ya lo tiene) | Rama `solana:` ANTES del cuerpo eip155: valida `^solana:(devnet|mainnet)$` → `getAdapterByNetworkId(network)` → `adapter.verify/settle(parsed as unknown as VerifyParams/SettleParams)`. Cluster inválido → `NETWORK_MISMATCH`; namespace sin adapter → `CHAIN_UNAVAILABLE`. **No agregar códigos nuevos.** |
| `src/core/idempotency.ts` | Redis cache actual (DT-1: se conserva como cache, NO como fuente de verdad anti-replay Solana) | `settle:inflight:` lock es fail-OPEN (justificado por el nonce on-chain EVM) — **NO copiar ese fail-open a Solana** (CD-4). |
| `src/core/schemas.ts` | Shape del request Zod | **HALLAZGO CRÍTICO**: `AcceptedSchema.asset`/`payTo` son `AddressHexSchema` (0x-hex) y `assetTransferMethod` ∈ {eip3009,permit2,erc7710}. Un request Solana (mint/payTo base58) NO pasa el gate Zod del route hoy → wire-format HTTP Solana está fuera de scope (§8). |
| `supabase/migrations/001_facilitator_settlements.sql` | Patrón del unique index existente | `idempotency_key TEXT NOT NULL UNIQUE`; `amount NUMERIC(78,0)` para uint256; índices `IF NOT EXISTS`; migración idempotente, no editar tras push. |
| `src/core/ledger.ts` + `src/infra/supabase.ts` | Patrón de persistencia + null-handling | `getSupabaseClient()` devuelve `null` si Supabase no configurado; ledger EVM trata `null` como **no-op (fail-open)**. **Solana INVIERTE esto**: `null` → no se puede dedup → fail-CLOSED (CD-4). UPSERT `onConflict:'idempotency_key', ignoreDuplicates:true`. |
| `src/infra/env.ts` | Patrón opt-in `KITE_MAINNET_ENABLED` | Flags opt-in: `z.enum(['true','false']).default('false').transform(...)`; token/RPC addresses `.optional()`, NUNCA en `.superRefine` (opt-in). `z.coerce.boolean()` PROHIBIDO. |
| `src/core/errors.ts` + `src/core/types.ts` | `X402ErrorCode` (12 valores) + `Record` exhaustivos | Agregar un valor obliga a tocar ambos `Record` + ambas uniones route-local (auto-blindaje 024#W0). → Reuso puro (DT-6). |
| `src/routes/verify.ts` / `src/routes/settle.ts` | Uniones route-local `VerifyRouteErrorCode`/`SettleRouteErrorCode` | Ambas listan los 12 `X402ErrorCode` + extras. `NETWORK_MISMATCH`/`TRANSACTION_FAILED`/`INVALID_AMOUNT`/`INVALID_RECEIVER` YA están en ambas → reuso = **cero edits en routes** (respeta CD-2). |
| `src/core/health-status.ts:86` + `src/chains/init-domain-check.ts:65,87` | Consumidores que llaman `lookup.adapter.getPublicClient()` | Fuerzan que `getAdapter(chainId)` SIGA devolviendo `ChainAdapter` (no `SettlementAdapter`) → narrowing en `getAdapter` (DT-3). |
| `OWNERS.md` | Boundaries | `src/chains/*` puede importar SOLO `chains/types`, `chains/abi/*`, `src/infra/wallet.ts`, viem. NO `infra/supabase`. → nueva excepción `[5]` para `infra/solana-dedup.ts` (DT-4). |
| Auto-blindajes 025#W3, 024#W0/W1, 023#W0 | Errores recurrentes | Ver CD-7..CD-13 (§5). |

---

## 2. Arquitectura de la solución (visión)

```
POST /settle  ──►  core/settle.ts (rama solana:)  ──►  chainRegistry.getAdapterByNetworkId("solana:devnet")
                                                                     │
                                                    SolanaAdapter (src/chains/solana-adapter.ts)
                                                    ├─ verify(): Connection.getTransaction(sig,{finalized,maxSupportedTransactionVersion:0})
                                                    │            · program-id pin (SOLANA_TOKEN_PROGRAM_ID)  [AC-1]
                                                    │            · mint EXACTO por pubkey (SOLANA_USDC_MINT)  [AC-1]
                                                    │            · monto = delta neto pre/postTokenBalances (BigInt) [AC-2,AC-3]
                                                    │            · reference match (Solana Pay)
                                                    │            · dedup SELECT (fail-CLOSED)               [AC-4]
                                                    └─ settle(): verify() + INSERT atómico signature       [AC-4, DT-5]
                                                                          │ (UNIQUE violation → duplicado)
                                                        src/infra/solana-dedup.ts  ──►  Supabase
                                                                          │             facilitator_solana_settlements
                                                                          │             UNIQUE(signature)  ← barrera dura
                                                        (null client / db error → fail-CLOSED reject)
```

Boundary-clean: el adapter (`src/chains/*`) NO importa `infra/supabase` directo; usa `src/infra/solana-dedup.ts` (nueva excepción OWNERS `[5]`, espejo del precedente `src/infra/wallet.ts`). La tabla de dedup **es** el ledger de settlements Solana (doble propósito) → no toca `core/ledger.ts` ni `facilitator_settlements`.

---

## 3. Decisiones técnicas (DT-N)

### DT-1 — Dedup durable = `UNIQUE(signature)` en Postgres; Redis solo cache
Fuente de verdad anti-replay = `facilitator_solana_settlements.signature UNIQUE` (Postgres), análogo a `facilitator_settlements.idempotency_key UNIQUE`. Redis (`core/idempotency.ts`) sigue existiendo como cache de baja latencia PERO NO es la barrera (a diferencia de EVM, Solana verify-only no tiene nonce on-chain que backstopee el replay). La `signature` es la clave por ser el identificador inmutable on-chain de la tx. `reference` (Solana Pay) se valida como binding del pago pero NO es la clave del unique index (una tx puede reusar reference en flujos legítimos; la firma no).

### DT-2 — Precisión u64 con BigInt + `::text` en selects (heredado WKH-196)
Todo monto (`expectedAmount`, deltas de balance, `amount` persistido) se maneja como `bigint`/string decimal. Las lecturas de `preTokenBalances[i].uiTokenAmount.amount` / `postTokenBalances[i].uiTokenAmount.amount` (strings del RPC) se parsean con `BigInt(...)`, NUNCA `Number(...)` ni `uiAmount` (float) — u64 excede 2^53. La columna `amount NUMERIC(78,0)`: cualquier `select` vía supabase-js que la lea DEBE usar `::text` cast (PostgREST devuelve JSON number → pierde precisión >2^53). El dedup normalmente solo consulta existencia de `signature` (no lee amount), pero el CD-9 cubre cualquier select futuro.

### DT-3 — Registry generalizado a `SettlementAdapter` SIN ripple a consumidores EVM
- Map interno: `Map<string, SettlementAdapter>` (ya keyed por `networkId` string → O(1) preservado).
- `register(adapter: SettlementAdapter): RegisterResult` — acepta EVM (ChainAdapter) y no-EVM (SettlementAdapter puro).
- `_isValidAdapter(candidate)`: valida SOLO shape base (`typeof metadata === 'object'`, `metadata.chainId` number, `typeof verify === 'function'`, `typeof settle === 'function'`). **Se ELIMINAN** los checks `getPublicClient`/`getWalletClient` (EVM-only, no aplican a Solana).
- `getAdapterByNetworkId(networkId)`: return type ensanchado a `{ ok:true, adapter: SettlementAdapter }`. Consumido solo por las ramas `solana:` de `core/verify.ts:53` y `core/settle.ts:50` (solo llaman `.verify`/`.settle` → OK).
- `getAdapter(chainId)`: **conserva su contrato `{ ok:true, adapter: ChainAdapter }` byte-idéntico** para no romper `health-status.ts:86` ni `init-domain-check.ts:87`. Internamente hace `getAdapterByNetworkId('eip155:'+chainId)` → si `ok`, aplica un narrowing duck-typed `_isChainAdapter(a): a is ChainAdapter` (`typeof a.getPublicClient === 'function' && typeof a.getWalletClient === 'function'`) → si pasa, devuelve `adapter` como `ChainAdapter`; si NO (jamás pasa: un `eip155:*` siempre es ChainAdapter), devuelve `NETWORK_MISMATCH`. Esto hace el cast SANO (no un `as` a ciegas) y O(1) (dos `typeof`).
- **Consecuencia AC-6**: como `getAdapter(chainId)` sigue devolviendo `ChainAdapter`, `health-status`, `init-domain-check`, `init-breakers`, `supported` NO requieren edición. El Dev DEBE correr `npm run typecheck` tras W0 y, si aparece cualquier ripple fuera de `registry.ts`, **PARAR y escalar** (lección 025#W3), no editar archivos fuera de scope.

### DT-4 — Dedup en `src/infra/solana-dedup.ts` + excepción OWNERS `[5]`
El adapter (`src/chains/*`) no puede importar `infra/supabase` (OWNERS). Se crea `src/infra/solana-dedup.ts` (capa infra → puede importar `getSupabaseClient` de `infra/supabase`) que expone la lógica Postgres. Se agrega a `OWNERS.md` la excepción `[5]`: `src/chains/solana-adapter.ts` MAY import `src/infra/solana-dedup.ts` (espejo exacto del precedente `src/infra/wallet.ts` para `src/chains/*`). El dedup store es la dependencia infra obligatoria del money-path de la red no-EVM, análoga al operator wallet en EVM.

Contrato fail-CLOSED (CD-4), invierte el null-handling del ledger EVM:
```
isSolanaSignatureSettled(signature): Promise<
  | { ok: true; settled: boolean }     // consulta OK
  | { ok: false }                       // no client / db error / timeout → CALLER DEBE RECHAZAR
>
recordSolanaSignature(entry): Promise<
  | { ok: true; inserted: true }        // insert OK (primer settle)
  | { ok: true; inserted: false }       // UNIQUE violation (23505) → DUPLICADO
  | { ok: false }                       // no client / db error → CALLER DEBE RECHAZAR
>
```
`ok:false` NUNCA se traduce a "permitir" (esto es lo opuesto al swallow-to-allow del ledger EVM). El adapter mapea `ok:false` → `TRANSACTION_FAILED` (fail-closed).

### DT-5 — `settle()` Solana = verify + INSERT atómico + ledger (la tabla dedup ES el ledger)
`settle()`:
1. Corre la validación completa de `verify()` (mint/program-id/delta/bigint/finalized/reference).
2. Si verify falla → devuelve ese error verbatim (no persiste).
3. Si verify OK → `recordSolanaSignature({ signature, network, reference, mint, payTo, amount })` (INSERT atómico).
   - `inserted:true` → éxito (fila = dedup mark + settlement ledger, doble propósito).
   - `inserted:false` (UNIQUE violation) → **duplicado** → `TRANSACTION_FAILED` ("duplicate transaction — replay rejected").
   - `ok:false` → fail-CLOSED → `TRANSACTION_FAILED` ("dedup store unavailable").
4. Devuelve `SettleResult` (shape reusado, DT-7).

La barrera atómica real es el INSERT en settle (serializa dos settles concurrentes de la misma firma: el segundo choca con UNIQUE). `verify()` hace un SELECT (best-effort + AC-4) que NO inserta → verify sigue repetible para firmas aún no settled. NO se toca `core/ledger.ts` ni `facilitator_settlements` (EVM).

### DT-6 — Reuso puro de `X402ErrorCode` (cero valores nuevos)
Ver tabla §6. Justificación: (a) evita el ripple de auto-blindaje 024#W0 (widening rompe ambas uniones route-local + ambos `Record`); (b) `TRANSACTION_FAILED` es el código que la vía EVM emite para un replay de nonce (revert on-chain) → replay Solana → `TRANSACTION_FAILED` es behavioralmente consistente cross-rail; (c) `TRANSACTION_FAILED`=500 NO cachea (CD-12) → un outage transitorio del dedup store nunca memoiza un resultado erróneo (perfecto para fail-closed). Los mensajes (`message`) diferencian los casos en logs sin agregar códigos.

### DT-7 — Shape `VerifyResult`/`SettleResult` reusado; base58 en campos string vía cast documentado
El adapter produce el shape existente `VerifyResult`/`SettleResult` (NO se modifica `src/chains/types.ts` shapes ni el idempotency cache ni los serializers de route — disciplina de scope, evita ripple 025#W3). Los campos branded `Address` (`client`/`asset`/`payTo`/`from`/`to`) transportan pubkeys base58 para el namespace solana, construidos vía un único `as unknown as Address` en el boundary de retorno (mismo patrón sancionado que `core/verify.ts:124` `parsed as unknown as VerifyParams`). Los routes serializan estos campos verbatim (no los parsean como EVM). `expiresAt = 0` (Solana verify es point-in-time sobre una tx finalizada; sin ventana de validez forward). La `signature` NO se agrega al shape público: el dedup la deriva del input del request independientemente.

### DT-8 — Dependencia `@solana/web3.js` **v1.x** (NO v2)
Se pinea `@solana/web3.js@^1` (classic `Connection.getTransaction` API con `{ commitment, maxSupportedTransactionVersion }`). **NO** usar `@solana/web3.js` 2.x (kit modular, API distinta `@solana/*` — rompería el patrón `Connection`). El Dev fija la versión resuelta exacta en `package.json` (no `^` flotante en el lockfile) y confirma `node >=22` (engine del repo). Node 22 trae `fetch` global → no requiere polyfill.

### DT-9 — `Connection` inyectable para tests (DI)
El `SolanaAdapter` recibe en el constructor un `connection?: Connection` (o factory) opcional; en producción construye `new Connection(rpcUrl, 'finalized')` desde `process.env['SOLANA_RPC_URL']`. Los tests inyectan un fake con `getTransaction` mockeado (evita red). Mirror del patrón `BaseAdapterOpts` de base-adapter. Los tests que mockeen `infra/solana-dedup` lo hacen vía `vi.mock('../../infra/solana-dedup.js')`.

### DT-10 — Config del adapter leída de `process.env` directo (CD-6 heredado)
`SOLANA_RPC_URL`, `SOLANA_USDC_MINT`, `SOLANA_TOKEN_PROGRAM_ID` se leen con `process.env[...]` DENTRO del factory del adapter (patrón `base-adapter.ts:99-105`). Se AGREGAN igualmente al schema Zod de `src/infra/env.ts` (validación/documentación + fail-fast si formato inválido), pero el adapter NO importa `infra/env.ts` (boundary). `SOLANA_TOKEN_PROGRAM_ID` default = `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic SPL Token program). Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) NO es el default → rechazado por AC-1.

### DT-11 — Factory opt-in (`solanaAdapter | null`)
`src/chains/solana-adapter.ts` exporta `solanaAdapter: SolanaAdapter | null` = `null` salvo que `SOLANA_RPC_URL` **y** `SOLANA_USDC_MINT` estén seteadas (patrón `kiteMainnetAdapter`/`baseSepoliaAdapter`). `src/chains/index.ts`: `if (solanaAdapter !== null) chainRegistry.register(solanaAdapter);`. En test/default (sin env) → NO se registra → toda la suite EVM corre idéntica (AC-6).

---

## 4. Diseño detallado de `verify()` (algoritmo — cubre AC-1..AC-5)

Entrada: `params` (casteado desde el request). Se extrae vía guard `parseSolanaInput(params): AdapterResult<SolanaInput>` con validación base58 (rechaza malformados → `NETWORK_MISMATCH`):
- `network` = `params.accepted.network` (`solana:devnet|mainnet`)
- `expectedMint` = `params.accepted.asset` (base58)
- `payTo` = `params.accepted.payTo` (base58, owner destino)
- `expectedAmount` = `BigInt(params.accepted.amount)` (atomic)
- `signature` = firma base58 de la tx (de `params.payload`)
- `reference` = pubkey base58 Solana Pay (de `params.payload`)

Pasos:
1. **getTransaction** (AC-5): `connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })`. Si `null` (no encontrada / no finalizada) → `TRANSACTION_FAILED` ("tx not found or not finalized"). Prohibido reintentar con `confirmed`/`processed` (CD-5).
2. **tx success**: si `tx.meta?.err !== null` → `TRANSACTION_FAILED` ("on-chain tx failed"). Una tx revertida no paga.
3. **program-id pin** (AC-1, CD-1): localizar los token-balance entries del destino; su `programId` DEBE `=== SOLANA_TOKEN_PROGRAM_ID` (igualdad exacta de pubkey). Token-2022 u otro program → `NETWORK_MISMATCH` ("unsupported token program"). Prohibido soportar Token-2022 transfer-fee.
4. **mint exacto** (AC-1, CD-1): el `mint` del token-balance destino DEBE `=== expectedMint` por igualdad EXACTA de pubkey (`PublicKey.equals` o string base58 exacto). NUNCA por símbolo/nombre/decimales. Mint falso mismo símbolo → `NETWORK_MISMATCH` ("mint mismatch").
5. **delta de balance neto** (AC-2, AC-3, CD-2, CD-3): de `meta.preTokenBalances` y `meta.postTokenBalances`, seleccionar (por acceso literal-keyed sobre interfaz tipada, NO index dinámico — evita `security/detect-object-injection`, lección 023#W0) los entries donde `owner === payTo && mint === expectedMint && programId === SOLANA_TOKEN_PROGRAM_ID`. `preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n`; `postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n`; `delta = postAmt - preAmt`. **`delta` es neto sobre TODA la tx** → si una instrucción posterior vacía la ATA (transferencia compensatoria), `delta` ya refleja el neto real. NUNCA derivar el monto de "contar instrucciones Transfer".
6. **monto suficiente** (AC-2): si `delta < expectedAmount` → `INVALID_AMOUNT` ("net delta below accepted amount"). (Rechaza el caso compensatorio de AC-2 con el neto real.)
7. **reference match**: `reference` DEBE aparecer en las account keys de la tx (`tx.transaction.message.getAccountKeys()` / staticAccountKeys). Ausente → `NETWORK_MISMATCH` ("payment reference not found in tx"). Binding tx↔pago.
8. **dedup SELECT** (AC-4, CD-4): `isSolanaSignatureSettled(signature)`. `ok:false` → fail-CLOSED → `TRANSACTION_FAILED` ("dedup store unavailable"). `settled:true` → replay → `TRANSACTION_FAILED` ("duplicate transaction — replay rejected"). `settled:false` → continuar. **verify NO inserta** (repetible para firmas no-settled).
9. **éxito**: devolver `VerifyResult` con base58 en campos string (DT-7), `amount = expectedAmount.toString()`, `network`, `expiresAt: 0`.

`settle()` = pasos 1–9 de verify + INSERT atómico (DT-5). El adapter envuelve verify/settle SIN circuit breaker (el CB actual es EVM-específico vía `ChainCircuitBreaker`; extenderlo a Solana es Scope OUT del work-item). Nunca lanza: todo error → `AdapterResult` (contrato core/*).

---

## 5. Constraint Directives (CD-N)

**Heredados del work-item** (CD-1..CD-6):
- **CD-1**: PROHIBIDO comparar el asset Solana por símbolo/nombre/metadata — SOLO por pubkey exacta del mint (AC-1) + program-id pin exacto.
- **CD-2**: PROHIBIDO derivar el monto de "contar instrucciones Transfer" — SOLO delta neto de `pre/postTokenBalances` del destino (AC-2).
- **CD-3**: PROHIBIDO `number`/`uiAmount` (float) en cualquier punto del cálculo de monto — SOLO `BigInt`/string decimal (AC-3).
- **CD-4**: PROHIBIDO que el dedup Solana falle-abierto ante caída de Redis/Postgres — el `UNIQUE(signature)` es la barrera dura + `isSolanaSignatureSettled`/`recordSolanaSignature` `ok:false` → RECHAZO. NO copiar el fail-open EVM (`SETTLE_CAP_FAIL_MODE`/inflight-lock) — el nonce on-chain que lo justifica en EVM no existe aquí.
- **CD-5**: OBLIGATORIO `commitment: 'finalized'` en toda lectura de tx Solana — prohibido `confirmed`/`processed`.
- **CD-6**: OBLIGATORIO mantener el boundary OWNERS: el adapter lee `process.env` directo (NO importa `infra/env.ts`) y accede a Postgres SOLO vía `infra/solana-dedup.ts` (excepción `[5]`, NO importa `infra/supabase` directo).

**Nuevos del SDD** (CD-7..CD-13, varios anclados en auto-blindaje histórico):
- **CD-7** (anti-ripple de tipos — ref: WKH-204 auto-blindaje#3 / 025#W3): PROHIBIDO que la generalización del registry rompa cualquier archivo fuera de `src/chains/registry.ts`. `getAdapter(chainId)` DEBE seguir devolviendo `ChainAdapter`. Tras W0, `npm run typecheck` debe pasar sin editar `core/health-status.ts`, `chains/init-domain-check.ts`, `core/supported.ts`, `chains/init-breakers.ts`, `routes/*`. Si aparece un ripple → PARAR y escalar.
- **CD-8** (anti-ripple X402ErrorCode — ref: WKH-148 auto-blindaje#W0): PROHIBIDO agregar valores a `X402ErrorCode`. Solo reuso (tabla §6). Si un valor nuevo se juzgara imprescindible → escalar al gate (edita ambas uniones route-local + ambos `Record` de `core/errors.ts` + audita ripple), NO agregarlo silenciosamente.
- **CD-9** (precisión NUMERIC(78,0) — ref: WKH-196): cualquier `select` supabase-js de `facilitator_solana_settlements.amount` DEBE castear `::text`. Reads de RPC `uiTokenAmount.amount` → `BigInt(...)` siempre.
- **CD-10** (ESLint object-injection — ref: 023#W0): iterar `pre/postTokenBalances` por acceso literal-keyed sobre interfaz tipada (`entry.owner`, `entry.mint`, `entry.uiTokenAmount.amount`), NUNCA index dinámico `arr[i]` con `i` variable como sink. `.find(...)`/`.filter(...)` sobre campos literales. `eslint-disable` solo para claves fijas no atacante-controladas, con `--` reason.
- **CD-11** (type-imports — ref: 024#tests): en tests, tipar módulos dinámicos vía top-level `import type * as X from ...`, nunca `typeof import('...')` inline.
- **CD-12** (toolchain — ref: 024#gate): el gate es `npm run qa` = `typecheck && lint (eslint --max-warnings 0) && format:check (prettier) && test (vitest run)`. NO biome.
- **CD-13** (mocks parciales — ref: 024#W1): agregar `getTransaction`/dedup en el path Solana NO afecta mocks EVM (path separado). Los tests Solana que mockeen `Connection` deben stubbear `getTransaction`; los que mockeen el dedup deben cubrir `ok:false` (fail-closed).

---

## 6. Tabla de mapeo de errores (reuso puro — DT-6, CD-8)

| Condición | Código X402 (existente) | HTTP | Message (override) |
|-----------|------------------------|------|--------------------|
| mint ≠ SOLANA_USDC_MINT | `NETWORK_MISMATCH` | 400 | "mint mismatch" |
| program-id ≠ SPL Token classic (Token-2022, etc.) | `NETWORK_MISMATCH` | 400 | "unsupported token program" |
| reference ausente en la tx | `NETWORK_MISMATCH` | 400 | "payment reference not found in tx" |
| input malformado (base58/campos) | `NETWORK_MISMATCH` | 400 | "invalid solana request" |
| delta neto < monto esperado | `INVALID_AMOUNT` | 400 | "net delta below accepted amount" |
| payTo/ATA no coincide (owner destino) | `INVALID_RECEIVER` | 400 | "receiver ATA mismatch" |
| tx no encontrada / no finalizada | `TRANSACTION_FAILED` | 500 | "tx not found or not finalized" |
| tx on-chain err ≠ null | `TRANSACTION_FAILED` | 500 | "on-chain tx failed" |
| **duplicado / replay** (UNIQUE violation o SELECT settled) | `TRANSACTION_FAILED` | 500 | "duplicate transaction — replay rejected" |
| **dedup store no disponible** (fail-CLOSED) | `TRANSACTION_FAILED` | 500 | "dedup store unavailable" |
| namespace solana sin adapter registrado (opt-in off) | `CHAIN_UNAVAILABLE` | 503 | (ya lo emite `core/verify.ts:57`, sin cambio) |

Todos estos códigos YA existen en `X402ErrorCode` y en ambas uniones route-local + ambos `Record` de `core/errors.ts` → **cero edits en `core/types.ts`, `core/errors.ts`, `routes/verify.ts`, `routes/settle.ts`**.

---

## 7. DDL — migración `003_facilitator_solana_dedup.sql`

```sql
-- supabase/migrations/003_facilitator_solana_dedup.sql
-- WKH-205 / HU-SOL-6 — Durable anti-replay + settlement ledger para Solana verify-only.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Barrera dura anti-double-spend: UNIQUE(signature). A diferencia de EVM (nonce
-- on-chain revierte el replay), Solana verify-only NO tiene backstop on-chain →
-- este UNIQUE es la única línea de defensa (CD-4, fail-CLOSED en app-layer).
-- La tabla es DUAL: dedup mark + settlement ledger Solana (DT-5). Sin PII.

CREATE TABLE IF NOT EXISTS facilitator_solana_settlements (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  signature   TEXT          NOT NULL UNIQUE,   -- firma base58 de la tx (id inmutable on-chain)
  network     TEXT          NOT NULL,          -- 'solana:devnet' | 'solana:mainnet'
  reference   TEXT          NULL,              -- Solana Pay reference (pubkey base58), opcional
  mint        TEXT          NOT NULL,          -- SPL mint pubkey base58 (== SOLANA_USDC_MINT)
  pay_to      TEXT          NOT NULL,          -- owner/ATA destino (pubkey base58)
  amount      NUMERIC(78,0) NOT NULL,          -- delta neto atomic u64 (uint256-safe; leer con ::text — CD-9)
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fss_created_at ON facilitator_solana_settlements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fss_network    ON facilitator_solana_settlements (network);
CREATE INDEX IF NOT EXISTS idx_fss_reference  ON facilitator_solana_settlements (reference)
  WHERE reference IS NOT NULL;

COMMENT ON TABLE  facilitator_solana_settlements IS
  'WKH-205: dedup durable (UNIQUE signature) + settlement ledger Solana verify-only. Fail-CLOSED app-layer. No PII.';
COMMENT ON COLUMN facilitator_solana_settlements.signature IS
  'Firma base58 de la tx Solana. UNIQUE = barrera anti-replay (no hay nonce on-chain que la sustituya).';
COMMENT ON COLUMN facilitator_solana_settlements.amount IS
  'Delta neto atomic (u64). NUMERIC(78,0). Leer SIEMPRE con ::text cast (precision-loss >2^53 — WKH-196).';
```

`recordSolanaSignature` hace `INSERT` (no upsert-ignore): una UNIQUE violation (Postgres code `23505`) se detecta y se mapea a `inserted:false` (duplicado). El resto de errores → `ok:false` (fail-closed).

---

## 8. Gap conocido / FLAGGED (fuera de scope, no bloquea ACs)

**Wire-format HTTP Solana — Scope OUT (follow-up HU-SOL-X).** El `VerifyRequestSchema` (`src/core/schemas.ts`) NO puede representar un request Solana hoy: `AcceptedSchema.asset`/`payTo` exigen `AddressHexSchema` (0x-hex) y `assetTransferMethod` ∈ {eip3009,permit2,erc7710} (sin solana). Un request Solana con mint/payTo base58 falla el gate Zod del route ANTES de llegar al core. Extender el schema es un cambio en el request-path que ripplea a `routes/settle.ts` vía `buildLedgerEntry` (exactamente el bug de auto-blindaje 025#W3) → se difiere.

**Impacto**: esta HU entrega el ADAPTER + dedup + registry, **unit-testeado vía `adapter.verify(solanaShapedParams)` directo** (mock `Connection.getTransaction`). Solana NO es HTTP-reachable end-to-end hasta la HU de wire-format. **Los 6 ACs son todos adapter-internos** (mint, delta, bigint, dedup, finalized, no-regresión EVM) → se satisfacen sin el schema. AC-6 (no-regresión EVM) se satisface porque el adapter es opt-in-off por default.

**Cosmético (no-regresión EVM, aceptable)**: cuando Solana está opt-in-ON, su metadata aparece en `listAdapters()` → `health-status.probeChain` hace `getAdapter(solanaChainId)` → miss (solana bajo `solana:*`, no `eip155:*`) → muestra `rpc:'unreachable'` para la entrada solana; `init-domain-check`/`init-breakers` la saltean (miss). Ninguno crashea ni altera el comportamiento EVM. Health-probe real de Solana = follow-up junto al wire-format.

---

## 9. Waves de implementación

Cada wave cierra con gate verde: `npm run typecheck && npm run lint && npm run test` (mínimo), `npm run qa` completo al final.

### W0 — Deps + env + registry generalizado (serial; EVM 100% verde, Solana aún NO registrado)
- `package.json`: `npm install @solana/web3.js@^1` (v1.x, DT-8); pinear versión resuelta.
- `src/infra/env.ts`: agregar `SOLANA_RPC_URL` (`z.string().min(1).optional()`), `SOLANA_USDC_MINT` (`.optional()`), `SOLANA_TOKEN_PROGRAM_ID` (`.default('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')`). NINGUNO en `.superRefine` (opt-in, DT-10).
- `src/chains/registry.ts`: Map→`SettlementAdapter`; `register(SettlementAdapter)`; `_isValidAdapter` base-shape (drop viem checks); `getAdapterByNetworkId`→`SettlementAdapter`; `getAdapter`→narrowing `_isChainAdapter` guard→`ChainAdapter` (DT-3, CD-7).
- `OWNERS.md`: agregar excepción `[5]` (chains/solana-adapter ↔ infra/solana-dedup).
- **Gate**: typecheck sin ripple fuera de registry.ts (CD-7); suite EVM completa verde; `chain-registry.test.ts` sigue pasando (ajustar solo si el test asertaba el shape viejo de `_isValidAdapter`).

### W1 — Migración dedup + capa `infra/solana-dedup.ts`
- `supabase/migrations/003_facilitator_solana_dedup.sql` (§7).
- `src/infra/solana-dedup.ts`: `isSolanaSignatureSettled` + `recordSolanaSignature` (DT-4, fail-CLOSED, `::text` cast CD-9, detección `23505`).
- **Gate**: tests unit `solana-dedup` (mock supabase: insert OK, UNIQUE violation→inserted:false, null-client→ok:false, db-error→ok:false, SELECT settled/not-settled). EVM verde.

### W2 — `SolanaAdapter.verify()`
- `src/chains/solana-adapter.ts`: `class SolanaAdapter implements SettlementAdapter`; metadata (`networkId: solana:${cluster}`, chainId sintético documentado, `tokens:[mint]`); `parseSolanaInput` guard; `verify()` (algoritmo §4, pasos 1–9); constructor con `Connection` inyectable (DT-9); factory `solanaAdapter | null` opt-in (DT-11); lee `process.env` (DT-10). NO importa infra/env ni infra/supabase; SÍ importa infra/solana-dedup (excepción [5]).
- **Gate**: tests `verify` (happy + AC-1 mint-falso + AC-1 program-id Token-2022 + AC-2 delta-compensatorio + AC-3 u64>2^53 + AC-5 not-finalized/null + AC-4 replay-settled + fail-closed store). EVM verde.

### W3 — `settle()` + registro opt-in
- `SolanaAdapter.settle()` (DT-5: verify + `recordSolanaSignature` atómico; UNIQUE→duplicado; ok:false→fail-closed).
- `src/chains/index.ts`: `if (solanaAdapter !== null) chainRegistry.register(solanaAdapter);`.
- **Gate**: tests `settle` (happy INSERT, replay→UNIQUE violation reject, store-outage fail-closed) + registro simultáneo EVM+Solana (`getAdapter(43113)` intacto → ChainAdapter; `getAdapterByNetworkId('solana:devnet')` resuelve). EVM verde.

### W4 — Matriz de tests por AC + regresión EVM
- Consolidar `src/__tests__/unit/chains/solana-adapter.test.ts` con ≥1 test por AC (§10) + vectores de ataque.
- Regresión: `chain-registry.test.ts` con ambos rails; confirmar suite EVM byte-idéntica (843+ tests previos verdes).
- **Gate**: `npm run qa` completo verde.

---

## 10. Plan de tests (≥1 por AC + vectores de ataque)

Archivo nuevo: `src/__tests__/unit/chains/solana-adapter.test.ts` (mock `Connection.getTransaction` vía DI; mock `infra/solana-dedup` vía `vi.mock`). Nuevo: `src/__tests__/unit/solana-dedup.test.ts` (mock supabase, patrón `supabase.test.ts`/`ledger.test.ts`).

| Test | AC/CD | Vector | Espera |
|------|-------|--------|--------|
| T-SOL-1 happy verify | AC-1,2,3,5 | tx finalizada, mint correcto, delta≥monto, reference presente, no-settled | `ok:true`, amount correcto |
| T-SOL-2 mint falso mismo símbolo | AC-1, CD-1 | token-balance con mint distinto (símbolo "USDC" clonado) | `NETWORK_MISMATCH` "mint mismatch" |
| T-SOL-3 program-id Token-2022 | AC-1, CD-1 | `programId` = Token-2022 | `NETWORK_MISMATCH` "unsupported token program" |
| T-SOL-4 delta neto con compensatoria | AC-2, CD-2 | crédito X + débito posterior de la ATA → delta neto < monto | `INVALID_AMOUNT` (rechaza con neto real, no con el crédito aislado) |
| T-SOL-5 u64 > 2^53 | AC-3, CD-3 | `uiTokenAmount.amount` = "18446744073709551615" (u64 max) | parseo BigInt exacto, sin pérdida; comparación correcta |
| T-SOL-6 no finalizada / null | AC-5, CD-5 | `getTransaction` → null; y variante `meta.err ≠ null` | `TRANSACTION_FAILED`; se pidió `commitment:'finalized'` |
| T-SOL-7 replay (SELECT settled) | AC-4, CD-4 | dedup `isSolanaSignatureSettled` → `{ok:true,settled:true}` | `TRANSACTION_FAILED` "duplicate transaction — replay rejected" |
| T-SOL-8 dedup store outage (verify) | AC-4, CD-4 | `isSolanaSignatureSettled` → `{ok:false}` | fail-CLOSED → `TRANSACTION_FAILED` "dedup store unavailable" (NUNCA acepta) |
| T-SOL-9 settle happy | AC-4, DT-5 | verify OK + `recordSolanaSignature` → `{ok:true,inserted:true}` | `SettleResult` ok |
| T-SOL-10 settle replay UNIQUE | AC-4, CD-4, DT-5 | `recordSolanaSignature` → `{ok:true,inserted:false}` (23505) | `TRANSACTION_FAILED` duplicado |
| T-SOL-11 settle store outage | AC-4, CD-4 | `recordSolanaSignature` → `{ok:false}` | fail-CLOSED reject |
| T-SOL-12 reference ausente | binding | reference no está en accountKeys | `NETWORK_MISMATCH` "payment reference not found" |
| T-SOL-13 payTo/ATA mismatch | receiver | ningún token-balance con owner===payTo | `INVALID_RECEIVER` |
| T-DEDUP-1..4 | AC-4, CD-9 | insert OK / UNIQUE 23505 / null-client / db-error; `::text` en cualquier select | contrato §DT-4 |
| T-REG-1 registry base-shape | AC-6, DT-3 | `_isValidAdapter` acepta SettlementAdapter puro (sin viem clients) | `register` ok |
| T-REG-2 getAdapter EVM intacto | AC-6, CD-7 | `getAdapter(43113)` con Fuji registrado | devuelve ChainAdapter con `getPublicClient` |
| T-REG-3 EVM+Solana simultáneos | AC-6 | registrar Fuji + Solana; `getAdapterByNetworkId('solana:devnet')` | resuelve Solana; EVM sin cambio |
| T-REG-4 regresión suite EVM | AC-6 | toda la suite previa | verde byte-idéntica (Solana opt-in-off por default) |

---

## 11. Exemplars verificados (paths confirmados)

| Exemplar | Path (confirmado) | Qué se copia |
|----------|-------------------|--------------|
| Adapter EVM + lectura env boundary | `src/chains/base-adapter.ts` | estructura clase adapter, `process.env` directo, BigInt montos, `AdapterResult` sin lanzar |
| Factory opt-in `null` | `src/chains/kite.ts`, `src/chains/base.ts` (registrados en `src/chains/index.ts:36-40`) | patrón `xxxAdapter \| null` + `if (x !== null) register(x)` |
| Migración + UNIQUE | `supabase/migrations/001_facilitator_settlements.sql` | `UNIQUE`, `NUMERIC(78,0)`, `IF NOT EXISTS`, COMMENTs |
| Persistencia Supabase + null-handling | `src/core/ledger.ts`, `src/infra/supabase.ts` | `getSupabaseClient()` null-check (INVERTIDO a fail-closed), detección error |
| Env opt-in | `src/infra/env.ts:161-175` (`KITE_MAINNET_ENABLED`, `KITE_MAINNET_USDC_ADDRESS`) | `.optional()` / `.default()`, fuera de `.superRefine` |
| Dispatch namespace (ya existe) | `src/core/verify.ts:43-64`, `src/core/settle.ts:41-61` | rama `solana:` → `getAdapterByNetworkId` (NO se modifica) |
| Tests supabase/ledger | `src/__tests__/unit/supabase.test.ts`, `ledger.test.ts` | mock supabase-js pattern |
| Registry test | `src/__tests__/unit/chain-registry.test.ts` | asserts sobre `register`/`getAdapter`/`_isValidAdapter` |

---

## 12. Cobertura DT/CD ↔ AC

| AC | Cubierto por | Tests |
|----|--------------|-------|
| AC-1 mint+program-id exacto | §4 pasos 3-4, CD-1, DT-10 | T-SOL-2, T-SOL-3 |
| AC-2 delta neto | §4 pasos 5-6, CD-2 | T-SOL-4 |
| AC-3 bigint | §4 paso 5, DT-2, CD-3, CD-9 | T-SOL-5 |
| AC-4 dedup fail-CLOSED | §4 paso 8, DT-1, DT-4, DT-5, CD-4 | T-SOL-7/8/9/10/11, T-DEDUP-* |
| AC-5 finalized | §4 pasos 1-2, CD-5 | T-SOL-6 |
| AC-6 no-regresión EVM | DT-3, DT-11, CD-7, §8 | T-REG-1..4 |

---

## 13. Readiness Check

- [x] Work-item leído completo (6 ACs, DT-1..3, CD-1..6, Missing Inputs).
- [x] Stack confirmado: TypeScript strict, Fastify, Zod, supabase-js, viem (EVM), `@solana/web3.js@^1` (nuevo, DT-8). Node >=22.
- [x] Las 4 clarifications bloqueantes-F2 CERRADAS (§0). No blockers.
- [x] Exemplars verificados con Read (todos los paths de §11 existen).
- [x] Anti-alucinación: `SettlementAdapter`/`ChainAdapter` (types.ts:137-166), registry keyed por networkId (registry.ts:62), env opt-in (env.ts:161-175), dispatch solana (verify.ts:43-64/settle.ts:41-61), consumidores getPublicClient (health-status.ts:86, init-domain-check.ts:65,87) — todos confirmados.
- [x] Reuso puro de `X402ErrorCode` (cero valores nuevos, CD-8) — mapeo §6 con códigos existentes en ambas uniones route-local.
- [x] Migración: `003` es el siguiente NNN libre (001, 002 existen).
- [x] Auto-blindaje histórico aplicado: 025#W3 (ripple de tipos → CD-7 + §8), 024#W0 (X402ErrorCode → CD-8), 024#W1 (mocks parciales → CD-13), 023#W0 (object-injection → CD-10), 024#gate (toolchain → CD-12), WKH-196 (precisión → DT-2/CD-9).
- [x] Waves con gate verde por wave; W0 serial (contratos), W1-W4 incrementales.
- [x] Plan de tests ≥1 por AC + vectores de ataque (token falso mismo símbolo, tx multi-ix compensatoria, u64 grande, replay, store-outage).
- [ ] **Nota para F2.5/F3**: Scope IN del Story File DEBE incluir (exhaustivo): `package.json`, `src/infra/env.ts`, `src/chains/registry.ts`, `OWNERS.md`, `supabase/migrations/003_facilitator_solana_dedup.sql`, `src/infra/solana-dedup.ts`, `src/chains/solana-adapter.ts`, `src/chains/index.ts`, `src/__tests__/unit/chains/solana-adapter.test.ts`, `src/__tests__/unit/solana-dedup.test.ts`, y posibles ajustes de assert en `src/__tests__/unit/chain-registry.test.ts`. Wire-format schema FUERA de scope (§8).

**Veredicto**: SDD listo para SPEC_APPROVED. Sin `[NEEDS CLARIFICATION]` pendientes. El único gap conocido (wire-format HTTP) está documentado, flaggeado y fuera de scope sin afectar los 6 ACs.
