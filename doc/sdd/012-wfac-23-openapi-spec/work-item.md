# Work Item — [WFAC-23] OpenAPI 3.1 spec para todos los endpoints del facilitator

## Resumen

Se genera el contrato público OpenAPI 3.1 del wasiai-facilitator: cubre los 4
endpoints activos (`POST /verify`, `POST /settle`, `GET /supported`,
`GET /health`), se persiste como archivo estático `doc/openapi.yaml`, y se
sirve en runtime desde `GET /openapi.json`. No se incorporan librerías de
generación automática. El objetivo es que integradores externos y el ecosistema
WasiAI (wasiai-a2a, wasiai-v2) puedan descubrir el contrato sin leer el
código fuente.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Pipeline: FAST+AR
- Branch sugerido: `feat/012-wfac-23-openapi-spec`

**Justificación**: Approach híbrido (DT-1). Sin librerías nuevas en runtime.
Un archivo YAML + una route + un test de parseo/coherencia. Scope
perfectamente acotado, sin cambios en capas de negocio, sin migración de datos.
FAST+AR es suficiente — no hay decisiones arquitectónicas nuevas.

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a GET request is made to `/openapi.json`, the system SHALL
  respond with HTTP 200 and a body that is a valid JSON object containing
  `openapi: "3.1.0"` at the top level.

- **AC-2**: WHEN the OpenAPI spec is parsed, the system SHALL declare path
  entries for exactly `POST /verify`, `POST /settle`, `GET /supported`, and
  `GET /health` — no more, no fewer documented endpoints.

- **AC-3**: WHEN the OpenAPI spec is parsed, the system SHALL define a
  `VerifyRequest` schema whose required fields match the Zod
  `VerifyRequestSchema` exported from `src/core/schemas.ts` (fields:
  `x402Version`, `resource`, `accepted`, `payload`).

- **AC-4**: WHEN the OpenAPI spec is parsed, the system SHALL define a
  `SettleRequest` schema structurally identical to `VerifyRequest` (per
  `SettleRequestSchema = VerifyRequestSchema` in `src/core/schemas.ts`).

- **AC-5**: WHEN the OpenAPI spec is parsed, the system SHALL document all 10
  canonical `X402ErrorCode` values (`INVALID_SIGNATURE`,
  `INSUFFICIENT_BALANCE`, `PERMIT2_ALLOWANCE_REQUIRED`,
  `EXPIRED_AUTHORIZATION`, `NETWORK_MISMATCH`, `SIMULATION_FAILED`,
  `INVALID_AMOUNT`, `INVALID_RECEIVER`, `TRANSACTION_FAILED`,
  `DELEGATION_INVALID`) and their corresponding HTTP status codes matching
  `HTTP_BY_CODE` in `src/core/errors.ts`.

- **AC-6**: WHEN the OpenAPI spec is parsed, the system SHALL document the
  `GET /supported` 200 response with a `SupportedResponse` schema containing
  `chains` (array of `{ network, name, methods }`) and `methods` (array of
  strings), matching the shapes in `src/core/supported.ts`.

- **AC-7**: WHEN the OpenAPI spec is parsed, the system SHALL declare the spec
  `info.version` field equal to the `version` string in `package.json` (today
  `"0.1.0"`).

- **AC-8**: WHILE the Fastify server is running, `GET /openapi.json` SHALL
  serve the content of `doc/openapi.yaml` deserialized to JSON without any
  runtime YAML parsing library (the file is read and parsed at server startup,
  not per-request).

- **AC-9**: IF a test imports `doc/openapi.yaml` and calls an OpenAPI validator,
  THEN the system SHALL report zero validation errors against the OpenAPI 3.1.0
  JSON Schema.

- **AC-10**: IF the spec documents a path that does not correspond to an
  existing registered Fastify route, THEN the CI pipeline SHALL fail via the
  coherence test.

- **AC-11**: WHEN the OpenAPI spec is parsed, the system SHALL include a
  `GET /health` path entry documenting the 200 response shape with fields
  `status` (`"ok"` literal), `version` (string), `uptime` (number),
  `timestamp` (ISO 8601 string).

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `doc/openapi.yaml` | Spec estático — fuente de verdad |
| `src/routes/openapi.ts` | Nueva route `GET /openapi.json` que sirve el YAML parseado |
| `src/index.ts` | Registro de la nueva `openapiRoute` |
| `src/__tests__/unit/openapi.test.ts` | Test: parseable + validación 3.1 + coherencia de rutas |

---

## Scope OUT

- `GET /docs` con Swagger UI embebido — no incluido en esta HU. [NEEDS CLARIFICATION si el equipo lo necesita antes del primer integrador externo — si sí, es una HU separada WFAC-24]
- Generación automática desde Zod via `zod-to-openapi` — explícitamente fuera (DT-2)
- Cambios a `src/core/`, `src/methods/`, `src/chains/` — ninguno
- Cambios a schemas Zod existentes — ninguno
- Autenticación / security schemes en el spec — fuera del scope (el facilitator no tiene auth hoy)
- Webhook / async API spec — fuera del scope

---

## Decisiones técnicas

- **DT-1: Approach híbrido** — `doc/openapi.yaml` estático (authoritativo,
  versionable en git, legible en PR reviews) + route `GET /openapi.json` que
  sirve su contenido. Descartado approach dinámico via `@fastify/swagger`
  porque: (a) requiere nueva dependencia de producción, (b) el schema se
  infiere desde tipos TypeScript/Zod lo cual no es 100% fiel al x402 spec
  literal, (c) la surface de mantenimiento es mayor. Descartado YAML puro sin
  route porque los integradores programáticos prefieren JSON.

- **DT-2: Sin zod-to-openapi** — El YAML se escribe a mano mappeando las
  shapes ya conocidas de `src/core/schemas.ts` y `src/chains/types.ts`. Evita
  una dependencia de build adicional y mantiene el spec 100% bajo control
  editorial. Riesgo de drift (spec vs código) mitigado por AC-10 (test de
  coherencia de rutas).

- **DT-3: Parsing al startup, no por request** — La route `GET /openapi.json`
  lee y parsea `doc/openapi.yaml` una sola vez al registrar el plugin (similar
  al patrón de `health.ts` que lee `package.json` al cargar el módulo). El
  resultado se cachea en una constante del módulo. Esto evita I/O por request.
  Requiere un parser YAML; usar la librería `js-yaml` (devDependency — no
  necesita ir a producción si compilamos el parse en build, o puede ser
  dependencia de producción liviana). [NEEDS CLARIFICATION: ¿`js-yaml` como
  dependency o devDependency? — resoluble en F2 evaluando si el build incluye
  el parse en startup o se pre-bakeará a JSON]

- **DT-4: Ubicación del YAML** — `doc/openapi.yaml` (no raíz). Mantiene la
  raíz limpia y es coherente con el resto de la documentación técnica del
  proyecto en `doc/`.

- **DT-5: Versioning policy** — `info.version` del spec sigue `package.json#version`
  manualmente (sin auto-sync en esta HU). Cuando se bumpe la versión del
  package se actualiza el spec en el mismo commit. AC-7 lo valida en CI.

---

## Constraint Directives

- **CD-1**: PROHIBIDO importar `@fastify/swagger` o `@fastify/swagger-ui` en
  esta HU. Si en el futuro se decide adoptar Swagger UI, es una HU separada.

- **CD-2**: PROHIBIDO que `doc/openapi.yaml` documente un endpoint que no
  exista como route registrada en Fastify (AC-10 detecta esto).

- **CD-3**: PROHIBIDO que la route `GET /openapi.json` realice I/O de disco
  por request. El parse de YAML ocurre una sola vez al startup del módulo.

- **CD-4**: OBLIGATORIO que el spec use `openapi: "3.1.0"` (no 3.0.x). Los
  schemas deben usar JSON Schema draft 2020-12 features donde aplique (por
  ejemplo `const` en lugar de `enum` de un solo valor para `x402Version: 2`).

- **CD-5**: OBLIGATORIO que los response schemas de error definan los 3 campos
  exactos del `ErrorBody` real: `error.code`, `error.message`, `error.http`
  — ningún campo extra, ningún campo faltante.

- **CD-6**: PROHIBIDO hardcodear la versión del spec en la route. Debe leerla
  del `doc/openapi.yaml` parseado (que a su vez la toma de `package.json`
  manualmente — DT-5).

---

## Waves sugeridas

| Wave | Contenido | Salida |
|------|-----------|--------|
| W1 | Escribir `doc/openapi.yaml` completo (4 endpoints, todos los schemas, todos los error codes) | YAML válido |
| W2 | Implementar `src/routes/openapi.ts` + registrar en `src/index.ts` | `GET /openapi.json` responde 200 |
| W3 | `src/__tests__/unit/openapi.test.ts`: parseable + coherencia de rutas + validación 3.1 | CI verde |

---

## Missing Inputs

- **[NEEDS CLARIFICATION — non-blocking]** ¿`js-yaml` como `dependency` o
  `devDependency`? Si el servidor de producción necesita parsear YAML en
  startup (DT-3), debe ser `dependency`. Alternativa: pre-compilar el YAML a
  JSON en build time como artefacto estático. Resoluble en F2.

- **[NEEDS CLARIFICATION — non-blocking]** ¿Incluir `GET /metrics` (prom-client)
  en el spec? El endpoint existe via `prom-client` pero no hay route registrada
  explícitamente en el router Fastify (puede ser middleware). Si no está como
  route Fastify, queda fuera del scope por CD-2.

- **[RESUELTO]** Approach: híbrido (DT-1). No dinámico, no puro YAML.
- **[RESUELTO]** Todos los schemas de request/response están en `src/core/schemas.ts` y `src/chains/types.ts`.
- **[RESUELTO]** Los 10 error codes y su HTTP mapping están en `src/core/errors.ts`.

---

## Analisis de paralelismo

- Esta HU no bloquea ninguna otra HU activa — es puramente aditiva (nuevo
  archivo + nueva route de solo lectura).
- No tiene dependencias sobre ninguna HU pendiente.
- Puede correr en paralelo con cualquier HU que no toque `src/index.ts`
  (el registro de la route es una línea en ese archivo).
- WFAC-22 (011) debe estar en estado DONE antes de que esta HU vaya a
  producción para que `/supported` esté correctamente documentado y testeado.
  Dado que WFAC-22 está marcada "in progress" en el INDEX, verificar merge
  antes de F3.
