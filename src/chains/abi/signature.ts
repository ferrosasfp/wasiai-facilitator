/**
 * DUPLICATED FROM src/methods/eip3009/signature.ts — WFAC-50 DT-K.
 *
 * UNICA diferencia vs. source: NO importa `buildX402Error` de `src/core/errors.ts`
 * (chains cannot runtime-import core/* per OWNERS.md). In its place construye el
 * `Err['error']` literal inline via `makeInvalidSig(reason)` — shape identica
 * ({ code: 'INVALID_SIGNATURE', message, http: 401 }).
 *
 * Any edit to src/methods/eip3009/signature.ts MUST be replicated here in the
 * same PR (CD-NEW-SDD-1 — sync test in chain-adapter.test.ts).
 *
 * Refactor tracker: TD-CHAINS-ABI-DUP in BACKLOG.md.
 */

/**
 * EIP-3009 signature normalization — pure, total, Result-returning.
 *
 * Centralises parsing + validation of ECDSA signatures used by the
 * TransferWithAuthorization flow:
 *
 *   - 65-byte standard ECDSA (r || s || v) with v ∈ {27, 28} (EIP-155 style).
 *   - 64-byte EIP-2098 compact (r || yParityAndS); yParity extracted from the
 *     high bit of `s`, v reconstructed as 27 + yParity.
 *   - Legacy v ∈ {0, 1} pre-EIP-155 normalized to {27, 28}.
 *   - High-half `s` rejected (EIP-2 malleability — s MUST be <= n/2).
 *   - r = 0 or s = 0 rejected (not a valid secp256k1 point).
 *
 * Pure function: no I/O, no logger, no mutation of inputs. Never throws —
 * every foreseeable error returns `{ ok: false, error }` so callers need
 * no try/catch.
 *
 * Boundaries (OWNERS.md):
 *   - This module lives under `src/chains/abi/`.
 *   - Runtime imports: none from core/* (chains ↛ core runtime).
 *   - Type-only import of `src/core/types.ts` for `Err['error']` shape.
 *
 * Spec references:
 *   - EIP-3009 (https://eips.ethereum.org/EIPS/eip-3009)
 *   - EIP-2098 (https://eips.ethereum.org/EIPS/eip-2098) — compact signatures.
 *   - EIP-2 (https://eips.ethereum.org/EIPS/eip-2) — low-s requirement.
 */

import type { Hex } from 'viem';
import type { Err } from '../../core/types.js';

/**
 * Order of the secp256k1 curve (n).
 *
 * Source: SEC 2 v2.0 §2.4.1 "Recommended Parameters secp256k1".
 * A signature is considered malleable if `s > n/2` (EIP-2).
 */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Upper bound for a non-malleable (low-s) signature. */
const SECP256K1_N_HALF = SECP256K1_N / 2n;

/** Bit mask to clear the high bit (255) of `s` in EIP-2098 compact form. */
const S_LOW_255_MASK = (1n << 255n) - 1n;

/** Successful normalization result. `v` is always 27n or 28n. */
export type NormalizedSignature = {
  readonly ok: true;
  readonly r: Hex;
  readonly s: Hex;
  readonly v: 27n | 28n;
};

/** Failure result — shape identical to the `error` field of `Err`. */
export type SignatureError = {
  readonly ok: false;
  readonly error: Err['error'];
};

/**
 * Build an `Err['error']` literal with `code: 'INVALID_SIGNATURE'`, a
 * caller-provided `message`, and `http: 401`. Inline replacement for
 * `buildX402Error('INVALID_SIGNATURE', reason)` — see file header.
 *
 * `http: 401` mirrors `HTTP_BY_CODE.INVALID_SIGNATURE` in core/errors.ts.
 * If the spec HTTP code ever changes, both this file and core/errors.ts
 * must be updated together.
 */
function makeInvalidSig(reason: string): Err['error'] {
  return {
    code: 'INVALID_SIGNATURE',
    message: reason,
    http: 401,
  };
}

/**
 * Render a bigint as a 32-byte (64-hex-char) `0x`-prefixed Hex string.
 * Pads with leading zeros when needed. Pure.
 */
function bigintToHex32(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

/**
 * Parse a hex byte string (no `0x` prefix) into a bigint. Returns null when
 * the string contains non-hex characters so the caller can convert the
 * failure into a Result without try/catch escaping the function.
 */
function parseHexBigint(body: string): bigint | null {
  // Reject anything outside [0-9a-f] (case-insensitive). BigInt() accepts
  // '0x' prefix + hex; we build the prefix ourselves and validate first so
  // that inputs like '0xg...' or empty strings never reach BigInt().
  if (body.length === 0 || !/^[0-9a-f]+$/i.test(body)) {
    return null;
  }
  // Defensive: wrap in try/catch so a theoretical parse failure in a future
  // runtime still surfaces as a Result (CD-4 — never throw).
  try {
    return BigInt(`0x${body}`);
  } catch {
    return null;
  }
}

/**
 * Normalize an EIP-3009-compatible ECDSA signature hex to canonical
 * `{ r, s, v: 27n | 28n }` form.
 *
 * Accepts:
 *   - 132 chars incl. `0x` (65 bytes): r(32) || s(32) || v(1). v ∈ {0,1,27,28}.
 *   - 130 chars incl. `0x` (64 bytes): EIP-2098 compact r(32) || yParityAndS(32).
 *
 * Returns on success:
 *   { ok: true, r: Hex32, s: Hex32, v: 27n | 28n }
 *
 * Returns on failure (never throws):
 *   { ok: false, error: makeInvalidSig(<reason>) }
 *
 * Rejection reasons (all → INVALID_SIGNATURE):
 *   - Invalid length (AC-5).
 *   - Non-hex body.
 *   - r = 0 or s = 0 (AC-6 — not a valid secp256k1 scalar).
 *   - s > n/2 (AC-4 — EIP-2 malleability).
 *   - v not in {0, 1, 27, 28} (AC-3 contrapositive).
 */
export function normalizeSignature(sig: Hex): NormalizedSignature | SignatureError {
  // 1. Strip `0x` prefix (accepted case-insensitively).
  if (typeof sig !== 'string' || !sig.startsWith('0x')) {
    return {
      ok: false,
      error: makeInvalidSig('invalid signature length'),
    };
  }
  const body = sig.slice(2);

  // 2. Length check (AC-5). Body MUST be 128 (64 bytes, EIP-2098 compact) or
  // 130 (65 bytes, standard ECDSA). The work-item phrases "130/132 chars"
  // meaning the FULL 0x-prefixed hex string — here we measure the body only.
  if (body.length !== 128 && body.length !== 130) {
    return {
      ok: false,
      error: makeInvalidSig('invalid signature length'),
    };
  }

  // 3. Parse r and s.
  const rHex = body.slice(0, 64);
  const sOrCompactHex = body.slice(64, 128);
  const rBigInt = parseHexBigint(rHex);
  if (rBigInt === null) {
    return {
      ok: false,
      error: makeInvalidSig('invalid signature hex (r)'),
    };
  }
  const sRawBigInt = parseHexBigint(sOrCompactHex);
  if (sRawBigInt === null) {
    return {
      ok: false,
      error: makeInvalidSig('invalid signature hex (s)'),
    };
  }

  // 4. Derive v and the canonical s depending on encoding.
  let sBigInt: bigint;
  let v: 27n | 28n;

  if (body.length === 128) {
    // EIP-2098 compact (DT-5): high bit of s encodes yParity.
    const yParity = (sRawBigInt >> 255n) & 1n;
    sBigInt = sRawBigInt & S_LOW_255_MASK;
    v = yParity === 0n ? 27n : 28n;
  } else {
    // 130 chars → standard 65-byte ECDSA. Parse v from the last byte.
    const vHex = body.slice(128, 130);
    const vNum = parseHexBigint(vHex);
    if (vNum === null) {
      return {
        ok: false,
        error: makeInvalidSig('invalid signature hex (v)'),
      };
    }
    // AC-3: accept legacy {0,1} → {27,28} and {27,28} as-is; reject others.
    if (vNum === 0n || vNum === 27n) {
      v = 27n;
    } else if (vNum === 1n || vNum === 28n) {
      v = 28n;
    } else {
      return {
        ok: false,
        error: makeInvalidSig(`invalid signature v value: ${vNum.toString()}`),
      };
    }
    sBigInt = sRawBigInt;
  }

  // 5. Zero-check r and s (AC-6). Not valid scalars on secp256k1.
  if (rBigInt === 0n || sBigInt === 0n) {
    return {
      ok: false,
      error: makeInvalidSig('signature r or s is zero'),
    };
  }

  // 6. Range check: r and s MUST be strictly less than n.
  // (s high-half is covered by AC-4 below; r high-bound is defence-in-depth.)
  if (rBigInt >= SECP256K1_N || sBigInt >= SECP256K1_N) {
    return {
      ok: false,
      error: makeInvalidSig('signature r or s out of range'),
    };
  }

  // 7. Low-s (EIP-2 malleability, AC-4).
  if (sBigInt > SECP256K1_N_HALF) {
    return {
      ok: false,
      error: makeInvalidSig('signature s-value in high half (malleable)'),
    };
  }

  // 8. Success — render to padded 32-byte hex for stable output.
  return {
    ok: true,
    r: bigintToHex32(rBigInt),
    s: bigintToHex32(sBigInt),
    v,
  };
}
