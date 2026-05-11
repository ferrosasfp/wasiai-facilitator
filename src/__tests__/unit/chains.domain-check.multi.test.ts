/**
 * WFAC-53 FIX-2 — cross-chain Promise.allSettled semantics (CD-14).
 *
 * Verifies that one chain with a down RPC does NOT block the check on the
 * other chains. Registers 2 fake adapters: one returns a matching separator,
 * the other throws. Expected: no fatal, no exit, warn for the broken one,
 * debug for the healthy one.
 *
 * Helpers (makeFakeKiteAdapter / makeFakeAvalancheAdapter / makeStubLogger)
 * are copied inline here to minimize cross-file dependencies between test
 * files (Story §C3 cross-chain test snippet, line 1004).
 *
 * Refs: CD-14, AC-5.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { domainSeparator } from 'viem';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { initDomainCheck } from '../../chains/init-domain-check.js';
import type { ChainAdapter } from '../../chains/types.js';

const KITE_TESTNET_TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const KITE_TESTNET_LOCAL_SEP = domainSeparator({
  domain: {
    name: 'PYUSD',
    version: '1',
    chainId: 2368,
    verifyingContract: KITE_TESTNET_TOKEN_ADDRESS,
  },
});

const AVAX_FUJI_TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222' as `0x${string}`;

function makeFakeKiteAdapter(opts: {
  readContractImpl: (params: unknown) => Promise<unknown>;
}): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(2368),
      name: 'Kite Testnet',
      network: 'testnet',
      networkId: 'eip155:2368',
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      tokens: [
        {
          address: KITE_TESTNET_TOKEN_ADDRESS,
          symbol: 'PYUSD',
          decimals: 18,
          name: 'PYUSD',
          eip712Name: 'PYUSD',
          eip712Version: '1',
        },
      ],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: () =>
      ({
        readContract: vi.fn().mockImplementation(opts.readContractImpl),
      }) as unknown as ReturnType<ChainAdapter['getPublicClient']>,
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
  };
}

function makeFakeAvalancheAdapter(opts: {
  readContractImpl: (params: unknown) => Promise<unknown>;
}): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(43113),
      name: 'Avalanche Fuji',
      network: 'testnet',
      networkId: 'eip155:43113',
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      tokens: [
        {
          address: AVAX_FUJI_TOKEN_ADDRESS,
          symbol: 'USDC',
          decimals: 6,
          name: 'USD Coin',
          eip712Name: 'USD Coin',
          eip712Version: '2',
        },
      ],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: () =>
      ({
        readContract: vi.fn().mockImplementation(opts.readContractImpl),
      }) as unknown as ReturnType<ChainAdapter['getPublicClient']>,
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
  };
}

function makeStubLogger(): Logger & {
  fatal: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger & {
    fatal: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

describe('initDomainCheck — multi-chain allSettled (WFAC-53 CD-14)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DOM-MULTI (CD-14, AC-5): RPC down on 1 chain + match on 1 chain → warn + debug, no fatal', async () => {
    const matchAdapter = makeFakeKiteAdapter({
      readContractImpl: async () => KITE_TESTNET_LOCAL_SEP,
    });
    const downAdapter = makeFakeAvalancheAdapter({
      readContractImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    chainRegistry.register(matchAdapter);
    chainRegistry.register(downAdapter);

    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    // 1 warn (for the down chain) + 1 debug (for the healthy chain)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
