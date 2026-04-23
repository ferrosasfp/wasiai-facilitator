# Auto-Blindaje — WFAC-2 Fastify Bootstrap

Registro de errores detectados durante F3 y sus correcciones, para
aprendizaje cross-HU.

---

### [2026-04-22 W4] DRIFT-1 — ESLint 9 incompatible con .eslintrc.json legacy del scaffold

- **Error**: `npm run qa` fallaba porque `npm run lint` explotaba con
  "ESLint couldn't find an eslint.config.(js|mjs|cjs) file". El scaffold
  trae `.eslintrc.json` legacy, pero ESLint 9 dejó de soportar ese formato.
- **Causa raíz**: bug del scaffold pre-WFAC-2. Reproducido en `main`
  stash-checkout: el mismo error ocurre sin ningún cambio del HU.
  El Story File no anticipó esto (no hay guidance de ESLint).
- **Fix (DRIFT-1)**: se agregó `eslint.config.js` (flat config) que usa
  `FlatCompat` de `@eslint/eslintrc` para cargar las reglas del
  `.eslintrc.json` existente sin duplicarlas. Archivo NO está en el
  Scope IN del Story File (11 nuevos + 2 modificados), pero el gate
  `npm run lint` es obligatorio en DoD. Solución mínima:
  - Zero cambios a rules (delega al .eslintrc.json via compat).
  - Un archivo nuevo en root, no toca `src/`.
  - No rompe nada: si una HU futura hace flat-config nativo, borra
    este shim.
- **Justificación**: trivial (no afecta ACs/CDs, no expande scope
  funcional) → resuelto en F3 sin escalar. Futuras HUs deberían
  reemplazarlo con un flat-config nativo (candidato a HU dedicada o
  tech-debt).
- **Secundario**: el test `no-console.test.ts` disparaba warnings de
  `security/detect-non-literal-fs-filename` al walkear src/. Agregado
  `/* eslint-disable security/detect-non-literal-fs-filename */` con
  comentario explicativo — el test es un audit script, el warning no
  aplica.
- **Aplicar en**: cualquier HU futura que corra `npm run qa` — hasta
  que exista una HU dedicada para migrar el flat-config nativo, el shim
  sigue siendo la vía oficial.

---

### [2026-04-22 W4] Tests con captura de logs fallan con LOG_LEVEL=silent global

- **Error**: el test "emits Server listening with exact shape" no encontraba
  la línea `'Server listening'` en el stream capturado — `getLines()` venía
  vacío.
- **Causa raíz**: `vitest.config.ts` setea `LOG_LEVEL=silent` en el entorno
  de tests. Eso hace que pino no escriba nada al destination stream,
  incluso cuando el test espera capturar output.
- **Fix**: en tests que dependen de capturar logs, override explícito:
  `buildApp({ env: { ...process.env, LOG_LEVEL: 'info' }, loggerDestination: capture })`.
- **Aplicar en**: cualquier test futuro que haga log-capture — los stream
  assertions siempre deben forzar un LOG_LEVEL permisivo, no confiar en
  el default del vitest env.

---

### [2026-04-22 W2] FastifyInstance return-type mismatch por Pino.Logger generic specialization

- **Error**: `src/app.ts` no typecheckeaba. TS2322: `FastifyInstance<..., Logger, ...>`
  no asignable a `FastifyInstance<..., FastifyBaseLogger, ...>`. La causa:
  al pasar `loggerInstance: Logger` (Pino), Fastify especializa el generic
  al shape pino, pero la firma declarada retorna `FastifyInstance` sin
  generics → default `FastifyBaseLogger`. `BaseLogger` de Pino tiene
  `msgPrefix` y `FastifyBaseLogger` no.
- **Causa raíz**: R9 del Story File — estructuralmente compatibles, pero
  TS infiere el generic más específico al pasar `Logger` concreto.
- **Fix**: anotar la variable intermedia `const logger: FastifyBaseLogger = createLogger(...)`.
  Con eso el `loggerInstance` de Fastify ve `FastifyBaseLogger` y el
  generic queda en default. NO se usó `as any` (CD-4). Solución estructural,
  no casting.
- **Aplicar en**: cualquier otro lugar que instancie Fastify con un logger
  tipado (Pino, Bunyan, propietario). Regla: annotar siempre la variable
  como `FastifyBaseLogger` antes de pasarla a `Fastify({ loggerInstance })`.
