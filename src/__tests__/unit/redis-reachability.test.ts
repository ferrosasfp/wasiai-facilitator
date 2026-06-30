/**
 * P2 — OP-13: real PING-based Redis reachability.
 *
 * Before this fix `isRedisAvailable()` only checked `client !== null` — a
 * CONFIGURATION check, not a REACHABILITY check: a dead/unreachable Redis with
 * a constructed client still reported "available". `isRedisReachable()` issues
 * a real PING and returns false when the server is down (PING throws) or absent.
 *
 * We mock `getRedisClient` (the singleton accessor) so no live Redis is needed.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

let client: { ping: ReturnType<typeof vi.fn> } | null;

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => client,
}));

beforeEach(() => {
  client = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('P2 OP-13 — isRedisReachable (PING-based)', () => {
  it('RR-1: no client configured → isRedisReachable false, isRedisConfigured false', async () => {
    const { isRedisReachable, isRedisConfigured } = await import('../../core/idempotency.js');
    client = null;
    expect(await isRedisReachable()).toBe(false);
    expect(isRedisConfigured()).toBe(false);
  });

  it('RR-2: client present + PING returns PONG → reachable true', async () => {
    const { isRedisReachable, isRedisConfigured } = await import('../../core/idempotency.js');
    client = { ping: vi.fn(async () => 'PONG') };
    expect(isRedisConfigured()).toBe(true); // client constructed
    expect(await isRedisReachable()).toBe(true);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it('RR-3: client present but PING THROWS (server down) → reachable false (NOT just "client !== null")', async () => {
    const { isRedisReachable, isRedisConfigured } = await import('../../core/idempotency.js');
    client = {
      ping: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }),
    };
    // The OLD check would have said "available" because client !== null. The
    // PING-based check correctly reports the server as unreachable.
    expect(isRedisConfigured()).toBe(true);
    expect(await isRedisReachable()).toBe(false);
  });

  it('RR-4: PING returns a non-PONG reply → reachable false', async () => {
    const { isRedisReachable } = await import('../../core/idempotency.js');
    client = { ping: vi.fn(async () => 'WEIRD') };
    expect(await isRedisReachable()).toBe(false);
  });

  it('RR-5: never throws — a rejecting PING is swallowed into a boolean', async () => {
    const { isRedisReachable } = await import('../../core/idempotency.js');
    client = {
      ping: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    await expect(isRedisReachable()).resolves.toBe(false);
  });
});
