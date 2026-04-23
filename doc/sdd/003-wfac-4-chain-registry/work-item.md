# Work Item — [WFAC-4] Chain Registry Plug-in Architecture

## Metadata

| Campo | Valor |
|-------|-------|
| HU-ID | WFAC-4 |
| NNN | 003 |
| Slug | chain-registry |
| Jira | https://ferrosasfp.atlassian.net/browse/WFAC-4 |
| Branch sugerido | `feat/003-wfac-4-chain-registry` |
| Épica | E1 Core Infrastructure / E6 Chain Adapters |
| Fecha | 2026-04-23 |

---

## Resumen

Se construye el **sistema de registro y descubrimiento de chain adapters** de wasiai-facilitator. Esto incluye la interface `ChainAdapter` (contrato que todo adapter de chain debe cumplir), el type `ChainMetadata` (datos estáticos de cada chain), el singleton `ChainRegistry` con operaciones de registro y lookup O(1), y los módulos `src/chains/kite.ts` y `src/chains/avalanche.ts` como primeras implementaciones concretas del contrato.

Este módulo es **foundation contract**: WFAC-10 (verify), WFAC-11 (settle), WFAC-22 (/supported), WFAC-50+ (chain adapters) son todos bloqueados por esta HU. Sin `ChainAdapter` definido, ningún adapter concreto puede existir. Sin `ChainRegistry`, `core/verify.ts` y `core/settle.ts` no tienen cómo obtener el cliente viem correcto por `chainId`.

---

## Contexto de negocio

wasiai-facilitator nació para eliminar la dependencia de Pieverse (outage de `/v2/verify` el 2026-04-13). El valor diferencial es ser **multi-chain extensible**: agregar soporte para una nueva chain debe ser `1 archivo + 1 línea en registry` sin modificar `src/core/`. Esto requiere que el registry sea el único lugar que conoce qué chains existen, y que `core` lo consuma vía interface sin acoplarse a implementaciones concretas.

Sin esta abstracción, cada `chainId` nuevo implica `if/switch` en `core/` — rompe el contrato de extensibilidad y se convierte en deuda técnica inmediata.

---

## Sizing

- **SDD_MODE**: full
- **Modo NexusAgil**: QUALITY (mueve dinero — foundation contract para settle)
- **Estimación**: M (2-3 días dev + review)
- **Branch sugerido**: `feat/003-wfac-4-chain-registry`

Justificación QUALITY: aunque no hay lógica de negocio compleja, este es el contrato de extensibilidad más crítico del sistema. Un diseño erróneo en `ChainAdapter` o `ChainRegistry` implica refactor masivo cuando lleguen WFAC-50+. No hay lugar para FAST aquí.

---

## Acceptance Criteria (EARS)

### Happy paths — Lookup y List

**AC-1** (Event-driven): WHEN `ChainRegistry.getAdapter(chainId)` is called with a `chainId` that was registered at module initialization, the system SHALL return `{ ok: true, adapter: ChainAdapter }` with the corresponding adapter instance in O(1) time.

**AC-2** (Event-driven): WHEN `ChainRegistry.listAdapters()` is called, the system SHALL return an array containing one `ChainMetadata` entry for each registered chain, with no duplicate `chainId` values.

**AC-3** (Event-driven): WHEN `ChainRegistry.getSupportedChainIds()` is called, the system SHALL return an array of all registered `chainId` numbers with no duplicates.

### Error paths — Lookups inválidos

**AC-4** (Unwanted): IF `ChainRegistry.getAdapter(chainId)` is called with a `chainId` that was NOT registered, THEN the system SHALL return `{ ok: false, error: { code: 'NETWORK_MISMATCH', message: string, http: 400 } }` — NUNCA throw.

**AC-5** (Unwanted): IF `ChainRegistry.register(adapter)` is called with an adapter whose `chainId` is already registered, THEN the system SHALL return `{ ok: false, error: { code: 'NETWORK_MISMATCH', message: 'Chain already registered: <chainId>', http: 409 } }` and SHALL NOT overwrite the existing adapter.

**AC-6** (Unwanted): IF `ChainRegistry.register(adapter)` is called with an adapter object that does not satisfy the `ChainAdapter` interface at runtime (missing required methods), THEN the system SHALL return `{ ok: false, error: { code: 'NETWORK_MISMATCH', message: 'Invalid adapter: missing required methods', http: 500 } }`.

### TypeScript compile-time guards

**AC-7** (Ubiquitous): The system SHALL define `ChainAdapter` as a TypeScript `interface` such that any object failing to implement the required methods `getPublicClient()`, `getWalletClient()`, `getChainMetadata()`, `verify()`, and `settle()` produces a **compile-time error** when passed to `ChainRegistry.register()`.

**AC-8** (Ubiquitous): The system SHALL define `ChainMetadata` as a TypeScript `interface` with fields `chainId: number`, `name: string`, `network: string`, `rpcUrl: string`, `nativeCurrency: { name: string; symbol: string; decimals: number }`, and `tokens: Record<string, `0x${string}`>` — all required, no optional fields in V1.

### Module-load initialization

**AC-9** (State-driven): WHILE the application boots (before first HTTP request), the system SHALL initialize `ChainRegistry` with all adapters defined in `src/chains/` such that at least one chain is registered before the health endpoint becomes available.

**AC-10** (Event-driven): WHEN `ChainRegistry` is initialized, the system SHALL log a structured JSON message at `info` level listing each registered `chainId` and `name`, using Pino — PROHIBIDO `console.log`.

### Chain adapter implementations

**AC-11** (Ubiquitous): `src/chains/kite.ts` SHALL implement `ChainAdapter` for Kite Testnet (chainId `2368`) with RPC URL read from `process.env.KITE_TESTNET_RPC_URL` — NEVER hardcoded.

**AC-12** (Ubiquitous): `src/chains/kite.ts` SHALL implement `ChainAdapter` for Kite Mainnet (chainId `2366`) as a second export, with RPC URL from `process.env.KITE_MAINNET_RPC_URL`.

**AC-13** (Unwanted): IF `KITE_TESTNET_RPC_URL` or `KITE_MAINNET_RPC_URL` is not set at adapter construction time, THEN the chain adapter SHALL throw a startup error (acceptable at init, not at request time) with a clear message indicating which env var is missing.

### Test coverage

**AC-14** (Ubiquitous): The system SHALL have unit tests for `ChainRegistry` covering: register success, register duplicate (error path), getAdapter found, getAdapter not found (error path), listAdapters, and getSupportedChainIds — achieving ≥95% statement coverage on `src/chains/registry.ts` and `src/core/types.ts`.

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `src/core/types.ts` | `Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode` discriminated union — las primitivas de todo el service layer |
| `src/chains/types.ts` | `ChainAdapter` interface + `ChainMetadata` interface + `RegisterResult` type |
| `src/chains/registry.ts` | Singleton `ChainRegistry` con `register()`, `getAdapter()`, `listAdapters()`, `getSupportedChainIds()` |
| `src/chains/kite.ts` | Adapter Kite Testnet (2368) + Kite Mainnet (2366) |
| `src/chains/avalanche.ts` | Adapter Avalanche Fuji (43113) — stub OK, métodos `verify/settle` retornan `NETWORK_MISMATCH` pending WFAC-52 |
| `src/__tests__/unit/chain-registry.test.ts` | Tests unitarios del registry |
| `src/__tests__/unit/types.test.ts` | Tests del discriminated union |

## Scope OUT

| Artefacto | Razón |
|-----------|-------|
| `src/core/verify.ts` | WFAC-10 — fuera de esta HU |
| `src/core/settle.ts` | WFAC-11 — fuera de esta HU |
| `src/core/idempotency.ts` | WFAC-4 Redis (distinto ticket) |
| `src/core/schemas.ts` | WFAC-20 /verify route |
| `src/core/errors.ts` | Parte de `src/core/types.ts` en esta HU — solo los 10 códigos del spec como type-literal |
| `src/methods/` | E2 — fuera de esta HU |
| `src/routes/` | E3 — fuera de esta HU |
| `src/infra/wallet.ts` | Wallet singleton per chain — es infra, no registry. Puede referenciarse desde kite.ts pero no se crea aquí |
| Avalanche Mainnet (43114) | WFAC-53 — diferido a V1.1 |
| Kite Mainnet registro en producción | WFAC-51 — diferido (adapter stub OK en kite.ts) |
| Integration tests contra testnet real | WFAC-60 / WFAC-61 |
| viem `WalletClient` hydration | `getWalletClient()` en kite.ts puede retornar stub/lazy — wallet real es WFAC-32+ |

---

## Decisiones técnicas

**DT-A: Registry auto-discovery vs registro explícito**

Opciones consideradas:
- A1: Auto-discovery via glob `src/chains/*/index.ts` at runtime
- A2: Registro explícito en `src/chains/registry.ts` con import list manual

Decisión: **A2 — registro explícito**. Justificación: auto-discovery requiere `fs.readdir` en runtime, que es frágil en builds bundled (Railway), añade latencia de startup variable, y hace difícil predecir qué está registrado sin leer el filesystem. Con registro explícito, `registry.ts` es la única fuente de verdad: ver ese archivo es ver exactamente qué chains están activas. El costo (1 línea de import por chain nueva) es trivial vs la predictibilidad ganada.

`[NEEDS CLARIFICATION: si hay preferencia por auto-discovery por parte del arquitecto, puede revertirse en F2]`

**DT-B: `ChainAdapter` interface — métodos obligatorios V1**

Métodos mínimos que un adapter DEBE implementar en V1:

```ts
interface ChainAdapter {
  getChainMetadata(): ChainMetadata;
  getPublicClient(): PublicClient;   // viem — lectura + receipt wait
  getWalletClient(): WalletClient;   // viem — operator signing
  verify(params: VerifyParams): Promise<Result<VerifyOk>>;
  settle(params: SettleParams): Promise<Result<SettleOk>>;
}
```

`verify` y `settle` son los críticos para el x402 protocol. `getPublicClient` / `getWalletClient` los usa `core` para la ejecución on-chain. `getChainMetadata` lo usa `/supported` para autodescripción.

Métodos diferidos a V2: `getGasPrice()`, `estimateGas()`, `watchBlocks()`.

`[NEEDS CLARIFICATION: VerifyParams y SettleParams — Architect decide si son los del spec x402 directamente o wrappers internos. Marcar como TBD en F2]`

**DT-C: `getAdapter` retorna discriminated union vs Optional vs throw**

Opciones:
- C1: `throw new Error('Chain not found')`
- C2: `return undefined | ChainAdapter`
- C3: `return Result<{ adapter: ChainAdapter }>`

Decisión: **C3 — discriminated union `Result<T>`**. Regla del proyecto: `src/core/` y capas que interactúan con él NUNCA lanzan por errores previstos. "Chain not encontrada" es previsible. El caller (`core/verify.ts`) puede exhaustivamente manejar el error sin try/catch.

**DT-D: Registry singleton vs clase instanciable**

Opciones:
- D1: `export const chainRegistry = new ChainRegistry()` — singleton module-level
- D2: Clase `ChainRegistry` exportada + caller la instancia

Decisión: **D1 — singleton**. El registry es estado global del proceso. Múltiples instancias serían confusas y romperían el invariante de "un chain registrado una vez". La clase existe internamente para facilitar testing (se puede resetear con un método `_reset()` en test env), pero el export público es siempre el singleton.

**DT-E: `ChainMetadata` shape — campos V1**

```ts
interface ChainMetadata {
  chainId: number;
  name: string;           // "Kite Testnet"
  network: string;        // "eip155:2368" (x402 spec format)
  rpcUrl: string;         // desde env var, no hardcoded
  blockExplorer?: string; // opcional — no crítico para V1
  nativeCurrency: {
    name: string;         // "Kite"
    symbol: string;       // "KITE"
    decimals: number;     // 18
  };
  tokens: Record<string, `0x${string}`>; // tokenSymbol → address
}
```

`blockExplorer` es el único campo opcional. Todo lo demás es requerido para que `/supported` pueda funcionar sin casos edge.

**DT-F: viem types — reuse vs wrappers propios**

Decisión: **reuse directo de viem v2 types** (`PublicClient`, `WalletClient` de `viem`). viem es el stack canónico del proyecto — wrappear sus tipos sería overhead sin beneficio. Si mañana se cambia de viem (improbable), el refactor será explícito. `viem` está en `^2.47.6` — confirmar imports de `viem` (no de subpaths deprecados) en F3.

**DT-G: `src/core/types.ts` — scope de esta HU**

`src/core/types.ts` existía como stub en el project-context (comentado como "lo implementa Dev en WFAC-2"). Verificar que WFAC-2 no lo creó. Si el archivo existe con contenido, esta HU solo complementa — no sobreescribe. Si está vacío/inexistente, esta HU lo crea con: `Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode` (type literal de los 10 códigos), y tipos base de params/responses.

`[NEEDS CLARIFICATION: ¿Architect prefiere que X402ErrorCode y los 10 códigos vivan en `src/core/errors.ts` separado (para que `errors.ts` sea autocontenido) o en `types.ts`? Puede resolverse en F2]`

---

## Constraint Directives

**CD-1**: PROHIBIDO hardcodear `chainId`, `rpcUrl`, `tokenAddress` en ningún archivo de `src/chains/`. Todos los valores vienen de env vars o de constantes exportadas en el adapter con comentario de origen.

**CD-2**: PROHIBIDO que `src/chains/<chain>.ts` importe de `src/core/*`. Permitido solo `src/chains/types.ts` y librerías externas (viem). Ver OWNERS.md.

**CD-3**: PROHIBIDO que `src/chains/registry.ts` importe de `src/core/*`, `src/methods/*`, o `src/routes/*`. Solo puede importar `src/chains/types.ts` y los adapters concretos.

**CD-4**: PROHIBIDO que `ChainRegistry.getAdapter()` lance (throw) para chainId no registrado. OBLIGATORIO retornar `Result<{ adapter: ChainAdapter }>`.

**CD-5**: PROHIBIDO usar `any` explícito o `as unknown` en ningún archivo de `src/chains/` ni `src/core/types.ts`.

**CD-6**: OBLIGATORIO que `rpcUrl` en cada adapter se lea desde `process.env` en tiempo de construcción del adapter. Si la env var está ausente, el adapter DEBE fallar rápido en init (startup error), no silentemente en request time.

**CD-7**: PROHIBIDO `console.log` en archivos de `src/`. Logs estructurados vía Pino únicamente. El registry puede usar el logger de `src/infra/logger.ts` al inicializarse.

**CD-8**: PROHIBIDO que `src/infra/wallet.ts` sea creado en esta HU. `getWalletClient()` en los adapters V1 puede retornar un lazy initializer o un stub marcado con `// TODO: WFAC-infra-wallet` — pero la wallet real queda para una HU posterior.

**CD-9**: OBLIGATORIO que `ChainRegistry` tenga un método `_resetForTesting()` disponible únicamente en `NODE_ENV === 'test'` para limpiar el estado entre tests. En producción, llamarlo DEBE lanzar un `Error` con mensaje `'_resetForTesting() is only available in test environment'`.

**CD-10**: OBLIGATORIO que `src/core/types.ts` defina `X402ErrorCode` como `type` literal union con exactamente los 10 códigos del spec (no más, no menos): `'INVALID_SIGNATURE' | 'INSUFFICIENT_BALANCE' | 'PERMIT2_ALLOWANCE_REQUIRED' | 'EXPIRED_AUTHORIZATION' | 'NETWORK_MISMATCH' | 'SIMULATION_FAILED' | 'INVALID_AMOUNT' | 'INVALID_RECEIVER' | 'TRANSACTION_FAILED' | 'DELEGATION_INVALID'`.

**CD-11**: PROHIBIDO que `ChainRegistry` auto-descubra adapters via filesystem scan. El registro de adapters DEBE ser explícito (import + llamada a `register()` en el módulo `registry.ts`).

---

## Missing Inputs

| Item | Tipo | Resolución |
|------|------|------------|
| `VerifyParams` / `SettleParams` — shape exacto | `[NEEDS CLARIFICATION]` | Architect decide en F2. Puede ser spec x402 directo o wrapper interno |
| `X402ErrorCode` en `types.ts` vs `errors.ts` | `[NEEDS CLARIFICATION]` | Architect decide en F2. No bloquea work-item |
| `getWalletClient()` en adapters V1 — ¿stub o lazy init? | `[NEEDS CLARIFICATION]` | Architect define strategy en F2. CD-8 es el guardrail |
| WFAC-2 creó `src/core/types.ts`? | `[RESUELTO — verificar en F3]` | Dev verifica en Anti-Hallucination wave si el archivo existe antes de crear |
| Jira WFAC-4 como "Redis client" en BACKLOG.md vs "Chain registry" en input | `[NEEDS CLARIFICATION]` | Posible renumeración post-scaffold. Esta HU sigue el número de Jira provisto (WFAC-4 = chain registry). BACKLOG.md puede tener numeración desactualizada. Actualizar BACKLOG.md en esta HU o en retro. |

---

## Análisis de paralelismo

**Esta HU bloquea directamente:**

| HU | Descripción | Tipo de bloqueo |
|----|-------------|----------------|
| WFAC-10 | Verify logic — EIP-712 recovery | Necesita `ChainAdapter` para obtener `PublicClient` |
| WFAC-11 | Settle logic — transferWithAuthorization | Necesita `ChainAdapter.settle()` + `WalletClient` |
| WFAC-22 | GET /supported route | Necesita `ChainRegistry.listAdapters()` |
| WFAC-50 | Kite Testnet adapter (plena) | El stub en kite.ts de esta HU es el esqueleto |

**Puede ir en paralelo con:**

| HU | Por qué no se bloquean |
|----|----------------------|
| WFAC-4-Redis (idempotency cache) | Módulo independiente en `src/core/idempotency.ts` / `src/infra/redis.ts` |
| WFAC-5 CI | Workflow de CI — no tiene dependencias de código |
| WFAC-30 /metrics | Infra — no depende de chain registry |

**No existe riesgo de merge conflict** con las HUs paralelas ya que todas tocan módulos distintos.

---

## Waves preliminares

| Wave | Artefactos | Descripción |
|------|------------|-------------|
| W0 | `src/core/types.ts` | Foundation: `Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode`. Sin esto, nada tipea. |
| W1 | `src/chains/types.ts` | `ChainAdapter` interface, `ChainMetadata`, tipos auxiliares |
| W2 | `src/chains/registry.ts` | `ChainRegistry` singleton — `register`, `getAdapter`, `listAdapters`, `getSupportedChainIds`, `_resetForTesting` |
| W3 | `src/chains/kite.ts` | `kiteTestnetAdapter`, `kiteMainnetAdapter` — implementaciones concretas con env var validation |
| W4 | `src/chains/avalanche.ts` | `avalancheFujiAdapter` — stub con `verify/settle` retornando `NETWORK_MISMATCH` pending WFAC-52 |
| W5 | `src/__tests__/unit/chain-registry.test.ts` | Tests: register, duplicate, lookup found, lookup not-found, list, getSupportedChainIds |
| W6 | `src/__tests__/unit/types.test.ts` | Tests: type narrowing en `Result<T>`, compilación de X402ErrorCode |

---

## Criterios de éxito

| Criterio | Umbral |
|----------|--------|
| Tiempo de inicialización del registry | < 10ms desde import hasta primer `getAdapter` exitoso |
| Complejidad de lookup | O(1) — Map interno, no Array.find |
| Cobertura de tests | ≥ 95% statements en `src/chains/registry.ts` y `src/core/types.ts` |
| TypeScript compilation | 0 errores con `tsc --noEmit --strict` |
| Lint | 0 warnings con `eslint --max-warnings 0` |
| Boundary compliance | AR verifica que ningún archivo de `src/chains/` importe de `src/core/*` |

---

## Skills Router

- `nexus-agile` — metodología QUALITY, pipeline F0→F8
- Dominio primario: `blockchain-evm` (viem, ChainAdapter, x402 contract)
- Dominio secundario: `typescript-patterns` (discriminated union, interface design, singleton pattern)
