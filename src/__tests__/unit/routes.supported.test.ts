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
import type { ChainAdapter, SettlementAdapter } from '../../chains/types.js';
// WKH-323 — value import of the published literal. `chains/types.js` is
// side-effect free; importing `chains/solana-adapter.js` here is forbidden (see
// the CD-15/CD-16 note above, and it would run that module's env-reading
// factory IIFE).
import { SPL_TOKEN_TRANSFER_FINALIZED } from '../../chains/types.js';

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
    probeRpc: vi.fn(async (): Promise<void> => undefined),
  };
}

/**
 * WKH-323 — fake of the non-EVM Solana rail. Shape is `SettlementAdapter`
 * (no viem clients), metadata copied from the real adapter's own
 * `this.metadata` (src/chains/solana-adapter.ts). Deliberately WITHOUT
 * getPublicClient/getWalletClient and WITHOUT getBreakerState, which is what
 * the real adapter looks like.
 */
function makeFakeSolanaAdapter(): SettlementAdapter {
  return {
    metadata: {
      chainId: asChainId(103),
      name: 'Solana Devnet',
      network: 'testnet',
      networkId: 'solana:devnet',
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      tokens: [],
      supportedMethods: [SPL_TOKEN_TRANSFER_FINALIZED],
    },
    verify: vi.fn() as unknown as SettlementAdapter['verify'],
    settle: vi.fn() as unknown as SettlementAdapter['settle'],
    probeRpc: vi.fn() as unknown as SettlementAdapter['probeRpc'],
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
 * Build the Fastify app with a caller-controlled set of registered chains.
 * Passing `[]` leaves the registry empty (zero-adapter case for AC-9).
 */
async function buildAppWithAdapters(
  // WKH-323 — widened from `ChainAdapter[]`: the registry has accepted the
  // wider `SettlementAdapter` since WKH-205 (registry.ts register/_isValidAdapter),
  // so a non-EVM fake can be registered here.
  adapters: readonly SettlementAdapter[],
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
    skipDomainCheck: true, // WFAC-53 CD-16 — no real chain adapters wired in this test
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
    expect(Object.keys(chains[0]!).sort()).toEqual([
      'breakerStateAbsentReason',
      'methods',
      'name',
      'network',
    ]);
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
      // `makeFakeAdapter` no expone `getBreakerState`, así que la entrada dice POR QUÉ
      // no trae estado en vez de omitirlo en silencio.
      breakerStateAbsentReason: 'NO_BREAKER',
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
      breakerStateAbsentReason: 'NO_BREAKER',
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

  // ─── WFAC-41 — breakerState field (T-RT-SUPPORTED-CB-*) ─────────────────

  it('T-RT-SUPPORTED-CB-1 (AC-9): chains expose breakerState when adapter has getBreakerState', async () => {
    // Make an adapter that exposes getBreakerState (mimicking KiteAdapter).
    const adapterWithBreaker: ChainAdapter & { getBreakerState: () => 'CLOSED' } = {
      metadata: {
        chainId: asChainId(2368),
        name: 'Kite Testnet',
        network: 'testnet',
        networkId: 'eip155:2368',
        rpcUrl: 'http://localhost',
        nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
        tokens: [],
      },
      verify: vi.fn() as unknown as ChainAdapter['verify'],
      settle: vi.fn() as unknown as ChainAdapter['settle'],
      getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
      getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
      probeRpc: vi.fn(async (): Promise<void> => undefined),
      getBreakerState: () => 'CLOSED',
    };
    app = await buildAppWithAdapters([adapterWithBreaker]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      chains: Array<{ breakerState?: string }>;
    };
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0]!.breakerState).toBe('CLOSED');
  });

  it('T-RT-SUPPORTED-CB-2 (ducktype): chains WITHOUT getBreakerState OMIT the field (not null, not undefined)', async () => {
    // Plain fake adapter — makeFakeAdapter does not expose getBreakerState.
    const adapter = makeFakeAdapter(2368, 'Kite Testnet');
    app = await buildAppWithAdapters([adapter]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    expect(body.chains).toHaveLength(1);
    // The field must be ABSENT from the JSON (not serialized as undefined/null).
    expect(Object.prototype.hasOwnProperty.call(body.chains[0], 'breakerState')).toBe(false);
  });

  it('T-RT-SUPPORTED-CB-3 (AR-BLQ-BAJO-1): breakerState OMITTED when getBreakerState returns undefined (CB_ENABLED=false analogue)', async () => {
    // When CB_ENABLED=false, ChainCircuitBreaker.getState() returns undefined
    // (passthrough mode — no policy, no state to expose). Emulate that by
    // returning `undefined` from the adapter's getBreakerState. The serializer
    // MUST treat it identically to the "no getter at all" case: the field is
    // absent from the JSON (no misleading 'CLOSED' for a chain whose breaker
    // is disabled). Ensures DT-7 compliance end-to-end.
    const disabledAdapter: ChainAdapter & {
      getBreakerState: () => 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
    } = {
      metadata: {
        chainId: asChainId(2368),
        name: 'Kite Testnet',
        network: 'testnet',
        networkId: 'eip155:2368',
        rpcUrl: 'http://localhost',
        nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
        tokens: [],
      },
      verify: vi.fn() as unknown as ChainAdapter['verify'],
      settle: vi.fn() as unknown as ChainAdapter['settle'],
      getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
      getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
      probeRpc: vi.fn(async (): Promise<void> => undefined),
      getBreakerState: () => undefined,
    };
    app = await buildAppWithAdapters([disabledAdapter]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    expect(body.chains).toHaveLength(1);
    // Field MUST be absent — `Object.keys` excludes it, and
    // `hasOwnProperty('breakerState')` is false.
    expect(Object.keys(body.chains[0]!)).not.toContain('breakerState');
    expect(Object.prototype.hasOwnProperty.call(body.chains[0], 'breakerState')).toBe(false);
  });

  // ─── WKH-323 — per-chain methods (T-R11..T-R14) ─────────────────────────

  it('T-R11 / AC-1: the solana:devnet entry reports the SPL mechanism, not eip3009', async () => {
    app = await buildAppWithAdapters([makeFakeSolanaAdapter()]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      chains: Array<{ network: string; methods: string[] }>;
    };
    const solana = body.chains.find((c) => c.network === 'solana:devnet');
    expect(solana?.methods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
    expect(solana?.methods).not.toContain('eip3009');
  });

  it('T-R12 / AC-2: top-level methods is the deduped union across rails', async () => {
    // Two EVM fakes contribute the SAME value, so a length of 2 proves the
    // dedup ran; the Solana fake contributes the second, distinct one.
    app = await buildAppWithAdapters([
      makeFakeAdapter(2368, 'Kite Testnet'),
      makeFakeAdapter(43113, 'Avalanche Fuji'),
      makeFakeSolanaAdapter(),
    ]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { methods: string[] };
    expect([...body.methods].sort()).toEqual(['eip3009', SPL_TOKEN_TRANSFER_FINALIZED]);
    expect(body.methods.length).toBe(2);
  });

  it('T-R13 / AC-3: the Solana override does not leak into its EVM neighbours', async () => {
    app = await buildAppWithAdapters([
      makeFakeAdapter(2368, 'Kite Testnet'),
      makeFakeAdapter(43113, 'Avalanche Fuji'),
      makeFakeSolanaAdapter(),
    ]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as {
      chains: Array<{ network: string; methods: string[] }>;
    };
    const evmEntries = body.chains.filter((c) => c.network.startsWith('eip155:'));
    expect(evmEntries).toHaveLength(2);
    for (const entry of evmEntries) {
      expect(entry.methods).toEqual(['eip3009']);
    }
  });

  it('T-R14 / AC-4 (CD-12): Solana omits breakerState while a sibling EVM chain still emits it', async () => {
    // The EVM fake MUST expose getPublicClient + getWalletClient: supported.ts
    // resolves the adapter through chainRegistry.getAdapter(), whose
    // `_isChainAdapter` narrowing (registry.ts) requires both. Without them the
    // lookup fails and breakerState would be omitted for the EVM chain too —
    // the test would then pass for the wrong reason and prove nothing about
    // cross-entry isolation.
    const evmWithBreaker: ChainAdapter & { getBreakerState: () => 'CLOSED' } = {
      metadata: {
        chainId: asChainId(2368),
        name: 'Kite Testnet',
        network: 'testnet',
        networkId: 'eip155:2368',
        rpcUrl: 'http://localhost',
        nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
        tokens: [],
      },
      verify: vi.fn() as unknown as ChainAdapter['verify'],
      settle: vi.fn() as unknown as ChainAdapter['settle'],
      getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
      getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
      probeRpc: vi.fn(async (): Promise<void> => undefined),
      getBreakerState: () => 'CLOSED',
    };
    app = await buildAppWithAdapters([evmWithBreaker, makeFakeSolanaAdapter()]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      chains: Array<Record<string, unknown> & { network: string }>;
    };

    const solanaEntry = body.chains.find((c) => c.network === 'solana:devnet');
    expect(solanaEntry).toBeDefined();
    // `breakerState` ABSENT (not null, not undefined) — pero la entrada ya no calla el
    // motivo: trae `breakerStateAbsentReason`.
    expect(Object.keys(solanaEntry!).sort()).toEqual([
      'breakerStateAbsentReason',
      'methods',
      'name',
      'network',
    ]);

    const evmEntry = body.chains.find((c) => c.network === 'eip155:2368');
    expect(evmEntry?.breakerState).toBe('CLOSED');
  });

  // ─── la ausencia de `breakerState` deja de ser muda ──────────────────────
  //
  // Antes las cuatro entradas `eip155:*` traían `breakerState` y `solana:devnet` no, y
  // desde afuera eso se veía IGUAL que un campo perdido en el camino. Estos tests fijan
  // las dos mitades: que la razón se diga, y que NO se invente un estado para decirla.

  it('★ la entrada Solana NO trae breakerState y dice POR QUÉ: NO_BREAKER (no un CLOSED inventado)', async () => {
    app = await buildAppWithAdapters([makeFakeSolanaAdapter()]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    const solana = body.chains.find((c) => c.network === 'solana:devnet');

    // Nada verde que nada sostenga: el adaptador Solana no tiene breaker.
    expect(Object.prototype.hasOwnProperty.call(solana, 'breakerState')).toBe(false);
    expect(solana?.breakerStateAbsentReason).toBe('NO_BREAKER');
    // Y la razón es "le pregunté y no tiene", NO "no lo encontré": con el lookup por
    // `chainId` (que busca `eip155:103`) el adaptador Solana era INHALLABLE y esto
    // saldría 'ADAPTER_LOOKUP_FAILED'. Ése es el mutante que este assert mata.
    expect(solana?.breakerStateAbsentReason).not.toBe('ADAPTER_LOOKUP_FAILED');
  });

  it('★★ un adaptador Solana hipotético CON breaker sí reportaría su estado — la omisión de hoy es del adaptador, no del riel', async () => {
    // Este test no describe el adaptador real (que no tiene breaker): describe que
    // `/supported` le PREGUNTA. Sin el lookup por networkId, la entrada `solana:*`
    // nunca podría reportar un estado aunque lo tuviera, y la omisión de hoy sería una
    // coincidencia de dos hechos independientes en vez de una respuesta.
    const solanaWithBreaker: SettlementAdapter & { getBreakerState: () => 'OPEN' } = {
      ...makeFakeSolanaAdapter(),
      getBreakerState: () => 'OPEN',
    };
    app = await buildAppWithAdapters([solanaWithBreaker]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    const solana = body.chains.find((c) => c.network === 'solana:devnet');
    expect(solana?.breakerState).toBe('OPEN');
    expect(Object.prototype.hasOwnProperty.call(solana, 'breakerStateAbsentReason')).toBe(false);
  });

  it('★★ "no tiene breaker" y "lo tiene apagado" NO son la misma respuesta', async () => {
    // Las dos omitían `breakerState` y eran indistinguibles desde afuera. Si alguien
    // colapsa las dos razones en una, este test muere.
    const disabled: ChainAdapter & { getBreakerState: () => undefined } = {
      ...makeFakeAdapter(2368, 'Kite Testnet'),
      getBreakerState: () => undefined,
    };
    app = await buildAppWithAdapters([disabled, makeFakeSolanaAdapter()]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    const evm = body.chains.find((c) => c.network === 'eip155:2368');
    const solana = body.chains.find((c) => c.network === 'solana:devnet');

    expect(evm?.breakerStateAbsentReason).toBe('BREAKER_DISABLED');
    expect(solana?.breakerStateAbsentReason).toBe('NO_BREAKER');
    expect(evm?.breakerStateAbsentReason).not.toBe(solana?.breakerStateAbsentReason);
  });

  it('★★★ INVARIANTE: cada entrada trae EXACTAMENTE UNO de breakerState / breakerStateAbsentReason', async () => {
    // Las tres formas posibles de adaptador en una sola respuesta.
    const live: ChainAdapter & { getBreakerState: () => 'HALF_OPEN' } = {
      ...makeFakeAdapter(2368, 'Kite Testnet'),
      getBreakerState: () => 'HALF_OPEN',
    };
    const disabled: ChainAdapter & { getBreakerState: () => undefined } = {
      ...makeFakeAdapter(43113, 'Avalanche Fuji'),
      getBreakerState: () => undefined,
    };
    app = await buildAppWithAdapters([live, disabled, makeFakeSolanaAdapter()]);

    const res = await app.inject({ method: 'GET', url: '/supported' });
    const body = JSON.parse(res.body) as { chains: Array<Record<string, unknown>> };
    expect(body.chains).toHaveLength(3);

    for (const entry of body.chains) {
      const hasState = Object.prototype.hasOwnProperty.call(entry, 'breakerState');
      const hasReason = Object.prototype.hasOwnProperty.call(entry, 'breakerStateAbsentReason');
      // Ni los dos (contradicción) ni ninguno (que es exactamente lo que un consumidor
      // debe poder leer como "esta respuesta está incompleta").
      expect([hasState, hasReason]).toEqual(hasState ? [true, false] : [false, true]);
    }

    expect(body.chains.find((c) => c.network === 'eip155:2368')?.breakerState).toBe('HALF_OPEN');
    expect(body.chains.find((c) => c.network === 'eip155:43113')?.breakerStateAbsentReason).toBe(
      'BREAKER_DISABLED',
    );
    expect(body.chains.find((c) => c.network === 'solana:devnet')?.breakerStateAbsentReason).toBe(
      'NO_BREAKER',
    );
  });
});
