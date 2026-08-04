-- NO aplicar: la aplica el founder (accion gated, classifier)
-- supabase/migrations/006_facilitator_solana_release_claim_lease_down.sql
-- ROLLBACK de 006. Va contra bdwv (NUNCA caldz). Idempotente: safe to re-run.
--
-- ⚠️ ANTES DE CORRER ESTO: revertir tambien el codigo. Si las columnas desaparecen mientras
-- src/infra/solana-escrow-release-dedup.ts sigue desplegado, el UPDATE condicional del lease
-- falla y el modulo responde fail-CLOSED — o sea que NINGUN release sale. Es el lado seguro
-- (nunca paga de mas), pero deja el money-path detenido hasta el rollback del codigo.
--
-- Volver aca restaura el comportamiento de 004: el claim vuelve a ser PERMANENTE y un fallo
-- posterior al INSERT vuelve a dejar el escrow irreleaseable para siempre. Es un rollback, no
-- un arreglo alternativo.

DROP INDEX IF EXISTS idx_fsrc_claimed_at;

ALTER TABLE facilitator_solana_release_claims
  DROP CONSTRAINT IF EXISTS facilitator_solana_release_claims_status_check;

ALTER TABLE facilitator_solana_release_claims
  DROP COLUMN IF EXISTS status;

ALTER TABLE facilitator_solana_release_claims
  DROP COLUMN IF EXISTS claimed_at;
