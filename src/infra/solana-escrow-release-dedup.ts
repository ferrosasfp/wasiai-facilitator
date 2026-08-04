/**
 * WKH-216 / HU-SOL-13 — Wave 13c: escrow-release anti-replay (AC-5 / CD-9).
 *
 * Mirror of `src/infra/solana-dedup.ts` (AH-25) with an INVERTED, claim-FIRST
 * shape tailored to the release. The `UNIQUE(escrow_pda)` index in
 * `facilitator_solana_release_claims` is a durable, at-most-once barrier: the
 * facilitator co-signs+broadcasts a `release` for a given escrow AT MOST once,
 * even under concurrent requests. The on-chain `status` flip to `Released`
 * (verified in 13b) is the money-path truth; this table is the local, PRE-sign
 * guard that prevents a double broadcast BEFORE that flip is observable.
 *
 * FAIL-CLOSED (like `solana-dedup.ts`): a null/failed Supabase client yields
 * `{ ok:false }` — the caller MUST reject the release, never proceed. Solana has
 * no nonce backstop; this barrier is the only pre-sign line of defense.
 *
 * CLAIM-FIRST: `claimEscrowRelease` INSERTs (never upsert-ignore) BEFORE any sign,
 * so a Postgres 23505 UNIQUE violation surfaces as `claimed:false` (already
 * released) and the route rejects with 409 without re-signing.
 *
 * LEASE (migration 006). Claim-first has a cost: everything that runs between the
 * INSERT and the broadcast (fetching a blockhash, the freshness probe, the send)
 * can fail with the claim ALREADY written. With no expiry that escrow was
 * irreleaseable FOREVER — the retry hit the 23505, read it as a replay, and got a
 * permanent 409. So a claim now carries `claimed_at`, and one older than the lease
 * may be TAKEN OVER by a retry (`stealStaleReleaseClaim`). The row is never
 * deleted: `UNIQUE(escrow_pda)` is still the at-most-once barrier; the lease makes
 * a stuck claim RECOVERABLE, it does not weaken the barrier.
 *
 * WHY TAKING OVER A CLAIM DOES NOT DOUBLE-BROADCAST — three separate guards, all
 * required, and none of them sufficient on its own:
 *   1. `stealStaleReleaseClaim` is ONE conditional UPDATE reporting the rows it
 *      touched, so of N concurrent takers exactly one sees `stolen:true`.
 *   2. The lease is re-anchored to the instant of SIGNING (`markReleaseSigned` runs
 *      between `partialSign` and `serialize`), and `SOLANA_ESCROW_RELEASE_LEASE_MS`
 *      has a floor above a blockhash's lifetime — so a claim old enough to steal
 *      belongs to a tx that can no longer land. A tx that ALREADY landed is caught
 *      by guard 3, not by this one.
 *   3. `markReleaseSigned` is a ONE-SHOT fence (`status: claimed → signed`): if two
 *      requests both survived the lease, exactly one wins it, and the loser is
 *      refused the broadcast rather than transmitting a second release.
 * The route adds a fourth, outside this module: it re-reads the on-chain escrow
 * state in the SAME invocation and rejects with 409 when it already reads
 * `Released`, which is what covers the previous attempt whose tx DID land.
 *
 * OWNERSHIP (CD-8): this table is facilitator-GLOBAL dedup with NO `owner_ref`
 * (same as `facilitator_solana_settlements`); the ownership guard does not apply.
 *
 * Boundaries: MAY import `src/infra/supabase.ts` (runtime, only `getSupabaseClient`)
 * + `pino` (type-only). MUST NOT import `@supabase/supabase-js`, `src/chains/*`,
 * `src/core/*`, `src/methods/*`, `src/routes/*`.
 */

import type { Logger } from 'pino';
import { getSupabaseClient } from './supabase.js';

const TABLE = 'facilitator_solana_release_claims';

/** Postgres unique_violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

/** Minimal logger surface (no PII — only escrow_pda + network). */
export type ReleaseDedupLogger = Pick<Logger, 'warn' | 'debug'>;

/** Result of the release claim. `{ ok:false }` ⇒ store unavailable ⇒ fail-closed. */
export type ClaimResult =
  | { readonly ok: true; readonly claimed: true } // first claim → proceed to sign
  | { readonly ok: true; readonly claimed: false } // already claimed → replay, reject
  | { readonly ok: false }; // store unavailable/error → fail-closed reject

/** Row persisted into `facilitator_solana_release_claims`. No PII. */
export interface ReleaseClaimEntry {
  readonly escrowPda: string; // base58 PDA — the UNIQUE key
  readonly sender: string; // base58
  readonly remittanceId: string; // server-only trace id
  readonly network: string; // 'solana:devnet' | 'solana:mainnet'
}

/**
 * Claim the release for an escrow PDA (mutate-FIRST). Returns:
 *   - `{ ok:true, claimed:true }`  → first claim; the caller MAY build+sign.
 *   - `{ ok:true, claimed:false }` → UNIQUE(escrow_pda) violation (23505); a
 *                                    release was already claimed → reject (replay).
 *   - `{ ok:false }`               → null client / other error → FAIL-CLOSED reject.
 *
 * INSERT (never upsert-ignore) so the UNIQUE violation surfaces as a distinct
 * `claimed:false` rather than being silently swallowed.
 */
export async function claimEscrowRelease(
  entry: ReleaseClaimEntry,
  logger?: ReleaseDedupLogger,
): Promise<ClaimResult> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: entry.network },
        'solana release dedup store unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }

    const { error } = await client.from(TABLE).insert({
      escrow_pda: entry.escrowPda,
      sender: entry.sender,
      remittance_id: entry.remittanceId,
      network: entry.network,
    });

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        logger?.debug(
          { escrow_pda: entry.escrowPda },
          'solana release dedup duplicate (23505) — replay rejected',
        );
        return { ok: true, claimed: false };
      }
      logger?.warn(
        { err: error, escrow_pda: entry.escrowPda },
        'solana release dedup insert failed — fail-closed',
      );
      return { ok: false };
    }

    return { ok: true, claimed: true };
  } catch (err) {
    logger?.warn(
      { err, escrow_pda: entry.escrowPda },
      'solana release dedup insert threw — fail-closed',
    );
    return { ok: false };
  }
}

/**
 * Take over a claim whose lease expired (see LEASE in the file header). Returns
 * `{ ok:true, stolen:true }` ONLY to the single caller whose conditional UPDATE
 * actually touched the row; everybody else gets `stolen:false` and must reject.
 *
 * ONE conditional write (no read-then-write): two concurrent takers would both
 * read the same stale `claimed_at` and both conclude they may proceed, so the
 * decision has to live inside the write itself. `stolen` is true only when exactly
 * one row came back. The cutoff is computed in code — never by interpolating
 * Postgres `now()` into a filter string.
 *
 * The `status` is NOT part of the filter, on purpose. A `signed` row whose
 * broadcast died is exactly the case this fix exists for: leaving it unstealable
 * would keep the escrow blocked forever, which is the bug. What makes it safe is
 * the lease floor (a tx signed more than a lease ago can no longer land) plus the
 * route's on-chain `Released` check, NOT the status column. Taking it over resets
 * `status` to `claimed` so the one-shot fence can be won again.
 *
 * FAIL-CLOSED: null client / error / exception ⇒ `{ ok:false, stolen:false }`.
 */
export async function stealStaleReleaseClaim(
  entry: ReleaseClaimEntry,
  leaseMs: number,
  logger?: ReleaseDedupLogger,
): Promise<{ ok: boolean; stolen: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: entry.network },
        'solana release dedup store unavailable (no client) — fail-closed',
      );
      return { ok: false, stolen: false };
    }
    const cutoffIso = new Date(Date.now() - leaseMs).toISOString();
    const { data, error } = await client
      .from(TABLE)
      .update({ status: 'claimed', claimed_at: new Date().toISOString() })
      .eq('escrow_pda', entry.escrowPda)
      .eq('network', entry.network)
      .lt('claimed_at', cutoffIso)
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, escrow_pda: entry.escrowPda },
        'solana release dedup steal-stale-claim failed — fail-closed',
      );
      return { ok: false, stolen: false };
    }
    return { ok: true, stolen: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, escrow_pda: entry.escrowPda },
      'solana release dedup steal-stale-claim threw — fail-closed',
    );
    return { ok: false, stolen: false };
  }
}

/**
 * The ONE-SHOT FENCE, called between `partialSign` and `serialize` (guard 3 of the
 * file header). `status: claimed → signed`, conditional on `status='claimed'`, so
 * of two requests that both survived the lease exactly one gets `{ ok:true }` — and
 * the caller MUST NOT broadcast when this returns `{ ok:false }`.
 *
 * It also re-anchors `claimed_at` to NOW, which is what moves the lease clock from
 * "when the claim was written" to "when a tx first could exist". Without that
 * re-anchoring the lease would have to cover an unbounded gap (a hung
 * `getLatestBlockhash` alone can eat it) and a takeover could race a live tx.
 *
 * FAIL-CLOSED: null client / error / exception ⇒ `{ ok:false }` ⇒ no broadcast.
 */
export async function markReleaseSigned(
  entry: ReleaseClaimEntry,
  logger?: ReleaseDedupLogger,
): Promise<{ ok: boolean }> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: entry.network },
        'solana release dedup store unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }
    const { data, error } = await client
      .from(TABLE)
      .update({ status: 'signed', claimed_at: new Date().toISOString() })
      .eq('escrow_pda', entry.escrowPda)
      .eq('network', entry.network)
      .eq('status', 'claimed')
      .select('id');
    if (error) {
      logger?.warn(
        { err: error, escrow_pda: entry.escrowPda },
        'solana release dedup mark-signed failed — fail-closed',
      );
      return { ok: false };
    }
    return { ok: Array.isArray(data) && data.length === 1 };
  } catch (err) {
    logger?.warn(
      { err, escrow_pda: entry.escrowPda },
      'solana release dedup mark-signed threw — fail-closed',
    );
    return { ok: false };
  }
}
