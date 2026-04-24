/**
 * POST /settle — x402 HTTP API settlement endpoint (WFAC-21).
 *
 * Critical difference vs /verify: this endpoint triggers an on-chain write
 * (transferWithAuthorization via EIP-3009). Idempotency is a CORRECTNESS
 * mechanism — if the client re-sends the same body while the tx is in-flight
 * or already mined, we MUST return the cached response without invoking the
 * adapter a second time (double-spend prevention).
 *
 * Layers (top-down, mirrors routes/verify.ts):
 *   1. Zod shape validation → INVALID_PAYLOAD 400.
 *   2. Idempotency cache lookup (CD-9 via isRedisAvailable helper).
 *   3. Core orchestrator dispatch (src/core/settle.ts).
 *   4. Cache successful/non-5xx response (CD-12 via toCacheableSettle).
 *   5. Map Result<SettleResult> → HTTP (CD-2 spec-literal on 200, CD-5 on errors).
 *
 * Logging (SDD §DT-7): 4 line templates. NO PII — CD-3 applies to every line.
 *   tx_hash is AUTHORIZED on success lines (public on-chain data — CD-12 nuevo).
 *
 * CD-1/CD-10 observed: no imports from src/chains/*, src/methods/*, src/infra/*.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SettleRequestSchema, type SettleRequest } from '../core/schemas.js';
import { settleCore } from '../core/settle.js';
import {
  buildSettleIdempotencyKey,
  getCachedSettleResponse,
  setCachedSettleResponse,
  isRedisAvailable,
  toCacheableSettle,
  type CachedSettleResponse,
} from '../core/idempotency.js';

/** Route-local union: X402ErrorCode + 'INVALID_PAYLOAD' literal. */
type SettleRouteErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID'
  | 'INVALID_PAYLOAD';

interface ErrorBody {
  readonly error: {
    readonly code: SettleRouteErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

/** Max length of the Zod issue message we surface to clients (DT-Zod cap). */
const ZOD_MESSAGE_MAX_LEN = 200;

export const settleRoute: FastifyPluginAsync = async (app) => {
  app.post('/settle', async (request, reply) => {
    const startMs = Date.now();
    const requestId = request.id;

    // Step 1 — Zod validation
    const parseResult = SettleRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : 'body';
      const rawMsg = issue?.message ?? 'invalid';
      const message = `${path}: ${rawMsg}`.slice(0, ZOD_MESSAGE_MAX_LEN);
      const body: ErrorBody = {
        error: { code: 'INVALID_PAYLOAD', message, http: 400 },
      };
      app.log.warn(
        {
          request_id: requestId,
          error_code: 'INVALID_PAYLOAD',
          http_status: 400,
          duration_ms: Date.now() - startMs,
        },
        'settle failed',
      );
      return reply.code(400).send(body);
    }
    const parsed: SettleRequest = parseResult.data;

    // Step 2 — idempotency lookup
    const idempotencyKey = buildSettleIdempotencyKey(parsed);
    const redisUp = isRedisAvailable();
    if (redisUp) {
      const cached = await getCachedSettleResponse(idempotencyKey);
      if (cached) {
        return sendCachedSettle(reply, cached, {
          requestId,
          startMs,
          network: parsed.accepted.network,
          app,
        });
      }
    } else {
      // AC-10 graceful degradation — L2 warn
      app.log.warn({ request_id: requestId }, 'idempotency cache miss — Redis unavailable');
    }

    // Step 3 — dispatch to core
    let result;
    try {
      result = await settleCore(parsed);
    } catch (err: unknown) {
      // L4 — adapter threw. Defense-in-depth (CD-4 + SDD §DT-8).
      app.log.error(
        {
          request_id: requestId,
          error_code: 'TRANSACTION_FAILED',
          http_status: 500,
          err_type: (err as Error)?.name ?? 'UnknownError',
          duration_ms: Date.now() - startMs,
        },
        'settle adapter threw',
      );
      const body: ErrorBody = {
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'Internal adapter error',
          http: 500,
        },
      };
      return reply.code(500).send(body);
    }

    // Step 4 — cache (CD-12 filters 5xx inside toCacheableSettle)
    if (redisUp) {
      const cacheable = toCacheableSettle(result);
      if (cacheable) {
        await setCachedSettleResponse(idempotencyKey, cacheable);
      }
    }

    // Step 5 — map Result<SettleResult> → HTTP
    if (!result.ok) {
      // L3 — warn
      app.log.warn(
        {
          request_id: requestId,
          error_code: result.error.code,
          http_status: result.error.http,
          duration_ms: Date.now() - startMs,
        },
        'settle failed',
      );
      return reply.code(result.error.http).send({ error: result.error } satisfies ErrorBody);
    }

    // Success — L1 info with tx_hash (CD-12 nuevo; tx_hash is public on-chain).
    app.log.info(
      {
        request_id: requestId,
        network: parsed.accepted.network,
        method: 'eip3009',
        duration_ms: Date.now() - startMs,
        tx_hash: result.transactionHash,
      },
      'settle ok',
    );

    // CD-2 adaptado: spec-literal 200 body — 7 fields, EXPLICIT object build
    // (NO rest-spread destructure — WFAC-20 auto-blindaje W1 lesson).
    return reply.code(200).send({
      settled: result.settled,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      amount: result.amount,
      from: result.from,
      to: result.to,
      asset: result.asset,
    });
  });
};

// ─── helpers (not exported) ─────────────────────────────────────────────────

interface SendCachedCtx {
  readonly requestId: string;
  readonly startMs: number;
  readonly network: string;
  readonly app: {
    readonly log: {
      readonly info: (...a: unknown[]) => void;
      readonly warn: (...a: unknown[]) => void;
    };
  };
}

/**
 * CD-11 nuevo: cached-hit replay reconstructs the 7-field body EXPLICITLY
 * from cached.response. Do NOT `reply.send(cached.response)` — even though
 * the object already has the right shape, an explicit rebuild guarantees
 * that a future refactor of CachedSettleResponseOk cannot leak extra fields
 * into the HTTP response.
 */
function sendCachedSettle(
  reply: FastifyReply,
  cached: CachedSettleResponse,
  ctx: SendCachedCtx,
): FastifyReply {
  const { requestId, startMs, network, app } = ctx;
  if (cached.ok) {
    // CD-12 nuevo: cached success also logs tx_hash.
    app.log.info(
      {
        request_id: requestId,
        network,
        method: 'eip3009',
        duration_ms: Date.now() - startMs,
        tx_hash: cached.response.transactionHash,
        cached: true,
      },
      'settle ok',
    );
    return reply.code(200).send({
      settled: cached.response.settled,
      transactionHash: cached.response.transactionHash,
      blockNumber: cached.response.blockNumber,
      amount: cached.response.amount,
      from: cached.response.from,
      to: cached.response.to,
      asset: cached.response.asset,
    });
  }
  app.log.warn(
    {
      request_id: requestId,
      error_code: cached.error.code,
      http_status: cached.error.http,
      duration_ms: Date.now() - startMs,
      cached: true,
    },
    'settle failed',
  );
  return reply.code(cached.error.http).send({ error: cached.error });
}
