/**
 * wasiai-facilitator — entry point.
 *
 * Orchestrates: buildApp → listen → register SIGTERM/SIGINT handlers.
 * NO business logic here (CD-3). NO console.* calls (CD-1, AC-10).
 */

import { buildApp } from './app.js';
import { parseEnv } from './infra/env.js';
import { createShutdownHandler } from './infra/shutdown.js';

async function main(): Promise<void> {
  // Single parse (MNR-1 fix): parse once here and pass the validated EnvConfig
  // to buildApp so it does NOT re-run Zod validation internally.
  const env = parseEnv(process.env);
  const app = await buildApp({ env });

  // AC-1 / CD-18 fix (BLQ-BAJO-1): Fastify v5 internally calls
  // `this.log.info(listenTextResolver(address))` for every bound address
  // AFTER the OS emits the `listening` event (see fastify/lib/server.js
  // `logServerAddress`). With `host: '0.0.0.0'` this produces N log lines
  // with shape `{msg: "Server listening at http://<addr>:<port>"}` BEFORE
  // our AC-1-required log, violating "first JSON line after listen →
  // {msg:'Server listening', port:N}" literally.
  //
  // The only reliable suppression point is the logger itself. We temporarily
  // replace `app.log.info` with a filter that drops any message whose first
  // arg is a string starting with "Server listening at " (Fastify's default
  // text resolver output), then restore it before emitting our compliant log.
  // Other `info` traffic during `listen()` (hooks, etc.) is passed through.
  const originalInfo = app.log.info.bind(app.log);
  const isFastifyListeningText = (v: unknown): v is string =>
    typeof v === 'string' && v.startsWith('Server listening at ');
  (app.log as { info: (...args: unknown[]) => void }).info = (...args: unknown[]): void => {
    if (args.length > 0 && isFastifyListeningText(args[0])) return;
    (originalInfo as (...a: unknown[]) => void)(...args);
  };

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // Restore the original logger so all subsequent `info` calls are unaffected.
  (app.log as { info: typeof originalInfo }).info = originalInfo;

  // CD-18: EXACT shape {"msg":"Server listening","port":<N>}.
  // app.log is Pino → JSON in production, pretty in development.
  app.log.info({ port: env.PORT }, 'Server listening');

  const shutdown = createShutdownHandler({
    app,
    graceMs: env.SHUTDOWN_GRACE_MS,
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

// Top-level error handler. `parseEnv` already exits on invalid env, so the
// errors reachable here are primarily `listen()` failures (EADDRINUSE) or
// plugin-register timeouts during `buildApp()`.
main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal error during bootstrap: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
