/**
 * WKH-216 / HU-SOL-13 — Wave 13b: verifyVault (TF2, AC-2).
 *
 * Pure structural checks over an already-decoded `EscrowStateDecoded`. The gate
 * that MUST hold before any release: `status==Deposited`, `mint==USDC`,
 * `vault.amount==state.amount` (string equality — u64 decimal, CD-18).
 */

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { verifyVault, type EscrowStateDecoded } from '../../chains/solana-escrow.js';

const USDC = Keypair.generate().publicKey.toBase58();

function state(overrides: Partial<EscrowStateDecoded> = {}): EscrowStateDecoded {
  return {
    sender: Keypair.generate().publicKey.toBase58(),
    beneficiary: Keypair.generate().publicKey.toBase58(),
    authority: Keypair.generate().publicKey.toBase58(),
    mint: USDC,
    amount: '3000000',
    deadline: '1790000000',
    status: 'Deposited',
    bump: 254,
    escrowStatePda: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    ...overrides,
  };
}

describe('verifyVault (13b)', () => {
  it('TF2: Deposited + mint==USDC + vault==amount → ok', () => {
    const r = verifyVault(state(), '3000000', USDC);
    expect(r.ok).toBe(true);
  });

  it('TF2: status Released → reject (STATUS_NOT_DEPOSITED)', () => {
    const r = verifyVault(state({ status: 'Released' }), '3000000', USDC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('STATUS_NOT_DEPOSITED');
  });

  it('TF2: status Refunded → reject', () => {
    const r = verifyVault(state({ status: 'Refunded' }), '3000000', USDC);
    expect(r.ok).toBe(false);
  });

  it('TF2: mint ≠ USDC → reject (MINT_MISMATCH)', () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = verifyVault(state({ mint: other }), '3000000', USDC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MINT_MISMATCH');
  });

  it('TF2: vault.amount == state.amount → ok', () => {
    const r = verifyVault(state({ amount: '3000000' }), '3000000', USDC);
    expect(r.ok).toBe(true);
  });

  it('MNR-2: vault.amount DEFICIT (< state.amount) → reject (VAULT_AMOUNT_MISMATCH)', () => {
    const r = verifyVault(state({ amount: '3000000' }), '2999999', USDC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VAULT_AMOUNT_MISMATCH');
  });

  it('MNR-2: vault.amount EXCESS/dust (> state.amount) → ok (dust griefing no longer blocks release)', () => {
    // Anyone can transfer dust into the public vault ATA. The on-chain release
    // transfers EXACTLY state.amount, so the excess is inert — must NOT block.
    expect(verifyVault(state({ amount: '3000000' }), '3000001', USDC).ok).toBe(true);
    expect(verifyVault(state({ amount: '3000000' }), '9999999', USDC).ok).toBe(true);
  });

  it('TF2: large u64 amount compared as BigInt (no precision loss)', () => {
    const big = '18446744073709551615'; // 2^64-1
    expect(verifyVault(state({ amount: big }), big, USDC).ok).toBe(true);
    // deficit by 1 atomic unit → reject
    expect(verifyVault(state({ amount: big }), '18446744073709551614', USDC).ok).toBe(false);
    // excess beyond u64 max (dust) → still ok (only deficit is rejected)
    expect(verifyVault(state({ amount: big }), '18446744073709551616', USDC).ok).toBe(true);
  });
});
