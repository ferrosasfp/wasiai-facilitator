/**
 * POST /solana/sponsor — Solana fee-payer sponsorship (WKH-217 / HU-SOL-14,
 * autorización reescrita por SDD 037).
 *
 * chaski (server-side) sends a partial-signed legacy `deposit` transaction whose
 * feePayer is the facilitator. This route: auth → Zod → parse → Guard A + Guard B
 * → rate/daily → CR-1 (`validateDepositForSponsor`) + co-sign + broadcast →
 * `{ signature }`.
 *
 * ⚠️ SECURITY: the fee-payer's key signs ONLY after CR-1 authorizes the exact
 * `deposit` (fail-closed, CD-2/CD-3). This handler never signs a blob by
 * declared metadata. AC-10: the private key and the raw tx are NEVER logged nor
 * echoed in any error body.
 *
 * ⚠️ QUÉ AUTORIZA EL PATROCINIO, en concreto. Antes del SDD 037 la autorización
 * era un HMAC calculado con un secreto compartido con chaski: quien tuviera ese
 * secreto fabricaba una prueba válida para CUALQUIER billetera, y encima la
 * prueba hablaba de `body.sender`, un campo que la transacción no usaba. Hoy hay
 * dos guards y ninguno necesita un secreto:
 *
 *   Guard A — el `sender` es la cuenta 0 de la ix `deposit` (no un campo del
 *     body), su firma está presente y todas las firmas de la tx verifican.
 *   Guard B — esa misma billetera firmó además un mensaje legible que dice qué
 *     autoriza, y cada línea de ese mensaje se re-deriva de la transacción o de
 *     la config del facilitator.
 *
 * El input que rompe la propiedad si Guard B se cae: una tx firmada por la
 * víctima `V`, capturada y reenviada por `A`. Sin Guard B, `A` consigue que el
 * facilitator pague el gas de una transacción que `A` nunca autorizó. Guard A por
 * sí solo NO lo detiene: la tx de `V` es válida y sus firmas verifican — lo que
 * falta ahí es el consentimiento, no la posesión.
 *
 * ⚠️ LO QUE ESO **NO** ES: no es "patrocinio por cualquier monto". El monto vive
 * adentro de la tx (`deposit.data[88..96]`), o sea adentro de lo que `V` firmó:
 * tocarlo invalida la firma de `V` y lo corta **A3** (`sponsor-claims.ts`), que es
 * Guard A y sigue en pie con Guard B caído. Se midió: víctima firma `10000000`,
 * atacante sube a `1000000000` ⇒ `verifySignatures(false)` da `false` ⇒ 403 sin
 * que Guard B participe. Con una firma capturada `A` consigue exactamente el
 * monto que `V` firmó, ni un lamport más.
 *
 * ⚠️ TRES DESENLACES, NO DOS. Un broadcast termina en `salió` (200 + firma), `no
 * salió` (409/422/429 — probado que no se gastó) o `NO SÉ`
 * (`SPONSOR_BROADCAST_UNKNOWN`, 502). El tercero se decide por `CosignResult.sent`,
 * NO por el código del primitivo: `SPONSOR_BROADCAST_EXPIRED` se emite también desde
 * sondas POSTERIORES a un `sendRawTransaction` (broadcast.ts:300-312 y :348-360) y
 * ahí su `catch` significa "no pude preguntar", no "el blockhash venció". El detalle
 * está en el Step 11.
 *
 * ⚠️ CUÁNTO CUESTA ESA MENTIRA **ACÁ**, y va dicho para que este arreglo no se lea con
 * el peso del de `/solana/escrow/release` ni el del payout. Lo que queda en duda en el
 * patrocinio es EL GAS DEL FEE-PAYER: unos lamports nuestros, gastados o no, que ningún
 * reintento recupera. En un release o un payout lo que queda en duda es el dinero de una
 * persona en manos de un tercero. Tres diferencias concretas, todas comprobables:
 *
 *   1. El valor que mueve el `deposit` es del PROPIO sender y va a un escrow, no a un
 *      tercero: sigue teniendo `release` y `refund` por delante.
 *   2. La incógnita es RESOLUBLE por cualquiera desde afuera, sin nada nuestro: el
 *      `escrow_state` es un PDA de semillas `["escrow", sender, remittance_id]`
 *      (`chains/escrow-idl.ts`), o sea que existe o no existe, y quien tenga esos dos
 *      datos lo mira en la cadena. Un payout, en cambio, sólo se puede reconciliar con
 *      la firma que el facilitator persistió.
 *   3. No puede volverse un doble cobro: el vault de ese escrow se crea con `init` y no
 *      con `init_if_needed` (está documentado en `chains/escrow-idl.ts`), y su dirección
 *      se deriva del `escrow_state`, o sea de ese mismo par (sender, remittance_id). Un
 *      segundo depósito del par no puede aterrizar.
 *
 * Nada de esto lo hace menos FALSO — un 409 "blockhash expired" sigue afirmando algo
 * que no sabemos. Lo hace menos caro, y por eso este arreglo NO trae la mitad cara del
 * exemplar (persistir la firma para reconciliar después): esta ruta no tiene ledger y
 * agregarle uno sería construir la reconciliación de un gasto de gas.
 *
 * Registered ONLY when `isSponsorEnabled()` (opt-in-off, CD-13) — see app.ts.
 *
 * Boundary: mirrors `src/routes/settle.ts` (auth preHandler, Zod safeParse,
 * `{ error:{ code,message,http } }` body, `request.facilitatorKeyId` bucketing).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireFacilitatorKey } from '../middleware/auth.js';
import { getFeePayerKeypair } from '../infra/solana-fee-payer.js';
import { getReleaseAuthorityPubkey } from '../infra/solana-release-authority.js';
import { cosignAndBroadcast, parseSponsorTx } from '../methods/solana-sponsor/broadcast.js';
import { validateDepositForSponsor, type Cr1Config } from '../methods/solana-sponsor/cr1.js';
import { extractSponsorClaims } from '../methods/solana-sponsor/sponsor-claims.js';
import {
  buildSponsorPopMessage,
  verifySponsorPopSignature,
} from '../methods/solana-sponsor/sponsor-pop.js';
import { REMITTANCE_ID_LEN } from '../methods/solana-sponsor/deposit-shape.js';
import {
  checkAndIncrSponsorRate,
  checkAndIncrSponsorDailyLamports,
  releaseSponsorDailyLamports,
} from '../core/solana-sponsor-cap.js';

type SponsorErrorCodeHttp =
  | 'INVALID_PAYLOAD'
  | 'SPONSOR_SENDER_PROOF_INVALID'
  | 'SPONSOR_REJECTED'
  | 'SPONSOR_UNSUPPORTED_TX'
  | 'SPONSOR_RATE_LIMITED'
  | 'SPONSOR_DAILY_CAP'
  | 'SPONSOR_BROADCAST_EXPIRED'
  | 'SPONSOR_BROADCAST_FAILED'
  /**
   * La tx SE TRANSMITIÓ al cluster y no se pudo determinar su suerte. NO es un
   * fracaso y NO es un éxito: es la tercera respuesta, y existe porque las otras dos
   * mienten en este caso. Mismo criterio que `RELEASE_BROADCAST_UNKNOWN`
   * (routes/solana-escrow.ts) y `PAYOUT_BROADCAST_UNKNOWN` (routes/solana-payout.ts).
   *
   * Antes este caso salía como `SPONSOR_BROADCAST_EXPIRED / 409 / "Transaction
   * blockhash expired"`, que de los dos lados se lee como "no salió, rearmá la tx con
   * un blockhash nuevo y mandala de vuelta" — sobre un depósito que podía estar ya
   * aterrizado, con el gas ya gastado.
   */
  | 'SPONSOR_BROADCAST_UNKNOWN'
  | 'SPONSOR_NOT_ENABLED';

interface ErrorBody {
  readonly error: {
    readonly code: SponsorErrorCodeHttp;
    readonly message: string;
    readonly http: number;
  };
}

const ZOD_MESSAGE_MAX_LEN = 200;

/**
 * Route-local body schema (CD-16: does NOT reuse SettleRequestSchema).
 *
 * `amount` y `mint` NO están acá a propósito: el facilitator los re-deriva de la
 * ix `deposit`. Un campo declarado que después hay que comparar contra la tx es
 * superficie de más para el mismo resultado.
 *
 * ⚠️ `reference` TAMPOCO está, y salió de acá en el fix-pack del AR (MNR-1). Era
 * requerido y no tenía un solo consumidor: no se comparaba contra la tx, no
 * entraba al mensaje canónico, no se logueaba. Medido: dos requests idénticos
 * salvo `reference`, con la MISMA `popSignature`, daban 200 los dos — o sea que
 * era el último campo del request que no se comparaba contra nada, exactamente el
 * diagnóstico que el §0 del SDD 037 hizo sobre `body.sender`.
 *
 * Por qué se saca en vez de atarse: la `reference` real ya viaja adentro de la tx
 * como remaining account y CR-1 le valida los flags (`cr1.ts`), así que atar el
 * campo del body no agregaría ninguna defensa; y CR-1 acepta a propósito una ix
 * SIN remaining accounts, con lo cual exigir la coincidencia rechazaría formas que
 * hoy son válidas. Sacarlo no rompe a nadie en ningún orden de despliegue: `z.object`
 * descarta las claves que no conoce, así que un cliente que lo siga mandando (chaski
 * lo manda) pasa igual. Esto NO aplica a un rename de `popSignature`, que sí sería
 * un cambio de contrato con ventana (§2.2).
 */
const SponsorRequestSchema = z.object({
  partialSignedTx: z.string().min(1),
  sender: z.string().min(1),
  remittanceId: z.string().min(1),
  popSignature: z.string().min(1),
});

/**
 * La release-authority de esta instancia, en base58, o `undefined` si no está
 * configurada. NO tira: la ausencia de la llave es un estado legítimo de una instancia
 * que sólo patrocina (bandera propia, independiente de la del sponsor).
 *
 * Se lee UNA vez, al registrar la ruta: `getReleaseAuthorityKeypair` cachea el Keypair,
 * así que releerlo por request no detectaría un cambio de env de todos modos.
 */
function resolveReleaseAuthority(): string | undefined {
  try {
    return getReleaseAuthorityPubkey().toBase58();
  } catch {
    return undefined;
  }
}

export const solanaSponsorRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  const releaseAuthority = resolveReleaseAuthority();
  // ⚠️ El Check 4d NO se apaga en silencio. Un guard que se desarma solo cuando le
  // falta su config es indistinguible de no tenerlo, y el operador no ve la diferencia
  // — así que acá se ve, una vez, en el arranque. La contracara (`info`) también se
  // emite, para que "no veo el warning" signifique "está armado" y no "no miré bien".
  if (releaseAuthority === undefined) {
    app.log.warn(
      {
        setting: 'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
        value: '(unset)',
        check: 'CR1_DEPOSIT_AUTHORITY',
      },
      'NOTICE: the sponsored-deposit authority check (CR-1 Check 4d) is DISARMED — this instance has no release-authority key, so it cannot tell whether the deposits it sponsors will be releasable. Set SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY on any instance that also releases.',
    );
  } else {
    app.log.info(
      { check: 'CR1_DEPOSIT_AUTHORITY', release_authority: releaseAuthority },
      'sponsorship: deposit-authority check ARMED against the configured release authority',
    );
  }
  const cr1cfg: Cr1Config = {
    escrowProgramId: env.SOLANA_ESCROW_PROGRAM_ID,
    maxComputeUnits: env.SOLANA_SPONSOR_MAX_COMPUTE_UNITS,
    maxPriorityFeeMicroLamports: env.SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS,
    maxFeeLamports: BigInt(env.SOLANA_SPONSOR_MAX_FEE_LAMPORTS),
    // El mint que CR-1 exige en el `deposit`. Sale de la config, NUNCA del body:
    // el mensaje de patrocinio se arma desde la tx, así que el mint que la persona
    // firma es el que el cliente puso. Si la env falta, CR-1 rechaza (Check 4c).
    usdcMint: env.SOLANA_USDC_MINT,
    // La authority que el `deposit` graba en el escrow tiene que ser la nuestra, o ese
    // depósito nace irreleaseable (Check 4d). Ausente ⇒ check desarmado, avisado arriba.
    releaseAuthority,
    // WKH-357 — ¿aceptamos un `nonceAdvance` en ix 0 (depósito por enlace)? `false`
    // no desarma nada: rechaza con el veredicto de siempre (PROGRAM_NOT_WHITELISTED).
    durableNonceEnabled: env.SOLANA_SPONSOR_DURABLE_NONCE_ENABLED,
  };
  const dailyCapLamports = BigInt(env.SOLANA_SPONSOR_DAILY_MAX_LAMPORTS);
  const maxFeeLamports = cr1cfg.maxFeeLamports;

  app.post(
    '/solana/sponsor',
    {
      preHandler: requireFacilitatorKey,
      config: {
        rateLimit: {
          max: env.SOLANA_SPONSOR_RATE_LIMIT_MAX,
          timeWindow: env.SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const requestId = request.id;
      const keyId = request.facilitatorKeyId;

      const fail = (
        code: SponsorErrorCodeHttp,
        http: number,
        message: string,
        /**
         * Marcador interno del guard que cortó. NO se ecoa en la respuesta
         * (CD-12 no-oracle: al cliente no se le dice por qué falló). Existe para
         * que un operador pueda separar "el servicio está mal configurado" de
         * "alguien está atacando", que desde el body se ven idénticos.
         *
         * ⚠️ El camino 422 lo dejaba SIN pasar, y ahí es donde más se necesita:
         * `SPONSOR_REJECTED` es el destino común de ~34 motivos distintos de
         * `cr1.ts` + `broadcast.ts` (`FEE_PAYER_MISMATCH`, `PRIORITY_FEE_ABOVE_MAX`,
         * `COMPUTE_UNITS_ABOVE_MAX`, `PROGRAM_NOT_WHITELISTED`, …), así que un tope
         * mal configurado en el deploy y una tx corrupta salían con el MISMO
         * `error_code: SPONSOR_REJECTED, http_status: 422` y nada más. Hoy cada
         * `fail()` con causa distinguible pasa su marcador; los tests
         * `★ observabilidad del 422` de `solana-sponsor.route.test.ts` lo clavan
         * junto con el candado de que el marcador NO viaja al cliente.
         */
        guard?: string,
        /**
         * Detalle NO estructurado del guard, cuando el marcador solo no alcanza
         * para diagnosticar. Su único emisor es el `catch` de `extractSponsorClaims`,
         * que puede ser "tx rara" o "nuestro lector tiró". Mismo trato que `guard`:
         * log interno, jamás en la respuesta. NUNCA lleva la tx ni bytes del body.
         *
         * ⚠️ Ese `catch` **no lo alcanza ningún input conocido** con A2 en pie (AR-2
         * probó seis formas de tx malformada; el detalle y el porqué están en el
         * comentario del `catch`, en `sponsor-claims.ts`). O sea: este campo casi
         * nunca se emite, y verlo en un log es señal de que algo cambió — no de que
         * llegó tráfico raro.
         */
        guardDetail?: string,
      ) => {
        // AC-10: log ONLY the error code / non-secret keyId — never the body/tx.
        // NOTE: request.auditMeta.errorCode is intentionally NOT set here — its
        // union is an EVM-scoped shared type (src/core/audit.ts, outside this
        // HU's scope, CD-16). The structured warn below carries error_code for
        // observability; the audit row records the status code + path.
        app.log.warn(
          {
            request_id: requestId,
            error_code: code,
            http_status: http,
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
            ...(guard === undefined ? {} : { guard }),
            ...(guardDetail === undefined ? {} : { guard_detail: guardDetail }),
          },
          'solana sponsor failed',
        );
        return reply.code(http).send({ error: { code, message, http } } satisfies ErrorBody);
      };

      /** Todo rechazo de autorización sale con el MISMO código y el MISMO mensaje. */
      const failSenderProof = (guard: string, guardDetail?: string) =>
        fail(
          'SPONSOR_SENDER_PROOF_INVALID',
          403,
          'sender signature does not authorize this transaction',
          guard,
          guardDetail,
        );

      // Step 1 — Zod validation.
      const parsed = SponsorRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? issue.path.join('.') : 'body';
        const message = `${path}: ${issue?.message ?? 'invalid'}`.slice(0, ZOD_MESSAGE_MAX_LEN);
        return fail('INVALID_PAYLOAD', 400, message);
      }
      const body = parsed.data;

      // Step 2 — parse the tx. Los guards leen la transacción, así que hay que
      // deserializarla antes. Sigue sin tocar la key del feePayer y sin red.
      // DT-4: `cosignAndBroadcast` vuelve a parsear desde el base64; se acepta el
      // doble parseo para no cambiar el contrato del primitivo.
      const parsedTx = parseSponsorTx(body.partialSignedTx);
      if (!parsedTx.ok) {
        if (parsedTx.code === 'SPONSOR_UNSUPPORTED_TX') {
          return fail(
            'SPONSOR_UNSUPPORTED_TX',
            422,
            'Unsupported transaction (versioned)',
            parsedTx.reason,
          );
        }
        return fail('SPONSOR_REJECTED', 422, 'Transaction rejected by validation', parsedTx.reason);
      }

      // Step 3 — Guard A, parte 1: qué dice la tx de sí misma (shape + A2 + A3).
      const claimsResult = extractSponsorClaims(parsedTx.tx);
      if (!claimsResult.ok) {
        return failSenderProof(claimsResult.reason, claimsResult.detail);
      }
      const claims = claimsResult.claims;

      // Step 4 — Guard A, parte 2 (A1): el `sender` que el body declara tiene que
      // ser el `sender` REAL de la instrucción.
      //
      // ⚠️ HONESTIDAD SOBRE QUÉ APORTA ESTE GUARD, medida y no supuesta. Borrar
      // esta comparación NO abre el ataque de reenviar la tx de `V` diciendo
      // `body.sender = A`: el paso 7 arma el mensaje con `claims.sender` y
      // verifica contra ESE pubkey, así que la firma de `A` no pasa igual. Se
      // comprobó borrándolo y corriendo la suite: ningún test cambia de color
      // salvo el que mira cuál guard cortó.
      //
      // Lo que A1 sí garantiza es que `body.sender` no sea un campo decorativo:
      // un request cuyo `sender` no coincide con la transacción se rechaza ACÁ,
      // con su propio marcador, en vez de confundirse con una firma inválida. Y
      // es la línea que queda en pie si alguien alguna vez debilita Guard B.
      if (body.sender !== claims.sender) {
        return failSenderProof('A1_SENDER_MISMATCH');
      }

      // Step 5 — la red que el mensaje declara sale de NUESTRA config, nunca del
      // body. Ausente ⇒ 403 (CD-4). Ver §7.1: el marcador `guard` separa esto de
      // un ataque en el log, aunque el cliente vea exactamente la misma respuesta.
      const networkId = env.SOLANA_SPONSOR_NETWORK_ID;
      if (networkId === undefined) {
        return failSenderProof('NETWORK_ID_UNSET');
      }

      // Step 6 — el `remittanceId` es el único campo del body que entra al
      // mensaje, y entra GATEADO: sus 16 bytes de hash tienen que ser los que la
      // ix `deposit` ya lleva adentro. Un id distinto del que la tx usó no pasa.
      const expectedRid16 = createHash('sha256')
        .update(body.remittanceId, 'utf8')
        .digest()
        .subarray(0, REMITTANCE_ID_LEN);
      if (!claims.remittanceIdHash16.equals(expectedRid16)) {
        return failSenderProof('REMITTANCE_ID_MISMATCH');
      }

      // Step 7 — Guard B: la persona firmó un mensaje legible que dice qué
      // autoriza, y ese mensaje se reconstruye acá desde la tx + la config. Si el
      // atacante firmó `amount: 1` mientras la ix mueve 10000000, el string que
      // armamos es otro y ed25519 devuelve false.
      const popMessage = buildSponsorPopMessage({
        sender: claims.sender,
        networkId,
        remittanceId: body.remittanceId,
        amountMinor: claims.amountMinor,
        mint: claims.mint,
        txSignatureB58: claims.senderTxSignatureB58,
      });
      if (
        !verifySponsorPopSignature({
          message: popMessage,
          senderBase58: claims.sender,
          signatureBase58: body.popSignature,
        })
      ) {
        return failSenderProof('POP_SIGNATURE_INVALID');
      }

      // ── recién acá empieza lo caro / lo que consume ───────────────────────────
      // Los pasos 1-7 no tocan la key del feePayer, no reservan cap diario y no
      // hacen red (CD-4/CD-5). Por eso "cosignSpy no invocado" y "dailySpy no
      // invocado" son aserciones legítimas de los tests, no extras.

      // Step 8 — per-caller rate-limit (fail-closed, AC-6).
      const rate = await checkAndIncrSponsorRate(
        env.SOLANA_SPONSOR_RATE_LIMIT_MAX,
        env.SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC,
        app.log,
        keyId,
      );
      if (!rate.ok) {
        // `store_error_failclosed` (Redis caído) y `rate_exceeded` (alguien nos
        // martilla) salen los dos como 429: sin el marcador, una caída de Redis
        // durante una demo se lee como "me están limitando".
        return fail('SPONSOR_RATE_LIMITED', 429, 'Rate limit exceeded', rate.reason);
      }

      // Step 9 — resolve the fee-payer key (opt-in-off guard; never leaks value).
      let feePayerKeypair: Keypair;
      try {
        feePayerKeypair = getFeePayerKeypair();
      } catch {
        // El 501 no distingue "apagada a propósito" de "prendida y mal
        // configurada". El marcador dice CUÁL de las dos variables falta.
        return fail(
          'SPONSOR_NOT_ENABLED',
          501,
          'Sponsorship is not enabled',
          'FEE_PAYER_KEY_UNAVAILABLE',
        );
      }
      const rpcUrl = env.SOLANA_RPC_URL;
      if (rpcUrl === undefined || rpcUrl.length === 0) {
        return fail('SPONSOR_NOT_ENABLED', 501, 'Sponsorship is not enabled', 'RPC_URL_UNSET');
      }

      // Step 10 — CR-1 + co-sign + broadcast. Daily-cap INCR runs fail-closed
      // inside the primitive (onFeeEstimated) once the fee upper bound is known.
      const result = await cosignAndBroadcast(body.partialSignedTx, {
        feePayerKeypair,
        validate: (tx, feePayerPubkey) => validateDepositForSponsor(tx, feePayerPubkey, cr1cfg),
        rpcUrl,
        maxFeeLamports,
        maxRebroadcasts: env.SOLANA_SPONSOR_MAX_REBROADCASTS,
        onFeeEstimated: async (lamports) => {
          const cap = await checkAndIncrSponsorDailyLamports(
            lamports,
            dailyCapLamports,
            app.log,
            keyId,
          );
          return { ok: cap.ok, reason: cap.ok ? undefined : cap.reason };
        },
        // AR-MNR-1: release the daily-cap reservation when no on-chain spend
        // occurred (the primitive only calls this on such terminal failures).
        onFeeReleased: async (lamports) => {
          await releaseSponsorDailyLamports(lamports, dailyCapLamports, app.log, keyId);
        },
      });

      if (result.ok) {
        // CR-MNR-2: do NOT log `signature` — pino's redact list (logger.ts)
        // censors the `signature` field to `[Redacted]`, so logging it here is
        // dead weight. The signature is returned in the response body regardless.
        app.log.info(
          {
            request_id: requestId,
            method: 'solana-sponsor',
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
          },
          'solana sponsor ok',
        );
        return reply.code(200).send({ signature: result.signature });
      }

      // ── Step 11 — "no pude preguntar" ≠ "no salió" ──────────────────────────────
      //
      // `CosignResult.sent` existe exactamente para esto y hasta acá esta ruta lo tiraba
      // a la basura. El flag se prende en los DOS resultados posibles de un
      // `sendRawTransaction` (broadcast.ts:321 cuando devuelve, :331 cuando TIRA — un
      // socket caído no prueba que el nodo no haya aceptado la tx), y de ahí viaja a los
      // veredictos de las sondas de frescura POSTERIORES al envío (broadcast.ts:300-312
      // dentro del bucle, :348-366 al agotarlo). El `catch` de esas sondas significa "no
      // pude preguntar", no "el blockhash venció" — está escrito en broadcast.ts:113-118.
      // Traducir eso a `409 / "Transaction blockhash expired"` afirmaba que no se gastó.
      //
      // ⚠️ QUÉ SE PORTÓ DEL EXEMPLAR Y QUÉ NO. Son dos exemplars y NO son intercambiables:
      // el payout (solana-payout.ts:555-598) resuelve la incógnita optimistamente porque
      // VERIFICA LA FIRMA que persistió (`verifyPayoutSignature`) y por eso puede contestar
      // un 200 honesto; el release (solana-escrow.ts:509-556) NO lo hace, porque releer el
      // estado `Released` probaría que el escrow se liberó y no que lo haya hecho NUESTRA
      // tx. Acá corresponde el SEGUNDO, y por un motivo más fuerte todavía: esta ruta no
      // tiene NADA que verificar. El primitivo sólo devuelve la firma cuando confirmó, así
      // que en esta rama el facilitator no la tiene ni la persistió en ningún lado — no hay
      // ledger de patrocinios. Devolver un `{ signature }` sería inventarlo, y hasta si lo
      // recalculáramos de la tx firmada, "existe un depósito para este par" tampoco probaría
      // que lo puso nuestra transmisión. Ese `{ signature }` es una atribución que esta ruta
      // NO puede sostener, así que no la hace.
      //
      // Y NO SE DECLARA que un reintento resuelva la incógnita, porque acá no la resuelve:
      // a diferencia del release, esta ruta no relee nada on-chain antes de firmar, así que
      // un depósito que YA aterrizó vuelve a intentarse y falla en el preflight (el PDA ya
      // existe) — o sea que sale otra vez por este mismo camino. Quien puede cerrar la
      // incógnita es el que tiene el `remittance_id`: mirando si el `escrow_state` existe.
      if (result.sent === true) {
        // Log PROPIO: `fail()` escribe 'solana sponsor failed', y este desenlace no es un
        // fallo. Un log que lo llame fallo es la misma mentira corrida de superficie.
        app.log.error(
          {
            request_id: requestId,
            error_code: 'SPONSOR_BROADCAST_UNKNOWN' satisfies SponsorErrorCodeHttp,
            http_status: 502,
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
            guard: result.reason,
            // Excepción explícita y acotada a AC-10 ("nunca el body/tx"), con el mismo
            // criterio con el que la ruta del release loguea su `escrow_pda`: es UN pubkey
            // público leído de la lista de cuentas de la ix (no del body, no la tx, no un
            // secreto), y es una de las dos semillas del `escrow_state`. Es media llave:
            // la otra mitad es el `remittance_id`, que se queda del lado del cliente a
            // propósito. Acota a qué billetera mirar; no dice qué pasó.
            sender: claims.sender,
          },
          'solana sponsor outcome UNKNOWN — transaction was broadcast, on-chain effect undetermined',
        );
        return reply.code(502).send({
          error: {
            code: 'SPONSOR_BROADCAST_UNKNOWN',
            message: 'Transaction was broadcast; its on-chain outcome could not be determined',
            http: 502,
          },
        } satisfies ErrorBody);
      }

      // Step 11b — map the primitive error code → HTTP (no echo of the tx).
      //
      // A partir de acá `result.sent` es falso/ausente: NINGÚN envío ocurrió, así que
      // estos códigos sí pueden afirmar que no se gastó.
      //
      // `result.reason` es el ÚNICO dato que separa los ~34 motivos que el
      // primitivo colapsa en estos cinco códigos, y va al log — nunca al body.
      switch (result.code) {
        case 'SPONSOR_UNSUPPORTED_TX':
          return fail(
            'SPONSOR_UNSUPPORTED_TX',
            422,
            'Unsupported transaction (versioned)',
            result.reason,
          );
        case 'SPONSOR_DAILY_CAP':
          return fail('SPONSOR_DAILY_CAP', 429, 'Daily sponsorship cap reached', result.reason);
        case 'SPONSOR_BROADCAST_EXPIRED':
          // Alcanzable SÓLO sin envío previo: la sonda PRE-firma (broadcast.ts:224-232),
          // el blockhash ya vencido antes del primer send, o un `MISSING_BLOCKHASH`. Ahí
          // sí está probado que no se gastó nada y el 409 "rearmá y reintentá" es correcto.
          return fail(
            'SPONSOR_BROADCAST_EXPIRED',
            409,
            'Transaction blockhash expired',
            result.reason,
          );
        case 'SPONSOR_BROADCAST_FAILED':
          // Defensivo. El primitivo sólo emite este código tras agotar los reintentos, y
          // para llegar ahí hubo al menos un `sendRawTransaction` (exitoso o que tiró: los
          // dos marcan `sent`), así que en la práctica lo captura el bloque de arriba. Se
          // deja porque el contrato del primitivo no lo garantiza por tipo, y el mensaje ya
          // no afirma que la tx no salió — "failed" a secas se leía como "no salió".
          return fail(
            'SPONSOR_BROADCAST_FAILED',
            502,
            'Broadcast could not be confirmed',
            result.reason,
          );
        case 'SPONSOR_REJECTED':
        default:
          return fail('SPONSOR_REJECTED', 422, 'Transaction rejected by validation', result.reason);
      }
    },
  );
};
