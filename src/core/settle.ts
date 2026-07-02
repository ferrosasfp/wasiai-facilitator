/**
 * POST /settle orchestrator — stateless, pure (no I/O except adapter call).
 *
 * Flow (espejo exacto de src/core/verify.ts):
 *   1. Parse `accepted.network` with regex /^eip155:([1-9]\d*)$/ (CD-13 heredado).
 *      - Overflow guard (CD-14 heredado): if the numeric string exceeds safe
 *        integer range, return NETWORK_MISMATCH.
 *   2. Enforce assetTransferMethod === 'eip3009' (only method supported in v1).
 *   3. chainRegistry.getAdapter(chainId) → passthrough error if miss.
 *   4. adapter.settle(parsed as SettleParams) → passthrough result.
 *
 * NEVER throws for foreseeable errors (CD-4). Adapter exceptions propagate
 * (route handles via L4 log + 500 response).
 *
 * Boundary (OWNERS):
 *   - MAY import: ./types.js, ./errors.js, ./schemas.js (type-only),
 *     ../chains/registry.js (runtime), ../chains/types.js (type-only).
 *   - MUST NOT import: src/routes/*, src/methods/*, src/infra/*.
 */

import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { SettleParams, SettleResult } from '../chains/types.js';
import { checkSettleAmountCap } from './settle-cap.js';

// CD-13 heredado. NOTE: this regex and the MAX_CHAINID_DIGITS constant are
// duplicated from src/core/verify.ts ON PURPOSE for WFAC-21. Factoring them
// to a shared `src/core/network.ts` is OUT OF SCOPE (§4.1 "DO NOT"). Open a
// follow-up HU if a third consumer appears.
const EIP155_RE = /^eip155:([1-9]\d*)$/u;
const MAX_CHAINID_DIGITS = 16; // matches verify.ts

export async function settleCore(
  parsed: VerifyRequest, // alias by value: SettleRequest (SDD §DT-1)
  options?: { maxAmountAtomic?: string },
): Promise<Result<SettleResult>> {
  // Step 0 — per-request amount cap (anti-abuse, public sharing hardening).
  // Rejects settles above the configured maximum BEFORE hitting the chain.
  //
  // The cap MUST top the amount that is REALLY settled on-chain, which is the
  // signed EIP-3009 `authorization.value` (see base-adapter transfer args:
  // `value: BigInt(authorization.value)`), NOT the declared `accepted.amount`.
  // `verify` only guarantees `value >= accepted` (a lower bound), so capping
  // `accepted.amount` would be EVADIBLE: a caller could declare a tiny
  // `accepted.amount` under the cap while signing an arbitrarily large `value`,
  // and the facilitator would liquidate that large `value`. Capping `value`
  // (>= accepted by the invariant) closes that hole; for a legitimate settle
  // where `value === accepted`, this is identical to the previous behavior.
  if (options?.maxAmountAtomic !== undefined) {
    const capCheck = checkSettleAmountCap(
      parsed.payload.authorization.value,
      options.maxAmountAtomic,
    );
    if (!capCheck.ok) {
      return {
        ok: false,
        error: buildX402Error(
          'INVALID_AMOUNT',
          `amount exceeds per-settle cap (${capCheck.limit.toString()} atomic units)`,
        ),
      };
    }
  }

  // Step 1 — parse network
  const m = EIP155_RE.exec(parsed.accepted.network);
  // The regex is anchored and has a single capturing group that always
  // matches at least one digit (`[1-9]\d*`) when `m` is non-null.
  if (m === null || m[1] === undefined) {
    return {
      ok: false,
      error: buildX402Error(
        'NETWORK_MISMATCH',
        'network must be eip155:<chainId> with a positive integer',
      ),
    };
  }
  const digits = m[1];

  // CD-14 heredado: don't trust Number() for chainId beyond MAX_SAFE_INTEGER.
  if (digits.length > MAX_CHAINID_DIGITS || BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'chainId out of safe integer range'),
    };
  }
  // asChainId is safe here — digits passed both guards (positive int, within
  // MAX_SAFE_INTEGER). If you find yourself needing a try/catch around it,
  // you're adding unreachable code (WFAC-20 auto-blindaje W4 lesson).
  const chainId = asChainId(Number(digits));

  // Step 2 — method guard (SDD §DT-6)
  if (parsed.accepted.extra.assetTransferMethod !== 'eip3009') {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'Method not supported: only eip3009 in v1'),
    };
  }

  // Step 3 — registry lookup
  const lookup = chainRegistry.getAdapter(chainId);
  if (!lookup.ok) {
    return { ok: false, error: lookup.error };
  }

  // Step 4 — dispatch to adapter.settle
  // SettleRequest is structurally assignable to SettleParams (= VerifyParams)
  // with the same caveat as verifyCore: Zod `.regex()` narrows a string, not
  // a template literal type. The cast `as unknown as SettleParams` is the
  // sanctioned workaround (WFAC-20 auto-blindaje entry 4).
  //
  // If this cast breaks at build time, STOP AND REPORT — do NOT widen to
  // `any`. The schemas in W0 must stay in sync with SettleParams.
  const params: SettleParams = parsed as unknown as SettleParams;

  // NO try/catch here: adapter throws propagate to the route (CD-4 intent +
  // SDD §DT-8: "throws = bug; caught as defense-in-depth in the route L4").
  return lookup.adapter.settle(params);
}
