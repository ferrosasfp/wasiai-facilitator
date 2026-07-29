/**
 * WKH-302 — pinned shape constants for the SPL payout the facilitator ORIGINATES.
 *
 * Unlike the sponsorship/release paths (where the facilitator only co-signs a tx
 * someone else built), here the facilitator is the TREASURER: it builds, signs and
 * broadcasts a transfer out of its OWN ATA. These constants are what
 * `validate-transfer.ts` compares the re-parsed tx against before the payout
 * operator key is allowed to sign.
 *
 * CD-12 (repo-wide policy): we do NOT depend on `@coral-xyz/anchor` nor trust an
 * IDL to PARSE a transaction — program ids and instruction tags are compared by
 * exact bytes/pubkey. Anchor appears here for ONE thing only: the base58 encoder
 * (`encodeSignatureBase58`), which is pure data-encoding and touches no tx parsing.
 *
 * NO NEW DEPENDENCIES (Story File §4.3): `bs58` and `@solana/spl-token` are
 * deliberately NOT added. Adding a package to the money path buys new supply-chain
 * surface to replace encoding this repo already performs elsewhere.
 *
 * CD-15 (auto-blindaje #026): every base58 literal is a PUBLIC on-chain pubkey,
 * not a secret — each carries an `eslint-disable no-secrets` justification.
 *
 * Boundary: no env, no route, no keypair, no I/O. Constants + one pure function.
 */

import { utils } from '@coral-xyz/anchor';

/** SPL Token classic program id — owner of the `TransferChecked` instruction. */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Associated Token program id — owner of the `CreateIdempotent` instruction. */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain Associated Token program id (base58 pubkey), not a secret.
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** System program id — required account of the ATA `CreateIdempotent` ix. */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * SPL Token instruction tag for `TransferChecked` (first data byte).
 *
 * ⚠️ 12 (`TransferChecked`), NOT 3 (`Transfer`) — this is a Constraint Directive,
 * not a preference. `TransferChecked` carries the `mint` and `decimals` INSIDE the
 * instruction, so the SPL runtime itself rejects the tx when the source ATA does
 * not belong to the expected mint or the decimals disagree. With plain `Transfer`
 * (what the gateway uses today via `createTransferInstruction`) that check does not
 * exist and a wrong source ATA drains silently.
 */
export const SPL_TRANSFER_CHECKED_TAG = 12;

/** Associated Token program instruction tag for `CreateIdempotent`. */
export const ATA_CREATE_IDEMPOTENT_TAG = 1;

/**
 * Sentinel key for the payout mutex (`runExclusive`). The fee-payer sponsorship
 * uses `FEE_PAYER_SENTINEL_ID = -1`; payouts get their OWN `-2`.
 *
 * Sharing one sentinel would serialize payouts behind sponsorships for no reason
 * and — worse — put two DIFFERENT keypairs under a single lock, which reads like
 * mutual exclusion while providing none for either key.
 */
export const PAYOUT_SENTINEL_ID = -2;

/**
 * Encode a raw ed25519 signature as the base58 string Solana uses as a tx id.
 *
 * Uses anchor's bundled bs58 (`@coral-xyz/anchor@0.30.1` is already a direct
 * dependency and is already imported by `src/chains/solana-escrow.ts`), so no new
 * package enters the money path. Pure data encoding — CD-12 (no anchor for tx
 * PARSING) is untouched.
 */
export function encodeSignatureBase58(signature: Uint8Array): string {
  return utils.bytes.bs58.encode(Buffer.from(signature));
}
