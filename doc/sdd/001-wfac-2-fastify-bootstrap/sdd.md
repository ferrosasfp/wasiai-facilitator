# SDD #001 — WFAC-2 Fastify Bootstrap + /health + Pino

> SPEC_APPROVED: no
> Fecha: 2026-04-22
> Tipo: feature (fundacional)
> SDD_MODE: full
> Clasificación: QUALITY
> Branch: `feat/001-wfac-2-fastify-bootstrap` (desde `main@7197cdf`)
> Artefactos: `doc/sdd/001-wfac-2-fastify-bootstrap/`
> Jira: https://ferrosasfp.atlassian.net/browse/WFAC-2
> HU_APPROVED: sí (work-item.md revisado clínicamente)

---

## 1. Overview

Implementar el servidor Fastify v5 como entry point productivo de wasiai-facilitator,
reemplazando el placeholder de `src/index.ts`. Esta HU establece la arquitectura base
sobre la que todas las HUs E2–E8 van a construir: factory `buildApp()` testable,
structured logging JSON con Pino (pretty en dev, JSON puro en prod/test), endpoint
`/health` spec-compliant con exención de rate-limit (CD-9), validación Zod de env
vars con fail-fast en stderr (CD-8), graceful shutdown con timeout y forced exit
por `SHUTDOWN_GRACE_MS`.

**Resultado esperado**: `npm run dev` arranca el server en puerto 3002 con logs
pretty, `curl localhost:3002/health` devuelve JSON válido en <50ms, `SIGTERM` hace
drain de in-flight y exit(0), `npm run qa` verde.

---

## 2. Architecture

### Diagrama de componentes (esta HU)

```
┌──────────────────────────────────────────────────────┐
│  src/index.ts           (entry point — calls listen) │
│      │                                                │
│      ▼                                                │
│  src/app.ts             (buildApp factory — testable)│
│      │                                                │
│      ├──► src/infra/env.ts     (Zod schema + parse)   │
│      ├──► src/infra/logger.ts  (Pino instance setup)  │
│      └──► src/routes/health.ts (GET /health handler)  │
└──────────────────────────────────────────────────────┘
```

### Flujo de arranque

1. `node dist/index.js` (o `tsx src/index.ts` en dev) ejecuta el top-level
   await de `src/index.ts`.
2. `index.ts` llama a `buildApp()` → app factory en `src/app.ts`.
3. `buildApp()` hace:
   1. `const env = parseEnv(process.env)` — si falla, `process.exit(1)` con
      mensaje en stderr (CD-8).
   2. Crea la instancia Pino vía `createLogger(env)` (dev=pretty, test/prod=JSON).
   3. Crea Fastify pasando `{ loggerInstance }` (logger externo preconstruido;
      Fastify v5 soporta `loggerInstance` como alternativa a `logger: opts`).
   4. `await fastify.register(healthRoute)` (CD-7 — todos los `register` awaited).
   5. Retorna la instancia **sin** llamar `listen()` (CD-3, AC-13).
4. `index.ts` recibe la instance y hace `await app.listen({ port, host: '0.0.0.0' })`
   (AC-3).
5. `index.ts` registra `SIGTERM`/`SIGINT` → llama `gracefulShutdown()`:
   - Arranca `setTimeout(force_exit, SHUTDOWN_GRACE_MS)` (AC-12).
   - Llama `await fastify.close()` (AC-11).
   - Si `close` resuelve antes del timer → `clearTimeout` + `process.exit(0)`.
   - Si el timer dispara antes → log error + `process.exit(1)` (AC-12).

### Flujo de test (`inject()`)

1. Test importa `buildApp` desde `src/app.ts`.
2. `const app = await buildApp()` — SIN listen().
3. `const res = await app.inject({ method: 'GET', url: '/health' })`.
4. Assert shape + statusCode.
5. `await app.close()` en `afterEach` para evitar leaks.

---

## 3. Codebase Grounding (archivos leídos + evidencia)

### Archivos leídos en este proyecto (wasiai-facilitator)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `CLAUDE.md` | Guía de orquestación | QUALITY mode, gates HU_APPROVED/SPEC_APPROVED |
| `.nexus/project-context.md` | Stack + reglas | Fastify v5, Pino, viem, Zod. Puerto 3002. Service layer discriminated union |
| `OWNERS.md` | Module boundaries | `routes/` → `infra/` + `core/` OK; health route solo lee infra (CD-6) |
| `package.json` | Deps disponibles | fastify 5.8.5, pino 9.14.0, zod 3.25.76. `pino-pretty` y `pino-http` ausentes |
| `tsconfig.json` | TS config | Node16 ESM, `strict`, `noUncheckedIndexedAccess`, `rootDir: ./src`, `resolveJsonModule: true` |
| `vitest.config.ts` | Test config | include `src/**/*.test.ts`, env `NODE_ENV=test` + `LOG_LEVEL=silent`, coverage thresholds 80/80/75/80 |
| `src/index.ts` | Placeholder actual | Tiene `console.warn` que hay que remover (AC-10). Exporta `VERSION = '0.1.0'` — lo removemos porque version se lee de package.json |
| `doc/sdd/_INDEX.md` | SDD registry | Entrada 001 presente con status "in progress"; hay que cerrarla a DONE al final del pipeline |

### Exemplar cross-project (lectura únicamente — CD-5: no importar)

| Archivo | Qué se extrajo | Qué NO copiar |
|---------|----------------|----------------|
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts` | Pattern graceful shutdown (SIGTERM handler, `setTimeout` + `forceTimer.unref()`, `fastify.close()`, exit codes), `/health` shape (status/version/uptime/timestamp) | Puerto 3001 (nosotros 3002). `logger: true` en a2a — nosotros pasamos `loggerInstance` explícito. `console.log` del banner — PROHIBIDO en facilitator (CD-1). Todo lo de CORS/rate-limit/chains (Scope OUT) |

### Lectura obligatoria en `node_modules/` (post-cutoff)

| Archivo | Línea / evidencia | Qué confirma |
|---------|-------------------|--------------|
| `node_modules/fastify/package.json` | `"version": "5.8.5"` | Fastify v5 confirmado |
| `node_modules/fastify/fastify.d.ts:128` | `logger?: boolean \| FastifyLoggerOptions<RawServer> & PinoLoggerOptions` | Option `logger` acepta PinoLoggerOptions (config) |
| `node_modules/fastify/fastify.d.ts:129` | `loggerInstance?: Logger` | Option `loggerInstance` acepta una instance pre-construida — **esta es la que usamos** para controlar transport dev vs prod desde fuera de Fastify |
| `node_modules/fastify/types/logger.d.ts:53-83` | Default `req` serializer emite `method`, `url`, `host`, `remoteAddress` | AC-9 cubierto sin `pino-http` |
| `node_modules/fastify/lib/route.js:524` | `childLogger.info({ req: request }, 'incoming request')` | Fastify v5 emite `incoming request` automáticamente |
| `node_modules/fastify/lib/reply.js:949-952` | `reply.log.info({ res: reply, responseTime }, 'request completed')` | Fastify v5 emite `request completed` con `res.statusCode` y `responseTime` |
| `node_modules/fastify/lib/logger-pino.js:46-54` | `serializers.req = asReqValue` con `method`, `url` | Confirma que req logs contienen method + url (AC-9) |
| `node_modules/fastify/types/instance.d.ts:166-168` | `inject(opts): Promise<LightMyRequestResponse>` | API de test confirmada (AC-14) |
| `node_modules/fastify/types/instance.d.ts:170-172` | `listen(opts?: FastifyListenOptions): Promise<string>` con `host` default `'localhost'` | Debemos pasar `host: '0.0.0.0'` explícito (AC-3) |
| `node_modules/fastify/types/instance.d.ts:143` | `close(): Promise<undefined>` | API de close confirmada para graceful shutdown |
| `node_modules/pino/package.json` | `"version": "9.14.0"` + `"pino-pretty": "^13.0.0"` en devDeps | Pino 9 compatible con pino-pretty 13 (usado en el propio repo de pino) |
| `node_modules/pino/pino.d.ts:354-395` | `LoggerOptions` con `transport?`, `level?` default `'info'` | API de Pino confirmada |
| `node_modules/pino/pino.d.ts:265-267` | `TransportSingleOptions { target: string; options? }` | Forma del `transport: { target: 'pino-pretty' }` (AC-7) |
| `node_modules/pino/docs/pretty.md` | `transport: { target: 'pino-pretty' }` | API de transport pretty confirmada |
| `node_modules/zod/index.d.ts:1-4` | `export default z` apunta a `./v3/external.js` | Zod `^3.23.8` sigue siendo v3 (no v4) |
| `node_modules/zod/v3/types.d.ts:65-68` | `safeParse` + `safeParseAsync` existen | Usaremos `safeParse` para fail-fast + mensaje formateado |

### Estado de BD relevante

N/A — WFAC-2 no toca BD (Scope OUT: Supabase client → WFAC-32).

### Componentes reutilizables encontrados

- No hay utilidades previas en `src/`; este es el primer commit funcional.
- El scaffold creó directorios vacíos (`src/infra/`, `src/routes/`, `src/__tests__/`, etc.)
  pero ningún archivo. WFAC-2 es el que **inaugura el árbol**.

---

## 4. Exemplar Verification (paths verificados)

| Exemplar | Ruta verificada | Existe | Uso en esta HU |
|----------|----------------|--------|----------------|
| a2a graceful shutdown | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts:152-171` | sí | Patrón para `gracefulShutdown(signal)` en nuestro `src/index.ts` (sin console.log) |
| a2a /health route | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts:86-97` | sí | Shape de response (status/version/uptime/timestamp) + `config: { rateLimit: false }` (CD-9) |
| Fastify v5 inject signature | `node_modules/fastify/types/instance.d.ts:167` | sí | Forma `app.inject({ method, url }): Promise<LightMyRequestResponse>` para tests |
| Fastify v5 loggerInstance option | `node_modules/fastify/fastify.d.ts:129` | sí | Pasamos la instance pino construida por `src/infra/logger.ts` |
| Fastify v5 req logging | `node_modules/fastify/lib/reply.js:949-952` | sí | AC-9 cubierto por default — NO instalar `pino-http` |
| Pino transport pretty | `node_modules/pino/docs/pretty.md` | sí | `transport: { target: 'pino-pretty' }` en dev (AC-7) |
| Zod safeParse | `node_modules/zod/v3/types.d.ts:65` | sí | `schema.safeParse(process.env)` con branching `success`/`error.issues` |

**Nota**: NO se copia código verbatim de wasiai-a2a (CD-5). Solo se extrae el patrón (estructura del handler) y se re-escribe adaptado a las reglas de facilitator (no console, puerto 3002, `LOG_LEVEL` respeto, `loggerInstance` explícito).

---

## 5. Decisiones Técnicas Finales (DT-N con resolución)

### DT-1 — Fastify v5 confirmado

**Status**: confirmado.
**Evidencia**: `node_modules/fastify/package.json` → `"version": "5.8.5"`.
**Regla**: todos los `fastify.register()` deben estar `await`-eados (CD-7).
**Firma del factory**: `import Fastify from 'fastify'; const app = Fastify(opts)`
(default export según `fastify.d.ts:208`).

### DT-2 — pino-pretty a instalar como devDependency

**Status**: resuelto.
**Decisión**: agregar `"pino-pretty": "^13.1.3"` a `devDependencies`.
**Evidencia**:
- `node_modules/pino/package.json` → `pino-pretty: "^13.0.0"` en devDeps
  del propio repo pino 9.14 → señal fuerte de compatibilidad.
- `npm view pino-pretty@13.1.3` existe y es la última estable.
- CD-10 obliga devDep (no dep) porque en prod no se usa.
**Script `dev`**: ya arranca con `tsx watch src/index.ts` (package.json:9). Funcionará
una vez agregado pino-pretty y `NODE_ENV=development`.

### DT-3 — pino-http NO se instala

**Status**: resuelto.
**Decisión**: **NO instalar `pino-http`**. Fastify v5 built-in logger cubre AC-9.
**Evidencia archivo:línea**:
- `node_modules/fastify/lib/route.js:524` — emite `{req}, 'incoming request'`.
- `node_modules/fastify/lib/reply.js:949-952` — emite `{res: reply, responseTime}, 'request completed'`.
- `node_modules/fastify/lib/logger-pino.js:46-54` — serializer default de `req` incluye `method` + `url`.
- Los logs incluyen `reqId` porque Fastify hace child logger con
  `context.requestIdLogLabel` key (`logger-factory.js:22-24`).
**Configuración**: pasar `loggerInstance: pinoInstance` + `disableRequestLogging: false`
(default). No requiere plugin extra.
**Trade-off aceptado**: si más adelante necesitamos custom req/res serializers (ej: WFAC-31
request-id middleware completo), se agregan vía `loggerInstance`'s options. `pino-http`
no aporta nada sobre Fastify built-in.

### DT-4 — App factory (`src/app.ts`) obligatoria

**Status**: confirmado.
**Decisión**: `buildApp(): Promise<FastifyInstance>` exportada como `async function`.
Firma:
```
export async function buildApp(
  overrides?: Partial<EnvConfig>
): Promise<FastifyInstance>
```
El parámetro `overrides` permite tests inyectar env sin tocar `process.env` global
(ventaja sobre wasiai-a2a que no tiene factory). Si `overrides` no se pasa, se parsea
`process.env`.
**Test contract**: cada call a `buildApp()` debe devolver una **nueva** instancia
Fastify (no singleton). Para evitar leaks, tests deben `await app.close()` en
`afterEach`.

### DT-5 — Env schema Zod

**Status**: resuelto.
**Shape final** (en `src/infra/env.ts`):
```
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),
});
export type EnvConfig = z.infer<typeof EnvSchema>;
```
`z.coerce.number()` convierte strings del env a number. `.default()` hace que vars
ausentes usen el default. **Nota sobre strict**: `strictNullChecks` + `noUncheckedIndexedAccess`
son compatibles con `z.infer` porque Zod produce tipos no-nullable post-defaults.
**API**:
```
export function parseEnv(raw: NodeJS.ProcessEnv): EnvConfig
// Internally: const r = EnvSchema.safeParse(raw);
// if (!r.success) { process.stderr.write(...formatIssues(r.error)...); process.exit(1); }
// return r.data;
```

### DT-6 — SHUTDOWN_GRACE_MS default 10000

**Status**: confirmado.
**Diferencia con a2a**: a2a usa 30000 (más conservador). facilitator usa 10000
porque en esta HU no hay colas/tx on-chain pendientes (Scope OUT). Cuando se agreguen
en HUs futuras, se re-evalúa.

### DT-7 — `"type": "module"` + imports con `.js` extension

**Status**: confirmado.
**Regla**: todos los imports entre archivos nuevos usan extensión `.js`:
```
import { buildApp } from './app.js';
import { parseEnv } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { healthRoute } from './routes/health.js';
```
**tsconfig evidence**: `"module": "Node16"` (tsconfig.json:3) + `"type": "module"`
en package.json:5.

### DT-8 — Version para /health se lee de package.json

**Status**: nuevo (añadido en F2).
**Problema**: `rootDir: ./src` (tsconfig.json:14) impide que `tsc` incluya
`package.json` en el output. No se puede hacer `import pkg from '../package.json'`
con `with { type: 'json' }` de forma portable entre Node 20 y Node 22.
**Decisión**: leer el archivo en runtime con `readFileSync` + `JSON.parse`, usando
`import.meta.url` + `fileURLToPath` para resolver ruta relativa robusta.
**Ubicación**: en `src/routes/health.ts` (una sola lectura, cacheada en module scope).
**Código conceptual** (para F3):
```
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
```
**Alternativa rechazada**: `createRequire(import.meta.url)('../../package.json')` funciona
pero inyecta CJS interop innecesario; `readFileSync` es más directo.

### DT-9 — Logger: `loggerInstance` (pre-built) en vez de `logger: opts`

**Status**: nuevo (añadido en F2).
**Decisión**: `src/infra/logger.ts` exporta `createLogger(env)` que retorna una
`pino.Logger` ya configurada. En `app.ts` se pasa como `loggerInstance`:
```
const logger = createLogger(env);
const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });
```
**Evidencia**: `fastify.d.ts:129` acepta `loggerInstance?: Logger`. Este approach:
1. Permite exportar el logger singleton para usarlo fuera de Fastify (p.ej. en
   `src/index.ts` para el log de "Server listening" si no lo delegamos a Fastify).
2. Desacopla la política de logging (pretty vs JSON) del bootstrap de Fastify.
3. Facilita tests que necesiten `LOG_LEVEL=silent` (vitest setup ya lo hace).
**Trade-off**: un poco más de código en `logger.ts` pero mayor testabilidad.
**"Server listening" log (AC-1)**: lo emite Fastify internamente cuando hace `listen`,
porque escucha el hook `onListen`. Alternativa: loggearlo manualmente post-`listen()`
con `logger.info({ port }, 'Server listening')` para tener control exacto del mensaje.
**Decisión**: log manual post-listen en `src/index.ts`, con shape exacto
`{"msg":"Server listening","port":3002}` para cumplir AC-1 literal.

### DT-10 — `/health` exemption de rate-limit via route config (anticipatorio)

**Status**: nuevo (añadido en F2).
**Contexto**: CD-9 exige que `/health` sea exempt de rate-limit. Pero WFAC-2 no
registra `@fastify/rate-limit` (Scope OUT). CD-9 impacta HUs futuras (WFAC-20+).
**Decisión**: el handler de `/health` declara `config: { rateLimit: false }` desde
ya, aunque el middleware no esté registrado. Cuando WFAC-20+ agreguen `@fastify/rate-limit`,
el handler ya tiene el opt-out en el mismo sitio — cero toque en esta HU. Fastify
ignora configs desconocidos sin error.
**Evidencia**: patrón idéntico en wasiai-a2a/src/index.ts:88 (`config: { rateLimit: false }`).

---

## 6. Constraint Directives

### Heredados del work-item (TODOS vigentes)

- **CD-1** — PROHIBIDO `console.log|warn|error|info|debug` en `src/`. Único logger permitido: instancia Pino desde `src/infra/logger.ts`. Excepción: `scripts/` puede usar console.
- **CD-2** — PROHIBIDO hardcodear `3002` en código ejecutable. Siempre vía `env.PORT`. El literal `3002` solo puede aparecer como default del Zod schema, `.env.example`, y comentarios.
- **CD-3** — OBLIGATORIO `src/app.ts` exporta `buildApp()` async; `src/index.ts` solo orquesta listen + SIGTERM. Separación inviolable.
- **CD-4** — TypeScript strict: sin `any` explícito, sin `as unknown` para camuflar tipos, sin `@ts-ignore`/`@ts-expect-error` en código nuevo.
- **CD-5** — PROHIBIDO importar desde `wasiai-a2a` / `wasiai-v2`. Standalone.
- **CD-6** — OWNERS.md compliance: `src/routes/health.ts` SOLO importa de `src/infra/*` (+ stdlib, + tipos Fastify). NO importa `core/`, `chains/`, `methods/`.
- **CD-7** — OBLIGATORIO `await` en cada `fastify.register()` (Fastify v5 requirement).
- **CD-8** — OBLIGATORIO fail-fast en stderr si Zod env parse falla. Antes de que Fastify escuche.
- **CD-9** — PROHIBIDO rate-limit en `/health`. El handler declara `config: { rateLimit: false }` desde WFAC-2.
- **CD-10** — `pino-pretty` DEBE ser devDependency, nunca dependency.

### Nuevos agregados en F2

- **CD-11** — OBLIGATORIO usar `loggerInstance: createLogger(env)` al instanciar Fastify (NO `logger: true` ni `logger: {...}`). Justificación: DT-9, desacople de política de logging.
- **CD-12** — OBLIGATORIO `disableRequestLogging` queda `false` (default). NO setearlo a `true`; eso romperia AC-9. Si algún archivo lo setea a `true`, es AR bloqueante.
- **CD-13** — PROHIBIDO instalar `pino-http` en esta HU. Si un futuro dev lo agrega "para seguridad", reject en AR. La razón (DT-3) queda documentada para no revisitarla.
- **CD-14** — OBLIGATORIO extension `.js` en imports relativos entre archivos TS propios (ESM + Node16). Ejemplo: `import { x } from './foo.js'` NUNCA `from './foo'` o `from './foo.ts'`.
- **CD-15** — OBLIGATORIO leer `version` de `package.json` vía `readFileSync` + `fileURLToPath` (DT-8). PROHIBIDO hardcodear `"0.1.0"` en el handler de /health. Si el version sube a `0.2.0`, el endpoint debe reflejarlo automáticamente sin tocar código.
- **CD-16** — OBLIGATORIO que tests hagan `await app.close()` en `afterEach` o `afterAll` para evitar instance leaks entre tests (contrato del buildApp factory, DT-4).
- **CD-17** — PROHIBIDO en `src/app.ts` llamar `app.listen()`. Listen es exclusivo de `src/index.ts`. AR bloqueante si se viola (testabilidad).
- **CD-18** — OBLIGATORIO log inicial de "Server listening" con **shape exacto** `{"msg":"Server listening","port":<N>}` para cumplir AC-1 literal. No emojis, no banner ASCII, no `console.log` (CD-1). Emitirlo con `logger.info({ port }, 'Server listening')` DESPUÉS de `app.listen()` resuelve.

### OBLIGATORIO seguir (resumen aplicado)

- **Stack**: Fastify v5, Pino v9, Zod v3 — lo que está en package.json, nada más.
- **Patrón service layer**: WFAC-2 no crea services reales, pero `src/infra/env.ts`
  retorna `EnvConfig` directamente (no discriminated union) porque el contrato de
  `parseEnv` es "parse o exit"; no hay error propagable al caller.
- **Module boundaries**: ver OWNERS.md. `src/routes/health.ts` importa de `src/infra/*`
  exclusivamente (más stdlib).
- **Naming**: `kebab-case.ts` para archivos, `camelCase` para funciones/vars,
  `PascalCase` para tipos.

### PROHIBIDO (resumen)

- NO console.* en src/ (CD-1).
- NO hardcodes de puerto o version (CD-2, CD-15).
- NO importar de otros proyectos (CD-5).
- NO pino-http (CD-13).
- NO listen en app.ts (CD-17).
- NO `as any`, `as unknown`, `@ts-ignore` (CD-4).
- NO omitir `.js` en imports (CD-14).
- NO registrar rutas sin `await` (CD-7).
- NO olvidar `afterEach app.close()` en tests (CD-16).

---

## 7. Waves de Implementación

Las waves son **serial gates** a nivel de dependencias (W0 debe terminar antes que W1),
pero dentro de cada wave los archivos pueden crearse en cualquier orden.

### Wave 0 — Setup prerequisite (Serial gate, antes de cualquier código)

**Dependencias**: ninguna (arranque).
**Objetivo**: setup del entorno. Sin esto, nada compila.

| # | Archivo / acción | Detalle | ACs cubiertos | CDs aplicables |
|---|-----------------|---------|---------------|-----------------|
| W0.1 | `package.json` | Agregar `"pino-pretty": "^13.1.3"` a `devDependencies` | habilita AC-7 | CD-10 |
| W0.2 | `npm install` | Ejecutar para traer pino-pretty | — | — |
| W0.3 | Branch | Verificar `feat/001-wfac-2-fastify-bootstrap` checkout desde `main@7197cdf` | — | — |

**Criterio de done W0**: `ls node_modules/pino-pretty/` existe; `git branch --show-current` devuelve el branch correcto.

### Wave 1 — Infraestructura (env + logger)

**Dependencias**: W0 done.
**Objetivo**: módulos base que el factory va a consumir.

| # | Archivo / acción | Detalle | ACs cubiertos | CDs aplicables |
|---|-----------------|---------|---------------|-----------------|
| W1.1 | `src/infra/env.ts` (CREATE) | Export `EnvSchema`, `EnvConfig` (type), `parseEnv(raw): EnvConfig`. Fail-fast a stderr + `process.exit(1)` si `safeParse` falla. | AC-2 | CD-4, CD-8, CD-14 |
| W1.2 | `src/infra/logger.ts` (CREATE) | Export `createLogger(env: EnvConfig): pino.Logger`. Si `env.NODE_ENV === 'development'`: `pino({ level, transport: { target: 'pino-pretty' } })`. Si `production` o `test`: `pino({ level })`. No default export. | AC-7, AC-8 | CD-1, CD-4, CD-11, CD-14 |

**Criterio de done W1**: `npx tsc --noEmit src/infra/env.ts src/infra/logger.ts` limpio. Los módulos no tienen efectos secundarios (no parsean env al cargar).

### Wave 2 — App factory + route /health

**Dependencias**: W1 done.
**Objetivo**: core del servidor, testeable.

| # | Archivo / acción | Detalle | ACs cubiertos | CDs aplicables |
|---|-----------------|---------|---------------|-----------------|
| W2.1 | `src/routes/health.ts` (CREATE) | Export `healthRoute: FastifyPluginAsync`. Registra `GET /health` con `config: { rateLimit: false }`. Lee `version` de `package.json` via `readFileSync` (module scope, una vez). Handler retorna `{ status: 'ok', version, uptime: process.uptime(), timestamp: new Date().toISOString() }`. | AC-4, AC-5, AC-6 | CD-1, CD-6, CD-9, CD-14, CD-15 |
| W2.2 | `src/app.ts` (CREATE) | Export `async function buildApp(overrides?: Partial<EnvConfig>): Promise<FastifyInstance>`. Flujo: parseEnv → createLogger → Fastify({ loggerInstance, disableRequestLogging: false }) → `await app.register(healthRoute)` → return app. NO llama listen. | AC-9, AC-13 | CD-3, CD-4, CD-7, CD-11, CD-12, CD-14, CD-17 |

**Criterio de done W2**: `npx tsc --noEmit` limpio en todo `src/`. No hay side effects en module-load.

### Wave 3 — Entry point + graceful shutdown

**Dependencias**: W2 done.
**Objetivo**: arranque productivo + shutdown limpio.

| # | Archivo / acción | Detalle | ACs cubiertos | CDs aplicables |
|---|-----------------|---------|---------------|-----------------|
| W3.1 | `src/index.ts` (REPLACE) | Borrar placeholder + `console.warn`. Top-level async: `const app = await buildApp(); const port = ...env.PORT; await app.listen({ port, host: '0.0.0.0' }); app.log.info({ port }, 'Server listening');`. Registrar `SIGTERM` + `SIGINT` → `gracefulShutdown()`. Función `gracefulShutdown(signal)`: setTimeout force-exit con `SHUTDOWN_GRACE_MS`, `await app.close()`, clearTimeout + `process.exit(0)`. En caso de timeout: log error + `process.exit(1)`. | AC-1, AC-3, AC-10, AC-11, AC-12 | CD-1, CD-2, CD-3, CD-4, CD-14, CD-17, CD-18 |

**Criterio de done W3**: `npm run build` limpio; `NODE_ENV=development npm run dev` arranca; `curl localhost:3002/health` responde 200; `kill -SIGTERM <pid>` cierra con exit 0.

### Wave 4 — Tests + QA

**Dependencias**: W3 done.
**Objetivo**: verificación automatizada + gate QA.

| # | Archivo / acción | Detalle | ACs cubiertos | CDs aplicables |
|---|-----------------|---------|---------------|-----------------|
| W4.1 | `src/__tests__/setup.ts` (CREATE o touch) | Vacío por ahora, o con un `afterEach` global de logs silencer si vitest no lo hace. `vitest.config.ts` ya setea `NODE_ENV=test` + `LOG_LEVEL=silent`. | — | — |
| W4.2 | `src/__tests__/unit/health.test.ts` (CREATE) | Describe `GET /health` — mínimo 8 tests cubriendo ACs 4, 5, 6, 13, 14, 15, 16 (ver Test Plan sección 8). Usa `buildApp` + `inject`. `afterEach` → `app.close()`. | AC-4, AC-5, AC-6, AC-13, AC-14 | CD-4, CD-14, CD-16 |
| W4.3 | `src/__tests__/unit/env.test.ts` (CREATE) | Tests del `parseEnv` (OK con defaults, falla en NODE_ENV inválido, falla en PORT fuera de rango, etc.). | AC-2, AC-15 | CD-4, CD-14 |
| W4.4 | `src/__tests__/unit/logger.test.ts` (CREATE) | Tests de `createLogger` (retorna pino instance; en 'development' usa transport pino-pretty; en 'test'/'production' no usa transport). Verificación por shape del logger options vía pino's `.level` + `.levels.values`. | AC-7, AC-8 | CD-4, CD-14 |
| W4.5 | `src/__tests__/unit/no-console.test.ts` (CREATE) | Test lint-like: leer todos los `src/**/*.ts` (excluyendo `__tests__/`), asertar que NO contienen `console.` fuera de strings/comments. Usa `readdirSync` + regex simple. Cubre AC-10. | AC-10 | CD-1, CD-4 |
| W4.6 | `src/__tests__/unit/shutdown.test.ts` (CREATE) | Tests del graceful shutdown. Refactor: extraer `gracefulShutdown` como función exportada desde `src/index.ts` O mover a `src/infra/shutdown.ts` (ver nota abajo). Tests mockean `fastify.close` (resolve rápido → exit 0; reject/timeout → exit 1). | AC-11, AC-12 | CD-4, CD-14 |
| W4.7 | `npm run qa` | Verde (typecheck + lint + format:check + test). `npm run build` limpio. | AC-15, AC-16 | — |

**Nota arquitectural sobre W4.6**: para testear shutdown sin ejecutar el top-level de `src/index.ts` (que llama `listen`), la función `gracefulShutdown` debe vivir en un archivo **importable sin side effects**. **Recomendación**: extraerla a `src/infra/shutdown.ts` exportando `createShutdownHandler(app: FastifyInstance, graceMs: number): (signal: string) => Promise<void>`. `src/index.ts` importa y registra. Esto mantiene CD-3 (index.ts solo orquesta) y habilita tests puros.

**Criterio de done W4**: `npm run qa` verde; coverage thresholds cumplidos (líneas 80 / branches 75); `npm run build` sin errores.

### Archivos totales

- **Nuevos**: 10 archivos
  - `src/infra/env.ts`
  - `src/infra/logger.ts`
  - `src/infra/shutdown.ts` (refactor nuevo por DT arquitectural de W4.6)
  - `src/app.ts`
  - `src/routes/health.ts`
  - `src/__tests__/setup.ts`
  - `src/__tests__/unit/health.test.ts`
  - `src/__tests__/unit/env.test.ts`
  - `src/__tests__/unit/logger.test.ts`
  - `src/__tests__/unit/no-console.test.ts`
  - `src/__tests__/unit/shutdown.test.ts`
  - *(11 si contamos `setup.ts` como nuevo — ajustar según si ya existe)*
- **Modificados**: 2 archivos
  - `src/index.ts` (REPLACE completo)
  - `package.json` (agregar pino-pretty a devDeps)

---

## 8. Test Plan (≥1 test por AC — 16 ACs)

**Framework**: vitest 2.1.8 (ya instalado).
**Patrón**: describe por AC o grupo relacionado; it por escenario específico.
**Setup global**: `vitest.config.ts` ya setea `NODE_ENV=test` + `LOG_LEVEL=silent`.

| # | AC | Test file + describe/it | Qué valida | Fixture/mock | Expected result |
|---|----|-----------------------|------------|---------------|-----------------|
| 1 | AC-1 | `env.test.ts` → `parseEnv` → `defaults to 3002 when PORT missing` | `parseEnv({})` retorna `port: 3002`. Verifica default sin tocar server. | `process.env` mock vacío `{}` | `result.PORT === 3002` |
| 2 | AC-1 | `env.test.ts` → `parseEnv` → `respects PORT env var` | `parseEnv({ PORT: '4001' })` retorna `port: 4001`. | `{ PORT: '4001' }` | `result.PORT === 4001` |
| 3 | AC-1 | `health.test.ts` → `buildApp` → `startup logs 'Server listening' shape` | Mock Pino instance, spy en `logger.info`, verify que después de `listen()` en un port libre se llama con `{ port }, 'Server listening'`. | Puerto 0 (kernel-assigned) para no colisionar | Spy called with `{port: any}, 'Server listening'` |
| 4 | AC-2 | `env.test.ts` → `parseEnv` → `exits on invalid NODE_ENV` | `parseEnv({ NODE_ENV: 'staging' })` invoca `process.exit(1)` + escribe stderr. | Spy `process.exit` + `process.stderr.write` | `exit` called with `1`, stderr contains 'NODE_ENV' |
| 5 | AC-2 | `env.test.ts` → `parseEnv` → `exits on PORT out of range` | `parseEnv({ PORT: '99999' })` exits. | spy exit | `exit` called with `1` |
| 6 | AC-3 | `health.test.ts` → `buildApp` → `listens on 0.0.0.0` | Integration-style: `buildApp()` + `listen({ port: 0, host: '0.0.0.0' })`. Verifica `app.addresses()[0].address === '0.0.0.0'`. | `{ PORT: '0' }` | address family ipv4 + `0.0.0.0` |
| 7 | AC-4 | `health.test.ts` → `GET /health` → `returns 200 with exact shape` | `app.inject({ method: 'GET', url: '/health' })`. Assert statusCode=200, content-type json, body has exactly keys `[status, version, uptime, timestamp]`. | buildApp with defaults | statusCode 200, body.status='ok', body.version matches `^\d+\.\d+\.\d+$`, uptime number, timestamp ISO |
| 8 | AC-4 | `health.test.ts` → `GET /health` → `version comes from package.json` | Assert `body.version === '0.1.0'` (o el valor actual en package.json leído por el test mismo). | buildApp | body.version matches package.json |
| 9 | AC-5 | `health.test.ts` → `GET /health` → `responds under 50ms` | Medir con `performance.now()` diff alrededor de `inject`. Assert < 50ms. | buildApp, warm (skip first call) | elapsed < 50 |
| 10 | AC-6 | `health.test.ts` → `GET /health` → `route has rateLimit=false config` | Inspeccionar la definición de ruta: `app.getRouteOptions?.('GET', '/health')?.config?.rateLimit === false`. Si Fastify no expone getRouteOptions, usar `onRoute` hook captura en test setup. | buildApp | config.rateLimit === false |
| 11 | AC-7 | `logger.test.ts` → `createLogger` → `dev uses pino-pretty transport` | `createLogger({ NODE_ENV: 'development', LOG_LEVEL: 'info', ... })`. Verify via wrapping: creamos un test spy sobre `pino()` OR verificamos que el logger tiene el thread-stream dest que pino-pretty usa. Alt: test de smoke via capturar stdout. | no mocks | transport target === 'pino-pretty' (o equivalente indirecto) |
| 12 | AC-8 | `logger.test.ts` → `createLogger` → `production returns JSON logger without transport` | `createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info', ... })`. Escribir a custom stream, asert output es JSON parseable. | custom destination stream | `JSON.parse(output)` ok |
| 13 | AC-8 | `logger.test.ts` → `createLogger` → `respects LOG_LEVEL env` | `createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'warn' })`. `logger.level === 'warn'`. | — | logger.level === 'warn' |
| 14 | AC-9 | `health.test.ts` → `GET /health` → `produces request log with method/url/statusCode/responseTime/reqId` | Capturar logs via custom stream passed to pino. Hacer `inject('/health')`. Parsear última línea JSON. Assert keys presentes: `req.method='GET'`, `req.url='/health'`, `res.statusCode=200`, `responseTime` number, `reqId` string. | buildApp con logger custom stream | parsed log has expected fields |
| 15 | AC-10 | `no-console.test.ts` → `source files have no console usage` | `readdirSync('src/', recursive) filter .ts exclude __tests__`, lee contenido, regex `/\bconsole\.(log|warn|error|info|debug)\b/` — debe devolver 0 matches. | fs | 0 matches in all files |
| 16 | AC-11 | `shutdown.test.ts` → `createShutdownHandler` → `closes app and exits 0 on fast drain` | Crear mock Fastify con `close: vi.fn(() => Promise.resolve())`. Spy `process.exit`. Llamar handler. Verify: `app.close` called once, `process.exit(0)` called. | mock app + spies | exit(0) |
| 17 | AC-12 | `shutdown.test.ts` → `createShutdownHandler` → `force exits 1 on timeout` | Mock `app.close` que nunca resuelve (`new Promise(() => {})`). `graceMs = 50`. Esperar 100ms. Verify: `logger.error` con msg `'Graceful shutdown timed out, forcing exit'`, `process.exit(1)` called. | mock + fake timers o real timer | exit(1), error logged |
| 18 | AC-13 | `health.test.ts` → `buildApp` → `does not call listen` | `const app = await buildApp(); expect(app.server.listening).toBe(false);` | — | server not listening |
| 19 | AC-14 | `health.test.ts` → `GET /health via inject` | (mismo que test #7 — ya cubre inject-based testing) | — | pasa |
| 20 | AC-15 | `qa.test.ts` o manual gate | `npm run typecheck` exit 0. No es vitest-testable; se valida en `npm run qa` de W4.7. | — | exit 0 |
| 21 | AC-16 | `qa.test.ts` o manual gate | `npm run build` exit 0. Validado en W4.7. | — | exit 0 |

**Total tests unitarios planificados**: ~18-20 (vitest-executable). ACs 15 y 16 se validan vía gate `npm run qa` manualmente al final de W4.

**Mocks/spies necesarios**:
- `process.exit`: `vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)`
- `process.stderr.write`: `vi.spyOn(process.stderr, 'write')`
- Pino custom destination stream para capturar output (pino API: `pino({ level }, destinationStream)`)
- Fastify mock en shutdown tests: `{ log: { info: vi.fn(), error: vi.fn() }, close: vi.fn() }`

**Fixtures**:
- `src/__tests__/fixtures/env.ts` (opcional): helpers para construir `EnvConfig` válidos en tests. No obligatorio; los tests pueden inlinear.

**Coverage esperado**:
- `src/infra/env.ts`: 100% líneas (happy + 2 error cases cubiertos).
- `src/infra/logger.ts`: 100% (ambas ramas dev/prod).
- `src/infra/shutdown.ts`: 100% (happy path + timeout).
- `src/app.ts`: 100% (hay 1 path — buildApp).
- `src/routes/health.ts`: 100%.
- `src/index.ts`: excluido de coverage (`vitest.config.ts:15`) — válido, porque ejecuta top-level side effects.

---

## 9. Readiness Check

Checklist que el Dev ejecuta **ANTES** de arrancar F3:

- [ ] **Prerequisitos operacionales**
  - [ ] `cd /home/ferdev/.openclaw/workspace/wasiai-facilitator && git status` limpio o solo con docs de SDD
  - [ ] `git rev-parse HEAD` igual a `7197cdf` (o branch ya checkouteado)
  - [ ] Branch `feat/001-wfac-2-fastify-bootstrap` creado desde `main` y checkouteado
  - [ ] `ls node_modules/fastify/` existe (sino correr `npm install`)
  - [ ] `ls node_modules/pino/` existe
  - [ ] `ls node_modules/zod/` existe
  - [ ] `ls node_modules/vitest/` existe
- [ ] **Setup W0**
  - [ ] `package.json` contiene `"pino-pretty": "^13.1.3"` en `devDependencies`
  - [ ] `ls node_modules/pino-pretty/` existe post `npm install`
  - [ ] `package-lock.json` regenerado sin errores
- [ ] **Decisiones técnicas resueltas**
  - [ ] DT-3 (pino-http): confirmado que NO se instala (CD-13)
  - [ ] DT-2 (pino-pretty version): `^13.1.3` aceptado
  - [ ] DT-8 (version read): `readFileSync` + `fileURLToPath` confirmado
  - [ ] DT-9 (loggerInstance): confirmado NO usar `logger: true`
- [ ] **SDD coherence**
  - [ ] Todos los 16 ACs mapeados al menos a un test en sección 8
  - [ ] Todos los 10 CDs heredados + 8 nuevos (18 total) están en sección 6
  - [ ] Sin `[NEEDS CLARIFICATION]` pendientes
  - [ ] Sin `[TBD]` pendientes
- [ ] **OWNERS.md**
  - [ ] `src/routes/health.ts` importa SOLO de `src/infra/*` + stdlib + Fastify types
  - [ ] `src/app.ts` importa SOLO de `src/infra/*`, `src/routes/*`, Fastify types
  - [ ] Ningún archivo nuevo importa de `src/core/`, `src/chains/`, `src/methods/`, `src/middleware/` (no existen aún)
- [ ] **Scope**
  - [ ] `npm install` de `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` NO se ejecuta en esta HU (ya están en deps, pero NO se registran)
  - [ ] `src/chains/`, `src/core/`, `src/methods/`, `src/middleware/` permanecen VACÍOS (ni un stub)

Si falla cualquier item: corregir ANTES de empezar W0.

---

## 10. Risks & Mitigations

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|------------|
| R1 | Fastify v5 API change post-cutoff rompe el factory (ej: `register` sin await genera plugin-timeout) | M | A | **Mit**: CD-7 + evidence en `fastify.d.ts:128-129` leída. Cualquier cambio en Dev que no haga `await fastify.register()` → AR bloqueante. |
| R2 | `pino-pretty` missing en dev startup (scaffold sin install) | B | M | **Mit**: W0.1 + W0.2 explícitos en Readiness Check. Test `logger.test.ts` en NODE_ENV=test evita el transport, así que CI no depende de pino-pretty en runtime de tests. |
| R3 | `buildApp()` no es idempotente — dos llamadas en un test leak estado | M | A | **Mit**: DT-4 contract (nueva instance per call). CD-16 obliga `app.close()` en `afterEach`. Documentado en F3 Story File como parte del patrón. |
| R4 | Graceful shutdown tests son flaky por timing real | M | M | **Mit**: usar `vi.useFakeTimers()` en `shutdown.test.ts` para controlar el timeout. Alternativa: graceMs chico (50ms) con tolerancia. Documentado en sección 8 test #17. |
| R5 | AC-5 (<50ms) flaky en CI con carga alta | B | B | **Mit**: skip first `inject` (warm-up) + budget 100ms en CI si se detecta flakiness en la 1era iteración. La primera medición puede incluir JIT warmup. |
| R6 | `rootDir: ./src` impide importar `package.json` (Node16 + ESM) | M | M | **Mit**: DT-8 resuelve vía `readFileSync` + `fileURLToPath`. Test #8 verifica que version se lee correctamente. |
| R7 | Dev accidentalmente deja `console.warn` del placeholder en src/index.ts al replace | B | A | **Mit**: CD-1 + AC-10 + test `no-console.test.ts` (W4.5). El test fallaría si queda algún console. |
| R8 | Test de AC-9 no puede observar el log estructurado directamente (Fastify pipea a stdout) | M | M | **Mit**: crear `createLogger` con un `destinationStream` custom inyectable (via argumento opcional). En tests, pasar un `Writable` que acumule chunks y parsee JSON. Documentado en test #14. |
| R9 | `loggerInstance` + ESM types conflict (Fastify expects `FastifyBaseLogger`, Pino returns `pino.Logger`) | B | M | **Mit**: `pino.Logger` extends `BaseLogger` (pino) que es compat con `FastifyBaseLogger` (Pick de BaseLogger). Evidencia: `node_modules/fastify/types/logger.d.ts:10-17`. Si hay TS complaint, usar `loggerInstance: pinoInstance as FastifyBaseLogger` con comment explicando compat (no es CD-4 violation porque no es `as any` ni camuflaje de tipo malo). |
| R10 | `no-console.test.ts` genera falsos positivos al ver `console` en strings/comentarios | B | B | **Mit**: el regex `/\bconsole\.\w+\(/` es estricto a llamadas. Como backup, excluir líneas dentro de `/*...*/` y `//` con una pre-pass simple. Si el test falla por FP, documentar excepción en el archivo (ej: `// eslint-disable-line`). |
| R11 | Puerto 3002 ocupado en CI / dev local | B | M | **Mit**: AC-3 no fuerza 3002; `PORT` es env-driven. Tests usan `port: 0` (OS-assigned). Dev local puede `PORT=3099 npm run dev`. |

---

## 11. Dependencias

### Precede (debe existir antes de WFAC-2)

- `package.json` válido con fastify/pino/zod ya listadas → CUMPLIDO.
- `tsconfig.json` strict → CUMPLIDO.
- `vitest.config.ts` con env `NODE_ENV=test` → CUMPLIDO.
- `OWNERS.md` + `.nexus/project-context.md` → CUMPLIDOS.

### Bloquea (otras HUs que esperan esto)

- WFAC-3 (chain registry) — necesita `src/app.ts` para registrar `/supported` route
- WFAC-4 (Redis client) — necesita logger
- WFAC-5 (GitHub Actions CI) — necesita `npm run qa` verde
- WFAC-20+ (routes x402) — necesitan la factory
- Todas las HUs E2–E8

---

## 12. Missing Inputs

| Item | Estado |
|------|--------|
| `pino-pretty` no está en package.json | **Resuelto**: W0.1 lo agrega como devDep `^13.1.3`. |
| `pino-http` no está en package.json | **Resuelto**: DT-3 decide NO instalar. CD-13 lo prohíbe. |
| Versión exacta Fastify v5 logger API | **Resuelto**: `fastify.d.ts:128-129` + lib/reply.js + lib/route.js leídos. |
| `npm install` no corrió | **Resuelto en F2**: Architect corrió `npm install` como parte del grounding (312 packages instalados). |
| Banner / startup message | **Resuelto por CD-18**: log JSON exacto `"Server listening"`, sin banner ASCII. |

**Bloqueantes restantes**: ninguno.

---

## 13. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? | Resolución |
|--------|---------|-------------|-------------|------------|
| (ninguno) | — | — | — | Todos los `[TBD]` del work-item resueltos en DT-1..DT-10. |

---

## 14. Notas arquitecturales para el futuro (no-bloqueantes)

- **F2 decisión de DT arquitectural nueva (W4.6)**: se agregó `src/infra/shutdown.ts` como refactor preventivo. Razón: testeo de shutdown requiere que la lógica sea importable sin side effects. Esto NO viola CD-3 (el `index.ts` sigue siendo solo "orquesta listen + registra handlers"), pero mueve `gracefulShutdown` a infra para testabilidad. Queda documentado.
- **TD-tentativo**: cuando WFAC-31 agregue request-id middleware propio, hay que revisar si `disableRequestLogging: false` sigue siendo lo correcto o si pasamos a un `onResponse` hook custom con más campos. Registrar en BACKLOG.md como TD candidate.

---

## 15. Implementation Readiness Check (Template NexusAgil)

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 7 (Waves)
[x] Cada archivo en tabla 7 tiene un Exemplar válido verificado en sección 4
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives incluyen 18 items (10 heredados + 8 nuevos)
[x] Context Map tiene 15+ archivos leídos (sección 3)
[x] Scope IN y OUT explícitos (heredados del work-item)
[x] Sin BD en esta HU (N/A)
[x] Happy Path completo (sección 2 flujo de arranque)
[x] Flujo de error definido (AC-2 fail-fast, AC-12 timeout shutdown)
[x] Tests mapeados a todos los ACs (sección 8)
[x] Waves ordenadas con dependencias claras (sección 7)
[x] Risks identificados con mitigación (sección 10, 11 items)
```

---

*SDD generado por nexus-architect (F2) — QUALITY mode — 2026-04-22*
