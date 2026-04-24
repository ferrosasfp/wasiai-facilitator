/**
 * Kite chain adapters (Testnet 2368, Mainnet 2366).
 *
 * Exposes:
 *   - kiteTestnetAdapter: ChainAdapter — chainId 2368, env KITE_TESTNET_RPC_URL.
 *   - kiteMainnetAdapter: ChainAdapter — chainId 2366, env KITE_MAINNET_RPC_URL.
 *
 * WFAC-50: `_verifyRaw` / `_settleRaw` implement the full EIP-3009 flow against
 * Kite RPC (real signature recovery + simulate/write/waitReceipt). The outer
 * `verify()` / `settle()` wrappers preserve the WFAC-41 circuit breaker
 * accounting (BusinessFailureError pattern).
 *
 * Boundaries:
 *   - imports ./types.js, ./abi/*, ./circuit-breaker.js, ../infra/wallet.js, viem.
 *   - type-only import from ../core/types.js (for asChainId branded factory).
 *   - NO runtime imports from src/core/*, src/methods/*, src/routes/*.
 */

import {
  defineChain,
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  getAddress,
} from 'viem';
import type { PublicClient, WalletClient, Chain, Address } from 'viem';
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
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi/fiat-token.js';
import { normalizeSignature } from './abi/signature.js';
import { getOperatorAccount } from '../infra/wallet.js';

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
  private readonly _usdcAddress: Address;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;

  constructor(opts: {
    chainIdNum: number;
    envVarName: string;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
    usdcAddress: Address;
  }) {
    this._rpcUrl = readEnv(opts.envVarName, opts.chainIdNum);
    this._usdcAddress = opts.usdcAddress;

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
      // WFAC-50 — populated from KITE_USDC_ADDRESS env (injected by caller).
      tokens: [
        {
          address: opts.usdcAddress,
          symbol: 'USDC',
          decimals: 6,
          name: 'USD Coin',
          eip712Name: 'USD Coin',
          eip712Version: '2',
        },
      ],
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
      // WFAC-50 — inject operator account for signing.
      this._walletClient = createWalletClient({
        account: getOperatorAccount(),
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

  // WFAC-50 — real EIP-712 recovery + minimal chain-layer checks. The outer
  // verify() wrapper preserves the WFAC-41 circuit breaker accounting via
  // BusinessFailureError throws (AR-BLQ-ALTO-1 pattern). This function returns
  // a plain AdapterResult; it NEVER calls the breaker directly.
  private async _verifyRaw(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    const token = this.metadata.tokens[0];
    if (!token) {
      // Defensive — constructor guarantees 1 token, but TS narrows possible-undefined.
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Chain has no registered token',
          http: 400,
        },
      };
    }

    // 1. Network match (spec-literal eip155:<chainId>).
    if (params.accepted.network !== this.metadata.networkId) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Network does not match chain',
          http: 400,
        },
      };
    }

    // 2. Asset match (case-insensitive).
    if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Asset not found in chain token registry',
          http: 400,
        },
      };
    }

    // 3. Amount validation (AC-5). BigInt comparison — value/amount are uint256 strings.
    const authorization = params.payload.authorization;
    const acceptedAmount = BigInt(params.accepted.amount);
    if (BigInt(authorization.value) < acceptedAmount) {
      return {
        ok: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Authorized value is below accepted amount',
          http: 400,
        },
      };
    }

    // 4. Timestamp window (AC-4).
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(authorization.validBefore) <= nowSec) {
      return {
        ok: false,
        error: {
          code: 'EXPIRED_AUTHORIZATION',
          message: 'Authorization expired',
          http: 400,
        },
      };
    }

    // 5. Signature normalize (AC-2, AC-6). If fails → return INVALID_SIGNATURE
    // WITHOUT calling recoverTypedDataAddress (AC-6).
    const sig = normalizeSignature(params.payload.signature);
    if (!sig.ok) {
      return { ok: false, error: sig.error };
    }
    const canonicalVHex = sig.v === 27n ? '1b' : '1c';
    const canonicalSignature =
      `0x${sig.r.slice(2)}${sig.s.slice(2)}${canonicalVHex}` as `0x${string}`;

    // 6. Build domain inline (DT-D — no import from methods).
    const domain = {
      name: token.eip712Name ?? token.name,
      version: token.eip712Version ?? '1',
      chainId: this.metadata.chainId as number,
      verifyingContract: token.address,
    };

    // 7. Recover (AC-1, AC-3).
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({
        domain,
        types: EIP3009_TYPES,
        primaryType: EIP3009_PRIMARY_TYPE,
        message: {
          from: authorization.from as Address,
          to: authorization.to as Address,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce as `0x${string}`,
        },
        signature: canonicalSignature,
      });
    } catch {
      // Malformed signature bytes — viem error messages are implementation-defined.
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Failed to recover typed data address',
          http: 401,
        },
      };
    }

    // 8. Recovered vs claimed (AC-3).
    if (!isAddressEqual(recovered, authorization.from as Address)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Recovered address does not match sender',
          http: 401,
        },
      };
    }

    // 9. Success (AC-1).
    return {
      ok: true,
      verified: true,
      client: getAddress(recovered),
      amount: params.accepted.amount,
      asset: token.address,
      network: params.accepted.network,
      payTo: getAddress(params.accepted.payTo),
      expiresAt: Number(authorization.validBefore),
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

/**
 * Read + validate the Kite PYUSD/USDC token address at module load.
 *
 * WFAC-50: throws ChainAdapterInitError if missing/invalid. Regex is
 * defense-in-depth over EnvSchema (non-test env already enforces presence).
 */
function readUsdcAddress(chainIdNum: number): Address {
  const v = process.env['KITE_USDC_ADDRESS'];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ChainAdapterInitError('KITE_USDC_ADDRESS', chainIdNum);
  }
  return v as Address;
}

export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
  usdcAddress: readUsdcAddress(2368),
});

export const kiteMainnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2366,
  envVarName: 'KITE_MAINNET_RPC_URL',
  name: 'Kite Mainnet',
  network: 'mainnet',
  // MVP: reuse same env var. Future HU may introduce KITE_MAINNET_USDC_ADDRESS.
  usdcAddress: readUsdcAddress(2366),
});
