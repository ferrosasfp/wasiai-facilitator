/**
 * Avalanche adapters (Fuji testnet 43113, C-Chain mainnet 43114).
 *
 * Exposes:
 *   - avalancheFujiAdapter: ChainAdapter | null — chainId 43113, env AVALANCHE_FUJI_RPC_URL.
 *   - avalancheMainnetAdapter: ChainAdapter | null — chainId 43114, env AVALANCHE_MAINNET_RPC_URL.
 *     Opt-in: requires AVALANCHE_MAINNET_ENABLED=true AND AVALANCHE_MAINNET_RPC_URL.
 *
 * WFAC-52: `_verifyRaw` / `_settleRaw` implement the full EIP-3009 flow against
 * Avalanche RPC (real signature recovery + simulate/write/waitReceipt) using
 * the canonical Circle USDC. The outer `verify()` / `settle()` wrappers
 * preserve the WFAC-41 circuit breaker accounting (BusinessFailureError pattern,
 * AR-BLQ-ALTO-1).
 *
 * PR feat/mainnet: the AvalancheAdapter class is parametrized so the same code
 * serves Fuji (USDC, 6 decimals, eip712 'USD Coin' v2) AND mainnet (native
 * Circle USDC at 0xB97E…8a6E, same shape with a different verifying contract
 * address). Mainnet is opt-in via AVALANCHE_MAINNET_ENABLED=true so existing
 * deployments remain testnet-only by default.
 *
 * Boundaries:
 *   - imports ./types.js, ./abi/*, ./circuit-breaker.js, ../infra/wallet.js, viem, viem/chains.
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
import { avalanche, avalancheFuji } from 'viem/chains';
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
 * Mirrors `kite.ts:63` (sanitize helper).
 */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

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

function readRpcUrl(envVarName: string, chainIdNum: number): string {
  // eslint-disable-next-line security/detect-object-injection -- caller-controlled literal env-var name (AVALANCHE_FUJI_RPC_URL or AVALANCHE_MAINNET_RPC_URL), not user input.
  const value = process.env[envVarName];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(envVarName, chainIdNum);
  }
  return value;
}

/**
 * Read the boolean enabled flag for a mainnet chain. Default = false so the
 * facilitator preserves testnet-only behavior unless the operator opts in.
 * Mirrors kite.ts:readEnabledFlag (PR feat/mainnet — both adapters use the
 * same gating contract).
 */
function readEnabledFlag(envVarName: string): boolean {
  // eslint-disable-next-line security/detect-object-injection -- caller-controlled literal env-var name, not user input.
  const v = process.env[envVarName];
  return v === 'true';
}

class AvalancheAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _rpcUrl: string;
  private readonly _viemChain: Chain;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  private readonly _breaker: ChainCircuitBreaker;

  constructor(opts: {
    chainIdNum: number;
    envVarName: string;
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
      nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      tokens: [opts.token],
    };

    // WFAC-41 — per-chain circuit breaker. Defaults mirror the Zod schema
    // in src/infra/env.ts (CD-NEW-CB-HELPER-DEFAULTS). Adapters cannot
    // import env.ts (OWNERS); readCbNumber/readCbBool reuse the exact
    // same fallbacks.
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
      // WFAC-52 — inject operator account for signing (mirror kite.ts:159).
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
  // AR-BLQ-ALTO-1 fix: business failures (SIMULATION_FAILED /
  // TRANSACTION_FAILED — AC-13) are THROWN from inside the breaker's
  // `execute` lambda as `BusinessFailureError`. Cockatiel counts one
  // failure (clean 1:1 accounting); the outer catch unwraps `err.result`
  // back into an AdapterResult for the caller.
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

  // WFAC-52 — real EIP-712 recovery + chain-layer checks. Mirror of
  // kite.ts `_verifyRaw` (AC-1..AC-6). Differences vs Kite: token is
  // canonical Circle USDC on Fuji (6 decimals, eip712Version='2',
  // eip712Name='USD Coin'). Outer verify() wraps with circuit breaker
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

    // 6. Build EIP-712 domain inline. For Circle USDC on Fuji:
    //    name='USD Coin', version='2', chainId=43113, verifyingContract=USDC_FUJI.
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

  // WFAC-52 — real EIP-3009 transferWithAuthorization flow. Mirror of
  // kite.ts `_settleRaw` (AC-7..AC-13). Outer settle() wraps with circuit
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
