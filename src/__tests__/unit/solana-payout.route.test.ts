/**
 * WKH-302 — POST /solana/payout end to end (T-AC1, T-I1-a, T-CD10, T-CD17, caps).
 *
 * The route runs through `app.inject()` against the `FakeSolanaChain` BALANCE BOOK
 * and an in-memory ledger. Every money assertion reads the book, never a call
 * counter: a counter cannot tell "did not pay" from "paid twice".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as Web3 from '@solana/web3.js';
import type * as SupabaseModule from '../../infra/supabase.js';

const h = vi.hoisted(() => ({
  chain: { current: null as unknown },
  ledger: { rows: [] as Record<string, unknown>[], down: false },
  rate: { current: { ok: true } as { ok: boolean; reason?: string } },
  daily: { current: { ok: true } as { ok: boolean; reason?: string } },
  released: { atomic: [] as bigint[] },
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
    getLatestBlockhash(commitment?: string) {
      return this.c.getLatestBlockhash(commitment);
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

// Minimal durable ledger: a real UNIQUE(caller,intent) barrier over an array.
vi.mock('../../infra/supabase.js', async (importActual) => ({
  ...(await importActual<typeof SupabaseModule>()),
  getSupabaseClient: () => {
    if (h.ledger.down) return null;
    return {
      // The audit hook writes through this SAME client, so the table name matters:
      // without this guard, audit rows would land in the payout ledger and every
      // "nothing was claimed" assertion would silently pass for the wrong reason.
      from: (table: string) => {
        if (table !== 'facilitator_solana_payouts') return noopTable();
        return {
          insert: (obj: Record<string, unknown>) => {
            const dup = h.ledger.rows.some(
              (r) => r.caller_key_id === obj.caller_key_id && r.intent_id === obj.intent_id,
            );
            if (dup) return Promise.resolve({ error: { code: '23505', message: 'dup' } });
            h.ledger.rows.push({
              ...obj,
              id: `r${h.ledger.rows.length + 1}`,
              signature: null,
              recent_blockhash: null,
              attempts: 1,
              claimed_at: new Date().toISOString(),
            });
            return Promise.resolve({ error: null });
          },
          update: (patch: Record<string, unknown>) =>
            chainFilters((rows) => {
              for (const r of rows) Object.assign(r, patch);
              return rows.map((r) => ({ id: r.id }));
            }),
          select: () => chainFilters((rows) => rows),
        };
      },
    };
  },
}));

/** Any table other than the payout ledger: accepts writes, records nothing. */
function noopTable() {
  const sink = {
    insert: () => Promise.resolve({ error: null }),
    update: () => sink,
    select: () => sink,
    eq: () => sink,
    lt: () => sink,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: undefined,
  };
  return sink;
}

type Pred = (r: Record<string, unknown>) => boolean;

function chainFilters(apply: (rows: Record<string, unknown>[]) => unknown, preds: Pred[] = []) {
  const run = () => h.ledger.rows.filter((r) => preds.every((p) => p(r)));
  return {
    eq: (col: string, value: unknown) =>
      chainFilters(apply, [...preds, (r) => readCol(r, col) === value]),
    lt: (col: string, value: unknown) =>
      chainFilters(apply, [...preds, (r) => String(readCol(r, col)) < String(value)]),
    select: () => Promise.resolve({ data: apply(run()), error: null }),
    maybeSingle: () => Promise.resolve({ data: run().at(0) ?? null, error: null }),
  };
}

function readCol(r: Record<string, unknown>, col: string): unknown {
  const map = new Map(Object.entries(r));
  return map.get(col);
}

vi.mock('../../core/solana-payout-cap.js', () => ({
  checkAndIncrPayoutRate: () => Promise.resolve(h.rate.current),
  checkAndIncrPayoutDailyAtomic: () => Promise.resolve(h.daily.current),
  releasePayoutDailyAtomic: (amount: bigint) => {
    h.released.atomic.push(amount);
    return Promise.resolve();
  },
}));

import { Keypair, type PublicKey } from '@solana/web3.js';
import { FakeSolanaChain } from './methods/solana-payout/fake-solana-chain.js';

const DECIMALS = 6;
const AMOUNT = 3_000_000n;
const OPERATOR_START = 10_000_000n;

const operatorKp = Keypair.generate();
const OPERATOR_KEY_JSON = JSON.stringify(Array.from(operatorKp.secretKey));
const mintKp = Keypair.generate();
const MINT = mintKp.publicKey.toBase58();

let chain: FakeSolanaChain;
let app: FastifyInstance | undefined;
let agent: PublicKey;
let agentAta: PublicKey;
let operatorAta: PublicKey;

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_PAYOUT_ENABLED',
  'SOLANA_PAYOUT_OPERATOR_SECRET_KEY',
  'SOLANA_PAYOUT_MAX_AMOUNT_ATOMIC',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
  'FACILITATOR_API_KEYS',
  'FACILITATOR_API_KEY',
];

function applyEnv(): void {
  for (const k of ENV_KEYS) savedEnv.set(k, readEnv(k));
  process.env.SOLANA_PAYOUT_ENABLED = 'true';
  process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = OPERATOR_KEY_JSON;
  process.env.SOLANA_RPC_URL = 'http://mock-devnet-rpc';
  process.env.SOLANA_USDC_MINT = MINT;
  process.env.FACILITATOR_API_KEY = 'test-facilitator-key';
  delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
}

function readEnv(k: string): string | undefined {
  return new Map(Object.entries(process.env)).get(k);
}

function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k as keyof NodeJS.ProcessEnv];
    else process.env[k as keyof NodeJS.ProcessEnv] = v;
  }
  savedEnv.clear();
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

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    intentId: 'run-1:0',
    payTo: agent.toBase58(),
    amountAtomic: AMOUNT.toString(),
    network: 'solana:devnet',
    ...overrides,
  });
}

const post = (body: string) =>
  app?.inject({
    method: 'POST',
    url: '/solana/payout',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-facilitator-key',
    },
    payload: body,
  });

beforeEach(async () => {
  applyEnv();
  chain = new FakeSolanaChain();
  h.chain.current = chain;
  h.ledger.rows = [];
  h.ledger.down = false;
  h.rate.current = { ok: true };
  h.daily.current = { ok: true };
  h.released.atomic = [];
  agent = Keypair.generate().publicKey;
  operatorAta = chain.registerAta(operatorKp.publicKey, mintKp.publicKey, DECIMALS, OPERATOR_START);
  agentAta = chain.registerAta(agent, mintKp.publicKey, DECIMALS, 0n);
  chain.setLamports(operatorKp.publicKey, 50_000_000n);
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

describe('T-AC1 — a valid payout moves exactly the requested amount, once', () => {
  it('★ 200 and the book moves EXACTLY amountAtomic, in both directions', async () => {
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}') as {
      signature: string;
      alreadySettled: boolean;
      amountAtomic: string;
      network: string;
    };
    expect(body.alreadySettled).toBe(false);
    expect(body.amountAtomic).toBe(AMOUNT.toString());
    expect(body.network).toBe('solana:devnet');

    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);

    // The returned signature is the one that actually moved the money.
    expect(chain.appliedSignatures).toEqual([body.signature]);
  });

  it('the ledger ends at confirmed, with the signature persisted', async () => {
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    const row = h.ledger.rows.at(0);
    expect(row?.status).toBe('confirmed');
    expect(typeof row?.signature).toBe('string');
    expect(typeof row?.recent_blockhash).toBe('string');
  });

  it('creates the destination ATA in the SAME tx when it does not exist yet', async () => {
    const fresh = Keypair.generate().publicKey;
    const res = await post(payload({ payTo: fresh.toBase58() }));
    expect(res?.statusCode).toBe(200);
    const { deriveAta } = await import('../../chains/solana-escrow.js');
    expect(chain.balanceOf(deriveAta(fresh, mintKp.publicKey))).toBe(AMOUNT);
  });
});

describe('T-I1-a — the ledger is a VETO: store down means nobody gets paid', () => {
  it('★ ledger unavailable → 500 PAYOUT_STORE_UNAVAILABLE and the book does NOT move', async () => {
    h.ledger.down = true;
    const res = await post(payload());
    expect(res?.statusCode).toBe(500);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('PAYOUT_STORE_UNAVAILABLE');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('a store failure RELEASES the daily reservation (no spend happened)', async () => {
    h.ledger.down = true;
    await post(payload());
    expect(h.released.atomic).toEqual([AMOUNT]);
  });
});

describe('T-CD10 — precision: the cap is compared as BigInt', () => {
  it('★ an amount above 2^53 over the cap is rejected (Number() would round it in)', async () => {
    // 9007199254740993 = 2^53 + 1. As a double it collapses onto 2^53, so a
    // Number()-based comparison against a cap of 2^53 would let it through.
    process.env.SOLANA_PAYOUT_MAX_AMOUNT_ATOMIC = '9007199254740992';
    if (app) await app.close();
    app = await buildPayoutApp();
    const res = await post(payload({ amountAtomic: '9007199254740993' }));
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('INVALID_AMOUNT');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });
});

describe('T-CAP-1 / T-CAP-2 — caps reject without moving the book', () => {
  it('★ over the per-payout cap → 400 INVALID_AMOUNT, book unchanged', async () => {
    const res = await post(payload({ amountAtomic: '999999999999' }));
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('INVALID_AMOUNT');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START);
  });

  it('★ rate store fail-closed → 429, book unchanged', async () => {
    h.rate.current = { ok: false, reason: 'store_error_failclosed' };
    const res = await post(payload());
    expect(res?.statusCode).toBe(429);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('PAYOUT_RATE_LIMITED');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });

  it('★ daily store fail-closed → 429 PAYOUT_DAILY_CAP, book unchanged', async () => {
    h.daily.current = { ok: false, reason: 'store_error_failclosed' };
    const res = await post(payload());
    expect(res?.statusCode).toBe(429);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('PAYOUT_DAILY_CAP');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('a cap rejection never even claims the intent', async () => {
    h.daily.current = { ok: false };
    await post(payload());
    expect(h.ledger.rows).toHaveLength(0);
  });
});

describe('T-CAP-3 — the reservation is kept only when the tx may have landed', () => {
  it('★ confirmación caída pero la cadena confirma el pago → 200 y el débito se CONSERVA', async () => {
    // Antes esto contestaba 502 "no pude confirmar". Ahora, tras un envío exitoso,
    // se consulta la firma persistida: la cadena dice que el pago está, así que el
    // fallo era de OBSERVACIÓN y no de dinero. La reserva se conserva igual, que es
    // lo que este test siempre quiso fijar (hubo gasto real).
    chain.dropConfirmation = true;
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(h.released.atomic).toEqual([]);
  });

  it('★ BROADCAST_EXPIRED PRE-ENVÍO (never landed) → the daily reservation is RELEASED', async () => {
    // Este caso entra por el camino donde el veredicto SÍ es cierto: el blockhash
    // muere ANTES de cualquier send, así que nada se transmitió.
    chain.expireBlockhash();
    const res = await post(payload());
    expect(res?.statusCode).toBe(409);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('PAYOUT_BROADCAST_EXPIRED');
    expect(h.released.atomic).toEqual([AMOUNT]);
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.appliedSignatures).toHaveLength(0); // nada salió a la red
  });

  // ── AR BLQ-1 — reproducción: el agente COBRA y la ruta contestaba "no se gastó" ──
  it('★ BLQ-1: el cluster acepta la tx, la confirmación se cae y el blockhash rota', async () => {
    // Éste es el camino POST-ENVÍO, que el test de arriba nunca tocaba: la sonda de
    // frescura falla DESPUÉS de un sendRawTransaction exitoso, y su catch significa
    // "no pude preguntar", no "el blockhash venció".
    chain.dropConfirmation = true; // la confirmación se cae (websocket)
    chain.failBlockhashProbeAfterSend = true; // y la sonda posterior no contesta
    chain.failTxLookup = true; // el nodo tampoco contesta el verify ⇒ no sé
    const res = await post(payload());

    // El agente COBRÓ: eso es lo que mide el libro.
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);

    // Por lo tanto la respuesta NO puede afirmar que no se gastó.
    const code = JSON.parse(res?.body ?? '{}').error?.code;
    expect(code).not.toBe('PAYOUT_BROADCAST_EXPIRED');
    expect(res?.statusCode).toBe(502);
    expect(code).toBe('PAYOUT_BROADCAST_UNKNOWN');

    // Y la reserva del tope diario se CONSERVA: hubo gasto real.
    expect(h.released.atomic).toEqual([]);
  });

  it('★ BLQ-1: si la firma persistida SÍ verifica on-chain, la respuesta es 200', async () => {
    // La evidencia existía (invariante I2 la dejó en el ledger) y antes nadie la
    // consultaba. Ahora se consulta antes de emitir un veredicto.
    chain.failBlockhashProbeAfterSend = true;
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.alreadySettled).toBe(false);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.appliedSignatures).toEqual([body.signature]);
    expect(h.released.atomic).toEqual([]); // hubo gasto: la reserva se conserva
  });
});

describe('T-CD17 — a cheap rejection must NOT burn the intentId', () => {
  it('★ rejected for balance, then retried with funds → PAYS (no 409)', async () => {
    // Round 1: the operator cannot cover it.
    const poorChain = new FakeSolanaChain();
    const poorOperatorAta = poorChain.registerAta(
      operatorKp.publicKey,
      mintKp.publicKey,
      DECIMALS,
      1n,
    );
    poorChain.registerAta(agent, mintKp.publicKey, DECIMALS, 0n);
    poorChain.setLamports(operatorKp.publicKey, 50_000_000n);
    poorChain.setBlockhash(Keypair.generate().publicKey.toBase58());
    h.chain.current = poorChain;

    const first = await post(payload());
    expect(first?.statusCode).toBe(503);
    expect(JSON.parse(first?.body ?? '{}').error.code).toBe('PAYOUT_FUNDING_LOW');
    // The intent was NOT claimed — that is the whole point of the gate order.
    expect(h.ledger.rows).toHaveLength(0);
    expect(poorChain.balanceOf(poorOperatorAta)).toBe(1n);

    // Round 2: same intentId, now funded.
    h.chain.current = chain;
    const second = await post(payload());
    expect(second?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });
});

describe('auth, payload and cluster gates', () => {
  it('no bearer → 401 and nothing is claimed', async () => {
    const res = await app?.inject({
      method: 'POST',
      url: '/solana/payout',
      headers: { 'content-type': 'application/json' },
      payload: payload(),
    });
    expect(res?.statusCode).toBe(401);
    expect(h.ledger.rows).toHaveLength(0);
  });

  it('malformed body → 400 INVALID_PAYLOAD', async () => {
    const res = await post(JSON.stringify({ intentId: '', payTo: 'x', amountAtomic: '0' }));
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('INVALID_PAYLOAD');
  });

  it('★ amountAtomic with a leading zero is rejected by the schema', async () => {
    const res = await post(payload({ amountAtomic: '0300' }));
    expect(res?.statusCode).toBe(400);
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });

  it('★ mainnet request against a devnet cluster → 400 NETWORK_MISMATCH', async () => {
    const res = await post(payload({ network: 'solana:mainnet' }));
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '{}').error.code).toBe('NETWORK_MISMATCH');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });
});
