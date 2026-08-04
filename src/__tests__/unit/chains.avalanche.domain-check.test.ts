/**
 * WFAC-53 FIX-2 — Avalanche domain separator boot check tests.
 *
 * Pattern mirrors src/__tests__/unit/chains/init-breakers.test.ts:
 * chainRegistry._resetForTesting + register fake adapter with mocked
 * getPublicClient().readContract.
 *
 * Refs: AC-4, AC-5, AC-8, CD-14.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { domainSeparator } from 'viem';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { initDomainCheck } from '../../chains/init-domain-check.js';
import type { ChainAdapter } from '../../chains/types.js';

// Compute the canonical Avalanche Fuji USDC domain separator (Circle USDC
// canonical eip712Name='USD Coin', version='2', decimals=6 — see
// src/chains/avalanche.ts:95-102).
const AVAX_FUJI_TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const AVAX_FUJI_LOCAL_SEP = domainSeparator({
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: 43113,
    verifyingContract: AVAX_FUJI_TOKEN_ADDRESS,
  },
});

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
    probeRpc: vi.fn(async (): Promise<void> => undefined),
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

describe('initDomainCheck — Avalanche (WFAC-53 FIX-2)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DOM-AVAX-1 (AC-4, AC-8a): match → boot continues, debug log', async () => {
    const adapter = makeFakeAvalancheAdapter({
      readContractImpl: async () => AVAX_FUJI_LOCAL_SEP,
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 43113 }),
      expect.stringContaining('domain separator OK'),
    );
  });

  it('T-DOM-AVAX-2 (AC-4, AC-8b): mismatch → fatal log + process.exit(1)', async () => {
    const adapter = makeFakeAvalancheAdapter({
      readContractImpl: async () =>
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 43113,
        expected: AVAX_FUJI_LOCAL_SEP,
      }),
      expect.stringContaining('drift detected'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('T-DOM-AVAX-3 (AC-5, AC-8c): RPC throws → warn log, no fatal, no exit', async () => {
    const adapter = makeFakeAvalancheAdapter({
      readContractImpl: async () => {
        throw new Error('ECONNREFUSED avalanche-rpc.test');
      },
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 43113,
        err: expect.stringContaining('ECONNREFUSED'),
      }),
      expect.stringContaining('RPC unreachable'),
    );
  });
});
