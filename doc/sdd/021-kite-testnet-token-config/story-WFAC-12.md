# Story File — [WFAC-12] Kite Testnet token metadata env-configurable

> Fuente única para el Dev (F3). Autosuficiente y anti-alucinación.
> Branch: `feat/021-wfac-12-kite-testnet-token-config`
> SDD: `doc/sdd/021-kite-testnet-token-config/sdd.md` (SPEC_APPROVED)
> Modo: QUALITY · AR obligatorio (`src/chains/*` money-moving)

---

## 1. Contexto mínimo (qué construir y por qué)

El adaptador **Kite Testnet** (`src/chains/kite.ts`) hoy construye su `EIP3009Token`
con defaults **hardcodeados PYUSD** (`symbol/name/eip712Name='PYUSD'`, `eip712Version='1'`,
`decimals=18`). El adaptador **Mainnet** ya recibe esos 5 campos por opts del constructor
(`kite.ts:169-173`). El constructor `KiteAdapter` (`kite.ts:48-60`) **ya acepta los 5 opts
opcionales** y aplica los defaults PYUSD (`kite.ts:78-85` con `?? 'PYUSD'`).

**El cambio**: hacer esos 5 campos del testnet **env-configurables** vía 5 vars nuevas
opcionales en `EnvSchema`, leídas en la instanciación de `kiteTestnetAdapter`. Defaults =
valores PYUSD actuales → **cero regresión**. Caso de uso: habilitar **pieUSD**
(`0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368) sin tocar código.

**Lo que NO se toca** (ya es token-genérico, NO regresionar):
- `src/chains/base-adapter.ts:309-315` (`_verifyRaw` ya lee `token.eip712Name ?? token.name`).
- `src/chains/init-domain-check.ts` (boot-check ya valida cualquier token configurado).
- `kiteMainnetAdapter` y sus valores (`USDC.e`, `6`, `'USD Coin'`, `'2'`).

**5 vars nuevas** (todas opcionales, default PYUSD):

| Var | Tipo Zod (exacto, §4.4 SDD) | Default sin env | Valor pieUSD |
|-----|------------------------------|-----------------|--------------|
| `KITE_TESTNET_TOKEN_SYMBOL` | `z.string().min(1).optional()` | `PYUSD` | `pieUSD` |
| `KITE_TESTNET_TOKEN_NAME` | `z.string().min(1).optional()` | `PYUSD` | `pieUSD` |
| `KITE_TESTNET_TOKEN_DECIMALS` | `z.coerce.number().int().min(0).optional()` | `18` | `18` |
| `KITE_TESTNET_EIP712_NAME` | `z.string().min(1).optional()` | `PYUSD` | `pieUSD` |
| `KITE_TESTNET_EIP712_VERSION` | `z.string().min(1).optional()` | `1` | `1` |

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/infra/env.ts` | Modificar — 5 vars opcionales al `EnvSchema` (NO superRefine) | W1 |
| `src/chains/kite.ts` | Modificar — cablear 5 vars en `kiteTestnetAdapter` (`:144-150`) | W1 |
| `src/__tests__/unit/env.test.ts` | Modificar — AC-6 decimals inválido → exit(1) | W2 |
| `src/__tests__/unit/chain-adapter.test.ts` | Modificar — AC-5a/b/d (defaults, override, mainnet) | W2 |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` | Modificar (opcional) — fake adapter pieUSD | W2 |
| `.env.example` | Modificar — documentar 5 vars (defaults PYUSD + pieUSD comentado) | W3 |

> El test de override puede ir en `chain-adapter.test.ts` (preferido, exemplar directo) o
> en un archivo nuevo `chains.kite.token-config.test.ts`. Elegí UNO. No dupliques.

**Scope OUT (NO tocar):** `src/chains/base-adapter.ts`, `src/chains/init-domain-check.ts`,
`src/chains/avalanche.ts`, `src/chains/base.ts`, `kiteMainnetAdapter`, `src/core/`,
`src/methods/`, `src/routes/`. NO multi-token por cadena. NO cambiar firma de `KiteAdapter`
(ya soporta los opts). NO código de wasiai-a2a / Passkey.

---

## 3. Anti-Hallucination Checklist (esta HU)

### APIs que SÍ existen (verificado, usar tal cual)
- [x] Constructor `KiteAdapter` (`kite.ts:48-60`) ya acepta `tokenSymbol?/tokenName?/tokenDecimals?/eip712Name?/eip712Version?`. **NO cambiar la firma.**
- [x] Defaults PYUSD ya viven en el constructor (`kite.ts:78-85`: `opts.tokenSymbol ?? 'PYUSD'`, etc.). **NO duplicar defaults en el call-site.**
- [x] `EnvSchema` (Zod object) en `env.ts:13-150`; cierra con `.superRefine` en `env.ts:151`. `parseEnv` (`safeParse` → stderr + `process.exit(1)`) ya existe.
- [x] Patrón string opcional: `CORS_ALLOWED_ORIGINS: z.string().optional()` (`env.ts:138`).
- [x] Patrón coerce number int: `CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5)` (`env.ts:59`).
- [x] `kiteMainnetAdapter` pasa los 5 opts en `kite.ts:169-173` (patrón a espejar).
- [x] `viem.domainSeparator` usado en `init-domain-check.ts` y en el test (`chains.kite.domain-check.test.ts:22`).

### NO inventar / NO tocar
- [ ] NO crear helper switch-literal nuevo para las 5 vars (DT-2: acceso **literal directo**).
- [ ] NO `process.env[variable]` (bracket dinámico) — solo `process.env.KITE_TESTNET_TOKEN_*` literal.
- [ ] NO agregar las 5 vars al `.superRefine` (son opcionales, NO required-in-prod).
- [ ] NO `// eslint-disable-next-line security/detect-object-injection` sobre el acceso literal.
- [ ] NO modificar `base-adapter.ts`, `init-domain-check.ts`, `kiteMainnetAdapter`, ni sus valores.
- [ ] NO inventar paths/funciones fuera de los listados en §2.

---

## 4. Waves

### Wave 0 — N/A
No hay gate serial: el constructor ya soporta los opts, no hay contratos/tipos nuevos.

### Wave 1 — EnvSchema + cableado kite.ts (core)

**W1.1 — `src/infra/env.ts`: 5 vars opcionales en `EnvSchema`.**
- Insertar junto a `KITE_USDC_ADDRESS` (`env.ts:83-86`) o al bloque Kite mainnet.
- Tipos EXACTOS (no improvisar):
  ```ts
  KITE_TESTNET_TOKEN_SYMBOL: z.string().min(1).optional(),
  KITE_TESTNET_TOKEN_NAME: z.string().min(1).optional(),
  KITE_TESTNET_TOKEN_DECIMALS: z.coerce.number().int().min(0).optional(),
  KITE_TESTNET_EIP712_NAME: z.string().min(1).optional(),
  KITE_TESTNET_EIP712_VERSION: z.string().min(1).optional(),
  ```
- **NO** agregarlas al `.superRefine` (`env.ts:151+`). [CD-AB-1]
- Exemplar tipos: `env.ts:138` (string opcional), `env.ts:59` (coerce int).

**W1.2 — `src/chains/kite.ts`: cablear 5 vars en `kiteTestnetAdapter` (`:144-150`).**
- Acceso **literal directo** `process.env.KITE_TESTNET_TOKEN_*` con **spread condicional**
  (var ausente → opt `undefined` → default PYUSD del constructor). Snippet de referencia (§4.2 SDD):
  ```ts
  export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
    chainIdNum: 2368,
    envVarName: 'KITE_TESTNET_RPC_URL',
    name: 'Kite Testnet',
    network: 'testnet',
    usdcAddress: readUsdcAddress('KITE_USDC_ADDRESS', 2368),
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
- `Number(...)` convierte string→number en el call-site (process.env es siempre string).
  La validación entero≥0 la garantiza `parseEnv` al boot — **NO duplicar validación en kite.ts** [CD-3/DT-3].
- Exemplar: `kite.ts:160-174` (mainnet pasa los mismos 5 opts).

**DoD W1:** `npm run typecheck` OK + `npm run lint` OK (sin "Unused eslint-disable directive" [CD-AB-2]).

### Wave 2 — Tests

**W2.1 — `env.test.ts`: AC-5c / AC-6 (decimals inválido → exit(1)).**
- Dos casos: `KITE_TESTNET_TOKEN_DECIMALS='abc'` y `='-1'`.
- Aserción: `parseEnv({...})` lanza (exit mockeado), `exitSpy` llamado con `1`, stderr `toContain('KITE_TESTNET_TOKEN_DECIMALS')`.
- Exemplar EXACTO: `env.test.ts:102-119` (T2):
  ```ts
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
    throw new Error('__exit__');
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(() => parseEnv({ /* env válido + KITE_TESTNET_TOKEN_DECIMALS: 'abc' */ })).toThrow('__exit__');
  expect(exitSpy).toHaveBeenCalledWith(1);
  const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  expect(allWrites).toContain('KITE_TESTNET_TOKEN_DECIMALS');
  ```
  > Incluir un env mínimo válido (ej. `NODE_ENV:'production'`, `REDIS_URL`, etc.) para que el
  > único fallo sea decimals — espejá los campos que usa T2 en `env.test.ts:108-113`.

**W2.2 — `chain-adapter.test.ts` (describe `'kite.ts adapters'`, `:160`): AC-5a/b/d.**
- Mecanismo: `snapshotEnv()`/`restoreEnv()`, set env en `beforeEach`, `vi.resetModules()`,
  `await import('../../chains/kite.js')`, asserts sobre `metadata.tokens[0]`.
- **AC-5a (sin env → defaults PYUSD):** sin setear las 5 vars nuevas (el `beforeEach` actual ya
  NO las setea), `kiteTestnetAdapter.metadata.tokens[0]`: `symbol==='PYUSD'`, `decimals===18`,
  `name==='PYUSD'`, `eip712Name==='PYUSD'`, `eip712Version==='1'`.
- **AC-5b (con env → overrides):** setear las 5 vars (`pieUSD`/`pieUSD`/`'18'`/`pieUSD`/`'1'`)
  ANTES de `vi.resetModules()`+import; assert que `tokens[0]` refleja `pieUSD`/`18`/`pieUSD`/`'1'`.
- **AC-5d (mainnet intacto):** YA existe en `chain-adapter.test.ts:196-208` (USDC.e, 6, 'USD Coin', '2').
  **NO modificarlo**; confirmá que sigue verde tras el cambio.
- Exemplar EXACTO: `chain-adapter.test.ts:196-208`.

**W2.3 — `chains.kite.domain-check.test.ts` (opcional): fake adapter pieUSD.**
- Reusar `makeFakeKiteAdapter` (`:31`) con `metadata.tokens[0].eip712Name:'pieUSD'` y
  `readContractImpl` devolviendo el DOMAIN_SEPARATOR pieUSD (`0x05232467...b182`) → boot-check OK
  (`exitSpy` NOT called, `logger.fatal` NOT called).
- Exemplar EXACTO: `chains.kite.domain-check.test.ts:91-109` (T-DOM-KITE-1). El `makeFakeKiteAdapter`
  actual hardcodea PYUSD en `:44-50` — para este test calculá el separator pieUSD local con
  `domainSeparator` (patrón `:22-29`) usando `name:'pieUSD'`.

**DoD W2:** `npm test` — **suite completa verde** [CD-1]. Grep `toHaveLength`/conteos en tests
kite/env: la adición es aditiva, pero verificá que ningún `toHaveLength(1)` quedó stale [CD-AB-3].

### Wave 3 — `.env.example`

**W3.1 — Bloque comentado de 5 vars.**
- Insertar junto al bloque `KITE_USDC_ADDRESS` (`.env.example:98-101`) o al bloque Kite Testnet (`:59-60`).
- Formato espejando el bloque mainnet (`.env.example:62-68`): defaults PYUSD explicados + ejemplos pieUSD comentados.
- Valores confirmados (tabla §4.3 SDD — DOMAIN_SEPARATOR pieUSD verificado on-chain = computed, MATCH):
  ```
  # Kite Testnet token metadata (WFAC-12) — opt-in overrides. ALL optional.
  # Defaults (when unset) = PYUSD: symbol/name/eip712Name=PYUSD, decimals=18, version=1
  # (current Kite Testnet payment token at KITE_USDC_ADDRESS above).
  # To switch to pieUSD (0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A, chain 2368),
  # also set KITE_USDC_ADDRESS to the pieUSD address and uncomment:
  # KITE_TESTNET_TOKEN_SYMBOL=pieUSD
  # KITE_TESTNET_TOKEN_NAME=pieUSD
  # KITE_TESTNET_TOKEN_DECIMALS=18
  # KITE_TESTNET_EIP712_NAME=pieUSD
  # KITE_TESTNET_EIP712_VERSION=1
  ```
  > pieUSD `version()` revierte → fallback `'1'`. DOMAIN_SEPARATOR verificado:
  > `0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182` (computed == on-chain).

**DoD W3:** `.env.example` documenta las 5 vars (CD-4: son metadata, NO secrets — deben aparecer).

---

## 5. Mapeo AC → Test (copiado del Test Plan §SDD)

| AC | Test | Archivo | Aserción clave |
|----|------|---------|----------------|
| AC-1, AC-5a | Sin env → defaults PYUSD | `chain-adapter.test.ts` | `tokens[0].symbol==='PYUSD'`, `decimals===18`, `name/eip712Name==='PYUSD'`, `eip712Version==='1'` |
| AC-2, AC-5b | Con env → overrides | `chain-adapter.test.ts` | `tokens[0]` refleja `pieUSD`/`18`/`pieUSD`/`'1'` |
| AC-5c, AC-6 | Decimals inválido → exit(1) | `env.test.ts` | `exitSpy` con `1` + stderr `toContain('KITE_TESTNET_TOKEN_DECIMALS')` |
| AC-5d | Mainnet intacto | `chain-adapter.test.ts:196-208` | USDC.e / 6 / 'USD Coin' / '2' (existente, no tocar) |
| AC-4 | Fake adapter pieUSD boot-check | `chains.kite.domain-check.test.ts` (opcional) | boot OK, sin `process.exit` |
| AC-3 | Domain inline genérico (no regresión) | suite existente + AR | `base-adapter.ts:309-315` lee `token.eip712Name ?? token.name` |

---

## 6. Patrones a seguir (exemplars verificados — paths reales)

| Para | Exemplar (file:line) | Qué clonar |
|------|----------------------|------------|
| 5 vars en EnvSchema (string) | `src/infra/env.ts:138` | `z.string().optional()` → usar `.min(1).optional()` |
| Var decimals (coerce int) | `src/infra/env.ts:59` | `z.coerce.number().int().min(0)` → con `.optional()` |
| Cableado 5 opts testnet | `src/chains/kite.ts:160-174` | mainnet pasa los 5 opts al constructor |
| Test adapter (resetModules+import+tokens[0]) | `src/__tests__/unit/chain-adapter.test.ts:160-208` | `snapshotEnv`/`restoreEnv`, `vi.resetModules()`, `await import` |
| Test parseEnv exit/stderr | `src/__tests__/unit/env.test.ts:102-119` | exit spy + stderr spy + `toContain('VAR')` |
| Fake adapter pieUSD | `src/__tests__/unit/chains.kite.domain-check.test.ts:91-109` (+ `:22-29`, `:31-61`) | `makeFakeKiteAdapter` + `domainSeparator` local |
| `.env.example` bloque | `.env.example:62-68` (mainnet Kite) | comentarios defaults + ejemplos comentados |

---

## 7. Constraint Directives — checklist BLOQUEANTE

- [ ] **CD-1 (zero-regression):** sin las 5 env vars, `kiteTestnetAdapter` byte-idéntico (default PYUSD vía spread condicional). Tests existentes verdes SIN tocar fixtures PYUSD.
- [ ] **CD-2 (mainnet intacto):** NO modificar `kiteMainnetAdapter` (`kite.ts:160-174`) ni sus valores (USDC.e/6/'USD Coin'/'2').
- [ ] **CD-3 (EnvSchema primero):** las 5 vars en `EnvSchema` ANTES de consumirlas en `kite.ts`. Sin acceso a `process.env` que evada el schema.
- [ ] **CD-5 (acceso literal):** `process.env.KITE_TESTNET_TOKEN_*` literal. NO bracket dinámico `process.env[var]`.
- [ ] **CD-6 (AR obligatorio):** money-moving — AR antes de merge. AR confirma `_verifyRaw` (`base-adapter.ts:309-315`) sigue leyendo `token.eip712Name ?? token.name` (no regresión).
- [ ] **CD-AB-1 (NO superRefine):** las 5 vars NO van al `.superRefine` (opcionales). *Ref: WFAC-50 AB#1 + WFAC-12[020] AB#1 — required-in-prod en superRefine rompió 3 fixtures prod-success.*
- [ ] **CD-AB-2 (NO eslint-disable sobre literal):** NO `eslint-disable security/detect-object-injection` sobre el acceso literal → quedaría "Unused directive" y rompe lint. `npm run lint` post-edit. *Ref: WFAC-50[017] AB#2.*
- [ ] **CD-AB-3 (assertions stale):** grep `toHaveLength`/conteos en tests kite/env post-cambio. *Ref: WFAC-53[019] + WFAC-12[020] AB.*
- [ ] **CD-4 (metadata, NO secret):** las 5 vars deben aparecer en `.env.example`.

---

## 8. Done Definition (la HU está hecha cuando)

- [ ] `src/infra/env.ts`: 5 vars con tipos exactos §4.4, fuera del superRefine.
- [ ] `src/chains/kite.ts`: 5 opts cableados en `kiteTestnetAdapter` con acceso literal + spread condicional; `kiteMainnetAdapter` sin cambios.
- [ ] Tests AC-5a/b/c/d + (opcional) AC-4 fake pieUSD agregados.
- [ ] `.env.example`: 5 vars documentadas (defaults PYUSD + pieUSD comentado).
- [ ] `npm run typecheck` OK · `npm run lint` OK · `npm test` suite completa verde.
- [ ] Sin `toHaveLength` stale (CD-AB-3) · sin eslint-disable innecesario (CD-AB-2).
- [ ] Listo para AR (CD-6) — el Dev NO mergea; AR es gate previo.

---

## Notas (gaps detectados, NO expandir scope)
- Ninguna. El SDD cubre los 7 AC; DT-2 resuelto (acceso literal), DOMAIN_SEPARATOR pieUSD verificado.
