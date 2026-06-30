/**
 * Dependency-aware health status (ECOSYSTEM-AUDIT OP-05).
 *
 * Surfaces readiness signals WITHOUT leaking secrets and WITHOUT making the
 * `/health` liveness probe block on dependency latency:
 *   - Redis reachability (real PING, via src/core/idempotency.ts helper).
 *   - Per-chain RPC reachability (cheap `getChainId()` probe per registered
 *     adapter, bounded by a short timeout).
 *   - Operator wallet presence (env var SET / NOT SET — never the value).
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

/** How long a cached snapshot is served before a background refresh is kicked. */
const SNAPSHOT_TTL_MS = 5000;

export interface ChainHealth {
  readonly chainId: number;
  readonly name: string;
  readonly network: string;
  /** 'ok' = RPC reachable; 'unreachable' = probe failed/timed out. */
  readonly rpc: 'ok' | 'unreachable';
}

export interface HealthStatusDetail {
  /** Overall: true when ANY tracked dependency is not in its healthy state. */
  readonly degraded: boolean;
  readonly redis: {
    /** Whether a REDIS_URL is configured (false in test/in-memory mode). */
    readonly configured: boolean;
    /** 'ok' (PING succeeded), 'unreachable' (PING failed), or 'disabled'. */
    readonly status: 'ok' | 'unreachable' | 'disabled';
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
 * Probe a single adapter's RPC with a bounded `getChainId()` call. Returns
 * 'ok' on success, 'unreachable' on any error or timeout. Never throws.
 */
async function probeChain(meta: ChainMetadata): Promise<ChainHealth> {
  const base = {
    chainId: meta.chainId as number,
    name: meta.name,
    network: meta.networkId,
  };
  const lookup = chainRegistry.getAdapter(meta.chainId);
  if (!lookup.ok) {
    return { ...base, rpc: 'unreachable' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = lookup.adapter.getPublicClient();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('rpc probe timeout')), RPC_PROBE_TIMEOUT_MS);
    });
    // `getChainId()` is the cheapest authenticated round-trip to the RPC.
    await Promise.race([client.getChainId(), timeout]);
    return { ...base, rpc: 'ok' };
  } catch {
    return { ...base, rpc: 'unreachable' };
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

  const redisStatus: 'ok' | 'unreachable' | 'disabled' = !redisConfigured
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

/** @internal — tests only. Clears the cached snapshot. */
export function resetHealthStatusForTesting(): void {
  _snapshot = null;
  _refreshing = null;
}
