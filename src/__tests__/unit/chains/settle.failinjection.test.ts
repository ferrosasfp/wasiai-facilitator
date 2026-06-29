/**
 * Suite 2 (part B) — Failure-injection on the on-chain settle path.
 *
 * Mocks the chain dependencies of `BaseEip3009Adapter.settle` (via the real
 * kiteTestnetAdapter + vi.spyOn on getPublicClient/getWalletClient) and asserts
 * MONEY-SAFE behavior on every adversarial failure mode:
 *
 *   - simulateContract reverts → SIMULATION_FAILED, NO broadcast (writeContract
 *     never called).
 *   - writeContract throws → TRANSACTION_FAILED, surfaced cleanly, no receipt
 *     wait, never throws.
 *   - waitForTransactionReceipt times out → TRANSACTION_FAILED 'receipt timeout'.
 *   - receipt.status === 'reverted' → TRANSACTION_FAILED 'transaction reverted'.
 *   - Per-chain circuit breaker OPEN → settle rejected FAST with
 *     CHAIN_UNAVAILABLE 503 + retryAfterMs, BEFORE any RPC.
 *   - Idempotency: a settle that already broadcast a tx and then fails on the
 *     receipt does NOT re-broadcast on the adapter call (one writeContract per
 *     settle invocation — the orchestrator/cache layer dedups retries; pinned
 *     in routes.settle.failinjection.test.ts).
 *
 * Deterministic + fast: NO real RPC, NO real settlement. Every viem call is a
 * vi.fn() stub.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Chain, PublicClient, WalletClient } from 'viem';
import type { VerifyParams } from '../../../chains/types.js';

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'KITE_MAINNET_ENABLED',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
  'CB_FAILURE_THRESHOLD',
  'CB_ROLLING_WINDOW_MS',
  'CB_ENABLED',
] as const;

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

/* eslint-disable security/detect-object-injection -- ENV_KEYS is a fixed literal tuple, not attacker-controlled. */
function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}
/* eslint-enable security/detect-object-injection */

function makeMockClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const operatorAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: operatorAccount,
    writeContract: vi.fn(),
    chain: {} as Chain,
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

async function makeValidParams(): Promise<VerifyParams> {
  const { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } = await import('../../../chains/abi/fiat-token.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const baseMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
  };
  const domain = { name: 'PYUSD', version: '1', chainId: 2368, verifyingContract: TEST_USDC };
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const signature = await account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: baseMessage,
  });
  return {
    x402Version: 2,
    resource: { url: 'https://example.com' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: '1000',
      asset: TEST_USDC,
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009' },
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
  } as unknown as VerifyParams;
}

describe('Suite 2B — settle on-chain failure injection (money-safe)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'false';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  // ── simulateContract reverts ────────────────────────────────────────────
  describe('simulateContract reverts → no broadcast', () => {
    it('SIMULATION_FAILED and writeContract NEVER called (no money moves)', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(
        new Error('execution reverted: FiatTokenV2: authorization is used or canceled'),
      );

      const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('SIMULATION_FAILED');
        expect(r.error.http).toBe(500);
        // Revert reason is NOT interpreted into a sub-code.
        expect(r.error.message.length).toBeLessThanOrEqual(200);
      }
      // The money-safety invariant: a failed simulation must NEVER broadcast.
      expect(walletClient.writeContract).not.toHaveBeenCalled();
      expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it('settle RESOLVES (never rejects) when simulate throws a non-Error value', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce('raw string boom');

      await expect(mod.kiteTestnetAdapter.settle(await makeValidParams())).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  // ── writeContract throws ────────────────────────────────────────────────
  describe('writeContract throws → clean TRANSACTION_FAILED', () => {
    it('returns TRANSACTION_FAILED, never waits for a receipt, never throws', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: { __opaque: 1 } as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockRejectedValueOnce(
        new Error('nonce too low / replacement transaction underpriced'),
      );

      const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('TRANSACTION_FAILED');
        expect(r.error.http).toBe(500);
      }
      // We never proceed to receipt-wait if the broadcast itself failed.
      expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
    });
  });

  // ── receipt timeout ──────────────────────────────────────────────────────
  describe('waitForTransactionReceipt timeout → TRANSACTION_FAILED "receipt timeout"', () => {
    it('maps the named viem timeout error to the literal "receipt timeout" message', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      const timeoutErr = new Error('Timed out while waiting for transaction to be confirmed.');
      timeoutErr.name = 'WaitForTransactionReceiptTimeoutError';
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(timeoutErr);

      const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('TRANSACTION_FAILED');
        expect(r.error.message).toBe('receipt timeout');
      }
      // A broadcast DID happen (tx in mempool) — exactly one writeContract.
      expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    });

    it('non-timeout receipt error preserves a sanitized message (not the literal)', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(
        new Error('RPC connection reset by peer'),
      );

      const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('TRANSACTION_FAILED');
        expect(r.error.message).not.toBe('receipt timeout');
        expect(r.error.message.length).toBeLessThanOrEqual(200);
      }
    });
  });

  // ── receipt reverted on-chain ────────────────────────────────────────────
  describe('receipt.status === "reverted" → TRANSACTION_FAILED', () => {
    it('reports an on-chain revert distinctly from a timeout', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'reverted',
        blockNumber: 99n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('TRANSACTION_FAILED');
        expect(r.error.message).toBe('transaction reverted on-chain');
      }
    });
  });

  // ── idempotency at the adapter level ────────────────────────────────────
  describe('idempotency: one settle invocation broadcasts at most once', () => {
    it('a receipt-timeout failure broadcast exactly ONE tx (no internal retry/double-broadcast)', async () => {
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      const timeoutErr = new Error('timed out');
      timeoutErr.name = 'WaitForTransactionReceiptTimeoutError';
      vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValue(timeoutErr);

      await mod.kiteTestnetAdapter.settle(await makeValidParams());
      // The adapter does NOT retry writeContract on its own — retry is the
      // orchestrator's job (and is idempotency-gated). Double-broadcast here
      // would mean two on-chain transfers for one settle call.
      expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    });

    it('two identical settle CALLS each broadcast once — same tx hash returned (chain nonce dedups on-chain)', async () => {
      // The adapter is stateless: each call broadcasts. The on-chain EIP-3009
      // nonce is what prevents a true double-spend (the 2nd would revert). Here
      // both succeed against the mock; the invariant we pin is "one broadcast
      // per call" — never two per call.
      const mod = await import('../../../chains/kite.js');
      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
      vi.mocked(publicClient.simulateContract).mockResolvedValue({
        request: {} as never,
        result: undefined as never,
      });
      vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
      vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
        status: 'success',
        blockNumber: 7n,
        transactionHash: TEST_TX_HASH,
      } as never);

      const params = await makeValidParams();
      const r1 = await mod.kiteTestnetAdapter.settle(params);
      const r2 = await mod.kiteTestnetAdapter.settle(params);
      expect(r1.ok && r2.ok).toBe(true);
      // 2 calls → exactly 2 broadcasts (one each), never 4.
      expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    });
  });

  // ── circuit breaker OPEN ─────────────────────────────────────────────────
  describe('circuit breaker OPEN → fast reject before RPC', () => {
    it('settle returns CHAIN_UNAVAILABLE 503 with retryAfterMs and never touches the chain', async () => {
      process.env['CB_FAILURE_THRESHOLD'] = '2';
      process.env['CB_ROLLING_WINDOW_MS'] = '1000';
      process.env['CB_ENABLED'] = 'true';
      vi.resetModules();

      const mod = await import('../../../chains/kite.js');
      const adapter = mod.kiteTestnetAdapter as unknown as {
        _breaker: { recordBusinessFailure: (r: string) => void; getState: () => string };
        getPublicClient: () => PublicClient;
        getWalletClient: () => WalletClient;
        settle: (p: unknown) => Promise<{
          ok: boolean;
          error: { code: string; http: number; retryAfterMs?: number };
        }>;
      };

      const { publicClient, walletClient } = makeMockClients();
      vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
      vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);

      // Force the breaker OPEN.
      for (let i = 0; i < 25; i += 1) adapter._breaker.recordBusinessFailure('SIMULATION_FAILED');
      await new Promise((r) => setImmediate(r));
      expect(adapter._breaker.getState()).toBe('OPEN');

      const result = await adapter.settle(await makeValidParams());
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(result.error.http).toBe(503);
      expect(result.error.retryAfterMs).toBeGreaterThan(0);

      // FAST reject — the open breaker short-circuits before any RPC.
      expect(publicClient.simulateContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });
});
