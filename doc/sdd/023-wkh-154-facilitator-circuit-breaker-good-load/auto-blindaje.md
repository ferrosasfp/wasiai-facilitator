# Auto-Blindaje — WKH-154 (facilitator circuit-breaker transport-vs-business)

### [2026-07-07 01:22] Wave 0 — `security/detect-object-injection` en el classifier puro
- **Error**: `eslint --max-warnings 0` falló con 2 warnings de `security/detect-object-injection`: un helper genérico `readString(obj, key)` que hacía `obj[key]` con `key: string` variable, y la lectura del símbolo `(result as Record<symbol, unknown>)[BREAKER_CLASS]`.
- **Causa raíz**: el plugin marca cualquier member-access con clave no-literal como sink de object-injection. El acceso dinámico por variable (aunque las claves fueran un set fijo) dispara el warning.
- **Fix**: (1) reemplacé el helper genérico por acceso literal-keyed sobre una interfaz `RawErrorLike` (`obj.name`, `obj.message`, `obj.cause`, etc.) — cero claves variables; (2) para el símbolo módulo-privado `BREAKER_CLASS` (no atacante-controlado) usé un `eslint-disable-next-line` justificado, patrón idéntico al de `circuit-breaker.ts` (`readCbNumber`/`readCbBool`).
- **Aplicar en**: cualquier módulo `src/chains/*` que inspeccione objetos `unknown` por duck-typing. Preferir siempre acceso por clave literal sobre una interfaz tipada; reservar `eslint-disable` (con `--` reason) solo para símbolos/claves fijas no atacante-controladas.

### [2026-07-07 01:22] Wave 0 — token literal `instanceof` en comentarios
- **Error**: el completion-criteria exige `grep -c "instanceof" src/chains/error-classifier.ts → 0`, pero un comentario de diseño ("Duck-typing only, NEVER `instanceof`") contenía el token literal.
- **Causa raíz**: el guardrail hace grep textual, no distingue código de comentario.
- **Fix**: reformulé el comentario a "never type-identity operators" — mantiene la intención (CD-9) sin el token literal. `grep -c "instanceof"` → 0.
- **Aplicar en**: cualquier guardrail que exija un grep-count 0 de un token — evitar ese token también en comentarios/strings, no solo en código.
