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
 *
 * Derived from `escrowIdl.address` — the SINGLE source (CD-15). The re-exported
 * module is dependency-free data, so CD-12 holds: this does NOT pull anchor into
 * the raw-bytes validation path.
 */
export { ESCROW_PROGRAM_ID_DEFAULT } from '../../chains/escrow-program-id.js';

/**
 * Anchor discriminator of the `deposit` instruction — first 8 bytes of `ix.data`
 * (pinned from escrow-idl.ts:197). CR-1 compares these bytes exactly.
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
 * remaining account). Order (escrow-idl.ts:198-340):
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
 * SDD 037 / W0 — byte layout of the `deposit` instruction DATA.
 *
 * Pinned from the arg order declared in `src/chains/escrow-idl.ts:341-364` and
 * CONFIRMED against bytes produced by `BorshInstructionCoder(escrowIdl).encode`
 * in `src/__tests__/unit/solana-sponsor.amount-offset.test.ts` (T-OFF1). The
 * evidence note is `doc/sdd/037-sponsor-pop-ed25519/w0-amount-offset.md`.
 *
 *   offset  len  field
 *        0    8  Anchor discriminator     === DEPOSIT_DISCRIMINATOR
 *        8   16  remittance_id  [u8; 16]  === sha256(utf8(remittanceId))[0..16]
 *       24   32  beneficiary    pubkey
 *       56   32  authority      pubkey
 *       88    8  amount         u64 LE    <- AMOUNT_OFFSET
 *       96    8  deadline       i64 LE
 *      ---------
 *      104       DEPOSIT_DATA_LEN
 *
 * ⚠️ Un offset equivocado acá NO se ve como un bug puntual: la línea `amount`
 * del mensaje canónico se reconstruye distinta y el guard rechaza TODO request.
 * El input concreto que lo delata: una ix con `amount = 10000000n` y
 * `deadline = 1900000000n` — si el offset estuviera corrido 8 bytes, el u64 en
 * 88 daría 1900000000n en vez de 10000000n. T-OFF1 usa exactamente ese par.
 */
export const AMOUNT_OFFSET = 88;
export const AMOUNT_LEN = 8;
export const DEPOSIT_DATA_LEN = 104;

/**
 * Offset/largo del campo `authority` de la ix `deposit` — la pubkey que queda GRABADA
 * en el `EscrowState` y que despues es la unica que puede firmar el `release`
 * (`has_one = authority` -> `ConstraintHasOne` 2001 si firma otra).
 *
 * Mismo layout de arriba: 8 discriminador + 16 remittance_id + 32 beneficiary = 56.
 *
 * ⚠️ El input concreto que delata un offset corrido: una ix cuyo `beneficiary` y
 * `authority` son pubkeys DISTINTAS y cuya `authority` es la configurada. Con el offset
 * en 24 el check leeria el `beneficiary` y rechazaria un deposito legitimo; con el
 * offset en 88 leeria los 8 bytes del `amount` + 24 mas y tampoco coincidiria. El
 * fixture de `solana-sponsor.cr1.test.ts` (Check 4d) usa exactamente esa forma.
 */
export const AUTHORITY_OFFSET = 56;
export const AUTHORITY_LEN = 32;

/**
 * HU-SOL-20 / R3 — pinned shape of the ONLY 2nd business instruction CR-1 accepts:
 * `register_escrow` of the SAME escrow program. Pinned from the IDL produced by
 * `anchor build` in solana-programs (HU-SOL-20/R1) and re-vendored here by R2a
 * (`src/chains/escrow-idl.ts:520`), NEVER from a literal in a doc.
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

/**
 * WKH-357 / HU-064 — pinned shape of the `AdvanceNonceAccount` System-Program ix that
 * a DEEP-LINK deposit carries as its instruction 0 (durable nonce). Gated by
 * `SOLANA_SPONSOR_DURABLE_NONCE_ENABLED`; with the flag OFF nothing below is read.
 *
 * These are NOT copied from a doc: MEASURED on 2026-08-17 against the
 * `@solana/web3.js` in THIS repo's node_modules (^1.98.4) with
 * `SystemProgram.nonceAdvance({noncePubkey, authorizedPubkey})`, which printed
 *   data: [4,0,0,0] len: 4
 *   keys: 0 signer=false writable=true | 1 signer=false writable=false | 2 signer=true writable=false
 * The twin constants live in `chaski-v3/src/infrastructure/solana/nonce-duradero.ts`
 * (CD-17), and the chaski side has the test that catches a web3.js bump moving them.
 *
 * ⚠️ WHY THIS IS PINNED BY BYTES AND NOT BY CALLING `SystemProgram.nonceAdvance`:
 * same reason as `DEPOSIT_DISCRIMINATOR` (CD-12) — the validator compares what
 * ARRIVED on the wire, and building a reference ix here to compare against would
 * make the guard agree with whatever the library does after an upgrade.
 */
export const ADVANCE_NONCE_DISCRIMINATOR: readonly number[] = [4, 0, 0, 0];

/**
 * EXACT byte length of the `nonceAdvance` data. Compared with `===`, never `>=`.
 *
 * ⚠️ The concrete input that a `>=` would let through: a 5-byte data of
 * `[4,0,0,0,99]` — a well-formed AdvanceNonceAccount discriminator with a trailing
 * byte the System Program ignores today. `>=` accepts it, `===` rejects it, and the
 * vector that measures the difference is the "data de 5 bytes" case of T-12.
 */
export const ADVANCE_NONCE_DATA_LEN = 4;

/**
 * The `nonceAdvance` carries EXACTLY these 3 accounts, in this order, and NO
 * remaining ones.
 *
 * ⚠️ The concrete input that an off-by-one would let through: an ix with a 4th
 * account appended. Since Check 5 sweeps every key of every ix, an extra account is
 * not a drain by itself — but it is an account the tx can reference that the pinned
 * shape never authorized, and `!== 3` is what keeps the shape closed. T-12 uses both
 * a 2-account and a 4-account vector.
 */
export const ADVANCE_NONCE_POSITIONAL_ACCOUNTS = 3;

/**
 * Positional indices into the `nonceAdvance` account list, with the flags each one
 * MUST carry (measured above):
 *   0 NONCE               writable, NON-signer  — the nonce account itself
 *   1 RECENT_BLOCKHASHES  readonly, NON-signer  === SYSVAR_RECENT_BLOCKHASHES_ID
 *   2 AUTHORITY           SIGNER,   readonly    — must be the deposit's OWN sender
 *
 * ⚠️ The concrete input that a swapped NONCE/AUTHORITY index would let through: an ix
 * whose keys[0] is the sender (signer) and keys[2] the nonce account. Reading the
 * authority at index 0 would then compare the nonce account against the deposit
 * sender and reject a legitimate tx; reading it at index 2 on a hand-built ix that
 * puts a THIRD party's nonce at index 0 is exactly what n6 exists to catch.
 */
export const ADVANCE_NONCE_ACCOUNT_INDEX = {
  NONCE: 0,
  RECENT_BLOCKHASHES: 1,
  AUTHORITY: 2,
} as const;

/**
 * The recent-blockhashes sysvar the `nonceAdvance` reads (account index 1).
 *
 * ⚠️ IT IS THE DIGIT `1`, NOT THE LETTER `l` — "SysvarRecentB**1**ockHashes". base58
 * has no `l`, so a typo here does not produce a wrong-but-valid pubkey: it throws
 * inside `new PublicKey(...)` at module import. Derived from
 * `SYSVAR_RECENT_BLOCKHASHES_PUBKEY.toBase58()` on 2026-08-17, not typed by hand.
 */
export const SYSVAR_RECENT_BLOCKHASHES_ID = 'SysvarRecentB1ockHashes11111111111111111111';
