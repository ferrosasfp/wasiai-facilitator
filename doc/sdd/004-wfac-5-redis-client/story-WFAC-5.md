# Story File — WFAC-5 Redis Client (Idempotency Cache Foundation)

> **Este archivo es autocontenido.** El Dev NO necesita leer work-item ni SDD para
> implementar esta HU. Todo lo que necesita está acá.
>
> **Status**: SPEC_APPROVED (pending humano — no arrancar F3 hasta que el humano escriba
> `SPEC_APPROVED`).
> **Branch**: `feat/004-wfac-5-redis-client` desde `main@f93a97b`.
> **Fecha generación**: 2026-04-22.
> **Agente**: nexus-architect (F2.5).
> **Proyecto**: wasiai-facilitator (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`).
> **Jira**: https://ferrosasfp.atlassian.net/browse/WFAC-5.
> **SDD**: `doc/sdd/004-wfac-5-redis-client/sdd.md` (referencia — NO obligatoria para el Dev).

---

## 0. Contract con el Dev

Este documento es un contrato ejecutable entre el Architect (autor) y el Dev (F3). Reglas
inviolables:

1. **Un camino oficial único**. Todo lo que aparece en §3/§4/§5/§7 es el camino correcto.
   Si creés que hay una "mejor forma" no documentada: parar y escalar al humano.
2. **No hay código que adivinar**. Firmas, shapes, decisiones, retry values — todos
   fijados. El Dev escribe el **cuerpo** de funciones cuyas interfaces están especificadas.
3. **Waves secuenciales**. W0 → W1 → W2 → W3. No salteés waves.
4. **12 CDs inviolables** (§9). Cada violación se marca BLOQUEANTE en AR/CR.
5. **14 ACs verificables** (§8). La HU no está DONE hasta que el test correspondiente a
   cada AC pasa + `npm run qa` verde + `npm run build` verde.
6. **Sin `console.*` en `src/`**. Único logger: Pino inyectado.
7. **Node_modules read-first**: ANTES de codear W1, leer `node_modules/ioredis/built/Redis.d.ts`
   + `node_modules/ioredis/built/redis/RedisOptions.d.ts` para verificar firmas. Paths en §10.
8. **Cero `any` / `as unknown as X`** en código productivo. El pattern `as unknown as ...`
   solo se permite en tests existentes donde ya está establecido (ver
   `src/__tests__/unit/shutdown.test.ts` como referencia).

Si encontrás ambigüedad no cubierta por este Story File: **NO IMPLEMENTAR**. Escalar.

---

## 1. Resumen Ejecutivo

**Qué se construye**: el **singleton ioredis** de wasiai-facilitator con su ciclo de vida
integrado al shutdown existente. Infraestructura pura — cero lógica de negocio.

Entregables:

- `src/infra/env.ts` con dos env vars nuevas: `REDIS_URL` (optional en test, required en
  dev/prod) y `REDIS_DB` (default 0).
- `src/infra/redis.ts` (nuevo): exporta `initRedis`, `getRedisClient`, `redactRedisUrl`,
  `resetRedisClientForTests`.
- `src/app.ts` modificado: llama `initRedis(env, logger)` y registra `onClose` hook que
  hace `redis.quit()`.
- `src/__tests__/unit/redis.test.ts` (nuevo): tests con `vi.mock('ioredis')`, sin live Redis.
- `.env.example` actualizado con `REDIS_DB`.
- `npm run qa` verde, `npm run build` verde.

**Por qué importa**: es la foundation de WFAC-21 (idempotency), WFAC-40 (distributed
rate-limit) y WFAC-42 (BullMQ queue). Ninguna de esas 3 HUs puede arrancar sin este
módulo. Un mal manejo del ciclo de vida de conexión = file descriptor leaks o shutdown
colgado — inaceptable en servicio financiero.

**Qué NO hace esta HU**:

- NO crea `src/core/idempotency.ts` (WFAC-21).
- NO registra `@fastify/rate-limit` (WFAC-40).
- NO setup BullMQ (WFAC-42).
- NO modifica `src/infra/shutdown.ts` (integración vía `onClose` hook, no vía shutdown
  handler).
- NO integration tests con Redis real (solo unit con mock).

---

## 2. Prerequisites (antes de W0)

Ejecutar en orden desde `/home/ferdev/.openclaw/workspace/wasiai-facilitator/`:

```bash
# 1. Verificar branch base
git status                        # debe estar clean
git rev-parse HEAD                # si no estás en main@f93a97b, volver: git checkout main && git pull

# 2. Crear/checkout branch de la HU
git checkout -b feat/004-wfac-5-redis-client
# (si ya existe: git checkout feat/004-wfac-5-redis-client && git rebase main)

# 3. Verificar deps instaladas
ls node_modules/ioredis/          # debe existir
cat node_modules/ioredis/package.json | grep '"version"'  # debe decir 5.4.1 o similar
ls node_modules/pino/             # debe existir

# 4. Verificar que los archivos a modificar compilan limpios en main
npm run typecheck                 # debe pasar
npm run test                      # debe pasar (tests existentes)
```

Si cualquiera de los pasos falla, **parar** y escalar al humano. No empezar W0 sobre un
baseline roto.

---

## 3. Archivos afectados (Scope IN)

| Archivo | Acción | Wave | Notas |
|---------|--------|------|-------|
| `src/infra/env.ts` | MODIFY | W0 | Agregar `REDIS_URL` + `REDIS_DB` + `superRefine` cross-field |
| `src/infra/redis.ts` | CREATE | W1 | Singleton + redaction + retry + event handlers |
| `src/app.ts` | MODIFY | W2 | Call `initRedis()` + registrar `onClose` hook |
| `src/__tests__/unit/env.test.ts` | MODIFY | W0 | Agregar 3 tests nuevos (AC-1/AC-2/AC-3) |
| `src/__tests__/unit/redis.test.ts` | CREATE | W3 | Tests con `vi.mock('ioredis')` |
| `.env.example` | MODIFY | W3 | Agregar `REDIS_DB=0` con comentario |

**Archivos PROHIBIDOS de modificar** (fuera de scope):

- `src/index.ts` — no requiere cambios.
- `src/infra/shutdown.ts` — la integración se hace via Fastify `onClose`, NO modificando shutdown.
- `src/infra/logger.ts` — no se toca.
- `src/core/*` — no existe todavía, no crear archivos ahí en esta HU.
- `package.json` — ioredis ya instalado; no agregar deps nuevas.
- `tsconfig.json` — no se toca.
- `vitest.config.ts` — no se toca.

---

## 4. Anti-Hallucination Checklist (específica de esta HU)

Antes de escribir CUALQUIER línea de código, confirmá lo siguiente:

- [ ] Leíste `node_modules/ioredis/built/Redis.d.ts` y confirmaste que existen:
  - Constructor `constructor(path: string, options: RedisOptions)` — para `new Redis(url, opts)`.
  - Método `quit(): Promise<'OK'>`.
  - Método `disconnect(reconnect?: boolean): void` — **NO uses esto en shutdown**.
  - Events `'connect'`, `'error'` (firma `on(event, cb)`).

- [ ] Leíste `node_modules/ioredis/built/redis/RedisOptions.d.ts` y confirmaste:
  - `retryStrategy?: (times: number) => number | void | null`.
  - `maxRetriesPerRequest?: number | null` (default 20).
  - `enableReadyCheck?: boolean` (default true).
  - `lazyConnect?: boolean` (default false).
  - `db?: number` (default 0).
  - `connectionName?: string`.

- [ ] Leíste `node_modules/ioredis/built/index.d.ts` y confirmaste:
  - `export default Redis` (default export).
  - `export { default as Redis } from './Redis'` (también named).
  - Tu import va a ser: `import Redis from 'ioredis'` (usamos el default).

- [ ] Leíste `src/infra/env.ts` (40 líneas) y entendés el pattern `z.object({...})` +
  `safeParse` + stderr + exit. Tu cambio DEBE seguir ese pattern: agregar campos al
  schema, no reestructurar.

- [ ] Leíste `src/app.ts` (52 líneas) y entendés la firma `buildApp(options)`. Tu cambio
  agrega una llamada a `initRedis()` **después** de crear el logger y **antes** del
  `register(healthRoute)`. El `app.addHook('onClose', ...)` va antes del `return app`.

- [ ] Leíste `src/__tests__/unit/logger.test.ts` (92 líneas) y entendés el pattern
  `vi.mock('pino', () => { ... factory ... })`. Lo replicás con `vi.mock('ioredis', ...)`.

- [ ] Leíste `src/__tests__/unit/env.test.ts` (43 líneas) y entendés el pattern para
  testear `parseEnv` con mock de `process.exit` y `process.stderr.write`.

- [ ] Confirmaste que los siguientes archivos están todos presentes:
  - `src/infra/env.ts` (40 líneas actuales)
  - `src/infra/logger.ts` (32 líneas)
  - `src/infra/shutdown.ts` (64 líneas) — NO lo vas a modificar
  - `src/app.ts` (52 líneas)

- [ ] Confirmaste que `src/infra/redis.ts` NO existe todavía (vas a crearlo).

- [ ] Confirmaste que `src/__tests__/unit/redis.test.ts` NO existe todavía.

- [ ] NO vas a importar `src/core/*`, `src/chains/*`, `src/methods/*`, `src/routes/*`
  desde `redis.ts`. Solo `ioredis` (runtime) + type-only `EnvConfig` y `Logger`.

- [ ] NO vas a loggear `process.env.REDIS_URL` ni `env.REDIS_URL` sin redactar.

- [ ] NO vas a usar `any` ni `as unknown as X` en código productivo (`src/infra/redis.ts`
  y `src/app.ts`). Los tests pueden usar `as unknown as X` solo si replican un pattern
  ya existente (ver `src/__tests__/unit/shutdown.test.ts`).

---

## 5. Shapes exactas

### 5.1. `src/infra/env.ts` — cambios (W0)

**Pattern a mantener**: la función `parseEnv()` y sus tests siguen iguales. Solo se modifica
la **definición del schema**.

```ts
// src/infra/env.ts — shape final

import { z } from 'zod';

/**
 * Environment variables schema.
 *
 * CD-2: PORT default 3002 is declared here (the only source-of-truth literal).
 * CD-8: validation fails FAST in `parseEnv` before anything else bootstraps.
 *
 * REDIS_URL: required in development/production. Optional when NODE_ENV === 'test'
 *            (tests must not require a live Redis instance — see WFAC-5 AC-3).
 * REDIS_DB:  optional Redis logical database index (0-15). Default 0.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),
    REDIS_URL: z.string().min(1).optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
  })
  .superRefine((data, ctx) => {
    if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when NODE_ENV is not "test"',
      });
    }
  });

export type EnvConfig = z.infer<typeof EnvSchema>;

// parseEnv() — NO CAMBIA. Mismo código actual (líneas 28-40).
export function parseEnv(raw: NodeJS.ProcessEnv): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    const message = `Env validation failed:\n${lines.join('\n')}\n`;
    process.stderr.write(message);
    process.exit(1);
  }
  return result.data;
}
```

**El tipo inferido resultante** (verificable con hover en IDE):

```ts
type EnvConfig = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  SHUTDOWN_GRACE_MS: number;
  REDIS_URL: string | undefined;   // <- optional
  REDIS_DB: number;                // <- default 0
};
```

### 5.2. `src/infra/redis.ts` — NUEVO archivo (W1)

**Shape completo** (el Dev escribe los bodies, las firmas son no-negociables):

```ts
/**
 * Redis client singleton for wasiai-facilitator.
 *
 * WFAC-5 — Idempotency Cache Foundation.
 *
 * Design:
 *   - Module-level singleton (DT-1). NO class, NO factory pattern.
 *   - `initRedis(env, logger)` is called once by `buildApp()`; it is idempotent.
 *   - `getRedisClient()` creates the ioredis instance lazily on first call.
 *   - Returns `Redis | null`:
 *     * `Redis`  in dev/prod (or test with REDIS_URL set)
 *     * `null`   in test env with no REDIS_URL → callers fall back to in-memory
 *
 * Boundaries (OWNERS.md):
 *   - Imports: `ioredis` (runtime), `pino` (type-only), `./env.js` (type-only).
 *   - Must NOT import from `src/core/*`, `src/chains/*`, `src/methods/*`,
 *     `src/routes/*`, `src/middleware/*`.
 *
 * Lifecycle:
 *   - Client is created with `lazyConnect: true` — no TCP I/O on construction.
 *   - Event handlers for 'connect' and 'error' are registered immediately.
 *   - Shutdown: `buildApp()` registers a Fastify `onClose` hook that calls
 *     `client.quit()` (NOT `disconnect()`) before `app.close()` resolves.
 *
 * Security:
 *   - REDIS_URL may contain a password (redis://user:pass@host:port/db).
 *   - `redactRedisUrl()` is ALWAYS called before any log output. Never log
 *     `env.REDIS_URL` directly.
 */

import Redis from 'ioredis';
import type { EnvConfig } from './env.js';
import type { Logger } from 'pino';

/**
 * Minimal logger surface used by this module. Declared as `Pick<Logger, ...>`
 * so callers can pass either a Pino Logger or a FastifyBaseLogger without a
 * cast (both satisfy this shape structurally).
 */
export type RedisLogger = Pick<Logger, 'info' | 'error' | 'warn'>;

// ─── module state ──────────────────────────────────────────────────────────
let _client: Redis | null = null;
let _env: EnvConfig | null = null;
let _logger: RedisLogger | null = null;
let _initialized = false;

/**
 * Initialize the Redis singleton's dependencies (env + logger).
 *
 * Called ONCE from `buildApp()`. Subsequent calls with the same env are no-ops.
 *
 * Does NOT create the ioredis instance — that happens lazily on the first
 * `getRedisClient()` call.
 */
export function initRedis(env: EnvConfig, logger: RedisLogger): void {
  if (_initialized && _env === env && _logger === logger) {
    return; // idempotent
  }
  _env = env;
  _logger = logger;
  _initialized = true;
}

/**
 * Returns the singleton ioredis client, creating it on first call.
 *
 * Returns `null` if:
 *   - `initRedis` was never called, OR
 *   - `NODE_ENV === 'test'` AND `REDIS_URL` is undefined.
 *
 * In production, an invalid REDIS_URL is not expected (parseEnv rejects before
 * boot). But if it happens anyway, the error is caught by the `'error'`
 * handler and logged; the process does not crash.
 */
export function getRedisClient(): Redis | null {
  if (!_initialized || _env === null || _logger === null) {
    // initRedis was never called — refuse to auto-create.
    return null;
  }
  if (_client) return _client;

  const url = _env.REDIS_URL;
  if (!url) {
    // Test env path — caller must handle null (in-memory fallback).
    return null;
  }

  const logger = _logger;

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    db: _env.REDIS_DB,
    connectionName: 'wasiai-facilitator',
    retryStrategy: redisRetryStrategy,
  });

  // CD-4: register error handler IMMEDIATELY after construction.
  client.on('error', (err: Error) => {
    logger.error({ err }, 'Redis error');
  });

  client.on('connect', () => {
    const { host, port } = parseHostPort(url);
    logger.info({ host, port }, 'Redis connected');
  });

  logger.info(
    { url: redactRedisUrl(url), db: _env.REDIS_DB },
    'Redis client instantiated',
  );

  _client = client;
  return _client;
}

/**
 * Exponential backoff retry strategy for ioredis (AC-9).
 *
 *   times=0  → 100ms
 *   times=1  → 200ms
 *   times=2  → 400ms
 *   times=3  → 800ms
 *   times=4  → 1600ms
 *   times=5+ → 3000ms (capped)
 *   times>10 → null (give up; ioredis emits final 'error' event)
 */
export function redisRetryStrategy(times: number): number | null {
  if (times > 10) return null;
  return Math.min(100 * 2 ** times, 3000);
}

/**
 * Redact the password (and username, if any) from a Redis URL before logging.
 *
 * Examples:
 *   'redis://host:6379/0'                     → 'redis://host:6379/0'
 *   'redis://:pass@host:6379/0'               → 'redis://:*@host:6379/0'
 *   'redis://user:pass@host:6379/0'           → 'redis://*:*@host:6379/0'
 *   'not-a-url'                               → 'redis://***'
 *
 * CD-1: This function is the ONLY sanctioned way to prepare a REDIS_URL for logs.
 */
export function redactRedisUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '*';
    if (u.username) u.username = '*';
    return u.toString();
  } catch {
    return 'redis://***';
  }
}

/**
 * Parse host:port from a Redis URL for structured logging (AC-7).
 * Falls back to `unknown`/`0` if the URL is malformed.
 */
function parseHostPort(raw: string): { host: string; port: number } {
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || 'unknown',
      port: u.port ? Number(u.port) : 6379,
    };
  } catch {
    return { host: 'unknown', port: 0 };
  }
}

/**
 * Reset the singleton for tests. DO NOT CALL IN PRODUCTION CODE.
 *
 * Vitest pattern: call this in `beforeEach` to ensure each test gets a fresh
 * mocked instance.
 */
export function resetRedisClientForTests(): void {
  _client = null;
  _env = null;
  _logger = null;
  _initialized = false;
}
```

**Notas de implementación**:

- **NUNCA** uses `console.log`/`console.error`. Todos los logs pasan por `_logger`.
- **NUNCA** hagas `new Redis(_env.REDIS_URL!)` con non-null assertion. Ya chequeaste con
  `if (!url) return null`.
- El `_initialized === true` check en `initRedis` previene el warning "logger replaced
  mid-test" si un test llama `initRedis` dos veces con distintos loggers — en ese caso
  **sí** actualizamos (porque cambió la ref). Pero en producción, `buildApp` lo llama
  una sola vez por proceso.
- El retry strategy es una **function declaration nombrada**, no arrow — así aparece con
  nombre en stack traces.

### 5.3. `src/app.ts` — cambios (W2)

**Diff conceptual** (el Dev edita, no reemplaza el archivo entero):

```ts
// src/app.ts — diff conceptual

import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import type { DestinationStream } from 'pino';
import { parseEnv, type EnvConfig } from './infra/env.js';
import { createLogger } from './infra/logger.js';
+import { initRedis, getRedisClient } from './infra/redis.js';
import { healthRoute } from './routes/health.js';

// BuildAppOptions — NO CAMBIA

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env: EnvConfig = options.env ?? parseEnv(options.rawEnv ?? process.env);
  const logger: FastifyBaseLogger = createLogger(env, options.loggerDestination);

+  // WFAC-5: initialize Redis singleton with env + logger. Idempotent; creates
+  // no TCP connection (lazyConnect: true). The actual ioredis instance is
+  // created lazily on the first getRedisClient() call by consumers.
+  initRedis(env, logger);

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  });

  await app.register(healthRoute);

+  // WFAC-5 AC-10/AC-11: quit Redis client during graceful shutdown. Fastify
+  // v5 runs onClose hooks before app.close() resolves. Null-guard for test env
+  // (getRedisClient may return null when REDIS_URL is undefined).
+  app.addHook('onClose', async () => {
+    const client = getRedisClient();
+    if (!client) return;
+    try {
+      await client.quit();
+    } catch (err: unknown) {
+      logger.error({ err }, 'Redis quit failed during shutdown');
+    }
+  });

  return app;
}
```

**Por qué pasamos `logger` (FastifyBaseLogger) a `initRedis` que espera `RedisLogger`**:
el tipo `RedisLogger = Pick<Logger, 'info' | 'error' | 'warn'>` es estructuralmente
satisfecho por `FastifyBaseLogger`, que tiene esos tres métodos. TypeScript NO pide cast —
por eso la firma `initRedis(env: EnvConfig, logger: RedisLogger)`. Zero `any`, zero
`as unknown as`.

### 5.4. `src/__tests__/unit/redis.test.ts` — NUEVO archivo (W3)

**Shape completo** (el Dev adapta los asserts y los bodies de los tests):

```ts
/**
 * Unit tests for src/infra/redis.ts (WFAC-5).
 *
 * Strategy: mock `ioredis` with a minimal class that records constructor args,
 * registers event handlers, and exposes an __emit helper to simulate events.
 * No live Redis is required (CD-9).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '../../infra/env.js';

// ─── ioredis mock ──────────────────────────────────────────────────────────
// Hoisted by Vitest. Do NOT close over external state beyond exported helpers.
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const quitSpy = vi.fn<[], Promise<'OK'>>(() => Promise.resolve('OK'));

  class RedisMock {
    options: Record<string, unknown>;
    url: string;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, opts: Record<string, unknown>) {
      constructorSpy(url, opts);
      this.url = url;
      this.options = opts;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(handler);
      this.listeners.set(event, arr);
      return this;
    }

    quit(): Promise<'OK'> {
      return quitSpy();
    }

    // Test-only helper to fire a registered handler.
    __emit(event: string, ...args: unknown[]): void {
      (this.listeners.get(event) ?? []).forEach((h) => h(...args));
    }
  }

  return {
    default: RedisMock,
    Redis: RedisMock,
    __constructorSpy: constructorSpy,
    __quitSpy: quitSpy,
  };
});

// Fake logger — plain vi.fn() so we can assert calls + arguments.
function makeFakeLogger(): {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'info',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_URL: 'redis://localhost:6379/0',
    REDIS_DB: 0,
    ...overrides,
  };
}

describe('redactRedisUrl', () => {
  it('masks the password component', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    const out = redactRedisUrl('redis://user:secret123@host.example:6379/2');
    expect(out).not.toContain('secret123');
    expect(out).toContain('host.example');
    expect(out).toContain(':6379');
  });

  it('masks both username and password', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    const out = redactRedisUrl('redis://user:pass@host:6379');
    expect(out).not.toContain('user');
    expect(out).not.toContain('pass');
  });

  it('returns safe fallback for malformed URLs', async () => {
    const { redactRedisUrl } = await import('../../infra/redis.js');
    expect(redactRedisUrl('not a url')).toBe('redis://***');
  });
});

describe('redisRetryStrategy', () => {
  it('returns exponential backoff values', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(0)).toBe(100);
    expect(redisRetryStrategy(1)).toBe(200);
    expect(redisRetryStrategy(2)).toBe(400);
    expect(redisRetryStrategy(3)).toBe(800);
    expect(redisRetryStrategy(4)).toBe(1600);
  });

  it('caps at 3000ms', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(5)).toBe(3000);
    expect(redisRetryStrategy(10)).toBe(3000);
  });

  it('returns null after 10 retries', async () => {
    const { redisRetryStrategy } = await import('../../infra/redis.js');
    expect(redisRetryStrategy(11)).toBeNull();
    expect(redisRetryStrategy(100)).toBeNull();
  });
});

describe('getRedisClient', () => {
  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy.mockClear();
    (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy.mockClear();
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when initRedis was never called', async () => {
    const { getRedisClient } = await import('../../infra/redis.js');
    expect(getRedisClient()).toBeNull();
  });

  it('returns null in test env when REDIS_URL is undefined (AC-6)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    initRedis(makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }), makeFakeLogger());
    expect(getRedisClient()).toBeNull();
  });

  it('returns the same instance on repeated calls (AC-4, singleton)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    const a = getRedisClient();
    const b = getRedisClient();

    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('constructs Redis with lazyConnect, maxRetriesPerRequest, enableReadyCheck (AC-4)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('redis://localhost:6379/0');
    expect(opts.lazyConnect).toBe(true);
    expect(opts.maxRetriesPerRequest).toBe(3);
    expect(opts.enableReadyCheck).toBe(false);
    expect(typeof opts.retryStrategy).toBe('function');
    expect(opts.db).toBe(0);
  });

  it('logs redacted URL at info level on first creation (AC-5)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(
      makeEnv({ REDIS_URL: 'redis://user:supersecret@host:6379/0' }),
      logger,
    );
    getRedisClient();

    expect(logger.info).toHaveBeenCalled();
    const allCalls = logger.info.mock.calls;
    // Find the "Redis client instantiated" log.
    const creationCall = allCalls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Redis client instantiated'),
    );
    expect(creationCall).toBeDefined();
    const payload = creationCall?.[0] as { url: string };
    expect(payload.url).not.toContain('supersecret');
    expect(payload.url).toContain('host:6379');
  });

  it('emits "Redis connected" log on connect event (AC-7)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(makeEnv({ REDIS_URL: 'redis://host.example:6380/0' }), logger);
    const client = getRedisClient();
    expect(client).not.toBeNull();

    // Trigger the registered 'connect' handler.
    (client as unknown as { __emit: (event: string) => void }).__emit('connect');

    const connectCall = logger.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'Redis connected',
    );
    expect(connectCall).toBeDefined();
    const payload = connectCall?.[0] as { host: string; port: number };
    expect(payload.host).toBe('host.example');
    expect(payload.port).toBe(6380);
  });

  it('logs error at error level on error event without throwing (AC-8)', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const logger = makeFakeLogger();
    initRedis(makeEnv(), logger);
    const client = getRedisClient();
    expect(client).not.toBeNull();

    const fakeErr = new Error('ECONNREFUSED');
    expect(() => {
      (client as unknown as { __emit: (event: string, err: Error) => void }).__emit('error', fakeErr);
    }).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith({ err: fakeErr }, 'Redis error');
  });

  it('initRedis is idempotent across repeated calls', async () => {
    const { initRedis, getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy;

    const env = makeEnv();
    const logger = makeFakeLogger();
    initRedis(env, logger);
    initRedis(env, logger); // second call with same refs → no-op
    getRedisClient();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resetRedisClientForTests clears state', async () => {
    const { initRedis, getRedisClient, resetRedisClientForTests } = await import(
      '../../infra/redis.js'
    );
    const ioredis = await import('ioredis');
    const spy = (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy;

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();
    expect(spy).toHaveBeenCalledTimes(1);

    resetRedisClientForTests();
    expect(getRedisClient()).toBeNull(); // not initialized anymore

    initRedis(makeEnv(), makeFakeLogger());
    getRedisClient();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('buildApp onClose integration (AC-10, AC-11)', () => {
  beforeEach(async () => {
    const ioredis = await import('ioredis');
    (ioredis as unknown as { __constructorSpy: ReturnType<typeof vi.fn> }).__constructorSpy.mockClear();
    (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy.mockClear();
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  it('calls redis.quit() during app.close() when client exists (AC-10)', async () => {
    const { buildApp } = await import('../../app.js');
    const { getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;

    const app = await buildApp({
      env: makeEnv({ REDIS_URL: 'redis://host:6379/0' }),
    });
    // Force client creation.
    getRedisClient();

    await app.close();
    expect(quitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw and logs error when quit() rejects (AC-11)', async () => {
    const { buildApp } = await import('../../app.js');
    const { getRedisClient } = await import('../../infra/redis.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;
    quitSpy.mockRejectedValueOnce(new Error('quit boom'));

    const app = await buildApp({
      env: makeEnv({ REDIS_URL: 'redis://host:6379/0' }),
    });
    getRedisClient();

    await expect(app.close()).resolves.not.toThrow();
  });

  it('skips quit when client is null (test env path)', async () => {
    const { buildApp } = await import('../../app.js');
    const ioredis = await import('ioredis');
    const quitSpy = (ioredis as unknown as { __quitSpy: ReturnType<typeof vi.fn> }).__quitSpy;

    const app = await buildApp({
      env: makeEnv({ NODE_ENV: 'test', REDIS_URL: undefined }),
    });
    // No getRedisClient() call → singleton stays null.

    await app.close();
    expect(quitSpy).not.toHaveBeenCalled();
  });
});
```

**Notas importantes para el Dev sobre los tests**:

1. El `as unknown as { __constructorSpy: ... }` del mock es aceptable — es el pattern
   para acceder a helpers del mock sin romper tipos. MISMO pattern que
   `src/__tests__/unit/shutdown.test.ts` usa para el fake `FastifyInstance`.
2. **CD-12**: no usamos `vi.resetModules()`. El reset se hace via
   `resetRedisClientForTests()` que no invalida el módulo.
3. El mock de `ioredis` está al tope del archivo — vitest lo hoist. No lo muevas.
4. El `await import('../../infra/redis.js')` dinámico dentro de cada test es intencional:
   garantiza que el mock de ioredis ya está en el registry antes de que redis.ts
   resuelva su import.

### 5.5. `src/__tests__/unit/env.test.ts` — 3 tests nuevos (W0)

**Agregar al final del `describe('parseEnv', ...)` existente**:

```ts
it('returns REDIS_URL when present in production env (WFAC-5 AC-1)', () => {
  const result = parseEnv({
    NODE_ENV: 'production',
    REDIS_URL: 'redis://host:6379/0',
  });
  expect(result.REDIS_URL).toBe('redis://host:6379/0');
  expect(result.REDIS_DB).toBe(0); // default
});

it('exits with code 1 and mentions REDIS_URL when missing in prod (WFAC-5 AC-2)', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow('__exit__');

  expect(exitSpy).toHaveBeenCalledWith(1);
  const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  expect(allWrites).toContain('REDIS_URL');
});

it('does NOT exit when REDIS_URL absent in test env (WFAC-5 AC-3)', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const result = parseEnv({ NODE_ENV: 'test' });
  expect(result.REDIS_URL).toBeUndefined();
  expect(exitSpy).not.toHaveBeenCalled();
});
```

### 5.6. `.env.example` — cambios (W3)

Línea 49 actual dice:
```
REDIS_URL=redis://localhost:6379
```

Modificar a:
```
REDIS_URL=redis://localhost:6379

# Redis logical database index (0-15). Optional, default 0. Used by ioredis
# client for namespacing between different environments sharing a Redis instance.
REDIS_DB=0
```

No tocar el resto del archivo.

---

## 6. Waves de implementación (orden secuencial estricto)

### W0 — Env schema (src/infra/env.ts)

1. Abrir `src/infra/env.ts`.
2. Reemplazar la definición de `EnvSchema` con el shape de §5.1.
3. Dejar `parseEnv()` intacta.
4. Abrir `src/__tests__/unit/env.test.ts` y agregar los 3 tests nuevos de §5.5.
5. Correr `npm run typecheck` → debe pasar.
6. Correr `npm run test -- src/__tests__/unit/env.test.ts` → los 4 tests existentes + los 3 nuevos deben pasar.

**Checkpoint W0**: 7 tests pasan en `env.test.ts`, typecheck limpio.

### W1 — Redis client singleton (src/infra/redis.ts)

1. Crear `src/infra/redis.ts` con el shape de §5.2.
2. Correr `npm run typecheck` → debe pasar (incluye el nuevo archivo).
3. Correr `npm run lint` → debe pasar sin warnings.
4. Chequear que el archivo NO tiene:
   - `console.*` anywhere.
   - `any` type (usar `unknown` si necesario).
   - `as unknown as X` (no hace falta en `redis.ts`).
   - Imports de `src/core/*`, `src/chains/*`, `src/methods/*`, `src/routes/*`, `src/middleware/*`.

**Checkpoint W1**: `redis.ts` typechekea y lintea. Sin tests todavía.

### W2 — Integración con buildApp (src/app.ts)

1. Editar `src/app.ts` aplicando el diff de §5.3:
   - Nuevo import: `initRedis, getRedisClient`.
   - Nueva línea: `initRedis(env, logger);` después de `createLogger`.
   - Nuevo hook: `app.addHook('onClose', async () => { ... })` antes de `return app`.
2. Correr `npm run typecheck` → debe pasar.
3. Correr `npm run test` → TODOS los tests existentes (health, shutdown, logger, env,
   chain-adapter, chain-registry, core-types, no-console) deben seguir pasando.

**Checkpoint W2**: baseline intacto, nueva integración compila.

### W3 — Tests + `.env.example` + qa green

1. Crear `src/__tests__/unit/redis.test.ts` con el shape de §5.4.
2. Correr `npm run test -- src/__tests__/unit/redis.test.ts` → todos los tests nuevos deben pasar.
3. Editar `.env.example` según §5.6.
4. Correr `npm run qa` → verde entero (typecheck + lint + format:check + test).
5. Correr `npm run build` → limpio.

**Checkpoint W3 (final)**: pipeline listo para AR.

---

## 7. Patterns a seguir (referencias verificadas)

| Pattern | Archivo exemplar (wasiai-facilitator) | Qué extraer |
|---------|---------------------------------------|-------------|
| Zod schema + `parseEnv` con stderr/exit | `src/infra/env.ts` (pre-cambio) | Estructura del schema + comportamiento de fallo |
| Cross-field Zod validation | Zod docs + `.superRefine((data, ctx) => ctx.addIssue(...))` | Usar `z.ZodIssueCode.custom` + `path: [...]` |
| `vi.mock('pkg', () => factory)` hoisted | `src/__tests__/unit/logger.test.ts` | El mock factory es hoisted; no cerrar sobre estado externo |
| Fake `FastifyInstance` con `as unknown as X` | `src/__tests__/unit/shutdown.test.ts` | Pattern aceptado en tests para simular estructura grande |
| `app.addHook('onClose', async () => {...})` | Fastify v5 docs (no hay exemplar en el repo todavía) | Cleanup hooks corren antes de que `app.close()` resuelva |
| Pino logger inyectado en tests | `src/infra/logger.ts` + `logger.test.ts` | `createLogger(env, destination?)` + `vi.mocked(...)` |

---

## 8. Tests requeridos (mapeo AC → test)

**Total: 17 tests nuevos + 4 existentes en `env.test.ts` sin cambios = 21 tests en total
que tocan esta HU.**

### En `src/__tests__/unit/env.test.ts` (3 nuevos)

| # | Test name | AC |
|---|-----------|-----|
| E1 | `returns REDIS_URL when present in production env (WFAC-5 AC-1)` | AC-1 |
| E2 | `exits with code 1 and mentions REDIS_URL when missing in prod (WFAC-5 AC-2)` | AC-2 |
| E3 | `does NOT exit when REDIS_URL absent in test env (WFAC-5 AC-3)` | AC-3 |

### En `src/__tests__/unit/redis.test.ts` (14 nuevos)

| # | Test name | AC |
|---|-----------|-----|
| R1 | `redactRedisUrl masks the password component` | AC-5 |
| R2 | `redactRedisUrl masks both username and password` | AC-5 |
| R3 | `redactRedisUrl returns safe fallback for malformed URLs` | AC-5 (hardening) |
| R4 | `redisRetryStrategy returns exponential backoff values` | AC-9 |
| R5 | `redisRetryStrategy caps at 3000ms` | AC-9 |
| R6 | `redisRetryStrategy returns null after 10 retries` | AC-9 |
| R7 | `getRedisClient returns null when initRedis was never called` | AC-6 (edge) |
| R8 | `getRedisClient returns null in test env when REDIS_URL is undefined` | AC-6 |
| R9 | `getRedisClient returns the same instance on repeated calls` | AC-4 |
| R10 | `Redis constructor called with lazyConnect, maxRetriesPerRequest, enableReadyCheck` | AC-4 |
| R11 | `logs redacted URL at info level on first creation` | AC-5 |
| R12 | `emits "Redis connected" log on connect event` | AC-7 |
| R13 | `logs error at error level on error event without throwing` | AC-8 |
| R14a | `initRedis is idempotent across repeated calls` | hardening |
| R14b | `resetRedisClientForTests clears state` | hardening |
| R15 | `calls redis.quit() during app.close() when client exists` | AC-10 |
| R16 | `does not throw and logs error when quit() rejects` | AC-11 |
| R17 | `skips quit when client is null (test env path)` | AC-11 (edge) |

### AC coverage

| AC | Cubierto por |
|----|--------------|
| AC-1 | E1 |
| AC-2 | E2 |
| AC-3 | E3 |
| AC-4 | R9, R10 |
| AC-5 | R1, R2, R3, R11 |
| AC-6 | R7, R8 |
| AC-7 | R12 |
| AC-8 | R13 |
| AC-9 | R4, R5, R6 |
| AC-10 | R15 |
| AC-11 | R16, R17 |
| AC-12 | **Out of scope — WFAC-21** (documentado en SDD §14) |
| AC-13 | Implícito — todo corre sin live Redis |
| AC-14 | Implícito — `npm run typecheck` en DoD |

---

## 9. Constraint Directives (12 totales)

| # | Regla | Archivo crítico |
|---|-------|-----------------|
| CD-1 | No loggear `REDIS_URL` sin `redactRedisUrl()`. | `src/infra/redis.ts` |
| CD-2 | Solo `src/infra/redis.ts` hace `new Redis(...)`. | Cross-repo |
| CD-3 | `getRedisClient(): Redis \| null` (NO `undefined`, NO `any`). | `src/infra/redis.ts` |
| CD-4 | `client.on('error', ...)` registrado inmediatamente post-construcción. | `src/infra/redis.ts` |
| CD-5 | No Cluster, no Sentinel. | `src/infra/redis.ts` |
| CD-6 | OWNERS: `redis.ts` solo importa `ioredis` + type-only `EnvConfig`/`Logger`. | `src/infra/redis.ts` |
| CD-7 | No `console.*` en `src/infra/redis.ts`. | `src/infra/redis.ts` |
| CD-8 | `redis.quit()` se llama durante shutdown (via `onClose` hook). | `src/app.ts` |
| CD-9 | Tests corren sin live Redis (mock obligatorio). | `redis.test.ts` |
| CD-10 | No hardcode de `redis://localhost:6379` en `src/`. Solo `.env.example` y `vi.mock`. | Cross-repo |
| CD-11 | Tests de logging usan logger spy inyectado (NO depender de captura stdout — vitest pone `LOG_LEVEL=silent`). | `redis.test.ts` |
| CD-12 | PROHIBIDO `vi.resetModules()` + `instanceof Redis` en tests. Usar `resetRedisClientForTests()`. | `redis.test.ts` |

**Cada violación = BLOQUEANTE en AR/CR.**

---

## 10. Read-first paths en node_modules (obligatorio en W1)

Antes de escribir `src/infra/redis.ts`, el Dev DEBE leer y confirmar:

| Path | Qué confirmar |
|------|---------------|
| `node_modules/ioredis/package.json` | `"version": "5.4.1"` (o compat) |
| `node_modules/ioredis/built/index.d.ts` | `export default Redis` (default import válido) |
| `node_modules/ioredis/built/Redis.d.ts` | Constructor `constructor(path: string, options: RedisOptions)`; método `quit(): Promise<'OK'>`; events `'connect' \| 'error' \| 'close' \| 'ready'` via `.on(event, cb)` |
| `node_modules/ioredis/built/redis/RedisOptions.d.ts` | Campos: `retryStrategy?: (times: number) => number \| void \| null`, `maxRetriesPerRequest?: number \| null`, `enableReadyCheck?: boolean`, `lazyConnect?: boolean`, `db?: number`, `connectionName?: string` |

**No es opcional.** Si alguno de estos shape NO está como el SDD/Story File describen,
parar y escalar (puede haber drift de versión).

---

## 11. Drift policy

Si durante F3 encontrás que algo no es como el Story File dice:

1. **PARAR**. No implementar por libre.
2. Anotar el drift en `doc/sdd/004-wfac-5-redis-client/auto-blindaje.md` (crear si no existe).
3. Escalar al humano via el orquestador con: (a) qué esperabas, (b) qué encontraste,
   (c) opciones de resolución.
4. Esperar decisión del humano.

Auto-Blindaje es una entrada por cada drift/fix. El orquestador va a leer este archivo en
el pipeline CR/F4 para decidir si la desviación es aceptable.

---

## 12. Done Definition (DoD)

La HU NO está DONE hasta que TODOS estos ítems sean true:

- [ ] W0 completo: `src/infra/env.ts` modificado + 3 tests nuevos en `env.test.ts`.
- [ ] W1 completo: `src/infra/redis.ts` creado con las 5 exports (`initRedis`,
  `getRedisClient`, `redactRedisUrl`, `redisRetryStrategy`, `resetRedisClientForTests`).
- [ ] W2 completo: `src/app.ts` llama `initRedis()` + registra `onClose` hook.
- [ ] W3 completo: `src/__tests__/unit/redis.test.ts` creado con los 14-17 tests; `.env.example`
  actualizado con `REDIS_DB`.
- [ ] `npm run typecheck` exit 0.
- [ ] `npm run lint` exit 0 sin warnings.
- [ ] `npm run format:check` exit 0.
- [ ] `npm run test` exit 0 (todos los tests del repo verdes).
- [ ] `npm run qa` (atajo a los 4 anteriores) exit 0.
- [ ] `npm run build` exit 0, `dist/` generado sin errors.
- [ ] Zero `any` en código productivo (`src/infra/redis.ts`, cambios en `src/app.ts`,
  `src/infra/env.ts`).
- [ ] Zero `console.*` en `src/infra/redis.ts`.
- [ ] Zero hardcode de `redis://localhost:6379` en `src/` (CD-10 grep check:
  `grep -r 'redis://localhost' src/ --exclude-dir=__tests__` debe retornar **cero hits**
  fuera de tests).
- [ ] CD-4 verificable: el `.on('error', ...)` está en la línea INMEDIATAMENTE siguiente
  al `new Redis(...)` (o dentro del mismo bloque, antes de cualquier otra operación).
- [ ] CD-6 verificable: `grep 'from.*src/core' src/infra/redis.ts` debe retornar cero
  hits (idem para `chains`, `methods`, `routes`, `middleware`).
- [ ] Los 14 ACs mapeados a tests (§8) — cada AC cubierto por al menos un test que
  pasa (excepto AC-12 explícitamente out-of-scope).
- [ ] Git diff del PR toca solo los 6 archivos del Scope IN. Si tocás algo fuera: drift
  → documentar en `auto-blindaje.md`.
- [ ] Branch `feat/004-wfac-5-redis-client` con commits atómicos por wave (sugerido,
  no obligatorio): `W0:`, `W1:`, `W2:`, `W3:`.

---

## 13. Next steps (post-F3)

Cuando el Dev termine W3 y todos los checkboxes de DoD estén tildados:

1. Pushear el branch.
2. Reportar al orquestador: "F3 COMPLETE — WFAC-5 ready for AR".
3. El orquestador lanza `/nexus-p5-ar WFAC-5` → Adversary Review.
4. Si AR APROBADO → orquestador lanza `/nexus-p6-cr WFAC-5` → Code Review.
5. Si CR APROBADO → orquestador lanza `/nexus-p7-f4 WFAC-5` → QA + ACs.
6. Si F4 APROBADO → orquestador lanza `/nexus-p8-done WFAC-5` → merge + cierre.

El Dev NO avanza estos pasos — los lanza el orquestador.
