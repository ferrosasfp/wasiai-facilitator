# SDD #021: [WFAC-12] Kite testnet token metadata env-configurable

> SPEC_APPROVED: no
> Fecha: 2026-06-10
> Tipo: improvement
> SDD_MODE: full
> Branch: feat/021-wfac-12-kite-testnet-token-config
> Artefactos: doc/sdd/021-kite-testnet-token-config/

---

## 1. Resumen

El adaptador Kite **Testnet** (`src/chains/kite.ts`) construye su `EIP3009Token` con
defaults hardcodeados PYUSD (`symbol/name/eip712Name='PYUSD'`, `eip712Version='1'`,
`decimals=18`), mientras que el adaptador Kite **Mainnet** ya recibe esos cinco campos
por opts del constructor (patrón existente, líneas 169-173). Esta HU elimina la asimetría:
los cinco campos token/dominio del testnet pasan a ser **env-configurables**, con defaults
= valores PYUSD actuales (zero-regression). Caso de uso motivador: habilitar **pieUSD**
(`0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368) en Kite Testnet sin tocar código.

El cambio es quirúrgico: 5 vars opcionales nuevas en `EnvSchema` (Zod), una lectura literal
de esas vars en la construcción de `kiteTestnetAdapter`, tests y `.env.example`. **No** se
toca la lógica de verify/settle (`base-adapter.ts:309-315` ya lee `token.eip712Name ?? token.name`
genéricamente) ni `initDomainCheck` (ya valida cualquier token configurado).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 021 / WFAC-12 |
| **Tipo** | improvement |
| **SDD_MODE** | full |
| **Objetivo** | Hacer los 5 campos token/EIP-712 de Kite Testnet env-configurables, con defaults PYUSD (zero-regression), habilitando pieUSD sin tocar código |
| **Reglas de negocio** | Superficie de settlement money-moving (A+ auditado); un error en `eip712Name/Version` → `INVALID_SIGNATURE` silencioso. AR obligatorio (`src/chains/*`). |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | N/A — todos resueltos (DOMAIN_SEPARATOR pieUSD verificado, ver §4.3) |

### Acceptance Criteria (EARS)

- **AC-1 (zero-regression defaults):** WHEN `kiteTestnetAdapter` se construye sin ninguna de las 5 env vars nuevas, THE system SHALL usar `symbol/name/eip712Name='PYUSD'`, `decimals=18`, `eip712Version='1'` — idéntico al comportamiento previo; ningún test existente SHALL fallar.
- **AC-2 (override por env):** WHEN `KITE_TESTNET_TOKEN_SYMBOL/_NAME/_DECIMALS/_EIP712_NAME/_EIP712_VERSION` están presentes, THE system SHALL construir el `EIP3009Token` del testnet con esos valores en vez de los defaults PYUSD.
- **AC-3 (dominio EIP-712 en verify/settle):** WHEN se ejecuta `/verify` o `/settle` en Kite Testnet con token env-configurado, THE system SHALL reconstruir el dominio con `token.eip712Name`/`token.eip712Version` configurados y la firma SHALL recuperarse correctamente — sin hardcodes 'PYUSD' en el domain inline de `_verifyRaw`.
- **AC-4 (verificación DOMAIN_SEPARATOR pieUSD):** BEFORE fijar los valores pieUSD en `.env.example`, THE system SHALL documentar el DOMAIN_SEPARATOR on-chain verificado y confirmar que coincide con el calculado vía `viem.domainSeparator`. IF diverge, THEN `initDomainCheck` SHALL fallar el boot con `logger.fatal` + `process.exit(1)` (comportamiento existente).
- **AC-5 (tests cableado env):** WHEN se añaden las 5 vars a `EnvSchema` y `kite.ts`, THE system SHALL tener tests que verifiquen (a) sin env → defaults PYUSD; (b) con env → overrides reflejados; (c) `KITE_TESTNET_TOKEN_DECIMALS` inválido → `process.exit(1)`; (d) mainnet adapter intacto (USDC.e, 6, 'USD Coin', '2').
- **AC-6 (validación EnvSchema):** WHEN `KITE_TESTNET_TOKEN_DECIMALS` presente, THE system SHALL validarlo como `z.coerce.number().int().min(0)`. IF no-numérico/negativo, THEN `parseEnv` SHALL escribir a stderr mencionando `KITE_TESTNET_TOKEN_DECIMALS` y llamar `process.exit(1)`.
- **AC-7 (.env.example):** WHEN el PR se mergea, THE system SHALL documentar las 5 vars con (a) ejemplos pieUSD comentados, (b) defaults PYUSD explicados en comentario.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído (verificado file:line) |
|---------|---------|-----------------------------------------|
| `src/chains/kite.ts` | Sede del cambio | **Defaults PYUSD** en `kite.ts:78-85` (`opts.tokenSymbol ?? 'PYUSD'`, etc.). **Hardcode testnet** en `kite.ts:144-150`: el constructor recibe SOLO `usdcAddress`, sin los 5 opts → cae a defaults. **Patrón a espejar** en `kite.ts:160-174` (mainnet pasa `tokenSymbol/tokenName/tokenDecimals/eip712Name/eip712Version`). **Patrón env-reader switch-literal** en `kite.ts:29-43` (`readEnv` con `switch(name)` sobre union) y `kite.ts:111-125` (`readUsdcAddress`). El constructor `KiteAdapter` ya acepta los 5 opts (`kite.ts:48-60`) — **no requiere cambio de firma**. |
| `src/chains/base-adapter.ts` | Confirmar que verify NO hardcodea PYUSD | `base-adapter.ts:309-315`: `_verifyRaw` arma el domain inline con `name: token.eip712Name ?? token.name`, `version: token.eip712Version ?? '1'`, `chainId: this.metadata.chainId`, `verifyingContract: token.address`. **Genérico — sin hardcode 'PYUSD'.** AC-3 se cumple por construcción; el único cambio es pasar los overrides al adapter. |
| `src/infra/env.ts` | Registrar 5 vars nuevas | `EnvSchema` (Zod object, `env.ts:13-150`). **String opcional**: `CORS_ALLOWED_ORIGINS: z.string().optional()` (`env.ts:138`); con `.min(1)`: `SUPABASE_SERVICE_KEY: z.string().min(1).optional()` (`env.ts:36`). **Coerce number int**: `CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5)` (`env.ts:59`), `REDIS_DB: z.coerce.number().int().min(0).max(15).default(0)` (`env.ts:22`). **parseEnv** (`env.ts:197-209`): `safeParse` → on failure escribe issues con su `path` a `process.stderr` y `process.exit(1)`. Las vars opcionales NO van al `.superRefine` (no son required-in-prod). |
| `src/chains/init-domain-check.ts` | Confirmar boot-check genérico (AC-4) | `init-domain-check.ts:43` lee `metadata.tokens[0]`; `:54-57` calcula `domainSeparator({ name: token.eip712Name ?? token.name, version: token.eip712Version ?? '1', chainId, verifyingContract })` y compara con el on-chain. **Ya funciona para cualquier token configurado** — no se modifica. |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` | Exemplar test boot-check | Usa `chainRegistry._resetForTesting()` + `makeFakeKiteAdapter({ readContractImpl })` con `metadata.tokens[0]` (`:42-51`), `domainSeparator` local (`:22-29`), `vi.spyOn(process,'exit')`. Patrón para verificar un fake adapter con `eip712Name:'pieUSD'`. |
| `src/__tests__/unit/chain-adapter.test.ts` | Exemplar test adapters kite | `:160-208` describe 'kite.ts adapters': `snapshotEnv()`/`restoreEnv()`, set de env vars en `beforeEach`, `vi.resetModules()`, `await import('../../chains/kite.js')` y asserts sobre `metadata.tokens[0]` (`:196-208` valida mainnet USDC.e: `symbol`, `decimals`, `name`, `eip712Name`, `eip712Version`). **Exemplar exacto para AC-5a/b/d.** |
| `src/__tests__/unit/env.test.ts` | Exemplar test parseEnv exit | `:102-119` (T2): `vi.spyOn(process,'exit').mockImplementation(() => { throw new Error('__exit__') })` + `vi.spyOn(process.stderr,'write')`, `expect(() => parseEnv({...})).toThrow('__exit__')`, `expect(exitSpy).toHaveBeenCalledWith(1)`, `expect(allWrites).toContain('VAR_NAME')`. **Exemplar exacto para AC-5c/AC-6.** |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| Lectura de 5 vars en `kiteTestnetAdapter` | `kite.ts:160-174` (mainnet opts) + `kite.ts:144-150` (testnet actual) | El constructor ya acepta los opts; solo hay que pasarlos |
| 5 vars en `EnvSchema` | strings: `env.ts:138` (`CORS_ALLOWED_ORIGINS`); decimals: `env.ts:59` (`CB_FAILURE_THRESHOLD`) | Tipos canónicos del proyecto |
| Test override/default adapter | `chain-adapter.test.ts:196-208` | Mismo mecanismo `resetModules` + `import` + tokens[0] |
| Test decimals inválido → exit | `env.test.ts:102-119` | Mismo mecanismo exit/stderr spy |
| Test fake adapter pieUSD | `chains.kite.domain-check.test.ts:31-61` | makeFakeKiteAdapter con eip712Name configurable |

### Estado de BD relevante

N/A — esta HU no toca base de datos.

### Componentes reutilizables encontrados

- El constructor `KiteAdapter` (`kite.ts:48-60`) **ya** tiene los 5 parámetros opcionales `tokenSymbol/tokenName/tokenDecimals/eip712Name/eip712Version` con defaults PYUSD aplicados en `kite.ts:78-85`. **No se crea firma nueva**, solo se cablean los args en la instanciación del testnet.
- `initDomainCheck` (`init-domain-check.ts`) ya valida genéricamente — reutilizar, no tocar.
- `_verifyRaw` domain inline (`base-adapter.ts:309-315`) ya genérico — reutilizar, no tocar.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | AC | Exemplar |
|---------|--------|-------------|-----|----------|
| `src/infra/env.ts` | Modificar | Agregar 5 vars opcionales al `EnvSchema` (NO al superRefine) | AC-6, AC-2 | `env.ts:138`, `env.ts:59` |
| `src/chains/kite.ts` | Modificar | En la instanciación de `kiteTestnetAdapter` (`:144-150`), leer las 5 vars y pasarlas al constructor | AC-1, AC-2, AC-3 | `kite.ts:160-174` |
| `.env.example` | Modificar | Documentar las 5 vars: defaults PYUSD + ejemplos pieUSD comentados | AC-7 | bloque mainnet existente |
| `src/__tests__/unit/env.test.ts` | Modificar | Tests AC-6 (decimals inválido → exit 1) y opcional defaults parseo | AC-5c, AC-6 | `env.test.ts:102-119` |
| `src/__tests__/unit/chain-adapter.test.ts` (o nuevo `chains.kite.token-config.test.ts`) | Modificar/Crear | Tests AC-5a (defaults PYUSD), AC-5b (override env), AC-5d (mainnet intacto) | AC-1, AC-2, AC-5 | `chain-adapter.test.ts:196-208` |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` | Modificar (opcional) | Verificar fake adapter con `eip712Name:'pieUSD'` (boot-check genérico) | AC-4 | `chains.kite.domain-check.test.ts:91-109` |
| `doc/sdd/021-kite-testnet-token-config/` | Crear | SDD + story file + DOMAIN_SEPARATOR pieUSD confirmado (§4.3) | AC-4 | — |

### 4.2 Decisión DT-2 — helper vs acceso literal directo (RESUELTO)

> El work-item delega esta decisión al Architect (Missing Input [TBD en F2]).

**Decisión: acceso literal directo `process.env.KITE_TESTNET_TOKEN_*`** dentro de la
construcción del testnet adapter — **NO** función helper switch-literal.

Justificación:
1. Son **5 vars de uso único** (se leen una vez, en la instanciación). El patrón switch-literal
   (`readEnv`, `readUsdcAddress`) existe para vars consumidas con un **parámetro `name` dinámico**
   reutilizable entre testnet/mainnet; aquí no hay reuso ni parámetro dinámico → un helper agrega
   indirección sin valor.
2. `process.env.KITE_TESTNET_TOKEN_SYMBOL` es **acceso por clave literal string**, NO bracket
   dinámico → **no dispara** `eslint-plugin-security/detect-object-injection` (cumple CD-5). El acceso
   literal de propiedad (dot o `['LITERAL']`) está permitido; lo prohibido es `process.env[variable]`.
3. `EnvSchema` (Zod) ya valida tipo/coerción al boot; la lectura en `kite.ts` solo necesita el valor
   crudo de `process.env` para pasarlo al constructor (los defaults `?? 'PYUSD'` viven ya en el
   constructor, `kite.ts:78-85`).

**Detalle de cableado (ilustrativo — el Dev escribe el código en F3):**

```ts
// kite.ts — instanciación testnet (~líneas 144-150). Acceso LITERAL por clave.
export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
  usdcAddress: readUsdcAddress('KITE_USDC_ADDRESS', 2368),
  // 5 overrides opcionales — undefined cae al default PYUSD en el constructor (:78-85).
  ...(process.env.KITE_TESTNET_TOKEN_SYMBOL
    ? { tokenSymbol: process.env.KITE_TESTNET_TOKEN_SYMBOL } : {}),
  ...(process.env.KITE_TESTNET_TOKEN_NAME
    ? { tokenName: process.env.KITE_TESTNET_TOKEN_NAME } : {}),
  ...(process.env.KITE_TESTNET_TOKEN_DECIMALS
    ? { tokenDecimals: Number(process.env.KITE_TESTNET_TOKEN_DECIMALS) } : {}),
  ...(process.env.KITE_TESTNET_EIP712_NAME
    ? { eip712Name: process.env.KITE_TESTNET_EIP712_NAME } : {}),
  ...(process.env.KITE_TESTNET_EIP712_VERSION
    ? { eip712Version: process.env.KITE_TESTNET_EIP712_VERSION } : {}),
});
```

> **Nota anti-regresión (CD-1):** usar spread condicional (`? {...} : {}`) para que una var ausente
> deje el opt en `undefined` y el constructor caiga al default PYUSD (`?? 'PYUSD'`, `kite.ts:78-85`).
> Pasar `tokenSymbol: process.env.KITE_TESTNET_TOKEN_SYMBOL` directo (sin guard) haría
> `tokenSymbol: undefined`, lo cual TAMBIÉN cae al `?? 'PYUSD'` y es válido — el Dev puede elegir el
> estilo más simple, pero el spread condicional es el más explícito. Lo crítico es que **sin env →
> default PYUSD byte-idéntico**.

> **Nota decimals (CD-3 + DT-3):** `EnvSchema` coerciona/valida `KITE_TESTNET_TOKEN_DECIMALS` a
> number entero ≥0; el `Number(...)` en `kite.ts` es la conversión de string→number en el punto de
> consumo (process.env es siempre string). La validación de "es entero ≥0" la garantiza `parseEnv`
> al boot, no `kite.ts`. NO duplicar validación en `kite.ts`.

### 4.3 AC-4 — Verificación DOMAIN_SEPARATOR pieUSD (CONFIRMADO)

Verificado durante F2 ejecutando viem localmente:

```
viem.domainSeparator({ domain: {
  name: 'pieUSD', version: '1', chainId: 2368,
  verifyingContract: '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A'
}})
  computed = 0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182
  on-chain = 0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182
  MATCH = true ✓
```

**Conclusión:** el EIP-712 name de pieUSD = `name()` = `'pieUSD'` y version = `'1'`
(`version()` revierte → fallback '1'). NO hay divergencia entre `eip712Name` y `name()`.
Los valores de env para pieUSD son:

| Var | Valor pieUSD | Default (PYUSD) |
|-----|--------------|------------------|
| `KITE_USDC_ADDRESS` (existente) | `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A` | — |
| `KITE_TESTNET_TOKEN_SYMBOL` | `pieUSD` | `PYUSD` |
| `KITE_TESTNET_TOKEN_NAME` | `pieUSD` | `PYUSD` |
| `KITE_TESTNET_TOKEN_DECIMALS` | `18` | `18` |
| `KITE_TESTNET_EIP712_NAME` | `pieUSD` | `PYUSD` |
| `KITE_TESTNET_EIP712_VERSION` | `1` | `1` |

> Esto es **verificación documental** (AC-4), NO cambio de código. El boot-check
> `initDomainCheck` (`init-domain-check.ts:54-57`) ya re-calcula y compara contra el on-chain
> al arranque; si el operador configura pieUSD con un `eip712Name`/`version` incorrecto, el boot
> falla con `logger.fatal` + `process.exit(1)` (defensa en profundidad existente, no se toca).

### 4.4 EnvSchema — tipos exactos de las 5 vars

Insertar en `EnvSchema` (sugerido junto a `KITE_USDC_ADDRESS`, `env.ts:83-86`). **NO** agregar al `.superRefine` (son opcionales, no required-in-prod):

| Var | Tipo Zod exacto |
|-----|------------------|
| `KITE_TESTNET_TOKEN_SYMBOL` | `z.string().min(1).optional()` |
| `KITE_TESTNET_TOKEN_NAME` | `z.string().min(1).optional()` |
| `KITE_TESTNET_TOKEN_DECIMALS` | `z.coerce.number().int().min(0).optional()` |
| `KITE_TESTNET_EIP712_NAME` | `z.string().min(1).optional()` |
| `KITE_TESTNET_EIP712_VERSION` | `z.string().min(1).optional()` |

### 4.5 Flujo principal (Happy Path)

1. Operador define (o no) las 5 vars en el entorno.
2. Al boot, `parseEnv` valida tipos vía `EnvSchema` (decimals coercionado a int ≥0).
3. `src/chains/kite.ts` se importa; `kiteTestnetAdapter` se construye leyendo las vars literales de `process.env` y pasándolas al constructor (defaults PYUSD si ausentes).
4. `initDomainCheck` re-calcula `domainSeparator` del token configurado y lo compara con el on-chain → OK (match) o `process.exit(1)` (drift).
5. `/verify` y `/settle` reconstruyen el dominio EIP-712 con `token.eip712Name`/`eip712Version` (`base-adapter.ts:309-315`) → firma recuperada correctamente.

### 4.6 Flujo de error

1. `KITE_TESTNET_TOKEN_DECIMALS='abc'` o `=-1` → `EnvSchema` falla → `parseEnv` escribe a stderr mencionando `KITE_TESTNET_TOKEN_DECIMALS` + `process.exit(1)` (AC-6).
2. Operador configura `eip712Name`/`version` incorrecto para pieUSD → `initDomainCheck` detecta drift vs on-chain → `logger.fatal` + `process.exit(1)` (existente, AC-4).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-3:** registrar las 5 vars en `EnvSchema` (`src/infra/env.ts`) ANTES de consumirlas en `kite.ts`. Acceso directo a `process.env` sin schema = violación del patrón.
- **CD-5:** usar **acceso literal directo** `process.env.KITE_TESTNET_TOKEN_*` (decisión DT-2). NO bracket dinámico `process.env[variable]`. NO agregar `eslint-disable security/detect-object-injection` — el acceso literal NO lo dispara (ver §7 riesgo R-2, lección AB-WFAC-50).
- Tipos Zod exactos según §4.4 (4 strings `.min(1).optional()`, decimals `z.coerce.number().int().min(0).optional()`).
- Cablear los opts vía spread condicional o paso directo, garantizando default PYUSD cuando ausente (CD-1).

### PROHIBIDO
- **CD-1 (zero-regression):** PROHIBIDO alterar el comportamiento de `kiteTestnetAdapter` cuando ninguna de las 5 vars está en el entorno. Los tests existentes (`chains.kite.domain-check.test.ts`, `env.test.ts`, `chain-adapter.test.ts`) deben pasar en verde **sin modificar sus fixtures PYUSD** (salvo el ajuste obligatorio de fixtures descrito en R-1 si aplica).
- **CD-2 (no romper mainnet):** PROHIBIDO modificar los opts de `kiteMainnetAdapter` (`kite.ts:160-174`) ni sus valores (`USDC.e`, `6`, `USD Coin`, `2`). Verificados on-chain, fixed.
- **CD-4:** las 5 vars son metadata (no secrets). PROHIBIDO tratarlas como secrets o excluirlas de `.env.example`.
- **CD-6 (AR obligatorio):** por regla 12 de project-context (`src/chains/*` money-moving), AR obligatorio antes de merge. El AR DEBE confirmar que `_verifyRaw` (`base-adapter.ts:309-315`) sigue leyendo `token.eip712Name ?? token.name` / `token.eip712Version ?? '1'` — sin hardcode 'PYUSD' (no se regresionó).
- PROHIBIDO modificar `base-adapter.ts`, `init-domain-check.ts`, `avalanche.ts`, `base.ts`, `src/core/`, `src/methods/`, `src/routes/`.
- PROHIBIDO agregar las 5 vars al `.superRefine` (son opcionales, no required-in-prod — agregarlas rompería fixtures, ver R-1).
- PROHIBIDO agregar soporte multi-token por cadena (fuera de scope).

### Constraint Directives derivados de Auto-Blindaje histórico
- **CD-AB-1 (fixtures prod / superRefine):** PROHIBIDO agregar estas vars al `.superRefine`. **Referencia: WFAC-50 auto-blindaje#1 + WFAC-12[020] auto-blindaje#1** — agregar una key required-in-prod al superRefine rompió 3 fixtures de prod-success en `env.test.ts`. Aquí las vars son OPCIONALES → no debería ocurrir; pero si el Dev añade un test de prod-success nuevo, NO debe omitir env vars previamente required.
- **CD-AB-2 (eslint-disable sobre literal):** PROHIBIDO agregar `// eslint-disable-next-line security/detect-object-injection` sobre `process.env.KITE_TESTNET_TOKEN_*`. **Referencia: WFAC-50[017] auto-blindaje#2** — el plugin solo dispara con índice VARIABLE/dinámico, no con clave literal; el disable quedaría como "Unused eslint-disable directive" y rompería lint. Verificar con `npm run lint` post-edit.
- **CD-AB-3 (assertions stale por cambio aditivo):** si algún test existente asserta longitud/conteo exacto de un array de tokens o de un schema, revisar que la adición de vars no lo deje stale. **Referencia: WFAC-53[019] + WFAC-12[020] auto-blindaje** — `toHaveLength(1)` falló tras adición aditiva. Buscar `toHaveLength` / conteos en tests de kite/env post-cambio.

## 6. Scope

**IN:**
- `src/infra/env.ts`: 5 vars opcionales nuevas en `EnvSchema`.
- `src/chains/kite.ts`: cablear las 5 vars en la instanciación de `kiteTestnetAdapter` (`:144-150`).
- `.env.example`: documentar 5 vars (defaults PYUSD + ejemplos pieUSD comentados).
- Tests AC-5a/b/c/d + AC-6 + verificación fake adapter pieUSD.
- SDD + story file + DOMAIN_SEPARATOR pieUSD confirmado.

**OUT:**
- Defaults de `kiteTestnetAdapter` (PYUSD sigue siendo default sin env).
- `kiteMainnetAdapter` y sus valores (USDC.e/6/'USD Coin'/'2').
- Otros chain adapters (`avalanche.ts`, `base.ts`).
- Lógica verify/settle (`base-adapter.ts`), `initDomainCheck`.
- `src/core/`, `src/methods/`, `src/routes/`.
- Multi-token por cadena.
- Cualquier código de wasiai-a2a / Passkey / sistemas externos.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| **R-1** — Agregar las vars rompe fixtures de prod-success en `env.test.ts` | B | M | Vars OPCIONALES → no van al superRefine → no se requieren en prod. Si algún test nuevo de prod-success se agrega, NO omitir env vars previas (CD-AB-1). |
| **R-2** — Dev agrega `eslint-disable detect-object-injection` innecesario → lint falla | M | B | CD-AB-2: acceso literal no dispara el rule. `npm run lint` post-edit. |
| **R-3** — Cablear sin guard deja default roto cuando var ausente (regresión) | B | A | CD-1 + §4.2 nota: spread condicional / verificar default PYUSD byte-idéntico. Test AC-5a cubre. |
| **R-4** — `eip712Name` mal configurado para pieUSD → `INVALID_SIGNATURE` silencioso | B | A | DOMAIN_SEPARATOR verificado (§4.3) + `initDomainCheck` falla boot en drift. AR obligatorio (CD-6). |
| **R-5** — Assertions stale (`toHaveLength`) tras cambio aditivo | B | B | CD-AB-3: grep `toHaveLength`/conteos en tests post-cambio. |

## 8. Dependencias

- Ninguna previa. El constructor `KiteAdapter` (`kite.ts:48-60`) ya soporta los 5 opts.
- HU independiente; no bloquea ni es bloqueada por otra HU activa.

## 9. Missing Inputs

- N/A. DOMAIN_SEPARATOR pieUSD verificado (§4.3); decisión helper-vs-literal resuelta (DT-2 → literal, §4.2).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Ninguno pendiente | No |

---

## Plan de Implementación (Waves)

### Wave 0 (Serial Gate)
N/A — no hay prerequisitos de contratos/tipos (el constructor ya soporta los opts).

### Wave 1 — Verificación dominio + cableado env (core)
- [ ] W1.1: Confirmar DOMAIN_SEPARATOR pieUSD = on-chain (ya hecho en §4.3 — documental). → Exemplar: `init-domain-check.ts:54-57`
- [ ] W1.2: Agregar 5 vars opcionales a `EnvSchema` en `src/infra/env.ts` (§4.4). NO superRefine. → Exemplar: `env.ts:138`, `env.ts:59`
- [ ] W1.3: Cablear las 5 vars en `kiteTestnetAdapter` (`kite.ts:144-150`) con acceso literal directo (§4.2). → Exemplar: `kite.ts:160-174`
- Verificación: `npm run typecheck` + `npm run lint` (CD-AB-2).

### Wave 2 — Tests
- [ ] W2.1: `env.test.ts` — AC-6 decimals inválido (`'abc'`, `'-1'`) → `process.exit(1)` + stderr menciona `KITE_TESTNET_TOKEN_DECIMALS`. → Exemplar: `env.test.ts:102-119`
- [ ] W2.2: `chain-adapter.test.ts` (o nuevo `chains.kite.token-config.test.ts`) — AC-5a (sin env → defaults PYUSD), AC-5b (con env → overrides), AC-5d (mainnet intacto). → Exemplar: `chain-adapter.test.ts:196-208`
- [ ] W2.3: `chains.kite.domain-check.test.ts` (opcional) — fake adapter con `eip712Name:'pieUSD'` → boot-check OK. → Exemplar: `chains.kite.domain-check.test.ts:91-109`
- Verificación: `npm test` — suite completa verde (CD-1). Revisar `toHaveLength`/conteos (CD-AB-3).

### Wave 3 — Documentación
- [ ] W3.1: `.env.example` — bloque comentado de 5 vars con defaults PYUSD + ejemplos pieUSD (§4.3). → Exemplar: bloque mainnet existente en `.env.example`.

## Test Plan

| Test | AC | Wave | Archivo | Framework |
|------|-----|------|---------|-----------|
| Sin env → defaults PYUSD | AC-1, AC-5a | W2.2 | `chain-adapter.test.ts` | vitest |
| Con env → overrides reflejados | AC-2, AC-5b | W2.2 | `chain-adapter.test.ts` | vitest |
| Decimals inválido → exit(1) + stderr | AC-5c, AC-6 | W2.1 | `env.test.ts` | vitest |
| Mainnet adapter intacto | AC-5d | W2.2 | `chain-adapter.test.ts` | vitest |
| Fake adapter pieUSD boot-check | AC-4 | W2.3 | `chains.kite.domain-check.test.ts` | vitest |
| Domain inline lee eip712Name genérico (no regresión) | AC-3 | (cubierto por suite existente + AR) | `base-adapter` tests | vitest |

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W1 | typecheck + lint (CD-AB-2) |
| W2 | typecheck + tests (suite completa verde, CD-1) |
| W3 | full QA + AR (CD-6) |

## Estimación

- Archivos nuevos: 0-1 (test opcional)
- Archivos modificados: 4-5
- Tests nuevos: ~5
- Líneas estimadas: ~80-120

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1 (AC-1..7 mapeados)
[x] Cada archivo en tabla 4.1 tiene Exemplar verificado con Read (file:line citado)
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives incluyen >=3 PROHIBIDO (CD-1,2,4,6 + CD-AB-1,2,3 + scope)
[x] Context Map tiene >=2 archivos leídos (7 archivos)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: N/A (sin cambios de BD)
[x] Happy Path completo (§4.5)
[x] Flujo de error definido (§4.6 — 2 casos)
[x] DT-2 resuelto (acceso literal directo)
[x] DOMAIN_SEPARATOR pieUSD verificado contra on-chain (MATCH, §4.3)
[x] Auto-Blindaje histórico incorporado (CD-AB-1/2/3)
```

Resultado: **LISTO para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL*
