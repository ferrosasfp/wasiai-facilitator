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
| `src/chains/<chain>.ts`   | `src/chains/types.ts`, `src/chains/abi/*.ts` (ver [3]), `src/infra/wallet.ts` (para Account operator — WFAC-50 DT-J), `src/infra/solana-dedup.ts` (dedup durable no-EVM — ver [5]), viem, `@solana/web3.js` (v1, red no-EVM) | `src/core/*` (runtime), `src/methods/*`, `src/routes/*`, otras chains, `src/infra/supabase.ts` (directo) |
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

### [2] `src/core/audit.ts` — observabilidad HTTP (WFAC-33)

`src/core/audit.ts` sigue el mismo boundary que `src/core/ledger.ts`:

- **MAY import**: `src/infra/supabase.ts` (runtime, solo `getSupabaseClient`),
  `pino` (type-only), `fastify` (side-effect import que sostiene el
  `declare module 'fastify'` que augmenta `FastifyRequest.auditMeta`),
  `src/core/types.ts` (type-only, para `X402ErrorCode`).
- **MUST NOT import**: `@supabase/supabase-js` directo (acceso vía wrapper),
  `src/chains/*`, `src/methods/*`, `src/routes/*`.
- **Consumido desde**: `src/app.ts` (hook global `onResponse`). Las rutas
  `src/routes/settle.ts` y `src/routes/verify.ts` **NO** importan
  `audit.ts` directamente — solo setean el decorator opcional
  `request.auditMeta` (cuya firma vive en `audit.ts` vía la declaración
  `declare module 'fastify'`). Esta es la única forma de cruzar metadata
  route → hook sin romper el boundary `routes ↛ core/audit`.
- **Contratos clave**: `persistAuditEntry` es fail-open (CD-1 — nunca
  propaga al caller); `buildAuditEntry` es pure function (CD-7) con
  truncation `ip→45` / `user_agent→512` (CD-8); el objeto INSERT no
  incluye `timestamp` (CD-13 — DB genera vía `DEFAULT NOW()`); PII (ip,
  user_agent) nunca se loguea en stdout, solo se persiste en DB (CD-4).

Origen: **WFAC-33**.

### [3] Nota: `src/chains/abi/*.ts` — duplicados spec-fijos (WFAC-50)

`src/chains/abi/fiat-token.ts` y `src/chains/abi/signature.ts` son **duplicados
controlados** de `src/methods/eip3009/abi.ts` y `src/methods/eip3009/signature.ts`
respectivamente. Razón: el boundary `chains ↛ methods` es estricto, y estos
archivos contienen spec-literal de EIP-3009 necesaria para que los chain
adapters hagan EIP-712 recovery inline.

- **Sincronía obligatoria**: cambios al source en `src/methods/eip3009/` DEBEN
  replicarse en `src/chains/abi/` en el mismo PR (CD-NEW-SDD-1).
- **Test de detección**: `T-SDD-1-ABI-SYNC` en
  `src/__tests__/unit/chain-adapter.test.ts` compara byte-for-byte
  `FIAT_TOKEN_ABI`, `EIP3009_TYPES`, `EIP3009_PRIMARY_TYPE`,
  `RECEIPT_TIMEOUT_MS`, y la salida funcional de `normalizeSignature`.
- **Refactor futuro**: `TD-CHAINS-ABI-DUP` en `BACKLOG.md` — mover canónico a
  `src/chains/abi/` y re-exportar desde `src/methods/eip3009/` para unificar la
  fuente de verdad.

Origen: **WFAC-50** (DT-A + DT-K).

### [4] Excepción documentada: refactor namespace-agnóstico de `core/` (WKH-204 / HU-SOL-2)

La regla #1 de boundary ("si tenés que tocar `src/core/` para soportar la chain,
parar y reevaluar") tiene una **excepción explícita y única**: el refactor
namespace-agnóstico de WKH-204, que generalizó el core de **EVM-only**
(keyed por `chainId` numérico) a **multi-red por namespace** (`eip155:` |
`solana:` | futuros). Este refactor era estructural (fundación de abstracción),
no "soporte de una chain concreta".

- **Cambio de KEY**: la clave interna de `ChainRegistry` ahora es
  `networkId: string` (`"eip155:<chainId>"`, `"solana:devnet"`, …), NO
  `ChainId` numérico. `getAdapterByNetworkId(networkId)` es el lookup primario;
  `getAdapter(chainId)` quedó como wrapper O(1) EVM (`eip155:${chainId}` +
  `Map.get`) que preserva su contrato byte-idéntico.
- **Dispatch por namespace**: `core/verify.ts` y `core/settle.ts` anteponen una
  rama `solana:` (cluster `devnet`/`mainnet`) ANTES del cuerpo eip155 —
  textualmente intacto. Cluster inválido → `NETWORK_MISMATCH` (400); namespace
  válido sin adapter → `CHAIN_UNAVAILABLE` (503). NO se agregó ningún valor
  nuevo a `X402ErrorCode`.
- **Contrato de adapter**: se extrajo `SettlementAdapter` (verify-only, sin
  viem clients) y `ChainAdapter extends SettlementAdapter` (parte EVM viem).

**Regla para agregar una red NO-EVM a futuro** (post-WKH-204): sigue siendo
1 archivo `src/chains/<red>.ts` + 1 línea en `registry.ts` con su
`metadata.networkId` — **SIN volver a tocar `core/`**. La abstracción de
namespace ya vive en el core; el core no se re-modifica por red.

Origen: **WKH-204 / HU-SOL-2**.

### [5] Excepción documentada: `src/chains/solana-adapter.ts` ↔ `src/infra/solana-dedup.ts` (WKH-205 / HU-SOL-6)

`src/chains/solana-adapter.ts` **MAY** hacer runtime import de `src/infra/solana-dedup.ts`
(dedup durable Postgres del money-path no-EVM: `isSolanaSignatureSettled` +
`recordSolanaSignature`). Es el análogo no-EVM de `src/infra/wallet.ts` para el
broadcast EVM: el adapter Solana verify-only necesita una barrera anti-replay
durable (`UNIQUE(signature)`), y esa barrera vive en la capa infra (única que
puede importar `@supabase/supabase-js`).

- **El adapter NO importa `src/infra/supabase.ts` directo** — solo el wrapper
  `solana-dedup.ts` (mismo patrón que `core/ledger.ts` accede a Supabase solo
  vía `getSupabaseClient`).
- `src/infra/solana-dedup.ts` sigue el boundary de `src/infra/*`: MAY import
  `@supabase/supabase-js` (vía `infra/supabase.ts`), `pino` (type-only); MUST
  NOT import `src/chains/*`, `src/core/*`, `src/methods/*`, `src/routes/*`.
- El adapter lee `process.env` DIRECTO (NO importa `src/infra/env.ts`), igual
  que los adapters EVM (`base-adapter.ts` lee `process.env` para el circuit
  breaker / OPERATOR_MIN_BALANCE_WEI).

Origen: **WKH-205 / HU-SOL-6**.

### [6] Excepción documentada: rutas dedicadas no-x402 → `methods/*`, `chains/*`

La matriz dice `src/routes/ ↛ src/chains/*, src/methods/*` porque las rutas x402
(`settle`, `verify`) acceden a esas capas **vía `core.verify/settle`**. Las rutas
**dedicadas no-x402** de Solana son una excepción explícita y acotada:

| Ruta | Importa de `methods/*` / `chains/*` |
|---|---|
| `src/routes/solana-sponsor.ts` | `methods/solana-sponsor/{broadcast,cr1,pop}.ts` |
| `src/routes/solana-escrow.ts`  | `methods/solana-escrow/{build-release,cr1-release}.ts`, `chains/solana-escrow.ts` |
| `src/routes/solana-payout.ts`  | `methods/solana-payout/*`, `chains/solana-escrow.ts` (`deriveAta`) |

**Alcance explícito**: SOLO esas tres rutas. Cualquier otra ruta sigue bajo la
regla general.

Justificación (por qué NO se enruta por `core/*`):

- Estas rutas no son del camino x402. `core/verify.ts` y `core/settle.ts` son el
  dispatcher del **contrato x402** (`SettleRequest` → adapter de chain); no hay
  nada que dispatchear acá: no hay `PaymentPayload`, no hay adapter de chain que
  elija el namespace.
- Hacerlas pasar por `core/*` obligaría a meter conocimiento **no-EVM específico
  de instrucción** (forma del `deposit`/`release`/`TransferChecked`, keypairs de
  Solana, PDAs) dentro del core — exactamente lo que la excepción `[4]` declara
  prohibido tras el refactor namespace-agnóstico de WKH-204 ("el core no se
  re-modifica por red").
- El estado de hecho ya era éste: `solana-sponsor.ts` y `solana-escrow.ts` lo
  hacen desde WKH-217/WKH-216, y `methods/solana-escrow/build-release.ts` importa
  runtime de `chains/solana-escrow.ts`. Esta nota **documenta** el patrón que ya
  existía, que es el requisito de la "Regla para futuros módulos" de `[1]`.

Condiciones que estas rutas SÍ mantienen: no importan `chains/registry.ts`, no
tocan `core/settle.ts` / `core/verify.ts`, y su contrato de request/response es
**route-local** (Zod propio, unión de errores propia) — nunca widenizan un tipo
compartido del camino EVM (`X402ErrorCode`, `HTTP_BY_CODE`, `AuditMeta.errorCode`).

Origen: **WKH-217 / WKH-216** (estado de hecho), documentado en **WKH-302**.

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
