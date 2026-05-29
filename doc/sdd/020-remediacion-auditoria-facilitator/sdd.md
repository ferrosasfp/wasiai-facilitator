# SDD #020: [WFAC-AUDIT] Remediación auditoría profesional — seguridad de pagos + calidad

> SPEC_APPROVED: no
> Fecha: 2026-05-29
> Tipo: security + refactor
> SDD_MODE: full
> Branch: feat/020-wfac-audit-remediation
> Artefactos: doc/sdd/020-remediacion-auditoria-facilitator/

---

## 1. Resumen

Remediación de 6 hallazgos de la auditoría staff-level (2026-05-29, calificación B+). El
facilitator mueve dinero real (x402/EIP-3009), así que el bar de seguridad excede al de un
CRUD. Esta HU agrega (1) autenticación de caller en `/settle` y `/verify`, (2) rate-limit
keyed por IP real (`trustProxy` + `request.ip`, eliminando el bypass por `X-Forwarded-For`
forjado), (3) un lock in-flight para idempotencia de settle, (4) los checks de validación
`validAfter` / `payTo == to` / `amount > 0` que hoy existen en `src/methods/eip3009/verify.ts`
pero faltan en los adapters live, (5) una base class `Eip3009Adapter` que deduplica los tres
adapters (`kite`, `avalanche`, `base`) y (6) un `checkSettleAmountCap` fail-closed ante error
de parseo de BigInt.

El resultado esperado: los 590+ tests existentes siguen verdes (CD-1/CD-2 behavior-preserving),
los hallazgos quedan cerrados con tests dedicados, y el refactor de adapters (que toca dinero)
se separa de la adición de checks en commits/waves distintas para mantener la auditabilidad.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 020 |
| **Tipo** | security + refactor |
| **SDD_MODE** | full |
| **Objetivo** | Cerrar 6 hallazgos de auditoría sin romper la verificación de firma EIP-3009 ni la suite de 590+ tests. |
| **Reglas de negocio** | Sin hardcodes (key/proxy desde env). `timingSafeEqual` para comparar API key. Refactor de adapters behavior-preserving y separado de los checks nuevos. `src/methods/eip3009/*` intocable. |
| **Scope IN** | Ver §6. |
| **Scope OUT** | Ver §6. mTLS/JWT, multi-key por chain, RLS, Permit2/ERC-7710, alarmas de gas. |
| **Missing Inputs** | `TRUST_PROXY` exacto para Railway (resuelto §10), comportamiento del lock cuando existe (resuelto §10). |

### Acceptance Criteria (EARS)

- **AC-1** — WHEN a POST a `/settle` o `/verify` llega SIN un bearer `FACILITATOR_API_KEY`
  válido (ausente / mismatch), THE sistema SHALL responder HTTP 401 ANTES de ejecutar
  business logic. WHEN llega CON la key válida, SHALL proceder con el pipeline existente.
- **AC-2** — WHILE `trustProxy` está configurado al proxy upstream conocido (Railway), THE
  sistema SHALL keyear el rate-limit por `request.ip` (IP resuelta por Fastify post-trustProxy)
  y NO por el primer elemento crudo de `X-Forwarded-For`. IF un atacante rota `X-Forwarded-For`
  desde una misma IP real, THEN todas las requests SHALL contar contra el MISMO bucket.
- **AC-3** — WHEN un `/settle` llega y la idempotency key NO está en cache (miss), THE sistema
  SHALL setear atómicamente un lock `SET key NX EX <ttl>` ANTES de despachar a `settleCore`.
  IF el lock ya existe (request concurrente idéntica in-flight), THEN SHALL responder HTTP 409.
  WHEN `settleCore` completa, SHALL reemplazar el lock por la entry permanente de idempotency
  (path `toCacheableSettle` + `setCachedSettleResponse`). El doc SHALL describir el nonce
  on-chain como salvaguarda última y el lock como optimización best-effort server-side.
- **AC-4** — WHEN cualquier adapter (`kite`/`avalanche`/`base`) procesa `/verify` o `/settle`,
  THE sistema SHALL checar ANTES del RPC: `amount > 0` (INVALID_AMOUNT 400), `to` address-equal
  a `accepted.payTo` (INVALID_RECEIVER 400), `validAfter <= nowSec` (EXPIRED_AUTHORIZATION 400).
  Post-AC, el path del adapter SHALL ser equivalente al de `src/methods/eip3009/verify.ts`.
- **AC-5** — WHEN se introduce `BaseEip3009Adapter` parametrizado por chain/token, THE sistema
  SHALL migrar `KiteAdapter`/`AvalancheAdapter`/`BaseAdapter` a extenderla, con la lógica
  compartida (`_verifyRaw`, `_settleRaw`, `sanitize`, CB wiring, `getPublicClient`,
  `getWalletClient`, `setLogger`, `getBreakerState`, `verify`, `settle`) UNA sola vez. El
  refactor SHALL ser behavior-preserving (590+ tests sin tocar assertions).
- **AC-6** — IF `checkSettleAmountCap` recibe `amountAtomic`/`capAtomic` que falla `BigInt()`
  (`"abc"`, `"1.5"`, `""`), THEN SHALL retornar `{ ok: false, limit: 0n }` (fail-closed), NO
  `{ ok: true }`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/routes/settle.ts` | Dónde insertar preHandler de auth (AC-1) + lock in-flight (AC-3) | Plugin `FastifyPluginAsync`; `app.post('/settle', { config: { rateLimit } }, handler)` (L70-79); `request.auditMeta` set ANTES de `reply.send`; pasos Zod→idempotency-lookup→daily-cap→`settleCore`→cache→map (L84-342); `isRedisAvailable()` (L115); `getCachedSettleResponse`/`setCachedSettleResponse`/`toCacheableSettle`/`buildSettleIdempotencyKey` (L26-33). |
| `src/routes/verify.ts` | Mismo preHandler de auth (AC-1) | Misma estructura de plugin + `config.rateLimit` (L68-77). No tiene daily-cap ni write on-chain. |
| `src/app.ts` | Configurar `trustProxy` (AC-2) + registrar preHandler global o per-route | `buildApp(options)` crea `Fastify({ loggerInstance, disableRequestLogging:false })` SIN `trustProxy` hoy (L98-101). Rate-limit se registra en L153-215 con `keyGenerator: (req)=>extractClientIp(req) ?? req.ip ?? 'unknown'` (L171). Orden: helmet → cors → rate-limit → routes. `app.decorate('env', env)` (L103). |
| `src/core/network.ts` | `extractClientIp` (AC-2) | Pure helper: prioriza el 1er elemento de `X-Forwarded-For` (L27-36), luego `request.ip` (L37). ESTE es el bypass: el XFF forjado gana sobre `request.ip`. |
| `src/infra/env.ts` | Agregar `FACILITATOR_API_KEY` + `TRUST_PROXY` (AC-1, AC-2) | `EnvSchema` + `.superRefine` (L142-166) con patrón "required outside test" para `OPERATOR_PRIVATE_KEY` (L151-157), `REDIS_URL`, `KITE_USDC_ADDRESS`. Enum-string + transform para booleans (`z.coerce.boolean()` PROHIBIDO, L41-45). `parseEnv` fail-fast a stderr (L180-192). |
| `src/core/idempotency.ts` | Diseñar `setInflightSettleLock` (AC-3) | `getRedisClient()` directo (L32), `isRedisAvailable()` (L141-143), `SETTLE_IDEMPOTENCY_TTL_SEC=120` (L220), `SETTLE_IDEMPOTENCY_KEY_PREFIX='settle:idempotency:'` (L223), `buildSettleIdempotencyKey` (L285-289), set con `client.set(key, val, 'EX', ttl)` (L326). Todo swallow-on-error (CD-4). |
| `src/core/settle-cap.ts` | Fix fail-closed (AC-6) | `checkSettleAmountCap` (L47-60): el `catch` retorna `{ ok: true }` (fail-OPEN — el bug). Tipo `AmountCapResult = { ok: true } | { ok: false; limit: bigint }` (L28). |
| `src/chains/kite.ts` | Diseñar base class (AC-5) + ubicar checks (AC-4) | `KiteAdapter` con `_verifyRaw` (L263-398) y `_settleRaw` (L437-588); `verify`/`settle` con CB+BusinessFailureError (L224-257, L401-430); `sanitize` (L63-66); `getPublicClient`/`getWalletClient`/`setLogger`/`getBreakerState` (L185-213). Chain-specific: `defineChain` inline (L125-134), `readEnv`/`readUsdcAddress`/`readEnabledFlag`, token defaults PYUSD (L138-142). |
| `src/chains/avalanche.ts` | Comparar contra kite (AC-5) | `_verifyRaw` (L267-400) y `_settleRaw` (L437-586) byte-equivalentes a kite salvo comentarios. Chain-specific: `USDC_FUJI`/`USDC_AVALANCHE_MAINNET` constantes (L83-102), `viemChain` desde `viem/chains` (L36), recibe `token`+`viemChain` por constructor. |
| `src/chains/base.ts` | Comparar contra kite/avalanche (AC-5) | `_verifyRaw` (L277-412) y `_settleRaw` (L449-598) byte-equivalentes. Chain-specific: `USDC_BASE_SEPOLIA`/`USDC_BASE_MAINNET` (L96-116), `nativeCurrency` = ETH (L190), gating por dos flags. |
| `src/methods/eip3009/verify.ts:80-149` | Semántica EXACTA de los checks faltantes (AC-4) | `acceptedAmount <= 0n → INVALID_AMOUNT` (L98-103); `isAddressEqual(authorization.to, accepted.payTo)` false → `INVALID_RECEIVER` (L112-117); `validBefore <= nowSec → EXPIRED_AUTHORIZATION 'Authorization expired'` (L124-126); `validAfter > nowSec → EXPIRED_AUTHORIZATION 'Authorization not yet valid'` (L127-132). Todo con BigInt (BLQ-MED-1). |
| `src/chains/types.ts` | Contrato `ChainAdapter` (AC-5) | Interface de 5 miembros + opcionales `getBreakerState`/`setLogger` (L128-154); `EIP3009Token`, `ChainMetadata`, `VerifyParams`/`Result`/`SettleParams`/`Result`, `AdapterResult<T>`, `ChainAdapterInitError`. |
| `src/chains/abi/fiat-token.ts` | Imports compartidos de la base class (AC-5) | `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS` — duplicados controlados (OWNERS [3]). |
| `src/chains/index.ts` | Boot registration (no cambia con AC-5) | Importa los adapters exportados + `chainRegistry.register(...)`. Las exports (`kiteTestnetAdapter`, etc.) deben preservar el mismo shape. |
| `src/__tests__/unit/chain-adapter.test.ts:1-70` | Harness behavior-preserving (AC-5, T16/T17) | `vi.resetModules()` por test, `snapshotEnv/restoreEnv` sobre `ENV_KEYS`, `makeMockClients()` con `vi.fn()` stubs, fixtures EIP-712 reales (Hardhat acct #0). `T-SDD-1-ABI-SYNC` byte-for-byte. |
| `src/__tests__/unit/rate-limiting.test.ts:1-30` | Tests de rate-limit a actualizar (AC-2, T6/T7) | `buildApp({ rawEnv })` con caps bajos; T-RL-8/T-RL-10 fuerzan IPs distintas vía `x-forwarded-for` (HOY pasan PORQUE XFF se honra — bajo trustProxy esa semántica cambia, ver §7 R-1). |
| `src/__tests__/unit/routes.verify.test.ts:192-206` | Harness para test de auth (AC-1) | `buildAppWithAdapter()` hace `await import('../../app.js')` + `buildApp({ rawEnv, ... })` + registra fake adapter; usa `app.inject()`. |
| `src/__tests__/unit/core.settle-cap.test.ts` | Ampliar con T19-T22 (AC-6) | Existe; AC-6 agrega casos de parseo inválido. |
| `doc/sdd/019.../auto-blindaje.md`, `doc/sdd/015.../auto-blindaje.md` | Aprendizaje histórico | Ver §5 CD-13, CD-14. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| `src/middleware/auth.ts` (NUEVO) | `src/core/network.ts` (pure helper + boundary doc) para la estructura; `app.ts:189-213 errorResponseBuilder` para la forma del body de error 401 | Es el primer archivo real en `src/middleware/` (hoy solo `.gitkeep`). preHandler que lee `env.FACILITATOR_API_KEY` vía `app.env`. |
| `src/chains/base-adapter.ts` (NUEVO) | `src/chains/kite.ts` (clase `KiteAdapter` completa) | La base class extrae métodos byte-idénticos de los 3 adapters. |
| `FACILITATOR_API_KEY` / `TRUST_PROXY` en `src/infra/env.ts` | `OPERATOR_PRIVATE_KEY` (L67-70 + superRefine L151-157) y `RATE_LIMIT_ENABLED` (L42-45) | Mismo patrón "required outside test" y enum-transform para no-boolean-coerce. |
| `setInflightSettleLock` en `src/core/idempotency.ts` | `setCachedSettleResponse` (L319-330) + `buildSettleIdempotencyKey` (L285-289) | Mismo façade, swallow-on-error, prefix dedicado. |
| Checks AC-4 en `base-adapter.ts` | `src/methods/eip3009/verify.ts:96-132` | Copiar semántica exacta (codes/HTTP/mensajes/orden BigInt). |
| `routes.settle.auth.test.ts` / `routes.settle.inflight.test.ts` (NUEVOS) | `routes.verify.test.ts:192-206` + `routes.settle.test.ts:1-55` | Harness `buildApp({rawEnv})` + fake adapter + `app.inject()`. |
| Ampliación de `chains.kite.test.ts` (T11-T15) | `chains.base.test.ts:1-60` | Mismo harness de fixtures EIP-712 reales + mock clients. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `facilitator_settlements` | Sí | N/A — esta HU no toca el ledger. |
| `facilitator_audit_log` | Sí | N/A — el preHandler 401 deja que el hook `onResponse` audite (status 401) sin cambios. |
| Redis (no BD) | N/A | Nuevo prefix `settle:inflight:` (AC-3). TTL = `SETTLE_IDEMPOTENCY_TTL_SEC` (120s). |

### Componentes reutilizables encontrados

- `extractClientIp` (`src/core/network.ts`) — se MODIFICA su precedencia (AC-2), no se duplica.
- `isRedisAvailable` / `getRedisClient` (`src/core/idempotency.ts` + `src/infra/redis.ts`) — reutilizar para el lock fail-open (CD-7).
- `buildSettleIdempotencyKey` — el lock reusa la MISMA key base (mismo hash canónico) con prefix distinto.
- CB wiring `ChainCircuitBreaker` + `BusinessFailureError` (`src/chains/circuit-breaker.ts`) — se mueve íntegro a la base class sin cambios de lógica.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | AC | Exemplar |
|---------|--------|-------------|-----|----------|
| `src/middleware/auth.ts` | Crear | `requireFacilitatorKey` preHandler: lee bearer de `Authorization`, compara con `app.env.FACILITATOR_API_KEY` vía `timingSafeEqual`; 401 si ausente/mismatch; en test sin key → bypass. NUNCA loguea la key. | AC-1 | `src/core/network.ts` (boundary) + `app.ts` error body |
| `src/routes/settle.ts` | Modificar | Agregar `preHandler: requireFacilitatorKey` al `app.post('/settle', {...})`; insertar lock in-flight tras cache-miss y ANTES de `settleCore`; release/replace post-settle. | AC-1, AC-3 | `src/routes/settle.ts` L70-79 (config existente) |
| `src/routes/verify.ts` | Modificar | Agregar `preHandler: requireFacilitatorKey` al `app.post('/verify', {...})`. | AC-1 | ídem settle |
| `src/app.ts` | Modificar | Pasar `trustProxy: env.TRUST_PROXY` al `Fastify({...})` constructor (L98) — ANTES del registro de rate-limit (CD-5). Ajustar el `keyGenerator` para keyear por `req.ip` (no XFF crudo) — ver §4.3. | AC-2 | `src/app.ts` L98-101, L171 |
| `src/core/network.ts` | Modificar | Cuando `trustProxy` está activo, `extractClientIp` SHALL devolver `request.ip` (ya resuelta por Fastify) en lugar del 1er XFF crudo. Estrategia: invertir precedencia o tomar `request.ip` directo. | AC-2 | `src/core/network.ts` L26-39 |
| `src/core/idempotency.ts` | Modificar | Agregar `SETTLE_INFLIGHT_KEY_PREFIX`, `setInflightSettleLock(parsed)` (→ `'acquired' | 'held' | 'skipped'`) y `releaseInflightSettleLock(key)`. Doc preciso (AC-3 nonce on-chain). | AC-3 | `setCachedSettleResponse` L319-330 |
| `src/core/settle-cap.ts` | Modificar | `checkSettleAmountCap`: `catch` retorna `{ ok: false, limit: 0n }`; agregar guard `amount <= 0n` (T21). Cambiar comentario fail-open→fail-closed. | AC-6 | `src/core/settle-cap.ts` L47-60 |
| `src/chains/base-adapter.ts` | Crear | `abstract class BaseEip3009Adapter implements ChainAdapter` con `_verifyRaw`/`_settleRaw`/`verify`/`settle`/`sanitize`/`getPublicClient`/`getWalletClient`/`setLogger`/`getBreakerState`/CB wiring. Recibe en constructor: chainIdNum, name, network, rpcUrl, viemChain, token, blockExplorer. | AC-5 (+AC-4 en W4) | `src/chains/kite.ts` (clase completa) |
| `src/chains/kite.ts` | Modificar | `KiteAdapter extends BaseEip3009Adapter`. Retiene solo: `readEnv`, `readUsdcAddress`, `readEnabledFlag`, construcción de `defineChain` + token PYUSD defaults, y los exports `kiteTestnetAdapter`/`kiteMainnetAdapter`. <100 líneas (T18). | AC-5 | base-adapter.ts |
| `src/chains/avalanche.ts` | Modificar | `AvalancheAdapter extends BaseEip3009Adapter`. Retiene: `USDC_FUJI`/`USDC_AVALANCHE_MAINNET`, `readRpcUrl`/`readEnabledFlag`, `viemChain` (avalanche/avalancheFuji), exports. <100 líneas. | AC-5 | base-adapter.ts |
| `src/chains/base.ts` | Modificar | `BaseAdapter extends BaseEip3009Adapter`. Retiene: `USDC_BASE_SEPOLIA`/`USDC_BASE_MAINNET`, `readRpcUrl`/`readEnabledFlag`, `viemChain` (base/baseSepolia), `nativeCurrency` ETH, exports. <100 líneas. | AC-5 | base-adapter.ts |
| `src/infra/env.ts` | Modificar | Agregar `FACILITATOR_API_KEY` (required outside test, superRefine) + `TRUST_PROXY` (string, default `'1'`). | AC-1, AC-2 | `OPERATOR_PRIVATE_KEY` L67-70 + L151-157 |
| `.env.example` | Modificar | Documentar `FACILITATOR_API_KEY` y `TRUST_PROXY` con comentarios de seguridad (CD-8). | AC-1, AC-2 | entradas existentes |
| `src/__tests__/unit/routes.settle.auth.test.ts` | Crear | T1-T5 (auth). | AC-1 | routes.verify.test.ts |
| `src/__tests__/unit/rate-limiting.xff-bypass.test.ts` | Crear | T6-T7 (XFF spoof → mismo bucket bajo trustProxy). | AC-2 | rate-limiting.test.ts |
| `src/__tests__/unit/routes.settle.inflight.test.ts` | Crear | T8-T10 (lock concurrente → 409; Redis down → skip; doc). | AC-3 | routes.settle.test.ts |
| `src/__tests__/unit/chains.kite.test.ts` (o equivalentes base/avalanche) | Crear/Ampliar | T11-T15 (`_verifyRaw`/`_settleRaw` con los 3 checks). | AC-4 | chains.base.test.ts |
| `src/__tests__/unit/chain-adapter.test.ts` | (sin tocar assertions) | T16 corre intacto (behavior-preserving). T17 puede agregarse como caso de la base class. | AC-5 | — |
| `src/__tests__/unit/core.settle-cap.test.ts` | Ampliar | T19-T22. | AC-6 | existente |
| `src/__tests__/unit/rate-limiting.test.ts` | Modificar (mínimo) | T-RL-8/T-RL-10 (XFF keying con 2 IPs) deben re-expresarse para reflejar que bajo trustProxy el XFF crudo ya NO separa cuotas; usar `remoteAddress`/inject distinto. Ver §7 R-1. | AC-2 | — |

### 4.2 Modelo de datos

> N/A en BD. Redis: nuevo key namespace `settle:inflight:<sha256>` con `SET NX EX 120`.
> NO se persiste nada nuevo en Supabase.

### 4.3 Componentes / Servicios

**A. `requireFacilitatorKey` (preHandler, `src/middleware/auth.ts`)**

- Firma: `(request, reply) => Promise<void>` (Fastify preHandler). Lee `request.server.env.FACILITATOR_API_KEY` (decorator `env`).
- Lógica:
  1. `const configured = request.server.env.FACILITATOR_API_KEY;`
  2. **Bypass de test (DT-7):** si `configured` es `undefined` (solo posible en `NODE_ENV === 'test'`, garantizado por superRefine), `return;` (no auth). En prod la key es required → boot falla si falta (CD-3).
  3. Extraer bearer: `const header = request.headers['authorization'];` → si no empieza con `'Bearer '` → 401.
  4. `const provided = header.slice('Bearer '.length);`
  5. Comparar con `timingSafeEqual` (node:crypto) sobre `Buffer.from`. **Longitudes distintas** → `timingSafeEqual` throwea; protegerlo con pre-check de longitud que NO short-circuitee el resultado boolean final (comparar longitud y luego una comparación dummy del mismo costo, o usar `crypto.timingSafeEqual` solo cuando lengths coinciden y devolver 401 en otro caso — el length por sí mismo no es secreto).
  6. Si no matchea → `reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', http: 401 } })`.
  7. NUNCA loguear `provided` ni `configured` (CD-NEW-AUTH-NOLOG).
- Body de error: shape `{ error: { code, message, http } }` (consistente con el resto de rutas). `code: 'UNAUTHORIZED'` es route/middleware-local (NO está en `X402ErrorCode`; igual que `RATE_LIMITED`/`SERVICE_UNAVAILABLE` son locales).
- **Boundary (OWNERS):** `src/middleware/` MAY import `src/infra/*` + tipos Fastify; MUST NOT importar `src/core/*`, `src/methods/*`, `src/chains/*`. La key se lee desde el decorator `app.env` (que ya es `EnvConfig`), NO importando `env.ts` runtime — consistente con cómo las rutas leen `app.env`. node:crypto está permitido (infra-level primitive).
- **Registro:** se aplica per-route vía `preHandler` en `settle.ts`/`verify.ts` (NO hook global) para no autenticar `/health`, `/supported`, `/openapi.json`, `/metrics`.

**B. `trustProxy` + IP keying (`src/app.ts` + `src/core/network.ts`)**

- `app.ts`: `Fastify({ loggerInstance, disableRequestLogging:false, trustProxy: parseTrustProxy(env.TRUST_PROXY) })`. Fastify v5 acepta `trustProxy: number | string | boolean`. `TRUST_PROXY='1'` (string) → coerción a number `1` (un hop). En test, `TRUST_PROXY` se setea a `false` (string `'false'` → boolean false) para no depender de proxy.
- **Decisión clave (DT-2/§7 R-1):** con `trustProxy` activo, Fastify ya resuelve `request.ip` desde el XFF de forma confiable (toma el hop correcto, no el primer elemento atacante-controlado). Por tanto el `keyGenerator` del rate-limit y el `extractClientIp` deben preferir `request.ip`, NO el primer XFF crudo.
- `network.ts`: `extractClientIp` cambia su precedencia. Diseño elegido: devolver `request.ip` como fuente primaria (Fastify ya aplicó la política de trustProxy); la rama de parseo manual de XFF se ELIMINA (era exactamente el vector de bypass). El helper queda: `return (typeof request.ip === 'string' && request.ip.length > 0) ? request.ip : null;`. Esto preserva su contrato pure `string | null` y simplifica.
- `keyGenerator` en `app.ts`: queda `(req) => extractClientIp(req) ?? req.ip ?? 'unknown'` — ahora ambos términos colapsan a `req.ip` (correcto).

**C. In-flight lock (`src/core/idempotency.ts` + `src/routes/settle.ts`)**

- Nuevos exports en `idempotency.ts`:
  - `export const SETTLE_INFLIGHT_KEY_PREFIX = 'settle:inflight:';`
  - `setInflightSettleLock(idempotencyKey): Promise<'acquired' | 'held' | 'skipped'>`: deriva la inflight-key reemplazando el prefix de la idempotency-key (o re-hasheando con el prefix inflight); ejecuta `client.set(inflightKey, '1', 'EX', SETTLE_IDEMPOTENCY_TTL_SEC, 'NX')`. Retorna `'acquired'` si OK (`!== null`), `'held'` si null (ya existe), `'skipped'` si Redis no disponible (fail-open CD-7). Swallow-on-error → `'skipped'`.
  - `releaseInflightSettleLock(idempotencyKey): Promise<void>`: `client.del(inflightKey)` swallow-on-error. Llamado tras escribir la entry permanente (la entry permanente, con TTL 120s, asume el rol de idempotencia; el lock se borra o se deja auto-expirar — preferimos `del` explícito para liberar antes).
- `settle.ts` flujo (insertar entre Step 2 cache-miss y Step 2.5/Step 3):
  1. tras confirmar cache-miss y `redisUp`, llamar `setInflightSettleLock(idempotencyKey)`.
  2. si `'held'` → responder HTTP 409 `{ error: { code: 'CONFLICT', message: 'Settlement already in-flight', http: 409 } }` (409 inmediato, §10). Set `request.auditMeta.errorCode = 'CONFLICT'`.
  3. si `'skipped'` → log warn (CD-7) y continuar sin lock.
  4. si `'acquired'` → continuar. En el path de éxito/4xx, tras `setCachedSettleResponse`, llamar `releaseInflightSettleLock`. En el path de throw (catch L191), también release (finally-style) para no dejar el lock colgado 120s. El lock NUNCA debe bloquear un retry legítimo tras un 5xx no-cacheado → por eso se libera en todos los paths terminales.
- `code: 'CONFLICT'` es route-local (NO en `X402ErrorCode`).

**D. Base class `BaseEip3009Adapter` (`src/chains/base-adapter.ts`)**

- `export abstract class BaseEip3009Adapter implements ChainAdapter`.
- Constructor recibe `BaseAdapterOpts`: `{ chainIdNum, name, network, networkId?, rpcUrl, viemChain: Chain, token: EIP3009Token, blockExplorer?, nativeCurrency, cbThresholds }`. Construye `this.metadata` (idéntico a hoy) y `this._breaker` (idéntico).
- Métodos compartidos (extraídos byte-equivalentes): `getPublicClient`, `getWalletClient`, `setLogger`, `getBreakerState`, `verify` (CB+BusinessFailureError), `settle` (CB+BusinessFailureError), `_verifyRaw`, `_settleRaw`, `sanitize` (helper privado o de módulo).
- Cada subclase pasa su `viemChain`, `token`, `nativeCurrency` y env-reading propio al `super(...)`. NO override de `_verifyRaw`/`_settleRaw` (única implementación).
- **W3 (refactor) NO cambia lógica.** Los checks de AC-4 se agregan en W4 en `_verifyRaw`/`_settleRaw` de la base — un solo lugar.

**E. Checks AC-4 (en `base-adapter.ts`, W4)**

Orden definitivo en `_verifyRaw` (DT-6, copiado de `methods/eip3009/verify.ts`):
1. token presente (NETWORK_MISMATCH si no)
2. network match (NETWORK_MISMATCH)
3. asset match (NETWORK_MISMATCH)
4. **`amount > 0`** → `BigInt(accepted.amount) <= 0n` → INVALID_AMOUNT 400 *(NUEVO)*
5. `authorization.value >= acceptedAmount` → INVALID_AMOUNT 400 (existente)
6. **`payTo == to`** → `!isAddressEqual(authorization.to, accepted.payTo)` → INVALID_RECEIVER 400 *(NUEVO)*
7. `validBefore <= nowSec` → EXPIRED_AUTHORIZATION 400 (existente)
8. **`validAfter > nowSec`** → EXPIRED_AUTHORIZATION 400 'Authorization not yet valid' *(NUEVO)*
9. normalize sig → 10. recover → 11. recovered == from.

`_settleRaw` agrega los MISMOS 3 checks nuevos (4, 6, 8) en su bloque de defense-in-depth (pasos 1-4 actuales, antes del normalize-sig + simulate). Mensajes/codes/HTTP idénticos a `methods/eip3009/verify.ts`.

### 4.4 Flujo principal (Happy Path)

1. Client POST `/settle` con `Authorization: Bearer <FACILITATOR_API_KEY>` válido.
2. `requireFacilitatorKey` preHandler pasa (timingSafeEqual OK).
3. Zod valida → idempotency cache miss → `setInflightSettleLock` retorna `'acquired'`.
4. daily-cap OK → `settleCore` (adapter base hace los 3 checks AC-4 + recover + simulate + write + receipt) → success.
5. cache write (`setCachedSettleResponse`) → `releaseInflightSettleLock` → 200 spec-literal.

### 4.5 Flujo de error

1. **Auth ausente:** preHandler → 401 `{ error: { code:'UNAUTHORIZED', ... } }` antes de cualquier business logic.
2. **Concurrencia:** 2da request idéntica in-flight → `setInflightSettleLock` retorna `'held'` → 409 `{ error:{ code:'CONFLICT', ... } }` (no segundo `settleCore`).
3. **Check AC-4:** `amount=0` / `to != payTo` / `validAfter` futuro → INVALID_AMOUNT / INVALID_RECEIVER / EXPIRED_AUTHORIZATION 400 antes del RPC.
4. **Cap imparseable (AC-6):** `checkSettleAmountCap("100","abc")` → `{ ok:false, limit:0n }` → request bloqueada (fail-closed).
5. **Redis down (AC-3):** `setInflightSettleLock` → `'skipped'` → warn + flujo continúa (el nonce on-chain es la salvaguarda última).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1** (heredado): NO romper la verificación de firma EIP-3009. El refactor (AC-4, AC-5) DEBE ser behavior-preserving: los 590+ tests existentes pasan SIN modificar assertions. Cualquier fallo de test existente = BLOQUEANTE en AR.
- **CD-2** (heredado): Refactor (AC-5) y checks (AC-4) son operaciones SECUENCIADAS en waves/commits distintos: primero extraer base class manteniendo comportamiento exacto (W3), luego agregar checks (W4).
- **CD-4** (heredado): `timingSafeEqual` (node:crypto) para comparar la API key. `===` PROHIBIDO (timing attack).
- **CD-5** (heredado): `trustProxy` se configura en el constructor `Fastify({...})` de `buildApp` ANTES del registro de `@fastify/rate-limit`.
- **CD-7** (heredado): el lock in-flight es fail-open cuando Redis no está disponible (patrón `isRedisAvailable()`). La degradación se loguea en warn.
- **CD-8** (heredado): documentar `FACILITATOR_API_KEY` y `TRUST_PROXY` en `.env.example` con comentarios de seguridad antes de mergear.
- **CD-DT-7** (heredado DT-7): `FACILITATOR_API_KEY` required en `NODE_ENV !== 'test'` vía `.superRefine` (mismo patrón que `OPERATOR_PRIVATE_KEY`). En test ausente → preHandler bypass.
- **CD-NEW-AUTH-NOLOG**: el preHandler de auth NUNCA loguea la API key recibida ni la configurada (ni en error). Ningún `log.*` debe incluir `provided`/`configured`/`authorization` header.
- **CD-NEW-ORDER**: el orden de checks en `_verifyRaw`/`_settleRaw` es exactamente el de §4.3-E / DT-6, idéntico a `methods/eip3009/verify.ts`.
- **CD-13** (de auto-blindaje WFAC-53): cuando se mueve/extrae un símbolo consumido por tests (ej. la clase adapter o `FIAT_TOKEN_ABI`), el grep de consumers DEBE usar la regex ampliada `SYMBOL\s*[).\[]` incluyendo `).toHaveLength`, `.length`, `[N]`, `for...of`, `.map`, `.forEach`. El refactor de AC-5 toca clases que muchos tests instancian — verificar TODOS los importadores antes de cambiar exports.
- **CD-14** (de auto-blindaje WFAC-40): si en el futuro la auth se moviera a un plugin que `throw`ea el body (no es el caso aquí — usamos `reply.code(401).send()` directo), recordar el patrón `statusCode` no-enumerable. Para esta HU el preHandler responde con `reply.code(401)` directo, NO throw → no aplica el escape hatch, pero NO introducir un throw que dependa de `error.statusCode`.

### PROHIBIDO

- **CD-6** (heredado): PROHIBIDO modificar `src/methods/eip3009/verify.ts` ni `src/methods/eip3009/settle.ts` (auditados y correctos). Los checks de AC-4 van en la base class.
- **CD-3** (heredado): PROHIBIDO hardcodear `FACILITATOR_API_KEY` o `TRUST_PROXY`. Vienen exclusivamente de `env`.
- PROHIBIDO agregar dependencias nuevas (node:crypto, viem, fastify, zod ya están).
- PROHIBIDO cambiar el shape spec-literal de las respuestas 200 de `/verify` y `/settle`.
- PROHIBIDO violar OWNERS: `src/middleware/auth.ts` no importa core/methods/chains; `src/chains/base-adapter.ts` no importa core/* runtime (solo `chains/types.ts`, `chains/abi/*`, `chains/circuit-breaker.ts`, `infra/wallet.ts`, viem — igual que los adapters hoy).
- PROHIBIDO modificar archivos fuera del Scope IN (§6).
- PROHIBIDO agregar lógica nueva durante W3 (solo mover código).

## 6. Scope

**IN:**
- AC-1..AC-6 según §4.1.
- `src/middleware/auth.ts`, `src/chains/base-adapter.ts` (nuevos).
- Modificación de `settle.ts`, `verify.ts`, `app.ts`, `network.ts`, `idempotency.ts`, `settle-cap.ts`, `kite.ts`, `avalanche.ts`, `base.ts`, `env.ts`, `.env.example`.
- Tests dedicados por AC.

**OUT:**
- Alarmas de gas del operator (script existe; cablear alarmas no es de esta HU).
- Multi-key por chain (V1: una key estática global).
- mTLS / JWT de sesión (V2).
- RLS Postgres-level (tracked aparte).
- Permit2 / ERC-7710 adapters (no existen; AC-4 solo aplica a los 3 adapters actuales).
- `src/methods/eip3009/*` (intocable — CD-6).

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| **R-1**: trustProxy invalida tests existentes de XFF-keying (`rate-limiting.test.ts` T-RL-8/T-RL-10 fuerzan IPs vía XFF). | A | M | El cambio de semántica es DELIBERADO (es el fix de AC-2). Re-expresar esos tests para usar `remoteAddress` distinto en `inject` (o aceptar que con trustProxy el XFF de un mismo origen no separa cuotas). Documentar como cambio esperado, NO regresión silenciosa. Es la ÚNICA excepción permitida a CD-1 — debe quedar explícita en el Story File. |
| **R-2**: el refactor AC-5 rompe `instanceof`/module-cache de `chain-adapter.test.ts` (usa `vi.resetModules()`). | M | A | La base class vive en `base-adapter.ts`; las subclases conservan sus nombres y exports. No cambiar las exports (`kiteTestnetAdapter`, etc.) ni los nombres de clase exportados. Correr la suite completa al cierre de W3 (CD-2). |
| **R-3**: `timingSafeEqual` throwea con buffers de distinta longitud. | M | M | Pre-check de longitud antes de `timingSafeEqual`; el length no es secreto. Devolver 401 si difieren. |
| **R-4**: lock in-flight no se libera tras 5xx no-cacheado → bloquea retry 120s. | M | A | `releaseInflightSettleLock` en TODOS los paths terminales (success, 4xx, catch-throw). El TTL 120s es backstop. |
| **R-5**: base class introduce `protected` members que las subclases ya no inicializan → CB no se arma. | B | A | El constructor de la base arma el `_breaker`; las subclases solo pasan thresholds. Verificar `getBreakerState()` en T16. |
| **R-6**: agregar `validAfter`/`payTo`/`amount>0` cambia el resultado de algún test de adapter existente que asumía el comportamiento laxo. | M | M | Esos checks son W4 (post-refactor). Si un test existente fallaba por un fixture con `validAfter` futuro o `to != payTo`, ajustar el fixture (no la assertion de seguridad). Documentar. |

## 8. Dependencias

- WFAC-53 (019) DONE — baseline. Esta HU continúa sobre él.
- Ninguna HU activa bloqueada por esta.
- Post-merge: OWNERS.md + BACKLOG.md deben documentar que toda chain futura extiende `BaseEip3009Adapter` (nueva constraint).

## 9. Money-Safety (sección crítica — servicio que mueve dinero)

- **El refactor (AC-5) NO altera la verificación de firma.** `_verifyRaw`/`_settleRaw` se MUEVEN byte-equivalentes a la base class. El recover EIP-712 (`recoverTypedDataAddress` con `EIP3009_TYPES`/`EIP3009_PRIMARY_TYPE`/domain inline) y el chequeo `recovered == from` permanecen idénticos. Único cambio de comportamiento autorizado: los 3 checks ADICIONALES de AC-4 (W4), que solo RECHAZAN más (nunca aceptan algo que antes rechazaban). El `simulate-before-write` y el uso opaco de `sim.request` se preservan.
- **Orden de checks en `_verifyRaw`/`_settleRaw`:** definido en §4.3-E / DT-6 — money-checks (amount>0, value>=accepted, payTo==to, ventana temporal) ocurren ANTES de gastar gas en `simulateContract` y ANTES del recover. Esto evita firmar/simular txs inválidas.
- **El preHandler de auth NUNCA loguea la API key** (CD-NEW-AUTH-NOLOG). La key es un secreto operacional; filtrarla en logs JSON sería equivalente a comprometerla.
- **El lock in-flight es una optimización best-effort, NO la garantía última.** El doc en `idempotency.ts` DEBE afirmar que el nonce EIP-3009 on-chain (un `transferWithAuthorization` con el mismo nonce revierte) es la salvaguarda definitiva contra double-spend; el lock solo evita despachar dos `settleCore` concurrentes en la ventana de carrera. Por eso es seguro que sea fail-open ante Redis down (CD-7).
- **AC-6 fail-closed:** un cap imparseable es misconfig; bloquear (no dejar pasar) protege el wallet operator. El cambio es estrictamente más conservador.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Resolución | Bloqueante? |
|--------|---------|-------------|------------|-------------|
| TRUST_PROXY valor Railway | §4.3-B | ¿`1` o `2` (Cloudflare delante)? | **RESUELTO**: default `TRUST_PROXY='1'` (Railway = un hop HTTP). Documentado en `.env.example`. Si el operador suma Cloudflare, lo sube a `2` por env — sin cambio de código (CD-3). | No |
| Lock existente → 409 vs polling | §4.3-C | ¿409 inmediato o retry/poll? | **RESUELTO**: HTTP 409 CONFLICT inmediato (default conservador, AC-3). NO polling — el cliente reintenta y, si la 1ra completó, recibe la respuesta cacheada. | No |

> Gate: sin `[NEEDS CLARIFICATION]` pendientes. Ambos markers resueltos.

## 11. Plan de Implementación (Waves)

> Respeta análisis de paralelismo del work-item: AC-5 PRECEDE AC-4; AC-2 + su test juntos; refactor y checks en commits separados (CD-2).

### Wave 0 (Serial Gate — verificación de baseline)
- W0.1: correr suite completa (`vitest`) y confirmar 590+ tests verdes ANTES de tocar nada. Registrar el número exacto (≈591) como baseline.

### Wave 1 (Parallelizable — ortogonales, bajo riesgo)
- W1.1: AC-6 — `src/core/settle-cap.ts` fail-closed + `core.settle-cap.test.ts` (T19-T22). → Exemplar: `settle-cap.ts:47-60`.
- W1.2: AC-1 — `src/infra/env.ts` (`FACILITATOR_API_KEY` superRefine) + `src/middleware/auth.ts` + preHandler en `settle.ts`/`verify.ts` + `.env.example` + `routes.settle.auth.test.ts` (T1-T5). → Exemplar: `env.ts:67-70,151-157` + `network.ts`.

### Wave 2 (trustProxy — toca app.ts + tests rate-limit)
- W2.1: AC-2 — `src/app.ts` (`trustProxy`), `src/core/network.ts` (precedencia `request.ip`), `src/infra/env.ts` (`TRUST_PROXY`), `.env.example` + `rate-limiting.xff-bypass.test.ts` (T6-T7) + ajuste de `rate-limiting.test.ts` T-RL-8/T-RL-10 (R-1). → Exemplar: `app.ts:98-101,171`.

### Wave 3 (Base class — refactor behavior-preserving, SOLO src/chains/)
- W3.1: AC-5 — crear `src/chains/base-adapter.ts` extrayendo lógica byte-equivalente; migrar `kite.ts`/`avalanche.ts`/`base.ts` a `extends BaseEip3009Adapter`. SIN checks nuevos. Verificar 590+ tests verdes + T17/T18. **Commit separado.** → Exemplar: `kite.ts` clase.

### Wave 4 (Checks AC-4 — sobre W3, en la base class)
- W4.1: AC-4 — agregar `amount>0` / `payTo==to` / `validAfter` en `_verifyRaw` y `_settleRaw` de `base-adapter.ts` (orden §4.3-E). Tests T11-T15. **Commit separado de W3.** → Exemplar: `methods/eip3009/verify.ts:96-132`.

### Wave 5 (In-flight lock — sobre idempotency + settle route)
- W5.1: AC-3 — `src/core/idempotency.ts` (`setInflightSettleLock`/`releaseInflightSettleLock` + doc) + `src/routes/settle.ts` (insertar lock + release en todos los paths) + `routes.settle.inflight.test.ts` (T8-T10). → Exemplar: `idempotency.ts:319-330`.

### Dependencias entre waves

| Wave | Depende de | Razón |
|------|-----------|-------|
| W4.1 | W3.1 | Los checks van en la base class que W3 crea (CD-2). |
| W2.1 (test) | W2.1 (trustProxy) | El test XFF-spoof necesita trustProxy configurado. |
| W1, W2, W5 | — | Ortogonales entre sí (archivos distintos). |

### Verificación incremental

| Wave | Verificación |
|------|--------------|
| W0 | suite completa verde (baseline ≈591). |
| W1 | typecheck + tests de AC-1 y AC-6 + suite verde. |
| W2 | typecheck + tests XFF + suite verde (con T-RL-8/10 re-expresados). |
| W3 | typecheck + **suite completa SIN cambiar assertions** (CD-1/CD-2). |
| W4 | typecheck + T11-T15 + suite verde. |
| W5 | typecheck + T8-T10 + suite verde + full QA. |

## 12. Test Plan

| Test | AC | Wave | Framework | Qué cubre |
|------|-----|------|-----------|-----------|
| `routes.settle.auth.test.ts` T1-T5 | AC-1 | W1 | vitest+inject | sin header→401, wrong key→401, key válida→pipeline, `/verify` sin header→401, key ausente en test→bypass. |
| `core.settle-cap.test.ts` T19-T22 | AC-6 | W1 | vitest | `("abc","100")`→ok:false, `("100","abc")`→ok:false, `("0","100")`→ok:false, `("50","100")`→ok:true. |
| `rate-limiting.xff-bypass.test.ts` T6-T7 | AC-2 | W2 | vitest+inject | 5 requests misma IP real con XFF rotante→mismo bucket→429; `request.ip` refleja IP resuelta por Fastify. |
| (ajuste) `rate-limiting.test.ts` T-RL-8/T-RL-10 | AC-2 | W2 | vitest+inject | re-expresar: bajo trustProxy el XFF crudo NO separa cuotas (R-1). |
| `chain-adapter.test.ts` (intacto) T16 | AC-5 | W3 | vitest | toda la suite existente pasa sin cambiar assertions (behavior-preserving). |
| nuevo T17 (base class directa) | AC-5 | W3/W4 | vitest | instanciar la base con token mock + verificar `_verifyRaw`. |
| T18 (LOC) | AC-5 | W3 | manual/grep | `kite.ts`/`avalanche.ts`/`base.ts` <100 líneas; `base-adapter.ts` con la lógica. |
| `chains.{kite,base,avalanche}.test.ts` T11-T15 | AC-4 | W4 | vitest | `value="0"`/accepted 0→INVALID_AMOUNT; `to != payTo`→INVALID_RECEIVER; `validAfter` futuro→EXPIRED_AUTHORIZATION (distinto de validBefore-expired); idem `_settleRaw`; success regression. |
| `routes.settle.inflight.test.ts` T8-T10 | AC-3 | W5 | vitest+inject | 2 concurrentes→solo uno a `settleCore`, 2do→409; Redis down→skip graceful; doc preciso en `idempotency.ts`. |

## 13. Readiness Check

```
[x] Cada AC tiene >=1 archivo asociado en tabla 4.1 (AC-1..AC-6 mapeados).
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados).
[x] No hay [NEEDS CLARIFICATION] pendientes (2 markers resueltos en §10).
[x] Constraint Directives incluyen >=3 PROHIBIDO (6 listados en §5).
[x] Context Map tiene >=2 archivos leídos (16 leídos en §3).
[x] Scope IN y OUT explícitos y no ambiguos (§6).
[x] BD: tablas verificadas (facilitator_* existen; Redis namespace nuevo documentado).
[x] Happy Path completo (§4.4).
[x] Flujo de error definido (5 casos en §4.5).
[x] Money-safety documentado (§9) — obligatorio en servicio que mueve dinero.
[x] Baseline de tests identificado (≈591) para validar CD-1/CD-2.
```

> Todos los checks pasan. SDD listo para SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL*
