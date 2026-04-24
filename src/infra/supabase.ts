/**
 * Supabase client singleton for wasiai-facilitator.
 *
 * WFAC-32 — Settlement Ledger (fire-and-forget persistence).
 *
 * Design (analogous to `src/infra/redis.ts`):
 *   - Module-level singleton. NO class, NO factory pattern.
 *   - `initSupabase(env, logger)` is called once by `buildApp()`; idempotent.
 *   - `getSupabaseClient()` creates the client lazily on first call.
 *   - Returns `SupabaseClient | null`:
 *     * `SupabaseClient` when both SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
 *     * `null` otherwise → ledger becomes a no-op (AC-4 / AC-7).
 *
 * Boundaries (OWNERS.md):
 *   - Imports: `@supabase/supabase-js` (runtime, named), `pino` (type-only),
 *     `./env.js` (type-only).
 *   - Must NOT import from `src/core/*`, `src/chains/*`, `src/methods/*`,
 *     `src/routes/*`, `src/middleware/*`.
 *
 * Security:
 *   - SUPABASE_SERVICE_KEY is a service-role token; never log it raw.
 *     `redactSupabaseKey()` is the ONLY sanctioned way to expose it in logs.
 *     (CD-2)
 *
 * Lifecycle:
 *   - The Supabase client is HTTP-based (no persistent TCP). No `onClose` hook
 *     is registered in `src/app.ts`. (CD-15)
 */

// CD-12: named import of both the factory and the type. Do NOT use a default
// or namespace import — Supabase-js v2 exposes only named exports.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { EnvConfig } from './env.js';

/**
 * Minimal logger surface used by this module. Declared as `Pick<Logger, ...>`
 * so callers can pass either a Pino Logger or a FastifyBaseLogger without a
 * cast.
 */
export type SupabaseLogger = Pick<Logger, 'info' | 'error' | 'warn' | 'debug'>;

// ─── module state ──────────────────────────────────────────────────────────
let _client: SupabaseClient | null = null;
let _env: EnvConfig | null = null;
let _logger: SupabaseLogger | null = null;
let _initialized = false;

/**
 * Initialize the Supabase singleton's dependencies (env + logger).
 *
 * Idempotent. Does NOT create the Supabase client — that happens lazily on
 * the first `getSupabaseClient()` call.
 *
 * Logs once:
 *   - "Supabase client configured" (info) when both env vars are present.
 *   - "Supabase client not configured — ledger disabled" (warn) otherwise.
 *     (AC-4)
 */
export function initSupabase(env: EnvConfig, logger: SupabaseLogger): void {
  if (_initialized && _env === env && _logger === logger) {
    return; // idempotent
  }
  _env = env;
  _logger = logger;
  _initialized = true;

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  if (url && key) {
    // `url` is Zod-validated (`z.string().url()`) — `new URL(url)` cannot
    // throw here, so no defensive fallback is needed.
    const hostname = new URL(url).hostname || url;
    logger.info(
      { url: hostname, keyPreview: redactSupabaseKey(key) },
      'Supabase client configured',
    );
  } else {
    logger.warn(
      { hasUrl: Boolean(url), hasKey: Boolean(key) },
      'Supabase client not configured — ledger disabled',
    );
  }
}

/**
 * Returns the singleton Supabase client, creating it on first call.
 *
 * Returns `null` if:
 *   - `initSupabase` was never called, OR
 *   - `SUPABASE_URL` is undefined/empty, OR
 *   - `SUPABASE_SERVICE_KEY` is undefined/empty.
 *
 * In those cases the caller (e.g. `persistLedgerEntry`) MUST treat the absence
 * as a no-op. (AC-4 / AC-7)
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!_initialized || _env === null || _logger === null) {
    return null;
  }

  const url = _env.SUPABASE_URL;
  const key = _env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return null;
  }

  if (_client) return _client;

  const logger = _logger;

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // `url` is Zod-validated (`z.string().url()`) at parseEnv — `new URL(url)`
  // cannot throw here. Defensive hostname extraction is redundant; log the
  // already-validated URL structure (same hostname-only payload as init).
  const hostname = new URL(url).hostname || url;
  logger.info({ url: hostname }, 'Supabase client instantiated');

  return _client;
}

/**
 * Redact a service-role key for safe logging.
 *
 * CD-2: This function is the ONLY sanctioned way to prepare
 * `SUPABASE_SERVICE_KEY` for logs. Never log the raw value.
 *
 * Behaviour:
 *   - Keys of length >= 12: first 8 chars + U+2026 + last 4 chars.
 *   - Keys of length < 12 (or non-string): return literal `sb_***`.
 */
export function redactSupabaseKey(raw: string): string {
  if (typeof raw !== 'string' || raw.length < 12) {
    return 'sb_***';
  }
  return `${raw.slice(0, 8)}…${raw.slice(-4)}`;
}

/**
 * Reset the singleton for tests. DO NOT CALL IN PRODUCTION CODE.
 *
 * Vitest pattern: call this in `beforeEach` to ensure each test gets a fresh
 * mocked instance. (CD-8)
 */
export function resetSupabaseClientForTests(): void {
  _client = null;
  _env = null;
  _logger = null;
  _initialized = false;
}
