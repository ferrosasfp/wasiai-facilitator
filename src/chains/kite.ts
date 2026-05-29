/**
 * Kite chain adapters (Testnet 2368, Mainnet 2366).
 *
 * Exposes:
 *   - kiteTestnetAdapter: ChainAdapter — chainId 2368, env KITE_TESTNET_RPC_URL.
 *   - kiteMainnetAdapter: ChainAdapter | null — chainId 2366, env KITE_MAINNET_RPC_URL.
 *
 * WFAC-AUDIT AC-5: the full EIP-3009 flow (verify/settle + circuit breaker)
 * now lives in `BaseEip3009Adapter`. This file is a thin wrapper: it reads its
 * env, builds the Kite viem chain + PYUSD/USDC.e token, and calls `super()`.
 *
 * Boundaries:
 *   - imports ./types.js, ./base-adapter.js, viem.
 *   - type-only import from ../core/types.js is NOT needed here (handled by base).
 *   - NO runtime imports from src/core/*, src/methods/*, src/routes/*.
 */

import { defineChain } from 'viem';
import type { Chain, Address } from 'viem';
import { ChainAdapterInitError, type ChainAdapter, type EIP3009Token } from './types.js';
import { BaseEip3009Adapter } from './base-adapter.js';

/**
 * WFAC-53 FIX-4 — switch over literal union (DT-H) eliminates the
 * `security/detect-object-injection` warning (CD-10, CD-13).
 */
type KiteRpcEnvName = 'KITE_TESTNET_RPC_URL' | 'KITE_MAINNET_RPC_URL';

function readEnv(name: KiteRpcEnvName, chainId: number): string {
  let value: string | undefined;
  switch (name) {
    case 'KITE_TESTNET_RPC_URL':
      value = process.env.KITE_TESTNET_RPC_URL;
      break;
    case 'KITE_MAINNET_RPC_URL':
      value = process.env.KITE_MAINNET_RPC_URL;
      break;
  }
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
  }
  return value;
}

class KiteAdapter extends BaseEip3009Adapter {
  // Token + EIP-712 domain overrides (mainnet, PR feat/mainnet). Defaults
  // preserve the testnet PYUSD shape so Kite Testnet metadata is byte-identical.
  constructor(opts: {
    chainIdNum: number;
    envVarName: KiteRpcEnvName;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
    usdcAddress: Address;
    tokenSymbol?: string;
    tokenName?: string;
    tokenDecimals?: number;
    eip712Name?: string;
    eip712Version?: string;
  }) {
    const rpcUrl = readEnv(opts.envVarName, opts.chainIdNum);

    const viemChain: Chain = defineChain({
      id: opts.chainIdNum,
      name: opts.name,
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      ...(opts.blockExplorer
        ? { blockExplorers: { default: { name: 'Explorer', url: opts.blockExplorer } } }
        : {}),
      testnet: opts.network === 'testnet',
    });

    // Default token metadata = Kite Testnet PYUSD (PR #29 shape preserved).
    // Mainnet adapter overrides each field — see `kiteMainnetAdapter` below.
    // Kite Testnet payment token is PYUSD (verified against live contract
    // DOMAIN_SEPARATOR on chain 2368 @ 0x8E04…ec9). `version()` reverts → '1'.
    const token: EIP3009Token = {
      address: opts.usdcAddress,
      symbol: opts.tokenSymbol ?? 'PYUSD',
      decimals: opts.tokenDecimals ?? 18,
      name: opts.tokenName ?? 'PYUSD',
      eip712Name: opts.eip712Name ?? 'PYUSD',
      eip712Version: opts.eip712Version ?? '1',
    };

    super({
      chainIdNum: opts.chainIdNum,
      name: opts.name,
      network: opts.network,
      rpcUrl,
      viemChain,
      token,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
    });
  }
}

/**
 * Read + validate a Kite token address from a named env var at module load.
 *
 * WFAC-50: throws ChainAdapterInitError if missing/invalid. Regex is
 * defense-in-depth over EnvSchema.
 *
 * Testnet uses `KITE_USDC_ADDRESS` (PYUSD on Kite Testnet, 18 decimals).
 * Mainnet uses `KITE_MAINNET_USDC_ADDRESS` (USDC.e on Kite Mainnet, 6 decimals).
 */
type KiteUsdcEnvName = 'KITE_USDC_ADDRESS' | 'KITE_MAINNET_USDC_ADDRESS';

function readUsdcAddress(envVarName: KiteUsdcEnvName, chainIdNum: number): Address {
  let v: string | undefined;
  switch (envVarName) {
    case 'KITE_USDC_ADDRESS':
      v = process.env.KITE_USDC_ADDRESS;
      break;
    case 'KITE_MAINNET_USDC_ADDRESS':
      v = process.env.KITE_MAINNET_USDC_ADDRESS;
      break;
  }
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ChainAdapterInitError(envVarName, chainIdNum);
  }
  return v as Address;
}

/**
 * WFAC-53 FIX-4 — single-case switch over the only literal currently
 * consumed in kite.ts. Eliminates the `security/detect-object-injection`
 * disable (CD-10, CD-13). If a new mainnet flag is added, extend the union.
 */
type KiteEnabledFlagEnvName = 'KITE_MAINNET_ENABLED';

function readEnabledFlag(envVarName: KiteEnabledFlagEnvName): boolean {
  let v: string | undefined;
  switch (envVarName) {
    case 'KITE_MAINNET_ENABLED':
      v = process.env.KITE_MAINNET_ENABLED;
      break;
  }
  return v === 'true';
}

export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
  usdcAddress: readUsdcAddress('KITE_USDC_ADDRESS', 2368),
});

// Mainnet adapter is opt-in: only registered if BOTH conditions hold:
//   1. KITE_MAINNET_ENABLED=true (explicit operator opt-in)
//   2. KITE_MAINNET_RPC_URL + KITE_MAINNET_USDC_ADDRESS are present
//
// Token: USDC.e on Kite Mainnet (6 decimals, separate from testnet PYUSD).
// EIP-712 domain name = 'USD Coin' / version = '2' — matches Circle's
// canonical bridged USDC.e contract metadata (verified against on-chain
// DOMAIN_SEPARATOR for Kite Mainnet 2366).
export const kiteMainnetAdapter: ChainAdapter | null = (() => {
  if (!readEnabledFlag('KITE_MAINNET_ENABLED')) return null;
  try {
    return new KiteAdapter({
      chainIdNum: 2366,
      envVarName: 'KITE_MAINNET_RPC_URL',
      name: 'Kite Mainnet',
      network: 'mainnet',
      usdcAddress: readUsdcAddress('KITE_MAINNET_USDC_ADDRESS', 2366),
      tokenSymbol: 'USDC.e',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
      eip712Name: 'USD Coin',
      eip712Version: '2',
    });
  } catch {
    return null;
  }
})();
