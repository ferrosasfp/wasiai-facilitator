/**
 * Production hardening startup warnings (AUDIT).
 *
 * buildApp() must emit a loud `warn` at boot, in production, when the config
 * carries an operational/availability trade-off:
 *   - SETTLE_CAP_FAIL_MODE=open       (fail-open caps — wallet-drain risk; this
 *                                      is the SAFE default while Redis is non-HA)
 *   - RATE_LIMIT_FAIL_OPEN=true       (fail-open rate-limit)
 *   - CORS_ALLOWED_ORIGINS unset      (permissive CORS)
 * It must NOT emit them when configured securely, nor outside production.
 *
 * These warnings change NO behavior (no fail-fast) — they surface drift only.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

// Minimal prod env satisfying superRefine (REDIS_URL, OPERATOR_PRIVATE_KEY,
// KITE_USDC_ADDRESS, FACILITATOR_API_KEY required when NODE_ENV != test).
const PROD_BASE = {
  NODE_ENV: 'production',
  REDIS_URL: 'redis://localhost:6379/0',
  OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
  KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
  FACILITATOR_API_KEY: 'a-long-random-secret',
  // Disable rate-limit plugin registration where not under test, and avoid the
  // domain check; both are orthogonal to the warnings.
  RATE_LIMIT_ENABLED: 'false',
} as const;

describe('production startup hardening warnings (AUDIT)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('warns when SETTLE_CAP_FAIL_MODE=open in production', async () => {
    const cap = new CaptureStream();
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: { ...PROD_BASE, SETTLE_CAP_FAIL_MODE: 'open', CORS_ALLOWED_ORIGINS: 'https://x.io' },
      loggerDestination: cap,
      skipDomainCheck: true,
    });
    expect(cap.text()).toContain('SETTLE_CAP_FAIL_MODE');
    expect(cap.text()).toContain('FAIL-OPEN');
    // Reworded (2026-06-29 incident): the warning must NOT nudge operators to
    // set fail-closed unconditionally; it must condition fail-closed on HA Redis.
    expect(cap.text()).toContain('HA');
    expect(cap.text()).not.toContain('Recommended: SETTLE_CAP_FAIL_MODE=closed');
  });

  it('warns when CORS_ALLOWED_ORIGINS is unset in production', async () => {
    const cap = new CaptureStream();
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: { ...PROD_BASE, SETTLE_CAP_FAIL_MODE: 'closed' }, // CORS unset
      loggerDestination: cap,
      skipDomainCheck: true,
    });
    expect(cap.text()).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('warns when RATE_LIMIT_FAIL_OPEN=true with rate-limit enabled in production', async () => {
    const cap = new CaptureStream();
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        ...PROD_BASE,
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_FAIL_OPEN: 'true',
        SETTLE_CAP_FAIL_MODE: 'closed',
        CORS_ALLOWED_ORIGINS: 'https://x.io',
      },
      loggerDestination: cap,
      skipDomainCheck: true,
    });
    expect(cap.text()).toContain('RATE_LIMIT_FAIL_OPEN');
  });

  it('does NOT warn when configured securely in production', async () => {
    const cap = new CaptureStream();
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        ...PROD_BASE,
        SETTLE_CAP_FAIL_MODE: 'closed',
        RATE_LIMIT_FAIL_OPEN: 'false',
        CORS_ALLOWED_ORIGINS: 'https://app.wasiai.io',
      },
      loggerDestination: cap,
      skipDomainCheck: true,
    });
    const out = cap.text();
    expect(out).not.toContain('SECURITY:');
  });
});
