# Auto-Blindaje — WFAC-22

Registro de errores cometidos durante la implementación F3 y sus fixes.
Proteje futuras HUs contra repetición.

### [2026-04-23 02:37] Wave W0 — Prettier failed on initial write
- **Error**: `npm run format:check` marcó `src/core/supported.ts` con diff.
  Escribí `Array.from(\n  new Set(chains.flatMap((c) => c.methods)),\n);` en
  tres líneas, Prettier lo quiere en una sola línea (line-length < 100).
- **Causa raíz**: escribí el código a mano con mi propio criterio de line-break
  en lugar de dejar que Prettier (printWidth ~100) defina el wrap. El literal
  cabe en una línea sola.
- **Fix**: `npx prettier --write src/core/supported.ts` — colapsó a una línea.
- **Aplicar en**: antes de commitear cada wave, correr `prettier --check` y
  si falla, `prettier --write` + re-lectura. No asumir line-breaks "estéticos"
  sin confirmar contra el formatter.
