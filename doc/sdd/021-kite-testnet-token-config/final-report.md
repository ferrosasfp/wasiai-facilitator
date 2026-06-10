# Report — HU [WFAC-12] Kite testnet token metadata env-configurable

**Status:** DONE  
**Branch:** feat/021-wfac-12-kite-testnet-token-config  
**SDD Mode:** QUALITY  
**Date Closed:** 2026-06-10

---

## Resumen ejecutivo

WFAC-12 completó exitosamente la configuración env-driven de los 5 campos token/EIP-712 del adaptador **Kite Testnet** (symbol, name, decimals, eip712Name, eip712Version). La implementación introduce cero regresión: defaults PYUSD (byte-idénticos) cuando ninguna env var está presente, habilitando pieUSD (`0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368) sin tocar código. Todos los 7 ACs validados, 622 tests en verde, AR y CR aprobados, QA PASS. Listo para merge y prod deployment (próximos pasos: config env pieUSD, fondear relayer, e2e con Kite Agent Passport).

---

## Pipeline ejecutado

| Fase | Hito | Estado | Evidencia |
|------|------|--------|-----------|
| **F0** | Project context cargado (wasiai-facilitator QUALITY pipeline) | ✓ PASS | doc/sdd/021-kite-testnet-token-config/ / work-item.md · SDD.md |
| **F1** | Work Item + ACs (7 ACs EARS completos) | ✓ PASS | HU_APPROVED (gates del orquestador) |
| **F2** | SDD full (DT-2 resuelto: acceso literal directo) | ✓ PASS | SPEC_APPROVED |
| **F2.5** | Story File (anti-hallucination checklist, exemplars verificados) | ✓ PASS | story-WFAC-12.md |
| **F3** | Implementación 3 waves (W1: env+cableware, W2: tests, W3: .env.example) | ✓ PASS | 7 files modified; src/ cableado completo |
| **AR** | Adversarial Review (7/7 superficies verificadas) | ✓ **APROBADO** | money-moving (`src/chains/*`) sin regresiones; domain inline genérico |
| **CR** | Code Review (2 menores, cerrados en fix-pack) | ✓ **APROBADO CON MENORES** | override test cobertura, rename parámetro `decimals` → `tokenDecimals` |
| **F4** | QA + Validation (AC-1 a AC-7 evidenciados archivo:línea) | ✓ **PASS** | 622/622 tests verde, typecheck OK, lint OK; validación.md en artefactos finales |
| **DONE** | Reporte final · _INDEX.md actualizado | ✓ LISTO | Este report · entry 021 → DONE |

---

## Acceptance Criteria — resultado final

| AC | Estado | Evidencia |
|----|----|----------|
| **AC-1** (zero-regression defaults) | PASS | `kiteTestnetAdapter` sin env vars → symbol/name/eip712Name/decimals/version byte-idénticos PYUSD. Spread condicional en `kite.ts:156-170` aplica defaults del constructor cuando var ausente. Tests AC-5a (chain-adapter.test.ts) verde sin modificar fixtures PYUSD. |
| **AC-2** (override por env) | PASS | Env vars `KITE_TESTNET_TOKEN_*` presentes → constructor recibe los opts y usa sus valores en lugar de defaults. Test AC-5b (chain-adapter.test.ts) setea vars `pieUSD`/`18`/`pieUSD`/`'1'` → adapter refleja token correcto. |
| **AC-3** (dominio EIP-712 en verify/settle genérico) | PASS | `base-adapter.ts:309-315` (_verifyRaw) lee `token.eip712Name ?? token.name` y `token.eip712Version ?? '1'` genéricamente (sin hardcodes PYUSD). El domain se reconstruye con los valores configurados. No requiere cambio de código base-adapter. |
| **AC-4** (DOMAIN_SEPARATOR pieUSD verificado) | PASS | Calculado localmente: `viem.domainSeparator({ name:'pieUSD', version:'1', chainId:2368, verifyingContract:'0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A' })` = `0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182`. On-chain verificado (match). Boot-check `initDomainCheck` falla si diverge (defensa existente). |
| **AC-5a** (tests: sin env → defaults) | PASS | chain-adapter.test.ts: sin vars nuevas → tokens[0].symbol==='PYUSD', decimals===18, name==='PYUSD', eip712Name==='PYUSD', version==='1'. |
| **AC-5b** (tests: con env → overrides) | PASS | chain-adapter.test.ts: setear vars a pieUSD → tokens[0] refleja pieUSD metadata. |
| **AC-5c** (tests: decimals inválido → exit) | PASS | env.test.ts: KITE_TESTNET_TOKEN_DECIMALS='abc' o '-1' → parseEnv lanza exit(1) + stderr menciona var. spy exit + spy stderr confirman. |
| **AC-5d** (tests: mainnet intacto) | PASS | chain-adapter.test.ts:196-208 (existente): kiteMainnetAdapter sigue con USDC.e/6/'USD Coin'/'2'. Sin regresión. |
| **AC-6** (validación EnvSchema decimals) | PASS | env.ts:95: `KITE_TESTNET_TOKEN_DECIMALS: z.coerce.number().int().min(0).optional()`. Valida entero ≥0; inválido → parseEnv exit(1). |
| **AC-7** (.env.example documentado) | PASS | .env.example:103-112: bloque comentado con 5 vars, defaults PYUSD explicados, ejemplos pieUSD comentados incluyendo DOMAIN_SEPARATOR verificado. |

---

## Archivos modificados (git diff)

| Archivo | Cambio | Líneas | Razón |
|---------|--------|--------|-------|
| `src/infra/env.ts` | + 5 vars opcionales EnvSchema | +10 (líneas 88-97) | KITE_TESTNET_TOKEN_SYMBOL/NAME/DECIMALS/EIP712_NAME/EIP712_VERSION con tipos exactos Zod |
| `src/chains/kite.ts` | Cableado spread condicional testnet | +15 (líneas 144-170) | Lectura literal de 5 vars en kiteTestnetAdapter; spread condicional preserva defaults PYUSD |
| `.env.example` | Bloque comentado pieUSD | +10 (líneas 103-112) | Documentación env vars (defaults PYUSD + ejemplos pieUSD con DOMAIN_SEPARATOR) |
| `src/__tests__/unit/env.test.ts` | Tests AC-5c / AC-6 (decimals inválido) | +25 | Dos casos: 'abc' y '-1' → exit(1) + stderr spy |
| `src/__tests__/unit/chain-adapter.test.ts` | Tests AC-5a/b/d (override, defaults, mainnet) | +45 | Tres test cases: sin env, con env pieUSD, mainnet intacto |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` | Test AC-4 (fake adapter pieUSD) | +20 | Fake adapter con eip712Name:'pieUSD' → boot-check OK |
| `doc/sdd/_INDEX.md` | Entry 021 status DONE | +0 (update in-place) | Fila WFAC-12 → status DONE, branch feat/021-... |

**Total:** 7 files modified, ~125 líneas de código + tests + docs, 0 files deleted.

---

## Gates completados

### Adversarial Review (AR) — 7/7 verificaciones OK

1. **Money-moving surface (`src/chains/kite.ts`)**: spread condicional no introduce regresiones; acceso literal a process.env (no bracket dinámico, CD-5 cumplido).
2. **EIP-712 domain inline (`base-adapter.ts:309-315`)**: lee `token.eip712Name ?? token.name` genéricamente (sin hardcodes PYUSD). Verificado que no se regresionó.
3. **EnvSchema PROHIBIDO superRefine**: las 5 vars opcionales NO van al `.superRefine` (CD-AB-1 cumplido); fixtures prod-success no rotas.
4. **Tipos Zod exactos**: 4 strings `.min(1).optional()`, decimals `z.coerce.number().int().min(0).optional()` (DT-3 cumplido).
5. **Acceso literal vs bracket**: `process.env.KITE_TESTNET_TOKEN_SYMBOL` (literal) NO dispara eslint-plugin-security/detect-object-injection (CD-AB-2 cumplido, no eslint-disable innecesario).
6. **DOMAIN_SEPARATOR pieUSD**: calculado vía viem = on-chain, MATCH verificado (AC-4, §4.3 SDD).
7. **Defaults PYUSD byte-idénticos**: spread condicional garantiza que var ausente → opt omitido → constructor default PYUSD (CD-1, zero-regression).

**Veredicto AR:** **APROBADO** — Sin hallazgos bloqueantes.

### Code Review (CR) — 2 menores, ambos cerrados

1. **Test override cobertura incompleta (MENOR)**: fix-pack añadió test case pieUSD faltante en chain-adapter.test.ts.
2. **Parámetro decimals → tokenDecimals (rename, MENOR)**: parámetro del constructor renombrado a `tokenDecimals` para claridad (evita confusión con var env `KITE_TESTNET_TOKEN_DECIMALS`).

**Veredicto CR:** **APROBADO CON MENORES (ambos cerrados)**.

### QA / F4 Validation — 622/622 tests, AC-1 a AC-7 evidenciados

| Test Suite | Conteo | Status |
|-----------|--------|--------|
| `npm test` (completa) | 622 passed | ✓ VERDE |
| `npm run typecheck` | — | ✓ OK (sin errores) |
| `npm run lint` | — | ✓ OK (max-warnings 0, sin directives stale) |
| AC-1 (zero-regression defaults) | archivo:línea kite.ts:156-170 | ✓ PASS |
| AC-2 (override env) | archivo:línea kite.ts:156-170 | ✓ PASS |
| AC-3 (domain genérico) | archivo:línea base-adapter.ts:309-315 | ✓ PASS (no cambio, verifica) |
| AC-4 (DOMAIN_SEPARATOR) | archivo:línea SDD §4.3 (computed vs on-chain) | ✓ MATCH |
| AC-5a (defaults tests) | archivo:línea chain-adapter.test.ts:AC-5a | ✓ PASS |
| AC-5b (override tests) | archivo:línea chain-adapter.test.ts:AC-5b | ✓ PASS |
| AC-5c (decimals invalid exit) | archivo:línea env.test.ts:AC-5c | ✓ PASS |
| AC-5d (mainnet intacto) | archivo:línea chain-adapter.test.ts:196-208 | ✓ PASS |
| AC-6 (EnvSchema decimals) | archivo:línea env.ts:95 | ✓ PASS |
| AC-7 (.env.example) | archivo:línea .env.example:103-112 | ✓ PASS |

**Veredicto QA:** **APROBADO** — 7/7 ACs evidenciados, 622 tests verdes, cero drift.

---

## Auto-Blindaje consolidado

Extraído del contexto SDD (secciones Constraint Directives + Riesgos):

| ID | Tema | Lección / Mitigación | Referencia | Aplicado en WFAC-12 |
|----|------|---------------------|-----------|-------------------|
| **AB-1** | Fixtures prod-success rotas por `superRefine` | PROHIBIDO agregar vars required-in-prod al superRefine. Vars opcionales NO van ahí. | WFAC-50 AB#1 + WFAC-12[020] AB#1 | ✓ CD-AB-1 cumplido: 5 vars outside superRefine |
| **AB-2** | Unused eslint-disable detection | NO agregar `eslint-disable security/detect-object-injection` sobre acceso **literal** (dispara solo con bracket dinámico). | WFAC-50[017] AB#2 | ✓ CD-AB-2 cumplido: acceso literal `process.env.KITE_TESTNET_TOKEN_*` (no disable) |
| **AB-3** | Assertions stale (`toHaveLength`, conteos) | Grep `toHaveLength`/conteos en tests post-cambio aditivo. | WFAC-53[019] + WFAC-12[020] AB | ✓ CD-AB-3 cumplido: ni fixtures ni asserts afectados por adición aditiva |
| **AB-4** | Decimal coercion vs Number conversion | `EnvSchema` coerciona string→number; call-site usa `Number(...)` solo para type satisfaction (ya validado al boot). NO duplicar validación. | DT-3 SDD §4.2 | ✓ Applied: env.ts:95 coerce, kite.ts:163 Number(...) conversión (no revalidación) |
| **AB-5** | Spread condicional vs direct undefined | Ambas formas válidas (spread condicional más explícita). Crítico: var ausente → opt omitido/undefined → default PYUSD. | CD-1 SDD §4.2 nota | ✓ Applied: spread condicional en kite.ts:156-170 (byte-idéntico default) |
| **AB-6** | Acceso literal string vs dynamic bracket | Literal acceso: `process.env.KITE_TESTNET_TOKEN_SYMBOL`. Dynamic bracket: `process.env[variable]` (PROHIBIDO, dispara eslint-security). | CD-5 SDD | ✓ Applied: 5 vars literal (no variables dinámicas) |

**Consolidación AB:** 6 lecciones aprendidas en el proceso histórico (WFAC-50, WFAC-53, WFAC-AUDIT), todas aplicadas como CD en este SDD y verificadas en implementación.

---

## Config pieUSD para próxima activación

Cuando se desee habilitar pieUSD (`0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368) como token de pago en Kite Testnet sin tocar código:

```bash
# .env (o Railway dashboard env vars):

# Cambiar dirección token a pieUSD (reemplazar PYUSD actual):
KITE_USDC_ADDRESS=0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A

# Configurar metadata pieUSD:
KITE_TESTNET_TOKEN_SYMBOL=pieUSD
KITE_TESTNET_TOKEN_NAME=pieUSD
KITE_TESTNET_TOKEN_DECIMALS=18
KITE_TESTNET_EIP712_NAME=pieUSD
KITE_TESTNET_EIP712_VERSION=1
```

**Por qué funciona:** El `KiteAdapter` constructor lee las vars nuevas vía spread condicional en `kiteTestnetAdapter` (`kite.ts:156-170`). El EIP-712 domain se recalcula con `eip712Name:'pieUSD'` / `version:'1'`, recuperando firmas correctamente. Boot-check `initDomainCheck` verifica que el DOMAIN_SEPARATOR local = on-chain (MATCH = `0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182`). Cero regresión: sin estas vars, defaults PYUSD se aplican.

**Próximos pasos:** deploy facilitator+a2a testnet con env pieUSD, fondear relayer (native KITE + pieUSD), e2e verify/settle con Kite Agent Passport.

---

## Scope IN vs OUT (verificación final)

### Scope IN (completado)
- [x] `src/infra/env.ts`: 5 vars opcionales EnvSchema (types exactos, NO superRefine)
- [x] `src/chains/kite.ts`: cableado spread condicional kiteTestnetAdapter
- [x] `.env.example`: documentación 5 vars (defaults PYUSD + ejemplos pieUSD comentados)
- [x] Tests: AC-5a/b/c/d (defaults, overrides, decimals inválido, mainnet)
- [x] Tests: AC-4 fake adapter pieUSD (boot-check OK)
- [x] SDD + story file + DOMAIN_SEPARATOR pieUSD verificado

### Scope OUT (RESPETADO, sin cambios)
- [x] NO modificar `base-adapter.ts`, `init-domain-check.ts` (ya genéricos)
- [x] NO modificar `kiteMainnetAdapter` (USDC.e/6/'USD Coin'/'2' hardcoded intacto)
- [x] NO modificar otros chain adapters (avalanche.ts, base.ts)
- [x] NO soporte multi-token por cadena (fuera scope)
- [x] NO código wasiai-a2a / Passkey / externos

---

## Hallazgos finales

### BLOQUEANTEs
- **Ninguno**: todos los hallazgos AR/CR fueron MENOREs y ya cerrados.

### MENOREs (cerrados en fix-pack)
1. Test cobertura incompleta pieUSD (CR): agregado test AC-5b.
2. Rename parámetro decimals → tokenDecimals (CR): mejorada claridad.

### Deuda / Spinoffs
- **Ninguna**: esta HU es completamente self-contained. No bloquea ni es bloqueada.

---

## Lecciones para próximas HUs

1. **Anti-Hallucination via Exemplars:** Story File §6 lista los exemplars file:line exactos. Cuando el Dev sigue los patrones verificados (env vars Zod, spread condicional, acceso literal), la cobertura y lint pasan inline.

2. **Zero-Regression via Conditional Spread:** Para opt-in env overrides, spread condicional (`? {...} : {}`) es más explícito que pass-directo. Ambas aplicarán el default si la var está ausente, pero la spread es más legible en reviews.

3. **Acceso Literal vs Dynamic Bracket:** Eslint-security solo dispara con bracket dinámico. Literal `process.env.VAR_NAME` es siempre OK; no requiere disable. Cuando agregues más vars, verifica que el linter no reclame "Unused eslint-disable" (signo de confusión).

4. **Coerce en EnvSchema, Convert en Call-Site:** DT-3 / AB-4 diferencia: `EnvSchema` valida/coerciona al boot (`z.coerce.number().int().min(0)`); el call-site solo convierte string→number (`Number(...)`) para tipo. NO duplicar validación en kite.ts; confía en parseEnv.

5. **CD-AB-1 Auto-Blindaje persiste:** Cuando hagas cambios aditivos en env.ts (nuevas vars), siempre verifica que NO rompan fixtures prod-success. Un `toHaveLength(1)` stale es fácil de pasar por alto; grep antes de merge.

---

## Archivos entregables

- `/home/ferdev/.openclaw/workspace/wasiai-facilitator/doc/sdd/021-kite-testnet-token-config/final-report.md` ← este archivo
- `/home/ferdev/.openclaw/workspace/wasiai-facilitator/doc/sdd/_INDEX.md` ← actualizado (entrada 021 → DONE)
- `feat/021-wfac-12-kite-testnet-token-config` branch ready para merge (7 files modified, 622 tests verde)

---

*Report generado por nexus-docs — QUALITY pipeline closure, 2026-06-10.*
