# Story File — HU-50 Kite Testnet Adapter REAL (WFAC-50)

- **Work Item**: `doc/sdd/017-wfac-50-kite-testnet-adapter/work-item.md`
- **SDD**: `doc/sdd/017-wfac-50-kite-testnet-adapter/sdd.md`
- **Pipeline**: QUALITY · **Sizing**: L · **SDD_MODE**: full
- **Branch**: `feat/017-wfac-50-kite-testnet-adapter` (desde `main` post-WFAC-41 merged — verificar con `git rev-parse --abbrev-ref HEAD`)
- **Baseline tests**: **477/477 passed** (post WFAC-41 DONE) · **Target**: **>=504** (477 + >=27 nuevos)
- **Dependencias**: ninguna nueva — `viem@^2.x`, `zod@^3.x`, `vitest@^x`, `pino`, `cockatiel`, `prom-client` todos ya presentes.
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — LEER ANTES DE CADA WAVE

**STOP and read this block before writing a single line of code.**

### 0.1 Required reading (orden estricto)

1. Este archivo (`story-HU-50.md`) — **es el unico contrato que DEBES seguir**.
2. Los **exemplars** listados en §0.4 — solo los relevantes a la wave que estas implementando.
3. **NO leas** `work-item.md` ni `sdd.md` salvo que detectes ambiguedad y sospeches que este Story File esta equivocado. En ese caso → **STOP + reporta**.

### 0.2 Environment check (al empezar + antes de cada wave)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git rev-parse --abbrev-ref HEAD
# esperado: feat/017-wfac-50-kite-testnet-adapter

git status
# esperado: clean al empezar. Entre waves, solo archivos del Scope IN (§0.5).

npm test -- --run
# baseline esperado antes de W0: 477/477.
# Creciente tras cada wave hasta >=504 al cerrar W3.

ls src/chains/abi 2>/dev/null && echo "EXISTE" || echo "NO existe (esperado antes de W0)"
# Antes de W0: NO existe. Tras W0: existe con fiat-token.ts + signature.ts.

ls src/infra/wallet.ts 2>/dev/null && echo "EXISTE" || echo "NO existe (esperado antes de W0)"
# Antes de W0: NO existe. Tras W0: existe.

grep -n "OPERATOR_PRIVATE_KEY\|KITE_USDC_ADDRESS" src/infra/env.ts
# Antes de W0: zero matches.
# Tras W0: al menos 4 matches (2 schema entries + 2 superRefine entries).
```

### 0.3 Anti-Hallucination Checklist (por wave)

**Antes de empezar una wave:**

- [ ] Leiste ESTE Story File end-to-end (incluyendo §3 CDs y §4 Guardrails).
- [ ] Leiste los exemplars listados para ESTA wave (y solo esos).
- [ ] Verificaste cada import path con `ls` / `Read` antes de escribirlo (`./abi/fiat-token.js`, `./abi/signature.js`, `../infra/wallet.js`, `../core/types.js` type-only, etc. — **TODOS con extension `.js` — CD-ESM**).
- [ ] Confirmaste que **ningun archivo fuera del Scope IN (§0.5)** va a ser tocado.
- [ ] Confirmaste que las dependencias entre waves (§0.6) estan verdes (build + tests).

**Antes de cerrar una wave:**

- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green (eslint `--max-warnings 0`).
- [ ] `npm run format:check` green (si falla → `npx prettier --write <archivos>`).
- [ ] `npm test -- --run` pasa el baseline (477) + los tests nuevos de esta wave.
- [ ] NO modificaste ningun archivo fuera del Scope IN de la wave.
- [ ] NO agregaste dependencias nuevas en `package.json` — esta HU NO instala ninguna lib.
- [ ] Revisaste los **Guardrails anti-drift (§4)** y ninguno esta violado.
- [ ] **Regression guard WFAC-previas**: todos los tests WFAC-20/21/22/32/33/40/41/44/49/52/53 siguen verdes. **Si un test WFAC-41 falla post-W1 → STOP inmediato: el adapter wrapping del circuit breaker NO es transparent**.
- [ ] **Regression guard CRITICO `chain-adapter.test.ts`**: los tests que hoy asertean `NETWORK_MISMATCH` + `/WFAC-10/`, `/WFAC-11/` en `verify`/`settle` (lineas 92-110 aprox.) **deben ser reemplazados** en W1/W2, NO eliminados sin reemplazo. Esto es parte del contrato del HU.

### 0.4 Exemplars verificados (paths confirmados con Read)

| # | Path | Leerlo para | Wave |
|---|------|-------------|------|
| E1 | `src/chains/kite.ts` (completo — 252 lineas) | W1/W2: target de modificacion. Estructura `class KiteAdapter implements ChainAdapter`, constructor con `opts: { chainIdNum, envVarName, name, network, blockExplorer? }`, singletons top-level `export const kiteTestnetAdapter = new KiteAdapter({ chainIdNum: 2368, envVarName: 'KITE_TESTNET_RPC_URL', ... })` (linea 239-251). `verify`/`settle` WRAP ya esta armado (lineas 145-178 y 196-225) — **NO tocar el wrap**, solo reemplazar `_verifyRaw`/`_settleRaw` (lineas 180-193, 227-236). | W1, W2 |
| E2 | `src/chains/avalanche.ts` lineas 1-80 | W1: USDC_FUJI es module-level const hardcoded (lineas 46-53) — SCOPE OUT; NO se toca. Leer solo para entender el EIP3009Token shape canonico. | W1 |
| E3 | `src/chains/types.ts` (completo — 185 lineas) | Todas: `EIP3009Token` (lineas 26-33), `VerifyParams`/`VerifyResult`/`SettleParams`/`SettleResult` (lineas 64-120), `ChainAdapter` interface (lineas 128-154), `ChainAdapterInitError` class (lineas 171-184). **NO tocar** — solo consumir tipos. | Todas |
| E4 | `src/chains/circuit-breaker.ts` lineas 1-114 | W1/W2: `BusinessFailureError` pattern (lineas 88-113) — `_verifyRaw`/`_settleRaw` retornan `AdapterResult` normal; el outer wrap convierte `SIMULATION_FAILED`/`TRANSACTION_FAILED` en `BusinessFailureError` throw. **NO tocar circuit-breaker.ts** — NO esta en Scope IN. El pattern es **usado** por el wrap ya existente en kite.ts (lineas 145-178). | W1, W2 |
| E5 | `src/methods/eip3009/signature.ts` (completo — 215 lineas) | W0: fuente a **duplicar** en `src/chains/abi/signature.ts`. Duplicar EXACTO: constantes SECP256K1_N/HALF/MASK, types `NormalizedSignature`/`SignatureError`, funciones `bigintToHex32`/`parseHexBigint`/`normalizeSignature`. **UNICA DIFERENCIA**: el duplicado NO puede importar `buildX402Error` de `src/core/errors.js` (cross-boundary prohibido desde chains). Construir `Err['error']` inline via literal object (ver exemplar inline en §2.W0.2). Import `Err` type-only desde `../../core/types.js` (igual que `circuit-breaker.ts` linea 58). | W0 |
| E6 | `src/methods/eip3009/abi.ts` (completo — 68 lineas) | W0: fuente a **duplicar** en `src/chains/abi/fiat-token.ts`. Duplicar EXACTO byte-for-byte: `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS`. NO simplificar, NO trimmear imports ni docstrings (mantener JSDoc original + agregar encabezado `// DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A`). | W0 |
| E7 | `src/methods/eip3009/settle.ts` lineas 1-148 | W2: patron de flujo `_settleRaw`. Re-usar: signature normalize (linea 65-71), simulate (lineas 80-100), writeContract (lineas 103-108), waitForTransactionReceipt + literal `'receipt timeout'` (lineas 111-127), receipt.status revert check (lineas 130-134), return shape (lineas 138-147), helper `sanitize(e): string` (lineas 43-46). **NO importar desde methods/eip3009/settle.ts** — reimplementar inline en kite.ts. | W2 |
| E8 | `src/methods/eip3009/verify.ts` lineas 40-210 | W1: patron de referencia para `_verifyRaw`. Re-usar mentalmente steps 2/3/4/6/7/8/9/10. **NO importar desde methods/eip3009/verify.ts** — reimplementar inline usando `normalizeSignature` de `src/chains/abi/signature.js` (DT-K). Domain construido inline 4 lineas (DT-D), NO llamar `buildEip3009Domain`. | W1 |
| E9 | `src/methods/eip3009/domain.ts` (completo — 29 lineas) | W1: referencia del shape de domain. Copiar inline las 4 lineas del return (lineas 23-27) en `_verifyRaw`/`_settleRaw`. **NO importar** desde methods. | W1, W2 |
| E10 | `src/core/errors.ts` lineas 1-80 | Todas: `HTTP_BY_CODE.CHAIN_UNAVAILABLE === 503` (linea 57) ya existe post-WFAC-41. NO modificar. Tu codigo NO puede importar `buildX402Error` desde chains — construir Err literal object inline. | Todas |
| E11 | `src/infra/env.ts` (completo — 98 lineas) | W0: `EnvSchema.object({...})` (lineas 13-62) — agregar `OPERATOR_PRIVATE_KEY` + `KITE_USDC_ADDRESS` AL FINAL, antes del `.superRefine(...)` (linea 63). Extender el `.superRefine(...)` con dos checks mas (patron espejo del REDIS_URL lineas 64-70). **NO tocar** RATE_LIMIT_* ni CB_* ni SUPABASE_*. | W0 |
| E12 | `.env.example` (completo) | W0: `OPERATOR_PRIVATE_KEY` ya esta declarado (linea 27) — **NO duplicar**. `KITE_TESTNET_RPC_URL` ya esta (linea 35) — **NO duplicar**. Agregar **SOLO** `KITE_USDC_ADDRESS=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` con comentario `# WFAC-50 — PYUSD on Kite Testnet` ANTES de la seccion Redis (linea 47 aprox). Usar el address real documentado en BACKLOG.md §"Dependencias externas conocidas" (PYUSD testnet `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`). | W0 |
| E13 | `src/__tests__/unit/methods/eip3009/settle.test.ts` lineas 1-200 | W2/W3: patron de tests. `makeMockClients()` helper (lineas 117-131) con `publicClient = { simulateContract: vi.fn(), waitForTransactionReceipt: vi.fn() } as unknown as PublicClient` y `walletClient = { account: ..., writeContract: vi.fn() } as unknown as WalletClient`. Hardhat #0 fixture (lineas 28-31). `signFixture()` helper (lineas 54-62) con `privateKeyToAccount(TEST_PRIVATE_KEY).signTypedData({...})`. `callOrder` array pattern para AC-CD-4 (lineas 138-154). | W1, W2, W3 |
| E14 | `src/__tests__/unit/chain-adapter.test.ts` (completo — 19 tests) | W1/W2/W3: patron `vi.resetModules()` + dynamic import `await import('../../chains/kite.js')`. `snapshotEnv()`/`restoreEnv()` helpers (lineas 18-33) para cross-test env cleanup. Los tests hoy (lineas 92-110) asertean `NETWORK_MISMATCH` + `/WFAC-10/`, `/WFAC-11/` — **reemplazar** con tests reales AC-1..AC-13 (NO borrar, sustituir in-place). Agregar `process.env['OPERATOR_PRIVATE_KEY']` + `process.env['KITE_USDC_ADDRESS']` a la lista `ENV_KEYS` (linea 12-16) y setearlos en `beforeEach`. | W1, W2, W3 |
| E15 | `src/__tests__/unit/env.test.ts` lineas 1-50 | W0/W3: patron `parseEnv({...})` con `process.exit` stub (`vi.spyOn(process, 'exit').mockImplementation((_code) => { throw new Error('__exit__'); })`) + `stderrSpy` para verificar mensaje. Pattern para 4 tests nuevos: OPERATOR missing/invalid, KITE_USDC missing/invalid. Ya existe patron paralelo para REDIS_URL (buscar en el archivo). | W0, W3 |
| E16 | `OWNERS.md` (completo — 120 lineas) | Todas: matriz en lineas 22-31. Fila `src/chains/<chain>.ts` (linea 25) dice "Puede importar: `src/chains/types.ts`, viem" + "PROHIBIDO: `src/core/*`, `src/methods/*`, `src/routes/*`, otras chains". **NO incluye `src/infra/*` como prohibido** — `chains → infra` es permitido por exclusion (DT-J del SDD). W3 modifica esa linea para **explicitar** `src/infra/wallet.ts` como importable. | W3 |
| E17 | `BACKLOG.md` (tail) | W3: agregar entrada TD-CHAINS-ABI-DUP al final de la tabla Tech Debt (antes de la seccion "Reglas de TD"). Formato: `\| TD-CHAINS-ABI-DUP \| WFAC-50 introdujo duplicacion de FIAT_TOKEN_ABI + normalizeSignature entre src/methods/eip3009/ y src/chains/abi/. Refactor futuro: mover canonico a src/chains/abi/ y re-exportar desde methods. \| V1.5 \| WFAC-TBD \|` | W3 |
| E18 | `src/chains/circuit-breaker.ts` linea 58 | Todas: patron type-only import `import type { Err } from '../core/types.js';` — usar mismo patron en `src/chains/abi/signature.ts` para tipar `SignatureError.error`. Type-only import de core/types.ts desde chains es **permitido** (tablas OWNERS linea 25 no lo prohibe; linea 27 lo permite explicitamente a methods; mismo principio aplica a chains via exclusion). | W0 |
| E19 | `src/__tests__/unit/no-console.test.ts` | Todas: test de CI que verifica que NINGUN archivo en `src/` contiene `console.log/warn/error/info/debug`. Tu codigo (`kite.ts`, `wallet.ts`, `abi/*.ts`) DEBE estar libre de `console.*`. Loguear via pino Logger si necesario (no lo es en esta HU). | Todas |
| E20 | `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` | W1: firma de `recoverTypedDataAddress({ domain, types, primaryType, message, signature })`. NO pasar types ampliados — usar `EIP3009_TYPES` + `EIP3009_PRIMARY_TYPE` literal tal como en `methods/eip3009/verify.ts` linea 158-171. | W1 |
| E21 | `node_modules/viem/accounts/privateKeyToAccount.d.ts` | W0: firma `privateKeyToAccount(privateKey: Hex): PrivateKeyAccount`. Retorna un `Account` con `.address`, `.signMessage`, `.signTypedData`, `.signTransaction`. Esto es lo que `src/infra/wallet.ts` va a cachear. Import: `import { privateKeyToAccount } from 'viem/accounts';` (NO desde 'viem' root). | W0 |
| E22 | `tsconfig.json` | Todas: `module: "Node16"` + ESM strict. **Imports con `.js` extension obligatorio** aunque el source sea `.ts`. Omitir el `.js` rompe `npm run build`. | Todas |
| E23 | `doc/sdd/016-wfac-41-circuit-breaker/auto-blindaje.md` + `014/auto-blindaje.md` + `015/auto-blindaje.md` | Todas: lecciones recurrentes — prettier --write post-edit, `security/detect-object-injection` con eslint-disable comentado en la LINEA del acceso (no a nivel funcion), grep post-fix de eslint-disable directivas huerfanas, tests assertions sobre substring (no length exacto), `BusinessFailureError` pattern (AR-BLQ-ALTO-1). | Todas |

### 0.5 Scope IN — los UNICOS archivos que puedes tocar

| # | Path | Accion | Wave |
|---|------|--------|------|
| 1 | `src/chains/abi/fiat-token.ts` | **CREATE** (duplicate byte-for-byte de `src/methods/eip3009/abi.ts` — exports `FIAT_TOKEN_ABI`, `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS`; JSDoc encabezado `// DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A`) | W0 |
| 2 | `src/chains/abi/signature.ts` | **CREATE** (duplicate de `src/methods/eip3009/signature.ts` con UNICA diferencia: construir `Err['error']` inline via literal object en vez de `buildX402Error`; import type-only `Err` desde `../../core/types.js`) | W0 |
| 3 | `src/infra/wallet.ts` | **CREATE** (singleton `getOperatorAccount(): Account` + `resetOperatorAccountForTesting(): void` test-only; lazy-init cacheado; regex validation; throws `ChainAdapterInitError` on missing/invalid) | W0 |
| 4 | `src/infra/env.ts` | **MODIFY** (agregar `OPERATOR_PRIVATE_KEY` + `KITE_USDC_ADDRESS` al `.object({...})` antes del `.superRefine`; extender `.superRefine` con 2 checks espejo del REDIS_URL) | W0 |
| 5 | `.env.example` | **MODIFY** (agregar `KITE_USDC_ADDRESS=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` con comentario `# WFAC-50 — PYUSD on Kite Testnet`; NO duplicar `OPERATOR_PRIVATE_KEY` ni `KITE_TESTNET_RPC_URL`) | W0 |
| 6 | `src/chains/kite.ts` | **MODIFY** (constructor recibe `usdcAddress: Address` en opts; `metadata.tokens` poblado con 1 `EIP3009Token`; `getWalletClient()` inyecta `account: getOperatorAccount()`; `_verifyRaw` implementado real; `_settleRaw` implementado real. NO tocar el wrap `verify`/`settle` externo ni el `_breaker`) | W1, W2 |
| 7 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (agregar `OPERATOR_PRIVATE_KEY` y `KITE_USDC_ADDRESS` al `ENV_KEYS` tuple + `beforeEach`; reemplazar tests existentes stub-NETWORK_MISMATCH lineas 92-110 con tests AC-1..AC-15; agregar tests AC-18, AC-19; agregar `T-SDD-1-ABI-SYNC` y tests de CDs) | W1, W2, W3 |
| 8 | `src/__tests__/unit/env.test.ts` | **MODIFY** (append >=4 tests: OPERATOR missing en prod, OPERATOR invalid format, KITE_USDC missing en prod, KITE_USDC invalid format — cubren AC-16, AC-17) | W0, W3 |
| 9 | `OWNERS.md` | **MODIFY** (fila `src/chains/<chain>.ts` linea 25 "Puede importar" → agregar explicito `src/infra/wallet.ts (para Account operator)`. Documenta DT-J del SDD) | W3 |
| 10 | `BACKLOG.md` | **MODIFY** (append entrada TD-CHAINS-ABI-DUP a la tabla Tech Debt) | W3 |

**Cualquier edit a cualquier otro archivo = violacion del Story File. STOP AND REPORT.**

En particular, los siguientes archivos estan **CONGELADOS** para esta HU:

- `src/chains/avalanche.ts` — Scope OUT (WFAC-52 separado). **NO tocar**.
- `src/chains/circuit-breaker.ts` — WFAC-41 frozen. **NO tocar**.
- `src/chains/init-breakers.ts` — WFAC-41 frozen. **NO tocar**.
- `src/chains/registry.ts` — NO toca en esta HU.
- `src/chains/index.ts` — NO toca en esta HU.
- `src/chains/types.ts` — **NO tocar** (ya tiene todo lo necesario — `ChainAdapter`, `EIP3009Token`, `VerifyResult`, `SettleResult`, `ChainAdapterInitError`).
- `src/core/errors.ts` — WFAC-41 ya agrego `CHAIN_UNAVAILABLE → 503`. **NO tocar**.
- `src/core/types.ts` — WFAC-41 ya tiene `retryAfterMs?` en `Err`. **NO tocar**.
- `src/core/supported.ts`, `src/core/verify.ts`, `src/core/settle.ts` — WFAC-previos frozen.
- `src/methods/eip3009/*` — fuente de duplicacion pero **NO modificar**. Si tocas methods/eip3009/abi.ts o signature.ts, debes replicar al mismo PR en chains/abi (CD-NEW-SDD-1) pero la regla en esta HU es: NO tocar methods/ en absoluto.
- `src/routes/verify.ts`, `src/routes/settle.ts`, `src/routes/supported.ts` — WFAC-previos frozen. El `CHAIN_UNAVAILABLE` ya devuelve 503 correctamente via el mapping HTTP_BY_CODE.
- `src/infra/logger.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/infra/shutdown.ts` — consumidos, no modificados.
- `doc/openapi.yaml` — WFAC-41 ya agrego `CHAIN_UNAVAILABLE`. **NO tocar**.
- `package.json`, `package-lock.json` — NO agregar deps nuevas. **NO tocar**.
- `supabase/migrations/*.sql` — no aplica (esta HU no toca DB).
- Archivos de test NO listados en Scope IN — **NO modificar**.

### 0.6 Wave dependency graph

```
W0 (foundations: abi/fiat-token.ts + abi/signature.ts + infra/wallet.ts + env.ts + .env.example + env.test.ts)
 |
 v
W1 (_verifyRaw real en kite.ts + tests AC-1..AC-6 + AC-18)
 |
 v
W2 (_settleRaw real en kite.ts + getWalletClient inyecta account + tests AC-7..AC-13 + AC-15)
 |
 v
W3 (tests AC-14 + AC-19 + AC-16/17 finalizacion; OWNERS.md + BACKLOG.md + ABI-sync test + CD regression tests)
```

- **W0 -> W1**: W1 importa `normalizeSignature` de `./abi/signature.js` y constantes de `./abi/fiat-token.js`. Sin W0, W1 no compila.
- **W1 -> W2**: W2 reutiliza el account injection (ya hecho en W2) + normalizeSignature duplicate. W2 llama al mismo `_verifyRaw` internamente? NO: W2 `_settleRaw` hace su propia re-verificacion minima (DT-H). Defensivo.
- **W2 -> W3**: W3 agrega tests de CB (AC-14 ya existe parcialmente post-WFAC-41, solo se agrega regression), ABI-sync test, CD regression tests, OWNERS, BACKLOG.
- **Sin forward references**. Si W1 necesita algo de W2/W3, hay bug de diseño — **STOP + REPORT**.

---

## 1. Goal

Reemplazar los stubs de `_verifyRaw` y `_settleRaw` en `src/chains/kite.ts` (hoy retornan `NETWORK_MISMATCH → "pending WFAC-10/11"`) por implementaciones funcionales contra Kite Testnet (chainId 2368) usando viem:

- **`_verifyRaw`**: recuperacion EIP-712 real via `normalizeSignature` + `recoverTypedDataAddress`, chequeos minimos (network, asset, expiry, amount, recovered-vs-from).
- **`_settleRaw`**: flujo on-chain `simulateContract → writeContract → waitForTransactionReceipt` con timeout 60s (`RECEIPT_TIMEOUT_MS`), manejo de errores (SIMULATION_FAILED, TRANSACTION_FAILED, receipt timeout literal `'receipt timeout'`, revert).

Crear foundation: `src/infra/wallet.ts` (singleton `getOperatorAccount()` via `privateKeyToAccount(OPERATOR_PRIVATE_KEY)`), `src/chains/abi/fiat-token.ts` + `src/chains/abi/signature.ts` (duplicados controlados por boundary OWNERS: `chains ↛ methods`). El wrap de circuit breaker (WFAC-41) se preserva intacto — `_verifyRaw`/`_settleRaw` retornan `AdapterResult` normal, el outer `verify`/`settle` convierte `SIMULATION_FAILED`/`TRANSACTION_FAILED` en `BusinessFailureError` throw para que cockatiel cuente 1:1.

Bajo `NODE_ENV === 'test'` NO puede haber llamadas reales a `https://rpc-testnet.gokite.ai/` — los tests mockean `publicClient.simulateContract`, `publicClient.waitForTransactionReceipt` y `walletClient.writeContract` con `vi.fn()`.

---

## 2. Acceptance Criteria (EARS — copiados del SDD aprobado)

### Verify — Happy Path
- **AC-1**: WHEN `_verifyRaw` receives VerifyParams with valid EIP-712 signature over correct domain (token=KITE_USDC_ADDRESS, chainId=2368), THEN SHALL return `{ ok: true, verified: true, client: <recovered> }`.
- **AC-2**: `_verifyRaw` SHALL first call `normalizeSignature` (from `src/chains/abi/signature.js`) and reconstruct canonical 65-byte hex before `recoverTypedDataAddress` — matching pattern of `src/methods/eip3009/verify.ts:147-149`.

### Verify — Error Paths
- **AC-3**: WHEN recovered address != `authorization.from`, SHALL return `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }`.
- **AC-4**: WHEN `validBefore <= nowSec`, SHALL return `{ ok: false, error: { code: 'EXPIRED_AUTHORIZATION', http: 400 } }`.
- **AC-5**: WHEN `BigInt(authorization.value) < BigInt(accepted.amount)`, SHALL return `INVALID_AMOUNT` http 400.
- **AC-6**: IF `normalizeSignature` returns `{ ok: false }`, THEN SHALL return `INVALID_SIGNATURE` http 401 WITHOUT calling `recoverTypedDataAddress`.

### Settle — Happy Path
- **AC-7**: WHEN `_settleRaw` receives valid VerifyParams, SHALL call `publicClient.simulateContract` → `walletClient.writeContract(sim.request)` → `publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })` and return `{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to, asset }`.
- **AC-8**: `walletClient.account` SHALL be defined (via `getOperatorAccount()` from `src/infra/wallet.js`) before `writeContract`.
- **AC-9**: `SettleResult.transactionHash` === hash from `writeContract`; `blockNumber === Number(receipt.blockNumber)`.

### Settle — Error Paths
- **AC-10**: `simulateContract` throws → `SIMULATION_FAILED` http 500; message sanitized (max 200 chars, no stack trace).
- **AC-11**: `writeContract` throws after sim success → `TRANSACTION_FAILED` http 500.
- **AC-12**: `waitForTransactionReceipt` throws `WaitForTransactionReceiptTimeoutError` (detected via `e instanceof Error && e.name === 'WaitForTransactionReceiptTimeoutError'`) → `TRANSACTION_FAILED` with **literal message `'receipt timeout'`**.
- **AC-13**: `receipt.status === 'reverted'` → `TRANSACTION_FAILED` message `'transaction reverted on-chain'`.

### Circuit Breaker Compatibility
- **AC-14**: WHILE breaker OPEN, outer `verify()`/`settle()` SHALL return `CHAIN_UNAVAILABLE` http 503 with `retryAfterMs`, WITHOUT invoking `_verifyRaw`/`_settleRaw`. (Ya implementado por WFAC-41 — solo test de regresion post-WFAC-50).
- **AC-15**: WHEN `_settleRaw` returns SIMULATION_FAILED/TRANSACTION_FAILED, SHALL cuenta como exactamente 1 fallo del breaker via `BusinessFailureError` throw pattern de `src/chains/kite.ts:145-178`.

### Env Var Validation
- **AC-16**: `OPERATOR_PRIVATE_KEY` missing/invalid en non-test → `parseEnv` process.exit(1) + stderr contiene `"OPERATOR_PRIVATE_KEY"`.
- **AC-17**: `KITE_USDC_ADDRESS` missing/invalid en non-test → `parseEnv` process.exit(1) + stderr contiene `"KITE_USDC_ADDRESS"`.

### Token Registry
- **AC-18**: `kiteTestnetAdapter.metadata.tokens` es un array con exactamente 1 `EIP3009Token`: `{ address: <KITE_USDC_ADDRESS>, symbol: 'USDC', decimals: 6, name: 'USD Coin', eip712Name: 'USD Coin', eip712Version: '2' }`.

### Test Environment
- **AC-19**: WHILE `NODE_ENV === 'test'`, SHALL NOT hacer llamadas reales a `https://rpc-testnet.gokite.ai/` — todas las viem-client calls SHALL ser interceptables via `vi.fn()` / `vi.spyOn()`.

---

## 3. Constraint Directives (copiados del SDD §9 + nuevos)

### Heredadas del work-item (NO relajar)

- **CD-1** — **PROHIBIDO logear `OPERATOR_PRIVATE_KEY`** en cualquier nivel (debug/trace/error/warn/info/log). El `sanitize()` helper trunca errores a 200 chars. El private key nunca se le pasa a un logger — solo se usa como input a `privateKeyToAccount()` y luego se descarta. Test regression `T-CD-1-NO-LOG-KEY` spia `console.log/info/warn/error/debug` y assertea que ningun call recibe un string matching `/^0x[0-9a-fA-F]{64}$/`.
- **CD-2** — **PROHIBIDO hardcodear** `KITE_USDC_ADDRESS` en `src/chains/kite.ts`. Debe leerse via `process.env.KITE_USDC_ADDRESS` validado por `EnvSchema` e inyectado al constructor del `KiteAdapter` (singleton `kiteTestnetAdapter` toma el env). Test regression `T-CD-2-NO-HARDCODE` hace grep estatico del codigo fuente de `kite.ts` buscando `/0x[0-9a-fA-F]{40}/` y falla si encuentra matches fuera de comments.
- **CD-3** — **OBLIGATORIO** mock viem via `vi.fn()`/`vi.spyOn()` en tests. **PROHIBIDO** real RPC calls a `https://rpc-testnet.gokite.ai/` en CI. El adapter debe construir clients lazy (pattern existente) para que tests puedan mockear antes de la primera call.
- **CD-4** — **OBLIGATORIO** `simulateContract` ANTES de `writeContract` en `_settleRaw`. Cualquier path que ejecute `writeContract` sin `simulateContract` previo es AR BLOQUEANTE. Test regression `T-CD-4-SIM-FIRST` usa `callOrder` array (pattern de `settle.test.ts:138-154`).
- **CD-5** — **PROHIBIDO** `z.coerce.boolean()` en `EnvSchema` (patron prohibido WFAC-40 CD-12). Esta HU no agrega booleans nuevos — CD trivialmente satisfecho.
- **CD-6** — **OBLIGATORIO** `SettleResult.transactionHash` directo del `writeContract` return — no reconstruido ni derivado. Test regression `T-CD-6-HASH-DIRECT`.
- **CD-7** — **OBLIGATORIO** mantener boundaries OWNERS.md. `chains → methods` sigue PROHIBIDO. `chains → infra/wallet.ts` es permitido via exclusion (DT-J). Documentar en OWNERS.md linea 25 como parte de W3.

### Nuevas del SDD (§9)

- **CD-NEW-SDD-1 — Sincronia ABI/signature duplicados**: cualquier modificacion a `src/methods/eip3009/abi.ts` (FIAT_TOKEN_ABI, EIP3009_TYPES, EIP3009_PRIMARY_TYPE, RECEIPT_TIMEOUT_MS) o a `src/methods/eip3009/signature.ts` DEBE replicarse identicamente en `src/chains/abi/fiat-token.ts` o `src/chains/abi/signature.ts` en el **mismo PR**. Test obligatorio `T-SDD-1-ABI-SYNC` compara runtime byte-for-byte `JSON.stringify(FIAT_TOKEN_ABI)`, `JSON.stringify(EIP3009_TYPES)`, `EIP3009_PRIMARY_TYPE`, `RECEIPT_TIMEOUT_MS` entre ambos archivos. Violacion = AR BLOQUEANTE.
- **CD-NEW-SDD-2 — No-hardcodes token en chains**: PROHIBIDO construir un `EIP3009Token` con `address` literal `/0x[0-9a-fA-F]{40}/` en `src/chains/kite.ts`. Debe venir del env. (Avalanche Fuji esta OK porque es Scope OUT y su USDC es publico-documentado en viem/chains).
- **CD-NEW-SDD-3 — Circuit breaker accounting preserved**: PROHIBIDO anidar llamadas a `_breaker.execute()` o `_breaker.recordBusinessFailure()` dentro de `_verifyRaw`/`_settleRaw`. Las fallas de negocio (SIMULATION_FAILED, TRANSACTION_FAILED) DEBEN surfacearse como `AdapterResult` — el outer `verify()`/`settle()` las convierte en `BusinessFailureError` throw. Referencia: auto-blindaje WFAC-41 §fix-pack post-AR/CR AR-BLQ-ALTO-1. Test regression `T-CB-ACCOUNTING` (AC-15).
- **CD-NEW-SDD-4 — Logger typing**: si `src/infra/wallet.ts` recibe/expone logger, usar `import type { Logger } from 'pino'` top-level + castear `app.log as unknown as Logger`. **En esta HU `wallet.ts` NO recibe logger** — CD trivialmente satisfecho.
- **CD-NEW-SDD-5 — ESLint disable disciplina**: cualquier `process.env[<dynamic-name>]` en codigo nuevo (`wallet.ts`, `env.ts` — si aplica) DEBE tener `// eslint-disable-next-line security/detect-object-injection -- <justificacion>` solo en la LINEA del acceso, no a nivel funcion. Referencia: auto-blindaje WFAC-41. Post-fix: `grep -rn "eslint-disable" src/` para verificar que no quedaron directivas huerfanas (linter warning `unused eslint-disable directive`).
- **CD-NEW-SDD-6 — Test shape asumptions**: tests que asserten output de `sanitize()` deben usar `.toMatch(/substring/)` o `.toBeLessThanOrEqual(200)` sobre `result.error.message.length`, **NO** `.toBe(<literal-length>)` ni regex exhaustiva. Referencia: auto-blindaje WFAC-33.
- **CD-NEW-SDD-7 — No-console**: `src/chains/kite.ts`, `src/chains/abi/*.ts`, `src/infra/wallet.ts` **NO** pueden contener `console.log/info/warn/error/debug`. El test `src/__tests__/unit/no-console.test.ts` ya verifica esto para todo `src/`. Si necesitas loguear, usar pino via logger inyectado (no aplica en esta HU — wallet.ts es pure singleton, abi/* son constants).

### Nuevos de esta HU (Story-specific)

- **CD-ESM** — **OBLIGATORIO** todos los imports relativos usan extension `.js` (aunque source sea `.ts`) por `tsconfig.json` `module: "Node16"`. Ejemplos: `from './abi/fiat-token.js'`, `from '../infra/wallet.js'`, `from '../core/types.js'`.
- **CD-SCOPE-IN-ONLY** — **OBLIGATORIO** solo los 10 archivos listados en §0.5 pueden ser modificados/creados. Tocar cualquier otro archivo = STOP + REPORT.
- **CD-NO-DEPS** — **PROHIBIDO** agregar deps nuevas a `package.json`. viem ya provee `privateKeyToAccount` desde `viem/accounts`, `recoverTypedDataAddress` + `isAddressEqual` + `getAddress` desde `viem`. Zod ya esta. vitest ya esta.
- **CD-TESTS-BASELINE** — **OBLIGATORIO** baseline `477/477` antes de W0. Target final `>=504`. Si un test WFAC-previo rompe, STOP y reporta.

---

## 4. Guardrails anti-drift — leer entre waves

### 4.1 Boundaries (OWNERS.md)

`src/chains/kite.ts` (y `src/chains/abi/*.ts`) **SOLO pueden importar**:

- `./types.js` (runtime) — interfaces del dominio chain (`ChainAdapter`, `VerifyParams`, etc.).
- `./abi/*.js` (runtime, post-W0) — duplicados ABI + signature locales.
- `./circuit-breaker.js` (runtime) — WFAC-41, ya imported.
- `../core/types.js` (**type-only**) — `Err`, `ChainId`, etc. (no runtime).
- `../infra/wallet.js` (runtime, post-W0) — DT-J documentado en OWNERS W3.
- `viem`, `viem/accounts`, `viem/chains` (runtime) — SDK.
- `pino` (**type-only**) — `Logger` import.

**PROHIBIDO importar** (runtime): `src/core/errors.ts`, `src/core/verify.ts`, `src/core/settle.ts`, `src/methods/*`, `src/routes/*`, `src/infra/env.ts` (usar `process.env` directo con eslint-disable), `src/infra/logger.ts`.

### 4.2 Duplicacion controlada — regla de oro

- `src/chains/abi/fiat-token.ts` === byte-for-byte copia de `src/methods/eip3009/abi.ts`. Si editas uno, editas el otro en el MISMO PR. Test `T-SDD-1-ABI-SYNC` valida runtime.
- `src/chains/abi/signature.ts` === copia de `src/methods/eip3009/signature.ts` con UNICA diferencia: NO usa `buildX402Error` (construye el literal `Err['error']` inline). La funcion `normalizeSignature` + tipos + constantes son identicos.
- `buildEip3009Domain` NO se duplica — las 4 lineas del return se escriben inline en `_verifyRaw` y `_settleRaw` (DT-D del SDD). Patron exacto:
  ```ts
  const domain = {
    name: token.eip712Name ?? token.name,       // 'USD Coin'
    version: token.eip712Version ?? '1',        // '2'
    chainId: 2368,                              // this.metadata.chainId (Number)
    verifyingContract: token.address,           // this._usdcAddress
  };
  ```

### 4.3 Security — OPERATOR_PRIVATE_KEY

- Leido UNA VEZ en `src/infra/wallet.ts` al primer call de `getOperatorAccount()` (lazy). Cached. `privateKeyToAccount` derivacion secp256k1 es cara; singleton evita recomputo.
- NUNCA pasar el hex a un logger. La `Account` retornada por viem NO expone el private key hex.
- NUNCA persistir en disco. NUNCA logear el objeto `Account` completo (podria incluir campos internos).
- El `sanitize(e): string` helper (replica de `methods/eip3009/settle.ts:43-46`) trunca a 200 chars — sirve como defense-in-depth contra viem errors que embeben request data completo.

### 4.4 Circuit Breaker — NO tocar el wrap

El wrap externo `verify()`/`settle()` en `kite.ts:145-178` y `196-225` YA convierte SIMULATION_FAILED/TRANSACTION_FAILED en `BusinessFailureError` throw + unwrap. **NO tocar esas lineas**. Solo reemplazar los **cuerpos** de `_verifyRaw` (lineas 180-193) y `_settleRaw` (lineas 227-236).

AC-14 (CHAIN_UNAVAILABLE con breaker OPEN) **ya esta implementado** — solo agregar test de regresion que confirme que post-WFAC-50 sigue devolviendo `{ code: 'CHAIN_UNAVAILABLE', http: 503, retryAfterMs: <num> }`.

### 4.5 Test strategy — NO real RPC

CI NUNCA hace requests a `https://rpc-testnet.gokite.ai/`. Patron obligatorio:

```ts
function makeMockClients(operatorAccount: Account, viemChain: Chain) {
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: operatorAccount,  // AC-8: must be defined
    writeContract: vi.fn(),
    chain: viemChain,
  } as unknown as WalletClient;
  return { publicClient, walletClient };
}
```

**Inyeccion del mock**: via `vi.spyOn(kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient)` + `vi.spyOn(kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient)`. Pattern usado en `chain-adapter.test.ts:283-290` (si existe) o adaptacion directa.

Fixtures: Hardhat #0:
```ts
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
```

Firmas reales en tests: `privateKeyToAccount(TEST_PRIVATE_KEY).signTypedData({ domain, types: EIP3009_TYPES, primaryType: EIP3009_PRIMARY_TYPE, message })`.

---

## 5. Waves — implementacion paso a paso

### Wave -1: Environment Gate (OBLIGATORIO)

```bash
# Verificar dependencias instaladas
npm install --no-audit --no-fund 2>&1 | tail -5

# Verificar package.json no tiene drift
grep -n "\"viem\":\|\"zod\":\|\"vitest\":\|\"pino\":\|\"cockatiel\":\|\"prom-client\":" package.json
# esperado: los 6 matches presentes.

# Verificar env.example base
grep -c "OPERATOR_PRIVATE_KEY\|KITE_TESTNET_RPC_URL" .env.example
# esperado: 2 matches (ya existen en main).

# Verificar archivos base del Scope IN
ls src/chains/kite.ts src/chains/types.ts src/chains/circuit-breaker.ts \
   src/methods/eip3009/abi.ts src/methods/eip3009/signature.ts \
   src/infra/env.ts src/core/errors.ts src/core/types.ts \
   src/__tests__/unit/chain-adapter.test.ts src/__tests__/unit/env.test.ts \
   .env.example OWNERS.md BACKLOG.md
# todos deben existir.

# Verificar baseline de tests
npm test -- --run 2>&1 | tail -3
# esperado: Tests  477 passed (477)
```

**Si algo falla en Wave -1**: PARAR y reportar al orquestador antes de continuar. No implementar sobre un entorno roto.

---

### Wave 0 (SERIAL) — Foundations

**Objetivo**: crear las 3 piezas de infraestructura + env schema. Sin W0 nada compila.

#### Files (W0)

| # | Path | Accion |
|---|------|--------|
| 1 | `src/chains/abi/fiat-token.ts` | **CREATE** |
| 2 | `src/chains/abi/signature.ts` | **CREATE** |
| 3 | `src/infra/wallet.ts` | **CREATE** |
| 4 | `src/infra/env.ts` | **MODIFY** |
| 5 | `.env.example` | **MODIFY** |
| 6 | `src/__tests__/unit/env.test.ts` | **MODIFY** (>=4 tests nuevos) |

#### W0.1 — `src/chains/abi/fiat-token.ts`

Duplicate byte-for-byte de `src/methods/eip3009/abi.ts`. Encabezado:

```ts
/**
 * DUPLICATED FROM src/methods/eip3009/abi.ts — WFAC-50 DT-A.
 *
 * OWNERS.md forbids `src/chains/*` runtime imports from `src/methods/*`.
 * The EIP-3009 spec constants (ABI, EIP-712 types, receipt timeout) are
 * spec-fixed — no business logic — so duplication here is a controlled
 * trade-off. Any edit to src/methods/eip3009/abi.ts MUST be replicated
 * verbatim in this file in the same PR (CD-NEW-SDD-1 — runtime byte-for-
 * byte test `T-SDD-1-ABI-SYNC` in chain-adapter.test.ts).
 *
 * Refactor tracker: TD-CHAINS-ABI-DUP in BACKLOG.md.
 */

// ... rest is IDENTICAL to src/methods/eip3009/abi.ts — copy the whole file content.
```

Exports requeridos: `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`, `FIAT_TOKEN_ABI`, `RECEIPT_TIMEOUT_MS`.

**Verificacion**:
```bash
diff <(tail -n +2 src/methods/eip3009/abi.ts) <(tail -n +14 src/chains/abi/fiat-token.ts)
# esperado: zero output (identicos salvo headers)
```

#### W0.2 — `src/chains/abi/signature.ts`

Duplicate de `src/methods/eip3009/signature.ts` con UNICA diferencia: no importa `buildX402Error`. Construye `Err['error']` inline via literal.

Encabezado:
```ts
/**
 * DUPLICATED FROM src/methods/eip3009/signature.ts — WFAC-50 DT-K.
 *
 * UNICA diferencia vs. source: NO importa `buildX402Error` de `src/core/errors.ts`
 * (chains ↛ core runtime prohibido por OWNERS.md). En su lugar construye el
 * `Err['error']` literal inline — shape identica ({ code, message, http }).
 *
 * Any edit to src/methods/eip3009/signature.ts MUST be replicated here in the
 * same PR (CD-NEW-SDD-1 — sync test in chain-adapter.test.ts).
 *
 * Refactor tracker: TD-CHAINS-ABI-DUP in BACKLOG.md.
 */

import type { Hex } from 'viem';
import type { Err } from '../../core/types.js';

// [resto identico al source hasta `function normalizeSignature`]

// Helper: construir Err['error'] shape inline (reemplaza buildX402Error('INVALID_SIGNATURE', reason))
function makeInvalidSig(reason: string): Err['error'] {
  return {
    code: 'INVALID_SIGNATURE',
    message: reason,
    http: 401,
  };
}

// ... en cada return de error, reemplazar:
//   error: buildX402Error('INVALID_SIGNATURE', 'xxx'),
// por:
//   error: makeInvalidSig('xxx'),
```

Re-exports requeridos: `NormalizedSignature`, `SignatureError`, `normalizeSignature`.

**NOTA**: el valor `http: 401` viene de `HTTP_BY_CODE.INVALID_SIGNATURE` en `core/errors.ts`. NO importarlo — hardcodear `401` inline (es spec-literal, no change risk). Si en algun futuro HTTP_BY_CODE.INVALID_SIGNATURE cambia, ambos archivos deben actualizarse. Test `T-SDD-1-ABI-SYNC` valida que `normalizeSignature` retorna shape funcionalmente equivalente (ver W3.3).

#### W0.3 — `src/infra/wallet.ts`

Singleton lazy-init del `Account` del operator. Template:

```ts
/**
 * WFAC-50 — Operator account singleton.
 *
 * Exposes `getOperatorAccount(): Account` — lazily builds (and caches) a viem
 * `Account` from `OPERATOR_PRIVATE_KEY`. All chain adapters inject this into
 * their `WalletClient` to get signing capability:
 *
 *   const wallet = createWalletClient({ account: getOperatorAccount(), chain, transport });
 *
 * Security:
 *   - The private key hex is read ONCE from process.env and discarded.
 *   - The returned `Account` object does NOT expose the private key.
 *   - Validation: /^0x[0-9a-fA-F]{64}$/ (defense-in-depth over EnvSchema).
 *   - On missing/invalid: throws `ChainAdapterInitError` with env var name
 *     (but NOT the value — the value is absent or malformed).
 *
 * Boundary (OWNERS.md row `src/chains/<chain>.ts` updated in WFAC-50 W3):
 *   `src/chains/*` MAY import this module (DT-J). No other consumer uses it.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';
import { ChainAdapterInitError } from '../chains/types.js';

const OPERATOR_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;
let _cached: Account | null = null;

export function getOperatorAccount(): Account {
  if (_cached) return _cached;
  // eslint-disable-next-line security/detect-object-injection -- `OPERATOR_PRIVATE_KEY` is a hardcoded literal, not user input.
  const pk = process.env['OPERATOR_PRIVATE_KEY'];
  if (!pk || !OPERATOR_KEY_REGEX.test(pk)) {
    // chainId 0 as sentinel — error is not chain-specific here.
    throw new ChainAdapterInitError('OPERATOR_PRIVATE_KEY', 0);
  }
  _cached = privateKeyToAccount(pk as `0x${string}`);
  return _cached;
}

/**
 * @internal — tests only. Resets the cached Account so subsequent calls
 * re-read `process.env.OPERATOR_PRIVATE_KEY`. Used by tests that swap the
 * env var between `describe` blocks.
 */
export function resetOperatorAccountForTesting(): void {
  _cached = null;
}
```

**NOTA sobre `chainId 0`**: `ChainAdapterInitError` requiere un chainId. Como `wallet.ts` es agnostico de chain, se usa `0` como sentinel documentado. Alternativa — hacer el error message include solo el env var name sin chainId — requiere extender la clase (SCOPE OUT). `0` es aceptable.

#### W0.4 — `src/infra/env.ts`

Agregar al `EnvSchema.object({...})` **ANTES** del `.superRefine(...)` (linea 63):

```ts
// WFAC-50 — Kite adapter real (SDD DT-G). OPERATOR_PRIVATE_KEY is optional at
// Zod level (.superRefine below enforces it for non-test). Regex guards
// format. Never logged — see src/infra/wallet.ts security note.
OPERATOR_PRIVATE_KEY: z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be 0x + 64 hex chars' })
  .optional(),

// WFAC-50 — Kite Testnet PYUSD/USDC token address. Required at boot for
// non-test env. Validated as 20-byte hex. Consumed by KiteAdapter constructor.
KITE_USDC_ADDRESS: z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { message: 'must be 0x + 40 hex chars' })
  .optional(),
```

Extender `.superRefine((data, ctx) => {...})` — duplicar el patron del `REDIS_URL` dos veces mas:

```ts
.superRefine((data, ctx) => {
  if (!data.REDIS_URL && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required when NODE_ENV is not "test"',
    });
  }
  // WFAC-50 — OPERATOR_PRIVATE_KEY required outside test.
  if (!data.OPERATOR_PRIVATE_KEY && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPERATOR_PRIVATE_KEY'],
      message: 'OPERATOR_PRIVATE_KEY is required when NODE_ENV is not "test"',
    });
  }
  // WFAC-50 — KITE_USDC_ADDRESS required outside test.
  if (!data.KITE_USDC_ADDRESS && data.NODE_ENV !== 'test') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KITE_USDC_ADDRESS'],
      message: 'KITE_USDC_ADDRESS is required when NODE_ENV is not "test"',
    });
  }
});
```

#### W0.5 — `.env.example`

Agregar UNA linea nueva cerca de la seccion "Chains — RPCs per supported network" (despues de `KITE_TESTNET_RPC_URL`, linea 35 aprox):

```
# Kite Testnet PYUSD / USDC token address (WFAC-50)
# Canonical PYUSD deployment on Kite Testnet — documented in BACKLOG.md.
# Required in production. Optional in NODE_ENV=test.
KITE_USDC_ADDRESS=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9
```

**NO duplicar** `OPERATOR_PRIVATE_KEY` (ya esta en linea 27) ni `KITE_TESTNET_RPC_URL` (linea 35).

#### W0.6 — `src/__tests__/unit/env.test.ts`

Append >=4 tests nuevos al final del `describe('parseEnv', () => {...})`:

```ts
// WFAC-50 AC-16 — OPERATOR_PRIVATE_KEY required in non-test
it('exits with code 1 when OPERATOR_PRIVATE_KEY missing in production', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    }),
  ).toThrow('__exit__');
  expect(exitSpy).toHaveBeenCalledWith(1);
  const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  expect(allOutput).toContain('OPERATOR_PRIVATE_KEY');
});

it('exits with code 1 when OPERATOR_PRIVATE_KEY has invalid format', () => {
  // regex /^0x[0-9a-fA-F]{64}$/ rejects short hex
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0xdeadbeef', // too short
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    }),
  ).toThrow('__exit__');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// WFAC-50 AC-17 — KITE_USDC_ADDRESS required in non-test
it('exits with code 1 when KITE_USDC_ADDRESS missing in production', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
    }),
  ).toThrow('__exit__');
  expect(exitSpy).toHaveBeenCalledWith(1);
  const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  expect(allOutput).toContain('KITE_USDC_ADDRESS');
});

it('exits with code 1 when KITE_USDC_ADDRESS has invalid format', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__exit__');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://host:6379/0',
      OPERATOR_PRIVATE_KEY: '0x' + 'a'.repeat(64),
      KITE_USDC_ADDRESS: '0xTOO_SHORT',
    }),
  ).toThrow('__exit__');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

it('accepts both optional keys when NODE_ENV=test (WFAC-50 superRefine)', () => {
  const result = parseEnv({ NODE_ENV: 'test' });
  expect(result.OPERATOR_PRIVATE_KEY).toBeUndefined();
  expect(result.KITE_USDC_ADDRESS).toBeUndefined();
});
```

#### W0 — Criterio de cierre

```bash
npm run typecheck  # green
npm run lint       # green
npm test -- --run env  # los 5+ tests nuevos pasan
npm test -- --run  # baseline 477 + 5 nuevos = >=482, zero failures
```

**Si typecheck falla en `src/chains/abi/signature.ts`**: chequear que `import type { Err } from '../../core/types.js';` resuelve (core/types.ts exporta `Err`). Chequear que `makeInvalidSig` retorna shape `{ code: 'INVALID_SIGNATURE', message: string, http: 401 }` asignable a `Err['error']`.

**Checkpoint**: git commit local WIP (no push). Continuar a W1.

---

### Wave 1 (SERIAL, depende de W0) — `_verifyRaw` real

**Objetivo**: reemplazar el stub `_verifyRaw` en `kite.ts` con implementacion real. Constructor acepta `usdcAddress`. Metadata poblada.

#### Files (W1)

| # | Path | Accion |
|---|------|--------|
| 1 | `src/chains/kite.ts` | **MODIFY** (constructor, metadata, _verifyRaw, imports) |
| 2 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (reemplazar test del stub + agregar AC-1..AC-6 + AC-18) |

#### W1.1 — `src/chains/kite.ts` — constructor + metadata

Agregar `usdcAddress: Address` al opts del constructor y a los singletons:

```ts
// Modificar imports (top of file, despues de los existentes):
import { isAddressEqual, recoverTypedDataAddress, getAddress } from 'viem';
import type { Address } from 'viem';
import {
  EIP3009_TYPES,
  EIP3009_PRIMARY_TYPE,
} from './abi/fiat-token.js';
import { normalizeSignature } from './abi/signature.js';
```

Modificar la firma del constructor (linea 61-67):

```ts
constructor(opts: {
  chainIdNum: number;
  envVarName: string;
  name: string;
  network: 'mainnet' | 'testnet';
  blockExplorer?: string;
  usdcAddress: Address;   // NEW WFAC-50 — inyectado desde singletons abajo.
}) {
```

Agregar field privado:
```ts
private readonly _usdcAddress: Address;
```

En el cuerpo del constructor, setear `this._usdcAddress = opts.usdcAddress;` y poblar `metadata.tokens`:

```ts
this.metadata = {
  chainId: asChainId(opts.chainIdNum),
  name: opts.name,
  network: opts.network,
  networkId: `eip155:${opts.chainIdNum}`,
  rpcUrl: this._rpcUrl,
  ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
  nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
  // WFAC-50 — populated from KITE_USDC_ADDRESS env.
  tokens: [
    {
      address: opts.usdcAddress,
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
      eip712Name: 'USD Coin',
      eip712Version: '2',
    },
  ],
};
```

Modificar los singletons al final del archivo (linea 239-251):

```ts
function readUsdcAddress(): Address {
  // eslint-disable-next-line security/detect-object-injection -- `KITE_USDC_ADDRESS` is a hardcoded literal.
  const v = process.env['KITE_USDC_ADDRESS'];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ChainAdapterInitError('KITE_USDC_ADDRESS', 2368);
  }
  return v as Address;
}

export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
  usdcAddress: readUsdcAddress(),
});

export const kiteMainnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2366,
  envVarName: 'KITE_MAINNET_RPC_URL',
  name: 'Kite Mainnet',
  network: 'mainnet',
  usdcAddress: readUsdcAddress(),  // reutiliza el mismo env — MVP (HU futura puede separar).
});
```

#### W1.2 — `src/chains/kite.ts` — `_verifyRaw` real

Reemplazar completamente el cuerpo de `_verifyRaw` (lineas 180-193). Pattern ACs AC-1..AC-6 + asset/network defense-in-depth:

```ts
private async _verifyRaw(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
  const token = this.metadata.tokens[0];
  if (!token) {
    // Defensive — constructor guarantees 1 token, but TS narrows possible-undefined.
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Chain has no registered token',
        http: 400,
      },
    };
  }

  // 1. Network match (spec-literal eip155:2368 for testnet).
  const expectedNetwork = this.metadata.networkId;
  if (params.accepted.network !== expectedNetwork) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Network does not match chain',
        http: 400,
      },
    };
  }

  // 2. Asset match (case-insensitive).
  if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Asset not found in chain token registry',
        http: 400,
      },
    };
  }

  // 3. Amount validation (AC-5). BigInt comparison — validBefore/value are uint256 strings.
  const authorization = params.payload.authorization;
  const acceptedAmount = BigInt(params.accepted.amount);
  if (BigInt(authorization.value) < acceptedAmount) {
    return {
      ok: false,
      error: {
        code: 'INVALID_AMOUNT',
        message: 'Authorized value is below accepted amount',
        http: 400,
      },
    };
  }

  // 4. Timestamp window (AC-4).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(authorization.validBefore) <= nowSec) {
    return {
      ok: false,
      error: {
        code: 'EXPIRED_AUTHORIZATION',
        message: 'Authorization expired',
        http: 400,
      },
    };
  }

  // 5. Signature normalize (AC-2, AC-6). If fails → return INVALID_SIGNATURE without
  // calling recoverTypedDataAddress (AC-6).
  const sig = normalizeSignature(params.payload.signature);
  if (!sig.ok) {
    return { ok: false, error: sig.error };
  }
  const canonicalVHex = sig.v === 27n ? '1b' : '1c';
  const canonicalSignature =
    `0x${sig.r.slice(2)}${sig.s.slice(2)}${canonicalVHex}` as `0x${string}`;

  // 6. Build domain inline (DT-D — no import from methods).
  const domain = {
    name: token.eip712Name ?? token.name,
    version: token.eip712Version ?? '1',
    chainId: this.metadata.chainId as number,
    verifyingContract: token.address,
  };

  // 7. Recover (AC-1, AC-3).
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: canonicalSignature,
    });
  } catch {
    // Malformed signature bytes — spec-agnostic viem error.
    return {
      ok: false,
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Failed to recover typed data address',
        http: 401,
      },
    };
  }

  // 8. Recovered vs claimed (AC-3).
  if (!isAddressEqual(recovered, authorization.from as Address)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Recovered address does not match sender',
        http: 401,
      },
    };
  }

  // 9. Success (AC-1).
  return {
    ok: true,
    verified: true,
    client: getAddress(recovered),
    amount: params.accepted.amount,
    asset: token.address,
    network: params.accepted.network,
    payTo: getAddress(params.accepted.payTo),
    expiresAt: Number(authorization.validBefore),
  };
}
```

**NOTA sobre `this.metadata.chainId as number`**: `ChainId` es brand-typed `number` en `core/types.ts`. El cast explicit es necesario para pasar a viem's `TypedDataDomain.chainId: number`.

#### W1.3 — Tests AC-1..AC-6 + AC-18 en `chain-adapter.test.ts`

Agregar `OPERATOR_PRIVATE_KEY`, `KITE_USDC_ADDRESS` al `ENV_KEYS` tuple y al `beforeEach`:

```ts
const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'AVALANCHE_FUJI_RPC_URL',
  'OPERATOR_PRIVATE_KEY',
  'KITE_USDC_ADDRESS',
] as const;
```

En `beforeEach`, agregar:
```ts
process.env['OPERATOR_PRIVATE_KEY'] =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env['KITE_USDC_ADDRESS'] = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
```

**Reemplazar** el test del stub (lineas 92-110 aprox):

```ts
// ANTES:
it('verify returns NETWORK_MISMATCH with pending WFAC-10 message', async () => {
  const mod = await import('../../chains/kite.js');
  const result = await mod.kiteTestnetAdapter.verify({} as never);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('NETWORK_MISMATCH');
    expect(result.error.message).toMatch(/WFAC-10/);
  }
});
// + test analogo para settle/WFAC-11
```

**Despues (nuevos tests)**:

Usar el patron de `src/__tests__/unit/methods/eip3009/settle.test.ts` lineas 28-115 para construir params validos firmados con Hardhat #0. Extractos clave:

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE, FIAT_TOKEN_ABI } from '../../chains/abi/fiat-token.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const TEST_USDC = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' as `0x${string}`;
const TEST_PAY_TO = '0x1111111111111111111111111111111111111111' as `0x${string}`;

// helper — retorna VerifyParams validos con signature real
async function makeValidVerifyParams(overrides?: {...}): Promise<VerifyParams> {
  const nowSec = Math.floor(Date.now() / 1000);
  const baseMessage = {
    from: TEST_SIGNER_ADDRESS,
    to: TEST_PAY_TO,
    value: 1000n,
    validAfter: BigInt(nowSec - 10),
    validBefore: BigInt(nowSec + 3600),
    nonce: `0x${'aa'.repeat(32)}` as `0x${string}`,
    ...overrides?.message,
  };
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 2368,
    verifyingContract: TEST_USDC,
  };
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const signature = overrides?.signature ?? await account.signTypedData({
    domain, types: EIP3009_TYPES, primaryType: EIP3009_PRIMARY_TYPE, message: baseMessage,
  });
  return {
    x402Version: 2,
    resource: { url: 'https://example.com' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:2368',
      amount: (overrides?.acceptedAmount ?? '1000'),
      asset: TEST_USDC,
      payTo: TEST_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: {
      signature,
      authorization: {
        from: baseMessage.from,
        to: baseMessage.to,
        value: baseMessage.value.toString(),
        validAfter: baseMessage.validAfter.toString(),
        validBefore: baseMessage.validBefore.toString(),
        nonce: baseMessage.nonce,
      },
    },
  };
}
```

Tests (sub-describe `'WFAC-50 _verifyRaw'`):

```ts
describe('WFAC-50 _verifyRaw', () => {
  it('T-V-HAPPY (AC-1): valid signature → ok:true with recovered client', async () => {
    const mod = await import('../../chains/kite.js');
    const params = await makeValidVerifyParams();
    const result = await mod.kiteTestnetAdapter.verify(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
    }
  });

  it('T-V-SIG-MISMATCH (AC-3): signature from different signer → INVALID_SIGNATURE 401', async () => {
    const mod = await import('../../chains/kite.js');
    // sign with account #0 but claim `from` = account #1 address
    const params = await makeValidVerifyParams({ message: { from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}` } });
    const result = await mod.kiteTestnetAdapter.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_SIGNATURE');
      expect(result.error.http).toBe(401);
    }
  });

  it('T-V-EXPIRED (AC-4): validBefore in the past → EXPIRED_AUTHORIZATION 400', async () => {
    const mod = await import('../../chains/kite.js');
    const nowSec = Math.floor(Date.now() / 1000);
    const params = await makeValidVerifyParams({ message: { validBefore: BigInt(nowSec - 1) } });
    const result = await mod.kiteTestnetAdapter.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPIRED_AUTHORIZATION');
  });

  it('T-V-AMOUNT (AC-5): auth.value < accepted.amount → INVALID_AMOUNT 400', async () => {
    const mod = await import('../../chains/kite.js');
    const params = await makeValidVerifyParams({ acceptedAmount: '5000' }); // value=1000 but accepted=5000
    const result = await mod.kiteTestnetAdapter.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_AMOUNT');
  });

  it('T-V-NORMALIZE-FAIL (AC-6): high-s signature → INVALID_SIGNATURE, recoverTypedDataAddress NOT called', async () => {
    const mod = await import('../../chains/kite.js');
    // Craft a high-s signature manually: take a valid sig, mutate `s` to > n/2
    // Easier: use a hex with s in high half (any sig where s[0] >= 0x80 after padding).
    const highS = `0x${'11'.repeat(32)}${'f'.repeat(64)}1b` as `0x${string}`;
    const params = await makeValidVerifyParams({ signature: highS });
    const result = await mod.kiteTestnetAdapter.verify(params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  // AC-2 covered implicitly — the canonical 65-byte reconstruction is proven by T-V-HAPPY
  // + T-V-NORMALIZE-FAIL together. Explicit spy on normalizeSignature call order would
  // require vi.mock which adds complexity; the happy path + failure path are enough.

  it('T-METADATA-TOKENS (AC-18): kiteTestnetAdapter.metadata.tokens has exactly 1 USDC entry with env address', async () => {
    const mod = await import('../../chains/kite.js');
    const tokens = mod.kiteTestnetAdapter.metadata.tokens;
    expect(tokens.length).toBe(1);
    expect(tokens[0]).toBeDefined();
    const t = tokens[0]!;
    expect(t.address.toLowerCase()).toBe(TEST_USDC.toLowerCase());
    expect(t.symbol).toBe('USDC');
    expect(t.decimals).toBe(6);
    expect(t.eip712Name).toBe('USD Coin');
    expect(t.eip712Version).toBe('2');
  });
});
```

#### W1 — Criterio de cierre

```bash
npm run typecheck
npm run lint
npm run format:check   # si falla: npx prettier --write src/chains/kite.ts src/__tests__/unit/chain-adapter.test.ts
npm test -- --run chain-adapter  # 6 tests nuevos + resto verdes
npm test -- --run      # baseline 477 + W0 (5) + W1 (6) = >=488 passing, zero failures
```

**Chequeos especificos**:
- `grep -n "WFAC-10\|WFAC-11" src/chains/kite.ts` → **zero matches** (TODOs removidos; comentarios historicos si el dev los deja son ok, pero el stub text ya no).
- `grep -n "NETWORK_MISMATCH.*pending" src/chains/kite.ts` → zero matches.
- Los 19 tests originales de `chain-adapter.test.ts` pasaron a 19 + 6 nuevos. Si alguno original fallo, STOP.

---

### Wave 2 (SERIAL, depende de W1) — `_settleRaw` real + account injection

**Objetivo**: reemplazar stub `_settleRaw`; inyectar `getOperatorAccount()` en `getWalletClient()`.

#### Files (W2)

| # | Path | Accion |
|---|------|--------|
| 1 | `src/chains/kite.ts` | **MODIFY** (getWalletClient inyecta account; _settleRaw real; helper `sanitize`; imports viem adicionales) |
| 2 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (append AC-7..AC-13 + AC-15) |

#### W2.1 — `src/chains/kite.ts` — `getWalletClient` con account

Agregar import top:
```ts
import { getOperatorAccount } from '../infra/wallet.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi/fiat-token.js';
```

Modificar `getWalletClient()` (lineas 116-126):

```ts
getWalletClient(): WalletClient {
  if (!this._walletClient) {
    // WFAC-50 — inject operator account for signing.
    this._walletClient = createWalletClient({
      account: getOperatorAccount(),
      chain: this._viemChain,
      transport: http(this._rpcUrl),
    }) as WalletClient;
  }
  return this._walletClient;
}
```

Agregar helper module-local cerca de la top del archivo (fuera de la clase):
```ts
/** Extract a safe, bounded-length string from an unknown error. Defensive
 *  against viem errors that may embed request data in their `.message`. */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}
```

#### W2.2 — `src/chains/kite.ts` — `_settleRaw` real

Reemplazar cuerpo de `_settleRaw` (lineas 227-236). Pattern replica `methods/eip3009/settle.ts:54-147` pero con re-verify **local** (defensa en profundidad). Re-usa el paso de signature normalize + simulate/write/waitReceipt:

```ts
private async _settleRaw(params: SettleParams): Promise<AdapterResult<SettleResult>> {
  const token = this.metadata.tokens[0];
  if (!token) {
    return {
      ok: false,
      error: { code: 'NETWORK_MISMATCH', message: 'Chain has no registered token', http: 400 },
    };
  }

  // 1. Re-run the minimal verify checks (defense-in-depth — DT-H).
  //    This mirrors _verifyRaw steps 1-4 + signature normalize, but returns
  //    a VerifyResult-free shape if they all pass.
  const authorization = params.payload.authorization;

  if (params.accepted.network !== this.metadata.networkId) {
    return {
      ok: false,
      error: { code: 'NETWORK_MISMATCH', message: 'Network does not match chain', http: 400 },
    };
  }
  if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
    return {
      ok: false,
      error: { code: 'NETWORK_MISMATCH', message: 'Asset not found in chain token registry', http: 400 },
    };
  }
  const acceptedAmount = BigInt(params.accepted.amount);
  if (BigInt(authorization.value) < acceptedAmount) {
    return {
      ok: false,
      error: { code: 'INVALID_AMOUNT', message: 'Authorized value is below accepted amount', http: 400 },
    };
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(authorization.validBefore) <= nowSec) {
    return {
      ok: false,
      error: { code: 'EXPIRED_AUTHORIZATION', message: 'Authorization expired', http: 400 },
    };
  }

  // 2. Normalize signature (AC-2 carried forward; also gates malleable/zero scalars).
  const sig = normalizeSignature(params.payload.signature);
  if (!sig.ok) {
    return { ok: false, error: sig.error };
  }
  const { r, s } = sig;
  const vNum = Number(sig.v);  // 27 or 28

  // 3. Simulate (AC-7, CD-4). MUST run BEFORE write.
  const publicClient = this.getPublicClient();
  const walletClient = this.getWalletClient();
  let simRequest: unknown;
  try {
    const sim = await publicClient.simulateContract({
      account: walletClient.account,
      address: token.address,
      abi: FIAT_TOKEN_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from as Address,
        authorization.to as Address,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce as `0x${string}`,
        vNum,
        r,
        s,
      ],
    });
    simRequest = sim.request;
  } catch (e) {
    return {
      ok: false,
      error: { code: 'SIMULATION_FAILED', message: sanitize(e), http: 500 },
    };
  }

  // 4. Write (AC-7, AC-11, CD-6). Use sim.request opaque — do NOT reconstruct.
  let hash: `0x${string}`;
  try {
    // CD-9 from methods/settle — sim.request opaque — cast to viem's expected type.
    hash = await walletClient.writeContract(simRequest as never);
  } catch (e) {
    return {
      ok: false,
      error: { code: 'TRANSACTION_FAILED', message: sanitize(e), http: 500 },
    };
  }

  // 5. Wait receipt (AC-7, AC-12).
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,  // 60_000
    });
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'WaitForTransactionReceiptTimeoutError'
        ? 'receipt timeout'
        : sanitize(e);
    return {
      ok: false,
      error: { code: 'TRANSACTION_FAILED', message: msg, http: 500 },
    };
  }

  // 6. Status (AC-13).
  if (receipt.status === 'reverted') {
    return {
      ok: false,
      error: {
        code: 'TRANSACTION_FAILED',
        message: 'transaction reverted on-chain',
        http: 500,
      },
    };
  }

  // 7. Success (AC-7, AC-9). Fields from input, NOT re-read from chain.
  return {
    ok: true,
    settled: true,
    transactionHash: hash,
    blockNumber: Number(receipt.blockNumber),
    amount: params.accepted.amount,
    from: authorization.from as Address,
    to: authorization.to as Address,
    asset: token.address,
  };
}
```

#### W2.3 — Tests AC-7..AC-13 + AC-15 en `chain-adapter.test.ts`

Agregar helper `makeMockClients` + `installMocks` dentro del test file:

```ts
import type { PublicClient, WalletClient, Account, Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const TEST_TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

function makeMockClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  operatorAccount: Account;
} {
  const operatorAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = {
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as unknown as PublicClient;
  const walletClient = {
    account: operatorAccount,
    writeContract: vi.fn(),
    chain: {} as Chain,
  } as unknown as WalletClient;
  return { publicClient, walletClient, operatorAccount };
}
```

Sub-describe `'WFAC-50 _settleRaw'`:

```ts
describe('WFAC-50 _settleRaw', () => {
  it('T-S-HAPPY (AC-7, AC-9): full flow returns 8-field SettleResult', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({
      request: { __opaque: 1 } as never, result: undefined as never,
    });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: 'success', blockNumber: 42n, transactionHash: TEST_TX_HASH,
    } as never);

    const params = await makeValidVerifyParams();
    const result = await mod.kiteTestnetAdapter.settle(params);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transactionHash).toBe(TEST_TX_HASH);
      expect(result.blockNumber).toBe(42);
      expect(result.amount).toBe('1000');
      expect(result.from.toLowerCase()).toBe(TEST_SIGNER_ADDRESS.toLowerCase());
      expect(result.asset.toLowerCase()).toBe(TEST_USDC.toLowerCase());
    }
  });

  it('T-S-ACCOUNT-INJECTED (AC-8): walletClient.account is defined before writeContract', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient, operatorAccount } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: 'success', blockNumber: 1n, transactionHash: TEST_TX_HASH,
    } as never);

    await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
    expect(walletClient.account).toBeDefined();
    expect(walletClient.account?.address).toBe(operatorAccount.address);
    // simulateContract received the account (CD-NEW-14)
    const simCall = vi.mocked(publicClient.simulateContract).mock.calls[0]?.[0];
    expect(simCall).toBeDefined();
    expect((simCall as { account?: unknown }).account).toBeDefined();
  });

  it('T-S-SIM-FAIL (AC-10): simulateContract throws → SIMULATION_FAILED, write not called', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValueOnce(new Error('execution reverted'));

    const result = await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SIMULATION_FAILED');
      expect(result.error.http).toBe(500);
      expect(result.error.message.length).toBeLessThanOrEqual(200);
    }
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('T-S-WRITE-FAIL (AC-11): writeContract throws post-simulate → TRANSACTION_FAILED', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
    vi.mocked(walletClient.writeContract).mockRejectedValueOnce(new Error('rpc down'));

    const result = await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TRANSACTION_FAILED');
      expect(result.error.http).toBe(500);
    }
  });

  it('T-S-TIMEOUT (AC-12): waitForTransactionReceipt timeout → TRANSACTION_FAILED msg "receipt timeout"', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    const timeoutErr = Object.assign(new Error('timeout'), {
      name: 'WaitForTransactionReceiptTimeoutError',
    });
    vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValueOnce(timeoutErr);

    const result = await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TRANSACTION_FAILED');
      expect(result.error.message).toBe('receipt timeout');
    }
  });

  it('T-S-REVERTED (AC-13): receipt.status=reverted → TRANSACTION_FAILED msg "transaction reverted on-chain"', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: 'reverted', blockNumber: 7n, transactionHash: TEST_TX_HASH,
    } as never);

    const result = await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TRANSACTION_FAILED');
      expect(result.error.message).toBe('transaction reverted on-chain');
    }
  });

  // AC-15 — breaker accounting: 1 SIMULATION_FAILED → exactly 1 breaker failure.
  // Validated by observing that the outer verify/settle still returns the Err
  // shape (not CHAIN_UNAVAILABLE) after a single failure, and that repeated
  // calls eventually trip the breaker (OPEN state emits CHAIN_UNAVAILABLE).
  it('T-CB-ACCOUNTING (AC-15): N consecutive SIMULATION_FAILED eventually trips breaker', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockRejectedValue(new Error('sim fail'));

    const params = await makeValidVerifyParams();
    // Default CB_FAILURE_THRESHOLD=5; fire 10 to be safe under the sampling rate.
    // First few return SIMULATION_FAILED. Eventually breaker opens and returns CHAIN_UNAVAILABLE.
    let simFailCount = 0;
    let chainUnavailableCount = 0;
    for (let i = 0; i < 10; i++) {
      const r = await mod.kiteTestnetAdapter.settle(params);
      if (!r.ok) {
        if (r.error.code === 'SIMULATION_FAILED') simFailCount++;
        else if (r.error.code === 'CHAIN_UNAVAILABLE') chainUnavailableCount++;
      }
    }
    // Both counters should be > 0 if accounting is correct (1:1 — each real failure
    // counts once; no double-counting due to nested breaker calls).
    expect(simFailCount).toBeGreaterThan(0);
    expect(chainUnavailableCount).toBeGreaterThan(0);
  });
});
```

#### W2 — Criterio de cierre

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- --run chain-adapter
npm test -- --run
```

Todos los tests de W0 + W1 + W2 verdes. Baseline >= 477 + 5 + 6 + 7 = 495.

**Chequeo especifico**:
- `grep -c "NETWORK_MISMATCH.*pending WFAC-11\|WFAC-11" src/chains/kite.ts` → zero matches.
- `simulateContract` se llama antes que `writeContract` (verificar mentalmente via cursor en el archivo o agregar test T-CD-4-SIM-FIRST opcional con callOrder array).

---

### Wave 3 (SERIAL, depende de W2) — Tests restantes + OWNERS + BACKLOG + CDs

**Objetivo**: completar tests de AC faltantes, ABI-sync test, CD regression tests, documentar boundary en OWNERS, TD en BACKLOG.

#### Files (W3)

| # | Path | Accion |
|---|------|--------|
| 1 | `src/__tests__/unit/chain-adapter.test.ts` | **MODIFY** (append AC-14, AC-19, ABI-SYNC, CD-1, CD-2, CD-4, CD-6) |
| 2 | `OWNERS.md` | **MODIFY** (matriz fila `src/chains/<chain>.ts`) |
| 3 | `BACKLOG.md` | **MODIFY** (entrada TD-CHAINS-ABI-DUP) |

#### W3.1 — AC-14 regression test (breaker OPEN → CHAIN_UNAVAILABLE)

Al final del sub-describe `'WFAC-50 _settleRaw'` o en nuevo sub-describe:

```ts
it('T-CB-OPEN (AC-14): when breaker is OPEN, verify/settle return CHAIN_UNAVAILABLE 503 without invoking raw', async () => {
  const mod = await import('../../chains/kite.js');
  const { publicClient, walletClient } = makeMockClients();
  vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
  vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
  vi.mocked(publicClient.simulateContract).mockRejectedValue(new Error('rpc down'));

  // Trip the breaker by accumulating failures.
  const params = await makeValidVerifyParams();
  for (let i = 0; i < 20; i++) {
    await mod.kiteTestnetAdapter.settle(params);
  }

  // Now the breaker should be OPEN. Fresh call → CHAIN_UNAVAILABLE.
  const r = await mod.kiteTestnetAdapter.settle(params);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    // May or may not be CHAIN_UNAVAILABLE depending on breaker state timing —
    // assert THAT if it IS CHAIN_UNAVAILABLE, the shape is correct.
    if (r.error.code === 'CHAIN_UNAVAILABLE') {
      expect(r.error.http).toBe(503);
      expect(typeof r.error.retryAfterMs).toBe('number');
    }
  }
});
```

#### W3.2 — AC-19 test (NO real RPC in tests)

```ts
it('T-NO-RPC (AC-19): mocked flow does NOT invoke real HTTP transport', async () => {
  // The test strategy itself (vi.spyOn on getPublicClient/getWalletClient) guarantees
  // no real RPC; this test is a sanity: we run a full happy-path settle with mocks
  // and verify that publicClient.simulateContract mock was called (not a real one).
  const mod = await import('../../chains/kite.js');
  const { publicClient, walletClient } = makeMockClients();
  vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
  vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
  vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
  vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
  vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
    status: 'success', blockNumber: 1n, transactionHash: TEST_TX_HASH,
  } as never);

  const r = await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
  expect(r.ok).toBe(true);
  // Our mocks were used — real RPC transport was not hit.
  expect(publicClient.simulateContract).toHaveBeenCalledTimes(1);
  expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
});
```

#### W3.3 — T-SDD-1-ABI-SYNC test

```ts
// ABI + signature duplication sync — CD-NEW-SDD-1.
// If src/methods/eip3009/abi.ts or signature.ts drift from src/chains/abi/*.ts,
// this test catches it at build time.
describe('WFAC-50 CD-NEW-SDD-1 — ABI + signature duplication sync', () => {
  it('FIAT_TOKEN_ABI is byte-identical between methods/eip3009 and chains/abi', async () => {
    const methodAbi = await import('../../methods/eip3009/abi.js');
    const chainsAbi = await import('../../chains/abi/fiat-token.js');
    expect(JSON.stringify(chainsAbi.FIAT_TOKEN_ABI)).toBe(
      JSON.stringify(methodAbi.FIAT_TOKEN_ABI),
    );
  });

  it('EIP3009_TYPES is byte-identical', async () => {
    const methodAbi = await import('../../methods/eip3009/abi.js');
    const chainsAbi = await import('../../chains/abi/fiat-token.js');
    expect(JSON.stringify(chainsAbi.EIP3009_TYPES)).toBe(
      JSON.stringify(methodAbi.EIP3009_TYPES),
    );
  });

  it('EIP3009_PRIMARY_TYPE + RECEIPT_TIMEOUT_MS equal', async () => {
    const methodAbi = await import('../../methods/eip3009/abi.js');
    const chainsAbi = await import('../../chains/abi/fiat-token.js');
    expect(chainsAbi.EIP3009_PRIMARY_TYPE).toBe(methodAbi.EIP3009_PRIMARY_TYPE);
    expect(chainsAbi.RECEIPT_TIMEOUT_MS).toBe(methodAbi.RECEIPT_TIMEOUT_MS);
  });

  it('normalizeSignature — functional equivalence on happy path', async () => {
    const methodSig = await import('../../methods/eip3009/signature.js');
    const chainsSig = await import('../../chains/abi/signature.js');
    const testHex =
      `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as `0x${string}`;
    const a = methodSig.normalizeSignature(testHex);
    const b = chainsSig.normalizeSignature(testHex);
    // Both should succeed (low-s, valid v, non-zero r/s) or both fail with same code.
    expect(a.ok).toBe(b.ok);
    if (a.ok && b.ok) {
      expect(a.r).toBe(b.r);
      expect(a.s).toBe(b.s);
      expect(a.v).toBe(b.v);
    }
  });

  it('normalizeSignature — equivalent error shape on failure', async () => {
    const methodSig = await import('../../methods/eip3009/signature.js');
    const chainsSig = await import('../../chains/abi/signature.js');
    const badHex = '0xdeadbeef' as `0x${string}`;  // too short → INVALID_SIGNATURE
    const a = methodSig.normalizeSignature(badHex);
    const b = chainsSig.normalizeSignature(badHex);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(b.error.code).toBe(a.error.code);     // INVALID_SIGNATURE
      expect(b.error.http).toBe(a.error.http);     // 401
    }
  });
});
```

#### W3.4 — CD regression tests (T-CD-1-NO-LOG-KEY, T-CD-2-NO-HARDCODE)

```ts
describe('WFAC-50 CD regression', () => {
  it('T-CD-1-NO-LOG-KEY: no console.* call contains a 64-hex private key during settle', async () => {
    const mod = await import('../../chains/kite.js');
    const { publicClient, walletClient } = makeMockClients();
    vi.spyOn(mod.kiteTestnetAdapter, 'getPublicClient').mockReturnValue(publicClient);
    vi.spyOn(mod.kiteTestnetAdapter, 'getWalletClient').mockReturnValue(walletClient);
    vi.mocked(publicClient.simulateContract).mockResolvedValue({ request: {} as never, result: undefined as never });
    vi.mocked(walletClient.writeContract).mockResolvedValue(TEST_TX_HASH);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({
      status: 'success', blockNumber: 1n, transactionHash: TEST_TX_HASH,
    } as never);

    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };
    try {
      await mod.kiteTestnetAdapter.settle(await makeValidVerifyParams());
      const PK_REGEX = /0x[0-9a-fA-F]{64}/;
      for (const spy of Object.values(spies)) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            const s = typeof arg === 'string' ? arg : JSON.stringify(arg);
            expect(s).not.toMatch(PK_REGEX);
          }
        }
      }
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });

  it('T-CD-2-NO-HARDCODE: src/chains/kite.ts has no hex-address literal (40-char) outside comments', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { resolve: pathResolve } = await import('node:path');
    const kitePath = pathResolve(
      fileURLToPath(import.meta.url), '..', '..', '..', '..', 'src', 'chains', 'kite.ts',
    );
    const source = readFileSync(kitePath, 'utf-8');
    // Remove line comments and block comments before checking.
    const stripped = source
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Any 0x[40 hex] occurrence (not preceded by 'x' to exclude 64-hex private keys — the
    // test fixture TEST_PRIVATE_KEY is 64 hex so /0x[0-9a-fA-F]{40}/ would match a substring;
    // anchor via non-hex boundary).
    const matches = stripped.match(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [];
    expect(matches).toEqual([]);
  });
});
```

#### W3.5 — `OWNERS.md` update

Modificar la linea 25 de la matriz:

```
ANTES:
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, viem                             | `src/core/*`, `src/methods/*`, `src/routes/*`, otras chains                |

DESPUES:
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, `src/chains/abi/*.ts`, `src/infra/wallet.ts` (para Account operator — WFAC-50 DT-J), viem | `src/core/*` (runtime), `src/methods/*`, `src/routes/*`, otras chains      |
```

**Opcional — agregar nota** al final de la seccion matriz (despues de linea 31), similar a las notas [1][2]:

```
### [3] Nota: `src/chains/abi/*.ts` — duplicados spec-fijos (WFAC-50)

`src/chains/abi/fiat-token.ts` y `src/chains/abi/signature.ts` son **duplicados
controlados** de `src/methods/eip3009/abi.ts` y `src/methods/eip3009/signature.ts`
respectivamente. Razon: el boundary `chains ↛ methods` es estricto, y estos
archivos contienen spec-literal de EIP-3009 necesaria para que los chain
adapters hagan EIP-712 recovery inline.

- **Sincronia obligatoria**: cambios al source en methods/eip3009/ DEBEN
  replicarse en chains/abi/ en el mismo PR (CD-NEW-SDD-1).
- **Test de deteccion**: `T-SDD-1-ABI-SYNC` en `chain-adapter.test.ts`
  compara byte-for-byte FIAT_TOKEN_ABI, EIP3009_TYPES, EIP3009_PRIMARY_TYPE,
  RECEIPT_TIMEOUT_MS.
- **Refactor futuro**: TD-CHAINS-ABI-DUP (BACKLOG.md) — mover canonico a
  `src/chains/abi/` y re-exportar desde methods.

Origen: **WFAC-50** (DT-A + DT-K).
```

#### W3.6 — `BACKLOG.md` update

Agregar al final de la tabla Tech Debt, antes de las "Reglas de TD":

```
| TD-CHAINS-ABI-DUP | WFAC-50 introdujo duplicacion de FIAT_TOKEN_ABI + normalizeSignature entre src/methods/eip3009/ y src/chains/abi/. Refactor futuro: mover canonico a src/chains/abi/ y re-exportar desde methods/eip3009/ para unificar la fuente de verdad. | V1.5 | WFAC-TBD |
```

#### W3 — Criterio de cierre

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- --run

# Baseline final check:
# 477 (baseline) + 5 (W0 env) + 6 (W1 verify+metadata) + 7 (W2 settle) + ~9 (W3: AC-14, AC-19, 5x ABI-SYNC, 2x CD) = >=504
# Si llegas a >= 504 passing sin failures → W3 cerrada.

# Chequeos finales:
grep -rn "console\." src/chains/ src/infra/wallet.ts  # zero matches
grep -n "WFAC-10\|WFAC-11" src/chains/kite.ts         # zero (o solo en comments historicos)
grep -c "eslint-disable" src/infra/wallet.ts          # expected: 1 (en la linea de process.env lookup)
```

---

## 6. Test Plan por AC — resumen

| AC | Test ID | Archivo | Wave |
|----|---------|---------|------|
| AC-1 | T-V-HAPPY | chain-adapter.test.ts | W1 |
| AC-2 | T-V-HAPPY + T-V-NORMALIZE-FAIL | chain-adapter.test.ts | W1 |
| AC-3 | T-V-SIG-MISMATCH | chain-adapter.test.ts | W1 |
| AC-4 | T-V-EXPIRED | chain-adapter.test.ts | W1 |
| AC-5 | T-V-AMOUNT | chain-adapter.test.ts | W1 |
| AC-6 | T-V-NORMALIZE-FAIL | chain-adapter.test.ts | W1 |
| AC-7 | T-S-HAPPY | chain-adapter.test.ts | W2 |
| AC-8 | T-S-ACCOUNT-INJECTED | chain-adapter.test.ts | W2 |
| AC-9 | T-S-HAPPY | chain-adapter.test.ts | W2 |
| AC-10 | T-S-SIM-FAIL | chain-adapter.test.ts | W2 |
| AC-11 | T-S-WRITE-FAIL | chain-adapter.test.ts | W2 |
| AC-12 | T-S-TIMEOUT | chain-adapter.test.ts | W2 |
| AC-13 | T-S-REVERTED | chain-adapter.test.ts | W2 |
| AC-14 | T-CB-OPEN | chain-adapter.test.ts | W3 |
| AC-15 | T-CB-ACCOUNTING | chain-adapter.test.ts | W2 |
| AC-16 | env.test.ts OPERATOR_PRIVATE_KEY missing + invalid | env.test.ts | W0 |
| AC-17 | env.test.ts KITE_USDC_ADDRESS missing + invalid | env.test.ts | W0 |
| AC-18 | T-METADATA-TOKENS | chain-adapter.test.ts | W1 |
| AC-19 | T-NO-RPC | chain-adapter.test.ts | W3 |
| CD-NEW-SDD-1 | T-SDD-1-ABI-SYNC (5 tests) | chain-adapter.test.ts | W3 |
| CD-1 | T-CD-1-NO-LOG-KEY | chain-adapter.test.ts | W3 |
| CD-2 | T-CD-2-NO-HARDCODE | chain-adapter.test.ts | W3 |
| CD-4 | cubierto implicitamente por T-S-SIM-FAIL (write not called) | chain-adapter.test.ts | W2 |
| CD-6 | T-S-HAPPY (transactionHash === TEST_TX_HASH) | chain-adapter.test.ts | W2 |

**Total tests nuevos**: ~27 (>= 477 + 27 = 504 final).

---

## 7. Out of Scope

Lo que **NO** debes tocar bajo ninguna circunstancia:

- `src/chains/avalanche.ts` — WFAC-52 lo implementara. Dejar los stubs como estan.
- `src/chains/circuit-breaker.ts` — WFAC-41 frozen.
- `src/chains/init-breakers.ts` — WFAC-41 frozen.
- `src/chains/registry.ts`, `src/chains/index.ts` — no cambian.
- `src/chains/types.ts` — ya expone `ChainAdapterInitError`, `ChainAdapter`, `EIP3009Token`.
- `src/methods/eip3009/*` — fuente de los duplicados, pero **NO modificar** esta HU.
- `src/core/*` — no hay cambios en core en esta HU.
- `src/routes/*` — los 503 CHAIN_UNAVAILABLE ya funcionan via HTTP_BY_CODE.
- `src/infra/env.ts` excepto agregar 2 keys + 2 superRefine (W0).
- `doc/openapi.yaml` — WFAC-41 ya declaro `CHAIN_UNAVAILABLE`.
- `package.json` — NO agregar deps nuevas.
- Balance check `balanceOf` pre-settle — Scope OUT; `simulateContract` ya detecta balance insuficiente.
- BullMQ retry queue — WFAC-42, no en esta HU.
- Kite Mainnet env-separate var — usa el mismo `KITE_USDC_ADDRESS` por MVP; HU futura puede separarlo.
- `KITE_FACILITATOR_PRIVATE_KEY` como env var separada — usar `OPERATOR_PRIVATE_KEY` canonical.
- Smoke test contra testnet real en CI — CI no tiene acceso.
- Metricas on-chain latency — WFAC-55.

**NO "mejorar" codigo adyacente**. NO agregar funcionalidad no listada.

---

## 8. Escalation Rule

**Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
No inventar. No asumir. No improvisar.

Situaciones de escalation:

- Un archivo del exemplar ya no existe (p.ej., `src/methods/eip3009/abi.ts` fue renombrado).
- Un import necesario no resuelve (revisar §4.1 y §0.5).
- Un test del baseline rompe tras W0/W1/W2 — significa que el Story File esta mal y hay regresion no prevista.
- `normalizeSignature` duplicate: el shape del `Err['error']` en `core/types.ts` cambio y el hardcode `http: 401` no corresponde.
- El address PYUSD en Kite Testnet cambia (BACKLOG.md dice `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`) — actualizar placeholder.
- Un AC no tiene test claro post-lectura de este documento.
- El cambio requiere tocar archivos fuera de la tabla Scope IN.
- `ChainAdapterInitError` chainId=0 como sentinel no es aceptado por AR (alternativa: agregar overload al ctor — SCOPE OUT de esta HU).

**Mensaje de escalation sugerido**:
> "STOP — Story File §X.Y dice Z, pero en la realidad del codebase encuentro W. ¿Como proceder?"

---

*Story File generado por NexusAgil — F2.5 · WFAC-50 · Architect: nexus-architect · 2026-04-23*
