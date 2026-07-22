# Report — HU-SOL-6 / WKH-205: Adaptador Solana del facilitator (verify + dedup)

**Status: DONE (2026-07-21) · HELD** · branch `feat/026-wkh-205-solana-adapter` @ `fabaa63` (impl+fix-pack) · NO mergeada (facilitator prod/Railway).

## Resumen
Registra detrás de la interfaz `SettlementAdapter` (HU-SOL-2) el adaptador concreto que verifica una tx Solana confirmada, para que `solana:devnet`/`solana:mainnet` dejen de responder `CHAIN_UNAVAILABLE`. Verify-only (la wallet del cliente auto-envía; el facilitator verifica + deduplica). Opt-in-off por default.

**Entrega:** 6/6 ACs PASS · **873 tests** (849 EVM byte-idénticos + 24 nuevos) · AR (8 vectores) + CR APROBADOS + fix-pack de 3 MENORes + F4 APROBADO. `X402ErrorCode` sin cambios, routes/core intactos.

## Acceptance Criteria (evidencia archivo:línea en validation.md)
- AC-1 mint-pubkey EXACTO + program-id pin (anti token falso / Token-2022).
- AC-2 monto por **delta neto** pre/postTokenBalances (no "one transfer"; anti compensatoria).
- AC-3 precisión **BigInt** end-to-end (nunca Number/uiAmount; u64 > 2^53).
- AC-4 dedup durable **fail-CLOSED** vía `UNIQUE(signature)` Postgres (no fail-open como EVM).
- AC-5 `commitment:'finalized'` explícito.
- AC-6 no-regresión EVM (opt-in-off; getAdapter EVM O(1) preservado por narrowing `_isChainAdapter`).

## Cadena de gates
HU_APPROVED → SPEC_APPROVED → F2.5 Story File → F3 (873 tests) → **AR** APROBADO (8 vectores de verificación de dinero: mint falso, monto gameado, precisión, replay/dedup fail-CLOSED, finalized, receiver, registry/regresión, X402ErrorCode) → **CR** APROBADO → **fix-pack** (destino owner+mint+program, ledger persiste delta real, test precisión 2^53) → **F4 QA** APROBADO (6/6, drift NONE) → DONE (HELD).

## Diseño clave
`SolanaAdapter implements SettlementAdapter`; dedup durable = tabla `facilitator_solana_settlements` con `UNIQUE(signature)` (`infra/solana-dedup.ts` fail-CLOSED, boundary OWNERS [5]); registry generalizado a `Map<string, SettlementAdapter>`; reuso puro de códigos x402.

## Archivos
Creados: `src/chains/solana-adapter.ts`, `src/infra/solana-dedup.ts`, `supabase/migrations/003_facilitator_solana_dedup.sql`, 2 test files. Modificados: `registry.ts`, `chains/index.ts`, `infra/env.ts`, `OWNERS.md`, `package.json`/lock.

## Activación / follow-ups (para el founder)
1. **Migración 003 PENDING-DEPLOY**: aplicar `003_facilitator_solana_dedup.sql` a la DB del facilitator ANTES de habilitar Solana (sin la tabla el dedup rechaza todo settle Solana). Acción gated del founder.
2. **Env opt-in**: Solana solo se registra con `SOLANA_RPC_URL` + `SOLANA_USDC_MINT` seteadas. Por default OFF.
3. **Wire-format HTTP Solana** (follow-up HU-SOL-9/13): el schema Zod HTTP no representa aún un request Solana (asset/payTo 0x-hex); el adapter está completo + unit-tested pero no HTTP-reachable e2e hasta ese wire-format.
4. **Diferidos MENORes** (a la HU de wire-format): CR-MNR-2 (cluster por substring → env `SOLANA_CLUSTER`); AR-MNR-2 (flag `degraded` global con Solana ON → excluir adapters no-EVM de `anyChainDown`).

## Pendiente (orquestador)
Merge de la branch a `main` + deploy Railway + aplicación de la migración = decisión de integración de cierre de Sprint 2 (facilitator es prod).
