/**
 * Tests for src/core/settle-cap.ts — anti-abuse caps.
 *
 * checkSettleAmountCap: synchronous BigInt comparison — pure, no mocks.
 * incrementAndCheckDailyCap: Redis INCR via `vi.mock('../../infra/redis.js')`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  incr: vi.fn(),
  expire: vi.fn(async () => 1),
};

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => mockClient,
}));

import { checkSettleAmountCap, incrementAndCheckDailyCap } from '../../core/settle-cap.js';

const nullLogger = { warn: vi.fn(), debug: vi.fn() };

describe('checkSettleAmountCap (synchronous BigInt comparison)', () => {
  it('returns ok=true when amount <= cap', () => {
    expect(checkSettleAmountCap('1000', '10000')).toEqual({ ok: true });
  });

  it('returns ok=true when amount === cap (edge)', () => {
    expect(checkSettleAmountCap('10000', '10000')).toEqual({ ok: true });
  });

  it('returns ok=false with limit when amount > cap', () => {
    const result = checkSettleAmountCap('10001', '10000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe(10000n);
  });

  it('handles uint256 max correctly (BigInt)', () => {
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(checkSettleAmountCap(big, big)).toEqual({ ok: true });
    expect(checkSettleAmountCap(big, '0')).toEqual({ ok: false, limit: 0n });
  });

  it('fail-opens when BigInt() throws (invalid decimal — defense-in-depth)', () => {
    expect(checkSettleAmountCap('not-a-number', '10000')).toEqual({ ok: true });
  });
});

describe('incrementAndCheckDailyCap (Redis INCR)', () => {
  beforeEach(() => {
    mockClient.incr.mockReset();
    mockClient.expire.mockReset();
    mockClient.expire.mockImplementation(async () => 1);
    nullLogger.warn.mockReset();
    nullLogger.debug.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok=true with count=0 when cap <= 0 (disabled)', async () => {
    const r = await incrementAndCheckDailyCap(0, nullLogger);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(0);
    expect(mockClient.incr).not.toHaveBeenCalled();
  });

  it('passes until count > cap, then rejects', async () => {
    const cap = 3;
    const counts = [1, 2, 3, 4];
    let i = 0;
    mockClient.incr.mockImplementation(async () => counts[i++] ?? 0);

    const r1 = await incrementAndCheckDailyCap(cap, nullLogger);
    expect(r1.ok).toBe(true);
    const r2 = await incrementAndCheckDailyCap(cap, nullLogger);
    expect(r2.ok).toBe(true);
    const r3 = await incrementAndCheckDailyCap(cap, nullLogger);
    expect(r3.ok).toBe(true);

    const overflow = await incrementAndCheckDailyCap(cap, nullLogger);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.count).toBe(cap + 1);
      expect(overflow.cap).toBe(cap);
      expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
      expect(overflow.retryAfterSeconds).toBeLessThanOrEqual(86400);
    }
  });

  it('sets 48h TTL only on first increment (count === 1)', async () => {
    let call = 0;
    mockClient.incr.mockImplementation(async () => ++call);
    await incrementAndCheckDailyCap(1000, nullLogger);
    expect(mockClient.expire).toHaveBeenCalledTimes(1);
    expect(mockClient.expire).toHaveBeenCalledWith(expect.any(String), 48 * 3600);
    await incrementAndCheckDailyCap(1000, nullLogger);
    expect(mockClient.expire).toHaveBeenCalledTimes(1); // still 1 — not called again
  });

  it('fail-opens on Redis throw (never blocks)', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await incrementAndCheckDailyCap(10, nullLogger);
    expect(r.ok).toBe(true);
    expect(nullLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 10 }),
      expect.stringContaining('fail-open'),
    );
  });
});
