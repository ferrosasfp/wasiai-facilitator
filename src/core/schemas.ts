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
 * Top-level x402 POST /verify request body — WKH-204 namespace union.
 * CD-8: x402Version uses z.literal(2) (not z.number()) so any other value
 * fails fast at the Zod gate.
 *
 * The body is a `z.union` (NOT z.discriminatedUnion: the discriminant
 * `assetTransferMethod` lives nested inside `accepted.extra`) of two branches:
 *   - Eip3009RequestSchema    — byte-identical to the pre-WKH-204 schema.
 *   - NonEip3009RequestSchema — permit2/erc7710 placeholder with a permissive,
 *     minimally-typed payload (NOT the final Solana shape — CD-3).
 */

// Branch eip3009 — BYTE-IDENTICAL to the prior schema (literal + strict PayloadSchema).
const Eip3009RequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: AcceptedSchema.extend({
      extra: AcceptedExtraSchema.extend({ assetTransferMethod: z.literal('eip3009') }),
    }),
    payload: PayloadSchema,
  })
  .strict();

// Payload placeholder no-eip3009: typed by what the core LAYER READS
// (authorization.from → ledger, authorization.value → cap-check), permissive
// via passthrough. NOT the final Solana shape (CD-3). NOT z.record (CD-11):
// a record/passthrough-without-authorization reintroduces an index-signature
// that breaks the `in` narrowing of the cap-check (TS18046).
const NonEip3009PayloadSchema = z
  .object({
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/u)
      .optional(),
    // authorization optional; `from`+`value` are the only fields core reads.
    // `.passthrough()` tolerates the eip3009 extra fields
    // (to/validAfter/validBefore/nonce) that T-V10/T-C5 inject when reusing
    // VALID_BODY.payload, and future non-EVM fields.
    authorization: z
      .object({ from: AddressHexSchema, value: Uint256StringSchema })
      .passthrough()
      .optional(),
  })
  .passthrough();

const NonEip3009RequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: AcceptedSchema.extend({
      extra: AcceptedExtraSchema.extend({ assetTransferMethod: z.enum(['permit2', 'erc7710']) }),
    }),
    payload: NonEip3009PayloadSchema,
  })
  .strict();

export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema]);

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
