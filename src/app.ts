import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
} from 'fastify';
import type { DestinationStream } from 'pino';
import { parseEnv, type EnvConfig } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { healthRoute } from './routes/health.js';

export interface BuildAppOptions {
  /** Override raw env (for tests). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pino destination stream for log capture (for tests). Default: undefined (stdout). */
  loggerDestination?: DestinationStream;
}

/**
 * Factory for the Fastify instance. Does NOT call `listen()` (CD-17).
 * Tests use `app.inject(...)` for HTTP testing without binding a port.
 *
 * CD-3:  inviolable separation — `src/index.ts` is the only file calling listen().
 * CD-7:  every `fastify.register(...)` is awaited.
 * CD-11: logger is pre-built via `createLogger()`; Fastify receives `loggerInstance`.
 * CD-12: `disableRequestLogging` stays `false` (explicit default) so AC-9 fires.
 */
export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const rawEnv = options.env ?? process.env;
  const env: EnvConfig = parseEnv(rawEnv);
  // Widen Pino's Logger to FastifyBaseLogger so Fastify does not specialize
  // the generic (structural compatibility is intentional; R9 in the Story File).
  const logger: FastifyBaseLogger = createLogger(env, options.loggerDestination);

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  });

  await app.register(healthRoute);

  return app;
}
