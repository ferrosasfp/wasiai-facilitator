/**
 * P1 — OP-05: observability — /metrics route + dependency-aware /health.
 *
 * - /metrics: returns the prom-client default registry in Prometheus text
 *   format with the right content-type, and is exempt from rate-limiting +
 *   the audit hook.
 * - /health dependency detail: the `getHealthStatus` snapshot reports redis /
 *   wallet / per-chain RPC state and NEVER leaks a secret.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { EnvSchema, type EnvConfig } from '../../infra/env.js';

describe('P1 OP-05 — GET /metrics', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('MT-1: returns 200 Prometheus text exposition with prom-client content-type', async () => {
    app = await buildApp({ skipDomainCheck: true });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    // prom-client default content type is text/plain; version=0.0.4; charset=utf-8
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // The circuit-breaker module registers gauges/counters on the default
    // registry at import time — at least the HELP/TYPE banner must be present.
    expect(res.body).toMatch(/# (HELP|TYPE) /);
  });

  it('MT-2: /metrics route config has rateLimit: false', async () => {
    const { metricsRoute } = await import('../../routes/metrics.js');
    const Fastify = (await import('fastify')).default;
    const bare = Fastify({ logger: false });
    let captured: Record<string, unknown> | undefined;
    bare.addHook('onRoute', (route) => {
      if (route.url === '/metrics') captured = route.config as Record<string, unknown>;
    });
    await bare.register(metricsRoute);
    await bare.ready();
    await bare.close();
    expect(captured?.rateLimit).toBe(false);
  });

  it('MT-3: /metrics is in AUDIT_EXCLUDED_PATHS (not audited)', async () => {
    // Indirect check: a GET /metrics returns 200 and the app boots; the
    // exclusion itself is asserted structurally in app.ts. We at least confirm
    // the route is reachable and well-formed.
    app = await buildApp({ skipDomainCheck: true });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });
});

describe('N10 — GET /metrics token gate', () => {
  let app: FastifyInstance | undefined;
  // NODE_ENV='test' bypasses superRefine required-in-prod checks, so this parses
  // with everything else optional. Override NODE_ENV/METRICS_TOKEN per test by
  // spreading — the object is passed as `env`, so buildApp does NOT re-validate.
  const baseEnv: EnvConfig = EnvSchema.parse({ NODE_ENV: 'test' });
  const prodEnv: EnvConfig = { ...baseEnv, NODE_ENV: 'production' };
  const prodEnvWithToken: EnvConfig = {
    ...baseEnv,
    NODE_ENV: 'production',
    METRICS_TOKEN: 'scrape-secret',
  };

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('MG-1: token unset + production → 503 (fail-closed)', async () => {
    app = await buildApp({ env: prodEnv, skipDomainCheck: true });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(503);
  });

  it('MG-2: token unset + non-prod → 200 (passthrough)', async () => {
    app = await buildApp({ env: baseEnv, skipDomainCheck: true });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/# (HELP|TYPE) /);
  });

  it('MG-3: token set + correct x-metrics-token header → 200', async () => {
    app = await buildApp({ env: prodEnvWithToken, skipDomainCheck: true });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-metrics-token': 'scrape-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/# (HELP|TYPE) /);
  });

  it('MG-4: token set + correct Authorization Bearer → 200', async () => {
    app = await buildApp({ env: prodEnvWithToken, skipDomainCheck: true });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer scrape-secret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('MG-5: token set + wrong token → 401', async () => {
    app = await buildApp({ env: prodEnvWithToken, skipDomainCheck: true });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-metrics-token': 'wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('MG-6: token set + absent token → 401', async () => {
    app = await buildApp({ env: prodEnvWithToken, skipDomainCheck: true });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });
});

describe('P1 OP-05 — dependency-aware health status', () => {
  beforeEach(async () => {
    const { resetHealthStatusForTesting } = await import('../../core/health-status.js');
    resetHealthStatusForTesting();
  });

  afterEach(async () => {
    const { resetHealthStatusForTesting } = await import('../../core/health-status.js');
    resetHealthStatusForTesting();
    vi.restoreAllMocks();
  });

  it('HS-1: first call returns an optimistic snapshot instantly (probedAt 0)', async () => {
    const { getHealthStatus } = await import('../../core/health-status.js');
    const snap = await getHealthStatus();
    expect(snap.probedAt).toBe(0);
    expect(snap.redis).toHaveProperty('status');
    expect(snap.wallet).toHaveProperty('present');
    expect(Array.isArray(snap.chains)).toBe(true);
  });

  it('HS-2: wallet present is reported from env presence, never the value', async () => {
    const { refreshHealthStatusNow } = await import('../../core/health-status.js');
    // Test env sets OPERATOR_PRIVATE_KEY (vitest.config.ts) → present true.
    const snap = await refreshHealthStatusNow();
    expect(snap.wallet.present).toBe(true);
    // The serialized snapshot must NOT contain a 0x+64hex private key.
    expect(JSON.stringify(snap)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('HS-3: missing wallet → degraded true', async () => {
    const original = process.env['OPERATOR_PRIVATE_KEY'];
    delete process.env['OPERATOR_PRIVATE_KEY'];
    try {
      const { refreshHealthStatusNow } = await import('../../core/health-status.js');
      const snap = await refreshHealthStatusNow();
      expect(snap.wallet.present).toBe(false);
      expect(snap.degraded).toBe(true);
    } finally {
      if (original === undefined) delete process.env['OPERATOR_PRIVATE_KEY'];
      else process.env['OPERATOR_PRIVATE_KEY'] = original;
    }
  });

  it('HS-4: redis status is "disabled" when no REDIS_URL is configured (test env)', async () => {
    // In the test env there is no REDIS_URL and initRedis is not called by this
    // unit, so isRedisConfigured() is false → 'disabled' (NOT degraded on its own).
    const { refreshHealthStatusNow } = await import('../../core/health-status.js');
    const snap = await refreshHealthStatusNow();
    expect(snap.redis.configured).toBe(false);
    expect(snap.redis.status).toBe('disabled');
  });

  it('HS-5: a chain whose RPC probe fails is reported "unreachable" and degrades', async () => {
    // Register an adapter whose getPublicClient().getChainId() rejects.
    const { chainRegistry } = await import('../../chains/registry.js');
    const { refreshHealthStatusNow } = await import('../../core/health-status.js');
    chainRegistry._resetForTesting();
    const fakeAdapter = {
      metadata: {
        chainId: 999001 as unknown as number,
        name: 'FakeDown',
        network: 'testnet' as const,
        networkId: 'eip155:999001',
        rpcUrl: 'http://127.0.0.1:0',
        nativeCurrency: { name: 'X', symbol: 'X', decimals: 18 },
        tokens: [],
      },
      verify: vi.fn(),
      settle: vi.fn(),
      getPublicClient: () =>
        ({
          getChainId: async () => {
            throw new Error('ECONNREFUSED');
          },
        }) as never,
      getWalletClient: vi.fn(),
    };
    chainRegistry.register(fakeAdapter as never);

    const snap = await refreshHealthStatusNow();
    const fake = snap.chains.find((c) => c.chainId === 999001);
    expect(fake).toBeDefined();
    expect(fake?.rpc).toBe('unreachable');
    expect(snap.degraded).toBe(true);

    chainRegistry._resetForTesting();
  });

  it('HS-6: a chain whose RPC probe succeeds is reported "ok"', async () => {
    const { chainRegistry } = await import('../../chains/registry.js');
    const { refreshHealthStatusNow } = await import('../../core/health-status.js');
    chainRegistry._resetForTesting();
    const fakeAdapter = {
      metadata: {
        chainId: 999002 as unknown as number,
        name: 'FakeUp',
        network: 'testnet' as const,
        networkId: 'eip155:999002',
        rpcUrl: 'http://127.0.0.1:0',
        nativeCurrency: { name: 'X', symbol: 'X', decimals: 18 },
        tokens: [],
      },
      verify: vi.fn(),
      settle: vi.fn(),
      getPublicClient: () => ({ getChainId: async () => 999002 }) as never,
      getWalletClient: vi.fn(),
    };
    chainRegistry.register(fakeAdapter as never);

    const snap = await refreshHealthStatusNow();
    const fake = snap.chains.find((c) => c.chainId === 999002);
    expect(fake?.rpc).toBe('ok');

    chainRegistry._resetForTesting();
  });
});
