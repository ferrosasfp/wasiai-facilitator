/**
 * Service-layer primitives for wasiai-facilitator.
 *
 * Exposes:
 *   - Ok<T> / Err / Result<T>: discriminated union for service-layer responses.
 *   - Address: branded 0x-prefixed hex string (aliases viem Hex for clarity).
 *   - ChainId: branded number to prevent accidental misuse.
 *   - asChainId: constructor guard — THROWS on invalid input (compile-time helper).
 *   - X402ErrorCode: union literal of exactly the 10 codes in x402 spec.
 *
 * Boundaries respected (OWNERS.md):
 *   - No imports from src/chains/*, src/methods/*, src/routes/*, src/infra/*.
 *   - Only primitives — no runtime deps.
 */

export type Address = `0x${string}`;

declare const __chainIdBrand: unique symbol;
export type ChainId = number & { readonly [__chainIdBrand]: 'ChainId' };

/**
 * Type-narrowing constructor for ChainId. Throws (not Result<T>) because
 * invalid chainIds are programmer errors, not runtime-expected failures.
 */
export function asChainId(n: number): ChainId {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid chainId: ${n} (must be positive integer)`);
  }
  return n as ChainId;
}

export type X402ErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID';

export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

/**
 * Ok<T> uses intersection with { ok: true } so specific result shapes can
 * extend it by adding their own discriminant-free fields.
 *
 *   type VerifyOk = Ok<{ verified: true; client: Address; ... }>
 *   → { ok: true; verified: true; client: Address; ... }
 */
export type Ok<T extends object> = { readonly ok: true } & T;

export type Result<T extends object> = Ok<T> | Err;
