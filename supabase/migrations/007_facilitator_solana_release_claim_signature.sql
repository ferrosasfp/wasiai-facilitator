-- NO aplicar: la aplica el founder (accion gated, classifier)
-- supabase/migrations/007_facilitator_solana_release_claim_signature.sql
-- El claim del escrow release guarda la FIRMA y el BLOCKHASH de la tx que firmo.
-- Va contra bdwv (NUNCA caldz). Idempotente: safe to re-run.
--
-- ORDEN: ESTA MIGRACION VA **ANTES** DE DESPLEGAR EL CODIGO QUE LA USA.
-- Mismo motivo que la 006: `markReleaseSigned` es un UPDATE, y un UPDATE que nombra
-- una columna inexistente devuelve error -> `{ ok:false }` -> el primitivo NO transmite
-- y contesta SPONSOR_PERSIST_FAILED. Con el codigo desplegado antes que esta migracion,
-- TODO release falla en su primer intento y queda con el claim escrito. Al reves (esta
-- migracion primero, codigo despues) no rompe nada: las dos columnas nuevas son NULLABLE
-- y el codigo viejo simplemente no las escribe.
--
-- QUE ARREGLA. Hoy la unica huella de un release es la respuesta HTTP. La firma se
-- devuelve en el body y NO queda en ningun lado nuestro: la tabla no tiene columna, y el
-- logger REDACTA el campo `signature` (src/infra/logger.ts, lista REDACT_FIELDS). Si esa
-- respuesta se pierde (timeout del cliente, proceso reiniciado, sonda post-envio que no
-- pudo preguntar), nadie puede reconstruir QUE transaccion se firmo ni si aterrizo.
--
-- Es la misma pieza que `facilitator_solana_payouts` (005) ya tiene y usa: ahi la firma
-- persistida es lo que permite, ante una duda, ir a preguntarle a la cadena en vez de
-- adivinar. Sin ella, "no se" no tiene como dejar de ser "no se".
--
-- QUE **NO** AFIRMA UNA FILA CON FIRMA. Que la tx existe y se firmo, nada mas. NO dice
-- que se transmitio, y menos que aterrizo. La direccion util es la contraria y es la que
-- sostiene el invariante I2 del payout: una fila SIN firma prueba que no se transmitio
-- nada, porque la firma se escribe entre `partialSign` y `serialize`, o sea antes de que
-- la tx pueda existir para el cluster.

ALTER TABLE facilitator_solana_release_claims
  ADD COLUMN IF NOT EXISTS signature TEXT;

ALTER TABLE facilitator_solana_release_claims
  ADD COLUMN IF NOT EXISTS recent_blockhash TEXT;

COMMENT ON COLUMN facilitator_solana_release_claims.signature IS
  'Firma base58 de la tx de release, escrita entre partialSign y serialize (antes de cualquier envio). NULL = no se firmo nada para esta fila, y eso SI prueba que no se transmitio. NO-NULL prueba que la tx existe; no dice que aterrizo.';
COMMENT ON COLUMN facilitator_solana_release_claims.recent_blockhash IS
  'Blockhash con el que se firmo. Sirve para acotar la ventana en que esa tx pudo entrar: un blockhash muerto prueba que ya no puede aterrizar DE ACA EN ADELANTE, nunca que no haya aterrizado antes (eso solo lo responde la cadena).';
