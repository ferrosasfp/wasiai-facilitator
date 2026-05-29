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

  // WFAC-AUDIT AC-6 — fail-CLOSED: an unparseable/non-positive amount or cap is a
  // misconfig; blocking is the safe default (was fail-open before this HU).
  it('T19: fail-closed on invalid amount decimal', () => {
    expect(checkSettleAmountCap('abc', '100')).toEqual({ ok: false, limit: 0n });
  });

  it('T20: fail-closed on invalid cap decimal', () => {
    expect(checkSettleAmountCap('100', 'abc')).toEqual({ ok: false, limit: 0n });
  });

  it('T21: fail-closed when amount <= 0 (zero)', () => {
    expect(checkSettleAmountCap('0', '100')).toEqual({ ok: false, limit: 0n });
  });

  it('T22: happy path — amount < cap → ok=true (regression)', () => {
    expect(checkSettleAmountCap('50', '100')).toEqual({ ok: true });
  });

  it('T19b: fail-closed on fractional amount', () => {
    expect(checkSettleAmountCap('1.5', '100')).toEqual({ ok: false, limit: 0n });
  });

  it('T19c: fail-closed on empty amount string', () => {
    expect(checkSettleAmountCap('', '100')).toEqual({ ok: false, limit: 0n });
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
    const r = await incrementAndCheckDailyCap(0, 'open', nullLogger);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(0);
    expect(mockClient.incr).not.toHaveBeenCalled();
  });

  it('passes until count > cap, then rejects with reason=cap_exceeded', async () => {
    const cap = 3;
    const counts = [1, 2, 3, 4];
    let i = 0;
    mockClient.incr.mockImplementation(async () => counts[i++] ?? 0);

    const r1 = await incrementAndCheckDailyCap(cap, 'open', nullLogger);
    expect(r1.ok).toBe(true);
    const r2 = await incrementAndCheckDailyCap(cap, 'open', nullLogger);
    expect(r2.ok).toBe(true);
    const r3 = await incrementAndCheckDailyCap(cap, 'open', nullLogger);
    expect(r3.ok).toBe(true);

    const overflow = await incrementAndCheckDailyCap(cap, 'open', nullLogger);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      // WFAC-53 FIX-6: rejection now carries a discriminator. The pre-existing
      // path is `reason: 'cap_exceeded'`; `redis_error_failclosed` is the new
      // path covered by T-CAP-CLOSED below.
      expect(overflow.reason).toBe('cap_exceeded');
      if (overflow.reason === 'cap_exceeded') {
        expect(overflow.count).toBe(cap + 1);
        expect(overflow.cap).toBe(cap);
        expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
        expect(overflow.retryAfterSeconds).toBeLessThanOrEqual(86400);
      }
    }
  });

  it('sets 48h TTL only on first increment (count === 1)', async () => {
    let call = 0;
    mockClient.incr.mockImplementation(async () => ++call);
    await incrementAndCheckDailyCap(1000, 'open', nullLogger);
    expect(mockClient.expire).toHaveBeenCalledTimes(1);
    expect(mockClient.expire).toHaveBeenCalledWith(expect.any(String), 48 * 3600);
    await incrementAndCheckDailyCap(1000, 'open', nullLogger);
    expect(mockClient.expire).toHaveBeenCalledTimes(1); // still 1 — not called again
  });

  it('fail-opens on Redis throw (never blocks)', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await incrementAndCheckDailyCap(10, 'open', nullLogger);
    expect(r.ok).toBe(true);
    expect(nullLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 10 }),
      expect.stringContaining('fail-open'),
    );
  });

  // ─── WFAC-53 FIX-6 — SETTLE_CAP_FAIL_MODE opt-in ────────────────────────

  it('T-CAP-CLOSED (AC-15, AC-17a): failMode="closed" + Redis throw → { ok: false, reason: "redis_error_failclosed" }', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await incrementAndCheckDailyCap(10, 'closed', nullLogger);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('redis_error_failclosed');
    }
    expect(nullLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 10 }),
      expect.stringContaining('fail-closed'),
    );
  });

  it('T-CAP-OPEN-EXPLICIT (AC-16, AC-17b, CD-8): failMode="open" + Redis throw → { ok: true } (preserve V1)', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await incrementAndCheckDailyCap(10, 'open', nullLogger);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(0);
      expect(r.cap).toBe(10);
    }
    expect(nullLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 10 }),
      expect.stringContaining('fail-open'),
    );
  });
});
