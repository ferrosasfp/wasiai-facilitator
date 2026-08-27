/**
 * POST /solana/sponsor — los TRES desenlaces de un broadcast, por separado.
 *
 * `salió` / `no salió` / `NO SÉ`. El tercero existe porque los otros dos mienten en su
 * caso: `SPONSOR_BROADCAST_EXPIRED` se emite también desde sondas que corren DESPUÉS de
 * un `sendRawTransaction` exitoso (broadcast.ts:372-388 y :425-440), y el `catch` de esas
 * sondas significa "no pude preguntar", no "el blockhash venció" — está escrito en
 * broadcast.ts:145-151. `CosignResult.sent` es lo único que los separa, y esta ruta lo
 * descartaba.
 *
 * Cada test fija el desenlace en las CUATRO superficies donde se puede mentir: código
 * HTTP, código de error, mensaje y log. La QUINTA es la contabilidad del cap diario
 * (devolver los lamports reservados afirma "no se gastó"), y como esa decisión vive en
 * el primitivo la cubre `solana-sponsor.broadcast.test.ts`.
 *
 * El primitivo `cosignAndBroadcast` es un doble: acá se mide la TRADUCCIÓN que hace la
 * ruta de su resultado, no el primitivo.
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

/** El resultado que el doble del primitivo devuelve. `sent` es el eje del test. */
type CosignFake =
  | { ok: true; signature: string }
  | {
      ok: false;
      code: string;
      reason: string;
      sent?: boolean;
      // WKH-367: los dos campos de diagnóstico que la ruta traduce a log.
      detail?: string;
      sentSignature?: string;
    };

const h = vi.hoisted(() => ({
  cosignResult: {
    current: { ok: true, signature: 'SIGsponsor-happy' } as unknown,
  },
}));

vi.mock('../../methods/solana-sponsor/broadcast.js', async (importActual) => {
  const actual = await importActual<typeof SponsorBroadcastModule>();
  return {
    ...actual, // `parseSponsorTx` queda REAL: la ruta parsea la tx en su Step 2.
    cosignAndBroadcast: () => Promise.resolve(h.cosignResult.current),
  };
});

vi.mock('../../core/solana-sponsor-cap.js', () => ({
  checkAndIncrSponsorRate: () => Promise.resolve({ ok: true }),
  checkAndIncrSponsorDailyLamports: () => Promise.resolve({ ok: true }),
  releaseSponsorDailyLamports: () => Promise.resolve(),
}));

const feePayerKp = Keypair.generate();
const KEY_JSON = JSON.stringify(Array.from(feePayerKp.secretKey));
const NETWORK_ID = 'solana:devnet';
const MINT = new PublicKey(
  // eslint-disable-next-line no-secrets/no-secrets -- mint USDC devnet de Circle (base58 público), no es un secreto.
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);
/**
 * AR MNR-1 — el program id de este fixture es DISTINTO del default de `env.ts`.
 *
 * Con el default, `cr1cfg.escrowProgramId` y `ESCROW_PROGRAM_ID_DEFAULT` valen lo mismo y
 * T-8 no puede distinguirlos: un mutante que hardcodee el default en la ruta pasa verde.
 * Y no es hipotético — `chains/escrow-program-id.ts` documenta que el program id YA rotó,
 * o sea que en prod el override está seteado: la regresión loguearía un `escrow_pda` que
 * no existe en la cadena, el falso "no aterrizó" que esta HU existe para evitar.
 *
 * Se DERIVA de una frase (sha256) en vez de pegarse como literal: así no dispara
 * `no-secrets` y quien revise lo puede regenerar sin creerme.
 */
const TEST_PROGRAM_ID = new PublicKey(
  createHash('sha256').update('wkh367-outcome-program', 'utf8').digest(),
).toBase58();
const REMITTANCE_ID = 'rem_outcome_sponsor';
const AMOUNT_MINOR = 10000000n;

/** Firma ed25519 cruda con la seed de un Keypair de Solana, vía `node:crypto`. */
function signMessage(kp: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(kp.secretKey.subarray(0, 32)),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return bs58.encode(cryptoSign(null, Buffer.from(message, 'utf8'), key));
}

function depositData(): Buffer {
  const data = Buffer.alloc(DEPOSIT_DATA_LEN);
  Buffer.from([...DEPOSIT_DISCRIMINATOR]).copy(data, 0);
  createHash('sha256').update(REMITTANCE_ID, 'utf8').digest().subarray(0, 16).copy(data, 8);
  Keypair.generate().publicKey.toBuffer().copy(data, 24); // beneficiary
  Keypair.generate().publicKey.toBuffer().copy(data, 56); // authority (check 4d desarmado acá)
  data.writeBigUInt64LE(AMOUNT_MINOR, AMOUNT_OFFSET);
  data.writeBigInt64LE(1900000000n, 96);
  return data;
}

/** Request válido de punta a punta: los guards de autorización son REALES. */
function validBody(): Record<string, unknown> {
  const senderKeypair = Keypair.generate();
  const ix = new TransactionInstruction({
    programId: new PublicKey(TEST_PROGRAM_ID),
    keys: [
      { pubkey: senderKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // escrow_state
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // vault
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // sender_ata
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: depositData(),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(senderKeypair);

  const entry = tx.signatures.find((s) => s.publicKey.equals(senderKeypair.publicKey));
  const sig = entry?.signature;
  if (!sig) throw new Error('fixture inválido: la firma del sender no quedó puesta');

  const message = buildSponsorPopMessage({
    sender: senderKeypair.publicKey.toBase58(),
    networkId: NETWORK_ID,
    remittanceId: REMITTANCE_ID,
    amountMinor: AMOUNT_MINOR.toString(),
    mint: MINT.toBase58(),
    txSignatureB58: bs58.encode(Buffer.from(sig)),
  });

  return {
    partialSignedTx: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    sender: senderKeypair.publicKey.toBase58(),
    remittanceId: REMITTANCE_ID,
    popSignature: signMessage(senderKeypair, message),
  };
}

// ── Env ──────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'SOLANA_FEE_PAYER_SPONSOR_ENABLED',
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
  'SOLANA_SPONSOR_NETWORK_ID',
  'SOLANA_ESCROW_PROGRAM_ID',
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

function applySponsorEnv(): void {
  for (const k of ENV_KEYS) savedEnv.set(k, readEnv(k));
  setEnv('SOLANA_FEE_PAYER_SPONSOR_ENABLED', 'true');
  setEnv('SOLANA_FEE_PAYER_PRIVATE_KEY', KEY_JSON);
  setEnv('SOLANA_RPC_URL', 'http://mock-rpc');
  setEnv('SOLANA_USDC_MINT', MINT.toBase58());
  setEnv('SOLANA_SPONSOR_NETWORK_ID', NETWORK_ID);
  setEnv('SOLANA_ESCROW_PROGRAM_ID', TEST_PROGRAM_ID);
}
function restoreSponsorEnv(): void {
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

async function buildSponsorApp(capture?: CaptureStream): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  resetRedisClientForTests();
  resetFeePayerForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ loggerDestination: capture, skipDomainCheck: true });
}

interface Outcome {
  status: number;
  code?: string;
  message?: string;
  signature?: string;
  sender: string;
  log: string;
  /** WKH-367 / T-9 — las claves REALES de `body.error`, para compararlas exhaustivamente. */
  errorKeys?: readonly string[];
}

/**
 * WKH-367 / T-10: `probe` escribe en el MISMO logger del app antes de cerrarlo. Existe
 * para medir el redactor con la app real en vez de con un pino aparte, que mediría otra
 * configuración. Opcional: los llamadores viejos quedan idénticos.
 */
async function run(cosign: CosignFake, probe?: (app: FastifyInstance) => void): Promise<Outcome> {
  h.cosignResult.current = cosign;
  const cap = new CaptureStream();
  const body = validBody();
  let app: FastifyInstance | undefined;
  try {
    const res = await withLogs(async () => {
      app = await buildSponsorApp(cap);
      return app.inject({
        method: 'POST',
        url: '/solana/sponsor',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    });
    if (probe !== undefined && app !== undefined) probe(app);
    const parsed = JSON.parse(res.body) as {
      signature?: string;
      error?: { code: string; message: string };
    };
    return {
      status: res.statusCode,
      code: parsed.error?.code,
      message: parsed.error?.message,
      signature: parsed.signature,
      sender: String(body.sender),
      log: cap.text(),
      errorKeys: parsed.error === undefined ? undefined : Object.keys(parsed.error),
    };
  } finally {
    if (app) await app.close();
  }
}

describe('POST /solana/sponsor — salió / no salió / no sé', () => {
  beforeEach(() => {
    applySponsorEnv();
  });

  afterEach(() => {
    restoreSponsorEnv();
    vi.clearAllMocks();
  });

  // ── 1. SALIÓ ───────────────────────────────────────────────────────────────
  it('★ salió: el primitivo confirmó → 200 { signature }, y nada dice "unknown"', async () => {
    const out = await run({ ok: true, signature: 'SIGsponsor-happy' });
    expect(out.status).toBe(200);
    expect(out.signature).toBe('SIGsponsor-happy');
    expect(out.code).toBeUndefined();
    expect(out.log).not.toContain('SPONSOR_BROADCAST_UNKNOWN');
    expect(out.log).not.toContain('UNKNOWN');
  });

  // ── 2. NO SALIÓ ────────────────────────────────────────────────────────────
  it('★ no salió: EXPIRED SIN envío previo (`sent` ausente) → 409 SPONSOR_BROADCAST_EXPIRED', async () => {
    // Éste es el expirado PRE-firma (broadcast.ts:279-290): probado que no se gastó.
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
    });
    expect(out.status).toBe(409);
    expect(out.code).toBe('SPONSOR_BROADCAST_EXPIRED');
    expect(out.message).toBe('Transaction blockhash expired');
    expect(out.log).not.toContain('SPONSOR_BROADCAST_UNKNOWN');
  });

  it('no salió: EXPIRED con `sent:false` explícito → 409 (no basta con que el campo exista)', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'STALE_BLOCKHASH',
      sent: false,
    });
    expect(out.status).toBe(409);
    expect(out.code).toBe('SPONSOR_BROADCAST_EXPIRED');
  });

  it('no salió: un rechazo de CR-1 sigue siendo 422 (el bloque nuevo no se come los otros códigos)', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_REJECTED',
      reason: 'FEE_PAYER_MISMATCH',
    });
    expect(out.status).toBe(422);
    expect(out.code).toBe('SPONSOR_REJECTED');
  });

  // ── 3. NO SÉ ───────────────────────────────────────────────────────────────
  //
  // MISMO `code` y MISMO `reason` que el primer test del bloque 2: lo ÚNICO que
  // cambia es `sent`. Si la ruta volviera a descartar ese campo, los dos devolverían
  // lo mismo y éste muere.
  it('★★ no sé: EXPIRED DESPUÉS de un envío exitoso (`sent:true`) → 502 SPONSOR_BROADCAST_UNKNOWN', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.code).toBe('SPONSOR_BROADCAST_UNKNOWN');
    expect(out.message).toBe(
      'Transaction was broadcast; its on-chain outcome could not be determined',
    );
  });

  it('★★ no sé: FAILED tras agotar reintentos (`sent:true`) → 502 SPONSOR_BROADCAST_UNKNOWN', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.code).toBe('SPONSOR_BROADCAST_UNKNOWN');
  });

  // ── el "no sé" no se confunde con ninguno de los otros dos, superficie x superficie ──
  it('★★★ el "no sé" es distinto del "salió" y del "no salió" en HTTP, código, mensaje y log', async () => {
    const salio = await run({ ok: true, signature: 'SIGsponsor-happy' });
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
    expect(noSe.log).not.toContain('solana sponsor failed');
    expect(noSe.log).not.toContain('solana sponsor ok');
    // ...y el "no salió" sí sigue siendo un fallo, para que el assert de arriba no
    // esté midiendo que la ruta dejó de loguear en general.
    expect(noSalio.log).toContain('solana sponsor failed');
    expect(salio.log).not.toContain('UNKNOWN');
  });

  it('★ ni el 502 del "no sé" ni el 409 dicen "Broadcast failed": ese mensaje afirmaba que no salió', async () => {
    const noSe = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
      sent: true,
    });
    expect(noSe.message).not.toBe('Broadcast failed');
    // El código defensivo (FAILED sin `sent`, que el primitivo hoy no produce) tampoco.
    const defensivo = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
    });
    expect(defensivo.status).toBe(502);
    expect(defensivo.code).toBe('SPONSOR_BROADCAST_FAILED');
    expect(defensivo.message).toBe('Broadcast could not be confirmed');
  });

  it('★ el 502 del "no sé" lleva el `sender` al log — es media semilla del escrow_state', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.log).toContain(out.sender);
    // no-oracle: el pubkey va al log, NUNCA al body.
    expect(out.message).not.toContain(out.sender);
    // Y lo que NO se loguea: el `remittance_id`, que es la otra mitad de la semilla y
    // se queda del lado del cliente (AC-10 — nada del body al log).
    expect(out.log).not.toContain(REMITTANCE_ID);
  });
  // ══ WKH-367 — los tres campos de diagnóstico del 502 ════════════════════════

  /** El resultado del primitivo que la ruta traduce en los tests de abajo. */
  const NO_SE_CON_DIAG = {
    ok: false as const,
    code: 'SPONSOR_BROADCAST_EXPIRED',
    reason: 'BLOCKHASH_CHECK_FAILED',
    sent: true,
    detail: 'custom program error: 0x1',
    sentSignature: 'SIGtest',
  };

  it('★★ T-8 (AC-N1/N3/N4): el log del 502 lleva escrow_pda + broadcast_detail + tx_signature', async () => {
    const out = await run(NO_SE_CON_DIAG);
    expect(out.status).toBe(502);

    // El fixture pone un `escrow_state` ALEATORIO en keys[2], así que el esperado NO se
    // compara contra esa cuenta: se DERIVA acá con la misma fórmula que declara el IDL.
    // Quien clava la fórmula contra un vector externo es T-12a, no este test.
    const esperado = PublicKey.findProgramAddressSync(
      [
        Buffer.from('escrow', 'utf8'),
        new PublicKey(out.sender).toBuffer(),
        createHash('sha256').update(REMITTANCE_ID, 'utf8').digest().subarray(0, 16),
      ],
      new PublicKey(TEST_PROGRAM_ID),
    )[0].toBase58();

    // AR MNR-1: sin esto el test no sabría que está midiendo algo. Si el fixture volviera
    // al default, la línea de abajo pasaría igual con la ruta hardcodeando el default.
    expect(TEST_PROGRAM_ID).not.toBe(ESCROW_PROGRAM_ID_DEFAULT);
    expect(out.log).toContain(`"escrow_pda":"${esperado}"`);
    expect(out.log).toContain('"broadcast_detail":"custom program error: 0x1"');
    expect(out.log).toContain('"tx_signature":"SIGtest"');
  });

  it('★ T-8b (AC-N4): sin `detail` ni `sentSignature`, las claves se OMITEN — no salen vacías', async () => {
    const out = await run({
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'BLOCKHASH_CHECK_FAILED',
      sent: true,
    });
    expect(out.status).toBe(502);
    expect(out.log).not.toContain('broadcast_detail');
    expect(out.log).not.toContain('tx_signature');
    // ...y el que SÍ se puede derivar siempre sigue estando, para que los dos `not` de
    // arriba no estén midiendo que la ruta dejó de loguear.
    expect(out.log).toContain('escrow_pda');
  });

  it('★ T-9 (CD-9/AC-N5): el body del 502 tiene EXACTAMENTE code + http + message', async () => {
    const out = await run(NO_SE_CON_DIAG);
    // Comparación de CLAVES, no `toMatchObject`: un campo de más pasaría desapercibido.
    expect([...(out.errorKeys ?? [])].sort()).toEqual(['code', 'http', 'message']);
    expect(out.message).not.toContain('custom program error');
    expect(out.message).not.toContain('SIGtest');
  });

  it('★★ T-10 (DT-6/R-3): `tx_signature` sale con su VALOR, y `signature` sigue censurada', async () => {
    const out = await run(NO_SE_CON_DIAG, (app) => {
      app.log.error({ signature: 'SIGredactada', tx_signature: 'SIGvisible' }, 'probe');
    });
    // (a) el nombre nuevo pasa: `redact` hace match de clave EXACTA.
    expect(out.log).toContain('"tx_signature":"SIGvisible"');
    // (b) el control del control. Sin esta mitad, (a) pasaría también con el redactor
    // APAGADO, y el test no estaría midiendo nada del redactor.
    expect(out.log).toContain('"signature":"[Redacted]"');
    expect(out.log).not.toContain('SIGredactada');
  });

  it('★ T-11 (CD-10): el log del 502 no lleva el `remittance_id`, ni su hash en hex, ni en base58', async () => {
    const hash16 = createHash('sha256').update(REMITTANCE_ID, 'utf8').digest().subarray(0, 16);
    const out = await run(NO_SE_CON_DIAG);
    expect(out.status).toBe(502);
    expect(out.log).not.toContain(REMITTANCE_ID);
    expect(out.log).not.toContain(hash16.toString('hex'));
    expect(out.log).not.toContain(bs58.encode(hash16));
  });
});
