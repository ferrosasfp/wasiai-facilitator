/**
 * Chain registry composition — side-effect module.
 *
 * Importing this module registers every adapter known to the facilitator.
 * Consumers should do: `import './chains/index.js';` in their bootstrap path.
 *
 * Exposes: NOTHING. This file is side-effect-only (CD-19).
 * Consumers that need the singleton import it directly from './registry.js'.
 *
 * Boundaries:
 *   - imports ./registry.js + ./kite.js + ./avalanche.js only.
 *
 * Future work:
 *   - Each new chain = 1 line here + 1 new file in src/chains/.
 */

import { chainRegistry } from './registry.js';
import { kiteTestnetAdapter, kiteMainnetAdapter } from './kite.js';
import { avalancheFujiAdapter, avalancheMainnetAdapter } from './avalanche.js';
import { baseSepoliaAdapter, baseMainnetAdapter } from './base.js';
import { solanaAdapter } from './solana-adapter.js';
import { casperMainnetAdapter, casperTestnetAdapter } from './casper-adapter.js';

chainRegistry.register(kiteTestnetAdapter);
// Optional adapters — registered only when fully configured.
//
// Testnets (Fuji): registered if their RPC env var is set. This is the
// historical behavior — present before the mainnet flags landed.
//
// Mainnets (Kite Mainnet, Avalanche C-Chain, Base Mainnet) AND Base Sepolia:
// require BOTH an explicit `*_ENABLED=true` flag AND the corresponding RPC
// (+ token-address where applicable) env vars. Each adapter module returns
// `null` when those preconditions are not met, so existing deployments boot
// identically to before this PR.
//
// WKH-105: Base Sepolia is opt-in too (NOT auto-registered on RPC presence
// like Fuji) — CD-2 of the work-item requires default OFF on Base Sepolia.
if (kiteMainnetAdapter !== null) chainRegistry.register(kiteMainnetAdapter);
if (avalancheFujiAdapter !== null) chainRegistry.register(avalancheFujiAdapter);
if (avalancheMainnetAdapter !== null) chainRegistry.register(avalancheMainnetAdapter);
if (baseSepoliaAdapter !== null) chainRegistry.register(baseSepoliaAdapter);
if (baseMainnetAdapter !== null) chainRegistry.register(baseMainnetAdapter);
// WKH-205 — Solana (verify-only, non-EVM). Opt-in-off: registered only when
// SOLANA_RPC_URL + SOLANA_USDC_MINT are set (the factory returns null otherwise),
// so the EVM suite is byte-identical when Solana is unconfigured (AC-6).
if (solanaAdapter !== null) chainRegistry.register(solanaAdapter);
// Casper (verify/settle delegated to the Casper x402 facilitator, non-EVM).
// Opt-in-off, same gate as Solana: registered only when CASPER_<NET>_ENABLED=true
// AND CASPER_<NET>_WCSPR_CONTRACT_HASH is set (the factory returns null otherwise),
// so deployments that do not configure Casper boot byte-identically.
if (casperMainnetAdapter !== null) chainRegistry.register(casperMainnetAdapter);
if (casperTestnetAdapter !== null) chainRegistry.register(casperTestnetAdapter);
