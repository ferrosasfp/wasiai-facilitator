import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnv } from '../../infra/env.js';

describe('parseEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults PORT to 3002 when PORT is missing', () => {
    // NODE_ENV=test avoids the WFAC-5 AC-2 superRefine requiring REDIS_URL;
    // this test targets PORT-default behavior only.
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.PORT).toBe(3002);
  });

  it('respects PORT from env var', () => {
    // NODE_ENV=test (see above) — the assertion under test is about PORT.
    const result = parseEnv({ NODE_ENV: 'test', PORT: '4001' });
    expect(result.PORT).toBe(4001);
  });

  it('exits with code 1 on invalid NODE_ENV', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const firstCall = stderrSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall?.[0])).toContain('NODE_ENV');
  });

  it('exits with code 1 on PORT out of range', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ PORT: '99999' })).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns REDIS_URL when present in production env (WFAC-5 AC-1)', () => {
    // WFAC-50: superRefine now requires OPERATOR_PRIVATE_KEY + KITE_USDC_ADDRESS
    // in non-test NODE_ENV. Fixture updated; assertion focus unchanged.
    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    });
    expect(result.REDIS_URL).toBe('redis://host:6379/0');
    expect(result.REDIS_DB).toBe(0); // default
  });

  it('exits with code 1 and mentions REDIS_URL when missing in prod (WFAC-5 AC-2)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('REDIS_URL');
  });

  it('does NOT exit when REDIS_URL absent in test env (WFAC-5 AC-3)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.REDIS_URL).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── WFAC-32 — SUPABASE vars (T1-T3) ─────────────────────────────────────
  it('T1: accepts both SUPABASE_URL and SUPABASE_SERVICE_KEY in production (WFAC-32 AC-6)', () => {
    // WFAC-50: prod fixtures need OPERATOR_PRIVATE_KEY + KITE_USDC_ADDRESS.
    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      SUPABASE_URL: 'https://foo.supabase.co',
      SUPABASE_SERVICE_KEY: 'sb_secret_xyz',
    });
    expect(result.SUPABASE_URL).toBe('https://foo.supabase.co');
    expect(result.SUPABASE_SERVICE_KEY).toBe('sb_secret_xyz');
  });

  it('T2: exits with code 1 when SUPABASE_URL is not a valid URL (WFAC-32 AC-8)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        SUPABASE_URL: 'not-a-url',
      }),
    ).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('SUPABASE_URL');
  });

  it('T2b: rejects SUPABASE_URL with non-http(s) scheme — ftp:// / mailto: (WFAC-32 AR MNR-1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // ftp:// is an RFC 3986 URL that z.string().url() would accept without
    // the defense-in-depth .refine(); must now be rejected.
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        SUPABASE_URL: 'ftp://foo.example.com',
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);

    let allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('SUPABASE_URL');
    expect(allWrites).toContain('http');

    // mailto: is an RFC 3986 URI and also slips past z.string().url()
    // prior to the .refine() — must be rejected too.
    stderrSpy.mockClear();
    exitSpy.mockClear();
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        SUPABASE_URL: 'mailto:ops@example.com',
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('SUPABASE_URL');
  });

  it('T3: does NOT exit in production when both SUPABASE vars are absent (WFAC-32 CD-4)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // WFAC-50: prod fixtures need OPERATOR_PRIVATE_KEY + KITE_USDC_ADDRESS.
    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    });
    expect(result.SUPABASE_URL).toBeUndefined();
    expect(result.SUPABASE_SERVICE_KEY).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── WFAC-40 — RATE_LIMIT_* vars (T-ENV-RL-1..7) ─────────────────────────
  it('T-ENV-RL-1 (AC-12 defaults): all RATE_LIMIT_* vars take documented defaults', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.RATE_LIMIT_ENABLED).toBe(true);
    expect(result.RATE_LIMIT_WINDOW_SEC).toBe(60);
    expect(result.RATE_LIMIT_VERIFY_MAX).toBe(60);
    expect(result.RATE_LIMIT_SETTLE_MAX).toBe(30);
    expect(result.RATE_LIMIT_SUPPORTED_MAX).toBe(120);
  });

  it('T-ENV-RL-2 (AC-6 disabled): RATE_LIMIT_ENABLED="false" → boolean false', () => {
    const result = parseEnv({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'false' });
    expect(result.RATE_LIMIT_ENABLED).toBe(false);
    // Sanity: literal string "false" became the boolean `false`, not string.
    expect(typeof result.RATE_LIMIT_ENABLED).toBe('boolean');
  });

  it('T-ENV-RL-3 (CD-12 explicit true): RATE_LIMIT_ENABLED="true" → boolean true', () => {
    const result = parseEnv({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'true' });
    expect(result.RATE_LIMIT_ENABLED).toBe(true);
    expect(typeof result.RATE_LIMIT_ENABLED).toBe('boolean');
  });

  it('T-ENV-RL-4 (AC-12 overrides): numeric RATE_LIMIT_* vars parse from strings', () => {
    const result = parseEnv({
      NODE_ENV: 'test',
      RATE_LIMIT_WINDOW_SEC: '120',
      RATE_LIMIT_VERIFY_MAX: '100',
      RATE_LIMIT_SETTLE_MAX: '50',
      RATE_LIMIT_SUPPORTED_MAX: '200',
    });
    expect(result.RATE_LIMIT_WINDOW_SEC).toBe(120);
    expect(result.RATE_LIMIT_VERIFY_MAX).toBe(100);
    expect(result.RATE_LIMIT_SETTLE_MAX).toBe(50);
    expect(result.RATE_LIMIT_SUPPORTED_MAX).toBe(200);
  });

  it('T-ENV-RL-5 (AC-12 invalid negative WINDOW_SEC): exits with stderr mention', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', RATE_LIMIT_WINDOW_SEC: '-1' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('RATE_LIMIT_WINDOW_SEC');
  });

  it('T-ENV-RL-6 (AC-12 invalid zero VERIFY_MAX): exits with code 1', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', RATE_LIMIT_VERIFY_MAX: '0' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('RATE_LIMIT_VERIFY_MAX');
  });

  it('T-ENV-RL-7 (CD-12 invalid ENABLED): rejects "yes"/arbitrary strings (defense vs z.coerce.boolean footgun)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'yes' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('RATE_LIMIT_ENABLED');
  });

  // ─── WFAC-41 — CB (circuit breaker) vars (T-ENV-CB-*) ────────────────────
  it('T-ENV-CB-1 (AC-10 defaults): CB_* env vars default to {true, 5, 30000, 10000}', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.CB_ENABLED).toBe(true);
    expect(result.CB_FAILURE_THRESHOLD).toBe(5);
    expect(result.CB_ROLLING_WINDOW_MS).toBe(30000);
    expect(result.CB_RESET_TIMEOUT_MS).toBe(10000);
  });

  it('T-ENV-CB-2 (CD-NEW-CB-BOOL): CB_ENABLED=false is parsed as boolean false', () => {
    const result = parseEnv({ NODE_ENV: 'test', CB_ENABLED: 'false' });
    expect(result.CB_ENABLED).toBe(false);
    expect(typeof result.CB_ENABLED).toBe('boolean');
  });

  it('T-ENV-CB-3 (AC-10 override numeric): CB_* numerics parse as integers', () => {
    const result = parseEnv({
      NODE_ENV: 'test',
      CB_FAILURE_THRESHOLD: '10',
      CB_ROLLING_WINDOW_MS: '60000',
      CB_RESET_TIMEOUT_MS: '15000',
    });
    expect(result.CB_FAILURE_THRESHOLD).toBe(10);
    expect(result.CB_ROLLING_WINDOW_MS).toBe(60000);
    expect(result.CB_RESET_TIMEOUT_MS).toBe(15000);
  });

  it('T-ENV-CB-4 (AC-10 invalid negative CB_FAILURE_THRESHOLD): exits with code 1', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', CB_FAILURE_THRESHOLD: '-1' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('CB_FAILURE_THRESHOLD');
  });

  it('T-ENV-CB-5 (AC-10 invalid zero CB_ROLLING_WINDOW_MS): exits with code 1', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', CB_ROLLING_WINDOW_MS: '0' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('CB_ROLLING_WINDOW_MS');
  });

  it('T-ENV-CB-6 (AC-10 invalid non-integer CB_RESET_TIMEOUT_MS): exits with code 1', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', CB_RESET_TIMEOUT_MS: 'abc' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('CB_RESET_TIMEOUT_MS');
  });

  it('T-ENV-CB-7 (CD-NEW-CB-BOOL): CB_ENABLED rejects arbitrary strings like "yes"', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', CB_ENABLED: 'yes' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('CB_ENABLED');
  });

  // ─── WFAC-50 — OPERATOR_PRIVATE_KEY + KITE_USDC_ADDRESS (T-ENV-WFAC50-*) ──
  // Coverage: AC-16 (OPERATOR_PRIVATE_KEY missing/invalid in non-test),
  //           AC-17 (KITE_USDC_ADDRESS missing/invalid in non-test).
  it('T-ENV-WFAC50-1 (AC-16 missing): exits with code 1 when OPERATOR_PRIVATE_KEY missing in production', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('OPERATOR_PRIVATE_KEY');
  });

  it('T-ENV-WFAC50-2 (AC-16 invalid): exits with code 1 when OPERATOR_PRIVATE_KEY has invalid format', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        OPERATOR_PRIVATE_KEY: '0xdeadbeef', // too short
        KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('OPERATOR_PRIVATE_KEY');
  });

  it('T-ENV-WFAC50-3 (AC-17 missing): exits with code 1 when KITE_USDC_ADDRESS missing in production', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('KITE_USDC_ADDRESS');
  });

  it('T-ENV-WFAC50-4 (AC-17 invalid): exits with code 1 when KITE_USDC_ADDRESS has invalid format', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://host:6379/0',
        OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
        KITE_USDC_ADDRESS: '0xTOOSHORT',
      }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('KITE_USDC_ADDRESS');
  });

  it('T-ENV-WFAC50-5 (superRefine test bypass): NODE_ENV=test accepts both WFAC-50 optional keys as undefined', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.OPERATOR_PRIVATE_KEY).toBeUndefined();
    expect(result.KITE_USDC_ADDRESS).toBeUndefined();
  });

  // ─── PR feat/mainnet — KITE_MAINNET_ENABLED + AVALANCHE_MAINNET_ENABLED ──

  it('PR feat/mainnet: KITE_MAINNET_ENABLED defaults to false when missing', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.KITE_MAINNET_ENABLED).toBe(false);
  });

  it('PR feat/mainnet: AVALANCHE_MAINNET_ENABLED defaults to false when missing', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.AVALANCHE_MAINNET_ENABLED).toBe(false);
  });

  it('PR feat/mainnet: KITE_MAINNET_ENABLED transforms "true" to boolean true', () => {
    const result = parseEnv({ NODE_ENV: 'test', KITE_MAINNET_ENABLED: 'true' });
    expect(result.KITE_MAINNET_ENABLED).toBe(true);
  });

  it('PR feat/mainnet: KITE_MAINNET_ENABLED transforms "false" to boolean false (no truthy coerce)', () => {
    const result = parseEnv({ NODE_ENV: 'test', KITE_MAINNET_ENABLED: 'false' });
    expect(result.KITE_MAINNET_ENABLED).toBe(false);
  });

  it('PR feat/mainnet: AVALANCHE_MAINNET_ENABLED transforms "true" to boolean true', () => {
    const result = parseEnv({ NODE_ENV: 'test', AVALANCHE_MAINNET_ENABLED: 'true' });
    expect(result.AVALANCHE_MAINNET_ENABLED).toBe(true);
  });

  it('PR feat/mainnet: KITE_MAINNET_ENABLED rejects non-enum strings (exit 1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', KITE_MAINNET_ENABLED: 'yes' })).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('KITE_MAINNET_ENABLED');
  });

  it('PR feat/mainnet: KITE_MAINNET_USDC_ADDRESS validates 20-byte hex format', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      parseEnv({ NODE_ENV: 'test', KITE_MAINNET_USDC_ADDRESS: 'not-an-address' }),
    ).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('PR feat/mainnet: KITE_MAINNET_USDC_ADDRESS accepts well-formed addr', () => {
    const result = parseEnv({
      NODE_ENV: 'test',
      KITE_MAINNET_USDC_ADDRESS: '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e',
    });
    expect(result.KITE_MAINNET_USDC_ADDRESS).toBe('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e');
  });

  // ─── WFAC-53 FIX-1 — CORS_ALLOWED_ORIGINS ────────────────────────────────

  it('T-ENV-CORS-1 (FIX-1 AC-2): CORS_ALLOWED_ORIGINS defaults undefined when missing', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('T-ENV-CORS-2 (FIX-1 AC-1, CD-11): parses CSV string as-is (no Zod transform)', () => {
    const result = parseEnv({
      NODE_ENV: 'test',
      CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io,https://app.wasiai.io',
    });
    expect(result.CORS_ALLOWED_ORIGINS).toBe('https://a2a.wasiai.io,https://app.wasiai.io');
    expect(typeof result.CORS_ALLOWED_ORIGINS).toBe('string'); // raw, not transformed
  });

  // ─── WFAC-53 FIX-6 — SETTLE_CAP_FAIL_MODE ────────────────────────────────

  it('T-ENV-FAIL-1 (FIX-6 AC-16, CD-8): SETTLE_CAP_FAIL_MODE defaults "open"', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    expect(result.SETTLE_CAP_FAIL_MODE).toBe('open');
  });

  it('T-ENV-FAIL-2 (FIX-6 AC-15): SETTLE_CAP_FAIL_MODE accepts "closed"', () => {
    const result = parseEnv({ NODE_ENV: 'test', SETTLE_CAP_FAIL_MODE: 'closed' });
    expect(result.SETTLE_CAP_FAIL_MODE).toBe('closed');
  });

  it('T-ENV-FAIL-3 (CD-8 defense): SETTLE_CAP_FAIL_MODE rejects arbitrary strings → exit 1', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'test', SETTLE_CAP_FAIL_MODE: 'maybe' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('SETTLE_CAP_FAIL_MODE');
  });
});
