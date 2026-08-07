/**
 * Unit tests for src/chains/casper-adapter.ts.
 *
 * Strategy (mirror of chains/solana-adapter.test.ts):
 *   - the Casper facilitator HTTP client is mocked via DI (constructor
 *     `fetchImpl`), exactly like Solana injects a fake `Connection`.
 * NO network, NO DB. verify/settle/registry/amount-math/address-validation are
 * exercised through the adapter directly.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CasperAdapter,
  CasperAmountPrecisionError,
  csprToMotes,
  motesToCspr,
  isCasperPublicKey,
  isCasperAccountHash,
  isCasperContractHash,
} from '../../../chains/casper-adapter.js';
import { ChainRegistry } from '../../../chains/registry.js';
import type { ChainAdapter, ChainMetadata, VerifyParams } from '../../../chains/types.js';
import { asChainId } from '../../../core/types.js';

// ─── fixtures ──────────────────────────────────────────────────────────────
const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64);

const WCSPR = `hash-${hex64('a1b2')}`;
const WCSPR_BARE = hex64('a1b2');
const WRONG_CONTRACT = hex64('dead');
const PAYER_PUBKEY = `01${hex64('11')}`;
const PAYER_SECP = `02${'22'.repeat(33)}`;
const PAYTO = `01${hex64('33')}`;
const PAYTO_ACCOUNT_HASH = `account-hash-${hex64('44')}`;
const DEPLOY_HASH = hex64('5e');
const FACILITATOR = 'https://x402-facilitator.cspr.cloud';

function makeAdapter(
  fetchImpl: ReturnType<typeof vi.fn>,
  network: 'casper' | 'casper-test' = 'casper-test',
): CasperAdapter {
  return new CasperAdapter({
    network,
    wcsprContractHash: WCSPR,
    facilitatorUrl: FACILITATOR,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function params(overrides?: {
  amount?: string;
  payTo?: string;
  asset?: string;
  network?: string;
  from?: string;
  signature?: string;
}): VerifyParams {
  return {
    x402Version: 2,
    resource: { url: 'https://x.test/r' },
    accepted: {
      scheme: 'exact',
      network: overrides?.network ?? 'casper:casper-test',
      amount: overrides?.amount ?? '1000000000',
      asset: overrides?.asset ?? WCSPR,
      payTo: overrides?.payTo ?? PAYTO,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: {
      signature: (overrides?.signature ?? `01${hex64('ab')}`) as `0x${string}`,
      authorization: {
        from: overrides?.from ?? PAYER_PUBKEY,
        to: overrides?.payTo ?? PAYTO,
        value: overrides?.amount ?? '1000000000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'0'.repeat(64)}`,
      },
    } as unknown as VerifyParams['payload'],
  };
}

// ─── amount / decimal conversion (motes, 9 decimals) ───────────────────────
describe('CasperAdapter amount conversion (motes, 9 decimals)', () => {
  it('T-CSPR-1: whole CSPR → motes exactly', () => {
    expect(csprToMotes('1')).toBe(1_000_000_000n);
    expect(csprToMotes('0')).toBe(0n);
    expect(csprToMotes('2500')).toBe(2_500_000_000_000n);
  });

  it('T-CSPR-2: fractional CSPR → motes exactly (no binary-float drift)', () => {
    expect(csprToMotes('1.5')).toBe(1_500_000_000n);
    expect(csprToMotes('0.000000001')).toBe(1n); // one mote
    // 0.07 * 1e9 in IEEE-754 doubles is 70000000.00000001 — integer math is exact.
    expect(csprToMotes('0.07')).toBe(70_000_000n);
  });

  it('T-CSPR-3: amount beyond 2^53 stays exact (BigInt, never Number)', () => {
    expect(csprToMotes('9007199254.740993')).toBe(9_007_199_254_740_993_000n);
    expect(csprToMotes('18446744073.709551615')).toBe(18_446_744_073_709_551_615n);
  });

  it('T-CSPR-4: sub-mote precision THROWS instead of truncating', () => {
    expect(() => csprToMotes('0.0000000001')).toThrow(CasperAmountPrecisionError);
    expect(() => csprToMotes('1.1234567891')).toThrow(CasperAmountPrecisionError);
    expect(() => csprToMotes('1.1234567891')).toThrow(/sub-mote precision would be lost/u);
  });

  it('T-CSPR-4b: trailing zeros beyond the 9th decimal are lossless (no throw)', () => {
    expect(csprToMotes('1.1234567890000')).toBe(1_123_456_789n);
  });

  it('T-CSPR-5: malformed amounts throw RangeError', () => {
    expect(() => csprToMotes('')).toThrow(RangeError);
    expect(() => csprToMotes('-1')).toThrow(RangeError);
    expect(() => csprToMotes('1e9')).toThrow(RangeError);
    expect(() => csprToMotes('01.5')).toThrow(RangeError);
    expect(() => csprToMotes('1.')).toThrow(RangeError);
  });

  it('T-CSPR-6: motesToCspr is the exact inverse', () => {
    expect(motesToCspr(1_000_000_000n)).toBe('1');
    expect(motesToCspr(1n)).toBe('0.000000001');
    expect(motesToCspr(1_500_000_000n)).toBe('1.5');
    expect(motesToCspr(0n)).toBe('0');
    for (const v of ['1', '1.5', '0.000000001', '18446744073.709551615']) {
      expect(motesToCspr(csprToMotes(v))).toBe(v);
    }
  });
});

// ─── address / hash validation ─────────────────────────────────────────────
describe('CasperAdapter address validation', () => {
  it('T-CSPR-7: accepts ed25519 (01…) and secp256k1 (02…) public keys', () => {
    expect(isCasperPublicKey(PAYER_PUBKEY)).toBe(true);
    expect(isCasperPublicKey(PAYER_SECP)).toBe(true);
  });

  it('T-CSPR-8: rejects malformed public keys (bad tag / length / non-hex)', () => {
    expect(isCasperPublicKey(`03${hex64('11')}`)).toBe(false); // unknown algo tag
    expect(isCasperPublicKey(`01${hex64('11')}ff`)).toBe(false); // ed25519 too long
    expect(isCasperPublicKey(`02${'22'.repeat(32)}`)).toBe(false); // secp256k1 too short
    expect(isCasperPublicKey(`01${'z'.repeat(64)}`)).toBe(false); // non-hex
    expect(isCasperPublicKey('')).toBe(false);
    expect(isCasperPublicKey('0x1234')).toBe(false); // EVM address is not a Casper key
  });

  it('T-CSPR-9: account hashes and contract hashes are validated by shape', () => {
    expect(isCasperAccountHash(PAYTO_ACCOUNT_HASH)).toBe(true);
    expect(isCasperAccountHash(hex64('44'))).toBe(false); // missing prefix
    expect(isCasperContractHash(WCSPR)).toBe(true);
    expect(isCasperContractHash(WCSPR_BARE)).toBe(true);
    expect(isCasperContractHash('hash-abc')).toBe(false);
    expect(isCasperContractHash(`hash-${'z'.repeat(64)}`)).toBe(false);
  });

  it('T-CSPR-10: constructor rejects a malformed wCSPR contract hash', () => {
    expect(() => new CasperAdapter({ network: 'casper', wcsprContractHash: 'hash-nope' })).toThrow(
      RangeError,
    );
  });
});

// ─── verify ────────────────────────────────────────────────────────────────
describe('CasperAdapter.verify', () => {
  it('T-CSPR-11: happy verify → VerifyResult, POSTs x402 v2 body to /verify', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ isValid: true, payer: PAYER_PUBKEY }));
    const res = await makeAdapter(f).verify(params());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verified).toBe(true);
      expect(res.amount).toBe('1000000000');
      expect(res.asset as unknown as string).toBe(WCSPR);
      expect(res.payTo as unknown as string).toBe(PAYTO);
      expect(res.client as unknown as string).toBe(PAYER_PUBKEY);
      expect(res.network).toBe('casper:casper-test');
      expect(res.expiresAt).toBe(0);
    }
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FACILITATOR}/verify`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      x402Version: number;
      paymentPayload: { network: string; scheme: string };
      paymentRequirements: { maxAmountRequired: string; asset: string; payTo: string };
    };
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.network).toBe('casper:casper-test');
    expect(body.paymentPayload.scheme).toBe('exact');
    expect(body.paymentRequirements.maxAmountRequired).toBe('1000000000');
    expect(body.paymentRequirements.asset).toBe(WCSPR);
    expect(body.paymentRequirements.payTo).toBe(PAYTO);
  });

  it('T-CSPR-12: an account-hash payTo is accepted', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ isValid: true }));
    const res = await makeAdapter(f).verify(params({ payTo: PAYTO_ACCOUNT_HASH }));
    expect(res.ok).toBe(true);
  });

  it('T-CSPR-13: facilitator isValid:false → INVALID_SIGNATURE with its reason', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ isValid: false, invalidReason: 'insufficient_funds' }));
    const res = await makeAdapter(f).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_SIGNATURE');
      expect(res.error.message).toBe('insufficient_funds');
    }
  });

  it('T-CSPR-14: an absent isValid is a REJECT, never an implicit accept (fail-CLOSED)', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}));
    const res = await makeAdapter(f).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_SIGNATURE');
  });

  it('T-CSPR-15: asset mismatch (look-alike CEP-18) → NETWORK_MISMATCH, no HTTP call', async () => {
    const f = vi.fn();
    const res = await makeAdapter(f).verify(params({ asset: WRONG_CONTRACT }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.message).toBe('asset mismatch');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('T-CSPR-16: network mismatch (mainnet body on the testnet adapter) → NETWORK_MISMATCH', async () => {
    const f = vi.fn();
    const res = await makeAdapter(f).verify(params({ network: 'casper:casper' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe('network mismatch');
    expect(f).not.toHaveBeenCalled();
  });

  it('T-CSPR-17: invalid payTo → INVALID_RECEIVER', async () => {
    const f = vi.fn();
    const res = await makeAdapter(f).verify(params({ payTo: '0xdeadbeef' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_RECEIVER');
      expect(res.error.message).toBe('invalid payTo address');
    }
  });

  it('T-CSPR-18: non-canonical / non-positive amounts → INVALID_AMOUNT', async () => {
    const f = vi.fn();
    const adapter = makeAdapter(f);
    for (const amount of ['1.5', '-1', '01', '1e9', 'abc']) {
      const res = await adapter.verify(params({ amount }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('INVALID_AMOUNT');
    }
    const zero = await adapter.verify(params({ amount: '0' }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.message).toBe('amount must be positive');
    expect(f).not.toHaveBeenCalled();
  });

  it('T-CSPR-19: a u512 amount above 2^53 is forwarded exactly', async () => {
    const BIG = '18446744073709551615';
    const f = vi.fn().mockResolvedValue(jsonResponse({ isValid: true }));
    const res = await makeAdapter(f).verify(params({ amount: BIG }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.amount).toBe(BIG);
  });
});

// ─── settle ────────────────────────────────────────────────────────────────
describe('CasperAdapter.settle', () => {
  it('T-CSPR-20: happy settle → SettleResult carrying the deploy hash', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        transaction: DEPLOY_HASH,
        payer: PAYER_PUBKEY,
        blockHeight: 4242,
      }),
    );
    const res = await makeAdapter(f).settle(params());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settled).toBe(true);
      expect(res.transactionHash as unknown as string).toBe(DEPLOY_HASH);
      expect(res.blockNumber).toBe(4242);
      expect(res.amount).toBe('1000000000');
      expect(res.from as unknown as string).toBe(PAYER_PUBKEY);
      expect(res.to as unknown as string).toBe(PAYTO);
      expect(res.asset as unknown as string).toBe(WCSPR);
    }
    expect((f.mock.calls[0] as [string])[0]).toBe(`${FACILITATOR}/settle`);
  });

  it('T-CSPR-21: facilitator success:false → TRANSACTION_FAILED with its reason', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, errorReason: 'deploy_reverted' }));
    const res = await makeAdapter(f).settle(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('deploy_reverted');
    }
  });

  it('T-CSPR-22: success without a usable deploy hash → fail-CLOSED reject', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ success: true, transaction: 'nope' }));
    const res = await makeAdapter(f).settle(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('malformed casper facilitator response');
    }
  });

  it('T-CSPR-23: settle returns the validation error verbatim without any HTTP call', async () => {
    const f = vi.fn();
    const res = await makeAdapter(f).settle(params({ asset: WRONG_CONTRACT }));
    expect(res.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

// ─── facilitator HTTP error handling ───────────────────────────────────────
describe('CasperAdapter facilitator HTTP errors', () => {
  it('T-CSPR-24: transport failure / timeout → CHAIN_UNAVAILABLE (503)', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await makeAdapter(f).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(res.error.http).toBe(503);
      expect(res.error.message).toBe('casper facilitator unreachable');
    }
  });

  it('T-CSPR-25: HTTP 5xx → CHAIN_UNAVAILABLE (503); HTTP 4xx → TRANSACTION_FAILED (400)', async () => {
    const f5 = vi.fn().mockResolvedValue(jsonResponse({}, 502));
    const r5 = await makeAdapter(f5).settle(params());
    expect(r5.ok).toBe(false);
    if (!r5.ok) {
      expect(r5.error.code).toBe('CHAIN_UNAVAILABLE');
      expect(r5.error.http).toBe(503);
      expect(r5.error.message).toBe('casper facilitator error (HTTP 502)');
    }

    const f4 = vi.fn().mockResolvedValue(jsonResponse({}, 422));
    const r4 = await makeAdapter(f4).settle(params());
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.error.code).toBe('TRANSACTION_FAILED');
      expect(r4.error.http).toBe(400);
    }
  });

  it('T-CSPR-26: malformed (non-JSON) facilitator body → reject, never accept', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);
    const res = await makeAdapter(f).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe('malformed casper facilitator response');
  });

  it('T-CSPR-27: probeRpc resolves on 2xx and throws otherwise', async () => {
    const okFetch = vi.fn().mockResolvedValue(jsonResponse({ kinds: [] }));
    await expect(makeAdapter(okFetch).probeRpc()).resolves.toBeUndefined();
    expect((okFetch.mock.calls[0] as [string])[0]).toBe(`${FACILITATOR}/supported`);

    const badFetch = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    await expect(makeAdapter(badFetch).probeRpc()).rejects.toThrow(/HTTP 503/u);
  });
});

// ─── registry registration ─────────────────────────────────────────────────
function makeEvmMock(chainIdNum: number): ChainAdapter {
  const metadata: ChainMetadata = {
    chainId: asChainId(chainIdNum),
    name: `EVM ${chainIdNum}`,
    network: 'testnet',
    networkId: `eip155:${chainIdNum}`,
    rpcUrl: 'https://example.test/rpc',
    nativeCurrency: { name: 'Test', symbol: 'TST', decimals: 18 },
    tokens: [],
  };
  return {
    metadata,
    verify: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    settle: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    getPublicClient: vi.fn(() => ({}) as never),
    getWalletClient: vi.fn(() => ({}) as never),
    probeRpc: vi.fn(async () => undefined),
  };
}

describe('ChainRegistry — Casper registration', () => {
  it('T-CSPR-28: registers as a pure SettlementAdapter (no viem clients)', () => {
    const registry = new ChainRegistry();
    expect(registry.register(makeAdapter(vi.fn())).ok).toBe(true);
  });

  it('T-CSPR-29: both Casper networks register and resolve by networkId', () => {
    const registry = new ChainRegistry();
    registry.register(makeAdapter(vi.fn(), 'casper'));
    registry.register(makeAdapter(vi.fn(), 'casper-test'));

    const mainnet = registry.getAdapterByNetworkId('casper:casper');
    expect(mainnet.ok).toBe(true);
    if (mainnet.ok) {
      expect(mainnet.adapter.metadata.networkId).toBe('casper:casper');
      expect(mainnet.adapter.metadata.network).toBe('mainnet');
      expect(mainnet.adapter.metadata.name).toBe('Casper Mainnet');
    }

    const testnet = registry.getAdapterByNetworkId('casper:casper-test');
    expect(testnet.ok).toBe(true);
    if (testnet.ok) {
      expect(testnet.adapter.metadata.networkId).toBe('casper:casper-test');
      expect(testnet.adapter.metadata.network).toBe('testnet');
    }
  });

  it('T-CSPR-30: EVM + Casper coexist; the Casper synthetic chainId never resolves as eip155', () => {
    const registry = new ChainRegistry();
    registry.register(makeEvmMock(43113));
    registry.register(makeAdapter(vi.fn(), 'casper'));

    const evm = registry.getAdapter(asChainId(43113));
    expect(evm.ok).toBe(true);
    if (evm.ok) expect(typeof evm.adapter.getPublicClient).toBe('function');

    expect(registry.getAdapterByNetworkId('eip155:506').ok).toBe(false);
  });

  it('T-CSPR-31: re-registering the same Casper network is rejected (409)', () => {
    const registry = new ChainRegistry();
    expect(registry.register(makeAdapter(vi.fn(), 'casper')).ok).toBe(true);
    const dup = registry.register(makeAdapter(vi.fn(), 'casper'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.http).toBe(409);
  });

  it('T-CSPR-32: metadata exposes wCSPR (9 decimals) as the settlement asset', () => {
    const meta = makeAdapter(vi.fn(), 'casper').metadata;
    expect(meta.nativeCurrency).toEqual({ name: 'Casper', symbol: 'CSPR', decimals: 9 });
    expect(meta.tokens).toHaveLength(1);
    expect(meta.tokens[0]?.symbol).toBe('WCSPR');
    expect(meta.tokens[0]?.decimals).toBe(9);
    expect(meta.blockExplorer).toBe('https://cspr.live');
  });
});
