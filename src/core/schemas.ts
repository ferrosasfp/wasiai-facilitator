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
    // REQUERIDO, no `.optional()`. El adaptador Solana lo exige SIEMPRE: el paso 7
    // de `_verifyCore` (solana-adapter.ts:298-312) corta con
    // `reference !== null && staticKeys.some(...)`, o sea que un body sin
    // `reference` NO puede terminar en 200 por ningún camino — ni `/verify` ni
    // `/settle` (los dos entran por el mismo `_verifyCore`).
    //
    // Cuando esto era `.optional()` el body pasaba el gate de Zod y moría adentro,
    // después del roundtrip al RPC: con la tx ya finalizada salía
    // `400 NETWORK_MISMATCH "payment reference not found in tx"` (código que habla
    // de la red, no del campo que falta) y, con la tx todavía no finalizada, salía
    // `500 TRANSACTION_FAILED` — un 5xx para lo que es un error de forma del caller.
    // Declarado acá, el rechazo es `400 INVALID_PAYLOAD` en el borde y el adaptador
    // ni se invoca.
    reference: Base58PubkeySchema,
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

// ─── describeFirstIssue ─────────────────────────────────────────────────────

/** Levels of `invalid_union` unwrapped before giving up (guards pathological nesting). */
const MAX_UNION_UNWRAP_DEPTH = 4;

/**
 * First issue of the "closest" branch of a failed `z.union` — the branch with
 * the FEWEST issues.
 *
 * Why fewest-issues: the branches of `VerifyRequestSchema` are mutually
 * exclusive in practice (EVM 0x-hex vs Solana base58, `extra` present vs
 * `.strict()`-forbidden), so the branch the caller actually AIMED at is the one
 * that stumbles on the least. A Solana body missing `payload.reference` yields 1
 * issue on the Solana branch and 5-6 on each EVM branch. This is a heuristic for
 * the error MESSAGE only; it has zero influence on accept/reject.
 *
 * Returns `undefined` when no branch reported an issue (should not happen — a
 * failed union always has at least one failing branch — but the caller must not
 * depend on that).
 */
function closestBranchIssue(unionErrors: readonly z.ZodError[]): z.ZodIssue | undefined {
  let best: z.ZodError | undefined;
  for (const candidate of unionErrors) {
    if (candidate.issues.length === 0) continue;
    if (best === undefined || candidate.issues.length < best.issues.length) best = candidate;
  }
  return best?.issues[0];
}

/**
 * Reduce a `ZodError` to the `{path, message}` pair the routes echo back on
 * `400 INVALID_PAYLOAD`.
 *
 * Exists because `VerifyRequestSchema` is a `z.union`: on failure Zod reports a
 * SINGLE top-level `invalid_union` issue with `path: []` and the message
 * `"Invalid input"`, and buries the per-branch issues in `unionErrors`. Reading
 * `error.issues[0]` verbatim therefore produced `"body: Invalid input"` for every
 * malformed body — which never names the offending field. This walks into the
 * closest branch so the reply can say e.g. `payload.reference: Required`.
 *
 * Scope of what it discloses: the SHAPE of the request the caller itself sent
 * (field path + Zod's own message). It reads nothing about server state, chain
 * state or other callers, and it runs BEFORE any adapter/RPC/DB work — so it
 * cannot become an oracle. (The `no-oracle` directive of this repo, CD-12, is
 * scoped to `/solana/sponsor` and `/solana/escrow`, whose rejection REASONS
 * depend on server-side facts; `/verify` and `/settle` have echoed the Zod
 * path+message since WFAC-20.)
 *
 * Callers cap the length of the returned message (`ZOD_MESSAGE_MAX_LEN`).
 */
export function describeFirstIssue(error: z.ZodError): { path: string; message: string } {
  let issue: z.ZodIssue | undefined = error.issues[0];
  for (let depth = 0; depth < MAX_UNION_UNWRAP_DEPTH; depth += 1) {
    if (issue === undefined || issue.code !== z.ZodIssueCode.invalid_union) break;
    // Zod runs every union branch with the SAME ctx.path, so a branch issue's
    // `path` is already absolute from the root — no prefix to re-attach here.
    const inner = closestBranchIssue(issue.unionErrors);
    if (inner === undefined) break;
    issue = inner;
  }
  return {
    path: issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : 'body',
    message: issue?.message ?? 'invalid',
  };
}
