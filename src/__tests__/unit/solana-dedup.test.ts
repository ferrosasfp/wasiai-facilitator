/**
 * Unit tests for src/infra/solana-dedup.ts (WKH-205 / HU-SOL-6 — W1).
 *
 * Strategy: mock the infra wrapper (`../../infra/supabase.js`) rather than
 * `@supabase/supabase-js` directly — `solana-dedup.ts` consumes the wrapper and
 * never imports the SDK. Exemplar: src/__tests__/unit/ledger.test.ts.
 *
 * Focus: the INVERTED (fail-CLOSED) policy — a null client or any query error
 * must resolve to `{ ok:false }` (reject), never a silent accept.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as SolanaDedup from '../../infra/solana-dedup.js';

// ─── infra/supabase.js mock ────────────────────────────────────────────────
vi.mock('../../infra/supabase.js', () => {
  const maybeSingleSpy = vi.fn();
  const eqSpy = vi.fn(() => ({ maybeSingle: maybeSingleSpy }));
  const selectSpy = vi.fn(() => ({ eq: eqSpy }));
  const insertSpy = vi.fn();
  const fromSpy = vi.fn(() => ({ select: selectSpy, insert: insertSpy }));
  const clientStub = { from: fromSpy };
  const getSupabaseClient = vi.fn(() => clientStub);
  return {
    __esModule: true,
    getSupabaseClient,
    __maybeSingleSpy: maybeSingleSpy,
    __eqSpy: eqSpy,
    __selectSpy: selectSpy,
    __insertSpy: insertSpy,
    __fromSpy: fromSpy,
    __getSupabaseClient: getSupabaseClient,
    __clientStub: clientStub,
  };
});

interface SupabaseMock {
  __maybeSingleSpy: ReturnType<typeof vi.fn>;
  __eqSpy: ReturnType<typeof vi.fn>;
  __selectSpy: ReturnType<typeof vi.fn>;
  __insertSpy: ReturnType<typeof vi.fn>;
  __fromSpy: ReturnType<typeof vi.fn>;
  __getSupabaseClient: ReturnType<typeof vi.fn>;
  __clientStub: { from: ReturnType<typeof vi.fn> };
}

function makeFakeLogger(): { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), debug: vi.fn() };
}

const ENTRY: SolanaDedup.SolanaSettlementEntry = {
  signature: '5'.repeat(88),
  network: 'solana:devnet',
  reference: 'Ref111111111111111111111111111111111111111',
  // eslint-disable-next-line no-secrets/no-secrets -- public USDC SPL mint pubkey (base58), not a secret.
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: 'PayTo1111111111111111111111111111111111111',
  amount: '18446744073709551615', // u64 max — verifies string passthrough (no Number)
};

describe('solana-dedup (W1)', () => {
  beforeEach(async () => {
    const mod = (await import('../../infra/supabase.js')) as unknown as SupabaseMock;
    mod.__maybeSingleSpy.mockReset();
    mod.__eqSpy.mockReset();
    mod.__eqSpy.mockImplementation(() => ({ maybeSingle: mod.__maybeSingleSpy }));
    mod.__selectSpy.mockReset();
    mod.__selectSpy.mockImplementation(() => ({ eq: mod.__eqSpy }));
    mod.__insertSpy.mockReset();
    mod.__fromSpy.mockReset();
    mod.__fromSpy.mockImplementation(() => ({
      select: mod.__selectSpy,
      insert: mod.__insertSpy,
    }));
    mod.__getSupabaseClient.mockReset();
    mod.__getSupabaseClient.mockReturnValue(mod.__clientStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DEDUP-1: recordSolanaSignature insert OK → { ok:true, inserted:true }', async () => {
    const { recordSolanaSignature } = await import('../../infra/solana-dedup.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as SupabaseMock;
    mod.__insertSpy.mockResolvedValueOnce({ error: null });

    const result = await recordSolanaSignature(ENTRY, makeFakeLogger());
    expect(result).toEqual({ ok: true, inserted: true });
    expect(mod.__fromSpy).toHaveBeenCalledWith('facilitator_solana_settlements');
    // CD-9: amount passed through as the exact decimal string (no precision loss).
    const insertArg = mod.__insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg.amount).toBe('18446744073709551615');
    expect(insertArg.pay_to).toBe(ENTRY.payTo);
  });

  it('T-DEDUP-2: UNIQUE violation (code 23505) → { ok:true, inserted:false } (duplicate)', async () => {
    const { recordSolanaSignature } = await import('../../infra/solana-dedup.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as SupabaseMock;
    mod.__insertSpy.mockResolvedValueOnce({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const result = await recordSolanaSignature(ENTRY, makeFakeLogger());
    expect(result).toEqual({ ok: true, inserted: false });
  });

  it('T-DEDUP-3: null client → { ok:false } fail-CLOSED for BOTH functions', async () => {
    const { recordSolanaSignature, isSolanaSignatureSettled } =
      await import('../../infra/solana-dedup.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as SupabaseMock;
    mod.__getSupabaseClient.mockReturnValue(null);

    const rec = await recordSolanaSignature(ENTRY, makeFakeLogger());
    expect(rec).toEqual({ ok: false });
    expect(mod.__insertSpy).not.toHaveBeenCalled();

    const sel = await isSolanaSignatureSettled(ENTRY.signature, makeFakeLogger());
    expect(sel).toEqual({ ok: false });
    expect(mod.__selectSpy).not.toHaveBeenCalled();
  });

  it('T-DEDUP-4: generic db error (code ≠ 23505) → { ok:false }; SELECT settled/not-settled OK', async () => {
    const { recordSolanaSignature, isSolanaSignatureSettled } =
      await import('../../infra/solana-dedup.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as SupabaseMock;

    // record: generic error → fail-CLOSED
    mod.__insertSpy.mockResolvedValueOnce({
      error: { code: '42501', message: 'permission denied' },
    });
    expect(await recordSolanaSignature(ENTRY, makeFakeLogger())).toEqual({ ok: false });

    // select generic error → fail-CLOSED
    mod.__maybeSingleSpy.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'conn' },
    });
    expect(await isSolanaSignatureSettled(ENTRY.signature, makeFakeLogger())).toEqual({
      ok: false,
    });

    // select row present → settled:true
    mod.__maybeSingleSpy.mockResolvedValueOnce({
      data: { signature: ENTRY.signature },
      error: null,
    });
    expect(await isSolanaSignatureSettled(ENTRY.signature, makeFakeLogger())).toEqual({
      ok: true,
      settled: true,
    });

    // select row absent → settled:false
    mod.__maybeSingleSpy.mockResolvedValueOnce({ data: null, error: null });
    expect(await isSolanaSignatureSettled(ENTRY.signature, makeFakeLogger())).toEqual({
      ok: true,
      settled: false,
    });
  });
});
