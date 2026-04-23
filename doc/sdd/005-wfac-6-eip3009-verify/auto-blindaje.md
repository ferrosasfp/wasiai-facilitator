# Auto-Blindaje — WFAC-6 (EIP-3009 verify)

Registro de errores detectados durante F3 e F3.1 y sus fixes. Para que futuras HUs
no repitan los mismos patrones.

---

## F3.1 Fix-pack (post-AR)

### [2026-04-23 11:30] W0/W1 — CD-2 violation: `BigInt("abc")` throw uncaught (BLQ-ALTO-2)
- **Error**: `verifyEip3009` llamaba `BigInt(params.accepted.amount)` en línea 60 sobre input attacker-controlled sin pre-validación de shape. Con `amount = "abc"` / `"1e2"` el `BigInt()` tira `SyntaxError` que se propaga al caller → viola CD-2 (método NO debe throw, siempre `AdapterResult`).
- **Causa raíz**: El shape validation se aplicaba solo a `params.payload.authorization` (via `Eip3009AuthorizationSchema`), NO a `params.accepted`. Quedaban sin cobertura `amount`, `asset`, `payTo`, `network`.
- **Fix**: Nuevo `AcceptedSchema` (zod, passthrough) en `schemas.ts`. Parseo como paso 1b en `verify.ts` ANTES de cualquier `BigInt(...)` o `isAddressEqual(...)`. Ruteo de errores: `amount` → `INVALID_AMOUNT`, otros → `NETWORK_MISMATCH` (clase match con steps 2/3).
- **Aplicar en**: Cualquier método que consuma `params.accepted.*` con conversión tipada. Futuro `settleEip3009`, `verifyPermit2`, `verifyErc7710` deben validar `accepted` con Zod antes de cualquier `BigInt()` o `isAddressEqual()`.

### [2026-04-23 11:30] W0/W1 — Negative amount bypass (BLQ-ALTO-1)
- **Error**: `accepted.amount = "-1"` pasaba la guardia `acceptedAmount === 0n` porque `BigInt("-1") === -1n` (no `0n`). Llegaba a la comparación `authorization.value < acceptedAmount` donde `1000n < -1n` es `false` → happy-path con amount negativo.
- **Causa raíz**: (1) El regex original `/^\d+$/u` SÍ rechazaba `-1` pero no se aplicaba a `accepted.amount` (ver BLQ-ALTO-2). (2) La comparación `=== 0n` era demasiado estrecha — también debería rechazar valores `< 0n` como defense-in-depth.
- **Fix**: Doble capa: (a) `AcceptedSchema.amount = Uint256StringSchema` (regex `/^(0|[1-9]\d*)$/`) rechaza `-1` en el parseo. (b) Cambio `=== 0n` → `<= 0n` para defense-in-depth.
- **Aplicar en**: Toda comparación `=== 0n` sobre valores decimal-string parseados debería ser `<= 0n` o `>= 0n` según intención. Patrón: rechazar negativos en el schema Y tener un guard defensivo en la lógica.

### [2026-04-23 11:30] W0/W1 — Precision loss en `Number(validBefore)` (BLQ-MED-1)
- **Error**: Líneas 75, 78 usaban `Number(authorization.validBefore) <= nowSec`. `validBefore` es uint256 (hasta 2^256-1); si excede `Number.MAX_SAFE_INTEGER` (2^53-1), `Number()` pierde precisión silenciosamente y puede flipear decisión expired/valid.
- **Causa raíz**: `nowSec` (de `Math.floor(Date.now()/1000)`) es `number`, lo que incentivaba a convertir el lado BigInt a `number` para comparar — dirección equivocada.
- **Fix**: `nowSec` ahora es `BigInt(Math.floor(Date.now()/1000))`. Comparaciones usan `BigInt(authorization.validBefore) <= nowSec` y `BigInt(authorization.validAfter) > nowSec`. `expiresAt` en el output sigue siendo `Number()` (shape del `VerifyResult` typed `number`, out-of-scope fix aquí) — pero las DECISIONES de control de flujo son BigInt-correct.
- **Aplicar en**: Cualquier comparación de uint256 strings contra timestamps. REGLA: si un lado es BigInt, conviertí el otro lado a BigInt, no al revés. Nunca `Number(uint256)` para lógica de decisión.

### [2026-04-23 11:30] W0 — Leading zeros bypass canonicalidad (BLQ-BAJO-1)
- **Error**: Regex `/^\d+$/u` aceptaba `"01000"`, `"00"`, `"000100"` — valores con BigInt idéntico pero representación string distinta. Produce ambigüedad en logs, cachés, equality checks downstream.
- **Causa raíz**: Regex demasiado permisivo; no enforcaba forma canónica.
- **Fix**: Regex `/^(0|[1-9]\d*)$/u` — una sola forma canónica por valor. `"0"` OK, `"1000"` OK, `"01000"` rechazado.
- **Aplicar en**: Cualquier uint256 serializado como string debería usar forma canónica. Si Permit2/ERC-7710 introduce nuevos uint256 strings, reusar `Uint256StringSchema`.

### Nota sobre T-H5 flake (OUT OF SCOPE)
- **Observado**: Test `T-H5: validBefore === nowSec + 1 is OK` es flaky cuando el suite completo (`npm run qa`) corre bajo carga. Root cause: `validBefore = nowSec + 1` deja un buffer de 1 segundo; si la generación de fixture + llamada a `verifyEip3009` cruza ese límite (p.ej. por CPU caliente o GC), la comparación `validBefore <= nowSec_later` falla.
- **Por qué no se toca acá**: Fix-pack scope dice "NO borrar tests existentes — solo agregar". T-H5 fue introducido en el PR base (commit 9f9dc5e), no en F3.1. Se marca como **TD** (technical debt) para futura HU de tests-hardening: aumentar el buffer a `nowSec + 10` o usar `vi.useFakeTimers()`.
- **Mitigación actual**: El test pasa consistentemente cuando `verify.test.ts` corre aislado (`npx vitest run src/__tests__/unit/methods/eip3009/verify.test.ts`).
