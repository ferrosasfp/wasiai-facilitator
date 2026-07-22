/**
 * WKH-217 / HU-SOL-14 — CR-1 vectors (T1-T10). THE anti-drain suite.
 *
 * Fixtures are built with `@solana/web3.js` in this file (no anchor, no
 * spl-token): the canonical `deposit` and malicious variants. CR-1 is pure (no
 * network), so txs are constructed and passed to `validateDepositForSponsor`
 * directly. The ★ vectors (T2/T5/T6/T7) are the drain vectors — a "sign" on any
 * of them is a CRITICAL failure.
 *
 * CD-15: base58 program ids come from `deposit-shape.ts` (already justified).
 */

import { describe, it, expect } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { validateDepositForSponsor, type Cr1Config } from '../../methods/solana-sponsor/cr1.js';
import { parseSponsorTx } from '../../methods/solana-sponsor/broadcast.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEPOSIT_DISCRIMINATOR,
  ESCROW_PROGRAM_ID_DEFAULT,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../../methods/solana-sponsor/deposit-shape.js';

const ESCROW_PK = new PublicKey(ESCROW_PROGRAM_ID_DEFAULT);
const TOKEN_PK = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PK = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const SYS_PK = new PublicKey(SYSTEM_PROGRAM_ID);

const CFG: Cr1Config = {
  escrowProgramId: ESCROW_PROGRAM_ID_DEFAULT,
  maxComputeUnits: 300_000,
  maxPriorityFeeMicroLamports: 50_000,
  maxFeeLamports: 100_000n,
};

function depositData(disc: readonly number[] = DEPOSIT_DISCRIMINATOR): Buffer {
  return Buffer.concat([Buffer.from([...disc]), Buffer.alloc(16 + 32 + 32 + 8 + 8)]);
}

interface IxOverrides {
  sender?: PublicKey;
  reference?: PublicKey;
  disc?: readonly number[];
  breakSenderFlags?: boolean;
  wrongTokenProgram?: boolean;
  referenceWritable?: boolean;
  dropSystemProgram?: boolean;
}

function buildDepositIx(o: IxOverrides = {}): TransactionInstruction {
  const sender = o.sender ?? Keypair.generate().publicKey;
  const reference = o.reference ?? Keypair.generate().publicKey;
  const keys: AccountMeta[] = [
    { pubkey: sender, isSigner: !o.breakSenderFlags, isWritable: !o.breakSenderFlags },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // mint
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // escrow_state
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // vault
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // sender_ata
    {
      pubkey: o.wrongTokenProgram ? Keypair.generate().publicKey : TOKEN_PK,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: ATA_PK, isSigner: false, isWritable: false },
    {
      pubkey: o.dropSystemProgram ? Keypair.generate().publicKey : SYS_PK,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: reference, isSigner: false, isWritable: !!o.referenceWritable },
  ];
  return new TransactionInstruction({ programId: ESCROW_PK, keys, data: depositData(o.disc) });
}

interface TxOverrides extends IxOverrides {
  feePayer: PublicKey;
  extraIx?: TransactionInstruction[];
  omitDeposit?: boolean;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}

function buildDepositTx(o: TxOverrides): Transaction {
  const tx = new Transaction();
  if (o.computeUnitLimit !== undefined) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnitLimit }));
  }
  if (o.computeUnitPriceMicroLamports !== undefined) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.computeUnitPriceMicroLamports }),
    );
  }
  if (!o.omitDeposit) tx.add(buildDepositIx(o));
  if (o.extraIx) for (const ix of o.extraIx) tx.add(ix);
  tx.feePayer = o.feePayer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

/** Raw SPL-Token ix (no @solana/spl-token). `variant`: 3=transfer,6=setAuth,9=close. */
function splTokenIx(variant: number, authority: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: TOKEN_PK, keys, data: Buffer.from([variant]) });
}

describe('CR-1 validateDepositForSponsor', () => {
  const feePayer = Keypair.generate().publicKey;

  // ── T1 — happy (AC-1) ──────────────────────────────────────────────────────
  it('T1: exact deposit → { ok:true, feeUpperBoundLamports }', () => {
    const tx = buildDepositTx({ feePayer });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feeUpperBoundLamports).toBeGreaterThan(0n);
  });

  it('T1b: happy with in-range ComputeBudget → ok', () => {
    const tx = buildDepositTx({
      feePayer,
      computeUnitLimit: 200_000,
      computeUnitPriceMicroLamports: 10_000,
    });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(true);
  });

  // ── ★ T2 — extra ix (AC-2) — DRAIN VECTOR ──────────────────────────────────
  it('★ T2: deposit + extra SystemProgram.transfer → reject, NOT signed', () => {
    const tx = buildDepositTx({
      feePayer,
      extraIx: [systemTransfer(Keypair.generate().publicKey)],
    });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
  });

  // ── T3 — programId not whitelisted (AC-2) ──────────────────────────────────
  it('T3: single ix with a random programId → reject', () => {
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([1, 2, 3]),
      }),
    );
    tx.feePayer = feePayer;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PROGRAM_NOT_WHITELISTED');
  });

  // ── T4 — deposit absent / ix de menos (AC-2) ───────────────────────────────
  it('T4a: empty tx → reject', () => {
    const tx = new Transaction();
    tx.feePayer = feePayer;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  it('T4b: only ComputeBudget (no deposit) → reject', () => {
    const tx = buildDepositTx({ feePayer, omitDeposit: true, computeUnitLimit: 100_000 });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  // ── ★ T5 — fee-payer as Transfer source (AC-3) — DRAIN VECTOR ───────────────
  it('★ T5: SystemProgram.transfer({ from: feePayer }) → reject, NOT signed', () => {
    const tx = buildDepositTx({ feePayer, extraIx: [systemTransfer(feePayer)] });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
  });

  it('★ T5b: ONLY a SystemProgram.transfer({ from: feePayer }) (no deposit) → reject', () => {
    // Even if it were the only ix, the fee-payer must never be a transfer source.
    const tx = new Transaction();
    tx.add(systemTransfer(feePayer));
    tx.feePayer = feePayer;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
  });

  // ── ★ T6 — fee-payer as SPL authority (AC-3, 3 sub-vectors) — DRAIN VECTOR ──
  it('★ T6: SPL transfer/setAuthority/closeAccount with fee-payer authority → reject', () => {
    for (const variant of [3, 6, 9]) {
      const tx = buildDepositTx({ feePayer, extraIx: [splTokenIx(variant, feePayer)] });
      const r = validateDepositForSponsor(tx, feePayer, CFG);
      expect(r.ok).toBe(false);
    }
  });

  // ── ★ T7 — fee-payer as sender/rent-payer (AC-8) — DRAIN VECTOR ─────────────
  it('★ T7: deposit sender (account[0]) === feePayer → reject, NOT signed', () => {
    const tx = buildDepositTx({ feePayer, sender: feePayer });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
  });

  // ── ★ CR-MNR-4 — fee-payer at a NON-sender deposit index (AC-8) — DRAIN VECTOR ─
  it('★ CR-MNR-4: fee-payer injected as the `reference` account (idx 8, non-sender) → reject', () => {
    // T5/T6/T7 cover the fee-payer as transfer source / SPL authority / deposit
    // sender (idx 0). This vector places the fee-payer at a NON-zero account
    // index of the deposit itself — Check 5 (fee-payer referenced by ANY ix)
    // must still reject WITHOUT signing.
    const tx = buildDepositTx({ feePayer, reference: feePayer });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
  });

  // ── T8 — ComputeBudget out of range (AC-4) ─────────────────────────────────
  it('T8a: compute unit limit > max → reject', () => {
    const tx = buildDepositTx({ feePayer, computeUnitLimit: 400_000 });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('COMPUTE_UNITS_ABOVE_MAX');
  });

  it('T8b: priority fee > max → reject', () => {
    const tx = buildDepositTx({ feePayer, computeUnitPriceMicroLamports: 60_000 });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIORITY_FEE_ABOVE_MAX');
  });

  // ── T9 — wrong discriminator (AC-2) ────────────────────────────────────────
  it('T9: first 8 bytes ≠ deposit discriminator → reject', () => {
    const tx = buildDepositTx({ feePayer, disc: [0, 0, 0, 0, 0, 0, 0, 0] });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  // ── T10 — parse throws / corrupt bytes (AC-2 / CD-3) ───────────────────────
  it('T10a: corrupt base64 → parseSponsorTx rejects fail-closed (no throw)', () => {
    const r = parseSponsorTx('!!!not-valid-base64-@@@zzz');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_REJECTED');
  });

  it('T10b: malformed Transaction (feePayer undefined) → CR-1 rejects, no throw', () => {
    const tx = new Transaction(); // no feePayer, no ix
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_MISMATCH');
  });

  // ── extra structural coverage ──────────────────────────────────────────────
  it('rejects when the token program account is wrong', () => {
    const tx = buildDepositTx({ feePayer, wrongTokenProgram: true });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TOKEN_PROGRAM_MISMATCH');
  });

  it('rejects when the system program account is wrong', () => {
    const tx = buildDepositTx({ feePayer, dropSystemProgram: true });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SYSTEM_PROGRAM_MISMATCH');
  });

  it('rejects when the reference remaining account is writable', () => {
    const tx = buildDepositTx({ feePayer, referenceWritable: true });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('REMAINING_ACCOUNT_FLAGS_INVALID');
  });

  it('rejects when tx.feePayer does not match the sponsor pubkey', () => {
    const tx = buildDepositTx({ feePayer: Keypair.generate().publicKey });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_MISMATCH');
  });
});

/** System transfer helper (local — mirrors what a malicious caller would inject). */
function systemTransfer(from: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
}
