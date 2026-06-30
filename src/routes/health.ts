import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { getHealthStatus, type HealthStatusDetail } from '../core/health-status.js';

/**
 * Read `version` from package.json once at module load and cache it.
 *
 * CD-15: NO hardcoding "0.1.0".
 * DT-8: `rootDir: ./src` excludes package.json from tsc output, so we cannot
 *        rely on `resolveJsonModule` + a relative import. Instead we resolve
 *        the path at runtime via `fileURLToPath(import.meta.url)`.
 */
const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
  version: string;
};

export interface HealthResponse {
  /**
   * 'ok' for liveness — the process is up. Dependency problems are surfaced via
   * `degraded` + `details`, NOT by failing the probe (OP-05): /health stays 200
   * so a transient Redis/RPC blip does not get the container killed.
   */
  status: 'ok';
  /** OP-05 — true when any tracked dependency is unhealthy. */
  degraded: boolean;
  version: string;
  uptime: number;
  timestamp: string;
  /** OP-05 — per-dependency detail (Redis, wallet presence, per-chain RPC). */
  details: HealthStatusDetail;
}

/**
 * GET /health — liveness probe with dependency-aware detail (OP-05).
 *
 * Always returns HTTP 200 for liveness (the process is up). The body carries a
 * `degraded` flag and a `details` object reporting Redis reachability (real
 * PING), per-chain RPC reachability, and operator wallet presence — WITHOUT
 * leaking any secret value.
 *
 * CD-9: `config.rateLimit = false` so the rate-limit plugin exempts this route.
 */
export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
    },
    async (_request, _reply): Promise<HealthResponse> => {
      const details = await getHealthStatus();
      return {
        status: 'ok',
        degraded: details.degraded,
        version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        details,
      };
    },
  );
};
