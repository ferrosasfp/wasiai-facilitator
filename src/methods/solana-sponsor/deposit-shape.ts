/**
 * WKH-217 / HU-SOL-14 — pinned `deposit` shape constants (CR-1 source of truth).
 *
 * These are the EXACT bytes/pubkeys CR-1 (`validateDepositForSponsor`) compares
 * against. They are pinned from the escrow IDL that chaski uses to build the tx
 * (`chaski-v3/src/infrastructure/solana/escrow-idl.ts`, HU-SOL-5). CD-12: we do
 * NOT depend on `@coral-xyz/anchor` nor trust an IDL at runtime — we compare the
 * discriminator + system program ids by exact bytes/pubkey.
 *
 * CD-15 (auto-blindaje #026): every base58 literal is a PUBLIC on-chain pubkey,
 * not a secret — each carries an `eslint-disable no-secrets` justification.
 */

/**
 * Escrow program id whitelisted for the `deposit` ix. Overridable via
 * `SOLANA_ESCROW_PROGRAM_ID`; this is the default (devnet program).
 */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain escrow program id (base58 pubkey), not a secret.
export const ESCROW_PROGRAM_ID_DEFAULT = 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x';

/**
 * Anchor discriminator of the `deposit` instruction — first 8 bytes of `ix.data`
 * (pinned from escrow-idl.ts:83). CR-1 compares these bytes exactly.
 */
export const DEPOSIT_DISCRIMINATOR: readonly number[] = [242, 35, 198, 137, 82, 225, 242, 182];

/** SPL Token classic program id (deposit account index 5). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Associated Token program id (deposit account index 6). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain Associated Token program id (base58 pubkey), not a secret.
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** System program id (deposit account index 7). */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Number of positional accounts in the `deposit` ix (before the `reference`
 * remaining account). Order (escrow-idl.ts:84-143):
 *   0 sender (writable, signer)
 *   1 mint
 *   2 escrow_state (writable, pda)
 *   3 vault (writable, pda)
 *   4 sender_ata (writable)
 *   5 token_program              === TOKEN_PROGRAM_ID
 *   6 associated_token_program   === ASSOCIATED_TOKEN_PROGRAM_ID
 *   7 system_program             === SYSTEM_PROGRAM_ID
 * followed by N remaining accounts (the `reference`, non-signer + non-writable).
 */
export const DEPOSIT_POSITIONAL_ACCOUNTS = 8;

/** Positional indices into the `deposit` ix account list. */
export const DEPOSIT_ACCOUNT_INDEX = {
  SENDER: 0,
  MINT: 1,
  ESCROW_STATE: 2,
  VAULT: 3,
  SENDER_ATA: 4,
  TOKEN_PROGRAM: 5,
  ASSOCIATED_TOKEN_PROGRAM: 6,
  SYSTEM_PROGRAM: 7,
} as const;

/**
 * HU-SOL-20 / R3 — pinned shape of the ONLY 2nd business instruction CR-1 accepts:
 * `register_escrow` of the SAME escrow program. Pinned from the IDL produced by
 * `anchor build` in solana-programs (HU-SOL-20/R1) and re-vendored here by R2a
 * (`src/chains/escrow-idl.ts:365`), NEVER from a literal in a doc.
 *
 * Read back from the built artifact on 2026-07-28:
 *   discriminator [200,17,194,170,224,144,127,166]
 *   accounts      [sender, escrow_state, escrow_index, system_program]
 */
export const REGISTER_ESCROW_DISCRIMINATOR: readonly number[] = [
  200, 17, 194, 170, 224, 144, 127, 166,
];

/** `register_escrow` carries EXACTLY these 4 accounts, in this order, and NO remaining ones. */
export const REGISTER_ESCROW_POSITIONAL_ACCOUNTS = 4;
export const REGISTER_ESCROW_ACCOUNT_INDEX = {
  SENDER: 0, // signer + writable (pays the index rent)
  ESCROW_STATE: 1, // non-signer (see cr1.ts Check 4b/b5 on why writability is NOT asserted here)
  ESCROW_INDEX: 2, // writable, non-signer (PDA ["escrow-index", sender])
  SYSTEM_PROGRAM: 3, // === SYSTEM_PROGRAM_ID
} as const;

/** ix-data layout: 8 discriminator bytes + [u8;16] remittance_id = EXACTLY 24 bytes. */
export const REMITTANCE_ID_OFFSET = 8;
export const REMITTANCE_ID_LEN = 16;
export const REGISTER_ESCROW_DATA_LEN = REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN; // 24
