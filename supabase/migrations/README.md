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

## Migrations planeadas (stubs — implementación en épica E4 observability)

| # | Archivo | Tabla | WFAC ticket |
|---|---------|-------|-------------|
| 001 | `001_facilitator_settlements.sql` | `facilitator_settlements` | WFAC-32 |
| 002 | `002_facilitator_audit_log.sql` | `facilitator_audit_log` | WFAC-33 |
| 003 | `003_facilitator_idempotency.sql` | `facilitator_idempotency` | WFAC-32 |

Schemas de referencia documentados en `.nexus/project-context.md` sección "Tablas DB".

**NO escribir las SQL aquí** — son trabajo de F3 Dev dentro del pipeline NexusAgil
(WFAC-32 / WFAC-33). Este README es solo el contrato de convenciones.

---

*Última actualización: 2026-04-21 — adopción patrón luma-ai migrations*
