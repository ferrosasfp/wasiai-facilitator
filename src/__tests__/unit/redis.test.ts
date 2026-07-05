/**
 * Unit tests for src/infra/redis.ts (WFAC-5).
 *
 * Strategy: mock `ioredis` with a minimal class that records constructor args,
 * registers event handlers, and exposes an __emit helper to simulate events.
 * No live Redis is required (CD-9).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '../../infra/env.js';

// ─── ioredis mock ──────────────────────────────────────────────────────────
// Hoisted by Vitest. Do NOT close over external state beyond exported helpers.
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));

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

    // Test-only helper to fire a registered handler.
    __emit(event: string, ...args: unknown[]): void {
      (this.listeners.get(event) ?? []).forEach((h) => h(...args));
    }
  }

  return {
    default: RedisMock,
    Redis: RedisMock,
    __constructorSpy: constructorSpy,
    __quitSpy: quitSpy,
  };
});

// Fake logger — plain vi.fn() so we can assert calls + arguments.
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

describe('redactRedisUrl', () => {
  it('masks the password component', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    const out = redactRedisUrl('redis://user:secret123@host.example:6379/2');
    expect(out).not.toContain('secret123');
    expect(out).toContain('host.example');
    expect(out).toContain(':6379');
  });

  it('masks both username and password', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    const out = redactRedisUrl('redis://user:pass@host:6379');
    expect(out).not.toContain('user');
    expect(out).not.toContain('pass');
  });

  it('returns safe fallback for malformed URLs', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    expect(redactRedisUrl('not a url')).toBe('redis://***');
  });
});

describe('redisRetryStrategy', () => {
  it('returns exponential backoff values', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(0)).toBe(100);
    expect(redisRetryStrategy(1)).toBe(200);
    expect(redisRetryStrategy(2)).toBe(400);
    expect(redisRetryStrategy(3)).toBe(800);
    expect(redisRetryStrategy(4)).toBe(1600);
  });

  it('caps at 3000ms', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(5)).toBe(3000);
    expect(redisRetryStrategy(10)).toBe(3000);
  });

  it('never gives up — keeps the capped 3000ms backoff forever (WKH-131 self-heal)', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(11)).toBe(3000);
    expect(redisRetryStrategy(100)).toBe(3000);
    expect(redisRetryStrategy(10_000)).toBe(3000);
  });
});

describe('getRedisClient', () => {
  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy.mockClear();
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when initRedis was never called', async () => {
    const { getRedisClient } = await import('../../infra/redis.js');
    expect(getRedisClient()).toBeNull();
  });

  it('returns null in test env when REDIS_URL is undefined (AC-6)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());
    expect(getRedisClient()).toBeNull();
  });

  it('returns the same instance on repeated calls (AC-4, singleton)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> })
      .__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    const a = getRedisClient();
    const b = getRedisClient();

    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('constructs Redis with lazyConnect, maxRetriesPerRequest, enableReadyCheck (AC-4)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> })
      .__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('redis://localhost:6379/0');
    expect(opts.lazyConnect).toBe(true);
    expect(opts.maxRetriesPerRequest).toBe(3);
    expect(opts.enableReadyCheck).toBe(false);
    expect(typeof opts.retryStrategy).toBe('function');
    expect(opts.db).toBe(0);
    // family:0 = dual-stack DNS lookup, required for Railway IPv6-only
    // `*.railway.internal` hosts (default ioredis family:4 fails to resolve).
    expect(opts.family).toBe(0);
  });

  it('logs redacted URL at info level on first creation (AC-5)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(makeEnv({ REDIS_URL: 'redis://user:supersecret@host:6379/0' }), logger);
    getRedisClient();

    expect(logger.info).toHaveBeenCalled();
    const allCalls = logger.info.mock.calls;
    // Find the "Redis client instantiated" log.
    const creationCall = allCalls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Redis client instantiated'),
    );
    expect(creationCall).toBeDefined();
    const payload = creationCall?.[0] as { url: string };
    expect(payload.url).not.toContain('supersecret');
    expect(payload.url).toContain('host:6379');
  });

  it('emits "Redis connected" log on connect event (AC-7)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(makeEnv({ REDIS_URL: 'redis://host.example:6380/0' }), logger);
    const client = getRedisClient();
    expect(client).not.toBeNull();

    // Trigger the registered 'connect' handler.
    (client as unknown as { __emit: (event: string) => void }).__emit('connect');

    const connectCall = logger.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'Redis connected',
    );
    expect(connectCall).toBeDefined();
    const payload = connectCall?.[0] as { host: string; port: number };
    expect(payload.host).toBe('host.example');
    expect(payload.port).toBe(6380);
  });

  it('logs error at error level on error event without throwing (AC-8)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(makeEnv(), logger);
    const client = getRedisClient();
    expect(client).not.toBeNull();

    const fakeErr = new Error('ECONNREFUSED');
    expect(() => {
      (client as unknown as { __emit: (event: string, err: Error) => void }).__emit(
        'error',
        fakeErr,
      );
    }).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith({ err: fakeErr }, 'Redis error');
  });

  it('initRedis is idempotent across repeated calls', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> })
      .__constructorSpy;

    const env = makeEnv();
    const logger = makeFakeLogger();
    initRedis(env, logger);
    initRedis(env, logger); // second call with same refs → no-op
    getRedisClient();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resetRedisClientForTests clears state', async () => {
    const { initRedis, getRedisClient, resetRedisClientForTests } =
      await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> })
      .__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();
    expect(spy).toHaveBeenCalledTimes(1);

    resetRedisClientForTests();
    expect(getRedisClient()).toBeNull(); // not initialized anymore

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('buildApp onClose integration (AC-10, AC-11)', () => {
  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy.mockClear();
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  it('calls redis.quit() during app.close() when client exists (AC-10)', async () => {
    const { buildApp } = await import('../../app.js');
    const { getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;

    const app = await buildApp({
      env: makeEnv({ REDIS_URL: 'redis://host:6379/0' }),
      skipDomainCheck: true, // WFAC-53 CD-16
    });
    // Force client creation.
    getRedisClient();

    await app.close();
    expect(quitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw and logs error when quit() rejects (AC-11)', async () => {
    const { buildApp } = await import('../../app.js');
    const { getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;
    quitSpy.mockRejectedValueOnce(new Error('quit boom'));

    const app = await buildApp({
      env: makeEnv({ REDIS_URL: 'redis://host:6379/0' }),
      skipDomainCheck: true, // WFAC-53 CD-16
    });
    getRedisClient();

    await expect(app.close()).resolves.not.toThrow();
  });

  it('skips quit when client is null (test env path)', async () => {
    const { buildApp } = await import('../../app.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;

    const app = await buildApp({
      env: makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }),
      skipDomainCheck: true, // WFAC-53 CD-16
    });
    // No getRedisClient() call → singleton stays null.

    await app.close();
    expect(quitSpy).not.toHaveBeenCalled();
  });
});
