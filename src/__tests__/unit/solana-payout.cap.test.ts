/**
 * WKH-302 — payout anti-abuse caps, fail-CLOSED (unit level).
 *
 * Redis is mocked at the infra wrapper (same pattern as solana-sponsor.cap.test.ts).
 * The assertion that matters: a null client OR a Redis error must REJECT — the
 * opposite of the EVM `settle-cap.ts`, which is fail-open on purpose. Fail-open on a
 * treasury route means paying while unable to count.
 *
 * The route-level `T-CAP-1`/`T-CAP-2`/`T-CAP-3` (money book unchanged) live in
 * `solana-payout.route.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  incr: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  expire: vi.fn(async () => 1),
};

const h = vi.hoisted(() => ({ clientOrNull: { current: null as unknown } }));

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => h.clientOrNull.current,
}));

import {
  checkAndIncrPayoutRate,
  checkAndIncrPayoutDailyAtomic,
  releasePayoutDailyAtomic,
} from '../../core/solana-payout-cap.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  mockClient.incr.mockReset();
  mockClient.incrby.mockReset();
  mockClient.decrby.mockReset();
  mockClient.expire.mockReset();
  mockClient.expire.mockImplementation(async () => 1);
  logger.warn.mockReset();
  logger.debug.mockReset();
  h.clientOrNull.current = mockClient;
});

afterEach(() => vi.clearAllMocks());

describe('checkAndIncrPayoutRate — per-caller rate limit (fail-CLOSED)', () => {
  it('under the max → ok', async () => {
    mockClient.incr.mockResolvedValue(1);
    expect(await checkAndIncrPayoutRate(20, 60, logger, 'caller1')).toEqual({ ok: true });
  });

  it('over the max → rate_exceeded', async () => {
    mockClient.incr.mockResolvedValue(21);
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_exceeded');
  });

  it('★ Redis throws → FAIL-CLOSED', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ null client → FAIL-CLOSED', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ uses its OWN Redis prefix — never the sponsor bucket', async () => {
    mockClient.incr.mockResolvedValue(1);
    await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    const key = String(mockClient.incr.mock.calls.at(0)?.at(0));
    expect(key).toContain('solana:payout:rate:');
    expect(key).not.toContain('solana:sponsor:');
  });
});

describe('checkAndIncrPayoutDailyAtomic — daily ceiling (fail-CLOSED)', () => {
  it('accumulated <= cap → ok, increment sent as a decimal STRING', async () => {
    mockClient.incrby.mockResolvedValue(3_000_000);
    expect(
      await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'caller1'),
    ).toEqual({ ok: true });
    expect(mockClient.incrby).toHaveBeenCalledWith(expect.any(String), '3000000');
  });

  it('★ accumulated > cap → daily_exceeded', async () => {
    mockClient.incrby.mockResolvedValue(1_000_000_001);
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('exactly at the cap is allowed (comparison is >, not >=)', async () => {
    mockClient.incrby.mockResolvedValue(1_000_000_000);
    expect(await checkAndIncrPayoutDailyAtomic(1_000n, 1_000_000_000n, logger, 'caller1')).toEqual({
      ok: true,
    });
  });

  it('★ Redis throws → FAIL-CLOSED', async () => {
    mockClient.incrby.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ null client → FAIL-CLOSED', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ precision above 2^53 is exact (BigInt, WKH-196 lesson)', async () => {
    // A total one unit over a cap beyond Number.MAX_SAFE_INTEGER must still reject.
    const cap = 9_007_199_254_740_992n; // 2^53
    mockClient.incrby.mockResolvedValue('9007199254740993'); // 2^53 + 1, as a string
    const r = await checkAndIncrPayoutDailyAtomic(1n, cap, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('cap <= 0 disables the ceiling without touching Redis', async () => {
    expect(await checkAndIncrPayoutDailyAtomic(3_000_000n, 0n, logger, 'c1')).toEqual({ ok: true });
    expect(mockClient.incrby).not.toHaveBeenCalled();
  });

  it('★ uses its OWN daily prefix — never the sponsor bucket', async () => {
    mockClient.incrby.mockResolvedValue(1);
    await checkAndIncrPayoutDailyAtomic(1n, 1_000_000_000n, logger, 'caller1');
    const key = String(mockClient.incrby.mock.calls.at(0)?.at(0));
    expect(key).toContain('solana:payout:daily:');
    expect(key).not.toContain('solana:sponsor:');
  });
});

describe('releasePayoutDailyAtomic — compensating decrement', () => {
  it('releases the same counter it reserved', async () => {
    mockClient.decrby.mockResolvedValue(0);
    await releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'caller1');
    expect(mockClient.decrby).toHaveBeenCalledWith(
      expect.stringContaining('solana:payout:daily:caller1'),
      '3000000',
    );
  });

  it('never throws on a Redis error (best-effort)', async () => {
    mockClient.decrby.mockRejectedValue(new Error('redis down'));
    await expect(
      releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1'),
    ).resolves.toBeUndefined();
  });

  it('never throws with a null client', async () => {
    h.clientOrNull.current = null;
    await expect(
      releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1'),
    ).resolves.toBeUndefined();
  });

  it('no-op when the ceiling is disabled or the amount is non-positive', async () => {
    await releasePayoutDailyAtomic(3_000_000n, 0n, logger, 'c1');
    await releasePayoutDailyAtomic(0n, 1_000_000_000n, logger, 'c1');
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });
});
