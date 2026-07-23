/* eslint-disable security/detect-non-literal-fs-filename -- SIBLING is a build-time constant path (path.resolve of a hardcoded literal), not attacker input. */
/**
 * Escrow IDL hash lock — WKH-227 / HU-SOL-24, Wave W2 (AC-2 + AC-3).
 *
 * AC-2 (Nivel 1, SIEMPRE corre): el IDL vendoreado (`escrow-idl.ts`) canonicaliza
 * al hash pinneado. Si alguien edita el IDL a mano sin re-pinnear → ROJO.
 *
 * AC-3 (Nivel 2, best-effort): compara contra la fuente de verdad
 * `../solana-programs/target/idl/escrow.json` por path sibling. Si el sibling no
 * existe (repo desplegado por separado / CI) → `it.skip` limpio, sin fallar.
 * `solana-programs` se LEE, jamás se escribe (CD-2).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { escrowIdl } from './escrow-idl.js';
import { canonicalSha256 } from './canonical-hash.js';

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
const ESCROW_IDL_SHA256 = 'aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71';

describe('WKH-227 AC-2/AC-3 · escrow IDL canonical hash lock', () => {
  it('AC-2: el IDL vendoreado canonicaliza al hash pinneado', () => {
    expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256);
  });

  const SIBLING = path.resolve(process.cwd(), '../solana-programs/target/idl/escrow.json');
  (existsSync(SIBLING) ? it : it.skip)(
    'AC-3: coincide con solana-programs (fuente de verdad)',
    () => {
      const idl: unknown = JSON.parse(readFileSync(SIBLING, 'utf8'));
      expect(canonicalSha256(idl)).toBe(ESCROW_IDL_SHA256);
    },
  );
});
