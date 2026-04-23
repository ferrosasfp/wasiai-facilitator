# SDD #004 — WFAC-5 Redis Client — Idempotency Cache Foundation

> SPEC_APPROVED: no
> Fecha: 2026-04-22
> Tipo: infra (fundacional)
> SDD_MODE: full
> Clasificación: QUALITY
> Branch: `feat/004-wfac-5-redis-client` (desde `main@f93a97b`)
> Artefactos: `doc/sdd/004-wfac-5-redis-client/`
> Jira: https://ferrosasfp.atlassian.net/browse/WFAC-5
> HU_APPROVED: sí (work-item.md revisado por humano)

---

## 1. Overview

Implementar el **singleton ioredis** como fundación de idempotencia/rate-limit/BullMQ para
wasiai-facilitator. Esta HU NO escribe lógica de negocio: crea la infraestructura de
conexión con su ciclo de vida integrado al shutdown handler existente, logging redacted,
retry strategy explícita y un comportamiento diferenciado por `NODE_ENV` que permite que
todo el test suite corra sin live Redis.

**Entrega**:

1. `src/infra/env.ts` extendido con `REDIS_URL` (obligatorio en `development`/`production`,
   opcional en `test`) y `REDIS_DB` (opcional, default `0`).
2. `src/infra/redis.ts` nuevo: exporta `getRedisClient(): Redis | null`,
   `resetRedisClientForTests()`, y `redactRedisUrl(url: string): string` (exportado para
   los tests AC-13). Internamente: singleton module-level, `lazyConnect: true`,
   `maxRetriesPerRequest: 3`, `enableReadyCheck: false`, `retryStrategy` exponential
   backoff con cap 3s y máximo 10 intentos, event handlers `connect`/`error`.
3. Integración con shutdown vía **Fastify `onClose` hook** registrado en `buildApp()` —
   esto hace que `app.close()` espere el `redis.quit()` antes de resolver (AC-10), con
   null-guard para el caso test-env (AC-11).
4. `src/__tests__/unit/redis.test.ts` nuevo con mocks de ioredis para verificar singleton
   identity, URL redaction, retry strategy y null-return path.
5. `.env.example` actualizado (el archivo ya tiene `REDIS_URL=redis://localhost:6379`;
   agregamos `REDIS_DB=0` con comentario).

**Resultado esperado**: `npm run qa` verde, `getRedisClient()` devuelve la misma instancia
en N llamadas, password no aparece en ningún log stdout, `SIGTERM` ejecuta `quit()` antes
de exit, y WFAC-21/WFAC-40/WFAC-42 pueden desbloquearse con una sola línea de import.

---

## 2. Architecture

### Diagrama de componentes (esta HU)

```
┌───────────────────────────────────────────────────────────────────────┐
│  src/index.ts                                                          │
│    │  parseEnv(process.env) → EnvConfig { ..., redisUrl?, redisDb }    │
│    │  buildApp({ env })                                                │
│    │  app.listen(...)                                                  │
│    │  createShutdownHandler(...)  ← NO cambia en esta HU               │
│    ▼                                                                    │
│  src/app.ts            (buildApp factory)                              │
│    │  register routes                                                  │
│    │  app.addHook('onClose', async () => {                             │
│    │    const client = getRedisClient();                               │
│    │    if (client) { await client.quit().catch((e) => log.error) }    │
│    │  })                                                               │
│    ▼                                                                    │
│  src/infra/redis.ts    (singleton — new)                               │
│    │  let _client: Redis | null = null                                 │
│    │  getRedisClient(): Redis | null                                   │
│    │    - reads env.redisUrl (via lazy parseEnv inside getter? NO ─    │
│    │      → caller passes env via init(env, logger) in W1, see DT-7)   │
│    │  redactRedisUrl(raw: string): string                              │
│    │  resetRedisClientForTests(): void                                 │
│    └──► ioredis → single TCP connection (lazyConnect)                  │
└───────────────────────────────────────────────────────────────────────┘
```

### Flujo de arranque

1. `index.ts` → `parseEnv(process.env)` devuelve `EnvConfig` con `redisUrl` validado
   (obligatorio en prod/dev, opcional en test).
2. `index.ts` → `buildApp({ env })`.
3. Dentro de `buildApp`, ANTES de `app.register(healthRoute)`, inicializamos el
   singleton: `initRedis(env, logger)` — este método guarda el `env` y el `logger` en
   variables module-level de `redis.ts` (ver DT-7) para que cualquier caller posterior
   pueda llamar `getRedisClient()` sin tener que volver a pasar env/logger.
4. Mismo `buildApp` registra un hook `onClose`:
   ```ts
   app.addHook('onClose', async () => {
     const client = getRedisClient();
     if (!client) return;              // test env o caller con fallback
     try { await client.quit(); }
     catch (err) { logger.error({ err }, 'Redis quit failed during shutdown'); }
   });
   ```
5. `getRedisClient()` la PRIMERA vez:
   - Lee `env.redisUrl`. Si `undefined` (solo posible con `NODE_ENV=test`) → retorna
     `null` sin instanciar nada (AC-6).
   - `new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3,
     enableReadyCheck: false, db: env.redisDb, retryStrategy, connectionName: 'wasiai-facilitator' })`.
   - Registra `.on('error', …)` inmediatamente (CD-4) y `.on('connect', …)`.
   - Loggea `{ msg: 'Redis client instantiated', url: redactRedisUrl(env.redisUrl) }`.
   - Guarda en `_client` y lo retorna.
6. Llamadas subsiguientes retornan `_client` sin reinicializar (AC-4).
7. Ciclo de vida de conexión:
   - `lazyConnect: true` → el socket TCP no se abre hasta el primer comando, o hasta
     que un caller haga `await client.connect()` explícito. Esta HU NO llama `.connect()`
     — lo hará el primer consumidor (WFAC-21 probablemente).
   - Cuando el socket sí se abra, ioredis emite `connect` → se loggea AC-7 shape.
   - Si hay error → `error` event → se loggea AC-8 shape, el proceso NO crashea.
8. Shutdown:
   - `SIGTERM` → `createShutdownHandler` → `app.close()`.
   - Fastify ejecuta el `onClose` hook → `client.quit()` → espera ACK de Redis.
   - Si `quit()` tarda más que `SHUTDOWN_GRACE_MS`, el `setTimeout` ya configurado en
     `shutdown.ts` force-exitea el proceso (AC-11 + DT-5).

### Flujo de test

1. `vitest` arranca con `NODE_ENV=test` y `LOG_LEVEL=silent` (del `vitest.config.ts`).
2. Cada `describe` block:
   - Llama `resetRedisClientForTests()` en `beforeEach` para invalidar el singleton
     (importante entre tests: vi.mock de ioredis puede producir instancias distintas).
   - Llama `vi.mock('ioredis', ...)` (hoisted) con un stub que registra constructor args
     y simula event handlers.
3. Test de singleton: llamar `getRedisClient()` dos veces, assertear `===`.
4. Test de null-return: inicializar con `env.redisUrl = undefined`, assertear `null`.
5. Test de redaction: llamar `redactRedisUrl('redis://user:pass@host:6379/0')` →
   asserte que `pass` NO aparece en el string resultante.
6. Test de retry: interceptar constructor args, assertear que `retryStrategy` está
   presente y que invocándola con `times=3` devuelve `800` (100·2³), con `times=20`
   devuelve `null` (corte por AC-9).
7. Ningún test abre socket TCP. `vi.mock('ioredis')` garantiza que no hay I/O real.

---

## 3. Codebase Grounding (archivos leídos + evidencia)

### Archivos leídos en este proyecto (wasiai-facilitator)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `CLAUDE.md` | Orquestación | QUALITY mode, gates HU_APPROVED/SPEC_APPROVED, OWNERS.md compliance |
| `OWNERS.md` | Module boundaries | `src/infra/` puede importar SDK clients (ioredis, pino), PROHIBIDO importar del resto de `src/*`. Eso valida CD-6 del work-item |
| `package.json` | Deps | `ioredis 5.4.1` presente; pino 9.5.0; zod 3.23.8; vitest 2.1.8; node >=20 |
| `tsconfig.json` | TS config | ESM Node16, `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess` — todo esto fuerza el shape `Redis \| null` en CD-3 |
| `vitest.config.ts` | Test config | `include: src/**/*.test.ts`, env `NODE_ENV=test` + `LOG_LEVEL=silent`. Coverage thresholds disabled (temporal WFAC-3) |
| `src/infra/env.ts` | Exemplar de schema Zod | Pattern `z.enum(...).default(...)`, `z.coerce.number()`, `parseEnv()` que hace `process.stderr.write()` + `process.exit(1)` en safeParse fail |
| `src/infra/logger.ts` | Exemplar logger | Pino factory `createLogger(env, destination?)`, soporta `DestinationStream` para tests. La instancia Fastify se obtiene vía `app.log` |
| `src/infra/shutdown.ts` | Exemplar shutdown | `createShutdownHandler({ app, graceMs, exit? })` ya ejecuta `await app.close()`. NO requiere modificación — la integración se hace vía Fastify `onClose` hook en `buildApp`. Esto resuelve el "Missing Input #2" del work-item |
| `src/app.ts` | Factory buildApp | `buildApp({ env?, rawEnv?, loggerDestination? })`. Aquí se registra la initialización Redis + el `onClose` hook |
| `src/index.ts` | Entry point | NO requiere cambios — `env.redisUrl` se propaga automáticamente porque ya se hace `parseEnv(process.env)` → `buildApp({ env })` |
| `src/core/types.ts` | Primitivas | `Result<T>` discriminated union existe pero NO se usa en infra layer (retornamos `Redis \| null`, no `Result<Redis>`). Nota: Redis no fallea con shape de dominio, falla con errors de conexión |
| `src/__tests__/setup.ts` | Setup global | Vacío, solo `export {}`. No hay hooks globales que pisen ioredis |
| `src/__tests__/unit/env.test.ts` | Exemplar test env | Pattern `vi.spyOn(process, 'exit').mockImplementation(...throw)` + `vi.spyOn(process.stderr, 'write')`. Lo replicamos para AC-2/AC-3 |
| `src/__tests__/unit/shutdown.test.ts` | Exemplar test shutdown | Fake `FastifyInstance` via `as unknown as FastifyInstance`. `vi.useFakeTimers()` para test de timeout. Lo replicamos en redis.test para el onClose hook |
| `src/__tests__/unit/logger.test.ts` | Exemplar `vi.mock` hoisted | `vi.mock('pino', () => { const factory = vi.fn(() => ({ info, error, ... })); return { default: factory } })`. MISMO pattern para ioredis, con cuidado de que `default` export es la clase Redis |
| `doc/sdd/_INDEX.md` | Registry | Esta HU ya está listada como "in progress" #004. Se cerrará a DONE al final |

### Exemplar cross-project (lectura únicamente — CD-6 OWNERS)

| Archivo | Qué se extrajo | Qué NO copiar |
|---------|----------------|----------------|
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/infra/` (si existe) | Pattern de singleton infra | N/A — a2a usa stack distinto |

*Nota*: no se leyó cross-project — el stack de wasiai-facilitator es independiente y OWNERS prohíbe cross-project imports.

### Auto-Blindaje histórico (lecciones aprendidas)

Leí `doc/sdd/001-wfac-2-fastify-bootstrap/auto-blindaje.md` y
`doc/sdd/003-wfac-4-chain-registry/auto-blindaje.md`. Hallazgos aplicables a esta HU:

| Hallazgo previo | HU | Cómo aplica a WFAC-5 | Tratamiento |
|-----------------|-----|----------------------|-------------|
| Tests con captura de logs fallan con `LOG_LEVEL=silent` global | WFAC-2 | AC-5/AC-7/AC-8 requieren verificar que el logger **sí loggea** algo. Los tests de URL redaction y event logging necesitarán un logger spy, no confiar en pino output | **CD-11 (nueva)**: los tests que verifiquen logging DEBEN inyectar un logger spy/mock, no leer stdout. El pino default se silencia por `LOG_LEVEL=silent` |
| `vi.resetModules()` invalida `instanceof ClassFromReloadedModule` | WFAC-4 | Si el test de redis.ts hace `resetModules()` entre tests para reejercitar el singleton, el `instanceof Redis` puede fallar por la misma razón | **CD-12 (nueva)**: PROHIBIDO usar `instanceof Redis` en los tests. Usar `.constructor.name === 'Redis'` o verificar por propiedades. Alternativa: exportar `resetRedisClientForTests()` que no requiere `resetModules` |
| Double `parseEnv` en bootstrap → Zod corre dos veces | WFAC-2 | Si hacemos que `getRedisClient()` llame `parseEnv` internamente, corremos dos veces. Solución: `initRedis(env, logger)` inyecta el env una sola vez | **DT-7** (nuevo): singleton `redis.ts` expone `initRedis(env, logger)` + `getRedisClient()`. `buildApp` invoca `initRedis` UNA vez; todos los callers posteriores usan `getRedisClient()` sin re-parsear |
| `security/detect-object-injection` en ESLint con index dinámico | WFAC-4 | No aplica — no usamos índices dinámicos en esta HU | — |
| Fastify v5 emite logs "Server listening at..." que rompen assertions literales | WFAC-2 | No aplica directamente, pero recordá que Fastify puede emitir logs inesperados. Para AC-7/AC-8 NO asseramos "primera línea", asseramos "alguna línea con este shape" | Incorporado en Test Plan |

### Lectura obligatoria en `node_modules/` (post-cutoff)

| Path | Verificado | Hallazgo concreto |
|------|-----------|------------------|
| `node_modules/ioredis/package.json` | Sí | Version `5.4.1`; main/types `./built/index.js` / `./built/index.d.ts` |
| `node_modules/ioredis/built/index.d.ts` | Sí | Default export = `Redis` class. Named: `{ Redis, Cluster, RedisOptions, CommonRedisOptions, ... }`. Import canónico: `import Redis from 'ioredis'` (default) o `import { Redis } from 'ioredis'` (named) |
| `node_modules/ioredis/built/Redis.d.ts` | Sí | Constructor signatures relevantes: `constructor(options: RedisOptions)` / `constructor(path: string, options: RedisOptions)` (URL variant). **Usaremos `new Redis(url, options)`** — firma soportada. Events: `'connect'`, `'ready'`, `'close'`, `'error'`, `'reconnecting'`, `'end'`. Método `quit(): Promise<'OK'>`. Método `disconnect(reconnect?: boolean): void` |
| `node_modules/ioredis/built/redis/RedisOptions.d.ts` | Sí | Confirma: `retryStrategy?: ((times: number) => number \| void \| null)`, `maxRetriesPerRequest?: number \| null`, `enableReadyCheck?: boolean`, `lazyConnect?: boolean`, `db?: number`, `connectionName?: string`, `connectTimeout?: number` (default 10000ms). ioredis 5 ya NO requiere `family: 4` explícito |
| `node_modules/ioredis/built/redis/event_handler.d.ts` | Sí | Confirma que los event handlers existen — pero son `@ignore` internos. Nosotros usamos la interfaz pública `client.on('connect' \| 'error', ...)` |

---

## 4. Exemplar Verification (paths confirmados)

| Path | Verificación | Patrón extraído |
|------|--------------|-----------------|
| `src/infra/env.ts` | `Read` OK, 40 líneas | Patrón Zod `z.object({...})` + `parseEnv(raw)` con `safeParse` + stderr + `exit(1)` |
| `src/infra/logger.ts` | `Read` OK, 32 líneas | Patrón `createLogger(env, destination?)`. Retorna `Logger`. En test/prod: JSON |
| `src/infra/shutdown.ts` | `Read` OK, 64 líneas | Patrón `createShutdownHandler({ app, graceMs, exit? })`. Usa `app.log.error` y `app.close()`. NO se modifica |
| `src/app.ts` | `Read` OK, 52 líneas | Patrón `buildApp(options)` con `options.env?: EnvConfig`. `await app.register(...)` post-logger. Aquí se inserta `initRedis(env, logger)` y `app.addHook('onClose', ...)` |
| `src/index.ts` | `Read` OK, 72 líneas | Entry point. NO se modifica (env.redisUrl se propaga automáticamente) |
| `src/core/types.ts` | `Read` OK, 66 líneas | `Result<T>` para service layer. NO se usa en esta HU (infra retorna `Redis \| null`) |
| `src/__tests__/unit/env.test.ts` | `Read` OK, 43 líneas | Pattern mock `process.exit`/`process.stderr.write` |
| `src/__tests__/unit/logger.test.ts` | `Read` OK, 92 líneas | Pattern `vi.mock('pino', () => { factory })` con `vi.resetModules()` y `await import(...)` dinámico |
| `src/__tests__/unit/shutdown.test.ts` | `Read` OK, 88 líneas | Pattern fake app `as unknown as FastifyInstance`, `vi.useFakeTimers()` |
| `.env.example` | `Read` OK | Ya contiene `REDIS_URL=redis://localhost:6379` en línea 49. Agregamos `REDIS_DB=0` con comentario |
| `vitest.config.ts` | `Read` OK | `env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' }` — no requiere cambios |
| `tsconfig.json` | `Read` OK | `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`. CD-3 (`Redis \| null`) está enforced por el typechecker |
| `OWNERS.md` | `Read` OK | `src/infra/` puede importar ioredis; NO puede importar de `src/core/*`. Confirma CD-6 del work-item |

Ningún path mencionado en el SDD fue inventado. Los que NO existen todavía (creados por esta HU):

- `src/infra/redis.ts` → CREATE
- `src/__tests__/unit/redis.test.ts` → CREATE

---

## 5. Decisiones Técnicas (DT-N)

### DT-1 — Singleton module-level, inicialización diferida con `initRedis(env, logger)`

`src/infra/redis.ts` expone tres funciones:

```ts
let _client: Redis | null = null;
let _env: EnvConfig | null = null;
let _logger: Logger | null = null;
let _initialized = false;

export function initRedis(env: EnvConfig, logger: Logger): void { /* guarda refs */ }
export function getRedisClient(): Redis | null { /* crea _client la 1ra vez */ }
export function resetRedisClientForTests(): void { /* invalida todo */ }
export function redactRedisUrl(url: string): string { /* pure, exportado para tests */ }
```

**Por qué dos funciones**: `initRedis` hace la inyección de dependencias (env + logger) una
sola vez en `buildApp`. `getRedisClient` es el punto de acceso público que los futuros
consumidores (WFAC-21, WFAC-40, WFAC-42) van a usar sin preocuparse por env/logger. Esto
evita la trampa de la HU-2 (double parseEnv) y mantiene los tests simples: reset + init.

**Por qué no clase**: una clase con `.getInstance()` requiere que todos los callers
conozcan la clase; además TypeScript + ESM + singletons de clase tienen edge cases con
`vi.resetModules()` (ver auto-blindaje WFAC-4). Module-level variables + funciones
nombradas es el patrón más alineado con el resto de la infra (`createLogger`,
`createShutdownHandler`, `parseEnv` — todos son funciones, no clases).

### DT-2 — `lazyConnect: true` obligatorio (+ `enableReadyCheck: false`)

`lazyConnect: false` (default de ioredis) abre el socket TCP en el constructor. En
`NODE_ENV=test`, incluso con el mock, pasarlo a `true` simplifica el razonamiento: el
constructor NUNCA hace I/O. El primer comando o un `.connect()` explícito dispara la
conexión. Esto hace trivialmente segura la siguiente regla: *si `getRedisClient()` se
llama en un contexto donde no queremos conexión (e.g., importar el módulo en un archivo
que arranca tests), no hay efectos laterales*.

`enableReadyCheck: false` es necesario porque el ready check corre `INFO` al conectar y
con `lazyConnect` no se ejecuta hasta el primer comando real. Mantenerlo en `false` hace
el ciclo connect → ready directo, sin latencia adicional. Alineado con work-item AC-4.

### DT-3 — Redacción de URL localmente con `new URL(...)` + reemplazo de `.password`

```ts
export function redactRedisUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '*';
    if (u.username) u.username = '*';
    return u.toString();
  } catch {
    // raw no es URL válida (no debería ocurrir post Zod); redactá agresivo
    return 'redis://***';
  }
}
```

**Por qué `new URL`**: Node 20 expone WHATWG URL. Parsea `redis://user:pass@host:6379/0`
correctamente, y `u.toString()` re-serializa con el password reemplazado. Aliasing de
estilo `u.pathname` queda intacto (mantenemos `/0` visible — ayuda a debug).

**Por qué `catch` con fallback agresivo**: defensa en profundidad. Si Zod aprueba la URL
(porque aprueba cualquier `z.string().min(1)`), pero luego alguien le pasa un string malformado,
no queremos filtrar el password por un parse error. Mejor perder info útil que exponer.

**AC-13 requiere exportar esta función** para que los tests puedan ejercitar la redaction
con inputs conocidos.

### DT-4 — Retry strategy: exponential backoff con floor 100ms, cap 3s, max 10 intentos

```ts
function redisRetryStrategy(times: number): number | null {
  if (times > 10) return null;             // dar up → error final
  return Math.min(100 * 2 ** times, 3000); // 100, 200, 400, 800, 1600, 3000, 3000, ...
}
```

`times=1` → 200ms (primera reconnect attempt después del primer error).
`times=10` → 3000ms (cap alcanzado).
`times=11` → `null` → ioredis emite error final.

**Por qué cap 3000ms**: si un Redis está en flap (reboot/fail), no queremos esperar 60s
entre intentos. 3s × 10 = 30s total en el peor caso, menos que `SHUTDOWN_GRACE_MS=10000`
si el worst-case coincide con un SIGTERM. Alineado con circuit breaker (WFAC-41) que
vendrá después.

**Por qué devolver `null` (no `undefined`, no `0`)**: la signature ioredis v5 es
`(times) => number | void | null`. `null` es el término oficial de "no more retries,
emit final error" (confirmado en `RedisOptions.d.ts` línea 8). Usamos `number | null` en
nuestra firma TS explícita (no `void`) para claridad.

### DT-5 — `redis.quit()` en `onClose` hook, NO modificar `shutdown.ts`

El ciclo actual de `shutdown.ts` ya hace `await app.close()`. La manera idiomática en
Fastify v5 de agregar cleanup es registrar `app.addHook('onClose', async () => {...})`
durante `buildApp`. Fastify garantiza que TODOS los `onClose` hooks completan antes de
que `app.close()` resuelva.

**Por qué NO tocar shutdown.ts**:

1. Mantiene la separación de responsabilidades: `shutdown.ts` no sabe de Redis ni de
   ningún recurso específico. Es un orquestador.
2. Futuras HUs (WFAC-32 Supabase, WFAC-42 BullMQ) van a agregar sus propios cleanup
   hooks. Si cada uno modifica `shutdown.ts` → acoplamiento creciente. Mejor cada
   módulo registra su `onClose` en su initializer.
3. Tests de `shutdown.ts` (ya existentes) siguen válidos sin cambios.

**Null-guard en el hook**: si `getRedisClient()` retorna `null` (test env), el hook hace
`return` temprano. Si `quit()` rechaza → capturamos con `try/catch`, loggeamos y
continuamos (AC-11). El hook NUNCA deja que el shutdown se cuelgue.

**Nota sobre el "Missing Input #2" del work-item** (comportamiento de `shutdown.ts` cuando
client es `null`): **resuelto vía encapsulación**. `shutdown.ts` NO toca Redis directamente.
El null-guard vive dentro del hook `onClose` registrado por `buildApp`.

### DT-6 — Env schema: `REDIS_URL` opcional condicional + test-only behavior

**Opción elegida**: `superRefine` post-safeParse en `parseEnv`, NO mezclar la lógica en la
definición del schema.

```ts
// src/infra/env.ts (shape final)
export const EnvSchema = z.object({
  NODE_ENV: z.enum([...]).default('development'),
  PORT: z.coerce.number()...,
  LOG_LEVEL: z.enum([...]).default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number()...,
  REDIS_URL: z.string().min(1).optional(),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
}).superRefine((data, ctx) => {
  if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required when NODE_ENV is not "test"',
    });
  }
});
```

**Por qué `superRefine`**: el `.transform` propuesto en DT-6 del work-item no tiene acceso
a `ctx.data` (la firma de Zod `z.string().optional().transform((val, ctx))` pasa `val, ctx`
donde `ctx.addIssue` sí existe pero `ctx.data` NO es parte de la API pública). `superRefine`
a nivel del objeto sí ve todos los campos — es la API designed para cross-field validation.

**Shape final de EnvConfig**:

```ts
export type EnvConfig = z.infer<typeof EnvSchema>;
// {
//   NODE_ENV: 'development' | 'test' | 'production';
//   PORT: number;
//   LOG_LEVEL: 'fatal' | ... | 'silent';
//   SHUTDOWN_GRACE_MS: number;
//   REDIS_URL: string | undefined;  // <- optional
//   REDIS_DB: number;               // <- default 0
// }
```

**Por qué exponer `REDIS_URL` en UPPER_CASE en el tipo (no camelCase)**: mantener
consistencia con el resto del schema actual (`NODE_ENV`, `PORT`, `LOG_LEVEL` — todos
UPPER_CASE). El work-item usa `redisUrl: string` pero eso era shorthand del Analyst; el
Architect elige mantener `REDIS_URL: string | undefined` para no romper la convención.

**Nota sobre REDIS_DB**: el work-item no lo menciona en los ACs, pero el prompt de la
tarea lo requiere. Lo agregamos como optional con default `0` — NO bloqueante de ningún AC,
pero necesario para que futuras HUs (WFAC-21/42) no tengan que re-parsear. Tratado como
"additive beyond work-item" — documentado aquí, no conflictúa con CDs.

### DT-7 — Inyección de dependencias via `initRedis(env, logger)` llamado desde `buildApp`

Relacionado con DT-1: el módulo `src/infra/redis.ts` NO importa `parseEnv` ni
`createLogger` — recibe ambos via `initRedis(env, logger)`. Esto tiene tres ventajas:

1. **No re-parse**: `env` ya fue validado por `parseEnv` en `index.ts`. `redis.ts` no
   vuelve a correr Zod (lección de WFAC-2 auto-blindaje).
2. **Test isolation**: el test file puede llamar `initRedis(fakeEnv, fakeLogger)` sin
   tocar `process.env` ni importar el logger real.
3. **OWNERS compliance**: `src/infra/redis.ts` importa SOLO `ioredis` + `pino` types. NO
   importa `src/infra/env.ts` ni `src/infra/logger.ts` — los tipos (`EnvConfig`, `Logger`)
   vienen via type-only imports que NO generan runtime deps.

```ts
// redis.ts
import type { EnvConfig } from './env.js';   // type-only, OK per OWNERS
import type { Logger } from 'pino';          // type-only, OK
import Redis from 'ioredis';
```

`initRedis` es **idempotente dentro de un mismo proceso** (llamarlo dos veces con el
mismo env es no-op). Esto es importante porque los tests que hacen `buildApp()` dos veces
no deben romper.

---

## 6. Constraint Directives (CD-N)

Los CDs 1-10 heredados del work-item quedan activos. Agregamos 2 más a partir del
análisis de codebase y del auto-blindaje histórico:

### CDs heredados del work-item (mantener literal)

- **CD-1**: No loggear `REDIS_URL` sin redactar. Violación → BLOQUEANTE.
- **CD-2**: Solo `src/infra/redis.ts` puede hacer `new Redis(...)`. Otros módulos importan
  `getRedisClient()`.
- **CD-3**: `getRedisClient()` retorna `Redis | null` (no `undefined`, no `Redis`, no `any`).
- **CD-4**: Registrar `client.on('error', ...)` inmediatamente tras construir.
- **CD-5**: No usar ioredis en modo Cluster/Sentinel (V1.5+).
- **CD-6**: OWNERS compliance — `redis.ts` solo importa `ioredis` y (type-only) EnvConfig/Logger.
- **CD-7**: PROHIBIDO `console.log` en `redis.ts`. Solo Pino logger inyectado.
- **CD-8**: `shutdown.ts` quit de Redis antes de `process.exit(0)` → ahora resuelto vía
  `onClose` hook registrado en `buildApp` (DT-5). Equivalente semántico.
- **CD-9**: `redis.test.ts` corre sin live Redis (mocks obligatorios).
- **CD-10**: PROHIBIDO hardcode de `redis://localhost:6379` en `src/`. Solo `.env.example`
  y `vi.mock('ioredis')` pueden referenciarlo.

### CDs nuevos (del análisis de codebase)

- **CD-11 (nuevo, lección de WFAC-2 auto-blindaje)**: OBLIGATORIO que los tests que
  verifiquen logging usen un logger spy/mock inyectado vía `initRedis(env, fakeLogger)`.
  PROHIBIDO depender de la captura de stdout/pino destination (el default de
  `LOG_LEVEL=silent` en vitest lo rompe). Violación → CR BLOQUEANTE.

- **CD-12 (nuevo, lección de WFAC-4 auto-blindaje)**: PROHIBIDO en `redis.test.ts` usar
  `vi.resetModules()` combinado con `instanceof Redis`. Si es estrictamente necesario
  resetear, hacerlo via la función `resetRedisClientForTests()` exportada, que NO requiere
  resetear el módulo. Violación → CR BLOQUEANTE.

---

## 7. Waves de implementación

| Wave | Objetivo | Archivos | Bloqueo |
|------|----------|----------|---------|
| **W0** (serial) | Env schema: `REDIS_URL` optional + `superRefine` + `REDIS_DB` | `src/infra/env.ts` | Debe pasar W0 antes de W1. Tests de `env.test.ts` existentes no deben romperse |
| **W1** (serial) | `src/infra/redis.ts`: singleton + redaction + retry + event handlers | `src/infra/redis.ts` (CREATE) | Requires W0 (usa `EnvConfig.REDIS_URL`) |
| **W2** (serial) | Integración con `buildApp` (`initRedis` + `onClose` hook) | `src/app.ts` | Requires W1 (llama `initRedis`). NO modifica `shutdown.ts` |
| **W3** (serial) | Tests + `.env.example` + `npm run qa` green | `src/__tests__/unit/redis.test.ts` (CREATE), `.env.example` | Requires W2 |

### Detalle por wave

**W0 — Env schema**

- Modificar `src/infra/env.ts`:
  - Agregar `REDIS_URL: z.string().min(1).optional()`.
  - Agregar `REDIS_DB: z.coerce.number().int().min(0).max(15).default(0)`.
  - Agregar `.superRefine((data, ctx) => { ... })` al objeto para el cross-field check
    de AC-2/AC-3.
- Verificar que `EnvConfig` inferido tiene `REDIS_URL: string | undefined` y `REDIS_DB: number`.
- Los 4 tests existentes en `env.test.ts` deben seguir pasando (no tocan REDIS_URL).
- Agregar 3 tests nuevos en `env.test.ts` (mismo archivo, coherente con pattern actual):
  - AC-1: `parseEnv({ NODE_ENV: 'production', REDIS_URL: 'redis://x:6379' })` → `REDIS_URL` presente.
  - AC-2: `parseEnv({ NODE_ENV: 'production' })` (sin REDIS_URL) → exit(1) + stderr contains `REDIS_URL`.
  - AC-3: `parseEnv({ NODE_ENV: 'test' })` (sin REDIS_URL) → NO exit, `REDIS_URL` es `undefined`.

**W1 — Redis client singleton**

- Crear `src/infra/redis.ts` con:
  - Imports: `import Redis from 'ioredis'; import type { EnvConfig } from './env.js'; import type { Logger } from 'pino';`
  - Module-level state: `_client`, `_env`, `_logger`, `_initialized`.
  - `export function initRedis(env, logger): void` — idempotent.
  - `export function getRedisClient(): Redis | null` — crea cliente la 1ra vez, retorna null si env test + no URL.
  - `export function redactRedisUrl(raw: string): string` — pure.
  - `export function resetRedisClientForTests(): void` — solo para tests (nombre auto-explica el scope).
  - Handlers `.on('connect', ...)` y `.on('error', ...)` registrados inmediatamente tras construcción.
  - Retry strategy inline como function, no flecha (para tener `.name` en stack traces).
- **Nunca** invocar `console.*`. Usar `_logger.info(...)`, `_logger.error(...)`, `_logger.warn(...)`.
- Loggear redacted URL una sola vez, al construir el cliente (no en cada `getRedisClient()`).

**W2 — Integración buildApp**

- Modificar `src/app.ts`:
  - Import `initRedis, getRedisClient` desde `./infra/redis.js`.
  - Después de `const logger: FastifyBaseLogger = createLogger(env, options.loggerDestination);`:
    - `initRedis(env, logger as Logger);` (cast estructural aceptable — `FastifyBaseLogger`
      tiene todas las methods que `redis.ts` usa: `.info`, `.error`, `.warn`).
    - Alternativa sin cast: inyectar un shim `{ info, error, warn }` tipado como
      `Pick<Logger, 'info' | 'error' | 'warn'>` — Architect prefiere esta opción por
      zero-cast. Evaluar en F3.
  - Antes de `return app`:
    ```ts
    app.addHook('onClose', async () => {
      const client = getRedisClient();
      if (!client) return;
      try {
        await client.quit();
      } catch (err: unknown) {
        logger.error({ err }, 'Redis quit failed during shutdown');
      }
    });
    ```
- NO modificar `src/index.ts`, NO modificar `src/infra/shutdown.ts` (DT-5).

**W3 — Tests + doc + qa**

- Crear `src/__tests__/unit/redis.test.ts` con los tests de sección 8.
- Modificar `.env.example`: agregar `REDIS_DB=0` con comentario al lado de `REDIS_URL`
  (línea 49).
- Correr `npm run qa`. Todo verde.
- Correr `npm run build`. Sin errores.

---

## 8. Plan de tests (≥1 test por AC)

Tests en `src/__tests__/unit/redis.test.ts` (mockeando `ioredis`) más 3 tests adicionales
en `src/__tests__/unit/env.test.ts` (cubren AC-1/2/3 del schema).

### Tests de env schema (en `env.test.ts`)

| AC | Test | Setup | Assert |
|----|------|-------|--------|
| AC-1 | `parseEnv returns REDIS_URL when present in prod env` | `{ NODE_ENV: 'production', REDIS_URL: 'redis://h:6379' }` | `result.REDIS_URL === 'redis://h:6379'` |
| AC-2 | `parseEnv exits with code 1 and stderr includes REDIS_URL when absent in prod` | `{ NODE_ENV: 'production' }` (no REDIS_URL), mock `process.exit`/`process.stderr.write` | `exitSpy` llamado con `1`, stderr contiene `'REDIS_URL'` |
| AC-3 | `parseEnv does not exit when REDIS_URL absent in test env` | `{ NODE_ENV: 'test' }` | `result.REDIS_URL === undefined`, exit NO llamado |

### Tests de redis client (en `redis.test.ts`)

| AC | Test | Setup | Assert |
|----|------|-------|--------|
| AC-4 | `getRedisClient returns same instance on repeated calls` | mock ioredis default; `initRedis(envWithUrl, fakeLogger)`; `const a = getRedisClient(); const b = getRedisClient();` | `a === b`, `RedisMock` llamado exactamente 1 vez |
| AC-4 (config) | `Redis constructor called with lazyConnect true, maxRetriesPerRequest 3, enableReadyCheck false` | idem + inspect mock constructor args | `args[1].lazyConnect === true`, `args[1].maxRetriesPerRequest === 3`, `args[1].enableReadyCheck === false` |
| AC-5 | `redactRedisUrl masks password component` | `redactRedisUrl('redis://user:secret123@host:6379/0')` | resultado NO contiene `'secret123'`; sí contiene `'host:6379'`; password reemplazado por `'*'` |
| AC-5 (log) | `init logs redacted URL at info level on first creation` | `initRedis(envWithPasswordUrl, fakeLogger)`; `getRedisClient()` | `fakeLogger.info` llamado con objeto que tiene `url` sin el password; `msg` menciona `'Redis client instantiated'` o shape equivalente |
| AC-6 | `getRedisClient returns null when REDIS_URL is undefined in test env` | `initRedis({...env, NODE_ENV: 'test', REDIS_URL: undefined}, fakeLogger)` | `getRedisClient() === null`, `RedisMock` NO llamado |
| AC-7 | `on connect event, logger.info is called with msg "Redis connected" + host/port` | init + `getRedisClient()` + invocar manualmente el `connect` handler registrado | `fakeLogger.info` llamado con `{ host, port }` + msg `'Redis connected'` |
| AC-8 | `on error event, logger.error is called and process does not throw` | init + getClient + invocar `error` handler con `new Error('ECONNREFUSED')` | `fakeLogger.error` llamado con `{ err }` + msg `'Redis error'`; el test NO observa unhandled rejection |
| AC-9 | `retryStrategy returns correct backoff values and null at cap` | Inspect mock constructor args, llamar `args[1].retryStrategy(0..11)` | `f(0) === 100`, `f(1) === 200`, `f(5) === 3000` (capped), `f(10) === 3000`, `f(11) === null` |
| AC-9 (log) | `logs "Redis connection failed permanently" when retries exhausted` | Invocar retryStrategy con `times=11`; verificar que el mock retornó null | `retryStrategy(11) === null`. Nota: el log concreto lo emite ioredis internamente — validamos via el `error` handler de AC-8, que se emite cuando retries se agotan |
| AC-10 | `app.close() triggers onClose hook that calls client.quit()` | buildApp con env redis válido + mock ioredis; invocar `app.close()`; inspect mock `quit` | `quitMock` llamado exactamente 1 vez antes de que `close()` resuelva |
| AC-11 | `if quit() rejects, logger.error is called and close still resolves` | mock `quit: vi.fn().mockRejectedValue(new Error('boom'))`; `await app.close()` | `close()` resuelve sin throw; `logger.error` llamado con `{ err }` |
| AC-12 | *(out of scope)* | Este AC vive en `src/core/idempotency.ts` (WFAC-21). Esta HU NO lo implementa. El SDD registra la cobertura esperada pero el test se escribe en WFAC-21 | N/A aquí — verificar que el work-item de WFAC-21 referencie este SDD |
| AC-13 | `npm run test passes without live Redis` | ejecutar `npm run test` localmente | Exit 0; ninguna suite require conexión TCP |
| AC-14 | `getRedisClient return type is Redis \| null (compile-time)` | en el test: `const c: Redis \| null = getRedisClient(); type _T = typeof c; const _check: Redis \| null = c;` — si cambia el tipo, typecheck rompe | Implícito: `npm run typecheck` exit 0 |

**Tests adicionales no-AC (hardening sugerido)**:

- `resetRedisClientForTests clears state so next init creates a fresh mock instance` — verifica la API de test helper.
- `calling initRedis twice with same env is idempotent (does not create two clients)` — previene bug de race en double-boot.

### Cobertura del mock de `ioredis`

```ts
// tests/unit/redis.test.ts header (shape)
vi.mock('ioredis', () => {
  const constructorSpy = vi.fn();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  class RedisMock {
    options: Record<string, unknown>;
    constructor(url: string, opts: Record<string, unknown>) {
      constructorSpy(url, opts);
      this.options = opts;
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      return this;
    }
    quit(): Promise<'OK'> { return Promise.resolve('OK'); }
    __emit(event: string, ...args: unknown[]): void {
      (listeners.get(event) ?? []).forEach((h) => h(...args));
    }
  }
  return {
    default: RedisMock,
    Redis: RedisMock,
    __spy: constructorSpy,
  };
});
```

Este shape garantiza:

- Constructor observable (`__spy.mock.calls`).
- Event handlers registrables y simulables (`__emit('connect')`).
- `quit()` observable y override-able por test (via `vi.mocked`).
- Cero I/O real.

---

## 9. Readiness Check

- [x] Todos los exemplars verificados con Read/Glob.
- [x] Todos los CDs del work-item heredados + 2 nuevos (CD-11 CD-12) documentados.
- [x] Los 14 ACs mapeados a waves y tests explícitos (AC-12 documentado como out-of-scope con referencia a WFAC-21).
- [x] Missing Inputs del work-item resueltos:
  - #1 ioredis API → verificado en `node_modules/ioredis/built/*.d.ts` (sección 3 y 4).
  - #2 Comportamiento `shutdown.ts` con null → resuelto encapsulando en `onClose` hook, no tocar shutdown.ts (DT-5).
  - #3 Zod `.superRefine` vs `.transform` → elegido `.superRefine` a nivel de objeto (DT-6).
- [x] Stack confirmado: ioredis 5.4.1, pino 9.5.0, zod 3.23.8, vitest 2.1.8, Node ≥20.
- [x] OWNERS compliance: `src/infra/redis.ts` imports solo `ioredis` + type-only from `env`/`pino` (CD-6).
- [x] No `console.*` en `redis.ts` (CD-7).
- [x] Tests corren sin live Redis (mock) (CD-9).
- [x] `[NEEDS CLARIFICATION]` markers: **CERO**.
- [x] Lecciones del Auto-Blindaje de WFAC-2 y WFAC-4 incorporadas como CD-11/CD-12 y DT-7.

**SDD is ready for SPEC_APPROVED gate.**

---

## 10. Risks

| # | Risk | Severidad | Mitigación |
|---|------|-----------|------------|
| R1 | ioredis 5.x API drift vs Architect expectations (post-cutoff) | Media | Mitigado por lectura directa de `node_modules/ioredis/built/*.d.ts` en F2. El Dev DEBE volver a leer estos archivos en F3 antes de codear. Story File §10 (read-first) garantiza esto |
| R2 | Connection leak: el singleton queda vivo entre tests, acumulando listeners o sockets | Media | `resetRedisClientForTests()` exportado. Cada `describe` hace `beforeEach(() => resetRedisClientForTests())`. Con `lazyConnect: true` no hay socket hasta el primer comando real, pero los event handlers sí se acumulan sin reset |
| R3 | Password leak en logs vía stack traces o serialización de RedisOptions en errores | Alta | Doble defensa: (1) CD-1 redacción en el módulo, (2) CD-11 tests verifican que ningún `logger.info/error/warn` mock recibe una string que contenga el password plaintext, (3) TD-01-04 (WFAC-31) agregará Pino `redact` config global para futuro hardening |
| R4 | Connection retry storm: si muchos clientes llaman `getRedisClient()` durante un outage, todos disparan reconnect simultáneo → thundering herd | Media | Mitigado por el singleton: hay UNA sola instancia ioredis. Además `maxRetriesPerRequest: 3` corta comandos después de 3 intentos. El `retryStrategy` es a nivel conexión (no por comando) y está capped en 10 intentos → max 30s antes de fail definitivo |
| R5 | Fastify `onClose` hook order: si hay otros hooks que también hacen I/O, el orden de ejecución puede importar | Baja | Fastify v5 ejecuta hooks en LIFO (último registrado, primero en correr). El hook Redis se registra en `buildApp` ANTES de cualquier consumer — por tanto corre DESPUÉS de cualquier hook que un consumer registre (consumer cleanup primero, Redis quit al final). Esto es correcto: los consumers pueden querer emitir comandos durante su cleanup |
| R6 | `env.test` con `REDIS_URL` definido accidentalmente en CI → los tests que asumen `null` path fallarían | Baja | Los tests usan `vi.mock('ioredis')` + pasan `fakeEnv` con `REDIS_URL: undefined` explícito vía `initRedis()` — no leen `process.env`. CI está seguro |

---

## 11. Dependencies

### Deps nuevas (package.json)

- Ninguna. `ioredis@^5.4.1` ya instalado.

### Deps runtime importadas

- `ioredis` (default import, named `Redis`).
- `pino` (solo type-only import de `Logger`).

### Deps dev

- `vitest` (ya instalado).

### Downstream dependencies unlocked

- WFAC-21 (settlement idempotency) — unblocked.
- WFAC-40 (distributed rate-limit) — unblocked.
- WFAC-42 (BullMQ queue) — unblocked.

### Upstream dependencies

- WFAC-2 (Fastify bootstrap) — DONE (merged).
- WFAC-4 (chain registry) — DONE (merged). Esta HU no depende técnicamente, pero el repo
  está en `main@f93a97b` post-WFAC-4.

---

## 12. Missing Inputs (resolved)

| Item | Resolución |
|------|-----------|
| ioredis 5.x API signatures | Confirmado vía `node_modules/ioredis/built/index.d.ts` + `Redis.d.ts` + `redis/RedisOptions.d.ts`. API estable, constructor `new Redis(url, options)` soportado, `retryStrategy` signature es `(times: number) => number \| void \| null` |
| shutdown.ts behavior con null client | **NO modificamos shutdown.ts**. El null-guard vive en el hook `onClose` dentro de `buildApp` (DT-5). Si client es null → hook retorna temprano. Zero cambios a la unidad probada en WFAC-2 |
| Zod `.superRefine` vs `.transform` | **Elegido `.superRefine`** a nivel del objeto (no a nivel del field) — tiene acceso a todos los campos para cross-field validation. Ver DT-6 |

---

## 13. Uncertainty Markers

**Ninguno activo.** Todas las uncertainties del work-item fueron resueltas en DT-5/DT-6/DT-7
y en sección 3 (grounding). Si durante F3 el Dev encuentra un caso no cubierto, debe
parar y escalar al humano via el orquestador (no implementar por libre — CD del skill).

---

## 14. Notas adicionales

### Sobre la firma `(env, logger)` de `initRedis`

La decisión de pasar `logger: Logger` (tipo Pino) vs `FastifyBaseLogger` merece
aclaración. En W2 el call site es:

```ts
const logger: FastifyBaseLogger = createLogger(env, options.loggerDestination);
// ...
initRedis(env, logger as Logger);  // cast estructural
```

**`FastifyBaseLogger` es estructuralmente compatible con un subset de `Logger` de Pino**
(tiene `.info`, `.error`, `.warn`, `.fatal`, `.trace`, `.debug`). El cast `as Logger` es
cosmetic — funciona, pero prefiero una alternativa sin cast:

**Opción preferida** (a implementar en F3): definir la firma de `initRedis` como:

```ts
type RedisLogger = Pick<Logger, 'info' | 'error' | 'warn'>;
export function initRedis(env: EnvConfig, logger: RedisLogger): void { ... }
```

Y en `app.ts`:

```ts
initRedis(env, logger);  // FastifyBaseLogger satisface Pick<Logger, 'info' | 'error' | 'warn'>
```

Esto evita el cast y es más explícito sobre qué methods del logger usa redis.ts.

**El Dev elige entre las dos opciones en F3**, justificando en el PR. Preferencia del
Architect: opción sin cast (RedisLogger = Pick<...>).

### Sobre el test de AC-7 (connect event)

Con `lazyConnect: true`, el event `connect` solo se emite cuando un caller explícitamente
llama `client.connect()` o envía un comando. En los tests, **simulamos** esa emisión
llamando al handler registrado manualmente (`mockInstance.__emit('connect')`). Esto NO
prueba que ioredis mismo emita el evento en producción (eso es contrato de la librería,
no responsabilidad nuestra), pero SÍ prueba que **nuestro handler responde correctamente
cuando el evento se dispara** — que es la responsabilidad de esta HU.

### Sobre AC-12 (warning de in-memory fallback)

Este AC vive en `src/core/idempotency.ts`, archivo que NO se crea en esta HU (está en
Scope OUT explícito). La implementación de AC-12 se hace en WFAC-21. Sin embargo, la API
de `getRedisClient(): Redis | null` que esta HU entrega es **la condición necesaria** para
que WFAC-21 pueda implementar AC-12 (el caller necesita un `null` check para saber cuándo
loggear el fallback). El SDD registra explícitamente que AC-12 no es responsabilidad de
esta HU, y que la validación real correrá en WFAC-21.

### Sobre la creación del branch

El branch `feat/004-wfac-5-redis-client` debe crearse desde `main@f93a97b` (commit actual).
Si ya existe, verificar que esté sincronizado con `main`:

```bash
git checkout main
git pull origin main
git checkout -b feat/004-wfac-5-redis-client
# o: git checkout feat/004-wfac-5-redis-client && git rebase main
```

---

## 15. Implementation Readiness Check (pre-F3)

Antes de que el Dev empiece W0 en F3, esta lista DEBE estar 100% verde:

- [x] `doc/sdd/004-wfac-5-redis-client/sdd.md` escrito (este archivo).
- [ ] Story File `story-WFAC-5.md` generado (F2.5 — próximo paso).
- [ ] Humano aprobó el SDD con texto literal `SPEC_APPROVED`.
- [x] Branch base identificado (`main@f93a97b`).
- [x] Deps verificadas (ioredis 5.4.1 instalado).
- [x] Exemplars accesibles (todos los Read OK en sección 4).
- [x] Zero `[NEEDS CLARIFICATION]` en todo el SDD.
- [x] Waves ordenadas y con archivos exactos por wave.
- [x] Tests mapeados a ACs (sección 8).
- [x] Risks identificados y mitigados (sección 10).
- [x] Auto-Blindaje histórico leído y aplicado (CD-11 / CD-12 / DT-7).

El Dev solo avanza a F3 DESPUÉS de SPEC_APPROVED humano.
