# Auto-Blindaje — WFAC-23

Registro de errores cometidos y corregidos durante la implementación.

### [2026-04-23 02:58] Wave 3 — Lint warning `security/detect-object-injection` en test helper

- **Error**: El test AC-9 hace `spec.components.schemas[schemaName]` donde
  `schemaName` proviene de `$ref.replace(...)`. El plugin
  `eslint-plugin-security` (max-warnings 0) falla porque detecta una
  "Function Call Object Injection Sink".
- **Causa raíz**: ESLint no puede probar estáticamente que `schemaName`
  deriva de data del propio repo (`doc/openapi.yaml`), no de input externo.
- **Fix**: Añadir `// eslint-disable-next-line security/detect-object-injection`
  con justificación explícita. Patrón idéntico al usado en
  `src/core/errors.ts` para `HTTP_BY_CODE[code]`.
- **Aplicar en**: cualquier test/código futuro que haga lookup dinámico
  por key en un `Record<string, _>` cuando la key provenga de data del
  propio repo — no es vulnerabilidad, pero el lint rule dispara por
  defecto y requiere comment justificativo.

### [2026-04-23 02:58] Wave 3 — Prettier format check fallaba en archivos nuevos

- **Error**: `npm run format:check` reportó diffs en `src/routes/openapi.ts`
  y `src/__tests__/unit/routes.openapi.test.ts`.
- **Causa raíz**: El estilo default que escribí (line-break pattern en la
  asignación multi-línea de `yamlLoad(...) as Record<...>`) no coincidía
  con la regla prettier del proyecto.
- **Fix**: `npx prettier --write` en ambos archivos. Cambios cosméticos
  (alineación), sin tocar lógica ni tests.
- **Aplicar en**: correr `prettier --write` antes de cada `format:check`
  en archivos nuevos; o mejor, configurar pre-commit hook (fuera del
  scope de esta HU).
