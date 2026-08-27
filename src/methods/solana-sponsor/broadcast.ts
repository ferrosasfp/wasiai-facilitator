/**
 * WKH-217 / HU-SOL-14 — reusable co-sign + broadcast primitive (CD-11).
 *
 * `cosignAndBroadcast` is GENERIC: it knows NOTHING about the `deposit`. It
 * parses a base64 legacy `Transaction`, asks an INJECTED structural validator
 * (`SponsorTxValidator`) whether the fee-payer may sign, and — ONLY if the
 * validator returns `{ ok:true }` — co-signs as fee-payer and broadcasts,
 * paying just the network fee.
 *
 * The `deposit`-specific logic lives entirely in `cr1.ts`
 * (`validateDepositForSponsor`), injected via `opts.validate`. HU-SOL-13
 * (release) reuses THIS primitive unchanged by injecting its own
 * `validateReleaseForSponsor`. Do NOT hardcode any instruction shape here.
 *
 * FAIL-CLOSED (CD-2/CD-3): the fee-payer NEVER signs an opaque blob. Every step
 * below is fail-closed; a parse error, a validator reject, a fee over the cap, a
 * daily-cap reject, or a stale blockhash all return WITHOUT signing.
 *
 * CONCURRENCY (AC-5): the sign+broadcast section runs inside
 * `runExclusive(FEE_PAYER_SENTINEL_ID, ...)` so concurrent sponsorships for the
 * single fee-payer Keypair serialize FIFO and never interleave signing state.
 *
 * Boundary: imports `@solana/web3.js` (runtime) + `src/chains/chain-mutex.ts`
 * (runtime). No EVM imports, no route/env imports.
 */

import {
  Connection,
  Transaction,
  VersionedTransaction,
  type Keypair,
  type PublicKey,
} from '@solana/web3.js';
import { runExclusive } from '../../chains/chain-mutex.js';

/**
 * Sentinel chainId reserved for the Solana fee-payer mutex. Solana has no EVM
 * chainId; `runExclusive` only needs a stable key to serialize the singleton
 * Keypair's sign/broadcast. `-1` never collides with real EVM chainIds (> 0).
 */
export const FEE_PAYER_SENTINEL_ID = -1;

/** Stable, PII-free error codes surfaced to the sponsorship route (§Contrato). */
export type SponsorErrorCode =
  | 'SPONSOR_REJECTED'
  | 'SPONSOR_UNSUPPORTED_TX'
  | 'SPONSOR_DAILY_CAP'
  | 'SPONSOR_BROADCAST_EXPIRED'
  | 'SPONSOR_BROADCAST_FAILED'
  // WKH-302: only reachable when a caller passes `onSigned` (payout). The two
  // existing `switch (result.code)` sites (routes/solana-sponsor.ts,
  // routes/solana-escrow.ts) both have a `default:` and neither does `never`
  // exhaustiveness, so adding this member does not change their behaviour.
  | 'SPONSOR_PERSIST_FAILED';

/**
 * Injected structural validator (CD-11). Generic contract reused by every
 * sponsored instruction (deposit today, release in HU-SOL-13). Receives the
 * PARSED legacy transaction + the fee-payer pubkey; returns the derived fee
 * upper bound (checks 1-5 OK) or a reject reason.
 *
 * ⚠️ THIS TYPE SAID "STABLE — do not change" AND WKH-357 CHANGED IT. What was
 * added: the OPTIONAL `durableNonce?: true` on the success branch. Why that keeps
 * the contract stable in the sense the old line meant:
 *   - it is additive and optional, so the three implementers
 *     (`validateDepositForSponsor`, `validateReleaseForSponsor`, `validatePayoutTx`)
 *     keep type-checking WITHOUT a single edit — only CR-1 ever sets it;
 *   - a validator that never sets it produces `undefined`, and every read site
 *     treats `undefined` exactly as `false` (see `saltearFrescura` below), so the
 *     existing behaviour is byte-identical;
 *   - it carries no new authority: it does NOT say "sign this", it says "this tx's
 *     blockhash is a durable-nonce value, so do not judge it for freshness".
 * The precedent for widening this interface additively is `CosignOpts.onSigned`
 * below, added by WKH-302 with the same "callers that do not pass it are
 * unaffected" reasoning. What is still NOT allowed: changing the SHAPE of the
 * existing two branches, or making a new field required.
 */
export type SponsorTxValidator = (
  tx: Transaction,
  feePayerPubkey: PublicKey,
) =>
  | {
      ok: true;
      feeUpperBoundLamports: bigint;
      /**
       * Set by CR-1 ONLY when it recognized (and fully validated, Check 2n) an
       * `AdvanceNonceAccount` as ix 0 and the durable-nonce flag is ON. `undefined`
       * on every other path, including the flag-OFF path.
       *
       * ⛔ This is NOT a "trust me" bit: CR-1 already rejected the tx if the nonce
       * ix deviated in any way. It exists because `broadcast.ts` must not parse
       * instruction shapes (see the file header) — the decision is made in CR-1 and
       * travels here as a boolean.
       */
      durableNonce?: true;
    }
  | { ok: false; reason: string };

export interface CosignOpts {
  readonly feePayerKeypair: Keypair;
  /** CR-1 injected here; NEVER hardcode the deposit shape in this file. */
  readonly validate: SponsorTxValidator;
  /** Reuses SOLANA_RPC_URL (WKH-205). */
  readonly rpcUrl: string;
  /** SOLANA_SPONSOR_MAX_FEE_LAMPORTS. */
  readonly maxFeeLamports: bigint;
  /** SOLANA_SPONSOR_MAX_REBROADCASTS. */
  readonly maxRebroadcasts: number;
  /**
   * Daily-cap CHECK+INCR (fail-closed, AC-6). Called with the derived fee upper
   * bound BEFORE signing: the CHECK (already over the daily ceiling?) stays
   * pre-sign so we never over-spend, and the atomic INCR RESERVES the fee.
   */
  readonly onFeeEstimated?: (lamports: bigint) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * AR-MNR-1 compensation. Releases a fee previously RESERVED by `onFeeEstimated`
   * when signing/broadcast never produced an on-chain spend (stale/expired
   * blockhash, pre-sign reject). Best-effort; must never throw.
   */
  readonly onFeeReleased?: (lamports: bigint) => Promise<void>;
  /** WKH-302: mutex key. Defaults to FEE_PAYER_SENTINEL_ID (sponsor/release). */
  readonly mutexId?: number;
  /**
   * WKH-302 (invariant I2): invoked AFTER signing and BEFORE serializing and
   * broadcasting. If it returns `{ ok:false }` the primitive does NOT broadcast and
   * resolves `SPONSOR_PERSIST_FAILED`. Callers that do not pass it are unaffected.
   *
   * This is what lets a durable ledger record the signature+blockhash BEFORE the tx
   * can possibly land, so a row without a signature PROVES nothing was broadcast.
   */
  readonly onSigned?: (tx: Transaction) => Promise<{ ok: boolean }>;
}

export type CosignResult =
  | { ok: true; signature: string }
  | {
      ok: false;
      code: SponsorErrorCode;
      reason: string;
      /**
       * WKH-302 (AR BLQ-1) — ¿ya se transmitió la tx al cluster con éxito antes de
       * este fallo? SÓLO informativo: los callers que no lo leen (sponsor, release)
       * quedan byte-idénticos.
       *
       * ⚠️ POR QUÉ EXISTE. `SPONSOR_BROADCAST_EXPIRED` se emite desde dos sondas
       * que corren DESPUÉS de un `sendRawTransaction` exitoso, y su `catch` no
       * significa "el blockhash venció" sino **"no pude preguntar"**. Sin este
       * campo, el caller no puede distinguir el expirado PRE-envío (que sí prueba
       * que no se gastó) del POST-envío (donde el agente pudo haber cobrado), y
       * termina afirmando "no se gastó" sobre un pago real.
       */
      sent?: boolean;
      /**
       * WKH-367 — motivo del ÚLTIMO error OBSERVADO por el bucle, ≤160 chars. SÓLO
       * diagnóstico: ninguna rama de decisión lo lee (CD-8), y NUNCA va al body de
       * ninguna respuesta HTTP (CD-9) — sólo al log del operador.
       *
       * ⚠️ QUÉ NO ES: no es un veredicto (la tx pudo aterrizar igual) ni los logs de
       * simulación (se usa `transactionError.message`, el motivo pelado). Tampoco es
       * necesariamente la causa del `reason` que lo acompaña: `BLOCKHASH_EXPIRED` no
       * tiene error propio y viaja con el último que sí hubo.
       *
       * ⚠️ EL INVARIANTE, que es lo que lo hace legible (AR BLQ-BAJO-1): ningún error
       * observado se descarta, así que `detail` es SIEMPRE lo ÚLTIMO que salió mal en esta
       * transmisión, nunca lo anteúltimo. Lo clava **T-3g**, que corre en los CUATRO sitios el
       * mutante *"si el error nuevo no se puede narrowear, quedate con el anteúltimo"*; sin
       * T-3g esto era prosa y el mutante pasaba la suite entera (CR MNR-CR-3).
       *
       * ⚠️ "OBSERVADO", NO "ATRAPADO" (CR MNR-CR-7): este renglón decía *"atrapado"*, y ése es
       * el modelo mental que produjo el bug de BLQ-BAJO-1. El desenlace más informativo de
       * todos — `confirmTransaction` que RESUELVE con `value.err !== null`, la tx aterrizada y
       * revertida — **no pasa por ningún `catch`**, y por eso un barrido de `catch`es no podía
       * encontrarlo; hoy se captura con el prefijo `CONFIRMED_WITH_ERR:` (T-3c/T-3d/T-3f).
       *
       * ⚠️ EL PRECIO DEL INVARIANTE, decidido y no accidental (CR MNR-CR-4): a ese
       * `CONFIRMED_WITH_ERR:` lo PISA el error de transporte de un reintento posterior, que ya
       * no podía cambiar nada (la red dedupea por firma). Se acepta: invertir la precedencia
       * crearía una segunda regla ("algunos errores valen más") que contradice este mismo
       * invariante, y la información no se pierde — `sentSignature` sobrevive y es el ancla
       * para ir a mirar la cadena. **T-3h** lo pinnea para que revisarlo no sea silencioso.
       */
      detail?: string;
      /**
       * WKH-367 — la firma que un `sendRawTransaction` RETORNÓ antes de que el desenlace
       * quedara incierto. SÓLO diagnóstico; NUNCA al body (CD-9), al log va `tx_signature`.
       *
       * ⚠️ NO se llama `signature` porque la rama `ok:true` ya usa ese nombre y ahí
       * significa "confirmada"; esto significa apenas "un nodo aceptó estos bytes".
       * Confundirlas es la atribución que el bloque del 502 de `routes/solana-sponsor.ts`
       * argumenta que esa ruta NO puede sostener.
       */
      sentSignature?: string;
    };

/**
 * Parse a base64 legacy `Transaction`. Fail-closed:
 *   - decode/deserialize error → `{ ok:false, code:'SPONSOR_REJECTED' }`
 *   - a versioned (v0) transaction → `{ ok:false, code:'SPONSOR_UNSUPPORTED_TX' }`
 * NEVER throws — the caller relies on this (T10).
 */
export function parseSponsorTx(
  txBase64: string,
):
  | { ok: true; tx: Transaction }
  | { ok: false; code: 'SPONSOR_UNSUPPORTED_TX' | 'SPONSOR_REJECTED'; reason: string } {
  let buf: Buffer;
  try {
    buf = Buffer.from(txBase64, 'base64');
  } catch {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'BASE64_DECODE_FAILED' };
  }
  try {
    const tx = Transaction.from(buf);
    return { ok: true, tx };
  } catch {
    // Transaction.from throws on a versioned message. Disambiguate for an
    // accurate error code: a v0 tx deserializes as a VersionedTransaction.
    if (isVersionedTx(buf)) {
      return { ok: false, code: 'SPONSOR_UNSUPPORTED_TX', reason: 'VERSIONED_TX_NOT_SUPPORTED' };
    }
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'DESERIALIZE_FAILED' };
  }
}

/** True iff `buf` decodes as a NON-legacy (v0+) versioned transaction. */
function isVersionedTx(buf: Buffer): boolean {
  try {
    const vt = VersionedTransaction.deserialize(Uint8Array.from(buf));
    return vt.version !== 'legacy';
  } catch {
    return false;
  }
}

/** True iff `blockhash` is still processable by the cluster. */
async function isBlockhashFresh(connection: Connection, blockhash: string): Promise<boolean> {
  // CR-MNR-1: rely on the real `RpcResponseAndContext<boolean>` return type
  // (`.value` is a stable field) — no double-cast needed.
  const res = await connection.isBlockhashValid(blockhash);
  return res.value === true;
}

/**
 * Co-sign + broadcast a sponsored transaction after an injected validator
 * authorizes it. See file header. Never throws — always resolves a
 * `CosignResult`.
 */
export async function cosignAndBroadcast(
  txBase64: string,
  opts: CosignOpts,
): Promise<CosignResult> {
  // Step 1 — parse (fail-closed; versioned/corrupt handled by parseSponsorTx).
  const parsed = parseSponsorTx(txBase64);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, reason: parsed.reason };
  }
  const tx = parsed.tx;

  // Step 2 — INJECTED structural validation (CR-1). The primitive signs ONLY
  // if this returns { ok:true }. It knows nothing about the deposit itself.
  const v = opts.validate(tx, opts.feePayerKeypair.publicKey);
  if (!v.ok) {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: v.reason };
  }

  // WKH-357 — ¿saltear las sondas de frescura? SÓLO si el validador reconoció un
  // durable nonce. `undefined` (todo validador que no lo setea, y CR-1 con la bandera
  // apagada) ⇒ `false` ⇒ las 3 sondas corren exactamente como hoy.
  //
  // POR QUÉ HAY QUE SALTEARLAS Y NO ES UNA OPTIMIZACIÓN: el `recentBlockhash` de una
  // tx con nonce durable NO es un blockhash reciente, es el valor guardado en la cuenta
  // de nonce. `isBlockhashValid` contesta `false` para él — correctamente, porque no está
  // entre los ~150 recientes — y ese `false` rechazaría TODO depósito con nonce.
  //
  // ⚠️ LA AUTORIDAD SOBRE SI EL NONCE SIRVE ES EL RUNTIME AL EJECUTAR, NO UNA SONDA
  // PREVIA. El System Program compara el valor de la cuenta contra el `recentBlockhash`
  // del mensaje y falla la tx entera si no coinciden, así que saltear esto no relaja
  // ninguna garantía: mueve el veredicto al único lugar que puede darlo de verdad.
  //
  // ⛔ Y NO se convierte en un `ok:true` optimista: el veredicto lo siguen dando
  // `sendRawTransaction` + `confirmTransaction`. Lo que se PIERDE es el diagnóstico
  // `STALE_BLOCKHASH`; lo que lo reemplaza para acotar el bucle es el conteo de
  // intentos (`attempts`), que ya existía. La contabilidad de `sent` / `mayHaveSpent`
  // no se toca: al agotar los intentos con el salteo puesto se cae en
  // `SPONSOR_BROADCAST_FAILED` + `sent`, que CONSERVA el débito. Ése es el lado
  // conservador y es el correcto — no lo "arregles" para devolver los lamports.
  const saltearFrescura = v.durableNonce === true;

  // Step 3 — fee upper bound must stay within the per-tx cap.
  if (v.feeUpperBoundLamports > opts.maxFeeLamports) {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'FEE_ABOVE_MAX' };
  }

  // Step 4 — daily-cap CHECK+INCR (fail-closed, AC-6). A reject here means the
  // aggregate lamports ceiling was hit OR the counter store is down. On success
  // this RESERVES `feeUpperBoundLamports` (the CHECK stays PRE-SIGN so we never
  // over-spend); the reservation is released below if no on-chain spend occurs.
  let reserved = false;
  if (opts.onFeeEstimated) {
    const cap = await opts.onFeeEstimated(v.feeUpperBoundLamports);
    if (!cap.ok) {
      return { ok: false, code: 'SPONSOR_DAILY_CAP', reason: cap.reason ?? 'DAILY_CAP_EXCEEDED' };
    }
    reserved = true;
  }

  // Steps 5-6 — blockhash freshness + sign + broadcast, SERIALIZED per fee-payer.
  const result = await runExclusive(
    opts.mutexId ?? FEE_PAYER_SENTINEL_ID,
    async (): Promise<CosignResult> => {
      const connection = new Connection(opts.rpcUrl, 'confirmed');
      const blockhash = tx.recentBlockhash;
      if (blockhash === undefined || blockhash.length === 0) {
        return { ok: false, code: 'SPONSOR_REJECTED', reason: 'MISSING_BLOCKHASH' };
      }

      // Step 5 — blockhash fresh BEFORE signing (never sign a stale tx).
      // Salteado para una tx con nonce durable: ver `saltearFrescura` arriba.
      if (!saltearFrescura) {
        let fresh: boolean;
        try {
          fresh = await isBlockhashFresh(connection, blockhash);
        } catch {
          // RPC error on the freshness probe → fail-closed, never sign.
          return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_CHECK_FAILED' };
        }
        if (!fresh) {
          return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'STALE_BLOCKHASH' };
        }
      }

      // Step 6 — co-sign as fee-payer, then broadcast with bounded rebroadcast.
      tx.partialSign(opts.feePayerKeypair);
      // WKH-302 (I2): persist signature+blockhash BETWEEN signing and broadcasting.
      // A Solana signature exists before the tx is transmitted, so this ordering is
      // free — and it is what makes "no signature recorded" a PROOF that nothing was
      // sent. If persistence fails we must NOT broadcast: we would be unable to tell
      // a retry whether it already paid.
      if (opts.onSigned) {
        const persisted = await opts.onSigned(tx);
        if (!persisted.ok) {
          return {
            ok: false,
            code: 'SPONSOR_PERSIST_FAILED',
            reason: 'PERSIST_BEFORE_BROADCAST_FAILED',
          };
        }
      }
      const raw = tx.serialize();
      return broadcastWithRebroadcast(
        connection,
        raw,
        blockhash,
        opts.maxRebroadcasts,
        saltearFrescura,
      );
    },
  );

  // AR-MNR-1 (data-integrity / auto-DoS): the daily-cap INCR at step 4 RESERVED
  // the fee upper bound BEFORE any spend. Release it for every terminal outcome
  // that guarantees NO fee was charged on-chain (pre-sign reject, stale/expired
  // blockhash) so a tx that never landed cannot auto-exhaust the caller's daily
  // budget. Debits for AMBIGUOUS outcomes are KEPT, conservatively, to protect the
  // fee-payer wallet. The CHECK stayed pre-sign — this compensation only touches
  // accounting, never weakening fail-closed.
  //
  // ⚠️ `sent` ENTRA EN ESTA CUENTA, y antes no entraba. La regla ya era "conservá el
  // débito cuando la tx pudo haber aterrizado", y estaba escrita nombrando UN código
  // (`SPONSOR_BROADCAST_FAILED`) en vez de la propiedad. `SPONSOR_BROADCAST_EXPIRED`
  // también se emite DESPUÉS de un envío (líneas 300-312 y 348-360) y caía del lado
  // del release: la contabilidad devolvía los lamports afirmando "no se gastó" sobre
  // un gas que puede estar gastado. Es la MISMA mentira que el 409 de la ruta, corrida
  // a la superficie del cap diario, y por eso se arregla junto. Los otros dos callers
  // (payout, release) no pasan `onFeeReleased`, así que esto sólo toca al patrocinio.
  const mayHaveSpent =
    !result.ok && (result.code === 'SPONSOR_BROADCAST_FAILED' || result.sent === true);
  if (reserved && !result.ok && !mayHaveSpent && opts.onFeeReleased) {
    await opts.onFeeReleased(v.feeUpperBoundLamports);
  }

  return result;
}

/** Mismo tope y misma razón que el `DETAIL_MAX_LEN` de `sponsor-claims.ts`. */
const BROADCAST_DETAIL_MAX_LEN = 160;

/**
 * WKH-367 — el motivo de un error de envío/confirmación, acotado. NUNCA tira (T-4b).
 *
 * Match ESTRUCTURAL, no `instanceof SendTransactionError`: los tests inyectan un
 * `Connection` doble y la identidad de clase entre dos instancias del módulo es frágil.
 * `transactionError` (getter público de @solana/web3.js 1.98.4) devuelve el motivo
 * pelado; `e.message` NO sirve porque arranca con ~88 chars de firma base58 e incrusta
 * los logs de simulación — truncarlo a 160 se come justo el motivo.
 *
 * ⛔ Nunca `String(e)`: sobre un no-Error deja `"undefined"` o `"[object Object]"` en el
 * log, peor que no tener el campo — sin candidato ⇒ `undefined` ⇒ la clave se omite.
 * ⛔ Nunca `.logs` ni `getLogs()` (el segundo hace RED).
 */
function narrowSendDetail(e: unknown): string | undefined {
  try {
    if (typeof e === 'object' && e !== null) {
      const te = (e as { transactionError?: unknown }).transactionError;
      if (typeof te === 'object' && te !== null) {
        const m = (te as { message?: unknown }).message;
        // AR MNR-3: si el error TIENE `transactionError` pero su `message` no es string,
        // NO se cae al `e.message` de abajo. Ese texto arranca con ~88 chars de firma e
        // incrusta los `Logs:` de simulación — exactamente lo que CD-11 prohíbe. Sin
        // candidato limpio, ningún candidato: el campo se omite y nadie se confunde.
        return typeof m === 'string' ? m.slice(0, BROADCAST_DETAIL_MAX_LEN) : undefined;
      }
    }
    if (e instanceof Error) {
      // `message` está tipado `string`, pero un objeto real puede traer cualquier cosa
      // ahí: se re-mira en runtime antes de llamarle `.slice` (AR MNR-2).
      const m: unknown = e.message;
      if (typeof m === 'string') return m.slice(0, BROADCAST_DETAIL_MAX_LEN);
    }
  } catch {
    // AR MNR-2: un `transactionError` implementado como getter que TIRA escapaba de acá.
    // Este helper corre DENTRO de los `catch` del bucle, así que un throw suyo no se
    // atrapa en ningún lado: se lleva puesto el 502 con todo su diagnóstico y lo
    // convierte en un 500. "NUNCA tira" ahora es una propiedad, no una intención.
  }
  return undefined;
}

/**
 * WKH-367 / AR BLQ-BAJO-1 — el motivo de una tx que ATERRIZÓ y REVIRTIÓ, acotado.
 *
 * `confirmTransaction` RESUELVE con `value.err !== null` en ese caso: no hay objeto de
 * error, no hay `catch`, y el desenlace más informativo de todos era el único que el
 * bucle tiraba a la basura. Sin esto, el `return` de agotamiento sale con el motivo de
 * un intento ANTERIOR Y DISTINTO — el operador lee "el envío nunca pasó" sobre una tx
 * que sí llegó a la cadena. Es la misatribución que esta HU existe para no cometer.
 *
 * El prefijo `CONFIRMED_WITH_ERR:` está para que ese `detail` no se confunda con el de
 * un error de transporte: los dos viven en el mismo campo y significan cosas opuestas.
 *
 * NUNCA tira: `JSON.stringify` puede tirar (referencia circular, `BigInt`) o devolver
 * `undefined` (una función), y los dos casos caen en `[unserializable]`. Un throw acá
 * quedaría atrapado por el `catch` de confirmación y `detail` diría un motivo NUESTRO
 * disfrazado de motivo de la cadena.
 */
function narrowConfirmedErr(err: unknown): string {
  let body: string | undefined;
  try {
    body = typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    body = undefined;
  }
  return `CONFIRMED_WITH_ERR:${body ?? '[unserializable]'}`.slice(0, BROADCAST_DETAIL_MAX_LEN);
}

/**
 * Broadcast + confirm with bounded rebroadcast (AC-5). Up to
 * `maxRebroadcasts + 1` attempts. On exhaustion, distinguishes expiry (blockhash
 * no longer valid → SPONSOR_BROADCAST_EXPIRED) from a hard failure
 * (SPONSOR_BROADCAST_FAILED).
 *
 * WKH-357: `saltearFrescura` viaja como parámetro porque esta función es PRIVADA y
 * tiene su propia firma — no recibe el `v` del validador, así que los 2 sitios de
 * frescura que viven acá no se ven en el diff de `cosignAndBroadcast`. Con `true`, el
 * bucle sigue acotado por `attempts` y la salida por agotamiento es
 * `SPONSOR_BROADCAST_FAILED` + `sent`, que conserva el débito.
 */
async function broadcastWithRebroadcast(
  connection: Connection,
  raw: Uint8Array,
  blockhash: string,
  maxRebroadcasts: number,
  saltearFrescura: boolean,
): Promise<CosignResult> {
  const attempts = Math.max(1, maxRebroadcasts + 1);
  // AR BLQ-1: a partir del primer send exitoso, NINGÚN veredicto posterior puede
  // afirmar que no se gastó — la tx ya está en manos del cluster.
  let sent = false;
  // WKH-367: se guarda el ÚLTIMO error/firma, no el primero — el motivo que importa es
  // el del intento que terminó el camino, no el del que todavía tenía reintentos.
  let lastDetail: string | undefined;
  let lastSignature: string | undefined;
  const diag = () => ({
    ...(lastDetail === undefined ? {} : { detail: lastDetail }),
    ...(lastSignature === undefined ? {} : { sentSignature: lastSignature }),
  });
  for (let i = 0; i < attempts; i++) {
    // Re-check freshness at the top of each (re)broadcast — the blockhash may
    // have expired between retries. Salteado para nonce durable: un valor de nonce no
    // "vence entre reintentos", se consume cuando la tx ejecuta.
    if (!saltearFrescura) {
      let fresh: boolean;
      try {
        fresh = await isBlockhashFresh(connection, blockhash);
      } catch (e) {
        // "No pude preguntar" ≠ "venció". Si ya hubo envío, esto es una incógnita.
        // WKH-367: sin capturar ACÁ, el `detail` de este return sería el del
        // `sendRawTransaction` del intento ANTERIOR — misatribución (T-3b).
        lastDetail = narrowSendDetail(e);
        return {
          ok: false,
          code: 'SPONSOR_BROADCAST_EXPIRED',
          reason: 'BLOCKHASH_CHECK_FAILED',
          sent,
          ...diag(),
        };
      }
      if (!fresh) {
        return {
          ok: false,
          code: 'SPONSOR_BROADCAST_EXPIRED',
          reason: 'BLOCKHASH_EXPIRED',
          sent,
          ...diag(),
        };
      }
    }

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      sent = true;
      lastSignature = signature;
    } catch (e) {
      // R-1: un envío que TIRA también cuenta como "pudo haber salido". Un timeout
      // o un socket caído ocurren perfectamente DESPUÉS de que el nodo aceptó la tx
      // y la reenvió al cluster, así que el throw no prueba que no haya llegado.
      //
      // Y este mismo bucle ya lo asumía: el `continue` de abajo reintenta LA MISMA
      // tx firmada, algo que sólo es seguro porque la red dedupea por firma. El
      // bucle trataba el envío fallido como "puede haber llegado" y el flag como
      // "no llegó" — dos criterios opuestos en el mismo archivo.
      sent = true;
      lastDetail = narrowSendDetail(e);
      continue; // transient send error → rebroadcast
    }

    try {
      // CR-MNR-1: `RpcResponseAndContext<SignatureResult>` — `.value.err` is a
      // stable field (null on success); no double-cast needed.
      const conf = await connection.confirmTransaction(signature, 'confirmed');
      if (conf.value.err === null || conf.value.err === undefined) {
        return { ok: true, signature };
      }
      // AR BLQ-BAJO-1: la tx aterrizó y falló ON-CHAIN. Va DENTRO del `try` a propósito:
      // si el narrowing llegara a tirar, el `catch` de abajo lo absorbe y la función
      // sigue sin poder propagar una excepción nueva (T-3e).
      lastDetail = narrowConfirmedErr(conf.value.err);
    } catch (e) {
      // confirmation error → retry
      lastDetail = narrowSendDetail(e);
    }
  }

  // Exhausted retries. Expired blockhash → EXPIRED, otherwise a hard FAILED.
  // Con nonce durable no hay expiración que distinguir, así que se cae derecho al
  // FAILED de abajo, que lleva `sent` y por lo tanto CONSERVA el débito del cap.
  if (!saltearFrescura) {
    let stillFresh: boolean;
    try {
      stillFresh = await isBlockhashFresh(connection, blockhash);
    } catch (e) {
      lastDetail = narrowSendDetail(e);
      return {
        ok: false,
        code: 'SPONSOR_BROADCAST_EXPIRED',
        reason: 'BLOCKHASH_CHECK_FAILED',
        sent,
        ...diag(),
      };
    }
    if (!stillFresh) {
      return {
        ok: false,
        code: 'SPONSOR_BROADCAST_EXPIRED',
        reason: 'BLOCKHASH_EXPIRED',
        sent,
        ...diag(),
      };
    }
  }
  return {
    ok: false,
    code: 'SPONSOR_BROADCAST_FAILED',
    reason: 'UNCONFIRMED_AFTER_REBROADCASTS',
    sent,
    ...diag(),
  };
}
