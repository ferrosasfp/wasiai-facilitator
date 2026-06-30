/**
 * Avalanche adapters (Fuji testnet 43113, C-Chain mainnet 43114).
 *
 * Exposes:
 *   - avalancheFujiAdapter: ChainAdapter | null — chainId 43113, env AVALANCHE_FUJI_RPC_URL.
 *   - avalancheMainnetAdapter: ChainAdapter | null — chainId 43114, env AVALANCHE_MAINNET_RPC_URL.
 *     Opt-in: requires AVALANCHE_MAINNET_ENABLED=true AND AVALANCHE_MAINNET_RPC_URL.
 *
 * WFAC-AUDIT AC-5: the full EIP-3009 flow now lives in `BaseEip3009Adapter`.
 * This file is a thin wrapper: it reads its env, selects the viem chain and
 * the canonical Circle USDC token, and calls `super()`.
 *
 * Boundaries:
 *   - imports ./types.js, ./base-adapter.js, viem/chains.
 *   - NO runtime imports from src/core/*, src/methods/*, src/routes/*.
 */

import type { Chain } from 'viem';
import { avalanche, avalancheFuji } from 'viem/chains';
import { ChainAdapterInitError, type ChainAdapter, type EIP3009Token } from './types.js';
import { BaseEip3009Adapter } from './base-adapter.js';

const FUJI_CHAIN_ID = 43113;
const AVALANCHE_MAINNET_CHAIN_ID = 43114;

// Canonical USDC on Avalanche Fuji testnet — documented in
// https://docs.avax.network/ (public, stable address).
// Kept as a module-level constant (NOT in env) per SDD DT-10 rationale.
const USDC_FUJI: EIP3009Token = {
  address: '0x5425890298aed601595a70AB815c96711a31Bc65',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  eip712Name: 'USD Coin',
  eip712Version: '2',
};

// Canonical native Circle USDC on Avalanche C-Chain mainnet (43114). Same
// EIP-712 shape as Fuji (Circle's contract template) — only the verifying
// contract address differs. Source: Circle docs (https://www.circle.com/usdc).
const USDC_AVALANCHE_MAINNET: EIP3009Token = {
  address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  eip712Name: 'USD Coin',
  eip712Version: '2',
};

/**
 * WFAC-53 FIX-4 — switch over literal union (DT-H). Removes the previous
 * `security/detect-object-injection` disable (CD-10, CD-13).
 */
type AvalancheRpcEnvName = 'AVALANCHE_FUJI_RPC_URL' | 'AVALANCHE_MAINNET_RPC_URL';

function readRpcUrl(envVarName: AvalancheRpcEnvName, chainIdNum: number): string {
  let value: string | undefined;
  switch (envVarName) {
    case 'AVALANCHE_FUJI_RPC_URL':
      value = process.env.AVALANCHE_FUJI_RPC_URL;
      break;
    case 'AVALANCHE_MAINNET_RPC_URL':
      value = process.env.AVALANCHE_MAINNET_RPC_URL;
      break;
  }
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(envVarName, chainIdNum);
  }
  return value;
}

/**
 * OP-04 (audit) — optional secondary RPC URL for RPC fallback. Returns the
 * trimmed `*_RPC_URL_FALLBACK` value, or undefined when unset/blank. `switch`
 * over the literal union avoids `security/detect-object-injection`.
 */
function readFallbackRpcUrl(envVarName: AvalancheRpcEnvName): string | undefined {
  let value: string | undefined;
  switch (envVarName) {
    case 'AVALANCHE_FUJI_RPC_URL':
      value = process.env.AVALANCHE_FUJI_RPC_URL_FALLBACK;
      break;
    case 'AVALANCHE_MAINNET_RPC_URL':
      value = process.env.AVALANCHE_MAINNET_RPC_URL_FALLBACK;
      break;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * WFAC-53 FIX-4 — single-case switch over the only literal currently
 * consumed in avalanche.ts. Eliminates the `security/detect-object-injection`
 * disable (CD-10, CD-13). If a new mainnet flag is added, extend the union.
 */
type AvalancheEnabledFlagEnvName = 'AVALANCHE_MAINNET_ENABLED';

function readEnabledFlag(envVarName: AvalancheEnabledFlagEnvName): boolean {
  let v: string | undefined;
  switch (envVarName) {
    case 'AVALANCHE_MAINNET_ENABLED':
      v = process.env.AVALANCHE_MAINNET_ENABLED;
      break;
  }
  return v === 'true';
}

class AvalancheAdapter extends BaseEip3009Adapter {
  constructor(opts: {
    chainIdNum: number;
    envVarName: AvalancheRpcEnvName;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
    token: EIP3009Token;
    viemChain: Chain;
  }) {
    const rpcUrl = readRpcUrl(opts.envVarName, opts.chainIdNum);
    const rpcUrlFallback = readFallbackRpcUrl(opts.envVarName);
    super({
      chainIdNum: opts.chainIdNum,
      name: opts.name,
      network: opts.network,
      rpcUrl,
      ...(rpcUrlFallback ? { rpcUrlFallback } : {}),
      viemChain: opts.viemChain,
      token: opts.token,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    });
  }
}

// Fuji adapter is opt-in: only instantiated if AVALANCHE_FUJI_RPC_URL is set.
// WFAC-52 delivered full real EIP-3009 settle + verify against Fuji RPC.
export const avalancheFujiAdapter: ChainAdapter | null = (() => {
  try {
    return new AvalancheAdapter({
      chainIdNum: FUJI_CHAIN_ID,
      envVarName: 'AVALANCHE_FUJI_RPC_URL',
      name: 'Avalanche Fuji',
      network: 'testnet',
      blockExplorer: 'https://testnet.snowtrace.io',
      token: USDC_FUJI,
      viemChain: avalancheFuji,
    });
  } catch {
    return null;
  }
})();

// Avalanche C-Chain mainnet adapter (PR feat/mainnet) — opt-in:
//   1. AVALANCHE_MAINNET_ENABLED=true (explicit operator opt-in).
//   2. AVALANCHE_MAINNET_RPC_URL set.
// Default behavior (any flag missing or false) → adapter is null and never
// registered. Existing testnet-only deployments see no change.
export const avalancheMainnetAdapter: ChainAdapter | null = (() => {
  if (!readEnabledFlag('AVALANCHE_MAINNET_ENABLED')) return null;
  try {
    return new AvalancheAdapter({
      chainIdNum: AVALANCHE_MAINNET_CHAIN_ID,
      envVarName: 'AVALANCHE_MAINNET_RPC_URL',
      name: 'Avalanche',
      network: 'mainnet',
      blockExplorer: 'https://snowtrace.io',
      token: USDC_AVALANCHE_MAINNET,
      viemChain: avalanche,
    });
  } catch {
    return null;
  }
})();
