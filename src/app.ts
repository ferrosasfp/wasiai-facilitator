import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { DestinationStream, Logger } from 'pino';
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
import { initChainBreakers } from './chains/init-breakers.js';
import { initDomainCheck } from './chains/init-domain-check.js';
// Side-effect import: registers built-in chain adapters (kite, avalanche) in chainRegistry.
// MUST be imported at app bootstrap — without this, chainRegistry stays empty and
// GET /supported returns { chains: [], methods: [] }.
import './chains/index.js';

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

/**
 * WFAC-AUDIT AC-2 — coerce the raw TRUST_PROXY env string into the value
 * Fastify's `trustProxy` option accepts:
 *   'false'/'true' → boolean; numeric string → number (hop count); other → string.
 */
function parseTrustProxy(raw: string): boolean | number | string {
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : raw;
}

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
  /**
   * WFAC-53 FIX-2 — opt-out flag for tests that build the app without
   * configuring chain adapters with real RPC mocks. When true, the
   * DOMAIN_SEPARATOR() boot-time drift check is skipped entirely.
   *
   * Default `false`: production code path always runs the check.
   * Test files that register fake adapters without `readContract` mock
   * MUST set this to true to avoid spurious warn/fatal logs (CD-16).
   */
  skipDomainCheck?: boolean;
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY), // WFAC-AUDIT AC-2 — ANTES del rate-limit (CD-5)
  });

  app.decorate('env', env);

  // Security headers (helmet) — HSTS, X-Content-Type-Options, X-Frame-Options, etc.
  // Disabling CSP because this is a JSON-only API (no HTML served).
  // Registered FIRST so headers apply to all responses including errors.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // WFAC-53 FIX-1 — CORS origin policy.
  //   - CORS_ALLOWED_ORIGINS absent or empty → origin: true (legacy permissive
  //     — reflects any Origin so wasiai-a2a / wasiai-v2 dev keeps working).
  //   - CORS_ALLOWED_ORIGINS = "https://a,https://b" → callback whitelist;
  //     non-whitelisted origins get 403 with no Access-Control-Allow-Origin.
  // CD-11: manual CSV parse (split + trim + filter), NO Zod transform.
  const corsAllowedOrigins: readonly string[] = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const corsOriginPolicy:
    | true
    | ((origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => void) =
    corsAllowedOrigins.length === 0
      ? true
      : (origin, cb) => {
          // CORS spec: same-origin requests have no Origin header → reflect (cb true).
          if (!origin) {
            cb(null, true);
            return;
          }
          if (corsAllowedOrigins.includes(origin)) {
            cb(null, true);
            return;
          }
          cb(null, false); // @fastify/cors emits 403 + omits ACAO header
        };

  await app.register(cors, {
    origin: corsOriginPolicy,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  });

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

  // WFAC-41 — inject the app logger into per-chain circuit breakers so state
  // transitions emit structured warn logs. Ducktype over adapter.setLogger;
  // adapters without a breaker (stubs, future adapters) silently skip. MUST
  // run AFTER adapter registration (registry populated via eager imports
  // from src/core/supported.ts and friends) and BEFORE routes start serving.
  // Cast: FastifyBaseLogger is structurally compatible with pino.Logger at
  // runtime; the missing `msgPrefix` field is an unused pino internal.
  initChainBreakers(app.log as unknown as Logger);

  // WFAC-53 FIX-2 — boot-time DOMAIN_SEPARATOR() drift assertion (DT-I, CD-14).
  // Test-only opt-out via skipDomainCheck (CD-16). Production path always runs.
  // Cast pattern matches initChainBreakers above (AB-WFAC-41-3).
  if (!options.skipDomainCheck) {
    await initDomainCheck(app.log as unknown as Logger);
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
