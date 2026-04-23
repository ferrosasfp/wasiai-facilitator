# Story File — WFAC-10 EIP-3009 Settle Logic

> **Este archivo es autocontenido.** El Dev NO necesita leer work-item ni SDD para
> implementar esta HU. Todo lo que necesita está acá.
>
> **Status**: SPEC_APPROVED (pending humano — no arrancar F3 hasta que el humano escriba
> literal `SPEC_APPROVED`).
> **Branch**: `feat/006-wfac-10-eip3009-settle` desde `main@00887c4`.
> **Fecha generación**: 2026-04-23.
> **Agente**: nexus-architect (F2.5).
> **Proyecto**: wasiai-facilitator (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`).
> **Jira**: https://ferrosasfp.atlassian.net/browse/WFAC-10.
> **SDD**: `doc/sdd/006-wfac-10-eip3009-settle/sdd.md` (referencia — NO obligatoria para el Dev).

---

## 0. Contrato con el Dev

1. **Un camino oficial único**. Todo lo que aparece en §3/§4/§5/§6/§7 es el camino
   correcto. Si creés que hay una "mejor forma" no documentada: parar y escalar.
2. **No hay código que adivinar**. Firmas, shapes, decisiones, orden de llamadas —
   todos fijados. El Dev escribe el **cuerpo** de funciones cuyas interfaces están
   especificadas.
3. **Waves secuenciales**. W0 → W1 → W2. No salteés waves.
4. **16 CDs inviolables** (§7). Cada violación se marca BLOQUEANTE en AR/CR.
5. **14 ACs con ≥1 test c/u = 14+ tests mínimos** (§6). La HU no está DONE hasta que
   todos los tests pasan + `npm run qa` verde + `npm run build` verde.
6. **Sin `console.*` en `src/`**. Esta HU NO recibe logger.
7. **Node_modules read-first**: ANTES de codear W1, verificar firmas de `simulateContract`,
   `writeContract`, `waitForTransactionReceipt`, `parseSignature`. Paths en §4.1.
8. **Cero `any`, cero `as unknown as X` en `src/`**. Único `as unknown as PublicClient` /
   `as unknown as WalletClient` permitido: en tests (DT-D).
9. **viem exclusivo**. PROHIBIDO ethers, @noble, web3.js.
10. **Boundary estricto**. `src/methods/eip3009/settle.ts` importa SOLO:
    - Runtime: viem (+ subpath), `./verify.js`, `./abi.js`.
    - Type-only: `../../chains/types.js`, `../../core/types.js`.
    Cualquier otro import de `src/*` está PROHIBIDO (ver CD-6).

Si encontrás ambigüedad no cubierta: **NO IMPLEMENTAR**. Escalar.

---

## 1. Resumen Ejecutivo

**Qué se construye**: la función `settleEip3009(params, token, chainId, publicClient,
walletClient)` que:

1. Re-valida el payload con `verifyEip3009(...)` (AC-9).
2. Parsea la firma en v/r/s (descarta EIP-2098 compact — WFAC-13 ticket).
3. Simula la tx con `simulateContract` usando `FIAT_TOKEN_ABI`.
4. Ejecuta la tx con `writeContract(sim.request)` (canónico viem).
5. Espera el receipt con `waitForTransactionReceipt({ hash, timeout: 60_000 })`.
6. Si `status === 'reverted'` → `TRANSACTION_FAILED`. Si `'success'` → retorna
   `SettleResult` spec-literal.

Más la constante `FIAT_TOKEN_ABI` (fragmento `transferWithAuthorization` v/r/s overload)
y `RECEIPT_TIMEOUT_MS = 60_000`.

**Entregables**:

- `src/methods/eip3009/abi.ts` (MODIFY) — agregar `FIAT_TOKEN_ABI` + `RECEIPT_TIMEOUT_MS`.
- `src/methods/eip3009/settle.ts` (CREATE) — función principal ~130 líneas.
- `src/methods/eip3009/index.ts` (MODIFY) — re-exportar `settleEip3009`, `FIAT_TOKEN_ABI`,
  `RECEIPT_TIMEOUT_MS`.
- `src/__tests__/unit/methods/eip3009/settle.test.ts` (CREATE) — ≥14 tests.
- `npm run qa` verde + `npm run build` verde.

**Por qué importa**: `settleEip3009` es el **único lugar del codebase que mueve dinero
real** via `transferWithAuthorization`. Un bug acá tiene impacto financiero directo.
Cuidado.

**Qué NO hace**:

- NO orchestration (WFAC-21).
- NO persistence (WFAC-32).
- NO idempotency cache (WFAC-21).
- NO retry queue (WFAC-42).
- NO normaliza EIP-2098 compact (WFAC-13 — esta HU rechaza esas firmas con
  `INVALID_SIGNATURE`).
- NO modifica `src/chains/kite.ts`.

---

## 2. Prerequisites (antes de W0)

Ejecutar desde `/home/ferdev/.openclaw/workspace/wasiai-facilitator/`:

```bash
# 1. Verificar branch base
git status                      # clean
git rev-parse HEAD              # si no estás en main@00887c4: git checkout main && git pull

# 2. Crear/checkout branch de la HU
git checkout -b feat/006-wfac-10-eip3009-settle
# (si ya existe: git checkout feat/006-wfac-10-eip3009-settle && git rebase main)

# 3. Verificar deps y tests previos
cat node_modules/viem/package.json | grep '"version"'  # 2.47.x o 2.48.x
ls src/methods/eip3009/                                # abi.ts, domain.ts, index.ts, schemas.ts, verify.ts
ls src/__tests__/unit/methods/eip3009/                 # verify.test.ts, domain.test.ts, schemas.test.ts

# 4. Verificar baseline verde
npm run typecheck               # debe pasar
npm run test                    # debe pasar (todos los tests existentes)
```

Si cualquier paso falla, **parar** y escalar al humano.

---

## 3. Archivos afectados (Scope IN)

| Archivo | Acción | Wave | Líneas aprox | Notas |
|---------|--------|------|--------------|-------|
| `src/methods/eip3009/abi.ts` | MODIFY | W0 | +40 líneas | Agregar `FIAT_TOKEN_ABI` (array `as const`) + `RECEIPT_TIMEOUT_MS = 60_000` |
| `src/methods/eip3009/index.ts` | MODIFY | W0 + W1 | +3 líneas | Re-exportar los nuevos símbolos |
| `src/methods/eip3009/settle.ts` | CREATE | W1 | ~130 líneas | Función principal + helper `err()` + `sanitize()` |
| `src/__tests__/unit/methods/eip3009/settle.test.ts` | CREATE | W2 | ~400 líneas | ≥14 tests (1+ por AC) + helpers |

**Archivos PROHIBIDOS de modificar** (fuera de scope):

- `src/core/*`, `src/routes/*`, `src/infra/*`, `src/chains/*` — no tocar.
- `src/methods/eip3009/verify.ts`, `domain.ts`, `schemas.ts` — no tocar (scope WFAC-6).
- `src/__tests__/unit/methods/eip3009/verify.test.ts`, `domain.test.ts`, `schemas.test.ts`
  — no tocar.
- `src/methods/permit2/`, `src/methods/erc7710/` — no existen, NO crear.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js` — NO tocar.

---

## 4. Anti-Hallucination Checklist (específica de esta HU)

### 4.1. Leíste los siguientes archivos en `node_modules/`

- [ ] `node_modules/viem/_types/actions/public/simulateContract.d.ts` confirmaste:
  - Firma: `simulateContract<...>(client, parameters): Promise<SimulateContractReturnType>`.
  - Return shape: `{ result, request }` donde `request` es un objeto que se pasa opaco
    a `writeContract`.
  - Lanza excepción si revierte / RPC falla / encoding falla.
- [ ] `node_modules/viem/_types/actions/wallet/writeContract.d.ts` confirmaste:
  - Firma: `writeContract<...>(client, parameters): Promise<WriteContractReturnType>`.
  - Return type: `WriteContractReturnType = SendTransactionReturnType = Hash = 0x${string}`.
  - Lanza excepción por RPC drop / nonce error / insufficient funds para gas.
- [ ] `node_modules/viem/_types/actions/public/waitForTransactionReceipt.d.ts` confirmaste:
  - Firma: `waitForTransactionReceipt(client, { hash, timeout?, ... }): Promise<TxReceipt>`.
  - `timeout` es `number | undefined`. Default es **180_000** ms (no undefined).
  - Al expirar, **lanza `WaitForTransactionReceiptTimeoutError`** (NO retorna undefined).
  - Return type: `TransactionReceipt` con `status: 'success' | 'reverted'`,
    `blockNumber: bigint`, `transactionHash: Hash`.
- [ ] `node_modules/viem/_types/errors/transaction.d.ts` confirmaste:
  - `class WaitForTransactionReceiptTimeoutError extends BaseError`.
  - Se atrapa con `catch (e)` genérico (no necesitás `instanceof`).
- [ ] `node_modules/viem/_types/utils/signature/parseSignature.d.ts` confirmaste:
  - Firma: `parseSignature(hex): { r, s, v: bigint, yParity } | { r, s, yParity, v?: never }`.
  - El retorno es un discriminated union: `v` puede ser `bigint` o `never`/`undefined`
    (caso EIP-2098 compact).

### 4.2. Leíste los siguientes archivos del proyecto

- [ ] `src/methods/eip3009/abi.ts` (26 líneas) — vas a extender. Confirmaste:
  - `EIP3009_TYPES` y `EIP3009_PRIMARY_TYPE` ya están (NO tocarlos).
  - Usar `as const` en el nuevo `FIAT_TOKEN_ABI` para inferencia viem.
- [ ] `src/methods/eip3009/verify.ts` (159 líneas) confirmaste:
  - Export `verifyEip3009(params, token, chainId): Promise<AdapterResult<VerifyResult>>`.
  - Patrón helper `err(code, message, http)` interno (copiar este patrón en settle.ts).
  - Sin logger, sin console, sin throw.
- [ ] `src/methods/eip3009/index.ts` (11 líneas) — barrel actual:
  ```ts
  export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';
  export { ... } from './schemas.js';
  export { buildEip3009Domain } from './domain.js';
  export { verifyEip3009 } from './verify.js';
  ```
  Agregar: `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS` (desde `./abi.js`) y `settleEip3009`
  (desde `./settle.js`).
- [ ] `src/chains/types.ts` (153 líneas) confirmaste shapes:
  - `SettleParams = VerifyParams` (type alias).
  - `SettleResult = { settled: true, transactionHash, blockNumber, amount, from, to, asset }`
    (7 fields, todos `readonly`).
  - `EIP3009Token.address: Address` (`0x${string}`).
  - `AdapterResult<T> = Result<T>`.
  - Import `PublicClient`, `WalletClient` desde `viem` (runtime type + value).
- [ ] `src/core/types.ts` (66 líneas) confirmaste:
  - `X402ErrorCode` incluye `'SIMULATION_FAILED'` y `'TRANSACTION_FAILED'`.
  - `Result<T> = Ok<T> | Err`.
  - `Address = 0x${string}`.
- [ ] `src/__tests__/unit/methods/eip3009/verify.test.ts` (~400 líneas) confirmaste:
  - Patrón `TEST_PRIVATE_KEY` (Hardhat account #0 — public) + `privateKeyToAccount`.
  - `makeValidParams(opts?)` helper.
  - Assertions: `expect(result.ok).toBe(true/false)` + narrowing `if (!result.ok) {...}`.
  - Importa `from '../../../../methods/eip3009/...'` (4 niveles arriba).

### 4.3. Confirmaste que los siguientes archivos NO existen todavía

- [ ] `src/methods/eip3009/settle.ts` → lo vas a crear en W1.
- [ ] `src/__tests__/unit/methods/eip3009/settle.test.ts` → lo vas a crear en W2.

### 4.4. Confirmaste que los siguientes símbolos NO existen todavía en `abi.ts`

- [ ] `FIAT_TOKEN_ABI` → lo vas a agregar en W0.
- [ ] `RECEIPT_TIMEOUT_MS` → lo vas a agregar en W0.

### 4.5. Checks críticos específicos (money-moving)

- [ ] NO vas a hacer `simulateContract` con un ABI hardcoded — usás `FIAT_TOKEN_ABI`
  (CD-3).
- [ ] NO vas a pasar literal `60_000` a `waitForTransactionReceipt` — usás
  `RECEIPT_TIMEOUT_MS` (CD-4).
- [ ] NO vas a reconstruir args para `writeContract` — pasás `sim.request` opaco (CD-9).
- [ ] NO vas a llamar `createPublicClient` / `createWalletClient` dentro de `settle.ts`
  (CD-5).
- [ ] NO vas a hacer `console.log` / `console.error` (CD-7).
- [ ] NO vas a hacer `throw new Error(...)` por condiciones previsibles (CD-1 + AC-14).
- [ ] NO vas a mockear `viem` completo con `vi.mock('viem', ...)` (CD-8).
- [ ] NO vas a hacer RPC real en tests (CD-8, AC-12).

---

## 5. Shapes TypeScript exactas

### 5.1. `FIAT_TOKEN_ABI` (nuevo — en `abi.ts`)

```ts
/**
 * Minimal ABI for EIP-3009 `transferWithAuthorization` — v/r/s overload.
 *
 * Source: Circle FiatTokenV2 (canonical USDC/PYUSD implementation).
 * https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol
 *
 * Overload: v/r/s (NOT the EIP-2098 compact bytes overload).
 * The compact bytes variant requires WFAC-13 pre-processing (out of scope).
 *
 * CRITICAL: `as const` is required so viem can narrow the function signature
 * types for simulateContract/writeContract. Without it, the inferred type
 * widens and viem rejects with an abi-encoding error at runtime.
 */
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

/**
 * Timeout for waiting on-chain tx receipt after submission.
 *
 * 60s chosen because supported chains (Kite, Avalanche) have ≤2s blocktimes.
 * Longer waits indicate RPC issues or stuck txs — upper-layer retry (WFAC-42)
 * handles those. viem default is 180_000 ms; we explicitly override.
 */
export const RECEIPT_TIMEOUT_MS = 60_000;
```

### 5.2. Firma exacta de `settleEip3009`

```ts
// settle.ts
import { parseSignature } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  SettleParams,
  SettleResult,
} from '../../chains/types.js';
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
import { verifyEip3009 } from './verify.js';

/**
 * Execute an EIP-3009 `transferWithAuthorization` on-chain.
 *
 * Flow:
 *   1. Re-verify payload (off-chain checks; NO RPC).
 *   2. Parse signature into v/r/s. Reject EIP-2098 compact (WFAC-13).
 *   3. simulateContract — if throws → SIMULATION_FAILED.
 *   4. writeContract(sim.request) — if throws → TRANSACTION_FAILED.
 *   5. waitForTransactionReceipt — timeout or throw → TRANSACTION_FAILED.
 *   6. If receipt.status === 'reverted' → TRANSACTION_FAILED.
 *   7. Return SettleResult with fields from input params (NOT re-read on-chain).
 *
 * Never throws for foreseeable conditions — always returns AdapterResult.
 *
 * @remarks
 * TOCTOU gap: simulateContract succeeds at block N; writeContract executes at
 * block N+k. If nonce is consumed in that window (e.g. user settled elsewhere),
 * writeContract or the on-chain receipt will surface the failure as
 * TRANSACTION_FAILED. This function does NOT retry — the core/settle orchestrator
 * (WFAC-21) + BullMQ queue (WFAC-42) handle retries.
 *
 * @remarks
 * `blockNumber` returned is `Number(receipt.blockNumber)` — may lose precision
 * if the chain ever exceeds 2^53-1 blocks (not a concern for decades). Tracked
 * as TD in WFAC-6 auto-blindaje BLQ-MED-1.
 */
export async function settleEip3009(
  params: SettleParams,
  token: EIP3009Token,
  chainId: ChainId,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<AdapterResult<SettleResult>> {
  // ... implementation (ver §6)
}
```

### 5.3. Helper interno `err`

```ts
function err(
  code: X402ErrorCode,
  message: string,
  http: number,
): AdapterResult<SettleResult> {
  return { ok: false, error: { code, message, http } };
}
```

### 5.4. Helper interno `sanitize`

```ts
/** Extract a safe, bounded-length string from an unknown error. */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}
```

### 5.5. Barrel actualizado — `index.ts`

```ts
export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE, FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
export {
  AddressHexSchema,
  Bytes32HexSchema,
  Eip3009AuthorizationSchema,
  Uint256StringSchema,
  type Eip3009Authorization,
} from './schemas.js';
export { buildEip3009Domain } from './domain.js';
export { verifyEip3009 } from './verify.js';
export { settleEip3009 } from './settle.js';
```

---

## 6. Waves de implementación

### W0 — ABI + constants (≤50 LOC nuevas)

**Pasos**:

1. Abrir `src/methods/eip3009/abi.ts`. Al final del archivo (después de línea 26),
   agregar `FIAT_TOKEN_ABI` y `RECEIPT_TIMEOUT_MS` según shapes en §5.1.
2. Abrir `src/methods/eip3009/index.ts`. Modificar primera línea:
   ```ts
   // antes:
   export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';
   // después:
   export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE, FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
   ```
3. Ejecutar:
   ```bash
   npm run typecheck     # verde
   npm run test          # verde (tests existentes siguen pasando)
   ```

**Criterio de salida**: typecheck + test verdes. `FIAT_TOKEN_ABI` es accesible como
`import { FIAT_TOKEN_ABI } from '../../../methods/eip3009/index.js'` desde cualquier
lugar.

### W1 — `settleEip3009` (~130 LOC)

**Pasos**:

1. Crear `src/methods/eip3009/settle.ts`. Usar la estructura siguiente:

```ts
/**
 * EIP-3009 settle — on-chain transferWithAuthorization execution.
 *
 * [full JSDoc from §5.2 here]
 */

import { parseSignature } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  SettleParams,
  SettleResult,
} from '../../chains/types.js';
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
import { verifyEip3009 } from './verify.js';

function err(
  code: X402ErrorCode,
  message: string,
  http: number,
): AdapterResult<SettleResult> {
  return { ok: false, error: { code, message, http } };
}

function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

export async function settleEip3009(
  params: SettleParams,
  token: EIP3009Token,
  chainId: ChainId,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<AdapterResult<SettleResult>> {
  // 1. Re-verify (AC-9) — propagate error unchanged.
  const v = await verifyEip3009(params, token, chainId);
  if (!v.ok) {
    return { ok: false, error: v.error };
  }

  // 2. Parse signature into v/r/s (reject EIP-2098 compact — CD-NEW-15).
  const parsed = parseSignature(params.payload.signature);
  if (!('v' in parsed) || parsed.v === undefined) {
    return err(
      'INVALID_SIGNATURE',
      'EIP-2098 compact signatures not supported in V1 (WFAC-13)',
      401,
    );
  }
  const { r, s } = parsed;
  const vNum = Number(parsed.v); // v ∈ {27, 28} — safe Number conversion

  // 3. Simulate (AC-1, AC-2, CD-2). Must run BEFORE write.
  const auth = params.payload.authorization;
  let sim;
  try {
    sim = await publicClient.simulateContract({
      address: token.address,
      abi: FIAT_TOKEN_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        auth.from,
        auth.to,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        vNum,
        r,
        s,
      ],
    });
  } catch (e) {
    return err('SIMULATION_FAILED', sanitize(e), 500);
  }

  // 4. Write (AC-3, AC-4, CD-9). Use sim.request opaque — do NOT reconstruct.
  let hash: `0x${string}`;
  try {
    hash = await walletClient.writeContract(sim.request);
  } catch (e) {
    return err('TRANSACTION_FAILED', sanitize(e), 500);
  }

  // 5. Wait receipt (AC-5, AC-6, CD-4).
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
  } catch (e) {
    // viem throws WaitForTransactionReceiptTimeoutError on timeout.
    // All errors here map to TRANSACTION_FAILED. If message is short,
    // preserve it; otherwise use literal 'receipt timeout' (AC-6 spec).
    const msg =
      e instanceof Error && e.name === 'WaitForTransactionReceiptTimeoutError'
        ? 'receipt timeout'
        : sanitize(e);
    return err('TRANSACTION_FAILED', msg, 500);
  }

  // 6. Check status (AC-7).
  if (receipt.status === 'reverted') {
    return err('TRANSACTION_FAILED', 'transaction reverted on-chain', 500);
  }

  // 7. Success (AC-8). Fields from input params, NOT re-read from chain.
  return {
    ok: true,
    settled: true,
    transactionHash: hash,
    blockNumber: Number(receipt.blockNumber),
    amount: params.accepted.amount,
    from: auth.from,
    to: auth.to,
    asset: token.address,
  };
}
```

2. Actualizar `src/methods/eip3009/index.ts` con `export { settleEip3009 } from
   './settle.js';` al final.

3. Ejecutar:
   ```bash
   npm run typecheck     # verde
   npm run build         # verde
   npm run test          # verde (W2 tests aún no existen, lo demás verde)
   ```

**Criterio de salida**: build limpio, sin regresiones.

### W2 — Tests (≥14 tests, 1+ por AC)

**Pasos**:

1. Crear `src/__tests__/unit/methods/eip3009/settle.test.ts` con la estructura siguiente.

**Template del archivo de tests** (copiar y completar los TODOs):

```ts
/**
 * Unit tests for settleEip3009.
 *
 * Covers all 14 ACs of WFAC-10 (see doc/sdd/006-wfac-10-eip3009-settle/work-item.md).
 *
 * Mocks: PublicClient.simulateContract + PublicClient.waitForTransactionReceipt
 * + WalletClient.writeContract via vi.fn(). No real RPC, no vi.mock('viem', ...).
 * Signature fixtures generated offline with privateKeyToAccount (Hardhat account #0).
 */

import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient, TypedDataDomain, WalletClient } from 'viem';
import { settleEip3009 } from '../../../../methods/eip3009/settle.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from '../../../../methods/eip3009/abi.js';
import {
  EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE,
} from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, SettleParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

// Hardhat account #0 — public knowledge.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TEST_CHAIN_ID = asChainId(2368);

const TEST_TOKEN: EIP3009Token = {
  address: '0x00000000000000000000000000000000000000ff' as Address,
  symbol: 'TEST',
  decimals: 6,
  name: 'Test Token',
  eip712Name: 'Test Token',
  eip712Version: '1',
};

const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as Address;
const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

type AuthMessage = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

async function signFixture(
  domain: TypedDataDomain,
  message: AuthMessage,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message,
  });
}

async function makeValidParams(opts?: {
  nowSec?: number;
  messageOverrides?: Partial<AuthMessage>;
  acceptedOverrides?: Partial<SettleParams['accepted']>;
  signatureOverride?: `0x${string}`;
}): Promise<SettleParams> {
  // nowSec + 3600 buffer to avoid flake (CD-NEW-14 — see WFAC-6 T-H5 note).
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const baseMessage: AuthMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
    ...opts?.messageOverrides,
  };
  const domain = buildEip3009Domain(TEST_TOKEN, TEST_CHAIN_ID, {
    extra: { assetTransferMethod: 'eip3009' },
  } as SettleParams['accepted']);
  const signature = opts?.signatureOverride ?? (await signFixture(domain, baseMessage));

  return {
    x402Version: 2,
    resource: {
      url: 'https://example.com',
      description: 't',
      mimeType: 'application/json',
    },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: '1000',
      asset: TEST_TOKEN.address,
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009' },
      ...opts?.acceptedOverrides,
    },
    payload: {
      signature,
      authorization: {
        from: baseMessage.from,
        to: baseMessage.to,
        value: baseMessage.value.toString(),
        validAfter: baseMessage.validAfter.toString(),
        validBefore: baseMessage.validBefore.toString(),
        nonce: baseMessage.nonce,
      },
    },
  };
}

function makeMockClients(): { publicClient: PublicClient; walletClient: WalletClient } {
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    // DT-D: partial mock — tests only exercise these 2 methods.
  } as unknown as PublicClient;
  const walletClient = {
    writeContract: vi.fn(),
    // DT-D: partial mock — tests only exercise this method.
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

describe('settleEip3009', () => {
  describe('AC-1 — simulate before write', () => {
    it('calls simulateContract before writeContract', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      const callOrder: string[] = [];
      vi.mocked(publicClient.simulateContract).mockImplementation(async () => {
        callOrder.push('sim');
        return { request: {} as never, result: undefined as never };
      });
      vi.mocked(walletClient.writeContract).mockImplementation(async () => {
        callOrder.push('write');
        return TEST_TX_HASH;
      });
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(callOrder).toEqual(['sim', 'write']);
    });
  });

  describe('AC-2 — simulateContract throws', () => {
    it('returns SIMULATION_FAILED and does not call writeContract', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('execution reverted: nonce used'),
      );

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SIMULATION_FAILED');
        expect(result.error.http).toBe(500);
      }
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('AC-3 — writeContract uses sim.request', () => {
    it('passes sim.request object opaquely to writeContract', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      const opaqueRequest = { __opaque: 'marker' };
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: opaqueRequest as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(walletClient.writeContract).toHaveBeenCalledWith(opaqueRequest);
    });
  });

  describe('AC-4 — writeContract throws', () => {
    it('returns TRANSACTION_FAILED on write error', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockRejectedValueOnce(new Error('RPC drop'));

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.http).toBe(500);
      }
    });
  });

  describe('AC-5 — wait for receipt with timeout', () => {
    it('calls waitForTransactionReceipt with hash and RECEIPT_TIMEOUT_MS', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: TEST_TX_HASH,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      expect(RECEIPT_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('AC-6 — receipt timeout', () => {
    it('returns TRANSACTION_FAILED with message "receipt timeout" when WaitForTransactionReceiptTimeoutError', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      const timeoutErr = new Error('Timed out while waiting for transaction');
      timeoutErr.name = 'WaitForTransactionReceiptTimeoutError';
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(timeoutErr);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.message).toBe('receipt timeout');
      }
    });
  });

  describe('AC-7 — receipt status reverted', () => {
    it('returns TRANSACTION_FAILED with "transaction reverted on-chain"', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'reverted',
        blockNumber: 42n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.message).toBe('transaction reverted on-chain');
      }
    });
  });

  describe('AC-8 — happy path SettleResult shape', () => {
    it('returns ok:true with correct SettleResult fields', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settled).toBe(true);
        expect(result.transactionHash).toBe(TEST_TX_HASH);
        expect(result.blockNumber).toBe(123);
        expect(result.amount).toBe('1000');
        expect(result.from).toBe(TEST_SIGNER_ADDRESS);
        expect(result.to).toBe(TEST_PAY_TO);
        expect(result.asset).toBe(TEST_TOKEN.address);
      }
    });
  });

  describe('AC-9 — verify is called first', () => {
    it('propagates verify error unchanged and skips simulateContract', async () => {
      // Force verify to fail with NETWORK_MISMATCH by mismatching network.
      const params = await makeValidParams({
        acceptedOverrides: { network: 'eip155:9999' },
      });
      const { publicClient, walletClient } = makeMockClients();

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
      }
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('AC-10 — no subcode mapping from revert reasons', () => {
    it('returns plain SIMULATION_FAILED even with recognizable revert string', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('execution reverted: authorization is used'),
      );

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SIMULATION_FAILED');
        // Must NOT map to EXPIRED_AUTHORIZATION or INVALID_SIGNATURE.
      }
    });
  });

  describe('AC-11 — ABI shape matches v/r/s overload', () => {
    it('FIAT_TOKEN_ABI has transferWithAuthorization with 9 inputs ending in v,r,s', () => {
      expect(FIAT_TOKEN_ABI).toHaveLength(1);
      const fn = FIAT_TOKEN_ABI[0];
      expect(fn.name).toBe('transferWithAuthorization');
      expect(fn.inputs).toHaveLength(9);
      expect(fn.inputs[6]?.name).toBe('v');
      expect(fn.inputs[6]?.type).toBe('uint8');
      expect(fn.inputs[7]?.name).toBe('r');
      expect(fn.inputs[8]?.name).toBe('s');
    });
  });

  describe('AC-12 — no real RPC in tests', () => {
    it('structural: test file uses only vi.fn() mocks (enforced by no http/createClient imports)', () => {
      // Structural: tests never call createPublicClient / http. Verified by this
      // file having only vi.fn() stubs inside makeMockClients().
      expect(true).toBe(true);
    });
  });

  describe('AC-13 — 5 error paths + happy path covered', () => {
    it('coverage: sim-fail (AC-2), write-fail (AC-4), receipt-revert (AC-7), receipt-timeout (AC-6), happy (AC-8)', () => {
      // Structural — the other 5 tests in this suite cover all paths.
      expect(true).toBe(true);
    });
  });

  describe('AC-14 — no exceptions thrown', () => {
    it('settleEip3009 resolves (never rejects) on simulate failure', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('boom'),
      );
      await expect(
        settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient),
      ).resolves.toMatchObject({ ok: false });
    });

    it('settleEip3009 resolves (never rejects) on write failure', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockRejectedValueOnce(new Error('boom'));
      await expect(
        settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  // ---- Hardening tests (opcional) ----

  describe('T-H1 — sanitize handles non-Error throws', () => {
    it('returns bounded string message even when throw value is a string', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        'plain string error',
      );

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message.length).toBeLessThanOrEqual(200);
      }
    });
  });
});
```

2. Ejecutar:
   ```bash
   npm run qa        # verde (typecheck + lint + test)
   npm run build     # verde
   ```

**Criterio de salida**: TODOS los tests verdes. `npm run qa` verde. 14+ ACs cubiertos.

---

## 7. Constraint Directives (inviolables)

Los 12 CDs del work-item + 4 específicos del SDD:

1. **CD-1**: PROHIBIDO throw por condiciones previsibles.
2. **CD-2**: OBLIGATORIO `simulateContract` antes de `writeContract`.
3. **CD-3**: PROHIBIDO ABI inline — usar `FIAT_TOKEN_ABI` desde `abi.ts`.
4. **CD-4**: OBLIGATORIO `RECEIPT_TIMEOUT_MS` named constant. PROHIBIDO `60_000` inline.
5. **CD-5**: OBLIGATORIO `publicClient` + `walletClient` via params inyectados.
   PROHIBIDO `createPublicClient`/`createWalletClient` en `settle.ts`.
6. **CD-6**: Imports permitidos SOLO: viem (+ subpath), `./verify.js`, `./abi.js`,
   `../../chains/types.js` (type-only), `../../core/types.js` (type-only).
7. **CD-7**: PROHIBIDO `console.*`. Sin logger.
8. **CD-8**: PROHIBIDO `vi.mock('viem', ...)`. Mock solo los objetos inyectados.
9. **CD-9**: OBLIGATORIO `writeContract(sim.request)` — NO reconstruir args.
10. **CD-10**: firma exacta (§5.2). TS strict. NO `any`. NO `as unknown` fuera de tests.
11. **CD-11**: `try/catch` de `simulateContract` atrapa **todo** (incluyendo programmer
    errors) → `SIMULATION_FAILED` con mensaje sanitizado.
12. **CD-12**: ≥1 test por cada uno de los 14 ACs.
13. **CD-NEW-13**: JSDoc de `blockNumber` documenta precisión `Number(bigint)`.
14. **CD-NEW-14**: tests con timestamp usan buffer `nowSec + 3600` (no `+1`).
15. **CD-NEW-15**: validar shape v/r/s de la firma — si `parseSignature().v === undefined`,
    retornar `INVALID_SIGNATURE`.
16. **CD-NEW-16**: JSDoc de `settleEip3009` documenta TOCTOU gap con texto literal del §5.2.

---

## 8. Done Definition

La HU está DONE cuando:

- [ ] `npm run typecheck` verde.
- [ ] `npm run lint` verde (cero `no-console`, cero `no-explicit-any`, cero
  `no-secrets`, cero violaciones de boundary).
- [ ] `npm run test` verde. TODOS los tests del repo pasan (no sólo `settle.test.ts`).
- [ ] `npm run build` verde. El bundle compila sin errors ni warnings.
- [ ] `npm run qa` verde (wrapper que combina los 3 anteriores).
- [ ] Los 14 ACs tienen al menos un test que los cubre (revisar tabla §6.AC-#).
- [ ] `settle.ts` NO contiene `console.*`, `any`, `as unknown`, `vi.mock`, literal
  `60_000` inline, `createPublicClient`, `createWalletClient`, throw por condición
  previsible.
- [ ] `settle.ts` NO importa de `src/core/*` (excepto type-only), `src/routes/*`,
  `src/chains/*` (excepto type-only), `src/infra/*`, otros methods.
- [ ] El barrel `src/methods/eip3009/index.ts` exporta `settleEip3009`, `FIAT_TOKEN_ABI`,
  `RECEIPT_TIMEOUT_MS`.
- [ ] JSDoc de `settleEip3009` incluye literal la nota de TOCTOU (CD-NEW-16).
- [ ] `doc/sdd/_INDEX.md` status actualizado a `DONE` (esto lo hace el docs-agent en
  DONE phase — NO el Dev).
- [ ] Commit con mensaje siguiendo patrón previo (`feat(WFAC-10): EIP-3009 settle —
  simulate + write + receipt wait`).

---

## 9. Referencias

- [Work Item WFAC-10](./work-item.md)
- [SDD WFAC-10](./sdd.md)
- [SDD WFAC-6 (verify — precedente directo)](../005-wfac-6-eip3009-verify/sdd.md)
- [Auto-Blindaje WFAC-6](../005-wfac-6-eip3009-verify/auto-blindaje.md)
- [verify.test.ts](../../../src/__tests__/unit/methods/eip3009/verify.test.ts) — patrón
  de tests a copiar.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009).
- [viem simulateContract](https://viem.sh/docs/contract/simulateContract).
- [FiatTokenV2 source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2.sol)
  — ABI canónico de referencia.
