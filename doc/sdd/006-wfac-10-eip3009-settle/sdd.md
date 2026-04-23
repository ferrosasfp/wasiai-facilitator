# SDD #006 — WFAC-10 EIP-3009 Settle Logic

> SPEC_APPROVED: pending humano
> Fecha: 2026-04-23
> Tipo: method (money-moving — on-chain transaction)
> SDD_MODE: full
> Clasificación: QUALITY (AR obligatorio — mueve fondos reales)
> Branch: `feat/006-wfac-10-eip3009-settle` (desde `main@00887c4`)
> Artefactos: `doc/sdd/006-wfac-10-eip3009-settle/`
> Jira: https://ferrosasfp.atlassian.net/browse/WFAC-10
> HU_APPROVED: sí (work-item.md revisado por humano)
> Agente: nexus-architect (F2)

---

## 1. Overview

Implementar `src/methods/eip3009/settle.ts` — la función de settlement on-chain del método
EIP-3009. Es el módulo que corre detrás de `POST /settle` (cuando exista) y es el **único
lugar** del codebase que mueve dinero real via `transferWithAuthorization`.

**Qué hace**:

1. Re-valida el payload llamando `verifyEip3009(params, token, chainId)` (AC-9). Si
   falla, propaga el error tal cual — no llega a RPC.
2. Simula la transacción con `publicClient.simulateContract` usando el ABI de
   `transferWithAuthorization`. Si revierte / falla → `SIMULATION_FAILED`.
3. Ejecuta la transacción con `walletClient.writeContract(simulationResult.request)`
   (patrón viem canónico — el `request` ya tiene args encoded + validados). Si falla →
   `TRANSACTION_FAILED`.
4. Espera el receipt con `publicClient.waitForTransactionReceipt({ hash, timeout:
   RECEIPT_TIMEOUT_MS })`. Si timeout o `status === 'reverted'` → `TRANSACTION_FAILED`.
5. Retorna `{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to,
   asset }` con los campos del request original (NO re-lee on-chain).

**Qué NO hace** (Scope OUT):

- NO maneja el `core/settle.ts` orchestrator (WFAC-21) — recibe `publicClient` y
  `walletClient` ya construidos.
- NO persiste en `facilitator_settlements` (WFAC-32).
- NO implementa idempotency cache 120s (WFAC-21).
- NO normaliza EIP-2098 compact signatures (WFAC-13).
- NO implementa retry / BullMQ queue (WFAC-42).
- NO chequea balance antes del simulate — el propio `simulateContract` revierte si no
  hay saldo (DT-F del work-item).
- NO modifica `src/chains/kite.ts` — el adapter wiring queda para WFAC-21.

**Entrega**:

1. `src/methods/eip3009/abi.ts` — EXTENDER con `FIAT_TOKEN_ABI` (fragmento
   `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`).
2. `src/methods/eip3009/settle.ts` (NEW) — función principal.
3. `src/methods/eip3009/index.ts` — EXTENDER exports (`settleEip3009`, `FIAT_TOKEN_ABI`,
   `RECEIPT_TIMEOUT_MS`).
4. `src/__tests__/unit/methods/eip3009/settle.test.ts` (NEW) — ≥14 tests (uno por AC).

**Resultado esperado**: `npm run qa` verde, `npm run build` verde, 14 ACs con tests que
aseguran `error.code` y shape de resultado exitoso, cero `any`, cero `throw` por
condiciones previsibles, cero imports hacia fuera del boundary del método.

---

## 2. Architecture

### Diagrama de flujo (esta HU)

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/core/settle.ts               (NO existe — WFAC-21)              │
│    │                                                                  │
│    │ resolve chain → get publicClient + walletClient → dispatch       │
│    ▼                                                                  │
│  settleEip3009(params, token, chainId, publicClient, walletClient)    │
│    │                                                                  │
│    │  1. const v = await verifyEip3009(params, token, chainId)        │
│    │       if (!v.ok) return v as AdapterResult<SettleResult>         │
│    │       // cast ok: ambos son { ok:false, error: {...} }           │
│    │                                                                  │
│    │  2. try { const sim = await publicClient.simulateContract({      │
│    │       address: token.address,                                    │
│    │       abi: FIAT_TOKEN_ABI,                                       │
│    │       functionName: 'transferWithAuthorization',                 │
│    │       args: [from, to, value, validAfter, validBefore, nonce,    │
│    │              v, r, s],                                           │
│    │     })                                                           │
│    │     } catch (e) { return err('SIMULATION_FAILED', ...) }         │
│    │                                                                  │
│    │  3. try { hash = await walletClient.writeContract(sim.request) } │
│    │     catch (e) { return err('TRANSACTION_FAILED', ...) }          │
│    │                                                                  │
│    │  4. try { receipt = await publicClient                           │
│    │         .waitForTransactionReceipt({ hash,                       │
│    │                                      timeout: RECEIPT_TIMEOUT_MS })│
│    │     } catch (e) { return err('TRANSACTION_FAILED',               │
│    │                              'receipt timeout' | e.message) }    │
│    │                                                                  │
│    │  5. if (receipt.status === 'reverted')                           │
│    │        return err('TRANSACTION_FAILED',                          │
│    │                   'transaction reverted on-chain')               │
│    │                                                                  │
│    │  6. return {                                                     │
│    │       ok: true, settled: true,                                   │
│    │       transactionHash: hash,                                     │
│    │       blockNumber: Number(receipt.blockNumber),                  │
│    │       amount: params.accepted.amount,                            │
│    │       from: authorization.from,                                  │
│    │       to: authorization.to,                                      │
│    │       asset: token.address,                                      │
│    │     }                                                            │
│    ▼                                                                  │
│  AdapterResult<SettleResult>                                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Orden de validación (crítico — fail-fast)

El orden garantiza:

1. **Re-verify primero** (AC-9). Antes de cualquier RPC call. Si la firma o la ventana
   temporal falla, no gastamos ni una request al nodo.
2. **Simulate antes de write** (CD-2, AC-1). Simulación es `eth_call` read-only; si
   revierte (nonce usado, balance insuficiente, firma inválida para el contrato), no
   gastamos gas.
3. **Write antes de wait** (AC-3). `writeContract` usa el `request` retornado por
   `simulate` — la API canónica de viem elimina cualquier divergencia de args entre los
   dos pasos.
4. **Wait receipt con timeout hard de 60s** (CD-4, AC-5). El default de viem es 180s
   (confirmado en node_modules); nosotros lo bajamos a 60s porque los blocktimes de las
   chains soportadas son ≤2s y cualquier cosa más larga implica RPC stuck.

### Mapa del discriminated union (retorno)

| Condición | Retorno | http |
|-----------|---------|------|
| verify falla | `{ ok:false, error: <de verify> }` | preservado de verify |
| simulate throws | `{ ok:false, error: { code:'SIMULATION_FAILED', message, http:500 } }` | 500 |
| write throws | `{ ok:false, error: { code:'TRANSACTION_FAILED', message, http:500 } }` | 500 |
| waitForTxReceipt throws (timeout) | `{ ok:false, error: { code:'TRANSACTION_FAILED', message:'receipt timeout', http:500 } }` | 500 |
| receipt.status === 'reverted' | `{ ok:false, error: { code:'TRANSACTION_FAILED', message:'transaction reverted on-chain', http:500 } }` | 500 |
| receipt.status === 'success' | `{ ok:true, settled:true, transactionHash, blockNumber, amount, from, to, asset }` | — |

### Flujo de test

1. Cada test construye `mockPublicClient` y `mockWalletClient` con `vi.fn()` para
   `simulateContract`, `waitForTransactionReceipt`, `writeContract`.
2. Cada test inyecta esos mocks como parámetros — NO se usa `vi.mock('viem', ...)` a
   nivel de módulo (CD-8).
3. Las fixtures de firma se reciclan del patrón de `verify.test.ts` (privateKeyToAccount
   + signTypedData offline, Hardhat account #0).
4. Para el path happy path, mockPublicClient.simulateContract devuelve
   `{ request: <opaque object>, result: undefined }` (transferWithAuthorization retorna
   void on-chain, pero viem retorna `undefined`).
5. Cero I/O de red. Cero spawn de procesos.

---

## 3. Codebase Grounding (archivos leídos + evidencia)

### Archivos leídos en este proyecto (wasiai-facilitator)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `doc/sdd/006-wfac-10-eip3009-settle/work-item.md` | Input obligatorio | 14 ACs + 12 CDs + 6 DTs + Waves W0–W2 + 3 Missing Inputs a resolver |
| `.nexus/project-context.md` | Stack + reglas absolutas | viem v2 exclusivo; simulate antes de settle (regla #5); Result<T> discriminated union; x402 10 error codes; TS strict no-any; tests obligatorios |
| `src/chains/types.ts` (1–153) | Contratos de dominio | `SettleParams = VerifyParams` (alias); `SettleResult` con 7 campos readonly (settled:true, transactionHash: 0x${string}, blockNumber: number, amount, from, to, asset); `AdapterResult<T> = Result<T>`; `ChainAdapter.getPublicClient()/getWalletClient()` — punto de inyección |
| `src/core/types.ts` (1–66) | Primitivas | `X402ErrorCode` incluye `SIMULATION_FAILED` y `TRANSACTION_FAILED`; `Result<T> = Ok<T> \| Err`; `Ok<T> = { ok:true } & T` |
| `src/methods/eip3009/verify.ts` (1–159) | Exemplar de estilo del módulo | Patrón helper `err(code, message, http)` interno; imports named desde viem; try/catch puntual alrededor de `recoverTypedDataAddress`; retorna `AdapterResult<VerifyResult>`; NO logger; NO throw por condiciones previsibles |
| `src/methods/eip3009/abi.ts` (1–26) | Archivo a extender | Sólo tiene `EIP3009_TYPES` (typed data) y `EIP3009_PRIMARY_TYPE`. NO tiene ABI on-chain — esta HU agrega `FIAT_TOKEN_ABI` con `as const` |
| `src/methods/eip3009/index.ts` (1–11) | Barrel a extender | Re-exporta `verifyEip3009`, `EIP3009_TYPES`, etc. Agregar `settleEip3009`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS` |
| `src/methods/eip3009/schemas.ts` (1–83) | Zod shapes | `Eip3009AuthorizationSchema` valida `value/validAfter/validBefore: Uint256StringSchema`. Settle NO usa estos schemas directamente — verifyEip3009 ya los aplica en el paso 1 |
| `src/chains/kite.ts` (1–141) | Adapter exemplar (referencial) | Confirma que `getPublicClient()/getWalletClient()` crean clientes singleton. Settle.ts NO los importa — los recibe inyectados (CD-5) |
| `src/__tests__/unit/methods/eip3009/verify.test.ts` (1–200) | Exemplar de test pattern | Patrón `makeValidParams(opts)` con overrides; fixture offline con Hardhat account #0 (`0xac09...ff80`); assertions con `expect(result.ok).toBe(...)` + narrowing `if (!result.ok)` |
| `src/__tests__/unit/chain-adapter.test.ts` (linea 85) | Exemplar mock viem | Confirma que `client.writeContract` es `function` — los adapters usan viem WalletClient real; en tests mockeamos la función directamente |
| `package.json` | Deps | viem `^2.47.6` (instalado 2.48.4), zod `^3.23.8`, vitest `^2.1.8` |
| `tsconfig.json` | Module resolution | `module: Node16` → imports con `.js` extension |
| `doc/sdd/005-wfac-6-eip3009-verify/sdd.md` | Antecedente | Verify ya DONE (AR pass + F4 pass); `verifyEip3009` es dep directa de settle (AC-9) |
| `doc/sdd/005-wfac-6-eip3009-verify/auto-blindaje.md` | Lecciones | Ver sección siguiente |
| `doc/sdd/005-wfac-6-eip3009-verify/story-WFAC-6.md` | Plantilla Story File | Patrón de 10+ secciones self-contained |
| `doc/sdd/_INDEX.md` | Registry | Esta HU marcada "in progress" |

### Auto-Blindaje histórico (lecciones aprendidas aplicadas a esta HU)

Leí el único auto-blindaje existente en el repo (WFAC-6). No hay 3 HUs DONE con auto-blindaje
todavía — sólo WFAC-6 registró errores. Patrones aplicables:

| Hallazgo previo | HU | Cómo aplica a WFAC-10 | Tratamiento |
|-----------------|-----|----------------------|-------------|
| `BigInt("abc")` throw uncaught por falta de pre-validación Zod en `accepted` (BLQ-ALTO-2) | WFAC-6 | Settle llama `verifyEip3009` primero (AC-9). Si `accepted` está mal, verify lo atrapa con `AcceptedSchema` y retorna error — settle NO llega a `BigInt(...)`. Este blindaje está heredado por construcción | CD heredado: settle NO consume `params.accepted.amount` via `BigInt()` antes de verify. Los únicos BigInt que settle usa son los del authorization (ya parseados por verify) |
| Negative amount bypass (BLQ-ALTO-1) | WFAC-6 | Mismo blindaje — verify rechaza `-1` via `Uint256StringSchema` regex `/^(0\|[1-9]\d*)$/` | Cubierto por AC-9 |
| Precision loss `Number(validBefore)` (BLQ-MED-1) | WFAC-6 | En settle retornamos `blockNumber: Number(receipt.blockNumber)`. `receipt.blockNumber` es `bigint` (viem). Block numbers reales están <= 2^40 hoy; `Number()` es seguro por décadas. Documentado como informational (igual que `expiresAt` en VerifyResult) | **CD-NEW-13**: documentar en JSDoc que `blockNumber` puede perder precisión si alguna EVM futura supera 2^53-1 blocks; es TD aceptada |
| Canonical uint256 string (BLQ-BAJO-1) | WFAC-6 | `amount` en `SettleResult` viene de `params.accepted.amount` (ya parseado como canónico por verify). Preservado | Cubierto por AC-9 |
| T-H5 flake con `nowSec + 1` buffer (TD) | WFAC-6 | Settle no tiene timestamp checks propios — hereda los de verify. Si aparece flake en settle.test.ts por timestamps, usar `nowSec + 10` buffer o `vi.useFakeTimers()` | **CD-NEW-14**: en settle.test.ts, si una fixture depende de timestamp window, usar `nowSec + 3600` (una hora) para eliminar flake |

**Lecciones nuevas específicas de esta HU** (primera HU que escribe on-chain):

- **TOCTOU simulate→write**: documentar explícitamente en JSDoc que NO mitigamos el gap
  (DT-A del work-item).
- **Mock de viem v2 clients**: usar `as unknown as PublicClient` / `as unknown as
  WalletClient` — es el único `as unknown` permitido y sólo en tests (DT-D).

### Lectura obligatoria en `node_modules/` (post-cutoff — viem 2.48.4)

| Path | Verificado | Hallazgo concreto |
|------|-----------|------------------|
| `node_modules/viem/_types/actions/public/simulateContract.d.ts` | Sí | `simulateContract(client, parameters): Promise<{ result, request }>`. `request` es un objeto `Prettify<UnionEvaluate<...>>` que contiene los args encoded y es directamente consumible por `writeContract`. No throws por success; throws por revert/RPC/encoding — el catch atrapa todo vía `try/catch` (CD-1) |
| `node_modules/viem/_types/actions/wallet/writeContract.d.ts` | Sí | `writeContract(client, parameters): Promise<WriteContractReturnType>` donde `WriteContractReturnType = SendTransactionReturnType` (alias de `Hash = 0x${string}`). La doc oficial del file dice: "It is highly recommended to simulate the contract write with contract.simulate before you execute it" — refuerza CD-2 |
| `node_modules/viem/_types/actions/public/waitForTransactionReceipt.d.ts` | Sí | `waitForTransactionReceipt(client, { hash, timeout?: number \| undefined, ... }): Promise<GetTransactionReceiptReturnType<chain>>`. Default timeout es **180_000 ms** (no `undefined` como dice el work-item). Si timeout expira → throw `WaitForTransactionReceiptTimeoutError` (confirmado abajo). Retorna `TransactionReceipt` con `status: 'success' \| 'reverted'` y `blockNumber: bigint` |
| `node_modules/viem/_types/errors/transaction.d.ts` | Sí | `class WaitForTransactionReceiptTimeoutError extends BaseError`. `.name === 'WaitForTransactionReceiptTimeoutError'`. Al quedarse el timeout, lanza esta instancia — el `catch (e)` genérico la atrapa sin necesidad de `instanceof` (retornamos `TRANSACTION_FAILED` con mensaje `'receipt timeout'`) |
| `node_modules/viem/_types/errors/base.d.ts` | Sí | `class BaseError extends Error` con `.shortMessage`, `.details`, `.walk(fn?)`. Útil para extraer mensaje en catch blocks sin exponer stack traces al caller |
| `node_modules/viem/_types/errors/contract.d.ts` | Sí | `ContractFunctionRevertedError extends BaseError` — se lanza cuando el contrato revierte durante `simulateContract`. Atrapado por el mismo `catch (e)` del simulate block → retornamos `SIMULATION_FAILED` (AC-10 explícitamente dice NO mapear subcódigos) |
| `node_modules/viem/_types/types/transaction.d.ts` | Sí | `TransactionReceipt.status: 'success' \| 'reverted'`. `TransactionReceipt.blockNumber: bigint` (quantity default). `TransactionReceipt.transactionHash: Hash` |

**Verificación cross-check comportamiento timeout**: el work-item (missing input #3) pedía
validar si `waitForTransactionReceipt` lanza error o retorna `undefined` con timeout. La
lectura de `transaction.d.ts` confirma **lanza `WaitForTransactionReceiptTimeoutError`** —
nuestro `catch (e)` en el bloque de wait retorna `TRANSACTION_FAILED` con mensaje
`'receipt timeout'`. No hay path de retorno `undefined`.

### Exemplars confirmados para el Dev

| Path | Existe | Uso |
|------|--------|-----|
| `src/chains/types.ts` | Sí (153 líneas) | Import type `{ EIP3009Token, SettleParams, SettleResult, AdapterResult }`. Type-only (OWNERS) |
| `src/core/types.ts` | Sí (66 líneas) | Import type `{ Address, ChainId, X402ErrorCode }`. Type-only |
| `src/methods/eip3009/abi.ts` | Sí (26 líneas) | Extender con `FIAT_TOKEN_ABI` + `RECEIPT_TIMEOUT_MS` |
| `src/methods/eip3009/verify.ts` | Sí (159 líneas) | Importar `verifyEip3009` runtime — es el mismo módulo, import relativo `./verify.js` |
| `src/methods/eip3009/schemas.ts` | Sí (83 líneas) | NO importar directamente en settle.ts — verify ya los aplica |
| `src/methods/eip3009/index.ts` | Sí (11 líneas) | Extender exports |
| `src/__tests__/unit/methods/eip3009/verify.test.ts` | Sí (~400 líneas) | Reusar `TEST_PRIVATE_KEY`, `TEST_SIGNER_ADDRESS`, `TEST_TOKEN`, `TEST_PAY_TO`, `TEST_CHAIN_ID`, `makeValidParams()` helper (copiar patrón adaptado a settle.test.ts — NO importar entre tests) |
| `node_modules/viem/_types/actions/public/simulateContract.d.ts` | Sí | Firma verificada |
| `node_modules/viem/_types/actions/wallet/writeContract.d.ts` | Sí | Firma verificada |
| `node_modules/viem/_types/actions/public/waitForTransactionReceipt.d.ts` | Sí | Firma verificada + default timeout 180s descubierto |
| `node_modules/viem/_types/errors/transaction.d.ts` | Sí | `WaitForTransactionReceiptTimeoutError` verificado |
| `node_modules/viem/_types/utils/signature/parseSignature.d.ts` | Sí | `parseSignature(hex): { r, s, v?: bigint, yParity }` — necesario para partir la firma en `v, r, s` que pide el ABI de `transferWithAuthorization` |

---

## 4. Missing Inputs — resolución

### MI-1 — ABI de `transferWithAuthorization` para on-chain calls

**Resolución**: agregar a `src/methods/eip3009/abi.ts` la constante `FIAT_TOKEN_ABI`
exportada como array `as const`. Contiene **sólo** el fragmento de
`transferWithAuthorization` con la firma **v/r/s expandida** (no la variante de firma
compacta/bytes):

```ts
// abi.ts — append
export const FIAT_TOKEN_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;
```

**Razón**: Circle FiatTokenV2 (implementación canónica USDC/PYUSD) expone dos overloads:
(1) `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`
— la histórica. (2) `transferWithAuthorization(from, to, value, validAfter, validBefore,
nonce, signature bytes)` — la EIP-2098 compact. El work-item original (AC-11) lista una
firma con `signature: bytes`, pero esa versión requiere pre-procesamiento EIP-2098
(WFAC-13, scope OUT). Usamos la variante **v/r/s** porque:

1. Ya está en producción desde 2020 en USDC/PYUSD.
2. No requiere WFAC-13.
3. Es la que `parseSignature(signature)` de viem produce directamente.
4. Los tokens soportados por wasiai-facilitator V1 (PYUSD en Kite) implementan ambas,
   pero v/r/s es el camino más estable.

**Trade-off documentado**: si en V2 soportamos tokens que **sólo** implementen la variante
bytes (raro), agregar un segundo fragmento al ABI. Tracked como nota en el JSDoc del ABI.

**AC-11 actualizado**: el ABI matchea la variante v/r/s. Cualquier cambio de shape a futuro
se detecta en compile-time por el tipado `as const` de viem (satisfies inferencia).

### MI-2 — Client injection point (ChainAdapter)

**Resolución confirmada**: `settleEip3009` recibe `publicClient: PublicClient` y
`walletClient: WalletClient` como parámetros explícitos. El `ChainAdapter` (definido en
`src/chains/types.ts:117-123`) expone `getPublicClient()` y `getWalletClient()` — cuando
WFAC-21 implemente `core/settle.ts`, el orchestrator hará:

```ts
// WFAC-21 preview (fuera de scope — sólo para contexto)
const publicClient = adapter.getPublicClient();
const walletClient = adapter.getWalletClient();
return settleEip3009(params, token, chainId, publicClient, walletClient);
```

En esta HU (WFAC-10), `settle.ts` sólo define la función con los 5 parámetros. El wiring
al adapter queda para WFAC-21. Ver CD-5 (prohibido importar o instanciar clients viem
adentro de settle.ts).

### MI-3 — Comportamiento `waitForTransactionReceipt` con timeout en viem v2.47+

**Resolución confirmada**: `waitForTransactionReceipt({ hash, timeout: 60_000 })` **lanza
`WaitForTransactionReceiptTimeoutError`** (extends `BaseError`, extends `Error`) cuando
el timeout expira sin receipt. No hay path de retorno `undefined`.

**Implicancias para settle.ts**:

1. El bloque `try { await waitForTransactionReceipt(...) } catch (e) { ... }` atrapa el
   timeout naturalmente.
2. En el `catch`, inspeccionamos `e instanceof BaseError` **no es necesario** — todos
   los errores de este bloque (timeout, RPC drop, transaction replaced con onReplaced
   callback undefined, etc.) se mapean a `TRANSACTION_FAILED`. El mensaje del error se
   copia al `message` del `Err` (SIN stack traces — sanitización: `(e instanceof Error ?
   e.message : String(e)).slice(0, 200)`).
3. Para el test case de AC-6 (timeout), el mock lanza manualmente:
   `mockPublicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'))`.

**Nota sobre default timeout**: el work-item DT-B dice que el default de viem es
`undefined`. Tras leer el `.d.ts` actual, **el default es 180_000 ms (180s)**. No cambia
nuestro análisis — forzamos 60s con `RECEIPT_TIMEOUT_MS = 60_000` (CD-4).

---

## 5. Decisiones Técnicas (DT-N)

### DT-A — TOCTOU gap simulate→write: accept V1 (heredado del work-item)

Confirmado. El gap existe (bloques avanzan entre simulate y write). V1 no mitiga con
retry en settle.ts — si write falla, `TRANSACTION_FAILED`. El caller (WFAC-21 orchestrator
+ WFAC-42 BullMQ) hace retry con re-simulate.

**Refuerzo en código**: JSDoc explícito en settle.ts advirtiendo el gap + referencia a
WFAC-42.

### DT-B — `RECEIPT_TIMEOUT_MS = 60_000` (heredado)

Confirmado. 60s es generoso para Kite (~2s blocktime) y Avalanche (~2s). Sobra para
cualquier EVM soportada en V1. La constante vive en `abi.ts` (sección "constants") y se
re-exporta desde `index.ts`.

### DT-C — Single wait, no retry (heredado)

Confirmado. Un único `await waitForTransactionReceipt(...)`. Si falla, TRANSACTION_FAILED.

### DT-D — Mocks con `as unknown as PublicClient` (heredado)

Confirmado. Única excepción permitida a la regla no-any / no-as-unknown (CD-10). Comentado
en cada test: `// DT-D: partial mock — tests only exercise the 2 methods we call`.

### DT-E — Error code mapping (heredado del work-item)

Confirmado. Simple V1:

- simulate throws → `SIMULATION_FAILED` (http 500)
- write throws → `TRANSACTION_FAILED` (http 500)
- waitForTxReceipt throws (timeout/RPC) → `TRANSACTION_FAILED` (http 500)
- receipt.status reverted → `TRANSACTION_FAILED` (http 500)
- verify falla → propagado as-is

### DT-F — Reutilizar verify, sin SettleAcceptedSchema (heredado)

Confirmado. `settle.ts` llama `verifyEip3009` como paso 1 (AC-9). Toda la validación de
shape (Zod) y de condiciones off-chain ya corre ahí. Settle NO tiene schemas propios.

### DT-G (nueva) — ABI v/r/s, no bytes-signature

Ver MI-1 resolución. Usamos la firma histórica v/r/s. `parseSignature(params.payload.signature)`
produce `{ r, s, v }` para pasar al ABI.

**Importante**: `parseSignature` retorna un discriminated union:

```ts
| { r: Hex; s: Hex; v: bigint; yParity: number }
| { r: Hex; s: Hex; yParity: number; v?: never }
```

Si la firma es EIP-2098 compact (64 bytes), `v` puede ser `undefined` → en ese caso
retornamos `err('INVALID_SIGNATURE', 'EIP-2098 compact signatures not supported in V1 (WFAC-13)', 401)`.
Usamos un guard explícito: `if (!('v' in parsed) || parsed.v === undefined) return err(...)`.

**Refuerzo en CD**: ver CD-NEW-15 abajo.

### DT-H (nueva) — Cómo derivar v/r/s desde `payload.signature`

`params.payload.signature` es `0x${string}` de 130 chars (65 bytes). viem v2.47 provee
`parseSignature(hex)` que retorna `{ r, s, v: bigint, yParity: number }`. Convertimos `v`
a `number` (EIP-3009 espera uint8) vía `Number(parsed.v)`. Seguro porque `v ∈ {27, 28}`
(o `{0, 1}` con EIP-1559 recovery) — muy por debajo de 2^53-1.

**Alternativa descartada**: hexSlice manual (`signature.slice(2, 66)` para r,
`signature.slice(66, 130)` para s, `parseInt(signature.slice(130), 16)` para v). Es más
código y menos seguro contra futuros formatos. `parseSignature` es la fuente canónica
de viem.

### DT-I (nueva) — Ownership del JSDoc sobre TOCTOU

El JSDoc de `settleEip3009` DEBE incluir literal:

```
/**
 * ...
 * @remarks
 * TOCTOU gap: `simulateContract` succeeds at block N; `writeContract` executes at
 * block N+k. If nonce is consumed in that window (e.g. user settled elsewhere),
 * `writeContract` or the on-chain receipt will surface the failure as
 * TRANSACTION_FAILED. This function does NOT retry — the core/settle orchestrator
 * (WFAC-21) + BullMQ queue (WFAC-42) handle retries.
 */
```

Esto es CD-NEW-16.

### DT-J (nueva) — No usar `simulateContract.request` con `account: undefined`

viem v2 tipa el `request` retornado por simulate con el `account` opcional. En producción
el adapter debe proveer `account` (el operator) al crear el WalletClient; en tests lo
mockeamos vacío. `writeContract(sim.request)` falla en runtime si `account` no se resolvió
— pero eso ocurre en **integration tests** (scope WFAC-21), NO en unit tests (los mocks
retornan un stub opaco).

**Implicancia para unit tests**: el mock de `simulateContract.mockResolvedValue({ request:
{} as any, result: undefined })` es suficiente — `writeContract.mockResolvedValue('0x...')`
ignora el shape del request.

**Implicancia para código**: settle.ts NO inspecciona `sim.request` — lo pasa opaco a
`writeContract` (CD-9).

---

## 6. Constraint Directives

Los 12 CDs del work-item se heredan literal. Agrego 4 específicos de este SDD:

**CD-1** (heredado): PROHIBIDO throw por condiciones previsibles. Todo error → `{ ok:
false, error: {...} }`.

**CD-2** (heredado): OBLIGATORIO simulate antes de write.

**CD-3** (heredado): PROHIBIDO ABI hardcoded inline — usar `FIAT_TOKEN_ABI` desde
`abi.ts`.

**CD-4** (heredado): OBLIGATORIO `RECEIPT_TIMEOUT_MS` named constant. PROHIBIDO literal
`60_000` inline.

**CD-5** (heredado): OBLIGATORIO `publicClient` + `walletClient` como params inyectados.
PROHIBIDO `createPublicClient` / `createWalletClient` dentro de settle.ts.

**CD-6** (heredado): Imports permitidos SOLO: viem (+ tipos), `./verify.js`, `./abi.js`,
`../../chains/types.js` (type-only), `../../core/types.js` (type-only). PROHIBIDO core/,
chains/registry, routes/, otros methods.

**CD-7** (heredado): PROHIBIDO `console.*`. Sin logger en el módulo.

**CD-8** (heredado): PROHIBIDO `vi.mock('viem', ...)` a nivel módulo. Mock solo los
objetos inyectados con `vi.fn()`.

**CD-9** (heredado): OBLIGATORIO `writeContract(simulationResult.request)` — NO
reconstruir args.

**CD-10** (heredado): firma exacta:

```ts
export async function settleEip3009(
  params: SettleParams,
  token: EIP3009Token,
  chainId: ChainId,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<AdapterResult<SettleResult>>
```

TS strict, no `any`, no `as unknown` fuera de tests.

**CD-11** (heredado con refinamiento): el `try/catch` de `simulateContract` atrapa
**todo** error (incluyendo programmer errors). La razón: AC-14 + CD-1 prohíben throw.
Si hubiera un bug de programación (ej. `TypeError`), retornamos `SIMULATION_FAILED` con
mensaje sanitizado. **Refinamiento**: el work-item original dudaba entre atrapar todo vs
relanzar bugs de programación. Decisión final F2: **atrapar todo**. Razón: el boundary
HTTP superior (Fastify error-handler) ya captura excepciones no previsibles — que ese
path no entre en juego desde settle.ts garantiza determinismo de respuestas.

**CD-12** (heredado): OBLIGATORIO ≥1 test por cada AC (14 tests mínimo).

**CD-NEW-13** (SDD): en el JSDoc de `SettleResult.blockNumber`, documentar que el valor
es `Number(receipt.blockNumber)` y que podría perder precisión si la chain supera 2^53-1
blocks (heredado de auto-blindaje WFAC-6 BLQ-MED-1 — aceptado como TD).

**CD-NEW-14** (SDD): en `settle.test.ts`, si alguna fixture depende de ventana temporal
(validBefore), usar buffer de `nowSec + 3600` — heredado de WFAC-6 T-H5 flake.

**CD-NEW-15** (SDD): OBLIGATORIO validar shape v/r/s de la firma ANTES de pasar al ABI.
Si `parseSignature(signature).v === undefined` (EIP-2098 compact), retornar `err('INVALID_SIGNATURE',
'EIP-2098 compact signatures not supported in V1 (WFAC-13)', 401)`. Esta guardia SE
EJECUTA después de `verifyEip3009` (que no chequea formato v/r/s explícitamente) y antes
de `simulateContract`.

**CD-NEW-16** (SDD): OBLIGATORIO documentar TOCTOU gap en JSDoc de `settleEip3009` con
texto literal de DT-I.

---

## 7. Waves de implementación

### W0 — Constants + ABI (≤50 LOC nuevas)

**Archivos**:

- `src/methods/eip3009/abi.ts` (EXTEND) — agregar `FIAT_TOKEN_ABI` como array `as const`
  (solo fragmento `transferWithAuthorization` v/r/s overload) + `RECEIPT_TIMEOUT_MS = 60_000`.
- `src/methods/eip3009/index.ts` (EXTEND) — re-exportar `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS`.

**Criterio de salida**: `npm run typecheck` verde. `npm run test` verde (tests existentes
siguen pasando — el archivo abi.ts ya no rompe).

### W1 — Función settleEip3009 (~130 LOC)

**Archivos**:

- `src/methods/eip3009/settle.ts` (CREATE) — función principal.
- `src/methods/eip3009/index.ts` (EXTEND) — re-exportar `settleEip3009`.

**Implementación** (orden estricto):

1. Helper interno `err(code, message, http): AdapterResult<SettleResult>`.
2. `const v = await verifyEip3009(params, token, chainId)`; si `!v.ok`, retornar
   `{ ok: false, error: v.error }` (AC-9).
3. Parse firma con `parseSignature(params.payload.signature)` — si `v === undefined`,
   retornar `INVALID_SIGNATURE` (CD-NEW-15).
4. `try { sim = await publicClient.simulateContract({ address: token.address, abi:
   FIAT_TOKEN_ABI, functionName: 'transferWithAuthorization', args: [from, to,
   BigInt(value), BigInt(validAfter), BigInt(validBefore), nonce, Number(v), r, s] }) }
   catch (e) { return err('SIMULATION_FAILED', sanitize(e), 500) }`.
5. `try { hash = await walletClient.writeContract(sim.request) } catch (e) { return
   err('TRANSACTION_FAILED', sanitize(e), 500) }`.
6. `try { receipt = await publicClient.waitForTransactionReceipt({ hash, timeout:
   RECEIPT_TIMEOUT_MS }) } catch (e) { return err('TRANSACTION_FAILED', 'receipt timeout',
   500) }` (el mensaje 'receipt timeout' es literal por AC-6; si es otra cause, usar
   `sanitize(e)`).
7. `if (receipt.status === 'reverted') return err('TRANSACTION_FAILED', 'transaction
   reverted on-chain', 500)` (AC-7).
8. Retorno ok: `{ ok: true, settled: true, transactionHash: hash, blockNumber:
   Number(receipt.blockNumber), amount: params.accepted.amount, from:
   params.payload.authorization.from, to: params.payload.authorization.to, asset:
   token.address }` (AC-8).

**Helper `sanitize(e: unknown): string`**: `(e instanceof Error ? e.message :
String(e)).slice(0, 200)`. Retorna string seguro sin stack trace completo.

**Criterio de salida**: `npm run typecheck` verde. `npm run build` verde. Tests de
verify siguen verdes (nada se rompió).

### W2 — Tests (≥14 tests, 1+ por AC)

**Archivo**: `src/__tests__/unit/methods/eip3009/settle.test.ts` (CREATE).

**Fixtures base** (copiadas/adaptadas de `verify.test.ts`):

- `TEST_PRIVATE_KEY`, `TEST_SIGNER_ADDRESS`, `TEST_CHAIN_ID` (`asChainId(2368)`),
  `TEST_TOKEN`, `TEST_PAY_TO`.
- `makeValidParams(opts?)` helper (reutilizado).
- `makeMockClients()` helper que retorna `{ publicClient, walletClient }` con `vi.fn()`
  stubs.

**Tests (mapeo AC → test)**:

| AC | Test | Mock setup | Expected |
|----|------|------------|----------|
| AC-1 | `calls simulateContract before writeContract` | sim ok, write ok, receipt ok | `mockPublicClient.simulateContract.toHaveBeenCalledBefore(mockWalletClient.writeContract)` — use `vi.fn().mockImplementation(() => Promise.resolve({request:{}, result:undefined}))` + call order spy |
| AC-2 | `returns SIMULATION_FAILED when simulateContract throws` | `simulateContract.mockRejectedValueOnce(new Error('revert: nonce used'))` | `result.ok === false`, `error.code === 'SIMULATION_FAILED'`, `error.http === 500`; write NOT called |
| AC-3 | `passes simulate.request to writeContract without reconstruction` | simulate returns `{ request: { __opaque: true }, result: undefined }` | `mockWalletClient.writeContract.toHaveBeenCalledWith({ __opaque: true })` |
| AC-4 | `returns TRANSACTION_FAILED when writeContract throws` | sim ok, `writeContract.mockRejectedValueOnce(new Error('RPC drop'))` | `error.code === 'TRANSACTION_FAILED'`, http 500 |
| AC-5 | `calls waitForTransactionReceipt with RECEIPT_TIMEOUT_MS and hash` | sim ok, write returns '0xabc...', receipt ok | `mockPublicClient.waitForTransactionReceipt.toHaveBeenCalledWith({ hash: '0xabc...', timeout: 60_000 })` |
| AC-6 | `returns TRANSACTION_FAILED message 'receipt timeout' on timeout` | sim ok, write ok, `waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'))` | `error.code === 'TRANSACTION_FAILED'`, `error.message === 'receipt timeout'` (literal — AC-6 explícito) |
| AC-7 | `returns TRANSACTION_FAILED when receipt.status === 'reverted'` | sim ok, write ok, receipt with `status: 'reverted'` | `error.code === 'TRANSACTION_FAILED'`, `error.message === 'transaction reverted on-chain'` |
| AC-8 | `returns SettleResult with correct shape on happy path` | all ok, receipt `status: 'success', blockNumber: 123n` | `result.ok === true`, `result.settled === true`, `result.transactionHash === '0xabc...'`, `result.blockNumber === 123`, `result.amount === '1000'`, `result.from === TEST_SIGNER_ADDRESS`, `result.to === TEST_PAY_TO`, `result.asset === TEST_TOKEN.address` |
| AC-9 | `calls verifyEip3009 first and returns its error unchanged` | params con asset inválido (verify fallará con NETWORK_MISMATCH) | `error.code === 'NETWORK_MISMATCH'`, `mockPublicClient.simulateContract` NOT called |
| AC-10 | `returns SIMULATION_FAILED on ContractFunctionRevertedError-like throw` | simulate throws new Error('execution reverted: authorization is used') | `error.code === 'SIMULATION_FAILED'` (NO subcode mapping) |
| AC-11 | `ABI shape matches v/r/s overload` | static — compile-time | `expectTypeOf<typeof FIAT_TOKEN_ABI[0]['inputs']>().toMatchObjectType<...>()` OR runtime assert: `FIAT_TOKEN_ABI[0].inputs.length === 9 && inputs[6].name === 'v'` |
| AC-12 | all tests use `vi.fn()` mocks | static review — test file contains zero `http(...)` / `createPublicClient` calls | grep-style assert (optional) |
| AC-13 | test suite covers 5 paths: sim-fail / write-fail / receipt-revert / receipt-timeout / happy | covered by AC-2, AC-4, AC-7, AC-6, AC-8 | N/A — structural |
| AC-14 | no test exercises a settleEip3009 path that throws | structural: wrap each test in `expect(settleEip3009(...)).resolves.toMatchObject(...)` — NO `.rejects` | N/A — structural |

**Tests adicionales (hardening, no obligatorios por AC pero recomendados)**:

- T-H1: sim succeeds, write throws with non-Error (string) — `sanitize()` should still
  produce string message (boundary coverage).
- T-H2: EIP-2098 compact signature (64 bytes) → `INVALID_SIGNATURE` (CD-NEW-15).
- T-H3: `receipt.blockNumber === 0n` (genesis block) → `blockNumber: 0` in result
  (edge case around falsy).
- T-H4: verify fails with `EXPIRED_AUTHORIZATION` → propagated unchanged.

**Criterio de salida**: `npm run qa` verde (que corre typecheck + lint + test). Todos los
ACs con al menos un test asociado.

---

## 8. Plan de tests (resumen tabular)

| Archivo | Tests nuevos | Archivos touched | ACs cubiertos |
|---------|-------------|------------------|---------------|
| `src/__tests__/unit/methods/eip3009/settle.test.ts` | 14 (mínimo) + hasta 4 hardening | CREATE | AC-1..AC-14 |
| Existentes (`verify.test.ts`, `domain.test.ts`, `schemas.test.ts`) | 0 modified | NO TOCAR | N/A |

Cobertura objetivo: ≥90% líneas en `settle.ts` (c8 coverage via `npm run test -- --coverage`
— opcional pero recomendado).

---

## 9. Risks

| # | Riesgo | Severidad | Mitigación |
|---|--------|-----------|------------|
| **R1** | **TOCTOU simulate→write**: entre `simulate` (ok) y `write` (ejecuta) un third party puede consumir el nonce → write falla o tx revierte on-chain → `TRANSACTION_FAILED` pero el usuario/merchant no sabe si el pago salió en otro lado | Alta en integración | DT-A + CD-NEW-16 (JSDoc warning). WFAC-21 orchestrator agrega idempotency cache 120s + WFAC-42 BullMQ retry con re-simulate. Esta HU NO mitiga — documentado explícitamente |
| **R2** | **RPC flake** durante `waitForTransactionReceipt`: la tx llegó on-chain, hash conocido, pero el nodo RPC devuelve error / timeout / socket close → retornamos `TRANSACTION_FAILED` aunque el pago se ejecutó | Alta en producción | Timeout explícito 60s (CD-4). El caller (WFAC-21) tiene el hash y puede rellamar `waitForTransactionReceipt(hash)` para reconciliar. La settlement ledger en WFAC-32 registra status=pending con hash para follow-up. Unit tests cubren path AC-6 |
| **R3** | **Nonce replay reentrancy/race**: dos requests concurrentes al mismo facilitator con idéntico nonce → ambas pasan verify → ambas llaman simulate → ambas llaman write (una falla on-chain) → doble gas gastado + confusión de estado | Media (solo con concurrencia alta) | La V1 NO tiene idempotency cache en settle.ts (scope WFAC-21). El riesgo se mitiga en capas superiores: (a) Redis cache 120s por `paymentId` hash (WFAC-21), (b) EIP-3009 on-chain `_authorizationStates[from][nonce]` detecta replay y revierte → al menos no hay doble settlement. El bug es "gas gastado 2x", no "doble transferencia". Documentado como R3 para que WFAC-21 lo aborde |
| **R4** | **Signature malleability**: s-value "high" de una firma ECDSA puede reconstruirse como s-value "low" produciendo otra firma válida para el mismo mensaje → dos settlements con mismo nonce (en teoría). Heredado como risk conocido desde WFAC-6 | Baja (OpenZeppelin ECDSA.sol ya rechaza high-s desde 2020) | FiatTokenV2 usa `ECDSA.recover` de OpenZeppelin, que rechaza high-s. El propio contrato rechaza malleability. Nuestro `simulate` falla si el contrato rechaza. Documentado y cubierto por simulate. WFAC-13 (EIP-2098 compact) también contempla esto |
| **R5** | **Mock drift viem v2**: si viem actualiza a 2.5x la firma de `simulateContract` o `waitForTransactionReceipt` (p.ej. rename de field `request` → `simulationRequest`), nuestros mocks con `as unknown as PublicClient` no fallan en compile time porque el cast borra el contrato | Media (dependency lifecycle) | DT-D + tests de contrato mínimos: `typeof sim.request === 'object'` chequea el shape. WFAC-49 (plan existente) agrega tests de contrato viem. Dependabot con semver minor pins limita drift |
| **R6** | **Timeout default change**: viem default changed de `undefined` (work-item) a `180_000` (confirmado por Architect). Si nuestro `RECEIPT_TIMEOUT_MS=60_000` se olvida de pasar en algún call → receipt wait 180s → UX caller x402 timeout 300s se come 180s de nosotros → margen de error mínimo | Baja | CD-4 prohíbe literal inline. Test AC-5 asserts `timeout: 60_000` explícitamente pasado. Revisión Dev + AR vigila |
| **R7** | **`blockNumber` precision loss post-2^53**: `Number(receipt.blockNumber)` perderá precisión si alguna chain supera 2^53 blocks (improbable: Bitcoin está ~800k, Ethereum ~20M). Heredado de WFAC-6 BLQ-MED-1 | Muy Baja (décadas de margen) | CD-NEW-13 documenta TD. Future: `VerifyResult.blockNumber` pasa a `string \| number` en una HU dedicada. Acción recurrente: no crear nuevas HUs con `Number(bigint)` sin evaluar precisión |
| **R8** | **Writer sin cuenta (`account: undefined`)**: el adapter crea `walletClient` sin privateKeyToAccount en W1 (TODO WFAC-wallet-singleton). Si WFAC-21 despacha a settle.ts con un walletClient sin account → `writeContract` falla en runtime con error poco claro | Alta en integración | En esta HU sólo declaramos el contrato. Tests unitarios mockean todo. La integración con adapter real es scope WFAC-21 — ahí se valida el wallet del operator. Nota en JSDoc |

---

## 10. Readiness Check

- [x] **Work-item leído completo** — 14 ACs + 12 CDs + 6 DTs + 3 missing inputs resueltos.
- [x] **`project-context.md` leído** — stack confirmado (viem v2, vitest, TS strict, x402 spec).
- [x] **Exemplars verificados con `Read`**:
  - [x] `src/methods/eip3009/abi.ts` (26 líneas) — a extender.
  - [x] `src/methods/eip3009/verify.ts` (159 líneas) — import runtime.
  - [x] `src/methods/eip3009/index.ts` (11 líneas) — a extender.
  - [x] `src/chains/types.ts` (153 líneas) — type-only.
  - [x] `src/core/types.ts` (66 líneas) — type-only.
  - [x] `src/__tests__/unit/methods/eip3009/verify.test.ts` — patrón de test.
- [x] **viem types leídos en `node_modules/`** (3 obligatorios):
  - [x] `_types/actions/public/simulateContract.d.ts` — firma verificada.
  - [x] `_types/actions/wallet/writeContract.d.ts` — firma verificada.
  - [x] `_types/actions/public/waitForTransactionReceipt.d.ts` — timeout behavior verificada.
  - [x] `_types/errors/transaction.d.ts` — `WaitForTransactionReceiptTimeoutError` verificada.
  - [x] `_types/utils/signature/parseSignature.d.ts` — firma v/r/s verificada.
- [x] **3 Missing Inputs resueltos**:
  - [x] MI-1: `FIAT_TOKEN_ABI` diseñado (v/r/s overload) con justificación (§4).
  - [x] MI-2: client injection via parámetros confirmado (via ChainAdapter en WFAC-21).
  - [x] MI-3: `waitForTransactionReceipt` lanza `WaitForTransactionReceiptTimeoutError`.
- [x] **Auto-blindaje histórico leído** (WFAC-6) — 4 lecciones aplicadas (CD-NEW-13, CD-NEW-14, por construcción AC-9).
- [x] **No hay `[NEEDS CLARIFICATION]` pendientes**. El único CD que en work-item estaba marcado (CD-11) fue resuelto en §6 (decisión: atrapar todo).
- [x] **Waves definidas** W0→W1→W2 con criterio de salida por wave.
- [x] **Plan de tests** completo (≥14 tests + 4 hardening) con mapeo AC→test.
- [x] **≥4 Risks documentados** (8 entregados: TOCTOU, RPC flake, nonce race, malleability, mock drift, timeout default, blockNumber precision, wallet account missing).
- [x] **Branch base**: `feat/006-wfac-10-eip3009-settle` desde `main@00887c4`.
- [x] **Scope OUT respetado** — no se planea tocar `core/`, `routes/`, `chains/kite.ts`, idempotency cache, Supabase ledger, BullMQ.
- [x] **Output artefacto**: `sdd.md` listo para SPEC_APPROVED humano.

**Listo para SPEC_APPROVED.**

---

## 11. Artefactos esperados post-F2.5

Cuando el humano escriba `SPEC_APPROVED`, el Architect generará:

- `doc/sdd/006-wfac-10-eip3009-settle/story-WFAC-10.md` — Story File self-contained para
  el Dev (F3). Incluye shapes exactos, pasos de W0/W1/W2, Anti-Hallucination Checklist
  específica.

El Dev NO arranca F3 hasta que el Story File exista y el humano valide. Pipeline
NexusAgil QUALITY: Dev → AR → CR → F4 → DONE sin gates intermedios.

---

## 12. Referencias cruzadas

- [Work Item WFAC-10](./work-item.md)
- [SDD WFAC-6 (verify)](../005-wfac-6-eip3009-verify/sdd.md) — precedente directo.
- [Auto-Blindaje WFAC-6](../005-wfac-6-eip3009-verify/auto-blindaje.md) — lecciones aplicadas.
- [x402 Spec](https://docs.x402.org) — 10 error codes, /settle shape.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) — transferWithAuthorization.
- [viem v2 simulateContract docs](https://viem.sh/docs/contract/simulateContract) — patrón canónico simulate→write.
- [FiatTokenV2 source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol) — ABI oficial con v/r/s overload.
