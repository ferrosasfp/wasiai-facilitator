# Auto-Blindaje — WFAC-53 (Dev session)

Documenta los errores que ocurrieron durante la implementación F3 y cómo se corrigieron, para proteger futuras HUs.

### [2026-05-11 12:39] Wave 1 (C3) — R-10 incompleto: `FIAT_TOKEN_ABI` length consumer no listado en Scope IN

- **Error**: Tras agregar la entry `DOMAIN_SEPARATOR()` a `FIAT_TOKEN_ABI` (necesario por AC-6 + CD-3), el test
  `src/__tests__/unit/methods/eip3009/settle.test.ts` (linea 398) falló con:
  `AssertionError: expected [...] to have a length of 1 but got 2`. El test asertaba `expect(FIAT_TOKEN_ABI).toHaveLength(1)` y `FIAT_TOKEN_ABI[0]`.
- **Causa raíz**: Story §6 R-10 declaraba "verificado: ningún consumer itera `FIAT_TOKEN_ABI[`" via grep,
  pero el grep usado por el Architect (`grep -rn "FIAT_TOKEN_ABI\[\|FIAT_TOKEN_ABI\.length" src/`) NO contemplaba
  `FIAT_TOKEN_ABI).toHaveLength(...)` (la sintaxis vitest sobre el array). Una segunda pasada con `grep
  "FIAT_TOKEN_ABI\[\|FIAT_TOKEN_ABI).toHaveLength\|FIAT_TOKEN_ABI.length"` reveló el consumer faltante.
- **Fix**: Actualicé el test stale ajustando la length expected a 2 y agregando una assertion para la segunda entry
  (`DOMAIN_SEPARATOR`). Este file NO estaba en Scope IN §0.6 pero la modificación es estrictamente necesaria para
  cumplir CD-2 (baseline no regression) tras la ABI extension mandada por CD-3. Documentado como desviación
  justificada en reporte al orquestador.
- **Aplicar en**: futuras HUs que extiendan ABIs versionadas — el grep de R-10 debe incluir
  `).toHaveLength`, `.length === N`, `[N]`, `for...of`, `for(let i`, `.forEach`, `.map`, `.filter`. Una sola
  expresión regex: `FIAT_TOKEN_ABI\s*[).\[]`. CD-PROPUESTO para próximas Story Files: cuando una ABI versionada
  se extiende, la búsqueda de consumers DEBE usar la regex ampliada.
