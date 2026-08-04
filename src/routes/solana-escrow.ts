/**
 * POST /solana/escrow/release — Solana escrow release (WKH-216 / HU-SOL-13, Wave 13c).
 *
 * chaski (server-side) asks the facilitator to release an escrow whose deposit is
 * already `Deposited` on-chain, after KYC + the TransFi payout order completed.
 * This route orchestrates — ALL fail-closed, in order, BEFORE any signing:
 *   auth → Zod → release attestation (KYC+TransFi gate) → readEscrowState +
 *   verifyVault (13b, SAME invocation, CD-3) → dedup claim (AC-5) → build-release
 *   from ON-CHAIN state (beneficiary NEVER from body, CD-4) → cosignAndBroadcast
 *   (HU-SOL-14 primitive, release-authority = feePayer, CD-11) → { signature }.
 *
 * El claim del Step 5 tiene un LEASE (`SOLANA_ESCROW_RELEASE_LEASE_MS`). Se escribe
 * ANTES de pedir blockhash y de firmar, así que TODO lo que pasa después puede fallar
 * con el claim ya escrito; sin expiración eso dejaba el escrow irreleaseable para
 * siempre (el reintento chocaba con el UNIQUE y comía un 409 permanente), con la
 * ventana de custodia en 2 horas y el release disparado a mano. Un claim más viejo que
 * el lease ahora puede tomarse. Lo que sostiene el AT-MOST-ONCE del broadcast:
 *   - el `UNIQUE(escrow_pda)` intacto (ninguna fila se borra jamás),
 *   - el robo como UN solo UPDATE condicional (un ganador entre N),
 *   - la cerca de un solo disparo en `onSigned` (Step 7), que además re-ancla el lease
 *     en el instante de la firma, y
 *   - el Step 4 de ESTA misma invocación, que corta con 409 si el escrow ya figura
 *     `Released` on-chain — la tentativa anterior que SÍ aterrizó se detecta ahí.
 *
 * ⚠️ SECURITY: the release-authority signs ONLY after `validateReleaseForSponsor`
 * (CR-1 of the release) authorizes the exact `release` tx (fail-closed, CD-3). The
 * `beneficiary` is ALWAYS `escrow_state.beneficiary` read on-chain (CD-4), never
 * the request body. The private key and raw tx/state are NEVER logged/echoed.
 *
 * Registered ONLY when `isReleaseEnabled()` (opt-in-off, CD-5) — see app.ts (TF8).
 *
 * [NC-2] wire-format decision (documented, founder-gated for the real semantics):
 * the "KYC confirmed + TransFi order completed" gate is option (a) — a
 * server-signed attestation passed by chaski: an HMAC-SHA256 over an INJECTIVE
 * length-prefixed encoding of `(remittanceId, sender)` (MNR-1, see
 * `encodeAttestationMessage`) keyed by `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET`
 * (read directly from process.env, opt-in-off, mirrors solana-fee-payer/pop; env.ts
 * is intentionally NOT modified — outside this HU's file scope). Fail-closed: unset
 * secret ⇒ EVERY request rejected. The REAL KYC/TransFi confirmation binding and
 * the companion HU-SOL-9 Zod wire-format remain founder-gated (Scope OUT).
 *
 * Boundary: mirrors `src/routes/solana-sponsor.ts` (auth preHandler, Zod safeParse,
 * `{ error:{ code,message,http } }` body, non-secret logging).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireFacilitatorKey } from '../middleware/auth.js';
import {
  getReleaseAuthorityKeypair,
  getReleaseAuthorityPubkey,
} from '../infra/solana-release-authority.js';
import { readEscrowState, verifyVault } from '../chains/solana-escrow.js';
import {
  claimEscrowRelease,
  markReleaseSigned,
  stealStaleReleaseClaim,
  type ReleaseClaimEntry,
} from '../infra/solana-escrow-release-dedup.js';
import { buildReleaseTx } from '../methods/solana-escrow/build-release.js';
import { validateReleaseForSponsor } from '../methods/solana-escrow/cr1-release.js';
import { cosignAndBroadcast } from '../methods/solana-sponsor/broadcast.js';
import type { Cr1Config } from '../methods/solana-sponsor/cr1.js';

type ReleaseErrorCode =
  | 'INVALID_PAYLOAD'
  | 'RELEASE_REJECTED'
  | 'RELEASE_REPLAY'
  | 'RELEASE_STORE_UNAVAILABLE'
  | 'RELEASE_NOT_ENABLED'
  | 'RELEASE_BROADCAST_EXPIRED'
  | 'RELEASE_BROADCAST_FAILED';

interface ErrorBody {
  readonly error: {
    readonly code: ReleaseErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

const ZOD_MESSAGE_MAX_LEN = 200;

/** Route-local body schema (does NOT reuse SettleRequestSchema). */
const ReleaseRequestSchema = z.object({
  remittanceId: z.string().min(1),
  sender: z.string().min(1),
  attestation: z.string().min(1),
});

/**
 * INJECTIVE encoding of the attestation fields (MNR-1). The naive `${a}:${b}` is
 * non-injective — `("a:b","c")` and `("a","b:c")` collide, so an attestation could
 * be replayed across escrows if the field semantics ever changed. We length-prefix
 * `remittanceId` so the boundary between the two fields is unambiguous:
 * `${len}:${remittanceId}${sender}` — the decoder reads `len`, then exactly `len`
 * chars for `remittanceId`, and the remainder is `sender`. Single source of truth:
 * BOTH the server (`verifyReleaseAttestation`) and any client (chaski / tests)
 * MUST build the HMAC message through this function.
 */
function encodeAttestationMessage(remittanceId: string, sender: string): string {
  return `${remittanceId.length}:${remittanceId}${sender}`;
}

/**
 * Compute the expected release attestation (KYC+TransFi gate). Exported so chaski's
 * server companion mirrors it; here it is the reference. HMAC over the INJECTIVE
 * `encodeAttestationMessage(remittanceId, sender)` keyed by the shared secret
 * (MNR-1 — the shared SECRET is unchanged; only the signed message encoding is
 * hardened).
 */
export function computeReleaseAttestation(
  remittanceId: string,
  sender: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(encodeAttestationMessage(remittanceId, sender))
    .digest('hex');
}

/** Verify the release attestation. Fail-closed: unset secret / bad HMAC → false. */
function verifyReleaseAttestation(
  attestation: string,
  remittanceId: string,
  sender: string,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0) return false;
  if (attestation.length === 0 || remittanceId.length === 0 || sender.length === 0) return false;
  const expected = computeReleaseAttestation(remittanceId, sender, secret);
  const a = Buffer.from(attestation);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const solanaEscrowReleaseRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  const leaseMs = env.SOLANA_ESCROW_RELEASE_LEASE_MS;
  const cr1cfg: Cr1Config = {
    escrowProgramId: env.SOLANA_ESCROW_PROGRAM_ID,
    maxComputeUnits: env.SOLANA_SPONSOR_MAX_COMPUTE_UNITS,
    maxPriorityFeeMicroLamports: env.SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS,
    maxFeeLamports: BigInt(env.SOLANA_SPONSOR_MAX_FEE_LAMPORTS),
    // Campo compartido con el `deposit`. `validateReleaseForSponsor` NO lo lee: el
    // mint del release se contrasta contra el `EscrowState` on-chain (`verifyVault`,
    // chains/solana-escrow.ts:220). Va igual para que el día que lo lea encuentre
    // el valor configurado y no un `undefined`.
    usdcMint: env.SOLANA_USDC_MINT,
  };

  app.post(
    '/solana/escrow/release',
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
        code: ReleaseErrorCode,
        http: number,
        message: string,
        /**
         * Marcador interno de qué cortó. NO se ecoa en la respuesta (mismo
         * no-oracle que `solana-sponsor.ts`: al cliente no se le dice por qué
         * falló). Sin él, `RELEASE_REJECTED / 422` era el destino común de la
         * attestation inválida, del vault que no verifica y de las DOS causas de
         * `readEscrowState` — y esas dos son opuestas para el operador:
         * `ESCROW_STATE_NOT_FOUND` es "ese escrow no existe" y
         * `ESCROW_READ_FAILED` es "el RPC se cayó y no pude preguntar".
         * NUNCA lleva la tx, el state ni bytes del body.
         */
        guard?: string,
      ) => {
        // Log ONLY the error code / non-secret keyId + guard — never the body/tx/state.
        app.log.warn(
          {
            request_id: requestId,
            error_code: code,
            http_status: http,
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
            ...(guard === undefined ? {} : { guard }),
          },
          'solana escrow release failed',
        );
        return reply.code(http).send({ error: { code, message, http } } satisfies ErrorBody);
      };

      // Step 1 — Zod validation.
      const parsed = ReleaseRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? issue.path.join('.') : 'body';
        const message = `${path}: ${issue?.message ?? 'invalid'}`.slice(0, ZOD_MESSAGE_MAX_LEN);
        return fail('INVALID_PAYLOAD', 400, message);
      }
      const body = parsed.data;

      // Step 2 — KYC + TransFi gate ([NC-2], fail-closed). BEFORE any read/sign.
      const attestationSecret = process.env.SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET;
      if (
        !verifyReleaseAttestation(
          body.attestation,
          body.remittanceId,
          body.sender,
          attestationSecret,
        )
      ) {
        return fail(
          'RELEASE_REJECTED',
          422,
          'KYC/TransFi attestation invalid',
          'ATTESTATION_INVALID',
        );
      }

      // Step 3 — resolve the release-authority key + RPC/mint (opt-in-off guards).
      let authorityKeypair: Keypair;
      try {
        authorityKeypair = getReleaseAuthorityKeypair();
      } catch {
        return fail(
          'RELEASE_NOT_ENABLED',
          501,
          'Escrow release is not enabled',
          'RELEASE_AUTHORITY_UNAVAILABLE',
        );
      }
      const rpcUrl = env.SOLANA_RPC_URL;
      const usdcMint = env.SOLANA_USDC_MINT;
      if (
        rpcUrl === undefined ||
        rpcUrl.length === 0 ||
        usdcMint === undefined ||
        usdcMint.length === 0
      ) {
        return fail(
          'RELEASE_NOT_ENABLED',
          501,
          'Escrow release is not enabled',
          rpcUrl === undefined || rpcUrl.length === 0 ? 'RPC_URL_UNSET' : 'USDC_MINT_UNSET',
        );
      }
      const network = rpcUrl.includes('mainnet') ? 'solana:mainnet' : 'solana:devnet';

      // Step 4 — read + verify on-chain EscrowState (13b, SAME invocation, CD-3).
      const connection = new Connection(rpcUrl, 'confirmed');
      const read = await readEscrowState({
        sender: body.sender,
        remittanceId: body.remittanceId,
        connection,
        programId: env.SOLANA_ESCROW_PROGRAM_ID,
      });
      if (!read.ok) {
        // ⚠️ `read.reason` es lo único que separa "el escrow no existe"
        // (`ESCROW_STATE_NOT_FOUND`) de "el RPC se cayó" (`ESCROW_READ_FAILED`).
        // Sin él las dos salen como el mismo 422 'Escrow state unreadable'.
        return fail('RELEASE_REJECTED', 422, 'Escrow state unreadable', read.reason);
      }
      const { state, vaultAmount } = read;

      // AC-5: an already-Released escrow is a replay → 409 (never re-sign).
      if (state.status === 'Released') {
        return fail('RELEASE_REPLAY', 409, 'Escrow already released', 'STATE_ALREADY_RELEASED');
      }

      const verified = verifyVault(state, vaultAmount, usdcMint);
      if (!verified.ok) {
        return fail('RELEASE_REJECTED', 422, 'Vault verification failed', verified.reason);
      }

      // Step 5 — dedup claim (AC-5 / CD-9, fail-closed, mutate-first).
      const claimEntry: ReleaseClaimEntry = {
        escrowPda: state.escrowStatePda,
        sender: state.sender,
        remittanceId: body.remittanceId,
        network,
      };
      const claim = await claimEscrowRelease(claimEntry, app.log);
      if (!claim.ok) {
        return fail(
          'RELEASE_STORE_UNAVAILABLE',
          500,
          'Release dedup store unavailable',
          'DEDUP_STORE_UNAVAILABLE',
        );
      }
      if (!claim.claimed) {
        // El claim ya existía. Antes esto era el final del camino PARA SIEMPRE: como
        // el claim se escribe ANTES de pedir blockhash y de firmar, cualquier fallo
        // posterior al INSERT (un hipo del RPC alcanzaba) dejaba el escrow
        // irreleaseable y el beneficiario sin cobrar, con el refund del sender como
        // único escape. Ahora un claim más viejo que el lease puede TOMARSE.
        //
        // El robo es UN solo UPDATE condicional: de N reintentos concurrentes
        // exactamente uno sigue. Y no re-firma a ciegas — el escrow ya figuraba
        // distinto de `Released` en la lectura on-chain del Step 4, en ESTA misma
        // invocación, así que una tentativa anterior que sí aterrizó ya cortó arriba
        // con 409.
        const steal = await stealStaleReleaseClaim(claimEntry, leaseMs, app.log);
        if (!steal.ok) {
          return fail(
            'RELEASE_STORE_UNAVAILABLE',
            500,
            'Release dedup store unavailable',
            'DEDUP_STORE_UNAVAILABLE',
          );
        }
        if (!steal.stolen) {
          // Lease vigente: hay una tentativa que puede estar viva. Mismo código que
          // antes (contrato público sin cambios); el marcador del log distingue este
          // caso del claim viejo, que ahora sí reintenta.
          return fail('RELEASE_REPLAY', 409, 'Release already claimed', 'DEDUP_LEASE_HELD');
        }
      }

      // Step 6 — build the release tx from ON-CHAIN state (beneficiary from state, CD-4).
      let releaseTxBase64: string;
      try {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        releaseTxBase64 = buildReleaseTx({
          state,
          remittanceId: body.remittanceId,
          authority: getReleaseAuthorityPubkey(),
          recentBlockhash: blockhash,
          escrowProgramId: env.SOLANA_ESCROW_PROGRAM_ID,
        });
      } catch {
        return fail(
          'RELEASE_BROADCAST_EXPIRED',
          409,
          'Could not fetch a fresh blockhash',
          'BLOCKHASH_FETCH_FAILED',
        );
      }

      // Step 7 — CR-1 (release) + co-sign + broadcast (HU-SOL-14 primitive, CD-11).
      const result = await cosignAndBroadcast(releaseTxBase64, {
        feePayerKeypair: authorityKeypair,
        validate: validateReleaseForSponsor(state, cr1cfg),
        rpcUrl,
        maxFeeLamports: cr1cfg.maxFeeLamports,
        maxRebroadcasts: env.SOLANA_SPONSOR_MAX_REBROADCASTS,
        // La CERCA de un solo disparo, entre `partialSign` y `serialize`. Cubre el
        // interleaving que el lease solo no cubre: A cuelga, B le toma el claim, y
        // después A revive y firma. Acá exactamente uno gana el paso a `signed`; el
        // otro recibe `{ ok:false }` y el primitivo NO transmite (SPONSOR_PERSIST_FAILED).
        //
        // También re-ancla el lease en el instante de la firma, que es el único
        // momento a partir del cual pudo existir una tx: sin eso el lease tendría que
        // cubrir un hueco sin cota (un `getLatestBlockhash` colgado se lo come solo).
        onSigned: () => markReleaseSigned(claimEntry, app.log),
      });

      if (result.ok) {
        app.log.info(
          {
            request_id: requestId,
            method: 'solana-escrow-release',
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
          },
          'solana escrow release ok',
        );
        return reply.code(200).send({ signature: result.signature });
      }

      // Step 8 — map the primitive error code → HTTP (no echo of the tx/state).
      switch (result.code) {
        case 'SPONSOR_UNSUPPORTED_TX':
          return fail(
            'RELEASE_REJECTED',
            422,
            'Unsupported transaction (versioned)',
            result.reason,
          );
        case 'SPONSOR_BROADCAST_EXPIRED':
          return fail(
            'RELEASE_BROADCAST_EXPIRED',
            409,
            'Transaction blockhash expired',
            result.reason,
          );
        case 'SPONSOR_BROADCAST_FAILED':
          return fail('RELEASE_BROADCAST_FAILED', 502, 'Broadcast failed', result.reason);
        case 'SPONSOR_PERSIST_FAILED':
          // La cerca no se pudo tomar (otro request ya pasó a `signed`, o el store
          // no respondió). El primitivo NO transmitió, así que este request no
          // gastó nada. Iba a caer en el `default:` de abajo, que dice "rechazada
          // por validación" — un diagnóstico falso para un problema de almacenamiento.
          return fail(
            'RELEASE_STORE_UNAVAILABLE',
            500,
            'Release dedup store unavailable',
            result.reason,
          );
        case 'SPONSOR_DAILY_CAP':
        case 'SPONSOR_REJECTED':
        default:
          return fail('RELEASE_REJECTED', 422, 'Transaction rejected by validation', result.reason);
      }
    },
  );
};
