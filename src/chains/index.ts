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

chainRegistry.register(kiteTestnetAdapter);
// Optional adapters — registered only when fully configured.
//
// Testnets (Fuji): registered if their RPC env var is set. This is the
// historical behavior — present before the mainnet flags landed.
//
// Mainnets (Kite Mainnet, Avalanche C-Chain): require BOTH an explicit
// `*_ENABLED=true` flag AND the corresponding RPC + token-address env vars.
// Each adapter module returns `null` when those preconditions are not met,
// so existing testnet-only deployments boot identically to before this PR.
if (kiteMainnetAdapter !== null) chainRegistry.register(kiteMainnetAdapter);
if (avalancheFujiAdapter !== null) chainRegistry.register(avalancheFujiAdapter);
if (avalancheMainnetAdapter !== null) chainRegistry.register(avalancheMainnetAdapter);
