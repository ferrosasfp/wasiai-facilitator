/**
 * POST /verify orchestrator — stateless, pure (no I/O except the adapter
 * call it delegates to).
 *
 * Flow:
 *   1. Parse `accepted.network` with regex /^eip155:([1-9]\d*)$/ (CD-13).
 *      - Overflow guard (CD-14): if the numeric string exceeds safe
 *        integer range (BigInt > Number.MAX_SAFE_INTEGER), return
 *        NETWORK_MISMATCH.
 *   2. Enforce `accepted.extra.assetTransferMethod === 'eip3009'`
 *      (only method supported in v1).
 *   3. chainRegistry.getAdapter(chainId) → passthrough error if miss.
 *   4. adapter.verify(params) → passthrough result verbatim.
 *
 * NEVER throws for foreseeable errors (CD-4). Adapter exceptions
 * propagate (the route handles via L4 error log + 500 response).
 *
 * Boundary (OWNERS / CD-10):
 *   - MAY import: ./types.js, ./errors.js, ./schemas.js,
 *                 ../chains/registry.js, ../chains/types.js (type-only).
 *   - MUST NOT import: src/methods/* (dispatch goes through registry only).
 *   - MUST NOT import: src/routes/*, src/infra/*.
 */

import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { VerifyParams, VerifyResult } from '../chains/types.js';

/**
 * Canonical network regex (CD-13 inherited from WFAC-6 BLQ-BAJO-1):
 *   - `eip155:` prefix literal.
 *   - chainId = [1-9]\d* → rejects "0", "01", "-1", "", "1.0".
 */
const EIP155_RE = /^eip155:([1-9]\d*)$/u;

/** Defense-in-depth cap: Number.MAX_SAFE_INTEGER has 16 digits. */
const MAX_CHAINID_DIGITS = 16;

export async function verifyCore(parsed: VerifyRequest): Promise<Result<VerifyResult>> {
  // WKH-204 — namespace dispatch. Non-eip155 rails route here BEFORE the EVM body.
  const network = parsed.accepted.network;
  const namespace = network.substring(0, network.indexOf(':'));
  if (namespace === 'solana') {
    if (!/^solana:(devnet|mainnet)$/u.test(network)) {
      return {
        ok: false,
        error: buildX402Error('NETWORK_MISMATCH', 'network must be solana:<devnet|mainnet>'),
      };
    }
    const lookup = chainRegistry.getAdapterByNetworkId(network);
    if (!lookup.ok) {
      return {
        ok: false,
        error: buildX402Error(
          'CHAIN_UNAVAILABLE',
          'Network namespace recognized but no adapter registered',
        ),
      };
    }
    return lookup.adapter.verify(parsed as unknown as VerifyParams);
  }
  if (namespace === 'casper') {
    if (!/^casper:(casper|casper-test)$/u.test(network)) {
      return {
        ok: false,
        error: buildX402Error('NETWORK_MISMATCH', 'network must be casper:<casper|casper-test>'),
      };
    }
    const lookup = chainRegistry.getAdapterByNetworkId(network);
    if (!lookup.ok) {
      return {
        ok: false,
        error: buildX402Error(
          'CHAIN_UNAVAILABLE',
          'Network namespace recognized but no adapter registered',
        ),
      };
    }
    return lookup.adapter.verify(parsed as unknown as VerifyParams);
  }

  // Step 1 — parse network string.
  const m = EIP155_RE.exec(parsed.accepted.network);
  // The regex is anchored and has a single capturing group that always
  // matches at least one digit (`[1-9]\d*`) when `m` is non-null.
  // Testing `m !== null && m[1] !== undefined` in one branch keeps TS
  // narrowing happy AND reports as a single covered branch.
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

  // CD-14: do NOT trust Number() for chainId overflow detection — use
  // BigInt with a digit-length guard first to avoid BigInt() allocation
  // on obviously out-of-range inputs.
  if (digits.length > MAX_CHAINID_DIGITS || BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'chainId out of safe integer range'),
    };
  }

  // By construction: `digits` matches `[1-9]\d*` (positive integer) and
  // BigInt-safe — so `asChainId(Number(digits))` cannot throw. No
  // try/catch needed here.
  const chainId = asChainId(Number(digits));

  // Step 2 — method dispatch.
  if (parsed.accepted.extra.assetTransferMethod !== 'eip3009') {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'Method not supported: only eip3009 in v1'),
    };
  }

  // Step 3 — registry lookup.
  const lookup = chainRegistry.getAdapter(chainId);
  if (!lookup.ok) {
    return { ok: false, error: lookup.error };
  }

  // Step 4 — dispatch to the adapter (single entry point, CD-10).
  //
  // `VerifyRequest` is structurally assignable to `VerifyParams`
  // EXCEPT for the hex-string branded types (signature / asset / payTo /
  // nonce / from / to): Zod's `.regex()` narrows to `string`, not to
  // `` `0x${string}` ``. The regexes in src/methods/eip3009/schemas.ts
  // and src/core/schemas.ts enforce the `0x`-prefix at runtime, so the
  // cast below is safe at runtime. See auto-blindaje.md §W0 entry 2.
  //
  // NO try/catch here: adapter exceptions are programmer errors and
  // propagate to the route (CD-4 intent: "no throws for FORESEEABLE
  // errors"; adapter throws = bug, handled by route's L4 log + 500).
  const params: VerifyParams = parsed as unknown as VerifyParams;
  return lookup.adapter.verify(params);
}
