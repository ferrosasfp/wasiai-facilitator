/**
 * WKH-217 / HU-SOL-14 — cosignAndBroadcast primitive (T11-T14).
 *
 * The `@solana/web3.js` Connection is MOCKED (CD-10: no network, cero plata) via
 * `vi.mock` with `importActual` so Transaction/Keypair/SystemProgram stay REAL
 * (CD-14: `import * as` + vi.mocked style through vi.hoisted state). The mutex
 * (`runExclusive`) is real, so T12 exercises genuine FIFO serialization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Web3 from '@solana/web3.js';

const h = vi.hoisted(() => ({
  isBlockhashValidImpl: vi.fn(async (_bh: string) => ({ value: true })),
  sendRawTransactionImpl: vi.fn(async (_raw: Uint8Array) => `SIG_${Math.random().toString(16)}`),
  // `err` is annotated `unknown` (not inferred from the `null` default): the
  // failure tests override this with `{ value: { err: 'InstructionError' } }`,
  // which the inferred `{ err: null }` type would have rejected.
  confirmTransactionImpl: vi.fn(
    async (_sig: string): Promise<{ value: { err: unknown } }> => ({
      value: { err: null },
    }),
  ),
  active: { current: 0, max: 0 },
}));

vi.mock('@solana/web3.js', async (importActual) => {
  const actual = await importActual<typeof Web3>();
  class MockConnection {
    constructor(_url: string, _commitment?: string) {}
    isBlockhashValid(bh: string): Promise<{ value: boolean }> {
      return h.isBlockhashValidImpl(bh) as Promise<{ value: boolean }>;
    }
    async sendRawTransaction(raw: Uint8Array): Promise<string> {
      h.active.current += 1;
      h.active.max = Math.max(h.active.max, h.active.current);
      try {
        return await h.sendRawTransactionImpl(raw);
      } finally {
        h.active.current -= 1;
      }
    }
    confirmTransaction(sig: string): Promise<{ value: { err: unknown } }> {
      return h.confirmTransactionImpl(sig) as Promise<{ value: { err: unknown } }>;
    }
  }
  return { ...actual, Connection: MockConnection };
});

import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  cosignAndBroadcast,
  parseSponsorTx,
  type SponsorTxValidator,
} from '../../methods/solana-sponsor/broadcast.js';
import { resetChainMutexForTesting } from '../../chains/chain-mutex.js';

/** Build a sender-signed legacy tx (base64), simulating chaski's partial-sign. */
function buildSignedTxBase64(feePayerKp: Keypair, senderKp: Keypair): string {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: senderKp.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(senderKp);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

const okValidator: SponsorTxValidator = () => ({ ok: true, feeUpperBoundLamports: 5000n });

const baseOpts = (feePayerKp: Keypair) => ({
  feePayerKeypair: feePayerKp,
  validate: okValidator,
  rpcUrl: 'http://mock',
  maxFeeLamports: 100_000n,
  maxRebroadcasts: 3,
});

describe('cosignAndBroadcast primitive', () => {
  beforeEach(() => {
    resetChainMutexForTesting();
    h.isBlockhashValidImpl.mockReset();
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.sendRawTransactionImpl.mockReset();
    h.sendRawTransactionImpl.mockImplementation(async () => `SIG_${Math.random().toString(16)}`);
    h.confirmTransactionImpl.mockReset();
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: null } });
    h.active.current = 0;
    h.active.max = 0;
  });

  afterEach(() => vi.clearAllMocks());

  // ── T11 — blockhash stale (AC-4): reject WITHOUT signing ────────────────────
  it('★ T11: isBlockhashValid=false → SPONSOR_BROADCAST_EXPIRED, not signed', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: false });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  // ── ★ T12 — concurrency N without collision (AC-5) ──────────────────────────
  it('★ T12: 5 concurrent txs → 5 unique signatures, serialized (no interleave)', async () => {
    let counter = 0;
    h.sendRawTransactionImpl.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 1));
      counter += 1;
      return `SIG_${counter}`;
    });

    const calls = Array.from({ length: 5 }, () => {
      const feePayerKp = Keypair.generate();
      const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
      return cosignAndBroadcast(tx, baseOpts(feePayerKp));
    });
    const results = await Promise.all(calls);

    const sigs = results.map((r) => (r.ok ? r.signature : `ERR_${r.code}`));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(sigs).size).toBe(5); // all unique, no collision
    expect(h.sendRawTransactionImpl).toHaveBeenCalledTimes(5);
    // The fee-payer mutex serialized signing/broadcast: never 2 in flight.
    expect(h.active.max).toBe(1);
  });

  // ── T13 — rebroadcast + expiry (AC-5) ───────────────────────────────────────
  it('T13: confirm fails then blockhash expires → SPONSOR_BROADCAST_EXPIRED after rebroadcast', async () => {
    // pre-sign check true, loop attempt#0 true, then false on attempt#1 start.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValue({ value: false });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });

    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    // At least one (re)broadcast happened before the blockhash went stale.
    expect(h.sendRawTransactionImpl).toHaveBeenCalled();
  });

  it('T13b: confirm never succeeds but blockhash stays valid → SPONSOR_BROADCAST_FAILED', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), maxRebroadcasts: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_FAILED');
  });

  // ── T14 — primitive is agnostic to the deposit (CD-11) ──────────────────────
  it('★ T14a: injected validator { ok:false } → NOT signed, SPONSOR_REJECTED', async () => {
    const rejectValidator: SponsorTxValidator = () => ({ ok: false, reason: 'INJECTED_REJECT' });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), validate: rejectValidator });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SPONSOR_REJECTED');
      expect(r.reason).toBe('INJECTED_REJECT');
    }
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
    expect(h.isBlockhashValidImpl).not.toHaveBeenCalled(); // rejected before any network/sign
  });

  it('★ T14b: injected validator { ok:true } → signs + broadcasts', async () => {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(true);
    expect(h.sendRawTransactionImpl).toHaveBeenCalledTimes(1);
  });

  it('T14c: fee upper bound over the per-tx cap → SPONSOR_REJECTED (not signed)', async () => {
    const bigFeeValidator: SponsorTxValidator = () => ({
      ok: true,
      feeUpperBoundLamports: 999_999n,
    });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), validate: bigFeeValidator });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_REJECTED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  it('T14d: onFeeEstimated reject (daily cap) → SPONSOR_DAILY_CAP (not signed)', async () => {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: false, reason: 'store_error_failclosed' }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_DAILY_CAP');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  // ── CR-MNR-3 — versioned (v0) tx → SPONSOR_UNSUPPORTED_TX (reject, not signed) ─
  it('★ CR-MNR-3: a versioned/v0 VersionedTransaction → SPONSOR_UNSUPPORTED_TX (parse rejects)', () => {
    const payer = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const b64 = Buffer.from(vtx.serialize()).toString('base64');
    const r = parseSponsorTx(b64);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_UNSUPPORTED_TX');
  });

  // ── AR-MNR-1 — daily-cap reservation released only when no on-chain spend ─────
  it('★ AR-MNR-1a: stale blockhash → reserved fee is RELEASED (compensated), not signed', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: false }); // stale → EXPIRED pre-sign
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
    // The 5000-lamport reservation (okValidator) is released — no spend happened.
    expect(released).toEqual([5000n]);
  });

  it('★ AR-MNR-1b: SPONSOR_BROADCAST_FAILED → reservation KEPT (tx may have landed)', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      maxRebroadcasts: 1,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_FAILED');
    // Ambiguous outcome → keep the debit to protect the fee-payer wallet.
    expect(released).toEqual([]);
  });

  it('AR-MNR-1c: success → reservation KEPT (spend happened, no release)', async () => {
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(true);
    expect(released).toEqual([]);
  });
});
