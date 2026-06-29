/**
 * Suite 2 (part A) — Failure-injection on the settle daily-cap check.
 *
 * This is the EXACT code path of the 2026-06-29 production incident:
 * `incrementAndCheckDailyCap` runs a Redis INCR on every /settle. When Redis
 * is down the INCR throws. The failure mode is governed by
 * `SETTLE_CAP_FAIL_MODE`:
 *   - 'open'   (DEFAULT) → Redis throw → settle PROCEEDS (fail-open).
 *   - 'closed'           → Redis throw → { ok:false, redis_error_failclosed }
 *                          → route surfaces HTTP 503.
 *
 * INCIDENT: a deploy flipped the live default toward fail-closed. Redis blipped
 * and EVERY settlement on EVERY chain was rejected (settlement outage). These
 * tests pin the money-safe contract at the unit level so the regression can
 * never silently recur. All Redis interaction is mocked — no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mockable Redis client: `incr` is reconfigured per test to throw or count.
const mockClient = {
  incr: vi.fn(),
  expire: vi.fn(async () => 1),
};

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => mockClient,
}));

import { incrementAndCheckDailyCap } from '../../core/settle-cap.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

describe('Suite 2A — daily-cap failure injection (2026-06-29 incident class)', () => {
  beforeEach(() => {
    mockClient.incr.mockReset();
    mockClient.expire.mockReset();
    mockClient.expire.mockImplementation(async () => 1);
    logger.warn.mockReset();
    logger.debug.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── The pinned regression: DEFAULT ('open') must NOT reject on Redis error ──
  describe('REGRESSION PIN: fail-open default never rejects settlement on Redis error', () => {
    it('failMode="open" + Redis INCR throws → { ok: true } (settle proceeds)', async () => {
      mockClient.incr.mockRejectedValue(new Error('READONLY redis cluster down'));
      const r = await incrementAndCheckDailyCap(1000, 'open', logger);
      // THE pin: an infra error MUST NOT block a settlement when failMode=open.
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.count).toBe(0);
        expect(r.cap).toBe(1000);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 1000 }),
        expect.stringContaining('fail-open'),
      );
    });

    it('failMode="open" survives MANY distinct Redis failures (deterministic sweep)', async () => {
      const failures = [
        new Error('ECONNREFUSED'),
        new Error('connection timeout'),
        new Error('READONLY You cannot write against a read only replica'),
        new Error('MISCONF Redis is configured to save RDB snapshots'),
        new Error('max number of clients reached'),
        Object.assign(new Error('LOADING Redis is loading the dataset in memory'), {
          name: 'ReplyError',
        }),
      ];
      for (const err of failures) {
        mockClient.incr.mockReset();
        mockClient.incr.mockRejectedValue(err);
        const r = await incrementAndCheckDailyCap(500, 'open', logger);
        expect(r.ok).toBe(true);
      }
    });

    it('failMode="open" is the behavior even at cap=1 (smallest enabled cap)', async () => {
      mockClient.incr.mockRejectedValue(new Error('redis down'));
      const r = await incrementAndCheckDailyCap(1, 'open', logger);
      expect(r.ok).toBe(true);
    });
  });

  // ── The opt-in fail-closed path (only safe with HA Redis) ──────────────────
  describe('opt-in failMode="closed" rejects on Redis error (503 surface)', () => {
    it('failMode="closed" + Redis throws → { ok:false, redis_error_failclosed }', async () => {
      mockClient.incr.mockRejectedValue(new Error('redis down'));
      const r = await incrementAndCheckDailyCap(1000, 'closed', logger);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('redis_error_failclosed');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 1000 }),
        expect.stringContaining('fail-closed'),
      );
    });

    it('failMode="closed" with HEALTHY Redis under cap → still proceeds (no spurious 503)', async () => {
      mockClient.incr.mockResolvedValue(1);
      const r = await incrementAndCheckDailyCap(1000, 'closed', logger);
      expect(r.ok).toBe(true);
    });
  });

  // ── Disabled cap (cap<=0) never touches Redis — no incident surface at all ──
  describe('cap disabled (cap<=0) short-circuits before Redis', () => {
    it('cap=0 → ok, INCR never called (even if Redis would throw)', async () => {
      mockClient.incr.mockRejectedValue(new Error('redis down'));
      const r = await incrementAndCheckDailyCap(0, 'closed', logger);
      expect(r.ok).toBe(true);
      expect(mockClient.incr).not.toHaveBeenCalled();
    });
  });

  // ── Cap-exceeded path is a BUSINESS rejection, distinct from infra failure ──
  describe('cap exceeded is a business 429 — NOT confused with infra failure', () => {
    it('count > cap → cap_exceeded with retryAfterSeconds, never redis_error_failclosed', async () => {
      mockClient.incr.mockResolvedValue(1001);
      const r = await incrementAndCheckDailyCap(1000, 'open', logger);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('cap_exceeded');
        if (r.reason === 'cap_exceeded') {
          expect(r.retryAfterSeconds).toBeGreaterThan(0);
          expect(r.retryAfterSeconds).toBeLessThanOrEqual(86400);
        }
      }
    });

    it('count === cap (boundary) → still ok (strict greater-than)', async () => {
      mockClient.incr.mockResolvedValue(1000);
      const r = await incrementAndCheckDailyCap(1000, 'open', logger);
      expect(r.ok).toBe(true);
    });
  });
});
