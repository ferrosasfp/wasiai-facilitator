/**
 * WKH-216 / HU-SOL-13 — Wave 13c: POST /solana/escrow/release orchestration (TF6/TF7).
 *
 * The route is exercised via `app.inject()`. `cosignAndBroadcast` (the HU-SOL-14
 * primitive), `readEscrowState`, and `claimEscrowRelease` are mocked with hoisted
 * state; `verifyVault` stays REAL; `Connection.getLatestBlockhash` is spied so the
 * happy path never touches the network. The ★ assertion across TF6/TF7 is that the
 * primitive is NEVER invoked when the release is rejected BEFORE signing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import * as web3 from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import type * as SponsorBroadcastModule from '../../methods/solana-sponsor/broadcast.js';
import type * as SolanaEscrowModule from '../../chains/solana-escrow.js';
import type { EscrowStateDecoded } from '../../chains/solana-escrow.js';
import { computeReleaseAttestation } from '../../routes/solana-escrow.js';

const USDC_MINT = Keypair.generate().publicKey.toBase58();
const releaseAuthorityKp = Keypair.generate();

/**
 * ⚠️ La authority del fixture ERA UN PUBKEY AL AZAR, y toda la suite pasaba. Un escrow
 * asi no se puede liberar NUNCA (`has_one = authority` -> ConstraintHasOne 2001), o sea
 * que el camino feliz estaba ejercitando exactamente el agujero que el Step 4b cierra.
 * Ahora es la authority real de la ruta, y los vectores que hablan de ella la pisan.
 *
 * Idem el `deadline`: ahora se declara relativo a AHORA, porque una constante en el
 * futuro caduca sola y el dia que caduque estos tests fallarian por el motivo equivocado.
 */
function depositedState(overrides: Partial<EscrowStateDecoded> = {}): EscrowStateDecoded {
  return {
    sender: Keypair.generate().publicKey.toBase58(),
    beneficiary: Keypair.generate().publicKey.toBase58(),
    authority: releaseAuthorityKp.publicKey.toBase58(),
    mint: USDC_MINT,
    amount: '3000000',
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    status: 'Deposited',
    bump: 254,
    escrowStatePda: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    ...overrides,
  };
}

const h = vi.hoisted(() => ({
  cosignResult: {
    current: { ok: true, signature: 'SIGrel123' } as
      | { ok: true; signature: string }
      | { ok: false; code: string; reason: string },
  },
  cosignSpy: vi.fn(),
  /** Un rechazo BARATO no puede quemar el claim: el reintento legítimo comería un 409. */
  claimSpy: vi.fn(),
  readResult: {
    current: { ok: true, state: null, vaultAmount: '3000000' } as {
      ok: boolean;
      state?: EscrowStateDecoded | null;
      vaultAmount?: string;
      reason?: string;
    },
  },
  claimResult: {
    current: { ok: true, claimed: true } as
      | { ok: true; claimed: true }
      | { ok: true; claimed: false }
      | { ok: false },
  },
  stealResult: {
    current: { ok: true, stolen: false } as { ok: boolean; stolen: boolean },
  },
}));

vi.mock('../../methods/solana-sponsor/broadcast.js', async (importActual) => {
  const actual = await importActual<typeof SponsorBroadcastModule>();
  return {
    ...actual,
    cosignAndBroadcast: (...args: unknown[]) => {
      h.cosignSpy(...args);
      return Promise.resolve(h.cosignResult.current);
    },
  };
});

vi.mock('../../chains/solana-escrow.js', async (importActual) => {
  const actual = await importActual<typeof SolanaEscrowModule>();
  return {
    ...actual, // verifyVault stays REAL
    readEscrowState: () => Promise.resolve(h.readResult.current),
  };
});

vi.mock('../../infra/solana-escrow-release-dedup.js', () => ({
  claimEscrowRelease: (...args: unknown[]) => {
    h.claimSpy(...args);
    return Promise.resolve(h.claimResult.current);
  },
  // Lease del claim: por defecto NO se puede tomar (lease vigente), que es lo que
  // deja los TF7 de acá abajo midiendo lo mismo que antes — un claim existente y
  // VIVO sigue siendo un 409 sin firma. La recuperación del claim trabado se prueba
  // en route.release.lease.test.ts, contra el store real en memoria.
  stealStaleReleaseClaim: (...args: unknown[]) => {
    void args;
    return Promise.resolve(h.stealResult.current);
  },
  markReleaseSigned: (...args: unknown[]) => {
    void args;
    return Promise.resolve({ ok: true });
  },
}));

const KEY_JSON = JSON.stringify(Array.from(releaseAuthorityKp.secretKey));
const ATTEST_SECRET = 'test-release-secret';
const SENDER = Keypair.generate().publicKey.toBase58();
const REMITTANCE_ID = 'rem-xyz-9';

interface SavedEnv {
  enabled?: string;
  key?: string;
  attest?: string;
  rpc?: string;
  mint?: string;
}
const savedEnv: SavedEnv = {};

function applyReleaseEnv(): void {
  savedEnv.enabled = process.env.SOLANA_ESCROW_RELEASE_ENABLED;
  savedEnv.key = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  savedEnv.attest = process.env.SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET;
  savedEnv.rpc = process.env.SOLANA_RPC_URL;
  savedEnv.mint = process.env.SOLANA_USDC_MINT;
  process.env.SOLANA_ESCROW_RELEASE_ENABLED = 'true';
  process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = KEY_JSON;
  process.env.SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET = ATTEST_SECRET;
  process.env.SOLANA_RPC_URL = 'http://mock-rpc';
  process.env.SOLANA_USDC_MINT = USDC_MINT;
}

function restoreReleaseEnv(): void {
  restore('SOLANA_ESCROW_RELEASE_ENABLED', savedEnv.enabled);
  restore('SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY', savedEnv.key);
  restore('SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET', savedEnv.attest);
  restore('SOLANA_RPC_URL', savedEnv.rpc);
  restore('SOLANA_USDC_MINT', savedEnv.mint);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    // eslint-disable-next-line security/detect-object-injection -- fixed env name from a literal call site, not user input.
    delete process.env[name];
  } else {
    // eslint-disable-next-line security/detect-object-injection -- fixed env name from a literal call site, not user input.
    process.env[name] = value;
  }
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    remittanceId: REMITTANCE_ID,
    sender: SENDER,
    attestation: computeReleaseAttestation(REMITTANCE_ID, SENDER, ATTEST_SECRET),
    ...overrides,
  };
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

/**
 * ⚠️ `vitest.config.ts:9` fija `LOG_LEVEL: 'silent'` para toda la suite, así que
 * un `CaptureStream` no recibe NADA salvo que se suba el nivel a propósito. Sin
 * esto, un `expect(cap.text()).toContain(...)` mide el vacío y falla por la razón
 * equivocada — y su gemelo `not.toContain` pasaría sin probar nada.
 */
function withLogs<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  const restore = () => {
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

async function inject(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/solana/escrow/release',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('POST /solana/escrow/release', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    applyReleaseEnv();
    h.cosignResult.current = { ok: true, signature: 'SIGrel123' };
    h.cosignSpy.mockReset();
    h.claimSpy.mockReset();
    h.readResult.current = { ok: true, state: depositedState(), vaultAmount: '3000000' };
    h.claimResult.current = { ok: true, claimed: true };
    h.stealResult.current = { ok: true, stolen: false };
    // No network: the happy path's getLatestBlockhash is stubbed.
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

  // ── happy — proves cosignAndBroadcast IS invoked once on the authorized path ──
  it('valid attestation + Deposited + fresh claim → 200 { signature }, primitive invoked once', async () => {
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { signature: string };
    expect(body.signature).toBe('SIGrel123');
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  // ── TF6 — reject BEFORE signing (AC-4 / CD-3) ────────────────────────────────
  it('★ TF6a: invalid attestation (no KYC/TransFi) → 422, primitive NOT invoked', async () => {
    app = await buildReleaseApp();
    const res = await inject(app, validBody({ attestation: 'deadbeef'.repeat(8) }));
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('RELEASE_REJECTED');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ TF6b: on-chain status ≠ Deposited (Refunded) → 422, primitive NOT invoked', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ status: 'Refunded' }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(422);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ TF6c: vault.amount ≠ state.amount → 422, primitive NOT invoked', async () => {
    h.readResult.current = { ok: true, state: depositedState(), vaultAmount: '2999999' };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(422);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('MNR-2: vault has dust excess (> state.amount) → 200, primitive invoked (griefing DoS closed)', async () => {
    // Attacker sends 1 dust unit to the public vault ATA → vaultAmount > amount.
    // Release must STILL proceed (on-chain release transfers exactly state.amount).
    h.readResult.current = { ok: true, state: depositedState(), vaultAmount: '3000001' };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(200);
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  it('★ TF6d: escrow unreadable (RPC/decoding) → 422, primitive NOT invoked', async () => {
    h.readResult.current = { ok: false, reason: 'ESCROW_READ_FAILED' };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(422);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── TF7 — no-replayable (AC-5 / CD-9) ────────────────────────────────────────
  it('★ TF7a: on-chain status == Released → 409, primitive NOT invoked', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ status: 'Released' }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('RELEASE_REPLAY');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ TF7b: dedup already claimed → 409, primitive NOT invoked', async () => {
    h.claimResult.current = { ok: true, claimed: false };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('RELEASE_REPLAY');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ TF7c: dedup store down → 500 fail-closed, primitive NOT invoked', async () => {
    h.claimResult.current = { ok: false };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('RELEASE_STORE_UNAVAILABLE');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('TF7: two concurrent-style calls — first claims, second (claimed:false) → 409', async () => {
    app = await buildReleaseApp();
    const first = await inject(app, validBody());
    expect(first.statusCode).toBe(200);
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
    // Second call: dedup now reports already-claimed.
    h.claimResult.current = { ok: true, claimed: false };
    const second = await inject(app, validBody());
    expect(second.statusCode).toBe(409);
    // cosign NOT re-invoked (still 1 total).
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  // ── Step 4b — las dos condiciones que la CADENA ya iba a rechazar ────────────
  //
  // `readEscrowState` decodifica `deadline` y `authority` y hasta acá no los leía
  // nadie: la ruta reclamaba el claim, firmaba y transmitía una tx condenada a
  // `ReleaseWindowClosed` (6008) o a `ConstraintHasOne` (2001). Cada aserción
  // `claimSpy NOT called` es la parte cara: un rechazo barato que quema el claim deja
  // al reintento legítimo comiendo 409 durante todo el lease.

  it('★ deadline vencido → 409 RELEASE_WINDOW_CLOSED, sin firmar y SIN quemar el claim', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ deadline: String(Math.floor(Date.now() / 1000) - 1) }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RELEASE_WINDOW_CLOSED');
    // El mensaje tiene que decir que NO es reintentable: ese escrow ya sólo va a refund.
    expect(body.error.message).toContain('refunded');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('★ el borde exacto: `now == deadline` ya está cerrado (on-chain pide `now < deadline`)', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ deadline: String(Math.floor(Date.now() / 1000)) }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('RELEASE_WINDOW_CLOSED');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('deadline vigente (1 h por delante) → sigue liberándose (el guard no rechaza de más)', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ deadline: String(Math.floor(Date.now() / 1000) + 3600) }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(200);
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  it('★ authority ajena → 422 RELEASE_AUTHORITY_MISMATCH, sin firmar y SIN quemar el claim', async () => {
    h.readResult.current = {
      ok: true,
      state: depositedState({ authority: Keypair.generate().publicKey.toBase58() }),
      vaultAmount: '3000000',
    };
    app = await buildReleaseApp();
    const res = await inject(app, validBody());
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('RELEASE_AUTHORITY_MISMATCH');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  /**
   * ★★ EL PUNTO DE LOS DOS CÓDIGOS. "El plazo venció" es IRREVERSIBLE (ese escrow ya
   * sólo puede terminar en refund) y "esta authority no es la de este escrow" es un
   * problema de CONFIGURACIÓN. Las acciones son opuestas, así que un solo código
   * (`RELEASE_REJECTED / 422`, que es donde caían las dos antes) no sirve.
   */
  it('★★ las dos condiciones son distinguibles entre sí y del rechazo genérico', async () => {
    const responses: { code: string; status: number }[] = [];

    for (const state of [
      depositedState({ deadline: String(Math.floor(Date.now() / 1000) - 1) }),
      depositedState({ authority: Keypair.generate().publicKey.toBase58() }),
      depositedState({ status: 'Refunded' }), // rechazo genérico preexistente
    ]) {
      h.readResult.current = { ok: true, state, vaultAmount: '3000000' };
      const instance = await buildReleaseApp();
      const res = await inject(instance, validBody());
      responses.push({
        code: (JSON.parse(res.body) as { error: { code: string } }).error.code,
        status: res.statusCode,
      });
      await instance.close();
    }

    expect(responses.map((r) => r.code)).toEqual([
      'RELEASE_WINDOW_CLOSED',
      'RELEASE_AUTHORITY_MISMATCH',
      'RELEASE_REJECTED',
    ]);
    // Y los tres códigos son distintos entre sí (no es sólo el orden del array).
    expect(new Set(responses.map((r) => r.code)).size).toBe(3);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── ★ observabilidad del 422 ────────────────────────────────────────────────
  //
  // ⚠️ TF6d de arriba prueba que un escrow ilegible NO se firma, y eso está bien,
  // pero deja el 422 mudo: `ESCROW_STATE_NOT_FOUND` ("ese escrow no existe") y
  // `ESCROW_READ_FAILED` ("el RPC se cayó y no pude preguntar") salían con el
  // MISMO `error_code: RELEASE_REJECTED` y el MISMO 'Escrow state unreadable'.
  // Para un operador son diagnósticos opuestos: uno es un bug del cliente, el
  // otro es infraestructura caída. Estos dos tests fijan que el motivo va al log
  // y NO a la respuesta.

  it('★ el 422 de escrow ilegible escribe el motivo del RPC en el log', async () => {
    h.readResult.current = { ok: false, reason: 'ESCROW_READ_FAILED' };
    const cap = new CaptureStream();
    const res = await withLogs(async () => {
      app = await buildReleaseApp(cap);
      return inject(app, validBody());
    });

    expect(res.statusCode).toBe(422);
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(cap.text().length).toBeGreaterThan(0);
    expect(cap.text()).toContain('ESCROW_READ_FAILED');
    // no-oracle: el cliente ve el mensaje genérico y nada más.
    const body = JSON.parse(res.body) as { error: { message: string } };
    expect(body.error.message).toBe('Escrow state unreadable');
    expect(res.body).not.toContain('ESCROW_READ_FAILED');
  });

  it('★ el escrow inexistente se distingue del RPC caído EN EL LOG (mismo 422 para el cliente)', async () => {
    h.readResult.current = { ok: false, reason: 'ESCROW_STATE_NOT_FOUND' };
    const cap = new CaptureStream();
    const res = await withLogs(async () => {
      app = await buildReleaseApp(cap);
      return inject(app, validBody());
    });

    expect(res.statusCode).toBe(422);
    expect(cap.text()).toContain('ESCROW_STATE_NOT_FOUND');
    // El marcador que NO corresponde no aparece: si `fail()` hardcodeara una
    // etiqueta fija en vez de propagar `read.reason`, este assert lo caza.
    expect(cap.text()).not.toContain('ESCROW_READ_FAILED');
    expect(res.body).not.toContain('ESCROW_STATE_NOT_FOUND');
  });
});

// ── MNR-1 — injective attestation encoding (no shifted-delimiter collision) ────
describe('computeReleaseAttestation (MNR-1 injective encoding)', () => {
  const SECRET = 'test-attestation-secret';

  it('shifted-delimiter inputs do NOT collide', () => {
    // Naive `${a}:${b}` would make these two pairs share the same signed message.
    const a = computeReleaseAttestation('a:b', 'c', SECRET);
    const b = computeReleaseAttestation('a', 'b:c', SECRET);
    expect(a).not.toBe(b);
  });

  it('same inputs are deterministic (SSOT for client + server)', () => {
    expect(computeReleaseAttestation('rid-1', 'sender-1', SECRET)).toBe(
      computeReleaseAttestation('rid-1', 'sender-1', SECRET),
    );
  });

  it('distinct field boundaries yield distinct attestations', () => {
    const one = computeReleaseAttestation('ab', 'cd', SECRET);
    const two = computeReleaseAttestation('abc', 'd', SECRET);
    const three = computeReleaseAttestation('a', 'bcd', SECRET);
    expect(new Set([one, two, three]).size).toBe(3);
  });
});
