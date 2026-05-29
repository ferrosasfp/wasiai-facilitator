/**
 * Cross-cutting integration tests for @fastify/rate-limit wiring (WFAC-40 W3).
 *
 * Strategy: spin up `buildApp({ rawEnv })` with LOW per-route caps
 * (VERIFY_MAX=2, SETTLE_MAX=2, SUPPORTED_MAX=2, WINDOW_SEC=60) so we can
 * trigger 429 with 3 consecutive `app.inject` calls from the same IP
 * (forced via `x-forwarded-for` header).
 *
 * We intentionally do NOT mock Redis nor the rate-limit plugin — the plugin
 * falls back to LocalStore when `getRedisClient()` returns null (NODE_ENV=test
 * + no REDIS_URL). That in-memory store is per-FastifyInstance, which is
 * perfect for test isolation.
 *
 * core/audit.js IS mocked here (mirror pattern from routes.settle.test.ts)
 * so T-RL-14 can verify the onResponse hook fires on 429 replies.
 *
 * AC coverage (12 ACs):
 *   AC-1  → T-RL-1   (/verify 429)
 *   AC-2  → T-RL-2   (/settle 429)
 *   AC-3  → T-RL-3   (/supported 429)
 *   AC-4  → T-RL-4, T-RL-5, T-RL-16 (body shape + content-type + no extras)
 *   AC-5  → T-RL-6   (X-RateLimit-* headers)
 *   AC-6  → T-RL-7   (RATE_LIMIT_ENABLED=false → bypass)
 *   AC-7  → T-RL-8, T-RL-9 (/health and /openapi.json exempt)
 *   AC-8  → T-RL-10  (per-IP keying — two real peers don't share cuota).
 *           WFAC-AUDIT R-1: under trustProxy the raw first XFF element no
 *           longer separates buckets (that was the spoofing vector, AC-2).
 *           T-RL-10 now uses `remoteAddress` (the real peer) with
 *           TRUST_PROXY='false' so request.ip = peer. Intentional semantic
 *           change, NOT a regression. makeApp defaults TRUST_PROXY='false'
 *           so the XFF noise in T-RL-1..9/T-RL-11 is harmless (peer stable).
 *   AC-9  → T-RL-11  (warn log without PII)
 *   AC-10 → T-RL-12  (boot fail-open LocalStore)
 *   AC-11 → T-RL-14  (audit row captures 429)
 *   AC-12 → covered in env.test.ts (T-ENV-RL-*)
 *   CD-11 → T-RL-15  (type-level: RATE_LIMITED NOT in X402ErrorCode)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { X402ErrorCode } from '../../core/types.js';

// ─── core/audit.js mock (mirror routes.settle.test.ts pattern) ─────────────
vi.mock('../../core/audit.js', () => {
  const persistAuditSpy = vi.fn(async () => undefined);
  const buildAuditSpy = vi.fn((input: unknown) => ({ __auditInput: input }));
  return {
    __esModule: true,
    buildAuditEntry: buildAuditSpy,
    persistAuditEntry: persistAuditSpy,
    __persistAuditSpy: persistAuditSpy,
    __buildAuditSpy: buildAuditSpy,
  };
});

// ─── CaptureStream for log assertions ──────────────────────────────────────
class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  getLines(): Array<Record<string, unknown>> {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build an app with low per-route caps so 3 inject calls trigger 429. */
async function makeApp(
  overrides: Record<string, string> = {},
  capture?: CaptureStream,
): Promise<FastifyInstance> {
  const rawEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_SEC: '60',
    RATE_LIMIT_VERIFY_MAX: '2',
    RATE_LIMIT_SETTLE_MAX: '2',
    RATE_LIMIT_SUPPORTED_MAX: '2',
    // WFAC-AUDIT R-1: tests do not depend on proxy infra → request.ip = peer.
    TRUST_PROXY: 'false',
    ...overrides,
  };
  const { buildApp } = await import('../../app.js');
  return buildApp({ rawEnv, loggerDestination: capture, skipDomainCheck: true });
}

/** Arbitrary malformed payload — triggers 400 before rate-limit? No: rate-limit
 * runs in onRequest, BEFORE the handler. So on over-limit requests, we get 429
 * regardless of payload validity. Under-limit requests with bad payload return
 * 400; this is irrelevant to the rate-limit assertions, which only care about
 * statusCode === 429 on the N+1 th call. */
const ANY_PAYLOAD = JSON.stringify({ anything: 'here' });

describe('@fastify/rate-limit integration (WFAC-40)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockClear();
    audit.__buildAuditSpy.mockClear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  // ─── T-RL-1 (AC-1): /verify 429 on max+1 ─────────────────────────────────
  it('T-RL-1 / AC-1: /verify returns 429 after exceeding RATE_LIMIT_VERIFY_MAX', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' };

    const r1 = await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const r2 = await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const r3 = await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });

    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    expect(r3.statusCode).toBe(429);
  });

  // ─── T-RL-2 (AC-2): /settle 429 on max+1 ─────────────────────────────────
  it('T-RL-2 / AC-2: /settle returns 429 after exceeding RATE_LIMIT_SETTLE_MAX', async () => {
    app = await makeApp({ RATE_LIMIT_SETTLE_MAX: '2' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.10' };

    const r1 = await app.inject({ method: 'POST', url: '/settle', headers, payload: ANY_PAYLOAD });
    const r2 = await app.inject({ method: 'POST', url: '/settle', headers, payload: ANY_PAYLOAD });
    const r3 = await app.inject({ method: 'POST', url: '/settle', headers, payload: ANY_PAYLOAD });

    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    expect(r3.statusCode).toBe(429);
  });

  // ─── T-RL-3 (AC-3): /supported 429 on max+1 ──────────────────────────────
  it('T-RL-3 / AC-3: /supported returns 429 after exceeding RATE_LIMIT_SUPPORTED_MAX', async () => {
    app = await makeApp({ RATE_LIMIT_SUPPORTED_MAX: '2' });
    const headers = { 'x-forwarded-for': '9.9.9.11' };

    const r1 = await app.inject({ method: 'GET', url: '/supported', headers });
    const r2 = await app.inject({ method: 'GET', url: '/supported', headers });
    const r3 = await app.inject({ method: 'GET', url: '/supported', headers });

    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    expect(r3.statusCode).toBe(429);
  });

  // ─── T-RL-4 (AC-4): 429 body shape exact ─────────────────────────────────
  it('T-RL-4 / AC-4: 429 body has EXACTLY { error: { code, message, http } } — no extras (CD-3)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.12' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });

    expect(over.statusCode).toBe(429);
    const body = JSON.parse(over.body) as { error: Record<string, unknown> };
    expect(body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
        http: 429,
      },
    });
    expect(Object.keys(body.error).sort()).toEqual(['code', 'http', 'message']);
  });

  // ─── T-RL-5 (AC-4): 429 Content-Type ─────────────────────────────────────
  it('T-RL-5 / AC-4: 429 response is Content-Type application/json', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.13' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });

    expect(over.statusCode).toBe(429);
    const ct = String(over.headers['content-type'] ?? '');
    expect(ct.startsWith('application/json')).toBe(true);
  });

  // ─── T-RL-6 (AC-5): X-RateLimit-* headers ────────────────────────────────
  it('T-RL-6 / AC-5: 429 response includes X-RateLimit-Limit / Remaining / Reset headers', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.14' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });

    expect(over.statusCode).toBe(429);
    // light-my-request normalizes headers to lowercase.
    expect(over.headers['x-ratelimit-limit']).toBeDefined();
    expect(over.headers['x-ratelimit-remaining']).toBeDefined();
    expect(over.headers['x-ratelimit-reset']).toBeDefined();
    expect(String(over.headers['x-ratelimit-limit'])).toBe('1');
    expect(String(over.headers['x-ratelimit-remaining'])).toBe('0');
  });

  // ─── T-RL-7 (AC-6): RATE_LIMIT_ENABLED=false → global bypass ─────────────
  it('T-RL-7 / AC-6: RATE_LIMIT_ENABLED=false → plugin not registered, no 429 ever', async () => {
    app = await makeApp({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_VERIFY_MAX: '2' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.15' };

    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/verify',
        headers,
        payload: ANY_PAYLOAD,
      });
      results.push(r.statusCode);
    }
    expect(results.every((s) => s !== 429)).toBe(true);
  });

  // ─── T-RL-8 (AC-7): /health exempt ───────────────────────────────────────
  it('T-RL-8 / AC-7: /health never triggers 429 (config.rateLimit:false)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'x-forwarded-for': '9.9.9.16' };

    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'GET', url: '/health', headers });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  // ─── T-RL-9 (AC-7): /openapi.json exempt ─────────────────────────────────
  it('T-RL-9 / AC-7: /openapi.json never triggers 429 (config.rateLimit:false, CD-6)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'x-forwarded-for': '9.9.9.17' };

    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'GET', url: '/openapi.json', headers });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  // ─── T-RL-10 (AC-8): per-IP keying — two real peers don't share cuota ────
  // WFAC-AUDIT R-1 (INTENTIONAL semantic change, NOT a regression): under
  // trustProxy the raw first X-Forwarded-For element no longer separates
  // rate-limit buckets — rotating XFF WAS the bypass (AC-2). Buckets are now
  // keyed by the resolved request.ip. With TRUST_PROXY='false' (makeApp
  // default), request.ip = the real peer (light-my-request `remoteAddress`).
  // The assertion (two distinct IPs → separate quotas) is preserved; only the
  // VECTOR changed from spoofable XFF to the real peer address.
  it('T-RL-10 / AC-8: distinct peer IPs consume separate quotas (remoteAddress)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2' });

    const headers = { 'content-type': 'application/json' };

    const a1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      remoteAddress: '1.1.1.1',
      payload: ANY_PAYLOAD,
    });
    const a2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      remoteAddress: '1.1.1.1',
      payload: ANY_PAYLOAD,
    });
    const b1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      remoteAddress: '2.2.2.2',
      payload: ANY_PAYLOAD,
    });

    expect(a1.statusCode).not.toBe(429);
    expect(a2.statusCode).not.toBe(429);
    // Peer 2.2.2.2's first call: should not be 429 — separate quota.
    expect(b1.statusCode).not.toBe(429);
  });

  // ─── T-RL-11 (AC-9): warn log emitted with NO PII ────────────────────────
  it('T-RL-11 / AC-9: rate limit exceeded log has request_id+path, NO ip/user_agent', async () => {
    const capture = new CaptureStream();
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' }, capture);
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.18' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });
    expect(over.statusCode).toBe(429);

    const lines = capture.getLines();
    const logEntry = lines.find((l) => l.msg === 'rate limit exceeded');
    expect(logEntry).toBeDefined();
    expect(logEntry).toHaveProperty('request_id');
    expect(logEntry).toHaveProperty('path');
    expect(logEntry).not.toHaveProperty('ip');
    expect(logEntry).not.toHaveProperty('user_agent');
    expect(logEntry).not.toHaveProperty('userAgent');
  });

  // ─── T-RL-12 (AC-10): boot fail-open when Redis null (LocalStore) ────────
  it('T-RL-12 / AC-10: boots without REDIS_URL — LocalStore fallback, /health returns 200', async () => {
    // `makeApp()` defaults to NODE_ENV=test without REDIS_URL → getRedisClient()
    // returns null → plugin uses LocalStore. This test proves the boot path
    // doesn't throw (DT-10 SDD).
    app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  // ─── T-RL-14 (AC-11): audit hook captures 429 ────────────────────────────
  it('T-RL-14 / AC-11: onResponse audit hook fires on 429 with statusCode=429 and path=/verify', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.19' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });
    expect(over.statusCode).toBe(429);

    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    // last call corresponds to the 429 response. The hook normally receives
    // the exact status; /verify is NOT in AUDIT_EXCLUDED_PATHS so the hook
    // runs for all responses including 429.
    const calls = audit.__buildAuditSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastInput = calls[calls.length - 1]?.[0] as {
      statusCode: number;
      path: string;
    };
    expect(lastInput.statusCode).toBe(429);
    expect(lastInput.path).toBe('/verify');
  });

  // ─── T-RL-15 (CD-11): type-level assertion RATE_LIMITED NOT in X402ErrorCode
  it('T-RL-15 / CD-11: "RATE_LIMITED" is NOT part of X402ErrorCode union (compile-time)', async () => {
    const types = await import('../../core/types.js');
    // Runtime sanity: the X402ErrorCode type is a TS-only union so we can't
    // directly assert its contents. The type-level assertion below (with
    // @ts-expect-error) is the real test — if someone extends the union
    // with 'RATE_LIMITED', the comment's directive becomes a compile error.
    //
    // @ts-expect-error — RATE_LIMITED MUST NOT be assignable to X402ErrorCode.
    const _bad: X402ErrorCode = 'RATE_LIMITED';
    void _bad;
    // Runtime assertion: the module exports nothing called 'RATE_LIMITED'.
    expect((types as Record<string, unknown>).RATE_LIMITED).toBeUndefined();
  });

  // ─── T-RL-16 (AC-4 + CD-3): no extra fields in 429 body ──────────────────
  it('T-RL-16 / AC-4 + CD-3: 429 body does NOT contain retryAfter/limit/remaining/reset/ban', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '1' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.20' };

    await app.inject({ method: 'POST', url: '/verify', headers, payload: ANY_PAYLOAD });
    const over = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });
    expect(over.statusCode).toBe(429);
    const body = JSON.parse(over.body) as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('retryAfter');
    expect(body.error).not.toHaveProperty('limit');
    expect(body.error).not.toHaveProperty('remaining');
    expect(body.error).not.toHaveProperty('reset');
    expect(body.error).not.toHaveProperty('ban');
    expect(body.error).not.toHaveProperty('after');
  });

  // ─── T-RL-17 (CD-13): disabled build does NOT expose X-RateLimit-* headers
  it('T-RL-17 / CD-13: RATE_LIMIT_ENABLED=false → no X-RateLimit-* headers on any response', async () => {
    app = await makeApp({ RATE_LIMIT_ENABLED: 'false' });
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.21' };

    const r = await app.inject({
      method: 'POST',
      url: '/verify',
      headers,
      payload: ANY_PAYLOAD,
    });
    expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    expect(r.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(r.headers['x-ratelimit-reset']).toBeUndefined();
  });
});
