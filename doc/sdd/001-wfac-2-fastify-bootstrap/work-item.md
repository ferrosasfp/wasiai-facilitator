# Work Item — [WFAC-2] Fastify Bootstrap + /health Endpoint + Structured Logging (Pino)

## Metadata

| Campo | Valor |
|-------|-------|
| **HU-ID** | WFAC-2 |
| **NNN** | 001 |
| **Slug** | `fastify-bootstrap` |
| **Jira** | https://ferrosasfp.atlassian.net/browse/WFAC-2 |
| **Épica** | E1 — Core Infrastructure |
| **Fecha** | 2026-04-22 |
| **Branch sugerido** | `feat/001-wfac-2-fastify-bootstrap` |
| **Autor** | nexus-analyst (F0+F1) |

---

## Resumen

Implementar el servidor Fastify v5 como punto de entrada productivo de wasiai-facilitator,
reemplazando el placeholder `src/index.ts`. La HU entrega el servidor arrancando en el puerto 3002,
con structured logging JSON via Pino, el endpoint `/health` spec-compliant, y la base de los
scripts `dev`/`build`/`start`/`qa` funcionando. Es la fundación sobre la que todas las HUs de
E1–E8 van a construir — sin esta HU aprobada, ningún feature puede arrancar.

---

## Contexto de negocio

wasiai-facilitator mueve dinero. Un servidor bootstrap robusto, con graceful shutdown, logging
estructurado desde el arranque y health check funcional no es nice-to-have: es el mínimo viable
de cualquier servicio financiero productivo. Concretamente:

- El outage de Pieverse (2026-04-13) demostró que la observabilidad importa desde el día 1 —
  si el /health endpoint hubiera retornado `degraded` antes del crash, el sistema cliente
  (wasiai-a2a) podría haber fallado fast en lugar de colgar.
- Los jueces del hackathon Kite evaluarán que el servicio arranca, responde `/health`, y tiene
  logs que muestran qué está pasando.
- Todas las HUs E2–E8 asumen un servidor Fastify funcional con `app.ts` factory exportada.

---

## Sizing

| Campo | Valor |
|-------|-------|
| **SDD_MODE** | full |
| **Clasificación** | QUALITY |
| **Estimación** | M |
| **Justificación QUALITY** | HU fundacional de un servicio que mueve dinero. Establece patrones (app factory, env schema, logger setup) que todas las HUs futuras van a heredar. Un error de diseño aquí impacta todas las épicas E2–E8. AR obligatorio. |

---

## Acceptance Criteria (EARS)

### Servidor y arranque

**AC-1** — WHEN the server starts, it SHALL bind to the port resolved from `process.env.PORT`,
defaulting to `3002` if not set, and SHALL log `{"msg":"Server listening","port":3002}` as the
first structured JSON line to stdout.

**AC-2** — WHEN `NODE_ENV` is not one of `development | test | production` or when required env
vars fail Zod validation at startup, the process SHALL exit with code `1` and a human-readable
error message printed to stderr before Fastify listens.

**AC-3** — WHILE the server is running, it SHALL accept HTTP connections on `0.0.0.0` (all
interfaces), not only on `127.0.0.1`, so Railway/Docker can route traffic to it.

### /health endpoint

**AC-4** — WHEN `GET /health` is requested, the system SHALL return HTTP 200 with
`Content-Type: application/json` and a body matching exactly:
```json
{
  "status": "ok",
  "version": "<semver from package.json>",
  "uptime": <seconds as number>,
  "timestamp": "<ISO 8601 UTC string>"
}
```

**AC-5** — WHEN `GET /health` is requested, the system SHALL respond in under 50ms (p99 on
localhost, no I/O path).

**AC-6** — WHILE the server is running and rate-limit middleware is registered, the `/health`
endpoint SHALL be exempt from rate limiting (so monitoring tools do not exhaust quotas).

### Logging (Pino)

**AC-7** — WHILE `NODE_ENV=development`, the system SHALL initialize Pino with
`transport: { target: 'pino-pretty' }` so that logs are human-readable in terminal.

**AC-8** — WHILE `NODE_ENV=production` or `NODE_ENV=test`, the system SHALL initialize Pino with
JSON-only output (no `pino-pretty` transport) and respect the `LOG_LEVEL` env var, defaulting to
`info` if not set.

**AC-9** — WHILE the server is running, every incoming HTTP request SHALL produce a structured
log entry with at minimum: `method`, `url`, `statusCode`, `responseTime`, and `reqId` fields —
achieved via Fastify's built-in logger integration (passing the Pino instance to Fastify's
`logger` option or equivalent Fastify v5 logger configuration).

**AC-10** — the system SHALL NOT call `console.log`, `console.warn`, `console.error`, or
`console.debug` anywhere in `src/` — all output SHALL use the Pino logger instance. (The
existing scaffold placeholder `console.warn` in `src/index.ts` SHALL be removed.)

### Graceful shutdown

**AC-11** — WHEN the process receives `SIGTERM` or `SIGINT`, the system SHALL call
`fastify.close()`, wait for in-flight requests to drain, and then exit with code `0`. The grace
period SHALL be controlled by `process.env.SHUTDOWN_GRACE_MS`, defaulting to `10000` (10s) if
not set.

**AC-12** — IF graceful shutdown exceeds `SHUTDOWN_GRACE_MS`, the system SHALL log an error
`{"level":"error","msg":"Graceful shutdown timed out, forcing exit"}` and exit with code `1`.

### App factory and testability

**AC-13** — the system SHALL export a `buildApp()` async factory function from `src/app.ts`
that creates and configures the Fastify instance (with all middleware and routes registered)
without calling `fastify.listen()`, so that tests can import and start the server in-process
without binding a real port.

**AC-14** — WHEN `src/__tests__/unit/health.test.ts` is run with `vitest run`, the test SHALL
pass: it imports `buildApp()`, injects `GET /health`, and asserts HTTP 200 + body schema
matches AC-4. No real port binding. No external service dependency.

### TypeScript and build

**AC-15** — WHEN `npm run typecheck` is executed, the command SHALL exit with code `0` (no
TypeScript errors) on the files introduced by this HU.

**AC-16** — WHEN `npm run build` is executed, `tsc` SHALL compile all new `src/*.ts` files into
`dist/` without errors.

---

## Scope IN

| Archivo / Módulo | Acción | Notas |
|-----------------|--------|-------|
| `src/index.ts` | REPLACE | Borrar placeholder; implementar arranque real |
| `src/app.ts` | CREATE | App factory — `buildApp(): Promise<FastifyInstance>` |
| `src/infra/logger.ts` | CREATE | Setup Pino (dev pretty / prod JSON), export `logger` singleton |
| `src/infra/env.ts` | CREATE | Zod schema de env vars requeridas para esta HU (PORT, NODE_ENV, LOG_LEVEL) |
| `src/routes/health.ts` | CREATE | Route handler para `GET /health` |
| `src/__tests__/unit/health.test.ts` | CREATE | Test unitario del endpoint via inject() |
| `src/__tests__/setup.ts` | CREATE (o touch) | Vitest setup global si aún no existe |
| `package.json` | MODIFY | Agregar `pino-pretty` a devDependencies + `pino-http` si se usa |

---

## Scope OUT

| Item | Razón |
|------|-------|
| `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` registration | WFAC-20+ (rutas x402). No bloquean bootstrap básico. |
| `/verify`, `/settle`, `/supported`, `/metrics` routes | E2, E3, E4 HUs separadas |
| Chain registry (`src/chains/`) | WFAC-3 |
| Redis client (`src/infra/redis.ts`) | WFAC-4 |
| GitHub Actions CI | WFAC-5 |
| `src/core/types.ts` (discriminated union completo) | Se puede crear el stub mínimo, pero el tipo completo es de WFAC-10 |
| Supabase client | WFAC-32 |
| OpenAPI spec | WFAC-23 |
| Prometheus `/metrics` | WFAC-30 |
| Request-ID middleware completo | WFAC-31 (el placeholder puede existir como hook vacío) |
| `.env` llenado con valores reales | Responsabilidad del operador — fuera del código |

---

## Decisiones técnicas (DT-N)

**DT-1 — Fastify v5 confirmado.**
`package.json` tiene `"fastify": "^5.8.4"`. Fastify v5 cambió la API de registro de plugins:
`await fastify.register(plugin)` es el patrón correcto (v5 no permite `.register()` sin await
en contextos async top-level). El Architect DEBE leer `node_modules/fastify/` antes de codear
para verificar firmas de hooks y tipos de `FastifyInstance` post-cutoff.

**DT-2 — pino-pretty NO está en package.json.**
`pino` v9.5.0 está en `dependencies`. Sin embargo, `pino-pretty` no aparece ni en
`dependencies` ni en `devDependencies`. Para AC-7 (dev pretty logging) será necesario
instalarlo como devDependency. El Dev DEBE agregar `"pino-pretty": "^X.Y.Z"` a `devDependencies`
y correr `npm install` antes de implementar. Ver sección Missing Inputs.

**DT-3 — pino-http NO está en package.json.**
El project-context menciona `pino-http` para request logging correlacionado. Fastify v5 puede
usar su built-in logger (que es Pino) pasando la instancia directamente via `logger` option —
esto cubre AC-9 sin necesidad de `pino-http` como plugin separado. El Architect decide si
Fastify's built-in logger integration es suficiente para esta HU o si se necesita `pino-http`.
Dejar como `[TBD en F2]`. No bloquea el work-item.

**DT-4 — App factory (`src/app.ts`) es obligatoria para testabilidad.**
El proyecto usa `vitest` y el patrón de test via `inject()` (Fastify light HTTP injection)
que requiere una instancia sin `listen()`. El exemplar wasiai-a2a NO exporta factory (todo en
`src/index.ts`) — wasiai-facilitator DEBE mejorar esto desde WFAC-2 dado que el codebase es
nuevo y la separación `app.ts` vs `index.ts` cuesta cero en esta etapa.

**DT-5 — Env schema Zod en `src/infra/env.ts`.**
WFAC-2 solo necesita validar las vars de server (PORT, NODE_ENV, LOG_LEVEL). El schema debe
ser extensible (otros modules agregarán sus vars en sus HUs). El patrón recomendado es
`z.object({...}).parse(process.env)` al inicio de `buildApp()`, no en module-level (para que
los tests puedan inyectar env antes de importar). El Architect define el shape exacto en F2.

**DT-6 — Graceful shutdown grace period desde env.**
Patrón copiado del exemplar wasiai-a2a (`SHUTDOWN_GRACE_MS`). Valor default: `10000` ms (10s)
— suficiente para operaciones in-flight sin bloquear deploys de Railway. Diferencia con a2a:
`30000` ms default en a2a (era más conservador). Para facilitator, 10s es el correcto dado
que no hay colas largas en esta HU.

**DT-7 — `"type": "module"` en package.json.**
Todos los imports deben usar la extensión `.js` (no `.ts`) en los import paths cuando se
compila con `"module": "Node16"`. El Architect DEBE asegurar que todos los imports en los nuevos
archivos sigan este patrón: `import { logger } from './infra/logger.js'`.

---

## Constraint Directives (CD-N)

**CD-1** — PROHIBIDO usar `console.log`, `console.warn`, `console.error`, `console.info`,
`console.debug` en cualquier archivo bajo `src/`. Único logger permitido: instancia Pino
exportada de `src/infra/logger.ts`. (Excepción: el archivo `scripts/*.ts` puede usar console.)

**CD-2** — PROHIBIDO hardcodear el puerto (`3002`) en código. El puerto SIEMPRE viene de
`process.env.PORT ?? '3002'`. El valor `3002` puede aparecer SOLO en `.env.example`,
comentarios, y el default del Zod schema.

**CD-3** — OBLIGATORIO que `src/app.ts` exporte `buildApp()` como función async separada de
`src/index.ts`. `src/index.ts` solo importa `buildApp()`, llama `listen()`, y registra
los handlers de SIGTERM/SIGINT. Esta separación es inviolable para testabilidad.

**CD-4** — OBLIGATORIO TypeScript strict: sin `any` explícito, sin `as unknown` para camuflar
tipos, sin `@ts-ignore` ni `@ts-expect-error` en código nuevo. `noImplicitAny: true`,
`strictNullChecks: true`, `noUncheckedIndexedAccess: true` están activos en `tsconfig.json`.

**CD-5** — PROHIBIDO importar desde otros proyectos del ecosistema (`wasiai-a2a`, `wasiai-v2`).
wasiai-facilitator es standalone. Si se necesita algo compartido, se crea en este mismo repo.

**CD-6** — OWNERS.md compliance: `src/routes/health.ts` puede importar desde `src/infra/*`.
NO puede importar desde `src/core/*`, `src/chains/*`, ni `src/methods/*`. El health route es
puro — solo consulta `process.uptime()` y la versión del package.json.

**CD-7** — OBLIGATORIO `await` en todos los `fastify.register()` calls en Fastify v5. Sin
`await`, los plugins se registran en orden no determinista y los tests pueden ver estado
inconsistente. Verificar en node_modules antes de codear.

**CD-8** — OBLIGATORIO que el Env Zod schema valide y falle rápido al arranque si hay vars
inválidas, antes de que Fastify empiece a aceptar tráfico. El proceso DEBE exit(1) con mensaje
claro en stderr (no solo un log JSON que puede perderse en Railway startup).

**CD-9** — PROHIBIDO registrar `/health` con rate limiting. El rate-limit middleware que se
agregue en HUs futuras DEBE respetar la exclusión de este endpoint (patrón: `config: { rateLimit: false }` en Fastify, igual que en el exemplar wasiai-a2a).

**CD-10** — `pino-pretty` DEBE ser devDependency (no dependency). En producción (Railway),
`NODE_ENV=production` activa JSON puro — pino-pretty no se llama nunca. Incluirlo en
`dependencies` sería peso innecesario en el bundle de producción.

---

## Missing Inputs

| Item | Tipo | Estado |
|------|------|--------|
| `pino-pretty` no está en package.json | **Setup gap** — Dev debe instalar antes de implementar AC-7. Versión a instalar: `^11.x` (compatible con pino v9). | Resuelto en F2/F3: Dev agrega a devDeps y corre `npm install`. No bloqueante para el work-item. |
| `pino-http` no está en package.json | **Decisión arquitectural** — Fastify v5 puede ofrecer request logging via su built-in logger sin este plugin. El Architect define en F2 si se necesita o no para AC-9. | `[TBD en F2]` — No bloqueante. |
| Versión exacta del Fastify v5 API para logger config | **Riesgo post-cutoff** — Fastify v5 puede haber cambiado la firma del `logger` option. Dev DEBE leer `node_modules/fastify/` antes de codear. | Resuelto en F3 via regla `node_modules read-first`. |
| `npm install` no se ha corrido (no hay `node_modules/`) | **Prerequisito operacional** — el scaffold fue creado pero no instalado aún. | Resuelto por Dev antes de F3. No bloquea F1/F2. |

---

## Waves preliminares (el Architect refina en F2)

| Wave | Descripción | Archivos estimados |
|------|-------------|-------------------|
| **W0** | Infraestructura base: env schema Zod + logger Pino | `src/infra/env.ts`, `src/infra/logger.ts` |
| **W1** | App factory + /health route | `src/app.ts`, `src/routes/health.ts` |
| **W2** | Entry point real + graceful shutdown | `src/index.ts` (rewrite) |
| **W3** | Tests + typecheck + build validation | `src/__tests__/unit/health.test.ts`, `src/__tests__/setup.ts`, `npm run qa` green |

---

## Criterios de éxito no funcionales

- Startup time: proceso escucha en puerto < 500ms desde arranque (`tsx watch` o `node dist/`)
- `/health` latencia: < 50ms p99 en localhost (AC-5)
- `npm run qa` green: typecheck + lint + format:check + test (sin warnings)
- `npm run build` limpio: `tsc` sin errores en los archivos de esta HU
- `npm test` pasa: mínimo 1 test de `/health` (AC-14), coverage >= 80% líneas en archivos nuevos
- Zero `any` en archivos nuevos — verificado por `tsc --noEmit` + ESLint

---

## Patterns luma-ai considerados

| Pattern | Presente en este WI | Dónde |
|---------|--------------------|----|
| Service layer discriminated union `{ ok:true } | { ok:false, error }` | Scope OUT de esta HU — health route no necesita el pattern. Pero `src/infra/env.ts` podría retornar errores; se define el patrón en F2. | Referenciado en CD-8 (fail fast) |
| OWNERS.md module boundaries | Sí | CD-6: health route solo importa de infra/ |
| node_modules read-first para libs fast-moving | Sí | DT-1 (Fastify v5), DT-3 (pino-http), regla explicita en Missing Inputs |
| Port 3002 (no 3001, no 3000) | Sí | DT-2, CD-2, AC-1 |
| No console.log en src/ | Sí | CD-1, AC-10 |

---

## Análisis de paralelismo

- **Bloquea**: WFAC-3 (chain registry), WFAC-4 (Redis client), WFAC-5 (CI), y todas las HUs E2–E8. Sin `src/app.ts` factory, ninguna HU posterior puede construir su feature.
- **No hay WIP paralelo**: ninguna HU está en progreso actualmente (este es el primer work-item del proyecto). No hay riesgo de conflicto de branches.
- **No depende de externos**: WFAC-2 no necesita Redis, Supabase, ni RPC de Kite. Completamente auto-contenida.
- **Puede correr en paralelo con**: WFAC-1 (scaffold, ya marcado como meta/done). No hay colisión.
