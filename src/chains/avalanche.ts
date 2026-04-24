/**
 * Avalanche Fuji testnet adapter (chainId 43113).
 *
 * Exposes:
 *   - avalancheFujiAdapter: ChainAdapter — chainId 43113, env AVALANCHE_FUJI_RPC_URL.
 *
 * verify() and settle() are STUBS — return NETWORK_MISMATCH pending WFAC-52.
 *
 * Boundaries:
 *   - imports ./types.js + viem + viem/chains (for canonical avalancheFuji def).
 *   - NO imports from src/core/* (runtime), src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work: WFAC-52 implements real verify/settle for Fuji USDC.
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { avalancheFuji } from 'viem/chains';
import type { Logger } from 'pino';
import {
  ChainAdapterInitError,
  type AdapterResult,
  type ChainAdapter,
  type ChainMetadata,
  type EIP3009Token,
  type SettleParams,
  type SettleResult,
  type VerifyParams,
  type VerifyResult,
} from './types.js';
import { asChainId } from '../core/types.js';
import {
  ChainCircuitBreaker,
  BreakerOpenError,
  readCbNumber,
  readCbBool,
  type BreakerStateName,
} from './circuit-breaker.js';

const FUJI_CHAIN_ID = 43113;

// Canonical USDC on Avalanche Fuji — documented in
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

function readRpcUrl(): string {
  const value = process.env['AVALANCHE_FUJI_RPC_URL'];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError('AVALANCHE_FUJI_RPC_URL', FUJI_CHAIN_ID);
  }
  return value;
}

class AvalancheFujiAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;

  constructor() {
    this._rpcUrl = readRpcUrl();
    this.metadata = {
      chainId: asChainId(FUJI_CHAIN_ID),
      name: 'Avalanche Fuji',
      network: 'testnet',
      networkId: `eip155:${FUJI_CHAIN_ID}`,
      rpcUrl: this._rpcUrl,
      blockExplorer: 'https://testnet.snowtrace.io',
      nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      tokens: [USDC_FUJI],
    };

    // WFAC-41 — per-chain circuit breaker. Defaults mirror the Zod schema
    // in src/infra/env.ts (CD-NEW-CB-HELPER-DEFAULTS). Adapters cannot
    // import env.ts (OWNERS); readCbNumber/readCbBool reuse the exact
    // same fallbacks.
    this._breaker = new ChainCircuitBreaker({
      chainId: FUJI_CHAIN_ID,
      chainName: 'Avalanche Fuji',
      failureThreshold: readCbNumber('CB_FAILURE_THRESHOLD', 5),
      rollingWindowMs: readCbNumber('CB_ROLLING_WINDOW_MS', 30000),
      resetTimeoutMs: readCbNumber('CB_RESET_TIMEOUT_MS', 10000),
      enabled: readCbBool('CB_ENABLED', true),
    });
  }

  getPublicClient(): PublicClient {
    if (!this._publicClient) {
      this._publicClient = createPublicClient({
        chain: avalancheFuji,
        transport: http(this._rpcUrl),
      }) as PublicClient;
    }
    return this._publicClient;
  }

  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      // TODO: WFAC-wallet-singleton — wallet real (OPERATOR_PRIVATE_KEY) se inyecta
      // cuando exista src/infra/wallet.ts. Por ahora este client no puede firmar (account: undefined).
      this._walletClient = createWalletClient({
        chain: avalancheFuji,
        transport: http(this._rpcUrl),
      }) as WalletClient;
    }
    return this._walletClient;
  }

  setLogger(logger: Logger): void {
    this._breaker.setLogger(logger);
  }

  getBreakerState(): BreakerStateName {
    return this._breaker.getState();
  }

  // ── verify split — CD-1 (wrap both verify and settle) ─────────────────
  async verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    try {
      return await this._breaker.execute(() => this._verifyRaw(params));
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        return {
          ok: false,
          error: {
            code: 'CHAIN_UNAVAILABLE',
            message: 'Chain RPC temporarily unavailable',
            http: 503,
            retryAfterMs: err.remainingMs,
          },
        };
      }
      throw err;
    }
  }

  private async _verifyRaw(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    const result: AdapterResult<VerifyResult> = {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Verify not implemented yet (WFAC-52)',
        http: 400,
      },
    };
    // AC-13 — count business-level failures toward breaker.
    if (
      !result.ok &&
      (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')
    ) {
      this._breaker.recordBusinessFailure(result.error.code);
    }
    return result;
  }

  // ── settle split — mirror of verify ────────────────────────────────────
  async settle(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    try {
      return await this._breaker.execute(() => this._settleRaw(params));
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        return {
          ok: false,
          error: {
            code: 'CHAIN_UNAVAILABLE',
            message: 'Chain RPC temporarily unavailable',
            http: 503,
            retryAfterMs: err.remainingMs,
          },
        };
      }
      throw err;
    }
  }

  private async _settleRaw(_params: SettleParams): Promise<AdapterResult<SettleResult>> {
    const result: AdapterResult<SettleResult> = {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Settle not implemented yet (WFAC-52)',
        http: 400,
      },
    };
    if (
      !result.ok &&
      (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')
    ) {
      this._breaker.recordBusinessFailure(result.error.code);
    }
    return result;
  }
}

export const avalancheFujiAdapter: ChainAdapter = new AvalancheFujiAdapter();
