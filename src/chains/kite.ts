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
import {
  EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE,
  FIAT_TOKEN_ABI,
  RECEIPT_TIMEOUT_MS,
} from './abi/fiat-token.js';
import { normalizeSignature } from './abi/signature.js';
import { getOperatorAccount } from '../infra/wallet.js';

/**
 * Extract a safe, bounded-length string from an unknown error. Defensive
 * against viem errors that may embed request data in their `.message`.
 * Mirrors `src/methods/eip3009/settle.ts:43-46` (sanitize helper).
 */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

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
    /**
     * Token + EIP-712 domain overrides (mainnet support, PR feat/mainnet).
     *
     * Defaults preserve the original testnet PYUSD shape exactly so the
     * Kite Testnet adapter's metadata is byte-identical to PR #29 (no
     * regression on existing chain). Mainnet callers MUST pass:
     *   tokenSymbol='USDC.e', tokenName='USD Coin', tokenDecimals=6,
     *   eip712Name='USD Coin', eip712Version='2'.
     */
    tokenSymbol?: string;
    tokenName?: string;
    tokenDecimals?: number;
    eip712Name?: string;
    eip712Version?: string;
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

    // Default token metadata = Kite Testnet PYUSD (PR #29 shape preserved).
    // Mainnet adapter overrides each field — see `kiteMainnetAdapter` below.
    const tokenSymbol = opts.tokenSymbol ?? 'PYUSD';
    const tokenName = opts.tokenName ?? 'PYUSD';
    const tokenDecimals = opts.tokenDecimals ?? 18;
    const eip712Name = opts.eip712Name ?? 'PYUSD';
    const eip712Version = opts.eip712Version ?? '1';

    this.metadata = {
      chainId: asChainId(opts.chainIdNum),
      name: opts.name,
      network: opts.network,
      networkId: `eip155:${opts.chainIdNum}`,
      rpcUrl: this._rpcUrl,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      // WFAC-50 — populated from KITE_USDC_ADDRESS env (injected by caller).
      // PR feat/mainnet: token + domain fields are now constructor inputs so
      // the same KiteAdapter class can serve PYUSD (testnet) AND USDC.e
      // (mainnet) without forking the class.
      tokens: [
        {
          // Kite Testnet payment token is PYUSD (verified against live contract
          // DOMAIN_SEPARATOR on chain 2368 @ 0x8E04…ec9).
          // `version()` function reverts on-chain → hardcoded to '1'.
          address: opts.usdcAddress,
          symbol: tokenSymbol,
          decimals: tokenDecimals,
          name: tokenName,
          eip712Name,
          eip712Version,
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

  // WFAC-50 — real EIP-3009 transferWithAuthorization flow via viem. The outer
  // settle() wrapper preserves the WFAC-41 circuit breaker accounting via
  // BusinessFailureError throws (CD-NEW-SDD-3). This function returns a plain
  // AdapterResult — SIMULATION_FAILED / TRANSACTION_FAILED surface to the
  // wrap where they are converted to a thrown BusinessFailureError.
  private async _settleRaw(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    const token = this.metadata.tokens[0];
    if (!token) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Chain has no registered token',
          http: 400,
        },
      };
    }

    // 1. Defense-in-depth re-verify (DT-H). Mirror the first 4 steps of
    //    _verifyRaw so a mis-routed settle still rejects before RPC.
    const authorization = params.payload.authorization;

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

    // 2. Normalize signature — gates malleable/zero scalars before spending
    //    gas on a simulate. Shape matches _verifyRaw step 5.
    const sig = normalizeSignature(params.payload.signature);
    if (!sig.ok) {
      return { ok: false, error: sig.error };
    }
    const { r, s } = sig;
    const vNum = Number(sig.v); // 27 or 28

    // 3. Simulate (AC-7, CD-4). MUST run BEFORE writeContract.
    const publicClient = this.getPublicClient();
    const walletClient = this.getWalletClient();
    let simRequest: unknown;
    try {
      const sim = await publicClient.simulateContract({
        account: walletClient.account,
        address: token.address,
        abi: FIAT_TOKEN_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from as Address,
          authorization.to as Address,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce as `0x${string}`,
          vNum,
          r,
          s,
        ],
      });
      simRequest = sim.request;
    } catch (e) {
      return {
        ok: false,
        error: { code: 'SIMULATION_FAILED', message: sanitize(e), http: 500 },
      };
    }

    // 4. Write (AC-7, AC-11, CD-6). Use sim.request opaque — do NOT reconstruct.
    let hash: `0x${string}`;
    try {
      hash = await walletClient.writeContract(simRequest as never);
    } catch (e) {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: sanitize(e), http: 500 },
      };
    }

    // 5. Wait receipt (AC-7, AC-12).
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
    } catch (e) {
      const msg =
        e instanceof Error && e.name === 'WaitForTransactionReceiptTimeoutError'
          ? 'receipt timeout'
          : sanitize(e);
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: msg, http: 500 },
      };
    }

    // 6. Status (AC-13).
    if (receipt.status === 'reverted') {
      return {
        ok: false,
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'transaction reverted on-chain',
          http: 500,
        },
      };
    }

    // 7. Success (AC-7, AC-9). Fields from input params, NOT re-read from chain.
    return {
      ok: true,
      settled: true,
      transactionHash: hash,
      blockNumber: Number(receipt.blockNumber),
      amount: params.accepted.amount,
      from: authorization.from as Address,
      to: authorization.to as Address,
      asset: token.address,
    };
  }
}

/**
 * Read + validate a Kite token address from a named env var at module load.
 *
 * WFAC-50: throws ChainAdapterInitError if missing/invalid. Regex is
 * defense-in-depth over EnvSchema (non-test env already enforces presence).
 *
 * Testnet uses `KITE_USDC_ADDRESS` (PYUSD on Kite Testnet, 18 decimals).
 * Mainnet uses `KITE_MAINNET_USDC_ADDRESS` (USDC.e on Kite Mainnet, 6 decimals).
 */
function readUsdcAddress(envVarName: string, chainIdNum: number): Address {
  // eslint-disable-next-line security/detect-object-injection -- `envVarName` is a caller-controlled literal (one of KITE_USDC_ADDRESS / KITE_MAINNET_USDC_ADDRESS), not user input.
  const v = process.env[envVarName];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ChainAdapterInitError(envVarName, chainIdNum);
  }
  return v as Address;
}

/**
 * Read the boolean enabled flag for a mainnet chain. Default = false so the
 * facilitator preserves testnet-only behavior unless the operator explicitly
 * opts in. Mirrors the enum-string pattern used in src/infra/env.ts (the
 * Zod schema cannot be imported here per OWNERS — chains/* must not depend
 * on infra/* runtime).
 */
function readEnabledFlag(envVarName: string): boolean {
  // eslint-disable-next-line security/detect-object-injection -- caller-controlled literal env-var name, not user input.
  const v = process.env[envVarName];
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
// Default behavior (any flag missing or false) → adapter is null and never
// registered. Existing testnet-only deployments see no behavioral change.
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
