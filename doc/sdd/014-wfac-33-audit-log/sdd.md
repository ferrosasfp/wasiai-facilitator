# SDD — WFAC-33 Audit log inmutable (`facilitator_audit_log`)

- **Work Item:** `doc/sdd/014-wfac-33-audit-log/work-item.md`
- **Branch:** `feat/014-wfac-33-audit-log` (desde `main` post-WFAC-32)
- **SDD_MODE:** full
- **Pipeline:** QUALITY
- **Estimación:** M
- **Autor:** nexus-architect (F2)
- **Fecha:** 2026-04-23

---

## 0. Resumen ejecutivo

WFAC-33 introduce `facilitator_audit_log`, una tabla **append-only** en Supabase que registra
el ciclo de vida HTTP de cada request al API público del facilitator (`/verify`, `/settle`,
`/supported`). El registro se realiza vía **Fastify `onResponse` hook global** — fire-and-forget,
nunca bloquea al caller. El módulo `src/core/audit.ts` es un espejo estructural de
`src/core/ledger.ts` (WFAC-32): `AuditEntry` + `buildAuditEntry()` (pura) + `persistAuditEntry()`
(fail-open). El hook lee dos decoradores que las rutas populan sincronicamente antes de
`reply.send(...)` — `request.auditMeta.errorCode` y `request.auditMeta.idempotencyKey`.

Esta HU **no** implementa cron de retention, anonymization de PII ni RLS — están trackeados en
HUs separadas (Scope OUT).

---

## 1. Context Map — archivos leídos y patrones extraídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/core/ledger.ts` | Exemplar estructural directo de `src/core/audit.ts` | `export type XxxLogger = Pick<Logger, ...>`; `export interface XxxEntry`; pure `buildXxxEntry()` + fail-open `persistXxxEntry()` envuelto en try/catch total; no import de `@supabase/supabase-js`, solo via `getSupabaseClient()`; logger via argumento. |
| `src/infra/supabase.ts` | Singleton reusable post-WFAC-32 | `initSupabase(env, logger)` ya invocado en `app.ts:57`; `getSupabaseClient()` retorna `null` cuando SUPABASE_URL o SUPABASE_SERVICE_KEY faltan → fuerza el no-op (AC-3). |
| `src/app.ts` | Único punto de registro del hook global | `app.addHook('onClose', ...)` ya existe (línea 73). El nuevo `onRequest` + `onResponse` se registran antes o después sin tocar `buildApp` invariants. |
| `src/routes/verify.ts` | Ruta a auditar; confirma `request.id` y `request.body` están disponibles en handler | `request.id` es string (Fastify-generated UUID); el handler solo usa `request.body` post-Zod. |
| `src/routes/settle.ts` | La única ruta que calcula `idempotencyKey` | `buildSettleIdempotencyKey(parsed)` en línea 92. Este valor debe pasar al decorador `request.auditMeta.idempotencyKey` ANTES de `reply.send`. |
| `src/routes/supported.ts` | Ruta auditada sin idempotency ni error | Solo retorna 200 con shape `{chains, methods}`. `errorCode` e `idempotencyKey` quedan como `undefined`. |
| `src/routes/health.ts` | Ruta a EXCLUIR del audit | Registrada como `app.get('/health', ...)`. `request.routeOptions.url === '/health'`. |
| `src/routes/openapi.ts` | Ruta a EXCLUIR del audit (NC-2 resuelto) | Path registrado como `/openapi.json` (documento público estático). Evita ruido. |
| `supabase/migrations/001_facilitator_settlements.sql` | Exemplar DDL | Usa `CREATE TABLE IF NOT EXISTS`; `gen_random_uuid()`; `TIMESTAMPTZ NOT NULL DEFAULT NOW()`; índices con `IF NOT EXISTS`; `COMMENT ON TABLE` documenta intent. |
| `src/__tests__/unit/ledger.test.ts` | Exemplar de testing para `audit.test.ts` | `vi.mock('../../infra/supabase.js', ...)` con `upsertSpy`/`insertSpy` + `fromSpy`. Patrón Map-backed. |
| `src/__tests__/unit/supabase.test.ts` | Exemplar secundario | `vi.mock('@supabase/supabase-js', ...)` directo si se necesitara (NO se usa en audit.ts — access solo por infra wrapper). |
| `OWNERS.md` | Matriz de boundaries | `src/core/*` puede importar `src/infra/*`. `src/routes/*` puede importar `src/core/*`. Se agrega `audit.ts` al bloque "core". |
| `.nexus/project-context.md` | Stack + principios | Fastify v5.8, TS strict, sin PII en logs, sin `any`, discriminated union en core. |

### 1.1 Auto-Blindaje histórico aplicado (lecciones de HUs previas)

Leídos (últimas 3 HUs DONE):

- **WFAC-32 auto-blindaje** (2026-04-23): dos lecciones — (a) borrar una `let` no utilizada
  requiere `rg <name>` global antes de commit para cachear asignaciones huérfanas; (b) nunca
  poner literales realistas (tokens, hashes) en JSDoc por `no-secrets/no-secrets` ESLint.
- **WFAC-23 auto-blindaje** (2026-04-23): lookup dinámico por key en `Record<...>` requiere
  `// eslint-disable-next-line security/detect-object-injection` cuando la key viene del propio
  repo. Y: correr `prettier --write` antes de `format:check`.
- **WFAC-22 auto-blindaje** (2026-04-23): no asumir line-breaks "estéticos" — dejar que Prettier
  decida; correr `format:check` antes de commit.

**Patrones recurrentes detectados (≥2 HUs):** Prettier line-break discipline (WFAC-22 + WFAC-23).
→ Se agrega a Constraint Directives como **CD-10** (nuevo) en §5.2.

No hay patrón recurrente de bug lógico en WFAC-32/23/22 aplicable a WFAC-33 (los errores fueron
de tooling, no de semántica). El CD-10 sigue siendo obligatorio.

---

## 2. Architecture Decisions — resolución de 4 NEEDS CLARIFICATION

### DT-7 (nuevo) — PII hashing de IP: NO hashear (resuelve NC-1)

**Decisión:** la columna `ip` almacena el valor extraído crudo (IPv4 o IPv6, truncado a 45 chars).
No se hashea con SHA-256 ni otro mecanismo.

**Razón:**

1. **Scope del facilitator:** el facilitator es un componente de infraestructura. La responsabilidad
   de GDPR/CCPA compliance reside en el **operator/deployer** del servicio, quien debe publicar
   privacy policy, obtener consent, y configurar retention cron (fuera de esta HU).
2. **Transparencia forense:** hashear impide consultas por IP específica — exactamente el caso
   de uso primario del audit log (detectar abuso, rate-limit debugging, anomaly response).
   Un hash SHA-256 de una IP es recuperable por brute force en segundos (espacio de búsqueda
   IPv4 ≈ 2³²) → falsa sensación de anonimización sin valor real.
3. **Simplicidad:** agregar hashing implica decidir salt strategy (estático = recuperable;
   per-request = rompe agregaciones). Out of scope.
4. **Reversibilidad:** si el operator/PO requiere anonimización posterior, una HU separada
   puede introducir una migration (`ALTER TABLE facilitator_audit_log ADD COLUMN ip_hash TEXT`)
   sin disrupciones.

Si PO cambia requisito → HU separada (`WKH-SEC-0X`).

### DT-8 (nuevo) — Coverage de `/openapi.json`: NO auditar (resuelve NC-2)

**Decisión:** el hook filtra `/openapi.json` junto con `/health` (lista explícita de exclusión).

**Razón:**

1. **Documento público estático:** `/openapi.json` es consumido por herramientas (Swagger UI,
   code generators) en bulk, a menudo con polling automático. Auditarlo genera ruido sin
   valor forense.
2. **No contiene lógica de negocio:** su hit no indica actividad x402, solo discovery/docs.
3. **Consistencia con rate-limit:** las rutas de `/health` y `/openapi.json` típicamente se
   excluyen de rate-limit por la misma razón; el audit se alinea.

La lista explícita está definida en `src/app.ts` (no en `src/core/audit.ts`) — el core no
conoce nombres de rutas.

### DT-9 (nuevo) — Typing del request decorator: `declare module 'fastify'` (resuelve NC-3)

**Decisión:** se usa **module augmentation global** (`declare module 'fastify'`) para extender
`FastifyRequest` con un campo opcional `auditMeta`.

**Pattern:**

```ts
// src/core/audit.ts
declare module 'fastify' {
  interface FastifyRequest {
    auditMeta?: AuditMeta;
  }
}

export interface AuditMeta {
  readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD';
  readonly idempotencyKey?: string;
}
```

**Razón:**

1. **Idiomatic Fastify v5:** la guía oficial recomienda `declare module` para extender tipos
   globales en TS strict (ver plugin guide).
2. **Single source of truth:** el tipo `AuditMeta` vive en `src/core/audit.ts` junto con
   el código que lo consume (el hook). Las rutas solo leen el tipo por re-exportación
   cuando asignan.
3. **Alternativa descartada:** `app.decorateRequest('auditMeta', ...)` requiere inicialización
   en runtime + casts en cada handler — menos type-safe y más verboso.
4. **Opcionalidad (`?`):** el decorador es `undefined` por default. `/supported` nunca lo setea;
   `/verify` puede setearlo solo en path de error. El hook tolera `undefined`.

**Shape exacta de `AuditMeta`:**

| Campo | Tipo | Cuándo se setea |
|-------|------|-----------------|
| `errorCode` | `X402ErrorCode \| 'INVALID_PAYLOAD'` (opcional) | Rutas lo setean antes de `reply.code(4xx|5xx).send(...)`. En path 200, queda `undefined`. |
| `idempotencyKey` | `string` (opcional, sha256 hex 64 chars) | Solo `/settle` lo setea (tras `buildSettleIdempotencyKey(parsed)`). `/verify` y `/supported` lo dejan `undefined`. |

El tipo `X402ErrorCode` se importa type-only desde `src/core/types.ts`. El literal
`'INVALID_PAYLOAD'` es un superset local (definido en las routes como `VerifyRouteErrorCode`),
así que el union explícito lo cubre.

### DT-10 (nuevo) — Fuente de `idempotency_key` en el hook: del decorador (resuelve NC-4)

**Decisión:** el `onResponse` hook lee `request.auditMeta?.idempotencyKey`. **NO** se lee
`request.body.*` en el hook.

**Razón:**

1. **Consistencia con `error_code`:** ambos campos fluyen por el mismo canal (decorador).
   Evita divergencia conceptual.
2. **Desacoplamiento:** el hook NO conoce las reglas de cómo se construye la idempotency_key
   (SHA-256 de canonical JSON del body). Es el handler quien las sabe y la deposita explícitamente.
3. **Performance trivial:** leer el decorator es O(1); re-parsear `request.body` y recomputar
   el hash sería redundante con trabajo ya hecho en el handler.
4. **Testabilidad:** en tests unitarios de `audit.ts` no se necesita mockear body shape; basta
   setear `auditMeta` directamente en un request stub.

**Implementación en rutas:**

- En `src/routes/settle.ts`, tras `const idempotencyKey = buildSettleIdempotencyKey(parsed);`
  (línea 92 actual), se agrega `request.auditMeta = { ...request.auditMeta, idempotencyKey };`
  ANTES del primer `reply.send(...)`.
- En los paths de error (Zod failure, adapter-throw, result.ok=false), se agrega ANTES del
  `return reply.code(...).send(body)`: `request.auditMeta = { ...request.auditMeta, errorCode: '...' };`.
- `/verify` hace lo mismo para `errorCode` (sin `idempotencyKey`).
- `/supported` no toca `auditMeta`.

**CD nueva para esto:** CD-11 (ver §5.2).

### DT-11 (nuevo) — Filtro de rutas en el hook: lista blanca vs lista negra

**Decisión:** **lista negra** (`EXCLUDED_PATHS`) en `src/app.ts`, no lista blanca.

**Razón:**

1. **Fail-safe por cobertura:** si mañana se agrega `/refund` o `/webhooks/*`, el default es
   "auditar". La lista blanca generaría gap por omisión silenciosa.
2. **Principio: auditar todo lo público, excluir solo docs/health.** Es más defensivo.
3. **Simple:** el set es `new Set(['/health', '/openapi.json'])`.

El filtro usa `request.routeOptions.url` (path declarado, no `request.url` que incluye
query string).

### DT-12 (nuevo) — IP truncation ocurre en `buildAuditEntry` (no en el hook)

**Decisión:** `buildAuditEntry(input)` recibe IP cruda y trunca a 45 chars internamente.
El hook solo extrae la IP raw desde headers.

**Razón:**

1. **Pure function:** la truncation es parte del contrato de `AuditEntry` (CD-8 del work-item).
2. **Testabilidad:** tests de `buildAuditEntry` cubren truncation sin mockear Fastify.
3. **DRY:** si mañana se agrega otro consumer del builder, no se duplica lógica.

### DT-13 (nuevo) — INSERT sin `onConflict` (append-only)

**Decisión:** `persistAuditEntry` emite `.insert(entry)` puro. No `.upsert()`. No `onConflict`.

**Razón:**

1. **Append-only semantics:** cada request genera un row nuevo. No hay unique constraint de
   negocio — `idempotency_key` NO es unique aquí (solo informativo; dos requests idempotentes
   al /settle generan 2 rows en audit, uno por hit HTTP).
2. **CD-2 del work-item:** prohibe `UPDATE`/`DELETE`. El INSERT puro sin ON CONFLICT es la
   única operación.
3. **Retention via cron externo:** el borrado masivo post-90d lo hace un cron SEPARADO
   (out of scope WFAC-33). El módulo `audit.ts` solo inserta.

---

## 3. DDL completo — `supabase/migrations/002_facilitator_audit_log.sql`

```sql
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
```

**Notas de DDL:**

- **Append-only by convention:** no triggers de UPDATE/DELETE porque CD-2 del work-item lo prohibe
  en código. Postgres-level RLS pending (Scope OUT → HU separada `WKH-SEC-0X`).
- **`VARCHAR(45)` / `VARCHAR(512)`:** límites explícitos = defensa adicional ante bugs en el
  builder. Si el builder falla en truncar, Postgres rechaza con error `value too long for type
  character varying(N)`. El `persistAuditEntry` lo captura en su try/catch y loguea `warn` — no
  afecta al caller.
- **Tamaños de índices:** para 100k requests/día × 90d = ~9M rows. `idx_fal_timestamp` (~200MB)
  y `idx_fal_status_code` (~100MB) son aceptables. El partial `idx_fal_idempotency_key` es
  mucho más pequeño (~30% del total, solo /settle).
- **AC-14:** cumplido por `COMMENT ON TABLE` referenciando TD-RETENTION-01.

---

## 4. Waves de implementación

### W1 — DDL migration

**Archivos:**

- `supabase/migrations/002_facilitator_audit_log.sql` (NUEVO)

**Tareas:**

1. Crear el archivo con el DDL de §3 (verbatim).
2. Validación manual: aplicar en Supabase dev y verificar `SELECT COUNT(*) FROM facilitator_audit_log;` devuelve 0.
3. Verificar índices con `\d facilitator_audit_log` en psql.

**DoD:** archivo creado, DDL aplicado en dev, 0 rows iniciales.

### W2 — Core: `src/core/audit.ts`

**Archivos:**

- `src/core/audit.ts` (NUEVO)

**Tareas:**

1. Declarar module augmentation:
   ```ts
   declare module 'fastify' {
     interface FastifyRequest {
       auditMeta?: AuditMeta;
     }
   }
   ```
2. Exportar `AuditMeta` interface.
3. Exportar `AuditLogger = Pick<Logger, 'warn' | 'debug'>`.
4. Exportar `AuditEntry` interface (shape de row).
5. Exportar `BuildAuditEntryInput` interface (qué recibe el builder).
6. Implementar `buildAuditEntry(input): AuditEntry` — pure, incluye truncation (CD-8).
7. Implementar `persistAuditEntry(entry, logger): Promise<void>` — fail-open (CD-1), try/catch total, no-op si `getSupabaseClient()` es null, usa `.insert(entry)` sin onConflict (DT-13).
8. No imports de `@supabase/supabase-js` (CD-3 del work-item). Solo `getSupabaseClient` desde `../infra/supabase.js`.
9. No `console.*` (CD-5 del work-item).

**Shape sugerido (orientativo, Dev puede ajustar):**

```ts
export interface AuditEntry {
  readonly timestamp: string;       // ISO-8601, set by Postgres NOW() — omitimos en INSERT
  readonly request_id: string;
  readonly method: string;          // 'GET' | 'POST'
  readonly path: string;
  readonly status_code: number;
  readonly duration_ms: number;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly error_code: string | null;
  readonly idempotency_key: string | null;
}

export interface BuildAuditEntryInput {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly ipRaw: string | null;          // pre-truncation
  readonly userAgentRaw: string | null;   // pre-truncation
  readonly errorCode?: string;
  readonly idempotencyKey?: string;
}
```

**Nota sobre `timestamp`:** NO se envía en el INSERT — el DB lo genera con `DEFAULT NOW()`.
Esto evita drift entre clock del host Node y del DB. El campo está en la interface `AuditEntry`
solo para reflejar la shape de lectura post-insert (pero no es obligatorio exponerlo).

**DoD:** módulo compila en TS strict, no imports prohibidos, exports completos, JSDoc en cada función pública.

### W3 — App: decorador + hooks en `src/app.ts` + route touch-ups

**Archivos:**

- `src/app.ts` (MODIFICAR — agregar hooks)
- `src/routes/verify.ts` (MODIFICAR — poblar `request.auditMeta.errorCode` en paths de error)
- `src/routes/settle.ts` (MODIFICAR — poblar `request.auditMeta.idempotencyKey` y `errorCode`)
- `src/routes/supported.ts` (NO CAMBIOS — no tiene error_code ni idempotencyKey)

**Tareas en `src/app.ts`:**

1. Importar `buildAuditEntry`, `persistAuditEntry` desde `./core/audit.js`.
2. Definir constante de exclusión: `const AUDIT_EXCLUDED_PATHS = new Set(['/health', '/openapi.json']);`
3. Registrar hook `onRequest` para capturar `startMs` temprano (NO lo guarda; usa `request.startTimeMs` via `reply.elapsedTime` en `onResponse`). *Nota:* Fastify v5 ya provee `reply.elapsedTime` en `onResponse` — no se necesita decorador adicional de tiempo.
4. Registrar hook `onResponse` global:
   ```ts
   app.addHook('onResponse', async (request, reply) => {
     const path = request.routeOptions.url;
     if (!path || AUDIT_EXCLUDED_PATHS.has(path)) return;

     // Extract IP (proxy-aware)
     const xff = request.headers['x-forwarded-for'];
     let ipRaw: string | null = null;
     if (typeof xff === 'string' && xff.length > 0) {
       ipRaw = xff.split(',')[0]?.trim() ?? null;
     } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
       ipRaw = xff[0].split(',')[0]?.trim() ?? null;
     } else if (request.ip) {
       ipRaw = request.ip;
     }

     const uaRaw = typeof request.headers['user-agent'] === 'string'
       ? request.headers['user-agent']
       : null;

     const entry = buildAuditEntry({
       requestId: request.id,
       method: request.method,
       path,
       statusCode: reply.statusCode,
       durationMs: Math.round(reply.elapsedTime),
       ipRaw,
       userAgentRaw: uaRaw && uaRaw.length > 0 ? uaRaw : null,
       ...(request.auditMeta?.errorCode !== undefined ? { errorCode: request.auditMeta.errorCode } : {}),
       ...(request.auditMeta?.idempotencyKey !== undefined ? { idempotencyKey: request.auditMeta.idempotencyKey } : {}),
     });

     // Fire-and-forget: NEVER await in a way that blocks; but the hook itself
     // is already post-response, so awaiting here is safe. `persistAuditEntry`
     // is fail-open (CD-1) — it never throws.
     await persistAuditEntry(entry, app.log);
   });
   ```
   **Sobre el `await`:** Fastify v5 ejecuta `onResponse` DESPUÉS de flush del response al cliente. `await` aquí no agrega latencia observable (AC-9 cumplido). Adicionalmente, `persistAuditEntry` internamente swallowea errores (CD-1 del work-item).
5. Ubicación: registrar los hooks DESPUÉS de `initSupabase(env, logger)` y ANTES de `app.register(healthRoute)` (o después — no importa; Fastify aplica hooks a todas las routes registradas después del addHook, pero el global `onResponse` afecta a TODO). Decisión: registrar después de `initSupabase` y antes de los `register(...)` para evitar orden implícito.

**Tareas en `src/routes/verify.ts`:**

- Tras la Zod failure branch (línea ~73-86), agregar:
  ```ts
  request.auditMeta = { ...request.auditMeta, errorCode: 'INVALID_PAYLOAD' };
  ```
  ANTES de `return reply.code(400).send(body);`.
- Tras la adapter-throw branch (línea ~114-132), agregar:
  ```ts
  request.auditMeta = { ...request.auditMeta, errorCode: 'TRANSACTION_FAILED' };
  ```
  ANTES de `return reply.code(500).send(body);`.
- Tras la result.ok=false branch (línea ~143-155), agregar:
  ```ts
  request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
  ```
  ANTES de `return reply.code(result.error.http).send(...)`.

**Tareas en `src/routes/settle.ts`:**

- Tras `const idempotencyKey = buildSettleIdempotencyKey(parsed);` (línea 92), agregar:
  ```ts
  request.auditMeta = { ...request.auditMeta, idempotencyKey };
  ```
- En cada path de error (Zod failure, adapter-throw, result.ok=false), setear `errorCode`
  análogo a `/verify`. El `idempotencyKey` ya está seteado en `auditMeta` desde la línea 92 → sobrevive a los spreads.
- **Importante:** la Zod failure path NO tiene acceso a `idempotencyKey` (el parse falló antes). En ese caso solo se setea `errorCode: 'INVALID_PAYLOAD'` — `idempotencyKey` queda `undefined`.

**DoD:** `npm run typecheck` pasa; `npm test` pasa suite anterior (no regresión); hooks funcionan en `app.inject` manual.

### W4 — Tests: `src/__tests__/unit/audit.test.ts`

**Archivos:**

- `src/__tests__/unit/audit.test.ts` (NUEVO)

**Estrategia (copiada de `ledger.test.ts`):** mock del infra wrapper `../../infra/supabase.js` con `insertSpy` + `fromSpy`. No tocar `@supabase/supabase-js` directo.

Tests requeridos — ver §6 (Test Plan) por AC.

**DoD:** `npm test` corre; todos los tests de `audit.test.ts` PASS; coverage ≥90% de `src/core/audit.ts`.

### W5 — Integration tests + OWNERS + cierre

**Archivos:**

- `src/__tests__/unit/routes.verify.test.ts` (MODIFICAR — agregar 1-2 tests del hook)
- `src/__tests__/unit/routes.settle.test.ts` (MODIFICAR — agregar tests de `auditMeta` propagation)
- `src/__tests__/unit/routes.supported.test.ts` (MODIFICAR — 1 test: hook SI dispara aún sin error)
- `src/__tests__/unit/health.test.ts` (MODIFICAR — 1 test: hook NO dispara en `/health`)
- `OWNERS.md` (MODIFICAR — documentar `src/core/audit.ts`)

**Tareas:**

1. En tests de routes, mockear `../../core/audit.js` (spy en `persistAuditEntry`) y verificar que se invoca/no se invoca según ruta.
2. En `health.test.ts`, assert que el spy NO se llama.
3. En `OWNERS.md`, agregar nota: "`src/core/audit.ts` sigue mismo boundary que `src/core/ledger.ts` (OK importar `src/infra/supabase.ts`; PROHIBIDO importar chains/methods/routes)."
4. Correr `npm run qa` (typecheck + lint + format:check + test) — MUST pass.

**DoD:** suite verde 100%, OWNERS actualizado, tests existentes no rotos.

---

## 5. Constraint Directives

### 5.1 Heredadas del work-item (inmodificables)

- **CD-1:** `persistAuditEntry` NEVER throws. Try/catch total con logger.warn.
- **CD-2:** Prohibido `UPDATE`/`DELETE` en `facilitator_audit_log` desde `src/core/audit.ts`. Solo INSERT puro.
- **CD-3:** Prohibido importar `@supabase/supabase-js` directo en `audit.ts`. Solo vía `getSupabaseClient()`.
- **CD-4:** Prohibido loguear `user_agent` o `ip` en logs de aplicación (PII). El audit solo va a DB.
- **CD-5:** Prohibido `console.*` en `audit.ts`.
- **CD-6:** Obligatorio filtrar `/health` (y ahora `/openapi.json`) en el hook vía `request.routeOptions.url`.
- **CD-7:** `buildAuditEntry` es pure function (sin side effects, sin logger).
- **CD-8:** Truncation `ip→45` y `user_agent→512` ocurre en `buildAuditEntry` antes de `persistAuditEntry`.
- **CD-9:** Prohibido agregar lógica x402 en `audit.ts` (sin chainId, sin amount, sin methods).

### 5.2 Nuevas del SDD

- **CD-10 (nuevo — auto-blindaje WFAC-22/23):** OBLIGATORIO correr `npx prettier --write src/core/audit.ts src/__tests__/unit/audit.test.ts supabase/migrations/002_facilitator_audit_log.sql` antes de cada commit. No asumir line-breaks estéticos — dejar que Prettier decida.
- **CD-11 (nuevo — resuelve NC-4):** Las rutas `verify.ts` y `settle.ts` DEBEN setear `request.auditMeta = { ...request.auditMeta, errorCode: X }` en CADA path de error ANTES del `reply.send(...)`. El hook lee `request.auditMeta?.errorCode` sin fallback — si la ruta olvida setear, el audit row queda con `error_code = NULL` para un status ≥400 (defecto visible pero no bloqueante).
- **CD-12 (nuevo):** El `onResponse` hook DEBE usar `request.routeOptions.url` (path declarado), NO `request.url` (que incluye query string). Esto alinea con el filtro y previene que `/health?foo=bar` pase el filtro por no hacer match literal.
- **CD-13 (nuevo):** La interfaz `AuditEntry` NO incluye el campo `timestamp` en el objeto enviado al INSERT — el DB lo genera con `DEFAULT NOW()`. Esto evita drift entre clocks. Si la entrada `entry` tuviera `timestamp: string`, el INSERT con ese valor sobrescribiría el default — PROHIBIDO.
- **CD-14 (nuevo):** El hook `onResponse` puede `await persistAuditEntry(...)` porque Fastify v5 ejecuta el hook DESPUÉS del flush. NO se puede usar `persistAuditEntry(...).catch(...)` ni `void persistAuditEntry(...)` — ambos violan el contrato de fail-open + auditabilidad. El await garantiza que el pipeline de error interno del módulo corre por completo ANTES de que el request sea garbage-collected.

---

## 6. Test Plan — cobertura por AC

| # | AC | Test ID | Archivo | Descripción |
|---|----|---------|---------|-------------|
| T1 | AC-1 | T-A1 | `audit.test.ts` | `buildAuditEntry` populates `request_id`, `method`, `path`, `status_code`, `duration_ms` correctamente desde `BuildAuditEntryInput`. |
| T2 | AC-1 | T-A2 | `audit.test.ts` | `persistAuditEntry` llama `.from('facilitator_audit_log').insert(entry)` con la entry exacta. |
| T3 | AC-1 | T-R1 | `routes.verify.test.ts` | `app.inject({POST /verify, valid})` → `persistAuditEntry` spy called 1 vez con `path='/verify', status_code=200`. |
| T4 | AC-1 | T-R2 | `routes.settle.test.ts` | `app.inject({POST /settle, valid})` → `persistAuditEntry` spy called 1 vez con `path='/settle'`. |
| T5 | AC-1 | T-R3 | `routes.supported.test.ts` | `app.inject({GET /supported})` → `persistAuditEntry` spy called 1 vez con `path='/supported'`. |
| T6 | AC-2 | T-H1 | `health.test.ts` | `app.inject({GET /health})` → `persistAuditEntry` spy NO es llamado. |
| T7 | AC-2 | T-O1 | `audit.test.ts` (integration-light) | Simular request a `/openapi.json` (o test en routes.openapi.test.ts) → spy NO llamado. |
| T8 | AC-3 | T-A3 | `audit.test.ts` | `persistAuditEntry` no-op cuando `getSupabaseClient()` retorna `null` → sin throw, sin logger.warn. |
| T9 | AC-4 | T-A4 | `audit.test.ts` | `buildAuditEntry` con `ipRaw='1.2.3.4, 10.0.0.1'` (via XFF split previo en hook) → `ip='1.2.3.4'` (el hook hizo split antes; builder recibe ya split). ALTERNATIVA: testear el hook directo con XFF header. |
| T10 | AC-4 | T-R4 | `routes.verify.test.ts` o `routes.settle.test.ts` | `app.inject({headers: {'x-forwarded-for': '203.0.113.5, 10.0.0.1'}})` → spy recibe input con `ipRaw='203.0.113.5'`. |
| T11 | AC-5 | T-R5 | `routes.verify.test.ts` | `app.inject({headers: {}})` → spy recibe `ipRaw` igual a `request.ip` (o `127.0.0.1` en inject context). |
| T12 | AC-6 | T-A5 | `audit.test.ts` | `buildAuditEntry` con `ipRaw='a'.repeat(60)` → output `ip.length === 45`. |
| T13 | AC-7 | T-A6 | `audit.test.ts` | `buildAuditEntry` con `userAgentRaw='x'.repeat(600)` → output `user_agent.length === 512`. |
| T14 | AC-8 | T-A7 | `audit.test.ts` | `buildAuditEntry` con `userAgentRaw=null` → output `user_agent === null`. También caso `userAgentRaw=''`. |
| T15 | AC-8 | T-R6 | `routes.verify.test.ts` | `app.inject({headers: {} (sin UA)})` → spy recibe `userAgentRaw=null`, entry final con `user_agent=null`. |
| T16 | AC-9 | T-R7 | `routes.settle.test.ts` | Mock `persistAuditEntry` con delay 500ms. `app.inject({POST /settle})` → response vuelve en <100ms (antes del audit persist). **Nota:** dado que el hook es post-flush, this test asserta que el flush happens independientemente. |
| T17 | AC-10 | T-A8 | `audit.test.ts` | `insertSpy` mockRejectedValueOnce → `persistAuditEntry` resolves sin throw, `logger.warn` llamado 1 vez con err object, message `'audit insert failed'` (o análogo). |
| T18 | AC-10 | T-A8b | `audit.test.ts` | `getSupabaseClient` synchronous throw → `persistAuditEntry` resolves sin throw, logger.warn llamado 1 vez (espeja `ledger.test.ts T20b`). |
| T19 | AC-10 | T-A8c | `audit.test.ts` | Supabase response `{data: null, error: {...}}` → logger.warn llamado, sin throw. |
| T20 | AC-11 | T-DDL | manual / DDL review | Revisar `002_...sql` — sin triggers; revisar `audit.ts` — sin `UPDATE`/`DELETE` en código (grep). Plus: documentar que RLS está pendiente (WKH-SEC-0X). |
| T21 | AC-12 | T-R8 | `routes.settle.test.ts` | `app.inject({POST /settle, valid})` → spy recibe entry con `idempotency_key` = valor esperado (sha256 hex). |
| T22 | AC-12 | T-R9 | `routes.verify.test.ts` | `app.inject({POST /verify})` → spy recibe entry con `idempotency_key=null`. |
| T23 | AC-13 | T-R10 | `routes.verify.test.ts` | `app.inject({POST /verify, invalid body})` → spy recibe entry con `error_code='INVALID_PAYLOAD'` y `status_code=400`. |
| T24 | AC-13 | T-R11 | `routes.settle.test.ts` | `app.inject({POST /settle, body that triggers INSUFFICIENT_BALANCE})` → spy recibe entry con `error_code='INSUFFICIENT_BALANCE'`. |
| T25 | AC-14 | T-DDL-C | DDL review | `grep 'retention' supabase/migrations/002_...sql` — COMMENT ON TABLE incluye string "90d" y referencia a TD-RETENTION-01. |

**Coverage target:** ≥90% de `src/core/audit.ts` según `vitest --coverage`.

**Tests totales:** ≥14 (AC count) + margin de edge cases = target 22-25 test cases.

---

## 7. Exemplar verification (paths confirmados)

| Archivo | Existe | Verificado con | Uso |
|---------|--------|----------------|-----|
| `src/core/ledger.ts` | SI | Read | Exemplar estructural de `audit.ts` |
| `src/infra/supabase.ts` | SI | Read | Import `getSupabaseClient` |
| `src/app.ts` | SI | Read | Sitio de registro del hook |
| `src/routes/verify.ts` | SI | Read | Ruta auditada, poblar `auditMeta.errorCode` |
| `src/routes/settle.ts` | SI | Read | Ruta auditada, poblar `auditMeta.{errorCode, idempotencyKey}` |
| `src/routes/supported.ts` | SI | Read | Ruta auditada, sin cambios |
| `src/routes/health.ts` | SI | Read | Excluida del audit |
| `src/routes/openapi.ts` | SI | `ls doc/sdd/012-wfac-23-openapi-spec/` (HU DONE) + import en `app.ts:11` | Excluida del audit |
| `supabase/migrations/001_facilitator_settlements.sql` | SI | Read | Exemplar DDL |
| `src/__tests__/unit/ledger.test.ts` | SI | Read | Exemplar de test |
| `src/__tests__/unit/supabase.test.ts` | SI | Read | Exemplar de mock factory |
| `OWNERS.md` | SI | Read | Actualizar con `audit.ts` |
| `src/core/types.ts` | SI | grep confirms `X402ErrorCode` exportado | Type import en `audit.ts` |
| `.nexus/project-context.md` | SI | Read | Stack confirmado Fastify v5.8 |
| `package.json` | SI | Read | `fastify ^5.8.4`, `@supabase/supabase-js ^2.104.1` |

Sin alucinaciones: todas las rutas referenciadas fueron `Read` o `Glob` verificadas.

---

## 8. Boundaries y OWNERS actualizados

`src/core/audit.ts` sigue el mismo boundary que `src/core/ledger.ts`:

| Puede importar | PROHIBIDO importar |
|----------------|-------------------|
| `src/infra/supabase.ts` (runtime, solo `getSupabaseClient`) | `@supabase/supabase-js` directo (CD-3) |
| `pino` (type-only: `Logger`) | `src/chains/*`, `src/methods/*` (CD-9) |
| `src/core/types.ts` (type-only: `X402ErrorCode`) | `src/routes/*` |
| `fastify` (type-only, para `declare module 'fastify'`) | `node:crypto`, `ioredis`, `viem` |

En W5 el Dev actualiza `OWNERS.md` agregando nota explícita para `audit.ts`.

---

## 9. Readiness Check

Para que el SDD esté listo para `SPEC_APPROVED` todos los ítems deben ser [x]:

- [x] Work item leído completo (14 ACs, 9 CDs, 6 DTs, 4 NCs)
- [x] Los 4 `[NEEDS CLARIFICATION]` están resueltos (NC-1 via DT-7; NC-2 via DT-8; NC-3 via DT-9; NC-4 via DT-10)
- [x] Stack confirmado por `.nexus/project-context.md` y `package.json` (Fastify v5.8, Supabase, Pino)
- [x] Exemplars verificados con Read (§7) — cero paths inventados
- [x] DDL completo en §3 listo para copiar-pegar al migration file
- [x] Patrón de módulo `audit.ts` alineado con `ledger.ts` (CD-1 fail-open; CD-3 no direct SDK import; CD-5 no console; CD-7 pure builder)
- [x] Waves (W1-W5) tienen archivos exactos y DoD medible
- [x] Test plan cubre los 14 ACs con ≥1 test cada uno (§6)
- [x] Auto-blindaje aplicado: CD-10 (Prettier)
- [x] Boundaries documentados (§8) + action item en W5 para OWNERS.md
- [x] Readiness check completo sin TBDs

**SDD LISTO PARA SPEC_APPROVED.**

---

## 10. Open questions (no bloqueantes — para Adversary/QA review)

Ninguna bloqueante. Notas informativas para AR/CR:

1. **Clock precision en `duration_ms`:** usamos `Math.round(reply.elapsedTime)`. Fastify v5
   expone esto con precisión de ms (via `process.hrtime.bigint()` internamente). Si AR detecta
   jitter, es fix de 1 línea (`Math.round` vs `Math.floor`).
2. **`request.method` case:** Fastify normaliza a uppercase (`'GET'`, `'POST'`). Si algún test
   hace lowercase match, ajustar.
3. **Retry/backoff en `persistAuditEntry`:** out of scope. Si falla el INSERT, se loguea warn y
   el row se pierde — consistent con ledger.ts. Future enhancement: background queue (BullMQ ya
   en deps).
4. **RLS a nivel Postgres:** pending como `WKH-SEC-0X`. Hoy la defensa es solo app-layer (CD-2).
5. **Cron de retention 90d:** tracked como `TD-RETENTION-01` fuera de esta HU. El DDL lo
   documenta (AC-14).

---

## 11. Changelog

| Fecha | Cambio | Autor |
|-------|--------|-------|
| 2026-04-23 | SDD inicial — F2 completo. NC-1..NC-4 resueltos. 14 ACs cubiertos por test plan. | nexus-architect |
