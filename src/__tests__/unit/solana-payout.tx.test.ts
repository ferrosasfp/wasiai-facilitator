/**
 * WKH-302 — transaction build / validation / verification + the new broadcast hooks.
 *
 * `@solana/web3.js` is mocked so `Connection` delegates to the `FakeSolanaChain`
 * balance book (the pattern of solana-sponsor.broadcast.test.ts); `Transaction`,
 * `Keypair` and `PublicKey` stay REAL, so the txs under test are genuine wire-format
 * transactions that the fake decodes byte by byte.
 *
 * The validator suite is the one that matters most: it is the only thing standing
 * between a future refactor of the builder and a signature over the wrong amount or
 * the wrong destination.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Web3 from '@solana/web3.js';

const h = vi.hoisted(() => ({ chain: { current: null as unknown } }));

interface FakeConn {
  getLatestBlockhash: (c?: string) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  isBlockhashValid: (b: string) => Promise<{ value: boolean }>;
  sendRawTransaction: (raw: Uint8Array, o?: unknown) => Promise<string>;
  confirmTransaction: (s: string, c?: string) => Promise<{ value: { err: unknown } }>;
  getParsedTransaction: (s: string, o?: unknown) => Promise<unknown>;
}

vi.mock('@solana/web3.js', async (importActual) => {
  const actual = await importActual<typeof Web3>();
  class MockConnection {
    constructor(_url: string, _commitment?: string) {}
    private get c(): FakeConn {
      return h.chain.current as FakeConn;
    }
    getLatestBlockhash(commitment?: string) {
      return this.c.getLatestBlockhash(commitment);
    }
    isBlockhashValid(blockhash: string) {
      return this.c.isBlockhashValid(blockhash);
    }
    sendRawTransaction(raw: Uint8Array, opts?: unknown) {
      return this.c.sendRawTransaction(raw, opts);
    }
    confirmTransaction(sig: string, commitment?: string) {
      return this.c.confirmTransaction(sig, commitment);
    }
    getParsedTransaction(sig: string, opts?: unknown) {
      return this.c.getParsedTransaction(sig, opts);
    }
  }
  return { ...actual, Connection: MockConnection };
});

import { Keypair, Transaction, type Connection, type PublicKey } from '@solana/web3.js';
import { FakeSolanaChain } from './methods/solana-payout/fake-solana-chain.js';
import { buildPayoutTx } from '../../methods/solana-payout/build-transfer.js';
import {
  validatePayoutTx,
  type ExpectedPayout,
} from '../../methods/solana-payout/validate-transfer.js';
import { verifyPayoutSignature } from '../../methods/solana-payout/verify-transfer.js';
import {
  PAYOUT_SENTINEL_ID,
  encodeSignatureBase58,
} from '../../methods/solana-payout/payout-shape.js';
import { cosignAndBroadcast } from '../../methods/solana-sponsor/broadcast.js';
import { resetChainMutexForTesting } from '../../chains/chain-mutex.js';
import { deriveAta } from '../../chains/solana-escrow.js';

const DECIMALS = 6;
const AMOUNT = 3_000_000n;
// A blockhash must be valid base58 decoding to 32 bytes — a generated pubkey is
// the simplest thing that always is (same trick as solana-sponsor.broadcast.test).
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

let chain: FakeSolanaChain;
let operatorKp: Keypair;
let agent: PublicKey;
let mint: PublicKey;
let operatorAta: PublicKey;
let agentAta: PublicKey;

function expected(overrides: Partial<ExpectedPayout> = {}): ExpectedPayout {
  return {
    payoutOperator: operatorKp.publicKey,
    payTo: agent,
    mint,
    decimals: DECIMALS,
    amountAtomic: AMOUNT,
    maxFeeLamports: 100_000n,
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildPayoutTx>[0]> = {}): string {
  return buildPayoutTx({
    payoutOperator: operatorKp.publicKey,
    payTo: agent,
    mint,
    decimals: DECIMALS,
    amountAtomic: AMOUNT,
    recentBlockhash: BLOCKHASH,
    createDestinationAta: false,
    ...overrides,
  });
}

const parse = (b64: string): Transaction => Transaction.from(Buffer.from(b64, 'base64'));

beforeEach(() => {
  resetChainMutexForTesting();
  chain = new FakeSolanaChain();
  h.chain.current = chain;
  operatorKp = Keypair.generate();
  agent = Keypair.generate().publicKey;
  mint = Keypair.generate().publicKey;
  operatorAta = chain.registerAta(operatorKp.publicKey, mint, DECIMALS, 10_000_000n);
  agentAta = chain.registerAta(agent, mint, DECIMALS, 0n);
  chain.setLamports(operatorKp.publicKey, 50_000_000n);
  chain.setBlockhash(BLOCKHASH);
});

afterEach(() => vi.clearAllMocks());

describe('buildPayoutTx', () => {
  it('builds a single TransferChecked, unsigned, with the operator as feePayer', () => {
    const tx = parse(build());
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer?.toBase58()).toBe(operatorKp.publicKey.toBase58());
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    const ix = tx.instructions.at(0);
    expect(ix?.data.readUInt8(0)).toBe(12); // TransferChecked, NOT 3 (Transfer)
    expect(ix?.data.readBigUInt64LE(1)).toBe(AMOUNT);
    expect(ix?.data.readUInt8(9)).toBe(DECIMALS);
  });

  it('★ source and destination are the DERIVED ATAs (not the wallets)', () => {
    const ix = parse(build()).instructions.at(0);
    expect(ix?.keys.at(0)?.pubkey.toBase58()).toBe(operatorAta.toBase58());
    expect(ix?.keys.at(2)?.pubkey.toBase58()).toBe(agentAta.toBase58());
    expect(ix?.keys.at(3)?.pubkey.toBase58()).toBe(operatorKp.publicKey.toBase58());
    expect(ix?.keys.at(3)?.isSigner).toBe(true);
  });

  it('prepends CreateIdempotent for the DESTINATION when asked, in the SAME tx', () => {
    const tx = parse(build({ createDestinationAta: true }));
    expect(tx.instructions).toHaveLength(2);
    const create = tx.instructions.at(0);
    expect(create?.data).toEqual(Buffer.from([1]));
    expect(create?.keys.at(1)?.pubkey.toBase58()).toBe(agentAta.toBase58());
    expect(create?.keys.at(2)?.pubkey.toBase58()).toBe(agent.toBase58());
  });

  it('★ NEVER emits a create for the SOURCE ata (no-funds must not be hidden by rent)', () => {
    const tx = parse(build({ createDestinationAta: true }));
    for (const ix of tx.instructions) {
      if (ix.data.length === 1 && ix.data.readUInt8(0) === 1) {
        expect(ix.keys.at(1)?.pubkey.toBase58()).not.toBe(operatorAta.toBase58());
      }
    }
  });

  it('handles an amount above 2^53 exactly (u64 LE from BigInt, CD-10)', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const ix = parse(build({ amountAtomic: big })).instructions.at(0);
    expect(ix?.data.readBigUInt64LE(1)).toBe(big);
  });

  it('does not sign', () => {
    const tx = parse(build());
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
  });
});

describe('validatePayoutTx — the guard that is NOT decorative', () => {
  it('accepts the tx the builder produced for the same intent', () => {
    const r = validatePayoutTx(expected())(parse(build()), operatorKp.publicKey);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feeUpperBoundLamports).toBeGreaterThan(0n);
  });

  it('accepts the 2-instruction (create + transfer) shape', () => {
    const r = validatePayoutTx(expected())(
      parse(build({ createDestinationAta: true })),
      operatorKp.publicKey,
    );
    expect(r.ok).toBe(true);
  });

  it('★ AMOUNT altered by the builder → reject (the M5 scenario)', () => {
    const tx = parse(build({ amountAtomic: AMOUNT * 2n }));
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('AMOUNT_MISMATCH');
  });

  it('★ DESTINATION altered by the builder → reject (the M5 scenario)', () => {
    const attacker = Keypair.generate().publicKey;
    const tx = parse(build({ payTo: attacker }));
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DESTINATION_ATA_MISMATCH');
  });

  it('★ an amount ONE unit over is rejected (equality, never >=)', () => {
    const tx = parse(build({ amountAtomic: AMOUNT + 1n }));
    expect(validatePayoutTx(expected())(tx, operatorKp.publicKey).ok).toBe(false);
  });

  it('★ an amount BELOW the expectation is rejected too', () => {
    const tx = parse(build({ amountAtomic: AMOUNT - 1n }));
    expect(validatePayoutTx(expected())(tx, operatorKp.publicKey).ok).toBe(false);
  });

  it('mint mismatch → reject', () => {
    const tx = parse(build({ mint: Keypair.generate().publicKey }));
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MINT_MISMATCH');
  });

  it('decimals mismatch → reject', () => {
    const tx = parse(build({ decimals: 9 }));
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DECIMALS_MISMATCH');
  });

  it('★ a plain Transfer (tag 3) instead of TransferChecked → reject', () => {
    const tx = parse(build());
    const ix = tx.instructions.at(0);
    if (ix) ix.data.writeUInt8(3, 0);
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_TRANSFER_CHECKED');
  });

  it('★ source ATA swapped for someone else’s → reject', () => {
    const tx = parse(build());
    const ix = tx.instructions.at(0);
    const victimAta = deriveAta(Keypair.generate().publicKey, mint);
    const key0 = ix?.keys.at(0);
    if (key0) key0.pubkey = victimAta;
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SOURCE_ATA_MISMATCH');
  });

  it('★ an extra third instruction → reject (exactly 1 or 2)', () => {
    const tx = parse(build({ createDestinationAta: true }));
    const extra = tx.instructions.at(1);
    if (extra) tx.add(extra);
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('UNEXPECTED_INSTRUCTION_COUNT');
  });

  it('★ feePayer that is not the expected operator → reject', () => {
    const tx = parse(build());
    tx.feePayer = Keypair.generate().publicKey;
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_MISMATCH');
  });

  it('★ the SIGNER offered by the primitive must be the expected operator', () => {
    const tx = parse(build());
    const r = validatePayoutTx(expected())(tx, Keypair.generate().publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIGNER_NOT_EXPECTED_OPERATOR');
  });

  it('★ a create ix pointing at ANOTHER ATA → reject (rent for an unrelated account)', () => {
    const tx = parse(build({ createDestinationAta: true }));
    const create = tx.instructions.at(0);
    const key1 = create?.keys.at(1);
    if (key1) key1.pubkey = deriveAta(Keypair.generate().publicKey, mint);
    const r = validatePayoutTx(expected())(tx, operatorKp.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('CREATE_ATA_MISMATCH');
  });

  it('fee above the per-tx ceiling → reject', () => {
    const r = validatePayoutTx(expected({ maxFeeLamports: 1n }))(
      parse(build()),
      operatorKp.publicKey,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_ABOVE_MAX');
  });
});

describe('verifyPayoutSignature — verify-before-trust (CD-8)', () => {
  async function payOnce(): Promise<string> {
    const tx = parse(build());
    tx.partialSign(operatorKp);
    return chain.sendRawTransaction(tx.serialize());
  }

  it('★ a real payment verifies by NET DELTA of the balance book', async () => {
    const sig = await payOnce();
    const r = await verifyPayoutSignature(chain as unknown as Connection, {
      signature: sig,
      payTo: agent.toBase58(),
      mint: mint.toBase58(),
      amountAtomic: AMOUNT.toString(),
    });
    expect(r.valid).toBe(true);
  });

  it('★ a delta BELOW the expected amount is not valid', async () => {
    const sig = await payOnce();
    const r = await verifyPayoutSignature(chain as unknown as Connection, {
      signature: sig,
      payTo: agent.toBase58(),
      mint: mint.toBase58(),
      amountAtomic: (AMOUNT + 1n).toString(),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('DELTA_BELOW_EXPECTED');
  });

  it('unknown signature → not valid (never throws)', async () => {
    const r = await verifyPayoutSignature(chain as unknown as Connection, {
      signature: 'NoSuchSignature',
      payTo: agent.toBase58(),
      mint: mint.toBase58(),
      amountAtomic: AMOUNT.toString(),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('TX_NOT_FOUND');
  });

  it('another owner’s payment does not verify for this payTo', async () => {
    const sig = await payOnce();
    const r = await verifyPayoutSignature(chain as unknown as Connection, {
      signature: sig,
      payTo: Keypair.generate().publicKey.toBase58(),
      mint: mint.toBase58(),
      amountAtomic: AMOUNT.toString(),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('NO_DESTINATION_BALANCE');
  });

  it('★ an RPC failure is NOT a valid verification (never throws)', async () => {
    const sig = await payOnce();
    chain.failBalanceRead = true;
    const r = await verifyPayoutSignature(chain as unknown as Connection, {
      signature: sig,
      payTo: agent.toBase58(),
      mint: mint.toBase58(),
      amountAtomic: AMOUNT.toString(),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('RPC_ERROR');
  });
});

describe('cosignAndBroadcast — the new onSigned / mutexId options (WKH-302)', () => {
  const baseOpts = () => ({
    feePayerKeypair: operatorKp,
    validate: validatePayoutTx(expected()),
    rpcUrl: 'http://mock',
    maxFeeLamports: 100_000n,
    maxRebroadcasts: 2,
  });

  it('★ onSigned runs BEFORE the broadcast and receives the SIGNED tx', async () => {
    let sawSignature: string | null = null;
    let bookAtHookTime: bigint | null = null;
    const r = await cosignAndBroadcast(build(), {
      ...baseOpts(),
      mutexId: PAYOUT_SENTINEL_ID,
      onSigned: async (tx) => {
        const sig = tx.signatures.at(0)?.signature;
        sawSignature = sig ? encodeSignatureBase58(Uint8Array.from(sig)) : null;
        bookAtHookTime = chain.balanceOf(agentAta);
        return { ok: true };
      },
    });
    expect(r.ok).toBe(true);
    expect(sawSignature).not.toBeNull();
    if (r.ok) expect(r.signature).toBe(sawSignature);
    // The money had NOT moved yet when the hook ran — that is invariant I2.
    expect(bookAtHookTime).toBe(0n);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });

  it('★ onSigned { ok:false } → NO broadcast, SPONSOR_PERSIST_FAILED, book unchanged', async () => {
    const before = chain.balanceOf(agentAta);
    const r = await cosignAndBroadcast(build(), {
      ...baseOpts(),
      mutexId: PAYOUT_SENTINEL_ID,
      onSigned: async () => ({ ok: false }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPONSOR_PERSIST_FAILED');
    expect(chain.balanceOf(agentAta)).toBe(before);
    expect(chain.balanceOf(operatorAta)).toBe(10_000_000n);
  });

  it('a persist failure RELEASES the daily reservation (no spend happened)', async () => {
    const released: bigint[] = [];
    const r = await cosignAndBroadcast(build(), {
      ...baseOpts(),
      mutexId: PAYOUT_SENTINEL_ID,
      onFeeEstimated: async () => ({ ok: true }),
      onFeeReleased: async (l) => {
        released.push(l);
      },
      onSigned: async () => ({ ok: false }),
    });
    expect(r.ok).toBe(false);
    expect(released).toHaveLength(1);
  });

  it('★ without onSigned the primitive behaves exactly as before (sponsor/release)', async () => {
    const r = await cosignAndBroadcast(build(), baseOpts());
    expect(r.ok).toBe(true);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
  });

  it('a payout moves the money EXACTLY once, in both directions', async () => {
    const r = await cosignAndBroadcast(build(), { ...baseOpts(), mutexId: PAYOUT_SENTINEL_ID });
    expect(r.ok).toBe(true);
    expect(chain.balanceOf(agentAta)).toBe(AMOUNT);
    expect(chain.balanceOf(operatorAta)).toBe(10_000_000n - AMOUNT);
  });

  it('★ the validator rejecting means nothing is signed and nothing moves', async () => {
    const r = await cosignAndBroadcast(build({ amountAtomic: AMOUNT * 3n }), {
      ...baseOpts(),
      mutexId: PAYOUT_SENTINEL_ID,
    });
    expect(r.ok).toBe(false);
    expect(chain.balanceOf(agentAta)).toBe(0n);
    expect(chain.balanceOf(operatorAta)).toBe(10_000_000n);
  });
});
