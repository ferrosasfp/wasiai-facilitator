/**
 * WKH-154 W3 — Breaker accounting through the REAL settle() path.
 *
 * Drives `kiteTestnetAdapter.settle()` with viem clients mocked to throw typed
 * errors, and asserts the circuit breaker only counts TRANSPORT failures:
 *
 *   - BC-1 (AC-1): N business sim-fails (same-account contention) → breaker
 *     stays CLOSED, no CHAIN_UNAVAILABLE (the Chaski-$0 fix).
 *   - BC-2 (AC-2 / CD-1): N transport failures → breaker OPENs → next settle
 *     returns CHAIN_UNAVAILABLE 503 (genuine outage protection preserved).
 *   - BC-3 (AC-3 / CD-7): burst of N-1 business + 1 good settle → CLOSED and the
 *     good settle succeeds (no 503).
 *   - BC-4 (AC-5): ambiguous errors → transport fail-safe → count → OPEN.
 *   - BC-5 (AC-1 / CD-10): the caller-visible result shape is identical to
 *     today; the business tag is invisible.
 *
 * Deterministic + fast: NO real RPC, NO real settlement (CD-4/CD-5). Every viem
 * call is a vi.fn() stub. Breaker isolation per test via env + vi.resetModules()
 * (fresh adapter instance → fresh breaker), mirroring settle.failinjection.test.ts.
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

/** Same-account contention: the crux Chaski error (a business outcome). */
function businessContentionError(): Error {
  return Object.assign(new Error('gas required exceeds allowance (24468/11800/62584)'), {
    name: 'EstimateGasExecutionError',
  });
}

/** Genuine transport failure: RPC returned HTTP 503. */
function transportOutageError(): Error {
  return Object.assign(new Error('Service Unavailable'), {
    name: 'HttpRequestError',
    status: 503,
  });
}

describe('WKH-154 — settle() breaker classification (transport counts, business does not)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'false';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    // Tight thresholds so a handful of TRANSPORT failures trips the breaker fast.
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    process.env['CB_ENABLED'] = 'true';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  // ── BC-1 (AC-1): business contention never opens the breaker ──────────────
  it('BC-1 (AC-1): N business sim-fails keep the breaker CLOSED (no CHAIN_UNAVAILABLE)', async () => {
    const mod = await import('../../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValue(businessContentionError());

    const params = await makeValidParams();
    let chainUnavailable = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = await mod.kiteTestnetAdapter.settle(params);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.code === 'CHAIN_UNAVAILABLE') chainUnavailable += 1;
    }
    await new Promise((r) => setImmediate(r));

    expect(chainUnavailable).toBe(0);
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
    // A failed simulate must never broadcast.
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  // ── BC-2 (AC-2 / CD-1): transport outage still opens the breaker ──────────
  it('BC-2 (AC-2 / CD-1): N transport failures OPEN the breaker → next settle is CHAIN_UNAVAILABLE 503', async () => {
    const mod = await import('../../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValue(transportOutageError());

    const params = await makeValidParams();
    for (let i = 0; i < 30; i += 1) {
      await mod.kiteTestnetAdapter.settle(params);
    }
    await new Promise((r) => setImmediate(r));

    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('OPEN');

    const openResult = await mod.kiteTestnetAdapter.settle(params);
    expect(openResult.ok).toBe(false);
    if (!openResult.ok) {
      expect(openResult.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(openResult.error.http).toBe(503);
      expect(openResult.error.retryAfterMs).toBeGreaterThan(0);
    }
  });

  // ── BC-3 (AC-3 / CD-7): burst N-1 business + 1 good → CLOSED, good succeeds ─
  it('BC-3 (AC-3 / CD-7): burst of business contention + 1 good settle → CLOSED and good settle succeeds', async () => {
    const mod = await import('../../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);

    const N = 6;
    // N-1 business contention sim-fails queued first (mockRejectedValueOnce wins
    // over the default), then the default resolves OK for the good settle.
    for (let i = 0; i < N - 1; i += 1) {
      vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(businessContentionError());
    }
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
    for (let i = 0; i < N - 1; i += 1) {
      const r = await mod.kiteTestnetAdapter.settle(params);
      expect(r.ok).toBe(false); // business failures
    }
    const good = await mod.kiteTestnetAdapter.settle(params);
    await new Promise((r) => setImmediate(r));

    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.settled).toBe(true);
      expect(good.transactionHash).toBe(TEST_TX_HASH);
    }
  });

  // ── BC-4 (AC-5): ambiguous errors count (fail-safe) → OPEN ─────────────────
  it('BC-4 (AC-5): ambiguous sim-fails are transport fail-safe → breaker OPENs', async () => {
    const mod = await import('../../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValue(new Error('sim fail'));

    const params = await makeValidParams();
    for (let i = 0; i < 30; i += 1) {
      await mod.kiteTestnetAdapter.settle(params);
    }
    await new Promise((r) => setImmediate(r));

    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('OPEN');
  });

  // ── BC-5 (AC-1 / CD-10): caller-visible shape unchanged (tag invisible) ────
  it('BC-5 (AC-1 / CD-10): business sim-fail returns SIMULATION_FAILED with an identical shape (tag invisible)', async () => {
    const mod = await import('../../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(businessContentionError());

    const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SIMULATION_FAILED');
      expect(r.error.http).toBe(500);
      // The tag is a non-enumerable symbol — invisible to keys / JSON.
      expect(Object.keys(r.error).sort()).toEqual(['code', 'http', 'message']);
      expect(JSON.stringify(r)).not.toContain('breakerClass');
      expect(JSON.stringify(r)).not.toContain('business');
    }
  });
});
