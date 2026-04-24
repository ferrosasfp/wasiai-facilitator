/**
 * Unit tests for src/infra/supabase.ts (WFAC-32 — W1).
 *
 * Strategy: mock `@supabase/supabase-js` with a minimal `createClient` spy
 * that returns a SupabaseMock instance recording constructor args.
 * No live Supabase is required.
 *
 * Exemplar: src/__tests__/unit/redis.test.ts (WFAC-5 singleton pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '../../infra/env.js';

// ─── @supabase/supabase-js mock ────────────────────────────────────────────
vi.mock('@supabase/supabase-js', () => {
  class SupabaseMock {
    public readonly url: string;
    public readonly key: string;
    public readonly opts?: unknown;
    public from = vi.fn();
    constructor(url: string, key: string, opts?: unknown) {
      this.url = url;
      this.key = key;
      this.opts = opts;
    }
  }

  const createClientSpy = vi.fn(
    (url: string, key: string, opts?: unknown) => new SupabaseMock(url, key, opts),
  );

  return {
    createClient: createClientSpy,
    __createClientSpy: createClientSpy,
  };
});

// Fake logger — plain vi.fn() so we can assert calls + arguments.
function makeFakeLogger(): {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'info',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_DB: 0,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'sb_service_abcdef1234567890xyz',
    ...overrides,
  };
}

describe('redactSupabaseKey (AC-10 / CD-2)', () => {
  it('T4a: redacts a valid long key to prefix…suffix shape', async () => {
    const { redactSupabaseKey } = await import('../../infra/supabase.js');
    const raw = 'sb_service_abcdef1234567890xyz';
    const out = redactSupabaseKey(raw);

    expect(out).not.toContain(raw);
    expect(out.startsWith(raw.slice(0, 8))).toBe(true);
    expect(out.endsWith(raw.slice(-4))).toBe(true);
    expect(out).toContain('…');
  });

  it('T4b: returns sb_*** for short input', async () => {
    const { redactSupabaseKey } = await import('../../infra/supabase.js');
    expect(redactSupabaseKey('short')).toBe('sb_***');
    expect(redactSupabaseKey('')).toBe('sb_***');
  });
});

describe('getSupabaseClient', () => {
  beforeEach(async () => {
    const mod = (await import('@supabase/supabase-js')) as unknown as {
      __createClientSpy: ReturnType<typeof vi.fn>;
    };
    mod.__createClientSpy.mockClear();
    const { resetSupabaseClientForTests } = await import('../../infra/supabase.js');
    resetSupabaseClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T5: returns null when initSupabase was never called (AC-12)', async () => {
    const { getSupabaseClient } = await import('../../infra/supabase.js');
    expect(getSupabaseClient()).toBeNull();
  });

  it('T6: returns null when SUPABASE_URL is undefined (AC-7)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    initSupabase(
      makeEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: 'sb_secret_xyz' }),
      makeFakeLogger(),
    );
    expect(getSupabaseClient()).toBeNull();
  });

  it('T7: returns same instance on repeated calls — singleton (AC-12)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    const mod = (await import('@supabase/supabase-js')) as unknown as {
      __createClientSpy: ReturnType<typeof vi.fn>;
    };
    const spy = mod.__createClientSpy;

    initSupabase(makeEnv(), makeFakeLogger());
    const a = getSupabaseClient();
    const b = getSupabaseClient();

    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('T8: initSupabase is idempotent across repeated calls (AC-12)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    const mod = (await import('@supabase/supabase-js')) as unknown as {
      __createClientSpy: ReturnType<typeof vi.fn>;
    };
    const spy = mod.__createClientSpy;

    const env = makeEnv();
    const logger = makeFakeLogger();
    initSupabase(env, logger);
    initSupabase(env, logger); // no-op
    getSupabaseClient();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('T9: resetSupabaseClientForTests clears state (AC-12 / CD-8)', async () => {
    const { initSupabase, getSupabaseClient, resetSupabaseClientForTests } =
      await import('../../infra/supabase.js');
    const mod = (await import('@supabase/supabase-js')) as unknown as {
      __createClientSpy: ReturnType<typeof vi.fn>;
    };
    const spy = mod.__createClientSpy;

    initSupabase(makeEnv(), makeFakeLogger());
    getSupabaseClient();
    expect(spy).toHaveBeenCalledTimes(1);

    resetSupabaseClientForTests();
    expect(getSupabaseClient()).toBeNull();

    initSupabase(makeEnv(), makeFakeLogger());
    getSupabaseClient();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('T10: initSupabase logs keyPreview redacted (AC-10)', async () => {
    const { initSupabase } = await import('../../infra/supabase.js');
    const logger = makeFakeLogger();
    const rawKey = 'sb_service_abcdef1234567890xyz';
    initSupabase(makeEnv({ SUPABASE_SERVICE_KEY: rawKey }), logger);

    expect(logger.info).toHaveBeenCalled();
    const configuredCall = logger.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Supabase client configured'),
    );
    expect(configuredCall).toBeDefined();
    const payload = configuredCall?.[0] as { keyPreview: string; url: string };
    expect(payload.keyPreview).not.toBe(rawKey);
    expect(payload.keyPreview).not.toContain('abcdef1234567890');
    expect(payload.keyPreview).toContain('…');
    expect(payload.url).toBe('example.supabase.co');
  });

  it('T11: initSupabase logs "disabled" warn when SUPABASE_URL is undefined (AC-4)', async () => {
    const { initSupabase } = await import('../../infra/supabase.js');
    const logger = makeFakeLogger();
    initSupabase(makeEnv({ SUPABASE_URL: undefined }), logger);

    const disabledCall = logger.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('ledger disabled'),
    );
    expect(disabledCall).toBeDefined();
  });

  it('T7b: constructs Supabase client with auth.persistSession=false (AC-12)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    const mod = (await import('@supabase/supabase-js')) as unknown as {
      __createClientSpy: ReturnType<typeof vi.fn>;
    };
    const spy = mod.__createClientSpy;

    initSupabase(makeEnv(), makeFakeLogger());
    getSupabaseClient();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, key, opts] = spy.mock.calls[0] as [
      string,
      string,
      { auth: { persistSession: boolean; autoRefreshToken: boolean } },
    ];
    expect(url).toBe('https://example.supabase.co');
    expect(key).toBe('sb_service_abcdef1234567890xyz');
    expect(opts.auth.persistSession).toBe(false);
    expect(opts.auth.autoRefreshToken).toBe(false);
  });

  it('T6b: returns null when SUPABASE_SERVICE_KEY is undefined (AC-7)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    initSupabase(
      makeEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_KEY: undefined,
      }),
      makeFakeLogger(),
    );
    expect(getSupabaseClient()).toBeNull();
  });

  it('T10b: SUPABASE_SERVICE_KEY is never included raw in any logger call (AC-10)', async () => {
    const { initSupabase, getSupabaseClient } = await import('../../infra/supabase.js');
    const logger = makeFakeLogger();
    const rawKey = 'sb_service_this_is_a_super_secret_raw_value_12345';
    initSupabase(makeEnv({ SUPABASE_SERVICE_KEY: rawKey }), logger);
    getSupabaseClient();

    const allCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.debug.mock.calls,
    ];
    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(rawKey);
    }
  });
});
