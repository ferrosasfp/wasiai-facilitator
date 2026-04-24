# Work Item — [WFAC-33] Audit log inmutable (facilitator_audit_log)

## Resumen

Se construye `facilitator_audit_log`, una tabla Supabase append-only que registra el ciclo de vida HTTP de cada request al API público del facilitator (`/verify`, `/settle`, `/supported`). Distinto de `facilitator_settlements` (WFAC-32), este log captura metadatos de transporte (IP, user-agent, status code, duración) con fines de seguridad/forense y compliance, no de reconciliación on-chain. Contiene PII (IP, user-agent) y requiere retention policy de 90 días. El registro se realiza vía Fastify `onResponse` hook global, fire-and-forget — nunca bloquea al caller.

---

## Diferencia WFAC-32 vs WFAC-33

| Aspecto | facilitator_settlements (WFAC-32) | facilitator_audit_log (WFAC-33) |
|---------|-----------------------------------|----------------------------------|
| Foco | Transacciones on-chain (tx_hash, amount) | Request HTTP lifecycle (IP, user-agent, headers) |
| Mutabilidad | UPSERT con conflict no-op | INSERT puro, append-only |
| PII | NO (solo addresses públicas) | SI (IP, user-agent — retention 90d) |
| Scope | Solo /settle | Todos los endpoints públicos (/verify, /settle, /supported) |
| Uso | Reconciliación on-chain, métricas | Seguridad/forense, rate-limit debugging, compliance |
| Retention | Permanente | 90 días (cron separado, fuera de scope WFAC-33) |

---

## Sizing

- SDD_MODE: full
- Estimación: M
- Pipeline: QUALITY
- Branch sugerido: `feat/014-wfac-33-audit-log`

---

## Acceptance Criteria (EARS)

### Hook y cobertura de rutas

- **AC-1**: WHEN a request to `/verify`, `/settle`, or `/supported` completes (response sent), the system SHALL insert one row into `facilitator_audit_log` capturing `request_id`, `timestamp`, `method`, `path`, `status_code`, and `duration_ms`.

- **AC-2**: WHEN a request to any route not covered by the audit hook (`/health`, `/metrics`) completes, the system SHALL NOT insert a row into `facilitator_audit_log`.

- **AC-3**: WHILE Supabase is unavailable or unconfigured (`getSupabaseClient()` returns `null`), the system SHALL skip the audit insert silently without affecting the HTTP response.

### IP capture

- **AC-4**: WHEN the `X-Forwarded-For` header is present in the request, the system SHALL store the first IP in that header as `ip` in `facilitator_audit_log` (proxy-aware extraction).

- **AC-5**: WHEN the `X-Forwarded-For` header is absent, the system SHALL store `request.ip` (Fastify's direct socket IP) as `ip` in `facilitator_audit_log`.

- **AC-6**: IF the extracted IP string exceeds 45 characters (max IPv6 literal), THEN the system SHALL truncate to 45 characters before persisting.

### User-Agent

- **AC-7**: WHEN the `User-Agent` header is present, the system SHALL store up to 512 characters of its value as `user_agent` in `facilitator_audit_log`.

- **AC-8**: WHEN the `User-Agent` header is absent or empty, the system SHALL store `null` as `user_agent` in `facilitator_audit_log`.

### Fire-and-forget / non-blocking

- **AC-9**: WHILE the audit INSERT is executing, the system SHALL have already sent the HTTP response to the caller — the INSERT MUST NOT add latency to the response path.

- **AC-10**: IF the audit INSERT throws or returns a Supabase error, THEN the system SHALL log at `warn` level (including the error object) and continue — it SHALL NOT propagate the error nor affect the Fastify request lifecycle.

### DDL append-only invariant

- **AC-11**: WHEN the Postgres migration `002_facilitator_audit_log.sql` is applied, the table SHALL have no UPDATE-capable triggers and no application code path that issues `UPDATE` or `DELETE` statements against `facilitator_audit_log` (enforced by OWNERS boundary and DDL comments; NOT enforced by Postgres RLS in this release).

### idempotency_key linkage

- **AC-12**: WHEN the request includes an idempotency key (present in `/settle` flow), the system SHALL store it as `idempotency_key` (nullable TEXT) in `facilitator_audit_log`, linking the audit row to `facilitator_settlements`.

### error_code capture

- **AC-13**: WHEN the response status code is not 2xx and an x402 error code is available in the response body, the system SHALL store it as `error_code` (nullable TEXT) in `facilitator_audit_log`.

### Retention awareness (DDL only)

- **AC-14**: WHEN the migration `002_facilitator_audit_log.sql` is applied, the table SHALL include a `COMMENT ON TABLE` documenting the 90-day retention intent and referencing the separate cron task (not yet implemented) that will execute the DELETE.

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `supabase/migrations/002_facilitator_audit_log.sql` | Nueva tabla append-only con índices y comentarios |
| `src/core/audit.ts` | Módulo nuevo: `AuditEntry` interface, `buildAuditEntry()`, `persistAuditEntry()` — patrón análogo a `src/core/ledger.ts` |
| `src/app.ts` | Registrar hook global `onResponse` que llama `persistAuditEntry` fire-and-forget para las 3 rutas públicas |
| `src/__tests__/unit/audit.test.ts` | Tests unitarios: `buildAuditEntry`, `persistAuditEntry` no-op, truncation, null user-agent |
| `OWNERS.md` | Actualizar matriz: `src/core/audit.ts` sigue el mismo boundary que `src/core/ledger.ts` |
| `doc/sdd/014-wfac-33-audit-log/` | Artefactos SDD de esta HU |

---

## Scope OUT

| Artefacto | Razón |
|-----------|-------|
| Dashboard de audit log | Fuera de scope — UI separada o queries Supabase directas |
| Alertas / anomaly detection | Consumidor del log, no parte de su producción |
| Cron de retention (DELETE después de 90d) | Tarea separada; el DDL documenta la intención solamente |
| RLS (Row Level Security) en `facilitator_audit_log` | Análogo a WKH-SEC-02 para settlements; pendiente ticket propio |
| `/health` y `/metrics` hook | Rutas internas no públicas, excluidas explícitamente |
| PII anonymization / hashing de IP | [NEEDS CLARIFICATION] — la HU indica captura directa; si el compliance requiere hashing, es scope separado |
| Consentimiento legal de storage de PII | [NEEDS CLARIFICATION] — asumimos que el operator/deployer es responsable de cumplimiento GDPR/CCPA |
| Modificar rutas existentes (`/verify`, `/settle`, `/supported`) | El hook es global en `app.ts`, no dentro de cada route |

---

## Decisiones técnicas

- **DT-1: `onResponse` hook global vs `preHandler` por route** — Se elige `onResponse` registrado en `app.ts` (global para las 3 rutas públicas). `onResponse` dispara después de que el response fue enviado al cliente, garantizando que el INSERT nunca bloquea la latencia observable. `preHandler` dispara antes, lo que haría el audit logging parte crítica del path de respuesta — incorrecto para este caso. El hook filtra por `request.routeOptions.url` para excluir `/health` y `/metrics`.

- **DT-2: IP detrás de proxy (X-Forwarded-For)** — Railway (el PaaS de producción) inyecta `X-Forwarded-For`. Se extrae el primer elemento del header (cliente original) y se trunca a 45 chars (máximo IPv6). Fastify v5 no tiene `trustProxy` configurado por defecto en este proyecto; el audit extrae el header manualmente desde `request.headers['x-forwarded-for']` para no requerir cambios de configuración globales.

- **DT-3: `user_agent` max length** — Se trunca a 512 caracteres antes de persistir (VARCHAR(512) en DDL). Suficiente para todos los browsers/SDK user-agents conocidos; previene inyección de strings largos que inflen el almacenamiento.

- **DT-4: Patrón de módulo** — `src/core/audit.ts` es análogo a `src/core/ledger.ts`: exports `AuditEntry` (interface), `buildAuditEntry()` (pure function), `persistAuditEntry()` (fire-and-forget, fail-open). El cliente Supabase se accede SOLO vía `getSupabaseClient()` desde `src/infra/supabase.ts` — no se importa `@supabase/supabase-js` directamente en `src/core/`.

- **DT-5: Cómo el hook obtiene el `error_code`** — El `onResponse` hook tiene acceso al `reply.statusCode` pero NO al body ya enviado (Fastify no expone el body serializado en `onResponse`). Estrategia: el hook lee un decorador de request `request.auditMeta` (objeto plano con `error_code` e `idempotency_key` opcionales) que las rutas populan antes de enviar. El decorador es un objeto `{ errorCode?: string; idempotencyKey?: string }` inicializado en `null` / `undefined` por el hook `onRequest`. Esto evita parsear el response body.

- **DT-6: Decorador de request vs payload parsing** — Alternativa descartada: parsear el response body en `onResponse`. No es posible en Fastify v5 sin interceptar el stream (costoso). El decorador de request es la solución idiomática de Fastify para pasar contexto desde handlers hacia hooks downstream.

---

## Constraint Directives (CD)

- **CD-1**: PROHIBIDO que `persistAuditEntry` lance excepciones al caller. Todo error path MUST ser capturado internamente y logueado a `warn`. Mismo contrato que `persistLedgerEntry` (WFAC-32 CD-1).

- **CD-2**: PROHIBIDO usar `UPDATE` o `DELETE` en `facilitator_audit_log` desde `src/core/audit.ts`. El módulo SOLO emite `INSERT` sin `onConflict` (tabla no tiene unique constraint de negocio — cada request genera un row nuevo).

- **CD-3**: PROHIBIDO importar `@supabase/supabase-js` directamente en `src/core/audit.ts`. Acceso SOLO via `getSupabaseClient()` de `src/infra/supabase.ts`.

- **CD-4**: PROHIBIDO loguear el valor de `user_agent` o `ip` en logs de aplicación (PII). El audit log persiste en DB; los logs de aplicación solo emiten `request_id` y resultado del INSERT.

- **CD-5**: PROHIBIDO usar `console.*` en `src/core/audit.ts`. OBLIGATORIO usar el logger inyectado.

- **CD-6**: OBLIGATORIO que el `onResponse` hook filtre por `request.routeOptions.url` y NO registre `/health` y `/metrics`. Un request a `/health` NO debe generar row en `facilitator_audit_log`.

- **CD-7**: OBLIGATORIO que `buildAuditEntry` sea una función pura (mismo input => mismo output, sin side effects). El acceso a Supabase solo ocurre en `persistAuditEntry`.

- **CD-8**: OBLIGATORIO que `ip` se truncate a 45 chars y `user_agent` a 512 chars en `buildAuditEntry` antes de llegar a `persistAuditEntry`.

- **CD-9**: PROHIBIDO agregar lógica de negocio x402 en `src/core/audit.ts`. Este módulo es infraestructura de observabilidad — no conoce chainId, amount, ni métodos EIP-3009.

---

## Waves sugeridas

| Wave | Descripción | Archivos |
|------|-------------|----------|
| W1 | DDL: `002_facilitator_audit_log.sql` con tabla, índices, comentarios retention | `supabase/migrations/002_facilitator_audit_log.sql` |
| W2 | Core: `src/core/audit.ts` — interface + pure builder + fire-and-forget persist | `src/core/audit.ts` |
| W3 | App: decorador de request + `onResponse` hook global en `src/app.ts` | `src/app.ts` |
| W4 | Tests: unit tests `audit.test.ts` (no-op, truncation, null user-agent, error swallow) | `src/__tests__/unit/audit.test.ts` |
| W5 | Cierre: OWNERS.md actualizado + validación E2E manual | `OWNERS.md` |

---

## Missing Inputs

| Tipo | Descripción |
|------|-------------|
| [NEEDS CLARIFICATION] | PII compliance scope: ¿el operator requiere hashing de IP antes de persistir (GDPR pseudonymization)? Asumido: captura directa, el operator es responsable de compliance. Si se requiere hashing, es una HU separada. |
| [NEEDS CLARIFICATION] | ¿El `onResponse` hook debe cubrir también `/openapi` (documentación)? Asumido: NO — solo las 3 rutas de negocio público. |
| [resuelto en F2] | Fastify request decorator typing (TypeScript augmentation de `FastifyRequest`) — el Architect decidirá el pattern exacto (module augmentation vs `declare module`). |
| [resuelto en F2] | Decidir si `idempotency_key` en el audit row se extrae del body (`request.body`) o del decorador. El body ya está parseado en el `onResponse` hook scope — posible leerlo desde `request.body` sin overhead extra. El Architect evaluará. |

---

## Análisis de paralelismo

- WFAC-33 NO bloquea ninguna HU activa conocida.
- WFAC-33 depende de WFAC-32 (Supabase singleton `src/infra/supabase.ts` ya mergeado en main).
- Puede correr en paralelo con HUs de chains o methods (no toca `src/chains/`, `src/methods/`).
- La branch `feat/013-wfac-32-settlement-ledger` figura como "in progress" en `_INDEX.md`; WFAC-33 parte desde `main` (commit `6fdc27b` indicado en el INPUT) asumiendo WFAC-32 mergeado.
