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
 * problema, así que A3 no la ve. Ése es el input que separa a los dos.
 *
 * ⚠️ QUÉ SOSTIENE HOY EL RECHAZO DE ESE INPUT, medido y no supuesto. Se borró la
 * línea de A2 y se corrió la suite: el request SIGUE dando 403, sin co-firmar y
 * sin reservar cap. No es A2 quien lo sostiene, es el `catch` del final:
 * `bs58.encode(Buffer.from(null))` tira un `TypeError` y se convierte en un
 * `ok:false`. Lo único que cambia al borrar A2 es el marcador que ve el operador
 * (`SENDER_SIGNATURE_NULL` ⇒ `CLAIMS_EXTRACTION_FAILED:TypeError`), y por eso el
 * test T-A2 lo assertea: sin ese assert esta línea se puede borrar sin que nada
 * se ponga rojo.
 *
 * Entonces A2 se queda por lo que el `catch` NO puede dar: un marcador que dice
 * "vino una tx sin la firma del sender" en vez de "algo de nuestro lector tiró".
 * Son diagnósticos distintos y el §7.1 los hace requisito. Lo que NO hay que
 * creer: que borrar A2 abra un 500 o un gasto. No lo abre.
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
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Sólo para el rechazo del `catch`: el `message` del error que se atrapó,
       * truncado. Existe porque `CLAIMS_EXTRACTION_FAILED` puede significar dos
       * cosas muy distintas ("nos mandaron una tx rara" / "nuestro lector tiró"),
       * y desde el log se veían idénticas.
       *
       * NUNCA lleva la transacción, ni bytes, ni nada del body: sólo el texto que
       * arma Node para un error de tipo o de rango (p. ej. `The value of "offset"
       * is out of range...`). El emisor es siempre uno de nuestros lectores, no
       * un dato del caller. Y no se ecoa al cliente (CD-12 no-oracle).
       */
      readonly detail?: string;
    };

const DETAIL_MAX_LEN = 160;

function reject(reason: string, detail?: string): SponsorClaimsResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
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
  } catch (e) {
    // `serializeMessage()` (adentro de verifySignatures) puede tirar sobre una tx
    // malformada que igual deserializó. Un error de lectura es un `no`, no un 500.
    //
    // ⚠️ ALCANZABILIDAD: hoy NINGÚN input conocido llega hasta acá con A2 en pie, y
    // conviene que quede escrito para que nadie lo lea como una rama cubierta por el
    // tráfico normal. El AR-2 probó seis formas de tx malformada (firma nula, sin
    // blockhash, sin feePayer, sin signer, tx vacía, programId indefinido) y todas
    // salieron por un `reject` de más arriba. Los tres candidatos que uno esperaría:
    //   - `readBigUInt64LE(AMOUNT_OFFSET)` no puede salirse de rango, porque
    //     `SHORT_DEPOSIT_DATA` ya cortó y AMOUNT_OFFSET + 8 <= DEPOSIT_DATA_LEN;
    //   - `bs58.encode(Buffer.from(senderSig))` sólo tira con `senderSig === null`,
    //     que A2 corta una línea antes;
    //   - `verifySignatures(false)` usa el `_message` que @solana/web3.js cachea al
    //     hacer `Transaction.from(...)`, así que no re-compila y no tira.
    // O sea: esto es defensa en profundidad, no un camino caliente. **Si este marcador
    // aparece en un log, la hipótesis #1 no es "nos mandaron una tx rara": es que algo
    // de lo de arriba cambió** (un guard que se movió, un offset, una versión de
    // web3.js). La rama está ejercitada forzando el throw en `solana-sponsor.pop.test.ts`
    // (los dos tests del final), que es lo único honesto que se puede hacer sin un
    // input real que la produzca.
    //
    // El `try` envuelve la función ENTERA (forma, índices, readBigUInt64LE, bs58,
    // A2, A3), así que este rechazo es el más ambiguo de todos: sin ligar el error
    // no se puede separar "tx rara" de "nuestro lector tiró". Se liga el `name` al
    // marcador y el `message` truncado va aparte, para que el operador vea la
    // diferencia en el log sin que el cliente vea nada.
    const err = e instanceof Error ? e : undefined;
    return reject(
      `CLAIMS_EXTRACTION_FAILED:${err?.name ?? 'unknown'}`,
      err?.message.slice(0, DETAIL_MAX_LEN),
    );
  }
}
