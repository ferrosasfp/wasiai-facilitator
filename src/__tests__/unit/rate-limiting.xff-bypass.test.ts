/**
 * WFAC-AUDIT AC-2 — X-Forwarded-For spoofing bypass is closed.
 *
 * Before this HU, `extractClientIp` parsed the raw first XFF element BEFORE
 * `request.ip`, so an attacker could rotate `X-Forwarded-For` to dodge the
 * per-IP rate-limit bucket. The fix trusts Fastify's resolved `request.ip`
 * exclusively (see src/core/network.ts).
 *
 * Harness copied from rate-limiting.test.ts:makeApp (buildApp({ rawEnv })).
 *
 * R-1 NOTE (empirically validated, see auto-blindaje.md W2): light-my-request
 * marks the inject peer as trusted, so `trustProxy: true` would honor ANY raw
 * XFF and give per-XFF request.ip. The security property AC-2 fixes is that a
 * NON-trusted-proxy attacker cannot evade the bucket by rotating XFF — that is
 * `TRUST_PROXY='false'` (the peer is the untrusted source). Under that config
 * Fastify ignores the raw XFF and keys by the real peer (`remoteAddress`).
 *
 * AC coverage:
 *   - AC-2 → T6 (rotating XFF, same peer → SAME bucket → 429 on 3rd)
 *   - AC-2 → T7 (distinct raw XFF share a bucket; distinct peers do not)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── core/audit.js mock (mirror rate-limiting.test.ts) ─────────────────────
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

async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const rawEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_SEC: '60',
    RATE_LIMIT_VERIFY_MAX: '2',
    RATE_LIMIT_SETTLE_MAX: '2',
    RATE_LIMIT_SUPPORTED_MAX: '2',
    TRUST_PROXY: 'false',
    ...overrides,
  };
  const { buildApp } = await import('../../app.js');
  return buildApp({ rawEnv, skipDomainCheck: true });
}

const ANY_PAYLOAD = JSON.stringify({ anything: 'here' });

describe('WFAC-AUDIT AC-2 — XFF spoofing bypass closed', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  // ─── T6: rotating XFF from the same peer does NOT evade the bucket ────────
  it('T6 / AC-2: 3 requests with ROTATING X-Forwarded-For from the same peer → 429 on the 3rd', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2', TRUST_PROXY: 'false' });

    // Attacker rotates XFF on every request hoping for a fresh bucket each time.
    // Same (untrusted) peer for all → request.ip is stable → SAME bucket.
    const base = { 'content-type': 'application/json' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '1.1.1.1' },
      payload: ANY_PAYLOAD,
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '2.2.2.2' },
      payload: ANY_PAYLOAD,
    });
    const r3 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '3.3.3.3' },
      payload: ANY_PAYLOAD,
    });

    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    // Rotating XFF did NOT reset the bucket → the 3rd is throttled.
    expect(r3.statusCode).toBe(429);
  });

  // ─── T7: request.ip (resolved by Fastify) is the bucket key, NOT raw XFF ──
  it('T7 / AC-2: distinct raw XFF share a bucket (same peer); distinct peers do not', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2', TRUST_PROXY: 'false' });
    const base = { 'content-type': 'application/json' };

    // Two requests, DIFFERENT raw XFF, SAME peer → if XFF were the key these
    // would be in separate buckets; instead they share the peer's bucket.
    const p1a = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '10.0.0.1' },
      remoteAddress: '7.7.7.7',
      payload: ANY_PAYLOAD,
    });
    const p1b = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '10.0.0.2' },
      remoteAddress: '7.7.7.7',
      payload: ANY_PAYLOAD,
    });
    const p1c = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '10.0.0.3' },
      remoteAddress: '7.7.7.7',
      payload: ANY_PAYLOAD,
    });
    // Same peer 7.7.7.7 regardless of XFF → 3rd is throttled (XFF is NOT the key).
    expect(p1a.statusCode).not.toBe(429);
    expect(p1b.statusCode).not.toBe(429);
    expect(p1c.statusCode).toBe(429);

    // A genuinely different peer gets its own fresh bucket (request.ip IS the key).
    const p2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { ...base, 'x-forwarded-for': '10.0.0.1' },
      remoteAddress: '8.8.8.8',
      payload: ANY_PAYLOAD,
    });
    expect(p2.statusCode).not.toBe(429);
  });
});
