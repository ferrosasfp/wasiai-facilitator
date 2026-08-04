/**
 * Chain domain contracts for wasiai-facilitator.
 *
 * Exposes:
 *   - EIP3009Token: on-chain token metadata + EIP-712 domain fields.
 *   - ChainMetadata: readonly static data for a chain.
 *   - VerifyParams/VerifyResult/SettleParams/SettleResult: x402 spec shapes (direct).
 *   - AdapterResult<T>: alias for Result<T> (re-exported for consumers that don't want to import from core).
 *   - ChainAdapter: the 5-member interface every adapter must implement.
 *   - RegisterResult: shape returned by ChainRegistry.register().
 *   - ChainAdapterInitError: thrown at adapter construction if env vars missing.
 *
 * Boundaries (DT-12 of SDD 003):
 *   - type-only import from src/core/types.ts is allowed.
 *   - NO runtime imports from core/*.
 *   - Runtime: only viem.
 *
 * Future work:
 *   - WFAC-15+: multi-method (Permit2/ERC-7710) dispatch via assetTransferMethod union.
 */

import type { PublicClient, WalletClient } from 'viem';
import type { Logger } from 'pino';
import type { Result, Address, ChainId, X402ErrorCode } from '../core/types.js';

export interface EIP3009Token {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
}

/**
 * ChainMetadata — static readonly data for a chain.
 *
 * NOTE: breaker state is NOT stored here. WFAC-41 CR-BLQ-BAJO-2 (dead-field
 * removal): the `/supported` route fetches the live CB state per-request
 * via `adapter.getBreakerState?.()` (ducktype path in src/core/supported.ts).
 * Embedding a stale `breakerState` on the metadata object would be either
 * wrong (stale) or redundant (re-synced every call), so it is omitted from
 * the type entirely to keep the single-source-of-truth clear.
 */
export interface ChainMetadata {
  readonly chainId: ChainId;
  readonly name: string;
  readonly network: 'mainnet' | 'testnet';
  readonly networkId: string; // "eip155:<chainId>" (EVM) | "solana:<cluster>" (WKH-205)
  readonly rpcUrl: string;
  readonly blockExplorer?: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly tokens: readonly EIP3009Token[];
  /** WKH-204 — optional per-adapter method override; falls back to CHAIN_METHODS_DEFAULT. */
  readonly supportedMethods?: readonly string[];
}

// --- x402 spec shapes (DT-2 of SDD: direct, no wrappers) ---

export type AssetTransferMethod = 'eip3009' | 'permit2' | 'erc7710';

/**
 * WKH-323 — the `methods` value `GET /supported` publishes for the Solana rail.
 * `SolanaAdapter` sets it as its `ChainMetadata.supportedMethods`
 * (`src/chains/solana-adapter.ts`), so the `solana:<cluster>` entry reports this
 * string instead of falling back to `CHAIN_METHODS_DEFAULT`.
 *
 * Why it is NOT `eip3009`: EIP-3009 is an off-chain signed authorization that
 * *this* facilitator broadcasts on-chain. The Solana rail runs the other way
 * around — the payer already broadcast the SPL Token transfer and sends the
 * base58 signature; `SolanaAdapter.verify/settle` inspect that existing
 * transaction afterwards (net balance delta, exact mint pin, token program-id
 * pin, durable dedup). See `src/chains/solana-adapter.ts`.
 *
 * Why the `-finalized` suffix: the adapter reads the transaction with
 * `getTransaction(sig, { commitment: 'finalized' })` and does not retry at
 * `confirmed`/`processed` (`src/chains/solana-adapter.ts`, "Step 1 (CD-5)"),
 * so a request only succeeds when the transfer already exists on-chain at
 * finalized commitment.
 *
 * This facilitator DOES sign and broadcast SPL movements, but on dedicated
 * non-x402 routes — today `POST /solana/payout` (`src/routes/solana-payout.ts`),
 * `POST /solana/sponsor` (`src/routes/solana-sponsor.ts`) and
 * `POST /solana/escrow/release` (`src/routes/solana-escrow.ts`); facilitator as
 * TREASURER. Never on the `/verify` + `/settle` path this literal describes
 * (facilitator as WITNESS): that path only reads an already-broadcast tx.
 *
 * This string is a PUBLIC CONTRACT served by `GET /supported`: renaming it
 * breaks integrators that branch on `chains[].methods`. Pinned verbatim by
 * T-SOL-M2 in `src/__tests__/unit/chains/solana-adapter.test.ts`.
 */
export const SPL_TOKEN_TRANSFER_FINALIZED = 'spl-token-transfer-finalized' as const;

export interface VerifyParams {
  readonly x402Version: 2;
  readonly resource: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
  readonly accepted: {
    readonly scheme: 'exact';
    readonly network: string;
    readonly amount: string;
    readonly asset: string;
    readonly payTo: string;
    readonly maxTimeoutSeconds: number;
    readonly extra: {
      readonly assetTransferMethod: AssetTransferMethod;
      readonly name?: string;
      readonly version?: string;
    };
  };
  readonly payload: {
    readonly signature: `0x${string}`;
    readonly authorization: {
      readonly from: Address;
      readonly to: Address;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: `0x${string}`;
    };
  };
}

export interface VerifyResult {
  readonly verified: true;
  readonly client: Address;
  readonly amount: string;
  readonly asset: Address;
  readonly network: string;
  readonly payTo: Address;
  readonly expiresAt: number;
}

// SettleParams shares the same body shape as VerifyParams in x402 spec.
// Use type alias (not empty-extend interface) to avoid @typescript-eslint
// no-empty-interface warnings.
export type SettleParams = VerifyParams;

export interface SettleResult {
  readonly settled: true;
  readonly transactionHash: `0x${string}`;
  readonly blockNumber: number;
  readonly amount: string;
  readonly from: Address;
  readonly to: Address;
  readonly asset: Address;
}

/**
 * AdapterResult<T> === Result<T>. Re-exported alias so adapters/consumers
 * can rely on a single domain import.
 */
export type AdapterResult<T extends object> = Result<T>;

/**
 * WKH-204 (AC-4) — verify-only settlement contract. Money-moving methods that
 * do NOT require viem clients (getPublicClient/getWalletClient). Non-EVM rails
 * (Solana) auto-broadcast from the client wallet and have no operator broadcast
 * wallet in the EVM sense. This HU defines/types the interface; it does NOT
 * implement a real non-EVM adapter (CD-3).
 */
export interface SettlementAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  /**
   * Liveness sonda del RPC de ESTA chain — REQUIRED (never optional).
   *
   * Contract:
   *   - resolves (void) when the chain's RPC answered;
   *   - throws/rejects when it did not.
   *
   * WHY it lives on the adapter: `src/core/health-status.ts` used to probe every
   * registered adapter with two viem calls (`getPublicClient().getChainId()`),
   * which is impossible for a non-EVM adapter by construction — so Solana was
   * reported `rpc: 'unreachable'` forever and `/health` was permanently
   * `degraded: true`. A health module must NOT know about chain families; each
   * adapter answers for its own rail. Being REQUIRED (not `probeRpc?()`) is the
   * whole point: a new adapter cannot compile without a probe, so it can never
   * be silently mis-probed again.
   *
   * Implementation guidance: use the CHEAPEST round-trip available (node-config
   * data, not ledger state) — `eth_chainId` on EVM, `getVersion` on Solana. The
   * caller bounds the call with a short timeout and never awaits it on the
   * request path, so an implementation MUST NOT add retries/backoff of its own.
   */
  probeRpc(): Promise<void>;
  /**
   * WFAC-41 — optional introspection: current circuit breaker state for
   * this chain. Adapters that wrap verify/settle with ChainCircuitBreaker
   * (KiteAdapter, AvalancheFujiAdapter) expose this; stubs without breakers
   * may omit. Consumer (core/supported.ts) uses `typeof adapter.getBreakerState
   * === 'function'` before calling.
   *
   * Return value:
   *   - `'CLOSED' | 'OPEN' | 'HALF_OPEN'` when the breaker is enabled.
   *   - `undefined` when `CB_ENABLED=false` (passthrough mode) — the
   *     `/supported` serializer omits the `breakerState` field entirely
   *     for that adapter (AR-BLQ-BAJO-1 fix / DT-7).
   */
  getBreakerState?(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
  /**
   * WFAC-41 — optional logger injection (ducktype at buildApp init via
   * src/chains/init-breakers.ts). Adapters that own a ChainCircuitBreaker
   * forward the call to `breaker.setLogger(logger)`.
   */
  setLogger?(logger: Logger): void;
}

export interface ChainAdapter extends SettlementAdapter {
  getPublicClient(): PublicClient;
  getWalletClient(): WalletClient;
}

export type RegisterResult =
  | { readonly ok: true; readonly chainId: ChainId }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: X402ErrorCode;
        readonly message: string;
        readonly http: number;
      };
    };

/**
 * Thrown at adapter construction time when a required env var is missing.
 * Includes the exact env var name in the message (CD-15).
 */
export class ChainAdapterInitError extends Error {
  public readonly envVar: string;
  public readonly chainId: number;

  constructor(envVar: string, chainId: number) {
    super(
      `ChainAdapterInitError: required environment variable "${envVar}" is not set ` +
        `(needed for chainId ${chainId}).`,
    );
    this.name = 'ChainAdapterInitError';
    this.envVar = envVar;
    this.chainId = chainId;
  }
}
