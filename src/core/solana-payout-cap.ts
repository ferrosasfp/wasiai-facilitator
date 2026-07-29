/**
 * WKH-302 — anti-abuse caps for the Solana PAYOUT route (fail-CLOSED). Mirror of
 * `src/core/solana-sponsor-cap.ts` with its OWN Redis prefixes:
 *
 *   1. `checkAndIncrPayoutRate`       — per-caller request rate-limit
 *      (`solana:payout:rate:<keyId>:<window>`).
 *   2. `checkAndIncrPayoutDailyAtomic` — aggregate daily ceiling in ATOMIC token
 *      units (`solana:payout:daily:<keyId>:<UTCdate>`, TTL 48h) — the main control
 *      protecting the payout treasury.
 *   3. `releasePayoutDailyAtomic`     — compensating decrement when a reservation
 *      never produced an on-chain spend.
 *
 * ⚠️ SEPARATE BUCKETS FROM THE SPONSOR ON PURPOSE: the sponsor's budget is measured
 * in LAMPORTS OF FEE, this one in ATOMIC UNITS OF USDC PRINCIPAL. Sharing a bucket
 * would mix two different budgets in one counter.
 *
 * Why these caps are mandatory and not nice-to-have: on EVM the facilitator only
 * pays GAS — the principal moves under a client-signed EIP-3009 authorization. Here
 * the principal leaves the facilitator's OWN ATA, so the drain surface is new and
 * larger. `payTo` is deliberately NOT allow-listed (agents are discovered
 * dynamically); the equivalent control is this daily ceiling plus the wallet balance.
 *
 * FAIL-CLOSED: a null Redis client OR any Redis error → `{ ok:false }` → the route
 * rejects. This is the OPPOSITE of `src/core/settle-cap.ts`, which is fail-OPEN on
 * purpose for the EVM path (a Redis blip must not stop all settlements). Do NOT
 * copy that criterion here: fail-open on a treasury route means paying while
 * unable to count.
 *
 * Boundaries (mirrors solana-sponsor-cap.ts): MAY import `pino` (type-only),
 * `../infra/redis.js` (runtime). MUST NOT import `@supabase/supabase-js`,
 * `src/chains/*`, `src/methods/*`, `src/routes/*`.
 */

import type { Logger } from 'pino';
import { getRedisClient } from '../infra/redis.js';

const RATE_KEY_PREFIX = 'solana:payout:rate:';
const DAILY_KEY_PREFIX = 'solana:payout:daily:';
// 48h TTL so yesterday's daily key expires naturally across the UTC boundary.
const DAILY_TTL_SECONDS = 48 * 3600;

export type PayoutCapResult = { ok: true } | { ok: false; reason: string };

type CapLogger = Pick<Logger, 'warn' | 'debug'>;

/**
 * Per-caller fixed-window rate-limit. Fail-CLOSED: no client or a Redis error
 * rejects. The window bucket is `floor(now / windowSec)` so the key rolls over on
 * its own; the TTL is set on the first increment.
 *
 * @param keyId NON-SECRET caller id (sha256 prefix from auth). Falls back to a
 *              shared bucket when absent.
 */
export async function checkAndIncrPayoutRate(
  max: number,
  windowSec: number,
  logger: CapLogger,
  keyId?: string,
): Promise<PayoutCapResult> {
  const client = getRedisClient();
  if (!client) {
    logger.warn({ scope: 'payout-rate' }, 'payout rate store unavailable — fail-closed');
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
      return { ok: false, reason: 'rate_exceeded' };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err, scope: 'payout-rate' }, 'payout rate check failed — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
}

/**
 * Aggregate daily ATOMIC-unit counter. INCRBY today's counter by `amountAtomic`; if
 * the running total exceeds `dailyMaxAtomic`, reject. Fail-CLOSED: null client or
 * Redis error rejects. `dailyMaxAtomic <= 0` disables the ceiling.
 *
 * On success this RESERVES the amount: the check happens BEFORE any signing, so the
 * facilitator never over-spends, and `releasePayoutDailyAtomic` gives the
 * reservation back for terminal outcomes that prove no spend occurred.
 *
 * Precision (CD-10, WKH-196 lesson): the increment travels as a decimal STRING and
 * the running total is compared as BigInt. Never `Number()`.
 */
export async function checkAndIncrPayoutDailyAtomic(
  amountAtomic: bigint,
  dailyMaxAtomic: bigint,
  logger: CapLogger,
  keyId?: string,
): Promise<PayoutCapResult> {
  if (dailyMaxAtomic <= 0n) return { ok: true }; // disabled
  const client = getRedisClient();
  if (!client) {
    logger.warn({ scope: 'payout-daily' }, 'payout daily store unavailable — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
  const partition = keyId !== undefined && keyId.length > 0 ? keyId : 'shared';
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_KEY_PREFIX}${partition}:${dateKey}`;
  const increment = amountAtomic > 0n ? amountAtomic.toString() : '0';
  try {
    const totalRaw = await client.incrby(key, increment);
    // Set/refresh the 48h TTL (best-effort). Daily keys are date-scoped, so a
    // refreshed TTL never leaks a counter beyond its day.
    await client.expire(key, DAILY_TTL_SECONDS).catch(() => undefined);
    const total = BigInt(String(totalRaw));
    if (total > dailyMaxAtomic) {
      return { ok: false, reason: 'daily_exceeded' };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err, scope: 'payout-daily' }, 'payout daily check failed — fail-closed');
    return { ok: false, reason: 'store_error_failclosed' };
  }
}

/**
 * Compensating decrement for the daily counter. Called ONLY when an amount reserved
 * by `checkAndIncrPayoutDailyAtomic` never produced an on-chain spend, so a payout
 * that never landed cannot auto-exhaust the caller's daily budget. Key derivation
 * MIRRORS the reservation EXACTLY so the same counter is released.
 *
 * ⚠️ The one outcome that must NOT be released is `PAYOUT_BROADCAST_FAILED`: there
 * the tx may have landed and we could not confirm it, so the debit is kept
 * conservatively (§6.6.4).
 *
 * Best-effort and NEVER throws: it runs after the request already failed, so a
 * Redis error or a null client is swallowed (a missed release only leaves the
 * caller's OWN counter slightly high — conservative, never over-spends).
 */
export async function releasePayoutDailyAtomic(
  amountAtomic: bigint,
  dailyMaxAtomic: bigint,
  logger: CapLogger,
  keyId?: string,
): Promise<void> {
  if (dailyMaxAtomic <= 0n) return; // disabled — nothing was incremented
  if (amountAtomic <= 0n) return;
  const client = getRedisClient();
  if (!client) return; // best-effort: no store → nothing to release
  const partition = keyId !== undefined && keyId.length > 0 ? keyId : 'shared';
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${DAILY_KEY_PREFIX}${partition}:${dateKey}`;
  try {
    await client.decrby(key, amountAtomic.toString());
  } catch (err) {
    logger.warn({ err, scope: 'payout-daily' }, 'payout daily release failed — non-fatal');
  }
}
