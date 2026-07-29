/**
 * WKH-302 — durable state machine of the SPL payout (`facilitator_solana_payouts`).
 *
 * Sibling of `src/infra/solana-escrow-release-dedup.ts`, but a STATE MACHINE rather
 * than a one-shot claim: `claimed` → `signed` → `confirmed`. `UNIQUE(caller_key_id,
 * intent_id)` is the durable at-most-once barrier; partitioning by caller stops one
 * caller from squatting another's `intentId` (`FACILITATOR_API_KEYS` is multi-key).
 *
 * > **Invariant I2 — the broadcast ALWAYS happens after the signature and the
 * > blockhash are persisted. Therefore `status='claimed'` (no signature) PROVES
 * > nothing was ever broadcast.**
 *
 * That is free to implement because a Solana tx's ed25519 signature exists BEFORE
 * it is transmitted: the route persists it inside `cosignAndBroadcast`'s `onSigned`
 * hook, which runs between `partialSign` and `serialize`.
 *
 * Invariant I1 — this barrier is SUBORDINATE: the facilitator never initiates a
 * payout, it only answers the gateway. So this table may VETO a payout or REPLAY a
 * previous signature; it can never decide to pay on its own. Composing two
 * at-most-once barriers is monotone (it can only REDUCE broadcasts), so a barrier
 * on the executor side is not split-brain.
 *
 * CD-7 — EVERY transition is ONE conditional write that reports in the same
 * operation whether it applied. Deciding a transition from a prior `SELECT` and
 * then writing is FORBIDDEN: two concurrent requests would both read the same
 * state and both proceed. Reading a row AFTER an INSERT lost the 23505 race is
 * allowed — what is banned is *deciding the transition* from that read.
 *
 * FAIL-CLOSED everywhere: a null client, a network error or a thrown exception all
 * yield `{ ok:false }` and the caller rejects with `PAYOUT_STORE_UNAVAILABLE`.
 * Never `{ ok:true }` by default — "I don't know if I already paid" must never be
 * treated as "I did not pay".
 *
 * CD-10 precision (WKH-196 lesson): `amountAtomic` travels as a decimal STRING end
 * to end and is compared as `BigInt`. No `Number()`, no `parseFloat`, no `uiAmount`.
 *
 * No PII in logs: `caller_key_id` (already a truncated sha256), `intent_id`,
 * `network`, `status`. Never the body, never the key, never the tx.
 *
 * Boundary (mirrors solana-escrow-release-dedup.ts): MAY import
 * `src/infra/supabase.ts` (runtime, only `getSupabaseClient`) + `pino` (type-only).
 * MUST NOT import `@supabase/supabase-js`, `src/chains/*`, `src/core/*`,
 * `src/methods/*`, `src/routes/*`.
 */

import type { Logger } from 'pino';
import { getSupabaseClient } from './supabase.js';

const TABLE = 'facilitator_solana_payouts';

/** Postgres unique_violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

/** Minimal logger surface (no PII — only ids, network and status). */
export type PayoutLedgerLogger = Pick<Logger, 'warn' | 'debug'>;

/** Lifecycle of a payout row. `claimed` (no signature) ⇒ never broadcast (I2). */
export type PayoutStatus = 'claimed' | 'signed' | 'confirmed';

/** Identity + terms of a payout intent. The tuple the caller is bound to (AC-9). */
export interface PayoutIntent {
  readonly callerKeyId: string;
  readonly intentId: string;
  readonly network: string; // 'solana:devnet' | 'solana:mainnet'
  readonly payTo: string; // base58
  readonly mint: string; // base58
  readonly amountAtomic: string; // DECIMAL STRING — never a number (CD-10)
}

/** Row as read back from the ledger. `amountAtomic` stays a string (CD-10). */
export interface PayoutRow {
  readonly status: PayoutStatus;
  readonly payTo: string;
  readonly mint: string;
  readonly amountAtomic: string;
  readonly signature: string | null;
  readonly recentBlockhash: string | null;
  readonly attempts: number;
  readonly claimedAt: string; // ISO
}

export type ClaimResult =
  | { readonly ok: true; readonly claimed: true } // won the INSERT → may sign
  | { readonly ok: true; readonly claimed: false; readonly row: PayoutRow } // existed → caller resolves by state
  | { readonly ok: false }; // store down → FAIL-CLOSED

/** Shape of the row as stored in Postgres (snake_case), for the narrow mapper. */
interface PayoutRowRaw {
  status?: unknown;
  pay_to?: unknown;
  mint?: unknown;
  amount_atomic?: unknown;
  signature?: unknown;
  recent_blockhash?: unknown;
  attempts?: unknown;
  claimed_at?: unknown;
}

const ROW_COLUMNS =
  'status,pay_to,mint,amount_atomic,signature,recent_blockhash,attempts,claimed_at';

/** Narrow an untyped PostgREST row into `PayoutRow`. Returns null if unusable. */
function toPayoutRow(raw: PayoutRowRaw | null | undefined): PayoutRow | null {
  if (raw === null || raw === undefined) return null;
  const { status, pay_to, mint, amount_atomic, signature, recent_blockhash, attempts, claimed_at } =
    raw;
  if (status !== 'claimed' && status !== 'signed' && status !== 'confirmed') return null;
  if (typeof pay_to !== 'string' || typeof mint !== 'string') return null;
  // amount_atomic is TEXT in the schema (WKH-196): a NUMERIC would come back as a
  // JSON number and lose precision above 2^53. Keep it a string, always.
  if (typeof amount_atomic !== 'string') return null;
  if (typeof claimed_at !== 'string') return null;
  return {
    status,
    payTo: pay_to,
    mint,
    amountAtomic: amount_atomic,
    signature: typeof signature === 'string' ? signature : null,
    recentBlockhash: typeof recent_blockhash === 'string' ? recent_blockhash : null,
    attempts: typeof attempts === 'number' ? attempts : 0,
    claimedAt: claimed_at,
  };
}

/**
 * Claim `(callerKeyId, intentId)` with an `INSERT` (never an upsert-ignore) so the
 * UNIQUE violation surfaces as a distinct outcome instead of being swallowed:
 *   - `{ ok:true, claimed:true }`  → won the race; the caller MAY build+sign.
 *   - `{ ok:true, claimed:false, row }` → 23505; the caller resolves by row state
 *                                    (§6.5) — conflict, replay, steal or in-progress.
 *   - `{ ok:false }`               → null client / error / unreadable row →
 *                                    FAIL-CLOSED reject.
 *
 * Reading the row after losing the INSERT is the ONE permitted read (it classifies
 * an outcome; it does not decide a transition).
 */
export async function claimPayout(
  intent: PayoutIntent,
  logger?: PayoutLedgerLogger,
): Promise<ClaimResult> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: intent.network },
        'solana payout ledger unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }

    const { error } = await client.from(TABLE).insert({
      caller_key_id: intent.callerKeyId,
      intent_id: intent.intentId,
      network: intent.network,
      pay_to: intent.payTo,
      mint: intent.mint,
      amount_atomic: intent.amountAtomic,
      status: 'claimed',
    });

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        logger?.debug(
          { intent_id: intent.intentId, caller_key_id: intent.callerKeyId },
          'solana payout claim duplicate (23505) — resolving by row state',
        );
        const existing = await readPayout(intent, logger);
        if (!existing.ok || existing.row === undefined) return { ok: false };
        return { ok: true, claimed: false, row: existing.row };
      }
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout claim insert failed — fail-closed',
      );
      return { ok: false };
    }

    return { ok: true, claimed: true };
  } catch (err) {
    logger?.warn(
      { err, intent_id: intent.intentId },
      'solana payout claim insert threw — fail-closed',
    );
    return { ok: false };
  }
}

/**
 * Take over a `claimed` row whose lease expired. By I2 a `claimed` row has NO
 * signature, so its holder died BEFORE signing and never broadcast anything —
 * re-signing is safe.
 *
 * CD-7: ONE conditional `UPDATE` guarded by `status='claimed' AND claimed_at <
 * cutoff`, returning the affected ids. `stolen` is true only when exactly one row
 * came back, so two concurrent stealers can never both win. The cutoff is computed
 * in code (never by interpolating Postgres `now()` into a string).
 */
export async function stealStaleClaim(
  intent: PayoutIntent,
  leaseMs: number,
  logger?: PayoutLedgerLogger,
): Promise<{ ok: boolean; stolen: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: intent.network },
        'solana payout ledger unavailable (no client) — fail-closed',
      );
      return { ok: false, stolen: false };
    }
    const cutoffIso = new Date(Date.now() - leaseMs).toISOString();
    // NOTE on `attempts`: the Story File's raw SQL reads `attempts = attempts + 1`.
    // PostgREST's plain `.update()` takes VALUES, not expressions, so an atomic
    // increment would need either a read-modify-write (which invites a lost update)
    // or a DB function outside this HU's migration scope. `attempts` is diagnostics
    // only; the load-bearing part of the steal is RENEWING the lease (`claimed_at`),
    // which is done here inside the same single conditional write (CD-7).
    const { data, error } = await client
      .from(TABLE)
      .update({ claimed_at: new Date().toISOString() })
      .eq('caller_key_id', intent.callerKeyId)
      .eq('intent_id', intent.intentId)
      .eq('status', 'claimed')
      .lt('claimed_at', cutoffIso)
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout steal-stale-claim failed — fail-closed',
      );
      return { ok: false, stolen: false };
    }
    return { ok: true, stolen: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, intent_id: intent.intentId },
      'solana payout steal-stale-claim threw — fail-closed',
    );
    return { ok: false, stolen: false };
  }
}

/**
 * Persist the signature + blockhash, moving `claimed` → `signed`. This is the
 * write that makes invariant I2 true: the route calls it from `onSigned`, i.e.
 * AFTER `partialSign` and BEFORE `serialize`/broadcast, and refuses to transmit
 * when it returns `{ ok:false }`.
 *
 * CD-7: conditional on `status='claimed'`, so a row someone else already advanced
 * cannot be overwritten.
 */
export async function markSigned(
  intent: PayoutIntent,
  signature: string,
  recentBlockhash: string,
  logger?: PayoutLedgerLogger,
): Promise<{ ok: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: intent.network },
        'solana payout ledger unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }
    const { data, error } = await client
      .from(TABLE)
      .update({ status: 'signed', signature, recent_blockhash: recentBlockhash })
      .eq('caller_key_id', intent.callerKeyId)
      .eq('intent_id', intent.intentId)
      .eq('status', 'claimed')
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout mark-signed failed — fail-closed',
      );
      return { ok: false };
    }
    return { ok: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, intent_id: intent.intentId },
      'solana payout mark-signed threw — fail-closed',
    );
    return { ok: false };
  }
}

/**
 * §6.5 transition: `signed` + NOT confirmed + blockhash PROVEN INVALID ⇒ back to
 * `claimed` so the retry may re-sign. The caller MUST have established, in the same
 * invocation, that the recorded blockhash is no longer valid — i.e. that tx can
 * never land — before calling this.
 *
 * ⚠️ Reading of I2 after a revert: `claimed` no longer means "never signed", it
 * means "no LIVE broadcast exists" — either nothing was ever signed, or the
 * previous signature was PROVEN dead before the revert. That is exactly the
 * property `stealStaleClaim` relies on, and it is what keeps at-most-once true.
 * Do NOT call this on a `signed` row whose blockhash is still valid: that tx can
 * still land and re-signing would pay twice.
 *
 * CD-7: ONE conditional write, guarded by `status='signed'` AND the exact
 * signature observed, so a concurrent request that already advanced the row (or a
 * different attempt's signature) cannot be clobbered. `signature`/`recent_blockhash`
 * are cleared so a dead signature never lingers on a `claimed` row.
 *
 * NOTE: this export is REQUIRED by §6.5 of the Story File but is absent from its
 * §4.2 export list — see the Dev report; the two sections disagree and §6.5 is the
 * one that carries the money semantics.
 */
export async function revertSignedToClaimed(
  intent: PayoutIntent,
  signature: string,
  logger?: PayoutLedgerLogger,
): Promise<{ ok: boolean; reverted: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: intent.network },
        'solana payout ledger unavailable (no client) — fail-closed',
      );
      return { ok: false, reverted: false };
    }
    const { data, error } = await client
      .from(TABLE)
      .update({
        status: 'claimed',
        signature: null,
        recent_blockhash: null,
        claimed_at: new Date().toISOString(),
      })
      .eq('caller_key_id', intent.callerKeyId)
      .eq('intent_id', intent.intentId)
      .eq('status', 'signed')
      .eq('signature', signature)
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout revert-signed failed — fail-closed',
      );
      return { ok: false, reverted: false };
    }
    return { ok: true, reverted: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, intent_id: intent.intentId },
      'solana payout revert-signed threw — fail-closed',
    );
    return { ok: false, reverted: false };
  }
}

/**
 * Move a row to `confirmed` once the broadcast confirmed on-chain. Conditional on
 * the SIGNATURE (not on the previous status) so the confirmation of a specific tx
 * can never be attributed to a different attempt.
 */
export async function markConfirmed(
  intent: PayoutIntent,
  signature: string,
  logger?: PayoutLedgerLogger,
): Promise<{ ok: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) return { ok: false };
    const { data, error } = await client
      .from(TABLE)
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('caller_key_id', intent.callerKeyId)
      .eq('intent_id', intent.intentId)
      .eq('signature', signature)
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout mark-confirmed failed — fail-closed',
      );
      return { ok: false };
    }
    return { ok: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, intent_id: intent.intentId },
      'solana payout mark-confirmed threw — fail-closed',
    );
    return { ok: false };
  }
}

/**
 * Read the row for `(callerKeyId, intentId)`. Used to CLASSIFY an outcome (after a
 * lost INSERT race, or to re-check state), never to decide a transition (CD-7).
 * Fail-closed: any error yields `{ ok:false }`.
 */
export async function readPayout(
  intent: PayoutIntent,
  logger?: PayoutLedgerLogger,
): Promise<{ ok: boolean; row?: PayoutRow }> {
  try {
    const client = getSupabaseClient();
    if (!client) return { ok: false };
    const { data, error } = await client
      .from(TABLE)
      .select(ROW_COLUMNS)
      .eq('caller_key_id', intent.callerKeyId)
      .eq('intent_id', intent.intentId)
      .maybeSingle();
    if (error) {
      logger?.warn(
        { err: error, intent_id: intent.intentId },
        'solana payout read failed — fail-closed',
      );
      return { ok: false };
    }
    const row = toPayoutRow(data as PayoutRowRaw | null);
    if (row === null) return { ok: true };
    return { ok: true, row };
  } catch (err) {
    logger?.warn({ err, intent_id: intent.intentId }, 'solana payout read threw — fail-closed');
    return { ok: false };
  }
}
