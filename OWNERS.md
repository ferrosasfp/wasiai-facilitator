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
| `src/methods/<method>/`   | `src/chains/types.ts` (solo tipos), viem, ABIs propias  | `src/core/*`, `src/chains/registry.ts`, otros methods                      |
| `src/routes/`             | `src/core/*`, `src/infra/*`, Zod schemas                | `src/chains/*`, `src/methods/*` (se accede vía `core.verify/settle`)       |
| `src/middleware/`         | `src/infra/*`, tipos Fastify                            | `src/core/*`, `src/methods/*`, `src/chains/*`                              |
| `src/infra/`              | SDK clients (viem, supabase-js, ioredis, pino, etc.)    | TODO el resto de `src/*`                                                   |
| `src/__tests__/`          | Cualquier cosa (tests tienen bypass)                    | —                                                                           |

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
