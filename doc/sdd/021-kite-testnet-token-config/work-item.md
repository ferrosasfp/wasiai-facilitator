# Work Item — [WFAC-12] Kite testnet token metadata env-configurable

## Resumen

El adaptador Kite Testnet (`src/chains/kite.ts`) construye su `EIP3009Token` con
defaults hardcodeados a PYUSD (`symbol/name/eip712Name='PYUSD'`, `eip712Version='1'`,
`decimals=18`). El adaptador Kite Mainnet ya lee esos campos desde los opts del constructor
(patron existente). Esta HU elimina la asimetría: los cinco campos de token/dominio del
testnet pasan a ser env-configurables (con defaults = valores PYUSD actuales), habilitando
cualquier token EIP-3009 en Kite Testnet sin tocar código. Caso de uso motivador: pieUSD
(`0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368) para Kite Agent Passport.

## Sizing

- SDD_MODE: full (QUALITY)
- Estimación: S (cambio quirúrgico en una sola función de construcción + env vars + tests)
- Branch sugerido: `feat/021-wfac-12-kite-testnet-token-config` (ya creado)
- Justificación QUALITY: superficie de settlement — cualquier error en `eip712Name` o
  `eip712Version` provoca `INVALID_SIGNATURE` silencioso en todas las verificaciones para
  el token configurado. El servicio es A+ auditado; el flujo EIP-712 es money-moving.
  AR obligatorio por `src/chains/kite.ts` (regla 12 de project-context).

## Skills de dominio

- `blockchain/eip712` — dominio EIP-712, `eip712Name/Version` afectan la recuperación de firma
- `config/env-schema` — patrón `EnvSchema` Zod + `readEnv` switch-literal en `kite.ts`

## Acceptance Criteria (EARS)

- **AC-1 (zero-regression defaults):** WHEN `kiteTestnetAdapter` se construye sin ninguna de las
  cinco variables de entorno nuevas presentes, the system SHALL usar `tokenSymbol='PYUSD'`,
  `tokenName='PYUSD'`, `tokenDecimals=18`, `eip712Name='PYUSD'`, `eip712Version='1'` — idéntico
  al comportamiento previo. Ningún test existente SHALL fallar.

- **AC-2 (override por env):** WHEN las variables `KITE_TESTNET_TOKEN_SYMBOL`,
  `KITE_TESTNET_TOKEN_NAME`, `KITE_TESTNET_TOKEN_DECIMALS`, `KITE_TESTNET_EIP712_NAME` y/o
  `KITE_TESTNET_EIP712_VERSION` están presentes en el entorno, the system SHALL construir el
  `EIP3009Token` del testnet adapter con esos valores en lugar de los defaults PYUSD.

- **AC-3 (dominio EIP-712 en verify/settle):** WHEN se ejecuta `/verify` o `/settle` en Kite
  Testnet con un token configurado via env (p.ej. `eip712Name='pieUSD'`, `eip712Version='1'`),
  the system SHALL reconstruir el dominio EIP-712 con los valores configurados
  (`token.eip712Name`, `token.eip712Version`) y la firma SHALL ser recuperada correctamente
  para ese token — sin hardcodes de 'PYUSD' en el domain inline de `_verifyRaw`.

- **AC-4 (verificación DOMAIN_SEPARATOR pieUSD pre-config):** BEFORE fijar los valores de
  env para pieUSD en `.env.example`, the system SHALL documentar en el work-item/SDD el
  DOMAIN_SEPARATOR on-chain verificado de pieUSD (chain 2368,
  `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`) y confirmar que coincide con el calculado
  localmente vía `viem.domainSeparator({ name:'pieUSD', version:'1', chainId:2368,
  verifyingContract:'0x38129...' })`. El DOMAIN_SEPARATOR conocido es
  `0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182`
  (verificado on-chain por el owner; `version()` revierte → fallback '1').
  IF el cálculo local diverge del valor on-chain, THEN the system SHALL fallar el boot-check
  `initDomainCheck` con `logger.fatal` + `process.exit(1)` (comportamiento ya existente —
  no hay código nuevo aquí, solo la validación documental previa al config).

- **AC-5 (tests del cableado env):** WHEN se añaden las cinco variables nuevas a `EnvSchema`
  y a `kite.ts`, the system SHALL tener tests unitarios que verifiquen: (a) sin env →
  adapter tiene defaults PYUSD; (b) con env override → adapter refleja los overrides; (c)
  `KITE_TESTNET_TOKEN_DECIMALS` inválido (no entero, negativo) → `parseEnv` llama
  `process.exit(1)`; (d) mainnet adapter (`kiteMainnetAdapter`) sigue usando sus propios
  valores hardcodeados (USDC.e, 6 decimals, 'USD Coin', '2') — cero regresión de mainnet.

- **AC-6 (validación EnvSchema):** WHEN `KITE_TESTNET_TOKEN_DECIMALS` está presente,
  the system SHALL validarlo como entero positivo (≥0) via `z.coerce.number().int().min(0)`.
  IF el valor es no-numérico o negativo, THEN `parseEnv` SHALL escribir a `process.stderr`
  mencionando `KITE_TESTNET_TOKEN_DECIMALS` y llamar `process.exit(1)`.

- **AC-7 (.env.example actualizado):** WHEN el PR es mergeado, the system SHALL tener las
  cinco variables nuevas documentadas en `.env.example` con: (a) valores de ejemplo para
  pieUSD comentados (`# para pieUSD: KITE_TESTNET_EIP712_NAME=pieUSD`), (b) valores
  actuales PYUSD como defaults implícitos explicados en comentario.

## Scope IN

| Artefacto | Cambio |
|-----------|--------|
| `src/chains/kite.ts` (líneas 144-150) | Pasar 5 opts de token al constructor de `kiteTestnetAdapter` leyendo nuevas env vars (switch-literal como `readEnv`/`readUsdcAddress`) |
| `src/infra/env.ts` (EnvSchema) | Agregar 5 vars opcionales: `KITE_TESTNET_TOKEN_SYMBOL`, `KITE_TESTNET_TOKEN_NAME`, `KITE_TESTNET_TOKEN_DECIMALS`, `KITE_TESTNET_EIP712_NAME`, `KITE_TESTNET_EIP712_VERSION` |
| `.env.example` | Documentar las 5 vars nuevas con defaults y ejemplos pieUSD comentados |
| `src/__tests__/unit/env.test.ts` | Tests AC-5c (decimals inválido → exit 1) y AC-5a (defaults) |
| `src/__tests__/unit/chains.kite.domain-check.test.ts` | Verificar que el fake adapter con token configurado usa los valores overrideados |
| `src/__tests__/unit/chain-adapter.test.ts` o nuevo `chains.kite.token-config.test.ts` | Tests AC-5a, AC-5b, AC-5d (defaults, overrides, mainnet intacto) |
| `doc/sdd/021-kite-testnet-token-config/` | SDD + story file |

## Scope OUT

- NO cambiar defaults de `kiteTestnetAdapter` (PYUSD sigue siendo el default cuando no hay env)
- NO modificar `kiteMainnetAdapter` ni sus valores (USDC.e, 6 decimals, 'USD Coin', '2' son hardcoded intencionalmente — ya están verificados en mainnet)
- NO modificar otros chain adapters (`avalanche.ts`, `base.ts`)
- NO cambiar la lógica de verify/settle en `base-adapter.ts` (ya lee `token.eip712Name ?? token.name` correctamente)
- NO modificar `initDomainCheck` (ya funciona genéricamente para cualquier token configurado)
- NO tocar `src/core/`, `src/methods/`, `src/routes/`
- NO agregar soporte para múltiples tokens por cadena (fuera de scope)
- NO modificar ningún código de wasiai-a2a, Passkey, ni sistemas externos

## Decisiones técnicas

- **DT-1 (naming de env vars):** Prefijo `KITE_TESTNET_*` espeja el patrón existente del
  repo (`KITE_TESTNET_RPC_URL`, `KITE_USDC_ADDRESS` es la excepción legacy). El sufijo
  `TOKEN_SYMBOL/TOKEN_NAME/TOKEN_DECIMALS/EIP712_NAME/EIP712_VERSION` es auto-descriptivo
  y consistente con lo que usan los comentarios del código actual.

- **DT-2 (lectura via switch-literal, no bracket access):** `kite.ts` ya tiene el patrón
  `type KiteRpcEnvName = 'KITE_TESTNET_RPC_URL' | ...` + `switch(name) { case ... }` para
  cumplir `eslint-plugin-security/detect-object-injection` (CD-10, CD-13). Las nuevas vars
  se leerán con el mismo patrón o directamente via `process.env.KITE_TESTNET_TOKEN_SYMBOL`
  (acceso literal a string — no bracket dinámico). La decisión entre ambas se deja al
  Architect en F2; el approach literal es más simple dado que son 5 vars de uso único.

- **DT-3 (decimals en EnvSchema como z.coerce.number):** `KITE_TESTNET_TOKEN_DECIMALS` es
  string en env → debe coercionar a number igual que `PORT`, `CB_FAILURE_THRESHOLD`, etc.
  `z.coerce.number().int().min(0)` es el patrón canónico del proyecto.

- **DT-4 (string vars sin transform):** `KITE_TESTNET_TOKEN_SYMBOL`, `KITE_TESTNET_TOKEN_NAME`,
  `KITE_TESTNET_EIP712_NAME`, `KITE_TESTNET_EIP712_VERSION` son `z.string().min(1).optional()`
  sin transform — patrón idéntico a `CORS_ALLOWED_ORIGINS` y otras string vars del schema.

## Constraint Directives

- **CD-1 (zero-regression obligatorio):** PROHIBIDO alterar el comportamiento de
  `kiteTestnetAdapter` cuando ninguna de las 5 vars nuevas está en el entorno. Los tests
  existentes (`chains.kite.domain-check.test.ts`, `env.test.ts`, `chain-adapter.test.ts`)
  deben pasar en verde sin modificación de sus fixtures PYUSD.

- **CD-2 (no romper mainnet):** PROHIBIDO modificar los opts pasados a `kiteMainnetAdapter`
  ni sus valores (`tokenSymbol:'USDC.e'`, `tokenDecimals:6`, `eip712Name:'USD Coin'`,
  `eip712Version:'2'`). Esos valores están verificados on-chain y son fixed por contrato.

- **CD-3 (EnvSchema obligatorio):** OBLIGATORIO registrar las 5 vars nuevas en `EnvSchema`
  (src/infra/env.ts) antes de consumirlas en `kite.ts`. El acceso directo a `process.env`
  sin pasar por el schema es violación del patrón del proyecto.

- **CD-4 (no secrets en env):** Las vars nuevas son metadata de token (nombres, versión,
  decimals) — no son secrets. PROHIBIDO tratarlas como secrets ni excluirlas de `.env.example`.

- **CD-5 (switch-literal / no bracket access dinámico):** OBLIGATORIO seguir el patrón
  `switch(name) { case 'LITERAL': ... }` de `readEnv` si se hace una función helper, OR usar
  acceso literal directo `process.env.KITE_TESTNET_TOKEN_SYMBOL` (ambos son aceptables;
  bracket con variable dinámica es PROHIBIDO por CD-10 del WFAC-53).

- **CD-6 (AR obligatorio):** Por regla 12 de project-context (`src/chains/*` es money-moving),
  OBLIGATORIO pasar por Adversarial Review antes de merge. El AR debe verificar que el
  domain inline en `_verifyRaw` (base-adapter.ts:310-315) lee `token.eip712Name ?? token.name`
  y `token.eip712Version ?? '1'` — no hay hardcodes de 'PYUSD' en esa lógica (ya está
  correcto; el AR confirma que no se regresionó).

## Waves sugeridas

**W1 — Verificación domain pieUSD + cableado env (core del cambio)**
- Calcular localmente `viem.domainSeparator({ name:'pieUSD', version:'1', chainId:2368, verifyingContract:'0x38129...' })` y comparar con `0x05232467797ecde...` (ya verificado)
- Agregar 5 vars opcionales a `EnvSchema` en `src/infra/env.ts`
- Modificar `kiteTestnetAdapter` en `src/chains/kite.ts` (líneas 144-150) para leer las 5 vars y pasarlas al constructor de `KiteAdapter`

**W2 — Tests**
- Tests env.test.ts: defaults PYUSD sin env, overrides con env, decimals inválido → exit 1
- Tests chains.kite.token-config (nuevo o en chain-adapter.test.ts): adapter con overrides refleja token correcto, mainnet adapter sin cambios
- Confirmar que `initDomainCheck` funciona con adapter de pieUSD (fake adapter con `eip712Name:'pieUSD'`)

**W3 — Documentación**
- `.env.example`: agregar bloque comentado para las 5 vars con defaults PYUSD y ejemplos pieUSD
- Actualizar `doc/sdd/021-*/` con el valor confirmado de DOMAIN_SEPARATOR de pieUSD

## Missing Inputs

- [resuelto] Valor DOMAIN_SEPARATOR on-chain de pieUSD: `0x05232467797ecde6282391272b5d100ae7d753bdd45f3ff4f895b5c32e76b182` (verificado por el owner, `version()` revierte → '1')
- [resuelto] Dirección pieUSD: `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, chain 2368
- [TBD en F2] Decidir si usar función helper `readKiteTestnetTokenEnv()` o acceso literal directo en `kiteTestnetAdapter`. Ambos son válidos; el Architect elige en SDD.

## Análisis de paralelismo

- Esta HU es independiente de cualquier otra HU activa (solo toca `kite.ts` y `env.ts`).
- NO bloquea ni es bloqueada por nada en `wasiai-a2a`.
- El branch `feat/021-wfac-12-kite-testnet-token-config` está limpio; puede mergearse en
  cualquier momento después de AR aprobado.
