-- supabase/migrations/003_facilitator_solana_dedup.sql
-- WKH-205 / HU-SOL-6 — Durable anti-replay + settlement ledger para Solana verify-only.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Barrera dura anti-double-spend: UNIQUE(signature). A diferencia de EVM (nonce
-- on-chain revierte el replay), Solana verify-only NO tiene backstop on-chain →
-- este UNIQUE es la única línea de defensa (CD-4, fail-CLOSED en app-layer).
-- La tabla es DUAL: dedup mark + settlement ledger Solana (DT-5). Sin PII.

CREATE TABLE IF NOT EXISTS facilitator_solana_settlements (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  signature   TEXT          NOT NULL UNIQUE,   -- firma base58 de la tx (id inmutable on-chain)
  network     TEXT          NOT NULL,          -- 'solana:devnet' | 'solana:mainnet'
  reference   TEXT          NULL,              -- Solana Pay reference (pubkey base58), opcional
  mint        TEXT          NOT NULL,          -- SPL mint pubkey base58 (== SOLANA_USDC_MINT)
  pay_to      TEXT          NOT NULL,          -- owner/ATA destino (pubkey base58)
  amount      NUMERIC(78,0) NOT NULL,          -- delta neto atomic u64 (uint256-safe; leer con ::text — CD-9)
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fss_created_at ON facilitator_solana_settlements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fss_network    ON facilitator_solana_settlements (network);
CREATE INDEX IF NOT EXISTS idx_fss_reference  ON facilitator_solana_settlements (reference)
  WHERE reference IS NOT NULL;

COMMENT ON TABLE  facilitator_solana_settlements IS
  'WKH-205: dedup durable (UNIQUE signature) + settlement ledger Solana verify-only. Fail-CLOSED app-layer. No PII.';
COMMENT ON COLUMN facilitator_solana_settlements.signature IS
  'Firma base58 de la tx Solana. UNIQUE = barrera anti-replay (no hay nonce on-chain que la sustituya).';
COMMENT ON COLUMN facilitator_solana_settlements.amount IS
  'Delta neto atomic (u64). NUMERIC(78,0). Leer SIEMPRE con ::text cast (precision-loss >2^53 — WKH-196).';
