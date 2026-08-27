/**
 * WKH-367 / AC-N6 — la fórmula del PDA `escrow_state`, con control POSITIVO y NEGATIVO.
 *
 * Por qué existe este archivo: `routes/solana-sponsor.ts` declaraba que la incógnita del
 * 502 la resuelve cualquiera desde afuera mirando si el `escrow_state` existe, y daba la
 * fórmula MAL — con el `remittanceId` crudo como tercera semilla en vez de sus 16 bytes
 * de hash. Quien siguiera esa fórmula miraría OTRA dirección, no la encontraría, y
 * concluiría un falso "el depósito no aterrizó".
 *
 * El positivo solo no alcanza: sin el negativo, el test no distingue "derivé bien" de
 * "derivé cualquier cosa y coincidió". Por eso T-12b deriva a mano, como lo haría quien
 * siguiera el docblock viejo, y exige una dirección DISTINTA.
 *
 * PURO: sin red, sin env, sin base (CD-7).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { deriveEscrowStatePda } from '../../methods/solana-sponsor/sponsor-claims.js';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

// El vector se DERIVA de dos frases, así que acá no hay ni un pubkey pegado a mano y
// cualquiera lo regenera. Deliberadamente NO es el escrow program id real: así el vector
// no se pudre el día que ese id rote, y no duplica el literal que
// `chains/escrow-program-id.test.ts` prohíbe.
const SENDER = new PublicKey(sha256('wkh367-vector-sender')); // 46VkL4ZJ…
const PROGRAM = new PublicKey(sha256('wkh367-vector-program')); // B1ospDxo…
const REMITTANCE_ID = 'rem_wkh367_vector';
const HASH16 = sha256(REMITTANCE_ID).subarray(0, 16); // fe4e86cf1eff215b6cb749fc43dd98d9

/** Producido corriendo la derivación del repo `chaski-v3` — el productor REAL del depósito. */
// eslint-disable-next-line no-secrets/no-secrets -- PDA base58 pública y determinista, derivable de las frases de arriba; es la expectativa del test, no un secreto.
const PDA_CORRECTA = '8eBFZZN4kenWaCGFxcCeZ8S3hZz1qnHBN8C4nk5gfVto';
/** La que sale de la fórmula vieja. Es el falso negativo, no una dirección cualquiera. */
// eslint-disable-next-line no-secrets/no-secrets -- ídem: una dirección derivada, pinneada a propósito para que el control negativo no pueda coincidir por casualidad.
const PDA_CON_ID_CRUDO = '2Y8UQigZL81YRRKSAooLPRNLm5mnfC52FzgSRwAJ7QFF';

describe('WKH-367 · deriveEscrowStatePda (AC-N6)', () => {
  it('★ T-12a (positivo): reproduce la PDA del vector externo con los 16 bytes de hash', () => {
    expect(deriveEscrowStatePda(SENDER.toBase58(), HASH16, PROGRAM.toBase58())).toBe(PDA_CORRECTA);
  });

  it('★★ T-12b (negativo): derivar con el `remittanceId` CRUDO da una dirección DISTINTA', () => {
    // A mano y a propósito: pasarle el id crudo a `deriveEscrowStatePda` mediría el guard
    // de longitud (17 bytes ⇒ undefined), no la fórmula. Acá se mide la fórmula.
    const conIdCrudo = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow', 'utf8'), SENDER.toBuffer(), Buffer.from(REMITTANCE_ID, 'utf8')],
      PROGRAM,
    )[0].toBase58();

    expect(conIdCrudo).toBe(PDA_CON_ID_CRUDO);
    expect(conIdCrudo).not.toBe(PDA_CORRECTA);
    // Y el control del control: la fórmula buena y la mala parten del MISMO sender y del
    // MISMO programa, así que lo único que las separa es la tercera semilla.
    expect(deriveEscrowStatePda(SENDER.toBase58(), HASH16, PROGRAM.toBase58())).not.toBe(
      conIdCrudo,
    );
  });

  it('T-12c: entrada inválida ⇒ `undefined`, y NUNCA tira', () => {
    const casos: ReadonlyArray<readonly [string, () => string | undefined]> = [
      [
        'hash de 15 bytes',
        () => deriveEscrowStatePda(SENDER.toBase58(), HASH16.subarray(0, 15), PROGRAM.toBase58()),
      ],
      [
        'hash de 32 bytes',
        () => deriveEscrowStatePda(SENDER.toBase58(), sha256(REMITTANCE_ID), PROGRAM.toBase58()),
      ],
      ['programId no base58', () => deriveEscrowStatePda(SENDER.toBase58(), HASH16, '!!!')],
      ['sender no base58', () => deriveEscrowStatePda('no-es-base58', HASH16, PROGRAM.toBase58())],
    ];
    for (const [nombre, f] of casos) {
      expect(f, nombre).not.toThrow();
      expect(f(), nombre).toBeUndefined();
    }
  });

  it('★★ T-12f (CR MNR-CR-1): un impostor con `.length === 16` se RECHAZA, no deriva otra dirección', () => {
    // El guard era `…length !== REMITTANCE_ID_LEN` a secas: duck-typing puro. Medido antes de
    // endurecerlo, con este mismo vector:
    //   { length: 16 }        ⇒ 'ECKwqsVW…'   ← una PDA EQUIVOCADA, no `undefined`
    //   new Array(16).fill(0) ⇒ 'ECKwqsVW…'
    //   'abcdefghijklmnop'    ⇒ 'Av3gEaCA…'
    // El docblock prometía `undefined` para "cualquier entrada inválida" y devolvía una
    // dirección: mirarla en la cadena da un falso "el depósito no aterrizó", que es
    // exactamente lo que esta HU existe para no producir.
    const impostores: ReadonlyArray<readonly [string, unknown]> = [
      ['objeto con length', { length: 16 }],
      ['Array de 16', new Array(16).fill(0)],
      ['string de 16 chars', 'abcdefghijklmnop'],
    ];
    for (const [nombre, v] of impostores) {
      const f = (): string | undefined =>
        deriveEscrowStatePda(SENDER.toBase58(), v as Buffer, PROGRAM.toBase58());
      expect(f, nombre).not.toThrow();
      expect(f(), nombre).toBeUndefined();
    }

    // ── Los DOS controles, para que el test no se cuente a sí mismo ──────────────────
    // (a) el rechazo viene del guard de TIPO, no de algo trivial: los MISMOS 16 bytes, pero
    //     como Buffer de verdad, SÍ derivan. Antes de endurecer, estas dos líneas daban el
    //     mismo valor — ésa era toda la falla.
    const mismosBytes = Buffer.from('abcdefghijklmnop', 'utf8');
    expect(mismosBytes).toHaveLength(16);
    expect(deriveEscrowStatePda(SENDER.toBase58(), mismosBytes, PROGRAM.toBase58())).toBeDefined();
    // (b) endurecer NO cerró el tipo legítimo: un `Uint8Array` que no es Buffer sigue
    //     derivando (`Buffer.isBuffer` daría `false` para él).
    const comoUint8 = Uint8Array.from(HASH16);
    expect(Buffer.isBuffer(comoUint8)).toBe(false);
    expect(deriveEscrowStatePda(SENDER.toBase58(), comoUint8 as Buffer, PROGRAM.toBase58())).toBe(
      PDA_CORRECTA,
    );
  });

  it('★ T-12e (AR MNR-2): `null`/`undefined` como hash tampoco tiran', () => {
    // El guard de longitud vivía FUERA del `try`, así que estas dos entradas rompían en
    // el `.length` mismo y el docblock que promete "NUNCA tira" era falso. T-12c no las
    // alcanzaba porque todos sus casos eran Buffers de verdad.
    const nulos: ReadonlyArray<readonly [string, () => string | undefined]> = [
      [
        'null',
        () =>
          deriveEscrowStatePda(SENDER.toBase58(), null as unknown as Buffer, PROGRAM.toBase58()),
      ],
      [
        'undefined',
        () =>
          deriveEscrowStatePda(
            SENDER.toBase58(),
            undefined as unknown as Buffer,
            PROGRAM.toBase58(),
          ),
      ],
    ];
    for (const [nombre, f] of nulos) {
      expect(f, nombre).not.toThrow();
      expect(f(), nombre).toBeUndefined();
    }
  });

  it('★ T-12d (guard doc↔código): el docblock de la ruta dice la fórmula BUENA y no la vieja', () => {
    // Lee OTRO archivo, nunca a sí mismo: un guard que se busca en su propio texto no
    // puede fallar jamás — el literal está en la línea que lo busca.
    const ruta = readFileSync(path.join(SRC_DIR, 'routes', 'solana-sponsor.ts'), 'utf8');

    expect(ruta).toContain('sha256(utf8(remittanceId))[0..16]');
    expect(ruta).not.toContain('["escrow", sender, remittance_id]');
  });
});
