# SDD #025: Facilitator multi-red — generalizar dispatch EVM-only → orquestador por namespace de red

> SPEC_APPROVED: no
> Fecha: 2026-07-21
> Tipo: architecture (feature de abstracción pura)
> SDD_MODE: full
> Branch: feat/025-hu-sol-f1-facilitator-multichain
> Artefactos: doc/sdd/025-hu-sol-f1-facilitator-multichain/
> HU: WKH-204 / HU-SOL-2 (alias interno HU-SOL-F1 / WFAC-TBD)
> Repo objetivo: /home/ferdev/.openclaw/workspace/wasiai-facilitator/

---

## 1. Resumen

Generalizamos el core del facilitator (`verify` / `settle` / `registry` / `schemas` / `supported` /
`types`) de "EVM-only, keyed por `chainId` numérico vía `eip155:<chainId>`" a "multi-red, keyed por
**namespace de red** (`eip155:` | `solana:` | futuros)". Es la fundación de abstracción para el
programa Solana LATAM Labs: abre el *slot* para que Solana (y cualquier red no-EVM futura) entre sin
volver a tocar `core/`.

Esta HU **NO** implementa el adapter Solana concreto (eso es HU-SOL-6). Solo prueba que un
`network: "solana:devnet"` / `"solana:mainnet"` rutea a un error x402 estructurado y no-crasheante, con
el path EVM **100% byte-idéntico** (regresión cero, garantizada por la suite completa — AC-1).

Resultado esperado: 833 tests existentes verdes sin cambio de assertion + tests nuevos para el
dispatch por namespace + `SettlementAdapter` (verify-only) tipado + schema Zod discriminado por método +
`ChainRegistry` indexable por `networkId: string`.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 025 |
| **Tipo** | architecture / feature (abstracción pura) |
| **SDD_MODE** | full |
| **Objetivo** | Volver `core/` + `chains/registry.ts` + `chains/types.ts` namespace-agnóstico, preservando EVM byte-idéntico y abriendo el slot no-EVM |
| **Reglas de negocio** | No mover plata de ninguna red nueva; solana debe rutear a error estructurado, nunca a un settle simulado exitoso (CD-3) |
| **Scope IN** | `src/core/verify.ts`, `src/core/settle.ts`, `src/chains/registry.ts`, `src/chains/types.ts`, `src/core/schemas.ts`, `src/core/supported.ts`, `src/core/types.ts`, `OWNERS.md`, tests |
| **Scope OUT** | Adapter Solana real, lógica ed25519/SPL/RPC Solana, `src/routes/*`, `src/middleware/*`, `src/infra/*`, openapi.yaml, X402-CONFORMANCE.md, chains EVM nuevas |
| **Missing Inputs** | 3 [NEEDS CLARIFICATION] — **RESUELTOS en §10 de este SDD** |

### Acceptance Criteria (EARS)

- **AC-1 (regresión EVM — CENTRAL)**: WHILE el path `eip155:<chainId>` con método `eip3009` se ejecuta
  contra `verifyCore` / `settleCore`, THE system SHALL producir exactamente el mismo comportamiento
  observable (mismos códigos x402, mismos HTTP status, mismo `Result<T>` shape, mismo orden de checks) que
  antes de esta HU. Toda la suite existente (58 archivos / 833 tests verificados verdes 2026-07-21) SHALL
  pasar **sin modificar sus expectativas** (edits permitidos solo mecánicos por el refactor de tipos —
  imports; CERO cambio de assertion de comportamiento).
- **AC-2 (namespace routing genérico)**: WHEN `verifyCore` / `settleCore` recibe un `accepted.network` que
  matchea el namespace `eip155:` (regex `EIP155_RE` vigente), THE system SHALL rutear por el mismo path
  numérico `ChainId` que hoy (chain-adaptive intacto).
- **AC-3 (slot no-EVM sin crash)**: WHEN `verifyCore` / `settleCore` recibe `accepted.network` con
  namespace `solana:<cluster>` con cluster válido (`devnet` | `mainnet`), THE system SHALL retornar
  `Result<T>` con `ok: false`, código `CHAIN_UNAVAILABLE` (HTTP 503) y mensaje que indica "red reconocida
  pero sin adapter registrado" — NUNCA un throw sin capturar, `undefined` de un `.get()` sin chequear, ni
  un 500 no estructurado. IF el cluster es inválido (ej. `solana:1`, `solana:foo`), THEN THE system SHALL
  retornar `NETWORK_MISMATCH` (HTTP 400) — "red inválida", indistinguible byte-a-byte del comportamiento
  actual.
- **AC-4 (interfaz verify-only)**: THE system SHALL exponer una interfaz `SettlementAdapter` que permita
  implementar `verify()` / `settle()` sin requerir `getPublicClient()` / `getWalletClient()`. Esta HU
  define y tipa la interfaz; NO la implementa con un adapter real (CD-3).
- **AC-5 (schema discrimina por método)**: WHEN `VerifyRequestSchema` valida un payload con
  `accepted.extra.assetTransferMethod !== 'eip3009'`, THE system SHALL permitir (a nivel de tipo y de
  validación Zod) formas de `payload` no-EVM sin romper el narrowing del path `eip3009`. Discrimina el
  schema; NO define el payload shape final de Solana.
- **AC-6 (registry indexable por networkId string)**: THE system SHALL permitir que `ChainRegistry`
  indexe adapters por un `networkId: string` (ej. `"solana:devnet"`) sin romper
  `getSupportedChainIds()` / `listAdapters()` / `/supported` / `getAdapter(chainId)` O(1) para EVM.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read/Glob)

| Archivo | Por qué | Patrón/hallazgo extraído |
|---------|---------|--------------------------|
| `src/core/verify.ts` | Punto 1 del dispatch a generalizar | `EIP155_RE = /^eip155:([1-9]\d*)$/u` (l.37); overflow guard `MAX_CHAINID_DIGITS=16` (l.40,63); orden: regex→overflow→method guard→`chainRegistry.getAdapter(chainId)`→dispatch; `NEVER throws`; cast `parsed as unknown as VerifyParams` (l.101) |
| `src/core/settle.ts` | Espejo del dispatch (duplica regex a propósito, l.29-32) | Step 0 cap check lee `parsed.payload.authorization.value` (l.54) ANTES del namespace/method → punto de ripple del schema; misma estructura de 4 pasos; cast `as unknown as SettleParams` (l.117) |
| `src/core/schemas.ts` | Discriminación por método (AC-5) | `AcceptedExtraSchema.assetTransferMethod: z.enum(['eip3009','permit2','erc7710'])` (l.49); `PayloadSchema` fuerza shape eip3009 (signature 0x-hex + `Eip3009AuthorizationSchema`) (l.79-84); `.strict()` en todos; `SettleRequestSchema = VerifyRequestSchema` alias (l.112) |
| `src/core/supported.ts` | Métodos por-adapter (Scope IN) | `CHAIN_METHODS_DEFAULT = ['eip3009']` global (l.31); `getSupportedResponse()` mapea `chainRegistry.listAdapters()`; ducktype `getBreakerState` vía `getAdapter(meta.chainId)` (l.81-87) |
| `src/core/types.ts` | `X402ErrorCode` union + `ChainId` brand | 12 códigos (10 spec + `CHAIN_UNAVAILABLE` 503 + `OPERATOR_FUNDING_LOW` 503) (l.33-54); `ChainId = number & brand` (l.20); `asChainId` throws (l.26) |
| `src/core/errors.ts` | Tablas exhaustivas `Record<X402ErrorCode, T>` | `HTTP_BY_CODE` (l.45) + `DEFAULT_MESSAGE_BY_CODE` (l.74) exhaustivas — el compilador fuerza cobertura; `buildX402Error(code, message?)` pura (l.109) |
| `src/chains/registry.ts` | Key generalizable (AC-6) | `Map<ChainId, ChainAdapter>` (l.28); `getAdapter(chainId)` O(1) (l.66); de-dup por `metadata.chainId` (l.50); `_isValidAdapter` exige `verify/settle/getPublicClient/getWalletClient` (l.113-127); `getSupportedChainIds()` = `keys()` (l.98) |
| `src/chains/types.ts` | `SettlementAdapter` nueva (AC-4) | `ChainMetadata.networkId: string` ("eip155:<chainId>") YA existe (l.49); `ChainAdapter` 5-miembros + `getPublicClient/getWalletClient` viem (l.128-154); `VerifyParams`/`SettleParams` (`=VerifyParams`) shapes x402 (l.64-110) |
| `src/routes/verify.ts` | Verificar impacto CD-2 de nuevo código | `VerifyRouteErrorCode` = union literal que LISTA todos los `X402ErrorCode` (l.38-56); `result.error.code` (X402ErrorCode) se asigna a esa union (l.195) → **widening rompe typecheck aquí** |
| `src/routes/settle.ts` | Idem espejo | `SettleRouteErrorCode` (l.44) lista X402ErrorCode + `SERVICE_UNAVAILABLE`/`CONFLICT`/`RATE_LIMITED`; `result.error.code` asignado (l.326,344,365); Retry-After solo si `code==='CHAIN_UNAVAILABLE' && typeof retryAfterMs==='number'` (l.358) |
| `src/__tests__/unit/core.verify.test.ts` | Baseline assertions EVM | T-V6 usa `network:'solana:1'` → espera `NETWORK_MISMATCH` http 400 (l.146-157); registro vía `_resetForTesting()`+`register()`; `makeFakeAdapter` (l.73) |
| `src/__tests__/unit/core.settle.test.ts` | Baseline assertions settle | T-C2 `solana:1` → NETWORK_MISMATCH (l.118); mismo fixture eip3009 |
| `src/__tests__/unit/chain-registry.test.ts` | Contrato registry | AC-5 dup chainId→409, AC-4 unregistered→400, `getSupportedChainIds().map(Number).sort()` = [2368,43113] etc (integration l.174-306); solo chequean code+http, no mensajes exactos de miss |
| `src/__tests__/unit/routes.verify.test.ts` | Assertions HTTP | T-R6 `solana:1` → 400 NETWORK_MISMATCH (l.360); rechazos schema → `code==='INVALID_PAYLOAD'` http 400 (l.316,335,354) **sin** assert de mensaje Zod exacto |
| `OWNERS.md` | Nota de refactor autorizado (DT-1) | Regla #1 "agregar chain = 1 archivo, si tocás core parar" (l.106); excepciones documentadas como notas `[N]` |
| `package.json` | Toolchain / gates | `test: vitest run`, `typecheck: tsc --noEmit`, `lint: eslint --max-warnings 0`, `qa: typecheck && lint && format:check && test`; **NO biome** |

### Exemplars verificados (Glob confirmado)

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| Rama solana en `verify.ts` | El cuerpo actual de `verifyCore` (return `{ok:false, error: buildX402Error(...)}`) | Mismo estilo de early-return con `buildX402Error`, nunca throw |
| Rama solana en `settle.ts` | El bloque espejo de `settleCore` | Duplicación deliberada (patrón `EIP155_RE`, settle.ts:29-32) |
| `SettlementAdapter` en `chains/types.ts` | `ChainAdapter` (l.128-154) | Interfaz base; `ChainAdapter extends SettlementAdapter` |
| `getAdapterByNetworkId` en `registry.ts` | `getAdapter` (l.66-88) | Mismo shape de Result de retorno |
| schema discriminado en `schemas.ts` | `AcceptedSchema`/`PayloadSchema` (.strict()) | Preservar strict + branded hex |
| Test nuevo dispatch solana | `core.verify.test.ts` T-V6/T-V9 | `_resetForTesting()`+`register()`+`makeFakeAdapter` |
| Test nuevo registry-por-networkId | `chain-registry.test.ts` | `new ChainRegistry()` + `makeMockAdapter` |

### Estado de BD relevante

N/A — esta HU no toca BD (ledger/audit son `src/infra/*` / `src/core/audit.ts`, fuera de Scope y protegidos por CD-2).

### Componentes reutilizables encontrados

- `buildX402Error(code, message?)` (`src/core/errors.ts`) — usar para TODOS los errores nuevos, incluida
  la rama solana. NO construir objetos `{code,message,http}` a mano.
- `CHAIN_UNAVAILABLE` (503) ya existe en `X402ErrorCode` + tablas exhaustivas + manejo de Retry-After en
  ambas rutas — **se reutiliza** para el slot no-EVM (ver DT-2 / §10.2).
- `ChainMetadata.networkId: string` ya existe — es la clave string para el registry generalizado (AC-6).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `src/chains/types.ts` | Modificar | Añadir `interface SettlementAdapter` (verify-only, sin viem clients) + `ChainAdapter extends SettlementAdapter`. Sin romper shapes existentes | `ChainAdapter` actual |
| `src/core/types.ts` | Modificar | Añadir `type NetworkId = string` + helpers de namespace (`type NetworkNamespace = 'eip155' \| 'solana'`). SIN romper `ChainId` | union `X402ErrorCode` |
| `src/chains/registry.ts` | Modificar | Map key `ChainId`→`string` (networkId); `getAdapterByNetworkId(networkId)`; `getAdapter(chainId)` como wrapper O(1); de-dup por `metadata.networkId`; `getSupportedChainIds()` deriva de `metadata.chainId`; `_isValidAdapter` INTACTO | `getAdapter` (l.66-88) |
| `src/core/verify.ts` | Modificar | Namespace dispatch: rama `solana:` ANTES del cuerpo eip155 actual (que queda INTACTO) | cuerpo actual |
| `src/core/settle.ts` | Modificar | Espejo; + narrowing `'authorization' in parsed.payload` en el cap check (Step 0) por el schema union | cuerpo actual + verify.ts |
| `src/core/schemas.ts` | Modificar | Discriminar payload por `assetTransferMethod` (union eip3009 vs no-eip3009), branch eip3009 byte-idéntico | `PayloadSchema`/`AcceptedSchema` |
| `src/core/supported.ts` | Modificar | Métodos por-adapter con fallback a `CHAIN_METHODS_DEFAULT` (output byte-idéntico, ningún adapter override aún) | `getSupportedResponse` |
| `OWNERS.md` | Modificar | Nota `[4]` — refactor namespace-agnóstico de `core/` autorizado (excepción a regla #1), origen WKH-204 | notas `[1]`/`[2]`/`[3]` |
| `src/__tests__/unit/core.verify.test.ts` | Modificar | + tests dispatch `solana:devnet`→CHAIN_UNAVAILABLE 503, `solana:mainnet`→503, `solana:1`→NETWORK_MISMATCH (byte-idéntico) | tests existentes |
| `src/__tests__/unit/core.settle.test.ts` | Modificar | Idem para `settleCore` | tests existentes |
| `src/__tests__/unit/chain-registry.test.ts` | Modificar | + tests `getAdapterByNetworkId` + registro por networkId string | tests existentes |
| `src/__tests__/unit/core.schemas.discriminated.test.ts` | Crear (o extender) | Schema acepta payload no-eip3009 sin romper narrowing eip3009 | `core.verify.test.ts` T-V1..V5 |

> **Nota**: si el Dev prefiere un archivo de test nuevo (`*.solana.test.ts`) en vez de extender los
> existentes, es aceptable siempre que los tests existentes NO cambien sus assertions (CD-1).

### 4.2 Modelo de datos

N/A — sin cambios de BD.

### 4.3 Componentes / Servicios — diseño de la abstracción

**(a) `SettlementAdapter` (AC-4) — `src/chains/types.ts`**

Interfaz BASE con los métodos money-moving que NO requieren viem clients; `ChainAdapter` la extiende
con la parte EVM (viem). Adición, no reemplazo (DT-3 del work item):

```
SettlementAdapter (nueva, base):
  readonly metadata: ChainMetadata
  verify(params): Promise<AdapterResult<VerifyResult>>
  settle(params): Promise<AdapterResult<SettleResult>>
  getBreakerState?(): 'CLOSED'|'OPEN'|'HALF_OPEN'|undefined   // opcional (ya existía en ChainAdapter)
  setLogger?(logger): void                                    // opcional

ChainAdapter extends SettlementAdapter (EVM):
  getPublicClient(): PublicClient
  getWalletClient(): WalletClient
```

- `ChainMetadata` NO cambia su `chainId: ChainId` (numérico, EVM). El story de metadata no-EVM
  (networkId-primary, chainId opcional) se **difiere a HU-SOL-6** — AC-4 solo pide que la interfaz
  verify-only EXISTA, no que un adapter no-EVM se construya.
- El registry sigue almacenando `ChainAdapter` (EVM) en esta HU; HU-SOL-6 ampliará el value-type a
  `SettlementAdapter` cuando registre el adapter Solana real. AC-6 es sobre el **tipo de la KEY**
  (string), no del value.

**(b) `ChainRegistry` generalizado (AC-6) — clarificación #3 resuelta in-place (§10.3)**

```
_adapters: Map<string, ChainAdapter>        // KEY = networkId string (antes ChainId)
register(adapter): de-dup por adapter.metadata.networkId
getAdapterByNetworkId(networkId: string): { ok, adapter } | { ok:false, error }   // NUEVO
getAdapter(chainId: ChainId): wrapper O(1) → getAdapterByNetworkId(`eip155:${chainId}`)
                              // preserva EXACTAMENTE el mensaje de miss `Chain not registered: ${chainId}`
getSupportedChainIds(): itera values → adapter.metadata.chainId  (mismos valores ChainId[])
listAdapters(): sin cambio (itera values → metadata)
_isValidAdapter(): SIN CAMBIO (valida shape ChainAdapter EVM completo — DT-4 "no regresiona")
```

**(c) Namespace dispatch (AC-2/AC-3) — `verify.ts` / `settle.ts`**

Añadir la rama solana ANTES del cuerpo eip155 actual, que queda **literalmente intacto**:

```
const namespace = network.substring(0, network.indexOf(':'))   // prefijo antes del primer ':'
if (namespace === 'solana') {
   if (!/^solana:(devnet|mainnet)$/u.test(network))
       return { ok:false, error: buildX402Error('NETWORK_MISMATCH', 'network must be ...') }  // cluster inválido
   const lookup = chainRegistry.getAdapterByNetworkId(network)
   if (!lookup.ok)
       return { ok:false, error: buildX402Error('CHAIN_UNAVAILABLE',
                'Network namespace recognized but no adapter registered') }   // AC-3
   return lookup.adapter.verify(params) / .settle(params)   // inalcanzable esta HU (no hay adapter solana)
}
// ── fall-through: cuerpo eip155 ACTUAL sin tocar (EIP155_RE → overflow → method → getAdapter → dispatch)
```

Consecuencia byte-idéntica: TODO network que no empiece con `solana:` toma el path idéntico de hoy;
`solana:*` con cluster inválido (incluye `solana:1`, único que usan los tests) → NETWORK_MISMATCH
idéntico; solo `solana:devnet` / `solana:mainnet` cambian (sin tests existentes que los usen).

**(d) Schema discriminado (AC-5) — `schemas.ts`**

`VerifyRequestSchema` pasa a `z.union([Eip3009RequestSchema, NonEip3009RequestSchema])`:
- `Eip3009RequestSchema`: idéntico al actual pero `accepted.extra.assetTransferMethod: z.literal('eip3009')`
  + `PayloadSchema` eip3009 estricto. → bodies eip3009 validan idéntico.
- `NonEip3009RequestSchema`: mismo top-level pero `assetTransferMethod: z.enum(['permit2','erc7710'])`
  + payload permisivo-pero-tipado (placeholder no-EVM; NO define el shape final de Solana — CD-3).
- `z.union` (no `discriminatedUnion`: el discriminante vive anidado en `accepted.extra`, no al top level).
- Tipo inferido `VerifyRequest` = union → única ripple: `settleCore` Step 0 lee
  `parsed.payload.authorization.value`. Se resuelve con narrowing por operador `in`:
  `if ('authorization' in parsed.payload) { ...cap check actual... }`. Para bodies eip3009 (todos los
  fixtures existentes) `'authorization' in payload` es `true` → cap check corre idéntico (byte-idéntico).
- CD-4: sin `any`, sin `as unknown as X` nuevos. `z.union` + `z.literal` + narrowing `in`.

**(e) `supported.ts` métodos por-adapter**

`getSupportedResponse()` lee `adapter.metadata.supportedMethods ?? CHAIN_METHODS_DEFAULT` (nuevo campo
opcional `supportedMethods?: readonly string[]` en `ChainMetadata`). Ningún adapter EVM lo setea →
output byte-idéntico (`routes.supported.test.ts` verde por AC-1).

### 4.4 Flujo principal (Happy Path — EVM, sin cambio)

1. `POST /verify` con `network:"eip155:2368"`, método `eip3009`.
2. Route Zod-valida (branch eip3009 del union) → `verifyCore`.
3. `namespace !== 'solana'` → fall-through → `EIP155_RE` match → `getAdapter(2368)` → dispatch adapter.
4. Resultado idéntico a hoy.

### 4.5 Flujo de error

1. `network:"solana:devnet"` → rama solana → cluster válido → `getAdapterByNetworkId('solana:devnet')`
   miss → `CHAIN_UNAVAILABLE` 503 "no adapter registered". Route mapea 503 (sin Retry-After: no hay
   `retryAfterMs`).
2. `network:"solana:1"` → rama solana → cluster inválido → `NETWORK_MISMATCH` 400 (byte-idéntico a hoy).
3. `network:"foo:bar"` / garbage → fall-through → `EIP155_RE` miss → `NETWORK_MISMATCH` 400 (idéntico).
4. Método `permit2` + payload no-eip3009 → Zod acepta (branch NonEip3009); `verifyCore` method guard
   (dentro del cuerpo eip155, tras fall-through para `eip155:`) → `NETWORK_MISMATCH` "only eip3009 in v1"
   (idéntico a T-V10).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1 (heredado, OBLIGATORIO)**: EVM byte-idéntico. La rama solana se AÑADE antes del cuerpo eip155;
  el cuerpo eip155 de `verifyCore`/`settleCore` NO se reescribe. Ningún test existente cambia su assertion.
- **CD-2 (heredado, OBLIGATORIO)**: PROHIBIDO tocar `src/routes/*`, `src/middleware/*`, `src/infra/*`. El
  dispatch multi-red se resuelve en `src/core/*` + `src/chains/registry.ts` + `src/chains/types.ts`.
- **CD-3 (heredado, OBLIGATORIO)**: PROHIBIDO implementar lógica real Solana (ed25519, SPL, RPC, wallet).
  La rama solana responde determinística y no-crasheante; NUNCA simula un settle exitoso.
- **CD-4 (heredado)**: PROHIBIDO `any` / `as unknown as X` nuevos para el discriminated union. Usar
  `z.union` + `z.literal` + narrowing por `in`.
- **CD-5 (heredado, OBLIGATORIO)**: PROHIBIDO romper la API pública `/verify` `/settle`. Refactor
  interno; ningún consumidor HTTP nota el cambio. Reusar `CHAIN_UNAVAILABLE` NO agrega códigos nuevos al
  shape público (ver DT-2).
- **CD-6 (heredado, OBLIGATORIO)**: cambios en `registry.ts` + `chains/types.ts` requieren AR obligatorio
  (money-moving-adjacent).
- **CD-7 (nuevo)**: Reusar `CHAIN_UNAVAILABLE` (503) para el slot no-EVM SIN `retryAfterMs`. NO añadir un
  nuevo valor a `X402ErrorCode` (ver DT-2 y §10.2 — un código nuevo forzaría editar las route-local unions
  → viola CD-2).
- **CD-8 (nuevo)**: el cuerpo eip155 de `verifyCore`/`settleCore` (EIP155_RE, overflow guard, method guard,
  `getAdapter(chainId)`) queda **textualmente intacto**; solo se antepone la rama de namespace.
- **CD-9 (nuevo, heredado de auto-blindaje WFAC-148)**: cualquier widening de un tipo/union compartido
  ripplea a route-local unions / partial mocks / `Record<Union,T>` exhaustivos. Antes de widenear, grep de
  todos los consumidores. Esta HU EVITA widenear `X402ErrorCode` justamente por esto.

### PROHIBIDO
- NO agregar dependencias nuevas (viem/solana web3.js/etc.). Ninguna.
- NO crear `src/chains/<solana>.ts` ni ningún adapter concreto.
- NO crear `src/core/network.ts` compartido (fuera de Scope IN; mantener la duplicación deliberada del
  patrón `EIP155_RE`, ver settle.ts:29-32).
- NO cambiar `_isValidAdapter` (DT-4).
- NO modificar archivos fuera de la tabla 4.1.
- NO usar biome (el toolchain es eslint + prettier — `npm run qa`; auto-blindaje WFAC-148).
- NO usar `typeof import('...')` inline en tests (ESLint `consistent-type-imports`); usar
  `import type * as X` top-level (auto-blindaje WFAC-148).
- NO acceso member por clave variable en duck-typing (`security/detect-object-injection`); usar claves
  literales sobre interfaz tipada (auto-blindaje WKH-154).

## 6. Scope

**IN**: los 8 archivos de producción + 4 de test de la tabla 4.1.
**OUT**: adapter Solana real, lógica Solana, `routes/*`, `middleware/*`, `infra/*`, openapi.yaml,
X402-CONFORMANCE.md, chains EVM nuevas, métodos EVM nuevos, `src/core/network.ts` compartido.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Schema `z.union` cambia el issue Zod de un body eip3009 malformado y rompe un route test que asserta el mensaje | B | A | Verificado: route tests solo chequean `code==='INVALID_PAYLOAD'` + http, no el mensaje Zod (routes.verify.test.ts:316,335,354). Branch eip3009 = z.literal → matchea primero |
| Ripple del union type a `settleCore` Step 0 (cap check lee `payload.authorization`) | M | M | Narrowing `if ('authorization' in parsed.payload)`; true para todo fixture eip3009 → byte-idéntico. Correr AC-1 completo; si un test de precedencia cap-vs-method con método no-eip3009 rompe, escalar |
| Cambiar Map key a string rompe `getSupportedChainIds()`/de-dup | B | A | Derivar chainId de `metadata.chainId`; de-dup por networkId (1:1 con chainId para EVM). Tests integration solo chequean valores ChainId[], preservados |
| Reusar `CHAIN_UNAVAILABLE` para solana confunde con breaker-open en métricas | B | B | Semánticamente correcto ("chain unavailable"); mensaje distinto; sin `retryAfterMs` → sin Retry-After. Documentado |
| `getAdapter(chainId)` wrapper cambia mensaje de miss y rompe un assert | B | M | Wrapper preserva textualmente `Chain not registered: ${chainId}` (tests no chequean mensaje, pero se preserva por seguridad) |

## 8. Dependencias

- Ninguna externa. Baseline verde (833 tests) confirmado 2026-07-21.
- Bloquea HU-SOL-6 (adapter Solana real) — depende del merge de esta HU.

## 9. Missing Inputs

Ninguno bloqueante. Los 3 [NEEDS CLARIFICATION] del work-item quedan RESUELTOS en §10.

## 10. Resolución de los 3 [NEEDS CLARIFICATION]

### 10.1 Formato `networkId` no-EVM → `solana:<cluster>` simplificado

**Decisión**: `solana:devnet` / `solana:mainnet` (cluster simplificado), NO el genesis-hash CAIP-2 completo.
EVM permanece `eip155:<chainId>` intacto. Regex de validación: `/^solana:(devnet|mainnet)$/u`.

**Razón**: consistencia cross-HU obligatoria con HU-SOL-8 (PoP/atestación), que ata las atestaciones al
cluster `solana:devnet` vs `solana:mainnet` (anti-replay cross-cluster, hallazgo ME-3). No hay consumidores
CAIP-2 reales todavía. Ventaja colateral: `solana:1` (único string solana en los tests actuales) NO matchea
`(devnet|mainnet)` → sigue siendo `NETWORK_MISMATCH` → **CD-1 byte-idéntico garantizado**.

### 10.2 Código de error para "namespace reconocido, sin adapter" (AC-3) → reusar `CHAIN_UNAVAILABLE` (503)

**Decisión**: reusar el código existente `CHAIN_UNAVAILABLE` (HTTP 503) con un **mensaje distinto y explícito**
(`"Network namespace recognized but no adapter registered"`), SIN `retryAfterMs`. NO se agrega un nuevo valor
a `X402ErrorCode`.

**Razón (diverge de la "leve preferencia" del steer por un código nuevo — decisión de Architect fundada en
grounding)**: agregar un valor a `X402ErrorCode` fuerza actualizar las **route-local unions**
`VerifyRouteErrorCode` (`src/routes/verify.ts:38-56`) y `SettleRouteErrorCode` (`src/routes/settle.ts:44`),
porque `result.error.code` (tipado `X402ErrorCode`) se asigna a esas unions (verify.ts:195; settle.ts:326,344,365).
Editar `src/routes/*` **viola CD-2 (OBLIGATORIO)**. El auto-blindaje de WFAC-148 documenta exactamente este
acoplamiento ("Any new `X402ErrorCode` value must be added to BOTH `src/routes/settle.ts` and
`src/routes/verify.ts` route-local unions plus the two exhaustive Records"). Entre reusar existentes:
`NETWORK_MISMATCH` está prohibido por el steer (confunde "red inválida" con "válida sin adapter") y por AC-3;
`CHAIN_UNAVAILABLE` ("chain no disponible") es semánticamente el más cercano a "red reconocida, sin adapter",
se distingue del path inválido, y su manejo de Retry-After es no-op sin `retryAfterMs` (verify.ts:187-193;
settle.ts:358). Cumple AC-3 (código distinto de NETWORK_MISMATCH + mensaje claro + 5xx) SIN violar CD-2/CD-5.

> **Flag al humano (gate SPEC_APPROVED)**: si se prefiere estrictamente un código nuevo
> (`NETWORK_NOT_SUPPORTED`/`ADAPTER_NOT_REGISTERED`), habría que **ampliar el Scope IN a `src/routes/verify.ts`
> + `src/routes/settle.ts`** y relajar CD-2 para esos 2 archivos (edits mecánicos: +1 miembro en cada union +
> 2 entradas en los Records de `errors.ts`). Recomendación del Architect: NO — reusar `CHAIN_UNAVAILABLE`
> mantiene el blast-radius dentro de `core/`+`chains/` y honra CD-2 tal como está aprobado.

### 10.3 `ChainRegistry` in-place vs hermano → **in-place**, key `ChainId`→`string` (networkId)

**Decisión**: generalizar `ChainRegistry` **in-place**: `Map<ChainId, ChainAdapter>` → `Map<string, ChainAdapter>`
keyed por `metadata.networkId`. Añadir `getAdapterByNetworkId(networkId: string)`. `getAdapter(chainId: ChainId)`
queda como wrapper O(1) (`getAdapterByNetworkId(\`eip155:${chainId}\`)`). `_isValidAdapter` INTACTO.
`getSupportedChainIds()` deriva de `metadata.chainId`.

**Razón**: single source of truth (un solo Map, sin drift entre registry EVM y hermano), satisface DT-4
(getAdapter EVM O(1): concat string O(1) + Map.get O(1); `_isValidAdapter` sin regresión porque ningún adapter
no-EVM se registra en esta HU). Un registry hermano duplicaría `listAdapters`/`getSupportedChainIds`/logging y
partiría el estado. **Impacto en OWNERS.md**: se documenta como nota `[4]` — el key del registry ahora es
`networkId: string` (no `ChainId` numérico); agregar una red = 1 archivo `src/chains/<red>.ts` + 1 línea en
registry con `metadata.networkId` de su namespace, SIN volver a tocar `core/`.

## 11. Plan de Tests (≥1 por AC)

| Test | AC | Archivo | Qué verifica |
|------|----|---------|--------------|
| Suite completa 833 tests verde | AC-1 | (todos) | `npm test` sin cambios de assertion; edits solo mecánicos de imports |
| EVM `eip155:2368` dispatch happy + errores actuales | AC-2 | core.verify/settle.test.ts (existentes) | Path numérico intacto |
| `solana:devnet`→CHAIN_UNAVAILABLE 503 + mensaje "no adapter"; `solana:mainnet`→503; `solana:1`→NETWORK_MISMATCH 400 | AC-3 | core.verify/settle.test.ts (extender) | No-crash, código correcto, byte-idéntico para cluster inválido |
| `SettlementAdapter` tipa verify/settle sin viem clients (compilación + type test) | AC-4 | core-types.test.ts o nuevo | Interfaz existe, `ChainAdapter extends SettlementAdapter` |
| Schema acepta body método≠eip3009 con payload no-eip3009; body eip3009 valida idéntico | AC-5 | core.schemas.discriminated.test.ts (crear) | Discriminación sin romper narrowing |
| `getAdapterByNetworkId('eip155:2368')` hit; registro por networkId; `getAdapter(chainId)` O(1) equivalente; miss→400 | AC-6 | chain-registry.test.ts (extender) | Key string + wrapper compat |

**Criterio test-first**: lógica de negocio (dispatch, registry, schema) → SÍ test-first.
**Gate**: `npm run qa` (typecheck strict + eslint --max-warnings 0 + prettier --check + vitest run).

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | Los 3 [NEEDS CLARIFICATION] resueltos en §10 | No |

## 13. Waves de Implementación

### Wave 0 (Serial Gate — tipos base, no rompen ChainId/ChainAdapter)
- W0.1: `src/core/types.ts` — `NetworkId`/`NetworkNamespace` (aditivo, sin tocar `ChainId`/`X402ErrorCode`).
- W0.2: `src/chains/types.ts` — `SettlementAdapter` + `ChainAdapter extends SettlementAdapter` + campo opcional
  `ChainMetadata.supportedMethods?`.
- Verificación: `npm run typecheck` verde.

### Wave 1 (Registry — depende de W0)
- W1.1: `src/chains/registry.ts` — Map key `string`, `getAdapterByNetworkId`, wrapper `getAdapter`, de-dup por
  networkId, `getSupportedChainIds` desde metadata, `_isValidAdapter` intacto.
- Verificación: `npm run typecheck` + `chain-registry.test.ts` verde.

### Wave 2 (Dispatch por namespace — depende de W1)
- W2.1: `src/core/verify.ts` — rama solana antes del cuerpo eip155 (intacto).
- W2.2: `src/core/settle.ts` — espejo + narrowing `in` en cap check.
- Verificación: `npm run typecheck` + core.verify/settle.test.ts + routes.*.test.ts verde.

### Wave 3 (Schema + supported — depende de W0)
- W3.1: `src/core/schemas.ts` — `z.union` discriminado (branch eip3009 byte-idéntico).
- W3.2: `src/core/supported.ts` — métodos por-adapter con fallback.
- Verificación: `npm run qa` completo.

### Wave 4 (Docs + tests nuevos — final)
- W4.1: `OWNERS.md` nota `[4]`.
- W4.2: tests nuevos (dispatch solana, registry por networkId, schema discriminado).
- Verificación: `npm run qa` completo (833+ tests verde).

## 14. Readiness Check

```
[x] Cada AC (AC-1..6) tiene ≥1 archivo asociado en tabla 4.1 y ≥1 test en §11
[x] Cada archivo en 4.1 tiene Exemplar verificado con Glob/Read (§3)
[x] No hay [NEEDS CLARIFICATION] pendientes (3 resueltos en §10)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (§5 tiene 8+ PROHIBIDO + 9 CD)
[x] Context Map tiene ≥2 archivos leídos (15 archivos leídos)
[x] Scope IN y OUT explícitos y no ambiguos (§6)
[x] BD: N/A verificado (sin cambios de BD)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, 4 casos)
[x] Baseline verde confirmado: 58 archivos / 833 tests (2026-07-21)
[x] CD-2 no violado: nuevo código evitado; solución dentro de core/+chains/
```

**No blockers.** SDD listo para gate SPEC_APPROVED → F2.5 (Story File).

---

*SDD generado por NexusAgil — FULL — nexus-architect F2*
