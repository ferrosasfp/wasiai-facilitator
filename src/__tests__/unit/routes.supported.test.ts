/**
 * Integration tests for GET /supported via app.inject() (WFAC-22 W2).
 *
 * Pattern: mirrors src/__tests__/unit/routes.verify.test.ts — CaptureStream
 * from E11 + vi.mock('ioredis') from E12 + chainRegistry._resetForTesting().
 *
 * CD-6 observed: every test uses app.inject() — no live ports.
 * CD-15/CD-16 observed: NEVER imports src/chains/kite.ts or
 * src/chains/avalanche.ts — fake adapters are registered explicitly with
 * realistic metadata (Kite Testnet 2368, Avalanche Fuji 43113) to validate
 * AC-3 and AC-4 without coupling to real adapter env vars.
 *
 * AC coverage:
 *   - AC-1  → T-R1   (200 + exact top-level shape)
 *   - AC-2  → T-R2   (live registry read — register new adapter mid-test)
 *   - AC-3  → T-R3   (Kite Testnet entry present)
 *   - AC-4  → T-R4   (Avalanche Fuji entry present)
 *   - AC-5  → T-R5   (methods top-level === ['eip3009'])
 *   - AC-6  → T-R6   (POST /supported → 404, no side effects)
 *   - AC-7  → T-R7   (info log 'supported ok' with required fields)
 *   - AC-8  → T-R8   (log has no PII — no ip, no headers, no user-agent)
 *   - AC-9  → T-R9   (zero adapters → { chains: [], methods: [] })
 *   - AC-10 → T-R10  (content-type application/json + valid JSON)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter } from '../../chains/types.js';

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

// ─── ioredis mock (mirrors routes.verify.test.ts) ──────────────────────────
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

// ─── CaptureStream (verbatim from routes.verify.test.ts) ──────────────────
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

/**
 * Build a minimal ChainAdapter with deterministic metadata. Matches
 * ChainMetadata shape exactly (see src/chains/types.ts:34). verify/settle/
 * clients are stubs — GET /supported never invokes them.
 */
function makeFakeAdapter(chainIdNum: number, name: string): ChainAdapter {
  return {
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

/**
 * Build the Fastify app with a caller-controlled set of registered chains.
 * Passing `[]` leaves the registry empty (zero-adapter case for AC-9).
 */
async function buildAppWithAdapters(
  adapters: readonly ChainAdapter[],
  opts: {
    capture?: CaptureStream;
    env?: EnvConfig;
  } = {},
): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  for (const adapter of adapters) {
    chainRegistry.register(adapter);
  }

  const { buildApp } = await import('../../app.js');
  const env = opts.env ?? makeEnv();
  return buildApp({
    env,
    loggerDestination: opts.capture,
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('GET /supported', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __getSpy: ReturnType<typeof vi.fn> }).__getSpy.mockClear();
    (ioredis as unknown as { __setSpy: ReturnType<typeof vi.fn> }).__setSpy.mockClear();
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  // ─── AC-1 ──────────────────────────────────────────────────────────────

  it('T-R1 / AC-1: returns 200 with exact top-level shape { chains, methods }', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['chains', 'methods']);
    expect(Array.isArray(body.chains)).toBe(true);
    expect(Array.isArray(body.methods)).toBe(true);

    const chains = body.chains as Array<Record<string, unknown>>;
    expect(chains.length).toBe(1);
    expect(Object.keys(chains[0]!).sort()).toEqual(['methods', 'name', 'network']);
    expect(typeof chains[0]!.network).toBe('string');
    expect(typeof chains[0]!.name).toBe('string');
    expect(Array.isArray(chains[0]!.methods)).toBe(true);
  });

  // ─── AC-2 ──────────────────────────────────────────────────────────────

  it('T-R2 / AC-2: reads the live registry (new adapter shows up on next request)', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite]);

    const r1 = await app.inject({ method: 'GET', url: '/supported' });
    const body1 = JSON.parse(r1.body) as { chains: Array<{ network: string }> };
    expect(body1.chains.length).toBe(1);

    // Register a second adapter AFTER the app is built. DT-3 says response
    // is computed at request time — the next GET must reflect the new state.
    const avalanche = makeFakeAdapter(43113, 'Avalanche Fuji');
    chainRegistry.register(avalanche);

    const r2 = await app.inject({ method: 'GET', url: '/supported' });
    const body2 = JSON.parse(r2.body) as { chains: Array<{ network: string }> };
    expect(body2.chains.length).toBe(2);
    const networks = body2.chains.map((c) => c.network).sort();
    expect(networks).toEqual(['eip155:2368', 'eip155:43113']);
  });

  // ─── AC-3 ──────────────────────────────────────────────────────────────

  it('T-R3 / AC-3: includes Kite Testnet entry with eip155:2368 + methods [eip3009]', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    const avalanche = makeFakeAdapter(43113, 'Avalanche Fuji');
    app = await buildAppWithAdapters([kite, avalanche]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      chains: Array<{ network: string; name: string; methods: string[] }>;
    };
    const kiteEntry = body.chains.find((c) => c.network === 'eip155:2368');
    expect(kiteEntry).toEqual({
      network: 'eip155:2368',
      name: 'Kite Testnet',
      methods: ['eip3009'],
    });
  });

  // ─── AC-4 ──────────────────────────────────────────────────────────────

  it('T-R4 / AC-4: includes Avalanche Fuji entry with eip155:43113 + methods [eip3009]', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    const avalanche = makeFakeAdapter(43113, 'Avalanche Fuji');
    app = await buildAppWithAdapters([kite, avalanche]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      chains: Array<{ network: string; name: string; methods: string[] }>;
    };
    const avaxEntry = body.chains.find((c) => c.network === 'eip155:43113');
    expect(avaxEntry).toEqual({
      network: 'eip155:43113',
      name: 'Avalanche Fuji',
      methods: ['eip3009'],
    });
  });

  // ─── AC-5 ──────────────────────────────────────────────────────────────

  it('T-R5 / AC-5: top-level methods equals ["eip3009"] when chains are registered', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    const avalanche = makeFakeAdapter(43113, 'Avalanche Fuji');
    app = await buildAppWithAdapters([kite, avalanche]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { methods: string[] };
    // Deduped union across both chains. Both expose ['eip3009'] → result is
    // the single method, no duplicates.
    expect(body.methods).toEqual(['eip3009']);
  });

  // ─── AC-6 ──────────────────────────────────────────────────────────────

  it('T-R6 / AC-6: POST /supported returns 404 (Fastify default, no side effects)', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite]);

    const res = await app.inject({ method: 'POST', url: '/supported', payload: '{}' });
    // Fastify default for an unregistered method on a matched path is 404.
    // The AC also accepts 405; this implementation yields 404.
    expect([404, 405]).toContain(res.statusCode);
  });

  // ─── AC-7 ──────────────────────────────────────────────────────────────

  it('T-R7 / AC-7: emits info log "supported ok" with request_id + chain_count + duration_ms', async () => {
    const capture = new CaptureStream();
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    const avalanche = makeFakeAdapter(43113, 'Avalanche Fuji');
    app = await buildAppWithAdapters([kite, avalanche], { capture });

    await app.inject({ method: 'GET', url: '/supported' });

    const lines = capture.getLines();
    const okLine = lines.find((l) => l.msg === 'supported ok');
    expect(okLine).toBeDefined();
    expect(typeof okLine?.request_id).toBe('string');
    expect(okLine?.chain_count).toBe(2);
    expect(typeof okLine?.duration_ms).toBe('number');
    expect(okLine?.level).toBe(30); // info
  });

  // ─── AC-8 ──────────────────────────────────────────────────────────────

  it('T-R8 / AC-8: log does NOT contain ip, user-agent, or authorization header', async () => {
    const capture = new CaptureStream();
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite], { capture });

    // Inject a request with PII-ish headers; the info-level 'supported ok'
    // line must not include any of them (CD-3).
    await app.inject({
      method: 'GET',
      url: '/supported',
      headers: {
        'user-agent': 'pii-scan-bot/1.0',
        authorization: 'Bearer pii-token-abc',
        'x-forwarded-for': '203.0.113.42',
      },
      remoteAddress: '203.0.113.42',
    });

    const lines = capture.getLines();
    const okLine = lines.find((l) => l.msg === 'supported ok');
    expect(okLine).toBeDefined();
    const asJson = JSON.stringify(okLine);
    expect(asJson).not.toContain('pii-scan-bot');
    expect(asJson).not.toContain('pii-token-abc');
    expect(asJson).not.toContain('203.0.113.42');
    expect(asJson).not.toContain('user-agent');
    expect(asJson).not.toContain('authorization');
  });

  // ─── AC-9 ──────────────────────────────────────────────────────────────

  it('T-R9 / AC-9: zero adapters registered → 200 with { chains: [], methods: [] }', async () => {
    app = await buildAppWithAdapters([]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as unknown;
    expect(body).toEqual({ chains: [], methods: [] });
  });

  // ─── AC-10 ─────────────────────────────────────────────────────────────

  it('T-R10 / AC-10: content-type is application/json and body is valid JSON', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    // RFC 8259 parseability — JSON.parse would throw on malformed body.
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('chains');
    expect(parsed).toHaveProperty('methods');

    const contentType = res.headers['content-type'];
    expect(typeof contentType).toBe('string');
    expect(String(contentType).toLowerCase()).toContain('application/json');
  });

  // ─── WFAC-33 W4 — audit hook integration ───────────────────────────────

  it('T-ASU-1 / AC-1: /supported IS audited (not in AUDIT_EXCLUDED_PATHS)', async () => {
    const kite = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([kite]);
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockClear();
    audit.__buildAuditSpy.mockClear();

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);

    expect(audit.__persistAuditSpy).toHaveBeenCalledTimes(1);
    const input = audit.__buildAuditSpy.mock.calls[0]![0] as {
      path: string;
      method: string;
      statusCode: number;
      errorCode?: string;
      idempotencyKey?: string;
    };
    expect(input.path).toBe('/supported');
    expect(input.method).toBe('GET');
    expect(input.statusCode).toBe(200);
    expect(input.errorCode).toBeUndefined();
    expect(input.idempotencyKey).toBeUndefined();
  });
});
