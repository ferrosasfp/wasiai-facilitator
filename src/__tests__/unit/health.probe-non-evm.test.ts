/**
 * fix/health-probe-non-evm — `/health` per-chain RPC probe must be
 * chain-family-agnostic.
 *
 * BUG BEING FIXED: `src/core/health-status.ts#probeChain` resolved the adapter by
 * numeric chainId (`eip155:<id>` key) and probed it with two viem/EVM calls
 * (`getPublicClient().getChainId()`). The Solana adapter is non-EVM by design
 * (`solana:<cluster>` key, no viem client), so it was reported
 * `rpc: 'unreachable'` on EVERY refresh and prod `/health` answered
 * `degraded: true` permanently (5 EVM chains ok + Solana Devnet unreachable).
 *
 * MUTATION CONTRACT: restoring the EVM-only probe
 *   `const c = chainRegistry.getAdapter(meta.chainId); await c.getChainId();`
 * must turn HP-1 / HP-2 / HP-4 RED.
 *
 * NO NETWORK: the Solana `Connection` is injected via `opts.connection` DI
 * (solana-adapter.ts constructor) and every EVM adapter is a local fake, so no
 * test in this file opens a socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { chainRegistry } from '../../chains/registry.js';
import { SolanaAdapter } from '../../chains/solana-adapter.js';
import { kiteTestnetAdapter } from '../../chains/kite.js';
import type { ChainAdapter, ChainMetadata, SettlementAdapter } from '../../chains/types.js';
import { asChainId } from '../../core/types.js';
import {
  refreshHealthStatusNow,
  resetHealthStatusForTesting,
  type ChainHealth,
} from '../../core/health-status.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Base58 pubkeys generated at runtime (never a hardcoded literal → no-secrets). */
const MINT_58 = Keypair.generate().publicKey.toBase58();

/** The 4 EVM chains registered in the production facilitator + their names. */
const PROD_EVM_CHAINS: ReadonlyArray<readonly [number, string]> = [
  [2368, 'Kite Testnet'],
  [43113, 'Avalanche Fuji'],
  [43114, 'Avalanche'],
  [84532, 'Base Sepolia'],
];

function evmMetadata(chainId: number, name: string): ChainMetadata {
  return {
    chainId: asChainId(chainId),
    name,
    network: chainId === 43114 ? 'mainnet' : 'testnet',
    networkId: `eip155:${chainId}`,
    rpcUrl: 'http://127.0.0.1:0',
    nativeCurrency: { name: 'Native', symbol: 'NAT', decimals: 18 },
    tokens: [],
  };
}

interface EvmFake {
  readonly adapter: ChainAdapter;
  readonly getChainId: ReturnType<typeof vi.fn>;
  readonly getPublicClient: ReturnType<typeof vi.fn>;
}

/**
 * EVM fake shaped exactly like the real `BaseEip3009Adapter`: its `probeRpc()`
 * delegates to `getPublicClient().getChainId()`, so the EVM health path stays
 * observable through the same two spies the pre-fix code called directly.
 */
function makeEvmFake(chainId: number, name: string, chainIdImpl: () => Promise<number>): EvmFake {
  const getChainId = vi.fn(chainIdImpl);
  const getPublicClient = vi.fn(
    () => ({ getChainId }) as unknown as ReturnType<ChainAdapter['getPublicClient']>,
  );
  const adapter: ChainAdapter = {
    metadata: evmMetadata(chainId, name),
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient,
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: async (): Promise<void> => {
      await getPublicClient().getChainId();
    },
  };
  return { adapter, getChainId, getPublicClient };
}

interface NonEvmFake {
  readonly adapter: SettlementAdapter;
  readonly probeRpc: ReturnType<typeof vi.fn>;
  /** Present ONLY as a tripwire: a chain-family-aware prober would call it. */
  readonly getPublicClient: ReturnType<typeof vi.fn>;
}

function makeNonEvmFake(opts: {
  chainId: number;
  name: string;
  networkId: string;
  probe: () => Promise<void>;
}): NonEvmFake {
  const probeRpc = vi.fn(opts.probe);
  const getPublicClient = vi.fn(() => {
    throw new Error('non-EVM adapter has no viem public client');
  });
  const adapter: SettlementAdapter = {
    metadata: {
      chainId: asChainId(opts.chainId),
      name: opts.name,
      network: 'testnet',
      networkId: opts.networkId,
      rpcUrl: 'http://127.0.0.1:0',
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      tokens: [],
    },
    verify: vi.fn() as unknown as SettlementAdapter['verify'],
    settle: vi.fn() as unknown as SettlementAdapter['settle'],
    probeRpc,
  };
  // Attached AFTER construction so the object keeps the verify-only type while
  // still exposing the tripwire spy at runtime.
  Object.assign(adapter, { getPublicClient });
  return { adapter, probeRpc, getPublicClient };
}

/** Real SolanaAdapter with an injected fake Connection (DT-9 DI, no network). */
function makeSolanaAdapter(getVersion: ReturnType<typeof vi.fn>): {
  adapter: SolanaAdapter;
  getTransaction: ReturnType<typeof vi.fn>;
} {
  const getTransaction = vi.fn(async () => null);
  const connection = { getVersion, getTransaction } as unknown as Connection;
  const adapter = new SolanaAdapter({
    rpcUrl: 'http://127.0.0.1:0/devnet',
    mint: MINT_58,
    cluster: 'devnet',
    connection,
  });
  return { adapter, getTransaction };
}

function chainOf(chains: readonly ChainHealth[], chainId: number): ChainHealth | undefined {
  return chains.find((c) => c.chainId === chainId);
}

describe('fix/health-probe-non-evm — probeChain is chain-family-agnostic', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
    resetHealthStatusForTesting();
  });

  afterEach(() => {
    chainRegistry._resetForTesting();
    resetHealthStatusForTesting();
    vi.restoreAllMocks();
  });

  // ─── HP-1: the real non-EVM adapter is probed OK, without any viem API ────

  it('HP-1: the real SolanaAdapter is probed via getVersion() and reported "ok" (MUTATION: red on the EVM-only probe)', async () => {
    const getVersion = vi.fn(async () => ({ 'solana-core': '1.18.26' }));
    const { adapter, getTransaction } = makeSolanaAdapter(getVersion);
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();
    const solana = chainOf(snap.chains, 103);

    expect(solana).toBeDefined();
    expect(solana?.network).toBe('solana:devnet');
    // THE regression assertion: this was 'unreachable' in production.
    expect(solana?.rpc).toBe('ok');
    // The probe is the cheapest node-config call, once per refresh...
    expect(getVersion).toHaveBeenCalledTimes(1);
    // ...and it never touches the money path (no tx reads on a health probe).
    expect(getTransaction).not.toHaveBeenCalled();
    // Structural proof there is nothing viem-shaped to probe on this adapter.
    expect('getPublicClient' in adapter).toBe(false);
    expect('getWalletClient' in adapter).toBe(false);
  });

  // ─── HP-2: no viem/EVM API is touched on a non-EVM adapter ───────────────

  it('HP-2: a non-EVM adapter is probed WITHOUT calling getPublicClient()/getChainId()', async () => {
    const fake = makeNonEvmFake({
      chainId: 101,
      name: 'Solana Mainnet',
      networkId: 'solana:mainnet',
      probe: async () => undefined,
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    expect(chainOf(snap.chains, 101)?.rpc).toBe('ok');
    expect(fake.probeRpc).toHaveBeenCalledTimes(1);
    // The EVM-only prober would have reached for a viem client here.
    expect(fake.getPublicClient).not.toHaveBeenCalled();
  });

  // ─── HP-3: the EVM path is unchanged ─────────────────────────────────────

  it('HP-3: the 4 EVM chains are still probed through getPublicClient().getChainId() and all report "ok"', async () => {
    const fakes = PROD_EVM_CHAINS.map(([chainId, name]) =>
      makeEvmFake(chainId, name, async () => chainId),
    );
    for (const f of fakes) expect(chainRegistry.register(f.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    for (const [chainId] of PROD_EVM_CHAINS) {
      expect(chainOf(snap.chains, chainId)?.rpc).toBe('ok');
    }
    for (const f of fakes) {
      expect(f.getPublicClient).toHaveBeenCalledTimes(1);
      expect(f.getChainId).toHaveBeenCalledTimes(1);
    }
  });

  it('HP-3b: the REAL EVM adapter implementation probes with eth_chainId via its viem public client', async () => {
    const getChainId = vi.fn(async () => 2368);
    const spy = vi
      .spyOn(kiteTestnetAdapter, 'getPublicClient')
      .mockReturnValue({ getChainId } as unknown as ReturnType<ChainAdapter['getPublicClient']>);

    await expect(kiteTestnetAdapter.probeRpc()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  // ─── HP-4: degraded is no longer stuck at true ────────────────────────────

  it('HP-4: degraded is false with the full prod chain set (4 EVM + Solana) healthy (MUTATION: red on the EVM-only probe)', async () => {
    for (const [chainId, name] of PROD_EVM_CHAINS) {
      const f = makeEvmFake(chainId, name, async () => chainId);
      expect(chainRegistry.register(f.adapter).ok).toBe(true);
    }
    const { adapter } = makeSolanaAdapter(vi.fn(async () => ({ 'solana-core': '1.18.26' })));
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    expect(snap.chains).toHaveLength(5);
    expect(snap.chains.every((c) => c.rpc === 'ok')).toBe(true);
    // wallet present (vitest env sets OPERATOR_PRIVATE_KEY) + redis 'disabled'
    // (no REDIS_URL in test) are both NON-degrading, so the only remaining
    // degradation source was the phantom Solana 'unreachable'.
    expect(snap.wallet.present).toBe(true);
    expect(snap.redis.status).toBe('disabled');
    expect(snap.degraded).toBe(false);
  });

  // ─── HP-5: the probe never throws ────────────────────────────────────────

  it('HP-5: probeChain never throws — rejecting, synchronously-throwing and probe-less adapters all degrade gracefully', async () => {
    const rejecting = makeNonEvmFake({
      chainId: 901,
      name: 'Rejects',
      networkId: 'solana:rejects',
      probe: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:0');
      },
    });
    const throwingSync: SettlementAdapter = {
      ...makeNonEvmFake({
        chainId: 902,
        name: 'ThrowsSync',
        networkId: 'solana:throws-sync',
        probe: async () => undefined,
      }).adapter,
      probeRpc: (): Promise<void> => {
        throw new Error('boom — synchronous explosion');
      },
    };
    // Adapter smuggled in through an unsafe cast, with NO probeRpc at all
    // (the TS contract makes this impossible in src/, but a bad cast could).
    const probeless = {
      metadata: {
        chainId: asChainId(903),
        name: 'NoProbe',
        network: 'testnet' as const,
        networkId: 'solana:no-probe',
        rpcUrl: 'http://127.0.0.1:0',
        nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
        tokens: [],
      },
      verify: vi.fn(),
      settle: vi.fn(),
    } as unknown as SettlementAdapter;

    expect(chainRegistry.register(rejecting.adapter).ok).toBe(true);
    expect(chainRegistry.register(throwingSync).ok).toBe(true);
    expect(chainRegistry.register(probeless).ok).toBe(true);

    // No rejection escapes the probe.
    const snap = await refreshHealthStatusNow();

    expect(chainOf(snap.chains, 901)?.rpc).toBe('unreachable');
    expect(chainOf(snap.chains, 902)?.rpc).toBe('unreachable');
    expect(chainOf(snap.chains, 903)?.rpc).toBe('unreachable');
    expect(snap.degraded).toBe(true);
  });

  // ─── HP-6/HP-7: rate-limit (429) hysteresis vs hard failures ─────────────

  it('HP-6: a single 429 from the rate-limiting public devnet RPC does NOT flip the chain (tolerated, but reported)', async () => {
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('failed to get version: Error: 429 Too Many Requests');
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const first = await refreshHealthStatusNow();
    const firstSolana = chainOf(first.chains, 103);
    expect(firstSolana?.rpc).toBe('ok'); // tolerated blip — no flapping
    expect(firstSolana?.consecutiveFailures).toBe(1); // but NEVER silent
    expect(firstSolana?.lastFailureKind).toBe('transient');
    expect(first.degraded).toBe(false);

    // A SECOND consecutive transient failure is no longer a blip.
    const second = await refreshHealthStatusNow();
    const secondSolana = chainOf(second.chains, 103);
    expect(secondSolana?.rpc).toBe('unreachable');
    expect(secondSolana?.consecutiveFailures).toBe(2);
    expect(second.degraded).toBe(true);
  });

  it('HP-6b: a successful probe resets the transient counter (and omits the additive fields)', async () => {
    let fail = true;
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        if (fail) throw new Error('429 Too Many Requests');
        return undefined;
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    expect(chainOf((await refreshHealthStatusNow()).chains, 103)?.consecutiveFailures).toBe(1);
    fail = false;
    const recovered = chainOf((await refreshHealthStatusNow()).chains, 103);
    expect(recovered?.rpc).toBe('ok');
    expect(recovered?.consecutiveFailures).toBeUndefined();
    expect(recovered?.lastFailureKind).toBeUndefined();

    // And a later 429 starts counting from 1 again (no accumulated history).
    fail = true;
    expect(chainOf((await refreshHealthStatusNow()).chains, 103)?.consecutiveFailures).toBe(1);
  });

  // NOTE: vitest 4 takes the options object as the SECOND argument (the
  // `it(name, fn, opts)` signature was removed in v4).
  it(
    'HP-6c: a hung RPC hits the short probe timeout, is classified transient and is bounded',
    { timeout: 10_000 },
    async () => {
      const fake = makeNonEvmFake({
        chainId: 103,
        name: 'Solana Devnet',
        networkId: 'solana:devnet',
        // Never resolves — exactly what a 429-retrying Connection looks like.
        probe: () => new Promise<void>(() => undefined),
      });
      expect(chainRegistry.register(fake.adapter).ok).toBe(true);

      const started = Date.now();
      const snap = await refreshHealthStatusNow();
      const elapsed = Date.now() - started;

      // Bounded by RPC_PROBE_TIMEOUT_MS (1500ms) — a health refresh never hangs.
      expect(elapsed).toBeLessThan(4000);
      const solana = chainOf(snap.chains, 103);
      expect(solana?.lastFailureKind).toBe('transient');
      expect(solana?.rpc).toBe('ok'); // first timeout tolerated
      expect(snap.degraded).toBe(false);
    },
  );

  it('HP-7: a hard connection failure is reported "unreachable" on the FIRST probe (no hysteresis)', async () => {
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8899');
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();
    const solana = chainOf(snap.chains, 103);
    expect(solana?.rpc).toBe('unreachable');
    expect(solana?.consecutiveFailures).toBe(1);
    expect(solana?.lastFailureKind).toBe('connection');
    expect(snap.degraded).toBe(true);
  });

  // ─── HP-8: the /health response shape is unchanged (additive only) ────────

  it('HP-8: a healthy chain entry keeps EXACTLY the legacy keys (new fields are additive/omitted)', async () => {
    const f = makeEvmFake(2368, 'Kite Testnet', async () => 2368);
    expect(chainRegistry.register(f.adapter).ok).toBe(true);
    const { adapter } = makeSolanaAdapter(vi.fn(async () => ({ 'solana-core': '1.18.26' })));
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    expect(Object.keys(snap).sort()).toEqual(['chains', 'degraded', 'probedAt', 'redis', 'wallet']);
    for (const chain of snap.chains) {
      expect(Object.keys(chain).sort()).toEqual(['chainId', 'name', 'network', 'rpc']);
    }
  });
});
