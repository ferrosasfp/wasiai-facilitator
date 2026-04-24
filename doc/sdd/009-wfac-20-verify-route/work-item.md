# Work Item — [WKH-WFAC-20] POST /verify route

## Resumen

Exponer por primera vez el facilitator como API HTTP pública implementando el endpoint
`POST /verify` del protocolo x402 (spec-literal). El route acepta el body x402 canónico,
valida con Zod, despacha al method adapter EIP-3009 vía chain registry, aplica
idempotency Redis (optional-fallback) y retorna la respuesta spec-literal.
Este es el endpoint de mayor valor del servicio: sin él no hay facilitator.

## Sizing

- SDD_MODE: full
- Estimación: L
- Pipeline: QUALITY (expone API pública, cruza routes + core + methods + chains + infra)
- Branch sugerido: `feat/009-wfac-20-verify-route`

---

## Acceptance Criteria (EARS)

### Happy path

- **AC-1**: WHEN a POST /verify request arrives with a well-formed x402 body (valid
  `x402Version`, `resource`, `accepted`, `payload`) for a registered chain and the
  EIP-3009 signature verifies correctly, the system SHALL return HTTP 200 with body
  `{ verified: true, client, amount, asset, network, payTo, expiresAt }` matching
  the x402 spec shape exactly (no extra top-level keys, no missing keys).

- **AC-2**: WHEN the route returns HTTP 200, the system SHALL emit a structured Pino
  log at `info` level containing the fields `{ msg: "verify ok", request_id, network,
  method: "eip3009", duration_ms }` with no PII (no signature hex, no private keys).

### Payload validation errors (Zod layer)

- **AC-3**: WHEN the POST /verify request body is missing any required top-level field
  (`x402Version`, `resource`, `accepted`, `payload`) or `x402Version !== 2`, the
  system SHALL return HTTP 400 with body `{ error: { code: "INVALID_PAYLOAD",
  message: <string>, http: 400 } }` and SHALL NOT invoke the chain adapter.

- **AC-4**: WHEN the POST /verify request body contains an `accepted.network` field
  that does not match the pattern `eip155:<positive-integer>`, the system SHALL return
  HTTP 400 with body `{ error: { code: "NETWORK_MISMATCH", message: <string>,
  http: 400 } }` before invoking the chain adapter.

### Unknown / unregistered network

- **AC-5**: WHEN the `accepted.network` field is a valid `eip155:<chainId>` format but
  the extracted `chainId` is not registered in the `chainRegistry`, the system SHALL
  return HTTP 400 with body `{ error: { code: "NETWORK_MISMATCH", message: <string>,
  http: 400 } }`.

### Signature invalid / business logic failures

- **AC-6**: WHEN the chain adapter's `verify()` returns `{ ok: false, error }`, the
  system SHALL return an HTTP response whose status code equals `error.http` and whose
  body is `{ error: { code, message, http } }` — using the exact values from the
  adapter result without modification.

- **AC-7**: WHEN the EIP-3009 authorization has a `validBefore` timestamp that is
  already past (expired), the system SHALL return HTTP 400 with `code:
  "EXPIRED_AUTHORIZATION"` (delegating to the adapter result — route SHALL NOT
  re-implement timestamp logic).

### Timing / timestamp edge

- **AC-8**: WHEN the EIP-3009 authorization has a `validAfter` timestamp that is in
  the future (not yet valid), the system SHALL return HTTP 400 with `code:
  "EXPIRED_AUTHORIZATION"` (delegating to the adapter result).

### Idempotency

- **AC-9**: WHILE Redis is available and a prior identical request (same idempotency
  key derived from the canonical SHA-256 of the serialized request body) was processed
  within the configured TTL, the system SHALL return the cached response with HTTP 200
  (or the original error HTTP code) and SHALL NOT re-invoke the chain adapter.

- **AC-10**: IF Redis is unavailable (connection error, null client), THEN the system
  SHALL log a `warn`-level structured message `{ msg: "idempotency cache miss — Redis
  unavailable", request_id }` and SHALL continue processing the request normally
  (graceful degradation — no 500).

### Logging and observability

- **AC-11**: WHEN any POST /verify request is processed (success or error), the system
  SHALL include a structured Pino log line with `request_id` (Fastify `reqId`) and
  `duration_ms` so that distributed tracing is possible without additional correlation
  headers.

- **AC-12**: WHEN the route handler returns an error response, the system SHALL log a
  structured `warn` or `error` level line containing `{ msg, request_id, error_code,
  http_status }` and SHALL NOT log the raw signature bytes or authorization payload
  fields.

### Content-type enforcement

- **AC-13**: IF the POST /verify request arrives with a `Content-Type` header other
  than `application/json`, THEN the system SHALL return HTTP 415 (or Fastify's
  default content-type rejection) before Zod validation runs.

---

## Scope IN

| Artefacto | Acción |
|-----------|--------|
| `src/routes/verify.ts` | Crear — Fastify plugin, POST /verify handler |
| `src/core/schemas.ts` | Crear — Zod schemas x402 canónicos para VerifyRequest + VerifyResponse |
| `src/core/verify.ts` | Crear — orquestador: parse network → registry lookup → adapter dispatch → idempotency |
| `src/core/idempotency.ts` | Crear — SHA-256 payload key + Redis get/set con TTL + null-safe fallback |
| `src/app.ts` | Modificar — registrar `verifyRoute` plugin |
| `src/__tests__/unit/routes.verify.test.ts` | Crear — unit tests via `app.inject()` |
| `src/__tests__/unit/core.verify.test.ts` | Crear — unit tests del core orchestrator |
| `src/__tests__/unit/core.idempotency.test.ts` | Crear — unit tests del idempotency module |

## Scope OUT

- `POST /settle` route — HU separada (WFAC-21 futuro)
- `GET /supported` route — HU separada
- `GET /metrics` — HU separada
- Middleware plugins (@fastify/cors, @fastify/helmet, @fastify/rate-limit) — HU separada o pre-requisito, no parte de este scope si no están registrados
- Supabase audit log (`facilitator_audit_log`) — V1.1
- BullMQ retry queue — V1.5
- Sentry error tracking — V1.1
- `permit2` y `erc7710` method dispatch — future HUs (solo `eip3009` en esta HU)
- Modificar `src/methods/eip3009/` — ya implementado; este work-item solo lo consume
- Modificar `src/chains/registry.ts` o chain adapters — ya implementados

---

## Decisiones técnicas (DT-N)

- **DT-1 — Schemas location**: los Zod schemas del request/response x402 viven en
  `src/core/schemas.ts` (no en `src/routes/`). Justificación: el project-context.md
  diagrama muestra `core/schemas.ts` como destino canónico; OWNERS.md dice que
  `routes/` importa de `src/core/*`. Los schemas method-specific
  (`src/methods/eip3009/schemas.ts`) permanecen en su módulo para respetar el boundary.

- **DT-2 — Core orchestrator vs route-inline logic**: se crea `src/core/verify.ts`
  como orquestador separado de `src/routes/verify.ts`. El route solo parsea/valida
  el body Zod, extrae el `chainId` del network string, llama al core, mapea el Result
  a HTTP. El core hace el registry lookup + method dispatch. Justificación: OWNERS.md
  establece que routes no conocen chains ni methods directamente.

- **DT-3 — Idempotency key strategy**: `SHA-256(JSON.stringify(body))` donde `body`
  es el body crudo recibido (antes de parse, string canónico del JSON que llegó).
  Alternativa considerada: hash solo de `payload.authorization` — rechazada porque dos
  requests con distinto `accepted.amount` y misma authorization serían tratados como
  iguales. Redis key prefix: `verify:idempotency:<hash>`. TTL: 120s (spec requirement,
  hard-coded como constante `VERIFY_IDEMPOTENCY_TTL_SEC = 120` en `core/idempotency.ts`).

- **DT-4 — Network string → chainId extraction**: el route (o el core) extrae el
  `chainId` numérico del string `"eip155:<N>"` via regex `/^eip155:(\d+)$/`. Si el
  string no matchea el patrón → responder NETWORK_MISMATCH 400 sin invocar el adapter.
  La conversión usa `asChainId()` de `src/core/types.ts` para obtener el branded type.

- **DT-5 — Method dispatch**: en esta HU solo se soporta `assetTransferMethod:
  "eip3009"`. El core orchestrator verifica `accepted.extra.assetTransferMethod ===
  "eip3009"` y llama a `adapter.verify(params)`. Si el value es otro string conocido
  (permit2, erc7710) se retorna `{ ok: false, error: { code: "NETWORK_MISMATCH",
  message: "Method not supported", http: 400 } }`. Si es desconocido → mismo error.
  La signature de `core/verify.ts` acepta `VerifyParams` completo (tipado en
  `src/chains/types.ts`).

- **DT-6 — Logging fields (request_id)**: Fastify v5 asigna `reqId` a cada request.
  El route lee `request.id` (string) y lo propaga como `request_id` en todos los logs
  estructurados del handler. No se requiere header personalizado en este scope (el
  middleware `request-id.ts` es HU separada). `duration_ms` se calcula como
  `Date.now() - startMs` al inicio del handler.

- **DT-7 — Error response shape**: el route devuelve `reply.code(error.http).send({
  error: { code, message, http } })` para errores de adapter. Para errores de
  validación Zod (AC-3) se usa un errorCode especial `"INVALID_PAYLOAD"` con HTTP 400.
  NOTA: `INVALID_PAYLOAD` no existe en `X402ErrorCode` de `src/core/types.ts` — se
  necesita decidir si se extiende el type union o si se usa un type local en el route.
  [NEEDS CLARIFICATION — no bloqueante, resoluble en F2: el Architect decide si ampliar
  X402ErrorCode o usar un literal local en el route para errores de input shape].

- **DT-8 — Fastify plugin pattern**: `src/routes/verify.ts` exporta
  `verifyRoute: FastifyPluginAsync` siguiendo el patrón de `health.ts`. `app.ts` hace
  `await app.register(verifyRoute)`.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que `src/routes/verify.ts` importe directamente de
  `src/chains/registry.ts`, `src/methods/eip3009/verify.ts` o cualquier módulo bajo
  `src/chains/` o `src/methods/`. El único punto de entrada desde routes es
  `src/core/verify.ts` (orquestador) — respeta OWNERS.md boundary.

- **CD-2**: OBLIGATORIO que el response body de HTTP 200 sea spec-literal:
  exactamente los campos `{ verified, client, amount, asset, network, payTo,
  expiresAt }` de `VerifyResult` en `src/chains/types.ts`. Ningún campo extra, ningún
  wrapper adicional.

- **CD-3**: PROHIBIDO loggear `params.payload.signature`, `params.payload.authorization.nonce`,
  o cualquier campo del `authorization` en texto plano en logs de producción. Solo
  metadata (request_id, duration_ms, network, method, error_code) está permitida.

- **CD-4**: OBLIGATORIO que `src/core/verify.ts` y `src/core/idempotency.ts` nunca
  lancen excepciones para errores previstos. Siempre retornan `Result<T>` o un
  discriminated union con `ok: false`. El route handler es el único que mapea a HTTP.

- **CD-5**: PROHIBIDO hacer `reply.send(result)` cuando `result.ok === false` sin
  setear el status code correcto vía `reply.code(result.error.http)`. Cada error path
  DEBE tener el HTTP code correcto.

- **CD-6**: OBLIGATORIO que los tests en `src/__tests__/unit/routes.verify.test.ts`
  usen `app.inject()` (no live port). El pattern de `health.test.ts` es la referencia.

- **CD-7**: PROHIBIDO hardcodear el TTL de idempotency como literal numérico en
  múltiples lugares. Usar la constante `VERIFY_IDEMPOTENCY_TTL_SEC = 120` declarada
  una sola vez en `src/core/idempotency.ts`.

- **CD-8**: OBLIGATORIO que el Zod schema del request en `src/core/schemas.ts` valide
  `x402Version` como literal `z.literal(2)` (no `z.number()`), consistente con el
  tipo `VerifyParams.x402Version: 2` definido en `src/chains/types.ts`.

---

## Waves sugeridas (para F2.5 Story File)

| Wave | Artefactos | Descripción |
|------|-----------|-------------|
| W0 | `src/core/schemas.ts` | Zod schemas x402 request/response. No deps nuevas. |
| W1 | `src/core/idempotency.ts` | SHA-256 key builder + Redis get/set/fallback. |
| W2 | `src/core/verify.ts` | Orquestador: schema validation + network parse + registry + adapter dispatch. |
| W3 | `src/routes/verify.ts` + `src/app.ts` | Fastify plugin + registro en buildApp. |
| W4 | `src/__tests__/unit/` (3 archivos) | Tests: routes, core/verify, core/idempotency. |

---

## Missing Inputs

- **[NEEDS CLARIFICATION — no bloqueante]** DT-7: `INVALID_PAYLOAD` no está en el
  `X402ErrorCode` union (10 codes spec). El Architect en F2 decide si: (a) extender
  el union con `INVALID_PAYLOAD` marcado como non-spec, (b) usar un literal local en
  el route, o (c) mapear errores Zod al code `NETWORK_MISMATCH` (más cercano en semántica).
  Se puede avanzar con F2 sin bloquear.

- **[NEEDS CLARIFICATION — no bloqueante]** Idempotency key: ¿hashear el body raw
  string o el objeto parseado re-serializado? Si el cliente envía campos en distinto
  orden, el hash del raw string puede diferir aunque el contenido sea el mismo.
  Decisión recomendada (para F2): hashear el objeto `VerifyParams` parseado + re-serializado
  via `JSON.stringify` con keys ordenados canónicamente — pero requiere decisión
  arquitectónica explícita. Marcado como [NEEDS CLARIFICATION].

- **[RESUELTO]** Shape exacto del request/response x402: documentado en
  `.nexus/project-context.md` sección "x402 Protocol — Referencia rápida" y en
  `src/chains/types.ts` (VerifyParams / VerifyResult). No hay ambigüedad.

- **[RESUELTO]** Existe `src/core/` como capa: sí, los archivos `errors.ts` y `types.ts`
  ya están. Faltan `schemas.ts`, `verify.ts`, `idempotency.ts` — todos en scope IN.

---

## Análisis de paralelismo

- Esta HU desbloquea `POST /settle` (WFAC-21) — settle route necesita el mismo patrón
  de core orchestrator + idempotency + schema base.
- Puede correr en paralelo con: infraestructura de middleware (CORS, rate-limit,
  request-id) ya que no hay acoplamiento directo.
- No bloquea ni es bloqueada por cambios en chain adapters (kite.ts, avalanche.ts).
- Depende de: WFAC-6 (verifyEip3009 — DONE), WFAC-4 (chainRegistry — DONE),
  WFAC-11 (errors.ts — DONE), WFAC-5 (Redis client — DONE), WFAC-13
  (signature normalization — in progress, 008; el merge de 008 es precondición
  para que el adapter funcione correctamente en prod, pero los tests pueden mockear).
