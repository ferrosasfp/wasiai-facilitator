# SDD #005 — WFAC-6 EIP-3009 Verify Logic

> SPEC_APPROVED: pending humano
> Fecha: 2026-04-22
> Tipo: method (money-moving — firma criptográfica)
> SDD_MODE: full
> Clasificación: QUALITY
> Branch: `feat/005-wfac-6-eip3009-verify` (desde `main@00887c4`)
> Artefactos: `doc/sdd/005-wfac-6-eip3009-verify/`
> Jira: https://ferrosasfp.atlassian.net/browse/WFAC-6
> HU_APPROVED: sí (work-item.md revisado por humano)
> Agente: nexus-architect (F2)

---

## 1. Overview

Implementar `src/methods/eip3009/verify.ts` — la función de verificación off-chain pura
del método EIP-3009. Es el módulo que corre detrás de `POST /verify` y es también la
primera mitad del pipeline de `POST /settle` (se re-valida antes de ejecutar on-chain).

**Qué hace**:

1. Recupera la dirección firmante del payload vía EIP-712
   (`recoverTypedDataAddress` de viem) sobre el tipo `TransferWithAuthorization`.
2. Compara la dirección recuperada contra `authorization.from` con `isAddressEqual`.
3. Valida el conjunto completo de pre-condiciones del spec x402:
   - ventana temporal (`validAfter`/`validBefore` vs `Date.now()/1000`),
   - monto (`authorization.value >= accepted.amount`, y `amount > 0`),
   - red canónica (`accepted.network === eip155:<chainId>`),
   - asset presente en el registro de la chain,
   - receptor (`authorization.to === accepted.payTo`),
   - formato `nonce` (hex 32 bytes).
4. Retorna un discriminated union tipado: `AdapterResult<VerifyResult>`
   (`{ ok: true, verified: true, client, amount, asset, network, payTo, expiresAt }`
   o `{ ok: false, error: { code: X402ErrorCode, message, http } }`).

**Qué NO hace** (Scope OUT):

- NO consulta RPC (`balanceOf`, `eth_getBlockByNumber`, `eth_call`) — es off-chain.
- NO persiste nada (no Redis, no Supabase).
- NO ejecuta la transacción on-chain (eso es WFAC-7 / settle).
- NO arma el dispatcher `core/verify.ts` (WFAC-20).
- NO normaliza EIP-2098 compact signatures (WFAC-13 — ticket dedicado).

**Entrega**:

1. `src/methods/eip3009/abi.ts` — constante `EIP3009_TYPES` (definición EIP-712 del
   `TransferWithAuthorization`) + re-export de `asConst` helpers si son necesarios.
2. `src/methods/eip3009/schemas.ts` — Zod schemas locales para validar el sub-objeto
   `authorization` del `VerifyParams` (refuerza los tipos en runtime: nonce `0x` + 64 hex,
   value/validAfter/validBefore como string uint256 decimal, `from`/`to` como addresses).
3. `src/methods/eip3009/domain.ts` — `buildEip3009Domain(token, chainId, accepted)` →
   `TypedDataDomain` puro.
4. `src/methods/eip3009/verify.ts` — función principal `verifyEip3009(params, token,
   chainId)`.
5. `src/methods/eip3009/index.ts` — re-export público (`verifyEip3009`,
   `buildEip3009Domain`, `EIP3009_TYPES`).
6. `src/__tests__/unit/methods/eip3009/domain.test.ts` — tests del builder.
7. `src/__tests__/unit/methods/eip3009/verify.test.ts` — tests con fixtures de firma
   generados offline (viem `signTypedData` + Hardhat account #0 private key).

**Resultado esperado**: `npm run qa` verde, `npm run build` verde, 12+ ACs con al menos
un test que los aserciona por `error.code`, cero `any`, cero `throw` por condiciones
previsibles, cero imports hacia fuera del boundary del método.

---

## 2. Architecture

### Diagrama de componentes (esta HU)

```
┌────────────────────────────────────────────────────────────────────────┐
│  src/core/verify.ts            (NO existe — WFAC-20)                   │
│    │                                                                    │
│    │ resolve chain → resolve method → dispatch                          │
│    ▼                                                                    │
│  verifyEip3009(params, token, chainId)   ← THIS HU                     │
│    │                                                                    │
│    │  1. Zod validate payload.authorization shape        (schemas.ts)  │
│    │       on fail → { ok:false, INVALID_SIGNATURE, 401 }               │
│    │                                                                    │
│    │  2. Network / asset / amount pre-checks (cheap)                    │
│    │       network !== eip155:<chainId> → NETWORK_MISMATCH              │
│    │       asset not in token list       → NETWORK_MISMATCH             │
│    │       amount === 0n                 → INVALID_AMOUNT               │
│    │       value < amount                → INVALID_AMOUNT               │
│    │       to !== payTo                  → INVALID_RECEIVER             │
│    │       nowSec >= validBefore         → EXPIRED_AUTHORIZATION        │
│    │       nowSec <  validAfter          → EXPIRED_AUTHORIZATION        │
│    │                                                                    │
│    │  3. Build EIP-712 domain             (domain.ts)                   │
│    │       { name, version, chainId, verifyingContract }                │
│    │                                                                    │
│    │  4. recoverTypedDataAddress({                                      │
│    │       domain, types: EIP3009_TYPES,                                │
│    │       primaryType: 'TransferWithAuthorization',                    │
│    │       message: authorization, signature })                         │
│    │       try/catch → INVALID_SIGNATURE                                │
│    │                                                                    │
│    │  5. isAddressEqual(recovered, authorization.from)                  │
│    │       false → INVALID_SIGNATURE                                    │
│    │                                                                    │
│    │  6. return { ok:true, verified:true, client: recovered,            │
│    │              amount, asset, network, payTo,                        │
│    │              expiresAt: Number(validBefore) }                      │
│    ▼                                                                    │
│  AdapterResult<VerifyResult>                                           │
└────────────────────────────────────────────────────────────────────────┘
```

### Orden de validación (crítico — fail-fast)

El orden garantiza:

1. **Cheap checks antes que crypto**. Las comparaciones de red/asset/timestamp cuestan
   µs; `recoverTypedDataAddress` cuesta ~1-2ms (hash typed data + secp256k1 recover).
2. **Seguridad por capas**. Si `accepted.asset` no está en el registro, no perdemos
   tiempo recuperando una firma de un token desconocido.
3. **El shape del Zod check se corre primero**: si `authorization.nonce` no es `0x` +
   64 hex chars, ni siquiera intentamos recover — el payload está corrupto.

### Flujo de test

1. Cada test genera su fixture offline con:
   ```ts
   const account = privateKeyToAccount('0xac09...ff80'); // Hardhat account #0
   const signature = await account.signTypedData({
     domain, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message,
   });
   ```
   → No hay I/O, no hay red, no hay mocks de viem.

2. Cada test construye un `VerifyParams` completo con el `signature` del paso anterior.

3. Cada test llama `verifyEip3009(params, token, chainId)` y assertea el shape
   retornado.

4. No se usa `vi.mock('viem', ...)` — viem es la dep criptográfica, la usamos real.

---

## 3. Codebase Grounding (archivos leídos + evidencia)

### Archivos leídos en este proyecto (wasiai-facilitator)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `doc/sdd/005-wfac-6-eip3009-verify/work-item.md` | Input obligatorio | 12 ACs + 13 CDs + DTs (A–E) + Waves W0–W3 |
| `.nexus/project-context.md` | Stack + reglas | viem v2 exclusivo; Result<T> discriminated union; x402 spec shapes literales; sin ethers |
| `OWNERS.md` | Module boundaries | `src/methods/<method>/` puede importar `src/chains/types.ts` (solo tipos) + viem + ABIs propias. PROHIBIDO `src/core/*`, `src/chains/registry.ts`, otros methods |
| `src/chains/types.ts` (lines 1–153) | Fuente de `EIP3009Token`, `VerifyParams`, `VerifyResult`, `AdapterResult`, `ChainAdapter` | Confirma shapes exactos: `VerifyParams.payload.signature: 0x${string}`, `authorization.value/validAfter/validBefore: string`, `nonce: 0x${string}`, `from/to: Address`. `AdapterResult<T>` = `Result<T>` |
| `src/core/types.ts` (lines 1–66) | Primitivas | `Ok<T> = { ok: true } & T`; `Err = { ok:false, error: {code, message, http} }`; `X402ErrorCode` literal union de 10 códigos; `asChainId(n)` throws (es helper de construcción, no Result); `Address = 0x${string}` |
| `src/chains/kite.ts` (lines 1–141) | Exemplar de adapter (referencial) | Confirma que `verify()`/`settle()` de los adapters retornan stub `NETWORK_MISMATCH` con mensaje WFAC-10/11 pendiente. Esta HU NO modifica eso — el adapter llamará a `verifyEip3009` desde WFAC-10, fuera de scope |
| `src/chains/registry.ts` | Estructura del registry | `getAdapter(chainId)` retorna `{ok:true, adapter}` o `{ok:false, error}`. ESTA HU no usa el registry — recibe `token` + `chainId` directamente como args (ver DT-A) |
| `package.json` | Deps disponibles | viem `^2.47.6` (instalado 2.48.4), zod `^3.23.8`, vitest `^2.1.8`, node ≥20, TS strict |
| `tsconfig.json` | TS config | `module: Node16`, `strict: true`, `noUncheckedIndexedAccess: true`. Los imports ESM requieren `.js` extension en los paths |
| `eslint.config.js` + legacy `.eslintrc.json` via FlatCompat | Lint rules | `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/consistent-type-imports: error`, `security/detect-object-injection: warn` (ojo con `authorization[field]` dinámico), `no-console: warn`, `no-secrets/no-secrets: error` con tolerance 4.5 |
| `vitest.config.ts` | Test config | `include: ['src/**/*.test.ts']`. `NODE_ENV=test`, `LOG_LEVEL=silent` (no aplica a esta HU — no logueamos) |
| `src/__tests__/unit/chain-adapter.test.ts` | Exemplar test pattern | Usa `beforeEach`/`afterEach` snapshotting env. Usa `await expect(promise).rejects.toThrow(...)` para errors. Nosotros NO usamos env-snapshot (la función es pura), ni rejects (no throwea) |
| `src/__tests__/unit/core-types.test.ts` | Patrón de test de tipos | (si existe) patrón para narrowing de `Result<T>` con `if (!result.ok)` guard |
| `doc/sdd/_INDEX.md` | Registry | HU 005 "in progress" — se cerrará a DONE al final |
| `doc/sdd/004-wfac-5-redis-client/sdd.md` | Plantilla/convenciones | 15 secciones, readiness check, tabla de CDs, waves |
| `doc/sdd/004-wfac-5-redis-client/story-WFAC-5.md` | Plantilla Story File | Sección "Contract con el Dev", shapes exactos, anti-hallucination checklist explícita |

### Auto-Blindaje histórico (lecciones aprendidas aplicadas a esta HU)

Leí los tres auto-blindajes disponibles. Patrones aplicables:

| Hallazgo previo | HU | Cómo aplica a WFAC-6 | Tratamiento |
|-----------------|-----|----------------------|-------------|
| `security/detect-object-injection` dispara en `process.env[name]` dinámico | WFAC-4 | En `verify.ts` NO hacemos indexing dinámico a `authorization[field]` — leemos campos explícitos (`authorization.from`, `.to`, `.value`, etc.). Si el Zod schema itera keys, debe hacerlo con un object literal estático | CD extra: PROHIBIDO indexing dinámico — leer cada campo explícitamente por su key literal |
| `vi.resetModules()` invalida `instanceof` | WFAC-4 | No aplica — esta HU no usa `vi.resetModules()`. La función es pura, no hay singletons a resetear | N/A |
| Double parseEnv en bootstrap | WFAC-2 | No aplica — esta HU NO toca env ni bootstrap | N/A |
| CJS default import en Node16 + ioredis | WFAC-5 | Aplica a los imports de viem. viem tiene ESM nativo, pero el alias `default` vs named es relevante. Leí `node_modules/viem/package.json` y los tipos: `recoverTypedDataAddress`, `isAddressEqual`, `getAddress` son **named exports** desde `'viem'`. `privateKeyToAccount` es named export desde `'viem/accounts'`. `signTypedData` (para fixtures) también desde `'viem/accounts'` | CD extra: OBLIGATORIO imports named explícitos. PROHIBIDO `import viem from 'viem'` o `import * as viem` |
| Tests con `LOG_LEVEL=silent` | WFAC-2 | No aplica — esta HU no emite logs. La función es pura y NO recibe logger (ver CD-5 del work-item) | N/A |

**Ningún auto-blindaje previo cubre lecciones crypto/EIP-712** (las 3 HUs previas son
infra/chain registry, no criptografía). Esta es la **primera HU criptográfica** del
proyecto — los riesgos están bien documentados en sección 10 (Risks) para que futuras
HUs los hereden.

### Lectura obligatoria en `node_modules/` (post-cutoff — viem 2.48.4)

| Path | Verificado | Hallazgo concreto |
|------|-----------|------------------|
| `node_modules/viem/package.json` | Sí | Versión `2.48.4`. `type: module`. Exports `./accounts` separado de `.` |
| `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` | Sí | `recoverTypedDataAddress(parameters: { domain, types, primaryType, message, signature: Hex \| ByteArray \| Signature }): Promise<Address>`. Retorna la address recuperada directamente |
| `node_modules/viem/_types/utils/signature/verifyTypedData.d.ts` | Sí | Alternativa: `verifyTypedData({...same..., address: Address}): Promise<boolean>`. Confirmado DT-A: usar `recoverTypedDataAddress` porque necesitamos la address para `VerifyResult.client` — `verifyTypedData` solo devuelve bool |
| `node_modules/viem/_types/utils/address/isAddressEqual.d.ts` | Sí | `isAddressEqual(a: Address, b: Address): boolean`. Case-insensitive. Throws `InvalidAddressErrorType` si el input no es una Address válida |
| `node_modules/viem/_types/utils/address/getAddress.d.ts` | Sí | `getAddress(address: string, chainId?: number): Address`. Checksumming EIP-55 (si chainId está, aplica EIP-1191). Usamos sin chainId para checksum estándar |
| `node_modules/viem/_types/accounts/privateKeyToAccount.d.ts` | Sí | `privateKeyToAccount(privateKey: Hex, options?): PrivateKeyAccount`. El account expone `.signTypedData(parameters)` — lo usaremos en fixtures de test |
| `node_modules/viem/_types/accounts/utils/signTypedData.d.ts` | Sí | `signTypedData({ privateKey, domain, types, primaryType, message }): Promise<Hex>`. Firma el shape correcto para recover |
| `node_modules/viem/_types/types/typedData.d.ts` | Sí | `TypedDataDefinition<typedData, primaryType>` = `{ types, primaryType, domain?, message }`. El tipo `TypedData` viene de `abitype`: `Record<string, readonly TypedDataParameter[]>` |
| `node_modules/abitype/dist/types/abi.d.ts` (lines 121–127) | Sí | `TypedDataDomain = { chainId?: number \| bigint, name?: string, salt?: ..., verifyingContract?: Address, version?: string }`. Todos opcionales — nuestro builder llena los 4 que usa EIP-3009, omite `salt` |

**Verificación cross-check**: `recoverTypedDataAddress` usa `hashTypedData` internamente,
que a su vez computa el domain separator igual que un contrato Solidity con
`keccak256(abi.encode(typehash, ...))`. Por tanto **los valores que pasamos en `domain`
deben ser EXACTAMENTE los que el token usa** — cualquier mismatch (e.g., `name: "USD Coin"`
vs `name: "USDC"`) resulta en una recovered address distinta y fallo de verificación.
Esto es R3 en sección 10.

### Exemplars confirmados para el Dev

| Path | Existe | Uso |
|------|--------|-----|
| `src/chains/types.ts` | Sí (153 líneas) | Import `type { EIP3009Token, VerifyParams, VerifyResult, AdapterResult }`. TYPE-ONLY import (boundary OWNERS) |
| `src/core/types.ts` | Sí (66 líneas) | Import `type { Address, ChainId, X402ErrorCode, Result }`. TYPE-ONLY import (OWNERS permite `chains/types.ts` pero `core/types.ts` entra via re-export de `chains/types.ts` — ver DT-F abajo) |
| `src/methods/eip3009/` | Existe (`.gitkeep` vacío) | Root del nuevo método |
| `src/__tests__/unit/methods/eip3009/` | NO existe | Crear en W0 junto con el primer test |
| `node_modules/viem/index.d.ts` | Sí | Re-exporta `recoverTypedDataAddress`, `isAddressEqual`, `getAddress`, `verifyTypedData` desde root |
| `node_modules/viem/accounts/index.d.ts` | Sí | Re-exporta `privateKeyToAccount`, `signTypedData` desde `viem/accounts` |

---

## 4. Exemplar Verification (paths confirmados)

| Path | Verificación | Patrón extraído |
|------|--------------|-----------------|
| `src/chains/types.ts` | `Read` OK, 153 líneas | `EIP3009Token { address, symbol, decimals, name, eip712Name?, eip712Version? }`. `VerifyParams` con shape x402 completo. `VerifyResult` con 7 campos (verified true, client, amount, asset, network, payTo, expiresAt) |
| `src/core/types.ts` | `Read` OK, 66 líneas | `Result<T>` + `X402ErrorCode` literal union. `Address = 0x${string}` simple alias |
| `src/chains/kite.ts` | `Read` OK, 141 líneas | Exemplar de adapter — NO tocar. Confirma que nuestro método es llamado desde el adapter, pero eso es WFAC-10, no WFAC-6 |
| `package.json` | `Read` OK | viem 2.47.6 declarado, zod 3.23.8, vitest 2.1.8, no ethers, no @noble |
| `tsconfig.json` | `Read` OK | `module: Node16` obliga extensions `.js` en imports |
| `eslint.config.js` + `.eslintrc.json` | `Read` OK | Reglas confirmadas |
| `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` | `Read` OK | Firma verificada |
| `node_modules/viem/_types/utils/address/isAddressEqual.d.ts` | `Read` OK | Firma verificada |
| `node_modules/viem/_types/utils/address/getAddress.d.ts` | `Read` OK | Firma verificada |
| `node_modules/viem/_types/accounts/privateKeyToAccount.d.ts` | `Read` OK | Firma verificada |
| `node_modules/viem/_types/accounts/utils/signTypedData.d.ts` | `Read` OK | Firma verificada |
| `node_modules/abitype/dist/types/abi.d.ts` | `Read` OK, line 121–127 | `TypedDataDomain` shape verificado |

Archivos mencionados en el SDD pero que aún NO existen (creados por esta HU):

- `src/methods/eip3009/abi.ts` → CREATE (W0)
- `src/methods/eip3009/schemas.ts` → CREATE (W0)
- `src/methods/eip3009/domain.ts` → CREATE (W1)
- `src/methods/eip3009/verify.ts` → CREATE (W2)
- `src/methods/eip3009/index.ts` → CREATE (W2, barrel)
- `src/__tests__/unit/methods/eip3009/domain.test.ts` → CREATE (W1)
- `src/__tests__/unit/methods/eip3009/verify.test.ts` → CREATE (W2 + W3)

Ningún path mencionado en el SDD fue inventado.

---

## 5. Decisiones Técnicas (DT-N)

### DT-A — `recoverTypedDataAddress` (heredado del work-item)

Confirmado. Usamos `recoverTypedDataAddress` (no `verifyTypedData`). Razón: obtenemos
directamente la Address recuperada, que es el `client` del `VerifyResult`. Una sola
llamada. Comparamos con `isAddressEqual(recovered, authorization.from)`.

### DT-B — EIP-712 domain shape (heredado del work-item)

Confirmado. Los 4 campos: `name`, `version`, `chainId`, `verifyingContract`. `salt` NO
se usa (no aplica a EIP-3009 canónico).

**Precedencia de resolución** (documentada aquí, nueva vs. work-item):

```ts
// src/methods/eip3009/domain.ts
function resolveName(token: EIP3009Token, accepted: VerifyParams['accepted']): string {
  return token.eip712Name ?? accepted.extra.name ?? token.name;
}

function resolveVersion(token: EIP3009Token, accepted: VerifyParams['accepted']): string {
  return token.eip712Version ?? accepted.extra.version ?? '1';
}
```

**Justificación de fallbacks**:

1. `eip712Name`/`eip712Version` del registro son la fuente canónica (definido por el
   operador del facilitator).
2. Si no están, `accepted.extra.name`/`.extra.version` son la segunda fuente (el merchant
   declaró qué domain usó el cliente).
3. Si tampoco están, `token.name` (metadata genérica) + `'1'` (versión default de EIP-712)
   — último recurso. Si el token real no usa esta combinación, la firma no recuperará la
   address esperada y fallará `INVALID_SIGNATURE` — es el fail-safe correcto.

**Nota sobre PYUSD Kite**: el work-item menciona "Missing Input: Domain salt para PYUSD en
Kite testnet". **Resolución**: EIP-3009 NO usa `salt`. El contrato deployado de PYUSD
(verificado contra el estándar Circle USDC/PayPal PYUSD — ambos implementan EIP-3009 sin
salt) solo setea los 4 campos canónicos. El registro de chain debe popular `eip712Name`
y `eip712Version` por chain — lo hará WFAC-10 al cargar tokens, no es responsabilidad
de esta HU.

### DT-C — Timestamp off-chain (heredado del work-item)

Confirmado. Usamos `Math.floor(Date.now() / 1000)`. NO consultamos `block.timestamp`.

**Risk bounded** (R4 en sección 10): drift del reloj del servidor. Mitigación: la ventana
`validBefore - validAfter` típica es 5-10 minutos; un drift de ≤30s del servidor NTP
no causa rechazos falsos. En producción asumimos NTP sync (Railway lo provee).

### DT-D — Raw hex signature (heredado del work-item)

Confirmado. `VerifyParams.payload.signature: 0x${string}` se pasa directamente a
`recoverTypedDataAddress`. viem acepta `Hex | ByteArray | Signature` — el caso Hex es el
primer overload. Normalización EIP-2098 (compact 64-byte) es WFAC-13, fuera de scope.

### DT-E — Zod schemas locales (refinamiento del work-item)

El work-item dejaba abierto si `core/schemas.ts` se pre-crea acá o espera a WFAC-20.
**Resolución del Architect**: NO se crea `core/schemas.ts` en esta HU. Creamos
`src/methods/eip3009/schemas.ts` con solo el sub-schema del `authorization` (el que
necesitamos validar en profundidad para el nonce format y los uint256 strings).

Justificación:

1. OWNERS.md: `src/methods/<method>/` NO puede importar de `src/core/*`. Crear el schema
   ahí obligaría a leerlo desde el método, violando boundary.
2. El caller de `verifyEip3009` (core/verify.ts en WFAC-20) va a hacer su propio Zod de
   `VerifyParams` antes de llamar al método. Nosotros recibimos un input ya pre-validado
   en shape estructural. El Zod local acá es una **segunda capa** (defense in depth) que
   valida invariantes específicas del método (nonce format, uint256 parseable).
3. Mantener el schema local permite que WFAC-14 (permit2) y WFAC-15 (erc7710) tengan
   schemas distintos sin superposición.

**Shape exacto del schema local**:

```ts
// src/methods/eip3009/schemas.ts
import { z } from 'zod';

// 0x + 64 hex chars (bytes32)
export const Bytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'nonce must be 0x-prefixed 32-byte hex');

// 0x + 40 hex chars (address) — shape-only, NOT checksum validation
export const AddressHexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'address must be 0x-prefixed 20-byte hex');

// Decimal uint256 as string: digits only, no negatives, <= 78 chars (2^256-1 has 78 digits)
export const Uint256StringSchema = z
  .string()
  .regex(/^\d+$/u, 'value must be a decimal uint256 string')
  .refine((s) => {
    try {
      const n = BigInt(s);
      return n >= 0n && n <= 2n ** 256n - 1n;
    } catch {
      return false;
    }
  }, 'value out of uint256 range');

export const Eip3009AuthorizationSchema = z.object({
  from: AddressHexSchema,
  to: AddressHexSchema,
  value: Uint256StringSchema,
  validAfter: Uint256StringSchema,
  validBefore: Uint256StringSchema,
  nonce: Bytes32HexSchema,
});
```

**Manejo de falla**: si el Zod falla, la función **retorna** `{ ok: false, error: { code:
'INVALID_SIGNATURE', message: 'Authorization payload malformed', http: 401 } }`. NO
throwea (CD-2). Acorde con AC-3 y CD-11 del work-item.

### DT-F — Boundary relaxation para `core/types.ts`

OWNERS.md dice: "`src/methods/<method>/` puede importar `src/chains/types.ts` (solo
tipos), viem, ABIs propias". PROHIBIDO `src/core/*`.

**Problema**: `src/chains/types.ts` hace re-export de `Address`, `ChainId`,
`X402ErrorCode` desde `src/core/types.ts`. Si el método hace
`import type { Address } from '../../chains/types.js'`, técnicamente importa un re-export
de `core/types.ts`, pero NUNCA toca el namespace core directamente.

**Resolución**: permitir imports TYPE-ONLY desde `../../core/types.js` en métodos **solo
para los tipos primitivos** `Address`, `ChainId`, `X402ErrorCode`, `Result`. Esto es
consistente con lo que hace `src/chains/types.ts` (ver línea 23:
`import type { Result, Address, ChainId, X402ErrorCode } from '../core/types.js';`).

El Architect documenta esta excepción aquí para que AR la vea explícita:

> **Excepción OWNERS**: `src/methods/eip3009/` puede hacer `import type` (NUNCA runtime)
> desde `src/core/types.js` para los primitivos `Address`, `ChainId`, `X402ErrorCode`,
> `Result`. Esto es equivalente a lo que hace `src/chains/types.ts` (mismo boundary
> relaxation). La regla prohibida sigue siendo: imports runtime desde `src/core/*` y
> cualquier import desde `src/chains/registry.ts`, `src/routes/`, o métodos vecinos.

Alternativa rechazada: re-exportar los tipos desde `src/chains/types.ts`. Rechazada
porque acoplaría métodos al módulo chains innecesariamente (el método no depende de
chains — depende de tipos x402).

### DT-G — Generación de fixtures de firma en tests (refuerza CD-8)

Los tests NO usan fixtures hardcodeados tomados de internet (riesgo: firmas obsoletas,
domains mutados, imposibles de re-generar). En su lugar:

```ts
// Hardhat/Anvil account #0 — conocimiento público (documented Hardhat default accounts)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
```

El helper de tests:

```ts
async function signFixture(
  privateKey: `0x${string}`,
  domain: TypedDataDomain,
  message: Eip3009AuthorizationMessage,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });
}
```

Cada test llama a este helper con su input específico. Las variantes "firmar con domain
diferente" o "firmar con message diferente" se consiguen mutando el input — nunca
mutando la firma a mano.

**Ventaja**: si viem bumpea su implementación EIP-712, los tests se regeneran solos —
mantienen contrato semántico, no hex literal.

### DT-H — Manejo de `try/catch` en `recoverTypedDataAddress`

El work-item AC-3 pide: "if `recoverTypedDataAddress` throws → `INVALID_SIGNATURE`".
Esto es conceptualmente simple pero requiere precisión del catch:

```ts
let recovered: Address;
try {
  recovered = await recoverTypedDataAddress({
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: params.payload.authorization,
    signature: params.payload.signature,
  });
} catch (err: unknown) {
  // PROHIBIDO inspeccionar err.message ni err.code — son implementation-defined
  // y pueden cambiar entre versiones de viem. El único contrato es: si throwea,
  // la firma está malformada → INVALID_SIGNATURE.
  return errInvalidSignature('Failed to recover typed data address');
}
```

**Por qué `catch (err: unknown)`**: `tsconfig.strict` activa `useUnknownInCatchVariables`.
`err` es `unknown`. No hacemos narrowing — no necesitamos la información, solo el hecho
de que throwó.

**Por qué NO `catch` sin variable**: ESLint suele permitirlo pero `@typescript-eslint`
recomienda capturar para evidenciar que sabemos del error. `_err` sería equivalente pero
el naming `err` es el convencional en el resto del proyecto.

**No se envía `err.message` al logger** porque el módulo NO logea (CD-5 del work-item).
El mensaje human-readable del Result es fijo ("Failed to recover typed data address") y
NO incluye PII/signature bytes (defensa en profundidad contra PII leaks en logs del
caller).

### DT-I — Comparación de addresses: `isAddressEqual` obligatorio

El work-item CD-10 lo especifica. Detalles:

1. `isAddressEqual(a, b)` throwea `InvalidAddressError` si cualquiera de los inputs no
   es una Address válida (no cumple shape 0x + 40 hex). Pero el Zod schema
   `AddressHexSchema` garantiza el shape ANTES de llamar isAddressEqual. Caso imposible
   en nuestro flow.
2. La comparación es case-insensitive — checksum no importa.
3. `recoverTypedDataAddress` devuelve la address en formato checksummed. `authorization.from`
   llega del cliente en formato arbitrario. `isAddressEqual` normaliza ambos antes de
   comparar → seguro.

**Aplicamos isAddressEqual también para `authorization.to` vs `accepted.payTo`** (AC-9).
Mismo razonamiento.

### DT-J — Orden de checks: fail-fast pre-crypto

El work-item no dicta orden explícito. El Architect propone este orden (documentado para
que AR lo valide):

1. **Zod validation** del `authorization` → si falla → `INVALID_SIGNATURE` (AC-3 cubre
   casos de malformado; nonce inválido también es CD-11 → `INVALID_SIGNATURE`).
2. **Network match**: `accepted.network === 'eip155:' + chainId` → si no,
   `NETWORK_MISMATCH` (AC-8).
3. **Asset present in token registry** (registry implícito: el adapter pasa `token`;
   WFAC-10 valida que `accepted.asset === token.address` antes de dispatchar. PERO
   también lo revalidamos acá como defense-in-depth con `isAddressEqual`) → si no,
   `NETWORK_MISMATCH` (AC-11).
4. **Amount validation**: `accepted.amount === '0'` → `INVALID_AMOUNT` (AC-7).
   `BigInt(authorization.value) < BigInt(accepted.amount)` → `INVALID_AMOUNT` (AC-6).
5. **Receiver match**: `isAddressEqual(authorization.to, accepted.payTo)` → si no,
   `INVALID_RECEIVER` (AC-9).
6. **Timestamp window**:
   - `Number(validBefore) <= nowSec` → `EXPIRED_AUTHORIZATION` (AC-4).
   - `Number(validAfter) > nowSec` → `EXPIRED_AUTHORIZATION` (AC-5).
7. **Build domain + recover** (crypto). Try/catch → `INVALID_SIGNATURE` on throw (AC-3).
8. **isAddressEqual(recovered, authorization.from)** → si no, `INVALID_SIGNATURE` (AC-2).
9. **Return success** → `VerifyResult` con `client: getAddress(recovered)`,
   `expiresAt: Number(validBefore)`, resto de campos del `accepted` (AC-1, AC-12).

**Nota sobre el paso 3 (asset recheck)**: el método recibe `token: EIP3009Token` — la
decisión de "qué token usar" fue del caller (el adapter). Pero el adapter pudo haber
hecho match aproximado o por símbolo. Re-chequeamos `isAddressEqual(accepted.asset,
token.address)` para garantizar que el recover usa el contract correcto (si no,
verifyingContract del domain está equivocado → firma inválida, pero el error code más
semántico es NETWORK_MISMATCH).

---

## 6. Constraint Directives (CD-N)

CDs 1-13 heredados del work-item quedan activos literal. Agregamos 3 más a partir del
análisis de codebase:

### CDs heredados del work-item (mantener literal)

- **CD-1**: PROHIBIDO importar desde `src/core/*` (excepto type-only primitives via
  DT-F), `src/chains/registry.ts`, `src/routes/`, u otros métodos.
- **CD-2**: PROHIBIDO throw por condiciones previsibles. Todo es Result. Excepciones
  de viem se capturan con try/catch.
- **CD-3**: PROHIBIDO hardcodear name/version/chainId/contract address — todo viene
  de params.
- **CD-4**: OBLIGATORIO viem exclusivo. PROHIBIDO ethers.js, @noble/secp256k1 directo,
  web3.js.
- **CD-5**: PROHIBIDO `console.log`. La función NO recibe logger — el caller logea el
  Result.
- **CD-6**: OBLIGATORIO firma con tipos explícitos, sin `any`:
  ```ts
  export async function verifyEip3009(
    params: VerifyParams,
    token: EIP3009Token,
    chainId: ChainId,
  ): Promise<AdapterResult<VerifyResult>>
  ```
- **CD-7**: OBLIGATORIO `buildEip3009Domain` es función pura, exportada desde
  `domain.ts`.
- **CD-8**: PROHIBIDO keys reales u on-chain calls en tests. Fixtures con Hardhat
  account #0.
- **CD-9**: OBLIGATORIO `EIP3009_TYPES` constante en `abi.ts`.
- **CD-10**: PROHIBIDO `===` o `.toLowerCase()` para addresses. Usar `isAddressEqual`.
- **CD-11**: OBLIGATORIO nonce es `0x` + 64 hex chars. Nonce mal formado →
  `INVALID_SIGNATURE`.
- **CD-12**: OBLIGATORIO ≥1 test por AC con check explícito de `error.code`.
- **CD-13**: PROHIBIDO rutas relativas que crucen boundary del método.

### CDs nuevos (del análisis de codebase y auto-blindaje)

- **CD-14 (nuevo, de WFAC-5 auto-blindaje + boundary OWNERS)**: OBLIGATORIO imports
  named explícitos desde viem. Ejemplo OK:
  ```ts
  import { recoverTypedDataAddress, isAddressEqual, getAddress } from 'viem';
  import { privateKeyToAccount } from 'viem/accounts';
  ```
  PROHIBIDO: `import viem from 'viem'`, `import * as viem from 'viem'`. Violación → CR
  BLOQUEANTE.

- **CD-15 (nuevo, de WFAC-4 auto-blindaje)**: PROHIBIDO indexing dinámico sobre
  `authorization` (i.e., `authorization[field]` con `field` variable). Esto dispara
  `security/detect-object-injection` que está en `warn` + `--max-warnings 0`. Leer cada
  campo por key literal. Violación → CR BLOQUEANTE.

- **CD-16 (nuevo, DT-F excepción boundary)**: Los imports type-only desde
  `src/core/types.js` están permitidos SOLO para los 4 primitivos (`Address`, `ChainId`,
  `X402ErrorCode`, `Result`). Cualquier otro import (incluido runtime) desde `src/core/*`
  es BLOQUEANTE.

### CD — cuadro resumen (para AR/CR)

| CD | Tipo | Archivo donde aplica | Check de AR |
|----|------|----------------------|-------------|
| CD-1 | Import boundary | todos `src/methods/eip3009/*.ts` | grep imports, verificar no hay `from '../../core/`, `from '../../chains/registry'`, `from '../../routes/'`, `from '../permit2/'` |
| CD-2 | No throw | `verify.ts`, `domain.ts`, `schemas.ts` | grep `throw ` — solo permitido dentro de try/catch block del recover |
| CD-3 | No hardcodes | `verify.ts`, `domain.ts` | grep por literals hex (contract addresses), por `"1"` string fuera del fallback de version |
| CD-4 | viem only | todos | grep `from 'ethers'`, `from '@noble'`, `from 'web3'` → si aparece, BLOQUEANTE |
| CD-5 | No console | todos | grep `console\.` |
| CD-6 | Typed signature | `verify.ts` | verificar export matches shape |
| CD-7 | Pure domain builder | `domain.ts` | no side effects, no await, no I/O |
| CD-8 | Test fixtures | `verify.test.ts`, `domain.test.ts` | grep `TEST_PRIVATE_KEY`, NO hex literal de 65 bytes como signature (excepto el generado por signFixture) |
| CD-9 | EIP3009_TYPES exportado | `abi.ts` | `export const EIP3009_TYPES` presente |
| CD-10 | isAddressEqual | `verify.ts` | grep `===` adyacente a address vars → BLOQUEANTE si aplica a addresses |
| CD-11 | nonce validation | `schemas.ts`, `verify.ts` | `Bytes32HexSchema.parse(authorization.nonce)` presente |
| CD-12 | 1 test por AC | `verify.test.ts` | contar describe blocks — mínimo 12 (uno por AC-1..AC-12) |
| CD-13 | No cross-boundary relative | todos | grep `from '../../../` → si sale fuera de `src/methods/eip3009/` → BLOQUEANTE |
| CD-14 | named imports viem | todos | grep `import viem`, `import * as viem` → BLOQUEANTE |
| CD-15 | no dynamic indexing | todos | grep `authorization\[` con var dentro del `[...]` |
| CD-16 | core/types type-only | todos | verificar `import type` delante de imports desde `../../core/types` |

---

## 7. Waves de implementación

| Wave | Objetivo | Archivos | Bloqueo |
|------|----------|----------|---------|
| **W0** (serial) | Constantes + Zod schemas locales | `src/methods/eip3009/abi.ts` (CREATE), `src/methods/eip3009/schemas.ts` (CREATE), `src/methods/eip3009/index.ts` (CREATE, barrel stub) | Ninguno — primera wave |
| **W1** (serial) | Domain builder puro + tests unitarios | `src/methods/eip3009/domain.ts` (CREATE), `src/__tests__/unit/methods/eip3009/domain.test.ts` (CREATE) | Requires W0 (usa `EIP3009_TYPES` no, pero sí tipos de `chains/types.ts`) |
| **W2** (serial) | Función `verifyEip3009` + happy path + error paths (ACs 1, 2, 3, 6, 7, 8, 9, 11, 12) | `src/methods/eip3009/verify.ts` (CREATE), `src/__tests__/unit/methods/eip3009/verify.test.ts` (CREATE) | Requires W1 (usa `buildEip3009Domain`) |
| **W3** (serial) | Edge cases: ACs 4, 5, 10; además hardening (nonce malformado, domain mismatch, amount=value, signature bytes inválidos) | `src/__tests__/unit/methods/eip3009/verify.test.ts` (EXTEND) | Requires W2 |

**Entre waves**: `npm run typecheck && npm run test` deben pasar. `npm run qa` al final
de W3.

### Detalle por wave

**W0 — Constants + schemas**

Archivos:

- `src/methods/eip3009/abi.ts`:
  ```ts
  /**
   * EIP-3009 TransferWithAuthorization typed data definition.
   *
   * This array is consumed by:
   *   - viem's recoverTypedDataAddress (at runtime in verify.ts)
   *   - viem's signTypedData (in test fixtures via privateKeyToAccount)
   *
   * Source of truth: the TransferWithAuthorization struct as specified in
   * EIP-3009 (https://eips.ethereum.org/EIPS/eip-3009).
   */
  export const EIP3009_TYPES = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;

  export const EIP3009_PRIMARY_TYPE = 'TransferWithAuthorization' as const;
  ```
  Nota: `as const` es obligatorio para que viem pueda inferir el tipo exacto. Sin `as
  const` el tipo se ensancha a `string` y viem rechaza con `TypedDataInvalid`.

- `src/methods/eip3009/schemas.ts`: (ver DT-E arriba para shape completo).

- `src/methods/eip3009/index.ts` (barrel):
  ```ts
  export { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';
  // W1: export { buildEip3009Domain } from './domain.js';
  // W2: export { verifyEip3009 } from './verify.js';
  ```

**W1 — Domain builder**

`src/methods/eip3009/domain.ts`:

```ts
import type { TypedDataDomain } from 'viem';
import type { EIP3009Token, VerifyParams } from '../../chains/types.js';
import type { ChainId } from '../../core/types.js'; // DT-F excepción

/**
 * Pure builder for the EIP-712 domain used by EIP-3009 TransferWithAuthorization.
 *
 * Resolution precedence:
 *   - name:    token.eip712Name ?? accepted.extra.name ?? token.name
 *   - version: token.eip712Version ?? accepted.extra.version ?? '1'
 *   - chainId: numeric chainId (NOT the string 'eip155:<id>')
 *   - verifyingContract: token.address
 *
 * No side effects. No I/O.
 */
export function buildEip3009Domain(
  token: EIP3009Token,
  chainId: ChainId,
  accepted: VerifyParams['accepted'],
): TypedDataDomain {
  return {
    name: token.eip712Name ?? accepted.extra.name ?? token.name,
    version: token.eip712Version ?? accepted.extra.version ?? '1',
    chainId: Number(chainId), // ChainId is branded number
    verifyingContract: token.address,
  };
}
```

Tests `domain.test.ts` (≥5 tests):

1. `returns domain with name from token.eip712Name when present`.
2. `falls back to accepted.extra.name when eip712Name absent`.
3. `falls back to token.name when both eip712Name and extra.name absent`.
4. `version defaults to '1' when all fallbacks absent`.
5. `chainId is numeric, not the eip155 string`.
6. `verifyingContract is token.address verbatim`.
7. (hardening) `returns no salt field` (EIP-3009 canónico).

**W2 — verifyEip3009 + core tests**

`src/methods/eip3009/verify.ts`:

```ts
import {
  recoverTypedDataAddress,
  isAddressEqual,
  getAddress,
} from 'viem';
import type { Address } from 'viem';
import type { EIP3009Token, VerifyParams, VerifyResult, AdapterResult }
  from '../../chains/types.js';
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { Eip3009AuthorizationSchema } from './schemas.js';
import { buildEip3009Domain } from './domain.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';

function err(code: X402ErrorCode, message: string, http: number): AdapterResult<VerifyResult> {
  return { ok: false, error: { code, message, http } };
}

export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>> {
  // 1. Shape validation (Zod)
  const authParse = Eip3009AuthorizationSchema.safeParse(params.payload.authorization);
  if (!authParse.success) {
    return err('INVALID_SIGNATURE', 'Authorization payload malformed', 401);
  }
  const authorization = authParse.data;

  // 2. Network match
  const canonicalNetwork = `eip155:${Number(chainId)}`;
  if (params.accepted.network !== canonicalNetwork) {
    return err('NETWORK_MISMATCH', 'Network does not match chain', 400);
  }

  // 3. Asset match (defense-in-depth vs caller error)
  if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
    return err('NETWORK_MISMATCH', 'Asset not found in chain token registry', 400);
  }

  // 4. Amount validation
  const acceptedAmount = BigInt(params.accepted.amount);
  if (acceptedAmount === 0n) {
    return err('INVALID_AMOUNT', 'Accepted amount must be greater than zero', 400);
  }
  if (BigInt(authorization.value) < acceptedAmount) {
    return err('INVALID_AMOUNT', 'Authorized value is below accepted amount', 400);
  }

  // 5. Receiver match
  if (!isAddressEqual(authorization.to as Address, params.accepted.payTo as Address)) {
    return err('INVALID_RECEIVER', 'Receiver does not match payTo', 400);
  }

  // 6. Timestamp window
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(authorization.validBefore) <= nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization expired', 400);
  }
  if (Number(authorization.validAfter) > nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization not yet valid', 400);
  }

  // 7. Build domain + recover
  const domain = buildEip3009Domain(token, chainId, params.accepted);
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
      signature: params.payload.signature,
    });
  } catch {
    return err('INVALID_SIGNATURE', 'Failed to recover typed data address', 401);
  }

  // 8. Verify recovered matches claimed
  if (!isAddressEqual(recovered, authorization.from as Address)) {
    return err('INVALID_SIGNATURE', 'Recovered address does not match sender', 401);
  }

  // 9. Success
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

**W3 — edge cases**

Tests adicionales en `verify.test.ts`:

- `nonce con 63 hex chars (off-by-one)` → `INVALID_SIGNATURE`.
- `nonce con caracter no-hex ('0xZZ...' )` → `INVALID_SIGNATURE`.
- `validBefore === nowSec (boundary)` → `EXPIRED_AUTHORIZATION`.
- `validAfter === nowSec (boundary)` → OK (not expired).
- `amount === value exactly` → OK (boundary de AC-6).
- `signature con 130 chars sin '0x' prefix` → si Zod no valida el signature (es tipo
  `0x${string}` en TS pero no hay schema runtime), el `recoverTypedDataAddress` throwea
  → `INVALID_SIGNATURE`. Esto cubre defense-in-depth pero NO es un AC literal —
  documentado como test extra.
- `domain name mutation (simulating a malicious merchant)` → recover devuelve address
  diferente → `INVALID_SIGNATURE`.

---

## 8. Plan de tests (≥1 test por AC)

Tests en `src/__tests__/unit/methods/eip3009/verify.test.ts` (mapeo AC → test):

| AC | Descripción | Setup | Assert |
|----|-------------|-------|--------|
| AC-1 | Happy path: firma válida, recovered === from, todos los checks pasan | Firmar con Hardhat key #0, setear `from = TEST_SIGNER_ADDRESS`, network/asset/timestamp/amount correctos | `result.ok === true`, `result.verified === true`, `result.client === getAddress(TEST_SIGNER_ADDRESS)`, `result.expiresAt === Number(validBefore)` |
| AC-2 | Recovered !== from | Firmar con key #0, pero setear `from = algunaOtraAddress` (no la de key #0) | `result.ok === false`, `result.error.code === 'INVALID_SIGNATURE'`, `result.error.http === 401` |
| AC-3 | recoverTypedDataAddress throws (signature bytes malformados) | Setear `signature = '0x00' + 'aa'.repeat(64)` (shape válido pero bytes corruptos que hacen throw) | `result.error.code === 'INVALID_SIGNATURE'`, `result.error.http === 401` |
| AC-4 | validBefore <= nowSec | Setear `validBefore = String(nowSec - 1)` | `result.error.code === 'EXPIRED_AUTHORIZATION'`, `result.error.http === 400` |
| AC-5 | validAfter > nowSec | Setear `validAfter = String(nowSec + 3600)` (future) | `result.error.code === 'EXPIRED_AUTHORIZATION'`, `result.error.http === 400` |
| AC-6 | value < amount | Setear `authorization.value = '99'`, `accepted.amount = '100'` | `result.error.code === 'INVALID_AMOUNT'`, `result.error.http === 400` |
| AC-7 | accepted.amount === 0 | Setear `accepted.amount = '0'` | `result.error.code === 'INVALID_AMOUNT'`, `result.error.http === 400` |
| AC-8 | network mismatch | Setear `accepted.network = 'eip155:999'` con chainId = 2368 | `result.error.code === 'NETWORK_MISMATCH'`, `result.error.http === 400` |
| AC-9 | authorization.to !== accepted.payTo | Setear `authorization.to = addressA`, `accepted.payTo = addressB` | `result.error.code === 'INVALID_RECEIVER'`, `result.error.http === 400` |
| AC-10 | Domain integrity: build from registry, no hardcodes | Assert que `verifyEip3009` con un token que tiene `eip712Name: 'USD Coin'`, el recover usa ese nombre. Modificar el domain del signer a `'USD Coin Clone'` → debe fallar | Verify el happy path con registry-sourced domain; verify fallo al usar un domain "impostor" |
| AC-11 | accepted.asset no matches token.address | Setear `accepted.asset = '0x' + 'ff'.repeat(20)` (no la del token) | `result.error.code === 'NETWORK_MISMATCH'`, `result.error.http === 400` |
| AC-12 | Output contract: happy path retorna shape exacto | Mismo setup que AC-1 | `result.expiresAt === Number(validBefore)`, `result.client` es checksummed (via `getAddress`), `result.network === accepted.network`, `result.asset === token.address`, `result.amount === accepted.amount`, `result.payTo` checksummed |

Tests adicionales (no-AC, hardening):

- `T-H1`: nonce con 63 chars → `INVALID_SIGNATURE`.
- `T-H2`: nonce con chars no-hex (`'0xZZZZ...'`) → `INVALID_SIGNATURE`.
- `T-H3`: value === amount (boundary) → OK.
- `T-H4`: validAfter === nowSec (boundary) → OK.
- `T-H5`: validBefore === nowSec + 1 (boundary) → OK.
- `T-H6`: authorization.value > uint256 max (79 dígitos) → Zod rechaza → `INVALID_SIGNATURE`.
- `T-H7`: signature con longitud incorrecta (60 bytes) → recover throws → `INVALID_SIGNATURE`.
- `T-H8`: concurrent verify calls (dos fixtures distintas al mismo tiempo) no causan
  cross-talk — función es pura y stateless.

Tests de `domain.test.ts` (7 tests) listados en W1.

**Total mínimo de tests**: 12 ACs + 8 hardening + 7 domain = **27 tests**.

### Fixture setup pattern (shared test helper)

Al principio de `verify.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, TypedDataDomain } from 'viem';
import { verifyEip3009 } from '../../../../methods/eip3009/verify.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from '../../../../methods/eip3009/abi.js';
import type { EIP3009Token, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SIGNER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

const TEST_CHAIN_ID = asChainId(2368);

const TEST_TOKEN: EIP3009Token = {
  address: '0x00000000000000000000000000000000000000ff' as Address,
  symbol: 'TEST',
  decimals: 6,
  name: 'Test Token',
  eip712Name: 'Test Token',
  eip712Version: '1',
};

type AuthMessage = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
};

async function signFixture(
  domain: TypedDataDomain,
  message: AuthMessage,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return account.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message,
  });
}

function makeValidParams(
  nowSec: number,
  overrides?: Partial<VerifyParams>,
): VerifyParams {
  // builds a fully-valid VerifyParams; tests override specific fields to
  // exercise error branches.
  // ... implementation in story file §5.
}
```

---

## 9. Readiness Check

- [x] Todos los exemplars verificados con Read/Glob (sección 4).
- [x] Todos los CDs del work-item heredados + 3 nuevos (CD-14, CD-15, CD-16).
- [x] Los 12 ACs mapeados a tests con `error.code` explícito (sección 8).
- [x] Missing Inputs del work-item resueltos:
  - #1 core/schemas.ts → **Resuelto (DT-E)**: schemas locales en
    `src/methods/eip3009/schemas.ts`. No se pre-crea `src/core/schemas.ts` en esta HU.
  - #2 Nonce unicidad vs formato → **Resuelto (CD-11 + DT-E)**: verify off-chain solo
    valida formato `0x<bytes32>` via Zod. Unicidad es WFAC-7 (settle) vía chain RPC.
  - #3 Domain salt PYUSD Kite → **Resuelto (DT-B)**: EIP-3009 canónico NO usa salt. El
    work-item citaba esto del draft; el estándar final (PYUSD + USDC deployados en
    producción) usa solo los 4 campos. No se incluye salt en domain builder.
- [x] Stack confirmado: viem 2.48.4, zod 3.23.8, vitest 2.1.8, TS strict, Node ≥20.
- [x] OWNERS compliance: imports de `verify.ts` solo viem + types desde
  `chains/types.js` + types desde `core/types.js` (DT-F excepción documentada).
- [x] No `console.*` en ningún archivo productivo (CD-5).
- [x] Tests corren sin I/O real — todos los fixtures se generan offline con
  `privateKeyToAccount` + `signTypedData` (CD-8).
- [x] `[NEEDS CLARIFICATION]` markers: **CERO**.
- [x] Lecciones de Auto-Blindaje aplicadas: CD-14 (named imports), CD-15 (no dynamic
  indexing), estructura pure-function (no singleton, evita el problema de
  `vi.resetModules`).
- [x] Orden de validación explícito documentado (DT-J).
- [x] Try/catch en `recoverTypedDataAddress` con `catch (err: unknown)` sin narrowing
  (DT-H).
- [x] Total tests planeados ≥ 27 (12 ACs + 8 hardening + 7 domain).

**SDD is ready for SPEC_APPROVED gate.**

---

## 10. Risks

| # | Risk | Severidad | Mitigación |
|---|------|-----------|------------|
| **R1** | **viem version drift**: viem 2.48.4 cambia la firma de `recoverTypedDataAddress` o `signTypedData` en un patch release | Alta | Package.json pin `^2.47.6` → permite minor/patch bumps. Mitigación: (1) verificar `node_modules/viem/_types/...` en F3 antes de codear, igual que WFAC-5 (R1 de WFAC-5 auto-blindaje); (2) los tests usan fixtures generados por la MISMA viem del runtime — si viem cambia la firma del hash, tests se regeneran automáticamente (no hay hex literal fijo). Worst case: CI falla en build si firma rompe → detectado antes de deploy |
| **R2** | **Timestamp clock skew**: servidor con reloj mal sincronizado acepta o rechaza authorizations dentro de la ventana por ±N segundos | Media | (1) DT-C bound el risk: ventana típica del cliente 5-10min >> drift NTP esperado <2s. (2) Railway (prod) corre NTP. (3) Si drift es chronic, monitoring (WFAC-futuro) debería alertar. (4) Tests usan `Math.floor(Date.now() / 1000)` real (no mocked time) porque el rango de tolerancia del AC lo permite — alternativa rechazada: `vi.useFakeTimers()` porque reduce la confianza de "se ejecuta igual que prod" |
| **R3** | **Domain hash mismatch**: el `name`/`version` que setea el facilitator NO matchea lo que el contrato deployado hardcodea en su `EIP712_DOMAIN_TYPEHASH`. Resultado: recover devuelve una address consistente pero distinta a la esperada → `INVALID_SIGNATURE` incluso con firmas legítimas | Alta | (1) El registro de chain (WFAC-10) es responsable de popular `eip712Name`/`eip712Version` correctos, leyendo el contract on-chain (`contract.name()`, `contract.version()` estándares ERC-20). Pre-requisito documentado en el work-item de WFAC-10. (2) Esta HU NO puede verificar R3 por sí sola — depende del adapter que la llame. Test T-H (hardening) simula domain mutation para confirmar que la función detecta el mismatch correctamente. (3) Post-deploy debería haber un smoke-test en Kite testnet con PYUSD real que verifica una firma conocida — lo hará QA en F4 o WFAC-20 (integration test) |
| **R4** | **Signature format edge cases**: signature de 130 chars shape válido pero con `v` inválido (0, 1, 27, 28, otros) → recover puede throw o devolver zero-address | Media | (1) viem normaliza `v` internamente (acepta 0/1 y 27/28, rechaza otros con throw). (2) AC-3 + T-H7 cubren throw. (3) Zero-address recovery es imposible con signature shape válido + message válido + secp256k1 math — pero si pasara, `isAddressEqual(0x000...0, authorization.from)` siempre sería false (no hay account con from=zero-address firmando) → `INVALID_SIGNATURE` correcto. (4) EIP-2098 compact (64 bytes) es WFAC-13, fuera de scope |
| **R5** | **Boundary violation drift**: futuro Dev/CR acepta un import desde `src/core/*` que NO es `core/types.js`, rompiendo la excepción estrecha de DT-F | Media | (1) CD-16 explícito en esta sección (solo 4 tipos primitivos permitidos). (2) AR del PR tiene un grep específico en sección 6 (CD-16 check). (3) Considerar WFAC-futuro (post-V1): habilitar `eslint-plugin-boundaries` para enforzar por regla — ver OWNERS.md "Auditoría" |
| **R6** | **Nonce replay protection NO está en scope**: si el mismo nonce se firma dos veces con mismo domain+message, ambas firmas recuperan la misma address → verify pasa → dos settlements exitosos | Alta en integración | (1) **Responsabilidad explícita de WFAC-7 (settle)** — el check on-chain `wasAuthorizationUsed(nonce)` vive en `transferWithAuthorization` del contrato, + idempotency cache Redis (WFAC-5 + WFAC-21). (2) Esta HU NO es responsable por design — documentar en JSDoc del `verifyEip3009` que "the caller MUST ensure nonce uniqueness via chain adapter before settlement". (3) Scope OUT explícito en sección 1 |
| **R7** | **BigInt overflow/DoS**: un atacante envía `accepted.amount` con 1000 dígitos intentando slow `BigInt()` parse | Baja | (1) Zod `Uint256StringSchema` regex `^\d+$` + `.refine(BigInt(s) <= 2^256-1)` limita a ≤78 dígitos antes del parse. (2) Fastify default body limit es 1MB — antes de llegar a Zod el payload ya está bounded. (3) Test T-H6 cubre uint256 overflow |
| **R8** | **Test fixture cross-contamination**: si un test muta el objeto `TEST_TOKEN` in place, los siguientes tests ven el state corrupto | Baja | (1) `TEST_TOKEN` declarado con `as const` y shapes `readonly` — TypeScript previene mutación en compile-time. (2) Los tests nunca referencian mutable helpers — cada test llama `makeValidParams(nowSec)` que retorna nuevo objeto. (3) Vitest `describe`s no comparten state por default |

---

## 11. Dependencies

### Deps nuevas (package.json)

**Ninguna**. viem, zod, vitest ya instalados.

### Deps runtime importadas

- `viem` (named: `recoverTypedDataAddress`, `isAddressEqual`, `getAddress`)
- `viem/accounts` (solo en tests: `privateKeyToAccount`)
- `zod` (named: `z`)

### Deps dev

- `vitest` (ya instalado).
- `@types/node` (ya instalado).

### Type-only imports (no runtime)

- `type { Address, TypedDataDomain } from 'viem'`
- `type { EIP3009Token, VerifyParams, VerifyResult, AdapterResult } from '../../chains/types.js'`
- `type { ChainId, X402ErrorCode } from '../../core/types.js'` (DT-F excepción)

### Downstream dependencies unlocked

- WFAC-7 (settle logic) — unblocked.
- WFAC-10 (Kite chain adapter verify implementation) — unblocked.
- WFAC-20 (POST /verify route + core dispatcher) — unblocked.
- WFAC-13 (EIP-2098 compact signature normalization) — puede ir en paralelo.

### Upstream dependencies

- WFAC-4 (chain registry) — DONE (merged). Provee `EIP3009Token` + `ChainId` tipos.
- WFAC-5 (Redis client) — DONE. No directly needed, pero hermano en el roadmap.

---

## 12. Missing Inputs (resolved)

| Item | Resolución |
|------|-----------|
| `src/core/schemas.ts` no existe | **NO se pre-crea acá**. Schemas locales en `src/methods/eip3009/schemas.ts` (DT-E). WFAC-20 decide el shape de `core/schemas.ts` |
| Nonce format exact (bytes32 puro vs bytes16 packed) | **Resolución**: valida formato `0x` + 64 hex (bytes32), NO valida semántica (random vs counter). Uniqueness vive en WFAC-7 via `wasAuthorizationUsed` on-chain |
| Domain salt PYUSD Kite testnet | **Resolución**: EIP-3009 canónico NO usa salt. Los contratos deployados de USDC/PYUSD/EURC solo usan los 4 campos (`name`, `version`, `chainId`, `verifyingContract`). `TypedDataDomain` de abitype lo soporta como opcional — lo omitimos |

---

## 13. Uncertainty Markers

**Ninguno activo.** Todas las uncertainties del work-item fueron resueltas en DT-B/DT-E
y en sección 12. Si durante F3 el Dev encuentra un caso no cubierto, debe parar y
escalar al humano vía el orquestador (no implementar por libre — regla del skill
nexus-agile).

---

## 14. Notas adicionales

### Sobre el uso de `getAddress` en la salida

`VerifyResult.client` y `.payTo` se devuelven checksummed (EIP-55) via `getAddress(...)`.
Justificación: el x402 spec-literal dice "client: recovered signer address" sin precisar
casing, pero la industria (Circle, Coinbase) siempre devuelve checksummed en responses
JSON. Mantenemos esa convención para interoperabilidad.

### Sobre el `as Address` cast en verify.ts

Los strings en `params.payload.authorization.from/to` y `params.accepted.asset/payTo`
son `Address` en el tipo (sección 2 del work-item — ya tipados por el caller), pero en
runtime después del Zod safeParse tenemos `string` (el schema `AddressHexSchema` devuelve
string). El cast `as Address` es **seguro** porque:

1. Zod `AddressHexSchema` regex ya garantiza shape `0x` + 40 hex.
2. viem `isAddressEqual` y `recoverTypedDataAddress` aceptan `Address` (= `0x${string}`).
3. El cast NO es `as unknown as Address` — es un narrow cast desde un subtipo.

Alternativa considerada: usar `z.custom<Address>(...)` para que Zod devuelva
directamente `Address`. Rechazada: complica el schema sin beneficio funcional. El cast
explícito en el call-site es más legible y AR puede verificar que cada cast viene
precedido de una Zod validation.

### Sobre el orden de imports en `verify.ts`

Grouping convention (heredada del proyecto):

1. External deps (viem, zod).
2. Type-only imports (agrupados con `import type`).
3. Local runtime imports (relative `.js` paths).

Con `@typescript-eslint/consistent-type-imports: 'error'` activo, los type-only imports
se separan automáticamente. El Dev NO debe mezclar types y values en el mismo `import`
statement.

### Sobre la branch y el commit inicial

Branch `feat/005-wfac-6-eip3009-verify` debe crearse desde `main@00887c4` (post
WFAC-53). Verificar con `git rev-parse main`. Si ya está checked-out, rebase:
`git pull origin main && git rebase main`.

Primer commit del F3: `feat(WFAC-6): W0 — EIP3009 types + schemas + barrel stub`.

---

## 15. Implementation Readiness Check (pre-F3)

Antes de que el Dev empiece W0 en F3, esta lista DEBE estar 100% verde:

- [x] `doc/sdd/005-wfac-6-eip3009-verify/sdd.md` escrito (este archivo).
- [ ] Story File `story-WFAC-6.md` generado (F2.5 — próximo paso).
- [ ] Humano aprobó el SDD con texto literal `SPEC_APPROVED`.
- [x] Branch base identificado (`main@00887c4`).
- [x] Deps verificadas (viem 2.48.4, zod 3.23.8, vitest 2.1.8 instalados).
- [x] Exemplars accesibles (todos los Read OK en secciones 3 y 4).
- [x] Zero `[NEEDS CLARIFICATION]` en todo el SDD.
- [x] Waves ordenadas y con archivos exactos por wave.
- [x] Tests mapeados a ACs (sección 8, 27+ tests).
- [x] Risks identificados y mitigados (sección 10, 8 riesgos).
- [x] Auto-Blindaje histórico leído y aplicado (CD-14, CD-15).
- [x] Missing Inputs del work-item resueltos (sección 12).
- [x] DTs (A–J) todos explícitos, sin TBDs.

El Dev solo avanza a F3 DESPUÉS de SPEC_APPROVED humano.
