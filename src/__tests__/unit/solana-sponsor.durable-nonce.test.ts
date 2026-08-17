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
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
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
  /**
   * ¿Pasar el fixture por el cable antes de devolverlo? **Default `true`**, y ése es el
   * arreglo de AR BLQ-ALTO-1 al nivel del método (ver el docblock de `buildTx`).
   *
   * `false` SÓLO para los vectores cuya deformación el round-trip BORRA — la unión de
   * metas la sobreescribe — y que por lo tanto son inalcanzables en el cable. Cada uso de
   * `roundTrip: false` lleva al lado la medición de qué se borra y por qué el vector se
   * conserva igual. Si no tiene ese comentario, está mal usado.
   */
  roundTrip?: boolean;
}

/**
 * La forma REAL del contrato de integración:
 *   [ nonceAdvance, SetComputeUnitLimit, SetComputeUnitPrice, deposit (, register_escrow) ]
 * con la `nonceAdvance` en posición 0 ABSOLUTA.
 *
 * 🔴 EL ROUND-TRIP ES EL DEFAULT, y no es cosmético (AR BLQ-ALTO-1). Producción NUNCA ve
 * el objeto `Transaction` que se construye acá: ve `parseSponsorTx` → `Transaction.from`
 * sobre los bytes (`broadcast.ts:161-183`). Y en un mensaje LEGACY `isSigner`/`isWritable`
 * son propiedades **del mensaje** (header + orden de `accountKeys`), no de cada
 * instrucción, así que en ese round-trip la meta de cada pubkey **colapsa a la UNIÓN**
 * sobre todas las ix. MEDIDO sobre este mismo fixture: la authority del nonce entra
 * `signer=true writable=false` y vuelve `signer=true writable=TRUE`.
 *
 * ⚠️ POR QUÉ ES DEFAULT Y NO UN OPT-IN. La primera versión de este archivo validaba los 24
 * vectores en memoria y tenía UN test de round-trip (T-28) que no llamaba al validador. La
 * suite entera quedó midiendo **una forma de transacción que no existe en el cable**, y con
 * la bandera prendida CR-1 rechazaba el 100% de los depósitos con nonce sin que un solo
 * test se pusiera rojo. Un opt-in habría dejado el default en el lado equivocado: el
 * fixture que alguien agregue mañana tiene que cruzar el cable **sin acordarse**.
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
  if (o.roundTrip === false) return tx;
  return porElCable(tx);
}

/**
 * El cable, en una función, para que los fixtures armados A MANO (T-13, y el caso inline de
 * T-20) puedan cruzarlo igual que los de `buildTx`. `requireAllSignatures: false` porque el
 * sender firma en la billetera del remitente y acá no hay claves privadas para la mayoría de
 * los vectores; lo que el round-trip tiene que reproducir es el MENSAJE (y sus banderas), no
 * las firmas.
 */
function porElCable(tx: Transaction): Transaction {
  return Transaction.from(tx.serialize({ requireAllSignatures: false }));
}

describe('WKH-357 — las constantes pinneadas, contra una fuente que NO se mueve con ellas', () => {
  // ⚠️ POR QUÉ ESTE `describe` EXISTE (AR MNR-2). El mutante
  // `SYSVAR_RECENT_BLOCKHASHES_ID`: `…1111` → `…1112` (otra pubkey base58 válida) dejaba la
  // suite ENTERA en verde. La causa es "guards que se comparan consigo mismos": el fixture
  // hacía `new PublicKey(SYSVAR_RECENT_BLOCKHASHES_ID)`, o sea el validador y el vector se
  // movían JUNTOS con el mutante. Si el valor estuviera mal de verdad, n4 rechazaría TODO
  // depósito con nonce, fail-closed y en silencio.
  //
  // El arreglo no es cambiar la constante —sigue siendo un literal pinneado a propósito
  // (CD-12: el validador compara contra bytes fijos, no contra lo que la librería devuelva
  // después de un bump)— sino DARLE UNA SEGUNDA FUENTE al test. `@solana/web3.js` ya es
  // dependencia y exporta el sysvar, y ese export NO se mueve con nuestro literal.
  // El gemelo de este control en chaski es `nonce-duradero.test.ts`.
  it('★ el sysvar de recent-blockhashes es EXACTAMENTE el de @solana/web3.js', () => {
    expect(SYSVAR_RECENT_BLOCKHASHES_ID).toBe(SYSVAR_RECENT_BLOCKHASHES_PUBKEY.toBase58());
  });

  it('★ el discriminador de AdvanceNonceAccount es el que emite SystemProgram.nonceAdvance', () => {
    // El mutante hermano (`[4,0,0,0]`→`[5,0,0,0]`) moría, pero por UN solo vector y de
    // rebote (el `[4,0,0,0,99]` hardcodeado de T-12). Acá muere de frente y por su propio
    // motivo, contra la fuente que de verdad decide qué byte espera el System Program.
    const ref = SystemProgram.nonceAdvance({
      noncePubkey: Keypair.generate().publicKey,
      authorizedPubkey: Keypair.generate().publicKey,
    });
    expect([...ref.data]).toEqual([...ADVANCE_NONCE_DISCRIMINATOR]);
    // Y la forma completa que n3/n5/n4 exigen, contra la ix que arma la librería.
    expect(ref.keys).toHaveLength(3);
    expect(ref.keys[1]?.pubkey.equals(SYSVAR_RECENT_BLOCKHASHES_PUBKEY)).toBe(true);
    expect({ s: ref.keys[0]?.isSigner, w: ref.keys[0]?.isWritable }).toEqual({ s: false, w: true });
    expect({ s: ref.keys[1]?.isSigner, w: ref.keys[1]?.isWritable }).toEqual({
      s: false,
      w: false,
    });
    expect(ref.keys[2]?.isSigner).toBe(true);
  });
});

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
    // ⛔ ACÁ HABÍA DOS VECTORES MÁS SOBRE LA AUTHORITY, y los dos se fueron de esta lista
    // por AR BLQ-ALTO-1 — no por conveniencia, sino porque el round-trip **borra** la
    // deformación que pretendían introducir. Están abajo, cada uno con su medición:
    //   • 'keys[2] writable'   → ya NO es un rechazo (T-31): es la ÚNICA forma que existe
    //                            en el cable, y exigir lo contrario tumbaba la feature.
    //   • 'keys[2] NO signer'  → sigue siendo un rechazo pero SÓLO en memoria (T-32),
    //                            porque en el cable la unión le devuelve el `signer`.
    // Dejarlos en esta lista, que ahora cruza el cable, los volvía verdes por la razón
    // equivocada: el n6 roto y el n6 arreglado rechazaban los dos con el MISMO enum.
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

  // ── T-31 / T-32 — las dos banderas de la AUTHORITY, con la medición del cable ──
  it('★★ T-31 (AR BLQ-ALTO-1): la authority WRITABLE se ACEPTA, porque es la única forma que llega por el cable', () => {
    // Éste es el vector que la HU tenía invertido. Se construye la deformación A MANO
    // (`authorityWritable: true`) Y ADEMÁS se mide que el fixture canónico llega igual:
    // la deformación es indistinguible del caso legítimo una vez que el mensaje se
    // recompila, así que "rechazar la authority writable" era "rechazar todo".
    const sender = Keypair.generate().publicKey;
    const deformada = buildTx({ feePayer, sender, nonce: { authorityWritable: true } });
    const canonica = buildTx({ feePayer, sender });
    const authDef = deformada.instructions[0]?.keys[2];
    const authCan = canonica.instructions[0]?.keys[2];
    // La premisa medida: tras el cable las DOS son signer=true writable=true.
    expect({ s: authDef?.isSigner, w: authDef?.isWritable }).toEqual({ s: true, w: true });
    expect({ s: authCan?.isSigner, w: authCan?.isWritable }).toEqual({ s: true, w: true });
    // ⇒ el veredicto tiene que ser el mismo, y tiene que ser ACEPTAR.
    const rDef = validateDepositForSponsor(deformada, feePayer, CFG_ON);
    const rCan = validateDepositForSponsor(canonica, feePayer, CFG_ON);
    expect(rDef.ok).toBe(true);
    expect(rCan.ok).toBe(true);
    if (rDef.ok) expect(rDef.durableNonce).toBe(true);
  });

  it('T-32: la authority NO signer rechaza en MEMORIA, y en el cable el vector es inalcanzable (medido)', () => {
    // `roundTrip: false` porque la deformación no sobrevive: la authority ES el sender y el
    // `deposit` lo marca signer, así que la unión de metas le devuelve el `isSigner`. Se
    // mide LAS DOS COSAS para que quede escrito y no inferido, y para que la mitad
    // `!authorityAcct.isSigner` de n6 no se lea como cobertura del camino de producción.
    const sender = Keypair.generate().publicKey;
    const enMemoria = buildTx({
      feePayer,
      sender,
      nonce: { authoritySigner: false },
      roundTrip: false,
    });
    expect(enMemoria.instructions[0]?.keys[2]?.isSigner).toBe(false);
    const rMem = validateDepositForSponsor(enMemoria, feePayer, CFG_ON);
    expect(rMem.ok).toBe(false);
    if (!rMem.ok) expect(rMem.reason).toBe('NONCE_IX_ACCOUNTS_INVALID');

    // Y el mismo fixture tras el cable: la deformación desapareció ⇒ pasa. Fail-closed
    // igual, porque no hay nada que cerrar: la tx es la legítima.
    const porElCable = buildTx({ feePayer, sender, nonce: { authoritySigner: false } });
    expect(porElCable.instructions[0]?.keys[2]?.isSigner).toBe(true);
    expect(validateDepositForSponsor(porElCable, feePayer, CFG_ON).ok).toBe(true);
  });

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
    // El fixture se arma a mano, así que el cable se pide EXPLÍCITAMENTE: `buildTx` no
    // participa acá y su default no protege a este `it` (AR BLQ-ALTO-1).
    const r = validateDepositForSponsor(porElCable(tx), feePayer, CFG_ON);
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
    //
    // ⚠️ `roundTrip: false`, Y ES LA EXCEPCIÓN QUE MÁS IMPORTA DECLARAR (AR BLQ-ALTO-1).
    // El fee-payer es `accountKeys[0]` del mensaje, o sea signer y writable SIEMPRE, así
    // que tras `Transaction.from` la cuenta de nonce vuelve con `isSigner: true` y **n5 la
    // rechaza antes de que Check 5 la vea**. MEDIDO, mismo fixture:
    //     cuenta de nonce (== feePayer) tras el cable: signer=true writable=true
    //     tras el cable : REJECT NONCE_IX_ACCOUNTS_INVALID
    //     en memoria    : REJECT FEE_PAYER_REFERENCED_IN_INSTRUCTION
    // Las dos son fail-closed y ninguna firma, pero el vector que aísla EL BUCLE de Check 5
    // sólo existe en memoria. Se conserva así a propósito: es el único que muere si alguien
    // cambia `instructions` por `businessIx`, y ese mutante es el que hay que matar.
    //
    // ⇒ Consecuencia que conviene tener escrita: en el cable, "el fee-payer referenciado
    // SÓLO en la nonceAdvance" es INALCANZABLE. keys[0] lo caza n5 (siempre signer),
    // keys[1] es el sysvar pinneado, y keys[2] tiene que ser el sender — y entonces el
    // fee-payer está también en el `deposit`, que es el caso de T-14b.
    const sender = Keypair.generate().publicKey;
    const tx = buildTx({ feePayer, sender, nonce: { nonceAccount: feePayer }, roundTrip: false });
    const referenciasAlFeePayer = tx.instructions.filter((ix) =>
      ix.keys.some((k) => k.pubkey.equals(feePayer)),
    );
    // El fixture mide su propia premisa: UNA sola ix referencia al fee-payer, y es la del nonce.
    expect(referenciasAlFeePayer).toHaveLength(1);
    expect(referenciasAlFeePayer[0]?.programId.equals(SYS_PK)).toBe(true);

    const r = validateDepositForSponsor(tx, feePayer, CFG_ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FEE_PAYER_REFERENCED_IN_INSTRUCTION');

    // Y el MISMO fixture tras el cable: sigue rechazando, con el marcador de n5. Se
    // assertea para que el día que esto cambie, el test lo diga en vez de callarse.
    const porElCable = buildTx({ feePayer, sender, nonce: { nonceAccount: feePayer } });
    expect(porElCable.instructions[0]?.keys[0]?.isSigner).toBe(true);
    const rCable = validateDepositForSponsor(porElCable, feePayer, CFG_ON);
    expect(rCable.ok).toBe(false);
    if (!rCable.ok) expect(rCable.reason).toBe('NONCE_IX_ACCOUNTS_INVALID');
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

    it('★ y con register_escrow el enum es OTRO: NOT_EXACTLY_ONE_BUSINESS_IX (AR MNR-1)', () => {
      // 🔴 EL PUNTO DE ESTE VECTOR ES QUE SON DOS MARCADORES, NO UNO. Tres comentarios del
      // repo (el docblock de `Cr1Config.durableNonceEnabled`, el de Check 2n y el de
      // `routes/solana-sponsor.ts`) afirmaban `PROGRAM_NOT_WHITELISTED` **sin condiciones**,
      // y chaski produce las DOS formas según haya lugar en el índice on-chain (WKH-347).
      // Con `register_escrow` presente, `businessIxTodas` es 3 y Check 2 corta por CANTIDAD
      // antes de mirar un solo programId. Quien opere grepeando el marcador equivocado no
      // encuentra la mitad de sus rechazos.
      const sender = Keypair.generate().publicKey;
      const tx = buildTx({ feePayer, sender, withRegister: true });
      const r = validateDepositForSponsor(tx, feePayer, CFG_OFF);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('NOT_EXACTLY_ONE_BUSINESS_IX');
    });

    it('Guard A sí da SHORT_DEPOSIT_DATA en las DOS formas (el contraste de AR MNR-1)', () => {
      // El asimétrico es CR-1, no Guard A: `extractSponsorClaims` mira el largo de la data
      // de la ix 0 antes que cualquier otra cosa, y la `nonceAdvance` tiene 4 bytes en las
      // dos formas. Se mide para que la afirmación del `doc/deploy` quede respaldada.
      const sender = Keypair.generate().publicKey;
      for (const withRegister of [false, true]) {
        const r = extractSponsorClaims(buildTx({ feePayer, sender, withRegister }));
        expect(r.ok).toBe(false);
        if (!r.ok)
          expect({ withRegister, reason: r.reason }).toEqual({
            withRegister,
            reason: 'SHORT_DEPOSIT_DATA',
          });
      }
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
            return porElCable(t);
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

  // ── T-30 — EL CONTROL QUE CIERRA LA CLASE (AR BLQ-ALTO-1) ─────────────────
  it('★★ T-30: el fixture POSITIVO, serializado y reconstruido con Transaction.from, sigue dando ok', () => {
    // 🔴 ÉSTE es el `it` que faltaba, y su ausencia dejó pasar un rechazo del 100% de los
    // depósitos con nonce. Es el ÚNICO test de este archivo que mide lo que llega por el
    // CABLE en vez de un objeto `Transaction` construido en memoria, y el único que no se
    // puede satisfacer eligiendo las banderas del fixture: `Transaction.from` las
    // recalcula desde el mensaje.
    //
    // ⚠️ NO alcanza con que `buildTx` haga el round-trip por default (que lo hace, ver su
    // docblock): eso protege a los 24 vectores pero es una propiedad del HELPER, y quien
    // agregue un fixture a mano —como los de T-13 y T-14, que arman el `Transaction`
    // directo— la pierde sin que nada avise. Este `it` la assertea de punta a punta y
    // ADEMÁS deja escritas las banderas medidas antes y después, que es el dato que
    // explica por qué n6 no puede exigir `!isWritable`.
    const senderKp = Keypair.generate();
    const feePayerKp = Keypair.generate();
    const fp = feePayerKp.publicKey;
    const enMemoria = buildTx({ feePayer: fp, sender: senderKp.publicKey, roundTrip: false });

    // La premisa, medida sobre el fixture: la authority llega NO-writable en memoria.
    const authAntes = enMemoria.instructions[0]?.keys[2];
    expect(authAntes?.pubkey.equals(senderKp.publicKey)).toBe(true);
    expect(authAntes?.isSigner).toBe(true);
    expect(authAntes?.isWritable).toBe(false);

    enMemoria.partialSign(senderKp);
    const recibida = Transaction.from(enMemoria.serialize({ requireAllSignatures: false }));

    // 🔴 EL COLAPSO, medido: en un mensaje legacy las banderas son del MENSAJE, no de la
    // ix, así que la meta de cada pubkey se une sobre todas las instrucciones. El sender
    // es signer+writable en el `deposit` (Check 4 lo EXIGE: `SENDER_FLAGS_INVALID` en
    // `cr1.ts`) y la authority ES el sender (n6 parte 2: `NONCE_AUTHORITY_NOT_SENDER`)
    // ⇒ la authority vuelve WRITABLE, siempre. Se citan por ENUM y no por línea a
    // propósito: `cr1.ts` se mueve con cada HU y este repo no tiene candado de citas.
    const authDespues = recibida.instructions[0]?.keys[2];
    expect(authDespues?.isSigner).toBe(true);
    expect(authDespues?.isWritable).toBe(true);

    // Y con esa forma —la única que existe en el cable— CR-1 tiene que ACEPTAR.
    const r = validateDepositForSponsor(recibida, fp, CFG_ON);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.durableNonce).toBe(true);

    // Las otras dos cuentas del nonce NO colapsan, y por eso n5/n4 sí pueden assertar
    // banderas: aparecen SÓLO en la `nonceAdvance`, así que no hay unión que las mueva.
    const nonceAcct = recibida.instructions[0]?.keys[0];
    const sysvarAcct = recibida.instructions[0]?.keys[1];
    expect(nonceAcct?.isSigner).toBe(false);
    expect(nonceAcct?.isWritable).toBe(true);
    expect(sysvarAcct?.isSigner).toBe(false);
    expect(sysvarAcct?.isWritable).toBe(false);
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
