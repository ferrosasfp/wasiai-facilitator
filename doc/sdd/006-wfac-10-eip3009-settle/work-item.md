# Work Item — [WFAC-10] EIP-3009 Settle Logic

## Resumen

Implementar `src/methods/eip3009/settle.ts` — la función de settlement on-chain del método
EIP-3009. Ejecuta `simulateContract` + `writeContract` (transferWithAuthorization) usando el
viem WalletClient del operador, luego espera el receipt con `waitForTransactionReceipt`.
Retorna un discriminated union `AdapterResult<SettleResult>` spec-literal. Este es el módulo
que mueve dinero real — cualquier bug aquí tiene impacto financiero directo.

## Sizing

- SDD_MODE: full
- Estimación: L (2–3 días implementación + tests)
- Branch sugerido: `feat/006-wfac-10-eip3009-settle`
- Clasificación NexusAgil: QUALITY (money-moving on-chain, AR obligatorio)

---

## Acceptance Criteria (EARS)

### Simulate-before-write (spec security)

**AC-1:** WHEN `settleEip3009()` is called with valid `SettleParams`, THEN the system SHALL call
`publicClient.simulateContract` with the full `transferWithAuthorization` arguments BEFORE calling
`walletClient.writeContract`, and SHALL abort with `SIMULATION_FAILED` if simulation throws.

**AC-2:** WHEN `simulateContract` throws for any reason (revert, insufficient balance, stale
nonce, RPC error), the system SHALL return
`{ ok: false, error: { code: 'SIMULATION_FAILED', message: '...', http: 500 } }`
without executing `writeContract`.

### Write transaction

**AC-3:** WHEN simulation succeeds, the system SHALL call `walletClient.writeContract` using the
`request` object returned from `simulateContract` (not reconstructing the call args) and SHALL
return the transaction hash.

**AC-4:** IF `writeContract` throws (nonce already used, RPC drop, wallet error), THEN the
system SHALL return
`{ ok: false, error: { code: 'TRANSACTION_FAILED', message: '...', http: 500 } }`.

### Receipt wait

**AC-5:** WHEN `writeContract` returns a transaction hash, the system SHALL call
`publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })` and SHALL wait for the
receipt before returning.

**AC-6:** WHEN `waitForTransactionReceipt` times out (no confirmation within 60s), the system
SHALL return
`{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'receipt timeout', http: 500 } }`.

**AC-7:** WHEN the receipt has `status === 'reverted'`, the system SHALL return
`{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'transaction reverted on-chain', http: 500 } }`.

### Success output contract

**AC-8:** WHEN the transaction is confirmed with `status === 'success'`, the system SHALL return
`{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to, asset }` where:
- `transactionHash` is the `0x`-prefixed hash from `writeContract`
- `blockNumber` is `Number(receipt.blockNumber)`
- `amount`, `from`, `to`, `asset` are sourced from the original `SettleParams` (not re-read from chain)

### Re-verify before settle

**AC-9:** WHEN `settleEip3009()` is called, the system SHALL call `verifyEip3009()` internally as
the first step and SHALL return its error as-is if verification fails, before attempting any RPC
call.

### Error code mapping

**AC-10:** WHEN `simulateContract` throws with a viem `ContractFunctionRevertedError` containing
a recognizable revert reason (e.g., `"authorization is used"` or `"authorization not yet valid"`),
the system SHALL return `SIMULATION_FAILED` (http: 500) — it SHALL NOT attempt to map revert
reasons to other x402 codes at V1 scope.

**AC-11:** IF the EIP-3009 function ABI used in `simulateContract` / `writeContract` does NOT
match `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature)`,
THEN the system SHALL fail at compile-time (TypeScript strict typing) rather than at runtime.

### Test coverage

**AC-12:** WHILE the test suite runs, the system SHALL NOT make any real RPC calls. All
`publicClient` and `walletClient` interactions SHALL be mocked via `vi.fn()` stubs injected as
parameters or via `vi.mock('viem', ...)`.

**AC-13:** WHEN all settle tests pass, the test suite SHALL cover: simulation-failed path,
write-failed path, receipt-reverted path, receipt-timeout path, and the happy path
(settled: true with correct SettleResult shape).

**AC-14:** WHILE `settleEip3009()` executes, the system SHALL NOT throw any exception for
foreseeable error conditions. All error paths SHALL return `{ ok: false, error: {...} }`.

---

## Scope IN

| Path | Descripción |
|------|-------------|
| `src/methods/eip3009/settle.ts` | Función principal `settleEip3009(params, token, chainId, publicClient, walletClient)` |
| `src/methods/eip3009/index.ts` | Re-export de `settleEip3009` |
| `src/__tests__/unit/methods/eip3009/settle.test.ts` | Tests unitarios: happy path + 5 error paths |

## Scope OUT

- `src/core/settle.ts` — orquestador core que despacha al método (WFAC-21 o ticket aparte)
- `src/routes/settle.ts` — route HTTP (WFAC-21)
- Idempotency cache check — pertenece a `core/settle.ts` (WFAC-21)
- `facilitator_settlements` Supabase ledger write — pertenece a `core/settle.ts` (WFAC-32)
- On-chain balance check (`balanceOf`) — decidido en DT-F: se delega al simulate (si el usuario no tiene saldo, simulate revierte)
- EIP-2098 compact signature normalization — WFAC-13 (ticket dedicado, pre-procesing antes de settle)
- BullMQ retry queue — WFAC-42 (fuera de scope V1 para settle.ts)
- Permit2 / ERC-7710 settle — métodos futuros

---

## Decisiones Técnicas

**DT-A — simulateContract → writeContract gap (TOCTOU)**

Existe una ventana entre `simulateContract` (que pasa) y `writeContract` (que ejecuta). En ese
gap el nonce puede haberse usado, el balance puede haber caído, o el bloque puede haber avanzado.
Estrategia V1: aceptar este gap sin retry en settle.ts — si `writeContract` falla, retornar
`TRANSACTION_FAILED` directamente. El retry con re-simulate es responsabilidad del `core/settle.ts`
(WFAC-42 / BullMQ queue). Razonamiento: `settle.ts` a nivel de método debe ser simple y sin estado;
la lógica de retry con back-off vive en la capa core/queue para no duplicar responsabilidades.
Documentar explícitamente en el código que el gap existe y no está mitigado en esta capa.

**DT-B — waitForTransactionReceipt timeout: 60s**

Valor por defecto de viem es `undefined` (espera indefinidamente). El spec x402 establece
`maxTimeoutSeconds: 300` a nivel de protocolo, pero ese timeout aplica al flujo completo
(verify + settle + network latency). Para la espera de receipt en la capa de método usamos 60s
(60_000ms) como timeout interno. Razonamiento: 60s es generoso para cualquier EVM chain soportada
(Kite blocktime ~2s, Avalanche ~2s); si transcurren 60s sin receipt probablemente hay un problema
de RPC o la tx quedó stuck. El caller (core/settle) puede reintentar con `waitForTransactionReceipt`
adicional si lo necesita. El timeout de 60s es un CD, no hardcoded — se acepta como constante
named `RECEIPT_TIMEOUT_MS = 60_000` en el archivo.

**DT-C — Receipt retries vs single wait**

V1: single `waitForTransactionReceipt` call en settle.ts. No implementar retry aquí — la tx
ya fue submitted, su hash es conocido. Si el primer wait falla (timeout / network error), el
core layer (WFAC-42) puede rellamar `waitForTransactionReceipt(txHash)` con el hash conocido.
Implementar retry en settle.ts crearía lógica de state management que corresponde a una capa
superior.

**DT-D — Mock walletClient shape en tests**

viem v2 `WalletClient` es un objeto con múltiples métodos. Para evitar construir un mock completo,
`settleEip3009` recibirá `publicClient` y `walletClient` como parámetros explícitos (dependency
injection, mismo patrón que `getPublicClient()` / `getWalletClient()` en ChainAdapter). En tests:
```ts
const mockPublicClient = {
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
} as unknown as PublicClient;
const mockWalletClient = {
  writeContract: vi.fn(),
} as unknown as WalletClient;
```
Usar `as unknown as PublicClient` es el patrón vitest aceptado para partial mocks de interfaces
complejas. El `as unknown` se documenta como intencional (única excepción a la regla no-any).
No mockear el módulo viem entero con `vi.mock('viem', ...)` para evitar side effects en otros tests.

**DT-E — Error codes mapping**

| Condición | Código x402 | HTTP |
|-----------|-------------|------|
| `simulateContract` throws (cualquier razón) | `SIMULATION_FAILED` | 500 |
| `writeContract` throws | `TRANSACTION_FAILED` | 500 |
| Receipt `status === 'reverted'` | `TRANSACTION_FAILED` | 500 |
| `waitForTransactionReceipt` timeout | `TRANSACTION_FAILED` | 500 |
| `verifyEip3009` returns error | propagado tal cual | (mismo http del verify) |

Razonamiento para NO distinguir subcasos de TRANSACTION_FAILED: el spec x402 solo define un
código para fallos on-chain. La granularidad (timeout vs revert vs write-fail) queda en el campo
`message` del error para debugging, no en el `code`. V1 conservativo.

**DT-F — Reutilizar AcceptedSchema / SettleAcceptedSchema**

`SettleParams === VerifyParams` (type alias en `src/chains/types.ts`). La validación de shape
de `params.accepted` y `params.payload.authorization` ya la hace `verifyEip3009()` (AC-9 requiere
llamarlo primero). Por tanto, `settle.ts` NO necesita un `SettleAcceptedSchema` propio — re-usa
el validate flow completamente delegando a `verifyEip3009`. Esto evita duplicar lógica de
validación. Si en el futuro settle necesita checks adicionales (nonce on-chain, balance check
directo) se agrega un `SettleAcceptedSchema` en ese momento (YAGNI principle).

---

## Constraint Directives

**CD-1:** PROHIBIDO que `settleEip3009()` o cualquier función del módulo lancen excepciones por
condiciones previsibles. Todo error retorna `{ ok: false, error: { code, message, http } }`.
Las excepciones de viem (simulate/write/receipt) deben capturarse con `try/catch` individuales
por bloque y convertirse al código correspondiente (SIMULATION_FAILED o TRANSACTION_FAILED).

**CD-2:** OBLIGATORIO llamar `simulateContract` ANTES de `writeContract` en toda ejecución del
happy path. No existe flujo que llame a `writeContract` sin simulate previo exitoso.

**CD-3:** PROHIBIDO hardcodear el ABI de `transferWithAuthorization` en `settle.ts`. El ABI
existente en `src/methods/eip3009/abi.ts` debe ser extendido o se crea `settle-abi.ts` con el
ABI de la función para el `simulateContract`/`writeContract`. Reutilizar siempre desde un source
de verdad.

**CD-4:** OBLIGATORIO que el timeout de receipt sea una constante named `RECEIPT_TIMEOUT_MS`
definida en `settle.ts` (o en un archivo de constantes del módulo). PROHIBIDO el literal `60000`
o `60_000` inline en la llamada a `waitForTransactionReceipt`.

**CD-5:** OBLIGATORIO que `settleEip3009` reciba `publicClient: PublicClient` y
`walletClient: WalletClient` como parámetros explícitos (dependency injection). PROHIBIDO
importar o instanciar clientes viem directamente desde `settle.ts` (eso pertenece a `infra/wallet.ts`).

**CD-6:** PROHIBIDO importar desde `src/core/`, `src/chains/registry.ts`, `src/routes/`, u otros
métodos. Sólo imports permitidos: `src/chains/types.ts` (type-only), `src/methods/eip3009/verify.ts`,
`src/methods/eip3009/abi.ts`, viem, tipos viem.

**CD-7:** PROHIBIDO usar `console.log`. Sin logging en la función — el caller (core/settle) logea
el resultado. Esto mantiene la función pura y testeable sin Pino.

**CD-8:** PROHIBIDO que los tests hagan RPC calls reales. Todos los mocks de `publicClient` y
`walletClient` son `vi.fn()` stubs. PROHIBIDO `vi.mock('viem', ...)` a nivel de módulo completo
(mock solo los objetos inyectados).

**CD-9:** OBLIGATORIO que `writeContract` use el objeto `request` retornado por `simulateContract`
(patrón viem canónico: `const { request } = await simulateContract(...); await writeContract(request)`).
PROHIBIDO reconstruir los args de la llamada para `writeContract` de forma independiente.

**CD-10:** OBLIGATORIO que la firma exportada sea:
```ts
export async function settleEip3009(
  params: SettleParams,
  token: EIP3009Token,
  chainId: ChainId,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<AdapterResult<SettleResult>>
```
TypeScript strict, sin `any`, sin `as unknown` salvo en mocks de test.

**CD-11:** OBLIGATORIO que el bloque `try/catch` alrededor de `simulateContract` NO capture
errores de programación (ej. `TypeError: cannot read property of undefined`). Solo capturar
errores de RPC / contrato. Patrón: relanzar si `!(error instanceof BaseError)` (viem BaseError).
[NEEDS CLARIFICATION: validar en F2 si esta heurística es la correcta para viem v2.47]

**CD-12:** OBLIGATORIO que `settle.test.ts` incluya al menos un test por cada uno de los 14 ACs.
Cada test usa `expect(result.ok).toBe(false/true)` y verifica `error.code` en paths de error.

---

## Missing Inputs

- ABI completo de `transferWithAuthorization` para `simulateContract` — la función existe en
  `abi.ts` solo como typed data types, NO como ABI para llamadas on-chain.
  [resuelto en F2 — Architect especifica ABI de la función para el contrato EIP-3009]
- `ChainAdapter.settle()` firma actual en `chains/types.ts` llama a
  `settle(params: SettleParams): Promise<AdapterResult<SettleResult>>` — settle.ts en methods/
  necesita publicClient + walletClient inyectados; el chain adapter los obtiene de `getPublicClient()`
  / `getWalletClient()`. Esto implica que el chain adapter wrappea la llamada.
  [resuelto en F2 — Architect verifica que el adapter es el punto de inyección]
- Comportamiento exacto de `waitForTransactionReceipt` con timeout en viem v2.47 —
  lanza `WaitForTransactionReceiptTimeoutError` vs retorna undefined.
  [resuelto en F2 — Architect valida contra node_modules/viem antes de codear]

---

## Waves de implementación

| Wave | Contenido | Archivos |
|------|-----------|---------|
| **W0** | ABI de función `transferWithAuthorization` para on-chain calls + constante `RECEIPT_TIMEOUT_MS` | `abi.ts` (extensión) o nuevo `settle-abi.ts` |
| **W1** | Función `settleEip3009` completa: re-verify → simulate → write → wait receipt | `settle.ts`, `index.ts` (re-export) |
| **W2** | Tests completos: happy path + simulation_failed + write_failed + receipt_reverted + receipt_timeout | `settle.test.ts` |

Cada wave: `npm run typecheck` verde + `npm test` verde antes de avanzar.

---

## Análisis de paralelismo

| Relación | HU | Tipo |
|----------|----|------|
| **Requiere** | WFAC-6 (verify logic) | `settle.ts` importa `verifyEip3009` — WFAC-6 ya está DONE (SDD 005) |
| **Bloquea** | WFAC-21 (POST /settle route) | La route llama al method adapter que llama a `settleEip3009` |
| **Paralelo posible** | WFAC-12 (error codes mapping) | Comparte `X402ErrorCode` pero no tiene dependencia directa |
| **Paralelo posible** | WFAC-20 (POST /verify route) | Independiente de settle — puede ir en paralelo |
| **Paralelo posible** | WFAC-32 (settlement ledger) | Supabase write pertenece a core/settle — independiente |
| **Bloqueado por** | Ninguna HU activa | WFAC-6 ya está mergeado (e342b7d) — path libre |

**Path crítico post-WFAC-10:** WFAC-10 → WFAC-21 → integración end-to-end `/settle`.
Sin WFAC-10 no hay `/settle` funcional y el facilitator está incompleto para producción.
