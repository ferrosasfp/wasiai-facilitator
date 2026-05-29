/**
 * Integration tests for POST /settle via app.inject() (WFAC-21 W3).
 *
 * Pattern: CaptureStream + vi.mock('ioredis') + makeFakeAdapter
 * (copied from routes.verify.test.ts, swapping verify → settle).
 *
 * CD-6  observed: every test uses app.inject() — no live ports.
 * CD-15, CD-16 observed: we NEVER import `src/chains/kite.ts` or
 * `src/chains/avalanche.ts` — fake adapters are registered explicitly.
 * CD-13 nuevo: fake adapter returns a deterministic SettleResult; no live
 *   viem client calls are made from tests.
 *
 * AC coverage:
 *   - AC-1  → T-R1
 *   - AC-2  → T-R2
 *   - AC-3  → T-R3
 *   - AC-4  → T-R4
 *   - AC-5  → T-R5
 *   - AC-6  → T-R6 (+ CD-12 heredado, not cached)
 *   - AC-7  → T-R7 (+ CD-12 heredado, not cached)
 *   - AC-8  → T-R8
 *   - AC-9  → T-R9
 *   - AC-10 → T-R10
 *   - AC-11 → T-R11
 *   - AC-12 → T-R12, T-R16 (CD-12 nuevo)
 *   - AC-13 → T-R13
 *   - AC-14 → T-R14
 *   - CD-11 nuevo → T-R15
 *   - CD-15 nuevo → T-R17
 *   - CD-6  → T-R18
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams } from '../../chains/types.js';

// ─── core/ledger.js mock (WFAC-32 W3) ──────────────────────────────────────
// Keep `buildLedgerEntry` as a simple passthrough-shaped structural mock.
// `persistLedgerEntry` becomes a spy whose default resolves `undefined`
// (mirrors the no-op production behaviour when SUPABASE_URL is absent).
// Individual tests may reach into `__persistSpy` / `__buildSpy` to assert.
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

// ─── core/audit.js mock (WFAC-33 W4) ───────────────────────────────────────
// The onResponse hook in `src/app.ts` invokes both helpers. We spy on the
// input shape (`__buildAuditSpy.mock.calls[0][0]`) to assert propagation of
// IP/UA/auditMeta, while `__persistAuditSpy` defaults to a silent resolve so
// tests never hit a real Supabase.
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

// ─── ioredis mock (copied verbatim from routes.verify.test.ts) ─────────────
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));
  const store = new Map<string, string>();
  const setSpy = vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
    store.set(key, value);
    return 'OK' as const;
  });
  const getSpy = vi.fn(async (key: string) => store.get(key) ?? null);

  class RedisMock {
    options: Record<string, unknown>;
    url: string;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, opts: Record<string, unknown>) {
      constructorSpy(url, opts);
      this.url = url;
      this.options = opts;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(handler);
      this.listeners.set(event, arr);
      return this;
    }

    quit(): Promise<'OK'> {
      return quitSpy();
    }

    get(key: string): Promise<string | null> {
      return getSpy(key);
    }

    set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
      return setSpy(key, value, mode, ttl);
    }
  }

  return {
    default: RedisMock,
    Redis: RedisMock,
    __constructorSpy: constructorSpy,
    __quitSpy: quitSpy,
    __setSpy: setSpy,
    __getSpy: getSpy,
    __store: store,
  };
});

// ─── CaptureStream (verbatim from routes.verify.test.ts) ───────────────────
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

// ─── fixtures ──────────────────────────────────────────────────────────────

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

/** CD-13 nuevo: deterministic settle result (no viem, no live calls). */
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
  };
}

async function buildAppWithAdapter(
  adapter: ChainAdapter,
  opts: {
    capture?: CaptureStream;
    env?: EnvConfig;
  } = {},
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  chainRegistry.register(adapter);

  const { buildApp } = await import('../../app.js');
  const env = opts.env ?? makeEnv();
  return buildApp({
    env,
    loggerDestination: opts.capture,
    skipDomainCheck: true, // WFAC-53 CD-16 — fake adapter, no real readContract mock
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('POST /settle', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy.mockClear();
    (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy.mockClear();
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();

    const ledger = (await import('../../core/ledger.js')) as unknown as {
      __persistSpy: ReturnType<typeof vi.fn>;
      __buildSpy: ReturnType<typeof vi.fn>;
    };
    ledger.__persistSpy.mockClear();
    ledger.__buildSpy.mockClear();

    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockClear();
    audit.__buildAuditSpy.mockClear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  // ─── AC-1 ──────────────────────────────────────────────────────────────

  it('T-R1 / AC-1: returns 200 with exact 7-field SettleResult body', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'amount',
      'asset',
      'blockNumber',
      'from',
      'settled',
      'to',
      'transactionHash',
    ]);
    expect(body.settled).toBe(true);
    expect(body.transactionHash).toBe(VALID_SETTLE_RESULT.transactionHash);
    expect(body.blockNumber).toBe(12345);
    expect(body.from).toBe(VALID_SETTLE_RESULT.from);
    expect(body.to).toBe(VALID_SETTLE_RESULT.to);
    expect(body.asset).toBe(VALID_SETTLE_RESULT.asset);
    expect(body.amount).toBe('1000000');
  });

  // ─── AC-2 ──────────────────────────────────────────────────────────────

  it('T-R2 / AC-2: returns 400 INVALID_PAYLOAD on malformed body, adapter NOT invoked', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

    // Case A: missing x402Version
    const { x402Version: _v, ...missingVersion } = VALID_BODY;
    void _v;
    const rA = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(missingVersion),
    });
    expect(rA.statusCode).toBe(400);
    const bA = JSON.parse(rA.body) as { error: { code: string; http: number } };
    expect(bA.error.code).toBe('INVALID_PAYLOAD');
    expect(bA.error.http).toBe(400);

    // Case B: x402Version === 1
    const rB = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...VALID_BODY, x402Version: 1 }),
    });
    expect(rB.statusCode).toBe(400);
    const bB = JSON.parse(rB.body) as { error: { code: string } };
    expect(bB.error.code).toBe('INVALID_PAYLOAD');

    // Case C: missing resource
    const { resource: _r, ...missingResource } = VALID_BODY;
    void _r;
    const rC = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(missingResource),
    });
    expect(rC.statusCode).toBe(400);
    const bC = JSON.parse(rC.body) as { error: { code: string } };
    expect(bC.error.code).toBe('INVALID_PAYLOAD');

    expect(settleSpy).not.toHaveBeenCalled();
  });

  // ─── AC-3 ──────────────────────────────────────────────────────────────

  it('T-R3 / AC-3: returns 400 NETWORK_MISMATCH for bad network formats and unregistered chain', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

    // Sub-case A: solana:1
    const rA = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
      }),
    });
    expect(rA.statusCode).toBe(400);
    expect((JSON.parse(rA.body) as { error: { code: string } }).error.code).toBe(
      'NETWORK_MISMATCH',
    );

    // Sub-case B: eip155:0
    const rB = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'eip155:0' },
      }),
    });
    expect(rB.statusCode).toBe(400);
    expect((JSON.parse(rB.body) as { error: { code: string } }).error.code).toBe(
      'NETWORK_MISMATCH',
    );

    // Sub-case C: eip155:999999 (unregistered)
    const rC = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'eip155:999999' },
      }),
    });
    expect(rC.statusCode).toBe(400);
    expect((JSON.parse(rC.body) as { error: { code: string } }).error.code).toBe(
      'NETWORK_MISMATCH',
    );

    expect(settleSpy).not.toHaveBeenCalled();
  });

  // ─── AC-4 ──────────────────────────────────────────────────────────────

  it('T-R4 / AC-4: 401 INVALID_SIGNATURE passthrough from adapter', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    }));
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    });
  });

  // ─── AC-5 ──────────────────────────────────────────────────────────────

  it('T-R5 / AC-5: 402 INSUFFICIENT_BALANCE passthrough from adapter', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds', http: 402 },
    }));
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(body.error.http).toBe(402);
  });

  // ─── AC-6 ──────────────────────────────────────────────────────────────

  it('T-R6 / AC-6: 500 SIMULATION_FAILED is NOT cached (adapter called twice)', async () => {
    const settleSpy = vi.fn(async () => ({
      ok: false,
      error: { code: 'SIMULATION_FAILED', message: 'rpc down', http: 500 },
    }));
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

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
    expect(r1.statusCode).toBe(500);
    expect(r2.statusCode).toBe(500);
    expect(settleSpy).toHaveBeenCalledTimes(2);
  });

  // ─── AC-7 ──────────────────────────────────────────────────────────────

  it('T-R7 / AC-7: 500 TRANSACTION_FAILED is NOT cached (adapter called twice)', async () => {
    const settleSpy = vi.fn(async () => ({
      ok: false,
      error: { code: 'TRANSACTION_FAILED', message: 'reverted', http: 500 },
    }));
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

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
    expect(r1.statusCode).toBe(500);
    expect(r2.statusCode).toBe(500);
    const body = JSON.parse(r1.body) as { error: { code: string } };
    expect(body.error.code).toBe('TRANSACTION_FAILED');
    expect(settleSpy).toHaveBeenCalledTimes(2);
  });

  // ─── AC-8 ──────────────────────────────────────────────────────────────

  it('T-R8 / AC-8: idempotency hit on success — adapter called once, bodies identical', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

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
    expect(r2.statusCode).toBe(200);
    expect(r1.body).toBe(r2.body);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  // ─── AC-9 ──────────────────────────────────────────────────────────────

  it('T-R9 / AC-9: idempotency hit on 4xx — cached error replays verbatim', async () => {
    const settleSpy = vi.fn(async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    }));
    const adapter = makeFakeAdapter(2368, settleSpy);
    app = await buildAppWithAdapter(adapter);

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
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.body).toBe(r2.body);
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  // ─── AC-10 ─────────────────────────────────────────────────────────────

  it('T-R10 / AC-10: Redis unavailable → warn log + proceeds', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter, {
      capture,
      env: makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const lines = capture.getLines();
    const warnLine = lines.find((l) => l.msg === 'idempotency cache miss — Redis unavailable');
    expect(warnLine).toBeDefined();
    expect(typeof warnLine?.request_id).toBe('string');
  });

  // ─── AC-11 ─────────────────────────────────────────────────────────────

  it('T-R11 / AC-11: adapter throws → 500 TRANSACTION_FAILED with L4 error log', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('boom');
    });
    app = await buildAppWithAdapter(adapter, { capture });

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'TRANSACTION_FAILED',
        message: 'Internal adapter error',
        http: 500,
      },
    });

    const lines = capture.getLines();
    const errorLine = lines.find((l) => l.msg === 'settle adapter threw');
    expect(errorLine).toBeDefined();
    expect(errorLine?.error_code).toBe('TRANSACTION_FAILED');
    expect(errorLine?.http_status).toBe(500);
    expect(errorLine?.err_type).toBe('Error');
    expect(typeof errorLine?.duration_ms).toBe('number');
  });

  // ─── AC-12 ─────────────────────────────────────────────────────────────

  it('T-R12 / AC-12: success log has tx_hash and NO PII', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter, { capture });

    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    const lines = capture.getLines();
    const okLine = lines.find((l) => l.msg === 'settle ok');
    expect(okLine).toBeDefined();
    expect(typeof okLine?.request_id).toBe('string');
    expect(okLine?.network).toBe('eip155:2368');
    expect(okLine?.method).toBe('eip3009');
    expect(typeof okLine?.duration_ms).toBe('number');
    expect(okLine?.tx_hash).toBe(VALID_SETTLE_RESULT.transactionHash);

    // CD-3: no PII bytes from the request body in the log line.
    const asJson = JSON.stringify(okLine);
    expect(asJson).not.toContain(VALID_BODY.payload.signature);
    expect(asJson).not.toContain(VALID_BODY.payload.authorization.nonce);
    expect(asJson).not.toContain(VALID_BODY.payload.authorization.from);
    expect(asJson).not.toContain(VALID_BODY.payload.authorization.to);
  });

  // ─── AC-13 ─────────────────────────────────────────────────────────────

  it('T-R13 / AC-13: error logs carry error_code + http_status + duration_ms, no PII', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    }));
    app = await buildAppWithAdapter(adapter, { capture });

    // 1. INVALID_PAYLOAD
    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ x402Version: 1 }),
    });
    // 2. NETWORK_MISMATCH
    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
      }),
    });
    // 3. INVALID_SIGNATURE (adapter error path)
    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    const lines = capture.getLines();
    const failLines = lines.filter((l) => l.msg === 'settle failed');
    expect(failLines.length).toBeGreaterThanOrEqual(3);
    for (const l of failLines) {
      expect(l.level).toBe(40); // warn
      expect(typeof l.request_id).toBe('string');
      expect(typeof l.error_code).toBe('string');
      expect(typeof l.http_status).toBe('number');
      expect(typeof l.duration_ms).toBe('number');
      const asJson = JSON.stringify(l);
      expect(asJson).not.toContain(VALID_BODY.payload.signature);
      expect(asJson).not.toContain(VALID_BODY.payload.authorization.nonce);
      expect(asJson).not.toContain(VALID_BODY.payload.authorization.from);
      expect(asJson).not.toContain(VALID_BODY.payload.authorization.to);
    }
  });

  // ─── AC-14 ─────────────────────────────────────────────────────────────

  it('T-R14 / AC-14: non-JSON Content-Type → 415 or 400 (Fastify default)', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect([400, 415]).toContain(res.statusCode);
  });

  // ─── CD-11 nuevo ───────────────────────────────────────────────────────

  it('T-R15 / CD-11 nuevo: cached 200 replay body is byte-exact identical to fresh response', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);

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
    expect(r1.payload).toBe(r2.payload);

    // r2 must not contain extra keys beyond the 7 spec-literal fields.
    const body2 = JSON.parse(r2.body) as Record<string, unknown>;
    expect(Object.keys(body2).sort()).toEqual([
      'amount',
      'asset',
      'blockNumber',
      'from',
      'settled',
      'to',
      'transactionHash',
    ]);
  });

  // ─── CD-12 nuevo ───────────────────────────────────────────────────────

  it('T-R16 / CD-12 nuevo: cached-hit success log ALSO contains tx_hash', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter, { capture });

    // First call primes the cache.
    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    // Second call hits the cache.
    await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    const lines = capture.getLines();
    const cachedOk = lines.find((l) => l.msg === 'settle ok' && l.cached === true);
    expect(cachedOk).toBeDefined();
    expect(cachedOk?.tx_hash).toBe(VALID_SETTLE_RESULT.transactionHash);
    expect(cachedOk?.request_id).toBeTypeOf('string');
    expect(cachedOk?.network).toBe('eip155:2368');
    expect(cachedOk?.method).toBe('eip3009');
  });

  // ─── CD-15 nuevo ───────────────────────────────────────────────────────

  it('T-R17 / CD-15 nuevo: buildApp registers BOTH verifyRoute and settleRoute', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);

    // /settle responds 200 with the happy-path body.
    const rSettle = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(rSettle.statusCode).toBe(200);

    // /verify also exists — a malformed payload should get 400, not 404.
    const rVerify = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(rVerify.statusCode).not.toBe(404);
    expect([400, 401, 500]).toContain(rVerify.statusCode);
  });

  // ─── CD-6 heredado ─────────────────────────────────────────────────────

  it('T-R18 / CD-6 heredado: prefixes keep verify and settle idempotency keys separated', async () => {
    const { buildIdempotencyKey, buildSettleIdempotencyKey } =
      await import('../../core/idempotency.js');
    const verifyKey = buildIdempotencyKey(VALID_BODY);
    const settleKey = buildSettleIdempotencyKey(VALID_BODY);
    expect(verifyKey).not.toBe(settleKey);
    expect(verifyKey.startsWith('verify:idempotency:')).toBe(true);
    expect(settleKey.startsWith('settle:idempotency:')).toBe(true);
  });

  // ─── WFAC-32 — ledger hooks (T20-T22, T24) ─────────────────────────────

  it('T20 / AC-1: success path invokes persistLedgerEntry exactly once with success entry', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const ledger = (await import('../../core/ledger.js')) as unknown as {
      __persistSpy: ReturnType<typeof vi.fn>;
      __buildSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(ledger.__persistSpy).toHaveBeenCalledTimes(1);
    expect(ledger.__buildSpy).toHaveBeenCalledTimes(1);

    const buildInput = ledger.__buildSpy.mock.calls[0]?.[0] as {
      method: string;
      network: string;
      result: { ok: boolean };
    };
    expect(buildInput.method).toBe('eip3009');
    expect(buildInput.network).toBe('eip155:2368');
    expect(buildInput.result.ok).toBe(true);
  });

  it('T21 / AC-2: adapter x402 failure invokes persistLedgerEntry once with failed entry', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds', http: 402 },
    }));
    app = await buildAppWithAdapter(adapter);
    const ledger = (await import('../../core/ledger.js')) as unknown as {
      __persistSpy: ReturnType<typeof vi.fn>;
      __buildSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(402);
    expect(ledger.__persistSpy).toHaveBeenCalledTimes(1);

    const buildInput = ledger.__buildSpy.mock.calls[0]?.[0] as {
      result: { ok: boolean; error?: { code: string; http: number } };
    };
    expect(buildInput.result.ok).toBe(false);
    expect(buildInput.result.error?.code).toBe('INSUFFICIENT_BALANCE');
    expect(buildInput.result.error?.http).toBe(402);
  });

  it('T22 / AC-2-extended: adapter throw invokes persistLedgerEntry once with TRANSACTION_FAILED 500', async () => {
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('rpc down');
    });
    app = await buildAppWithAdapter(adapter);
    const ledger = (await import('../../core/ledger.js')) as unknown as {
      __persistSpy: ReturnType<typeof vi.fn>;
      __buildSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);
    expect(ledger.__persistSpy).toHaveBeenCalledTimes(1);

    const buildInput = ledger.__buildSpy.mock.calls[0]?.[0] as {
      result: { ok: boolean; error?: { code: string; http: number } };
    };
    expect(buildInput.result.ok).toBe(false);
    expect(buildInput.result.error?.code).toBe('TRANSACTION_FAILED');
    expect(buildInput.result.error?.http).toBe(500);
  });

  it('T24: cache-hit does NOT invoke persistLedgerEntry (only first request persists)', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const ledger = (await import('../../core/ledger.js')) as unknown as {
      __persistSpy: ReturnType<typeof vi.fn>;
      __buildSpy: ReturnType<typeof vi.fn>;
    };

    const r1 = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(r1.statusCode).toBe(200);
    expect(ledger.__persistSpy).toHaveBeenCalledTimes(1);

    // Second identical request hits the Redis idempotency cache.
    const r2 = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(r2.statusCode).toBe(200);
    // Still only ONE persistLedgerEntry call — cache-hit must NOT duplicate.
    expect(ledger.__persistSpy).toHaveBeenCalledTimes(1);
  });

  // ─── WFAC-33 W4 — audit hook integration ───────────────────────────────

  it('T-AR-1 / AC-1: success path invokes persistAuditEntry once with resolved IP + UA + idempotencyKey', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    // WFAC-AUDIT AC-2 (R-1, intentional): the audit row now records the
    // resolved request.ip (the peer), NOT the spoofable raw X-Forwarded-For.
    // With TRUST_PROXY unset → false, the raw XFF is ignored; ipRaw = peer.
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.5, 10.0.0.1',
        'user-agent': 'curl/7.88',
      },
      remoteAddress: '4.4.4.4',
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(audit.__persistAuditSpy).toHaveBeenCalledTimes(1);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      path: string;
      statusCode: number;
      ipRaw: string | null;
      userAgentRaw: string | null;
      idempotencyKey?: string;
      errorCode?: string;
    };
    expect(input.path).toBe('/settle');
    expect(input.statusCode).toBe(200);
    // Resolved peer, not the forged XFF first element.
    expect(input.ipRaw).toBe('4.4.4.4');
    expect(input.userAgentRaw).toBe('curl/7.88');
    // Auto-Blindaje W4: buildSettleIdempotencyKey returns the full Redis key
    // `settle:idempotency:<64-hex>` (length 83). Production stores the prefixed
    // form in facilitator_audit_log.idempotency_key.
    expect(input.idempotencyKey).toMatch(/^settle:idempotency:[0-9a-f]{64}$/);
    expect(input.errorCode).toBeUndefined();
  });

  it('T-AR-2 / AC-12: success path propagates 64-char hex idempotencyKey', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as { idempotencyKey?: string };
    // Auto-Blindaje W4: full Redis key `settle:idempotency:<hash>` (83 chars).
    expect(input.idempotencyKey).toMatch(/^settle:idempotency:[0-9a-f]{64}$/);
  });

  it('T-AR-3 / AC-13: 400 Zod path populates errorCode=INVALID_PAYLOAD', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ invalid: 'body' }),
    });
    expect(res.statusCode).toBe(400);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      statusCode: number;
      errorCode?: string;
    };
    expect(input.statusCode).toBe(400);
    expect(input.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('T-AR-4 / AC-13: adapter-throw path populates errorCode=TRANSACTION_FAILED + idempotencyKey present', async () => {
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('adapter exploded');
    });
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      statusCode: number;
      errorCode?: string;
      idempotencyKey?: string;
    };
    expect(input.statusCode).toBe(500);
    expect(input.errorCode).toBe('TRANSACTION_FAILED');
    // Auto-Blindaje W4: full prefixed Redis key.
    expect(input.idempotencyKey).toMatch(/^settle:idempotency:[0-9a-f]{64}$/);
  });

  it('T-AR-5 / AC-13: adapter result.ok=false propagates error code verbatim', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds', http: 402 },
    }));
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(402);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      statusCode: number;
      errorCode?: string;
    };
    expect(input.statusCode).toBe(402);
    expect(input.errorCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('T-AR-6 / AC-4: forged array XFF is ignored — resolved request.ip recorded', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    // WFAC-AUDIT AC-2 (R-1, intentional): array XFF can no longer override the
    // resolved peer in the audit row. ipRaw = peer, not '203.0.113.6'.
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ['203.0.113.6, 10.0.0.2'],
      },
      remoteAddress: '6.6.6.6',
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as { ipRaw: string | null };
    expect(input.ipRaw).toBe('6.6.6.6');
  });

  it('T-AR-7 / AC-5: no XFF → falls back to request.ip', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as { ipRaw: string | null };
    expect(input.ipRaw).not.toBeNull();
    // request.ip under light-my-request is typically 127.0.0.1.
    expect(typeof input.ipRaw).toBe('string');
  });

  it('T-AR-8 / AC-8: empty user-agent header → userAgentRaw=null', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    // Auto-Blindaje W4: light-my-request injects default 'lightMyRequest' UA when
    // headers.user-agent is absent. Override with '' to exercise the empty→null
    // branch. True header-absence is covered by the pure builder unit tests.
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', 'user-agent': '' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as { userAgentRaw: string | null };
    expect(input.userAgentRaw).toBeNull();
  });

  it('T-AR-9 / AC-9: persistAuditEntry rejection is swallowed by Fastify — response still 200', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockRejectedValueOnce(new Error('boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    // onResponse hook runs AFTER the reply is already flushed. A thrown
    // audit error cannot flip the status back to 5xx — the client sees 200.
    expect(res.statusCode).toBe(200);
  });

  // ─── WFAC-41 — circuit breaker Retry-After header (T-RT-SETTLE-CB-*) ────

  it('T-RT-SETTLE-CB-1 (AC-2, AC-11): CHAIN_UNAVAILABLE returns 503 + Retry-After header', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: {
        code: 'CHAIN_UNAVAILABLE' as const,
        message: 'Chain RPC temporarily unavailable',
        http: 503,
        retryAfterMs: 7500,
      },
    }));
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(503);
    // ceil(7500/1000) = 8 seconds
    expect(res.headers['retry-after']).toBe('8');
    const body = JSON.parse(res.body) as { error: Record<string, unknown> };
    expect(body.error.code).toBe('CHAIN_UNAVAILABLE');
    expect(body.error.http).toBe(503);
  });

  it('T-RT-SETTLE-CB-2 (CD-NEW-CB-RETRY-AFTER-INTERNAL): 503 body has exactly {code, message, http} — retryAfterMs NOT serialized', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: {
        code: 'CHAIN_UNAVAILABLE' as const,
        message: 'Chain RPC temporarily unavailable',
        http: 503,
        retryAfterMs: 2000,
      },
    }));
    app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const body = JSON.parse(res.body) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(['code', 'http', 'message']);
    expect((body.error as { retryAfterMs?: unknown }).retryAfterMs).toBeUndefined();
  });
});
