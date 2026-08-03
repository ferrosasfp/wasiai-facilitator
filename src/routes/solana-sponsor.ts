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
 * facilitator pague el gas de una transacción que `A` nunca autorizó, y por
 * cualquier monto. Guard A por sí solo NO lo detiene: la tx de `V` es válida y
 * sus firmas verifican — lo que falta ahí es el consentimiento, no la posesión.
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
 */
const SponsorRequestSchema = z.object({
  partialSignedTx: z.string().min(1),
  reference: z.string().min(1),
  sender: z.string().min(1),
  remittanceId: z.string().min(1),
  popSignature: z.string().min(1),
});

export const solanaSponsorRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  const cr1cfg: Cr1Config = {
    escrowProgramId: env.SOLANA_ESCROW_PROGRAM_ID,
    maxComputeUnits: env.SOLANA_SPONSOR_MAX_COMPUTE_UNITS,
    maxPriorityFeeMicroLamports: env.SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS,
    maxFeeLamports: BigInt(env.SOLANA_SPONSOR_MAX_FEE_LAMPORTS),
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
         */
        guard?: string,
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
          },
          'solana sponsor failed',
        );
        return reply.code(http).send({ error: { code, message, http } } satisfies ErrorBody);
      };

      /** Todo rechazo de autorización sale con el MISMO código y el MISMO mensaje. */
      const failSenderProof = (guard: string) =>
        fail(
          'SPONSOR_SENDER_PROOF_INVALID',
          403,
          'sender signature does not authorize this transaction',
          guard,
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
          return fail('SPONSOR_UNSUPPORTED_TX', 422, 'Unsupported transaction (versioned)');
        }
        return fail('SPONSOR_REJECTED', 422, 'Transaction rejected by validation');
      }

      // Step 3 — Guard A, parte 1: qué dice la tx de sí misma (shape + A2 + A3).
      const claimsResult = extractSponsorClaims(parsedTx.tx);
      if (!claimsResult.ok) {
        return failSenderProof(claimsResult.reason);
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
        return fail('SPONSOR_RATE_LIMITED', 429, 'Rate limit exceeded');
      }

      // Step 9 — resolve the fee-payer key (opt-in-off guard; never leaks value).
      let feePayerKeypair: Keypair;
      try {
        feePayerKeypair = getFeePayerKeypair();
      } catch {
        return fail('SPONSOR_NOT_ENABLED', 501, 'Sponsorship is not enabled');
      }
      const rpcUrl = env.SOLANA_RPC_URL;
      if (rpcUrl === undefined || rpcUrl.length === 0) {
        return fail('SPONSOR_NOT_ENABLED', 501, 'Sponsorship is not enabled');
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

      // Step 11 — map the primitive error code → HTTP (no echo of the tx).
      switch (result.code) {
        case 'SPONSOR_UNSUPPORTED_TX':
          return fail('SPONSOR_UNSUPPORTED_TX', 422, 'Unsupported transaction (versioned)');
        case 'SPONSOR_DAILY_CAP':
          return fail('SPONSOR_DAILY_CAP', 429, 'Daily sponsorship cap reached');
        case 'SPONSOR_BROADCAST_EXPIRED':
          return fail('SPONSOR_BROADCAST_EXPIRED', 409, 'Transaction blockhash expired');
        case 'SPONSOR_BROADCAST_FAILED':
          return fail('SPONSOR_BROADCAST_FAILED', 502, 'Broadcast failed');
        case 'SPONSOR_REJECTED':
        default:
          return fail('SPONSOR_REJECTED', 422, 'Transaction rejected by validation');
      }
    },
  );
};
