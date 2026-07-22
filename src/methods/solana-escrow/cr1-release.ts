/**
 * WKH-216 / HU-SOL-13 — Wave 13c: CR-1 of the `release` (THE anti-drain core).
 *
 * `validateReleaseForSponsor(state, cfg)` is a FACTORY that captures the on-chain
 * `EscrowState` (13b, read in the SAME invocation) and returns a `SponsorTxValidator`
 * (HU-SOL-14 stable contract, AH-21). Given the PARSED legacy `release` tx + the
 * release-authority pubkey, it asserts — fail-closed, in order — that the tx is
 * EXACTLY the expected `release` for THIS escrow, and that the release-authority
 * appears ONLY as the `authority` account (idx 0) and nowhere else. Only then does
 * it return the derived fee upper bound so `cosignAndBroadcast` may co-sign.
 *
 * ⚠️ VECTOR ESTRELLA: the release-authority signs + pays. If it co-signed an
 * opaque blob, an attacker could redirect the vault or drain the authority wallet.
 * Every check is fail-closed (CD-3): any deviation, and any thrown exception (a
 * top-level try/catch also rejects), returns `{ ok:false }` WITHOUT signing.
 *
 * ⚠️ NOT the deposit Check-5: in the `deposit` the feePayer must NOT appear in any
 * ix. In the `release` the feePayer (== authority) MUST appear as account idx 0
 * (signer) of the single whitelisted `release` ix — legitimate and required. The
 * anti-drain rule here is: the release-authority may appear ONLY at that position,
 * in NO other account slot and NO other instruction (blocks it as a Transfer
 * source / SPL authority / rent-payer of an injected ix).
 *
 * CD-12: no `@coral-xyz/anchor`, no IDL trust for the TX — discriminator + program
 * ids are compared by exact bytes/pubkey (the IDL/anchor only decodes the ACCOUNT).
 *
 * Boundary: imports `@solana/web3.js`, `./release-shape.js`, the `Cr1Config` +
 * `Cr1Result` types from `../solana-sponsor/cr1.js`, and the `EscrowStateDecoded`
 * type from `../../chains/solana-escrow.js`.
 */

import { ComputeBudgetProgram, PublicKey, type Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RELEASE_ACCOUNT_INDEX,
  RELEASE_DISCRIMINATOR,
  RELEASE_POSITIONAL_ACCOUNTS,
  TOKEN_PROGRAM_ID,
} from './release-shape.js';
import type { Cr1Config, Cr1Result } from '../solana-sponsor/cr1.js';
import type { EscrowStateDecoded } from '../../chains/solana-escrow.js';

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
 * Factory (CR-1 of the release). Captures the on-chain `state` + `cfg` and returns
 * a `SponsorTxValidator`. Returns `{ ok:true, feeUpperBoundLamports }` when every
 * check passes (blockhash freshness is checked by `cosignAndBroadcast`), else
 * `{ ok:false, reason }` — `reason` is a stable, PII-free enum with NO echo of the
 * tx or the state.
 */
export function validateReleaseForSponsor(
  state: EscrowStateDecoded,
  cfg: Cr1Config,
): (tx: Transaction, feePayerPubkey: PublicKey) => Cr1Result {
  return (tx: Transaction, feePayerPubkey: PublicKey): Cr1Result => {
    try {
      // ── Check 1: fee-payer (== release-authority) correct ───────────────────
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
      const release = businessIx[0];
      if (release === undefined) {
        return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
      }
      let escrowPk: PublicKey;
      try {
        escrowPk = new PublicKey(cfg.escrowProgramId);
      } catch {
        return reject('BAD_ESCROW_PROGRAM_ID_CONFIG');
      }
      if (!release.programId.equals(escrowPk)) {
        return reject('PROGRAM_NOT_WHITELISTED');
      }

      // ── Check 3: ComputeBudget bounded (<=2 ix; only SetCU limit/price) ──────
      if (cbIx.length > 2) {
        return reject('TOO_MANY_COMPUTE_BUDGET_IX');
      }
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
          return reject('UNSUPPORTED_COMPUTE_BUDGET_IX');
        }
      }

      // ── Check 4: discriminator + `release` account structure (AH-11) ─────────
      const data = release.data;
      if (data.length < RELEASE_DISCRIMINATOR.length) {
        return reject('SHORT_RELEASE_DATA');
      }
      const disc = Buffer.from(data.subarray(0, RELEASE_DISCRIMINATOR.length));
      if (!disc.equals(Buffer.from([...RELEASE_DISCRIMINATOR]))) {
        return reject('BAD_DISCRIMINATOR');
      }
      const keys = release.keys;
      if (keys.length < RELEASE_POSITIONAL_ACCOUNTS) {
        return reject('RELEASE_ACCOUNTS_MISSING');
      }
      // Destructure the positional accounts by name (order = AH-11). escrow_state
      // (4), vault (5), beneficiary_ata (6) are PDAs — enforced on-chain by the
      // program's seeds/has_one; not re-derived here.
      const [
        authorityAcc,
        senderAcc,
        beneficiaryAcc,
        mintAcc,
        ,
        ,
        ,
        tokenProgramAcc,
        ataProgramAcc,
      ] = keys;
      if (
        authorityAcc === undefined ||
        senderAcc === undefined ||
        beneficiaryAcc === undefined ||
        mintAcc === undefined ||
        tokenProgramAcc === undefined ||
        ataProgramAcc === undefined
      ) {
        return reject('RELEASE_ACCOUNTS_MISSING');
      }
      // authority (idx 0) MUST be the release-authority AND a signer (AC-3).
      if (!authorityAcc.pubkey.equals(feePayerPubkey) || !authorityAcc.isSigner) {
        return reject('AUTHORITY_INVALID');
      }
      // sender/beneficiary/mint MUST match the ON-CHAIN state (CD-4 — never the body).
      if (!senderAcc.pubkey.equals(new PublicKey(state.sender))) {
        return reject('SENDER_MISMATCH');
      }
      if (!beneficiaryAcc.pubkey.equals(new PublicKey(state.beneficiary))) {
        return reject('BENEFICIARY_MISMATCH');
      }
      if (!mintAcc.pubkey.equals(new PublicKey(state.mint))) {
        return reject('MINT_MISMATCH');
      }
      if (!tokenProgramAcc.pubkey.equals(new PublicKey(TOKEN_PROGRAM_ID))) {
        return reject('TOKEN_PROGRAM_MISMATCH');
      }
      if (!ataProgramAcc.pubkey.equals(new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))) {
        return reject('ASSOCIATED_TOKEN_PROGRAM_MISMATCH');
      }

      // ── Check 5 (ANTI-DRAIN): release-authority ONLY at authority idx 0 ──────
      // The release-authority may appear ONLY as the `authority` account (idx 0)
      // of the single whitelisted `release` ix. If its pubkey shows up in ANY
      // other account slot or ANY other instruction, that ix could use it as a
      // Transfer source / SPL authority / rent-payer — a drain vector. Reject.
      for (const ix of instructions) {
        const isRelease = ix === release;
        for (const [idx, k] of ix.keys.entries()) {
          if (k.pubkey.equals(feePayerPubkey)) {
            if (!(isRelease && idx === RELEASE_ACCOUNT_INDEX.AUTHORITY)) {
              return reject('AUTHORITY_REFERENCED_OUTSIDE_IDX0');
            }
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
      return reject('CR1_RELEASE_UNEXPECTED_ERROR');
    }
  };
}
