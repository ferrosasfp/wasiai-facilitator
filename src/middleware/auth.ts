/**
 * Caller authentication preHandler (WFAC-AUDIT AC-1).
 *
 * Guards `/settle` and `/verify` with a bearer caller key.
 *
 * KEY VERSIONING / ROTATION (AUDIT, additive):
 *   The set of valid keys is `FACILITATOR_API_KEY` (single, legacy — keeps
 *   working unchanged) PLUS every entry in `FACILITATOR_API_KEYS` (optional
 *   comma-separated list). A request is authenticated if its bearer matches
 *   ANY configured key under a timing-safe comparison. This enables
 *   zero-downtime rotation: publish the new key in FACILITATOR_API_KEYS,
 *   deploy, migrate callers, then drop the old one. The single-key,
 *   FACILITATOR_API_KEYS-unset operation is preserved exactly.
 *
 * PER-KEY RATE LIMITING (AUDIT, additive): on a successful match we stamp
 * `request.facilitatorKeyId` with a NON-SECRET, stable identifier derived from
 * the matched key (sha256, truncated). The rate-limit keyGenerator in app.ts
 * folds this into the bucket so one caller's key cannot exhaust another's
 * per-IP budget (and a shared NAT'd IP doesn't punish every key). The raw key
 * is NEVER used as a Redis key and NEVER logged.
 *
 * SECURITY (CD-NEW-AUTH-NOLOG): this module NEVER logs the API key — not the
 * provided value, not the configured value, not the `authorization` header,
 * not on the error path. There is intentionally NO logger here.
 *
 * Boundary (OWNERS): `src/middleware/` MAY import `node:crypto` + `fastify`
 * types only. MUST NOT import `src/core/*`, `src/methods/*`, `src/chains/*`,
 * nor `src/infra/env.ts` at runtime. Keys are read SOLELY via
 * `request.server.env` (the decorator declared in `app.ts`).
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Non-secret, stable identifier for the matched caller key (sha256 prefix).
     * Set by `requireFacilitatorKey` on successful auth; consumed by the
     * rate-limit keyGenerator for per-key bucketing. Undefined when auth is
     * bypassed (no key configured) or the request was rejected.
     */
    facilitatorKeyId?: string;
  }
}

/**
 * Resolve the full set of valid caller keys from env: the single
 * FACILITATOR_API_KEY plus the comma-separated FACILITATOR_API_KEYS list.
 * Trimmed + empty-filtered + de-duplicated. Pure; never logs.
 */
export function resolveConfiguredKeys(
  single: string | undefined,
  csv: string | undefined,
): readonly string[] {
  const keys = new Set<string>();
  if (single !== undefined && single.length > 0) keys.add(single);
  if (csv !== undefined) {
    for (const k of csv.split(',')) {
      const trimmed = k.trim();
      if (trimmed.length > 0) keys.add(trimmed);
    }
  }
  return [...keys];
}

/**
 * Non-secret, stable per-key identifier for rate-limit bucketing. sha256 of
 * the key, truncated to 16 hex chars. One-way: cannot be reversed to the key,
 * safe to use as a Redis key fragment. NEVER the raw key.
 */
function keyId(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

/**
 * Timing-safe equality that does not early-exit on a length mismatch in a way
 * that leaks WHICH candidate matched. `timingSafeEqual` throws when buffer
 * lengths differ; the length itself is not secret, so a length mismatch is a
 * direct non-match.
 */
function timingSafeMatch(provided: string, candidate: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function requireFacilitatorKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const configured = resolveConfiguredKeys(
    request.server.env.FACILITATOR_API_KEY,
    request.server.env.FACILITATOR_API_KEYS,
  );

  // DT-7 bypass: only reachable when NODE_ENV==='test' (superRefine guarantees
  // FACILITATOR_API_KEY presence in prod). No key configured → no auth.
  if (configured.length === 0) return;

  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return unauthorized(reply);
  }
  const provided = header.slice('Bearer '.length);

  // Compare against EVERY configured key with a timing-safe comparison. We do
  // NOT short-circuit on first match: iterate the whole list so total work is
  // (length-mismatch fast paths aside) independent of which key matched.
  let matched: string | undefined;
  for (const candidate of configured) {
    if (timingSafeMatch(provided, candidate)) {
      matched = candidate;
    }
  }
  if (matched === undefined) {
    return unauthorized(reply);
  }

  // Per-key rate-limit bucket: stamp a NON-SECRET id of the matched key.
  request.facilitatorKeyId = keyId(matched);
  // match → return (pipeline continues).
}

function unauthorized(reply: FastifyReply): void {
  reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', http: 401 },
  });
}

/**
 * N10 (audit hardening) — token gate for GET /metrics.
 *
 * The Prometheus scrape target exposes operational state (per-chain circuit
 * breaker gauges/counters). On Railway the endpoint is a PUBLIC URL, so it is
 * gated by a shared secret (`METRICS_TOKEN`). Fail-CLOSED in production:
 *
 *   - METRICS_TOKEN set   → require the token, sent as `x-metrics-token: <v>`
 *                           or `Authorization: Bearer <v>` (same bearer scheme
 *                           as caller-auth). Timing-safe compared. 401 on
 *                           mismatch/absence.
 *   - METRICS_TOKEN unset:
 *       - production       → 503 (fail-closed: never expose metrics
 *                            unconfigured in prod).
 *       - dev/test         → passthrough (local scrape / tests keep working).
 *
 * SECURITY (CD-NEW-AUTH-NOLOG): NEVER logs the token — reuses the same
 * timing-safe comparison as the caller-auth path. Read SOLELY via
 * `request.server.env` (no direct env import — OWNERS boundary).
 */
export async function requireMetricsToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.server.env.METRICS_TOKEN;

  // Unconfigured: fail-CLOSED in production, passthrough in dev/test.
  if (token === undefined || token.length === 0) {
    if (request.server.env.NODE_ENV === 'production') {
      reply.code(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Metrics endpoint is not configured',
          http: 503,
        },
      });
    }
    return;
  }

  const provided = extractMetricsToken(request);
  if (provided === undefined || !timingSafeMatch(provided, token)) {
    reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing metrics token', http: 401 },
    });
  }
}

/**
 * Extract the metrics token from the dedicated `x-metrics-token` header or a
 * standard `Authorization: Bearer <token>` header (consistent with the
 * caller-auth bearer scheme). Returns undefined when neither is present.
 */
function extractMetricsToken(request: FastifyRequest): string | undefined {
  const dedicated = request.headers['x-metrics-token'];
  if (typeof dedicated === 'string' && dedicated.length > 0) return dedicated;
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const t = header.slice('Bearer '.length);
    if (t.length > 0) return t;
  }
  return undefined;
}
