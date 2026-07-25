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
import { PublicKey } from '@solana/web3.js';

/** 0x-prefixed 32-byte hex (bytes32 / nonce). */
export const Bytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'must be 0x-prefixed 32-byte hex');

/** 0x-prefixed 20-byte hex (address). Shape-only; does NOT validate checksum. */
export const AddressHexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'must be 0x-prefixed 20-byte hex');

/**
 * Decimal uint256 string — CANONICAL form.
 * - Regex: either "0" OR [1-9][0-9]* — rejects leading zeros ("01000"),
 *   negatives, "+", scientific notation ("1e2"), hex prefixes, whitespace.
 * - Refine: BigInt parseable AND within [0, 2^256-1].
 *
 * Rationale (BLQ-BAJO-1): leading-zero variants produce identical BigInt
 * values but distinct string representations — canonical form keeps logs
 * and equality checks unambiguous.
 */
export const Uint256StringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u, 'must be a canonical decimal uint256 string')
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

/**
 * `params.accepted` validator (BLQ-ALTO-2 / CD-2).
 *
 * Validates the hot-path fields consumed by verify.ts BEFORE any `BigInt(...)`
 * or `isAddressEqual(...)` call so we never throw on attacker-controlled input:
 *   - amount: canonical uint256 string (rejects "-1", "abc", "1e2", "01000").
 *   - asset/payTo: 0x + 40 hex chars (rejects non-address strings).
 *   - network: non-empty string (e.g. "eip155:2368").
 *
 * Optional fields (scheme, maxTimeoutSeconds, extra) pass through via
 * `.passthrough()` to avoid rejecting upstream-valid payloads while we
 * focus validation on the fields verify.ts actually consumes.
 */
export const AcceptedSchema = z
  .object({
    amount: Uint256StringSchema,
    asset: AddressHexSchema,
    payTo: AddressHexSchema,
    network: z.string().min(1, 'network must be a non-empty string'),
  })
  .passthrough();

export type AcceptedValidated = z.infer<typeof AcceptedSchema>;

// ─── HU-SOL-9 / WKH-208 · Solana base58 primitives (aditivo puro) ───────────
// Boundary OWNERS: primitivos viven acá; core/schemas.ts los reusa (no duplica).
// Mismo criterio que src/chains/solana-adapter.ts::isBase58Pubkey /
// isBase58Signature (CD-9): lo que pasa el Zod pasa el parse del adapter.

/** base58 pubkey (32-byte) — MISMO criterio que solana-adapter.ts::isBase58Pubkey. */
export const Base58PubkeySchema = z.string().refine((s) => {
  try {
    // PublicKey ctor valida base58 + longitud 32-byte (throw en otro caso).
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, 'must be a base58 pubkey');

/** base58 tx signature — MISMO criterio que solana-adapter.ts::isBase58Signature. */
export const Base58SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'base58')
  .refine((s) => s.length >= 64 && s.length <= 120, 'solana signature length');
