/**
 * WKH-216 / HU-SOL-13 — Wave 13c: build the `release` transaction server-side.
 *
 * Assembles the escrow `release` ix ENTIRELY from on-chain `EscrowState` data
 * (beneficiary/sender/mint come from `state`, NEVER from the request body — CD-4),
 * sets `feePayer = release-authority`, attaches a fresh blockhash, and serializes
 * base64 for `cosignAndBroadcast` (HU-SOL-14). The tx has ONE signer (authority),
 * which `cosignAndBroadcast` adds — this builder NEVER signs (CD-11).
 *
 * The ix is assembled with raw `@solana/web3.js` (discriminator + accounts pinned
 * from release-shape.ts / AH-11), NOT anchor: anchor is used ONLY to decode the
 * account (13b). This keeps the build deterministic and dependency-light.
 *
 * Boundary: imports `@solana/web3.js`, `./release-shape.js`, and the READ helpers
 * `deriveAta`/`remittanceIdToBytes16` from `../../chains/solana-escrow.js` (PDA/ATA
 * parity with 13b). No env, no route, no keypair.
 */

import { PublicKey, Transaction, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RELEASE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
} from './release-shape.js';
import {
  deriveAta,
  remittanceIdToBytes16,
  type EscrowStateDecoded,
} from '../../chains/solana-escrow.js';

export interface BuildReleaseInput {
  /** On-chain state (13b) — the ONLY source of beneficiary/sender/mint (CD-4). */
  readonly state: EscrowStateDecoded;
  /** The remittanceId (server-only) — re-derived into the `[u8;16]` ix arg. */
  readonly remittanceId: string;
  /** Release-authority pubkey (== feePayer == the only signer). */
  readonly authority: PublicKey;
  /** Fresh recent blockhash (fetched by the route in the same invocation). */
  readonly recentBlockhash: string;
  /** Escrow program id (whitelisted). */
  readonly escrowProgramId: string;
}

/**
 * Build + serialize (base64) the unsigned `release` transaction. NEVER signs.
 * The returned base64 is fed to `cosignAndBroadcast`, which validates it via
 * `validateReleaseForSponsor(state)` and only then co-signs as the authority.
 */
export function buildReleaseTx(input: BuildReleaseInput): string {
  const programId = new PublicKey(input.escrowProgramId);
  const authority = input.authority;
  const sender = new PublicKey(input.state.sender);
  const beneficiary = new PublicKey(input.state.beneficiary);
  const mint = new PublicKey(input.state.mint);
  const escrowState = new PublicKey(input.state.escrowStatePda);
  const vault = new PublicKey(input.state.vault);
  const beneficiaryAta = deriveAta(beneficiary, mint);

  // Account order = AH-11 (verified against solana-programs Release<'info>).
  const keys: AccountMeta[] = [
    { pubkey: authority, isSigner: true, isWritable: false }, // 0 authority (signer)
    { pubkey: sender, isSigner: false, isWritable: false }, // 1 sender
    { pubkey: beneficiary, isSigner: false, isWritable: false }, // 2 beneficiary
    { pubkey: mint, isSigner: false, isWritable: false }, // 3 mint
    { pubkey: escrowState, isSigner: false, isWritable: true }, // 4 escrow_state (pda)
    { pubkey: vault, isSigner: false, isWritable: true }, // 5 vault
    { pubkey: beneficiaryAta, isSigner: false, isWritable: true }, // 6 beneficiary_ata
    { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // 7
    { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // 8
  ];

  // ix data = 8-byte discriminator + remittance_id [u8;16] (the only arg).
  const data = Buffer.concat([
    Buffer.from([...RELEASE_DISCRIMINATOR]),
    remittanceIdToBytes16(input.remittanceId),
  ]);

  const ix = new TransactionInstruction({ programId, keys, data });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority; // release-authority pays the fee AND is the sole signer
  tx.recentBlockhash = input.recentBlockhash;

  // Serialize UNSIGNED — cosignAndBroadcast adds the authority signature (CD-11).
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
