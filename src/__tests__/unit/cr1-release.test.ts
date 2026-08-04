/**
 * WKH-216 / HU-SOL-13 — Wave 13c: CR-1 of the release (TF3-TF5). THE anti-drain suite.
 *
 * Fixtures are built with `@solana/web3.js` in this file (no anchor, no spl-token):
 * the canonical `release` and malicious variants, then passed to
 * `validateReleaseForSponsor(state, cfg)`. CR-1 is pure (no network). The ★ vectors
 * (TF4/TF5) are the drain vectors — a "sign" on any of them is a CRITICAL failure.
 */

import { describe, it, expect } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { validateReleaseForSponsor } from '../../methods/solana-escrow/cr1-release.js';
import { buildReleaseTx as buildProdReleaseTx } from '../../methods/solana-escrow/build-release.js';
import { parseSponsorTx } from '../../methods/solana-sponsor/broadcast.js';
import type { Cr1Config } from '../../methods/solana-sponsor/cr1.js';
import type { EscrowStateDecoded } from '../../chains/solana-escrow.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ESCROW_PROGRAM_ID_DEFAULT,
  RELEASE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
} from '../../methods/solana-escrow/release-shape.js';

const ESCROW_PK = new PublicKey(ESCROW_PROGRAM_ID_DEFAULT);
const TOKEN_PK = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PK = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);

const CFG: Cr1Config = {
  escrowProgramId: ESCROW_PROGRAM_ID_DEFAULT,
  maxComputeUnits: 300_000,
  maxPriorityFeeMicroLamports: 50_000,
  maxFeeLamports: 100_000n,
  // Campo del `deposit`; `validateReleaseForSponsor` no lo lee (el mint del release
  // lo verifica `verifyVault` contra el EscrowState on-chain). Va poblado igual para
  // que ningún vector de acá dependa de que valga `undefined`.
  // eslint-disable-next-line no-secrets/no-secrets -- mint USDC devnet de Circle (base58 público), no es un secreto.
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

// Fixed identities shared between the on-chain `state` and the tx accounts.
const AUTHORITY = Keypair.generate().publicKey; // release-authority == feePayer
const SENDER = Keypair.generate().publicKey;
const BENEFICIARY = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const ESCROW_STATE = Keypair.generate().publicKey;
const VAULT = Keypair.generate().publicKey;
const BENEFICIARY_ATA = Keypair.generate().publicKey;

const STATE: EscrowStateDecoded = {
  sender: SENDER.toBase58(),
  beneficiary: BENEFICIARY.toBase58(),
  authority: AUTHORITY.toBase58(),
  mint: MINT.toBase58(),
  amount: '3000000',
  deadline: '1790000000',
  status: 'Deposited',
  bump: 254,
  escrowStatePda: ESCROW_STATE.toBase58(),
  vault: VAULT.toBase58(),
};

const validate = validateReleaseForSponsor(STATE, CFG);

function releaseData(disc: readonly number[] = RELEASE_DISCRIMINATOR): Buffer {
  return Buffer.concat([Buffer.from([...disc]), Buffer.alloc(16)]);
}

interface IxOverrides {
  authority?: PublicKey;
  authorityNotSigner?: boolean;
  sender?: PublicKey;
  beneficiary?: PublicKey;
  mint?: PublicKey;
  tokenProgram?: PublicKey;
  ataProgram?: PublicKey;
  disc?: readonly number[];
}

function buildReleaseIx(o: IxOverrides = {}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: o.authority ?? AUTHORITY, isSigner: !o.authorityNotSigner, isWritable: false },
    { pubkey: o.sender ?? SENDER, isSigner: false, isWritable: false },
    { pubkey: o.beneficiary ?? BENEFICIARY, isSigner: false, isWritable: false },
    { pubkey: o.mint ?? MINT, isSigner: false, isWritable: false },
    { pubkey: ESCROW_STATE, isSigner: false, isWritable: true },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: BENEFICIARY_ATA, isSigner: false, isWritable: true },
    { pubkey: o.tokenProgram ?? TOKEN_PK, isSigner: false, isWritable: false },
    { pubkey: o.ataProgram ?? ATA_PK, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: ESCROW_PK, keys, data: releaseData(o.disc) });
}

interface TxOverrides extends IxOverrides {
  feePayer?: PublicKey;
  extraIx?: TransactionInstruction[];
  omitRelease?: boolean;
}

function buildReleaseTx(o: TxOverrides = {}): Transaction {
  const tx = new Transaction();
  if (!o.omitRelease) tx.add(buildReleaseIx(o));
  if (o.extraIx) for (const ix of o.extraIx) tx.add(ix);
  tx.feePayer = o.feePayer ?? AUTHORITY;
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

function systemTransfer(from: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
}

describe('CR-1 validateReleaseForSponsor', () => {
  // ── TF3 — happy (AC-3) ──────────────────────────────────────────────────────
  it('TF3: exact release + matching state → { ok:true, feeUpperBoundLamports }', () => {
    const r = validate(buildReleaseTx(), AUTHORITY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feeUpperBoundLamports).toBeGreaterThan(0n);
  });

  it('TF3: build-release output round-trips through parse → CR-1 accepts it', () => {
    // The PRODUCTION builder + a real serialize/re-parse (as cosignAndBroadcast
    // does) must yield a tx CR-1 authorizes — proves builder/validator agreement
    // and that the authority signer flag survives feePayer compilation.
    const base64 = buildProdReleaseTx({
      state: STATE,
      remittanceId: 'rem-abc-123',
      authority: AUTHORITY,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      escrowProgramId: ESCROW_PROGRAM_ID_DEFAULT,
    });
    const parsed = parseSponsorTx(base64);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = validate(parsed.tx, AUTHORITY);
    expect(r.ok).toBe(true);
  });

  // ── ★ TF4 — beneficiary injected (AC-4 / CD-4) — DRAIN VECTOR ────────────────
  it('★ TF4: account beneficiary ≠ state.beneficiary → reject, NOT signed', () => {
    const r = validate(buildReleaseTx({ beneficiary: Keypair.generate().publicKey }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BENEFICIARY_MISMATCH');
  });

  // ── ★ TF5 — anti-drain family (AC-3/AC-4) ────────────────────────────────────
  it('★ TF5a: authority account ≠ release-authority → reject', () => {
    const r = validate(buildReleaseTx({ authority: Keypair.generate().publicKey }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('AUTHORITY_INVALID');
  });

  it('★ TF5b: authority account present but NOT a signer → reject', () => {
    const r = validate(buildReleaseTx({ authorityNotSigner: true }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('AUTHORITY_INVALID');
  });

  it('★ TF5c: discriminator ≠ release → reject', () => {
    const r = validate(buildReleaseTx({ disc: [0, 0, 0, 0, 0, 0, 0, 0] }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  it('★ TF5d: extra SystemProgram.transfer({ from: release-authority }) → reject', () => {
    const r = validate(buildReleaseTx({ extraIx: [systemTransfer(AUTHORITY)] }), AUTHORITY);
    expect(r.ok).toBe(false);
  });

  it('★ TF5e: extra SPL setAuthority/close/transfer using release-authority → reject', () => {
    for (const variant of [3, 6, 9]) {
      const r = validate(buildReleaseTx({ extraIx: [splTokenIx(variant, AUTHORITY)] }), AUTHORITY);
      expect(r.ok).toBe(false);
    }
  });

  it('★ TF5f: release-authority injected at a NON-authority account slot → reject', () => {
    // Place the release-authority as the `sender` (idx 1) too. It must appear
    // ONLY at authority idx 0 — anywhere else is an anti-drain violation. (sender
    // mismatch OR the anti-drain scan rejects; either way, NOT signed.)
    const r = validate(buildReleaseTx({ sender: AUTHORITY }), AUTHORITY);
    expect(r.ok).toBe(false);
  });

  it('★ TF5g: whole extra ix whitelisted-program but non-release discriminator → reject', () => {
    const rogue = new TransactionInstruction({
      programId: ESCROW_PK,
      keys: [{ pubkey: AUTHORITY, isSigner: true, isWritable: false }],
      data: releaseData([9, 9, 9, 9, 9, 9, 9, 9]),
    });
    const r = validate(buildReleaseTx({ extraIx: [rogue] }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  // ── structural coverage ─────────────────────────────────────────────────────
  it('rejects when feePayer ≠ release-authority', () => {
    const other = Keypair.generate().publicKey;
    const r = validate(buildReleaseTx({ feePayer: other }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_MISMATCH');
  });

  it('rejects when sender ≠ state.sender', () => {
    const r = validate(buildReleaseTx({ sender: Keypair.generate().publicKey }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SENDER_MISMATCH');
  });

  it('rejects when mint ≠ state.mint', () => {
    const r = validate(buildReleaseTx({ mint: Keypair.generate().publicKey }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MINT_MISMATCH');
  });

  it('rejects when token_program account is wrong', () => {
    const r = validate(buildReleaseTx({ tokenProgram: Keypair.generate().publicKey }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TOKEN_PROGRAM_MISMATCH');
  });

  it('rejects an empty tx (no business ix)', () => {
    const r = validate(buildReleaseTx({ omitRelease: true }), AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
  });

  it('never throws — malformed tx (no feePayer) → reject', () => {
    const tx = new Transaction();
    const r = validate(tx, AUTHORITY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_MISMATCH');
  });
});
