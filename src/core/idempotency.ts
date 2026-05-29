/**
 * Idempotency cache for POST /verify (WFAC-20, DT-Idempotency of SDD).
 *
 * Key strategy: SHA-256 of canonical-JSON(parsed request body).
 *   - "Canonical" = keys sorted alphabetically recursively; arrays preserve
 *     insertion order.
 *   - "Parsed" = post-Zod VerifyRequest — removes whitespace / key-order
 *     noise from the raw HTTP body.
 *
 * Redis integration is optional + null-safe:
 *   - If getRedisClient() returns null, we act as "always cache miss"
 *     (AC-10 graceful degradation).
 *   - If Redis is up but .get/.set throws → swallow, no propagation.
 *
 * Boundary (OWNERS):
 *   - MAY import: node:crypto, ../infra/redis.js (only getRedisClient),
 *     ./schemas.js (type-only `VerifyRequest`).
 *   - MUST NOT import: src/routes/*, src/chains/*, src/methods/*, direct
 *     ioredis (always via the getRedisClient singleton).
 *
 * CDs enforced:
 *   - CD-4  : never throw for foreseeable errors; every Redis error is
 *             swallowed and the route is responsible for deciding behavior.
 *   - CD-7  : TTL declared ONCE as `VERIFY_IDEMPOTENCY_TTL_SEC`.
 *   - CD-11 : canonicalStringify is deterministic across key-order
 *             permutations (tested in W4 T-I2..T-I4).
 *   - CD-12 : toCacheable refuses to cache http >= 500 (caller must still
 *             respond — we just don't memoize transient errors).
 */

import { createHash } from 'node:crypto';
import { getRedisClient } from '../infra/redis.js';
import type { VerifyRequest } from './schemas.js';

/** Idempotency cache TTL in seconds (CD-7: declared once). */
export const VERIFY_IDEMPOTENCY_TTL_SEC = 120;

/** Prefix for all /verify idempotency keys in Redis. */
export const VERIFY_IDEMPOTENCY_KEY_PREFIX = 'verify:idempotency:';

/**
 * Exact shape of the VerifyResult fields we persist for a successful hit.
 * Mirrors `VerifyResult` in src/chains/types.ts minus the `ok` discriminant.
 */
export interface CachedVerifyResponseOk {
  readonly ok: true;
  readonly response: {
    readonly verified: true;
    readonly client: `0x${string}`;
    readonly amount: string;
    readonly asset: `0x${string}`;
    readonly network: string;
    readonly payTo: `0x${string}`;
    readonly expiresAt: number;
  };
}

/** Shape persisted for a non-5xx adapter error. */
export interface CachedVerifyResponseErr {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly http: number; // always < 500 by CD-12
  };
}

export type CachedVerifyResponse = CachedVerifyResponseOk | CachedVerifyResponseErr;

/**
 * Input shape accepted by `toCacheable`. Structurally equivalent to
 * `Result<VerifyResult>` but declared locally so core/idempotency.ts does
 * not depend on src/chains/types.ts (OWNERS: core/* must not import
 * chains/*).
 */
export type ToCacheableInput =
  | {
      readonly ok: true;
      readonly verified: true;
      readonly client: `0x${string}`;
      readonly amount: string;
      readonly asset: `0x${string}`;
      readonly network: string;
      readonly payTo: `0x${string}`;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly http: number;
      };
    };

/**
 * Canonical JSON serialization: recursively sorts object keys. Arrays
 * preserve insertion order. Primitives pass through `JSON.stringify` as-is.
 *
 * Determinism required by CD-11 — two structurally-equal objects with
 * different key orderings MUST produce the same output string.
 *
 * Notes:
 *   - `undefined` properties: dropped (matches `JSON.stringify` semantics).
 *   - `NaN` / `Infinity`: produce `null` (matches `JSON.stringify`).
 *   - Arrays: preserved in order — reordering would break semantics.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalStringify(v));
    return `[${parts.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    // eslint-disable-next-line security/detect-object-injection -- `k` is from Object.keys(obj); finite set derived from the object itself.
    const raw = obj[k];
    if (raw === undefined) continue; // mirror JSON.stringify dropping undefined
    parts.push(`${JSON.stringify(k)}:${canonicalStringify(raw)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Builds the full Redis key `verify:idempotency:<sha256-hex>`. */
export function buildIdempotencyKey(parsed: VerifyRequest): string {
  const canonical = canonicalStringify(parsed);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${VERIFY_IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

/**
 * CD-9 helper: lets the route emit AC-10 warn log without touching the
 * redis module directly. Returns false when:
 *   - initRedis was never called, OR
 *   - REDIS_URL is undefined (test env path).
 */
export function isRedisAvailable(): boolean {
  return getRedisClient() !== null;
}

/**
 * Read the cached response.
 *
 * Returns:
 *   - `null`  → cache miss (Redis unavailable, genuine miss, or transient
 *               error on .get). Caller proceeds as if no cache existed.
 *   - object  → cache hit → caller replays without invoking the adapter
 *               (AC-9).
 */
export async function getCachedVerifyResponse(key: string): Promise<CachedVerifyResponse | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedVerifyResponse;
  } catch {
    // Swallow — AC-10 graceful degradation. Logging stays route-side
    // (core must not own a logger).
    return null;
  }
}

/**
 * Write a cached response with TTL. Swallows all errors (CD-4).
 * CD-12: caller is expected to pre-filter via `toCacheable()`; this
 * function trusts the `payload` argument.
 */
export async function setCachedVerifyResponse(
  key: string,
  payload: CachedVerifyResponse,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(payload), 'EX', VERIFY_IDEMPOTENCY_TTL_SEC);
  } catch {
    // Swallow — graceful degradation.
  }
}

/**
 * CD-12: convert a `Result<VerifyResult>`-shaped value into a
 * `CachedVerifyResponse` or `null`. Returns `null` when http >= 500
 * (not cacheable — such errors may be transient and should be retried).
 */
export function toCacheable(result: ToCacheableInput): CachedVerifyResponse | null {
  if (result.ok) {
    return {
      ok: true,
      response: {
        verified: result.verified,
        client: result.client,
        amount: result.amount,
        asset: result.asset,
        network: result.network,
        payTo: result.payTo,
        expiresAt: result.expiresAt,
      },
    };
  }
  if (result.error.http >= 500) return null; // CD-12
  return { ok: false, error: result.error };
}

// ─── WFAC-21 settle helpers ─────────────────────────────────────────────
//
// All settle-related exports live alongside the verify helpers so the
// route layer imports from ONE façade (`src/core/idempotency.ts`). We do
// NOT create a separate file (SDD §DT-2).
//
// Naming convention: every new symbol is prefixed with `Settle*` or
// `SETTLE_*` so auditors can grep the two concepts apart.

/** Spec x402: 120 s window for idempotency replay. */
export const SETTLE_IDEMPOTENCY_TTL_SEC = 120;

/** Distinct prefix from VERIFY_IDEMPOTENCY_KEY_PREFIX (CD-6, CD-11 SDD nuevo). */
export const SETTLE_IDEMPOTENCY_KEY_PREFIX = 'settle:idempotency:';

/** Prefix for in-flight settle locks (distinct from idempotency entries). */
export const SETTLE_INFLIGHT_KEY_PREFIX = 'settle:inflight:';

/**
 * Cached settle success — 7 spec-literal fields of SettleResult.
 * NOTE: structural (no `SettleResult` import from src/chains/types.ts) to
 * keep the OWNERS boundary `core/idempotency.ts → infra + crypto + schemas`
 * intact. Mirrors the pattern used by CachedVerifyResponse.
 */
export interface CachedSettleResponseOk {
  readonly ok: true;
  readonly response: {
    readonly settled: true;
    readonly transactionHash: `0x${string}`;
    readonly blockNumber: number;
    readonly amount: string;
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    readonly asset: `0x${string}`;
  };
}

/** Cached settle error — always `http < 500` (CD-12 enforced by toCacheableSettle). */
export interface CachedSettleResponseErr {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly http: number;
  };
}

export type CachedSettleResponse = CachedSettleResponseOk | CachedSettleResponseErr;

/**
 * Structural input for toCacheableSettle — matches `Result<SettleResult>`
 * without importing the concrete type (OWNERS: core/idempotency.ts does
 * NOT import src/chains/*). Same pattern as ToCacheableInput.
 */
export type ToCacheableSettleInput =
  | {
      readonly ok: true;
      readonly settled: true;
      readonly transactionHash: `0x${string}`;
      readonly blockNumber: number;
      readonly amount: string;
      readonly from: `0x${string}`;
      readonly to: `0x${string}`;
      readonly asset: `0x${string}`;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly http: number;
      };
    };

/**
 * Builds the full Redis key `settle:idempotency:<sha256-hex>`.
 * Reuses `canonicalStringify` — no duplication (CD-8 heredado).
 */
export function buildSettleIdempotencyKey(parsed: VerifyRequest): string {
  const canonical = canonicalStringify(parsed);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${SETTLE_IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

/**
 * Read the cached settle response.
 *
 * Returns:
 *   - `null`  → cache miss (Redis unavailable or genuine miss) → caller proceeds.
 *   - object  → cache hit → caller replays WITHOUT invoking the adapter
 *               (CRITICAL: prevents double-spend when the original tx is
 *               in-flight mempool or already mined).
 */
export async function getCachedSettleResponse(key: string): Promise<CachedSettleResponse | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedSettleResponse;
  } catch {
    // Swallow — graceful degradation (AC-10). Do NOT log here (logger is
    // route-owned). Return null to pass-through.
    return null;
  }
}

/**
 * Write settle cache entry with TTL.
 * Swallows all errors (CD-4 applies: never throw on expected failure).
 * CD-12: caller must pre-filter via toCacheableSettle().
 */
export async function setCachedSettleResponse(
  key: string,
  payload: CachedSettleResponse,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(payload), 'EX', SETTLE_IDEMPOTENCY_TTL_SEC);
  } catch {
    // Swallow — graceful degradation.
  }
}

/**
 * Map an idempotency key to its in-flight lock key (same canonical hash, a
 * distinct prefix so a lock never collides with a cached response entry).
 */
function toInflightKey(idempotencyKey: string): string {
  // idempotencyKey = `${SETTLE_IDEMPOTENCY_KEY_PREFIX}${hash}`
  return idempotencyKey.startsWith(SETTLE_IDEMPOTENCY_KEY_PREFIX)
    ? `${SETTLE_INFLIGHT_KEY_PREFIX}${idempotencyKey.slice(SETTLE_IDEMPOTENCY_KEY_PREFIX.length)}`
    : `${SETTLE_INFLIGHT_KEY_PREFIX}${idempotencyKey}`;
}

/**
 * Acquire an in-flight lock for a settle request (WFAC-AUDIT AC-3).
 *
 * Returns:
 *   - 'acquired' → lock set (SET NX OK) → caller dispatches settleCore.
 *   - 'held'     → lock already exists (concurrent identical request in-flight)
 *                  → caller responds HTTP 409.
 *   - 'skipped'  → Redis unavailable / error → caller proceeds WITHOUT lock.
 *
 * SAFETY: This lock is a BEST-EFFORT server-side optimization. The ULTIMATE
 * double-spend safeguard is the EIP-3009 on-chain nonce — a second
 * transferWithAuthorization with the same nonce reverts on-chain. That is why
 * fail-open on Redis outage (CD-7) is safe here: the chain is the source of truth.
 */
export async function setInflightSettleLock(
  idempotencyKey: string,
): Promise<'acquired' | 'held' | 'skipped'> {
  const client = getRedisClient();
  if (!client) return 'skipped';
  try {
    const res = await client.set(
      toInflightKey(idempotencyKey),
      '1',
      'EX',
      SETTLE_IDEMPOTENCY_TTL_SEC,
      'NX',
    );
    return res !== null ? 'acquired' : 'held';
  } catch {
    return 'skipped'; // fail-open (CD-7)
  }
}

/**
 * Release an in-flight settle lock. Swallow-on-error — the TTL (120s) is the
 * backstop if the del races/fails.
 */
export async function releaseInflightSettleLock(idempotencyKey: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.del(toInflightKey(idempotencyKey));
  } catch {
    // swallow — TTL (120s) is the backstop.
  }
}

/**
 * Convert a Result<SettleResult> into a CachedSettleResponse or null.
 * Returns null when http >= 500 (not cacheable — transient/permanent 5xx
 * must NOT block future retries — CD-12 heredado de WFAC-20).
 *
 * CD-11 (new): success branch builds the response object EXPLICITLY with
 * the 7 spec-literal fields (no rest-spread destructure). This is the
 * "explicit object build" lesson from WFAC-20 auto-blindaje W1.
 */
export function toCacheableSettle(result: ToCacheableSettleInput): CachedSettleResponse | null {
  if (result.ok) {
    return {
      ok: true,
      response: {
        settled: result.settled,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        amount: result.amount,
        from: result.from,
        to: result.to,
        asset: result.asset,
      },
    };
  }
  if (result.error.http >= 500) return null; // CD-12
  return { ok: false, error: result.error };
}
