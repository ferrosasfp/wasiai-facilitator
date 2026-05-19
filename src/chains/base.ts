/**
 * Base adapters (Sepolia testnet 84532, Mainnet 8453).
 *
 * Exposes:
 *   - baseSepoliaAdapter: ChainAdapter | null — chainId 84532.
 *     Opt-in: requires BASE_SEPOLIA_ENABLED=true AND BASE_SEPOLIA_RPC_URL.
 *   - baseMainnetAdapter: ChainAdapter | null — chainId 8453.
 *     Opt-in: requires BASE_MAINNET_ENABLED=true AND BASE_MAINNET_RPC_URL.
 *
 * WKH-105 (BASE-02): direct mirror of `avalanche.ts` — same circuit breaker
 * accounting, same EIP-3009 flow (real signature recovery + simulate/write/
 * waitReceipt) against Circle's canonical USDC contracts on Base.
 *
 * EIP-712 domain (verified on-chain via cast, 2026-05-19):
 *   - Sepolia USDC at 0x036C…F7e  → name="USDC",      version="2"
 *   - Mainnet USDC at 0x8335…913  → name="USD Coin",  version="2"
 *
 * Note: the testnet contract uses the literal symbol "USDC" as its EIP-712
 * `name` field (NOT "USD Coin"). This differs from the production Circle
 * USDC contract on mainnet — both are documented above and confirmed
 * against `name()` / `version()` view fns. The init-domain-check boot
 * assertion (init-domain-check.ts) would refuse to boot on drift.
 *
 * Both chains default to OFF — existing Kite + Avalanche deployments are
 * byte-identical post this PR. Operator must set the *_ENABLED flag AND
 * the corresponding RPC URL env var before either adapter is registered.
 *
 * Boundaries (OWNERS.md):
 *   - imports ./types.js, ./abi/*, ./circuit-breaker.js, ../infra/wallet.js,
 *     viem, viem/chains.
 *   - type-only import from ../core/types.js (for asChainId branded factory).
 *   - NO runtime imports from src/core/*, src/methods/*, src/routes/*.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  getAddress,
} from 'viem';
import type { PublicClient, WalletClient, Address, Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
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
 * Mirrors `avalanche.ts:72` (sanitize helper).
 */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

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
 * Switch over literal union (DT-H pattern from avalanche.ts:108-124).
 * Removes the `security/detect-object-injection` warning that inline
 * disables would otherwise require (CD-10, CD-13).
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
 * Read the boolean enabled flag for a Base chain. Default = false so
 * existing deployments preserve byte-identical behavior — operator must
 * explicitly opt in to register a Base adapter.
 *
 * Mirrors avalanche.ts:140-148 (single-case switch over literal union).
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

class BaseAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _rpcUrl: string;
  private readonly _viemChain: Chain;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;

  constructor(opts: {
    chainIdNum: number;
    envVarName: BaseRpcEnvName;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
    token: EIP3009Token;
    viemChain: Chain;
  }) {
    this._rpcUrl = readRpcUrl(opts.envVarName, opts.chainIdNum);
    this._viemChain = opts.viemChain;
    this.metadata = {
      chainId: asChainId(opts.chainIdNum),
      name: opts.name,
      network: opts.network,
      networkId: `eip155:${opts.chainIdNum}`,
      rpcUrl: this._rpcUrl,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      // Base is an Ethereum L2 — gas token is ETH (NOT BASE / native L2 token).
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [opts.token],
    };

    // Per-chain circuit breaker — defaults mirror the Zod schema in
    // src/infra/env.ts (CD-NEW-CB-HELPER-DEFAULTS). Adapters cannot import
    // env.ts (OWNERS); readCbNumber/readCbBool reuse the exact same fallbacks.
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
  // AR-BLQ-ALTO-1 pattern: business failures (SIMULATION_FAILED /
  // TRANSACTION_FAILED) are THROWN from inside the breaker's `execute`
  // lambda as `BusinessFailureError`. Cockatiel counts one failure (clean
  // 1:1 accounting); the outer catch unwraps `err.result` back into an
  // AdapterResult for the caller.
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
      throw err;
    }
  }

  // Real EIP-712 recovery + chain-layer checks. Mirror of
  // avalanche.ts `_verifyRaw`. Outer verify() wraps with circuit breaker
  // (BusinessFailureError pattern, AR-BLQ-ALTO-1).
  private async _verifyRaw(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
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

    // 1. Network match.
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

    // 2. Asset match.
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

    // 3. Amount validation.
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

    // 4. Timestamp window.
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

    // 5. Signature normalize.
    const sig = normalizeSignature(params.payload.signature);
    if (!sig.ok) {
      return { ok: false, error: sig.error };
    }
    const canonicalVHex = sig.v === 27n ? '1b' : '1c';
    const canonicalSignature =
      `0x${sig.r.slice(2)}${sig.s.slice(2)}${canonicalVHex}` as `0x${string}`;

    // 6. Build EIP-712 domain inline. For Circle USDC on Base:
    //    Sepolia: name='USDC',      version='2', chainId=84532
    //    Mainnet: name='USD Coin',  version='2', chainId=8453
    //    Both differ on `name` — see USDC_BASE_SEPOLIA / USDC_BASE_MAINNET above.
    const domain = {
      name: token.eip712Name ?? token.name,
      version: token.eip712Version ?? '1',
      chainId: this.metadata.chainId as number,
      verifyingContract: token.address,
    };

    // 7. Recover signer from EIP-712 typed data.
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
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Failed to recover typed data address',
          http: 401,
        },
      };
    }

    // 8. Recovered must equal claimed sender.
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

    // 9. Success.
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

  // Real EIP-3009 transferWithAuthorization flow. Mirror of
  // avalanche.ts `_settleRaw`. Outer settle() wraps with circuit
  // breaker (BusinessFailureError pattern, CD-NEW-SDD-3).
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

    // 1. Defense-in-depth re-verify (DT-H). Mirror first 4 steps of _verifyRaw.
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

    // 2. Normalize signature — gates malleable/zero scalars before spending gas.
    const sig = normalizeSignature(params.payload.signature);
    if (!sig.ok) {
      return { ok: false, error: sig.error };
    }
    const { r, s } = sig;
    const vNum = Number(sig.v); // 27 or 28

    // 3. Simulate. MUST run BEFORE writeContract.
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

    // 4. Write. Use sim.request opaque — do NOT reconstruct.
    let hash: `0x${string}`;
    try {
      hash = await walletClient.writeContract(simRequest as never);
    } catch (e) {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: sanitize(e), http: 500 },
      };
    }

    // 5. Wait receipt.
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

    // 6. Status.
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

    // 7. Success.
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
