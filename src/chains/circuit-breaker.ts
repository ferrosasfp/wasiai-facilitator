/**
 * WFAC-41 — Per-chain circuit breaker wrapper around `cockatiel`.
 *
 * Exposes a narrow, adapter-friendly API on top of cockatiel's
 * `CircuitBreakerPolicy` + `SamplingBreaker`:
 *
 *   - `ChainCircuitBreaker.execute(fn)`: runs `fn` through the breaker.
 *     When the breaker is OPEN, throws `BreakerOpenError` (custom, with
 *     `chainId` + `remainingMs`). Cockatiel's internal `BrokenCircuitError`
 *     NEVER escapes this module (CD-NEW-CB-TRANSLATE).
 *   - `BusinessFailureError`: sentinel thrown by adapters from inside
 *     `_breaker.execute(...)` when `_verifyRaw`/`_settleRaw` produce a
 *     business-level failure (SIMULATION_FAILED / TRANSACTION_FAILED).
 *     The outer `verify()`/`settle()` catches it, unwraps the original
 *     `AdapterResult`, and returns it to the caller. This pattern gives
 *     the breaker clean 1:1 accounting (one business failure → one
 *     breaker failure) — see AR-BLQ-ALTO-1 fix for AC-13.
 *   - `recordBusinessFailure(reason)`: legacy helper kept for tests that
 *     need to force-open a breaker without going through `execute`. NOT
 *     used by the adapter runtime path anymore (AR-BLQ-ALTO-1 fix).
 *   - `getState()`: 'CLOSED' | 'OPEN' | 'HALF_OPEN' (Isolated → 'OPEN')
 *     when enabled; `undefined` when `enabled=false` (DT-7 — lets the
 *     `/supported` route omit the `breakerState` field entirely via spread).
 *   - `getRemainingOpenMs()`: used by the adapter to populate the
 *     `retryAfterMs` field on `CHAIN_UNAVAILABLE` errors; route layer then
 *     emits the `Retry-After` HTTP header.
 *   - `setLogger(logger)`: lazy logger injection from `initChainBreakers`
 *     at `buildApp` time. Idempotent.
 *
 * Passthrough mode (`enabled: false`) is a strict no-op: no state changes,
 * no metric updates, no log emissions — `execute` directly returns `fn()`
 * and `recordBusinessFailure` is a no-op (CD-NEW-CB-ENABLED-FALSE).
 *
 * Boundaries (OWNERS.md + CD-CHAIN-OWNERS):
 *   - MAY import: `cockatiel`, `prom-client`, `pino` (type-only).
 *   - MUST NOT import: `src/core/*`, `src/routes/*`, `src/methods/*`,
 *                      `src/infra/*` (runtime). The translation from
 *                      `BreakerOpenError` to the x402 `CHAIN_UNAVAILABLE`
 *                      error happens in the adapter layer, not here.
 */

import {
  circuitBreaker,
  SamplingBreaker,
  handleAll,
  CircuitState,
  BrokenCircuitError,
  type CircuitBreakerPolicy,
} from 'cockatiel';
import {
  Counter,
  Gauge,
  register as defaultRegister,
  type Counter as PromCounter,
  type Gauge as PromGauge,
} from 'prom-client';
import type { Logger } from 'pino';
import type { Err } from '../core/types.js';

export type BreakerStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ChainCircuitBreakerOptions {
  readonly chainId: number;
  readonly chainName: string;
  readonly failureThreshold: number;
  readonly rollingWindowMs: number;
  readonly resetTimeoutMs: number;
  readonly enabled: boolean;
  readonly logger?: Logger;
}

/**
 * Thrown from `ChainCircuitBreaker.execute` when the breaker is OPEN.
 * Replaces cockatiel's `BrokenCircuitError` at the module boundary so
 * consumers never depend on cockatiel types.
 */
export class BreakerOpenError extends Error {
  public readonly chainId: number;
  public readonly remainingMs: number;
  constructor(chainId: number, remainingMs: number) {
    super(`Circuit breaker OPEN for chain ${String(chainId)}`);
    this.name = 'BreakerOpenError';
    this.chainId = chainId;
    this.remainingMs = remainingMs;
  }
}

/**
 * Sentinel thrown by adapters from inside `_breaker.execute(...)` when the
 * raw verify/settle implementation returns a business-level failure
 * (SIMULATION_FAILED / TRANSACTION_FAILED — AC-13). The outer
 * `verify()`/`settle()` catches this, unwraps `.result`, and returns it
 * to the caller unchanged.
 *
 * WHY (AR-BLQ-ALTO-1 fix): the previous design called
 * `recordBusinessFailure()` from inside `_verifyRaw`, which ran a second
 * `policy.execute(() => throw)` while the outer `policy.execute(() =>
 * _verifyRaw())` resolved successfully (because `_verifyRaw` returned an
 * `AdapterResult` rather than throwing). Cockatiel's SamplingBreaker saw
 * +1 failure AND +1 success per call — the ratio stayed at 50% and the
 * breaker never tripped with the strict-greater-than threshold. Throwing
 * from inside the outer execute gives clean 1:1 accounting.
 */
export class BusinessFailureError extends Error {
  public readonly result: Err;
  public readonly code: string;
  constructor(result: Err, code: string) {
    super(`Business failure: ${code}`);
    this.name = 'BusinessFailureError';
    this.result = result;
    this.code = code;
  }
}

// ─── Metrics (idempotent registration — CD-NEW-CB-METRICS-IDEMPOTENT) ──────
// prom-client's default registry is a process-level singleton. Under
// `vi.resetModules()` (used by adapter tests) this module may re-evaluate;
// `new Gauge({name, ...})` throws if the name is already registered. The
// `registerOrGet*` helpers guard against that by checking the register
// first and returning the existing metric if present.

function registerOrGetCounter(
  name: string,
  factory: () => PromCounter<string>,
): PromCounter<string> {
  const existing = defaultRegister.getSingleMetric(name);
  if (existing) return existing as PromCounter<string>;
  return factory();
}

function registerOrGetGauge(name: string, factory: () => PromGauge<string>): PromGauge<string> {
  const existing = defaultRegister.getSingleMetric(name);
  if (existing) return existing as PromGauge<string>;
  return factory();
}

const cbStateGauge = registerOrGetGauge(
  'cb_state',
  () =>
    new Gauge({
      name: 'cb_state',
      help: 'Circuit breaker state per chain (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
      labelNames: ['chain', 'chain_id'],
    }),
);

const cbFailuresTotal = registerOrGetCounter(
  'cb_failures_total',
  () =>
    new Counter({
      name: 'cb_failures_total',
      help: 'Total failures counted toward circuit breaker (per chain)',
      labelNames: ['chain', 'chain_id', 'reason'],
    }),
);

const cbTransitionsTotal = registerOrGetCounter(
  'cb_transitions_total',
  () =>
    new Counter({
      name: 'cb_transitions_total',
      help: 'Circuit breaker state transitions (per chain + direction)',
      labelNames: ['chain', 'chain_id', 'from_state', 'to_state'],
    }),
);

// ─── Helpers for adapter consumers ────────────────────────────────────────
// Adapters read env vars directly (they cannot import `src/infra/env.ts`
// per OWNERS). These helpers mirror the Zod defaults exactly — divergence
// would make `process.env` omission behave differently across layers
// (CD-NEW-CB-HELPER-DEFAULTS).

export function readCbNumber(name: string, fallback: number): number {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a caller-controlled literal from the hardcoded set { CB_FAILURE_THRESHOLD, CB_ROLLING_WINDOW_MS, CB_RESET_TIMEOUT_MS } used by ChainAdapter constructors. Not attacker-controlled.
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readCbBool(name: string, fallback: boolean): boolean {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a caller-controlled literal ('CB_ENABLED') from ChainAdapter constructors. Not attacker-controlled.
  const raw = process.env[name];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

// ─── Helpers for state mapping ────────────────────────────────────────────

function cockatielStateToName(state: CircuitState): BreakerStateName {
  switch (state) {
    case CircuitState.Closed:
      return 'CLOSED';
    case CircuitState.HalfOpen:
      return 'HALF_OPEN';
    case CircuitState.Open:
    case CircuitState.Isolated:
      return 'OPEN';
    default:
      return 'CLOSED';
  }
}

function stateGaugeValue(state: BreakerStateName): number {
  switch (state) {
    case 'CLOSED':
      return 0;
    case 'HALF_OPEN':
      return 1;
    case 'OPEN':
      return 2;
  }
}

// ─── ChainCircuitBreaker ──────────────────────────────────────────────────

export class ChainCircuitBreaker {
  private readonly _chainId: number;
  private readonly _chainName: string;
  private readonly _enabled: boolean;
  private readonly _resetTimeoutMs: number;
  private readonly _policy: CircuitBreakerPolicy | null;
  private _logger: Logger | undefined;
  private _breakOpenAtMs: number;
  private _currentStateName: BreakerStateName;

  constructor(opts: ChainCircuitBreakerOptions) {
    this._chainId = opts.chainId;
    this._chainName = opts.chainName;
    this._enabled = opts.enabled;
    this._resetTimeoutMs = opts.resetTimeoutMs;
    this._logger = opts.logger;
    this._breakOpenAtMs = 0;
    this._currentStateName = 'CLOSED';

    if (!this._enabled) {
      // Passthrough mode — no policy, no state, no metrics, no logs.
      this._policy = null;
      return;
    }

    // SamplingBreaker: opens when > `threshold` of calls fail over
    // `duration` ms, provided `minimumRps` is met. We derive `minimumRps`
    // from the configured threshold + window so the breaker trips at the
    // documented failure count under the simplest saturation assumption.
    const rpsFloor = Math.max(
      0.001,
      opts.failureThreshold / Math.max(1, opts.rollingWindowMs / 1000),
    );
    const policy = circuitBreaker(handleAll, {
      halfOpenAfter: opts.resetTimeoutMs,
      breaker: new SamplingBreaker({
        threshold: 0.5,
        duration: opts.rollingWindowMs,
        minimumRps: rpsFloor,
      }),
    });
    this._policy = policy;

    policy.onStateChange((newState) => {
      const from = this._currentStateName;
      const to = cockatielStateToName(newState);
      this._currentStateName = to;
      if (to === 'OPEN') {
        this._breakOpenAtMs = Date.now();
      } else if (to === 'CLOSED') {
        this._breakOpenAtMs = 0;
      }
      cbStateGauge.set(
        { chain: this._chainName, chain_id: String(this._chainId) },
        stateGaugeValue(to),
      );
      cbTransitionsTotal.inc({
        chain: this._chainName,
        chain_id: String(this._chainId),
        from_state: from,
        to_state: to,
      });
      this._logger?.warn(
        {
          chainId: this._chainId,
          chainName: this._chainName,
          fromState: from,
          toState: to,
        },
        'circuit breaker state transition',
      );
    });

    // Initialize gauge at CLOSED so scrapers see the metric immediately.
    cbStateGauge.set({ chain: this._chainName, chain_id: String(this._chainId) }, 0);
  }

  /**
   * Execute `fn` through the breaker.
   *
   * - `enabled=false`: pass-through to `fn()` (CD-NEW-CB-ENABLED-FALSE).
   * - OPEN: throws `BreakerOpenError(chainId, remainingMs)` — cockatiel's
   *   `BrokenCircuitError` never escapes (CD-NEW-CB-TRANSLATE).
   * - Closed/HalfOpen: propagates exceptions from `fn` after cockatiel
   *   counts them as failures.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this._enabled || this._policy === null) {
      return fn();
    }
    try {
      return await this._policy.execute(fn);
    } catch (err) {
      if (err instanceof BrokenCircuitError) {
        throw new BreakerOpenError(this._chainId, this.getRemainingOpenMs());
      }
      // Non-breaker exception — count as an RPC failure (best-effort label)
      // and propagate.
      cbFailuresTotal.inc({
        chain: this._chainName,
        chain_id: String(this._chainId),
        reason: 'rpc_error',
      });
      throw err;
    }
  }

  /**
   * Record a business-level failure (e.g. SIMULATION_FAILED) against the
   * breaker without invoking a real RPC call. Used by adapters to count
   * x402 error results toward the threshold (AC-13).
   *
   * No-op when `enabled=false` (CD-NEW-CB-ENABLED-FALSE).
   */
  recordBusinessFailure(reason: string): void {
    if (!this._enabled || this._policy === null) return;
    // Feed the breaker one failure via a rejected dummy execution. We
    // catch the resulting rejection locally so the synthetic error never
    // propagates to the caller — cockatiel still sees the failure count.
    this._policy
      .execute(() => {
        throw new Error(`business failure: ${reason}`);
      })
      .catch(() => {
        // Swallow — we intentionally triggered this failure to feed
        // cockatiel's sampling window.
      });
    cbFailuresTotal.inc({
      chain: this._chainName,
      chain_id: String(this._chainId),
      reason,
    });
  }

  /**
   * Current breaker state when enabled; `undefined` when `enabled=false`.
   *
   * DT-7 / AR-BLQ-BAJO-1: returning `undefined` in disabled mode lets
   * the `/supported` route's spread-based serializer OMIT the
   * `breakerState` field entirely (rather than reporting a misleading
   * 'CLOSED' for a non-existent breaker). When `enabled=true` the return
   * is always one of the three `BreakerStateName` literals.
   */
  getState(): BreakerStateName | undefined {
    if (!this._enabled || this._policy === null) return undefined;
    return cockatielStateToName(this._policy.state);
  }

  /**
   * Milliseconds remaining until the breaker is eligible to attempt the
   * HALF_OPEN probe. Returns 0 when the breaker is not currently OPEN
   * or when `enabled=false`.
   */
  getRemainingOpenMs(): number {
    if (!this._enabled || this._policy === null) return 0;
    if (this.getState() !== 'OPEN') return 0;
    if (this._breakOpenAtMs === 0) return this._resetTimeoutMs;
    const elapsed = Date.now() - this._breakOpenAtMs;
    const remaining = this._resetTimeoutMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Inject a logger for state-transition warnings. Idempotent — overwrites
   * the previous logger. Called once per adapter from `initChainBreakers`
   * during `buildApp` (DT-11 SDD).
   */
  setLogger(logger: Logger): void {
    this._logger = logger;
  }
}
