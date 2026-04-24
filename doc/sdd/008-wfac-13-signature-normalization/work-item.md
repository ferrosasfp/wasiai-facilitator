# Work Item — [WFAC-13] Signature normalization — EIP-2098 compact sigs + Core wallet edge cases

## Resumen

Introducir un módulo dedicado `src/methods/eip3009/signature.ts` que centraliza el parse,
normalización y validación de firmas ECDSA para EIP-3009 (65-byte standard, 64-byte EIP-2098
compact, v=0/1 adjustment, s-malleability rejection). Actualmente `settle.ts` rechaza
compactas con un comentario "WFAC-13 pending" y `verify.ts` delega toda la validación a
viem de forma implícita; esta HU hace el contrato explícito, testeable y seguro frente a
wallets edge-case (Core wallet, Backpack, Ethers v5 interop).

## Sizing

- SDD_MODE: mini
- Estimación: S
- Pipeline: FAST+AR
- Branch sugerido: `feat/008-wfac-13-signature-normalization`

## Acceptance Criteria (EARS)

- AC-1: WHEN `normalizeSignature` recibe un hex de 132 chars (65 bytes, v=27/28), the system SHALL retornar `{ r, s, v: 27n | 28n }` sin error.
- AC-2: WHEN `normalizeSignature` recibe un hex de 130 chars (64 bytes, formato EIP-2098 compact), the system SHALL expandirlo a 65 bytes extrayendo `yParity` del bit alto de `s`, reconstruir `v = 27n + yParity`, y retornar `{ r, s_clean, v }` con el bit `yParity` limpiado de `s`.
- AC-3: WHEN `normalizeSignature` recibe un hex con `v = 0` o `v = 1` (legacy pre-EIP-155), the system SHALL normalizar a `v = 27n` o `v = 28n` respectivamente antes de retornar.
- AC-4: IF la firma contiene `s` en el high-half de la curva secp256k1 (`s > secp256k1.n / 2`), THEN the system SHALL retornar `{ ok: false, error: buildX402Error('INVALID_SIGNATURE', 'signature s-value in high half (malleable)') }`.
- AC-5: IF el hex de firma tiene longitud distinta de 130 o 132 chars (excluyendo prefijo `0x`), THEN the system SHALL retornar `{ ok: false, error: buildX402Error('INVALID_SIGNATURE', 'invalid signature length') }`.
- AC-6: IF el hex de firma contiene bytes que no corresponden a un punto válido de secp256k1 (ej.: r=0 o s=0), THEN the system SHALL retornar `{ ok: false, error: buildX402Error('INVALID_SIGNATURE', ...) }` sin lanzar excepción.
- AC-7: WHEN `settle.ts` llama a `parseSignature` de viem, the system SHALL ser reemplazado por `normalizeSignature` del nuevo módulo, eliminando el bloque inline de rechazo EIP-2098 y usando el resultado normalizado en el `simulateContract` call.
- AC-8: WHILE el módulo `signature.ts` existe en `src/methods/eip3009/`, the system SHALL NO importar nada de `src/core/*` salvo `src/core/errors.ts` (excepción documentada en OWNERS.md [1]) y `src/core/types.ts` (type-only).
- AC-9: WHEN se ejecuta la suite de tests de `signature.test.ts`, the system SHALL cubrir: (a) 65-byte happy path, (b) 64-byte EIP-2098 happy path, (c) v=0/1 normalization, (d) s-malleability rejection, (e) longitud inválida, (f) r=0 o s=0 rejection, (g) fixture roundtrip — firma generada con `privateKeyToAccount.signTypedData` y normalizada debe producir el `v/r/s` correcto para `recoverTypedDataAddress`.
- AC-10: the system SHALL exportar la función con la firma exacta: `normalizeSignature(sig: Hex): NormalizedSignature | SignatureError` donde `NormalizedSignature = { ok: true; r: Hex; s: Hex; v: 27n | 28n }` y `SignatureError = { ok: false; error: Err['error'] }`.

## Scope IN

- `src/methods/eip3009/signature.ts` — módulo nuevo (implementación)
- `src/__tests__/unit/methods/eip3009/signature.test.ts` — test file nuevo
- `src/methods/eip3009/settle.ts` — refactor: reemplazar bloque `parseSignature + v-guard` por llamada a `normalizeSignature`
- `src/methods/eip3009/verify.ts` — opcional: agregar llamada a `normalizeSignature` como pre-validation explícita antes de `recoverTypedDataAddress` (ver DT-3)

## Scope OUT

- `src/core/signature.ts` — descartado: el módulo vive en `src/methods/eip3009/` porque es específico del método EIP-3009. No hay otro método en scope que lo reutilice hoy (ver DT-1).
- Soporte del overload `bytes` de `transferWithAuthorization` (EIP-2098 compact directo al contrato) — ese overload no está en `FIAT_TOKEN_ABI` (WFAC-13 solo normaliza a v/r/s para el overload existente).
- Modificar `FIAT_TOKEN_ABI` para agregar el overload compact — fuera de scope.
- Modificar `X402ErrorCode` — los errores de firma ya están cubiertos por `INVALID_SIGNATURE`.
- Actualizar OWNERS.md — `signature.ts` vive en `methods/eip3009/` que ya es boundary permitido; no requiere nueva excepción.
- Tests de integración on-chain (require RPC).

## Decisiones Técnicas (DT-N)

- DT-1: **Ubicación `src/methods/eip3009/signature.ts` (no `src/core/`)**. Justificación: la lógica es específica de secp256k1/EIP-2098 y hoy solo la consume eip3009. Si en el futuro otro method la necesita, se eleva a `src/core/` en su propia HU. Colocarlo en `src/core/` hoy violaría el principio de "agregar method = 1 directorio" y requeriría nueva excepción en OWNERS.md.
- DT-2: **Retorno discriminado union `{ ok: true, r, s, v } | { ok: false, error }`** (no throw). Mantiene consistencia con el patrón `Result<T>` del proyecto (ver `src/core/types.ts`). La función es síncrona (sin I/O), el llamador no necesita `try/catch`.
- DT-3: **`verify.ts` — pre-validación opcional pero recomendada**. Hoy `recoverTypedDataAddress` de viem ya detecta firmas malformadas y el catch existente las convierte a `INVALID_SIGNATURE`. Si se agrega `normalizeSignature` antes del recover, se gana: (a) rechazo explícito de s-malleable antes del recover (viem no lo rechaza por defecto), (b) log más preciso. Decisión: incluir en Scope IN como "opcional" — Dev puede implementarla si el refactor de settle.ts lo justifica, pero no es bloqueante para los ACs.
- DT-4: **Constante `SECP256K1_N`** (`0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n`) definida dentro de `signature.ts` como `const` local. No depende de ninguna librería externa — es un valor fijo de la curva. Esto mantiene la pureza del módulo (zero runtime deps más allá de viem's `Hex` type import y `buildX402Error`).
- DT-5: **EIP-2098 s-bit extraction**: el bit 255 de `s` en el compact encoding codifica `yParity`. Se extrae con `(sBigInt >> 255n) & 1n` y se limpia con `sBigInt & ((1n << 255n) - 1n)`. Ambas operaciones son BigInt puras — no requieren librería externa.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO importar desde `src/core/*` salvo `src/core/errors.ts` (runtime, excepción documentada en OWNERS.md [1]) y `src/core/types.ts` (type-only). Violación = AR BLOQUEANTE.
- CD-2: PROHIBIDO usar `console.log`, `logger`, o cualquier I/O dentro de `signature.ts`. La función es pura: mismo input, mismo output, sin side effects.
- CD-3: OBLIGATORIO usar `buildX402Error('INVALID_SIGNATURE', <message>)` para todos los errores de la función — no construir el shape `{ code, message, http }` manualmente.
- CD-4: PROHIBIDO lanzar excepciones desde `normalizeSignature`. Todo error se retorna como `{ ok: false, error: ... }`. Si internamente alguna operación puede lanzar (ej.: BigInt parse de hex malformado), se debe envolver en try/catch.
- CD-5: OBLIGATORIO que los tests usen fixtures generados con `privateKeyToAccount(...).signTypedData(...)` (misma key de Hardhat #0 que usa el resto del proyecto) — no firmas hardcodeadas arbitrarias que no correspondan a ninguna clave privada real.
- CD-6: PROHIBIDO modificar `OWNERS.md`, `src/core/types.ts`, o `src/core/errors.ts` en esta HU.
- CD-7: OBLIGATORIO que `settle.ts` post-refactor NO tenga el bloque inline de `if (!('v' in parsed) || parsed.v === undefined)` — ese guard debe vivir en `signature.ts`.

## Waves (combinables en un solo PR)

- W0 — Módulo `signature.ts`: implementar `normalizeSignature` + constante `SECP256K1_N` + tipos exportados `NormalizedSignature` / `SignatureError`. Sin tocar consumers todavía.
- W1 — Tests `signature.test.ts`: cubrir los 7 escenarios del AC-9. Puede correr en paralelo con W0 o inmediatamente después.
- W2 — Refactor consumers: actualizar `settle.ts` (Scope IN fijo) y opcionalmente `verify.ts` (Scope IN opcional, ver DT-3). W2 requiere W0 done.

*W0+W1 pueden entregarse como un solo commit. W2 es un segundo commit sobre el mismo branch.*

## Missing Inputs

- [resuelto en F2] Confirmar si viem's `parseCompactSignature` (si existe en v2.47.x) ya extrae yParity correctamente para EIP-2098 — si está disponible, DT-5 podría delegar en viem en lugar de implementar BigInt manual. Verificar en F3 anti-hallucination check antes de codear.
- [NEEDS CLARIFICATION — no bloqueante] ¿El overload compact bytes de `transferWithAuthorization` (algunos contratos USDC-fork lo soportan como función separada) está en el roadmap? Si sí, la firma de `normalizeSignature` debería estar diseñada para facilitar ese path. Por ahora se asume que NO (Scope OUT explícito) y se avanza.

## Análisis de paralelismo

- Esta HU NO bloquea otras activas (WFAC-7 pending, WFAC-11 ya merged).
- Puede ir en paralelo con cualquier HU que no toque `src/methods/eip3009/`.
- Una vez merged, WFAC-21 (core/settle orchestrator) puede consumir el normalizador directamente si necesita pre-validar firmas antes del dispatch.
