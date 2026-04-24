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
import type { ChainAdapter, SettleParams } from '../../chains/types.js';
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
    const settleSpy = vi.fn(async () => VALID_SETTLE_RESULT);
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
});
