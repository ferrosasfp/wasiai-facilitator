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
  fallback,
  isAddressEqual,
  recoverTypedDataAddress,
  getAddress,
} from 'viem';
import type { PublicClient, WalletClient, Chain, Address, Transport } from 'viem';
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
import { runExclusive } from './chain-mutex.js';
import { classifyChainError, tagBusiness, isTaggedBusiness } from './error-classifier.js';

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
  /**
   * OP-04 (audit) — optional secondary RPC URL. When provided (operator-set
   * via `*_RPC_URL_FALLBACK`), BOTH the read (public) and write (wallet/settle)
   * clients use a viem `fallback([...])` transport so a single RPC outage does
   * not take the chain offline.
   *
   * MNR-1 (audit2) — when this is ABSENT, a sane PUBLIC fallback is used for
   * known chainIds (see `publicFallbackRpcUrl`) but ONLY on the READ/verify
   * path. The WRITE/settle (wallet) transport NEVER gets a hardcoded public
   * default — it falls back only when this explicit operator opt-in is set.
   * Injecting a third-party public RPC into the mainnet broadcast path by
   * default would be a money-path trust expansion (a malicious/compromised
   * public RPC could censor/delay/feed-stale-views to a settle broadcast).
   */
  rpcUrlFallback?: string;
  viemChain: Chain;
  token: EIP3009Token;
  blockExplorer?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

/**
 * OP-04 — sane PUBLIC fallback RPC for known chainIds, used only when the
 * operator did NOT configure an explicit `*_RPC_URL_FALLBACK`. Returns
 * `undefined` for unknown chains (then the transport is primary-only).
 * `switch` over a numeric literal avoids `security/detect-object-injection`.
 */
export function publicFallbackRpcUrl(chainId: number): string | undefined {
  switch (chainId) {
    case 2368: // Kite Testnet
      return 'https://rpc-testnet.gokite.ai';
    case 2366: // Kite Mainnet
      return 'https://rpc-mainnet.gokite.ai';
    case 43113: // Avalanche Fuji
      return 'https://api.avax-test.network/ext/bc/C/rpc';
    case 43114: // Avalanche C-Chain
      return 'https://api.avax.network/ext/bc/C/rpc';
    case 84532: // Base Sepolia
      return 'https://sepolia.base.org';
    case 8453: // Base mainnet
      return 'https://mainnet.base.org';
    default:
      return undefined;
  }
}

export abstract class BaseEip3009Adapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  protected readonly _viemChain: Chain;
  protected readonly _rpcUrl: string;
  /**
   * MNR-1 — resolved secondary RPC URL for the READ/verify path (explicit env
   * fallback OR a sane public default for known chainIds), or undefined.
   */
  protected readonly _readRpcUrlFallback: string | undefined;
  /**
   * MNR-1 — resolved secondary RPC URL for the WRITE/settle path. ONLY the
   * explicit operator-set `*_RPC_URL_FALLBACK`; NEVER a hardcoded public
   * default. Undefined when the operator did not opt in.
   */
  protected readonly _writeRpcUrlFallback: string | undefined;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;
  protected readonly _breaker: ChainCircuitBreaker;

  constructor(opts: BaseAdapterOpts) {
    this._rpcUrl = opts.rpcUrl;
    this._viemChain = opts.viemChain;
    // MNR-1 — READ path: prefer the operator-supplied fallback; else a sane
    // public default for known chainIds. WRITE path: ONLY the explicit operator
    // opt-in — no hardcoded public default on the money/broadcast path.
    this._readRpcUrlFallback = opts.rpcUrlFallback ?? publicFallbackRpcUrl(opts.chainIdNum);
    this._writeRpcUrlFallback = opts.rpcUrlFallback;

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

  /**
   * OP-04 / MNR-1 — build the viem transport. When the given secondary RPC is
   * available (and distinct from the primary), use
   * `fallback([http(primary), http(secondary)])` so a primary RPC outage
   * transparently rolls over. Otherwise a plain `http(primary)` (preserves the
   * pre-audit single-RPC behavior).
   *
   * The caller passes the path-specific fallback: `_readRpcUrlFallback` for the
   * read/verify client (may be a public default) and `_writeRpcUrlFallback` for
   * the wallet/settle client (explicit operator opt-in only).
   */
  private _buildTransport(rpcUrlFallback: string | undefined): Transport {
    if (rpcUrlFallback && rpcUrlFallback !== this._rpcUrl) {
      return fallback([http(this._rpcUrl), http(rpcUrlFallback)]);
    }
    return http(this._rpcUrl);
  }

  getPublicClient(): PublicClient {
    if (!this._publicClient) {
      // READ/verify path — may use a sane public default fallback (MNR-1):
      // a stale read only costs a retry, never a bad settle.
      this._publicClient = createPublicClient({
        chain: this._viemChain,
        transport: this._buildTransport(this._readRpcUrlFallback),
      }) as PublicClient;
    }
    return this._publicClient;
  }

  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      // WFAC-50 — inject operator account for signing.
      // MNR-1 — WRITE/settle path: fallback ONLY on explicit operator opt-in;
      // never a hardcoded public default on the money/broadcast path.
      this._walletClient = createWalletClient({
        account: getOperatorAccount(),
        chain: this._viemChain,
        transport: this._buildTransport(this._writeRpcUrlFallback),
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
          // WKH-154: a failure tagged as business in _verifyRaw does NOT count
          // toward the breaker (return = resolved outcome for cockatiel).
          // Transport/ambiguous (untagged) DOES count (throw legacy). In
          // practice _verifyRaw does no RPC, so it never tags → identical to
          // today; the gate blinds the path if it ever gains RPC (CD-11).
          if (isTaggedBusiness(result)) {
            return result;
          }
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
          // WKH-154: contención/negocio tagueada en _settleRaw NO cuenta hacia el
          // breaker (return = outcome resuelto para cockatiel). Transporte/ambiguo
          // (sin tag) SÍ cuenta (throw legacy). Preserva la invariante 1↔1 (CD-11).
          if (isTaggedBusiness(result)) {
            return result;
          }
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

    // 3-7. On-chain section — simulate → write → wait → status → success.
    //
    // R-1 / OP-03 (audit): serialize this whole section PER CHAIN with
    // `runExclusive(chainId, ...)`. The operator signs every settle on a chain
    // with ONE account; viem reads the next account nonce lazily on each
    // writeContract. Two CONCURRENT DISTINCT settles on the same chain would
    // otherwise both read the same pending nonce and the second broadcast
    // reverts ("nonce too low"). Settles on DIFFERENT chains keep running in
    // parallel (independent operator nonces). The in-flight idempotency lock
    // does NOT cover this — it dedups IDENTICAL requests only.
    return runExclusive<AdapterResult<SettleResult>>(this.metadata.chainId as number, async () => {
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
        // WKH-154: same-account contention (gas/nonce/revert) surfaces here.
        // Tag it business so the wrapper resolves it as an outcome instead of
        // counting it toward the breaker. Transport/ambiguous stays untagged.
        const result: AdapterResult<SettleResult> = {
          ok: false,
          error: { code: 'SIMULATION_FAILED', message: sanitize(e), http: 500 },
        };
        if (classifyChainError(e) === 'business') tagBusiness(result);
        return result;
      }

      // 4. Write (AC-7, AC-11, CD-6). Use sim.request opaque — do NOT reconstruct.
      let hash: `0x${string}`;
      try {
        hash = await walletClient.writeContract(simRequest as never);
      } catch (e) {
        // WKH-154: business broadcast failures (nonce too low, already known)
        // are contention, not a chain outage — tag so they do not count.
        const result: AdapterResult<SettleResult> = {
          ok: false,
          error: { code: 'TRANSACTION_FAILED', message: sanitize(e), http: 500 },
        };
        if (classifyChainError(e) === 'business') tagBusiness(result);
        return result;
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
        // WKH-154: classify on the RAW `e` (not `msg`). A receipt timeout is a
        // transport signal → stays untagged → counts (legacy). A business
        // revert surfaced here is tagged → does not count.
        const result: AdapterResult<SettleResult> = {
          ok: false,
          error: { code: 'TRANSACTION_FAILED', message: msg, http: 500 },
        };
        if (classifyChainError(e) === 'business') tagBusiness(result);
        return result;
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
    });
  }
}
