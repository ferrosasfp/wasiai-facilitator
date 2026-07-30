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
  Base58PubkeySchema,
  Base58SignatureSchema,
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

// ─── HU-SOL-9 / WKH-208 · rama Solana base58 (3ª rama del union) ────────────
// Representa el request Solana no-custodial en base58 (NO 0x-hex) tal como lo
// construye chaski `verifySolanaSettlement` y lo consume
// solana-adapter.ts::_parseSolanaInput (accepted.{network,asset,payTo,amount} +
// payload.{signature,reference?}). NO hay `extra` (el dispatch solana hace
// early-return antes del check assetTransferMethod). `.strict()` lo rechaza.
const SolanaAcceptedSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z
      .string()
      .regex(/^solana:(devnet|mainnet)$/u, 'network must be solana:<devnet|mainnet>'),
    amount: Uint256StringSchema, // u64 ⊂ uint256 — reusa el primitivo existente
    asset: Base58PubkeySchema, // mint base58 (NO 0x-hex)
    payTo: Base58PubkeySchema, // beneficiary base58 (NO 0x-hex)
    maxTimeoutSeconds: z.number().int().positive(),
  })
  .strict();

const SolanaPayloadSchema = z
  .object({
    signature: Base58SignatureSchema, // tx sig finalizada (NO 0x-hex, NO objeto authorization)
    reference: Base58PubkeySchema.optional(),
  })
  .strict();

const SolanaRequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: SolanaAcceptedSchema,
    payload: SolanaPayloadSchema,
  })
  .strict();

// ─── Casper · rama casper (4ª rama del union) ───────────────────────────────
// Casper transporta claves públicas / account-hashes / contract-hashes (NO
// 0x-hex EVM), igual que la rama Solana transporta base58. Los criterios son
// LOS MISMOS que src/chains/casper-adapter.ts (CD-9 heredado de la rama
// Solana): lo que pasa el Zod pasa el parse del adapter.
const CasperPublicKeySchema = z
  .string()
  .regex(/^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/u, 'must be a casper public key');

const CasperPayToSchema = z
  .string()
  .regex(
    /^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66}|account-hash-[0-9a-fA-F]{64})$/u,
    'must be a casper public key or account hash',
  );

const CasperContractHashSchema = z
  .string()
  .regex(/^(hash-)?[0-9a-fA-F]{64}$/u, 'must be a casper contract hash');

const CasperAcceptedSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z
      .string()
      .regex(/^casper:(casper|casper-test)$/u, 'network must be casper:<casper|casper-test>'),
    amount: Uint256StringSchema, // motes (u512 ⊂ uint256 string) — reusa el primitivo
    asset: CasperContractHashSchema, // wCSPR CEP-18 contract hash
    payTo: CasperPayToSchema,
    maxTimeoutSeconds: z.number().int().positive(),
  })
  .strict();

const CasperPayloadSchema = z
  .object({
    signature: z.string().min(1),
    authorization: z
      .object({ from: CasperPublicKeySchema })
      .passthrough(),
  })
  .passthrough();

const CasperRequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: CasperAcceptedSchema,
    payload: CasperPayloadSchema,
  })
  .strict();

// The exported TYPE intentionally reflects ONLY the two EVM branches — it is
// BYTE-IDENTICAL to the pre-HU-SOL-9 inferred type. The Solana runtime path
// early-returns in core/{verify,settle}.ts (namespace dispatch) BEFORE any
// `.accepted.extra` / `.payload.authorization` read, and the Solana-specific
// fields are consumed by solana-adapter.ts via its own sanctioned boundary cast
// (`params.payload as unknown as {...}`). Widening this type to include the
// Solana branch would break settle.ts/verify.ts/routes reads of `.extra` /
// `.authorization` (CD-4': those files are out of scope).
export type VerifyRequest =
  | z.infer<typeof Eip3009RequestSchema>
  | z.infer<typeof NonEip3009RequestSchema>;

// CD-1: `z.union` devuelve la PRIMERA rama que matchea. Un body EVM matchea
// rama 1/2 igual que hoy; la 3ª rama (Solana) va ÚLTIMA → nunca altera el
// `.success` de un body que ya matcheaba ni de uno que fallaba las 2 EVM.
//
// El RUNTIME valida las 3 ramas (una request Solana base58 PASA). El tipo de
// salida se asevera como `VerifyRequest` (solo EVM) mediante un cast de
// frontera sancionado (mismo patrón `as unknown as` de core/settle.ts:144):
// desacopla la validación en runtime (3 ramas) del tipo estático que consumen
// settle.ts/verify.ts/routes (EVM), que jamás leen los campos Solana como
// `VerifyRequest`. Sin este cast, `safeParse().data` sería la unión de 3 ramas
// y rompería `const parsed: SettleRequest = parseResult.data` en las rutas.
export const VerifyRequestSchema = z.union([
  Eip3009RequestSchema,
  NonEip3009RequestSchema,
  SolanaRequestSchema,
  CasperRequestSchema,
]) as unknown as z.ZodType<VerifyRequest, z.ZodTypeDef, unknown>;

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
