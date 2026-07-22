# F4 Validation — HU-SOL-6 / WKH-205 (adaptador Solana verify+dedup)

**Veredicto: APROBADO PARA DONE** · 2026-07-21 · branch `feat/026-wkh-205-solana-adapter` @ `fabaa63`

## Runtime (evidencia propia del QA)
- `npm run qa` → typecheck 0 + eslint 0 + prettier + **873 tests / 61 files PASS**.
- DB dev (`bdwvrwzvsldephfibmuu`): `PGRST205 — table 'facilitator_solana_settlements' not found` → confirma migración 003 **PENDING-DEPLOY** (no aplicada); sin la tabla, el dedup falla-CLOSED (`{ok:false}` → `TRANSACTION_FAILED`), nunca aceptación silenciosa.

## Acceptance Criteria (6/6 PASS)
| AC | Veredicto | Evidencia |
|----|-----------|-----------|
| AC-1 mint exacto + program-id pin | PASS | `solana-adapter.ts:257-273` + tests T-SOL-2 (mint clonado), T-SOL-3 (Token-2022) |
| AC-2 monto por delta neto | PASS | `solana-adapter.ts:275-290` + T-SOL-4 (compensatoria → delta neto < esperado → INVALID_AMOUNT) |
| AC-3 precisión BigInt | PASS | `solana-adapter.ts:280-282` (`BigInt`, nunca uiAmount) + T-SOL-5 (u64 max) + T-SOL-5b (borde 2^53) |
| AC-4 dedup durable fail-CLOSED | PASS | `solana-dedup.ts:73-161` + `003:12` UNIQUE(signature) + T-SOL-7/8/10/11 + 4 tests de dedup |
| AC-5 commitment finalized | PASS | `solana-adapter.ts:210-212` + T-SOL-6 |
| AC-6 no-regresión EVM + opt-in-off | PASS | factory→null sin env (`:419-430`), registro condicional (`index.ts:45`); 849 EVM sin tocar assertions |

## Fix-pack (3 MENORes) verificado
- FIX-1 (destino owner+mint+program) — no debilita el fail-safe (mint/program pin de abajo intactos).
- FIX-2 (ledger persiste delta real) — gate `delta >= expected` sin tocar.
- FIX-3 (test T-SOL-5b precisión 2^53) — rechaza correctamente.
Ningún constraint de seguridad debilitado; `X402ErrorCode` sin cambios.

## Drift: NONE
`git diff main...HEAD --name-only` = solo archivos de HU-SOL-6 (adapter, dedup, migración 003, registry, index, env, OWNERS, tests, docs). `routes/*`/`core/*` intactos. Migración 003 PENDING-DEPLOY. Boundary OWNERS [5] documentado.

**Listo para DONE.** (AR: APROBADO 8 vectores; CR: APROBADO; verdictos autoritativos provistos por el orquestador — los adversarios reportan al orquestador, no a archivo, patrón de esta sesión.)
