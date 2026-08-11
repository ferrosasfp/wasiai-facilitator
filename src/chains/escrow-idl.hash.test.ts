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
import { DEPOSIT_POSITIONAL_ACCOUNTS } from '../methods/solana-sponsor/deposit-shape.js';

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
// HU-SOL-20/R2a: re-pinneada tras R1 (EscrowIndex + register_escrow/deregister_escrow). `EscrowState`
// NO cambió: mismo discriminator y mismo layout, por eso el decode de la cuenta es idéntico.
// RE-PIN 2026-08-05 — despliegue en devnet (slot 481495859, binario verificado byte a byte contra el
// artefacto local). Diff normalizado del IDL entero (claves ordenadas): la ÚNICA diferencia es que
// `close` suma una SÉPTIMA cuenta, `escrow_index`, `optional: true`, al final de la lista (después de
// `token_program`). Ningún discriminador se movió: los 6 de instrucciones y los 2 de cuentas
// (`EscrowIndex`, `EscrowState`) son idénticos. `deposit`, `release`, `refund`, `register_escrow` y
// `deregister_escrow` conservan cuentas, orden y args; los errores siguen 6000..6008 sin renumerar.
// `EscrowStatus` sigue con 3 variantes, así que el decode de la cuenta no se mueve. Este repo firma
// `release` y lee `EscrowState`: ninguno de los dos cambió de forma, y `close` no lo invoca acá.
// Anterior: fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071.
// RE-PIN 2026-08-01 — ventana de custodia. Diff instrucción por instrucción contra el IDL nuevo:
// `close` suma la cuenta `sender_ata` (barrido del vault) y entran los errores 6006 DeadlineTooSoon,
// 6007 DeadlineTooFar y 6008 ReleaseWindowClosed. Ningún código existente se renumeró ni se borró.
// `deposit`, `refund`, `release`, `register_escrow` y `deregister_escrow` conservan discriminador,
// cuentas y args; EscrowStatus sigue con 3 variantes, así que el decode de la cuenta es idéntico.
// Este repo firma `release` y lee `EscrowState`: ninguno de los dos cambió de forma.
// Anterior: 4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b.
// RE-PIN 2026-08-10 (WKH-343) — el `deposit` suma una NOVENA cuenta, `beneficiary_ata`, al final de
// la lista (índice 8), no-writable y no-signer. Diff medido instrucción por instrucción contra el IDL
// nuevo, ignorando `docs`: `deposit` es la ÚNICA que cambió; `close`, `refund`, `release`,
// `register_escrow` y `deregister_escrow` quedan idénticas, y los bloques `accounts`, `types` y
// `errors` y el `address` tampoco se movieron. Ningún discriminador cambió (los 6 los asertea el test
// R2a de acá abajo). Este repo firma `release` y lee `EscrowState`: `release` sigue con sus 9 cuentas,
// `beneficiary_ata` en el índice 6 y writable — la forma que `release-shape.ts` tiene pinneada — y el
// layout de `EscrowState` es el mismo, así que el decode de la cuenta no se mueve.
// El CR-1 del `deposit` acepta la cuenta nueva por diseño, sin tocarlo: compara
// `keys.length < DEPOSIT_POSITIONAL_ACCOUNTS` (cr1.ts:220) y exige que las cuentas extra sean
// no-signer y no-writable (cr1.ts:286) — que es exactamente lo que `beneficiary_ata` es. Esa
// propiedad la asertea T-DEP9 acá abajo, para que no dependa sólo de este hash.
// Anterior: bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922.
const ESCROW_IDL_SHA256 = 'cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51';

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

  // T-DEP9 (WKH-343) — la propiedad de la que depende CR-1, aserteada aparte del hash.
  //
  // Por qué NO alcanza con el hash pinneado: el re-pin es el flujo normal cuando el programa cambia
  // de verdad, y al re-pinnear el hash vuelve a verde por construcción. Medido el 2026-08-10: con
  // `beneficiary_ata` flipeada a writable Y el hash re-pinneado, la suite entera queda VERDE en un
  // árbol sin el sibling (que es como corre la CI, ci.yml:22 clona sólo este repo). O sea que sin
  // este test la propiedad no la mira nadie donde corre la automatización.
  //
  // Qué propiedad es: CR-1 acepta el `deposit` con cuentas de más sólo si son no-signer y
  // no-writable (`cr1.ts:286`), porque las trata como `remaining accounts` después de las
  // `DEPOSIT_POSITIONAL_ACCOUNTS` posicionales (`cr1.ts:220`). Si el programa agregara una cuenta
  // extra WRITABLE, CR-1 rechazaría todo depósito legítimo y el corte se vería recién en runtime.
  // Este test lo pone en rojo al re-vendorizar, que es cuando todavía es barato.
  it('T-DEP9: las cuentas del `deposit` más allá de las posicionales son no-signer y no-writable', () => {
    const deposit = escrowIdl.instructions.find((i) => i.name === 'deposit');
    const accounts = deposit?.accounts as
      | ReadonlyArray<{ name: string; writable?: boolean; signer?: boolean }>
      | undefined;

    // 8 posicionales + `beneficiary_ata`. El 9 es literal a propósito: si el IDL suma otra cuenta,
    // este test tiene que obligar a mirarla, no adaptarse solo.
    expect(accounts).toHaveLength(9);
    expect(accounts?.[8]?.name).toBe('beneficiary_ata');

    // El corte lo da la constante que CR-1 usa de verdad, no un 8 escrito de nuevo acá.
    const extras = (accounts ?? []).slice(DEPOSIT_POSITIONAL_ACCOUNTS);
    expect(extras.map((a) => a.name)).toEqual(['beneficiary_ata']);
    for (const a of extras) {
      expect({ name: a.name, writable: a.writable === true, signer: a.signer === true }).toEqual({
        name: a.name,
        writable: false,
        signer: false,
      });
    }
  });

  // ⚠️ AC-3 NO es "la fuente de verdad", y llamarlo así fue parte del problema: compara
  // contra OTRA COPIA en OTRO REPO, y se saltea entero cuando el sibling no está — que es
  // como corre la CI (`ci.yml` clona sólo este repo). Un `SKIPPED` no es cobertura. Se deja
  // porque en la máquina de quien re-vendoriza atrapa el error en el acto, pero el brazo que
  // le pregunta al BINARIO DESPLEGADO es `scripts/check-idl-onchain.ts`, y corre por reloj
  // en `.github/workflows/idl-onchain-drift.yml`, no acá.
  const SIBLING = path.resolve(process.cwd(), '../solana-programs/target/idl/escrow.json');
  (existsSync(SIBLING) ? it : it.skip)(
    'AC-3 (best-effort, se SALTEA sin el repo hermano): coincide con la copia de solana-programs',
    () => {
      const idl: unknown = JSON.parse(readFileSync(SIBLING, 'utf8'));
      expect(canonicalSha256(idl)).toBe(ESCROW_IDL_SHA256);
    },
  );
});
