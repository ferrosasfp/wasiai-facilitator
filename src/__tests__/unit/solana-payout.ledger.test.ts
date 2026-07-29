/**
 * WKH-302 — durable payout ledger (T-CD7 + fail-CLOSED contract).
 *
 * Strategy: instead of asserting on call spies, this suite runs the ledger against
 * an IN-MEMORY TABLE that enforces the real constraints — `UNIQUE(caller_key_id,
 * intent_id)` (raising a genuine 23505) and filter evaluation AT APPLY TIME. That
 * makes the concurrency assertions mean something: a conditional `UPDATE` can have
 * exactly one winner, while a read-then-write implementation lets both through.
 *
 * The store injects latency BEFORE evaluating each operation's filter, so two
 * concurrent calls genuinely interleave their start.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  caller_key_id: string;
  intent_id: string;
  network: string;
  pay_to: string;
  mint: string;
  amount_atomic: string;
  status: string;
  signature: string | null;
  recent_blockhash: string | null;
  attempts: number;
  claimed_at: string;
  confirmed_at: string | null;
}

type Filter = { op: 'eq' | 'lt'; col: string; value: unknown };

/** In-memory stand-in for `facilitator_solana_payouts`. */
class FakeTable {
  rows: Row[] = [];
  /** Latency applied before each operation evaluates its filters. */
  latencyMs = 0;
  /** When set, every operation resolves with this PostgREST-shaped error. */
  errorMode: { code?: string; message: string } | null = null;
  /** When true, every operation throws (network-level failure). */
  throwMode = false;
  private _seq = 0;

  private async _gate(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
    if (this.throwMode) throw new Error('network down');
  }

  private _match(row: Row, filters: readonly Filter[]): boolean {
    return filters.every((f) => {
      const actual = readColumn(row, f.col);
      if (f.op === 'eq') return actual === f.value;
      return String(actual) < String(f.value);
    });
  }

  async insert(obj: Record<string, unknown>): Promise<{ error: unknown }> {
    await this._gate();
    if (this.errorMode) return { error: this.errorMode };
    const callerKeyId = String(obj.caller_key_id);
    const intentId = String(obj.intent_id);
    if (this.rows.some((r) => r.caller_key_id === callerKeyId && r.intent_id === intentId)) {
      return {
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      };
    }
    this._seq += 1;
    this.rows.push({
      id: `row-${this._seq}`,
      caller_key_id: callerKeyId,
      intent_id: intentId,
      network: String(obj.network),
      pay_to: String(obj.pay_to),
      mint: String(obj.mint),
      amount_atomic: String(obj.amount_atomic),
      status: String(obj.status ?? 'claimed'),
      signature: null,
      recent_blockhash: null,
      attempts: 1,
      claimed_at: new Date().toISOString(),
      confirmed_at: null,
    });
    return { error: null };
  }

  async update(
    patch: Record<string, unknown>,
    filters: readonly Filter[],
  ): Promise<{ data: unknown; error: unknown }> {
    await this._gate();
    if (this.errorMode) return { data: null, error: this.errorMode };
    // Filter evaluation + mutation happen TOGETHER, after the await — exactly like
    // a single conditional UPDATE in Postgres.
    const matched = this.rows.filter((r) => this._match(r, filters));
    for (const row of matched) {
      for (const [col, value] of Object.entries(patch)) writeColumn(row, col, value);
    }
    return { data: matched.map((r) => ({ id: r.id })), error: null };
  }

  async selectOne(filters: readonly Filter[]): Promise<{ data: unknown; error: unknown }> {
    await this._gate();
    if (this.errorMode) return { data: null, error: this.errorMode };
    const found = this.rows.find((r) => this._match(r, filters));
    return { data: found === undefined ? null : { ...found }, error: null };
  }
}

/** Column access without dynamic indexing (security/detect-object-injection). */
function readColumn(row: Row, col: string): unknown {
  switch (col) {
    case 'caller_key_id':
      return row.caller_key_id;
    case 'intent_id':
      return row.intent_id;
    case 'status':
      return row.status;
    case 'signature':
      return row.signature;
    case 'claimed_at':
      return row.claimed_at;
    default:
      return undefined;
  }
}

function writeColumn(row: Row, col: string, value: unknown): void {
  switch (col) {
    case 'status':
      row.status = String(value);
      break;
    case 'signature':
      row.signature = value === null ? null : String(value);
      break;
    case 'recent_blockhash':
      row.recent_blockhash = value === null ? null : String(value);
      break;
    case 'claimed_at':
      row.claimed_at = String(value);
      break;
    case 'confirmed_at':
      row.confirmed_at = value === null ? null : String(value);
      break;
    default:
      break;
  }
}

const h = vi.hoisted(() => ({ table: { current: null as unknown }, nullClient: { on: false } }));

vi.mock('../../infra/supabase.js', () => ({
  getSupabaseClient: () => {
    if (h.nullClient.on) return null;
    const table = h.table.current as FakeTable;
    return {
      from: () => ({
        insert: (obj: Record<string, unknown>) => table.insert(obj),
        update: (patch: Record<string, unknown>) => makeFilterChain(table, patch),
        select: () => makeSelectChain(table),
      }),
    };
  },
}));

/** `.update(patch).eq().eq().lt()....select('id')` */
function makeFilterChain(
  table: FakeTable,
  patch: Record<string, unknown>,
  filters: Filter[] = [],
): {
  eq: (col: string, value: unknown) => ReturnType<typeof makeFilterChain>;
  lt: (col: string, value: unknown) => ReturnType<typeof makeFilterChain>;
  select: (cols?: string) => Promise<{ data: unknown; error: unknown }>;
} {
  return {
    eq: (col, value) => makeFilterChain(table, patch, [...filters, { op: 'eq', col, value }]),
    lt: (col, value) => makeFilterChain(table, patch, [...filters, { op: 'lt', col, value }]),
    select: () => table.update(patch, filters),
  };
}

/** `.select(cols).eq().eq().maybeSingle()` */
function makeSelectChain(
  table: FakeTable,
  filters: Filter[] = [],
): {
  eq: (col: string, value: unknown) => ReturnType<typeof makeSelectChain>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
} {
  return {
    eq: (col, value) => makeSelectChain(table, [...filters, { op: 'eq', col, value }]),
    maybeSingle: () => table.selectOne(filters),
  };
}

import {
  claimPayout,
  markConfirmed,
  markSigned,
  readPayout,
  revertSignedToClaimed,
  stealStaleClaim,
  type PayoutIntent,
} from '../../infra/solana-payout-ledger.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

const INTENT: PayoutIntent = {
  callerKeyId: 'caller-abc',
  intentId: 'run-1:0',
  network: 'solana:devnet',
  payTo: 'PayTo1111111111111111111111111111111111111',
  mint: 'Mint11111111111111111111111111111111111111',
  amountAtomic: '3000000',
};

let table: FakeTable;

beforeEach(() => {
  table = new FakeTable();
  h.table.current = table;
  h.nullClient.on = false;
  logger.warn.mockReset();
  logger.debug.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('claimPayout — the at-most-once barrier', () => {
  it('first claim wins the INSERT', async () => {
    const r = await claimPayout(INTENT, logger);
    expect(r).toEqual({ ok: true, claimed: true });
    expect(table.rows).toHaveLength(1);
    expect(table.rows.at(0)?.status).toBe('claimed');
  });

  it('★ second claim hits 23505 and returns the EXISTING row, not a new one', async () => {
    await claimPayout(INTENT, logger);
    const r = await claimPayout(INTENT, logger);
    expect(r.ok).toBe(true);
    if (r.ok && !r.claimed) {
      expect(r.row.status).toBe('claimed');
      expect(r.row.amountAtomic).toBe('3000000');
      expect(r.row.signature).toBeNull();
    } else {
      expect.unreachable('the second claim must lose the race');
    }
    expect(table.rows).toHaveLength(1); // no duplicate row was created
  });

  it('★ a DIFFERENT caller may use the same intentId (partition by caller)', async () => {
    await claimPayout(INTENT, logger);
    const other = await claimPayout({ ...INTENT, callerKeyId: 'caller-xyz' }, logger);
    expect(other).toEqual({ ok: true, claimed: true });
    expect(table.rows).toHaveLength(2);
  });

  it('★ N concurrent claims → exactly ONE winner', async () => {
    table.latencyMs = 2;
    const results = await Promise.all(Array.from({ length: 5 }, () => claimPayout(INTENT, logger)));
    const winners = results.filter((r) => r.ok && r.claimed);
    expect(winners).toHaveLength(1);
    expect(table.rows).toHaveLength(1);
  });

  it('★ null client → { ok:false } (FAIL-CLOSED), never a silent accept', async () => {
    h.nullClient.on = true;
    expect(await claimPayout(INTENT, logger)).toEqual({ ok: false });
  });

  it('★ store error → { ok:false } (FAIL-CLOSED)', async () => {
    table.errorMode = { code: '08006', message: 'connection failure' };
    expect(await claimPayout(INTENT, logger)).toEqual({ ok: false });
  });

  it('★ store throws → { ok:false } (FAIL-CLOSED)', async () => {
    table.throwMode = true;
    expect(await claimPayout(INTENT, logger)).toEqual({ ok: false });
  });
});

describe('T-CD7 — every transition is ONE conditional write', () => {
  it('★ two concurrent stealStaleClaim → exactly one returns stolen:true', async () => {
    await claimPayout(INTENT, logger);
    // Age the claim past the lease.
    const row = table.rows.at(0);
    expect(row).toBeDefined();
    if (row) row.claimed_at = new Date(Date.now() - 60_000).toISOString();

    table.latencyMs = 2;
    const [a, b] = await Promise.all([
      stealStaleClaim(INTENT, 1000, logger),
      stealStaleClaim(INTENT, 1000, logger),
    ]);
    const stolen = [a, b].filter((r) => r.stolen);
    expect(stolen).toHaveLength(1);
  });

  it('a claim YOUNGER than the lease cannot be stolen', async () => {
    await claimPayout(INTENT, logger);
    const r = await stealStaleClaim(INTENT, 60_000, logger);
    expect(r).toEqual({ ok: true, stolen: false });
  });

  it('the steal RENEWS the lease (a third request cannot steal right after)', async () => {
    await claimPayout(INTENT, logger);
    const row = table.rows.at(0);
    if (row) row.claimed_at = new Date(Date.now() - 60_000).toISOString();
    expect((await stealStaleClaim(INTENT, 1000, logger)).stolen).toBe(true);
    expect((await stealStaleClaim(INTENT, 1000, logger)).stolen).toBe(false);
  });

  it('★ a SIGNED row is never stolen by stealStaleClaim (guarded on status)', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_1', 'BLOCKHASH_1', logger);
    const row = table.rows.at(0);
    if (row) row.claimed_at = new Date(Date.now() - 60_000).toISOString();
    expect((await stealStaleClaim(INTENT, 1000, logger)).stolen).toBe(false);
  });

  it('★ two concurrent markSigned → exactly one wins (guarded on status=claimed)', async () => {
    await claimPayout(INTENT, logger);
    table.latencyMs = 2;
    const [a, b] = await Promise.all([
      markSigned(INTENT, 'SIG_A', 'BH_A', logger),
      markSigned(INTENT, 'SIG_B', 'BH_B', logger),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('markSigned persists signature AND blockhash together (invariant I2)', async () => {
    await claimPayout(INTENT, logger);
    expect(await markSigned(INTENT, 'SIG_1', 'BLOCKHASH_1', logger)).toEqual({ ok: true });
    const row = table.rows.at(0);
    expect(row?.status).toBe('signed');
    expect(row?.signature).toBe('SIG_1');
    expect(row?.recent_blockhash).toBe('BLOCKHASH_1');
  });

  it('markSigned on a non-claimed row → { ok:false } (no clobbering)', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_1', 'BH_1', logger);
    expect(await markSigned(INTENT, 'SIG_2', 'BH_2', logger)).toEqual({ ok: false });
    expect(table.rows.at(0)?.signature).toBe('SIG_1');
  });

  it('★ markSigned fail-closed on a store error (so the route must not broadcast)', async () => {
    await claimPayout(INTENT, logger);
    table.errorMode = { message: 'boom' };
    expect(await markSigned(INTENT, 'SIG_1', 'BH_1', logger)).toEqual({ ok: false });
  });

  it('markConfirmed is keyed on the SIGNATURE, not on the previous status', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_1', 'BH_1', logger);
    expect(await markConfirmed(INTENT, 'SIG_1', logger)).toEqual({ ok: true });
    expect(table.rows.at(0)?.status).toBe('confirmed');
    // A different attempt's signature must NOT be able to confirm this row.
    expect(await markConfirmed(INTENT, 'SIG_OTHER', logger)).toEqual({ ok: false });
  });
});

describe('revertSignedToClaimed — §6.5 dead-blockhash re-sign path', () => {
  it('reverts a signed row and clears the dead signature', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_DEAD', 'BH_DEAD', logger);
    const r = await revertSignedToClaimed(INTENT, 'SIG_DEAD', logger);
    expect(r).toEqual({ ok: true, reverted: true });
    const row = table.rows.at(0);
    expect(row?.status).toBe('claimed');
    expect(row?.signature).toBeNull();
    expect(row?.recent_blockhash).toBeNull();
  });

  it('★ refuses to revert with a signature that is not the recorded one', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_REAL', 'BH_1', logger);
    expect(await revertSignedToClaimed(INTENT, 'SIG_WRONG', logger)).toEqual({
      ok: true,
      reverted: false,
    });
    expect(table.rows.at(0)?.status).toBe('signed');
  });

  it('★ two concurrent reverts → exactly one wins', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_DEAD', 'BH_DEAD', logger);
    table.latencyMs = 2;
    const [a, b] = await Promise.all([
      revertSignedToClaimed(INTENT, 'SIG_DEAD', logger),
      revertSignedToClaimed(INTENT, 'SIG_DEAD', logger),
    ]);
    expect([a.reverted, b.reverted].filter(Boolean)).toHaveLength(1);
  });

  it('a CONFIRMED row is never reverted', async () => {
    await claimPayout(INTENT, logger);
    await markSigned(INTENT, 'SIG_1', 'BH_1', logger);
    await markConfirmed(INTENT, 'SIG_1', logger);
    expect((await revertSignedToClaimed(INTENT, 'SIG_1', logger)).reverted).toBe(false);
  });
});

describe('readPayout — classification only, fail-closed', () => {
  it('returns the row with amountAtomic as a STRING (CD-10)', async () => {
    const big = '9007199254740993'; // 2^53 + 1 — unrepresentable as a JS number
    await claimPayout({ ...INTENT, amountAtomic: big }, logger);
    const r = await readPayout({ ...INTENT, amountAtomic: big }, logger);
    expect(r.ok).toBe(true);
    expect(r.row?.amountAtomic).toBe(big);
    expect(BigInt(r.row?.amountAtomic ?? '0')).toBe(BigInt(big));
  });

  it('missing row → ok with no row (absence is not an error)', async () => {
    const r = await readPayout(INTENT, logger);
    expect(r.ok).toBe(true);
    expect(r.row).toBeUndefined();
  });

  it('★ null client → { ok:false } (FAIL-CLOSED)', async () => {
    h.nullClient.on = true;
    expect((await readPayout(INTENT, logger)).ok).toBe(false);
  });

  it('★ store error → { ok:false } (FAIL-CLOSED)', async () => {
    table.errorMode = { message: 'boom' };
    expect((await readPayout(INTENT, logger)).ok).toBe(false);
  });
});
