/**
 * WKH-216 / HU-SOL-13 — Wave 13b: escrow READ + verify-vault (read-only, BAJO riesgo).
 *
 * The facilitator MUST read the on-chain `EscrowState` and the vault balance and
 * verify `status==Deposited`, `mint==USDC`, `vault.amount==state.amount` BEFORE
 * building/signing ANY `release` (AC-2, CD-3). This module is READ-ONLY: no
 * keypair, no broadcast — it only decodes a PDA account and reads a token balance.
 *
 * DT-4b: the `EscrowState` ACCOUNT is decoded with `BorshAccountsCoder(escrowIdl)`
 * (pinned IDL). CD-12 is NOT violated: 13b decodes an on-chain *account*; the
 * `release` *transaction* is parsed raw-by-bytes in `cr1-release.ts` (13c). Never
 * confuse the two.
 *
 * PDA parity (CD-crítico / TF1): the escrow_state PDA derivation MUST byte-match
 * chaski's (`sha256(utf8(remittanceId)).subarray(0,16)`, AH-9). `amount` on-chain
 * is a u64 — carried end-to-end as a DECIMAL STRING, NEVER `Number()` (WKH-196/CD-18).
 *
 * FAIL-CLOSED: every path returns a discriminated result — NEVER throws. A missing
 * account, a decode error, or an RPC error all resolve `{ ok:false, reason }` so
 * the caller (13c route) rejects the release without signing.
 *
 * Boundary: imports `@solana/web3.js` (runtime), `@coral-xyz/anchor`
 * (BorshAccountsCoder — account decode only), `./escrow-idl.js`, `node:crypto`
 * (server-side sha256; the facilitator is a Node server, never a browser bundle —
 * CD-15 does not apply here).
 */

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type BN, type Idl } from '@coral-xyz/anchor';
import { escrowIdl } from './escrow-idl.js';

/** SPL Token classic program id (ATA derivation seed). Public on-chain pubkey. */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Associated Token program id (ATA derivation program). Public on-chain pubkey. */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain Associated Token program id (base58 pubkey), not a secret.
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Escrow program id (PDA derivation). Public on-chain pubkey (== escrowIdl.address). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain escrow program id (base58 pubkey), not a secret.
export const ESCROW_PROGRAM_ID_DEFAULT = 'BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA';

/** Escrow status, normalized from the anchor enum object to a stable string. */
export type EscrowStatusStr = 'Deposited' | 'Released' | 'Refunded' | 'Unknown';

/** Decoded `EscrowState` — pubkeys as base58, u64/i64 as decimal strings (CD-18). */
export interface EscrowStateDecoded {
  readonly sender: string;
  readonly beneficiary: string;
  readonly authority: string;
  readonly mint: string;
  readonly amount: string; // decimal string atomic u64 (NEVER Number)
  readonly deadline: string; // decimal string i64 (unix seconds)
  readonly status: EscrowStatusStr;
  readonly bump: number;
  /** Derived escrow_state PDA (base58) — parity-checked against chaski (TF1). */
  readonly escrowStatePda: string;
  /** Derived vault ATA (base58) whose balance was read. */
  readonly vault: string;
}

/** Minimal Connection surface used here (DI: tests inject a fake; prod = web3 Connection). */
export interface EscrowReadConnection {
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer } | null>;
  getTokenAccountBalance(pubkey: PublicKey): Promise<{ value: { amount: string } }>;
}

export type ReadEscrowResult =
  | { readonly ok: true; readonly state: EscrowStateDecoded; readonly vaultAmount: string }
  | { readonly ok: false; readonly reason: string };

export type VerifyVaultResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Raw shape returned by BorshAccountsCoder.decode for the `EscrowState` account. */
interface EscrowStateRaw {
  sender: PublicKey;
  beneficiary: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  amount: BN;
  deadline: BN;
  status: unknown;
  bump: number;
}

/**
 * `[u8;16]` derived from the remittanceId — `sha256(utf8(remittanceId))[:16]`.
 * MUST byte-match chaski's `remittanceIdToBytes16` (AH-9) or the PDA diverges (TF1).
 * Server-side `node:crypto` (facilitator is a Node process — CD-15 browser rule N/A).
 */
export function remittanceIdToBytes16(remittanceId: string): Buffer {
  return createHash('sha256').update(Buffer.from(remittanceId, 'utf8')).digest().subarray(0, 16);
}

/**
 * Derive the escrow_state PDA: `["escrow", sender, sha256(remittanceId)[:16]]` over
 * the escrow program id. Byte-identical to chaski's derivation (AH-9).
 */
export function deriveEscrowStatePda(
  sender: PublicKey,
  remittanceId: string,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), sender.toBuffer(), remittanceIdToBytes16(remittanceId)],
    programId,
  );
  return pda;
}

/**
 * Derive the canonical Associated Token Account for `owner`+`mint`. Works for the
 * off-curve escrow_state PDA owner too (ATA derivation never checks curve).
 */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return ata;
}

/**
 * Normalize the anchor enum object to a stable string. BorshAccountsCoder (0.30.1)
 * decodes the `EscrowStatus` variant as a single-key object (e.g. `{ Deposited:{} }`);
 * lowercase the key defensively so casing changes across anchor versions don't slip.
 */
function normalizeStatus(raw: unknown): EscrowStatusStr {
  if (raw !== null && typeof raw === 'object') {
    const keys = Object.keys(raw as Record<string, unknown>).map((k) => k.toLowerCase());
    if (keys.includes('deposited')) return 'Deposited';
    if (keys.includes('released')) return 'Released';
    if (keys.includes('refunded')) return 'Refunded';
  }
  return 'Unknown';
}

/**
 * Read + decode the on-chain `EscrowState` and the vault balance (AC-2, CD-3).
 * NEVER throws. `{ ok:false }` on: bad input, account not found, decode failure,
 * or any RPC error → the caller MUST reject the release without signing.
 */
export async function readEscrowState(input: {
  readonly sender: string;
  readonly remittanceId: string;
  readonly connection: EscrowReadConnection;
  readonly programId?: string;
}): Promise<ReadEscrowResult> {
  try {
    const programId = new PublicKey(input.programId ?? ESCROW_PROGRAM_ID_DEFAULT);
    const senderPk = new PublicKey(input.sender);
    const escrowStatePda = deriveEscrowStatePda(senderPk, input.remittanceId, programId);

    const account = await input.connection.getAccountInfo(escrowStatePda);
    if (account === null) {
      return { ok: false, reason: 'ESCROW_STATE_NOT_FOUND' };
    }

    // DT-4b: decode the ACCOUNT with the pinned IDL coder (never the tx — CD-12).
    const coder = new BorshAccountsCoder(escrowIdl as unknown as Idl);
    const raw = coder.decode('EscrowState', account.data) as EscrowStateRaw;

    const mintPk = raw.mint;
    const vault = deriveAta(escrowStatePda, mintPk);
    const balance = await input.connection.getTokenAccountBalance(vault);
    const vaultAmount = balance.value.amount; // decimal string (CD-18)

    const state: EscrowStateDecoded = {
      sender: raw.sender.toBase58(),
      beneficiary: raw.beneficiary.toBase58(),
      authority: raw.authority.toBase58(),
      mint: mintPk.toBase58(),
      amount: raw.amount.toString(), // BN → decimal string (NEVER Number)
      deadline: raw.deadline.toString(),
      status: normalizeStatus(raw.status),
      bump: raw.bump,
      escrowStatePda: escrowStatePda.toBase58(),
      vault: vault.toBase58(),
    };

    return { ok: true, state, vaultAmount };
  } catch {
    // Any throw (bad base58, decode mismatch, RPC error) → fail-closed reject.
    return { ok: false, reason: 'ESCROW_READ_FAILED' };
  }
}

/**
 * Verify the escrow is releasable (AC-2): `status==Deposited`, `mint==configured
 * USDC`, and the vault holds AT LEAST `state.amount`. Comparison is on `amount` as
 * an arbitrary-precision BigInt (decimal u64, CD-18) — never `Number` (no precision
 * loss). Pure, never throws.
 *
 * MNR-2 (griefing/DoS fix): the vault is the ATA of the `escrow_state` PDA — a
 * PUBLIC token account. ANYONE can transfer dust into it, making `vaultAmount >
 * state.amount` permanently. A strict `!==` would then block the release FOREVER
 * (VAULT_AMOUNT_MISMATCH) — a cheap DoS of the money-path happy-path. We accept
 * `vaultAmount >= state.amount`: it is SAFE because the on-chain `release` ix
 * transfers EXACTLY `escrow_state.amount` to the beneficiary (see solana-programs
 * escrow `release`: `let amount = escrow_state.amount; token::transfer(_, amount)`),
 * so any excess dust stays inert in the vault and NEVER inflates the released
 * amount. Only a DEFICIT (`vaultAmount < state.amount`, i.e. a drained/partial
 * vault) is still rejected — the release must never sign against an underfunded
 * vault.
 */
export function verifyVault(
  state: EscrowStateDecoded,
  vaultAmount: string,
  usdcMint: string,
): VerifyVaultResult {
  if (state.status !== 'Deposited') return { ok: false, reason: 'STATUS_NOT_DEPOSITED' };
  if (state.mint !== usdcMint) return { ok: false, reason: 'MINT_MISMATCH' };
  if (BigInt(vaultAmount) < BigInt(state.amount)) {
    return { ok: false, reason: 'VAULT_AMOUNT_MISMATCH' };
  }
  return { ok: true };
}
