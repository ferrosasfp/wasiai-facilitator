/**
 * Unit tests for src/core/idempotency.ts (WFAC-20 W4).
 *
 * Pattern inherited from src/__tests__/unit/redis.test.ts (E12):
 *   - vi.mock('ioredis') with a minimal Redis class that backs get/set
 *     with a Map + per-test error overrides.
 *   - resetRedisClientForTests() in afterEach to guarantee isolation.
 *
 * Coverage map:
 *   - T-I1  : VERIFY_IDEMPOTENCY_TTL_SEC === 120 (CD-7).
 *   - T-I2  : canonicalStringify sorts keys recursively (CD-11).
 *   - T-I3  : canonicalStringify preserves array order (CD-11).
 *   - T-I4  : buildIdempotencyKey stable across key-order permutations
 *             (CD-11 / AC-9 prerequisite).
 *   - T-I5  : buildIdempotencyKey differs for distinct payloads.
 *   - T-I6  : buildIdempotencyKey prefix + hex suffix.
 *   - T-I7  : isRedisAvailable false when client null.
 *   - T-I8  : getCachedVerifyResponse null when client null.
 *   - T-I9  : getCachedVerifyResponse swallows redis.get throw (AC-10).
 *   - T-I10 : setCachedVerifyResponse swallows redis.set throw.
 *   - T-I11 : toCacheable returns null for http >= 500 (CD-12).
 *   - T-I12 : toCacheable preserves success 7-field shape.
 *   - T-I13 : getCachedVerifyResponse returns parsed hit when present.
 *   - T-I14 : setCachedVerifyResponse calls .set with EX TTL.
 *   - T-I15 : canonicalStringify drops undefined values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '../../infra/env.js';

// ─── ioredis mock ──────────────────────────────────────────────────────────
// Hoisted by Vitest. Mirrors the pattern from redis.test.ts (E12) but
// extends RedisMock with get/set backed by a Map.
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));
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

function makeFakeLogger(): {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
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
  };
}

// Valid VerifyRequest fixture (mirrors §4.4 of the Story File).
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

describe('VERIFY_IDEMPOTENCY_TTL_SEC', () => {
  it('T-I1: exports exactly 120 (CD-7)', async () => {
    const { VERIFY_IDEMPOTENCY_TTL_SEC } = await import('../../core/idempotency.js');
    expect(VERIFY_IDEMPOTENCY_TTL_SEC).toBe(120);
  });
});

describe('canonicalStringify', () => {
  it('T-I2: sorts object keys recursively (CD-11)', async () => {
    const { canonicalStringify } = await import('../../core/idempotency.js');
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('T-I3: preserves array order (CD-11)', async () => {
    const { canonicalStringify } = await import('../../core/idempotency.js');
    expect(canonicalStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('T-I15: drops undefined values (mirrors JSON.stringify)', async () => {
    const { canonicalStringify } = await import('../../core/idempotency.js');
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('serializes nulls and primitives as JSON.stringify would', async () => {
    const { canonicalStringify } = await import('../../core/idempotency.js');
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify('hi')).toBe('"hi"');
    expect(canonicalStringify(true)).toBe('true');
  });
});

describe('buildIdempotencyKey', () => {
  it('T-I4: stable across top-level key permutations (CD-11)', async () => {
    const { buildIdempotencyKey } = await import('../../core/idempotency.js');
    const a = VALID_PARSED;
    // Reorder top-level properties.
    const b = {
      payload: a.payload,
      accepted: a.accepted,
      resource: a.resource,
      x402Version: a.x402Version,
    } as typeof VALID_PARSED;
    expect(buildIdempotencyKey(a)).toBe(buildIdempotencyKey(b));
  });

  it('T-I4b: stable across nested key permutations', async () => {
    const { buildIdempotencyKey } = await import('../../core/idempotency.js');
    const a = VALID_PARSED;
    const b: typeof VALID_PARSED = {
      ...a,
      accepted: {
        ...a.accepted,
        // Same values, different property ordering in extra.
        extra: {
          version: a.accepted.extra.version,
          name: a.accepted.extra.name,
          assetTransferMethod: a.accepted.extra.assetTransferMethod,
        },
      },
    };
    expect(buildIdempotencyKey(a)).toBe(buildIdempotencyKey(b));
  });

  it('T-I5: differs for distinct payloads (accepted.amount changed)', async () => {
    const { buildIdempotencyKey } = await import('../../core/idempotency.js');
    const a = VALID_PARSED;
    const b = { ...a, accepted: { ...a.accepted, amount: '2000000' } };
    expect(buildIdempotencyKey(a)).not.toBe(buildIdempotencyKey(b));
  });

  it('T-I6: starts with prefix + 64-char hex suffix', async () => {
    const { buildIdempotencyKey, VERIFY_IDEMPOTENCY_KEY_PREFIX } =
      await import('../../core/idempotency.js');
    const key = buildIdempotencyKey(VALID_PARSED);
    expect(key.startsWith(VERIFY_IDEMPOTENCY_KEY_PREFIX)).toBe(true);
    const suffix = key.slice(VERIFY_IDEMPOTENCY_KEY_PREFIX.length);
    expect(suffix).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isRedisAvailable / getCachedVerifyResponse / setCachedVerifyResponse', () => {
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

  it('T-I7: isRedisAvailable returns false when no REDIS_URL in test env', async () => {
    const { isRedisAvailable } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());
    expect(isRedisAvailable()).toBe(false);
  });

  it('T-I8: getCachedVerifyResponse returns null when client null', async () => {
    const { getCachedVerifyResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());
    await expect(getCachedVerifyResponse('verify:idempotency:x')).resolves.toBeNull();
  });

  it('T-I9: getCachedVerifyResponse swallows redis.get throw and returns null (AC-10)', async () => {
    const { getCachedVerifyResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const getSpy = (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy;
    getSpy.mockRejectedValueOnce(new Error('boom'));
    initRedis(makeEnv(), makeFakeLogger());
    await expect(getCachedVerifyResponse('verify:idempotency:x')).resolves.toBeNull();
  });

  it('T-I10: setCachedVerifyResponse swallows redis.set throw', async () => {
    const { setCachedVerifyResponse } = await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const setSpy = (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy;
    setSpy.mockRejectedValueOnce(new Error('boom'));
    initRedis(makeEnv(), makeFakeLogger());
    const payload = {
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH', message: 'n/a', http: 400 },
    };
    await expect(setCachedVerifyResponse('verify:idempotency:x', payload)).resolves.toBeUndefined();
  });

  it('T-I13: getCachedVerifyResponse returns parsed hit when redis has the key', async () => {
    const { setCachedVerifyResponse, getCachedVerifyResponse } =
      await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    initRedis(makeEnv(), makeFakeLogger());

    const payload = {
      ok: true as const,
      response: {
        verified: true as const,
        client: `0x${'33'.repeat(20)}` as `0x${string}`,
        amount: '1000000',
        asset: `0x${'11'.repeat(20)}` as `0x${string}`,
        network: 'eip155:2368',
        payTo: `0x${'22'.repeat(20)}` as `0x${string}`,
        expiresAt: 99999999999,
      },
    };
    await setCachedVerifyResponse('verify:idempotency:k1', payload);
    await expect(getCachedVerifyResponse('verify:idempotency:k1')).resolves.toEqual(payload);
  });

  it('T-I14: setCachedVerifyResponse calls Redis SET with EX TTL === VERIFY_IDEMPOTENCY_TTL_SEC', async () => {
    const { setCachedVerifyResponse, VERIFY_IDEMPOTENCY_TTL_SEC } =
      await import('../../core/idempotency.js');
    const { initRedis } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const setSpy = (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy;
    initRedis(makeEnv(), makeFakeLogger());

    const payload = {
      ok: false as const,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    };
    await setCachedVerifyResponse('verify:idempotency:k2', payload);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const args = setSpy.mock.calls[0];
    expect(args?.[2]).toBe('EX');
    expect(args?.[3]).toBe(VERIFY_IDEMPOTENCY_TTL_SEC);
  });
});

describe('toCacheable (CD-12)', () => {
  it('T-I11: returns null for http >= 500 (CD-12)', async () => {
    const { toCacheable } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'TRANSACTION_FAILED', message: 'boom', http: 500 },
    };
    expect(toCacheable(result)).toBeNull();
  });

  it('T-I11b: returns null for http 503', async () => {
    const { toCacheable } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'SIMULATION_FAILED', message: 'rpc', http: 503 },
    };
    expect(toCacheable(result)).toBeNull();
  });

  it('T-I12: preserves success 7-field shape', async () => {
    const { toCacheable } = await import('../../core/idempotency.js');
    const success = {
      ok: true as const,
      verified: true as const,
      client: `0x${'33'.repeat(20)}` as `0x${string}`,
      amount: '1000000',
      asset: `0x${'11'.repeat(20)}` as `0x${string}`,
      network: 'eip155:2368',
      payTo: `0x${'22'.repeat(20)}` as `0x${string}`,
      expiresAt: 99999999999,
    };
    const cacheable = toCacheable(success);
    expect(cacheable).toEqual({
      ok: true,
      response: {
        verified: true,
        client: success.client,
        amount: '1000000',
        asset: success.asset,
        network: 'eip155:2368',
        payTo: success.payTo,
        expiresAt: 99999999999,
      },
    });
  });

  it('preserves non-5xx error verbatim', async () => {
    const { toCacheable } = await import('../../core/idempotency.js');
    const result = {
      ok: false as const,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    };
    expect(toCacheable(result)).toEqual({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    });
  });
});
