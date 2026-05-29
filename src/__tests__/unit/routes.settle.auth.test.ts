/**
 * Auth preHandler tests for /settle + /verify (WFAC-AUDIT AC-1).
 *
 * Harness copied from routes.settle.test.ts / routes.verify.test.ts
 * (makeEnv + buildAppWithAdapter + app.inject). The preHandler
 * `requireFacilitatorKey` rejects with 401 BEFORE the route handler runs.
 *
 * AC coverage:
 *   - AC-1 → T1 (settle no header), T2 (settle wrong key), T3 (settle valid key),
 *            T4 (verify no header), T5 (env without key → bypass)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams, VerifyParams } from '../../chains/types.js';

// ─── core/ledger.js mock ────────────────────────────────────────────────────
vi.mock('../../core/ledger.js', () => {
  const persistSpy = vi.fn(async () => undefined);
  const buildSpy = vi.fn((input: unknown) => ({ __input: input }));
  return {
    __esModule: true,
    buildLedgerEntry: buildSpy,
    persistLedgerEntry: persistSpy,
    __persistSpy: persistSpy,
    __buildSpy: buildSpy,
  };
});

// ─── core/audit.js mock ─────────────────────────────────────────────────────
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

// ─── ioredis mock ───────────────────────────────────────────────────────────
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));
  const store = new Map<string, string>();
  const setSpy = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK' as const;
  });
  const getSpy = vi.fn(async (key: string) => store.get(key) ?? null);

  class RedisMock {
    options: Record<string, unknown>;
    url: string;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(url: string, opts: Record<string, unknown>) {
      constructorSpy(url, opts);
      this.url = url;
      this.options = opts;
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(handler);
      this.listeners.set(event, arr);
      return this;
    }
    quit(): Promise<'OK'> {
      return quitSpy();
    }
    get(key: string): Promise<string | null> {
      return getSpy(key);
    }
    set(key: string, value: string): Promise<'OK'> {
      return setSpy(key, value);
    }
  }

  return {
    default: RedisMock,
    Redis: RedisMock,
    __constructorSpy: constructorSpy,
    __quitSpy: quitSpy,
    __setSpy: setSpy,
    __getSpy: getSpy,
    __store: store,
  };
});

// ─── fixtures ────────────────────────────────────────────────────────────────

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

const VALID_VERIFY_RESULT = {
  ok: true as const,
  verified: true as const,
  client: `0x${'33'.repeat(20)}` as `0x${string}`,
  amount: '1000000',
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
  network: 'eip155:2368',
  payTo: `0x${'22'.repeat(20)}` as `0x${string}`,
  expiresAt: 99999999999,
};

function makeFakeAdapter(
  chainIdNum: number,
  impls: {
    settle?: (params: SettleParams) => Promise<unknown>;
    verify?: (params: VerifyParams) => Promise<unknown>;
  },
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
    verify: (impls.verify ?? vi.fn()) as ChainAdapter['verify'],
    settle: (impls.settle ?? vi.fn()) as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
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

const KEY = 'test-secret-key';

// ─── tests ─────────────────────────────────────────────────────────────────

describe('requireFacilitatorKey preHandler (WFAC-AUDIT AC-1)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('T1: POST /settle without Authorization header → 401 UNAUTHORIZED', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, { settle: settleSpy });
    app = await buildAppWithAdapter(adapter, makeEnv({ FACILITATOR_API_KEY: KEY }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.http).toBe(401);
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T2: POST /settle with wrong bearer key → 401', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, { settle: settleSpy });
    app = await buildAppWithAdapter(adapter, makeEnv({ FACILITATOR_API_KEY: KEY }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T2b: POST /settle with same-length but different key → 401 (forces timingSafeEqual branch)', async () => {
    // 'test-secret-key' (15 chars) vs 'test-secret-keX' (15 chars): equal
    // length means the `a.length !== b.length` pre-check is FALSE, so the
    // 401 MUST come from `!timingSafeEqual(a, b)`. Guards against a regression
    // where the comparison is inverted (would let this through as a match).
    const wrongSameLen = 'test-secret-keX';
    expect(wrongSameLen.length).toBe(KEY.length);

    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, { settle: settleSpy });
    app = await buildAppWithAdapter(adapter, makeEnv({ FACILITATOR_API_KEY: KEY }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongSameLen}` },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T3: POST /settle with valid bearer key → passes preHandler into pipeline (not 401)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, { settle: settleSpy });
    app = await buildAppWithAdapter(adapter, makeEnv({ FACILITATOR_API_KEY: KEY }));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('T4: POST /verify without Authorization header → 401 (same preHandler)', async () => {
    const verifySpy = vi.fn(async () => VALID_VERIFY_RESULT);
    const adapter = makeFakeAdapter(2368, { verify: verifySpy });
    app = await buildAppWithAdapter(adapter, makeEnv({ FACILITATOR_API_KEY: KEY }));

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('T5: FACILITATOR_API_KEY absent in env → preHandler bypass → request proceeds (not 401)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, { settle: settleSpy });
    // No FACILITATOR_API_KEY in env → bypass (NODE_ENV test-style behavior).
    app = await buildAppWithAdapter(adapter, makeEnv());

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });
});
