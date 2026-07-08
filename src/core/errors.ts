/**
 * Standard x402 error codes — canonical HTTP mapping + default messages.
 *
 * Spec reference: docs.x402.org — Facilitator error codes.
 * Conformance doc: doc/architecture/X402-CONFORMANCE.md §"Standard error codes".
 *
 * Exposes:
 *   - HTTP_BY_CODE: Record<X402ErrorCode, number> — exhaustive canonical mapping
 *     (compiler rejects missing variants; see AC-6 of WFAC-11).
 *   - DEFAULT_MESSAGE_BY_CODE: Record<X402ErrorCode, string> — exhaustive
 *     spec-literal defaults (no PII, no addresses, English).
 *   - buildX402Error(code, message?): pure constructor for Err['error'].
 *
 * Boundaries respected (OWNERS.md, CD-1 of WFAC-11):
 *   - No imports from src/chains/*, src/methods/*, src/routes/*, src/infra/*.
 *   - Only primitives — no runtime deps.
 *
 * Pureness (CD-4 of WFAC-11):
 *   - buildX402Error has no side effects, no logger, no I/O.
 *   - Same input always yields the same output.
 */

import type { Err, X402ErrorCode } from './types.js';

/**
 * Canonical HTTP status by x402 error code (spec-literal).
 *
 * Typed as `Record<X402ErrorCode, number>` (NOT `Partial<…>`, NOT `as const`)
 * so TypeScript rejects incomplete coverage at compile-time — satisfies CD-3
 * and AC-4/AC-6 of WFAC-11.
 *
 * Values mirror doc/architecture/X402-CONFORMANCE.md exactly:
 *   - INVALID_SIGNATURE          → 401 (auth failure)
 *   - INSUFFICIENT_BALANCE       → 402 (payment required)
 *   - PERMIT2_ALLOWANCE_REQUIRED → 412 (precondition failed; Permit2 method only)
 *   - EXPIRED_AUTHORIZATION      → 400 (bad request)
 *   - NETWORK_MISMATCH           → 400 (bad request)
 *   - SIMULATION_FAILED          → 500 (server-side simulation error)
 *   - INVALID_AMOUNT             → 400 (bad request)
 *   - INVALID_RECEIVER           → 400 (bad request)
 *   - TRANSACTION_FAILED         → 500 (on-chain execution failure)
 *   - DELEGATION_INVALID         → 401 (auth failure; ERC-7710 only)
 *   - CHAIN_UNAVAILABLE          → 503 (circuit breaker open, RPC not reachable; WFAC-41)
 */
export const HTTP_BY_CODE: Record<X402ErrorCode, number> = {
  INVALID_SIGNATURE: 401,
  INSUFFICIENT_BALANCE: 402,
  PERMIT2_ALLOWANCE_REQUIRED: 412,
  EXPIRED_AUTHORIZATION: 400,
  NETWORK_MISMATCH: 400,
  SIMULATION_FAILED: 500,
  INVALID_AMOUNT: 400,
  INVALID_RECEIVER: 400,
  TRANSACTION_FAILED: 500,
  DELEGATION_INVALID: 401,
  // WFAC-41 — circuit breaker open: HTTP 503 Service Unavailable.
  CHAIN_UNAVAILABLE: 503,
  // WKH-148 — operator wallet underfunded (relayer out of gas): HTTP 503.
  // Transient + operator-actionable (refuel), same class as CHAIN_UNAVAILABLE.
  OPERATOR_FUNDING_LOW: 503,
};

/**
 * Spec-literal default messages by x402 error code.
 *
 * Typed as `Record<X402ErrorCode, string>` for exhaustive coverage (CD-3).
 * Messages are:
 *   - English.
 *   - Free of PII (no addresses, no values, no chain IDs).
 *   - Descriptive of the failure class (caller may override with a more
 *     specific, still PII-free, message via the `message` argument of
 *     `buildX402Error`).
 */
export const DEFAULT_MESSAGE_BY_CODE: Record<X402ErrorCode, string> = {
  INVALID_SIGNATURE: 'Invalid signature',
  INSUFFICIENT_BALANCE: 'Insufficient balance',
  PERMIT2_ALLOWANCE_REQUIRED: 'Permit2 allowance required',
  EXPIRED_AUTHORIZATION: 'Authorization expired or not yet valid',
  NETWORK_MISMATCH: 'Network does not match',
  SIMULATION_FAILED: 'Simulation failed',
  INVALID_AMOUNT: 'Invalid amount',
  INVALID_RECEIVER: 'Invalid receiver',
  TRANSACTION_FAILED: 'Transaction failed',
  DELEGATION_INVALID: 'Delegation invalid',
  // WFAC-41 — circuit breaker open: transient RPC unreachability.
  CHAIN_UNAVAILABLE: 'Chain RPC temporarily unavailable',
  // WKH-148 — operator underfunded. PII-free: NO address, NO balance, NO chain
  // ID (those go to the server-side log only; CD-4). Generic + transient.
  OPERATOR_FUNDING_LOW: 'Settlement temporarily unavailable',
};

/**
 * Construct an `Err['error']` payload for a given x402 code.
 *
 * Pure: no logger, no side effects, no I/O (CD-4).
 *
 * @param code - one of the 10 canonical `X402ErrorCode` values (TS-enforced).
 * @param message - optional override. When omitted, uses `DEFAULT_MESSAGE_BY_CODE[code]`.
 *                  When present, used verbatim (empty string is preserved).
 * @returns `{ code, message, http }` shape matching `Err['error']`.
 *
 * @example
 *   buildX402Error('INVALID_SIGNATURE');
 *   // → { code: 'INVALID_SIGNATURE', message: 'Invalid signature', http: 401 }
 *
 *   buildX402Error('INVALID_AMOUNT', 'Authorized value is below accepted amount');
 *   // → { code: 'INVALID_AMOUNT', message: 'Authorized value is below accepted amount', http: 400 }
 */
export function buildX402Error(code: X402ErrorCode, message?: string): Err['error'] {
  return {
    code,
    // eslint-disable-next-line security/detect-object-injection -- `code` is typed as `X402ErrorCode` (finite union); DEFAULT_MESSAGE_BY_CODE is `Record<X402ErrorCode, string>` — the lookup is compile-time-exhaustive.
    message: message ?? DEFAULT_MESSAGE_BY_CODE[code],
    // eslint-disable-next-line security/detect-object-injection -- `code` is typed as `X402ErrorCode` (finite union); HTTP_BY_CODE is `Record<X402ErrorCode, number>` — the lookup is compile-time-exhaustive.
    http: HTTP_BY_CODE[code],
  };
}
