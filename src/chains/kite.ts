/**
 * Kite chain adapters (Testnet 2368, Mainnet 2366).
 *
 * Exposes:
 *   - kiteTestnetAdapter: ChainAdapter — chainId 2368, env KITE_TESTNET_RPC_URL.
 *   - kiteMainnetAdapter: ChainAdapter — chainId 2366, env KITE_MAINNET_RPC_URL.
 *
 * verify() and settle() are STUBS in this HU — they return NETWORK_MISMATCH
 * with a message pointing to WFAC-10/WFAC-11 (see DT-4 of SDD 003).
 *
 * Boundaries:
 *   - imports ./types.js + viem only.
 *   - NO imports from src/core/* (runtime), src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work:
 *   - WFAC-10: implement verify() (EIP-712 signature recovery).
 *   - WFAC-11: implement settle() (transferWithAuthorization on-chain).
 *   - WFAC-wallet-singleton: inject real account into getWalletClient().
 */

import { defineChain, createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient, Chain } from 'viem';
import type { Logger } from 'pino';
import {
  ChainAdapterInitError,
  type AdapterResult,
  type ChainAdapter,
  type ChainMetadata,
  type SettleParams,
  type SettleResult,
  type VerifyParams,
  type VerifyResult,
} from './types.js';
import { asChainId } from '../core/types.js';
import {
  ChainCircuitBreaker,
  BreakerOpenError,
  BusinessFailureError,
  readCbNumber,
  readCbBool,
  type BreakerStateName,
} from './circuit-breaker.js';

function readEnv(name: string, chainId: number): string {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a caller-controlled literal (one of KITE_TESTNET_RPC_URL / KITE_MAINNET_RPC_URL), not user input.
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
  }
  return value;
}

class KiteAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _viemChain: Chain;
  private readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;

  constructor(opts: {
    chainIdNum: number;
    envVarName: string;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
  }) {
    this._rpcUrl = readEnv(opts.envVarName, opts.chainIdNum);

    this._viemChain = defineChain({
      id: opts.chainIdNum,
      name: opts.name,
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      rpcUrls: { default: { http: [this._rpcUrl] } },
      ...(opts.blockExplorer
        ? { blockExplorers: { default: { name: 'Explorer', url: opts.blockExplorer } } }
        : {}),
      testnet: opts.network === 'testnet',
    });

    this.metadata = {
      chainId: asChainId(opts.chainIdNum),
      name: opts.name,
      network: opts.network,
      networkId: `eip155:${opts.chainIdNum}`,
      rpcUrl: this._rpcUrl,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      tokens: [], // W1: token list starts empty; WFAC-10 populates PYUSD etc.
    };

    // WFAC-41 — per-chain circuit breaker. Thresholds from env with
    // hardcoded defaults matching the Zod schema in src/infra/env.ts
    // (CD-NEW-CB-HELPER-DEFAULTS). Logger injected later via setLogger()
    // from initChainBreakers() in src/chains/init-breakers.ts.
    this._breaker = new ChainCircuitBreaker({
      chainId: opts.chainIdNum,
      chainName: opts.name,
      failureThreshold: readCbNumber('CB_FAILURE_THRESHOLD', 5),
      rollingWindowMs: readCbNumber('CB_ROLLING_WINDOW_MS', 30000),
      resetTimeoutMs: readCbNumber('CB_RESET_TIMEOUT_MS', 10000),
      enabled: readCbBool('CB_ENABLED', true),
    });
  }

  getPublicClient(): PublicClient {
    if (!this._publicClient) {
      this._publicClient = createPublicClient({
        chain: this._viemChain,
        transport: http(this._rpcUrl),
      }) as PublicClient;
    }
    return this._publicClient;
  }

  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      // TODO: WFAC-wallet-singleton — wallet real (con OPERATOR_PRIVATE_KEY) se inyecta
      // cuando exista src/infra/wallet.ts. Por ahora este client no puede firmar (account: undefined).
      this._walletClient = createWalletClient({
        chain: this._viemChain,
        transport: http(this._rpcUrl),
      }) as WalletClient;
    }
    return this._walletClient;
  }

  setLogger(logger: Logger): void {
    this._breaker.setLogger(logger);
  }

  getBreakerState(): BreakerStateName | undefined {
    return this._breaker.getState();
  }

  // ── verify split — CD-1 (wrap both verify and settle) ─────────────────
  //
  // AR-BLQ-ALTO-1 fix: _verifyRaw returns an AdapterResult normally; when
  // that result is a business failure (SIMULATION_FAILED / TRANSACTION_FAILED
  // — AC-13) we THROW a BusinessFailureError from INSIDE the breaker's
  // `execute` lambda. Cockatiel's SamplingBreaker counts that as ONE failure
  // (and nothing else). The outer try/catch unwraps `err.result` and returns
  // it to the caller — so from the caller's perspective the function still
  // returns an AdapterResult, but the breaker sees clean 1:1 accounting.
  async verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    try {
      return await this._breaker.execute(async () => {
        const result = await this._verifyRaw(params);
        if (
          !result.ok &&
          (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')
        ) {
          throw new BusinessFailureError(result, result.error.code);
        }
        return result;
      });
    } catch (err) {
      if (err instanceof BusinessFailureError) {
        // Unwrap — caller still sees an AdapterResult<VerifyResult>.
        return err.result as AdapterResult<VerifyResult>;
      }
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
      // Non-breaker, non-business error — propagate (routes have a defensive
      // try/catch around adapter calls; also breaker.execute has already
      // counted this toward the sampling window via cockatiel).
      throw err;
    }
  }

  private async _verifyRaw(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    // Stub body pre-WFAC-10. The outer verify() handles AC-13 accounting by
    // converting SIMULATION_FAILED / TRANSACTION_FAILED results into a
    // BusinessFailureError throw — _verifyRaw itself just returns the
    // AdapterResult, no breaker-side effects here (AR-BLQ-ALTO-1 fix).
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Verify not implemented yet (WFAC-10)',
        http: 400,
      },
    };
  }

  // ── settle split — mirror of verify ────────────────────────────────────
  async settle(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    try {
      return await this._breaker.execute(async () => {
        const result = await this._settleRaw(params);
        if (
          !result.ok &&
          (result.error.code === 'SIMULATION_FAILED' || result.error.code === 'TRANSACTION_FAILED')
        ) {
          throw new BusinessFailureError(result, result.error.code);
        }
        return result;
      });
    } catch (err) {
      if (err instanceof BusinessFailureError) {
        return err.result as AdapterResult<SettleResult>;
      }
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
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Settle not implemented yet (WFAC-11)',
        http: 400,
      },
    };
  }
}

export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
});

export const kiteMainnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2366,
  envVarName: 'KITE_MAINNET_RPC_URL',
  name: 'Kite Mainnet',
  network: 'mainnet',
});
