/**
 * SDD 037 — Guard B: el mensaje canónico de patrocinio y su verificación ed25519.
 *
 * Reemplaza al HMAC de `pop.ts` (borrado en W2). La diferencia que importa: acá
 * NO hay ningún secreto compartido con chaski. La clave que valida es el pubkey
 * `sender` que la propia transacción trae adentro, así que quien no controla esa
 * billetera no puede producir una firma que verifique.
 *
 * Qué NO hace este módulo, para que nadie lo asuma: no decide de dónde salen los
 * campos del mensaje. Recibe un objeto ya armado. La regla de que cada línea se
 * re-derive de la transacción (CD-3) vive en la ruta y en `sponsor-claims.ts`.
 * Si alguien llamara a `buildSponsorPopMessage` con campos copiados del body, la
 * firma verificaría igual y el guard no serviría de nada: ese es exactamente el
 * input que rompe la propiedad, y por eso se nombra.
 *
 * Boundary: `node:crypto` (ed25519) + `@coral-xyz/anchor` (bs58). Sin red, sin
 * env, sin dependencias nuevas.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';

/** Separador de dominio. Distinto del `Chaski Proof-of-Possession` del leg de payout a propósito:
 *  una firma legítima de aquel challenge NO debe servir acá.
 *
 *  El test que cubre ESTE valor es **T-B5b**, no T-B5. T-B5 manda un challenge de payout real, que
 *  difiere del mensaje canónico en seis cosas más allá de la primera línea y por eso seguiría dando
 *  403 aunque esta constante se borrara entera (se midió: queda verde). T-B5b aísla el separador
 *  pisando sólo la primera línea de la salida del builder, así que cambiar esta constante al dominio
 *  del leg de payout lo pone rojo. */
const SPONSOR_POP_DOMAIN = 'WasiAI Sponsor Request v1';

/** Prefijo DER de una SubjectPublicKeyInfo ed25519; le siguen los 32 bytes crudos del pubkey. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ED25519_PUBKEY_LEN = 32;
const ED25519_SIGNATURE_LEN = 64;

export interface SponsorPopFields {
  /** base58 del pubkey `sender`, sacado de la ix `deposit` (NUNCA del body). */
  readonly sender: string;
  /** CAIP-2 del cluster, desde la config del facilitator (NUNCA del body). */
  readonly networkId: string;
  /** id de la remesa, gateado contra `deposit.data[8..24]` antes de llegar acá. */
  readonly remittanceId: string;
  /** u64 en unidades mínimas, decimal, leído de `deposit.data` en AMOUNT_OFFSET. */
  readonly amountMinor: string;
  /** base58 del mint, sacado de la ix `deposit`. */
  readonly mint: string;
  /** base58 de la firma de 64 bytes que el sender puso sobre ESTA transacción. */
  readonly txSignatureB58: string;
}

/**
 * SSOT del mensaje en este repo (CD-7). 7 líneas separadas por `\n`, SIN newline
 * final — mismo idiom que `buildSolanaPopMessage` de chaski.
 *
 * El gemelo byte-idéntico vive en `chaski-v3/src/infrastructure/auth/sponsor-pop-message.ts`.
 * El vector golden (`src/__tests__/fixtures/sponsor-pop-golden.ts`) es lo que
 * detecta si los dos se separan: cambiar acá `network:` por `Network:` deja este
 * repo internamente coherente y rompe únicamente contra el otro.
 */
export function buildSponsorPopMessage(f: SponsorPopFields): string {
  return `${SPONSOR_POP_DOMAIN}\nsender: ${f.sender}\nnetwork: ${f.networkId}\nremittance: ${f.remittanceId}\namount: ${f.amountMinor}\nmint: ${f.mint}\ntx: ${f.txSignatureB58}`;
}

/** Decodifica base58 devolviendo `null` en vez de tirar (CD-4: un decode fallido es un `no`). */
function decodeBase58(value: string): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return Buffer.from(utils.bytes.bs58.decode(value));
  } catch {
    return null;
  }
}

export interface VerifySponsorPopArgs {
  readonly message: string;
  /** base58 del pubkey que tiene que haber firmado. */
  readonly senderBase58: string;
  /** base58 de la firma ed25519 de 64 bytes. */
  readonly signatureBase58: string;
}

/**
 * Verifica la firma ed25519 del mensaje canónico. Fail-closed en TODAS las ramas
 * (CD-4): base58 inválido, pubkey que no mide 32 bytes, firma que no mide
 * exactamente 64, o verificación negativa ⇒ `false`. Nunca tira.
 *
 * ⚠️ EL CHEQUEO DE LARGO ES REDUNDANTE HOY, y está escrito así para que nadie lo
 * borre creyendo que descubrió algo. Se midió en Node 22: `crypto.verify` con una
 * firma de 63 o de 65 bytes devuelve `false` por su cuenta, sin tirar — o sea que
 * sacar esta línea no cambia ninguna respuesta (se comprobó con la suite entera).
 * Se mantiene porque deja el requisito de 64 bytes escrito en el código en vez de
 * heredado de un detalle de la librería. El test
 * "crypto.verify rechaza por su cuenta los largos != 64" pinnea esa conducta: si
 * una versión futura pasara a TIRAR, ese test se pone rojo y esta línea deja de
 * ser redundante para volverse la que evita un 500.
 */
export function verifySponsorPopSignature(args: VerifySponsorPopArgs): boolean {
  const pubkeyBytes = decodeBase58(args.senderBase58);
  if (pubkeyBytes === null || pubkeyBytes.length !== ED25519_PUBKEY_LEN) return false;

  const signature = decodeBase58(args.signatureBase58);
  if (signature === null || signature.length !== ED25519_SIGNATURE_LEN) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkeyBytes]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(args.message, 'utf8'), key, signature);
  } catch {
    // Un pubkey que decodifica a 32 bytes pero no es un punto válido de la curva
    // llega hasta acá: `createPublicKey` tira. Es un `no`, no un 500.
    return false;
  }
}
