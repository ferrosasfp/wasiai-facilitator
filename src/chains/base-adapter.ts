/**
 * BaseEip3009Adapter — shared EIP-3009 chain adapter logic (WFAC-AUDIT AC-5).
 *
 * Deduplicates the byte-equivalent verify/settle/client/breaker machinery that
 * was copy-pasted across kite.ts, avalanche.ts and base.ts. Each concrete
 * adapter is now a thin wrapper that reads its env, builds its viem chain +
 * token, and calls `super({...})` — the protocol logic lives here ONCE.
 *
 * WFAC-AUDIT W3: this extraction is behavior-preserving. The methods below are
 * byte-equivalent moves from kite.ts (the exemplar). No new checks are added in
 * W3; the AC-4 checks (amount>0 / payTo==to / validAfter) are added in W4.
 *
 * Boundaries (OWNERS.md, same as the adapters it replaces):
 *   - imports ./types.js, ./abi/*, ./circuit-breaker.js, ../infra/wallet.js, viem.
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
import type { PublicClient, WalletClient, Chain, Address } from 'viem';
import type { Logger } from 'pino';
import {
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
 * Mirrors `src/methods/eip3009/settle.ts` (sanitize helper).
 */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

export interface BaseAdapterOpts {
  chainIdNum: number;
  name: string;
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  viemChain: Chain;
  token: EIP3009Token;
  blockExplorer?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export abstract class BaseEip3009Adapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  protected readonly _viemChain: Chain;
  protected readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  protected readonly _breaker: ChainCircuitBreaker;

  constructor(opts: BaseAdapterOpts) {
    this._rpcUrl = opts.rpcUrl;
    this._viemChain = opts.viemChain;

    this.metadata = {
      chainId: asChainId(opts.chainIdNum),
      name: opts.name,
      network: opts.network,
      networkId: `eip155:${opts.chainIdNum}`,
      rpcUrl: this._rpcUrl,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: opts.nativeCurrency,
      tokens: [opts.token],
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
  protected async _verifyRaw(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
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

    // 4 (WFAC-AUDIT AC-4 — NEW). amount > 0. Semantics copied from
    // methods/eip3009/verify.ts:98-103 (CD-6 read-only).
    if (acceptedAmount <= 0n) {
      return {
        ok: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Accepted amount must be greater than zero',
          http: 400,
        },
      };
    }

    // 5. value >= accepted.
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

    // 6 (WFAC-AUDIT AC-4 — NEW). payTo == authorization.to. Semantics copied
    // from methods/eip3009/verify.ts:112-117 (CD-6 read-only).
    if (!isAddressEqual(authorization.to as Address, params.accepted.payTo as Address)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_RECEIVER',
          message: 'Receiver does not match payTo',
          http: 400,
        },
      };
    }

    // 7. validBefore — expired (AC-4). BigInt (BLQ-MED-1).
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

    // 8 (WFAC-AUDIT AC-4 — NEW). validAfter — not yet valid. Semantics copied
    // from methods/eip3009/verify.ts:127-132 (CD-6 read-only).
    if (BigInt(authorization.validAfter) > nowSec) {
      return {
        ok: false,
        error: {
          code: 'EXPIRED_AUTHORIZATION',
          message: 'Authorization not yet valid',
          http: 400,
        },
      };
    }

    // 9. Signature normalize (AC-2, AC-6). If fails → return INVALID_SIGNATURE
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
  protected async _settleRaw(params: SettleParams): Promise<AdapterResult<SettleResult>> {
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

    // WFAC-AUDIT AC-4 (NEW) — amount > 0 (same order/semantics as _verifyRaw).
    if (acceptedAmount <= 0n) {
      return {
        ok: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Accepted amount must be greater than zero',
          http: 400,
        },
      };
    }
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

    // WFAC-AUDIT AC-4 (NEW) — payTo == authorization.to.
    if (!isAddressEqual(authorization.to as Address, params.accepted.payTo as Address)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_RECEIVER',
          message: 'Receiver does not match payTo',
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

    // WFAC-AUDIT AC-4 (NEW) — validAfter — not yet valid.
    if (BigInt(authorization.validAfter) > nowSec) {
      return {
        ok: false,
        error: {
          code: 'EXPIRED_AUTHORIZATION',
          message: 'Authorization not yet valid',
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
