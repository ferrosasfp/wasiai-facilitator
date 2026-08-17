/**
 * POST /solana/escrow/release — el claim dejó de ser una lápida (lease + cerca de firma).
 *
 * A diferencia de route.release.test.ts, acá el módulo de dedup NO se mockea: corre el
 * real contra una tabla EN MEMORIA que hace cumplir `UNIQUE(escrow_pda)` con un 23505 de
 * verdad y evalúa los filtros al momento de aplicar. Sin eso, el UPDATE condicional del
 * lease no se estaría probando — se estaría probando un doble que responde lo que se le
 * pidió responder.
 *
 * `cosignAndBroadcast` sí es un doble, y emula UNA cláusula del primitivo real: si el
 * caller pasó `onSigned` y éste devuelve `{ ok:false }`, NO transmite y resuelve
 * `SPONSOR_PERSIST_FAILED` (broadcast.ts:299-308). Esa cláusula es lo que convierte la
 * cerca en un no-broadcast, y el doble la respeta en vez de asumirla. Que el primitivo
 * real la cumpla ya lo cubre solana-sponsor.broadcast.test.ts.
 *
 * El tiempo no se toca con relojes falsos: se envejece la fila del store, que es el dato
 * del que depende el lease.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as web3 from '@solana/web3.js';
import { Keypair, type Transaction } from '@solana/web3.js';
import type * as SolanaEscrowModule from '../../chains/solana-escrow.js';
import type { EscrowStateDecoded } from '../../chains/solana-escrow.js';
import type * as SupabaseModule from '../../infra/supabase.js';
import type * as SponsorBroadcastModule from '../../methods/solana-sponsor/broadcast.js';
import { computeReleaseAttestation } from '../../routes/solana-escrow.js';

const USDC_MINT = Keypair.generate().publicKey.toBase58();
const LEASE_MS = 180_000; // el default de SOLANA_ESCROW_RELEASE_LEASE_MS

// ── store en memoria ─────────────────────────────────────────────────────────
interface Row {
  id: string;
  escrow_pda: string;
  network: string;
  status: string;
  claimed_at: string;
  /** Migración 007. NULL mientras no se firmó — y eso prueba que no se transmitió nada. */
  signature: string | null;
  recent_blockhash: string | null;
}

type Filter = { op: 'eq' | 'lt'; col: string; value: unknown };

class FakeTable {
  rows: Row[] = [];
  latencyMs = 0;
  /** Mutante: si es true, el INSERT deja pasar duplicados (dedup desactivado). */
  allowDuplicates = false;
  private _seq = 0;

  private async _gate(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
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
    const escrowPda = String(obj.escrow_pda);
    if (!this.allowDuplicates && this.rows.some((r) => r.escrow_pda === escrowPda)) {
      return {
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      };
    }
    this._seq += 1;
    this.rows.push({
      id: `row-${this._seq}`,
      escrow_pda: escrowPda,
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
    const matched = this.rows.filter((r) => this._match(r, filters));
    for (const row of matched) {
      for (const [col, value] of Object.entries(patch)) writeColumn(row, col, value);
    }
    return { data: matched.map((r) => ({ id: r.id })), error: null };
  }

  /** Envejece TODOS los claims, para simular el paso del tiempo sin relojes falsos. */
  age(ms: number): void {
    const past = new Date(Date.now() - ms).toISOString();
    for (const row of this.rows) row.claimed_at = past;
  }
}

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
    // ⚠️ El `default: break` de abajo COME cualquier columna que la app escriba y el
    // doble no conozca. Estas dos están acá explícitamente para que la persistencia de
    // la firma (007) se pueda AFIRMAR: sin ellas, un `markReleaseSigned` que dejara de
    // escribirlas pasaría inadvertido.
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

const h = vi.hoisted(() => ({
  table: { current: null as unknown },
  readResult: {
    current: { ok: true } as {
      ok: boolean;
      state?: EscrowStateDecoded | null;
      vaultAmount?: string;
      reason?: string;
    },
  },
  /** Una entrada por BROADCAST efectivamente emitido. */
  broadcasts: { list: [] as string[] },
  /** Llamadas al primitivo (haya transmitido o no). */
  cosignCalls: { n: 0 },
}));

// Mock PARCIAL: `buildApp` llama `initSupabase` al arrancar, así que un mock que sólo
// exponga `getSupabaseClient` rompe el arranque de la app entera.
vi.mock('../../infra/supabase.js', async (importActual) => {
  const actual = await importActual<typeof SupabaseModule>();
  return {
    ...actual,
    getSupabaseClient: () => {
      const table = h.table.current as FakeTable;
      return {
        // ⚠️ El doble DEBE mirar el nombre de la tabla. Acá se levanta la app entera,
        // así que por este mismo cliente pasan escrituras ajenas (el audit log, por
        // ejemplo). Un `from()` que ignore el nombre las mete en la tabla de claims y
        // las cuenta como claims — un falso rojo que ya se cobró una vuelta.
        from: (name: string) => {
          if (name !== RELEASE_CLAIMS_TABLE) return makeSinkChain();
          return {
            insert: (obj: Record<string, unknown>) => table.insert(obj),
            update: (patch: Record<string, unknown>) => makeFilterChain(table, patch),
          };
        },
      };
    },
  };
});

const RELEASE_CLAIMS_TABLE = 'facilitator_solana_release_claims';

/** Sumidero inofensivo para cualquier OTRA tabla que toque la app durante el test. */
interface SinkChain {
  insert: (obj?: unknown) => SinkChain;
  update: (obj?: unknown) => SinkChain;
  select: (cols?: string) => SinkChain;
  eq: (col?: string, value?: unknown) => SinkChain;
  lt: (col?: string, value?: unknown) => SinkChain;
  maybeSingle: () => Promise<{ data: null; error: null }>;
  single: () => Promise<{ data: null; error: null }>;
  then: (
    onfulfilled?: ((value: { data: never[]; error: null }) => unknown) | null,
  ) => Promise<unknown>;
}

function makeSinkChain(): SinkChain {
  const chain: SinkChain = {
    insert: () => chain,
    update: () => chain,
    select: () => chain,
    eq: () => chain,
    lt: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (onfulfilled) => Promise.resolve({ data: [], error: null }).then(onfulfilled),
  };
  return chain;
}

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

/** Tx firmada mínima: lo único que `onSigned` lee es `signatures[0].signature`. */
function signedTxDouble(): Transaction {
  const kp = Keypair.generate();
  return {
    signatures: [{ publicKey: kp.publicKey, signature: Buffer.alloc(64, 7) }],
  } as unknown as Transaction;
}

vi.mock('../../methods/solana-sponsor/broadcast.js', async (importActual) => {
  const actual = await importActual<typeof SponsorBroadcastModule>();
  return {
    ...actual,
    cosignAndBroadcast: async (
      _txBase64: string,
      opts: { onSigned?: (tx: Transaction) => Promise<{ ok: boolean }> },
    ) => {
      h.cosignCalls.n += 1;
      // Contrato real del primitivo: firma, y SÓLO transmite si `onSigned` autorizó.
      if (opts.onSigned) {
        // El primitivo real llama `onSigned` DESPUÉS de `partialSign`, así que la tx
        // que recibe YA tiene la firma cruda en `signatures[0]`. El doble entregaba un
        // `{}` pelado, que alcanzaba mientras `onSigned` sólo movía un estado y deja de
        // alcanzar ahora que además lee la firma para persistirla.
        const persisted = await opts.onSigned(signedTxDouble());
        if (!persisted.ok) {
          return {
            ok: false,
            code: 'SPONSOR_PERSIST_FAILED',
            reason: 'PERSIST_BEFORE_BROADCAST_FAILED',
          };
        }
      }
      const signature = `SIG-${h.broadcasts.list.length + 1}`;
      h.broadcasts.list.push(signature);
      return { ok: true, signature };
    },
  };
});

vi.mock('../../chains/solana-escrow.js', async (importActual) => {
  const actual = await importActual<typeof SolanaEscrowModule>();
  return {
    ...actual, // verifyVault queda REAL
    readEscrowState: () => Promise.resolve(h.readResult.current),
  };
});

// ── entorno de la ruta ───────────────────────────────────────────────────────
const releaseAuthorityKp = Keypair.generate();
const KEY_JSON = JSON.stringify(Array.from(releaseAuthorityKp.secretKey));
const ATTEST_SECRET = 'test-release-secret';
const SENDER = Keypair.generate().publicKey.toBase58();
const REMITTANCE_ID = 'rem-lease-1';

/** `Map` en vez de un objeto: sin índices dinámicos que auditar. */
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_ESCROW_RELEASE_ENABLED',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
  'SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
] as const;

function setEnv(name: string, value: string): void {
  // eslint-disable-next-line security/detect-object-injection -- nombre fijo de una lista literal, no input de usuario.
  process.env[name] = value;
}

function readEnv(name: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- ídem.
  return process.env[name];
}

function unsetEnv(name: string): void {
  // eslint-disable-next-line security/detect-object-injection -- ídem.
  delete process.env[name];
}

function applyReleaseEnv(): void {
  for (const k of ENV_KEYS) savedEnv.set(k, readEnv(k));
  setEnv('SOLANA_ESCROW_RELEASE_ENABLED', 'true');
  setEnv('SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY', KEY_JSON);
  setEnv('SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET', ATTEST_SECRET);
  setEnv('SOLANA_RPC_URL', 'http://mock-rpc');
  setEnv('SOLANA_USDC_MINT', USDC_MINT);
}

function restoreReleaseEnv(): void {
  for (const k of ENV_KEYS) {
    const value = savedEnv.get(k);
    if (value === undefined) unsetEnv(k);
    else setEnv(k, value);
  }
}

function depositedState(): EscrowStateDecoded {
  return {
    sender: SENDER,
    beneficiary: Keypair.generate().publicKey.toBase58(),
    // La authority REAL de la ruta: un pubkey al azar acá describe un escrow que no se
    // puede liberar nunca (ConstraintHasOne 2001), y el Step 4b lo corta antes del claim.
    authority: releaseAuthorityKp.publicKey.toBase58(),
    mint: USDC_MINT,
    amount: '3000000',
    // Relativo a AHORA: una constante en el futuro caduca sola.
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    status: 'Deposited',
    bump: 254,
    escrowStatePda: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
  };
}

function validBody() {
  return {
    remittanceId: REMITTANCE_ID,
    sender: SENDER,
    attestation: computeReleaseAttestation(REMITTANCE_ID, SENDER, ATTEST_SECRET),
  };
}

async function buildReleaseApp(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetReleaseAuthorityForTesting } =
    await import('../../infra/solana-release-authority.js');
  resetRedisClientForTests();
  resetReleaseAuthorityForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ skipDomainCheck: true });
}

async function inject(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/solana/escrow/release',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(validBody()),
  });
}

let table: FakeTable;

describe('POST /solana/escrow/release — lease del claim', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    applyReleaseEnv();
    table = new FakeTable();
    h.table.current = table;
    h.readResult.current = { ok: true, state: depositedState(), vaultAmount: '3000000' };
    h.broadcasts.list = [];
    h.cosignCalls.n = 0;
    vi.spyOn(web3.Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreReleaseEnv();
    vi.restoreAllMocks();
  });

  /**
   * ★ EL CASO QUE HOY ROMPE. El claim se escribe antes de pedir el blockhash, así que
   * un hipo del RPC ahí dejaba la fila puesta y el escrow irreleaseable PARA SIEMPRE:
   * todo reintento chocaba con el UNIQUE y comía un 409 permanente. Con el lease, el
   * reintento POSTERIOR al lease sí puede volver a intentar.
   */
  it('★ claim escrito + broadcast fallido → el reintento posterior al lease SÍ vuelve a intentar', async () => {
    app = await buildReleaseApp();

    // 1) El RPC tiene un hipo justo después del claim.
    vi.spyOn(web3.Connection.prototype, 'getLatestBlockhash').mockRejectedValueOnce(
      new Error('rpc hiccup'),
    );
    const first = await inject(app);
    expect(first.statusCode).toBe(409);
    expect(JSON.parse(first.body).error.code).toBe('RELEASE_BROADCAST_EXPIRED');
    expect(table.rows).toHaveLength(1); // el claim quedó escrito
    expect(h.broadcasts.list).toHaveLength(0); // y no se transmitió nada
    // 007: una fila SIN firma es la prueba durable de ese "no se transmitió nada".
    expect(table.rows.at(0)?.signature).toBeNull();
    expect(table.rows.at(0)?.recent_blockhash).toBeNull();

    // 2) Reintento INMEDIATO: el lease está vigente ⇒ sigue siendo 409 (la barrera no
    //    se aflojó; sólo dejó de ser eterna).
    const second = await inject(app);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe('RELEASE_REPLAY');
    expect(h.broadcasts.list).toHaveLength(0);

    // 3) Reintento pasado el lease: se toma el claim y el release sale.
    table.age(LEASE_MS + 60_000);
    const third = await inject(app);
    expect(third.statusCode).toBe(200);
    expect(JSON.parse(third.body).signature).toBe('SIG-1');
    expect(h.broadcasts.list).toHaveLength(1);
    expect(table.rows).toHaveLength(1); // nunca se creó una fila nueva
    expect(table.rows.at(0)?.status).toBe('signed');
    // 007: ahora la firma existe DEL LADO NUESTRO, no sólo en el body de la respuesta
    // (que es lo único que había, porque el logger redacta el campo `signature`).
    expect(table.rows.at(0)?.signature).toBeTruthy();
    expect(table.rows.at(0)?.recent_blockhash).toBeTruthy();
  });

  /**
   * ★ CANDADO DE NO-REGRESIÓN #1 — la carrera del INSERT. Dos requests concurrentes no
   * pueden transmitir las dos: `UNIQUE(escrow_pda)` sigue siendo la barrera.
   */
  it('★ dos requests concurrentes → UN solo broadcast', async () => {
    app = await buildReleaseApp();
    table.latencyMs = 2; // los INSERTs interleavean de verdad

    const [a, b] = await Promise.all([inject(app), inject(app)]);
    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([200, 409]);
    expect(h.broadcasts.list).toHaveLength(1);
    expect(table.rows).toHaveLength(1);
  });

  /**
   * ★ CANDADO DE NO-REGRESIÓN #2 — la carrera que ABRE el lease, y que la barrera vieja
   * no tenía: A cuelga con el claim tomado, su lease vence, B se lo toma y transmite, y
   * DESPUÉS A revive y firma. Sin la cerca `claimed → signed` salen DOS releases del
   * mismo escrow, que es peor que el bug que este arreglo cierra.
   */
  it('★ el que revive después de que le tomaron el claim NO transmite', async () => {
    app = await buildReleaseApp();

    // A queda colgado pidiendo el blockhash, con el claim ya escrito.
    let releaseA: (() => void) | undefined;
    const aIsHanging = new Promise<void>((resolveHangingStarted) => {
      vi.spyOn(web3.Connection.prototype, 'getLatestBlockhash').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveHangingStarted();
            releaseA = () =>
              resolve({
                blockhash: Keypair.generate().publicKey.toBase58(),
                lastValidBlockHeight: 1,
              });
          }),
      );
    });
    const aPromise = inject(app);
    await aIsHanging;
    expect(table.rows).toHaveLength(1);

    // Pasa el lease y entra B, que toma el claim y transmite.
    table.age(LEASE_MS + 60_000);
    const b = await inject(app);
    expect(b.statusCode).toBe(200);
    expect(h.broadcasts.list).toHaveLength(1);

    // A revive y firma. La cerca ya está tomada ⇒ no transmite.
    releaseA?.();
    const a = await aPromise;
    expect(a.statusCode).toBe(500);
    expect(JSON.parse(a.body).error.code).toBe('RELEASE_STORE_UNAVAILABLE');
    expect(h.cosignCalls.n).toBe(2); // los dos llegaron a firmar...
    expect(h.broadcasts.list).toHaveLength(1); // ...y transmitió UNO solo
  });
});
