/**
 * WKH-302 — Solana PAYOUT-OPERATOR key singleton (opt-in-off).
 *
 * Mirror of `src/infra/solana-release-authority.ts`, for a DIFFERENT power. The
 * fee-payer and the release-authority co-sign transactions someone else built; this
 * keypair ORIGINATES a transfer out of the facilitator's own ATA. It is the only
 * key in this service that owns the settlement treasury.
 *
 * KEY FORMAT: JSON byte-array of length 64 (Solana CLI keypair format), decoded
 * WITHOUT any extra dependency:
 *     Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))
 *
 * ⚠️ THE FORMAT DIFFERS FROM THE GATEWAY'S ON PURPOSE. The gateway's
 * `SOLANA_OPERATOR_PRIVATE_KEY` is base58; this one is a JSON byte-array. An
 * accidental copy-paste of one env into the other does NOT parse. That asymmetry is
 * a feature — do not "unify" it. And the key itself must be FRESHLY MINTED, never
 * the gateway's material re-encoded: that material already lived in the gateway's
 * environment, deploys and history, so moving it without rotating leaves intact
 * exactly the risk this HU exists to close.
 *
 * OPT-IN-OFF: the key is read DIRECTLY from `process.env` (not the Zod EnvConfig),
 * and `isSolanaPayoutEnabled()` returns true ONLY when the flag is 'true' AND the
 * key is present, parseable, and DISTINCT from the other two Solana keys. Without
 * all of that, `src/app.ts` does NOT register `POST /solana/payout` → the EVM boot
 * stays byte-identical (AC-4) and the route 404s.
 *
 * SECURITY: the private key is read from a dedicated env, NEVER hardcoded, NEVER
 * logged, NEVER included in a thrown error (a throw carries only the env NAME).
 * Do NOT log the returned Keypair.
 *
 * Boundary: reads `process.env` directly and imports ONLY `@solana/web3.js` plus the
 * other two key modules (for the AC-11 comparison). It does NOT import
 * `src/infra/env.ts`, `src/core/*` nor `src/routes/*`.
 */

import { Keypair } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import { getFeePayerKeypair } from './solana-fee-payer.js';
import { getReleaseAuthorityKeypair } from './solana-release-authority.js';

/** Env var name — referenced by NAME only (never its secret value). */
const PAYOUT_OPERATOR_KEY_ENV = 'SOLANA_PAYOUT_OPERATOR_SECRET_KEY';

/** Flag env — must be exactly 'true' to opt in. */
const PAYOUT_ENABLED_ENV = 'SOLANA_PAYOUT_ENABLED';

/** Expected length of the Solana CLI keypair byte-array. */
const SECRET_KEY_BYTE_LENGTH = 64;

let _cached: Keypair | null = null;

/**
 * Error thrown when the payout-operator key is missing or malformed. Carries the
 * env NAME only — never the value (absent or a secret byte-array).
 */
export class PayoutOperatorKeyError extends Error {
  constructor(envName: string, detail: string) {
    super(`${envName}: ${detail}`);
    this.name = 'PayoutOperatorKeyError';
  }
}

/**
 * Parse the JSON byte-array (length 64) into a `Keypair`. Fail-closed: any shape
 * deviation throws a `PayoutOperatorKeyError` carrying the env NAME, never the
 * value. Not exported — callers use `getPayoutOperatorKeypair`.
 */
function parsePayoutOperatorKeypair(raw: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do NOT include `raw` (the secret) in the message.
    throw new PayoutOperatorKeyError(
      PAYOUT_OPERATOR_KEY_ENV,
      'must be a JSON byte-array of length 64',
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_BYTE_LENGTH) {
    throw new PayoutOperatorKeyError(
      PAYOUT_OPERATOR_KEY_ENV,
      'must be a JSON byte-array of length 64',
    );
  }
  for (const b of parsed) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new PayoutOperatorKeyError(
        PAYOUT_OPERATOR_KEY_ENV,
        'byte-array elements must be 0..255 integers',
      );
    }
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    // web3.js rejects an invalid secret key (bad length / not on curve). No echo.
    throw new PayoutOperatorKeyError(PAYOUT_OPERATOR_KEY_ENV, 'is not a valid Solana secret key');
  }
}

/**
 * Return the singleton payout-operator `Keypair`, building it lazily on first call.
 * Throws `PayoutOperatorKeyError('SOLANA_PAYOUT_OPERATOR_SECRET_KEY', ...)` when the
 * env is missing or malformed — the message never contains the secret.
 */
export function getPayoutOperatorKeypair(): Keypair {
  if (_cached) return _cached;
  const raw = process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
  if (raw === undefined || raw.length === 0) {
    throw new PayoutOperatorKeyError(PAYOUT_OPERATOR_KEY_ENV, 'is not set');
  }
  _cached = parsePayoutOperatorKeypair(raw);
  return _cached;
}

/** Convenience: the payout-operator public key (safe to log — it is public). */
export function getPayoutOperatorPubkey(): PublicKey {
  return getPayoutOperatorKeypair().publicKey;
}

/**
 * Resolve another Solana key's pubkey WITHOUT letting its absence matter. Each of
 * the two comparison keys lives behind its own try/catch: if that key is not
 * configured there is no collision possible, and that is NOT a reason to disable
 * payouts. Returns null when the key is absent or unparseable.
 */
function pubkeyOrNull(resolve: () => Keypair): string | null {
  try {
    return resolve().publicKey.toBase58();
  } catch {
    return null;
  }
}

/**
 * Opt-in gate. Returns true ONLY when, in this exact order:
 *   1. `SOLANA_PAYOUT_ENABLED` is exactly 'true'
 *   2. `SOLANA_PAYOUT_OPERATOR_SECRET_KEY` is present and non-empty
 *   3. it parses into a Keypair
 *   4. its pubkey differs from the sponsorship FEE-PAYER's          (AC-11)
 *   5. its pubkey differs from the escrow RELEASE-AUTHORITY's       (AC-11)
 *
 * ⚠️ Why steps 4-5 are code and not a comment (AC-11 / DT-1): separating the
 * instruments is a blast-radius decision. The fee-payer merely co-signs the NETWORK
 * COST of a tx it did not originate and whose contents it validated first; it never
 * owns the funds being moved and holds cents of SOL. The payout operator ORIGINATES
 * the transfer instruction and owns the ATA holding the entire settlement balance.
 * Fusing them extends a compromise of the cheap key to the whole treasury. A comment
 * saying "use a different key" does not stop a copy-paste in Railway; this does — a
 * misconfiguration turns the feature OFF instead of silently merging two powers.
 *
 * The comparison is between PUBKEYS, not between env strings: two different
 * encodings of the same secret must collide all the same.
 *
 * NEVER throws — any problem yields `false` (opt-in-off).
 */
export function isSolanaPayoutEnabled(): boolean {
  if (process.env.SOLANA_PAYOUT_ENABLED !== 'true') return false;
  const raw = process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
  if (raw === undefined || raw.length === 0) return false;

  let payoutPubkey: string;
  try {
    payoutPubkey = getPayoutOperatorKeypair().publicKey.toBase58();
  } catch {
    return false;
  }

  // AC-11 — fail-closed on key reuse. Only PUBLIC pubkeys are ever compared, so
  // nothing secret is derivable from this branch (and we log nothing here at all).
  const feePayerPubkey = pubkeyOrNull(getFeePayerKeypair);
  if (feePayerPubkey !== null && feePayerPubkey === payoutPubkey) return false;

  const releasePubkey = pubkeyOrNull(getReleaseAuthorityKeypair);
  if (releasePubkey !== null && releasePubkey === payoutPubkey) return false;

  return true;
}

/** Flag/key env names exposed for docs/tests (values are never read from here). */
export const PAYOUT_ENV_NAMES = {
  KEY: PAYOUT_OPERATOR_KEY_ENV,
  FLAG: PAYOUT_ENABLED_ENV,
} as const;

/**
 * @internal — tests only. Resets the cached Keypair so subsequent calls re-read
 * `process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY`. Mirrors `resetFeePayerForTesting`.
 */
export function resetPayoutOperatorForTesting(): void {
  _cached = null;
}
