/**
 * WKH-217 / HU-SOL-14 — Solana fee-payer key singleton (opt-in-off).
 *
 * The non-EVM analogue of `src/infra/wallet.ts` (`getOperatorAccount`). Exposes
 * a lazily-built, cached `Keypair` derived from `SOLANA_FEE_PAYER_PRIVATE_KEY`.
 * The `cosignAndBroadcast` primitive injects this Keypair to co-sign the
 * sponsored `deposit` after CR-1 validates it.
 *
 * KEY FORMAT (DT-8 / Anti-Hallucination Header): the env carries a JSON
 * byte-array of length 64 (the Solana CLI keypair format), decoded WITHOUT any
 * extra dependency:
 *     Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))
 * Base58 (which would need `bs58`) is intentionally out of scope.
 *
 * OPT-IN-OFF (CD-13, mirrors `src/chains/solana-adapter.ts:419-430`): the key is
 * read DIRECTLY from `process.env` (not the Zod EnvConfig), and `isSponsorEnabled()`
 * returns true ONLY when the flag is 'true' AND the key is present and parseable.
 * Without both, `src/app.ts` does NOT register the route → the EVM suite runs
 * byte-identically (AC-9).
 *
 * SECURITY (AC-10 / CD-7): the private key is read from a dedicated env, NEVER
 * hardcoded, NEVER logged, NEVER included in a thrown error (throw carries only
 * the env NAME, never its value — the `wallet.ts` pattern). The returned
 * `Keypair` object does not expose the raw byte-array in any log-friendly way;
 * do not log it.
 *
 * Boundary: this module reads `process.env` directly (like `solana-adapter.ts`)
 * and imports ONLY `@solana/web3.js`. It does NOT import `src/infra/env.ts`.
 */

import { Keypair } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';

/** Env var name — referenced by NAME only (never its secret value). */
const FEE_PAYER_KEY_ENV = 'SOLANA_FEE_PAYER_PRIVATE_KEY';

/** Expected length of the Solana CLI keypair byte-array. */
const SECRET_KEY_BYTE_LENGTH = 64;

let _cached: Keypair | null = null;

/**
 * Error thrown when the fee-payer key is missing or malformed. Carries the env
 * NAME only — never the value (which is either absent or a secret byte-array).
 */
export class FeePayerKeyError extends Error {
  constructor(envName: string, detail: string) {
    super(`${envName}: ${detail}`);
    this.name = 'FeePayerKeyError';
  }
}

/**
 * Parse the JSON byte-array (length 64) into a `Keypair`. Fail-closed: any
 * shape deviation throws a `FeePayerKeyError` carrying the env NAME, never the
 * value. Not exported — callers use `getFeePayerKeypair`.
 */
function parseFeePayerKeypair(raw: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do NOT include `raw` (the secret) in the message.
    throw new FeePayerKeyError(FEE_PAYER_KEY_ENV, 'must be a JSON byte-array of length 64');
  }
  if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_BYTE_LENGTH) {
    throw new FeePayerKeyError(FEE_PAYER_KEY_ENV, 'must be a JSON byte-array of length 64');
  }
  for (const b of parsed) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new FeePayerKeyError(FEE_PAYER_KEY_ENV, 'byte-array elements must be 0..255 integers');
    }
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    // web3.js rejects an invalid secret key (bad length / not on curve). No echo.
    throw new FeePayerKeyError(FEE_PAYER_KEY_ENV, 'is not a valid Solana secret key');
  }
}

/**
 * Return the singleton fee-payer `Keypair`, building it lazily on first call.
 * Throws `FeePayerKeyError('SOLANA_FEE_PAYER_PRIVATE_KEY', ...)` when the env is
 * missing or malformed — the message never contains the secret value.
 */
export function getFeePayerKeypair(): Keypair {
  if (_cached) return _cached;
  const raw = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  if (raw === undefined || raw.length === 0) {
    throw new FeePayerKeyError(FEE_PAYER_KEY_ENV, 'is not set');
  }
  _cached = parseFeePayerKeypair(raw);
  return _cached;
}

/** Convenience: the fee-payer public key (safe to log — it is a public pubkey). */
export function getFeePayerPubkey(): PublicKey {
  return getFeePayerKeypair().publicKey;
}

/**
 * Opt-in gate (CD-13). Returns true ONLY when the flag env is exactly 'true'
 * AND the private key is present and parses cleanly. Reads `process.env`
 * directly (never `src/infra/env.ts`) so `src/app.ts` can decide route
 * registration with the same source the Keypair uses. NEVER throws — a
 * malformed/absent key yields `false` (opt-in-off, byte-identical EVM boot).
 */
export function isSponsorEnabled(): boolean {
  if (process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED !== 'true') return false;
  const raw = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  if (raw === undefined || raw.length === 0) return false;
  try {
    getFeePayerKeypair();
    return true;
  } catch {
    return false;
  }
}

/**
 * @internal — tests only. Resets the cached Keypair so subsequent calls re-read
 * `process.env.SOLANA_FEE_PAYER_PRIVATE_KEY`. Mirrors `resetOperatorAccountForTesting`.
 */
export function resetFeePayerForTesting(): void {
  _cached = null;
}
