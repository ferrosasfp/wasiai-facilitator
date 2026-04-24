# SDD — [WFAC-50] Kite Testnet Adapter REAL (MVP chain)

- **HU**: WFAC-50
- **Branch**: `feat/017-wfac-50-kite-testnet-adapter`
- **Mode**: QUALITY (full SDD)
- **Estimación**: L
- **Architect**: nexus-architect
- **Fecha**: 2026-04-23

---

## 1. Context & Objective

Reemplazar los stubs de `_verifyRaw` y `_settleRaw` en `src/chains/kite.ts` (hoy
devuelven `NETWORK_MISMATCH → "pending WFAC-10/11"`) por implementaciones reales
contra Kite Testnet (chainId 2368) usando viem v2:

- `_verifyRaw` → normalización + recuperación EIP-712 real + checks mínimos.
- `_settleRaw` → `simulateContract → writeContract → waitForTransactionReceipt`
  usando un `WalletClient` firmable con `OPERATOR_PRIVATE_KEY`.
- Nuevo singleton `src/infra/wallet.ts` (account factory) para desbloquear
  también el TODO `WFAC-wallet-singleton` de Avalanche.
- Nuevo ABI local `src/chains/abi/fiat-token.ts` por boundary OWNERS
  (`chains ↛ methods`). Necesario porque el viejo FIAT_TOKEN_ABI + constantes
  EIP-712 viven en `src/methods/eip3009/`.

La HU preserva la lógica de circuit breaker (WFAC-41) ya integrada en
`KiteAdapter.verify/settle` — los `_verifyRaw`/`_settleRaw` deben seguir
retornando `AdapterResult` y delegar el accounting de fallas (`SIMULATION_FAILED`
/ `TRANSACTION_FAILED`) al outer wrapper mediante `BusinessFailureError`.

Bajo `NODE_ENV === 'test'` NO puede haber llamadas reales a
`https://rpc-testnet.gokite.ai` — los tests mockean los clients con
`vi.fn()` (patrón ya consolidado en `settle.test.ts`).

---

## 2. Context Map (archivos leídos)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `.nexus/project-context.md` | stack autoritativo | viem v2, TypeScript strict, service layer returns `Result<T>` (nunca throw), x402 spec-literal |
| `doc/sdd/017-wfac-50-kite-testnet-adapter/work-item.md` | input WFAC-50 | 19 ACs, 7 CDs, 6 DTs, Scope IN/OUT |
| `OWNERS.md` | boundaries | `src/chains/* ↛ src/methods/*`, `src/chains/* ↛ src/core/*` (runtime) salvo excepción `[1]` para `core/errors.ts` |
| `src/chains/kite.ts` | target principal | KiteAdapter class, breaker wrap con `BusinessFailureError`, stubs `_verifyRaw`/`_settleRaw` |
| `src/chains/avalanche.ts` | sibling adapter | mismo breaker pattern, `USDC_FUJI` EIP3009Token hardcoded module-level |
| `src/chains/types.ts` | contratos | `VerifyParams`, `VerifyResult`, `SettleParams`, `SettleResult`, `EIP3009Token`, `ChainAdapterInitError` |
| `src/methods/eip3009/verify.ts` | lógica de referencia | 10-step pipeline con `normalizeSignature` + `buildEip3009Domain` + `recoverTypedDataAddress`; usa `isAddressEqual`, `BigInt` para timestamps |
| `src/methods/eip3009/settle.ts` | lógica de referencia | `simulateContract → writeContract → waitForTransactionReceipt`; `sanitize()` helper (max 200 chars); literal `'receipt timeout'` |
| `src/methods/eip3009/abi.ts` | ABI canónica | `FIAT_TOKEN_ABI as const`, `EIP3009_TYPES as const`, `EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS = 60_000` |
| `src/methods/eip3009/signature.ts` | utility reutilizable | `normalizeSignature(sig): NormalizedSignature \| SignatureError`; el `SignatureError.error` es directamente un `Err['error']` |
| `src/methods/eip3009/domain.ts` | EIP-712 domain builder | `buildEip3009Domain(token, chainId, accepted)` — pure |
| `src/core/errors.ts` | `buildX402Error` canónico | `CHAIN_UNAVAILABLE → 503` ya existe; todos los códigos mapeados |
| `src/infra/env.ts` | EnvSchema Zod | patrón `superRefine` para vars requeridas según `NODE_ENV`; `z.coerce.boolean()` PROHIBIDO (CD-12 WFAC-40) |
| `src/__tests__/unit/methods/eip3009/settle.test.ts` | exemplar test | `makeMockClients()` con `vi.fn()` casteado `as unknown as PublicClient/WalletClient`; fixtures con `privateKeyToAccount` Hardhat #0 |
| `src/__tests__/unit/chain-adapter.test.ts` | exemplar adapter test | `vi.resetModules()` + dynamic import para reset de singletons; snapshot/restore de `process.env` |
| `.env.example` | template | ya declara `OPERATOR_PRIVATE_KEY`; falta `KITE_USDC_ADDRESS` |
| `doc/sdd/016-wfac-41-circuit-breaker/auto-blindaje.md` | lecciones previas | AR-BLQ-ALTO-1: `BusinessFailureError` pattern; `FastifyBaseLogger → Logger` cast needed; openapi.yaml lags behind |
| `doc/sdd/015-wfac-40-rate-limiting/auto-blindaje.md` | lecciones previas | `errorResponseBuilder` → `statusCode` non-enumerable trick |
| `doc/sdd/014-wfac-33-audit-log/auto-blindaje.md` | lecciones previas | cuidado con asunciones sobre shape de strings en tests |

---

## 3. Architecture Decisions (DT-N)

Las DTs heredadas del work-item se **resuelven aquí** (DT-1..DT-6 del work-item
→ DT-A..DT-I del SDD). Alguna DT se refina o parte en dos.

### DT-A — Boundary `chains ↛ methods`: ABI duplication, not exception

**Decisión**: Crear `src/chains/abi/fiat-token.ts` como **copia estructural** de
`src/methods/eip3009/abi.ts` (subset necesario: `FIAT_TOKEN_ABI`, `EIP3009_TYPES`,
`EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS`). Kite adapter importa **solo** de
`src/chains/abi/fiat-token.ts`. NO se agrega excepción `[3]` a OWNERS.md.

**Opciones evaluadas**:

- **Opción A — excepción OWNERS `[3]`**: chains puede importar utilities
  "spec-conformance" de methods/eip3009/. Rechazada: abre una pendiente
  resbaladiza (cualquier HU futura puede argumentar "es spec-conformance" para
  cruzar el boundary). El valor de OWNERS está en su rigidez; añadir excepciones
  ad-hoc diluye el contrato.
- **Opción B — duplicar ABI en `src/chains/abi/`** (elegida): mismo contenido,
  dos archivos. Trade-off explícito: mantener sincronía entre dos copias del
  ABI. Aceptable porque (a) el ABI de EIP-3009 `transferWithAuthorization` es
  **spec-fija** — no cambia sin un EIP nuevo; (b) es ≤ 20 líneas de metadata;
  (c) queda documentado como **TD-CHAINS-ABI-DUP** en BACKLOG para un refactor
  futuro que mueva el ABI canónico a `src/chains/abi/` y haga que
  `methods/eip3009/abi.ts` re-exporte desde allí (requiere HU propia).
- **Opción C — mover ABI a `src/core/` + importar desde ambos lados**.
  Rechazada: `core/` es method-agnostic por contrato de arquitectura
  (CHAIN-ADAPTIVE.md). Poner un ABI EIP-3009 en core viola esa invariante
  (¿dónde pondríamos el ABI de Permit2 en V1.5?).

**ABI duplication justification**:

- Es el **único** lugar del proyecto donde se permite duplicación de constantes.
- Documentado en el JSDoc del archivo nuevo: `// DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A`
- El work-item DT-1 ya contempla este trade-off; el SDD lo confirma.
- **TD-CHAINS-ABI-DUP** a crearse en `BACKLOG.md` durante Wave 3 (parte del
  scope) como tracker del refactor futuro.

### DT-B — `KITE_USDC_ADDRESS` resolution strategy (placeholder + env-late-resolution)

**Problema**: El address real de PYUSD/USDC en Kite Testnet no está confirmado
al momento de escribir este SDD. Se necesita un valor concreto para que tests y
`/supported` funcionen, pero no podemos bloquear F3 esperando confirmación
operativa.

**Decisión**: 3 capas de resolución, cada una unambigua:

1. **Schema Zod** (`src/infra/env.ts`): `KITE_USDC_ADDRESS` es requerida
   (formato `0x + 40 hex`) salvo en `NODE_ENV === 'test'` (via `superRefine`
   espejo del patrón actual de REDIS_URL). Los tests NO dependen del address
   real: usan un fixture local `TEST_TOKEN_ADDRESS`.
2. **`.env.example`**: placeholder literal `KITE_USDC_ADDRESS=0xPLACEHOLDER_KITE_TESTNET_USDC_REPLACE_BEFORE_DEPLOY`
   con comentario `# WFAC-50 — set to real PYUSD/USDC address before deploying to Railway; confirm in Kite Testnet docs`.
   El Dev NO reemplaza con una address real en F3 — es responsabilidad ops.
3. **F3 smoke manual (fuera de CI)**: después del merge, el humano confirma
   el address real y lo setea en Railway. No es parte del scope del Dev.

**Rechazadas**:

- Hardcodear el address en `kite.ts` (CD-2 explícito del work-item lo
  prohíbe).
- Hacer WebFetch al contract explorer: no hay endpoint documentado que
  devuelva canónicamente "el PYUSD/USDC de Kite testnet"; el Architect NO
  inventa addresses ni guessea sin verificación humana.

**Resultado**: F3 procede sin bloqueo; el placeholder falla *en deploy* (no en
tests) si no se reemplaza, lo cual es el fallo-fast correcto.

### DT-C — `verifyEip3009` NO es re-utilizable desde `src/chains/kite.ts` (DT-3 work-item resuelto)

**Decisión**: `_verifyRaw` **NO llama** a `verifyEip3009` (cross-boundary
prohibido). En cambio `_verifyRaw` implementa **solo los checks que el caller
aún no hizo**:

Arquitectura clave: en el flujo real (`src/core/verify.ts` → `adapter.verify`),
`src/core/verify.ts` **ya** ejecuta `verifyEip3009` del method-plugin **antes**
de llegar al adapter, porque el dispatch por `assetTransferMethod` vive en
core. Eso significa que cuando `_verifyRaw` de kite.ts corre, los checks de
shape, domain match, amount, receiver, timestamp, signature recovery **ya**
pasaron. El adapter sólo aporta on-chain-specific checks que el method no
puede hacer (no tiene RPC client).

**¿Qué hace `_verifyRaw` entonces?** Dado que el work-item AC-1..AC-6 lo
describe como "receives a well-formed VerifyParams", y `balanceOf` está
**Scope OUT**, el adapter real hace:

1. Validar que `accepted.network === 'eip155:2368'` (chainId de la metadata)
   — NETWORK_MISMATCH si no.
2. Validar que `accepted.asset` matchea `metadata.tokens[0].address` con
   `isAddressEqual` (case-insensitive) — NETWORK_MISMATCH si no.
3. Ejecutar `normalizeSignature(params.payload.signature)` — si falla,
   retornar `INVALID_SIGNATURE` (AC-6).
4. Ejecutar `recoverTypedDataAddress` con el domain construido localmente
   (**ver DT-D**) — si throw, capturar y retornar `INVALID_SIGNATURE` (AC-3).
5. Comparar `recovered` con `authorization.from` — si no match, `INVALID_SIGNATURE`
   (AC-3).
6. Validar `validBefore > nowSec` — si no, `EXPIRED_AUTHORIZATION` (AC-4).
7. Validar `BigInt(authorization.value) >= BigInt(accepted.amount)` — si no,
   `INVALID_AMOUNT` (AC-5).
8. Retornar `{ ok: true, verified: true, client: recovered, amount, asset, network, payTo, expiresAt: Number(validBefore) }`.

**Justificación**: duplicación **controlada** y **mínima** — el adapter vuelve
a hacer checks 2-7 del verify.ts para defensa en profundidad + para que el
adapter sea válido si en una HU futura se lo llama fuera del flujo de
`core/verify` (ej. tests unitarios directos como los actuales). No se duplica
la parte cara (Zod parsing de shapes) — se asume que si el params llega al
adapter, pasó Zod arriba.

La alternativa "confiar ciegamente que core/verify corrió primero y devolver
`{ ok: true }` sin checks" fue rechazada porque rompe el principio de
defensa-en-profundidad y haría fallar los tests existentes que llaman
`kiteTestnetAdapter.verify({} as never)`.

### DT-D — `buildEip3009Domain` also duplicated inline (minimal)

**Decisión**: implementar el domain build **inline** dentro de `_verifyRaw` y
`_settleRaw` con 4 líneas, **no** crear un archivo helper en `src/chains/abi/`.
El cuerpo es:

```ts
const domain = {
  name: token.eip712Name ?? token.name,
  version: token.eip712Version ?? '1',
  chainId: 2368, // from metadata
  verifyingContract: token.address,
};
```

**Justificación**: el domain build de `src/methods/eip3009/domain.ts` es una
función de 6 líneas + un fallback adicional `accepted.extra.name` que ya no
necesitamos a nivel adapter (core/verify ya validó los extras). Ponerlo en un
nuevo helper `src/chains/abi/domain.ts` añade superficie sin aportar
reutilización dentro de chains/. Cuando Avalanche WFAC-52 sume su propia
implementación real, si duplica las mismas 4 líneas entonces evaluamos extraer
a `src/chains/abi/domain.ts` en esa HU. YAGNI-friendly.

### DT-E — `settleEip3009` NO es re-utilizable — reimplementar inline (DT-4 work-item resuelto)

**Decisión**: `_settleRaw` implementa inline el mismo flujo que
`src/methods/eip3009/settle.ts` (simulate → write → receipt → status-check)
pero usando `FIAT_TOKEN_ABI` desde `src/chains/abi/fiat-token.ts`. No cruza
boundary. Duplicación justificada y sincronizada vía la regla explícita de
sincronía entre `src/methods/eip3009/abi.ts` y `src/chains/abi/fiat-token.ts`
(**CD-NEW-SDD-1** abajo).

**Trade-off aceptado**: si en el futuro se modifica el flujo settle
(ej. agregar balance-check pre-simulate, WFAC-55), hay 2 lugares a tocar:
`methods/eip3009/settle.ts` Y `chains/kite.ts` `_settleRaw` Y
`chains/avalanche.ts` `_settleRaw` (WFAC-52). La alternativa (bajar settleEip3009
a un helper compartible) requiere refactor del boundary (HU propia).

### DT-F — `src/infra/wallet.ts` como **account factory**, no client factory (DT-2 work-item refinado)

**Decisión**: `src/infra/wallet.ts` expone **una sola función**:

```ts
export function getOperatorAccount(): Account;
```

No recibe `privateKey` como argumento. Lee `OPERATOR_PRIVATE_KEY` de
`process.env` internamente, valida formato `/^0x[0-9a-fA-F]{64}$/`, y cachea
la `Account` devuelta por `privateKeyToAccount` en un module-level singleton
(lazy-init). La función falla fast con `ChainAdapterInitError` si la env var
falta o tiene formato inválido (AC-16).

**Por qué singleton**: `privateKeyToAccount` es relativamente caro (derivación
secp256k1); llamarlo una vez por boot y compartir la `Account` entre todas las
chain-adapters es lo correcto. Cada chain-adapter construye su propio
`WalletClient` con su `chain` específica e inyecta la misma `Account` en
`createWalletClient({ account: operatorAccount, chain, transport })`.

**Contratos**:

- **Read-only**: la función NO expone el private key ni el hex. Solo la
  `Account` (objeto viem con `.address`, `.signMessage`, etc.).
- **Throwing**: si la env var falta/malformed y `NODE_ENV !== 'test'`, throw
  sincrónico `ChainAdapterInitError('OPERATOR_PRIVATE_KEY', <chainId>)` (AC-16).
- **Test mode**: si `NODE_ENV === 'test'` y la env var no está, lanza igual
  (porque el caller es el adapter en constructor) — los tests **SÍ** deben
  setear `OPERATOR_PRIVATE_KEY` a una clave test-fija (Hardhat #0) en
  `beforeEach`. Patrón idéntico a `KITE_TESTNET_RPC_URL` hoy.
- **Reset**: para tests que necesiten re-cargar el módulo (cambios de env),
  `vi.resetModules()` + dynamic import (patrón ya usado en
  `chain-adapter.test.ts`).

**Función test-only export**: `resetOperatorAccountForTesting()` marcada con
JSDoc `@internal — tests only` que limpia el cache del singleton. Evita
cross-test contamination sin requerir `vi.resetModules()` en cada assertion.

### DT-G — `OPERATOR_PRIVATE_KEY` en `env.ts`: Zod schema + redact

**Decisión**: agregar al `EnvSchema`:

```ts
OPERATOR_PRIVATE_KEY: z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be 0x + 64 hex chars' })
  .optional(),

KITE_USDC_ADDRESS: z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be 0x + 40 hex chars' })
  .optional(),
```

Y extender el `superRefine` existente:

```ts
.superRefine((data, ctx) => {
  if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
    ctx.addIssue({ ..., path: ['REDIS_URL'], message: '...' });
  }
  if (!data.OPERATOR_PRIVATE_KEY && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPERATOR_PRIVATE_KEY'],
      message: 'OPERATOR_PRIVATE_KEY is required when NODE_ENV is not "test"',
    });
  }
  if (!data.KITE_USDC_ADDRESS && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KITE_USDC_ADDRESS'],
      message: 'KITE_USDC_ADDRESS is required when NODE_ENV is not "test"',
    });
  }
});
```

**Por qué `.optional()` + superRefine**: espejo exacto del pattern existente
para REDIS_URL. Permite que tests corran sin setear vars reales, pero
`parseEnv` en dev/prod falla fast con mensaje explícito (AC-16, AC-17). El
`regex` solo corre si el value está presente — eso es deseable (no queremos
que la ausencia de `OPERATOR_PRIVATE_KEY` reporte "regex mismatch", sino la
custom message del superRefine).

**Redact en logs**: agregar `OPERATOR_PRIVATE_KEY` y `SUPABASE_SERVICE_KEY` a
la lista de redact paths de Pino (si ya existe). Verificar
`src/infra/logger.ts` durante F3 — si no tiene redact paths, **no es scope
de esta HU agregarlos** (tracked como TD-SEC-03 si hace falta; el log de Pino
por defecto no loguea `process.env`). CD-1 cubre el código de aplicación:
prohibido logear `OPERATOR_PRIVATE_KEY` explícitamente.

### DT-H — `_settleRaw` re-usa la lógica exacta de `settleEip3009`, con 2 diferencias

**Decisión**: `_settleRaw` ejecuta exactamente el mismo pipeline que
`settleEip3009` (`methods/eip3009/settle.ts`), con dos diferencias:

1. **NO re-verifica** con `verifyEip3009` (cross-boundary prohibido). El paso
   1 de settleEip3009 (re-verify) se reemplaza por una **re-verificación
   local mínima** idéntica a DT-C — los mismos checks que hace `_verifyRaw`.
   Alternativamente, el adapter **confía** en que `core/settle.ts` ya llamó a
   `adapter.verify()` antes de `adapter.settle()`. Evaluar ambos:

   - **Opción 1**: skip re-verify; confiar en el caller. Riesgo:
     `adapter.settle` puede ser llamado en aislamiento (ej. tests futuros, o
     por una ruta que no hace verify primero). Defensa-en-profundidad floja.
   - **Opción 2 (elegida)**: re-ejecutar los checks mínimos de DT-C antes de
     simulate. Redundante cuando el flujo real corre, pero baratos
     (signature normalize + recover son μs; no RPC hasta simulate). Ganancia
     en robustez del adapter como unit aislado.

2. **ABI desde `src/chains/abi/fiat-token.ts`**, no desde methods/.

Todo lo demás (signature normalize reuse → simulate → write → waitForReceipt
→ status check → sanitize errors) es **copy-shape** exacto de
`settleEip3009`. La función `sanitize()` (max 200 chars) se duplica también
como helper module-local en `kite.ts` (4 líneas, no justifica exportar a
`chains/abi/`).

**AC-12 (`'receipt timeout'`) preservado**: comparación exacta `e.name ===
'WaitForTransactionReceiptTimeoutError'` replicando el pattern de
`methods/eip3009/settle.ts:123`.

### DT-I — Circuit-breaker integration no cambia (heredado WFAC-41)

**Decisión**: `_verifyRaw` y `_settleRaw` continúan siendo **privados** y
retornando `AdapterResult`. El outer `verify()`/`settle()` mantiene el wrap
`this._breaker.execute(lambda)` que convierte
`SIMULATION_FAILED`/`TRANSACTION_FAILED` en `BusinessFailureError` throw (ver
auto-blindaje WFAC-41 §fix-pack post-AR/CR). No se toca ese código. El único
cambio: los stubs dejan de existir y los métodos ahora pueden devolver
resultados reales (incluyendo, eventualmente, `SIMULATION_FAILED` o
`TRANSACTION_FAILED` reales que ahora sí harán trip el breaker — es el
comportamiento deseado).

AC-14 (CHAIN_UNAVAILABLE cuando breaker OPEN) ya está implementado vía el
outer wrapper — NO requiere código nuevo, solo **tests de regresión** para
confirmar que post-WFAC-50 sigue funcionando.

---

## 4. viem client setup pattern

### 4.1 PublicClient (reads)

Pattern ya establecido en `kite.ts:107-114` (sin cambios):

```ts
this._publicClient = createPublicClient({
  chain: this._viemChain,   // defineChain({ id: 2368, ... })
  transport: http(this._rpcUrl),
}) as PublicClient;
```

**Lazy init**: primera llamada a `getPublicClient()` crea el client. No se
toca el chain definition.

### 4.2 WalletClient (writes)

Pattern **modificado** en `getWalletClient()`:

```ts
// ANTES (stub, no firma):
this._walletClient = createWalletClient({
  chain: this._viemChain,
  transport: http(this._rpcUrl),
}) as WalletClient;

// DESPUÉS (WFAC-50):
import { getOperatorAccount } from '../infra/wallet.js';
// ^ infra import OK — chains/* puede importar infra (OWNERS no lo prohíbe;
//   la matriz solo lista infra como "SDK clients" sin contar src/chains/*
//   como prohibido consumidor. Ver sección 4.3 abajo).
// ACTUALIZACIÓN: OWNERS.md NO autoriza chains→infra explícitamente. Ver DT-J.

this._walletClient = createWalletClient({
  account: getOperatorAccount(),   // Account típo viem
  chain: this._viemChain,
  transport: http(this._rpcUrl),
}) as WalletClient;
```

### 4.3 DT-J — boundary `chains → infra`: autorizado explícitamente

**Problema nuevo detectado**: OWNERS.md matriz actual lista:

```
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, viem  | `src/core/*`, `src/methods/*`, ...
```

`src/infra/wallet.ts` no aparece en "Puede importar". **¿Violación?**

**Lectura precisa de OWNERS.md**: la columna "PROHIBIDO importar" lista
explícitamente `src/core/*`, `src/methods/*`, `src/routes/*`, otras chains.
**No lista `src/infra/*` como prohibido**. La columna "Puede importar"
tampoco lo incluye, pero las tablas de OWNERS siguen el principio
"whitelist con gaps permitidos por exclusión explícita" — los boundaries
son el listado de PROHIBIDOs.

**Decisión**: `chains → infra` es **permitido** por exclusión. Se documenta
explícitamente añadiendo **una línea a la matriz** como parte del Scope IN
(Wave 3):

```
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, `src/infra/wallet.ts` (para Account operator), viem  | ...
```

Razón semántica: `src/infra/*` provee "SDK clients" (la descripción ya dice
eso — viem/supabase/redis/pino). `wallet.ts` es exactamente eso: un wrapper
sobre `viem/accounts.privateKeyToAccount`. Tiene sentido arquitectónico que
chains pueda consumirlo — sería raro obligar a cada chain a re-crear la
`Account` desde env.

**Alternativa rechazada**: pasar la `Account` como argumento al constructor
de `KiteAdapter` desde `src/chains/registry.ts` (que sí podría importar
infra). Complejidad: el registry hoy exporta adapters como singletons
construidos en module-load-time (`export const kiteTestnetAdapter = new
KiteAdapter(...)`). Reescribir eso pendría una DI refactor propia. YAGNI.

**Nota**: CD-7 del work-item dice "Si el Architect determina que la solución
requiere cruzar un boundary, DEBE documentarlo como excepción explícita con
número `[N]` en OWNERS.md antes del merge." Este caso es un **refinamiento**
de la matriz (añadir una fila más explícita), no una excepción numerada —
porque `chains → infra` nunca estuvo prohibido. El Dev documenta en
OWNERS.md durante Wave 3.

---

## 5. Security — OPERATOR_PRIVATE_KEY handling

### 5.1 Validación

- Zod schema `EnvSchema.OPERATOR_PRIVATE_KEY`: `z.string().regex(/^0x[0-9a-fA-F]{64}$/)`
  (DT-G).
- `superRefine`: required si `NODE_ENV !== 'test'`.
- `src/infra/wallet.ts` valida de nuevo con el mismo regex al momento de
  cargar (defense-in-depth). Fails con `ChainAdapterInitError` si la env var
  existe pero cambió entre bootstrap y uso (teórico, cubre hot-reload).

### 5.2 Logs — PROHIBICIONES

- **CD-1 original WFAC-50**: PROHIBIDO logear `OPERATOR_PRIVATE_KEY` en
  cualquier nivel (debug, trace, error).
- **Implementación**: la función `sanitize(e)` que usa `_settleRaw` (replica
  de `methods/eip3009/settle.ts:43-46`) trunca a 200 chars:
  ```ts
  function sanitize(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.slice(0, 200);
  }
  ```
  El truncation protege contra viem errors que ocasionalmente embeben
  request data completo en el message. 200 chars típicamente NO cabe un hex
  de 132 chars + contexto, pero para garantizar, CD-2-NEW abajo añade un
  chequeo explícito.

- **CD-NEW-SDD-2** (refuerzo a CD-1): si un mensaje de error contiene el
  substring del `OPERATOR_PRIVATE_KEY` (detectado por sustring con el prefix
  `0x` de la key — imposible en práctica por entropía, pero tests podrían
  surfacearlo), `sanitize()` reemplaza por `[REDACTED]`. **Decisión
  práctica**: NO implementar un check así — es overengineering (la key es
  entropía secp256k1, no va a aparecer en un mensaje de viem por accidente).
  El truncation a 200 chars es suficiente. Lo anotamos para el Adversary
  Review que vaya a cuestionarlo: la defensa es **no-inclusion by design**
  (el private key nunca se le pasa a ningún logger; solo se usa como input
  a `privateKeyToAccount` y luego se descarta).

### 5.3 No-log tests

- Test AC-16: confirmar que al startup sin `OPERATOR_PRIVATE_KEY`, el mensaje
  de `ChainAdapterInitError` cita el nombre de la env var pero **no el valor**
  (obvio porque falta).
- Test CD-1-regression (no-log): `vi.spyOn(console, 'log')` durante una
  settle real mockeada; assert que ninguna call de `console.log` recibió un
  string que matchea `/^0x[0-9a-fA-F]{64}$/`. Es sanity guard.

---

## 6. Test Strategy — NO live RPC

### 6.1 Regla

CD-3 original: CI nunca hace llamadas reales a Kite Testnet RPC. Todo mockeado
con `vi.fn()` / `vi.spyOn()`.

### 6.2 Pattern de mock — 2 variantes

**Variante A (exemplar existente, `methods/eip3009/settle.test.ts:117-131`)** —
partial-mock del client:

```ts
function makeMockClients(): { publicClient: PublicClient; walletClient: WalletClient } {
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: <operatorAccount>,  // must be defined — AC-8 asserts it
    writeContract: vi.fn(),
    chain: <viemChain>,           // needed by viem type narrowing
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}
```

**Variante B** — `vi.spyOn(kiteTestnetAdapter, 'getPublicClient')` para
devolver el mock client. Útil cuando el adapter crea el client lazy y queremos
reemplazar-lo sin llamar al ctor. Patrón ya usado en
`chain-adapter.test.ts:283-290` para mockear `_verifyRaw`.

**Decisión SDD**: usar Variante A como default (más limpio, no toca privates).
Variante B sólo para tests que validen la *inyección* del account en el
WalletClient (AC-8).

### 6.3 Signature fixtures

Reutilizar Hardhat account #0 igual que `settle.test.ts:28-30`:

```ts
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
```

Los tests firman typed data con `privateKeyToAccount(TEST_PRIVATE_KEY).signTypedData({...})`
para producir signatures válidas que `recoverTypedDataAddress` pueda recuperar.

### 6.4 NODE_ENV en tests

`NODE_ENV=test` por defecto en vitest. En tests que toquen `src/infra/env.ts`
o `src/infra/wallet.ts`, setear `process.env['OPERATOR_PRIVATE_KEY'] =
TEST_PRIVATE_KEY` en `beforeEach` + `vi.resetModules()` para forzar reload
del singleton. Pattern existente en `chain-adapter.test.ts:38-48`.

---

## 7. Implementation Waves

Secuenciales — cada wave cierra con typecheck + lint + tests verdes.

### W0 — Foundations (serial)

**Entregables**:

- `src/chains/abi/fiat-token.ts` (nuevo)
  - Copia de `src/methods/eip3009/abi.ts` — exports: `FIAT_TOKEN_ABI`,
    `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS`.
  - JSDoc con `// DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A`.
- `src/infra/wallet.ts` (nuevo)
  - Export: `getOperatorAccount(): Account`, `resetOperatorAccountForTesting(): void`.
  - Singleton interno + regex validation + ChainAdapterInitError on missing.
- `src/infra/env.ts` (edit)
  - Agregar `OPERATOR_PRIVATE_KEY` (regex + optional) y `KITE_USDC_ADDRESS`
    (regex + optional) al EnvSchema.
  - Extender `superRefine` con los 2 nuevos checks `NODE_ENV !== 'test'`.
- `.env.example` (edit)
  - Añadir `KITE_USDC_ADDRESS=0xPLACEHOLDER_KITE_TESTNET_USDC_REPLACE_BEFORE_DEPLOY`
    + comentario.
  - Confirmar que `OPERATOR_PRIVATE_KEY` ya está (no duplicar).
- `OWNERS.md` (edit — parte de Wave 3 pero agendable aquí)
  - Ampliar la fila `src/chains/<chain>.ts`: "Puede importar" → añadir
    `src/infra/wallet.ts (para Account operator)`. Ver DT-J.
- Tests: extender `env.test.ts` con 4 tests nuevos (AC-16, AC-17 — 2 para
  OPERATOR_PRIVATE_KEY y 2 para KITE_USDC_ADDRESS: missing-in-prod y
  invalid-format).

**Criterio de cierre W0**: `npm run typecheck && npm run lint && npm test -- env`
verde.

### W1 — `_verifyRaw` real (serial, depende de W0)

**Entregables**:

- `src/chains/kite.ts` (edit)
  - Constructor: añadir parámetro `usdcAddress: Address` (readonly field).
    Inyectado desde el factory `new KiteAdapter({ ..., usdcAddress: <env> })`
    (los singletons exportados `kiteTestnetAdapter` y `kiteMainnetAdapter`
    leen `process.env.KITE_USDC_ADDRESS`).
  - Poblar `metadata.tokens` con un único `EIP3009Token`:
    ```ts
    tokens: [{
      address: this._usdcAddress,
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
      eip712Name: 'USD Coin',
      eip712Version: '2',
    }]
    ```
  - `_verifyRaw`: implementar los 8 pasos de DT-C.
  - Imports nuevos: `normalizeSignature`-like helper (ver nota abajo),
    `recoverTypedDataAddress`, `isAddressEqual`, `getAddress` desde viem;
    `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE` desde `./abi/fiat-token.js`.

**Sobre `normalizeSignature`**: está en `src/methods/eip3009/signature.ts`,
cross-boundary prohibido. **Decisión**: el adapter ejecuta una variante más
simple inline — solo el recover con el hex crudo envuelto en try/catch. El
rechazo de high-s / zero scalars **ya** lo hizo `verifyEip3009` en core
antes de llegar al adapter (DT-C confía en el caller para defensa
completa). AC-2 dice "the system SHALL first normalize the raw signature via
`normalizeSignature` (existing utility in `src/methods/eip3009/signature.ts`)
... matching the pattern already established in verify.ts". **Conflicto**:
AC-2 exige reuse explícito. Resolución: crear **`src/chains/abi/signature.ts`**
duplicando `normalizeSignature` (subset: solo la función, ~200 líneas), con
JSDoc `// DUPLICATED FROM src/methods/eip3009/signature.ts — WFAC-50 DT-K`.

### DT-K — `normalizeSignature` también se duplica (AC-2 forcing)

**Decisión**: agregar `src/chains/abi/signature.ts` como duplicate de
`src/methods/eip3009/signature.ts`. Se amplía la lista de archivos
duplicados (ABI + signature). La regla de sincronía (**CD-NEW-SDD-1**) cubre
ambos.

AC-2 es unambiguous: usa `normalizeSignature` **desde kite.ts**. No
podemos importarlo cross-boundary; la única opción es duplicar. Sí, es más
duplicación, pero es **controlada, documentada, y atada a spec** (EIP-2
malleability + EIP-2098 compact + legacy v).

**Alternativa evaluada y rechazada**: mover `src/methods/eip3009/signature.ts`
a `src/chains/abi/signature.ts` y hacer que methods/eip3009/signature.ts
re-exporte desde allí. Requiere refactor cruzado y afecta el boundary inverso
(`methods → chains/abi`). Aunque semánticamente razonable, introduce cambio en
methods/eip3009/* que **NO es Scope IN** — se deja para una HU futura que
mueva canónicamente el ABI y la signature utility.

**Retorno a W1 (continuación)**:

- `src/__tests__/unit/chain-adapter.test.ts` (edit, NO nuevo archivo)
  - Reemplazar/actualizar los tests existentes de verify/settle que
    assertean `WFAC-10/WFAC-11` (hoy líneas 92-110) con tests reales de los
    AC-1..AC-6.
  - Setear `KITE_USDC_ADDRESS` y `OPERATOR_PRIVATE_KEY` en `beforeEach`.

**Criterio de cierre W1**: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 passing; typecheck + lint verdes.

### W2 — `_settleRaw` real (serial, depende de W1)

**Entregables**:

- `src/chains/kite.ts` (edit)
  - `getWalletClient()`: inyectar `account: getOperatorAccount()` desde
    `src/infra/wallet.js` (DT-F).
  - `_settleRaw`: re-verify local (DT-H) + normalizeSignature + simulate +
    write + waitForReceipt + status-check, con `sanitize()` helper local.
- `src/__tests__/unit/chain-adapter.test.ts` (edit)
  - Añadir bloque `describe('WFAC-50 settle real')` con tests AC-7..AC-13,
    AC-15 (circuit breaker accounting).

**Criterio de cierre W2**: AC-7..AC-13 + AC-15 passing; typecheck + lint verdes.

### W3 — Tests restantes + OWNERS + BACKLOG + cleanup

**Entregables**:

- `src/__tests__/unit/chain-adapter.test.ts` (edit)
  - Tests restantes: AC-14 (breaker OPEN returns CHAIN_UNAVAILABLE — ya
    existe como T-ADAPT-CB-2 y T-ADAPT-CB-6; añadir check específico AC-14
    post-WFAC-50), AC-18 (metadata.tokens shape), AC-19 (no real RPC
    guard).
- `src/__tests__/unit/env.test.ts` (edit) — finalize AC-16, AC-17.
- `OWNERS.md` (edit)
  - Fila `src/chains/<chain>.ts` "Puede importar" → `src/infra/wallet.ts
    (para Account operator)` (DT-J).
- `BACKLOG.md` (edit)
  - Añadir entrada TD-CHAINS-ABI-DUP: "WFAC-50 introdujo duplicación de
    FIAT_TOKEN_ABI y normalizeSignature entre src/methods/eip3009/ y
    src/chains/abi/. Futuro refactor: mover canónicamente a src/chains/abi/
    y re-exportar desde methods. Owner: next chain impl (WFAC-52 Avalanche
    real). Severity: MAJ."
- `.env.example`: verificar placeholder está en orden.
- `doc/sdd/017-wfac-50-kite-testnet-adapter/auto-blindaje.md` (se escribe en
  F4 QA, no ahora).

**Criterio de cierre W3**: 19 ACs passing; full `npm run build && npm run
lint && npm test` verde.

---

## 8. Test Plan por AC

19 ACs → 19+ tests concretos. Todos en `src/__tests__/unit/chain-adapter.test.ts`
(o `env.test.ts` para AC-16/17).

| AC | Test ID | Qué valida | Archivo |
|----|---------|-----------|---------|
| AC-1 | T-V-HAPPY | verify con signature válida + domain correcto → `{ ok: true, verified: true, client: recovered }` | chain-adapter.test.ts |
| AC-2 | T-V-NORMALIZE | verify invoca `normalizeSignature` antes de recover; un high-s signature retorna INVALID_SIGNATURE sin llamar recover (spy en recoverTypedDataAddress) | chain-adapter.test.ts |
| AC-3 | T-V-SIG-MISMATCH | firma válida pero recover address ≠ `authorization.from` → `{ ok: false, code: INVALID_SIGNATURE, http: 401 }` | chain-adapter.test.ts |
| AC-4 | T-V-EXPIRED | `validBefore <= nowSec` → `{ ok: false, code: EXPIRED_AUTHORIZATION, http: 400 }` | chain-adapter.test.ts |
| AC-5 | T-V-AMOUNT | `authorization.value < accepted.amount` → INVALID_AMOUNT | chain-adapter.test.ts |
| AC-6 | T-V-NORMALIZE-FAIL | `normalizeSignature` retorna `{ ok: false }` (zero scalar) → INVALID_SIGNATURE, NO se llama recoverTypedDataAddress (spy) | chain-adapter.test.ts |
| AC-7 | T-S-HAPPY | settle full flow: simulate + write + receipt → `{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to, asset }` | chain-adapter.test.ts |
| AC-8 | T-S-ACCOUNT-INJECTED | walletClient.account !== undefined tras getOperatorAccount inyección; writeContract se llama con account definido | chain-adapter.test.ts |
| AC-9 | T-S-RESULT-SHAPE | `transactionHash` equals hash from writeContract; `blockNumber = Number(receipt.blockNumber)` | chain-adapter.test.ts |
| AC-10 | T-S-SIM-FAIL | `simulateContract` throws → `{ ok: false, code: SIMULATION_FAILED, http: 500 }`, message ≤ 200 chars | chain-adapter.test.ts |
| AC-11 | T-S-WRITE-FAIL | `writeContract` throws after successful sim → TRANSACTION_FAILED | chain-adapter.test.ts |
| AC-12 | T-S-TIMEOUT | `waitForTransactionReceipt` throws `WaitForTransactionReceiptTimeoutError` → TRANSACTION_FAILED with message `'receipt timeout'` | chain-adapter.test.ts |
| AC-13 | T-S-REVERTED | receipt.status === 'reverted' → TRANSACTION_FAILED with message `'transaction reverted on-chain'` | chain-adapter.test.ts |
| AC-14 | T-CB-OPEN | breaker in OPEN state → verify/settle return CHAIN_UNAVAILABLE 503 with retryAfterMs; `_verifyRaw`/`_settleRaw` never invoked (spy) | chain-adapter.test.ts |
| AC-15 | T-CB-ACCOUNTING | 1 call that returns SIMULATION_FAILED counts as exactly 1 breaker failure (inspect `_breaker` state increment) | chain-adapter.test.ts |
| AC-16 | T-ENV-OPERATOR-MISSING | parseEnv in prod without OPERATOR_PRIVATE_KEY → process.exit(1) + stderr contains "OPERATOR_PRIVATE_KEY" | env.test.ts |
| AC-17 | T-ENV-USDC-MISSING | parseEnv in prod without KITE_USDC_ADDRESS → process.exit(1) + stderr contains "KITE_USDC_ADDRESS" | env.test.ts |
| AC-18 | T-METADATA-TOKENS | `kiteTestnetAdapter.metadata.tokens` length 1, USDC shape + address matches KITE_USDC_ADDRESS | chain-adapter.test.ts |
| AC-19 | T-NO-RPC | during a full settle flow with mocks, NO fetch/http call escapes (assert `fetch` spy never called; `http` transport never hit) | chain-adapter.test.ts |

**Tests de regresión (CDs)**:

| CD | Test ID | Qué valida |
|----|---------|-----------|
| CD-1 | T-CD-1-NO-LOG-KEY | spy `console.log/info/error`; run settle; assert ningún call recibe un string matching `/^0x[0-9a-fA-F]{64}$/` |
| CD-2 | T-CD-2-NO-HARDCODE | grep estático via test: `src/chains/kite.ts` no contiene `0x[0-9a-fA-F]{40}` hardcoded (salvo en comments) |
| CD-3 | T-CD-3-MOCK-ONLY | ya cubierto por T-NO-RPC (AC-19) |
| CD-4 | T-CD-4-SIM-FIRST | simulate se llama ANTES de write (orden preservado — spy callOrder array como en settle.test.ts:138-154) |
| CD-5 | no-regression | N/A (no usamos z.coerce.boolean en esta HU) |
| CD-6 | T-CD-6-HASH-DIRECT | writeContract returns `0xAAA...`; result.transactionHash === `0xAAA...` (no transformation) |
| CD-7 | T-CD-7-OWNERS | OWNERS.md contains `src/infra/wallet.ts` as allowed import for chains (grep test) |

**Tests nuevos del SDD**:

| CD-NEW | Test ID | Qué valida |
|--------|---------|-----------|
| CD-NEW-SDD-1 | T-SDD-1-ABI-SYNC | runtime compare de `FIAT_TOKEN_ABI` en ambos archivos (methods + chains/abi) usando `JSON.stringify` — deben ser idénticos byte-for-byte |

**Total tests ≥ 19 ACs + 7 CDs = 26 casos**. Los existentes en
`chain-adapter.test.ts` que asertean el stub "NETWORK_MISMATCH / WFAC-10/11"
deben **eliminarse o actualizarse** (no left-over stub assertions).

---

## 9. Constraint Directives — heredadas + nuevas

### Heredadas del work-item (mantener)

- **CD-1**: PROHIBIDO logear `OPERATOR_PRIVATE_KEY`. (sec 5)
- **CD-2**: PROHIBIDO hardcodear `KITE_USDC_ADDRESS` en kite.ts. (sec 3 DT-B)
- **CD-3**: OBLIGATORIO mock viem en tests; PROHIBIDO RPC real en CI. (sec 6)
- **CD-4**: OBLIGATORIO `simulateContract` antes de `writeContract`. (sec 3 DT-H)
- **CD-5**: PROHIBIDO `z.coerce.boolean()` en EnvSchema. (sec 3 DT-G — cumplido, no usamos boolean nueva)
- **CD-6**: OBLIGATORIO `SettleResult.transactionHash` directo de `writeContract`. (sec 3 DT-H)
- **CD-7**: OBLIGATORIO mantener boundaries OWNERS o documentar excepción `[N]`. (sec 3 DT-A, DT-J)

### Nuevas agregadas por el SDD

- **CD-NEW-SDD-1 (Sincronía ABI/signature duplicados)**: cualquier modificación
  a `src/methods/eip3009/abi.ts` (FIAT_TOKEN_ABI, EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE, RECEIPT_TIMEOUT_MS) o a `src/methods/eip3009/signature.ts`
  (`normalizeSignature` + helpers) DEBE replicarse idénticamente en
  `src/chains/abi/fiat-token.ts` o `src/chains/abi/signature.ts` en el mismo PR.
  Test de regresión `T-SDD-1-ABI-SYNC` valida byte-equality. Violación = AR BLOQUEANTE.

- **CD-NEW-SDD-2 (No-hardcodes token en chains)**: PROHIBIDO construir un
  `EIP3009Token` con `address` literal `0x[0-9a-fA-F]{40}` en `src/chains/*.ts`
  que **no** sea un testnet con address público-estable documentado upstream
  (avalanche Fuji USDC está OK porque está en viem/chains docs). Kite
  testnet debe venir de env.

- **CD-NEW-SDD-3 (Lecciones auto-blindaje previas — AC-13 accounting)**: PROHIBIDO
  anidar llamadas a `_breaker.execute()` o `_breaker.recordBusinessFailure()`
  dentro de `_verifyRaw`/`_settleRaw`. Las fallas de negocio DEBEN surfacearse
  como `AdapterResult` discriminated union; el outer `verify()`/`settle()` las
  convierte en `BusinessFailureError` throw. **Referencia**: auto-blindaje
  WFAC-41 §fix-pack post-AR/CR AR-BLQ-ALTO-1. Test de regresión T-CB-ACCOUNTING
  (AC-15).

- **CD-NEW-SDD-4 (Lecciones auto-blindaje previas — Logger typing)**: si
  `src/infra/wallet.ts` recibe o expone un logger, DEBE usar `import type {
  Logger } from 'pino'` top-level (no inline `import('pino').Logger`), y DEBE
  castear `app.log` con `as unknown as Logger` cuando se lo pase desde código
  Fastify. **Referencia**: auto-blindaje WFAC-41 §`FastifyBaseLogger no es
  estructuralmente compatible con pino.Logger`. **En esta HU**: `wallet.ts` NO
  recibe logger (es pure singleton) — CD trivialmente satisfecho, pero si se
  extiende en V1.1 aplica.

- **CD-NEW-SDD-5 (Lecciones auto-blindaje previas — ESLint disable disciplina)**:
  cualquier uso de `process.env[<dynamic-name>]` en código nuevo (`wallet.ts`,
  `env.ts`) DEBE tener `// eslint-disable-next-line security/detect-object-injection`
  **solo** en la línea del acceso, NO a nivel función/clase. Comment del disable
  justifica por qué el name no es user-controlled. **Referencia**:
  auto-blindaje WFAC-41 §"unused eslint-disable directive".

- **CD-NEW-SDD-6 (Lecciones auto-blindaje previas — Test shape asumptions)**:
  tests que asserten estructura de strings devueltos por `sanitize()`, o por
  `buildX402Error`, DEBEN assertear sobre el substring/pattern, NO sobre el
  length exacto o matcheo exhaustivo. **Referencia**: auto-blindaje WFAC-33
  §"test assumption about idempotencyKey shape".

- **CD-NEW-SDD-7 (No-console)**: respetar el test existente `no-console.test.ts`
  — `src/chains/kite.ts`, `src/infra/wallet.ts`, `src/chains/abi/*.ts` NO
  pueden contener `console.log/info/warn/error`. Usar pino via el logger que
  se pase (o no loguear).

---

## 10. Anti-Hallucination Checklist

| Item | Verificado | Evidencia |
|------|-----------|-----------|
| `src/chains/kite.ts` existe y tiene `_verifyRaw`/`_settleRaw` como privados | ✅ | Read lines 180-236 |
| `src/chains/types.ts` tiene `ChainAdapterInitError` exportado | ✅ | Read lines 171-184 |
| `src/methods/eip3009/abi.ts` exporta `FIAT_TOKEN_ABI`, `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS` | ✅ | Read full file |
| `src/methods/eip3009/signature.ts` exporta `normalizeSignature` with shape `NormalizedSignature \| SignatureError` | ✅ | Read lines 48-59, 111 |
| `src/methods/eip3009/settle.ts` usa pattern simulate → write → waitForReceipt; tiene `sanitize()` helper | ✅ | Read lines 43-147 |
| `src/methods/eip3009/verify.ts` usa pattern `normalizeSignature → buildEip3009Domain → recoverTypedDataAddress` | ✅ | Read lines 40-210 |
| `src/chains/avalanche.ts` tiene `USDC_FUJI` hardcodeado (Scope OUT validado) | ✅ | Read lines 46-53 |
| `src/infra/env.ts` usa `superRefine` para conditional-required vars | ✅ | Read lines 63-71 |
| `OPERATOR_PRIVATE_KEY` ya está en `.env.example` | ✅ | Bash head .env.example |
| `src/infra/wallet.ts` NO existe aún | ✅ | ls src/infra/ → [env, logger, redis, shutdown, supabase] |
| `src/chains/abi/` carpeta NO existe aún | ✅ | assumed from ls output — confirmar en F3 |
| `CHAIN_UNAVAILABLE` está en `X402ErrorCode` + HTTP_BY_CODE | ✅ | Read core/errors.ts:57 |
| Test pattern `vi.fn() as unknown as PublicClient` es accepted | ✅ | Read settle.test.ts:117-131 |
| `viem` exporta: `createPublicClient`, `createWalletClient`, `http`, `defineChain`, `recoverTypedDataAddress`, `isAddressEqual`, `getAddress` | ✅ | Read verify.ts:25, settle.ts:29, kite.ts:21 — todos usados |
| `viem/accounts` exporta `privateKeyToAccount` | ✅ | settle.test.ts:14 |
| `WaitForTransactionReceiptTimeoutError` is a viem error with `.name === 'WaitForTransactionReceiptTimeoutError'` | ✅ | settle.ts:123 pattern |

---

## 11. Readiness Check

- [x] Todos los `[NEEDS CLARIFICATION]` del work-item resueltos o
      escalados explícitamente:
  - [x] DT-3 / DT-4 work-item → resueltos vía DT-C / DT-E / DT-H / DT-K
        (duplicación controlada + re-verify local).
  - [x] `KITE_USDC_ADDRESS` real → placeholder documentado DT-B (no bloquea F3).
  - [x] Balance check `balanceOf` → Scope OUT confirmado (no AC-20).
  - [x] DT-1 work-item (ABI duplication) → resuelto DT-A + DT-K (ampliado a signature).
- [x] Todos los archivos referenciados verificados con Read (ver sec 10).
- [x] Auto-blindaje de las 3 HUs previas leído (WFAC-33, WFAC-40, WFAC-41);
      lecciones destiladas como CD-NEW-SDD-3..-6.
- [x] Waves definidas con criterio de cierre explícito (sec 7).
- [x] Test plan por AC (19 + CDs) completo y trazeable (sec 8).
- [x] CDs heredadas + nuevas documentadas (sec 9).
- [x] Security posture explícita (sec 5).
- [x] Boundary OWNERS.md clarificación agendada (DT-J + Wave 3).
- [x] Tech debt nuevo trackeado: TD-CHAINS-ABI-DUP en BACKLOG Wave 3.

**SDD ready for SPEC_APPROVED.**

---

## 12. Próximos pasos

1. Humano revisa este SDD y aprueba con el gate exacto: `SPEC_APPROVED`
   (texto literal, sin equivalentes "dale"/"ok").
2. Tras `SPEC_APPROVED`, ejecutar `/nexus-p3-f2-5 WFAC-50` para generar el
   Story File (`story-file.md`) autocontenido — contrato para el Dev.
3. El Story File resultante es el único input del Dev en F3.
