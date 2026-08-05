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
/** Separador de dominio del OTRO mecanismo (leg de payout, `buildSolanaPopMessage`
 *  de chaski). Literal a propósito: si se importara de algún lado seguiría al
 *  mutante que se quiere cazar. */
const PAYOUT_POP_DOMAIN = 'Chaski Proof-of-Possession';

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

function depositData(remittanceId: string, amountMinor: bigint, authority?: PublicKey): Buffer {
  const data = Buffer.alloc(DEPOSIT_DATA_LEN);
  Buffer.from([...DEPOSIT_DISCRIMINATOR]).copy(data, 0);
  createHash('sha256').update(remittanceId, 'utf8').digest().subarray(0, 16).copy(data, 8);
  Keypair.generate().publicKey.toBuffer().copy(data, 24); // beneficiary
  // La authority por default es un pubkey al azar — o sea la de un depósito que NADIE
  // podría liberar. Es el estado real de este archivo antes del Check 4d, y sigue
  // pasando porque en este entorno el check está DESARMADO (sin release-authority).
  (authority ?? Keypair.generate().publicKey).toBuffer().copy(data, 56); // authority
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
  /** `authority` grabada en `data[56..88]` — lo que CR-1 Check 4d compara. */
  authority?: PublicKey;
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
    data: depositData(
      opts?.remittanceId ?? REMITTANCE_ID,
      opts?.amountMinor ?? AMOUNT_MINOR,
      opts?.authority,
    ),
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
  // ⚠️ TIENE que ser el MISMO mint que `buildValidSponsorTx` pone en la ix: desde
  // que CR-1 clava el mint (cr1.ts, Check 4c), un valor distinto acá haría que
  // todo depósito de este archivo se rechace por MINT_MISMATCH. Antes eran dos
  // pubkeys distintos y no pasaba nada, porque nadie los comparaba.
  process.env.SOLANA_USDC_MINT = MINT.toBase58();
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
   * AR MNR-1 — `reference` salió del schema porque no tenía consumidor. Este test
   * clava las DOS mitades de esa decisión, que es lo que la vuelve verificable:
   * sin el campo el request pasa (el facilitator no lo necesita), y con el campo
   * también pasa (`z.object` descarta lo que no conoce, así que chaski puede
   * seguir mandándolo — de hecho lo manda, y el resto de este archivo lo prueba).
   * Si alguien lo vuelve a poner como requerido, la primera mitad se pone roja.
   */
  it('★ el facilitator NO necesita `reference`: sin el campo → 200, con el campo → 200', async () => {
    const sinReference = validBody();
    delete sinReference.reference;
    const res = await post(sinReference);
    expect(res.statusCode).toBe(200);
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
    if (app) {
      await app.close();
      app = undefined;
    }

    h.cosignSpy.mockReset();
    const conReference = await post(validBody());
    expect(conReference.statusCode).toBe(200);
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
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

    // ⚠️ El `tx:` va VACÍO a propósito. Quien manda este request controla la
    // billetera, así que firma el mensaje que un servidor SIN A2 construiría: sin
    // firma en la tx, la línea `tx` queda en blanco. Con la firma original adentro,
    // el 403 podría venir de Guard B y este test no diría nada sobre A2.
    //
    // Aun así, el 403 solo NO alcanza para probar que A2 hace algo, y se midió:
    // borrando la línea `if (senderSig === null)` de `sponsor-claims.ts` este
    // request SIGUE dando 403, porque `bs58.encode(Buffer.from(null))` tira y lo
    // absorbe el `catch` de `sponsor-claims.ts:110-116` con el mismo status y el
    // mismo `cosign`/`daily` sin invocar. Lo ÚNICO que cambia es el marcador:
    // `SENDER_SIGNATURE_NULL` pasa a `CLAIMS_EXTRACTION_FAILED:TypeError`. Por eso se
    // assertea el marcador — mismo recurso que T-A1, y §7.1 lo hace requisito
    // contractual de observabilidad, no un detalle interno.
    const message = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: '',
    });
    const popSignature = signMessage(built.senderKeypair, message);

    const cap = new CaptureStream();
    const res = await withLogs(() =>
      post(
        {
          partialSignedTx: stripped
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString('base64'),
          reference: Keypair.generate().publicKey.toBase58(),
          sender: built.senderKeypair.publicKey.toBase58(),
          remittanceId: REMITTANCE_ID,
          popSignature,
        },
        cap,
      ),
    );

    // Las TRES aserciones del AC-2, en este orden: el request se corta ANTES de
    // co-firmar y ANTES de reservar el cap diario, y con un 403 y no con un 500.
    expect(res.statusCode).toBe(403);
    expect(h.cosignSpy).not.toHaveBeenCalled();
    expect(h.dailySpy).not.toHaveBeenCalled();

    // La cuarta: quién cortó. Sin esto A2 se puede borrar y el test sigue verde.
    expect(cap.text().length).toBeGreaterThan(0);
    expect(cap.text()).toContain('SENDER_SIGNATURE_NULL');
    expect(res.body).not.toContain('SENDER_SIGNATURE_NULL');
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

  // ── T-B5 — reuso cross-protocol (el ataque #6 del §6 del SDD) ───────────────
  //
  // ⚠️ QUÉ PRUEBA Y QUÉ NO. Prueba que una firma AUTÉNTICA de la misma billetera,
  // producida minutos antes en el leg de payout, no sirve para pedir patrocinio.
  // NO prueba el separador de dominio: el challenge de payout difiere del mensaje
  // canónico en cinco cosas más allá de la primera línea (`address:` en vez de
  // `sender:`, `nonce:`, `expires:`, y la ausencia de `remittance`/`amount`/`mint`/
  // `tx`), así que seguiría dando 403 aunque el dominio se borrara entero. Se midió:
  // con `SPONSOR_POP_DOMAIN = 'Chaski Proof-of-Possession'` este test queda VERDE.
  // El que aísla el separador es T-B5b, acá abajo.
  it('★ T-B5: firma legítima del challenge del leg de payout enviada como popSignature → 403', async () => {
    const built = buildValidSponsorTx();
    // Mensaje REAL del otro mecanismo (`buildSolanaPopMessage` de chaski), firmado
    // por la MISMA billetera. Es una firma auténtica; lo que la invalida acá es que
    // habla de otro protocolo.
    const payoutChallenge = `${PAYOUT_POP_DOMAIN}\naddress: ${built.senderKeypair.publicKey.toBase58()}\nnetwork: ${NETWORK_ID}\nnonce: ${'a'.repeat(32)}\nexpires: 2000000000`;
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

  // ── T-B5b — el separador de dominio, aislado ────────────────────────────────
  it('★ T-B5b: mensaje idéntico al canónico salvo la línea del dominio → 403', async () => {
    const built = buildValidSponsorTx();
    const canonical = buildSponsorPopMessage({
      sender: built.senderKeypair.publicKey.toBase58(),
      networkId: NETWORK_ID,
      remittanceId: REMITTANCE_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      mint: MINT.toBase58(),
      txSignatureB58: built.senderSigB58,
    });
    // Se reemplaza SÓLO la primera línea. Las otras seis son, byte a byte, las que
    // el servidor va a armar desde la tx y su config: si el 403 llega, la única
    // causa posible es el separador. Y se arma pisando la salida del builder en vez
    // de re-tipear el formato, así que M7 (cambiar `SPONSOR_POP_DOMAIN` al dominio
    // del leg de payout) hace que las dos cadenas se vuelvan la MISMA y el servidor
    // acepte: el `not.toBe` de abajo cae primero y dice exactamente eso.
    const otherDomain = canonical.replace(/^[^\n]*/, PAYOUT_POP_DOMAIN);
    expect(otherDomain, 'el separador de dominio dejó de separar').not.toBe(canonical);

    const res = await post({
      partialSignedTx: built.base64,
      reference: Keypair.generate().publicKey.toBase58(),
      sender: built.senderKeypair.publicKey.toBase58(),
      remittanceId: REMITTANCE_ID,
      popSignature: signMessage(built.senderKeypair, otherDomain),
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

  // ── SOLANA_USDC_MINT → CR-1 (cableado) ──────────────────────────────────────
  /**
   * El primitivo está mockeado, así que CR-1 no corre por sí solo en este archivo.
   * Lo que estos tests agarran es el `validate` REAL que la ruta le pasó, o sea el
   * `Cr1Config` que la ruta armó con SU env. Un `Cr1Config` escrito a mano en un
   * test pasaría igual aunque la ruta se olvidara de poblar `usdcMint`.
   */
  interface CapturedOpts {
    validate: (tx: Transaction, feePayer: PublicKey) => { ok: boolean; reason?: string };
  }
  function capturedValidate(): CapturedOpts['validate'] {
    const call = h.cosignSpy.mock.calls[0] as [string, CapturedOpts] | undefined;
    if (call === undefined) throw new Error('el primitivo no se invocó: no hay validate que mirar');
    return call[1].validate;
  }

  it('★ el mint que CR-1 exige sale de SOLANA_USDC_MINT, no de una constante', async () => {
    const otroMint = Keypair.generate().publicKey;
    process.env.SOLANA_USDC_MINT = otroMint.toBase58();
    const res = await post(validBody());
    expect(res.statusCode).toBe(200);
    const validate = capturedValidate();
    // Con la env movida, el que pasa es el mint NUEVO...
    expect(validate(buildValidSponsorTx({ mint: otroMint }).tx, feePayerKp.publicKey).ok).toBe(
      true,
    );
    // ...y el de siempre deja de pasar. Si la ruta clavara el mint en el código o
    // no pasara `usdcMint`, una de las dos mitades se cae.
    const r = validate(buildValidSponsorTx().tx, feePayerKp.publicKey);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MINT_MISMATCH');
  });

  it('★ sin SOLANA_USDC_MINT, CR-1 rechaza hasta el depósito bueno (fail-closed)', async () => {
    // CD-10: se BORRA la variable, no se la pone en "".
    delete process.env.SOLANA_USDC_MINT;
    const res = await post(validBody());
    // 200 porque el primitivo está mockeado y nunca llama al validate; el punto del
    // test es qué contesta ESE validate, no el status.
    expect(res.statusCode).toBe(200);
    const r = capturedValidate()(buildValidSponsorTx().tx, feePayerKp.publicKey);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('USDC_MINT_NOT_CONFIGURED');
  });

  // ── SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY → CR-1 Check 4d (cableado) ────
  /**
   * Mismo método que los del mint: se agarra el `validate` REAL que la ruta le pasó al
   * primitivo. Un `Cr1Config` escrito a mano en un test pasaría igual aunque la ruta se
   * olvidara de poblar `releaseAuthority` — que es exactamente el modo en que un guard
   * nuevo puede quedar sin cablear y con la suite verde.
   */
  const RELEASE_KP = Keypair.generate();

  function withReleaseAuthorityEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = JSON.stringify(
      Array.from(RELEASE_KP.secretKey),
    );
    const restore = async (): Promise<void> => {
      if (saved === undefined) delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
      else process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = saved;
      const { resetReleaseAuthorityForTesting } =
        await import('../../infra/solana-release-authority.js');
      resetReleaseAuthorityForTesting();
    };
    return fn().then(
      async (v) => {
        await restore();
        return v;
      },
      async (e: unknown) => {
        await restore();
        throw e;
      },
    );
  }

  it('★ la authority que CR-1 exige sale de la env del release, no de una constante', async () => {
    await withReleaseAuthorityEnv(async () => {
      const { resetReleaseAuthorityForTesting } =
        await import('../../infra/solana-release-authority.js');
      resetReleaseAuthorityForTesting();
      const res = await post(validBody());
      expect(res.statusCode).toBe(200);
      const validate = capturedValidate();
      // El depósito que nombra NUESTRA authority pasa...
      expect(
        validate(buildValidSponsorTx({ authority: RELEASE_KP.publicKey }).tx, feePayerKp.publicKey)
          .ok,
      ).toBe(true);
      // ...y el que nombra otra (la env de chaski desalineada) deja de pasar. Si la
      // ruta no pasara `releaseAuthority`, la segunda mitad se cae.
      const r = validate(
        buildValidSponsorTx({ authority: Keypair.generate().publicKey }).tx,
        feePayerKp.publicKey,
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('DEPOSIT_AUTHORITY_MISMATCH');
    });
  });

  it('★★ sin la llave del release, el patrocinio NO se cae: el check queda desarmado', async () => {
    // La decisión de modo de falla, medida. `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`
    // NO está seteada en este entorno (una instancia sponsor-only, que es legítima).
    // Si el check rechazara ante su ausencia — como sí hace el del mint — tumbaría una
    // capacidad bien configurada por una env que no es suya.
    const res = await post(validBody());
    expect(res.statusCode).toBe(200);
    const r = capturedValidate()(
      buildValidSponsorTx({ authority: Keypair.generate().publicKey }).tx,
      feePayerKp.publicKey,
    );
    expect(r.ok).toBe(true);
  });

  it('★★ ...y ese desarme NO es silencioso: el arranque lo dice', async () => {
    const cap = new CaptureStream();
    await withLogs(() => post(validBody(), cap));
    expect(cap.text().length).toBeGreaterThan(0);
    expect(cap.text()).toContain('CR1_DEPOSIT_AUTHORITY');
    expect(cap.text()).toContain('DISARMED');
  });

  it('★ con la llave presente el arranque NO avisa de desarme', async () => {
    await withReleaseAuthorityEnv(async () => {
      const { resetReleaseAuthorityForTesting } =
        await import('../../infra/solana-release-authority.js');
      resetReleaseAuthorityForTesting();
      const cap = new CaptureStream();
      await withLogs(() => post(validBody(), cap));
      // El `warn` del desarme no aparece. (El `info` del armado no se mide acá: el
      // nivel del capture es 'warn', y subirlo mediría el logger, no este guard.)
      expect(cap.text()).not.toContain('DISARMED');
    });
  });

  it('★ el rechazo por mint sale como marcador al log y NO al cliente (no-oracle)', async () => {
    h.cosignResult.current = { ok: false, code: 'SPONSOR_REJECTED', reason: 'MINT_MISMATCH' };
    const cap = new CaptureStream();
    const res = await withLogs(() => post(validBody(), cap));
    expect(res.statusCode).toBe(422);
    expect(errorCode(res.body)).toBe('SPONSOR_REJECTED');
    expect(cap.text()).toContain('MINT_MISMATCH');
    expect(res.body).not.toContain('MINT_MISMATCH');
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

  // ── ★ observabilidad del 422 ────────────────────────────────────────────────
  //
  // ⚠️ EL AGUJERO QUE ESTOS DOS TESTS TAPAN, y por qué son DOS y no uno. El
  // camino 403 ya pasaba su marcador a `fail()` (T-A1/T-A2 lo asertan); el 422
  // no pasaba NADA, y es el que colapsa ~34 motivos distintos de `cr1.ts` +
  // `broadcast.ts` en un solo `error_code: SPONSOR_REJECTED`. Consecuencia
  // medible: un tope mal configurado en el deploy (`PRIORITY_FEE_ABOVE_MAX`) y
  // una transacción corrupta (`BAD_DISCRIMINATOR`) producían logs IDÉNTICOS.
  //
  // Los dos tests tiran en direcciones opuestas a propósito: el primero exige
  // que el motivo ESTÉ en el log, el segundo que NO esté en la respuesta. Sin el
  // segundo, "arreglar" el primero metiendo el motivo en `error.message`
  // quedaría verde y convertiría la ruta en un oráculo (CD-12).

  it('★ el 422 del primitivo escribe el motivo del rechazo en el log', async () => {
    // `PRIORITY_FEE_ABOVE_MAX` es el caso "mal configurado": el operador tiene
    // que poder verlo sin adivinar. Va como literal (no importado) para que
    // seguir el rename de una constante no lo vuelva vacuo.
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_REJECTED',
      reason: 'PRIORITY_FEE_ABOVE_MAX',
    };
    const cap = new CaptureStream();
    const res = await withLogs(() => post(validBody(), cap));

    expect(res.statusCode).toBe(422);
    expect(errorCode(res.body)).toBe('SPONSOR_REJECTED');
    // Precondición: el stream capturó ALGO (si no, el toContain de abajo mide
    // el vacío y el test no prueba nada).
    expect(cap.text().length).toBeGreaterThan(0);
    expect(cap.text()).toContain('PRIORITY_FEE_ABOVE_MAX');
  });

  it('★ el 422 que corta en el parseo también escribe su motivo en el log', async () => {
    // Otro sitio de 422, ANTES del primitivo: la tx no deserializa. Su motivo
    // (`DESERIALIZE_FAILED`) sale de `parseSponsorTx`, no de `cosignAndBroadcast`,
    // así que el test anterior no lo cubre.
    const cap = new CaptureStream();
    const res = await withLogs(() =>
      post(validBody({ partialSignedTx: Buffer.from('deadbeef').toString('base64') }), cap),
    );

    expect(res.statusCode).toBe(422);
    expect(cap.text().length).toBeGreaterThan(0);
    expect(cap.text()).toContain('DESERIALIZE_FAILED');
    expect(res.body).not.toContain('DESERIALIZE_FAILED');
  });

  it('★ no-oracle: el motivo del rechazo NUNCA viaja en la respuesta del 422', async () => {
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_REJECTED',
      reason: 'PRIORITY_FEE_ABOVE_MAX',
    };
    const res = await post(validBody());

    expect(res.statusCode).toBe(422);
    // El mensaje al cliente es el genérico, textual: si alguien lo interpola con
    // el motivo (`...: ${result.reason}`) este assert cae antes que el siguiente.
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('Transaction rejected by validation');
    // Y el motivo no aparece en NINGUNA parte del cuerpo (ni en un campo nuevo).
    expect(res.body).not.toContain('PRIORITY_FEE_ABOVE_MAX');
  });
});
