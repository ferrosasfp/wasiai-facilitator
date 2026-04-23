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
