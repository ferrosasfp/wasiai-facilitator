/**
 * WKH-343 — la lógica de tres desenlaces del guard on-chain, medida SIN red.
 *
 * Lo que se prueba acá es la CLASIFICACIÓN, no la cadena. La cadena envejece sola y su
 * respuesta cambia sin que nadie edite código, así que un test gateado por commit no
 * puede afirmar nada sobre ella. Lo que sí tiene que quedar clavado es que los cinco
 * veredictos no se colapsen entre sí — y el colapso que importa es
 * `UNREACHABLE → verde`, que es exactamente el defecto que este módulo vino a arreglar.
 */

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import {
  checkEscrowIdlOnchain,
  decodeIdlMetadataAccount,
  deriveIdlMetadataPda,
  exitCodeFor,
  IdlUndecodableError,
} from './escrow-idl-onchain.js';
import { canonicalSha256 } from './canonical-hash.js';
import { escrowIdl } from './escrow-idl.js';
import { ESCROW_PROGRAM_ID_DEFAULT } from './escrow-program-id.js';

// CD-15: se DERIVA de la única fuente, no se re-tipea el base58. `escrow-program-id.test.ts`
// falla si el literal reaparece fuera de la fuente y del lock — y me agarró escribiéndolo acá.
const PROGRAM_ID = ESCROW_PROGRAM_ID_DEFAULT;

/** Arma los bytes de una cuenta de metadata con el layout real (header 96 + zlib). */
function fakeAccount(idl: unknown): { data: Buffer } {
  const payload = deflateSync(Buffer.from(JSON.stringify(idl), 'utf8'));
  const data = Buffer.alloc(96 + payload.length);
  data.writeUInt32LE(payload.length, 87);
  payload.copy(data, 96);
  return { data };
}

describe('WKH-343 · escrow IDL on-chain drift check', () => {
  it('el PDA se deriva bajo el programa Program-Metadata, NO bajo el esquema viejo de anchor', async () => {
    const programId = new PublicKey(PROGRAM_ID);
    const pda = deriveIdlMetadataPda(programId);

    // El address viejo (anchor <= 0.30.x). En la cadena NO hay cuenta ahí, así que si la
    // derivación volviera a ese esquema el guard diría ABSENT sobre un programa que sí
    // tiene IDL publicado. Este test es lo que frena esa regresión.
    const [base] = PublicKey.findProgramAddressSync([], programId);
    const legacy = await PublicKey.createWithSeed(base, 'anchor:idl', programId);
    expect(pda.toBase58()).not.toBe(legacy.toBase58());

    // Address medido con un proxy RPC sobre el `getAccountInfo` real de anchor-cli 1.1.2.
    // eslint-disable-next-line no-secrets/no-secrets -- public on-chain PDA (base58 pubkey), not a secret.
    expect(pda.toBase58()).toBe('7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC');
    // El id del programa de metadata NO se re-tipea acá: el PDA de arriba se DERIVA de él,
    // así que si esa constante cambia, esta misma aserción se pone roja. Una copia más del
    // literal sería una copia más que puede envejecer sola.
  });

  it('MATCH cuando el IDL on-chain canonicaliza al hash pinneado', async () => {
    const v = await checkEscrowIdlOnchain({
      programId: PROGRAM_ID,
      pinnedSha256: canonicalSha256(escrowIdl),
      getAccountInfo: () => Promise.resolve(fakeAccount(escrowIdl)),
    });
    expect(v.verdict).toBe('MATCH');
    expect(exitCodeFor(v.verdict)).toBe(0);
  });

  it('MISMATCH cuando la cadena contesta un IDL distinto — y NO es verde', async () => {
    const drifted = structuredClone(escrowIdl) as { metadata: { version: string } };
    drifted.metadata.version = '9.9.9';
    const v = await checkEscrowIdlOnchain({
      programId: PROGRAM_ID,
      pinnedSha256: canonicalSha256(escrowIdl),
      getAccountInfo: () => Promise.resolve(fakeAccount(drifted)),
    });
    expect(v.verdict).toBe('MISMATCH');
    expect(exitCodeFor(v.verdict)).toBe(1);
  });

  it('ABSENT cuando la cuenta no existe — es una RESPUESTA, y es roja', async () => {
    const v = await checkEscrowIdlOnchain({
      programId: PROGRAM_ID,
      pinnedSha256: canonicalSha256(escrowIdl),
      getAccountInfo: () => Promise.resolve(null),
    });
    expect(v.verdict).toBe('ABSENT');
    expect(exitCodeFor(v.verdict)).toBe(1);
  });

  it('UNDECODABLE cuando la cuenta existe pero no se entiende — rojo, no "no pude preguntar"', async () => {
    const v = await checkEscrowIdlOnchain({
      programId: PROGRAM_ID,
      pinnedSha256: canonicalSha256(escrowIdl),
      getAccountInfo: () => Promise.resolve({ data: Buffer.alloc(200) }),
    });
    expect(v.verdict).toBe('UNDECODABLE');
    expect(exitCodeFor(v.verdict)).toBe(1);
  });

  // ⚠️ EL TEST QUE IMPORTA. Si "no pude preguntar" colapsara a MATCH, el guard sería
  // decoración: quedaría verde para siempre con la red caída. Y si colapsara a MISMATCH,
  // la CI se caería con cada hipo de devnet y alguien terminaría apagándolo, que nos deja
  // peor que ahora. Tiene que ser su propio desenlace, con el motivo escrito.
  it('UNREACHABLE es su PROPIO desenlace: ni verde, ni el rojo de la deriva', async () => {
    const v = await checkEscrowIdlOnchain({
      programId: PROGRAM_ID,
      pinnedSha256: canonicalSha256(escrowIdl),
      getAccountInfo: () => Promise.reject(new Error('fetch failed: ECONNREFUSED')),
    });
    expect(v.verdict).toBe('UNREACHABLE');
    expect(v.verdict).not.toBe('MATCH');
    expect(v.verdict).not.toBe('MISMATCH');
    expect(exitCodeFor(v.verdict)).toBe(2);
    // El motivo viaja con el veredicto: un desenlace sin motivo se lee como un skip.
    if (v.verdict === 'UNREACHABLE') expect(v.reason).toContain('ECONNREFUSED');
  });

  // Un fallo NUESTRO (decode) no se puede disfrazar de problema de red, porque eso
  // apagaría el guard en silencio: exit 2 no bloquea.
  it('los tres exit codes son distintos y sólo MATCH da 0', () => {
    expect(exitCodeFor('MATCH')).toBe(0);
    expect(
      new Set(['MISMATCH', 'ABSENT', 'UNDECODABLE'].map((x) => exitCodeFor(x as 'MISMATCH'))),
    ).toEqual(new Set([1]));
    expect(exitCodeFor('UNREACHABLE')).toBe(2);
  });

  it('decodeIdlMetadataAccount tira en vez de devolver un IDL a medias', () => {
    expect(() => decodeIdlMetadataAccount(Buffer.alloc(10))).toThrow(IdlUndecodableError);
    // Largo declarado que no entra en la cuenta.
    const bad = Buffer.alloc(200);
    bad.writeUInt32LE(9999, 87);
    expect(() => decodeIdlMetadataAccount(bad)).toThrow(IdlUndecodableError);
  });

  it('round-trip: lo que se decodifica de los bytes es el IDL, no otra cosa', () => {
    const decoded = decodeIdlMetadataAccount(fakeAccount(escrowIdl).data);
    expect(canonicalSha256(decoded)).toBe(canonicalSha256(escrowIdl));
  });
});
