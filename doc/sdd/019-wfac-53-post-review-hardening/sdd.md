# SDD #019 — WFAC-53 Post-review hardening (multi-chain, multi-consumer)

> SPEC_APPROVED: no
> Fecha: 2026-05-11
> Tipo: security-hardening
> SDD_MODE: full
> Branch: `fix/wfac-53-post-review-hardening`
> Base commit: `d6ccd5f` (main post-PR #34)
> Baseline: 553/553 tests
> Artefactos: `doc/sdd/019-wfac-53-post-review-hardening/`

---

## 1. Resumen

Incorporar 6 fixes surgidos del code review externo sobre PR #34 (mainnet
adapters Kite+Avalanche). El servicio corre sobre 4 chains (Kite testnet 2368,
Kite mainnet 2366, Avalanche Fuji 43113, Avalanche mainnet 43114) y sirve a
2 consumers (wasiai-v2, wasiai-a2a). Los fixes cubren:

- **FIX-1** CORS whitelist via `CORS_ALLOWED_ORIGINS` env (sin breaking change).
- **FIX-2** Boot-time per-chain `DOMAIN_SEPARATOR()` assertion vs valor on-chain.
- **FIX-3** APPEND a `doc/architecture/SECURITY.md` (failure modes + operator wallet + reporting).
- **FIX-4** Eliminar 5 `eslint-disable security/detect-object-injection` mediante refactor estructural a `switch` literal.
- **FIX-5** Merge externo de Dependabot PR #10 (sin commit local).
- **FIX-6** `SETTLE_CAP_FAIL_MODE` (default `'open'` → zero breaking change) que habilita opt-in al fail-closed.

Result: zero-regression sobre las 553 tests existentes + ≥10 nuevos tests
para los ACs, sin tocar `src/core/*` salvo `settle-cap.ts`, sin tocar
`src/methods/*` salvo `abi.ts` (ABI sync requerida por `T-SDD-1`).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 019 |
| **HU Jira** | WFAC-53 |
| **Tipo** | security-hardening |
| **SDD_MODE** | full |
| **Smart Sizing** | QUALITY |
| **Categoría riesgo** | ALTA — boot logic + multi-chain + security path |
| **Objetivo** | Cerrar 6 hallazgos del code review externo sobre PR #34, preservando los 553 tests verdes y zero breaking change para consumers existentes. |
| **Scope IN** | `src/app.ts`, `src/infra/env.ts`, `src/core/settle-cap.ts`, `src/chains/abi/fiat-token.ts`, `src/methods/eip3009/abi.ts`, `src/chains/init-domain-check.ts` (NEW), `src/chains/kite.ts`, `src/chains/avalanche.ts`, `src/routes/settle.ts` (route-local error union + handling), `doc/architecture/SECURITY.md`, + 5 test files. |
| **Scope OUT** | `src/core/*` (excepto `settle-cap.ts`), `src/methods/**` (excepto `abi.ts` sync), `src/routes/*` (excepto `settle.ts` para FIX-6 wiring del nuevo error code), `src/middleware/**`, `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/chains/registry.ts`, `openapi.yaml`, `BACKLOG.md`, Dependabot PRs #3–#7 (HOLD). |
| **Missing Inputs** | FIX-3 Reporting section: `security@wasiai.io` + 48h SLA (provisional aceptado del Analyst). To-verify-pre-merge si el operador prefiere otro contacto. |

### Acceptance Criteria (EARS) — 19 ACs heredados del work-item

Heredados verbatim del `work-item.md` (AC-1 a AC-19). Mapping AC→test en §6.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos y patrones extraídos

| Archivo | Por qué leerlo | Patrón extraído |
|---------|----------------|-----------------|
| `src/app.ts` (246 líneas) | FIX-1: CORS register + FIX-2 inyección post-`initChainBreakers`. | `await app.register(cors, { origin: true, ... })` actual (líneas 105-110); `initChainBreakers(app.log as unknown as Logger)` en línea 187 (cast pino). Conditional plugin pattern (`if (env.RATE_LIMIT_ENABLED)` líneas 116-178). |
| `src/index.ts` (72 líneas) | DT-I: confirma que el orden bootstrap es `parseEnv → buildApp → listen`; tests usan `buildApp({ env })` sin pasar por index. | `index.ts` solo orquesta listen/shutdown; toda la lógica de bootstrap (Redis, Supabase, Chains, Breakers) está en `buildApp`. **Decisión DT-I:** `initDomainCheck()` debe vivir DENTRO de `buildApp()`, no de `index.ts`, para que los tests lo ejerciten. |
| `src/infra/env.ts` (172 líneas) | FIX-1 + FIX-6: agregar 2 vars. | Patrón `z.string().optional()` para opt-in (línea 21 REDIS_URL); patrón `z.enum(['true','false']).default('true').transform(v => v === 'true')` para booleans (líneas 42-45 RATE_LIMIT_ENABLED); patrón `.superRefine()` para validaciones cruzadas (líneas 122-146). FIX-6 usa `z.enum(['open','closed']).default('open')` SIN transform — el valor crudo ya es discriminado. |
| `src/__tests__/unit/env.test.ts` (468 líneas) | Patrón de tests de Zod parsing. | `parseEnv({ NODE_ENV: 'test', VAR: 'value' })` + `expect(result.VAR).toBe(...)`; uso de `vi.spyOn(process, 'exit')` + `vi.spyOn(process.stderr, 'write')` para casos de fail (líneas 22-34). Tests existentes ya cubren `RATE_LIMIT_ENABLED`/`CB_ENABLED` con el mismo enum pattern. |
| `src/chains/kite.ts` (líneas 60-160, 577-606) | FIX-4: 3 ubicaciones con `eslint-disable security/detect-object-injection`. | `function readEnv(name: string, chainId: number)` (líneas 68-75) hace `process.env[name]` con disable comment. `readUsdcAddress` (líneas 586-593) y `readEnabledFlag` (líneas 602-606) idéntico. Las 3 helpers son llamadas SOLO con literales hardcoded (`'KITE_TESTNET_RPC_URL'`, `'KITE_USDC_ADDRESS'`, etc.). |
| `src/chains/avalanche.ts` (líneas 95-130) | FIX-4: 2 ubicaciones. | `readRpcUrl(envVarName, chainIdNum)` líneas 104-111 y `readEnabledFlag(envVarName)` líneas 119-123. Mismo pattern que kite.ts. |
| `src/chains/abi/fiat-token.ts` (80 líneas) | FIX-2 ABI: agregar `DOMAIN_SEPARATOR()` view. | Estructura `as const` array con entries `{ type, name, stateMutability, inputs, outputs }`. DT-G work-item especifica: `stateMutability: 'view'`, `inputs: []`, `outputs: [{ type: 'bytes32' }]`. |
| `src/methods/eip3009/abi.ts` (67 líneas) | FIX-2: sync target (ABI byte-for-byte). | Idéntica estructura a `src/chains/abi/fiat-token.ts`. Comentarios encabezando file deben mantener sincronía narrativa (no son verificados por test, sólo el `JSON.stringify` de los exports). |
| `src/__tests__/unit/chain-adapter.test.ts` (líneas 1046-1100) | Confirmar que `T-SDD-1-ABI-SYNC` cubre `DOMAIN_SEPARATOR()` automáticamente. | Test usa `expect(JSON.stringify(chainsAbi.FIAT_TOKEN_ABI)).toBe(JSON.stringify(methodAbi.FIAT_TOKEN_ABI))`. **Cualquier entry agregada al ABI** es cubierta automáticamente. No requiere extender el test (DT-K). |
| `src/chains/init-breakers.ts` (31 líneas) | DT-I exemplar: cómo construir un boot-init module respetando OWNERS. | Imports permitidos: `pino` (type-only), `./registry.js` (sibling). NO importa de `core/`, `methods/`, `routes/`, `infra/`. Llamado desde `src/app.ts` post-adapter-registration. |
| `src/chains/registry.ts` (130 líneas) | FIX-2: iterar adapters para chequear DOMAIN_SEPARATOR. | API: `chainRegistry.listAdapters(): readonly ChainMetadata[]` (línea 90); `chainRegistry.getAdapter(chainId): Result<{ adapter }>` (línea 66). Patrón usado en `init-breakers.ts:21-29`. |
| `src/chains/types.ts` (185 líneas) | FIX-2: contrato `ChainMetadata` (chainId + tokens + rpcUrl) + `ChainAdapter` (getPublicClient). | `ChainMetadata.tokens: readonly EIP3009Token[]` con `eip712Name`, `eip712Version`, `address` — exactamente los inputs para computar domain separator local. `adapter.getPublicClient(): PublicClient` permite RPC reads. |
| `src/methods/eip3009/domain.ts` (28 líneas) | FIX-2: cómo se construye el EIP-712 domain en runtime hoy. | `buildEip3009Domain(token, chainId, accepted)` puro: name/version/chainId/verifyingContract. **Decisión:** `init-domain-check.ts` NO importa este helper (boundary `chains ↛ methods`). Construye el domain inline con shape idéntico (4 fields) — patrón ya replicado en `src/chains/kite.ts:325-330` y `src/chains/avalanche.ts:315-322`. |
| `src/core/settle-cap.ts` (103 líneas) | FIX-6: catch del `client.incr` (línea 91-94). | `incrementAndCheckDailyCap` retorna `DailyCapResult` discriminated union. El catch actual fail-opens con `logger.warn` + return `{ ok: true, count: 0, cap }`. **FIX-6** introduce ramificación: si `failMode === 'closed'`, retornar nueva variante `{ ok: false; reason: 'redis_error_failclosed'; ... }` que el route mapea a HTTP 503. |
| `src/__tests__/unit/core.settle-cap.test.ts` (111 líneas) | Patrón test mocking de Redis. | `vi.mock('../../infra/redis.js', () => ({ getRedisClient: () => mockClient }))` (línea 15). `mockClient.incr.mockRejectedValue(new Error('redis down'))` (línea 103). 2 tests nuevos siguen este pattern. |
| `src/routes/settle.ts` (líneas 35-65, 130-155) | FIX-6: dónde cablear el nuevo error code 503. | `SettleRouteErrorCode` union local (líneas 40-53) incluye literals fuera de `X402ErrorCode` (`'INVALID_PAYLOAD'`, `'RATE_LIMITED'`). **Decisión DT-L:** agregar `'SERVICE_UNAVAILABLE'` al union local. La llamada a `incrementAndCheckDailyCap` (línea 131) se ramifica por la nueva variante. |
| `doc/architecture/SECURITY.md` (122 líneas, 10+ secciones) | FIX-3: estructura existente. | Secciones existentes: Attack surface (1-10), Defense in depth, Incident response, Secret handling, Audit readiness, Future (V2+). **APPEND ONLY** (CD-12): nuevas secciones "Failure modes" y "Reporting" al final, ANTES de "Future (V2+)" o DESPUÉS — decisión: AL FINAL, después de "Future (V2+)". El "Operator Wallet" V1/V2 update va dentro de la sección §1 existente (extender, no duplicar). |
| `OWNERS.md` (140 líneas) | FIX-2: validar que `src/chains/init-domain-check.ts` puede importar lo que necesita. | Sección "Matriz de importación" autoriza `src/chains/<chain>.ts` a importar `./types.ts`, `./abi/*.ts`, viem. Sección [1] permite `methods → core/errors.ts` excepción (no aplica acá). **`init-domain-check.ts`** sigue el patrón de `init-breakers.ts` (boot init module, MAY import registry + types + abi). |
| `src/core/types.ts` (74 líneas) | Confirmar X402ErrorCode union — `SERVICE_UNAVAILABLE` NO existe. | 11 codes: 10 x402 spec + `CHAIN_UNAVAILABLE` (WFAC-41). Patrón establecido: route-local unions extienden con literals NO-spec (`'RATE_LIMITED'`, `'INVALID_PAYLOAD'`) sin tocar `X402ErrorCode`. DT-L sigue ese patrón con `'SERVICE_UNAVAILABLE'`. |

### 3.2 Auto-Blindaje histórico (últimas 3 HUs DONE)

- **WFAC-52** (`auto-blindaje.md`): retroactive process violations + ESLint patterns (no relevante al fix).
- **WFAC-50** (Kite Testnet, `auto-blindaje.md`):
  - **AB-WFAC-50-1**: cuando agregás superRefine prod-required a `EnvSchema`, **TODOS** los tests existentes con `NODE_ENV: 'production'` se rompen — hay que actualizar fixtures. **FIX-1 + FIX-6**: las 2 nuevas vars **NO** son required-en-prod (FIX-1 es opcional; FIX-6 tiene default `'open'`). Riesgo R-3 documentado.
  - **AB-WFAC-50-2**: nunca poner `eslint-disable-next-line security/detect-object-injection` arriba de declaración de función — solo en la línea del acceso dinámico. **FIX-4** elimina los 5 disables — la refactorización a `switch` literal hace innecesario CUALQUIER disable (estructural, no comment).
  - **AB-WFAC-50-3**: nueva env var required-at-module-load auditar impacto en tests que importan ese módulo. **FIX-2** introduce `init-domain-check.ts` que NO es required-at-module-load: la función exportada `initDomainCheck` solo se ejecuta en `buildApp()`. Sin impacto sobre tests existentes que no llamen `buildApp`.
- **WFAC-41** (Circuit Breaker, `auto-blindaje.md`):
  - **AB-WFAC-41-1**: extender `X402ErrorCode` rompe `VerifyRouteErrorCode`/`SettleRouteErrorCode` locales. **FIX-6 DT-L:** evita tocar `X402ErrorCode` — agrega `'SERVICE_UNAVAILABLE'` SOLO al union local `SettleRouteErrorCode`. Cero impacto sobre `verify.ts` (que no llama settle-cap).
  - **AB-WFAC-41-2**: `eslint-disable-next-line security/detect-object-injection` solo en la línea del acceso. **FIX-4** trivializa esta lección — elimina los 5 disables completamente.
  - **AB-WFAC-41-3**: `FastifyBaseLogger` no es estructuralmente compatible con `pino.Logger` → requiere cast `as unknown as Logger`. **FIX-2** `initDomainCheck` recibe `app.log` desde `src/app.ts:188` — debe seguir el mismo cast pattern usado en `initChainBreakers(app.log as unknown as Logger)`.
  - **AB-WFAC-41-4**: dead-field anti-pattern (declarar opcional luego no usar) → grep post-pivot. **N/A** acá; sin pivots en este SDD.

**Patrón recurrente detectado (≥2 HUs)**: ESLint `Unused eslint-disable directive` cuando el disable se aplica al lugar equivocado (línea declaración vs línea acceso). FIX-4 evita la trampa removiendo TODOS los disables; lo capturamos en **CD-13** explícito.

### 3.3 Exemplars para nuevos archivos

| Para crear | Seguir patrón de | Razón |
|------------|-------------------|-------|
| `src/chains/init-domain-check.ts` (NEW) | `src/chains/init-breakers.ts` (31 líneas) | Boot init module, OWNERS-compliant (`pino` type-only, `./registry.js` sibling, `./abi/fiat-token.js` sibling), llamado desde `src/app.ts` post-adapter-registration. |
| `src/__tests__/unit/app.cors.test.ts` (NEW) | `src/__tests__/unit/rate-limiting.test.ts` (~400 líneas) | Test de integración Fastify usando `buildApp({ rawEnv })` con `app.inject` para enviar headers Origin. |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` (NEW) | `src/__tests__/unit/chains/init-breakers.test.ts` (155 líneas) | Mock de adapter via `chainRegistry._resetForTesting()` + `register(fakeAdapter)`. `vi.mock` de `viem` para stub de `readContract` (`DOMAIN_SEPARATOR()` call). |
| `src/__tests__/unit/chains.avalanche.domain-check.test.ts` (NEW) | idem `chains.kite.domain-check.test.ts` | Estructura idéntica con `chainId=43113` y domain `'USD Coin' / '2'`. |
| Tests nuevos en `src/__tests__/unit/core.settle-cap.test.ts` (extend) | Tests existentes T1-T5 del mismo file | `vi.mock` de Redis ya hecho; agregar 2 describes para `failMode='closed'` y `failMode='open'`. |
| Tests nuevos en `src/__tests__/unit/env.test.ts` (extend) | T-ENV-RL-* tests del mismo file (líneas 173-246) | Patrón `parseEnv({ NODE_ENV: 'test', SETTLE_CAP_FAIL_MODE: 'closed' })` + `expect(result.SETTLE_CAP_FAIL_MODE).toBe('closed')`. |

### 3.4 Estado de BD

| Tabla | Existe | Cambios |
|-------|--------|---------|
| Cualquiera | — | **Sin cambios de schema.** FIX-3 SECURITY.md menciona `facilitator_audit_log` ya existente pero no la modifica. |

### 3.5 Componentes reutilizables

- `viem.domainSeparator({ domain })`: helper `viem` SOTA exportado en `node_modules/viem/_types/utils/typedData.d.ts:18` — devuelve `Hex` del separador EIP-712 computado offline. Usado en FIX-2 para computar el valor local sin reimplementar keccak256(abi.encode(...)).
- `viem.readContract`: para llamar `DOMAIN_SEPARATOR()` view en cada chain.
- `chainRegistry.listAdapters()`: ya devuelve `readonly ChainMetadata[]` (registry.ts:90).
- `adapter.getPublicClient()`: ya retorna `PublicClient` configurado con RPC URL de cada chain.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Wave | Descripción | Exemplar |
|---|---------|--------|------|-------------|----------|
| 1 | `src/infra/env.ts` | Modificar | W0 | Agregar `CORS_ALLOWED_ORIGINS: z.string().optional()` (FIX-1) + `SETTLE_CAP_FAIL_MODE: z.enum(['open','closed']).default('open')` (FIX-6) al `EnvSchema`. NO superRefine. | líneas 42-49 (RATE_LIMIT_*); línea 21 (REDIS_URL optional). |
| 2 | `src/__tests__/unit/env.test.ts` | Modificar | W0 | Agregar 4 tests: T-ENV-CORS-1 (default undefined), T-ENV-CORS-2 (CSV string parsed), T-ENV-FAIL-1 (default 'open'), T-ENV-FAIL-2 ('closed' parsed), T-ENV-FAIL-3 (invalid value → exit 1). | T-ENV-RL-* (líneas 173-246). |
| 3 | `src/chains/kite.ts` | Modificar | W0 | Refactor `readEnv`, `readUsdcAddress`, `readEnabledFlag` a `switch` literal sobre union de env-var-names. Eliminar 3 `eslint-disable security/detect-object-injection`. **NO cambia call-sites.** | líneas 68-75, 586-593, 602-606. |
| 4 | `src/chains/avalanche.ts` | Modificar | W0 | Refactor `readRpcUrl`, `readEnabledFlag` a `switch` literal. Eliminar 2 `eslint-disable`. **NO cambia call-sites.** | líneas 104-111, 119-123. |
| 5 | `src/app.ts` | Modificar | W0 | FIX-1: registrar `@fastify/cors` con callback condicional. Parse `env.CORS_ALLOWED_ORIGINS` (CSV → string[]) inline. Si lista vacía → `origin: true`. Si lista no vacía → callback `(origin, cb)` que devuelve match exacto o `false`. | líneas 105-110 + pattern conditional registration líneas 116-178 (rate-limit). |
| 6 | `src/__tests__/unit/app.cors.test.ts` | Crear | W0 | 3 tests AC-1/AC-2/AC-3: (a) whitelisted origin allowed, (b) non-whitelisted blocked, (c) empty → permissive. | rate-limiting.test.ts (boot via buildApp + app.inject). |
| 7 | `src/chains/abi/fiat-token.ts` | Modificar | W1 | Agregar entry `DOMAIN_SEPARATOR()` view en `FIAT_TOKEN_ABI` (`as const` array): `{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }`. | Entry existente `transferWithAuthorization` (líneas 54-71). |
| 8 | `src/methods/eip3009/abi.ts` | Modificar | W1 | Replicar **byte-for-byte** la misma entry agregada en (7). CD-3 enforcement via `T-SDD-1-ABI-SYNC`. | idem (líneas 41-58). |
| 9 | `src/chains/init-domain-check.ts` | Crear | W1 | NEW module. Export `async function initDomainCheck(logger: Logger): Promise<void>`. Itera `chainRegistry.listAdapters()`. Por cada chain con ≥1 token: (a) compute local separator via `viem.domainSeparator({ domain: { name, version, chainId, verifyingContract } })`; (b) `Promise.allSettled` reads `adapter.getPublicClient().readContract({ address: token.address, abi: FIAT_TOKEN_ABI, functionName: 'DOMAIN_SEPARATOR' })`; (c) compare: mismatch → `logger.fatal({chainId, expected, actual}, '...')` + `process.exit(1)`; rejected promise (RPC timeout/unreachable) → `logger.warn(...)` + continue (non-blocking, AC-5). | `src/chains/init-breakers.ts` (boundary + iteration pattern). |
| 10 | `src/app.ts` | Modificar | W1 | Llamar `await initDomainCheck(app.log as unknown as Logger)` después de `initChainBreakers(...)` (línea 187) y **antes** de `await app.register(healthRoute)` (línea 189). Wrap behind `if (!options.skipDomainCheck)` (new BuildAppOptions field, default `false` excepto tests que opten). | línea 187 (initChainBreakers); BuildAppOptions interface líneas 41-56. |
| 11 | `src/__tests__/unit/chains.kite.domain-check.test.ts` | Crear | W1 | 3 tests AC-7: match/mismatch/RPC-fail. Mock adapter via registry + stub `getPublicClient().readContract`. Espía `logger.fatal` / `logger.warn` + `vi.spyOn(process, 'exit')`. | init-breakers.test.ts (makeAdapterWithBreaker + chainRegistry._resetForTesting). |
| 12 | `src/__tests__/unit/chains.avalanche.domain-check.test.ts` | Crear | W1 | 3 tests AC-8: idéntico a (11) con chainId=43113 + domain 'USD Coin'/'2'. | idem. |
| 13 | `doc/architecture/SECURITY.md` | Modificar (APPEND ONLY) | W2 | Agregar 2 nuevas secciones AL FINAL: **"Failure modes"** (Redis outage → rate-limit bypass; Redis outage → settle-cap fail-open via SETTLE_CAP_FAIL_MODE; domain separator drift → FIX-2 boot check) y **"Reporting"** (`security@wasiai.io` + 48h SLA). Extender §1 "Operator wallet compromise" con: V1 nota single hot key per chain, V2 separate keys recomendado, env vars que NO deben loguearse (`OPERATOR_PRIVATE_KEY`, `SUPABASE_SERVICE_KEY`). | secciones existentes (estructura ## H2 / - bullets). |
| 14 | `src/core/settle-cap.ts` | Modificar | W3 | FIX-6: `incrementAndCheckDailyCap` recibe nuevo arg `failMode: 'open' \| 'closed'`. Ramificar dentro del `catch (err)` del `client.incr`: si `failMode === 'closed'` → return `{ ok: false; reason: 'redis_error_failclosed'; ... }`; si `'open'` → preserve `{ ok: true, count: 0, cap }` (comportamiento actual). Type `DailyCapResult` extendido con discriminator `reason`. | líneas 91-94 (catch actual). |
| 15 | `src/routes/settle.ts` | Modificar | W3 | (a) Pasar `env.SETTLE_CAP_FAIL_MODE` como segundo arg al call de `incrementAndCheckDailyCap`. (b) Agregar `'SERVICE_UNAVAILABLE'` al union local `SettleRouteErrorCode` (línea 53). (c) Manejar la nueva variante: si `dailyCap.ok === false && dailyCap.reason === 'redis_error_failclosed'` → reply 503 con body `{ error: { code: 'SERVICE_UNAVAILABLE', message: 'Settlement cap check failed — service unavailable', http: 503 } }`. | líneas 131-154 (handling actual de dailyCap). |
| 16 | `src/__tests__/unit/core.settle-cap.test.ts` | Modificar | W3 | Agregar 2 tests AC-17: T-CAP-CLOSED (failMode='closed' + Redis throw → `{ ok: false, reason: 'redis_error_failclosed' }`), T-CAP-OPEN-EXPLICIT (failMode='open' explícito → `{ ok: true }`, preserva comportamiento). Los 5 tests existentes para `failMode='open'` (default actual) se mantienen vía passing implícito o explícito de `'open'`. | tests existentes líneas 49-110. |

### 4.2 Modelo de datos

N/A — sin cambios de schema. FIX-3 hace referencia narrativa a tablas existentes (`facilitator_audit_log`).

### 4.3 Componentes / Servicios

#### 4.3.1 `initDomainCheck` (NEW, `src/chains/init-domain-check.ts`)

```
// CONTRATO (no es código — pseudo-firma):
async function initDomainCheck(logger: pino.Logger): Promise<void>

// Comportamiento:
1. Lista los adapters via chainRegistry.listAdapters() (orden no garantizado).
2. Para cada chain con ≥1 token: lanza una promesa de check.
3. await Promise.allSettled(checks).
4. Por cada settled result:
   - { status: 'fulfilled', value: 'match' } → debug log "domain separator OK".
   - { status: 'fulfilled', value: 'mismatch' } → logger.fatal + process.exit(1).
   - { status: 'rejected', reason } → logger.warn (RPC unreachable, no fatal).

// Cada check:
async function checkOneChain(adapter, logger): Promise<'match' | 'mismatch'>
  - token = adapter.metadata.tokens[0]  // primer token (4 chains tienen 1 sólo)
  - localSep = viem.domainSeparator({ domain: { name, version, chainId, verifyingContract: token.address } })
  - onChainSep = await adapter.getPublicClient().readContract({
      address: token.address,
      abi: FIAT_TOKEN_ABI,
      functionName: 'DOMAIN_SEPARATOR',
    })
  - return localSep.toLowerCase() === onChainSep.toLowerCase() ? 'match' : 'mismatch'
  - Si readContract throws → la promesa de checkOneChain rechaza con ese error;
    el outer allSettled lo captura como 'rejected' → warn (AC-5).

// Edge cases:
- 0 adapters registrados (test fixtures) → no-op silencioso, return Promise.resolve().
- Adapter sin tokens (futuro) → skip ese adapter, no warn (no es un error).
- Mismatch + RPC reachable → fatal exit (AC-4 — semántica de "drift detected").
- Multiple chains mismatch a la vez → todas las fatales se loguean antes del exit(1)
  porque Promise.allSettled colecta todos los resultados antes de inspeccionar.

// OWNERS boundaries:
- imports: { Logger } from 'pino' (type-only), chainRegistry from './registry.js'
           (sibling), FIAT_TOKEN_ABI from './abi/fiat-token.js' (sibling),
           { domainSeparator } from 'viem' (runtime SOTA).
- NO imports de src/core/*, src/methods/*, src/routes/*, src/infra/*.

// Para que NODE_ENV=test no fuerce a las suites a inyectar adapters:
- buildApp acepta nuevo BuildAppOptions.skipDomainCheck?: boolean (default false).
- Tests existentes que no necesitan FIX-2 pasarán `skipDomainCheck: true`.
- Tests NUEVOS de FIX-2 NO pasan el flag (lo dejan correr) y montan adapters fake
  con stubs de getPublicClient.
- Tests existentes que llaman buildApp({ env }) hoy: revisar uno por uno y
  agregar `skipDomainCheck: true` donde no se quiera disparar la check. Lista en R-4.
```

#### 4.3.2 FIX-4 — switch literal pattern

```ts
// ANTES (kite.ts línea 68-75):
function readEnv(name: string, chainId: number): string {
  // eslint-disable-next-line security/detect-object-injection -- ...
  const value = process.env[name];
  if (!value || value.trim() === '') throw new ChainAdapterInitError(name, chainId);
  return value;
}
// callers: readEnv('KITE_TESTNET_RPC_URL', 2368), readEnv('KITE_MAINNET_RPC_URL', 2366)

// DESPUÉS:
type KiteRpcEnvName = 'KITE_TESTNET_RPC_URL' | 'KITE_MAINNET_RPC_URL';
function readEnv(name: KiteRpcEnvName, chainId: number): string {
  let value: string | undefined;
  switch (name) {
    case 'KITE_TESTNET_RPC_URL': value = process.env.KITE_TESTNET_RPC_URL; break;
    case 'KITE_MAINNET_RPC_URL': value = process.env.KITE_MAINNET_RPC_URL; break;
  }
  if (!value || value.trim() === '') throw new ChainAdapterInitError(name, chainId);
  return value;
}
// El switch es exhaustivo sobre el union → TS rejects nuevos miembros sin case.
// `process.env.KITE_TESTNET_RPC_URL` es indexing por literal estático → no dispara
// security/detect-object-injection. Cero eslint-disable.
```

Patrón aplicado idénticamente a `readUsdcAddress` (kite.ts 586) con `'KITE_USDC_ADDRESS' | 'KITE_MAINNET_USDC_ADDRESS'`, `readEnabledFlag` (kite.ts 602 y avalanche.ts 119) con `'KITE_MAINNET_ENABLED' | 'AVALANCHE_MAINNET_ENABLED'`, y `readRpcUrl` (avalanche.ts 104) con `'AVALANCHE_FUJI_RPC_URL' | 'AVALANCHE_MAINNET_RPC_URL'`.

#### 4.3.3 FIX-6 — fail-mode wiring

```
// ANTES (settle-cap.ts línea 91-94):
} catch (err) {
  logger.warn({ err, cap }, 'settle daily cap check failed — fail-open');
  return { ok: true, count: 0, cap };
}

// DESPUÉS (firma extendida + ramificación):
type DailyCapResult =
  | { ok: true; count: number; cap: number }
  | { ok: false; reason: 'cap_exceeded'; count: number; cap: number; retryAfterSeconds: number }
  | { ok: false; reason: 'redis_error_failclosed' };   // NUEVA variante

async function incrementAndCheckDailyCap(
  cap: number,
  failMode: 'open' | 'closed',                          // NUEVO arg
  logger: Pick<Logger, 'warn' | 'debug'>,
): Promise<DailyCapResult> {
  // ... resto idéntico hasta el catch ...
  } catch (err) {
    if (failMode === 'closed') {
      logger.warn({ err, cap }, 'settle daily cap check failed — fail-closed');
      return { ok: false, reason: 'redis_error_failclosed' };
    }
    logger.warn({ err, cap }, 'settle daily cap check failed — fail-open');
    return { ok: true, count: 0, cap };
  }
}
```

Route layer (`src/routes/settle.ts`):
```
// Línea 131 ANTES:
const dailyCap = await incrementAndCheckDailyCap(env.SETTLE_DAILY_GLOBAL_CAP, app.log);

// DESPUÉS:
const dailyCap = await incrementAndCheckDailyCap(
  env.SETTLE_DAILY_GLOBAL_CAP,
  env.SETTLE_CAP_FAIL_MODE,    // 'open' (default) | 'closed'
  app.log,
);

// Línea 132 ANTES: if (!dailyCap.ok) { /* RATE_LIMITED branch */ }
// DESPUÉS:
if (!dailyCap.ok) {
  if (dailyCap.reason === 'redis_error_failclosed') {
    // FIX-6 fail-closed: HTTP 503 SERVICE_UNAVAILABLE
    const body: ErrorBody = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Settlement cap check failed — service unavailable',
        http: 503,
      },
    };
    app.log.warn({ request_id: requestId, error_code: 'SERVICE_UNAVAILABLE', http_status: 503, duration_ms: Date.now() - startMs }, 'settle failed — fail-closed');
    request.auditMeta = { ...request.auditMeta, errorCode: 'SERVICE_UNAVAILABLE' };
    return reply.code(503).send(body);
  }
  // dailyCap.reason === 'cap_exceeded' → branch RATE_LIMITED actual
  // (handling exacto preserved — solo se renombra `dailyCap.retryAfterSeconds`).
}
```

### 4.4 Flujo principal (Happy Path)

**Boot del facilitator post-FIX:**

1. `index.ts` → `parseEnv(process.env)` (FIX-1: parse `CORS_ALLOWED_ORIGINS`; FIX-6: parse `SETTLE_CAP_FAIL_MODE`).
2. `buildApp({ env })` →
   1. `initRedis(env, logger)`, `initSupabase(env, logger)`.
   2. `app.register(helmet, ...)`.
   3. `app.register(cors, { origin: parsedOriginCallback, ... })` (FIX-1).
   4. `app.register(rateLimit, ...)` si enabled.
   5. `initChainBreakers(app.log)` (existente, WFAC-41).
   6. **`await initDomainCheck(app.log)`** (FIX-2, NEW).
      - Por cada chain registrada: compute local separator + read `DOMAIN_SEPARATOR()` on-chain.
      - Si match en las 4 chains: debug logs, boot continúa.
      - Si mismatch en alguna: fatal log + `process.exit(1)`.
      - Si RPC unreachable en alguna: warn log, boot continúa (non-blocking).
   7. `app.register(healthRoute)` ... etc.
3. `app.listen(...)` (sin cambios).

**Settle request fail-closed scenario:**

1. Client → POST `/settle`.
2. Validación Zod, idempotency lookup OK.
3. `incrementAndCheckDailyCap(cap, env.SETTLE_CAP_FAIL_MODE, logger)`.
4. Si Redis throws + `failMode='closed'` → return `{ ok: false, reason: 'redis_error_failclosed' }`.
5. Route returns HTTP 503 con body `{ error: { code: 'SERVICE_UNAVAILABLE', ... } }`.

### 4.5 Flujo de error

**FIX-2 mismatch a boot:**
- `DOMAIN_SEPARATOR()` on-chain returns `0xabcd...` pero local computa `0x1234...`.
- `logger.fatal({ chainId, expected: localSep, actual: onChainSep }, 'domain separator drift detected — refusing to boot')`.
- `process.exit(1)`.
- Operator debe inspeccionar el log, corregir el token metadata (`eip712Name`/`eip712Version`/`address`) y reboot.

**FIX-1 CORS rechazo:**
- Client desde `https://attacker.example` envía request con `Origin: https://attacker.example`.
- Si `CORS_ALLOWED_ORIGINS=https://a2a.wasiai.io,https://app.wasiai.io` configurado → callback devuelve `false`.
- `@fastify/cors` responde HTTP 403 sin headers `Access-Control-Allow-Origin`.

**FIX-6 fail-closed:**
- Redis down + `SETTLE_CAP_FAIL_MODE=closed`.
- Cada settle request retorna HTTP 503 con `code: 'SERVICE_UNAVAILABLE'`.
- Service degrada protectivamente (no fail-open).

---

## 5. Constraint Directives (Anti-Alucinación)

### CDs heredados del work-item

- **CD-1**: TypeScript strict — no `any`, no `as unknown` EXCEPTO el cast documentado `app.log as unknown as Logger` (heredado de WFAC-41 AB-WFAC-41-3) en `initDomainCheck` invocation.
- **CD-2**: Baseline MUST NOT regress — `npm test` ≥553 PASS, 0 FAIL **después de cada commit individual**.
- **CD-3**: ABI sync byte-for-byte (FIAT_TOKEN_ABI) entre `src/chains/abi/fiat-token.ts` y `src/methods/eip3009/abi.ts`. `T-SDD-1-ABI-SYNC` enforza.
- **CD-4**: OWNERS.md boundaries inviolables — `init-domain-check.ts` MAY importar `./registry.js`, `./abi/fiat-token.js`, viem, pino (type-only). MUST NOT importar `src/methods/*`, `src/core/*`, `src/routes/*`, `src/infra/*`.
- **CD-5**: Pipeline anchors untouched — sin modificar comentarios `CD-N`, `WFAC-N`, `DT-N`, `T-SDD-1-ABI-SYNC` en archivos existentes (excepto extensión de los del SDD actual con nuevos códigos).
- **CD-6**: FIX-2 boot check non-blocking en RPC failure (warn + continue) — solo `fatal+exit(1)` si RPC respondió y los separadores difieren.
- **CD-7**: Cada AC SHALL tener ≥1 test que lo cubre. Test names reference AC number (e.g., `'AC-4: domain separator match → boot continues'`).
- **CD-8**: FIX-6 default `'open'` preserva el comportamiento existente exactly. `SETTLE_CAP_FAIL_MODE` ausente ≡ `SETTLE_CAP_FAIL_MODE=open`.
- **CD-9**: Per-chain domain check sobre todas las chains REGISTRADAS en runtime — driven by `chainRegistry.listAdapters()`, no hardcodea chain IDs.
- **CD-10**: `eslint-plugin-security/detect-object-injection` MUST NOT be suppressed via inline comments en las 5 ubicaciones FIX-4 (refactor estructural, no comment suppress).
- **CD-11**: `CORS_ALLOWED_ORIGINS` es `z.string().optional()` (raw CSV) parseado manualmente en `app.ts` por `String.prototype.split(',').map(trim).filter(nonEmpty)`. NO Zod CSV transform.
- **CD-12**: FIX-3 SECURITY.md es APPEND ONLY. Dev MUST leer las 122 líneas antes de editar. Crear/truncar el archivo = BLOQUEANTE.

### CDs nuevos identificados por Architect en F2

- **CD-13** (NEW, lección AB-WFAC-50-2 + AB-WFAC-41-2): NO agregar `eslint-disable security/detect-object-injection` en NINGÚN archivo modificado por esta HU. Si tras el refactor FIX-4 alguna línea aún dispara la regla, **el refactor está incompleto** — el approach correcto es seguir convirtiendo a switch/literal access (NUNCA agregar un disable nuevo). El test `npm run lint -- --max-warnings 0` debe pasar.
- **CD-14** (NEW): `initDomainCheck` MUST usar `Promise.allSettled` (no `Promise.all`) para que UNA chain con RPC down no bloquee el check de las otras 3. `Promise.all` rejecta al primer error, lo que violaría AC-5.
- **CD-15** (NEW): `SERVICE_UNAVAILABLE` se agrega SOLO al union local `SettleRouteErrorCode` en `src/routes/settle.ts`. NUNCA se agrega a `X402ErrorCode` en `src/core/types.ts` (no es spec x402). Patrón consistente con `'RATE_LIMITED'` (WFAC-40) y `'INVALID_PAYLOAD'`.
- **CD-16** (NEW): `BuildAppOptions.skipDomainCheck?: boolean` default `false`. Tests existentes que importen `buildApp` y NO configuren chain adapters deben pasar `skipDomainCheck: true` para evitar warns/fatals espurios. Lista de tests afectados en R-4.

### Prohibido

- NO agregar dependencias nuevas (todo viem/zod/pino/fastify-cors ya está instalado).
- NO modificar `openapi.yaml` — no se agregan endpoints públicos; el 503 SERVICE_UNAVAILABLE en /settle es comportamiento condicional documentado en SECURITY.md, no nuevo response schema obligatorio (TD potencial — fuera de scope).
- NO modificar `src/middleware/**`, `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/chains/registry.ts`.
- NO crear `src/chains/util/*` u otro helper compartido entre kite.ts y avalanche.ts para FIX-4 — el switch literal queda inline en cada file (5 ubicaciones → 5 mini-refactors). Compartir un helper acoplaría kite ↔ avalanche y rompería la regla "agregar nueva chain = 1 archivo" (OWNERS.md §1).
- NO usar `process.env[VARIABLE]` con variable dinámica en código nuevo o modificado.
- NO mergear Dependabot PRs #3–#7 en esta HU (HOLD explícito).
- NO escribir `console.log/info/warn/error` en código de producción (`no-console` rule existente).
- NO commitear FIX-2 sin haber actualizado AMBOS archivos ABI en el MISMO commit (CD-3).

---

## 6. Plan de tests + Mapping AC → Test

### 6.1 Tests por wave

| Wave | Test file | Test name | Cubre AC |
|------|-----------|-----------|----------|
| W0 | `env.test.ts` | T-ENV-CORS-1: `CORS_ALLOWED_ORIGINS` defaults undefined when missing | AC-2 (implicit env contract) |
| W0 | `env.test.ts` | T-ENV-CORS-2: parses CSV string as-is (no Zod transform) | AC-1, AC-2 (env contract) |
| W0 | `env.test.ts` | T-ENV-FAIL-1: `SETTLE_CAP_FAIL_MODE` defaults 'open' | AC-16, CD-8 |
| W0 | `env.test.ts` | T-ENV-FAIL-2: accepts 'closed' literal | AC-15 (env contract) |
| W0 | `env.test.ts` | T-ENV-FAIL-3: rejects arbitrary strings → exit 1 | CD-8 defense |
| W0 | `app.cors.test.ts` | T-CORS-1 (AC-1): whitelisted Origin returns ACAO header | AC-1 |
| W0 | `app.cors.test.ts` | T-CORS-2 (AC-2): non-whitelisted Origin gets 403 / no ACAO | AC-1 |
| W0 | `app.cors.test.ts` | T-CORS-3 (AC-3): empty env → origin:true (reflect) | AC-2, AC-3 |
| W0 | `chain-adapter.test.ts` (existing) | (no new test needed — lint regression caught by CD-2 npm test + CD-19 npm run lint) | AC-12, AC-13 |
| W1 | `chain-adapter.test.ts` (existing) | T-SDD-1-ABI-SYNC family (líneas 1051-1099) | AC-6 (automatic — DOMAIN_SEPARATOR entry is part of FIAT_TOKEN_ABI) |
| W1 | `chains.kite.domain-check.test.ts` (NEW) | T-DOM-KITE-1 (AC-7a): match → boot continues, debug log | AC-4, AC-7 |
| W1 | `chains.kite.domain-check.test.ts` (NEW) | T-DOM-KITE-2 (AC-7b): mismatch → fatal log + process.exit(1) | AC-4, AC-7 |
| W1 | `chains.kite.domain-check.test.ts` (NEW) | T-DOM-KITE-3 (AC-7c): RPC throws → warn log, no exit | AC-5, AC-7 |
| W1 | `chains.avalanche.domain-check.test.ts` (NEW) | T-DOM-AVAX-1 (AC-8a): match → boot continues | AC-4, AC-8 |
| W1 | `chains.avalanche.domain-check.test.ts` (NEW) | T-DOM-AVAX-2 (AC-8b): mismatch → fatal exit | AC-4, AC-8 |
| W1 | `chains.avalanche.domain-check.test.ts` (NEW) | T-DOM-AVAX-3 (AC-8c): RPC throws → warn, no exit | AC-5, AC-8 |
| W1 | (cross-chain integration) | T-DOM-MULTI: 2 chains, 1 RPC-down + 1 match → warn + continue (Promise.allSettled) | CD-14 |
| W2 | (Doc-only — no tests) | grep verification: SECURITY.md contiene "Failure Modes", "Reporting", "security@wasiai.io", "48 hours", "OPERATOR_PRIVATE_KEY", "SUPABASE_SERVICE_KEY" | AC-9, AC-10, AC-11 |
| W3 | `core.settle-cap.test.ts` (extend) | T-CAP-CLOSED (AC-17a): failMode='closed' + Redis throw → `{ ok: false, reason: 'redis_error_failclosed' }` + warn log | AC-15, AC-17 |
| W3 | `core.settle-cap.test.ts` (extend) | T-CAP-OPEN-EXPLICIT (AC-17b): failMode='open' + Redis throw → `{ ok: true, count: 0, cap }` (preserve existing) | AC-16, AC-17 |
| W3 | `core.settle-cap.test.ts` (extend) | T-CAP-DEFAULT-OPEN: failMode arg missing — N/A: arg ahora required en signature, tests existentes pass `'open'` explícito en fixture update | CD-8 |
| W3 | (manual or integration) | E2E flow: `SETTLE_CAP_FAIL_MODE=closed` + Redis mock throw → POST /settle returns 503 + body `{ error: { code: 'SERVICE_UNAVAILABLE', ... } }` | AC-15 |
| Final | All waves complete | `npm test` reports ≥553 PASS + N new tests, 0 FAIL | AC-18 |
| Final | All waves complete | `npm run lint` exits 0, 0 warnings | AC-12, AC-19, CD-10, CD-13 |

### 6.2 Resumen de tests

- **Tests nuevos**: 5 archivos modificados/creados:
  - `env.test.ts`: +5 tests
  - `app.cors.test.ts`: +3 tests (NEW file)
  - `chains.kite.domain-check.test.ts`: +3 tests (NEW file)
  - `chains.avalanche.domain-check.test.ts`: +3 tests (NEW file)
  - `core.settle-cap.test.ts`: +2 tests + minor fixture update existing 5
- **Total new**: ~16 new tests + 1 cross-chain integration test.
- **Estimated total post-HU**: ≥569 PASS (553 + 16).
- **Tests modificados (no nuevos)**: tests existentes que llaman `buildApp` sin querer disparar FIX-2 → agregar `skipDomainCheck: true` en `BuildAppOptions`. Lista preliminar (verificar en W1): `init-breakers.test.ts`, `routes.openapi.test.ts`, `routes.settle.test.ts`, `routes.verify.test.ts`, `routes.supported.test.ts`, `rate-limiting.test.ts`, `audit.test.ts`, `health.test.ts`, `shutdown.test.ts` — todos los que importan `buildApp`.

### 6.3 Verificación incremental por wave

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | `npm run typecheck` + `npm test src/__tests__/unit/env.test.ts src/__tests__/unit/app.cors.test.ts src/__tests__/unit/chain-adapter.test.ts` + `npm run lint` (ahora 0 disables FIX-4). |
| W1 | `npm run typecheck` + `npm test` (full) — confirms `T-SDD-1-ABI-SYNC` still green + 6 new domain-check tests + 1 multi-chain + skipDomainCheck migration of existing buildApp tests. |
| W2 | `git diff doc/architecture/SECURITY.md` — verify APPEND only (no líneas eliminadas), grep verification de las strings clave. |
| W3 | `npm test` full + `npm run lint --max-warnings 0` + manual smoke E2E (POST /settle with mocked Redis throw + `SETTLE_CAP_FAIL_MODE=closed`). |

---

## 7. Multi-chain coverage matrix

Confirma que cada FIX aplica consistentemente sobre las 4 chains:

| FIX | Kite Testnet 2368 | Kite Mainnet 2366 | Avalanche Fuji 43113 | Avalanche Mainnet 43114 |
|-----|-------------------|-------------------|----------------------|-------------------------|
| FIX-1 CORS | N/A (HTTP-level, no chain-specific) | N/A | N/A | N/A |
| FIX-2 DOMAIN_SEPARATOR check | ✅ — token PYUSD eip712Name='PYUSD' v='1' verifyingContract=KITE_USDC_ADDRESS | ✅ — token USDC.e eip712Name='USD Coin' v='2' verifyingContract=KITE_MAINNET_USDC_ADDRESS | ✅ — token USDC eip712Name='USD Coin' v='2' verifyingContract=0x5425...c65 | ✅ — token USDC eip712Name='USD Coin' v='2' verifyingContract=0xB97E...8a6E |
| FIX-3 SECURITY.md | N/A | N/A | N/A | N/A |
| FIX-4 eslint-disable | ✅ — 3 funciones en kite.ts (readEnv, readUsdcAddress, readEnabledFlag) | mismas 3 funciones (compartidas) | ✅ — 2 funciones en avalanche.ts (readRpcUrl, readEnabledFlag) | mismas 2 funciones |
| FIX-5 Dependabot | N/A | N/A | N/A | N/A |
| FIX-6 fail-mode | N/A (chain-agnostic — applies pre-adapter dispatch) | N/A | N/A | N/A |

**Conclusión**: FIX-2 es el único per-chain. Los tests para FIX-2 cubren Kite + Avalanche (kite y avalanche use same adapter class para testnet+mainnet pair). Verificar en W1: tests T-DOM-KITE-* implícitamente cubren mainnet vía la misma KiteAdapter class; T-DOM-AVAX-* idéntico.

---

## 8. Waves de implementación

### W0 — Low-risk baseline cleanup (FIX-4 + FIX-1)
- **Objetivo**: dejar baseline limpio (cero lint warnings + CORS env contract) antes de tocar boot logic.
- **Commits planificados (2)**:
  - C1: FIX-4 — refactor 5 helpers de kite.ts/avalanche.ts a switch literal. **No tests nuevos** (CD-2 + lint baseline cubren).
  - C2: FIX-1 — env var + cors wiring + 3 tests app.cors + 2 tests env.
- **Riesgo**: BAJO. Cambios estructurales sin logic change (FIX-4) y backward-compatible env contract (FIX-1).
- **Verificación**: `npm test` ≥553+5 PASS, `npm run lint` 0 warnings (lint regression mostrará si quedó algún disable).

### W1 — Domain separator boot check (FIX-2)
- **Objetivo**: agregar DOMAIN_SEPARATOR ABI + boot check.
- **Commits planificados (1)**:
  - C3: FIX-2 — ABI dual update (chains+methods en el mismo commit, CD-3) + init-domain-check.ts NEW + integration en buildApp + skipDomainCheck flag + 6 domain-check tests + 1 cross-chain test + migration de buildApp tests existentes.
- **Riesgo**: ALTO. Touches boot logic. Mitigado por: (a) CD-14 `Promise.allSettled` non-blocking, (b) CD-6 fatal solo en mismatch real, (c) skipDomainCheck flag for tests, (d) AB-WFAC-41-3 cast pino documentado.
- **Verificación**: `npm test` ≥553+12 PASS (5 W0 + 7 W1), `npm run typecheck` clean.

### W2 — Docs append (FIX-3)
- **Objetivo**: extender SECURITY.md.
- **Commits planificados (1)**:
  - C4: FIX-3 — APPEND a SECURITY.md (Failure modes, Reporting, Operator wallet update).
- **Riesgo**: BAJO. Doc-only, sin código.
- **Verificación**: `git diff` confirms APPEND ONLY + grep verification.

### W3 — Fail-mode opt-in (FIX-6)
- **Objetivo**: agregar SETTLE_CAP_FAIL_MODE.
- **Commits planificados (1)**:
  - C5: FIX-6 — env var + settle-cap.ts signature extension + route handler + 2 tests + fixture updates en tests existentes.
- **Riesgo**: MEDIO. Default `'open'` preserva behavior (CD-8), pero touches money-moving path. Mitigado por AC-17 explicit test coverage de ambos modes.
- **Verificación**: `npm test` full ≥553+15 PASS, `npm run lint` 0 warnings.

### DONE — FIX-5 external action
- **Acción**: merge GitHub Dependabot PR #10 (no commit local).
- **Comentar** PRs #3–#7 con "Holding until manual smoke test".

### Dependencias entre waves
- W0 → W1 → W2 → W3 → DONE: **estrictamente serial**. CD-2 (baseline verde tras cada commit) hace que no se puedan mergear en paralelo.
- W1 y W3 son independientes en lógica pero ambos asumen W0 (lint baseline limpio).

---

## 9. Riesgos

| # | Riesgo | Prob | Impacto | Mitigación |
|---|--------|------|---------|------------|
| R-1 | FIX-2 mismatch falso positivo por desalineación de metadata (e.g. eip712Version='2' vs '1') → fatal exit en boot prod | M | A | Smoke E2E en dev/staging contra cada RPC antes de merge. Si mismatch real, corregir token metadata en `src/chains/kite.ts:124-128` o avalanche y re-test ANTES de prod deploy. |
| R-2 | `Promise.allSettled` swallows rare errors fuera del RPC failure (e.g. assertion en domainSeparator computation) | B | M | Wrap el bloque local-computation también en try/catch dentro de cada checkOneChain → trate todos los errores no-mismatch como warn (consistente con AC-5). Test T-DOM-KITE-3 cubre RPC throws; test similar para local computation throw es adicional pero opcional (defensive). |
| R-3 | Nuevas env vars (FIX-1, FIX-6) violan AB-WFAC-50-1 si requieren superRefine prod-required | M | M | **AMBAS son optional** sin superRefine (FIX-1: `z.string().optional()`, FIX-6: `z.enum().default('open')`). NO se agregan checks superRefine. Verificación: post-W0, correr `npm test src/__tests__/unit/env.test.ts -- --grep "T-ENV-WFAC50"` debe pasar igual que antes. |
| R-4 | Tests existentes que llaman `buildApp({ env })` sin adapters registrados → `initDomainCheck` itera 0 → no-op, OK. PERO si algún test registra fake adapter sin `getPublicClient.readContract` mock → fatal exit | A | A | **Mitigación dual:** (a) `BuildAppOptions.skipDomainCheck` default false → todos los buildApp callers default-on, los tests que tienen adapters fake sin readContract DEBEN pasar `skipDomainCheck: true`. (b) Grep `await buildApp` en `src/__tests__/` y revisar uno por uno en W1 (~9 archivos). |
| R-5 | FIX-4 switch refactor rompe edge case (e.g., trimmed empty string) | B | M | Cada switch case retorna `process.env.LITERAL` que es `string \| undefined`; check `!value \|\| value.trim() === ''` preservado. Tests existentes para `ChainAdapterInitError` (en chain-adapter.test.ts) detectan regresiones. |
| R-6 | `SERVICE_UNAVAILABLE` route-local conflict con audit code typing | B | B | `request.auditMeta.errorCode: X402ErrorCode \| 'INVALID_PAYLOAD' \| 'RATE_LIMITED'` (src/core/audit.ts:52). Agregar `\| 'SERVICE_UNAVAILABLE'` al type union (1 line change). CD-15 enforça que NO se agrega a X402ErrorCode. **Esto SUMA 1 archivo modificado** (`src/core/audit.ts`) NO listado en work-item Scope IN — verificar que el work-item Scope IN permite ampliarlo. Si no, fallback: NO setear errorCode en auditMeta para este branch (no es bloqueante para AC). **Decisión Architect**: agregar `'SERVICE_UNAVAILABLE'` al union de audit.ts:52 — es 1 línea, mismo pattern que `'RATE_LIMITED'`, no rompe nada. Audit Scope IN extension justificada. |
| R-7 | FIX-2 introduce latencia de boot (4 RPC reads en serie) | B | B | `Promise.allSettled` paraleliza las 4 reads. Latency es bounded por la chain más lenta (~1-2s testnet). Aceptable para boot (one-time cost). Si crítico, futura optimización: cache local separator + skip on cache hit (out of scope). |
| R-8 | Dev olvida actualizar `src/methods/eip3009/abi.ts` cuando edita `src/chains/abi/fiat-token.ts` (FIX-2 C3) | M | A | CD-3 + `T-SDD-1-ABI-SYNC` (chain-adapter.test.ts:1051-1056). El test corre en CI por default y rompe el commit. Story File debe ser explícito sobre los 2 archivos en el mismo commit. |
| R-9 | FIX-3 APPEND choca con git merge conflicts si otro PR toca SECURITY.md | B | B | Branch base `d6ccd5f` ya tiene SECURITY.md estable. Sin otros PRs abiertos tocando el file (verificado vs work-item OUT). |
| R-10 | DOMAIN_SEPARATOR()  view function en FIAT_TOKEN_ABI conflicto con consumer code que iteraba el array | B | B | Grep `FIAT_TOKEN_ABI.length\|FIAT_TOKEN_ABI[` confirma sin iteración por índice. Solo se usa con viem `simulateContract/writeContract/readContract` que toman el ABI entero y matchean por `functionName`. Agregar 1 entry no rompe matching de `transferWithAuthorization`. |

---

## 10. Dependencias

- **Pre-flight** (DT-A): `git pull origin main` + `git checkout -b fix/wfac-53-post-review-hardening` desde `d6ccd5f`.
- **Tooling**: `viem.domainSeparator` ya disponible (node_modules/viem/_types/utils/typedData.d.ts:18). No requiere actualización de viem.
- **Tests**: ya están instalados vitest, @fastify/cors, ioredis-mock — sin nuevas devDeps.

---

## 11. Missing Inputs

- [ ] **FIX-3 Reporting section**: provisional aceptado del Analyst — `security@wasiai.io` + 48h SLA acknowledgement. **To-verify-pre-merge** con el operador. Si el operador prefiere otro contacto, update en el commit C4 antes del merge. No bloquea el SDD — provisional documented.

---

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TO-VERIFY-PRE-MERGE] | §11 | Email + SLA en FIX-3 Reporting | No (provisional aceptado) |
| [TO-VERIFY-IN-W1] | §6.2, R-4 | Lista exhaustiva de tests que llaman `buildApp` y necesitan `skipDomainCheck: true` | No (se descubre durante W1) |

> Sin `[NEEDS CLARIFICATION]` bloqueantes.

---

## 13. Resolución de DTs

| DT (work-item) | Status | Decisión Architect |
|----------------|--------|--------------------|
| DT-A pre-flight branch | OK | `git checkout -b fix/wfac-53-post-review-hardening` desde `d6ccd5f`. |
| DT-B 6 commits secuenciales | OK | 5 commits locales (C1-C5) + 1 acción externa (FIX-5 GitHub UI). Order: C1 FIX-4 → C2 FIX-1 → C3 FIX-2 → C4 FIX-3 → C5 FIX-6. |
| DT-C FIX-2 per-chain (4 chains) | OK | `chainRegistry.listAdapters()` driven — no chain IDs hardcoded. |
| DT-D FIX-3 APPEND | OK | APPEND al final del file, secciones "Failure modes" y "Reporting"; "Operator wallet" §1 extendida in-place. |
| DT-E FIX-6 default 'open' | OK | Zod `.default('open')` + handler preserva behavior cuando `failMode === 'open'`. |
| DT-F QUALITY pipeline | OK | NexusAgil QUALITY mode. |
| DT-G ABI sync 2 files | OK | DOMAIN_SEPARATOR entry agregada idénticamente a ambos abi.ts. Test T-SDD-1-ABI-SYNC ya cubre (DT-K). |
| **DT-H FIX-4 strategy** | **RESUELTO** | **Switch statement** sobre union de literales (no Record). Rationale: (a) preserva call-site exacto (`readEnv('KITE_TESTNET_RPC_URL', 2368)`), (b) TS exhaustiveness rejection de nuevos literals, (c) cada case usa `process.env.LITERAL` (no dynamic indexing) → cero eslint-disable, (d) no requires nuevo helper compartido (CD-OWNERS-prevent kite↔avalanche coupling), (e) error throw inline en cada caller chain-specific. |
| **DT-I init-domain-check.ts injection** | **RESUELTO** | Llamado desde `src/app.ts:buildApp()` después de `initChainBreakers(app.log)` (línea 187) y antes de `app.register(healthRoute)` (línea 189). NO en `index.ts`. Razón: tests usan `buildApp` directamente; si la check vive en `index.ts`, los tests no la ejercitan. Trade-off: tests existentes que no quieren la check deben pasar `BuildAppOptions.skipDomainCheck: true` (CD-16). |
| **DT-J inputs format** | **RESUELTO** | Reservado a Analyst. Sin nueva alocación. |
| **DT-K ABI sync test extension** | **RESUELTO** | NO requiere extensión. Test existente `T-SDD-1-ABI-SYNC` (`chain-adapter.test.ts:1051-1056`) usa `JSON.stringify(FIAT_TOKEN_ABI)` byte-comparison — cualquier entry nueva (incluyendo DOMAIN_SEPARATOR) queda cubierta automáticamente. NO se modifica el test. |
| **DT-L SERVICE_UNAVAILABLE code location** | **RESUELTO** | Agregar SOLO al union local `SettleRouteErrorCode` en `src/routes/settle.ts:53`. Patrón consistente con `'RATE_LIMITED'` y `'INVALID_PAYLOAD'` (route-local literals, no x402 spec codes). NO se agrega a `X402ErrorCode` en `src/core/types.ts`. Resuelto CD-15. |
| **DT-M FIX-2 utility scope** | **RESUELTO** | NO crear helper compartido entre kite.ts/avalanche.ts. El compute-local-separator vive como función PRIVADA dentro de `init-domain-check.ts`. Razón: respeta OWNERS (`init-domain-check.ts` es boot-init, no business adapter); no introduce dependency cross-chain. |
| **DT-N buildApp options extension** | **RESUELTO** | Agregar `skipDomainCheck?: boolean` (default `false`) a `BuildAppOptions` (líneas 41-56 en `src/app.ts`). Backward-compatible (default = behavior change opt-out). Tests existentes que llaman `buildApp({ env })` sin adapters registrados quedan OK (no-op iteration); tests con adapters mock sin readContract setean `skipDomainCheck: true`. |
| **DT-O audit.ts errorCode extension** | **RESUELTO** | Agregar `'SERVICE_UNAVAILABLE'` al union `request.auditMeta.errorCode` en `src/core/audit.ts:52`. 1 línea, mismo pattern que `'RATE_LIMITED'` (WFAC-40). **Esto SUMA 1 archivo a Scope IN** (audit.ts) — work-item Scope OUT explícito: `src/core/*` excepto settle-cap. **Architect ruling**: extender Scope IN a `audit.ts` para esta 1 línea es justificable bajo CR (acceptance criteria de FIX-6 requiere setear errorCode auditMeta en el branch fail-closed para mantener observabilidad), y cumple el patrón establecido en WFAC-40 cuando se agregó `'RATE_LIMITED'`. Si Adversary BLOQUEANTE rechaza, fallback: NO setear `auditMeta.errorCode` en el branch fail-closed (degrada observability pero cumple los ACs literales — todos los AC-15..17 hablan del response body, no de auditMeta). |

---

## 14. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1 (mapping en §6.1)
[x] Cada archivo en tabla 4.1 tiene un Exemplar válido (verificado con Glob/Read en §3)
[x] No hay [NEEDS CLARIFICATION] pendientes (provisional FIX-3 aceptado en §11)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (16 CDs totales: 12 heredados + 4 nuevos)
[x] Context Map tiene ≥2 archivos leídos (19 archivos en §3.1)
[x] Scope IN y OUT son explícitos y no ambiguos (§2 + §5)
[x] Si hay BD: tablas verificadas (N/A — sin cambios schema)
[x] Flujo principal (Happy Path) está completo (§4.4)
[x] Flujo de error está definido (≥3 casos: FIX-2 mismatch, FIX-1 reject, FIX-6 fail-closed — §4.5)
[x] Multi-chain matrix presente (§7)
[x] DTs deferidas a F2 resueltas (DT-H, DT-I, DT-K, DT-L, DT-M, DT-N, DT-O — §13)
[x] Auto-blindaje histórico revisado y aplicado a CDs (§3.2)
[x] Test plan AC → test mapping completo (§6.1, ≥1 test por AC)
[x] Waves serializadas con dependencias claras (§8)
[x] Risks inventory ≥8 items (10 items en §9)
```

**Readiness**: ✅ Listo para SPEC_APPROVED.

---

## 15. Observaciones para el orquestador

- **Pre-merge action requerida**: confirmar con el humano que `security@wasiai.io` + 48h SLA son aceptables o reemplazar antes de C4 (FIX-3).
- **Smoke test recomendado post-merge**: spin up el facilitator contra Kite Testnet en staging y verificar logs `domain separator OK` por las 4 chains. Si fatal: investigar metadata mismatch.
- **FIX-5 acción externa**: el orquestador debe documentar el merge de Dependabot PR #10 en el done-report tras DONE de la HU.
- **Tests que requieren update**: durante W1, lista exacta de tests calling `buildApp` (~9 archivos) debe migrarse con `skipDomainCheck: true`. Esto es scope expansion menor justificada por R-4.

---

*SDD generado por NexusAgil F2 — Architect — 2026-05-11*
