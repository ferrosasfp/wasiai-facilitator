/**
 * Unit tests for src/core/audit.ts (WFAC-33 — W4).
 *
 * Strategy: mock the infra wrapper (`../infra/supabase.js`) rather than
 * `@supabase/supabase-js` directly — `audit.ts` consumes the wrapper and
 * never imports the SDK (CD-3).
 *
 * Exemplar: src/__tests__/unit/ledger.test.ts (W2/W4 pattern — spy module).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BuildAuditEntryInput } from '../../core/audit.js';

// ─── infra/supabase.js mock ────────────────────────────────────────────────
vi.mock('../../infra/supabase.js', () => {
  const insertSpy = vi.fn();
  const fromSpy = vi.fn(() => ({ insert: insertSpy }));
  const clientStub = { from: fromSpy };
  const getSupabaseClient = vi.fn(() => clientStub);
  return {
    __esModule: true,
    getSupabaseClient,
    __insertSpy: insertSpy,
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

function baseInput(overrides: Partial<BuildAuditEntryInput> = {}): BuildAuditEntryInput {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/settle',
    statusCode: 200,
    durationMs: 42,
    ipRaw: '1.2.3.4',
    userAgentRaw: 'Mozilla/5.0',
    ...overrides,
  };
}

describe('buildAuditEntry (W2)', () => {
  it('T-A1 (AC-1): maps 9 fields correctly with idempotencyKey populated', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(
      baseInput({
        requestId: 'req-1',
        method: 'POST',
        path: '/settle',
        statusCode: 200,
        durationMs: 42,
        ipRaw: '1.2.3.4',
        userAgentRaw: 'Mozilla/5.0',
        idempotencyKey: 'abc',
      }),
    );
    expect(entry.request_id).toBe('req-1');
    expect(entry.method).toBe('POST');
    expect(entry.path).toBe('/settle');
    expect(entry.status_code).toBe(200);
    expect(entry.duration_ms).toBe(42);
    expect(entry.ip).toBe('1.2.3.4');
    expect(entry.user_agent).toBe('Mozilla/5.0');
    expect(entry.error_code).toBeNull();
    expect(entry.idempotency_key).toBe('abc');
  });

  it('T-A2 (AC-1 + CD-13): output does NOT include timestamp key', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput());
    expect(Object.keys(entry)).not.toContain('timestamp');
  });

  it('T-A4 (AC-4 proxy-aware): preserves IP already extracted from XFF', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput({ ipRaw: '203.0.113.5' }));
    expect(entry.ip).toBe('203.0.113.5');
  });

  it('T-A5 (AC-5 fallback): loopback IP from request.ip fallback preserved', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput({ ipRaw: '127.0.0.1' }));
    expect(entry.ip).toBe('127.0.0.1');
  });

  it('T-A6 (AC-6 IP truncation): 60-char string truncates to 45', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput({ ipRaw: 'x'.repeat(60) }));
    expect(entry.ip).not.toBeNull();
    expect(entry.ip!.length).toBe(45);

    const entry45 = buildAuditEntry(baseInput({ ipRaw: 'y'.repeat(45) }));
    expect(entry45.ip!.length).toBe(45);

    const entry44 = buildAuditEntry(baseInput({ ipRaw: 'z'.repeat(44) }));
    expect(entry44.ip!.length).toBe(44);
  });

  it('T-A7 (AC-7 UA truncation): 600-char UA truncates to 512', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput({ userAgentRaw: 'a'.repeat(600) }));
    expect(entry.user_agent).not.toBeNull();
    expect(entry.user_agent!.length).toBe(512);

    const entry512 = buildAuditEntry(baseInput({ userAgentRaw: 'b'.repeat(512) }));
    expect(entry512.user_agent!.length).toBe(512);

    const entry511 = buildAuditEntry(baseInput({ userAgentRaw: 'c'.repeat(511) }));
    expect(entry511.user_agent!.length).toBe(511);
  });

  it('T-A8 (AC-8 null/empty UA): coerces to null', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entryNull = buildAuditEntry(baseInput({ userAgentRaw: null }));
    expect(entryNull.user_agent).toBeNull();

    const entryEmpty = buildAuditEntry(baseInput({ userAgentRaw: '' }));
    expect(entryEmpty.user_agent).toBeNull();
  });

  it('T-A9 (AC-8 null/empty IP): coerces to null', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entryNull = buildAuditEntry(baseInput({ ipRaw: null }));
    expect(entryNull.ip).toBeNull();

    const entryEmpty = buildAuditEntry(baseInput({ ipRaw: '' }));
    expect(entryEmpty.ip).toBeNull();
  });

  it('T-A15 (CD-13 DDL parity): output has exactly the 9 expected keys', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const entry = buildAuditEntry(baseInput());
    expect(Object.keys(entry).sort()).toEqual([
      'duration_ms',
      'error_code',
      'idempotency_key',
      'ip',
      'method',
      'path',
      'request_id',
      'status_code',
      'user_agent',
    ]);
  });

  it('T-A15b: errorCode undefined maps to error_code=null; present maps verbatim', async () => {
    const { buildAuditEntry } = await import('../../core/audit.js');
    const nullEntry = buildAuditEntry(baseInput({ errorCode: undefined }));
    expect(nullEntry.error_code).toBeNull();

    const fullEntry = buildAuditEntry(baseInput({ errorCode: 'INSUFFICIENT_BALANCE' }));
    expect(fullEntry.error_code).toBe('INSUFFICIENT_BALANCE');
  });
});

describe('persistAuditEntry (W2)', () => {
  beforeEach(async () => {
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
      __clientStub: { from: ReturnType<typeof vi.fn> };
    };
    mod.__insertSpy.mockReset();
    mod.__fromSpy.mockReset();
    mod.__fromSpy.mockImplementation(() => ({ insert: mod.__insertSpy }));
    mod.__getSupabaseClient.mockReset();
    mod.__getSupabaseClient.mockReturnValue(mod.__clientStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-A3 (AC-3 null client): no-op, no insert, no logs', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
    };
    mod.__getSupabaseClient.mockReturnValueOnce(null);

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput());
    await expect(persistAuditEntry(entry, logger)).resolves.toBeUndefined();

    expect(mod.__insertSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('T-A10 (AC-10 async rejection): swallows and warns, no throw', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__insertSpy.mockRejectedValueOnce(new Error('network down'));

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput());
    await expect(persistAuditEntry(entry, logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('audit client or insert failed');
    expect(call[0].request_id).toBe(entry.request_id);
    expect(call[0].path).toBe(entry.path);
    expect(call[0].err).toBeInstanceOf(Error);
  });

  it('T-A11 (AC-10 Supabase error response): warns with audit insert failed', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__insertSpy.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    });

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput());
    await persistAuditEntry(entry, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('audit insert failed');
    expect(call[0].request_id).toBe(entry.request_id);
    expect(call[0].path).toBe(entry.path);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('T-A12 (AC-10 sync throw from getSupabaseClient): swallows and warns', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
      __getSupabaseClient: ReturnType<typeof vi.fn>;
    };
    mod.__getSupabaseClient.mockImplementationOnce(() => {
      throw new Error('init fail');
    });

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput());
    await expect(persistAuditEntry(entry, logger)).resolves.toBeUndefined();

    expect(mod.__fromSpy).not.toHaveBeenCalled();
    expect(mod.__insertSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(call[1]).toBe('audit client or insert failed');
    expect((call[0].err as Error).message).toBe('init fail');
  });

  it('T-A13 (AC-1 INSERT signature): calls from(table).insert(entry) with plain INSERT (no onConflict)', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
      __fromSpy: ReturnType<typeof vi.fn>;
    };
    mod.__insertSpy.mockResolvedValueOnce({ data: [{ id: 'uuid-xyz' }], error: null });

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput());
    await persistAuditEntry(entry, logger);

    expect(mod.__fromSpy).toHaveBeenCalledWith('facilitator_audit_log');
    expect(mod.__insertSpy).toHaveBeenCalledTimes(1);
    // Plain INSERT — only the entry, no second argument (no onConflict).
    expect(mod.__insertSpy).toHaveBeenCalledWith(entry);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T-A14 (CD-4 PII guard): warn payload never contains ip or user_agent', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __insertSpy: ReturnType<typeof vi.fn>;
    };
    mod.__insertSpy.mockResolvedValueOnce({
      data: null,
      error: { message: 'broken', code: '23505' },
    });

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput({ ipRaw: '10.0.0.1', userAgentRaw: 'SecretBot/1.0' }));
    await persistAuditEntry(entry, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const payload = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).not.toHaveProperty('ip');
    expect(payload).not.toHaveProperty('user_agent');
    expect(payload).not.toHaveProperty('userAgent');
  });

  it('T-A14b (CD-4 PII guard, sync throw path): warn payload stays PII-free', async () => {
    const { buildAuditEntry, persistAuditEntry } = await import('../../core/audit.js');
    const mod = (await import('../../infra/supabase.js')) as unknown as {
      __getSupabaseClient: ReturnType<typeof vi.fn>;
    };
    mod.__getSupabaseClient.mockImplementationOnce(() => {
      throw new Error('bootstrap');
    });

    const logger = makeFakeLogger();
    const entry = buildAuditEntry(baseInput({ ipRaw: '10.0.0.1', userAgentRaw: 'SecretBot/1.0' }));
    await persistAuditEntry(entry, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const payload = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).not.toHaveProperty('ip');
    expect(payload).not.toHaveProperty('user_agent');
  });
});
