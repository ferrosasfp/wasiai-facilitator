import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// NOTE: we intentionally do NOT import ChainAdapterInitError statically here.
// `vi.resetModules()` (used in beforeEach) invalidates the module cache and
// causes subsequent dynamic imports of ../../chains/types.js to produce a
// DIFFERENT class constructor. If we compared instances against a statically
// imported reference, `instanceof` would fail for all but the first test.
// Instead we match by error name + message via regex — the thrown error is
// still the domain-defined `ChainAdapterInitError`, just from a freshly
// re-evaluated module graph.

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'AVALANCHE_FUJI_RPC_URL',
] as const;

/* eslint-disable security/detect-object-injection -- `k` is constrained to the
 * const tuple ENV_KEYS literal (3 hardcoded env-var names). Not user input; the
 * security/detect-object-injection heuristic cannot narrow tuple element types. */
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

describe('kite.ts adapters', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('AC-11: kiteTestnetAdapter has chainId 2368 and testnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteTestnetAdapter.metadata.chainId).toBe(2368);
    expect(mod.kiteTestnetAdapter.metadata.network).toBe('testnet');
    expect(mod.kiteTestnetAdapter.metadata.networkId).toBe('eip155:2368');
  });

  it('AC-12: kiteMainnetAdapter has chainId 2366 and mainnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteMainnetAdapter.metadata.chainId).toBe(2366);
    expect(mod.kiteMainnetAdapter.metadata.network).toBe('mainnet');
    expect(mod.kiteMainnetAdapter.metadata.networkId).toBe('eip155:2366');
  });

  it('AC-13: throws ChainAdapterInitError when KITE_TESTNET_RPC_URL missing', async () => {
    delete process.env['KITE_TESTNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_TESTNET_RPC_URL/);
  });

  it('AC-13: throws ChainAdapterInitError when KITE_MAINNET_RPC_URL missing', async () => {
    delete process.env['KITE_MAINNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_MAINNET_RPC_URL/);
  });

  it('DT-4: getPublicClient returns an object with readContract method', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient();
    expect(client).toBeDefined();
    expect(typeof client.readContract).toBe('function');
  });

  it('DT-4: getWalletClient returns an object with writeContract method (no account — cannot sign)', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getWalletClient();
    expect(client).toBeDefined();
    expect(typeof client.writeContract).toBe('function');
  });

  it('verify returns NETWORK_MISMATCH with pending WFAC-10 message', async () => {
    const mod = await import('../../chains/kite.js');
    const result = await mod.kiteTestnetAdapter.verify({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toMatch(/WFAC-10/);
    }
  });

  it('settle returns NETWORK_MISMATCH with pending WFAC-11 message', async () => {
    const mod = await import('../../chains/kite.js');
    const result = await mod.kiteTestnetAdapter.settle({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toMatch(/WFAC-11/);
    }
  });
});

describe('avalanche.ts adapter', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('has chainId 43113 and testnet network', async () => {
    const mod = await import('../../chains/avalanche.js');
    expect(mod.avalancheFujiAdapter.metadata.chainId).toBe(43113);
    expect(mod.avalancheFujiAdapter.metadata.network).toBe('testnet');
    expect(mod.avalancheFujiAdapter.metadata.networkId).toBe('eip155:43113');
  });

  it('throws ChainAdapterInitError when AVALANCHE_FUJI_RPC_URL missing', async () => {
    delete process.env['AVALANCHE_FUJI_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(/AVALANCHE_FUJI_RPC_URL/);
  });

  it('exposes USDC Fuji in tokens list with decimals 6', async () => {
    const mod = await import('../../chains/avalanche.js');
    const tokens = mod.avalancheFujiAdapter.metadata.tokens;
    expect(tokens).toHaveLength(1);
    const usdc = tokens[0];
    expect(usdc).toBeDefined();
    if (usdc) {
      expect(usdc.symbol).toBe('USDC');
      expect(usdc.decimals).toBe(6);
    }
  });

  it('verify returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.verify({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });

  it('settle returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.settle({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });
});
