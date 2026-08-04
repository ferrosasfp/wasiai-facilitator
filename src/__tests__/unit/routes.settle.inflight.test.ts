/**
 * WFAC-AUDIT AC-3 — in-flight settle lock (SET NX EX).
 *
 * Harness: routes.settle.test.ts pattern (buildApp + fake adapter + inject).
 * The in-flight lock functions in core/idempotency.js are partially mocked
 * (importActual + override) so each branch ('acquired' / 'held' / 'skipped')
 * is forced deterministically without a live Redis NX.
 *
 * AC coverage:
 *   - AC-3 → T8 (held → 409, settleCore invoked once)
 *   - AC-3 → T9 (skipped/Redis down → proceeds, warn, no PII)
 *   - AC-3 → T10 (JSDoc documents best-effort + on-chain nonce safeguard)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams } from '../../chains/types.js';
import type * as IdempotencyModule from '../../core/idempotency.js';

// ─── core/idempotency.js partial mock — control the in-flight lock branch ──
const lockStateSpy = vi.fn<() => 'acquired' | 'held' | 'skipped'>(() => 'acquired');
const releaseSpy = vi.fn(async () => undefined);

vi.mock('../../core/idempotency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IdempotencyModule>();
  return {
    ...actual,
    setInflightSettleLock: vi.fn(async () => lockStateSpy()),
    releaseInflightSettleLock: releaseSpy,
  };
});

// ─── core/ledger.js mock ────────────────────────────────────────────────────
vi.mock('../../core/ledger.js', () => {
  const persistSpy = vi.fn(async () => undefined);
  const buildSpy = vi.fn((input: unknown) => ({ __input: input }));
  return {
    __esModule: true,
    buildLedgerEntry: buildSpy,
    persistLedgerEntry: persistSpy,
    __persistSpy: persistSpy,
    __buildSpy: buildSpy,
  };
});

// ─── core/audit.js mock ─────────────────────────────────────────────────────
vi.mock('../../core/audit.js', () => {
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

// ─── ioredis mock (Redis "up" so isRedisAvailable() === true) ──────────────
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  class RedisMock {
    constructor() {}
    on(): this {
      return this;
    }
    async quit(): Promise<'OK'> {
      return 'OK';
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async set(): Promise<'OK'> {
      return 'OK';
    }
  }
  return { default: RedisMock, Redis: RedisMock, __store: store };
});

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  getLines(): Array<Record<string, unknown>> {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const VALID_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1000000',
    asset: `0x${'11'.repeat(20)}`,
    payTo: `0x${'22'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
  },
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: `0x${'33'.repeat(20)}`,
      to: `0x${'22'.repeat(20)}`,
      value: '1000000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
} as const;

const VALID_SETTLE_RESULT = {
  ok: true as const,
  settled: true as const,
  transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
  blockNumber: 12345,
  amount: '1000000',
  from: `0x${'33'.repeat(20)}` as `0x${string}`,
  to: `0x${'22'.repeat(20)}` as `0x${string}`,
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
};

function makeFakeAdapter(
  chainIdNum: number,
  settleImpl: (params: SettleParams) => Promise<unknown>,
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
    settle: settleImpl as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: vi.fn(async (): Promise<void> => undefined),
  };
}

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

async function buildAppWithAdapter(
  adapter: ChainAdapter,
  capture?: CaptureStream,
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  chainRegistry.register(adapter);
  const { buildApp } = await import('../../app.js');
  return buildApp({ env: makeEnv(), loggerDestination: capture, skipDomainCheck: true });
}

describe('POST /settle — in-flight lock (WFAC-AUDIT AC-3)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    lockStateSpy.mockReset();
    lockStateSpy.mockReturnValue('acquired');
    releaseSpy.mockClear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('T8: concurrent identical request → 2nd lock "held" → 409, settle invoked once', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

    // 1st request acquires the lock and dispatches settle; 2nd finds it held.
    lockStateSpy.mockReturnValueOnce('acquired').mockReturnValueOnce('held');

    const r1 = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(409);
    const b2 = JSON.parse(r2.body) as { error: { code: string; http: number } };
    expect(b2.error.code).toBe('CONFLICT');
    expect(b2.error.http).toBe(409);
    // settleCore (→ adapter.settle) ran exactly once — the held request never dispatched.
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it('T9: Redis down → lock "skipped" → request proceeds (not 409), warn emitted, no PII', async () => {
    const capture = new CaptureStream();
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter, capture);

    lockStateSpy.mockReturnValue('skipped');

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    expect(res.statusCode).not.toBe(409);
    expect(res.statusCode).toBe(200);
    expect(settleSpy).toHaveBeenCalledTimes(1);

    const warn = capture
      .getLines()
      .find((l) => l.msg === 'in-flight lock skipped — Redis unavailable');
    expect(warn).toBeDefined();
    // CD-3 — no PII (signature/nonce) in the warn line.
    const asJson = JSON.stringify(warn);
    expect(asJson).not.toContain(VALID_BODY.payload.signature);
    expect(asJson).not.toContain(VALID_BODY.payload.authorization.nonce);

    // R-4 — acquired path skipped → release NOT called (nothing to release).
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('T10: setInflightSettleLock JSDoc documents best-effort + on-chain nonce safeguard', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../core/idempotency.ts'), 'utf8');
    const docStart = src.indexOf('Acquire an in-flight lock for a settle request');
    expect(docStart).toBeGreaterThan(-1);
    const doc = src.slice(docStart, docStart + 900);
    expect(doc).toContain('BEST-EFFORT');
    expect(doc.toLowerCase()).toContain('on-chain nonce');
    expect(doc).toContain('fail-open');
  });
});
