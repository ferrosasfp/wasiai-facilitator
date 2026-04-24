# Report — HU [WFAC-33] Audit log inmutable (`facilitator_audit_log`)

**Status**: DONE  
**Date Closed**: 2026-04-24  
**PR**: #22 (merged via squash, commit 949c0d5)  
**Branch**: feat/014-wfac-33-audit-log

---

## Resumen ejecutivo

WFAC-33 implementó `facilitator_audit_log`, tabla Supabase append-only que registra el ciclo de vida HTTP de requests públicos (`/verify`, `/settle`, `/supported`) vía Fastify `onResponse` hook global. Fire-and-forget design, nunca bloquea al caller. PR #22 squash-merged a main (949c0d5). **403/403 tests passing** (369 baseline + 34 nuevos); **100% coverage en audit.ts**. AR + CR ambos aprobados sin bloqueantes; 7 MENORs diferidos (2 post-merge documentation, 5 auto-blindaje de tooling). Operador debe aplicar migration Supabase `002_facilitator_audit_log.sql` vía `supabase db push` antes de go-live.

---

## Pipeline ejecutado

- **F0**: project-context disponible en `.nexus/project-context.md` ✓
- **F1**: work-item.md (WFAC-33 SDD 014) generado por `nexus-analyst` ✓
- **F2**: sdd.md (QUALITY mode, full scope) completado, SPEC_APPROVED ✓
- **F2.5**: story-HU-33.md (5 waves: W1 DDL → W5 OWNERS boundary update) ✓
- **F3**: Implementación 5 waves (W1 SQL → W5 OWNERS documentation)
  - W1: Migration DDL `002_facilitator_audit_log.sql` (60 LOC, append-only table + 3 indexes + DDL comments)
  - W2: `src/core/audit.ts` módulo (163 LOC, module augmentation + AuditEntry builder + fire-and-forget persistor)
  - W3: App hook registration en `src/app.ts` + route touch-ups (settle.ts, verify.ts, supported.ts, health.ts, openapi.ts)
  - W4: Unit + integration tests `audit.test.ts` + route test updates (17 nuevos unit tests)
  - W5: OWNERS.md actualizado con boundary documentation
  - **Archivos tocados**: 17 files, 3086 insertions(+), 2 deletions(-)
  - **Tests baseline**: 369 → 403 final (34 nuevos; 100% coverage on audit.ts) ✓
- **AR**: Adversarial Review ejecutado por `nexus-adversary`
  - **BLOQUEANTEs**: 0 detectados
  - **MENORs** (7 total, post-implementation):
    - MNR-1: Auto-blindaje W4 — test assumption sobre shape de `idempotencyKey` (prefixed vs raw hex) → documentado en auto-blindaje.md, non-blocking
    - MNR-2: Auto-blindaje W4 — light-my-request default UA behavior → documentado en auto-blindaje.md, non-blocking
    - [5 adicionales logged en auto-blindaje.md, todos recomendaciones futuras]
  - **Veredicto final**: APROBADO (sin fixes post-merge requeridos)
- **CR**: Code Review ejecutado por `nexus-adversary` post-AR
  - **Hallazgos**: 0 bloqueantes (all CDs + security patterns honored)
  - **Veredicto**: APROBADO
- **F4**: QA + validation ejecutado por `nexus-qa`
  - 14/14 ACs verificados con evidencia archivo:línea
  - 14/14 CDs verificados
  - **Veredicto**: APROBADO

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Notas |
|----|--------|-----------|-------|
| AC-1 | PASS | `src/core/audit.ts:56-62`, `src/app.ts:114-135` (hook `onResponse` calls `buildAuditEntry` con request_id, method, path, status_code, duration_ms) | W2/W3: hook capture transport metadata en `onResponse` post-flush |
| AC-2 | PASS | `src/app.ts:119-121` (filtro `AUDIT_EXCLUDED_PATHS.has(path)` excluye `/health` y `/openapi.json`) | W3: lista negra explícita de exclusion, fail-safe por default audita nuevas rutas |
| AC-3 | PASS | `src/core/audit.ts:144-162` (try/catch wrapper, no-op si `getSupabaseClient()` retorna null) | W2: si Supabase no configurado, silent skip sin error propagation |
| AC-4 | PASS | `src/app.ts:124-128` (extrae primer elemento de `X-Forwarded-For` header, split-aware) | W3: proxy-aware IP extraction, consultar primeiro header del CSV |
| AC-5 | PASS | `src/app.ts:129-131` (fallback a `request.ip` si XFF ausente) | W3: direct socket IP cuando proxy header no presente |
| AC-6 | PASS | `src/core/audit.ts:71-73` (truncate `ipRaw` a 45 chars en `buildAuditEntry`) | W2: defense-in-depth, DB VARCHAR(45) rechazaría overflow |
| AC-7 | PASS | `src/core/audit.ts:74-80` (truncate `userAgentRaw` a 512 chars en builder) | W2: max length 512 antes de persist |
| AC-8 | PASS | `src/core/audit.ts:74-80` (si `userAgentRaw` empty/null, output `user_agent: null`) | W2: null coercion para ausencia de header |
| AC-9 | PASS | `src/core/audit.ts:144-162` (fire-and-forget: `await persistAuditEntry` en hook post-flush; builder + insert son O(1)) | W2/W3: AC-9 cumplido porque hook ejecuta post-response flush, persist nunca agrega latencia observable |
| AC-10 | PASS | `src/core/audit.ts:155-162` (try/catch total: DB error → logger.warn, return sin throw) | W2: error swallowing pattern, no error propagation al caller |
| AC-11 | PASS | `supabase/migrations/002_facilitator_audit_log.sql:1-60` (NO triggers, NO UPDATE/DELETE permitidos; grep confirms `src/core/audit.ts` solo emite INSERT) | W1: DDL append-only by convention, no RLS (pending WKH-SEC-0X) |
| AC-12 | PASS | `src/routes/settle.ts:95` + `src/app.ts:133-134` (ruta setea `request.auditMeta.idempotencyKey` con valor prefixed `settle:idempotency:...`, hook lee y persiste) | W3/W4: idempotency key linkage vía decorador de request |
| AC-13 | PASS | `src/routes/verify.ts:76,118,147` + `src/routes/settle.ts:100,127,169` (rutas setean `request.auditMeta.errorCode` ANTES de reply.send en paths 4xx/5xx), `src/app.ts:133` (hook lee y persiste) | W3: error code capture en route handlers, propagado vía decorador |
| AC-14 | PASS | `supabase/migrations/002_facilitator_audit_log.sql:47-50` (COMMENT ON TABLE incluye string "90d" y referencia TD-RETENTION-01) | W1: DDL documenta intención de retention, cron externo (future HU) |

**Total**: 14/14 ACs PASS.

---

## Constraint Directives verificados (14 total)

| CD | Verificación | Evidencia |
|----|--------------|-----------|
| CD-1 | Fire-and-forget fail-open: DB error NUNCA bloquea respuesta | `src/core/audit.ts:155-162` try/catch, swallow-all + logger.warn |
| CD-2 | Prohibido UPDATE/DELETE en facilitator_audit_log desde audit.ts | `src/core/audit.ts` audit-tree grep: solo `.insert()`, no `.upsert()` ni `onConflict` |
| CD-3 | Prohibido import directo de @supabase/supabase-js en audit.ts | `src/core/audit.ts:7` imports solo `getSupabaseClient`, no `@supabase/supabase-js` |
| CD-4 | Prohibido loguear ip/user_agent en application logs (PII) | `src/core/audit.ts:159` logger payload: solo `request_id`, `path`, `err`, nunca `ip`/`user_agent` |
| CD-5 | Prohibido console.* en audit.ts | `src/core/audit.ts` grep: no `console.` calls anywhere |
| CD-6 | Obligatorio filtrar /health y /openapi.json en hook vía request.routeOptions.url | `src/app.ts:119-121` AUDIT_EXCLUDED_PATHS set, uses `request.routeOptions.url` |
| CD-7 | buildAuditEntry pure function (sin side effects, sin logger) | `src/core/audit.ts:56-62` signature, no logger parameter, pure builder |
| CD-8 | Truncation ip→45 y user_agent→512 en buildAuditEntry ANTES de persistAuditEntry | `src/core/audit.ts:71-80` truncation logic en builder, fields ya truncados al persistir |
| CD-9 | Prohibido lógica x402/chainId/amount en audit.ts | `src/core/audit.ts` grep: no import chains/methods, no business logic, solo observability |
| CD-10 | Prettier run antes de commit (auto-blindaje WFAC-22/23) | All 17 files run through prettier; format:check green en pre-merge |
| CD-11 | Routes DEBEN setear request.auditMeta.errorCode en CADA path de error ANTES del reply.send | `src/routes/verify.ts:76,118,147` + `src/routes/settle.ts:100,127,169` verificados en tests |
| CD-12 | Hook usa request.routeOptions.url (path declarado), NO request.url (con query string) | `src/app.ts:119` uses `request.routeOptions.url`, no `.url` |
| CD-13 | AuditEntry NO incluye timestamp field, DB genera vía DEFAULT NOW() | `src/core/audit.ts:43-52` interface AuditEntry: no `timestamp` field |
| CD-14 | Hook puede `await persistAuditEntry` sin restricciones (Fastify v5 post-flush execution) | `src/app.ts:135` `await persistAuditEntry(...)` directo, safe post-response |

---

## Hallazgos finales

### BLOQUEANTEs (resueltos)

**Ninguno detectado durante AR/CR phases.** Auto-blindaje post-merge identificó 2 notas (no bloqueantes) sobre assumptions de tests:

1. **Auto-blindaje W4**: idempotencyKey shape — tests asumían 64-char hex; implementación prefixea con `settle:idempotency:` (83 chars total). Documentado en auto-blindaje.md para futuras HUs que joineen audit ↔ settlements.
2. **Auto-blindaje W4**: light-my-request default UA — inyecta `'lightMyRequest'` cuando no hay header. Tests adaptados para ejercitar la rama `null-UA` via `headers: { 'user-agent': '' }` explícitamente.

### MENORs (aceptados como deuda o documentados)

1. **MNR-1** (Auto-blindaje): idempotencyKey shape documentation
   - **Action**: Documentado en auto-blindaje.md §2; no code change requerido. Lectores futuros sabrán que el audit row contiene la key prefixada, no raw hex.

2. **MNR-2** (Auto-blindaje): light-my-request behavior documentation
   - **Action**: Documentado en auto-blindaje.md §3; tests ya adaptados.

3. **MNR-3** (Post-merge documentation): RLS ainda no implementado
   - **Action**: DDL COMMENT referencia WKH-SEC-0X pending. RLS será implementado en HU separada (Scope OUT ya documentado).

4. **MNR-4** (Post-merge documentation): Retention cron pendiente
   - **Action**: DDL COMMENT referencia TD-RETENTION-01 (cron externo no en esta HU).

5. **MNR-5..7** (Auto-blindaje notes): Recomendaciones futuras
   - Documentadas en auto-blindaje.md para uso en próximas HUs que toquen audit/ledger/routes.

---

## Auto-Blindaje consolidado

Errores detectados durante F3 implementación y cómo prevenirlos en futuras HUs:

### Patrón 1: Test assumption sobre idempotencyKey shape (W4, post-WFAC-32 idempotency refactor)

**Error**: Tests T-AR-1, T-AR-2, T-AR-4 asserting `idempotencyKey` como raw 64-char hex via `/^[0-9a-f]{64}$/`.  
**Causa raíz**: `buildSettleIdempotencyKey(parsed)` retorna **full Redis cache key** `settle:idempotency:<sha256-hex>` (83 chars), no el raw hex. Valor propagado al audit row via `request.auditMeta.idempotencyKey` en `src/routes/settle.ts:95`.  
**Fix**: Tests adaptan assertion a `settle:idempotency:` prefix + 64-hex suffix. Production audit rows contienen la prefixed key (matching ledger.ts line ~111 que también almacena el valor prefixado).  
**Aplicar en**: Cualquier future HU joining audit ↔ settlements — aplicar same transformation en ambos lados.

### Patrón 2: light-my-request default user-agent behavior (W4, Fastify inject transport)

**Error**: T-AR-8 esperaba `userAgentRaw === null` cuando `app.inject()` omite `user-agent` header.  
**Causa raíz**: `light-my-request` (el transport mock de Fastify) inyecta literal default UA `'lightMyRequest'` cuando ningún header explícito es provided. No hay forma de inyectar genuino absence de header.  
**Fix**: Tests usan `headers: { 'user-agent': '' }` explícitamente para ejercitar rama null-UA. Production path (no UA header en request real) ya cubierto por unit tests pure de `buildAuditEntry`.  
**Aplicar en**: Any future route tests exercising null-header cases — preferir builder unit tests para null semántica; usar injection solo para validar propagation cuando UA SÍ está present o empty string.

### Patrón 3: Prettier discipline (recurrente WFAC-22, 23, 32, 33)

**Error**: Format:check falló pre-merge (line-break aesthetics).  
**Causa**: No correr `npx prettier --write` antes de commit.  
**Solución**: CD-10 obligatorio: `npx prettier --write <files>` para todo nuevo código antes de push.  
**Aplicar en**: TODAS las HUs futuras. Integrar en pre-commit hook o CI (pendiente).

### Patrón 4: OWNERS.md updates en cierre de HU (W5 checklist)

**Error**: Olvidar actualizar OWNERS.md con nuevo módulo `src/core/audit.ts`.  
**Causa**: No es parte del código productivo; fácil de olvidar.  
**Solución**: W5 Always verifica que nuevos módulos en `src/core/` o `src/infra/` se agregan a OWNERS.md con su boundary statement.  
**Aplicar en**: Any HU adding new modules — W5 checklist: "grep OWNERS.md para verificar que todos los nuevos paths están documentados".

---

## Métricas finales

| Métrica | Valor | Notas |
|---------|-------|-------|
| Tests baseline → final | 369 → 403 | +34 nuevos (audit.test.ts 17 + route integrations) |
| Coverage audit.ts | 100% | 163 LOC, vitest --coverage |
| Coverage supabase integration | 100% | persistAuditEntry paths todos exercitados |
| Arc branches covered | 14/14 | buildAuditEntry all code paths tested |
| Archivos modificados | 17 | DDL + core + app + routes + tests + docs + OWNERS |
| LOC added (net) | +3088 | supabase DDL 60 + audit.ts 163 + tests 322 + hooks/routes 287 + stories/docs 1900+ |
| Commit count | 1 squash | #22 merge (949c0d5) |
| AR bloqueantes | 0 | Auto-blindaje documented, non-blocking |
| CR hallazgos | 0 | All CDs honored |
| QA veredicto | APROBADO | 14/14 ACs, 14/14 CDs |

---

## Archivos modificados

**DDL & Infrastructure (W1)**
- `supabase/migrations/002_facilitator_audit_log.sql` [NEW, 60 LOC]

**Core Module (W2)**
- `src/core/audit.ts` [NEW, 163 LOC]

**App & Routes (W3)**
- `src/app.ts` [MODIFIED, +53 lines: onResponse hook + AUDIT_EXCLUDED_PATHS constant]
- `src/routes/settle.ts` [MODIFIED, +10 lines: auditMeta.idempotencyKey + errorCode population]
- `src/routes/verify.ts` [MODIFIED, +6 lines: auditMeta.errorCode population in error paths]

**Tests (W4)**
- `src/__tests__/unit/audit.test.ts` [NEW, 322 LOC: 17 test cases covering all ACs]
- `src/__tests__/unit/routes.settle.test.ts` [MODIFIED, +247 lines: audit hook integration tests]
- `src/__tests__/unit/routes.verify.test.ts` [MODIFIED, +147 lines: audit hook integration tests]
- `src/__tests__/unit/routes.supported.test.ts` [MODIFIED, +43 lines: hook should fire on /supported]
- `src/__tests__/unit/health.test.ts` [MODIFIED, +32 lines: hook should NOT fire on /health]
- `src/__tests__/unit/routes.openapi.test.ts` [MODIFIED, +31 lines: hook should NOT fire on /openapi.json]

**Boundaries (W5)**
- `OWNERS.md` [MODIFIED, +24 lines: document src/core/audit.ts boundary same as ledger.ts]

**Documentation**
- `doc/sdd/014-wfac-33-audit-log/work-item.md` [NEW, 173 LOC: WI definition]
- `doc/sdd/014-wfac-33-audit-log/sdd.md` [NEW, 636 LOC: full SDD]
- `doc/sdd/014-wfac-33-audit-log/story-HU-33.md` [NEW, 1125 LOC: developer story file]
- `doc/sdd/014-wfac-33-audit-log/auto-blindaje.md` [NEW, 15 LOC: post-implementation lessons]
- `doc/sdd/_INDEX.md` [MODIFIED, +1 line: entry 014 status DONE]

---

## Decisiones diferidas a backlog

1. **RLS (Row Level Security)** — Postgres-level protection pending separate HU (`WKH-SEC-0X`). Today: app-layer boundary enforcement via OWNERS + code review.
2. **Retention cron (90d purge)** — External task tracked as `TD-RETENTION-01`. DDL documents intent; cleanup scheduled for operator/DevOps.
3. **IP hashing / PII anonymization** — Out of scope. Operator responsible for GDPR/CCPA compliance at deployment layer.

---

## Lecciones para próximas HUs

1. **Auto-blindaje pattern: tooling discipline** — Prettier + ESLint + typecheck ANTES de merge. Integrar en pre-commit hook para evitar surprises en CI.

2. **Test inject transport quirks** — light-my-request has opinionated defaults (e.g., UA injection). Document via unit tests; prefer pure builder tests para semantics edge cases.

3. **Decorador de request coupling** — Fastify module augmentation es powerful pero requiere tipo-safe propagation. Usar `declare module 'fastify'` early; tests deben validar que las rutas populan antes de `reply.send()`.

4. **Fire-and-forget error handling** — Always wrap `getXClient()` + `.operation()` en mismo try/catch. SDK getters pueden lanzar exception sincrónica (URL validation, SDK init).

5. **Append-only enforcement** — Convention + OWNERS boundary (hoy). RLS vendrá después. Documentar intent en DDL COMMENTs para future DBA context.

6. **Documentation for operators** — DDL COMMENTs son el único spec que el operator ve en prod. Ser explícito: PII retention, external crons, RLS pending, etc.

---

## Next Steps para Operator

1. **Apply migration 002 locally + dev:**
   ```bash
   supabase db push  # Applies migration to Supabase remote
   ```

2. **Verify table in Supabase:**
   ```sql
   SELECT * FROM facilitator_audit_log LIMIT 0;  -- check schema
   \d facilitator_audit_log                       -- verify indexes
   ```

3. **Deploy code** (PR #22 already merged to main).

4. **Monitor audit table growth** (new rows on each request to public endpoints).

5. **Schedule retention cron** (future HU `TD-RETENTION-01`):
   ```sql
   -- Not yet implemented; placeholder for operator planning:
   DELETE FROM facilitator_audit_log WHERE timestamp < NOW() - INTERVAL '90 days';
   ```

---

## Verification Checklist

- [x] All 14 ACs verified with archivo:línea evidence
- [x] All 14 CDs verified
- [x] 403/403 tests passing (100% coverage audit.ts)
- [x] PR #22 merged (commit 949c0d5)
- [x] Branch `feat/014-wfac-33-audit-log` merged to main
- [x] `npm run qa` green (typecheck + lint + format:check + test)
- [x] OWNERS.md updated
- [x] Auto-blindaje consolidated in this report
- [x] AR + CR both APROBADO
- [x] F4 QA APROBADO
- [x] No blocking issues; 7 MINORs documented + non-blocking

---

## Sign-Off

**WFAC-33 is DONE.** Audit log infrastructure ready for production deployment. Operator must apply migration 002 and schedule future retention cron. No code changes or follow-up HUs are blocking go-live.

---

**Report generated**: 2026-04-24  
**Closed by**: nexus-docs  
**Status**: APROBADO para DONE ✓
