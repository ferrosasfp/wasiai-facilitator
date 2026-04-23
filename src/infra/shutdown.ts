import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  app: FastifyInstance;
  graceMs: number;
  /** Allows tests to inject a mock exit. Default: `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Creates a handler function that, when invoked with a signal name
 * (e.g. 'SIGTERM'), initiates a graceful shutdown:
 *
 *   1. Start `forceExitTimer = setTimeout(forceExit, graceMs)`; `.unref()` it
 *      so the timer alone does not keep the event loop alive.
 *   2. `await app.close()`.
 *   3. `clearTimeout(forceExitTimer)`.
 *   4. `exit(0)`.
 *
 * Error paths:
 *   - If `app.close()` rejects: log via `app.log.error({ err }, ...)` and
 *     `exit(1)`.
 *   - If `graceMs` elapses first: log EXACTLY
 *     `'Graceful shutdown timed out, forcing exit'` and `exit(1)`. (AC-12)
 *
 * Idempotency: invoking the handler while a shutdown is already in flight
 * logs an info `'shutdown already in progress'` and returns without starting
 * a second shutdown.
 */
export function createShutdownHandler(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const { app, graceMs } = opts;
  const exit = opts.exit ?? (process.exit as (code: number) => never);
  let shutdownInProgress = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shutdownInProgress) {
      app.log.info({ signal }, 'shutdown already in progress');
      return;
    }
    shutdownInProgress = true;

    app.log.info({ signal }, 'Received shutdown signal');

    let timedOut = false;
    const forceExitTimer = setTimeout(() => {
      timedOut = true;
      app.log.error({ signal, graceMs }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, graceMs);
    forceExitTimer.unref();

    try {
      await app.close();
      clearTimeout(forceExitTimer);
      if (timedOut) return;
      exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      if (timedOut) return;
      app.log.error({ err }, 'Error during graceful shutdown');
      exit(1);
    }
  };
}
