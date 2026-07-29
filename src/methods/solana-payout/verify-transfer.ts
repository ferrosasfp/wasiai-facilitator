/**
 * WKH-302 — verify-before-trust for a previously recorded payout signature (CD-8).
 *
 * When the ledger says a payout for this intent already has a signature, the route
 * does NOT take the row's word for it: it re-reads the transaction on-chain and
 * recomputes the NET DELTA credited to `payTo` for `mint`. Only then does it return
 * that signature as an already-settled payment (AC-5).
 *
 * The delta is `post - pre` over the WHOLE transaction, so a later compensating
 * instruction is already reflected in the post balance. All arithmetic is BigInt on
 * `uiTokenAmount.amount`; `uiAmount` is NEVER read (CD-10) — it is a float and
 * rounds. Same criterion as the verify block of `src/chains/solana-adapter.ts`.
 *
 * NEVER throws. Devuelve uno de TRES estados (`PayoutVerification`), nunca un
 * booleano: un fallo de RPC es `indeterminate`, NO una negativa. Ese colapso —
 * "no pude mirar" leído como "miré y no está" — es exactamente lo que causó el
 * doble pago de BLQ-2, así que el tipo existe para que el call-site no pueda
 * repetirlo.
 *
 * Boundary: imports `@solana/web3.js` (type-only) + `./payout-shape.js`. No env, no
 * route, no keypair.
 */

import type { Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from './payout-shape.js';

export interface VerifyPayoutInput {
  readonly signature: string;
  readonly payTo: string; // base58 owner
  readonly mint: string; // base58
  readonly amountAtomic: string; // decimal STRING (CD-10)
}

/**
 * Resultado de preguntarle a la cadena. TRES valores, no dos (AR BLQ-2).
 *
 * ⚠️ ESTE TIPO ES EL ARREGLO, no un detalle de estilo. Antes esto devolvía
 * `{ valid: boolean; reason?: string }`, y todo call-site leía el booleano: eso
 * COLAPSA "miré la cadena y el pago no está" con "no pude mirar". Las dos cosas
 * daban `valid:false`, y aguas abajo eso autorizaba re-firmar y volver a pagar.
 *
 * Toda consulta a un sistema externo tiene tres respuestas: está / no está / no
 * pude preguntar. Si el tipo tiene dos, el tercer caso ya se perdió en el diseño y
 * cada call-site lo va a colapsar mal. Acá el compilador obliga a distinguirlos.
 *
 * `indeterminate` NUNCA autoriza gastar ni re-gastar: es "no sé", y el lado seguro
 * de "no sé" en un camino de dinero es no hacer nada nuevo.
 */
export type PayoutVerification =
  /** La cadena confirma que el pago acreditó al menos lo esperado. */
  | { readonly status: 'confirmed' }
  /**
   * La cadena RESPONDIÓ y la respuesta demuestra que ese pago no ocurrió (la tx
   * falló on-chain, o acreditó menos de lo debido).
   */
  | { readonly status: 'absent'; readonly reason: string }
  /**
   * No se pudo determinar: RPC caído, cuerpo ilegible, o la tx no aparece — que
   * puede ser "no existe" pero también "este nodo no tiene ese pedazo de historia",
   * "este nodo va atrasado" o "el índice está degradado".
   */
  | { readonly status: 'indeterminate'; readonly reason: string };

/** Minimal shape we read off the parsed tx — narrower than the SDK's own type. */
interface TokenBalanceLike {
  readonly owner?: string | null;
  readonly mint?: string;
  readonly programId?: string;
  readonly uiTokenAmount?: { readonly amount?: string };
}

/**
 * Re-lee `signature` on-chain y decide si acreditó AL MENOS `amountAtomic` de
 * `mint` a `payTo`. Clasifica en tres, y la frontera importa:
 *
 *  · `confirmed`     — la cadena confirma el crédito.
 *  · `absent`        — la cadena RESPONDIÓ y ese pago no está: la tx se ejecutó y
 *                      falló, no tocó el balance del destino, o acreditó de menos.
 *                      También el caso "el nodo no la tiene en su historia", que es
 *                      la respuesta más DÉBIL: por eso `absent` nunca autoriza sola
 *                      volver a gastar (el call-site exige además blockhash muerto).
 *  · `indeterminate` — NO se pudo preguntar: RPC caído, balances ilegibles, monto
 *                      esperado no parseable. Nunca autoriza re-firmar.
 *
 * ⚠️ El fallo de RPC NO va con las negativas demostradas. Meterlo ahí es el colapso
 * que causó BLQ-2 (doble pago de un intent ya pagado).
 */
export async function verifyPayoutSignature(
  connection: Connection,
  input: VerifyPayoutInput,
): Promise<PayoutVerification> {
  let expected: bigint;
  try {
    expected = BigInt(input.amountAtomic);
  } catch {
    // No podemos ni formular la pregunta ⇒ no sabemos nada del pago.
    return { status: 'indeterminate', reason: 'BAD_EXPECTED_AMOUNT' };
  }

  let tx;
  try {
    tx = await connection.getParsedTransaction(input.signature, {
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    // "No pude preguntar". JAMÁS es evidencia de que no se pagó.
    return { status: 'indeterminate', reason: 'RPC_ERROR' };
  }

  if (tx === null || tx === undefined || tx.meta === null || tx.meta === undefined) {
    // El nodo RESPONDIÓ y esa firma no está en su historia. Es la respuesta
    // "miré y no está", distinta de "no pude mirar" (que es el catch de arriba).
    //
    // ⚠️ PERO `null` es la respuesta más débil de las tres: también la da un nodo
    // que no tiene ese pedazo de historia, uno atrasado o un índice degradado. Por
    // eso `absent` NUNCA autoriza por sí sola volver a gastar: el call-site exige
    // ADEMÁS que el blockhash de esa tx esté muerto. Sin blockhash vencido, una tx
    // "no encontrada" todavía puede estar en vuelo.
    return { status: 'absent', reason: 'TX_NOT_FOUND' };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    // La cadena RESPONDIÓ: esa tx se ejecutó y falló ⇒ no movió el dinero.
    return { status: 'absent', reason: 'TX_FAILED_ON_CHAIN' };
  }

  const post: readonly TokenBalanceLike[] = tx.meta.postTokenBalances ?? [];
  const pre: readonly TokenBalanceLike[] = tx.meta.preTokenBalances ?? [];

  const matches = (e: TokenBalanceLike): boolean =>
    e.owner === input.payTo && e.mint === input.mint && e.programId === TOKEN_PROGRAM_ID;

  // Fall back to owner+mint (without the program-id pin) so a cluster that omits
  // programId does not turn a real payment into an unverifiable one; the amount
  // check below is what actually authorizes.
  const destPost =
    post.find(matches) ?? post.find((e) => e.owner === input.payTo && e.mint === input.mint);
  if (destPost === undefined) {
    // La tx existe y se ejecutó bien, pero NO tocó el balance de este destino: la
    // cadena respondió y la respuesta es negativa.
    return { status: 'absent', reason: 'NO_DESTINATION_BALANCE' };
  }
  const destPre =
    pre.find(matches) ?? pre.find((e) => e.owner === input.payTo && e.mint === input.mint);

  let delta: bigint;
  try {
    const postAmt = BigInt(destPost.uiTokenAmount?.amount ?? '0');
    const preAmt = destPre === undefined ? 0n : BigInt(destPre.uiTokenAmount?.amount ?? '0');
    delta = postAmt - preAmt;
  } catch {
    // Los balances vinieron ilegibles ⇒ no pudimos leer la respuesta.
    return { status: 'indeterminate', reason: 'UNPARSEABLE_BALANCE' };
  }

  if (delta < expected) {
    return { status: 'absent', reason: 'DELTA_BELOW_EXPECTED' };
  }
  return { status: 'confirmed' };
}
