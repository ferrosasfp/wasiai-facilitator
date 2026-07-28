/**
 * CD-15 — anti-duplication guard for the escrow program id.
 *
 * Goes RED if anyone re-introduces the program id as a literal. This is the
 * complement of `escrow-idl.hash.test.ts`, and the two must NOT be conflated:
 *
 *   - escrow-idl.hash.test.ts = the LOCK. It pins the expected value on purpose,
 *     so an UNINTENDED id change (bad regeneration, wrong deploy) goes red. Its
 *     literal is the point of the test and must stay.
 *   - this file = the ANTI-DUPLICATION guard. It walks src/ and asserts the
 *     literal appears ONLY in the source (escrow-idl.ts) and in the lock. A copy
 *     anywhere else is what rotted last time the program id rotated.
 *
 * This file deliberately holds NO literal: the needle is read from
 * `escrowIdl.address`, so the guard can never become a copy of what it guards.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { escrowIdl } from './escrow-idl.js';
import { ESCROW_PROGRAM_ID_DEFAULT } from './escrow-program-id.js';
import { ESCROW_PROGRAM_ID_DEFAULT as DEPOSIT_SHAPE_ID } from '../methods/solana-sponsor/deposit-shape.js';
import { ESCROW_PROGRAM_ID_DEFAULT as RELEASE_SHAPE_ID } from '../methods/solana-escrow/release-shape.js';
import { ESCROW_PROGRAM_ID_DEFAULT as SOLANA_ESCROW_ID } from './solana-escrow.js';
import { EnvSchema } from '../infra/env.js';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files allowed to contain the program id literal, relative to src/.
 * Adding an entry here is a deliberate act that must be justified in review.
 */
const ALLOWED_LITERAL_FILES: readonly string[] = [
  // THE source: the vendored Anchor IDL. Regenerated from solana-programs.
  'chains/escrow-idl.ts',
  // THE lock: pins the expected value so an accidental change goes red.
  'chains/escrow-idl.hash.test.ts',
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only walk rooted at src/ (derived from import.meta.url); no external/user input.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('CD-15 · escrow program id has a single source', () => {
  it('every consumer derives from escrowIdl.address (no drift possible)', () => {
    expect(ESCROW_PROGRAM_ID_DEFAULT).toBe(escrowIdl.address);
    expect(DEPOSIT_SHAPE_ID).toBe(escrowIdl.address);
    expect(RELEASE_SHAPE_ID).toBe(escrowIdl.address);
    expect(SOLANA_ESCROW_ID).toBe(escrowIdl.address);
  });

  it('the SOLANA_ESCROW_PROGRAM_ID env default derives from escrowIdl.address', () => {
    const parsed = EnvSchema.parse({ NODE_ENV: 'test' });
    expect(parsed.SOLANA_ESCROW_PROGRAM_ID).toBe(escrowIdl.address);
  });

  it('the literal appears ONLY in the source and in the lock', () => {
    // Needle built at runtime from the source — never typed out here.
    const needle = escrowIdl.address;
    const offenders = listTsFiles(SRC_DIR)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only read of files enumerated from src/ itself; no external/user input.
      .filter((file) => readFileSync(file, 'utf8').includes(needle))
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join('/'))
      .sort();

    expect(offenders).toEqual([...ALLOWED_LITERAL_FILES].sort());
  });
});
