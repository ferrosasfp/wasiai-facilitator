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
  REGISTER_ESCROW_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../../methods/solana-sponsor/deposit-shape.js';
import { escrowIdl } from '../../chains/escrow-idl.js';

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
  /** HU-SOL-20/R3 — additive: pin `escrow_state` so the 2nd ix can be bound to it. */
  escrowState?: PublicKey;
  /** HU-SOL-20/R3 — additive: full ix-data override (to pin the `remittance_id`). */
  data?: Buffer;
}

function buildDepositIx(o: IxOverrides = {}): TransactionInstruction {
  const sender = o.sender ?? Keypair.generate().publicKey;
  const reference = o.reference ?? Keypair.generate().publicKey;
  const keys: AccountMeta[] = [
    { pubkey: sender, isSigner: !o.breakSenderFlags, isWritable: !o.breakSenderFlags },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // mint
    { pubkey: o.escrowState ?? Keypair.generate().publicKey, isSigner: false, isWritable: true }, // escrow_state
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
  return new TransactionInstruction({
    programId: ESCROW_PK,
    keys,
    data: o.data ?? depositData(o.disc),
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// HU-SOL-20 / R3 — CR-1 accepts the ATOMIC 2-business-ix tx (deposit + register_escrow)
//
// The 2nd ix allowlist is the most dangerous change in the epic: it is what keeps
// the sponsor from signing a tx that does something it never agreed to pay for.
// Every vector below asserts the EXACT `reason` (the 2 drain vectors are the
// deliberate exception: there, "does not sign" is the whole requirement).
//
// ⚠️ RECORDED CHANGE OF REJECTOR (AR-G4 BLQ-BAJO-1) — not a regression:
// pre-R3, deleting Check 5 turned `T5`, `T5b`, `T6`, `T7` and `CR-MNR-4` red. Post-R3
// only `T7` and `CR-MNR-4` still respond, because `T5`/`T5b`/`T6` inject a SECOND
// business ix (a SystemProgram/SPL transfer) and now die earlier — in Check 2 by
// count, or in Check 4b/b1 by programId — before Check 5 is reached. They only
// assert `ok === false`, so the change of rejector is invisible in their output. The
// set guarding Check 5 therefore narrowed from 5 vectors to 2, which is why `V-8`
// below was added: it restores coverage on the atomic form, on the real path.
//
// ⚠️ Vectors marked [RT] go through the REAL production path
// (serialize → `parseSponsorTx` → CR-1, routes/solana-sponsor.ts:148-152) instead
// of handing an in-memory `Transaction` to CR-1. That distinction is NOT cosmetic:
// in a Solana LEGACY message is-writable/is-signer are TRANSACTION-level, so on the
// round-trip each pubkey's metas collapse to the UNION over all instructions. A
// vector built only in memory can assert a per-instruction flag that cannot exist
// on the wire.
// ─────────────────────────────────────────────────────────────────────────────

/** Every escrow ix discriminator EXCEPT `register_escrow`, read from the vendored IDL. */
const NON_REGISTER_DISCRIMINATORS: ReadonlyArray<{ name: string; disc: readonly number[] }> =
  escrowIdl.instructions
    .filter((i) => i.name !== 'register_escrow')
    .map((i) => ({ name: i.name, disc: i.discriminator }));

interface RegOverrides {
  sender: PublicKey;
  escrowState: PublicKey;
  escrowIndex?: PublicKey;
  rid?: Buffer;
  disc?: readonly number[];
  programId?: PublicKey;
  dataLen?: number;
  extraAccount?: boolean;
  dropAccount?: boolean;
  escrowStateSigner?: boolean;
  escrowIndexSigner?: boolean;
  escrowIndexReadonly?: boolean;
  wrongSystemProgram?: boolean;
  systemProgramWritable?: boolean;
  senderNotSigner?: boolean;
}

function buildRegisterEscrowIx(o: RegOverrides): TransactionInstruction {
  const rid = o.rid ?? Buffer.alloc(16, 7);
  const disc = Buffer.from([...(o.disc ?? REGISTER_ESCROW_DISCRIMINATOR)]);
  let data = Buffer.concat([disc, rid]);
  if (o.dataLen !== undefined) {
    // Grow with zeros / truncate — the discriminator prefix is preserved either way.
    const grown = Buffer.alloc(Math.max(o.dataLen, data.length));
    data.copy(grown);
    data = grown.subarray(0, o.dataLen);
  }
  const keys: AccountMeta[] = [
    { pubkey: o.sender, isSigner: !o.senderNotSigner, isWritable: true },
    { pubkey: o.escrowState, isSigner: !!o.escrowStateSigner, isWritable: false },
    {
      pubkey: o.escrowIndex ?? Keypair.generate().publicKey,
      isSigner: !!o.escrowIndexSigner,
      isWritable: !o.escrowIndexReadonly,
    },
    {
      pubkey: o.wrongSystemProgram ? Keypair.generate().publicKey : SYS_PK,
      isSigner: false,
      isWritable: !!o.systemProgramWritable,
    },
  ];
  if (o.extraAccount) {
    keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false });
  }
  if (o.dropAccount) keys.pop();
  return new TransactionInstruction({ programId: o.programId ?? ESCROW_PK, keys, data });
}

/** A matched deposit+register pair: same sender, same escrow_state, same remittance_id. */
function buildAtomicPair(
  reg: Partial<Omit<RegOverrides, 'sender' | 'escrowState'>> = {},
  dep: IxOverrides = {},
): {
  deposit: TransactionInstruction;
  register: TransactionInstruction;
  sender: PublicKey;
  escrowState: PublicKey;
  rid: Buffer;
} {
  const sender = dep.sender ?? Keypair.generate().publicKey;
  const escrowState = dep.escrowState ?? Keypair.generate().publicKey;
  const rid = Buffer.alloc(16, 7);
  const depositData_ = Buffer.concat([
    Buffer.from([...DEPOSIT_DISCRIMINATOR]),
    rid,
    Buffer.alloc(32 + 32 + 8 + 8),
  ]);
  const deposit = buildDepositIx({ ...dep, sender, escrowState, data: depositData_ });
  const register = buildRegisterEscrowIx({ sender, escrowState, rid, ...reg });
  return { deposit, register, sender, escrowState, rid };
}

function txOf(feePayer: PublicKey, ...ix: TransactionInstruction[]): Transaction {
  const tx = new Transaction();
  for (const i of ix) tx.add(i);
  tx.feePayer = feePayer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

/**
 * A 2-business-ix tx ALWAYS carries an explicit `SetComputeUnitLimit`.
 * Post AR-G4/BLQ-MEDIO-1 that is a hard requirement, not decoration: absent the
 * ix the runtime would apply `200_000 * 2 = 400_000` CU, above the configured
 * 300_000 cap, and CR-1 rejects with `IMPLICIT_COMPUTE_UNITS_ABOVE_MAX` before it
 * ever reaches Check 4b (pinned by `V-13`). R4 must emit this ix, sized against
 * R1/T11's WORST case (79 826 CU), never against a single sample.
 */
const ATOMIC_CU_LIMIT = 200_000;
function atomicTx(feePayer: PublicKey, ...ix: TransactionInstruction[]): Transaction {
  return txOf(
    feePayer,
    ComputeBudgetProgram.setComputeUnitLimit({ units: ATOMIC_CU_LIMIT }),
    ...ix,
  );
}

/**
 * [RT] Serialize → `parseSponsorTx` → CR-1: the EXACT sequence production runs.
 * `sender` must sign so the message header reserves its signature slot.
 */
function validateViaWire(
  tx: Transaction,
  senderKp: Keypair,
  feePayer: PublicKey,
): ReturnType<typeof validateDepositForSponsor> {
  tx.partialSign(senderKp);
  const b64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  const parsed = parseSponsorTx(b64);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('fixture failed to serialize');
  return validateDepositForSponsor(parsed.tx, feePayer, CFG);
}

describe('CR-1 R3 — atomic deposit + register_escrow (2 business ix)', () => {
  const feePayer = Keypair.generate().publicKey;

  // ── T-R3-1 ★ happy, 2 ix (AC-R3-1) ─────────────────────────────────────────
  it('T-R3-1: deposit + well-formed bound register_escrow → ok', () => {
    const { deposit, register } = buildAtomicPair();
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feeUpperBoundLamports).toBeGreaterThan(0n);
  });

  // ── T-R3-2 happy, 2 ix + in-range ComputeBudget ─────────────────────────────
  it('T-R3-2: 2 business ix + in-range ComputeBudget → ok', () => {
    const { deposit, register } = buildAtomicPair();
    const tx = txOf(
      feePayer,
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      deposit,
      register,
    );
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(true);
  });

  // ── T-R3-3 ★ 1 ix legacy stays accepted (AC-R3-2) ───────────────────────────
  it('T-R3-3: the legacy 1-business-ix deposit is STILL accepted', () => {
    const tx = buildDepositTx({ feePayer });
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(true);
  });

  // ── T-R3-4 other programId ──────────────────────────────────────────────────
  it('T-R3-4: 2nd ix on another programId → SECOND_IX_PROGRAM_NOT_WHITELISTED', () => {
    const foreign = Keypair.generate().publicKey;
    const { deposit, register } = buildAtomicPair({ programId: foreign });
    expect(register.programId.equals(ESCROW_PK)).toBe(false); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_PROGRAM_NOT_WHITELISTED');
  });

  // ── T-R3-5 wrong discriminator (all 5 OTHER escrow ixs, from the IDL) ───────
  it('T-R3-5: 2nd ix with any NON-register escrow discriminator → SECOND_IX_BAD_DISCRIMINATOR', () => {
    // Covers the program's whole surface: 6 instructions total, so 5 non-register.
    expect(NON_REGISTER_DISCRIMINATORS.length).toBe(5);
    for (const { name, disc } of NON_REGISTER_DISCRIMINATORS) {
      const { deposit, register } = buildAtomicPair({ disc });
      expect(Array.from(register.data.subarray(0, 8))).toEqual([...disc]); // fixture honesty
      const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.reason, name).toBe('SECOND_IX_BAD_DISCRIMINATOR');
    }
  });

  // ── T-R3-6 data length ≠ 24 ─────────────────────────────────────────────────
  it('T-R3-6: 2nd ix data length 25 and 23 → SECOND_IX_BAD_DATA_LEN', () => {
    for (const dataLen of [25, 23]) {
      const { deposit, register } = buildAtomicPair({ dataLen });
      expect(register.data.length, `len ${dataLen}`).toBe(dataLen); // fixture honesty
      const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
      expect(r.ok, `len ${dataLen}`).toBe(false);
      if (!r.ok) expect(r.reason, `len ${dataLen}`).toBe('SECOND_IX_BAD_DATA_LEN');
    }
  });

  // ── T-R3-7 account count ≠ 4 ────────────────────────────────────────────────
  it('T-R3-7: 2nd ix with 5 accounts (injected remaining) and with 3 → SECOND_IX_ACCOUNTS_INVALID', () => {
    for (const variant of ['extraAccount', 'dropAccount'] as const) {
      const { deposit, register } = buildAtomicPair({ [variant]: true });
      expect(register.keys.length, variant).toBe(variant === 'extraAccount' ? 5 : 3); // honesty
      const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
      expect(r.ok, variant).toBe(false);
      if (!r.ok) expect(r.reason, variant).toBe('SECOND_IX_ACCOUNTS_INVALID');
    }
  });

  // ── T-R3-8 ★ escrow_state as a SIGNER ───────────────────────────────────────
  // NOTE (story deviation, see report): the story asked for `escrow_state` marked
  // WRITABLE here. That flag cannot be asserted: it is transaction-level and the
  // `deposit` legitimately makes escrow_state writable, so the union always brings
  // it back writable (see [RT] vectors below). Signer-ness is the flag that is
  // both assertable and meaningful, so that is what b5 pins and what this vector
  // and mutation M2 exercise.
  it('T-R3-8: 2nd ix escrow_state marked signer → SECOND_IX_ACCOUNTS_INVALID', () => {
    const { deposit, register } = buildAtomicPair({ escrowStateSigner: true });
    expect(register.keys[1]?.isSigner).toBe(true); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_ACCOUNTS_INVALID');
  });

  // ── T-R3-9 ★ escrow_index as signer / read-only ─────────────────────────────
  it('T-R3-9: 2nd ix escrow_index marked signer (and read-only) → SECOND_IX_ACCOUNTS_INVALID', () => {
    for (const variant of ['escrowIndexSigner', 'escrowIndexReadonly'] as const) {
      const { deposit, register } = buildAtomicPair({ [variant]: true });
      if (variant === 'escrowIndexSigner') expect(register.keys[2]?.isSigner).toBe(true);
      else expect(register.keys[2]?.isWritable).toBe(false); // fixture honesty
      const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
      expect(r.ok, variant).toBe(false);
      if (!r.ok) expect(r.reason, variant).toBe('SECOND_IX_ACCOUNTS_INVALID');
    }
  });

  // ── T-R3-10 ★ system_program swapped / writable ─────────────────────────────
  it('T-R3-10: 2nd ix system_program replaced or writable → SECOND_IX_ACCOUNTS_INVALID', () => {
    for (const variant of ['wrongSystemProgram', 'systemProgramWritable'] as const) {
      const { deposit, register } = buildAtomicPair({ [variant]: true });
      if (variant === 'wrongSystemProgram')
        expect(register.keys[3]?.pubkey.equals(SYS_PK)).toBe(false);
      else expect(register.keys[3]?.isWritable).toBe(true); // fixture honesty
      const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
      expect(r.ok, variant).toBe(false);
      if (!r.ok) expect(r.reason, variant).toBe('SECOND_IX_ACCOUNTS_INVALID');
    }
  });

  // ── T-R3-11 ★ binding broken: sender ────────────────────────────────────────
  it('T-R3-11: 2nd ix sender ≠ deposit sender → SECOND_IX_NOT_BOUND_TO_DEPOSIT', () => {
    const { deposit, escrowState, rid } = buildAtomicPair();
    const other = Keypair.generate().publicKey;
    const register = buildRegisterEscrowIx({ sender: other, escrowState, rid });
    expect(register.keys[0]?.pubkey.equals(deposit.keys[0]!.pubkey)).toBe(false); // honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
  });

  // ── T-R3-12 ★ binding broken: escrow_state ──────────────────────────────────
  it('T-R3-12: 2nd ix escrow_state ≠ deposit escrow_state → SECOND_IX_NOT_BOUND_TO_DEPOSIT', () => {
    const { deposit, sender, rid } = buildAtomicPair();
    const register = buildRegisterEscrowIx({
      sender,
      escrowState: Keypair.generate().publicKey,
      rid,
    });
    expect(register.keys[1]?.pubkey.equals(deposit.keys[2]!.pubkey)).toBe(false); // honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
  });

  // ── T-R3-13 ★ binding broken: remittance_id ─────────────────────────────────
  it('T-R3-13: 2nd ix remittance_id ≠ deposit remittance_id → SECOND_IX_NOT_BOUND_TO_DEPOSIT', () => {
    const { deposit, register } = buildAtomicPair({ rid: Buffer.alloc(16, 9) });
    expect(register.data.subarray(8, 24).equals(deposit.data.subarray(8, 24))).toBe(false); // honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
  });

  // ── T-R3-14 ★★ DRAIN: register sender = fee-payer (AC-R3-4) ─────────────────
  it('★★ T-R3-14: 2nd ix sender === feePayer → reject, NOT signed', () => {
    const { deposit, escrowState, rid } = buildAtomicPair();
    const register = buildRegisterEscrowIx({ sender: feePayer, escrowState, rid });
    expect(register.keys[0]?.pubkey.equals(feePayer)).toBe(true); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false); // reason may be SECOND_IX_* or FEE_PAYER_*: what matters is NOT signing
  });

  // ── T-R3-15 ★★ DRAIN: escrow_index = fee-payer (AC-R3-4) ────────────────────
  it('★★ T-R3-15: 2nd ix escrow_index === feePayer → reject, NOT signed', () => {
    const { deposit, register } = buildAtomicPair({ escrowIndex: feePayer });
    expect(register.keys[2]?.pubkey.equals(feePayer)).toBe(true); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
  });

  // ── T-R3-16 ★★ DRAIN: 2 legit ix + a 3rd transfer from the fee-payer ────────
  it('★★ T-R3-16: 2 legit business ix + SystemProgram.transfer({from:feePayer}) → NOT_EXACTLY_ONE_BUSINESS_IX', () => {
    const { deposit, register } = buildAtomicPair();
    const tx = atomicTx(feePayer, deposit, register, systemTransfer(feePayer));
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  // ── T-R3-17 order inverted: register first ──────────────────────────────────
  it('T-R3-17: register_escrow at position 0 and deposit at 1 → BAD_DISCRIMINATOR', () => {
    const { deposit, register } = buildAtomicPair();
    const r = validateDepositForSponsor(atomicTx(feePayer, register, deposit), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  // ── T-R3-18 2nd ix duplicating the deposit ──────────────────────────────────
  it('T-R3-18: 2nd ix duplicating the deposit → rejected (length gate fires before the discriminator)', () => {
    // Verbatim duplicate: the deposit's data is 104 bytes, so b2 (exact length)
    // rejects BEFORE b3 can look at the discriminator. The story predicted
    // SECOND_IX_BAD_DISCRIMINATOR; the real gate order makes it BAD_DATA_LEN.
    const { deposit } = buildAtomicPair();
    const dup = validateDepositForSponsor(atomicTx(feePayer, deposit, deposit), feePayer, CFG);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('SECOND_IX_BAD_DATA_LEN');
    // Same intent, past the length gate: a deposit discriminator in a 24-byte ix.
    const pair = buildAtomicPair({ disc: DEPOSIT_DISCRIMINATOR });
    const r = validateDepositForSponsor(
      atomicTx(feePayer, pair.deposit, pair.register),
      feePayer,
      CFG,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_BAD_DISCRIMINATOR');
  });

  // ── T-R3-19 three business ix ───────────────────────────────────────────────
  it('T-R3-19: 3 business ix (deposit + register + register) → NOT_EXACTLY_ONE_BUSINESS_IX', () => {
    const { deposit, register } = buildAtomicPair();
    const r = validateDepositForSponsor(
      atomicTx(feePayer, deposit, register, register),
      feePayer,
      CFG,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  // T-R3-20 is the pre-existing T4a/T4b (0 business ix) — deliberately NOT duplicated here.

  // ───────────────────────────────────────────────────────────────────────────
  // Vectors added beyond the story's 20 (V-*): attacker-driven and round-trip.
  // ───────────────────────────────────────────────────────────────────────────

  // ── V-1 ★★: the declared bound vs what the CLUSTER ACTUALLY CHARGES ─────────
  //
  // ⚠️ This vector replaces a vacuous one (AR-G4). The first version asserted that
  // `feeUpperBoundLamports` was IDENTICAL for the 1-ix and 2-ix forms. That was
  // true (25 000 = 25 000) and it passed — but it compared OUR OWN prediction to
  // itself while the real cost rose 50%. The lesson: never assert a number we
  // computed; assert it against the number the runtime charges.
  //
  // Every literal below was MEASURED with solana-bankrun (2 signers, real
  // `processTransaction`, fee-payer balance before/after), NOT derived from the
  // code under test:
  //   price 50 000 µL, NO SetComputeUnitLimit: 1 business ix → 20 000 lamports,
  //                                            2 → 30 000, 3 → 40 000
  //   price 50 000 µL, SetComputeUnitLimit(200 000): → 20 000
  //   price 50 000 µL, SetComputeUnitLimit(300 000): → 25 000
  //   no price ix at all:                            → 10 000 (base only)
  // CU actually consumed in those runs was 300/450/600: the priority fee follows
  // the LIMIT, never consumption.
  // Goes through the WIRE so `numSigners` is really 2 (feePayer + sender), matching
  // the measurement's conditions. An unsigned in-memory tx reports 1 signer and the
  // comparison against the measured lamports would be meaningless.
  it('★★ V-1 [RT]: feeUpperBoundLamports vs the lamports the runtime really charges (measured)', () => {
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
    // (a) legacy 1 ix, no SetComputeUnitLimit ⇒ runtime limit 200 000 ⇒ charged 20 000.
    const kpA = Keypair.generate();
    const one = validateViaWire(
      txOf(feePayer, price, buildDepositIx({ sender: kpA.publicKey })),
      kpA,
      feePayer,
    );
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.feeUpperBoundLamports).toBe(20_000n); // == measured, exact
    // (b) atomic 2 ix with SetComputeUnitLimit(200 000) ⇒ charged 20 000.
    const kpB = Keypair.generate();
    const pairB = buildAtomicPair({}, { sender: kpB.publicKey });
    const two = validateViaWire(
      txOf(
        feePayer,
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        price,
        pairB.deposit,
        pairB.register,
      ),
      kpB,
      feePayer,
    );
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.feeUpperBoundLamports).toBe(20_000n); // == measured, exact
    // (c) the form that used to under-reserve (2 ix, no limit ⇒ really 30 000 charged
    //     while CR-1 declared 25 000) is now REJECTED, so it can never be signed.
    const kpC = Keypair.generate();
    const pairC = buildAtomicPair({}, { sender: kpC.publicKey });
    const under = validateViaWire(
      txOf(feePayer, price, pairC.deposit, pairC.register),
      kpC,
      feePayer,
    );
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toBe('IMPLICIT_COMPUTE_UNITS_ABOVE_MAX');
  });

  // ── V-13 ★★: the CU cap can no longer be evaded by OMITTING the ix ──────────
  it('★★ V-13: 2 business ix without SetComputeUnitLimit → IMPLICIT_COMPUTE_UNITS_ABOVE_MAX', () => {
    // Implicit limit = 200_000 * 2 = 400_000 > cfg.maxComputeUnits (300_000).
    const { deposit, register } = buildAtomicPair();
    const r = validateDepositForSponsor(txOf(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('IMPLICIT_COMPUTE_UNITS_ABOVE_MAX');
  });

  it('V-13b: 1 business ix without SetComputeUnitLimit is STILL accepted (200_000 <= cap)', () => {
    // The new gate must not touch the legacy form: this is the compatibility half
    // of V-13, and the reason the rule is `200_000 * n` and not a flat rejection.
    const r = validateDepositForSponsor(txOf(feePayer, buildDepositIx()), feePayer, CFG);
    expect(r.ok).toBe(true);
  });

  it('V-13c: 2 business ix WITH SetComputeUnitLimit above the cap → COMPUTE_UNITS_ABOVE_MAX', () => {
    // The declared path keeps its own, distinct enum — the two gates do not merge.
    const { deposit, register } = buildAtomicPair();
    const r = validateDepositForSponsor(
      txOf(
        feePayer,
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        deposit,
        register,
      ),
      feePayer,
      CFG,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('COMPUTE_UNITS_ABOVE_MAX');
  });

  // ── V-2 ★★: a LONE register_escrow must never be sponsored ──────────────────
  it('★★ V-2: register_escrow ALONE (no deposit) → BAD_DISCRIMINATOR, never sponsored', () => {
    // Explicitly prohibited: a register with no deposit attached is work the
    // sponsor pays for with no consideration ⇒ a fee-budget drain vector.
    const sender = Keypair.generate().publicKey;
    const register = buildRegisterEscrowIx({
      sender,
      escrowState: Keypair.generate().publicKey,
    });
    const r = validateDepositForSponsor(txOf(feePayer, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  // ── V-3 ★★ [RT]: the happy path through the REAL production path ────────────
  it('★★ V-3 [RT]: atomic 2-ix tx via serialize → parseSponsorTx → CR-1 → ok', () => {
    // THE vector that catches a per-instruction flag assertion that cannot hold
    // on the wire. Without it, T-R3-1 can be green while the money-path is dead.
    const senderKp = Keypair.generate();
    const { deposit, register } = buildAtomicPair({}, { sender: senderKp.publicKey });
    const r = validateViaWire(atomicTx(feePayer, deposit, register), senderKp, feePayer);
    expect(r.ok).toBe(true);
  });

  it('★★ V-3b [RT]: on the wire, escrow_state comes back WRITABLE in the 2nd ix', () => {
    // Pins the reason b5 cannot assert non-writable for escrow_state: legacy
    // messages carry tx-level flags, so the deposit's `mut` leaks into ix[1].
    const senderKp = Keypair.generate();
    const { deposit, register } = buildAtomicPair({}, { sender: senderKp.publicKey });
    const tx = atomicTx(feePayer, deposit, register);
    // ix[0] is the SetComputeUnitLimit, so the register is ix[2]. Identify it
    // positively FIRST, so an index slip cannot turn this vector into a tautology.
    expect(tx.instructions.length).toBe(3);
    expect(tx.instructions[2]?.programId.equals(ESCROW_PK)).toBe(true);
    expect(tx.instructions[2]?.keys.length).toBe(4);
    expect(tx.instructions[2]?.keys[1]?.isWritable).toBe(false); // in memory: read-only
    tx.partialSign(senderKp);
    const parsed = parseSponsorTx(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tx.instructions[2]?.keys[1]?.isWritable).toBe(true); // on the wire: writable
  });

  // ── V-4 [RT]: the legacy 1-ix form through the real path ────────────────────
  it('V-4 [RT]: legacy 1-ix deposit via serialize → parseSponsorTx → CR-1 → ok', () => {
    const senderKp = Keypair.generate();
    const tx = buildDepositTx({ feePayer, sender: senderKp.publicKey });
    const r = validateViaWire(tx, senderKp, feePayer);
    expect(r.ok).toBe(true);
  });

  // ── V-5: short deposit data cannot be bound ─────────────────────────────────
  it('V-5: deposit data truncated to 8 bytes + valid register → SECOND_IX_NOT_BOUND_TO_DEPOSIT', () => {
    const sender = Keypair.generate().publicKey;
    const escrowState = Keypair.generate().publicKey;
    const deposit = buildDepositIx({
      sender,
      escrowState,
      data: Buffer.from([...DEPOSIT_DISCRIMINATOR]),
    });
    expect(deposit.data.length).toBe(8); // fixture honesty
    const register = buildRegisterEscrowIx({ sender, escrowState });
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
  });

  // ── V-6: b6's length gate must NOT leak into the legacy path ────────────────
  it('V-6: legacy 1-ix deposit with 8-byte data is STILL ok (b6 did not leak)', () => {
    const tx = txOf(feePayer, buildDepositIx({ data: Buffer.from([...DEPOSIT_DISCRIMINATOR]) }));
    const r = validateDepositForSponsor(tx, feePayer, CFG);
    expect(r.ok).toBe(true); // pre-R3 behaviour, byte-identical
  });

  // ── V-7 [RT]: fee-payer as escrow_index on the wire ─────────────────────────
  //
  // ⚠️ CORRECTED LABEL (AR-G4 BLQ-BAJO-1): this is NOT "the drain vector through the
  // real path". On the wire the fee-payer is a REQUIRED SIGNER, so the union marks
  // this account `isSigner` and b5's `regEscrowIndex.isSigner` rejects it before
  // Check 5 is ever consulted — the vector stays green with Check 5 deleted. It
  // documents b5's defence in depth; `V-8` below is the one that pins Check 5 on the
  // real path. Asserting the exact rejector is what makes that distinction visible.
  it('V-7 [RT]: escrow_index === feePayer on the wire → rejected by b5, not by Check 5', () => {
    const senderKp = Keypair.generate();
    const { deposit, register } = buildAtomicPair(
      { escrowIndex: feePayer },
      { sender: senderKp.publicKey },
    );
    const r = validateViaWire(atomicTx(feePayer, deposit, register), senderKp, feePayer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_ACCOUNTS_INVALID'); // b5, NOT Check 5
  });

  // ── V-8 ★★ [RT]: THE worst drain, and Check 5 is its only rejector ───────────
  //
  // AR-G4 BLQ-BAJO-1: `deposit.sender === feePayer` with the register CORRECTLY
  // BOUND to it, on the wire. Such a tx would debit the fee-payer's own USDC ATA and
  // charge it the rent of both the escrow and the index. Nothing else stops it:
  // `T7` covers only the 1-ix form, and `T-R3-14` uses a DIFFERENT regSender so it
  // dies in b6 and never reaches here. Under M7 the AR measured this exact shape as
  // *** ACCEPTED — SPONSOR SIGNS A DRAIN ***, so this is the vector that gives the
  // atomic form real coverage of the anti-drain core on the production path.
  it('★★ V-8 [RT]: deposit.sender === feePayer with a BOUND register → FEE_PAYER_REFERENCED_IN_INSTRUCTION', () => {
    const feePayerKp = Keypair.generate();
    const fp = feePayerKp.publicKey;
    // The whole pair is built around the fee-payer as the sender, so b1..b6 all pass
    // and Check 5 is the only gate left.
    const { deposit, register } = buildAtomicPair({}, { sender: fp });
    expect(deposit.keys[0]?.pubkey.equals(fp)).toBe(true); // fixture honesty
    expect(register.keys[0]?.pubkey.equals(fp)).toBe(true); // bound to the SAME sender
    expect(register.data.subarray(8, 24).equals(deposit.data.subarray(8, 24))).toBe(true);
    const tx = atomicTx(fp, deposit, register);
    // sender === feePayer, so the fee-payer's own key is the only signature slot.
    const r = validateViaWire(tx, feePayerKp, fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
  });

  // ── V-9: position-0 discipline (no discriminator search) ────────────────────
  it('V-9: two register_escrow ixs (no deposit at all) → BAD_DISCRIMINATOR', () => {
    const sender = Keypair.generate().publicKey;
    const escrowState = Keypair.generate().publicKey;
    const a = buildRegisterEscrowIx({ sender, escrowState });
    const b = buildRegisterEscrowIx({ sender, escrowState });
    const r = validateDepositForSponsor(atomicTx(feePayer, a, b), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  // ── V-10: the atomic form keeps supporting the x402 `reference` account ─────
  it('V-10: atomic 2-ix with the deposit carrying its x402 `reference` remaining account → ok', () => {
    const reference = Keypair.generate().publicKey;
    const { deposit, register } = buildAtomicPair({}, { reference });
    expect(deposit.keys[8]?.pubkey.equals(reference)).toBe(true); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(true);
  });

  // ── V-11: the remittance_id binding is byte-exact, not a prefix ─────────────
  it('V-11: register remittance_id differing in the LAST byte only → SECOND_IX_NOT_BOUND_TO_DEPOSIT', () => {
    const rid = Buffer.alloc(16, 7);
    rid[15] = 8; // differs from the deposit's rid (all 7s) in the final byte only
    const { deposit, register } = buildAtomicPair({ rid });
    expect(register.data.subarray(8, 23).equals(deposit.data.subarray(8, 23))).toBe(true); // 15 bytes equal
    expect(register.data[23]).not.toBe(deposit.data[23]); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
  });

  // ── V-12: sender not a signer in the 2nd ix ─────────────────────────────────
  it('V-12: 2nd ix sender not marked signer → SECOND_IX_ACCOUNTS_INVALID', () => {
    const { deposit, register } = buildAtomicPair({ senderNotSigner: true });
    expect(register.keys[0]?.isSigner).toBe(false); // fixture honesty
    const r = validateDepositForSponsor(atomicTx(feePayer, deposit, register), feePayer, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SECOND_IX_ACCOUNTS_INVALID');
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
