/**
 * Unit tests for src/chains/solana-adapter.ts (WKH-205 / HU-SOL-6 — W4).
 *
 * Strategy:
 *   - `Connection.getTransaction` is mocked via DI (constructor `connection`).
 *   - `../../../infra/solana-dedup.js` is mocked via `vi.mock` (no DB).
 * NO network, NO DB. All 6 ACs are exercised through `adapter.verify(...)` /
 * `adapter.settle(...)` directly (Solana is not HTTP-reachable e2e this HU).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import * as solanaDedupModule from '../../../infra/solana-dedup.js';
import { SolanaAdapter } from '../../../chains/solana-adapter.js';
import { ChainRegistry } from '../../../chains/registry.js';
import type { ChainAdapter, ChainMetadata, VerifyParams } from '../../../chains/types.js';
import { SPL_TOKEN_TRANSFER_FINALIZED } from '../../../chains/types.js';
import { asChainId } from '../../../core/types.js';

// ─── infra/solana-dedup.js mock ────────────────────────────────────────────
vi.mock('../../../infra/solana-dedup.js', () => ({
  __esModule: true,
  isSolanaSignatureSettled: vi.fn(async () => ({ ok: true, settled: false })),
  recordSolanaSignature: vi.fn(async () => ({ ok: true, inserted: true })),
}));

const dedup = vi.mocked(solanaDedupModule);

// ─── fixtures ──────────────────────────────────────────────────────────────
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain Token-2022 program id (base58 pubkey), not a secret.
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const MINT = new PublicKey(Keypair.generate().publicKey.toBase58());
const WRONG_MINT = new PublicKey(Keypair.generate().publicKey.toBase58()); // clone "USDC" symbol
const PAYTO = new PublicKey(Keypair.generate().publicKey.toBase58());
const FEEPAYER = new PublicKey(Keypair.generate().publicKey.toBase58());
const REFERENCE = new PublicKey(Keypair.generate().publicKey.toBase58());

const MINT_58 = MINT.toBase58();
const PAYTO_58 = PAYTO.toBase58();
const REFERENCE_58 = REFERENCE.toBase58();
// Valid base58 signature (~88 chars) built from two base58 pubkeys.
const SIGNATURE = FEEPAYER.toBase58() + PAYTO.toBase58();

interface TokenBalanceStub {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

function tb(o: {
  owner: string;
  mint: string;
  programId: string;
  amount: string;
}): TokenBalanceStub {
  return {
    accountIndex: 1,
    mint: o.mint,
    owner: o.owner,
    programId: o.programId,
    uiTokenAmount: { amount: o.amount, decimals: 6, uiAmount: null },
  };
}

function makeTx(opts: {
  err?: unknown;
  pre?: TokenBalanceStub[];
  post?: TokenBalanceStub[];
  staticKeys?: PublicKey[];
  slot?: number;
}): unknown {
  return {
    slot: opts.slot ?? 123456,
    transaction: {
      message: { staticAccountKeys: opts.staticKeys ?? [FEEPAYER, PAYTO, REFERENCE] },
      signatures: [SIGNATURE],
    },
    meta: {
      err: opts.err ?? null,
      preTokenBalances: opts.pre ?? [],
      postTokenBalances: opts.post ?? [],
    },
  };
}

function makeConnection(getTransaction: ReturnType<typeof vi.fn>): Connection {
  return { getTransaction } as unknown as Connection;
}

function makeAdapter(getTransaction: ReturnType<typeof vi.fn>): SolanaAdapter {
  return new SolanaAdapter({
    rpcUrl: 'https://api.devnet.solana.com',
    mint: MINT_58,
    programId: SPL_TOKEN,
    cluster: 'devnet',
    connection: makeConnection(getTransaction),
  });
}

function params(overrides?: {
  amount?: string;
  payTo?: string;
  asset?: string;
  signature?: string;
  reference?: string | null;
}): VerifyParams {
  return {
    x402Version: 2,
    resource: { url: 'https://x.test/r' },
    accepted: {
      scheme: 'exact',
      network: 'solana:devnet',
      amount: overrides?.amount ?? '1000000',
      asset: overrides?.asset ?? MINT_58,
      payTo: overrides?.payTo ?? PAYTO_58,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: {
      signature: (overrides?.signature ?? SIGNATURE) as `0x${string}`,
      // Solana boundary: reference rides alongside signature on payload.
      ...(overrides?.reference === undefined
        ? { reference: REFERENCE_58 }
        : overrides.reference === null
          ? {}
          : { reference: overrides.reference }),
      authorization: {
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000000000000000000000000000000000000',
        value: '0',
        validAfter: '0',
        validBefore: '0',
        nonce: `0x${'0'.repeat(64)}`,
      },
    } as unknown as VerifyParams['payload'],
  };
}

const okPost = (amount: string): TokenBalanceStub[] => [
  tb({ owner: PAYTO_58, mint: MINT_58, programId: SPL_TOKEN, amount }),
];

beforeEach(() => {
  dedup.isSolanaSignatureSettled.mockReset();
  dedup.isSolanaSignatureSettled.mockResolvedValue({ ok: true, settled: false });
  dedup.recordSolanaSignature.mockReset();
  dedup.recordSolanaSignature.mockResolvedValue({ ok: true, inserted: true });
});

describe('SolanaAdapter.verify (W2/W4)', () => {
  it('T-SOL-1: happy verify (AC-1,2,3,5)', async () => {
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000') }));
    const res = await makeAdapter(getTx).verify(params({ amount: '1000000' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.amount).toBe('1000000');
      expect(res.asset as unknown as string).toBe(MINT_58);
      expect(res.payTo as unknown as string).toBe(PAYTO_58);
      expect(res.expiresAt).toBe(0);
    }
  });

  it('T-SOL-2: mint mismatch (same symbol clone) → NETWORK_MISMATCH (AC-1, CD-1)', async () => {
    const post = [
      tb({ owner: PAYTO_58, mint: WRONG_MINT.toBase58(), programId: SPL_TOKEN, amount: '1000000' }),
    ];
    const getTx = vi.fn().mockResolvedValue(makeTx({ post }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.message).toBe('mint mismatch');
    }
  });

  it('T-SOL-3: Token-2022 program-id → NETWORK_MISMATCH (AC-1, CD-1)', async () => {
    const post = [tb({ owner: PAYTO_58, mint: MINT_58, programId: TOKEN_2022, amount: '1000000' })];
    const getTx = vi.fn().mockResolvedValue(makeTx({ post }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.message).toBe('unsupported token program');
    }
  });

  it('T-SOL-4: net delta with compensating debit → INVALID_AMOUNT (AC-2, CD-2)', async () => {
    // pre=0, post=300000 net after a later compensating withdrawal → below 1000000.
    const pre = [tb({ owner: PAYTO_58, mint: MINT_58, programId: SPL_TOKEN, amount: '0' })];
    const post = [tb({ owner: PAYTO_58, mint: MINT_58, programId: SPL_TOKEN, amount: '300000' })];
    const getTx = vi.fn().mockResolvedValue(makeTx({ pre, post }));
    const res = await makeAdapter(getTx).verify(params({ amount: '1000000' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_AMOUNT');
      expect(res.error.message).toBe('net delta below accepted amount');
    }
  });

  it('T-SOL-5: u64 > 2^53 parsed exactly via BigInt (AC-3, CD-3)', async () => {
    const U64_MAX = '18446744073709551615';
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost(U64_MAX) }));
    const res = await makeAdapter(getTx).verify(params({ amount: U64_MAX }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.amount).toBe(U64_MAX);
  });

  it('T-SOL-5b: delta = expected-1 near 2^53 → INVALID_AMOUNT shortfall (BigInt precision, CD-3)', async () => {
    // expected 9007199254740993 (2^53+1), delta 9007199254740992 (2^53). A stray
    // Number() in the delta path would round BOTH to 2^53 → false accept; BigInt
    // keeps them distinct so the shortfall (delta < expected) is rejected.
    const EXPECTED = '9007199254740993';
    const DELTA = '9007199254740992';
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost(DELTA) }));
    const res = await makeAdapter(getTx).verify(params({ amount: EXPECTED }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_AMOUNT');
      expect(res.error.message).toBe('net delta below accepted amount');
    }
  });

  it('T-SOL-6: tx null → TRANSACTION_FAILED + commitment finalized requested (AC-5, CD-5)', async () => {
    const getTx = vi.fn().mockResolvedValue(null);
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('TRANSACTION_FAILED');
    expect(getTx).toHaveBeenCalledWith(
      SIGNATURE,
      expect.objectContaining({ commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
    );
  });

  it('T-SOL-6b: meta.err ≠ null → TRANSACTION_FAILED "on-chain tx failed"', async () => {
    const getTx = vi
      .fn()
      .mockResolvedValue(
        makeTx({ err: { InstructionError: [0, 'Custom'] }, post: okPost('1000000') }),
      );
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('on-chain tx failed');
    }
  });

  it('T-SOL-7: replay (SELECT settled) → TRANSACTION_FAILED duplicate (AC-4, CD-4)', async () => {
    dedup.isSolanaSignatureSettled.mockResolvedValue({ ok: true, settled: true });
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000') }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('duplicate transaction — replay rejected');
    }
  });

  it('T-SOL-8: dedup store outage → fail-CLOSED TRANSACTION_FAILED (AC-4, CD-4)', async () => {
    dedup.isSolanaSignatureSettled.mockResolvedValue({ ok: false });
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000') }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('dedup store unavailable');
    }
  });

  it('T-SOL-12: reference absent from account keys → NETWORK_MISMATCH', async () => {
    // staticKeys without REFERENCE.
    const getTx = vi
      .fn()
      .mockResolvedValue(makeTx({ post: okPost('1000000'), staticKeys: [FEEPAYER, PAYTO] }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_MISMATCH');
      expect(res.error.message).toBe('payment reference not found in tx');
    }
  });

  it('T-SOL-13: no token-balance owner===payTo → INVALID_RECEIVER', async () => {
    const other = new PublicKey(Keypair.generate().publicKey.toBase58()).toBase58();
    const post = [tb({ owner: other, mint: MINT_58, programId: SPL_TOKEN, amount: '1000000' })];
    const getTx = vi.fn().mockResolvedValue(makeTx({ post }));
    const res = await makeAdapter(getTx).verify(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_RECEIVER');
      expect(res.error.message).toBe('receiver ATA mismatch');
    }
  });
});

describe('SolanaAdapter.settle (W3/W4)', () => {
  it('T-SOL-9: settle happy → SettleResult (AC-4, DT-5)', async () => {
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000'), slot: 999 }));
    const res = await makeAdapter(getTx).settle(params({ amount: '1000000' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settled).toBe(true);
      expect(res.transactionHash as unknown as string).toBe(SIGNATURE);
      expect(res.blockNumber).toBe(999);
      expect(res.amount).toBe('1000000');
    }
    expect(dedup.recordSolanaSignature).toHaveBeenCalledTimes(1);
  });

  it('T-SOL-10: settle replay UNIQUE (inserted:false) → TRANSACTION_FAILED duplicate (CD-4)', async () => {
    dedup.recordSolanaSignature.mockResolvedValue({ ok: true, inserted: false });
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000') }));
    const res = await makeAdapter(getTx).settle(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('duplicate transaction — replay rejected');
    }
  });

  it('T-SOL-11: settle store outage (record ok:false) → fail-CLOSED reject (CD-4)', async () => {
    dedup.recordSolanaSignature.mockResolvedValue({ ok: false });
    const getTx = vi.fn().mockResolvedValue(makeTx({ post: okPost('1000000') }));
    const res = await makeAdapter(getTx).settle(params());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TRANSACTION_FAILED');
      expect(res.error.message).toBe('dedup store unavailable');
    }
  });

  it('settle returns verify error verbatim without persisting', async () => {
    const getTx = vi.fn().mockResolvedValue(null);
    const res = await makeAdapter(getTx).settle(params());
    expect(res.ok).toBe(false);
    expect(dedup.recordSolanaSignature).not.toHaveBeenCalled();
  });
});

// ─── registry generalization (T-REG) ────────────────────────────────────────
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
  };
}

describe('ChainRegistry generalization (T-REG)', () => {
  it('T-REG-1: _isValidAdapter accepts a pure SettlementAdapter (no viem clients)', () => {
    const registry = new ChainRegistry();
    const solana = makeAdapter(vi.fn());
    const result = registry.register(solana);
    expect(result.ok).toBe(true);
  });

  it('T-REG-2: getAdapter(chainId) still returns a ChainAdapter with viem clients (CD-7)', () => {
    const registry = new ChainRegistry();
    registry.register(makeEvmMock(43113));
    const res = registry.getAdapter(asChainId(43113));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(typeof res.adapter.getPublicClient).toBe('function');
      expect(typeof res.adapter.getWalletClient).toBe('function');
    }
  });

  it('T-REG-3: EVM + Solana register simultaneously; each resolves by networkId', () => {
    const registry = new ChainRegistry();
    registry.register(makeEvmMock(43113));
    registry.register(makeAdapter(vi.fn()));

    const sol = registry.getAdapterByNetworkId('solana:devnet');
    expect(sol.ok).toBe(true);
    if (sol.ok) expect(sol.adapter.metadata.networkId).toBe('solana:devnet');

    const evm = registry.getAdapter(asChainId(43113));
    expect(evm.ok).toBe(true);
    if (evm.ok) expect(typeof evm.adapter.getPublicClient).toBe('function');

    // getAdapter(chainId) never resolves the Solana synthetic chainId as EVM.
    const asEip = registry.getAdapterByNetworkId('eip155:103');
    expect(asEip.ok).toBe(false);
  });

  it('T-REG-4: Solana metadata is non-EVM (networkId solana:*, no eip155 key)', () => {
    const solana = makeAdapter(vi.fn());
    expect(solana.metadata.networkId).toBe('solana:devnet');
    expect(solana.metadata.network).toBe('testnet');
  });

  // WKH-323 — the adapter must declare the mechanism it actually implements.
  // Before the fix it declared nothing, so `GET /supported` fell back to
  // CHAIN_METHODS_DEFAULT and published `eip3009` for this rail.
  it('T-SOL-M1: metadata.supportedMethods declares the SPL mechanism, never eip3009', () => {
    const solana = makeAdapter(vi.fn());
    expect(solana.metadata.supportedMethods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
    expect(solana.metadata.supportedMethods).not.toContain('eip3009');
  });

  // Public-contract pin. This is the ONLY place in WKH-323 where the literal is
  // written by hand: every other assertion references the constant, so without
  // this test a rename would keep the whole suite green while the published
  // contract silently changed.
  it('T-SOL-M2: the published literal is exactly `spl-token-transfer-finalized`', () => {
    expect(SPL_TOKEN_TRANSFER_FINALIZED).toBe('spl-token-transfer-finalized');
  });

  it('T-SOL-M3: a mainnet-cluster adapter declares the same literal (no devnet-only wiring)', () => {
    const mainnet = new SolanaAdapter({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      mint: MINT_58,
      programId: SPL_TOKEN,
      cluster: 'mainnet',
      connection: makeConnection(vi.fn()),
    });
    expect(mainnet.metadata.networkId).toBe('solana:mainnet');
    expect(mainnet.metadata.supportedMethods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
  });
});
