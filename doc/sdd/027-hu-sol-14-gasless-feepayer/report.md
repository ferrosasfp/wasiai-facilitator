# Report — HU-SOL-14 / WKH-217: Gasless Fee-Payer Sponsorship Solana (CR-1 anti-drain)

**Status**: DONE (HELD — sin merge a `main`, opt-in-off, devnet-only)
**Fecha**: 2026-07-22
**Branch**: `feat/027-wkh-217-solana-feepayer-sponsorship` @ `6670fa9`
**Deps**: stacked sobre `feat/026-wkh-205-solana-adapter` (WKH-205 / HU-SOL-6, HELD)

## Resumen ejecutivo

El facilitator co-firma como fee-payer + broadcastea la tx `deposit` que la wallet del usuario arma+partial-firma (gasless para usuarios sin SOL). Antes de firmar, **reconstruye y valida la tx (CR-1, fail-closed)**: el fee-payer NUNCA firma un blob opaco. La primitiva `cosignAndBroadcast` + el contrato `SponsorTxValidator` se diseñan **reusables** — HU-SOL-13c escribe su `validateReleaseForSponsor` y reusa el resto sin tocar la primitiva. **Aditivo puro**: el relayer EVM (EIP-3009, `OPERATOR_PRIVATE_KEY`) queda byte-idéntico. **Opt-in-off**: sin `SOLANA_FEE_PAYER_SPONSOR_ENABLED=true` + key parseable, la ruta no se registra (404).

## Pipeline y veredictos

- **F3**: 923 tests (873 base + 50 nuevos), tsc 0, eslint `--max-warnings 0`.
- **AR**: APROBADO — drain del fee-payer cerrado y verificado empíricamente (Check 5). 1 MENOR (daily-cap over-count).
- **CR**: APROBADO — primitiva bien desacoplada (HU-SOL-13 la reusa). 5 MENORes.
- **Fix-pack**: AR-MNR-1 (compensación `onFeeReleased`, el CHECK sigue pre-sign) + CR-MNR-3/4 (tests versioned/v0 + fee-payer no-sender) + CR-MNR-1/5/2 (tipos + log). **933 tests**.
- **F4 QA**: APROBADO PARA DONE (HELD) — 10/10 ACs PASS, anti-drain verificado, caps fail-closed, EVM byte-idéntico, key nunca logueada, drift NONE.

## Acceptance Criteria (10/10 PASS — evidencia en validation.md)

| AC | Evidencia clave |
|----|-----------------|
| AC-1 sponsor happy path | `cr1.test.ts:122-137` (T1) + `route.test.ts` (T18, 200 `{signature}`) |
| AC-2 rechazo tx no-esperada | `cr1.ts:78-96` + `cr1.test.ts:140-181` (T2/T3/T4) |
| AC-3 fee-payer nunca source/authority | `cr1.ts:175-186` (Check 5) + `cr1.test.ts:184-227` (T5/T6/CR-MNR-4) |
| AC-4 blockhash + ComputeBudget acotados | `cr1.ts:98-131` + `broadcast.test.ts` (T11) |
| AC-5 concurrencia sin colisión | `broadcast.ts:180-203` (`runExclusive`) + `broadcast.test.ts` (T12) |
| AC-6 rate + daily fail-closed | `solana-sponsor-cap.ts:46-118` + `cap.test.ts` |
| AC-7 PoP antes de parsear | `routes/solana-sponsor.ts:118-121` + `route.test.ts` (T17) |
| AC-8 rent lo paga el sender | subsumido Check 5 + `cr1.test.ts:210-215` (T7) |
| AC-9 EVM byte-idéntico | `git diff` cero archivos EVM + 933 tests sin re-assertion (T21) |
| AC-10 key desde env, no logueada | `solana-fee-payer.ts:89` + `logger.ts:41-43` redaction + `route.test.ts:220-241` (T19) |

## Diseño clave

- **Primitiva reusable** `cosignAndBroadcast` (`broadcast.ts`) — NO conoce el `deposit`; recibe un `SponsorTxValidator` inyectado. HU-SOL-13c inyecta `validateReleaseForSponsor` sin tocarla.
- **CR-1** (`cr1.ts`, 6 checks fail-closed): la regla maestra (Check 5) rechaza el fee-payer en `keys` de CUALQUIER ix → subsume source/authority/rent.
- **Anti-abuso fail-CLOSED** (`solana-sponsor-cap.ts`): rate + daily-cap de SOL; el CHECK es pre-sign, la contabilidad se compensa (`onFeeReleased`) en desenlaces sin gasto on-chain.
- **Concurrencia**: mutex FIFO (`runExclusive`, sentinel `-1`) + `lastValidBlockHeight` + rebroadcast acotado.

## Archivos

**Nuevos (8)**: `src/infra/solana-fee-payer.ts`, `src/methods/solana-sponsor/{broadcast,cr1,deposit-shape,pop}.ts`, `src/core/solana-sponsor-cap.ts`, `src/routes/solana-sponsor.ts` + 5 tests.
**Modificados aditivos (3)**: `src/app.ts`, `src/infra/env.ts`, `src/infra/logger.ts`.

## Follow-ups para el founder

1. **HELD — activación founder-gated**: merge a `main` del facilitator + deploy Railway + envs (`SOLANA_FEE_PAYER_PRIVATE_KEY` JSON 64 bytes, `SOLANA_FEE_PAYER_SPONSOR_ENABLED=true`, `SOLANA_SPONSOR_POP_SECRET`, caps) + fondeo del wallet fee-payer con SOL devnet. **Orden de merge del facilitator: `026 (HU-SOL-6) → 027 (HU-SOL-14) → 13c`.**
2. **W3 companion chaski** (`POST /api/settle/sponsor-solana` + gateway thin) — pendiente en el repo chaski (candidato a agrupar con HU-SOL-13a o sub-HU).
3. **HU-SOL-13c** reusa la primitiva `cosignAndBroadcast` de esta HU.
