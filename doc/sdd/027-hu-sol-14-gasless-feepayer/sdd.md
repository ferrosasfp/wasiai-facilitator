# SDD #027: Gasless / Fee-Payer Sponsorship — relayer propio Solana (CR-1 anti-drain)

> SPEC_APPROVED: no
> Fecha: 2026-07-22
> Tipo: feature (security + chain-impl)
> SDD_MODE: full (QUALITY — seguridad-crítica, ampliada por auditoría)
> Branch (facilitator): `feat/027-wkh-217-solana-feepayer-sponsorship`
> Branch (chaski-v3): a coordinar por el Architect de chaski (companion SDD en ese repo)
> Artefactos: `doc/sdd/027-hu-sol-14-gasless-feepayer/`
> Repos: `wasiai-facilitator` (lado crítico, este SDD) + `chaski-v3` (cliente, §11 contrato)

---

## 1. Resumen

El usuario Solana sin SOL igual completa el `deposit` al escrow no-custodial. `chaski-v3`
(HU-SOL-5, YA IMPLEMENTADO) arma la tx legacy con `feePayer = facilitator`, la partial-firma
SÓLO con la wallet del sender y la envía serializada base64 al facilitator. El facilitator debe
**reconstruir y validar la tx antes de firmar nada** (CR-1, el corazón de seguridad), co-firmar como
fee-payer, transmitirla pagando el fee de red, y devolver la signature.

Un fee-payer que firma un blob opaco es un vector de **drenaje directo de su propia wallet** (basta
que el caller inyecte una ix `Transfer` con el fee-payer como source). Por eso CR-1 es fail-closed en
cada check y la primitiva de co-firma NUNCA firma sin que un validador estructural la autorice.

La primitiva "co-firmar + broadcastear una tx Solana" se diseña **reusable**: HU-SOL-13 (release)
la invocará para firmar la ix `release`. CR-1 (específico del `deposit`) queda **desacoplado** de la
primitiva genérica como un validador inyectable (§4.3, §10 punto de extensión).

Aditivo puro: el relayer gasless EVM (EIP-3009, `OPERATOR_PRIVATE_KEY`) no cambia una línea
(AC-9, CD-1). Opt-in-off: sin `SOLANA_FEE_PAYER_PRIVATE_KEY` la ruta no se registra y todo corre
byte-idéntico.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 027 (WKH-217 / HU-SOL-14) |
| **Tipo** | feature (security + chain-impl) |
| **SDD_MODE** | full |
| **Objetivo** | Fee-payer Solana que reconstruye+valida (CR-1 fail-closed) y co-firma+broadcastea el `deposit`, para que el sender sin SOL deposite; primitiva reusable por HU-SOL-13 |
| **Reglas de negocio** | fee-payer paga SOLO el fee de red; nunca rent ni transfers; devnet + flags OFF; cero plata real |
| **Scope IN** | ver §6 IN |
| **Scope OUT** | ver §6 OUT |
| **Missing Inputs** | 3 NEEDS CLARIFICATION del F1 → RESUELTOS en §9 |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** WHEN chaski envía una tx cuyo único set de ix es exactamente el `deposit` esperado
  (programId escrow whitelisteado, cuentas = sender/mint/escrowState/vault/senderAta/token_program/
  associated_token_program/system_program + la `reference` remaining-account, ComputeBudget dentro de
  rango o ausente, blockhash fresco), THE system SHALL co-firmar como fee-payer, transmitir y devolver
  la signature.
- **AC-2** (CR-1) IF el set de ix NO es EXACTAMENTE el esperado (ix de más/de menos, distinto
  programId, o cualquier programId fuera de la whitelist), THEN the system SHALL rechazar SIN firmar ni
  transmitir, fail-closed.
- **AC-3** (CR-1) IF el pubkey del fee-payer aparece como source/authority/owner/signer en cualquier
  ix `Transfer`/`TransferChecked`/`Close`/`Assign`/`SetAuthority` (System o SPL Token), THEN the system
  SHALL rechazar sin firmar, fail-closed.
- **AC-4** IF el `recentBlockhash` no es fresco (fuera de `lastValidBlockHeight`) O el ComputeBudget
  excede el límite configurado (compute-units / priority-fee), THEN the system SHALL rechazar sin firmar.
- **AC-5** WHILE N txs de distintos usuarios llegan concurrentemente, THE system SHALL co-firmar y
  transmitir cada una sin colisión de blockhash/nonce del fee-payer.
- **AC-6** IF el caller excede el rate-limit O el tope diario de SOL agregado, THEN the system SHALL
  rechazar fail-closed con código de error explícito.
- **AC-7** IF la solicitud no trae prueba KYC/PoP válida del sender, THEN the system SHALL rechazar
  ANTES de parsear/firmar.
- **AC-8** THE system SHALL verificar que ninguna ix crea una cuenta con el fee-payer como
  `payer`/`funder` — el fee-payer paga SOLO el fee de red.
- **AC-9** THE system SHALL dejar el relayer gasless EVM sin ningún cambio de comportamiento — ninguna
  suite EVM cambia assertion.
- **AC-10** THE system SHALL leer la clave privada del fee-payer EXCLUSIVAMENTE desde env dedicada,
  nunca hardcodeada, nunca logueada ni expuesta en response/error.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read/Glob)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `wasiai-facilitator/src/infra/wallet.ts` | exemplar del key-singleton | `getOperatorAccount()` lazy + cache `_cached` + regex validación + `reset...ForTesting()` + throw con **nombre** de env (nunca valor) |
| `wasiai-facilitator/src/chains/solana-adapter.ts:419-430` | patrón opt-in-off | factory `= (() => { if (!env) return null; ... })()`; lee `process.env` directo; EVM byte-idéntico si Solana no configurado |
| `wasiai-facilitator/src/infra/solana-dedup.ts` | fail-CLOSED de referencia | `{ ok:false }` en no-client/error = reject; `UNIQUE` es la única línea de defensa; `amount` string, `::text` cast por precisión (WKH-196) |
| `wasiai-facilitator/src/core/settle-cap.ts` | patrón daily-cap Redis | `DAILY_CAP_KEY_PREFIX`+TTL 48h; per-caller partition (non-secret keyId); `failMode:'closed'`; INCR atómico |
| `wasiai-facilitator/src/routes/settle.ts:80-175` | exemplar de ruta | `preHandler: requireFacilitatorKey`; `config.rateLimit.{max,timeWindow}`; Zod safeParse → `INVALID_PAYLOAD` 400; `auditMeta.errorCode`; error body `{ error:{code,message,http} }` |
| `wasiai-facilitator/src/middleware/auth.ts` | caller-auth + keyId | `requireFacilitatorKey`; `request.facilitatorKeyId` (sha256 prefix non-secret) para bucketing; NUNCA loguea la key |
| `wasiai-facilitator/src/chains/chain-mutex.ts:42` | serialización FIFO | `runExclusive<T>(chainId, fn)` — mutex por-clave FIFO; base para la serialización del fee-payer (AC-5) |
| `wasiai-facilitator/src/infra/env.ts:180-205` | schema env Solana | `SOLANA_RPC_URL`/`SOLANA_USDC_MINT` `.optional()`; caps como STRING con regex (precisión); no en `.superRefine` (opt-in) |
| `chaski-v3/src/infrastructure/solana-wallet.ts:64-150` | **fuente de verdad de la tx** | `authorizePrincipal`: 1 ix `deposit` vía anchor; `feePayer=facilitator`; `remainingAccounts([{reference,isSigner:false,isWritable:false}])`; serialize `{requireAllSignatures:false, verifySignatures:false}`; return `{ partialSignedTx, reference }` |
| `chaski-v3/src/infrastructure/solana/escrow-idl.ts:82-167` | shape exacto del `deposit` | programId `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`; discriminator `[242,35,198,137,82,225,242,182]`; 8 accounts ordenadas (ver §4.4) + 1 remaining |
| `chaski-v3/src/infrastructure/settlement/http-settlement-gateway.ts` | exemplar gateway chaski | client-only → `fetch('/api/settle/principal')`; type-guards explícitos; fail-closed en red caída; shape del 200 validado |
| `chaski-v3/src/application/ports.ts:163-200` | tipos del contrato | `SolanaPrincipalAuthorization { vm, partialSignedTx, reference }`; `PrincipalSettlementGateway.settle` |
| `doc/sdd/026-.../auto-blindaje.md`, `025-.../auto-blindaje.md` | errores recurrentes | ver CD-14/CD-15/CD-16 (heredados de auto-blindaje) |

### Exemplars (para cada archivo nuevo → §4.1)

| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `src/infra/solana-fee-payer.ts` | `src/infra/wallet.ts` | key-singleton lazy, opt-in-off, throw con nombre-no-valor |
| `src/methods/solana-sponsor/cr1.ts` | `src/chains/solana-adapter.ts` (parse `@solana/web3.js`, pins) | parseo raw fail-closed, comparación por pubkey/discriminator exacta |
| `src/methods/solana-sponsor/broadcast.ts` | `src/chains/base-adapter.ts:725` (`runExclusive`) + `src/chains/chain-mutex.ts` | serialización + broadcast |
| `src/core/solana-sponsor-cap.ts` | `src/core/settle-cap.ts` | daily cap Redis + rate helper fail-closed |
| `src/routes/solana-sponsor.ts` | `src/routes/settle.ts` | ruta Fastify: auth, rateLimit, Zod, error body |
| `src/methods/solana-sponsor/pop.ts` | `src/infra/solana-dedup.ts` (fail-closed) | verificación HMAC fail-closed |

### Estado de BD relevante

| Tabla | Existe | Uso |
|-------|--------|-----|
| `facilitator_solana_settlements` | Sí (WKH-205) | NO se reusa para esto (DT-3 del F1) |
| Daily cap de lamports esponsorizados | N/A | contador en **Redis** (no Postgres), patrón `settle-cap.ts` (DT-6) — NO se crea tabla nueva |

### Dependencias disponibles (verificado en `package.json`)
- `@solana/web3.js` `^1.98.4` — presente. `Keypair`, `Transaction`, `VersionedTransaction`,
  `Connection`, `PublicKey`, `SystemProgram`, `ComputeBudgetProgram` disponibles.
- **NO** hay `@coral-xyz/anchor` ni `bs58` como deps directas → CR-1 NO usa anchor; parsea ix crudas.
  El key del fee-payer se lee como **JSON byte-array de 64** (formato Solana CLI keypair), decodable
  sin dep extra (`Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))`). Base58 queda como
  follow-up (requiere `bs58`, DT-8).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `src/infra/env.ts` | Modificar | +env vars §4.6 (todas `.optional()`/con default, fuera de `.superRefine`) | `env.ts:180-205` | W0 |
| `src/infra/solana-fee-payer.ts` | Crear | `getFeePayerKeypair(): Keypair` singleton lazy opt-in-off + `getFeePayerPubkey()` + `resetFeePayerForTesting()` | `src/infra/wallet.ts` | W0 |
| `src/methods/solana-sponsor/broadcast.ts` | Crear | **primitiva reusable** `cosignAndBroadcast(txBase64, opts)` — parse, valida vía callback inyectado, co-firma, serializa, broadcastea+confirma con rebroadcast, serializado por fee-payer (AC-5). NO conoce `deposit` | `base-adapter.ts:725` + `chain-mutex.ts` | W0 |
| `src/methods/solana-sponsor/cr1.ts` | Crear | `validateDepositForSponsor(txBase64, feePayerPubkey, cfg): Cr1Result` — el validador estructural fail-closed (AC-2/3/4/8) | `solana-adapter.ts` | W1 |
| `src/methods/solana-sponsor/deposit-shape.ts` | Crear | constantes pinneadas: escrow programId, discriminator `deposit`, whitelist de programIds, orden esperado de cuentas, IDs de programas de sistema | `escrow-idl.ts` | W1 |
| `src/methods/solana-sponsor/pop.ts` | Crear | `verifySponsorPop(proof, senderPubkey, secret): boolean` HMAC fail-closed (AC-7) | `solana-dedup.ts` (fail-closed) | W2 |
| `src/core/solana-sponsor-cap.ts` | Crear | `checkAndIncrSponsorRate(...)` + `checkAndIncrDailyLamports(feeLamports, cap)` fail-CLOSED (AC-6) | `src/core/settle-cap.ts` | W2 |
| `src/routes/solana-sponsor.ts` | Crear | `POST /solana/sponsor`: auth → PoP → rate/daily → CR-1 → cosign+broadcast → `{ signature }` | `src/routes/settle.ts` | W2 |
| `src/app.ts` | Modificar | registrar la ruta SOLO si `getFeePayerKeypair` está configurado (opt-in-off); si no, 501/no-registro | patrón registro rutas en `app.ts` | W2 |
| `src/infra/logger.ts` (redaction) | Verificar/Modificar | asegurar que la env del fee-payer y la privkey nunca se loguean (AC-10) | `logger.redact.test.ts` | W2 |
| `__tests__/unit/solana-sponsor.cr1.test.ts` | Crear | vectores CR-1 (§7) | `solana-dedup.test.ts` | W4 |
| `__tests__/unit/solana-sponsor.broadcast.test.ts` | Crear | primitiva + concurrencia (§7) | `concurrency.settle.test.ts` | W4 |
| `__tests__/unit/solana-sponsor.route.test.ts` | Crear | ruta e2e mockeada: auth/PoP/rate/cap/happy | `routes.settle.test.ts` | W4 |
| `__tests__/unit/solana-sponsor.cap.test.ts` | Crear | rate-limit + daily lamports fail-closed | `core.settle-cap.test.ts` | W4 |
| `__tests__/unit/solana-sponsor.env-optin.test.ts` | Crear | opt-in-off: sin env → ruta no registrada, EVM intacto (AC-9) | `app.startup-warnings.test.ts` | W4 |

> **AC-9 EVM byte-idéntico**: NINGÚN archivo EVM (`src/methods/eip3009/*`, `src/infra/wallet.ts`,
> `src/core/settle.ts` rama `eip155:*`, `src/chains/base-adapter.ts`) se modifica. Verificación: la
> suite EVM completa corre sin re-assertion (§7, T-AC9). Todos los archivos nuevos viven en dirs
> nuevos (`src/methods/solana-sponsor/`) o son aditivos.

### 4.2 Modelo de datos

Sin cambios de schema Postgres. El tope diario de SOL agregado es un contador **Redis** (patrón
`settle-cap.ts`, clave `solana:sponsor:daily:<feePayerId>:<UTCdate>` + TTL 48h) y el rate-limit reusa
el rate-limit Redis-backed de Fastify (WFAC-40). No se persiste la tx ni la privkey en ningún lado.

### 4.3 Arquitectura — separación primitiva vs CR-1 (punto de extensión para HU-SOL-13)

```
POST /solana/sponsor (route)
  │  1. requireFacilitatorKey        (auth caller = chaski server)      AC-7 gate previo
  │  2. Zod: { partialSignedTx:b64, reference:b58, sender:b58, popProof } AC-7
  │  3. verifySponsorPop(...)         fail-closed                       AC-7
  │  4. checkAndIncrSponsorRate(keyId) fail-closed                      AC-6
  │  5. cosignAndBroadcast(partialSignedTx, {
  │        feePayerKeypair: getFeePayerKeypair(),
  │        validate: (tx, feePayerPk) =>                <── CR-1 inyectado (deposit-específico)
  │             validateDepositForSponsor(tx, feePayerPk, cfg),  AC-1/2/3/4/8
  │        estimateFeeLamports,       // para el daily cap
  │        onFeeEstimated: (lam) => checkAndIncrDailyLamports(lam, cap)  AC-6 fail-closed
  │        rpcUrl, maxFeeLamports })
  │  6. → { signature }  |  error explícito
```

- **`cosignAndBroadcast` (primitiva GENÉRICA, reusable)**: recibe la tx + un **validador inyectado**
  (`validate: (tx, feePayerPubkey) => Cr1Result`). Firma SÓLO si `validate` devuelve `{ ok:true }`.
  NO conoce nada del `deposit`. HU-SOL-13 la reusa pasando su propio validador `validateReleaseForSponsor`.
- **`validateDepositForSponsor` (CR-1, ESPECÍFICO del deposit)**: implementa AC-1/2/3/4/8 contra el
  shape del `deposit`. Es lo que HU-SOL-13 reemplaza por su equivalente `release`.
- Contrato del validador (punto de extensión, §10): `type SponsorTxValidator = (tx: Transaction,
  feePayerPubkey: PublicKey) => { ok: true; feeUpperBoundLamports: bigint } | { ok: false; reason: string }`.

### 4.4 CR-1 — checks fail-closed (el corazón, AC-2/3/4/8)

`validateDepositForSponsor` deserializa con `Transaction.from(Buffer.from(base64,'base64'))` (legacy;
si `VersionedTransaction`, ver DT-7) y assert **en orden, cualquier fallo → `{ ok:false, reason }`
SIN excepción-por-default** (todo `try/catch` externo también rechaza — CD-3):

1. **Fee-payer correcto** — `tx.feePayer` (o `message.accountKeys[0]`) === `getFeePayerPubkey()`.
   Si no coincide → reject (no somos el fee-payer que la tx declara).
2. **Exactamente 1 ix de negocio** — `tx.instructions` filtrando ComputeBudget: debe quedar
   **exactamente 1** ix, cuyo `programId` === escrow programId whitelisteado (`SOLANA_ESCROW_PROGRAM_ID`,
   default `BBQ9…79WA`). Cualquier ix extra de otro programId (fuera de whitelist) → reject (AC-2).
3. **ComputeBudget acotado** — a lo sumo 2 ix `ComputeBudgetProgram` (SetComputeUnitLimit /
   SetComputeUnitPrice). CU ≤ `SOLANA_SPONSOR_MAX_COMPUTE_UNITS`; priceMicroLamports ≤
   `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS`. Cualquier otra ix de ComputeBudget o valor fuera de
   rango → reject (AC-4). Cota de fee derivada ≤ `SOLANA_SPONSOR_MAX_FEE_LAMPORTS`.
4. **Discriminator + estructura del `deposit`** — la ix de negocio: primeros 8 bytes de `ix.data` ===
   `[242,35,198,137,82,225,242,182]`; nº de cuentas === 8 posicionales + N remaining; las 8
   posicionales en orden esperado con flags (`sender` writable+signer; `token_program` ===
   `Tokenkeg…`; `associated_token_program` === `ATokenGP…`; `system_program` === `1111…`); la
   remaining `reference` con `isSigner:false, isWritable:false`. Desviación → reject (AC-1/AC-2).
   *(No re-derivamos PDAs con anchor — verificamos estructura + program IDs de sistema pinneados;
   la validez on-chain la garantiza el programa escrow al ejecutar, y el `verify()` de HU-SOL-6.)*
5. **Fee-payer NO es source/authority/signer indebido (AC-3, AC-8)** — recorrer TODAS las ix (incluida
   la de negocio y cualquier ComputeBudget) y assertar:
   - el fee-payer pubkey **no** aparece en ninguna ix del **System Program** como cuenta de un
     `Transfer`/`Assign`/`CreateAccount`/`Allocate` en el rol de `from`/`funder`/`base`;
   - el fee-payer pubkey **no** aparece en ninguna ix del **SPL Token** como `source`/`authority`/
     `owner` de `Transfer`/`TransferChecked`/`CloseAccount`/`SetAuthority`/`Approve`;
   - el fee-payer pubkey **no** es la cuenta `sender` (índice 0) del `deposit` (el sender/depositor y
     rent-payer es la wallet, no el fee-payer — AC-8);
   - el fee-payer aparece EXCLUSIVAMENTE como `accountKeys[0]` (fee payer implícito) y **no writable**
     por ninguna ix salvo el débito de fee que hace el runtime (fuera de las ix).
   Cualquier match indebido → reject (AC-3). *(Como la tx esperada tiene 1 sola ix `deposit` y su set
   de cuentas es cerrado, en el happy-path el fee-payer sólo está en `accountKeys[0]`; este check es
   la defensa contra ix inyectadas.)*
6. **Blockhash fresco (AC-4)** — con `Connection(SOLANA_RPC_URL)`: `isBlockhashValid(recentBlockhash)`
   (o `getLatestBlockhash` + comparación de `lastValidBlockHeight` vs `getBlockHeight`). Si no es
   válido/fresco → reject. Se ejecuta en `cosignAndBroadcast` (necesita red) justo antes de firmar.

**Devuelve** `{ ok:true, feeUpperBoundLamports }` o `{ ok:false, reason }`. `reason` es un enum
estable, PII-free, sin echo de la tx.

### 4.5 Concurrencia (AC-5) — mecanismo elegido (resuelve DT-5)

**Elegido: serialización por fee-payer + `lastValidBlockHeight` + rebroadcast acotado.**
`cosignAndBroadcast` envuelve la co-firma+broadcast en `runExclusive(<feePayerSentinelId>, fn)`
(reusa `src/chains/chain-mutex.ts`), garantizando orden FIFO y que dos envíos no compartan un estado
de firma inconsistente. Cada tx usa su propio `recentBlockhash` (el que trae la tx del sender) y su
`lastValidBlockHeight`; se rebroadcastea (hasta `SOLANA_SPONSOR_MAX_REBROADCASTS`, default 3, con
backoff) hasta confirmación (`commitment:'confirmed'`) o hasta exceder `lastValidBlockHeight` → en ese
caso fail-closed (`SPONSOR_BROADCAST_EXPIRED`).

**Por qué no durable-nonce pool:** requiere provisionar/rotar nonce accounts on-chain (SOL real,
rotación, gestión de estado) — sobredimensionado para devnet + volumen bajo del hackathon.
**Trade-off documentado:** la serialización es un cuello de botella bajo alta concurrencia sostenida
(las txs se firman en serie). Aceptable para devnet/MVP. **Upgrade path:** durable-nonce pool como
follow-up si el volumen prod lo exige (§8 riesgo R-3). Importante: la serialización NO causa colisión
porque cada tx trae su blockhash del sender; el mutex sólo evita interleaving de la firma/estado del
Keypair singleton y da orden determinista al broadcast.

### 4.6 Env vars nuevas (todas opt-in / con default; fuera de `.superRefine`)

| Env | Tipo | Default | Rol |
|-----|------|---------|-----|
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | string (JSON array 64 bytes) | — (unset ⇒ opt-in-off) | secret; NUNCA logueada (AC-10) |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | bool | `false` | flag OFF por default (CD-10). Ruta activa sólo si `true` **y** key presente |
| `SOLANA_ESCROW_PROGRAM_ID` | string b58 | `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` | whitelist programId `deposit` (CD-4) |
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | number | `300000` | cota CU (AC-4/CD-5) |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | number | `50000` | cota priority fee (AC-4/CD-5) |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | number | `100000` | cota fee por tx (0.0001 SOL) |
| `SOLANA_SPONSOR_RATE_LIMIT_MAX` | number | `20` | requests/ventana por caller (AC-6) |
| `SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC` | number | `60` | ventana rate-limit |
| `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS` | string | `500000000` (0.5 SOL) | tope diario agregado fail-closed (AC-6). STRING por precisión (patrón `SETTLE_MAX_AMOUNT_ATOMIC`) |
| `SOLANA_SPONSOR_MAX_REBROADCASTS` | number | `3` | reintentos de broadcast (AC-5) |
| `SOLANA_SPONSOR_POP_SECRET` | string | — (unset ⇒ PoP rechaza todo, fail-closed) | HMAC del PoP/KYC (AC-7) |

> `SOLANA_RPC_URL` ya existe (WKH-205) y se reusa para la `Connection` de broadcast/blockhash.
> Valores numéricos = defaults **conservadores configurables** (resuelve NEEDS CLARIFICATION #2).

### 4.7 Flujo principal (Happy Path)

1. chaski (server-side) hace `POST /solana/sponsor` con `Authorization: Bearer <FACILITATOR_API_KEY>`
   y body `{ partialSignedTx, reference, sender, popProof }`.
2. `requireFacilitatorKey` OK → `verifySponsorPop` OK → rate/daily OK.
3. `cosignAndBroadcast` → CR-1 (`validateDepositForSponsor`) `{ ok:true, feeUpperBoundLamports }` →
   daily-lamports INCR OK → blockhash fresco OK → co-firma con el fee-payer Keypair →
   `sendRawTransaction` → confirma (rebroadcast si hace falta) → signature.
4. Respuesta `200 { signature }`. chaski propaga la signature a `ConfirmAndSend`/caller.

### 4.8 Flujo de error

- CR-1 rechaza (cualquier check) → `422 { error:{ code:'SPONSOR_REJECTED', reason, http:422 } }`,
  **sin firmar ni transmitir**, sin echo de la tx.
- PoP inválido/ausente → `403 SPONSOR_POP_INVALID` (antes de parsear).
- Rate-limit / daily-cap → `429 SPONSOR_RATE_LIMITED` / `429 SPONSOR_DAILY_CAP` (fail-closed también
  ante error del store — CD-6).
- Blockhash expirado / broadcast falla tras rebroadcasts → `409 SPONSOR_BROADCAST_EXPIRED` /
  `502 SPONSOR_BROADCAST_FAILED`.
- Fee-payer no configurado (`SOLANA_FEE_PAYER_SPONSOR_ENABLED=false` o sin key) → ruta **no registrada**
  (opt-in-off); si se fuerza, `501 SPONSOR_NOT_ENABLED`.
- Cualquier excepción de parseo/red en CR-1 → reject fail-closed (nunca firma). La privkey nunca
  aparece en ningún error (AC-10).

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-10) — vigentes tal cual (§141-165 work-item)
- **CD-1** PROHIBIDO modificar el relayer gasless EVM (`src/methods/eip3009/*`, `src/infra/wallet.ts`,
  `OPERATOR_PRIVATE_KEY`) — ninguna suite EVM cambia assertion (AC-9).
- **CD-2** OBLIGATORIO reconstruir/parsear la tx ANTES de firmar — PROHIBIDO firmar blob opaco por
  metadata declarada.
- **CD-3** OBLIGATORIO fail-closed en CADA check CR-1; cualquier ambigüedad/error de parseo → reject.
- **CD-4** OBLIGATORIO whitelist explícita de programId (escrow + System/Token/AssociatedToken/
  ComputeBudget sólo donde se esperan) — PROHIBIDO aceptar programId no listado.
- **CD-5** OBLIGATORIO acotar ComputeBudget (CU + priority-fee) vía env — PROHIBIDO tx sin tope.
- **CD-6** OBLIGATORIO rate-limit + daily-cap SOL fail-CLOSED — PROHIBIDO fail-open ante error del store.
- **CD-7** OBLIGATORIO leer la privkey desde env dedicada, nunca hardcodeada, nunca logueada.
- **CD-8** PROHIBIDO `@solana/pay`.
- **CD-9** OBLIGATORIO que el depositor (sender), no el fee-payer, pague rent — fee-payer sólo fee de red.
- **CD-10** Devnet + flags OFF por default — cero plata real.

### Nuevos de este SDD
- **CD-11** OBLIGATORIO separar la primitiva `cosignAndBroadcast` (genérica, reusable HU-SOL-13) del
  validador CR-1 (`validateDepositForSponsor`, deposit-específico). La primitiva firma SÓLO si el
  validador inyectado devuelve `{ ok:true }`. PROHIBIDO hardcodear la lógica del `deposit` dentro de la
  primitiva.
- **CD-12** OBLIGATORIO parsear la tx con `@solana/web3.js` (ya pinneado `^1.98.4`) — PROHIBIDO
  `@coral-xyz/anchor` (no es dep) y PROHIBIDO confiar en IDL para CR-1; comparar discriminator +
  program IDs por bytes/pubkey exactos.
- **CD-13** OBLIGATORIO opt-in-off (patrón `solana-adapter.ts:419-430`): sin
  `SOLANA_FEE_PAYER_PRIVATE_KEY` (o flag OFF) la ruta NO se registra y el resto corre byte-idéntico.
- **CD-14** (auto-blindaje #026) OBLIGATORIO en tests que mockeen módulos: `import * as mod` (runtime)
  + `vi.mocked(mod)`, NO `import type * as X` como valor. Referencia: WKH-205 auto-blindaje#1.
- **CD-15** (auto-blindaje #026) OBLIGATORIO anteponer `// eslint-disable-next-line
  no-secrets/no-secrets -- <razón: pubkey pública on-chain>` en cada literal base58 (programIds, mints,
  system programs). Referencia: WKH-205 auto-blindaje#2.
- **CD-16** (auto-blindaje #025) OBLIGATORIO, antes de tocar cualquier tipo/schema compartido, auditar
  TODOS los consumidores del tipo inferido (aquí: la ruta nueva es aditiva y NO comparte schema con
  `routes/settle.ts`/`ledger.ts` — mantenerlo así; PROHIBIDO widenizar `SettleRequestSchema` u otros
  tipos EVM). Referencia: WKH-204 auto-blindaje.

### PROHIBIDO (resumen)
- NO modificar archivos EVM (CD-1). NO agregar deps nuevas (usar `@solana/web3.js` presente).
- NO crear tabla Postgres nueva (daily-cap va en Redis).
- NO loguear la privkey ni el body crudo de la tx. NO echo de la tx en errores.
- NO fail-open en ningún check de seguridad. NO firmar sin validador OK.

## 6. Scope

**IN (facilitator):**
- Ruta `POST /solana/sponsor` (opt-in-off).
- CR-1 (`validateDepositForSponsor` + `deposit-shape`).
- Primitiva reusable `cosignAndBroadcast`.
- Fee-payer key-singleton (`solana-fee-payer.ts`).
- Anti-abuso: rate-limit + daily-lamports fail-closed + PoP gate.
- Env vars §4.6. Registro condicional en `app.ts`. Redaction de la privkey.
- Tests §7.

**IN (chaski-v3, companion SDD en ese repo — §11 contrato):**
- Ruta server-only que reenvía `{ partialSignedTx, reference, sender, popProof }` al facilitator y
  propaga la `signature`.
- Gateway thin (`http-solana-sponsor-gateway.ts` análogo a `http-settlement-gateway.ts`).

**OUT:**
- `authorizePrincipal`/armado del `deposit` + partial-sign (HU-SOL-5, ya hecho, no se toca).
- `verify()` on-chain del `deposit` (HU-SOL-6, no se reimplementa).
- `release`/settle final del escrow (HU-SOL-13) — pero la primitiva se diseña reusable para él.
- Wiring completo dentro de `ConfirmAndSend` (marcar `principal_in`, etc.) → follow-up HU-SOL-13
  (NON-blocking, F1 Missing Inputs #4).
- Deploy devnet, activación de flags, fondeo del fee-payer con SOL — founder-gated.
- Mainnet. `@solana/pay`. Durable-nonce pool (upgrade path futuro).

## 7. Plan de tests (≥1 por AC)

Framework: `vitest` (`vitest run`). Fixtures: construir txs con `@solana/web3.js` en el test (armar el
`deposit` esperado como el que produce `chaski/solana-wallet.ts`, y variantes maliciosas). Broadcast/
Connection **mockeados** (sin red real, cero plata — CD-10).

| Test | AC | Vector |
|------|-----|--------|
| `cr1.test.ts` T1 — happy | AC-1 | tx = exactamente `deposit` esperado → `{ ok:true }` |
| `cr1.test.ts` T2 — **★ tx no-esperada** | AC-2 | tx con una ix `SystemProgram.transfer` extra (además del deposit) → `{ ok:false }`, **NO se firma** |
| `cr1.test.ts` T3 — programId fuera de whitelist | AC-2 | ix con programId aleatorio → reject |
| `cr1.test.ts` T4 — deposit ausente / ix de menos | AC-2 | tx vacía o sólo ComputeBudget → reject |
| `cr1.test.ts` T5 — **★ fee-payer como source de Transfer** | AC-3 | ix `SystemProgram.transfer({from: feePayer})` → reject, **NO se firma** |
| `cr1.test.ts` T6 — fee-payer authority SPL Transfer/SetAuthority/Close | AC-3 | 3 sub-vectores (SPL `transfer`/`setAuthority`/`closeAccount` con fee-payer) → reject |
| `cr1.test.ts` T7 — fee-payer como `sender`/rent-payer del deposit | AC-8 | account[0] del deposit == feePayer → reject |
| `cr1.test.ts` T8 — ComputeBudget fuera de rango | AC-4 | CU > max ó priorityFee > max → reject |
| `cr1.test.ts` T9 — discriminator equivocado | AC-2 | primeros 8 bytes ≠ deposit discriminator → reject |
| `cr1.test.ts` T10 — parseo lanza / bytes corruptos | AC-2/CD-3 | base64 inválido → reject fail-closed (no throw hacia arriba) |
| `broadcast.test.ts` T11 — blockhash stale | AC-4 | `isBlockhashValid` mock=false → reject sin firmar |
| `broadcast.test.ts` T12 — **★ concurrencia N sin colisión** | AC-5 | 5 txs de senders distintos en paralelo → 5 signatures, orden FIFO, sin colisión (mock `sendRawTransaction`) |
| `broadcast.test.ts` T13 — rebroadcast + expiry | AC-5 | confirm falla hasta expiry → `SPONSOR_BROADCAST_EXPIRED` |
| `broadcast.test.ts` T14 — primitiva reusable | CD-11 | `validate` inyectado que devuelve `{ok:false}` → NO firma; `{ok:true}` → firma. Prueba que la primitiva es agnóstica al deposit |
| `cap.test.ts` T15 — rate-limit fail-closed | AC-6 | exceder max → 429; store Redis caído → **fail-closed** (rechaza) |
| `cap.test.ts` T16 — daily lamports fail-closed | AC-6 | acumulado > cap → 429; error del contador → fail-closed |
| `route.test.ts` T17 — PoP inválido/ausente | AC-7 | sin `popProof` o HMAC malo → 403 **antes** de parsear (spy: CR-1 no invocado) |
| `route.test.ts` T18 — happy e2e mockeado | AC-1 | auth+PoP+rate+CR-1+broadcast mock → 200 `{ signature }` |
| `route.test.ts` T19 — privkey nunca en logs/errores | AC-10 | forzar error; assert que la env/privkey no aparece en logs (spy logger) ni en el body |
| `env-optin.test.ts` T20 — opt-in-off | AC-9/CD-13 | sin `SOLANA_FEE_PAYER_PRIVATE_KEY` → ruta no registrada (404) |
| `env-optin.test.ts` T21 — **★ EVM byte-idéntico** | AC-9 | correr la suite EVM completa (`npm test`) sin cambios → todos verdes; ninguna assertion EVM modificada |

## 8. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| R-1: CR-1 incompleto deja pasar una ix maliciosa (drain) | M | **Crítico** | fail-closed en cada check + set cerrado de ix esperadas + tests T2/T5/T6/T7; AR obligatorio ataca vectores |
| R-2: parseo de `VersionedTransaction` distinto a legacy | B | M | chaski emite legacy `Transaction` (`solana-wallet.ts:136`); CR-1 soporta legacy y rechaza v0 con `SPONSOR_UNSUPPORTED_TX` hasta que HU lo requiera (DT-7) |
| R-3: serialización = cuello de botella bajo carga | B (devnet) | M | aceptado para devnet; upgrade a durable-nonce pool documentado (§4.5) |
| R-4: privkey leak en log/error | B | Crítico | AC-10 + redaction (`logger.ts`) + test T19 + throw con nombre-no-valor (patrón `wallet.ts`) |
| R-5: daily-cap fail-open accidental | B | A | CD-6 fail-CLOSED explícito; test T15/T16 con store caído |
| R-6: regresión EVM | B | A | CD-1 + dirs nuevos aislados + test T21 |

## 9. Missing Inputs (NEEDS CLARIFICATION del F1 — RESUELTOS)

| # | Item | Resolución |
|---|------|-----------|
| 1 | Mecanismo concurrencia (AL-7 / DT-5) | **Serialización `runExclusive` + `lastValidBlockHeight` + rebroadcast** (§4.5). Durable-nonce pool = upgrade path futuro. |
| 2 | Valores numéricos anti-abuso (AC-6) | Defaults conservadores configurables por env (§4.6): rate 20/60s, daily 0.5 SOL, fee/tx 0.0001 SOL, CU 300k, priority 50k µlamports. |
| 3 | Shape endpoint chaski (§11) | **Ruta standalone** `POST /api/settle/sponsor-solana` (server-only) + gateway thin; NO se mete en `ConfirmAndSend` en esta HU (wiring = HU-SOL-13). Contrato en §11. El Architect de chaski autora el companion SDD y fija su NNN. |

> Sin `[NEEDS CLARIFICATION]` pendientes. El PoP exacto (payload HMAC) se coordina con chaski en §11
> como contrato; el facilitator lo valida fail-closed contra `SOLANA_SPONSOR_POP_SECRET`.

## 10. Punto de extensión — reuso por HU-SOL-13 (release)

HU-SOL-13 (release/settle non-custodial) reusa la infra así, **sin tocar** la primitiva:
1. Invoca `cosignAndBroadcast(releaseTxBase64, { validate: validateReleaseForSponsor, ... })`.
2. Implementa `validateReleaseForSponsor` (nuevo, análogo a `validateDepositForSponsor`) con el
   discriminator/estructura de la ix `release` del escrow — mismo contrato `SponsorTxValidator`.
3. La serialización, rebroadcast, key-singleton, rate/daily-cap y PoP se heredan sin cambio.

Contrato estable a respetar (NO romper en HU-SOL-13):
`type SponsorTxValidator = (tx: Transaction, feePayerPubkey: PublicKey) =>
  { ok: true; feeUpperBoundLamports: bigint } | { ok: false; reason: string }`.

## 11. Contrato cross-repo — chaski-v3 (companion SDD)

> El Architect de chaski-v3 autora su propio SDD (`doc/sdd/0NN-...`) e implementa esto. Aquí fijo el
> **contrato HTTP** (fuente de verdad del wire-format), verificado contra `solana-wallet.ts:146-149`.

**Request** (chaski server → facilitator), `POST {FACILITATOR_BASE_URL}/solana/sponsor`,
`Authorization: Bearer {FACILITATOR_API_KEY}` (server-side, nunca en el browser — CD-4 chaski):
```
{ "partialSignedTx": "<base64>",   // = SolanaPrincipalAuthorization.partialSignedTx
  "reference": "<base58 pubkey>",  // = SolanaPrincipalAuthorization.reference
  "sender": "<base58 pubkey>",     // wallet del depositor (para PoP + AC-8)
  "popProof": "<hmac attestation>" // KYC/PoP; validado fail-closed vs SOLANA_SPONSOR_POP_SECRET (AC-7)
}
```
**Response 200**: `{ "signature": "<base58 tx signature>" }`.
**Errores**: `403 SPONSOR_POP_INVALID` | `422 SPONSOR_REJECTED` | `429 SPONSOR_RATE_LIMITED|SPONSOR_DAILY_CAP`
| `409 SPONSOR_BROADCAST_EXPIRED` | `501 SPONSOR_NOT_ENABLED` | `502 SPONSOR_BROADCAST_FAILED`.

Lado chaski (fail-closed como `http-settlement-gateway.ts`): red caída / shape raro / status ≠ 200 →
NO asumir éxito; propagar reason que bloquea. El browser NUNCA llama al facilitator directo (la ruta
`/api/settle/sponsor-solana` server-only reenvía con las credenciales server-side).

---

## Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC (1-10) tiene ≥1 archivo en §4.1 y ≥1 test en §7
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob (§3 tablas)
[x] No hay [NEEDS CLARIFICATION] pendientes — 3 resueltos en §9
[x] Constraint Directives: 10 heredados + 6 nuevos (≥3 PROHIBIDO)
[x] Context Map: 13 archivos leídos (facilitator + chaski)
[x] Scope IN/OUT explícitos (§6)
[x] BD: sin tabla nueva (daily-cap en Redis) — verificado patrón settle-cap.ts
[x] Happy Path (§4.7) completo
[x] Flujo de error (§4.8) — ≥8 casos
[x] Primitiva reusable desacoplada de CR-1 (§4.3, §10, CD-11) — reuso HU-SOL-13 garantizado
[x] Concurrencia (AC-5) y anti-abuso (AC-6) con mecanismo + valores fijados (§4.5, §4.6)
[x] EVM byte-idéntico (AC-9): dirs aislados + test T21
```

**Vectores estrella cubiertos (§7):** T2 (tx no-esperada NO se esponsoriza), T5/T6/T7 (fee-payer como
source/authority/rent-payer → reject), T12 (concurrencia N sin colisión), T15/T16 (rate/daily
fail-closed), T21 (EVM byte-idéntico).

Estado: **listo para SPEC_APPROVED** (sin TBDs bloqueantes).

---

*SDD generado por NexusAgil — FULL (F2). Autor: nexus-architect.*
