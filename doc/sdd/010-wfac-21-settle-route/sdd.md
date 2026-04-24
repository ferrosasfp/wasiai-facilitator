# SDD — WFAC-21 POST /settle route

- **Work Item**: [`doc/sdd/010-wfac-21-settle-route/work-item.md`](./work-item.md)
- **Pipeline**: QUALITY (on-chain write — AR + CR obligatorios)
- **Status**: in progress
- **Branch**: `feat/010-wfac-21-settle-route`
- **Sizing**: M · SDD_MODE: full
- **Architect**: nexus-architect (F2)
- **Fecha**: 2026-04-23
- **Precede**: WFAC-20 (POST /verify — DONE, main@5296b89)

---

## 1. Context + Goals

`POST /settle` es el segundo y último endpoint core del x402 facilitator: ejecuta
`transferWithAuthorization` on-chain vía EIP-3009. A diferencia de `/verify` (read-only,
~30 ms, determinista), `/settle`:

1. **Tiene side-effect monetario** — una ejecución = una tx on-chain. Una re-ejecución
   no protegida = double-spend.
2. **Es latency-heavy** — hasta `RECEIPT_TIMEOUT_MS` (≈ 300 s) esperando el receipt.
3. **Requiere idempotency como mecanismo de corrección** (no de optimización): si el
   cliente re-envía mientras la tx está in-flight o ya minada, el sistema **DEBE** devolver
   el resultado cacheado sin ejecutar una segunda `writeContract`.
4. **Retorna un shape distinto**: `{ settled, transactionHash, blockNumber, amount, from, to, asset }`
   (7 campos de `SettleResult`) — sin `verified`, sin `client/network/payTo/expiresAt`.

El 90% del pipeline HTTP es paralelo a WFAC-20: Zod → idempotency lookup → core dispatch
→ cache → map a HTTP. Las diferencias críticas están en (a) la forma del response,
(b) la cache policy para 5xx, (c) el logging de `tx_hash` en éxito, (d) claves y TTL
separados en Redis para no mezclar contexts.

**Deliverable**: 2 archivos nuevos en `src/core/*`, 1 nuevo en `src/routes/*`,
2 archivos modificados (`src/core/schemas.ts`, `src/core/idempotency.ts`, `src/app.ts`),
3 suites de tests unitarios nuevas. Boundaries OWNERS respetadas — no se toca
`src/chains/*` ni `src/methods/*`.

---

## 2. Architecture Decisions (resuelven los 4 MI del work-item)

### DT-1 · resolución de MI-3 — `SettleRequestSchema` = **alias de `VerifyRequestSchema`**

**Decisión**: exportar en `src/core/schemas.ts`:

```ts
// Alias by value — same Zod object, distinct name for route-layer clarity.
export const SettleRequestSchema = VerifyRequestSchema;
export type SettleRequest = VerifyRequest;
```

**Justificación**:

| Criterio | (a) Alias (ELEGIDA) | (b) Copia/duplicar schema | (c) Re-export con wrapper fresh |
|----------|---------------------|----------------------------|----------------------------------|
| Spec-conformance x402 | `SettleParams = VerifyParams` ya declarado en `src/chains/types.ts:99` — el body HTTP ES idéntico por spec | Duplica schemas que SIEMPRE deben evolucionar en paralelo → drift risk | Igual a (a) pero con overhead sin beneficio |
| OWNERS boundaries | Cero cambios cross-module | Cero | Cero |
| Type safety | `SettleRequest` es `VerifyRequest` al compilar — `VerifyRequest → VerifyParams → SettleParams` type chain intacta | Dos types estructuralmente iguales pero nominalmente distintos → cast boilerplate | Idem (a) |
| Mantenibilidad | Si spec x402 cambia el body, se actualiza en 1 lugar | Dos lugares — el próximo que agregue un campo en verify olvidará settle (o viceversa) | 1 lugar, pero la wrapper-function puede divergir |
| Signal de intent | El name `SettleRequestSchema` en el route es auto-documental (lector entiende qué está validando sin ir a schemas.ts) | Ídem, con duplicación | Ídem |

**Trade-off aceptado**: si en el futuro (post-V1) la spec x402 separa formalmente los
bodies de verify y settle (p.ej. settle agrega un `tip` field opcional), el alias se
rompe y se debe **forkear** a un schema propio. Eso es una HU explícita, no un drift
accidental — es mejor detectar ese momento que cargar duplicación preventiva.

**CDs derivados**: CD-13 heredado (canonical JSON), CD-14 heredado (BigInt overflow).

---

### DT-2 · resolución de MI-4 — **extender `src/core/idempotency.ts`** (no crear archivo nuevo)

**Decisión**: agregar en `src/core/idempotency.ts` junto a los exports de verify:

- `SETTLE_IDEMPOTENCY_TTL_SEC = 120` (const).
- `SETTLE_IDEMPOTENCY_KEY_PREFIX = 'settle:idempotency:'` (const).
- `CachedSettleResponseOk`, `CachedSettleResponseErr`, `CachedSettleResponse` types.
- `ToCacheableSettleInput` type (estructural `Result<SettleResult>`).
- `buildSettleIdempotencyKey(parsed: VerifyRequest): string` — reusa `canonicalStringify`.
- `getCachedSettleResponse(key): Promise<CachedSettleResponse | null>` — idéntico patrón.
- `setCachedSettleResponse(key, payload)` — idéntico patrón.
- `toCacheableSettle(result: ToCacheableSettleInput): CachedSettleResponse | null`.

Los exports de verify (`VERIFY_IDEMPOTENCY_*`, `CachedVerifyResponse*`, `buildIdempotencyKey`,
`getCachedVerifyResponse`, `setCachedVerifyResponse`, `toCacheable`, `isRedisAvailable`,
`canonicalStringify`) **permanecen intactos** — WFAC-20 tests no se tocan.

**Justificación**:

| Criterio | (a) Extender idempotency.ts (ELEGIDA) | (b) `src/core/settle-idempotency.ts` nuevo |
|----------|---------------------------------------|---------------------------------------------|
| Reuso de `canonicalStringify` | Import directo, cero duplicación | Requiere export desde el archivo verify o re-implementar → duplica CD-8 (reutilización explícita) |
| Reuso de `isRedisAvailable` | Ídem | Dos archivos queriendo el mismo helper boolean, o circular import |
| Disciplina OWNERS | 1 archivo `core/idempotency.ts` es la **única** fachada al módulo Redis — patrón `routes → core → infra` mantenido exacto | 2 archivos; el route debería importar desde ambos |
| Tamaño del archivo | ~200 → ~340 LOC, razonable y bien comentado | 2 archivos de ~170 LOC cada uno |
| Test colocation | Un solo `core.idempotency.test.ts` (existente) + uno nuevo `core.idempotency.settle.test.ts` para scope claro | Dos archivos de tests igual, mismo overhead |
| Reversibilidad | Split a futuro es trivial (moverse 40 LOC a un archivo aparte si el archivo crece inmanejable) | Merge a futuro es trivial |

**CD derivado**: CD-14 (idempotency.ts no debe romper tests WFAC-20 existentes).

**Nota sobre `ToCacheableSettleInput`**: se declara **estructural** (sin importar
`SettleResult` de `src/chains/types.ts`) para preservar el boundary OWNERS actual
(`core/idempotency.ts` no importa `chains/*`). Esto ya fue establecido para
`ToCacheableInput` en WFAC-20 (ver `src/core/idempotency.ts:76-94`).

---

### DT-3 · resolución de MI-1 — Rate-limit `RATE_LIMIT_SETTLE_MAX=30` → **defer a WFAC-40 (rate-limiting epic)**

**Decisión**: **NO conectar** rate-limit hardcoded en WFAC-21. La env var
`RATE_LIMIT_SETTLE_MAX` no aparece hoy en `src/infra/env.ts`; este SDD NO la agrega.

**Justificación**:

1. La spec del work-item § Scope OUT lista explícitamente "Rate-limit específico para
   /settle" como fuera de scope.
2. `src/routes/health.ts` muestra el patrón `config: { rateLimit: false }` como
   placeholder para cuando el plugin global exista — no hay plugin `@fastify/rate-limit`
   instalado hoy (verificado vía `src/app.ts` — no registra plugin de rate-limit).
3. WFAC-40 (rate-limiting epic mencionado en BACKLOG.md post-hackathon) cubre la
   integración completa, con config env-driven por endpoint. Hacer un shim parcial
   aquí genera deuda técnica y puede colisionar con la config final.
4. Riesgo operacional hoy: el facilitator es interno (no público en V1); el
   risk-of-abuse sin rate-limit es bajo mientras el deployment sea detrás de la
   puerta del marketplace (wasiai-v2 / wasiai-a2a).

**Lo que sí hacemos en WFAC-21**:

- Documentamos en el SDD (aquí) que `RATE_LIMIT_SETTLE_MAX=30` es el valor
  objetivo para WFAC-40 (trazabilidad).
- El route usa `app.post('/settle', ...)` sin `config.rateLimit` — queda listo para
  que WFAC-40 agregue la config sin tocar la ruta.

**No-op**: ninguna env var nueva, ningún import de `@fastify/rate-limit`, ningún
middleware settle-specific.

---

### DT-4 · resolución de MI-2 — cache policy para 5xx → **NO cachear ningún 5xx** (idéntico a WFAC-20 CD-12)

**Decisión**: `toCacheableSettle(result)` retorna `null` cuando `result.error.http >= 500`.
Esto abarca tanto `SIMULATION_FAILED` (500) como `TRANSACTION_FAILED` (500). El
cliente podrá reintentar tras corregir params o esperar.

**Justificación**:

| Caso | Si cachéasemos 5xx | Comportamiento elegido (NO cachear) |
|------|---------------------|-------------------------------------|
| `SIMULATION_FAILED` por gas price spike transitorio | Cliente bloqueado 120 s sin poder reintentar aunque la red se normalice → degrade | Cliente puede retry inmediato; la tx nunca se ejecutó |
| `TRANSACTION_FAILED` por revert determinista (insuficiente balance surgió durante la ventana) | Ídem — cliente no puede recuperar con balance nuevo | Cliente puede retry con balance top-up |
| `TRANSACTION_FAILED` por timeout del receipt (tx en mempool sin mined) | **Escenario peligroso**: la tx PUEDE aún ejecutarse minada post-timeout → un retry del cliente PUEDE emitir una segunda tx → double-spend | Ver **Riesgo R1** abajo |
| 500 genérico (adapter bug) | Idempotency cachea basura; próximas consultas fallan idénticamente sin visibilidad | Cliente recibe 500 fresco cada vez → errores operacionales detectables |

**Riesgo R1 (documentado, no mitigado en V1)**: En el caso de receipt-timeout, si la
tx sigue viva en mempool y el cliente retry rápido, existe ventana de double-spend.
La mitigación real requiere idempotency by `authorization.nonce` (EIP-3009 nonce es
único por user+contract, diseñado justamente para esto — el segundo `writeContract`
con mismo nonce **revierte** on-chain, no ejecuta). La primera capa de defensa es
el propio protocolo EIP-3009; la idempotency Redis es la segunda capa. En V1 aceptamos
esta ventana porque:

1. El nonce del payload actúa como idempotency key on-chain: dos settles del mismo
   payload intentan el mismo nonce → el segundo revierte con `TRANSACTION_FAILED`.
2. Aceptar el riesgo es consistente con CD-12 de WFAC-20 (no cachear 5xx).
3. Cachear reverts permanentes requeriría distinguir revert determinista
   (error del signer) de timeout (error de infraestructura) — viem no expone ese
   discriminante con confiabilidad. Hackear heuristics sobre `err.message` viola el
   espíritu del código defensivo y CD-13 (sanitize) de WFAC-20.

Decisión formal: **mismo comportamiento que WFAC-20 — CD-12 aplicado literal a settle**.

---

### DT-5 · Response shape spec-literal (del work-item DT-3)

El body HTTP 200 emite **exactamente** los 7 campos de `SettleResult` (verificado vía
`src/chains/types.ts:101-109`):

```json
{
  "settled": true,
  "transactionHash": "0x...",
  "blockNumber": 12345,
  "amount": "1000000",
  "from": "0x...",
  "to": "0x...",
  "asset": "0x..."
}
```

- **SIN** el discriminante `ok` (se strippea en la route, CD-2).
- **SIN** campos extras (`duration_ms`, `request_id` van al log, no al body).
- El campo es `transactionHash` (camelCase, no `txHash` ni `tx_hash`) — confirmado en
  `src/chains/types.ts:103`. El log estructurado usa `tx_hash` (snake_case, convención
  Pino) — ver DT-7.

---

### DT-6 · `assetTransferMethod` guard en `settleCore` (del work-item DT-6)

`settleCore` replica el guard de `verifyCore` (ver `src/core/verify.ts:76-81`): si
`parsed.accepted.extra.assetTransferMethod !== 'eip3009'`, retornar
`{ ok: false, error: buildX402Error('NETWORK_MISMATCH', 'Method not supported: only eip3009 in v1') }`.

Esto preserva el single-point-of-decision pattern (un solo guard, un solo mensaje)
y hace trivial el refactor cuando WFAC-22+ agreguen Permit2 / ERC-7710.

---

### DT-7 · Logging de `tx_hash` en éxito (del work-item DT-4, AC-12)

**Decisión**: incluir `tx_hash: result.transactionHash` en la log line INFO de éxito.
Es información pública on-chain por diseño del protocolo — **no es PII ni secreto**. El
valor de la log line para auditoría, correlación de receipts y debug es alto.

**Mapping CD-3 vs tx_hash**:

| Campo | ¿PII? | ¿En log? |
|-------|-------|----------|
| `signature` (hex 65 bytes) | No estrictamente PII, pero **expone credencial criptográfica** del pagador → potencial replay fuera de contrato si el nonce no está consumido → PROHIBIDO | NO |
| `authorization.{from, to, value, nonce, validAfter, validBefore}` | Expone el pagador y la semántica financiera del payment | NO |
| `tx_hash` | Dato público en el explorer on-chain; inclusion post-mined es by-design auditable | SI (solo éxito) |
| `network`, `method`, `duration_ms`, `request_id`, `error_code`, `http_status` | Metadata operacional, sin PII | SI |

---

### DT-8 · Throws propagan desde `settleCore` (CD-4, igual que WFAC-20)

`settleCore` NUNCA captura throws del adapter. El route los atrapa en `try { await settleCore(...) } catch (err)` y emite log L4 + HTTP 500 TRANSACTION_FAILED.

**Justificación**: un throw del adapter = bug (viola el contrato de `ChainAdapter.settle`
que debe retornar `Promise<AdapterResult<SettleResult>>`). No es un error previsible.
Captar en core enmascararia el bug. La defensa-en-profundidad vive en el route.

---

## 3. Inheritance de CDs de WFAC-20

Leído `doc/sdd/009-wfac-20-verify-route/sdd.md` §5 y `src/core/idempotency.ts` header.
Aplican los siguientes CDs de WFAC-20 al nuevo código de WFAC-21:

### Heredados **literal** (sin cambio)

- **CD-1 (del WI WFAC-21)**: `src/routes/settle.ts` NO importa `src/chains/*`, `src/methods/*`, `src/infra/*` salvo vía helpers de `src/core/idempotency.ts`.
- **CD-3**: PROHIBIDO loguear `payload.signature`, `payload.authorization.*` en ningún nivel.
- **CD-4 (WFAC-20)**: `src/core/settle.ts` NUNCA throw por errores previstos — siempre `Result<SettleResult>`.
- **CD-5**: cada error path usa `reply.code(err.http).send({ error })` antes del return.
- **CD-6**: tests de route usan `app.inject()`, no `listen()` en puerto real.
- **CD-11 (WFAC-20)**: `canonicalStringify` es determinista sobre permutaciones de key-order (ya probado en WFAC-20; heredamos la función).
- **CD-12 (WFAC-20)**: PROHIBIDO cachear responses con `http >= 500` — `toCacheableSettle` implementa el guard.
- **CD-13 (WFAC-20)**: regex de parsing network `/^eip155:([1-9]\d*)$/u` en `settleCore` (herencia exacta de `verifyCore:37`).
- **CD-14 (WFAC-20)**: BigInt overflow guard para chainId `> MAX_SAFE_INTEGER` → retornar NETWORK_MISMATCH.
- **CD-15 (WFAC-20)**: tests usan fake adapters registered via `chainRegistry.register(...)`, NO los production adapters `src/chains/kite.ts` / `src/chains/avalanche.ts`.
- **CD-16 (WFAC-20)**: PROHIBIDO importar `src/chains/kite.ts` o `src/chains/avalanche.ts` desde los test files de esta HU.

### Adaptados (misma intención, shape distinto)

- **CD-2 (adaptado)**: response 200 spec-literal usa **los 7 campos de `SettleResult`**
  (`settled, transactionHash, blockNumber, amount, from, to, asset`), **NO** los 7 de
  VerifyResult. El strip del `ok` discriminante sigue la misma técnica — explicit object
  build (sin destructuring rest-spread, por la lección W1 del auto-blindaje WFAC-20).
- **CD-7 (adaptado)**: TTL declarado ONCE como `SETTLE_IDEMPOTENCY_TTL_SEC = 120`,
  separado de `VERIFY_IDEMPOTENCY_TTL_SEC`. Mismo valor (120), declaración propia —
  si spec separa TTLs en el futuro, no hay cambios cross-concept.
- **CD-8 (adaptado)**: reuso de `canonicalStringify` — `buildSettleIdempotencyKey`
  invoca `canonicalStringify(parsed)` directamente, **sin reimplementar**.
- **CD-9 (WFAC-20 → adaptado)**: `src/routes/settle.ts` usa `isRedisAvailable()`
  exportado por `src/core/idempotency.ts`. NO importa `getRedisClient` directo.
- **CD-10 (WFAC-20 → adaptado)**: `src/core/settle.ts` NO importa `src/methods/*`; el
  dispatch va por `chainRegistry.getAdapter(chainId).adapter.settle(params)`.

---

## 4. Architectural CDs adicionales (WFAC-21-specific)

- **CD-11 (nuevo)** — **OBLIGATORIO** que el idempotency-hit replay devuelva el
  body **exacto** cacheado, reconstruyendo el JSON shape spec-literal a partir de
  `cached.response` **sin re-serializar → re-parsear → re-serializar**. La función
  `sendCachedSettleResponse(reply, cached, ctx)` arma el body con los 7 campos
  de `CachedSettleResponseOk.response` directamente. Justificación: evitar drift
  por lossy JSON roundtrips (p.ej. keys reorder del `reply.send`) que rompan el
  invariante `r1.body === r2.body` (T-R12 equivalent en WFAC-20 verifica esto).

- **CD-12 (nuevo)** — **OBLIGATORIO** que la log line INFO de éxito incluya
  `tx_hash: result.transactionHash`. Este campo es el correlation identifier
  canónico para auditoría on-chain y **sin él** ningún log de `/settle` ok tiene
  valor investigativo (AC-12). En la variante cached-hit, el `tx_hash` se toma
  de `cached.response.transactionHash`. Justificación: Riesgo operacional —
  forensics post-incident requiere trazar request_id ↔ tx_hash sin leer body de
  response.

- **CD-13 (nuevo)** — **OBLIGATORIO** que los tests de route usen un fake adapter
  cuyo `settle()` retorne un `SettleResult` determinista (p.ej.
  `transactionHash = '0xdead...beef'` literal, `blockNumber: 1`). **PROHIBIDO**
  que el fake adapter invoke `walletClient.writeContract` real o `publicClient.simulateContract`
  real — eso lo ejerce el adapter unit test (`methods/eip3009/settle.test.ts`
  existente). El fake adapter del route test reemplaza `adapter.settle` con
  `vi.fn()` que retorna `Promise<AdapterResult<SettleResult>>`. Justificación:
  evitar tests que dependan de viem live mocks; preservar boundary "route
  tests integran HTTP + core, adapter unit tests integran viem".

- **CD-14 (nuevo)** — **PROHIBIDO** que la extensión de `src/core/idempotency.ts`
  rompa los tests existentes de WFAC-20 en `src/__tests__/unit/core.idempotency.test.ts`.
  Criterio de aceptación obligatorio: `npm run test -- core.idempotency.test.ts`
  debe seguir verde post-cambio. Esto implica NO renombrar exports de verify, NO
  cambiar signatures existentes, NO cambiar valores de constantes existentes.
  Solo **agregar** nuevos exports.

- **CD-15 (nuevo)** — **OBLIGATORIO** que `src/app.ts` registre `settleRoute`
  **inmediatamente después** de `verifyRoute` (orden: `healthRoute → verifyRoute → settleRoute`).
  **PROHIBIDO** usar `.register(...).then(...)` sin `await` (regla project-context
  "fastify.register siempre awaited", mismo patrón que WFAC-20 CD-7). Justificación:
  un orden predecible permite al AR auditar el pipeline de bootstrap sin ambigüedad;
  el `await` evita race conditions donde el server `listen` antes de que plugins carguen.

---

## 5. Waves detalladas (W0 → W3)

### W0 — Schemas + Types + Idempotency helpers (archivos MODIFIED)

**Artefactos**:

- `src/core/schemas.ts` — **MODIFY**.
- `src/core/idempotency.ts` — **MODIFY**.

**Cambios en `src/core/schemas.ts`**:

Agregar al final del archivo (después de `export type VerifyRequest = …`):

```ts
/**
 * Alias of VerifyRequestSchema — x402 spec declares the settle body shape
 * identical to verify (see src/chains/types.ts: SettleParams = VerifyParams).
 * Export distinct name for route-layer clarity (DT-1).
 *
 * If the spec ever diverges (e.g. settle adds an optional `tip` field), this
 * alias MUST be forked to its own Zod object in an explicit SDD — not drifted
 * silently.
 */
export const SettleRequestSchema = VerifyRequestSchema;
export type SettleRequest = VerifyRequest;
```

**Imports permitidos**: ninguno nuevo — `VerifyRequestSchema` y `VerifyRequest` ya
están locales.

**Criterios de completion**:

- `tsc --noEmit` verde.
- Exports nuevos accesibles desde `../core/schemas.js`.
- Zero cambio en los exports existentes de verify (CD-14 enforcement).

**Cambios en `src/core/idempotency.ts`**:

Agregar al final del archivo (después de `toCacheable`):

1. **Constantes**:

```ts
export const SETTLE_IDEMPOTENCY_TTL_SEC = 120;
export const SETTLE_IDEMPOTENCY_KEY_PREFIX = 'settle:idempotency:';
```

2. **Types**:

```ts
export interface CachedSettleResponseOk {
  readonly ok: true;
  readonly response: {
    readonly settled: true;
    readonly transactionHash: `0x${string}`;
    readonly blockNumber: number;
    readonly amount: string;
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    readonly asset: `0x${string}`;
  };
}

export interface CachedSettleResponseErr {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly http: number; // always < 500 by CD-12
  };
}

export type CachedSettleResponse =
  | CachedSettleResponseOk
  | CachedSettleResponseErr;

// Structural — NO import from src/chains/types.ts (OWNERS: core/idempotency.ts
// must NOT import chains/*). Mirrors the pattern used by ToCacheableInput.
export type ToCacheableSettleInput =
  | {
      readonly ok: true;
      readonly settled: true;
      readonly transactionHash: `0x${string}`;
      readonly blockNumber: number;
      readonly amount: string;
      readonly from: `0x${string}`;
      readonly to: `0x${string}`;
      readonly asset: `0x${string}`;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly http: number;
      };
    };
```

3. **Funciones**:

```ts
export function buildSettleIdempotencyKey(parsed: VerifyRequest): string {
  const canonical = canonicalStringify(parsed);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${SETTLE_IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

export async function getCachedSettleResponse(
  key: string,
): Promise<CachedSettleResponse | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedSettleResponse;
  } catch {
    return null;
  }
}

export async function setCachedSettleResponse(
  key: string,
  payload: CachedSettleResponse,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(
      key,
      JSON.stringify(payload),
      'EX',
      SETTLE_IDEMPOTENCY_TTL_SEC,
    );
  } catch {
    // swallow — graceful degradation
  }
}

export function toCacheableSettle(
  result: ToCacheableSettleInput,
): CachedSettleResponse | null {
  if (result.ok) {
    return {
      ok: true,
      response: {
        settled: result.settled,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        amount: result.amount,
        from: result.from,
        to: result.to,
        asset: result.asset,
      },
    };
  }
  if (result.error.http >= 500) return null; // CD-12
  return { ok: false, error: result.error };
}
```

**Imports permitidos**: ninguno nuevo — `createHash`, `getRedisClient`, `VerifyRequest`
ya están importados en el archivo.

**OWNERS audit**: el archivo sigue importando solo `node:crypto`, `../infra/redis.js`,
`./schemas.js` (type-only). No cruza a `src/chains/*` ni `src/methods/*`.

**Dependencias entre waves**: W0 no depende de W1+. Es el primer bloque.

**Criterios de completion**:

- `tsc --noEmit` verde.
- `npm run test -- core.idempotency.test.ts` (WFAC-20) sigue verde (CD-14).
- Los 7 nuevos exports son accesibles desde `../core/idempotency.js`.

**Tests de W0 (escritos en W3, suite `core.idempotency.settle.test.ts`)**: T-I1..T-I7 (ver §6).

---

### W1 — Core orchestrator (archivo NEW)

**Artefacto**: crear `src/core/settle.ts`.

**Export único**:

```ts
export async function settleCore(
  parsed: VerifyRequest, // alias for SettleRequest (DT-1)
): Promise<Result<SettleResult>>
```

**Flow interno** (espejo exacto de `src/core/verify.ts:42-103`; diff = dispatch invoca
`adapter.settle(params)` en vez de `adapter.verify(params)`):

1. **Parse network** (CD-13, CD-14 heredados):
   - Regex `/^eip155:([1-9]\d*)$/u`.
   - Overflow guard: `digits.length > MAX_CHAINID_DIGITS` o `BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)` → `NETWORK_MISMATCH`.
   - `chainId = asChainId(Number(digits))` (no try/catch — narrowing by regex).

2. **Guard method** (DT-6):
   - Si `parsed.accepted.extra.assetTransferMethod !== 'eip3009'` → `NETWORK_MISMATCH` con message `'Method not supported: only eip3009 in v1'`.

3. **Registry lookup**:
   - `const lookup = chainRegistry.getAdapter(chainId);`
   - Si `!lookup.ok` → passthrough `{ ok: false, error: lookup.error }`.

4. **Dispatch**:
   - `const params: SettleParams = parsed as unknown as SettleParams;`
   - Cast documentado con el mismo comentario que verifyCore (auto-blindaje WFAC-20
     entry 4: `Zod .regex() no narrow a template literal → cast sanctioned`).
   - `return lookup.adapter.settle(params);`
   - No try/catch — adapter throws propagan al route (CD-4 + DT-8).

**Imports** (OWNERS `core/*` → `core/*` + `chains/types.ts` type-only + `chains/registry.js` runtime):

```ts
import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { SettleParams, SettleResult } from '../chains/types.js';
```

**Prohibido** (CD-1 WI WFAC-21, CD-9 del WI, CD-10 WFAC-20):

- `src/methods/*` — dispatch exclusivo via registry.
- `src/routes/*` — core no conoce HTTP.
- `src/infra/*` — core no toca I/O directo (salvo `core/idempotency.ts` que es fachada).

**Constantes**: el archivo declara `EIP155_RE` y `MAX_CHAINID_DIGITS` idénticos a `verify.ts`.
Valoramos factorar a un helper compartido `src/core/network.ts` en una HU futura
(WFAC-22+) si aparece un tercer consumidor — por ahora, **NO refactorar** (CD-1 WI WFAC-21:
esta HU no toca `src/core/verify.ts`).

**Dependencias**: W1 depende de W0 (usa `VerifyRequest` type).

**Criterios de completion**:

- `tsc --noEmit` verde.
- Retorna siempre `Result<SettleResult>` (nunca throw para errores previstos).
- 4 paths cubiertos: network malformed, method not eip3009, chain not registered, adapter result (ok/err).

**Tests de W1 (escritos en W3, suite `core.settle.test.ts`)**: T-C1..T-C6.

---

### W2 — Route + app.ts register (archivos: NEW + MODIFY)

**Artefactos**:

- `src/routes/settle.ts` — **NEW**.
- `src/app.ts` — **MODIFY** (agregar 2 líneas: import + register).

**`src/routes/settle.ts`** — estructura (espejo exacto de `src/routes/verify.ts:61-179`):

```ts
export const settleRoute: FastifyPluginAsync = async (app) => {
  app.post('/settle', async (request, reply) => {
    const startMs = Date.now();
    const requestId = request.id;

    // Step 1 — Zod validation
    const parseResult = SettleRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      /* INVALID_PAYLOAD 400, warn log, no cache, return */
    }
    const parsed: SettleRequest = parseResult.data;

    // Step 2 — idempotency lookup
    const idempotencyKey = buildSettleIdempotencyKey(parsed);
    const redisUp = isRedisAvailable();
    if (redisUp) {
      const cached = await getCachedSettleResponse(idempotencyKey);
      if (cached) {
        return sendCachedSettle(reply, cached, { requestId, startMs, network, app });
      }
    } else {
      app.log.warn({ request_id: requestId }, 'idempotency cache miss — Redis unavailable');
    }

    // Step 3 — dispatch to core
    let result;
    try {
      result = await settleCore(parsed);
    } catch (err: unknown) {
      // L4 — adapter threw (defense-in-depth CD-4)
      app.log.error({
        request_id: requestId,
        error_code: 'TRANSACTION_FAILED',
        http_status: 500,
        err_type: (err as Error)?.name ?? 'UnknownError',
        duration_ms: Date.now() - startMs,
      }, 'settle adapter threw');
      return reply.code(500).send({
        error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 },
      });
    }

    // Step 4 — cache (CD-12 enforced inside toCacheableSettle)
    if (redisUp) {
      const cacheable = toCacheableSettle(result);
      if (cacheable) await setCachedSettleResponse(idempotencyKey, cacheable);
    }

    // Step 5 — map Result<SettleResult> → HTTP
    if (!result.ok) {
      app.log.warn({
        request_id: requestId,
        error_code: result.error.code,
        http_status: result.error.http,
        duration_ms: Date.now() - startMs,
      }, 'settle failed');
      return reply.code(result.error.http).send({ error: result.error });
    }

    // Success — L1 info with tx_hash (CD-12 nueva)
    app.log.info({
      request_id: requestId,
      network: parsed.accepted.network,
      method: 'eip3009',
      duration_ms: Date.now() - startMs,
      tx_hash: result.transactionHash,
    }, 'settle ok');

    // CD-2: spec-literal 200 body — explicit object build (auto-blindaje WFAC-20 W1
    // lesson: no destructure rest-spread with _-prefix to avoid eslint unused-var).
    return reply.code(200).send({
      settled: result.settled,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      amount: result.amount,
      from: result.from,
      to: result.to,
      asset: result.asset,
    });
  });
};

// helper sendCachedSettle (not exported) — emits info log with tx_hash when ok,
// warn log when err, and reply.send with the EXACT cached.response shape (CD-11 nuevo).
```

**Log templates** (adaptados de WFAC-20 §DT-Log):

| Line | Level | Trigger | Campos exactos |
|------|-------|---------|----------------|
| L1 | info | 200 settle ok (fresh or cached) | `{ msg: "settle ok", request_id, network, method: "eip3009", duration_ms, tx_hash }` (+ `cached: true` si hit) |
| L2 | warn | Redis unavailable | `{ msg: "idempotency cache miss — Redis unavailable", request_id }` |
| L3 | warn | 4xx error (validation, adapter) | `{ msg: "settle failed", request_id, error_code, http_status, duration_ms }` |
| L4 | error | Adapter threw (defense) | `{ msg: "settle adapter threw", request_id, error_code: "TRANSACTION_FAILED", http_status: 500, err_type, duration_ms }` |

**Route-local types** (espejo de WFAC-20):

```ts
type SettleRouteErrorCode =
  | 'INVALID_SIGNATURE' | 'INSUFFICIENT_BALANCE' | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION' | 'NETWORK_MISMATCH' | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT' | 'INVALID_RECEIVER' | 'TRANSACTION_FAILED' | 'DELEGATION_INVALID'
  | 'INVALID_PAYLOAD';

interface ErrorBody {
  readonly error: {
    readonly code: SettleRouteErrorCode;
    readonly message: string;
    readonly http: number;
  };
}
```

**Constantes**: `const ZOD_MESSAGE_MAX_LEN = 200;` (idéntico a verify).

**Imports permitidos** (CD-1 WI WFAC-21):

```ts
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SettleRequestSchema, type SettleRequest } from '../core/schemas.js';
import { settleCore } from '../core/settle.js';
import {
  buildSettleIdempotencyKey,
  getCachedSettleResponse,
  setCachedSettleResponse,
  isRedisAvailable,
  toCacheableSettle,
  type CachedSettleResponse,
} from '../core/idempotency.js';
```

**Prohibido**: `src/chains/*`, `src/methods/*`, `src/infra/*`, viem, ioredis, node:crypto.

---

**`src/app.ts` cambios** (CD-15 nuevo — orden estricto):

```ts
// Agregar al bloque de imports (después de verifyRoute):
import { settleRoute } from './routes/settle.js';

// Dentro de buildApp, después de await app.register(verifyRoute):
await app.register(settleRoute);
```

Zero cambios adicionales — el onClose hook de Redis ya cubre settle (getRedisClient
es singleton global).

**Dependencias entre waves**: W2 depende de W0 (schemas/idempotency helpers) + W1 (settleCore).

**Criterios de completion**:

- `app.inject({ method: 'POST', url: '/settle', ... })` retorna 200 con 7-field shape (AC-1).
- `app.inject` con body malformado → 400 INVALID_PAYLOAD (AC-2), adapter NOT called.
- Cobertura de 14 ACs via W3 tests.

---

### W3 — Tests (3 archivos NEW)

**Artefactos**:

- `src/__tests__/unit/core.idempotency.settle.test.ts` — **NEW** (cubre helpers W0).
- `src/__tests__/unit/core.settle.test.ts` — **NEW** (cubre `settleCore` W1).
- `src/__tests__/unit/routes.settle.test.ts` — **NEW** (cubre route W2 + end-to-end ACs).

**Estrategia de mocks** (heredada de WFAC-20):

- `vi.mock('ioredis')` con RedisMock class + Map-backed get/set (copy literal del
  file `src/__tests__/unit/routes.verify.test.ts:36-86`).
- `CaptureStream` (copy literal de `routes.verify.test.ts:89-102`) para log assertions.
- `chainRegistry._resetForTesting()` + `chainRegistry.register(fakeAdapter)` en `beforeEach`.
- `makeFakeAdapter(chainIdNum, settleImpl)` helper — idéntico a el de routes.verify.test.ts
  pero con `.settle = settleImpl`, `.verify = vi.fn()`.
- Fixture `VALID_BODY` reusable (mismo shape).
- Fixture `VALID_SETTLE_RESULT` nuevo:

```ts
const VALID_SETTLE_RESULT = {
  ok: true as const,
  settled: true as const,
  transactionHash: `0x${'de'.repeat(16)}beef${'ab'.repeat(3)}fe` as `0x${string}`, // 66-char determinista
  blockNumber: 12345,
  amount: '1000000',
  from: `0x${'33'.repeat(20)}` as `0x${string}`,
  to: `0x${'22'.repeat(20)}` as `0x${string}`,
  asset: `0x${'11'.repeat(20)}` as `0x${string}`,
};
```

- `buildAppWithAdapter(adapter, { capture, env })` helper — copy adaptado del WFAC-20 test.

**Dependencias**: W3 depende de W0 + W1 + W2.

**Criterios de completion**:

- `npm run test` verde completo.
- `npm run typecheck` verde.
- `npm run lint` verde (zero warnings).
- Cobertura `src/core/settle.ts` + `src/routes/settle.ts` ≥ 90% (mandato auto-blindaje WFAC-20).
- Tests WFAC-20 **siguen verdes** (CD-14).

---

## 6. Test Plan por AC (≥1 test por cada uno de los 14 ACs + tests CD-específicos)

| AC | Test file | Test ID / name | Strategy |
|----|-----------|----------------|----------|
| AC-1 | `routes.settle.test.ts` | **T-R1**: returns 200 with 7-field SettleResult body | `app.inject` happy path. Assert `Object.keys(body).sort()` === sorted 7 fields. Assert `body.settled === true`, `body.transactionHash === VALID_SETTLE_RESULT.transactionHash`. |
| AC-2 | `routes.settle.test.ts` | **T-R2**: 400 INVALID_PAYLOAD on malformed body, adapter.settle NOT called | 3 sub-cases: missing `x402Version`, `x402Version = 1`, missing `resource`. Spy on fakeAdapter.settle, assert `not.toHaveBeenCalled()`. Assert `body.error.code === 'INVALID_PAYLOAD'`. |
| AC-3 | `routes.settle.test.ts` | **T-R3**: 400 NETWORK_MISMATCH for bad `network` format or unregistered chain | 3 sub-cases: `network = 'solana:1'`, `network = 'eip155:0'` (CD-13), `network = 'eip155:999999'` (not registered). |
| AC-4 | `routes.settle.test.ts` | **T-R4**: 401 INVALID_SIGNATURE passthrough (adapter returns error) | Fake adapter `settle` returns `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 } }`. Assert statusCode 401, body.error exact match. |
| AC-5 | `routes.settle.test.ts` | **T-R5**: 402 INSUFFICIENT_BALANCE passthrough | Fake adapter returns http 402 err. Assert statusCode 402. |
| AC-6 | `routes.settle.test.ts` | **T-R6**: 500 SIMULATION_FAILED + NOT cached (two calls, adapter called twice) | Fake adapter settle returns http 500 err with code SIMULATION_FAILED. First inject 500, second inject 500, assert `settleSpy.toHaveBeenCalledTimes(2)`. |
| AC-7 | `routes.settle.test.ts` | **T-R7**: 500 TRANSACTION_FAILED + NOT cached | Idem AC-6 con code TRANSACTION_FAILED. |
| AC-8 | `routes.settle.test.ts` | **T-R8**: idempotency hit 200 — two identical requests, adapter called once | Fake adapter returns success. First inject stores in Redis (via RedisMock), second inject reads cache. Assert `settleSpy.toHaveBeenCalledTimes(1)`, `r1.body === r2.body`, statusCode 200 twice. |
| AC-9 | `routes.settle.test.ts` | **T-R9**: idempotency hit 4xx — cached error replays verbatim | Fake adapter returns http 401. First inject cache, second reads. Assert adapter called once, both 401 responses identical. |
| AC-10 | `routes.settle.test.ts` | **T-R10**: Redis unavailable → warn log + proceed | `REDIS_URL: undefined` env. Assert response 200. Assert capture lines contains `msg: 'idempotency cache miss — Redis unavailable'` with `request_id`. |
| AC-11 | `routes.settle.test.ts` | **T-R11**: adapter throws → 500 + error log | Fake adapter `settle` throws `new Error('adapter boom')`. Assert statusCode 500, body.error.code === 'TRANSACTION_FAILED'. Assert error log line `msg: 'settle adapter threw'` with `err_type: 'Error'`, `duration_ms: <number>`. |
| AC-12 | `routes.settle.test.ts` | **T-R12**: success log contains tx_hash, NO PII | Fake adapter returns success. Assert info log `msg: 'settle ok'` contains `tx_hash === VALID_SETTLE_RESULT.transactionHash`, `request_id`, `network`, `method: 'eip3009'`, `duration_ms`. Assert `JSON.stringify(logLine)` does NOT contain `VALID_BODY.payload.signature` nor `VALID_BODY.payload.authorization.nonce`. |
| AC-13 | `routes.settle.test.ts` | **T-R13**: error log has error_code + http_status + duration_ms, NO PII | Loop 3 error cases (INVALID_PAYLOAD, NETWORK_MISMATCH, INVALID_SIGNATURE adapter). Each: find warn log `msg: 'settle failed'`, assert fields present, assert JSON.stringify does NOT contain signature/nonce/from/to values. |
| AC-14 | `routes.settle.test.ts` | **T-R14**: non-JSON Content-Type → 415 or 400 (Fastify delegated) | `app.inject({ headers: { 'content-type': 'text/plain' }, payload: '{}' })`. Assert `res.statusCode in [400, 415]` (Fastify v5 default). |

**Tests de CDs nuevos (además de los 14 ACs)**:

| CD | Test file | Test ID / name | Strategy |
|----|-----------|----------------|----------|
| CD-11 (body cached exacto) | `routes.settle.test.ts` | **T-R15**: cached 200 replay → `Object.keys(r2.body)` identical to `r1.body` order | Two injects, happy path. Assert `r1.body === r2.body` byte-exact string comparison. |
| CD-12 (tx_hash en éxito) | `routes.settle.test.ts` | **T-R16**: cached-hit log also contains tx_hash | Second inject (cached path). Find `msg: 'settle ok'` with `cached: true`. Assert `tx_hash === VALID_SETTLE_RESULT.transactionHash`. |
| CD-13 (fake adapter determinista) | `routes.settle.test.ts` | **T-R17**: fake adapter does NOT invoke real writeContract | Assert `fakeAdapter.getWalletClient()` returns the stubbed `vi.fn()`, never invoked in happy path (settle returns pre-computed result). |
| CD-14 (no rompe WFAC-20 tests) | run `npm run test` | Suite-level assertion | `core.idempotency.test.ts` (12+ tests) pasan verde post-cambios W0. CI enforcement. |
| CD-15 (app.ts orden) | `routes.settle.test.ts` | **T-R18**: `buildApp()` registers both verify and settle; both injects work in same instance | Build app, inject POST /verify + POST /settle, assert both return 200/400 respectively. |

**Tests de `src/core/settle.ts` (orchestrator puro, sin Fastify)**:

| ID | Test file | Name |
|----|-----------|------|
| T-C1 | `core.settle.test.ts` | `settleCore` retorna NETWORK_MISMATCH cuando `network` no matchea `eip155:<N>` |
| T-C2 | `core.settle.test.ts` | `settleCore` retorna NETWORK_MISMATCH para `eip155:0` (CD-13) |
| T-C3 | `core.settle.test.ts` | `settleCore` retorna NETWORK_MISMATCH cuando `assetTransferMethod !== 'eip3009'` |
| T-C4 | `core.settle.test.ts` | `settleCore` retorna lookup.error cuando chainId no está registrado |
| T-C5 | `core.settle.test.ts` | `settleCore` passes params unchanged to `adapter.settle` |
| T-C6 | `core.settle.test.ts` | `settleCore` retorna passthrough del `adapter.settle` Result |
| T-C7 | `core.settle.test.ts` | `settleCore` NO captura excepciones del adapter (propaga) |
| T-C8 | `core.settle.test.ts` | `settleCore` retorna NETWORK_MISMATCH para chainId > MAX_SAFE_INTEGER (CD-14) |

**Tests de `src/core/idempotency.ts` extensión settle**:

| ID | Test file | Name |
|----|-----------|------|
| T-I1 | `core.idempotency.settle.test.ts` | `SETTLE_IDEMPOTENCY_TTL_SEC === 120` |
| T-I2 | `core.idempotency.settle.test.ts` | `SETTLE_IDEMPOTENCY_KEY_PREFIX === 'settle:idempotency:'` y distinto al prefix de verify |
| T-I3 | `core.idempotency.settle.test.ts` | `buildSettleIdempotencyKey` es determinista sobre permutaciones de key-order |
| T-I4 | `core.idempotency.settle.test.ts` | `buildSettleIdempotencyKey(parsedA) !== buildIdempotencyKey(parsedA)` (prefijos distintos → keys distintas aunque payload idéntico) |
| T-I5 | `core.idempotency.settle.test.ts` | `getCachedSettleResponse` retorna null cuando Redis null |
| T-I6 | `core.idempotency.settle.test.ts` | `setCachedSettleResponse` usa EX TTL = `SETTLE_IDEMPOTENCY_TTL_SEC` |
| T-I7 | `core.idempotency.settle.test.ts` | `toCacheableSettle(http=500)` retorna null (CD-12) |
| T-I8 | `core.idempotency.settle.test.ts` | `toCacheableSettle(ok success)` preserva los 7 campos spec-literal |
| T-I9 | `core.idempotency.settle.test.ts` | `getCachedSettleResponse` swallows redis.get throw |
| T-I10 | `core.idempotency.settle.test.ts` | `setCachedSettleResponse` swallows redis.set throw |

**Total esperado**: 14 (ACs) + 5 (CDs nuevos) + 8 (core.settle) + 10 (idempotency settle) = **37 tests mínimos**.

---

## 7. Exemplar Verification (paths reales)

### Archivos leídos (con Read) — toda referencia al codebase

| # | Path | Uso | Patrón extraído |
|---|------|-----|-----------------|
| 1 | `src/core/schemas.ts:91-100` | W0 MODIFY | `VerifyRequestSchema` + `type VerifyRequest = z.infer<...>` — alias base |
| 2 | `src/core/idempotency.ts:36-208` | W0 MODIFY | Full file layout: constantes, types `Cached*Response*`, `ToCacheableInput`, `canonicalStringify`, `buildIdempotencyKey`, `getCachedVerifyResponse`, `setCachedVerifyResponse`, `toCacheable`, `isRedisAvailable` — estructura espejo para settle |
| 3 | `src/core/verify.ts:42-103` | W1 espejo | Flow del orchestrator: regex network + BigInt overflow + registry + dispatch, con comentarios CD-4, CD-10, CD-14 explícitos |
| 4 | `src/routes/verify.ts:61-225` | W2 espejo | FastifyPluginAsync + 5-step flow + `sendCached` helper + L1..L4 log templates + CD-2 explicit object build |
| 5 | `src/app.ts:50-69` | W2 MODIFY | `buildApp` con `await app.register(route)` pattern; `onClose` hook de Redis |
| 6 | `src/chains/types.ts:99-109` | DT-1 + DT-5 | `SettleParams = VerifyParams`; `SettleResult` con 7 campos `transactionHash: 0x{string}, blockNumber: number, amount: string, from: Address, to: Address, asset: Address` |
| 7 | `src/methods/eip3009/settle.ts:48-148` | Info (no modificar) | Confirm `settleEip3009` retorna `AdapterResult<SettleResult>` con los 7 campos exactos. Confirm adapter nunca throw para errores previstos |
| 8 | `src/__tests__/unit/routes.verify.test.ts:1-753` | W3 espejo | Estrategia completa: vi.mock('ioredis') + CaptureStream + makeFakeAdapter + VALID_BODY fixture + buildAppWithAdapter helper + 20+ test cases cubriendo 13 ACs + CD extras |
| 9 | `src/__tests__/unit/core.idempotency.test.ts:1-80` | W3 espejo | Pattern de tests para idempotency.ts: vi.mock ioredis + resetRedisClientForTests + coverage map con CD references |
| 10 | `OWNERS.md:22-31` | Compliance | Matrix confirma `routes → core + infra`; `core → infra + tipos + zod`, NO `chains/*` ni `methods/*` directo desde routes. Excepción [1] documenta `methods → core/errors.ts` (irrelevante para WFAC-21) |
| 11 | `doc/sdd/009-wfac-20-verify-route/sdd.md:455-513` | CD inheritance | Lista completa CD-1..CD-16 de WFAC-20. Mapping explícito en §3 de este SDD |
| 12 | `doc/sdd/009-wfac-20-verify-route/auto-blindaje.md:1-95` | Lessons learned | 4 entries: (1) import pruning lint rule, (2) `_ok` rest-destructure lint error → use explicit object build, (3) collapse unreachable defensive branches para coverage, (4) `as unknown as VerifyParams` cast sanctioned |
| 13 | `doc/sdd/_INDEX.md` | Status | WFAC-20 DONE en main@5296b89; WFAC-21 branch `feat/010-wfac-21-settle-route` |

### Paths que se CREAN (verificado `ls src/core/`, `ls src/routes/`, `ls src/__tests__/unit/`)

| Path | Existe hoy? | Acción |
|------|-------------|--------|
| `src/core/settle.ts` | NO (ls: `errors.ts`, `idempotency.ts`, `schemas.ts`, `types.ts`, `verify.ts`) | CREATE |
| `src/routes/settle.ts` | NO (ls: `health.ts`, `verify.ts`) | CREATE |
| `src/__tests__/unit/core.settle.test.ts` | NO | CREATE |
| `src/__tests__/unit/core.idempotency.settle.test.ts` | NO | CREATE |
| `src/__tests__/unit/routes.settle.test.ts` | NO | CREATE |

### Paths que se MODIFICAN

| Path | Cambio | Tamaño estimado |
|------|--------|-----------------|
| `src/core/schemas.ts` | Agregar 2 exports (const + type) al final | +8 LOC |
| `src/core/idempotency.ts` | Agregar 2 constantes, 3 types, 4 funciones | +130 LOC |
| `src/app.ts` | +1 import, +1 `await app.register(settleRoute)` | +2 LOC |

---

## 8. Historical Auto-Blindaje (lecciones heredadas de WFAC-20)

Leído `doc/sdd/009-wfac-20-verify-route/auto-blindaje.md`. Las 4 lessons aplican
parcial o directamente:

| Lesson WFAC-20 | Aplicabilidad a WFAC-21 | Protección en este SDD |
|----------------|--------------------------|------------------------|
| **[W0 Bytes32HexSchema unused import]** — imports transitivos disparan `no-unused-vars` | Bajo — `SettleRequestSchema` es alias, no re-declara imports | N/A (no hay nuevos imports en schemas.ts — solo re-export) |
| **[W1 `_ok` rest-destructure lint error]** — ESLint no tiene `varsIgnorePattern` | **Alto** — el route settle strippea el `ok` discriminante al enviar el body 200 y al hacer toCacheableSettle | **CD-11 nuevo** explicitamente mandata explicit object build, NO destructure rest-spread. Código en §5 W2 usa `{ settled: result.settled, transactionHash: ..., ... }` literal |
| **[W4 Unreachable defensive branches → cobertura ↓]** | **Alto** — `settleCore` tiene las mismas condiciones (regex + BigInt guard) que `verifyCore` | Instrucción explícita en §5 W1: "no try/catch alrededor de `asChainId(Number(digits))`", "colapsar `m === null || m[1] === undefined` en un solo return path". Copiar el patrón exacto de `verify.ts:49-73` |
| **[W0 VerifyRequest no asignable a VerifyParams por signature type]** | **Alto** — `SettleRequest → SettleParams` tiene el mismo gap (signature, asset, payTo, nonce, from, to son `string` por Zod `.regex()`, pero `SettleParams` los declara `` `0x${string}` ``) | **DT-1** documenta el alias; **§5 W1** documenta el cast `as unknown as SettleParams` con el mismo comentario que `verifyCore:96-101` (cita auto-blindaje entry 4) |

**Lesson nueva propuesta (pre-blindaje de WFAC-21)**:

- Si el Dev siente la tentación de refactorar `EIP155_RE` y `MAX_CHAINID_DIGITS` a un helper
  `src/core/network.ts` durante la implementación: **PARAR**. Eso está fuera de scope de esta HU
  (WFAC-21 no toca `src/core/verify.ts`). Abrir WFAC-22+ si emerge un tercer consumidor.

---

## 9. Readiness Check (self-audit)

| Criterio | Status | Nota |
|----------|--------|------|
| Todos los MI del work-item resueltos? | **YES** | MI-1 → DT-3 (defer WFAC-40), MI-2 → DT-4 (no cachear 5xx), MI-3 → DT-1 (alias), MI-4 → DT-2 (extender idempotency.ts) |
| Test plan cubre 100% de los 14 ACs? | **YES** | Tabla §6: 14 ACs × ≥1 test + 5 CD-tests + 8 core.settle tests + 10 idempotency settle tests = 37 mínimos |
| Boundaries OWNERS respetados (wave por wave)? | **YES** | §5: routes → `core/*` (schemas, settle, idempotency); core/settle → `chains/types` type-only + `chains/registry` runtime; core/idempotency → `infra/redis` + type-only schemas. Zero cross-project imports |
| Auto-blindajes históricos aplicados como CDs explícitos? | **YES** | §8 mappea las 4 lessons a CDs/DT específicos (CD-11 explicit object build, DT-1 alias + cast documentado, §5 W1 no try/catch defensive, no refactor cross-file) |
| Exemplars verificados con Read? | **YES** | 13 paths leídos (§7); 5 nuevos paths confirmados no-existentes |
| Artefactos a crear están fuera de lo ya existente? | **YES** | `ls src/core/`, `ls src/routes/`, `ls src/__tests__/unit/` confirman paths únicos |
| CD sobre secrets/hardcodes respetados? | **YES** | Sin URLs, addresses, chainIds hardcodeados — todo viene del registry fake adapter en tests y del env/registry en runtime |
| Patrón "service-layer returns discriminated union" preservado? | **YES** | `settleCore` retorna `Result<SettleResult>`; `adapter.settle` retorna `AdapterResult<SettleResult>` = `Result<SettleResult>`; `get*CachedResponse` retorna `null | CachedResponse` |
| Log policy cumple CD-3? | **YES** | DT-7 lista los 4 log templates + los campos PROHIBIDOS; `tx_hash` es explícitamente AUTORIZADO en éxito (dato público on-chain) |
| Rate-limit manejo documentado? | **YES** | DT-3 explicita defer a WFAC-40, sin env var nueva, sin middleware |
| Tests WFAC-20 siguen verdes post-cambio (CD-14 nuevo)? | **PLAN** | §5 W0 exige validación con `npm run test -- core.idempotency.test.ts`; enforcement es responsabilidad del Dev |

### Riesgos identificados (no bloqueantes)

1. **R1 (medio, documentado en DT-4)** — Receipt-timeout double-spend window: si la tx
   está in-flight mempool post-timeout y el cliente retry inmediato, dos `writeContract`
   pueden emitirse. **Mitigación V1**: el nonce EIP-3009 es la segunda barrera on-chain
   (la segunda tx revierte). Tracking: abrir HU futura (WFAC-42 BullMQ queue) para
   distinguir revert de timeout a nivel logging.

2. **R2 (bajo)** — WaveL1 propagation: si el Dev al escribir `settleCore` copia
   `verifyCore` textualmente pero olvida cambiar `lookup.adapter.verify(params)` por
   `lookup.adapter.settle(params)`, el tipo compila (ambos métodos retornan
   `AdapterResult<T>` pero con T distinto — `VerifyResult` vs `SettleResult`). **Mitigación**:
   tests T-C5, T-C6 asertan explícitamente que el fake adapter recibe `settle` y retorna
   `settled: true` — un typo se detecta en rojo test.

3. **R3 (bajo)** — Falso positivo idempotency entre verify y settle: si el cliente
   envía el mismo body a ambos endpoints, el hash interno del payload es igual, pero
   el prefix (`verify:idempotency:` vs `settle:idempotency:`) los separa en Redis. T-I4
   cubre este invariante. **Mitigación CD-6 heredada del WI**: prefixes distintos obligatorios.

4. **R4 (bajo)** — Orden en `src/app.ts`: si alguien (HU futura) registra otro plugin
   entre `verifyRoute` y `settleRoute`, podría alterar el orden esperado. **Mitigación**:
   CD-15 nuevo + enforcement en AR (grep literal del orden).

5. **R5 (bajo)** — El `transactionHash` del fixture de test es un literal determinista
   (`0xdead...beef...`); si algún test de otra HU usa el mismo literal, los
   test-case isolation se rompe. **Mitigación**: `chainRegistry._resetForTesting()` +
   `resetRedisClientForTests()` en beforeEach limpian todo state global.

---

## 10. Open Questions (non-blocking para F2.5 / F3)

**Ninguna**. Los 4 MI del work-item están resueltos en §2 (DT-1..DT-4). El Dev puede
avanzar a F2.5 (Story File) y F3 (implementación) sin input humano adicional.

Si el operador de producto decide a futuro:

- (a) Implementar rate-limit ahora y no esperar WFAC-40 → abrir HU diferenciada, NO
  expandir WFAC-21.
- (b) Cachear reverts permanentes para proteger contra double-spend en timeout →
  abrir WFAC-21.1 (SDD separado) — requiere distinguir revert vs timeout a nivel
  `methods/eip3009/settle.ts`, cambio cross-boundary.

---

## 11. Resumen ejecutivo (para orquestador)

- **Waves**: 4 (W0 schemas+idempotency MODIFY, W1 core/settle NEW, W2 route+app.ts NEW+MODIFY, W3 tests NEW).
- **Archivos**: 3 NEW (`src/core/settle.ts`, `src/routes/settle.ts`, 3 tests nuevos) + 3 MODIFY (`src/core/schemas.ts`, `src/core/idempotency.ts`, `src/app.ts`).
- **Tests**: 37 mínimos en 3 suites nuevas.
- **DTs**: 8 (DT-1..DT-8). **MI resueltos**: 4/4.
- **CDs heredados WFAC-20**: 12 (CD-1..CD-10 WI + CD-11..CD-16 arquitectónicos de WFAC-20 SDD, adaptados/literales).
- **CDs nuevos WFAC-21**: 5 (CD-11 body cached exacto, CD-12 tx_hash en log, CD-13 fake adapter determinista, CD-14 no romper WFAC-20, CD-15 orden en app.ts).
- **Riesgos**: 5 bajos/medios documentados, ninguno bloqueante.
- **Auto-blindaje WFAC-20**: 4 lessons aplicadas como CDs/DTs concretos.
- **Readiness**: **PASS**.

---

*Generated by nexus-architect · F2 SDD · 2026-04-23*
