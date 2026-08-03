import pino, { type Logger, type LoggerOptions, type DestinationStream, type LogFn } from 'pino';
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
  // WKH-217 / HU-SOL-14 — Solana fee-payer signing key (AC-10).
  //
  // SDD 037: acá había dos entradas más, el secreto compartido del patrocinio y
  // la prueba HMAC que viajaba en el body. Las dos se fueron con el mecanismo,
  // que está BORRADO del repo. Su reemplazo, `popSignature`, NO se agrega a esta
  // lista: es una firma ed25519 sobre un mensaje público, y redactarla sugeriría
  // que es un secreto — justo la confusión que esta HU vino a sacar del medio.
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'feePayerPrivateKey',
  // WKH-302 — Solana payout-operator signing key (the facilitator's treasury key).
  // Same criterion as SOLANA_FEE_PAYER_PRIVATE_KEY: `redact` matches EXACT field
  // keys, so the generic 'secret' entry below does NOT cover this name.
  'SOLANA_PAYOUT_OPERATOR_SECRET_KEY',
  'payoutOperatorSecretKey',
  'partialSignedTx',
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
 * OP-11 (audit) — free-text hex-secret scrubber.
 *
 * `redact.paths` only masks STRUCTURED object keys; it cannot touch a secret
 * that leaks inside a FREE-TEXT message string (e.g. a viem/RPC error whose
 * `.message` embedded an operator key, a signature, or a 32-byte nonce). This
 * regex matches a `0x` + 64 hex-char blob (a 32-byte value — private key,
 * EIP-712 signature half, nonce, hash) anywhere in a plain string and replaces
 * it with `[Redacted-hex]`.
 *
 * SCOPE: applied ONLY to free-text STRING arguments passed to a log call (the
 * `msg` and any string interpolation args) via the pino `logMethod` hook —
 * NOT to structured fields. This is deliberate: structured `tx_hash` is public
 * on-chain data we intentionally log; the risk is a 64-hex blob smuggled into
 * an unstructured error message.
 *
 * `g` + case-insensitive so multiple occurrences and mixed-case hex are caught.
 */
const HEX_SECRET_RE = /0x[0-9a-fA-F]{64}/g;

/** Replace every 64-hex blob in a free-text string with `[Redacted-hex]`. */
export function scrubHexSecrets(text: string): string {
  return text.replace(HEX_SECRET_RE, '[Redacted-hex]');
}

/**
 * pino `logMethod` hook: scrub free-text STRING arguments before they are
 * serialized. The first arg may be a merge OBJECT (left untouched here — it is
 * handled by `redact.paths`) or a string message; any subsequent string args
 * are interpolation params. We only rewrite string args.
 */
function scrubbingLogMethod(
  this: Logger,
  args: Parameters<LogFn>,
  method: LogFn,
  _level: number,
): void {
  const scrubbed = args.map((a) =>
    typeof a === 'string' && a.includes('0x') ? scrubHexSecrets(a) : a,
  ) as Parameters<LogFn>;
  method.apply(this, scrubbed);
}

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
    // OP-11 — scrub 0x+64hex blobs from free-text message strings (the
    // structured-field redaction above cannot reach unstructured messages).
    hooks: {
      logMethod: scrubbingLogMethod,
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
