/**
 * Integration tests for POST /verify via app.inject() (WFAC-20 W4).
 *
 * Pattern: CaptureStream from src/__tests__/unit/health.test.ts (E11) +
 * vi.mock('ioredis') from src/__tests__/unit/redis.test.ts (E12).
 *
 * CD-6  observed: every test uses app.inject() — no live ports.
 * CD-15, CD-16 observed: we NEVER import `src/chains/kite.ts` or
 * `src/chains/avalanche.ts` — fake adapters are registered explicitly.
 *
 * AC coverage:
 *   - AC-1  → T-R1
 *   - AC-2  → T-R2
 *   - AC-3  → T-R3, T-R4, T-R5
 *   - AC-4  → T-R6, T-R7
 *   - AC-5  → T-R8
 *   - AC-6  → T-R9
 *   - AC-7  → T-R10
 *   - AC-8  → T-R11
 *   - AC-9  → T-R12
 *   - AC-10 → T-R13
 *   - AC-11 → T-R14
 *   - AC-12 → T-R15
 *   - AC-13 → T-R16
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, VerifyParams } from '../../chains/types.js';
import { drainAndCloseApps, trackApp, trackPending } from '../helpers/app-lifecycle.js';

// ─── core/audit.js mock (WFAC-33 W4) ───────────────────────────────────────
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

// ─── ioredis mock (mirrors E12 + adds get/set backed by Map) ───────────────
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<() => Promise<'OK'>>(() => Promise.resolve('OK'));
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

// ─── CaptureStream (verbatim from E11) ─────────────────────────────────────
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

const VALID_ADAPTER_RESULT = {
  ok: true as const,
  verified: true as const,
  client: `0x${'33'.repeat(20)}` as `0x${string}`,
  amount: '1000000',
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
  network: 'eip155:2368',
  payTo: `0x${'22'.repeat(20)}` as `0x${string}`,
  expiresAt: 99999999999,
};

function makeFakeAdapter(
  chainIdNum: number,
  verifyImpl: (params: VerifyParams) => Promise<unknown>,
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
    verify: verifyImpl as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
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
    // Deliberately partial (repo idiom, cf. routes.settle.failopen.test.ts): this
    // fixture sets only the fields the unit under test reads. The cast is what lets
    // it stand in for EnvConfig — every field NOT listed above reaches the code as
    // `undefined` even though EnvConfig declares it required.
  } as EnvConfig;
}

/**
 * Sync wrapper so the boot promise itself is tracked. A test that times out
 * mid-boot leaves this promise running; `afterEach` has to wait for it or the
 * leftover work steals the next test's clock (see helpers/app-lifecycle.ts).
 */
function buildAppWithAdapter(
  adapter: ChainAdapter,
  opts: {
    capture?: CaptureStream;
    env?: EnvConfig;
  } = {},
): Promise<FastifyInstance> {
  return trackPending(buildAppWithAdapterInner(adapter, opts));
}

async function buildAppWithAdapterInner(
  adapter: ChainAdapter,
  opts: {
    capture?: CaptureStream;
    env?: EnvConfig;
  },
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  chainRegistry.register(adapter);

  const { buildApp } = await import('../../app.js');
  const env = opts.env ?? makeEnv();
  // trackApp registers the instance the moment it boots — NOT when the test
  // assigns it to a local, which never happens if the test already timed out.
  return trackApp(
    await buildApp({
      env,
      loggerDestination: opts.capture,
      skipDomainCheck: true, // WFAC-53 CD-16 — fake adapter, no real readContract mock
    }),
  );
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('POST /verify', () => {
  // NOTE: there is deliberately NO describe-scoped `app` variable any more.
  // It used to be shared mutable state BETWEEN tests: a timed-out test keeps
  // running its body, and when its continuation reached `app.inject(...)` it
  // read whatever the CURRENT test had just assigned — injecting a ghost
  // request into the live app and inflating its audit/ledger spies. Each test
  // now holds its own `const app`; cleanup is centralised in
  // `drainAndCloseApps()`, which tracks instances itself.

  // Warm-up, not a test. `buildAppWithAdapter` imports `src/app.ts` lazily; on
  // an idle box that import is 626 ms cold / 0.1 ms warm, and the first boot +
  // request adds the rest — T-R1 measured 1069 ms against 4-8 ms for T-R2..T-R9.
  // Paying it here moves it off T-R1's `testTimeout` budget and onto the
  // separate `hookTimeout` one. It does NOT make the suite faster; it stops one
  // fixed cost from being charged to a single test.
  beforeAll(async () => {
    const warm = await buildAppWithAdapter(makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT));
    await warm.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    await drainAndCloseApps();
  });

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy.mockClear();
    (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy.mockClear();
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();

    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockClear();
    audit.__buildAuditSpy.mockClear();
  });

  afterEach(async () => {
    // Barrier, not just cleanup: a timed-out test leaves its `inject()` running,
    // and that stale request resolves its adapter from the shared
    // `chainRegistry` at REQUEST time — after the next test already registered
    // its own. Without this drain the next test fails with
    // `expected "vi.fn()" to not be called at all`, blaming the wrong test for
    // a clock problem. See helpers/app-lifecycle.ts.
    await drainAndCloseApps();
    vi.restoreAllMocks();
  });

  // ─── AC-1 ──────────────────────────────────────────────────────────────

  it('T-R1 / AC-1: returns 200 with exact 7-field spec body', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'amount',
      'asset',
      'client',
      'expiresAt',
      'network',
      'payTo',
      'verified',
    ]);
    expect(body.verified).toBe(true);
    expect(body.client).toBe(VALID_ADAPTER_RESULT.client);
    expect(body.network).toBe('eip155:2368');
  });

  // ─── AC-2 ──────────────────────────────────────────────────────────────

  it('T-R2 / AC-2: emits info log "verify ok" with required fields and no PII', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter, { capture });

    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    const lines = capture.getLines();
    const okLine = lines.find((l) => l.msg === 'verify ok');
    expect(okLine).toBeDefined();
    expect(typeof okLine?.request_id).toBe('string');
    expect(okLine?.network).toBe('eip155:2368');
    expect(okLine?.method).toBe('eip3009');
    expect(typeof okLine?.duration_ms).toBe('number');

    // CD-3: no PII
    const asJson = JSON.stringify(okLine);
    expect(asJson).not.toContain(VALID_BODY.payload.signature);
    expect(asJson).not.toContain(VALID_BODY.payload.authorization.nonce);
  });

  // ─── AC-3 ──────────────────────────────────────────────────────────────

  it('T-R3 / AC-3: 400 INVALID_PAYLOAD when x402Version missing, adapter NOT called', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const { x402Version: _v, ...rest } = VALID_BODY;
    void _v;
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(rest),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(body.error.http).toBe(400);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('T-R4 / AC-3: 400 INVALID_PAYLOAD when x402Version !== 2 (CD-8)', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const bad = { ...VALID_BODY, x402Version: 1 };
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(bad),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('T-R5 / AC-3: 400 INVALID_PAYLOAD when resource missing', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const { resource: _r, ...rest } = VALID_BODY;
    void _r;
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(rest),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  // ─── AC-4 ──────────────────────────────────────────────────────────────

  it('T-R6 / AC-4: 400 NETWORK_MISMATCH on malformed network "solana:1"', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const bad = { ...VALID_BODY, accepted: { ...VALID_BODY.accepted, network: 'solana:1' } };
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(bad),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('NETWORK_MISMATCH');
    expect(body.error.http).toBe(400);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('T-R7 / AC-4: 400 NETWORK_MISMATCH for "eip155:0" (CD-13)', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const bad = { ...VALID_BODY, accepted: { ...VALID_BODY.accepted, network: 'eip155:0' } };
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(bad),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('NETWORK_MISMATCH');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  // ─── AC-5 ──────────────────────────────────────────────────────────────

  it('T-R8 / AC-5: 400 NETWORK_MISMATCH when chainId not registered', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);

    const bad = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:999999' },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(bad),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('NETWORK_MISMATCH');
  });

  // ─── AC-6 ──────────────────────────────────────────────────────────────

  it('T-R9 / AC-6: passes adapter error verbatim (code, message, http)', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'custom msg', http: 401 },
    }));
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as unknown;
    expect(body).toEqual({
      error: { code: 'INVALID_SIGNATURE', message: 'custom msg', http: 401 },
    });
  });

  // ─── AC-7 ──────────────────────────────────────────────────────────────

  it('T-R10 / AC-7: EXPIRED_AUTHORIZATION when adapter reports expired (past validBefore)', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: {
        code: 'EXPIRED_AUTHORIZATION',
        message: 'Authorization expired',
        http: 400,
      },
    }));
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('EXPIRED_AUTHORIZATION');
  });

  // ─── AC-8 ──────────────────────────────────────────────────────────────

  it('T-R11 / AC-8: EXPIRED_AUTHORIZATION when adapter reports not-yet-valid (future validAfter)', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: {
        code: 'EXPIRED_AUTHORIZATION',
        message: 'Authorization not yet valid',
        http: 400,
      },
    }));
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('EXPIRED_AUTHORIZATION');
    expect(body.error.message).toContain('not yet valid');
  });

  // ─── AC-9 ──────────────────────────────────────────────────────────────

  it('T-R12 / AC-9: returns cached response on second identical request (adapter called once)', async () => {
    const verifySpy = vi.fn(async () => VALID_ADAPTER_RESULT);
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const r1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.body).toBe(r2.body);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  // ─── AC-10 ─────────────────────────────────────────────────────────────

  it('T-R13 / AC-10: logs warn and proceeds when Redis unavailable', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter, {
      capture,
      env: makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
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

  it('T-R14 / AC-11: every response logs request_id + duration_ms (4 scenarios)', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    }));
    const app = await buildAppWithAdapter(adapter, { capture });

    // 1. INVALID_PAYLOAD
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    // 2. NETWORK_MISMATCH
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
      }),
    });
    // 3. INVALID_SIGNATURE (adapter error path)
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    // Reset adapter to success for the OK scenario (idempotency stored the
    // previous 401 for the same body, so vary the body slightly).
    const okAdapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    chainRegistry._resetForTesting();
    chainRegistry.register(okAdapter);
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, amount: '5000000' },
      }),
    });

    const lines = capture.getLines();
    const verifyLines = lines.filter((l) => l.msg === 'verify ok' || l.msg === 'verify failed');
    expect(verifyLines.length).toBeGreaterThanOrEqual(4);
    for (const l of verifyLines) {
      expect(typeof l.request_id).toBe('string');
      expect(typeof l.duration_ms).toBe('number');
    }
  });

  // ─── AC-12 ─────────────────────────────────────────────────────────────

  it('T-R15 / AC-12: error responses emit warn log with error_code + http_status, no PII', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    }));
    const app = await buildAppWithAdapter(adapter, { capture });

    // 1. INVALID_PAYLOAD
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ x402Version: 1 }),
    });
    // 2. NETWORK_MISMATCH
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        ...VALID_BODY,
        accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
      }),
    });
    // 3. INVALID_SIGNATURE
    await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });

    const lines = capture.getLines();
    const failLines = lines.filter((l) => l.msg === 'verify failed');
    expect(failLines.length).toBeGreaterThanOrEqual(3);
    for (const l of failLines) {
      expect(l.level).toBe(40); // warn
      expect(typeof l.error_code).toBe('string');
      expect(typeof l.http_status).toBe('number');
      const asJson = JSON.stringify(l);
      expect(asJson).not.toContain(VALID_BODY.payload.signature);
      expect(asJson).not.toContain(VALID_BODY.payload.authorization.nonce);
    }
  });

  // ─── AC-13 ─────────────────────────────────────────────────────────────

  it('T-R16 / AC-13: returns 415 or 400 for non-JSON Content-Type', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect([400, 415]).toContain(res.statusCode);
  });

  // ─── Defensive: adapter throws → L4 recovery (defense-in-depth) ────────

  it('T-R17 (defense): adapter throw → 500 TRANSACTION_FAILED with error log', async () => {
    const capture = new CaptureStream();
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('adapter kaboom');
    });
    const app = await buildAppWithAdapter(adapter, { capture });

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('TRANSACTION_FAILED');
    expect(body.error.http).toBe(500);

    // L4 error log emitted with request_id + duration_ms.
    const lines = capture.getLines();
    const errorLine = lines.find((l) => l.msg === 'verify adapter threw');
    expect(errorLine).toBeDefined();
    expect(typeof errorLine?.request_id).toBe('string');
    expect(typeof errorLine?.duration_ms).toBe('number');
  });

  // ─── CD-3 structural: adapter-throw log MUST NOT leak Error.message bytes ─

  it('T-R20 (CD-3): adapter throw with signature hex in Error.message → log does NOT contain hex', async () => {
    const capture = new CaptureStream();
    const leakyHex = `0x${'de'.repeat(65)}`;
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error(`ecrecover failed for signature ${leakyHex}`);
    });
    const app = await buildAppWithAdapter(adapter, { capture });

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);

    const lines = capture.getLines();
    const errorLine = lines.find((l) => l.msg === 'verify adapter threw');
    expect(errorLine).toBeDefined();
    // Projection fields only — no err.message, no err.stack serialization.
    expect(errorLine?.error_code).toBe('TRANSACTION_FAILED');
    expect(errorLine?.http_status).toBe(500);
    expect(errorLine?.err_type).toBe('Error');
    // CD-3: no PII / signature bytes in the log line.
    const asJson = JSON.stringify(errorLine);
    expect(asJson).not.toContain(leakyHex);
    expect(asJson).not.toContain('ecrecover failed');
  });

  // ─── Idempotency error-replay path (CD-12 cached non-5xx error) ────────

  it('T-R18: cached non-5xx error replays verbatim on repeat (idempotency error hit)', async () => {
    const verifySpy = vi.fn(async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad', http: 401 },
    }));
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const r1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.body).toBe(r2.body);
    // CD-9 behavior: adapter called only once because r2 was served from cache.
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  // ─── CD-12: 5xx responses MUST NOT be cached ───────────────────────────

  it('T-R19: 5xx adapter error is NOT cached (CD-12) — adapter called twice', async () => {
    const verifySpy = vi.fn(async () => ({
      ok: false,
      error: { code: 'SIMULATION_FAILED', message: 'rpc down', http: 500 },
    }));
    const adapter = makeFakeAdapter(2368, verifySpy);
    const app = await buildAppWithAdapter(adapter);

    const r1 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(r1.statusCode).toBe(500);
    expect(r2.statusCode).toBe(500);
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  // ─── WFAC-33 W4 — audit hook integration ───────────────────────────────

  it('T-AV-1 / AC-1: /verify success invokes persistAuditEntry once with no errorCode/idempotencyKey', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(audit.__persistAuditSpy).toHaveBeenCalledTimes(1);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      path: string;
      statusCode: number;
      errorCode?: string;
      idempotencyKey?: string;
    };
    expect(input.path).toBe('/verify');
    expect(input.statusCode).toBe(200);
    expect(input.errorCode).toBeUndefined();
    // /verify does NOT populate idempotencyKey in auditMeta (AC-12 applies to
    // /settle only — the audit column is only linked for settlements).
    expect(input.idempotencyKey).toBeUndefined();
  });

  it('T-AV-2 / AC-13: /verify 400 Zod path populates errorCode=INVALID_PAYLOAD', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
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

  it('T-AV-3 / AC-13: /verify adapter-throw populates errorCode=TRANSACTION_FAILED', async () => {
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('adapter exploded');
    });
    const app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(500);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      statusCode: number;
      errorCode?: string;
    };
    expect(input.statusCode).toBe(500);
    expect(input.errorCode).toBe('TRANSACTION_FAILED');
  });

  it('T-AV-4 / AC-13: /verify result.ok=false propagates code verbatim', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 400 },
    }));
    const app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(400);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      statusCode: number;
      errorCode?: string;
    };
    expect(input.statusCode).toBe(400);
    expect(input.errorCode).toBe('INVALID_SIGNATURE');
  });

  it('T-AV-5 / AC-12: /verify success leaves idempotencyKey undefined (builder will null it)', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_ADAPTER_RESULT);
    const app = await buildAppWithAdapter(adapter);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(200);

    const input = audit.__buildAuditSpy.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(input.idempotencyKey).toBeUndefined();
    // buildAuditEntry coerces undefined → null; validated in audit.test.ts T-A1.
  });

  // ─── WFAC-41 — circuit breaker Retry-After header (T-RT-VERIFY-CB-*) ────

  it('T-RT-VERIFY-CB-1 (AC-2, AC-11): CHAIN_UNAVAILABLE returns 503 + Retry-After header', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: {
        code: 'CHAIN_UNAVAILABLE' as const,
        message: 'Chain RPC temporarily unavailable',
        http: 503,
        retryAfterMs: 7500,
      },
    }));
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
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

  it('T-RT-VERIFY-CB-2 (CD-NEW-CB-RETRY-AFTER-INTERNAL): 503 body has exactly {code, message, http} — retryAfterMs NOT serialized', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: {
        code: 'CHAIN_UNAVAILABLE' as const,
        message: 'Chain RPC temporarily unavailable',
        http: 503,
        retryAfterMs: 2000,
      },
    }));
    const app = await buildAppWithAdapter(adapter);

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    const body = JSON.parse(res.body) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(['code', 'http', 'message']);
    expect((body.error as { retryAfterMs?: unknown }).retryAfterMs).toBeUndefined();
  });
});
