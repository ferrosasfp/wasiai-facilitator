/**
 * Caller authentication preHandler (WFAC-AUDIT AC-1).
 *
 * Guards `/settle` and `/verify` with a bearer `FACILITATOR_API_KEY`.
 * Applied per-route (NOT a global hook) so public endpoints (`/health`,
 * `/supported`, `/openapi.json`, `/metrics`) stay open.
 *
 * SECURITY (CD-NEW-AUTH-NOLOG): this module NEVER logs the API key — not the
 * provided value, not the configured value, not the `authorization` header,
 * not on the error path. There is intentionally NO logger here.
 *
 * Boundary (OWNERS): `src/middleware/` MAY import `node:crypto` + `fastify`
 * types only. MUST NOT import `src/core/*`, `src/methods/*`, `src/chains/*`,
 * nor `src/infra/env.ts` at runtime. The key is read SOLELY via
 * `request.server.env` (the decorator declared in `app.ts`).
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireFacilitatorKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const configured = request.server.env.FACILITATOR_API_KEY;

  // DT-7 bypass: only possible when NODE_ENV==='test' (superRefine guarantees
  // presence in prod). No key configured → no auth.
  if (configured === undefined) return;

  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return unauthorized(reply);
  }
  const provided = header.slice('Bearer '.length);

  // R-3: timingSafeEqual throws when buffer lengths differ. The length is not
  // secret → if they differ, 401 directly (without comparing bytes).
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return unauthorized(reply);
  }
  // match → return (pipeline continues).
}

function unauthorized(reply: FastifyReply): void {
  reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', http: 401 },
  });
}
