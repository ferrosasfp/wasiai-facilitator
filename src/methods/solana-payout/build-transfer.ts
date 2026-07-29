/**
 * WKH-302 — build the SPL payout transaction the facilitator ORIGINATES.
 *
 * Assembles, in ONE transaction: an optional ATA `CreateIdempotent` for the
 * DESTINATION plus a `TransferChecked` from the payout operator's ATA to the
 * agent's. `feePayer` is the payout operator, which is also the transfer authority
 * and the sole signer — added later by `cosignAndBroadcast`. This builder NEVER
 * signs.
 *
 * Two decisions that look like details and are not:
 *
 * 1. **The destination ATA is created IN THE SAME TX**, never in a separate one.
 *    If the create landed and the transfer did not, we would have paid rent and
 *    paid the agent nothing.
 * 2. **The SOURCE ATA is NEVER auto-created.** If it does not exist, the operator
 *    has no funds — that is `PAYOUT_FUNDING_LOW`, not something to fix by spending.
 *    This corrects an asymmetry in the gateway's current path, where
 *    `getOrCreateAssociatedTokenAccount(...)` on the operator's OWN ATA hid a
 *    "no funds" behind a rent expense.
 *
 * The ix is assembled with raw `@solana/web3.js` (tags/programs pinned in
 * `payout-shape.ts`), NOT anchor and NOT `@solana/spl-token` — CD-12 and the
 * no-new-dependencies rule.
 *
 * Boundary: imports `@solana/web3.js`, `./payout-shape.js`, and `deriveAta` from
 * `../../chains/solana-escrow.js` (the repo's canonical ATA derivation — do not
 * re-implement it). No env, no route, no keypair.
 */

import { PublicKey, Transaction, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ATA_CREATE_IDEMPOTENT_TAG,
  SPL_TRANSFER_CHECKED_TAG,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './payout-shape.js';
import { deriveAta } from '../../chains/solana-escrow.js';

export interface BuildPayoutInput {
  /** feePayer AND the transfer authority — the same key (it owns the source ATA). */
  readonly payoutOperator: PublicKey;
  /** The agent's wallet (owner of the destination ATA), NOT the ATA itself. */
  readonly payTo: PublicKey;
  readonly mint: PublicKey;
  readonly decimals: number;
  readonly amountAtomic: bigint;
  readonly recentBlockhash: string;
  /** Prepend the destination ATA `CreateIdempotent` (decided by an on-chain read). */
  readonly createDestinationAta: boolean;
}

/**
 * Build + serialize (base64) the UNSIGNED payout transaction. Never signs. The
 * result is fed to `cosignAndBroadcast`, which re-parses it, runs
 * `validatePayoutTx(expected)` and only then lets the operator key sign.
 */
export function buildPayoutTx(input: BuildPayoutInput): string {
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
  const systemProgram = new PublicKey(SYSTEM_PROGRAM_ID);

  const sourceAta = deriveAta(input.payoutOperator, input.mint);
  const destinationAta = deriveAta(input.payTo, input.mint);

  const tx = new Transaction();

  if (input.createDestinationAta) {
    // Associated Token Program `CreateIdempotent` (data = [1]): a no-op when the
    // account already exists, so a race with another creator cannot fail the tx.
    const createKeys: AccountMeta[] = [
      { pubkey: input.payoutOperator, isSigner: true, isWritable: true }, // 0 funding
      { pubkey: destinationAta, isSigner: false, isWritable: true }, // 1 associated account
      { pubkey: input.payTo, isSigner: false, isWritable: false }, // 2 wallet owner
      { pubkey: input.mint, isSigner: false, isWritable: false }, // 3 mint
      { pubkey: systemProgram, isSigner: false, isWritable: false }, // 4 system program
      { pubkey: tokenProgram, isSigner: false, isWritable: false }, // 5 token program
    ];
    tx.add(
      new TransactionInstruction({
        programId: ataProgram,
        keys: createKeys,
        data: Buffer.from([ATA_CREATE_IDEMPOTENT_TAG]),
      }),
    );
  }

  // SPL `TransferChecked` (tag 12): amount as u64 LITTLE-ENDIAN derived from a
  // BigInt (never from a number — CD-10), followed by the decimals byte. Carrying
  // mint+decimals inside the ix is what makes the SPL runtime itself reject a
  // source ATA of the wrong mint.
  const data = Buffer.alloc(10);
  data.writeUInt8(SPL_TRANSFER_CHECKED_TAG, 0);
  data.writeBigUInt64LE(input.amountAtomic, 1);
  data.writeUInt8(input.decimals, 9);

  const transferKeys: AccountMeta[] = [
    { pubkey: sourceAta, isSigner: false, isWritable: true }, // 0 source
    { pubkey: input.mint, isSigner: false, isWritable: false }, // 1 mint
    { pubkey: destinationAta, isSigner: false, isWritable: true }, // 2 destination
    { pubkey: input.payoutOperator, isSigner: true, isWritable: false }, // 3 authority
  ];
  tx.add(new TransactionInstruction({ programId: tokenProgram, keys: transferKeys, data }));

  tx.feePayer = input.payoutOperator;
  tx.recentBlockhash = input.recentBlockhash;

  // Serialize UNSIGNED — cosignAndBroadcast adds the operator signature.
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
