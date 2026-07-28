/**
 * WKH-217 / HU-SOL-14 — CR-1: `validateDepositForSponsor` (THE anti-drain core).
 *
 * The `SponsorTxValidator` for the escrow `deposit`. Given a PARSED legacy
 * transaction and the fee-payer pubkey, it asserts — fail-closed, in order —
 * that the tx is EXACTLY the expected `deposit` and that the fee-payer is never
 * a source/authority/rent-payer of anything. Only then does it return the
 * derived fee upper bound so `cosignAndBroadcast` may co-sign.
 *
 * ⚠️ VECTOR ESTRELLA: a fee-payer that signs an opaque blob drains its own
 * wallet. Every check here is fail-closed (CD-3): any deviation, and any thrown
 * exception (a top-level `try/catch` also rejects), returns `{ ok:false }`
 * WITHOUT signing. When in doubt, reject.
 *
 * CD-12: no `@coral-xyz/anchor`, no IDL trust — the discriminator + system
 * program ids are compared by exact bytes/pubkey.
 *
 * Boundary: imports `@solana/web3.js` + `./deposit-shape.js` only.
 */

import { ComputeBudgetProgram, PublicKey, type Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEPOSIT_ACCOUNT_INDEX,
  DEPOSIT_DISCRIMINATOR,
  DEPOSIT_POSITIONAL_ACCOUNTS,
  REGISTER_ESCROW_ACCOUNT_INDEX,
  REGISTER_ESCROW_DATA_LEN,
  REGISTER_ESCROW_DISCRIMINATOR,
  REGISTER_ESCROW_POSITIONAL_ACCOUNTS,
  REMITTANCE_ID_LEN,
  REMITTANCE_ID_OFFSET,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './deposit-shape.js';

/** Result type — identical to `SponsorTxValidator`'s return (CD-11). */
export type Cr1Result = { ok: true; feeUpperBoundLamports: bigint } | { ok: false; reason: string };

/** Runtime-configurable bounds (from env; passed by the route). */
export interface Cr1Config {
  readonly escrowProgramId: string;
  readonly maxComputeUnits: number;
  readonly maxPriorityFeeMicroLamports: number;
  readonly maxFeeLamports: bigint;
}

/** Base network fee per signature (lamports) — the current Solana constant. */
const BASE_FEE_LAMPORTS_PER_SIG = 5000n;

/** ComputeBudget instruction discriminators (first data byte). */
const CB_SET_COMPUTE_UNIT_LIMIT = 2;
const CB_SET_COMPUTE_UNIT_PRICE = 3;

function reject(reason: string): Cr1Result {
  return { ok: false, reason };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * CR-1. See file header. Returns `{ ok:true, feeUpperBoundLamports }` when
 * checks 1-5 pass (blockhash freshness — check 6 — is done in
 * `cosignAndBroadcast`, which has network access), else `{ ok:false, reason }`.
 * `reason` is a stable, PII-free enum with NO echo of the tx.
 */
export function validateDepositForSponsor(
  tx: Transaction,
  feePayerPubkey: PublicKey,
  cfg: Cr1Config,
): Cr1Result {
  try {
    // ── Check 1: fee-payer correct ──────────────────────────────────────────
    const feePayer = tx.feePayer;
    if (feePayer === undefined || !feePayer.equals(feePayerPubkey)) {
      return reject('FEE_PAYER_MISMATCH');
    }

    const instructions = tx.instructions;
    const computeBudgetPk = ComputeBudgetProgram.programId;

    // ── Check 2: 1 or 2 business ix, escrow-whitelisted programId ────────────
    const businessIx = instructions.filter((ix) => !ix.programId.equals(computeBudgetPk));
    const cbIx = instructions.filter((ix) => ix.programId.equals(computeBudgetPk));
    // HU-SOL-20/R3: 1 (legacy form, byte-identical path) or 2 (`deposit` +
    // `register_escrow`, atomic) are allowed. 0 or >=3 keep rejecting with the
    // SAME enum (vectors T4a/T4b are untouched). Position 0 is ALWAYS the
    // `deposit`: no discriminator search, deterministic and fail-closed.
    if (businessIx.length !== 1 && businessIx.length !== 2) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }
    const deposit = businessIx[0];
    if (deposit === undefined) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }
    let escrowPk: PublicKey;
    try {
      escrowPk = new PublicKey(cfg.escrowProgramId);
    } catch {
      // Misconfigured whitelist programId → fail-closed.
      return reject('BAD_ESCROW_PROGRAM_ID_CONFIG');
    }
    if (!deposit.programId.equals(escrowPk)) {
      return reject('PROGRAM_NOT_WHITELISTED');
    }

    // ── Check 3: ComputeBudget bounded (<=2 ix; only SetCU limit/price) ──────
    if (cbIx.length > 2) {
      return reject('TOO_MANY_COMPUTE_BUDGET_IX');
    }
    // Conservative default: absent a SetComputeUnitLimit, assume the max cap so
    // the derived priority fee is an upper bound.
    let computeUnits = cfg.maxComputeUnits;
    let priceMicroLamports = 0n;
    let sawLimit = false;
    let sawPrice = false;
    for (const ix of cbIx) {
      const data = ix.data;
      if (data.length === 0) return reject('EMPTY_COMPUTE_BUDGET_IX');
      const kind = data.readUInt8(0);
      if (kind === CB_SET_COMPUTE_UNIT_LIMIT) {
        if (sawLimit) return reject('DUP_COMPUTE_UNIT_LIMIT');
        if (data.length < 5) return reject('BAD_COMPUTE_UNIT_LIMIT_DATA');
        const units = data.readUInt32LE(1);
        if (units > cfg.maxComputeUnits) return reject('COMPUTE_UNITS_ABOVE_MAX');
        computeUnits = units;
        sawLimit = true;
      } else if (kind === CB_SET_COMPUTE_UNIT_PRICE) {
        if (sawPrice) return reject('DUP_COMPUTE_UNIT_PRICE');
        if (data.length < 9) return reject('BAD_COMPUTE_UNIT_PRICE_DATA');
        const price = data.readBigUInt64LE(1);
        if (price > BigInt(cfg.maxPriorityFeeMicroLamports))
          return reject('PRIORITY_FEE_ABOVE_MAX');
        priceMicroLamports = price;
        sawPrice = true;
      } else {
        // RequestUnits/RequestHeapFrame/unknown — not allowed (CD-5).
        return reject('UNSUPPORTED_COMPUTE_BUDGET_IX');
      }
    }

    // ── Check 4: discriminator + `deposit` structure ────────────────────────
    const data = deposit.data;
    if (data.length < DEPOSIT_DISCRIMINATOR.length) {
      return reject('SHORT_DEPOSIT_DATA');
    }
    // Buffer.equals over the first 8 bytes — avoids per-index member access.
    const disc = Buffer.from(data.subarray(0, DEPOSIT_DISCRIMINATOR.length));
    if (!disc.equals(Buffer.from([...DEPOSIT_DISCRIMINATOR]))) {
      return reject('BAD_DISCRIMINATOR');
    }
    const keys = deposit.keys;
    if (keys.length < DEPOSIT_POSITIONAL_ACCOUNTS) {
      return reject('DEPOSIT_ACCOUNTS_MISSING');
    }
    // Destructure the 8 positional accounts by name (order = escrow-idl.ts).
    const [sender, , , , , tokenProgram, ataProgram, systemProgram] = keys;
    if (
      sender === undefined ||
      tokenProgram === undefined ||
      ataProgram === undefined ||
      systemProgram === undefined
    ) {
      return reject('DEPOSIT_ACCOUNTS_MISSING');
    }
    if (!sender.isSigner || !sender.isWritable) {
      return reject('SENDER_FLAGS_INVALID');
    }
    if (!tokenProgram.pubkey.equals(new PublicKey(TOKEN_PROGRAM_ID))) {
      return reject('TOKEN_PROGRAM_MISMATCH');
    }
    if (!ataProgram.pubkey.equals(new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))) {
      return reject('ASSOCIATED_TOKEN_PROGRAM_MISMATCH');
    }
    if (!systemProgram.pubkey.equals(new PublicKey(SYSTEM_PROGRAM_ID))) {
      return reject('SYSTEM_PROGRAM_MISMATCH');
    }
    // Remaining accounts (idx 8+) — the `reference` must be non-signer + non-writable.
    const remaining = keys.slice(DEPOSIT_POSITIONAL_ACCOUNTS);
    if (remaining.some((k) => k.isSigner || k.isWritable)) {
      return reject('REMAINING_ACCOUNT_FLAGS_INVALID');
    }

    // ── Check 4b: if a 2nd business ix exists it MUST be EXACTLY `register_escrow`
    // of the same escrow program, bound to THIS deposit (HU-SOL-20/R3). Strict
    // allowlist: programId + pinned discriminator + exact data length + exactly 4
    // accounts with fixed flags + sender/escrow_state/remittance_id binding. Any
    // deviation ⇒ reject WITHOUT signing. Everything new lives inside this `if`,
    // so the 1-business-ix path executes not a single new line (AC-R3-2).
    if (businessIx.length === 2) {
      const reg = businessIx[1];
      if (reg === undefined) return reject('SECOND_IX_ACCOUNTS_INVALID');
      // b1 — same escrow program (never another programId, nor ComputeBudget, nor SPL).
      if (!reg.programId.equals(escrowPk)) return reject('SECOND_IX_PROGRAM_NOT_WHITELISTED');
      // b2 — EXACT length (8 + 16). Not one byte more: closes the silent "extra arg".
      if (reg.data.length !== REGISTER_ESCROW_DATA_LEN) return reject('SECOND_IX_BAD_DATA_LEN');
      // b3 — pinned discriminator, compared byte-wise (CD-12: no anchor, no runtime IDL trust).
      const regDisc = Buffer.from(reg.data.subarray(0, REGISTER_ESCROW_DISCRIMINATOR.length));
      if (!regDisc.equals(Buffer.from([...REGISTER_ESCROW_DISCRIMINATOR]))) {
        return reject('SECOND_IX_BAD_DISCRIMINATOR');
      }
      // b4 — EXACTLY 4 accounts: no remaining ones, none extra.
      if (reg.keys.length !== REGISTER_ESCROW_POSITIONAL_ACCOUNTS) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      const regSender = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.SENDER];
      const regEscrowState = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.ESCROW_STATE];
      const regEscrowIndex = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.ESCROW_INDEX];
      const regSystemProgram = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.SYSTEM_PROGRAM];
      if (
        regSender === undefined ||
        regEscrowState === undefined ||
        regEscrowIndex === undefined ||
        regSystemProgram === undefined
      ) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b5 — EXACT flags per position. An extra writable is an account the tx can mutate.
      //
      // ⚠️ WHY `regEscrowState` is only checked for NON-SIGNER and not for non-writable:
      // in a Solana LEGACY message, is-signer/is-writable are TRANSACTION-level
      // properties (message header + accountKeys ordering), NOT per-instruction ones.
      // The production path is serialize → `parseSponsorTx` → `Transaction.from`
      // (broadcast.ts:96-118), and on that round-trip every meta of a given pubkey
      // collapses to the UNION over all instructions. `escrow_state` is legitimately
      // writable in the `deposit` (IDL: deposit.escrow_state.writable = true), so it
      // ALWAYS comes back writable in the 2nd ix too. Asserting non-writable here
      // would reject every legitimate atomic tx and take the money-path down.
      // No drain is enabled by allowing it: the account is pinned by b6 to be the
      // deposit's OWN `escrow_state`, the program declares it without `mut` in
      // `RegisterEscrow` (lib.rs:403-416) so it cannot be written by that ix, and
      // Check 5 still guarantees it is not the fee-payer.
      if (!regSender.isSigner || !regSender.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regEscrowState.isSigner) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regEscrowIndex.isSigner || !regEscrowIndex.isWritable) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      if (regSystemProgram.isSigner || regSystemProgram.isWritable) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      if (!regSystemProgram.pubkey.equals(new PublicKey(SYSTEM_PROGRAM_ID))) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b6 — BINDING to the deposit: same sender, same escrow_state, same remittance_id.
      // Without it an attacker could pair a legitimate deposit with the register of
      // something else. The deposit's data length is asserted ONLY here, so the
      // 1-ix path stays byte-identical.
      if (data.length < REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
      const depEscrowState = keys[DEPOSIT_ACCOUNT_INDEX.ESCROW_STATE];
      if (depEscrowState === undefined) return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      const depRid = Buffer.from(
        data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN),
      );
      const regRid = Buffer.from(
        reg.data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN),
      );
      if (
        !regSender.pubkey.equals(sender.pubkey) ||
        !regEscrowState.pubkey.equals(depEscrowState.pubkey) ||
        !regRid.equals(depRid)
      ) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
    }

    // ── Check 5: fee-payer is NEVER referenced by ANY instruction (AC-3/AC-8) ─
    // The fee-payer may appear ONLY as the implicit tx.feePayer (accountKeys[0]).
    // If its pubkey shows up in ANY instruction's account list, it could be a
    // Transfer source / SPL authority / the deposit sender (rent-payer) — all of
    // which are drain vectors. Strongest fail-closed rule; subsumes T5/T6/T7.
    for (const ix of instructions) {
      for (const k of ix.keys) {
        if (k.pubkey.equals(feePayerPubkey)) {
          return reject('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
        }
      }
    }

    // ── Fee upper bound = base (5000/sig) + priority (CU * price / 1e6) ──────
    const numSigners = BigInt(Math.max(1, tx.signatures.length));
    const priorityLamports = ceilDiv(BigInt(computeUnits) * priceMicroLamports, 1_000_000n);
    const feeUpperBoundLamports = BASE_FEE_LAMPORTS_PER_SIG * numSigners + priorityLamports;
    if (feeUpperBoundLamports > cfg.maxFeeLamports) {
      return reject('FEE_ABOVE_MAX');
    }

    return { ok: true, feeUpperBoundLamports };
  } catch {
    // CD-3: any thrown exception → fail-closed reject (never propagate, never sign).
    return reject('CR1_UNEXPECTED_ERROR');
  }
}
