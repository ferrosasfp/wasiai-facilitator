# Story File — #027: Gasless / Fee-Payer Sponsorship — relayer propio Solana (CR-1 anti-drain) [WKH-217 / HU-SOL-14]

> SDD: `doc/sdd/027-hu-sol-14-gasless-feepayer/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/027-hu-sol-14-gasless-feepayer/work-item.md`
> Fecha: 2026-07-22
> Branch (facilitator): `feat/027-wkh-217-solana-feepayer-sponsorship`
> Repos: `wasiai-facilitator` (ESTE story = lado crítico) + `chaski-v3` (companion, W3 = spec para OTRO repo/branch)
> Modo: QUALITY + AR obligatorio (seguridad-crítica: firma con fondos propios del facilitator; vector de drenaje directo)

---

## Goal

El usuario Solana **sin SOL** completa el `deposit` al escrow no-custodial. `chaski-v3` (HU-SOL-5, YA
IMPLEMENTADO — no se toca) arma la tx legacy con `feePayer = facilitator`, la partial-firma SÓLO con la
wallet del sender y la envía serializada base64 al facilitator. El facilitator debe **reconstruir y
validar la tx ANTES de firmar nada (CR-1, el corazón de seguridad)**, co-firmar como fee-payer, hacer
broadcast pagando el fee de red, y devolver la `signature`.

La primitiva de co-firma se diseña **reusable** (HU-SOL-13 `release` la invocará): `cosignAndBroadcast`
es genérica y firma SÓLO si un **validador estructural inyectado** (`SponsorTxValidator`) devuelve
`{ ok:true }`. CR-1 (`validateDepositForSponsor`, deposit-específico) es ese validador. Aditivo puro:
el relayer gasless EVM no cambia una línea (AC-9). Opt-in-off: sin `SOLANA_FEE_PAYER_PRIVATE_KEY` (o
flag OFF) la ruta NO se registra y todo corre byte-idéntico.

> ⚠️ **VECTOR ESTRELLA — IMPOSIBLE DE SALTEAR**: un fee-payer que firma un blob opaco es drenaje directo
> de su propia wallet. Basta que el caller inyecte una ix `SystemProgram.transfer({ from: feePayer })` o
> una ix extra fuera de la whitelist. **T2/T5/T6/T7 (§Test Expectations) deben pasar SÍ o SÍ**: cualquier
> desviación del `deposit` esperado, o el fee-payer como source/authority/rent-payer → RECHAZO sin firmar
> ni transmitir. Si dudás si un check es demasiado estricto → **es fail-closed, rechazá y escalá**.

---

## 🛡️ Anti-Hallucination Header — LEER PRIMERO

### Baseline (verificado en F2.5)
- Gate del repo = `npm run qa` = `typecheck (tsc) && lint (eslint --max-warnings 0) && format:check (prettier) && test (vitest run)`. **NO hay biome** (gotcha 024/026). Toolchain único = ESLint + Prettier + tsc + Vitest.
- Corré `npm run qa` ANTES de tocar nada (Wave -1). Baseline verde. Cualquier rojo pre-existente → ESCALAR, no lo arregles acá.
- `@solana/web3.js` `^1.98.4` **YA está** en `package.json:28` (lo agregó WKH-205). **NO agregar deps nuevas** (ni `@coral-xyz/anchor`, ni `bs58`, ni `@solana/spl-token`, ni `@solana/pay`).
- `@coral-xyz/anchor` **NO es dependency** del facilitator → CR-1 **NO usa anchor**. Parsea instrucciones crudas y compara discriminator + program-ids por bytes/pubkey exactos.
- Key del fee-payer = **JSON byte-array de 64** (formato Solana CLI keypair): `Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))`. Base58 queda como follow-up (requeriría `bs58`, DT-8, FUERA de scope).

### API de `@solana/web3.js` v1.x a usar (classic, NO v2)
- `Transaction.from(Buffer.from(base64, 'base64'))` → legacy `Transaction` con `.instructions`, `.feePayer`, `.recentBlockhash`, `.signatures`.
- `VersionedTransaction.deserialize(...)` → **NO soportado en esta HU**: si el primer byte indica v0/versioned → `{ ok:false, reason:'SPONSOR_UNSUPPORTED_TX' }` (R-2/DT-7). chaski emite legacy `Transaction` (`solana-wallet.ts:136`).
- `Keypair`, `PublicKey`, `Connection`, `SystemProgram`, `ComputeBudgetProgram` disponibles.
- `ComputeBudgetProgram.programId` → usar esta constante del SDK, **NO** hardcodear el id del ComputeBudget.
- Blockhash freshness: `Connection.isBlockhashValid(recentBlockhash)` (o `getLatestBlockhash` + comparar `lastValidBlockHeight` vs `getBlockHeight`).
- Node >= 22 (fetch global, sin polyfill).

### REGLA DE ORO (AC-9 — EVM byte-idéntico, no-regresión)
1. **NINGÚN archivo EVM se toca.** PROHIBIDO editar: `src/methods/eip3009/*`, `src/infra/wallet.ts`, `src/core/settle.ts` (rama `eip155:*`), `src/chains/base-adapter.ts`, `src/chains/solana-adapter.ts` (el adapter verify-only de WKH-205 NO se modifica), `src/core/schemas.ts` (`SettleRequestSchema`), `src/core/ledger.ts`.
2. Todo lo nuevo vive en **dirs nuevos** (`src/methods/solana-sponsor/`, `src/core/solana-sponsor-cap.ts`, `src/infra/solana-fee-payer.ts`, `src/routes/solana-sponsor.ts`) o es aditivo (env schema, registro condicional en `app.ts`).
3. Si tras cualquier wave el typecheck rompe un archivo EVM o la suite EVM cambia una assertion → **PARAR y ESCALAR**. La suite EVM completa debe quedar verde SIN re-assertion (T21).

### Prohibiciones globales (heredadas del SDD — inviolables)
- **CD-1**: PROHIBIDO modificar el relayer gasless EVM. Ninguna suite EVM cambia assertion (AC-9).
- **CD-2**: OBLIGATORIO reconstruir/parsear la tx ANTES de firmar. PROHIBIDO firmar blob opaco por metadata declarada.
- **CD-3**: OBLIGATORIO **fail-closed en CADA check CR-1**. Cualquier ambigüedad/error de parseo → reject. Un `try/catch` externo que envuelve todo CR-1 también rechaza (nunca deja pasar por excepción).
- **CD-4**: OBLIGATORIO whitelist explícita de programId (escrow + System/Token/AssociatedToken/ComputeBudget solo donde se esperan). PROHIBIDO aceptar programId no listado.
- **CD-5**: OBLIGATORIO acotar ComputeBudget (CU + priority-fee) vía env. PROHIBIDO tx sin tope.
- **CD-6**: OBLIGATORIO rate-limit + daily-cap SOL **fail-CLOSED**. PROHIBIDO fail-open ante error del store (Redis caído → RECHAZO).
- **CD-7**: OBLIGATORIO leer la privkey desde env dedicada, nunca hardcodeada, **nunca logueada**, nunca en response/error (AC-10).
- **CD-8**: PROHIBIDO `@solana/pay`.
- **CD-9**: OBLIGATORIO que el depositor (sender índice 0), no el fee-payer, pague rent — fee-payer sólo fee de red.
- **CD-10**: Devnet + flags OFF por default — cero plata real. Broadcast/Connection **mockeados** en tests.
- **CD-11**: OBLIGATORIO separar la primitiva `cosignAndBroadcast` (genérica) del validador CR-1 (`validateDepositForSponsor`). La primitiva firma SÓLO si el validador inyectado devuelve `{ ok:true }`. PROHIBIDO hardcodear la lógica del `deposit` dentro de la primitiva.
- **CD-12**: OBLIGATORIO parsear con `@solana/web3.js`. PROHIBIDO `@coral-xyz/anchor` y PROHIBIDO confiar en IDL para CR-1; comparar discriminator + program-ids por bytes/pubkey exactos.
- **CD-13**: OBLIGATORIO opt-in-off (patrón `solana-adapter.ts:419-430`): sin `SOLANA_FEE_PAYER_PRIVATE_KEY` (o flag OFF) la ruta NO se registra y el resto corre byte-idéntico.

### Prohibiciones de auto-blindaje (heredadas de HUs previas — inviolables)
- **CD-14** (auto-blindaje #026): en tests que mockeen módulos usar `import * as mod` (runtime) + `vi.mocked(mod)`. **NO** `import type * as X` usado como valor. Ref: WKH-205 auto-blindaje#1.
- **CD-15** (auto-blindaje #026): anteponer `// eslint-disable-next-line no-secrets/no-secrets -- <razón: pubkey pública on-chain>` en CADA literal base58 (programIds, mints, system programs). Ref: WKH-205 auto-blindaje#2. (Ej. ya presente en `env.ts:185`.)
- **CD-16** (auto-blindaje #025): antes de tocar cualquier tipo/schema compartido, auditar TODOS los consumidores. Acá la ruta es aditiva y NO comparte schema con `routes/settle.ts`/`core/schemas.ts`/`ledger.ts` — mantenerlo así. PROHIBIDO widenizar `SettleRequestSchema` u otros tipos EVM. Ref: WKH-204 auto-blindaje.

---

## Acceptance Criteria (EARS — copiados del SDD, verificará QA en F4)

- **AC-1** WHEN chaski envía una tx cuyo único set de ix es exactamente el `deposit` esperado (programId escrow whitelisteado, 8 cuentas + `reference` remaining, ComputeBudget en rango o ausente, blockhash fresco), THE system SHALL co-firmar como fee-payer, transmitir y devolver la signature.
- **AC-2** (CR-1) IF el set de ix NO es EXACTAMENTE el esperado (ix de más/de menos, distinto programId, o cualquier programId fuera de la whitelist), THEN the system SHALL rechazar SIN firmar ni transmitir, fail-closed.
- **AC-3** (CR-1) IF el pubkey del fee-payer aparece como source/authority/owner/signer en cualquier ix `Transfer`/`TransferChecked`/`Close`/`Assign`/`SetAuthority` (System o SPL Token), THEN the system SHALL rechazar sin firmar, fail-closed.
- **AC-4** IF el `recentBlockhash` no es fresco (fuera de `lastValidBlockHeight`) O el ComputeBudget excede el límite configurado (CU / priority-fee), THEN the system SHALL rechazar sin firmar.
- **AC-5** WHILE N txs de distintos usuarios llegan concurrentemente, THE system SHALL co-firmar y transmitir cada una sin colisión de blockhash/nonce del fee-payer.
- **AC-6** IF el caller excede el rate-limit O el tope diario de SOL agregado, THEN the system SHALL rechazar fail-closed con código de error explícito.
- **AC-7** IF la solicitud no trae prueba KYC/PoP válida del sender, THEN the system SHALL rechazar ANTES de parsear/firmar.
- **AC-8** THE system SHALL verificar que ninguna ix crea una cuenta con el fee-payer como `payer`/`funder` — el fee-payer paga SOLO el fee de red.
- **AC-9** THE system SHALL dejar el relayer gasless EVM sin ningún cambio de comportamiento — ninguna suite EVM cambia assertion.
- **AC-10** THE system SHALL leer la clave privada del fee-payer EXCLUSIVAMENTE desde env dedicada, nunca hardcodeada, nunca logueada ni expuesta en response/error.

---

## Files to Create/Modify

> Todos los paths son relativos a `wasiai-facilitator/`. Dev NO toca `chaski-v3` (eso es W3, otro repo/branch).

| # | Archivo | Acción | Wave | Qué hacer | Exemplar (verificado) |
|---|---------|--------|------|-----------|-----------------------|
| 1 | `src/infra/env.ts` | Modificar | W0 | +11 env vars (§Env vars). Todas `.optional()`/`.default()`, **fuera de `.superRefine`** (opt-in, no rompe boot testnet-only) | `src/infra/env.ts:180-216` (bloque Solana + `SETTLE_MAX_AMOUNT_ATOMIC` string-regex) |
| 2 | `src/infra/solana-fee-payer.ts` | Crear | W0 | `getFeePayerKeypair(): Keypair` singleton lazy opt-in-off + `getFeePayerPubkey(): PublicKey` + `isSponsorEnabled(): boolean` + `resetFeePayerForTesting()`. Lee `SOLANA_FEE_PAYER_PRIVATE_KEY` (JSON array 64) DIRECTO de `process.env`. Throw con **nombre de env, nunca valor**. | `src/infra/wallet.ts` (COMPLETO) |
| 3 | `src/methods/solana-sponsor/broadcast.ts` | Crear | W0 | **Primitiva reusable** `cosignAndBroadcast(txBase64, opts)`. NO conoce `deposit`. (§Contrato primitiva) | `src/chains/chain-mutex.ts` (`runExclusive`) + `src/infra/wallet.ts` |
| 4 | `src/methods/solana-sponsor/deposit-shape.ts` | Crear | W1 | Constantes pinneadas: escrow programId default, discriminator `deposit`, whitelist programIds, orden de las 8 cuentas del `deposit`, ids System/Token/AssociatedToken. Cada literal base58 con `eslint-disable no-secrets` (CD-15). | IDL `chaski-v3/.../escrow-idl.ts:82-167` |
| 5 | `src/methods/solana-sponsor/cr1.ts` | Crear | W1 | `validateDepositForSponsor(tx, feePayerPubkey, cfg): Cr1Result` — los 6 checks fail-closed (§CR-1). Es el `SponsorTxValidator` del `deposit`. | `src/chains/solana-adapter.ts` (parse pins, comparación exacta) |
| 6 | `src/methods/solana-sponsor/pop.ts` | Crear | W2 | `verifySponsorPop(proof, senderPubkey, secret): boolean` HMAC **fail-closed** (secret unset ⇒ rechaza todo). `timingSafeEqual`. | `src/infra/solana-dedup.ts` (fail-closed) + `src/middleware/auth.ts` (`timingSafeMatch`) |
| 7 | `src/core/solana-sponsor-cap.ts` | Crear | W2 | `checkAndIncrSponsorDailyLamports(feeLamports, capLamports, failMode, logger, keyId): Promise<DailyCapResult>` **fail-CLOSED** (patrón `settle-cap.ts` pero `failMode:'closed'` por default). Clave Redis `solana:sponsor:daily:<keyId>:<UTCdate>` TTL 48h. | `src/core/settle-cap.ts` (COMPLETO) |
| 8 | `src/routes/solana-sponsor.ts` | Crear | W2 | `POST /solana/sponsor`: auth → Zod → PoP → rate/daily → CR-1+cosign+broadcast → `{ signature }` \| error. (§Contrato de Integración) | `src/routes/settle.ts:74-180` |
| 9 | `src/app.ts` | Modificar | W2 | Registrar `solanaSponsorRoute` SOLO si `isSponsorEnabled()` (opt-in-off). Import + `await app.register(...)` cerca de `registerMoneyPathRoutes`. Sin flag/key → NO registrar (404 natural). | `src/app.ts:385-395` (patrón `app.register`) |
| 10 | `__tests__/unit/solana-sponsor.cr1.test.ts` | Crear | W4 | T1-T10 (§Test Expectations) | `__tests__/unit/*solana*dedup*.test.ts` / `026` cr1 fixtures |
| 11 | `__tests__/unit/solana-sponsor.broadcast.test.ts` | Crear | W4 | T11-T14 (concurrencia, rebroadcast, primitiva agnóstica) | tests de `concurrency`/`chain-mutex` |
| 12 | `__tests__/unit/solana-sponsor.cap.test.ts` | Crear | W4 | T15-T16 (rate/daily fail-closed) | `__tests__/unit/*settle-cap*.test.ts` |
| 13 | `__tests__/unit/solana-sponsor.route.test.ts` | Crear | W4 | T17-T19 (PoP, happy e2e mock, privkey no-log) | `__tests__/unit/*routes*settle*.test.ts` |
| 14 | `__tests__/unit/solana-sponsor.env-optin.test.ts` | Crear | W4 | T20-T21 (opt-in-off + EVM byte-idéntico) | `__tests__/unit/*app*startup*.test.ts` |

> **Verificar logger redaction (AC-10)**: NO se crea archivo. Confirmar en W2 que `src/infra/logger.ts` (redaction/serializers) no loguea `SOLANA_FEE_PAYER_PRIVATE_KEY` ni el body crudo de la tx. Si hay lista de redacción → agregar la key ahí. Si NO hay mecanismo → NO loguear la env/tx en ningún archivo nuevo (default: no logging de la privkey). T19 lo verifica.

---

## Contrato de la primitiva reusable ⚠️ CD-11 (punto de extensión HU-SOL-13)

> Este contrato es **estable**. HU-SOL-13 (release) lo reusa pasando su propio `validateReleaseForSponsor`. NO romperlo.

```ts
// src/methods/solana-sponsor/broadcast.ts
import type { Transaction, PublicKey, Keypair } from '@solana/web3.js';

/** Validador estructural inyectado. Genérico: cada ix (deposit/release) provee el suyo. */
export type SponsorTxValidator = (
  tx: Transaction,
  feePayerPubkey: PublicKey,
) => { ok: true; feeUpperBoundLamports: bigint } | { ok: false; reason: string };

export interface CosignOpts {
  feePayerKeypair: Keypair;
  validate: SponsorTxValidator;                 // <── CR-1 inyectado; NUNCA hardcodear deposit aquí
  rpcUrl: string;                               // reusa SOLANA_RPC_URL (ya existe, WKH-205)
  maxFeeLamports: bigint;                        // SOLANA_SPONSOR_MAX_FEE_LAMPORTS
  maxRebroadcasts: number;                       // SOLANA_SPONSOR_MAX_REBROADCASTS (default 3)
  onFeeEstimated?: (lamports: bigint) => Promise<{ ok: boolean; reason?: string }>; // daily cap INCR fail-closed (AC-6)
}

export type CosignResult =
  | { ok: true; signature: string }
  | { ok: false; code: SponsorErrorCode; reason: string };

export async function cosignAndBroadcast(
  txBase64: string,
  opts: CosignOpts,
): Promise<CosignResult>;
```

**Secuencia interna OBLIGATORIA (fail-closed en cada paso, ninguno se saltea):**
1. Parse `Transaction.from(Buffer.from(txBase64,'base64'))`. Si es versioned/v0 → `{ ok:false, code:'SPONSOR_UNSUPPORTED_TX' }`. Si el parse lanza → `{ ok:false, code:'SPONSOR_REJECTED' }` (nunca propaga excepción).
2. `const v = opts.validate(tx, opts.feePayerKeypair.publicKey)`. Si `v.ok === false` → `{ ok:false, code:'SPONSOR_REJECTED', reason:v.reason }`. **NO firma.**
3. Si `v.feeUpperBoundLamports > opts.maxFeeLamports` → reject `SPONSOR_REJECTED`.
4. `onFeeEstimated?.(v.feeUpperBoundLamports)` → si `{ ok:false }` → reject `SPONSOR_DAILY_CAP` (fail-closed).
5. Blockhash fresco (`isBlockhashValid` sobre `Connection(rpcUrl)`) → si false → `{ ok:false, code:'SPONSOR_BROADCAST_EXPIRED' }` **antes de firmar**.
6. **Todo lo de firma+broadcast dentro de `runExclusive(FEE_PAYER_SENTINEL_ID, fn)`** (serialización AC-5). Co-firmar con `feePayerKeypair` (`tx.partialSign(feePayerKeypair)`), `sendRawTransaction(tx.serialize())`, confirmar `commitment:'confirmed'` con rebroadcast hasta `maxRebroadcasts` o hasta exceder `lastValidBlockHeight` → `SPONSOR_BROADCAST_EXPIRED`. Otro fallo → `SPONSOR_BROADCAST_FAILED`.
7. Éxito → `{ ok:true, signature }`.

> `FEE_PAYER_SENTINEL_ID`: un `number` constante (ej. `-1`) reservado como chainId sentinela para `runExclusive` (Solana no tiene chainId EVM; el mutex sólo serializa la firma/estado del Keypair singleton). Documentarlo con comentario. NO colisiona con chainIds EVM reales (>0).

---

## CR-1 — los 6 checks fail-closed (§4.4 SDD) ⚠️ EL CORAZÓN

`validateDepositForSponsor(tx, feePayerPubkey, cfg)` deserializa legacy y assert **en orden; cualquier
fallo → `{ ok:false, reason }` SIN excepción-por-default** (un `try/catch` externo también rechaza):

1. **Fee-payer correcto** — `tx.feePayer` (o `accountKeys[0]`) `.equals(feePayerPubkey)`. No coincide → reject.
2. **Exactamente 1 ix de negocio** — filtrar las ix cuyo `programId.equals(ComputeBudgetProgram.programId)`; del resto debe quedar **exactamente 1** ix, con `programId` === escrow whitelisteado (`cfg.escrowProgramId`, default `BBQ9…79WA`). Cualquier ix extra de otro programId → reject (AC-2, **★ T2/T3/T4**).
3. **ComputeBudget acotado** — a lo sumo 2 ix ComputeBudget (SetComputeUnitLimit / SetComputeUnitPrice). Decodificar sus datos: CU ≤ `cfg.maxComputeUnits`; priceMicroLamports ≤ `cfg.maxPriorityFeeMicroLamports`. Cualquier otra variante ComputeBudget o valor fuera de rango → reject (AC-4, **T8**). Derivar `feeUpperBoundLamports` (base 5000 lamports/firma + priority) ≤ `cfg.maxFeeLamports`.
4. **Discriminator + estructura del `deposit`** — primeros 8 bytes de `ix.data` === `[242,35,198,137,82,225,242,182]` (**T9**); nº de cuentas === 8 posicionales + N remaining; las 8 en orden esperado con flags: `sender` (idx 0) writable+signer; `token_program` === `Tokenkeg…`; `associated_token_program` === `ATokenGP…`; `system_program` === `1111…`; la remaining `reference` con `isSigner:false, isWritable:false`. Desviación → reject. *(NO re-derivar PDAs con anchor — validar estructura + system program ids pinneados; la validez on-chain la garantiza el programa escrow + el `verify()` de HU-SOL-6.)*
5. **Fee-payer NO es source/authority/signer indebido (★ AC-3/AC-8)** — recorrer TODAS las ix y assertar:
   - el fee-payer **no** aparece en ninguna ix del **System Program** como `from`/`funder`/`base` de `Transfer`/`Assign`/`CreateAccount`/`Allocate` (**★ T5**);
   - el fee-payer **no** aparece en ninguna ix del **SPL Token** como `source`/`authority`/`owner` de `Transfer`/`TransferChecked`/`CloseAccount`/`SetAuthority`/`Approve` (**★ T6**, 3 sub-vectores);
   - el fee-payer **no** es la cuenta `sender` (idx 0) del `deposit` (**★ T7**, AC-8: el rent-payer es la wallet, no el fee-payer);
   - el fee-payer aparece EXCLUSIVAMENTE como `accountKeys[0]` (fee payer implícito), no writable por ninguna ix.
   Cualquier match indebido → reject. *(Como la tx esperada tiene 1 sola ix `deposit` con set de cuentas cerrado, en happy-path el fee-payer sólo está en `accountKeys[0]`; este check es la defensa contra ix inyectadas.)*
6. **Blockhash fresco (AC-4)** — se ejecuta en `cosignAndBroadcast` paso 5 (necesita red), justo antes de firmar. `validateDepositForSponsor` NO hace red; devuelve la cota de fee y el resto de checks estructurales.

**Devuelve** `{ ok:true, feeUpperBoundLamports }` (checks 1-5 OK) o `{ ok:false, reason }`. `reason` = enum estable, PII-free, **sin echo de la tx**.

```ts
// Cr1Result === el retorno de SponsorTxValidator (mismo tipo, CD-11)
export type Cr1Result =
  | { ok: true; feeUpperBoundLamports: bigint }
  | { ok: false; reason: string };
```

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU es cross-repo (chaski server → facilitator). El wire-format es la fuente de verdad. Verificado contra `chaski-v3/src/infrastructure/solana-wallet.ts:146-149`.

### chaski-v3 (server-only) → wasiai-facilitator

**Request** — `POST {FACILITATOR_BASE_URL}/solana/sponsor`, header `Authorization: Bearer {FACILITATOR_API_KEY}` (server-side; el browser NUNCA llama directo):

```json
{
  "partialSignedTx": "<base64>",   // = SolanaPrincipalAuthorization.partialSignedTx (tx legacy partial-firmada por el sender, feePayer=facilitator)
  "reference": "<base58 pubkey>",  // = SolanaPrincipalAuthorization.reference
  "sender": "<base58 pubkey>",     // wallet del depositor (para PoP + AC-8)
  "popProof": "<hmac attestation>" // KYC/PoP; validado fail-closed vs SOLANA_SPONSOR_POP_SECRET (AC-7)
}
```

**Zod del body** (route-local, NO reusar `SettleRequestSchema` — CD-16): `partialSignedTx` string b64 no vacío; `reference` string b58 no vacío; `sender` string b58 no vacío; `popProof` string no vacío. Fallo → `400 { error:{ code:'INVALID_PAYLOAD', message, http:400 } }` (patrón `settle.ts:100-121`).

**Response 200:** `{ "signature": "<base58 tx signature>" }`

**Errores** (body `{ error:{ code, message, http } }`, patrón `settle.ts`):

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | Zod falla (falta un campo / tipo raro) |
| 403 | `SPONSOR_POP_INVALID` | PoP ausente o HMAC inválido → **antes** de parsear/CR-1 (AC-7) |
| 422 | `SPONSOR_REJECTED` | CR-1 rechaza (cualquier check). **Sin firmar ni transmitir. Sin echo de la tx.** (AC-2/3/4/8) |
| 422 | `SPONSOR_UNSUPPORTED_TX` | tx versioned/v0 (sólo legacy soportado, DT-7) |
| 429 | `SPONSOR_RATE_LIMITED` | rate-limit excedido (o store caído → fail-closed, CD-6) |
| 429 | `SPONSOR_DAILY_CAP` | daily-lamports excedido (o contador caído → fail-closed) |
| 409 | `SPONSOR_BROADCAST_EXPIRED` | blockhash stale / excede `lastValidBlockHeight` tras rebroadcasts |
| 501 | `SPONSOR_NOT_ENABLED` | forzado sin flag/key (normalmente la ruta ni existe → 404) |
| 502 | `SPONSOR_BROADCAST_FAILED` | fallo de broadcast tras rebroadcasts |

> Lado chaski (companion, W3): fail-closed como `http-settlement-gateway.ts` — red caída / shape raro / status ≠ 200 → NO asumir éxito. **Ese código NO se implementa en este repo** (ver Wave 3).

---

## Env vars (§4.6 SDD — agregar en `src/infra/env.ts`, fuera de `.superRefine`)

| Env | Tipo Zod | Default | Rol |
|-----|----------|---------|-----|
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | `z.string().min(1).optional()` | — (unset ⇒ opt-in-off) | secret JSON array 64; NUNCA logueada (AC-10). Validación de forma en `solana-fee-payer.ts`, no en el schema |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | `z.coerce.boolean()` o string→bool | `false` | flag OFF (CD-10/CD-13). Ruta activa sólo si `true` **y** key presente |
| `SOLANA_ESCROW_PROGRAM_ID` | `z.string().min(1).default(...)` + `// eslint-disable no-secrets` | `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` | whitelist programId `deposit` (CD-4) |
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | `z.coerce.number()` | `300000` | cota CU (AC-4) |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | `z.coerce.number()` | `50000` | cota priority fee (AC-4) |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | `z.coerce.number()` | `100000` | cota fee por tx (0.0001 SOL) |
| `SOLANA_SPONSOR_RATE_LIMIT_MAX` | `z.coerce.number()` | `20` | requests/ventana por caller (AC-6) |
| `SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC` | `z.coerce.number()` | `60` | ventana rate-limit |
| `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS` | `z.string().regex(/^[1-9][0-9]*$/).default('500000000')` | `500000000` (0.5 SOL) | tope diario agregado fail-closed. **STRING** por precisión (patrón `SETTLE_MAX_AMOUNT_ATOMIC` env.ts:193) |
| `SOLANA_SPONSOR_MAX_REBROADCASTS` | `z.coerce.number()` | `3` | reintentos de broadcast (AC-5) |
| `SOLANA_SPONSOR_POP_SECRET` | `z.string().min(1).optional()` | — (unset ⇒ PoP rechaza todo, fail-closed) | HMAC del PoP/KYC (AC-7) |

> `SOLANA_RPC_URL` YA existe (env.ts:180) y se reusa para la `Connection` de broadcast/blockhash. NO redefinir.
> Rate-limit de la ruta: reusar el patrón `config.rateLimit.{max,timeWindow}` de `settle.ts:88-92` con las env `SOLANA_SPONSOR_RATE_LIMIT_*`. El fail-closed del daily-cap es el mecanismo principal de AC-6; el rate-limit por-ruta es la primera capa.

---

## Constraint Directives (resumen accionable)

### OBLIGATORIO
- Seguir `src/infra/wallet.ts` para el key-singleton (lazy `_cached`, throw con nombre-de-env, `reset...ForTesting()`).
- Seguir `src/chains/chain-mutex.ts` (`runExclusive`) para la serialización del fee-payer (AC-5).
- Seguir `src/core/settle-cap.ts` para el daily-cap Redis, pero **`failMode:'closed'` por default** (CD-6, a diferencia del EVM que es fail-open).
- Seguir `src/routes/settle.ts` para auth (`requireFacilitatorKey`), Zod safeParse, error body `{ error:{ code, message, http } }`, `request.facilitatorKeyId` para bucketing.
- Fail-closed en CADA check CR-1 (CD-3). El validador firma SÓLO si devuelve `{ ok:true }` (CD-11).
- Opt-in-off byte-idéntico (CD-13): sin flag/key la ruta no se registra.

### PROHIBIDO
- NO agregar deps (`@coral-xyz/anchor`, `bs58`, `@solana/spl-token`, `@solana/pay`). Usar SOLO `@solana/web3.js` (ya presente).
- NO modificar archivos EVM ni `src/chains/solana-adapter.ts` ni `src/core/schemas.ts` ni `src/core/ledger.ts` (CD-1, AC-9).
- NO crear tabla Postgres (daily-cap va en Redis).
- NO loguear la privkey ni el body crudo de la tx. NO echo de la tx en errores (CD-7, AC-10).
- NO fail-open en ningún check de seguridad. NO firmar sin validador OK.
- NO hardcodear la lógica del `deposit` dentro de `cosignAndBroadcast` (CD-11).

---

## Test Expectations (21 tests — ≥1 por AC)

> Framework: `vitest` (`vitest run`). Fixtures: construir txs con `@solana/web3.js` en el propio test (armar el `deposit` esperado como lo produce chaski `solana-wallet.ts`, y variantes maliciosas). **Broadcast/Connection mockeados** (sin red, cero plata — CD-10). Mock de módulos: `import * as mod` + `vi.mocked(mod)` (CD-14). Literales base58 con `eslint-disable no-secrets` (CD-15).

| Test | Archivo | AC / CD | Vector — expectativa exacta |
|------|---------|---------|------------------------------|
| **T1** — happy CR-1 | `solana-sponsor.cr1.test.ts` | AC-1 | tx = exactamente el `deposit` esperado → `{ ok:true, feeUpperBoundLamports }` |
| **★ T2** — tx no-esperada | `cr1.test.ts` | AC-2 | `deposit` + una ix `SystemProgram.transfer` extra → `{ ok:false }`, **NO se firma** |
| **T3** — programId fuera de whitelist | `cr1.test.ts` | AC-2 | ix con programId aleatorio → reject |
| **T4** — deposit ausente / ix de menos | `cr1.test.ts` | AC-2 | tx vacía o sólo ComputeBudget → reject |
| **★ T5** — fee-payer como source de Transfer | `cr1.test.ts` | AC-3 | `SystemProgram.transfer({ fromPubkey: feePayer })` → reject, **NO se firma** |
| **★ T6** — fee-payer authority SPL | `cr1.test.ts` | AC-3 | 3 sub-vectores SPL Token (`transfer`/`setAuthority`/`closeAccount`) con fee-payer como authority/owner → reject |
| **★ T7** — fee-payer como sender/rent-payer | `cr1.test.ts` | AC-8 | account[0] del `deposit` == feePayer → reject |
| **T8** — ComputeBudget fuera de rango | `cr1.test.ts` | AC-4 | CU > max ó priorityFee > max → reject |
| **T9** — discriminator equivocado | `cr1.test.ts` | AC-2 | primeros 8 bytes ≠ discriminator `deposit` → reject |
| **T10** — parseo lanza / bytes corruptos | `cr1.test.ts` | AC-2/CD-3 | base64 inválido → reject fail-closed (NO throw hacia arriba) |
| **T11** — blockhash stale | `solana-sponsor.broadcast.test.ts` | AC-4 | `isBlockhashValid` mock=false → `SPONSOR_BROADCAST_EXPIRED`, **sin firmar** |
| **★ T12** — concurrencia N sin colisión | `broadcast.test.ts` | AC-5 | 5 txs de senders distintos en paralelo → 5 signatures, orden FIFO, sin colisión (mock `sendRawTransaction`) |
| **T13** — rebroadcast + expiry | `broadcast.test.ts` | AC-5 | confirm falla hasta expiry → `SPONSOR_BROADCAST_EXPIRED` tras `maxRebroadcasts` |
| **T14** — primitiva reusable agnóstica | `broadcast.test.ts` | CD-11 | `validate` inyectado `{ ok:false }` → NO firma; `{ ok:true }` → firma. Prueba que la primitiva NO conoce el `deposit` |
| **T15** — rate-limit fail-closed | `solana-sponsor.cap.test.ts` | AC-6 | exceder max → rechazo; store Redis caído → **fail-closed** (rechaza, NO fail-open) |
| **T16** — daily lamports fail-closed | `cap.test.ts` | AC-6 | acumulado > cap → rechazo; error del contador → **fail-closed** |
| **T17** — PoP inválido/ausente | `solana-sponsor.route.test.ts` | AC-7 | sin `popProof` o HMAC malo → `403 SPONSOR_POP_INVALID` **antes** de parsear (spy: CR-1 NO invocado) |
| **T18** — happy e2e mockeado | `route.test.ts` | AC-1 | auth+PoP+rate+CR-1+broadcast mock → `200 { signature }` |
| **T19** — privkey nunca en logs/errores | `route.test.ts` | AC-10 | forzar error; assert que la env/privkey NO aparece en logs (spy logger) ni en el body de error |
| **T20** — opt-in-off | `solana-sponsor.env-optin.test.ts` | AC-9/CD-13 | sin `SOLANA_FEE_PAYER_PRIVATE_KEY` (o flag OFF) → ruta no registrada (`POST /solana/sponsor` → 404) |
| **★ T21** — EVM byte-idéntico | `env-optin.test.ts` (+ suite completa) | AC-9 | correr la suite EVM completa sin cambios → todos verdes; ninguna assertion EVM modificada |

**Criterio Test-First**: SÍ para CR-1, primitiva, cap y ruta (lógica de seguridad crítica). Escribir el test del vector antes que la implementación en W1/W2.

> ⚠️ **Los ★ (T2/T5/T6/T7/T12/T21) son bloqueantes de merge.** T2/T5/T6/T7 son el vector de drenaje: si cualquiera pasa "firmando" es un fallo CRÍTICO. AR los ataca en la fase siguiente.

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npm install 2>/dev/null || echo "SIN package.json"
# Gate del repo (debe estar VERDE antes de empezar):
npm run qa
# Confirmar que la dep Solana ya está (NO se agrega nada):
node -e "require('@solana/web3.js').Keypair && console.log('web3.js OK')"
# Confirmar archivos base del Scope IN existen:
ls src/infra/wallet.ts src/chains/chain-mutex.ts src/core/settle-cap.ts src/routes/settle.ts src/middleware/auth.ts src/infra/env.ts src/app.ts
# Confirmar el IDL fuente de verdad (chaski, solo lectura de referencia):
ls ../chaski-v3/src/infrastructure/solana/escrow-idl.ts ../chaski-v3/src/infrastructure/solana-wallet.ts
```

**Si algo falla en Wave -1: PARAR y reportar al orquestador.** No implementar sobre entorno roto ni con `npm run qa` en rojo pre-existente.

### Wave 0 (Serial Gate — completar antes de todo)
- [ ] W0.1: `src/infra/env.ts` — agregar las 11 env vars (§Env vars), todas `.optional()`/`.default()` **fuera de `.superRefine`**. Typecheck pasa. → Archivo #1
- [ ] W0.2: `src/infra/solana-fee-payer.ts` — `getFeePayerKeypair`/`getFeePayerPubkey`/`isSponsorEnabled`/`resetFeePayerForTesting`. Patrón `wallet.ts`: lazy `_cached`, `process.env` directo, throw con nombre-de-env (nunca valor). `isSponsorEnabled` = flag `true` **y** key presente y parseable. → Archivo #2
- [ ] W0.3: `src/methods/solana-sponsor/broadcast.ts` — primitiva `cosignAndBroadcast` + tipos `SponsorTxValidator`/`CosignOpts`/`CosignResult`/`SponsorErrorCode` + `FEE_PAYER_SENTINEL_ID`. Serialización con `runExclusive`. **Punto de extensión `SponsorTxValidator` explícito y limpio** (CD-11). NO conoce `deposit`. → Archivo #3

**Verificación W0**: `npm run typecheck` pasa. Los tipos exportados quedan estables para HU-SOL-13.

### Wave 1 (CR-1 — el corazón; depende de W0)
- [ ] W1.1: `src/methods/solana-sponsor/deposit-shape.ts` — constantes pinneadas (programId escrow default, discriminator, whitelist, orden de 8 cuentas, ids System/Token/AssociatedToken). CD-15 en cada literal base58. → Archivo #4
- [ ] W1.2: `src/methods/solana-sponsor/cr1.ts` — `validateDepositForSponsor` los 6 checks fail-closed (§CR-1). Implementa `SponsorTxValidator`. **Test-first**: escribir T2/T5/T6/T7/T9 antes. → Archivo #5

**Verificación W1**: typecheck + T1-T10 verdes (cr1.test.ts). Los ★ T2/T5/T6/T7 pasan.

### Wave 2 (Ruta + anti-abuso + PoP; depende de W0, W1)
- [ ] W2.1: `src/methods/solana-sponsor/pop.ts` — `verifySponsorPop` HMAC fail-closed (secret unset ⇒ rechaza todo). `timingSafeEqual`. → Archivo #6
- [ ] W2.2: `src/core/solana-sponsor-cap.ts` — daily-lamports Redis **fail-closed** (patrón `settle-cap.ts`, `failMode:'closed'` default). → Archivo #7
- [ ] W2.3: `src/routes/solana-sponsor.ts` — `POST /solana/sponsor` cableando: auth → Zod → PoP → rate/daily → `cosignAndBroadcast({ validate: validateDepositForSponsor, ... })` → `{ signature }` \| error. Orden §4.3 SDD. → Archivo #8
- [ ] W2.4: `src/app.ts` — registrar la ruta SOLO si `isSponsorEnabled()`. → Archivo #9
- [ ] W2.5: verificar redaction en `src/infra/logger.ts` (AC-10). Si hay lista de redacción, agregar `SOLANA_FEE_PAYER_PRIVATE_KEY`; si no, garantizar que ningún archivo nuevo loguea la privkey/tx cruda.

**Verificación W2**: typecheck + tests de W1 siguen verdes + ruta responde en test mock.

### Wave 3 (chaski-v3 companion — OTRO REPO, NO implementar aquí) 📋 SPEC-ONLY
> **El Dev de este repo NO toca chaski-v3.** Esta wave documenta lo que el Architect/Dev de `chaski-v3` implementa en su propio branch (`feat/0NN-hu-sol-14-feepayer-endpoint`, NNN a fijar en `chaski-v3/doc/sdd/_INDEX.md`). Se incluye para que el contrato quede cerrado.

Lo que chaski-v3 debe construir (companion SDD en ESE repo):
- **Ruta server-only** `POST /api/settle/sponsor-solana` (Next.js route handler, server-side) que:
  1. Recibe del cliente el `{ partialSignedTx, reference, sender }` que ya devuelve `authorizePrincipal` (`solana-wallet.ts:146-149`, HU-SOL-5 — **NO se toca ese archivo**).
  2. Genera/adjunta el `popProof` (HMAC del sender vs `SOLANA_SPONSOR_POP_SECRET`, compartido con el facilitator).
  3. Hace `POST {FACILITATOR_BASE_URL}/solana/sponsor` con `Authorization: Bearer {FACILITATOR_API_KEY}` **server-side** (el browser NUNCA llama al facilitator directo).
  4. Propaga la `signature` de vuelta al caller/orquestación.
- **Gateway thin** `http-solana-sponsor-gateway.ts` análogo a `chaski-v3/src/infrastructure/settlement/http-settlement-gateway.ts`: type-guards explícitos, **fail-closed** en red caída / status ≠ 200 / shape raro (NO asumir éxito, propagar reason bloqueante).
- Contrato HTTP = el de §Contrato de Integración (fuente de verdad este story).
- El wiring completo dentro de `ConfirmAndSend` (marcar `principal_in`, etc.) es **follow-up HU-SOL-13**, NO parte de esta HU.

### Wave 4 (Tests; depende de W0-W2)
- [ ] W4.1: `__tests__/unit/solana-sponsor.cr1.test.ts` — T1-T10 → Archivo #10
- [ ] W4.2: `__tests__/unit/solana-sponsor.broadcast.test.ts` — T11-T14 → Archivo #11
- [ ] W4.3: `__tests__/unit/solana-sponsor.cap.test.ts` — T15-T16 → Archivo #12
- [ ] W4.4: `__tests__/unit/solana-sponsor.route.test.ts` — T17-T19 → Archivo #13
- [ ] W4.5: `__tests__/unit/solana-sponsor.env-optin.test.ts` — T20-T21 → Archivo #14

**Verificación W4 / Full QA**: `npm run qa` completo verde. Los 21 tests presentes. La suite EVM byte-idéntica (T21). `eslint --max-warnings 0` (los literales base58 con disable-comment). Ningún archivo EVM modificado.

### Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W-1 | `npm run qa` VERDE baseline (si no → PARAR) |
| W0 | `npm run typecheck` pasa; tipos de la primitiva estables |
| W1 | typecheck + T1-T10 verdes (★ T2/T5/T6/T7) |
| W2 | typecheck + W1 verde + ruta responde en mock |
| W4 | `npm run qa` full verde + 21 tests + EVM byte-idéntico (T21) |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- `chaski-v3/*` (todo — es OTRO repo/branch, W3 es spec-only).
- `src/infra/wallet.ts`, `src/methods/eip3009/*`, `src/core/settle.ts` (rama `eip155:*`), `src/chains/base-adapter.ts` — EVM, CD-1/AC-9.
- `src/chains/solana-adapter.ts` (verify-only de WKH-205) — NO se modifica; esta HU NO reimplementa el `verify()` on-chain (HU-SOL-6).
- `src/core/schemas.ts` (`SettleRequestSchema`) / `src/core/ledger.ts` — no widenizar (CD-16).
- `authorizePrincipal` / armado del `deposit` + partial-sign (HU-SOL-5, ya hecho).
- `release`/settle final del escrow (HU-SOL-13) — pero la primitiva se deja reusable para él.
- Deploy devnet, activación de flags, fondeo del fee-payer con SOL, mainnet, `@solana/pay`, durable-nonce pool (upgrade path futuro).
- NO agregar deps. NO "mejorar" código adyacente. NO refactors no solicitados.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar, no asumir, no improvisar.**

Escalá si:
- Un exemplar o path referenciado ya no existe (`solana-wallet.ts`, `escrow-idl.ts`, `chain-mutex.ts`, etc.).
- `npm run qa` está en rojo pre-existente en Wave -1.
- El discriminator/estructura del `deposit` en el IDL de chaski difiere de `[242,35,198,137,82,225,242,182]` / 8 cuentas.
- `@solana/web3.js` v1 no expone `isBlockhashValid` / `ComputeBudgetProgram.programId` como esperás (versión distinta).
- Necesitás tocar un archivo fuera de la tabla "Files to Create/Modify" (especialmente cualquier archivo EVM).
- Un check de CR-1 te obliga a decidir entre firmar o rechazar y hay ambigüedad → **rechazá (fail-closed) y escalá**, nunca firmes por default.
- El mecanismo de redaction del logger no existe o no cubre la privkey (AC-10).

---

*Story File generado por NexusAgil — F2.5. Autor: nexus-architect.*
