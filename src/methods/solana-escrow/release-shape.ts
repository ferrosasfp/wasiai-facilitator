/**
 * WKH-216 / HU-SOL-13 — Wave 13c: pinned `release` shape constants (CR-1 source of truth).
 *
 * The EXACT bytes/pubkeys `validateReleaseForSponsor` (cr1-release.ts) compares
 * against, pinned from the escrow IDL (AH-11, verified against
 * solana-programs `Release<'info>`). Mirror of `deposit-shape.ts` (AH-23). CD-12:
 * we do NOT depend on anchor to VALIDATE the tx — the discriminator + program ids
 * are compared by exact bytes/pubkey (the IDL/anchor only decodes the *account*).
 *
 * Every base58 literal is a PUBLIC on-chain pubkey, not a secret (auto-blindaje #026).
 */

/**
 * Escrow program id whitelisted for the `release` ix. Overridable via
 * `SOLANA_ESCROW_PROGRAM_ID`; this is the default (devnet program).
 */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain escrow program id (base58 pubkey), not a secret.
export const ESCROW_PROGRAM_ID_DEFAULT = 'BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA';

/**
 * Anchor discriminator of the `release` instruction — first 8 bytes of `ix.data`
 * (pinned from escrow-idl.ts release ix, AH-11). CR-1 compares these bytes exactly.
 */
export const RELEASE_DISCRIMINATOR: readonly number[] = [253, 249, 15, 206, 28, 127, 193, 241];

/** SPL Token classic program id (release account index 7). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Associated Token program id (release account index 8). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain Associated Token program id (base58 pubkey), not a secret.
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Number of positional accounts in the `release` ix. Order (AH-11 / escrow
 * `Release<'info>`):
 *   0 authority              (signer; == release-authority == feePayer)
 *   1 sender                 (== state.sender)
 *   2 beneficiary            (== state.beneficiary, on-chain)
 *   3 mint                   (== state.mint)
 *   4 escrow_state           (writable, pda)
 *   5 vault                  (writable)
 *   6 beneficiary_ata        (writable)
 *   7 token_program          === TOKEN_PROGRAM_ID
 *   8 associated_token_program === ASSOCIATED_TOKEN_PROGRAM_ID
 */
export const RELEASE_POSITIONAL_ACCOUNTS = 9;

/** Positional indices into the `release` ix account list. */
export const RELEASE_ACCOUNT_INDEX = {
  AUTHORITY: 0,
  SENDER: 1,
  BENEFICIARY: 2,
  MINT: 3,
  ESCROW_STATE: 4,
  VAULT: 5,
  BENEFICIARY_ATA: 6,
  TOKEN_PROGRAM: 7,
  ASSOCIATED_TOKEN_PROGRAM: 8,
} as const;
