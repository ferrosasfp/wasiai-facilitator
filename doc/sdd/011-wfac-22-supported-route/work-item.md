# Work Item — [WFAC-22] GET /supported — Discovery Endpoint

## Resumen

Endpoint read-only `GET /supported` que expone las chains activas y los métodos de pago
soportados por el facilitator. Consumido por integradores (wasiai-v2, wasiai-a2a, terceros)
para saber qué chains y métodos pueden enviar antes de invocar `/verify` o `/settle`.
Sin body, sin autenticación, sin idempotency — la respuesta se deriva directamente del
`chainRegistry` singleton ya existente.

## Sizing

- **SDD_MODE**: mini
- **Estimación**: S
- **Pipeline**: FAST+AR
- **Branch sugerido**: `feat/011-wfac-22-supported-route`

Justificación FAST: endpoint puramente de lectura, sin on-chain write, sin idempotency,
sin Redis. Reutiliza el patrón Fastify plugin ya establecido en WFAC-20/21. Complejidad
de implementación es mínima — un `FastifyPluginAsync` de ~30 líneas + un módulo core de
~20 líneas. AR obligatorio porque es API pública que afecta contrato de integración.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `GET /supported` is called, the system SHALL respond with HTTP 200 and a
  JSON body with shape `{ chains: ChainSupportedItem[], methods: string[] }` where
  `ChainSupportedItem` is `{ network: string, name: string, methods: string[] }`.

- **AC-2**: WHEN `GET /supported` is called, the system SHALL populate `chains` by reading
  the live `chainRegistry.listAdapters()` at request time, so the response reflects
  whatever adapters are registered at boot — not a hardcoded list.

- **AC-3**: WHEN `GET /supported` is called with Kite Testnet registered, the system SHALL
  include `{ network: "eip155:2368", name: "Kite Testnet", methods: ["eip3009"] }` in
  `chains`.

- **AC-4**: WHEN `GET /supported` is called with Avalanche Fuji registered, the system SHALL
  include `{ network: "eip155:43113", name: "Avalanche Fuji", methods: ["eip3009"] }` in
  `chains`.

- **AC-5**: WHEN `GET /supported` is called, the system SHALL return `methods: ["eip3009"]`
  at the top-level as the union of all methods across all registered chains.

- **AC-6**: WHEN `GET /supported` is called with a non-GET HTTP method (POST, PUT, DELETE,
  PATCH), the system SHALL respond with HTTP 404 (Fastify default for unregistered routes)
  or 405, with no side effects.

- **AC-7**: WHEN `GET /supported` is called, the system SHALL emit a structured Pino log
  line at `info` level containing `{ request_id, chain_count, duration_ms }` and message
  `"supported ok"`.

- **AC-8**: WHEN `GET /supported` is called, the system SHALL NOT log any PII — no client
  IP, no user-agent, no authorization headers in the info-level line.

- **AC-9**: WHEN `GET /supported` is called and zero adapters are registered, the system
  SHALL return HTTP 200 with `{ chains: [], methods: [] }` (not a 500 or empty body).

- **AC-10**: IF `GET /supported` is called, THEN the system SHALL set
  `Content-Type: application/json` and the response SHALL be parseable as valid JSON by
  any RFC 8259-compliant parser.

## Scope IN

- `src/core/supported.ts` — new module: `getSupportedResponse()` pure function reading
  `chainRegistry.listAdapters()` and mapping to response shape + type `SupportedResponse`.
- `src/routes/supported.ts` — new Fastify plugin `supportedRoute: FastifyPluginAsync`
  handling `GET /supported`.
- `src/app.ts` — add `await app.register(supportedRoute)` (one line).
- `src/__tests__/unit/routes.supported.test.ts` — integration tests via `app.inject()`,
  same CaptureStream + fake-registry pattern from WFAC-20/21.

## Scope OUT

- OpenAPI / JSON Schema documentation for `/supported` — WFAC-23 (explicit future HU).
- Prometheus / metrics counter for `/supported` hits — out of scope.
- Cache-Control / ETag HTTP caching headers — no TTL defined; deferred if needed.
- GraphQL-style filtering (`?chain=eip155:2368`) — out of scope.
- Token list (`metadata.tokens`) in the response — out of scope; this is chain-discovery
  only, not asset-discovery.
- `src/chains/registry.ts` modifications — no changes to registry; reading only.
- `src/chains/types.ts` modifications — `ChainMetadata` already has `networkId` and `name`;
  no changes needed.
- Adding a `supportedMethods` field to `ChainAdapter` / `ChainMetadata` — methods list is
  derived in `supported.ts`, not stored in the adapter (see DT-1).

## Decisiones Técnicas

- **DT-1 — Methods derivation from registry, not adapter metadata**
  `ChainMetadata` does NOT have a `supportedMethods` field today. Adding one would require
  touching every adapter (kite.ts, avalanche.ts) and `ChainAdapterInitError` init path.
  Instead, `getSupportedResponse()` in `src/core/supported.ts` maps each `ChainMetadata`
  to a hardcoded `["eip3009"]` array — the only method active today. The per-chain methods
  array is kept in `supported.ts` as a module-level constant (`CHAIN_METHODS_DEFAULT`).
  When multi-method support lands (WFAC-permit2), that HU will add
  `ChainMetadata.supportedMethods?: readonly AssetTransferMethod[]` and update this module.
  Rationale: zero adapter changes in this HU; contained blast radius.

- **DT-2 — Response type defined in `src/core/supported.ts`, not in schemas.ts**
  `src/core/schemas.ts` contains x402 request schemas. The supported response is not a
  request schema and has no Zod validation need (it's built, not parsed). A plain TypeScript
  interface `SupportedResponse` in `src/core/supported.ts` is sufficient. No Zod overhead.

- **DT-3 — Route reads from registry at request time (live snapshot)**
  The response is computed on every request from `chainRegistry.listAdapters()`. This means
  if adapters are re-registered between boot and request (only possible in tests), the
  response reflects the live state. No caching at the route level (registry is in-process;
  `listAdapters()` is O(N) over a Map — negligible for N < 20 chains).

- **DT-4 — `src/core/supported.ts` boundary compliance (OWNERS.md)**
  `src/core/` MAY import `src/chains/registry.ts` (via `chainRegistry` singleton).
  `src/routes/supported.ts` MAY import `src/core/*`. Pattern is identical to how
  `src/routes/verify.ts` calls `src/core/verify.ts`. No boundary violation.

- **DT-5 — No Zod schema for GET /supported**
  The endpoint has no body and no query parameters to validate. Fastify handles the
  routing. No Zod layer needed in this route.

## Constraint Directives

- **CD-1**: PROHIBIDO que `src/routes/supported.ts` importe directamente de
  `src/chains/*` (registry, adapters). OBLIGATORIO pasar por `src/core/supported.ts`
  (mirrors CD-1 / CD-10 from OWNERS.md).

- **CD-2**: OBLIGATORIO que la respuesta HTTP sea construida campo por campo de forma
  explícita (no `reply.send(result)` directo). Mirrors the WFAC-21 anti-rest-spread lesson.

- **CD-3**: PROHIBIDO loguear PII en la línea info de éxito. Campos autorizados:
  `request_id`, `chain_count`, `duration_ms`. Sin `request.ip`, `request.headers`,
  `user-agent`.

- **CD-4**: PROHIBIDO que `GET /supported` tenga side effects (no escritura a Redis,
  no llamadas on-chain, no mutación de estado).

- **CD-5**: OBLIGATORIO registrar el plugin con `await app.register(supportedRoute)` en
  `src/app.ts`. PROHIBIDO llamar directamente a la función handler sin Fastify (mirrors
  CD-7 from SDD 001).

- **CD-6**: OBLIGATORIO que el test use `app.inject()` — sin live ports, sin supertest.

- **CD-7**: PROHIBIDO hardcodear `"Kite Testnet"`, `"eip155:2368"`, `"Avalanche Fuji"`,
  `"eip155:43113"` en `src/routes/supported.ts` o `src/core/supported.ts`. Los nombres
  y networkIds vienen del `chainRegistry` en runtime.

## Waves

- **W0 — Core module** (`src/core/supported.ts`):
  Define `SupportedResponse` type + `ChainSupportedItem` type + `getSupportedResponse()`
  pure function. No I/O. Zero runtime deps beyond `../chains/registry.js`.

- **W1 — Route plugin** (`src/routes/supported.ts`):
  `GET /supported` handler: call `getSupportedResponse()`, log structured line, reply 200.
  Register in `src/app.ts`.

- **W2 — Tests** (`src/__tests__/unit/routes.supported.test.ts`):
  CaptureStream + fake registry (mirrors routes.verify.test.ts pattern).
  Cover AC-1 through AC-10.

## Missing Inputs

- **[resuelto en F2]** `CHAIN_METHODS_DEFAULT` value: `["eip3009"]` es el único método
  activo. Cuando WFAC-permit2 llegue, Architect decide si `ChainMetadata` absorbe el
  campo o si `supported.ts` recibe la lista por configuración. Sin bloqueo para esta HU.

- **[resuelto en F2]** El `network` field en la respuesta — el HU propone `"eip155:2368"`
  que corresponde a `ChainMetadata.networkId`. Confirmado: `kite.ts` y `avalanche.ts`
  ambos tienen `networkId: \`eip155:\${chainIdNum}\`` — no hay gap.

## Análisis de paralelismo

- No bloquea ninguna HU conocida (es un endpoint de lectura sin dependencias hacia adelante).
- Puede correr en paralelo con cualquier WFAC de la columna "infra" que no toque
  `src/app.ts`.
- WFAC-23 (OpenAPI docs) depende de esta HU estar done (necesita el shape real del endpoint).
- No hay conflicto con WFAC-21 (ya merged en main).
