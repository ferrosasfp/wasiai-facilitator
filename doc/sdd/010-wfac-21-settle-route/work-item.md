# Work Item — [WFAC-21] POST /settle route

## Resumen

Implementar la ruta HTTP `POST /settle` del protocolo x402 en wasiai-facilitator.
A diferencia de `/verify` (read-only, ~30 ms), `/settle` ejecuta una transacción
on-chain (`transferWithAuthorization` via EIP-3009) y espera el receipt de red —
operación que puede tardar hasta 300 s y cuya re-ejecución sin protección puede
producir un double-spend. La idempotency Redis es, por tanto, **mecanismo de
corrección**, no de optimización: si el cliente reenvía la misma solicitud mientras
la tx está en vuelo o ya mined, el sistema DEBE retornar el resultado cacheado sin
ejecutar una segunda tx. El 90 % del patrón de implementación es paralelo a WFAC-20;
la diferencia crítica reside en la forma del response, la cache policy para errores
y el logging del `txHash`.

## Sizing

- SDD_MODE: full
- Estimación: M (reuso alto de WFAC-20 reduce complejidad respecto al sizing formal)
- Branch sugerido: `feat/010-wfac-21-settle-route`
- Pipeline: QUALITY — on-chain write obliga AR + CR obligatorios (regla 12 del project-context)

## Acceptance Criteria (EARS)

- AC-1: WHEN a valid x402 POST /settle request arrives AND no idempotency cache entry exists, the system SHALL call `settleEip3009` via the settle orchestrator and return HTTP 200 with body `{ settled: true, transactionHash, blockNumber, amount, from, to, asset }` spec-literal (no extra fields, no `ok` discriminant).

- AC-2: WHEN a POST /settle request body fails Zod validation, the system SHALL return HTTP 400 with body `{ error: { code: "INVALID_PAYLOAD", message: "<field>: <reason>" (max 200 chars), http: 400 } }` without invoking the settle orchestrator.

- AC-3: WHEN `accepted.network` is not in the format `eip155:<positive-integer>` OR the chain is not registered, the system SHALL return HTTP 400 with `{ error: { code: "NETWORK_MISMATCH", ... } }`.

- AC-4: WHEN `settleEip3009` returns `{ ok: false, error: { code: "INVALID_SIGNATURE" } }`, the system SHALL return HTTP 401 with the spec error body without executing any on-chain write.

- AC-5: WHEN `settleEip3009` returns `{ ok: false, error: { code: "INSUFFICIENT_BALANCE" } }`, the system SHALL return HTTP 402 with the spec error body.

- AC-6: WHEN `settleEip3009` returns `{ ok: false, error: { code: "SIMULATION_FAILED" } }`, the system SHALL return HTTP 500 with the spec error body and SHALL NOT cache the response in Redis (transient — CD-12 settle variant).

- AC-7: WHEN `settleEip3009` returns `{ ok: false, error: { code: "TRANSACTION_FAILED" } }` (revert, gas out, or receipt timeout), the system SHALL return HTTP 500 with the spec error body and SHALL NOT cache the response in Redis.

- AC-8: WHEN an identical POST /settle request arrives within 120 s of a previously settled (HTTP 200) response, the system SHALL return the cached `{ settled: true, transactionHash, ... }` response without invoking the settle orchestrator (idempotency replay — no double-spend).

- AC-9: WHEN an identical POST /settle request arrives within 120 s of a previously failed (HTTP 4xx, non-5xx) response, the system SHALL return the cached error response without re-invoking the orchestrator.

- AC-10: WHILE Redis is unavailable (null client), the system SHALL log a WARN with `request_id` and proceed to call the settle orchestrator (graceful degradation — idempotency disabled, not fail-open).

- AC-11: WHEN the settle orchestrator throws an unexpected exception (adapter bug, not a Result error), the system SHALL return HTTP 500 with `{ error: { code: "TRANSACTION_FAILED", message: "Internal adapter error", http: 500 } }` and SHALL log at ERROR level with `err_type` and `duration_ms`.

- AC-12: WHEN a POST /settle request is processed successfully, the system SHALL emit a structured JSON log at INFO level including `request_id`, `network`, `method`, `duration_ms`, and `tx_hash`; SHALL NOT log `payload.signature` or any field of `payload.authorization`.

- AC-13: WHEN a POST /settle request is rejected (any error path), the system SHALL emit a structured JSON log at WARN level including `request_id`, `error_code`, `http_status`, and `duration_ms`; SHALL NOT include wallet addresses or signature values in any log field.

- AC-14: WHEN a POST /settle request arrives, the system SHALL accept `Content-Type: application/json` and SHALL reject any other content type with HTTP 415 (delegated to Fastify/middleware — no explicit handling needed in route).

## Scope IN

| Artefacto | Tipo | Notas |
|-----------|------|-------|
| `src/core/settle.ts` | NEW | Orchestrator: network parse → registry → adapter.settle dispatch. Espejo de verify.ts. |
| `src/routes/settle.ts` | NEW | Fastify plugin POST /settle. Espejo de routes/verify.ts con shape de response y cache policy distintos. |
| `src/app.ts` | MODIFY | Registrar `settleRoute` con `await app.register(settleRoute)`. |
| `src/core/schemas.ts` | MODIFY | Agregar `SettleRequestSchema` (alias o re-export de `VerifyRequestSchema` — resolver en F2), `SettleRequest` type. |
| `src/core/idempotency.ts` | MODIFY | Agregar variante settle: `SETTLE_IDEMPOTENCY_TTL_SEC`, `SETTLE_IDEMPOTENCY_KEY_PREFIX`, `CachedSettleResponse*`, `buildSettleIdempotencyKey`, `getCachedSettleResponse`, `setCachedSettleResponse`, `toSettleCacheable`. |
| `src/__tests__/unit/routes.settle.test.ts` | NEW | Happy path, body inválido, network desconocida, errores de adapter (cada código), idempotency hit/miss, Redis down. |
| `src/__tests__/unit/core.settle.test.ts` | NEW | Network parse, método no soportado, registry miss, adapter ok, adapter error. |
| `src/__tests__/unit/core.idempotency.settle.test.ts` | NEW | buildSettleIdempotencyKey determinism, toCacheable no caches 5xx, getCached/setCache round-trip. |

## Scope OUT

| Fuera del scope | Referencia |
|-----------------|-----------|
| OpenAPI YAML (`openapi.yaml`) actualización para /settle | WFAC-23 |
| Settlement ledger / Supabase write (`facilitator_settlements`) | WFAC-32 |
| Audit log (`facilitator_audit_log`) write | WFAC-33 |
| BullMQ retry queue para settlements fallidos | WFAC-42 |
| Rate-limit específico para /settle (`RATE_LIMIT_SETTLE_MAX`) | Puede mencionarse en env.ts pero no se conecta ahora — `[NEEDS CLARIFICATION]` si ya existe o es parte de esta HU |
| `/supported` route (lista de chains/methods) | WFAC futura |
| Integration tests contra testnet real | Post-V1 |
| Prometheus metrics counter para settle | Post-WFAC-21 (puede ser WFAC-35) |

## Decisiones técnicas

- DT-1 — SettleRequestSchema = alias vs copia: `SettleParams` en `src/chains/types.ts` ya declara `type SettleParams = VerifyParams`, confirmando que el body x402 es idéntico. En `src/core/schemas.ts` se propone exportar `export const SettleRequestSchema = VerifyRequestSchema` y `export type SettleRequest = VerifyRequest` (alias by value). Alternativa: re-export con nombre propio. La decisión formal va en F2. `[NEEDS CLARIFICATION]` si el equipo prefiere alias vs nuevo objeto Zod para evitar acoplamiento semántico futuro.

- DT-2 — Extensión de idempotency.ts vs nuevo archivo: dado que `idempotency.ts` ya importa `VerifyRequest` (type-only) y expone funciones nombradas explícitamente, la extensión para settle requiere agregar un segundo bloque de tipos/constantes/funciones específicas de settle. La alternativa es un `settle-idempotency.ts` separado. Decisión en F2. Preferencia tentativa: extender el archivo existente con prefijos claros (`Cached**Settle**Response`, `SETTLE_IDEMPOTENCY_*`) para evitar fragmentación, pero mantener las funciones de verify intactas (no romper WFAC-20).

- DT-3 — Response shape: confirmado vía `src/chains/types.ts` `SettleResult`: `{ settled: true, transactionHash: \`0x${string}\`, blockNumber: number, amount: string, from: Address, to: Address, asset: Address }`. El campo es `transactionHash` (no `txHash`). La ruta deberá emitir estos 7 campos exactos más `settled: true` — sin el discriminante `ok`. Esto está spec-literal documentado en project-context.md.

- DT-4 — Logging de txHash: en AC-12 se incluye `tx_hash` en el log de éxito. Este campo es el hash de una transacción pública on-chain — no es PII ni secreto. Se incluye en el log INFO para correlación y trazabilidad. `[NEEDS CLARIFICATION]` si existe política explícita que lo excluya.

- DT-5 — Cache policy para errores 5xx (SIMULATION_FAILED, TRANSACTION_FAILED): a diferencia de /verify donde los 5xx son errores de adapter genéricos, en /settle SIMULATION_FAILED puede ser permanente (contrato rechaza params) o transitorio (gas price spike). TRANSACTION_FAILED tras revert también es determinista (mismos parámetros = mismo revert). Sin embargo, cachear un revert implicaría bloquear al cliente de reintentar con parámetros corregidos. Decisión tentativa: NO cachear ningún 5xx (mismo comportamiento que WFAC-20 CD-12). `[NEEDS CLARIFICATION]` si existe un requisito de negocio de cachear reverts permanentes para proteger al operador de doble write.

- DT-6 — `assetTransferMethod` guard: igual que `verifyCore`, `settleCore` debe verificar que `accepted.extra.assetTransferMethod === 'eip3009'` y retornar NETWORK_MISMATCH si no (único método soportado en V1). Este guard queda en `src/core/settle.ts`.

## Constraint Directives

- CD-1: `src/routes/settle.ts` PROHIBIDO importar `src/chains/*`, `src/methods/*`, `src/infra/*` (salvo vía helpers de `src/core/idempotency.ts`). Boundary definido en OWNERS.md — violación = AR BLOQUEANTE.

- CD-2: el body HTTP 200 de /settle DEBE ser spec-literal: exactamente los 7 campos de `SettleResult` (`settled`, `transactionHash`, `blockNumber`, `amount`, `from`, `to`, `asset`) sin el discriminante `ok` ni campos extra.

- CD-3: PROHIBIDO loguear `payload.signature`, `payload.authorization.*` (addresses, nonce, value) en ningún nivel de log (INFO, WARN, ERROR). Solo `request_id`, `network`, `method`, `duration_ms`, `error_code`, `http_status`, `tx_hash` (solo en éxito).

- CD-4: `src/core/settle.ts` NUNCA debe lanzar excepción para errores previsibles. Siempre retorna `Result<SettleResult>`. Throws de adapter (bugs) se propagan sin captura al route, que los atrapa en el try/catch de defensa (mismo patrón que verifyCore).

- CD-5: respuestas de error DEBEN usar el objeto `{ error: { code, message, http } }` spec-literal. PROHIBIDO enviar el error raw o el mensaje del adapter sin mapear.

- CD-6: idempotency key prefix para settle DEBE ser distinto al de verify (`settle:idempotency:` vs `verify:idempotency:`) para evitar colisiones en Redis. Si el mismo hash de payload aparece en ambos contexts, son keys separadas.

- CD-7: TTL de idempotency settle DEBE ser `120` s (spec x402). Declarado como constante nombrada `SETTLE_IDEMPOTENCY_TTL_SEC`. PROHIBIDO hardcodear el número en la llamada a `client.set`.

- CD-8: OBLIGATORIO reusar `canonicalStringify` de `src/core/idempotency.ts` para construir el hash del key de settle. PROHIBIDO duplicar la función.

- CD-9: `src/core/settle.ts` PROHIBIDO importar `src/methods/*`. El dispatch se hace exclusivamente via `chainRegistry.getAdapter(chainId).adapter.settle(params)` (mismo patrón que verifyCore).

- CD-10: `src/app.ts` DEBE registrar `settleRoute` con `await app.register(settleRoute)` inmediatamente después de `verifyRoute`. PROHIBIDO registrar con `.register(...).then(...)` sin await.

## Waves sugeridas (para F2.5 Story File)

| Wave | Entregables | Tests mínimos |
|------|-------------|---------------|
| W1 — Schemas + Types | `SettleRequestSchema` + `SettleRequest` en schemas.ts; `CachedSettleResponse*`, `ToCacheableSettleInput`, `SETTLE_*` constants + funciones en idempotency.ts | T-S1 (schema parse ok), T-S2 (schema rejects extras), T-I1 (key prefix distinto a verify), T-I2 (toCacheable retorna null para 5xx) |
| W2 — Core orchestrator | `settleCore` en `src/core/settle.ts` | T-C1 (network parse ok), T-C2 (network bad format), T-C3 (method not eip3009), T-C4 (chain not registered), T-C5 (adapter settle ok), T-C6 (adapter settle err) |
| W3 — Route + app.ts | `settleRoute` en `src/routes/settle.ts`; registro en `app.ts` | T-R1 (200 happy path), T-R2 (400 bad body), T-R3 (idempotency hit 200), T-R4 (idempotency hit 4xx), T-R5 (Redis down warn + proceed), T-R6 (adapter error 4xx), T-R7 (adapter SIMULATION_FAILED 500), T-R8 (adapter TRANSACTION_FAILED 500), T-R9 (adapter throw 500) |
| W4 — Logging + PII audit | Verificar que ningún log emite payload fields; AC-12/AC-13 confirmados | T-R10 (log fields present en éxito), T-R11 (log no PII en error) |

## Missing Inputs

- MI-1: `[NEEDS CLARIFICATION]` Rate-limit específico para /settle (`RATE_LIMIT_SETTLE_MAX=30` está en project-context.md env vars pero no aparece en `src/infra/env.ts` — confirmar si está en scope de esta HU o de WFAC post-20.
- MI-2: `[NEEDS CLARIFICATION]` Cache policy para errores on-chain permanentes (revert determinista): la decisión tentativa es NO cachear ningún 5xx (DT-5), pero si el product owner quiere proteger al operador de double-write en revert permanentes, esto requiere distinguir revert de timeout — resolvible en F2 sin cambiar los ACs fundamentales.
- MI-3: `[resuelto en F2]` Decisión definitiva alias vs nuevo SettleRequestSchema (DT-1) — no bloquea F1, se decide en SDD.
- MI-4: `[resuelto en F2]` Extensión idempotency.ts vs archivo separado (DT-2) — no bloquea F1.

## Análisis de paralelismo

- WFAC-21 (esta HU) depende de: WFAC-20 merged (confirmado — branch feat/009-wfac-20-verify-route está in progress; esta HU DEBE esperar merge de WFAC-20 antes de merge, aunque el desarrollo puede comenzar en paralelo en rama propia).
- WFAC-21 bloquea: WFAC-32 (settlement ledger), WFAC-33 (audit log), WFAC-42 (BullMQ retry queue) — todos dependen de que la ruta /settle exista.
- WFAC-21 es independiente de: WFAC-23 (OpenAPI update), cualquier HU de chains/methods que no toque core/settle.
- Grado de reuso de WFAC-20: ALTO. Los 5 módulos centrales (schemas, idempotency, verify.ts como plantilla, routes/verify.ts como plantilla, app.ts) tienen contraparte directa. La diferencia es la forma del response (7 campos SettleResult vs 7 campos VerifyResult), la críticidad de idempotency, el logging de txHash, y la política de cache para 5xx transient-vs-permanent.
