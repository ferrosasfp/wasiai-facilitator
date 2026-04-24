# SDD #013: Settlement Ledger — Supabase `facilitator_settlements` (WFAC-32)

> SPEC_APPROVED: no
> Fecha: 2026-04-23
> Tipo: feature (infra)
> SDD_MODE: full
> Pipeline: QUALITY
> Branch: `feat/013-wfac-32-settlement-ledger`
> Artefactos: `doc/sdd/013-wfac-32-settlement-ledger/`
> Work Item: `doc/sdd/013-wfac-32-settlement-ledger/work-item.md`

---

## 1. Resumen

Introducir una capa de persistencia Postgres (Supabase) que registre cada resultado de
`POST /settle` — tanto exitoso (on-chain settled) como fallido (4xx x402 y 5xx adapter
errors) — en la tabla `facilitator_settlements`. La persistencia es **fire-and-forget**:
se ejecuta entre `adapter.settle()` y el `reply.send()`, y si la escritura falla el
servicio igual responde al cliente sin alterar el resultado ya producido on-chain.

El objetivo primario es **auditabilidad off-chain** + **métricas de volumen/chain/asset**
+ **reconciliación post-dispute**. NO reemplaza la cache de idempotencia en Redis (120 s)
ni el audit log inmutable de WFAC-33.

Diseño adopta el patrón singleton-lazy-init de `src/infra/redis.ts` (WFAC-5) y la
frontera core→infra de `src/core/idempotency.ts` → `src/infra/redis.ts`.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | WFAC-32 (SDD 013) |
| **Tipo** | feature (infra / persistencia) |
| **SDD_MODE** | full |
| **Objetivo** | Persistir cada resultado de `/settle` en Supabase antes de responder al cliente, sin bloquear la respuesta ante fallos de DB. |
| **Reglas de negocio** | Persistencia fire-and-forget. Sólo datos on-chain + metadata técnica (idempotency_key hex, duration_ms). PII HTTP (IP, UA) queda OUT — WFAC-33. |
| **Scope IN** | `src/infra/supabase.ts` (nuevo), `src/core/ledger.ts` (nuevo), `src/infra/env.ts` (+2 vars), `src/routes/settle.ts` (hook), `src/app.ts` (initSupabase), `supabase/migrations/001_facilitator_settlements.sql` (nuevo), `package.json` (+1 dep), 2 tests unit (nuevos). |
| **Scope OUT** | `facilitator_audit_log` (WFAC-33), RLS policies (TD), BullMQ retry queue (V1.5), `/verify` ledger, dashboards, métricas Prometheus del ledger, `facilitator_idempotency` persistente. |
| **Missing Inputs** | Ninguno bloqueante. Los 5 [NEEDS CLARIFICATION] del work-item se resuelven en §4.2 / §5. |

### 2.1 Acceptance Criteria (heredados del work-item)

Los 12 ACs del work-item se adoptan íntegros. Referencia breve:

| AC | Esencia | Verificación |
|----|---------|--------------|
| AC-1 | Success → INSERT status='success' con 9 campos antes del reply 200 | Test integración route |
| AC-2 | Error x402 4xx → INSERT status='failed' con error_code/error_http antes del reply | Test integración route |
| AC-3 | DB error → log warn + reply sin modificar (fail-open) | Test unit ledger + test route |
| AC-4 | Env vars ausentes → skip ledger + warn startup, no crash | Test unit + test buildApp |
| AC-5 | UNIQUE conflict en idempotency_key → UPSERT ON CONFLICT DO NOTHING + log debug | Test unit ledger |
| AC-6 | prod/dev + ambas vars → singleton activo | Test unit supabase |
| AC-7 | test + sin SUPABASE_URL → no-op en todo el ledger | Test unit ledger + supabase |
| AC-8 | SUPABASE_URL inválida → parseEnv fail-fast con Zod | Test unit env |
| AC-9 | NO PII HTTP en la tabla (payer/payee addr OK, IP/UA NO) | Grep schema + review migration |
| AC-10 | SERVICE_KEY nunca en logs (mismo rigor que OPERATOR_PRIVATE_KEY) | Test unit supabase (log assertion) |
| AC-11 | `persistLedgerEntry` invocado desde route, no desde `src/core/settle.ts` | Grep route + OWNERS check |
| AC-12 | `src/infra/supabase.ts` replica patrón `redis.ts` (init/get/resetForTests) | Test unit supabase |

Además (resolución NC-1, §4.2.1): persistir también resultados 5xx del adapter y el catch
defensivo del route (TRANSACTION_FAILED 500) bajo `status='failed'` → cubierto por **AC-2**
con nota: *"non-5xx x402 error"* se extiende a *"any x402 error including 500"*.
Esta reinterpretación se formaliza como nuevo **AC-2-extended** en §4.2.1.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos y patrón extraído

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/infra/redis.ts` (188 LOC) | Ejemplar DIRECTO del singleton lazy-init con null-return fallback. | Module-level state (`_client, _env, _logger, _initialized`); `initX(env, logger)` idempotente; `getXClient(): Client \| null`; `resetXClientForTests()`. Log con URL/endpoint redactado. CD: swallow errors via event handlers, never throw. |
| `src/infra/env.ts` (58 LOC) | Patrón Zod EnvSchema + `parseEnv()` fail-fast (stderr + process.exit(1)). | `z.string().min(1).optional()` para vars opcionales; `z.string().url()` para URLs; `.superRefine()` para reglas cross-field prod-vs-test. |
| `src/infra/logger.ts` (32 LOC) | Shape del Pino Logger + `Pick<Logger, 'info'\|'error'\|'warn'>`. | Confirma que el logger NO se instancia en el módulo de infra — se pasa como argumento en `initX()`. |
| `src/core/idempotency.ts` (359 LOC) | Ejemplar de módulo `src/core/*` que importa `src/infra/*` (via `getRedisClient`). Valida boundary OWNERS. | Core importa infra (solo el getter). Errores de infra se **swallowean** dentro del core (try/catch → return null / no-op). Caller (route) es dueño del log. |
| `src/routes/settle.ts` (243 LOC) | Hook point. `startMs` en línea 62 reusable para `duration_ms`. | Post-adapter cache write en líneas 133-138 (existing `toCacheableSettle`). El hook del ledger va **inmediatamente después** del cache write y ANTES de `reply.send()`. |
| `src/chains/types.ts` líneas 101-109 | Shape de `SettleResult` (discriminated union via `AdapterResult<SettleResult>`). | 7 campos spec-literal: `settled, transactionHash, blockNumber, amount, from, to, asset`. `blockNumber: number` (no `bigint`); debe serializarse como BIGINT en SQL. |
| `src/core/errors.ts` líneas 44-55 | Mapping `X402ErrorCode → HTTP`. | `error_code` en la tabla vs `error_http`: dos columnas separadas, NOT NULL juntas en row failed / NULL juntas en row success. Check constraint en DDL valida exhaustividad. |
| `src/core/types.ts` líneas 32-42 | `X402ErrorCode` literal union (10 codes). | Enum SQL NO — usamos TEXT + CHECK porque el set es estable pero Supabase dashboard es friendlier con TEXT. |
| `.env.example` líneas 56-60 | Nombres canónicos: `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` (NO `SUPABASE_SERVICE_ROLE_KEY`). | DT-1 del work-item confirmado: adoptar `SUPABASE_SERVICE_KEY`. |
| `supabase/migrations/README.md` | Convención de migrations del proyecto: `NNN_descripcion.sql` con padding 3 dígitos, idempotente, orden inmutable. | **Resuelve NC-4**: archivo `001_facilitator_settlements.sql`. WFAC-32 es la PRIMERA migration — no hay precedentes conflictivos. |
| `src/app.ts` (79 LOC) | Bootstrap: `initRedis()` + `onClose` hook. | `initSupabase()` sigue el mismo ciclo. `onClose` NO necesario (Supabase client HTTP-based, no conexión persistente a liberar) — ver DT-9. |
| `src/__tests__/unit/redis.test.ts` (325 LOC) | Ejemplar de `vi.mock('ioredis', ...)` con `RedisMock` class + `__constructorSpy` + `__emit`. Patrón de `beforeEach(resetRedisClientForTests)`. | **Copia literal** para `supabase.test.ts`: `vi.mock('@supabase/supabase-js', ...)` con `SupabaseMock` class + `__createClientSpy` + `__insertSpy`. |
| `src/__tests__/unit/core.idempotency.settle.test.ts` (líneas 30-80) | Patrón de `.get/.set` stubeado por `vi.fn` + store Map. | **Copia patrón** para mock de `.from('…').upsert(…)` en `ledger.test.ts`. |
| `tsconfig.json` | `module: "Node16"`, `moduleResolution: "node16"`, `esModuleInterop: true`, `strict + noUncheckedIndexedAccess`. | **Precaución clave**: `@supabase/supabase-js` es ESM con `createClient` named export; no default export. Import correcto: `import { createClient, type SupabaseClient } from '@supabase/supabase-js'`. WFAC-5 auto-blindaje documentó el hazard equivalente para ioredis. |
| `package.json` (74 LOC) | Estado actual de deps. `@supabase/supabase-js` NO está instalado. Viem 2.47, Fastify 5.8, Zod 3.23, Pino 9.5. | Agregar `@supabase/supabase-js`: ver §4.2.3 (NC-3 resolution). |
| `OWNERS.md` sección 1.3 y tabla líneas 21-32 | Boundary `src/core/*` MAY import `src/infra/*`; `src/chains/*` MUST NOT. | Valida AC-11 + CD-3 del work-item: `ledger.ts` va en `src/core/` (puede importar infra) y NO en `src/routes/` directo. |

### 3.2 Auto-Blindaje histórico — patrones recurrentes aplicables

Revisión de los últimos 3 HUs DONE con auto-blindaje (012 OpenAPI, 011 supported-route,
010 settle-route):

| Patrón recurrente | Frecuencia | Cómo se previene en esta HU |
|-------------------|------------|------------------------------|
| **Prettier failures en archivos nuevos** (WFAC-22, WFAC-23) | 2/3 | **CD-9 nuevo**: correr `npx prettier --write` antes de cada wave commit. Documentado en Story File. |
| **`no-unused-vars` en imports no consumidos directamente** (WFAC-20) | 1/3 | **CD-10 nuevo**: importar SÓLO lo que se consume directamente en el archivo; `type X` → `import type { X }`. |
| **`security/detect-object-injection` en Record lookups dinámicos** (WFAC-23) | 1/3 | **CD-11 nuevo**: cualquier `RECORD[variableKey]` en `errors.ts`/`ledger.ts` requiere el eslint-disable comment con justificación, patrón idéntico a `src/core/errors.ts` líneas 101-104. |
| **CJS/ESM default-import hazard (ioredis)** (WFAC-5 → relevante para Supabase) | 1/3 | **CD-12 nuevo**: `@supabase/supabase-js` expone `createClient` como **named export** ESM. Importar `import { createClient, type SupabaseClient } from '@supabase/supabase-js'`. Nunca `import supabase from '@supabase/supabase-js'`. |
| **Rest-spread destructure + `no-unused-vars`** (WFAC-20 W1, WFAC-21) | 2/3 | **CD-13 nuevo**: construir objetos INSERT del ledger explícitamente (9 campos listados por nombre), no con `{ ...result }`. Mismo patrón que `src/routes/settle.ts` líneas 169-177 y `toCacheableSettle`. |
| **Unreachable defensive branches bajan coverage** (WFAC-20) | 1/3 | Nota en §7 Riesgos: no agregar try/catch alrededor de rutas ya guardadas por tipos discriminados. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Fuente |
|-------|--------|---------------------|--------|
| `facilitator_settlements` | **NO** — se crea en esta HU | (ver §4.2.4 DDL completo) | Supabase dedicado `wasiai-facilitator` |
| `facilitator_audit_log` | NO — WFAC-33 | — | scope OUT |
| `facilitator_idempotency` | NO — deferred (persistencia > 120 s) | — | scope OUT |

El Supabase project ya está aprovisionado (SUPABASE_URL + SUPABASE_SERVICE_KEY en
`.env.example`); la migration se apliará vía `supabase db push` o equivalente.

### 3.4 Componentes reutilizables encontrados

- **`canonicalStringify` + `createHash('sha256')`** en `src/core/idempotency.ts` líneas
  108-126 y 285-289 → ya se usa para generar el `idempotency_key` que la tabla
  necesita. **No duplicar**: el ledger recibirá el hash como parámetro (ya calculado
  por la route en `src/routes/settle.ts` línea 89).
- **`Pick<Logger, 'info' \| 'error' \| 'warn' \| 'debug'>`** en `src/infra/redis.ts`
  línea 46 (`RedisLogger`) → replicar como `SupabaseLogger` en `src/infra/supabase.ts`.
- **`redactRedisUrl`** en `src/infra/redis.ts` líneas 149-158 → crear análogo
  `redactSupabaseKey(raw: string): string` que enmascare la service key (mostrar sólo
  primeros 8 chars + `…`). CD-2 del work-item.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear / modificar

| # | Archivo | Acción | Descripción | Exemplar verificado |
|---|---------|--------|-------------|---------------------|
| 1 | `supabase/migrations/001_facilitator_settlements.sql` | **Crear** | DDL de la tabla + 3 índices + CHECK constraints. Idempotente. | `supabase/migrations/README.md` convention |
| 2 | `package.json` | Modificar | Agregar `@supabase/supabase-js: ^2.45.0` a `dependencies`. | `package.json` líneas 23-35 (bloque deps actual) |
| 3 | `src/infra/env.ts` | Modificar | Agregar `SUPABASE_URL: z.string().url().optional()` y `SUPABASE_SERVICE_KEY: z.string().min(1).optional()` al EnvSchema. NO agregar superRefine (CD-4 work-item). | `src/infra/env.ts` líneas 21-22 (pattern `REDIS_URL`) |
| 4 | `src/infra/supabase.ts` | **Crear** | Singleton lazy-init: `initSupabase(env, logger)`, `getSupabaseClient(): SupabaseClient \| null`, `resetSupabaseClientForTests()`, `redactSupabaseKey(raw): string`. | `src/infra/redis.ts` 188 LOC completo |
| 5 | `src/core/ledger.ts` | **Crear** | `LedgerEntry` type + `persistLedgerEntry(entry, logger): Promise<void>` fire-and-forget (swallow-all). `buildLedgerEntry(...)` helper para mapear `AdapterResult<SettleResult>` → `LedgerEntry`. | `src/core/idempotency.ts` 359 LOC completo |
| 6 | `src/routes/settle.ts` | Modificar | Insertar llamadas a `buildLedgerEntry` + `persistLedgerEntry` en 3 puntos: (a) después del cache write línea 138 en branch success, (b) después del log warn línea 152 en branch error x402, (c) dentro del catch línea 130 en branch adapter-throw 500. `await` opcional porque fire-and-forget (ver DT-7 abajo). | `src/routes/settle.ts` estructura actual líneas 60-179 |
| 7 | `src/app.ts` | Modificar | Agregar `initSupabase(env, logger)` inmediatamente después de `initRedis(env, logger)` (línea 51). Sin `onClose` hook (Supabase-js no mantiene conexiones TCP persistentes). | `src/app.ts` línea 51 (`initRedis`) |
| 8 | `src/__tests__/unit/supabase.test.ts` | **Crear** | Tests del singleton: mock de `@supabase/supabase-js`, `redactSupabaseKey`, null-return en test env, init idempotente, `resetSupabaseClientForTests`. | `src/__tests__/unit/redis.test.ts` 325 LOC completo |
| 9 | `src/__tests__/unit/ledger.test.ts` | **Crear** | Tests de `persistLedgerEntry`: happy path INSERT, UPSERT on conflict no-op (AC-5), fail-open (AC-3), no-op cuando client es null (AC-4/AC-7), `buildLedgerEntry` mapping correcto (9 campos). | `src/__tests__/unit/core.idempotency.settle.test.ts` pattern mock + Map store |
| 10 | `src/__tests__/unit/env.test.ts` | Modificar (append) | Tests nuevos: `SUPABASE_URL` inválida → parseEnv fail (AC-8); `SUPABASE_URL` válida + SERVICE_KEY → parse OK; ambas ausentes en `NODE_ENV='production'` → parse OK (no superRefine, CD-4). | `src/__tests__/unit/env.test.ts` patrón existente |

**Total**: 5 archivos nuevos + 5 modificaciones. Total LOC estimado: ~580 (incluye SQL
+ tests).

### 4.2 Resolución de [NEEDS CLARIFICATION] del work-item

#### 4.2.1 NC-1 — ¿Persistir 5xx del adapter (TRANSACTION_FAILED 500)?

**Resolución: SÍ**. Persistir todos los resultados del adapter (success + failed 4xx +
failed 5xx), incluyendo el catch defensivo del route (`settle adapter threw`, línea 111-130
de `src/routes/settle.ts`).

Justificación:

1. **Debugging de incidentes** en producción requiere ver los 500s. La mayoría de los
   500s son `SIMULATION_FAILED` (RPC flake) o `TRANSACTION_FAILED` (revert on-chain);
   ambos son exactamente lo que el ledger debe capturar para post-mortem.
2. **Reconciliación**: si el cliente dice "me cobraste X" y la tx revirtió, el ledger
   es la evidencia de que SÍ intentamos y la razón del fallo.
3. **Volumetría real** del facilitator — una métrica basada sólo en éxitos oculta
   saturación del RPC o degradación de chain.

**Impacto en ACs**: se agrega **AC-2-extended** (nuevo, derivado):

> **AC-2-extended**: WHEN POST /settle results in a 5xx error (adapter throw mapped to
> `TRANSACTION_FAILED` 500, or x402 `SIMULATION_FAILED`/`TRANSACTION_FAILED` from the
> method), THEN the system SHALL INSERT a row with `status='failed'`,
> `error_code='TRANSACTION_FAILED'` (or the adapter-returned code), `error_http=500`,
> `tx_hash=NULL`, `block_number=NULL`, `duration_ms` populated, BEFORE sending the 500
> response to the client.

#### 4.2.2 NC-2 — UPSERT vs INSERT

**Resolución: UPSERT con `ON CONFLICT (idempotency_key) DO NOTHING`**.

Justificación:

1. **Simplicidad**: Supabase-js `supabase.from('…').upsert(payload, { onConflict: 'idempotency_key', ignoreDuplicates: true })` es un one-liner que no genera Supabase errors en logs ruidosos.
2. **Silencio explícito**: el caso de conflict (crash del proceso entre `adapter.settle`
   y el Redis cache write) es un **no-error** desde la lógica del ledger — la primera
   persistencia ya guardó los datos autoritativos. Un `.eq()` + `INSERT` + catch de
   código `23505` sería 3× más código para el mismo resultado.
3. **Observabilidad suficiente**: el log `debug` que AC-5 exige ("treat conflict as
   no-op, log debug") se emite igualmente cuando el UPSERT devuelve `data=null` +
   `error=null` (path ignoreDuplicates).

**Alternativa considerada y rechazada**: INSERT + catch explícito `PGRST116`/`23505`.
Rechazada porque agrega superficie de logs ruidosos sin ganancia: los conflicts reales
son eventos raros de diagnóstico no-actionable.

**Código conceptual** (NO es el SDD prescribiendo código, es aclaración semántica):

```
const { error } = await client
  .from('facilitator_settlements')
  .upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true });
if (error) { logger.warn({ err: error, idempotency_key, network }, 'ledger upsert failed'); return; }
// success path — no log (only debug if .data indica que fue duplicate no-op)
```

#### 4.2.3 NC-3 — Versión de `@supabase/supabase-js`

**Resolución: `@supabase/supabase-js: ^2.45.0`**.

Research: `npm view @supabase/supabase-js version` → latest `2.104.1` (2026-04-23).
Todo el rango `^2.45.x` → `^2.104.x` es estable, Node 20 ESM compatible, no hay v3 en
GA. El rango `^2.45.0` da compatibilidad hacia adelante con 2.x sin breaking changes
esperados (Supabase respeta semver para la v2).

**Versión pinada**: `^2.45.0` (permitir `npm install` a resolver la patch más reciente
dentro del mayor 2; evita lockstep rígido).

**Lockfile**: `package-lock.json` va a pinear la versión concreta resolvida al momento
de instalar. Dev debe commitear el lockfile regenerado.

**Compatibilidad**:
- ESM (named export `createClient`): OK con `"type": "module"` del proyecto.
- Node 20 LTS: OK (Supabase-js soporta Node >=18).
- TypeScript strict + `noUncheckedIndexedAccess`: OK (Supabase-js tiene type defs
  v2-first-class).
- CJS/ESM hazard: Supabase-js v2 expone `createClient` como named export; import
  correcto `import { createClient, type SupabaseClient } from '@supabase/supabase-js';`.
  NO `import supabase from …`. CD-12 §3.2.

#### 4.2.4 NC-4 — Migration naming convention

**Resolución: `supabase/migrations/001_facilitator_settlements.sql`**.

Fuente: `supabase/migrations/README.md` (proyecto) líneas 9-27 — convención adoptada
del patrón `luma-ai`:

1. Padding 3 dígitos: `NNN_descripcion.sql`.
2. Idempotente: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
3. Orden inmutable: nunca renombrar ni reordenar.
4. Prefix `facilitator_` en todas las tablas propias.

El README ya reserva explícitamente `001_facilitator_settlements.sql` para WFAC-32
(línea 57). No hay migrations previas en el directorio (sólo el README), así que WFAC-32
ES la primera migration — arrancamos la numeración limpia.

**NO usamos** `supabase/migrations/20260424000000_facilitator_settlements.sql` (timestamp-based
Supabase CLI default) porque el proyecto adoptó el patrón luma-ai (numerado
secuencial) documentado. Mantener consistencia.

**Convención para futuras migrations**:
- `002_facilitator_audit_log.sql` (WFAC-33).
- `003_facilitator_idempotency.sql` (deferred).

#### 4.2.5 NC-5 — Ubicación de `persistLedgerEntry`

**Resolución: `src/core/ledger.ts`** con `LedgerEntry` type + `persistLedgerEntry`
function. NO inline en `src/routes/settle.ts`.

Justificación (ya recomendada en work-item AC-11 y CD-3):

1. **Testeable independiente**: `ledger.test.ts` mockea `getSupabaseClient` y verifica la
   lógica de `persistLedgerEntry` sin arrancar Fastify.
2. **Reusable**: WFAC-33 (audit log) puede importar `LedgerEntry` type o copiar el
   patrón directamente. Si estuviera inline en la route, habría que refactorizar.
3. **Patrón idéntico a `src/core/idempotency.ts`**: core consume infra (`getRedisClient`)
   y la route es sólo orquestador. AC-11 explícitamente valida este layout.
4. **Boundary OWNERS**: `src/core/` PUEDE importar `src/infra/*` (OWNERS.md tabla
   línea 22). La importación `src/core/ledger.ts` → `src/infra/supabase.ts` es válida.

**Route layer sólo orquesta**: llama a `buildLedgerEntry(result, parsed, idempotencyKey,
durationMs)` + `persistLedgerEntry(entry, log)` — sin lógica propia.

### 4.3 DDL completo — `001_facilitator_settlements.sql`

Schema propuesto, idempotente, con 3 índices + CHECK constraint:

```sql
-- supabase/migrations/001_facilitator_settlements.sql
-- WFAC-32 — Settlement ledger for facilitator /settle persistence.
-- Idempotent: safe to re-run. Do not edit once pushed — create follow-up migration.

CREATE TABLE IF NOT EXISTS facilitator_settlements (
  -- Identity
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT           NOT NULL UNIQUE,   -- sha256 hex (64 chars)

  -- Result
  status            TEXT           NOT NULL CHECK (status IN ('success', 'failed')),

  -- Blockchain (NULLABLE for status='failed')
  tx_hash           TEXT           NULL,
  block_number      BIGINT         NULL,

  -- x402 fields (always present)
  network           TEXT           NOT NULL,                   -- 'eip155:<chainId>'
  method            TEXT           NOT NULL,                   -- 'eip3009' | 'permit2' | 'erc7710'
  asset             TEXT           NOT NULL,                   -- token address 0x...
  amount            NUMERIC(78, 0) NOT NULL,                   -- atomic uint256 (fits 2^256)
  payer             TEXT           NOT NULL,                   -- 0x address (from)
  payee             TEXT           NOT NULL,                   -- 0x address (to)

  -- Error (NULL for status='success')
  error_code        TEXT           NULL,                       -- X402ErrorCode literal or NULL
  error_http        INTEGER        NULL,                       -- 400/401/402/412/500 or NULL

  -- Technical
  duration_ms       INTEGER        NOT NULL,                   -- Date.now() - startMs

  -- Timestamps
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  -- Cross-field invariants
  CONSTRAINT success_has_tx CHECK (
    (status = 'success' AND tx_hash IS NOT NULL AND block_number IS NOT NULL
      AND error_code IS NULL AND error_http IS NULL)
    OR
    (status = 'failed'  AND error_code IS NOT NULL AND error_http IS NOT NULL)
  )
);

-- Indexes (non-unique — the UNIQUE on idempotency_key lives in the table constraint)
CREATE INDEX IF NOT EXISTS idx_fs_created_at ON facilitator_settlements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_network    ON facilitator_settlements (network);
CREATE INDEX IF NOT EXISTS idx_fs_status     ON facilitator_settlements (status);

-- Optional: composite index for common dashboard query (network + date range)
CREATE INDEX IF NOT EXISTS idx_fs_network_created_at
  ON facilitator_settlements (network, created_at DESC);

COMMENT ON TABLE  facilitator_settlements IS
  'WFAC-32: per-settlement ledger. Fire-and-forget from src/routes/settle.ts. No PII.';
COMMENT ON COLUMN facilitator_settlements.idempotency_key IS
  'SHA-256 hex (64 chars) of canonical-JSON(parsed body). Matches Redis key (sans prefix).';
COMMENT ON COLUMN facilitator_settlements.amount IS
  'Atomic units (uint256). Use NUMERIC(78,0) to fit 2^256-1 without precision loss.';
```

**Notas del DDL**:

1. `NUMERIC(78, 0)` soporta `2^256 - 1` (78 dígitos decimales) sin precisión perdida.
   JavaScript serializa el `amount: string` de `SettleResult` y Supabase-js lo inserta
   tal cual — PostgreSQL NUMERIC lo acepta.
2. `block_number BIGINT` cubre bloques hasta `9.2 × 10^18`, seguro para cualquier chain.
3. CHECK `success_has_tx` es **crítico** — evita rows inconsistentes (`status='success'`
   sin `tx_hash`) que arruinarían reporting. Dev debe testear en W4 que no lanzamos
   un INSERT inválido (test de integración).
4. Índices intencionales:
   - `created_at DESC`: queries time-range típicas de dashboards.
   - `network`: filtros por chain.
   - `status`: filtros success vs failed.
   - Compuesto `(network, created_at DESC)`: dashboard Supabase típico.
5. **No FOREIGN KEYS** — consistencia con README convention #7.
6. **No RLS en V1** — TD-SEC-LEDGER-01 a crear en `BACKLOG.md` (scope OUT pero mencionar
   en §7 Riesgos).

### 4.4 Componentes / Servicios

#### 4.4.1 `src/infra/supabase.ts` — Singleton

Responsabilidades:

- `export function initSupabase(env: EnvConfig, logger: SupabaseLogger): void` — idempotente.
- `export function getSupabaseClient(): SupabaseClient | null` — lazy, creates on first
  call only if `env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY`. Returns `null` cuando
  test env o vars ausentes.
- `export function resetSupabaseClientForTests(): void` — CD-8 work-item.
- `export function redactSupabaseKey(raw: string): string` — CD-2 work-item. Muestra
  primeros 8 chars + `…` (o `'sb_***'` si raw es corto/inválido).
- `export type SupabaseLogger = Pick<Logger, 'info' | 'error' | 'warn' | 'debug'>` —
  `debug` agregado vs `RedisLogger` para el log AC-5 "log debug on conflict no-op".

Estructura (pseudo, **NO es código del SDD — es esquema del módulo**):

- Módulo state: `_client, _env, _logger, _initialized`.
- `initSupabase`: valida que `env !== null`, guarda refs, idempotente, log info "Supabase
  client configured" con `url` redactada (sólo hostname) + `keyPreview` (primeros 8 chars).
- `getSupabaseClient`: si `!_initialized` o `!_env.SUPABASE_URL` o `!_env.SUPABASE_SERVICE_KEY`
  → return null. Si ya hay `_client`, return cached. Si no, `createClient(_env.SUPABASE_URL, _env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })` → assign a `_client`, log info "Supabase client instantiated".
- `resetSupabaseClientForTests`: clears all module state.
- `redactSupabaseKey`: try → primeros 8 chars + `…` + últimos 4 chars (shape `sb_secret_abcd…xyz9`); catch → `'sb_***'`.

Boundary: imports sólo `@supabase/supabase-js` (runtime), `pino` (type-only),
`./env.js` (type-only).

#### 4.4.2 `src/core/ledger.ts` — Persistencia

Responsabilidades:

- `export type LedgerEntry` — shape exacta del INSERT:
  ```ts
  // Campos en el mismo orden que el DDL
  readonly idempotency_key: string;      // sha256 hex
  readonly status: 'success' | 'failed';
  readonly tx_hash: string | null;       // 0x... | null
  readonly block_number: number | null;  // bigint-compatible | null
  readonly network: string;              // 'eip155:2368'
  readonly method: 'eip3009' | 'permit2' | 'erc7710';
  readonly asset: string;                // 0x...
  readonly amount: string;               // uint256 as string
  readonly payer: string;                // 0x...
  readonly payee: string;                // 0x...
  readonly error_code: string | null;    // X402ErrorCode | null
  readonly error_http: number | null;    // 400..500 | null
  readonly duration_ms: number;
  ```
- `export function buildLedgerEntry(input: BuildLedgerInput): LedgerEntry` — pure
  function, mapea `AdapterResult<SettleResult> | AdapterThrow` + contexto (request
  parsed, idempotency_key, duration_ms, method) → `LedgerEntry`. Sin side effects.
- `export async function persistLedgerEntry(entry: LedgerEntry, logger: LedgerLogger): Promise<void>` —
  fire-and-forget:
  1. `const client = getSupabaseClient(); if (!client) return;` (AC-4/AC-7).
  2. `try { await client.from('facilitator_settlements').upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true }); } catch (err) { logger.warn({ err, idempotency_key: entry.idempotency_key, network: entry.network }, 'ledger upsert failed'); }` (AC-3, CD-1).
  3. Si `upsert` resuelve con `{ error }` no-null → mismo log warn (Supabase no-throw pattern).
  4. Si resuelve OK → no log (AC-5: log debug opcional ante ignoreDuplicates no-op — ver subtlety abajo).

**Subtlety AC-5 "log debug on conflict no-op"**: Supabase-js v2 con `ignoreDuplicates: true`
retorna `data: []` (array vacío) cuando el conflict se silencia. Distinguir vs
inserción exitosa (`data: [{ …row }]` o `data: null` según versión). El módulo puede
inspeccionar `.data` y log `debug` si `data?.length === 0` y no hubo error.

- `LedgerLogger` type: `Pick<Logger, 'warn' | 'debug'>` (sólo los dos niveles que usa).

Boundary: imports `../infra/supabase.js` (runtime), `pino` (type-only),
`./types.js` (opcional, type-only para `X402ErrorCode`). NO importar `src/chains/*`
ni `src/methods/*`.

#### 4.4.3 Hook en `src/routes/settle.ts`

Tres puntos de inserción (ver archivo existing):

| Branch | Ubicación actual | Acción |
|--------|------------------|--------|
| Success on-chain | después del cache write, línea 138 (antes de `reply.send` línea 169) | `const entry = buildLedgerEntry({ result, parsed, idempotencyKey, durationMs: Date.now() - startMs, method: 'eip3009' }); await persistLedgerEntry(entry, app.log);` |
| Error x402 4xx/5xx del adapter | después del log warn línea 151 (antes del `reply.code(...).send` línea 152) | mismo pattern, con `result.error` propagado al builder |
| Adapter throw (catch línea 110-130) | dentro del catch, antes de `reply.code(500).send` línea 129 | `buildLedgerEntry` con shape sintético `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 } }` + `tx_hash: null, block_number: null` |

**await sí o no**: el ledger entrada es `await persistLedgerEntry(...)` porque:
1. La función **nunca throwea** (CD-1), así que el await no agrega riesgo.
2. Queremos garantizar que el INSERT se completó antes de devolver la respuesta HTTP
   (AC-1/AC-2 explícitas: "BEFORE sending the response"). Un `.catch()` sin await
   dejaría la promesa huérfana en el event loop y Fastify podría cerrar la connection
   antes de que Supabase recibiera el request.
3. Latency añadida: ~40-120 ms p99 Supabase over internet. Aceptable para el tradeoff
   de garantía de persistencia. Si se mide excesivo en prod, se refactorea a BullMQ
   async en V1.5 (scope OUT).

**Excepción al await**: en el branch de cache-hit (líneas 91-100 actuales,
`sendCachedSettle`), NO persistimos al ledger — el primer request ya lo hizo. El
`idempotency_key` ya está en la tabla y UPSERT lo ignoraría igual, pero evitamos la
roundtrip innecesaria.

#### 4.4.4 Bootstrap en `src/app.ts`

Insertar después de línea 51 (`initRedis`):

```
// WFAC-32: initialize Supabase singleton with env + logger. Idempotent; creates
// no network request (HTTP client is lazy — actual POST happens per-insert call).
initSupabase(env, logger);
```

**No `onClose` hook** para Supabase — razón: `@supabase/supabase-js` es un wrapper
sobre `fetch`, sin conexión TCP persistente que cerrar. Cada `.from(…).upsert(…)` es
una POST aislada a `https://<project>.supabase.co/rest/v1/`. El `onClose` de Fastify
sólo tiene que esperar pending promises (que ya awaitean en la route).

### 4.5 Flujo principal (Happy Path)

1. Cliente hace `POST /settle` con payload x402 válido.
2. Route valida Zod → pasa.
3. Idempotency cache miss (Redis up).
4. `settleCore(parsed)` → `eip3009.settle()` → `walletClient.writeContract()` → tx
   mined → `result = { ok: true, settled: true, transactionHash: '0x…', blockNumber: 12345, amount: '1000000', from: '0x…', to: '0x…', asset: '0x…' }`.
5. Redis cache write (`toCacheableSettle`).
6. **NUEVO**: `buildLedgerEntry({ ok: true, …, idempotency_key: hash, durationMs, method: 'eip3009' })` → `LedgerEntry` con `status='success'`, 9 campos on-chain, `error_code=null, error_http=null`.
7. **NUEVO**: `await persistLedgerEntry(entry, app.log)` → `supabase.from('facilitator_settlements').upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true })` → PostgreSQL INSERT → row con UUID generado.
8. Log info línea 156-164 existing + el reply 200 existing (líneas 169-177).

### 4.6 Flujo de error (varios casos)

#### 4.6.1 Error x402 del adapter (ej. INSUFFICIENT_BALANCE 402)
1-4 idénticos, pero `result = { ok: false, error: { code: 'INSUFFICIENT_BALANCE', message: '…', http: 402 } }`.
5. Redis cache write (http < 500 → `toCacheableSettle` acepta).
6. **NUEVO**: `buildLedgerEntry({ ok: false, error, idempotency_key, …, method })` → `LedgerEntry` con `status='failed'`, `tx_hash=null, block_number=null`, `error_code='INSUFFICIENT_BALANCE', error_http=402`, plus payer/payee/asset/amount/network derivados del `parsed` request.
7. **NUEVO**: `await persistLedgerEntry(entry, app.log)` → INSERT.
8. Log warn existing + reply error existing.

#### 4.6.2 Adapter throw (SIMULATION_FAILED / TRANSACTION_FAILED 500)
1-3 idénticos.
4. `settleCore(parsed)` throws → catch línea 110.
5. **NUEVO (dentro del catch)**: `buildLedgerEntry({ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 }, parsed, idempotency_key, durationMs, method: 'eip3009' })` → `LedgerEntry` con `status='failed'`, `tx_hash=null, block_number=null`, `error_code='TRANSACTION_FAILED', error_http=500`.
6. **NUEVO**: `await persistLedgerEntry(entry, app.log)`.
7. Redis cache SKIP en este branch (código existing no cachea 500).
8. Log error existing + reply 500 existing.

#### 4.6.3 Supabase UNIQUE conflict (race/crash retry)
1-6 idénticos a happy-path.
7. **NUEVO**: `upsert` con `ignoreDuplicates: true` → PostgreSQL silencia el conflict, retorna `data: []`. Ledger module logea `debug` con `{ idempotency_key }`.
8. Reply normal al cliente.

#### 4.6.4 Supabase DB down / network error
1-6 idénticos.
7. **NUEVO**: `upsert` throwea o retorna `{ error: {…} }`. `persistLedgerEntry` catch → log `warn { err, idempotency_key, network }`. Reply al cliente SIN modificar (AC-3).

#### 4.6.5 Env vars ausentes en producción
1. Startup: `parseEnv` pasa (vars optional, sin superRefine).
2. `initSupabase(env, logger)` se invoca en `buildApp`; como `!env.SUPABASE_URL`, el log info "Supabase client not configured — ledger disabled" (AC-4) se emite al primer `getSupabaseClient()` intent. **Decision**: emitir el warn UNA VEZ durante init (no por cada request). Implementación: `initSupabase` puede loggear el estado "disabled" si detecta ausencia y guardar un flag `_loggedDisabled = true` para no repetir.
3. `persistLedgerEntry` → `getSupabaseClient() === null` → return silencioso (no log por invocación; evita spam).
4. Settle flow completa normal.

---

## 5. Constraint Directives (Anti-Alucinación)

### 5.1 CDs heredados del work-item (CD-1 a CD-8)

Se incluyen todos íntegros (CD-1 swallow, CD-2 redact key, CD-3 import boundary,
CD-4 env optional sin superRefine, CD-5 no console.log, CD-6 migration naming,
CD-7 no PII client_ip, CD-8 resetForTests). Ver `work-item.md` líneas 205-240.

### 5.2 CDs nuevos (arquitectónicos, derivados de auto-blindaje histórico + decisiones §4)

- **CD-9 (Prettier pre-wave)**: OBLIGATORIO correr `npx prettier --write <archivos>`
  después de cada edición y antes de `npm run qa`. Auto-blindaje WFAC-22/WFAC-23
  documenta 2 fallas recurrentes en F3 por omitir este paso.

- **CD-10 (Imports estrictos)**: PROHIBIDO importar símbolos en `src/infra/supabase.ts`,
  `src/core/ledger.ts`, o los tests nuevos que no se usen directamente en el archivo.
  Auto-blindaje WFAC-20 W0 documenta la falla (`'Bytes32HexSchema' is defined but never
  used`). El lint corre con `--max-warnings 0`.

- **CD-11 (Record lookups dinámicos)**: si `src/core/ledger.ts` o el builder usa
  lookups tipo `RECORD[key]` con key derivada de runtime input, agregar
  `// eslint-disable-next-line security/detect-object-injection` + justificación
  citando `src/core/errors.ts` líneas 101-104 como precedente sancionado.

- **CD-12 (Supabase-js import shape)**: OBLIGATORIO importar
  `import { createClient, type SupabaseClient } from '@supabase/supabase-js';`.
  PROHIBIDO `import supabase from '@supabase/supabase-js'` o `import * as Supabase`.
  Bajo `tsconfig.json` con `module: "Node16"` + Supabase-js v2 ESM, el named import es
  la única forma correcta. Precedente: auto-blindaje WFAC-5 W1 (ioredis CJS default
  import fallido).

- **CD-13 (Explicit INSERT object build)**: OBLIGATORIO construir el `LedgerEntry`
  literalmente con los 13 campos nombrados uno por uno (NO `{ ...result }`). Precedente:
  auto-blindaje WFAC-20 W1 y CD-11 de WFAC-21. Además el DDL CHECK `success_has_tx`
  rompería si el objeto tuviera inconsistencia silent.

- **CD-14 (fire-and-forget pero con await)**: OBLIGATORIO `await persistLedgerEntry(...)`
  en la route — la función nunca throwea (CD-1) pero el await garantiza que el INSERT
  se completó antes del reply (AC-1/AC-2 "BEFORE sending"). PROHIBIDO
  `persistLedgerEntry(...).catch(...)` o `void persistLedgerEntry(...)`.

- **CD-15 (No onClose para Supabase)**: PROHIBIDO agregar `app.addHook('onClose', ...)`
  para Supabase en `src/app.ts`. El cliente HTTP-based no tiene conexión TCP persistente
  que cerrar; agregar un hook sin necesidad complica shutdown y no aporta nada.

- **CD-16 (Migration immutable)**: PROHIBIDO editar
  `supabase/migrations/001_facilitator_settlements.sql` después de haber sido mergeado
  a main. Cualquier cambio de schema va en `002_...sql` nueva. Regla del README
  (`supabase/migrations/README.md` línea 23-24).

- **CD-17 (NUMERIC amount preservation)**: OBLIGATORIO pasar `amount` al UPSERT como
  **string** (no Number). JavaScript pierde precisión >2^53, PostgreSQL NUMERIC(78,0)
  no. Supabase-js acepta strings para columnas NUMERIC sin conversión adicional.

### 5.3 PROHIBIDO — síntesis

- NO implementar retries automáticos del ledger (fire-and-forget, no retry queue).
- NO persistir desde `src/core/settle.ts` (AC-11, CD-3).
- NO loggear la service key ni substring de ella en NINGÚN path.
- NO agregar superRefine hard-fail prod en env.ts para las Supabase vars (CD-4).
- NO instalar `@supabase/realtime-js`, `@supabase/auth-helpers-*`, ni otros sub-packages.
  Sólo `@supabase/supabase-js` monolítico.
- NO renombrar la tabla, las columnas, ni el archivo de migration una vez mergeado.
- NO agregar RLS policies en esta HU (scope OUT — TD-SEC-LEDGER-01 en BACKLOG).
- NO persistir client_ip, user_agent, request-id, ni ningún header HTTP (CD-7, AC-9).
- NO agregar deps nuevas salvo `@supabase/supabase-js`.

---

## 6. Scope (síntesis)

**IN** (10 artefactos):
- Migration SQL nueva.
- `@supabase/supabase-js: ^2.45.0` en deps.
- `src/infra/supabase.ts` nuevo (singleton + redactKey).
- `src/core/ledger.ts` nuevo (type + builder + persistor).
- `src/infra/env.ts` +2 vars optional.
- `src/routes/settle.ts` 3 hooks al ledger.
- `src/app.ts` initSupabase.
- 2 tests nuevos (supabase.test.ts, ledger.test.ts).
- env.test.ts +3 casos para las nuevas vars.
- SDD + Story File + CR artifacts en `doc/sdd/013-…/`.

**OUT** (scope outs del work-item + explicitos de arquitectura):
- `facilitator_audit_log` + cualquier PII HTTP → WFAC-33.
- RLS → TD-SEC-LEDGER-01.
- BullMQ settlement retry queue → V1.5.
- `/verify` ledger → no scope.
- Dashboard / reporting UI → no scope en este proyecto.
- Métricas Prometheus del ledger → HU futura de observabilidad.
- `facilitator_idempotency` persistente → deferred.

---

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Latency del UPSERT (Supabase over internet, ~40-120ms p99) impacta p95 del endpoint | M | M | Aceptado V1 por garantía de persistencia pre-reply. Monitorear p95 en prod post-deploy. Refactor a BullMQ en V1.5 si excede SLA (scope OUT esta HU). |
| Supabase down → warn flood en logs bajo volumen | M | B | `persistLedgerEntry` loggea 1 warn por fallo, no throttlea. Aceptado: el warn es actionable (ops). Alternativa: ring-buffer logging futuro — TD si se observa ruido excesivo. |
| RLS OFF en V1 → service_key leak expone toda la tabla | B | A | Service key sólo en env Railway backend, nunca en frontend. TD-SEC-LEDGER-01 rastrea habilitar RLS. Mismo trade-off que WKH-53 en wasiai-a2a. |
| CHECK constraint `success_has_tx` rechaza rows malformados → `persistLedgerEntry` logea warn constante en bug de construcción | B | M | Tests unit de `buildLedgerEntry` cubren los 4 branches (success, x402 fail, adapter throw, missing fields). CD-13 fuerza construcción explícita. |
| Migration `001_*` colisiona con migrations pre-existentes si alguien las corrió desde otro flujo | MB | A | Directory `supabase/migrations/` tiene sólo README — verificado con `ls -la`. Primera migration del proyecto. |
| Supabase-js v2.45 → v2.104 minor bump trae breaking change inesperado | MB | M | `^2.45.0` permite upgrade dentro de 2.x; monitorear changelog en `npm outdated`. Auto-blindaje si ocurre. |
| Dev implementa INSERT puro (no UPSERT) por costumbre → AC-5 falla | B | M | CD-13 + §4.2.2 explícitos. Story File W2 va a citar el método `.upsert(payload, { onConflict: 'idempotency_key', ignoreDuplicates: true })`. |
| Dev omite el branch catch (adapter throw) → 5xx no persisten, AC-2-extended falla | B | M | §4.4.3 tabla con 3 puntos de hook explícitos. Story File W3 incluye los 3 como checklist. Test W3 cubre el branch catch con `settleCore.mockRejectedValue(...)`. |
| Test `@supabase/supabase-js` mock no replica exactamente API v2 → test verde pero prod roto | B | A | Mock usa la signature real: `createClient(url, key, opts).from(table).upsert(payload, opts)`. Integration test opcional en W4 contra testing Supabase (stretch). |

---

## 8. Dependencias

- Supabase project dedicado para facilitator ya aprovisionado (vars en `.env.example`).
  **Pre-condición humana**: en prod, crear el proyecto Supabase dedicado (NO reusar el
  de wasiai-a2a) y setear las 2 env vars en Railway antes del deploy post-merge.
- Fastify ≥ v5 (existing, OK).
- Node 20 LTS (existing, OK).
- WFAC-21 (settle route) merged y en DONE (confirmado: SDD 010 status DONE en _INDEX).
- WFAC-5 (Redis singleton) merged (confirmado: SDD 004 DONE) — patrón que replicamos.

---

## 9. Test Plan (por AC, mínimo 12)

Tabla completa — Wave asignado + archivo que contendrá el test:

| # | Test name | AC que cubre | Wave | Archivo |
|---|-----------|--------------|------|---------|
| T1 | `parseEnv accepts SUPABASE_URL valid + SERVICE_KEY` | AC-6 | W1 | `env.test.ts` (append) |
| T2 | `parseEnv rejects invalid SUPABASE_URL format (AC-8)` | AC-8 | W1 | `env.test.ts` (append) |
| T3 | `parseEnv allows both SUPABASE vars absent in production (CD-4, no superRefine)` | CD-4 | W1 | `env.test.ts` (append) |
| T4 | `redactSupabaseKey masks body of the service key (CD-2)` | CD-2 | W1 | `supabase.test.ts` |
| T5 | `getSupabaseClient returns null when initSupabase never called` | AC-12 | W1 | `supabase.test.ts` |
| T6 | `getSupabaseClient returns null when NODE_ENV=test + SUPABASE_URL absent` | AC-7 | W1 | `supabase.test.ts` |
| T7 | `getSupabaseClient returns the same instance on repeated calls (singleton)` | AC-12 | W1 | `supabase.test.ts` |
| T8 | `initSupabase is idempotent across repeated calls` | AC-12 | W1 | `supabase.test.ts` |
| T9 | `resetSupabaseClientForTests clears state (AC-12 / CD-8)` | AC-12, CD-8 | W1 | `supabase.test.ts` |
| T10 | `initSupabase logs "configured" with redacted key preview (AC-10, CD-2)` | AC-10 | W1 | `supabase.test.ts` |
| T11 | `initSupabase logs "disabled" when vars absent (AC-4)` | AC-4 | W1 | `supabase.test.ts` |
| T12 | `buildLedgerEntry maps SettleResult success → status=success, 9 fields populated (AC-1, CD-13)` | AC-1 | W2 | `ledger.test.ts` |
| T13 | `buildLedgerEntry maps x402 error → status=failed, error_code + error_http populated, tx_hash + block_number null (AC-2, CD-13)` | AC-2 | W2 | `ledger.test.ts` |
| T14 | `buildLedgerEntry maps adapter-throw 500 → status=failed, error_code=TRANSACTION_FAILED, error_http=500 (AC-2-extended)` | AC-2-ext | W2 | `ledger.test.ts` |
| T15 | `persistLedgerEntry is no-op when client is null (AC-4, AC-7)` | AC-4, AC-7 | W2 | `ledger.test.ts` |
| T16 | `persistLedgerEntry calls upsert with onConflict:'idempotency_key', ignoreDuplicates:true (AC-5, NC-2)` | AC-5 | W2 | `ledger.test.ts` |
| T17 | `persistLedgerEntry logs warn and does not throw when upsert rejects (AC-3, CD-1)` | AC-3 | W2 | `ledger.test.ts` |
| T18 | `persistLedgerEntry logs warn and does not throw when upsert returns {error} (AC-3)` | AC-3 | W2 | `ledger.test.ts` |
| T19 | `persistLedgerEntry logs debug when duplicate silenced (AC-5)` | AC-5 | W2 | `ledger.test.ts` |
| T20 | `POST /settle success → ledger upsert invoked with status=success BEFORE reply 200 (AC-1)` | AC-1 | W3 | `routes.settle.test.ts` (append) |
| T21 | `POST /settle x402 error → ledger upsert invoked with status=failed BEFORE reply (AC-2)` | AC-2 | W3 | `routes.settle.test.ts` (append) |
| T22 | `POST /settle adapter throw → ledger upsert invoked with status=failed 500 BEFORE reply 500 (AC-2-extended)` | AC-2-ext | W3 | `routes.settle.test.ts` (append) |
| T23 | `POST /settle with ledger disabled (env vars absent) → settle still succeeds (AC-4)` | AC-4 | W4 | `routes.settle.test.ts` or `shutdown.test.ts` equivalent |
| T24 | `POST /settle cache-hit → ledger NOT invoked (idempotent replay, §4.4.3 exception)` | §4.4.3 | W3 | `routes.settle.test.ts` (append) |

**Total: 24 tests nuevos** → cobertura de los 12 ACs + AC-2-extended + CDs clave.
Cada AC tiene **al menos 1 test**; ACs críticos (AC-1, AC-2, AC-3, AC-4, AC-5, AC-12)
tienen ≥ 2.

Coverage target: ≥ 90% statement en `src/core/ledger.ts` y `src/infra/supabase.ts`
(consistencia con WFAC-20 baseline del proyecto).

---

## 10. Waves de implementación

### W0 — Serial Gate (infra + deps)
- [ ] **W0.1**: Crear `supabase/migrations/001_facilitator_settlements.sql` con el DDL de §4.3. Verificar `CREATE TABLE IF NOT EXISTS` parseable por psql (lint: `supabase db lint` si disponible, sino revisión manual del SQL).
- [ ] **W0.2**: `npm install @supabase/supabase-js@^2.45.0` + commit `package.json` + `package-lock.json`.
- [ ] **W0.3**: Verificar `npm run typecheck` sigue pasando (Supabase types disponibles).

**Verificación W0**: `npm install` exit 0; `npm run typecheck` verde; SQL parseable.

### W1 — Infra (Supabase singleton + env)
Paralelizable tras W0.
- [ ] **W1.1**: `src/infra/env.ts` — agregar `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` al schema. Exemplar: `REDIS_URL` línea 21.
- [ ] **W1.2**: `src/infra/supabase.ts` NUEVO — módulo completo (init/get/reset/redact). Exemplar: `src/infra/redis.ts` 188 LOC.
- [ ] **W1.3**: `src/__tests__/unit/supabase.test.ts` NUEVO — T4-T11. Exemplar: `redis.test.ts` 325 LOC.
- [ ] **W1.4**: `src/__tests__/unit/env.test.ts` — append T1-T3.

**Verificación W1**: `npm run test -- supabase` + `npm run test -- env` verde; `npm run typecheck` + `npm run lint` verde.

### W2 — Core ledger module
Depende de W1.
- [ ] **W2.1**: `src/core/ledger.ts` NUEVO — `LedgerEntry` type + `buildLedgerEntry` + `persistLedgerEntry` + `LedgerLogger`. Exemplar: `src/core/idempotency.ts` líneas 141-208 (pattern fail-open en core que consume infra).
- [ ] **W2.2**: `src/__tests__/unit/ledger.test.ts` NUEVO — T12-T19. Exemplar: `core.idempotency.settle.test.ts` líneas 30-80.

**Verificación W2**: `npm run test -- ledger` verde; coverage ≥ 90% en `src/core/ledger.ts`; `npm run typecheck` + `npm run lint` verde.

### W3 — Route integration
Depende de W2.
- [ ] **W3.1**: `src/routes/settle.ts` — 3 hooks al ledger según §4.4.3. Cada uno con `buildLedgerEntry` + `await persistLedgerEntry`. Respetar orden: cache write → ledger → reply.
- [ ] **W3.2**: `src/__tests__/unit/routes.settle.test.ts` — append T20, T21, T22, T24.

**Verificación W3**: `npm run test -- routes.settle` verde (incluyendo los cases nuevos + los existing sin regresión); `npm run typecheck` + `npm run lint` verde.

### W4 — App bootstrap + final QA
Depende de W3.
- [ ] **W4.1**: `src/app.ts` — agregar `initSupabase(env, logger)` después de `initRedis` (línea 51). SIN onClose hook (CD-15).
- [ ] **W4.2**: Opcional — test de buildApp T23: `buildApp({ env: makeEnv({ SUPABASE_URL: undefined }) })` → POST /settle completa sin error.
- [ ] **W4.3**: `npm run qa` completo (typecheck + lint + format:check + test). Si falla Prettier en cualquier archivo nuevo, `npx prettier --write <archivo>` (CD-9).
- [ ] **W4.4**: Update `.env.example` — verificar que las vars `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` en líneas 59-60 ya existen (comentario ya está). Agregar comentario inline documentando la consumption por WFAC-32 si aún no está.
- [ ] **W4.5**: Agregar TD a `BACKLOG.md`: "TD-SEC-LEDGER-01 — Habilitar RLS en `facilitator_settlements` con policies por service role post-V1".

**Verificación W4 (final)**: `npm run qa` exit 0; todos los 24 tests nuevos pasan; 0 warnings de lint; 0 diffs de prettier.

### Dependencias entre waves

| Wave | Depende de | Razón |
|------|-----------|-------|
| W0 | — | serial gate (migrations + deps) |
| W1 | W0.2 (supabase-js installed) | typecheck necesita types |
| W2 | W1.2 (supabase.ts exports) | `ledger.ts` importa `getSupabaseClient` |
| W3 | W2.1 (ledger exports) | route importa `buildLedgerEntry`, `persistLedgerEntry` |
| W4 | W3 | bootstrap integrates all |

---

## 11. Exemplar Verification (archivo:línea confirmado con Read)

| Ruta citada | Verificado | Notas |
|-------------|------------|-------|
| `src/infra/redis.ts` líneas 48-52, 62-69, 82-120, 149-158, 182-187 | SÍ | Patrón singleton + lazy + reset completamente leído. |
| `src/infra/env.ts` líneas 13-32 | SÍ | EnvSchema existente con superRefine de REDIS_URL. |
| `src/infra/logger.ts` líneas 16-32 | SÍ | `Pick<Logger, …>` pattern confirmado. |
| `src/routes/settle.ts` líneas 60-179 | SÍ | Hook points identificados: 138 (post-cache), 151 (pre-reply error), 129 (en catch). |
| `src/core/idempotency.ts` líneas 30-50, 108-208 | SÍ | Patrón core-consume-infra + swallow + type-only import. |
| `src/chains/types.ts` líneas 101-109 | SÍ | `SettleResult` shape. |
| `src/core/errors.ts` líneas 44-55, 98-106 | SÍ | `HTTP_BY_CODE` + `buildX402Error` + eslint-disable precedent. |
| `src/core/types.ts` líneas 32-42 | SÍ | `X402ErrorCode` union (10 literals). |
| `.env.example` líneas 56-60 | SÍ | `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` canon. |
| `supabase/migrations/README.md` líneas 9-27, 57 | SÍ | Naming convention `NNN_descripcion.sql`; `001_facilitator_settlements.sql` reservado. |
| `OWNERS.md` tabla líneas 21-32 | SÍ | `src/core/*` MAY import `src/infra/*`. |
| `src/app.ts` líneas 41-78 | SÍ | `initRedis` pattern + `onClose` hook (NO replicamos para Supabase, CD-15). |
| `src/__tests__/unit/redis.test.ts` líneas 14-52, 120-267 | SÍ | Mock pattern + beforeEach reset + emit helper. |
| `src/__tests__/unit/core.idempotency.settle.test.ts` líneas 30-80 | SÍ | Mock con Map-backed get/set. |
| `package.json` líneas 23-35 | SÍ | Deps actuales; agregar supabase-js. |
| `tsconfig.json` líneas 2-18 | SÍ | Node16 + ESM + strict + noUncheckedIndexedAccess. |
| `doc/sdd/_INDEX.md` líneas 5-17 | SÍ | Historial HUs DONE confirmado. |
| `doc/sdd/012-…/auto-blindaje.md`, `009-…/auto-blindaje.md`, `004-…/auto-blindaje.md`, `011-…/auto-blindaje.md` | SÍ | Fuentes de CD-9, CD-10, CD-11, CD-12, CD-13. |

---

## 12. Readiness Check

```
[x] Cada AC tiene ≥ 1 test asociado (§9 tabla cubre AC-1..AC-12 + AC-2-ext + CDs).
[x] Cada archivo en §4.1 tiene exemplar verificado con Read/Glob (§11 tabla).
[x] No hay [NEEDS CLARIFICATION] pendientes — los 5 del work-item están resueltos en §4.2.
[x] Constraint Directives incluyen 8 heredados + 9 nuevos (CD-9..CD-17) → 17 total, superando el mínimo de 3 PROHIBIDO.
[x] Context Map tiene 17 archivos leídos (§3.1), muy por encima del mínimo de 2.
[x] Scope IN y OUT explícitos en §6.
[x] BD: tabla `facilitator_settlements` no existe — se crea en W0.1 con DDL completo §4.3.
[x] Flujo principal (Happy Path) completo en §4.5 con 8 pasos numerados.
[x] Flujos de error definidos en §4.6 (5 escenarios: x402 error, adapter throw, UNIQUE conflict, DB down, env vars absent).
[x] Waves de implementación con dependencias explícitas (§10).
[x] Test plan con 24 tests (§9) — supera el mínimo de 12 del prompt F2.
[x] Autobloqueo histórico revisado — 3 auto-blindajes recientes reflejados en CD-9..CD-13.
[x] Stack del project-context respetado: Fastify 5, Zod 3, viem 2, Pino 9, TypeScript strict Node16 ESM, Supabase dedicado NO compartido con wasiai-a2a.
[x] OWNERS.md boundaries respetados: core→infra OK, routes→core OK, nadie salta boundaries.
[x] Ningún módulo `src/chains/*` o `src/methods/*` tocado (HU no cambia lógica on-chain).
```

**Resultado**: READINESS PASS. SDD listo para presentar al humano en GATE 2 para
SPEC_APPROVED.

---

## 13. Open Questions (no-bloqueantes)

Ninguna. Los 5 [NEEDS CLARIFICATION] originales resueltos en §4.2. Decisiones tomadas
por el Architect con justificación documentada. Si el humano prefiere una decisión
alterna en cualquiera de las 5, requiere re-roll de la sección + re-approval.

Posibles follow-ups (scope OUT, para HUs futuras):

1. **RLS habilitado + policies**: TD-SEC-LEDGER-01 a agregar en `BACKLOG.md` durante W4.
2. **BullMQ async retry del ledger**: V1.5, si monitoreo de p95 post-deploy muestra que
   el await del upsert deteriora SLA > 150 ms.
3. **Métricas Prometheus**: `facilitator_ledger_upsert_total{status}` y
   `facilitator_ledger_upsert_duration_ms` — HU de observabilidad post-V1.
4. **Integration test contra Supabase real** (containerizado o test-project): W4
   stretch goal si tiempo. El mock unit-test cubre la API contract.

---

*SDD generado por NexusAgil — F2 — WFAC-32 — 2026-04-23 — Architect*
