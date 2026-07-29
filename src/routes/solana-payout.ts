/**
 * POST /solana/payout — the facilitator ORIGINATES an SPL payout (WKH-302).
 *
 * ⚠️ THIS IS A DEDICATED ROUTE ON PURPOSE. It is NOT a mode of `/settle`, and it
 * must never become one. `/settle` means "here is a payment that ALREADY happened;
 * verify and record it" — the facilitator is a WITNESS. This route means "originate
 * a payment from YOUR treasury" — the facilitator is the TREASURER. A shared
 * endpoint would put both powers behind the same auth and tell them apart by the
 * ABSENCE OF A FIELD, so any regression that drops that field (a caller bug, a
 * middleware that prunes the body, a convenient `.optional()` in a Zod, a
 * serializer that strips nulls) would silently PROMOTE A VERIFICATION INTO A SPEND.
 * An omitted field cannot be the boundary between looking and paying.
 *
 * Registered ONLY when `isSolanaPayoutEnabled()` — flag ON, key present and
 * parseable, AND the key distinct from the fee-payer's and the release-authority's
 * (AC-11). Otherwise the route is not registered and POST /solana/payout 404s.
 *
 * Order of gates (§6.4, CD-17) — the CLAIM is the LAST gate before signing:
 *   1 auth  2 Zod  3 cluster  4 per-payout cap  5 rate-limit  6 key
 *   7 funding pre-check (READ-ONLY)  8 daily reservation  9 CLAIM
 *   10 blockhash+build  11 validate+sign+persist+broadcast  12 confirm
 * Cheap rejections must NOT burn the `intentId`: if the claim came before the
 * funding check, a rejection for insufficient balance would leave the intent
 * claimed and the legitimate retry would eat PAYOUT_IN_PROGRESS for the whole lease.
 *
 * Error codes are a route-LOCAL union. They are deliberately NOT added to
 * `X402ErrorCode` / `HTTP_BY_CODE` / `AuditMeta.errorCode`: widening a shared EVM
 * type to fit a non-EVM code is a mistake this repo already made once.
 *
 * Boundary: see OWNERS.md note [6] (dedicated non-x402 routes may import
 * `methods/*` and `chains/*`).
 */

import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { requireFacilitatorKey } from '../middleware/auth.js';
import { getPayoutOperatorKeypair } from '../infra/solana-payout-operator.js';
import {
  claimPayout,
  markConfirmed,
  markSigned,
  revertSignedToClaimed,
  stealStaleClaim,
  type PayoutIntent,
  type PayoutRow,
} from '../infra/solana-payout-ledger.js';
import {
  checkAndIncrPayoutDailyAtomic,
  checkAndIncrPayoutRate,
  releasePayoutDailyAtomic,
} from '../core/solana-payout-cap.js';
import { buildPayoutTx } from '../methods/solana-payout/build-transfer.js';
import { validatePayoutTx } from '../methods/solana-payout/validate-transfer.js';
import { verifyPayoutSignature } from '../methods/solana-payout/verify-transfer.js';
import {
  PAYOUT_SENTINEL_ID,
  encodeSignatureBase58,
} from '../methods/solana-payout/payout-shape.js';
import { cosignAndBroadcast } from '../methods/solana-sponsor/broadcast.js';
import { deriveAta } from '../chains/solana-escrow.js';

type PayoutErrorCode =
  | 'INVALID_PAYLOAD'
  | 'NETWORK_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'PAYOUT_NOT_ENABLED'
  | 'PAYOUT_RATE_LIMITED'
  | 'PAYOUT_DAILY_CAP'
  | 'PAYOUT_FUNDING_LOW'
  | 'PAYOUT_RPC_UNAVAILABLE'
  | 'PAYOUT_STORE_UNAVAILABLE'
  | 'PAYOUT_INTENT_CONFLICT'
  | 'PAYOUT_IN_PROGRESS'
  | 'PAYOUT_BROADCAST_EXPIRED'
  | 'PAYOUT_BROADCAST_FAILED';

interface ErrorBody {
  readonly error: {
    readonly code: PayoutErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

const ZOD_MESSAGE_MAX_LEN = 200;
const USDC_DECIMALS = 6;

/** Route-local body schema. Deliberately NOT SettleRequestSchema (CD-9). */
const PayoutRequestSchema = z.object({
  intentId: z.string().min(1).max(200),
  payTo: z.string().min(32).max(44),
  amountAtomic: z.string().regex(/^[1-9][0-9]*$/),
  network: z.enum(['solana:devnet', 'solana:mainnet']),
});

/** Outcome of resolving a request that LOST the claim race (§6.5). */
type ResolveOutcome =
  | { readonly kind: 'proceed' } // this request now owns the claim and may sign
  | { readonly kind: 'replay'; readonly signature: string } // already paid, verified
  | {
      readonly kind: 'reject';
      readonly code: PayoutErrorCode;
      readonly http: number;
      readonly message: string;
    };

interface ResolveDeps {
  readonly intent: PayoutIntent;
  readonly amountAtomic: bigint;
  readonly connection: Connection;
  readonly leaseMs: number;
  readonly logger: FastifyBaseLogger;
}

const inProgress = (): ResolveOutcome => ({
  kind: 'reject',
  code: 'PAYOUT_IN_PROGRESS',
  http: 409,
  message: 'A payout for this intent is in progress',
});

const storeUnavailable = (): ResolveOutcome => ({
  kind: 'reject',
  code: 'PAYOUT_STORE_UNAVAILABLE',
  http: 500,
  message: 'Payout ledger unavailable',
});

/**
 * §6.5 state machine for a request that lost the claim.
 *
 * The CONFLICT check (AC-9) runs FIRST and unconditionally: a replay that changed
 * the terms never gets the previous signature back and never signs a new payment.
 *
 * Everything else hangs off invariant I2 — `claimed` (no signature) proves no LIVE
 * broadcast exists — which is what makes stealing a stale claim safe.
 */
export async function resolveExistingRow(
  row: PayoutRow,
  deps: ResolveDeps,
): Promise<ResolveOutcome> {
  const { intent, amountAtomic, connection, leaseMs, logger } = deps;

  // AC-9 — same intentId, different terms. Evaluated BEFORE any other state
  // resolution, so a caller cannot rewrite what it asked for and still be told
  // "already paid".
  if (
    row.payTo !== intent.payTo ||
    row.mint !== intent.mint ||
    BigInt(row.amountAtomic) !== amountAtomic
  ) {
    return {
      kind: 'reject',
      code: 'PAYOUT_INTENT_CONFLICT',
      http: 409,
      message: 'intentId already used with different terms',
    };
  }

  if (row.status === 'claimed') {
    // Only a claim older than the lease may be taken over. By I2 it carries no
    // signature, so nothing was ever broadcast and re-signing cannot double-pay.
    const stolen = await stealStaleClaim(intent, leaseMs, logger);
    if (!stolen.ok) return storeUnavailable();
    return stolen.stolen ? { kind: 'proceed' } : inProgress();
  }

  const signature = row.signature;
  if (signature === null) {
    // signed/confirmed without a signature is an impossible row; treat it as
    // unknown rather than asserting anything about the money.
    return inProgress();
  }

  // Verify-before-trust (CD-8): never hand back a signature the chain does not
  // back — not even one we wrote ourselves.
  const verified = await verifyPayoutSignature(connection, {
    signature,
    payTo: intent.payTo,
    mint: intent.mint,
    amountAtomic: intent.amountAtomic,
  });
  if (verified.valid) {
    await markConfirmed(intent, signature, logger);
    return { kind: 'replay', signature };
  }

  if (row.status === 'confirmed') {
    // Recorded confirmed yet unverifiable on-chain right now: we do NOT know the
    // disposition, so we must not claim it was unpaid and must not pay again.
    return inProgress();
  }

  // status === 'signed' and not verifiable: can that transaction still land?
  const blockhash = row.recentBlockhash;
  let stillValid: boolean;
  if (blockhash === null) {
    stillValid = false;
  } else {
    try {
      const res = await connection.isBlockhashValid(blockhash);
      stillValid = res.value === true;
    } catch {
      // Cannot tell → assume it may still land. Never re-sign on a guess.
      stillValid = true;
    }
  }
  if (stillValid) return inProgress();

  // The blockhash is dead: that tx can never land, so re-signing is safe.
  const reverted = await revertSignedToClaimed(intent, signature, logger);
  if (!reverted.ok) return storeUnavailable();
  return reverted.reverted ? { kind: 'proceed' } : inProgress();
}

export const solanaPayoutRoute: FastifyPluginAsync = async (app) => {
  const env = app.env;
  const maxAmountAtomic = BigInt(env.SOLANA_PAYOUT_MAX_AMOUNT_ATOMIC);
  const dailyMaxAtomic = BigInt(env.SOLANA_PAYOUT_DAILY_MAX_ATOMIC);
  const minSolLamports = BigInt(env.SOLANA_PAYOUT_MIN_SOL_LAMPORTS);
  const maxFeeLamports = BigInt(env.SOLANA_SPONSOR_MAX_FEE_LAMPORTS);
  const leaseMs = env.SOLANA_PAYOUT_LEASE_MS;

  app.post(
    '/solana/payout',
    {
      preHandler: requireFacilitatorKey,
      config: {
        rateLimit: {
          max: env.SOLANA_PAYOUT_RATE_LIMIT_MAX,
          timeWindow: env.SOLANA_PAYOUT_RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const requestId = request.id;
      const keyId = request.facilitatorKeyId;

      const fail = (code: PayoutErrorCode, http: number, message: string) => {
        // Log ONLY the code + non-secret ids — never the body, the key or the tx.
        app.log.warn(
          {
            request_id: requestId,
            error_code: code,
            http_status: http,
            facilitator_key_id: keyId,
            duration_ms: Date.now() - startMs,
          },
          'solana payout failed',
        );
        return reply.code(http).send({ error: { code, message, http } } satisfies ErrorBody);
      };

      // ── Step 1 — the ledger is partitioned by caller, so an anonymous caller
      // cannot be served: its rows would collide with everyone else's.
      if (keyId === undefined || keyId.length === 0) {
        return fail('PAYOUT_NOT_ENABLED', 501, 'Solana payout is not enabled');
      }

      // ── Step 2 — Zod (route-local).
      const parsed = PayoutRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? issue.path.join('.') : 'body';
        const message = `${path}: ${issue?.message ?? 'invalid'}`.slice(0, ZOD_MESSAGE_MAX_LEN);
        return fail('INVALID_PAYLOAD', 400, message);
      }
      const body = parsed.data;

      // ── Step 3 — cluster match.
      const rpcUrl = env.SOLANA_RPC_URL;
      const usdcMint = env.SOLANA_USDC_MINT;
      if (
        rpcUrl === undefined ||
        rpcUrl.length === 0 ||
        usdcMint === undefined ||
        usdcMint.length === 0
      ) {
        return fail('PAYOUT_NOT_ENABLED', 501, 'Solana payout is not enabled');
      }
      const network = rpcUrl.includes('mainnet') ? 'solana:mainnet' : 'solana:devnet';
      if (body.network !== network) {
        return fail('NETWORK_MISMATCH', 400, 'network does not match the configured cluster');
      }

      // ── Step 4 — per-payout ceiling, in BigInt (CD-10). A Number() comparison
      // would let an amount above 2^53 through by rounding.
      let amountAtomic: bigint;
      try {
        amountAtomic = BigInt(body.amountAtomic);
      } catch {
        return fail('INVALID_PAYLOAD', 400, 'amountAtomic: not a decimal integer');
      }
      if (amountAtomic > maxAmountAtomic) {
        return fail('INVALID_AMOUNT', 400, 'amount above the per-payout cap');
      }

      // ── Step 5 — per-caller rate-limit (fail-CLOSED).
      const rate = await checkAndIncrPayoutRate(
        env.SOLANA_PAYOUT_RATE_LIMIT_MAX,
        env.SOLANA_PAYOUT_RATE_LIMIT_WINDOW_SEC,
        app.log,
        keyId,
      );
      if (!rate.ok) {
        return fail('PAYOUT_RATE_LIMITED', 429, 'Rate limit exceeded');
      }

      // ── Step 6 — resolve the payout key. The AC-11 separation gate already ran
      // at boot (the route would not be registered otherwise); this is the
      // per-request guard against a key that became unreadable.
      let operatorKeypair: Keypair;
      try {
        operatorKeypair = getPayoutOperatorKeypair();
      } catch {
        return fail('PAYOUT_NOT_ENABLED', 501, 'Solana payout is not enabled');
      }
      const operator = operatorKeypair.publicKey;

      let payTo: PublicKey;
      let mint: PublicKey;
      try {
        payTo = new PublicKey(body.payTo);
        mint = new PublicKey(usdcMint);
      } catch {
        return fail('INVALID_PAYLOAD', 400, 'payTo: not a valid base58 pubkey');
      }

      const connection = new Connection(rpcUrl, 'confirmed');
      const intent: PayoutIntent = {
        callerKeyId: keyId,
        intentId: body.intentId,
        network,
        payTo: body.payTo,
        mint: usdcMint,
        amountAtomic: body.amountAtomic,
      };

      // ── Step 7 — funding pre-check, READ-ONLY (AC-8). An RPC failure here is
      // NOT funding-low: confusing them trains the operator to top up a wallet
      // that is fine (inherited from base-adapter.ts OPERATOR_FUNDING_LOW).
      try {
        const lamports = await connection.getBalance(operator);
        if (BigInt(lamports) < minSolLamports) {
          app.log.warn(
            { facilitator_key_id: keyId, operator: operator.toBase58(), lamports },
            'solana payout: operator SOL below the floor',
          );
          return fail('PAYOUT_FUNDING_LOW', 503, 'Payout operator is underfunded');
        }
      } catch {
        return fail('PAYOUT_RPC_UNAVAILABLE', 503, 'Could not read the operator balance');
      }

      // The SOURCE ATA is NEVER created: its absence means the operator has no
      // funds, which is a funding problem, not something to fix by spending rent.
      const sourceAta = deriveAta(operator, mint);
      try {
        const bal = await connection.getTokenAccountBalance(sourceAta);
        if (BigInt(bal.value.amount) < amountAtomic) {
          app.log.warn(
            { facilitator_key_id: keyId, source_ata: sourceAta.toBase58() },
            'solana payout: operator SPL balance below the requested amount',
          );
          return fail('PAYOUT_FUNDING_LOW', 503, 'Payout operator is underfunded');
        }
      } catch {
        return fail('PAYOUT_FUNDING_LOW', 503, 'Payout operator is underfunded');
      }

      // The DESTINATION may legitimately not exist yet — that is exactly what the
      // in-transaction CreateIdempotent is for.
      let destinationExists: boolean;
      try {
        await connection.getTokenAccountBalance(deriveAta(payTo, mint));
        destinationExists = true;
      } catch {
        destinationExists = false;
      }

      // ── Step 8 — reserve the daily ceiling (fail-CLOSED).
      const daily = await checkAndIncrPayoutDailyAtomic(
        amountAtomic,
        dailyMaxAtomic,
        app.log,
        keyId,
      );
      if (!daily.ok) {
        return fail('PAYOUT_DAILY_CAP', 429, 'Daily payout cap reached');
      }
      let reserved = true;
      const releaseReservation = async (): Promise<void> => {
        if (!reserved) return;
        reserved = false;
        await releasePayoutDailyAtomic(amountAtomic, dailyMaxAtomic, app.log, keyId);
      };

      // ── Step 9 — CLAIM. The LAST gate before signing (CD-17).
      const claim = await claimPayout(intent, app.log);
      if (!claim.ok) {
        await releaseReservation();
        return fail('PAYOUT_STORE_UNAVAILABLE', 500, 'Payout ledger unavailable');
      }

      if (!claim.claimed) {
        const resolved = await resolveExistingRow(claim.row, {
          intent,
          amountAtomic,
          connection,
          leaseMs,
          logger: app.log,
        });
        if (resolved.kind === 'replay') {
          await releaseReservation();
          return reply.code(200).send({
            signature: resolved.signature,
            network,
            payTo: body.payTo,
            amountAtomic: body.amountAtomic,
            alreadySettled: true,
          });
        }
        if (resolved.kind === 'reject') {
          await releaseReservation();
          return fail(resolved.code, resolved.http, resolved.message);
        }
        // resolved.kind === 'proceed' → this request owns the claim and may sign.
      }

      // ── Step 10 — fresh blockhash + build (unsigned).
      let txBase64: string;
      let blockhash: string;
      try {
        const latest = await connection.getLatestBlockhash('confirmed');
        blockhash = latest.blockhash;
        txBase64 = buildPayoutTx({
          payoutOperator: operator,
          payTo,
          mint,
          decimals: USDC_DECIMALS,
          amountAtomic,
          recentBlockhash: blockhash,
          createDestinationAta: !destinationExists,
        });
      } catch {
        await releaseReservation();
        return fail('PAYOUT_BROADCAST_EXPIRED', 409, 'Could not fetch a fresh blockhash');
      }

      // ── Step 11 — validate + sign + PERSIST + broadcast.
      const result = await cosignAndBroadcast(txBase64, {
        feePayerKeypair: operatorKeypair,
        validate: validatePayoutTx({
          payoutOperator: operator,
          payTo,
          mint,
          decimals: USDC_DECIMALS,
          amountAtomic,
          maxFeeLamports,
        }),
        rpcUrl,
        maxFeeLamports,
        maxRebroadcasts: env.SOLANA_SPONSOR_MAX_REBROADCASTS,
        mutexId: PAYOUT_SENTINEL_ID,
        // Invariant I2: persist the signature BEFORE the tx can possibly land. If
        // this fails the primitive does NOT broadcast — otherwise we could not
        // tell a retry whether it had already paid.
        onSigned: async (tx) => {
          const raw = tx.signatures.at(0)?.signature;
          if (!raw) return { ok: false };
          const signature = encodeSignatureBase58(Uint8Array.from(raw));
          return markSigned(intent, signature, blockhash, app.log);
        },
      });

      // ── Step 12 — confirm + respond.
      if (result.ok) {
        await markConfirmed(intent, result.signature, app.log);
        app.log.info(
          {
            request_id: requestId,
            method: 'solana-payout',
            facilitator_key_id: keyId,
            intent_id: body.intentId,
            duration_ms: Date.now() - startMs,
          },
          'solana payout ok',
        );
        return reply.code(200).send({
          signature: result.signature,
          network,
          payTo: body.payTo,
          amountAtomic: body.amountAtomic,
          alreadySettled: false,
        });
      }

      // §6.6.4 — every terminal failure releases the reservation EXCEPT a broadcast
      // that may have landed: there the debit is KEPT, conservatively.
      if (result.code === 'SPONSOR_BROADCAST_FAILED') {
        reserved = false;
      } else {
        await releaseReservation();
      }

      switch (result.code) {
        case 'SPONSOR_BROADCAST_EXPIRED':
          return fail('PAYOUT_BROADCAST_EXPIRED', 409, 'Transaction blockhash expired');
        case 'SPONSOR_BROADCAST_FAILED':
          return fail('PAYOUT_BROADCAST_FAILED', 502, 'Broadcast could not be confirmed');
        case 'SPONSOR_PERSIST_FAILED':
          return fail('PAYOUT_STORE_UNAVAILABLE', 500, 'Payout ledger unavailable');
        default:
          return fail('INVALID_PAYLOAD', 400, 'Transaction rejected by validation');
      }
    },
  );
};
