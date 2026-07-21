/**
 * Unit tests for the WKH-204 namespace union in src/core/schemas.ts (AC-5).
 *
 * The top-level body schema is a `z.union` of two branches:
 *   - Eip3009RequestSchema    — byte-identical to the pre-WKH-204 schema.
 *   - NonEip3009RequestSchema — permit2/erc7710 placeholder with a permissive,
 *     minimally-typed payload (authorization?: {from,value} + passthrough).
 *
 * Coverage (addendum 025-A §A.6):
 *   - T-D1 : eip3009 body → success (branch eip3009 byte-identical).
 *   - T-D2 : permit2 body reusing the eip3009-shaped payload → success
 *            (reaches the method-guard, is NOT rejected at Zod — protects
 *            SDD §4.5 case 4 / T-V10 / T-C5).
 *   - T-D3 : malformed eip3009 (bad signature) → failure.
 *   - T-D4 : malformed eip3009 (non-canonical amount `0100`) → failure.
 *   - T-D5 : unknown top-level key → failure (`.strict()` preserved by `.extend`).
 *   - T-D6 : ledger fail-closed — buildLedgerEntry failure branch WITHOUT
 *            authorization → payer === '' (documents the CD-10 `?? ''` guard).
 */

import { describe, it, expect } from 'vitest';
import { VerifyRequestSchema, SettleRequestSchema } from '../../core/schemas.js';
import { buildLedgerEntry, type BuildLedgerEntryInput } from '../../core/ledger.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const EIP3009_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1000000',
    asset: `0x${'11'.repeat(20)}`,
    payTo: `0x${'22'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
  },
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: `0x${'33'.repeat(20)}`,
      to: `0x${'22'.repeat(20)}`,
      value: '1000000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

describe('WKH-204 schema union (AC-5)', () => {
  it('T-D1: accepts a canonical eip3009 body (byte-identical branch)', () => {
    expect(VerifyRequestSchema.safeParse(EIP3009_BODY).success).toBe(true);
    // alias intact — settle body shares the same schema.
    expect(SettleRequestSchema.safeParse(EIP3009_BODY).success).toBe(true);
  });

  it('T-D2: accepts a permit2 body reusing the eip3009-shaped payload', () => {
    // Reuses EIP3009_BODY.payload verbatim: the extra eip3009 fields
    // (to/validAfter/validBefore/nonce) are tolerated by `.passthrough()`.
    // The body reaches the method-guard, is NOT rejected at Zod (§4.5 case 4).
    const permit2Body = {
      ...EIP3009_BODY,
      accepted: {
        ...EIP3009_BODY.accepted,
        extra: { assetTransferMethod: 'permit2', name: 'PYUSD', version: '1' },
      },
    };
    expect(VerifyRequestSchema.safeParse(permit2Body).success).toBe(true);
  });

  it('T-D3: rejects a malformed eip3009 body (bad signature)', () => {
    const bad = {
      ...EIP3009_BODY,
      payload: { ...EIP3009_BODY.payload, signature: 'not-hex' },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('T-D4: rejects a malformed eip3009 body (non-canonical amount 0100)', () => {
    const bad = {
      ...EIP3009_BODY,
      accepted: { ...EIP3009_BODY.accepted, amount: '0100' },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('T-D5: rejects an unknown top-level key (.strict() preserved by .extend)', () => {
    const bad = { ...EIP3009_BODY, foo: 'bar' };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('WKH-204 ledger fail-closed (CD-10)', () => {
  it('T-D6: failure branch without authorization → payer === ""', () => {
    const input: BuildLedgerEntryInput = {
      idempotencyKey: 'a'.repeat(64),
      durationMs: 1,
      method: 'permit2',
      network: 'eip155:2368',
      parsed: {
        accepted: {
          asset: `0x${'11'.repeat(20)}`,
          payTo: `0x${'22'.repeat(20)}`,
          amount: '1000000',
        },
        // no `authorization` — the widened optional (branch no-eip3009).
        payload: {},
      },
      result: {
        ok: false,
        error: { code: 'CHAIN_UNAVAILABLE', http: 503 },
      },
    };
    const entry = buildLedgerEntry(input);
    expect(entry.status).toBe('failed');
    expect(entry.payer).toBe('');
  });
});
