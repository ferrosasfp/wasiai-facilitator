/**
 * Unit tests for src/core/verify.ts + Zod schemas in src/core/schemas.ts
 * (WFAC-20 W4).
 *
 * CD-15, CD-16 observed: we NEVER import `src/chains/kite.ts` or
 * `src/chains/avalanche.ts` — fake adapters are registered explicitly
 * via `chainRegistry._resetForTesting()` + `chainRegistry.register(...)`.
 *
 * Coverage map:
 *   - T-V1  : Schema accepts canonical fixture.
 *   - T-V2  : Schema rejects x402Version !== 2 (CD-8).
 *   - T-V3  : Schema rejects missing resource.
 *   - T-V4  : Schema rejects missing payload.
 *   - T-V5  : Schema rejects non-canonical uint256 (leading zero).
 *   - T-V6  : verifyCore NETWORK_MISMATCH on regex miss.
 *   - T-V7  : verifyCore NETWORK_MISMATCH on eip155:0 (CD-13).
 *   - T-V8  : verifyCore NETWORK_MISMATCH on chainId overflow (CD-14).
 *   - T-V9  : verifyCore NETWORK_MISMATCH on unregistered chain.
 *   - T-V10 : verifyCore NETWORK_MISMATCH on non-eip3009 method.
 *   - T-V11 : verifyCore passes params unchanged to adapter.verify.
 *   - T-V12 : verifyCore does not catch adapter exceptions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VerifyRequestSchema, type VerifyRequest } from '../../core/schemas.js';
import { verifyCore } from '../../core/verify.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, VerifyParams, VerifyResult } from '../../chains/types.js';

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

const VALID_RESULT = {
  ok: true as const,
  verified: true as const,
  client: `0x${'33'.repeat(20)}` as `0x${string}`,
  amount: '1000000',
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
  network: 'eip155:2368',
  payTo: `0x${'22'.repeat(20)}` as `0x${string}`,
  expiresAt: 99999999999,
};

function makeFakeAdapter(
  chainIdNum: number,
  verifyImpl: (params: VerifyParams) => Promise<unknown>,
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
    verify: verifyImpl as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
  };
}

// ─── VerifyRequestSchema (Zod) ─────────────────────────────────────────────

describe('VerifyRequestSchema (Zod x402 body)', () => {
  it('T-V1: accepts the canonical fixture', () => {
    const result = VerifyRequestSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
  });

  it('T-V2: rejects x402Version !== 2 (CD-8)', () => {
    const bad = { ...VALID_BODY, x402Version: 1 };
    const result = VerifyRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('T-V3: rejects missing resource', () => {
    const { resource: _r, ...rest } = VALID_BODY;
    void _r;
    const result = VerifyRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('T-V4: rejects missing payload', () => {
    const { payload: _p, ...rest } = VALID_BODY;
    void _p;
    const result = VerifyRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('T-V5: rejects non-canonical uint256 (leading zero) for accepted.amount', () => {
    const bad = { ...VALID_BODY, accepted: { ...VALID_BODY.accepted, amount: '0100' } };
    const result = VerifyRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level key (strict mode)', () => {
    const bad = { ...VALID_BODY, extra: 'nope' };
    const result = VerifyRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ─── verifyCore orchestrator ───────────────────────────────────────────────

describe('verifyCore', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  it('T-V6: returns NETWORK_MISMATCH when network regex fails ("solana:1")', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'solana:1' },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.http).toBe(400);
    }
  });

  it('T-V7: rejects eip155:0 (leading-zero / zero chainId, CD-13)', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:0' },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NETWORK_MISMATCH');
  });

  it('T-V7b: rejects eip155:01 (leading zero, CD-13)', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:01' },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NETWORK_MISMATCH');
  });

  it('T-V8: returns NETWORK_MISMATCH on chainId overflow (CD-14)', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: `eip155:${'9'.repeat(20)}` },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.message.toLowerCase()).toContain('safe integer');
    }
  });

  it('T-V9: returns NETWORK_MISMATCH when chain not registered', async () => {
    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: { ...VALID_BODY.accepted, network: 'eip155:999999' },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NETWORK_MISMATCH');
  });

  it('T-V10: returns NETWORK_MISMATCH when assetTransferMethod !== eip3009 and does NOT call adapter.verify', async () => {
    const spy = vi.fn(async () => VALID_RESULT);
    const adapter = makeFakeAdapter(2368, spy);
    const reg = chainRegistry.register(adapter);
    expect(reg.ok).toBe(true);

    const body: VerifyRequest = {
      ...VALID_BODY,
      accepted: {
        ...VALID_BODY.accepted,
        extra: { assetTransferMethod: 'permit2', name: 'X', version: '1' },
      },
    };
    const res = await verifyCore(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NETWORK_MISMATCH');
    expect(spy).not.toHaveBeenCalled();
  });

  it('T-V11: passes params to adapter.verify verbatim and returns its Result', async () => {
    let received: VerifyParams | undefined;
    const adapter = makeFakeAdapter(2368, async (params) => {
      received = params;
      return VALID_RESULT;
    });
    chainRegistry.register(adapter);

    const res = await verifyCore(VALID_BODY);
    expect(received).toBeDefined();
    expect(received?.accepted.amount).toBe(VALID_BODY.accepted.amount);
    expect(received?.payload.signature).toBe(VALID_BODY.payload.signature);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.client).toBe(VALID_RESULT.client);
      expect(res.amount).toBe(VALID_RESULT.amount);
    }
  });

  it('T-V11b: adapter error is passed through (code + message + http)', async () => {
    const adapter = makeFakeAdapter(2368, async () => ({
      ok: false as const,
      error: {
        code: 'INVALID_SIGNATURE' as const,
        message: 'Custom adapter message',
        http: 401,
      },
    }));
    chainRegistry.register(adapter);

    const res = (await verifyCore(VALID_BODY)) as {
      ok: false;
      error: { code: string; message: string; http: number };
    };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_SIGNATURE');
    expect(res.error.message).toBe('Custom adapter message');
    expect(res.error.http).toBe(401);
  });

  it('T-V12: does NOT catch adapter exceptions (propagates)', async () => {
    const adapter = makeFakeAdapter(2368, async () => {
      throw new Error('adapter blew up');
    });
    chainRegistry.register(adapter);

    await expect(verifyCore(VALID_BODY)).rejects.toThrow('adapter blew up');
  });

  // Non-CD extra: matches VerifyResult shape returned by adapter.
  it('returns success discriminant when adapter succeeds', async () => {
    const adapter = makeFakeAdapter(2368, async () => VALID_RESULT);
    chainRegistry.register(adapter);

    const res = await verifyCore(VALID_BODY);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r: VerifyResult = res;
      expect(r.verified).toBe(true);
      expect(r.network).toBe('eip155:2368');
    }
  });
});
