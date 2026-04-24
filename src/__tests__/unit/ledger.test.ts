/**
 * Unit tests for src/core/ledger.ts (WFAC-32 — W2).
 *
 * Strategy: mock the infra wrapper (`../infra/supabase.js`) rather than
 * `@supabase/supabase-js` directly — `ledger.ts` consumes the wrapper and
 * never imports the SDK (CD-3).
 *
 * Exemplar: src/__tests__/unit/core.idempotency.settle.test.ts (E11 —
 * Map-backed spy pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BuildLedgerEntryInput } from '../../core/ledger.js';

// ─── infra/supabase.js mock ────────────────────────────────────────────────
vi.mock('../../infra/supabase.js', () => {
  const upsertSpy = vi.fn();
  const fromSpy = vi.fn(() => ({ upsert: upsertSpy }));
  const clientStub = { from: fromSpy };
  const getSupabaseClient = vi.fn(() => clientStub);
  return {
    __esModule: true,
    getSupabaseClient,
    __upsertSpy: upsertSpy,
    __fromSpy: fromSpy,
    __getSupabaseClient: getSupabaseClient,
    __clientStub: clientStub,
  };
});

function makeFakeLogger(): {
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), debug: vi.fn() };
}

function successInput(): BuildLedgerEntryInput {
  return {
    idempotencyKey: 'a'.repeat(64),
    durationMs: 42,
    method: 'eip3009',
    network: 'eip155:2368',
    parsed: {
      accepted: {
        asset: '0xAsset',
        payTo: '0xPayee',
        amount: '1000000',
      },
      payload: {
        authorization: { from: '0xPayer' },
      },
    },
    result: {
      ok: true,
      settled: true,
      transactionHash: '0xdeadbeef',
      blockNumber: 12345,
      amount: '1000000',
      from: '0xPayer',
      to: '0xPayee',
      asset: '0xAsset',
    },
  };
}

function failureInput(overrides: {
  code: string;
  http: number;
  message?: string;
}): BuildLedgerEntryInput {
  return {
    idempotencyKey: 'b'.repeat(64),
    durationMs: 77,
    method: 'eip3009',
    network: 'eip155:2368',
    parsed: {
      accepted: {
        asset: '0xParsedAsset',
        payTo: '0xParsedPayee',
        amount: '5000000',
      },
      payload: {
        authorization: { from: '0xParsedPayer' },
      },
    },
    result: {
      ok: false,
      error: {
        code: overrides.code,
        http: overrides.http,
        ...(overrides.message !== undefined ? { message: overrides.message } : {}),
      },
    },
  };
}

describe('buildLedgerEntry (W2)', () => {
  it('T12: success branch populates 9 on-chain fields (AC-1 / CD-13)', async () => {
    const { buildLedgerEntry } = await import('../../core/ledger.js');
    const entry = buildLedgerEntry(successInput());

    expect(entry.status).toBe('success');
    expect(entry.tx_hash).toBe('0xdeadbeef');
    expect(entry.block_number).toBe(12345);
    expect(entry.network).toBe('eip155:2368');
    expect(entry.method).toBe('eip3009');
    expect(entry.asset).toBe('0xAsset');
    expect(entry.amount).toBe('1000000');
    expect(entry.payer).toBe('0xPayer');
    expect(entry.payee).toBe('0xPayee');
    expect(entry.error_code).toBeNull();
    expect(entry.error_http).toBeNull();
    expect(entry.duration_ms).toBe(42);
    expect(entry.idempotency_key).toHaveLength(64);
    // CD-17: amount stays as string
    expect(typeof entry.amount).toBe('string');
  });

  it('T13: failure branch INSUFFICIENT_BALANCE maps http 402 (AC-2 / CD-13)', async () => {
    const { buildLedgerEntry } = await import('../../core/ledger.js');
    const entry = buildLedgerEntry(failureInput({ code: 'INSUFFICIENT_BALANCE', http: 402 }));

    expect(entry.status).toBe('failed');
    expect(entry.tx_hash).toBeNull();
    expect(entry.block_number).toBeNull();
    expect(entry.error_code).toBe('INSUFFICIENT_BALANCE');
    expect(entry.error_http).toBe(402);
    // Identity derives from parsed, not from result (which has no on-chain
    // data on failure).
    expect(entry.asset).toBe('0xParsedAsset');
    expect(entry.payer).toBe('0xParsedPayer');
    expect(entry.payee).toBe('0xParsedPayee');
    expect(entry.amount).toBe('5000000');
  });

  it('T14: failure branch TRANSACTION_FAILED maps http 500 (AC-2-extended)', async () => {
    const { buildLedgerEntry } = await import('../../core/ledger.js');
    const entry = buildLedgerEntry(failureInput({ code: 'TRANSACTION_FAILED', http: 500 }));

    expect(entry.status).toBe('failed');
    expect(entry.error_code).toBe('TRANSACTION_FAILED');
    expect(entry.error_http).toBe(500);
    expect(entry.tx_hash).toBeNull();
    expect(entry.block_number).toBeNull();
  });
});

describe('persistLedgerEntry (W2)', () => {
  beforeEach(async () => {
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
      __clientStub: { from: ReturnType<typeof vi.fn> };
    };
    mod.__upsertSpy.mockReset();
    mod.__fromSpy.mockReset();
    // Reattach the default factory so the client stub still wires to from+upsert.
    mod.__fromSpy.mockImplementation(() => ({ upsert: mod.__upsertSpy }));
    mod.__getSupabaseClient.mockReset();
    mod.__getSupabaseClient.mockReturnValue(mod.__clientStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T15: no-op when client is null (AC-4 / AC-7)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
    };
    mod.__getSupabaseClient.mockReturnValue(null);

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await persistLedgerEntry(entry, logger);

    expect(mod.__upsertSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T16: uses exact from/upsert signature (AC-5 / NC-2)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
    };
    mod.__upsertSpy.mockResolvedValueOnce({ data: [{ id: 'fake-uuid' }], error: null });

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await persistLedgerEntry(entry, logger);

    expect(mod.__fromSpy).toHaveBeenCalledWith('facilitator_settlements');
    expect(mod.__upsertSpy).toHaveBeenCalledWith(entry, {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T17: swallows awaited rejection and logs warn (AC-3 / CD-1)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__upsertSpy.mockRejectedValueOnce(new Error('network down'));

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await expect(persistLedgerEntry(entry, logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    // After AR BLQ-ALTO-1 fix, the unified catch block uses a shared message
    // covering both getSupabaseClient() sync throw and upsert rejection.
    expect(call[1]).toBe('ledger client or upsert failed');
    expect(call[0].idempotency_key).toBe(entry.idempotency_key);
    expect(call[0].network).toBe(entry.network);
    expect(call[0].err).toBeInstanceOf(Error);
  });

  it('T18: logs warn when response contains { error } object (AC-3)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__upsertSpy.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    });

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await persistLedgerEntry(entry, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('ledger upsert failed');
    expect(call[0].idempotency_key).toBe(entry.idempotency_key);
  });

  it('T19: logs debug on silenced duplicate (empty data) (AC-5)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__upsertSpy.mockResolvedValueOnce({ data: [], error: null });

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await persistLedgerEntry(entry, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const call = logger.debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('ledger upsert silenced duplicate');
    expect(call[0].idempotency_key).toBe(entry.idempotency_key);
  });

  it('T20b: swallows synchronous throw from getSupabaseClient (AR BLQ-ALTO-1 / CD-1 / AC-3)', async () => {
    const { buildLedgerEntry, persistLedgerEntry } = await import('../../core/ledger.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __upsertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
    };
    // Simulate `createClient()` throwing synchronously (e.g. invalid URL
    // scheme slipping past env validation). Before the AR fix, this throw
    // bubbled to the caller → 500 on an already-mined tx.
    mod.__getSupabaseClient.mockImplementationOnce(() => {
      throw new Error('createClient failed');
    });

    const logger = makeFakeLogger();
    const entry = buildLedgerEntry(successInput());
    await expect(persistLedgerEntry(entry, logger)).resolves.toBeUndefined();

    // from/upsert never reached — throw happened before the Supabase call.
    expect(mod.__fromSpy).not.toHaveBeenCalled();
    expect(mod.__upsertSpy).not.toHaveBeenCalled();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('ledger client or upsert failed');
    expect(call[0].idempotency_key).toBe(entry.idempotency_key);
    expect(call[0].network).toBe(entry.network);
    expect(call[0].err).toBeInstanceOf(Error);
    expect((call[0].err as Error).message).toBe('createClient failed');
  });
});
