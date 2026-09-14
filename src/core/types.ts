/**
 * Service-layer primitives for wasiai-facilitator.
 *
 * Exposes:
 *   - Ok<T> / Err / Result<T>: discriminated union for service-layer responses.
 *   - Address: branded 0x-prefixed hex string (aliases viem Hex for clarity).
 *   - ChainId: branded number to prevent accidental misuse.
 *   - asChainId: constructor guard — THROWS on invalid input (compile-time helper).
 *   - X402ErrorCode: union literal of exactly the 11 codes (10 x402 spec +
 *     CHAIN_UNAVAILABLE WFAC-41 DT-3 Opción B).
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

/** Network namespace prefix (before the first ':' in a networkId). */
export type NetworkNamespace = 'eip155' | 'solana' | 'casper';

/** Full network identifier string, e.g. "eip155:2368" | "solana:devnet". */
export type NetworkId = string;

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
  | 'DELEGATION_INVALID'
  // WFAC-41 (DT-3 Opción B) — circuit breaker open: facilitator cannot reach
  // the RPC for this chain. HTTP 503. Populated by ChainAdapter.verify/settle
  // when the per-chain breaker is in OPEN state (src/chains/circuit-breaker.ts).
  | 'CHAIN_UNAVAILABLE'
  // WKH-148 (DT-3) — operator (relayer) wallet native balance below the
  // configured OPERATOR_MIN_BALANCE_WEI threshold. HTTP 503. Populated by the
  // read-only pre-check in _settleRaw (src/chains/base-adapter.ts) BEFORE any
  // simulateContract/writeContract — a transient, operator-actionable condition
  // (refuel gas), NOT a settle execution failure. The 12th facilitator code
  // (10 x402 spec + CHAIN_UNAVAILABLE + this).
  | 'OPERATOR_FUNDING_LOW';

export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
    /**
     * WFAC-41 (DT-10) — populated ONLY when `code === 'CHAIN_UNAVAILABLE'`.
     * Used by route layer to compute `Retry-After` HTTP header. NEVER serialized
     * in the JSON response body (CD-NEW-CB-RETRY-AFTER-INTERNAL).
     */
    readonly retryAfterMs?: number;
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
