# Work Item — [WFAC-AUDIT] Remediación auditoría profesional — seguridad de pagos + calidad

## Resumen

Remediación de 6 hallazgos de la auditoría staff-level (2026-05-29, calificación B+) sobre
wasiai-facilitator. El servicio mueve dinero real (x402/EIP-3009); el bar de seguridad es
más alto que un servicio CRUD. Los hallazgos cubren autenticación de caller, rate-limit
bypass por IP forjada, garantía de idempotencia in-flight, checks de validación faltantes
en los adapters de chain, duplicación estructural de adapters, y un cap de seguridad que
falla abierto ante errores de parseo.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/020-wfac-audit-remediation`

---

## Acceptance Criteria (EARS)

### AC-1 — [HIGH] Auth en /settle y /verify

WHEN a POST request to `/settle` or `/verify` is received WITHOUT a valid
`FACILITATOR_API_KEY` bearer token (or key absent / mismatched), the system SHALL
reject the request with HTTP 401 UNAUTHORIZED before executing any business logic.

WHEN a POST request to `/settle` or `/verify` is received WITH a matching
`FACILITATOR_API_KEY` bearer token, the system SHALL proceed normally with the
existing validation + settlement pipeline.

### AC-2 — [HIGH] Rate-limit keyed por IP real (no XFF forjable)

WHILE `trustProxy` is configured to the known upstream proxy (Railway), the system
SHALL key the per-route rate-limit counter by `request.ip` (the validated IP resolved
by Fastify after `trustProxy` processing) and NOT by the raw first element of
`X-Forwarded-For`.

IF an attacker sends requests with rotating forged `X-Forwarded-For` headers from the
same real IP, THEN the system SHALL count all such requests against the SAME rate-limit
bucket (the real IP), making the bypass ineffective.

### AC-3 — [MEDIO] Lock in-flight para idempotencia de settle

WHEN a `/settle` request arrives and the idempotency key is NOT in the cache (cache
miss), the system SHALL atomically set a `SET key NX EX <ttl>` in-flight lock in Redis
BEFORE dispatching to `settleCore`.

IF the in-flight lock already exists (a concurrent identical request is in-flight),
THEN the system SHALL return HTTP 409 CONFLICT (or poll/retry) rather than dispatching
a second `settleCore` call.

WHEN the `settleCore` call completes (success or 4xx), the system SHALL replace the
in-flight lock with the permanent idempotency cache entry (the existing `toCacheableSettle`
+ `setCachedSettleResponse` path).

The README and any inline doc claiming "prevents double-spend" SHALL accurately describe
the on-chain nonce as the ultimate safeguard and the in-flight lock as a best-effort
server-side optimization.

### AC-4 — [MEDIO] Checks `validAfter`, `payTo == authorization.to`, `amount > 0` en adapters live

WHEN any chain adapter (`kite.ts`, `avalanche.ts`, `base.ts`) processes a `/verify` or
`/settle` request, the system SHALL check ALL of the following conditions before
dispatching to the RPC:

- `authorization.amount > 0` (INVALID_AMOUNT 400 on violation)
- `authorization.to` is address-equal to `accepted.payTo` (INVALID_RECEIVER 400 on violation)
- `BigInt(authorization.validAfter) <= nowSec` — not-yet-valid check (EXPIRED_AUTHORIZATION
  400 on violation)

These checks are already present in `src/methods/eip3009/verify.ts` but absent in the
live adapter paths (`kite.ts:_verifyRaw`, `avalanche.ts:_verifyRaw`, `base.ts:_verifyRaw`
and their `_settleRaw` counterparts). After this AC, the adapter path SHALL be equivalent
to the methods module path for these three checks.

### AC-5 — [MEDIO-refactor] Base class `Eip3009Adapter` — deduplicación de adapters

WHEN a `BaseEip3009Adapter` class parametrized by chain/token is introduced, the system
SHALL migrate `KiteAdapter`, `AvalancheAdapter`, and `BaseAdapter` to extend it such that
the shared logic (`_verifyRaw`, `_settleRaw`, `sanitize`, CB wiring, `getPublicClient`,
`getWalletClient`, `setLogger`, `getBreakerState`) lives ONCE in the base class.

The refactor SHALL be behavior-preserving: all 590+ existing tests MUST pass without
modification to test assertions.

Each chain-specific adapter file SHALL retain only chain-specific data (chainId, token
constants, `defineChain`/`viemChain`, env-var names, enabled-flag gating logic) and
instantiate the base class with those parameters.

### AC-6 — [LOW] `checkSettleAmountCap` fail-closed ante error de parseo BigInt

IF `checkSettleAmountCap` is called with an `amountAtomic` or `capAtomic` string that
fails `BigInt()` parsing (e.g. `"abc"`, `"1.5"`, `""`), THEN the system SHALL return
`{ ok: false, limit: 0n }` (or equivalent rejection) rather than `{ ok: true }`.

The function MUST NOT allow a request through when the cap value itself cannot be parsed
— an unparseable cap is a misconfiguration, and the safe default is to block.

---

## Test Plan

Per AC (mínimo un test por AC; casos críticos indicados):

### AC-1
- `routes.settle.auth.test.ts` — T1: POST `/settle` sin header `Authorization` → 401.
- T2: POST `/settle` con `Authorization: Bearer wrong-key` → 401.
- T3: POST `/settle` con `Authorization: Bearer <FACILITATOR_API_KEY>` válido → pipeline
  normal (existente mock de settleCore retorna ok).
- T4: POST `/verify` sin header → 401 (misma lógica, mismo preHandler).
- T5: `FACILITATOR_API_KEY` ausente en env → boot falla con error descriptivo (o preHandler
  permite tráfico solo si `NODE_ENV === test`).

### AC-2
- `rate-limiting.xff-bypass.test.ts` — T6: 5 requests desde IP real `10.0.0.1` con XFF
  forjado rotante (`1.1.1.1`, `2.2.2.2`, `3.3.3.3`, `4.4.4.4`, `5.5.5.5`) TODOS cuentan
  contra el mismo bucket y el 5º (o el que supere el cap del test) recibe 429.
- T7: `trustProxy` configurado → `request.ip` refleja la IP resolvida por Fastify, no el
  XFF crudo.

### AC-3
- `routes.settle.inflight.test.ts` — T8: dos requests idénticos concurrentes → sólo uno
  llega a `settleCore`; el segundo recibe 409 (o la respuesta del primero si completa
  antes del timeout).
- T9: si Redis está down (null client), el lock se omite gracefully (AC-10 degradation
  existente) y el request sigue el flujo normal.
- T10: comentario/doc en `idempotency.ts` describe con precisión la garantía: "in-flight
  lock best-effort; ultimate protection is EIP-3009 nonce on-chain".

### AC-4
- `chains.base.test.ts` / `chains.kite.test.ts` / `chains.avalanche.test.ts` — T11:
  `_verifyRaw` con `authorization.value = "0"` → `INVALID_AMOUNT` 400.
- T12: `_verifyRaw` con `authorization.to != accepted.payTo` → `INVALID_RECEIVER` 400.
- T13: `_verifyRaw` con `validAfter` en el futuro (not-yet-valid) → `EXPIRED_AUTHORIZATION`
  400 (distinguir de validBefore-expired).
- T14: mismas T11–T13 para `_settleRaw`.
- T15: path de success con todos los campos válidos sigue pasando (regression).

### AC-5
- `chain-adapter.test.ts` existente — T16: todos los tests existentes pasan sin cambios de
  assertions (behavior-preserving).
- T17: nuevo test que instancia la base class directamente con un token mock y verifica el
  flujo de `_verifyRaw` (caja blanca de la base).
- T18: `kite.ts`, `avalanche.ts`, `base.ts` reducidos a <100 líneas c/u (solo
  chain-specific glue); `base-adapter.ts` tiene la lógica compartida.

### AC-6
- `core.settle-cap.test.ts` — T19: `checkSettleAmountCap("abc", "100")` → `{ ok: false }`.
- T20: `checkSettleAmountCap("100", "abc")` → `{ ok: false }`.
- T21: `checkSettleAmountCap("0", "100")` → `{ ok: false }` (amount == 0 is also blocked).
- T22: `checkSettleAmountCap("50", "100")` → `{ ok: true }` (existing happy path).

---

## Scope IN

| Archivo / módulo | Cambio |
|-----------------|--------|
| `src/routes/settle.ts` | Agregar `preHandler` de auth (AC-1) + lock in-flight (AC-3) |
| `src/routes/verify.ts` | Agregar `preHandler` de auth (AC-1) |
| `src/app.ts` | Configurar `trustProxy` (AC-2) |
| `src/core/network.ts` | Adaptar `extractClientIp` para usar `request.ip` cuando trustProxy está activo (AC-2) |
| `src/core/idempotency.ts` | Agregar `setInflightSettleLock` / `releaseInflightSettleLock` helpers (AC-3) |
| `src/core/settle-cap.ts` | `checkSettleAmountCap`: cambiar catch de BigInt a fail-closed (AC-6) |
| `src/chains/kite.ts` | Agregar checks validAfter/payTo/amount>0 en `_verifyRaw` y `_settleRaw` (AC-4); migrar a base class (AC-5) |
| `src/chains/avalanche.ts` | Ídem (AC-4 + AC-5) |
| `src/chains/base.ts` | Ídem (AC-4 + AC-5) |
| `src/chains/base-adapter.ts` | NUEVO — clase base `Eip3009Adapter` con lógica compartida (AC-5) |
| `src/middleware/auth.ts` | NUEVO — `requireFacilitatorKey` preHandler |
| `src/infra/env.ts` | Agregar `FACILITATOR_API_KEY` (requerido en no-test), `TRUST_PROXY` config |
| `.env.example` | Documentar `FACILITATOR_API_KEY` y `TRUST_PROXY` con comentarios de seguridad |
| `src/__tests__/unit/routes.settle.auth.test.ts` | NUEVO |
| `src/__tests__/unit/rate-limiting.xff-bypass.test.ts` | NUEVO o ampliar existing |
| `src/__tests__/unit/routes.settle.inflight.test.ts` | NUEVO |
| `src/__tests__/unit/chains.kite.test.ts` (o base equivalente) | Ampliar con T11–T15 |
| `src/__tests__/unit/core.settle-cap.test.ts` | Ampliar con T19–T22 |

## Scope OUT

- Alertas de gas del operator (script `check-operator-gas.mjs` existe; cablear alarmas no es parte de esta HU).
- Multi-key por chain (limitación V1 documentada).
- mTLS / JWT de sesión (el scope de auth es API-key estática via env; mTLS es V2).
- RLS en Supabase (tracked separately).
- Permit2 / ERC-7710 adapters (no existen aún; AC-4 aplica solo a los tres adapters actuales).
- `src/methods/eip3009/` — se mantiene como está (el módulo ya tiene los checks correctos; el fix es en los adapters).

---

## Decisiones técnicas (DT-N)

- **DT-1**: Auth via `Authorization: Bearer <key>` header (no cookie, no query param). El preHandler vive en `src/middleware/auth.ts` e importa `env.FACILITATOR_API_KEY`. Fastify `preHandler` garantiza que la ejecución se detiene antes del handler si retorna 401. Comparación con `timingSafeEqual` (node:crypto) para evitar timing attacks.
- **DT-2**: `trustProxy` se configura en `buildApp` antes del registro de `rateLimit`. El valor correcto para Railway es `1` (un proxy upstream). Debe exponerse como `TRUST_PROXY` env var (default `'1'` en producción, `false` en tests para no depender de infraestructura de proxy). Fastify v5 acepta `trustProxy: number | string | boolean`.
- **DT-3**: El in-flight lock usa `SET settle:inflight:<idempotency-key> 1 NX EX <ttl>`. Si `SET NX` retorna null (key ya existe), la ruta devuelve HTTP 409. Si Redis está down, el lock se omite y el flujo continúa sin bloqueo (fail-open, consistente con el patrón del proyecto). El TTL del lock = TTL de idempotency (120s) para auto-expirar si el proceso muere.
- **DT-4**: `checkSettleAmountCap` cambia el `catch` de BigInt a retornar `{ ok: false, limit: 0n }`. El comentario existente que decía "fail-open por defense-in-depth" se reemplaza por "fail-closed — un cap imparseable es misconfig; bloquear es el default seguro".
- **DT-5**: La base class `Eip3009Adapter` en `src/chains/base-adapter.ts` es `abstract` con un método abstracto `buildViemChain(): Chain` (o recibe el chain en el constructor). Los tres adapters existentes se convierten en thin wrappers que pasan sus parámetros específicos. Las constantes de token (`USDC_FUJI`, `USDC_BASE_SEPOLIA`, etc.) permanecen en sus archivos originales para legibilidad.
- **DT-6**: Los checks `validAfter`, `payTo == to`, `amount > 0` se agregan en `_verifyRaw` y `_settleRaw` de la base class (una sola implementación). El orden en `_verifyRaw`: (1) network, (2) asset, (3) amount > 0, (4) payTo == to, (5) validBefore, (6) validAfter, (7) normalize sig, (8) recover, (9) recovered == from.
- **DT-7**: `FACILITATOR_API_KEY` es required en `NODE_ENV !== 'test'` (mismo patrón que `OPERATOR_PRIVATE_KEY` en `env.ts:superRefine`). En test, el preHandler debe hacer bypass si `FACILITATOR_API_KEY` está ausente (o el test inyecta la key en el rawEnv del buildApp).

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO romper la verificación de firma EIP-3009 existente. La refactorización de adapters (AC-4, AC-5) DEBE ser behavior-preserving: los 590+ tests existentes deben pasar sin modificar sus assertions. Cualquier fallo de test existente es bloqueante en AR.
- **CD-2**: OBLIGATORIO que el refactor de adapters (AC-5) sea behavior-preserving, validado por el conjunto de tests existente. No se agregan nuevas lógicas al mismo tiempo que se extrae la base class — son dos operaciones secuenciadas: primero extraer la base class manteniendo el comportamiento exacto, luego agregar los checks de AC-4 como un segundo commit.
- **CD-3**: PROHIBIDO hardcodear `FACILITATOR_API_KEY` en código. La key DEBE venir exclusivamente de `env.FACILITATOR_API_KEY` (parseEnv / EnvSchema).
- **CD-4**: OBLIGATORIO usar `timingSafeEqual` (node:crypto) para comparar el API key recibido con el configurado. Comparación con `===` es susceptible a timing attacks.
- **CD-5**: El `trustProxy` de Fastify DEBE configurarse en `buildApp` ANTES del registro de `@fastify/rate-limit` para que el plugin ya use `request.ip` resolvida.
- **CD-6**: PROHIBIDO modificar `src/methods/eip3009/verify.ts` ni `src/methods/eip3009/settle.ts` (están correctos y auditados). Los cambios de AC-4 van en los adapters y/o en la base class.
- **CD-7**: El lock in-flight (AC-3) DEBE ser fail-open cuando Redis no está disponible (consistente con `isRedisAvailable()` pattern del proyecto). La degradación se loguea en warn.
- **CD-8**: OBLIGATORIO documentar `FACILITATOR_API_KEY` y `TRUST_PROXY` en `.env.example` con comentarios de seguridad claros antes de mergear.

---

## Análisis de paralelismo

**Secuencia obligatoria dentro de esta HU:**

1. **AC-5 (base class) PRECEDE a AC-4 (checks)**: ambos tocan `kite.ts`, `avalanche.ts`, `base.ts`. Si se implementan en paralelo hay conflictos de merge garantizados. El orden correcto es: extraer base class primero (AC-5, behavior-preserving), luego agregar los checks en la base class (AC-4, un único lugar).

2. **AC-2 (trustProxy) PRECEDE al test T6**: el test de XFF-bypass depende de que `trustProxy` esté configurado para poder simular la resolución de IP correcta. Implementar ambos en el mismo wave.

3. **AC-1 y AC-6** son independientes entre sí y del resto. Pueden ir en paralelo con AC-2 y AC-3 desde el punto de vista de archivos tocados.

**Dependencias con otras HUs:**
- Esta HU NO bloquea ninguna HU activa conocida.
- WFAC-19 (post-review hardening WFAC-53) ya está DONE; esta HU continúa sobre ese baseline.
- El AC-5 introduce `src/chains/base-adapter.ts` — cualquier HU futura que agregue una nueva chain DEBE extender este base adapter (nueva constraint documentada en OWNERS.md y BACKLOG.md post-merge).

**Olas sugeridas para F2.5 Story File:**
- Wave 1: AC-6 (settle-cap fail-closed) + AC-1 (auth middleware + env) — archivos ortogonales, bajo riesgo.
- Wave 2: AC-2 (trustProxy + keyGenerator) — toca app.ts, requiere actualizar tests de rate-limit.
- Wave 3: AC-5 (base class extracción, behavior-preserving) — solo `src/chains/`.
- Wave 4: AC-4 (agregar checks en base class) — sobre Wave 3.
- Wave 5: AC-3 (in-flight lock) — sobre idempotency.ts + settle route.

---

## Missing Inputs

- `TRUST_PROXY` valor exacto para Railway: Railway usa un proxy HTTP en producción. El valor `1` (un hop) es la convención estándar para Railway, pero [NEEDS CLARIFICATION si el operador tiene Cloudflare delante — en ese caso el valor podría ser `2` o la IP del edge]. Por defecto se usará `1` y se documenta en `.env.example`.
- Comportamiento deseado para AC-3 cuando el lock existe: ¿HTTP 409 inmediato o polling con retry? El work-item adopta 409 como default conservador; puede ajustarse en F2.
