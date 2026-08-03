/**
 * WKH-217 / HU-SOL-14 — POST /solana/sponsor (T17-T19), reescrito por SDD 037.
 *
 * La ruta se ejercita con `app.inject()` (sin puerto). El primitivo de broadcast y
 * los caps anti-abuso están mockeados (`vi.mock` + estado hoisteado), así que no
 * se toca ni la red ni Redis; los guards de autorización son REALES.
 *
 * ⚠️ POR QUÉ ACÁ HAY UNA TX DE VERDAD Y ANTES NO. Hasta el SDD 037 todos los
 * tests de este archivo mandaban `Buffer.from('deadbeef')` como `partialSignedTx`
 * y pasaban, porque la ruta no deserializaba nada: el mock de `cosignAndBroadcast`
 * se tragaba el string. Con el orden de guards nuevo la ruta parsea en el paso 2,
 * así que un basural ya no llega ni al primer guard. `buildValidSponsorTx` arma
 * una `Transaction` legacy real, con una ix `deposit` de 104 bytes y la firma de
 * la billetera puesta de verdad.
 *
 * El otro cambio de fondo: `checkAndIncrSponsorDailyLamports` pasa a ser un
 * `vi.fn()` hoisteado. Antes era una arrow suelta y NO se podía assertear que no
 * se hubiera invocado — que es exactamente lo que T-A2 tiene que probar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import type * as SponsorBroadcastModule from '../../methods/solana-sponsor/broadcast.js';
import { buildSponsorPopMessage } from '../../methods/solana-sponsor/sponsor-pop.js';
import {
  AMOUNT_OFFSET,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEPOSIT_DATA_LEN,
  DEPOSIT_DISCRIMINATOR,
  ESCROW_PROGRAM_ID_DEFAULT,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../../methods/solana-sponsor/deposit-shape.js';

const bs58 = utils.bytes.bs58;

const h = vi.hoisted(() => ({
  cosignResult: {
    current: { ok: true, signature: 'SIGabc123' } as
      | { ok: true; signature: string }
      | { ok: false; code: string; reason: string },
  },
  cosignSpy: vi.fn(),
  rateResult: { current: { ok: true } as { ok: boolean; reason?: string } },
  dailyResult: { current: { ok: true } as { ok: boolean; reason?: string } },
  /** SDD 037 — hoisteado como `vi.fn()` para poder assertear que NO se invocó. */
  dailySpy: vi.fn(),
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

vi.mock('../../core/solana-sponsor-cap.js', () => ({
  checkAndIncrSponsorRate: () => Promise.resolve(h.rateResult.current),
  checkAndIncrSponsorDailyLamports: (...args: unknown[]) => {
    h.dailySpy(...args);
    return Promise.resolve(h.dailyResult.current);
  },
  releaseSponsorDailyLamports: () => Promise.resolve(),
}));

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
 * esto, cualquier `expect(cap.text()).not.toContain(...)` pasa por vacío: no
 * prueba que el secreto no se loguee, prueba que no se logueó nada.
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

const feePayerKp = Keypair.generate();
const KEY_JSON = JSON.stringify(Array.from(feePayerKp.secretKey));
const NETWORK_ID = 'solana:devnet';
const MINT = new PublicKey(
  // eslint-disable-next-line no-secrets/no-secrets -- mint USDC devnet de Circle (base58 público), no es un secreto.
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);
const REMITTANCE_ID = 'rem_037_route';
const AMOUNT_MINOR = 10000000n;

// ── Helpers de firma ─────────────────────────────────────────────────────────

/** Firma ed25519 cruda con la seed de un Keypair de Solana, vía `node:crypto`. */
function signMessage(kp: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(kp.secretKey.subarray(0, 32)),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return bs58.encode(cryptoSign(null, Buffer.from(message, 'utf8'), key));
}

function depositData(remittanceId: string, amountMinor: bigint): Buffer {
  const data = Buffer.alloc(DEPOSIT_DATA_LEN);
  Buffer.from([...DEPOSIT_DISCRIMINATOR]).copy(data, 0);
  createHash('sha256').update(remittanceId, 'utf8').digest().subarray(0, 16).copy(data, 8);
  Keypair.generate().publicKey.toBuffer().copy(data, 24); // beneficiary
  Keypair.generate().publicKey.toBuffer().copy(data, 56); // authority
  data.writeBigUInt64LE(amountMinor, AMOUNT_OFFSET);
  data.writeBigInt64LE(1900000000n, 96);
  return data;
}

interface ValidSponsorTx {
  readonly base64: string;
  readonly senderKeypair: Keypair;
  readonly senderSigB58: string;
  readonly tx: Transaction;
}

/**
 * Arma una tx legacy REAL con una ix `deposit` y la firma parcial de la billetera.
 * Es el reemplazo del `deadbeef` que este archivo usaba: sin esto, la ruta corta
 * en 422 antes de llegar a ningún guard y los tests miden otra cosa.
 */
function buildValidSponsorTx(opts?: {
  senderKeypair?: Keypair;
  amountMinor?: bigint;
  mint?: PublicKey;
  remittanceId?: string;
}): ValidSponsorTx {
  const senderKeypair = opts?.senderKeypair ?? Keypair.generate();
  const mint = opts?.mint ?? MINT;
  const ix = new TransactionInstruction({
    programId: new PublicKey(ESCROW_PROGRAM_ID_DEFAULT),
    keys: [
      { pubkey: senderKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // escrow_state
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // vault
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // sender_ata
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: depositData(opts?.remittanceId ?? REMITTANCE_ID, opts?.amountMinor ?? AMOUNT_MINOR),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(senderKeypair);

  const entry = tx.signatures.find((s) => s.publicKey.equals(senderKeypair.publicKey));
  const sig = entry?.signature;
  if (!sig) throw new Error('fixture inválido: la firma del sender no quedó puesta');

  return {
    base64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    senderKeypair,
    senderSigB58: bs58.encode(Buffer.from(sig)),
    tx,
  };
}

interface SponsorBody {
  partialSignedTx: string;
  reference: string;
  sender: string;
  remittanceId: string;
  popSignature: string;
}

/** Request completamente válido: el que el resto de los tests degrada de a un campo. */
function validBody(overrides: Partial<SponsorBody> = {}): Record<string, unknown> {
  const built = buildValidSponsorTx();
  const message = buildSponsorPopMessage({
    sender: built.senderKeypair.publicKey.toBase58(),
    networkId: NETWORK_ID,
    remittanceId: REMITTANCE_ID,
    amountMinor: AMOUNT_MINOR.toString(),
    mint: MINT.toBase58(),
    txSignatureB58: built.senderSigB58,
  });
  return {
    partialSignedTx: built.base64,
    reference: Keypair.generate().publicKey.toBase58(),
    sender: built.senderKeypair.publicKey.toBase58(),
    remittanceId: REMITTANCE_ID,
    popSignature: signMessage(built.senderKeypair, message),
    ...overrides,
  };
}

// ── Env ──────────────────────────────────────────────────────────────────────

interface SavedEnv {
  enabled?: string;
  key?: string;
  rpc?: string;
  mint?: string;
  networkId?: string;
}
const savedEnv: SavedEnv = {};

function applySponsorEnv(): void {
  savedEnv.enabled = process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  savedEnv.key = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  savedEnv.rpc = process.env.SOLANA_RPC_URL;
  savedEnv.mint = process.env.SOLANA_USDC_MINT;
  savedEnv.networkId = process.env.SOLANA_SPONSOR_NETWORK_ID;
  process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'true';
  process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = KEY_JSON;
  process.env.SOLANA_RPC_URL = 'http://mock-rpc';
  process.env.SOLANA_USDC_MINT = 'So11111111111111111111111111111111111111112';
  process.env.SOLANA_SPONSOR_NETWORK_ID = NETWORK_ID;
}

function restoreSponsorEnv(): void {
  if (savedEnv.enabled === undefined) delete process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  else process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = savedEnv.enabled;
  if (savedEnv.key === undefined) delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  else process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = savedEnv.key;
  if (savedEnv.rpc === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = savedEnv.rpc;
  if (savedEnv.mint === undefined) delete process.env.SOLANA_USDC_MINT;
  else process.env.SOLANA_USDC_MINT = savedEnv.mint;
  if (savedEnv.networkId === undefined) delete process.env.SOLANA_SPONSOR_NETWORK_ID;
  else process.env.SOLANA_SPONSOR_NETWORK_ID = savedEnv.networkId;
}

async function buildSponsorApp(capture?: CaptureStream): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  resetRedisClientForTests();
  resetFeePayerForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ loggerDestination: capture, skipDomainCheck: true });
}

describe('POST /solana/sponsor', () => {
  let app: FastifyInstance | undefined;

  async function post(payload: unknown, capture?: CaptureStream) {
    app = await buildSponsorApp(capture);
    return app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  }

  function errorCode(body: string): string {
    return (JSON.parse(body) as { error: { code: string } }).error.code;
  }

  beforeEach(() => {
    applySponsorEnv();
    h.cosignResult.current = { ok: true, signature: 'SIGabc123' };
    h.cosignSpy.mockReset();
    h.dailySpy.mockReset();
    h.rateResult.current = { ok: true };
    h.dailyResult.current = { ok: true };
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreSponsorEnv();
    vi.clearAllMocks();
  });

  // ── T18 — happy e2e (mocked) ────────────────────────────────────────────────
  it('T18: request válido + CR-1/broadcast mock → 200 { signature }', async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { signature: string };
    expect(body.signature).toBe('SIGabc123');
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  // ── T17a / T-B6 — sin popSignature ──────────────────────────────────────────
  it('★ T17a / T-B6: sin popSignature → 400 INVALID_PAYLOAD, nunca se co-firma', async () => {
    const body = validBody();
    delete body.popSignature;
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('INVALID_PAYLOAD');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.dailySpy).not.toHaveBeenCalled();
  });

  it('sin remittanceId → 400 INVALID_PAYLOAD (el campo entró al schema)', async () => {
    const body = validBody();
    delete body.remittanceId;
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('INVALID_PAYLOAD');
  });

  /**
   * ⚠️ ÚNICO lugar del repo donde sobrevive el nombre del campo viejo, y es a
   * propósito. El AC-11 pide que no queden referencias VIVAS al HMAC borrado;
   * ésta no lo es: es la prueba de que ese campo ya no autoriza nada. El literal
   * es el formato de cable que un cliente desactualizado manda, así que
   * reemplazarlo por otra cosa borraría lo que el test verifica.
   *
   * Es también el desenlace que el §2.2 elige para la ventana de contrato
   * desalineado: con el facilitator desplegado primero, el cliente viejo se
   * choca contra el Zod (400), sin firmar y sin reservar cap.
   */
  it('★ el schema viejo (popProof) ya no autoriza nada → 400', async () => {
    const body = validBody();
    delete body.popSignature;
    body.popProof = 'a'.repeat(64);
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('INVALID_PAYLOAD');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.dailySpy).not.toHaveBeenCalled();
  });

  // ── T17b / T-A3 / T-B1 — firma que no verifica ──────────────────────────────
  it('★ T17b / T-A3 / T-B1: popSignature de 64 bytes al azar → 403 SPONSOR_SENDER_PROOF_INVALID, no se co-firma', async () => {
    const random = bs58.encode(Buffer.alloc(64, 0x5a));
    const res = await post(validBody({ popSignature: random }));
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe('SPONSOR_SENDER_PROOF_INVALID');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.dailySpy).not.toHaveBeenCalled();
  });

  it('el 403 NO le dice al cliente cuál guard cortó (no-oracle)', async () => {
    const res = await post(validBody({ popSignature: bs58.encode(Buffer.alloc(64, 1)) }));
    const body = JSON.parse(res.body) as { error: { message: string } };
    expect(body.error.message).toBe('sender signature does not authorize this transaction');
    expect(res.body).not.toContain('POP_SIGNATURE_INVALID');
  });

  // ── T-A1 — body.sender mentido ──────────────────────────────────────────────
  it('★ T-A1: tx firmada por V con body.sender = A y firma de A → 403, no se co-firma', async () => {
    // V arma y firma una tx real. A es el atacante: NO tocó esa tx.
    const victim = buildValidSponsorTx();
    const attacker = Keypair.generate();
    // A firma un mensaje impecable que se nombra a sí mismo y lleva la firma de V.
    const message = buildSponsorPopMessage({
      sender: attacker.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: victim.senderSigB58,
    });
    const cap = new CaptureStream();
    const res = await withLogs(() =>
      post(
        {
          partialSignedTx: victim.base64,
          reference: Keypair.generate().publicKey.toBase58(),
          sender: attacker.publicKey.toBase58(),
          remittanceId: REMITTANCE_ID,
          popSignature: signMessage(attacker, message),
        },
        cap,
      ),
    );
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe('SPONSOR_SENDER_PROOF_INVALID');
    expect(h.cosignSpy).not.toHaveBeenCalled();

    // ⚠️ POR QUÉ SE MIRA EL MARCADOR Y NO ALCANZA EL 403. Este request lo rechazan
    // DOS guards independientes: A1 (el body miente sobre quién es el sender) y
    // Guard B (la firma de `A` no verifica contra el pubkey de `V`, que es el que
    // sale de la tx). Se midió: borrando A1 el status sigue siendo 403 y ningún
    // otro test cambia de color. Assertear sólo el 403 dejaría a A1 sin ninguna
    // red — se podría borrar y la suite seguiría verde.
    expect(cap.text()).toContain('A1_SENDER_MISMATCH');
    expect(res.body).not.toContain('A1_SENDER_MISMATCH');
  });

  // ── T-A2 — firma del sender en null ─────────────────────────────────────────
  it('★ T-A2: firma del sender puesta en null → 403 (no 500), sin co-firmar y SIN reservar cap diario', async () => {
    const built = buildValidSponsorTx();

    // Vaciar la firma del sender y re-serializar.
    const stripped = Transaction.from(Buffer.from(built.base64, 'base64'));
    const entry = stripped.signatures.find((s) =>
      s.publicKey.equals(built.senderKeypair.publicKey),
    );
    expect(entry?.signature).not.toBeNull();
    if (entry) entry.signature = null;

    // ⚠️ El `tx:` va VACÍO a propósito, y esto es lo que le da filo al test.
    // Quien manda este request controla la billetera, así que firma el mensaje que
    // un servidor SIN A2 construiría: sin firma en la tx, la línea `tx` queda en
    // blanco. Si el mensaje llevara la firma original, el 403 podría venir de
    // Guard B y borrar A2 no rompería nada. Así, el único que puede cortar es A2.
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: '',
    });
    const popSignature = signMessage(built.senderKeypair, message);

    const res = await post({
      partialSignedTx: stripped
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature,
    });

    // Las TRES aserciones del AC-2, en este orden. Antes del SDD 037 esta misma
    // tx llegaba hasta `tx.partialSign(feePayer)`, reventaba en `serialize()` con
    // un 500 y encima dejaba TOMADA la reserva del cap diario.
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.dailySpy).not.toHaveBeenCalled();
  });

  // ── T-B2 — la firma está atada a UNA transacción ────────────────────────────
  it('★ T-B2: (mensaje, popSignature) legítimo reusado con OTRA tx del mismo sender → 403', async () => {
    const sender = Keypair.generate();
    const first = buildValidSponsorTx({ senderKeypair: sender });
    const message = buildSponsorPopMessage({
      sender: sender.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: first.senderSigB58,
    });
    const popSignature = signMessage(sender, message);

    // Misma billetera, mismo monto, mismo id: sólo cambia el blockhash ⇒ otra firma.
    const second = buildValidSponsorTx({ senderKeypair: sender });
    expect(second.senderSigB58).not.toBe(first.senderSigB58);

    const res = await post({
      partialSignedTx: second.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: sender.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature,
    });
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── T-B3 — el remittanceId del body tiene que ser el de la tx ───────────────
  it('★ T-B3: remittanceId del body distinto del que lleva la ix → 403', async () => {
    const built = buildValidSponsorTx({ remittanceId: 'rem_el_de_la_tx' });
    const otherId = 'rem_el_del_body';
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: otherId,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: built.senderSigB58,
    });
    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: otherId,
      popSignature: signMessage(built.senderKeypair, message),
    });
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── T-B4 — la red sale de la config, no del body ────────────────────────────
  it('★ T-B4: mensaje firmado con network: solana:mainnet contra un facilitator de devnet → 403', async () => {
    const built = buildValidSponsorTx();
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: 'solana:mainnet',
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: built.senderSigB58,
    });
    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature: signMessage(built.senderKeypair, message),
      // El atacante DECLARA la red que firmó. Hoy el schema ignora este campo.
      // Va en el request igual, para que el día que alguien lea `network` del body
      // en vez de la config (M5) este test se ponga rojo en vez de seguir verde.
      network: 'solana:mainnet',
    });
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── T-B5 — separador de dominio ─────────────────────────────────────────────
  it('★ T-B5: firma legítima del challenge del leg de payout enviada como popSignature → 403', async () => {
    const built = buildValidSponsorTx();
    // Mensaje REAL del otro mecanismo (`buildSolanaPopMessage` de chaski), firmado
    // por la MISMA billetera. Es una firma auténtica; lo que la invalida acá es que
    // habla de otro dominio.
    const payoutChallenge = `Chaski Proof-of-Possession\naddress: ${built.senderKeypair.publicKey.toBase58()}\nnetwork: ${NETWORK_ID}\nnonce: ${'a'.repeat(32)}\nexpires: 2000000000`;
    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature: signMessage(built.senderKeypair, payoutChallenge),
    });
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── T-B7 — largo exacto de 64 bytes ─────────────────────────────────────────
  it('★ T-B7: firmas de 63 y de 65 bytes → 403 en las dos', async () => {
    for (const len of [63, 65]) {
      h.cosignSpy.mockReset();
      const res = await post(validBody({ popSignature: bs58.encode(Buffer.alloc(len, 7)) }));
      expect(res.statusCode, `largo ${len}`).toBe(403);
      expect(h.cosignSpy, `largo ${len}`).not.toHaveBeenCalled();
      if (app) {
        await app.close();
        app = undefined;
      }
    }
  });

  // ── T-B8 — el amount se re-deriva de la ix ──────────────────────────────────
  it('★ T-B8: mensaje que declara amount: 1 mientras la ix mueve 10000000 → 403', async () => {
    const built = buildValidSponsorTx({ amountMinor: 10000000n });
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: '1', // lo que la persona leyó
      mint: MINT.toBase58(),
      txSignatureB58: built.senderSigB58,
    });
    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature: signMessage(built.senderKeypair, message),
      // Mismo criterio que en T-B4: el atacante declara el monto que firmó. El
      // schema lo ignora hoy; el campo va igual para que M11 (armar la línea
      // `amount` desde el body en vez de la ix) rompa este test.
      amount: '1',
    });
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ el mint también se re-deriva: un mensaje que nombra otro mint → 403', async () => {
    const built = buildValidSponsorTx();
    const attackerMint = Keypair.generate().publicKey.toBase58();
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: attackerMint,
      txSignatureB58: built.senderSigB58,
    });
    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature: signMessage(built.senderKeypair, message),
      mint: attackerMint,
    });
    expect(res.statusCode).toBe(403);
  });

  // ── SOLANA_SPONSOR_NETWORK_ID ausente ⇒ fail-closed ─────────────────────────
  it('★ sin SOLANA_SPONSOR_NETWORK_ID → 403, sin co-firmar, con marcador propio en el log', async () => {
    // CD-10: se BORRA la variable, no se la pone en "" — un string vacío es otro caso.
    delete process.env.SOLANA_SPONSOR_NETWORK_ID;
    const cap = new CaptureStream();
    const res = await withLogs(() => post(validBody(), cap));
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe('SPONSOR_SENDER_PROOF_INVALID');
    expect(h.cosignSpy).not.toHaveBeenCalled();
    // El operador tiene que poder separar "mal configurado" de "me están atacando".
    expect(cap.text()).toContain('NETWORK_ID_UNSET');
    // Pero el cliente no se entera de nada de eso.
    expect(res.body).not.toContain('NETWORK_ID_UNSET');
  });

  // ── Parseo de la tx ─────────────────────────────────────────────────────────
  it('partialSignedTx que no deserializa → 422 SPONSOR_REJECTED, sin llegar a los guards', async () => {
    const res = await post(
      validBody({ partialSignedTx: Buffer.from('deadbeef').toString('base64') }),
    );
    expect(res.statusCode).toBe(422);
    expect(errorCode(res.body)).toBe('SPONSOR_REJECTED');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  // ── Mapeo de errores del primitivo ──────────────────────────────────────────
  it('maps SPONSOR_REJECTED → 422', async () => {
    h.cosignResult.current = { ok: false, code: 'SPONSOR_REJECTED', reason: 'BAD_DISCRIMINATOR' };
    const res = await post(validBody());
    expect(res.statusCode).toBe(422);
    expect(errorCode(res.body)).toBe('SPONSOR_REJECTED');
  });

  it('maps SPONSOR_BROADCAST_EXPIRED → 409 and rate store fail-closed → 429', async () => {
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'STALE_BLOCKHASH',
    };
    const expired = await post(validBody());
    expect(expired.statusCode).toBe(409);
    if (app) {
      await app.close();
      app = undefined;
    }

    h.rateResult.current = { ok: false, reason: 'store_error_failclosed' };
    const limited = await post(validBody());
    expect(limited.statusCode).toBe(429);
  });

  // ── T19 — privkey never in logs/errors (AC-10) ──────────────────────────────
  it('★ T19: forced error → private key never appears in logs nor error body', async () => {
    const cap = new CaptureStream();
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED',
    };
    const res = await withLogs(() => post(validBody(), cap));
    expect(res.statusCode).toBe(502);
    // Precondición: el stream capturó ALGO. Sin este assert, los dos `not.toContain`
    // de abajo pasan por vacío y T19 deja de probar lo que dice probar.
    expect(cap.text().length).toBeGreaterThan(0);
    // The 64-byte secret key JSON must NEVER appear in logs nor the response.
    expect(cap.text()).not.toContain(KEY_JSON);
    expect(res.body).not.toContain(KEY_JSON);
    // A couple of raw secret bytes as a sanity substring check.
    const secretHead = Array.from(feePayerKp.secretKey.slice(0, 8)).join(',');
    expect(cap.text()).not.toContain(secretHead);
  });
});
