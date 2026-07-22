# Auto-Blindaje — WKH-216 / HU-SOL-13 (Waves 13b + 13c, wasiai-facilitator)

Errores cometidos y corregidos durante F3. Cada entrada blinda futuras HUs.

### [2026-07-22] Wave 13b — `import type` faltante en `BN` (consistent-type-imports)
- **Error**: `import { BorshAccountsCoder, BN, type Idl } from '@coral-xyz/anchor'` en `src/chains/solana-escrow.ts` — eslint `@typescript-eslint/consistent-type-imports` (error, `--max-warnings 0` lo bloquea).
- **Causa raíz**: `BN` se usa SOLO como tipo (`amount: BN` en la interface `EscrowStateRaw`), nunca como valor en ese módulo. La regla exige `import type` para símbolos usados solo como tipo.
- **Fix**: `import { BorshAccountsCoder, type BN, type Idl }` (BorshAccountsCoder queda como valor). En el TEST, en cambio, `BN` SÍ es valor (`new BN(...)`) → ahí va sin `type` (correcto).
- **Aplicar en**: cualquier módulo que importe `BN`/tipos de anchor: separar `import type` de los valores por-símbolo, no por-módulo (alinea con CD-16).

### [2026-07-22] Wave 13b — casing del enum al decodificar con BorshAccountsCoder (anchor 0.30.1)
- **Error**: `normalizeStatus` chequeaba `'deposited' in raw` (lowercase). El decode real de `BorshAccountsCoder(escrowIdl).decode('EscrowState', data)` devuelve la variante con la clave **capitalizada** del IDL: `{ Deposited: {} }`. También el ENCODE exige la clave capitalizada (`{ Deposited:{} }`) — `{ deposited:{} }` lanza `unable to infer src variant`.
- **Causa raíz**: se asumió el camelCase histórico de anchor. En 0.30.1 con el IDL nuevo (`types` + `defined:{name}`), la variante se preserva tal cual está en el IDL (`Deposited`/`Released`/`Refunded`).
- **Fix**: `normalizeStatus` lowercasea las claves antes de comparar (robusto ante cambios de casing entre versiones de anchor). Verificado con un probe de encode/decode round-trip ANTES de escribir los tests.
- **Aplicar en**: cualquier decode/encode de enums Anchor — NO asumir casing; probar el round-trip real. El fixture de test encodea con `{ [Status]: {} }` (capitalizado, como el IDL).

### [2026-07-22] Wave 13c — `security/detect-object-injection` en loops de env de los tests
- **Error**: `for (const k of ENV_KEYS) { saved[k] = process.env[k]; ... }` disparó `security/detect-object-injection` (warning) en 2 test files → `--max-warnings 0` falla el gate.
- **Causa raíz**: acceso por bracket con variable (`process.env[k]`, `saved[k]`) sobre índice dinámico — la regla lo marca aunque la key venga de un literal controlado.
- **Fix**: se reemplazaron los loops por asignaciones explícitas por-variable (patrón del test de `solana-sponsor.route.test.ts`) + un helper `restore(name, value)` con `eslint-disable-next-line security/detect-object-injection` justificado (env name de call-site literal, no user-input).
- **Aplicar en**: helpers de save/restore de env en tests — evitar loops sobre bracket-access; usar asignaciones explícitas o disable justificado. Es el mismo patrón que ya usaba el exemplar HU-SOL-14.

## Decisiones de F3 documentadas (no errores)
- **[NC-2] wire-format del release request**: elegí opción (a) — atestación server-firmada pasada por chaski: HMAC-SHA256 sobre `${remittanceId}:${sender}` con `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` (leída directo de `process.env`, opt-in-off, espeja `pop.ts`). `env.ts` NO se modifica (fuera del file-scope 13c). Fail-closed: secret unset ⇒ rechaza todo. La semántica REAL de "KYC+TransFi confirmados" + el Zod companion de HU-SOL-9 siguen founder-gated (Scope OUT).
- **[NC-4] coder**: `@coral-xyz/anchor@0.30.1` PINNEADO (mismo pin que chaski), `BorshAccountsCoder` SOLO para decodificar la CUENTA `EscrowState` (13b). La tx `release` se parsea raw-bytes en `cr1-release.ts` (CD-12). Instaló limpio (added 15 packages, sin `--legacy-peer-deps`).
- **sha256 server-side**: 13b usa `node:crypto` (facilitator es Node puro, nunca bundle browser) → CD-15 (libs isomórficas) NO aplica acá. Paridad de PDA con chaski verificada byte-a-byte en TF1 (sha256 de utf8 == `TextEncoder().encode` de chaski).
