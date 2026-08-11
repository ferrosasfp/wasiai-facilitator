#!/usr/bin/env -S npx tsx
/**
 * WKH-343 — ¿el IDL publicado on-chain es el que este repo tiene vendoreado?
 *
 * Este es el ÚNICO control del repo que le pregunta a la CADENA. Los otros dos brazos
 * (`escrow-idl.hash.test.ts`) comparan copias contra copias: AC-2 compara el hash pinneado
 * contra la copia vendoreada — las dos puntas se mueven juntas — y AC-3 compara contra el
 * IDL de `solana-programs`, que es otra copia en otro repo Y está gateado por `existsSync`,
 * así que en CI no corre.
 *
 * POR QUÉ ES UN SCRIPT Y NO UN TEST. La respuesta de la cadena cambia sin que nadie edite
 * una línea: alguien republica el IDL y esto pasa de rojo a verde solo. Un test gateado por
 * commit que dependa de eso es un flake garantizado y termina apagado. Lo que sí vive en la
 * suite es la CLASIFICACIÓN (`src/chains/escrow-idl-onchain.test.ts`), con dobles y sin red.
 *
 * CONTRA QUÉ COMPARA. Contra `canonicalSha256(escrowIdl)`, o sea la copia vendoreada, NO
 * contra una tercera copia del literal del hash. El literal pinneado vive en UN solo lugar
 * (`escrow-idl.hash.test.ts`) y AC-2 lo ata a la copia vendoreada en cada `npm test`; con
 * ese eslabón puesto, comparar la cadena contra la copia vendoreada es comparar contra el
 * pin. Duplicar el literal acá sería agregar una cuarta copia que puede envejecer sola.
 *
 * EXIT CODES — tres desenlaces, y el 2 existe a propósito:
 *   0  MATCH        el IDL on-chain coincide.
 *   1  MISMATCH     la cadena contestó y NO coincide  → rojo duro, sin bandera de escape.
 *      ABSENT       la cadena contestó: no hay IDL    → rojo duro.
 *      UNDECODABLE  contestó algo ininteligible       → rojo duro.
 *   2  UNREACHABLE  NO se pudo preguntar (red, RPC caído, env sin setear).
 *
 * El 2 NO es verde y NO bloquea: es su propio desenlace, con el motivo impreso. Si fuera
 * verde sería decoración; si fuera rojo, la CI se caería con cada hipo de devnet y alguien
 * lo terminaría apagando, que nos deja peor que ahora.
 *
 * Uso:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com npm run ops:check-idl-onchain
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { canonicalSha256 } from '../src/chains/canonical-hash.js';
import { escrowIdl } from '../src/chains/escrow-idl.js';
import { ESCROW_PROGRAM_ID_DEFAULT } from '../src/chains/escrow-program-id.js';
import { checkEscrowIdlOnchain, exitCodeFor } from '../src/chains/escrow-idl-onchain.js';

const rpcUrl = process.env.SOLANA_RPC_URL;
const programId = process.env.SOLANA_ESCROW_PROGRAM_ID ?? ESCROW_PROGRAM_ID_DEFAULT;

// Sin RPC no se pudo ni preguntar. Es el desenlace 2, con su propio motivo impreso: NO se
// disfraza de MATCH (sería decoración) ni de MISMATCH (culparía al programa de un olvido
// de configuración). Mismo criterio que `scripts/check-operator-gas.mjs`.
if (!rpcUrl) {
  console.error('UNREACHABLE — SOLANA_RPC_URL no está seteada: no se pudo preguntar a la cadena.');
  console.error('  Esto NO afirma que el IDL on-chain esté bien ni mal. No se lo consultó.');
  process.exit(2);
}

const connection = new Connection(rpcUrl, 'confirmed');

const verdict = await checkEscrowIdlOnchain({
  programId,
  pinnedSha256: canonicalSha256(escrowIdl),
  getAccountInfo: async (address: PublicKey) => {
    const info = await connection.getAccountInfo(address);
    return info === null ? null : { data: info.data };
  },
});

console.log(`escrow program : ${programId}`);
console.log(`IDL account    : ${verdict.idlAccount}`);
console.log(`verdict        : ${verdict.verdict}`);

switch (verdict.verdict) {
  case 'MATCH':
    console.log(`sha256         : ${verdict.sha256}`);
    console.log('\nOK — el IDL publicado on-chain es el que este repo tiene vendoreado.');
    break;
  case 'MISMATCH':
    console.error(`on-chain sha256: ${verdict.onchainSha256}`);
    console.error(`vendored sha256: ${verdict.pinnedSha256}`);
    console.error(
      '\nDERIVA REAL — el IDL publicado on-chain NO es el que este repo tiene vendoreado.',
    );
    console.error('  Lo pone en verde: republicar el IDL del binario desplegado (`anchor idl`).');
    break;
  case 'ABSENT':
    console.error('\nNO HAY IDL PUBLICADO en esa cuenta.');
    console.error('  Ojo: una derivación equivocada del PDA se ve EXACTAMENTE así. Antes de');
    console.error('  publicar nada, verificá contra qué cuenta lee `anchor idl fetch`.');
    break;
  case 'UNDECODABLE':
    console.error(`reason         : ${verdict.reason}`);
    console.error('\nLa cuenta existe pero no se pudo interpretar. No es un problema de red:');
    console.error('  o cambió el layout de la metadata, o estamos leyendo la cuenta equivocada.');
    break;
  case 'UNREACHABLE':
    console.error(`reason         : ${verdict.reason}`);
    console.error('\nNO SE PUDO PREGUNTAR. Esto no dice nada sobre el IDL on-chain:');
    console.error('  no es un OK y tampoco es una deriva. Volvé a correrlo.');
    break;
}

process.exit(exitCodeFor(verdict.verdict));
