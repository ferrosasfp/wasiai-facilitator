/**
 * Proxy-aware client IP extraction — pure helper (WFAC-40).
 *
 * Used by:
 *   - `src/app.ts` audit hook (WFAC-33 — refactored from inline block).
 *   - `src/app.ts` rate-limit plugin keyGenerator (WFAC-40).
 *
 * Precedence (SDD §3.1 DT-8):
 *   1. First element of `X-Forwarded-For` header when present and non-empty
 *      (left-trimmed, comma-split). Handles both string and string[] cases
 *      (Fastify v5 normalizes but defense-in-depth keeps both branches).
 *   2. `request.ip` (Fastify default; respects `trustProxy` config).
 *   3. `null` if neither yields a non-empty string.
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
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0];
    const trimmed = first ? first.trim() : '';
    if (trimmed.length > 0) return trimmed;
  } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
    const first = xff[0].split(',')[0];
    const trimmed = first ? first.trim() : '';
    if (trimmed.length > 0) return trimmed;
  }
  if (typeof request.ip === 'string' && request.ip.length > 0) return request.ip;
  return null;
}
