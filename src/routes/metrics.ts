/**
 * GET /metrics — Prometheus scrape endpoint (ECOSYSTEM-AUDIT OP-05).
 *
 * Exposes the already-collected prom-client metrics (today: per-chain circuit
 * breaker gauges/counters from src/chains/circuit-breaker.ts) in the Prometheus
 * text exposition format. Read-only.
 *
 * N10 (audit hardening) — TOKEN GATED. On Railway the endpoint is a PUBLIC URL,
 * so operational state must not leak to anonymous recon. `requireMetricsToken`
 * (src/middleware/auth.ts) enforces a shared secret (`METRICS_TOKEN`) and FAILS
 * CLOSED in production when the token is unset (503); dev/test passes through.
 *
 * Boundary (OWNERS / CD-1):
 *   - MAY import: fastify, ../infra/metrics.js (the prom-client facade),
 *     ../middleware/auth.js (the token-gate preHandler — same import shape as
 *     verify.ts / settle.ts pull in requireFacilitatorKey).
 *   - MUST NOT import: src/chains/* directly. The facade keeps the
 *     `routes ↛ chains` boundary intact.
 *
 * Rate-limit: exempt (`config.rateLimit = false`) — a scrape target should not
 * be throttled. Excluded from the audit hook in app.ts (AUDIT_EXCLUDED_PATHS).
 */

import type { FastifyPluginAsync } from 'fastify';
import { renderMetrics, METRICS_CONTENT_TYPE } from '../infra/metrics.js';
import { requireMetricsToken } from '../middleware/auth.js';

export const metricsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/metrics',
    {
      config: { rateLimit: false },
      preHandler: requireMetricsToken, // N10 — token gate, fail-closed in prod
    },
    async (_request, reply) => {
      const body = await renderMetrics();
      return reply.code(200).header('content-type', METRICS_CONTENT_TYPE).send(body);
    },
  );
};
