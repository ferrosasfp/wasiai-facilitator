import { z } from 'zod';

/**
 * Environment variables schema.
 *
 * CD-2: PORT default 3002 is declared here (the only source-of-truth literal).
 * CD-8: validation fails FAST in `parseEnv` before anything else bootstraps.
 *
 * REDIS_URL: required in development/production. Optional when NODE_ENV === 'test'
 *            (tests must not require a live Redis instance — see WFAC-5 AC-3).
 * REDIS_DB:  optional Redis logical database index (0-15). Default 0.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),
    REDIS_URL: z.string().min(1).optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    // Supabase (WFAC-32): optional — disabled when either var is missing.
    // CD-4: NO superRefine cross-field "both required in prod" — decision
    // lives in `initSupabase` / `getSupabaseClient` at runtime.
    // DT-1: canonical name is `SUPABASE_SERVICE_KEY` (NOT `SUPABASE_SERVICE_ROLE_KEY`).
    // Defense-in-depth (WFAC-32 AR MNR-1): `z.string().url()` accepts ANY
    // RFC 3986 URL (ftp://, mailto:, file://, etc.). `createClient()` may
    // throw synchronously on exotic schemes — reject them up-front at env
    // validation so misconfig fails fast in `parseEnv`, not at request time.
    SUPABASE_URL: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: 'must be http:// or https://' })
      .optional(),
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),

    // WFAC-40 — rate limiting (SDD §4.1). NO magic numbers in routes (CD-7).
    // RATE_LIMIT_ENABLED: accepts literal 'true'/'false' strings from env;
    // transforms to boolean. `z.coerce.boolean()` is PROHIBITED (CD-12) —
    // it would interpret 'false' as truthy (any non-empty string).
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_SETTLE_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_SUPPORTED_MAX: z.coerce.number().int().min(1).default(120),

    // WFAC-41 — circuit breaker per chain RPC (SDD §4.1). NO magic numbers
    // in adapters (CD-NEW-CB-NO-MAGIC). `CB_ENABLED` must use the enum
    // transform pattern — `z.coerce.boolean()` is PROHIBITED (CD-NEW-CB-BOOL;
    // same rationale as WFAC-40 CD-12 for RATE_LIMIT_ENABLED).
    CB_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    CB_ROLLING_WINDOW_MS: z.coerce.number().int().min(1).default(30000),
    CB_RESET_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),

    // WFAC-50 — Kite adapter real (SDD DT-G). OPERATOR_PRIVATE_KEY is optional
    // at Zod level; the .superRefine below enforces presence for non-test env.
    // Regex guards format (0x + 64 hex chars). Never logged — see
    // src/infra/wallet.ts security note.
    OPERATOR_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be 0x + 64 hex chars' })
      .optional(),

    // WFAC-AUDIT — caller auth. Optional at Zod level; .superRefine enforces
    // presence for non-test env (same pattern as OPERATOR_PRIVATE_KEY). NEVER logged.
    FACILITATOR_API_KEY: z.string().min(1).optional(),

    // AUDIT (key versioning / rotation) — ADDITIVE multi-key support.
    // Comma-separated list of additional valid caller keys. Lets the operator
    // rotate keys with a grace period (publish a new key here, deploy, migrate
    // callers, then drop the old one) WITHOUT downtime. The single
    // FACILITATOR_API_KEY above keeps working unchanged: at runtime the auth
    // middleware accepts FACILITATOR_API_KEY OR any entry in this list.
    // Raw CSV string (NO Zod transform per the CORS CD-11 precedent) — parsed +
    // trimmed + filtered in src/middleware/auth.ts. NEVER logged.
    // NOT added to .superRefine: optional, NOT required-in-prod (the single
    // key remains the required credential; this is purely additive).
    FACILITATOR_API_KEYS: z.string().optional(),

    // WFAC-AUDIT — Fastify trustProxy hop count. Railway = 1 hop ('1').
    // If Cloudflare sits in front, bump to '2' via env (no code change, CD-3).
    // In tests set 'false' to avoid depending on proxy infra (R-1).
    TRUST_PROXY: z.string().default('1'),

    // WFAC-50 — Kite Testnet PYUSD/USDC token address. Required at boot for
    // non-test env. Validated as 20-byte hex. Consumed by KiteAdapter constructor.
    KITE_USDC_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be 0x + 40 hex chars' })
      .optional(),

    // WFAC-12 — Kite Testnet token metadata, env-configurable (opt-in overrides).
    // ALL optional: when unset, KiteAdapter applies the PYUSD defaults
    // (symbol/name/eip712Name=PYUSD, decimals=18, version='1') → zero regression.
    // NOT added to .superRefine (CD-AB-1: optional, NOT required-in-prod). These
    // are token metadata, not secrets (CD-4). Consumed in kiteTestnetAdapter.
    KITE_TESTNET_TOKEN_SYMBOL: z.string().min(1).optional(),
    KITE_TESTNET_TOKEN_NAME: z.string().min(1).optional(),
    KITE_TESTNET_TOKEN_DECIMALS: z.coerce.number().int().min(0).optional(),
    KITE_TESTNET_EIP712_NAME: z.string().min(1).optional(),
    KITE_TESTNET_EIP712_VERSION: z.string().min(1).optional(),

    // ---- Mainnet feature flags + per-chain config (public mainnet support) -
    // Each mainnet chain is OPT-IN via a discrete enabled flag. Defaults are
    // `false` so existing testnet-only deployments are unaffected. Same enum
    // pattern as RATE_LIMIT_ENABLED / CB_ENABLED — z.coerce.boolean() is
    // PROHIBITED (would interpret 'false' as truthy).
    //
    // For each chain, registration in src/chains/index.ts requires:
    //   1. The `*_ENABLED` flag === true.
    //   2. The chain's RPC URL env var to be present.
    //   3. The chain's token address env var (where applicable) to be present.
    // If any of those fail, the chain is silently NOT registered — boot
    // succeeds with whatever testnet+enabled-mainnets the operator configured.
    KITE_MAINNET_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AVALANCHE_MAINNET_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Kite Mainnet USDC.e address (chain 2366). Optional at the schema level —
    // required at adapter construction iff KITE_MAINNET_ENABLED=true (enforced
    // by KiteAdapter constructor via readUsdcAddress).
    KITE_MAINNET_USDC_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be 0x + 40 hex chars' })
      .optional(),

    // ---- Anti-abuse caps (public-sharing hardening) ------------------------
    // Per-settle max authorized amount (atomic units; uint256 decimal string).
    // Default 100 PYUSD at 18 decimals = 100 * 1e18.
    // Requests with accepted.amount > this cap are rejected with INVALID_AMOUNT
    // 400 BEFORE hitting the chain adapter. Protects against single-tx drain.
    SETTLE_MAX_AMOUNT_ATOMIC: z
      .string()
      .regex(/^[1-9][0-9]*$/, { message: 'must be a positive uint256 decimal (no leading zero)' })
      .default('100000000000000000000'),
    // Global daily settle cap — hard ceiling across ALL IPs/wallets to protect
    // the operator wallet gas budget. Key `settle:daily:<YYYY-MM-DD>` in Redis.
    // Set to 0 to disable (useful for stress-testing or after re-fueling).
    // Fail-open on Redis outage (never blocks due to infra).
    SETTLE_DAILY_GLOBAL_CAP: z.coerce.number().int().min(0).default(1000),

    /**
     * WFAC-53 FIX-1 — CORS origin whitelist. Raw CSV string (NO Zod transform
     * per CD-11). When absent or empty → @fastify/cors uses `origin: true`
     * (reflect any origin). When non-empty → callback returns true only for
     * listed origins; non-whitelisted origins receive 403 (no ACAO header).
     * Example: 'https://a2a.wasiai.io,https://app.wasiai.io'.
     */
    CORS_ALLOWED_ORIGINS: z.string().optional(),

    /**
     * WFAC-53 FIX-6 — failure mode for incrementAndCheckDailyCap.
     *   - 'open'   : Redis throw → allow request through (fail-open).
     *   - 'closed' (DEFAULT, AUDIT hardening): Redis throw → returns
     *              { ok: false, reason: 'redis_error_failclosed' } →
     *              /settle route returns HTTP 503 SERVICE_UNAVAILABLE.
     *
     * AUDIT (money-path behavior change, flagged for AR): the default flipped
     * from 'open' to 'closed'. For a PAYMENT service, a missing/unset env must
     * be SECURE by default — when the daily settle cap cannot be enforced
     * (Redis down) we must NOT let unbounded settlements drain the operator
     * wallet. Still fully overridable to 'open' via env for operators who
     * prefer availability over budget protection. Startup warns (see app.ts)
     * when running in production with 'open'.
     */
    SETTLE_CAP_FAIL_MODE: z.enum(['open', 'closed']).default('closed'),

    /**
     * AUDIT (money-path behavior, flagged for AR) — rate-limit failure mode on
     * a transient Redis error. Maps to @fastify/rate-limit `skipOnError`.
     *   - 'true'  (DEFAULT): preserve current behavior (skipOnError: true).
     *             A Redis blip lets requests through rather than hard-breaking
     *             the service. Recommended ONLY if you accept a brief per-IP
     *             rate-limit bypass during Redis outages.
     *   - 'false' (prod recommendation for strict enforcement): a Redis error
     *             on the rate-limit store rejects the request. CAUTION: a
     *             sustained Redis outage will then fail ALL rate-limited
     *             requests — only enable with Redis HA.
     * Default 'true' is DELIBERATE: flipping to fail-closed unconditionally
     * could hard-break the service on a transient blip. The authoritative
     * budget protection is SETTLE_CAP_FAIL_MODE (fail-closed by default);
     * rate-limit is defense-in-depth.
     */
    RATE_LIMIT_FAIL_OPEN: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((data, ctx) => {
    if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when NODE_ENV is not "test"',
      });
    }
    // WFAC-50 — OPERATOR_PRIVATE_KEY required outside test.
    if (!data.OPERATOR_PRIVATE_KEY && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPERATOR_PRIVATE_KEY'],
        message: 'OPERATOR_PRIVATE_KEY is required when NODE_ENV is not "test"',
      });
    }
    // WFAC-50 — KITE_USDC_ADDRESS required outside test.
    if (!data.KITE_USDC_ADDRESS && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KITE_USDC_ADDRESS'],
        message: 'KITE_USDC_ADDRESS is required when NODE_ENV is not "test"',
      });
    }
    // WFAC-AUDIT — FACILITATOR_API_KEY required outside test (caller auth).
    if (!data.FACILITATOR_API_KEY && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FACILITATOR_API_KEY'],
        message: 'FACILITATOR_API_KEY is required when NODE_ENV is not "test"',
      });
    }
  });

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Parse process.env (or any raw record) against EnvSchema.
 *
 * On failure: writes a human-readable summary to `process.stderr` listing each
 * issue with its path, then calls `process.exit(1)`.
 * On success: returns a validated & strongly-typed `EnvConfig`.
 *
 * CD-8: fail-fast BEFORE Fastify listens — stderr, not logger (the logger may
 * not exist yet when this runs).
 */
export function parseEnv(raw: NodeJS.ProcessEnv): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    const message = `Env validation failed:\n${lines.join('\n')}\n`;
    process.stderr.write(message);
    process.exit(1);
  }
  return result.data;
}
