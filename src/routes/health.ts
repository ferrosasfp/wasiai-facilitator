import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

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
  status: 'ok';
  version: string;
  uptime: number;
  timestamp: string;
}

/**
 * GET /health — liveness probe with basic metadata.
 *
 * CD-9: `config.rateLimit = false` so the rate-limit plugin (registered in
 * WFAC-20+) will exempt this route. Fastify ignores unknown config keys, so
 * declaring this here in WFAC-2 is safe even before the plugin exists.
 */
export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
    },
    async (_request, _reply): Promise<HealthResponse> => {
      return {
        status: 'ok',
        version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    },
  );
};
