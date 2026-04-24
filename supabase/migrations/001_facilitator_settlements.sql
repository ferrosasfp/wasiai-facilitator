-- supabase/migrations/001_facilitator_settlements.sql
-- WFAC-32 — Settlement ledger for facilitator /settle persistence.
-- Idempotent: safe to re-run. Do not edit once pushed — create follow-up migration.

CREATE TABLE IF NOT EXISTS facilitator_settlements (
  -- Identity
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT           NOT NULL UNIQUE,   -- sha256 hex (64 chars)

  -- Result
  status            TEXT           NOT NULL CHECK (status IN ('success', 'failed')),

  -- Blockchain (NULLABLE for status='failed')
  tx_hash           TEXT           NULL,
  block_number      BIGINT         NULL,

  -- x402 fields (always present)
  network           TEXT           NOT NULL,                   -- 'eip155:<chainId>'
  method            TEXT           NOT NULL,                   -- 'eip3009' | 'permit2' | 'erc7710'
  asset             TEXT           NOT NULL,                   -- token address 0x...
  amount            NUMERIC(78, 0) NOT NULL,                   -- atomic uint256 (fits 2^256)
  payer             TEXT           NOT NULL,                   -- 0x address (from)
  payee             TEXT           NOT NULL,                   -- 0x address (to)

  -- Error (NULL for status='success')
  error_code        TEXT           NULL,                       -- X402ErrorCode literal or NULL
  error_http        INTEGER        NULL,                       -- 400/401/402/412/500 or NULL

  -- Technical
  duration_ms       INTEGER        NOT NULL,                   -- Date.now() - startMs

  -- Timestamps
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  -- Cross-field invariants
  CONSTRAINT success_has_tx CHECK (
    (status = 'success' AND tx_hash IS NOT NULL AND block_number IS NOT NULL
      AND error_code IS NULL AND error_http IS NULL)
    OR
    (status = 'failed'  AND error_code IS NOT NULL AND error_http IS NOT NULL)
  )
);

-- Indexes (non-unique — the UNIQUE on idempotency_key lives in the table constraint)
CREATE INDEX IF NOT EXISTS idx_fs_created_at ON facilitator_settlements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_network    ON facilitator_settlements (network);
CREATE INDEX IF NOT EXISTS idx_fs_status     ON facilitator_settlements (status);

-- Optional: composite index for common dashboard query (network + date range)
CREATE INDEX IF NOT EXISTS idx_fs_network_created_at
  ON facilitator_settlements (network, created_at DESC);

COMMENT ON TABLE  facilitator_settlements IS
  'WFAC-32: per-settlement ledger. Fire-and-forget from src/routes/settle.ts. No PII.';
COMMENT ON COLUMN facilitator_settlements.idempotency_key IS
  'SHA-256 hex (64 chars) of canonical-JSON(parsed body). Matches Redis key (sans prefix).';
COMMENT ON COLUMN facilitator_settlements.amount IS
  'Atomic units (uint256). Use NUMERIC(78,0) to fit 2^256-1 without precision loss.';
