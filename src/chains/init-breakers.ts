/**
 * WFAC-41 — logger injection for per-chain circuit breakers (DT-11 SDD).
 *
 * Called once from `src/app.ts` `buildApp()` AFTER adapter registration
 * (registry populated) and BEFORE route handlers start serving traffic.
 *
 * Ducktype over `setLogger(logger)`: adapters that own a ChainCircuitBreaker
 * (KiteAdapter, AvalancheFujiAdapter) expose the method; adapters without
 * breakers silently skip.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import: `./registry.js` (sibling), `pino` (type-only).
 *   - MUST NOT import: `src/core/*` runtime, `src/routes/*`, `src/methods/*`,
 *                      `src/infra/*`.
 */

import type { Logger } from 'pino';
import { chainRegistry } from './registry.js';

export function initChainBreakers(logger: Logger): void {
  for (const metadata of chainRegistry.listAdapters()) {
    const lookup = chainRegistry.getAdapter(metadata.chainId);
    if (!lookup.ok) continue;
    const adapter = lookup.adapter;
    const maybeSetter = (adapter as { setLogger?: (l: Logger) => void }).setLogger;
    if (typeof maybeSetter === 'function') {
      maybeSetter.call(adapter, logger);
    }
  }
}
