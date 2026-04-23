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
  const env = parseEnv(process.env);
  const app = await buildApp({ env: process.env });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

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
