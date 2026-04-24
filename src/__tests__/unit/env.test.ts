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
    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
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
    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
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

  it('T3: does NOT exit in production when both SUPABASE vars are absent (WFAC-32 CD-4)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
    });
    expect(result.SUPABASE_URL).toBeUndefined();
    expect(result.SUPABASE_SERVICE_KEY).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
