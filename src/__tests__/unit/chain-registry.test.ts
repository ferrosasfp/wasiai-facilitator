import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChainRegistry } from '../../chains/registry.js';
import type { ChainAdapter, ChainMetadata } from '../../chains/types.js';
import { asChainId } from '../../core/types.js';

function makeMockAdapter(chainIdNum: number, name = `Chain ${chainIdNum}`): ChainAdapter {
  const metadata: ChainMetadata = {
    chainId: asChainId(chainIdNum),
    name,
    network: 'testnet',
    networkId: `eip155:${chainIdNum}`,
    rpcUrl: 'https://example.test/rpc',
    nativeCurrency: { name: 'Test', symbol: 'TST', decimals: 18 },
    tokens: [],
  };
  return {
    metadata,
    verify: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    settle: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    getPublicClient: vi.fn(() => ({}) as never),
    getWalletClient: vi.fn(() => ({}) as never),
  };
}

describe('ChainRegistry', () => {
  let registry: ChainRegistry;

  beforeEach(() => {
    registry = new ChainRegistry();
  });

  describe('register()', () => {
    it('AC-1: registers an adapter and returns ok', () => {
      const adapter = makeMockAdapter(2368, 'Kite Testnet');
      const result = registry.register(adapter);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.chainId).toBe(asChainId(2368));
    });

    it('AC-5: returns NETWORK_MISMATCH + http 409 on duplicate chainId, does NOT overwrite', () => {
      const first = makeMockAdapter(2368, 'First');
      const second = makeMockAdapter(2368, 'Second');
      registry.register(first);
      const result = registry.register(second);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(409);
        expect(result.error.message).toMatch(/already registered/);
      }
      const stored = registry.getAdapter(asChainId(2368));
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.adapter.metadata.name).toBe('First');
    });

    it('AC-6: returns NETWORK_MISMATCH + http 500 on invalid adapter shape', () => {
      const result = registry.register({} as ChainAdapter);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(500);
        expect(result.error.message).toMatch(/missing required/);
      }
    });
  });

  describe('getAdapter()', () => {
    it('AC-1: returns the registered adapter in O(1) via Map lookup', () => {
      const adapter = makeMockAdapter(2368);
      registry.register(adapter);
      const result = registry.getAdapter(asChainId(2368));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.adapter).toBe(adapter);
    });

    it('AC-4: returns NETWORK_MISMATCH + http 400 for unregistered chainId (never throws)', () => {
      const result = registry.getAdapter(asChainId(9999));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('listAdapters()', () => {
    it('AC-2: returns array of metadata with no duplicate chainIds', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      registry.register(makeMockAdapter(43113));
      const list = registry.listAdapters();
      expect(list).toHaveLength(3);
      const ids = list.map((m) => m.chainId);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('getSupportedChainIds()', () => {
    it('AC-3: returns unique chainId array', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(43113));
      const ids = registry.getSupportedChainIds();
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('setLogger() + logging behavior (AC-10, DT-11)', () => {
    it('AC-10: logs info with chainId and name when logger injected', () => {
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      registry.setLogger(logger as never);
      registry.register(makeMockAdapter(2368, 'Kite Testnet'));
      expect(logger.info).toHaveBeenCalledWith(
        { chainId: asChainId(2368), name: 'Kite Testnet' },
        'Chain adapter registered',
      );
    });

    it('does not throw and does not log when no logger set', () => {
      expect(() => registry.register(makeMockAdapter(2368))).not.toThrow();
    });

    it('logs once per registered adapter', () => {
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      registry.setLogger(logger as never);
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      expect(logger.info).toHaveBeenCalledTimes(2);
    });
  });

  describe('_resetForTesting() (CD-9)', () => {
    it('clears all adapters when NODE_ENV === "test"', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      registry._resetForTesting();
      expect(registry.getSupportedChainIds()).toHaveLength(0);
    });

    it('throws when NODE_ENV !== "test"', () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => registry._resetForTesting()).toThrow(/test environment/);
      } finally {
        process.env['NODE_ENV'] = originalEnv;
      }
    });
  });
});

describe('ChainRegistry — module-load integration (AC-9)', () => {
  // PR feat/mainnet — keys we mutate in setup/teardown of this suite.
  const SUITE_ENV_KEYS = [
    'KITE_TESTNET_RPC_URL',
    'KITE_MAINNET_RPC_URL',
    'KITE_MAINNET_ENABLED',
    'KITE_MAINNET_USDC_ADDRESS',
    'AVALANCHE_FUJI_RPC_URL',
    'AVALANCHE_MAINNET_RPC_URL',
    'AVALANCHE_MAINNET_ENABLED',
    'OPERATOR_PRIVATE_KEY',
    'KITE_USDC_ADDRESS',
  ] as const;

  /* eslint-disable security/detect-object-injection -- tuple of hardcoded env-var names, not user input. */
  function snap(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of SUITE_ENV_KEYS) out[k] = process.env[k];
    return out;
  }
  function restore(s: Record<string, string | undefined>): void {
    for (const k of SUITE_ENV_KEYS) {
      if (s[k] === undefined) delete process.env[k];
      else process.env[k] = s[k];
    }
  }
  /* eslint-enable security/detect-object-injection */

  it('registers at least one chain when src/chains/index.ts is imported with env vars set', async () => {
    vi.resetModules();
    const prev = snap();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    process.env['OPERATOR_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    process.env['KITE_USDC_ADDRESS'] = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

    try {
      await import('../../chains/index.js');
      const { chainRegistry } = await import('../../chains/registry.js');
      expect(chainRegistry.getSupportedChainIds().length).toBeGreaterThanOrEqual(1);
    } finally {
      restore(prev);
    }
  });

  it('PR feat/mainnet: with mainnet flags OFF, only testnet chains register (default behavior)', async () => {
    vi.resetModules();
    const prev = snap();
    // Both mainnets are set up (RPC + token addr) but the ENABLED flags are
    // explicitly absent. Default-deny gating MUST exclude them from the registry.
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_USDC_ADDRESS'] = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    process.env['AVALANCHE_MAINNET_RPC_URL'] = 'https://api.avax.network/ext/bc/C/rpc';
    delete process.env['KITE_MAINNET_ENABLED'];
    delete process.env['AVALANCHE_MAINNET_ENABLED'];
    process.env['OPERATOR_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    process.env['KITE_USDC_ADDRESS'] = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

    try {
      const { chainRegistry } = await import('../../chains/registry.js');
      chainRegistry._resetForTesting();
      await import('../../chains/index.js');
      const ids = chainRegistry
        .getSupportedChainIds()
        .map(Number)
        .sort((a, b) => a - b);
      expect(ids).toEqual([2368, 43113]);
    } finally {
      restore(prev);
    }
  });

  it('PR feat/mainnet: with KITE_MAINNET_ENABLED=true + RPC + token, Kite Mainnet registers', async () => {
    vi.resetModules();
    const prev = snap();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'true';
    process.env['KITE_MAINNET_USDC_ADDRESS'] = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    delete process.env['AVALANCHE_MAINNET_ENABLED'];
    process.env['OPERATOR_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    process.env['KITE_USDC_ADDRESS'] = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

    try {
      const { chainRegistry } = await import('../../chains/registry.js');
      chainRegistry._resetForTesting();
      await import('../../chains/index.js');
      const ids = chainRegistry
        .getSupportedChainIds()
        .map(Number)
        .sort((a, b) => a - b);
      expect(ids).toContain(2366);
      expect(ids).toEqual([2366, 2368, 43113]);
    } finally {
      restore(prev);
    }
  });

  it('PR feat/mainnet: all 4 chains register when both mainnet flags are true', async () => {
    vi.resetModules();
    const prev = snap();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'true';
    process.env['KITE_MAINNET_USDC_ADDRESS'] = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    process.env['AVALANCHE_MAINNET_RPC_URL'] = 'https://api.avax.network/ext/bc/C/rpc';
    process.env['AVALANCHE_MAINNET_ENABLED'] = 'true';
    process.env['OPERATOR_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    process.env['KITE_USDC_ADDRESS'] = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

    try {
      const { chainRegistry } = await import('../../chains/registry.js');
      chainRegistry._resetForTesting();
      await import('../../chains/index.js');
      const ids = chainRegistry
        .getSupportedChainIds()
        .map(Number)
        .sort((a, b) => a - b);
      expect(ids).toEqual([2366, 2368, 43113, 43114]);
    } finally {
      restore(prev);
    }
  });
});
