-- supabase/migrations/005_facilitator_solana_payouts.sql
-- WKH-302 — Ledger durable del payout SPL que ORIGINA el facilitator (AC-5 / AC-9 / CD-7).
-- PENDING-DEPLOY (founder-gated): NO aplicar hasta el cutover de la wallet de payout.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Máquina de estados claimed -> signed -> confirmed. UNIQUE(caller_key_id, intent_id)
-- es la barrera durable at-most-once: el facilitator firma+transmite un payout para un
-- (caller, intentId) COMO MUCHO una vez, aun bajo requests concurrentes. La partición por
-- caller impide que un caller squattee el intentId de otro (FACILITATOR_API_KEYS es multi-key).
--
-- Invariante I2: el broadcast ocurre SIEMPRE después de persistir firma + blockhash, así
-- que status='claimed' (sin firma) demuestra que no hay un broadcast VIVO. Fail-CLOSED en
-- app-layer (src/infra/solana-payout-ledger.ts). Sin PII.
-- Tabla facilitator-GLOBAL (sin owner_ref, igual que 003/004 — el guard de ownership no aplica).

CREATE TABLE IF NOT EXISTS facilitator_solana_payouts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_key_id    TEXT        NOT NULL,          -- request.facilitatorKeyId (sha256 truncado, NO secreto)
  intent_id        TEXT        NOT NULL,          -- provisto por el gateway (`${composeRunId}:${i}`)
  network          TEXT        NOT NULL,          -- 'solana:devnet' | 'solana:mainnet'
  pay_to           TEXT        NOT NULL,          -- owner del agente, base58
  mint             TEXT        NOT NULL,          -- base58
  amount_atomic    TEXT        NOT NULL,          -- TEXT, no NUMERIC/BIGINT — ver nota de precisión
  status           TEXT        NOT NULL DEFAULT 'claimed',
  signature        TEXT,                          -- NULL hasta 'signed'
  recent_blockhash TEXT,                          -- NULL hasta 'signed'
  attempts         INT         NOT NULL DEFAULT 1,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- base del lease (SOLANA_PAYOUT_LEASE_MS)
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT facilitator_solana_payouts_status_check
    CHECK (status IN ('claimed','signed','confirmed'))
);

-- Barrera at-most-once, particionada por caller.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fsp_caller_intent
  ON facilitator_solana_payouts (caller_key_id, intent_id);

-- Una misma firma no puede quedar registrada bajo dos intents (índice parcial).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fsp_signature
  ON facilitator_solana_payouts (signature) WHERE signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fsp_created_at ON facilitator_solana_payouts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fsp_network    ON facilitator_solana_payouts (network);

COMMENT ON TABLE  facilitator_solana_payouts IS
  'WKH-302: ledger durable del payout SPL originado por el facilitator (claimed/signed/confirmed). UNIQUE(caller_key_id,intent_id) = barrera at-most-once. Fail-CLOSED app-layer. No PII.';
COMMENT ON COLUMN facilitator_solana_payouts.amount_atomic IS
  'Unidades atómicas como TEXT (NO NUMERIC): lección WKH-196 — supabase-js lee NUMERIC(78,0) como número JSON y JSON.parse redondea por encima de 2^53. TEXT en la columna, BigInt en el código.';
COMMENT ON COLUMN facilitator_solana_payouts.status IS
  'claimed -> signed -> confirmed. Invariante I2: claimed (sin firma) ⇒ no hay broadcast vivo; el broadcast siempre ocurre DESPUÉS de persistir firma+blockhash.';
COMMENT ON COLUMN facilitator_solana_payouts.attempts IS
  'Diagnóstico solamente: HOY NO SE INCREMENTA. PostgREST toma VALORES y no expresiones, así que un attempts = attempts + 1 atómico necesitaría un read-modify-write (que invita una actualización perdida) o una función en la base, fuera del alcance de esta migración. Ninguna decisión de producción lo lee. Si algún día se necesita de verdad, va por una función en la base, no por leer-y-escribir desde la app.';
COMMENT ON COLUMN facilitator_solana_payouts.claimed_at IS
  'Base del lease: un claim más viejo que SOLANA_PAYOUT_LEASE_MS puede ser robado por stealStaleClaim (UPDATE condicional).';
