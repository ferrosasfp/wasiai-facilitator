/**
 * WKH-217 / HU-SOL-14 — anti-abuse caps for the Solana sponsorship route
 * (AC-6, fail-CLOSED). Two Redis-backed mechanisms, both fail-CLOSED — the
 * OPPOSITE of `src/core/settle-cap.ts` (which is fail-open for EVM):
 *
 *   1. `checkAndIncrSponsorRate`         — per-caller request rate-limit
 *      (`solana:sponsor:rate:<keyId>:<window>`), the first anti-abuse layer.
 *   2. `checkAndIncrSponsorDailyLamports` — aggregate daily fee ceiling in
 *      lamports (`solana:sponsor:daily:<keyId>:<UTCdate>`, TTL 48h), the main
 *      mechanism protecting the fee-payer wallet.
 *
 * FAIL-CLOSED (CD-6): a null Redis client OR any Redis error → `{ ok:false,
 * reason:'store_error_failclosed' }` → the route rejects (never fail-open). The
 * fee-payer never signs when the anti-abuse store is unavailable. Devnet + low
 * volume + opt-in make this safe (unlike the EVM settle path).
 *
 * Boundaries (OWNERS.md, mirrors settle-cap.ts): MAY import `pino` (type-only),
 * `../infra/redis.js` (runtime). MUST NOT import `@supabase/supabase-js`,
 * `src/chains/*`, `src/methods/*`, `src/routes/*`.
 */

import type { Logger } from 'pino';
import { getRedisClient } from '../infra/redis.js';

const RATE_KEY_PREFIX = 'solana:sponsor:rate:';
const DAILY_KEY_PREFIX = 'solana:sponsor:daily:';
// 48h TTL so yesterday's daily key expires naturally across the UTC boundary.
const DAILY_TTL_SECONDS = 48 * 3600;

export type SponsorCapResult =
  | { ok: true }
  | { ok: false; reason: 'rate_exceeded' | 'daily_exceeded'; retryAfterSeconds: number }
  // fail-closed path (no store / Redis error) → route surfaces 429.
  | { ok: false; reason: 'store_error_failclosed' };

type CapLogger = Pick<Logger, 'warn' | 'debug'>;

/**
 * Per-caller fixed-window rate-limit. Fail-CLOSED: no client or a Redis error
 * rejects. The window bucket is `floor(now / windowSec)` so the key rolls over
 * automatically; TTL is set on first increment.
 *
 * @param keyId NON-SECRET caller id (sha256 prefix from auth). Falls back to a
 *              shared bucket when absent.
 */
export async function checkAndIncrSponsorRate(
  max: number,
  windowSec: number,
  logger: CapLogger,
  keyId?: string,
): Promise<SponsorCapResult> {
  const client = getRedisClient();
  if (!client) {
    logger.warn({ scope: 'sponsor-rate' }, 'sponsor rate store unavailable — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
  const partition = keyId !== undefined && keyId.length > 0 ? keyId : 'shared';
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `${RATE_KEY_PREFIX}${partition}:${bucket}`;
  try {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, windowSec).catch(() => undefined);
    }
    if (count > max) {
      return { ok: false, reason: 'rate_exceeded', retryAfterSeconds: windowSec };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err, scope: 'sponsor-rate' }, 'sponsor rate check failed — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
}

/**
 * Aggregate daily lamports counter. INCRBY today's counter by `feeLamports`; if
 * the running total exceeds `capLamports`, reject. Fail-CLOSED: null client or
 * Redis error rejects. `cap <= 0` disables the ceiling (returns ok).
 *
 * Precision: the increment is passed as a decimal STRING (WKH-196 lesson) and
 * the total is compared as BigInt. Lamport magnitudes here (<= 0.5 SOL/day) stay
 * far below 2^53, but the BigInt comparison is precise regardless.
 */
export async function checkAndIncrSponsorDailyLamports(
  feeLamports: bigint,
  capLamports: bigint,
  logger: CapLogger,
  keyId?: string,
): Promise<SponsorCapResult> {
  if (capLamports <= 0n) return { ok: true }; // disabled
  const client = getRedisClient();
  if (!client) {
    logger.warn({ scope: 'sponsor-daily' }, 'sponsor daily store unavailable — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
  const partition = keyId !== undefined && keyId.length > 0 ? keyId : 'shared';
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_KEY_PREFIX}${partition}:${dateKey}`;
  const increment = feeLamports > 0n ? feeLamports.toString() : '0';
  try {
    const totalRaw = await client.incrby(key, increment);
    // Set/refresh the 48h TTL (best-effort). Daily keys are date-scoped, so a
    // refreshed TTL never leaks a counter beyond its day.
    await client.expire(key, DAILY_TTL_SECONDS).catch(() => undefined);
    const total = BigInt(String(totalRaw));
    if (total > capLamports) {
      return {
        ok: false,
        reason: 'daily_exceeded',
        retryAfterSeconds: secondsUntilNextUtcMidnight(),
      };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err, scope: 'sponsor-daily' }, 'sponsor daily check failed — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
}

/**
 * AR-MNR-1 compensating decrement for the daily lamports counter. Called ONLY
 * when a fee previously reserved by `checkAndIncrSponsorDailyLamports` never
 * produced an on-chain spend (stale/expired blockhash, pre-broadcast reject), so
 * a failed tx cannot inflate the caller's daily counter. Key derivation MIRRORS
 * `checkAndIncrSponsorDailyLamports` EXACTLY so the same counter is released.
 *
 * Best-effort: this runs after the request already failed, so a Redis error or a
 * null client is swallowed (a missed release only leaves the caller's OWN daily
 * counter slightly high — conservative, never over-spends). `cap <= 0` (ceiling
 * disabled) or a non-positive fee means nothing was ever reserved → no-op.
 */
export async function releaseSponsorDailyLamports(
  feeLamports: bigint,
  capLamports: bigint,
  logger: CapLogger,
  keyId?: string,
): Promise<void> {
  if (capLamports <= 0n) return; // disabled — nothing was incremented
  if (feeLamports <= 0n) return;
  const client = getRedisClient();
  if (!client) return; // best-effort: no store → nothing to release
  const partition = keyId !== undefined && keyId.length > 0 ? keyId : 'shared';
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_KEY_PREFIX}${partition}:${dateKey}`;
  try {
    await client.decrby(key, feeLamports.toString());
  } catch (err) {
    logger.warn({ err, scope: 'sponsor-daily' }, 'sponsor daily release failed — non-fatal');
  }
}

function secondsUntilNextUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}
