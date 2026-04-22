import pino, {
  type Logger,
  type LoggerOptions,
  type DestinationStream,
} from 'pino';
import type { EnvConfig } from './env.js';

/**
 * Create a Pino logger configured from EnvConfig.
 *
 * - development: uses `pino-pretty` transport (human-readable, ANSI colors).
 * - test | production: plain JSON output, no transport.
 *
 * An optional `destination` stream may be injected (used by tests to capture
 * log output). When provided, the transport option is IGNORED — that is the
 * pino API contract (options + stream signature).
 *
 * CD-11: the returned instance is what Fastify receives as `loggerInstance`.
 */
export function createLogger(
  env: EnvConfig,
  destination?: DestinationStream,
): Logger {
  const baseOptions: LoggerOptions = { level: env.LOG_LEVEL };

  if (destination) {
    return pino(baseOptions, destination);
  }

  if (env.NODE_ENV === 'development') {
    return pino({
      ...baseOptions,
      transport: { target: 'pino-pretty' },
    });
  }

  // test | production → JSON puro (stdout default de Pino).
  return pino(baseOptions);
}
