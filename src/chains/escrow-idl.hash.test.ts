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
// HU-SOL-20/R2a: re-pinneada tras R1 (EscrowIndex + register_escrow/deregister_escrow). `EscrowState`
// NO cambió: mismo discriminator y mismo layout, por eso el decode de la cuenta es idéntico.
// RE-PIN 2026-08-01 — ventana de custodia. Diff instrucción por instrucción contra el IDL nuevo:
// `close` suma la cuenta `sender_ata` (barrido del vault) y entran los errores 6006 DeadlineTooSoon,
// 6007 DeadlineTooFar y 6008 ReleaseWindowClosed. Ningún código existente se renumeró ni se borró.
// `deposit`, `refund`, `release`, `register_escrow` y `deregister_escrow` conservan discriminador,
// cuentas y args; EscrowStatus sigue con 3 variantes, así que el decode de la cuenta es idéntico.
// Este repo firma `release` y lee `EscrowState`: ninguno de los dos cambió de forma.
// Anterior: 4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b.
const ESCROW_IDL_SHA256 = 'fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071';

describe('WKH-227 AC-2/AC-3 · escrow IDL canonical hash lock', () => {
  it('AC-2: el IDL vendoreado canonicaliza al hash pinneado', () => {
    expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256);
  });

  // HU-SOL-20/R2a AC-R2a-2: el upgrade es in-place, el program id NO cambia. `address` del IDL es la
  // ÚNICA fuente del program id (CD-15) — nunca un literal copiado de otro archivo.
  it('AC-R2a-2: el address del IDL sigue siendo el program deployado (upgrade in-place)', () => {
    // eslint-disable-next-line no-secrets/no-secrets -- public on-chain escrow program id (base58 pubkey), not a secret.
    expect(escrowIdl.address).toBe('DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x');
  });

  // HU-SOL-20/R2a trazabilidad: asertea sobre el IDL VENDOREADO (siempre presente en este repo) ⇒
  // NUNCA condicionado con existsSync/it.skip, o el test desaparecería en silencio en vez de fallar.
  it('R2a: el IDL vendoreado expone las 6 instrucciones y los discriminadores de R1', () => {
    const ixs = escrowIdl.instructions as ReadonlyArray<{
      name: string;
      discriminator: readonly number[];
    }>;
    expect(ixs.map((i) => i.name).sort()).toEqual([
      'close',
      'deposit',
      'deregister_escrow',
      'refund',
      'register_escrow',
      'release',
    ]);
    // Discriminadores leídos del IDL generado por anchor build en R1 (00fef7f).
    expect(ixs.find((i) => i.name === 'register_escrow')?.discriminator).toEqual([
      200, 17, 194, 170, 224, 144, 127, 166,
    ]);
    expect(ixs.find((i) => i.name === 'deregister_escrow')?.discriminator).toEqual([
      226, 232, 192, 96, 102, 196, 211, 162,
    ]);
    // No-regresión del núcleo: los 4 discriminadores pre-R1 son intocables (CD-7).
    expect(ixs.find((i) => i.name === 'deposit')?.discriminator).toEqual([
      242, 35, 198, 137, 82, 225, 242, 182,
    ]);
    expect(ixs.find((i) => i.name === 'release')?.discriminator).toEqual([
      253, 249, 15, 206, 28, 127, 193, 241,
    ]);
    expect(ixs.find((i) => i.name === 'refund')?.discriminator).toEqual([
      2, 96, 183, 251, 63, 208, 46, 46,
    ]);
    expect(ixs.find((i) => i.name === 'close')?.discriminator).toEqual([
      98, 165, 201, 177, 108, 65, 206, 96,
    ]);
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
