# Chain-Adaptive Architecture

**Principle:** Adding a new chain to `wasiai-facilitator` should NEVER require touching `src/core/`. Only two files change: the new `src/chains/<name>.ts` adapter and the `src/chains/registry.ts` import line.

## Contract

Every chain adapter implements the `ChainConfig` interface defined in `src/chains/types.ts`:

```ts
export interface ChainConfig {
  id: number;                              // numeric chainId (e.g. 2368)
  name: string;                            // slug (e.g. "kite-testnet")
  caip2: string;                           // "eip155:2368"
  rpcUrl: string;                          // from env var
  nativeGasToken: { symbol, decimals };   // e.g. { symbol: "KITE", decimals: 18 }
  explorerUrl?: string;                    // e.g. "https://testnet.kitescan.ai"
  tokens: Record<string, TokenConfig>;    // symbol → token details
}

export interface TokenConfig {
  symbol: string;                          // "PYUSD", "USDC"
  address: Address;                        // checksummed
  decimals: number;
  eip712Domain: { name: string; version: string };
  supportedMethods: MethodType[];          // ['eip3009'] | ['eip3009','permit2']
}

export type MethodType = 'eip3009' | 'permit2' | 'erc7710';
```

## How to add a new chain

### Example: adding `base-sepolia`

1. **Create `src/chains/base-sepolia.ts`:**

```ts
import { baseSepolia } from 'viem/chains';
import type { ChainConfig } from './types.js';

export const baseSepoliaConfig: ChainConfig = {
  id: baseSepolia.id,
  name: 'base-sepolia',
  caip2: `eip155:${baseSepolia.id}`,
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? baseSepolia.rpcUrls.default.http[0],
  nativeGasToken: { symbol: 'ETH', decimals: 18 },
  explorerUrl: 'https://sepolia.basescan.org',
  tokens: {
    USDC: {
      symbol: 'USDC',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      eip712Domain: { name: 'USD Coin', version: '2' },
      supportedMethods: ['eip3009'],
    },
  },
};
```

2. **Register in `src/chains/registry.ts`:**

```ts
import { baseSepoliaConfig } from './base-sepolia.js';

export const chainRegistry: Record<string, ChainConfig> = {
  // existing...
  'base-sepolia': baseSepoliaConfig,
};
```

3. **Add env var to `.env.example`:**

```bash
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

4. **Fund operator wallet** with ETH for gas on the new chain (manual or via CI script).

5. **Write integration test** in `src/chains/__tests__/base-sepolia.test.ts`.

**Zero changes to** `src/core/`, `src/methods/`, `src/routes/`.

## Verification

After adding a chain, `GET /supported` should automatically list it. This endpoint reads from `chainRegistry` directly.

Example response fragment:
```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "eip155:2368" },
    { "x402Version": 2, "scheme": "exact", "network": "eip155:84532" }
  ]
}
```

## Method compatibility per chain

Some chains may not support all methods (e.g. older chains without Permit2 deployed). The `tokens[].supportedMethods` field declares what's actually available.

The core engine rejects requests for methods not in `supportedMethods` with `NETWORK_MISMATCH` error.

## Mainnet vs testnet

Convention: testnet has suffix `-testnet` or specific name (`fuji`, `sepolia`). Mainnet has no suffix or is named explicitly (`mainnet`).

Both are separate entries in `chainRegistry`. No shared code — they're independent ChainConfigs with different RPCs, token addresses, and sometimes different EIP-712 domains.

## Operator wallet per chain

Current V1: single `OPERATOR_PRIVATE_KEY` used across all chains (same address on every chain via EVM address derivation).

**Future V2:** multi-key support for chain isolation:
```bash
OPERATOR_KEY_KITE=0x...
OPERATOR_KEY_AVALANCHE=0x...
OPERATOR_KEY_BASE=0x...
```

This allows:
- Separate balance tracking per chain
- Key rotation per chain (zero-downtime by rotating one at a time)
- Risk isolation (compromise of one key ≠ compromise of all)

## Non-EVM chains (V2+)

Non-EVM chains (Solana, Aptos, Stellar) have fundamentally different cryptography and transaction models. They will NOT fit under the current `ChainConfig` interface.

The plan for V2+:
- Introduce `ChainFamily` abstraction (`evm` | `solana` | `aptos` | ...)
- Each family has its own adapter interface
- `src/chains/registry.ts` aggregates all families
- `src/methods/` gets family-specific adapters (e.g. `src/methods/spl-transfer/` for Solana)

Until then, V1 is EVM-only.
