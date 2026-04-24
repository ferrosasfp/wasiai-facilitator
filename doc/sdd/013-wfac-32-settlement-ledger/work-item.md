# Work Item — [WFAC-32] Settlement Ledger (Supabase)

## Resumen

Persistir cada resultado de POST /settle en una tabla Supabase `facilitator_settlements`
inmediatamente antes de responder al cliente — tanto resultados exitosos como errores de
x402 — para habilitar auditoría de trazabilidad on-chain, métricas de volumen por chain/asset,
y reconciliación off-chain en caso de disputes.

Regla central: **la persistencia es fire-and-forget**. Si el INSERT/UPSERT falla, el servicio
responde al cliente normalmente con el resultado del settle ya ejecutado on-chain. La tx
ya ocurrió; bloquear la respuesta por fallo de BD sería un error de diseño grave.

Audiencia primaria: operadores del facilitator (auditoría interna). No exposición pública.

---

## Sizing

- **SDD_MODE**: full
- **Pipeline**: QUALITY (infraestructura DB, schema, env vars producción, service role key, Supabase client nuevo)
- **Estimación**: M
- **Branch sugerido**: `feat/013-wfac-32-settlement-ledger`

---

## Acceptance Criteria (EARS)

### Persistencia — happy path

- **AC-1**: WHEN POST /settle produces a successful on-chain result (settled: true),
  THEN the system SHALL INSERT a row into `facilitator_settlements` with status='success',
  tx_hash, block_number, amount, asset, payer, payee, network, method, idempotency_key,
  and duration_ms populated, BEFORE sending the 200 response to the client.

- **AC-2**: WHEN POST /settle returns a non-5xx x402 error (e.g. INVALID_SIGNATURE,
  INSUFFICIENT_BALANCE), THEN the system SHALL INSERT a row into `facilitator_settlements`
  with status='failed', error_code, error_http, and duration_ms populated, BEFORE sending
  the error response to the client.

### Fail-open — persistência nunca bloquea

- **AC-3**: IF the Supabase INSERT/UPSERT throws or returns a Supabase error object,
  THEN the system SHALL log a structured `warn` with `{ err, idempotency_key, network }`
  and SHALL still send the original settle result (success or error) to the client
  without modification. The client response MUST NOT be delayed or altered by persistence
  failure.

- **AC-4**: IF `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is absent at runtime,
  THEN the system SHALL skip all ledger persistence calls (no-op path), log a single
  `warn` at startup indicating the ledger is disabled, and SHALL NOT crash or reject
  incoming /settle requests. Settle flow continues normally.

### Idempotency safety

- **AC-5**: WHEN the same `idempotency_key` is already present in `facilitator_settlements`
  (UNIQUE constraint conflict on re-insert), THEN the system SHALL treat the conflict as
  a no-op (UPSERT with ON CONFLICT DO NOTHING or equivalent), log a `debug` line, and
  SHALL NOT propagate the conflict as an error to the client.

  Rationale: a process crash between the adapter returning and the Redis cache write could
  cause the route to retry. The second INSERT would hit the UNIQUE constraint; swallowing it
  is correct.

### Env vars y schema

- **AC-6**: WHEN the service starts with `NODE_ENV !== 'test'` and both `SUPABASE_URL`
  and `SUPABASE_SERVICE_KEY` are defined, THEN the Supabase client singleton SHALL
  initialize successfully and the ledger SHALL be considered active.

- **AC-7**: WHILE `NODE_ENV === 'test'` and `SUPABASE_URL` is undefined,
  the system SHALL skip Supabase client initialization and all `persistLedgerEntry` calls
  SHALL be no-ops, keeping unit tests free of live Supabase dependency.

  Pattern mirrors WFAC-5 AC-3 (Redis optional in test env).

- **AC-8**: WHEN `SUPABASE_URL` is defined but has an invalid format (not a valid URL),
  THEN `parseEnv` SHALL reject at startup with a human-readable Zod validation error
  before Fastify listens (fail-fast; mirrors existing REDIS_URL behavior).

### Seguridad / PII

- **AC-9**: the system SHALL NOT store any field that constitutes off-chain PII in
  `facilitator_settlements`. Specifically: `payer` and `payee` are Ethereum addresses
  (public on-chain data) and are authorized. IP addresses, user-agent headers, or any
  HTTP request metadata NOT visible on-chain SHALL NOT be stored in this table.

  Note: client IP + request-level metadata is OUT OF SCOPE and belongs in
  `facilitator_audit_log` (WFAC-33).

- **AC-10**: the system SHALL use `SUPABASE_SERVICE_KEY` (service role key) exclusively
  for ledger writes. The key SHALL be sourced only from `process.env` via the validated
  `EnvConfig`. It SHALL NOT appear in logs (same redaction rule as OPERATOR_PRIVATE_KEY).

### Boundary y módulos

- **AC-11**: WHILE the system is processing a POST /settle request, the ledger
  persistence call SHALL be invoked from `src/routes/settle.ts` (or a helper imported
  by it), NEVER from `src/core/settle.ts`. The `src/core/` boundary MUST NOT import
  `src/infra/supabase.ts` or `src/core/ledger.ts` if ledger.ts imports infra.

  Rationale: OWNERS.md — `src/core/` MAY import `src/infra/*` but `src/core/settle.ts`
  is currently pure (no I/O). Ledger is I/O; it belongs in the route layer to keep
  the core orchestrator testable without Supabase.

  [NEEDS CLARIFICATION — F2]: Architect must decide whether `persistLedgerEntry` lives
  in `src/core/ledger.ts` (core module with infra import) or directly in
  `src/routes/settle.ts`. OWNERS.md permits core→infra imports; the question is
  whether the ledger function should be independently testable as a core service.
  Recommendation: `src/core/ledger.ts` importing `src/infra/supabase.ts` is valid per
  OWNERS.md and follows the existing pattern (core/idempotency.ts imports infra/redis.ts).

- **AC-12**: `src/infra/supabase.ts` SHALL follow the same singleton pattern as
  `src/infra/redis.ts`: module-level state, `initSupabase(env, logger)` called once
  from `buildApp()`, `getSupabaseClient()` returns `SupabaseClient | null`,
  `resetSupabaseClientForTests()` for test isolation.

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `src/infra/supabase.ts` | Cliente Supabase singleton (nuevo — no existe) |
| `src/core/ledger.ts` | `persistLedgerEntry(entry, logger)` — fire-and-forget (nuevo) |
| `src/routes/settle.ts` | Hook post-adapter, pre-response para llamar `persistLedgerEntry` |
| `src/infra/env.ts` | Agregar `SUPABASE_URL` (z.string().url().optional()) y `SUPABASE_SERVICE_KEY` (z.string().min(1).optional()) al EnvSchema, con superRefine opcional en prod |
| `.env.example` | Ya tiene `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` — validar nombre exacto |
| `supabase/migrations/0001_facilitator_settlements.sql` | DDL de la tabla + indexes (nuevo directorio) |
| `package.json` | Agregar `@supabase/supabase-js` como runtime dependency (no instalado aún) |
| `src/__tests__/unit/supabase.test.ts` | Tests del singleton (mock de @supabase/supabase-js) |
| `src/__tests__/unit/ledger.test.ts` | Tests de persistLedgerEntry (fail-open, idempotency no-op) |
| `doc/sdd/013-wfac-32-settlement-ledger/` | SDD artifacts |

---

## Scope OUT

| Artefacto | Razón |
|-----------|-------|
| `facilitator_audit_log` table | Scope WFAC-33 — audit log inmutable append-only con IP, request_id, payload_hash. Diferente tabla, diferente HU. |
| RLS (Row Level Security) en Supabase | La defensa es app-layer (mismo patrón que wasiai-a2a WKH-53). RLS es deuda técnica a trackear como TD en BACKLOG.md. |
| `/verify` ledger | Solo persist para `/settle` en esta HU. `/verify` no mueve fondos. |
| BullMQ retry queue | WFAC-V1.5. El ledger registra el resultado, no dispara reintentos. |
| Dashboard / reporting UI | No scope en este proyecto. |
| Métricas Prometheus de ledger | Puede agregarse en una HU de observabilidad posterior. |
| `facilitator_idempotency` table | Ya gestionado por Redis. Persistencia en Supabase más allá de 120s es WFAC futuro. |
| Supabase Realtime / subscriptions | No se necesitan para ledger write. |

---

## Decisiones técnicas (DT-N)

- **DT-1: Nombre de la env var** — El proyecto usa `SUPABASE_SERVICE_KEY` (confirmado en
  `.env.example` línea 60 y `.nexus/project-context.md` sección "Variables de entorno").
  El input de la HU mencionó `SUPABASE_SERVICE_ROLE_KEY` (nombre del dashboard de Supabase).
  Se adopta `SUPABASE_SERVICE_KEY` como nombre canónico para mantener consistencia con el
  estado actual del proyecto. Dev debe respetar este nombre en el Zod schema.

- **DT-2: UPSERT vs INSERT** — Se usa UPSERT con `ON CONFLICT (idempotency_key) DO NOTHING`
  en lugar de INSERT puro. Justificación: si el proceso se cae entre `adapter.settle()` y
  el write de Redis, la siguiente request al mismo idempotency_key pasará por el adapter de
  nuevo (Redis miss), y se intentará un segundo INSERT al ledger. El UPSERT absorbe el
  conflicto sin propagar error al cliente (AC-5). La pérdida de información es aceptable
  (el primer registro ya está guardado). [NEEDS CLARIFICATION — F2]: Architect puede optar
  por INSERT + capturar código de error PGRST116/23505 explícitamente si prefiere
  visibilidad sobre conflictos vs. ON CONFLICT DO NOTHING silencioso.

- **DT-3: Lazy init del cliente Supabase** — `getSupabaseClient()` retorna `null` cuando
  Supabase no está configurado (test env o vars ausentes). `persistLedgerEntry` es no-op
  ante `null`. Mismo patrón que `getRedisClient()` en WFAC-5. No hay `lazyConnect` en
  Supabase (HTTP client, no TCP), pero el constructor se invoca en el primer
  `getSupabaseClient()` call para mantener coherencia con el patrón establecido.

- **DT-4: Timing del INSERT** — El INSERT ocurre DESPUÉS de que el adapter retorna el
  resultado (on-chain tx completada o fallida) y ANTES de enviar la respuesta HTTP al
  cliente. Esto asegura que `duration_ms` incluye el tiempo del adapter pero no el tiempo
  de red al cliente. La secuencia es: adapter → INSERT (fire-and-forget) → reply. Si el
  INSERT es async y el await falla, el catch log warn y el reply sigue.

- **DT-5: `duration_ms` — qué incluye** — `Date.now() - startMs` donde `startMs` se toma
  al inicio del handler de la route (ya existe en `src/routes/settle.ts` línea 63). El
  `duration_ms` del ledger es el mismo valor que ya se logea en los line logs del route.
  No crear un segundo timer.

- **DT-6: Schema column `idempotency_key`** — Es el SHA-256 hex del canonical-JSON del
  body (mismo valor que se usa como Redis key, sin el prefix `settle:idempotency:`). Se
  almacena el hash puro (64 chars hex) para que sea opaco y no revele el body. UNIQUE
  constraint garantiza unicidad.

- **DT-7: `@supabase/supabase-js` versión** — [NEEDS CLARIFICATION — F2]: Architect debe
  decidir versión. Recomendación: `^2.x` (v2 estable, LTS). v3 está en beta al 2026-04-23.
  Verificar compatibilidad con Node 20 ESM antes de pinear.

- **DT-8: `block_number` nullable** — En SettleResult, `blockNumber` es `number`. En la
  tabla es `BIGINT` (no nullable en el schema propuesto). Para filas con status='failed'
  no hay block_number. La columna debe ser NULLABLE en el DDL para las filas de error.
  El campo del DDL propuesto en la HU input tiene `block_number BIGINT` sin NOT NULL —
  correcto, mantener nullable.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que `persistLedgerEntry` (o cualquier función en la cadena de
  persistencia) haga `throw` o propague errores al caller. Todo error de Supabase DEBE
  ser capturado internamente y logeado como `warn`. El caller (route) NUNCA debe
  necesitar try/catch alrededor de `persistLedgerEntry`.

- **CD-2**: PROHIBIDO almacenar `SUPABASE_SERVICE_KEY` o fragmentos de ella en logs.
  El client singleton DEBE redactar la key antes de cualquier línea de log (igual que
  `redactRedisUrl` para Redis). Una función `redactSupabaseKey(raw: string): string`
  análoga es OBLIGATORIA si se logea algo relacionado con la configuración del cliente.

- **CD-3**: PROHIBIDO importar `src/infra/supabase.ts` desde `src/chains/*`,
  `src/methods/*`, o `src/middleware/*`. Solo `src/core/ledger.ts` y `src/app.ts`
  (para init) pueden importarlo.

- **CD-4**: OBLIGATORIO que `src/infra/env.ts` declare `SUPABASE_URL` y
  `SUPABASE_SERVICE_KEY` como opcionales (z.string().optional()) sin `superRefine`
  hard-fail en producción. La decisión de si el ledger está "activo" la toma el módulo
  ledger en runtime, no el parser de env. Esto permite deploys sin Supabase configurado
  (degraded mode).

- **CD-5**: PROHIBIDO hacer `console.log` en ningún módulo nuevo. Todos los logs DEBEN
  usar el logger de Pino pasado como argumento (mismo patrón que redis.ts).

- **CD-6**: OBLIGATORIO que la migration SQL esté en
  `supabase/migrations/0001_facilitator_settlements.sql` (o el número siguiente si el
  directorio ya tiene migrations). Si se usa Supabase CLI, seguir la convención
  `<timestamp>_<slug>.sql`. [NEEDS CLARIFICATION — F2]: Architect confirma naming
  convention de migrations para este proyecto (no hay precedente en el repo aún).

- **CD-7**: PROHIBIDO que la tabla `facilitator_settlements` almacene el campo `client_ip`
  o cualquier identificador de usuario no-blockchain. Esos campos pertenecen a
  `facilitator_audit_log` (WFAC-33).

- **CD-8**: OBLIGATORIO implementar `resetSupabaseClientForTests()` en
  `src/infra/supabase.ts` (análogo a `resetRedisClientForTests` en redis.ts) para
  permitir aislamiento de tests con `beforeEach`.

---

## Waves sugeridas (para F2.5 Story File)

| Wave | Contenido | Verificable |
|------|-----------|-------------|
| W0 | Migration SQL + instalar `@supabase/supabase-js` | `npm install` exitoso; SQL parseable |
| W1 | `src/infra/supabase.ts` singleton + `src/infra/env.ts` SUPABASE_* vars | `npm run typecheck` pasa; unit tests supabase.test.ts |
| W2 | `src/core/ledger.ts` — `LedgerEntry` type + `persistLedgerEntry` | unit tests ledger.test.ts (mock cliente) |
| W3 | Hook en `src/routes/settle.ts` — llamar `persistLedgerEntry` post-adapter pre-reply | Test de integración: settle exitoso → assert ledger.test mock invocado |
| W4 | `src/app.ts` — `initSupabase()` en buildApp; onClose hook para cleanup si aplica | `npm run qa` pasa; test de buildApp con Supabase deshabilitado |

---

## Missing Inputs

| Item | Estado | Notas |
|------|--------|-------|
| ¿Persistir también resultados 5xx del adapter (TRANSACTION_FAILED)? | [NEEDS CLARIFICATION] | La HU input incluye `status IN ('success', 'failed')` — "failed" aparenta cubrir errores x402. Los errores 5xx (adapter throws) también deben logearse para debugging. Recomendación: sí, persistir todos los resultados incluyendo el catch del adapter throw en la ruta. |
| ¿UPSERT o INSERT + catch de conflicto explícito? | [NEEDS CLARIFICATION — F2] | Ver DT-2. |
| ¿Versión de `@supabase/supabase-js`? | [NEEDS CLARIFICATION — F2] | Ver DT-7. |
| ¿Convention de naming para migration files? | [NEEDS CLARIFICATION — F2] | Ver CD-6. |
| ¿`persistLedgerEntry` en `src/core/ledger.ts` o inline en la route? | [NEEDS CLARIFICATION — F2] | Recomendación: `src/core/ledger.ts` (testable, reutilizable). Ver AC-11 rationale. |
| ¿Supabase URL validation en EnvSchema debe ser z.string().url() o z.string().min(1)? | [RESUELTO en F1] | Usar `z.string().url().optional()` para forzar formato válido en startup. Más seguro que `min(1)`. |

---

## Análisis de paralelismo

- Esta HU no bloquea ninguna otra HU activa conocida.
- WFAC-33 (audit log inmutable) DEPENDE del patrón establecido por esta HU (supabase.ts singleton).
  WFAC-33 puede comenzar después de que WFAC-32 esté en DONE.
- No hay conflicto de merge con WKH-012 (OpenAPI spec — en progress): los archivos tocados son
  diferentes (`src/infra/`, `src/core/ledger.ts`, `src/routes/settle.ts`, `supabase/`).
  Posible conflicto menor en `src/routes/settle.ts` si WKH-012 también toca ese archivo
  — verificar al abrir el PR.
- WKH-012 está marcado "in progress" en el INDEX — coordinar merge order.
