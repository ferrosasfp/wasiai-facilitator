/**
 * Settlement ledger — core persistence helpers (WFAC-32).
 *
 * Responsibilities:
 *   1. Build a `LedgerEntry` from a successful or failed settle result.
 *   2. Persist that entry into Supabase via fire-and-forget UPSERT.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import from `src/infra/*` (runtime) and `pino` (type-only).
 *   - MUST NOT import from `src/chains/*`, `src/methods/*`, `src/routes/*`
 *     (CD-3). The input to `buildLedgerEntry` is a structural type defined
 *     locally so the core layer never reaches into chain/method shapes.
 *   - MUST NOT import `@supabase/supabase-js` directly — access is only
 *     through `getSupabaseClient()`.
 *
 * Contracts:
 *   - `persistLedgerEntry` NEVER throws at the caller (CD-1). All error paths
 *     are captured and logged at `warn`/`debug` via the injected logger.
 *   - `amount` is a decimal string end-to-end (atomic uint256 → NUMERIC(78,0)
 *     in Postgres). No `Number()` or `BigInt()` conversions (CD-17).
 *   - No `console.*` usage (CD-5). No PII in the entry (CD-7 / AC-9).
 */

import type { Logger } from 'pino';
import { getSupabaseClient } from '../infra/supabase.js';

/**
 * Minimal logger surface used by this module. Mirrors the `Pick<Logger, ...>`
 * pattern from `src/infra/redis.ts` so callers can pass either a Pino Logger
 * or a FastifyBaseLogger.
 */
export type LedgerLogger = Pick<Logger, 'warn' | 'debug'>;

/**
 * Row shape persisted into `facilitator_settlements` (see
 * `supabase/migrations/001_facilitator_settlements.sql`).
 *
 * Columns map 1:1 with snake_case DB names. Nullable fields reflect the
 * `success_has_tx` CHECK constraint in the DDL.
 */
export interface LedgerEntry {
  readonly idempotency_key: string; // sha256 hex (64 chars)
  readonly status: 'success' | 'failed';
  readonly tx_hash: string | null;
  readonly block_number: number | null;
  readonly network: string; // 'eip155:<chainId>'
  readonly method: 'eip3009' | 'permit2' | 'erc7710';
  readonly asset: string;
  readonly amount: string; // atomic uint256 as decimal string (CD-17)
  readonly payer: string;
  readonly payee: string;
  readonly error_code: string | null;
  readonly error_http: number | null;
  readonly duration_ms: number;
}

/**
 * Structural input for `buildLedgerEntry`. Defined locally to avoid pulling
 * types from `src/chains/*` or `src/methods/*` (CD-3).
 *
 * `parsed` provides the fallback identity data (asset/payer/payee/amount)
 * for the failure branch, where no on-chain result is available.
 */
export interface BuildLedgerEntryInput {
  readonly idempotencyKey: string;
  readonly durationMs: number;
  readonly method: 'eip3009' | 'permit2' | 'erc7710';
  readonly network: string;
  readonly parsed: {
    readonly accepted: {
      readonly asset: string;
      readonly payTo: string;
      readonly amount: string;
    };
    readonly payload: {
      readonly authorization: { readonly from: string };
    };
  };
  readonly result:
    | {
        readonly ok: true;
        readonly settled: true;
        readonly transactionHash: string;
        readonly blockNumber: number;
        readonly amount: string;
        readonly from: string;
        readonly to: string;
        readonly asset: string;
      }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message?: string;
          readonly http: number;
        };
      };
}

/**
 * Pure function. Maps the union-typed `result` + request context into a
 * `LedgerEntry` row ready for persistence.
 *
 * CD-13: the 13 output fields are listed by name (no `{ ...result }`
 * spread) to keep the DB surface auditable and prevent accidental leakage
 * of extra properties from the adapter layer.
 */
export function buildLedgerEntry(input: BuildLedgerEntryInput): LedgerEntry {
  if (input.result.ok) {
    return {
      idempotency_key: input.idempotencyKey,
      status: 'success',
      tx_hash: input.result.transactionHash,
      block_number: input.result.blockNumber,
      network: input.network,
      method: input.method,
      asset: input.result.asset,
      amount: input.result.amount, // CD-17: already string
      payer: input.result.from,
      payee: input.result.to,
      error_code: null,
      error_http: null,
      duration_ms: input.durationMs,
    };
  }

  // Failure branch: derive on-chain identity data from the parsed request.
  return {
    idempotency_key: input.idempotencyKey,
    status: 'failed',
    tx_hash: null,
    block_number: null,
    network: input.network,
    method: input.method,
    asset: input.parsed.accepted.asset,
    amount: input.parsed.accepted.amount, // CD-17: already string
    payer: input.parsed.payload.authorization.from,
    payee: input.parsed.accepted.payTo,
    error_code: input.result.error.code,
    error_http: input.result.error.http,
    duration_ms: input.durationMs,
  };
}

/**
 * Persist a ledger entry. Fire-and-forget: the awaited promise ALWAYS
 * resolves — errors are swallowed + logged (CD-1 / AC-3).
 *
 * No-ops when `getSupabaseClient()` returns `null` (AC-4 / AC-7).
 *
 * UPSERT with `onConflict: 'idempotency_key', ignoreDuplicates: true`
 * guarantees idempotent writes — a retried request with the same key is
 * silently treated as a no-op (AC-5).
 */
export async function persistLedgerEntry(entry: LedgerEntry, logger: LedgerLogger): Promise<void> {
  try {
    // CD-1 / AC-3: `getSupabaseClient()` itself may throw synchronously
    // (e.g. `createClient()` rejecting an unusual URL scheme). Wrapping the
    // call inside the try/catch guarantees fail-open even for bootstrap bugs.
    const client = getSupabaseClient();
    if (!client) return;

    const { data, error } = await client
      .from('facilitator_settlements')
      .upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true });

    if (error) {
      logger.warn(
        { err: error, idempotency_key: entry.idempotency_key, network: entry.network },
        'ledger upsert failed',
      );
      return;
    }

    // `ignoreDuplicates: true` silences ON CONFLICT with an empty-array/null
    // return. Log at debug for observability — NOT warn (AC-5).
    const rows: unknown = data;
    if (rows === null || (Array.isArray(rows) && rows.length === 0)) {
      logger.debug({ idempotency_key: entry.idempotency_key }, 'ledger upsert silenced duplicate');
    }
  } catch (err) {
    // CD-1: capture EVERY throw from the async chain — including synchronous
    // throws from `getSupabaseClient()` / `createClient()`. Never re-throw.
    logger.warn(
      { err, idempotency_key: entry.idempotency_key, network: entry.network },
      'ledger client or upsert failed',
    );
  }
}
