/**
 * POST /solana/sponsor — Solana fee-payer sponsorship (WKH-217 / HU-SOL-14).
 *
 * chaski (server-side) sends a partial-signed legacy `deposit` transaction whose
 * feePayer is the facilitator. This route: auth → Zod → PoP → rate/daily →
 * CR-1 (`validateDepositForSponsor`) + co-sign + broadcast → `{ signature }`.
 *
 * ⚠️ SECURITY: the fee-payer's key signs ONLY after CR-1 authorizes the exact
 * `deposit` (fail-closed, CD-2/CD-3). This handler never signs a blob by
 * declared metadata. AC-10: the private key and the raw tx are NEVER logged nor
 * echoed in any error body.
 *
 * Registered ONLY when `isSponsorEnabled()` (opt-in-off, CD-13) — see app.ts.
 *
 * Boundary: mirrors `src/routes/settle.ts` (auth preHandler, Zod safeParse,
 * `{ error:{ code,message,http } }` body, `request.facilitatorKeyId` bucketing).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { requireFacilitatorKey } from '../middleware/auth.js';
import { getFeePayerKeypair } from '../infra/solana-fee-payer.js';
import { cosignAndBroadcast } from '../methods/solana-sponsor/broadcast.js';
import { validateDepositForSponsor, type Cr1Config } from '../methods/solana-sponsor/cr1.js';
import { verifySponsorPop } from '../methods/solana-sponsor/pop.js';
import {
  checkAndIncrSponsorRate,
  checkAndIncrSponsorDailyLamports,
  releaseSponsorDailyLamports,
} from '../core/solana-sponsor-cap.js';

type SponsorErrorCodeHttp =
  | 'INVALID_PAYLOAD'
  | 'SPONSOR_POP_INVALID'
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

/** Route-local body schema (CD-16: does NOT reuse SettleRequestSchema). */
const SponsorRequestSchema = z.object({
  partialSignedTx: z.string().min(1),
  reference: z.string().min(1),
  sender: z.string().min(1),
  popProof: z.string().min(1),
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

      const fail = (code: SponsorErrorCodeHttp, http: number, message: string) => {
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
          },
          'solana sponsor failed',
        );
        return reply.code(http).send({ error: { code, message, http } } satisfies ErrorBody);
      };

      // Step 1 — Zod validation.
      const parsed = SponsorRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? issue.path.join('.') : 'body';
        const message = `${path}: ${issue?.message ?? 'invalid'}`.slice(0, ZOD_MESSAGE_MAX_LEN);
        return fail('INVALID_PAYLOAD', 400, message);
      }
      const body = parsed.data;

      // Step 2 — PoP gate BEFORE any parse/sign (AC-7). Fail-closed.
      if (!verifySponsorPop(body.popProof, body.sender, env.SOLANA_SPONSOR_POP_SECRET)) {
        return fail('SPONSOR_POP_INVALID', 403, 'Invalid or missing proof-of-personhood');
      }

      // Step 3 — per-caller rate-limit (fail-closed, AC-6).
      const rate = await checkAndIncrSponsorRate(
        env.SOLANA_SPONSOR_RATE_LIMIT_MAX,
        env.SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC,
        app.log,
        keyId,
      );
      if (!rate.ok) {
        return fail('SPONSOR_RATE_LIMITED', 429, 'Rate limit exceeded');
      }

      // Step 4 — resolve the fee-payer key (opt-in-off guard; never leaks value).
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

      // Step 5 — CR-1 + co-sign + broadcast. Daily-cap INCR runs fail-closed
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

      // Step 6 — map the primitive error code → HTTP (no echo of the tx).
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
