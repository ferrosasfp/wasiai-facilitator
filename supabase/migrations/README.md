# Supabase Migrations — wasiai-facilitator

Convenciones de migraciones para el Supabase dedicated del facilitator.
Adopción del patrón de `luma-ai` (numbered idempotent migrations).

---

## Convenciones (obligatorias)

1. **Numeración secuencial con padding**: `NNN_descripcion.sql`
   - `001_facilitator_settlements.sql`
   - `002_facilitator_audit_log.sql`
   - `003_facilitator_idempotency.sql`

2. **Idempotentes SIEMPRE**: toda migration debe poder re-correrse sin error.
   - `CREATE TABLE IF NOT EXISTS ...`
   - `CREATE INDEX IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
   - `DROP INDEX IF EXISTS ...` (antes de recrear)

3. **Una migration = un objetivo lógico**. No mezclar "crear tabla X" con "agregar columna a Y".

4. **Orden ascendente inmutable**: NUNCA renombrar, borrar, ni intercalar una migration ya pusheada.
   Si hay que revertir, crear una nueva migration que haga el rollback.

5. **Naming de tablas**: prefix `facilitator_` en todas las tablas propias (evita colisión
   cross-project si Supabase org se comparte en el futuro).

6. **RLS**:
   - V1: OFF (service_key-only access desde el backend Node)
   - Post-V1: ON con policies cuando expongamos API pública o UI directa

7. **Foreign keys**: opcional en V1 — preferimos JOINs lógicos controlados desde el servicio
   (performance) + referential integrity via unique constraints + checks.

---

## Ejecución

```bash
# Aplicar localmente (requiere Supabase CLI + proyecto linkeado)
supabase db push

# Aplicar a prod (vía CI/CD)
supabase db push --linked

# Crear nueva migration
supabase migration new <nombre_descriptivo>
```

---

## Migrations en el repo

Esta tabla lista lo que HAY en `supabase/migrations/`, no lo que se planeó. Antes
llegaba hasta la 003 y en el disco ya había siete archivos, así que un lector se
llevaba la impresión de que el escrow y el payout no tenían nada en la base.

⚠️ **Este repo NO lleva un registro de despliegue.** No hay forma de saber desde acá
qué corrió contra qué base; lo único verificable es lo que cada archivo dice de sí
mismo. La columna "Lo que declara el archivo" es exactamente eso — una cita, no un
estado confirmado. Para el estado real hay que preguntarle a la base.

| # | Archivo | Tabla | Lo que declara el archivo |
|---|---------|-------|---------------------------|
| 001 | `001_facilitator_settlements.sql` | `facilitator_settlements` | nada sobre despliegue |
| 002 | `002_facilitator_audit_log.sql` | `facilitator_audit_log` | nada sobre despliegue |
| 003 | `003_facilitator_solana_dedup.sql` | `facilitator_solana_settlements` | nada sobre despliegue |
| 004 | `004_facilitator_solana_release_dedup.sql` | `facilitator_solana_release_claims` | aplicada — se deduce de la 006, que le agrega columnas a esta misma tabla |
| 005 | `005_facilitator_solana_payouts.sql` | `facilitator_solana_payouts` | `PENDING-DEPLOY (founder-gated)` |
| 006 | `006_facilitator_solana_release_claim_lease.sql` | `facilitator_solana_release_claims` (+`claimed_at`, `status`) | `Aplicada a bdwv el 2026-08-04, ANTES del merge del código` |
| 006 | `006_..._lease_down.sql` | rollback de la 006 | es el `_down` de la anterior; sólo se corre para revertir |
| 007 | `007_facilitator_solana_release_claim_signature.sql` | `facilitator_solana_release_claims` (+`signature`, `recent_blockhash`) | `NO aplicar: la aplica el founder` |

Notas de estado:

- La base de DESARROLLO es **bdwv**, que es contra la que corre el facilitator hoy.
  NUNCA `caldz`.
- La **007 va ANTES de desplegar su código**, igual que la 006 y por el mismo motivo:
  `markReleaseSigned` es un `UPDATE`, y un `UPDATE` que nombra una columna inexistente
  devuelve error ⇒ `{ ok:false }` ⇒ el primitivo no transmite ⇒ ningún release sale.
  Al revés (migración primero, código después) no rompe nada: las columnas nuevas son
  nullable y el código viejo no las escribe.
- Toda migración cuya primera línea diga `-- NO aplicar: la aplica el founder` es una
  acción gateada: NO la corras vos.

Schemas de referencia documentados en `.nexus/project-context.md` sección "Tablas DB".

---

*Última actualización: 2026-08-05 — la tabla lista las migraciones reales (llegaba hasta la 003 con siete archivos en el disco)*
