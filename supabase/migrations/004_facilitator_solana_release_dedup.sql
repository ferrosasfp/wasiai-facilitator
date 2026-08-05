-- supabase/migrations/004_facilitator_solana_release_dedup.sql
-- WKH-216 / HU-SOL-13 (Wave 13c) — Anti-replay durable del escrow `release` (AC-5 / CD-9).
-- YA CORRIO contra la base de desarrollo (bdwv). Decia "PENDING-DEPLOY, NO aplicar" y
-- eso ya no puede ser cierto: la `006` declara haberse aplicado a bdwv el 2026-08-04 y
-- es un `ALTER TABLE` sobre ESTA tabla, que sobre una tabla inexistente habria errado.
-- Un "no aplicar" que sobrevive a su propio cutover entrena a leer los avisos como
-- ruido, justo en la carpeta donde el aviso importa.
-- El estado declarado de cada migracion esta en supabase/migrations/README.md; este
-- repo NO lleva registro de despliegue, asi que lo de arriba es una DEDUCCION, no una
-- confirmacion de la base.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Barrera dura anti-doble-release: UNIQUE(escrow_pda). El facilitator co-firma+broadcastea
-- un `release` para un escrow AT MOST once, aun bajo requests concurrentes. El flip on-chain
-- de `status` a Released (verificado en 13b) es la verdad del money-path; esta tabla es el
-- guard local PRE-firma que evita un doble broadcast ANTES de que ese flip sea observable.
-- Fail-CLOSED en app-layer (src/infra/solana-escrow-release-dedup.ts). Sin PII.
-- Tabla facilitator-GLOBAL (sin owner_ref, igual que facilitator_solana_settlements — CD-8 N/A).

CREATE TABLE IF NOT EXISTS facilitator_solana_release_claims (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_pda    TEXT        NOT NULL UNIQUE,   -- PDA base58 escrow_state (barrera at-most-once)
  sender        TEXT        NOT NULL,          -- depositor pubkey base58 (seed del PDA)
  remittance_id TEXT        NOT NULL,          -- id de la remesa (trazabilidad server-only)
  network       TEXT        NOT NULL,          -- 'solana:devnet' | 'solana:mainnet'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fsrc_created_at ON facilitator_solana_release_claims (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fsrc_network    ON facilitator_solana_release_claims (network);

COMMENT ON TABLE  facilitator_solana_release_claims IS
  'WKH-216: claim durable del escrow release (UNIQUE escrow_pda) — anti-doble-firma/broadcast. Fail-CLOSED app-layer. No PII.';
COMMENT ON COLUMN facilitator_solana_release_claims.escrow_pda IS
  'PDA base58 de escrow_state. UNIQUE = barrera anti-replay pre-firma (el status on-chain flip es la verdad final).';
