/**
 * Zod schemas for the x402 POST /verify request body (spec-literal).
 *
 * Exports:
 *   - ResourceSchema
 *   - AcceptedExtraSchema
 *   - AcceptedSchema (full x402 accepted object: scheme, network, amount,
 *     asset, payTo, maxTimeoutSeconds, extra)
 *   - PayloadSchema
 *   - VerifyRequestSchema  ← TOP-LEVEL
 *   - type VerifyRequest = z.infer<typeof VerifyRequestSchema>
 *
 * Boundary (OWNERS): re-uses primitive validators from
 * src/methods/eip3009/schemas.ts — DO NOT duplicate
 * Bytes32HexSchema / AddressHexSchema / Uint256StringSchema here.
 *
 * CDs enforced in this file:
 *   - CD-8  : x402Version MUST be z.literal(2), not z.number().
 *   - CD-11 : canonical uint256 (inherited via Uint256StringSchema — rejects
 *             leading zeros, negatives, scientific notation).
 *
 * The resulting `VerifyRequest` type is structurally assignable to
 * `VerifyParams` in src/chains/types.ts (verified at build time by
 * src/core/verify.ts).
 */

import { z } from 'zod';
import {
  AddressHexSchema,
  Uint256StringSchema,
  Eip3009AuthorizationSchema,
} from '../methods/eip3009/schemas.js';
// Note: Bytes32HexSchema is reachable transitively via Eip3009AuthorizationSchema
// (used for `authorization.nonce`). We do NOT re-import it here — it would be
// unused at this layer and the lint rule `no-unused-vars` would fire.

/** x402 resource descriptor. */
export const ResourceSchema = z
  .object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .strict();

/** x402 accepted.extra — method discriminator + optional EIP-712 domain hints. */
export const AcceptedExtraSchema = z
  .object({
    assetTransferMethod: z.enum(['eip3009', 'permit2', 'erc7710']),
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .strict();

/**
 * Full x402 accepted object. Distinct from
 * src/methods/eip3009/schemas.ts::AcceptedSchema which is intentionally a
 * method-local passthrough guard over hot-path fields only.
 */
export const AcceptedSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z.string().min(1),
    amount: Uint256StringSchema,
    asset: AddressHexSchema,
    payTo: AddressHexSchema,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: AcceptedExtraSchema,
  })
  .strict();

/**
 * x402 payload — signature + authorization.
 *
 * signature: we only enforce 0x-prefixed hex here. Exact byte-length
 * validation (65-byte canonical / 64-byte EIP-2098 compact) is the adapter's
 * concern (see src/methods/eip3009/verify.ts signature pre-validation).
 */
export const PayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u, 'signature must be 0x-prefixed hex'),
    authorization: Eip3009AuthorizationSchema,
  })
  .strict();

/**
 * Top-level x402 POST /verify request body.
 * CD-8: x402Version uses z.literal(2) (not z.number()) so any other value
 * fails fast at the Zod gate.
 */
export const VerifyRequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: AcceptedSchema,
    payload: PayloadSchema,
  })
  .strict();

export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

// ─── WFAC-21 extension ──────────────────────────────────────────────────
/**
 * Alias of VerifyRequestSchema — x402 spec declares the settle body shape
 * identical to verify (see src/chains/types.ts: `SettleParams = VerifyParams`).
 * Export under a distinct name for route-layer clarity (SDD §DT-1).
 *
 * If the spec ever diverges (e.g. settle adds an optional `tip` field), this
 * alias MUST be forked to its own Zod object in an explicit SDD — not drifted
 * silently.
 */
export const SettleRequestSchema = VerifyRequestSchema;
export type SettleRequest = VerifyRequest;
