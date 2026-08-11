/**
 * WKH-343 — el brazo del guard del IDL que le pregunta a la CADENA.
 *
 * POR QUÉ EXISTE. `escrow-idl.hash.test.ts` tiene dos brazos y sólo uno mira afuera:
 * AC-2 compara el hash pinneado contra la copia vendoreada (las dos puntas se mueven
 * juntas: es auto-referencial) y AC-3 compara contra `../solana-programs/target/idl/
 * escrow.json`, que es OTRA COPIA en OTRO REPO y que además está gateado por
 * `existsSync` — y `ci.yml` clona sólo este repo, así que en CI ese brazo es `it.skip`.
 * Medido el 2026-08-10: con una cuenta del `deposit` flipeada a writable Y el hash
 * re-pinneado, la suite entera queda VERDE en un árbol sin el sibling.
 *
 * Este módulo ata el pin al BINARIO REALMENTE DESPLEGADO, que es la propiedad que
 * decimos querer. Es lo único acá que puede desmentir a las dos copias a la vez.
 *
 * QUE NO ES AUTO-REFERENCIAL NO ES UNA OPINIÓN, ESTÁ MEDIDO. El 2026-08-11 este control
 * pasó de MISMATCH a MATCH con el repo BYTE POR BYTE IGUAL: no se editó una línea, se
 * republicó el IDL en cadena (camino de buffer de `solana-programs/doc/publish-idl-onchain.md`).
 * Un guard cuyo veredicto cambia sin que el repo cambie es, por definición, un guard que
 * está mirando afuera. AC-2 no puede hacer eso ni queriendo: sus dos puntas se mueven juntas.
 *
 * ⚠️ LA CADENA ENVEJECE SOLA — y el corolario incómodo es que el verde de hoy no dice nada
 * del de mañana. El mismo día en que se escribió esto el veredicto cambió dos veces.
 * El veredicto puede cambiar sin que nadie
 * edite una línea (alguien republica el IDL, o despliega otro binario). Por eso NO vive
 * en la suite de vitest gateada por commit: vive en `scripts/check-idl-onchain.ts`, que
 * se corre aparte. Lo que sí está en la suite es la CLASIFICACIÓN de acá abajo, con
 * dobles y sin red, para que la lógica de tres desenlaces no se pudra en silencio.
 *
 * CINCO veredictos, TRES desenlaces. La regla de la casa es que "no pude preguntar"
 * NO es "no pasó" (mismo criterio que `routes/solana-escrow.ts:509`, el Step 8 del
 * release, que contesta 502 UNKNOWN en vez de mentir "no salió"):
 *
 *   MATCH        → coincide.                              exit 0
 *   MISMATCH     → la cadena contestó y NO coincide.      exit 1  (rojo duro, sin bandera)
 *   ABSENT       → la cadena contestó: no hay IDL.        exit 1  (rojo duro)
 *   UNDECODABLE  → la cadena contestó algo ininteligible. exit 1  (rojo duro)
 *   UNREACHABLE  → NO pude preguntar.                     exit 2  (su propio desenlace)
 *
 * Por qué ABSENT es ROJO y no "no pude preguntar": la ausencia de la cuenta es una
 * RESPUESTA de la cadena, no un fallo de red. Y hay un motivo más fuerte, vivido
 * mientras se escribía esto: la derivación del address del IDL YA CAMBIÓ una vez
 * (ver abajo). Una derivación equivocada devuelve exactamente "no existe la cuenta".
 * Si ABSENT fuera verde, un guard con la derivación vieja se aplaudiría solo para
 * siempre — que es justo el defecto que este módulo vino a arreglar.
 */

import { PublicKey } from '@solana/web3.js';
import { inflateSync } from 'node:zlib';
import { canonicalSha256 } from './canonical-hash.js';

/**
 * Programa Program-Metadata que custodia el IDL publicado.
 *
 * ⚠️ NO es el esquema viejo de Anchor. Hasta 0.30.x el IDL vivía en
 * `createWithSeed(findProgramAddress([], programId)[0], "anchor:idl", programId)`.
 * anchor-cli 1.1.2 ya NO lee ahí: medido con un proxy RPC que loguea las llamadas,
 * `anchor idl fetch` hace UN solo `getAccountInfo`, contra el PDA de acá abajo. En el
 * address viejo no hay cuenta, así que un guard escrito contra el esquema viejo
 * reportaría "no hay IDL" sobre un programa que SÍ lo tiene publicado.
 */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain program id (base58 pubkey), not a secret.
export const IDL_METADATA_PROGRAM_ID = 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S';

/** La seed `idl` va padeada a 16 bytes con ceros (medido contra la cuenta real). */
const IDL_SEED = 'idl';
const IDL_SEED_LEN = 16;

/**
 * Layout de la cuenta de metadata, LEÍDO de la cuenta real (5292 bytes) del escrow en
 * devnet, no de una especificación. Sólo se validan los campos que se usan; el resto
 * del header no se interpreta a propósito, para no atarse a bytes que no hacen falta.
 *
 *   [84]      byte de codificación — 0x02 en la cuenta medida
 *   [87..91)  u32 LE con el largo del payload
 *   [96..]    payload comprimido con zlib (arranca con el magic 0x78)
 */
const OFFSET_DATA_LEN = 87;
const OFFSET_PAYLOAD = 96;
const ZLIB_MAGIC_FIRST_BYTE = 0x78;

/** Derivación del PDA donde vive el IDL publicado. */
export function deriveIdlMetadataPda(programId: PublicKey): PublicKey {
  const seed = Buffer.alloc(IDL_SEED_LEN);
  seed.write(IDL_SEED, 'utf8');
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer(), seed],
    new PublicKey(IDL_METADATA_PROGRAM_ID),
  );
  return pda;
}

export class IdlUndecodableError extends Error {}

/**
 * Descomprime el IDL de los bytes crudos de la cuenta. Tira `IdlUndecodableError` en vez
 * de devolver algo aproximado: un IDL a medias comparado contra un hash daría MISMATCH,
 * que suena a deriva del programa cuando en realidad es que no supimos leer.
 */
export function decodeIdlMetadataAccount(data: Buffer): unknown {
  if (data.length < OFFSET_PAYLOAD + 1) {
    throw new IdlUndecodableError(`account too short: ${data.length} bytes`);
  }
  const declaredLen = data.readUInt32LE(OFFSET_DATA_LEN);
  const end = OFFSET_PAYLOAD + declaredLen;
  if (declaredLen === 0 || end > data.length) {
    throw new IdlUndecodableError(
      `declared payload length ${declaredLen} does not fit in ${data.length} bytes`,
    );
  }
  const payload = data.subarray(OFFSET_PAYLOAD, end);
  if (payload[0] !== ZLIB_MAGIC_FIRST_BYTE) {
    throw new IdlUndecodableError(
      `payload is not zlib (first byte 0x${(payload[0] ?? 0).toString(16)})`,
    );
  }
  let json: string;
  try {
    json = inflateSync(payload).toString('utf8');
  } catch (err) {
    throw new IdlUndecodableError(
      `inflate failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    throw new IdlUndecodableError(
      `payload is not JSON: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

export type IdlDriftVerdict =
  | { verdict: 'MATCH'; idlAccount: string; sha256: string }
  | { verdict: 'MISMATCH'; idlAccount: string; onchainSha256: string; pinnedSha256: string }
  | { verdict: 'ABSENT'; idlAccount: string }
  | { verdict: 'UNDECODABLE'; idlAccount: string; reason: string }
  | { verdict: 'UNREACHABLE'; idlAccount: string; reason: string };

/** Lo único que este módulo necesita de la red. Inyectado para poder testear sin RPC. */
export type AccountFetcher = (address: PublicKey) => Promise<{ data: Buffer } | null>;

export interface CheckIdlOnchainDeps {
  programId: string;
  pinnedSha256: string;
  getAccountInfo: AccountFetcher;
}

/**
 * Compara el IDL publicado on-chain contra el hash pinneado.
 *
 * ⚠️ El `catch` de acá abajo cubre SÓLO la llamada de red. Está a propósito envolviendo
 * nada más que el `getAccountInfo`: si envolviera también el decode y la comparación, un
 * bug NUESTRO se reportaría como "no pude preguntar" (exit 2, no bloqueante) y el guard
 * se apagaría solo sin que nadie se entere.
 */
export async function checkEscrowIdlOnchain(deps: CheckIdlOnchainDeps): Promise<IdlDriftVerdict> {
  const pda = deriveIdlMetadataPda(new PublicKey(deps.programId));
  const idlAccount = pda.toBase58();

  let account: { data: Buffer } | null;
  try {
    account = await deps.getAccountInfo(pda);
  } catch (err) {
    return {
      verdict: 'UNREACHABLE',
      idlAccount,
      reason: err instanceof Error ? err.message : 'unknown transport error',
    };
  }

  if (account === null) {
    return { verdict: 'ABSENT', idlAccount };
  }

  let idl: unknown;
  try {
    idl = decodeIdlMetadataAccount(account.data);
  } catch (err) {
    return {
      verdict: 'UNDECODABLE',
      idlAccount,
      reason: err instanceof Error ? err.message : 'unknown decode error',
    };
  }

  const onchainSha256 = canonicalSha256(idl);
  return onchainSha256 === deps.pinnedSha256
    ? { verdict: 'MATCH', idlAccount, sha256: onchainSha256 }
    : { verdict: 'MISMATCH', idlAccount, onchainSha256, pinnedSha256: deps.pinnedSha256 };
}

/**
 * Exit code del veredicto. TRES valores, y el 2 es el que existe para que "no pude
 * preguntar" no se lea como verde ni tumbe la CI por un hipo de devnet.
 */
export function exitCodeFor(verdict: IdlDriftVerdict['verdict']): 0 | 1 | 2 {
  if (verdict === 'MATCH') return 0;
  if (verdict === 'UNREACHABLE') return 2;
  return 1;
}
