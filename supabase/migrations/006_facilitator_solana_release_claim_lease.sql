-- NO aplicar: la aplica el founder (accion gated, classifier)
-- supabase/migrations/006_facilitator_solana_release_claim_lease.sql
-- WKH-BLQ release-claim-lease — el claim del escrow release deja de ser PERMANENTE.
-- Va contra bdwv (NUNCA caldz). Idempotente: safe to re-run.
--
-- 🔴 ORDEN: ESTA MIGRACION VA **ANTES** DE DESPLEGAR EL CODIGO DEL LEASE.
-- Al reves rompe TODOS los releases: `markReleaseSigned` erra por columna
-- inexistente -> SPONSOR_PERSIST_FAILED, y el `steal` tampoco puede correr, asi
-- que cada escrow queda trabado en su primer intento. O sea: exactamente el bug
-- que este arreglo viene a cerrar, disparado antes de tiempo y para todos.
-- El `_down` avisaba del orden inverso; este `_up` no decia nada. Lo encontro el
-- AR (BLQ-BAJO-1). Aplicada a bdwv el 2026-08-04, ANTES del merge del codigo.
--
-- QUE ARREGLA. `004` creo la tabla con UNIQUE(escrow_pda) y SIN ninguna nocion de
-- expiracion, y la ruta escribe el claim ANTES de pedir blockhash / firmar / transmitir.
-- Cualquier fallo posterior al INSERT (un hipo del RPC en getLatestBlockhash alcanza)
-- dejaba el escrow IRRELEASEABLE PARA SIEMPRE: el reintento choca con el UNIQUE (23505),
-- la app lo lee como replay y contesta 409 hasta el fin de los tiempos. Con la ventana de
-- custodia en 2 horas y el release disparado a mano, el beneficiario no cobraba nunca.
--
-- COMO. Se agrega un LEASE (mismo patron que facilitator_solana_payouts / 005):
--   * `claimed_at` — base del lease. Un claim mas viejo que SOLANA_ESCROW_RELEASE_LEASE_MS
--     puede ser tomado por un reintento (UPDATE condicional, un solo write).
--   * `status`     — 'claimed' -> 'signed'. La transicion es la CERCA de un solo disparo:
--     entre dos requests que sobreviven al lease, exactamente una logra pasar a 'signed'
--     y solo esa transmite (la otra recibe ok:false y NO broadcastea).
--
-- LA FILA NUNCA SE BORRA. `UNIQUE(escrow_pda)` sigue siendo la barrera at-most-once y no
-- hay DELETE en ningun lado: el lease no la afloja, la hace RECUPERABLE. Robar un claim es
-- seguro por dos pruebas independientes que se exigen JUNTAS:
--   (1) el lease se re-ancla al instante de la FIRMA (renewReleaseClaimLease corre entre
--       partialSign y serialize), y su piso configurable supera la vida de un blockhash
--       (~150 slots), asi que una tx firmada hace mas de un lease YA NO PUEDE aterrizar; y
--   (2) la ruta re-lee el estado on-chain en la MISMA invocacion y corta con 409 si el
--       escrow ya figura `Released` — o sea que una tx anterior que SI aterrizo se detecta
--       antes de llegar al robo.
--
-- BACKFILL. `claimed_at` se rellena desde `created_at` (no desde NOW()) para que la historia
-- sea honesta. Efecto buscado: todo claim viejo y trabado queda inmediatamente recuperable,
-- que es exactamente el bug que esta migracion viene a destrabar.

ALTER TABLE facilitator_solana_release_claims
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE facilitator_solana_release_claims
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'claimed';

-- Historia honesta: el lease de una fila preexistente arranca cuando se creo, no cuando
-- corrio esta migracion. Idempotente (el WHERE no matchea en la segunda corrida).
UPDATE facilitator_solana_release_claims
   SET claimed_at = created_at
 WHERE claimed_at > created_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'facilitator_solana_release_claims_status_check'
  ) THEN
    ALTER TABLE facilitator_solana_release_claims
      ADD CONSTRAINT facilitator_solana_release_claims_status_check
      CHECK (status IN ('claimed','signed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fsrc_claimed_at
  ON facilitator_solana_release_claims (claimed_at DESC);

COMMENT ON COLUMN facilitator_solana_release_claims.claimed_at IS
  'Base del lease: un claim mas viejo que SOLANA_ESCROW_RELEASE_LEASE_MS puede ser tomado por un reintento (UPDATE condicional). Se re-ancla en la FIRMA, no solo en el claim, para que el lease mida desde el unico instante a partir del cual pudo existir un broadcast.';
COMMENT ON COLUMN facilitator_solana_release_claims.status IS
  'claimed -> signed. La transicion a signed es la cerca de un solo disparo: de dos requests que sobrevivieron al lease, exactamente una la gana y SOLO esa transmite. La fila nunca se borra; UNIQUE(escrow_pda) sigue siendo la barrera at-most-once.';
