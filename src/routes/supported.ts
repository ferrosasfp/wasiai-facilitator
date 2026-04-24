/**
 * GET /supported — facilitator discovery endpoint (WFAC-22).
 *
 * Read-only. No body. No auth. No idempotency (no side effects — CD-4).
 * Consumers (wasiai-v2, wasiai-a2a, third-party integrators) hit this before
 * invoking /verify or /settle to learn which chains and methods are live.
 *
 * Layers (top-down):
 *   1. Measure start time.
 *   2. Build response via `getSupportedResponse()` (pure, reads chainRegistry).
 *   3. Emit structured info log (L1) with `request_id`, `chain_count`,
 *      `duration_ms`. No PII (CD-3).
 *   4. Return 200 with an EXPLICIT field-by-field body build (CD-2) —
 *      never `reply.send(response)` directly.
 *
 * Boundary (OWNERS / CD-1):
 *   - MAY import: fastify, ../core/supported.js.
 *   - MUST NOT import: src/chains/* (any), src/methods/* (any),
 *     src/infra/* (any). The route stays pure orchestration + HTTP.
 *
 * HTTP method coverage (AC-6): Fastify's default for unregistered methods on
 * a matched path is 404. We only register `.get('/supported', ...)`; POST/
 * PUT/DELETE/PATCH fall through to the default handler → 404, no side effects.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getSupportedResponse } from '../core/supported.js';

export const supportedRoute: FastifyPluginAsync = async (app) => {
  // WFAC-40 — per-route rate-limit config (DT-6 + DT-13 SDD).
  const env = app.env;
  app.get(
    '/supported',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SUPPORTED_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const requestId = request.id;

      const response = getSupportedResponse();

      // L1 — success info log. Authorized fields only: request_id, chain_count,
      // duration_ms (CD-3). No request.ip, no request.headers, no user-agent.
      app.log.info(
        {
          request_id: requestId,
          chain_count: response.chains.length,
          duration_ms: Date.now() - startMs,
        },
        'supported ok',
      );

      // CD-2: explicit field-by-field body build. Even though `response` already
      // has the right shape, a future refactor of SupportedResponse could
      // accidentally leak extra fields if we did `reply.send(response)` directly.
      return reply.code(200).send({
        chains: response.chains,
        methods: response.methods,
      });
    },
  );
};
