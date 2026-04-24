# Work Item — [WFAC-40] Rate Limiting Redis-backed

## Resumen

Implementar rate limiting por IP en el facilitator público usando `@fastify/rate-limit`
con Redis como store de contadores. El facilitator expone actualmente `/verify`,
`/settle` y `/supported` sin ningún control de flujo, dejando la infraestructura
expuesta a DoS, scraping y brute-force de nonces. Esta HU cierra ese vector con
límites diferenciados por ruta, fail-open cuando Redis está caído, y respuesta
x402-spec-compatible (HTTP 429) para clientes que excedan la cuota.

## Sizing

- SDD_MODE: full
- Estimación: M
- Pipeline: QUALITY (security-critical — DoS protection, env vars nuevas, nuevo plugin Fastify)
- Branch sugerido: `feat/015-wfac-40-rate-limiting`
- Skills: backend-security, platform-infra

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a client IP sends more than `RATE_LIMIT_VERIFY_MAX` requests to
  `POST /verify` within a `RATE_LIMIT_WINDOW_SEC` second window, THEN the system
  SHALL respond with HTTP 429 and stop processing the request before invoking any
  core or idempotency logic.

- **AC-2**: WHEN a client IP sends more than `RATE_LIMIT_SETTLE_MAX` requests to
  `POST /settle` within a `RATE_LIMIT_WINDOW_SEC` second window, THEN the system
  SHALL respond with HTTP 429 and stop processing the request before invoking any
  on-chain write.

- **AC-3**: WHEN a client IP sends more than `RATE_LIMIT_SUPPORTED_MAX` requests to
  `GET /supported` within a `RATE_LIMIT_WINDOW_SEC` second window, THEN the system
  SHALL respond with HTTP 429 and stop processing the request.

- **AC-4**: WHEN a rate-limited response is sent, the system SHALL return a JSON body
  with exactly the shape:
  ```json
  { "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later", "http": 429 } }
  ```
  The `Content-Type` SHALL be `application/json`.

- **AC-5**: WHEN a rate-limited response is sent, the system SHALL include the headers
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` in the
  response reflecting the current quota state for that IP and route.

- **AC-6**: WHILE `RATE_LIMIT_ENABLED=false` is set in the environment, the system
  SHALL skip all rate limiting and process requests normally for every route,
  including `/verify`, `/settle`, and `/supported`.

- **AC-7**: WHILE `RATE_LIMIT_ENABLED=true` (or the env var is absent/defaults to
  `true`), the routes `GET /health` and `GET /openapi.json` SHALL NOT be subject
  to any rate-limit check.

- **AC-8**: WHEN extracting the client IP for rate-limit key computation, the system
  SHALL use the first element of the `X-Forwarded-For` header when present,
  falling back to `request.ip` (reusing the proxy-aware extraction pattern
  established in WFAC-33 `src/app.ts` `onResponse` hook).

- **AC-9**: WHEN a request is rate-limited (HTTP 429), the system SHALL emit a
  structured `warn` log entry containing at minimum `request_id` and `path`.
  The log SHALL NOT contain the raw IP address (no PII in stdout).

- **AC-10**: IF the Redis store is unavailable or the connection times out during
  rate-limit counter read/write, THEN the system SHALL fail-open (allow the
  request to proceed) and NOT return 429 due to the Redis outage.

- **AC-11**: WHEN a rate-limited request arrives at a route covered by the WFAC-33
  audit hook (i.e., NOT `/health` or `/openapi.json`), the system SHALL persist
  an audit log entry with `status_code = 429` in `facilitator_audit_log`.
  This SHALL require no changes to the audit hook — the `onResponse` hook fires
  post-reply by Fastify v5 contract.

- **AC-12**: WHEN the `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_VERIFY_MAX`,
  `RATE_LIMIT_SETTLE_MAX`, or `RATE_LIMIT_SUPPORTED_MAX` env vars are set to
  values outside their valid ranges (non-positive integers), the system SHALL
  fail at startup (Zod parse fails in `parseEnv`) with a human-readable error
  on stderr and exit code 1.

---

## Scope IN

- `src/infra/env.ts` — add 5 new env var entries to `EnvSchema`:
  `RATE_LIMIT_ENABLED`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_VERIFY_MAX`,
  `RATE_LIMIT_SETTLE_MAX`, `RATE_LIMIT_SUPPORTED_MAX`
- `src/app.ts` — register `@fastify/rate-limit` plugin BEFORE route registration,
  configure global Redis store + error response handler + keyGenerator (proxy-aware IP)
- `src/routes/verify.ts` — add per-route `config: { rateLimit: { max, timeWindow } }`
  using values from env
- `src/routes/settle.ts` — same as verify.ts
- `src/routes/supported.ts` — same
- `src/routes/health.ts` — already has `config: { rateLimit: false }` (DT-future-proof
  noted in WFAC-2 CD-9); verify the existing declaration is sufficient, no change needed
- `src/routes/openapi.ts` — add `config: { rateLimit: false }` (mirrors health.ts pattern)
- Unit tests covering: fail-open when Redis null, 429 body shape, env var defaults,
  disabled mode, `RATE_LIMIT_ENABLED=false` bypass

## Scope OUT

- Per-user or per-API-key rate limiting (IP-only in this HU)
- Token bucket or sliding window algorithms (fixed window via `@fastify/rate-limit` default)
- `GET /health` and `GET /openapi.json` granular per-route limits (they are excluded)
- Redis RLS / data layer changes (no Supabase involvement)
- Changes to `facilitator_audit_log` schema or `src/core/audit.ts`
- Dynamic rate limit updates at runtime without restart
- Allowlist / denylist by IP

---

## Decisiones Técnicas

- **DT-1 — Plugin choice**: usar `@fastify/rate-limit` v10.3.0 (ya en `package.json`
  — no se instala nada nuevo). Battle-tested, Redis store nativo, integración con
  Fastify v5, rate-limit info headers incluidos out-of-the-box. Custom middleware
  descartado.

- **DT-2 — `RATE_LIMITED` code location**: NO extender `X402ErrorCode` en
  `src/core/types.ts`. El string literal `'RATE_LIMITED'` vive únicamente en la
  función `errorResponseBuilder` del plugin config en `src/app.ts` como una
  route-local union (patrón idéntico a `'INVALID_PAYLOAD'` en DT-7 de WFAC-20).
  Justificación: `X402ErrorCode` refleja los 10 códigos del spec x402 (docs.x402.org);
  `RATE_LIMITED` es una preocupación de infraestructura, no del spec del protocolo.
  Extenderla contaminaría el tipo spec-literal y rompería exhaustividad en
  `HTTP_BY_CODE` / `DEFAULT_MESSAGE_BY_CODE` de `src/core/errors.ts`.

- **DT-3 — Fail-open cuando Redis down**: si `getRedisClient()` retorna `null`
  (test env o Redis caído), el plugin `@fastify/rate-limit` se configura sin
  `redis` store, cayendo en el in-memory store por defecto — permitiendo requests
  sin límite. Esto es consistente con la política WFAC-5 de degradación graceful.
  Alternativa fail-closed (bloquear todo si Redis down) fue descartada: bloquear
  la API pública por outage de Redis es peor que permitir tráfico en exceso
  temporalmente.

- **DT-4 — IP extraction reuse**: el keyGenerator del plugin reutiliza la misma
  lógica proxy-aware de WFAC-33 (`X-Forwarded-For` first element, fallback
  `request.ip`). Para evitar duplicación se extrae a un helper
  `extractClientIp(request)` en `src/infra/ip.ts` o equivalente compartido,
  consumido tanto por el keyGenerator del rate-limit como por el `onResponse`
  hook de audit. [NEEDS CLARIFICATION: el Architect decidirá si el helper vive
  en `src/infra/` o inline en `src/app.ts` según boundary OWNERS.md — `middleware/`
  puede importar `infra/`, `app.ts` puede importar ambos].

- **DT-5 — Plugin registration order**: `@fastify/rate-limit` se registra en
  `buildApp()` ANTES de cualquier `app.register(route)`. Fastify v5: los plugins
  de decoración/hook deben registrarse antes de los plugins de ruta para que la
  config per-route `{ rateLimit: { max, timeWindow } }` sea reconocida.

- **DT-6 — Per-route config pattern**: los límites específicos de cada ruta se
  declaran vía el objeto `config` en el handler de Fastify
  (`app.get('/supported', { config: { rateLimit: { max, timeWindow } } }, handler)`).
  Los valores de `max` y `timeWindow` vienen de `env` (inyectado al plugin al
  momento de `buildApp`). No se usan magic numbers inline en las rutas.

- **DT-7 — `errorResponseBuilder`**: el plugin se configura con un
  `errorResponseBuilder` global que produce exactamente el shape
  `{ error: { code: 'RATE_LIMITED', message: '...', http: 429 } }` para toda
  respuesta 429 generada por rate-limit. El builder recibe `(req, context)`;
  el log `warn` con `request_id` + `path` se emite aquí (AC-9). PII-free:
  el IP NO aparece en el log payload.

---

## Constraint Directives

- **CD-1 — PROHIBIDO extender `X402ErrorCode`**: el string `'RATE_LIMITED'` NO
  debe aparecer en `src/core/types.ts`. Vive exclusivamente como literal en
  `src/app.ts` dentro del `errorResponseBuilder`.

- **CD-2 — OBLIGATORIO fail-open**: si Redis no está disponible, la API DEBE
  continuar sirviendo requests. PROHIBIDO bloquear tráfico por outage de Redis.

- **CD-3 — Response spec-literal**: el body de toda respuesta 429 generada por
  rate-limit DEBE tener exactamente los 3 campos `code`, `message`, `http` bajo
  `error`. PROHIBIDO agregar campos extra (e.g., `retryAfter`, `limit`).

- **CD-4 — PROHIBIDO PII en logs**: el `errorResponseBuilder` y cualquier log
  relacionado con rate-limiting NO DEBE incluir la IP del cliente en el payload
  estructurado de Pino. (IP va a DB en audit row, no a stdout).

- **CD-5 — OBLIGATORIO registro del plugin antes de rutas**: `app.register(rateLimit, ...)`
  DEBE preceder a todos los `app.register(xRoute)` en `buildApp()`.

- **CD-6 — OBLIGATORIO `config: { rateLimit: false }` en `/openapi.json`**:
  la ruta `openapiRoute` DEBE declarar exclusión explícita del rate-limit
  (mirrors el patrón existente de `/health` en WFAC-2 CD-9).

- **CD-7 — PROHIBIDO magic numbers**: los valores `max` y `timeWindow` en las
  rutas se leen SIEMPRE desde `env.RATE_LIMIT_*`. Prohibido hardcodear 60, 30
  u otro literal numérico en el plugin config o en los route handlers.

- **CD-8 — OBLIGATORIO env var validation en `parseEnv`**: las 5 vars nuevas
  deben estar en `EnvSchema` con defaults válidos, tipos coerced y rangos mínimos
  (ej. `min(1)` para los contadores). Fallar en startup si valores son inválidos
  (AC-12).

---

## Waves

- **Wave 1 — Env vars + plugin skeleton**: extender `EnvSchema` con las 5 vars
  nuevas. Registrar `@fastify/rate-limit` en `buildApp()` con config global
  (Redis store condicional, `errorResponseBuilder`, `keyGenerator`, defaults
  de fallback). Sin per-route config todavía. Tests: env parsing valid/invalid,
  plugin registration no-crash.

- **Wave 2 — Per-route limits + exclusiones**: agregar `config: { rateLimit: ... }`
  en `verifyRoute`, `settleRoute`, `supportedRoute`. Agregar `config: { rateLimit: false }`
  en `openapiRoute`. Verificar que `healthRoute` ya tiene la exclusión (WFAC-2
  CD-9). Tests: 429 disparado en cada ruta, excluidas pasan sin rate-limit.

- **Wave 3 — Edge cases + integration**: fail-open cuando Redis null (mock),
  `RATE_LIMIT_ENABLED=false` bypass, 429 body shape exacto, headers X-RateLimit-*
  presentes, log warn emitido sin IP, audit hook captura 429 (integration test).

---

## Missing Inputs

- [RESUELTO en DT-2] `RATE_LIMITED` no está en `X402ErrorCode` — se usa como literal
  local en `errorResponseBuilder`, no se extiende el tipo spec.
- [RESUELTO en DT-3] Fail-open vs fail-closed — fail-open (degradación graceful,
  consistente con WFAC-5).
- [NEEDS CLARIFICATION — Architect F2] Ubicación exacta del helper `extractClientIp`:
  `src/infra/ip.ts` (nuevo módulo) vs inline en `src/app.ts`. Decisión de boundary
  según OWNERS.md; no bloquea el work-item.
- [NEEDS CLARIFICATION — Architect F2] `@fastify/rate-limit` v10 con ioredis: la API
  espera un cliente Redis compatible. Confirmar que pasar la instancia de `getRedisClient()`
  (ioredis `Redis`) es directamente compatible sin wrapper, o si requiere
  `redis: { client: getRedisClient() }` vs otro shape de config.

---

## Análisis de paralelismo

- WFAC-40 depende de WFAC-33 (audit log) como prereq de infraestructura de `onResponse`
  hook — WFAC-33 está `in progress` (014), debe mergearse primero.
- WFAC-40 NO bloquea otras HUs conocidas.
- Puede ir en paralelo con cualquier HU que no toque `src/app.ts` o `src/infra/env.ts`.
