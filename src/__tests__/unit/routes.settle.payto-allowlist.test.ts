/**
 * P3 — TB-04: per-caller /settle payTo allowlist.
 *
 * Proves the OPTIONAL `FACILITATOR_PAYTO_ALLOWLIST` gate:
 *   - unset/empty  → every receiver allowed (backward-compatible).
 *   - non-empty    → a /settle whose body `payTo` is NOT in the list is
 *                    rejected 403 FORBIDDEN BEFORE the adapter is invoked;
 *                    a listed `payTo` passes through to settlement.
 *
 * Harness mirrors routes.settle.auth.test.ts (makeEnv + buildAppWithAdapter).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams } from '../../chains/types.js';

vi.mock('../../core/ledger.js', () => ({
  __esModule: true,
  buildLedgerEntry: vi.fn((input: unknown) => ({ __input: input })),
  persistLedgerEntry: vi.fn(async () => undefined),
}));

vi.mock('../../core/audit.js', () => ({
  __esModule: true,
  buildAuditEntry: vi.fn((input: unknown) => ({ __auditInput: input })),
  persistAuditEntry: vi.fn(async () => undefined),
}));

vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  class RedisMock {
    private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(
      public url: string,
      public options: Record<string, unknown>,
    ) {}
    on(event: string, handler: (...a: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(handler);
      this.listeners.set(event, arr);
      return this;
    }
    quit(): Promise<'OK'> {
      return Promise.resolve('OK');
    }
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    }
    set(key: string, value: string): Promise<'OK'> {
      store.set(key, value);
      return Promise.resolve('OK');
    }
    del(): Promise<number> {
      return Promise.resolve(1);
    }
    incr(): Promise<number> {
      return Promise.resolve(1);
    }
    expire(): Promise<number> {
      return Promise.resolve(1);
    }
  }
  return { default: RedisMock, Redis: RedisMock, __store: store };
});

const PAYTO_ALLOWED = `0x${'22'.repeat(20)}`;
const PAYTO_FORBIDDEN = `0x${'99'.repeat(20)}`;

function bodyWithPayTo(payTo: string): unknown {
  return {
    x402Version: 2,
    resource: { url: 'https://example.com/api/resource' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: '1000000',
      asset: `0x${'11'.repeat(20)}`,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
    },
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: `0x${'33'.repeat(20)}`,
        to: payTo,
        value: '1000000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'cd'.repeat(32)}`,
      },
    },
  };
}

const VALID_SETTLE_RESULT = {
  ok: true as const,
  settled: true as const,
  transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
  blockNumber: 12345,
  amount: '1000000',
  from: `0x${'33'.repeat(20)}` as `0x${string}`,
  to: PAYTO_ALLOWED as `0x${string}`,
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
};

function makeFakeAdapter(
  chainIdNum: number,
  settle: (params: SettleParams) => Promise<unknown>,
): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(chainIdNum),
      name: `fake-${chainIdNum}`,
      network: 'testnet',
      networkId: `eip155:${chainIdNum}`,
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: settle as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: vi.fn(async (): Promise<void> => undefined),
  };
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'silent',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_DB: 0,
    FACILITATOR_API_KEY: 'k',
    SETTLE_DAILY_GLOBAL_CAP: 0, // disable the cap so it never interferes
    ...overrides,
  } as EnvConfig;
}

async function buildAppWithAdapter(
  adapter: ChainAdapter,
  env: EnvConfig,
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  chainRegistry.register(adapter);
  const { buildApp } = await import('../../app.js');
  return buildApp({ env, skipDomainCheck: true });
}

const AUTH = { authorization: 'Bearer k', 'content-type': 'application/json' };

describe('P3 TB-04 — /settle payTo allowlist', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('AL-1: allowlist UNSET → any payTo settles (backward-compatible)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(makeFakeAdapter(2368, settleSpy), makeEnv());
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: AUTH,
      payload: JSON.stringify(bodyWithPayTo(PAYTO_FORBIDDEN)),
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('AL-2: allowlist SET + payTo NOT listed → 403 FORBIDDEN, adapter NOT called', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(
      makeFakeAdapter(2368, settleSpy),
      makeEnv({ FACILITATOR_PAYTO_ALLOWLIST: PAYTO_ALLOWED }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: AUTH,
      payload: JSON.stringify(bodyWithPayTo(PAYTO_FORBIDDEN)),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.http).toBe(403);
    // The on-chain settle must NEVER run for a forbidden receiver.
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('AL-3: allowlist SET + payTo listed → settles normally (200)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(
      makeFakeAdapter(2368, settleSpy),
      makeEnv({ FACILITATOR_PAYTO_ALLOWLIST: PAYTO_ALLOWED }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: AUTH,
      payload: JSON.stringify(bodyWithPayTo(PAYTO_ALLOWED)),
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('AL-4: allowlist match is case-insensitive (checksum vs lowercase)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    // Configure the allowlist in UPPERCASE; request sends lowercase.
    app = await buildAppWithAdapter(
      makeFakeAdapter(2368, settleSpy),
      makeEnv({ FACILITATOR_PAYTO_ALLOWLIST: PAYTO_ALLOWED.toUpperCase().replace('0X', '0x') }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: AUTH,
      payload: JSON.stringify(bodyWithPayTo(PAYTO_ALLOWED)),
    });
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });
});
