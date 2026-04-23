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

### [2026-04-22 F3.1 fix-pack] BLQ-BAJO-1 — Fastify v5 emite logs "Server listening at http://..." ANTES del log AC-1

- **Error**: AR detectó en runtime que la PRIMERA línea JSON a stdout después
  de `app.listen(...)` era `{"msg":"Server listening at http://10.255.255.254:3099"}`
  (una por cada address binding al usar `host: '0.0.0.0'`), no el log CD-18
  compliant `{"msg":"Server listening","port":<N>}`. Violación literal de AC-1
  ("first structured JSON line to stdout"). El test #3 original NO ejercitaba
  `app.listen()` real, emitía el log manualmente — por eso el defecto no fue
  atrapado en F3.
- **Causa raíz**: Fastify v5 en `lib/server.js::logServerAddress` llama
  `this.log.info(listenTextResolver(address))` por cada address bindeado.
  Con `host: '0.0.0.0'` en Linux multi-interface eso son 3 líneas. El
  `listening` event se registra DENTRO de `app.listen(...)`
  (`listenPromise`/`listeningEventHandler`), así que un
  `app.server.removeAllListeners('listening')` ANTES de listen no sirve.
- **Fix**: envolver `app.log.info` con un filtro que descarta strings que
  empiezan con `"Server listening at "` (shape exacto del default
  `listenTextResolver` de Fastify) durante el intervalo `app.listen(...)`,
  restaurar el original inmediatamente después y EN ESE PUNTO emitir el
  log AC-1 compliant `app.log.info({ port }, 'Server listening')`.
  Suppression a nivel del logger porque es el único punto confiable en
  Fastify v5 (el evento `listening` se registra internamente por `listen()`).
- **Hardening del test**: agregado nuevo test de ordering en
  `src/__tests__/unit/health.test.ts` que ejercita `app.listen({ port: 0,
  host: '0.0.0.0' })` REAL, replica la misma suppression del wrapper, y
  assertea que (a) la primera línea con `msg.startsWith('Server listening')`
  es exactamente `{msg:'Server listening', port:<N>}`, (b) no hay línea con
  `msg.startsWith('Server listening at http://')`, (c) existe exactamente
  una línea con `msg === 'Server listening'`.
- **Aplicar en**: cualquier HU futura que emita un log post-`app.listen(...)`
  con un shape específico requerido por un AC. Fastify v5 SIEMPRE va a
  imprimir su default text log — hay que o (1) pisar el `listenTextResolver`
  para que devuelva algo que no molesta, o (2) envolver `app.log.info`
  mientras dura `listen()`. Documentar la decisión en el comment del código.

---

### [2026-04-22 F3.1 fix-pack] MNR-1 — Double parseEnv en bootstrap

- **Error**: `src/index.ts:13` llamaba `parseEnv(process.env)` y luego
  `buildApp({ env: process.env })` vuelve a llamar `parseEnv(process.env)`
  dentro de `src/app.ts`. Zod validación corría dos veces por cold start.
- **Causa raíz**: en F3 la firma de `BuildAppOptions.env` era
  `NodeJS.ProcessEnv` (raw), entonces `buildApp` siempre parseaba. El
  caller `index.ts` ya tenía el resultado parseado pero no había manera
  de inyectarlo.
- **Fix**: partir `BuildAppOptions` en dos caminos mutuamente excluyentes:
  (1) `env?: EnvConfig` — pre-parseado, el camino default del caller
  real `index.ts`. (2) `rawEnv?: NodeJS.ProcessEnv` — para tests que
  quieran ejercitar la validación Zod. `buildApp` ahora hace
  `options.env ?? parseEnv(options.rawEnv ?? process.env)`: UNA sola
  parseEnv por bootstrap.
- **Aplicar en**: cualquier factory que reciba un config validado y
  podría ser llamada desde múltiples puntos. Mejor API: aceptar el
  tipo ya validado; el fallback raw es opcional. Evita "parsear dos
  veces por las dudas".

---

### [2026-04-22 F3.1 fix-pack] MNR-2 — Deps transitivas de eslint no declaradas en package.json

- **Error**: `eslint.config.js` (shim FlatCompat — ver DRIFT-1) importa
  `@eslint/eslintrc` y `@eslint/js`. Ambos resuelven porque son deps
  transitivas de `eslint@9`, pero no estaban declarados en
  `package.json`. `npm ci` en un entorno fresh podría fallar si la
  resolución transitiva cambia en una release menor.
- **Causa raíz**: el shim fue añadido en F3 (ver DRIFT-1) y se asumió
  que la transitiva era estable. AR/CR detectaron correctamente que eso
  es un supply-chain risk — hay que declararlas explícitas.
- **Fix**: añadidas a `devDependencies`:
  - `@eslint/eslintrc: ^3.3.5` (versión resuelta actualmente)
  - `@eslint/js: ^9.39.4` (versión resuelta actualmente)
  `npm install` corrido para actualizar `package-lock.json`.
- **Aplicar en**: cualquier import de código propio (no runtime de la
  app) sobre deps transitivas. Regla: si `require()` / `import` aparece
  en código del repo, el paquete DEBE estar declarado en
  `package.json`, no depender de la resolución transitiva.

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
