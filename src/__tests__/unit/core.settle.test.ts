/**
 * Unit tests for src/core/settle.ts (WFAC-21 W1 orchestrator).
 *
 * CD-15, CD-16 observed: we NEVER import `src/chains/kite.ts` or
 * `src/chains/avalanche.ts` — fake adapters are registered explicitly
 * via `chainRegistry._resetForTesting()` + `chainRegistry.register(...)`.
 *
 * Coverage map:
 *   - T-C1  : settleCore accepts canonical body and returns passthrough.
 *   - T-C2  : settleCore NETWORK_MISMATCH on malformed network 'solana:1'.
 *   - T-C3  : settleCore NETWORK_MISMATCH on 'eip155:0'.
 *   - T-C4  : settleCore NETWORK_MISMATCH on chainId overflow (CD-14).
 *   - T-C5  : settleCore NETWORK_MISMATCH on assetTransferMethod !== eip3009.
 *   - T-C6  : settleCore passthrough of registry error on unregistered chain.
 *   - T-C7  : settleCore passes VerifyRequest → SettleParams unchanged.
 *   - T-C8  : settleCore returns the Result verbatim on adapter success.
 *   - T-C9  : settleCore returns the Result verbatim on adapter error.
 *   - T-C10 : settleCore does NOT catch adapter throws (CD-4 + SDD §DT-8).
 *   - T-C11 : settleCore does NOT invoke adapter.verify.
 *   - T-C12 : settleCore happy path end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settleCore } from '../../core/settle.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type {
  ChainAdapter,
  SettleParams,
  SettlementAdapter,
  VerifyParams,
  VerifyResult,
  SettleResult,
  AdapterResult,
} from '../../chains/types.js';
import type { VerifyRequest } from '../../core/schemas.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

const VALID_BODY: VerifyRequest = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1000000',
    asset: `0x${'11'.repeat(20)}`,
    payTo: `0x${'22'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
  },
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: `0x${'33'.repeat(20)}`,
      to: `0x${'22'.repeat(20)}`,
      value: '1000000',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

const VALID_SETTLE_RESULT = {
  ok: true as const,
  settled: true as const,
  transactionHash: `0x${'de'.repeat(32)}` as `0x${string}`,
  blockNumber: 12345,
  amount: '1000000',
  from: `0x${'33'.repeat(20)}` as `0x${string}`,
  to: `0x${'22'.repeat(20)}` as `0x${string}`,
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
};

function makeFakeAdapter(
  chainIdNum: number,
  settleImpl: (params: SettleParams) => Promise<unknown>,
  verifySpy: ReturnType<typeof vi.fn> = vi.fn(),
): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(chainIdNum),
      name: `fake-${chainIdNum}`,
      network: 'testnet',
      networkId: `eip155:${chainIdNum}`,
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [],
    },
    verify: verifySpy as unknown as ChainAdapter['verify'],
    settle: settleImpl as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: vi.fn(async (): Promise<void> => undefined),
  };
}

// ─── describe block ────────────────────────────────────────────────────────

describe('settleCore (WFAC-21 W1)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-C1: accepts canonical body and returns passthrough settled=true', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    chainRegistry.register(adapter);

    const result = await settleCore(VALID_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settled).toBe(true);
      expect(result.transactionHash).toBe(VALID_SETTLE_RESULT.transactionHash);
      expect(result.blockNumber).toBe(12345);
    }
  });

  it('T-C2: NETWORK_MISMATCH for malformed network "solana:1" (CD-13 heredado)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const bad: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
    };
    const result = await settleCore(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.http).toBe(400);
    }
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T-C3: NETWORK_MISMATCH for "eip155:0" (leading-zero rejection)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const bad: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:0' },
    };
    const result = await settleCore(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
    }
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T-C4: NETWORK_MISMATCH when chainId overflows MAX_SAFE_INTEGER (CD-14)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const bad: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: `eip155:${'9'.repeat(20)}` },
    };
    const result = await settleCore(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toContain('safe integer');
    }
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T-C5: NETWORK_MISMATCH when assetTransferMethod !== "eip3009" (SDD §DT-6)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const bad: VerifyRequest = {
      ...VALID_BODY,
      accepted: {
        ...VALID_BODY.accepted,
        extra: { ...VALID_BODY.accepted.extra, assetTransferMethod: 'permit2' },
      },
    };
    const result = await settleCore(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toContain('eip3009');
    }
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T-C6: passthrough registry error when chainId not registered', async () => {
    // No adapter registered at all; valid network but chainId 999999 is absent.
    const bad: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:999999' },
    };
    const result = await settleCore(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The registry error code comes from chains/registry.ts; no matter
      // the exact code, it must be a well-formed X402 error.
      expect(typeof result.error.code).toBe('string');
      expect(typeof result.error.message).toBe('string');
      expect(typeof result.error.http).toBe('number');
    }
  });

  it('T-C7: passes VerifyRequest → SettleParams reference unchanged to adapter.settle', async () => {
    // The spy MUST declare the parameter it is inspected for: a zero-arg
    // `vi.fn(async () => ...)` types `mock.calls[0]` as the empty tuple, so
    // `calls[0][0]` is `undefined` at the type level and the assertions below
    // would be checking a value TypeScript believes cannot exist.
    const settleSpy = vi.fn(async (_params: SettleParams) => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    await settleCore(VALID_BODY);
    expect(settleSpy).toHaveBeenCalledOnce();
    const firstArg = settleSpy.mock.calls[0]?.[0] as SettleParams;
    expect(firstArg.x402Version).toBe(2);
    expect(firstArg.accepted.network).toBe('eip155:2368');
    expect(firstArg.accepted.amount).toBe('1000000');
    expect(firstArg.accepted.asset).toBe(VALID_BODY.accepted.asset);
    expect(firstArg.accepted.payTo).toBe(VALID_BODY.accepted.payTo);
    expect(firstArg.accepted.extra.assetTransferMethod).toBe('eip3009');
    expect(firstArg.payload.signature).toBe(VALID_BODY.payload.signature);
  });

  it('T-C8: returns the Result verbatim on adapter success', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    chainRegistry.register(adapter);

    const result = await settleCore(VALID_BODY);
    expect(result).toEqual(VALID_SETTLE_RESULT);
  });

  it('T-C9: returns the Result verbatim on adapter error', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    }));
    chainRegistry.register(adapter);

    const result = await settleCore(VALID_BODY);
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 },
    });
  });

  it('T-C10: does NOT catch adapter throws (CD-4 + SDD §DT-8)', async () => {
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('adapter boom');
    });
    chainRegistry.register(adapter);

    await expect(settleCore(VALID_BODY)).rejects.toThrow('adapter boom');
  });

  it('T-C11: does NOT invoke adapter.verify (dispatches to .settle only, R2 regression guard)', async () => {
    const verifySpy = vi.fn();
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy, verifySpy);
    chainRegistry.register(adapter);

    await settleCore(VALID_BODY);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(settleSpy).toHaveBeenCalledOnce();
  });

  it('T-C12: accepts "eip155:2368" fake chain and returns success end-to-end', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    chainRegistry.register(adapter);

    const result = await settleCore(VALID_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settled).toBe(true);
      expect(result.amount).toBe('1000000');
      expect(result.asset).toBe(VALID_BODY.accepted.asset);
      expect(result.from).toBe(VALID_BODY.payload.authorization.from);
      expect(result.to).toBe(VALID_BODY.payload.authorization.to);
    }
  });

  // ─── Step 0 per-settle amount cap — cap the SETTLED amount, not the declared one ─
  //
  // The on-chain transfer moves `authorization.value` (base-adapter.ts:407/617),
  // and verify only guarantees `value >= accepted`. So the cap MUST bind to
  // `authorization.value`; binding to `accepted.amount` is evadible.

  it('T-C13 (bug repro): rejects when accepted.amount <= cap but authorization.value > cap', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    // Attacker: declares a tiny accepted.amount (under cap) but signs a huge value.
    const evasive: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, amount: '1' },
      payload: {
        ...VALID_BODY.payload,
        authorization: { ...VALID_BODY.payload.authorization, value: '10000' },
      },
    };

    const result = await settleCore(evasive, { maxAmountAtomic: '5000' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_AMOUNT');
      expect(result.error.message).toContain('per-settle cap');
    }
    // Must never reach the chain when the settled value exceeds the cap.
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('T-C14 (regression): passes when value === accepted <= cap (legitimate settle)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const legit: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, amount: '1000' },
      payload: {
        ...VALID_BODY.payload,
        authorization: { ...VALID_BODY.payload.authorization, value: '1000' },
      },
    };

    const result = await settleCore(legit, { maxAmountAtomic: '5000' });
    expect(result.ok).toBe(true);
    expect(settleSpy).toHaveBeenCalledOnce();
  });

  it('T-C15 (edge): value === accepted === cap passes (boundary, cap uses > not >=)', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const atLimit: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, amount: '5000' },
      payload: {
        ...VALID_BODY.payload,
        authorization: { ...VALID_BODY.payload.authorization, value: '5000' },
      },
    };

    const result = await settleCore(atLimit, { maxAmountAtomic: '5000' });
    expect(result.ok).toBe(true);
    expect(settleSpy).toHaveBeenCalledOnce();
  });

  it('T-C16 (edge): value one over cap while accepted at cap → rejects', async () => {
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
    const adapter = makeFakeAdapter(2368, settleSpy);
    chainRegistry.register(adapter);

    const over: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, amount: '5000' },
      payload: {
        ...VALID_BODY.payload,
        authorization: { ...VALID_BODY.payload.authorization, value: '5001' },
      },
    };

    const result = await settleCore(over, { maxAmountAtomic: '5000' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_AMOUNT');
    expect(settleSpy).not.toHaveBeenCalled();
  });

  // ─── WKH-204 (AC-3) — solana namespace dispatch (mirror of verify) ────────
  it('AC-3: solana:devnet with no registered adapter → CHAIN_UNAVAILABLE http 503', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'solana:devnet' },
    };
    const res = await settleCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(res.error.http).toBe(503);
      expect(res.error.message).toContain('no adapter registered');
    }
  });

  it('AC-3: solana:mainnet with no registered adapter → CHAIN_UNAVAILABLE http 503', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'solana:mainnet' },
    };
    const res = await settleCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(res.error.http).toBe(503);
    }
  });

  it('AC-3: solana:foo (invalid cluster) → NETWORK_MISMATCH http 400', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'solana:foo' },
    };
    const res = await settleCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.http).toBe(400);
    }
  });
});

// ─── WKH-204 (AC-4) — SettlementAdapter verify-only contract (type test) ─────
describe('SettlementAdapter (AC-4)', () => {
  it('an object with only metadata + verify + settle is assignable (no viem clients)', () => {
    // Compile-time assertion: SettlementAdapter does NOT require
    // getPublicClient/getWalletClient. If this stops compiling, the AC-4
    // contract regressed.
    const verifyOnly: SettlementAdapter = {
      metadata: {
        chainId: asChainId(2368),
        name: 'settlement-only',
        network: 'testnet',
        networkId: 'eip155:2368',
        rpcUrl: 'http://localhost',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        tokens: [],
      },
      verify: (_params: VerifyParams): Promise<AdapterResult<VerifyResult>> =>
        Promise.resolve({
          ok: false,
          error: { code: 'CHAIN_UNAVAILABLE', message: 'stub', http: 503 },
        }),
      settle: (_params: SettleParams): Promise<AdapterResult<SettleResult>> =>
        Promise.resolve({
          ok: false,
          error: { code: 'CHAIN_UNAVAILABLE', message: 'stub', http: 503 },
        }),
      probeRpc: (): Promise<void> => Promise.resolve(),
    };
    expect(typeof verifyOnly.verify).toBe('function');
    expect(typeof verifyOnly.settle).toBe('function');
    expect('getPublicClient' in verifyOnly).toBe(false);

    // Compile-time assertion: ChainAdapter extends SettlementAdapter — a
    // full EVM adapter is assignable to the narrower interface.
    const full = makeFakeAdapter(2368, async () => VALID_SETTLE_RESULT);
    const asSettlement: SettlementAdapter = full;
    expect(asSettlement.metadata.networkId).toBe('eip155:2368');
  });
});
