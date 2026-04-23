/**
 * Unit tests for verifyEip3009.
 *
 * Covers all 12 ACs of WFAC-6 + 8 hardening (T-H1..T-H8) — see
 * `doc/sdd/005-wfac-6-eip3009-verify/story-WFAC-6.md` §5.6, §6 (W2 + W3), §8.
 *
 * Signature fixtures are generated offline with `privateKeyToAccount(...)
 * .signTypedData(...)` using the Hardhat account #0 private key (public
 * knowledge, documented in Hardhat defaults). No RPC, no keys from env.
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, TypedDataDomain } from 'viem';
import { verifyEip3009 } from '../../../../methods/eip3009/verify.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

// Hardhat account #0 — public knowledge, documented in Hardhat defaults.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

const TEST_CHAIN_ID = asChainId(2368);

const TEST_TOKEN: EIP3009Token = {
  address: '0x00000000000000000000000000000000000000ff' as Address,
  symbol: 'TEST',
  decimals: 6,
  name: 'Test Token',
  eip712Name: 'Test Token',
  eip712Version: '1',
};

const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as Address;

type AuthMessage = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

async function signFixture(domain: TypedDataDomain, message: AuthMessage): Promise<`0x${string}`> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message,
  });
}

/**
 * Build a valid VerifyParams signed by TEST_SIGNER_ADDRESS.
 *
 * Overrides semantics:
 *   - `messageOverrides` mutate the message BEFORE signing → signature is
 *     valid over the (possibly tampered) message. Use for tests where you
 *     want a still-valid signature over a different message (e.g., value
 *     mismatch, timestamp window).
 *   - `domainOverrides` mutate the domain BEFORE signing → use for impostor
 *     domain tests (AC-10).
 *   - `acceptedOverrides` mutate the VerifyParams.accepted AFTER signing →
 *     use for tests where the accepted fields diverge from what the signer
 *     committed to (AC-6 amount, AC-7 zero, AC-8 network, AC-11 asset).
 *   - `signatureOverride` replaces the signature entirely AFTER signing →
 *     use for malformed signature tests (AC-3, T-H7).
 */
async function makeValidParams(opts?: {
  nowSec?: number;
  messageOverrides?: Partial<AuthMessage>;
  acceptedOverrides?: Partial<VerifyParams['accepted']>;
  domainOverrides?: Partial<TypedDataDomain>;
  signatureOverride?: `0x${string}`;
}): Promise<VerifyParams> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const baseMessage: AuthMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
    ...opts?.messageOverrides,
  };
  const baseDomain = buildEip3009Domain(TEST_TOKEN, TEST_CHAIN_ID, {
    extra: { assetTransferMethod: 'eip3009' },
  } as VerifyParams['accepted']);
  const domain: TypedDataDomain = { ...baseDomain, ...opts?.domainOverrides };
  const signature = opts?.signatureOverride ?? (await signFixture(domain, baseMessage));

  return {
    x402Version: 2,
    resource: {
      url: 'https://example.com',
      description: 't',
      mimeType: 'application/json',
    },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: '1000',
      asset: TEST_TOKEN.address,
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009' },
      ...opts?.acceptedOverrides,
    },
    payload: {
      signature,
      authorization: {
        from: baseMessage.from,
        to: baseMessage.to,
        value: baseMessage.value.toString(),
        validAfter: baseMessage.validAfter.toString(),
        validBefore: baseMessage.validBefore.toString(),
        nonce: baseMessage.nonce,
      },
    },
  };
}

describe('verifyEip3009', () => {
  describe('AC-1 — happy path', () => {
    it('returns ok: true with client === getAddress(recovered)', async () => {
      const params = await makeValidParams();
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verified).toBe(true);
        expect(result.client).toBe(TEST_SIGNER_ADDRESS);
        expect(result.amount).toBe('1000');
        expect(result.network).toBe('eip155:2368');
      }
    });
  });

  describe('AC-2 — recovered does not match from', () => {
    it('returns INVALID_SIGNATURE when authorization.from differs from signer', async () => {
      // Sign with the real TEST_SIGNER, then tamper authorization.from
      // post-sign so recover() returns TEST_SIGNER_ADDRESS but the claim
      // is a different address.
      const valid = await makeValidParams();
      const tamperedParams: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            from: '0x2222222222222222222222222222222222222222' as Address,
          },
        },
      };
      const result = await verifyEip3009(tamperedParams, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });
  });

  describe('AC-3 — recoverTypedDataAddress throws', () => {
    it('catches and returns INVALID_SIGNATURE on malformed signature bytes', async () => {
      // 65-byte hex that has shape-valid length but secp256k1 recovery will
      // fail (v=0x00 with r=s=0 — impossible point).
      const params = await makeValidParams({
        signatureOverride: `0x${'00'.repeat(65)}` as `0x${string}`,
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });
  });

  describe('AC-4 — validBefore expired', () => {
    it('returns EXPIRED_AUTHORIZATION when validBefore <= now', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec - 3600),
          validBefore: BigInt(nowSec - 1), // just expired
        },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-5 — validAfter in the future', () => {
    it('returns EXPIRED_AUTHORIZATION when validAfter > now', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec + 3600), // starts in 1h
          validBefore: BigInt(nowSec + 7200),
        },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-6 — value < amount', () => {
    it('returns INVALID_AMOUNT when authorized value below accepted amount', async () => {
      const params = await makeValidParams({
        messageOverrides: { value: 99n },
        acceptedOverrides: { amount: '100' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-7 — accepted.amount === 0', () => {
    it('returns INVALID_AMOUNT when accepted.amount is "0"', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { amount: '0' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-8 — network mismatch', () => {
    it('returns NETWORK_MISMATCH when accepted.network does not match chainId', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { network: 'eip155:999' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-9 — receiver mismatch', () => {
    it('returns INVALID_RECEIVER when authorization.to !== accepted.payTo', async () => {
      // Sign with original payTo, then override accepted.payTo post-sign
      // so signature is valid but the claim diverges from the receiver.
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        accepted: {
          ...valid.accepted,
          payTo: '0x3333333333333333333333333333333333333333' as Address,
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RECEIVER');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-10 — domain integrity', () => {
    it('verifies successfully when domain built from registry (happy path)', async () => {
      // Regression: AC-1 already proves this. Duplicate here for documentation.
      const params = await makeValidParams();
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
    });

    it('fails when signature was generated against a different domain name (impostor domain)', async () => {
      // Sign with a domain whose name is NOT what the registry would produce.
      const valid = await makeValidParams({
        domainOverrides: { name: 'Impostor Name' },
      });
      // Now validate with the registry-sourced domain (eip712Name = 'Test Token').
      // The recover will compute a different message hash → recovered address
      // will differ from TEST_SIGNER_ADDRESS → INVALID_SIGNATURE.
      const result = await verifyEip3009(valid, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('AC-11 — asset not in token registry', () => {
    it('returns NETWORK_MISMATCH when accepted.asset does not match token.address', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { asset: `0x${'ff'.repeat(20)}` },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('AC-12 — output contract exact shape', () => {
    it('returns VerifyResult with expected fields on happy path', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({ nowSec });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.expiresAt).toBe(Number(params.payload.authorization.validBefore));
        expect(result.network).toBe(params.accepted.network);
        expect(result.asset).toBe(TEST_TOKEN.address);
        expect(result.amount).toBe(params.accepted.amount);
        // getAddress returns checksummed; TEST_SIGNER_ADDRESS is already
        // checksummed in the helper.
        expect(result.client).toBe(TEST_SIGNER_ADDRESS);
        expect(result.payTo).toBe(TEST_PAY_TO);
      }
    });
  });

  // ── Hardening tests (non-AC but required by CD) ──

  describe('T-H — hardening', () => {
    it('T-H1: nonce with 63 hex chars is rejected as INVALID_SIGNATURE', async () => {
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            // 63 hex chars (62 from repeat + 1 trailing 'c').
            nonce: `0x${'ab'.repeat(31)}c` as `0x${string}`,
          },
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
    });

    it('T-H2: nonce with non-hex chars is rejected as INVALID_SIGNATURE', async () => {
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            nonce: `0x${'ZZ'.repeat(32)}` as `0x${string}`, // non-hex
          },
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
    });

    it('T-H3: value === amount exactly is OK (boundary of AC-6)', async () => {
      const params = await makeValidParams({
        messageOverrides: { value: 100n },
        acceptedOverrides: { amount: '100' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
    });

    it('T-H4: validAfter === nowSec is OK', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec),
          validBefore: BigInt(nowSec + 3600),
        },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
    });

    it('T-H5: validBefore === nowSec + 1 is OK', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec - 10),
          validBefore: BigInt(nowSec + 1),
        },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(true);
    });

    it('T-H6: uint256 overflow in value is rejected as INVALID_SIGNATURE', async () => {
      const valid = await makeValidParams();
      const tooBig = '1'.repeat(79); // 79 digits > 2^256-1 (78 digits)
      const tampered: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            value: tooBig,
          },
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
    });

    it('T-H7: signature of wrong length is rejected as INVALID_SIGNATURE', async () => {
      const params = await makeValidParams({
        // 60 bytes (120 hex chars), not 65.
        signatureOverride: `0x${'aa'.repeat(60)}` as `0x${string}`,
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
    });

    it('T-H8: two concurrent verify calls with different fixtures do not cross-talk', async () => {
      const p1 = await makeValidParams();
      const p2 = await makeValidParams({
        messageOverrides: { value: 2000n },
        acceptedOverrides: { amount: '2000' },
      });
      const [r1, r2] = await Promise.all([
        verifyEip3009(p1, TEST_TOKEN, TEST_CHAIN_ID),
        verifyEip3009(p2, TEST_TOKEN, TEST_CHAIN_ID),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok) expect(r1.amount).toBe('1000');
      if (r2.ok) expect(r2.amount).toBe('2000');
    });

    // ── F3.1 Fix-pack (BLQ resolution) ──

    it('T-H9 (BLQ-ALTO-1): accepted.amount = "-1" returns INVALID_AMOUNT without throwing', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { amount: '-1' },
      });
      // Must resolve (never throw) — negatives rejected by canonical regex.
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });

    it('T-H10 (BLQ-ALTO-2 / CD-2): accepted.amount = "abc" returns INVALID_AMOUNT without throwing', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { amount: 'abc' },
      });
      // Pre-fix: BigInt('abc') threw unhandled.
      // Post-fix: AcceptedSchema rejects before any BigInt() call.
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });

    it('T-H11 (BLQ-ALTO-2): accepted.amount = "1e2" (scientific) returns INVALID_AMOUNT without throwing', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { amount: '1e2' },
      });
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });

    it('T-H12 (BLQ-ALTO-2): accepted.asset = "not-an-address" rejected without throwing', async () => {
      const params = await makeValidParams({
        acceptedOverrides: { asset: 'not-an-address' },
      });
      // Pre-fix: isAddressEqual('not-an-address', ...) could throw.
      // Post-fix: AcceptedSchema's AddressHexSchema rejects first.
      const result = await verifyEip3009(params, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Asset shape errors are routed to NETWORK_MISMATCH (same class as
        // AC-11). Http must remain 400 regardless of code.
        expect(result.error.http).toBe(400);
        expect(['NETWORK_MISMATCH', 'INVALID_SIGNATURE']).toContain(result.error.code);
      }
    });

    it('T-H13 (BLQ-BAJO-1): authorization.value = "01000" (leading zero) returns INVALID_SIGNATURE', async () => {
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            // Canonical form requires "1000"; "01000" now rejected by
            // /^(0|[1-9]\d*)$/ — uniquifies log/equality representation.
            value: '01000',
          },
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });

    it('T-H14 (BLQ-MED-1): authorization.validBefore = "99999999999999999999" (>2^53) compares via BigInt', async () => {
      // This value is a valid uint256 (<= 2^256-1) but exceeds MAX_SAFE_INTEGER.
      // Pre-fix: Number("99999999999999999999") loses precision and could
      //   flip expired/valid decisions. We assert the decision is made on
      //   BigInt (so a far-future validBefore is NOT spuriously expired),
      //   AND that overall verification still proceeds to signature recovery
      //   without throwing on the numeric conversion.
      // Sign a valid auth with a normal validBefore, then tamper post-sign
      // with the huge string — recover will yield a different message hash
      // (since validBefore is part of the EIP-712 struct) so INVALID_SIGNATURE
      // is the expected terminal code. The ASSERTION is: no throw, no
      // EXPIRED_AUTHORIZATION (which would indicate Number() precision-loss
      // flipped the gate in reverse).
      const valid = await makeValidParams();
      const tampered: VerifyParams = {
        ...valid,
        payload: {
          ...valid.payload,
          authorization: {
            ...valid.payload.authorization,
            validBefore: '99999999999999999999',
          },
        },
      };
      const result = await verifyEip3009(tampered, TEST_TOKEN, TEST_CHAIN_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Critical: must NOT be EXPIRED_AUTHORIZATION — BigInt comparison
        // correctly identifies this as a future timestamp.
        expect(result.error.code).not.toBe('EXPIRED_AUTHORIZATION');
        // Terminal classification is INVALID_SIGNATURE (recovered mismatch).
        expect(result.error.code).toBe('INVALID_SIGNATURE');
      }
    });
  });
});
