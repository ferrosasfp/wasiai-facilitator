/**
 * DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A.
 *
 * OWNERS.md forbids `src/chains/*` runtime imports from `src/methods/*`.
 * The EIP-3009 spec constants (ABI, EIP-712 types, receipt timeout) are
 * spec-fixed — no business logic — so duplication here is a controlled
 * trade-off. Any edit to src/methods/eip3009/abi.ts MUST be replicated
 * verbatim in this file in the same PR (CD-NEW-SDD-1 — runtime byte-for-
 * byte test `T-SDD-1-ABI-SYNC` in chain-adapter.test.ts).
 *
 * Refactor tracker: TD-CHAINS-ABI-DUP in BACKLOG.md.
 */

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
  {
    type: 'function',
    name: 'DOMAIN_SEPARATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
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
