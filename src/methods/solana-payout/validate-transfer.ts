/**
 * WKH-302 — CR-1 of the payout: re-parse the tx and authorize the signature.
 *
 * `validatePayoutTx(expected)` is a FACTORY that captures what the route intends to
 * pay and returns a `SponsorTxValidator` (the stable contract of
 * `methods/solana-sponsor/broadcast.ts`). The primitive signs ONLY if this returns
 * `{ ok:true }`.
 *
 * ⚠️ "But I built the tx myself, this is redundant." It is NOT. This is the only
 * defense against a future refactor of the builder changing the amount or the
 * destination without any gate noticing: the check is against the ROUTE's intent,
 * re-read from the serialized bytes that will actually be signed. It is the same
 * argument that justifies CR-1 for the sponsor. Do NOT turn it into
 * `() => ({ ok: true, ... })`.
 *
 * CD-12: no `@coral-xyz/anchor` and no IDL trust for PARSING — programs and tags
 * are compared by exact pubkey/byte.
 *
 * Fail-closed: every deviation, and any thrown exception, returns `{ ok:false }`
 * with a stable, PII-free `reason` and no echo of the tx.
 *
 * Boundary: imports `@solana/web3.js`, `./payout-shape.js`, `deriveAta` from
 * `../../chains/solana-escrow.js`, and the `SponsorTxValidator` type.
 */

import { PublicKey, type Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ATA_CREATE_IDEMPOTENT_TAG,
  SPL_TRANSFER_CHECKED_TAG,
  TOKEN_PROGRAM_ID,
} from './payout-shape.js';
import { deriveAta } from '../../chains/solana-escrow.js';
import type { SponsorTxValidator } from '../solana-sponsor/broadcast.js';

/** Base network fee per signature (lamports) — the current Solana constant. */
const BASE_FEE_LAMPORTS_PER_SIG = 5000n;

/** Byte layout of the `TransferChecked` ix data: tag + u64 LE amount + decimals. */
const TRANSFER_DATA_LEN = 10;
const AMOUNT_OFFSET = 1;
const DECIMALS_OFFSET = 9;

export interface ExpectedPayout {
  readonly payoutOperator: PublicKey;
  readonly payTo: PublicKey;
  readonly mint: PublicKey;
  readonly decimals: number;
  readonly amountAtomic: bigint;
  readonly maxFeeLamports: bigint;
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * Factory. Returns a validator asserting — fail-closed, in this exact order — that
 * the parsed tx is EXACTLY the payout the route intends, and only then yields the
 * derived fee upper bound so the primitive may sign.
 */
export function validatePayoutTx(expected: ExpectedPayout): SponsorTxValidator {
  return (tx: Transaction, feePayerPubkey: PublicKey) => {
    try {
      const instructions = tx.instructions;

      // ── Check 1: instruction count — exactly 1 (transfer) or 2 (create+transfer).
      if (instructions.length !== 1 && instructions.length !== 2) {
        return reject('UNEXPECTED_INSTRUCTION_COUNT');
      }
      const hasCreate = instructions.length === 2;
      const createIx = hasCreate ? instructions.at(0) : undefined;
      const transferIx = instructions.at(hasCreate ? 1 : 0);
      if (transferIx === undefined || (hasCreate && createIx === undefined)) {
        return reject('UNEXPECTED_INSTRUCTION_COUNT');
      }

      // ── Check 2: pinned programs, compared by pubkey.
      const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
      const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
      if (!transferIx.programId.equals(tokenProgram)) {
        return reject('TRANSFER_PROGRAM_NOT_TOKEN');
      }
      if (createIx !== undefined && !createIx.programId.equals(ataProgram)) {
        return reject('CREATE_PROGRAM_NOT_ATA');
      }

      // ── Check 3: feePayer == expected operator == the transfer authority (signer).
      const feePayer = tx.feePayer;
      if (feePayer === undefined || !feePayer.equals(expected.payoutOperator)) {
        return reject('FEE_PAYER_MISMATCH');
      }
      if (!feePayerPubkey.equals(expected.payoutOperator)) {
        return reject('SIGNER_NOT_EXPECTED_OPERATOR');
      }
      const authority = transferIx.keys.at(3);
      if (authority === undefined) return reject('TRANSFER_ACCOUNTS_MISSING');
      if (!authority.pubkey.equals(expected.payoutOperator) || !authority.isSigner) {
        return reject('AUTHORITY_INVALID');
      }

      // ── Check 4: instruction tag is TransferChecked (12), not Transfer (3).
      const data = transferIx.data;
      if (data.length !== TRANSFER_DATA_LEN) return reject('BAD_TRANSFER_DATA_LEN');
      if (data.readUInt8(0) !== SPL_TRANSFER_CHECKED_TAG) return reject('NOT_TRANSFER_CHECKED');

      // ── Check 5: mint + decimals carried by the ix match the expectation.
      const mintAcc = transferIx.keys.at(1);
      if (mintAcc === undefined) return reject('TRANSFER_ACCOUNTS_MISSING');
      if (!mintAcc.pubkey.equals(expected.mint)) return reject('MINT_MISMATCH');
      if (data.readUInt8(DECIMALS_OFFSET) !== expected.decimals) return reject('DECIMALS_MISMATCH');

      // ── Check 6: amount, as BigInt, EXACTLY equal (never >=).
      const amount = data.readBigUInt64LE(AMOUNT_OFFSET);
      if (amount !== expected.amountAtomic) return reject('AMOUNT_MISMATCH');

      // ── Check 7: source and destination are the DERIVED ATAs, nothing else.
      const sourceAcc = transferIx.keys.at(0);
      const destAcc = transferIx.keys.at(2);
      if (sourceAcc === undefined || destAcc === undefined) {
        return reject('TRANSFER_ACCOUNTS_MISSING');
      }
      if (!sourceAcc.pubkey.equals(deriveAta(expected.payoutOperator, expected.mint))) {
        return reject('SOURCE_ATA_MISMATCH');
      }
      if (!destAcc.pubkey.equals(deriveAta(expected.payTo, expected.mint))) {
        return reject('DESTINATION_ATA_MISMATCH');
      }

      // The create ix, when present, must target the SAME destination ATA/owner —
      // otherwise it is rent spent on an account nobody asked for.
      if (createIx !== undefined) {
        const createReason = validateCreateIx(createIx, expected, destAcc.pubkey);
        if (createReason !== null) return reject(createReason);
      }

      // ── Fee upper bound (same criterion as cr1-release.ts). One signer here.
      const numSigners = BigInt(Math.max(1, tx.signatures.length));
      const feeUpperBoundLamports = BASE_FEE_LAMPORTS_PER_SIG * numSigners;
      if (feeUpperBoundLamports > expected.maxFeeLamports) return reject('FEE_ABOVE_MAX');

      return { ok: true, feeUpperBoundLamports };
    } catch {
      // Any thrown exception → fail-closed reject (never propagate, never sign).
      return reject('PAYOUT_VALIDATOR_UNEXPECTED_ERROR');
    }
  };
}

/** Structural check of the optional ATA create. Returns a reason, or null if OK. */
function validateCreateIx(
  ix: TransactionInstruction,
  expected: ExpectedPayout,
  destinationAta: PublicKey,
): string | null {
  if (ix.data.length !== 1 || ix.data.readUInt8(0) !== ATA_CREATE_IDEMPOTENT_TAG) {
    return 'CREATE_NOT_IDEMPOTENT';
  }
  const funding = ix.keys.at(0);
  const ata = ix.keys.at(1);
  const owner = ix.keys.at(2);
  const mint = ix.keys.at(3);
  if (funding === undefined || ata === undefined || owner === undefined || mint === undefined) {
    return 'CREATE_ACCOUNTS_MISSING';
  }
  if (!funding.pubkey.equals(expected.payoutOperator)) return 'CREATE_FUNDER_MISMATCH';
  if (!ata.pubkey.equals(destinationAta)) return 'CREATE_ATA_MISMATCH';
  if (!owner.pubkey.equals(expected.payTo)) return 'CREATE_OWNER_MISMATCH';
  if (!mint.pubkey.equals(expected.mint)) return 'CREATE_MINT_MISMATCH';
  return null;
}
