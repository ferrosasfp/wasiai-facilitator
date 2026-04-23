import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import type { DestinationStream } from 'pino';
import { parseEnv, type EnvConfig } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { healthRoute } from './routes/health.js';

export interface BuildAppOptions {
  /**
   * Pre-parsed `EnvConfig`. When provided, `parseEnv` is NOT called again
   * (avoids double validation — MNR-1 from AR/CR). `index.ts` always passes
   * this after its own `parseEnv(process.env)`.
   */
  env?: EnvConfig;
  /**
   * Raw env to parse when `env` is not provided. Default: `process.env`.
   * Used by tests that want to exercise the Zod validation path (e.g. to
   * override `LOG_LEVEL` without pre-parsing manually).
   */
  rawEnv?: NodeJS.ProcessEnv;
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
 *
 * MNR-1 fix: if `options.env` is provided, it is already a parsed `EnvConfig`
 * and we MUST NOT re-parse (would validate twice). If not, fall back to
 * `options.rawEnv ?? process.env` and validate here.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env: EnvConfig = options.env ?? parseEnv(options.rawEnv ?? process.env);
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
