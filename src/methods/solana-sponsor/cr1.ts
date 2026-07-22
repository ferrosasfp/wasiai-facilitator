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
  DEPOSIT_DISCRIMINATOR,
  DEPOSIT_POSITIONAL_ACCOUNTS,
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

    // ── Check 2: exactly 1 business ix, escrow-whitelisted programId ─────────
    const businessIx = instructions.filter((ix) => !ix.programId.equals(computeBudgetPk));
    const cbIx = instructions.filter((ix) => ix.programId.equals(computeBudgetPk));
    if (businessIx.length !== 1) {
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
