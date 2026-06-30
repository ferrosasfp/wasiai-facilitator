/**
 * Prometheus metrics facade (ECOSYSTEM-AUDIT OP-05).
 *
 * prom-client is already a dependency: src/chains/circuit-breaker.ts registers
 * circuit-breaker gauges/counters on the process-global DEFAULT registry. This
 * module is the single sanctioned way for the route layer to read those
 * metrics WITHOUT importing src/chains/* (OWNERS boundary: routes ↛ chains).
 *
 * Boundary (OWNERS.md row `src/infra/`): MAY import SDK clients (prom-client).
 * MUST NOT import any other src/* module. Consumed by src/routes/metrics.ts.
 */

import { register as defaultRegister } from 'prom-client';

/** Prometheus text exposition content-type (e.g. `text/plain; version=0.0.4`). */
export const METRICS_CONTENT_TYPE: string = defaultRegister.contentType;

/**
 * Serialize the default registry to the Prometheus text exposition format.
 * Returns whatever metrics have been registered process-wide (today: the
 * circuit-breaker gauges/counters from src/chains/circuit-breaker.ts).
 */
export async function renderMetrics(): Promise<string> {
  return defaultRegister.metrics();
}
