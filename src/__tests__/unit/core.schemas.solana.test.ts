/**
 * Unit tests for the HU-SOL-9 / WKH-208 Solana base58 branch of the
 * `z.union` in src/core/schemas.ts (Wave W4).
 *
 * The top-level body schema now has THREE branches:
 *   - Eip3009RequestSchema    — byte-identical to the pre-WKH-204 schema.
 *   - NonEip3009RequestSchema — permit2/erc7710 placeholder.
 *   - SolanaRequestSchema     — base58 asset/payTo + base58 payload.signature
 *                               (+ optional base58 reference). ADDED LAST.
 *
 * Coverage:
 *   - TF1 (AC-3, e2e-reachability): a base58 Solana body PASSES
 *     SettleRequestSchema/VerifyRequestSchema (with and without `reference`).
 *   - TF2 (AC-2 cross-repo, regresión): EVM eip3009/permit2 bodies still match
 *     branch 1/2; a base58 asset/payTo inside an EVM branch is still rejected.
 *   - TF3 (fail-closed): a battery of malformed Solana bodies FAILS the parse.
 */

import { describe, it, expect } from 'vitest';
import {
  VerifyRequestSchema,
  SettleRequestSchema,
  describeFirstIssue,
} from '../../core/schemas.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

// Real/valid base58 values (deterministic, generated via @solana/web3.js).
// mint = USDC devnet mint (32-byte base58 pubkey). payTo/reference = valid
// 32-byte pubkeys. signature = base58, 88 chars (∈ [64,120]).
// eslint-disable-next-line no-secrets/no-secrets -- public devnet USDC mint (base58 pubkey), not a secret.
const SOLANA_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
// eslint-disable-next-line no-secrets/no-secrets -- valid base58 pubkey test fixture (payTo), not a secret.
const SOLANA_PAYTO = 'C3JMHiAmkKzbPFvY4TREAMtraNrvW3gDGhDS95a7S2tY';
// eslint-disable-next-line no-secrets/no-secrets -- valid base58 pubkey test fixture (reference), not a secret.
const SOLANA_REFERENCE = '3jHFFgYmtqmoDQwJwCfuGsdbvCVVJtm55QVR1GMcXjne';
const SOLANA_SIGNATURE =
  // eslint-disable-next-line no-secrets/no-secrets -- valid base58 signature test fixture, not a secret.
  '44VvSvnGgBBE21SMd9eHryB28LzYW7J3FDkZ9XzFMiaXGY5r4dL7BPzQSaR4cjDDUcGRemWVPgWMLkq9v8BjdHEg';

// Contract T4 — the body chaski `verifySolanaSettlement` actually builds
// (chaski-v3 src/infrastructure/settlement/facilitator-client.ts:94-109). It
// ALWAYS carries `payload.reference`; the field is typed `reference: string`
// (non-optional) on `SolanaSettleInput` (ibid.:67).
const SOLANA_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'solana:devnet',
    amount: '10000000',
    asset: SOLANA_MINT,
    payTo: SOLANA_PAYTO,
    maxTimeoutSeconds: 60,
  },
  payload: {
    signature: SOLANA_SIGNATURE,
    reference: SOLANA_REFERENCE,
  },
} as const;

// Same body with `payload.reference` OMITTED — the shape the schema used to
// accept while the adapter rejected it deeper in.
const SOLANA_BODY_NO_REF = {
  ...SOLANA_BODY,
  payload: {
    signature: SOLANA_SIGNATURE,
  },
} as const;

// EVM eip3009 body — reused from core.schemas.discriminated.test.ts (branch 1).
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
} as const;

// ─── TF1 — e2e-reachability (AC-3) ───────────────────────────────────────────

describe('HU-SOL-9 — Solana base58 branch accepted (TF1)', () => {
  it('TF1: a base58 Solana body WITH reference PASSES VerifyRequestSchema', () => {
    expect(VerifyRequestSchema.safeParse(SOLANA_BODY).success).toBe(true);
    // alias intact — settle body shares the same schema.
    expect(SettleRequestSchema.safeParse(SOLANA_BODY).success).toBe(true);
  });

  it('TF1: solana:mainnet network is also accepted', () => {
    const mainnet = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, network: 'solana:mainnet' },
    };
    expect(VerifyRequestSchema.safeParse(mainnet).success).toBe(true);
  });
});

// ─── TF2 — EVM regression (AC-2 cross-repo) ──────────────────────────────────

describe('HU-SOL-9 — EVM branches unchanged (TF2)', () => {
  it('TF2: an eip3009 body still matches branch 1', () => {
    expect(VerifyRequestSchema.safeParse(EIP3009_BODY).success).toBe(true);
    expect(SettleRequestSchema.safeParse(EIP3009_BODY).success).toBe(true);
  });

  it('TF2: a permit2 body still matches branch 2', () => {
    const permit2Body = {
      ...EIP3009_BODY,
      accepted: {
        ...EIP3009_BODY.accepted,
        extra: { assetTransferMethod: 'permit2', name: 'PYUSD', version: '1' },
      },
    };
    expect(VerifyRequestSchema.safeParse(permit2Body).success).toBe(true);
  });

  it('TF2: base58 asset/payTo INSIDE an EVM (eip3009) branch is still rejected', () => {
    // An EVM body carrying base58 (non-0x-hex) asset/payTo must NOT sneak
    // through: the eip3009/permit2 branches still require AddressHexSchema, and
    // the Solana branch requires NO `extra` (.strict()) — so this matches none.
    const evmWithBase58 = {
      ...EIP3009_BODY,
      accepted: {
        ...EIP3009_BODY.accepted,
        asset: SOLANA_MINT,
        payTo: SOLANA_PAYTO,
      },
    };
    expect(VerifyRequestSchema.safeParse(evmWithBase58).success).toBe(false);
  });
});

// ─── TF3 — fail-closed negatives ─────────────────────────────────────────────

describe('HU-SOL-9 — Solana fail-closed negatives (TF3)', () => {
  it('TF3: network solana:mainnet-beta fails the regex', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, network: 'solana:mainnet-beta' },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: network eip155:2368 does not match the Solana branch (missing extra)', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, network: 'eip155:2368' },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: 0x-hex asset fails the base58 pubkey refine', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, asset: `0x${'11'.repeat(20)}` },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: asset with non-base58 chars (Il0O) fails', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, asset: 'Il0O' },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: signature shorter than 64 chars fails', () => {
    // `reference` kept VALID so the only defect under test is the signature.
    const bad = {
      ...SOLANA_BODY,
      payload: { signature: 'abc', reference: SOLANA_REFERENCE },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: unknown `extra` key in accepted fails (.strict())', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: {
        ...SOLANA_BODY.accepted,
        extra: { assetTransferMethod: 'eip3009' },
      },
    };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: x402Version as string "2" fails z.literal(2)', () => {
    const bad = { ...SOLANA_BODY, x402Version: '2' };
    expect(VerifyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF3: signature longer than 120 chars fails Base58SignatureSchema upper bound', () => {
    // 88-char valid base58 sig doubled = 176 chars: passes the base58 regex but
    // exceeds the length <= 120 refine (schemas.ts:105). `reference` kept VALID
    // so the only defect under test is the signature length.
    const bad = {
      ...SOLANA_BODY,
      payload: {
        signature: `${SOLANA_SIGNATURE}${SOLANA_SIGNATURE}`,
        reference: SOLANA_REFERENCE,
      },
    };
    const result = SettleRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('TF3: non-empty but non-base58 reference fails the Base58PubkeySchema refine', () => {
    // reference PRESENT but carrying non-base58 chars (0, O, l): distinct from
    // the missing-reference case below — this one exercises the pubkey refine,
    // not the required check.
    const bad = {
      ...SOLANA_BODY,
      payload: { signature: SOLANA_SIGNATURE, reference: '0OIl0OIl0OIl' },
    };
    const result = SettleRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('reference'))).toBe(true);
    }
  });

  it('TF3: missing required accepted.payTo fails Zod required', () => {
    const { payTo: _omit, ...acceptedNoPayTo } = SOLANA_BODY.accepted;
    void _omit;
    const bad = { ...SOLANA_BODY, accepted: acceptedNoPayTo };
    const result = SettleRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('TF3: non-base58 payTo fails the base58 pubkey refine (symmetric to asset)', () => {
    const bad = {
      ...SOLANA_BODY,
      accepted: { ...SOLANA_BODY.accepted, payTo: '0OIl' },
    };
    const result = SettleRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ─── TF5 — `payload.reference` is REQUIRED, not optional ─────────────────────
//
// The schema declared `reference: Base58PubkeySchema.optional()` while the
// adapter demanded it unconditionally (solana-adapter.ts:298-312, step 7:
// `reference !== null && staticKeys.some(...)`). A body without it therefore
// PASSED this gate and died deeper in, after the RPC roundtrip.

describe('payload.reference is required on the Solana branch (TF5)', () => {
  it('★ TF5: a Solana body WITHOUT payload.reference is REJECTED by the schema', () => {
    expect(VerifyRequestSchema.safeParse(SOLANA_BODY_NO_REF).success).toBe(false);
    expect(SettleRequestSchema.safeParse(SOLANA_BODY_NO_REF).success).toBe(false);
  });

  it('★ TF5: the rejection NAMES payload.reference (not a generic "Invalid input")', () => {
    const result = SettleRequestSchema.safeParse(SOLANA_BODY_NO_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      const described = describeFirstIssue(result.error);
      expect(described.path).toBe('payload.reference');
      expect(described.message).toBe('Required');
    }
  });

  it('TF5: `reference: undefined` is rejected the same as an absent key', () => {
    // Guards the `.optional()` semantics specifically: `.optional()` accepts an
    // explicit `undefined`, a required field does not.
    const bad = {
      ...SOLANA_BODY,
      payload: { signature: SOLANA_SIGNATURE, reference: undefined },
    };
    expect(SettleRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF5: empty-string reference is rejected (never silently treated as absent)', () => {
    const bad = {
      ...SOLANA_BODY,
      payload: { signature: SOLANA_SIGNATURE, reference: '' },
    };
    expect(SettleRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('TF5 (no-regression lock): the body chaski actually sends still PASSES', () => {
    // chaski-v3 facilitator-client.ts:105-108 — `{signature, reference}`, both
    // base58. This is the ONLY producer of a Solana /settle body today, and it
    // has always sent `reference`; requiring it breaks no live caller.
    expect(SettleRequestSchema.safeParse(SOLANA_BODY).success).toBe(true);
    expect(VerifyRequestSchema.safeParse(SOLANA_BODY).success).toBe(true);
  });
});

// ─── TF6 — describeFirstIssue unwraps the union so the field is named ────────

describe('describeFirstIssue (TF6)', () => {
  it('★ TF6: picks the closest union branch instead of the union\'s "Invalid input"', () => {
    const result = SettleRequestSchema.safeParse(SOLANA_BODY_NO_REF);
    expect(result.success).toBe(false);
    if (!result.success) {
      // What the routes used to read verbatim: the union's own issue.
      expect(result.error.issues[0]?.code).toBe('invalid_union');
      expect(result.error.issues[0]?.path).toEqual([]);
      expect(result.error.issues[0]?.message).toBe('Invalid input');
      // What they read now.
      expect(describeFirstIssue(result.error)).toEqual({
        path: 'payload.reference',
        message: 'Required',
      });
    }
  });

  it('TF6: an EVM body still reports its own field (no Solana-branch bleed)', () => {
    const bad = {
      ...EIP3009_BODY,
      accepted: { ...EIP3009_BODY.accepted, payTo: 'not-hex' },
    };
    const result = SettleRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const described = describeFirstIssue(result.error);
      expect(described.path).toBe('accepted.payTo');
    }
  });

  it('TF6: falls back to "body" when the error carries no issue with a path', () => {
    const result = SettleRequestSchema.safeParse('not an object at all');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describeFirstIssue(result.error).path).toBe('body');
    }
  });
});
