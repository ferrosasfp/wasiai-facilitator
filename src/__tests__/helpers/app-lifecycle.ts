/**
 * Per-file lifecycle guard for the route suites that boot a Fastify app per
 * test (`rate-limiting.test.ts`, `routes.settle.test.ts`,
 * `routes.verify.test.ts`).
 *
 * This is test infrastructure only. It changes no production behaviour.
 *
 * ── Why it exists (measured, not assumed) ─────────────────────────────────
 *
 * 1. A ONE-OFF COST LANDS ON TEST #1's CLOCK.
 *    Those suites import `src/app.ts` LAZILY, inside the first test body
 *    (`await import('../../app.js')` in their `buildApp…` helper). A throwaway
 *    probe on an idle box measured that import at 626.1 ms cold and 0.1 ms on
 *    the second call; the first `buildApp()` + `inject()` add the rest. Net,
 *    with `--reporter=verbose` on an idle box: T-R1 of routes.verify 1069 ms,
 *    T-R1 of routes.settle 1071 ms, T-RL-1 of rate-limiting 1085 ms — while
 *    every later test in the same file lands between 4 ms and 18 ms. On a busy
 *    box that single second is what walks past `testTimeout`, which is why the
 *    failures are always the FIRST N tests of the file.
 *    Each suite now pays that cost in `beforeAll`, whose budget is the
 *    separate `hookTimeout`, so no individual test carries it.
 *
 * 2. A TIMED-OUT TEST POISONS THE NEXT ONE.
 *    When vitest times a test out it does NOT cancel the promises that test
 *    started — it stops awaiting them and moves on. The abandoned
 *    `app.inject()` keeps running and eventually reaches `settleCore` /
 *    `verifyCore`, which resolve the adapter from the process-wide
 *    `chainRegistry` singleton at REQUEST time (src/core/settle.ts:50 and
 *    :131, src/core/verify.ts:53 and :107). By then the NEXT test has already
 *    run `chainRegistry._resetForTesting()` + `register(itsOwnAdapter)`, so
 *    the stale request calls the NEXT test's spy. The next test then fails on
 *    a SPY-COUNT assertion — a message that reads like a routing/logic bug and
 *    names the wrong test. The exact wording depends on which assertion the
 *    victim uses: `expected "vi.fn()" to not be called at all, but actually
 *    been called 1 times` for the `not.toHaveBeenCalled()` tests, or a
 *    `toHaveBeenCalledTimes` mismatch. The module-level `core/audit.js` and
 *    `core/ledger.js` spies (which `beforeEach` clears) are poisoned through
 *    the same channel.
 *    Reproduced deterministically on the pre-fix tree, without touching
 *    production code, with:
 *      npx vitest run src/__tests__/unit/routes.settle.test.ts --testTimeout=100
 *    which failed T-R6 with `expected "vi.fn()" to be called 2 times, but got
 *    5 times` — the 3 extra calls came from the 5 predecessors that had timed
 *    out. T-R6 itself is a perfectly correct test.
 *    `drainAndCloseApps()` awaits every promise the suite started and closes
 *    every app it built, so nothing is in flight when the next test mutates
 *    the singleton.
 *
 * ── The three channels the contagion actually used ────────────────────────
 *
 * a) The `chainRegistry` singleton, resolved per request (above).
 * b) The module-level `vi.mock` spies for `core/audit.js` / `core/ledger.js`,
 *    which `beforeEach` clears and a stale request re-dirties.
 * c) The describe-scoped `let app` variable the three suites used to share.
 *    A dead test's continuation reaching `await app.inject(...)` read whatever
 *    the CURRENTLY RUNNING test had just assigned, and injected a ghost request
 *    into the live app. That variable is gone: every test now holds its own
 *    `const app`, and cleanup is centralised here instead.
 *
 * The bookkeeping below deliberately does NOT rely on any suite-local
 * variable. If the timeout lands before `const app = await buildApp…()`
 * resolves, that variable is never assigned, so the old `afterEach`
 * (`if (app) await app.close()`) closed nothing at all and the app it
 * eventually produced leaked for the rest of the file.
 *
 * ── Standing measurement (this is how you check it again) ─────────────────
 *
 * A low-frequency flake cannot be shown absent by re-running a green suite.
 * What CAN be re-measured is the contagion, deterministically, by forcing the
 * timeouts instead of waiting for them:
 *
 *   npx vitest run src/__tests__/unit/routes.settle.test.ts --testTimeout=3
 *   npx vitest run src/__tests__/unit/routes.verify.test.ts --testTimeout=3
 *   npx vitest run src/__tests__/unit/rate-limiting.test.ts --testTimeout=3
 *
 * Every test is expected to FAIL there — that is the point. The invariant is
 * that every failure says `Test timed out in 3ms` and NOT a single one is an
 * `AssertionError`. Before this helper the same command produced assertion
 * failures on innocent tests; if one ever comes back, the barrier has a hole.
 */

import type { FastifyInstance } from 'fastify';

/** Promises the suite started, whether or not the test that started them is
 *  still being awaited by vitest. */
const pending = new Set<Promise<unknown>>();

/** Every app instance that finished booting during this file. */
const liveApps = new Set<FastifyInstance>();

/**
 * Registers a promise so `drainAndCloseApps()` can wait for it.
 *
 * Use it on the `buildApp…()` call itself: if the test times out DURING the
 * boot, the boot keeps burning the (single-threaded) event loop and starves
 * the next test's clock too — that is the cascade that turns one slow test
 * into "the first 8 tests failed".
 */
export function trackPending<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  return promise;
}

/**
 * Registers an app the moment it finishes booting and wraps its `inject` so
 * every request it serves is tracked.
 *
 * GOTCHA, measured, and the reason an earlier draft of this file did nothing at
 * all: `app.inject(opts)` does NOT return a native Promise. It returns a
 * light-my-request `Chain` (node_modules/light-my-request/index.js:96) — a
 * thenable that memoizes its underlying promise in `_promise`, so reading
 * `.then` twice is safe and does not dispatch twice (index.js:171-183). The
 * first draft guarded with `out instanceof Promise`, which is `false` for a
 * `Chain`, so it silently tracked NOTHING; the guard has to be a thenable
 * check. Probe output that pinned it:
 *   TRACE inject url="/settle" ctor=Chain isPromise=false thenable=function
 * `args.length > 0` separates the dispatching form `inject(opts)` from the
 * chainable builder form `inject()`, which must not be forced to resolve here.
 *
 * WHAT ABOUT THE POST-FLUSH TAIL? The audit row is written from an
 * `onResponse` hook (src/app.ts:436-464), which is not part of the reply. An
 * earlier version of this helper appended its own `onResponse` hook to signal
 * when that tail had finished. It was dropped, for two measured reasons:
 *  - It is unnecessary. Fastify starts the `onResponse` chain from the reply's
 *    `finish` event, which also drives light-my-request's own resolution, and
 *    the mocked `persistAuditEntry` settles within microtasks. Awaiting the
 *    inject thenable is therefore already enough — and it has to be, because
 *    the suite ITSELF depends on that same ordering: T-AR-1
 *    (routes.settle.test.ts:1013) asserts `persistAuditEntry` was called
 *    exactly once on the line right after `await app.inject(...)`.
 *  - It introduced a worse failure. If an earlier `onResponse` hook REJECTS,
 *    Fastify aborts the chain and never reaches later hooks
 *    (node_modules/fastify/lib/hooks.js:257-262) — so the signal never fired
 *    for T-AR-9, the test whose whole point is a rejecting
 *    `persistAuditEntry`, and `afterEach` burned the 10 s hook timeout.
 *
 * The wrapper is on the instance, not on the module, so it disappears with the
 * instance. No hook is added to the app under test: it runs the same hook
 * chain in tests as in production.
 */
export function trackApp(app: FastifyInstance): FastifyInstance {
  liveApps.add(app);

  const patchable = app as unknown as { inject: (...args: unknown[]) => unknown };
  const rawInject = patchable.inject.bind(app) as (...args: unknown[]) => unknown;
  patchable.inject = (...args: unknown[]): unknown => {
    const out = rawInject(...args);
    const isThenable =
      args.length > 0 &&
      typeof out === 'object' &&
      out !== null &&
      typeof (out as { then?: unknown }).then === 'function';
    if (isThenable) {
      // `.catch` so a rejected inject cannot turn the barrier into an
      // unhandled rejection; the drain only needs it SETTLED.
      pending.add(Promise.resolve(out).catch(() => undefined));
    }
    return out;
  };
  return app;
}

/**
 * Barrier for `afterEach`: nothing this test started may still be running when
 * the next one re-registers the shared `chainRegistry` adapter.
 *
 * Draining happens BEFORE closing so an in-flight request finishes against the
 * app that is serving it. The loop re-checks the set because a drained promise
 * may have queued another tracked one (a test that fires a second `inject`
 * from the continuation of the first).
 *
 * If some promise never settles, this hook exhausts `hookTimeout` and vitest
 * reports a hook timeout naming THIS barrier. That is the intended outcome: an
 * honest "something never resolved" beats a fabricated assertion failure
 * attributed to an innocent test.
 */
export async function drainAndCloseApps(): Promise<void> {
  while (pending.size > 0) {
    const batch = [...pending];
    pending.clear();
    await Promise.allSettled(batch);
  }

  // Belt and braces. Vitest abandons a timed-out test but its BODY keeps
  // executing: once its first `await app.inject(...)` resolves, the
  // continuation runs the NEXT statements of that dead test, including further
  // `inject()` calls. The loop above catches those only if the continuation
  // queues its work before the loop re-reads `pending.size` — true in every
  // configuration measured here, but a scheduling assumption rather than a
  // guarantee. Disarming turns it into a guarantee: after its own `afterEach`,
  // an app can no longer serve anything, full stop.
  //
  // Honest note on weight: with the drain working, removing this block did not
  // reproduce a single assertion failure across --testTimeout=1..5 on all three
  // suites. It is insurance, not the fix. The fix was the thenable check in
  // `trackApp` (the earlier `instanceof Promise` guard tracked nothing) plus
  // dropping the shared `let app`.
  //
  // Done synchronously, before any further await. A disarmed `inject` returns a
  // promise that never settles: the caller is by definition a dead test's
  // continuation, so parking it is correct — rejecting would surface as an
  // unhandled rejection attributed to whatever test happens to be running.
  const apps = [...liveApps];
  liveApps.clear();
  for (const instance of apps) {
    const patchable = instance as unknown as { inject: () => Promise<never> };
    patchable.inject = (): Promise<never> => new Promise<never>(() => undefined);
  }

  await Promise.allSettled(apps.map((instance) => instance.close()));
}
