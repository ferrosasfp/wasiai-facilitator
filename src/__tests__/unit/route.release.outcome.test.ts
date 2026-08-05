/**
 * POST /solana/escrow/release — los TRES desenlaces de un broadcast, por separado.
 *
 * `salió` / `no salió` / `NO SÉ`. El tercero existe porque los otros dos mienten en
 * su caso: `SPONSOR_BROADCAST_EXPIRED` se emite también desde sondas que corren
 * DESPUÉS de un `sendRawTransaction` exitoso (broadcast.ts:300-312 y :348-360), y el
 * `catch` de esas sondas significa "no pude preguntar", no "el blockhash venció".
 * `CosignResult.sent` es lo único que los separa, y esta ruta lo descartaba.
 *
 * Cada test fija el desenlace en las CUATRO superficies donde se puede mentir:
 * código HTTP, código de error, mensaje y log. La quinta (lo que queda en la tabla)
 * la cubre `route.release.lease.test.ts`, que corre contra el store real en memoria.
 *
 * El primitivo `cosignAndBroadcast` es un doble: acá se mide la TRADUCCIÓN que hace
 * la ruta de su resultado, no el primitivo (ése lo cubre solana-sponsor.broadcast.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import * as web3 from '@solana/web3.js';
import { Keypair, type Transaction } from '@solana/web3.js';
import type * as SponsorBroadcastModule from '../../methods/solana-sponsor/broadcast.js';
import type * as SolanaEscrowModule from '../../chains/solana-escrow.js';
import type { EscrowStateDecoded } from '../../chains/solana-escrow.js';
import { computeReleaseAttestation } from '../../routes/solana-escrow.js';

const USDC_MINT = Keypair.generate().publicKey.toBase58();
const releaseAuthorityKp = Keypair.generate();
const KEY_JSON = JSON.stringify(Array.from(releaseAuthorityKp.secretKey));
const ATTEST_SECRET = 'test-release-secret';
const SENDER = Keypair.generate().publicKey.toBase58();
const REMITTANCE_ID = 'rem-outcome-1';

/** El resultado que el doble del primitivo devuelve. `sent` es el eje del test. */
type CosignFake =
  | { ok: true; signature: string }
  | { ok: false; code: string; reason: string; sent?: boolean };

const h = vi.hoisted(() => ({
  cosignResult: {
    current: { ok: true, signature: 'SIGrel-happy' } as unknown,
  },
  /** Argumentos con los que la ruta llamó a `markReleaseSigned`. */
  markSignedArgs: { current: [] as unknown[] },
  readResult: {
    current: {} as {
      ok: boolean;
      state?: EscrowStateDecoded | null;
      vaultAmount?: string;
      reason?: string;
    },
  },
}));

vi.mock('../../methods/solana-sponsor/broadcast.js', async (importActual) => {
  const actual = await importActual<typeof SponsorBroadcastModule>();
  return {
    ...actual,
    cosignAndBroadcast: async (
      _txBase64: string,
      opts: { onSigned?: (tx: Transaction) => Promise<{ ok: boolean }> },
    ) => {
      // El primitivo real firma ANTES de transmitir y recién ahí llama `onSigned`,
      // así que el doble hace lo mismo: los tres desenlaces de abajo ocurren todos
      // DESPUÉS de que la firma existe y se persistió.
      if (opts.onSigned) {
        const kp = Keypair.generate();
        const persisted = await opts.onSigned({
          signatures: [{ publicKey: kp.publicKey, signature: Buffer.alloc(64, 3) }],
        } as unknown as Transaction);
        if (!persisted.ok) {
          return {
            ok: false,
            code: 'SPONSOR_PERSIST_FAILED',
            reason: 'PERSIST_BEFORE_BROADCAST_FAILED',
          };
        }
      }
      return h.cosignResult.current;
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

vi.mock('../../infra/solana-escrow-release-dedup.js', () => ({
  claimEscrowRelease: () => Promise.resolve({ ok: true, claimed: true }),
  stealStaleReleaseClaim: () => Promise.resolve({ ok: true, stolen: false }),
  markReleaseSigned: (...args: unknown[]) => {
    h.markSignedArgs.current = args;
    return Promise.resolve({ ok: true });
  },
}));

function depositedState(): EscrowStateDecoded {
  return {
    sender: SENDER,
    beneficiary: Keypair.generate().publicKey.toBase58(),
    authority: releaseAuthorityKp.publicKey.toBase58(),
    mint: USDC_MINT,
    amount: '3000000',
    // Lejos en el futuro: la ventana de release está abierta (ver Check de deadline).
    deadline: '4102444800',
    status: 'Deposited',
    bump: 254,
    escrowStatePda: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
  };
}

const ENV_KEYS = [
  'SOLANA_ESCROW_RELEASE_ENABLED',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
  'SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
] as const;
const savedEnv = new Map<string, string | undefined>();

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
    const v = savedEnv.get(k);
    if (v === undefined) unsetEnv(k);
    else setEnv(k, v);
  }
}

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

/** `vitest.config.ts` fija LOG_LEVEL='silent': sin esto el CaptureStream mide el vacío. */
function withLogs<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  const restore = (): void => {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  };
  return fn().then(
    (v) => {
      restore();
      return v;
    },
    (e: unknown) => {
      restore();
      throw e;
    },
  );
}

async function buildReleaseApp(capture?: CaptureStream): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetReleaseAuthorityForTesting } =
    await import('../../infra/solana-release-authority.js');
  resetRedisClientForTests();
  resetReleaseAuthorityForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ loggerDestination: capture, skipDomainCheck: true });
}

async function inject(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/solana/escrow/release',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      remittanceId: REMITTANCE_ID,
      sender: SENDER,
      attestation: computeReleaseAttestation(REMITTANCE_ID, SENDER, ATTEST_SECRET),
    }),
  });
}

interface Outcome {
  status: number;
  code?: string;
  message?: string;
  signature?: string;
  log: string;
}

async function run(cosign: CosignFake): Promise<Outcome> {
  h.cosignResult.current = cosign;
  const cap = new CaptureStream();
  let app: FastifyInstance | undefined;
  try {
    const res = await withLogs(async () => {
      app = await buildReleaseApp(cap);
      return inject(app);
    });
    const parsed = JSON.parse(res.body) as {
      signature?: string;
      error?: { code: string; message: string };
    };
    return {
      status: res.statusCode,
      code: parsed.error?.code,
      message: parsed.error?.message,
      signature: parsed.signature,
      log: cap.text(),
    };
  } finally {
    if (app) await app.close();
  }
}

describe('POST /solana/escrow/release — salió / no salió / no sé', () => {
  beforeEach(() => {
    applyReleaseEnv();
    h.readResult.current = { ok: true, state: depositedState(), vaultAmount: '3000000' };
    h.markSignedArgs.current = [];
    vi.spyOn(web3.Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
  });

  afterEach(() => {
    restoreReleaseEnv();
    vi.restoreAllMocks();
  });

  // ── 1. SALIÓ ───────────────────────────────────────────────────────────────
  it('★ salió: el primitivo confirmó → 200 { signature }, y nada dice "unknown"', async () => {
    const out = await run({ ok: true, signature: 'SIGrel-happy' });
    expect(out.status).toBe(200);
    expect(out.signature).toBe('SIGrel-happy');
    expect(out.code).toBeUndefined();
    expect(out.log).not.toContain('RELEASE_BROADCAST_UNKNOWN');
    expect(out.log).not.toContain('UNKNOWN');
  });

  // ── 2. NO SALIÓ ────────────────────────────────────────────────────────────
  it('★ no salió: EXPIRED SIN envío previo (`sent` ausente) → 409 RELEASE_BROADCAST_EXPIRED', async () => {
    // Éste es el expirado PRE-firma (broadcast.ts:224-232): probado que no se gastó.
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
    });
    expect(out.status).toBe(409);
    expect(out.code).toBe('RELEASE_BROADCAST_EXPIRED');
    expect(out.message).toBe('Transaction blockhash expired');
    expect(out.log).not.toContain('RELEASE_BROADCAST_UNKNOWN');
  });

  it('no salió: EXPIRED con `sent:false` explícito → 409 (no basta con que el campo exista)', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'STALE_BLOCKHASH',
      sent: false,
    });
    expect(out.status).toBe(409);
    expect(out.code).toBe('RELEASE_BROADCAST_EXPIRED');
  });

  // ── 3. NO SÉ ───────────────────────────────────────────────────────────────
  //
  // MISMO `code` y MISMO `reason` que el test de arriba: lo ÚNICO que cambia es
  // `sent`. Si la ruta volviera a descartar ese campo, estos dos tests devolverían
  // lo mismo y éste muere.
  it('★★ no sé: EXPIRED DESPUÉS de un envío exitoso (`sent:true`) → 502 RELEASE_BROADCAST_UNKNOWN', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.code).toBe('RELEASE_BROADCAST_UNKNOWN');
    expect(out.message).toBe(
      'Transaction was broadcast; its on-chain outcome could not be determined',
    );
  });

  it('★★ no sé: FAILED tras agotar reintentos (`sent:true`) → 502 RELEASE_BROADCAST_UNKNOWN', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.code).toBe('RELEASE_BROADCAST_UNKNOWN');
  });

  // ── el "no sé" no se confunde con ninguno de los otros dos, superficie x superficie ──
  it('★★★ el "no sé" es distinto del "salió" y del "no salió" en HTTP, código, mensaje y log', async () => {
    const salio = await run({ ok: true, signature: 'SIGrel-happy' });
    const noSalio = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
    });
    const noSe = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });

    // HTTP: los tres distintos.
    expect(new Set([salio.status, noSalio.status, noSe.status]).size).toBe(3);
    // Código de error: el del "no sé" no es el de ningún otro.
    expect(noSe.code).not.toBe(noSalio.code);
    expect(noSe.code).not.toBe(salio.code);
    // Mensaje: no afirma que venció (no salió) ni devuelve una firma (salió).
    expect(noSe.message).not.toContain('expired');
    expect(noSe.signature).toBeUndefined();
    // Log: el "no sé" NO se registra como fallo ni como ok.
    expect(noSe.log).toContain('UNKNOWN');
    expect(noSe.log).not.toContain('solana escrow release failed');
    expect(noSe.log).not.toContain('solana escrow release ok');
    // ...y el "no salió" sí sigue siendo un fallo, para que el assert de arriba no
    // esté midiendo que la ruta dejó de loguear en general.
    expect(noSalio.log).toContain('solana escrow release failed');
    expect(salio.log).not.toContain('UNKNOWN');
  });

  it('★ el 502 del "no sé" lleva el escrow_pda al log — es con lo que se busca la firma persistida', async () => {
    const state = depositedState();
    h.readResult.current = { ok: true, state, vaultAmount: '3000000' };
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.log).toContain(state.escrowStatePda);
    // no-oracle: el PDA va al log, NUNCA al body.
    expect(out.message).not.toContain(state.escrowStatePda);
  });

  // ── la mitad que hace útil a la otra: la firma queda persistida ─────────────
  it('★ la firma y el blockhash se persisten en el claim ANTES de cualquier envío', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    // markReleaseSigned(entry, signature, recentBlockhash, logger)
    const args = h.markSignedArgs.current;
    expect(args).toHaveLength(4);
    const signature = args[1];
    const blockhash = args[2];
    expect(typeof signature).toBe('string');
    expect(String(signature).length).toBeGreaterThan(0);
    expect(typeof blockhash).toBe('string');
    expect(String(blockhash).length).toBeGreaterThan(0);
    // El desenlace fue "no sé" y la firma existe igual: eso es lo que permite ir a
    // preguntarle a la cadena después. Sin esto, "no sé" no tiene cómo dejar de serlo.
  });

  it('★ la firma persistida NO viaja al log (el logger redacta `signature`) ni al body del 502', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    const signature = String(h.markSignedArgs.current[1]);
    expect(signature.length).toBeGreaterThan(0);
    expect(out.log).not.toContain(signature);
    expect(out.message).not.toContain(signature);
  });
});
