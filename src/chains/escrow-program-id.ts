/**
 * CD-15 — THE single source of the escrow program id.
 *
 * The program id lives in exactly ONE place in the codebase: `escrowIdl.address`
 * (src/chains/escrow-idl.ts), the vendored copy of the Anchor IDL emitted by
 * solana-programs. Every consumer (CR-1 deposit/release shapes, the PDA
 * derivation, the `SOLANA_ESCROW_PROGRAM_ID` env default) MUST derive from this
 * module — never re-type the base58 string.
 *
 * WHY (this is not cosmetic): the program id already changed once for real. The
 * previous binary (BBQ9…79WA) was never deployed and its keypair was lost, so the
 * escrow had to be rebuilt under a new address and hand-updated across three
 * repos. A copy that is missed on the next rotation makes the facilitator sign
 * against the WRONG program. With a single derived source there is nothing to
 * miss: regenerating `escrow-idl.ts` moves every consumer at once.
 *
 * Boundary: imports ONLY `./escrow-idl.js`, a dependency-free data module. This
 * keeps CD-12 intact — pulling the program id in does NOT drag `@coral-xyz/anchor`
 * nor `@solana/web3.js` into the raw-bytes CR-1 validation path.
 *
 * The literal itself is guarded by two tests that must NOT be conflated:
 *   - escrow-idl.hash.test.ts — the LOCK: pins the expected value so an
 *     accidental id change goes red. It is SUPPOSED to hold a literal.
 *   - escrow-program-id.test.ts — the ANTI-DUPLICATION guard: fails if the
 *     literal reappears anywhere outside the source and the lock.
 */

import { escrowIdl } from './escrow-idl.js';

/**
 * Default escrow program id (base58 pubkey, public on-chain address), derived
 * from the pinned IDL. Overridable at runtime via `SOLANA_ESCROW_PROGRAM_ID`.
 */
export const ESCROW_PROGRAM_ID_DEFAULT: string = escrowIdl.address;
