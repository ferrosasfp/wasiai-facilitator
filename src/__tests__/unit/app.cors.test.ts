/**
 * WFAC-53 FIX-1 — CORS_ALLOWED_ORIGINS unit tests.
 *
 * Pattern: buildApp({ rawEnv }) + app.inject({ method, url, headers }) — mirrors
 * src/__tests__/unit/rate-limiting.test.ts. Each test exercises a different
 * CORS_ALLOWED_ORIGINS configuration end-to-end through @fastify/cors.
 *
 * Refs: AC-1, AC-2, AC-3, CD-11.
 *
 * NOTE (Story §C2 trade-off): `BuildAppOptions.skipDomainCheck` is introduced
 * in C3 (FIX-2). In C2 the chain registry is empty by default in tests →
 * `initDomainCheck` (when wired in C3) will iterate 0 adapters → no-op. The
 * flag will be added to these `buildApp` callers as part of C3's R-4 migration.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

describe('CORS_ALLOWED_ORIGINS — FIX-1 (WFAC-53)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    // Reset Redis singleton between tests (rate-limit plugin reads it on boot).
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('T-CORS-1 (AC-1): whitelisted Origin returns Access-Control-Allow-Origin header', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io,https://app.wasiai.io',
        // RATE_LIMIT_ENABLED=false to isolate CORS-only path:
        RATE_LIMIT_ENABLED: 'false',
      },
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://a2a.wasiai.io',
        'access-control-request-method': 'GET',
      },
    });

    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers['access-control-allow-origin']).toBe('https://a2a.wasiai.io');
  });

  it('T-CORS-2 (AC-1): non-whitelisted Origin gets 403 / no ACAO header', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io',
        RATE_LIMIT_ENABLED: 'false',
      },
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'GET',
      },
    });

    // @fastify/cors responds with no ACAO header (omitted) when origin callback
    // returns false. Some browsers will report a CORS error; the status from
    // the preflight OPTIONS is governed by the plugin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('T-CORS-3 (AC-2, AC-3): empty/absent env → origin:true (reflect)', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        // CORS_ALLOWED_ORIGINS intentionally absent
        RATE_LIMIT_ENABLED: 'false',
      },
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://any-marketplace.example',
        'access-control-request-method': 'GET',
      },
    });

    // Permissive: origin reflected
    expect(res.headers['access-control-allow-origin']).toBe('https://any-marketplace.example');
  });
});
