/**
 * WKH-357 / HU-064 — depósitos con durable nonce (Check 2n, Guard A y el diferencial
 * de bandera apagada).
 *
 * Fixtures con `@solana/web3.js` puro (sin anchor, sin spl-token), en el estilo de
 * `solana-sponsor.cr1.test.ts`: CR-1 es pura, así que las tx se arman acá y se le pasan
 * directo. Cero red, cero plata (devnet o no).
 *
 * ⚠️ QUÉ MIDE ESTE ARCHIVO Y QUÉ NO. Mide el lado del FACILITATOR: que CR-1 reconozca y
 * valide la `nonceAdvance` con la bandera prendida, que la rechace con la bandera
 * apagada, y que Check 5 siga sin excepciones. NO mide que chaski produzca esa forma
 * (eso vive en chaski-v3) ni nada de un teléfono real.
 */

import { describe, it, expect } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { validateDepositForSponsor, type Cr1Config } from '../../methods/solana-sponsor/cr1.js';
import { extractSponsorClaims } from '../../methods/solana-sponsor/sponsor-claims.js';
import {
  ADVANCE_NONCE_DISCRIMINATOR,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEPOSIT_DISCRIMINATOR,
  ESCROW_PROGRAM_ID_DEFAULT,
  REGISTER_ESCROW_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  TOKEN_PROGRAM_ID,
} from '../../methods/solana-sponsor/deposit-shape.js';

const ESCROW_PK = new PublicKey(ESCROW_PROGRAM_ID_DEFAULT);
const TOKEN_PK = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PK = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const SYS_PK = new PublicKey(SYSTEM_PROGRAM_ID);
const SYSVAR_PK = new PublicKey(SYSVAR_RECENT_BLOCKHASHES_ID);

const USDC_MINT_PK = new PublicKey(
  // eslint-disable-next-line no-secrets/no-secrets -- mint USDC devnet de Circle (base58 público), no es un secreto.
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

/** La config de producción: bandera APAGADA, topes con los defaults de `env.ts`. */
const CFG_OFF: Cr1Config = {
  escrowProgramId: ESCROW_PROGRAM_ID_DEFAULT,
  maxComputeUnits: 300_000,
  maxPriorityFeeMicroLamports: 50_000,
  maxFeeLamports: 100_000n,
  usdcMint: USDC_MINT_PK.toBase58(),
  releaseAuthority: undefined,
  durableNonceEnabled: false,
};

/** La MISMA config con la bandera prendida. Los topes NO se mueven. */
const CFG_ON: Cr1Config = { ...CFG_OFF, durableNonceEnabled: true };

/** `data` de un `deposit` con el layout real (104 bytes). */
function depositData(disc: readonly number[] = DEPOSIT_DISCRIMINATOR): Buffer {
  return Buffer.concat([Buffer.from([...disc]), Buffer.alloc(16 + 32 + 32 + 8 + 8)]);
}

function buildDepositIx(sender: PublicKey, escrowState?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: sender, isSigner: true, isWritable: true },
    { pubkey: USDC_MINT_PK, isSigner: false, isWritable: false },
    { pubkey: escrowState ?? Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // vault
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // sender_ata
    { pubkey: TOKEN_PK, isSigner: false, isWritable: false },
    { pubkey: ATA_PK, isSigner: false, isWritable: false },
    { pubkey: SYS_PK, isSigner: false, isWritable: false },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // reference
  ];
  return new TransactionInstruction({ programId: ESCROW_PK, keys, data: depositData() });
}

/** `register_escrow` mínimo y bien formado, ligado a este `deposit`. */
function buildRegisterEscrowIx(sender: PublicKey, escrowState: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: sender, isSigner: true, isWritable: true },
    { pubkey: escrowState, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // escrow_index
    { pubkey: SYS_PK, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: ESCROW_PK,
    keys,
    data: Buffer.concat([Buffer.from([...REGISTER_ESCROW_DISCRIMINATOR]), Buffer.alloc(16)]),
  });
}

interface NonceOverrides {
  /** La cuenta de nonce (keys[0]). Default: una pubkey al azar. */
  nonceAccount?: PublicKey;
  /** La authority (keys[2]). En el caso POSITIVO tiene que ser el sender DE VERDAD. */
  authority?: PublicKey;
  data?: Buffer;
  keys?: AccountMeta[];
  nonceAccountWritable?: boolean;
  authoritySigner?: boolean;
  authorityWritable?: boolean;
  wrongSysvar?: boolean;
}

/**
 * La `nonceAdvance`. Se arma A MANO y no con `SystemProgram.nonceAdvance` a propósito:
 * los vectores negativos necesitan deformarla, y el caso positivo tiene que poder
 * compararse contra las constantes pinneadas y no contra lo que la librería produzca.
 * Que la forma del caso positivo COINCIDA con la de la librería lo mide el gemelo de
 * este test en chaski-v3 (T-N3), que es donde se construye la tx real.
 */
function buildNonceAdvanceIx(o: NonceOverrides = {}): TransactionInstruction {
  if (o.keys !== undefined) {
    return new TransactionInstruction({
      programId: SYS_PK,
      keys: o.keys,
      data: o.data ?? Buffer.from([...ADVANCE_NONCE_DISCRIMINATOR]),
    });
  }
  const keys: AccountMeta[] = [
    {
      pubkey: o.nonceAccount ?? Keypair.generate().publicKey,
      isSigner: false,
      isWritable: o.nonceAccountWritable ?? true,
    },
    {
      pubkey: o.wrongSysvar === true ? Keypair.generate().publicKey : SYSVAR_PK,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: o.authority ?? Keypair.generate().publicKey,
      isSigner: o.authoritySigner ?? true,
      isWritable: o.authorityWritable ?? false,
    },
  ];
  return new TransactionInstruction({
    programId: SYS_PK,
    keys,
    data: o.data ?? Buffer.from([...ADVANCE_NONCE_DISCRIMINATOR]),
  });
}

interface TxOpts {
  feePayer: PublicKey;
  sender: PublicKey;
  /**
   * Los overrides de la `nonceAdvance`. ⚠️ `undefined` (o ausente) significa **nonce
   * presente con la forma canónica**, y `null` significa **sin nonce**. NO al revés: la
   * primera versión de este helper trataba `undefined` como "sin nonce" y NINGUNO de los
   * 24 fixtures llevaba la `nonceAdvance`. Cayeron 11 tests a la vez y por eso se vio;
   * con aserciones más flojas (un `expect(r.ok).toBe(false)` suelto) la suite habría
   * quedado VERDE sin ejercitar una sola vez el camino que vino a medir.
   */
  nonce?: NonceOverrides | null;
  /** `true` ⇒ la `nonceAdvance` va DESPUÉS del ComputeBudget (posición != 0). */
  nonceAfterComputeBudget?: boolean;
  computeUnitLimit?: number | null;
  computeUnitPriceMicroLamports?: number | null;
  withRegister?: boolean;
  extraFirst?: TransactionInstruction;
}

/**
 * La forma REAL del contrato de integración:
 *   [ nonceAdvance, SetComputeUnitLimit, SetComputeUnitPrice, deposit (, register_escrow) ]
 * con la `nonceAdvance` en posición 0 ABSOLUTA.
 */
function buildTx(o: TxOpts): Transaction {
  const tx = new Transaction();
  const escrowState = Keypair.generate().publicKey;
  const nonceIx =
    o.nonce === null ? undefined : buildNonceAdvanceIx({ authority: o.sender, ...(o.nonce ?? {}) });
  if (o.extraFirst !== undefined) tx.add(o.extraFirst);
  if (nonceIx !== undefined && o.nonceAfterComputeBudget !== true) tx.add(nonceIx);
  if (o.computeUnitLimit !== null) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnitLimit ?? 200_000 }));
  }
  if (o.computeUnitPriceMicroLamports !== null) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: o.computeUnitPriceMicroLamports ?? 1_000,
      }),
    );
  }
  if (nonceIx !== undefined && o.nonceAfterComputeBudget === true) tx.add(nonceIx);
  tx.add(buildDepositIx(o.sender, escrowState));
  if (o.withRegister === true) tx.add(buildRegisterEscrowIx(o.sender, escrowState));
  tx.feePayer = o.feePayer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

describe('WKH-357 — CR-1 Check 2n: la nonceAdvance del depósito por enlace', () => {
  const feePayer = Keypair.generate().publicKey;

  // ── T-10 — caso positivo (AC-4) ───────────────────────────────────────────
  it('★ T-10: bandera prendida + tx bien formada → { ok:true, durableNonce:true }', () => {
    const sender = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender });
    // El fixture POSITIVO trae la authority == sender DE VERDAD, no omitida: la
    // lección del repo es que el test del camino feliz puede estar ejercitando el
    // agujero que el guard existe para tapar. Se assertea acá, sobre el fixture.
    const nonce = tx.instructions[0];
    expect(nonce?.keys[2]?.pubkey.equals(sender)).toBe(true);
    expect(nonce?.programId.equals(SYS_PK)).toBe(true);

    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.durableNonce).toBe(true);
      expect(r.feeUpperBoundLamports).toBeGreaterThan(0n);
    }
  });

  it('T-10b: la forma atómica [nonce, CB, CB, deposit, register_escrow] también pasa', () => {
    const sender = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender, withRegister: true });
    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.durableNonce).toBe(true);
  });

  // ── T-11 — la authority NO es el sender (el corazón de AC-4) ───────────────
  it('★ T-11: authority ≠ deposit.keys[0] → NONCE_AUTHORITY_NOT_SENDER', () => {
    const sender = Keypair.generate().publicKey;
    const otro = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender, nonce: { authority: otro } });
    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NONCE_AUTHORITY_NOT_SENDER');
  });

  // ── T-12 — los OCHO vectores negativos, cada uno con SU reason ─────────────
  //
  // ⚠️ DOS de los ocho NO dan un `NONCE_IX_*` y está bien que no lo den: una ix cuyo
  // discriminador NO es `[4,0,0,0]` no es una `nonceAdvance` para nada, así que no entra
  // a Check 2n — queda como ix de negocio, es `businessIx[0]`, su programId es el System
  // Program y no el escrow, y sale por `PROGRAM_NOT_WHITELISTED`, que es el veredicto de
  // SIEMPRE. Sigue siendo fail-closed, y es el mismo camino por el que sale un
  // `SystemProgram.transfer` colado. Se assertea el resultado MEDIDO, no el esperado.
  const negativos: ReadonlyArray<{ nombre: string; nonce: NonceOverrides; reason: string }> = [
    {
      nombre: 'data de 5 bytes ([4,0,0,0,99]) — el input que un `>=` dejaría pasar',
      nonce: { data: Buffer.from([4, 0, 0, 0, 99]) },
      reason: 'NONCE_IX_BAD_DISCRIMINATOR',
    },
    {
      nombre: 'data [3,0,0,0] — no es un AdvanceNonceAccount',
      nonce: { data: Buffer.from([3, 0, 0, 0]) },
      reason: 'PROGRAM_NOT_WHITELISTED',
    },
    {
      nombre: '2 cuentas',
      nonce: {
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_PK, isSigner: false, isWritable: false },
        ],
      },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
    {
      nombre: '4 cuentas',
      nonce: {
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_PK, isSigner: false, isWritable: false },
          { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
        ],
      },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
    {
      nombre: 'sysvar equivocado en keys[1]',
      nonce: { wrongSysvar: true },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
    {
      nombre: 'keys[0] (la cuenta de nonce) NO writable',
      nonce: { nonceAccountWritable: false },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
    {
      nombre: 'keys[2] (la authority) NO signer',
      nonce: { authoritySigner: false },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
    {
      nombre: 'keys[2] (la authority) writable',
      nonce: { authorityWritable: true },
      reason: 'NONCE_IX_ACCOUNTS_INVALID',
    },
  ];

  for (const v of negativos) {
    it(`★ T-12: ${v.nombre} → ${v.reason}`, () => {
      const sender = Keypair.generate().publicKey;
      const nonce = v.nonce.keys !== undefined ? v.nonce : { authority: sender, ...v.nonce };
      const tx = buildTx({ feePayer, sender, nonce });
      const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(v.reason);
    });
  }

  it('★ T-12 (9º): la nonceAdvance en posición 1 (después del ComputeBudget) → NONCE_IX_NOT_FIRST', () => {
    // Importa que sea un rechazo con causa PROPIA: el runtime sólo trata la tx como
    // durable-nonce si el advance es la ix 0, así que una en posición 1 avanzaría el
    // nonce SIN que el nonce gobierne la vigencia de la tx.
    const sender = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender, nonceAfterComputeBudget: true });
    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NONCE_IX_NOT_FIRST');
  });

  // ── T-13 — el `deposit` sigue siendo businessIx[0] ────────────────────────
  it('★ T-13: [nonceAdvance, register_escrow, deposit] → RECHAZA (el deposit no es la 1ª de negocio)', () => {
    const sender = Keypair.generate().publicKey;
    const escrowState = Keypair.generate().publicKey;
    const tx = new Transaction();
    tx.add(buildNonceAdvanceIx({ authority: sender }));
    // El ComputeBudget va SÍ o SÍ: sin él, 3 ix de cómputo (nonce + register + deposit)
    // dan un implícito de 600.000 > 300.000 y la tx saldría por el cap de CU en vez de
    // por lo que este vector mide, que es la POSICIÓN del `deposit`.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
    tx.add(buildRegisterEscrowIx(sender, escrowState));
    tx.add(buildDepositIx(sender, escrowState));
    tx.feePayer = feePayer;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    // El `register_escrow` cae en `businessIx[0]`, pasa el whitelist de programId (es
    // del mismo escrow) y muere en el discriminador. Lo que importa es que NO se
    // busque el `deposit` por discriminador: la posición sigue siendo la regla.
    if (!r.ok) expect(r.reason).toBe('BAD_DISCRIMINATOR');
  });

  // ── T-14 — Check 5 SIN excepciones (n7). OBLIGATORIO ──────────────────────
  it('★★ T-14: el fee-payer como CUENTA DE NONCE, referenciado SÓLO en la nonceAdvance → FEE_PAYER_REFERENCED_IN_INSTRUCTION', () => {
    // 🔴 ÉSTE es el vector que prueba que A1 no debilitó el invariante más fuerte del
    // anti-drain. El fee-payer NO aparece en ninguna ix de negocio: si Check 5 iterara
    // `businessIx` en vez de `instructions`, esta tx PASARÍA. Y pasa n1..n6 completos
    // (la cuenta de nonce es writable non-signer, la authority es el sender), así que
    // lo único que la rechaza es Check 5.
    const sender = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender, nonce: { nonceAccount: feePayer } });
    const referenciasAlFeePayer = tx.instructions.filter((ix) =>
      ix.keys.some((k) => k.pubkey.equals(feePayer)),
    );
    // El fixture mide su propia premisa: UNA sola ix referencia al fee-payer, y es la del nonce.
    expect(referenciasAlFeePayer).toHaveLength(1);
    expect(referenciasAlFeePayer[0]?.programId.equals(SYS_PK)).toBe(true);

    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
  });

  it('T-14b: el fee-payer como authority del nonce (y sender) → también rechaza', () => {
    // Acá el fee-payer sí aparece en el `deposit`, así que este vector NO distingue el
    // bucle de Check 5 — se queda como belt-and-braces del caso que el enunciado de la
    // HU nombra ("la authority es el fee-payer").
    const tx = buildTx({ feePayer, sender: feePayer });
    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
  });

  // ── T-25 — el presupuesto de cómputo cuenta la nonceAdvance ───────────────
  describe('★ T-25 (§6.4): el límite implícito de CU CUENTA la nonceAdvance', () => {
    it('con los topes de producción, [nonce, price, deposit] SIN SetComputeUnitLimit → IMPLICIT_COMPUTE_UNITS_ABOVE_MAX', () => {
      // 200.000 × (1 deposit + 1 nonceAdvance) = 400.000 > 300.000 (el tope default).
      // Si la `nonceAdvance` NO se contara, el implícito sería 200.000, entraría bajo el
      // tope y esta tx se aceptaría declarando la MITAD del cómputo que el runtime va a
      // cobrar ⇒ `feeUpperBoundLamports` deja de ser cota superior y el cap diario
      // sub-cuenta. Es AR-G4 BLQ-MEDIO-1 reintroducido.
      const sender = Keypair.generate().publicKey;
      const tx = buildTx({ feePayer, sender, computeUnitLimit: null });
      const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('IMPLICIT_COMPUTE_UNITS_ABOVE_MAX');
    });

    it('el fee implícito de [nonce, price, deposit] es el de 400.000 CU declarados, no el de 200.000', () => {
      // La igualdad exacta que nombra §6.4. Requiere un tope de CU que deje pasar las
      // dos formas para poder COMPARARLAS: se sube el tope DEL FIXTURE, no el de
      // producción (los topes de `env.ts` no se tocan en esta HU).
      const cfg: Cr1Config = { ...CFG_ON, maxComputeUnits: 600_000, maxFeeLamports: 10_000_000n };
      const sender = Keypair.generate().publicKey;
      const price = 1_000;
      const implicita = buildTx({
        feePayer,
        sender,
        computeUnitLimit: null,
        computeUnitPriceMicroLamports: price,
      });
      const declarada400k = buildTx({
        feePayer,
        sender,
        computeUnitLimit: 400_000,
        computeUnitPriceMicroLamports: price,
      });
      const declarada200k = buildTx({
        feePayer,
        sender,
        computeUnitLimit: 200_000,
        computeUnitPriceMicroLamports: price,
      });
      const rImpl = validateDepositForSponsor(implicita, feePayer, cfg);
      const r400 = validateDepositForSponsor(declarada400k, feePayer, cfg);
      const r200 = validateDepositForSponsor(declarada200k, feePayer, cfg);
      expect(rImpl.ok && r400.ok && r200.ok).toBe(true);
      if (rImpl.ok && r400.ok && r200.ok) {
        expect(rImpl.feeUpperBoundLamports).toBe(r400.feeUpperBoundLamports);
        // Y NO es el de 200.000: sin esta línea la igualdad de arriba se cumpliría
        // igual si los tres colapsaran al mismo número por otra razón.
        expect(rImpl.feeUpperBoundLamports).not.toBe(r200.feeUpperBoundLamports);
      }
    });
  });

  // ── T-20 — el diferencial de bandera APAGADA (AC-8) ───────────────────────
  describe('★ T-20 (AC-8): con la bandera apagada, TODA entrada da el veredicto de antes de esta HU', () => {
    it('una tx con nonceAdvance en 0 → PROGRAM_NOT_WHITELISTED en CR-1 (el camino de siempre)', () => {
      const sender = Keypair.generate().publicKey;
      const tx = buildTx({ feePayer, sender });
      const r = validateDepositForSponsor(tx, feePayer, CFG_OFF);
      expect(r.ok).toBe(false);
      // La `nonceAdvance` queda dentro de `businessIx`, es `businessIx[0]`, y su
      // programId es el System Program y no el escrow. Ni una línea nueva se ejecuta.
      if (!r.ok) expect(r.reason).toBe('PROGRAM_NOT_WHITELISTED');
    });

    it('una tx SIN nonce da EXACTAMENTE el mismo {ok, reason} con la bandera prendida y apagada', () => {
      // El diferencial que importa: la bandera no puede cambiar el veredicto de ninguna
      // tx que no lleve nonce. Se barren el caso feliz y 4 formas negativas.
      const sender = Keypair.generate().publicKey;
      const escrowState = Keypair.generate().publicKey;
      const casos: ReadonlyArray<{ nombre: string; tx: Transaction }> = [
        { nombre: 'deposit canónico', tx: buildTx({ feePayer, sender, nonce: null }) },
        {
          nombre: 'deposit + register_escrow',
          tx: buildTx({ feePayer, sender, nonce: null, withRegister: true }),
        },
        {
          nombre: 'feePayer referenciado (drain)',
          tx: buildTx({ feePayer, sender: feePayer, nonce: null }),
        },
        {
          nombre: 'SystemProgram.transfer colado como 1ª de negocio',
          tx: buildTx({
            feePayer,
            sender,
            nonce: null,
            extraFirst: SystemProgram.transfer({
              fromPubkey: sender,
              toPubkey: Keypair.generate().publicKey,
              lamports: 1,
            }),
          }),
        },
        {
          nombre: 'sin SetComputeUnitLimit (implícito bajo el tope)',
          tx: buildTx({ feePayer, sender, nonce: null, computeUnitLimit: null }),
        },
        {
          nombre: 'register_escrow como 1ª de negocio',
          tx: (() => {
            const t = new Transaction();
            t.add(buildRegisterEscrowIx(sender, escrowState));
            t.add(buildDepositIx(sender, escrowState));
            t.feePayer = feePayer;
            t.recentBlockhash = Keypair.generate().publicKey.toBase58();
            return t;
          })(),
        },
      ];
      for (const c of casos) {
        const off = validateDepositForSponsor(c.tx, feePayer, CFG_OFF);
        const on = validateDepositForSponsor(c.tx, feePayer, CFG_ON);
        expect({ caso: c.nombre, ok: on.ok, reason: on.ok ? undefined : on.reason }).toEqual({
          caso: c.nombre,
          ok: off.ok,
          reason: off.ok ? undefined : off.reason,
        });
        // Y el campo nuevo NO aparece: el objeto de éxito es el de antes de la HU.
        if (off.ok) expect(off.durableNonce).toBeUndefined();
        if (on.ok) expect(on.durableNonce).toBeUndefined();
      }
    });

    it('Guard A con la bandera apagada rechaza la tx con nonce por SHORT_DEPOSIT_DATA (medido, no BAD_DISCRIMINATOR)', () => {
      // ⚠️ El orden de los checks de `extractSponsorClaims` es el que decide el
      // marcador: `data.length < DEPOSIT_DATA_LEN` está ANTES del discriminador, y la
      // `nonceAdvance` tiene 4 bytes ⇒ nunca se llega a comparar el discriminador. El
      // 403 al cliente es el mismo; el marcador del log es éste.
      const senderKp = Keypair.generate();
      const tx = buildTx({ feePayer, sender: senderKp.publicKey });
      const r = extractSponsorClaims(tx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('SHORT_DEPOSIT_DATA');
    });

    it('Guard A con la bandera PRENDIDA saltea la nonceAdvance y lee el deposit real', () => {
      const senderKp = Keypair.generate();
      const tx = buildTx({ feePayer, sender: senderKp.publicKey });
      tx.partialSign(senderKp);
      const r = extractSponsorClaims(tx, { allowDurableNonce: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.claims.sender).toBe(senderKp.publicKey.toBase58());
    });

    it('Guard A: el default del parámetro es `false` (los llamadores viejos no cambian)', () => {
      const senderKp = Keypair.generate();
      const tx = buildTx({ feePayer, sender: senderKp.publicKey });
      tx.partialSign(senderKp);
      // Sin opts y con opts vacío tienen que dar lo MISMO que la bandera apagada.
      const sinOpts = extractSponsorClaims(tx);
      const optsVacio = extractSponsorClaims(tx, {});
      const explicitoFalse = extractSponsorClaims(tx, { allowDurableNonce: false });
      expect(sinOpts.ok).toBe(false);
      expect(optsVacio).toEqual(sinOpts);
      expect(explicitoFalse).toEqual(sinOpts);
    });
  });

  // ── T-28 — el round-trip real (R9) ────────────────────────────────────────
  it('★ T-28 (R9): serialize → Transaction.from → partialSign(feePayer) → verifySignatures(true) con la nonceAdvance presente', () => {
    // Que `partialSign` del lado del facilitator recompile un mensaje IDÉNTICO con una
    // ix más es un fallo que sólo aparece en runtime: ningún typecheck lo ve. Esto es
    // lo que deja R9 de ser `[NO VERIFICADO]`.
    const senderKp = Keypair.generate();
    const feePayerKp = Keypair.generate();
    const tx = buildTx({ feePayer: feePayerKp.publicKey, sender: senderKp.publicKey });
    tx.partialSign(senderKp);
    const bytes = tx.serialize({ requireAllSignatures: false });

    const recibida = Transaction.from(bytes);
    expect(recibida.instructions).toHaveLength(4);
    expect(recibida.instructions[0]?.programId.equals(SYS_PK)).toBe(true);
    expect([...(recibida.instructions[0]?.data ?? [])]).toEqual([...ADVANCE_NONCE_DISCRIMINATOR]);

    recibida.partialSign(feePayerKp);
    expect(recibida.verifySignatures(true)).toBe(true);
    // Y el `recentBlockhash` que viaja es el valor del nonce, intacto.
    expect(recibida.recentBlockhash).toBe(tx.recentBlockhash);
  });

  // ── T-29 — por qué la detección NO puede preguntarle a `nonceInfo` ────────
  it('T-29: Transaction.from NO setea `nonceInfo` ⇒ CR-1 tiene que inspeccionar la ix', () => {
    // Test DOCUMENTAL de la librería, no de nuestro código, y por eso no lleva mutante:
    // su valor es explicar por qué Check 2n mira los bytes de la ix 0 y no un campo del
    // objeto. Del lado del facilitator `tx.nonceInfo` es SIEMPRE `undefined`, incluso
    // para una tx que sí es durable-nonce, así que preguntarle daría un falso negativo
    // en el 100% de los casos.
    const senderKp = Keypair.generate();
    const tx = buildTx({ feePayer, sender: senderKp.publicKey });
    tx.partialSign(senderKp);
    const recibida = Transaction.from(tx.serialize({ requireAllSignatures: false }));
    expect(recibida.nonceInfo).toBeUndefined();
    // …y aun así la ix 0 del mensaje que viajó ES la nonceAdvance.
    expect(recibida.instructions[0]?.programId.equals(SYS_PK)).toBe(true);
  });
});
