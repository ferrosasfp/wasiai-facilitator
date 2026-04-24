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
import { avalancheFujiAdapter } from './avalanche.js';

chainRegistry.register(kiteTestnetAdapter);
// Optional adapters — registered only if their env vars are set.
// Each adapter module returns `null` when its required env is missing,
// letting the facilitator boot successfully with just testnet in V1 MVP.
if (kiteMainnetAdapter !== null) chainRegistry.register(kiteMainnetAdapter);
if (avalancheFujiAdapter !== null) chainRegistry.register(avalancheFujiAdapter);
