import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyPluginAsync,
  type FastifyRequest,
} from 'fastify';
import rateLimit, { type errorResponseBuilderContext } from '@fastify/rate-limit';
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
import { metricsRoute } from './routes/metrics.js';
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
const AUDIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/openapi.json',
  '/metrics',
]);

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

/**
 * BLQ-MED-1 — shared 429 error body builder for BOTH rate-limit layers
 * (Layer 1 global per-IP, Layer 2 per-key). Extracted so the two registrations
 * emit the identical spec-literal body + PII-free warn log.
 *
 * @fastify/rate-limit `throw`s the returned object; Fastify's default error
 * handler reads `statusCode` from the thrown error to set the HTTP code and
 * then serializes the remaining ENUMERABLE fields as the JSON body
 * (see fastify/lib/error-handler.js).
 *
 * We attach `statusCode: 429` as a NON-enumerable property so Fastify uses it
 * but it is NOT emitted in the body (CD-3: body must have exactly 3 keys —
 * code/message/http). The body itself is `{ error: { code, message, http } }`
 * verbatim (CD-10).
 */
function rateLimitErrorResponseBuilder(
  req: FastifyRequest,
  context: errorResponseBuilderContext,
): object {
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
}

/**
 * BLQ-MED-1 — encapsulated plugin that registers the money-path routes
 * (/verify, /settle) together with Layer 2 (per-key) rate-limiting.
 *
 * Layer 2 is a SECOND @fastify/rate-limit registration. Because it lives in
 * this encapsulated scope and is a distinct registration, it has its OWN store
 * and its OWN per-request `rateLimitRan` guard — so it runs IN ADDITION TO the
 * global Layer 1 (per-IP onRequest), not instead of it. It uses the
 * `preHandler` phase so it executes AFTER `requireFacilitatorKey` has stamped
 * `req.facilitatorKeyId`, bucketing per authenticated caller key.
 *
 * The per-route `config.rateLimit` on /verify and /settle is consumed by BOTH
 * registrations' onRoute hooks: Layer 1 applies it at onRequest keyed per-IP,
 * Layer 2 applies it at preHandler keyed per-key. The per-IP ceiling is always
 * enforced first; Layer 2 only ever ADDS a per-key bound (defense-in-depth).
 *
 * When RATE_LIMIT_ENABLED=false, Layer 2 is NOT registered (mirrors Layer 1) —
 * the routes still register, with zero rate-limit overhead.
 */
function registerMoneyPathRoutes(env: EnvConfig): FastifyPluginAsync {
  return async (scope) => {
    if (env.RATE_LIMIT_ENABLED) {
      const redisClient = getRedisClient();
      await scope.register(rateLimit, {
        global: true,
        // BLQ-MED-1 Layer 2: post-auth phase so `req.facilitatorKeyId` is set.
        hook: 'preHandler',
        max: env.RATE_LIMIT_VERIFY_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        skipOnError: env.RATE_LIMIT_FAIL_OPEN,
        redis: redisClient ?? undefined,
        // Per-key bucket: `facilitatorKeyId` is a NON-SECRET sha256 prefix
        // stamped by requireFacilitatorKey on a successful match (never the raw
        // key, never logged). Distinct keys behind the same IP get independent
        // budgets. Requests with no key (key-bypass test mode) fall back to a
        // per-IP bucket — harmless, since Layer 1 already bounds per-IP.
        keyGenerator: (req) => {
          const keyId = req.facilitatorKeyId;
          if (keyId) return `k:${keyId}`;
          return extractClientIp(req) ?? req.ip ?? 'unknown';
        },
        enableDraftSpec: false,
        errorResponseBuilder: rateLimitErrorResponseBuilder,
      });
    }
    await scope.register(verifyRoute);
    await scope.register(settleRoute);
  };
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

  // AUDIT — production hardening startup warnings. Loud, structured warns when
  // the service boots in production with a less-secure-than-recommended config.
  // These do NOT change behavior (no fail-fast) — they surface drift from the
  // recommended posture in logs/alerts without breaking existing deployments.
  if (env.NODE_ENV === 'production') {
    if (env.SETTLE_CAP_FAIL_MODE === 'open') {
      logger.warn(
        { setting: 'SETTLE_CAP_FAIL_MODE', value: 'open' },
        'NOTICE: daily settle cap is FAIL-OPEN (active default) in production — ' +
          'a Redis outage allows unbounded settlements (operator wallet drain ' +
          'risk). This is the SAFE default while Redis is single-instance: ' +
          'fail-closed would reject ALL settlements on a Redis blip (see the ' +
          '2026-06-29 outage). Only set SETTLE_CAP_FAIL_MODE=closed once Redis ' +
          'is HA.',
      );
    }
    if (env.RATE_LIMIT_ENABLED && env.RATE_LIMIT_FAIL_OPEN) {
      logger.warn(
        { setting: 'RATE_LIMIT_FAIL_OPEN', value: true },
        'SECURITY: rate limiting is FAIL-OPEN in production — a Redis outage ' +
          'disables per-IP/per-key limits. Set RATE_LIMIT_FAIL_OPEN=false for ' +
          'strict enforcement (requires Redis HA).',
      );
    }
    if (!env.CORS_ALLOWED_ORIGINS || env.CORS_ALLOWED_ORIGINS.trim().length === 0) {
      logger.warn(
        { setting: 'CORS_ALLOWED_ORIGINS', value: '(unset)' },
        'SECURITY: CORS_ALLOWED_ORIGINS is unset in production — CORS reflects ' +
          'ANY origin (permissive). Set an explicit allow-list, e.g. ' +
          'CORS_ALLOWED_ORIGINS=https://app.wasiai.io,https://wasiai.io.',
      );
    }
  }

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
  //
  // BLQ-MED-1 (audit fix-pack) — TWO independent rate-limit layers:
  //
  //   Layer 1 (GLOBAL, `onRequest`, PER-IP): registered here. Runs in the
  //     `onRequest` phase, BEFORE any route's auth preHandler. This restores
  //     the pre-auth throttling that protects the money-path routes from
  //     unauthenticated/wrong-bearer floods (matches `main` behavior — repeated
  //     bad-bearer requests to /settle and /verify eventually get 429, not
  //     unbounded 401s). It buckets purely by client IP, so it covers requests
  //     that never authenticate (the auth preHandler short-circuits with 401
  //     AFTER this hook has already counted the request).
  //
  //   Layer 2 (PER-KEY, `preHandler`, AFTER auth): a SEPARATE rate-limit
  //     registration scoped to /settle + /verify (see registerMoneyPathRoutes
  //     below). It runs AFTER `requireFacilitatorKey` stamps
  //     `req.facilitatorKeyId`, so it buckets per authenticated caller key —
  //     the additional hardening the audit asked for (one caller's key cannot
  //     exhaust another's allowance behind a shared NAT'd IP). Layer 2 NEVER
  //     weakens Layer 1: the per-IP ceiling is always enforced first.
  //
  // A single @fastify/rate-limit registration only adds ONE hook per route
  // (its `onRoute` hook installs the global OR the per-route config hook, never
  // both), and a per-request `rateLimitRan` guard prevents a second hook from
  // the SAME registration running twice. Two layers therefore REQUIRE two
  // registrations, each with its own store + `rateLimitRan` symbol.
  if (env.RATE_LIMIT_ENABLED) {
    const redisClient = getRedisClient();
    await app.register(rateLimit, {
      global: true,
      // BLQ-MED-1: default `onRequest` phase (NOT `preHandler`). This is the
      // pre-auth per-IP guard — it MUST run before route auth so unauthenticated
      // floods are throttled (the regression this fix closes).
      // Defensive fallback caps — the 3 public routes (and the money-path
      // routes) OVERRIDE `max` via per-route config.rateLimit. Any future route
      // without a config inherits these.
      max: env.RATE_LIMIT_VERIFY_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
      // DT-10 + AUDIT: fail-open on Redis runtime outage is now env-configurable
      // via RATE_LIMIT_FAIL_OPEN (default true = legacy behavior). When true,
      // an incr() rejection lets the request through. Set 'false' for strict
      // enforcement (only with Redis HA — see SECURITY.md). NOT flipped to
      // false by default: a transient blip must not hard-break the service.
      skipOnError: env.RATE_LIMIT_FAIL_OPEN,
      // DT-9 + DT-10 boot-time: when getRedisClient() returns null
      // (test env, REDIS_URL absent), pass undefined → plugin falls
      // back to LocalStore (in-memory) without crashing.
      redis: redisClient ?? undefined,
      // DT-8: reuse the centralized extractor. Defensive `?? req.ip ??
      // 'unknown'` fallback ensures the plugin always has a key.
      // BLQ-MED-1: PURE per-IP. `facilitatorKeyId` is NOT read here — this hook
      // runs in `onRequest`, BEFORE auth, so the key is not yet known. Per-key
      // bucketing lives exclusively in Layer 2 (which runs post-auth).
      keyGenerator: (req) => extractClientIp(req) ?? req.ip ?? 'unknown',
      // DT-12: default headers (X-RateLimit-*). Draft-spec variant
      // (RateLimit-*) not used — work-item AC-5 cites X- prefixed names.
      enableDraftSpec: false,
      errorResponseBuilder: rateLimitErrorResponseBuilder,
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
  // BLQ-MED-1 — money-path routes (/verify, /settle) are registered inside an
  // encapsulated scope that ALSO registers Layer 2 (per-key) rate-limiting.
  // Encapsulation is required: Layer 2 must be a SEPARATE @fastify/rate-limit
  // registration (own store + `rateLimitRan` symbol) so it runs IN ADDITION TO
  // the global Layer 1 (per-IP onRequest) — not instead of it.
  await app.register(registerMoneyPathRoutes(env));
  await app.register(supportedRoute);
  await app.register(openapiRoute);
  // OP-05 — Prometheus scrape endpoint (exposes prom-client default registry).
  await app.register(metricsRoute);

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
