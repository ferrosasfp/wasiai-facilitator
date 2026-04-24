# Auto-Blindaje — WFAC-32 Settlement Ledger

Errores detectados durante F3 implementación + cómo evitarlos en futuras HUs.

---

### [2026-04-23 03:32] Wave 1 — `_loggedDisabled` dead state dejado en `resetSupabaseClientForTests`

- **Error**: inicialmente declaré `let _loggedDisabled = false;` como parte del state del singleton, escribí sobre él en `initSupabase` y `resetSupabaseClientForTests`, pero nunca lo leí. Cuando el lint (`@typescript-eslint/no-unused-vars`) lo marcó, borré sólo la declaración al tope del archivo — pero dejé las dos asignaciones (`_loggedDisabled = false` en `initSupabase` y en `resetSupabaseClientForTests`). Tests rompieron con `ReferenceError: _loggedDisabled is not defined` en runtime.
- **Causa raíz**: borrar symbol declarations sin revisar referencias es una aplicación parcial del fix. El lint error fue la señal, pero el borrado completo requiere scan `grep -n _loggedDisabled src/infra/supabase.ts` antes de re-lint.
- **Fix**: eliminar las dos asignaciones restantes. `npm test` pasó 355/355.
- **Aplicar en**: cada vez que ESLint `no-unused-vars` aparece y el fix es "borrar la variable", correr un grep global del nombre antes de commit. En general, preferir `rg <name>` sobre `grep` por velocidad.

### [2026-04-23 03:31] Wave 1 — `no-secrets/no-secrets` trip en JSDoc del redactor

- **Error**: escribí `'sb_service_abcdef1234567890xyz'` como ejemplo dentro del JSDoc de `redactSupabaseKey`. ESLint `no-secrets/no-secrets` lo marcó como string con entropy 4.54 (false positive — es un literal de documentación).
- **Causa raíz**: el detector de entropy corre sobre strings literales en cualquier posición, incluyendo comentarios multi-línea. No hay forma de `eslint-disable-next-line` en un JSDoc block comment sin ensuciar el output.
- **Fix**: reescribir el bloque de ejemplos en prosa (`Keys of length >= 12: first 8 chars + U+2026 + last 4 chars.`) sin literales que parezcan tokens.
- **Aplicar en**: cualquier nuevo módulo que documente keys, hashes, signatures o tokens. Regla: NUNCA poner literales realistas en docstrings. Describir la transformación en texto.
