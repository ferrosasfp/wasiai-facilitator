/**
 * WFAC-53 FIX-2 — Kite domain separator boot check tests.
 *
 * Pattern mirrors src/__tests__/unit/chains/init-breakers.test.ts:
 * chainRegistry._resetForTesting + register fake adapter with mocked
 * getPublicClient().readContract.
 *
 * Refs: AC-4, AC-5, AC-7, CD-14.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { domainSeparator } from 'viem';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { initDomainCheck } from '../../chains/init-domain-check.js';
import type { ChainAdapter } from '../../chains/types.js';

// Compute the canonical Kite Testnet PYUSD domain separator (same shape used
// by the adapter at runtime — see src/chains/kite.ts:124-128).
const KITE_TESTNET_TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const KITE_TESTNET_LOCAL_SEP = domainSeparator({
  domain: {
    name: 'PYUSD',
    version: '1',
    chainId: 2368,
    verifyingContract: KITE_TESTNET_TOKEN_ADDRESS,
  },
});

// WFAC-12 — pieUSD domain separator (token metadata override). Same shape as
// the PYUSD separator above but eip712Name = 'pieUSD' → proves the boot-check
// validates whatever token metadata the env-configurable adapter exposes.
const KITE_TESTNET_PIEUSD_SEP = domainSeparator({
  domain: {
    name: 'pieUSD',
    version: '1',
    chainId: 2368,
    verifyingContract: KITE_TESTNET_TOKEN_ADDRESS,
  },
});

function makeFakeKiteAdapter(opts: {
  readContractImpl: (params: unknown) => Promise<unknown>;
  // `tokenName` drives all three name-ish fields of the fake token below:
  // `symbol`, `name`, and `eip712Name` (kept identical so the computed domain
  // separator matches whatever the test feeds via readContractImpl).
  tokenName?: string;
}): ChainAdapter {
  const tokenName = opts.tokenName ?? 'PYUSD';
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
          symbol: tokenName,
          decimals: 18,
          name: tokenName,
          eip712Name: tokenName,
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

describe('initDomainCheck — Kite (WFAC-53 FIX-2)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DOM-KITE-1 (AC-4, AC-7a): match → boot continues, debug log', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => KITE_TESTNET_LOCAL_SEP,
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
      expect.objectContaining({ chainId: 2368 }),
      expect.stringContaining('domain separator OK'),
    );
  });

  it('WFAC-12 AC-4: pieUSD token metadata → boot continues when separator matches', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => KITE_TESTNET_PIEUSD_SEP,
      tokenName: 'pieUSD',
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('T-DOM-KITE-2 (AC-4, AC-7b): mismatch → fatal log + process.exit(1)', async () => {
    const adapter = makeFakeKiteAdapter({
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
        chainId: 2368,
        expected: KITE_TESTNET_LOCAL_SEP,
      }),
      expect.stringContaining('drift detected'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('T-DOM-KITE-3 (AC-5, AC-7c): RPC throws → warn log, no fatal, no exit', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => {
        throw new Error('ECONNREFUSED kite-rpc.test');
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
        chainId: 2368,
        err: expect.stringContaining('ECONNREFUSED'),
      }),
      expect.stringContaining('RPC unreachable'),
    );
  });
});
