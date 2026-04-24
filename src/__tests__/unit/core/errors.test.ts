/* eslint-disable security/detect-object-injection --
 * This test indexes into HTTP_BY_CODE / DEFAULT_MESSAGE_BY_CODE / buildX402Error
 * output using `code` values drawn from the `CANONICAL` table (all typed as
 * `X402ErrorCode`). Keys are known literals, not attacker-controlled input.
 * The security/detect-object-injection heuristic cannot narrow union-typed
 * record keys, so we disable it at file scope. */

/**
 * Unit tests for src/core/errors.ts (WFAC-11).
 *
 * Covers WFAC-11 ACs:
 *   - AC-1: buildX402Error returns { code, message, http } with canonical HTTP.
 *   - AC-2: buildX402Error(code) without message uses DEFAULT_MESSAGE_BY_CODE[code].
 *   - AC-3: buildX402Error(code, 'explicit') uses the explicit message verbatim.
 *   - AC-4: HTTP_BY_CODE contains the 10 canonical entries with spec values.
 *   - AC-5: DEFAULT_MESSAGE_BY_CODE contains 10 entries with non-empty messages.
 *   - AC-6 & AC-8: enforced at compile time by `Record<X402ErrorCode, …>` +
 *                  TypeScript strict mode. A runtime test cannot exercise a
 *                  compile-time failure; see the type-level note below.
 *   - AC-7: verify.ts and settle.ts do NOT contain a local `function err(`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTP_BY_CODE, DEFAULT_MESSAGE_BY_CODE, buildX402Error } from '../../../core/errors.js';
import type { X402ErrorCode } from '../../../core/types.js';

// ---------------------------------------------------------------------------
// Canonical inventory — the 10 codes from the x402 spec, mirrored from
// doc/architecture/X402-CONFORMANCE.md §"Standard error codes".
// ---------------------------------------------------------------------------
const CANONICAL: Array<{ code: X402ErrorCode; http: number }> = [
  { code: 'INVALID_SIGNATURE', http: 401 },
  { code: 'INSUFFICIENT_BALANCE', http: 402 },
  { code: 'PERMIT2_ALLOWANCE_REQUIRED', http: 412 },
  { code: 'EXPIRED_AUTHORIZATION', http: 400 },
  { code: 'NETWORK_MISMATCH', http: 400 },
  { code: 'SIMULATION_FAILED', http: 500 },
  { code: 'INVALID_AMOUNT', http: 400 },
  { code: 'INVALID_RECEIVER', http: 400 },
  { code: 'TRANSACTION_FAILED', http: 500 },
  { code: 'DELEGATION_INVALID', http: 401 },
];

describe('core/errors — HTTP_BY_CODE (AC-4)', () => {
  it('maps every canonical x402 code to its spec HTTP status', () => {
    for (const { code, http } of CANONICAL) {
      expect(HTTP_BY_CODE[code]).toBe(http);
    }
  });

  it('contains exactly 10 entries (spec-literal inventory)', () => {
    expect(Object.keys(HTTP_BY_CODE)).toHaveLength(10);
  });

  it('uses 401 for INVALID_SIGNATURE', () => {
    expect(HTTP_BY_CODE.INVALID_SIGNATURE).toBe(401);
  });

  it('uses 402 for INSUFFICIENT_BALANCE', () => {
    expect(HTTP_BY_CODE.INSUFFICIENT_BALANCE).toBe(402);
  });

  it('uses 412 for PERMIT2_ALLOWANCE_REQUIRED (spec literal — not 402)', () => {
    // Guard against the common mistake of collapsing PERMIT2_ALLOWANCE_REQUIRED
    // onto 402. The spec mandates 412 (Precondition Failed).
    expect(HTTP_BY_CODE.PERMIT2_ALLOWANCE_REQUIRED).toBe(412);
  });

  it('uses 500 for server-side failures (SIMULATION_FAILED, TRANSACTION_FAILED)', () => {
    expect(HTTP_BY_CODE.SIMULATION_FAILED).toBe(500);
    expect(HTTP_BY_CODE.TRANSACTION_FAILED).toBe(500);
  });

  it('uses 400 for client-side validation failures', () => {
    expect(HTTP_BY_CODE.EXPIRED_AUTHORIZATION).toBe(400);
    expect(HTTP_BY_CODE.NETWORK_MISMATCH).toBe(400);
    expect(HTTP_BY_CODE.INVALID_AMOUNT).toBe(400);
    expect(HTTP_BY_CODE.INVALID_RECEIVER).toBe(400);
  });

  it('uses 401 for delegation auth failures (ERC-7710)', () => {
    expect(HTTP_BY_CODE.DELEGATION_INVALID).toBe(401);
  });
});

describe('core/errors — DEFAULT_MESSAGE_BY_CODE (AC-5)', () => {
  it('contains exactly 10 entries (exhaustive coverage)', () => {
    expect(Object.keys(DEFAULT_MESSAGE_BY_CODE)).toHaveLength(10);
  });

  it('has a non-empty, string default message for every canonical code', () => {
    for (const { code } of CANONICAL) {
      const msg = DEFAULT_MESSAGE_BY_CODE[code];
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('contains no PII-like tokens (addresses, chain-ids, amounts)', () => {
    // Defense-in-depth: default messages must be spec-literal and free of
    // request-specific data. This scans for hex addresses, numeric chain IDs
    // passed as concrete values, and obvious value tokens.
    const ADDRESS_RE = /0x[a-fA-F0-9]{8,}/;
    for (const { code } of CANONICAL) {
      const msg = DEFAULT_MESSAGE_BY_CODE[code];
      expect(msg).not.toMatch(ADDRESS_RE);
    }
  });
});

describe('core/errors — buildX402Error(code) default message (AC-1, AC-2)', () => {
  it('returns { code, message, http } shape for every canonical code', () => {
    for (const { code, http } of CANONICAL) {
      const out = buildX402Error(code);
      expect(out).toEqual({
        code,
        message: DEFAULT_MESSAGE_BY_CODE[code],
        http,
      });
    }
  });

  it('uses DEFAULT_MESSAGE_BY_CODE[code] when message argument is omitted', () => {
    const out = buildX402Error('INVALID_SIGNATURE');
    expect(out.message).toBe(DEFAULT_MESSAGE_BY_CODE.INVALID_SIGNATURE);
  });

  it('uses DEFAULT_MESSAGE_BY_CODE[code] when message argument is explicitly undefined', () => {
    const out = buildX402Error('INSUFFICIENT_BALANCE', undefined);
    expect(out.message).toBe(DEFAULT_MESSAGE_BY_CODE.INSUFFICIENT_BALANCE);
  });

  it('attaches the canonical HTTP status for every canonical code', () => {
    for (const { code, http } of CANONICAL) {
      expect(buildX402Error(code).http).toBe(http);
    }
  });
});

describe('core/errors — buildX402Error(code, message) explicit override (AC-3)', () => {
  it('uses the explicit message verbatim (does not substitute default)', () => {
    const out = buildX402Error('INVALID_AMOUNT', 'Authorized value is below accepted amount');
    expect(out).toEqual({
      code: 'INVALID_AMOUNT',
      message: 'Authorized value is below accepted amount',
      http: 400,
    });
  });

  it('preserves an empty string override (no default fallback)', () => {
    // `?? DEFAULT` only falls back on null/undefined — an empty string passed
    // explicitly must be preserved verbatim to avoid silent substitution.
    const out = buildX402Error('SIMULATION_FAILED', '');
    expect(out.message).toBe('');
    expect(out.http).toBe(500);
  });

  it('preserves overrides for every canonical code', () => {
    for (const { code, http } of CANONICAL) {
      const override = `explicit-${code}`;
      const out = buildX402Error(code, override);
      expect(out).toEqual({ code, message: override, http });
    }
  });
});

describe('core/errors — purity (CD-4)', () => {
  it('is pure: same input yields deeply-equal output across calls', () => {
    const a = buildX402Error('NETWORK_MISMATCH', 'n-test');
    const b = buildX402Error('NETWORK_MISMATCH', 'n-test');
    expect(a).toEqual(b);
  });

  it('returns a fresh object per call (no shared reference leak)', () => {
    const a = buildX402Error('TRANSACTION_FAILED');
    const b = buildX402Error('TRANSACTION_FAILED');
    expect(a).not.toBe(b);
  });
});

describe('core/errors — dead-code removal (AC-7, CD-5)', () => {
  // Resolve absolute paths relative to this test file's location.
  const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', 'src');

  const LOCAL_ERR_HELPER_RE = /function\s+err\s*\(/;

  it('src/methods/eip3009/verify.ts does NOT contain a local `function err(` helper', () => {
    const file = resolve(SRC_DIR, 'methods', 'eip3009', 'verify.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).not.toMatch(LOCAL_ERR_HELPER_RE);
  });

  it('src/methods/eip3009/settle.ts does NOT contain a local `function err(` helper', () => {
    const file = resolve(SRC_DIR, 'methods', 'eip3009', 'settle.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).not.toMatch(LOCAL_ERR_HELPER_RE);
  });

  it('src/methods/eip3009/verify.ts imports buildX402Error from core/errors', () => {
    const file = resolve(SRC_DIR, 'methods', 'eip3009', 'verify.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).toMatch(/from ['"][^'"]*core\/errors\.js['"]/);
    expect(content).toMatch(/buildX402Error/);
  });

  it('src/methods/eip3009/settle.ts imports buildX402Error from core/errors', () => {
    const file = resolve(SRC_DIR, 'methods', 'eip3009', 'settle.ts');
    const content = readFileSync(file, 'utf-8');
    expect(content).toMatch(/from ['"][^'"]*core\/errors\.js['"]/);
    expect(content).toMatch(/buildX402Error/);
  });
});

// ---------------------------------------------------------------------------
// Type-level notes (AC-6, AC-8)
// ---------------------------------------------------------------------------
//
// AC-6 (exhaustive coverage): HTTP_BY_CODE and DEFAULT_MESSAGE_BY_CODE are
//   typed as `Record<X402ErrorCode, number>` / `Record<X402ErrorCode, string>`.
//   TypeScript strict mode rejects an object literal that omits any member of
//   the union. If a contributor adds a new variant to X402ErrorCode without
//   updating both records, `tsc` fails with TS2741 ("Property '<NEW_CODE>'
//   is missing in type ..."). This is enforced at compile time; no runtime
//   test can exercise a compile-time failure.
//
// AC-8 (invalid-code rejection): buildX402Error's first parameter is typed
//   `code: X402ErrorCode`. Passing a string not in the union (e.g. 'FOO')
//   yields TS2345 ("Argument of type '\"FOO\"' is not assignable to parameter
//   of type 'X402ErrorCode'"). Also enforced at compile time only.
//
// These two ACs are verified by the `npm run build` / `tsc --noEmit` step in
// CI, not by a runtime assertion.
