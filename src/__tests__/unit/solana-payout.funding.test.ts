/**
 * WKH-302 — funding pre-check, fail-closed and distinguishable (T-AC8a..d).
 *
 * The point of AC-8 is that an underfunded operator must fail with its OWN code
 * instead of degrading into "let the gateway sign it". And that an RPC failure is
 * NOT reported as funding-low: confusing the two trains the operator to top up a
 * wallet that is perfectly fine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as Web3 from '@solana/web3.js';
import type * as SupabaseModule from '../../infra/supabase.js';

const h = vi.hoisted(() => ({
  chain: { current: null as unknown },
  ledger: { rows: [] as Record<string, unknown>[] },
}));

interface FakeConn {
  getLatestBlockhash: (c?: string) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  isBlockhashValid: (b: string) => Promise<{ value: boolean }>;
  sendRawTransaction: (raw: Uint8Array, o?: unknown) => Promise<string>;
  confirmTransaction: (s: string, c?: string) => Promise<{ value: { err: unknown } }>;
  getParsedTransaction: (s: string, o?: unknown) => Promise<unknown>;
  getBalance: (p: Web3.PublicKey) => Promise<number>;
  getTokenAccountBalance: (p: Web3.PublicKey) => Promise<{ value: { amount: string } }>;
}

vi.mock('@solana/web3.js', async (importActual) => {
  const actual = await importActual<typeof Web3>();
  class MockConnection {
    constructor(_url: string, _commitment?: string) {}
    private get c(): FakeConn {
      return h.chain.current as FakeConn;
    }
    getLatestBlockhash(c?: string) {
      return this.c.getLatestBlockhash(c);
    }
    isBlockhashValid(b: string) {
      return this.c.isBlockhashValid(b);
    }
    sendRawTransaction(raw: Uint8Array, o?: unknown) {
      return this.c.sendRawTransaction(raw, o);
    }
    confirmTransaction(s: string, c?: string) {
      return this.c.confirmTransaction(s, c);
    }
    getParsedTransaction(s: string, o?: unknown) {
      return this.c.getParsedTransaction(s, o);
    }
    getBalance(p: Web3.PublicKey) {
      return this.c.getBalance(p);
    }
    getTokenAccountBalance(p: Web3.PublicKey) {
      return this.c.getTokenAccountBalance(p);
    }
  }
  return { ...actual, Connection: MockConnection };
});

vi.mock('../../infra/supabase.js', async (importActual) => ({
  ...(await importActual<typeof SupabaseModule>()),
  getSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'facilitator_solana_payouts') return sink();
      return {
        insert: (obj: Record<string, unknown>) => {
          h.ledger.rows.push(obj);
          return Promise.resolve({ error: null });
        },
        // A conditional UPDATE that APPLIED returns exactly one row. Returning an
        // empty array here would make markSigned fail and every payout end in 500 —
        // which is precisely what the positive control at the bottom of this file
        // exists to catch.
        update: () => appliedUpdate(),
        select: () => sink(),
      };
    },
  }),
}));

function appliedUpdate() {
  const s = {
    eq: () => s,
    lt: () => s,
    select: () => Promise.resolve({ data: [{ id: 'r1' }], error: null }),
  };
  return s;
}

function sink() {
  const s = {
    insert: () => Promise.resolve({ error: null }),
    update: () => s,
    select: () => Promise.resolve({ data: [], error: null }),
    eq: () => s,
    lt: () => s,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return s;
}

vi.mock('../../core/solana-payout-cap.js', () => ({
  checkAndIncrPayoutRate: () => Promise.resolve({ ok: true }),
  checkAndIncrPayoutDailyAtomic: () => Promise.resolve({ ok: true }),
  releasePayoutDailyAtomic: () => Promise.resolve(),
}));

import { Keypair, type PublicKey } from '@solana/web3.js';
import { FakeSolanaChain } from './methods/solana-payout/fake-solana-chain.js';

const DECIMALS = 6;
const AMOUNT = 3_000_000n;

const operatorKp = Keypair.generate();
const mintKp = Keypair.generate();

let chain: FakeSolanaChain;
let app: FastifyInstance | undefined;
let agent: PublicKey;
let agentAta: PublicKey;

const saved = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_PAYOUT_ENABLED',
  'SOLANA_PAYOUT_OPERATOR_SECRET_KEY',
  'SOLANA_PAYOUT_MIN_SOL_LAMPORTS',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
  'FACILITATOR_API_KEY',
];

function applyEnv(): void {
  const env = new Map(Object.entries(process.env));
  for (const k of ENV_KEYS) saved.set(k, env.get(k));
  process.env.SOLANA_PAYOUT_ENABLED = 'true';
  process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = JSON.stringify(Array.from(operatorKp.secretKey));
  process.env.SOLANA_PAYOUT_MIN_SOL_LAMPORTS = '10000000';
  process.env.SOLANA_RPC_URL = 'http://mock-devnet-rpc';
  process.env.SOLANA_USDC_MINT = mintKp.publicKey.toBase58();
  process.env.FACILITATOR_API_KEY = 'test-facilitator-key';
  delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
}

function restoreEnv(): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k as keyof NodeJS.ProcessEnv];
    else process.env[k as keyof NodeJS.ProcessEnv] = v;
  }
  saved.clear();
}

async function buildPayoutApp(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetPayoutOperatorForTesting } = await import('../../infra/solana-payout-operator.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  const { resetReleaseAuthorityForTesting } =
    await import('../../infra/solana-release-authority.js');
  const { resetChainMutexForTesting } = await import('../../chains/chain-mutex.js');
  resetRedisClientForTests();
  resetPayoutOperatorForTesting();
  resetFeePayerForTesting();
  resetReleaseAuthorityForTesting();
  resetChainMutexForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ skipDomainCheck: true });
}

const post = () =>
  app?.inject({
    method: 'POST',
    url: '/solana/payout',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-facilitator-key',
    },
    payload: JSON.stringify({
      intentId: 'run-1:0',
      payTo: agent.toBase58(),
      amountAtomic: AMOUNT.toString(),
      network: 'solana:devnet',
    }),
  });

const code = (res: { body: string } | undefined): string =>
  (JSON.parse(res?.body ?? '{}') as { error?: { code?: string } }).error?.code ?? '';

beforeEach(async () => {
  applyEnv();
  chain = new FakeSolanaChain();
  h.chain.current = chain;
  h.ledger.rows = [];
  agent = Keypair.generate().publicKey;
  agentAta = chain.registerAta(agent, mintKp.publicKey, DECIMALS, 0n);
  chain.setBlockhash(Keypair.generate().publicKey.toBase58());
  app = await buildPayoutApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  restoreEnv();
  vi.clearAllMocks();
});

describe('T-AC8 — underfunded fails CLOSED with a distinguishable code', () => {
  it('★ T-AC8a: SPL balance below the amount → 503 PAYOUT_FUNDING_LOW, book unchanged', async () => {
    const opAta = chain.registerAta(operatorKp.publicKey, mintKp.publicKey, DECIMALS, AMOUNT - 1n);
    chain.setLamports(operatorKp.publicKey, 50_000_000n);
    const res = await post();
    expect(res?.statusCode).toBe(503);
    expect(code(res)).toBe('PAYOUT_FUNDING_LOW');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(opAta)).toBe(AMOUNT - 1n);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('★ T-AC8b: an RPC read failure → PAYOUT_RPC_UNAVAILABLE, NOT funding-low', async () => {
    chain.registerAta(operatorKp.publicKey, mintKp.publicKey, DECIMALS, 10_000_000n);
    chain.setLamports(operatorKp.publicKey, 50_000_000n);
    chain.failBalanceRead = true;
    const res = await post();
    expect(res?.statusCode).toBe(503);
    expect(code(res)).toBe('PAYOUT_RPC_UNAVAILABLE');
    expect(code(res)).not.toBe('PAYOUT_FUNDING_LOW');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });

  it('★ T-AC8c: SOL below the floor → 503 funding-low, book unchanged', async () => {
    chain.registerAta(operatorKp.publicKey, mintKp.publicKey, DECIMALS, 10_000_000n);
    chain.setLamports(operatorKp.publicKey, 1n); // below SOLANA_PAYOUT_MIN_SOL_LAMPORTS
    const res = await post();
    expect(res?.statusCode).toBe(503);
    expect(code(res)).toBe('PAYOUT_FUNDING_LOW');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('★ T-AC8d: NO source ATA → 503, and no create for the source is ever emitted', async () => {
    // The operator ATA is deliberately NOT registered.
    chain.setLamports(operatorKp.publicKey, 50_000_000n);
    const { deriveAta } = await import('../../chains/solana-escrow.js');
    const sourceAta = deriveAta(operatorKp.publicKey, mintKp.publicKey);
    expect(chain.hasAta(sourceAta)).toBe(false);

    const res = await post();
    expect(res?.statusCode).toBe(503);
    expect(code(res)).toBe('PAYOUT_FUNDING_LOW');
    // The source ATA STILL does not exist: no rent was spent to hide a no-funds.
    expect(chain.hasAta(sourceAta)).toBe(false);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('★ funding rejections never claim the intent (they are cheap, CD-17)', async () => {
    chain.setLamports(operatorKp.publicKey, 1n);
    await post();
    expect(h.ledger.rows).toHaveLength(0);
  });

  it('the positive control: fully funded → 200 (the scenarios above are real)', async () => {
    // Disarming the underfunding must turn this green; otherwise every 503 above
    // could be produced by an unrelated misconfiguration.
    chain.registerAta(operatorKp.publicKey, mintKp.publicKey, DECIMALS, 10_000_000n);
    chain.setLamports(operatorKp.publicKey, 50_000_000n);
    const res = await post();
    expect(res?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });
});
