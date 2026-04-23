# Story File — WFAC-6 EIP-3009 Verify Logic

> **Este archivo es autocontenido.** El Dev NO necesita leer work-item ni SDD para
> implementar esta HU. Todo lo que necesita está acá.
>
> **Status**: SPEC_APPROVED (pending humano — no arrancar F3 hasta que el humano escriba
> literal `SPEC_APPROVED`).
> **Branch**: `feat/005-wfac-6-eip3009-verify` desde `main@00887c4`.
> **Fecha generación**: 2026-04-22.
> **Agente**: nexus-architect (F2.5).
> **Proyecto**: wasiai-facilitator (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`).
> **Jira**: https://ferrosasfp.atlassian.net/browse/WFAC-6.
> **SDD**: `doc/sdd/005-wfac-6-eip3009-verify/sdd.md` (referencia — NO obligatoria para el Dev).

---

## 0. Contract con el Dev

Este documento es un contrato ejecutable entre el Architect (autor) y el Dev (F3).
Reglas inviolables:

1. **Un camino oficial único**. Todo lo que aparece en §3/§4/§5/§7 es el camino correcto.
   Si creés que hay una "mejor forma" no documentada: parar y escalar al humano.
2. **No hay código que adivinar**. Firmas, shapes, decisiones, orden de validación —
   todos fijados. El Dev escribe el **cuerpo** de funciones cuyas interfaces están
   especificadas.
3. **Waves secuenciales**. W0 → W1 → W2 → W3. No salteés waves.
4. **16 CDs inviolables** (§9). Cada violación se marca BLOQUEANTE en AR/CR.
5. **12 ACs + 8 hardening + 7 domain tests = 27 tests mínimos** (§8). La HU no está
   DONE hasta que todos los tests pasan + `npm run qa` verde + `npm run build` verde.
6. **Sin `console.*` en `src/`**. Esta HU NO recibe logger — el caller logea el Result.
7. **Node_modules read-first**: ANTES de codear W1, leer
   `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` +
   `node_modules/viem/_types/accounts/utils/signTypedData.d.ts` para verificar firmas.
   Paths en §10.
8. **Cero `any`, cero `as unknown as X`, cero `throw` por condiciones previsibles**.
   El único `throw` permitido viene de dentro de un `try { ... }` rodeando
   `recoverTypedDataAddress`, y ese throw lo captura el `catch` adyacente (ver §5.4).
9. **viem exclusivo**. PROHIBIDO ethers, @noble, web3.js. Ver §9 CD-4.
10. **Boundary estricto**. `src/methods/eip3009/` importa:
    - Runtime: viem, zod, ABIs propias.
    - Type-only: `../../chains/types.js` + `../../core/types.js` (solo primitivos
      — ver §9 CD-16).
    Cualquier otro import de `src/*` está PROHIBIDO.

Si encontrás ambigüedad no cubierta por este Story File: **NO IMPLEMENTAR**. Escalar.

---

## 1. Resumen Ejecutivo

**Qué se construye**: la función pura `verifyEip3009(params, token, chainId)` que:

1. Valida el shape del payload (Zod).
2. Valida pre-condiciones x402 (network, asset, amount, timestamp, receiver).
3. Recupera la address firmante via EIP-712 (viem).
4. Compara recovered vs claimed sender.
5. Retorna `AdapterResult<VerifyResult>` tipado.

Más los helpers puros: `buildEip3009Domain(token, chainId, accepted)`,
`EIP3009_TYPES` constant, Zod schemas locales.

Entregables:

- `src/methods/eip3009/abi.ts` (NEW) — `EIP3009_TYPES` + `EIP3009_PRIMARY_TYPE`.
- `src/methods/eip3009/schemas.ts` (NEW) — Zod schemas locales.
- `src/methods/eip3009/domain.ts` (NEW) — `buildEip3009Domain` puro.
- `src/methods/eip3009/verify.ts` (NEW) — función principal.
- `src/methods/eip3009/index.ts` (NEW) — barrel export.
- `src/__tests__/unit/methods/eip3009/domain.test.ts` (NEW) — ≥7 tests.
- `src/__tests__/unit/methods/eip3009/verify.test.ts` (NEW) — ≥20 tests (12 ACs + 8
  hardening).
- `npm run qa` verde, `npm run build` verde.

**Por qué importa**: `verifyEip3009` es la carga crítica del endpoint `POST /verify` y
la primera mitad del path de `POST /settle`. Una firma verificada incorrectamente =
settlement ilegítimo = pérdida de fondos. Una firma rechazada legítima = falla UX del
cliente x402. Precisión criptográfica obligatoria.

**Qué NO hace esta HU**:

- NO consulta RPC (no `balanceOf`, no `eth_call`, no `getBlock`).
- NO persiste nada (no Redis, no Supabase).
- NO ejecuta la tx on-chain (WFAC-7).
- NO arma el dispatcher `core/verify.ts` (WFAC-20).
- NO normaliza EIP-2098 compact signatures (WFAC-13).
- NO verifica unicidad de nonce (esa check vive en `transferWithAuthorization` on-chain
  + Redis idempotency en WFAC-7/WFAC-21).
- NO modifica `src/chains/kite.ts` (lo hará WFAC-10 cuando llame a `verifyEip3009`).

---

## 2. Prerequisites (antes de W0)

Ejecutar en orden desde `/home/ferdev/.openclaw/workspace/wasiai-facilitator/`:

```bash
# 1. Verificar branch base
git status                        # debe estar clean
git rev-parse HEAD                # si no estás en main@00887c4, volver: git checkout main && git pull

# 2. Crear/checkout branch de la HU
git checkout -b feat/005-wfac-6-eip3009-verify
# (si ya existe: git checkout feat/005-wfac-6-eip3009-verify && git rebase main)

# 3. Verificar deps instaladas
ls node_modules/viem/             # debe existir
cat node_modules/viem/package.json | grep '"version"'   # debe decir 2.47.6 o 2.48.x
ls node_modules/viem/accounts/    # debe existir (subpath)
ls node_modules/zod/              # debe existir

# 4. Verificar que los archivos a modificar compilan limpios en main
npm run typecheck                 # debe pasar
npm run test                      # debe pasar (tests existentes)

# 5. Verificar que src/methods/eip3009/ está vacío (solo .gitkeep)
ls -la src/methods/eip3009/       # solo .gitkeep
```

Si cualquiera de los pasos falla, **parar** y escalar al humano. No empezar W0 sobre
un baseline roto.

---

## 3. Archivos afectados (Scope IN)

| Archivo | Acción | Wave | Líneas aprox | Notas |
|---------|--------|------|--------------|-------|
| `src/methods/eip3009/abi.ts` | CREATE | W0 | ~30 | `EIP3009_TYPES` + `EIP3009_PRIMARY_TYPE` con `as const` |
| `src/methods/eip3009/schemas.ts` | CREATE | W0 | ~45 | Zod schemas locales (address, bytes32, uint256, authorization) |
| `src/methods/eip3009/index.ts` | CREATE | W0 + W1 + W2 (progresivo) | ~10 | Barrel — re-exports los públicos de cada archivo |
| `src/methods/eip3009/domain.ts` | CREATE | W1 | ~40 | `buildEip3009Domain` puro + JSDoc |
| `src/methods/eip3009/verify.ts` | CREATE | W2 | ~110 | Función principal + helper `err` interno |
| `src/__tests__/unit/methods/eip3009/domain.test.ts` | CREATE | W1 | ~80 | 7 tests |
| `src/__tests__/unit/methods/eip3009/verify.test.ts` | CREATE | W2 + W3 | ~400 | 20+ tests (12 ACs + 8 hardening) |

**Archivos PROHIBIDOS de modificar** (fuera de scope):

- `src/core/*` — no crear archivos nuevos. Solo imports TYPE-ONLY de `core/types.ts`.
- `src/chains/*` — no modificar adapters. WFAC-10 integra el método.
- `src/chains/registry.ts` — no se toca.
- `src/routes/*` — no existe aún; no crear.
- `src/infra/*` — no se toca (el método no necesita Redis/logger/etc).
- `src/app.ts`, `src/index.ts` — no se tocan.
- `package.json` — viem+zod ya instalados; no agregar deps nuevas.
- `tsconfig.json`, `vitest.config.ts`, `eslint.config.js` — no se tocan.
- `src/methods/permit2/`, `src/methods/erc7710/` — no existen, no crear.

---

## 4. Anti-Hallucination Checklist (específica de esta HU)

Antes de escribir CUALQUIER línea de código, confirmá lo siguiente:

### 4.1. Leíste y entendiste estos archivos en `node_modules/`

- [ ] `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` y
  confirmaste:
  - Firma: `recoverTypedDataAddress<typedData, primaryType>(parameters:
    RecoverTypedDataAddressParameters<typedData, primaryType>): Promise<Address>`.
  - `RecoverTypedDataAddressParameters` = `TypedDataDefinition<...> & { signature: Hex |
    ByteArray | Signature }`.
  - Retorna `Promise<Address>` directamente (no un Result, no un boolean — la Address).

- [ ] `node_modules/viem/_types/utils/address/isAddressEqual.d.ts` y confirmaste:
  - Firma: `isAddressEqual(a: Address, b: Address): boolean`.
  - Case-insensitive.
  - Throws `InvalidAddressError` si los inputs no son Address válidas — pero nuestro
    Zod schema + tipos ya lo garantizan.

- [ ] `node_modules/viem/_types/utils/address/getAddress.d.ts` y confirmaste:
  - Firma: `getAddress(address: string, chainId?: number): Address`.
  - Devuelve checksummed EIP-55.
  - Nosotros NO pasamos chainId (checksumming estándar, no EIP-1191).

- [ ] `node_modules/viem/_types/accounts/privateKeyToAccount.d.ts` y confirmaste:
  - Firma: `privateKeyToAccount(privateKey: Hex, options?): PrivateKeyAccount`.
  - El `PrivateKeyAccount` expone `.signTypedData(parameters)`.

- [ ] `node_modules/viem/_types/accounts/utils/signTypedData.d.ts` y confirmaste:
  - Firma: `signTypedData({ privateKey, domain, types, primaryType, message }):
    Promise<Hex>`.
  - Retorna la hex signature `0x...` (130 chars + `0x` prefix).

- [ ] `node_modules/abitype/dist/types/abi.d.ts` (lines 121-127) y confirmaste el shape
  de `TypedDataDomain`:
  ```ts
  TypedDataDomain = {
    chainId?: number | bigint | undefined;
    name?: string | undefined;
    salt?: ...;
    verifyingContract?: Address | undefined;
    version?: string | undefined;
  }
  ```
  Todos los campos son optional — nuestro builder llena 4, omite `salt`.

### 4.2. Leíste y entendiste estos archivos del proyecto

- [ ] `src/chains/types.ts` (153 líneas) — `EIP3009Token`, `VerifyParams`,
  `VerifyResult`, `AdapterResult<T>`. En particular:
  - `VerifyParams.payload.signature: 0x${string}` (branded hex).
  - `VerifyParams.payload.authorization.value/validAfter/validBefore: string`
    (decimal uint256 strings, no bigint).
  - `VerifyParams.payload.authorization.nonce: 0x${string}`.
  - `VerifyResult` tiene exactamente 7 campos: `verified: true`, `client`, `amount`,
    `asset`, `network`, `payTo`, `expiresAt: number`.

- [ ] `src/core/types.ts` (66 líneas) — `Address = 0x${string}`, `ChainId` (branded
  number con `asChainId(n)`), `X402ErrorCode` (union de 10 códigos), `Result<T>`
  discriminated union.

- [ ] `src/__tests__/unit/chain-adapter.test.ts` — para entender el pattern de tests
  del proyecto (vitest `describe`/`it`/`expect`, `beforeEach` para reset, narrowing
  con `if (!result.ok) { ... }`).

- [ ] `doc/sdd/005-wfac-6-eip3009-verify/sdd.md` §5 (DTs A-J) — si hay alguna duda de
  por qué una decisión se tomó así.

### 4.3. Confirmaste que los siguientes archivos NO existen todavía

- [ ] `src/methods/eip3009/abi.ts` → vas a crearlo.
- [ ] `src/methods/eip3009/schemas.ts` → vas a crearlo.
- [ ] `src/methods/eip3009/domain.ts` → vas a crearlo.
- [ ] `src/methods/eip3009/verify.ts` → vas a crearlo.
- [ ] `src/methods/eip3009/index.ts` → vas a crearlo.
- [ ] `src/__tests__/unit/methods/eip3009/` → directorio NO existe, creálo junto con el
  primer test.

### 4.4. Rules inviolables de implementación

- [ ] NO vas a importar `src/chains/registry.ts`, `src/routes/*`, `src/middleware/*`,
  `src/infra/*`, `src/methods/permit2/*`, `src/methods/erc7710/*`.
- [ ] NO vas a hacer runtime imports desde `src/core/*`. SOLO type-only imports desde
  `src/core/types.js`, y solo para `Address`, `ChainId`, `X402ErrorCode`, `Result`.
- [ ] NO vas a usar `any`. Cero. Ni en tests.
- [ ] NO vas a usar `as unknown as X` en código productivo.
- [ ] NO vas a usar `.toLowerCase()` para comparar addresses. Siempre `isAddressEqual`.
- [ ] NO vas a usar `===` para comparar Addresses. Siempre `isAddressEqual`.
- [ ] NO vas a llamar `console.log`, `console.error`, ni ningún Pino/logger. La función
  es silenciosa — el caller decide qué logear del Result.
- [ ] NO vas a lanzar exceptions por condiciones previsibles. Retornás Result. El
  único try/catch permitido rodea `recoverTypedDataAddress`.
- [ ] NO vas a hardcodear: contract addresses, token names, chainIds, RPC URLs,
  magic strings de error codes (los códigos son los 10 del `X402ErrorCode` literal
  union — TypeScript te fuerza).
- [ ] NO vas a importar viem como default. Usá imports named: `import { xxx } from
  'viem'`.
- [ ] NO vas a indexar `authorization[varName]` con string variable (ESLint
  `security/detect-object-injection` + `--max-warnings 0`). Leé cada campo por su key
  literal: `authorization.from`, `authorization.to`, etc.
- [ ] NO vas a copiar fixtures de firma de internet. TODAS las firmas de test se
  generan con `privateKeyToAccount(TEST_PRIVATE_KEY).signTypedData(...)` en el setup
  del test.
- [ ] NO vas a usar `new Date()` en `verify.ts` — usá `Date.now() / 1000` (entero con
  `Math.floor`).
- [ ] NO vas a instalar deps nuevas. viem + zod + vitest ya están.

---

## 5. Shapes exactas

### 5.1. `src/methods/eip3009/abi.ts` (W0)

```ts
/**
 * EIP-3009 TransferWithAuthorization typed data definition.
 *
 * This array is consumed by:
 *   - viem's recoverTypedDataAddress (runtime, verify.ts)
 *   - viem's signTypedData (test fixtures via privateKeyToAccount)
 *
 * Source of truth: EIP-3009 (https://eips.ethereum.org/EIPS/eip-3009).
 *
 * CRITICAL: `as const` is required so viem can infer the exact literal type.
 * Without it, the inferred type widens to `string` and viem will reject the
 * parameter at runtime with TypedDataInvalid.
 */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const EIP3009_PRIMARY_TYPE = 'TransferWithAuthorization' as const;
```

### 5.2. `src/methods/eip3009/schemas.ts` (W0)

```ts
/**
 * Local Zod schemas for EIP-3009 method.
 *
 * These validate SHAPE invariants specific to EIP-3009:
 *   - nonce: 0x + 64 hex chars (bytes32)
 *   - addresses: 0x + 40 hex chars (shape only, NOT checksum)
 *   - uint256 strings: decimal digits, <= 2^256-1
 *
 * The root VerifyParams schema lives in core/schemas.ts (to be created by
 * WFAC-20). This file intentionally stays method-local to respect OWNERS
 * boundaries.
 */

import { z } from 'zod';

/** 0x-prefixed 32-byte hex (bytes32 / nonce). */
export const Bytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'must be 0x-prefixed 32-byte hex');

/** 0x-prefixed 20-byte hex (address). Shape-only; does NOT validate checksum. */
export const AddressHexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'must be 0x-prefixed 20-byte hex');

/**
 * Decimal uint256 string.
 * - Regex: digits only, no leading + or -, no scientific notation.
 * - Refine: BigInt parseable AND within [0, 2^256-1].
 */
export const Uint256StringSchema = z
  .string()
  .regex(/^\d+$/u, 'must be a decimal uint256 string')
  .refine((s) => {
    try {
      const n = BigInt(s);
      return n >= 0n && n <= 2n ** 256n - 1n;
    } catch {
      return false;
    }
  }, 'out of uint256 range');

/** EIP-3009 authorization payload. */
export const Eip3009AuthorizationSchema = z.object({
  from: AddressHexSchema,
  to: AddressHexSchema,
  value: Uint256StringSchema,
  validAfter: Uint256StringSchema,
  validBefore: Uint256StringSchema,
  nonce: Bytes32HexSchema,
});

export type Eip3009Authorization = z.infer<typeof Eip3009AuthorizationSchema>;
```

### 5.3. `src/methods/eip3009/domain.ts` (W1)

```ts
/**
 * Pure builder for the EIP-712 domain used by EIP-3009 TransferWithAuthorization.
 *
 * Resolution precedence (see SDD §5 DT-B):
 *   name:    token.eip712Name ?? accepted.extra.name ?? token.name
 *   version: token.eip712Version ?? accepted.extra.version ?? '1'
 *   chainId: Number(chainId)  — numeric, NOT the eip155:<id> string
 *   verifyingContract: token.address
 *
 * No side effects. No I/O. No async. No logger.
 */

import type { TypedDataDomain } from 'viem';
import type { EIP3009Token, VerifyParams } from '../../chains/types.js';
import type { ChainId } from '../../core/types.js';

export function buildEip3009Domain(
  token: EIP3009Token,
  chainId: ChainId,
  accepted: VerifyParams['accepted'],
): TypedDataDomain {
  return {
    name: token.eip712Name ?? accepted.extra.name ?? token.name,
    version: token.eip712Version ?? accepted.extra.version ?? '1',
    chainId: Number(chainId),
    verifyingContract: token.address,
  };
}
```

### 5.4. `src/methods/eip3009/verify.ts` (W2)

**Firma no-negociable**:

```ts
export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>>
```

**Cuerpo completo (el Dev escribe exactamente esto, solo ajusta mensajes si es
necesario — los códigos son inmutables)**:

```ts
/**
 * EIP-3009 verify — off-chain validation of a TransferWithAuthorization.
 *
 * Pure async function. No RPC calls. No side effects. No logger.
 *
 * Validates (in order, fail-fast):
 *   1. Zod shape of payload.authorization (nonce bytes32, uint256 strings).
 *   2. Network match: accepted.network === 'eip155:<chainId>'.
 *   3. Asset match: accepted.asset isAddressEqual token.address.
 *   4. Amount: accepted.amount > 0 AND authorization.value >= accepted.amount.
 *   5. Receiver: authorization.to isAddressEqual accepted.payTo.
 *   6. Timestamp window: validAfter <= now < validBefore.
 *   7. EIP-712 recover: signature -> address; must equal authorization.from.
 *
 * The caller MUST ensure nonce uniqueness via the chain adapter before
 * settlement — this function does NOT check replay protection.
 */

import { recoverTypedDataAddress, isAddressEqual, getAddress } from 'viem';
import type { Address } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  VerifyParams,
  VerifyResult,
} from '../../chains/types.js';
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { Eip3009AuthorizationSchema } from './schemas.js';
import { buildEip3009Domain } from './domain.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';

function err(
  code: X402ErrorCode,
  message: string,
  http: number,
): AdapterResult<VerifyResult> {
  return { ok: false, error: { code, message, http } };
}

export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>> {
  // 1. Shape validation (Zod)
  const authParse = Eip3009AuthorizationSchema.safeParse(params.payload.authorization);
  if (!authParse.success) {
    return err('INVALID_SIGNATURE', 'Authorization payload malformed', 401);
  }
  const authorization = authParse.data;

  // 2. Network match (AC-8)
  const canonicalNetwork = `eip155:${Number(chainId)}`;
  if (params.accepted.network !== canonicalNetwork) {
    return err('NETWORK_MISMATCH', 'Network does not match chain', 400);
  }

  // 3. Asset match (AC-11, defense-in-depth)
  if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
    return err('NETWORK_MISMATCH', 'Asset not found in chain token registry', 400);
  }

  // 4. Amount validation (AC-6, AC-7)
  const acceptedAmount = BigInt(params.accepted.amount);
  if (acceptedAmount === 0n) {
    return err('INVALID_AMOUNT', 'Accepted amount must be greater than zero', 400);
  }
  if (BigInt(authorization.value) < acceptedAmount) {
    return err('INVALID_AMOUNT', 'Authorized value is below accepted amount', 400);
  }

  // 5. Receiver match (AC-9)
  if (!isAddressEqual(authorization.to as Address, params.accepted.payTo as Address)) {
    return err('INVALID_RECEIVER', 'Receiver does not match payTo', 400);
  }

  // 6. Timestamp window (AC-4, AC-5)
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(authorization.validBefore) <= nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization expired', 400);
  }
  if (Number(authorization.validAfter) > nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization not yet valid', 400);
  }

  // 7. Build domain + recover (AC-10)
  const domain = buildEip3009Domain(token, chainId, params.accepted);
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: params.payload.signature,
    });
  } catch {
    // AC-3: malformed signature bytes / invalid v-value -> catch and return.
    // We do NOT inspect err.message — viem's error messages are implementation-
    // defined and may change between patch releases.
    return err('INVALID_SIGNATURE', 'Failed to recover typed data address', 401);
  }

  // 8. Recovered vs claimed (AC-2)
  if (!isAddressEqual(recovered, authorization.from as Address)) {
    return err('INVALID_SIGNATURE', 'Recovered address does not match sender', 401);
  }

  // 9. Success (AC-1, AC-12)
  return {
    ok: true,
    verified: true,
    client: getAddress(recovered),
    amount: params.accepted.amount,
    asset: token.address,
    network: params.accepted.network,
    payTo: getAddress(params.accepted.payTo),
    expiresAt: Number(authorization.validBefore),
  };
}
```

### 5.5. `src/methods/eip3009/index.ts` (W0 + W1 + W2)

Actualizar incrementalmente por wave. Estado final (post W2):

```ts
export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';
export {
  AddressHexSchema,
  Bytes32HexSchema,
  Eip3009AuthorizationSchema,
  Uint256StringSchema,
  type Eip3009Authorization,
} from './schemas.js';
export { buildEip3009Domain } from './domain.js';
export { verifyEip3009 } from './verify.js';
```

### 5.6. Test helper shared (arriba de `verify.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, TypedDataDomain } from 'viem';
import { verifyEip3009 } from '../../../../methods/eip3009/verify.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

// Hardhat account #0 — public knowledge, documented in Hardhat defaults.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

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

/**
 * Build a valid VerifyParams signed by TEST_SIGNER_ADDRESS.
 * Overrides mutate the result before signing (to test error branches with
 * a still-valid signature over the mutated message), OR after signing
 * (to test signature/domain mismatches).
 */
async function makeValidParams(opts?: {
  nowSec?: number;
  messageOverrides?: Partial<AuthMessage>;
  acceptedOverrides?: Partial<VerifyParams['accepted']>;
  domainOverrides?: Partial<TypedDataDomain>;
  signatureOverride?: `0x${string}`;
}): Promise<VerifyParams> {
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
  const baseDomain = buildEip3009Domain(
    TEST_TOKEN,
    TEST_CHAIN_ID,
    { extra: { assetTransferMethod: 'eip3009' } } as VerifyParams['accepted'],
  );
  const domain: TypedDataDomain = { ...baseDomain, ...opts?.domainOverrides };
  const signature = opts?.signatureOverride ?? (await signFixture(domain, baseMessage));

  return {
    x402Version: 2,
    resource: { url: 'https://example.com', description: 't', mimeType: 'application/json' },
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
```

**NOTA**: el helper `makeValidParams` es quirúrgico — cada test pasa solo los
overrides que necesita. Esto reduce repetición masiva y hace que cada test sea 3-5
líneas de setup.

---

## 6. Waves detalladas (paso a paso)

### W0 — Constants + Schemas + Barrel Stub

Archivos a crear:

1. `src/methods/eip3009/abi.ts` (shape §5.1).
2. `src/methods/eip3009/schemas.ts` (shape §5.2).
3. `src/methods/eip3009/index.ts` (solo exports de abi + schemas; domain y verify se
   agregan en waves siguientes).

Gate de W0:

```bash
npm run typecheck   # pasa
npm run lint        # pasa
# NO hay tests nuevos aún — los tests reales llegan en W1
npm run test        # pasa (tests existentes, nada nuevo)
npm run build       # pasa
```

### W1 — Domain builder + tests

Archivos a crear:

1. `src/methods/eip3009/domain.ts` (shape §5.3).
2. `src/methods/eip3009/index.ts` — actualizar para incluir `buildEip3009Domain`.
3. `src/__tests__/unit/methods/eip3009/domain.test.ts`.

Tests de W1 (7 obligatorios):

```ts
describe('buildEip3009Domain', () => {
  const token = {
    address: '0x00000000000000000000000000000000000000ff' as const,
    symbol: 'TEST',
    decimals: 6,
    name: 'Fallback Token Name',
  };
  const accepted = (extra?: Record<string, string>) =>
    ({
      scheme: 'exact',
      network: 'eip155:2368',
      amount: '1',
      asset: token.address,
      payTo: '0x1111111111111111111111111111111111111111',
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009', ...extra },
    }) as VerifyParams['accepted'];

  it('DT-B-1: uses token.eip712Name when present', () => {
    const t = { ...token, eip712Name: 'Canonical Name' };
    const d = buildEip3009Domain(t, asChainId(2368), accepted({ name: 'ignored' }));
    expect(d.name).toBe('Canonical Name');
  });

  it('DT-B-2: falls back to accepted.extra.name when eip712Name absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted({ name: 'From Extra' }));
    expect(d.name).toBe('From Extra');
  });

  it('DT-B-3: falls back to token.name when both absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.name).toBe('Fallback Token Name');
  });

  it('DT-B-4: version defaults to "1" when all absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.version).toBe('1');
  });

  it('DT-B-5: chainId is numeric (not eip155: string)', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.chainId).toBe(2368);
    expect(typeof d.chainId).toBe('number');
  });

  it('DT-B-6: verifyingContract is token.address verbatim', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.verifyingContract).toBe(token.address);
  });

  it('DT-B-7: salt is NOT included (EIP-3009 canonical)', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d).not.toHaveProperty('salt');
  });
});
```

Gate de W1:

```bash
npm run typecheck   # pasa
npm run test        # 7 tests nuevos pasan
npm run qa          # todo verde
npm run build       # pasa
```

### W2 — verifyEip3009 + tests happy + error paths (ACs 1, 2, 3, 6, 7, 8, 9, 11, 12)

Archivos a crear:

1. `src/methods/eip3009/verify.ts` (shape §5.4).
2. `src/methods/eip3009/index.ts` — actualizar para incluir `verifyEip3009`.
3. `src/__tests__/unit/methods/eip3009/verify.test.ts` — helpers §5.6 + los siguientes
   tests:

Tests de W2 (9 obligatorios: AC-1, 2, 3, 6, 7, 8, 9, 11, 12):

```ts
describe('verifyEip3009', () => {
  describe('AC-1 — happy path', () => {
    it('returns ok: true with client === getAddress(recovered)', async () => {
      const params = await makeValidParams();
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verified).toBe(true);
        expect(result.client).toBe(TEST_SIGNER_ADDRESS);
        expect(result.amount).toBe('1000');
        expect(result.network).toBe('eip155:2368');
      }
    });
  });

  describe('AC-2 — recovered does not match from', () => {
    it('returns INVALID_SIGNATURE when authorization.from is different from signer', async () => {
      const params = await makeValidParams({
        messageOverrides: {
          from: '0x2222222222222222222222222222222222222222' as Address,
        },
      });
      // mismatch: signature was generated over a message with from=TEST_SIGNER
      // but authorization.from was overridden to 0x2222. Actually, since
      // messageOverrides mutates before signing, we get a signature that
      // recovers to TEST_SIGNER but authorization.from claims 0x2222.
      // IMPORTANT: makeValidParams also fills authorization.from from
      // baseMessage.from, so this test needs a post-sign override — see
      // variant below.

      // Proper setup: sign with original from, then override ONLY authorization.from.
      const validParams = await makeValidParams();
      const tamperedParams: VerifyParams = {
        ...validParams,
        payload: {
          ...validParams.payload,
          authorization: {
            ...validParams.payload.authorization,
            from: '0x2222222222222222222222222222222222222222' as Address,
          },
        },
      };
      const result = await verifyEip3009(tamperedParams, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });
  });

  describe('AC-3 — recoverTypedDataAddress throws', () => {
    it('catches and returns INVALID_SIGNATURE on malformed signature bytes', async () => {
      // A 65-byte hex that has shape-valid length but bytes that make secp256k1
      // recovery fail (e.g., v=0x00 with r=s=0 — impossible point).
      const params = await makeValidParams({
        signatureOverride: `0x${'00'.repeat(65)}` as `0x${string}`,
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });
  });

  describe('AC-6 — value < amount', () => {
    it('returns INVALID_AMOUNT when authorized value below accepted amount', async () => {
      const params = await makeValidParams({
        messageOverrides: { value: 99n },
        acceptedOverrides: { amount: '100' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_AMOUNT');
    });
  });

  describe('AC-7 — accepted.amount === 0', () => {
    it('returns INVALID_AMOUNT when accepted.amount is "0"', async () => {
      const params = await makeValidParams({ acceptedOverrides: { amount: '0' } });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_AMOUNT');
    });
  });

  describe('AC-8 — network mismatch', () => {
    it('returns NETWORK_MISMATCH when accepted.network does not match chainId', async () => {
      const params = await makeValidParams({ acceptedOverrides: { network: 'eip155:999' } });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NETWORK_MISMATCH');
    });
  });

  describe('AC-9 — receiver mismatch', () => {
    it('returns INVALID_RECEIVER when authorization.to !== accepted.payTo', async () => {
      // Override authorization.to AFTER signing (so signature is still valid
      // over the original message where to === payTo, but authorization.to
      // claims a different value).
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        accepted: {
          ...valid.accepted,
          payTo: '0x3333333333333333333333333333333333333333' as Address,
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_RECEIVER');
    });
  });

  describe('AC-11 — asset not in token registry', () => {
    it('returns NETWORK_MISMATCH when accepted.asset does not match token.address', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { asset: `0x${'ff'.repeat(20)}` },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NETWORK_MISMATCH');
    });
  });

  describe('AC-12 — output contract exact shape', () => {
    it('returns VerifyResult with expected fields on happy path', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({ nowSec });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.expiresAt).toBe(Number(params.payload.authorization.validBefore));
        expect(result.network).toBe(params.accepted.network);
        expect(result.asset).toBe(TEST_TOKEN.address);
        expect(result.amount).toBe(params.accepted.amount);
        // getAddress returns checksummed; TEST_SIGNER_ADDRESS in helper is already checksummed.
        expect(result.client).toBe(TEST_SIGNER_ADDRESS);
      }
    });
  });
});
```

Gate de W2:

```bash
npm run typecheck   # pasa
npm run test        # 7 W1 + 9 W2 = 16 tests pasan
npm run qa          # todo verde
```

### W3 — Edge cases (ACs 4, 5, 10) + hardening

Extender `verify.test.ts`:

```ts
describe('AC-4 — validBefore expired', () => {
  it('returns EXPIRED_AUTHORIZATION when validBefore <= now', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeValidParams({
      nowSec,
      messageOverrides: {
        validAfter: BigInt(nowSec - 3600),
        validBefore: BigInt(nowSec - 1), // just expired
      },
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
  });
});

describe('AC-5 — validAfter in the future', () => {
  it('returns EXPIRED_AUTHORIZATION when validAfter > now', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeValidParams({
      nowSec,
      messageOverrides: {
        validAfter: BigInt(nowSec + 3600), // starts in 1h
        validBefore: BigInt(nowSec + 7200),
      },
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
  });
});

describe('AC-10 — domain integrity', () => {
  it('verifies successfully when domain built from registry (happy path)', async () => {
    // Regression: AC-1 already proves this. Duplicate here for documentation.
    const params = await makeValidParams();
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(true);
  });

  it('fails when signature was generated against a different domain name (impostor domain)', async () => {
    // Sign with a domain whose name is NOT what the registry would produce.
    const valid = await makeValidParams({ domainOverrides: { name: 'Impostor Name' } });
    // Now validate with the registry-sourced domain (eip712Name = 'Test Token').
    // The recover will compute a different message hash → recovered address
    // will differ from TEST_SIGNER_ADDRESS → INVALID_SIGNATURE.
    const result = await verifyEip3009(valid, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });
});

// ── Hardening tests (non-AC but required by CD) ──

describe('T-H — hardening', () => {
  it('T-H1: nonce with 63 hex chars is rejected as INVALID_SIGNATURE', async () => {
    const valid = await makeValidParams();
    const tampered: VerifyParams = {
      ...valid,
      payload: {
        ...valid.payload,
        authorization: {
          ...valid.payload.authorization,
          nonce: `0x${'ab'.repeat(31)}c` as `0x${string}`, // 63 hex chars
        },
      },
    };
    const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  it('T-H2: nonce with non-hex chars is rejected as INVALID_SIGNATURE', async () => {
    const valid = await makeValidParams();
    const tampered: VerifyParams = {
      ...valid,
      payload: {
        ...valid.payload,
        authorization: {
          ...valid.payload.authorization,
          nonce: `0x${'ZZ'.repeat(32)}` as `0x${string}`, // non-hex
        },
      },
    };
    const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  it('T-H3: value === amount exactly is OK (boundary of AC-6)', async () => {
    const params = await makeValidParams({
      messageOverrides: { value: 100n },
      acceptedOverrides: { amount: '100' },
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(true);
  });

  it('T-H4: validAfter === nowSec is OK', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeValidParams({
      nowSec,
      messageOverrides: {
        validAfter: BigInt(nowSec),
        validBefore: BigInt(nowSec + 3600),
      },
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(true);
  });

  it('T-H5: validBefore === nowSec + 1 is OK', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeValidParams({
      nowSec,
      messageOverrides: {
        validAfter: BigInt(nowSec - 10),
        validBefore: BigInt(nowSec + 1),
      },
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(true);
  });

  it('T-H6: uint256 overflow in value is rejected as INVALID_SIGNATURE', async () => {
    const valid = await makeValidParams();
    const tooBig = '1'.repeat(79); // 79 digits > 2^256-1 (78 digits)
    const tampered: VerifyParams = {
      ...valid,
      payload: {
        ...valid.payload,
        authorization: {
          ...valid.payload.authorization,
          value: tooBig,
        },
      },
    };
    const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  it('T-H7: signature of wrong length is rejected as INVALID_SIGNATURE', async () => {
    const params = await makeValidParams({
      signatureOverride: `0x${'aa'.repeat(60)}` as `0x${string}`, // 60 bytes, not 65
    });
    const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  it('T-H8: two concurrent verify calls with different fixtures do not cross-talk', async () => {
    const p1 = await makeValidParams();
    const p2 = await makeValidParams({
      messageOverrides: { value: 2000n },
      acceptedOverrides: { amount: '2000' },
    });
    const [r1, r2] = await Promise.all([
      verifyEip3009(p1, TEST_TOKEN, TEST_CHAIN_ID),
      verifyEip3009(p2, TEST_TOKEN, TEST_CHAIN_ID),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.amount).toBe('1000');
    if (r2.ok) expect(r2.amount).toBe('2000');
  });
});
```

Gate de W3 (final):

```bash
npm run typecheck   # pasa
npm run lint        # pasa (0 warnings, 0 errors)
npm run test        # 7 (W1) + 9 (W2) + 11 (W3) = 27 tests pasan
npm run qa          # todo verde
npm run build       # pasa
```

---

## 7. Orden de validación (no-negociable)

Para cada request, el orden es fijo (documentado en SDD §5 DT-J):

1. Zod shape → `INVALID_SIGNATURE`
2. Network match → `NETWORK_MISMATCH`
3. Asset match (isAddressEqual vs token.address) → `NETWORK_MISMATCH`
4. Amount zero → `INVALID_AMOUNT`
5. Amount insufficient (value < amount) → `INVALID_AMOUNT`
6. Receiver match → `INVALID_RECEIVER`
7. Timestamp: expired → `EXPIRED_AUTHORIZATION`
8. Timestamp: not yet valid → `EXPIRED_AUTHORIZATION`
9. Domain build + recover (try/catch) → `INVALID_SIGNATURE`
10. Recovered vs claimed → `INVALID_SIGNATURE`
11. Success → Ok

El Dev NO debe reordenar sin aprobar con el humano. El orden actual minimiza costo
CPU (crypto es lo más caro y está al final).

---

## 8. Acceptance Criteria — test mapping

| AC | Test file | Test describe | Expected result |
|----|-----------|---------------|-----------------|
| AC-1 | verify.test.ts | `AC-1 — happy path` | `ok: true, verified: true, client === TEST_SIGNER_ADDRESS` |
| AC-2 | verify.test.ts | `AC-2 — recovered does not match from` | `error.code === 'INVALID_SIGNATURE'`, `http: 401` |
| AC-3 | verify.test.ts | `AC-3 — recoverTypedDataAddress throws` | `error.code === 'INVALID_SIGNATURE'`, `http: 401` |
| AC-4 | verify.test.ts | `AC-4 — validBefore expired` | `error.code === 'EXPIRED_AUTHORIZATION'`, `http: 400` |
| AC-5 | verify.test.ts | `AC-5 — validAfter in the future` | `error.code === 'EXPIRED_AUTHORIZATION'`, `http: 400` |
| AC-6 | verify.test.ts | `AC-6 — value < amount` | `error.code === 'INVALID_AMOUNT'`, `http: 400` |
| AC-7 | verify.test.ts | `AC-7 — accepted.amount === 0` | `error.code === 'INVALID_AMOUNT'`, `http: 400` |
| AC-8 | verify.test.ts | `AC-8 — network mismatch` | `error.code === 'NETWORK_MISMATCH'`, `http: 400` |
| AC-9 | verify.test.ts | `AC-9 — receiver mismatch` | `error.code === 'INVALID_RECEIVER'`, `http: 400` |
| AC-10 | verify.test.ts | `AC-10 — domain integrity` (2 tests) | happy path + impostor domain |
| AC-11 | verify.test.ts | `AC-11 — asset not in token registry` | `error.code === 'NETWORK_MISMATCH'`, `http: 400` |
| AC-12 | verify.test.ts | `AC-12 — output contract exact shape` | `expiresAt === Number(validBefore)`, `client` checksummed, `network === accepted.network` |

---

## 9. Constraint Directives (16 CDs)

### CDs heredados del work-item (1-13)

- **CD-1**: PROHIBIDO importar desde `src/core/*` (excepto type-only primitives via
  CD-16), `src/chains/registry.ts`, `src/routes/`, u otros métodos.
- **CD-2**: PROHIBIDO throw por condiciones previsibles. Todo es Result.
- **CD-3**: PROHIBIDO hardcodear name/version/chainId/contract address — todo viene
  de params.
- **CD-4**: OBLIGATORIO viem exclusivo. PROHIBIDO ethers.js, @noble/secp256k1,
  web3.js.
- **CD-5**: PROHIBIDO `console.log`. La función NO recibe logger.
- **CD-6**: OBLIGATORIO firma explícita: `(params: VerifyParams, token: EIP3009Token,
  chainId: ChainId) => Promise<AdapterResult<VerifyResult>>`.
- **CD-7**: OBLIGATORIO `buildEip3009Domain` puro (sin I/O, sin async).
- **CD-8**: PROHIBIDO keys reales u on-chain calls. Fixtures con Hardhat account #0.
- **CD-9**: OBLIGATORIO `EIP3009_TYPES` constante en `abi.ts`.
- **CD-10**: PROHIBIDO `===` o `.toLowerCase()` para addresses. Usar `isAddressEqual`.
- **CD-11**: OBLIGATORIO nonce es `0x` + 64 hex chars. Nonce mal formado →
  `INVALID_SIGNATURE`.
- **CD-12**: OBLIGATORIO ≥1 test por AC con check explícito de `error.code`.
- **CD-13**: PROHIBIDO rutas relativas que crucen boundary del método.

### CDs nuevos (SDD §6)

- **CD-14**: OBLIGATORIO imports named explícitos desde viem (`import { recoverTypedDataAddress,
  isAddressEqual, getAddress } from 'viem'`). PROHIBIDO `import viem` o `import * as
  viem`.
- **CD-15**: PROHIBIDO indexing dinámico sobre `authorization` (e.g.,
  `authorization[fieldName]`). Leé cada campo por key literal.
- **CD-16**: Imports type-only desde `src/core/types.js` permitidos SOLO para
  `Address`, `ChainId`, `X402ErrorCode`, `Result`. Cualquier otro import (runtime o
  type) desde `src/core/*` es BLOQUEANTE.

### Quick check para AR/CR (comandos a correr)

```bash
# CD-1 / CD-13: no cross-boundary imports
grep -rn "from '../../routes/" src/methods/eip3009/ && echo BAD
grep -rn "from '../../middleware/" src/methods/eip3009/ && echo BAD
grep -rn "from '../../infra/" src/methods/eip3009/ && echo BAD
grep -rn "from '../../chains/registry" src/methods/eip3009/ && echo BAD
grep -rn "from '../permit2/" src/methods/eip3009/ && echo BAD
grep -rn "from '../erc7710/" src/methods/eip3009/ && echo BAD

# CD-4: no ethers/noble/web3
grep -rn "from 'ethers" src/methods/eip3009/ && echo BAD
grep -rn "from '@noble" src/methods/eip3009/ && echo BAD
grep -rn "from 'web3" src/methods/eip3009/ && echo BAD

# CD-5: no console
grep -rn "console\." src/methods/eip3009/ && echo BAD

# CD-14: no default/star viem imports
grep -rn "^import viem from" src/methods/eip3009/ && echo BAD
grep -rn "^import \* as viem" src/methods/eip3009/ && echo BAD

# CD-16: type-only core imports
grep -rn "from '../../core/" src/methods/eip3009/
# cada match debe tener `import type` (no runtime)

# CD-10: no === or toLowerCase on addresses
grep -rn "\.toLowerCase()" src/methods/eip3009/*.ts && echo "REVIEW — maybe OK in tests"
# === solo para comparaciones NO-address (e.g., strings, amounts)
```

---

## 10. Lectura obligatoria en `node_modules/` (read-first, W1)

ANTES de escribir código en W1, leer:

- [ ] `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` —
  firma de `recoverTypedDataAddress` + `RecoverTypedDataAddressParameters` shape.
- [ ] `node_modules/viem/_types/utils/address/isAddressEqual.d.ts` — firma.
- [ ] `node_modules/viem/_types/utils/address/getAddress.d.ts` — firma.
- [ ] `node_modules/viem/_types/accounts/privateKeyToAccount.d.ts` — firma.
- [ ] `node_modules/viem/_types/accounts/utils/signTypedData.d.ts` — firma (para
  fixtures de test).
- [ ] `node_modules/abitype/dist/types/abi.d.ts` líneas 121-127 — `TypedDataDomain`
  shape.

Si cualquiera de estos archivos NO existe en el camino indicado, parar y escalar — el
path del d.ts file es responsabilidad de viem 2.48.4 shape actual.

---

## 11. Done Definition

La HU está DONE cuando TODOS los siguientes son verdad:

- [ ] Todos los archivos de §3 creados según shapes §5.
- [ ] Los 7 archivos totales compilan: `npm run typecheck` exit 0.
- [ ] `npm run lint` exit 0 con 0 errors y 0 warnings.
- [ ] `npm run test` exit 0 con mínimo 27 tests nuevos pasando (7 domain + 9 W2 + 11
  W3).
- [ ] `npm run build` exit 0 — `dist/methods/eip3009/*.js` + `.d.ts` generados.
- [ ] `npm run qa` exit 0 (combo typecheck + lint + format:check + test).
- [ ] Los 12 ACs tienen un test que los assertea explícitamente por `error.code` o
  por shape de éxito (§8).
- [ ] Los 16 CDs (§9) no están violados — grep checks de §9 no imprimen "BAD".
- [ ] **Auto-Blindaje escrito**: si durante F3 detectás un error al codear, documenta
  en `doc/sdd/005-wfac-6-eip3009-verify/auto-blindaje.md` con el formato estándar
  (ver `doc/sdd/004-wfac-5-redis-client/auto-blindaje.md` como exemplar). Si no hubo
  ningún error, el archivo puede no existir (no bloqueante).
- [ ] Commit final del Dev contiene el tag WFAC-6 en el mensaje.
- [ ] Listo para AR y CR.

No declarés DONE si:

- Algún test está `skip`eado.
- Algún type es `any`.
- Algún import es runtime desde `src/core/*`.
- Hay console.log/error/warn en `src/methods/eip3009/*.ts` (excepto tests).
- Hay hex literal de signature hardcodeado fuera de los helpers de test (T-H7 permite
  un hex literal de longitud incorrecta porque es un input explícitamente malformado
  para probar la rama de error).

---

## 12. Preguntas frecuentes (FAQ anticipada)

### Q: ¿Por qué el módulo no loggea nada?

R: Porque es una función pura que retorna un discriminated union tipado. El caller
(core/verify.ts en WFAC-20, o un adapter en WFAC-10) decide qué logear del Result —
tiene el contexto HTTP (request-id, IP) que esta función no conoce. Además, un logger
inyectado crearía boundary cross a infra que viola OWNERS.

### Q: ¿Por qué `isAddressEqual` y no `recovered === authorization.from`?

R: Porque `recoverTypedDataAddress` devuelve la address en formato checksummed EIP-55.
`authorization.from` llega del cliente — puede ser lowercase, uppercase, o mixed.
`===` sobre esos dos casos retorna `false` incluso cuando la address es la misma.
`isAddressEqual` normaliza ambos internamente y compara bytes.

### Q: ¿Por qué `getAddress` sobre `recovered` si ya viene checksummed?

R: Defense in depth. Si una futura versión de viem cambiara el formato de salida (e.g.,
EIP-1191 con chainId), `getAddress` nos deja fijar el formato canónico. No cuesta
performance.

### Q: ¿Por qué el helper `err()` local y no una factory importada?

R: Porque crear `src/core/errors.ts` con factories queda fuera de scope de esta HU
(ver CD-1 + OWNERS). `err()` local es 4 líneas de código trivial; centralizarlo
prematuramente es YAGNI — WFAC-20 puede introducir el helper cuando haya múltiples
methods que lo usen.

### Q: ¿Puedo usar `fc` (fast-check property tests) para los edge cases?

R: NO en esta HU. fast-check no está instalado y agregarlo es out-of-scope. Los edge
cases actuales (T-H1..T-H8) cubren los casos conocidos. Property testing puede ser
ticket dedicado futuro.

### Q: ¿Qué pasa si `accepted.asset` tiene casing distinto de `token.address`?

R: `isAddressEqual` las normaliza (AC-11). El test T-H testearía esto implícitamente
si ponemos un `accepted.asset` en lowercase y el `token.address` checksummed.

### Q: ¿Y si el domain del token real en chain tiene un `salt`?

R: No es EIP-3009 canónico. Si descubrimos un token deployado con salt, hacemos nuevo
ticket (WFAC-futuro). Por ahora ignoramos salt. Si el recover falla por eso, el client
recibe `INVALID_SIGNATURE` con mensaje genérico — aceptable.

### Q: ¿Debo rebuildear el branch con `main` al final?

R: Sí — si hubo merges en main mientras estabas codeando. `git fetch origin && git
rebase origin/main` antes de abrir el PR. Si hay conflicts, parar y escalar.

---

## 13. Checklist final antes de pasar a AR

- [ ] W0 completada + gate verde.
- [ ] W1 completada + gate verde.
- [ ] W2 completada + gate verde.
- [ ] W3 completada + gate verde.
- [ ] `npm run qa` verde.
- [ ] `npm run build` verde.
- [ ] 27+ tests pasando.
- [ ] 12 ACs verificados en `verify.test.ts`.
- [ ] 16 CDs no-violados (grep checks de §9).
- [ ] Sin `any`, sin `as unknown as X` en src/methods/eip3009/*.ts (excepto helpers
  de test donde es inevitable — pero en este SDD/Story NO hay un caso donde sea
  inevitable, así que: cero).
- [ ] Sin `console.*`.
- [ ] Imports type-only donde corresponde (linter enforcea).
- [ ] Commit message: `feat(WFAC-6): EIP-3009 verify logic — W0-W3` o similar por
  wave.

Listo para AR (`/nexus-p5-ar WFAC-6`).
