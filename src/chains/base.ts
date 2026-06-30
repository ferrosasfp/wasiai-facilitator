/**
 * Base adapters (Sepolia testnet 84532, Mainnet 8453).
 *
 * Exposes:
 *   - baseSepoliaAdapter: ChainAdapter | null — chainId 84532.
 *     Opt-in: requires BASE_SEPOLIA_ENABLED=true AND BASE_SEPOLIA_RPC_URL.
 *   - baseMainnetAdapter: ChainAdapter | null — chainId 8453.
 *     Opt-in: requires BASE_MAINNET_ENABLED=true AND BASE_MAINNET_RPC_URL.
 *
 * WFAC-AUDIT AC-5: the full EIP-3009 flow now lives in `BaseEip3009Adapter`.
 * This file is a thin wrapper: it reads its env, selects the viem chain and
 * the canonical Circle USDC token, and calls `super()`.
 *
 * EIP-712 domain (verified on-chain via cast, 2026-05-19):
 *   - Sepolia USDC at 0x036C…F7e  → name="USDC",      version="2"
 *   - Mainnet USDC at 0x8335…913  → name="USD Coin",  version="2"
 *
 * Note: the testnet contract uses the literal symbol "USDC" as its EIP-712
 * `name` field (NOT "USD Coin"). The init-domain-check boot assertion would
 * refuse to boot on drift.
 *
 * Both chains default to OFF — operator must set the *_ENABLED flag AND the
 * corresponding RPC URL env var before either adapter is registered.
 *
 * Boundaries (OWNERS.md):
 *   - imports ./types.js, ./base-adapter.js, viem/chains.
 *   - NO runtime imports from src/core/*, src/methods/*, src/routes/*.
 */

import type { Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { ChainAdapterInitError, type ChainAdapter, type EIP3009Token } from './types.js';
import { BaseEip3009Adapter } from './base-adapter.js';

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_CHAIN_ID = 8453;

// Canonical Circle USDC on Base Sepolia testnet — documented in
// https://docs.base.org/ + verified against the live contract DOMAIN_SEPARATOR
// at 0x036CbD53842c5426634e7929541eC2318f3dCF7e on 2026-05-19.
//
// IMPORTANT: the testnet USDC uses the literal symbol "USDC" as its EIP-712
// `name` field. This is INTENTIONALLY different from Avalanche / Kite Mainnet
// USDC (which use "USD Coin"). The init-domain-check boot assertion will
// refuse to boot if the local separator does NOT match the chain.
const USDC_BASE_SEPOLIA: EIP3009Token = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  symbol: 'USDC',
  decimals: 6,
  name: 'USDC',
  eip712Name: 'USDC',
  eip712Version: '2',
};

// Canonical native Circle USDC on Base Mainnet (8453). Verified against the
// live contract at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on 2026-05-19
// via `cast call ... "name()(string)"` → "USD Coin", `"version()(string)"` → "2".
// Source: Circle docs (https://www.circle.com/usdc).
const USDC_BASE_MAINNET: EIP3009Token = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  eip712Name: 'USD Coin',
  eip712Version: '2',
};

/**
 * Switch over literal union (DT-H pattern from avalanche.ts). Removes the
 * `security/detect-object-injection` warning inline disables would require.
 */
type BaseRpcEnvName = 'BASE_SEPOLIA_RPC_URL' | 'BASE_MAINNET_RPC_URL';

function readRpcUrl(envVarName: BaseRpcEnvName, chainIdNum: number): string {
  let value: string | undefined;
  switch (envVarName) {
    case 'BASE_SEPOLIA_RPC_URL':
      value = process.env.BASE_SEPOLIA_RPC_URL;
      break;
    case 'BASE_MAINNET_RPC_URL':
      value = process.env.BASE_MAINNET_RPC_URL;
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
function readFallbackRpcUrl(envVarName: BaseRpcEnvName): string | undefined {
  let value: string | undefined;
  switch (envVarName) {
    case 'BASE_SEPOLIA_RPC_URL':
      value = process.env.BASE_SEPOLIA_RPC_URL_FALLBACK;
      break;
    case 'BASE_MAINNET_RPC_URL':
      value = process.env.BASE_MAINNET_RPC_URL_FALLBACK;
      break;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read the boolean enabled flag for a Base chain. Default = false so existing
 * deployments preserve byte-identical behavior — operator must explicitly opt
 * in to register a Base adapter. Mirrors avalanche.ts:readEnabledFlag.
 */
type BaseEnabledFlagEnvName = 'BASE_SEPOLIA_ENABLED' | 'BASE_MAINNET_ENABLED';

function readEnabledFlag(envVarName: BaseEnabledFlagEnvName): boolean {
  let v: string | undefined;
  switch (envVarName) {
    case 'BASE_SEPOLIA_ENABLED':
      v = process.env.BASE_SEPOLIA_ENABLED;
      break;
    case 'BASE_MAINNET_ENABLED':
      v = process.env.BASE_MAINNET_ENABLED;
      break;
  }
  return v === 'true';
}

class BaseAdapter extends BaseEip3009Adapter {
  constructor(opts: {
    chainIdNum: number;
    envVarName: BaseRpcEnvName;
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
      // Base is an Ethereum L2 — gas token is ETH (NOT BASE / native L2 token).
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
  }
}

// Base Sepolia adapter (WKH-105) — opt-in:
//   1. BASE_SEPOLIA_ENABLED=true (explicit operator opt-in).
//   2. BASE_SEPOLIA_RPC_URL set.
// Default behavior (any flag missing or false) → adapter is null and never
// registered. Existing testnet/mainnet deployments see no change.
export const baseSepoliaAdapter: ChainAdapter | null = (() => {
  if (!readEnabledFlag('BASE_SEPOLIA_ENABLED')) return null;
  try {
    return new BaseAdapter({
      chainIdNum: BASE_SEPOLIA_CHAIN_ID,
      envVarName: 'BASE_SEPOLIA_RPC_URL',
      name: 'Base Sepolia',
      network: 'testnet',
      blockExplorer: 'https://sepolia.basescan.org',
      token: USDC_BASE_SEPOLIA,
      viemChain: baseSepolia,
    });
  } catch {
    return null;
  }
})();

// Base Mainnet adapter (WKH-105) — opt-in:
//   1. BASE_MAINNET_ENABLED=true (explicit operator opt-in).
//   2. BASE_MAINNET_RPC_URL set.
// Default behavior (any flag missing or false) → adapter is null and never
// registered. Mainnet moves real money — only enable after Sepolia validation
// + explicit operator approval (CD-5 of work-item WKH-105).
export const baseMainnetAdapter: ChainAdapter | null = (() => {
  if (!readEnabledFlag('BASE_MAINNET_ENABLED')) return null;
  try {
    return new BaseAdapter({
      chainIdNum: BASE_MAINNET_CHAIN_ID,
      envVarName: 'BASE_MAINNET_RPC_URL',
      name: 'Base',
      network: 'mainnet',
      blockExplorer: 'https://basescan.org',
      token: USDC_BASE_MAINNET,
      viemChain: base,
    });
  } catch {
    return null;
  }
})();
