# Work Item — [WFAC-6] EIP-3009 Verify Logic

## Resumen

Implementar `src/methods/eip3009/verify.ts` — la función de verificación off-chain pura del método
EIP-3009. Recupera la dirección firmante via EIP-712 (`recoverTypedDataAddress` de viem), valida
el conjunto completo de pre-condiciones de la spec x402 (timestamp window, amount, asset/network
match, nonce format, payTo match, domain hash) y retorna un discriminated union `Result<VerifyResult>`.
Este módulo es la carga crítica del `POST /verify` y la primera mitad del path de `POST /settle`.

## Sizing

- SDD_MODE: full
- Estimación: M (1,5–2 días implementación + tests)
- Branch sugerido: `feat/005-wfac-6-eip3009-verify`
- Clasificación NexusAgil: QUALITY (money-moving, verificación de firmas criptográficas)

---

## Acceptance Criteria (EARS)

### Recuperación de firma

**AC-1:** WHEN `verify()` is called with a valid EIP-3009 `VerifyParams`, THEN the system SHALL
call `recoverTypedDataAddress` with the EIP-712 `TransferWithAuthorization` typed data, and SHALL
return `{ ok: true, verified: true, client: <recovered address>, ... }` when the recovered address
equals `payload.authorization.from` (case-insensitive checksummed comparison via viem
`isAddressEqual`).

**AC-2:** WHEN the recovered address does NOT equal `payload.authorization.from`, the system SHALL
return `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: '...', http: 401 } }` without
performing any further checks.

**AC-3:** IF `recoverTypedDataAddress` throws (malformed signature bytes, signature too short,
invalid v-value), THEN the system SHALL catch the exception and return
`{ ok: false, error: { code: 'INVALID_SIGNATURE', message: '...', http: 401 } }`.

### Timestamp window

**AC-4:** WHEN `Number(authorization.validBefore) <= Math.floor(Date.now() / 1000)`, the system
SHALL return `{ ok: false, error: { code: 'EXPIRED_AUTHORIZATION', http: 400 } }`.

**AC-5:** WHEN `Number(authorization.validAfter) > Math.floor(Date.now() / 1000)`, the system
SHALL return `{ ok: false, error: { code: 'EXPIRED_AUTHORIZATION', http: 400 } }`.

### Amount validation

**AC-6:** WHEN `BigInt(authorization.value) < BigInt(accepted.amount)`, the system SHALL return
`{ ok: false, error: { code: 'INVALID_AMOUNT', http: 400 } }`.

**AC-7:** WHEN `BigInt(accepted.amount) === 0n`, the system SHALL return
`{ ok: false, error: { code: 'INVALID_AMOUNT', http: 400 } }`.

### Network / asset / receiver match

**AC-8:** WHEN `accepted.network` does not equal the canonical network string for the token's
`chainId` (format `eip155:<chainId>`), the system SHALL return
`{ ok: false, error: { code: 'NETWORK_MISMATCH', http: 400 } }`.

**AC-9:** WHEN `authorization.to` does not equal `accepted.payTo` (case-insensitive address
comparison), the system SHALL return
`{ ok: false, error: { code: 'INVALID_RECEIVER', http: 400 } }`.

### EIP-712 domain integrity

**AC-10:** WHEN the EIP-712 domain is built for `recoverTypedDataAddress`, the system SHALL use
`{ name, version, chainId, verifyingContract }` sourced exclusively from `EIP3009Token` (registry
entry for the asset address), falling back to `accepted.extra.name` / `accepted.extra.version`
only when `EIP3009Token.eip712Name` / `EIP3009Token.eip712Version` are absent — it SHALL NOT
hardcode any domain field value.

**AC-11:** WHEN `accepted.asset` is NOT found in the chain registry's token list for the resolved
`chainId`, the system SHALL return
`{ ok: false, error: { code: 'NETWORK_MISMATCH', http: 400 } }`.

### Output contract

**AC-12:** WHEN all checks pass, the system SHALL return a `VerifyResult` whose `expiresAt` field
equals `Number(authorization.validBefore)`, `client` equals the checksummed recovered address
(via viem `getAddress`), and `network` equals the string from `accepted.network`.

---

## Scope IN

| Path | Descripción |
|------|-------------|
| `src/methods/eip3009/verify.ts` | Función principal `verifyEip3009(params, token, chainId)` |
| `src/methods/eip3009/domain.ts` | Builder puro `buildEip3009Domain(token, chainId)` → `TypedDataDomain` |
| `src/methods/eip3009/schemas.ts` | Zod schemas locales para VerifyParams + Authorization (puede reexportar de `src/core/schemas.ts` si ya existe) |
| `src/methods/eip3009/index.ts` | Re-export del módulo |
| `src/methods/eip3009/abi.ts` | ABI mínimo del tipo `TransferWithAuthorization` (EIP-3009) para typed data |
| `src/__tests__/unit/methods/eip3009/verify.test.ts` | Tests unitarios con fixtures (happy path + 10+ error cases) |
| `src/__tests__/unit/methods/eip3009/domain.test.ts` | Tests del domain builder |

## Scope OUT

- `src/methods/eip3009/settle.ts` — esa es WFAC-7
- `src/core/verify.ts` — orquestador core (WFAC-20, que llama al method)
- `src/routes/verify.ts` — route HTTP (WFAC-20)
- On-chain balance check (`balanceOf`) — pertenece al chain adapter (WFAC-7 o WFAC-20)
- Nonce uniqueness on-chain check (requiere RPC call) — pertenece al pre-settle chain-layer (WFAC-7)
- EIP-2098 compact signature normalization — WFAC-13 (ticket dedicado)
- Permit2 / ERC-7710 — métodos futuros

---

## Decisiones Técnicas

**DT-A — `recoverTypedDataAddress` vs `verifyTypedData`**

Usar `recoverTypedDataAddress`. Razón: devuelve la dirección recuperada que necesitamos para
poblar `VerifyResult.client`. `verifyTypedData` retorna un `boolean`, lo cual es suficiente
para "¿es válida?" pero nos obliga a llamar igual a `recoverTypedDataAddress` para obtener el
`client` address — dos calls en lugar de uno.

Ambas son funciones utilitarias puras (no requieren `PublicClient`). La variante del public client
(`publicClient.verifyTypedData`) agrega soporte EIP-1271 (smart contract wallets) pero requiere RPC
round-trip — fuera de scope V1.

Firma real validada contra `node_modules/viem/_types`:
```
recoverTypedDataAddress({ domain, types, primaryType, message, signature }) → Promise<Address>
verifyTypedData({ domain, types, primaryType, message, signature, address }) → Promise<boolean>
```

**DT-B — EIP-712 domain shape exacto para EIP-3009**

EIP-3009 usa cuatro campos canónicos: `{ name, version, chainId, verifyingContract }`.
- `name` → `EIP3009Token.eip712Name ?? accepted.extra.name ?? token.name`
- `version` → `EIP3009Token.eip712Version ?? accepted.extra.version ?? "1"`
- `chainId` → `ChainId` numérico (no el string `eip155:X`)
- `verifyingContract` → `EIP3009Token.address` (la address del token, tipada como `Address`)

El `salt` field del dominio NO se usa en EIP-3009 canónico. El `TypedDataDomain` de viem/abitype
lo soporta opcionalmente — dejarlo ausente. No hay `salt` en los payloads x402 de Kite/PYUSD.

**DT-C — Timestamp: `Date.now()/1000` vs `block.timestamp` RPC**

Para la fase de verify off-chain, usar `Math.floor(Date.now() / 1000)`. Razones:
1. El spec x402 explícitamente define `/verify` como off-chain — no hace RPC calls.
2. `block.timestamp` requiere una llamada RPC (`eth_getBlockByNumber`) que agrega ~100-300ms de
   latencia y un punto de fallo extra.
3. La ventana `validAfter/validBefore` ya incorpora slack (típico: 5-10 minutos). El drift
   servidor-blockchain (<2s) es despreciable contra esa ventana.
4. En la fase de settle (WFAC-7) se puede agregar un check adicional si se quiere confirmar
   contra `block.timestamp`, pero es opcional — la industria (Coinbase x402) hace off-chain
   timestamp en verify también.

**DT-D — Signature format: objeto `{v,r,s}` vs raw hex 65 bytes**

`VerifyParams.payload.signature` está tipado como `` `0x${string}` `` (raw hex). El contrato
`recoverTypedDataAddress` de viem acepta `Hex | ByteArray | Signature` — soporta ambos. Para V1
aceptar raw hex únicamente (65 bytes = `0x` + 130 chars). La normalización EIP-2098 (64 bytes,
compact) se maneja en WFAC-13 como pre-processing antes de llamar `verify.ts`. No agregar lógica
de normalización aquí para mantener la función pura y single-responsibility.

**DT-E — Zod schema granularity**

Crear `src/methods/eip3009/schemas.ts` con el sub-schema de validación del `authorization` object
(validAfter/validBefore son strings de uint256, nonce es `0x<64 hex chars>`). El schema raíz de
`VerifyParams` vive en `src/core/schemas.ts` (que no existe aún — Dev debe crearlo o el Architect
decidirá en F2 si core/schemas.ts se crea aquí o en WFAC-20). Para esta HU: schemas locales al
método, sin dependencia de core schemas (evitar acoplamiento prematuro mientras core no está
escrito).

---

## Constraint Directives

**CD-1:** PROHIBIDO importar desde `src/core/`, `src/chains/registry.ts`, `src/routes/`, u otros
métodos desde `src/methods/eip3009/`. Sólo imports permitidos: `src/chains/types.ts` (type-only),
viem, Zod, ABIs propias.

**CD-2:** PROHIBIDO que `verifyEip3009()` o cualquier función del módulo lancen excepciones por
condiciones de verificación previsibles. Toda condición de error retorna `Result<VerifyResult>`.
Las excepciones de `recoverTypedDataAddress` (firma malformada) deben capturarse con `try/catch`
y convertirse a `{ ok: false, error: { code: 'INVALID_SIGNATURE', ... } }`.

**CD-3:** PROHIBIDO hardcodear: nombre del token, versión del dominio, chain ID, contract address.
Todo viene de los parámetros recibidos (`EIP3009Token`, `ChainId`).

**CD-4:** OBLIGATORIO usar `viem` exclusivamente para operaciones criptográficas.
PROHIBIDO `ethers.js`, `@noble/secp256k1` directo, `web3.js`, o cualquier otra librería de firma.

**CD-5:** PROHIBIDO usar `console.log`. Toda observabilidad via parámetro `logger` inyectado
(Pino Logger) o sin logging (la función core no logea — el caller logea el resultado).

**CD-6:** OBLIGATORIO que la función `verifyEip3009` exporte su firma con tipos explícitos y sin
`any`. La signatura debe ser:
```ts
export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>>
```

**CD-7:** OBLIGATORIO que `buildEip3009Domain` sea una función pura (sin side effects, sin I/O)
exportada desde `src/methods/eip3009/domain.ts`, testeable de forma aislada.

**CD-8:** PROHIBIDO que los tests usen keys reales u on-chain calls. Todos los fixtures de firma
deben ser generados offline con viem `signTypedData` en el setup del test usando una private key
de test fija (ej. `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
— Hardhat/Anvil account #0, de conocimiento público).

**CD-9:** OBLIGATORIO que el módulo exponga constantes del typed data en `abi.ts`:
el array `EIP3009_TYPES` con la definición completa del tipo `TransferWithAuthorization`
(campos: `from`, `to`, `value`, `validAfter`, `validBefore`, `nonce`) para que el builder y los
tests sean consistentes y no dupliquen la definición.

**CD-10:** PROHIBIDO realizar comparaciones de address con `===` o `.toLowerCase()`. Usar
`isAddressEqual(a, b)` de viem en toda comparación de Address.

**CD-11:** OBLIGATORIO que la validación de `authorization.nonce` verifique que es un hex string
de 32 bytes (`0x` + 64 hex chars). Si el formato es inválido retornar `INVALID_SIGNATURE` (el
nonce mal formado indica payload corrupto o manipulado).

**CD-12:** OBLIGATORIO incluir en `verify.test.ts` al menos un test por cada uno de los 12 ACs.
Cada test debe usar el patrón `expect(result.ok).toBe(false)` / `.toBe(true)` y verificar el
`error.code` explícitamente en casos de error.

**CD-13:** PROHIBIDO que el módulo `eip3009` importe desde `src/methods/eip3009/schemas.ts`
utilizando rutas relativas que crucen el boundary del método (ej. `../../core/schemas`). Si se
necesita reutilizar un schema de core, esperá a WFAC-20 donde core/schemas.ts se define.

---

## Missing Inputs

- `src/core/schemas.ts` no existe aún — los schemas Zod raíz de `VerifyParams` se decidirán en
  WFAC-20. Para esta HU, el Dev crea schemas locales en `src/methods/eip3009/schemas.ts`.
  [resuelto en F2 — Architect decide si pre-crear stub de core/schemas o usar local]
- Nonce format exact (bytes32 vs random bytes16 packed in bytes32) — el spec x402 dice
  `0x<bytes32>` pero no especifica si debe ser un nonce único o puede ser random.
  [NEEDS CLARIFICATION: en verify off-chain no se chequea unicidad, solo formato — OK para V1]
- Domain `salt` field para PYUSD en Kite testnet — necesita verificación contra el contrato
  deployado. [resuelto en F2 — Architect verificará ABI del contrato Kite PYUSD]

---

## Waves de implementación

| Wave | Contenido | Archivos |
|------|-----------|---------|
| **W0** | Types + schemas locales + ABI constants | `abi.ts`, `schemas.ts`, `index.ts` (stub) |
| **W1** | Domain builder puro + tests unitarios del builder | `domain.ts`, `domain.test.ts` |
| **W2** | Función `verifyEip3009` completa + tests happy path + error paths | `verify.ts`, `verify.test.ts` |
| **W3** | Tests de edge cases: nonce malformado, timestamp boundary, amount=0, domain mismatch | (extend `verify.test.ts`) |

Cada wave produce código compilable (`npm run typecheck`) y tests verdes (`npm test`) antes de
avanzar a la siguiente.

---

## Análisis de paralelismo

| Relación | HU | Tipo |
|----------|----|------|
| **Bloquea** | WFAC-7 (settle logic) | WFAC-7 importa `verifyEip3009` para re-validar antes de ejecutar on-chain |
| **Bloquea** | WFAC-20 (`POST /verify` route) | La route llama al method adapter vía `core/verify.ts` que a su vez llama a `verifyEip3009` |
| **Paralelo** | WFAC-12 (error codes mapping) | Usa los mismos `X402ErrorCode` pero no depende de verify.ts — puede ir en paralelo |
| **Paralelo** | WFAC-50 (Kite chain adapter) | El chain adapter no importa methods — puede ir en paralelo |
| **Bloqueada por** | WFAC-4 (Redis client) | Redis ya está done en 004 — no bloquea esta HU |
| **Bloqueada por** | WFAC-3 (chain registry) | Registry ya está done en 003 — tipos `EIP3009Token` disponibles |

**Crítico**: WFAC-6 → WFAC-7 → WFAC-20 es el path crítico del E2 (EIP-3009 method). Ningún
endpoint de dinero puede funcionar sin este trabajo.
