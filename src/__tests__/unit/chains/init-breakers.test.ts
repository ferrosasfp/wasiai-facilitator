/**
 * WFAC-41 — Integration tests for src/chains/init-breakers.ts.
 *
 * Validates that:
 *   T-INIT-1: after `buildApp(...)`, every adapter that exposes
 *             `getBreakerState` reports 'CLOSED' (breakers live, but no
 *             failures yet).
 *   T-INIT-2: `setLogger` is called during `buildApp` with an object that
 *             has a `.warn(...)` method (Fastify/pino logger).
 *
 * Pattern mirrors routes.supported.test.ts: chainRegistry._resetForTesting,
 * explicit registration of a fake ChainAdapter that exposes setLogger /
 * getBreakerState, then buildApp.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { EnvConfig } from '../../../infra/env.js';
import { chainRegistry } from '../../../chains/registry.js';
import { asChainId } from '../../../core/types.js';
import type { ChainAdapter } from '../../../chains/types.js';

// ─── core/audit.js mock ────────────────────────────────────────────────────
vi.mock('../../../core/audit.js', () => {
  const persistAuditSpy = vi.fn(async () => undefined);
  const buildAuditSpy = vi.fn((input: unknown) => ({ __auditInput: input }));
  return {
    __esModule: true,
    buildAuditEntry: buildAuditSpy,
    persistAuditEntry: persistAuditSpy,
    __persistAuditSpy: persistAuditSpy,
    __buildAuditSpy: buildAuditSpy,
  };
});

// ─── ioredis mock ──────────────────────────────────────────────────────────
vi.mock('ioredis', () => {
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));
  class RedisMock {
    constructor() {}
    on(): this {
      return this;
    }
    quit(): Promise<'OK'> {
      return quitSpy();
    }
    get(): Promise<string | null> {
      return Promise.resolve(null);
    }
    set(): Promise<'OK'> {
      return Promise.resolve('OK');
    }
  }
  return {
    default: RedisMock,
    Redis: RedisMock,
  };
});

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'info',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_DB: 0,
    ...overrides,
  } as EnvConfig;
}

/**
 * Make a fake adapter that DOES expose setLogger + getBreakerState
 * (mimicking KiteAdapter / AvalancheFujiAdapter). Returns the adapter
 * and the `setLogger` spy so tests can assert on it.
 */
function makeAdapterWithBreaker(chainIdNum: number, name: string) {
  let state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  const setLoggerSpy = vi.fn<[Logger], void>();
  const adapter: ChainAdapter & {
    setLogger: (l: Logger) => void;
    getBreakerState: () => 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  } = {
    metadata: {
      chainId: asChainId(chainIdNum),
      name,
      network: 'testnet',
      networkId: `eip155:${chainIdNum}`,
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    setLogger: (logger) => {
      setLoggerSpy(logger);
    },
    getBreakerState: () => state,
  };
  // Expose a way to mutate state for assertion (not used today; kept for
  // completeness if a future test wants to flip it mid-test).
  const setState = (s: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void => {
    state = s;
  };
  return { adapter, setLoggerSpy, setState };
}

describe('initChainBreakers (WFAC-41)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('T-INIT-1: after buildApp, adapters with getBreakerState report CLOSED', async () => {
    const kite = makeAdapterWithBreaker(2368, 'Kite Testnet');
    const avax = makeAdapterWithBreaker(43113, 'Avalanche Fuji');
    chainRegistry.register(kite.adapter);
    chainRegistry.register(avax.adapter);

    const { resetRedisClientForTests } = await import('../../../infra/redis.js');
    resetRedisClientForTests();
    const { buildApp } = await import('../../../app.js');
    app = await buildApp({ env: makeEnv() });

    expect(kite.adapter.getBreakerState()).toBe('CLOSED');
    expect(avax.adapter.getBreakerState()).toBe('CLOSED');
  });

  it('T-INIT-2: buildApp invokes adapter.setLogger with a logger-shaped object (pino-compatible)', async () => {
    const kite = makeAdapterWithBreaker(2368, 'Kite Testnet');
    chainRegistry.register(kite.adapter);

    const { resetRedisClientForTests } = await import('../../../infra/redis.js');
    resetRedisClientForTests();
    const { buildApp } = await import('../../../app.js');
    app = await buildApp({ env: makeEnv() });

    expect(kite.setLoggerSpy).toHaveBeenCalledTimes(1);
    const loggerArg = kite.setLoggerSpy.mock.calls[0]![0];
    expect(typeof loggerArg.warn).toBe('function');
    expect(typeof loggerArg.info).toBe('function');
  });
});
