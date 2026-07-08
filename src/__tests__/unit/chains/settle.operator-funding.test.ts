/**
 * WKH-148 — operator funding pre-check in the REAL settle() path.
 *
 * Drives `kiteTestnetAdapter.settle()` with viem clients mocked and asserts the
 * READ-ONLY `getBalance` pre-check added in `_settleRaw` BEFORE
 * runExclusive/simulateContract:
 *
 *   - OF-1 (AC-1/AC-6): balance < threshold → OPERATOR_FUNDING_LOW 503, and
 *     NEITHER simulateContract NOR writeContract is called (no chain touch).
 *   - OF-2 (AC-2/CD-4): the funding-low warning is logged server-side with
 *     chainId + operator address + balance + threshold; the HTTP body stays
 *     PII-free (no address/balance).
 *   - OF-3 (AC-3/CD-5): balance >= threshold → settle proceeds exactly as today
 *     (simulate→write→receipt→success).
 *   - OF-4 (AC-5/CD-6): getBalance throws a TRANSPORT error → SIMULATION_FAILED
 *     (NOT funding-low) and the breaker counts it (OPENs) — WKH-154 preserved.
 *   - OF-5 (AC-5/CD-6): getBalance throws a BUSINESS error → SIMULATION_FAILED,
 *     breaker stays CLOSED (business does not count).
 *   - OF-6 (AC-4): with OPERATOR_MIN_BALANCE_WEI UNSET, the default 0.01 token
 *     (1e16 wei) is applied (0.005 → low, 0.02 → ok).
 *   - OF-7 (AC-4 CD-3): an explicit OPERATOR_MIN_BALANCE_WEI override is honored.
 *   - OF-9 (DT-7 robustness): ~30 CONSECUTIVE funding-low settles keep the
 *     breaker CLOSED — guards against a future regression that adds
 *     OPERATOR_FUNDING_LOW to the set of codes counted toward the breaker
 *     (mirror of OF-4/OF-5, which loop to prove transport→OPEN vs business→CLOSED).
 *
 * Deterministic + fast: NO real RPC, NO real settlement. Mirrors
 * settle.breaker-classification.test.ts (env snapshot + vi.resetModules per test).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Chain, PublicClient, WalletClient } from 'viem';
import type { Logger } from 'pino';
import type * as KiteModule from '../../../chains/kite.js';
import type { VerifyParams } from '../../../chains/types.js';

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'KITE_MAINNET_ENABLED',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
  'OPERATOR_MIN_BALANCE_WEI',
  'CB_FAILURE_THRESHOLD',
  'CB_ROLLING_WINDOW_MS',
  'CB_ENABLED',
] as const;

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
// The operator account derived from TEST_PRIVATE_KEY (used to assert the log).
const OPERATOR_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

/* eslint-disable security/detect-object-injection -- ENV_KEYS is a fixed literal tuple, not attacker-controlled. */
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

function makeMockClients(): { publicClient: PublicClient; walletClient: WalletClient } {
  const operatorAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = {
    getBalance: vi.fn(),
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

/** A logger stub capturing warn calls (mirrors the pino Logger surface). */
function makeMockLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const noop = vi.fn();
  const logger = {
    warn,
    info: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, warn };
}

async function makeValidParams(): Promise<VerifyParams> {
  const { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } = await import('../../../chains/abi/fiat-token.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const baseMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
  };
  const domain = { name: 'PYUSD', version: '1', chainId: 2368, verifyingContract: TEST_USDC };
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
      network: 'eip155:2368',
      amount: '1000',
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
  } as unknown as VerifyParams;
}

/** Same-account contention: a BUSINESS outcome (must not count to breaker). */
function businessError(): Error {
  return Object.assign(new Error('gas required exceeds allowance (24468/11800/62584)'), {
    name: 'EstimateGasExecutionError',
  });
}
/** Genuine TRANSPORT failure: RPC returned HTTP 503 (must count to breaker). */
function transportError(): Error {
  return Object.assign(new Error('Service Unavailable'), {
    name: 'HttpRequestError',
    status: 503,
  });
}

/** Wire a mocked public+wallet client into the kite adapter. */
function wire(
  mod: typeof KiteModule,
  clients: { publicClient: PublicClient; walletClient: WalletClient },
): void {
  vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(clients.publicClient);
  vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(clients.walletClient);
}

/** Make simulate→write→receipt succeed (for the happy path). */
function mockHappyOnChain(clients: {
  publicClient: PublicClient;
  walletClient: WalletClient;
}): void {
  vi.mocked(clients.publicClient.simulateContract).mockResolvedValue({
    request: {} as never,
    result: undefined as never,
  });
  vi.mocked(clients.walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
  vi.mocked(clients.publicClient.waitForTransactionReceipt).mockResolvedValue({
    status: 'success',
    blockNumber: 7n,
    transactionHash: TEST_TX_HASH,
  } as never);
}

describe('WKH-148 — operator funding pre-check (read-only, before simulate)', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['KITE_MAINNET_ENABLED'] = 'false';
    process.env['OPERATOR_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
    process.env['KITE_USDC_ADDRESS'] = TEST_USDC;
    process.env['CB_FAILURE_THRESHOLD'] = '2';
    process.env['CB_ROLLING_WINDOW_MS'] = '1000';
    process.env['CB_ENABLED'] = 'true';
    // Default: leave OPERATOR_MIN_BALANCE_WEI UNSET so most tests exercise the
    // hardcoded 0.01-token default (OF-6). Individual tests override it.
    delete process.env['OPERATOR_MIN_BALANCE_WEI'];
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  // ── OF-1 (AC-1/AC-6): low balance → OPERATOR_FUNDING_LOW, no chain touch ────
  it('OF-1 (AC-1/AC-6): balance < threshold → OPERATOR_FUNDING_LOW 503, no simulate/write', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    // 0.005 token < 0.01 default.
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(5_000_000_000_000_000n);

    const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('OPERATOR_FUNDING_LOW');
      expect(r.error.http).toBe(503);
    }
    expect(clients.publicClient.getBalance).toHaveBeenCalledTimes(1);
    // AC-6 / AC-1 — read-only: the chain is never simulated nor written.
    expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    // DT-7 — funding-low bypasses the breaker (resolved outcome, not a failure).
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
  });

  // ── OF-2 (AC-2/CD-4): actionable detail logged, PII-free body ──────────────
  it('OF-2 (AC-2/CD-4): logs chain+address+balance+threshold; body carries no PII', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    const { logger, warn } = makeMockLogger();
    mod.kiteTestnetAdapter.setLogger!(logger);
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(1_000_000_000_000_000n); // 0.001

    const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());

    expect(warn).toHaveBeenCalledTimes(1);
    const [logObj] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(logObj).toMatchObject({
      event: 'operator_funding_low',
      chainId: 2368,
      operator: OPERATOR_ADDRESS,
      balanceWei: '1000000000000000',
      thresholdWei: '10000000000000000',
    });
    // CD-4 — the HTTP body message must NOT leak the address or balance.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).not.toContain(OPERATOR_ADDRESS);
      expect(r.error.message).not.toContain('1000000000000000');
      expect(JSON.stringify(r)).not.toContain(OPERATOR_ADDRESS);
    }
  });

  // ── OF-3 (AC-3/CD-5): healthy balance → settle proceeds identically ────────
  it('OF-3 (AC-3/CD-5): balance >= threshold → settle proceeds (simulate→write→success)', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(10n ** 20n); // 100 tokens
    mockHappyOnChain(clients);

    const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settled).toBe(true);
      expect(r.transactionHash).toBe(TEST_TX_HASH);
    }
    expect(clients.publicClient.simulateContract).toHaveBeenCalledTimes(1);
    expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  // ── OF-4 (AC-5/CD-6): getBalance transport failure → classifier, not low ───
  it('OF-4 (AC-5/CD-6): getBalance TRANSPORT throw → SIMULATION_FAILED, breaker counts (OPEN)', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    vi.mocked(clients.publicClient.getBalance).mockRejectedValue(transportError());

    const params = await makeValidParams();
    let last;
    for (let i = 0; i < 30; i += 1) {
      last = await mod.kiteTestnetAdapter.settle(params);
    }
    await new Promise((res) => setImmediate(res));

    expect(last?.ok).toBe(false);
    if (last && !last.ok) {
      // NOT funding-low — a real read failure is classified, never assumed low.
      expect(last.error.code).not.toBe('OPERATOR_FUNDING_LOW');
    }
    // Transport counts → breaker OPENs (WKH-154 invariant preserved).
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('OPEN');
    // The read failed before any simulate/write.
    expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
  });

  // ── OF-5 (AC-5/CD-6): getBalance business failure → does not count ─────────
  it('OF-5 (AC-5/CD-6): getBalance BUSINESS throw → SIMULATION_FAILED, breaker stays CLOSED', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    vi.mocked(clients.publicClient.getBalance).mockRejectedValue(businessError());

    const params = await makeValidParams();
    let last;
    for (let i = 0; i < 30; i += 1) {
      last = await mod.kiteTestnetAdapter.settle(params);
    }
    await new Promise((res) => setImmediate(res));

    expect(last?.ok).toBe(false);
    if (last && !last.ok) {
      expect(last.error.code).toBe('SIMULATION_FAILED');
      expect(last.error.code).not.toBe('OPERATOR_FUNDING_LOW');
    }
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
  });

  // ── OF-6 (AC-4): default 0.01 token applied when env is UNSET ──────────────
  it('OF-6 (AC-4): with OPERATOR_MIN_BALANCE_WEI unset, default 0.01 token (1e16) applies', async () => {
    // env deliberately unset in beforeEach.
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);

    // 0.02 token (2e16) >= 0.01 default → proceeds.
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(20_000_000_000_000_000n);
    mockHappyOnChain(clients);
    const ok = await mod.kiteTestnetAdapter.settle(await makeValidParams());
    expect(ok.ok).toBe(true);

    // 0.009 token (9e15) < 0.01 default → funding-low.
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(9_000_000_000_000_000n);
    const low = await mod.kiteTestnetAdapter.settle(await makeValidParams());
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe('OPERATOR_FUNDING_LOW');
  });

  // ── OF-7 (AC-4/CD-3): explicit override honored ───────────────────────────
  it('OF-7 (AC-4/CD-3): explicit OPERATOR_MIN_BALANCE_WEI override is honored', async () => {
    // 100 tokens threshold; even a 10-token balance is "low".
    process.env['OPERATOR_MIN_BALANCE_WEI'] = '100000000000000000000';
    vi.resetModules();
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(10n ** 19n); // 10 tokens

    const r = await mod.kiteTestnetAdapter.settle(await makeValidParams());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OPERATOR_FUNDING_LOW');
    expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
  });

  // ── OF-9 (DT-7 robustness): N consecutive funding-low never open the breaker ─
  it('OF-9 (DT-7): 30 CONSECUTIVE funding-low settles keep the breaker CLOSED', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    // Persistently starved operator: 0.001 token (1e15) < 0.01 default on EVERY
    // call — so every settle short-circuits to OPERATOR_FUNDING_LOW.
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(1_000_000_000_000_000n);

    const params = await makeValidParams();
    // CB_FAILURE_THRESHOLD = 2 (beforeEach): if funding-low were counted as a
    // chain failure, the breaker would trip after the 2nd call. 30 >> 2, and the
    // invariant is asserted on EVERY iteration (not just at the end) so a
    // mid-loop trip is caught immediately.
    for (let i = 0; i < 30; i += 1) {
      const r = await mod.kiteTestnetAdapter.settle(params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('OPERATOR_FUNDING_LOW');
      // DT-7 — funding-low is a resolved outcome, never a breaker failure.
      expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
    }
    // Let any deferred breaker bookkeeping settle before the final assertion
    // (mirrors OF-4/OF-5 which await a microtask turn after their loop).
    await new Promise((res) => setImmediate(res));

    // Still CLOSED after 30 funding-low outcomes.
    expect(mod.kiteTestnetAdapter.getBreakerState!()).toBe('CLOSED');
    // Read-only throughout: the chain is never simulated nor written across all
    // 30 calls (one getBalance per settle, no simulate/write ever).
    expect(clients.publicClient.getBalance).toHaveBeenCalledTimes(30);
    expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
  });

  // ── OF-8 (Scope OUT): /verify never runs the funding check (no gas spent) ──
  it('OF-8 (Scope OUT): verify() does NOT call getBalance and never returns funding-low', async () => {
    const mod = await import('../../../chains/kite.js');
    const clients = makeMockClients();
    wire(mod, clients);
    // Even with a starved operator balance, verify must ignore it entirely.
    vi.mocked(clients.publicClient.getBalance).mockResolvedValue(0n);

    const r = await mod.kiteTestnetAdapter.verify(await makeValidParams());

    // verify does off-chain EIP-712 recovery only — it never reads the balance.
    expect(clients.publicClient.getBalance).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});
