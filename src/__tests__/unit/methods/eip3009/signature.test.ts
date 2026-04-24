/**
 * Unit tests for normalizeSignature (WFAC-13).
 *
 * Covers the 7 scenarios of AC-9:
 *   (a) 65-byte standard happy path
 *   (b) 64-byte EIP-2098 compact happy path
 *   (c) v=0/1 legacy normalization → 27/28
 *   (d) high-s malleability rejection
 *   (e) invalid length rejection
 *   (f) r=0 / s=0 rejection
 *   (g) roundtrip: fixture generated with privateKeyToAccount.signTypedData
 *       → normalize → reconstruct hex → recoverTypedDataAddress matches signer.
 *
 * Fixtures are generated offline with Hardhat account #0 (CD-5) — same pattern
 * as verify.test.ts / settle.test.ts. No RPC, no hardcoded arbitrary signatures.
 */

import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import { normalizeSignature } from '../../../../methods/eip3009/signature.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

// Hardhat account #0 — public knowledge.
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

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_N_HALF = SECP256K1_N / 2n;

type AuthMessage = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

function makeDomainAndMessage(): { domain: TypedDataDomain; message: AuthMessage } {
  const nowSec = Math.floor(Date.now() / 1000);
  const message: AuthMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
  };
  const domain = buildEip3009Domain(TEST_TOKEN, TEST_CHAIN_ID, {
    extra: { assetTransferMethod: 'eip3009' },
  } as VerifyParams['accepted']);
  return { domain, message };
}

async function signFixture(): Promise<{
  domain: TypedDataDomain;
  message: AuthMessage;
  signature: Hex;
}> {
  const { domain, message } = makeDomainAndMessage();
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const signature = await account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message,
  });
  return { domain, message, signature };
}

/** Render a bigint as a 32-byte (64-hex-char) string WITHOUT `0x` prefix. */
function bi32(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** Render a bigint as a 32-byte `0x`-prefixed hex. */
function hex32(n: bigint): Hex {
  return `0x${bi32(n)}` as Hex;
}

/**
 * Compress a 65-byte standard ECDSA signature into 64-byte EIP-2098 compact.
 * yParity is encoded in the high bit of s.
 */
function toEip2098(sig: Hex): Hex {
  const body = sig.slice(2);
  const rHex = body.slice(0, 64);
  const sHex = body.slice(64, 128);
  const vHex = body.slice(128, 130);
  const sBig = BigInt(`0x${sHex}`);
  const vNum = Number.parseInt(vHex, 16);
  const yParity = vNum === 27 || vNum === 0 ? 0n : 1n;
  const yParityAndS = (yParity << 255n) | sBig;
  return `0x${rHex}${bi32(yParityAndS)}` as Hex;
}

describe('normalizeSignature (WFAC-13)', () => {
  // ── (a) 65-byte standard happy path ─────────────────────────────────────
  describe('AC-1 — 65-byte standard ECDSA happy path', () => {
    it('returns { ok: true, r, s, v } for a canonical v=27/28 signature', async () => {
      const { signature } = await signFixture();
      const result = normalizeSignature(signature);
      expect(result.ok).toBe(true);
      if (!result.ok) return; // type guard
      // viem's parseSignature is used only as a cross-check — our logic is
      // independent (DT-5) but must agree on r/s/v for well-formed inputs.
      const viemParsed = parseSignature(signature);
      expect(result.r).toBe(viemParsed.r);
      expect(result.s).toBe(viemParsed.s);
      if (viemParsed.v !== undefined) {
        expect(result.v).toBe(viemParsed.v);
      }
      expect([27n, 28n]).toContain(result.v);
    });

    it('pads r and s to 32 bytes (66 hex chars including 0x)', async () => {
      const { signature } = await signFixture();
      const result = normalizeSignature(signature);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.s).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  // ── (b) 64-byte EIP-2098 compact happy path ─────────────────────────────
  describe('AC-2 — 64-byte EIP-2098 compact happy path', () => {
    it('expands compact signature to { r, s, v } matching the standard form', async () => {
      const { signature } = await signFixture();
      const compact = toEip2098(signature);
      expect(compact.length).toBe(2 + 128); // 0x + 128 hex = 64 bytes

      const compactResult = normalizeSignature(compact);
      const standardResult = normalizeSignature(signature);
      expect(compactResult.ok).toBe(true);
      expect(standardResult.ok).toBe(true);
      if (!compactResult.ok || !standardResult.ok) return;

      expect(compactResult.r).toBe(standardResult.r);
      expect(compactResult.s).toBe(standardResult.s);
      expect(compactResult.v).toBe(standardResult.v);
    });

    it('extracts yParity=0 → v=27 from compact', () => {
      // r = 0x01..01 (non-zero). yParityAndS with high bit = 0 → v=27.
      const r = `${'01'.repeat(32)}`;
      const s = bi32(1n); // yParity bit = 0, low s = 1
      const compact = `0x${r}${s}` as Hex;
      const result = normalizeSignature(compact);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.v).toBe(27n);
      expect(result.s).toBe(hex32(1n));
    });

    it('extracts yParity=1 → v=28 from compact and clears the high bit', () => {
      const r = `${'01'.repeat(32)}`;
      // yParityAndS = (1 << 255) | 42 → yParity=1, clean s = 42.
      const yParityAndS = (1n << 255n) | 42n;
      const compact = `0x${r}${bi32(yParityAndS)}` as Hex;
      const result = normalizeSignature(compact);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.v).toBe(28n);
      expect(result.s).toBe(hex32(42n));
    });
  });

  // ── (c) v=0/1 legacy normalization ──────────────────────────────────────
  describe('AC-3 — legacy v=0/1 normalized to v=27/28', () => {
    it('normalizes v=0 last byte to v=27n', async () => {
      const { signature } = await signFixture();
      // Replace last byte (v) with 0x00.
      const tampered = (signature.slice(0, -2) + '00') as Hex;
      const result = normalizeSignature(tampered);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.v).toBe(27n);
    });

    it('normalizes v=1 last byte to v=28n', async () => {
      const { signature } = await signFixture();
      const tampered = (signature.slice(0, -2) + '01') as Hex;
      const result = normalizeSignature(tampered);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.v).toBe(28n);
    });

    it('rejects v=29 or other out-of-range values', async () => {
      const { signature } = await signFixture();
      const tampered = (signature.slice(0, -2) + '1d') as Hex; // 0x1d = 29
      const result = normalizeSignature(tampered);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.http).toBe(401);
      expect(result.error.message).toContain('v value');
    });
  });

  // ── (d) s-malleability rejection ────────────────────────────────────────
  describe('AC-4 — rejects high-s (EIP-2 malleability)', () => {
    it('rejects signature with s inverted into high half', async () => {
      const { signature } = await signFixture();
      const viemParsed = parseSignature(signature);
      const sBig = BigInt(viemParsed.s);
      // If original s is low, invert to high: s' = n - s (> n/2).
      // If original already high (rare for viem output), this makes it low →
      // pick the opposite orientation.
      const highS = sBig <= SECP256K1_N_HALF ? SECP256K1_N - sBig : sBig;
      expect(highS).toBeGreaterThan(SECP256K1_N_HALF);

      const vHex = viemParsed.v === 28n ? '1c' : '1b';
      const malleable = `0x${viemParsed.r.slice(2)}${bi32(highS)}${vHex}` as Hex;

      const result = normalizeSignature(malleable);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.http).toBe(401);
      expect(result.error.message).toContain('high half');
    });

    it('accepts boundary s = n/2 (inclusive, per EIP-2 "<= n/2")', () => {
      // Build a synthetic signature with s = n/2 exactly. r = 1 to avoid the
      // r=0 guard. v = 27. This is purely to pin the boundary condition of
      // the `s > n/2` check — it is NOT cryptographically valid.
      const r = bi32(1n);
      const s = bi32(SECP256K1_N_HALF);
      const sig = `0x${r}${s}1b` as Hex;
      const result = normalizeSignature(sig);
      expect(result.ok).toBe(true);
    });

    it('rejects s = n/2 + 1 (strictly above the boundary)', () => {
      const r = bi32(1n);
      const s = bi32(SECP256K1_N_HALF + 1n);
      const sig = `0x${r}${s}1b` as Hex;
      const result = normalizeSignature(sig);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('high half');
    });
  });

  // ── (e) invalid length rejection ────────────────────────────────────────
  describe('AC-5 — invalid length', () => {
    it('rejects empty string', () => {
      const result = normalizeSignature('0x' as Hex);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.message).toContain('length');
    });

    it('rejects 100-char hex body (too short)', () => {
      const result = normalizeSignature(`0x${'ab'.repeat(50)}` as Hex);
      expect(result.ok).toBe(false);
    });

    it('rejects 200-char hex body (too long, not 130 or 132)', () => {
      const result = normalizeSignature(`0x${'ab'.repeat(100)}` as Hex);
      expect(result.ok).toBe(false);
    });

    it('rejects input missing 0x prefix', () => {
      // Type-assert around the branded Hex parameter since we are testing
      // defensive runtime behaviour against malformed strings.
      const result = normalizeSignature('ab'.repeat(65) as unknown as Hex);
      expect(result.ok).toBe(false);
    });

    it('rejects 130-char body with non-hex in v position', () => {
      // Valid r and s, but last char (v) is 'z'. Body length is 130.
      const bad = `0x${'ab'.repeat(65).slice(0, -1)}z` as Hex;
      const result = normalizeSignature(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('hex');
    });

    it('rejects 130-char body with non-hex in r position', () => {
      const badR = 'z' + 'a'.repeat(63);
      const goodS = 'b'.repeat(64);
      const bad = `0x${badR}${goodS}1b` as Hex;
      const result = normalizeSignature(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('hex');
    });

    it('rejects 130-char body with non-hex in s position', () => {
      const goodR = 'a'.repeat(64);
      const badS = 'z' + 'b'.repeat(63);
      const bad = `0x${goodR}${badS}1b` as Hex;
      const result = normalizeSignature(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('hex');
    });
  });

  // ── (f) r=0 or s=0 rejection ────────────────────────────────────────────
  describe('AC-6 — r=0 or s=0 rejection', () => {
    it('rejects signature with r = 0 (standard 65-byte)', () => {
      const r = bi32(0n);
      const s = bi32(1n);
      const sig = `0x${r}${s}1b` as Hex;
      const result = normalizeSignature(sig);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.message).toContain('zero');
    });

    it('rejects signature with s = 0 (standard 65-byte)', () => {
      const r = bi32(1n);
      const s = bi32(0n);
      const sig = `0x${r}${s}1b` as Hex;
      const result = normalizeSignature(sig);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('zero');
    });

    it('rejects compact signature with clean s = 0 (yParity bit only)', () => {
      const r = bi32(1n);
      // yParityAndS with high bit set but low 255 bits zero → s cleaned = 0.
      const yParityAndS = 1n << 255n;
      const compact = `0x${r}${bi32(yParityAndS)}` as Hex;
      const result = normalizeSignature(compact);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('zero');
    });

    it('rejects compact signature with r = 0', () => {
      const r = bi32(0n);
      const yParityAndS = bi32(1n);
      const compact = `0x${r}${yParityAndS}` as Hex;
      const result = normalizeSignature(compact);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('zero');
    });

    it('rejects r or s >= n (out of range)', () => {
      // r = n → out of range (not on curve).
      const r = bi32(SECP256K1_N);
      const s = bi32(1n);
      const sig = `0x${r}${s}1b` as Hex;
      const result = normalizeSignature(sig);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('out of range');
    });
  });

  // ── (g) fixture roundtrip ───────────────────────────────────────────────
  describe('AC-9(g) — roundtrip: normalize → reconstruct → recoverTypedDataAddress', () => {
    it('preserves cryptographic validity through normalization', async () => {
      const { domain, message, signature } = await signFixture();
      const result = normalizeSignature(signature);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Reconstruct the standard 65-byte hex from normalized r/s/v.
      const vHex = result.v === 27n ? '1b' : '1c';
      const reconstructed = `0x${result.r.slice(2)}${result.s.slice(2)}${vHex}` as Hex;

      const recovered = await recoverTypedDataAddress({
        domain,
        types: EIP3009_TYPES,
        primaryType: EIP3009_PRIMARY_TYPE,
        message,
        signature: reconstructed,
      });
      expect(recovered.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
    });

    it('roundtrip also works starting from the EIP-2098 compact encoding', async () => {
      const { domain, message, signature } = await signFixture();
      const compact = toEip2098(signature);
      const result = normalizeSignature(compact);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const vHex = result.v === 27n ? '1b' : '1c';
      const reconstructed = `0x${result.r.slice(2)}${result.s.slice(2)}${vHex}` as Hex;

      const recovered = await recoverTypedDataAddress({
        domain,
        types: EIP3009_TYPES,
        primaryType: EIP3009_PRIMARY_TYPE,
        message,
        signature: reconstructed,
      });
      expect(recovered.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
    });
  });

  // ── Pureness / shape contract ───────────────────────────────────────────
  describe('AC-10 — return shape contract', () => {
    it('success variant has exactly { ok, r, s, v } keys', async () => {
      const { signature } = await signFixture();
      const result = normalizeSignature(signature);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result).sort()).toEqual(['ok', 'r', 's', 'v']);
    });

    it('failure variant has { ok, error } and matches Err["error"] shape', () => {
      const result = normalizeSignature('0x' as Hex);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(Object.keys(result).sort()).toEqual(['error', 'ok']);
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.http).toBe(401);
      expect(typeof result.error.message).toBe('string');
    });

    it('never throws on adversarial input (CD-4)', () => {
      const adversarial: string[] = [
        '',
        '0x',
        '0xzz',
        '0x' + 'g'.repeat(130),
        '0x' + 'a'.repeat(129), // odd length
        '0x' + 'a'.repeat(131),
        '0x' + 'a'.repeat(500),
      ];
      for (const s of adversarial) {
        expect(() => normalizeSignature(s as Hex)).not.toThrow();
      }
    });
  });
});
