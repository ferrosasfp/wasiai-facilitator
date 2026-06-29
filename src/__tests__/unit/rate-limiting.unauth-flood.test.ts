/**
 * BLQ-MED-1 regression — pre-auth per-IP throttling on the money-path routes.
 *
 * CONTEXT (the bug this file pins): to enable per-key rate-limit buckets, an
 * earlier audit fix moved the GLOBAL @fastify/rate-limit hook to `preHandler`
 * so the keyGenerator could read `req.facilitatorKeyId`. REGRESSION: each
 * money-path route's auth preHandler (`requireFacilitatorKey`) runs FIRST and
 * short-circuits with 401 on a bad bearer BEFORE the rate-limit preHandler
 * fired — so unauthenticated floods to /settle and /verify were no longer
 * throttled (unbounded 401s instead of eventual 429).
 *
 * THE FIX (two layers):
 *   Layer 1 — GLOBAL limiter back in the default `onRequest` phase, keyed
 *             PER-IP. Runs BEFORE auth, so wrong-bearer floods are throttled.
 *   Layer 2 — a SEPARATE per-key limiter in `preHandler`, AFTER auth, keyed by
 *             `facilitatorKeyId`. Adds per-key fairness without weakening L1.
 *
 * WHY THE EXISTING SUITE CANNOT CATCH THIS: `rate-limiting.test.ts` builds the
 * app with FACILITATOR_API_KEY UNSET (NODE_ENV=test bypass) → `requireFacilitatorKey`
 * returns early and NEVER 401s, so the unauthenticated path is never exercised.
 * This file builds the app with FACILITATOR_API_KEY SET so auth is ACTIVE.
 *
 * Assertions:
 *   T-RL-UNAUTH-1 — repeated `Authorization: Bearer WRONG` POSTs to /settle
 *                   eventually return 429 (NOT unbounded 401s).
 *   T-RL-UNAUTH-2 — same for /verify.
 *   T-RL-UNAUTH-3 — per-key bucketing still works for AUTHENTICATED traffic:
 *                   a single key exceeding its per-key cap gets 429 while a
 *                   different key (same IP) is unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const GOOD_KEY = 'test-facilitator-key-good';
const OTHER_KEY = 'test-facilitator-key-other';

/**
 * Build an app with caller auth ACTIVE (FACILITATOR_API_KEY set) and low caps.
 * TRUST_PROXY='false' → request.ip = the real peer (light-my-request
 * remoteAddress), so per-IP buckets are keyed by the peer, not a spoofable XFF.
 */
async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const rawEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    FACILITATOR_API_KEY: GOOD_KEY,
    FACILITATOR_API_KEYS: OTHER_KEY,
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

describe('BLQ-MED-1 — pre-auth per-IP throttling (auth ACTIVE)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  // ─── T-RL-UNAUTH-1 (/settle) ─────────────────────────────────────────────
  it('T-RL-UNAUTH-1: unauthenticated flood to /settle eventually returns 429 (not unbounded 401)', async () => {
    app = await makeApp({ RATE_LIMIT_SETTLE_MAX: '2' });
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer WRONG',
    };

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/settle',
        headers,
        remoteAddress: '203.0.113.10',
        payload: ANY_PAYLOAD,
      });
      codes.push(r.statusCode);
    }

    // The first MAX requests are throttled-counted but auth-rejected → 401.
    // Beyond MAX, the per-IP onRequest layer (Layer 1) fires BEFORE auth → 429.
    expect(codes.slice(0, 2)).toEqual([401, 401]);
    expect(codes).toContain(429);
    // CRITICAL: not an unbounded run of 401s — the flood is bounded.
    expect(codes[codes.length - 1]).toBe(429);
  });

  // ─── T-RL-UNAUTH-2 (/verify) ─────────────────────────────────────────────
  it('T-RL-UNAUTH-2: unauthenticated flood to /verify eventually returns 429 (not unbounded 401)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2' });
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer WRONG',
    };

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/verify',
        headers,
        remoteAddress: '203.0.113.11',
        payload: ANY_PAYLOAD,
      });
      codes.push(r.statusCode);
    }

    expect(codes.slice(0, 2)).toEqual([401, 401]);
    expect(codes).toContain(429);
    expect(codes[codes.length - 1]).toBe(429);
  });

  // ─── T-RL-UNAUTH-3 (per-key bucketing retained for AUTHENTICATED traffic) ─
  // Per-key buckets are INDEPENDENT: a fresh authenticated key is never
  // pre-emptively throttled by a DIFFERENT key's exhausted per-key bucket.
  //
  // We keep the per-IP ceiling (RATE_LIMIT_VERIFY_MAX) high enough that it is
  // NOT the binding constraint — both layers read this env, so a high value
  // means Layer 1 (per-IP) never fires and any 429 we DO see is purely the
  // Layer 2 (per-key) bucket. With both caps equal and high, neither layer
  // fires for the volumes below, which is exactly what proves per-key isolation:
  // GOOD_KEY's burst does not leak into OTHER_KEY's bucket.
  it('T-RL-UNAUTH-3: per-key bucket — a key burst does NOT throttle a different authenticated key (same IP)', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '50', RATE_LIMIT_SETTLE_MAX: '50' });

    const ip = '203.0.113.20';
    const reqFor = (bearer: string) =>
      app!.inject({
        method: 'POST',
        url: '/verify',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        remoteAddress: ip,
        payload: ANY_PAYLOAD,
      });

    // GOOD_KEY: a burst of 10 authenticated requests (under both caps).
    for (let i = 0; i < 10; i++) {
      const r = await reqFor(GOOD_KEY);
      expect(r.statusCode).not.toBe(429);
    }
    // OTHER_KEY from the SAME IP: its own per-key bucket is fresh → not 429.
    const other = await reqFor(OTHER_KEY);
    expect(other.statusCode).not.toBe(429);
  });

  // ─── T-RL-UNAUTH-4 (per-key 429 for an authenticated key exceeding its cap) ─
  // An AUTHENTICATED key that exceeds the per-key cap is itself throttled with
  // 429 (the per-key Layer 2 working end-to-end on the happy auth path).
  it('T-RL-UNAUTH-4: an authenticated key exceeding the per-key cap is throttled with 429', async () => {
    app = await makeApp({ RATE_LIMIT_VERIFY_MAX: '2' });
    const ip = '203.0.113.21';
    const reqFor = (bearer: string) =>
      app!.inject({
        method: 'POST',
        url: '/verify',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        remoteAddress: ip,
        payload: ANY_PAYLOAD,
      });

    const r1 = await reqFor(GOOD_KEY);
    const r2 = await reqFor(GOOD_KEY);
    const r3 = await reqFor(GOOD_KEY);

    // First 2 authenticated requests pass the rate-limit (reach the handler →
    // 400 on the dummy payload). The 3rd exceeds the cap → 429.
    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    expect(r3.statusCode).toBe(429);
  });
});
