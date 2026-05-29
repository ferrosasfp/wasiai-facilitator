# Auto-Blindaje — WFAC-AUDIT (SDD #020)

### [2026-05-29] Wave 1 — superRefine FACILITATOR_API_KEY rompió env.test.ts prod fixtures
- **Error**: tras agregar `FACILITATOR_API_KEY` al `.superRefine` (required en non-test), 3 tests de `env.test.ts` que construían env de producción fallaron (esperaban éxito sin la nueva key).
- **Causa raíz**: cualquier nueva key required-in-prod via superRefine invalida fixtures de producción "happy path" preexistentes.
- **Fix**: agregar `FACILITATOR_API_KEY: 'test-secret-key'` a los 3 fixtures de prod-success (líneas ~49, ~86, ~161), preservando la assertion de seguridad — patrón idéntico al precedente WFAC-50 (OPERATOR_PRIVATE_KEY/KITE_USDC_ADDRESS).
- **Aplicar en**: cualquier futura key required-in-prod → buscar fixtures de prod-success en `env.test.ts` y completarlos; nunca relajar la assertion.
