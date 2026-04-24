# SDD — WFAC-20 POST /verify route

- **Work Item**: [`doc/sdd/009-wfac-20-verify-route/work-item.md`](./work-item.md)
- **Pipeline**: QUALITY
- **Status**: in progress
- **Branch**: `feat/009-wfac-20-verify-route`
- **Sizing**: L · SDD_MODE: full
- **Architect**: nexus-architect (F2)
- **Fecha**: 2026-04-23

---

## 1. Context + Goals

Primer endpoint HTTP público del facilitator. `POST /verify` recibe un body x402 canónico,
lo valida con Zod en el borde (shape), orquesta en `src/core/verify.ts` (parse de
`eip155:<chainId>` → lookup en `chainRegistry` → dispatch al method adapter EIP-3009),
aplica idempotency cache 120s (Redis con fallback graceful a pass-through) y retorna la
respuesta spec-literal `{ verified, client, amount, asset, network, payTo, expiresAt }`.

**Deliverable**: 4 archivos nuevos en `src/` + 1 modificación (`src/app.ts`) + 3 suites
de tests unitarios. Sin tocar `src/chains/*` ni `src/methods/*`. Respeta boundaries
OWNERS: el route consume solo `src/core/*`; el core dispatchea al adapter vía registry.

---

## 2. Architecture Decisions (resuelven los NEEDS CLARIFICATION del work-item)

### DT-7 · resolution — error code para fallas de input shape

**Decisión**: **(b) usar literal local en el route — NO extender `X402ErrorCode`**.

- El route (capa HTTP) introduce un type local `VerifyRouteErrorCode = X402ErrorCode | 'INVALID_PAYLOAD'`
  declarado en `src/routes/verify.ts` (no exportado fuera del archivo).
- El body de respuesta sigue siendo `{ error: { code, message, http } }` pero `code` es
  del union extendido local.
- `INVALID_PAYLOAD` se emite **solo** en fallos de `VerifyRequestSchema.safeParse()` del
  propio route. Nunca es emitido por `src/core/*` ni por el adapter.
- `NETWORK_MISMATCH` sigue siendo el code para fallas de parsing `eip155:<chainId>` (AC-4, AC-5):
  estas son errores semánticos del campo `network`, no de shape general.

**Justificación**:

| Criterio | (a) Extender union | (b) Literal local (ELEGIDA) | (c) Mapear a NETWORK_MISMATCH |
|----------|--------------------|-----------------------------|-------------------------------|
| Spec-conformance | Rompe: 10 codes son contrato x402 docs.x402.org | Preservado: core/types.ts intacto | Preservado pero confunde semántica (network no es bad shape) |
| OWNERS boundaries | `core/types.ts` lo usan `methods/*` y `chains/*` — cambio cruza 3 capas | Cero cambios cross-module | Cero cambios cross-module |
| Exhaustividad compile-time | `HTTP_BY_CODE[code]` y `DEFAULT_MESSAGE_BY_CODE[code]` fuerzan cobertura (ok) | Route declara su propio HTTP mapping local (trivial: 400) | Reusa `HTTP_BY_CODE['NETWORK_MISMATCH']` = 400 (ok) |
| Clarity para integrator | "INVALID_PAYLOAD" = shape bug, claro | "INVALID_PAYLOAD" = shape bug, claro | Integrator recibe NETWORK_MISMATCH por body mal formado → confuso |
| AR risk (money-moving) | Alto (tocar core/types.ts en HU de route) | Cero | Cero |

**Impacto en CD-3 del work-item (logging)**: el log line emit para errores con code
`INVALID_PAYLOAD` sigue los mismos filtros (no PII, no signature, no authorization fields).
Se agrega a CD-3 explícitamente como code logueable.

**Impacto en AC-3**: el body de respuesta HTTP 400 es exactamente
`{ error: { code: "INVALID_PAYLOAD", message: "<zod-issue-derived>", http: 400 } }`.

### DT-Idempotency · key canon — hash del objeto parseado re-serializado canónicamente

**Decisión**: hashear el **objeto `VerifyParams` post-parse de Zod**, re-serializado con
`JSON.stringify(value, Object.keys(value).sort())` aplicado recursivamente (canonical JSON).

- La key es `verify:idempotency:sha256(<canonicalJson(parsed)>)`.
- NO se usa el raw body string recibido: dos requests con los mismos valores pero orden
  distinto de keys (ej. `{"x402Version":2,"resource":…}` vs `{"resource":…,"x402Version":2}`)
  deben cachear como idempotentes — la spec no impone orden de keys.
- La serialización canónica se hace con un helper pequeño `canonicalStringify(value)` en
  `src/core/idempotency.ts`: recorre recursivamente objetos y ordena keys alfabéticamente.
  Arrays preservan orden. Primitivos se serializan directamente.

**Justificación**:
1. **Conformancia con spec**: x402 no mandata orden de keys — dos requests lógicamente
   iguales deben producir la misma idempotency key.
2. **Evita ambigüedad de whitespace**: el raw body puede venir con `\n` pretty-printed o
   compact — hashear post-parse elimina ese ruido.
3. **Rechaza bodies malformados antes del hash**: si Zod falla, retornamos
   `INVALID_PAYLOAD` sin intentar idempotency. No cacheamos requests malformados.
4. **Reproducible**: tests pueden construir el objeto esperado y calcular la key sin
   emular el formato exacto del HTTP client.

**Contra-argumento considerado**: hashear raw body es más barato (sin re-serialize).
Rechazado porque el costo de `JSON.stringify` sobre un objeto típico de ~500 bytes es
despreciable (<50μs) vs el riesgo de falsos negativos en cache.

### DT-Log · campos EXACTOS por log line

Cada log line emit por `src/routes/verify.ts` sigue una de estas 4 plantillas. **Sin PII**
(ver CD-3 heredado).

| Line | Level | Trigger | Shape exacto |
|------|-------|---------|--------------|
| L1 | `info` | AC-1 (200 verified) | `{ msg: "verify ok", request_id, network, method: "eip3009", duration_ms }` |
| L2 | `warn` | AC-10 (Redis unavailable) | `{ msg: "idempotency cache miss — Redis unavailable", request_id }` |
| L3 | `warn` | AC-12 (4xx adapter or validation error) | `{ msg: "verify failed", request_id, error_code, http_status, duration_ms }` |
| L4 | `error` | Adapter threw (shouldn't happen per service-layer contract, but defense-in-depth) | `{ msg: "verify adapter threw", request_id, err, duration_ms }` |

**Campos PROHIBIDOS en todas las líneas** (CD-3 extensión):
- `signature` (hex, completo o parcial)
- `authorization.nonce`, `authorization.from`, `authorization.to`, `authorization.value`,
  `authorization.validAfter`, `authorization.validBefore`
- `payload` object en crudo
- `body` raw string

**Campo `error_code` en L3**: es el string del union `X402ErrorCode | 'INVALID_PAYLOAD'`
(los 10 codes spec + el literal local). Nunca el `err.message` de Zod o de viem.

### DT-Zod · mapeo de Zod issue → `error.message`

Cuando `VerifyRequestSchema.safeParse(body)` falla, el route extrae el **primer issue**
(por determinismo en tests) y construye el message así:

```
message = `${issue.path.join('.')}: ${issue.message}`
```

Ejemplos:
- `x402Version` literal mismatch → `"x402Version: Invalid literal value, expected 2"`
- `payload.authorization.nonce` regex → `"payload.authorization.nonce: must be 0x-prefixed 32-byte hex"`
- `accepted.amount` refinement → `"accepted.amount: must be a canonical decimal uint256 string"`

Si `issue.path` está vacío (error top-level), el prefijo es `"body"`. La longitud del
message se capea en 200 chars (truncado con `…`) para evitar logs gigantes.

**Justificación**: el integrator necesita saber QUÉ campo falló sin devolver el object
issue completo de Zod (que incluye `received`, potencialmente con datos sensibles). El
path + message conforma un error human-readable estable.

---

## 3. Waves detalladas (W0 → W4)

### W0 — `src/core/schemas.ts` (Zod schemas x402 canónicos)

**Artefacto**: crear `src/core/schemas.ts`.

**Exports**:
- `ResourceSchema: ZodObject` — `{ url: string, description?: string, mimeType?: string }`.
- `AcceptedExtraSchema: ZodObject` — `{ assetTransferMethod: enum("eip3009","permit2","erc7710"), name?: string, version?: string }`.
- `AcceptedSchema: ZodObject` — `{ scheme: literal("exact"), network: string.min(1), amount: Uint256StringSchema, asset: AddressHexSchema, payTo: AddressHexSchema, maxTimeoutSeconds: number.int().positive(), extra: AcceptedExtraSchema }`.
- `PayloadSchema: ZodObject` — `{ signature: HexSchema, authorization: Eip3009AuthorizationSchema }`.
- `VerifyRequestSchema: ZodObject` — `{ x402Version: z.literal(2), resource: ResourceSchema, accepted: AcceptedSchema, payload: PayloadSchema }`.
- `VerifyRequest = z.infer<typeof VerifyRequestSchema>` (type-only export).

**Imports permitidos** (OWNERS): `zod`, `../methods/eip3009/schemas.js` (re-usa
`AddressHexSchema`, `Bytes32HexSchema`, `Uint256StringSchema`, `Eip3009AuthorizationSchema`).

**Prohibido**: importar `src/chains/*`, `src/routes/*`, `src/infra/*` en runtime.

**Dependencias entre waves**: W0 no depende de nada. Es el primer bloque.

**Criterios de completion**:
- Compila con `tsc --noEmit`.
- `AcceptedSchema.safeParse` acepta el JSON canonical de la spec (fixture happy path).
- El schema produce `VerifyRequest` asignable a `VerifyParams` de `src/chains/types.ts`
  vía type compatibility (enforced por tests type-level).

**Tests en esta wave**: ninguno — los tests de schemas viven en W4 (`core.verify.test.ts`
ejerce VerifyRequestSchema vía `app.inject`).

### W1 — `src/core/idempotency.ts` (SHA-256 key + Redis optional cache)

**Artefacto**: crear `src/core/idempotency.ts`.

**Exports**:
- `VERIFY_IDEMPOTENCY_TTL_SEC = 120` (const, single source — CD-7 heredado).
- `VERIFY_IDEMPOTENCY_KEY_PREFIX = "verify:idempotency:"` (const).
- `canonicalStringify(value: unknown): string` — JSON con keys ordenadas recursivamente.
- `buildIdempotencyKey(parsed: VerifyRequest): string` — retorna `${PREFIX}${sha256(canonicalStringify(parsed))}`.
- `getCachedVerifyResponse(key: string): Promise<Result<CachedVerifyResponse> | null>` —
  null = cache miss (ok, seguir); Result = hit (devolver tal cual al caller).
- `setCachedVerifyResponse(key: string, payload: CachedVerifyResponse): Promise<void>` —
  set con TTL 120s, swallowea errores (logs warn internamente si logger disponible).

**Signaturas detalladas**:
```ts
// CachedVerifyResponse: lo que cacheamos. Union del success payload + error payload.
export type CachedVerifyResponse =
  | { readonly ok: true; readonly response: VerifyResult }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly http: number } };
```

**Imports permitidos** (OWNERS core → infra ok):
- `crypto` (node stdlib, `createHash`).
- `../infra/redis.js` (`getRedisClient`).
- `./schemas.js` (tipo `VerifyRequest`).
- type-only: `pino.Logger`.

**Semantics fallback (AC-10)**:
- `getCachedVerifyResponse`: si `getRedisClient()` retorna `null` → retorna `null` (cache miss).
  Si `redis.get(key)` throws → catchea internamente, retorna `null`, no propaga.
- `setCachedVerifyResponse`: mismo patrón — si null client o set falla, swallowea.
- El caller (route) es responsable de detectar el null-client path y emitir L2 log warn.
  Para eso, `idempotency.ts` exporta un helper boolean `isRedisAvailable(): boolean` que
  retorna `getRedisClient() !== null`.

**Dependencias**: W1 depende de W0 (importa `VerifyRequest` type).

**Criterios de completion**:
- `buildIdempotencyKey` es determinista sobre permutaciones de key order del objeto.
- Con `REDIS_URL` undefined (test env), `getCachedVerifyResponse` retorna null sin throw.
- Con Redis mock que throws en `.get()`, la función igual retorna null.

**Tests en W4**: `src/__tests__/unit/core.idempotency.test.ts` — 8 tests mínimo (ver §4).

### W2 — `src/core/verify.ts` (orchestrator)

**Artefacto**: crear `src/core/verify.ts`.

**Export único**:
```ts
export async function verifyCore(
  parsed: VerifyRequest,
): Promise<Result<VerifyResult>>
```

**Flow interno** (no throws — siempre Result):

1. Extraer `chainId` del string `parsed.accepted.network` via regex `/^eip155:([1-9]\d*)$/`.
   - Si no matchea → retornar `{ ok: false, error: buildX402Error('NETWORK_MISMATCH', 'network must be eip155:<chainId> with positive integer') }`.
   - Si `Number(match[1])` supera `Number.MAX_SAFE_INTEGER` → retornar NETWORK_MISMATCH
     (`chainId out of safe integer range`).
   - Si matchea → `chainId = asChainId(n)` dentro de try/catch; si `asChainId` throws
     (defensive, no debería pasar dado el regex), retornar NETWORK_MISMATCH.

2. Dispatch method:
   - Si `parsed.accepted.extra.assetTransferMethod !== 'eip3009'` → retornar
     `{ ok: false, error: buildX402Error('NETWORK_MISMATCH', 'Method not supported: only eip3009 in v1') }`.
   - (En HUs futuras, este bloque se convierte en switch.)

3. Lookup en registry:
   - `const lookup = chainRegistry.getAdapter(chainId);`
   - Si `!lookup.ok` → retornar `{ ok: false, error: lookup.error }` (el registry ya
     retorna NETWORK_MISMATCH http 400 para unknown chain — spec match).

4. Build `VerifyParams` para el adapter:
   - `parsed` ya matchea `VerifyRequest` que es **asignable** a `VerifyParams` (ver W0).
   - Cast type-safe: `const params: VerifyParams = parsed;`
   - Justificación: `VerifyRequest` (Zod-infer) debe superset-align con `VerifyParams`
     (branded hex types `0x${string}`, readonly). El schema en W0 usa
     `.transform((s) => s as 0x${string})` donde corresponde.

5. Invocar adapter:
   - `const result = await lookup.adapter.verify(params);`
   - Si `adapter.verify` throws (violación de contrato), dejamos que propague — el route
     lo atrapa y emite L4 log. `src/core/verify.ts` NO captura; esto preserva exhaustive
     typing del Result.
   - **Contradicción con CD-4?** No: CD-4 dice que `core/verify.ts` nunca throw **para
     errores previstos**. Una excepción del adapter es un bug, no un error previsto.

6. Retornar el `result` (passthrough — el shape ya matchea `Result<VerifyResult>` porque
   `AdapterResult<T>` es alias de `Result<T>`).

**Imports permitidos** (OWNERS core):
- `./types.js` (`Result`, `ChainId`, `asChainId`).
- `./errors.js` (`buildX402Error`).
- `./schemas.js` (type `VerifyRequest`).
- `../chains/registry.js` (`chainRegistry` — route NO puede importar esto, pero core SÍ vía registry interface).
- type-only: `../chains/types.js` (`VerifyParams`, `VerifyResult`).

**Prohibido**: importar `src/methods/*` directamente — el dispatch pasa por el adapter
obtenido del registry.

**Dependencias**: W2 depende de W0 + W1 (aunque idempotency es owned por el route, no
por core — ver DT-2 del work-item). Technicaly W2 solo depende de W0.

**Criterios de completion**:
- Retorna siempre `Result<VerifyResult>` (type-checked).
- Cobertura de 4 paths: network malformed, method not supported, chain not registered,
  adapter success/fail (passthrough).

### W3 — `src/routes/verify.ts` + `src/app.ts` (plugin Fastify)

**Artefactos**:
- Crear `src/routes/verify.ts`.
- Modificar `src/app.ts` — agregar `await app.register(verifyRoute);` después de `healthRoute`.

**`src/routes/verify.ts`**:

```ts
export const verifyRoute: FastifyPluginAsync = async (app) => {
  app.post('/verify', async (request, reply) => {
    const startMs = Date.now();
    const requestId = request.id;

    // Paso 1: Zod validation (DT-7 → INVALID_PAYLOAD)
    const parseResult = VerifyRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : 'body';
      const rawMsg = issue?.message ?? 'invalid';
      const message = `${path}: ${rawMsg}`.slice(0, 200);
      return sendError(reply, 'INVALID_PAYLOAD', message, 400, { requestId, startMs, app });
    }
    const parsed = parseResult.data;

    // Paso 2: Idempotency cache lookup
    const idempotencyKey = buildIdempotencyKey(parsed);
    const redisAvailable = isRedisAvailable();
    if (redisAvailable) {
      const cached = await getCachedVerifyResponse(idempotencyKey);
      if (cached) {
        return sendCachedResponse(reply, cached, { requestId, startMs, app, network: parsed.accepted.network });
      }
    } else {
      app.log.warn({ request_id: requestId }, 'idempotency cache miss — Redis unavailable');
    }

    // Paso 3: Dispatch al core orchestrator
    let result;
    try {
      result = await verifyCore(parsed);
    } catch (err: unknown) {
      app.log.error(
        { msg: 'verify adapter threw', request_id: requestId, err, duration_ms: Date.now() - startMs },
        'verify adapter threw',
      );
      return reply.code(500).send({
        error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 },
      });
    }

    // Paso 4: Cachear (si redis up)
    if (redisAvailable) {
      await setCachedVerifyResponse(idempotencyKey, toCacheable(result));
    }

    // Paso 5: Mapear a HTTP
    if (!result.ok) {
      app.log.warn(
        { msg: 'verify failed', request_id: requestId, error_code: result.error.code, http_status: result.error.http, duration_ms: Date.now() - startMs },
        'verify failed',
      );
      return reply.code(result.error.http).send({ error: result.error });
    }

    app.log.info(
      { msg: 'verify ok', request_id: requestId, network: parsed.accepted.network, method: 'eip3009', duration_ms: Date.now() - startMs },
      'verify ok',
    );
    // CD-2: spec-literal response — stripear ok (interno) y retornar exactamente los 7 fields.
    const { ok: _ok, ...spec } = result;
    return reply.code(200).send(spec);
  });
};
```

**Helpers internos del archivo** (no exportados):
- `sendError(reply, code, message, http, ctx)` — emite L3 log + reply con body `{ error }`.
- `sendCachedResponse(reply, cached, ctx)` — emite `info` log (msg: "verify ok (cached)")
  + reply con el payload cacheado.
- `toCacheable(result: Result<VerifyResult>): CachedVerifyResponse` — convierte al shape
  cacheable.

**Imports permitidos** (OWNERS routes):
- `fastify` (type `FastifyPluginAsync`).
- `../core/schemas.js` (`VerifyRequestSchema`, type `VerifyRequest`).
- `../core/verify.js` (`verifyCore`).
- `../core/idempotency.js` (`buildIdempotencyKey`, `getCachedVerifyResponse`, `setCachedVerifyResponse`, `isRedisAvailable`).

**Prohibido**: importar `src/chains/*`, `src/methods/*`, `src/infra/*` — CD-1 heredado.

**`src/app.ts` cambio**:
```ts
import { verifyRoute } from './routes/verify.js';
// …
await app.register(healthRoute);
await app.register(verifyRoute);  // <— nueva línea
```

**Criterios de completion**:
- `app.inject({ method: 'POST', url: '/verify', payload: <fixture> })` retorna 200 con
  shape exacto (AC-1).
- `app.inject` con body malformado retorna 400 con `INVALID_PAYLOAD` (AC-3).

### W4 — Tests (3 archivos)

Ver §4 para test plan completo. Artefactos:

1. `src/__tests__/unit/core.schemas.test.ts` (**nuevo — no estaba en work-item scope IN pero requerido para cobertura de AC-3/AC-4**; agregado aquí por defecto de rigor. El
   work-item list 3 archivos de test, pero el test de schemas puro se fusiona en
   `core.verify.test.ts` para mantener el conteo en 3 archivos como scope).

   **Decisión final**: mantener el scope original del work-item (3 archivos). Los tests
   de schema se escriben dentro de `core.verify.test.ts` en un `describe('VerifyRequestSchema')`.

2. `src/__tests__/unit/core.idempotency.test.ts`.
3. `src/__tests__/unit/core.verify.test.ts`.
4. `src/__tests__/unit/routes.verify.test.ts`.

**Dependencias**: W4 depende de W0 + W1 + W2 + W3.

**Criterios de completion**:
- 100% de ACs cubiertos con ≥1 test cada uno.
- Suite `npm run test` verde.
- `npm run typecheck` verde.
- `npm run lint` verde.

---

## 4. Test Plan por AC (≥1 test por AC · 13 ACs · ≥15 tests totales)

| AC | Test file | Test case name | Strategy |
|----|-----------|----------------|----------|
| AC-1 | `routes.verify.test.ts` | "POST /verify returns 200 with exact spec shape for valid EIP-3009 request" | Integration via `app.inject()` — mock chainRegistry via `_resetForTesting()` + register fake adapter whose `verify()` returns a fixed `VerifyResult` fixture. Assert body keys = `['amount','asset','client','expiresAt','network','payTo','verified']` (sorted). |
| AC-2 | `routes.verify.test.ts` | "emits info log 'verify ok' with {request_id, network, method, duration_ms} and no PII on 200" | Same pattern as AC-1 + CaptureStream. Parse log line by `msg: "verify ok"`, assert exact field set + absence of `signature`, `authorization`, `payload`. |
| AC-3 | `routes.verify.test.ts` | "POST /verify returns 400 INVALID_PAYLOAD when x402Version missing" + "…when x402Version !== 2" + "…when resource missing" | `app.inject` with malformed bodies. Assert body = `{ error: { code: 'INVALID_PAYLOAD', message: <string>, http: 400 } }`. Assert `chainRegistry.getAdapter` NOT called (spy). |
| AC-4 | `routes.verify.test.ts` | "POST /verify returns 400 NETWORK_MISMATCH when accepted.network doesn't match eip155:<N>" | `network = "solana:1"`, `network = "eip155:abc"`, `network = "eip155:-1"`, `network = "eip155:"`. All must return 400 with code `NETWORK_MISMATCH`. Spy on adapter → NOT called. |
| AC-5 | `routes.verify.test.ts` | "POST /verify returns 400 NETWORK_MISMATCH when chainId not registered" | `network = "eip155:999999"`. Registry empty (only fake adapter for 2368 registered). Assert 400 NETWORK_MISMATCH. |
| AC-6 | `routes.verify.test.ts` | "passes through adapter error verbatim (code/message/http)" | Fake adapter returns `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'custom', http: 401 } }`. Assert response body = `{ error: { code: 'INVALID_SIGNATURE', message: 'custom', http: 401 } }` and statusCode = 401. |
| AC-7 | `routes.verify.test.ts` | "returns 400 EXPIRED_AUTHORIZATION when adapter reports expired (delegation)" | Fake adapter returns `EXPIRED_AUTHORIZATION` / http 400. Assert passthrough. Route MUST NOT re-check timestamps. |
| AC-8 | `routes.verify.test.ts` | "returns 400 EXPIRED_AUTHORIZATION when adapter reports not-yet-valid (delegation)" | Same as AC-7 with different message. |
| AC-9 | `routes.verify.test.ts` | "returns cached response when idempotency key hits (same request twice)" | Mock ioredis with in-memory Map. First `inject` stores, second `inject` returns cached, adapter spy called ONCE. Assert body identical between calls. |
| AC-10 | `routes.verify.test.ts` | "graceful degradation: logs warn and proceeds when Redis unavailable" | `REDIS_URL` undefined (test env). `inject` happy path → adapter called, response 200. CaptureStream asserts line `msg: 'idempotency cache miss — Redis unavailable'` with `request_id`. |
| AC-11 | `routes.verify.test.ts` | "every response (success + error) includes a log line with request_id and duration_ms" | Loop 4 cases (200, 400 INVALID_PAYLOAD, 400 NETWORK_MISMATCH, 401 INVALID_SIGNATURE via mock). For each, at least one log line must have `request_id` + `duration_ms`. |
| AC-12 | `routes.verify.test.ts` | "error responses emit warn log with {error_code, http_status} and no PII" | For each error case, assert warn log present + absence of `signature`, `authorization.nonce`, `authorization.value`, `payload`. |
| AC-13 | `routes.verify.test.ts` | "returns 415 when Content-Type is text/plain" | `app.inject({ headers: { 'content-type': 'text/plain' }, payload: '{}' })`. Fastify rejects before handler. Assert statusCode in `[415, 400]` (Fastify v5 default: 415). |

**Tests adicionales (no ligados 1:1 a AC pero críticos)**:

| Extra | Test file | Test case name |
|-------|-----------|----------------|
| T-E1 | `core.verify.test.ts` | "verifyCore returns NETWORK_MISMATCH when network regex fails" |
| T-E2 | `core.verify.test.ts` | "verifyCore returns NETWORK_MISMATCH when assetTransferMethod !== 'eip3009'" |
| T-E3 | `core.verify.test.ts` | "verifyCore passes params unchanged to adapter.verify" |
| T-E4 | `core.verify.test.ts` | "verifyCore does NOT catch adapter exceptions (propagates)" |
| T-E5 | `core.idempotency.test.ts` | "buildIdempotencyKey is stable across key order permutations" |
| T-E6 | `core.idempotency.test.ts` | "buildIdempotencyKey differs for distinct payloads" |
| T-E7 | `core.idempotency.test.ts` | "getCachedVerifyResponse returns null when redis client is null (test env)" |
| T-E8 | `core.idempotency.test.ts` | "setCachedVerifyResponse swallows redis errors silently" |
| T-E9 | `core.idempotency.test.ts` | "VERIFY_IDEMPOTENCY_TTL_SEC === 120 (spec requirement)" |
| T-E10 | `core.idempotency.test.ts` | "canonicalStringify sorts keys recursively and preserves arrays" |
| T-E11 | `core.verify.test.ts` | "VerifyRequestSchema accepts the canonical fixture and rejects each required missing field" |
| T-E12 | `core.verify.test.ts` | "VerifyRequestSchema rejects x402Version=1" |

**Total**: 13 tests por AC + 12 extras = **25 tests mínimos en 3 archivos**.

**Estrategia de mock para `routes.verify.test.ts`**:
- `chainRegistry._resetForTesting()` en `beforeEach`.
- Registrar un `fakeAdapter` con `chainId = asChainId(2368)` cuyo `.verify` es un
  `vi.fn()` configurable per test.
- Mock de `ioredis` siguiendo el patrón de `src/__tests__/unit/redis.test.ts` (ya existe).
- `buildApp` con `loggerDestination: new CaptureStream()` para log assertions.

**Estrategia para `core.idempotency.test.ts`**:
- Mock `ioredis` como en `redis.test.ts`.
- `resetRedisClientForTests()` en `afterEach`.
- No necesita Fastify.

**Estrategia para `core.verify.test.ts`**:
- `chainRegistry._resetForTesting()` en `beforeEach` + register fake adapter ad-hoc.
- Pure unit tests (no Fastify, no Redis).

---

## 5. Constraint Directives — Inheritance + Extensions

### Heredados del work-item (obligatorios, se copian al Story File)

- **CD-1** (del WI): route no importa `src/chains/*` ni `src/methods/*` directo.
- **CD-2** (del WI): response 200 spec-literal — 7 fields exactos.
- **CD-3** (del WI): prohibido loggear signature/authorization en plano.
- **CD-4** (del WI): `src/core/verify.ts` y `src/core/idempotency.ts` nunca throw por
  errores previstos.
- **CD-5** (del WI): cada error path setea `reply.code(err.http)` antes del `.send()`.
- **CD-6** (del WI): tests de route usan `app.inject()`.
- **CD-7** (del WI): TTL constante declarada una sola vez.
- **CD-8** (del WI): schema `x402Version = z.literal(2)`.

### Nuevos (arquitectónicos, detectados en F2)

- **CD-9** — **PROHIBIDO** que `src/routes/verify.ts` invoque `getRedisClient()` directamente.
  Solo puede leer el estado de Redis vía el helper `isRedisAvailable()` exportado por
  `src/core/idempotency.ts`. Justificación: mantener el boundary `routes → core → infra`
  en una sola dirección; simplifica el mocking en tests.

- **CD-10** — **PROHIBIDO** que `src/core/verify.ts` importe `src/methods/*` directamente.
  El dispatch SIEMPRE pasa por `chainRegistry.getAdapter(chainId).adapter.verify(params)`.
  Justificación: respeta OWNERS matrix y permite que WFAC-21 (settle route) reuse el
  mismo patrón.

- **CD-11** — **OBLIGATORIO** que el helper `canonicalStringify` en `src/core/idempotency.ts`
  sea determinista sobre objetos con keys en cualquier orden y arrays (preserva orden).
  Se testea explícitamente (T-E5, T-E10). Justificación: evita false-negatives en
  idempotency cache que llevarían a doble-verify on-chain.

- **CD-12** — **PROHIBIDO** cachear responses con `http >= 500`. Solo se cachean
  `Result<VerifyResult>` con `http < 500`. Justificación: `SIMULATION_FAILED` o
  `TRANSACTION_FAILED` pueden ser transientes (RPC flake); cachear 500 bloquea el
  retry legítimo del cliente. Implementado en `toCacheable(result)`.

- **CD-13** — **OBLIGATORIO** que el regex de parsing network sea
  `/^eip155:([1-9]\d*)$/` (positive integer sin ceros a la izquierda, sin signo).
  Anti-blindaje: heredado de WFAC-6 auto-blindaje (leading zeros, negative bypass).

- **CD-14** — **PROHIBIDO** usar `Number()` para comparar chainId extraído contra valores
  límite (ej. `MAX_SAFE_INTEGER`). Si un chainId válido excede `MAX_SAFE_INTEGER`, el
  regex permitirá el match pero `asChainId(Number(s))` pierde precisión. Se rechaza con
  `NETWORK_MISMATCH` si `s.length > 16` o `BigInt(s) > BigInt(Number.MAX_SAFE_INTEGER)`.
  Anti-blindaje: heredado de WFAC-6 BLQ-MED-1.

- **CD-15** — **OBLIGATORIO** que el test fixture de happy path use un chainId que está
  EXPLÍCITAMENTE registrado en el fake adapter del test — no apoyarse en los adapters
  production (`kite.ts`, `avalanche.ts`) que requieren env vars de RPC. Si un test usa
  uno de los adapters production, debe hacerlo vía `register()` explícito con un mock
  del `verify()`.

- **CD-16** — **PROHIBIDO** importar `src/chains/kite.ts` o `src/chains/avalanche.ts`
  desde `src/__tests__/unit/routes.verify.test.ts` o `src/__tests__/unit/core.verify.test.ts`.
  Esos modules throw en construcción si falta env (`ChainAdapterInitError`), lo que
  romperia la suite en CI. Test infrastructure-dependent. Usar `register()` con un
  `ChainAdapter` stub.

---

## 6. Exemplar Verification (paths reales, verificados con Read + ls)

| # | Path | Verified | Patrón extraído | Used in Wave |
|---|------|----------|-----------------|--------------|
| 1 | `src/routes/health.ts` (líneas 33-48) | YES (Read) | `FastifyPluginAsync` export + `app.post/app.get` + `config: { rateLimit: false }` placeholder ignorable | W3 |
| 2 | `src/app.ts` (líneas 38-70) | YES (Read) | `buildApp` factory + `await app.register(...)` + `initRedis(env, logger)` + onClose hook | W3 (modificación) |
| 3 | `src/methods/eip3009/schemas.ts` (líneas 22-46, 49-56, 73-82) | YES (Read) | `AddressHexSchema`, `Bytes32HexSchema`, `Uint256StringSchema`, `Eip3009AuthorizationSchema`, `AcceptedSchema.passthrough()` — se RE-USAN en W0 | W0 |
| 4 | `src/methods/eip3009/verify.ts` (líneas 40-44, 60-77) | YES (Read) | Signature `(params, token, chainId) → Promise<AdapterResult<VerifyResult>>`; patrón de ruteo de Zod issues a codes específicos (INVALID_AMOUNT vs NETWORK_MISMATCH) | W2 (no modifica, solo consume vía registry) |
| 5 | `src/chains/registry.ts` (líneas 66-88, 130) | YES (Read) | `chainRegistry.getAdapter(chainId)` retorna Result; singleton exported; `_resetForTesting()` para tests | W2, W4 |
| 6 | `src/chains/types.ts` (líneas 51-94, 115, 117-123) | YES (Read) | `VerifyParams.x402Version: 2` literal; `AssetTransferMethod = 'eip3009' | 'permit2' | 'erc7710'`; `AdapterResult<T> = Result<T>`; `ChainAdapter.verify(params) → Promise<AdapterResult<VerifyResult>>` | W0, W2 |
| 7 | `src/core/errors.ts` (líneas 44-106) | YES (Read) | `HTTP_BY_CODE` exhaustive Record; `buildX402Error(code, message?)` pure; ningún cambio en este SDD (solo consume) | W2 |
| 8 | `src/core/types.ts` (líneas 16-62) | YES (Read) | `asChainId(n)` throws on invalid; `X402ErrorCode` union literal 10 codes; `Err.error: { code, message, http }` | W2, W3 (local type extension) |
| 9 | `src/infra/redis.ts` (líneas 82-120, 149-158) | YES (Read) | `getRedisClient() → Redis | null`; `redactRedisUrl`; `resetRedisClientForTests()` for test teardown | W1, W4 |
| 10 | `src/infra/logger.ts` (líneas 16-32) | YES (Read) | `createLogger(env, destination?)` factory; `destination` for test captures | W4 (no se modifica) |
| 11 | `src/__tests__/unit/health.test.ts` (líneas 11-25, 155-170, 222-245) | YES (Read) | `CaptureStream` class; `app.inject({ method, url })`; log line assertions via `getLines().find(msg === ...)` | W4 |
| 12 | `src/__tests__/unit/redis.test.ts` (líneas 14-52) | YES (Read) | `vi.mock('ioredis')` con RedisMock class + `__emit` helper | W4 |
| 13 | `src/__tests__/unit/methods/eip3009/verify.test.ts` | YES (ls — existe) | Referencia para pattern de tests de verify con adapter stub + fixtures EIP-3009 | W4 (no modifica) |

**Paths que se CREAN** (confirmado que no existen con `ls src/core/` y `ls src/routes/`):
- `src/core/schemas.ts` — NO existe (ls: solo `errors.ts`, `types.ts`)
- `src/core/verify.ts` — NO existe (idem)
- `src/core/idempotency.ts` — NO existe (idem)
- `src/routes/verify.ts` — NO existe (ls: solo `health.ts`)
- `src/__tests__/unit/core.verify.test.ts`, `core.idempotency.test.ts`, `routes.verify.test.ts` —
  NO existen (`ls src/__tests__/unit/` confirma solo `core-types.test.ts`, no otros `core.*`).

---

## 7. Historical Auto-Blindaje (lecciones heredadas)

Aplicado según el grounding de auto-blindajes de últimas 3 HUs DONE (WFAC-13, WFAC-10, WFAC-6):

| Lección previa | Origen | Protección en este SDD |
|----------------|--------|------------------------|
| Regex `/^\d+$/` acepta leading zeros → usar `/^(0|[1-9]\d*)$/` | WFAC-6 auto-blindaje BLQ-BAJO-1 | CD-13 del SDD (regex `eip155:([1-9]\d*)`) |
| `Number(uint256)` pierde precisión → usar BigInt para decisiones | WFAC-6 BLQ-MED-1 | CD-14 del SDD (chainId overflow guard) |
| `BigInt("abc")` throws en input sin pre-validación Zod → parsear shape ANTES | WFAC-6 BLQ-ALTO-2 | DT-Zod + W0 (VerifyRequestSchema parse PRIMERO en el route, antes de cualquier conversión) |
| Test fixture de EIP-2098 debe preservar parity de `v` | WFAC-10 Fix-pack F3.1 | No aplica directamente a WFAC-20 (el route no firma). Pero **sí** aplica a los fixtures de test AC-6/AC-7 — si un test genera signatures, debe usar un helper que ya esté battle-tested (ver `src/__tests__/unit/methods/eip3009/verify.test.ts`), no generar inline. |
| viem `recoverTypedDataAddress` solo acepta 65-byte signatures canónicas | WFAC-13 | Indirecto — el route NO llama viem; delegation al adapter. Pero si un test hace signature mocking, debe usar el mismo pattern canonical del adapter test suite. |
| Test que pinaba guardia defensiva vs test que pina transformación | WFAC-13 | Lección genérica: si algún test existente de `verify.ts` del adapter assume "route-less" behavior, NO se rompe (los tests del adapter son independientes del route). |

---

## 8. Readiness Check (self-audit)

| Criterio | Status | Nota |
|----------|--------|------|
| Todos los [NEEDS CLARIFICATION] del work-item resueltos? | **YES** | DT-7 → opción (b) literal local; DT-Idempotency → canonical JSON hash |
| Test plan cubre 100% de ACs? | **YES** | 13 ACs, 13 tests 1:1 + 12 tests extras (25 total) |
| Boundaries OWNERS respetados en imports propuestos? | **YES** | Verificados wave por wave en §3: routes → core, core → registry/infra, no cross |
| No hay imports cross-project (wasiai-a2a, wasiai-v2)? | **YES** | Ninguno propuesto |
| Auto-blindajes históricos aplicados como CDs? | **YES** | CD-13, CD-14, DT-Zod incorporan BLQ-BAJO-1, BLQ-MED-1, BLQ-ALTO-2 de WFAC-6 |
| Exemplars verificados con Read? | **YES** | 13 paths, todos leídos — tabla §6 |
| Artefactos a crear están fuera de lo ya existente? | **YES** | `ls src/core/`, `ls src/routes/`, `ls src/__tests__/unit/` confirman |
| CD sobre secrets/hardcodes respetados? | **YES** | No hay URLs, addresses, chainIds hardcodeados — todo viene del registry / env |
| Patrón "service-layer returns discriminated union" preservado? | **YES** | `verifyCore` retorna `Result<VerifyResult>`; idempotency retorna `null | Result`; route es el único que lanza (reply.send) |
| Log policy cumple CD-3? | **YES** | DT-Log lista 4 líneas autorizadas + campos prohibidos explícitos |

### Riesgos no mitigados

1. **R1 (bajo)**: Fastify v5 default behavior para `Content-Type` non-JSON en POST puede
   devolver 400 (con body `{ statusCode, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', ... }`)
   o 415 según la config de `addContentTypeParser`. AC-13 permite ambos — el test debe
   assert `statusCode in [400, 415]`. **Mitigación**: documentado en el test plan §4 (AC-13).

2. **R2 (bajo)**: El comportamiento de `request.body` en Fastify cuando `Content-Type` no
   es JSON: Fastify puede dejar `request.body` undefined. El handler debe tolerar eso —
   `VerifyRequestSchema.safeParse(undefined)` retorna success: false, lo cual genera
   `INVALID_PAYLOAD 400`. Consistent con el spec. **Mitigación**: el Zod schema naturalmente
   lo cubre; test T-E11 lo prueba.

3. **R3 (bajo)**: Race condition en idempotency cache: si dos requests idénticos llegan
   simultáneamente antes de que el primero haga `setCachedVerifyResponse`, ambos ejecutan
   el adapter. Esto es aceptable para `/verify` (stateless, idempotent por naturaleza —
   misma firma → mismo resultado). Para `/settle` sí sería crítico, pero `/settle` es
   otra HU. **Mitigación**: documentado aquí; no se implementa locking optimista en v1.

4. **R4 (medio)**: Si en el futuro `chainRegistry` se reinicia entre requests (HMR en dev),
   el fake adapter desaparece. Tests de dev-watch pueden fallar. **Mitigación**: el AR
   debe validar que en prod/test los adapters se registran una sola vez en
   `src/chains/index.ts` (ya pattern establecido en WFAC-4).

---

## 9. Open Questions (non-blocking for Dev)

Ninguna. Todas las clarifications del work-item están resueltas en §2. El Dev puede
avanzar a F2.5 (Story File) y luego F3 (implementación) sin input humano adicional.

---

## 10. Resumen para orquestador

- **Waves**: 5 (W0 schemas, W1 idempotency, W2 core/verify, W3 route+app, W4 tests).
- **Archivos a crear**: 4 (`src/core/schemas.ts`, `src/core/idempotency.ts`,
  `src/core/verify.ts`, `src/routes/verify.ts`) + 3 tests.
- **Archivos a modificar**: 1 (`src/app.ts` — una línea `register(verifyRoute)`).
- **Tests**: 25+ en 3 suites nuevas.
- **CDs nuevos**: 8 (CD-9 a CD-16); hereda CD-1 a CD-8 del work-item.
- **Riesgos**: 4 low/medium documentados, ninguno bloqueante.
- **Readiness**: **PASS**.

---

*Generated by nexus-architect · F2 SDD · 2026-04-23*
