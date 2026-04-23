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
