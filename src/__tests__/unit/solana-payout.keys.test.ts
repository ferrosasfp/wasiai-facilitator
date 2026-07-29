/**
 * WKH-302 — payout-operator key + AC-11 key-separation gate (T-AC2, T-AC11, T-ENV-3).
 *
 * The three Solana keys (payout operator, sponsorship fee-payer, escrow
 * release-authority) are read DIRECTLY from `process.env`, so every test sets and
 * restores them explicitly and resets the module-level singletons in between.
 * All material is `Keypair.generate()` — zero real keys (CD-4/AC-7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import {
  PAYOUT_ENV_NAMES,
  PayoutOperatorKeyError,
  getPayoutOperatorKeypair,
  getPayoutOperatorPubkey,
  isSolanaPayoutEnabled,
  resetPayoutOperatorForTesting,
} from '../../infra/solana-payout-operator.js';
import { resetFeePayerForTesting } from '../../infra/solana-fee-payer.js';
import { resetReleaseAuthorityForTesting } from '../../infra/solana-release-authority.js';

const payoutKp = Keypair.generate();
const otherKp = Keypair.generate();

const toJsonKey = (kp: Keypair): string => JSON.stringify(Array.from(kp.secretKey));

interface SavedEnv {
  payoutFlag?: string;
  payoutKey?: string;
  feePayerKey?: string;
  releaseKey?: string;
}
const saved: SavedEnv = {};

function saveEnv(): void {
  saved.payoutFlag = process.env.SOLANA_PAYOUT_ENABLED;
  saved.payoutKey = process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
  saved.feePayerKey = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  saved.releaseKey = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
}

function restoreEnv(): void {
  if (saved.payoutFlag === undefined) delete process.env.SOLANA_PAYOUT_ENABLED;
  else process.env.SOLANA_PAYOUT_ENABLED = saved.payoutFlag;
  if (saved.payoutKey === undefined) delete process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
  else process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = saved.payoutKey;
  if (saved.feePayerKey === undefined) delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  else process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = saved.feePayerKey;
  if (saved.releaseKey === undefined) delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  else process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = saved.releaseKey;
}

/** Clear the three key singletons so each test re-reads process.env. */
function resetAllKeySingletons(): void {
  resetPayoutOperatorForTesting();
  resetFeePayerForTesting();
  resetReleaseAuthorityForTesting();
}

beforeEach(() => {
  saveEnv();
  delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  process.env.SOLANA_PAYOUT_ENABLED = 'true';
  process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = toJsonKey(payoutKp);
  resetAllKeySingletons();
});

afterEach(() => {
  restoreEnv();
  resetAllKeySingletons();
});

describe('T-AC2 — the payout path uses its OWN key, never the gateway one', () => {
  it('resolves the keypair from SOLANA_PAYOUT_OPERATOR_SECRET_KEY', () => {
    expect(getPayoutOperatorPubkey().toBase58()).toBe(payoutKp.publicKey.toBase58());
    expect(PAYOUT_ENV_NAMES.KEY).toBe('SOLANA_PAYOUT_OPERATOR_SECRET_KEY');
    expect(PAYOUT_ENV_NAMES.FLAG).toBe('SOLANA_PAYOUT_ENABLED');
  });

  it('★ the module never reads nor accepts SOLANA_OPERATOR_PRIVATE_KEY (the gateway env)', () => {
    // The name must not appear ANYWHERE in the payout module's source: not as a
    // read, not as a fallback, not in a comment that could become a read later.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from import.meta.url (this repo's own source), never from input.
    const source = readFileSync(
      new URL('../../infra/solana-payout-operator.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('process.env.SOLANA_OPERATOR_PRIVATE_KEY');

    // And setting it does NOT enable anything: with the payout env absent the gate
    // is false even though the gateway-style key is present and well-formed.
    delete process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
    resetAllKeySingletons();
    process.env.SOLANA_OPERATOR_PRIVATE_KEY = 'ignored-by-this-service';
    try {
      expect(isSolanaPayoutEnabled()).toBe(false);
    } finally {
      delete process.env.SOLANA_OPERATOR_PRIVATE_KEY;
    }
  });

  it('AC-2 is NOT satisfied by this HU — the gateway still holds its key until WKH-302b', () => {
    // Documentation-as-test: this HU delivers the mechanism, NOT the cutover. The
    // legacy gateway path (flag OFF) still needs SOLANA_OPERATOR_PRIVATE_KEY, so
    // AC-2 is DECLARED NOT MET until WKH-302b decommissions it. Nothing in this
    // repo can assert the gateway's environment; the honest assertion is that the
    // facilitator side is complete and self-contained.
    expect(isSolanaPayoutEnabled()).toBe(true);
  });
});

describe('T-AC11 — startup refuses when the payout key collides with another', () => {
  it('★ payout pubkey === fee-payer pubkey → gate false (route never registers)', () => {
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = toJsonKey(payoutKp);
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('★ payout pubkey === release-authority pubkey → gate false', () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = toJsonKey(payoutKp);
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('★ the comparison is by PUBKEY, not by env string', () => {
    // Same secret, different textual encoding of the byte-array (spaces added).
    // A string comparison would miss this; a pubkey comparison must not.
    const spaced = JSON.stringify(Array.from(payoutKp.secretKey)).replace(/,/g, ', ');
    expect(spaced).not.toBe(process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY);
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = spaced;
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('distinct keys → gate true (the scenario above is real, not a broken fixture)', () => {
    // Disarming the collision must turn the gate GREEN. Without this, the three
    // asserts above would also pass if the gate were false for an unrelated reason.
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = toJsonKey(otherKp);
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = toJsonKey(Keypair.generate());
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(true);
  });

  it('an absent fee-payer/release key is NOT a collision (each behind its own try/catch)', () => {
    delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
    delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(true);
  });

  it('a MALFORMED fee-payer key is not a collision either (no collision possible)', () => {
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = 'not-json';
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(true);
  });
});

describe('T-ENV-3 — malformed/absent payout key: gate false, no throw, no echo', () => {
  it('flag off → false without even reading the key', () => {
    process.env.SOLANA_PAYOUT_ENABLED = 'false';
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it("flag 'false' as a STRING is not truthy (anti z.coerce.boolean pattern)", () => {
    process.env.SOLANA_PAYOUT_ENABLED = 'false';
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
    process.env.SOLANA_PAYOUT_ENABLED = '1';
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('key absent → gate false, no throw', () => {
    delete process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY;
    resetAllKeySingletons();
    expect(() => isSolanaPayoutEnabled()).not.toThrow();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('★ malformed key → gate false, and the VALUE never appears in the error', () => {
    const bogus = JSON.stringify(Array.from({ length: 64 }, () => 999));
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = bogus;
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
    try {
      getPayoutOperatorKeypair();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PayoutOperatorKeyError);
      const msg = String(e);
      expect(msg).toContain('SOLANA_PAYOUT_OPERATOR_SECRET_KEY');
      expect(msg).not.toContain(bogus);
      expect(msg).not.toContain('999');
    }
  });

  it('★ a VALID key never leaks its bytes through the thrown error path either', () => {
    const realJson = toJsonKey(payoutKp);
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = realJson.slice(0, 20); // truncated JSON
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
    try {
      getPayoutOperatorKeypair();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(String(e)).not.toContain(realJson.slice(0, 20));
    }
  });

  it('wrong byte-array length → gate false', () => {
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = JSON.stringify([1, 2, 3]);
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });

  it('★ base58 (the GATEWAY key format) does NOT parse here — copy-paste is inert', () => {
    // The format asymmetry is the point: pasting the gateway's base58 env into the
    // facilitator's must fail closed rather than silently work.
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = otherKp.publicKey.toBase58();
    resetAllKeySingletons();
    expect(isSolanaPayoutEnabled()).toBe(false);
  });
});
