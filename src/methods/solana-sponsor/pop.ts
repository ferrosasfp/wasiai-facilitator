/**
 * WKH-217 / HU-SOL-14 — PoP/KYC attestation verification (AC-7, fail-closed).
 *
 * The sponsorship route must reject BEFORE parsing/signing when the request
 * carries no valid proof-of-personhood / KYC attestation for the sender. The
 * proof is an HMAC-SHA256 over the sender pubkey keyed by a secret shared with
 * chaski (`SOLANA_SPONSOR_POP_SECRET`).
 *
 * FAIL-CLOSED (mirrors `src/infra/solana-dedup.ts`): when the secret is unset,
 * `verifySponsorPop` rejects EVERY request. The comparison is timing-safe
 * (`crypto.timingSafeEqual`, same pattern as `src/middleware/auth.ts`).
 *
 * SECURITY: never logs the secret or the proof. Boundary: `node:crypto` only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the expected attestation for a sender pubkey. Exported so chaski's
 * companion (W3, another repo) can mirror it; here it is the reference.
 */
export function computeSponsorPop(senderPubkey: string, secret: string): string {
  return createHmac('sha256', secret).update(senderPubkey).digest('hex');
}

/**
 * Verify a PoP attestation. Fail-closed: returns false when the secret is unset,
 * the proof is empty, or the HMAC does not match. Timing-safe comparison.
 */
export function verifySponsorPop(
  proof: string,
  senderPubkey: string,
  secret: string | undefined,
): boolean {
  // Fail-closed: no secret configured → reject everything (AC-7 / CD-6).
  if (secret === undefined || secret.length === 0) return false;
  if (proof.length === 0 || senderPubkey.length === 0) return false;

  const expected = computeSponsorPop(senderPubkey, secret);
  const a = Buffer.from(proof);
  const b = Buffer.from(expected);
  // Length itself is not secret; a mismatch is a direct non-match (timingSafeEqual
  // throws on unequal lengths — mirror the auth.ts guard).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
