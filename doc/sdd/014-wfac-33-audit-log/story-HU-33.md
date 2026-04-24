# Story File — HU-33 Audit log inmutable — Supabase `facilitator_audit_log` (WFAC-33)

- **Work Item**: `doc/sdd/014-wfac-33-audit-log/work-item.md`
- **SDD**: `doc/sdd/014-wfac-33-audit-log/sdd.md`
- **Pipeline**: QUALITY (infra DB + PII capture + hook global sobre 3 rutas productivas — AR + CR obligatorios) · **Sizing**: M · **SDD_MODE**: full
- **Branch**: `feat/014-wfac-33-audit-log` (ya creada desde `main` post-WFAC-32 — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **369/369 passed** (post WFAC-32 DONE) · **Target**: **≥ 394** (369 + ≥ 25 nuevos)
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-33.md`) — **es el único contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — consulta SOLO los relevantes a la wave que estás implementando.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes una ambigüedad y sospeches que este Story File está equivocado. En ese caso, STOP + reporta.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: feat/014-wfac-33-audit-log

git status
# esperado: clean al empezar. Entre waves, solo deben aparecer archivos del Scope IN (§0.5).

npm test -- --run
# esperado: 369/369 en baseline; creciente hasta ≥394 al cerrar W5.
```

### 0.3 Anti-Hallucination Checklist (por wave)

**Antes de empezar una wave:**

- [ ] Leíste ESTE Story File end-to-end (incluyendo §3 CDs y §4 Guardrails).
- [ ] Leíste los exemplars listados para ESTA wave (y solo esos).
- [ ] Verificaste cada import path con `ls` / `Read` antes de escribirlo.
- [ ] Confirmaste que **ningún archivo fuera del Scope IN (§0.5)** va a ser tocado.
- [ ] Confirmaste que las dependencias entre waves (§0.6) están verdes (build + tests).

**Antes de cerrar una wave:**

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green (eslint `--max-warnings 0`).
- [ ] `npm run format:check` green (si falla, `npx prettier --write <archivo>` — **CD-10**).
- [ ] `npm test -- --run` pasa el baseline (369) + los tests nuevos de esta wave.
- [ ] NO modificaste ningún archivo fuera del Scope IN de la wave.
- [ ] NO agregaste dependencias nuevas — todo el stack runtime YA está en `package.json`.
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno está violado.
- [ ] Si rompiste algún test de `ledger.test.ts` / `supabase.test.ts` / `routes.settle.test.ts` / `routes.verify.test.ts` previo → **STOP + diagnose** (regresión WFAC-32/21 = bloqueante).

### 0.4 Exemplars verificados en SDD §7 (paths confirmados con Read)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/core/ledger.ts` (190 LOC completo) | W2: **copiar patrón estructural exacto** — `LedgerLogger = Pick<Logger, ...>`, `LedgerEntry` interface readonly, `BuildLedgerEntryInput`, pure `buildLedgerEntry`, fail-open `persistLedgerEntry` con try/catch total. | W2 |
| E2 | `src/infra/supabase.ts` líneas 98-127 | W2: `getSupabaseClient(): SupabaseClient \| null` — cómo consumirlo, cómo manejar `null`. | W2 |
| E3 | `supabase/migrations/001_facilitator_settlements.sql` (59 LOC completo) | W1: DDL idempotente, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `COMMENT ON TABLE`, `COMMENT ON COLUMN`. | W1 |
| E4 | `src/app.ts` líneas 43-84 | W3: `buildApp(...)` completo — dónde agregar `onRequest` y `onResponse` hooks. `initSupabase(env, logger)` está en línea 57. | W3 |
| E5 | `src/routes/settle.ts` líneas 63-247 | W3: **handler completo de /settle** con 3 paths de error (Zod 400 línea 69-87, adapter-throw 500 línea 113-153, result.ok=false línea 164-196). Línea 92 es donde se calcula `idempotencyKey`. Los 3 hooks H1/H2/H3 de WFAC-32 ya existen. | W3 |
| E6 | `src/routes/verify.ts` líneas 61-179 | W3: handler completo de /verify con los MISMOS 3 paths de error (sin ledger). Es donde agregar `request.auditMeta = ...` en cada path. | W3 |
| E7 | `src/routes/health.ts` (48 LOC) | W3: confirma que el path registrado es literal `'/health'`, con `config: { rateLimit: false }`. El hook debe EXCLUIRLO. | W3 |
| E8 | `src/routes/openapi.ts` (60 LOC) | W3: confirma que el path registrado es literal `'/openapi.json'`. El hook debe EXCLUIRLO. | W3 |
| E9 | `src/routes/supported.ts` (55 LOC) | W3: confirma que `/supported` solo tiene success 200 — no tiene paths de error (Fastify default maneja 404). NO setea `auditMeta`. | W3 |
| E10 | `src/__tests__/unit/ledger.test.ts` líneas 15-96 | W4: **exemplar directo de test pattern** — `vi.mock('../../infra/supabase.js', ...)` con `__upsertSpy` / `__fromSpy` / `__getSupabaseClient`. | W4 |
| E11 | `src/__tests__/unit/supabase.test.ts` | W4 (secundario): patrón `vi.mock('@supabase/supabase-js', ...)` — **NO se usa en audit.test.ts** (el módulo consume solo via `getSupabaseClient` wrapper). | W4 |
| E12 | `src/__tests__/unit/routes.settle.test.ts` líneas 41-80 | W4: cómo mockear `../../core/ledger.js` para tests de route. Patrón `__persistSpy` / `__buildSpy`. Adaptar a `../../core/audit.js`. | W4 |
| E13 | `src/core/types.ts` líneas 32-42 | W2: `X402ErrorCode` literal union (10 codes) — `import type` para typing de `AuditMeta.errorCode`. | W2 |
| E14 | `OWNERS.md` líneas 20-34 | Todas: `src/core/*` MAY import `src/infra/*`. `src/routes/*` MAY import `src/core/*`. `audit.ts` entra en la misma excepción que `ledger.ts`. | Todas |
| E15 | `src/infra/env.ts` líneas 31-36 | W1 (NO modificar): `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` YA están en EnvSchema (WFAC-32). El hook consume las mismas credenciales via `getSupabaseClient()`. | W1/W2 |
| E16 | `tsconfig.json` (ya leído en WFAC-32) | W2: `module: "Node16"` + ESM strict + `noUncheckedIndexedAccess`. Imports con `.js` extension obligatorio. | W2 |

### 0.5 Scope IN — los ÚNICOS archivos que puedes tocar

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `supabase/migrations/002_facilitator_audit_log.sql` | **CREATE** | W1 |
| 2 | `src/core/audit.ts` | **CREATE** | W2 |
| 3 | `src/app.ts` | **MODIFY** (add 2 hooks + 1 import + 1 const) | W3 |
| 4 | `src/routes/settle.ts` | **MODIFY** (populate `auditMeta` en 4 paths — success + 3 errors) | W3 |
| 5 | `src/routes/verify.ts` | **MODIFY** (populate `auditMeta.errorCode` en 3 paths de error) | W3 |
| 6 | `src/__tests__/unit/audit.test.ts` | **CREATE** | W4 |
| 7 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (append tests del hook + auditMeta propagation) | W4 |
| 8 | `src/__tests__/unit/routes.verify.test.ts` | **MODIFY** (append tests del hook + auditMeta propagation) | W4 |
| 9 | `src/__tests__/unit/routes.supported.test.ts` | **MODIFY** (append 1 test: hook dispara en /supported) | W4 |
| 10 | `src/__tests__/unit/health.test.ts` | **MODIFY** (append 1 test: hook NO dispara en /health) | W4 |
| 11 | `src/__tests__/unit/routes.openapi.test.ts` | **MODIFY** (append 1 test: hook NO dispara en /openapi.json) | W4 |
| 12 | `OWNERS.md` | **MODIFY** (agregar nota para `src/core/audit.ts`) | W5 |

**Cualquier edit a cualquier otro archivo = violación del Story File. STOP AND REPORT.**

En particular, los siguientes archivos están **CONGELADOS** para esta HU:

- `src/core/ledger.ts` — patrón y espejo estructural, pero **NO modificar**.
- `src/infra/supabase.ts` — se consume únicamente. No agregar exports ni funciones.
- `src/infra/env.ts` — `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` ya existen (WFAC-32); NO renombrar ni agregar vars nuevas.
- `src/routes/health.ts` — solo se usa como EXCLUIDO del hook.
- `src/routes/openapi.ts` — solo se usa como EXCLUIDO del hook.
- `src/routes/supported.ts` — NO cambia; el hook lo audita pero la ruta no toca `auditMeta`.
- `src/core/settle.ts` / `src/core/verify.ts` — core permanece puro (CD-9).
- `src/chains/*`, `src/methods/*` — irrelevantes para esta HU.
- `supabase/migrations/001_facilitator_settlements.sql` — frozen post-merge (WFAC-32 CD-16).
- `package.json` — NO agregar deps. `@supabase/supabase-js` ya instalado.
- `.env.example` — NO modificar.

### 0.6 Wave dependency graph

```
W1 (migration SQL — DDL facilitator_audit_log)
       │
       ▼
W2 (src/core/audit.ts — AuditMeta + AuditEntry + buildAuditEntry + persistAuditEntry)
       │
       ▼
W3 (src/app.ts hooks + src/routes/settle.ts + src/routes/verify.ts — populate auditMeta)
       │
       ▼
W4 (tests: audit.test.ts + routes.*.test.ts + health.test.ts + routes.openapi.test.ts)
       │
       ▼
W5 (OWNERS.md + final qa)
```

- **W1 → W2**: W2 consulta el schema para mapear columnas (nombres snake_case).
- **W2 → W3**: W3 importa `buildAuditEntry`, `persistAuditEntry`, `AuditMeta` (tipo via `declare module 'fastify'` que vive en audit.ts).
- **W3 → W4**: W4 mockea el módulo `../../core/audit.js` en tests de routes — necesita que exporte el shape definido en W2.
- **W4 → W5**: W5 corre QA final tras tener 394/394 tests pasando.
- **Sin forward references**. Si W1 necesita algo de W2, hay bug de diseño — STOP AND REPORT.

---

## 1. Waves

### Wave 1 — Migration SQL `002_facilitator_audit_log.sql`

**Objetivo**: tener la tabla `facilitator_audit_log` versionada en `supabase/migrations/` + DDL idempotente + 3 índices + COMMENTs documentando retention 90d.

#### Files (W1)

| # | Path | Acción |
|---|------|--------|
| 1 | `supabase/migrations/002_facilitator_audit_log.sql` | **CREATE** |

#### W1.1 — `supabase/migrations/002_facilitator_audit_log.sql`

**Acción**: crear el archivo desde cero. Idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

**Contenido exacto** (copiar verbatim desde el SDD §3):

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

**Checklist W1.1**:

- [ ] El archivo se llama **exactamente** `002_facilitator_audit_log.sql` (3 dígitos, snake_case, padding).
- [ ] Todo el DDL es idempotente (`IF NOT EXISTS`).
- [ ] Los 3 índices (`idx_fal_timestamp`, `idx_fal_status_code`, `idx_fal_idempotency_key`) están creados. El último es **partial index** (`WHERE idempotency_key IS NOT NULL`).
- [ ] `COMMENT ON TABLE` incluye el string literal "90d" y la referencia a `TD-RETENTION-01` (cubre **AC-14**).
- [ ] NO `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` (scope OUT — WKH-SEC-0X).
- [ ] NO `CREATE TRIGGER` de ningún tipo (append-only convention — CD-2).
- [ ] `VARCHAR(45)` para `ip` y `VARCHAR(512)` para `user_agent` — **exactos**, defense-in-depth para truncation.
- [ ] NO `UNIQUE` constraint en `idempotency_key` (cada request genera un row nuevo — DT-13).
- [ ] Si detectás un typo cualquiera **antes del merge** → corregir in-place. Una vez mergeado, la migration es inmutable, cualquier cambio futuro va en `003_*.sql`.

#### Wave 1 — dependencies

- Depende solo de `main` post-WFAC-32 (migration 001 ya existe).
- NO depende de W2/W3/W4/W5.

#### Wave 1 — completion criteria

- [ ] Archivo `supabase/migrations/002_facilitator_audit_log.sql` creado.
- [ ] `npm run typecheck` green (no cambió nada en TS todavía — sanity check).
- [ ] `npm test -- --run` sigue 369/369 (no hay tests nuevos en W1).
- [ ] `git status` muestra SOLO `supabase/migrations/002_facilitator_audit_log.sql` (new).

---

### Wave 2 — `src/core/audit.ts` (AuditMeta + AuditEntry + buildAuditEntry + persistAuditEntry)

**Objetivo**: módulo core que (a) augmenta el tipo `FastifyRequest` con un decorador opcional `auditMeta`, (b) define la shape de row `AuditEntry`, (c) construye una entry pura desde un request + reply, y (d) persiste vía Supabase INSERT fire-and-forget.

#### Files (W2)

| # | Path | Acción |
|---|------|--------|
| 2 | `src/core/audit.ts` | **CREATE** |

#### W2.1 — `src/core/audit.ts` (NEW)

**Imports permitidos** (OWNERS: `src/core/*` MAY import `src/infra/*`):

```ts
import type { Logger } from 'pino';
import { getSupabaseClient } from '../infra/supabase.js';  // runtime
// declare module 'fastify' requires the module to be a known type — import is
// type-only, for declaration-merging purposes only (no runtime import of fastify).
import type { X402ErrorCode } from './types.js';           // type-only
import type { FastifyRequest } from 'fastify';              // type-only (for the augmentation)
```

**Imports PROHIBIDOS** (CD-3):

- `@supabase/supabase-js` — NO import directo; se accede SOLO via `getSupabaseClient()`.
- `src/chains/*` (any) — audit.ts es observabilidad, no conoce chainId / method / amount (CD-9).
- `src/methods/*` (any) — idem.
- `src/routes/*` (any).
- `node:crypto`, `viem`, `ioredis`, `zod` — no necesarios acá.

**Module augmentation obligatorio** (DT-9 del SDD):

```ts
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Optional audit metadata populated by route handlers BEFORE reply.send()
     * and read by the `onResponse` hook registered in `src/app.ts`.
     * `undefined` by default — the hook tolerates absence (WFAC-33 DT-9).
     */
    auditMeta?: AuditMeta;
  }
}
```

**Exports obligatorios** (6):

```ts
export interface AuditMeta {
  readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD';
  readonly idempotencyKey?: string;
}

export type AuditLogger = Pick<Logger, 'warn' | 'debug'>;

export interface AuditEntry {
  // NOTE: NO `timestamp` field — DB generates via DEFAULT NOW() (CD-13).
  readonly request_id: string;
  readonly method: string;
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
  readonly ipRaw: string | null;          // pre-truncation (CD-8)
  readonly userAgentRaw: string | null;   // pre-truncation (CD-8)
  readonly errorCode?: string;
  readonly idempotencyKey?: string;
}

export function buildAuditEntry(input: BuildAuditEntryInput): AuditEntry;
export async function persistAuditEntry(entry: AuditEntry, logger: AuditLogger): Promise<void>;
```

**Comportamiento requerido de `buildAuditEntry(input)`** — pure function, sin side effects, sin logger (CD-7):

1. Map input → `AuditEntry` construyendo los **9 campos nombrados uno por uno** (NO rest-spread — precedente `ledger.ts` CD-13 de WFAC-32).
2. **Truncation (CD-8)** DENTRO del builder, ANTES de retornar:
   - `ip`: si `input.ipRaw === null` o string vacío → `null`. Si `input.ipRaw.length > 45` → `input.ipRaw.slice(0, 45)`. Si no → `input.ipRaw`.
   - `user_agent`: si `input.userAgentRaw === null` o string vacío → `null`. Si `input.userAgentRaw.length > 512` → `input.userAgentRaw.slice(0, 512)`. Si no → `input.userAgentRaw`.
3. `error_code`: si `input.errorCode === undefined` → `null`. Si no → `input.errorCode`.
4. `idempotency_key`: si `input.idempotencyKey === undefined` → `null`. Si no → `input.idempotencyKey`.

**Comportamiento requerido de `persistAuditEntry(entry, logger)`** — fire-and-forget (CD-1):

1. `try { const client = getSupabaseClient(); if (!client) return; ... } catch (err) { logger.warn(...); }`
2. El `try` envuelve TODO — incluyendo la llamada sincrónica a `getSupabaseClient()` (que podría throwear bajo ciertos edge cases de SDK init — mismo pattern que `ledger.ts` línea 156-188).
3. Llamar:
   ```ts
   const { data, error } = await client
     .from('facilitator_audit_log')
     .insert(entry);
   ```
   **NO `.upsert()`**, **NO `onConflict`** (append-only — DT-13 del SDD). Plain INSERT.
4. Si `error` no-null → `logger.warn({ err: error, request_id: entry.request_id, path: entry.path }, 'audit insert failed')` y return. (CD-4: NO loguear `ip` ni `user_agent` en el payload del logger).
5. Si `error` null → return silencioso. **NO `logger.info`** (ruido — el audit ya fue persistido; el happy path no debe inflar logs).
6. Si el await (o `getSupabaseClient()`) throwea → catch captura, `logger.warn({ err, request_id: entry.request_id, path: entry.path }, 'audit client or insert failed')`. NUNCA re-throw.

**Archivo template (shape esperada, Dev puede reordenar JSDoc libremente — pero las firmas son fijas):**

```ts
/**
 * HTTP audit log — core persistence helpers (WFAC-33).
 *
 * Responsibilities:
 *   1. Augment FastifyRequest with an optional `auditMeta` decorator so route
 *      handlers can pass error_code / idempotency_key to the onResponse hook.
 *   2. Build an AuditEntry from request/reply transport data + auditMeta.
 *   3. Persist that entry into Supabase via fire-and-forget INSERT.
 *
 * Boundaries (OWNERS.md):
 *   - MAY import from `src/infra/*` (runtime) and `pino` / `fastify` / `./types.js`
 *     (type-only).
 *   - MUST NOT import from `src/chains/*`, `src/methods/*`, `src/routes/*` (CD-9).
 *   - MUST NOT import `@supabase/supabase-js` directly — access is only through
 *     `getSupabaseClient()` (CD-3).
 *
 * Contracts:
 *   - `persistAuditEntry` NEVER throws at the caller (CD-1). All error paths
 *     captured + logged at `warn` via the injected logger.
 *   - `buildAuditEntry` is a pure function — same input ⇒ same output, no side
 *     effects (CD-7). Truncation (ip→45, user_agent→512) happens here (CD-8).
 *   - The AuditEntry interface has NO `timestamp` field — Postgres DEFAULT NOW()
 *     generates it server-side (CD-13).
 *   - No `console.*` usage (CD-5).
 *   - No PII (ip, user_agent) in application logs — only in DB rows (CD-4).
 */

import type { Logger } from 'pino';
import type { FastifyRequest } from 'fastify';
import type { X402ErrorCode } from './types.js';
import { getSupabaseClient } from '../infra/supabase.js';

// ─── Fastify type augmentation (DT-9) ──────────────────────────────────────
declare module 'fastify' {
  interface FastifyRequest {
    auditMeta?: AuditMeta;
  }
}

// `FastifyRequest` import above is what makes the augmentation type-correct;
// we don't use the identifier at runtime. Suppress the unused-import warning
// if eslint complains — it's a declared dependency of the module augmentation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _KeepFastifyRequestImport = FastifyRequest;

export interface AuditMeta {
  readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD';
  readonly idempotencyKey?: string;
}

export type AuditLogger = Pick<Logger, 'warn' | 'debug'>;

export interface AuditEntry {
  readonly request_id: string;
  readonly method: string;
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
  readonly ipRaw: string | null;
  readonly userAgentRaw: string | null;
  readonly errorCode?: string;
  readonly idempotencyKey?: string;
}

/** Max widths — must match VARCHAR(N) in DDL (CD-8). */
const IP_MAX_LEN = 45;
const USER_AGENT_MAX_LEN = 512;

export function buildAuditEntry(input: BuildAuditEntryInput): AuditEntry {
  const ip = truncateOrNull(input.ipRaw, IP_MAX_LEN);
  const user_agent = truncateOrNull(input.userAgentRaw, USER_AGENT_MAX_LEN);
  return {
    request_id: input.requestId,
    method: input.method,
    path: input.path,
    status_code: input.statusCode,
    duration_ms: input.durationMs,
    ip,
    user_agent,
    error_code: input.errorCode ?? null,
    idempotency_key: input.idempotencyKey ?? null,
  };
}

function truncateOrNull(raw: string | null, max: number): string | null {
  if (raw === null || raw.length === 0) return null;
  return raw.length > max ? raw.slice(0, max) : raw;
}

export async function persistAuditEntry(
  entry: AuditEntry,
  logger: AuditLogger,
): Promise<void> {
  try {
    const client = getSupabaseClient();
    if (!client) return;

    const { error } = await client.from('facilitator_audit_log').insert(entry);

    if (error) {
      // CD-4: do NOT include ip/user_agent in log payload.
      logger.warn(
        { err: error, request_id: entry.request_id, path: entry.path },
        'audit insert failed',
      );
      return;
    }
    // Success path: silent — no logger.info (CD-4 + noise control).
  } catch (err) {
    // CD-1: capture EVERY throw from the async chain including synchronous
    // throws from `getSupabaseClient()` / `createClient()`. Never re-throw.
    logger.warn(
      { err, request_id: entry.request_id, path: entry.path },
      'audit client or insert failed',
    );
  }
}
```

**Notas importantes sobre la firma**:

- La constante `_KeepFastifyRequestImport` o similar es **opcional** — si el compilador no quita el import type por tree-shaking, podés omitirla. Si ESLint avisa `@typescript-eslint/no-unused-vars` sobre `FastifyRequest`, usala o usa `import 'fastify';` (side-effect import) en lugar de `import type { FastifyRequest }`. Elegí el que haga pasar lint sin hacks feos.
- `truncateOrNull` es local al módulo (no exported) — detalle de implementación.
- El shape del INSERT es **9 campos** (no 10) — `timestamp` **NO** se incluye (CD-13).
- **NO** llamar `logger.info` en el path exitoso — es ruido operacional.

#### Wave 2 — dependencies

- Depende de W1 (schema existe, pero no es blocking build — TS compila igual). Recomendado mergear waves en orden.
- NO depende de W3/W4/W5.

#### Wave 2 — completion criteria

- [ ] `npm run typecheck` green — el module augmentation debe tipar correctamente `request.auditMeta` en tests downstream.
- [ ] `npm run lint` green (max-warnings 0).
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/core/audit.ts`; **CD-10**).
- [ ] `npm test -- --run` sigue 369/369 (audit.test.ts se agrega en W4).
- [ ] `grep -n "from '@supabase/supabase-js'" src/core/audit.ts` → **zero matches**. (**CD-3**)
- [ ] `grep -nE "from '\\.\\./(chains|methods|routes)/" src/core/audit.ts` → **zero matches**. (**CD-9**)
- [ ] `grep -n "console\\." src/core/audit.ts` → **zero matches**. (**CD-5**)
- [ ] `grep -n "throw " src/core/audit.ts` → **zero matches** dentro de `persistAuditEntry` (el builder puro puede throwear teóricamente si recibe input imposible; persistor nunca).
- [ ] `grep -nE "timestamp" src/core/audit.ts` → solo aparece en JSDoc/comments, **NUNCA** como key en el objeto `AuditEntry` construido. (**CD-13**)
- [ ] `grep -nE "\\.upsert\\(|onConflict" src/core/audit.ts` → **zero matches**. (**CD-2 + DT-13**)
- [ ] `grep -nE "logger\\.(info|warn|debug).*(ip|user_agent|userAgent)" src/core/audit.ts` → **zero matches**. (**CD-4**)

---

### Wave 3 — `src/app.ts` (hooks globales) + `src/routes/{settle,verify}.ts` (populate `auditMeta`)

**Objetivo**: agregar `onRequest` + `onResponse` hooks globales en `buildApp`, que filtran `/health` y `/openapi.json`, extraen IP/UA, y llaman `persistAuditEntry`. Las rutas `/settle` y `/verify` populan `request.auditMeta.errorCode` y `/settle` además `idempotencyKey`.

#### Files (W3)

| # | Path | Acción |
|---|------|--------|
| 3 | `src/app.ts` | **MODIFY** (+ 1 import, + 1 const, + 1 onResponse hook) |
| 4 | `src/routes/settle.ts` | **MODIFY** (populate auditMeta en 5 puntos) |
| 5 | `src/routes/verify.ts` | **MODIFY** (populate auditMeta.errorCode en 3 puntos) |

#### W3.1 — `src/app.ts`

**Imports a agregar** (junto a los existentes):

```ts
import { buildAuditEntry, persistAuditEntry } from './core/audit.js';
```

**Const a agregar** (en el top del módulo, después de los imports):

```ts
/**
 * Paths excluded from the audit hook (DT-11 — blacklist pattern).
 * Uses `request.routeOptions.url` for exact match (query string is stripped —
 * CD-12). Any new public route is audited by default unless added here.
 */
const AUDIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set(['/health', '/openapi.json']);
```

**Hook a agregar** dentro de `buildApp(...)`, **DESPUÉS** del `app.register(openapiRoute)` (línea 68) y **ANTES** del existing `app.addHook('onClose', ...)` (línea 73) — pero la posición exacta no importa semánticamente mientras sea dentro del `buildApp` después de los registros. Mantener orden de legibilidad:

```ts
  // WFAC-33 — audit log onResponse hook (global).
  // Fires AFTER the response is flushed to the client (Fastify v5 guarantees
  // this); the await below does NOT add observable latency (AC-9).
  // Filters /health and /openapi.json via AUDIT_EXCLUDED_PATHS (AC-2, CD-6).
  // Reads optional request.auditMeta populated by route handlers before
  // reply.send (DT-9, DT-10, CD-11).
  app.addHook('onResponse', async (request, reply) => {
    const routePath = request.routeOptions.url;
    if (!routePath || AUDIT_EXCLUDED_PATHS.has(routePath)) return;

    // Proxy-aware IP extraction (DT-2). X-Forwarded-For first element.
    const xff = request.headers['x-forwarded-for'];
    let ipRaw: string | null = null;
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0];
      ipRaw = first ? first.trim() : null;
    } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
      const first = xff[0].split(',')[0];
      ipRaw = first ? first.trim() : null;
    } else if (typeof request.ip === 'string' && request.ip.length > 0) {
      ipRaw = request.ip;
    }

    const uaHeader = request.headers['user-agent'];
    const userAgentRaw =
      typeof uaHeader === 'string' && uaHeader.length > 0 ? uaHeader : null;

    const meta = request.auditMeta;
    const entry = buildAuditEntry({
      requestId: request.id,
      method: request.method,
      path: routePath,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ipRaw,
      userAgentRaw,
      ...(meta?.errorCode !== undefined ? { errorCode: meta.errorCode } : {}),
      ...(meta?.idempotencyKey !== undefined ? { idempotencyKey: meta.idempotencyKey } : {}),
    });

    // CD-14: await (hook already runs post-flush — no user-facing latency).
    // NO .catch(), NO void — the full error pipeline inside persistAuditEntry
    // must complete before the request is GC'd.
    await persistAuditEntry(entry, app.log);
  });
```

**Reglas críticas para `src/app.ts`**:

- [ ] **CD-6**: filtrar por `request.routeOptions.url` **exacto** con el set `AUDIT_EXCLUDED_PATHS`. NUNCA `request.url` (incluye query string — CD-12).
- [ ] **CD-14**: usar `await persistAuditEntry(...)` — NUNCA `.catch(...)`, `void persistAuditEntry(...)`, ni fire-and-forget desnudo.
- [ ] NO agregar un hook `onRequest` para inicializar `request.auditMeta` — el decorador es opcional (`auditMeta?`) y el hook tolera `undefined`. Inicializar vacío es ruido innecesario.
- [ ] NO mover ni reordenar `initRedis(env, logger)`, `initSupabase(env, logger)`, ni los `app.register(...)` existentes. El hook se agrega, no reemplaza.
- [ ] NO agregar `onClose` para Supabase (ya cubierto WFAC-32 CD-15).
- [ ] `Math.round(reply.elapsedTime)` — round, NO floor, NO ceil (nota SDD §10).

#### W3.2 — `src/routes/settle.ts`

**Puntos de populate de `request.auditMeta`** — basado en el exemplar actual (líneas 63-247):

1. **Después** de `const idempotencyKey = buildSettleIdempotencyKey(parsed);` (línea 92), **ANTES** del if `redisUp` (línea 93):
   ```ts
   request.auditMeta = { ...request.auditMeta, idempotencyKey };
   ```
   Esta asignación **sobrevive** a todos los spreads posteriores porque se hace ANTES de cualquier reply.

2. **En el Zod failure path** (líneas 69-87), **ANTES** del `return reply.code(400).send(body);` (línea 87):
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: 'INVALID_PAYLOAD' };
   ```
   Nota: en este path `idempotencyKey` **NO** está seteado (el parse falló antes del cálculo). El spread de `...request.auditMeta` preserva lo que haya (en este caso, nada).

3. **En el adapter-throw path** (líneas 113-153), **ANTES** del `return reply.code(500).send(body);` (línea 152) — y **ANTES** del `persistLedgerEntry` existing (línea 127) porque el orden lógico es: set meta → ledger entry → reply:
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: 'TRANSACTION_FAILED' };
   ```
   Acá `idempotencyKey` SÍ está en `request.auditMeta` (seteado en paso 1).

4. **En el result.ok=false path** (líneas 164-196), **ANTES** del `return reply.code(result.error.http).send(...)` (línea 195) — puede ir antes del `persistLedgerEntry` existing (línea 177) o después, el orden entre ledger y meta no importa:
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
   ```

5. **En el success path** (líneas 197-245): **NO** agregar `errorCode` (queda `undefined` → `error_code = null` en el audit row). `idempotencyKey` ya está seteado. NO tocar este path.

**NO modificar** `sendCachedSettle` helper (líneas 270-310). El cache-hit path **igual dispara el hook** — el `idempotencyKey` NO está seteado en `request.auditMeta` porque el asignamiento de paso 1 no corrió (cache-hit devuelve antes). Esto es OK: el audit row del replay no tiene idempotency_key (**AC-12** aplica solo al primer request). Si el PO pide cubrir cache-hit, agrega el populate en `sendCachedSettle` — pero **por defecto NO lo agregues** (minimiza cambios).

**ACTUALIZACIÓN importante**: releyendo el flujo — el cache-hit `sendCachedSettle` SÍ corre el `onResponse` hook (es parte del pipeline Fastify). Si querés que el audit row del replay incluya `idempotency_key`, podés mover el populate de paso 1 DESPUÉS del cálculo pero ANTES del if `redisUp`, como ya indica arriba. Está bien como está: línea 92 → populate idempotencyKey → línea 93 if redisUp → si hit, return via sendCachedSettle (con auditMeta ya seteado). El audit row del replay **sí** tendrá idempotency_key porque el populate ocurre antes del cache lookup.

**Snippet completo post-modificación del flujo de `/settle`** (referencia conceptual, Dev adapta):

```ts
// Step 1 — Zod validation
const parseResult = SettleRequestSchema.safeParse(request.body);
if (!parseResult.success) {
  // ... build error body, app.log.warn ...
  request.auditMeta = { ...request.auditMeta, errorCode: 'INVALID_PAYLOAD' };
  return reply.code(400).send(body);
}
const parsed: SettleRequest = parseResult.data;

// Step 2 — idempotency lookup
const idempotencyKey = buildSettleIdempotencyKey(parsed);
request.auditMeta = { ...request.auditMeta, idempotencyKey };  // (1)

const redisUp = isRedisAvailable();
if (redisUp) {
  const cached = await getCachedSettleResponse(idempotencyKey);
  if (cached) {
    return sendCachedSettle(reply, cached, { ... });
  }
}

// Step 3 — dispatch
let result;
try {
  result = await settleCore(parsed);
} catch (err: unknown) {
  // ... app.log.error ...
  request.auditMeta = { ...request.auditMeta, errorCode: 'TRANSACTION_FAILED' };  // (3)
  await persistLedgerEntry(buildLedgerEntry({ ... }), app.log);  // existing WFAC-32
  return reply.code(500).send(body);
}

// Step 4 — cache ... (no cambios)

// Step 5 — map Result → HTTP
if (!result.ok) {
  // ... app.log.warn ...
  request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };  // (4)
  await persistLedgerEntry(buildLedgerEntry({ ... }), app.log);  // existing WFAC-32
  return reply.code(result.error.http).send(...);
}

// Success — NO tocar auditMeta (errorCode queda undefined → error_code=null)
await persistLedgerEntry(buildLedgerEntry({ ... }), app.log);  // existing WFAC-32
app.log.info(...);
return reply.code(200).send(...);
```

**Reglas críticas para `settle.ts`**:

- [ ] **CD-11**: los 4 populate usan el patrón `request.auditMeta = { ...request.auditMeta, <field>: <value> }`. NUNCA asignación directa como `request.auditMeta.errorCode = 'X'` (porque `auditMeta` puede ser `undefined`).
- [ ] **CD-11**: la asignación ocurre **ANTES** de `reply.send(...)` / `return reply.code(...).send(...)`. Si lo haces después, Fastify ya disparó `onResponse` y el hook leyó `auditMeta` viejo.
- [ ] NO tocar `settleCore(parsed)` ni `buildSettleIdempotencyKey(parsed)` — sin modificaciones a `src/core/*`.
- [ ] NO tocar los hooks existing de `persistLedgerEntry` (WFAC-32 H1/H2/H3) — siguen idénticos.
- [ ] NO importar `../core/audit.js` en esta ruta — el tipo `AuditMeta` se resuelve via module augmentation en `audit.ts`. **Si TS quejas sobre tipos de `errorCode`**, el valor literal `'INVALID_PAYLOAD'` / `'TRANSACTION_FAILED'` es del superset local `SettleRouteErrorCode` (línea 38-50) que es compatible con `X402ErrorCode | 'INVALID_PAYLOAD'` — no necesita import extra. Si quejas persisten, agrega `import type { AuditMeta } from '../core/audit.js';` (type-only — no runtime).
- [ ] `sendCachedSettle` helper **no tocar** — el populate en paso (1) ya setea `idempotencyKey` antes del cache-hit.

#### W3.3 — `src/routes/verify.ts`

**Puntos de populate** — basado en el exemplar actual (líneas 61-179):

1. **En el Zod failure path** (líneas 68-86), **ANTES** del `return reply.code(400).send(body);` (línea 85):
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: 'INVALID_PAYLOAD' };
   ```

2. **En el adapter-throw path** (líneas 111-132), **ANTES** del `return reply.code(500).send(body);` (línea 131):
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: 'TRANSACTION_FAILED' };
   ```

3. **En el result.ok=false path** (líneas 143-155), **ANTES** del `return reply.code(result.error.http).send(...)` (línea 154):
   ```ts
   request.auditMeta = { ...request.auditMeta, errorCode: result.error.code };
   ```

4. **Success path** (líneas 157-178): NO agregar `errorCode` (queda undefined → error_code=null).

**NO** populate `idempotencyKey` en `/verify` — la idempotency key de verify se usa para cache pero NO necesita linkearse a `facilitator_settlements` (`facilitator_audit_log.idempotency_key` linkea solo a settlements). Deja `undefined` → `idempotency_key = null` en el audit row. Esto es intencional (work-item AC-12: "present in `/settle` flow").

**NO modificar** el helper `sendCached` (líneas 195-225) — mismo razonamiento que en settle: cache-hit dispara el hook igual, pero sin `errorCode` poblado (`error_code = null` para cache-hit exitoso; si fue cached-error, `errorCode` queda null — levemente impreciso pero no bloqueante).

**Reglas críticas para `verify.ts`**:

- [ ] Mismo patrón `request.auditMeta = { ...request.auditMeta, errorCode: X }` — siempre spread.
- [ ] Los 3 populate **ANTES** de `reply.send(...)`.
- [ ] NO importar `../core/audit.js` a menos que TS lo exija para tipar.
- [ ] NO tocar `verifyCore(parsed)`.

#### Wave 3 — dependencies

- Depende de W2 (`buildAuditEntry`, `persistAuditEntry`, `AuditMeta` type augmentation exportados).
- NO depende de W1 (el schema todavía no se lee en build-time — el runtime sí, pero los tests mockean Supabase).
- NO depende de W4/W5.

#### Wave 3 — completion criteria

- [ ] `npm run typecheck` green. Especialmente: TypeScript debe resolver `request.auditMeta` como `AuditMeta | undefined` en ambos routes.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/app.ts src/routes/settle.ts src/routes/verify.ts`; **CD-10**).
- [ ] `npm test -- --run` → **369/369 seguir verdes**. No hay tests nuevos aún en W3 (son W4), pero los tests existentes deben seguir pasando — especialmente `routes.settle.test.ts` (22 tests) y `routes.verify.test.ts` (verificar que el mock de `../../core/ledger.js` sigue funcionando). Si un test existing falla → regresión, STOP + diagnose.
- [ ] `grep -nE "persistAuditEntry|buildAuditEntry" src/routes/settle.ts` → **zero matches** (la route NO importa audit; solo el hook global en app.ts lo usa).
- [ ] `grep -nE "persistAuditEntry|buildAuditEntry" src/routes/verify.ts` → **zero matches**.
- [ ] `grep -nE "from '\\.\\./core/audit\\.js'" src/routes/settle.ts` → **zero o one match** (one si fue necesario para tipar `AuditMeta`; zero idealmente).
- [ ] `grep -n "addHook.*onResponse" src/app.ts` → **exactly 1 match**.
- [ ] `grep -nE "AUDIT_EXCLUDED_PATHS" src/app.ts` → **exactly 2 matches** (definición + uso en hook).
- [ ] `grep -nE "request\\.url\\b" src/app.ts` (dentro del hook) → **zero matches** (debe usar `request.routeOptions.url` — CD-12).
- [ ] `grep -nE "\\.catch\\(.*persistAuditEntry|void persistAuditEntry" src/app.ts` → **zero matches**. (**CD-14**)
- [ ] `grep -n "request\\.auditMeta = " src/routes/settle.ts` → **4 matches** (paso 1: idempotencyKey; paso 2: INVALID_PAYLOAD; paso 3: TRANSACTION_FAILED; paso 4: result.error.code).
- [ ] `grep -n "request\\.auditMeta = " src/routes/verify.ts` → **3 matches** (INVALID_PAYLOAD, TRANSACTION_FAILED, result.error.code).

---

### Wave 4 — Tests (`audit.test.ts` + integraciones en routes/health/openapi)

**Objetivo**: cubrir los 14 ACs con tests unitarios para `buildAuditEntry` / `persistAuditEntry` + tests de integración para el hook global en las 5 rutas (3 auditadas + 2 excluidas).

#### Files (W4)

| # | Path | Acción |
|---|------|--------|
| 6 | `src/__tests__/unit/audit.test.ts` | **CREATE** |
| 7 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (append tests del hook) |
| 8 | `src/__tests__/unit/routes.verify.test.ts` | **MODIFY** (append tests del hook) |
| 9 | `src/__tests__/unit/routes.supported.test.ts` | **MODIFY** (append 1 test) |
| 10 | `src/__tests__/unit/health.test.ts` | **MODIFY** (append 1 test) |
| 11 | `src/__tests__/unit/routes.openapi.test.ts` | **MODIFY** (append 1 test) |

#### W4.1 — `src/__tests__/unit/audit.test.ts` (NEW, ≥14 tests)

**Patrón mock** (copia del exemplar `ledger.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BuildAuditEntryInput } from '../../core/audit.js';

vi.mock('../../infra/supabase.js', () => {
  const insertSpy = vi.fn();
  const fromSpy = vi.fn(() => ({ insert: insertSpy }));
  const clientStub = { from: fromSpy };
  const getSupabaseClient = vi.fn(() => clientStub);
  return {
    __esModule: true,
    getSupabaseClient,
    __insertSpy: insertSpy,
    __fromSpy: fromSpy,
    __getSupabaseClient: getSupabaseClient,
    __clientStub: clientStub,
  };
});

function makeFakeLogger(): { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), debug: vi.fn() };
}
```

**Tests requeridos (≥14, uno por AC + edge cases — IDs T-A*)**:

- **T-A1 (AC-1)**: `buildAuditEntry({ requestId:'req-1', method:'POST', path:'/settle', statusCode:200, durationMs:42, ipRaw:'1.2.3.4', userAgentRaw:'Mozilla/5.0', errorCode: undefined, idempotencyKey: 'abc' })` → retorna entry con los 9 campos correctos; `error_code===null`, `idempotency_key==='abc'`.
- **T-A2 (AC-1 + CD-13)**: `buildAuditEntry(...)` output **NO contiene clave `timestamp`** (assertion: `expect(Object.keys(entry)).not.toContain('timestamp')`).
- **T-A3 (AC-3 / null client)**: `__getSupabaseClient.mockReturnValueOnce(null)` → `persistAuditEntry(entry, logger)` resolves sin llamar `__insertSpy`, sin `logger.warn` ni `logger.debug`.
- **T-A4 (AC-4, proxy-aware via builder)**: `buildAuditEntry({ ipRaw: '203.0.113.5', ... })` → `entry.ip === '203.0.113.5'`. **Nota**: el split del XFF ocurre en el **hook** (`src/app.ts`), no en el builder. El builder recibe la IP ya extraída. Este test valida que el builder no rompe al recibir IP ya limpia.
- **T-A5 (AC-5 fallback)**: `buildAuditEntry({ ipRaw: '127.0.0.1', ... })` (como si viniera de `request.ip`) → `entry.ip === '127.0.0.1'`.
- **T-A6 (AC-6 truncation IP)**: `buildAuditEntry({ ipRaw: 'x'.repeat(60), ... })` → `entry.ip!.length === 45`. También: input con exactamente 45 chars → length 45 sin modificar. Input con 44 → length 44 sin modificar.
- **T-A7 (AC-7 truncation UA)**: `buildAuditEntry({ userAgentRaw: 'a'.repeat(600), ... })` → `entry.user_agent!.length === 512`. También: exactly 512 → 512; 511 → 511.
- **T-A8 (AC-8 null UA)**: `buildAuditEntry({ userAgentRaw: null, ... })` → `entry.user_agent === null`. Variante: `userAgentRaw: ''` → también `null`.
- **T-A9 (AC-8 null IP)**: `buildAuditEntry({ ipRaw: null, ... })` → `entry.ip === null`. Variante: `ipRaw: ''` → `null`.
- **T-A10 (AC-10 fail-open async)**: `__insertSpy.mockRejectedValueOnce(new Error('network down'))` → `persistAuditEntry(entry, logger)` resolves sin throw, `logger.warn` llamado 1 vez con `{ err, request_id, path }` y mensaje `'audit client or insert failed'` (o el mensaje del try outer). **NO** re-throw.
- **T-A11 (AC-10 Supabase error response)**: `__insertSpy.mockResolvedValueOnce({ data: null, error: { message: 'permission denied', code: '42501' } })` → resolves sin throw, `logger.warn` llamado con mensaje `'audit insert failed'`, NO `logger.debug`.
- **T-A12 (AC-10 sync throw de getSupabaseClient)**: `__getSupabaseClient.mockImplementationOnce(() => { throw new Error('init fail'); })` → `persistAuditEntry(entry, logger)` resolves sin throw, `logger.warn` llamado 1 vez con mensaje `'audit client or insert failed'`. Cubre defense-in-depth.
- **T-A13 (AC-1 INSERT signature)**: `__insertSpy.mockResolvedValueOnce({ data: [{ id: 'uuid-xyz' }], error: null })` → `persistAuditEntry(entry, logger)` llama `__fromSpy('facilitator_audit_log')` con el string literal exacto Y `__insertSpy(entry)` con el objeto entry completo. **NO** `.upsert()`, **NO** `{ onConflict: ... }`.
- **T-A14 (CD-4 PII leak check)**: tras cualquier test que falle el insert — verificar que `logger.warn.mock.calls[0][0]` (el primer arg — payload object) **NO contiene** las keys `ip` ni `user_agent`. Assertion:
  ```ts
  const payload = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(payload).not.toHaveProperty('ip');
  expect(payload).not.toHaveProperty('user_agent');
  ```
- **T-A15 (CD-13 DDL parity)**: assertion estructural — `buildAuditEntry(...)` output tiene exactamente 9 keys. `expect(Object.keys(entry).sort()).toEqual(['duration_ms','error_code','idempotency_key','ip','method','path','request_id','status_code','user_agent'])`.

**Total mínimo en audit.test.ts: 15 tests** (14 AC-coverage + 1 parity).

#### W4.2 — `src/__tests__/unit/routes.settle.test.ts` (APPEND)

**Acción**: agregar mock de `../../core/audit.js` al tope (análogo al mock de `../../core/ledger.js` línea 46-56), y tests nuevos al final. NO modificar tests existing.

**Mock a agregar** (justo después del mock existing de `core/ledger.js`):

```ts
// ─── core/audit.js mock (WFAC-33 W4) ───────────────────────────────────────
vi.mock('../../core/audit.js', () => {
  const persistAuditSpy = vi.fn(async () => undefined);
  const buildAuditSpy = vi.fn((input: unknown) => ({ __auditInput: input }));
  return {
    __esModule: true,
    buildAuditEntry: buildAuditSpy,
    persistAuditEntry: persistAuditSpy,
    __persistAuditSpy: persistAuditSpy,
    __buildAuditSpy: buildAuditSpy,
  };
});
```

**Tests nuevos (IDs T-AR-*)**:

- **T-AR-1 (AC-1 integration, /settle success)**: `app.inject({ method:'POST', url:'/settle', headers:{'x-forwarded-for':'203.0.113.5, 10.0.0.1','user-agent':'curl/7.88'}, payload: validBody })` → response 200. Assertion: `__persistAuditSpy` llamado **1 vez** después del response. `__buildAuditSpy.mock.calls[0][0]` contiene `{ path:'/settle', statusCode:200, ipRaw:'203.0.113.5', userAgentRaw:'curl/7.88', idempotencyKey: <64-char hex>, errorCode: undefined }`.
- **T-AR-2 (AC-12, /settle success propaga idempotencyKey)**: mismo setup que T-AR-1 → `__buildAuditSpy.mock.calls[0][0].idempotencyKey` es string de 64 chars (hex sha256). (Complementa T-A1).
- **T-AR-3 (AC-13, /settle 400 Zod → error_code='INVALID_PAYLOAD')**: `app.inject({ url:'/settle', payload: { invalid: 'body' } })` → response 400. `__buildAuditSpy.mock.calls[0][0].errorCode === 'INVALID_PAYLOAD'`, `statusCode === 400`.
- **T-AR-4 (AC-13, /settle adapter-throw → error_code='TRANSACTION_FAILED')**: configurar fake adapter que throwea → response 500. `__buildAuditSpy.mock.calls[0][0].errorCode === 'TRANSACTION_FAILED'`, `statusCode === 500`, `idempotencyKey` presente (porque se seteó en paso 1).
- **T-AR-5 (AC-13, /settle result.ok=false → error_code=X)**: fake adapter retorna `{ ok:false, error:{ code:'INSUFFICIENT_BALANCE', http:402, message:'...' } }` → response 402. `__buildAuditSpy.mock.calls[0][0].errorCode === 'INSUFFICIENT_BALANCE'`, `statusCode === 402`.
- **T-AR-6 (AC-4, XFF array fallback)**: `app.inject({ headers: { 'x-forwarded-for': ['203.0.113.6, 10.0.0.2'] }, ... })` → `__buildAuditSpy.mock.calls[0][0].ipRaw === '203.0.113.6'`.
- **T-AR-7 (AC-5, sin XFF → request.ip fallback)**: `app.inject({ headers: {}, ... })` → `__buildAuditSpy.mock.calls[0][0].ipRaw` ≠ null (es `request.ip`, probablemente `'127.0.0.1'` en test context).
- **T-AR-8 (AC-8, sin UA header → null)**: `app.inject({ headers: {} (sin user-agent), ... })` → `__buildAuditSpy.mock.calls[0][0].userAgentRaw === null`.
- **T-AR-9 (CD-14 / AC-9, fail-open)**: `__persistAuditSpy.mockRejectedValueOnce(new Error('boom'))` → `app.inject({ url:'/settle', ... })` devuelve 200 (o 4xx/5xx según payload) **sin crash**. El mock de `persistAuditEntry` en producción no throwea (CD-1), pero este test valida que aun si throweara el hook handler de Fastify no propaga el error al caller. **Nota**: Fastify onResponse hooks que throwean solo loguean — no afectan response. Assertion razonable: response.statusCode es el esperado (200 o lo que sea del happy path), NO 500 por culpa del audit.

**Total tests nuevos en routes.settle.test.ts: 9** (T-AR-1 a T-AR-9).

**Anti-regresión**: los 22 tests existing deben seguir verdes. Si alguno falla tras el append → regresión WFAC-21/32. STOP.

#### W4.3 — `src/__tests__/unit/routes.verify.test.ts` (APPEND)

**Mock**: agregar el mismo pattern de `../../core/audit.js` al tope.

**Tests nuevos (IDs T-AV-*)**:

- **T-AV-1 (AC-1, /verify success)**: `app.inject({ url:'/verify', payload: validBody })` → 200. `__persistAuditSpy` llamado 1 vez con `{ path:'/verify', statusCode:200, errorCode: undefined, idempotencyKey: undefined }`. (`/verify` NO setea idempotencyKey en auditMeta — AC-12 aplica solo a /settle.)
- **T-AV-2 (AC-13, /verify 400 Zod → error_code='INVALID_PAYLOAD')**: `app.inject({ payload: invalidBody })` → 400. `errorCode === 'INVALID_PAYLOAD'`.
- **T-AV-3 (AC-13, /verify adapter-throw → error_code='TRANSACTION_FAILED')**: fake adapter throwea → 500. `errorCode === 'TRANSACTION_FAILED'`.
- **T-AV-4 (AC-13, /verify result.ok=false → error_code=X)**: fake adapter retorna `{ ok:false, error:{ code:'INVALID_SIGNATURE', http:400 } }` → 400. `errorCode === 'INVALID_SIGNATURE'`.
- **T-AV-5 (AC-12 nullability)**: T-AV-1 variant → `idempotency_key` en el builder input es `undefined` → entry final `idempotency_key === null`. (Complementa con un test del builder puro, pero este valida propagación end-to-end.)

**Total tests nuevos en routes.verify.test.ts: 5** (T-AV-1 a T-AV-5).

#### W4.4 — `src/__tests__/unit/routes.supported.test.ts` (APPEND)

**Mock**: `../../core/audit.js` (mismo pattern).

**Tests nuevos (ID T-ASU-*)**:

- **T-ASU-1 (AC-1, /supported SÍ es auditada)**: `app.inject({ method:'GET', url:'/supported' })` → 200. `__persistAuditSpy` llamado 1 vez con `{ path:'/supported', statusCode:200, errorCode: undefined, idempotencyKey: undefined, method:'GET' }`.

**Total tests nuevos en routes.supported.test.ts: 1**.

#### W4.5 — `src/__tests__/unit/health.test.ts` (APPEND)

**Mock**: `../../core/audit.js` (mismo pattern).

**Tests nuevos (ID T-AH-*)**:

- **T-AH-1 (AC-2, /health NO es auditada)**: `app.inject({ method:'GET', url:'/health' })` → 200. `__persistAuditSpy` **NO llamado** (`expect(persistAuditSpy).not.toHaveBeenCalled()`). También: `__buildAuditSpy` no llamado.

**Total tests nuevos en health.test.ts: 1**.

#### W4.6 — `src/__tests__/unit/routes.openapi.test.ts` (APPEND)

**Mock**: `../../core/audit.js` (mismo pattern).

**Tests nuevos (ID T-AO-*)**:

- **T-AO-1 (AC-2, /openapi.json NO es auditada — DT-8)**: `app.inject({ method:'GET', url:'/openapi.json' })` → 200. `__persistAuditSpy` NO llamado.

**Total tests nuevos en routes.openapi.test.ts: 1**.

#### Wave 4 — dependencies

- Depende de W2 + W3 (`audit.ts` existe, hook en `app.ts`, routes populate `auditMeta`).
- NO depende de W5.

#### Wave 4 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write <files>`; **CD-10**).
- [ ] **`npm test -- --run` → total ≥ 394/394** (369 baseline + ≥25 nuevos: 15 en audit.test.ts + 9 en settle + 5 en verify + 1 en supported + 1 en health + 1 en openapi = **32 nuevos** ideal).
- [ ] **Regression guard**: los 22 tests existing de `routes.settle.test.ts` siguen verdes. Los de `routes.verify.test.ts` siguen verdes. Los de `ledger.test.ts` (14) siguen verdes. Los de `supabase.test.ts` siguen verdes.
- [ ] `grep -n "__persistAuditSpy\\|__buildAuditSpy" src/__tests__/unit/*.ts` → aparece en los 5 archivos de route tests + health.
- [ ] Coverage de `src/core/audit.ts` ≥ 90% con `vitest --coverage`.

---

### Wave 5 — OWNERS.md + final QA

**Objetivo**: documentar el boundary de `src/core/audit.ts` en OWNERS.md + correr QA final.

#### Files (W5)

| # | Path | Acción |
|---|------|--------|
| 12 | `OWNERS.md` | **MODIFY** (agregar nota en la tabla o sección de excepciones) |

#### W5.1 — `OWNERS.md`

**Acción**: agregar una nota breve sobre `src/core/audit.ts` en la matriz de boundaries o en una sección nueva de "Runtime boundaries — core modules".

**Contenido sugerido (adaptar al tono existente del archivo — ver líneas 33-57 para precedente `core/errors.ts`):**

```md
### [2] `src/core/audit.ts` — observabilidad HTTP (WFAC-33)

`src/core/audit.ts` sigue el mismo boundary que `src/core/ledger.ts`:

- **MAY import**: `src/infra/supabase.ts` (runtime, solo `getSupabaseClient`),
  `pino` (type-only), `fastify` (type-only, para `declare module 'fastify'`),
  `src/core/types.ts` (type-only, para `X402ErrorCode`).
- **MUST NOT import**: `@supabase/supabase-js` directo (acceso vía wrapper),
  `src/chains/*`, `src/methods/*`, `src/routes/*`.
- **Consumido desde**: `src/app.ts` (hook global `onResponse`).
  Las routes `src/routes/settle.ts` y `src/routes/verify.ts` **NO** importan
  `audit.ts` directamente — solo setean el decorator opcional `request.auditMeta`
  (cuya firma vive en `audit.ts` vía `declare module 'fastify'`).

Origen: **WFAC-33**.
```

**Alternativa minimalista**: si la tabla de la matriz (líneas 20-34) es preferida, agregar una fila como `src/core/audit.ts` con las mismas reglas que `src/core/ledger.ts` — pero la tabla actual es por módulo genérico (`src/core/`), no por archivo. Más natural es agregar la nota `[2]` abajo.

**Checklist W5.1**:

- [ ] `OWNERS.md` menciona explícitamente `src/core/audit.ts`.
- [ ] Queda claro que `audit.ts` NO puede ser importado desde `src/chains/*` o `src/methods/*`.
- [ ] Referencia a WFAC-33 presente.

#### W5.2 — QA final

```bash
npm run qa
```

Este comando corre `typecheck + lint + format:check + test`. **Debe exit 0**.

**Si falla**:

- `format:check` → `npx prettier --write <archivo>` y re-run (**CD-10**).
- `lint` → revisar cada warning/error contra los CDs.
- `test` → identificar test fallido. Si es regresión (suite previa) → bug en W3/W4, diagnose. Si es expectativa desalineada → ajustar el test (NUNCA el feature).

#### W5.3 — Regression guard CRÍTICO final

- [ ] `npm test -- --run` → **≥394/394**.
- [ ] Los 369 tests previos al WFAC-33 siguen **todos verdes**.
- [ ] Ejecutar `npm test -- --run routes.settle` → WFAC-21 + WFAC-32 + WFAC-33 tests verdes.
- [ ] Ejecutar `npm test -- --run routes.verify` → WFAC-20 + WFAC-33 verdes.
- [ ] Ejecutar `npm test -- --run ledger` → WFAC-32 verdes (14 tests).
- [ ] Ejecutar `npm test -- --run supabase` → WFAC-32 verdes.
- [ ] Ejecutar `npm test -- --run health` → WFAC-2 + WFAC-33 verdes.

#### Wave 5 — completion criteria

- [ ] `npm run qa` → exit 0 sin warnings.
- [ ] **≥394/394** tests pasan.
- [ ] `git diff OWNERS.md` → solo agrega sección `[2]` / nota sobre `audit.ts`.
- [ ] `git status` limpio de archivos fuera del Scope IN.
- [ ] **`.env.example` NO modificado** (las vars ya estaban de WFAC-32).
- [ ] **`package.json` NO modificado** (sin dep nuevas).

---

## 2. AC → Wave → Test matrix (14 ACs)

| AC | Descripción | Wave(s) | Test(s) que cubre | Archivo |
|----|-------------|---------|-------------------|---------|
| **AC-1** | Hook inserta 1 row con request_id/timestamp/method/path/status_code/duration_ms | W2 + W3 + W4 | T-A1, T-A2, T-A13, T-AR-1, T-AV-1, T-ASU-1 | `audit.test.ts`, `routes.{settle,verify,supported}.test.ts` |
| **AC-2** | `/health` + `/openapi.json` NO auditadas | W3 + W4 | T-AH-1, T-AO-1 | `health.test.ts`, `routes.openapi.test.ts` |
| **AC-3** | `getSupabaseClient() === null` → no-op silencioso | W2 + W4 | T-A3 | `audit.test.ts` |
| **AC-4** | XFF presente → primer IP al `ip` | W3 + W4 | T-A4, T-AR-1, T-AR-6 | `audit.test.ts`, `routes.settle.test.ts` |
| **AC-5** | XFF ausente → `request.ip` fallback | W3 + W4 | T-A5, T-AR-7 | `audit.test.ts`, `routes.settle.test.ts` |
| **AC-6** | IP > 45 chars → truncate a 45 | W2 + W4 | T-A6 | `audit.test.ts` |
| **AC-7** | UA presente → hasta 512 chars al `user_agent` | W2 + W4 | T-A7 | `audit.test.ts` |
| **AC-8** | UA ausente/empty → `user_agent = null` | W2 + W4 | T-A8, T-AR-8 | `audit.test.ts`, `routes.settle.test.ts` |
| **AC-9** | INSERT corre POST-response — sin latencia observable | W3 + W4 | T-AR-9 (fail-open asserting no-5xx) | `routes.settle.test.ts` |
| **AC-10** | INSERT error → warn + continue, no propaga | W2 + W4 | T-A10, T-A11, T-A12, T-A14 | `audit.test.ts` |
| **AC-11** | Tabla sin UPDATE/DELETE en código | W1 + W2 | DDL review + `grep -nE "UPDATE\|DELETE" src/core/audit.ts` → zero | manual + grep |
| **AC-12** | `/settle` → idempotency_key poblado; link con settlements | W3 + W4 | T-A1 (opcional), T-AR-1, T-AR-2, T-AV-5 | `routes.{settle,verify}.test.ts` |
| **AC-13** | status no-2xx → error_code poblado si disponible | W3 + W4 | T-AR-3, T-AR-4, T-AR-5, T-AV-2, T-AV-3, T-AV-4 | `routes.{settle,verify}.test.ts` |
| **AC-14** | DDL incluye COMMENT ON TABLE con retention 90d | W1 | DDL grep: `grep "90d" supabase/migrations/002_*.sql` | manual |

**Total nuevos tests (mínimo)**: 15 (audit.test.ts) + 9 (settle) + 5 (verify) + 1 (supported) + 1 (health) + 1 (openapi) = **32 ≥ 25 target**. Final test count: **≥ 394 + stretch = ~401**.

---

## 3. Constraint Directives — 14 CDs (9 heredados WI + 5 nuevos SDD)

### 3.1 Heredados del work-item (CD-1..CD-9)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-1** | PROHIBIDO que `persistAuditEntry` throwee al caller — todo error capturado + log warn | `src/core/audit.ts` (W2) |
| **CD-2** | PROHIBIDO `UPDATE`/`DELETE` en `facilitator_audit_log` desde `src/core/audit.ts` — solo `INSERT` puro sin onConflict | `src/core/audit.ts` (W2), `supabase/migrations/002_*.sql` (W1) |
| **CD-3** | PROHIBIDO importar `@supabase/supabase-js` directo en `audit.ts` — solo via `getSupabaseClient()` | `src/core/audit.ts` (W2) |
| **CD-4** | PROHIBIDO loguear `user_agent` o `ip` en logs de aplicación (PII) — solo van a DB row | `src/core/audit.ts` (W2) |
| **CD-5** | PROHIBIDO `console.*` en `audit.ts` — usar logger inyectado | `src/core/audit.ts` (W2) |
| **CD-6** | OBLIGATORIO filtrar `/health` y `/openapi.json` en el hook vía `request.routeOptions.url` | `src/app.ts` (W3) |
| **CD-7** | `buildAuditEntry` es pure function — sin side effects, sin logger | `src/core/audit.ts` (W2) |
| **CD-8** | OBLIGATORIO truncation `ip→45` y `user_agent→512` dentro de `buildAuditEntry` (antes de llegar a persist) | `src/core/audit.ts` (W2) |
| **CD-9** | PROHIBIDO lógica x402 en `audit.ts` — sin chainId, sin amount, sin methods | `src/core/audit.ts` (W2) |

### 3.2 Nuevos del SDD (CD-10..CD-14)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-10** (auto-blindaje WFAC-22/23) | OBLIGATORIO correr `npx prettier --write <archivos>` antes de cada wave commit. No asumir line-breaks estéticos | Todas las waves |
| **CD-11** (resuelve NC-4) | Las rutas `/settle` y `/verify` DEBEN setear `request.auditMeta = { ...request.auditMeta, errorCode: X }` ANTES del `reply.send(...)`. En paths de error sin seteo, el audit row queda con `error_code = NULL` para status ≥400 (defecto visible, no bloqueante) | `src/routes/settle.ts`, `src/routes/verify.ts` (W3) |
| **CD-12** | El `onResponse` hook DEBE usar `request.routeOptions.url` (path declarado, sin query string). PROHIBIDO `request.url` | `src/app.ts` (W3) |
| **CD-13** | `AuditEntry` NO incluye `timestamp` en el objeto enviado al INSERT — DB genera via DEFAULT NOW(). Si la entry tuviera `timestamp: string`, Postgres lo sobrescribiría y perdería el default — PROHIBIDO | `src/core/audit.ts` (W2), DDL (W1) |
| **CD-14** | El hook `onResponse` usa `await persistAuditEntry(...)` (Fastify v5 dispara post-flush). PROHIBIDO `.catch()` o `void persistAuditEntry(...)` — ambos violan auditabilidad (no esperan al pipeline de error interno) | `src/app.ts` (W3) |

---

## 4. Guardrails anti-drift (checklist rápido para el Dev)

**Antes de cada commit, corré mentalmente esta lista**:

- [ ] **NO `throw` desde `persistAuditEntry`**. Todo error capturado internamente. (**CD-1**)
- [ ] **NO `UPDATE` / `DELETE` en `facilitator_audit_log`** — solo `INSERT` puro sin `onConflict`. (**CD-2**)
- [ ] **NO `import ... from '@supabase/supabase-js'`** en `src/core/audit.ts`. (**CD-3**)
- [ ] **NO `logger.warn({ ip, user_agent, ... })`** — nunca PII en logs de app. (**CD-4**)
- [ ] **NO `console.log`** en ningún módulo nuevo. (**CD-5**)
- [ ] **NO auditar `/health` ni `/openapi.json`** — deben estar en `AUDIT_EXCLUDED_PATHS`. (**CD-6 + DT-8**)
- [ ] **NO side effects en `buildAuditEntry`** — sin `Date.now()` dentro, sin `logger`, sin I/O. (**CD-7**)
- [ ] **NO omitir truncation** — `ip.slice(0, 45)`, `user_agent.slice(0, 512)`. (**CD-8**)
- [ ] **NO importar chains/methods/routes** en `audit.ts`. (**CD-9**)
- [ ] **NO olvidar `npx prettier --write`** antes de cerrar wave. (**CD-10**)
- [ ] **NO asignación directa `request.auditMeta.errorCode = X`** — siempre spread `= { ...request.auditMeta, errorCode: X }`. (**CD-11**)
- [ ] **NO `request.url`** en el hook — siempre `request.routeOptions.url`. (**CD-12**)
- [ ] **NO incluir `timestamp` en el objeto INSERT** — DB genera. (**CD-13**)
- [ ] **NO `persistAuditEntry(...).catch(...)` ni `void persistAuditEntry(...)`** en `app.ts` — siempre `await`. (**CD-14**)
- [ ] **NO tocar `src/core/settle.ts` ni `src/core/verify.ts`** — core pure. (**Scope IN**)
- [ ] **NO agregar deps nuevas en `package.json`** — `@supabase/supabase-js` ya instalado. (**Scope IN**)
- [ ] **NO modificar `src/infra/env.ts`** — vars YA existen de WFAC-32. (**Scope IN**)
- [ ] **NO modificar `src/infra/supabase.ts`** — se consume, no se expande. (**Scope IN**)
- [ ] **NO modificar `.env.example`**. (**Scope IN**)
- [ ] **NO modificar `supabase/migrations/001_*.sql`** — frozen post-merge (WFAC-32 CD-16).
- [ ] **NO agregar hook `onRequest`** para inicializar `request.auditMeta` — decorator es opcional (`auditMeta?`) y el hook tolera `undefined`.
- [ ] **NO agregar `onClose` hook** para Supabase (ya resuelto WFAC-32 CD-15).

### Regression guard CRÍTICO (tras cada wave, antes del próximo commit)

- [ ] `npm test -- --run` sigue verde para el baseline 369 tests previos.
- [ ] `npm test -- --run routes.settle` → 22 tests WFAC-21/32 existing siguen verdes + los nuevos T-AR-* pasan.
- [ ] `npm test -- --run routes.verify` → tests WFAC-20 existing siguen verdes + los nuevos T-AV-* pasan.
- [ ] `npm test -- --run ledger` → 14 tests WFAC-32 existing siguen verdes.
- [ ] `npm test -- --run supabase` → tests WFAC-32 existing siguen verdes.
- [ ] **≥394/394 mínimo al final de W4+W5**. Si ves <394 → hay regresión o faltan tests, STOP + diagnose.
- [ ] Si test del tipo "existing WFAC-21 settle success" falla → el hook está rompiendo algo. Revisar si el mock de `../../core/audit.js` está bien setup (el settle test mockea ambos `core/ledger` y `core/audit`).

---

## 5. Done Definition (HU-33)

- [ ] Todas las waves W1-W5 cerradas con sus completion criteria.
- [ ] `npm run qa` exit 0.
- [ ] **≥ 394 tests passing** (369 baseline + ≥25 nuevos, target 32).
- [ ] 12 archivos del Scope IN tocados; **ningún archivo fuera del Scope IN modificado**.
- [ ] Migration `002_facilitator_audit_log.sql` creada, idempotente, con `COMMENT ON TABLE` referenciando retention 90d + `TD-RETENTION-01`.
- [ ] `src/core/audit.ts` exporta `AuditMeta`, `AuditEntry`, `BuildAuditEntryInput`, `AuditLogger`, `buildAuditEntry`, `persistAuditEntry`.
- [ ] `src/core/audit.ts` incluye `declare module 'fastify' { interface FastifyRequest { auditMeta?: AuditMeta } }`.
- [ ] `src/app.ts` registra hook `onResponse` global que filtra `AUDIT_EXCLUDED_PATHS = { '/health', '/openapi.json' }`, extrae IP/UA, llama `await persistAuditEntry(...)`.
- [ ] `src/routes/settle.ts` popula `request.auditMeta` en 4 puntos (idempotencyKey post-paso-2, errorCode en 3 error paths). Success path no setea errorCode.
- [ ] `src/routes/verify.ts` popula `request.auditMeta.errorCode` en 3 error paths. Success path no setea. NO popula `idempotencyKey`.
- [ ] Los 14 CDs respetados (9 heredados + 5 nuevos).
- [ ] `.env.example` intacto. `package.json` intacto. `supabase/migrations/001_*.sql` intacto.
- [ ] `src/core/settle.ts` y `src/core/verify.ts` intactos (CD-9 — core puro).
- [ ] `src/infra/supabase.ts` y `src/infra/env.ts` intactos (consumidos, no modificados).
- [ ] `OWNERS.md` incluye nota sobre `src/core/audit.ts` (mismo boundary que `ledger.ts`).
- [ ] Commit messages con prefix `WFAC-33` y referencia a la wave (ej: `WFAC-33 W1: migration 002 audit log DDL`).

---

## 6. Referencias rápidas

- **Work Item**: `doc/sdd/014-wfac-33-audit-log/work-item.md`
- **SDD completo**: `doc/sdd/014-wfac-33-audit-log/sdd.md`
- **Baseline post-WFAC-32**: 369/369 tests passing
- **Target post-WFAC-33**: ≥ 394/394
- **Branch**: `feat/014-wfac-33-audit-log` (desde `main` post-WFAC-32)
- **Supabase vars**: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (ya existentes, .env.example líneas 59-60)
- **Convención migration**: `NNN_descripcion.sql` (padding 3 dígitos, idempotente, `COMMENT ON TABLE` incluye retention 90d)
- **Patrón referencia**: `src/core/ledger.ts` (pure builder + fail-open persist) + `src/infra/supabase.ts` (singleton wrapper)
- **Tablas relacionadas**: `facilitator_settlements` (WFAC-32, linkeada via `idempotency_key`)
- **HUs dependientes (future)**: `TD-RETENTION-01` (cron 90d), `WKH-SEC-0X` (RLS Postgres-level)

---

*Story File generado por NexusAgil — F2.5 — WFAC-33 — 2026-04-23 — Architect*
