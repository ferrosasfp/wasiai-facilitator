/**
 * Solana durable anti-replay + settlement ledger (WKH-205 / HU-SOL-6).
 *
 * The non-EVM analogue of the EVM ledger, but with an INVERTED failure policy:
 * whereas `src/core/ledger.ts` treats a missing/failed Supabase client as a
 * fire-and-forget no-op (fail-OPEN — the EVM nonce on-chain already reverts a
 * replay), Solana verify-only has NO on-chain backstop. The `UNIQUE(signature)`
 * index in `facilitator_solana_settlements` is the ONLY line of defense, so
 * every uncertain path here is **fail-CLOSED**: `{ ok: false }` means the caller
 * MUST reject, never accept.
 *
 * Boundaries (OWNERS.md [5]):
 *   - MAY import `src/infra/supabase.ts` (runtime, only `getSupabaseClient`),
 *     `pino` (type-only).
 *   - MUST NOT import `@supabase/supabase-js` directly, `src/chains/*`,
 *     `src/core/*`, `src/methods/*`, `src/routes/*`.
 *
 * Contracts:
 *   - `isSolanaSignatureSettled(signature)` — read: `{ ok:true, settled }` on a
 *     successful query, `{ ok:false }` on no-client / query-error (fail-CLOSED).
 *   - `recordSolanaSignature(entry)` — atomic INSERT: `{ ok:true, inserted:true }`
 *     on first settle, `{ ok:true, inserted:false }` on Postgres UNIQUE violation
 *     (code 23505 = duplicate), `{ ok:false }` on no-client / other error
 *     (fail-CLOSED).
 *   - `amount` is a decimal string end-to-end (atomic u64 → NUMERIC(78,0)). No
 *     `Number()` / `BigInt()` conversion here (CD-9). No PII in stdout.
 */

import type { Logger } from 'pino';
import { getSupabaseClient } from './supabase.js';

const TABLE = 'facilitator_solana_settlements';

/** Postgres unique_violation error code (supabase-js surfaces it as `error.code`). */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Minimal logger surface used by this module. Mirrors the `Pick<Logger, ...>`
 * pattern from `src/core/ledger.ts` so callers can pass either a Pino Logger or
 * a FastifyBaseLogger. No PII is ever logged (only signature + network).
 */
export type SolanaDedupLogger = Pick<Logger, 'warn' | 'debug'>;

/** Result of the durable replay lookup. */
export type IsSettledResult =
  | { readonly ok: true; readonly settled: boolean }
  | { readonly ok: false };

/** Result of the durable settlement INSERT. */
export type RecordResult =
  | { readonly ok: true; readonly inserted: true }
  | { readonly ok: true; readonly inserted: false }
  | { readonly ok: false };

/** Row persisted into `facilitator_solana_settlements`. */
export interface SolanaSettlementEntry {
  readonly signature: string;
  readonly network: string;
  readonly reference: string | null;
  readonly mint: string;
  readonly payTo: string;
  readonly amount: string; // decimal string atomic u64 (NUMERIC(78,0))
}

/**
 * Durable replay check. Returns `{ ok:true, settled }` on a clean query.
 *
 * FAIL-CLOSED: a null client (Supabase unconfigured) OR any query error yields
 * `{ ok:false }` — the OPPOSITE of the EVM ledger's swallow-to-allow. The
 * caller MUST treat `{ ok:false }` as a hard reject (dedup store unavailable),
 * never as "not settled → accept".
 */
export async function isSolanaSignatureSettled(
  signature: string,
  logger?: SolanaDedupLogger,
): Promise<IsSettledResult> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: 'solana' },
        'solana dedup store unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }

    // This SELECT does NOT read `amount`; if a future SELECT reads it, cast
    // `amount::text` (CD-9, WKH-196 precision-loss > 2^53).
    const { data, error } = await client
      .from(TABLE)
      .select('signature')
      .eq('signature', signature)
      .maybeSingle();

    if (error) {
      logger?.warn({ err: error, signature }, 'solana dedup select failed — fail-closed');
      return { ok: false };
    }

    return { ok: true, settled: data !== null };
  } catch (err) {
    // Synchronous throw from getSupabaseClient()/createClient() → fail-CLOSED.
    logger?.warn({ err, signature }, 'solana dedup select threw — fail-closed');
    return { ok: false };
  }
}

/**
 * Durable settlement INSERT — the atomic anti-replay barrier. Two concurrent
 * settles serialize on `UNIQUE(signature)`: the loser hits code 23505 →
 * `{ ok:true, inserted:false }` (duplicate). A first settle inserts →
 * `{ ok:true, inserted:true }`.
 *
 * FAIL-CLOSED: null client OR any error other than 23505 → `{ ok:false }`.
 * INSERT (never upsert-ignore) so the UNIQUE violation surfaces as a distinct
 * `inserted:false` instead of being silently swallowed.
 */
export async function recordSolanaSignature(
  entry: SolanaSettlementEntry,
  logger?: SolanaDedupLogger,
): Promise<RecordResult> {
  try {
    const client = getSupabaseClient();
    if (!client) {
      logger?.warn(
        { network: entry.network },
        'solana dedup store unavailable (no client) — fail-closed',
      );
      return { ok: false };
    }

    const { error } = await client.from(TABLE).insert({
      signature: entry.signature,
      network: entry.network,
      reference: entry.reference,
      mint: entry.mint,
      pay_to: entry.payTo,
      amount: entry.amount, // decimal string (CD-9): no Number/BigInt coercion
    });

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        logger?.debug(
          { signature: entry.signature },
          'solana dedup duplicate (23505) — replay rejected',
        );
        return { ok: true, inserted: false };
      }
      logger?.warn(
        { err: error, signature: entry.signature },
        'solana dedup insert failed — fail-closed',
      );
      return { ok: false };
    }

    return { ok: true, inserted: true };
  } catch (err) {
    logger?.warn({ err, signature: entry.signature }, 'solana dedup insert threw — fail-closed');
    return { ok: false };
  }
}
