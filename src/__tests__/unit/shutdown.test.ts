import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createShutdownHandler } from '../../infra/shutdown.js';

interface FakeLog {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

interface FakeApp {
  log: FakeLog;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeApp(close: ReturnType<typeof vi.fn>): FakeApp {
  return {
    log: { info: vi.fn(), error: vi.fn() },
    close,
  };
}

/**
 * The shutdown handler only touches `.close()`, `.log.info`, `.log.error`.
 * We erase the structural gap via a two-step assignment through `unknown` —
 * this is the standard vitest mock pattern and is narrowly scoped to tests.
 */
function asFastify(fake: FakeApp): FastifyInstance {
  return fake as unknown as FastifyInstance;
}

/** Wrap a `vi.fn()` so it satisfies the `(code: number) => never` shape. */
function asNeverExit(fn: ReturnType<typeof vi.fn>): (code: number) => never {
  return fn as unknown as (code: number) => never;
}

describe('createShutdownHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes app and exits 0 on fast drain', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const fakeApp = makeFakeApp(close);
    const exit = vi.fn();

    const handler = createShutdownHandler({
      app: asFastify(fakeApp),
      graceMs: 10000,
      exit: asNeverExit(exit),
    });

    await handler('SIGTERM');

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(fakeApp.log.error).not.toHaveBeenCalled();
  });

  it('logs timeout error and exits 1 when grace period elapses', async () => {
    vi.useFakeTimers();

    // `app.close()` never resolves, forcing the timeout branch.
    const close = vi.fn(() => new Promise<undefined>(() => {}));
    const fakeApp = makeFakeApp(close);
    const exit = vi.fn();

    const handler = createShutdownHandler({
      app: asFastify(fakeApp),
      graceMs: 50,
      exit: asNeverExit(exit),
    });

    // Fire-and-forget; the handler awaits `app.close()` which never resolves.
    void handler('SIGTERM');

    // Advance fake timers past the graceMs threshold.
    await vi.advanceTimersByTimeAsync(60);

    expect(exit).toHaveBeenCalledWith(1);
    expect(fakeApp.log.error).toHaveBeenCalled();
    // AC-12 requires the EXACT message string.
    const lastErrorCall = fakeApp.log.error.mock.calls.at(-1);
    expect(lastErrorCall).toBeDefined();
    expect(lastErrorCall?.[1]).toBe('Graceful shutdown timed out, forcing exit');
  });
});
