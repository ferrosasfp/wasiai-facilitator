/**
 * Global anti-abuse cap helpers (public-sharing hardening).
 *
 * Two independent mechanisms:
 *   1. Per-request amount cap (pure, synchronous) — compared against the
 *      authorized amount in the x402 body.
 *   2. Per-caller daily settle counter in Redis — a hard daily ceiling scoped
 *      to the calling API key (WFAC-AUDIT M3). The counter is partitioned by a
 *      NON-SECRET, stable id of the caller key so one tenant that exhausts its
 *      own daily cap can NEVER deny settlement capacity to other tenants
 *      (cross-tenant DoS). When no caller id is available (auth-bypass/test),
 *      it falls back to a single shared daily key (legacy behavior).
 *
 * Fail behavior differs by mechanism:
 *   - Amount cap (#1) is fail-CLOSED: if BigInt parsing throws (or the amount
 *     is non-positive), the request is rejected (`{ ok: false }`). An
 *     imparseable cap/amount is a misconfig, so blocking is the safe default.
 *   - Daily cap (#2) is fail-open by default: if Redis is unavailable, the
 *     request is allowed through (like WFAC-5/WFAC-40 fail-open pattern), so
 *     the abuse surface grows only when infra is already compromised. The
 *     caller MAY opt into fail-closed via `failMode: 'closed'` (WFAC-53 FIX-6).
 *
 * Boundaries (OWNERS.md):
 *   - MAY import: `pino` (type-only), `../infra/redis.js` (runtime).
 *   - MUST NOT import: `@supabase/supabase-js`, `src/chains/*`, `src/methods/*`,
 *                      `src/routes/*`.
 */

import type { Logger } from 'pino';
import { getRedisClient } from '../infra/redis.js';

const DAILY_CAP_KEY_PREFIX = 'settle:daily:';
// 48-hour TTL so yesterday's key naturally expires and the UTC day boundary
// transition never leaves a stale counter live.
const DAILY_CAP_TTL_SECONDS = 48 * 3600;

export type AmountCapResult = { ok: true } | { ok: false; limit: bigint };

export type DailyCapResult =
  | { ok: true; count: number; cap: number }
  | {
      ok: false;
      reason: 'cap_exceeded';
      count: number;
      cap: number;
      retryAfterSeconds: number;
    }
  // WFAC-53 FIX-6 — fail-closed path: route surfaces HTTP 503 SERVICE_UNAVAILABLE.
  | { ok: false; reason: 'redis_error_failclosed' };

/**
 * Synchronous amount check. Rejects if `amountAtomic` > `capAtomic`.
 * Both inputs are uint256 decimal strings (canonical, no leading zero).
 * Returns `{ ok: false, limit }` with the numeric cap for the caller's error body.
 */
export function checkSettleAmountCap(amountAtomic: string, capAtomic: string): AmountCapResult {
  try {
    const amount = BigInt(amountAtomic);
    const cap = BigInt(capAtomic);
    if (amount <= 0n) return { ok: false, limit: 0n }; // NUEVO (T21)
    if (amount > cap) {
      return { ok: false, limit: cap };
    }
    return { ok: true };
  } catch {
    // fail-closed — un cap (o amount) imparseable/no-positivo es misconfig; bloquear es el default seguro.
    return { ok: false, limit: 0n };
  }
}

/**
 * Atomic INCR on today's daily counter. On first bump, sets TTL = 48h.
 * Returns the post-increment count + the configured cap.
 *
 * The counter is PARTITIONED PER CALLER (WFAC-AUDIT M3): the Redis key is
 * `settle:daily:<YYYY-MM-DD>:<keyId>` when `keyId` is provided, so each API key
 * gets an independent daily budget and a single tenant can never exhaust the
 * capacity of others. When `keyId` is undefined (auth-bypass in test / no key
 * configured), it falls back to the shared `settle:daily:<YYYY-MM-DD>` key
 * (legacy behavior preserved).
 *
 * If the resulting count exceeds `cap`, returns `{ ok: false }` with a
 * `retryAfterSeconds` hint (seconds until next UTC midnight).
 *
 * If Redis is unreachable or throws, returns `{ ok: true, count: 0, cap }`
 * (fail-open). Never throws.
 *
 * @param cap — configured per-caller daily cap. If <= 0, all requests pass (disabled).
 * @param failMode — WFAC-53 FIX-6. 'open' (default, V1) → Redis throw → fail-open;
 *                   'closed' → Redis throw → return `{ ok: false, reason: 'redis_error_failclosed' }`
 *                   so the /settle route can respond HTTP 503 SERVICE_UNAVAILABLE (CD-8, CD-15).
 * @param logger — for warn-level logging on fail-open/fail-closed paths.
 * @param keyId — NON-SECRET, stable id of the calling API key (sha256 prefix from
 *                the auth middleware). Partitions the daily counter per tenant.
 *                Never the raw key. Undefined → shared legacy counter.
 */
export async function incrementAndCheckDailyCap(
  cap: number,
  failMode: 'open' | 'closed',
  logger: Pick<Logger, 'warn' | 'debug'>,
  keyId?: string,
): Promise<DailyCapResult> {
  if (cap <= 0) return { ok: true, count: 0, cap: 0 };

  const client = getRedisClient();
  if (!client) return { ok: true, count: 0, cap };

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  // Partition per caller so one tenant's flood cannot deny others (M3).
  const key =
    keyId !== undefined && keyId.length > 0
      ? `${DAILY_CAP_KEY_PREFIX}${dateKey}:${keyId}`
      : `${DAILY_CAP_KEY_PREFIX}${dateKey}`;

  try {
    const count = await client.incr(key);
    if (count === 1) {
      // best-effort TTL set; swallow error if it races
      await client.expire(key, DAILY_CAP_TTL_SECONDS).catch(() => undefined);
    }
    if (count > cap) {
      const retryAfterSeconds = secondsUntilNextUtcMidnight(now);
      return { ok: false, reason: 'cap_exceeded', count, cap, retryAfterSeconds };
    }
    return { ok: true, count, cap };
  } catch (err) {
    if (failMode === 'closed') {
      // WFAC-53 FIX-6 fail-closed — route surfaces HTTP 503 SERVICE_UNAVAILABLE.
      logger.warn({ err, cap }, 'settle daily cap check failed — fail-closed');
      return { ok: false, reason: 'redis_error_failclosed' };
    }
    // failMode === 'open' (default, CD-8 preserves V1 fail-open behavior).
    logger.warn({ err, cap }, 'settle daily cap check failed — fail-open');
    return { ok: true, count: 0, cap };
  }
}

function secondsUntilNextUtcMidnight(now: Date): number {
  const nextMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return Math.max(1, Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000));
}
