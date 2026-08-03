/**
 * SDD 037 — Guard A: qué dice la transacción sobre sí misma.
 *
 * Extrae de una `Transaction` legacy ya deserializada los cinco datos que el
 * mensaje canónico necesita, **todos leídos de la transacción**, nunca del body:
 * el `sender`, el `mint`, el `amount`, el hash del `remittance_id` y la firma que
 * el sender puso sobre esta misma transacción.
 *
 * De paso valida las dos condiciones que el §7 llama A2 y A3:
 *   A2 — existe una firma NO nula para el pubkey `sender`.
 *   A3 — todas las firmas presentes verifican (`tx.verifySignatures(false)`).
 *
 * Por qué A2 no es redundante con A3: `verifySignatures(false)` sólo mira las
 * firmas PRESENTES. Una transacción con la firma del sender en `null` la pasa sin
 * problema. Sin A2, ese request llegaba hasta `tx.partialSign(feePayer)` y
 * reventaba en `serialize()` con un 500, dejando además la reserva del cap diario
 * tomada. Ese es el input concreto que separa a los dos guards.
 *
 * Puro: sin red, sin env, sin keypairs. NUNCA tira — todo error es un `ok:false`.
 *
 * Boundary: `@solana/web3.js` (tipos + `PublicKey`) + `@coral-xyz/anchor` (bs58).
 */

import type { Transaction, TransactionInstruction } from '@solana/web3.js';
import { ComputeBudgetProgram } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import {
  AMOUNT_OFFSET,
  DEPOSIT_ACCOUNT_INDEX,
  DEPOSIT_DATA_LEN,
  DEPOSIT_DISCRIMINATOR,
  REMITTANCE_ID_LEN,
  REMITTANCE_ID_OFFSET,
} from './deposit-shape.js';

export interface SponsorClaims {
  /** base58 del pubkey de `deposit.keys[0]` — el único `sender` que cuenta. */
  readonly sender: string;
  /** base58 del pubkey de `deposit.keys[1]`. */
  readonly mint: string;
  /** u64 leído en `AMOUNT_OFFSET`, en decimal. */
  readonly amountMinor: string;
  /** `deposit.data[8..24]` — los 16 bytes que el programa recibió como `remittance_id`. */
  readonly remittanceIdHash16: Buffer;
  /** base58 de la firma de 64 bytes que el `sender` puso sobre esta transacción. */
  readonly senderTxSignatureB58: string;
}

export type SponsorClaimsResult =
  | { readonly ok: true; readonly claims: SponsorClaims }
  | { readonly ok: false; readonly reason: string };

function reject(reason: string): SponsorClaimsResult {
  return { ok: false, reason };
}

/**
 * Localiza la ix `deposit`. **Espeja** la regla de `cr1.ts:106-115`: el primer
 * instruction que no pertenece a ComputeBudget, por POSICIÓN, sin buscar por
 * discriminador. No la reemplaza ni la modifica (CR-1 sigue corriendo aparte).
 *
 * Que las dos usen la misma regla no es una coincidencia que se pueda relajar:
 * si este módulo mirara otra ix que la que CR-1 autoriza, el mensaje se armaría
 * sobre una transferencia y la autorización se daría sobre otra.
 */
function findDepositIx(tx: Transaction): TransactionInstruction | undefined {
  const computeBudgetPk = ComputeBudgetProgram.programId;
  return tx.instructions.find((ix) => !ix.programId.equals(computeBudgetPk));
}

export function extractSponsorClaims(tx: Transaction): SponsorClaimsResult {
  try {
    const deposit = findDepositIx(tx);
    if (deposit === undefined) return reject('NO_BUSINESS_IX');

    // ── Forma de la ix ──────────────────────────────────────────────────────
    const data = deposit.data;
    if (data.length < DEPOSIT_DATA_LEN) return reject('SHORT_DEPOSIT_DATA');
    const disc = Buffer.from(data.subarray(0, DEPOSIT_DISCRIMINATOR.length));
    if (!disc.equals(Buffer.from([...DEPOSIT_DISCRIMINATOR]))) return reject('BAD_DISCRIMINATOR');

    const senderKey = deposit.keys[DEPOSIT_ACCOUNT_INDEX.SENDER];
    const mintKey = deposit.keys[DEPOSIT_ACCOUNT_INDEX.MINT];
    if (senderKey === undefined || mintKey === undefined) return reject('DEPOSIT_ACCOUNTS_MISSING');

    // ── A2: firma del sender presente y NO nula ─────────────────────────────
    const senderEntry = tx.signatures.find((s) => s.publicKey.equals(senderKey.pubkey));
    if (senderEntry === undefined) return reject('SENDER_SIGNATURE_ABSENT');
    const senderSig = senderEntry.signature;
    if (senderSig === null) return reject('SENDER_SIGNATURE_NULL');

    // ── A3: las firmas presentes verifican ──────────────────────────────────
    // `false` = no exigir que estén TODAS: la del feePayer todavía no existe (es
    // justamente lo que el facilitator va a agregar). Lo que sí se exige es que
    // las que vinieron sean auténticas sobre este mensaje.
    if (!tx.verifySignatures(false)) return reject('SIGNATURE_VERIFICATION_FAILED');

    return {
      ok: true,
      claims: {
        sender: senderKey.pubkey.toBase58(),
        mint: mintKey.pubkey.toBase58(),
        amountMinor: data.readBigUInt64LE(AMOUNT_OFFSET).toString(),
        remittanceIdHash16: Buffer.from(
          data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN),
        ),
        senderTxSignatureB58: utils.bytes.bs58.encode(Buffer.from(senderSig)),
      },
    };
  } catch {
    // `serializeMessage()` (adentro de verifySignatures) puede tirar sobre una tx
    // malformada que igual deserializó. Un error de lectura es un `no`, no un 500.
    return reject('CLAIMS_EXTRACTION_FAILED');
  }
}
