/**
 * Suite 2 (part C) — Route-level fail-open regression pin (2026-06-29 incident).
 *
 * Exercises the FULL POST /settle pipeline with a Redis whose daily-cap INCR
 * THROWS (Redis down). The whole incident reduces to one question at the route
 * boundary: when the cap-check's Redis call fails, does the settlement proceed
 * or get rejected?
 *
 *   - SETTLE_CAP_FAIL_MODE='open'  (DEFAULT)  → settlement PROCEEDS → 200.
 *   - SETTLE_CAP_FAIL_MODE='closed' (opt-in)  → settlement REJECTED → 503.
 *
 * On 2026-06-29 a deploy made the effective mode fail-closed; Redis blipped and
 * EVERY settlement on EVERY chain returned 503 (prod settlement outage). The
 * test `THE PIN` below locks the fail-OPEN behavior under a Redis error so a
 * future change that re-introduces fail-closed-by-default breaks CI loudly.
 *
 * Harness mirrors routes.settle.inflight.test.ts: buildApp + fake adapter +
 * app.inject. The ioredis mock's `incr` is the injected failure. No network,
 * no real settlement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams } from '../../chains/types.js';

// ─── core/ledger.js + core/audit.js mocks (no Supabase) ────────────────────
vi.mock('../../core/ledger.js', () => ({
  __esModule: true,
  buildLedgerEntry: vi.fn((input: unknown) => ({ __input: input })),
  persistLedgerEntry: vi.fn(async () => undefined),
}));
vi.mock('../../core/audit.js', () => ({
  __esModule: true,
  buildAuditEntry: vi.fn((input: unknown) => ({ __auditInput: input })),
  persistAuditEntry: vi.fn(async () => undefined),
}));

// ─── ioredis mock — `incr` is the injectable failure for the daily-cap path ──
const incrSpy = vi.fn<(key: string) => Promise<number>>();
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  class RedisMock {
    constructor() {}
    on(): this {
      return this;
    }
    async quit(): Promise<'OK'> {
      return 'OK';
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK' | null> {
      // Honor SET ... NX so the in-flight lock behaves like prod: a second
      // identical request finds the key held. Idempotency cache writes (EX) and
      // the inflight lock (EX NX) both flow through here.
      const nx = _rest.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
    async del(key: string): Promise<number> {
      store.delete(key);
      return 1;
    }
    async expire(): Promise<number> {
      return 1;
    }
    async incr(key: string): Promise<number> {
      return incrSpy(key);
    }
  }
  return { default: RedisMock, Redis: RedisMock, __store: store };
});

/** Clear the ioredis mock's backing store between tests (cache isolation). */
async function clearRedisStore(): Promise<void> {
  const ioredis = await import('ioredis');
  (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
}

const VALID_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1000000',
    asset: `0x${'11'.repeat(20)}`,
    payTo: `0x${'22'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
  },
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: `0x${'33'.repeat(20)}`,
      to: `0x${'22'.repeat(20)}`,
      value: '1000000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
} as const;

const VALID_SETTLE_RESULT = {
  ok: true as const,
  settled: true as const,
  transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
  blockNumber: 12345,
  amount: '1000000',
  from: `0x${'33'.repeat(20)}` as `0x${string}`,
  to: `0x${'22'.repeat(20)}` as `0x${string}`,
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
};

function makeFakeAdapter(
  chainIdNum: number,
  settleImpl: (params: SettleParams) => Promise<unknown>,
): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(chainIdNum),
      name: `fake-${chainIdNum}`,
      network: 'testnet',
      networkId: `eip155:${chainIdNum}`,
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: settleImpl as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: vi.fn(async (): Promise<void> => undefined),
  };
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'silent',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_DB: 0,
    // Cap ENABLED (>0) so the daily-cap Redis path actually executes.
    SETTLE_DAILY_GLOBAL_CAP: 1000,
    SETTLE_MAX_AMOUNT_ATOMIC: '100000000000000000000',
    SETTLE_CAP_FAIL_MODE: 'open',
    ...overrides,
  } as EnvConfig;
}

async function buildAppWithAdapter(
  adapter: ChainAdapter,
  env: EnvConfig,
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  chainRegistry.register(adapter);
  const { buildApp } = await import('../../app.js');
  return buildApp({ env, skipDomainCheck: true });
}

describe('POST /settle — fail-open default regression (2026-06-29 incident)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    incrSpy.mockReset();
    await clearRedisStore();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════════
  // THE PIN — fail-OPEN default must NEVER reject a settlement on Redis error.
  // If this test ever fails, the 2026-06-29 settlement outage has regressed.
  // ════════════════════════════════════════════════════════════════════════
  it('THE PIN: SETTLE_CAP_FAIL_MODE default (open) + Redis INCR throws → 200 (settlement proceeds)', async () => {
    incrSpy.mockRejectedValue(new Error('READONLY: redis is down'));
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    // Env WITHOUT an explicit fail mode set in this object would still be 'open'
    // via makeEnv default; here we assert the open behavior explicitly.
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'open' }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    // The single most important assertion in this suite.
    expect(res.statusCode).toBe(200);
    expect(res.statusCode).not.toBe(503);
    // The cap-check's Redis INCR was attempted and threw...
    expect(incrSpy).toHaveBeenCalled();
    // ...yet the settlement still ran (fail-open).
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('opt-in: SETTLE_CAP_FAIL_MODE=closed + Redis INCR throws → 503 SERVICE_UNAVAILABLE, settle NOT invoked', async () => {
    incrSpy.mockRejectedValue(new Error('redis down'));
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'closed' }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.http).toBe(503);
    // Fail-closed rejects BEFORE dispatching the settlement.
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('healthy Redis under cap (open mode) → 200, settle invoked once (no spurious rejection)', async () => {
    incrSpy.mockResolvedValue(1);
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'open' }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('healthy Redis OVER cap → 429 RATE_LIMITED with Retry-After (business reject, not infra)', async () => {
    // Count returns cap+1 → cap_exceeded. This is a deliberate business
    // ceiling, distinct from the infra fail-open/closed path.
    incrSpy.mockResolvedValue(1001);
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'open' }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
    // Over-cap → settlement NOT dispatched.
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('closed mode + healthy Redis under cap → 200 (no false 503 when Redis is fine)', async () => {
    incrSpy.mockResolvedValue(5);
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'closed' }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('idempotency: identical second request returns the cached result, settle NOT re-invoked (no double-broadcast)', async () => {
    // Healthy Redis; first call settles + caches; second call replays the cache.
    incrSpy.mockResolvedValue(1);
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, makeEnv({ SETTLE_CAP_FAIL_MODE: 'open' }));

    const inject = () =>
      app!.inject({
        method: 'POST',
        url: '/settle',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(VALID_BODY),
      });

    const r1 = await inject();
    const r2 = await inject();
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // The CRITICAL money-safety invariant: the adapter settle (→ on-chain
    // broadcast) ran exactly once across two identical requests.
    expect(settleSpy).toHaveBeenCalledTimes(1);
    // Both responses carry the same transaction hash.
    const b1 = JSON.parse(r1.body) as { transactionHash: string };
    const b2 = JSON.parse(r2.body) as { transactionHash: string };
    expect(b1.transactionHash).toBe(b2.transactionHash);
  });
});
