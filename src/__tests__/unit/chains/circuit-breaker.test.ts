/**
 * WFAC-41 — Unit tests for src/chains/circuit-breaker.ts.
 *
 * Coverage matrix:
 *   - AC-1 / T-CB-1, T-CB-2: baseline CLOSED + N failures → OPEN.
 *   - AC-2 / T-CB-3: OPEN fast-fails without invoking fn.
 *   - AC-3 / T-CB-4: OPEN → HALF_OPEN after reset timeout.
 *   - AC-4 / T-CB-5: HALF_OPEN success → CLOSED.
 *   - AC-5 / T-CB-6: HALF_OPEN fail → OPEN with timer restart.
 *   - AC-6 / T-CB-7: enabled=false passthrough.
 *   - AC-7 / T-CB-8: cross-chain independence.
 *   - AC-13 / T-CB-9: recordBusinessFailure feeds the breaker.
 *   - AC-12 / T-CB-10: metrics populated after transitions.
 *   - AC-8 / T-CB-11: logger injection + warn payload shape.
 *   - T-CB-12: BreakerOpenError shape.
 *   - T-CB-13: readCbNumber/readCbBool helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register as defaultRegister } from 'prom-client';
import type { Logger } from 'pino';
import {
  ChainCircuitBreaker,
  BreakerOpenError,
  readCbNumber,
  readCbBool,
} from '../../../chains/circuit-breaker.js';

// Helper: drive N failures through the breaker to force it OPEN. Uses
// recordBusinessFailure (which feeds cockatiel a rejected execution) to
// avoid needing wall-clock async coordination of real fn() rejections.
function forceOpen(cb: ChainCircuitBreaker, n: number): void {
  for (let i = 0; i < n; i += 1) {
    cb.recordBusinessFailure('test_forced');
  }
}

describe('ChainCircuitBreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('T-CB-1 (AC-1 baseline CLOSED): newly constructed breaker is CLOSED and passes through fn() result', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9001,
      chainName: 'Test9001',
      failureThreshold: 3,
      rollingWindowMs: 10000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    expect(cb.getState()).toBe('CLOSED');
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
  });

  it('T-CB-2 (AC-1 → OPEN after enough failures): breaker trips OPEN after sustained failure rate', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9002,
      chainName: 'Test9002',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    // Feed enough business failures to cross the 50% threshold in the
    // sampling window. 20 failures is comfortably above the trip point.
    forceOpen(cb, 20);
    // Give cockatiel's microtasks a chance to process the rejections.
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');
  });

  it('T-CB-3 (AC-2 OPEN fast-fails): OPEN breaker throws BreakerOpenError without invoking fn', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9003,
      chainName: 'Test9003',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cb, 20);
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');

    const fnSpy = vi.fn(async () => 'should-not-run');
    await expect(cb.execute(fnSpy)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(fnSpy).not.toHaveBeenCalled();
  });

  it('T-CB-4 (AC-3 OPEN → HALF_OPEN after reset timeout): probe is allowed after resetTimeoutMs', async () => {
    vi.useFakeTimers();
    const cb = new ChainCircuitBreaker({
      chainId: 9004,
      chainName: 'Test9004',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cb, 20);
    // Flush microtasks before advancing time.
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.getState()).toBe('OPEN');

    // Advance past reset timeout.
    await vi.advanceTimersByTimeAsync(5001);
    // Next execute triggers the HALF_OPEN probe.
    const fnSpy = vi.fn(async () => 'probe-ok');
    const result = await cb.execute(fnSpy);
    expect(result).toBe('probe-ok');
    expect(fnSpy).toHaveBeenCalledTimes(1);
    // After a successful probe, breaker should be CLOSED.
    expect(cb.getState()).toBe('CLOSED');
  });

  it('T-CB-5 (AC-4 HALF_OPEN success → CLOSED): onReset fires and logger sees HALF_OPEN→CLOSED transition', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.fn();
    const cb = new ChainCircuitBreaker({
      chainId: 9005,
      chainName: 'Test9005',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    cb.setLogger({ warn: warnSpy } as unknown as Logger);
    forceOpen(cb, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.getState()).toBe('OPEN');

    await vi.advanceTimersByTimeAsync(5001);
    await cb.execute(async () => 'probe-ok');
    expect(cb.getState()).toBe('CLOSED');

    // Verify a transition log entry into CLOSED was recorded.
    const calls = warnSpy.mock.calls;
    const closedEntry = calls.find((c) => (c[0] as { toState?: string }).toState === 'CLOSED');
    expect(closedEntry).toBeDefined();
  });

  it('T-CB-6 (AC-5 HALF_OPEN fail → OPEN + timer restart): probe failure re-opens breaker', async () => {
    vi.useFakeTimers();
    const cb = new ChainCircuitBreaker({
      chainId: 9006,
      chainName: 'Test9006',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cb, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.getState()).toBe('OPEN');

    await vi.advanceTimersByTimeAsync(5001);
    // Probe that fails → back to OPEN.
    await expect(
      cb.execute(async () => {
        throw new Error('probe-failed');
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
    // Remaining open time is close to the full reset window (timer restarted).
    const remaining = cb.getRemainingOpenMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it('T-CB-7 (AC-6 CB_ENABLED=false passthrough): disabled breaker never changes state or fast-fails', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9007,
      chainName: 'Test9007',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: false,
    });
    // Even after many failures, the breaker remains CLOSED.
    for (let i = 0; i < 100; i += 1) {
      await cb
        .execute(async () => {
          throw new Error('x');
        })
        .catch(() => {});
    }
    expect(cb.getState()).toBe('CLOSED');
    // Passthrough: execute resolves the inner fn's return value.
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    // recordBusinessFailure is a no-op in disabled mode.
    cb.recordBusinessFailure('SIMULATION_FAILED');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('T-CB-8 (AC-7 cross-chain independence): opening one breaker does not affect another', async () => {
    const cbA = new ChainCircuitBreaker({
      chainId: 9008,
      chainName: 'Test9008A',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    const cbB = new ChainCircuitBreaker({
      chainId: 9009,
      chainName: 'Test9009B',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cbA, 20);
    await new Promise((r) => setImmediate(r));
    expect(cbA.getState()).toBe('OPEN');
    expect(cbB.getState()).toBe('CLOSED');
    // Breaker B still accepts work.
    const result = await cbB.execute(async () => 'B-ok');
    expect(result).toBe('B-ok');
  });

  it('T-CB-9 (AC-13 recordBusinessFailure counts): business failures eventually trip the breaker', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9010,
      chainName: 'Test9010',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    for (let i = 0; i < 25; i += 1) {
      cb.recordBusinessFailure('SIMULATION_FAILED');
    }
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');
  });

  it('T-CB-10 (AC-12 metrics populated): cb_state / cb_transitions_total updated after transitions', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9011,
      chainName: 'Test9011',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cb, 20);
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');

    const stateMetric = defaultRegister.getSingleMetric('cb_state');
    const transMetric = defaultRegister.getSingleMetric('cb_transitions_total');
    expect(stateMetric).toBeDefined();
    expect(transMetric).toBeDefined();

    const stateSnap = await stateMetric!.get();
    const stateForChain = (
      stateSnap.values as Array<{ value: number; labels: Record<string, string> }>
    ).find((v) => v.labels.chain === 'Test9011');
    expect(stateForChain?.value).toBe(2); // OPEN gauge value

    const transSnap = await transMetric!.get();
    const closedToOpen = (
      transSnap.values as Array<{ value: number; labels: Record<string, string> }>
    ).find(
      (v) =>
        v.labels.chain === 'Test9011' &&
        v.labels.from_state === 'CLOSED' &&
        v.labels.to_state === 'OPEN',
    );
    expect(closedToOpen).toBeDefined();
    expect(closedToOpen!.value).toBeGreaterThanOrEqual(1);
  });

  it('T-CB-11 (AC-8 logger injection + payload shape): warn carries {chainId, chainName, fromState, toState}', async () => {
    const warnSpy = vi.fn();
    const cb = new ChainCircuitBreaker({
      chainId: 9012,
      chainName: 'Test9012',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    cb.setLogger({ warn: warnSpy } as unknown as Logger);
    forceOpen(cb, 20);
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');

    expect(warnSpy).toHaveBeenCalled();
    const openCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { toState?: string }).toState === 'OPEN',
    );
    expect(openCall).toBeDefined();
    expect(openCall![0]).toMatchObject({
      chainId: 9012,
      chainName: 'Test9012',
      fromState: 'CLOSED',
      toState: 'OPEN',
    });
    expect(openCall![1]).toBe('circuit breaker state transition');
  });

  it('T-CB-12 (BreakerOpenError shape): thrown error carries chainId, remainingMs, and name', async () => {
    const cb = new ChainCircuitBreaker({
      chainId: 9013,
      chainName: 'Test9013',
      failureThreshold: 3,
      rollingWindowMs: 1000,
      resetTimeoutMs: 5000,
      enabled: true,
    });
    forceOpen(cb, 20);
    await new Promise((r) => setImmediate(r));
    expect(cb.getState()).toBe('OPEN');

    try {
      await cb.execute(async () => 42);
      throw new Error('expected BreakerOpenError');
    } catch (err) {
      expect(err).toBeInstanceOf(BreakerOpenError);
      const bop = err as BreakerOpenError;
      expect(bop.name).toBe('BreakerOpenError');
      expect(bop.chainId).toBe(9013);
      expect(bop.remainingMs).toBeGreaterThan(0);
      expect(bop.remainingMs).toBeLessThanOrEqual(5000);
    }
  });
});

describe('readCbNumber / readCbBool helpers', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('T-CB-13a: readCbNumber returns parsed int when env var is a positive integer string', () => {
    process.env.TEST_CB_FAKE = '7';
    expect(readCbNumber('TEST_CB_FAKE', 5)).toBe(7);
  });

  it('T-CB-13b: readCbNumber returns fallback on non-integer env var', () => {
    process.env.TEST_CB_FAKE = 'abc';
    expect(readCbNumber('TEST_CB_FAKE', 5)).toBe(5);
  });

  it('T-CB-13c: readCbNumber returns fallback on non-positive env var', () => {
    process.env.TEST_CB_FAKE = '0';
    expect(readCbNumber('TEST_CB_FAKE', 5)).toBe(5);
    process.env.TEST_CB_FAKE = '-3';
    expect(readCbNumber('TEST_CB_FAKE', 5)).toBe(5);
  });

  it('T-CB-13d: readCbNumber returns fallback when env var is missing', () => {
    delete process.env.TEST_CB_FAKE;
    expect(readCbNumber('TEST_CB_FAKE', 42)).toBe(42);
  });

  it('T-CB-13e: readCbBool parses "true"/"false" and falls back on anything else', () => {
    process.env.TEST_CB_FAKE_BOOL = 'false';
    expect(readCbBool('TEST_CB_FAKE_BOOL', true)).toBe(false);
    process.env.TEST_CB_FAKE_BOOL = 'true';
    expect(readCbBool('TEST_CB_FAKE_BOOL', false)).toBe(true);
    process.env.TEST_CB_FAKE_BOOL = 'nope';
    expect(readCbBool('TEST_CB_FAKE_BOOL', true)).toBe(true);
    delete process.env.TEST_CB_FAKE_BOOL;
    expect(readCbBool('TEST_CB_FAKE_BOOL', false)).toBe(false);
  });
});
