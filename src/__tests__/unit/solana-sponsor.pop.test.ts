/**
 * SDD 037 / W1 — el mensaje canónico, su verificación ed25519 y los claims.
 *
 * T-G1 es el test cross-repo: compara el builder contra un LITERAL escrito a mano
 * (CD-9). Su gemelo vive en `chaski-v3/src/infrastructure/auth/sponsor-pop-message.test.ts`
 * con el MISMO literal. Un mutante que cambie un byte del builder de UN solo repo
 * (M10) muere acá o allá, según de qué lado se aplique.
 *
 * Además se verifica algo que el §13.2 del SDD marcaba como NO comprobado: que
 * `tx.verifySignatures(false)` siga dando `true` sobre una transacción que pasó
 * por `serialize()` → `Transaction.from()`, que es el camino REAL (chaski
 * serializa, el facilitator deserializa). Si ese round-trip no reprodujera los
 * mismos bytes del mensaje, el guard A3 rechazaría todo request legítimo.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import {
  buildSponsorPopMessage,
  verifySponsorPopSignature,
} from '../../methods/solana-sponsor/sponsor-pop.js';
import { extractSponsorClaims } from '../../methods/solana-sponsor/sponsor-claims.js';
import {
  AMOUNT_OFFSET,
  DEPOSIT_DATA_LEN,
  DEPOSIT_DISCRIMINATOR,
  ESCROW_PROGRAM_ID_DEFAULT,
} from '../../methods/solana-sponsor/deposit-shape.js';
import { GOLDEN } from '../fixtures/sponsor-pop-golden.js';

const bs58 = utils.bytes.bs58;

/** Firma ed25519 cruda con una seed de 32 bytes, vía `node:crypto` (sin tweetnacl). */
function signWithSeed(seed: Uint8Array, message: string): Buffer {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(message, 'utf8'), key);
}

// ── T-G1 — vector golden contra literales ────────────────────────────────────
describe('T-G1 — el builder del mensaje canónico (facilitator)', () => {
  it('★ produce EXACTAMENTE el string del vector golden', () => {
    const built = buildSponsorPopMessage({
      sender: GOLDEN.senderBase58,
      networkId: GOLDEN.networkId,
      remittanceId: GOLDEN.remittanceId,
      amountMinor: GOLDEN.amountMinor,
      mint: GOLDEN.mintBase58,
      txSignatureB58: GOLDEN.txSignatureB58,
    });
    expect(built).toBe(GOLDEN.expectedMessage);
  });

  it('el mensaje tiene 7 líneas y NO termina en newline', () => {
    expect(GOLDEN.expectedMessage.split('\n')).toHaveLength(7);
    expect(GOLDEN.expectedMessage.endsWith('\n')).toBe(false);
  });

  it('abre con el separador de dominio propio, distinto del leg de payout', () => {
    expect(GOLDEN.expectedMessage.startsWith('WasiAI Sponsor Request v1\n')).toBe(true);
    expect(GOLDEN.expectedMessage.startsWith('Chaski Proof-of-Possession')).toBe(false);
  });

  it('★ la firma golden verifica contra el pubkey golden', () => {
    expect(
      verifySponsorPopSignature({
        message: GOLDEN.expectedMessage,
        senderBase58: GOLDEN.senderBase58,
        signatureBase58: GOLDEN.expectedSignature,
      }),
    ).toBe(true);
  });

  it('la seed publicada reproduce el pubkey y la firma del vector', () => {
    const kp = Keypair.fromSeed(Uint8Array.from(GOLDEN.senderSeed));
    expect(kp.publicKey.toBase58()).toBe(GOLDEN.senderBase58);
    expect(
      bs58.encode(signWithSeed(Uint8Array.from(GOLDEN.senderSeed), GOLDEN.expectedMessage)),
    ).toBe(GOLDEN.expectedSignature);
  });
});

// ── verifySponsorPopSignature — fail-closed en cada rama ─────────────────────
describe('verifySponsorPopSignature — fail-closed', () => {
  const seed = Uint8Array.from(GOLDEN.senderSeed);
  const message = GOLDEN.expectedMessage;

  it('mensaje alterado en UN byte ⇒ false', () => {
    const tampered = message.replace('network: solana:devnet', 'network: solana:mainnet');
    expect(tampered).not.toBe(message);
    expect(
      verifySponsorPopSignature({
        message: tampered,
        senderBase58: GOLDEN.senderBase58,
        signatureBase58: GOLDEN.expectedSignature,
      }),
    ).toBe(false);
  });

  it('firma de OTRO keypair sobre el mismo mensaje ⇒ false', () => {
    const otherSeed = new Uint8Array(32).fill(9);
    const otherSig = bs58.encode(signWithSeed(otherSeed, message));
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: GOLDEN.senderBase58,
        signatureBase58: otherSig,
      }),
    ).toBe(false);
  });

  it('firma de 63 y de 65 bytes ⇒ false en las dos', () => {
    const real = signWithSeed(seed, message);
    const short = bs58.encode(Buffer.from(real.subarray(0, 63)));
    const long = bs58.encode(Buffer.concat([real, Buffer.from([0])]));
    for (const sig of [short, long]) {
      expect(
        verifySponsorPopSignature({
          message,
          senderBase58: GOLDEN.senderBase58,
          signatureBase58: sig,
        }),
      ).toBe(false);
    }
  });

  it('base58 inválido (firma y pubkey) ⇒ false, sin tirar', () => {
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: GOLDEN.senderBase58,
        signatureBase58: 'no-es-base58-0OIl',
      }),
    ).toBe(false);
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: 'no-es-base58-0OIl',
        signatureBase58: GOLDEN.expectedSignature,
      }),
    ).toBe(false);
  });

  it('firma vacía o pubkey vacío ⇒ false', () => {
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: GOLDEN.senderBase58,
        signatureBase58: '',
      }),
    ).toBe(false);
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: '',
        signatureBase58: GOLDEN.expectedSignature,
      }),
    ).toBe(false);
  });

  it('pubkey de 32 bytes que NO es un punto de la curva ⇒ false, sin tirar', () => {
    // Todos-unos: decodifica a 32 bytes, pero no es un punto ed25519 válido.
    const notOnCurve = bs58.encode(Buffer.alloc(32, 0xff));
    expect(
      verifySponsorPopSignature({
        message,
        senderBase58: notOnCurve,
        signatureBase58: GOLDEN.expectedSignature,
      }),
    ).toBe(false);
  });
});

// ── extractSponsorClaims — lo que la tx dice de sí misma ─────────────────────

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

interface BuiltTx {
  readonly tx: Transaction;
  readonly senderKp: Keypair;
  readonly mint: PublicKey;
}

function buildDepositTx(opts?: {
  remittanceId?: string;
  amountMinor?: bigint;
  withComputeBudget?: boolean;
}): BuiltTx {
  const senderKp = Keypair.generate();
  const feePayer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const ix = new TransactionInstruction({
    programId: new PublicKey(ESCROW_PROGRAM_ID_DEFAULT),
    keys: [
      { pubkey: senderKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data: depositData(opts?.remittanceId ?? 'rem_037_golden', opts?.amountMinor ?? 10000000n),
  });
  const tx = new Transaction();
  if (opts?.withComputeBudget === true) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  }
  tx.add(ix);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.partialSign(senderKp);
  return { tx, senderKp, mint };
}

/** El camino REAL: chaski serializa parcialmente, el facilitator deserializa. */
function roundTrip(tx: Transaction): Transaction {
  const b64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  return Transaction.from(Buffer.from(b64, 'base64'));
}

describe('extractSponsorClaims', () => {
  it('★ sobrevive el round-trip serialize→Transaction.from (§13.2 del SDD)', () => {
    const { tx, senderKp, mint } = buildDepositTx();
    const parsed = roundTrip(tx);
    // Ésta es la afirmación que el SDD no había comprobado: A3 sobre la tx RECONSTRUIDA.
    expect(parsed.verifySignatures(false)).toBe(true);

    const res = extractSponsorClaims(parsed);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.sender).toBe(senderKp.publicKey.toBase58());
    expect(res.claims.mint).toBe(mint.toBase58());
    expect(res.claims.amountMinor).toBe('10000000');
    expect(
      res.claims.remittanceIdHash16.equals(
        createHash('sha256').update('rem_037_golden', 'utf8').digest().subarray(0, 16),
      ),
    ).toBe(true);
    expect(bs58.decode(res.claims.senderTxSignatureB58)).toHaveLength(64);
  });

  it('ignora las ix de ComputeBudget para localizar el `deposit`', () => {
    const { tx, senderKp } = buildDepositTx({ withComputeBudget: true });
    const res = extractSponsorClaims(roundTrip(tx));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.sender).toBe(senderKp.publicKey.toBase58());
  });

  it('A2: firma del sender puesta en null ⇒ ok:false, no tira', () => {
    const { tx } = buildDepositTx();
    const parsed = roundTrip(tx);
    for (const s of parsed.signatures) s.signature = null;
    const res = extractSponsorClaims(parsed);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('SENDER_SIGNATURE_NULL');
  });

  it('A3: firma presente pero corrupta ⇒ ok:false', () => {
    const { tx, senderKp } = buildDepositTx();
    const parsed = roundTrip(tx);
    // OJO: `signatures[0]` es el feePayer, cuya firma es null. Buscar al sender por
    // pubkey, no por posición — si no, este test no corrompe nada y prueba otra cosa.
    const entry = parsed.signatures.find((s) => s.publicKey.equals(senderKp.publicKey));
    expect(entry?.signature).not.toBeNull();
    if (entry) entry.signature = Buffer.alloc(64, 3);
    const res = extractSponsorClaims(parsed);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('SIGNATURE_VERIFICATION_FAILED');
  });

  it('data más corta que el layout ⇒ ok:false SHORT_DEPOSIT_DATA', () => {
    const senderKp = Keypair.generate();
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(ESCROW_PROGRAM_ID_DEFAULT),
        keys: [
          { pubkey: senderKp.publicKey, isSigner: true, isWritable: true },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...DEPOSIT_DISCRIMINATOR]),
      }),
    );
    tx.feePayer = Keypair.generate().publicKey;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.partialSign(senderKp);
    const res = extractSponsorClaims(roundTrip(tx));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('SHORT_DEPOSIT_DATA');
  });

  it('el amount sale de los bytes de la ix, no de ningún campo declarado', () => {
    const { tx } = buildDepositTx({ amountMinor: 123456789n });
    const res = extractSponsorClaims(roundTrip(tx));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.amountMinor).toBe('123456789');
  });
});
