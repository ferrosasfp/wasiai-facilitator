/**
 * P0 — R-1 / OP-03: per-chain nonce serialization on the settle path.
 *
 * PROVES: two CONCURRENT DISTINCT settles on the SAME chain are serialized so
 * they read DISTINCT operator nonces (no "nonce too low" collision), while
 * concurrent settles on DIFFERENT chains still run in parallel.
 *
 * MODEL: a single operator account signs every settle on a chain. viem reads
 * the next account nonce lazily on each writeContract. We model that with a
 * shared per-chain `pendingNonce` counter: `simulateContract` snapshots the
 * current pending nonce into the built request, and `writeContract` (with an
 * await boundary, like a real broadcast) only increments it AFTER it runs. If
 * two settles were NOT serialized, both would snapshot the SAME nonce before
 * either incremented → a collision the assertions catch. With the per-chain
 * `runExclusive` mutex around the on-chain section of `_settleRaw`, the second
 * settle does not start its simulate until the first has fully broadcast.
 *
 * Deterministic + fast: no real RPC, every viem call is a vi.fn() stub.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Chain, PublicClient, WalletClient } from 'viem';
import type { VerifyParams } from '../../../chains/types.js';

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'KITE_MAINNET_ENABLED',
  'KITE_MAINNET_USDC_ADDRESS',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
] as const;

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;

/* eslint-disable security/detect-object-injection -- ENV_KEYS is a fixed literal tuple. */
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

/**
 * Build a pair of viem client mocks whose nonce assignment is observable.
 *
 * `simulateContract` snapshots `state.pendingNonce` into the returned request.
 * `writeContract` AWAITS (yields the event loop, modelling a real broadcast
 * round-trip) and THEN increments `state.pendingNonce`. The await boundary is
 * the dangerous window: without serialization a second simulate could snapshot
 * the same nonce before the first write increments it.
 */
function makeNonceTrackingClients(state: { pendingNonce: number; usedNonces: number[] }): {
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const operatorAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = {
    simulateContract: vi.fn(async () => {
      // Snapshot the nonce the broadcast WOULD use right now.
      const nonce = state.pendingNonce;
      return { request: { __nonce: nonce } as never, result: undefined as never };
    }),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: 'success' as const,
      blockNumber: 1n,
    })),
  } as unknown as PublicClient;
  const walletClient = {
    account: operatorAccount,
    writeContract: vi.fn(async (req: { __nonce: number }) => {
      // Record the nonce that was committed and advance the account nonce.
      // The await BEFORE the increment models the broadcast round-trip — this
      // is exactly the window a non-serialized second settle would exploit.
      await Promise.resolve();
      state.usedNonces.push(req.__nonce);
      state.pendingNonce = req.__nonce + 1;
      return `0x${'ab'.repeat(32)}` as `0x${string}`;
    }),
    chain: {} as Chain,
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

async function makeValidParams(opts?: {
  network?: string;
  asset?: `0x${string}`;
  nonce?: `0x${string}`;
}): Promise<VerifyParams> {
  const { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } = await import('../../../chains/abi/fiat-token.js');
  const asset = opts?.asset ?? TEST_USDC;
  const network = opts?.network ?? 'eip155:2368';
  const chainId = Number(network.split(':')[1]);
  const nowSec = Math.floor(Date.now() / 1000);
  const baseMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: opts?.nonce ?? (`0x${'aa'.repeat(32)}` as `0x${string}`),
  };
  // Kite Testnet domain (PYUSD); Kite Mainnet uses USD Coin/v2.
  const domain =
    chainId === 2366
      ? { name: 'USD Coin', version: '2', chainId, verifyingContract: asset }
      : { name: 'PYUSD', version: '1', chainId, verifyingContract: asset };
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
      network,
      amount: '1000',
      asset,
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

describe('P0 R-1/OP-03 — per-chain settle nonce serialization', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'true';
    process.env['KITE_MAINNET_USDC_ADDRESS'] = '0x2222222222222222222222222222222222222222';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetChainMutexForTesting } = await import('../../../chains/chain-mutex.js');
    resetChainMutexForTesting();
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('NS-1: two CONCURRENT DISTINCT settles on ONE chain use DISTINCT nonces (no collision)', async () => {
    const mod = await import('../../../chains/kite.js');
    const state = { pendingNonce: 7, usedNonces: [] as number[] };
    const { publicClient, walletClient } = makeNonceTrackingClients(state);
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);

    // Two DISTINCT settles (different EIP-3009 authorization nonces) fired
    // concurrently on the SAME chain.
    const p1 = makeValidParams({ nonce: `0x${'a1'.repeat(32)}` as `0x${string}` });
    const p2 = makeValidParams({ nonce: `0x${'b2'.repeat(32)}` as `0x${string}` });
    const [params1, params2] = await Promise.all([p1, p2]);

    const [r1, r2] = await Promise.all([
      mod.kiteTestnetAdapter.settle(params1),
      mod.kiteTestnetAdapter.settle(params2),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Both broadcasts happened.
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    // THE invariant: the two broadcasts committed DISTINCT, contiguous nonces.
    // A non-serialized path would record [7, 7] (collision) — the Set size
    // assertion fails in that case.
    expect(state.usedNonces).toHaveLength(2);
    expect(new Set(state.usedNonces).size).toBe(2);
    expect([...state.usedNonces].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('NS-2: a burst of N concurrent distinct settles on one chain → N distinct contiguous nonces', async () => {
    const mod = await import('../../../chains/kite.js');
    const state = { pendingNonce: 0, usedNonces: [] as number[] };
    const { publicClient, walletClient } = makeNonceTrackingClients(state);
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);

    const N = 12;
    const paramsList = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        makeValidParams({
          nonce: `0x${i.toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`,
        }),
      ),
    );
    const results = await Promise.all(paramsList.map((p) => mod.kiteTestnetAdapter.settle(p)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(state.usedNonces).toHaveLength(N);
    // All nonces distinct AND contiguous 0..N-1 — no collision, no gap.
    expect(new Set(state.usedNonces).size).toBe(N);
    expect([...state.usedNonces].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
  });

  it('NS-3: settles on DIFFERENT chains are NOT serialized against each other (run in parallel)', async () => {
    const mod = await import('../../../chains/kite.js');
    expect(mod.kiteMainnetAdapter).not.toBeNull();
    const mainnet = mod.kiteMainnetAdapter;
    if (!mainnet) throw new Error('mainnet adapter expected');

    const testnetState = { pendingNonce: 100, usedNonces: [] as number[] };
    const mainnetState = { pendingNonce: 500, usedNonces: [] as number[] };
    const tn = makeNonceTrackingClients(testnetState);
    const mn = makeNonceTrackingClients(mainnetState);
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(tn.publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(tn.walletClient);
    vi.spyOn(mainnet, 'getPublicClient').mockReturnValue(mn.publicClient);
    vi.spyOn(mainnet, 'getWalletClient').mockReturnValue(mn.walletClient);

    const tnParams = await makeValidParams({ network: 'eip155:2368', asset: TEST_USDC });
    const mnParams = await makeValidParams({
      network: 'eip155:2366',
      asset: '0x2222222222222222222222222222222222222222',
    });

    const [rt, rm] = await Promise.all([
      mod.kiteTestnetAdapter.settle(tnParams),
      mainnet.settle(mnParams),
    ]);

    expect(rt.ok).toBe(true);
    expect(rm.ok).toBe(true);
    // Each chain advanced its OWN nonce independently — no cross-chain blocking.
    expect(testnetState.usedNonces).toEqual([100]);
    expect(mainnetState.usedNonces).toEqual([500]);
  });
});

describe('P0 R-1/OP-03 — runExclusive mutex primitive', () => {
  afterEach(async () => {
    const { resetChainMutexForTesting } = await import('../../../chains/chain-mutex.js');
    resetChainMutexForTesting();
  });

  it('RE-1: same chainId → calls run strictly one-at-a-time (no overlap)', async () => {
    const { runExclusive } = await import('../../../chains/chain-mutex.js');
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    async function critical(id: number): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      order.push(id);
      active -= 1;
    }

    await Promise.all(Array.from({ length: 8 }, (_, i) => runExclusive(2368, () => critical(i))));
    // Never two critical sections active at once on the same chain.
    expect(maxActive).toBe(1);
    // FIFO order preserved (arrival order = nonce assignment order).
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('RE-2: different chainIds run concurrently (overlap allowed)', async () => {
    const { runExclusive } = await import('../../../chains/chain-mutex.js');
    let active = 0;
    let maxActive = 0;
    async function critical(): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    }
    await Promise.all([
      runExclusive(1, () => critical()),
      runExclusive(2, () => critical()),
      runExclusive(3, () => critical()),
    ]);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('RE-3: a rejecting call does NOT poison the queue for the next caller', async () => {
    const { runExclusive } = await import('../../../chains/chain-mutex.js');
    const boom = runExclusive(42, async () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');
    // The next call on the same chain still runs.
    const ok = await runExclusive(42, async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('RE-4: the rejected call propagates its own error to ITS caller (not swallowed)', async () => {
    const { runExclusive } = await import('../../../chains/chain-mutex.js');
    const results = await Promise.allSettled([
      runExclusive(99, async () => 'first'),
      runExclusive(99, async () => {
        throw new Error('second-boom');
      }),
      runExclusive(99, async () => 'third'),
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'first' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 'third' });
  });
});
