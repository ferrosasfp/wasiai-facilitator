# Work Item — [WFAC-5] Redis Client — Idempotency Cache Foundation

## Metadata

| Campo | Valor |
|-------|-------|
| **HU-ID** | WFAC-5 |
| **NNN** | 004 |
| **Slug** | `redis-client` |
| **Jira** | https://ferrosasfp.atlassian.net/browse/WFAC-5 |
| **Épica** | E1 — Core Infrastructure |
| **Fecha** | 2026-04-22 |
| **Branch sugerido** | `feat/004-wfac-5-redis-client` |
| **Autor** | nexus-analyst (F0+F1) |

---

## Resumen

Implementar el singleton ioredis y su integración con la infra existente: extensión del Zod env
schema con `REDIS_URL`, registro del `quit()` en el shutdown handler, y un módulo
`src/infra/redis.ts` que exponga el cliente de forma lazy-connectable para entornos de test.
Este módulo es la fundación bloqueante de WFAC-21 (idempotency check en /settle),
WFAC-40 (rate-limit Redis-backed) y WFAC-42 (BullMQ queue). Sin él, ninguna de esas tres HUs
puede implementarse.

---

## Contexto de negocio

wasiai-facilitator requiere idempotencia en el flujo de settlement: si un cliente retransmite
el mismo payload (por timeout de red, etc.) el facilitator DEBE devolver el resultado previo
sin re-ejecutar la tx on-chain. Redis es el backend de ese cache (TTL 120s por spec x402).
Adicionalmente, el rate-limit distribuido (WFAC-40) y la cola BullMQ (WFAC-42) usan el mismo
cliente Redis. Esta HU construye la única instancia del cliente — infraestructura pura, sin
lógica de negocio. La severidad es alta: un mal manejo del ciclo de vida de conexión puede
generar file descriptor leaks o bloquear el graceful shutdown del proceso.

---

## Sizing

| Campo | Valor |
|-------|-------|
| **SDD_MODE** | full |
| **Clasificación** | QUALITY |
| **Estimación** | M |
| **Skills** | `infra-node`, `testing` |
| **Justificación QUALITY** | Infraestructura de conexión de red con ciclo de vida (connect/quit), integración con shutdown handler existente, comportamiento diferenciado por env (`NODE_ENV=test`), y fallback in-memory documentado. El singleton mal implementado impacta todas las HUs que dependen de Redis. AR obligatorio. |

---

## Acceptance Criteria (EARS)

### Env schema

**AC-1** — WHEN `parseEnv` is called and `REDIS_URL` is present in `process.env`, the system
SHALL validate it as a non-empty string and include it in the typed `EnvConfig` as
`redisUrl: string`.

**AC-2** — WHEN `parseEnv` is called and `REDIS_URL` is absent from `process.env`, the system
SHALL exit with code `1` and write a human-readable error to `process.stderr` listing
`REDIS_URL` as the missing field, before Fastify starts listening.

**AC-3** — WHEN `parseEnv` is called and `NODE_ENV` is `'test'` and `REDIS_URL` is absent,
the system SHALL NOT exit; instead `redisUrl` SHALL be `undefined` (optional in test env),
allowing test suites to run without a live Redis instance.

### Redis client singleton

**AC-4** — WHEN `getRedisClient()` is called for the first time, the system SHALL create
exactly one `ioredis` instance configured with the URL from `EnvConfig.redisUrl`, with
`lazyConnect: true`, `maxRetriesPerRequest: 3`, and `enableReadyCheck: false`. Subsequent
calls SHALL return the same instance.

**AC-5** — WHILE the Redis client is instantiated, it SHALL NOT log the full `REDIS_URL`
value. The system SHALL log a redacted version (e.g. `redis://*:*@host:port/db`) that masks
any password component, at level `info`, on first creation.

**AC-6** — IF `getRedisClient()` is called when `NODE_ENV` is `'test'` and `REDIS_URL` is
undefined, THEN the system SHALL return `null` (not throw), indicating the caller must fall
back to the in-memory alternative.

**AC-7** — WHILE the ioredis instance is connected and receives a `connect` event, it SHALL
emit exactly one structured log entry `{ msg: 'Redis connected', host: '<host>', port: <port> }`
at level `info` via the Pino logger singleton.

**AC-8** — IF the ioredis instance emits an `error` event, THEN the system SHALL log the
error at level `error` via the Pino logger singleton with fields `{ msg: 'Redis error', err }`
and SHALL NOT crash the process (ioredis error handler prevents unhandled rejection).

### Retry strategy

**AC-9** — WHILE the Redis client is reconnecting after a connection failure, it SHALL use
an exponential-backoff retry strategy with a minimum delay of `100ms`, a maximum delay of
`3000ms`, and a maximum of `10` retries before giving up. IF the client gives up (retries
exhausted), THEN it SHALL emit an `error` event and the process SHALL log at level `error`
`{ msg: 'Redis connection failed permanently' }`.

### Shutdown integration

**AC-10** — WHEN the graceful shutdown handler is invoked (SIGTERM or SIGINT), the system
SHALL call `redis.quit()` before `app.close()` resolves, ensuring no dangling connections
remain after the process exits.

**AC-11** — IF `redis.quit()` rejects or throws during shutdown, THEN the system SHALL log
the error at level `error` and continue the shutdown sequence (SHALL NOT block `app.close()`).

### In-memory fallback

**AC-12** — IF `getRedisClient()` returns `null` (test env or Redis unavailable) and a caller
in `src/core/idempotency.ts` detects this, THEN the system SHALL log a structured warning
`{ msg: 'Redis unavailable — falling back to in-memory idempotency cache' }` at level `warn`
exactly once per process lifetime (not per request).

### Tests

**AC-13** — WHEN `npm run test` executes `src/__tests__/unit/redis.test.ts`, all tests SHALL
pass without a live Redis instance, using either a mocked ioredis or the `null`-return path.
The test SHALL verify: `getRedisClient()` returns the same instance on repeated calls, the
URL-redaction function masks passwords, and the retry config is applied.

**AC-14** — WHEN `npm run typecheck` is executed on the files introduced by this HU, the
command SHALL exit with code `0` (no TypeScript errors). The exported type of `getRedisClient()`
SHALL be `Redis | null`, not `Redis | undefined | any`.

---

## Scope IN

| Archivo / Módulo | Acción | Notas |
|-----------------|--------|-------|
| `src/infra/env.ts` | MODIFY | Añadir `REDIS_URL` al `EnvSchema`; condicional en test env (AC-2, AC-3) |
| `src/infra/redis.ts` | CREATE | Singleton ioredis — `getRedisClient()`, URL redaction, retry strategy, event logging |
| `src/infra/shutdown.ts` | MODIFY | Registrar `redis.quit()` antes de `app.close()` en el shutdown handler (AC-10, AC-11) |
| `src/__tests__/unit/redis.test.ts` | CREATE | Unit tests sin live Redis (AC-13) |
| `.env.example` | MODIFY | Añadir `REDIS_URL=redis://localhost:6379` con comentario |

---

## Scope OUT

| Item | Razón |
|------|-------|
| `src/core/idempotency.ts` | WFAC-21 — usa el cliente Redis pero no es responsabilidad de esta HU crearlo |
| Rate-limit middleware Redis-backed | WFAC-40 — usa el cliente pero no es esta HU |
| BullMQ queue setup | WFAC-42 — usa el cliente pero no es esta HU |
| Integration tests con Redis real | Diferido a WFAC-21 (primer consumidor real del cliente) |
| Supabase `facilitator_idempotency` table | WFAC-32 — persistence layer separado |
| `@fastify/rate-limit` plugin registration | WFAC-40 — fuera de esta HU |
| Cluster mode / Redis Sentinel / TLS config | V1.5 — fuera del MVP actual |
| `ioredis` version upgrade | ya instalado en 5.4.1 (confirmado en package.json) |

---

## Decisiones técnicas (DT-N)

**DT-1 — Singleton via module-level variable, no clase.**
`src/infra/redis.ts` exporta `getRedisClient(): Redis | null`. El cliente se inicializa
la primera vez que se llama `getRedisClient()` y se guarda en una variable de módulo
(`let _client: Redis | null = null`). Este patrón evita instanciar ioredis en module-load
(importante para tests que importan el módulo sin Redis disponible) y es más simple que
una clase con `getInstance()`. El `lazyConnect: true` delega la conexión TCP al momento del
primer comando, no al constructor.

**DT-2 — `lazyConnect: true` obligatorio para test env.**
Con `lazyConnect: false` (default ioredis), el constructor dispara un `connect` inmediato.
En `NODE_ENV=test` esto causaría errores de conexión rechazada si no hay Redis local.
`lazyConnect: true` + retornar `null` cuando no hay `REDIS_URL` en test env permite que
los tests unitarios importen `getRedisClient()` sin efectos de red.

**DT-3 — URL redaction antes de loggear.**
`REDIS_URL` puede contener password (`redis://:password@host:6379`). El logger Pino no
tiene redact configurado para este campo aún (TD-01-04 lo cubre en WFAC-31). Por ello,
`src/infra/redis.ts` DEBE redactar el password localmente antes del log, usando
`new URL(redisUrl)` y reemplazando `url.password` con `'*'`. No loggear nunca
`process.env.REDIS_URL` directamente.

**DT-4 — Retry strategy: exponential backoff con cap en 3s.**
`retryStrategy(times: number): number | null` retorna `Math.min(100 * 2 ** times, 3000)`.
Después de 10 intentos retorna `null` para que ioredis emita un error final. Este cap evita
que un Redis en flap tarde horas en declararse failed. Alineado con el circuit-breaker
pattern que vendrá en WFAC-41.

**DT-5 — `redis.quit()` en shutdown, no `redis.disconnect()`.**
`disconnect()` cierra el socket inmediatamente sin esperar respuestas pendientes.
`quit()` envía el comando `QUIT` al servidor y espera la respuesta — más limpio para
un servicio financiero. Si hay comandos en vuelo, `quit()` los deja completar.
Excepción: si `quit()` tarda más de `SHUTDOWN_GRACE_MS`, el timer de force-exit ya
gestionará la terminación (AC-11 acepta que la promesa se rechace y continúe).

**DT-6 — Env schema condicional para test env.**
En lugar de `z.string().url()` puro, usar `.optional()` condicionado al `NODE_ENV`.
El patrón en `src/infra/env.ts` será:
```ts
REDIS_URL: z.string().min(1).optional().transform((val, ctx) => {
  if (!val && ctx.data?.NODE_ENV !== 'test') {
    ctx.addIssue({ code: 'custom', message: 'REDIS_URL is required in non-test envs' });
    return z.NEVER;
  }
  return val;
})
```
El Architect puede refinar en F2; lo importante es que la variante test-optional no
introduce `any` ni bypasea la validación en producción.

---

## Constraint Directives (CD-N)

**CD-1** — PROHIBIDO loggear `process.env.REDIS_URL` o cualquier valor de URL de Redis
sin redactar. Todo log que mencione la URL de Redis DEBE usar la versión con password
enmascarado (`redis://*:*@host:port/db`). Violación = BLOQUEANTE en AR.

**CD-2** — PROHIBIDO llamar a `new Redis(url)` fuera de `src/infra/redis.ts`. El único
punto de creación del cliente es `getRedisClient()`. Cualquier otra capa (core, routes,
middleware) DEBE importar `getRedisClient` y consumir la instancia retornada.

**CD-3** — OBLIGATORIO que `getRedisClient()` retorne `Redis | null` (no `Redis | undefined`,
no `Redis`). Los callers DEBEN manejar el caso `null` como in-memory fallback. TypeScript
strict enforza esto — el caller no puede usar el cliente sin el null check.

**CD-4** — OBLIGATORIO registrar el error handler de ioredis (`client.on('error', ...)`)
inmediatamente después de construir la instancia. Sin este handler, los errores de conexión
se convierten en `UnhandledPromiseRejection` y crashean el proceso (Node.js behavior).

**CD-5** — PROHIBIDO usar `ioredis` en modo Cluster o Sentinel en esta HU. La configuración
es `new Redis(url, { lazyConnect: true, ... })` — single-node. Cluster es V1.5 mínimo.

**CD-6** — OWNERS.md compliance: `src/infra/redis.ts` puede importar solo `ioredis` y
`src/infra/logger.ts`. PROHIBIDO importar de `src/core/*`, `src/chains/*`, `src/methods/*`,
`src/routes/*`. La infra layer es la base — no tiene dependencias internas.

**CD-7** — PROHIBIDO usar `console.log` en `src/infra/redis.ts`. Todo output usa el Pino
logger singleton importado de `src/infra/logger.ts` (igual que el resto de la infra layer,
heredado de CD-1 de WFAC-2).

**CD-8** — OBLIGATORIO que `shutdown.ts` registre el quit de Redis ANTES de `app.close()`.
El orden de shutdown es: (1) stop accepting new requests, (2) drain in-flight, (3) redis.quit(),
(4) process.exit(0). Si Redis quit falla, loggear y continuar — no bloquear el proceso.

**CD-9** — OBLIGATORIO que `src/__tests__/unit/redis.test.ts` corra sin live Redis.
Vitest config debe permitir el mock de `ioredis` (o usar el path `null`-return del módulo).
Un test que falle por `ECONNREFUSED` en CI es un CI roto — inaceptable.

**CD-10** — PROHIBIDO cualquier hardcode de `redis://localhost:6379` en `src/`. La única
aparición de esa URL en el codebase puede ser en `.env.example` como valor de ejemplo
comentado, y en los tests que usan vi.mock() para simularla.

---

## Missing Inputs

| Item | Tipo | Estado |
|------|------|--------|
| Versión exacta de ioredis 5.x API para `retryStrategy` | **Info** — ioredis 5.4.1 confirmado en package.json; el Architect DEBE leer `node_modules/ioredis/` antes de codear para verificar firmas de constructor y tipos de `retryStrategy`. | Resuelto en F3 via regla node_modules read-first |
| Comportamiento de `shutdown.ts` cuando Redis client es `null` (test env) | **Decisión arquitectural** — si `getRedisClient()` retorna `null`, el shutdown handler no debe llamar `null.quit()`. El guard es `if (redisClient) await redisClient.quit()`. El Architect confirma en F2. | `[Resuelto en F2]` |
| `REDIS_URL` condicional en test env: ¿Zod `.superRefine` o `.optional()` + check manual? | **Decisión arquitectural** — DT-6 propone una opción pero el Architect elige la implementación final. | `[Resuelto en F2]` |

---

## Waves preliminares (el Architect refina en F2)

| Wave | Descripción | Archivos estimados |
|------|-------------|-------------------|
| **W0** | Env schema: añadir `REDIS_URL` con variante optional en test env | `src/infra/env.ts` |
| **W1** | Redis client singleton: `getRedisClient()`, URL redaction, retry strategy, event handlers | `src/infra/redis.ts` |
| **W2** | Shutdown integration: `redis.quit()` en el handler + null guard | `src/infra/shutdown.ts` |
| **W3** | Tests: unit tests sin live Redis + typecheck green | `src/__tests__/unit/redis.test.ts`, `npm run qa` green |

---

## Análisis de paralelismo

- **Bloquea (hard dependency)**:
  - **WFAC-21** (POST /settle + idempotency check) — `src/core/idempotency.ts` requiere
    `getRedisClient()` para cachear resultados de settlement por 120s.
  - **WFAC-40** (rate-limit Redis-backed) — `@fastify/rate-limit` necesita la instancia ioredis
    como store. Sin este módulo, el rate-limit corre solo en memoria (no distribuido).
- **Bloquea (soft dependency)**:
  - **WFAC-42** (BullMQ settlement retry queue) — BullMQ constructor recibe una instancia ioredis.
    La cola no puede instanciarse sin el cliente.
- **Puede correr en paralelo con**:
  - WFAC-10 (verify logic) — no usa Redis.
  - WFAC-11 (settle logic core) — no usa Redis directamente; la idempotencia se agrega en WFAC-21.
  - WFAC-20 (POST /verify route) — no usa Redis.
  - WFAC-22 (GET /supported) — no usa Redis.
  - WFAC-30 (Prometheus metrics) — no usa Redis.
- **No depende de**:
  - Supabase (WFAC-32) — persistencia separada.
  - Chain registry (WFAC-4/003, ya mergeado) — no hay interacción.
  - Wallet client (aún no implementado) — no hay interacción.

---

## Criterios de éxito no funcionales

- `npm run qa` green: typecheck + lint + format:check + test pasan sin warnings.
- `npm run test` pasa en CI sin live Redis (mock o null-path).
- Zero `any` en archivos nuevos — verificado por tsc + ESLint.
- `getRedisClient()` retorna la misma instancia en 1000 llamadas consecutivas (no crea N conexiones).
- Password no aparece en ningún log ni en `process.stdout` en ningún path (verificado en test).
- `npm run build` limpio: `tsc` sin errores en los 3 archivos modificados/creados.
