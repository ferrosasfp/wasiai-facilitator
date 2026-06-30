/**
 * GET /metrics — Prometheus scrape endpoint (ECOSYSTEM-AUDIT OP-05).
 *
 * Exposes the already-collected prom-client metrics (today: per-chain circuit
 * breaker gauges/counters from src/chains/circuit-breaker.ts) in the Prometheus
 * text exposition format. Read-only, no auth (standard for an internal scrape
 * target; gate at the network/ingress layer if exposure must be restricted).
 *
 * Boundary (OWNERS / CD-1):
 *   - MAY import: fastify, ../infra/metrics.js (the prom-client facade).
 *   - MUST NOT import: src/chains/* directly. The facade keeps the
 *     `routes ↛ chains` boundary intact.
 *
 * Rate-limit: exempt (`config.rateLimit = false`) — a scrape target should not
 * be throttled. Excluded from the audit hook in app.ts (AUDIT_EXCLUDED_PATHS).
 */

import type { FastifyPluginAsync } from 'fastify';
import { renderMetrics, METRICS_CONTENT_TYPE } from '../infra/metrics.js';

export const metricsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/metrics',
    {
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      const body = await renderMetrics();
      return reply.code(200).header('content-type', METRICS_CONTENT_TYPE).send(body);
    },
  );
};
