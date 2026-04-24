/**
 * Supported discovery module (WFAC-22).
 *
 * Exposes:
 *   - SupportedResponse: top-level response shape served by GET /supported.
 *   - ChainSupportedItem: one entry per registered chain (network, name, methods).
 *   - CHAIN_METHODS_DEFAULT: module-level constant listing the methods every
 *     registered chain supports today. DT-1 — we do NOT read methods from
 *     ChainMetadata (no such field); every chain implements `eip3009` in V1.
 *   - getSupportedResponse(): pure function that maps `chainRegistry.listAdapters()`
 *     to the response shape at request time (DT-3, live snapshot).
 *
 * Boundaries (OWNERS.md row `src/core/`, DT-4):
 *   - MAY import: `../chains/registry.js` (via registry singleton, allowed
 *     "salvo vía registry"), `../chains/types.js` (type-only).
 *   - MUST NOT import: `../chains/<chain>.js` directly, `../methods/*`,
 *     `../routes/*`, `../infra/*` (pure — no logger, no I/O).
 *
 * Purity (CD-4): no side effects, no logger, no I/O. Same registry state =>
 * same response. `O(N)` over registered adapters (`N < 20` in practice).
 */

import type { ChainMetadata } from '../chains/types.js';
import { chainRegistry } from '../chains/registry.js';

/**
 * Methods every chain supports in V1. DT-1: kept here (not in ChainMetadata)
 * to avoid touching adapters. WFAC-permit2 will migrate this into the adapter
 * layer when a second method lands.
 */
export const CHAIN_METHODS_DEFAULT: readonly string[] = ['eip3009'];

export interface ChainSupportedItem {
  readonly network: string;
  readonly name: string;
  readonly methods: readonly string[];
}

export interface SupportedResponse {
  readonly chains: readonly ChainSupportedItem[];
  readonly methods: readonly string[];
}

/**
 * Build the discovery response from the live chain registry.
 *
 * - `chains`: one entry per registered adapter; `network` is `ChainMetadata.networkId`
 *   ("eip155:<chainId>"), `name` is `ChainMetadata.name`, `methods` is a copy of
 *   `CHAIN_METHODS_DEFAULT`.
 * - `methods`: deduped union of every chain's methods array. When there are
 *   zero registered adapters this naturally evaluates to `[]`, satisfying AC-9
 *   (`{ chains: [], methods: [] }`).
 *
 * Zero-adapter edge case (AC-9): `adapters = []` => `chains = []` =>
 * `flatMap(...)` yields `[]` => `methods = []`.
 */
export function getSupportedResponse(): SupportedResponse {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const chains: readonly ChainSupportedItem[] = adapters.map((meta) => ({
    network: meta.networkId,
    name: meta.name,
    methods: [...CHAIN_METHODS_DEFAULT],
  }));
  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
  return { chains, methods };
}
