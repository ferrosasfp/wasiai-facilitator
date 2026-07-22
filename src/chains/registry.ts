/**
 * ChainRegistry — singleton store + lookup for registered chain adapters.
 *
 * Exposes:
 *   - chainRegistry (singleton instance — primary public export)
 *   - ChainRegistry (class — exported for internal/test purposes only)
 *
 * Invariants:
 *   - Internal Map<ChainId, ChainAdapter> — O(1) lookups (CD-13, CD-16).
 *   - getAdapter() never throws — returns Result<T> (CD-4).
 *   - register() de-duplicates by metadata.chainId (CD-18).
 *   - Logger is injected via setLogger() — registry NEVER calls createLogger()
 *     itself to respect OWNERS matrix (chains/* must not depend on infra/*
 *     at runtime). See DT-11 of SDD.
 *
 * Boundaries:
 *   - Only imports ./types.js (sibling) + pino type (type-only).
 *   - NO imports from src/core/*, src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work: WFAC-10+ will call chainRegistry.setLogger(logger) in app boot.
 */

import type { Logger } from 'pino';
import type { ChainAdapter, ChainMetadata, RegisterResult, SettlementAdapter } from './types.js';
import type { ChainId } from '../core/types.js';

export class ChainRegistry {
  private readonly _adapters = new Map<string, SettlementAdapter>();
  private _logger: Logger | undefined;

  setLogger(logger: Logger): void {
    this._logger = logger;
  }

  register(adapter: SettlementAdapter): RegisterResult {
    // CD-6 runtime guard: adapter shape check (AC-6).
    if (!this._isValidAdapter(adapter)) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Invalid adapter: missing required methods',
          http: 500,
        },
      };
    }

    const chainId = adapter.metadata.chainId;
    const networkId = adapter.metadata.networkId;

    if (this._adapters.has(networkId)) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Chain already registered: ${chainId}`,
          http: 409,
        },
      };
    }

    this._adapters.set(networkId, adapter);
    this._logger?.info({ chainId, name: adapter.metadata.name }, 'Chain adapter registered');
    return { ok: true, chainId };
  }

  getAdapterByNetworkId(networkId: string):
    | { readonly ok: true; readonly adapter: SettlementAdapter }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: 'NETWORK_MISMATCH';
          readonly message: string;
          readonly http: number;
        };
      } {
    const adapter = this._adapters.get(networkId);
    if (!adapter) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Network not registered: ${networkId}`,
          http: 400,
        },
      };
    }
    return { ok: true, adapter };
  }

  getAdapter(chainId: ChainId):
    | { readonly ok: true; readonly adapter: ChainAdapter }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: 'NETWORK_MISMATCH';
          readonly message: string;
          readonly http: number;
        };
      } {
    const lookup = this.getAdapterByNetworkId(`eip155:${chainId}`);
    if (!lookup.ok) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Chain not registered: ${chainId}`,
          http: 400,
        },
      };
    }
    if (!this._isChainAdapter(lookup.adapter)) {
      // Never happens: an eip155:* adapter is always a ChainAdapter. The
      // duck-typed guard makes the narrowing a SANE cast + O(1) (CD-7).
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Chain not registered: ${chainId}`,
          http: 400,
        },
      };
    }
    return { ok: true, adapter: lookup.adapter };
  }

  listAdapters(): readonly ChainMetadata[] {
    const out: ChainMetadata[] = [];
    for (const adapter of this._adapters.values()) {
      out.push(adapter.metadata);
    }
    return out;
  }

  getSupportedChainIds(): readonly ChainId[] {
    const out: ChainId[] = [];
    for (const adapter of this._adapters.values()) {
      out.push(adapter.metadata.chainId);
    }
    return out;
  }

  /**
   * Test-only utility. Throws in non-test environments (CD-9).
   */
  _resetForTesting(): void {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error('_resetForTesting() is only available in test environment');
    }
    this._adapters.clear();
    this._logger = undefined;
  }

  private _isValidAdapter(candidate: SettlementAdapter): boolean {
    // Runtime shape guard — TS enforces at compile-time, this catches
    // objects passed via unsafe casts or from external boundaries. WKH-205:
    // validates the SettlementAdapter base shape only (EVM + non-EVM). The
    // viem-client checks (getPublicClient/getWalletClient) moved to the
    // narrowing guard `_isChainAdapter` used by `getAdapter(chainId)`.
    return (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof candidate.metadata === 'object' &&
      candidate.metadata !== null &&
      typeof candidate.metadata.chainId === 'number' &&
      typeof candidate.verify === 'function' &&
      typeof candidate.settle === 'function'
    );
  }

  /**
   * WKH-205 — duck-typed narrowing from `SettlementAdapter` to `ChainAdapter`
   * (the EVM viem-client subtype). Used by `getAdapter(chainId)` so its
   * `{ ok:true; adapter: ChainAdapter }` contract stays byte-identical while
   * the Map now holds the wider `SettlementAdapter`. Every `eip155:*` adapter
   * is a `ChainAdapter`, so the guard is a SANE O(1) cast, never a blind one.
   */
  private _isChainAdapter(a: SettlementAdapter): a is ChainAdapter {
    return (
      typeof (a as ChainAdapter).getPublicClient === 'function' &&
      typeof (a as ChainAdapter).getWalletClient === 'function'
    );
  }
}

export const chainRegistry = new ChainRegistry();
