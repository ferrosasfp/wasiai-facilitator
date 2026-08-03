/**
 * SDD 037 / W0 — T-OFF1: el offset del `amount` dentro de `deposit.data`.
 *
 * El §13.5 del SDD dejó el 88 como número DERIVADO del layout Borsh, sin bytes
 * reales atrás. Este test cierra esa deuda: encodea la ix `deposit` con el mismo
 * coder de Anchor que usa el builder de producción y compara contra LITERALES
 * escritos a mano (CD-9: nada de re-derivar la fórmula que se está vigilando).
 *
 * El par de valores no es decorativo. `amount = 10000000n` y
 * `deadline = 1900000000n` son distintos a propósito: si el offset estuviera
 * corrido 8 bytes, el u64 leído en 88 daría el deadline y el assert moriría.
 * Con dos valores iguales, un offset corrido pasaría por casualidad.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { BorshInstructionCoder, BN, type Idl } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { escrowIdl } from '../../chains/escrow-idl.js';
import {
  AMOUNT_OFFSET,
  AMOUNT_LEN,
  DEPOSIT_DATA_LEN,
  DEPOSIT_DISCRIMINATOR,
} from '../../methods/solana-sponsor/deposit-shape.js';

const coder = new BorshInstructionCoder(escrowIdl as unknown as Idl);

/** Los 16 bytes que el programa recibe como `remittance_id` (AH-9). */
function remittanceIdBytes(remittanceId: string): Buffer {
  return createHash('sha256').update(remittanceId, 'utf8').digest().subarray(0, 16);
}

describe('T-OFF1 — offset del amount en deposit.data (SDD 037 §9)', () => {
  const remittanceId = 'rem_037_golden';
  const rid16 = remittanceIdBytes(remittanceId);
  const beneficiary = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  const data = coder.encode('deposit', {
    remittance_id: Array.from(rid16),
    beneficiary,
    authority,
    amount: new BN('10000000'),
    deadline: new BN('1900000000'),
  });

  it('la data de la ix mide exactamente 104 bytes', () => {
    expect(data.length).toBe(104);
    expect(DEPOSIT_DATA_LEN).toBe(104);
  });

  it('los primeros 8 bytes son el discriminador pinneado de `deposit`', () => {
    expect(Buffer.from(data.subarray(0, 8)).equals(Buffer.from([...DEPOSIT_DISCRIMINATOR]))).toBe(
      true,
    );
  });

  it('los bytes 8..24 son el remittance_id de 16 bytes', () => {
    expect(Buffer.from(data.subarray(8, 24)).equals(rid16)).toBe(true);
  });

  it('★ el u64 en el offset 88 es el amount (10000000), no el deadline', () => {
    expect(data.readBigUInt64LE(88)).toBe(10000000n);
    expect(AMOUNT_OFFSET).toBe(88);
    expect(AMOUNT_LEN).toBe(8);
    // La constante y el literal apuntan al mismo byte: leer por la constante da lo mismo.
    expect(data.readBigUInt64LE(AMOUNT_OFFSET)).toBe(10000000n);
  });

  it('el i64 en el offset 96 es el deadline (1900000000) — descarta el corrimiento de 8', () => {
    expect(data.readBigInt64LE(96)).toBe(1900000000n);
    // Y la vuelta: en 88 NO está el deadline, en 96 NO está el amount.
    expect(data.readBigUInt64LE(88)).not.toBe(1900000000n);
    expect(data.readBigInt64LE(96)).not.toBe(10000000n);
  });

  it('beneficiary y authority caen en 24 y 56 (cierra el layout completo)', () => {
    expect(Buffer.from(data.subarray(24, 56)).equals(Buffer.from(beneficiary.toBytes()))).toBe(true);
    expect(Buffer.from(data.subarray(56, 88)).equals(Buffer.from(authority.toBytes()))).toBe(true);
  });
});

/**
 * Firma (id público on-chain) de la tx gasless que el propio facilitator co-firmó
 * y transmitió en devnet el 2026-07-22. Documentada en
 * `chaski-v3/doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md:31`.
 */
const REAL_DEVNET_TX_SIGNATURE =
  // eslint-disable-next-line no-secrets/no-secrets -- id PÚBLICO de una tx de devnet (base58), no es un secreto.
  '2PcvKgsZFeBo4xHgKZTnSHLREyAyZHRkw57pVev3j7JV2JdPJ4FgYcyyg5ToLgGoTUE3v52FA6NGBke32mDVPZV2';

/**
 * Corroboración con BYTES REALES de la cadena, no del encoder.
 *
 * Los 104 bytes de abajo son la `data` de la ix `deposit` de esa transacción,
 * leída con `getTransaction` contra `api.devnet.solana.com` el 2026-08-03 y
 * pegada acá como literal para que el test no toque la red.
 *
 * `runbook-skeleton.md:32` de chaski documenta que ese depósito movió **10 USDC**
 * al vault. USDC tiene 6 decimales ⇒ 10_000_000 unidades mínimas. Que ese número
 * aparezca en el offset 88 de una tx que la cadena aceptó es la prueba que el
 * encoder solo no puede dar: acá el productor de los bytes fue el builder de
 * producción de chaski y el consumidor fue el programa on-chain.
 */
const REAL_DEVNET_DEPOSIT_DATA_HEX =
  'f223c68952e1f2b6b81f31e8e50dee3ffb2d23f822620ca5bedc18c0d6217ef2' +
  '1ee1968af1b2106a29a658267874c45ac5f87b60bd12ffa283a0e46ac82fe89a' +
  '2e257c2ada08b6d7a7936d92307c4cd640d23330bea0c0ba8096980000000000' +
  'be3a616a00000000';

describe(`T-OFF1 — el mismo offset contra la tx REAL de devnet ${REAL_DEVNET_TX_SIGNATURE}`, () => {
  const real = Buffer.from(REAL_DEVNET_DEPOSIT_DATA_HEX, 'hex');

  it('la ix real mide 104 bytes y abre con el discriminador de `deposit`', () => {
    expect(real.length).toBe(104);
    expect(Buffer.from(real.subarray(0, 8)).equals(Buffer.from([...DEPOSIT_DISCRIMINATOR]))).toBe(
      true,
    );
  });

  it('★ el u64 en 88 de la tx real es 10000000 = los 10 USDC que la cadena aceptó', () => {
    expect(real.readBigUInt64LE(88)).toBe(10000000n);
    expect(real.readBigUInt64LE(AMOUNT_OFFSET)).toBe(10000000n);
  });

  it('el i64 en 96 es un deadline plausible (segundos epoch de 2026), no un monto', () => {
    expect(real.readBigInt64LE(96)).toBe(1784756926n);
  });
});
