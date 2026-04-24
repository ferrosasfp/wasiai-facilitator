/**
 * POST /verify — x402 HTTP API entry point (WFAC-20).
 *
 * Layers (top-down):
 *   1. Zod shape validation → INVALID_PAYLOAD 400 (DT-7 local literal).
 *   2. Idempotency cache lookup (CD-9 via isRedisAvailable helper).
 *   3. Core orchestrator dispatch (src/core/verify.ts).
 *   4. Cache successful/non-5xx response (CD-12 via toCacheable).
 *   5. Map Result<VerifyResult> → HTTP (CD-2 spec-literal on 200,
 *      CD-5 on errors).
 *
 * Logging (DT-Log): 4 line templates. NO PII — CD-3 applies to every
 * line (no `parsed.payload.*` fields ever appear in logs).
 *
 * Boundary (OWNERS / CD-1, CD-9, CD-10):
 *   - MAY import: fastify, ../core/schemas.js, ../core/verify.js,
 *                 ../core/idempotency.js.
 *   - MUST NOT import: src/chains/* (any), src/methods/* (any),
 *                      src/infra/* (any — Redis access goes via
 *                      isRedisAvailable() helper), viem, ioredis,
 *                      node:crypto.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { VerifyRequestSchema, type VerifyRequest } from '../core/schemas.js';
import { verifyCore } from '../core/verify.js';
import {
  buildIdempotencyKey,
  getCachedVerifyResponse,
  setCachedVerifyResponse,
  isRedisAvailable,
  toCacheable,
  type CachedVerifyResponse,
} from '../core/idempotency.js';

/** Route-local union: X402ErrorCode + 'INVALID_PAYLOAD' literal (DT-7). */
type VerifyRouteErrorCode =
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
    readonly code: VerifyRouteErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

/** Max length of the Zod issue message we surface to clients (DT-Zod cap). */
const ZOD_MESSAGE_MAX_LEN = 200;

export const verifyRoute: FastifyPluginAsync = async (app) => {
  // WFAC-40 — per-route rate-limit config (DT-6 + DT-13 SDD). Values come
  // from env via FastifyInstance augmentation declared in src/app.ts.
  // When env.RATE_LIMIT_ENABLED=false, the plugin is never registered and
  // this config is silently ignored by Fastify (AC-6 + DT-14 SDD).
  const env = app.env;
  app.post(
    '/verify',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_VERIFY_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const requestId = request.id;

      // Step 1 — Zod validation.
      const parseResult = VerifyRequestSchema.safeParse(request.body);
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
          'verify failed',
        );
        // WFAC-33 (CD-11): populate auditMeta.errorCode before reply.send.
        request.auditMeta = { ...request.auditMeta, errorCode: 'INVALID_PAYLOAD' };
        return reply.code(400).send(body);
      }
      const parsed: VerifyRequest = parseResult.data;

      // Step 2 — idempotency lookup.
      const idempotencyKey = buildIdempotencyKey(parsed);
      const redisUp = isRedisAvailable();
      if (redisUp) {
        const cached = await getCachedVerifyResponse(idempotencyKey);
        if (cached) {
          return sendCached(reply, cached, {
            requestId,
            startMs,
            network: parsed.accepted.network,
            app,
          });
        }
      } else {
        // AC-10 graceful degradation log — L2.
        app.log.warn({ request_id: requestId }, 'idempotency cache miss — Redis unavailable');
      }

      // Step 3 — dispatch to core.
      let result;
      try {
        result = await verifyCore(parsed);
      } catch (err: unknown) {
        // L4 — adapter threw (defense-in-depth; core contract forbids
        // foreseeable throws).
        app.log.error(
          {
            request_id: requestId,
            error_code: 'TRANSACTION_FAILED',
            http_status: 500,
            err_type: (err as Error)?.name ?? 'UnknownError',
            duration_ms: Date.now() - startMs,
          },
          'verify adapter threw',
        );
        const body: ErrorBody = {
          error: {
            code: 'TRANSACTION_FAILED',
            message: 'Internal adapter error',
            http: 500,
          },
        };
        // WFAC-33 (CD-11): populate auditMeta.errorCode before reply.send.
        request.auditMeta = { ...request.auditMeta, errorCode: 'TRANSACTION_FAILED' };
        return reply.code(500).send(body);
      }

      // Step 4 — cache (CD-12 is enforced inside toCacheable).
      if (redisUp) {
        const cacheable = toCacheable(result);
        if (cacheable) {
          await setCachedVerifyResponse(idempotencyKey, cacheable);
        }
      }

      // Step 5 — map Result<VerifyResult> → HTTP.
      if (!result.ok) {
        // L3 — warn.
        app.log.warn(
          {
            request_id: requestId,
            error_code: result.error.code,
            http_status: result.error.http,
            duration_ms: Date.now() - startMs,
          },
          'verify failed',
        );
        // WFAC-33 (CD-11): propagate adapter-returned x402 error code to audit row.
        request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
        return reply.code(result.error.http).send({ error: result.error } satisfies ErrorBody);
      }

      // Success — L1 info.
      app.log.info(
        {
          request_id: requestId,
          network: parsed.accepted.network,
          method: 'eip3009',
          duration_ms: Date.now() - startMs,
        },
        'verify ok',
      );
      // CD-2: spec-literal 200 body — strip `ok` discriminant, return the
      // 7 VerifyResult fields verbatim.
      return reply.code(200).send({
        verified: result.verified,
        client: result.client,
        amount: result.amount,
        asset: result.asset,
        network: result.network,
        payTo: result.payTo,
        expiresAt: result.expiresAt,
      });
    },
  );
};

// ─── helpers (not exported) ─────────────────────────────────────────────────

interface CachedSendCtx {
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

function sendCached(
  reply: FastifyReply,
  cached: CachedVerifyResponse,
  ctx: CachedSendCtx,
): FastifyReply {
  const { requestId, startMs, network, app } = ctx;
  if (cached.ok) {
    app.log.info(
      {
        request_id: requestId,
        network,
        method: 'eip3009',
        duration_ms: Date.now() - startMs,
        cached: true,
      },
      'verify ok',
    );
    return reply.code(200).send(cached.response);
  }
  app.log.warn(
    {
      request_id: requestId,
      error_code: cached.error.code,
      http_status: cached.error.http,
      duration_ms: Date.now() - startMs,
      cached: true,
    },
    'verify failed',
  );
  return reply.code(cached.error.http).send({ error: cached.error });
}
