/**
 * WKH-216 / HU-SOL-13 — Wave 13c: Solana escrow release-authority key singleton (opt-in-off).
 *
 * Mirror of `src/infra/solana-fee-payer.ts` (AH-24). Exposes a lazily-built,
 * cached `Keypair` derived from `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`. In
 * the escrow `release` this keypair is BOTH the `authority` (the only signer) AND
 * the feePayer, so `cosignAndBroadcast` injects it as `feePayerKeypair` (CD-11).
 *
 * KEY FORMAT: JSON byte-array of length 64 (Solana CLI keypair format), decoded
 * WITHOUT any extra dependency:
 *     Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))
 *
 * OPT-IN-OFF (CD-5): the key is read DIRECTLY from `process.env` (not the Zod
 * EnvConfig), and `isReleaseEnabled()` returns true ONLY when the flag is 'true'
 * AND the key is present and parseable. Without both, `src/app.ts` does NOT
 * register the `/solana/escrow/release` route → the EVM suite is byte-identical
 * (CD-2, TF8).
 *
 * SECURITY (CD-6): the private key is read from a dedicated env, NEVER hardcoded,
 * NEVER logged, NEVER included in a thrown error (throw carries only the env NAME,
 * never its value). Do NOT log the returned Keypair.
 *
 * Boundary: reads `process.env` directly and imports ONLY `@solana/web3.js`. It
 * does NOT import `src/infra/env.ts`.
 */

import { Keypair } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';

/** Env var name — referenced by NAME only (never its secret value). */
const RELEASE_AUTHORITY_KEY_ENV = 'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY';

/** Flag env — must be exactly 'true' to opt in. */
const RELEASE_ENABLED_ENV = 'SOLANA_ESCROW_RELEASE_ENABLED';

/** Expected length of the Solana CLI keypair byte-array. */
const SECRET_KEY_BYTE_LENGTH = 64;

let _cached: Keypair | null = null;

/**
 * Error thrown when the release-authority key is missing or malformed. Carries
 * the env NAME only — never the value (absent or a secret byte-array).
 */
export class ReleaseAuthorityKeyError extends Error {
  constructor(envName: string, detail: string) {
    super(`${envName}: ${detail}`);
    this.name = 'ReleaseAuthorityKeyError';
  }
}

/**
 * Parse the JSON byte-array (length 64) into a `Keypair`. Fail-closed: any shape
 * deviation throws a `ReleaseAuthorityKeyError` carrying the env NAME, never the
 * value. Not exported — callers use `getReleaseAuthorityKeypair`.
 */
function parseReleaseAuthorityKeypair(raw: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do NOT include `raw` (the secret) in the message.
    throw new ReleaseAuthorityKeyError(
      RELEASE_AUTHORITY_KEY_ENV,
      'must be a JSON byte-array of length 64',
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_BYTE_LENGTH) {
    throw new ReleaseAuthorityKeyError(
      RELEASE_AUTHORITY_KEY_ENV,
      'must be a JSON byte-array of length 64',
    );
  }
  for (const b of parsed) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new ReleaseAuthorityKeyError(
        RELEASE_AUTHORITY_KEY_ENV,
        'byte-array elements must be 0..255 integers',
      );
    }
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    // web3.js rejects an invalid secret key (bad length / not on curve). No echo.
    throw new ReleaseAuthorityKeyError(
      RELEASE_AUTHORITY_KEY_ENV,
      'is not a valid Solana secret key',
    );
  }
}

/**
 * Return the singleton release-authority `Keypair`, building it lazily on first
 * call. Throws `ReleaseAuthorityKeyError('SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY', ...)`
 * when the env is missing or malformed — the message never contains the secret.
 */
export function getReleaseAuthorityKeypair(): Keypair {
  if (_cached) return _cached;
  const raw = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  if (raw === undefined || raw.length === 0) {
    throw new ReleaseAuthorityKeyError(RELEASE_AUTHORITY_KEY_ENV, 'is not set');
  }
  _cached = parseReleaseAuthorityKeypair(raw);
  return _cached;
}

/** Convenience: the release-authority public key (safe to log — it is public). */
export function getReleaseAuthorityPubkey(): PublicKey {
  return getReleaseAuthorityKeypair().publicKey;
}

/**
 * Opt-in gate (CD-5). Returns true ONLY when the flag env is exactly 'true' AND
 * the secret key is present and parses cleanly. Reads `process.env` directly so
 * `src/app.ts` decides route registration with the same source the Keypair uses.
 * NEVER throws — a malformed/absent key yields `false` (opt-in-off, byte-identical
 * EVM boot, TF8).
 */
export function isReleaseEnabled(): boolean {
  if (process.env.SOLANA_ESCROW_RELEASE_ENABLED !== 'true') return false;
  const raw = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  if (raw === undefined || raw.length === 0) return false;
  try {
    getReleaseAuthorityKeypair();
    return true;
  } catch {
    return false;
  }
}

/** Flag/key env names exposed for docs/tests (values are never read from here). */
export const RELEASE_ENV_NAMES = {
  KEY: RELEASE_AUTHORITY_KEY_ENV,
  FLAG: RELEASE_ENABLED_ENV,
} as const;

/**
 * @internal — tests only. Resets the cached Keypair so subsequent calls re-read
 * `process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`. Mirrors
 * `resetFeePayerForTesting`.
 */
export function resetReleaseAuthorityForTesting(): void {
  _cached = null;
}
