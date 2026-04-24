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
  })
  .superRefine((data, ctx) => {
    if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when NODE_ENV is not "test"',
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
