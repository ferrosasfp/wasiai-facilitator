# Work Item — [WKH-217 / HU-SOL-14] Gasless / Fee-Payer Sponsorship (relayer propio Solana)

## Resumen
El usuario Solana sin SOL igual completa el `deposit` al escrow no-custodial: `chaski-v3` arma la
tx con `feePayer = facilitator`, la partial-firma con la wallet del sender y se la envía a
`wasiai-facilitator`, que debe **reconstruir y validar la tx (nunca firmar un blob opaco)**,
co-firmar como fee-payer y transmitirla — pagando el fee de red por el usuario. Es la pieza de
seguridad más sensible del track Solana (auditoría-ampliada): un fee-payer que firma ciegamente es
un vector de drenaje directo de su propia wallet.

Repos: `wasiai-facilitator` (lado crítico — parseo/validación/co-firma/broadcast) + `chaski-v3`
(endpoint que envía la tx partial-firmada al facilitator).

## Sizing
- SDD_MODE: full (QUALITY — seguridad-crítica, ampliada por auditoría)
- Estimación: L (cross-repo, nueva superficie de firma con fondos propios del facilitator, CR-1 es
  un parser+validador de instrucciones Solana completo, más anti-abuso + concurrencia)
- Branch sugerido (facilitator): `feat/027-wkh-217-solana-feepayer-sponsorship`
- Branch sugerido (chaski-v3): `feat/0NN-hu-sol-14-feepayer-endpoint` — NNN a coordinar con el
  Architect de chaski-v3 en su propio `doc/sdd/_INDEX.md` (última entrada indexada: `024`
  HU-SOL-4; `solana-wallet.ts` ya contiene HU-SOL-5 `authorizePrincipal` implementado pero sin fila
  propia visible en el índice al momento de este F1 — el Architect de chaski debe confirmar el NNN
  real antes de abrir F2 en ese repo).

## Skills Router
- `solana-security` (parseo/validación de instrucciones, fail-closed, whitelisting de programId)
- `payments-relayer` (patrón operator-wallet / fee-sponsorship, paridad con el relayer EVM EIP-3009)

## Acceptance Criteria (EARS)

- AC-1 (sponsor camino feliz): WHEN chaski-v3 envía al facilitator una tx Solana partial-firmada
  cuyo único set de instrucciones es exactamente la ix `deposit` esperada del escrow Anchor
  (programId whitelisteado, cuentas = sender/mint/escrowState/vault/senderAta + la `reference`
  remaining-account, sin ComputeBudget fuera de rango, blockhash fresco), the system SHALL
  co-firmar la tx como fee-payer, transmitirla y devolver la signature.

- AC-2 (CR-1, RECHAZO de tx no-esperada — drenaje del fee-payer): IF el set de instrucciones de la
  tx recibida NO es EXACTAMENTE el esperado (instrucciones de más, de menos, distinto programId, o
  cualquier ix cuyo programId no esté en la whitelist), THEN the system SHALL rechazar la tx SIN
  firmarla ni transmitirla, fail-closed, sin excepciones.

- AC-3 (CR-1, fee-payer nunca es source/authority de un transfer): IF el pubkey del fee-payer
  aparece como source, authority, owner o signer en cualquier instrucción `Transfer`,
  `TransferChecked`, `Close`, `Assign`, `SetAuthority` (System Program o SPL Token, en cualquier
  posición de la tx, incluidas instrucciones anidadas si el parser las expone), THEN the system
  SHALL rechazar la tx sin firmarla, fail-closed.

- AC-4 (blockhash + ComputeBudget acotados): IF el `recentBlockhash` de la tx no es válido/fresco
  (fuera de la ventana de `lastValidBlockHeight`) O la tx incluye instrucciones
  `ComputeBudgetProgram` que exceden el límite configurado de compute-units/priority-fee, THEN the
  system SHALL rechazar la tx sin firmarla.

- AC-5 (concurrencia sin colisión): WHILE N transacciones de distintos usuarios llegan
  concurrentemente al endpoint de sponsorship, the system SHALL co-firmar y transmitir cada una sin
  que ninguna falle por colisión de nonce/blockhash del fee-payer (durable-nonce pool o
  serialización con `lastValidBlockHeight` + rebroadcast ante expiry — mecanismo exacto: DT
  pendiente de F2, ver Missing Inputs).

- AC-6 (anti-abuso, rate-limit + tope diario fail-closed): IF el caller (por owner/wallet/IP,
  patrón WFAC-40 existente) excede el rate-limit configurado O el tope diario de SOL esponsorizado
  agregado, THEN the system SHALL rechazar el sponsorship (fail-closed) sin firmar ni transmitir,
  devolviendo un código de error explícito (no silencioso).

- AC-7 (anti-abuso, KYC/PoP antes de esponsorizar): IF la solicitud de sponsorship no trae una
  prueba de KYC/PoP válida asociada al sender (patrón `PopSigner`/autoridad server-side ya usado en
  `confirm-and-send.ts`/WKH-206), THEN the system SHALL rechazar el sponsorship antes de parsear/
  firmar la tx.

- AC-8 (rent lo paga el depositor, no el fee-payer): the system SHALL verificar que ninguna
  instrucción de la tx crea una cuenta nueva (rent-exempt allocation) con el fee-payer como
  `payer`/`funder` — el fee-payer paga SOLO el fee de red de la tx, nunca rent ni transferencias.

- AC-9 (EVM byte-idéntico, no-regresión): the system SHALL dejar el relayer gasless EVM existente
  (EIP-3009, `OPERATOR_PRIVATE_KEY`, `src/methods/eip3009/*`, `src/core/settle.ts` rama
  `eip155:*`) sin ningún cambio de comportamiento — ninguna suite de tests EVM cambia su
  assertion.

- AC-10 (key del fee-payer desde env, nunca en código): the system SHALL leer la clave privada del
  fee-payer Solana EXCLUSIVAMENTE desde una variable de entorno dedicada (ej.
  `SOLANA_FEE_PAYER_PRIVATE_KEY`), nunca hardcodeada, y nunca loguearla ni exponerla en ningún
  response/error.

## Scope IN
- `wasiai-facilitator`:
  - Endpoint nuevo de sponsorship (ej. `POST /solana/sponsor` o análogo — el Architect define el
    shape exacto en F2, x402-adyacente pero NO es `/settle` per-se porque no hay pago x402 de por
    medio, es el fee-payer de RED).
  - Parser/validador de la tx Solana recibida (deserializar `Transaction`/`VersionedTransaction`
    base64, reconstruir instrucciones, NUNCA confiar en metadata declarada por el caller) — el
    corazón de CR-1.
  - Módulo de co-firma del fee-payer (nuevo, análogo a `src/infra/wallet.ts` pero Solana:
    `Keypair` desde `SOLANA_FEE_PAYER_PRIVATE_KEY`, opt-in-off si la env no está seteada — mismo
    patrón que `solanaAdapter` en `solana-adapter.ts:419-430`).
  - Broadcast + confirmación (envío + espera de status, rebroadcast ante blockhash-expiry si aplica
    al modelo de concurrencia elegido en F2).
  - Anti-abuso: rate-limit (reusa/extiende el patrón Redis-backed de `middleware/rate-limit.ts` /
    WFAC-40) + tope diario de SOL esponsorizado (nuevo contador, fail-closed) + gate KYC/PoP.
  - Whitelist de programId (escrow Anchor + System Program/SPL Token solo en las posiciones
    esperadas), límite de ComputeBudget, validación de blockhash freshness.
- `chaski-v3`:
  - Endpoint nuevo (server-side, ej. `app/api/settle/principal-solana` o el que el Architect de
    chaski defina) que toma el `{ tx: base64, solana: { partialSignedTx, reference } }` que ya
    devuelve `authorizePrincipal` (`solana-wallet.ts:146-149`, HU-SOL-5, YA IMPLEMENTADO — no se
    toca) y lo reenvía al endpoint de sponsorship del facilitator, propagando la signature
    resultante de vuelta al caller/orquestación de `ConfirmAndSend`.

## Scope OUT
- El armado de la ix `deposit` y el partial-sign del sender — YA IMPLEMENTADO en HU-SOL-5
  (`chaski-v3/src/infrastructure/solana-wallet.ts:66-150`). Esta HU NO toca ese archivo salvo, si
  hace falta, el punto de envío downstream (el `tx`/`solana.partialSignedTx` ya devuelto).
  Este SDD/Architect debe confirmar caso de necesitar leer campos adicionales del retorno de
  `authorizePrincipal` (ej. el `reference`) para forwardearlos.
- El `verify()` on-chain del `deposit` (checks de mint/programId/dedup/reference) — YA
  IMPLEMENTADO en HU-SOL-6/`solana-adapter.ts`. Esta HU NO reimplementa esos checks; el fee-payer
  valida SOLO la ESTRUCTURA de la tx antes de firmar (CR-1), no el resultado on-chain (eso ocurre
  después, en el settle/verify existente).
- El `release`/settle non-custodial final del escrow — HU-SOL-13 (fuera de esta HU).
- Deploy real a devnet, activación de flags, fondeo de la wallet del fee-payer con SOL real —
  founder-gated (fuera del alcance del pipeline NexusAgil).
- Cualquier cambio al gasless EVM existente (EIP-3009, `OPERATOR_PRIVATE_KEY`) — CD-1/AC-9.
- `@solana/pay` — explícitamente prohibido por la HU.
- Mainnet Solana — solo devnet.

## Decisiones técnicas (DT-N)
- DT-1: El módulo de co-firma Solana sigue el patrón `opt-in-off` ya establecido en
  `solana-adapter.ts:419-430` (`solanaAdapter | null`, gateado por presencia de env vars) — si
  `SOLANA_FEE_PAYER_PRIVATE_KEY` no está seteada, el endpoint de sponsorship no se registra/queda
  501, y el resto del facilitator (EVM incluido) corre byte-idéntico.
- DT-2: El parseo de instrucciones reusa `@solana/web3.js` (ya dependency del facilitator vía
  `solana-adapter.ts`) — `Transaction.from(base64)` / `VersionedTransaction.deserialize`, NUNCA
  `@solana/web3.js` de una versión distinta a la ya pinneada.
- DT-3: El anti-replay/ledger de sponsorship (si se decide persistir signatures esponsorizadas)
  sigue el patrón fail-CLOSED de `src/infra/solana-dedup.ts` (tabla dedicada
  `facilitator_solana_settlements` NO se reusa para esto — nueva tabla si Architect la considera
  necesaria para el tope diario de SOL, ej. `facilitator_solana_sponsorships`).
- DT-4: El rate-limit reusa la infraestructura Redis-backed existente (`middleware/rate-limit.ts`,
  WFAC-40) en vez de crear un mecanismo nuevo desde cero.
- DT-5 [PENDIENTE F2]: Mecanismo exacto de concurrencia (AL-7) — durable-nonce account pool vs.
  serialización con `lastValidBlockHeight` + rebroadcast. Ver Missing Inputs.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el comportamiento del relayer gasless EVM existente
  (`src/methods/eip3009/*`, `src/infra/wallet.ts`, `OPERATOR_PRIVATE_KEY`) — ninguna suite EVM
  cambia assertion (AC-9).
- CD-2: OBLIGATORIO reconstruir/parsear la tx Solana recibida ANTES de firmar — PROHIBIDO firmar un
  blob opaco basado solo en metadata declarada por el caller (CR-1, corazón de la HU).
- CD-3: OBLIGATORIO fail-closed en cada uno de los checks de CR-1 (set de instrucciones, fee-payer
  no es source/authority/signer de transfer/close/assign/SetAuthority, programId whitelisteado,
  ComputeBudget acotado, blockhash fresco) — cualquier ambigüedad o error de parseo rechaza, nunca
  aprueba por default.
- CD-4: OBLIGATORIO whitelist explícita de programId (escrow Anchor address + System
  Program/Token/ComputeBudget solo donde estructuralmente se esperan) — PROHIBIDO aceptar cualquier
  programId no listado.
- CD-5: OBLIGATORIO acotar ComputeBudget (compute-units y/o priority-fee) a un límite configurado
  vía env — PROHIBIDO transmitir tx con ComputeBudget sin tope.
- CD-6: OBLIGATORIO rate-limit + tope diario de SOL esponsorizado fail-closed (ME-5) — PROHIBIDO
  degradar a fail-open ante error del store de conteo (mismo patrón fail-CLOSED que
  `solana-dedup.ts`).
- CD-7: OBLIGATORIO leer la clave privada del fee-payer desde env var dedicada, nunca hardcodeada,
  nunca logueada.
- CD-8: PROHIBIDO `@solana/pay`.
- CD-9: OBLIGATORIO que el depositor (sender), no el fee-payer, pague cualquier rent de cuentas
  nuevas — el fee-payer paga EXCLUSIVAMENTE el fee de red de la tx.
- CD-10: Devnet + flags OFF por default — PROHIBIDO cualquier movimiento de SOL/USDC real en el
  alcance de esta HU (cero plata real).

## Missing Inputs
- [NEEDS CLARIFICATION — resuelto en F2 por Architect] Mecanismo exacto de concurrencia (AL-7):
  durable-nonce account pool (requiere infra adicional: crear/rotar nonce accounts) vs.
  serialización de envíos + tracking de `lastValidBlockHeight` + rebroadcast en expiry (más simple,
  puede ser cuello de botella bajo carga alta). Devnet + volumen bajo del hackathon sugieren
  serialización simple como default razonable, pero es una decisión de dominio/carga que el
  Architect debe fijar explícitamente en el SDD (DT-5).
- [NEEDS CLARIFICATION — resuelto en F2] Valores numéricos concretos de anti-abuso (AC-6): rate-
  limit (requests/min) y tope diario de SOL agregado esponsorizado. No especificados por la HU ni
  por el humano — el Architect debe proponer defaults conservadores (ej. paridad con
  `RATE_LIMIT_SETTLE_MAX` existente) y dejarlos configurables por env.
- [NEEDS CLARIFICATION — resuelto en F2] Shape exacto del endpoint chaski-v3 que reenvía la tx (ruta,
  si se integra dentro de `ConfirmAndSend`/`PrincipalSettlementGateway` como una rama Solana nueva
  o como un endpoint standalone) — Scope IN lo deja abierto a la decisión del Architect de chaski,
  siguiendo el patrón de composición ya usado en `app/api/settle/principal/route.ts` (broadcast →
  verify → attest) pero adaptado: acá el facilitator hace broadcast, y el verify/attest de Solana
  puede reusar la infraestructura de HU-SOL-6/13 si ya existe wiring, o quedar como follow-up.
- [NO bloqueante] El wiring completo de la respuesta del sponsorship dentro del flujo de
  `ConfirmAndSend` (marcar `principal_in`, etc.) puede quedar como follow-up si el Architect decide
  que el endpoint "envía y recibe signature" alcanza para esta HU y el wiring end-to-end es
  HU-SOL-13.

## Análisis de paralelismo
- Bloqueada por (ya DONE, disponible): HU-SOL-5 (`solana-wallet.ts` `authorizePrincipal`, tx shape
  fuente de verdad para CR-1) y HU-SOL-6/WKH-205 (`solana-adapter.ts`, verify-only, HELD en
  `feat/026-wkh-205-solana-adapter`, referencia de patrones fail-closed/opt-in-off).
- Bloquea a: HU-SOL-13 (release/settle non-custodial final) — necesita que el `deposit` pueda
  completarse sin SOL en la wallet del usuario antes de poder liberar nada.
- Puede correr en paralelo con: cualquier HU que no toque `src/chains/solana-adapter.ts`,
  `src/infra/wallet.ts` (EVM), ni `chaski-v3/src/infrastructure/solana-wallet.ts` — en particular,
  no debería colisionar con trabajo EVM (WKH-209/210/211 ya DONE, WKH-196 ya DONE).
- Cross-repo: el merge en `wasiai-facilitator` (el endpoint de sponsorship) debe preceder o
  coordinarse con el merge en `chaski-v3` (el endpoint que lo consume) — igual patrón que WKH-205
  (facilitator) + HU-SOL-1/4 (chaski) corriendo en paralelo pero con dependencia de contrato
  (shape de la tx) ya fijado por HU-SOL-5.
- Ambos repos quedan HELD (no merge a `main`/prod) hasta que el founder decida activar Solana en
  prod — mismo patrón que WKH-204/205 (`feat/025-...`, `feat/026-...`).
