/**
 * WKH-216 / HU-SOL-13 — Wave 13b: readEscrowState (TF1, AC-2).
 *
 * The `EscrowState` fixture is ENCODED with the same pinned IDL coder used by the
 * production decode path (round-trip proves byte-correctness). The Connection is a
 * fake (DI) — zero network. The ★ assertion is the CROSS-REPO PDA PARITY: the
 * escrow_state PDA derived here MUST byte-match chaski's derivation
 * (`sha256(utf8(remittanceId))[:16]`, AH-9) or a release would target the wrong
 * account.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { BorshAccountsCoder, BN, type Idl } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import { escrowIdl } from '../../chains/escrow-idl.js';
import {
  readEscrowState,
  ESCROW_PROGRAM_ID_DEFAULT,
  type EscrowReadConnection,
} from '../../chains/solana-escrow.js';

const coder = new BorshAccountsCoder(escrowIdl as unknown as Idl);
const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID_DEFAULT);

interface EscrowFixture {
  sender: PublicKey;
  beneficiary: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  amount: string;
  deadline: string;
  status: 'Deposited' | 'Released' | 'Refunded';
  bump: number;
}

async function encodeEscrow(f: EscrowFixture): Promise<Buffer> {
  return coder.encode('EscrowState', {
    sender: f.sender,
    beneficiary: f.beneficiary,
    authority: f.authority,
    mint: f.mint,
    amount: new BN(f.amount),
    deadline: new BN(f.deadline),
    // Anchor 0.30 encodes the enum with the capitalized IDL variant name.
    status: { [f.status]: {} },
    bump: f.bump,
  });
}

/** chaski-side derivation (independent) — proves cross-repo PDA parity (TF1). */
function chaskiRemittanceIdBytes16(remittanceId: string): Buffer {
  return createHash('sha256')
    .update(new TextEncoder().encode(remittanceId))
    .digest()
    .subarray(0, 16);
}

function fakeConn(accountData: Buffer | null, vaultAmount: string): EscrowReadConnection {
  return {
    getAccountInfo: () => Promise.resolve(accountData === null ? null : { data: accountData }),
    getTokenAccountBalance: () => Promise.resolve({ value: { amount: vaultAmount } }),
  };
}

describe('readEscrowState (13b)', () => {
  const REMITTANCE_ID = 'rem-abc-123';
  const SENDER = Keypair.generate().publicKey;

  const fixture: EscrowFixture = {
    sender: SENDER,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    amount: '123456789012345678', // > 2^53 — decimal-string path (CD-18)
    deadline: '1790000000',
    status: 'Deposited',
    bump: 254,
  };

  it('TF1: decodes EscrowState byte-correct (u64 amount as decimal string)', async () => {
    const data = await encodeEscrow(fixture);
    const r = await readEscrowState({
      sender: SENDER.toBase58(),
      remittanceId: REMITTANCE_ID,
      connection: fakeConn(data, fixture.amount),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.sender).toBe(SENDER.toBase58());
    expect(r.state.beneficiary).toBe(fixture.beneficiary.toBase58());
    expect(r.state.authority).toBe(fixture.authority.toBase58());
    expect(r.state.mint).toBe(fixture.mint.toBase58());
    expect(r.state.amount).toBe('123456789012345678'); // never Number() lossy
    expect(r.state.deadline).toBe('1790000000');
    expect(r.state.status).toBe('Deposited');
    expect(r.state.bump).toBe(254);
    expect(r.vaultAmount).toBe('123456789012345678');
  });

  it('★ TF1: escrow_state PDA byte-matches chaski derivation (cross-repo parity)', async () => {
    const data = await encodeEscrow(fixture);
    const r = await readEscrowState({
      sender: SENDER.toBase58(),
      remittanceId: REMITTANCE_ID,
      connection: fakeConn(data, fixture.amount),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), SENDER.toBuffer(), chaskiRemittanceIdBytes16(REMITTANCE_ID)],
      PROGRAM_ID,
    );
    expect(r.state.escrowStatePda).toBe(expectedPda.toBase58());
  });

  it('TF1: decodes a Released status', async () => {
    const data = await encodeEscrow({ ...fixture, status: 'Released' });
    const r = await readEscrowState({
      sender: SENDER.toBase58(),
      remittanceId: REMITTANCE_ID,
      connection: fakeConn(data, fixture.amount),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.status).toBe('Released');
  });

  it('TF1: account not found → fail-closed reject (no throw)', async () => {
    const r = await readEscrowState({
      sender: SENDER.toBase58(),
      remittanceId: REMITTANCE_ID,
      connection: fakeConn(null, '0'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ESCROW_STATE_NOT_FOUND');
  });

  it('TF1: RPC throw → fail-closed reject (no throw)', async () => {
    const conn: EscrowReadConnection = {
      getAccountInfo: () => Promise.reject(new Error('rpc down')),
      getTokenAccountBalance: () => Promise.resolve({ value: { amount: '0' } }),
    };
    const r = await readEscrowState({
      sender: SENDER.toBase58(),
      remittanceId: REMITTANCE_ID,
      connection: conn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ESCROW_READ_FAILED');
  });
});
