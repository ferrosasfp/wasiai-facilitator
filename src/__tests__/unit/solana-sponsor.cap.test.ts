/**
 * WKH-217 / HU-SOL-14 — anti-abuse caps (T15-T16), fail-CLOSED (AC-6, CD-6).
 *
 * Redis INCR/INCRBY mocked via `vi.mock('../../infra/redis.js')` (same pattern
 * as core.settle-cap.test.ts). The critical assertion vs the EVM settle-cap:
 * a null client OR a Redis error → REJECT (fail-closed), never fail-open.
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
  checkAndIncrSponsorRate,
  checkAndIncrSponsorDailyLamports,
  releaseSponsorDailyLamports,
} from '../../core/solana-sponsor-cap.js';

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

describe('checkAndIncrSponsorRate (T15 — rate-limit fail-closed)', () => {
  it('T15a: under the max → ok', async () => {
    mockClient.incr.mockResolvedValue(1);
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incr).toHaveBeenCalledTimes(1);
  });

  it('T15b: exceeding the max → rate_exceeded reject', async () => {
    mockClient.incr.mockResolvedValue(21);
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_exceeded');
  });

  it('★ T15c: Redis throws → FAIL-CLOSED (reject, not fail-open)', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('★ T15d: no Redis client (null) → FAIL-CLOSED (reject)', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('sets TTL only on the first increment (count === 1)', async () => {
    mockClient.incr.mockResolvedValue(1);
    await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(mockClient.expire).toHaveBeenCalledTimes(1);
  });
});

describe('checkAndIncrSponsorDailyLamports (T16 — daily lamports fail-closed)', () => {
  it('T16a: accumulated <= cap → ok', async () => {
    mockClient.incrby.mockResolvedValue(30_000);
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incrby).toHaveBeenCalledWith(expect.any(String), '5000');
  });

  it('★ T16b: accumulated > cap → daily_exceeded reject', async () => {
    mockClient.incrby.mockResolvedValue(500_000_001);
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('★ T16c: Redis throws → FAIL-CLOSED (reject)', async () => {
    mockClient.incrby.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('★ T16d: no Redis client (null) → FAIL-CLOSED (reject)', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('cap <= 0 disables the ceiling (ok without touching Redis)', async () => {
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 0n, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incrby).not.toHaveBeenCalled();
  });

  it('BigInt comparison is precise for large accumulations (WKH-196 lesson)', async () => {
    // 500000000 exactly equals cap → allowed (not > cap).
    mockClient.incrby.mockResolvedValue(500_000_000);
    const r = await checkAndIncrSponsorDailyLamports(1_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(true);
  });
});

describe('releaseSponsorDailyLamports (AR-MNR-1 — compensating decrement)', () => {
  it('decrements the same daily counter by the reserved fee', async () => {
    mockClient.decrby.mockResolvedValue(0);
    await releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(mockClient.decrby).toHaveBeenCalledWith(expect.stringContaining('caller1'), '5000');
  });

  it('cap <= 0 (ceiling disabled) → no-op, never touches Redis', async () => {
    await releaseSponsorDailyLamports(5_000n, 0n, logger, 'caller1');
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });

  it('non-positive fee → no-op', async () => {
    await releaseSponsorDailyLamports(0n, 500_000_000n, logger, 'caller1');
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });

  it('best-effort: Redis error is swallowed (does not throw)', async () => {
    mockClient.decrby.mockRejectedValue(new Error('redis down'));
    await expect(
      releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1'),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('best-effort: null client → no-op (does not throw)', async () => {
    h.clientOrNull.current = null;
    await expect(
      releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1'),
    ).resolves.toBeUndefined();
  });
});
