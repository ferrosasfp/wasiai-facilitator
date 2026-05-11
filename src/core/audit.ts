/**
 * HTTP audit log — core persistence helpers (WFAC-33).
 *
 * Responsibilities:
 *   1. Augment FastifyRequest with an optional `auditMeta` decorator so route
 *      handlers can pass error_code / idempotency_key to the onResponse hook.
 *   2. Build an AuditEntry from request/reply transport data + auditMeta.
 *   3. Persist that entry into Supabase via fire-and-forget INSERT.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import from `src/infra/*` (runtime) and `pino` / `fastify` / `./types.js`
 *     (type-only).
 *   - MUST NOT import from `src/chains/*`, `src/methods/*`, `src/routes/*` (CD-9).
 *   - MUST NOT import `@supabase/supabase-js` directly — access is only through
 *     `getSupabaseClient()` (CD-3).
 *
 * Contracts:
 *   - `persistAuditEntry` NEVER throws at the caller (CD-1). All error paths
 *     captured + logged at `warn` via the injected logger.
 *   - `buildAuditEntry` is a pure function — same input ⇒ same output, no side
 *     effects (CD-7). Truncation (ip→45, user_agent→512) happens here (CD-8).
 *   - The AuditEntry interface has NO `timestamp` field — Postgres DEFAULT NOW()
 *     generates it server-side (CD-13).
 *   - No `console.*` usage (CD-5).
 *   - No PII (ip, user_agent) in application logs — only in DB rows (CD-4).
 */

import type { Logger } from 'pino';
import type { X402ErrorCode } from './types.js';
import { getSupabaseClient } from '../infra/supabase.js';

// ─── Fastify type augmentation (DT-9) ──────────────────────────────────────
// Side-effect import of 'fastify' makes the module augmentation type-correct
// without pulling any runtime binding into this file.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Optional audit metadata populated by route handlers BEFORE reply.send()
     * and read by the `onResponse` hook registered in `src/app.ts`.
     * `undefined` by default — the hook tolerates absence (WFAC-33 DT-9).
     */
    auditMeta?: AuditMeta;
  }
}

export interface AuditMeta {
  // Route-local literals allowed besides X402ErrorCode:
  //   - 'INVALID_PAYLOAD'     (Zod validation failures, WFAC-20 DT-7)
  //   - 'RATE_LIMITED'        (per-IP or global daily cap hits, WFAC-40 + anti-abuse)
  //   - 'SERVICE_UNAVAILABLE' (WFAC-53 FIX-6 DT-O — settle-cap Redis throw in
  //                            fail-closed mode; observability of the new path)
  readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE';
  readonly idempotencyKey?: string;
}

/**
 * Minimal logger surface used by this module. Mirrors the `Pick<Logger, ...>`
 * pattern from `src/core/ledger.ts`.
 */
export type AuditLogger = Pick<Logger, 'warn' | 'debug'>;

/**
 * Row shape persisted into `facilitator_audit_log` (see
 * `supabase/migrations/002_facilitator_audit_log.sql`).
 *
 * NOTE: NO `timestamp` field — DB generates via DEFAULT NOW() (CD-13).
 */
export interface AuditEntry {
  readonly request_id: string;
  readonly method: string;
  readonly path: string;
  readonly status_code: number;
  readonly duration_ms: number;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly error_code: string | null;
  readonly idempotency_key: string | null;
}

/**
 * Structural input for `buildAuditEntry`. The caller (onResponse hook in
 * `src/app.ts`) extracts transport data from the Fastify request + reply and
 * passes optional meta from `request.auditMeta`.
 */
export interface BuildAuditEntryInput {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly ipRaw: string | null; // pre-truncation (CD-8)
  readonly userAgentRaw: string | null; // pre-truncation (CD-8)
  readonly errorCode?: string;
  readonly idempotencyKey?: string;
}

/** Max widths — must match VARCHAR(N) in DDL (CD-8). */
const IP_MAX_LEN = 45;
const USER_AGENT_MAX_LEN = 512;

/**
 * Pure function. Maps transport + meta into an `AuditEntry` ready for
 * persistence. Truncation happens here (CD-8). No side effects (CD-7).
 *
 * CD-13: 9 output fields listed by name — no spread, no `timestamp`.
 */
export function buildAuditEntry(input: BuildAuditEntryInput): AuditEntry {
  const ip = truncateOrNull(input.ipRaw, IP_MAX_LEN);
  const user_agent = truncateOrNull(input.userAgentRaw, USER_AGENT_MAX_LEN);
  return {
    request_id: input.requestId,
    method: input.method,
    path: input.path,
    status_code: input.statusCode,
    duration_ms: input.durationMs,
    ip,
    user_agent,
    error_code: input.errorCode ?? null,
    idempotency_key: input.idempotencyKey ?? null,
  };
}

/**
 * Normalize raw string → truncated-or-null. Local helper (not exported).
 * Empty string is coerced to `null` so Postgres stores NULL rather than ''.
 */
function truncateOrNull(raw: string | null, max: number): string | null {
  if (raw === null || raw.length === 0) return null;
  return raw.length > max ? raw.slice(0, max) : raw;
}

/**
 * Persist an audit entry. Fire-and-forget: the awaited promise ALWAYS
 * resolves — errors are swallowed + logged (CD-1).
 *
 * No-ops when `getSupabaseClient()` returns `null`.
 *
 * Plain INSERT with NO `onConflict` — append-only semantics (CD-2 / DT-13).
 */
export async function persistAuditEntry(entry: AuditEntry, logger: AuditLogger): Promise<void> {
  try {
    // CD-1: `getSupabaseClient()` itself may throw synchronously — wrap inside
    // try/catch so even SDK bootstrap bugs cannot leak to the caller.
    const client = getSupabaseClient();
    if (!client) return;

    const { error } = await client.from('facilitator_audit_log').insert(entry);

    if (error) {
      // CD-4: do NOT include ip/user_agent in log payload (PII).
      logger.warn(
        { err: error, request_id: entry.request_id, path: entry.path },
        'audit insert failed',
      );
      return;
    }
    // Success path: silent — no logger.info (CD-4 + noise control).
  } catch (err) {
    // CD-1: capture EVERY throw from the async chain including synchronous
    // throws from `getSupabaseClient()` / `createClient()`. Never re-throw.
    logger.warn(
      { err, request_id: entry.request_id, path: entry.path },
      'audit client or insert failed',
    );
  }
}
