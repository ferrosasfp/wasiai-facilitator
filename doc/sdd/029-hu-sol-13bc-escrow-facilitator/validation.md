# Validation Report — WKH-216 / HU-SOL-13 Waves 13b+13c (wasiai-facilitator) (DENSE)

**Veredicto**: RECHAZADO PARA DONE (bloqueante trivial de higiene git — fix-pack de 1 commit)
**Fecha**: 2026-07-22
**Branch**: `feat/029bc-hu-sol-13bc-escrow-facilitator` @ `cbf8ca7` (stacked sobre `feat/027-wkh-217-solana-feepayer-sponsorship`)

## Hallazgo BLOQUEANTE (runtime, propio de F4 — nadie más lo hubiera visto)

`src/__tests__/unit/cr1-release.test.ts` (249 líneas, 16 tests: CR-1 de `release` —
beneficiary/authority/discriminator injection, AUTHORITY_REFERENCED_OUTSIDE_IDX0,
empty-tx, malformed-tx) está **UNTRACKED** — nunca se hizo `git add`. NO forma parte
del commit `cbf8ca7` (F3 + fix-pack).

**Evidencia**:
- `git status --short` → `?? src/__tests__/unit/cr1-release.test.ts`
- `git show --stat cbf8ca7` → el archivo NO aparece en la lista de paths tocados.
- `npm run test` con el working tree tal cual (untracked incluido) → **979 tests, 71 files**.
- `git stash -u` (saca el untracked) + `npm run test` sobre el estado REALMENTE
  commiteado → **963 tests, 70 files**. `git stash pop` restaura el archivo.

**Impacto**: el número "973→979 tests" que reporta el F3/fix-pack es un artefacto del
working tree local, NO del commit. Un checkout limpio de `cbf8ca7` (o el merge a
`main`) pierde las 16 pruebas de CR-1 del release — exactamente las que cubren el
vector estrella (anti-drain de la release-authority, AC-3/AC-4). Esto es justo el
tipo de discrepancia "el archivo existe pero no llegó al artefacto real" que F4
existe para cazar (análogo al patrón de migration-no-aplicada, pero en git en vez
de DB).

**Fix requerido (trivial, NO requiere re-abrir Dev de fase)**: `git add
src/__tests__/unit/cr1-release.test.ts` + commit. Tras eso, re-confirmar `npm run
qa` → 979/979 con el archivo trackeado. No hace falta re-lanzar F3 completo; es un
commit de higiene, no una implementación nueva.

---

## Runtime checks

- **Test suite (estado del working tree, incluye el untracked)**: `npm run qa` →
  `tsc --noEmit` exit 0, `eslint src/ --max-warnings 0` exit 0, `format:check`
  exit 0, vitest **71 test files / 979 tests, todos PASS** (`Test Files 71 passed
  (71)`, `Tests 979 passed (979)`, duración 2.52s run).
- **Test suite (estado REALMENTE commiteado, `git stash -u`)**: `npm run test` →
  **70 test files / 963 tests PASS** (sin el archivo untracked). Confirma el
  hallazgo bloqueante arriba.
- **Primitiva HU-SOL-14 sin modificar**: `git diff
  feat/027-wkh-217-solana-feepayer-sponsorship -- src/methods/solana-sponsor/broadcast.ts
  src/methods/solana-sponsor/cr1.ts` → output vacío. Confirmado byte-idéntico.
- **EVM byte-idéntico**: `git diff --stat feat/027-wkh-217-solana-feepayer-sponsorship..HEAD`
  → los 17 archivos tocados son TODOS de `src/chains/solana-escrow.ts`,
  `src/infra/solana-*`, `src/methods/solana-escrow/*`, `src/routes/solana-escrow.ts`,
  la migración `004_*`, `src/app.ts` (solo +10 líneas de registro opt-in), tests
  nuevos, `package.json`/`package-lock.json` (dep `@coral-xyz/anchor` ya estaba de
  HU-SOL-14) y `auto-blindaje.md`. Cero archivos EVM (`settle.ts`, `verify.ts`,
  adapters EVM, `src/infra/wallet.ts`) tocados. `route.release.optin.test.ts:93`
  (`EVM boot byte-identical — /health still 200 with release off`) PASS.
- **Migración `004_facilitator_solana_release_dedup.sql`**: leída, NO aplicada
  (solo lectura, per instrucción). `CREATE TABLE IF NOT EXISTS
  facilitator_solana_release_claims (... escrow_pda TEXT NOT NULL UNIQUE ...)` +
  2 `CREATE INDEX IF NOT EXISTS` — **aditiva, idempotente**, comentario explícito
  línea 3: `PENDING-DEPLOY (founder-gated, CD-5): NO aplicar hasta el cutover del
  release-authority`. Confirmado consistente con `src/infra/solana-escrow-release-dedup.ts`
  (`TABLE = 'facilitator_solana_release_claims'`, insert de `escrow_pda`/`sender`/
  `remittance_id`/`network`).

## ACs (facilitator-side: AC-2, AC-3, AC-4, AC-5 — AC-1/6/7 son chaski-side, fuera de este repo)

| AC | Texto (EARS, resumen) | Status | Evidencia |
|----|------------------------|--------|-----------|
| AC-2 | WHILE procesa `release`, leer on-chain `EscrowState`+vault y verificar `status==Deposited`, `mint==USDC`, `vault.amount==state.amount` ANTES de firmar | ✅ PASS | `src/chains/solana-escrow.ts:210-221` (`verifyVault`); `src/routes/solana-escrow.ts:202-220` (read+verify en la MISMA invocación, antes de `claimEscrowRelease`/`buildReleaseTx`); tests `solana-escrow.verify.test.ts:32,37,43,48,55` PASS |
| AC-3 | WHEN KYC+TransFi confirmados y beneficiary==`escrow_state.beneficiary`, firmar+broadcastear `release` con la authority | ✅ PASS | `src/routes/solana-escrow.ts:238-270` (build desde `state` + `cosignAndBroadcast`); `src/methods/solana-escrow/build-release.ts:52-57` (beneficiary/sender/mint SOLO de `state`); test `route.release.test.ts:187` (`valid attestation + Deposited + fresh claim → 200 { signature }, primitive invoked once`) PASS |
| AC-4 | IF sin KYC/TransFi, beneficiary≠state.beneficiary, o status≠Deposited, rechazar ANTES de construir/firmar, sin transferir | ✅ PASS | `route.release.test.ts:197` (attestation inválida → 422, `cosignSpy` NOT called), `:206` (status Refunded → 422, NOT called), `:218` (vault≠amount → 422, NOT called), `:236` (RPC/decode fail → 422, NOT called); CR-1 rechaza inyección de beneficiary/authority en `cr1-release.ts:165-176` + `src/__tests__/unit/cr1-release.test.ts:155,162,168,192` (untracked — ver hallazgo bloqueante) |
| AC-5 | IF `status==Released` (on-chain) o ya procesada localmente (dedup), rechazar SIN re-firmar/re-broadcastear | ✅ PASS | `src/routes/solana-escrow.ts:213-215` (status Released → 409 ANTES de `verifyVault`/dedup); `src/infra/solana-escrow-release-dedup.ts:60-104` (`claimEscrowRelease`, INSERT claim-first, `UNIQUE(escrow_pda)` 23505 → `claimed:false`); tests `route.release.test.ts:245` (`status==Released → 409, primitive NOT invoked`), `:259` (`dedup already claimed → 409, primitive NOT invoked`), `:269` (`dedup store down → 500 fail-closed, primitive NOT invoked`), `:279` (llamadas concurrentes: 1ª claims, 2ª 409) — todos PASS |

## Verificaciones críticas de seguridad

- **Release solo tras verificar on-chain (CD-3)**: confirmado — `readEscrowState`
  se invoca dentro del mismo handler, ANTES de `verifyVault`, `claimEscrowRelease`
  y `buildReleaseTx`/`cosignAndBroadcast` (`solana-escrow.ts:202-254`, sin caché
  ni estado del body).
- **beneficiary/sender/mint SIEMPRE de `escrow_state` on-chain (CD-4)**:
  `ReleaseRequestSchema` (`routes/solana-escrow.ts:70-74`) solo acepta
  `remittanceId`/`sender`/`attestation` — Zod ni siquiera define un campo
  `beneficiary`, es estructuralmente imposible inyectarlo desde el body.
  `build-release.ts:52-54` deriva `sender`/`beneficiary`/`mint` de `input.state`.
- **CR-1 del release** (`cr1-release.ts`): `RELEASE_DISCRIMINATOR =
  [253,249,15,206,28,127,193,241]` (`release-shape.ts:22`, pinneado del IDL);
  `escrowProgramId` whitelisteado vía `cfg.escrowProgramId` (Check 2, línea 88-96);
  exactamente 1 business ix (`businessIx.length !== 1` reject, línea 84-87);
  la release-authority solo en idx0 del `release` ix — Check 5 (`cr1-release.ts:188-201`)
  recorre TODAS las instrucciones y rechaza `AUTHORITY_REFERENCED_OUTSIDE_IDX0` si
  el pubkey de la authority aparece en cualquier otro slot/instrucción que no sea
  `RELEASE_ACCOUNT_INDEX.AUTHORITY` (idx0) del ix `release` mismo.
- **Dedup fail-closed (CD-9/AC-5)**: `UNIQUE(escrow_pda)` en la migración 004 +
  `claimEscrowRelease` INSERT claim-first (nunca upsert-ignore) — 23505 →
  `{ok:true, claimed:false}` (409, replay); cliente Supabase null/error →
  `{ok:false}` (500, fail-closed, NO libera ni firma). Confirmado en
  `solana-escrow-release-dedup.ts:60-104` y tests `route.release.test.ts:259,269,279`.
- **verifyVault (MNR-2)**: `BigInt(vaultAmount) < BigInt(state.amount)` → reject
  (`solana-escrow.ts:217-219`) — dust EXCEDENTE (`vaultAmount > amount`) pasa
  (`ok:true`), déficit rechaza. BigInt en toda la comparación (nunca `Number()`).
  Test `solana-escrow.verify.test.ts:66` (excess → ok) y `:60` (deficit → reject)
  + `route.release.test.ts:226` (MNR-2: dust excess → 200, primitive invoked)
  confirman el fix de griefing DoS.
- **HMAC attestation (MNR-1)**: `encodeAttestationMessage` (`routes/solana-escrow.ts:86-88`)
  length-prefixed (`${remittanceId.length}:${remittanceId}${sender}`) — inyectivo,
  evita colisión `("a:b","c")` vs `("a","b:c")`. `computeReleaseAttestation` es la
  ÚNICA fuente (SSOT) para server y cliente. `verifyReleaseAttestation`
  (línea 108-121) usa `timingSafeEqual` con chequeo de longitud previo (evita
  excepción de `timingSafeEqual` en buffers de distinto tamaño) y `secret===undefined
  || secret.length===0 → false` (fail-closed sin secreto). Tests
  `route.release.test.ts:297,304,310` (no-colisión, determinismo, boundaries
  distintas → HMACs distintos) PASS.
- **Key/opt-in-off**: `getReleaseAuthorityKeypair`/`ReleaseAuthorityKeyError`
  (`solana-release-authority.ts:45-104`) — el error SIEMPRE lleva el NOMBRE de la
  env, nunca el valor; sin `grep` de la key en logs (`app.log.info`/`warn` en la
  ruta solo loguean `request_id`, `error_code`, `http_status`, `facilitator_key_id`,
  `duration_ms` — nunca el keypair/tx/state). `isReleaseEnabled()` gatea el registro
  de la ruta en `app.ts:410` — sin flag+key válida, la ruta NO se registra → 404
  natural. Confirmado por `route.release.optin.test.ts:71,77,84` (los 3 casos de
  opt-in-off → 404) + `:93` (EVM `/health` sigue 200).

## Drift

Acotado a los archivos de 13b/13c — sin desvío de scope. `git diff --stat` vs la
base `feat/027-wkh-217-solana-feepayer-sponsorship` muestra únicamente:
`src/chains/solana-escrow.ts`, `src/chains/escrow-idl.ts`, `src/infra/solana-release-authority.ts`,
`src/infra/solana-escrow-release-dedup.ts`, `src/methods/solana-escrow/{build-release,cr1-release,release-shape}.ts`,
`src/routes/solana-escrow.ts`, `supabase/migrations/004_*.sql`, `src/app.ts` (+10
líneas de registro opt-in), tests nuevos, `auto-blindaje.md`, `package.json`/
`package-lock.json`. Todos dentro del Scope IN de la HU (work-item §Scope IN,
`wasiai-facilitator/src/chains/solana-adapter.ts` o módulo hermano + `src/infra/`).
Único hallazgo NO de scope-drift sino de git-hygiene: ver bloqueante arriba.

## Gates (confirmados + re-verificados puntualmente)

- `npm run qa` (typecheck+lint+format+test) corrido por mí: exit 0 en las 4 etapas,
  979/979 tests PASS (incluye el untracked). tsc y eslint también corridos
  individualmente (`npx tsc --noEmit` exit 0, `eslint src/ --max-warnings 0` exit 0)
  para confirmar que el hallazgo bloqueante es SOLO de tracking git, no de calidad
  de código.
- AR: APROBADO (10 vectores, 0 BLQ, 2 MNR resueltos en fix-pack) — leído del
  contexto del orquestador, no re-ejecutado.
- CR: APROBADO (0 BLQ / 0 MNR) — leído del contexto del orquestador, no re-ejecutado.

## Veredicto

**RECHAZADO PARA DONE** — no por un AC en FAIL (los 4 ACs facilitator-side tienen
evidencia PASS sólida, con Checks anti-drain verificados línea por línea) ni por
un gate rojo, sino porque el commit real (`cbf8ca7`) **no contiene** 16 de los
979 tests reportados — específicamente los que cubren el vector más crítico de
esta HU (CR-1 anti-drain de la release-authority). Un merge a `main` en este
estado pierde esa cobertura silenciosamente.

**Acción requerida antes de re-someter a F4**: `git add
src/__tests__/unit/cr1-release.test.ts` + 1 commit de fix-pack. No requiere
volver a F3/AR/CR — es puramente un commit faltante, no un cambio de código o
diseño. Tras el commit, re-confirmar `git show --stat <nuevo-commit>` incluye el
archivo y `npm run qa` sigue en 979/979 con el working tree limpio (`git status`
sin untracked).
