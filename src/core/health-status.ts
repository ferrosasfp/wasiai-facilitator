/**
 * Dependency-aware health status (ECOSYSTEM-AUDIT OP-05).
 *
 * Surfaces readiness signals WITHOUT leaking secrets and WITHOUT making the
 * `/health` liveness probe block on dependency latency:
 *   - Redis reachability (real PING, via src/core/idempotency.ts helper).
 *   - Per-chain RPC reachability (each adapter's own `probeRpc()`, bounded by a
 *     short timeout).
 *   - Operator wallet presence (env var SET / NOT SET — never the value).
 *
 * DESIGN (why the probe is delegated to the adapter): this module used to probe
 * every registered adapter with two viem/EVM calls inline
 * (`getPublicClient().getChainId()`) and to resolve the adapter by numeric
 * chainId (`eip155:<id>` key). Both are EVM-only assumptions, so the non-EVM
 * Solana adapter — registered as `solana:<cluster>`, with no viem client by
 * design — was reported `rpc: 'unreachable'` on EVERY refresh and `/health`
 * answered `degraded: true` permanently. A health module that is always red
 * trains operators to ignore it, which is worse than no health at all. Fix:
 *   1. resolve the adapter by `metadata.networkId` (family-agnostic key), and
 *   2. call `adapter.probeRpc()` — REQUIRED by `SettlementAdapter`, so a new
 *      adapter cannot compile without a probe and can never be mis-probed
 *      silently. This module now knows NOTHING about chain families.
 *
 * DESIGN (why hysteresis on transient failures): the public Solana devnet RPC
 * rate-limits aggressively (HTTP 429) and `Connection` retries 429 internally,
 * so a rate-limited refresh surfaces here as a probe timeout. Flipping
 * `degraded` on every such blip would replace a health that lies in red with one
 * that flaps. So probe failures are CLASSIFIED:
 *   - 'connection' (ECONNREFUSED / DNS / TLS / bad adapter) → unambiguous:
 *     `unreachable` on the FIRST failure, exactly as before.
 *   - 'transient' (429 / rate limit / timeout / 502-504 / socket reset) →
 *     tolerated while `consecutiveFailures < TRANSIENT_FAILURE_THRESHOLD`; the
 *     chain keeps `rpc: 'ok'` but the (additive) `consecutiveFailures` +
 *     `lastFailureKind` fields expose the blip, so tolerating is never silent.
 *     A real outage still lands as `unreachable` on the next refresh (~1 TTL).
 * Any successful probe resets that chain's counter.
 *
 * DESIGN (why a cache): probing a live Redis/RPC on every `/health` request
 * couples the liveness probe to dependency latency — a dead RPC would make
 * `/health` slow or hang, which is exactly what a liveness probe must NOT do.
 * Instead we keep a process-cached snapshot refreshed in the BACKGROUND on a
 * TTL. `getHealthStatus()` returns the last-known snapshot INSTANTLY and kicks
 * off a non-awaited refresh when the snapshot is stale. So `/health` stays a
 * fast 200 while still reporting accurate (near-real-time) dependency state.
 *
 * Boundaries (OWNERS.md row `src/core/`):
 *   - MAY import: `../chains/registry.js` (registry singleton — allowed "salvo
 *     vía registry"), `../chains/types.js` (type-only), `../infra/*`.
 *   - MUST NOT import: `../chains/<chain>.js` directly, `../methods/*`,
 *     `../routes/*`.
 *
 * SECURITY: no secret is ever returned. Wallet detail is a boolean presence
 * flag derived from `process.env.OPERATOR_PRIVATE_KEY != null` — the key value
 * is NEVER read into the response.
 */

import type { ChainMetadata } from '../chains/types.js';
import { chainRegistry } from '../chains/registry.js';
import { isRedisConfigured, isRedisReachable } from './idempotency.js';

/** Per-chain RPC probe timeout (ms). Kept short so a refresh never lingers. */
const RPC_PROBE_TIMEOUT_MS = 1500;

/**
 * How long a cached snapshot is served before a background refresh is kicked.
 *
 * EXPORTED (WKH-344) because the published `description` of `GET /health` states this
 * staleness bound in milliseconds, and a number copied into prose drifts in silence:
 * `T-O-DRIFT-3` compares the text against THIS constant, so the one-line mutant
 * `SNAPSHOT_TTL_MS = 30000` turns that test red instead of leaving a false sentence
 * published. Nothing in `src/` reads it through the export.
 */
export const SNAPSHOT_TTL_MS = 5000;

/**
 * Consecutive TRANSIENT probe failures tolerated before a chain is reported
 * `unreachable`. 2 = one blip is forgiven, a second consecutive one is not.
 * 'connection'-class failures ignore this threshold (reported immediately).
 */
const TRANSIENT_FAILURE_THRESHOLD = 2;

/**
 * Failure classification of a probe rejection (see module DESIGN note).
 *
 * Runtime tuple, not a bare union: `doc/openapi.yaml` publishes these values as an
 * `enum` and had no way to derive them, so it repeated them by hand and could drift in
 * silence. `T-O11-DETAIL` compares the published enum against THIS array. Same shape as
 * `DEDICATED_ROUTE_IDS` in `src/core/supported.ts:149-155`, and same one-line mutant that
 * reopens the drift: writing the union out by hand again instead of deriving it.
 */
export const PROBE_FAILURE_KINDS = ['transient', 'connection'] as const;
export type ProbeFailureKind = (typeof PROBE_FAILURE_KINDS)[number];

/**
 * Errors that mean "the RPC is there but did not answer THIS time": rate limits
 * (the public Solana devnet RPC 429s aggressively), our own probe timeout,
 * gateway 5xx and socket resets. Everything else is treated as a hard
 * 'connection' failure (ECONNREFUSED, DNS/TLS, or a malformed adapter).
 */
const TRANSIENT_PROBE_ERROR_RE =
  /\b429\b|too many requests|rate limit|rate-limit|timeout|timed out|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up|\b50[234]\b/i;

/**
 * 'ok' = RPC reachable (or a transient failure still tolerated); 'unreachable' = probe failed.
 *
 * Runtime tuple for the same reason as `PROBE_FAILURE_KINDS`: `ChainHealthItem.rpc` is
 * published as an `enum` in `doc/openapi.yaml` and `T-O11-DETAIL` derives it from here.
 */
export const CHAIN_RPC_STATUSES = ['ok', 'unreachable'] as const;
export type ChainRpcStatus = (typeof CHAIN_RPC_STATUSES)[number];

export interface ChainHealth {
  readonly chainId: number;
  readonly name: string;
  readonly network: string;
  /** 'ok' = RPC reachable; 'unreachable' = probe failed/timed out. */
  readonly rpc: ChainRpcStatus;
  /**
   * ADDITIVE (optional — omitted entirely on a clean probe, so the healthy
   * response stays byte-identical to the pre-fix shape): consecutive failed
   * probes for this chain. Present with `rpc: 'ok'` when a TRANSIENT failure is
   * still being tolerated (see module DESIGN note on hysteresis).
   */
  readonly consecutiveFailures?: number;
  /** ADDITIVE (optional): classification of the last failed probe. */
  readonly lastFailureKind?: ProbeFailureKind;
}

/**
 * 'ok' (PING succeeded), 'unreachable' (PING failed), or 'disabled' (no REDIS_URL).
 *
 * Runtime tuple for the same reason as `PROBE_FAILURE_KINDS`: `HealthDetail.redis.status`
 * is published as an `enum` in `doc/openapi.yaml` and `T-O11-DETAIL` derives it from here.
 */
export const REDIS_HEALTH_STATUSES = ['ok', 'unreachable', 'disabled'] as const;
export type RedisHealthStatus = (typeof REDIS_HEALTH_STATUSES)[number];

export interface HealthStatusDetail {
  /** Overall: true when ANY tracked dependency is not in its healthy state. */
  readonly degraded: boolean;
  readonly redis: {
    /** Whether a REDIS_URL is configured (false in test/in-memory mode). */
    readonly configured: boolean;
    /** 'ok' (PING succeeded), 'unreachable' (PING failed), or 'disabled'. */
    readonly status: RedisHealthStatus;
  };
  readonly wallet: {
    /** Operator signing key present in env (NEVER the value). */
    readonly present: boolean;
  };
  readonly chains: readonly ChainHealth[];
  /** Epoch ms when this snapshot's probes completed (0 = never probed yet). */
  readonly probedAt: number;
}

// ─── cached snapshot + background refresh ───────────────────────────────────
let _snapshot: HealthStatusDetail | null = null;
let _refreshing: Promise<void> | null = null;

/**
 * Consecutive-failure counters keyed by `metadata.networkId` (the same key the
 * registry uses, so it is family-agnostic). Only holds entries for chains whose
 * LAST probe failed — a success deletes the entry.
 */
const _probeFailures = new Map<string, { count: number; kind: ProbeFailureKind }>();

/** Classify a probe rejection as a tolerable blip vs a hard connection failure. */
function classifyProbeError(err: unknown): ProbeFailureKind {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT_PROBE_ERROR_RE.test(text) ? 'transient' : 'connection';
}

/**
 * Record a failed probe for `networkId` and decide what to REPORT for it.
 * Hysteresis: a 'transient' failure below the threshold keeps `rpc: 'ok'` (with
 * the additive counters exposing the blip); a 'connection' failure, or a
 * transient one at/over the threshold, reports 'unreachable'.
 */
function reportFailure(
  networkId: string,
  kind: ProbeFailureKind,
): Pick<ChainHealth, 'rpc' | 'consecutiveFailures' | 'lastFailureKind'> {
  const count = (_probeFailures.get(networkId)?.count ?? 0) + 1;
  _probeFailures.set(networkId, { count, kind });
  const tolerated = kind === 'transient' && count < TRANSIENT_FAILURE_THRESHOLD;
  return {
    rpc: tolerated ? 'ok' : 'unreachable',
    consecutiveFailures: count,
    lastFailureKind: kind,
  };
}

/**
 * Probe a single adapter's RPC via its OWN `probeRpc()`, bounded by a short
 * timeout. Returns 'ok' on success, 'unreachable' on a hard/repeated failure.
 * NEVER throws — a broken adapter degrades the report, never the probe.
 *
 * This function is deliberately chain-family-agnostic: it resolves the adapter
 * by `metadata.networkId` and touches NO viem/`getPublicClient()`/`getChainId()`
 * API, so non-EVM adapters (Solana) are probed correctly by construction.
 */
async function probeChain(meta: ChainMetadata): Promise<ChainHealth> {
  const base = {
    chainId: meta.chainId as number,
    name: meta.name,
    network: meta.networkId,
  };
  // networkId (NOT chainId): `getAdapter(chainId)` only resolves `eip155:<id>`
  // and narrows to the viem `ChainAdapter`, so it structurally misses every
  // non-EVM rail (`solana:<cluster>`) — the root cause of the permanent
  // `degraded: true` in production.
  const lookup = chainRegistry.getAdapterByNetworkId(meta.networkId);
  if (!lookup.ok) {
    // Not registered under its own networkId — a hard, non-transient defect.
    return { ...base, ...reportFailure(meta.networkId, 'connection') };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('rpc probe timeout')), RPC_PROBE_TIMEOUT_MS);
    });
    // The adapter owns the cheapest round-trip for its own rail (EVM
    // `eth_chainId`, Solana `getVersion`) — see SettlementAdapter.probeRpc.
    await Promise.race([lookup.adapter.probeRpc(), timeout]);
    _probeFailures.delete(meta.networkId);
    return { ...base, rpc: 'ok' };
  } catch (err) {
    return { ...base, ...reportFailure(meta.networkId, classifyProbeError(err)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run all probes and return a fresh snapshot. Never throws. */
async function probeAll(): Promise<HealthStatusDetail> {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const redisConfigured = isRedisConfigured();
  const [redisOk, chains] = await Promise.all([
    redisConfigured ? isRedisReachable() : Promise.resolve(false),
    Promise.all(adapters.map((meta) => probeChain(meta))),
  ]);

  const redisStatus: RedisHealthStatus = !redisConfigured
    ? 'disabled'
    : redisOk
      ? 'ok'
      : 'unreachable';

  // Wallet presence — env var SET/NOT SET only (never the value).
  const walletPresent = typeof process.env['OPERATOR_PRIVATE_KEY'] === 'string';

  const anyChainDown = chains.some((c) => c.rpc === 'unreachable');
  // Redis 'disabled' (no REDIS_URL, e.g. test) is NOT degraded; only a
  // configured-but-unreachable Redis is. A missing wallet IS degraded (the
  // facilitator cannot settle without a signer).
  const degraded = redisStatus === 'unreachable' || !walletPresent || anyChainDown;

  return {
    degraded,
    redis: { configured: redisConfigured, status: redisStatus },
    wallet: { present: walletPresent },
    chains,
    probedAt: Date.now(),
  };
}

/** Build the optimistic initial snapshot used before the first probe lands. */
function initialSnapshot(): HealthStatusDetail {
  const redisConfigured = isRedisConfigured();
  const walletPresent = typeof process.env['OPERATOR_PRIVATE_KEY'] === 'string';
  const chains: readonly ChainHealth[] = chainRegistry.listAdapters().map((meta) => ({
    chainId: meta.chainId as number,
    name: meta.name,
    network: meta.networkId,
    rpc: 'ok' as const, // optimistic until the first probe completes
  }));
  return {
    // Wallet absence is known synchronously and IS a real degraded signal.
    degraded: !walletPresent,
    redis: { configured: redisConfigured, status: redisConfigured ? 'ok' : 'disabled' },
    wallet: { present: walletPresent },
    chains,
    probedAt: 0,
  };
}

/** Kick a background refresh if one is not already in flight. Never awaited by callers. */
function kickRefresh(): void {
  if (_refreshing) return;
  _refreshing = probeAll()
    .then((snap) => {
      _snapshot = snap;
    })
    .catch(() => {
      // probeAll never throws, but guard anyway — keep the last snapshot.
    })
    .finally(() => {
      _refreshing = null;
    });
}

/**
 * Return the dependency-aware health detail. NON-BLOCKING: serves the cached
 * snapshot instantly and triggers a background refresh when stale. The first
 * call returns an optimistic snapshot (probedAt: 0) and starts the first probe.
 */
export async function getHealthStatus(): Promise<HealthStatusDetail> {
  if (!_snapshot) {
    _snapshot = initialSnapshot();
    kickRefresh();
    return _snapshot;
  }
  if (Date.now() - _snapshot.probedAt > SNAPSHOT_TTL_MS) {
    kickRefresh();
  }
  return _snapshot;
}

/**
 * Force a synchronous (awaited) probe and return the fresh snapshot. Used by
 * tests that need deterministic dependency state without waiting for the TTL.
 */
export async function refreshHealthStatusNow(): Promise<HealthStatusDetail> {
  const snap = await probeAll();
  _snapshot = snap;
  return snap;
}

/** @internal — tests only. Clears the cached snapshot + the hysteresis counters. */
export function resetHealthStatusForTesting(): void {
  _snapshot = null;
  _refreshing = null;
  _probeFailures.clear();
}
