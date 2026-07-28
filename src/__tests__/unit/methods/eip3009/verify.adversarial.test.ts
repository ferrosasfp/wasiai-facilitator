/**
 * Suite 1 — Adversarial EIP-3009 verify/settle.
 *
 * DEEP adversarial + failure-injection coverage for the x402 relayer's
 * off-chain payment-authorization validation (`verifyEip3009`). Every test
 * here crafts a MALICIOUS or malformed `TransferWithAuthorization` and asserts
 * that `verify` REJECTS it with the correct x402 error code — and that it never
 * leaks through to a (hypothetical) settle. `verify` is pure and side-effect
 * free, so the "no settle" guarantee for these vectors is that `verify` returns
 * `{ ok: false }`; `settle` re-verifies first (settle.ts step 1) and propagates
 * that error unchanged before any RPC.
 *
 * Vectors covered:
 *   - Wrong signer (sig from a different key than `from`) → INVALID_SIGNATURE.
 *   - Tampered-after-signing fields: amount raised, `to`/payTo changed, nonce
 *     changed, asset changed, chainId/domain changed → rejected.
 *   - Time window: expired, not-yet-valid, exact boundaries → correct.
 *   - Signature malleability: high-s → rejected before recover.
 *   - Replay via alternative encoding (high-s second hex) → rejected.
 *   - Amount edge cases: 0, negative, above maxAmountRequired, BigInt overflow
 *     (no Number() 2^53 precision loss) → rejected.
 *   - Wrong EIP-712 domain (name / version / verifyingContract / chainId).
 *
 * Property-style vectors are SEEDED + DETERMINISTIC (fixed arrays of crafted
 * inputs) — no real RNG, no network, no real settlement. Signatures are
 * generated offline with `privateKeyToAccount(...).signTypedData(...)`.
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, TypedDataDomain } from 'viem';
import { verifyEip3009 } from '../../../../methods/eip3009/verify.js';
import { settleEip3009 } from '../../../../methods/eip3009/settle.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, SettleParams, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';
import type { PublicClient, WalletClient } from 'viem';
import { vi } from 'vitest';

// Hardhat account #0 — public knowledge (documented Hardhat default).
const SIGNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SIGNER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

// Hardhat account #1 — the "attacker" / wrong key.
const ATTACKER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ATTACKER_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

const CHAIN_ID = asChainId(2368);

const TOKEN: EIP3009Token = {
  address: '0x00000000000000000000000000000000000000ff' as Address,
  symbol: 'TEST',
  decimals: 6,
  name: 'Test Token',
  eip712Name: 'Test Token',
  eip712Version: '1',
};

const PAY_TO = '0x1111111111111111111111111111111111111111' as Address;

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_N_HALF = SECP256K1_N / 2n;
const UINT256_MAX = 2n ** 256n - 1n;

type AuthMessage = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

async function signWith(
  pk: `0x${string}`,
  domain: TypedDataDomain,
  message: AuthMessage,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(pk);
  return account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message,
  });
}

/**
 * Build VerifyParams. `signerPk` defaults to the legitimate SIGNER_PK.
 *  - messageOverrides mutate the message BEFORE signing (sig valid over the
 *    mutated message).
 *  - acceptedOverrides mutate accepted AFTER signing (claim diverges).
 *  - domainOverrides mutate the signing domain (impostor domain).
 *  - signatureOverride replaces the signature outright.
 *  - authOverrides mutate the AUTHORIZATION payload AFTER signing (tamper).
 */
async function makeParams(opts?: {
  signerPk?: `0x${string}`;
  nowSec?: number;
  messageOverrides?: Partial<AuthMessage>;
  acceptedOverrides?: Partial<VerifyParams['accepted']>;
  domainOverrides?: Partial<TypedDataDomain>;
  signatureOverride?: `0x${string}`;
  authOverrides?: Partial<VerifyParams['payload']['authorization']>;
}): Promise<VerifyParams> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const baseMessage: AuthMessage = {
    from: SIGNER_ADDR,
    to: PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
    ...opts?.messageOverrides,
  };
  const baseDomain = buildEip3009Domain(TOKEN, CHAIN_ID, {
    extra: { assetTransferMethod: 'eip3009' },
  } as VerifyParams['accepted']);
  const domain: TypedDataDomain = { ...baseDomain, ...opts?.domainOverrides };
  const signature =
    opts?.signatureOverride ?? (await signWith(opts?.signerPk ?? SIGNER_PK, domain, baseMessage));

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
      asset: TOKEN.address,
      payTo: PAY_TO,
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
        ...opts?.authOverrides,
      },
    },
  };
}

/** Mock clients that EXPLODE if any chain call is made — proves no settle. */
function explodingClients(): { publicClient: PublicClient; walletClient: WalletClient } {
  const boom = () => {
    throw new Error('CHAIN CALL MADE — a rejected verify must never reach RPC');
  };
  const publicClient = {
    simulateContract: vi.fn(boom),
    waitForTransactionReceipt: vi.fn(boom),
  } as unknown as PublicClient;
  const walletClient = {
    account: undefined,
    writeContract: vi.fn(boom),
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

describe('Suite 1 — adversarial verifyEip3009', () => {
  // ── 1. Wrong signer ─────────────────────────────────────────────────────
  describe('wrong signer', () => {
    it('signature from a DIFFERENT key than `from` → INVALID_SIGNATURE/401', async () => {
      // Attacker signs the message but claims it is from SIGNER_ADDR.
      const params = await makeParams({ signerPk: ATTACKER_PK });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('INVALID_SIGNATURE');
        expect(r.error.http).toBe(401);
      }
    });

    it('attacker sets `from` to its OWN address but signs a tampered message → INVALID_SIGNATURE', async () => {
      // Attacker signs over from=SIGNER then post-sign rewrites from=ATTACKER.
      const params = await makeParams({
        authOverrides: { from: ATTACKER_ADDR },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('a rejected verify never triggers a chain call when wrapped by settle', async () => {
      const params = (await makeParams({ signerPk: ATTACKER_PK })) as SettleParams;
      const { publicClient, walletClient } = explodingClients();
      const r = await settleEip3009(params, TOKEN, CHAIN_ID, publicClient, walletClient);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  // ── 2. Tampered fields after signing ────────────────────────────────────
  describe('tampered-after-signing fields', () => {
    it('amount RAISED post-sign (value committed=1000, claim value=5000) → INVALID_SIGNATURE', async () => {
      // Legit signature over value=1000; tamper authorization.value upward.
      // recoverTypedDataAddress hashes the tampered value → recovered != from.
      const params = await makeParams({ authOverrides: { value: '5000' } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('`to` changed post-sign (≠ payTo) → INVALID_RECEIVER (receiver mismatch wins before recover)', async () => {
      const evil = '0x4444444444444444444444444444444444444444' as Address;
      const params = await makeParams({ authOverrides: { to: evil } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      // Receiver check (step 5) runs before signature recover (step 8).
      if (!r.ok) expect(r.error.code).toBe('INVALID_RECEIVER');
    });

    it('both `to` AND `payTo` changed to a colluding address → INVALID_SIGNATURE (passes receiver, fails recover)', async () => {
      const evil = '0x5555555555555555555555555555555555555555' as Address;
      // to==payTo so receiver check passes, but the signature committed to the
      // ORIGINAL to=PAY_TO → recovered address differs → rejected.
      const params = await makeParams({
        authOverrides: { to: evil },
        acceptedOverrides: { payTo: evil },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('nonce changed post-sign → INVALID_SIGNATURE (nonce is part of the EIP-712 struct)', async () => {
      const params = await makeParams({
        authOverrides: { nonce: `0x${'bb'.repeat(32)}` as `0x${string}` },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('asset changed (accepted.asset ≠ token registry) → NETWORK_MISMATCH/400', async () => {
      const params = await makeParams({
        acceptedOverrides: { asset: `0x${'ab'.repeat(20)}` },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('NETWORK_MISMATCH');
        expect(r.error.http).toBe(400);
      }
    });

    it('network/chainId changed (accepted.network ≠ eip155:<chainId>) → NETWORK_MISMATCH/400', async () => {
      const params = await makeParams({
        acceptedOverrides: { network: 'eip155:1' },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('NETWORK_MISMATCH');
        expect(r.error.http).toBe(400);
      }
    });

    // Property-style sweep over many tampered authorization fields. Seeded /
    // deterministic — every entry is a known mutation with a known reject code.
    const tamperVectors: ReadonlyArray<{
      name: string;
      auth?: Partial<VerifyParams['payload']['authorization']>;
      accepted?: Partial<VerifyParams['accepted']>;
      expect: ReadonlyArray<string>;
    }> = [
      { name: 'value=1001', auth: { value: '1001' }, expect: ['INVALID_SIGNATURE'] },
      { name: 'value=999 (below accepted)', auth: { value: '999' }, expect: ['INVALID_AMOUNT'] },
      {
        name: 'from=zero-addr',
        auth: { from: `0x${'00'.repeat(20)}` as Address },
        expect: ['INVALID_SIGNATURE'],
      },
      {
        name: 'nonce all-zero',
        auth: { nonce: `0x${'00'.repeat(32)}` as `0x${string}` },
        expect: ['INVALID_SIGNATURE'],
      },
      {
        name: 'nonce all-ff',
        auth: { nonce: `0x${'ff'.repeat(32)}` as `0x${string}` },
        expect: ['INVALID_SIGNATURE'],
      },
      {
        name: 'asset=zero-addr',
        accepted: { asset: `0x${'00'.repeat(20)}` },
        expect: ['NETWORK_MISMATCH'],
      },
      {
        name: 'network=eip155:99999',
        accepted: { network: 'eip155:99999' },
        expect: ['NETWORK_MISMATCH'],
      },
    ];

    it.each(tamperVectors)('seeded tamper vector: $name → rejected', async (vec) => {
      const params = await makeParams({
        ...(vec.auth ? { authOverrides: vec.auth } : {}),
        ...(vec.accepted ? { acceptedOverrides: vec.accepted } : {}),
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(vec.expect).toContain(r.error.code);
    });
  });

  // ── 3. Time window ───────────────────────────────────────────────────────
  describe('time window', () => {
    it('validBefore in the PAST (expired) → EXPIRED_AUTHORIZATION/400', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec - 3600),
          validBefore: BigInt(nowSec - 1),
        },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('EXPIRED_AUTHORIZATION');
        expect(r.error.http).toBe(400);
      }
    });

    it('validAfter in the FUTURE (not yet valid) → EXPIRED_AUTHORIZATION/400', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec + 3600),
          validBefore: BigInt(nowSec + 7200),
        },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EXPIRED_AUTHORIZATION');
    });

    it('BOUNDARY: validBefore === now → expired (strict <=) → EXPIRED_AUTHORIZATION', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec - 10),
          validBefore: BigInt(nowSec),
        },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EXPIRED_AUTHORIZATION');
    });

    it('BOUNDARY: validAfter === now → accepted (validAfter <= now)', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeParams({
        nowSec,
        messageOverrides: {
          validAfter: BigInt(nowSec),
          validBefore: BigInt(nowSec + 3600),
        },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(true);
    });

    // Twin of T-H5 in verify.test.ts, and it carries the SAME real-clock race:
    // a 1-second window built from `Date.now()` that `verifyEip3009` re-reads.
    // If the second boundary falls between the two reads the authorization is
    // rejected as EXPIRED and this goes red for no reason. Freeze `Date` only
    // (timers untouched, so the `await` on the signature cannot hang), and
    // restore it in `finally` so nothing leaks into sibling tests.
    it('BOUNDARY: validBefore === now + 1 → accepted (now < validBefore)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const nowSec = Math.floor(Date.now() / 1000);
        const params = await makeParams({
          nowSec,
          messageOverrides: {
            validAfter: BigInt(nowSec - 10),
            validBefore: BigInt(nowSec + 1),
          },
        });
        const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
        expect(r.ok).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── 4. Signature malleability (high-s) ──────────────────────────────────
  describe('signature malleability', () => {
    it('high-s variant of a valid signature → INVALID_SIGNATURE before recover (EIP-2)', async () => {
      const valid = await makeParams();
      const body = valid.payload.signature.slice(2);
      const rHex = body.slice(0, 64);
      const sHex = body.slice(64, 128);
      const vHex = body.slice(128, 130);
      const sLow = BigInt(`0x${sHex}`);
      // Force the high-half representation: s' = n - s (the malleable twin).
      const sHigh = sLow <= SECP256K1_N_HALF ? SECP256K1_N - sLow : sLow;
      expect(sHigh).toBeGreaterThan(SECP256K1_N_HALF);
      const flippedV = vHex === '1b' ? '1c' : '1b';
      const malleable =
        `0x${rHex}${sHigh.toString(16).padStart(64, '0')}${flippedV}` as `0x${string}`;
      const params = await makeParams({ signatureOverride: malleable });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('high-s never reaches a chain call (settle path short-circuits)', async () => {
      const valid = await makeParams();
      const body = valid.payload.signature.slice(2);
      const rHex = body.slice(0, 64);
      const sHex = body.slice(64, 128);
      const sLow = BigInt(`0x${sHex}`);
      const sHigh = sLow <= SECP256K1_N_HALF ? SECP256K1_N - sLow : sLow;
      const malleable = `0x${rHex}${sHigh.toString(16).padStart(64, '0')}1c` as `0x${string}`;
      const params = (await makeParams({ signatureOverride: malleable })) as SettleParams;
      const { publicClient, walletClient } = explodingClients();
      const r = await settleEip3009(params, TOKEN, CHAIN_ID, publicClient, walletClient);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
    });

    it('s === 0 → INVALID_SIGNATURE (not a valid secp256k1 scalar)', async () => {
      const valid = await makeParams();
      const body = valid.payload.signature.slice(2);
      const rHex = body.slice(0, 64);
      const zeroS = '00'.repeat(32);
      const sig = `0x${rHex}${zeroS}1b` as `0x${string}`;
      const params = await makeParams({ signatureOverride: sig });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('s === n (out of range) → INVALID_SIGNATURE', async () => {
      const valid = await makeParams();
      const body = valid.payload.signature.slice(2);
      const rHex = body.slice(0, 64);
      const sAtN = SECP256K1_N.toString(16).padStart(64, '0');
      const sig = `0x${rHex}${sAtN}1b` as `0x${string}`;
      const params = await makeParams({ signatureOverride: sig });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });
  });

  // ── 5. Replay ────────────────────────────────────────────────────────────
  describe('replay', () => {
    it('verify is pure: the SAME nonce verifies twice (replay protection is the chain nonce, not verify)', async () => {
      // verify.ts explicitly does NOT check replay — the on-chain EIP-3009
      // nonce is the guard. We pin that contract so a future refactor that
      // silently added nonce de-dup here (changing the documented behavior)
      // would surface as a failing test.
      const params = await makeParams();
      const r1 = await verifyEip3009(params, TOKEN, CHAIN_ID);
      const r2 = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    it('replay via alternative encoding (high-s twin) is rejected — only ONE canonical hex is accepted', async () => {
      // The classic malleability replay: same logical signature, second valid
      // hex via high-s. The low-s original verifies; the high-s twin must NOT.
      const valid = await makeParams();
      const okResult = await verifyEip3009(valid, TOKEN, CHAIN_ID);
      expect(okResult.ok).toBe(true);

      const body = valid.payload.signature.slice(2);
      const rHex = body.slice(0, 64);
      const sHex = body.slice(64, 128);
      const vHex = body.slice(128, 130);
      const sLow = BigInt(`0x${sHex}`);
      const sHigh = sLow <= SECP256K1_N_HALF ? SECP256K1_N - sLow : sLow;
      const flippedV = vHex === '1b' ? '1c' : '1b';
      const twin = `0x${rHex}${sHigh.toString(16).padStart(64, '0')}${flippedV}` as `0x${string}`;
      const replayParams = await makeParams({ signatureOverride: twin });
      const replay = await verifyEip3009(replayParams, TOKEN, CHAIN_ID);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe('INVALID_SIGNATURE');
    });
  });

  // ── 6. Amount edge cases ─────────────────────────────────────────────────
  describe('amount edge cases', () => {
    it('accepted.amount = "0" → INVALID_AMOUNT/400', async () => {
      const params = await makeParams({ acceptedOverrides: { amount: '0' } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('INVALID_AMOUNT');
        expect(r.error.http).toBe(400);
      }
    });

    it('accepted.amount = "-1" (negative) → INVALID_AMOUNT without throwing', async () => {
      const params = await makeParams({ acceptedOverrides: { amount: '-1' } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
    });

    it('authorized value ABOVE accepted is fine; accepted ABOVE authorized value → INVALID_AMOUNT', async () => {
      // accepted.amount=2000 but signed value=1000 → value < accepted → reject.
      const params = await makeParams({
        messageOverrides: { value: 1000n },
        acceptedOverrides: { amount: '2000' },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
    });

    it('value === accepted exactly → accepted (boundary)', async () => {
      const params = await makeParams({
        messageOverrides: { value: 4242n },
        acceptedOverrides: { amount: '4242' },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(true);
    });

    it('uint256 MAX value signed and accepted → accepted (no BigInt overflow / no Number() loss)', async () => {
      const maxStr = UINT256_MAX.toString();
      const params = await makeParams({
        messageOverrides: { value: UINT256_MAX },
        acceptedOverrides: { amount: maxStr },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.amount).toBe(maxStr);
    });

    it('value overflow (> 2^256-1, 79 digits) → rejected by schema, no throw', async () => {
      const params = await makeParams({ authOverrides: { value: '1'.repeat(79) } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('accepted.amount overflow (> 2^256-1) → INVALID_AMOUNT, no throw', async () => {
      const params = await makeParams({
        acceptedOverrides: { amount: (UINT256_MAX + 1n).toString() },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
    });

    it('BigInt comparison: amount just above 2^53 is NOT lost to Number() precision', async () => {
      // 2^53 + 1 = 9007199254740993. As a Number this rounds to 9007199254740992.
      // A naive Number() comparison would treat value(2^53) and accepted(2^53+1)
      // as equal and ACCEPT — the BigInt path must REJECT (value < accepted).
      const accepted = '9007199254740993'; // 2^53 + 1
      const params = await makeParams({
        messageOverrides: { value: 9007199254740992n }, // 2^53
        acceptedOverrides: { amount: accepted },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
    });

    it('BigInt comparison: value 2^53+1 over accepted 2^53 → accepted (no precision collapse)', async () => {
      const params = await makeParams({
        messageOverrides: { value: 9007199254740993n }, // 2^53 + 1
        acceptedOverrides: { amount: '9007199254740992' }, // 2^53
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(true);
    });

    // Seeded malformed-amount sweep (attacker-controlled accepted.amount strings).
    const malformedAmounts: ReadonlyArray<{ amount: string; code: string }> = [
      { amount: 'abc', code: 'INVALID_AMOUNT' },
      { amount: '1e2', code: 'INVALID_AMOUNT' },
      { amount: '0x10', code: 'INVALID_AMOUNT' },
      { amount: '1.5', code: 'INVALID_AMOUNT' },
      { amount: ' 100', code: 'INVALID_AMOUNT' },
      { amount: '01000', code: 'INVALID_AMOUNT' },
      { amount: '', code: 'INVALID_AMOUNT' },
      { amount: '-5', code: 'INVALID_AMOUNT' },
    ];

    it.each(malformedAmounts)(
      'malformed accepted.amount "$amount" → $code, never throws',
      async ({ amount, code }) => {
        const params = await makeParams({ acceptedOverrides: { amount } });
        const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe(code);
      },
    );
  });

  // ── 7. Wrong EIP-712 domain ──────────────────────────────────────────────
  describe('wrong EIP-712 domain', () => {
    it('domain NAME differs → recovered address differs → INVALID_SIGNATURE', async () => {
      const params = await makeParams({ domainOverrides: { name: 'Evil Token' } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('domain VERSION differs → INVALID_SIGNATURE', async () => {
      const params = await makeParams({ domainOverrides: { version: '2' } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('domain verifyingContract differs → INVALID_SIGNATURE', async () => {
      const params = await makeParams({
        domainOverrides: { verifyingContract: `0x${'cc'.repeat(20)}` as Address },
      });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    it('domain chainId differs (signed on chain 1, verified on 2368) → INVALID_SIGNATURE', async () => {
      const params = await makeParams({ domainOverrides: { chainId: 1 } });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });

    // Seeded domain-attack sweep.
    const domainVectors: ReadonlyArray<{
      name: string;
      domain: Partial<TypedDataDomain>;
    }> = [
      { name: 'name empty', domain: { name: '' } },
      { name: 'version=0', domain: { version: '0' } },
      { name: 'chainId=2367 (off-by-one)', domain: { chainId: 2367 } },
      { name: 'chainId=2369 (off-by-one)', domain: { chainId: 2369 } },
      {
        name: 'verifyingContract=zero',
        domain: { verifyingContract: `0x${'00'.repeat(20)}` as Address },
      },
    ];

    it.each(domainVectors)('seeded impostor domain: $name → INVALID_SIGNATURE', async (vec) => {
      const params = await makeParams({ domainOverrides: vec.domain });
      const r = await verifyEip3009(params, TOKEN, CHAIN_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_SIGNATURE');
    });
  });
});
