-- supabase/migrations/002_facilitator_audit_log.sql
-- WFAC-33 — Audit log inmutable para HTTP lifecycle del facilitator.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Diferencia vs 001_facilitator_settlements.sql:
--   - Append-only (sin UNIQUE ni ON CONFLICT de negocio).
--   - Contiene PII (ip, user_agent) — retention 90d vía cron separado (TD-RETENTION-01).
--   - NO CHECK constraints cross-field (no hay discriminated union status/error).
--   - TIMESTAMPTZ es la primera columna "de negocio" y se indexa DESC (casos de uso
--     forense iteran por fecha descendente).

CREATE TABLE IF NOT EXISTS facilitator_audit_log (
  -- Identity (UUID interna; no idempotency_key como PK porque no es unique aquí).
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Temporal
  timestamp        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Transport
  request_id       TEXT          NOT NULL,                  -- Fastify request.id (UUID-like)
  method           TEXT          NOT NULL,                  -- 'GET' | 'POST' | ... (upper-case)
  path             TEXT          NOT NULL,                  -- route path ('/verify', '/settle', '/supported')
  status_code      INTEGER       NOT NULL,                  -- 200 / 400 / 402 / 500 / ...
  duration_ms      INTEGER       NOT NULL,                  -- reply.elapsedTime rounded

  -- PII (retention 90d — TD-RETENTION-01)
  ip               VARCHAR(45)   NULL,                      -- IPv4 or IPv6 max length; NULL if undetectable
  user_agent       VARCHAR(512)  NULL,                      -- truncated at 512 chars; NULL if absent

  -- Linkage
  error_code       TEXT          NULL,                      -- X402ErrorCode | 'INVALID_PAYLOAD' | NULL
  idempotency_key  TEXT          NULL                       -- sha256 hex (64 chars) — only set on /settle
);

-- Indexes
-- Primary forensic query: "last N requests" → timestamp DESC.
CREATE INDEX IF NOT EXISTS idx_fal_timestamp
  ON facilitator_audit_log (timestamp DESC);

-- Secondary: "all 4xx/5xx in window" → status_code filter.
CREATE INDEX IF NOT EXISTS idx_fal_status_code
  ON facilitator_audit_log (status_code);

-- Sparse: join with facilitator_settlements via idempotency_key (partial index
-- because most rows /verify + /supported leave this NULL).
CREATE INDEX IF NOT EXISTS idx_fal_idempotency_key
  ON facilitator_audit_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Comments (document intent for DBA / future ops).
COMMENT ON TABLE  facilitator_audit_log IS
  'WFAC-33: append-only HTTP audit trail for /verify, /settle, /supported. Contains PII (ip, user_agent). Retention 90d via external cron (TD-RETENTION-01, not implemented in this HU). NO UPDATE or DELETE from application code (enforced by OWNERS + code boundary; Postgres RLS pending WKH-SEC-0X).';
COMMENT ON COLUMN facilitator_audit_log.ip IS
  'Client IP. Extracted from X-Forwarded-For header (first element) or request.ip fallback. Truncated to 45 chars (IPv6 max). PII — purge after 90d.';
COMMENT ON COLUMN facilitator_audit_log.user_agent IS
  'HTTP User-Agent header. Truncated to 512 chars. NULL if header absent/empty. PII — purge after 90d.';
COMMENT ON COLUMN facilitator_audit_log.idempotency_key IS
  'Links to facilitator_settlements.idempotency_key for /settle requests. sha256 hex (64 chars). NULL for /verify and /supported.';
COMMENT ON COLUMN facilitator_audit_log.error_code IS
  'x402 error code (INVALID_SIGNATURE, INSUFFICIENT_BALANCE, etc.) or literal "INVALID_PAYLOAD" for Zod failures. NULL on 2xx responses.';
