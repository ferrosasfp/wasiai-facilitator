/**
 * WKH-302 — replay, conflict and concurrency (T-AC5a..d, T-AC9, T-I1-b, T-I2, T-CONC).
 *
 * Same wiring as `solana-payout.route.test.ts`: real route over the balance book +
 * an in-memory ledger with a genuine UNIQUE(caller,intent) barrier. Every assertion
 * about "did not pay twice" reads the BOOK — a call counter cannot distinguish
 * "never paid" from "paid twice and one reverted".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as Web3 from '@solana/web3.js';
import type * as SupabaseModule from '../../infra/supabase.js';

const h = vi.hoisted(() => ({
  chain: { current: null as unknown },
  ledger: {
    rows: [] as Record<string, unknown>[],
    down: false,
    failUpdates: false,
    /** INSERT throws (transient/network) while UPDATEs keep working. */
    insertThrows: false,
  },
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

vi.mock('../../infra/supabase.js', async (importActual) => ({
  ...(await importActual<typeof SupabaseModule>()),
  getSupabaseClient: () => {
    if (h.ledger.down) return null;
    return {
      from: (table: string) => {
        if (table !== 'facilitator_solana_payouts') return noopTable();
        return {
          insert: (obj: Record<string, unknown>) => {
            if (h.ledger.insertThrows) return Promise.reject(new Error('connection reset'));
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
              // `failUpdates` models a conditional UPDATE that matched nothing (or
              // a store that refuses writes): the ledger reports "did not apply".
              if (h.ledger.failUpdates) return [];
              for (const r of rows) Object.assign(r, patch);
              return rows.map((r) => ({ id: r.id }));
            }),
          select: () => chainFilters((rows) => rows),
        };
      },
    };
  },
}));

function noopTable() {
  const sink = {
    insert: () => Promise.resolve({ error: null }),
    update: () => sink,
    select: () => sink,
    eq: () => sink,
    lt: () => sink,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
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
  return new Map(Object.entries(r)).get(col);
}

vi.mock('../../core/solana-payout-cap.js', () => ({
  checkAndIncrPayoutRate: () => Promise.resolve({ ok: true }),
  checkAndIncrPayoutDailyAtomic: () => Promise.resolve({ ok: true }),
  releasePayoutDailyAtomic: () => Promise.resolve(),
}));

import { createHash } from 'node:crypto';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { FakeSolanaChain } from './methods/solana-payout/fake-solana-chain.js';

const API_KEY = 'test-facilitator-key';
const DECIMALS = 6;
const AMOUNT = 3_000_000n;
const OPERATOR_START = 10_000_000n;

const operatorKp = Keypair.generate();
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
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
  'FACILITATOR_API_KEY',
];

function applyEnv(): void {
  const env = new Map(Object.entries(process.env));
  for (const k of ENV_KEYS) savedEnv.set(k, env.get(k));
  process.env.SOLANA_PAYOUT_ENABLED = 'true';
  process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = JSON.stringify(Array.from(operatorKp.secretKey));
  process.env.SOLANA_RPC_URL = 'http://mock-devnet-rpc';
  process.env.SOLANA_USDC_MINT = MINT;
  process.env.FACILITATOR_API_KEY = 'test-facilitator-key';
  delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
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

const errorCode = (res: { body: string } | undefined): string =>
  (JSON.parse(res?.body ?? '{}') as { error?: { code?: string } }).error?.code ?? '';

beforeEach(async () => {
  applyEnv();
  chain = new FakeSolanaChain();
  h.chain.current = chain;
  h.ledger.rows = [];
  h.ledger.down = false;
  h.ledger.failUpdates = false;
  h.ledger.insertThrows = false;
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

describe('T-AC5 — replay returns the previous signature, never a second payment', () => {
  it('★ T-AC5a: a 2nd POST after confirmed does NOT raise the balance again', async () => {
    const first = await post(payload());
    expect(first?.statusCode).toBe(200);
    const firstSig = (JSON.parse(first?.body ?? '{}') as { signature: string }).signature;
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);

    const second = await post(payload());
    expect(second?.statusCode).toBe(200);
    const body = JSON.parse(second?.body ?? '{}') as {
      signature: string;
      alreadySettled: boolean;
    };
    expect(body.alreadySettled).toBe(true);
    expect(body.signature).toBe(firstSig);

    // THE assertion: the money moved exactly once.
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });

  it('★ T-AC5b: a recorded signature the chain does NOT back is not replayed as valid', async () => {
    // A row claiming a payment that never credited the agent (fabricated, or a tx
    // that failed): verify-before-trust must refuse to hand it back as settled.
    h.ledger.rows.push({
      caller_key_id: knownKeyId(),
      intent_id: 'run-1:0',
      network: 'solana:devnet',
      pay_to: agent.toBase58(),
      mint: MINT,
      amount_atomic: AMOUNT.toString(),
      status: 'confirmed',
      signature: 'SignatureThatNeverLanded1111111111111111111',
      recent_blockhash: null,
      attempts: 1,
      claimed_at: new Date().toISOString(),
    });
    const res = await post(payload());
    expect(res?.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PAYOUT_IN_PROGRESS');
    expect(res?.body).not.toContain('SignatureThatNeverLanded');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });

  it('★ T-AC5c: crash after signing + DEAD blockhash → retry re-signs, pays ONCE in total', async () => {
    chain.crashAfterSign = true;
    const first = await post(payload());
    expect(first?.statusCode).toBe(502); // broadcast could not be confirmed
    // I2: the row is `signed`, with signature + blockhash persisted BEFORE any send.
    const row = h.ledger.rows.at(0);
    expect(row?.status).toBe('signed');
    expect(typeof row?.signature).toBe('string');
    expect(typeof row?.recent_blockhash).toBe('string');
    expect(chain.balanceOf(agentAta)).toBe(0n); // nothing moved

    // Time passes: the signed tx's blockhash dies (so it can NEVER land) and the
    // cluster starts offering a fresh one. Now re-signing is safe, and required.
    chain.crashAfterSign = false;
    chain.rotateBlockhash(Keypair.generate().publicKey.toBase58());

    const second = await post(payload());
    expect(second?.statusCode).toBe(200);

    // EXACTLY ONE payment across both attempts.
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });

  it('★ T-AC5d: signed + blockhash STILL valid → 409 IN_PROGRESS, book unchanged', async () => {
    chain.crashAfterSign = true;
    await post(payload());
    expect(h.ledger.rows.at(0)?.status).toBe('signed');

    // The blockhash is still valid: that tx may yet land, so we must NOT re-sign.
    chain.crashAfterSign = false;
    const res = await post(payload());
    expect(res?.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PAYOUT_IN_PROGRESS');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.appliedSignatures).toHaveLength(0);
  });
});

describe('AR BLQ-2 — un RPC que no contesta NO autoriza re-firmar', () => {
  it('★ pago hecho + verify que no puede mirar + blockhash muerto ⇒ NO se paga dos veces', async () => {
    // Ronda 1: se paga de verdad, la confirmación no llega Y el nodo tampoco puede
    // confirmar la firma, así que la fila queda en `signed` (no `confirmed`) con la
    // firma persistida — que es EXACTAMENTE el estado del ledger que reportó el AR.
    //
    // ⚠️ Este detalle es el que hace válida la reproducción: si la ronda 1 dejara la
    // fila en `confirmed`, la rama de `confirmed` atajaría el caso y el bug quedaría
    // enmascarado. Verificado con la mutación: con la fila `confirmed` el mutante
    // sobrevive; con la fila `signed` muere.
    chain.dropConfirmation = true;
    chain.failBlockhashProbeAfterSend = true;
    chain.failTxLookup = true;
    const first = await post(payload());
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT); // el agente YA cobró
    expect(h.ledger.rows.at(0)?.status).toBe('signed');
    const firstSignature = String(h.ledger.rows.at(0)?.signature ?? '');
    expect(firstSignature.length).toBeGreaterThan(0);
    expect(first?.statusCode).toBeDefined();

    // Ronda 2: el nodo no puede contestar por esa firma ("no pude mirar"), y el
    // blockhash viejo está muerto. Antes: verify → valid:false → revert → re-firma
    // → DOBLE PAGO. Un blockhash vencido prueba que esa tx no puede entrar DE ACÁ
    // EN ADELANTE, no que no haya entrado antes.
    chain.dropConfirmation = false;
    chain.failBlockhashProbeAfterSend = false;
    // failTxLookup sigue en true: el nodo no puede decir si esa firma aterrizó.
    chain.rotateBlockhash(Keypair.generate().publicKey.toBase58());

    const second = await post(payload());

    // LA aserción, contra el libro: el saldo NO se duplicó.
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
    expect(second?.statusCode).toBe(409);
    expect(errorCode(second)).toBe('PAYOUT_IN_PROGRESS');
    // Y la evidencia del primer pago sigue en el ledger (el revert la borraba).
    expect(String(h.ledger.rows.at(0)?.signature ?? '')).toBe(firstSignature);
  });

  it('control: con el verify SANO el reintento devuelve la firma previa, no un pago nuevo', async () => {
    // Desarmar el escenario tiene que cambiar el resultado: si el nodo SÍ contesta,
    // la maquinaria de replay funciona y responde alreadySettled.
    chain.dropConfirmation = true;
    chain.failBlockhashProbeAfterSend = true;
    await post(payload());
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);

    chain.dropConfirmation = false;
    chain.failBlockhashProbeAfterSend = false;
    chain.rotateBlockhash(Keypair.generate().publicKey.toBase58());

    const second = await post(payload());
    expect(second?.statusCode).toBe(200);
    expect(JSON.parse(second?.body ?? '{}').alreadySettled).toBe(true);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });

  it('★ una negativa DEMOSTRADA por la cadena sí permite re-firmar (una sola vez)', async () => {
    // El complemento: si la cadena RESPONDE que ese pago no está y el blockhash
    // está muerto, re-firmar es correcto — si no, el fix bloquearía retries válidos.
    chain.crashAfterSign = true; // firma persistida, nada transmitido
    await post(payload());
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(h.ledger.rows.at(0)?.status).toBe('signed');

    chain.crashAfterSign = false;
    chain.rotateBlockhash(Keypair.generate().publicKey.toBase58());
    const second = await post(payload());

    expect(second?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });
});

describe('T-AC9 — same intentId, different terms → conflict, no signature, no movement', () => {
  it('★ different payTo → 409 PAYOUT_INTENT_CONFLICT', async () => {
    const first = await post(payload());
    expect(first?.statusCode).toBe(200);
    const attacker = Keypair.generate().publicKey;

    const res = await post(payload({ payTo: attacker.toBase58() }));
    expect(res?.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PAYOUT_INTENT_CONFLICT');
    // Neither a new payment nor the previous signature handed back.
    expect(res?.body).not.toContain('signature');
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });

  it('★ different amount → 409 PAYOUT_INTENT_CONFLICT', async () => {
    await post(payload());
    const res = await post(payload({ amountAtomic: '1' }));
    expect(res?.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PAYOUT_INTENT_CONFLICT');
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });

  it('★ conflict is checked BEFORE the replay path (a claimed row also conflicts)', async () => {
    chain.crashAfterSign = true;
    await post(payload());
    chain.crashAfterSign = false;
    const res = await post(payload({ amountAtomic: '1' }));
    expect(errorCode(res)).toBe('PAYOUT_INTENT_CONFLICT');
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });
});

describe('T-I1-b / T-CONC — a young claim never proceeds to sign', () => {
  it('★ T-I1-b: a 23505 over a YOUNG claimed row does not sign', async () => {
    h.ledger.rows.push({
      caller_key_id: knownKeyId(),
      intent_id: 'run-1:0',
      network: 'solana:devnet',
      pay_to: agent.toBase58(),
      mint: MINT,
      amount_atomic: AMOUNT.toString(),
      status: 'claimed',
      signature: null,
      recent_blockhash: null,
      attempts: 1,
      claimed_at: new Date().toISOString(), // fresh → inside the lease
    });
    const res = await post(payload());
    expect(res?.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PAYOUT_IN_PROGRESS');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('★ T-CONC: 4 concurrent requests, same intentId → the book moves ONCE', async () => {
    const results = await Promise.all([
      post(payload()),
      post(payload()),
      post(payload()),
      post(payload()),
    ]);
    const codes = results.map((r) => r?.statusCode);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    // Whatever the mix of 200/409, the money moved exactly once.
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START - AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
    expect(h.ledger.rows).toHaveLength(1);
  });

  it('a STALE claim (past the lease) is taken over and pays exactly once', async () => {
    h.ledger.rows.push({
      caller_key_id: knownKeyId(),
      intent_id: 'run-1:0',
      network: 'solana:devnet',
      pay_to: agent.toBase58(),
      mint: MINT,
      amount_atomic: AMOUNT.toString(),
      status: 'claimed',
      signature: null,
      recent_blockhash: null,
      attempts: 1,
      claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.appliedSignatures).toHaveLength(1);
  });
});

describe('T-I1-a (money level) — a failed CLAIM can never become a payment', () => {
  it('★ INSERT throws while a claim already exists → 500, and the book does NOT move', async () => {
    // Why this scenario and not just "the store is down": with the whole store
    // down, markSigned also fails and invariant I2 blocks the broadcast anyway, so
    // a fail-OPEN claim is invisible. The harmful shape is a claim that fails while
    // UPDATEs still work AND a `claimed` row already exists — then a fail-open claim
    // would sign, markSigned would find that row, and the payout would go out while
    // another request holds the intent. That is the double-payment this guard stops.
    h.ledger.rows.push({
      caller_key_id: knownKeyId(),
      intent_id: 'run-1:0',
      network: 'solana:devnet',
      pay_to: agent.toBase58(),
      mint: MINT,
      amount_atomic: AMOUNT.toString(),
      status: 'claimed',
      signature: null,
      recent_blockhash: null,
      attempts: 1,
      claimed_at: new Date().toISOString(),
    });
    h.ledger.insertThrows = true;

    const res = await post(payload());
    expect(res?.statusCode).toBe(500);
    expect(errorCode(res)).toBe('PAYOUT_STORE_UNAVAILABLE');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('the control: with the INSERT working, that same request pays exactly once', async () => {
    h.ledger.insertThrows = false;
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });
});

describe('T-I2 — the signature is persisted BEFORE the broadcast, or there is no broadcast', () => {
  it('★ markSigned cannot apply → NOTHING is broadcast and the book does not move', async () => {
    // The claim succeeds and the tx gets signed, but the ledger cannot record the
    // signature. Broadcasting anyway would leave a payment we could never attribute
    // to this intent — a retry would not know whether it had already paid.
    h.ledger.failUpdates = true;
    const res = await post(payload());
    expect(res?.statusCode).toBe(500);
    expect(errorCode(res)).toBe('PAYOUT_STORE_UNAVAILABLE');
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(operatorAta)).toBe(OPERATOR_START);
    expect(chain.appliedSignatures).toHaveLength(0);
  });

  it('the control: with updates working, the very same request pays', async () => {
    // Disarming the failure must turn this green — otherwise the assertion above
    // could be passing because of an unrelated rejection earlier in the chain.
    h.ledger.failUpdates = false;
    const res = await post(payload());
    expect(res?.statusCode).toBe(200);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });

  it('★ on a crash after signing, the row already carries signature AND blockhash', async () => {
    chain.crashAfterSign = true;
    await post(payload());
    const row = h.ledger.rows.at(0);
    expect(row?.status).toBe('signed');
    expect(typeof row?.signature).toBe('string');
    expect(typeof row?.recent_blockhash).toBe('string');
    // ...and nothing was ever transmitted, which is what makes that row readable
    // as "a signature exists, no payment does".
    expect(chain.appliedSignatures).toHaveLength(0);
    expect(chain.balanceOf(agentAta)).toBe(0n);
  });
});

/**
 * The caller id the auth middleware derives from our bearer
 * (`src/middleware/auth.ts` — sha256 hex, first 16 chars). Hand-seeded rows MUST
 * carry it: with a different id they would not collide with the request's INSERT,
 * and the test would silently exercise the "fresh intent" path instead of the
 * replay path it claims to test.
 */
function knownKeyId(): string {
  return createHash('sha256').update(API_KEY).digest('hex').slice(0, 16);
}
