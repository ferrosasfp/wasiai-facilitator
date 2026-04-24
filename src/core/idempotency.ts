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
export async function getCachedVerifyResponse(
  key: string,
): Promise<CachedVerifyResponse | null> {
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
