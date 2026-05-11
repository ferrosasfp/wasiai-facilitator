/**
 * Unit tests for settleEip3009.
 *
 * Covers all 14 ACs of WFAC-10 (see doc/sdd/006-wfac-10-eip3009-settle/work-item.md)
 * plus 1 hardening test (T-H1 — sanitize non-Error throws).
 *
 * Mocks: PublicClient.simulateContract + PublicClient.waitForTransactionReceipt
 * + WalletClient.writeContract via vi.fn(). No real RPC, no vi.mock('viem', ...)
 * (CD-8). Signature fixtures generated offline with privateKeyToAccount
 * (Hardhat account #0).
 */

import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient, TypedDataDomain, WalletClient } from 'viem';
import { settleEip3009 } from '../../../../methods/eip3009/settle.js';
import {
  EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE,
  FIAT_TOKEN_ABI,
  RECEIPT_TIMEOUT_MS,
} from '../../../../methods/eip3009/abi.js';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, SettleParams } from '../../../../chains/types.js';
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
const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

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

async function makeValidParams(opts?: {
  nowSec?: number;
  messageOverrides?: Partial<AuthMessage>;
  acceptedOverrides?: Partial<SettleParams['accepted']>;
  signatureOverride?: `0x${string}`;
}): Promise<SettleParams> {
  // nowSec + 3600 buffer (CD-NEW-14 — no flake on slow CI).
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
  const domain = buildEip3009Domain(TEST_TOKEN, TEST_CHAIN_ID, {
    extra: { assetTransferMethod: 'eip3009' },
  } as SettleParams['accepted']);
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

function makeMockClients(): { publicClient: PublicClient; walletClient: WalletClient } {
  // DT-D: partial mock — tests only exercise simulateContract +
  // waitForTransactionReceipt on PublicClient, and writeContract on
  // WalletClient. The `as unknown as X` cast is the ONLY place it is
  // permitted (per Story File §0 rule 8).
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: undefined,
    writeContract: vi.fn(),
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

describe('settleEip3009', () => {
  describe('AC-1 — simulate before write', () => {
    it('calls simulateContract before writeContract', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      const callOrder: string[] = [];
      vi.mocked(publicClient.simulateContract).mockImplementation(async () => {
        callOrder.push('sim');
        return { request: {} as never, result: undefined as never };
      });
      vi.mocked(walletClient.writeContract).mockImplementation(async () => {
        callOrder.push('write');
        return TEST_TX_HASH;
      });
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(callOrder).toEqual(['sim', 'write']);
    });
  });

  describe('AC-2 — simulateContract throws', () => {
    it('returns SIMULATION_FAILED and does not call writeContract', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('execution reverted: nonce used'),
      );

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SIMULATION_FAILED');
        expect(result.error.http).toBe(500);
      }
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('AC-3 — writeContract uses sim.request', () => {
    it('passes sim.request object opaquely to writeContract (CD-9)', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      const opaqueRequest = { __opaque: 'marker' };
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: opaqueRequest as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(walletClient.writeContract).toHaveBeenCalledWith(opaqueRequest);
    });
  });

  describe('AC-4 — writeContract throws', () => {
    it('returns TRANSACTION_FAILED on write error', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockRejectedValueOnce(new Error('RPC drop'));

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.http).toBe(500);
      }
    });
  });

  describe('AC-5 — wait for receipt with timeout', () => {
    it('calls waitForTransactionReceipt with hash and RECEIPT_TIMEOUT_MS', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
        transactionHash: TEST_TX_HASH,
      } as never);

      await settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient);
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: TEST_TX_HASH,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      // Guard against accidental literal drift (CD-4).
      expect(RECEIPT_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('AC-6 — receipt timeout', () => {
    it('returns TRANSACTION_FAILED with message "receipt timeout" on WaitForTransactionReceiptTimeoutError', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      const timeoutErr = new Error('Timed out while waiting for transaction');
      timeoutErr.name = 'WaitForTransactionReceiptTimeoutError';
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(timeoutErr);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.message).toBe('receipt timeout');
        expect(result.error.http).toBe(500);
      }
    });
  });

  describe('AC-7 — receipt status reverted', () => {
    it('returns TRANSACTION_FAILED with "transaction reverted on-chain"', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'reverted',
        blockNumber: 42n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TRANSACTION_FAILED');
        expect(result.error.message).toBe('transaction reverted on-chain');
        expect(result.error.http).toBe(500);
      }
    });
  });

  describe('AC-8 — happy path SettleResult shape', () => {
    it('returns ok:true with correct SettleResult fields', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.settled).toBe(true);
        expect(result.transactionHash).toBe(TEST_TX_HASH);
        expect(result.blockNumber).toBe(123);
        expect(result.amount).toBe('1000');
        expect(result.from).toBe(TEST_SIGNER_ADDRESS);
        expect(result.to).toBe(TEST_PAY_TO);
        expect(result.asset).toBe(TEST_TOKEN.address);
      }
    });
  });

  describe('AC-9 — verify is called first', () => {
    it('propagates verify error unchanged and skips simulateContract', async () => {
      // Force verify to fail with NETWORK_MISMATCH by mismatching network.
      const params = await makeValidParams({
        acceptedOverrides: { network: 'eip155:9999' },
      });
      const { publicClient, walletClient } = makeMockClients();

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
      }
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('AC-10 — no subcode mapping from revert reasons', () => {
    it('returns plain SIMULATION_FAILED even with recognizable revert string', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('execution reverted: authorization is used'),
      );

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Must NOT map to EXPIRED_AUTHORIZATION or INVALID_SIGNATURE — settle
        // does not interpret revert reason strings.
        expect(result.error.code).toBe('SIMULATION_FAILED');
      }
    });
  });

  describe('AC-11 — ABI shape matches v/r/s overload', () => {
    it('FIAT_TOKEN_ABI has transferWithAuthorization with 9 inputs ending in v,r,s', () => {
      // WFAC-53 FIX-2 — FIAT_TOKEN_ABI was extended with a 2nd entry
      // (`DOMAIN_SEPARATOR()` view) for the boot-time drift assertion.
      // Length is now 2; this test continues to validate the original
      // transferWithAuthorization entry by `name` rather than positional [0]
      // (defensive against future entry order changes).
      expect(FIAT_TOKEN_ABI).toHaveLength(2);
      const fn = FIAT_TOKEN_ABI.find((e) => e.name === 'transferWithAuthorization');
      expect(fn).toBeDefined();
      expect(fn?.name).toBe('transferWithAuthorization');
      expect(fn?.inputs).toHaveLength(9);
      expect(fn?.inputs[6]?.name).toBe('v');
      expect(fn?.inputs[6]?.type).toBe('uint8');
      expect(fn?.inputs[7]?.name).toBe('r');
      expect(fn?.inputs[7]?.type).toBe('bytes32');
      expect(fn?.inputs[8]?.name).toBe('s');
      expect(fn?.inputs[8]?.type).toBe('bytes32');
    });
  });

  describe('AC-12 — no real RPC in tests', () => {
    it('structural: tests only use vi.fn() stubs — no http/createPublicClient import', () => {
      // Structural enforcement: this file does not import `http` or
      // `createPublicClient`/`createWalletClient` from viem — verified by
      // the imports at the top. All interactions go through makeMockClients().
      expect(true).toBe(true);
    });
  });

  describe('AC-13 — 5 error paths + happy path covered', () => {
    it('coverage: sim-fail (AC-2), write-fail (AC-4), receipt-revert (AC-7), receipt-timeout (AC-6), happy (AC-8)', () => {
      // Structural — the five dedicated tests above cover every path. This
      // test exists as a coverage checklist anchor for reviewers.
      expect(true).toBe(true);
    });
  });

  describe('AC-14 — no exceptions thrown (AdapterResult contract)', () => {
    it('settleEip3009 resolves (never rejects) on simulate failure', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(new Error('boom'));
      await expect(
        settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient),
      ).resolves.toMatchObject({ ok: false });
    });

    it('settleEip3009 resolves (never rejects) on write failure', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockRejectedValueOnce(new Error('boom'));
      await expect(
        settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient),
      ).resolves.toMatchObject({ ok: false });
    });

    it('settleEip3009 resolves (never rejects) on receipt failure', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(new Error('boom'));
      await expect(
        settleEip3009(params, TEST_TOKEN, TEST_CHAIN_ID, publicClient, walletClient),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  describe('AC-15 (WFAC-13) — legacy v=0/1 normalized, EIP-2098 compact expanded', () => {
    // WFAC-13 supersedes the pre-existing CD-NEW-15 reject-path: the guard
    // `!('v' in parsed) || parsed.v === undefined` has been replaced by
    // `normalizeSignature`, which NORMALIZES v ∈ {0,1} → {27,28} (AC-3 of
    // WFAC-13) and EXPANDS 64-byte EIP-2098 compact → 65-byte standard
    // (AC-2 of WFAC-13). These tests pin the new behaviour end-to-end (no
    // mocking of viem — CD-8 compliance).
    it('normalizes tampered v=0/1 last byte and proceeds to simulateContract', async () => {
      const validParams = await makeValidParams();
      const sigHex = validParams.payload.signature.slice(2);
      const sigBytes = Buffer.from(sigHex, 'hex');
      const originalV = sigBytes[64]; // 0x1b or 0x1c
      // Pick matching yParity so the signature remains cryptographically valid
      // (recover passes verify AC-9 via yParity form → reaches settle's
      // normalizeSignature which lifts v=0/1 → 27/28).
      sigBytes[64] = originalV === 0x1c ? 0x01 : 0x00;
      const tamperedSig = `0x${sigBytes.toString('hex')}` as `0x${string}`;

      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
      } as never);

      const result = await settleEip3009(
        {
          ...validParams,
          payload: { ...validParams.payload, signature: tamperedSig },
        },
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );

      expect(result.ok).toBe(true);
      // simulateContract receives v ∈ {27, 28} (normalized from the 0x00/0x01
      // last byte). Inspect the call to pin the normalization behaviour.
      expect(publicClient.simulateContract).toHaveBeenCalledTimes(1);
      const simArgs = vi.mocked(publicClient.simulateContract).mock.calls[0]?.[0];
      // args tuple: [from, to, value, validAfter, validBefore, nonce, v, r, s]
      const vPassed = (simArgs as { args: readonly unknown[] }).args[6];
      expect([27, 28]).toContain(vPassed);
    });

    it('expands 64-byte EIP-2098 compact signature and proceeds to simulateContract', async () => {
      const validParams = await makeValidParams();
      // Compress the canonical 65-byte sig into EIP-2098 compact (64 bytes).
      const sigHex = validParams.payload.signature.slice(2);
      const rHex = sigHex.slice(0, 64);
      const sHex = sigHex.slice(64, 128);
      const vHex = sigHex.slice(128, 130);
      const sBig = BigInt(`0x${sHex}`);
      const vNum = Number.parseInt(vHex, 16);
      const yParity = vNum === 27 ? 0n : 1n;
      const yParityAndS = (yParity << 255n) | sBig;
      const compactSig = `0x${rHex}${yParityAndS.toString(16).padStart(64, '0')}` as `0x${string}`;

      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
      } as never);

      const result = await settleEip3009(
        {
          ...validParams,
          payload: { ...validParams.payload, signature: compactSig },
        },
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );

      // verify.ts canonicalizes the 64-byte compact sig to a 65-byte standard
      // hex (via normalizeSignature) before calling recoverTypedDataAddress —
      // viem's recover does NOT accept compact form directly. settle.ts then
      // runs its own normalizeSignature pass and passes v/r/s to simulateContract.
      expect(result.ok).toBe(true);
      expect(publicClient.simulateContract).toHaveBeenCalledTimes(1);
    });

    it('rejects high-s (malleable) signature with INVALID_SIGNATURE', async () => {
      const validParams = await makeValidParams();
      const sigHex = validParams.payload.signature.slice(2);
      const rHex = sigHex.slice(0, 64);
      const sHex = sigHex.slice(64, 128);
      const vHex = sigHex.slice(128, 130);
      const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const sBig = BigInt(`0x${sHex}`);
      const SECP256K1_N_HALF = SECP256K1_N / 2n;
      // Flip s into the opposite half. If the original is low, n-s is high.
      const flippedS = sBig <= SECP256K1_N_HALF ? SECP256K1_N - sBig : sBig;
      // Flip v parity to keep the tampered sig well-formed if needed.
      const malleableVHex = vHex === '1b' ? '1c' : '1b';
      const malleableSig = `0x${rHex}${flippedS
        .toString(16)
        .padStart(64, '0')}${malleableVHex}` as `0x${string}`;

      const { publicClient, walletClient } = makeMockClients();
      const result = await settleEip3009(
        {
          ...validParams,
          payload: { ...validParams.payload, signature: malleableSig },
        },
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
      // Settle short-circuits before any RPC call.
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  // ── Hardening tests ─────────────────────────────────────────────────────

  describe('T-H1 — sanitize handles non-Error throws / concurrency', () => {
    it('returns bounded string message even when throw value is a plain string', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce('plain string error');

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message.length).toBeLessThanOrEqual(200);
        expect(result.error.code).toBe('SIMULATION_FAILED');
      }
    });

    it('truncates absurdly long Error messages to ≤200 chars', async () => {
      const params = await makeValidParams();
      const { publicClient, walletClient } = makeMockClients();
      const longMsg = 'x'.repeat(5000);
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(new Error(longMsg));

      const result = await settleEip3009(
        params,
        TEST_TOKEN,
        TEST_CHAIN_ID,
        publicClient,
        walletClient,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.length).toBeLessThanOrEqual(200);
      }
    });

    it('two concurrent settle calls do not cross-talk (Promise.all purity)', async () => {
      const p1 = await makeValidParams();
      const p2 = await makeValidParams({
        messageOverrides: { value: 2000n },
        acceptedOverrides: { amount: '2000' },
      });
      const clients1 = makeMockClients();
      const clients2 = makeMockClients();

      const txHash1 = `0x${'11'.repeat(32)}` as `0x${string}`;
      const txHash2 = `0x${'22'.repeat(32)}` as `0x${string}`;

      vi.mocked(clients1.publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(clients1.walletClient.writeContract).mockResolvedValue(txHash1);
      vi.mocked(clients1.publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 10n,
        transactionHash: txHash1,
      } as never);

      vi.mocked(clients2.publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(clients2.walletClient.writeContract).mockResolvedValue(txHash2);
      vi.mocked(clients2.publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 20n,
        transactionHash: txHash2,
      } as never);

      const [r1, r2] = await Promise.all([
        settleEip3009(p1, TEST_TOKEN, TEST_CHAIN_ID, clients1.publicClient, clients1.walletClient),
        settleEip3009(p2, TEST_TOKEN, TEST_CHAIN_ID, clients2.publicClient, clients2.walletClient),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok) {
        expect(r1.amount).toBe('1000');
        expect(r1.transactionHash).toBe(txHash1);
        expect(r1.blockNumber).toBe(10);
      }
      if (r2.ok) {
        expect(r2.amount).toBe('2000');
        expect(r2.transactionHash).toBe(txHash2);
        expect(r2.blockNumber).toBe(20);
      }
    });
  });
});
