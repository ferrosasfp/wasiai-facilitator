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
import type { Result, Address, ChainId, X402ErrorCode } from '../core/types.js';

export interface EIP3009Token {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
}

export interface ChainMetadata {
  readonly chainId: ChainId;
  readonly name: string;
  readonly network: 'mainnet' | 'testnet';
  readonly networkId: string; // "eip155:<chainId>"
  readonly rpcUrl: string;
  readonly blockExplorer?: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly tokens: readonly EIP3009Token[];
}

// --- x402 spec shapes (DT-2 of SDD: direct, no wrappers) ---

export type AssetTransferMethod = 'eip3009' | 'permit2' | 'erc7710';

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

export interface ChainAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
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
