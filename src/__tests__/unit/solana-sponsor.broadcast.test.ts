/**
 * WKH-217 / HU-SOL-14 — cosignAndBroadcast primitive (T11-T14).
 *
 * The `@solana/web3.js` Connection is MOCKED (CD-10: no network, cero plata) via
 * `vi.mock` with `importActual` so Transaction/Keypair/SystemProgram stay REAL
 * (CD-14: `import * as` + vi.mocked style through vi.hoisted state). The mutex
 * (`runExclusive`) is real, so T12 exercises genuine FIFO serialization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Web3 from '@solana/web3.js';

const h = vi.hoisted(() => ({
  isBlockhashValidImpl: vi.fn(async (_bh: string) => ({ value: true })),
  sendRawTransactionImpl: vi.fn(async (_raw: Uint8Array) => `SIG_${Math.random().toString(16)}`),
  // `err` is annotated `unknown` (not inferred from the `null` default): the
  // failure tests override this with `{ value: { err: 'InstructionError' } }`,
  // which the inferred `{ err: null }` type would have rejected.
  confirmTransactionImpl: vi.fn(
    async (_sig: string): Promise<{ value: { err: unknown } }> => ({
      value: { err: null },
    }),
  ),
  active: { current: 0, max: 0 },
}));

vi.mock('@solana/web3.js', async (importActual) => {
  const actual = await importActual<typeof Web3>();
  class MockConnection {
    constructor(_url: string, _commitment?: string) {}
    isBlockhashValid(bh: string): Promise<{ value: boolean }> {
      return h.isBlockhashValidImpl(bh) as Promise<{ value: boolean }>;
    }
    async sendRawTransaction(raw: Uint8Array): Promise<string> {
      h.active.current += 1;
      h.active.max = Math.max(h.active.max, h.active.current);
      try {
        return await h.sendRawTransactionImpl(raw);
      } finally {
        h.active.current -= 1;
      }
    }
    confirmTransaction(sig: string): Promise<{ value: { err: unknown } }> {
      return h.confirmTransactionImpl(sig) as Promise<{ value: { err: unknown } }>;
    }
  }
  return { ...actual, Connection: MockConnection };
});

import {
  Keypair,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  cosignAndBroadcast,
  parseSponsorTx,
  type CosignOpts,
  type SponsorTxValidator,
} from '../../methods/solana-sponsor/broadcast.js';
import { resetChainMutexForTesting } from '../../chains/chain-mutex.js';

/** Build a sender-signed legacy tx (base64), simulating chaski's partial-sign. */
function buildSignedTxBase64(feePayerKp: Keypair, senderKp: Keypair): string {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: senderKp.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(senderKp);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

const okValidator: SponsorTxValidator = () => ({ ok: true, feeUpperBoundLamports: 5000n });

const baseOpts = (feePayerKp: Keypair) => ({
  feePayerKeypair: feePayerKp,
  validate: okValidator,
  rpcUrl: 'http://mock',
  maxFeeLamports: 100_000n,
  maxRebroadcasts: 3,
});

describe('cosignAndBroadcast primitive', () => {
  beforeEach(() => {
    resetChainMutexForTesting();
    h.isBlockhashValidImpl.mockReset();
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.sendRawTransactionImpl.mockReset();
    h.sendRawTransactionImpl.mockImplementation(async () => `SIG_${Math.random().toString(16)}`);
    h.confirmTransactionImpl.mockReset();
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: null } });
    h.active.current = 0;
    h.active.max = 0;
  });

  afterEach(() => vi.clearAllMocks());

  // ── T11 — blockhash stale (AC-4): reject WITHOUT signing ────────────────────
  it('★ T11: isBlockhashValid=false → SPONSOR_BROADCAST_EXPIRED, not signed', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: false });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  // ── ★ T12 — concurrency N without collision (AC-5) ──────────────────────────
  it('★ T12: 5 concurrent txs → 5 unique signatures, serialized (no interleave)', async () => {
    let counter = 0;
    h.sendRawTransactionImpl.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 1));
      counter += 1;
      return `SIG_${counter}`;
    });

    const calls = Array.from({ length: 5 }, () => {
      const feePayerKp = Keypair.generate();
      const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
      return cosignAndBroadcast(tx, baseOpts(feePayerKp));
    });
    const results = await Promise.all(calls);

    const sigs = results.map((r) => (r.ok ? r.signature : `ERR_${r.code}`));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(sigs).size).toBe(5); // all unique, no collision
    expect(h.sendRawTransactionImpl).toHaveBeenCalledTimes(5);
    // The fee-payer mutex serialized signing/broadcast: never 2 in flight.
    expect(h.active.max).toBe(1);
  });

  // ── T13 — rebroadcast + expiry (AC-5) ───────────────────────────────────────
  it('T13: confirm fails then blockhash expires → SPONSOR_BROADCAST_EXPIRED after rebroadcast', async () => {
    // pre-sign check true, loop attempt#0 true, then false on attempt#1 start.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValue({ value: false });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });

    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    // At least one (re)broadcast happened before the blockhash went stale.
    expect(h.sendRawTransactionImpl).toHaveBeenCalled();
  });

  it('T13b: confirm never succeeds but blockhash stays valid → SPONSOR_BROADCAST_FAILED', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), maxRebroadcasts: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_FAILED');
  });

  // ── T14 — primitive is agnostic to the deposit (CD-11) ──────────────────────
  it('★ T14a: injected validator { ok:false } → NOT signed, SPONSOR_REJECTED', async () => {
    const rejectValidator: SponsorTxValidator = () => ({ ok: false, reason: 'INJECTED_REJECT' });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), validate: rejectValidator });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SPONSOR_REJECTED');
      expect(r.reason).toBe('INJECTED_REJECT');
    }
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
    expect(h.isBlockhashValidImpl).not.toHaveBeenCalled(); // rejected before any network/sign
  });

  it('★ T14b: injected validator { ok:true } → signs + broadcasts', async () => {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(true);
    expect(h.sendRawTransactionImpl).toHaveBeenCalledTimes(1);
  });

  it('T14c: fee upper bound over the per-tx cap → SPONSOR_REJECTED (not signed)', async () => {
    const bigFeeValidator: SponsorTxValidator = () => ({
      ok: true,
      feeUpperBoundLamports: 999_999n,
    });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), validate: bigFeeValidator });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_REJECTED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  it('T14d: onFeeEstimated reject (daily cap) → SPONSOR_DAILY_CAP (not signed)', async () => {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: false, reason: 'store_error_failclosed' }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_DAILY_CAP');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
  });

  // ── CR-MNR-3 — versioned (v0) tx → SPONSOR_UNSUPPORTED_TX (reject, not signed) ─
  it('★ CR-MNR-3: a versioned/v0 VersionedTransaction → SPONSOR_UNSUPPORTED_TX (parse rejects)', () => {
    const payer = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const b64 = Buffer.from(vtx.serialize()).toString('base64');
    const r = parseSponsorTx(b64);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_UNSUPPORTED_TX');
  });

  // ── AR-MNR-1 — daily-cap reservation released only when no on-chain spend ─────
  it('★ AR-MNR-1a: stale blockhash → reserved fee is RELEASED (compensated), not signed', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: false }); // stale → EXPIRED pre-sign
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(h.sendRawTransactionImpl).not.toHaveBeenCalled();
    // The 5000-lamport reservation (okValidator) is released — no spend happened.
    expect(released).toEqual([5000n]);
  });

  it('★ AR-MNR-1b: SPONSOR_BROADCAST_FAILED → reservation KEPT (tx may have landed)', async () => {
    h.isBlockhashValidImpl.mockResolvedValue({ value: true });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      maxRebroadcasts: 1,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_BROADCAST_FAILED');
    // Ambiguous outcome → keep the debit to protect the fee-payer wallet.
    expect(released).toEqual([]);
  });

  /**
   * La QUINTA superficie del "no sé": la contabilidad del cap diario. Devolver los
   * lamports reservados afirma "no se gastó" tan claramente como un 409, sólo que en
   * otro lado. `SPONSOR_BROADCAST_EXPIRED` emitido DESPUÉS de un envío caía del lado
   * del release porque la regla estaba escrita nombrando un código en vez de la
   * propiedad ("pudo haber aterrizado").
   *
   * Los dos tests de abajo cubren las DOS formas en que la sonda posterior al envío
   * termina en EXPIRED: la que responde "ya no es válido" y la que no responde nada.
   */
  it('★ el EXPIRED POSTERIOR a un envío (blockhash vencido entre reintentos) → reserva CONSERVADA', async () => {
    // pre-sign true, i=0 true (envía), confirm falla, i=1 false → EXPIRED con sent=true.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValue({ value: false });
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      maxRebroadcasts: 1,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
      expect(r.sent).toBe(true); // hubo envío: el gas pudo haberse cobrado
    }
    expect(h.sendRawTransactionImpl).toHaveBeenCalled();
    expect(released).toEqual([]);
  });

  it('★ el EXPIRED de "no pude preguntar" POSTERIOR a un envío → reserva CONSERVADA', async () => {
    // pre-sign true, i=0 true (envía), confirm falla, i=1 la sonda TIRA → BLOCKHASH_CHECK_FAILED.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: true })
      .mockRejectedValue(new Error('rpc down'));
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      maxRebroadcasts: 1,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
      expect(r.reason).toBe('BLOCKHASH_CHECK_FAILED');
      expect(r.sent).toBe(true);
    }
    expect(released).toEqual([]);
  });

  it('AR-MNR-1c: success → reservation KEPT (spend happened, no release)', async () => {
    const released: bigint[] = [];
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, {
      ...baseOpts(feePayerKp),
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.ok).toBe(true);
    expect(released).toEqual([]);
  });

  // ── WKH-357 / AC-5 — el salteo de frescura para una tx con nonce durable ────
  //
  // El validador que devuelve `durableNonce: true`. Ojo con lo que este doble NO
  // prueba: acá el booleano se inyecta a mano, así que estos dos tests miden el
  // COMPORTAMIENTO DE `broadcast.ts` dado el booleano, no que CR-1 lo produzca. Que
  // CR-1 lo produzca (y sólo con la bandera prendida y la forma exacta) lo miden
  // T-10..T-14 en `solana-sponsor.durable-nonce.test.ts`. Son dos afirmaciones
  // distintas y ninguna cubre a la otra.
  const nonceValidator: SponsorTxValidator = () => ({
    ok: true,
    feeUpperBoundLamports: 5000n,
    durableNonce: true,
  });

  it('★ T-15 (AC-5): durableNonce → se co-firma y transmite aunque isBlockhashValid diga false, con 0 llamadas a la sonda', async () => {
    // `false` es la respuesta CORRECTA del RPC para el valor de una cuenta de nonce:
    // no está entre los ~150 blockhashes recientes. Sin el salteo, este `false`
    // rechazaría todo depósito por enlace.
    h.isBlockhashValidImpl.mockResolvedValue({ value: false });
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), validate: nonceValidator });
    expect(r.ok).toBe(true);
    expect(h.sendRawTransactionImpl).toHaveBeenCalledTimes(1);
    // Lo que separa "salteamos la sonda" de "la sonda dijo algo que ignoramos":
    // la sonda no se llama NI UNA VEZ.
    expect(h.isBlockhashValidImpl).toHaveBeenCalledTimes(0);
  });

  it('★ T-16 (AC-5): SIN durableNonce, la sonda se sigue llamando el MISMO número de veces que antes de WKH-357', async () => {
    // El número no está copiado de ningún documento: es el que produce el camino
    // feliz de hoy (Step 5 pre-firma + la re-verificación al tope del 1er intento),
    // y se afirma como igualdad exacta para que el salteo no pueda "filtrarse" al
    // camino sin nonce sin ponerse rojo.
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(true);
    expect(h.isBlockhashValidImpl).toHaveBeenCalledTimes(2);
  });
  // ══ WKH-367 — el motivo del fallo, que hasta acá se tiraba a la basura ═══════
  //
  // Los cuatro `catch` de `broadcastWithRebroadcast` no ligaban el error a ninguna
  // variable, así que el 502 del patrocinio salía con una constante y la noche del
  // incidente hubo que ir a mirar la cadena a mano. Estos tests miden el CONTENIDO del
  // campo, no su presencia: un `detail` con el motivo equivocado es peor que uno vacío.

  /** Corre el primitivo y devuelve la rama `ok:false` ya angostada. */
  async function fallo(opts: Partial<CosignOpts> = {}) {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, { ...baseOpts(feePayerKp), ...opts });
    if (r.ok) throw new Error('el fixture esperaba un fallo y el primitivo confirmó');
    return r;
  }

  it('★ T-1 (AC-N2/CD-11): de un SendTransactionError sale el motivo PELADO, sin firma ni logs', async () => {
    h.sendRawTransactionImpl.mockRejectedValue(
      new SendTransactionError({
        action: 'send',
        signature: 'S'.repeat(88),
        transactionMessage: 'custom program error: 0x1',
        logs: ['Program log: uno', 'Program log: dos'],
      }),
    );
    const r = await fallo();
    expect(r.detail).toBe('custom program error: 0x1');
    // Lo que mata al `e.message.slice(0, 160)`: ese `message` arranca con ~88 chars de
    // firma base58 y sigue con los logs de simulación, así que 160 chars NO llegan al
    // motivo. La igualdad de arriba sola no lo distingue si el mensaje fuera corto.
    expect(r.detail).not.toContain('resulted in an error');
    expect(r.detail).not.toContain('Logs:');
    expect(r.detail).not.toContain('S'.repeat(88));
  });

  it('★ T-2 (AC-N3): la firma que RETORNÓ el send viaja en `sentSignature`, con el motivo del confirm', async () => {
    h.sendRawTransactionImpl.mockResolvedValue('SIG_ABC');
    h.confirmTransactionImpl.mockRejectedValue(new Error('rpc timeout'));
    const r = await fallo();
    expect(r.sentSignature).toBe('SIG_ABC');
    expect(r.detail).toBe('rpc timeout');
  });

  it('★ T-2b (DT-4): con dos intentos que fallan distinto, `detail` es el del ÚLTIMO', async () => {
    h.sendRawTransactionImpl
      .mockRejectedValueOnce(new Error('primero'))
      .mockRejectedValueOnce(new Error('segundo'));
    const r = await fallo({ maxRebroadcasts: 1 });
    expect(r.detail).toBe('segundo');
  });

  it('T-3 (AC-N2): un Error común propaga su `message`', async () => {
    h.sendRawTransactionImpl.mockRejectedValue(new Error('socket hang up'));
    const r = await fallo();
    expect(r.detail).toBe('socket hang up');
  });

  it('★★ T-3b (A-1): el `detail` del BLOCKHASH_CHECK_FAILED es el de SU sonda, no el del send anterior', async () => {
    // Sin capturar en el `catch` de la sonda de frescura del tope del bucle, este return
    // sale con 'send boom': un motivo REAL pegado a un `reason` que no es el suyo. Es la
    // misatribución que esta HU existe para no cometer.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true }) // pre-firma
      .mockResolvedValueOnce({ value: true }) // tope del intento 0
      .mockRejectedValue(new Error('probe boom')); // tope del intento 1
    h.sendRawTransactionImpl.mockRejectedValue(new Error('send boom'));
    const r = await fallo({ maxRebroadcasts: 1 });
    expect(r.reason).toBe('BLOCKHASH_CHECK_FAILED');
    expect(r.detail).toBe('probe boom');
    expect(r.detail).not.toBe('send boom');
  });

  it('★★ T-3c (AR BLQ-BAJO-1): la tx ATERRIZÓ y falló on-chain → `detail` es el de ESE desenlace, no el del send anterior', async () => {
    // Reproducción exacta del AR. `confirmTransaction` RESUELVE con `value.err` — no tira,
    // así que no hay `catch` que lo capture. Sin A-2 el `detail` sale con el motivo del
    // intento 0 y el operador lee "el envío nunca pasó" sobre una tx que aterrizó y revirtió.
    h.sendRawTransactionImpl
      .mockRejectedValueOnce(new Error('send boom (intento 0)'))
      .mockResolvedValue('SIG_LANDED');
    h.confirmTransactionImpl.mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    const r = await fallo({ maxRebroadcasts: 1 });
    expect(r.reason).toBe('UNCONFIRMED_AFTER_REBROADCASTS');
    expect(r.sentSignature).toBe('SIG_LANDED');
    expect(r.detail).not.toContain('send boom');
    expect(r.detail).toBe('CONFIRMED_WITH_ERR:{"InstructionError":[0,{"Custom":1}]}');
  });

  it('★★ T-3d (AR BLQ-BAJO-1, control): el MISMO desenlace SIN error previo da el MISMO `detail`', async () => {
    // ⚠️ CR MNR-CR-5 — acá decía *"el par con T-3c es lo que prueba que no hay herencia"*, y
    // es medible-falso. Medido con dos mutantes sobre la captura de `conf.value.err`:
    //   M1  (borrar la captura)              ⇒ T-3c ✗  T-3d ✗  T-3f ✗
    //   M1b (`lastDetail ?? narrow…`, o sea  ⇒ T-3c ✗  T-3d ✓  T-3f ✗
    //        quedarse con el motivo viejo)      ← T-3d NO lo mata: sin error previo, `??` no
    //                                             tiene nada viejo que preferir.
    // La propiedad "no hay herencia" la cargan T-3c y T-3f, cada una sola. T-3d es el control
    // de LEGIBILIDAD — el mismo desenlace sin error previo da el mismo `detail`, así que el
    // campo lo pone el desenlace — y no es peso muerto, pero no es lo que sostiene el par.
    // Antes de A-2 este caso salía SIN `detail`, y T-3c salía con el motivo equivocado: la
    // misma raíz, dos síntomas opuestos.
    h.sendRawTransactionImpl.mockResolvedValue('SIG_LANDED');
    h.confirmTransactionImpl.mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    const r = await fallo({ maxRebroadcasts: 1 });
    expect(r.reason).toBe('UNCONFIRMED_AFTER_REBROADCASTS');
    expect(r.detail).toBe('CONFIRMED_WITH_ERR:{"InstructionError":[0,{"Custom":1}]}');
  });

  it('★ T-3e (CD-11): un `err` on-chain hostil NO tira y sale acotado a 160', async () => {
    // (a) circular ⇒ `JSON.stringify` TIRA. Si el narrowing dejara escapar ese TypeError,
    // el `catch` de confirmación lo atraparía y `detail` diría "Converting circular
    // structure to JSON" — un motivo NUESTRO disfrazado de motivo de la cadena.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    h.sendRawTransactionImpl.mockResolvedValue('SIG_LANDED');
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: circular } });
    const r1 = await fallo({ maxRebroadcasts: 0 });
    expect(r1.detail).toBe('CONFIRMED_WITH_ERR:[unserializable]');
    expect(r1.detail).not.toContain('circular');

    // (b) el mismo tope de 160 que el resto de los `detail`.
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: { Custom: 'y'.repeat(500) } } });
    const r2 = await fallo({ maxRebroadcasts: 0 });
    expect(r2.detail).toHaveLength(160);
  });

  it('★★ T-3f (AR BLQ-BAJO-1, 2da variante): el BLOCKHASH_EXPIRED tampoco hereda un error VIEJO', async () => {
    // La otra salida sin error propio. Con A-2 ya no puede quedarse con el motivo del
    // intento 0 cuando el intento 1 produjo uno más nuevo: `detail` es SIEMPRE lo último
    // que salió mal en esta transmisión, nunca lo anteúltimo.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true }) // pre-firma
      .mockResolvedValueOnce({ value: true }) // tope del intento 0
      .mockResolvedValueOnce({ value: true }) // tope del intento 1
      .mockResolvedValue({ value: false }); // tope del intento 2 → EXPIRED
    h.sendRawTransactionImpl
      .mockRejectedValueOnce(new Error('send boom (intento 0)'))
      .mockResolvedValue('SIG_LANDED');
    h.confirmTransactionImpl.mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    const r = await fallo({ maxRebroadcasts: 2 });
    expect(r.reason).toBe('BLOCKHASH_EXPIRED');
    expect(r.detail).not.toContain('send boom');
    expect(r.detail).toBe('CONFIRMED_WITH_ERR:{"InstructionError":[0,{"Custom":1}]}');
  });

  it('★★ T-3g (CR MNR-CR-3): un evento NO narrowable NO resucita el motivo anterior — los CUATRO sitios', async () => {
    // EL CANDADO DEL INVARIANTE de `broadcast.ts` (docblock de `CosignResult.detail`):
    // *"ningún error observado se descarta, así que `detail` es SIEMPRE lo ÚLTIMO que salió
    // mal, nunca lo anteúltimo"*. Hasta este test el invariante era prosa: el mutante
    // `lastDetail = narrowSendDetail(e) ?? lastDetail` en los cuatro sitios — que es
    // literalmente *"si el error nuevo no se puede narrowear, quedate con el anteúltimo"*,
    // o sea la única cosa que el invariante prohíbe — pasaba la suite COMPLETA en verde.
    //
    // La forma es la misma en los cuatro: un error REAL y narrowable en el intento 0, y en
    // el evento que CIERRA el camino una basura no narrowable (un string pelado ⇒
    // `narrowSendDetail` devuelve `undefined` a propósito, T-4). El invariante exige que el
    // campo se OMITA: el último error observado no tiene texto limpio, y el anterior ya no
    // describe este desenlace.
    //
    // ⚠️ CONTROL DE NO-VACUIDAD, para que este test no se pueda contar a sí mismo: en los
    // cuatro casos el error viejo entra por el `catch` del `sendRawTransaction`, que en la
    // MISMA línea pone `sent = true`. Assertar `r.sent === true` prueba que ese `catch`
    // corrió y que por lo tanto SÍ hubo un `lastDetail` anterior que heredar. Sin eso, un
    // `detail` ausente podría significar "nunca hubo nada", y el test pasaría vacío.
    const VIEJO = new Error('primero real');
    const BASURA = 'basura no-Error';

    interface Caso {
      readonly sitio: string;
      readonly opts: Partial<CosignOpts>;
      readonly reason: string;
      readonly montar: () => void;
    }
    const casos: readonly Caso[] = [
      {
        sitio: 'sonda de frescura al TOPE del bucle',
        opts: { maxRebroadcasts: 1 },
        reason: 'BLOCKHASH_CHECK_FAILED',
        montar: () => {
          h.isBlockhashValidImpl
            .mockResolvedValueOnce({ value: true }) // pre-firma
            .mockResolvedValueOnce({ value: true }) // tope del intento 0
            .mockRejectedValue(BASURA); // tope del intento 1 → cierra el camino
          h.sendRawTransactionImpl.mockRejectedValue(VIEJO);
        },
      },
      {
        sitio: 'catch de sendRawTransaction',
        opts: { maxRebroadcasts: 1 },
        reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
        montar: () => {
          h.sendRawTransactionImpl.mockRejectedValueOnce(VIEJO).mockRejectedValue(BASURA);
        },
      },
      {
        sitio: 'catch de confirmTransaction',
        opts: { maxRebroadcasts: 1 },
        reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
        montar: () => {
          h.sendRawTransactionImpl.mockRejectedValueOnce(VIEJO).mockResolvedValue('SIG_X');
          h.confirmTransactionImpl.mockRejectedValue(BASURA);
        },
      },
      {
        sitio: 'sonda de frescura FINAL (agotados los intentos)',
        opts: { maxRebroadcasts: 0 },
        reason: 'BLOCKHASH_CHECK_FAILED',
        montar: () => {
          h.isBlockhashValidImpl
            .mockResolvedValueOnce({ value: true }) // pre-firma
            .mockResolvedValueOnce({ value: true }) // tope del único intento
            .mockRejectedValue(BASURA); // sonda final → cierra el camino
          h.sendRawTransactionImpl.mockRejectedValue(VIEJO);
        },
      },
    ];

    for (const caso of casos) {
      h.isBlockhashValidImpl.mockReset();
      h.isBlockhashValidImpl.mockResolvedValue({ value: true });
      h.sendRawTransactionImpl.mockReset();
      h.confirmTransactionImpl.mockReset();
      h.confirmTransactionImpl.mockResolvedValue({ value: { err: null } });
      caso.montar();

      const r = await fallo(caso.opts);
      expect(r.reason, caso.sitio).toBe(caso.reason);
      expect(r.sent, `${caso.sitio} — control: el catch del send corrió`).toBe(true);
      expect('detail' in r, caso.sitio).toBe(false);
      expect(JSON.stringify(r), caso.sitio).not.toContain('primero real');
    }
  });

  it('★★ T-3h (CR MNR-CR-4): un CONFIRMED_WITH_ERR lo PISA el ruido de transporte de un reintento — decidido, no accidental', async () => {
    // DECISIÓN (fix-pack del CR, MNR-CR-4): se queda así. La asimetría es real —
    // `CONFIRMED_WITH_ERR:` es un veredicto TERMINAL de la cadena y lo pisa un `socket hang
    // up` de un reintento que ya no podía cambiar nada (la red dedupea por firma, así que
    // el reintento no puede producir OTRO desenlace on-chain). Aun así no se invierte la
    // precedencia, por dos razones medibles:
    //   1. hacerlo "pegajoso" introduce una SEGUNDA regla ("algunos errores valen más") que
    //      contradice el invariante que T-3g acaba de clavar (*ningún error observado se
    //      descarta*), y obliga a escribir una tabla de precedencia que hoy no existe;
    //   2. la información NO se pierde: `sentSignature` sobrevive intacta, y es el ancla con
    //      la que el operador va a mirar la cadena. El `detail` dice "lo último que salió
    //      mal"; el veredicto de la cadena se lee en la cadena, con esa firma.
    // Este test PINNEA la decisión: el día que alguien la quiera invertir, se pone rojo acá
    // y la discusión es explícita en vez de un cambio silencioso.
    h.sendRawTransactionImpl
      .mockResolvedValueOnce('SIG_LANDED')
      .mockRejectedValue(new Error('socket hang up'));
    h.confirmTransactionImpl.mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    const r = await fallo({ maxRebroadcasts: 1 });
    expect(r.detail).toBe('socket hang up');
    // La mitigación, y lo que hace tolerable la asimetría: la firma del envío que SÍ aterrizó
    // sigue en el log, así que el veredicto on-chain es recuperable en un solo salto.
    expect(r.sentSignature).toBe('SIG_LANDED');
  });

  it('★ T-4 (AC-N4): un no-Error NO produce clave — nunca "undefined" ni "[object Object]"', async () => {
    const basuras: readonly unknown[] = ['texto', undefined, {}];
    for (const basura of basuras) {
      h.sendRawTransactionImpl.mockReset();
      h.sendRawTransactionImpl.mockRejectedValue(basura);
      const r = await fallo();
      expect('detail' in r).toBe(false);
      expect(JSON.stringify(r)).not.toContain('undefined');
      expect(JSON.stringify(r)).not.toContain('[object Object]');
    }
  });

  it('★★ T-4b (AR MNR-2 + CR MNR-CR-2): un error HOSTIL no tira y no produce clave', async () => {
    // Las TRES entradas hostiles que `narrowSendDetail` tiene que sobrevivir. Corre DENTRO
    // de los `catch` del bucle, así que un throw suyo no lo atrapa nadie: convertiría el 502
    // con diagnóstico en un 500 sin nada. Ninguna es alcanzable con @solana/web3.js 1.98.4;
    // lo que se está clavando es la promesa del docblock, no un bug de hoy.
    //
    // ⚠️ CADA UNA MIDE UNA COSA DISTINTA — el comentario viejo decía "los dos caminos" y en
    // realidad clavaba UNO SOLO (CR MNR-CR-2):
    //   - `getterQueTira`         → el `try/catch` del helper. Sin él, el throw escapa.
    //   - `errorConMessageRaro`   → NO clava nada por sí solo: con `message = 123` el
    //                               mutante que borra el `typeof m === 'string'` hace
    //                               `(123).slice(...)`, que TIRA, y el mismo `try/catch` lo
    //                               absorbe ⇒ `undefined` igual. Queda por documentación.
    //   - `errorConMessageArray`  → ÉSTE clava el `typeof m === 'string'`. `[].slice` existe
    //                               y NO tira: el mutante devuelve un ARRAY en un campo
    //                               tipado `string | undefined`, y la ruta lo loguearía.
    const getterQueTira = {
      get transactionError(): unknown {
        throw new Error('getter hostil');
      },
    };
    const errorConMessageRaro = new Error('x');
    Object.defineProperty(errorConMessageRaro, 'message', { value: 123 });
    const errorConMessageArray = new Error('x');
    Object.defineProperty(errorConMessageArray, 'message', { value: ['fuga-a', 'fuga-b'] });

    for (const basura of [getterQueTira, errorConMessageRaro, errorConMessageArray] as const) {
      h.sendRawTransactionImpl.mockReset();
      h.sendRawTransactionImpl.mockRejectedValue(basura);
      const r = await fallo();
      expect('detail' in r).toBe(false);
      expect(r.code).toBe('SPONSOR_BROADCAST_FAILED');
      // `'detail' in r === false` no ve un valor no-string que se colara con otra clave.
      expect(JSON.stringify(r)).not.toContain('fuga-');
    }
  });

  it('★★ T-4c (AR MNR-3): con `transactionError.message` no-string NO se cae al `e.message` sucio', async () => {
    // El fallback tomaba el `message` COMPLETO del SendTransactionError: ~88 chars de
    // firma + los `Logs:` de simulación, justo lo que CD-11 prohíbe. Hoy es inalcanzable
    // (superstruct valida `message: string`), pero un bump de la librería lo abría sin
    // que nada se pusiera rojo. El campo se omite: sin candidato limpio, ninguno.
    const sucio = new Error(
      `Transaction ${'S'.repeat(88)} resulted in an error. \nfallo. \nLogs: \n["Program log: secreto"]. `,
    );
    Object.defineProperty(sucio, 'transactionError', { value: { message: 123, logs: ['x'] } });
    h.sendRawTransactionImpl.mockRejectedValue(sucio);
    const r = await fallo();
    expect('detail' in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain('Logs:');
    expect(JSON.stringify(r)).not.toContain('S'.repeat(88));
  });

  it('T-5 (CD-11): `detail` se trunca a 160 chars exactos', async () => {
    h.sendRawTransactionImpl.mockRejectedValue(new Error('x'.repeat(500)));
    const r = await fallo();
    expect(r.detail).toHaveLength(160);
  });

  it('★ T-6 (AC-N5): el camino feliz devuelve EXACTAMENTE { ok, signature }, sin diagnóstico', async () => {
    const feePayerKp = Keypair.generate();
    const tx = buildSignedTxBase64(feePayerKp, Keypair.generate());
    const r = await cosignAndBroadcast(tx, baseOpts(feePayerKp));
    expect(r.ok).toBe(true);
    expect(Object.keys(r).sort()).toEqual(['ok', 'signature']);
  });

  it('★★ T-7 (CD-8/AC-N7): con `detail` y `sentSignature` poblados, la cuenta del cap NO cambia', async () => {
    // Gemelo estructural del "no pude preguntar POSTERIOR a un envío" de más arriba: el
    // MISMO desenlace, ahora con los campos nuevos llenos. Si alguna rama los leyera
    // (`mayHaveSpent`, el switch, el código HTTP), este `released` dejaría de estar vacío.
    h.isBlockhashValidImpl
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: true })
      .mockRejectedValue(new Error('rpc down'));
    h.sendRawTransactionImpl.mockResolvedValue('SIGkept');
    h.confirmTransactionImpl.mockResolvedValue({ value: { err: 'InstructionError' } });
    const released: bigint[] = [];
    const r = await fallo({
      maxRebroadcasts: 1,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (lamports) => {
        released.push(lamports);
      },
    });
    expect(r.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(r.sent).toBe(true);
    expect(r.detail).toBe('rpc down');
    expect(r.sentSignature).toBe('SIGkept');
    expect(released).toEqual([]);
  });
});
