# Auto-Blindaje — WFAC-2 Fastify Bootstrap

Registro de errores detectados durante F3 y sus correcciones, para
aprendizaje cross-HU.

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
