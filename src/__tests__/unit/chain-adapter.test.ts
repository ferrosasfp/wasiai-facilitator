import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { VerifyParams } from '../../chains/types.js';

// NOTE: we intentionally do NOT import ChainAdapterInitError statically here.
// `vi.resetModules()` (used in beforeEach) invalidates the module cache and
// causes subsequent dynamic imports of ../../chains/types.js to produce a
// DIFFERENT class constructor. If we compared instances against a statically
// imported reference, `instanceof` would fail for all but the first test.
// Instead we match by error name + message via regex — the thrown error is
// still the domain-defined `ChainAdapterInitError`, just from a freshly
// re-evaluated module graph.

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'AVALANCHE_FUJI_RPC_URL',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
] as const;

/* eslint-disable security/detect-object-injection -- `k` is constrained to the
 * const tuple ENV_KEYS literal (5 hardcoded env-var names). Not user input; the
 * security/detect-object-injection heuristic cannot narrow tuple element types. */
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

// Hardhat account #0 — reused for all real EIP-712 signature fixtures below.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;

/**
 * Build a VerifyParams object with a REAL EIP-712 signature signed by Hardhat
 * account #0 against the canonical Kite Testnet USDC (PYUSD) domain. Exposed
 * to the describe blocks below via closure.
 *
 * Overrides:
 *   - message: partial override to mutate validBefore / from / etc.
 *   - signature: pre-signed hex (bypasses the signing call) — used by
 *     T-V-NORMALIZE-FAIL to inject a malleable signature.
 *   - acceptedAmount: string override for AC-5 (high-accepted-amount case).
 */
async function makeValidVerifyParams(overrides?: {
  message?: Partial<{
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
  }>;
  signature?: `0x${string}`;
  acceptedAmount?: string;
}): Promise<VerifyParams> {
  // Import EIP-712 constants from the chains/abi duplicate (fresh per test —
  // vi.resetModules() in beforeEach re-evaluates the module graph).
  const { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } = await import('../../chains/abi/fiat-token.js');

  const nowSec = Math.floor(Date.now() / 1000);
  const baseMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
    ...overrides?.message,
  };
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 2368,
    verifyingContract: TEST_USDC,
  };
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const signature =
    overrides?.signature ??
    (await account.signTypedData({
      domain,
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message: baseMessage,
    }));
  return {
    x402Version: 2,
    resource: { url: 'https://example.com' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: overrides?.acceptedAmount ?? '1000',
      asset: TEST_USDC,
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: {
      signature,
      authorization: {
        from: baseMessage.from,
        to: baseMessage.to,
        value: baseMessage.value.toString(),
        validAfter: baseMessage.validAfter.toString(),
        validBefore: baseMessage.validBefore.toString(),
        nonce: baseMessage.nonce,
      },
    },
  };
}

describe('kite.ts adapters', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    // WFAC-50 — wallet singleton + token address env vars.
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('AC-11: kiteTestnetAdapter has chainId 2368 and testnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteTestnetAdapter.metadata.chainId).toBe(2368);
    expect(mod.kiteTestnetAdapter.metadata.network).toBe('testnet');
    expect(mod.kiteTestnetAdapter.metadata.networkId).toBe('eip155:2368');
  });

  it('AC-12: kiteMainnetAdapter has chainId 2366 and mainnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteMainnetAdapter.metadata.chainId).toBe(2366);
    expect(mod.kiteMainnetAdapter.metadata.network).toBe('mainnet');
    expect(mod.kiteMainnetAdapter.metadata.networkId).toBe('eip155:2366');
  });

  it('AC-13: throws ChainAdapterInitError when KITE_TESTNET_RPC_URL missing', async () => {
    delete process.env['KITE_TESTNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_TESTNET_RPC_URL/);
  });

  it('AC-13: throws ChainAdapterInitError when KITE_MAINNET_RPC_URL missing', async () => {
    delete process.env['KITE_MAINNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_MAINNET_RPC_URL/);
  });

  it('DT-4: getPublicClient returns an object with readContract method', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient();
    expect(client).toBeDefined();
    expect(typeof client.readContract).toBe('function');
  });

  it('DT-4: getWalletClient returns an object with writeContract method (WFAC-50 — now account-injected)', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getWalletClient();
    expect(client).toBeDefined();
    expect(typeof client.writeContract).toBe('function');
    // WFAC-50 AC-8: account is injected by getOperatorAccount() singleton.
    expect(client.account).toBeDefined();
    expect(client.account?.address.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
  });

  // ─── WFAC-50 — real EIP-712 verify (AC-1..AC-6 + AC-18) ─────────────────
  describe('WFAC-50 _verifyRaw', () => {
    it('T-V-HAPPY (AC-1): valid signature -> ok:true with recovered client', async () => {
      const mod = await import('../../chains/kite.js');
      const params = await makeValidVerifyParams();
      const result = await mod.kiteTestnetAdapter.verify(params);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.client.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
        expect(result.amount).toBe('1000');
        expect(result.asset.toLowerCase()).toBe(TEST_USDC.toLowerCase());
        expect(result.network).toBe('eip155:2368');
      }
    });

    it('T-V-SIG-MISMATCH (AC-3): signer != authorization.from -> INVALID_SIGNATURE 401', async () => {
      const mod = await import('../../chains/kite.js');
      // Sign with account #0 but claim `from` is account #1 address.
      const params = await makeValidVerifyParams({
        message: { from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}` },
      });
      const result = await mod.kiteTestnetAdapter.verify(params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });

    it('T-V-EXPIRED (AC-4): validBefore in the past -> EXPIRED_AUTHORIZATION 400', async () => {
      const mod = await import('../../chains/kite.js');
      const nowSec = Math.floor(Date.now() / 1000);
      const params = await makeValidVerifyParams({
        message: { validBefore: BigInt(nowSec - 1) },
      });
      const result = await mod.kiteTestnetAdapter.verify(params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
        expect(result.error.http).toBe(400);
      }
    });

    it('T-V-AMOUNT (AC-5): auth.value < accepted.amount -> INVALID_AMOUNT 400', async () => {
      const mod = await import('../../chains/kite.js');
      // Fixture signs with value=1000, then we bump accepted.amount to 5000.
      const params = await makeValidVerifyParams({ acceptedAmount: '5000' });
      const result = await mod.kiteTestnetAdapter.verify(params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_AMOUNT');
        expect(result.error.http).toBe(400);
      }
    });

    it('T-V-NORMALIZE-FAIL (AC-6): high-s signature -> INVALID_SIGNATURE (recover NOT called)', async () => {
      const mod = await import('../../chains/kite.js');
      // High-s: s occupies the upper half of n. Using all-0xff for s is > n/2
      // (and also out of range, but normalizeSignature rejects it before the
      // range check hits). The v byte 1b (27) is valid — the failure is s.
      const highS = `0x${'11'.repeat(32)}${'ff'.repeat(32)}1b` as `0x${string}`;
      const params = await makeValidVerifyParams({ signature: highS });
      const result = await mod.kiteTestnetAdapter.verify(params);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_SIGNATURE');
        expect(result.error.http).toBe(401);
      }
    });

    it('T-METADATA-TOKENS (AC-18): kiteTestnetAdapter.metadata.tokens has exactly 1 USDC entry with env address', async () => {
      const mod = await import('../../chains/kite.js');
      const tokens = mod.kiteTestnetAdapter.metadata.tokens;
      expect(tokens.length).toBe(1);
      const t = tokens[0];
      expect(t).toBeDefined();
      if (t) {
        expect(t.address.toLowerCase()).toBe(TEST_USDC.toLowerCase());
        expect(t.symbol).toBe('USDC');
        expect(t.decimals).toBe(6);
        expect(t.eip712Name).toBe('USD Coin');
        expect(t.eip712Version).toBe('2');
      }
    });
  });
});

describe('avalanche.ts adapter', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('has chainId 43113 and testnet network', async () => {
    const mod = await import('../../chains/avalanche.js');
    expect(mod.avalancheFujiAdapter.metadata.chainId).toBe(43113);
    expect(mod.avalancheFujiAdapter.metadata.network).toBe('testnet');
    expect(mod.avalancheFujiAdapter.metadata.networkId).toBe('eip155:43113');
  });

  it('throws ChainAdapterInitError when AVALANCHE_FUJI_RPC_URL missing', async () => {
    delete process.env['AVALANCHE_FUJI_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(/ChainAdapterInitError/);
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(/AVALANCHE_FUJI_RPC_URL/);
  });

  it('exposes USDC Fuji in tokens list with decimals 6', async () => {
    const mod = await import('../../chains/avalanche.js');
    const tokens = mod.avalancheFujiAdapter.metadata.tokens;
    expect(tokens).toHaveLength(1);
    const usdc = tokens[0];
    expect(usdc).toBeDefined();
    if (usdc) {
      expect(usdc.symbol).toBe('USDC');
      expect(usdc.decimals).toBe(6);
    }
  });

  it('verify returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.verify({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });

  it('settle returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.settle({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });
});

// ─── WFAC-41 — circuit breaker integration (T-ADAPT-CB-*) ─────────────────
// These tests exercise the breaker wrap added in W3 to kite.ts / avalanche.ts
// without going through the ChainRegistry — they import the adapter modules
// directly (same pattern as above) and cast to `any` to reach the private
// `_breaker` instance when needed to force state transitions quickly.

const CB_ENV_KEYS = [
  'CB_ENABLED',
  'CB_FAILURE_THRESHOLD',
  'CB_ROLLING_WINDOW_MS',
  'CB_RESET_TIMEOUT_MS',
] as const;

/* eslint-disable security/detect-object-injection -- tuple of hardcoded env-var names, not user input. */
function snapshotCbEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of CB_ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreCbEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of CB_ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}
/* eslint-enable security/detect-object-injection */

describe('WFAC-41 — circuit breaker integration on ChainAdapters', () => {
  let envSnapshot: Record<string, string | undefined>;
  let cbSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    cbSnapshot = snapshotCbEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    // WFAC-50 — required for kite.ts module load (readUsdcAddress) + wallet singleton.
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    restoreCbEnv(cbSnapshot);
    vi.resetModules();
  });

  it('T-ADAPT-CB-1 (AC-9): kiteTestnetAdapter exposes getBreakerState() returning "CLOSED" by default', async () => {
    const mod = await import('../../chains/kite.js');
    expect(typeof mod.kiteTestnetAdapter.getBreakerState).toBe('function');
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
  });

  it('T-ADAPT-CB-2 (AC-1/AC-2): verify returns CHAIN_UNAVAILABLE 503 when breaker is OPEN', async () => {
    // Force tiny thresholds so the breaker trips quickly.
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    vi.resetModules();
    const mod = await import('../../chains/kite.js');

    // Reach the private breaker via cast. Feed N business failures to open it.
    const adapter = mod.kiteTestnetAdapter as unknown as {
      _breaker: {
        recordBusinessFailure: (r: string) => void;
        getState: () => string;
      };
      verify: (p: unknown) => Promise<{
        ok: boolean;
        error: { code: string; http: number; retryAfterMs?: number };
      }>;
    };
    for (let i = 0; i < 25; i += 1) adapter._breaker.recordBusinessFailure('SIMULATION_FAILED');
    await new Promise((r) => setImmediate(r));
    expect(adapter._breaker.getState()).toBe('OPEN');

    const result = await adapter.verify({} as never);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CHAIN_UNAVAILABLE',
        http: 503,
      },
    });
    expect(result.error.retryAfterMs).toBeGreaterThan(0);
  });

  it('T-ADAPT-CB-3 (AC-7 independence): opening kite breaker does not affect avalanche', async () => {
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    vi.resetModules();
    const kiteMod = await import('../../chains/kite.js');
    const avaxMod = await import('../../chains/avalanche.js');

    const kiteAdapter = kiteMod.kiteTestnetAdapter as unknown as {
      _breaker: { recordBusinessFailure: (r: string) => void; getState: () => string };
      getBreakerState: () => string;
    };
    for (let i = 0; i < 25; i += 1) kiteAdapter._breaker.recordBusinessFailure('SIMULATION_FAILED');
    await new Promise((r) => setImmediate(r));

    expect(kiteMod.kiteTestnetAdapter.getBreakerState!()).toBe('OPEN');
    expect(avaxMod.avalancheFujiAdapter.getBreakerState!()).toBe('CLOSED');
  });

  it('T-ADAPT-CB-4 (AC-13): _verifyRaw returning SIMULATION_FAILED unwraps cleanly via BusinessFailureError (AR-BLQ-ALTO-1)', async () => {
    const mod = await import('../../chains/kite.js');
    const adapter = mod.kiteTestnetAdapter as unknown as {
      _verifyRaw: (p: unknown) => Promise<unknown>;
      verify: (
        p: unknown,
      ) => Promise<{ ok: boolean; error: { code: string; message: string; http: number } }>;
    };

    // Override _verifyRaw to emit SIMULATION_FAILED once. The AR-BLQ-ALTO-1
    // fix moves AC-13 accounting into the outer verify() wrapper: it throws
    // a BusinessFailureError from inside _breaker.execute when the raw result
    // is SIMULATION_FAILED / TRANSACTION_FAILED, then unwraps err.result on
    // the outer catch. The caller still sees the original AdapterResult.
    vi.spyOn(adapter, '_verifyRaw').mockImplementationOnce(async () => ({
      ok: false as const,
      error: { code: 'SIMULATION_FAILED' as const, message: 'x', http: 500 },
    }));

    const result = await adapter.verify({} as never);
    // Caller sees the UNWRAPPED business failure result, NOT a thrown error.
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SIMULATION_FAILED', http: 500 },
    });
  });

  it('T-ADAPT-CB-5 (AC-6): CB_ENABLED=false makes the breaker a no-op passthrough', async () => {
    process.env['CB_ENABLED'] = 'false';
    vi.resetModules();
    const mod = await import('../../chains/kite.js');
    const adapter = mod.kiteTestnetAdapter as unknown as {
      _breaker: { recordBusinessFailure: (r: string) => void; getState: () => string | undefined };
      verify: (p: VerifyParams) => Promise<{ ok: boolean; error?: { code: string } }>;
    };
    // Feed plenty of failures — with CB disabled they are no-ops.
    for (let i = 0; i < 200; i += 1) adapter._breaker.recordBusinessFailure('SIMULATION_FAILED');
    await new Promise((r) => setImmediate(r));

    // AR-BLQ-BAJO-1: disabled breaker reports `undefined` (not 'CLOSED') so
    // the /supported route omits the breakerState field for this chain.
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBeUndefined();
    // WFAC-50: with a valid signed VerifyParams, verify returns a normal result
    // (not CHAIN_UNAVAILABLE). The happy path proves passthrough — CB is not
    // intercepting, and the real EIP-712 recovery flow runs to completion.
    const params = await makeValidVerifyParams();
    const result = await adapter.verify(params);
    expect(result.ok).toBe(true);
  });

  it('T-ADAPT-CB-6 (AC-13 real flow — AR-BLQ-ALTO-1): N consecutive SIMULATION_FAILED via verify() flow trips the breaker', async () => {
    // Tune thresholds so a handful of failures crosses the 50% sampling
    // threshold comfortably. minimumRps is derived from failureThreshold /
    // (rollingWindowMs/1000) inside ChainCircuitBreaker; with 2/1s = 2 rps
    // floor and 25 consecutive failures we easily cross both.
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    process.env['CB_ENABLED'] = 'true';
    vi.resetModules();
    const mod = await import('../../chains/kite.js');
    const adapter = mod.kiteTestnetAdapter as unknown as {
      _verifyRaw: (p: unknown) => Promise<unknown>;
      _breaker: { getState: () => string | undefined };
      verify: (p: unknown) => Promise<{ ok: boolean; error: { code: string; http: number } }>;
    };

    // Mock _verifyRaw to ALWAYS return SIMULATION_FAILED. Every verify() call
    // flows through the real outer wrapper → throws BusinessFailureError
    // inside cockatiel's execute → counts as a clean failure → eventually
    // SamplingBreaker opens.
    vi.spyOn(adapter, '_verifyRaw').mockImplementation(async () => ({
      ok: false as const,
      error: { code: 'SIMULATION_FAILED' as const, message: 'simulated', http: 500 },
    }));

    // Before: breaker is CLOSED and verify returns the unwrapped business
    // failure as SIMULATION_FAILED (not CHAIN_UNAVAILABLE yet).
    expect(adapter._breaker.getState()).toBe('CLOSED');
    const firstResult = await adapter.verify({} as never);
    expect(firstResult.error.code).toBe('SIMULATION_FAILED');

    // Drive many more calls — each one throws BusinessFailureError inside
    // the breaker and is counted as a failure. After enough, the breaker
    // trips OPEN (AR-BLQ-ALTO-1 fix: previously the +1success/+1failure
    // pattern kept ratio at 50% and never exceeded the 0.5 threshold).
    for (let i = 0; i < 30; i += 1) {
      await adapter.verify({} as never).catch(() => {});
    }
    await new Promise((r) => setImmediate(r));

    expect(adapter._breaker.getState()).toBe('OPEN');

    // Subsequent call short-circuits with CHAIN_UNAVAILABLE 503 (breaker OPEN).
    const openResult = await adapter.verify({} as never);
    expect(openResult).toMatchObject({
      ok: false,
      error: { code: 'CHAIN_UNAVAILABLE', http: 503 },
    });
  });
});
