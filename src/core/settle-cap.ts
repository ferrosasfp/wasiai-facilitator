/**
 * Global anti-abuse cap helpers (public-sharing hardening).
 *
 * Two independent mechanisms:
 *   1. Per-request amount cap (pure, synchronous) — compared against the
 *      authorized amount in the x402 body.
 *   2. Global daily settle counter in Redis — hard ceiling across ALL IPs
 *      and ALL wallets, protects operator gas budget.
 *
 * Both are fail-open: if Redis is unavailable or BigInt parsing throws,
 * the request is allowed through (like WFAC-5/WFAC-40 fail-open pattern).
 * Surface of abuse grows only when infra is already compromised.
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
  | { ok: false; count: number; cap: number; retryAfterSeconds: number };

/**
 * Synchronous amount check. Rejects if `amountAtomic` > `capAtomic`.
 * Both inputs are uint256 decimal strings (canonical, no leading zero).
 * Returns `{ ok: false, limit }` with the numeric cap for the caller's error body.
 */
export function checkSettleAmountCap(amountAtomic: string, capAtomic: string): AmountCapResult {
  try {
    const amount = BigInt(amountAtomic);
    const cap = BigInt(capAtomic);
    if (amount > cap) {
      return { ok: false, limit: cap };
    }
    return { ok: true };
  } catch {
    // BigInt parse failure → fail-open (Zod earlier validated format; this is
    // defense-in-depth only).
    return { ok: true };
  }
}

/**
 * Atomic INCR on today's daily counter. On first bump, sets TTL = 48h.
 * Returns the post-increment count + the configured cap.
 *
 * If the resulting count exceeds `cap`, returns `{ ok: false }` with a
 * `retryAfterSeconds` hint (seconds until next UTC midnight).
 *
 * If Redis is unreachable or throws, returns `{ ok: true, count: 0, cap }`
 * (fail-open). Never throws.
 *
 * @param cap — configured global daily cap. If <= 0, all requests pass (disabled).
 * @param logger — for warn-level logging on fail-open paths.
 */
export async function incrementAndCheckDailyCap(
  cap: number,
  logger: Pick<Logger, 'warn' | 'debug'>,
): Promise<DailyCapResult> {
  if (cap <= 0) return { ok: true, count: 0, cap: 0 };

  const client = getRedisClient();
  if (!client) return { ok: true, count: 0, cap };

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_CAP_KEY_PREFIX}${dateKey}`;

  try {
    const count = await client.incr(key);
    if (count === 1) {
      // best-effort TTL set; swallow error if it races
      await client.expire(key, DAILY_CAP_TTL_SECONDS).catch(() => undefined);
    }
    if (count > cap) {
      const retryAfterSeconds = secondsUntilNextUtcMidnight(now);
      return { ok: false, count, cap, retryAfterSeconds };
    }
    return { ok: true, count, cap };
  } catch (err) {
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
