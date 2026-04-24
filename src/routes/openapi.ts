/**
 * GET /openapi.json — serves the OpenAPI 3.1 spec (WFAC-23).
 *
 * Reads `doc/openapi.yaml` ONCE at module load and parses it to a plain JSON
 * object (CD-3: no I/O per request). Subsequent requests reply from the
 * in-memory cached object — fast and allocation-free beyond what Fastify's
 * serializer already does.
 *
 * Layers (top-down):
 *   1. Resolve the YAML path relative to this module (ESM-safe via
 *      `fileURLToPath(import.meta.url)` — same pattern as
 *      `src/routes/health.ts` for package.json).
 *   2. `readFileSync` + `js-yaml.load()` at module load.
 *   3. Route handler returns the cached object with `application/json` +
 *      200.
 *
 * Boundary (OWNERS):
 *   - MAY import: fastify, node:fs, node:path, node:url, js-yaml.
 *   - MUST NOT import: src/chains/*, src/methods/*, src/core/*, src/infra/*.
 *     This route is a pure static-content server.
 *
 * CDs enforced here:
 *   - CD-1 : no `@fastify/swagger` / `@fastify/swagger-ui`.
 *   - CD-3 : the parse happens exactly once (module-level `const`).
 *   - CD-6 : `info.version` is NOT hardcoded — it comes from the parsed
 *            YAML (which itself tracks `package.json#version` per DT-5).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { load as yamlLoad } from 'js-yaml';

/**
 * Absolute path to `doc/openapi.yaml`.
 *
 * `rootDir: ./src` in tsconfig.json means the compiled JS ends up in
 * `dist/routes/openapi.js`. From there, `../../doc/openapi.yaml` resolves
 * to `<pkg-root>/doc/openapi.yaml`. During development with `tsx`, the same
 * relative hop works from `src/routes/openapi.ts` (→ `<pkg-root>/doc/...`).
 */
const yamlPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../doc/openapi.yaml');

/**
 * Parsed spec, cached at module load (CD-3). `unknown` is narrowed by the
 * route handler to `Record<string, unknown>` to keep the body typed without
 * pulling a runtime OpenAPI types package.
 */
const OPENAPI_SPEC: Record<string, unknown> = yamlLoad(readFileSync(yamlPath, 'utf-8')) as Record<
  string,
  unknown
>;

export const openapiRoute: FastifyPluginAsync = async (app) => {
  app.get('/openapi.json', async (_request, reply) => {
    return reply.code(200).type('application/json').send(OPENAPI_SPEC);
  });
};
