import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { DestinationStream } from 'pino';
import { parseEnv, type EnvConfig } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { initRedis, getRedisClient } from './infra/redis.js';
import { initSupabase } from './infra/supabase.js';
import { buildAuditEntry, persistAuditEntry } from './core/audit.js';
import { extractClientIp } from './core/network.js';
import { healthRoute } from './routes/health.js';
import { verifyRoute } from './routes/verify.js';
import { settleRoute } from './routes/settle.js';
import { supportedRoute } from './routes/supported.js';
import { openapiRoute } from './routes/openapi.js';

/**
 * WFAC-40 — expose the parsed EnvConfig to route plugins via decorator.
 * Consumed by `verify.ts`, `settle.ts`, `supported.ts` to read per-route
 * rate-limit caps without changing plugin signatures (DT-13 in SDD).
 */
declare module 'fastify' {
  interface FastifyInstance {
    env: EnvConfig;
  }
}

/**
 * Paths excluded from the audit hook (WFAC-33 DT-11 — blacklist pattern).
 * Uses `request.routeOptions.url` for exact match (query string is stripped —
 * CD-12). Any new public route is audited by default unless added here.
 */
const AUDIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set(['/health', '/openapi.json']);

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

  // WFAC-5: initialize Redis singleton with env + logger. Idempotent; creates
  // no TCP connection (lazyConnect: true). The actual ioredis instance is
  // created lazily on the first getRedisClient() call by consumers.
  initRedis(env, logger);

  // WFAC-32: initialize Supabase singleton (ledger). Synchronous — the HTTP
  // client is created lazily on the first getSupabaseClient() call. CD-15:
  // NO onClose hook — the Supabase client is HTTP-based (no persistent TCP).
  initSupabase(env, logger);

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  });

  app.decorate('env', env);

  // WFAC-40 — rate-limit plugin (DT-5 SDD: BEFORE route registration
  // so the plugin's onRoute hook reads per-route config.rateLimit).
  // Conditional registration (DT-14): when RATE_LIMIT_ENABLED=false,
  // the plugin is NOT registered → zero-overhead global bypass (AC-6).
  if (env.RATE_LIMIT_ENABLED) {
    const redisClient = getRedisClient();
    await app.register(rateLimit, {
      global: true,
      // Defensive fallback caps — the 3 public routes OVERRIDE these via
      // per-route config.rateLimit in W2. Any future route without a
      // config inherits these.
      max: env.RATE_LIMIT_VERIFY_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
      // DT-10: fail-open on Redis runtime outage. If the incr() call on
      // the store rejects, the plugin lets the request through.
      skipOnError: true,
      // DT-9 + DT-10 boot-time: when getRedisClient() returns null
      // (test env, REDIS_URL absent), pass undefined → plugin falls
      // back to LocalStore (in-memory) without crashing.
      redis: redisClient ?? undefined,
      // DT-8: reuse the centralized extractor. Defensive `?? req.ip ??
      // 'unknown'` fallback ensures the plugin always has a key.
      keyGenerator: (req) => extractClientIp(req) ?? req.ip ?? 'unknown',
      // DT-12: default headers (X-RateLimit-*). Draft-spec variant
      // (RateLimit-*) not used — work-item AC-5 cites X- prefixed names.
      enableDraftSpec: false,
      // DT-7 + DT-11: spec-literal body + warn log without PII (CD-3, CD-4).
      // @fastify/rate-limit `throw`s the returned object; Fastify's default
      // error handler reads `statusCode` from the thrown error to set the
      // HTTP code and then serializes the remaining enumerable fields as
      // the JSON body (see fastify/lib/error-handler.js:163,100).
      //
      // We need:
      //   - HTTP 429  → attach `statusCode: 429` as a NON-enumerable property
      //                 so it's used by Fastify but NOT emitted in the body
      //                 (CD-3: body must have exactly 3 keys — code/message/http).
      //   - body      → `{ error: { code, message, http } }` verbatim (CD-10).
      //
      // Using Object.defineProperty to make `statusCode` non-enumerable keeps
      // the JSON shape clean while still honouring the Fastify error contract.
      errorResponseBuilder: (req, context) => {
        req.log.warn(
          {
            request_id: req.id,
            path: req.routeOptions?.url ?? req.url,
            rate_limit_max: context.max,
            rate_limit_ttl_ms: context.ttl,
          },
          'rate limit exceeded',
        );
        const body = {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests, please try again later',
            http: 429,
          },
        };
        Object.defineProperty(body, 'statusCode', {
          value: 429,
          enumerable: false,
          writable: false,
          configurable: false,
        });
        return body;
      },
    });
  }

  await app.register(healthRoute);
  await app.register(verifyRoute);
  await app.register(settleRoute);
  await app.register(supportedRoute);
  await app.register(openapiRoute);

  // WFAC-33 — audit log onResponse hook (global).
  // Fires AFTER the response is flushed to the client (Fastify v5 guarantees
  // this); the await below does NOT add observable latency (AC-9).
  // Filters /health and /openapi.json via AUDIT_EXCLUDED_PATHS (AC-2, CD-6).
  // Reads optional request.auditMeta populated by route handlers before
  // reply.send (DT-9, DT-10, CD-11).
  app.addHook('onResponse', async (request, reply) => {
    const routePath = request.routeOptions.url;
    if (!routePath || AUDIT_EXCLUDED_PATHS.has(routePath)) return;

    // WFAC-40 CD-9 — proxy-aware IP extraction (DT-2, DT-8 SDD).
    // The XFF-first logic lives EXCLUSIVELY in src/core/network.ts.
    const ipRaw = extractClientIp(request);

    const uaHeader = request.headers['user-agent'];
    const userAgentRaw = typeof uaHeader === 'string' && uaHeader.length > 0 ? uaHeader : null;

    const meta = request.auditMeta;
    const entry = buildAuditEntry({
      requestId: request.id,
      method: request.method,
      path: routePath,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ipRaw,
      userAgentRaw,
      ...(meta?.errorCode !== undefined ? { errorCode: meta.errorCode } : {}),
      ...(meta?.idempotencyKey !== undefined ? { idempotencyKey: meta.idempotencyKey } : {}),
    });

    // CD-14: await (hook already runs post-flush — no user-facing latency).
    // NO .catch(), NO void — the full error pipeline inside persistAuditEntry
    // must complete before the request is GC'd.
    await persistAuditEntry(entry, app.log);
  });

  // WFAC-5 AC-10/AC-11: quit Redis client during graceful shutdown. Fastify
  // v5 runs onClose hooks before app.close() resolves. Null-guard for test env
  // (getRedisClient may return null when REDIS_URL is undefined).
  app.addHook('onClose', async () => {
    const client = getRedisClient();
    if (!client) return;
    try {
      await client.quit();
    } catch (err: unknown) {
      logger.error({ err }, 'Redis quit failed during shutdown');
    }
  });

  return app;
}
