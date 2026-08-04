/**
 * Integration test for the HU-SOL-9 / WKH-208 Solana wire (Wave W4).
 *
 * Proves the Zod gate no longer rejects a base58 Solana body with
 * `400 INVALID_PAYLOAD`: the body now PASSES SettleRequestSchema, reaches
 * `settleCore`, and — with the Solana adapter NOT registered (CD-6:
 * SOLANA_RPC_URL / SOLANA_USDC_MINT absent) — the namespace dispatch returns
 * `CHAIN_UNAVAILABLE` (503). A 503 (not a 400) is exactly the evidence that the
 * schema gate was passed WITHOUT turning on the adapter.
 *
 * Harness copied from routes.settle.test.ts (CaptureStream + ioredis/ledger/
 * audit mocks + app.inject()). NO Solana adapter is registered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter } from '../../chains/types.js';

// ─── core/ledger.js mock (silent passthrough — no Supabase) ─────────────────
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

// ─── core/audit.js mock (silent resolve — no Supabase) ──────────────────────
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

// ─── ioredis mock (verbatim from routes.settle.test.ts) ─────────────────────
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

// ─── fixtures ────────────────────────────────────────────────────────────────

// Real/valid base58 values (deterministic, generated via @solana/web3.js).
// eslint-disable-next-line no-secrets/no-secrets -- public devnet USDC mint (base58 pubkey), not a secret.
const SOLANA_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
// eslint-disable-next-line no-secrets/no-secrets -- valid base58 pubkey test fixture (payTo), not a secret.
const SOLANA_PAYTO = 'C3JMHiAmkKzbPFvY4TREAMtraNrvW3gDGhDS95a7S2tY';
// eslint-disable-next-line no-secrets/no-secrets -- valid base58 pubkey test fixture (reference), not a secret.
const SOLANA_REFERENCE = '3jHFFgYmtqmoDQwJwCfuGsdbvCVVJtm55QVR1GMcXjne';
const SOLANA_SIGNATURE =
  // eslint-disable-next-line no-secrets/no-secrets -- valid base58 signature test fixture, not a secret.
  '44VvSvnGgBBE21SMd9eHryB28LzYW7J3FDkZ9XzFMiaXGY5r4dL7BPzQSaR4cjDDUcGRemWVPgWMLkq9v8BjdHEg';

// The body chaski actually POSTs (chaski-v3 facilitator-client.ts:94-109):
// `payload.reference` always present.
const SOLANA_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'solana:devnet',
    amount: '10000000',
    asset: SOLANA_MINT,
    payTo: SOLANA_PAYTO,
    maxTimeoutSeconds: 60,
  },
  payload: {
    signature: SOLANA_SIGNATURE,
    reference: SOLANA_REFERENCE,
  },
} as const;

// Same body with `payload.reference` omitted.
const SOLANA_BODY_NO_REF = {
  ...SOLANA_BODY,
  payload: { signature: SOLANA_SIGNATURE },
} as const;

/** A minimal EVM fake adapter — registered ONLY so buildApp has a chain; the
 * Solana namespace lookup (by networkId `solana:devnet`) never resolves it. */
function makeFakeEvmAdapter(chainIdNum: number): ChainAdapter {
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
    settle: (async () => {
      throw new Error('EVM adapter must not be invoked for a Solana body');
    }) as unknown as ChainAdapter['settle'],
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
    ...overrides,
    // Deliberately partial (repo idiom, cf. routes.settle.failopen.test.ts): this
    // fixture sets only the fields the unit under test reads. The cast is what lets
    // it stand in for EnvConfig — every field NOT listed above reaches the code as
    // `undefined` even though EnvConfig declares it required.
  } as EnvConfig;
}

async function buildAppSolana(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  resetRedisClientForTests();
  chainRegistry._resetForTesting();
  // Only an EVM adapter is registered — NO Solana adapter (CD-6).
  chainRegistry.register(makeFakeEvmAdapter(2368));

  const { buildApp } = await import('../../app.js');
  return buildApp({ env: makeEnv(), skipDomainCheck: true });
}

// ─── TF4 ─────────────────────────────────────────────────────────────────────

describe('POST /settle — Solana wire (TF4, AC-3)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (
      ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }
    ).__constructorSpy.mockClear();
    (ioredis as unknown as { __store: Map<string, string> }).__store.clear();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('TF4: a base58 Solana body is NOT 400 INVALID_PAYLOAD — reaches settleCore → 503 CHAIN_UNAVAILABLE', async () => {
    app = await buildAppSolana();

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(SOLANA_BODY),
    });

    // The Zod gate was passed — NOT rejected with 400.
    expect(res.statusCode).not.toBe(400);
    // Namespace dispatch ran with the Solana adapter unregistered (CD-6).
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string; http: number } };
    expect(body.error.code).toBe('CHAIN_UNAVAILABLE');
    expect(body.error.http).toBe(503);
  });

  // ── missing `payload.reference` — rejected AT THE EDGE ───────────────────
  //
  // Measured before the fix, on this same route with the Solana adapter
  // REGISTERED and a stubbed Connection:
  //   · tx found & finalized → 400 NETWORK_MISMATCH
  //                            "payment reference not found in tx"
  //   · tx not yet finalized → 500 TRANSACTION_FAILED
  //                            "tx not found or not finalized"
  // Both arrived only AFTER the RPC roundtrip, and neither names the missing
  // field; the second even reports a caller-side shape error as a 5xx.
  it('★ sin payload.reference → 400 INVALID_PAYLOAD que NOMBRA el campo', async () => {
    app = await buildAppSolana();

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(SOLANA_BODY_NO_REF),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string; message: string; http: number } };
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(body.error.http).toBe(400);
    expect(body.error.message).toBe('payload.reference: Required');
  });

  it('★ el rechazo llega en el BORDE: nunca alcanza el dispatch de red', async () => {
    // Discriminating evidence, not a restatement of the test above. This app
    // registers NO Solana adapter, so ANY body that clears the Zod gate reaches
    // the namespace dispatch and comes back 503 CHAIN_UNAVAILABLE — that is
    // exactly what the TF4 test above asserts for the well-formed body. Getting
    // 400 instead of 503 here therefore proves the request died at the schema,
    // before any adapter/RPC/DB work.
    app = await buildAppSolana();

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(SOLANA_BODY_NO_REF),
    });

    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).toBe(400);
  });
});
