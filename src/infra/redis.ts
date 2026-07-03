/**
 * Redis client singleton for wasiai-facilitator.
 *
 * WFAC-5 — Idempotency Cache Foundation.
 *
 * Design:
 *   - Module-level singleton (DT-1). NO class, NO factory pattern.
 *   - `initRedis(env, logger)` is called once by `buildApp()`; it is idempotent.
 *   - `getRedisClient()` creates the ioredis instance lazily on first call.
 *   - Returns `Redis | null`:
 *     * `Redis`  in dev/prod (or test with REDIS_URL set)
 *     * `null`   in test env with no REDIS_URL → callers fall back to in-memory
 *
 * Boundaries (OWNERS.md):
 *   - Imports: `ioredis` (runtime), `pino` (type-only), `./env.js` (type-only).
 *   - Must NOT import from `src/core/*`, `src/chains/*`, `src/methods/*`,
 *     `src/routes/*`, `src/middleware/*`.
 *
 * Lifecycle:
 *   - Client is created with `lazyConnect: true` — no TCP I/O on construction.
 *   - Event handlers for 'connect' and 'error' are registered immediately.
 *   - Shutdown: `buildApp()` registers a Fastify `onClose` hook that calls
 *     `client.quit()` (NOT `disconnect()`) before `app.close()` resolves.
 *
 * Security:
 *   - REDIS_URL may contain a password (redis://user:pass@host:port/db).
 *   - `redactRedisUrl()` is ALWAYS called before any log output. Never log
 *     `env.REDIS_URL` directly.
 */

// Under `module: "Node16"` + `esModuleInterop: true`, importing ioredis (which
// is CJS with `module.exports = require("./Redis").default` + a separate
// `default` property) via `import Redis from 'ioredis'` resolves `Redis` to the
// CJS module namespace, not the class. The named import below re-exports the
// same class (`export { default as Redis } from './Redis'` in ioredis
// index.d.ts) and works correctly in both type and runtime positions.
import { Redis } from 'ioredis';
import type { EnvConfig } from './env.js';
import type { Logger } from 'pino';

/**
 * Minimal logger surface used by this module. Declared as `Pick<Logger, ...>`
 * so callers can pass either a Pino Logger or a FastifyBaseLogger without a
 * cast (both satisfy this shape structurally).
 */
export type RedisLogger = Pick<Logger, 'info' | 'error' | 'warn'>;

// ─── module state ──────────────────────────────────────────────────────────
let _client: Redis | null = null;
let _env: EnvConfig | null = null;
let _logger: RedisLogger | null = null;
let _initialized = false;

/**
 * Initialize the Redis singleton's dependencies (env + logger).
 *
 * Called ONCE from `buildApp()`. Subsequent calls with the same env are no-ops.
 *
 * Does NOT create the ioredis instance — that happens lazily on the first
 * `getRedisClient()` call.
 */
export function initRedis(env: EnvConfig, logger: RedisLogger): void {
  if (_initialized && _env === env && _logger === logger) {
    return; // idempotent
  }
  _env = env;
  _logger = logger;
  _initialized = true;
}

/**
 * Returns the singleton ioredis client, creating it on first call.
 *
 * Returns `null` if:
 *   - `initRedis` was never called, OR
 *   - `NODE_ENV === 'test'` AND `REDIS_URL` is undefined.
 *
 * In production, an invalid REDIS_URL is not expected (parseEnv rejects before
 * boot). But if it happens anyway, the error is caught by the `'error'`
 * handler and logged; the process does not crash.
 */
export function getRedisClient(): Redis | null {
  if (!_initialized || _env === null || _logger === null) {
    // initRedis was never called — refuse to auto-create.
    return null;
  }
  if (_client) return _client;

  const url = _env.REDIS_URL;
  if (!url) {
    // Test env path — caller must handle null (in-memory fallback).
    return null;
  }

  const logger = _logger;

  const client = new Redis(url, {
    // Railway private networking (`*.railway.internal`) is IPv6-only. ioredis
    // defaults to `family: 4` (IPv4-only DNS lookup), so the initial connect may
    // resolve by luck but reconnections/subsequent lookups fail → the client
    // drifts to `unreachable`. `family: 0` enables dual-stack DNS lookup (IPv4
    // AND IPv6), resolving the IPv6 host consistently, including on reconnect.
    family: 0,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    db: _env.REDIS_DB,
    connectionName: 'wasiai-facilitator',
    retryStrategy: redisRetryStrategy,
  });

  // CD-4: register error handler IMMEDIATELY after construction.
  client.on('error', (err: Error) => {
    logger.error({ err }, 'Redis error');
  });

  client.on('connect', () => {
    const { host, port } = parseHostPort(url);
    logger.info({ host, port }, 'Redis connected');
  });

  logger.info({ url: redactRedisUrl(url), db: _env.REDIS_DB }, 'Redis client instantiated');

  _client = client;
  return _client;
}

/**
 * Exponential backoff retry strategy for ioredis (AC-9).
 *
 *   times=0  → 100ms
 *   times=1  → 200ms
 *   times=2  → 400ms
 *   times=3  → 800ms
 *   times=4  → 1600ms
 *   times=5+ → 3000ms (capped)
 *   times>10 → null (give up; ioredis emits final 'error' event)
 */
export function redisRetryStrategy(times: number): number | null {
  if (times > 10) return null;
  return Math.min(100 * 2 ** times, 3000);
}

/**
 * Redact the password (and username, if any) from a Redis URL before logging.
 *
 * Examples:
 *   'redis://host:6379/0'                     → 'redis://host:6379/0'
 *   'redis://:pass@host:6379/0'               → 'redis://:*@host:6379/0'
 *   'redis://user:pass@host:6379/0'           → 'redis://*:*@host:6379/0'
 *   'not-a-url'                               → 'redis://***'
 *
 * CD-1: This function is the ONLY sanctioned way to prepare a REDIS_URL for logs.
 */
export function redactRedisUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '*';
    if (u.username) u.username = '*';
    return u.toString();
  } catch {
    return 'redis://***';
  }
}

/**
 * Parse host:port from a Redis URL for structured logging (AC-7).
 * Falls back to `unknown`/`0` if the URL is malformed.
 */
function parseHostPort(raw: string): { host: string; port: number } {
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || 'unknown',
      port: u.port ? Number(u.port) : 6379,
    };
  } catch {
    return { host: 'unknown', port: 0 };
  }
}

/**
 * Reset the singleton for tests. DO NOT CALL IN PRODUCTION CODE.
 *
 * Vitest pattern: call this in `beforeEach` to ensure each test gets a fresh
 * mocked instance.
 */
export function resetRedisClientForTests(): void {
  _client = null;
  _env = null;
  _logger = null;
  _initialized = false;
}
