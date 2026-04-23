# Story File — WFAC-2 Fastify Bootstrap + /health + Pino

> **Este archivo es autocontenido.** No necesitás leer ni el work-item ni el SDD para
> implementar esta HU. Todo lo que el Dev necesita saber está acá.
>
> **Status**: SPEC_APPROVED — listo para F3.
> **Branch**: `feat/001-wfac-2-fastify-bootstrap` (desde `main@7197cdf`).
> **Fecha generación**: 2026-04-22.
> **Agente**: nexus-architect (F2.5).
> **Proyecto**: wasiai-facilitator (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`).
> **Jira**: https://ferrosasfp.atlassian.net/browse/WFAC-2.

---

## 0. Contract con el Dev

Este documento es un **contrato ejecutable** entre el Architect (autor) y el Dev (F3).
El Dev DEBE cumplir las siguientes reglas sin desviaciones:

1. **Un camino oficial único**. Todo lo que figura en secciones 3/4/5/7 es el camino
   correcto. Si encontrás una "mejor forma" que no está documentada acá, parar y
   consultar al humano — no implementar por libre.
2. **No hay código que adivinar**. Las firmas, shapes y decisiones arquitecturales
   están todas fijadas. El trabajo del Dev es escribir el **cuerpo** de las funciones
   que el Story File describe, no inventar la API.
3. **Waves secuenciales**. W0 → W1 → W2 → W3 → W4. No saltés waves. No empecés W2
   antes de terminar W1.
4. **18 CDs inviolables** (sección 9). Cada violación se marca BLOQUEANTE en AR.
5. **21 tests** (sección 8). La HU no está DONE hasta que todos pasan + coverage
   thresholds cumplidos.
6. **Sin console.log en src/**. Único logger: instancia Pino desde `src/infra/logger.ts`.
7. **Node_modules read-first para libs fast-moving**: el Dev DEBE leer
   `node_modules/fastify/`, `node_modules/pino/`, `node_modules/zod/` para verificar
   firmas ANTES de escribir código. Los paths específicos están en sección 10.

Si el Dev encuentra una ambigüedad que no está cubierta en este documento:
**NO IMPLEMENTAR** — parar y escalar al humano via el orquestador.

---

## 1. Resumen Ejecutivo (contexto minimo para el Dev)

**Qué se construye**: el entry point HTTP de wasiai-facilitator, un servicio x402 para
pagos gasless en EVM. Esta HU entrega:

- Fastify v5 server bindeado a `0.0.0.0:3002` (env-driven).
- Factory `buildApp(): Promise<FastifyInstance>` separada del entry (para tests).
- Logger Pino: `pino-pretty` en dev, JSON puro en prod/test.
- Endpoint `GET /health` con shape `{status, version, uptime, timestamp}`.
- Validación Zod de env vars con fail-fast en stderr.
- Graceful shutdown con timeout configurable (SIGTERM/SIGINT → `fastify.close()` →
  `process.exit(0)`; si pasa el timeout → `process.exit(1)`).
- 21 tests unitarios vitest + `npm run qa` verde + `npm run build` limpio.

**Por qué importa**: wasiai-facilitator mueve dinero on-chain. Sin logging estructurado
desde el día 1 + health check funcional + graceful shutdown robusto, no hay fundación
para ninguna HU futura (WFAC-3 a WFAC-30+). Todas las E2–E8 asumen este esqueleto.

**Qué NO hace esta HU**: NO registra `@fastify/cors`, `@fastify/helmet`, ni
`@fastify/rate-limit` (esas deps ya están en `package.json` pero se registrarán en
WFAC-20+). NO toca Redis, Supabase, viem, BullMQ. NO crea `src/core/`, `src/chains/`,
`src/methods/`. Esos directorios quedan vacíos.

---

## 2. Prerequisites (antes de empezar W0)

Ejecutar en orden, desde `/home/ferdev/.openclaw/workspace/wasiai-facilitator/`:

```bash
# 1. Verificar branch base
git status                        # debe estar clean o solo con docs de SDD
git rev-parse HEAD                # verificar commit actual

# 2. Crear/checkout branch de la HU
git checkout -b feat/001-wfac-2-fastify-bootstrap
# (si ya existe: git checkout feat/001-wfac-2-fastify-bootstrap)

# 3. Verificar deps instaladas
ls node_modules/fastify/          # existe
ls node_modules/pino/             # existe
ls node_modules/zod/              # existe
ls node_modules/vitest/           # existe
# Si falta algo: npm install

# 4. Verificar Node version
node --version                    # >= v20.0.0
```

**Si cualquiera de estos pasos falla**: parar y escalar al humano. NO proceder
a W0.

---

## 3. Stack confirmado (no inventar)

| Tecnología | Versión | Usar como |
|-----------|---------|-----------|
| Node.js | 20 LTS | runtime |
| TypeScript | 5.7.2 | `strict: true`, `module: Node16`, `rootDir: ./src` |
| Fastify | ^5.8.4 (5.8.5 instalado) | HTTP framework |
| Pino | ^9.5.0 (9.14.0 instalado) | logger estructurado |
| pino-pretty | ^13.1.3 (AGREGAR a devDeps en W0) | dev-only pretty logs |
| Zod | ^3.23.8 | validación env vars |
| vitest | ^2.1.8 | tests unitarios |

**PROHIBIDO**:
- ethers.js (usamos viem — pero esta HU no lo toca)
- pino-http (Fastify v5 built-in logger lo cubre, ver CD-13)
- console.log anywhere (CD-1)
- `any` explícito o `as unknown` camuflando tipos (CD-4)

---

## 4. Anti-Hallucination Rules (específicas de esta HU)

El Dev NO DEBE:

1. **Inventar helpers que no se piden.** Si el Story File no dice "creá `utils/X.ts`",
   no existe.
2. **Copiar código de wasiai-a2a** literal. Puede **leer** `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts`
   para extraer patrón, pero NO copiar líneas. CD-5.
3. **Usar `logger: true`** al instanciar Fastify. DEBE usar `loggerInstance: createLogger(env)`.
   CD-11. Ver `node_modules/fastify/fastify.d.ts:129`.
4. **Instalar `pino-http`**. Está PROHIBIDO (CD-13). Fastify v5 emite request logs por
   default; evidencia en `node_modules/fastify/lib/reply.js:949-952`.
5. **Hardcodear el puerto** `3002` en código ejecutable. CD-2. El literal `3002` solo
   puede aparecer como `default` del Zod schema y en comentarios.
6. **Hardcodear la versión** `"0.1.0"` en el handler de `/health`. CD-15. DEBE leerla de
   `package.json` vía `readFileSync` + `fileURLToPath(import.meta.url)` (ver sección 5).
7. **Omitir `.js`** en imports relativos. CD-14. ESM + Node16 lo exigen:
   `import { x } from './foo.js'` NUNCA `from './foo'` ni `from './foo.ts'`.
8. **Omitir `await`** en `fastify.register()`. CD-7. Fastify v5 requiere await.
9. **Llamar `app.listen()` en `src/app.ts`**. CD-17. El listen SOLO vive en
   `src/index.ts`.
10. **Setear `disableRequestLogging: true`** en Fastify opts. CD-12. Rompe AC-9.
11. **Importar desde `wasiai-a2a` o `wasiai-v2`**. CD-5. wasiai-facilitator es standalone.
12. **Crear archivos en `src/core/`, `src/chains/`, `src/methods/`, `src/middleware/`**.
    Esos directorios quedan VACÍOS en esta HU (Scope OUT).
13. **Omitir `app.close()` en tests**. CD-16. Cada `describe` debe tener `afterEach` que
    cierre la instance.
14. **Usar emojis en output** (logs, tests, comentarios) — no pidió el usuario.
15. **Generar archivos de documentación** `.md` no pedidos.

---

## 5. Archivos nuevos — Plantillas exactas

El Dev DEBE crear los siguientes archivos. **Los snippets son plantillas con shape
exacto — NO son código final**. El Dev completa el cuerpo respetando las firmas.

### 5.1 `src/infra/env.ts` (CREATE, W1)

**Propósito**: Zod schema + `parseEnv(raw)` con fail-fast.
**ACs cubiertos**: AC-2, AC-15.
**CDs aplicables**: CD-4, CD-8, CD-14.

Shape esperado (el Dev implementa el cuerpo):

```ts
import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Parse process.env (or any raw record) against EnvSchema.
 * On failure: writes human-readable error to stderr and calls process.exit(1).
 * On success: returns validated & typed EnvConfig.
 *
 * CD-8: fail-fast BEFORE Fastify listens. stderr, not logger (which may not exist yet).
 */
export function parseEnv(raw: NodeJS.ProcessEnv): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    // format z.ZodError issues into readable lines
    // write to process.stderr
    // process.exit(1)
    // NOTA: para tests, `process.exit` es spy-able vía vi.spyOn
  }
  return /* result.data */;
}
```

**Detalles obligatorios**:
- Export nombrado `parseEnv` (NO default export).
- Export nombrado `EnvSchema` para tests.
- Export nombrado `EnvConfig` (type).
- Fail-fast: `process.stderr.write(msg + '\n')` + `process.exit(1)`.
- Mensaje de error debe listar **cada** issue con su path, ej:
  `Env validation failed:\n  - NODE_ENV: Invalid enum value. Expected 'development' | 'test' | 'production'\n  - PORT: Number must be less than or equal to 65535\n`.

---

### 5.2 `src/infra/logger.ts` (CREATE, W1)

**Propósito**: factory que construye una instancia Pino configurada.
**ACs cubiertos**: AC-7, AC-8.
**CDs aplicables**: CD-1, CD-4, CD-11, CD-14.

Shape esperado:

```ts
import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import type { EnvConfig } from './env.js';

/**
 * Create a Pino logger configured from EnvConfig.
 * - development: uses pino-pretty transport (human-readable)
 * - test | production: JSON output, no transport
 *
 * Optional destination stream for tests (to capture output).
 * When destination is provided, transport is IGNORED (pino API requirement).
 *
 * CD-11: returned instance is what Fastify receives as `loggerInstance`.
 */
export function createLogger(
  env: EnvConfig,
  destination?: DestinationStream,
): Logger {
  const baseOptions: LoggerOptions = { level: env.LOG_LEVEL };

  if (destination) {
    return pino(baseOptions, destination);
  }

  if (env.NODE_ENV === 'development') {
    return pino({
      ...baseOptions,
      transport: { target: 'pino-pretty' },
    });
  }

  // test | production → JSON puro
  return pino(baseOptions);
}
```

**Detalles obligatorios**:
- Export nombrado `createLogger` (NO default export).
- El `destination` opcional es **clave** para test #14 (AC-9 capture de logs).
- NO agregar un `destination` default a `process.stdout` — Pino ya usa stdout por default
  cuando no se pasa nada.
- NO usar `pino.destination(...)` a menos que sea estrictamente necesario.
- `LOG_LEVEL=silent` es un valor válido de Pino (no loguea nada).

---

### 5.3 `src/infra/shutdown.ts` (CREATE, W2)

**Propósito**: graceful shutdown handler como función exportada importable sin
side-effects (necesaria para testear AC-11/AC-12 sin ejecutar top-level de `index.ts`).
**ACs cubiertos**: AC-11, AC-12.
**CDs aplicables**: CD-1, CD-4, CD-14.

**Nota arquitectural**: el SDD (DT de W4.6) movió el handler a `infra/shutdown.ts`
porque `src/index.ts` está excluido de coverage (vitest.config.ts:14) y no es
importable sin ejecutar `listen`. Mantener la lógica aislada en `infra/` permite
testearla directamente.

Shape esperado:

```ts
import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  app: FastifyInstance;
  graceMs: number;
  /** Allows tests to inject a mock exit. Default: process.exit. */
  exit?: (code: number) => never;
}

/**
 * Creates a handler function that, when invoked with a signal name (e.g. 'SIGTERM'),
 * initiates graceful shutdown:
 *   1. Start forceExitTimer = setTimeout(forceExit, graceMs). Call .unref() on it so
 *      it doesn't keep the event loop alive by itself.
 *   2. await app.close()
 *   3. clearTimeout(forceExitTimer)
 *   4. exit(0)
 *
 * If app.close() rejects: log the error via app.log and exit(1).
 * If graceMs elapses first: log error 'Graceful shutdown timed out, forcing exit'
 *                           and exit(1). (AC-12)
 *
 * The function is idempotent: a second invocation while a shutdown is in-flight
 * should be a no-op (log a 'shutdown already in progress' info and return).
 */
export function createShutdownHandler(
  opts: ShutdownOptions,
): (signal: string) => Promise<void> {
  // implementation
}
```

**Detalles obligatorios**:
- Export nombrado `createShutdownHandler` y `ShutdownOptions`.
- `exit` default: `process.exit` (sí, eso es el valor por defecto del parámetro). En
  tests se pasa un mock. NO llamar `process.exit` directo hardcoded.
- Mensaje de error en timeout: EXACTO `'Graceful shutdown timed out, forcing exit'`
  (AC-12 verifica este string literal).
- Loggear via `opts.app.log.error({ err }, 'msg')` — nunca `console.error`.
- `forceExitTimer.unref()` para que el timer NO bloquee el event loop si `app.close()`
  resolvió ya pero el timer todavía no fue cleared.
- Idempotencia: usá un flag `let shutdownInProgress = false;` en closure.

---

### 5.4 `src/routes/health.ts` (CREATE, W2)

**Propósito**: Fastify plugin que registra `GET /health`.
**ACs cubiertos**: AC-4, AC-5, AC-6.
**CDs aplicables**: CD-1, CD-6, CD-9, CD-14, CD-15.

Shape esperado:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

// Read version from package.json once at module load (cached).
// CD-15: NO hardcoding '0.1.0'.
// DT-8: rootDir excludes package.json from tsc output → readFileSync + fileURLToPath.
const pkgPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../package.json',
);
const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  timestamp: string;
}

/**
 * GET /health — returns liveness + basic metadata.
 *
 * CD-9: config.rateLimit = false so the rate-limit middleware (registered in
 * WFAC-20+) will exempt this route. Fastify ignores unknown config keys, so
 * setting this in WFAC-2 is safe even though no rate-limit plugin is registered yet.
 */
export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      // schema: optional — you MAY add a response schema via Zod or Fastify JSON Schema
      //         for stricter contract, but it is NOT required for this HU.
    },
    async (_request, _reply): Promise<HealthResponse> => {
      return {
        status: 'ok',
        version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    },
  );
};
```

**Detalles obligatorios**:
- Export nombrado `healthRoute` (NO default).
- `version` cacheada en module scope (una sola lectura).
- `config: { rateLimit: false }` literal.
- Handler retorna objeto literal — NO hace `reply.send(...)` (Fastify auto-serializa el
  return value como JSON con `Content-Type: application/json` por default).
- `process.uptime()` devuelve number en segundos (fractional).
- `new Date().toISOString()` emite ISO 8601 UTC con sufijo `Z`.

---

### 5.5 `src/app.ts` (CREATE, W2)

**Propósito**: factory `buildApp()` que arma la instancia Fastify completa SIN llamar
`listen()`.
**ACs cubiertos**: AC-9, AC-13.
**CDs aplicables**: CD-3, CD-4, CD-7, CD-11, CD-12, CD-14, CD-17.

Shape esperado:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { parseEnv, type EnvConfig } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { healthRoute } from './routes/health.js';

export interface BuildAppOptions {
  /** Override raw env (for tests). Default: process.env */
  env?: NodeJS.ProcessEnv;
  /** Pino destination stream for log capture (for tests). Default: undefined (stdout) */
  loggerDestination?: import('pino').DestinationStream;
}

/**
 * Factory for the Fastify instance. Does NOT call listen() (CD-17).
 * Tests use `app.inject(...)` for HTTP testing without binding a port.
 *
 * CD-3: inviolable separation — index.ts is the only file calling listen().
 * CD-11: logger is pre-built via createLogger(); Fastify receives loggerInstance.
 * CD-12: disableRequestLogging stays false (default) so AC-9 fires.
 * CD-7: every fastify.register(...) is awaited.
 */
export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const rawEnv = options.env ?? process.env;
  const env: EnvConfig = parseEnv(rawEnv);
  const logger = createLogger(env, options.loggerDestination);

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // trustProxy: false, // explicit default; may change in WFAC-31
  });

  await app.register(healthRoute);

  return app;
}
```

**Detalles obligatorios**:
- Export nombrado `buildApp` + `BuildAppOptions`.
- **`async function`** — `Promise<FastifyInstance>` return type.
- Cada `app.register(...)` awaited — CD-7 inviolable.
- `loggerInstance` (NO `logger: true`) — CD-11.
- NO llamar `app.listen(...)` — CD-17.
- NO retornar un singleton — cada call produce instance nueva.
- El parámetro `options.env` permite que los tests inyecten env sin tocar `process.env`
  global.

**Cuidado con tipos de Fastify**: `loggerInstance` espera un `FastifyBaseLogger`.
`pino.Logger` satisface ese shape estructuralmente. Si TS se queja, la evidencia está
en `node_modules/fastify/types/logger.d.ts:10-17` — el mismatch puede requerir
un cast controlado. **Solución preferida**: NO castear. Importar `Logger` directo de
`pino` ya debería ser asignable. Si persiste el problema, reportá a Architect antes
de castear (CD-4).

---

### 5.6 `src/index.ts` (REPLACE, W3)

**Propósito**: entry point real. Reemplaza el placeholder actual.
**ACs cubiertos**: AC-1, AC-3, AC-10, AC-11, AC-12.
**CDs aplicables**: CD-1, CD-2, CD-3, CD-4, CD-14, CD-17, CD-18.

Shape esperado (reemplaza COMPLETAMENTE el contenido actual):

```ts
/**
 * wasiai-facilitator — entry point.
 *
 * Orchestrates: buildApp → listen → register SIGTERM/SIGINT handlers.
 * NO business logic here (CD-3). NO console.* calls (CD-1, AC-10).
 */

import { buildApp } from './app.js';
import { parseEnv } from './infra/env.js';
import { createShutdownHandler } from './infra/shutdown.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const app = await buildApp({ env: process.env });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // CD-18: exact shape {"msg":"Server listening","port":<N>}.
  // app.log.info is Pino → emits structured JSON in prod, pretty in dev.
  app.log.info({ port: env.PORT }, 'Server listening');

  const shutdown = createShutdownHandler({
    app,
    graceMs: env.SHUTDOWN_GRACE_MS,
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

// Top-level await via IIFE to keep error-handling explicit.
main().catch((err: unknown) => {
  // Logger may not exist here if parseEnv failed; but parseEnv exits before this.
  // Errors reachable here: listen() EADDRINUSE, register() plugin timeout, etc.
  process.stderr.write(
    `Fatal error during bootstrap: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
```

**Detalles obligatorios**:
- BORRAR todo el contenido actual (incluyendo `export const VERSION` y el `console.warn`).
- NO `console.*` anywhere — CD-1.
- `host: '0.0.0.0'` LITERAL en `listen` — AC-3.
- Log post-listen con EXACTO `'Server listening'` como msg y `{ port }` como context —
  CD-18/AC-1.
- `SIGTERM` + `SIGINT` ambos registrados — AC-11.
- `main().catch(...)` al final para capturar errores pre-listen (ej: EADDRINUSE).
- `void shutdown(...)` porque los handlers de `process.on` son sync pero shutdown retorna
  Promise. `void` silencia el warn de "no-floating-promise" si ESLint lo reporta.

---

### 5.7 `src/__tests__/setup.ts` (CREATE, W4)

**Propósito**: setup global de vitest. Puede quedar casi vacío (vitest.config.ts ya setea
`NODE_ENV=test` y `LOG_LEVEL=silent`).

Shape esperado:

```ts
/**
 * Global vitest setup — runs before any test file.
 * Keep minimal; per-file setup should live in the test file.
 */

// Ensure LOG_LEVEL is silent (redundant with vitest.config.ts, defensive).
// No-op actually: vitest.config.ts:9 already does this.
export {};
```

**Nota**: si Vitest no tiene `setupFiles` configurado en `vitest.config.ts`, este archivo
es solo un marker para futuras HUs. NO hace falta registrarlo en la config ahora (Scope
OUT: modificar vitest.config.ts).

---

### 5.8 `src/__tests__/unit/env.test.ts` (CREATE, W4)

**Propósito**: tests de `parseEnv`. Ver sección 8, tests #1, #2, #4, #5.

### 5.9 `src/__tests__/unit/logger.test.ts` (CREATE, W4)

**Propósito**: tests de `createLogger`. Ver sección 8, tests #11, #12, #13.

### 5.10 `src/__tests__/unit/health.test.ts` (CREATE, W4)

**Propósito**: tests del endpoint `/health` + factory `buildApp`. Ver sección 8, tests
#3, #6, #7, #8, #9, #10, #14, #18, #19.

### 5.11 `src/__tests__/unit/shutdown.test.ts` (CREATE, W4)

**Propósito**: tests de `createShutdownHandler`. Ver sección 8, tests #16, #17.

### 5.12 `src/__tests__/unit/no-console.test.ts` (CREATE, W4)

**Propósito**: test lint-like de CD-1/AC-10. Ver sección 8, test #15.

---

## 6. Archivos modificados — Deltas exactos

### 6.1 `package.json` (MODIFY, W0)

**Cambio único**: agregar `"pino-pretty": "^13.1.3"` a `devDependencies`.

**Procedimiento recomendado**:

```bash
npm install --save-dev pino-pretty@^13.1.3
```

Esto actualiza `package.json` + `package-lock.json` + installs el paquete.

**Verificación**:
- `grep -A 20 "devDependencies" package.json | grep pino-pretty` debe mostrar la entrada
- `ls node_modules/pino-pretty/` debe existir

**PROHIBIDO**: agregar pino-pretty a `dependencies` (CD-10). Es dev-only.

### 6.2 `src/index.ts` (REPLACE, W3)

Ver sección 5.6. Reemplazo COMPLETO del contenido (borrar placeholder + `console.warn` +
`VERSION` export).

---

## 7. Waves — secuencia ejecutable

### Wave 0 — Setup

| Paso | Acción | Comando / Detalle |
|------|--------|---------|
| W0.1 | Branch | `git checkout -b feat/001-wfac-2-fastify-bootstrap` (si no existe) |
| W0.2 | Install pino-pretty | `npm install --save-dev pino-pretty@^13.1.3` |
| W0.3 | Verificación | `ls node_modules/pino-pretty/` existe; `grep pino-pretty package.json` OK |

**Gate W0 → W1**: pino-pretty instalado. Sin esto, W1 falla.

### Wave 1 — Infraestructura base

| Paso | Archivo | Acción |
|------|---------|--------|
| W1.1 | `src/infra/env.ts` | CREATE (sección 5.1) |
| W1.2 | `src/infra/logger.ts` | CREATE (sección 5.2) |

**Gate W1 → W2**: `npx tsc --noEmit` limpio. Los módulos NO tienen side-effects a
nivel de module-load (no parsean env, no crean logger en top-level).

### Wave 2 — App factory + route + shutdown

| Paso | Archivo | Acción |
|------|---------|--------|
| W2.1 | `src/infra/shutdown.ts` | CREATE (sección 5.3) |
| W2.2 | `src/routes/health.ts` | CREATE (sección 5.4) |
| W2.3 | `src/app.ts` | CREATE (sección 5.5) |

**Gate W2 → W3**: `npx tsc --noEmit` limpio en todo `src/`. `buildApp()` compila.

### Wave 3 — Entry point

| Paso | Archivo | Acción |
|------|---------|--------|
| W3.1 | `src/index.ts` | REPLACE (sección 5.6) |

**Gate W3 → W4**:
- `npm run build` limpio (tsc → dist/).
- Smoke manual: `NODE_ENV=development npm run dev` arranca; `curl -s localhost:3002/health`
  retorna JSON; `kill -SIGTERM <pid>` cierra con exit 0.

### Wave 4 — Tests + QA gate

| Paso | Archivo | Acción |
|------|---------|--------|
| W4.1 | `src/__tests__/setup.ts` | CREATE (sección 5.7) |
| W4.2 | `src/__tests__/unit/env.test.ts` | CREATE — tests #1, #2, #4, #5 |
| W4.3 | `src/__tests__/unit/logger.test.ts` | CREATE — tests #11, #12, #13 |
| W4.4 | `src/__tests__/unit/health.test.ts` | CREATE — tests #3, #6, #7, #8, #9, #10, #14, #18, #19 |
| W4.5 | `src/__tests__/unit/shutdown.test.ts` | CREATE — tests #16, #17 |
| W4.6 | `src/__tests__/unit/no-console.test.ts` | CREATE — test #15 |
| W4.7 | QA gate | `npm run qa` verde + `npm run build` limpio |

**Gate W4 → DONE**: sección 11 DoD completa.

---

## 8. Test Plan — 21 tests completos

**Framework**: vitest 2.1.8.
**Setup global**: `vitest.config.ts` ya setea `NODE_ENV=test` + `LOG_LEVEL=silent`.
**Pattern**: `describe(<AC-ID or fn name>, () => { it(<scenario>, () => {...}); })`.

### Formato de la tabla

| # | AC | File | Describe | It (título del test) | Setup / Mocks | Expected assertion |
|---|----|------|----------|----------------------|----------------|--------------------|
| 1 | AC-1 | `env.test.ts` | `parseEnv` | `defaults PORT to 3002 when PORT is missing` | Llamar `parseEnv({})` | `result.PORT === 3002` |
| 2 | AC-1 | `env.test.ts` | `parseEnv` | `respects PORT from env var` | Llamar `parseEnv({ PORT: '4001' })` | `result.PORT === 4001` |
| 3 | AC-1 | `health.test.ts` | `buildApp` | `emits "Server listening" with exact shape when index.ts logs startup` | Construir `buildApp({ loggerDestination: captureStream })`. NO llamar listen (eso es de index.ts). En lugar, testear el log manualmente: `app.log.info({ port: 3002 }, 'Server listening')`. Parsear chunks del stream. | Log JSON parseado contiene `msg: 'Server listening'` y `port: 3002` |
| 4 | AC-2 | `env.test.ts` | `parseEnv` | `exits with code 1 on invalid NODE_ENV` | Spy `process.exit`, `process.stderr.write`. Llamar `parseEnv({ NODE_ENV: 'staging' })` | `exit` called with 1; `stderr.write` called with string containing 'NODE_ENV' |
| 5 | AC-2 | `env.test.ts` | `parseEnv` | `exits with code 1 on PORT out of range` | Spy `process.exit`. `parseEnv({ PORT: '99999' })` | `exit` called with 1 |
| 6 | AC-3 | `health.test.ts` | `buildApp` | `listens on 0.0.0.0 when index.ts binds` | `buildApp()` → `app.listen({ port: 0, host: '0.0.0.0' })`. Tras listen resolver, leer `app.addresses()[0]`. Close en afterEach. | `addresses[0].address === '0.0.0.0'` |
| 7 | AC-4 | `health.test.ts` | `GET /health` | `returns 200 with exact shape {status, version, uptime, timestamp}` | `buildApp()` + `app.inject({ method: 'GET', url: '/health' })` | statusCode === 200; headers['content-type'] startsWith 'application/json'; body keys exactly `['status','version','uptime','timestamp']`; `body.status === 'ok'`; `body.version` matches `/^\d+\.\d+\.\d+/`; `typeof body.uptime === 'number'`; `body.timestamp` parses con `new Date(x).toISOString() === x` |
| 8 | AC-4 | `health.test.ts` | `GET /health` | `version matches package.json` | Test lee package.json con readFileSync (mismo pattern que el source) y compara. | `body.version === pkg.version` |
| 9 | AC-5 | `health.test.ts` | `GET /health` | `responds under 50ms (p99 localhost)` | `buildApp()`; skip primera inject (JIT warmup); medir `performance.now()` alrededor de 100 injects; computar p99 o simplemente `Math.max(...samples)` | elapsed < 50ms. En CI tolerar hasta 100ms si flakey (documentar en comment) |
| 10 | AC-6 | `health.test.ts` | `GET /health` | `route config has rateLimit: false` | Pattern: usar `app.addHook('onRoute', (route) => { if (route.url === '/health') capturedOpts = route.config; })` ANTES de `app.register(healthRoute)`. Como buildApp ya registra internamente, alternativa: construir Fastify manualmente en el test e invocar `healthRoute(app, {})` directamente, capturando onRoute. | `capturedOpts.rateLimit === false` |
| 11 | AC-7 | `logger.test.ts` | `createLogger` | `in development uses pino-pretty transport` | `createLogger({ NODE_ENV: 'development', LOG_LEVEL: 'info', PORT: 3002, SHUTDOWN_GRACE_MS: 10000 })`. Como pino no expone opciones directamente post-creation, validar indirectamente: verificar que `logger.level === 'info'` + que NO es el logger production (diff por shape). Alt más robusta: mock `pino` con `vi.mock('pino', ...)` y espiar las opts. | Mock `pino` factory; assert called with opts que incluyen `transport.target === 'pino-pretty'` |
| 12 | AC-8 | `logger.test.ts` | `createLogger` | `in production returns JSON logger without transport` | Similar a #11 con mock. `NODE_ENV: 'production'`. | Mock called without `transport` key |
| 13 | AC-8 | `logger.test.ts` | `createLogger` | `respects LOG_LEVEL env var` | `createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'warn', ... })` | `logger.level === 'warn'` |
| 14 | AC-9 | `health.test.ts` | `GET /health` | `produces request log with method, url, statusCode, responseTime, reqId` | `buildApp({ loggerDestination: captureStream })` donde captureStream acumula chunks. `app.inject({ method: 'GET', url: '/health' })`. Parsear líneas JSON. Buscar la línea con `msg === 'request completed'`. | Log contiene: `req.method === 'GET'`; `req.url === '/health'`; `res.statusCode === 200`; `typeof responseTime === 'number'`; `typeof reqId === 'string'` |
| 15 | AC-10 | `no-console.test.ts` | `source files` | `have no console.<log\|warn\|error\|info\|debug> usage` | `readdirSync('src/', { recursive: true, withFileTypes: true })`. Filtrar `.ts` files excluyendo `__tests__/`. Para cada archivo: `readFileSync(path, 'utf-8')`. Regex: `/\bconsole\.(log\|warn\|error\|info\|debug)\s*\(/`. Acumular violaciones. | `violations.length === 0` |
| 16 | AC-11 | `shutdown.test.ts` | `createShutdownHandler` | `closes app and exits 0 on fast drain` | Mock `app = { log: { info: vi.fn(), error: vi.fn() }, close: vi.fn().mockResolvedValue(undefined) }`. Mock `exit = vi.fn()`. `const handler = createShutdownHandler({ app, graceMs: 10000, exit })`. `await handler('SIGTERM')`. | `app.close` called once; `exit` called with `0`; NO call a `app.log.error` |
| 17 | AC-12 | `shutdown.test.ts` | `createShutdownHandler` | `logs timeout error and exits 1 when grace period elapses` | Mock `app.close = vi.fn(() => new Promise(() => {}))` (never resolves). Mock `exit = vi.fn()`. Mock `app.log.error`. Usar `vi.useFakeTimers()`. Llamar `handler('SIGTERM')` sin await (fire-and-forget). Avanzar timers: `await vi.advanceTimersByTimeAsync(50)` con `graceMs: 50`. | `app.log.error` called con mensaje `'Graceful shutdown timed out, forcing exit'`; `exit` called with `1` |
| 18 | AC-13 | `health.test.ts` | `buildApp` | `returns a Fastify instance without calling listen` | `const app = await buildApp()`. | `app.server.listening === false` |
| 19 | AC-14 | `health.test.ts` | `GET /health` | `can be tested via inject() without binding a real port` | `const app = await buildApp(); const res = await app.inject({ method: 'GET', url: '/health' }); expect(res.statusCode).toBe(200)` (combina con test #7). | statusCode 200; `app.server.listening === false` during the test |
| 20 | AC-15 | Manual/CI gate | — | `npm run typecheck exits 0` | Validado por `npm run qa` en W4.7. NO es un test vitest. | exit code 0 |
| 21 | AC-16 | Manual/CI gate | — | `npm run build exits 0` | Validado por `npm run qa` / manual en W4.7. NO es un test vitest. | exit code 0 |

**Resumen**: 19 tests vitest-ejecutables + 2 gates manuales (npm run typecheck/build
en W4.7).

### Mocks / helpers compartidos

El Dev puede crear (opcional, si simplifica) `src/__tests__/helpers/capture-stream.ts`
con un `Writable` stream que acumula chunks y expone `getLines(): unknown[]` para
parsear salida de Pino. Si lo hace, NO debe importarlo fuera de tests.

**PROHIBIDO**:
- `vi.mock('fs')` para el test de no-console: usar `readdirSync` real contra el árbol
  real de `src/`.
- Mocks globales que persistan entre archivos de test — usar `beforeEach`/`afterEach`.
- Real timers en test #17 — `vi.useFakeTimers()` obligatorio.

### `afterEach` obligatorio (CD-16)

En cada describe de `health.test.ts` donde se llama `buildApp()`:

```ts
let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
});
```

Evita leaks entre tests.

---

## 9. Constraint Directives — Lista completa (18)

### Heredados del work-item (10)

- **CD-1** — PROHIBIDO `console.log|warn|error|info|debug` en cualquier archivo bajo
  `src/`. Único logger permitido: instancia Pino exportada de `src/infra/logger.ts`.
  Excepción: `scripts/` (fuera de `src/`) puede usar console.
- **CD-2** — PROHIBIDO hardcodear `3002` en código ejecutable. Siempre vía `env.PORT`.
  El literal `3002` solo puede aparecer como default del Zod schema, `.env.example`, y
  comentarios.
- **CD-3** — OBLIGATORIO `src/app.ts` exporta `buildApp()` async; `src/index.ts` solo
  orquesta listen + SIGTERM. Separación inviolable.
- **CD-4** — TypeScript strict: sin `any` explícito, sin `as unknown` camuflando
  tipos, sin `@ts-ignore`/`@ts-expect-error` en código nuevo.
- **CD-5** — PROHIBIDO importar desde `wasiai-a2a` / `wasiai-v2`. wasiai-facilitator
  es standalone.
- **CD-6** — OWNERS.md compliance: `src/routes/health.ts` SOLO importa de
  `src/infra/*` + stdlib + tipos Fastify. NO `core/`, `chains/`, `methods/`.
- **CD-7** — OBLIGATORIO `await` en cada `fastify.register()` (Fastify v5 requirement).
- **CD-8** — OBLIGATORIO fail-fast en stderr si Zod env parse falla, antes de que
  Fastify escuche.
- **CD-9** — PROHIBIDO rate-limit en `/health`. El handler declara
  `config: { rateLimit: false }` desde WFAC-2 (anticipatorio).
- **CD-10** — `pino-pretty` DEBE ser devDependency, nunca dependency.

### Nuevos agregados en F2 (8)

- **CD-11** — OBLIGATORIO usar `loggerInstance: createLogger(env)` al instanciar
  Fastify (NO `logger: true` ni `logger: {...}`). Evidencia:
  `node_modules/fastify/fastify.d.ts:129`.
- **CD-12** — OBLIGATORIO `disableRequestLogging` queda `false` (default explícito OK).
  Romperlo viola AC-9. AR bloqueante si algún archivo lo setea a `true`.
- **CD-13** — PROHIBIDO instalar `pino-http` en esta HU. Fastify v5 built-in logger
  emite `incoming request` + `request completed` por default (evidencia:
  `node_modules/fastify/lib/route.js:524` y `node_modules/fastify/lib/reply.js:949-952`).
- **CD-14** — OBLIGATORIO extensión `.js` en todos los imports relativos entre archivos
  TS propios (ESM + Node16 module resolution).
- **CD-15** — OBLIGATORIO leer `version` de `package.json` vía `readFileSync` +
  `fileURLToPath(import.meta.url)`. PROHIBIDO hardcodear `"0.1.0"`.
- **CD-16** — OBLIGATORIO `await app.close()` en `afterEach` (o `afterAll`) de cada
  describe que construye una `FastifyInstance`. Contrato inviolable de buildApp factory.
- **CD-17** — PROHIBIDO llamar `app.listen()` dentro de `src/app.ts`. Listen es
  exclusivo de `src/index.ts`. AR bloqueante si se viola.
- **CD-18** — OBLIGATORIO log inicial con shape exacto
  `{"msg":"Server listening","port":<N>}` — emitido vía `app.log.info({ port }, 'Server listening')`
  DESPUÉS de que `app.listen(...)` resuelve. No emojis, no banner ASCII, no `console.log`.

---

## 10. Node_modules read-first — paths exactos para el Dev

El Dev DEBE leer estos archivos para confirmar firmas antes de codear. Son libs
fast-moving — la doc online puede estar desactualizada. Los paths son relativos al root
del proyecto (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`):

| Archivo | Qué confirmar |
|---------|---------------|
| `node_modules/fastify/package.json` | `"version": "5.8.5"` |
| `node_modules/fastify/fastify.d.ts:128-129` | `logger?` vs `loggerInstance?` options (CD-11) |
| `node_modules/fastify/types/instance.d.ts:143` | `close(): Promise<undefined>` |
| `node_modules/fastify/types/instance.d.ts:166-168` | `inject(opts): Promise<LightMyRequestResponse>` |
| `node_modules/fastify/types/instance.d.ts:170-172` | `listen(opts?: FastifyListenOptions): Promise<string>` — default host es `localhost`, NOS OBLIGA a pasar `host: '0.0.0.0'` explícito (AC-3) |
| `node_modules/fastify/lib/route.js:524` | request logging automático (AC-9 cubierto sin pino-http) |
| `node_modules/fastify/lib/reply.js:949-952` | response logging con `res.statusCode` + `responseTime` |
| `node_modules/pino/package.json` | `"version": "9.14.0"` |
| `node_modules/pino/pino.d.ts:354-395` | `LoggerOptions` + `transport?` + `level?` |
| `node_modules/pino/pino.d.ts:265-267` | `TransportSingleOptions { target: string; options? }` |
| `node_modules/zod/index.d.ts:1-4` | Zod default export apunta a v3 |
| `node_modules/zod/v3/types.d.ts:65-68` | `safeParse` + `safeParseAsync` signatures |

**Exemplar cross-project (solo lectura, NO copiar — CD-5)**:

| Archivo | Extraer patrón de | NO copiar |
|---------|-------------------|-----------|
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts:86-97` | Shape de `/health` response (status/version/uptime/timestamp) + `config: { rateLimit: false }` | literal code |
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/index.ts:152-171` | Estructura del graceful shutdown (SIGTERM handler + setTimeout force + fastify.close + exit codes) | literal code, `console.log` banner, puerto 3001, `logger: true` |

---

## 11. Definition of Done (DoD)

El Dev reporta F3 done SOLO cuando TODOS los items están marcados:

**Archivos creados/modificados** (11 nuevos + 2 modificados):
- [ ] `src/infra/env.ts` creado conforme a 5.1
- [ ] `src/infra/logger.ts` creado conforme a 5.2
- [ ] `src/infra/shutdown.ts` creado conforme a 5.3
- [ ] `src/routes/health.ts` creado conforme a 5.4
- [ ] `src/app.ts` creado conforme a 5.5
- [ ] `src/index.ts` REEMPLAZADO conforme a 5.6 (sin `console.warn`, sin `VERSION`)
- [ ] `src/__tests__/setup.ts` creado
- [ ] `src/__tests__/unit/env.test.ts` creado con tests #1, #2, #4, #5
- [ ] `src/__tests__/unit/logger.test.ts` creado con tests #11, #12, #13
- [ ] `src/__tests__/unit/health.test.ts` creado con tests #3, #6, #7, #8, #9, #10, #14, #18, #19
- [ ] `src/__tests__/unit/shutdown.test.ts` creado con tests #16, #17
- [ ] `src/__tests__/unit/no-console.test.ts` creado con test #15
- [ ] `package.json` con `pino-pretty` en devDependencies

**Gates de compilación y calidad**:
- [ ] `npm run typecheck` exit 0
- [ ] `npm run lint` exit 0 (0 warnings)
- [ ] `npm run format:check` exit 0
- [ ] `npm run build` exit 0 (`dist/` generado)
- [ ] `npm run test` todos los 19 tests vitest pasan
- [ ] `npm run test:coverage` thresholds cumplidos (lines 80 / functions 80 / branches 75 / statements 80)
- [ ] `npm run qa` verde (combo typecheck + lint + format:check + test)

**Smoke manual** (ejecutar y documentar OK en auto-blindaje.md si aplica):
- [ ] `NODE_ENV=development npm run dev` arranca sin errores
- [ ] `curl -s http://localhost:3002/health | jq` retorna JSON con keys correctas
- [ ] Medir latencia: `curl -o /dev/null -s -w "%{time_total}\n" http://localhost:3002/health` < 0.05s
- [ ] `kill -SIGTERM <pid_del_tsx>` cierra el proceso antes de 10s con exit 0
- [ ] En `NODE_ENV=production LOG_LEVEL=info npm start` (post-build) los logs son JSON
  (no ANSI colors)

**Compliance checks**:
- [ ] Grep `grep -rn 'console\.\(log\|warn\|error\|info\|debug\)' src/ --include='*.ts' | grep -v __tests__` devuelve vacío
- [ ] Grep `grep -rn '\blogger: true\b' src/` devuelve vacío (CD-11)
- [ ] Grep `grep -rn 'pino-http' package.json src/` devuelve vacío (CD-13)
- [ ] Grep `grep -rn 'from .*wasiai-' src/` devuelve vacío (CD-5)
- [ ] Grep `grep -rn '3002' src/ --include='*.ts' | grep -v test | grep -v env.ts` devuelve solo matches en comentarios (CD-2)
- [ ] Grep `grep -rn "'0.1.0'" src/` devuelve vacío (CD-15)
- [ ] Todos los imports relativos tienen `.js` extension — verificar con
  `grep -rnE "from '\\./" src/ --include='*.ts' | grep -v '\\.js'` → vacío (CD-14)
- [ ] Directorios `src/core/`, `src/chains/`, `src/methods/`, `src/middleware/` siguen
  vacíos (no hay archivos nuevos adentro)

**Reporting**:
- [ ] El Dev deja un resumen breve en el output de F3 listando: archivos tocados,
  tests que pasan, gates verdes, y cualquier desviación justificada (si existiera — no
  debería existir ninguna).

---

## 12. Riesgos conocidos + mitigaciones (para el Dev)

| # | Riesgo | Mitigación |
|---|--------|-----------|
| R1 | Fastify v5 API change post-cutoff | Leé `node_modules/fastify/fastify.d.ts:128-129` antes de codear app.ts. CD-7 siempre. |
| R2 | pino-pretty missing en dev | W0.2 instala. Verificación explícita en W0.3. |
| R3 | buildApp() test leaks entre tests | CD-16: `afterEach` con `app.close()` en cada describe. |
| R4 | Shutdown test flaky por timing real | Test #17 usa `vi.useFakeTimers()`. No real timers. |
| R5 | AC-5 (<50ms) flaky en CI | Test #9 skippea la primera medición (warmup). Si en CI falla persistente, subir budget a 100ms con comment explicando warmup. |
| R6 | rootDir impide `import pkg from '../package.json'` | CD-15: `readFileSync` + `fileURLToPath`. Test #8 verifica. |
| R7 | Placeholder `console.warn` queda por accidente | CD-1 + test #15 lo detectaría. Además el REPLACE total de index.ts lo borra. |
| R8 | Capturar logs estructurados en tests de AC-9 | `createLogger(env, destinationStream)` con overload. `buildApp({ loggerDestination })` lo propaga. Test #14 usa custom Writable. |
| R9 | TS complaint entre `pino.Logger` y `FastifyBaseLogger` | Evidencia: structurally compatibles. Si falla, NO castear a `as any` — escalar a Architect. |
| R10 | no-console.test.ts falso-positivo en strings/comentarios | Regex estricta a calls: `/\bconsole\.\w+\s*\(/`. Si aún así falsea, excluir vía pre-pass que remueve `//` lines y `/*...*/` blocks. |
| R11 | Puerto 3002 ocupado en CI/dev | Tests usan `port: 0` (kernel-assigned). Dev puede overridear con `PORT=3099 npm run dev`. |

---

## 13. Out of scope (recordatorio explícito)

La HU WFAC-2 NO toca:
- `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` registration (ya instaladas en
  `package.json`, se registran en WFAC-20+).
- `/verify`, `/settle`, `/supported`, `/metrics` routes (WFAC-20+).
- `src/chains/*`, `src/methods/*`, `src/core/*`, `src/middleware/*` (HUs posteriores).
- Redis client, Supabase client, viem wallet (WFAC-4, WFAC-32, WFAC-6).
- GitHub Actions CI (WFAC-5).
- OpenAPI spec (WFAC-23).
- `.env` con valores reales (responsabilidad del operador, fuera del código).

Si el Dev se ve tentado a "adelantar" algo de lo anterior: **PARAR**. Ese trabajo
corresponde a otra HU. Scope creep viola el contrato.

---

## 14. Conclusión — el Dev en F3 debe

1. Leer este Story File de punta a punta. Una sola vez.
2. Ejecutar Prerequisites (sección 2).
3. Leer node_modules paths críticos (sección 10).
4. Ejecutar W0 → W1 → W2 → W3 → W4 secuencialmente.
5. Validar cada Gate antes de avanzar.
6. Correr `npm run qa` al final.
7. Marcar cada checkbox del DoD (sección 11).
8. Reportar al orquestador: archivos tocados, tests que pasan, gates verdes.

El Dev NO debe: inventar, improvisar, "mejorar silenciosamente", cambiar shapes, saltar
waves, violar CDs. Cualquier duda → parar y escalar.

---

*Story File generado por nexus-architect (F2.5) — QUALITY mode — 2026-04-22*
*Artefactos padre: `work-item.md`, `sdd.md` (ambos en este directorio).*
