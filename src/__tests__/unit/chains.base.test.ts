/**
 * WKH-105 (BASE-02) — Base chain adapter tests.
 *
 * Pattern mirrors `chain-adapter.test.ts` (Avalanche mainnet describe block):
 *   - per-test env snapshot + vi.resetModules() so each test gets a clean
 *     module graph (the adapter is built once at module-load via IIFE).
 *   - happy-path EIP-712 verify uses a REAL signature signed by Hardhat
 *     account #0 against the Base Sepolia USDC domain (name='USDC' v2 —
 *     verified on-chain via `cast call 0x036C…F7e "name()(string)"`).
 *   - settle happy-path uses vi.spyOn() on getPublicClient/getWalletClient
 *     to inject stub viem clients — NO real RPC calls.
 *   - NETWORK_UNAVAILABLE is exercised via T-ADAPT-CB-* pattern in the
 *     existing chain-adapter.test.ts; here we only check that the breaker
 *     wrapper is wired (CB integration parity).
 *
 * Refs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 of WKH-105 work-item.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient, WalletClient, Chain } from 'viem';
import type { VerifyParams } from '../../chains/types.js';

const ENV_KEYS = [
  'BASE_SEPOLIA_RPC_URL',
  'BASE_MAINNET_RPC_URL',
  'BASE_SEPOLIA_ENABLED',
  'BASE_MAINNET_ENABLED',
  'OPERATOR_PRIVATE_KEY',
] as const;

// USDC addresses verified against the live Base Sepolia and Base Mainnet
// USDC deployments (Circle docs + `cast call ... DOMAIN_SEPARATOR()` 2026-05-19).
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`;

// Hardhat account #0 — used to sign EIP-712 fixtures.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

/* eslint-disable security/detect-object-injection -- `k` is constrained to the
 * const tuple ENV_KEYS literal (hardcoded env-var names). Not user input. */
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

function makeMockClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const operatorAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: operatorAccount,
    writeContract: vi.fn(),
    chain: {} as Chain,
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}

/**
 * Build a VerifyParams object with a REAL EIP-712 signature signed by
 * Hardhat account #0 against the Base Sepolia USDC domain (name='USDC' v2,
 * chainId=84532, verifyingContract=BASE_SEPOLIA_USDC).
 */
async function makeBaseSepoliaVerifyParams(overrides?: {
  message?: Partial<{
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
  }>;
  acceptedAmount?: string;
}): Promise<VerifyParams> {
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
  // Base Sepolia USDC contract: name='USDC' (NOT 'USD Coin'), version='2'.
  // Verified via `cast call 0x036C…F7e "name()(string)" --rpc-url https://sepolia.base.org`
  // on 2026-05-19.
  const domain = {
    name: 'USDC',
    version: '2',
    chainId: 84532,
    verifyingContract: BASE_SEPOLIA_USDC,
  };
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const signature = await account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: baseMessage,
  });
  return {
    x402Version: 2,
    resource: { url: 'https://example.com' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: overrides?.acceptedAmount ?? '1000',
      asset: BASE_SEPOLIA_USDC,
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

// ─── Default behavior: both Base adapters OFF when flags absent ──────────
describe('base.ts adapters — default OFF (CD-2, AC-5)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    // Wallet singleton needs SOMETHING valid even though Base adapters
    // are OFF — `kite.ts` also needs its testnet RPC at module-load time
    // (it always builds the testnet adapter). Clear all Base envs.
    delete process.env['BASE_SEPOLIA_ENABLED'];
    delete process.env['BASE_MAINNET_ENABLED'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['BASE_MAINNET_RPC_URL'];
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('baseSepoliaAdapter is null when BASE_SEPOLIA_ENABLED is missing (default opt-out — CD-2, AC-5)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).toBeNull();
  });

  it('baseMainnetAdapter is null when BASE_MAINNET_ENABLED is missing (default opt-out — CD-5)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).toBeNull();
  });

  it('baseSepoliaAdapter is null when BASE_SEPOLIA_ENABLED=false (explicit opt-out)', async () => {
    process.env['BASE_SEPOLIA_ENABLED'] = 'false';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://sepolia.base.org';
    vi.resetModules();
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).toBeNull();
  });

  it('baseSepoliaAdapter is null when ENABLED=true but BASE_SEPOLIA_RPC_URL missing', async () => {
    process.env['BASE_SEPOLIA_ENABLED'] = 'true';
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    vi.resetModules();
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).toBeNull();
  });

  it('baseMainnetAdapter is null when ENABLED=true but BASE_MAINNET_RPC_URL missing', async () => {
    process.env['BASE_MAINNET_ENABLED'] = 'true';
    delete process.env['BASE_MAINNET_RPC_URL'];
    vi.resetModules();
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).toBeNull();
  });
});

// ─── Base Sepolia adapter (84532) ─────────────────────────────────────────
describe('base.ts — baseSepoliaAdapter (chainId 84532)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['BASE_SEPOLIA_ENABLED'] = 'true';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://sepolia.base.org';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('has chainId 84532 and testnet network (AC-4)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    expect(mod.baseSepoliaAdapter!.metadata.chainId).toBe(84532);
    expect(mod.baseSepoliaAdapter!.metadata.network).toBe('testnet');
    expect(mod.baseSepoliaAdapter!.metadata.networkId).toBe('eip155:84532');
    expect(mod.baseSepoliaAdapter!.metadata.name).toBe('Base Sepolia');
  });

  it('exposes Circle USDC Sepolia token (6 decimals, eip712 USDC v2)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    const tokens = mod.baseSepoliaAdapter!.metadata.tokens;
    expect(tokens).toHaveLength(1);
    const usdc = tokens[0]!;
    expect(usdc.address.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
    expect(usdc.symbol).toBe('USDC');
    expect(usdc.decimals).toBe(6);
    // CRITICAL: Base Sepolia USDC uses 'USDC' as EIP-712 domain name
    // (NOT 'USD Coin'). Verified on-chain 2026-05-19.
    expect(usdc.eip712Name).toBe('USDC');
    expect(usdc.eip712Version).toBe('2');
  });

  it('uses ETH as native currency (Base is an Ethereum L2)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    expect(mod.baseSepoliaAdapter!.metadata.nativeCurrency).toEqual({
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    });
  });

  it('exposes circuit breaker (CB integration parity — AC-3 NETWORK_UNAVAILABLE wired)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    expect(typeof mod.baseSepoliaAdapter!.getBreakerState).toBe('function');
    expect(mod.baseSepoliaAdapter!.getBreakerState!()).toBe('CLOSED');
  });

  // AC-5: requests with a different network MUST be rejected with NETWORK_MISMATCH.
  it('verify rejects mismatched network (AC-5: NETWORK_MISMATCH)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    const result = await mod.baseSepoliaAdapter!.verify({
      x402Version: 2,
      resource: { url: 'https://example.com' },
      accepted: {
        scheme: 'exact',
        network: 'eip155:1', // wrong — not 84532
        amount: '1000000',
        asset: BASE_SEPOLIA_USDC,
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: 'eip3009' },
      },
      payload: {
        signature: ('0x' + '00'.repeat(65)) as `0x${string}`,
        authorization: {
          from: '0x0000000000000000000000000000000000000002',
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000',
          validAfter: '0',
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: ('0x' + '00'.repeat(32)) as `0x${string}`,
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK_MISMATCH');
  });

  it('settle rejects expired authorization', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    const result = await mod.baseSepoliaAdapter!.settle({
      x402Version: 2,
      resource: { url: 'https://example.com' },
      accepted: {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '1000000',
        asset: BASE_SEPOLIA_USDC,
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: 'eip3009' },
      },
      payload: {
        signature: ('0x' + '00'.repeat(65)) as `0x${string}`,
        authorization: {
          from: '0x0000000000000000000000000000000000000002',
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000',
          validAfter: '0',
          validBefore: '1', // expired
          nonce: ('0x' + '00'.repeat(32)) as `0x${string}`,
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
  });

  // AC-1: happy path verify with REAL EIP-712 signature.
  it('verify returns ok with recovered client (AC-1 happy path)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    const params = await makeBaseSepoliaVerifyParams();
    const result = await mod.baseSepoliaAdapter!.verify(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
      expect(result.amount).toBe('1000');
      expect(result.asset.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
      expect(result.network).toBe('eip155:84532');
    }
  });

  // AC-2: settle happy path with mocked viem clients.
  it('settle returns transactionHash + blockNumber on success (AC-2 happy path)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    const adapter = mod.baseSepoliaAdapter!;
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(adapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(adapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({
      request: { __opaque: 1 } as never,
      result: undefined as never,
    });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: 'success',
      blockNumber: 1234n,
      transactionHash: TEST_TX_HASH,
    } as never);

    const params = await makeBaseSepoliaVerifyParams();
    const result = await adapter.settle(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transactionHash).toBe(TEST_TX_HASH);
      expect(result.blockNumber).toBe(1234);
      expect(result.amount).toBe('1000');
      expect(result.from.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
      expect(result.to.toLowerCase()).toBe(TEST_PAY_TO.toLowerCase());
      expect(result.asset.toLowerCase()).toBe(BASE_SEPOLIA_USDC.toLowerCase());
    }
  });

  // AC-3: RPC failure on simulate -> SIMULATION_FAILED (HTTP 500 from inner
  // _settleRaw). The outer wrapper translates it via BusinessFailureError.
  // After breaker opens, subsequent calls yield CHAIN_UNAVAILABLE 503 — but
  // for the first failure the response is the raw SIMULATION_FAILED.
  it('settle returns SIMULATION_FAILED when RPC simulate throws (AC-3 path 1)', async () => {
    const mod = await import('../../chains/base.js');
    const adapter = mod.baseSepoliaAdapter!;
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(adapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(adapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await adapter.settle(await makeBaseSepoliaVerifyParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SIMULATION_FAILED');
      expect(result.error.http).toBe(500);
    }
    // Defense-in-depth: writeContract MUST NOT run after simulate failure.
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  // AC-3 (continued): when breaker is OPEN, requests get CHAIN_UNAVAILABLE 503.
  it('settle returns CHAIN_UNAVAILABLE 503 when breaker is OPEN (AC-3 path 2 — NETWORK_UNAVAILABLE)', async () => {
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    vi.resetModules();
    const mod = await import('../../chains/base.js');
    const adapter = mod.baseSepoliaAdapter!;
    // Reach the private breaker via cast (same pattern as T-ADAPT-CB-2 in
    // chain-adapter.test.ts:817-848).
    const internal = adapter as unknown as {
      _breaker: {
        recordBusinessFailure: (r: string) => void;
        getState: () => string;
      };
    };
    for (let i = 0; i < 25; i += 1) internal._breaker.recordBusinessFailure('SIMULATION_FAILED');
    await new Promise((r) => setImmediate(r));
    expect(internal._breaker.getState()).toBe('OPEN');

    const params = await makeBaseSepoliaVerifyParams();
    const result = await adapter.settle(params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(result.error.http).toBe(503);
    }

    delete process.env['CB_FAILURE_THRESHOLD'];
    delete process.env['CB_ROLLING_WINDOW_MS'];
  });
});

// ─── Base Mainnet adapter (8453) ──────────────────────────────────────────
describe('base.ts — baseMainnetAdapter (chainId 8453)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['BASE_MAINNET_ENABLED'] = 'true';
    process.env['BASE_MAINNET_RPC_URL'] = 'https://mainnet.base.org';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('has chainId 8453 and mainnet network when enabled', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).not.toBeNull();
    expect(mod.baseMainnetAdapter!.metadata.chainId).toBe(8453);
    expect(mod.baseMainnetAdapter!.metadata.network).toBe('mainnet');
    expect(mod.baseMainnetAdapter!.metadata.networkId).toBe('eip155:8453');
    expect(mod.baseMainnetAdapter!.metadata.name).toBe('Base');
  });

  it('exposes native Circle USDC (6 decimals, eip712 USD Coin v2 — mainnet uses different name from sepolia)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).not.toBeNull();
    const tokens = mod.baseMainnetAdapter!.metadata.tokens;
    expect(tokens).toHaveLength(1);
    const usdc = tokens[0]!;
    expect(usdc.address.toLowerCase()).toBe(BASE_MAINNET_USDC.toLowerCase());
    expect(usdc.symbol).toBe('USDC');
    expect(usdc.decimals).toBe(6);
    // Base MAINNET USDC: name='USD Coin' (matches Avalanche / Kite Mainnet).
    // Verified via `cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    // "name()(string)" --rpc-url https://mainnet.base.org` on 2026-05-19.
    expect(usdc.eip712Name).toBe('USD Coin');
    expect(usdc.eip712Version).toBe('2');
  });

  it('uses Basescan as block explorer', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).not.toBeNull();
    expect(mod.baseMainnetAdapter!.metadata.blockExplorer).toBe('https://basescan.org');
  });

  it('exposes circuit breaker (CB integration parity)', async () => {
    const mod = await import('../../chains/base.js');
    expect(mod.baseMainnetAdapter).not.toBeNull();
    expect(typeof mod.baseMainnetAdapter!.getBreakerState).toBe('function');
    expect(mod.baseMainnetAdapter!.getBreakerState!()).toBe('CLOSED');
  });

  it('Sepolia and Mainnet adapters are independent (toggling one does not affect the other)', async () => {
    process.env['BASE_SEPOLIA_ENABLED'] = 'true';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://sepolia.base.org';
    vi.resetModules();
    const mod = await import('../../chains/base.js');
    expect(mod.baseSepoliaAdapter).not.toBeNull();
    expect(mod.baseMainnetAdapter).not.toBeNull();
    expect(mod.baseSepoliaAdapter!.metadata.chainId).toBe(84532);
    expect(mod.baseMainnetAdapter!.metadata.chainId).toBe(8453);
  });
});

// ─── WFAC-AUDIT AC-4 — new defense-in-depth checks (T11-T15) ──────────────
// amount>0 / payTo==to / validAfter, in the BaseEip3009Adapter base class.
// Semantics identical to methods/eip3009/verify.ts (CD-6 read-only).
describe('base.ts — WFAC-AUDIT AC-4 checks (T11-T15)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['BASE_SEPOLIA_ENABLED'] = 'true';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://sepolia.base.org';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  // T11 — amount must be > 0.
  it('T11: _verifyRaw rejects accepted.amount = 0 → INVALID_AMOUNT 400', async () => {
    const mod = await import('../../chains/base.js');
    const params = await makeBaseSepoliaVerifyParams({ acceptedAmount: '0' });
    const result = await mod.baseSepoliaAdapter!.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_AMOUNT');
      expect(result.error.http).toBe(400);
      expect(result.error.message).toBe('Accepted amount must be greater than zero');
    }
  });

  // T12 — payTo must equal authorization.to.
  it('T12: _verifyRaw rejects authorization.to != accepted.payTo → INVALID_RECEIVER 400', async () => {
    const mod = await import('../../chains/base.js');
    // Sign with a `to` that differs from accepted.payTo (TEST_PAY_TO).
    const params = await makeBaseSepoliaVerifyParams({
      message: { to: '0x2222222222222222222222222222222222222222' as `0x${string}` },
    });
    const result = await mod.baseSepoliaAdapter!.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_RECEIVER');
      expect(result.error.http).toBe(400);
      expect(result.error.message).toBe('Receiver does not match payTo');
    }
  });

  // T13 — validAfter in the future → not yet valid (distinct from expired).
  it('T13: _verifyRaw rejects validAfter in the future → EXPIRED_AUTHORIZATION "not yet valid" 400', async () => {
    const mod = await import('../../chains/base.js');
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeBaseSepoliaVerifyParams({
      message: {
        validAfter: BigInt(nowSec + 3600), // not yet valid
        validBefore: BigInt(nowSec + 7200),
      },
    });
    const result = await mod.baseSepoliaAdapter!.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
      expect(result.error.http).toBe(400);
      // Distinct from validBefore-expired ('Authorization expired').
      expect(result.error.message).toBe('Authorization not yet valid');
    }
  });

  // T14 — the same 3 checks gate _settleRaw BEFORE simulate (no gas spent).
  it('T14: _settleRaw rejects amount=0 / to!=payTo / future-validAfter BEFORE simulate', async () => {
    const mod = await import('../../chains/base.js');
    const adapter = mod.baseSepoliaAdapter!;
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(adapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(adapter, 'getWalletClient').mockReturnValue(walletClient);

    // amount = 0 → INVALID_AMOUNT.
    const r1 = await adapter.settle(await makeBaseSepoliaVerifyParams({ acceptedAmount: '0' }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_AMOUNT');

    // to != payTo → INVALID_RECEIVER.
    const r2 = await adapter.settle(
      await makeBaseSepoliaVerifyParams({
        message: { to: '0x2222222222222222222222222222222222222222' as `0x${string}` },
      }),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INVALID_RECEIVER');

    // future validAfter → EXPIRED_AUTHORIZATION 'not yet valid'.
    const nowSec = Math.floor(Date.now() / 1000);
    const r3 = await adapter.settle(
      await makeBaseSepoliaVerifyParams({
        message: { validAfter: BigInt(nowSec + 3600), validBefore: BigInt(nowSec + 7200) },
      }),
    );
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('EXPIRED_AUTHORIZATION');
      expect(r3.error.message).toBe('Authorization not yet valid');
    }

    // NONE of these reached the chain — simulate/write never called.
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  // T15 — fully valid params still pass (regression — checks only reject more).
  it('T15: _verifyRaw success path with all fields valid still passes (regression)', async () => {
    const mod = await import('../../chains/base.js');
    const result = await mod.baseSepoliaAdapter!.verify(await makeBaseSepoliaVerifyParams());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
    }
  });
});
