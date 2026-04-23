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
chainRegistry.register(kiteMainnetAdapter);
chainRegistry.register(avalancheFujiAdapter);
