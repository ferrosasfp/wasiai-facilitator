# Story File — HU-32 Settlement Ledger — Supabase `facilitator_settlements` (WFAC-32)

- **Work Item**: `doc/sdd/013-wfac-32-settlement-ledger/work-item.md`
- **SDD**: `doc/sdd/013-wfac-32-settlement-ledger/sdd.md`
- **Pipeline**: QUALITY (infra DB + service role key + schema producción — AR + CR obligatorios) · **Sizing**: M · **SDD_MODE**: full
- **Branch**: `feat/013-wfac-32-settlement-ledger` (ya creada desde `main` — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **340/340 passed** (post WFAC-23 DONE) · **Target**: **≥ 364** (340 + 24 nuevos)
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-32.md`) — **es el único contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — consulta SOLO los relevantes a la wave que estás implementando.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes una ambigüedad y sospeches que este Story File está equivocado. En ese caso, STOP + reporta.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: feat/013-wfac-32-settlement-ledger

git status
# esperado: clean al empezar. Entre waves, solo deben aparecer archivos del Scope IN (§0.5).

npm test -- --run
# esperado: 340/340 passed en la baseline; creciente hasta ≥364 al cerrar W4.
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
- [ ] `npm run format:check` green (si falla, `npx prettier --write <archivo>` — **CD-9**).
- [ ] `npm test -- --run` passes el baseline (340) + los tests nuevos de esta wave.
- [ ] NO modificaste ningún archivo fuera del Scope IN de la wave.
- [ ] NO agregaste dependencias fuera de `@supabase/supabase-js` en W0.2.
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno está violado.

### 0.4 Exemplars verificados en SDD §11 (paths confirmados con Read)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/infra/redis.ts` (188 LOC completo) | W1: copiar patrón singleton lazy-init + `initX` + `getXClient(): X \| null` + `resetXClientForTests` + `redactRedisUrl`. | W1 |
| E2 | `src/infra/env.ts` líneas 13-32 | W1: Zod `EnvSchema` + patrón `REDIS_URL` (línea 21). | W1 |
| E3 | `src/infra/logger.ts` líneas 16-32 | W1: `Pick<Logger, 'info'\|'error'\|'warn'>` type pattern para `SupabaseLogger`. | W1 |
| E4 | `src/core/idempotency.ts` líneas 141-208 | W2: patrón core-consume-infra + swallow errors + `getRedisClient() ?? null` fallback. | W2 |
| E5 | `src/chains/types.ts` líneas 101-109 | W2: shape exacto de `SettleResult` (7 campos spec-literal). **TYPE-ONLY import si se usa.** | W2 |
| E6 | `src/core/types.ts` líneas 32-42 | W2: `X402ErrorCode` literal union (10 codes). | W2 |
| E7 | `src/core/errors.ts` líneas 44-55, 98-106 | W2: `HTTP_BY_CODE` + patrón `eslint-disable security/detect-object-injection` con justificación (CD-11). | W2 |
| E8 | `src/routes/settle.ts` (243 LOC) | W3: hook points — línea 138 (post-cache success), línea 151 (pre-reply error x402), línea 129 (catch adapter throw). | W3 |
| E9 | `src/app.ts` líneas 41-78 | W4: patrón `initRedis(env, logger)` línea 51. **NO replicar onClose hook** (CD-15). | W4 |
| E10 | `src/__tests__/unit/redis.test.ts` (325 LOC) | W1: mock `vi.mock('ioredis', ...)` + `RedisMock` class + `__constructorSpy` + `beforeEach(resetRedisClientForTests)`. | W1 |
| E11 | `src/__tests__/unit/core.idempotency.settle.test.ts` líneas 30-80 | W2: pattern mock con `.get/.set` stubeado + `vi.fn` + Map store (adaptar a `.from().upsert()`). | W2 |
| E12 | `supabase/migrations/README.md` líneas 9-27, 57 | W0: naming convention `NNN_descripcion.sql`; slot `001_facilitator_settlements.sql` ya reservado. | W0 |
| E13 | `OWNERS.md` tabla líneas 21-32 | Todas: `src/core/*` MAY import `src/infra/*`; `src/chains/*` MUST NOT. | Todas |
| E14 | `.env.example` líneas 59-60 | W0/W4: `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` ya existen — **NO MODIFICAR NOMBRES** (DT-1). | W0/W4 |
| E15 | `package.json` líneas 23-35 | W0.2: bloque `dependencies` actual — agregar `@supabase/supabase-js: ^2.45.0`. | W0 |
| E16 | `tsconfig.json` líneas 2-18 | W1/W2: `module: "Node16"` + ESM + strict + `noUncheckedIndexedAccess`. Forza import con `.js` extension. | W1/W2 |

### 0.5 Scope IN — los ÚNICOS archivos que puedes tocar

| # | Path | Acción | Wave |
|---|------|--------|------|
| 1 | `supabase/migrations/001_facilitator_settlements.sql` | **CREATE** | W0 |
| 2 | `package.json` | **MODIFY** (agregar 1 dep) | W0 |
| 3 | `package-lock.json` | **MODIFY** (regenerado por `npm install`) | W0 |
| 4 | `src/infra/env.ts` | **MODIFY** (2 vars al EnvSchema) | W1 |
| 5 | `src/infra/supabase.ts` | **CREATE** | W1 |
| 6 | `src/__tests__/unit/supabase.test.ts` | **CREATE** | W1 |
| 7 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append T1-T3) | W1 |
| 8 | `src/core/ledger.ts` | **CREATE** | W2 |
| 9 | `src/__tests__/unit/ledger.test.ts` | **CREATE** | W2 |
| 10 | `src/routes/settle.ts` | **MODIFY** (3 hooks al ledger) | W3 |
| 11 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (append T20-T22, T24) | W3 |
| 12 | `src/app.ts` | **MODIFY** (1 línea `initSupabase`) | W4 |
| 13 | `BACKLOG.md` | **MODIFY** (agregar TD-SEC-LEDGER-01) | W4 |

**Cualquier edit a cualquier otro archivo = violación del Story File. STOP AND REPORT.**

En particular, los siguientes archivos están **CONGELADOS** para esta HU:

- `src/core/settle.ts` — core permanece puro (sin I/O ledger). Ver **CD-3**.
- `src/chains/*` — ninguna lógica on-chain cambia.
- `src/methods/*` — adapters intactos.
- `.env.example` — los nombres `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` ya están en líneas 59-60. **NO RENOMBRAR** (DT-1 SDD).
- `src/core/idempotency.ts` — ledger NO comparte archivo con idempotency (separación de concerns).

### 0.6 Wave dependency graph

```
W0 (migration SQL + @supabase/supabase-js install)
       │
       ▼
W1 (infra/env.ts + infra/supabase.ts + supabase.test.ts + env.test.ts)
       │
       ▼
W2 (core/ledger.ts + ledger.test.ts)
       │
       ▼
W3 (routes/settle.ts hooks + routes.settle.test.ts cases)
       │
       ▼
W4 (app.ts initSupabase + BACKLOG TD + final qa)
```

- **W0 → W1**: W1 necesita `@supabase/supabase-js` types instalados para `import type { SupabaseClient }`.
- **W1 → W2**: `core/ledger.ts` importa `getSupabaseClient` desde `../infra/supabase.js`.
- **W2 → W3**: `routes/settle.ts` importa `buildLedgerEntry` + `persistLedgerEntry` desde `../core/ledger.js`.
- **W3 → W4**: `app.ts` puede importar `initSupabase` desde `./infra/supabase.js` después de que la route ya lo consume.
- **Sin forward references**. Si W1 necesita algo de W2, hay bug de diseño — STOP AND REPORT.

---

## 1. Waves

### Wave 0 — Migration SQL + instalar `@supabase/supabase-js`

**Objetivo**: tener la tabla `facilitator_settlements` versionada en `supabase/migrations/` + la dependencia runtime instalada + typecheck verde.

#### Files (W0)

| # | Path | Acción |
|---|------|--------|
| 1 | `supabase/migrations/001_facilitator_settlements.sql` | **CREATE** |
| 2 | `package.json` | **MODIFY** (bloque `dependencies`) |
| 3 | `package-lock.json` | **MODIFY** (regenerado por `npm install`) |

#### W0.1 — `supabase/migrations/001_facilitator_settlements.sql`

**Acción**: crear el archivo desde cero. Idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

**Contenido exacto** (copiar verbatim desde el SDD §4.3):

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

**Checklist W0.1**:

- [ ] El archivo se llama **exactamente** `001_facilitator_settlements.sql` (3 dígitos, snake_case). **CD-6 / CD-16**.
- [ ] Todo el DDL es idempotente (`IF NOT EXISTS`).
- [ ] El CHECK `success_has_tx` está presente y bien formado.
- [ ] Los 4 índices están creados.
- [ ] NO `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` (scope OUT — TD-SEC-LEDGER-01).
- [ ] Si detectás un typo cualquiera **antes del merge** → corregir in-place. Una vez mergeado, la migration es inmutable (**CD-16**), cualquier cambio futuro va en `002_*.sql`.

#### W0.2 — `npm install @supabase/supabase-js@^2.45.0`

**Acción**: ejecutar el install, commitear `package.json` + `package-lock.json`.

```bash
npm install @supabase/supabase-js@^2.45.0
```

**Checklist W0.2**:

- [ ] `package.json` dependencies tiene `"@supabase/supabase-js": "^2.45.0"` (u otra `^2.X.Y` si npm resuelve una patch más reciente — el caret es lo importante).
- [ ] `package-lock.json` regenerado automáticamente por npm. **NO editarlo a mano**.
- [ ] NO instalar `@supabase/realtime-js`, `@supabase/auth-helpers-*`, ni otros sub-packages. Solo el monolito `@supabase/supabase-js`.
- [ ] NO agregar `@types/supabase-*` — Supabase-js v2 ya trae types first-class.

#### W0.3 — Verificación typecheck

- [ ] `npm run typecheck` → exit 0. Confirma que los types de `@supabase/supabase-js` son resolvibles.

#### Wave 0 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` sigue 340/340 (no hay tests nuevos en W0).
- [ ] `git status` muestra SOLO `supabase/migrations/001_facilitator_settlements.sql` (new), `package.json`, `package-lock.json` (modified).
- [ ] **NO** editaste `src/infra/env.ts` todavía — eso es W1.

---

### Wave 1 — `src/infra/supabase.ts` (singleton) + `src/infra/env.ts` (+2 vars) + tests

**Objetivo**: singleton lazy-init de Supabase client + 2 env vars opcionales + tests de ambos.

#### Files (W1)

| # | Path | Acción |
|---|------|--------|
| 4 | `src/infra/env.ts` | **MODIFY** (agregar 2 vars al schema) |
| 5 | `src/infra/supabase.ts` | **CREATE** |
| 6 | `src/__tests__/unit/supabase.test.ts` | **CREATE** |
| 7 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append T1-T3) |

#### W1.1 — `src/infra/env.ts`

**Acción**: agregar `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` al `EnvSchema` existing (línea 13-32). **NO agregar `superRefine`** para estas dos vars (CD-4).

**Posición**: inmediatamente después de `REDIS_URL` (línea 21 — el exemplar).

**Diff conceptual**:

```ts
// Dentro de EnvSchema = z.object({ ... }):
//   SUPABASE_URL: accepts undefined OR valid URL string. Fail-fast si URL inválida (AC-8).
SUPABASE_URL: z.string().url().optional(),
//   SUPABASE_SERVICE_KEY: accepts undefined OR non-empty string. NO url() validation — es un token.
SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
```

**Constraints clave**:

- [ ] **CD-4 SDD**: NO agregar `.superRefine()` cross-field "both required in prod" — la decisión de disabled/enabled la toma `initSupabase` en runtime, no el parser.
- [ ] El nombre canónico es **`SUPABASE_SERVICE_KEY`** (no `SUPABASE_SERVICE_ROLE_KEY`). Confirmado en `.env.example` línea 60. **DT-1 SDD**.
- [ ] `z.string().url()` valida formato a parse-time — AC-8 requiere fail-fast en startup.
- [ ] `z.string().min(1)` para la key garantiza que si está set, no es string vacío.

#### W1.2 — `src/infra/supabase.ts` (NEW)

**Acción**: crear módulo singleton lazy-init, análogo a `src/infra/redis.ts` (188 LOC).

**Imports permitidos**:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'; // CD-10/CD-12: named import
import type { Logger } from 'pino';        // type-only
import type { EnvConfig } from './env.js'; // type-only; Node16 ESM requires .js extension
```

**Imports PROHIBIDOS**:

- `default import` del package: `import supabase from '@supabase/supabase-js'` → NO (CD-12, Supabase-js v2 expone solo named exports).
- `import * as Supabase from '@supabase/supabase-js'` → NO.
- `src/routes/*`, `src/core/*`, `src/chains/*`, `src/methods/*` — infra no conoce capas superiores.

**Exports obligatorios** (5):

```ts
export type SupabaseLogger = Pick<Logger, 'info' | 'error' | 'warn' | 'debug'>;
export function initSupabase(env: EnvConfig, logger: SupabaseLogger): void;
export function getSupabaseClient(): SupabaseClient | null;
export function resetSupabaseClientForTests(): void;
export function redactSupabaseKey(raw: string): string;
```

**State del módulo** (module-level, análogo a redis.ts):

```ts
let _client: SupabaseClient | null = null;
let _env: EnvConfig | null = null;
let _logger: SupabaseLogger | null = null;
let _initialized = false;
let _loggedDisabled = false;  // evita spam del warn "disabled" por request
```

**Comportamiento requerido**:

1. **`initSupabase(env, logger)`** — idempotente. Guarda refs a `_env` y `_logger`, setea `_initialized = true`. Si **ambas vars** están definidas → log `info` "Supabase client configured" con `{ url: <hostname-only>, keyPreview: redactSupabaseKey(key) }`. Si faltan → log `info` (o `warn`) UNA VEZ "Supabase client not configured — ledger disabled" (AC-4). NO crea el cliente todavía (lazy).
2. **`getSupabaseClient()`**:
   - Si `!_initialized` o `!_env?.SUPABASE_URL` o `!_env?.SUPABASE_SERVICE_KEY` → `return null` (AC-4/AC-7).
   - Si `_client` ya existe → return cached.
   - Si no, `_client = createClient(_env.SUPABASE_URL, _env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })`; log `info` "Supabase client instantiated"; return.
3. **`resetSupabaseClientForTests()`** — clears **todo** el state del módulo: `_client = null`, `_env = null`, `_logger = null`, `_initialized = false`, `_loggedDisabled = false` (CD-8).
4. **`redactSupabaseKey(raw)`** — `try { return raw.slice(0, 8) + '…' + raw.slice(-4); } catch { return 'sb_***'; }`. Si `raw.length < 12`, retornar `'sb_***'`. **CD-2**.

**Boundary**: NO exportar nada más. NO exportar `_client`.

#### W1.3 — `src/__tests__/unit/supabase.test.ts` (NEW)

**Acción**: tests del singleton. Exemplar: `src/__tests__/unit/redis.test.ts` (325 LOC completo).

**Patrón obligatorio**:

```ts
// Al tope del archivo:
vi.mock('@supabase/supabase-js', () => {
  const createClientSpy = vi.fn(
    (url: string, key: string, opts?: unknown) => new SupabaseMock(url, key, opts),
  );
  class SupabaseMock {
    constructor(public url: string, public key: string, public opts?: unknown) {}
    from = vi.fn();  // no lo usamos en W1 tests, stub seguro
  }
  return { createClient: createClientSpy };
});

// En beforeEach:
beforeEach(() => {
  resetSupabaseClientForTests();
});
```

**Tests requeridos** (7 — IDs T4..T11 del SDD §9):

- **T4**: `redactSupabaseKey(validLongKey)` → substring inicio + `…` + últimos 4. `redactSupabaseKey('short')` → `'sb_***'`. Cubre **AC-10 / CD-2**.
- **T5**: sin llamar `initSupabase` → `getSupabaseClient()` retorna `null`. Cubre **AC-12**.
- **T6**: `initSupabase({ SUPABASE_URL: undefined } as EnvConfig, logger)` → `getSupabaseClient()` retorna `null`. Cubre **AC-7**.
- **T7**: dos calls a `getSupabaseClient()` tras init válido → `createClient` spy fue llamado 1 vez. Cubre **AC-12 (singleton)**.
- **T8**: `initSupabase(env, logger)` llamado 2 veces consecutivas → idempotente, no corrompe state. Cubre **AC-12**.
- **T9**: tras `resetSupabaseClientForTests()` → `getSupabaseClient()` retorna `null` nuevamente. Cubre **AC-12 / CD-8**.
- **T10**: `initSupabase` con vars válidas → `logger.info` llamado con payload que **incluye `keyPreview` redactado** (NO la key completa). Assertion: `expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ keyPreview: expect.not.stringContaining(rawKey) }), expect.any(String))`. Cubre **AC-10**.
- **T11**: `initSupabase` con `SUPABASE_URL: undefined` → `logger.info` (o warn) llamado UNA vez con mensaje "disabled". Cubre **AC-4**.

#### W1.4 — `src/__tests__/unit/env.test.ts` (APPEND)

**Acción**: agregar 3 tests al final del archivo existing. **NO modificar tests existing**.

**Tests nuevos** (T1-T3):

- **T1**: `parseEnv` con `SUPABASE_URL='https://foo.supabase.co'` + `SUPABASE_SERVICE_KEY='sb_secret_xyz'` + `NODE_ENV='production'` → retorna config sin throw. Cubre **AC-6**.
- **T2**: `parseEnv` con `SUPABASE_URL='not-a-url'` → throws con mensaje Zod "Invalid url". Cubre **AC-8**.
- **T3**: `parseEnv` con `NODE_ENV='production'` + AMBAS vars ausentes → pasa sin throw (CD-4: NO superRefine hard-fail). Cubre **CD-4**.

#### Wave 1 — dependencies

- Depende de W0 (supabase-js instalado).
- NO depende de W2/W3/W4.

#### Wave 1 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green (max-warnings 0; **CD-10 + CD-12**: imports estrictos, named import confirmado).
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/infra/supabase.ts src/infra/env.ts src/__tests__/unit/supabase.test.ts src/__tests__/unit/env.test.ts`; **CD-9**).
- [ ] `npm test -- --run` → 340 baseline + 11 nuevos = **351/351** (T1-T11).
- [ ] `grep -n "from '@supabase/supabase-js'" src/infra/supabase.ts` → exactly 1 match con shape `import { createClient, type SupabaseClient } from '@supabase/supabase-js'`. **CD-12**.
- [ ] `grep -nE "from '\\.\\./(routes|core|chains|methods)'" src/infra/supabase.ts` → zero matches.
- [ ] `grep -n "console\\." src/infra/supabase.ts` → zero matches. **CD-5**.

---

### Wave 2 — `src/core/ledger.ts` (LedgerEntry + builder + persistor) + tests

**Objetivo**: módulo core que mapea `AdapterResult<SettleResult>` + context → `LedgerEntry`, y persiste vía Supabase UPSERT fire-and-forget.

#### Files (W2)

| # | Path | Acción |
|---|------|--------|
| 8 | `src/core/ledger.ts` | **CREATE** |
| 9 | `src/__tests__/unit/ledger.test.ts` | **CREATE** |

#### W2.1 — `src/core/ledger.ts` (NEW)

**Imports permitidos** (OWNERS: `src/core/*` MAY import `src/infra/*`):

```ts
import type { Logger } from 'pino';                       // type-only
import { getSupabaseClient } from '../infra/supabase.js'; // runtime
// OPCIONAL type-only si se necesita narrow:
// import type { X402ErrorCode } from './types.js';
```

**Imports PROHIBIDOS** (CD-3):

- `src/chains/*` (any) — el builder recibe el shape ya serializado desde la route, no importa `SettleResult` de `chains/types.ts` directo (para mantener boundary). Usa un **structural input type** local (mismo patrón que `ToCacheableInput` en `src/core/idempotency.ts`).
- `src/methods/*` (any).
- `src/routes/*` (any).
- `@supabase/supabase-js` — NO import directo; se accede vía `getSupabaseClient()`.

**Exports obligatorios**:

```ts
export type LedgerLogger = Pick<Logger, 'warn' | 'debug'>;

export interface LedgerEntry {
  readonly idempotency_key: string;   // sha256 hex (64 chars)
  readonly status: 'success' | 'failed';
  readonly tx_hash: string | null;
  readonly block_number: number | null;
  readonly network: string;            // 'eip155:<chainId>'
  readonly method: 'eip3009' | 'permit2' | 'erc7710';
  readonly asset: string;
  readonly amount: string;             // uint256 as string — CD-17
  readonly payer: string;
  readonly payee: string;
  readonly error_code: string | null;
  readonly error_http: number | null;
  readonly duration_ms: number;
}

// Structural input — NO importa SettleResult de chains/types.ts.
export interface BuildLedgerEntryInput {
  readonly idempotencyKey: string;
  readonly durationMs: number;
  readonly method: 'eip3009' | 'permit2' | 'erc7710';
  readonly network: string;
  // Datos del request parseado (fallback para asset/payer/payee/amount en error path)
  readonly parsed: {
    readonly accepted: {
      readonly asset: string;
      readonly payTo: string;
      readonly amount: string;
    };
    readonly payload: {
      readonly authorization: { readonly from: string };
    };
  };
  readonly result:
    | {
        readonly ok: true;
        readonly settled: true;
        readonly transactionHash: string;
        readonly blockNumber: number;
        readonly amount: string;
        readonly from: string;
        readonly to: string;
        readonly asset: string;
      }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message?: string;
          readonly http: number;
        };
      };
}

export function buildLedgerEntry(input: BuildLedgerEntryInput): LedgerEntry;

export async function persistLedgerEntry(
  entry: LedgerEntry,
  logger: LedgerLogger,
): Promise<void>;
```

**Comportamiento requerido**:

1. **`buildLedgerEntry(input)`** — pure function, sin side effects:
   - Si `input.result.ok === true` → construir `LedgerEntry` con **13 campos listados explícitamente uno por uno** (CD-13 — NO `{ ...input.result }`): `status='success'`, `tx_hash = input.result.transactionHash`, `block_number = input.result.blockNumber`, `network/method/amount/asset/payer/payee` desde `input.result` (from→payer, to→payee), `error_code=null`, `error_http=null`, `idempotency_key/duration_ms` desde `input`.
   - Si `input.result.ok === false` → `status='failed'`, `tx_hash=null`, `block_number=null`, `error_code = input.result.error.code`, `error_http = input.result.error.http`. `network/method/asset/payer/payee/amount` **derivan de `input.parsed`** (NO hay result.settled en error). `parsed.accepted.asset/payTo/amount` + `parsed.payload.authorization.from` → payer.
   - **CD-17**: `amount` siempre se construye como `string` (atomic uint256). NO `Number()` / `BigInt()`.

2. **`persistLedgerEntry(entry, logger)`** — fire-and-forget:
   1. `const client = getSupabaseClient(); if (!client) return;` (AC-4/AC-7).
   2. Envuelve en `try/catch` ALL the way. **Nunca throwea** (CD-1).
   3. Llama:
      ```ts
      const { data, error } = await client
        .from('facilitator_settlements')
        .upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true });
      ```
   4. Si `error` no-null → `logger.warn({ err: error, idempotency_key: entry.idempotency_key, network: entry.network }, 'ledger upsert failed')` y return. (AC-3)
   5. Si `error` null + `data` es array empty / null (ignoreDuplicates → conflict silenciado) → `logger.debug({ idempotency_key: entry.idempotency_key }, 'ledger upsert silenced duplicate')`. (AC-5)
   6. Si exception throwea del await → catch bloc: `logger.warn({ err, idempotency_key: entry.idempotency_key, network: entry.network }, 'ledger upsert failed')`. NUNCA re-throw. (AC-3/CD-1)

**Restricciones**:

- [ ] **CD-1**: `persistLedgerEntry` NUNCA throwea al caller — todo `throw` capturado.
- [ ] **CD-5**: cero `console.log`, todo vía `logger`.
- [ ] **CD-13**: objeto `LedgerEntry` construido con los 13 campos listados nombrados; NO rest-spread.
- [ ] **CD-17**: `amount` permanece `string` end-to-end.
- [ ] Si usás Record lookup dinámico tipo `RECORD[key]` en el builder (poco probable acá) → agregá `// eslint-disable-next-line security/detect-object-injection` + justificación, precedente `src/core/errors.ts` líneas 101-104 (**CD-11**).

#### W2.2 — `src/__tests__/unit/ledger.test.ts` (NEW)

**Patrón mock**: mock `../infra/supabase.js` (no `@supabase/supabase-js` directo — `ledger.ts` consume el wrapper). Exemplar: `src/__tests__/unit/core.idempotency.settle.test.ts` líneas 30-80 (Map store + `vi.fn`).

**Scaffold**:

```ts
vi.mock('../../../infra/supabase.js', () => {
  const upsertSpy = vi.fn();
  const fromSpy = vi.fn(() => ({ upsert: upsertSpy }));
  const getSupabaseClient = vi.fn();  // controlaremos el return en cada test
  return {
    __esModule: true,
    getSupabaseClient,
    __upsertSpy: upsertSpy,
    __fromSpy: fromSpy,
  };
});
```

**Tests requeridos** (8 — IDs T12..T19 del SDD §9):

- **T12**: `buildLedgerEntry({ result: ok true, ... })` → retorna `LedgerEntry` con `status='success'`, 9 campos on-chain populados, `error_code=null`, `error_http=null`. Cubre **AC-1 / CD-13**.
- **T13**: `buildLedgerEntry({ result: ok false, error: { code:'INSUFFICIENT_BALANCE', http:402 }, parsed })` → `status='failed'`, `error_code='INSUFFICIENT_BALANCE'`, `error_http=402`, `tx_hash=null`, `block_number=null`, y `asset/payer/payee/amount` derivan de `parsed`. Cubre **AC-2 / CD-13**.
- **T14**: `buildLedgerEntry({ result: ok false, error: { code:'TRANSACTION_FAILED', http:500 }, parsed })` → `status='failed'`, `error_code='TRANSACTION_FAILED'`, `error_http=500`. Cubre **AC-2-extended**.
- **T15**: `getSupabaseClient` mock retorna `null` → `persistLedgerEntry(entry, logger)` no llama `upsertSpy`, resuelve sin warning. Cubre **AC-4 / AC-7**.
- **T16**: `upsertSpy` spy resuelve `{ data: [{id:'...'}], error: null }` → `persistLedgerEntry` llama `from('facilitator_settlements').upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true })` **exacto**. Assertion: `expect(__fromSpy).toHaveBeenCalledWith('facilitator_settlements')` + `expect(__upsertSpy).toHaveBeenCalledWith(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true })`. Cubre **AC-5 (signature) / NC-2**.
- **T17**: `upsertSpy.mockRejectedValueOnce(new Error('network down'))` → `persistLedgerEntry` resuelve sin throw, `logger.warn` llamado con `{ err, idempotency_key, network }`. Cubre **AC-3 / CD-1**.
- **T18**: `upsertSpy.mockResolvedValueOnce({ data: null, error: { message: 'permission denied', code: '42501' } })` → resuelve sin throw, `logger.warn` llamado. Cubre **AC-3**.
- **T19**: `upsertSpy.mockResolvedValueOnce({ data: [], error: null })` (duplicate ignored) → `logger.debug` llamado con `{ idempotency_key }`, `logger.warn` NO llamado. Cubre **AC-5**.

#### Wave 2 — dependencies

- Depende de W1 (`getSupabaseClient` exportado).
- NO depende de W3/W4.

#### Wave 2 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/core/ledger.ts src/__tests__/unit/ledger.test.ts`; **CD-9**).
- [ ] `npm test -- --run` → 351 previos + 8 nuevos = **359/359** (T12-T19).
- [ ] `grep -nE "from '\\.\\./(chains|methods|routes)/" src/core/ledger.ts` → zero matches. **CD-3**.
- [ ] `grep -n "@supabase/supabase-js" src/core/ledger.ts` → zero matches (solo via `getSupabaseClient`).
- [ ] `grep -nE "throw " src/core/ledger.ts` → zero matches **dentro de `persistLedgerEntry`** (el builder puro puede lanzar si recibe input imposible, pero la función de persistencia nunca). **CD-1**.
- [ ] `grep -n "console\\." src/core/ledger.ts` → zero matches. **CD-5**.

---

### Wave 3 — hooks en `src/routes/settle.ts` + tests de integración

**Objetivo**: 3 puntos de invocación del ledger en la route existing, sin tocar `src/core/settle.ts` (CD-3).

#### Files (W3)

| # | Path | Acción |
|---|------|--------|
| 10 | `src/routes/settle.ts` | **MODIFY** (3 hooks + 1 import) |
| 11 | `src/__tests__/unit/routes.settle.test.ts` | **MODIFY** (append T20-T22, T24) |

#### W3.1 — `src/routes/settle.ts`

**Import a agregar** (top del archivo, junto con los otros imports):

```ts
import { buildLedgerEntry, persistLedgerEntry } from '../core/ledger.js';
```

**PROHIBIDO**: agregar `import ... from '../infra/supabase.js'` acá — la route consume SOLO via `src/core/ledger.ts`. **CD-3**.

**Tres hooks requeridos** (ubicación exacta según SDD §4.4.3, basado en `src/routes/settle.ts` actual):

| # | Branch | Ubicación conceptual | Acción |
|---|--------|----------------------|--------|
| H1 | Success on-chain (200) | **Después** del cache write (donde `toCacheableSettle` + `setCachedSettleResponse` se ejecutan), **ANTES** del `reply.code(200).send(...)` y del log info final | Construir entry con `result.ok=true` + `parsed` + `idempotencyKey` + `method: 'eip3009'` + `durationMs = Date.now() - startMs` + `network: parsed.accepted.network`. Luego `await persistLedgerEntry(entry, app.log)`. |
| H2 | Error x402 4xx/5xx del adapter (`result.ok === false`) | **Después** del log warn existing, **ANTES** del `reply.code(result.error.http).send({ error: result.error })` | Mismo builder con `result.ok=false` + `error` propagado. Luego `await persistLedgerEntry(entry, app.log)`. |
| H3 | Adapter throw (catch bloc, 500) | **Dentro** del `catch`, **antes** del `reply.code(500).send(body)` | Construir entry sintético con `result = { ok: false, error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 } }`. Luego `await persistLedgerEntry(entry, app.log)`. |

**Skeleton conceptual** (ver exemplar `src/routes/settle.ts` líneas 60-179 para la estructura actual):

```ts
// H1 — success branch, después del cache write, antes del reply.send 200:
const ledgerEntry = buildLedgerEntry({
  idempotencyKey,
  durationMs: Date.now() - startMs,
  method: 'eip3009',
  network: parsed.accepted.network,
  parsed,
  result: {
    ok: true,
    settled: result.settled,
    transactionHash: result.transactionHash,
    blockNumber: result.blockNumber,
    amount: result.amount,
    from: result.from,
    to: result.to,
    asset: result.asset,
  },
});
await persistLedgerEntry(ledgerEntry, app.log);
// ... reply.code(200).send(...)
```

**Excepción — cache-hit branch (`sendCachedSettle`)**: **NO invocar ledger** en el cache-hit path. El primer request ya persistió; un UPSERT con `ignoreDuplicates:true` sería silenciado pero agrega roundtrip innecesaria. Documentado en SDD §4.4.3.

**Reglas críticas**:

- [ ] **CD-14**: los 3 hooks usan **`await`** explícito, NUNCA `.catch(...)`, `void`, o fire-and-forget sin await.
- [ ] El orden para success: cache write → **ledger await** → log info → reply.send. No alterar.
- [ ] El orden para error x402: log warn → **ledger await** → reply.send. No alterar.
- [ ] El orden para catch 500: log error → **ledger await** → reply.send. No alterar.
- [ ] **NO** modificar `src/core/settle.ts` (CD-3). Core permanece puro.
- [ ] **NO** importar `@supabase/supabase-js` ni `../infra/supabase.js` en esta ruta (CD-3).

#### W3.2 — `src/__tests__/unit/routes.settle.test.ts` (APPEND)

**Acción**: agregar 4 tests nuevos al final del archivo existing. NO modificar tests existing.

**Mock pattern**: mock `../core/ledger.js`:

```ts
vi.mock('../../../core/ledger.js', () => {
  const persistSpy = vi.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    buildLedgerEntry: vi.fn((input) => ({ /* passthrough objeto sintético */ })),
    persistLedgerEntry: persistSpy,
    __persistSpy: persistSpy,
  };
});
```

**Tests requeridos** (4 — IDs T20, T21, T22, T24 del SDD §9):

- **T20**: POST /settle con body válido + adapter success → `__persistSpy` llamado 1 vez con entry `{ status: 'success', tx_hash: <hash>, ... }` **antes** de que el test reciba el response 200. Assertion: spy invocation ocurre antes del `await response.json()`. Cubre **AC-1**.
- **T21**: POST /settle con body válido + adapter returns `{ ok: false, error: { code:'INSUFFICIENT_BALANCE', http: 402 } }` → `__persistSpy` llamado 1 vez con entry `{ status: 'failed', error_code: 'INSUFFICIENT_BALANCE', error_http: 402 }` antes del response 402. Cubre **AC-2**.
- **T22**: POST /settle con adapter **throw** (`adapter.settle.mockRejectedValueOnce(new Error('rpc down'))`) → `__persistSpy` llamado 1 vez con `{ status: 'failed', error_code: 'TRANSACTION_FAILED', error_http: 500 }` antes del response 500. Cubre **AC-2-extended**.
- **T24**: POST /settle cache-hit (segundo request idéntico tras uno exitoso) → `__persistSpy` NO llamado en el segundo request (solo en el primero). Cubre la **excepción §4.4.3**.

**Anti-regresión**: todos los tests existing en `routes.settle.test.ts` deben seguir verdes tras los appends. No modificar setup compartido.

#### Wave 3 — dependencies

- Depende de W2 (`buildLedgerEntry`, `persistLedgerEntry` exportados).
- NO depende de W4.

#### Wave 3 — completion criteria

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green (si falla → `npx prettier --write src/routes/settle.ts src/__tests__/unit/routes.settle.test.ts`; **CD-9**).
- [ ] `npm test -- --run` → 359 previos + 4 nuevos = **363/363** (T20-T22, T24).
- [ ] `grep -nE "from '\\.\\./infra/" src/routes/settle.ts` → zero matches. **CD-3**.
- [ ] `grep -n "@supabase/supabase-js" src/routes/settle.ts` → zero matches.
- [ ] `grep -nE "persistLedgerEntry|buildLedgerEntry" src/routes/settle.ts` → **3 invocations de `persistLedgerEntry`** (H1, H2, H3) + 3 builds.
- [ ] `grep -nE "\\.catch\\(.*persistLedgerEntry\\)|void persistLedgerEntry" src/routes/settle.ts` → zero matches. **CD-14**.
- [ ] `src/core/settle.ts` NO fue tocado. `git diff src/core/settle.ts` → vacío. **CD-3**.

---

### Wave 4 — Bootstrap `src/app.ts` + BACKLOG TD + final QA

**Objetivo**: llamar `initSupabase` en `buildApp`, registrar la deuda técnica (RLS) en BACKLOG, y correr QA final.

#### Files (W4)

| # | Path | Acción |
|---|------|--------|
| 12 | `src/app.ts` | **MODIFY** (1 import + 1 llamada) |
| 13 | `BACKLOG.md` | **MODIFY** (agregar TD-SEC-LEDGER-01) |

#### W4.1 — `src/app.ts`

**Acción**: agregar `initSupabase(env, logger)` **inmediatamente después** de `initRedis(env, logger)` (línea 51 del exemplar `src/app.ts`).

```ts
// ADD al bloque de imports (después de `import { initRedis } from './infra/redis.js';`):
import { initSupabase } from './infra/supabase.js';

// ADD inside buildApp(), IMMEDIATELY AFTER `await initRedis(env, logger)` (o el call existente a initRedis):
initSupabase(env, logger);
```

**Reglas críticas**:

- [ ] **CD-15**: NO agregar `app.addHook('onClose', ...)` para Supabase. El cliente HTTP-based no necesita cleanup.
- [ ] `initSupabase` es **síncrono** (no await necesario — no hace network calls en init).
- [ ] NO mover ni reordenar `initRedis` ni el registro de rutas.

**Verification grep**:

```bash
grep -n "initRedis\|initSupabase" src/app.ts
# Expected output includes:
#   import { initRedis } from './infra/redis.js';
#   import { initSupabase } from './infra/supabase.js';
#   await initRedis(env, logger);   // or initRedis(env, logger)
#   initSupabase(env, logger);
```

#### W4.2 — `BACKLOG.md`

**Acción**: agregar una entrada de deuda técnica bajo la sección correspondiente (buscar "TD-SEC" o "Deuda técnica" existente):

```md
### TD-SEC-LEDGER-01 — Habilitar RLS en `facilitator_settlements`

Hoy la defensa sobre `facilitator_settlements` es solo **app-layer** (service role key escribe directo).
Para V1.5 / post-auditoría: `ALTER TABLE facilitator_settlements ENABLE ROW LEVEL SECURITY` +
`CREATE POLICY` por service role. Mismo trade-off que WKH-53 en wasiai-a2a.

- Fuente: WFAC-32 SDD §7 Riesgos.
- Gate: WFAC-SEC-01 (cuando se agende una iteración de hardening).
```

Si la sección/estructura no coincide, ubicar la entrada al final del archivo bajo una sección clara y linkeable.

#### W4.3 — QA final

```bash
npm run qa
```

Este comando corre `typecheck + lint + format:check + test`. **Debe exit 0**.

**Si falla**:

- `format:check` → `npx prettier --write <archivo>` y re-run (**CD-9**).
- `lint` → revisar cada warning/error contra **CD-10 / CD-11 / CD-12 / CD-13**.
- `test` → identificar el test fallido, verificar si es regresión (bug real) o expectativa desalineada (ajustar el test, NUNCA el feature).

#### W4.4 — Regression guard CRÍTICO

- [ ] `npm test -- --run` → **364/364 minimum** (340 baseline + 24 nuevos).
- [ ] Los 340 tests previos al WFAC-32 siguen **todos verdes**. Si alguno falló, es regresión en W1/W2/W3 — STOP + diagnose antes de continuar.
- [ ] Ejecutar `npm test -- --run routes.settle` → los tests existing de WFAC-21 siguen verdes.
- [ ] Ejecutar `npm test -- --run redis` → los tests existing de WFAC-5 siguen verdes.
- [ ] Ejecutar `npm test -- --run core.idempotency` → idempotency tests verdes.

#### Wave 4 — completion criteria

- [ ] `npm run qa` → exit 0 sin warnings.
- [ ] **364/364** tests pasan (o más si se agregó algún stretch).
- [ ] `git diff src/app.ts` → exactamente 2 líneas agregadas (1 import + 1 call).
- [ ] `grep -n "addHook.*onClose.*[Ss]upabase\\|supabase.*onClose" src/app.ts` → zero matches. **CD-15**.
- [ ] `BACKLOG.md` incluye `TD-SEC-LEDGER-01`.
- [ ] **`.env.example` líneas 59-60 NO modificadas** (DT-1). Verificar con `git diff .env.example` → vacío.
- [ ] `git status` limpio de archivos fuera del Scope IN.

---

## 2. AC → Wave → Test matrix (12 ACs + AC-2-extended)

| AC | Descripción | Wave | Test(s) que cubre | Archivo |
|----|-------------|------|-------------------|---------|
| **AC-1** | Success → INSERT status='success' con 9 campos antes del reply 200 | W2 + W3 | T12 (builder), T20 (route integration) | `ledger.test.ts`, `routes.settle.test.ts` |
| **AC-2** | Error x402 4xx → INSERT status='failed' con error_code/error_http antes del reply | W2 + W3 | T13 (builder), T21 (route integration) | `ledger.test.ts`, `routes.settle.test.ts` |
| **AC-2-extended** | 5xx (adapter throw) → INSERT status='failed' error_code='TRANSACTION_FAILED' error_http=500 | W2 + W3 | T14 (builder), T22 (route integration) | `ledger.test.ts`, `routes.settle.test.ts` |
| **AC-3** | DB error → log warn + reply sin modificar (fail-open) | W2 | T17, T18 | `ledger.test.ts` |
| **AC-4** | Env vars ausentes → skip ledger + warn startup, no crash | W1 + W2 | T11, T15, T23 (opcional W4 stretch) | `supabase.test.ts`, `ledger.test.ts` |
| **AC-5** | UNIQUE conflict → UPSERT ON CONFLICT DO NOTHING + log debug | W2 | T16 (signature), T19 (duplicate behavior) | `ledger.test.ts` |
| **AC-6** | prod/dev + ambas vars → singleton activo | W1 | T1 | `env.test.ts` |
| **AC-7** | test + sin SUPABASE_URL → no-op total | W1 + W2 | T6, T15 | `supabase.test.ts`, `ledger.test.ts` |
| **AC-8** | SUPABASE_URL inválida → parseEnv fail-fast con Zod | W1 | T2 | `env.test.ts` |
| **AC-9** | NO PII HTTP en la tabla (solo on-chain data) | W0 (schema) + AR | Grep review del DDL + AR audit | `supabase/migrations/001_*.sql` |
| **AC-10** | SERVICE_KEY nunca en logs (rigor OPERATOR_PRIVATE_KEY) | W1 | T4 (redact), T10 (log assertion) | `supabase.test.ts` |
| **AC-11** | `persistLedgerEntry` invocado desde route, NO desde `src/core/settle.ts` | W3 | `grep` audit W3.5 + AR review | `src/routes/settle.ts` |
| **AC-12** | `src/infra/supabase.ts` replica patrón `redis.ts` (init/get/resetForTests) | W1 | T5, T7, T8, T9 | `supabase.test.ts` |

**Total**: 24 tests nuevos (T1-T24) — cada AC tiene ≥ 1 test; ACs críticos (AC-1, AC-2, AC-3, AC-4, AC-5, AC-12) tienen ≥ 2.

---

## 3. Constraint Directives — 17 CDs (8 heredados WI + 9 nuevos SDD)

### 3.1 Heredados del work-item (CD-1..CD-8)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-1** | PROHIBIDO que `persistLedgerEntry` throwea al caller — todo error capturado + log warn | `src/core/ledger.ts` (W2) |
| **CD-2** | PROHIBIDO `SUPABASE_SERVICE_KEY` en logs — usar `redactSupabaseKey` | `src/infra/supabase.ts` (W1) |
| **CD-3** | PROHIBIDO importar `src/infra/supabase.ts` desde `src/chains/*`, `src/methods/*`, `src/middleware/*`, `src/routes/*` directo. Solo `src/core/ledger.ts` + `src/app.ts` | `src/core/ledger.ts` (W2), `src/routes/settle.ts` (W3), `src/core/settle.ts` (frozen) |
| **CD-4** | OBLIGATORIO `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` opcionales en `EnvSchema`, **sin** `superRefine` hard-fail | `src/infra/env.ts` (W1.1) |
| **CD-5** | PROHIBIDO `console.log` — usar logger Pino pasado como argumento | `src/infra/supabase.ts` (W1), `src/core/ledger.ts` (W2) |
| **CD-6** | OBLIGATORIO migration en `supabase/migrations/001_facilitator_settlements.sql` (padding 3 dígitos, convención README) | W0.1 |
| **CD-7** | PROHIBIDO almacenar `client_ip`, `user_agent`, request metadata en `facilitator_settlements` (pertenece a `facilitator_audit_log` WFAC-33) | `supabase/migrations/001_*.sql` (W0.1), `src/core/ledger.ts` (W2) |
| **CD-8** | OBLIGATORIO implementar `resetSupabaseClientForTests()` en `src/infra/supabase.ts` | `src/infra/supabase.ts` (W1.2) |

### 3.2 Nuevos del SDD (CD-9..CD-17)

| # | Directiva | Aplica en |
|---|-----------|-----------|
| **CD-9** | OBLIGATORIO `npx prettier --write <archivos>` antes de cada wave commit (auto-blindaje WFAC-22/WFAC-23) | Todas las waves |
| **CD-10** | PROHIBIDO importar símbolos no consumidos directamente en el archivo; `type X` usa `import type` (auto-blindaje WFAC-20 W0) | `src/infra/supabase.ts`, `src/core/ledger.ts`, tests nuevos |
| **CD-11** | Si hay `RECORD[runtimeKey]` en ledger/supabase → agregar `eslint-disable-next-line security/detect-object-injection` + justificación citando `src/core/errors.ts` líneas 101-104 | `src/core/ledger.ts` (si aplica) |
| **CD-12** | OBLIGATORIO `import { createClient, type SupabaseClient } from '@supabase/supabase-js';`. PROHIBIDO default import / namespace import | `src/infra/supabase.ts` (W1.2) |
| **CD-13** | OBLIGATORIO construir `LedgerEntry` con los 13 campos NOMBRADOS uno por uno (NO `{ ...result }`). Precedente: WFAC-20 W1 auto-blindaje | `src/core/ledger.ts` (W2.1) |
| **CD-14** | OBLIGATORIO `await persistLedgerEntry(...)` en los 3 hooks de route. PROHIBIDO `.catch(...)` o `void ...` | `src/routes/settle.ts` (W3.1) |
| **CD-15** | PROHIBIDO agregar `app.addHook('onClose', ...)` para Supabase en `src/app.ts` | `src/app.ts` (W4.1) |
| **CD-16** | PROHIBIDO editar `supabase/migrations/001_facilitator_settlements.sql` después del merge a main. Cualquier cambio de schema → `002_*.sql` | W0.1 (pre-merge OK corregir typos) |
| **CD-17** | OBLIGATORIO `amount` como `string` end-to-end (uint256 via NUMERIC(78,0) en DDL). PROHIBIDO `Number(amount)` / `BigInt(amount)` | `src/core/ledger.ts` (W2.1), `supabase/migrations/001_*.sql` (W0.1) |

---

## 4. Guardrails anti-drift (checklist rápido para el Dev)

**Antes de cada commit, corré mentalmente esta lista**:

- [ ] **NO importar `@supabase/supabase-js` ni `../infra/supabase.js` desde `src/routes/settle.ts`**. Consume SOLO via `src/core/ledger.ts`. (**CD-3**)
- [ ] **NO `throw` desde `persistLedgerEntry`** ni de cualquier función en la cadena de persistencia. Todo error capturado internamente. (**CD-1**)
- [ ] **NO `console.log`** en ningún módulo nuevo. Todo va por el logger Pino inyectado. (**CD-5**)
- [ ] **NO renombrar env vars**. Nombres canónicos: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (DT-1). **NO** `SUPABASE_SERVICE_ROLE_KEY`. (**DT-1 SDD**)
- [ ] **NO tocar `src/core/settle.ts`** ni `src/chains/types.ts` ni `src/core/errors.ts` ni `src/core/types.ts`. El core permanece puro + los types son frozen. (**CD-3 + Scope IN**)
- [ ] **NO agregar `app.addHook('onClose', ...)` para Supabase** en `src/app.ts`. HTTP client sin cleanup necesario. (**CD-15**)
- [ ] **NO `ENABLE ROW LEVEL SECURITY` en el DDL** — scope OUT (TD-SEC-LEDGER-01 en BACKLOG). (**Scope OUT SDD §6**)
- [ ] **NO guardar `client_ip`, `user_agent`, `request_id`, headers HTTP en `facilitator_settlements`** — es WFAC-33. (**CD-7 / AC-9**)
- [ ] **Si `amount` excede `uint256` range** → usar **string** `NUMERIC(78,0)`, nunca `Number()` ni `BigInt()`. (**CD-17**)
- [ ] **Si `001_*.sql` tiene typo** antes del merge → PARAR + arreglar in-place. Post-merge, migration inmutable — cualquier cambio va a `002_*.sql`. (**CD-16**)
- [ ] **NO `import supabase from '@supabase/supabase-js'`** (default). Supabase-js v2 expone solo named exports. (**CD-12**)
- [ ] **NO instalar deps extra** (`@supabase/realtime-js`, `auth-helpers-*`, `postgrest-js` directo, etc.). Solo `@supabase/supabase-js`. (**SDD §5.3**)
- [ ] **NO `.catch(...)` ni `void persistLedgerEntry(...)`** en la route — siempre `await`. (**CD-14**)
- [ ] **NO construir `LedgerEntry` con `{ ...result }`** — listar los 13 campos. (**CD-13**)

### Regression guard CRÍTICO (tras cada wave, antes del próximo commit)

- [ ] `npm test -- --run` sigue verde para el baseline 340 tests previos.
- [ ] `npm test -- --run routes.settle.test.ts` verde (WFAC-21 sin regresión).
- [ ] `npm test -- --run redis.test.ts` verde (WFAC-5 sin regresión).
- [ ] `npm test -- --run core.idempotency.test.ts` verde (WFAC-20 sin regresión).
- [ ] **364/364 mínimo al final de W4**. Si ves 363 o menos → hay regresión, STOP + diagnose.

---

## 5. Done Definition (HU-32)

- [ ] Todas las waves W0-W4 cerradas con sus completion criteria.
- [ ] `npm run qa` exit 0.
- [ ] **≥ 364 tests passing** (340 baseline + 24 nuevos T1-T24).
- [ ] 13 archivos del Scope IN tocados; **ningún archivo fuera del Scope IN modificado**.
- [ ] Migration `001_facilitator_settlements.sql` creada, idempotente, con el CHECK `success_has_tx`.
- [ ] `@supabase/supabase-js: ^2.45.x` instalado en `package.json` + lockfile regenerado.
- [ ] `src/infra/supabase.ts` replica patrón `redis.ts` (init/get/resetForTests/redactKey).
- [ ] `src/core/ledger.ts` exporta `LedgerEntry`, `buildLedgerEntry`, `persistLedgerEntry`.
- [ ] `src/routes/settle.ts` invoca ledger en **3 hooks** (success, x402 error, adapter throw) con `await`. Cache-hit NO invoca ledger.
- [ ] `src/app.ts` llama `initSupabase(env, logger)` después de `initRedis`.
- [ ] `BACKLOG.md` incluye `TD-SEC-LEDGER-01`.
- [ ] Los 17 CDs respetados (8 heredados + 9 nuevos).
- [ ] `.env.example` líneas 59-60 **intactas** (names canónicos preservados).
- [ ] `src/core/settle.ts` **intacto** (CD-3 — core pure).
- [ ] Commit messages con prefix `WFAC-32` y referencia a la wave (`WFAC-32 W0: migration + deps`, etc.).

---

## 6. Referencias rápidas

- **Work Item**: `doc/sdd/013-wfac-32-settlement-ledger/work-item.md`
- **SDD completo**: `doc/sdd/013-wfac-32-settlement-ledger/sdd.md`
- **Baseline post-WFAC-23**: 340/340 tests passing
- **Target post-WFAC-32**: ≥ 364/364
- **Branch**: `feat/013-wfac-32-settlement-ledger` (desde `main`)
- **Supabase vars canónicas**: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (.env.example líneas 59-60)
- **Convención migration**: `NNN_descripcion.sql` (padding 3 dígitos, idempotente)
- **Patrón referencia**: `src/infra/redis.ts` (singleton) + `src/core/idempotency.ts` (core-consume-infra)

---

*Story File generado por NexusAgil — F2.5 — WFAC-32 — 2026-04-23 — Architect*
