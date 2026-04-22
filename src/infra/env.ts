import { z } from 'zod';

/**
 * Environment variables schema.
 *
 * CD-2: PORT default 3002 is declared here (the only source-of-truth literal).
 * CD-8: validation fails FAST in `parseEnv` before anything else bootstraps.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),
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
