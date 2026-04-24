# OWNERS.md — Module Boundaries

Este archivo define qué puede importar cada módulo de `src/`. Violaciones = AR reject.
Inspirado en patrón adoptado de `luma-ai` (OWNERS.md como contrato de arquitectura).

---

## Principio central

wasiai-facilitator tiene **3 capas adaptativas** (`chains`, `methods`, `core`) + infra + routes.
El valor del producto está en que **agregar chain o method = 1 archivo**. Esto requiere
disciplina de dependencias: `core` no puede conocer chain-specifics, `methods` no pueden
conocer routing, etc.

Si una HU te lleva a cruzar un boundary, parar y reevaluar — probablemente sea un hueco
en la abstracción, no una excepción válida.

---

## Matriz de importación

| Módulo                    | Puede importar                                          | PROHIBIDO importar                                                         |
|---------------------------|---------------------------------------------------------|----------------------------------------------------------------------------|
| `src/core/`               | `src/infra/*`, tipos compartidos, Zod                   | `src/chains/*` (salvo vía registry), `src/methods/*` (vía dispatch), `src/routes/*` |
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, viem                             | `src/core/*`, `src/methods/*`, `src/routes/*`, otras chains                |
| `src/chains/registry.ts`  | Todos los `src/chains/<chain>.ts` (explícitos)          | `src/core/*`, `src/methods/*`, `src/routes/*`                              |
| `src/methods/<method>/`   | `src/chains/types.ts` (solo tipos), `src/core/types.ts` (solo tipos), `src/core/errors.ts` [1], viem, ABIs propias | `src/core/*` (salvo excepciones [1]), `src/chains/registry.ts`, otros methods |
| `src/routes/`             | `src/core/*`, `src/infra/*`, Zod schemas                | `src/chains/*`, `src/methods/*` (se accede vía `core.verify/settle`)       |
| `src/middleware/`         | `src/infra/*`, tipos Fastify                            | `src/core/*`, `src/methods/*`, `src/chains/*`                              |
| `src/infra/`              | SDK clients (viem, supabase-js, ioredis, pino, etc.)    | TODO el resto de `src/*`                                                   |
| `src/__tests__/`          | Cualquier cosa (tests tienen bypass)                    | —                                                                           |

### [1] Excepción documentada: `src/core/errors.ts` desde methods

`src/methods/<method>/` puede hacer **runtime import** de `src/core/errors.ts`
(ej.: `buildX402Error`). Es una excepción explícita al boundary general
`methods ↛ core/*`. Justificación:

- **Zero-runtime-deps**: `errors.ts` solo importa `src/core/types.ts` (type-only),
  nada más — sin logger, sin I/O, sin SDK clients.
- **Pure function**: `buildX402Error(code, message?)` no tiene side effects
  (mismo input ⇒ mismo output). Ver CD-4 de WFAC-11.
- **Spec-conformance table**: `HTTP_BY_CODE` y `DEFAULT_MESSAGE_BY_CODE` son
  mappings canónicos de la spec x402 (`docs.x402.org`), tipados como
  `Record<X402ErrorCode, T>` — el compilador fuerza exhaustividad.
- **Origen**: introducido en **WFAC-11**, que también establece este patrón.

**Regla para futuros módulos** en `src/core/*.ts` que quieran ser importables
en runtime desde `src/methods/<method>/`:

1. Zero runtime deps más allá de `src/core/types.ts` (type-only).
2. Pure — sin side effects, sin logger, sin I/O, sin state.
3. Tipos exhaustivos (`Record<FiniteUnion, T>`, no `Partial`, no `as const`
   cuando se quiere fuerza del compilador).
4. Documentarse **explícitamente** en esta matriz como excepción (nueva
   nota `[N]`). Si no está aquí, AR la marca BLOQUEANTE.

---

## Reglas de boundary

1. **Agregar nueva chain = 1 archivo en `src/chains/<name>.ts` + 1 línea en `registry.ts`**.
   Si tenés que tocar `src/core/` para soportar la chain, parar y reevaluar.

2. **Agregar nuevo method = 1 directorio en `src/methods/<name>/`**.
   El method expone `verify()` y `settle()` con shape `Promise<Result<T>>`. `core` dispatcheta
   por `accepted.extra.assetTransferMethod`.

3. **Routes no conocen chains ni methods**. Reciben request Zod-validated, llaman a
   `core.verify()` o `core.settle()`, mapean el `Result` a respuesta HTTP.

4. **Middleware es infrastructure-only**. Request-id, CORS, rate-limit, validation,
   error-handler. Nada de lógica semántica del facilitator.

5. **`core/` nunca lanza**. Ver `.nexus/project-context.md` sección "Service Layer — Response
   Contract". Siempre discriminated union `{ ok: true, ... } | { ok: false, error }`.

---

## Cross-project rules (ecosystem WasiAI)

wasiai-facilitator es **standalone**. NUNCA importar de `wasiai-a2a` o `wasiai-v2`.
Si necesitás algo de esos proyectos, se expone como HTTP API o npm package público.

---

## Auditoría

- **AR reviewer** verifica boundaries en cada PR que toca más de 1 módulo
- **ESLint** (post-V1, TD-NN) enforzará boundaries vía `eslint-plugin-boundaries`
- Violación = AR `BLOQUEANTE`

---

*Adopción: 2026-04-21 — patrón heredado de luma-ai*
