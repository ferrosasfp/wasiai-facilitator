/**
 * Proxy-aware client IP extraction — pure helper (WFAC-40).
 *
 * Used by:
 *   - `src/app.ts` audit hook (WFAC-33 — refactored from inline block).
 *   - `src/app.ts` rate-limit plugin keyGenerator (WFAC-40).
 *
 * Precedence (WFAC-AUDIT AC-2 — single source):
 *   1. `request.ip` — resolved by Fastify from the correct `X-Forwarded-For`
 *      hop under `trustProxy`. This is the ONLY source.
 *   2. `null` if `request.ip` is not a non-empty string.
 *
 * The previous behavior (parsing the raw first XFF element BEFORE request.ip)
 * was the rate-limit bypass vector: an attacker rotating `X-Forwarded-For`
 * could dodge the per-IP bucket. We now trust Fastify's resolved `request.ip`
 * exclusively.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import: `fastify` (type-only).
 *   - MUST NOT import: ANY runtime module (this helper must stay pure).
 *
 * Contracts:
 *   - Pure — no logging, no throw, no I/O (WFAC-40 CD-9).
 *   - Same input ⇒ same output. Always returns `string | null`.
 */

import type { FastifyRequest } from 'fastify';

export function extractClientIp(request: FastifyRequest): string | null {
  // WFAC-AUDIT — under trustProxy, Fastify already resolves request.ip from the
  // correct XFF hop. Parsing the raw first XFF element here WAS the spoofing
  // vector (an attacker rotates X-Forwarded-For to dodge the rate-limit bucket).
  // We now trust Fastify's resolved request.ip exclusively.
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}
