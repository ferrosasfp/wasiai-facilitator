/**
 * WKH-302 — verify-before-trust for a previously recorded payout signature (CD-8).
 *
 * When the ledger says a payout for this intent already has a signature, the route
 * does NOT take the row's word for it: it re-reads the transaction on-chain and
 * recomputes the NET DELTA credited to `payTo` for `mint`. Only then does it return
 * that signature as an already-settled payment (AC-5).
 *
 * The delta is `post - pre` over the WHOLE transaction, so a later compensating
 * instruction is already reflected in the post balance. All arithmetic is BigInt on
 * `uiTokenAmount.amount`; `uiAmount` is NEVER read (CD-10) — it is a float and
 * rounds. Same criterion as the verify block of `src/chains/solana-adapter.ts`.
 *
 * NEVER throws: an RPC error yields `{ valid:false, reason }` so the caller can
 * fail closed instead of crashing mid-decision.
 *
 * Boundary: imports `@solana/web3.js` (type-only) + `./payout-shape.js`. No env, no
 * route, no keypair.
 */

import type { Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from './payout-shape.js';

export interface VerifyPayoutInput {
  readonly signature: string;
  readonly payTo: string; // base58 owner
  readonly mint: string; // base58
  readonly amountAtomic: string; // decimal STRING (CD-10)
}

/** Minimal shape we read off the parsed tx — narrower than the SDK's own type. */
interface TokenBalanceLike {
  readonly owner?: string | null;
  readonly mint?: string;
  readonly programId?: string;
  readonly uiTokenAmount?: { readonly amount?: string };
}

/**
 * Re-read `signature` on-chain and assert it credited AT LEAST `amountAtomic` of
 * `mint` to `payTo`. Returns `{ valid:false, reason }` for every negative outcome —
 * missing tx, on-chain error, no matching balance entry, short delta, RPC failure.
 */
export async function verifyPayoutSignature(
  connection: Connection,
  input: VerifyPayoutInput,
): Promise<{ valid: boolean; reason?: string }> {
  let expected: bigint;
  try {
    expected = BigInt(input.amountAtomic);
  } catch {
    return { valid: false, reason: 'BAD_EXPECTED_AMOUNT' };
  }

  let tx;
  try {
    tx = await connection.getParsedTransaction(input.signature, {
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return { valid: false, reason: 'RPC_ERROR' };
  }

  if (tx === null || tx === undefined || tx.meta === null || tx.meta === undefined) {
    return { valid: false, reason: 'TX_NOT_FOUND' };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    return { valid: false, reason: 'TX_FAILED_ON_CHAIN' };
  }

  const post: readonly TokenBalanceLike[] = tx.meta.postTokenBalances ?? [];
  const pre: readonly TokenBalanceLike[] = tx.meta.preTokenBalances ?? [];

  const matches = (e: TokenBalanceLike): boolean =>
    e.owner === input.payTo && e.mint === input.mint && e.programId === TOKEN_PROGRAM_ID;

  // Fall back to owner+mint (without the program-id pin) so a cluster that omits
  // programId does not turn a real payment into an unverifiable one; the amount
  // check below is what actually authorizes.
  const destPost =
    post.find(matches) ?? post.find((e) => e.owner === input.payTo && e.mint === input.mint);
  if (destPost === undefined) {
    return { valid: false, reason: 'NO_DESTINATION_BALANCE' };
  }
  const destPre =
    pre.find(matches) ?? pre.find((e) => e.owner === input.payTo && e.mint === input.mint);

  let delta: bigint;
  try {
    const postAmt = BigInt(destPost.uiTokenAmount?.amount ?? '0');
    const preAmt = destPre === undefined ? 0n : BigInt(destPre.uiTokenAmount?.amount ?? '0');
    delta = postAmt - preAmt;
  } catch {
    return { valid: false, reason: 'UNPARSEABLE_BALANCE' };
  }

  if (delta < expected) {
    return { valid: false, reason: 'DELTA_BELOW_EXPECTED' };
  }
  return { valid: true };
}
