/**
 * Unit tests for the WFAC-21 settle helpers in src/core/idempotency.ts.
 *
 * Pattern inherited from core.idempotency.test.ts (E10):
 *   - vi.mock('ioredis') with a minimal Redis class that backs get/set
 *     with a Map + per-test error overrides.
 *   - resetRedisClientForTests() in beforeEach to guarantee isolation.
 *
 * Coverage map:
 *   - T-I1  : SETTLE_IDEMPOTENCY_TTL_SEC === 120 (CD-7).
 *   - T-I2  : SETTLE_IDEMPOTENCY_KEY_PREFIX distinct from verify (CD-6).
 *   - T-I3  : buildSettleIdempotencyKey stable across permutations.
 *   - T-I4  : buildSettleIdempotencyKey !== buildIdempotencyKey for same body.
 *   - T-I5  : buildSettleIdempotencyKey differs for distinct payloads.
 *   - T-I6  : getCachedSettleResponse null when client null.
 *   - T-I7  : getCachedSettleResponse swallows .get throw.
 *   - T-I8  : setCachedSettleResponse swallows .set throw (CD-4).
 *   - T-I9  : setCachedSettleResponse uses EX TTL === SETTLE_IDEMPOTENCY_TTL_SEC.
 *   - T-I10 : setCachedSettleResponse no-op when client null.
 *   - T-I11 : toCacheableSettle http=500 returns null (CD-12).
 *   - T-I12 : toCacheableSettle http=502 returns null (CD-12).
 *   - T-I13 : toCacheableSettle http=4xx cached verbatim.
 *   - T-I14 : toCacheableSettle ok=true preserves 7 spec fields.
 *   - T-I15 : round-trip set → get via RedisMock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { Logger } from 'pino';
import type { EnvConfig } from '../../infra/env.js';

// ─── ioredis mock (mirrors E10 pattern) ────────────────────────────────────
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<() => Promise<'OK'>>(() => Promise.resolve('OK'));
  const store = new Map<string, string>();
  const setSpy = vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
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

    set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
      return setSpy(key, value, mode, ttl);
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

// Mocks typed against pino's real `LogFn` signatures so the double is
// assignable to `RedisLogger` (= Pick<Logger, 'info' | 'error' | 'warn'>). A bare
// `vi.fn()` is `Mock<Procedure>` and does NOT satisfy pino's overloads.
function makeFakeLogger(): {
  info: Mock<Logger['info']>;
  error: Mock<Logger['error']>;
  warn: Mock<Logger['warn']>;
} {
  return {
    info: vi.fn<Logger['info']>(),
    error: vi.fn<Logger['error']>(),
    warn: vi.fn<Logger['warn']>(),
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
    // Deliberately partial (repo idiom, cf. routes.settle.failopen.test.ts): this
    // fixture sets only the fields the unit under test reads. The cast is what lets
    // it stand in for EnvConfig — every field NOT listed above reaches the code as
    // `undefined` even though EnvConfig declares it required.
  } as EnvConfig;
}

const VALID_PARSED = {
  x402Version: 2 as const,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact' as const,
    network: 'eip155:2368',
    amount: '1000000',
    asset: `0x${'11'.repeat(20)}`,
    payTo: `0x${'22'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'eip3009' as const,
      name: 'PYUSD',
      version: '1',
    },
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
};

// ─── T-I1 / T-I2: constants ────────────────────────────────────────────────

describe('SETTLE_IDEMPOTENCY_TTL_SEC + SETTLE_IDEMPOTENCY_KEY_PREFIX', () => {
  it('T-I1: SETTLE_IDEMPOTENCY_TTL_SEC === 120 (CD-7)', async () => {
    const { SETTLE_IDEMPOTENCY_TTL_SEC } = await import('../../core/idempotency.js');
    expect(SETTLE_IDEMPOTENCY_TTL_SEC).toBe(120);
  });

  it('T-I2: SETTLE_IDEMPOTENCY_KEY_PREFIX === "settle:idempotency:" and distinct from verify (CD-6)', async () => {
    const { SETTLE_IDEMPOTENCY_KEY_PREFIX, VERIFY_IDEMPOTENCY_KEY_PREFIX } =
      await import('../../core/idempotency.js');
    expect(SETTLE_IDEMPOTENCY_KEY_PREFIX).toBe('settle:idempotency:');
    expect(SETTLE_IDEMPOTENCY_KEY_PREFIX).not.toBe(VERIFY_IDEMPOTENCY_KEY_PREFIX);
  });
});

// ─── T-I3 / T-I4 / T-I5: buildSettleIdempotencyKey ────────────────────────

describe('buildSettleIdempotencyKey', () => {
  it('T-I3: stable across top-level key permutations', async () => {
    const { buildSettleIdempotencyKey } = await import('../../core/idempotency.js');
    const a = VALID_PARSED;
    const b = {
      payload: a.payload,
      accepted: a.accepted,
      resource: a.resource,
      x402Version: a.x402Version,
    } as typeof VALID_PARSED;
    expect(buildSettleIdempotencyKey(a)).toBe(buildSettleIdempotencyKey(b));
  });

  it('T-I4: differs from buildIdempotencyKey for same payload (CD-6 prefix separation)', async () => {
    const { buildSettleIdempotencyKey, buildIdempotencyKey } =
      await import('../../core/idempotency.js');
    const verifyKey = buildIdempotencyKey(VALID_PARSED);
    const settleKey = buildSettleIdempotencyKey(VALID_PARSED);
    expect(settleKey).not.toBe(verifyKey);
    expect(settleKey.startsWith('settle:idempotency:')).toBe(true);
    expect(verifyKey.startsWith('verify:idempotency:')).toBe(true);
  });

  it('T-I5: differs for distinct payloads (accepted.amount changed)', async () => {
    const { buildSettleIdempotencyKey } = await import('../../core/idempotency.js');
    const a = VALID_PARSED;
    const b = { ...a, accepted: { ...a.accepted, amount: '2000000' } };
    expect(buildSettleIdempotencyKey(a)).not.toBe(buildSettleIdempotencyKey(b));
  });

  it('T-I5b: settle key has prefix + 64-char hex suffix', async () => {
    const { buildSettleIdempotencyKey, SETTLE_IDEMPOTENCY_KEY_PREFIX } =
      await import('../../core/idempotency.js');
    const key = buildSettleIdempotencyKey(VALID_PARSED);
    expect(key.startsWith(SETTLE_IDEMPOTENCY_KEY_PREFIX)).toBe(true);
    const suffix = key.slice(SETTLE_IDEMPOTENCY_KEY_PREFIX.length);
    expect(suffix).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── T-I6 .. T-I10 + T-I15: cache read/write ───────────────────────────────

describe('getCachedSettleResponse / setCachedSettleResponse', () => {
  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy.mockClear();
    (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy.mockClear();
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-I6: getCachedSettleResponse returns null when client null', async () => {
    const { getCachedSettleResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());
    await expect(getCachedSettleResponse('settle:idempotency:x')).resolves.toBeNull();
  });

  it('T-I7: getCachedSettleResponse swallows .get throw and returns null', async () => {
    const { getCachedSettleResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const getSpy = (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy;
    getSpy.mockRejectedValueOnce(new Error('boom'));
    initRedis(makeEnv(), makeFakeLogger());
    await expect(getCachedSettleResponse('settle:idempotency:x')).resolves.toBeNull();
  });

  it('T-I8: setCachedSettleResponse swallows .set throw (CD-4)', async () => {
    const { setCachedSettleResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const setSpy = (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy;
    setSpy.mockRejectedValueOnce(new Error('boom'));
    initRedis(makeEnv(), makeFakeLogger());
    const payload = {
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH', message: 'n/a', http: 400 },
    };
    await expect(setCachedSettleResponse('settle:idempotency:x', payload)).resolves.toBeUndefined();
  });

  it('T-I9: setCachedSettleResponse uses EX TTL === SETTLE_IDEMPOTENCY_TTL_SEC', async () => {
    const { setCachedSettleResponse, SETTLE_IDEMPOTENCY_TTL_SEC } =
      await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const setSpy = (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy;
    initRedis(makeEnv(), makeFakeLogger());

    const payload = {
      ok: false as const,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    };
    await setCachedSettleResponse('settle:idempotency:k2', payload);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const args = setSpy.mock.calls[0];
    expect(args?.[2]).toBe('EX');
    expect(args?.[3]).toBe(SETTLE_IDEMPOTENCY_TTL_SEC);
  });

  it('T-I10: setCachedSettleResponse no-op when client null', async () => {
    const { setCachedSettleResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const setSpy = (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy;
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());

    const payload = {
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH', message: 'n/a', http: 400 },
    };
    await expect(setCachedSettleResponse('settle:idempotency:x', payload)).resolves.toBeUndefined();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('T-I15: round-trip set → get via RedisMock preserves payload', async () => {
    const { setCachedSettleResponse, getCachedSettleResponse } =
      await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    initRedis(makeEnv(), makeFakeLogger());

    const payload = {
      ok: true as const,
      response: {
        settled: true as const,
        transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
        blockNumber: 12345,
        amount: '1000000',
        from: `0x${'33'.repeat(20)}` as `0x${string}`,
        to: `0x${'22'.repeat(20)}` as `0x${string}`,
        asset: `0x${'11'.repeat(20)}` as `0x${string}`,
      },
    };
    await setCachedSettleResponse('settle:idempotency:k1', payload);
    await expect(getCachedSettleResponse('settle:idempotency:k1')).resolves.toEqual(payload);
  });
});

// ─── T-I11 .. T-I14: toCacheableSettle (CD-12) ────────────────────────────

describe('toCacheableSettle (CD-12)', () => {
  it('T-I11: http === 500 returns null (CD-12)', async () => {
    const { toCacheableSettle } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'TRANSACTION_FAILED', message: 'rpc', http: 500 },
    };
    expect(toCacheableSettle(result)).toBeNull();
  });

  it('T-I12: http === 502 returns null (CD-12)', async () => {
    const { toCacheableSettle } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'SIMULATION_FAILED', message: 'bad gateway', http: 502 },
    };
    expect(toCacheableSettle(result)).toBeNull();
  });

  it('T-I13: http === 401 returns cached payload verbatim', async () => {
    const { toCacheableSettle } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    };
    expect(toCacheableSettle(result)).toEqual({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    });
  });

  it('T-I14: ok=true preserves exactly the 7 spec-literal fields (CD-11 nuevo)', async () => {
    const { toCacheableSettle } = await import('../../core/idempotency.js');
    const success = {
      ok: true as const,
      settled: true as const,
      transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
      blockNumber: 12345,
      amount: '1000000',
      from: `0x${'33'.repeat(20)}` as `0x${string}`,
      to: `0x${'22'.repeat(20)}` as `0x${string}`,
      asset: `0x${'11'.repeat(20)}` as `0x${string}`,
    };
    const cacheable = toCacheableSettle(success);
    expect(cacheable).not.toBeNull();
    expect(cacheable).toEqual({
      ok: true,
      response: {
        settled: true,
        transactionHash: success.transactionHash,
        blockNumber: 12345,
        amount: '1000000',
        from: success.from,
        to: success.to,
        asset: success.asset,
      },
    });
    // Ensure no extra keys leak beyond the 7 authorized fields.
    const nonNull = cacheable as { ok: true; response: Record<string, unknown> };
    expect(Object.keys(nonNull.response).sort()).toEqual([
      'amount',
      'asset',
      'blockNumber',
      'from',
      'settled',
      'to',
      'transactionHash',
    ]);
  });
});
