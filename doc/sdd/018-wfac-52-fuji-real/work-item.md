# Work Item — [WFAC-52] Avalanche Fuji Adapter REAL (verify + settle on-chain)

> **RETROACTIVE ARTIFACT** — This work-item documents a User Story that was
> implemented and merged to `main` BEFORE the NexusAgil pipeline ran (PR #33,
> commit `070875c`, 2026-04-24). It reflects what was effectively delivered, not
> a proposal. No implementation changes are expected from this document.
>
> Status: `RETROACTIVE — code merged before pipeline ran`
> HU-ID: WFAC-52
> Fecha: 2026-04-24
> PR: #33 | Commit: 070875c
> Artefactos previos (EXEMPLAR estructural): `doc/sdd/017-wfac-50-kite-testnet-adapter/`

---

## Resumen

Reemplazar los stubs de `_verifyRaw` y `_settleRaw` en `src/chains/avalanche.ts`
con implementaciones funcionales que operen contra la testnet Avalanche Fuji
(chainId 43113), replicando el patrón validado de `kite.ts` (WFAC-50). Incluye:
recuperación real de firma EIP-712 vía `recoverTypedDataAddress`, validaciones
de red/asset/amount/timestamp, normalización de firma (malleable/zero), flujo
simulate-before-write, `waitForTransactionReceipt` con timeout, y wallet operator
reutilizado vía `getOperatorAccount()` (ya creado en WFAC-50). El token canónico
es Circle USDC en Fuji (`0x5425890298aed601595a70AB815c96711a31Bc65`), hardcodeado
como constante de módulo (distinto de Kite, donde la address es env var). La
diferencia clave vs Kite: EIP-712 domain usa `{name:'USD Coin', version:'2',
chainId:43113}` (Kite/PYUSD usa `version:'1'`).

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: M
- **Pipeline**: QUALITY (toca payment path — categoría de riesgo)
- **Branch sugerido**: `feat/wfac-52-avalanche-fuji-real` (ya existió, mergeado)

Justificación M (vs L de WFAC-50): la infraestructura compartida (`wallet.ts`,
`abi/fiat-token.ts`, `circuit-breaker.ts`) ya existía post-WFAC-50. La HU es
un port casi 1:1 del patrón Kite; el delta real es el adaptador del dominio EIP-712,
la constante `USDC_FUJI`, y los 2 tests de comportamiento actualizado. No se creó
nuevo infra desde cero.

**Cambios del PR #33:**
- `src/chains/avalanche.ts`: 349 insertions / 32 deletions (540 LOC total, antes 231)
- `src/__tests__/unit/chain-adapter.test.ts`: 48 insertions — 2 tests de stub
  reemplazados por 4 tests de comportamiento real

---

## Acceptance Criteria (EARS)

### Verify — Network y Asset

- **AC-1**: WHEN `_verifyRaw` receives a VerifyParams where `accepted.network` is
  not `eip155:43113`, the system SHALL return
  `{ ok: false, error: { code: 'NETWORK_MISMATCH', http: 400 } }`
  without performing signature recovery.
  *(evidencia: `src/chains/avalanche.ts` líneas 212-219)*

- **AC-2**: WHEN `_verifyRaw` receives a VerifyParams where `accepted.asset` is not
  address-equal to the canonical Fuji USDC `0x5425890298aed601595a70AB815c96711a31Bc65`,
  the system SHALL return
  `{ ok: false, error: { code: 'NETWORK_MISMATCH', http: 400 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 222-230)*

### Verify — Validaciones pre-recovery

- **AC-3**: WHEN `_verifyRaw` receives a VerifyParams where
  `BigInt(authorization.value) < BigInt(accepted.amount)`, the system SHALL
  return `{ ok: false, error: { code: 'INVALID_AMOUNT', http: 400 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 236-245)*

- **AC-4**: WHEN `_verifyRaw` receives a VerifyParams where
  `BigInt(authorization.validBefore) <= BigInt(Math.floor(Date.now() / 1000))`,
  the system SHALL return
  `{ ok: false, error: { code: 'EXPIRED_AUTHORIZATION', http: 400 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 249-257)*

- **AC-5**: IF `normalizeSignature(params.payload.signature)` returns `{ ok: false }`
  (malleable high-s, zero scalar, or invalid length), THEN the system SHALL return
  `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }` WITHOUT calling
  `recoverTypedDataAddress`.
  *(evidencia: `src/chains/avalanche.ts` líneas 262-266)*

### Verify — Recovery y comparación

- **AC-6**: WHEN `recoverTypedDataAddress` throws for any reason (RPC unreachable,
  malformed typed data), the system SHALL catch the exception and return
  `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 293-305)*

- **AC-7**: WHEN all validations pass and the recovered signer address is NOT
  address-equal to `authorization.from`, the system SHALL return
  `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 307-314)*

- **AC-8**: WHEN all validations pass and the recovered signer equals `authorization.from`,
  the system SHALL return
  `{ ok: true, verified: true, client: <checksumed recovered address>, amount, asset, network, payTo, expiresAt }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 319-329)*

### Settle — Flujo on-chain

- **AC-9**: WHEN `_settleRaw` is called with valid SettleParams, the system SHALL
  call `publicClient.simulateContract` with `FIAT_TOKEN_ABI.transferWithAuthorization`,
  then `walletClient.writeContract(sim.request)`, then
  `publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })`,
  and return `{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to, asset }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 435-516)*

- **AC-10**: WHEN `publicClient.simulateContract` throws for any reason, the system
  SHALL return `{ ok: false, error: { code: 'SIMULATION_FAILED', message: <sanitized max 200 chars>, http: 500 } }`
  and SHALL NOT call `walletClient.writeContract`.
  *(evidencia: `src/chains/avalanche.ts` líneas 454-463)*

- **AC-11**: WHEN `walletClient.writeContract` throws after a successful simulation,
  the system SHALL return
  `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: <sanitized>, http: 500 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 466-472)*

- **AC-12**: WHEN `waitForTransactionReceipt` throws a `WaitForTransactionReceiptTimeoutError`,
  the system SHALL return
  `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'receipt timeout', http: 500 } }`
  using the exact literal string `'receipt timeout'`.
  *(evidencia: `src/chains/avalanche.ts` líneas 482-489)*

- **AC-13**: WHEN `receipt.status === 'reverted'`, the system SHALL return
  `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'transaction reverted on-chain', http: 500 } }`.
  *(evidencia: `src/chains/avalanche.ts` líneas 493-500)*

### Opt-in y Circuit Breaker

- **AC-14**: WHEN the service starts and `AVALANCHE_FUJI_RPC_URL` is not set or is
  empty, the module-level IIFE SHALL catch the `ChainAdapterInitError` and export
  `avalancheFujiAdapter` as `null`, without crashing the service.
  *(evidencia: `src/chains/avalanche.ts` líneas 522-528)*

- **AC-15**: WHILE the `AvalancheFujiAdapter` circuit breaker is in OPEN state, the
  system SHALL return `{ ok: false, error: { code: 'CHAIN_UNAVAILABLE', http: 503, retryAfterMs: <remaining_ms> } }`
  from both `verify()` and `settle()` public methods WITHOUT invoking `_verifyRaw`
  or `_settleRaw`.
  *(evidencia: `src/chains/avalanche.ts` líneas 162-191 y 334-363)*

- **AC-16**: WHEN `_settleRaw` returns `SIMULATION_FAILED` or `TRANSACTION_FAILED`,
  the system SHALL count exactly one breaker failure via the `BusinessFailureError`
  throw pattern (AR-BLQ-ALTO-1 fix from WFAC-41), preserving clean 1:1 accounting.
  *(evidencia: `src/chains/avalanche.ts` líneas 337-344)*

---

## Scope IN

| Artefacto | Acción |
|-----------|--------|
| `src/chains/avalanche.ts` | Reemplazar `_verifyRaw` y `_settleRaw` stubs con implementaciones reales; inyectar `getOperatorAccount()` en constructor del `WalletClient`; definir `USDC_FUJI` como constante de módulo; mantener el wrap del circuit breaker sin cambios |
| `src/__tests__/unit/chain-adapter.test.ts` | Reemplazar 2 tests de stub por 4 tests de comportamiento real contra el adapter de Avalanche Fuji: `verify rejects mismatched network`, `settle rejects expired authorization`, y 2 tests de metadata |

---

## Scope OUT

| Fuera de scope | Razón |
|----------------|-------|
| `src/chains/kite.ts` | Sin cambios — zero regresión esperada |
| `src/infra/wallet.ts` | Ya creado en WFAC-50 — no se modifica |
| `src/infra/env.ts` | `AVALANCHE_FUJI_RPC_URL` ya estaba registrado; no se requieren vars nuevas |
| `src/chains/abi/fiat-token.ts` | Ya existía post-WFAC-50 — no se modifica |
| Avalanche Mainnet (chainId 43114) | Riesgo mainnet — HU separada cuando Fuji esté validada |
| Tests E2E contra RPC Fuji real | CI no tiene acceso a testnet RPC; tests unitarios deterministas son suficientes para F4 |
| BullMQ retry queue integration | WFAC-42 — ya trackeado, esta HU no introduce cola |
| Balance check via `balanceOf` | `simulateContract` detecta balance insuficiente on-chain; pre-check es mejora de DX para HU separada |
| Nuevas métricas de on-chain latency | Out of scope WFAC-52; puede ser WFAC-55 |
| `USDC_FUJI_ADDRESS` como env var | Ver DT-B — address estable y pública, hardcodeada como constante de módulo |

---

## Decisiones técnicas (DT-N)

- **DT-A — Replicar patrón kite.ts sin abstracción**: Se optó por copiar el patrón
  completo de `kite.ts` en lugar de extraer una clase base abstracta o trait compartido.
  Razón: dos chain-adapters no justifican una capa de abstracción — el riesgo de drift
  por una abstracción prematura supera el beneficio del DRY. Si se agregan 3+ chains,
  se evalúa la extracción. Registrado como Tech Debt para revisión en V2.

- **DT-B — `USDC_FUJI` hardcodeada como constante de módulo (NO env var)**: La
  dirección `0x5425890298aed601595a70AB815c96711a31Bc65` es pública, estable y
  documentada en la guía oficial de Avalanche. No es un secreto ni un parámetro
  operacional. Contraste con Kite, donde `KITE_USDC_ADDRESS` es env var porque
  el testnet puede redeployar el token (DT-6 de WFAC-50). En Fuji, la address
  es la de Circle USDC canónico — no hay escenario de cambio sin migration.

- **DT-C — EIP-712 domain `{name:'USD Coin', version:'2', chainId:43113}`**: Circle
  USDC usa `version='2'` en su implementación ERC-3009 en Avalanche. Contraste
  con Kite/PYUSD que usa `version='1'`. El domain está construido inline en
  `_verifyRaw` a partir de los campos `token.eip712Name` y `token.eip712Version`
  del objeto `USDC_FUJI`, lo que mantiene el mismo patrón estructural que kite.ts.

- **DT-D — Operator account compartido vía `getOperatorAccount()`**: El mismo
  singleton de account (derivado de `OPERATOR_PRIVATE_KEY`) se usa para Kite y
  Fuji. Cada adapter crea su propio `WalletClient` con el `chain` correcto pero
  inyecta el mismo account. Razón: simplicidad operacional — una sola key para
  todos los chains. Multi-key por chain es una HU futura si se requiere separación
  de fondos de gas.

---

## Constraint Directives (CD-N)

- **CD-1**: TypeScript strict — no `any` explícito. Todo `as never` solo en call
  sites de `writeContract(sim.request as never)` donde el opaque type de viem lo
  requiere (patrón heredado de kite.ts y validado en AR de WFAC-50).

- **CD-2**: PROHIBIDO duplicar el wrap del circuit breaker. El patrón
  `BusinessFailureError` existente en el stub de `avalanche.ts` (heredado de
  WFAC-41) se mantiene sin cambios en la estructura externa. Solo se reemplaza
  el cuerpo de `_verifyRaw` y `_settleRaw`.

- **CD-3**: PROHIBIDO modificar `getOperatorAccount()` en `wallet.ts`. Es un
  singleton compartido; cualquier cambio afecta todos los chain adapters simultáneamente.

- **CD-4**: PROHIBIDO tocar `kite.ts` ni los tests de Kite. Zero regresión esperada.
  Si un cambio en avalanche.ts requiere modificar kite.ts, es señal de scope creep.

- **CD-5**: Tests E2E contra RPC real quedan OUT. Solo tests unitarios deterministas
  con `vi.fn()` mocks sobre `publicClient` y `walletClient`. Prohibido hacer calls
  reales al RPC en CI (`NODE_ENV=test`).

- **CD-6**: OBLIGATORIO que `_settleRaw` llame `simulateContract` ANTES de
  `writeContract`. Cualquier path que llame `writeContract` sin simulación previa
  es BLOQUEANTE en AR.

- **CD-7**: OBLIGATORIO que `SettleResult.transactionHash` sea el hash retornado
  directamente por `writeContract` — no reconstruido ni derivado del receipt.

---

## Missing Inputs

| Item | Tipo | Estado |
|------|------|--------|
| Verificación del DOMAIN_SEPARATOR real de Circle USDC en Fuji contra el domain construido en `_verifyRaw` | Validación on-chain | [Resuelto operacionalmente — address y version confirmados vía docs Avalanche + Circle; tests E2E pendientes para HU siguiente] |
| Decisión sobre multi-key operator (key separada por chain) | Arquitectónico | [DT-D resuelve con key compartida; revisión futura si se requiere separación] |

---

## Análisis de paralelismo

- Esta HU dependía de WFAC-50 (016) que estuviera mergeado — `wallet.ts`,
  `abi/fiat-token.ts` y el circuit breaker wrap ya debían existir en main.
  Confirmado: WFAC-50 está DONE en `_INDEX.md`.
- No bloquea otras HUs conocidas post-merge.
- WFAC-54 (tests E2E Fuji) puede avanzar en paralelo con cualquier HU de método
  (permit2, erc7710) dado que solo agrega tests de integración sobre el adapter
  ya implementado.
- WFAC-55 (métricas on-chain latency) también es independiente.
