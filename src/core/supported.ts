/**
 * Supported discovery module (WFAC-22).
 *
 * Exposes:
 *   - SupportedResponse: top-level response shape served by GET /supported.
 *   - ChainSupportedItem: one entry per registered chain (network, name, methods).
 *   - CHAIN_METHODS_DEFAULT: module-level FALLBACK, applied only to adapters
 *     that do not declare their own methods. Do NOT read it as "every
 *     registered chain supports eip3009": `getSupportedResponse()` below reads
 *     `ChainMetadata.supportedMethods` (field added by WKH-204) and only falls
 *     back here when that field is absent. Live case: `SolanaAdapter` declares
 *     `spl-token-transfer-finalized` (WKH-323) and never reaches this default.
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
 * Default methods for adapters that do NOT declare their own
 * `ChainMetadata.supportedMethods`. Today that is the EVM adapters, for which
 * `eip3009` is accurate (they settle a signed EIP-3009 authorization).
 *
 * This is not a statement about the whole registry: an adapter that declares
 * its own methods never reaches this default — see `SolanaAdapter`, which
 * declares `spl-token-transfer-finalized` (WKH-323).
 */
export const CHAIN_METHODS_DEFAULT: readonly string[] = ['eip3009'];

export interface ChainSupportedItem {
  readonly network: string;
  readonly name: string;
  readonly methods: readonly string[];
  /**
   * WFAC-41 (AC-9, DT-7) — current circuit breaker state per chain.
   * Omitted (field absent from the JSON) when the adapter does not expose
   * `getBreakerState()` (stub / future adapter without a breaker).
   * Integrators can branch on `breakerState === 'OPEN'` to try an
   * alternate chain.
   */
  readonly breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

export interface SupportedResponse {
  readonly chains: readonly ChainSupportedItem[];
  readonly methods: readonly string[];
}

/**
 * Build the discovery response from the live chain registry.
 *
 * - `chains`: one entry per registered adapter; `network` is `ChainMetadata.networkId`
 *   ("eip155:<chainId>" on EVM rails, "solana:<cluster>" on the Solana rail since
 *   WKH-205), `name` is `ChainMetadata.name`, and `methods` is the adapter's own
 *   `ChainMetadata.supportedMethods` WHEN it declares one — a copy of
 *   `CHAIN_METHODS_DEFAULT` only when it does not (see the `??` below). WKH-323:
 *   the Solana entry reports `spl-token-transfer-finalized` through that branch.
 * - `methods`: deduped union of every chain's methods array. When there are
 *   zero registered adapters this naturally evaluates to `[]`, satisfying AC-9
 *   (`{ chains: [], methods: [] }`).
 *
 * Zero-adapter edge case (AC-9): `adapters = []` => `chains = []` =>
 * `flatMap(...)` yields `[]` => `methods = []`.
 */
export function getSupportedResponse(): SupportedResponse {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const chains: readonly ChainSupportedItem[] = adapters.map((meta) => {
    // WFAC-41 (DT-7, CD-NEW-CB-SUPPORTED-DUCKTYPE) — ducktype lookup of
    // getBreakerState via registry. chainRegistry.getAdapter returns the
    // adapter instance which MAY expose getBreakerState (KiteAdapter,
    // AvalancheFujiAdapter) or MAY NOT (stubs / future adapters). Spread
    // keeps the field OMITTED when absent — cleaner JSON contract than
    // emitting `undefined`.
    //
    // AR-BLQ-BAJO-1 fix: the adapter's getBreakerState itself may now return
    // `undefined` when CB_ENABLED=false (ChainCircuitBreaker.getState in
    // passthrough mode). We treat that identically to the "no getter at all"
    // case — field is omitted — so integrators never see a misleading
    // 'CLOSED' for a chain whose breaker is disabled.
    type BreakerGetter = () => 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
    const lookup = chainRegistry.getAdapter(meta.chainId);
    const getter =
      lookup.ok &&
      typeof (lookup.adapter as { getBreakerState?: BreakerGetter }).getBreakerState === 'function'
        ? (lookup.adapter as { getBreakerState: BreakerGetter }).getBreakerState
        : undefined;
    const state = getter ? getter.call(lookup.ok ? lookup.adapter : undefined) : undefined;
    return {
      network: meta.networkId,
      name: meta.name,
      methods: [...(meta.supportedMethods ?? CHAIN_METHODS_DEFAULT)],
      ...(state !== undefined ? { breakerState: state } : {}),
    };
  });
  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
  return { chains, methods };
}
