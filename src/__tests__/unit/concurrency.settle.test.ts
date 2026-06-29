/**
 * DEEP concurrency / idempotency suite for the /settle path.
 *
 * GOAL: prove that under arbitrary interleavings of concurrent identical
 * settle requests the facilitator broadcasts EXACTLY ONE on-chain
 * transaction, the daily cap is never exceeded by a race, and the circuit
 * breaker fast-fails the herd once it trips — i.e. a broken implementation
 * (non-atomic INCR, missing NX, no in-flight dedup) would FAIL these tests.
 *
 * Strategy:
 *   - We exercise the REAL implementations:
 *       · src/core/idempotency.ts  (in-flight lock SET NX, cache get/set)
 *       · src/core/settle-cap.ts   (daily cap atomic INCR)
 *       · src/chains/circuit-breaker.ts (cockatiel SamplingBreaker wrapper)
 *   - The only thing mocked is the Redis client (`getRedisClient`), but the
 *     mock MODELS the atomic/lock semantics of real Redis:
 *       · `incr`  → true atomic increment of a single in-memory counter.
 *       · `set ... NX` → returns 'OK' only for the first caller of a key,
 *         `null` thereafter (the SETNX contract the in-flight lock relies on).
 *       · An injectable async "gap" so two requests can be parked mid-flight
 *         BEFORE either writes its result — the idempotency-cache race.
 *   - The on-chain broadcast is modelled by a `writeContract` spy. Tests
 *     assert it is called exactly once across all concurrent requests.
 *
 * Determinism: no real timers for the racing logic. We use explicit
 * `Promise` barriers / `Promise.all` to force the dangerous interleavings.
 * Circuit-breaker tests use `vi.useFakeTimers()` for the reset window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Atomic Redis mock — single source of truth shared by the module mock.
//
// JS is single-threaded, so a synchronous Map mutation is already "atomic"
// w.r.t. other microtasks. The danger we model is the AWAIT BOUNDARY: a real
// request yields the event loop between "read cache" and "write cache". We
// expose `gate()` to PARK a call at a chosen await point so a second request
// can run to the same point — reproducing the check-then-act race. A correct
// implementation must rely on an ATOMIC primitive (INCR / SET NX) rather than
// read-modify-write, so it survives the parked interleaving.
// ─────────────────────────────────────────────────────────────────────────

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class AtomicRedisMock {
  private readonly kv = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  // Spies so tests can assert call counts / interleaving.
  readonly incrSpy = vi.fn();
  readonly setSpy = vi.fn();
  readonly getSpy = vi.fn();
  readonly expireSpy = vi.fn();
  readonly delSpy = vi.fn();

  // Optional async gates keyed by operation. When set, the op awaits the
  // gate's promise BEFORE applying its effect — letting a test park a call
  // mid-flight to force a specific interleaving.
  private getGate: Deferred | null = null;

  /** Park the NEXT `get` until `releaseGet()` is called. Returns a "arrived"
   * promise that resolves once the get handler has been entered. */
  installGetGate(): { arrived: Promise<void>; release: () => void } {
    const gate = deferred();
    const arrivedD = deferred();
    this.getGate = gate;
    this._onGetEntered = arrivedD.resolve;
    return { arrived: arrivedD.promise, release: gate.resolve };
  }

  private _onGetEntered: (() => void) | null = null;

  async get(key: string): Promise<string | null> {
    this.getSpy(key);
    if (this.getGate) {
      const gate = this.getGate;
      this.getGate = null; // one-shot
      this._onGetEntered?.();
      this._onGetEntered = null;
      await gate.promise;
    }
    return this.kv.get(key) ?? null;
  }

  // ioredis signature: set(key, value, 'EX', ttl) or set(key, value, 'EX', ttl, 'NX')
  async set(
    key: string,
    value: string,
    _mode?: string,
    _ttl?: number,
    nx?: string,
  ): Promise<'OK' | null> {
    this.setSpy(key, value, _mode, _ttl, nx);
    if (nx === 'NX') {
      if (this.kv.has(key)) return null; // SET NX contract: key exists → fail
      this.kv.set(key, value);
      return 'OK';
    }
    this.kv.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.incrSpy(key);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(key: string, _ttl: number): Promise<number> {
    this.expireSpy(key, _ttl);
    return 1;
  }

  async del(key: string): Promise<number> {
    this.delSpy(key);
    return this.kv.delete(key) ? 1 : 0;
  }

  // Test helpers
  rawGet(key: string): string | undefined {
    return this.kv.get(key);
  }
  counter(key: string): number {
    return this.counters.get(key) ?? 0;
  }
}

let redis: AtomicRedisMock;

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => redis,
}));

beforeEach(() => {
  redis = new AtomicRedisMock();
});

afterEach(() => {
  vi.clearAllMocks();
});

const IDEMPOTENCY_KEY = 'settle:idempotency:deadbeef';
const nullLogger = { warn: vi.fn(), debug: vi.fn() };

const SUCCESS_PAYLOAD = {
  ok: true as const,
  response: {
    settled: true as const,
    transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
    blockNumber: 100,
    amount: '1000000',
    from: `0x${'33'.repeat(20)}` as `0x${string}`,
    to: `0x${'22'.repeat(20)}` as `0x${string}`,
    asset: `0x${'11'.repeat(20)}` as `0x${string}`,
  },
};

// ════════════════════════════════════════════════════════════════════════
// 1. IN-FLIGHT LOCK — exactly one acquirer under concurrency (SET NX)
// ════════════════════════════════════════════════════════════════════════

describe('in-flight settle lock — concurrent acquire (SET NX semantics)', () => {
  it('CC-1: N concurrent setInflightSettleLock → exactly ONE "acquired", rest "held"', async () => {
    const { setInflightSettleLock } = await import('../../core/idempotency.js');

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => setInflightSettleLock(IDEMPOTENCY_KEY)),
    );

    const acquired = results.filter((r) => r === 'acquired');
    const held = results.filter((r) => r === 'held');
    expect(acquired).toHaveLength(1); // <-- only one broadcaster
    expect(held).toHaveLength(N - 1);
    // The lock key was written exactly once (NX rejected the rest).
    expect(redis.rawGet('settle:inflight:deadbeef')).toBe('1');
  });

  it('CC-2: a broken lock that ignores NX would let multiple acquire — guard catches it', async () => {
    // This test pins the SET NX contract our mock enforces, so that if the
    // production code ever drops the 'NX' arg, exactly-one breaks here.
    const { setInflightSettleLock } = await import('../../core/idempotency.js');

    const first = await setInflightSettleLock(IDEMPOTENCY_KEY);
    const second = await setInflightSettleLock(IDEMPOTENCY_KEY);
    expect(first).toBe('acquired');
    expect(second).toBe('held'); // second MUST be denied
    // Verify the production call actually passed NX to Redis.
    const nxArgs = redis.setSpy.mock.calls.find((c) => c[4] === 'NX');
    expect(nxArgs).toBeDefined();
  });

  it('CC-3: release lets a subsequent (sequential retry) re-acquire — no permanent block', async () => {
    const { setInflightSettleLock, releaseInflightSettleLock } =
      await import('../../core/idempotency.js');

    expect(await setInflightSettleLock(IDEMPOTENCY_KEY)).toBe('acquired');
    await releaseInflightSettleLock(IDEMPOTENCY_KEY);
    expect(redis.delSpy).toHaveBeenCalledTimes(1);
    // After release, a legit retry acquires again (not blocked for the TTL).
    expect(await setInflightSettleLock(IDEMPOTENCY_KEY)).toBe('acquired');
  });

  it('CC-4: fail-open when Redis throws on SET — returns "skipped" (chain nonce is the backstop)', async () => {
    const { setInflightSettleLock } = await import('../../core/idempotency.js');
    // Force the next SET to throw — the lock helper must fail-open ('skipped').
    vi.spyOn(redis, 'set').mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    const r = await setInflightSettleLock(IDEMPOTENCY_KEY);
    expect(r).toBe('skipped');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. IDEMPOTENCY CACHE RACE — two requests before the first writes its entry
// ════════════════════════════════════════════════════════════════════════
//
// Models the dangerous window: request A reads cache (miss), yields; request
// B reads cache (still miss) BEFORE A writes. The in-flight lock (NX) is what
// makes only ONE of them broadcast. We orchestrate the full settle pipeline
// (lookup → lock → broadcast → cache) and prove exactly one writeContract.

describe('idempotency cache race — two requests, one broadcast', () => {
  /**
   * Minimal faithful model of the route's settle pipeline ordering:
   *   1. getCachedSettleResponse(key) → hit ⇒ replay, no broadcast.
   *   2. setInflightSettleLock(key)   → held ⇒ 409, no broadcast.
   *   3. broadcast (writeContract).
   *   4. setCachedSettleResponse(key, result).
   *   5. releaseInflightSettleLock(key).
   * This exercises the REAL idempotency helpers; only the broadcast is a spy.
   */
  async function runSettlePipeline(
    key: string,
    broadcast: () => Promise<typeof SUCCESS_PAYLOAD>,
  ): Promise<{ outcome: 'broadcast' | 'cached' | 'conflict'; payload?: typeof SUCCESS_PAYLOAD }> {
    const idem = await import('../../core/idempotency.js');
    const cached = await idem.getCachedSettleResponse(key);
    if (cached) return { outcome: 'cached', payload: cached as typeof SUCCESS_PAYLOAD };

    const lock = await idem.setInflightSettleLock(key);
    if (lock === 'held') return { outcome: 'conflict' };
    try {
      const result = await broadcast();
      await idem.setCachedSettleResponse(key, result);
      return { outcome: 'broadcast', payload: result };
    } finally {
      if (lock === 'acquired') await idem.releaseInflightSettleLock(key);
    }
  }

  it('CC-5: two requests racing the cache miss → exactly ONE broadcast, other gets 409 (no double-spend)', async () => {
    const writeContract = vi.fn(async () => SUCCESS_PAYLOAD);

    // Park request A inside its cache GET so request B enters before A locks.
    const gate = redis.installGetGate();

    const aPromise = runSettlePipeline(IDEMPOTENCY_KEY, writeContract);
    // Wait until A is parked in the cache read.
    await gate.arrived;
    // B starts now — its cache read is a genuine miss (no gate on it).
    const bPromise = runSettlePipeline(IDEMPOTENCY_KEY, writeContract);
    // Release A so both proceed to the lock step concurrently.
    gate.release();

    const [a, b] = await Promise.all([aPromise, bPromise]);
    const outcomes = [a.outcome, b.outcome].sort();

    // THE invariant: exactly one on-chain broadcast regardless of interleaving.
    expect(writeContract).toHaveBeenCalledTimes(1);
    // Exactly one request broadcasts; the loser is deduped — either a 409
    // 'conflict' (it hit the held lock) or a 'cached' replay (it read the
    // entry the winner already wrote). Both are correct no-double-spend paths;
    // which one fires depends on the precise interleaving. What must NOT happen
    // is two 'broadcast' outcomes.
    expect(outcomes.filter((o) => o === 'broadcast')).toHaveLength(1);
    expect(outcomes).not.toEqual(['broadcast', 'broadcast']);
    expect(['conflict', 'cached']).toContain(outcomes.find((o) => o !== 'broadcast'));
  });

  it('CC-6: third request AFTER cache is written replays from cache (no broadcast)', async () => {
    const writeContract = vi.fn(async () => SUCCESS_PAYLOAD);

    const first = await runSettlePipeline(IDEMPOTENCY_KEY, writeContract);
    expect(first.outcome).toBe('broadcast');
    expect(writeContract).toHaveBeenCalledTimes(1);

    const second = await runSettlePipeline(IDEMPOTENCY_KEY, writeContract);
    expect(second.outcome).toBe('cached');
    expect(writeContract).toHaveBeenCalledTimes(1); // still ONE
    expect(second.payload).toEqual(SUCCESS_PAYLOAD);
  });

  it('CC-7: 10-way burst of identical settles → AT MOST one broadcast, all others dedup', async () => {
    const writeContract = vi.fn(async () => {
      // simulate a tiny async broadcast gap so dedup must hold across awaits
      await Promise.resolve();
      return SUCCESS_PAYLOAD;
    });

    const burst = await Promise.all(
      Array.from({ length: 10 }, () => runSettlePipeline(IDEMPOTENCY_KEY, writeContract)),
    );

    const broadcasts = burst.filter((r) => r.outcome === 'broadcast');
    const conflicts = burst.filter((r) => r.outcome === 'conflict');
    // Because all 10 race the same empty cache, the NX lock guarantees one
    // acquirer. The rest are either 'conflict' (lock held) — never a second
    // broadcast.
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
    expect(conflicts).toHaveLength(9); // the 9 losers all hit the held lock
    expect(broadcasts.length + conflicts.length).toBe(10);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. DAILY CAP UNDER CONCURRENCY — atomic INCR, never exceeded by races
// ════════════════════════════════════════════════════════════════════════

describe('daily settle cap — atomic INCR under concurrency', () => {
  it('CC-8: 100 concurrent settles with cap=10 → exactly 10 pass, 90 rejected, counter monotonic', async () => {
    const { incrementAndCheckDailyCap } = await import('../../core/settle-cap.js');
    const cap = 10;
    const N = 100;

    const results = await Promise.all(
      Array.from({ length: N }, () => incrementAndCheckDailyCap(cap, 'open', nullLogger)),
    );

    const passed = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);

    // The cap is a HARD ceiling: never more than `cap` allowed through.
    expect(passed).toHaveLength(cap);
    expect(rejected).toHaveLength(N - cap);
    // Every rejection is the cap_exceeded reason (not a redis error).
    for (const r of rejected) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('cap_exceeded');
    }
    // INCR was called once per request (no skipped accounting).
    expect(redis.incrSpy).toHaveBeenCalledTimes(N);
  });

  it('CC-9: counts are a contiguous 1..N permutation — no lost/duplicate increments', async () => {
    const { incrementAndCheckDailyCap } = await import('../../core/settle-cap.js');
    const N = 50;

    const results = await Promise.all(
      // cap huge so all pass and we can inspect the assigned counts
      Array.from({ length: N }, () => incrementAndCheckDailyCap(10_000, 'open', nullLogger)),
    );

    const counts = results.map((r) => (r.ok ? r.count : -1)).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // Atomic INCR ⇒ the final counter equals N, no double-count.
    const todayKey = `settle:daily:${new Date().toISOString().slice(0, 10)}`;
    expect(redis.counter(todayKey)).toBe(N);
  });

  it('CC-10: cap boundary — concurrent requests at the exact cap do not overshoot', async () => {
    const { incrementAndCheckDailyCap } = await import('../../core/settle-cap.js');
    const cap = 3;
    // Fire exactly cap+2 in parallel.
    const results = await Promise.all(
      Array.from({ length: cap + 2 }, () => incrementAndCheckDailyCap(cap, 'open', nullLogger)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(cap);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it('CC-11: TTL expire set exactly once even under concurrent first-bumps (count===1 guard)', async () => {
    const { incrementAndCheckDailyCap } = await import('../../core/settle-cap.js');
    await Promise.all(
      Array.from({ length: 20 }, () => incrementAndCheckDailyCap(10_000, 'open', nullLogger)),
    );
    // Only the request that observes count===1 sets the TTL — exactly one.
    expect(redis.expireSpy).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. CIRCUIT BREAKER UNDER CONCURRENT FAILURES — opens, then herd fast-fails
// ════════════════════════════════════════════════════════════════════════

describe('circuit breaker — concurrent failures open it, herd then fast-fails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CC-12: a wave of failing settles trips the breaker; subsequent concurrent calls fast-fail without invoking fn (no thundering herd)', async () => {
    const { ChainCircuitBreaker, BreakerOpenError } =
      await import('../../chains/circuit-breaker.js');
    const cb = new ChainCircuitBreaker({
      chainId: 424242,
      chainName: 'HerdTest',
      failureThreshold: 5,
      rollingWindowMs: 1000,
      resetTimeoutMs: 10_000,
      enabled: true,
    });

    // The downstream RPC call. Counts how many times the real RPC is hit.
    const rpcCalls = vi.fn();
    const failingRpc = async (): Promise<never> => {
      rpcCalls();
      throw new Error('RPC boom');
    };

    // Wave 1 — concurrent failures to trip the breaker. Each rejection is
    // counted by cockatiel's sampling window.
    await Promise.allSettled(Array.from({ length: 20 }, () => cb.execute(failingRpc)));
    await vi.advanceTimersByTimeAsync(0);

    expect(cb.getState()).toBe('OPEN');
    const rpcCallsAfterTrip = rpcCalls.mock.calls.length;

    // Wave 2 — herd of concurrent calls while OPEN. NONE should reach the RPC.
    const herd = await Promise.allSettled(Array.from({ length: 50 }, () => cb.execute(failingRpc)));

    // Every herd call fast-failed with BreakerOpenError.
    for (const r of herd) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(BreakerOpenError);
      }
    }
    // CRITICAL: the RPC was NOT called again during the herd — no thundering
    // herd hammering a downstream that's already known-bad.
    expect(rpcCalls.mock.calls.length).toBe(rpcCallsAfterTrip);
  });

  it('CC-13: while OPEN, fn passed to execute is never invoked (fast-fail guarantee)', async () => {
    const { ChainCircuitBreaker, BreakerOpenError } =
      await import('../../chains/circuit-breaker.js');
    const cb = new ChainCircuitBreaker({
      chainId: 424243,
      chainName: 'FastFail',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 10_000,
      enabled: true,
    });

    await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        cb.execute(async () => {
          throw new Error('boom');
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.getState()).toBe('OPEN');

    const shouldNotRun = vi.fn(async () => 'nope');
    const settled = await Promise.allSettled(
      Array.from({ length: 30 }, () => cb.execute(shouldNotRun)),
    );
    expect(shouldNotRun).not.toHaveBeenCalled();
    for (const r of settled) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BreakerOpenError);
    }
  });

  it('CC-14: breaker provides a positive Retry-After window (remainingMs) once OPEN', async () => {
    const { ChainCircuitBreaker } = await import('../../chains/circuit-breaker.js');
    const cb = new ChainCircuitBreaker({
      chainId: 424244,
      chainName: 'RetryAfter',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 10_000,
      enabled: true,
    });
    await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        cb.execute(async () => {
          throw new Error('boom');
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.getRemainingOpenMs()).toBeGreaterThan(0);
    expect(cb.getRemainingOpenMs()).toBeLessThanOrEqual(10_000);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. COMBINED INVARIANT — lock + cache + cap together, single broadcast
// ════════════════════════════════════════════════════════════════════════

describe('combined: lock + idempotency cache + daily cap (one broadcast end-to-end)', () => {
  it('CC-15: concurrent identical settles under a generous cap → ONE broadcast, others dedup, cap counts only the winner path once per attempt', async () => {
    const idem = await import('../../core/idempotency.js');
    const { incrementAndCheckDailyCap } = await import('../../core/settle-cap.js');
    const writeContract = vi.fn(async () => {
      await Promise.resolve();
      return SUCCESS_PAYLOAD;
    });

    async function pipeline(): Promise<string> {
      const cached = await idem.getCachedSettleResponse(IDEMPOTENCY_KEY);
      if (cached) return 'cached';
      const lock = await idem.setInflightSettleLock(IDEMPOTENCY_KEY);
      if (lock === 'held') return 'conflict';
      try {
        // cap check happens after the lock in the real route (runSettle)
        const cap = await incrementAndCheckDailyCap(1000, 'open', nullLogger);
        if (!cap.ok) return 'rate_limited';
        const result = await writeContract();
        await idem.setCachedSettleResponse(IDEMPOTENCY_KEY, result);
        return 'broadcast';
      } finally {
        if (lock === 'acquired') await idem.releaseInflightSettleLock(IDEMPOTENCY_KEY);
      }
    }

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => pipeline()));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o === 'broadcast')).toHaveLength(1);
    // Because the lock dedups BEFORE the cap INCR, the cap counter is only
    // bumped by the single acquirer — concurrent dupes don't burn the budget.
    const todayKey = `settle:daily:${new Date().toISOString().slice(0, 10)}`;
    expect(redis.counter(todayKey)).toBe(1);
  });
});
