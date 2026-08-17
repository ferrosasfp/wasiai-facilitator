/**
 * WKH-217 / HU-SOL-14 — CR-1: `validateDepositForSponsor` (THE anti-drain core).
 *
 * The `SponsorTxValidator` for the escrow `deposit`. Given a PARSED legacy
 * transaction and the fee-payer pubkey, it asserts — fail-closed, in order —
 * that the tx is EXACTLY the expected `deposit` and that the fee-payer is never
 * a source/authority/rent-payer of anything. Only then does it return the
 * derived fee upper bound so `cosignAndBroadcast` may co-sign.
 *
 * ⚠️ VECTOR ESTRELLA: a fee-payer that signs an opaque blob drains its own
 * wallet. Every check here is fail-closed (CD-3): any deviation, and any thrown
 * exception (a top-level `try/catch` also rejects), returns `{ ok:false }`
 * WITHOUT signing. When in doubt, reject.
 *
 * CD-12: no `@coral-xyz/anchor`, no IDL trust — the discriminator + system
 * program ids are compared by exact bytes/pubkey.
 *
 * Boundary: imports `@solana/web3.js` + `./deposit-shape.js` only.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ADVANCE_NONCE_ACCOUNT_INDEX,
  ADVANCE_NONCE_DATA_LEN,
  ADVANCE_NONCE_DISCRIMINATOR,
  ADVANCE_NONCE_POSITIONAL_ACCOUNTS,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AUTHORITY_LEN,
  AUTHORITY_OFFSET,
  DEPOSIT_ACCOUNT_INDEX,
  DEPOSIT_DISCRIMINATOR,
  DEPOSIT_POSITIONAL_ACCOUNTS,
  REGISTER_ESCROW_ACCOUNT_INDEX,
  REGISTER_ESCROW_DATA_LEN,
  REGISTER_ESCROW_DISCRIMINATOR,
  REGISTER_ESCROW_POSITIONAL_ACCOUNTS,
  REMITTANCE_ID_LEN,
  REMITTANCE_ID_OFFSET,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  TOKEN_PROGRAM_ID,
} from './deposit-shape.js';

/** Result type — identical to `SponsorTxValidator`'s return (CD-11). */
export type Cr1Result =
  | {
      ok: true;
      feeUpperBoundLamports: bigint;
      /**
       * WKH-357 — present ONLY when Check 2n recognized and fully validated an
       * `AdvanceNonceAccount` at ix 0 (which requires `cfg.durableNonceEnabled`).
       * Absent on every other success, so the flag-OFF result object is
       * byte-identical to the pre-WKH-357 one. `broadcast.ts` reads it to skip the
       * blockhash-freshness probes, which cannot judge a nonce value.
       */
      durableNonce?: true;
    }
  | { ok: false; reason: string };

/** Runtime-configurable bounds (from env; passed by the route). */
export interface Cr1Config {
  readonly escrowProgramId: string;
  readonly maxComputeUnits: number;
  readonly maxPriorityFeeMicroLamports: number;
  readonly maxFeeLamports: bigint;
  /**
   * El mint que un `deposit` patrocinado tiene que llevar (`SOLANA_USDC_MINT`).
   * El tipo admite `undefined` porque la env es opcional en el schema
   * (`infra/env.ts:182`); ese caso NO desactiva el check, lo hace rechazar
   * (Check 4c). `validateReleaseForSponsor` comparte este tipo y no lo lee: el
   * mint del release se verifica contra el `EscrowState` on-chain
   * (`chains/solana-escrow.ts:220`), no contra la ix.
   */
  readonly usdcMint: string | undefined;
  /**
   * La release-authority de ESTA instancia, en base58, o `undefined` si esta instancia
   * no tiene esa llave configurada. Check 4d la compara contra los 32 bytes que la ix
   * `deposit` graba en `AUTHORITY_OFFSET`.
   *
   * ⚠️ `undefined` DESARMA el check (a diferencia de `usdcMint`, donde ausente ⇒
   * rechaza). El motivo es una asimetria real de configuracion, no una preferencia:
   * `SOLANA_USDC_MINT` es condicion para que el adapter Solana se registre siquiera
   * (chains/solana-adapter.ts), asi que una instancia que puede patrocinar SIEMPRE la
   * tiene — su ausencia es imposible, y rechazar es gratis. La release-authority, en
   * cambio, tiene su propia bandera (`SOLANA_ESCROW_RELEASE_ENABLED`) independiente de
   * la del patrocinio, y una instancia puede legitimamente tener solo la del sponsor.
   * Rechazar ahi tumbaria una capacidad bien configurada por la falta de una env que
   * NO es suya.
   *
   * Que el guard se apague en silencio seria lo peor de los dos mundos, asi que NO se
   * apaga en silencio: `routes/solana-sponsor.ts` avisa en el arranque, una vez, si
   * quedo desarmado. `validateDepositForSponsor` sigue siendo pura y sin logger.
   *
   * `validateReleaseForSponsor` comparte este tipo y NO lo lee.
   */
  readonly releaseAuthority: string | undefined;
  /**
   * WKH-357 — ¿esta instancia acepta depósitos con `AdvanceNonceAccount` en ix 0?
   * (`SOLANA_SPONSOR_DURABLE_NONCE_ENABLED`).
   *
   * ⚠️ QUÉ HACE `false`, dicho con precisión: **no desarma un check, RECHAZA**. Es el
   * criterio de `usdcMint` (ausente ⇒ Check 4c rechaza) y NO el de `releaseAuthority`
   * (ausente ⇒ el check se desarma), y los dos están contrastados arriba en este
   * mismo tipo. Con `false`, una tx cuya ix 0 es un `nonceAdvance` cae por el camino de
   * SIEMPRE — la `nonceAdvance` queda dentro de `businessIx` y Check 2 la juzga —, y ni
   * una línea nueva se ejecuta: el veredicto es el de antes de esta HU (AC-8).
   *
   * ⛔ CON QUÉ ENUM RECHAZA: **son DOS, según la forma, y chaski produce las dos** (lleva
   * `register_escrow` o no según haya lugar en el índice on-chain, WKH-347). MEDIDO:
   *   • `[nonceAdvance, CB, CB, deposit]`                  ⇒ `PROGRAM_NOT_WHITELISTED`
   *     (`businessIx` = 2, `businessIx[0]` es la `nonceAdvance`, su programId es el System
   *     Program y no el escrow)
   *   • `[nonceAdvance, CB, CB, deposit, register_escrow]`  ⇒ `NOT_EXACTLY_ONE_BUSINESS_IX`
   *     (`businessIx` = 3, y Check 2 corta por cantidad ANTES de mirar ningún programId)
   * Una versión anterior de este comentario afirmaba `PROGRAM_NOT_WHITELISTED` sin
   * condiciones, y quien opere grepeando ese marcador no lo encuentra la mitad de las
   * veces. Los dos veredictos los mide T-20. Guard A, en cambio, **sí** da
   * `SHORT_DEPOSIT_DATA` en los dos casos, y también está medido.
   *
   * ⚠️ Y NO ES OPCIONAL A PROPÓSITO. Es `boolean` requerido, no `boolean | undefined`,
   * porque así el compilador lleva a quien lo agregue a **los 4** literales de
   * `Cr1Config` que hay en el repo — incluidos los 2 que no son del `deposit`
   * (`routes/solana-escrow.ts`, `__tests__/unit/cr1-release.test.ts`). Un campo
   * opcional los habría dejado en `undefined` en silencio.
   *
   * `validateReleaseForSponsor` comparte este tipo y NO lo lee: un release nunca
   * lleva `nonceAdvance` (lo arma el facilitator, no una billetera tras un salto).
   */
  readonly durableNonceEnabled: boolean;
}

/** Base network fee per signature (lamports) — the current Solana constant. */
const BASE_FEE_LAMPORTS_PER_SIG = 5000n;

/** ComputeBudget instruction discriminators (first data byte). */
const CB_SET_COMPUTE_UNIT_LIMIT = 2;
const CB_SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Solana runtime defaults applied when the tx carries NO `SetComputeUnitLimit`:
 * the limit is `200_000 * <non-ComputeBudget ix>`, capped at `1_400_000`.
 * MEASURED with solana-bankrun (2 signers, `SetComputeUnitPrice(50_000)`, no
 * `SetComputeUnitLimit`): 1 business ix ⇒ the fee-payer is charged 20 000
 * lamports, 2 ⇒ 30 000, 3 ⇒ 40 000, while CU *consumed* was only 300/450/600.
 * The priority fee is charged on the LIMIT, never on consumption.
 */
const DEFAULT_CU_PER_BUSINESS_IX = 200_000;
/**
 * The runtime's per-tx ceiling. NOTE: with the allowlist capped at 2 business ix
 * this branch is UNREACHABLE (it needs 7), so it is documentation of the runtime
 * rule rather than tested behaviour — no vector exercises it, and none can.
 */
const MAX_CU_PER_TX = 1_400_000;

/** The limit the runtime will apply when the client omits `SetComputeUnitLimit`. */
function implicitComputeUnitLimit(businessIxCount: number): number {
  return Math.min(DEFAULT_CU_PER_BUSINESS_IX * businessIxCount, MAX_CU_PER_TX);
}

function reject(reason: string): Cr1Result {
  return { ok: false, reason };
}

/**
 * WKH-357 — ¿esta ix "se presenta como" un `AdvanceNonceAccount`? SÓLO para LOCALIZARLA
 * (n1): programId del System Program + los 4 bytes del discriminador.
 *
 * ⛔ NO es el validador: devolver `true` acá no autoriza nada. La forma completa la
 * exigen n2..n6 después, y cada desvío tiene su propio `reason`. La separación existe
 * para que una `nonceAdvance` en la posición EQUIVOCADA se pueda rechazar por lo que es
 * (`NONCE_IX_NOT_FIRST`) en vez de caer en un check ajeno con un marcador confuso.
 */
function esAdvanceNonce(ix: TransactionInstruction): boolean {
  if (!ix.programId.equals(new PublicKey(SYSTEM_PROGRAM_ID))) return false;
  if (ix.data.length < ADVANCE_NONCE_DISCRIMINATOR.length) return false;
  const disc = Buffer.from(ix.data.subarray(0, ADVANCE_NONCE_DISCRIMINATOR.length));
  return disc.equals(Buffer.from([...ADVANCE_NONCE_DISCRIMINATOR]));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * CR-1. See file header. Returns `{ ok:true, feeUpperBoundLamports }` when
 * checks 1-5 pass (blockhash freshness — check 6 — is done in
 * `cosignAndBroadcast`, which has network access), else `{ ok:false, reason }`.
 * `reason` is a stable, PII-free enum with NO echo of the tx.
 */
export function validateDepositForSponsor(
  tx: Transaction,
  feePayerPubkey: PublicKey,
  cfg: Cr1Config,
): Cr1Result {
  try {
    // ── Check 1: fee-payer correct ──────────────────────────────────────────
    const feePayer = tx.feePayer;
    if (feePayer === undefined || !feePayer.equals(feePayerPubkey)) {
      return reject('FEE_PAYER_MISMATCH');
    }

    const instructions = tx.instructions;
    const computeBudgetPk = ComputeBudgetProgram.programId;

    // ── Check 2: 1 or 2 business ix, escrow-whitelisted programId ────────────
    // ⛔ ESTAS DOS LÍNEAS NO CAMBIARON con WKH-357: son las de siempre, carácter por
    // carácter. La separación de la `nonceAdvance` se hace DESPUÉS, en Check 2n, para
    // que el camino de la bandera apagada no dependa de una expresión nueva (AC-8).
    const businessIxTodas = instructions.filter((ix) => !ix.programId.equals(computeBudgetPk));
    const cbIx = instructions.filter((ix) => ix.programId.equals(computeBudgetPk));

    // ── Check 2n (WKH-357): la `AdvanceNonceAccount` de un depósito por enlace ──
    // TODO lo nuevo de esta HU vive adentro de este `if`, con el patrón de Check 4b:
    // con `durableNonceEnabled: false` no se ejecuta ni una línea y `businessIx` es
    // literalmente `businessIxTodas`, así que el árbol de decisión es el de antes.
    //
    // Con la bandera APAGADA y una tx con nonce: la `nonceAdvance` queda dentro de
    // `businessIx` y Check 2 la juzga. Rechaza, no se desarma nada — pero el ENUM depende de
    // la forma, y chaski produce las dos (MEDIDO, T-20 las mide):
    //   sin `register_escrow`  ⇒ `PROGRAM_NOT_WHITELISTED`      (businessIx = 2, la
    //                             `nonceAdvance` es businessIx[0] y no es del escrow)
    //   con `register_escrow`  ⇒ `NOT_EXACTLY_ONE_BUSINESS_IX`  (businessIx = 3, el corte
    //                             por cantidad es ANTES del programId — ver más abajo)
    //
    // Los 7 requisitos (n1..n7) son fail-closed: cualquier desvío rechaza SIN firmar.
    // n7 es Check 5 y NO necesita una línea de código — ver el comentario de Check 5.
    let nonceIx: TransactionInstruction | undefined;
    let businessIx = businessIxTodas;
    if (cfg.durableNonceEnabled) {
      // n1 — la `nonceAdvance` va en posición 0 ABSOLUTA. Se BARRE la tx entera a
      // propósito: una `nonceAdvance` en cualquier otro índice es un rechazo con causa
      // PROPIA (`NONCE_IX_NOT_FIRST`) y no un "cae por otro check". El motivo es de
      // diagnóstico y de forma: el runtime de Solana sólo trata la tx como durable-nonce
      // si la ix 0 es el advance, así que una en posición 1 es una tx que avanza el
      // nonce de alguien SIN que el nonce gobierne su vigencia.
      const idxNonce = instructions.findIndex((ix) => esAdvanceNonce(ix));
      if (idxNonce > 0) {
        return reject('NONCE_IX_NOT_FIRST');
      }
      if (idxNonce === 0) {
        const candidata = instructions[0];
        if (candidata === undefined) {
          return reject('NONCE_IX_NOT_FIRST');
        }
        // n2 — largo EXACTO (nunca `>=`) y discriminador byte a byte.
        if (candidata.data.length !== ADVANCE_NONCE_DATA_LEN) {
          return reject('NONCE_IX_BAD_DISCRIMINATOR');
        }
        const nonceDisc = Buffer.from(candidata.data.subarray(0, ADVANCE_NONCE_DATA_LEN));
        if (!nonceDisc.equals(Buffer.from([...ADVANCE_NONCE_DISCRIMINATOR]))) {
          return reject('NONCE_IX_BAD_DISCRIMINATOR');
        }
        // n3 — exactamente 3 cuentas, ni una más.
        if (candidata.keys.length !== ADVANCE_NONCE_POSITIONAL_ACCOUNTS) {
          return reject('NONCE_IX_ACCOUNTS_INVALID');
        }
        const nonceAcct = candidata.keys[ADVANCE_NONCE_ACCOUNT_INDEX.NONCE];
        const sysvarAcct = candidata.keys[ADVANCE_NONCE_ACCOUNT_INDEX.RECENT_BLOCKHASHES];
        const authorityAcct = candidata.keys[ADVANCE_NONCE_ACCOUNT_INDEX.AUTHORITY];
        if (nonceAcct === undefined || sysvarAcct === undefined || authorityAcct === undefined) {
          return reject('NONCE_IX_ACCOUNTS_INVALID');
        }
        // ⚠️ LEER ESTO ANTES DE AGREGAR UNA ASERCIÓN DE BANDERAS ACÁ (AR BLQ-ALTO-1).
        // En un mensaje LEGACY de Solana `isSigner`/`isWritable` son propiedades **del
        // mensaje** (header + orden de `accountKeys`), NO de cada instrucción. El camino de
        // producción es serialize → `parseSponsorTx` → `Transaction.from`
        // (`broadcast.ts:161-183`), y en ese round-trip la meta de cada pubkey **colapsa a
        // la UNIÓN** sobre todas las ix. Entonces:
        //   • una bandera de una cuenta que aparece SÓLO en la `nonceAdvance` sobrevive
        //     intacta ⇒ se puede assertar (n5 y n4, abajo);
        //   • una bandera de una cuenta que TAMBIÉN aparece en el `deposit` llega con la
        //     unión ⇒ assertarla en negativo rechaza toda tx legítima (n6, abajo).
        // Es la misma trampa que está explicada para `regEscrowState` en Check 4b, y allá
        // salió el lado benigno. Acá salió el maligno: costó el 100% de los depósitos.
        //
        // n5 — la cuenta de nonce: writable y NO signer. Signer implicaría una 2ª
        // firma que la billetera no puede dar (y que obligaría a persistir una clave).
        //
        // ✅ ESTA ASERCIÓN SÍ ES ALCANZABLE EN EL CABLE, y está MEDIDO: la cuenta de nonce
        // es una pubkey que no aparece en ninguna otra ix (ni en el `deposit`, ni en el
        // `register_escrow`, ni en el ComputeBudget), así que no hay unión que la mueva. Un
        // fixture deformado a `isWritable: false` vuelve del round-trip con
        // `writable=false` y esta línea lo rechaza. Lo mide T-30 (el caso canónico vuelve
        // `signer=false writable=true`) + el vector "keys[0] NO writable" de T-12, que
        // ahora cruza el cable porque `buildTx` lo hace por default.
        //
        // 🔴 Y el caso `nonceAcct === feePayer` NO llega a Check 5, llega acá: el fee-payer
        // es `accountKeys[0]`, o sea signer y writable SIEMPRE, así que la unión le pone
        // `isSigner: true` a la cuenta de nonce y este `if` la rechaza primero. Sigue
        // fail-closed y sin firmar, sólo cambia el marcador (medido; T-14 lo dice).
        if (nonceAcct.isSigner || !nonceAcct.isWritable) {
          return reject('NONCE_IX_ACCOUNTS_INVALID');
        }
        // n4 — el sysvar exacto, readonly y no signer.
        //
        // ✅ TAMBIÉN ALCANZABLE EN EL CABLE, por el mismo criterio y también MEDIDO: el
        // sysvar de recent-blockhashes no aparece en el `deposit` (sus 3 program ids son
        // Token / ATA / System) ni en el `register_escrow`. Fixture deformado a
        // `isWritable: true` ⇒ vuelve `writable=true` ⇒ rechaza. La pubkey, obviamente, no
        // la toca ningún colapso.
        if (
          !sysvarAcct.pubkey.equals(new PublicKey(SYSVAR_RECENT_BLOCKHASHES_ID)) ||
          sysvarAcct.isSigner ||
          sysvarAcct.isWritable
        ) {
          return reject('NONCE_IX_ACCOUNTS_INVALID');
        }
        // n6 — la AUTHORITY es signer y es EL MISMO sender del `deposit`.
        //
        // 🔴 ÉSTE ES EL CORAZÓN (AC-4). Sin él, cualquiera podría hacer avanzar el nonce
        // de un tercero dentro de una tx que el facilitator paga: un DoS gratis contra
        // la cuenta de nonce de otra persona, que le invalida la tx que tenía firmada y
        // en vuelo. El `deposit` se resuelve más abajo (Check 2), así que la comparación
        // se hace ahí, donde `deposit.keys[0]` ya existe.
        //
        // ⛔ NO AGREGAR `|| authorityAcct.isWritable`. Estaba, y era un rechazo del 100% de
        // los depósitos con nonce durable — la feature no podía funcionar nunca.
        // MEDIDO sobre el fixture positivo, serializado y reconstruido como hace
        // producción, con el resto del archivo intacto:
        //     [2] AUTHORITY  ANTES signer=true writable=false
        //                    DESPUÉS signer=true writable=TRUE   ← la unión
        //     CR-1 en memoria    : ok durableNonce=true
        //     CR-1 tras el cable : REJECT NONCE_IX_ACCOUNTS_INVALID
        // El mecanismo es forzoso, no un accidente del fixture: Check 4 (más abajo, el
        // `SENDER_FLAGS_INVALID`) EXIGE `sender.isSigner && sender.isWritable`, y la parte 2
        // de n6 EXIGE `authority === sender`. Las tres condiciones juntas son
        // insatisfacibles: pedir la authority no-writable es pedir que el sender no sea
        // writable, que es justo lo contrario de lo que el `deposit` necesita para pagar la
        // renta del escrow. Re-agregarla pone 9 tests en rojo (medido).
        //
        // Y no se pierde nada de seguridad al permitirla writable: la cuenta está clavada
        // por la parte 2 de n6 a ser el sender de ESTE `deposit` — que ya firma la tx y ya
        // es writable por el `deposit` mismo —, y Check 5 sigue garantizando que no es el
        // fee-payer. "Writable" no le agrega ninguna capacidad que no tuviera.
        //
        // ⚠️ `isSigner` SÍ se sigue exigiendo, pero leelo como belt-and-braces y no como
        // cobertura del cable: MEDIDO, un fixture con la authority `isSigner: false` vuelve
        // del round-trip con `signer=true`, porque la authority es el sender y el `deposit`
        // lo marca signer. En el cable esta mitad es inalcanzable igual que las dos ramas de
        // `regSender` en Check 4b. Se conserva para un caller que le pase a CR-1 un
        // `Transaction` en memoria (y porque un `AdvanceNonceAccount` cuya authority no
        // firma es, en el protocolo, una ix inválida). T-32 mide las dos mitades.
        if (!authorityAcct.isSigner) {
          return reject('NONCE_IX_ACCOUNTS_INVALID');
        }
        nonceIx = candidata;
        // Identidad de REFERENCIA, no re-comparación por forma: `Array.prototype.filter`
        // preserva las referencias, así que `businessIxTodas[0]` ES el mismo objeto que
        // `instructions[0]` (el System Program nunca es ComputeBudget). Comparar por
        // identidad no puede confundir dos ix de forma idéntica en posiciones distintas.
        businessIx = businessIxTodas.filter((ix) => ix !== nonceIx);
      }
    }
    // HU-SOL-20/R3: 1 (legacy form, byte-identical path) or 2 (`deposit` +
    // `register_escrow`, atomic) are allowed. 0 or >=3 keep rejecting with the
    // SAME enum (vectors T4a/T4b are untouched). Position 0 is ALWAYS the
    // `deposit`: no discriminator search, deterministic and fail-closed.
    if (businessIx.length !== 1 && businessIx.length !== 2) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }
    const deposit = businessIx[0];
    if (deposit === undefined) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }
    let escrowPk: PublicKey;
    try {
      escrowPk = new PublicKey(cfg.escrowProgramId);
    } catch {
      // Misconfigured whitelist programId → fail-closed.
      return reject('BAD_ESCROW_PROGRAM_ID_CONFIG');
    }
    if (!deposit.programId.equals(escrowPk)) {
      return reject('PROGRAM_NOT_WHITELISTED');
    }

    // ── Check 3: ComputeBudget bounded (<=2 ix; only SetCU limit/price) ──────
    if (cbIx.length > 2) {
      return reject('TOO_MANY_COMPUTE_BUDGET_IX');
    }
    // Conservative default (AR-G4 BLQ-MEDIO-1): absent a SetComputeUnitLimit the
    // runtime applies `200_000 * businessIx`, NOT a constant — so pinning this to
    // `cfg.maxComputeUnits` under-reserved the 2-ix form (declared 25 000 vs 30 000
    // actually charged) and turned `feeUpperBoundLamports` into a lower bound,
    // which in turn made the daily lamport cap under-count real spend. Mirroring
    // the runtime rule keeps the value a true upper bound for EVERY form.
    //
    // 🔴 WKH-357 — LA `nonceAdvance` SE CUENTA ACÁ, y no contarla reintroduce este mismo
    // bug. `implicitComputeUnitLimit` espeja la regla del runtime: `200_000 × <ix que NO
    // son ComputeBudget>`. La `nonceAdvance` NO es ComputeBudget, así que EL RUNTIME LA
    // CUENTA. Si se la saca de `businessIx` (Check 2n) y esta línea queda igual, una tx
    // `[nonceAdvance, deposit]` SIN `SetComputeUnitLimit` declararía 200.000 mientras el
    // runtime cobra sobre 400.000 ⇒ `feeUpperBoundLamports` deja de ser cota SUPERIOR y
    // el cap diario de lamports sub-cuenta el gasto real. Es exactamente AR-G4
    // BLQ-MEDIO-1, el bug que los dos comentarios de arriba y abajo dan por arreglado.
    // Con la bandera apagada `nonceIx` es SIEMPRE `undefined` ⇒ byte-idéntico. T-25 lo mide.
    let computeUnits = implicitComputeUnitLimit(
      businessIx.length + (nonceIx === undefined ? 0 : 1),
    );
    let priceMicroLamports = 0n;
    let sawLimit = false;
    let sawPrice = false;
    for (const ix of cbIx) {
      const data = ix.data;
      if (data.length === 0) return reject('EMPTY_COMPUTE_BUDGET_IX');
      const kind = data.readUInt8(0);
      if (kind === CB_SET_COMPUTE_UNIT_LIMIT) {
        if (sawLimit) return reject('DUP_COMPUTE_UNIT_LIMIT');
        if (data.length < 5) return reject('BAD_COMPUTE_UNIT_LIMIT_DATA');
        const units = data.readUInt32LE(1);
        if (units > cfg.maxComputeUnits) return reject('COMPUTE_UNITS_ABOVE_MAX');
        computeUnits = units;
        sawLimit = true;
      } else if (kind === CB_SET_COMPUTE_UNIT_PRICE) {
        if (sawPrice) return reject('DUP_COMPUTE_UNIT_PRICE');
        if (data.length < 9) return reject('BAD_COMPUTE_UNIT_PRICE_DATA');
        const price = data.readBigUInt64LE(1);
        if (price > BigInt(cfg.maxPriorityFeeMicroLamports))
          return reject('PRIORITY_FEE_ABOVE_MAX');
        priceMicroLamports = price;
        sawPrice = true;
      } else {
        // RequestUnits/RequestHeapFrame/unknown — not allowed (CD-5).
        return reject('UNSUPPORTED_COMPUTE_BUDGET_IX');
      }
    }
    // An IMPLICIT limit above our cap must reject too (AR-G4 BLQ-MEDIO-1):
    // `COMPUTE_UNITS_ABOVE_MAX` above only fires when the client DECLARES a limit,
    // so without this a 2-ix tx that simply OMITS the ix runs under 400 000 CU
    // against a configured max of 300 000 — the cap evaded by omission.
    if (!sawLimit && computeUnits > cfg.maxComputeUnits) {
      return reject('IMPLICIT_COMPUTE_UNITS_ABOVE_MAX');
    }

    // ── Check 4: discriminator + `deposit` structure ────────────────────────
    const data = deposit.data;
    if (data.length < DEPOSIT_DISCRIMINATOR.length) {
      return reject('SHORT_DEPOSIT_DATA');
    }
    // Buffer.equals over the first 8 bytes — avoids per-index member access.
    const disc = Buffer.from(data.subarray(0, DEPOSIT_DISCRIMINATOR.length));
    if (!disc.equals(Buffer.from([...DEPOSIT_DISCRIMINATOR]))) {
      return reject('BAD_DISCRIMINATOR');
    }
    const keys = deposit.keys;
    if (keys.length < DEPOSIT_POSITIONAL_ACCOUNTS) {
      return reject('DEPOSIT_ACCOUNTS_MISSING');
    }
    // Destructure the 8 positional accounts by name (order = escrow-idl.ts).
    const [sender, , , , , tokenProgram, ataProgram, systemProgram] = keys;
    if (
      sender === undefined ||
      tokenProgram === undefined ||
      ataProgram === undefined ||
      systemProgram === undefined
    ) {
      return reject('DEPOSIT_ACCOUNTS_MISSING');
    }
    if (!sender.isSigner || !sender.isWritable) {
      return reject('SENDER_FLAGS_INVALID');
    }

    // ── Check 2n / n6 (parte 2, WKH-357): la authority del nonce ES el sender ──
    // 🔴 EL CORAZÓN DE AC-4. Se resuelve acá y no arriba porque necesita el `sender` del
    // `deposit`, que Check 4 recién destructuró. Sin esta comparación, una tx podría
    // hacer avanzar la cuenta de nonce de UN TERCERO con el gas del facilitator: le
    // invalida en el acto la transacción que esa persona tenía firmada y en vuelo, gratis
    // y a repetición. El `deposit` sería legítimo y todos los demás checks pasarían.
    //
    // ⛔ Y NO se compara contra `feePayerPubkey` ni contra nada configurado: se compara
    // contra el sender de ESTA tx. La authority del nonce NO PUEDE ser el fee-payer —
    // Check 5 lo rechaza abajo (n7) — así que el sender es el único valor posible.
    if (nonceIx !== undefined) {
      const authorityAcct = nonceIx.keys[ADVANCE_NONCE_ACCOUNT_INDEX.AUTHORITY];
      if (authorityAcct === undefined) {
        return reject('NONCE_IX_ACCOUNTS_INVALID');
      }
      if (!authorityAcct.pubkey.equals(sender.pubkey)) {
        return reject('NONCE_AUTHORITY_NOT_SENDER');
      }
    }
    if (!tokenProgram.pubkey.equals(new PublicKey(TOKEN_PROGRAM_ID))) {
      return reject('TOKEN_PROGRAM_MISMATCH');
    }
    if (!ataProgram.pubkey.equals(new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))) {
      return reject('ASSOCIATED_TOKEN_PROGRAM_MISMATCH');
    }
    if (!systemProgram.pubkey.equals(new PublicKey(SYSTEM_PROGRAM_ID))) {
      return reject('SYSTEM_PROGRAM_MISMATCH');
    }

    // ── Check 4c: el MINT del depósito, clavado contra el configurado ────────
    // El programa on-chain acepta CUALQUIER mint a propósito y lo dice: el doc de
    // la cuenta `mint` del `deposit` (escrow-idl.ts, ix `deposit`) delega "qué
    // token vale un dólar" en "el co-firmante off-chain, que se niega a firmar un
    // depósito con un mint inesperado". Ese co-firmante es esta función, y hasta
    // acá no se negaba: el índice 1 no se comparaba contra nada.
    //
    // El input concreto que lo delata: un cliente modificado arma el `deposit`
    // con un mint creado por él y su propia ATA. Guard A/B pasan (el mensaje de
    // patrocinio se arma DESDE la tx, así que la persona firma el mint que el
    // cliente puso), y el facilitator co-firma y paga el gas de un vault sin
    // valor. `verifyVault` sí compara el mint del `EscrowState`
    // (chains/solana-escrow.ts:220 → MINT_MISMATCH), así que ese vault no se
    // libera; lo que se pierde es el gas del feePayer y un `principal_in`
    // mentiroso aguas arriba.
    //
    // Sin la env NO se saltea el check: se rechaza (mismo criterio que
    // BAD_ESCROW_PROGRAM_ID_CONFIG en Check 2). Un guard que se apaga solo cuando
    // le falta su config es indistinguible de no tenerlo, y el operador no ve la
    // diferencia. `SOLANA_USDC_MINT` está seteada en producción — es la condición
    // para que el adapter Solana se registre (chains/solana-adapter.ts:450-453).
    const mint = keys[DEPOSIT_ACCOUNT_INDEX.MINT];
    if (mint === undefined) {
      return reject('DEPOSIT_ACCOUNTS_MISSING');
    }
    const configuredMint = cfg.usdcMint;
    if (configuredMint === undefined || configuredMint.length === 0) {
      return reject('USDC_MINT_NOT_CONFIGURED');
    }
    let usdcMintPk: PublicKey;
    try {
      usdcMintPk = new PublicKey(configuredMint);
    } catch {
      return reject('BAD_USDC_MINT_CONFIG');
    }
    if (!mint.pubkey.equals(usdcMintPk)) {
      return reject('MINT_MISMATCH');
    }
    // Remaining accounts (idx 8+) — the `reference` must be non-signer + non-writable.
    const remaining = keys.slice(DEPOSIT_POSITIONAL_ACCOUNTS);
    if (remaining.some((k) => k.isSigner || k.isWritable)) {
      return reject('REMAINING_ACCOUNT_FLAGS_INVALID');
    }

    // ── Check 4d: la `authority` que el depósito GRABA en el escrow ──────────
    // Los 32 bytes de `data[56..88]` son la única pubkey que después va a poder firmar
    // el `release` de ese escrow (`has_one = authority` ⇒ `ConstraintHasOne` 2001 si
    // firma otra). Quién los elige es chaski, desde SU propia env, un valor que el
    // facilitator no confirmaba contra nada — `authority` aparecía en este archivo sólo
    // en comentarios.
    //
    // El input concreto: chaski se despliega con la env de la authority desalineada (o
    // vacía, que graba la pubkey nula). Todos los depósitos siguen entrando y CR-1
    // sigue patrocinándolos, y cada uno NACE IRRELEASEABLE. Nadie se entera hasta que
    // la ventana de custodia (2 h) se acerca a su fin y el release devuelve
    // `RELEASE_AUTHORITY_MISMATCH` — cuando ya no hay tiempo de arreglarlo y sólo queda
    // el refund. Acá cuesta una respuesta 422 y el gas no se gasta.
    //
    // Y a diferencia del mint (Check 4c), la env que falta acá NO rechaza: ver el
    // comentario de `Cr1Config.releaseAuthority`. Esa decisión NO es silenciosa — la
    // ruta avisa en el arranque cuando el check queda desarmado.
    const configuredAuthority = cfg.releaseAuthority;
    if (configuredAuthority !== undefined && configuredAuthority.length > 0) {
      let expectedAuthority: PublicKey;
      try {
        expectedAuthority = new PublicKey(configuredAuthority);
      } catch {
        // Config presente pero ilegible: acá sí se rechaza (mismo criterio que
        // BAD_ESCROW_PROGRAM_ID_CONFIG). "Mal escrita" no es lo mismo que "ausente".
        return reject('BAD_RELEASE_AUTHORITY_CONFIG');
      }
      if (data.length < AUTHORITY_OFFSET + AUTHORITY_LEN) {
        // El Check 4 sólo exige 8 bytes, así que una ix corta llega hasta acá viva.
        return reject('DEPOSIT_DATA_TOO_SHORT_FOR_AUTHORITY');
      }
      const declaredAuthority = Buffer.from(
        data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + AUTHORITY_LEN),
      );
      if (!declaredAuthority.equals(expectedAuthority.toBuffer())) {
        return reject('DEPOSIT_AUTHORITY_MISMATCH');
      }
    }

    // ── Check 4b: if a 2nd business ix exists it MUST be EXACTLY `register_escrow`
    // of the same escrow program, bound to THIS deposit (HU-SOL-20/R3). Strict
    // allowlist: programId + pinned discriminator + exact data length + exactly 4
    // accounts with fixed flags + sender/escrow_state/remittance_id binding. Any
    // deviation ⇒ reject WITHOUT signing. Everything new lives inside this `if`,
    // so the 1-business-ix path executes not a single new line (AC-R3-2).
    if (businessIx.length === 2) {
      const reg = businessIx[1];
      if (reg === undefined) return reject('SECOND_IX_ACCOUNTS_INVALID');
      // b1 — same escrow program (never another programId, nor ComputeBudget, nor SPL).
      if (!reg.programId.equals(escrowPk)) return reject('SECOND_IX_PROGRAM_NOT_WHITELISTED');
      // b2 — EXACT length (8 + 16). Not one byte more: closes the silent "extra arg".
      if (reg.data.length !== REGISTER_ESCROW_DATA_LEN) return reject('SECOND_IX_BAD_DATA_LEN');
      // b3 — pinned discriminator, compared byte-wise (CD-12: no anchor, no runtime IDL trust).
      const regDisc = Buffer.from(reg.data.subarray(0, REGISTER_ESCROW_DISCRIMINATOR.length));
      if (!regDisc.equals(Buffer.from([...REGISTER_ESCROW_DISCRIMINATOR]))) {
        return reject('SECOND_IX_BAD_DISCRIMINATOR');
      }
      // b4 — EXACTLY 4 accounts: no remaining ones, none extra.
      if (reg.keys.length !== REGISTER_ESCROW_POSITIONAL_ACCOUNTS) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      const regSender = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.SENDER];
      const regEscrowState = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.ESCROW_STATE];
      const regEscrowIndex = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.ESCROW_INDEX];
      const regSystemProgram = reg.keys[REGISTER_ESCROW_ACCOUNT_INDEX.SYSTEM_PROGRAM];
      if (
        regSender === undefined ||
        regEscrowState === undefined ||
        regEscrowIndex === undefined ||
        regSystemProgram === undefined
      ) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b5 — EXACT flags per position. An extra writable is an account the tx can mutate.
      //
      // ⚠️ WHY `regEscrowState` is only checked for NON-SIGNER and not for non-writable:
      // in a Solana LEGACY message, is-signer/is-writable are TRANSACTION-level
      // properties (message header + accountKeys ordering), NOT per-instruction ones.
      // The production path is serialize → `parseSponsorTx` → `Transaction.from`
      // (broadcast.ts:161-183), and on that round-trip every meta of a given pubkey
      // collapses to the UNION over all instructions. `escrow_state` is legitimately
      // writable in the `deposit` (IDL: deposit.escrow_state.writable = true), so it
      // ALWAYS comes back writable in the 2nd ix too. Asserting non-writable here
      // would reject every legitimate atomic tx and take the money-path down.
      // No drain is enabled by allowing it: the account is pinned by b6 to be the
      // deposit's OWN `escrow_state`, the program declares it without `mut` in
      // `RegisterEscrow` (lib.rs:403-416) so it cannot be written by that ix, and
      // Check 5 still guarantees it is not the fee-payer.
      //
      // ⚠️ AR-G4 MNR-2 — the two `regSender` branches below are UNREACHABLE on the
      // wire: the deposit marks `sender` signer+writable, so the same union forces
      // both to `true` in ix[1]. They are kept as belt-and-braces for a caller that
      // hands CR-1 an in-memory `Transaction`, but do NOT read them as real coverage
      // of the production path (`V-12` asserts an enum production cannot emit). This
      // is the same reasoning trap as the story's `escrow_state` line, benign side up.
      if (!regSender.isSigner || !regSender.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regEscrowState.isSigner) return reject('SECOND_IX_ACCOUNTS_INVALID');
      // `escrow_index`'s PUBKEY is deliberately NOT derived here (AR-G4 MNR-1). CR-1
      // derives NO PDA for the deposit either — Check 4 pins the three program ids
      // by pubkey and Check 4c the `mint` against the configured one, but neither
      // `escrow_state` nor `vault` is recomputed from seeds, so deriving the PDA for
      // this one account would be incoherent with the module's own contract; the on-chain
      // `seeds = ["escrow-index", sender]` is the real guard, and a mismatch costs the
      // sponsor only the base fee, already bounded by the rate limit + daily cap.
      if (regEscrowIndex.isSigner || !regEscrowIndex.isWritable) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      if (regSystemProgram.isSigner || regSystemProgram.isWritable) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      if (!regSystemProgram.pubkey.equals(new PublicKey(SYSTEM_PROGRAM_ID))) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b6 — BINDING to the deposit: same sender, same escrow_state, same remittance_id.
      // Without it an attacker could pair a legitimate deposit with the register of
      // something else. The deposit's data length is asserted ONLY here, so the
      // 1-ix path stays byte-identical.
      if (data.length < REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
      const depEscrowState = keys[DEPOSIT_ACCOUNT_INDEX.ESCROW_STATE];
      if (depEscrowState === undefined) return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      const depRid = Buffer.from(
        data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN),
      );
      const regRid = Buffer.from(
        reg.data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN),
      );
      if (
        !regSender.pubkey.equals(sender.pubkey) ||
        !regEscrowState.pubkey.equals(depEscrowState.pubkey) ||
        !regRid.equals(depRid)
      ) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
    }

    // ── Check 5: fee-payer is NEVER referenced by ANY instruction (AC-3/AC-8) ─
    // The fee-payer may appear ONLY as the implicit tx.feePayer (accountKeys[0]).
    // If its pubkey shows up in ANY instruction's account list, it could be a
    // Transfer source / SPL authority / the deposit sender (rent-payer) — all of
    // which are drain vectors. Strongest fail-closed rule; subsumes T5/T6/T7.
    //
    // 🔴 WKH-357 / n7 — ESTE BUCLE NO CAMBIÓ Y NO TIENE EXCEPCIONES, y eso es el punto.
    // Itera `instructions` (TODAS, la `nonceAdvance` incluida, que sigue en
    // `tx.instructions`) y NO `businessIx`, así que la separación de Check 2n no lo
    // debilita en nada: las 3 cuentas nuevas del nonce se barren igual. La consecuencia
    // de diseño, que NO es negociable: **la authority del nonce no puede ser el
    // fee-payer**, porque si lo fuera este check rechazaría la tx. Por eso la authority
    // es el sender (n6) y por eso el facilitator NO puede ser dueño de las cuentas de
    // nonce ni patrocinar su creación.
    //
    // ⛔ Si alguien cambia `instructions` por `businessIx` acá, una tx con nonce cuya
    // authority sea el fee-payer pasaría. T-14 existe SÓLO para eso y se pone rojo.
    for (const ix of instructions) {
      for (const k of ix.keys) {
        if (k.pubkey.equals(feePayerPubkey)) {
          return reject('FEE_PAYER_REFERENCED_IN_INSTRUCTION');
        }
      }
    }

    // ── Fee upper bound = base (5000/sig) + priority (CU * price / 1e6) ──────
    const numSigners = BigInt(Math.max(1, tx.signatures.length));
    const priorityLamports = ceilDiv(BigInt(computeUnits) * priceMicroLamports, 1_000_000n);
    const feeUpperBoundLamports = BASE_FEE_LAMPORTS_PER_SIG * numSigners + priorityLamports;
    if (feeUpperBoundLamports > cfg.maxFeeLamports) {
      return reject('FEE_ABOVE_MAX');
    }

    // WKH-357: el campo SÓLO va cuando Check 2n reconoció y validó la `nonceAdvance`.
    // En cualquier otro caso el objeto es idéntico al de antes de esta HU (AC-8), sin
    // la clave presente — no `durableNonce: false`, que sería un objeto distinto.
    if (nonceIx !== undefined) {
      return { ok: true, feeUpperBoundLamports, durableNonce: true };
    }
    return { ok: true, feeUpperBoundLamports };
  } catch {
    // CD-3: any thrown exception → fail-closed reject (never propagate, never sign).
    return reject('CR1_UNEXPECTED_ERROR');
  }
}
