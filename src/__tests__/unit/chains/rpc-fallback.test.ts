/**
 * P1 — OP-04: per-chain RPC fallback transport.
 *
 * PROVES: when a `*_RPC_URL_FALLBACK` env is set, the chain's viem client uses
 * a `fallback([http(primary), http(secondary)])` transport (so a primary RPC
 * outage rolls over), and when it is NOT set the client keeps working with a
 * single `http(primary)` transport (backward-compatible). Also covers the
 * sane public-default fallback for known chainIds.
 *
 * We introspect the transport by invoking it (viem transports are factory
 * functions): a `fallback` transport reports `config.type === 'fallback'` and
 * exposes `value.transports`; an `http` transport reports `config.type ===
 * 'http'`.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_TESTNET_RPC_URL_FALLBACK',
  'KITE_MAINNET_RPC_URL',
  'KITE_MAINNET_ENABLED',
  'KITE_MAINNET_USDC_ADDRESS',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
] as const;

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;

/* eslint-disable security/detect-object-injection -- ENV_KEYS is a fixed literal tuple. */
function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}
/* eslint-enable security/detect-object-injection */

/**
 * Resolve the transport "kind" of a viem PublicClient by invoking its
 * transport factory. Returns 'fallback' | 'http' and the inner transport count
 * for fallback.
 */
function inspectTransport(client: { transport: Record<string, unknown> }): {
  type: string;
  innerCount: number;
} {
  // viem stores the RESOLVED transport on client.transport. A fallback
  // transport carries `type: 'fallback'` and an array `transports`.
  const t = client.transport;
  const type = String(t['type']);
  const inner = t['transports'];
  const innerCount = Array.isArray(inner) ? inner.length : 0;
  return { type, innerCount };
}

describe('P1 OP-04 — RPC fallback transport', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('FB-1: explicit *_RPC_URL_FALLBACK → public client uses a fallback transport with 2 inner transports', async () => {
    process.env['KITE_TESTNET_RPC_URL'] = 'https://primary.example/rpc';
    process.env['KITE_TESTNET_RPC_URL_FALLBACK'] = 'https://secondary.example/rpc';
    const mod = await import('../../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient() as unknown as {
      transport: Record<string, unknown>;
    };
    const info = inspectTransport(client);
    expect(info.type).toBe('fallback');
    expect(info.innerCount).toBe(2);
  });

  it('FB-2: no explicit fallback but a known chainId → public default fallback transport is used', async () => {
    // Use a non-public primary so it differs from the public default for 2368.
    process.env['KITE_TESTNET_RPC_URL'] = 'https://primary.example/rpc';
    delete process.env['KITE_TESTNET_RPC_URL_FALLBACK'];
    const mod = await import('../../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient() as unknown as {
      transport: Record<string, unknown>;
    };
    const info = inspectTransport(client);
    // chainId 2368 has a sane public fallback → still a fallback transport.
    expect(info.type).toBe('fallback');
    expect(info.innerCount).toBe(2);
  });

  it('FB-3: primary equal to the public default → single http transport (no duplicate fallback)', async () => {
    // When the operator's primary IS the public fallback, we must NOT build a
    // fallback([http(x), http(x)]) — base-adapter dedups equal URLs.
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    delete process.env['KITE_TESTNET_RPC_URL_FALLBACK'];
    const mod = await import('../../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient() as unknown as {
      transport: Record<string, unknown>;
    };
    const info = inspectTransport(client);
    expect(info.type).toBe('http');
  });

  it('FB-4: wallet client also uses the fallback transport when configured', async () => {
    process.env['KITE_TESTNET_RPC_URL'] = 'https://primary.example/rpc';
    process.env['KITE_TESTNET_RPC_URL_FALLBACK'] = 'https://secondary.example/rpc';
    const mod = await import('../../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getWalletClient() as unknown as {
      transport: Record<string, unknown>;
    };
    const info = inspectTransport(client);
    expect(info.type).toBe('fallback');
    expect(info.innerCount).toBe(2);
  });

  it('FB-5: publicFallbackRpcUrl returns a URL for known chains and undefined otherwise', async () => {
    const { publicFallbackRpcUrl } = await import('../../../chains/base-adapter.js');
    expect(publicFallbackRpcUrl(2368)).toBeDefined();
    expect(publicFallbackRpcUrl(43113)).toBeDefined();
    expect(publicFallbackRpcUrl(8453)).toBeDefined();
    expect(publicFallbackRpcUrl(999999)).toBeUndefined();
  });
});
