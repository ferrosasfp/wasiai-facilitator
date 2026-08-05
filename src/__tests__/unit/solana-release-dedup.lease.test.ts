/**
 * Lease del claim de escrow release (`facilitator_solana_release_claims`).
 *
 * Estrategia (misma que solana-payout.ledger.test.ts): en vez de espiar llamadas, el
 * módulo corre contra una TABLA EN MEMORIA que hace cumplir las restricciones reales —
 * `UNIQUE(escrow_pda)` levantando un 23505 de verdad, y evaluación de los filtros AL
 * MOMENTO DE APLICAR. Recién así las aserciones de concurrencia significan algo: un
 * UPDATE condicional puede tener exactamente un ganador, mientras que una
 * implementación leer-y-después-escribir deja pasar a los dos.
 *
 * La tabla inyecta latencia ANTES de evaluar los filtros de cada operación, así que dos
 * llamadas concurrentes realmente interleavean su arranque.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  escrow_pda: string;
  sender: string;
  remittance_id: string;
  network: string;
  status: string;
  claimed_at: string;
  /** Migración 007. NULL mientras no se firmó — y eso prueba que no se transmitió nada. */
  signature: string | null;
  recent_blockhash: string | null;
}

type Filter = { op: 'eq' | 'lt'; col: string; value: unknown };

/** Stand-in en memoria de `facilitator_solana_release_claims`. */
class FakeTable {
  rows: Row[] = [];
  /** Latencia aplicada antes de que cada operación evalúe sus filtros. */
  latencyMs = 0;
  /** Si está seteado, toda operación resuelve con este error con forma PostgREST. */
  errorMode: { code?: string; message: string } | null = null;
  /** Si es true, toda operación tira (fallo de red). */
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
    const escrowPda = String(obj.escrow_pda);
    if (this.rows.some((r) => r.escrow_pda === escrowPda)) {
      return {
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      };
    }
    this._seq += 1;
    this.rows.push({
      id: `row-${this._seq}`,
      escrow_pda: escrowPda,
      sender: String(obj.sender),
      remittance_id: String(obj.remittance_id),
      network: String(obj.network),
      status: 'claimed',
      claimed_at: new Date().toISOString(),
      signature: null,
      recent_blockhash: null,
    });
    return { error: null };
  }

  async update(
    patch: Record<string, unknown>,
    filters: readonly Filter[],
  ): Promise<{ data: unknown; error: unknown }> {
    await this._gate();
    if (this.errorMode) return { data: null, error: this.errorMode };
    // Los filtros se evalúan y la mutación se aplica JUNTOS, después del await —
    // exactamente como un único UPDATE condicional en Postgres.
    const matched = this.rows.filter((r) => this._match(r, filters));
    for (const row of matched) {
      for (const [col, value] of Object.entries(patch)) writeColumn(row, col, value);
    }
    return { data: matched.map((r) => ({ id: r.id })), error: null };
  }

  /** Envejece el claim para simular el paso del tiempo sin tocar el reloj. */
  age(ms: number): void {
    const row = this.rows.at(0);
    if (row) row.claimed_at = new Date(Date.now() - ms).toISOString();
  }
}

/** Acceso a columnas sin indexado dinámico (security/detect-object-injection). */
function readColumn(row: Row, col: string): unknown {
  switch (col) {
    case 'escrow_pda':
      return row.escrow_pda;
    case 'network':
      return row.network;
    case 'status':
      return row.status;
    case 'claimed_at':
      return row.claimed_at;
    case 'signature':
      return row.signature;
    case 'recent_blockhash':
      return row.recent_blockhash;
    default:
      return undefined;
  }
}

function writeColumn(row: Row, col: string, value: unknown): void {
  switch (col) {
    case 'status':
      row.status = String(value);
      break;
    case 'claimed_at':
      row.claimed_at = String(value);
      break;
    // ⚠️ Sin estos dos casos el `default: break` se COME la firma y la persistencia de
    // 007 no se podría afirmar: `markReleaseSigned` podría dejar de escribirla y el
    // doble diría lo mismo.
    case 'signature':
      row.signature = value === null ? null : String(value);
      break;
    case 'recent_blockhash':
      row.recent_blockhash = value === null ? null : String(value);
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

import {
  claimEscrowRelease,
  markReleaseSigned,
  stealStaleReleaseClaim,
  type ReleaseClaimEntry,
} from '../../infra/solana-escrow-release-dedup.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

const ENTRY: ReleaseClaimEntry = {
  escrowPda: 'Escrow111111111111111111111111111111111111',
  sender: 'Sender111111111111111111111111111111111111',
  remittanceId: 'rem-abc-1',
  network: 'solana:devnet',
};

const LEASE_MS = 180_000;

/** Firma + blockhash que `markReleaseSigned` persiste (migración 007). */
const SIGNATURE = 'SIGrelease1111111111111111111111111111111111';
const BLOCKHASH = 'Blockhash11111111111111111111111111111111111';

let table: FakeTable;

beforeEach(() => {
  table = new FakeTable();
  h.table.current = table;
  h.nullClient.on = false;
  logger.warn.mockReset();
  logger.debug.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('claimEscrowRelease — la barrera at-most-once sigue intacta', () => {
  it('el primer claim gana el INSERT', async () => {
    expect(await claimEscrowRelease(ENTRY, logger)).toEqual({ ok: true, claimed: true });
    expect(table.rows).toHaveLength(1);
    expect(table.rows.at(0)?.status).toBe('claimed');
  });

  it('★ N claims concurrentes → exactamente UN ganador (el lease no aflojó el UNIQUE)', async () => {
    table.latencyMs = 2;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimEscrowRelease(ENTRY, logger)),
    );
    expect(results.filter((r) => r.ok && r.claimed)).toHaveLength(1);
    expect(table.rows).toHaveLength(1);
  });

  it('★ cliente nulo → { ok:false } (FAIL-CLOSED)', async () => {
    h.nullClient.on = true;
    expect(await claimEscrowRelease(ENTRY, logger)).toEqual({ ok: false });
  });
});

describe('stealStaleReleaseClaim — el claim trabado se vuelve recuperable', () => {
  it('★ un claim más viejo que el lease se puede tomar (el escrow deja de estar trabado para siempre)', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.age(LEASE_MS + 60_000);
    expect(await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).toEqual({
      ok: true,
      stolen: true,
    });
  });

  it('★ un claim MÁS NUEVO que el lease NO se toma (una tentativa viva no se pisa)', async () => {
    await claimEscrowRelease(ENTRY, logger);
    expect(await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).toEqual({
      ok: true,
      stolen: false,
    });
  });

  it('★ dos tomas concurrentes → exactamente una devuelve stolen:true', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.age(LEASE_MS + 60_000);
    table.latencyMs = 2;
    const [a, b] = await Promise.all([
      stealStaleReleaseClaim(ENTRY, LEASE_MS, logger),
      stealStaleReleaseClaim(ENTRY, LEASE_MS, logger),
    ]);
    expect([a.stolen, b.stolen].filter(Boolean)).toHaveLength(1);
  });

  it('la toma RENUEVA el lease (un tercer request no puede tomarlo enseguida)', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.age(LEASE_MS + 60_000);
    expect((await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).stolen).toBe(true);
    expect((await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).stolen).toBe(false);
  });

  it('★ una fila SIGNED cuyo broadcast murió también se recupera pasado el lease', async () => {
    // Éste es el caso exacto del bug: se firmó, el envío no prosperó, y sin lease el
    // escrow quedaba irreleaseable. Lo que lo hace seguro no es el status sino que el
    // lease supera la vida de un blockhash (más el chequeo on-chain de la ruta).
    await claimEscrowRelease(ENTRY, logger);
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: true });
    table.age(LEASE_MS + 60_000);
    expect((await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).stolen).toBe(true);
    // Y vuelve a 'claimed', para que la cerca de un solo disparo pueda ganarse de nuevo.
    expect(table.rows.at(0)?.status).toBe('claimed');
  });

  it('★ cliente nulo / error / excepción → { ok:false } (FAIL-CLOSED, no se toma nada)', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.age(LEASE_MS + 60_000);

    h.nullClient.on = true;
    expect(await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).toEqual({
      ok: false,
      stolen: false,
    });
    h.nullClient.on = false;

    table.errorMode = { code: '08006', message: 'connection failure' };
    expect(await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).toEqual({
      ok: false,
      stolen: false,
    });
    table.errorMode = null;

    table.throwMode = true;
    expect(await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).toEqual({
      ok: false,
      stolen: false,
    });
  });
});

describe('markReleaseSigned — la firma queda del lado nuestro (007)', () => {
  /**
   * ★ Hasta la 007 la firma de un release existía en UN solo lugar: el body de la
   * respuesta HTTP. La tabla no tenía columna y `infra/logger.ts` redacta el campo
   * `signature`, así que una respuesta perdida (timeout, proceso reiniciado, sonda
   * post-envío que no pudo preguntar) no dejaba NADA con qué reconciliar.
   */
  it('★ persiste `signature` y `recent_blockhash` junto con la transición a signed', async () => {
    await claimEscrowRelease(ENTRY, logger);
    // Antes de firmar la fila NO tiene firma, y ESA es la dirección que prueba algo:
    // sin firma no se transmitió nada (la firma se escribe antes de `serialize`).
    expect(table.rows.at(0)?.signature).toBeNull();
    expect(table.rows.at(0)?.recent_blockhash).toBeNull();

    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: true });

    expect(table.rows.at(0)?.status).toBe('signed');
    expect(table.rows.at(0)?.signature).toBe(SIGNATURE);
    expect(table.rows.at(0)?.recent_blockhash).toBe(BLOCKHASH);
  });

  it('★ el que PIERDE la cerca no pisa la firma del que la ganó', async () => {
    await claimEscrowRelease(ENTRY, logger);
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: true });
    // El perdedor llega con OTRA firma: el filtro `status='claimed'` no matchea, así
    // que su UPDATE no toca nada. Si lo tocara, la fila quedaría apuntando a una tx
    // que nunca se transmitió y la reconciliación miraría la transacción equivocada.
    expect(
      await markReleaseSigned(ENTRY, 'OTRAfirma1111111111111111111111', 'OtroBlockhash111', logger),
    ).toEqual({ ok: false });
    expect(table.rows.at(0)?.signature).toBe(SIGNATURE);
    expect(table.rows.at(0)?.recent_blockhash).toBe(BLOCKHASH);
  });
});

describe('markReleaseSigned — la cerca de un solo disparo', () => {
  it('★ dos firmantes que sobrevivieron al lease → exactamente uno puede transmitir', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.latencyMs = 2;
    const [a, b] = await Promise.all([
      markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger),
      markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('★ el que llega tarde a la cerca recibe ok:false (y por contrato NO broadcastea)', async () => {
    // Interleaving que el lease solo no cubre: A cuelga, B le toma el claim, y después
    // A revive y firma. La cerca es lo único que impide que salgan las dos txs.
    await claimEscrowRelease(ENTRY, logger); // A
    table.age(LEASE_MS + 60_000);
    expect((await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).stolen).toBe(true); // B
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: true }); // B firma primero
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: false }); // A llega tarde
  });

  it('re-ancla el lease en el instante de la firma', async () => {
    await claimEscrowRelease(ENTRY, logger);
    table.age(LEASE_MS + 60_000);
    await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger);
    // El claim era robable un instante antes de firmar; después de firmar ya no.
    expect((await stealStaleReleaseClaim(ENTRY, LEASE_MS, logger)).stolen).toBe(false);
  });

  it('★ cliente nulo / error / excepción → { ok:false } (FAIL-CLOSED ⇒ sin broadcast)', async () => {
    await claimEscrowRelease(ENTRY, logger);

    h.nullClient.on = true;
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: false });
    h.nullClient.on = false;

    table.errorMode = { message: 'boom' };
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: false });
    table.errorMode = null;

    table.throwMode = true;
    expect(await markReleaseSigned(ENTRY, SIGNATURE, BLOCKHASH, logger)).toEqual({ ok: false });
  });
});
