import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import type { EnvConfig } from './env.js';

/**
 * Pino redaction paths (audit hardening — SECURITY.md "Secret handling").
 *
 * The facilitator holds the operator SIGNING KEY and a caller API key. If any
 * secret-bearing field is ever included in a logged object (now or by a future
 * code change), pino replaces its value with `[Redacted]` BEFORE serialization,
 * so the secret never reaches stdout / the log aggregator.
 *
 * Path syntax (pino docs):
 *   - `foo.bar`        — exact nested path.
 *   - `*.bar`          — `bar` at depth 1 under any key.
 *   - `foo[*].bar`     — array elements.
 *   - bracket notation — required for keys containing special chars
 *                        (e.g. `headers["set-cookie"]`).
 *
 * We redact BOTH top-level and one-level-nested (`*.<field>`) occurrences,
 * plus the common request/response header carriers, because structured logs
 * frequently nest secrets under `err`, `req`, `config`, `payload`, etc.
 *
 * `censor: '[Redacted]'` is the explicit replacement; `remove: false` keeps the
 * key present (so log shape is stable and the redaction is observable).
 */
const REDACT_FIELDS: readonly string[] = [
  // Operator signing key + any private-key shaped field.
  'privateKey',
  'private_key',
  'operatorPrivateKey',
  'OPERATOR_PRIVATE_KEY',
  // Caller / service credentials.
  'apiKey',
  'api_key',
  'facilitatorApiKey',
  'FACILITATOR_API_KEY',
  'serviceKey',
  'service_key',
  'SUPABASE_SERVICE_KEY',
  'secret',
  'token',
  'password',
  // x402 signature material (an EIP-3009 signature is not a secret per se, but
  // we avoid logging raw signatures as a defensive default — SECURITY.md:114).
  'signature',
  'nonce',
  // Authorization headers (bearer FACILITATOR_API_KEY travels here).
  'authorization',
  'Authorization',
  'cookie',
  'set-cookie',
];

/**
 * Build the full redact path list: each field at the top level AND one level
 * deep under any key (`*.<field>`), plus header carriers under `req`/`res`.
 */
function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const f of REDACT_FIELDS) {
    paths.push(f);
    paths.push(`*.${f}`);
  }
  // Common header carriers (Fastify's auto request/response logging).
  paths.push('req.headers.authorization');
  paths.push('req.headers.Authorization');
  paths.push('req.headers.cookie');
  paths.push('res.headers["set-cookie"]');
  paths.push('headers.authorization');
  paths.push('headers.Authorization');
  paths.push('headers.cookie');
  return paths;
}

const REDACT_PATHS: readonly string[] = buildRedactPaths();

/**
 * Create a Pino logger configured from EnvConfig.
 *
 * - development: uses `pino-pretty` transport (human-readable, ANSI colors).
 * - test | production: plain JSON output, no transport.
 *
 * Secret redaction (audit hardening): pino's `redact` option replaces any
 * secret-bearing field with `[Redacted]` before output. Applied in EVERY mode
 * (dev/test/prod) so a secret can never leak via a logged object.
 *
 * An optional `destination` stream may be injected (used by tests to capture
 * log output). When provided, the transport option is IGNORED — that is the
 * pino API contract (options + stream signature).
 *
 * CD-11: the returned instance is what Fastify receives as `loggerInstance`.
 */
export function createLogger(env: EnvConfig, destination?: DestinationStream): Logger {
  const baseOptions: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[Redacted]',
    },
  };

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
