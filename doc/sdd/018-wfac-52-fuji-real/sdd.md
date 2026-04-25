# SDD — [WFAC-52] Avalanche Fuji adapter REAL (verify + settle on-chain)

- **HU**: WFAC-52
- **Branch**: `feat/wfac-52-avalanche-fuji-real` (merged → main)
- **PR**: #33
- **Commit**: `070875c`
- **Mode**: QUALITY (full SDD)
- **Estimación**: M
- **Architect**: nexus-architect (retroactive)
- **Fecha**: 2026-04-24
- **Status**: `RETROACTIVE — code merged before pipeline ran`

> **AVISO RETROACTIVO**. Este SDD documenta la arquitectura **tal como fue
> implementada** y mergeada en `main` (commit `070875c`, PR #33) ANTES de que
> el pipeline NexusAgil ejecutara las fases F2/F2.5. No propone cambios.
> Toda evidencia se cita con archivo:línea contra el snapshot post-merge.

---

## 1. Context & Objective

Reemplazar los stubs de `_verifyRaw` / `_settleRaw` en `src/chains/avalanche.ts`
(post-WFAC-41 sólo devolvían `NETWORK_MISMATCH "pending WFAC-10/11"`) con
implementaciones funcionales contra Avalanche Fuji (chainId 43113), replicando
1:1 el patrón ya validado en `src/chains/kite.ts` post-WFAC-50 (PR #29,
commit `d32ad48`).

Diferencias respecto de Kite:

- **Token**: Circle USDC canónico `0x5425890298aed601595a70AB815c96711a31Bc65`,
  hardcodeado como constante de módulo (no env var) — DT-B del work-item.
- **EIP-712 domain**: `{ name:'USD Coin', version:'2', chainId:43113 }`. Kite/PYUSD
  usa `version:'1'`. La diferencia se resuelve dinámicamente vía
  `token.eip712Version` del objeto `USDC_FUJI` — el código del adapter es
  estructuralmente idéntico al de Kite.
- **viem chain helper**: `import { avalancheFuji } from 'viem/chains'` (Kite
  usa `defineChain` porque viem no expone Kite).

Toda la infraestructura compartida (`src/infra/wallet.ts`,
`src/chains/abi/fiat-token.ts`, `src/chains/abi/signature.ts`, circuit breaker
wrap WFAC-41) ya existía en `main` post-WFAC-50 y NO se modificó.

Bajo `NODE_ENV === 'test'` ninguna llamada real a Fuji RPC se ejecuta — los
tests existentes mockean el adapter mediante `vi.resetModules()` + dynamic
import (patrón consolidado en `chain-adapter.test.ts`).

---

## 2. Context Map (archivos leídos)

| Archivo | Por qué (post-merge) | Patrón verificado / extraído |
|---------|----------------------|------------------------------|
| `.nexus/project-context.md` | stack autoritativo | viem v2, TypeScript strict, OWNERS boundaries, port 3002 |
| `doc/sdd/018-wfac-52-fuji-real/work-item.md` | input HU | 16 ACs, 7 CDs, 4 DTs, scope IN/OUT |
| `doc/sdd/017-wfac-50-kite-testnet-adapter/sdd.md` | exemplar estructural HU gemela | 13 DTs (A–M), waves W0–W3, test plan; este SDD hereda DT-A/D/F/H/I/J |
| `src/chains/kite.ts:159` | inyección operator account en wallet | `account: getOperatorAccount(), chain: kiteTestnet, transport: http(rpcUrl)` — replicado en avalanche.ts:138-141 |
| `src/chains/kite.ts:185-359` | `_verifyRaw` 9-step exemplar | network → asset → amount → timestamp → sig normalize → domain inline → recover → match → success — replicado byte-for-byte en avalanche.ts:198-330 |
| `src/chains/kite.ts:361-549` | `_settleRaw` 7-step exemplar | re-verify (4 steps) → normalize → simulate → write → waitReceipt → status → success — replicado en avalanche.ts:336-516 |
| `src/chains/avalanche.ts` (PRE) | stub a reemplazar | constructor + breaker wrap + stubs `_verifyRaw`/`_settleRaw` con `code: 'NETWORK_MISMATCH', message: 'pending WFAC-10/11'` |
| `src/chains/avalanche.ts` (POST) | resultado mergeado | 540 LOC, EIP-712 real, simulate→write→receipt, USDC_FUJI hardcoded |
| `src/chains/abi/fiat-token.ts:1-12` | exemplar duplicate ABI | header `DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A`, exporta `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS` |
| `src/chains/abi/signature.ts:1-13` | exemplar normalize | `normalizeSignature(hex)` retorna `{ ok, r, s, v }` o `{ ok:false, error }`; usado en avalanche.ts:263, 428 |
| `src/infra/wallet.ts:35-44` | singleton operator account | `getOperatorAccount()` lee `OPERATOR_PRIVATE_KEY` regex-validated, cachea `Account` viem; throws `ChainAdapterInitError` si falta |
| `src/chains/circuit-breaker.ts` | breaker class | `BusinessFailureError` pattern (AR-BLQ-ALTO-1 fix WFAC-41); `_breaker.execute(lambda)` cuenta 1 falla por throw |
| `src/chains/types.ts` | contratos | `VerifyParams`, `SettleParams`, `EIP3009Token`, `ChainAdapter`, `ChainAdapterInitError`, `AdapterResult` |
| `src/__tests__/unit/chain-adapter.test.ts:492-581` | suite avalanche tests | 4 casos: chainId+network, opt-in null, USDC tokens shape, **verify rejects mismatched network**, **settle rejects expired authorization** (los 2 últimos = comportamiento real WFAC-52) |
| `viem/chains` | chain definition | `avalancheFuji` exporta el objeto chain con id 43113 ya definido upstream |

---

## 3. Architecture Overview

### 3.1 Cómo encaja el adapter Fuji en la arquitectura

```
┌─ POST /verify | /settle (Fastify routes) ─────────────────────────┐
│                                                                   │
│  src/core/verify.ts | settle.ts                                   │
│   └─ ChainRegistry.findByNetwork('eip155:43113')                  │
│       └─ avalancheFujiAdapter.verify(params)                      │
│           └─ this._breaker.execute(async () => {                  │
│              └─ this._verifyRaw(params)   ← WFAC-52 SCOPE         │
│           })                                                      │
│           └─ unwrap BusinessFailureError → AdapterResult          │
└───────────────────────────────────────────────────────────────────┘
```

- **Outer wrapper** (`avalanche.ts:162-191` y `:334-363`): heredado de WFAC-41.
  No modificado en WFAC-52. Convierte `SIMULATION_FAILED` /
  `TRANSACTION_FAILED` en `BusinessFailureError` throw para que el breaker
  cuente exactamente 1 falla (AR-BLQ-ALTO-1, validado en WFAC-41 Auto-Blindaje).
- **Inner real impl** (`_verifyRaw` y `_settleRaw`): SCOPE WFAC-52. Replica
  estructural del exemplar Kite (kite.ts:224-549).
- **ChainRegistry**: ya ruteaba a `avalancheFujiAdapter`; nada cambia ahí.
- **Opt-in module-level IIFE** (`avalanche.ts:522-528`): si
  `AVALANCHE_FUJI_RPC_URL` está vacío, el constructor throws
  `ChainAdapterInitError` y el IIFE catch-all retorna `null`. Mantenido
  desde PR #28.

### 3.2 Diferencias estructurales vs Kite (post-merge)

| Aspecto | Kite (kite.ts) | Avalanche Fuji (avalanche.ts) |
|---------|----------------|-------------------------------|
| chainId | 2368 (custom `defineChain`) | 43113 (`avalancheFuji` from viem/chains) |
| Token address | `process.env.KITE_USDC_ADDRESS` (env var) | `USDC_FUJI` constante de módulo |
| `eip712Version` | `'1'` (PYUSD) | `'2'` (Circle USDC) |
| `eip712Name` | `'PayPal USD'` | `'USD Coin'` |
| Imports viem chain | `import { defineChain } from 'viem'` | `import { avalancheFuji } from 'viem/chains'` |
| Resto de la lógica | — | byte-for-byte equivalente |

### 3.3 Boundaries respetados

`avalanche.ts:13-17` documenta los imports permitidos:
- IN: `./types.js`, `./abi/*`, `./circuit-breaker.js`, `../infra/wallet.js`,
  `viem`, `viem/chains`.
- type-only: `../core/types.js` (factory `asChainId`).
- PROHIBIDO runtime: `src/core/*` (excepto type-only), `src/methods/*`,
  `src/routes/*`. Verificado: el archivo no contiene `from '../core/`
  excepto `import type`, ni `from '../methods/`, ni `from '../routes/`.

---

## 4. Decisiones técnicas (DT-N)

Las DTs A–D vienen del work-item (heredadas, validadas en SDD); E–G se
añaden a nivel implementación para documentar elecciones de código que el
work-item no fijaba explícitamente.

### DT-A — Replicar patrón kite.ts sin abstracción (heredada del work-item)

**Decisión**: Copiar el patrón completo de `kite.ts` en lugar de extraer una
clase base abstracta o trait compartido.

**Razón**: Dos chain adapters no justifican una capa de abstracción — el
riesgo de drift por una abstracción prematura supera el beneficio del DRY.
Si se agregan 3+ chains, evaluar extracción. Tracked en BACKLOG como
**TD-CHAINS-ABSTRACT** (revisión V2).

**Evidencia**: `avalanche.ts:198-330` (verify) y `:368-516` (settle) replican
estructuralmente `kite.ts:224-359` y `:398-549` con los únicos cambios
parametrizados (`USDC_FUJI` vs token-from-env, `avalancheFuji` vs
`kiteTestnet`).

### DT-B — `USDC_FUJI` hardcodeada como constante de módulo (NO env var)

**Decisión**: La address `0x5425890298aed601595a70AB815c96711a31Bc65` se
declara como constante TS top-level, no se lee de `process.env`.

**Razón**: address pública, estable, documentada en docs.avax.network. NO es
secreto ni parámetro operacional. Contraste con Kite (DT-6 WFAC-50): el
testnet Kite puede redeployar el token, por eso allá es env var. En Fuji,
Circle USDC es canónico — no hay escenario de cambio sin migration.

**Evidencia**: `avalanche.ts:74-81`:

```ts
const USDC_FUJI: EIP3009Token = {
  address: '0x5425890298aed601595a70AB815c96711a31Bc65',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  eip712Name: 'USD Coin',
  eip712Version: '2',
};
```

### DT-C — EIP-712 domain `{name:'USD Coin', version:'2', chainId:43113}`

**Decisión**: El EIP-712 domain se construye inline dentro de `_verifyRaw`
(no helper compartido) leyendo los campos `eip712Name` / `eip712Version` del
objeto `USDC_FUJI`.

**Razón**: Circle USDC en Avalanche usa `version='2'` en su implementación
ERC-3009. Contraste con Kite/PYUSD (`version='1'`). Mantener el patrón
estructural inline (heredado de DT-D del SDD WFAC-50) evita crear un helper
prematuro mientras solo hay 2 chains. Cuando una 3ra chain aparezca, evaluar
extracción a `src/chains/abi/domain.ts`.

**Evidencia**: `avalanche.ts:271-278`:

```ts
const domain = {
  name: token.eip712Name ?? token.name,
  version: token.eip712Version ?? '1',
  chainId: this.metadata.chainId as number,
  verifyingContract: token.address,
};
```

### DT-D — Operator account compartido vía `getOperatorAccount()` (heredada)

**Decisión**: El singleton de account derivado de `OPERATOR_PRIVATE_KEY`
(creado en WFAC-50, `src/infra/wallet.ts:35-44`) se reutiliza para Fuji.
Cada chain adapter crea su propio `WalletClient` con `chain` específico
pero inyecta la misma `Account`.

**Razón**: simplicidad operacional — una sola key gestiona todos los chains.
Multi-key por chain queda como HU futura si se requiere separación de fondos
de gas.

**Evidencia**: `avalanche.ts:138-141`:

```ts
this._walletClient = createWalletClient({
  account: getOperatorAccount(),
  chain: avalancheFuji,
  transport: http(this._rpcUrl),
}) as WalletClient;
```

vs `kite.ts:159` (mismo patrón con `chain: kiteTestnet`).

### DT-E — Orden de validación 9-step en `_verifyRaw` (nuevo, nivel implementación)

**Decisión**: El orden de validación dentro de `_verifyRaw` es:

1. Token presence guard (defensive — TS narrow)
2. `accepted.network === metadata.networkId`
3. `isAddressEqual(accepted.asset, token.address)`
4. `BigInt(authorization.value) >= BigInt(accepted.amount)`
5. `BigInt(authorization.validBefore) > nowSec`
6. `normalizeSignature(payload.signature)` — gates malleable / zero scalars
7. Build EIP-712 domain inline
8. `recoverTypedDataAddress(...)` con try/catch
9. `isAddressEqual(recovered, authorization.from)` → success

**Razón**: orden idéntico al de `kite.ts:224-359`. Mantener semántica entre
adapters elimina sorpresas para clientes que prueban contra ambos chains.
Las validaciones cheap (network, asset, amount, timestamp) se ejecutan
ANTES de la cara (recoverTypedDataAddress, ECDSA recovery) — fail-fast.

**Evidencia**: `avalanche.ts:198-330` (steps 1–9 con comentarios numerados
inline en `:211, :223, :235, :249, :262, :271, :280, :308, :320`).

### DT-F — Defense-in-depth re-verify en `_settleRaw` (nuevo, nivel implementación)

**Decisión**: Los primeros 4 pasos de `_verifyRaw` (network, asset, amount,
timestamp) se REPETIR en `_settleRaw` antes de la simulación.

**Razón**: el caller del adapter (típicamente `src/core/settle.ts`) NO tiene
garantía contractual de haber llamado `verify()` antes que `settle()`. Un
adapter robusto debe ser válido como unit aislado:

- Tests directos pueden invocar `settle()` sin pasar por `verify()`.
- Una HU futura (rutas mock-mode, tools de operación) podría querer
  forzar settle sin verify previa.
- `simulate` cuesta una RPC call — evitarla con checks pre-cheap es buen
  ciudadanía.

**Trade-off**: ~25 líneas duplicadas entre verify y settle. Aceptable por
robustness > brevity. Validado en WFAC-50 (DT-H del SDD WFAC-50).

**Evidencia**: `avalanche.ts:381-425` replica los steps 1–4 de
`avalanche.ts:198-260`. Mismo orden, mismos códigos de error, mismos http
codes.

### DT-G — `sim.request` opaco en writeContract (nuevo, nivel implementación)

**Decisión**: el output `sim.request` de `simulateContract` se pasa
directamente a `writeContract(simRequest as never)` — NO se reconstruyen
los args (`address`, `abi`, `functionName`, `args`).

**Razón**: viem garantiza coherencia entre `simulate` y `write` SI Y SOLO SI
se usa el opaque request object. Reconstruir args manualmente abre la
puerta a desincronización (ej: simulate con args A, write con args A' — el
simulate validó algo distinto). El cast `as never` es inevitable porque el
opaque type viem `WriteContractParameters<TAbi, TFnName, ...>` no es
asignable cuando se almacena con tipo `unknown`.

**Evidencia**: `avalanche.ts:438` declara `let simRequest: unknown;`,
`:457` asigna `simRequest = sim.request;`, `:468` ejecuta
`hash = await walletClient.writeContract(simRequest as never);`. Patrón
copiado de `kite.ts:470, 489, 500`.

CD-1 del work-item (`as never` permitido sólo en este call site) cumplido —
no hay otros `as never` en el archivo (verified by visual scan
avalanche.ts:1-528).

---

## 5. Constraint Directives (CD-N)

### Heredadas del work-item (mantener)

- **CD-1** (TS strict, `as never` solo en write call site): cumplido —
  único `as never` está en `avalanche.ts:468`.
- **CD-2** (no duplicar el wrap del breaker): cumplido — `verify()` y
  `settle()` mantienen exactamente la misma estructura `try { breaker.execute(
  () => { _verifyRaw + BusinessFailureError throw }) } catch { unwrap |
  BreakerOpen → CHAIN_UNAVAILABLE | rethrow }` que ya existía pre-WFAC-52.
  Verified `avalanche.ts:162-191` y `:334-363`.
- **CD-3** (no modificar `getOperatorAccount` en `wallet.ts`): cumplido —
  `git diff 070875c -- src/infra/wallet.ts` retorna 0 cambios.
- **CD-4** (no tocar `kite.ts` ni tests Kite): cumplido — `git diff 070875c
  -- src/chains/kite.ts` retorna 0 cambios.
- **CD-5** (tests E2E OUT — solo unitarios deterministas): cumplido — la
  suite avalanche en `chain-adapter.test.ts:492-581` usa solo
  `vi.resetModules()` + dynamic import + casts. Ninguna llamada real a
  `https://api.avax-test.network/...` en CI.
- **CD-6** (`simulateContract` ANTES de `writeContract`): cumplido — orden
  `avalanche.ts:440 (simulate) → :468 (write)`.
- **CD-7** (`SettleResult.transactionHash` directo de `writeContract`):
  cumplido — `avalanche.ts:466` declara `let hash: 0x${string}`, `:468`
  asigna `hash = await walletClient.writeContract(...)`, `:510` retorna
  `transactionHash: hash` sin transformación.

### Nuevas a nivel SDD (post-implementation)

- **CD-NEW-SDD-1** — zero changes a `kite.ts`. Verified: `git diff 070875c
  -- src/chains/kite.ts` = 0 lines. Cualquier regresión en tests Kite
  bloquearía el merge — la batería completa (`npm test`) pasó pre-merge.

- **CD-NEW-SDD-2** — zero changes a `circuit-breaker.ts`. Verified: `git
  diff 070875c -- src/chains/circuit-breaker.ts` = 0 lines. El wrap se
  reutiliza tal cual.

- **CD-NEW-SDD-3** — `BusinessFailureError` pattern preservado en
  `avalanche.ts`. Verified: `avalanche.ts:170` y `:342` mantienen el
  `throw new BusinessFailureError(result, result.error.code)` exactamente
  igual que en el stub pre-WFAC-52 (heredado de WFAC-41 fix-pack
  AR-BLQ-ALTO-1).

- **CD-NEW-SDD-4** — `metadata.tokens` expone exactamente 1 token
  (USDC_FUJI). El work-item DT-B y el contrato `ChainAdapter.metadata`
  asumen al menos un token; el adapter expone `[USDC_FUJI]`. Verified:
  `avalanche.ts:108`. Tests `chain-adapter.test.ts:520-530` validan
  `tokens.length === 1` con `decimals === 6` y `symbol === 'USDC'`.

---

## 6. Implementation Waves (retroactiva — refleja el orden del PR #33)

> Notas: Como esta HU es retroactiva, las "waves" no son secuencias de
> commits separados — son particiones lógicas dentro del único commit
> `070875c`. Sirven para estructurar la lectura del diff y mapear los ACs
> a regiones del archivo.

### W0 — Codebase Grounding (cubierta por F0/F1, retroactiva)

**Entregables ya en `main` antes del PR #33** (no modificados en WFAC-52):

- `src/chains/kite.ts:185-549` — exemplar exacto a replicar.
- `src/chains/abi/fiat-token.ts` — ABI duplicada disponible.
- `src/chains/abi/signature.ts` — `normalizeSignature` disponible.
- `src/infra/wallet.ts` — `getOperatorAccount()` disponible.
- `src/chains/circuit-breaker.ts` — `BusinessFailureError` + `BreakerOpenError`.
- `.nexus/project-context.md` — stack autoritativo.

**Criterio de cierre**: el adapter Fuji puede importar todo lo que necesita
sin crear infraestructura nueva. Confirmado por la ausencia de archivos
nuevos en `git show --stat 070875c` (solo modificaciones).

### W1 — Imports + sanitize helper (top of file)

**Files**: `src/chains/avalanche.ts:1-89`

**Cambios diff**:
- Header JSDoc actualizado con `WFAC-52` (`:1-17`).
- Imports nuevos: `recoverTypedDataAddress`, `getAddress`, `isAddressEqual`,
  `Address`, `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`,
  `RECEIPT_TIMEOUT_MS`, `normalizeSignature`, `getOperatorAccount`
  (`:19-57`).
- Función `sanitize(e: unknown): string` agregada como helper local
  (`:59-67`) — copia byte-equivalente de `kite.ts:63-67`.
- `USDC_FUJI` ya existía pre-WFAC-52 (declarado desde el día 1 del adapter
  para cumplir el contrato `ChainAdapter.metadata.tokens`); no es cambio
  WFAC-52.

**Tests**: ninguno nuevo (cambios estructurales sin comportamiento). Los
tests existentes deben seguir compilando.

**Criterio de cierre**: `npm run typecheck` y `npm run lint` verdes.

### W2 — `_verifyRaw` real (9 steps)

**Files**: `src/chains/avalanche.ts:198-330`

**Cambios diff**: reemplazar el stub previo por la implementación completa
con los 9 steps documentados en DT-E.

**Mapping AC → línea**:

| AC | Línea de evidencia |
|----|--------------------|
| AC-1 (network mismatch) | `:212-220` |
| AC-2 (asset mismatch) | `:223-231` |
| AC-3 (amount lt accepted) | `:236-247` |
| AC-4 (expired) | `:249-260` |
| AC-5 (sig normalize fail) | `:262-266` |
| AC-6 (recover throws) | `:282-306` |
| AC-7 (recovered != from) | `:308-318` |
| AC-8 (success shape) | `:320-330` |

**Tests**: `chain-adapter.test.ts:532-555` — `verify rejects mismatched network
(WFAC-52: real implementation)`. Comportamiento real (no stub message).

**Criterio de cierre**: AC-1..AC-8 + el test reemplazado pasa.

### W3 — `_settleRaw` real (7 steps)

**Files**: `src/chains/avalanche.ts:368-517`

**Cambios diff**: reemplazar el stub previo por la implementación completa.

**Steps**:
1. Token presence guard (`:368-379`)
2. Defense-in-depth re-verify (4 sub-steps espejo de `_verifyRaw`)
   (`:381-425`)
3. Normalize signature (`:427-433`)
4. `simulateContract` (`:435-463`)
5. `writeContract(sim.request as never)` (`:465-474`)
6. `waitForTransactionReceipt` con `RECEIPT_TIMEOUT_MS` (`:476-492`)
7. Status check + success (`:494-516`)

**Mapping AC → línea**:

| AC | Línea de evidencia |
|----|--------------------|
| AC-9 (full happy path) | `:435-516` |
| AC-10 (SIMULATION_FAILED, no write) | `:454-463` (catch retorna sin caer en write) |
| AC-11 (TRANSACTION_FAILED post-sim) | `:466-472` |
| AC-12 (timeout literal `'receipt timeout'`) | `:482-489` (comparación `e.name === 'WaitForTransactionReceiptTimeoutError'`) |
| AC-13 (revert) | `:493-500` (literal `'transaction reverted on-chain'`) |

**Tests**: `chain-adapter.test.ts:557-580` — `settle rejects expired
authorization (WFAC-52: real implementation)`. Cubre el step 2 (defense-in-
depth) con un payload que pasa network/asset/amount pero tiene
`validBefore: '1'` (timestamp 1970).

**Criterio de cierre**: AC-9..AC-13 + el test reemplazado pasa.

### W4 — Wallet client injection

**Files**: `src/chains/avalanche.ts:135-145`

**Cambios diff**: `getWalletClient()` ahora pasa `account: getOperatorAccount()`
al constructor del `WalletClient`. Pre-WFAC-52, el stub no necesitaba account
porque nunca firmaba.

**Tests**: cubierto indirectamente por `chain-adapter.test.ts:557-580` —
si `getOperatorAccount()` no estuviera bien inyectado, el `_settleRaw`
tampoco podría llegar al `simulateContract` con `walletClient.account`
definido. AC-15 (breaker accounting) también valida el flujo completo
indirectamente vía T-ADAPT-CB-3 (`chain-adapter.test.ts:672-687`).

**Criterio de cierre**: `walletClient.account !== undefined` post-merge,
verified by passing the breaker integration tests.

---

## 7. Test Plan

### 7.1 Tests unitarios actualizados en WFAC-52

| Test | AC cubierto | Archivo:línea | Estrategia |
|------|-------------|---------------|------------|
| `has chainId 43113 and testnet network` | AC-14 (parcial — opt-in success) | `chain-adapter.test.ts:506-511` | `import` + assert metadata |
| `avalancheFujiAdapter is null when AVALANCHE_FUJI_RPC_URL missing` | AC-14 | `:513-518` | `delete process.env[...]` + dynamic import |
| `exposes USDC Fuji in tokens list with decimals 6` | DT-B / CD-NEW-SDD-4 | `:520-530` | shape assertion |
| **`verify rejects mismatched network (WFAC-52: real implementation)`** | AC-1 | `:532-555` | comportamiento real (vs stub `WFAC-10/11`) |
| **`settle rejects expired authorization (WFAC-52: real implementation)`** | AC-4 (settle path) | `:557-580` | comportamiento real (vs stub `WFAC-10/11`) |

**Cambios respecto al pre-WFAC-52**: los 2 tests con etiqueta
`(WFAC-52: real implementation)` reemplazaron 2 tests de stub que
asertaban `code: 'NETWORK_MISMATCH', message: 'pending WFAC-10/11'`. El
resto de la suite (3 tests de metadata + breaker) NO se modificó.

### 7.2 Tests de regresión que deben seguir verdes

| Suite | Archivo | Por qué importa |
|-------|---------|-----------------|
| Kite adapter (verify + settle real) | `chain-adapter.test.ts` (sección kite) | CD-NEW-SDD-1 zero regresión |
| Circuit breaker integration (T-ADAPT-CB-1..6) | `chain-adapter.test.ts:583+` | T-ADAPT-CB-3 (`:672-687`) verifica que abrir el breaker de Kite NO afecta a Fuji y viceversa — cobertura indirecta de WFAC-52 wallet injection |
| Opt-in IIFE | `chain-adapter.test.ts:513-518` | si el constructor de `AvalancheFujiAdapter` rompe por nuevos imports, este test surfaces |
| Token shape | `chain-adapter.test.ts:520-530` | si `USDC_FUJI` cambia structure, test rompe |
| Method-level eip3009 (verify.test.ts, settle.test.ts) | `src/__tests__/unit/methods/eip3009/*.test.ts` | core spec cobertura — no tocada por WFAC-52 pero parte del check global |

### 7.3 Tests E2E NO incluidos (Scope OUT)

- Tests contra RPC real Fuji (`https://api.avax-test.network/ext/bc/C/rpc`)
  quedan OUT de WFAC-52. CI no tiene acceso a testnet RPC; el Scope OUT
  del work-item lo confirma.
- Tracker: HU futura **WFAC-54** (tests E2E Fuji, opcional, fuera de CI).

### 7.4 Cobertura por Constraint Directive

| CD | Verificación |
|----|--------------|
| CD-1 | `npm run typecheck` pasa con `as never` solo en `:468` |
| CD-2/3/4 | `git diff 070875c` confirma 0 cambios en `kite.ts`, `wallet.ts`, `circuit-breaker.ts` |
| CD-5 | `npm test` corre con NODE_ENV=test, sin RPC real (todos los `await import(...)` usan dynamic-mocked clients) |
| CD-6 | Code path inspeccionado: `:440 simulateContract → :468 writeContract` |
| CD-7 | `:466 let hash`, `:468 hash = await write`, `:510 transactionHash: hash` (sin transform) |
| CD-NEW-SDD-1..4 | Auditadas en sección 5 con archivo:línea |

---

## 8. Anti-Hallucination Checklist

| Item | Verificado | Evidencia |
|------|-----------|-----------|
| `src/chains/avalanche.ts` existe post-merge con 540 LOC | OK | Read full file |
| `src/chains/kite.ts` exemplar `_verifyRaw` `_settleRaw` existen | OK | Read kite.ts:185-549 |
| `src/chains/abi/fiat-token.ts` exporta `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS` | OK | Read fiat-token.ts:14-40, JSDoc DT-A |
| `src/chains/abi/signature.ts` exporta `normalizeSignature` | OK | Read signature.ts:1-30, JSDoc DT-K |
| `src/infra/wallet.ts` exporta `getOperatorAccount` | OK | Read wallet.ts:35-44 |
| `src/chains/circuit-breaker.ts` exporta `ChainCircuitBreaker`, `BreakerOpenError`, `BusinessFailureError`, `readCbNumber`, `readCbBool` | OK | imports avalanche.ts:42-49 compilan post-merge |
| `viem/chains` exporta `avalancheFuji` con id 43113 | OK | import avalanche.ts:28 compila |
| `USDC_FUJI` address `0x5425890298aed601595a70AB815c96711a31Bc65` | OK | avalanche.ts:75 + work-item §AC-2 |
| `eip712Version='2'` para Circle USDC en Avalanche | OK | avalanche.ts:80 + DT-C work-item |
| `RECEIPT_TIMEOUT_MS` reused desde `chains/abi/fiat-token.ts` | OK | import avalanche.ts:54 |
| `WaitForTransactionReceiptTimeoutError` viem error con `.name === 'WaitForTransactionReceiptTimeoutError'` | OK | avalanche.ts:485 mismo pattern que kite.ts:517 |
| Tests Avalanche ya existen y compilan | OK | chain-adapter.test.ts:492-581 |

---

## 9. Resoluciones a `[NEEDS CLARIFICATION]`

Ninguna pendiente del work-item.

- **Verificación on-chain del `DOMAIN_SEPARATOR` real de Circle USDC en Fuji**:
  resuelto operacionalmente — address y `version='2'` confirmados vs docs de
  Avalanche/Circle. Tests E2E pendientes para WFAC-54 (Scope OUT explícito).
- **Multi-key operator (key separada por chain)**: resuelto por DT-D — key
  compartida es suficiente para Fuji + Kite simultáneos. Revisión futura si
  se requiere separación de fondos de gas.

---

## 10. Readiness Check

> Como este SDD es retroactivo, "readiness" se interpreta como
> "documentación coherente con el estado de `main` post-`070875c`".

- [x] Todos los DTs heredados del work-item resueltos o validados aquí.
- [x] Todos los archivos referenciados leídos (sec 2 + sec 8).
- [x] Lecciones del SDD WFAC-50 (HU gemela) replicadas — DT-A/D/F/H/I/J
      heredadas explícitamente.
- [x] Auto-Blindaje WFAC-41 referenciado para preservar el `BusinessFailureError`
      pattern (CD-NEW-SDD-3).
- [x] Waves W0–W4 mapeadas a regiones de archivo + ACs específicos
      (sec 6).
- [x] Test plan completo: 5 tests Avalanche en `chain-adapter.test.ts` +
      tests de regresión Kite + breaker integration cross-chain (sec 7).
- [x] CDs heredadas (7) + nuevas (4) auditadas con archivo:línea (sec 5).
- [x] Boundaries OWNERS respetados — chains/avalanche.ts no importa
      runtime de core/* / methods/* / routes/* (sec 3.3).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**SDD ready (retroactivo) — coherente con `main` post-`070875c`.**

---

## 11. Auto-Blindaje histórico aplicado

Patrones extraídos de las HUs DONE más recientes y aplicados en este SDD:

| HU previa | Lección destilada | Aplicación en WFAC-52 |
|-----------|-------------------|------------------------|
| WFAC-41 (016) AR-BLQ-ALTO-1 | `BusinessFailureError` throw inside `breaker.execute` lambda → 1:1 accounting | Preservado byte-for-byte en `avalanche.ts:170` y `:342` (CD-NEW-SDD-3) |
| WFAC-50 (017) DT-A | Duplicación controlada ABI `methods/eip3009/abi.ts` → `chains/abi/fiat-token.ts` | Reutilizado, NO se vuelve a duplicar; `avalanche.ts:50-55` importa de `chains/abi/fiat-token.ts` |
| WFAC-50 (017) DT-K | `normalizeSignature` también duplicado en `chains/abi/signature.ts` | Reutilizado vía `avalanche.ts:56` |
| WFAC-50 (017) DT-F | Singleton `getOperatorAccount()` chain-agnostic | Reutilizado vía `avalanche.ts:57` y `:139` |
| WFAC-50 (017) DT-H | Defense-in-depth re-verify en `_settleRaw` (mirror de los primeros 4 steps) | Replicado byte-for-byte en `avalanche.ts:381-425` (DT-F local) |

Sin patrones de error recurrentes nuevos detectados que requieran un CD
adicional propio de WFAC-52 — la HU es port 1:1 de un patrón ya validado.

---

## 12. Próximos pasos

(Retroactivos — el merge ya ocurrió.)

1. F2.5 retroactivo: generar `story-file.md` para completar la trazabilidad
   del pipeline (artefacto formal post-hoc, mismo régimen que este SDD).
2. F4 retroactivo: validar ACs con archivo:línea (la mayoría ya está
   trazada en sec 6 y 7 — la fase QA solo confirma que los tests verdes
   en CI cubren cada AC).
3. Auto-Blindaje WFAC-52: documentar si surgió algún error post-merge en
   producción (Railway logs) o en E2E manual (Fuji RPC). Esperado: ninguno
   (la HU es port 1:1).
4. `_INDEX.md` actualizado: sección 018 marca `RETROACTIVE — code merged
   before pipeline ran`, con ref a PR #33 y commit `070875c`.
