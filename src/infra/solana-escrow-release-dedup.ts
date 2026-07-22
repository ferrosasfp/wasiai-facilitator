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
