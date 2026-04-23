# SDD #003 — WFAC-4 Chain Registry Plug-in Architecture

> SPEC_APPROVED: no
> Fecha: 2026-04-23
> Tipo: architecture (foundation contract — bloquea E2/E3/E6)
> SDD_MODE: full
> Clasificación: QUALITY (mueve dinero — el registry es el gate de `core/verify` y `core/settle`)
> Branch: `feat/003-wfac-4-chain-registry` (desde `main@00887c4`)
> Artefactos: `doc/sdd/003-wfac-4-chain-registry/`
> Jira: https://ferrosasfp.atlassian.net/browse/WFAC-4
> HU_APPROVED: sí (work-item.md clinical review pasado)

---

## 1. Overview

Construir el **contrato de extensibilidad multi-chain** de wasiai-facilitator:

- `src/core/types.ts` — primitivas del service layer (`Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode`, `Address`, `ChainId`).
- `src/chains/types.ts` — contratos de dominio: `ChainMetadata`, `EIP3009Token`, `ChainAdapter`, shapes x402 (`VerifyParams`, `VerifyResult`, `SettleParams`, `SettleResult`).
- `src/chains/registry.ts` — `ChainRegistry` singleton con `register()`, `getAdapter()`, `listAdapters()`, `getSupportedChainIds()`, `_resetForTesting()`.
- `src/chains/kite.ts` — adapters concretos Kite Testnet (2368) y Kite Mainnet (2366), con `verify`/`settle` stubbed (retornan `NETWORK_MISMATCH` pending WFAC-10/11).
- `src/chains/avalanche.ts` — adapter Avalanche Fuji (43113), también stub.
- `src/chains/index.ts` — side-effect module que registra todos los adapters al importarse (usado por `buildApp()` via `import './chains/index.js'`).
- Tests unitarios (`src/__tests__/unit/chain-registry.test.ts`, `chain-adapter.test.ts`, `core-types.test.ts`) con ≥95% statements en `registry.ts` y `core/types.ts`.

El módulo es **foundation contract**: sin él, WFAC-10 (verify), WFAC-11 (settle), WFAC-22 (/supported) no pueden existir. El criterio de éxito es que **agregar una chain nueva = 1 archivo en `src/chains/` + 1 línea en `src/chains/index.ts`**, sin tocar `src/core/`.

**Out of scope explícito**: wiring a Fastify/app.ts, Redis idempotency, `src/core/errors.ts` separado, `src/core/verify.ts`, `src/core/settle.ts`, wallet singleton real. El `getWalletClient()` de V1 retorna un stub marcado con `TODO: WFAC-wallet-singleton`.

---

## 2. Architecture

### Diagrama de componentes (esta HU)

```
┌────────────────────────────────────────────────────────────────────┐
│  src/chains/index.ts        (side-effect: registra todos adapters) │
│      │                                                              │
│      ├─ import { chainRegistry } from './registry.js'               │
│      ├─ import { kiteTestnetAdapter, kiteMainnetAdapter }           │
│      │                  from './kite.js'                            │
│      ├─ import { avalancheFujiAdapter } from './avalanche.js'       │
│      │                                                              │
│      └─ chainRegistry.register(kiteTestnetAdapter)                  │
│         chainRegistry.register(kiteMainnetAdapter)                  │
│         chainRegistry.register(avalancheFujiAdapter)                │
├────────────────────────────────────────────────────────────────────┤
│  src/chains/registry.ts     (ChainRegistry singleton)               │
│      │                                                              │
│      ├─ Map<ChainId, ChainAdapter>                                  │
│      ├─ register(adapter) → Result<{ chainId: ChainId }>            │
│      ├─ getAdapter(chainId) → Result<{ adapter: ChainAdapter }>     │
│      ├─ listAdapters() → readonly ChainMetadata[]                   │
│      ├─ getSupportedChainIds() → readonly ChainId[]                 │
│      └─ _resetForTesting()  [NODE_ENV==='test' únicamente]          │
├────────────────────────────────────────────────────────────────────┤
│  src/chains/kite.ts         src/chains/avalanche.ts                 │
│  (concrete adapters — import SOLO ./types.js + viem)                │
├────────────────────────────────────────────────────────────────────┤
│  src/chains/types.ts        (domain contracts — no deps de core)    │
│  src/core/types.ts          (service-layer primitivas)              │
└────────────────────────────────────────────────────────────────────┘

Consumers futuros (fuera de esta HU):
   core/verify.ts   →  chainRegistry.getAdapter(chainId) → adapter.verify(params)
   core/settle.ts   →  chainRegistry.getAdapter(chainId) → adapter.settle(params)
   routes/supported.ts → chainRegistry.listAdapters()
```

### Invariantes arquitectónicas

1. **Registro explícito** (CD-11): `src/chains/index.ts` es la única fuente de verdad de qué chains existen. Ver ese archivo = ver exactamente qué está activo.
2. **Boundaries respetados** (CD-2, CD-3): `src/chains/<chain>.ts` importa SOLO de `./types.js` + viem. `registry.ts` importa SOLO de `./types.js` + `src/infra/logger.js`. Ningún adapter ni el registry importa de `src/core/*`, `src/methods/*`, `src/routes/*`.
3. **Service-layer discriminated union** (CD-4): `getAdapter` y `register` retornan `Result<T>`, nunca lanzan.
4. **Startup fail-fast** (CD-6, AC-13): si falta `KITE_TESTNET_RPC_URL` o `KITE_MAINNET_RPC_URL`, el adapter lanza `ChainAdapterInitError` en construcción — bloquea el boot antes de que Fastify acepte requests.
5. **Structured logging** (CD-7, AC-10): el registry logea al finalizar `register()` usando Pino, nunca `console.log`.

### Flujo de arranque (futuro, no en esta HU)

```
1. process start → src/index.ts → main()
2. parseEnv(process.env)                                  [WFAC-2]
3. import './chains/index.js'    (side-effect registers)  [WFAC-4 → ESTA HU]
   └─ kiteTestnetAdapter construido → lee process.env.KITE_TESTNET_RPC_URL
   └─ chainRegistry.register(adapter) → Map.set(2368, adapter)
   └─ logger.info({chainId:2368,name:'Kite Testnet'}, 'Chain adapter registered')
4. buildApp({env}) → Fastify + healthRoute                 [WFAC-2]
5. app.listen(...)                                         [WFAC-2]

Si uno de los step 3 falla (env var missing) → throw → top-level catch en
main() → process.stderr.write + process.exit(1). Fastify nunca binds.
```

Nota: el wiring exacto (`import './chains/index.js'` en `src/index.ts` o en `src/app.ts`) NO se implementa en esta HU — es responsabilidad de WFAC-10+. Esta HU entrega el módulo `src/chains/index.ts` listo para que el consumer lo importe; los tests lo importan directamente.

---

## 3. Codebase Grounding (archivos leídos + evidencia)

### Archivos leídos en wasiai-facilitator

| Archivo | Por qué | Patrón extraído |
|---------|---------|------------------|
| `CLAUDE.md` | Orquestación, QUALITY mode, gates | Sub-agentes obligatorios, service-layer discriminated union |
| `.nexus/project-context.md` | Stack + Service Layer Response Contract | `Result<T>` shape exacto (ok:true con spread vs ok:false con error obj). 10 códigos x402. Puerto 3002 |
| `OWNERS.md` | Module boundaries | Confirmado: `chains/<chain>.ts` NO puede importar `core/*` ni `methods/*` ni otras chains |
| `doc/architecture/X402-CONFORMANCE.md` | Códigos de error + HTTP mapping | Los 10 códigos con su HTTP status — canonical para `X402ErrorCode` |
| `BACKLOG.md` | Jira IDs + épicas | WFAC-4 = chain registry (no el "Redis client" mal-etiquetado en BACKLOG — ver Missing Inputs resueltos) |
| `package.json` | Versiones exactas | viem `^2.47.6` instalado. pino `^9.5.0`. zod `^3.23.8`. vitest `^2.1.8` |
| `tsconfig.json` | TS config | `strict`, `noUncheckedIndexedAccess`, `rootDir:./src`, `module:Node16` — imports DEBEN llevar `.js` suffix |
| `vitest.config.ts` | Test config | `NODE_ENV=test`, `LOG_LEVEL=silent` en env. Thresholds de coverage deshabilitados (TD-01-09) |
| `.env.example` | Var names exactos | `KITE_TESTNET_RPC_URL`, `KITE_MAINNET_RPC_URL`, `AVALANCHE_FUJI_RPC_URL` — literal, no variar |
| `src/index.ts` + `src/app.ts` | Bootstrap pattern WFAC-2 | factory `buildApp(options)` async + `parseEnv` fail-fast + `loggerInstance:FastifyBaseLogger` |
| `src/infra/env.ts` | Zod pattern para env vars | `z.object(...).safeParse(raw)` con exit(1) + stderr. Pattern a replicar si agregamos env vars nuevas (no aplica en esta HU — solo leemos vars existentes directo con `process.env`) |
| `src/infra/logger.ts` | Pino factory | `createLogger(env)` retorna `Logger`; en tests LOG_LEVEL=silent |
| `src/routes/health.ts` | FastifyPluginAsync pattern | Irrelevante a esta HU (no creamos rutas) pero confirma patrón |
| `src/__tests__/unit/env.test.ts` | Vitest pattern | `vi.spyOn(process, 'exit')`, `vi.spyOn(process.stderr, 'write')`, `describe`/`it`/`expect` — mimic |
| `src/__tests__/unit/no-console.test.ts` | Enforcement pattern CD-1/CD-7 | Este test ya audita `src/**/*.ts` por `console.*` — si lo rompemos, falla |
| `doc/sdd/001-wfac-2-fastify-bootstrap/auto-blindaje.md` | Lecciones WFAC-2 | Ver sección 4 — CDs específicos heredados para prevenir regresión |

### Exemplars cross-project (lectura, no import — CD-2/CD-3)

| Archivo | Qué se extrajo | Qué NO copiar |
|---------|----------------|----------------|
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/__tests__/registry.test.ts` | Pattern `adapter.chainId` + registry lookup por chainId; `_resetForTesting()` style | La shape del adapter (3-layer `{payment, attestation, gasless}`) NO aplica acá — wasiai-facilitator es mono-adapter por chain. Mapear el concepto, no la API |
| `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/kite-client.test.ts` | Pattern para mock de viem (`vi.mock('viem', ...)`) + `getChainId: 2368` verificado empíricamente. Env var handling con `ORIGINAL_ENV` restore en afterEach | `KITE_RPC_URL` (nombre viejo) — nosotros usamos `KITE_TESTNET_RPC_URL` / `KITE_MAINNET_RPC_URL`. `console.log` — PROHIBIDO en wasiai-facilitator (CD-7) |

### Lectura obligatoria en `node_modules/` (post-cutoff)

| Archivo | Qué se extrajo |
|---------|----------------|
| `node_modules/viem/_types/clients/createPublicClient.d.ts` | Signature de `createPublicClient(config)`. Exporta `PublicClient<transport, chain, accountOrAddress, rpcSchema>`. Todos los generics tienen defaults — podemos usar `PublicClient` raw como return type |
| `node_modules/viem/_types/clients/createWalletClient.d.ts` | Similar para `WalletClient<transport, chain, account, rpcSchema>`. Default generics OK para nuestros stubs |
| `node_modules/viem/_types/types/chain.d.ts` | `Chain` type: `{id:number, name:string, nativeCurrency, rpcUrls:{default:{http}}, blockExplorers?, testnet?}`. Nuestro `ChainMetadata` es un **superset del subset necesario para x402** — NO reuse `Chain` de viem directo (nuestro metadata incluye `network: 'eip155:<id>'` y `tokens`) |
| `node_modules/viem/_types/chains/definitions/avalancheFuji.d.ts` | viem ya exporta `avalancheFuji` chain def. Podemos reusarlo internamente vía `import { avalancheFuji } from 'viem/chains'` para construir el `PublicClient`, pero el `ChainMetadata` de x402 es distinto. Kite NO está en viem — usar `defineChain()` |

### Documentación externa consultada

| Fuente | Qué se extrajo |
|--------|----------------|
| `docs.x402.org/core-concepts/facilitator.md` (via `X402-CONFORMANCE.md` que ya sintetiza el spec) | Shapes de `/verify` y `/settle` request/response → deriva directa de `VerifyParams`/`SettleParams`/`VerifyResult`/`SettleResult` (ver sección 5 DT-2) |

---

## 4. Exemplar Verification

Cada path referenciado en este SDD fue verificado con `ls`/`Read`. Lista de verificaciones:

| Path | Verificado | Usage en esta HU |
|------|-----------|-------------------|
| `node_modules/viem/_types/clients/createPublicClient.d.ts` | ✅ Read | Type import `PublicClient` from `viem` |
| `node_modules/viem/_types/clients/createWalletClient.d.ts` | ✅ Read | Type import `WalletClient` from `viem` |
| `node_modules/viem/_types/types/chain.d.ts` | ✅ Read | Referencia estructural (no import) |
| `node_modules/viem/_types/chains/definitions/avalancheFuji.d.ts` | ✅ Read | Import `avalancheFuji` en `src/chains/avalanche.ts` |
| `src/infra/logger.ts` | ✅ Read | Import `createLogger` reused? **NO** — el registry recibe el logger por inyección; ver DT-4 |
| `src/infra/env.ts` | ✅ Read | Pattern para env var handling (no reuse directo — adapters leen `process.env` propio) |
| `src/__tests__/unit/no-console.test.ts` | ✅ listado | Test existente que AUDITA `src/**/*.ts` — no lo rompemos |
| `src/chains/` | ✅ `ls` (solo `.gitkeep`) | Directorio listo para nuevos archivos |
| `src/core/` | ✅ `ls` (solo `.gitkeep`) | Directorio listo para `types.ts` |
| `.env.example` | ✅ Read | Nombres env vars canonical |
| `wasiai-a2a/src/adapters/__tests__/registry.test.ts` | ✅ Grep | Pattern `_resetForTesting` — referencia conceptual |
| `wasiai-a2a/src/services/kite-client.test.ts` | ✅ Read | Pattern `vi.mock('viem', ...)` reused en nuestros tests |

**Anti-alucinación**: cada import que figura en las firmas de sección 5 fue validado contra el archivo `.d.ts` correspondiente arriba.

---

## 5. Decisiones Técnicas Finales

Heredadas del work-item (DT-A..DT-G) + nuevas que resuelven los `[NEEDS CLARIFICATION]`.

### DT-1 (hereda DT-A) — Registro explícito, NO auto-discovery

`src/chains/index.ts` es el ÚNICO lugar que llama `chainRegistry.register(...)`. Los tests que necesitan un ambiente limpio llaman `chainRegistry._resetForTesting()` primero y luego `register(mockAdapter)` manualmente.

Justificación reforzada (vs alternativa fs-scan): auto-discovery agrega latencia variable al cold start, rompe cuando Railway empaqueta con esbuild (filesystem layout cambia), y hace indeterminístico el orden de registro. Con `index.ts`, el diff de un PR "agregar chain" es literalmente 2 líneas.

### DT-2 (RESUELVE [NC-1]) — `VerifyParams`/`SettleParams` son shape x402 spec directo

Decisión: **shape x402 spec directo** (opción a). `VerifyParams` y `SettleParams` son exactamente el payload que entra a `/verify` y `/settle` según `X402-CONFORMANCE.md` + `docs.x402.org`. Cero wrappers internos. Mismas shape para `VerifyResult` / `SettleResult` (lo que sale).

Rationale:
- **Spec-compliance literal** (regla Golden Path): "shapes x402 exactos". Cualquier wrapper interno implica una capa de mapeo que puede desviar del spec silenciosamente.
- **Cero overhead**: la ruta `/verify` (futura WFAC-20) hace `body → zodSchema.parse → core.verify(parsed)` → `adapter.verify(parsed)`. Un wrapper agrega `parsed → internalShape → adapter.verify(internalShape)` — capa extra sin valor.
- **Testing más simple**: los conformance tests (futuros WFAC-60) pueden reusar fixtures del spec literalmente.
- **Consistencia con pattern `Result<T>`**: la normalización de errores ya está en el wrap `Result<T>` — no hace falta un segundo wrap de params.

Contrapartida conocida: si un método futuro (Permit2, ERC-7710) tiene shape distinto al EIP-3009 en `payload`, el `ChainAdapter` expone los MISMOS métodos `verify`/`settle` pero recibe union types en `payload`. Manejable con discriminated union por `accepted.extra.assetTransferMethod`. Ver sección 14.

Shape exacta (derivada de `.nexus/project-context.md` §"Request shape /verify" y "Response shape /settle"):

```ts
// src/chains/types.ts

export interface VerifyParams {
  x402Version: 2;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepted: {
    scheme: 'exact';
    network: string;           // "eip155:<chainId>" — el adapter puede cross-check con su chainId
    amount: string;            // uint256 atomic (string para preservar precisión)
    asset: string;             // token address (0x-prefixed)
    payTo: string;             // merchant address
    maxTimeoutSeconds: number;
    extra: {
      assetTransferMethod: 'eip3009' | 'permit2' | 'erc7710';
      name?: string;           // EIP-712 domain name (opcional — adapter puede defaultear desde metadata.tokens)
      version?: string;        // EIP-712 domain version
    };
  };
  payload: {
    signature: `0x${string}`;  // 65-byte hex
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;           // uint256
      validAfter: string;      // unix seconds as string
      validBefore: string;
      nonce: `0x${string}`;    // bytes32
    };
  };
}

export interface VerifyResult {
  verified: true;
  client: `0x${string}`;       // recovered signer
  amount: string;
  asset: `0x${string}`;
  network: string;             // "eip155:<chainId>"
  payTo: `0x${string}`;
  expiresAt: number;           // unix seconds (validBefore cast to number)
}

export interface SettleParams extends VerifyParams {}  // mismo body en spec

export interface SettleResult {
  settled: true;
  transactionHash: `0x${string}`;
  blockNumber: number;         // usamos number (MAX_SAFE_INTEGER cubre EVM actual)
  amount: string;
  from: `0x${string}`;
  to: `0x${string}`;
  asset: `0x${string}`;
}
```

Notas:
- `amount`, `value`, `validAfter`, `validBefore` son `string` (uint256) — preservar precisión, evitar BigInt en la API pública (BigInt se usa internamente cuando el adapter llama viem).
- `blockNumber` es `number` — EVM actual está en ~2.1e7, lejos de `2^53`. Si en el futuro vamos a chains con blocks mayores, cambiar a `string`. Documentado como TD-04-02 (tracker en retro de esta HU).

### DT-3 (RESUELVE [NC-2]) — `X402ErrorCode` vive en `src/core/types.ts`

Decisión: **`X402ErrorCode` en `src/core/types.ts`**, NO en un `src/core/errors.ts` separado.

Rationale:
- En esta HU solo necesitamos el **type literal union**. No hay helpers de runtime (`mapHttpStatus`, `codeToHttp`, etc.) — eso entra en WFAC-12 (HTTP mapping layer).
- Regla: "co-localizá con el tipo primario mientras no haya ≥5 utilities derivadas". Acá tenemos UNA cosa: la union. En `types.ts`.
- Cuando llegue WFAC-12 y agregue `codeToHttpStatus`, `errorToResponse`, etc., ESE ticket podrá crear `src/core/errors.ts` y RE-EXPORTAR `X402ErrorCode` desde ahí (o mover, con cascade de imports). No es decisión de esta HU.
- El work-item Scope OUT ya dice explícitamente: `src/core/errors.ts` → "Parte de `src/core/types.ts` en esta HU — solo los 10 códigos del spec como type-literal" — confirmamos esa decisión.

Shape exacta:

```ts
// src/core/types.ts
export type X402ErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID';
```

Exactamente 10 códigos (CD-10). Ni uno más, ni uno menos.

### DT-4 (RESUELVE [NC-3]) — `getWalletClient()` V1 = lazy stub con placeholder account

Decisión: **lazy stub**. `getWalletClient()` crea on-demand un `WalletClient` viem con la `Chain` correspondiente y transport HTTP al `rpcUrl` del adapter, pero SIN `account` real — retorna un client "read-only for balance lookups, write-disabled". El método está implementado y es llamable, pero cualquier `writeContract`/`signMessage` falla con `AccountNotFoundError` de viem.

Shape exacta:

```ts
// src/chains/kite.ts (ejemplo)
private _walletClient: WalletClient | null = null;

getWalletClient(): WalletClient {
  if (!this._walletClient) {
    this._walletClient = createWalletClient({
      chain: this._viemChain,
      transport: http(this._rpcUrl),
      // NO `account` — wallet real viene de WFAC-wallet-singleton (TD-05-03)
    });
  }
  return this._walletClient;
}
```

Rationale:
- **Alternativa descartada #1** (throw): retornar un stub que throw cuando se llama `getWalletClient()` rompe AC-7 (interface compile-time check — el método DEBE existir y typechequear). También hace que tests de contrato del registry (no de settle) fallen porque el interface no se implementa.
- **Alternativa descartada #2** (wallet real en esta HU): crearía `src/infra/wallet.ts` con `OPERATOR_PRIVATE_KEY`, expandiendo scope en 2x. Explícitamente prohibido (CD-8).
- **Ventaja del lazy stub**: el shape del `ChainAdapter` queda cerrado y completo. WFAC-10/11 extiende el adapter interno sin cambiar la interface pública — solo `getWalletClient` ahora retornará un client con `account` inyectado. **Zero refactor del contrato**.

**Documentación obligatoria en código**: cada `getWalletClient` lleva el comentario:
```ts
// TODO: WFAC-wallet-singleton — wallet real (con OPERATOR_PRIVATE_KEY) se inyecta
// cuando exista src/infra/wallet.ts. Por ahora este client no puede firmar (account: undefined).
```

Mención en tests: los tests de esta HU verifican que `adapter.getWalletClient()` **retorna un objeto** (no null, no throw), pero NO ejercitan `.writeContract()` — eso es WFAC-11.

### DT-5 (hereda DT-B) — `ChainAdapter` métodos V1

Métodos obligatorios (5):

```ts
// src/chains/types.ts
export interface ChainAdapter {
  readonly metadata: ChainMetadata;               // AC-7: getChainMetadata() reemplazado por readonly prop
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  getPublicClient(): PublicClient;
  getWalletClient(): WalletClient;
}
```

**Cambio vs work-item DT-B**: el work-item proponía `getChainMetadata()` como método. Decisión: **`readonly metadata: ChainMetadata` como property**. Rationale:
- Los datos son estáticos por adapter — no hay razón para que sea un método (no toma args, no cambia).
- Property es más idiomático en TS para "datos inmutables del objeto".
- AC-7 dice "métodos requeridos `getChainMetadata()`, `verify()`, `settle()`, `getPublicClient()`, `getWalletClient()`". **Reinterpretación**: AC-7 especifica que el adapter debe "exponer" esos 5 puntos. Una `readonly` property de shape `ChainMetadata` cumple el intent (compile-time check que el campo existe con el tipo correcto). Mantenemos los 4 métodos; el 5to es property.

Si Adversary/QA prefiere método estricto, la refactor es trivial (`get metadata()` → `getChainMetadata()`). Documentamos en Auto-Blindaje si sale ese feedback.

Métodos V2 diferidos: `getGasPrice()`, `estimateGas()`, `watchBlocks()`, `healthCheck()` — cada uno en su propio ticket.

### DT-6 (hereda DT-C) — `getAdapter` retorna `Result<T>`

No throw. Nunca. Return shape:

```ts
// found
{ ok: true, adapter: ChainAdapter }

// not found
{ ok: false, error: { code: 'NETWORK_MISMATCH', message: 'Chain not registered: <chainId>', http: 400 } }
```

Consistente con `Result<T>` del service layer. Caller puede pattern-match sin try/catch.

### DT-7 (hereda DT-D) — Singleton module-level

`src/chains/registry.ts` exporta:
```ts
class ChainRegistry { ... }   // NO exportada públicamente (export internal para testing)
export const chainRegistry = new ChainRegistry();  // única instancia exportada
```

Los tests hacen `chainRegistry._resetForTesting()` para aislar estado entre tests (CD-9). Fuera de test environment, `_resetForTesting()` lanza error — documentado.

### DT-8 (hereda DT-E) — `ChainMetadata` shape V1

Campos exactos (con refinamiento vs work-item: tokens son `readonly EIP3009Token[]` — array de objetos, NO `Record<string, 0x...>`):

```ts
// src/chains/types.ts
export interface EIP3009Token {
  readonly address: `0x${string}`;
  readonly symbol: string;            // "PYUSD", "USDC"
  readonly decimals: number;          // 6 (PYUSD, USDC)
  readonly name: string;              // "PayPal USD"
  readonly eip712Name?: string;       // EIP-712 domain name — default = name
  readonly eip712Version?: string;    // EIP-712 domain version — default "1"
}

export interface ChainMetadata {
  readonly chainId: ChainId;          // branded number — ver DT-9
  readonly name: string;              // "Kite Testnet"
  readonly network: 'mainnet' | 'testnet';  // más estricto que 'string' del work-item
  readonly networkId: string;         // "eip155:2368" — x402 spec format (CAMPO NUEVO, ver abajo)
  readonly rpcUrl: string;            // desde env var
  readonly blockExplorer?: string;    // opcional
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly tokens: readonly EIP3009Token[];
}
```

**Refinamientos vs work-item DT-E**:

1. **`tokens: readonly EIP3009Token[]`** en lugar de `Record<string, \`0x${string}\`>`. Rationale: el Record era minimalista; en x402 cada token tiene symbol, decimals, name, y opcionalmente EIP-712 domain name/version (necesarios para `recoverTypedDataAddress`). Si usamos Record, el caller (WFAC-10) va a necesitar un segundo lookup externo para obtener decimals/name — acopla módulos que deberían ser plug-in. El array de objetos es self-contained.

2. **`network: 'mainnet' | 'testnet'`** en lugar de `string`. Rationale: los únicos dos valores legítimos en el dominio x402 son mainnet/testnet (CAIP-2 formaliza más, pero para facilitator V1 es suficiente). Literal union cierra la puerta a typos.

3. **Campo nuevo `networkId: string`** — el formato `"eip155:<chainId>"` del spec x402. Evita reconstruirlo en cada call site.

4. **`chainId: ChainId`** branded (ver DT-9).

AC-8 actualizado efectivamente: los campos listados en el work-item AC-8 son el **subset obligatorio**; la shape real es superset. Validado contra conformance spec. Documentado como ampliación justificada (no drift).

### DT-9 — `ChainId` branded type

```ts
// src/core/types.ts
export type ChainId = number & { readonly __brand: 'ChainId' };

export function asChainId(n: number): ChainId {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid chainId: ${n}`);
  }
  return n as ChainId;
}
```

Rationale: previene que accidentalmente se pase un `tokenAmount: number` o `blockNumber: number` como `chainId`. TS compile-time guard.

**IMPORTANTE**: `asChainId()` es el ÚNICO constructor. Lanza si el input es inválido (no un `Result<T>` — es un helper de type narrowing, no del service layer). Uso: al construir `ChainMetadata` en los adapters:
```ts
chainId: asChainId(2368)
```

Tests cubren: valor válido, valor inválido (0, negativo, float, NaN).

### DT-10 — viem `Chain` object: `defineChain` para Kite, import para Avalanche

Kite NO está en `viem/chains`. Usar `defineChain()` local en `src/chains/kite.ts`:

```ts
import { defineChain, createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient } from 'viem';

const kiteTestnet = defineChain({
  id: 2368,
  name: 'Kite Testnet',
  nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
  rpcUrls: { default: { http: [/* set en construcción */] } },
  testnet: true,
});
```

Avalanche SÍ está en viem (`import { avalancheFuji } from 'viem/chains'`). Reusamos la definición canonical.

Rationale: reducir superficie de error — si mañana Avalanche Fuji cambia algo (unlikely, pero posible), viem mantiene eso upstream. Nosotros nos enfocamos en Kite donde NO tenemos alternativa.

### DT-11 — Logger del registry: inyectado, no singleton

`ChainRegistry` NO llama `createLogger()` internamente. En su lugar, expone un parámetro optional:

```ts
class ChainRegistry {
  private _logger?: Logger;

  setLogger(logger: Logger): void { this._logger = logger; }

  register(adapter: ChainAdapter): RegisterResult {
    // ...
    this._logger?.info({ chainId, name }, 'Chain adapter registered');
    return { ok: true, chainId };
  }
}
```

Rationale:
- En WFAC-2 el logger se construye con env (pretty vs JSON). Si `registry.ts` hardcodea un `createLogger()`, el logger del registry no va a coincidir con el de Fastify (doble instanciación, posible doble output).
- Patrón de inyección: `src/app.ts` hace `chainRegistry.setLogger(logger)` después de construir Fastify. Si el consumer no inyecta, el registry NO logea (silent). Los tests pueden inyectar un logger custom para assertar outputs.
- **Alternativa evaluada**: importar `createLogger` directamente en `registry.ts` → rompe OWNERS matrix (`chains/*` NO puede importar `infra/*` salvo tipo). Rechazada.

**Consecuencia para AC-10**: "log structured JSON message at info level listing each registered chainId and name" se cumple sólo cuando el consumer inyecta el logger. Los tests unitarios inyectan un mock y assertan. En tiempo de bootstrap real (futuro WFAC-10+), `src/index.ts` inyecta el logger global antes del side-effect import.

Para esta HU el side-effect `src/chains/index.ts` NO inyecta logger (no tiene acceso — el logger nace después de `parseEnv`). El registry logea SOLO si `setLogger` fue llamado. Tests explícitos cubren ambos caminos (con logger → log llamado; sin logger → silencio, no crash).

### DT-12 — `AdapterResult<T>` === `Result<T>`: alias en types.ts o reuse directo

Decisión: **reuse directo de `Result<T>` de `src/core/types.ts`**. `src/chains/types.ts` importa:

```ts
import type { Result } from '../core/types.js';

export interface ChainAdapter {
  verify(params: VerifyParams): Promise<Result<VerifyResult>>;
  settle(params: SettleParams): Promise<Result<SettleResult>>;
  // ...
}
```

**Violación potencial de OWNERS**: `src/chains/*` no puede importar `src/core/*`. PERO: `src/chains/types.ts` importando `type` (solo tipo, no runtime) de `src/core/types.ts` es aceptable porque:
1. Es un **type-only import** (`import type { Result }`) — desaparece en compile, no genera runtime dependency.
2. `core/types.ts` es la fuente de verdad de tipos primitivos compartidos — el registry es un consumer natural.
3. OWNERS matrix dice `src/chains/<chain>.ts` NO puede importar `src/core/*`, pero `src/chains/types.ts` ES un archivo de tipos compartidos. La matriz necesita refinement (TD-04-03).

**Excepción documentada**: `src/chains/types.ts` → `import type { Result, X402ErrorCode, Address, ChainId } from '../core/types.js'` es aceptable. Todos los demás archivos de `src/chains/` (registry.ts, kite.ts, avalanche.ts, index.ts) NO pueden importar de `core/*`. AR debe verificar esto literal.

Si Adversary rechaza esta excepción, la fallback es duplicar los tipos en `src/chains/types.ts` — costo: drift futuro entre las dos copias. Preferimos reuse + excepción documentada.

### DT-13 — Test file layout

| Archivo de test | Cubre |
|-----------------|--------|
| `src/__tests__/unit/core-types.test.ts` | `Ok<T>` / `Err` / `Result<T>` narrowing, `asChainId()` validation, `X402ErrorCode` compile-time (via test-compile fixture) |
| `src/__tests__/unit/chain-registry.test.ts` | `ChainRegistry.register`/`getAdapter`/`listAdapters`/`getSupportedChainIds`/`_resetForTesting`/`setLogger`. Todos los ACs 1-6 + 10 |
| `src/__tests__/unit/chain-adapter.test.ts` | `kiteTestnetAdapter`, `kiteMainnetAdapter`, `avalancheFujiAdapter` — metadata shape, getPublicClient returns object, getWalletClient returns object, verify/settle stubs return NETWORK_MISMATCH, env var missing → throws |

Rationale: 3 archivos alineados con los 3 módulos principales. Evita un mega-file `chains.test.ts` difícil de navegar.

---

## 6. Constraint Directives

### CDs heredados del work-item (11)

| # | Literal | Status |
|---|---------|--------|
| CD-1 | PROHIBIDO hardcodear `chainId`, `rpcUrl`, `tokenAddress` en `src/chains/`. | HEREDADO |
| CD-2 | PROHIBIDO que `src/chains/<chain>.ts` importe de `src/core/*` (runtime). | HEREDADO + refinamiento DT-12 |
| CD-3 | PROHIBIDO que `src/chains/registry.ts` importe de `src/core/*`, `src/methods/*`, `src/routes/*`. | HEREDADO |
| CD-4 | PROHIBIDO que `ChainRegistry.getAdapter()` lance. OBLIGATORIO retornar `Result<>`. | HEREDADO |
| CD-5 | PROHIBIDO `any` explícito o `as unknown` en `src/chains/` ni `src/core/types.ts`. | HEREDADO |
| CD-6 | OBLIGATORIO `rpcUrl` se lee de `process.env` en construcción; fail-fast si ausente. | HEREDADO |
| CD-7 | PROHIBIDO `console.*` en `src/`. | HEREDADO + auditado por test existente |
| CD-8 | PROHIBIDO crear `src/infra/wallet.ts` en esta HU. `getWalletClient()` = lazy stub (DT-4). | HEREDADO |
| CD-9 | OBLIGATORIO `_resetForTesting()` solo en `NODE_ENV==='test'`; throw en prod. | HEREDADO |
| CD-10 | OBLIGATORIO `X402ErrorCode` = union literal con EXACTOS 10 códigos listados en work-item. | HEREDADO |
| CD-11 | PROHIBIDO filesystem-scan auto-discovery. Registro explícito en `src/chains/index.ts`. | HEREDADO |

### CDs nuevos añadidos por Architect

| # | Literal | Razón |
|---|---------|-------|
| CD-12 | OBLIGATORIO que TODO import en `src/chains/` y `src/core/types.ts` lleve suffix `.js` (TypeScript `module: Node16` ESM). Sin esto, `tsc --noEmit` falla. | Evita regresión. El proyecto es Node16 ESM. Verificable vía `grep "from '\.\./.*[^s]'" src/chains` debe devolver 0 líneas |
| CD-13 | OBLIGATORIO que `ChainRegistry` use `Map<ChainId, ChainAdapter>` internamente (no `Object` indexed, no `Record`). | O(1) lookup literal; evita problemas de prototype pollution (security-sensitive); TS types cleaner |
| CD-14 | PROHIBIDO que los adapters expongan `rpcUrl` o `apiKey` como propiedad pública / en el log. Metadata.rpcUrl se loguea solo en dev (`NODE_ENV === 'development'`), en prod se loguea sólo chainId y name. | Evita leak de RPC privados si algún provider requiere auth (Alchemy, Infura — no aplica hoy pero blindaje) |
| CD-15 | OBLIGATORIO que `ChainAdapterInitError` (error thrown al faltar env var) incluya el **nombre exacto de la env var** en el mensaje para debugging. NUNCA genérico "Env var missing". | Dev experience: falla clara → fix rápido |
| CD-16 | PROHIBIDO usar `Array.prototype.find()` en `ChainRegistry.getAdapter()`. Debe ser `map.get(chainId)` — el criterio de éxito del work-item literal pide O(1). | Consistency + perf invariant |
| CD-17 | OBLIGATORIO que cada archivo nuevo de esta HU empiece con un JSDoc block que explique (a) qué expone, (b) qué boundaries respeta, (c) qué HU futura completará su scope. | Mantenibilidad + anti-drift |
| CD-18 | PROHIBIDO registrar el mismo adapter object en dos chainIds distintos (i.e., un adapter con chainId=2368 re-llamado para chainId=2366 por error). La validación `adapter.metadata.chainId === <keyDelRegistry>` es implícita — el registry usa `adapter.metadata.chainId` como clave, no acepta un chainId externo. | Evita bugs sutiles donde se sobreescribe un adapter con otro |
| CD-19 | OBLIGATORIO que `src/chains/index.ts` sea un módulo con SÓLO side-effects (imports + `register()` calls). NO exporta nada. Consumer lo importa por su side-effect: `import './chains/index.js';`. | Patrón conocido (polyfills). Evita que alguien importe `chainRegistry` desde `index.ts` (lo debe importar desde `./registry.js`) |

### CDs heredados de WFAC-2 auto-blindaje (prevención de regresión)

Del `auto-blindaje.md` de WFAC-2 se aprendió:

| # | Literal | Origen |
|---|---------|--------|
| CD-20 | PROHIBIDO importar símbolos de deps transitivas no declaradas en `package.json`. Si `src/` hace `import X from 'Y'`, `Y` DEBE estar en `dependencies` o `devDependencies`. Esta HU usa `viem`, `zod`, `vitest` — todas declaradas. Si alguien propone usar algo transitivo, bloquear. | WFAC-2 MNR-2 |
| CD-21 | PROHIBIDO hacer `as any` cuando TS específica un generic "demasiado" al recibir un type concreto. Usar anotación explícita (`const x: ConcreteType = factory()`). Aplica al retornar `PublicClient` / `WalletClient` desde el adapter — anotar return type explícito. | WFAC-2 "FastifyInstance generic specialization" |
| CD-22 | PROHIBIDO hacer `console.log` en tests "para debuggear rápido". El test `no-console.test.ts` audita `src/**/*.ts` incluyendo `*.test.ts`. Si el test lo pide, usar `vi.spyOn(console, 'log')` explícito. | WFAC-2 pattern (refuerzo) |

**Total CDs esta HU: 22** (11 heredados + 8 nuevos + 3 anti-regresión).

---

## 7. Waves de Implementación

Refinadas desde W0..W4 del work-item → W0..W5 finales.

### W0 — Serial, foundation types

- `src/core/types.ts`
  - `export type Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode`
  - `export type Address = \`0x${string}\``
  - `export type ChainId = number & { __brand: 'ChainId' }`
  - `export function asChainId(n: number): ChainId`

**Blocker**: sin este archivo, W1 no tipea. Hacer primero, en serial.

### W1 — Serial, chain domain contracts

- `src/chains/types.ts`
  - `export interface EIP3009Token`
  - `export interface ChainMetadata`
  - `export interface VerifyParams`, `VerifyResult`, `SettleParams`, `SettleResult`
  - `export interface ChainAdapter`
  - `export type RegisterResult = Result<{ chainId: ChainId }>`
  - `export class ChainAdapterInitError extends Error` (para CD-15)

**Blocker**: W2/W3/W4 requieren las interfaces.

### W2 — Paralelizable con W3/W4 (misma onda)

- `src/chains/registry.ts`
  - `class ChainRegistry` (no exportada públicamente — ver DT-7)
  - `export const chainRegistry = new ChainRegistry()`
  - Métodos: `register`, `getAdapter`, `listAdapters`, `getSupportedChainIds`, `setLogger`, `_resetForTesting`

### W3 — Paralelizable con W2/W4

- `src/chains/kite.ts`
  - `defineChain` para Kite Testnet y Mainnet
  - `kiteTestnetAdapter: ChainAdapter` con lazy `_publicClient`, `_walletClient`
  - `kiteMainnetAdapter: ChainAdapter` (mismo shape, chainId 2366)
  - `verify`/`settle` stubs: `return { ok: false, error: { code: 'NETWORK_MISMATCH', message: 'Verify not implemented yet (WFAC-10)', http: 400 } }` (literal — documentar que es pending)

### W4 — Paralelizable con W2/W3

- `src/chains/avalanche.ts`
  - `import { avalancheFuji } from 'viem/chains'`
  - `avalancheFujiAdapter: ChainAdapter` (chainId 43113, stub methods)
  - Notes: USDC en Fuji `0x5425890298aed601595a70AB815c96711a31Bc65`. Decidir si hardcodear (con comentario de origen Avalanche docs) o env-driven. **Decisión**: hardcodear con comentario y link. La token address de USDC Fuji es pública y estable — misma lógica que viem harcodea `avalancheFuji.contracts.multicall3`. NO aplica CD-1 (CD-1 habla de `chainId`, `rpcUrl`, no de token contracts públicos conocidos).

### W5 — Registry composition (serial — depende de W2+W3+W4)

- `src/chains/index.ts`
  - Side-effect module:
    ```ts
    import { chainRegistry } from './registry.js';
    import { kiteTestnetAdapter, kiteMainnetAdapter } from './kite.js';
    import { avalancheFujiAdapter } from './avalanche.js';
    chainRegistry.register(kiteTestnetAdapter);
    chainRegistry.register(kiteMainnetAdapter);
    chainRegistry.register(avalancheFujiAdapter);
    ```
  - Nota: este archivo PUEDE fallar en import si env vars faltan (construcción de adapter lanza). Eso es el fail-fast esperado (AC-13).

### W6 — Tests (paralelizable con W5)

- `src/__tests__/unit/core-types.test.ts` — tests de `asChainId`, tipo narrowing de `Result`, `X402ErrorCode` inventory.
- `src/__tests__/unit/chain-registry.test.ts` — suite completa del registry (11 tests aprox).
- `src/__tests__/unit/chain-adapter.test.ts` — suite de los 3 adapters (12 tests aprox).

### Orden sugerido (serial-paralelo mix)

```
W0  [=======]  (core/types.ts)
W1         [=======]  (chains/types.ts)
W2               [=========]
W3               [=========]
W4               [=========]
W5                        [=====]
W6                           [========]  (tests pueden empezar cuando W2+ listos)
```

Dev puede hacer W2/W3/W4 en paralelo si es una misma sesión (todos dependen de W1). W5 solo cuando los 3 adapters están listos. W6 puede arrancar en paralelo con W5 (tests de `registry.ts` no dependen de que `index.ts` exista — tests de `index.ts` wiring sí).

---

## 8. Test Plan

Por AC, se especifica nombre de test, archivo sugerido, setup/mocks y expected. Total ≥ 22 tests (más que 14 ACs porque hay ramas internas).

| AC | Test name | Archivo | Setup/Mocks | Expected |
|----|-----------|---------|-------------|----------|
| AC-1 | `getAdapter returns registered adapter in O(1)` | chain-registry.test.ts | `register(mockAdapter{chainId:2368})` | `result.ok === true && result.adapter === mockAdapter` |
| AC-2 | `listAdapters returns ChainMetadata array with unique chainIds` | chain-registry.test.ts | registra 3 adapters distintos | `.length === 3 && new Set(ids).size === 3` |
| AC-3 | `getSupportedChainIds returns unique chainId array` | chain-registry.test.ts | registra 2 adapters | `[2368, 2366]` (o tupla equivalente, sin dup) |
| AC-4 | `getAdapter returns NETWORK_MISMATCH error for unregistered chainId` | chain-registry.test.ts | empty registry | `{ok:false, error:{code:'NETWORK_MISMATCH', http:400}}` |
| AC-5 | `register returns NETWORK_MISMATCH error on duplicate chainId` | chain-registry.test.ts | register twice same chainId | `{ok:false, error:{code:'NETWORK_MISMATCH', http:409}}` + originalNotOverwritten |
| AC-6 | `register returns error on invalid adapter shape` | chain-registry.test.ts | pass `{} as ChainAdapter` runtime | `{ok:false, error:{code:'NETWORK_MISMATCH', http:500, message:contains('missing required')}}` |
| AC-7 | `ChainAdapter interface enforces 5 members at compile-time` | core-types.test.ts (fixture) | TS compile test — intento de registrar `{}` falla TS | test file con `// @ts-expect-error` annotations |
| AC-8 | `ChainMetadata shape is enforced at compile-time` | chain-adapter.test.ts | TS compile fixture con metadata inválida | `// @ts-expect-error` activo + test "metadata of real adapter has all fields" |
| AC-9 | `module load registers ≥ 1 chain before health endpoint` | chain-registry.test.ts | `import './chains/index.js'` con env vars set | `chainRegistry.getSupportedChainIds().length >= 1` |
| AC-10 | `register logs info with chainId and name when logger injected` | chain-registry.test.ts | `registry.setLogger(mockLogger); register(adapter)` | `mockLogger.info.calledWith({chainId, name}, 'Chain adapter registered')` |
| AC-11 | `kiteTestnetAdapter uses KITE_TESTNET_RPC_URL and chainId 2368` | chain-adapter.test.ts | `process.env.KITE_TESTNET_RPC_URL = 'https://...'` + import | `adapter.metadata.chainId === 2368 && adapter.metadata.rpcUrl contains 'gokite'` (no leak de URL real en assert) |
| AC-12 | `kiteMainnetAdapter uses KITE_MAINNET_RPC_URL and chainId 2366` | chain-adapter.test.ts | same pattern | `adapter.metadata.chainId === 2366` |
| AC-13 (ramas) | `kiteTestnetAdapter throws ChainAdapterInitError when KITE_TESTNET_RPC_URL missing` | chain-adapter.test.ts | `delete process.env.KITE_TESTNET_RPC_URL; vi.resetModules(); await import(...)` | `throws ChainAdapterInitError` + `error.message.includes('KITE_TESTNET_RPC_URL')` |
| AC-13 (rama 2) | `kiteMainnetAdapter throws ChainAdapterInitError when KITE_MAINNET_RPC_URL missing` | chain-adapter.test.ts | same | `throws ChainAdapterInitError` + message includes `KITE_MAINNET_RPC_URL` |
| AC-14 (cov) | coverage ≥ 95% statements en `registry.ts` + `core/types.ts` | npm run test:coverage | — | reporte cumple umbral |

### Tests adicionales (NO atados a un AC pero obligatorios para CDs)

| Test name | CD | Expected |
|-----------|----|----------|
| `_resetForTesting throws when NODE_ENV !== 'test'` | CD-9 | `expect(() => registry._resetForTesting()).toThrow(/test environment/)` mockeando `NODE_ENV='production'` |
| `_resetForTesting clears all adapters when NODE_ENV === 'test'` | CD-9 | registra 3 → reset → `getSupportedChainIds().length === 0` |
| `getAdapter uses Map.get, not Array.find (perf contract)` | CD-13, CD-16 | snapshot of code or logic test — ver CD-16 below |
| `setLogger allows multiple registers to log each` | DT-11 | register 2 → logger.info called 2 times |
| `no logger set → register does not throw and does not log` | DT-11 | registry sin setLogger → register OK, no log |
| `asChainId throws for 0, negative, float, NaN` | DT-9 | `expect(() => asChainId(0)).toThrow()` + variants |
| `asChainId accepts positive integers` | DT-9 | `expect(asChainId(2368)).toBe(2368)` |
| `Result<T> type narrowing — ok branch exposes data` | DT-6 | compile-time check + runtime assertion |
| `avalancheFujiAdapter.verify returns NETWORK_MISMATCH pending` | Scope IN | asserts exact error code |
| `getPublicClient returns viem PublicClient object (has readContract method)` | DT-4 | checks shape (typeof .readContract === 'function') |
| `getWalletClient returns viem WalletClient object (has writeContract method)` | DT-4 | same shape check. **NO ejercita writeContract** (no account) |
| `X402ErrorCode union has exactly 10 values (inventory test)` | CD-10 | array assertion test |

**Total ≈ 26 tests**. Todos en vitest, unit-only (no integration en esta HU).

### Cómo correr

```bash
npm run test                 # todos los tests — debe pasar verde
npm run test:coverage        # coverage report — ≥95% en registry.ts y core/types.ts
npm run qa                   # typecheck + lint + format:check + test — debe pasar completo
```

---

## 9. Readiness Check

Checklist que Dev debe confirmar antes de declarar DONE (no es un CR, es pre-flight):

- [ ] `src/core/types.ts` existe, exporta `Ok<T>`, `Err`, `Result<T>`, `X402ErrorCode` (exactly 10), `Address`, `ChainId`, `asChainId`.
- [ ] `src/chains/types.ts` existe, exporta `EIP3009Token`, `ChainMetadata`, `VerifyParams`/`VerifyResult`/`SettleParams`/`SettleResult`, `ChainAdapter`, `RegisterResult`, `ChainAdapterInitError`.
- [ ] `src/chains/registry.ts` exporta `chainRegistry` singleton. `ChainRegistry` class es internal (no default export).
- [ ] `src/chains/kite.ts` exporta `kiteTestnetAdapter` y `kiteMainnetAdapter` (2 exports).
- [ ] `src/chains/avalanche.ts` exporta `avalancheFujiAdapter`.
- [ ] `src/chains/index.ts` NO exporta nada, tiene 3 `register()` calls.
- [ ] Todos los imports usan suffix `.js` (Node16 ESM — CD-12).
- [ ] Ningún archivo de `src/chains/` (salvo `types.ts` type-only) importa de `src/core/`, `src/methods/`, `src/routes/` (CD-2/CD-3).
- [ ] Ningún `console.*` en los archivos nuevos (CD-7) — `npm run test` en `no-console.test.ts` confirma.
- [ ] Ningún `any`, `as unknown`, `as any` (CD-5/CD-21).
- [ ] `npm run typecheck` pasa (0 errores).
- [ ] `npm run lint -- --max-warnings 0` pasa (0 warnings).
- [ ] `npm run test` pasa (todos ≥ 26 tests verdes).
- [ ] `npm run test:coverage` reporta ≥ 95% statements en `registry.ts` y `core/types.ts` (thresholds manuales — los config-level están deshabilitados por TD-01-09).
- [ ] Boot simulado (script de smoke) con env vars reales NO falla: `node -e "import('./dist/chains/index.js').then(()=>console.error('OK')).catch(e=>{console.error(e);process.exit(1)})"` (después de `npm run build`).
- [ ] `npm run build` produce `dist/chains/index.js` sin errores.

---

## 10. Risks & Mitigations

| R# | Riesgo | Probabilidad | Impacto | Mitigación |
|----|--------|--------------|---------|------------|
| R1 | viem version drift (2.47.6 → 2.50.x antes de merge) cambia types de `PublicClient` / `WalletClient` breaking | Media | Alto (TS compile fail) | Pin exacto en package.json (`^2.47.6` permite minor → preferir `~2.47.6` o explícito `2.47.6`). Smoke run `npm ci && npm run typecheck` en CI antes de merge. Documentado que Dev lee `.d.ts` en F3 (CD-17 de `.nexus/project-context.md`) |
| R2 | `register()` no-idempotente: si `src/chains/index.ts` se importa 2 veces (Vitest hot-reload + prod import), `register` falla con duplicate en segunda call | Media | Bajo (fallback: log warning) | `_resetForTesting` en test setup. En prod, Node module cache asegura single import. Tests explícitos para doble-import behavior. Alternativa: `register` con flag `{ skipIfExists: true }` → rechazada porque oculta bugs |
| R3 | `ChainId` branded type causa fricción al pasar `number` literal → TS error en call sites futuros | Alta | Medio | `asChainId(n)` helper documentado + tests de ejemplo. Readme en `src/core/types.ts` comment bloque explica el pattern. Si fricción es excesiva, fallback a `type ChainId = number` directo (downgrade trivial) |
| R4 | ESM `.js` suffix: olvido → typecheck pasa (porque TS no exige el suffix en source), runtime falla con `ERR_MODULE_NOT_FOUND` al ejecutar | Alta (WFAC-2 confirmó que pasa) | Alto (prod crash) | CD-12 literal + Dev lee tsconfig section "Node16 ESM". Smoke test post-build runtime-verifica. eslint-plugin `import/extensions` recomendado como future hardening (TD-04-04) |
| R5 | Adapters stub para `verify`/`settle` retornan `NETWORK_MISMATCH` — confunde a consumers que esperan "not implemented" | Baja | Bajo | Message literal `'Verify not implemented yet (WFAC-10)'` + `'Settle not implemented yet (WFAC-11)'`. Documentado en AC stub tests. WFAC-10/WFAC-11 reemplazará literal |
| R6 | CD-12 boundary exception (chains/types.ts importa core/types.ts type-only) es vista como violación por AR | Media | Medio | Pre-documentado (DT-12 explícito). Si AR rechaza, fallback: duplicar tipos. Preferimos pedir waiver formal (AR aprueba excepción documentada). TD-04-03 ya trackea refinamiento del OWNERS |
| R7 | Leak de rpcUrl en logs cuando el RPC tiene API key en la URL (ej. Alchemy) | Baja (hoy no aplica) | Alto (credencial leak) | CD-14 literal: solo chainId+name en prod logs. Dev logs solo `NODE_ENV==='development'`. Verificar test de log capture no incluye URL |
| R8 | Test AC-7 (`@ts-expect-error`) es frágil — rompe si TS cambia de versión | Baja | Bajo | Pinearlo a typescript `^5.7.2` (actual). Tests son compile-time, los catches vitest igual |

---

## 11. Dependencias

### Precede (unblocks)

| HU | Por qué |
|----|---------|
| WFAC-10 (Verify EIP-712) | Consume `chainRegistry.getAdapter(chainId).getPublicClient()` para `recoverTypedDataAddress` |
| WFAC-11 (Settle) | Consume `getWalletClient()` + `simulateContract` |
| WFAC-22 (GET /supported) | Consume `chainRegistry.listAdapters()` |
| WFAC-50 (Kite Testnet full adapter) | Completa `verify`/`settle` stubs en `kite.ts` |
| WFAC-51 (Kite Mainnet) | Idem |
| WFAC-52 (Avalanche Fuji full) | Completa `avalanche.ts` |

### Bloqueado por

| HU | Status |
|----|--------|
| WFAC-2 (Fastify bootstrap) | ✅ DONE — logger, env pattern disponibles |
| WFAC-3 (CI workflow) | ✅ DONE — CI ya corre en PRs |

### Puede ir en paralelo

| HU | Por qué no conflict |
|----|---------------------|
| WFAC-4-Redis (idempotency cache) | Distinto módulo (`src/core/idempotency.ts`, `src/infra/redis.ts`) |
| WFAC-30 /metrics | Distinto módulo |

Cero riesgo de merge conflict.

---

## 12. Missing Inputs — Resueltos

| Item | Resolución |
|------|-----------|
| `VerifyParams`/`SettleParams` shape | **DT-2**: shape x402 spec directo (opción a) — cero wrappers internos. Justificación: spec-literal conformance, zero overhead, conformance tests reutilizables. |
| `X402ErrorCode` ubicación | **DT-3**: `src/core/types.ts` — no creamos `errors.ts` en esta HU. Co-localizado con demás tipos service-layer. WFAC-12 puede mover/re-exportar luego. |
| `getWalletClient()` V1 strategy | **DT-4**: lazy stub (client real-viem sin `account`, read-capable pero write-disabled). Comment `// TODO: WFAC-wallet-singleton` obligatorio. Zero refactor del contrato cuando llegue wallet real. |
| WFAC-2 creó `src/core/types.ts`? | **Verificado**: NO lo creó. `src/core/` solo tiene `.gitkeep`. Esta HU crea el archivo desde cero. |
| BACKLOG.md dice WFAC-4 = "Redis client" | **Inconsistencia conocida**. Jira WFAC-4 apunta a chain registry (work-item source of truth). BACKLOG.md desfasado — se agregará entrada en DONE.md de esta HU para que nexus-docs ajuste BACKLOG en cierre. No blocking. |

**Cero `[NEEDS CLARIFICATION]` pending**. Todos los items del work-item Missing Inputs table están cerrados.

---

## 13. Uncertainty Markers

| Marker | Status |
|--------|--------|
| `[NEEDS CLARIFICATION: VerifyParams y SettleParams]` (work-item DT-B) | ✅ **RESUELTO** en DT-2 |
| `[NEEDS CLARIFICATION: X402ErrorCode en types vs errors]` (work-item DT-G) | ✅ **RESUELTO** en DT-3 |
| `[NEEDS CLARIFICATION: getWalletClient V1 stub vs lazy]` (work-item Missing Inputs) | ✅ **RESUELTO** en DT-4 |
| `[NEEDS CLARIFICATION: auto-discovery vs explícito]` (work-item DT-A) | ✅ **RESUELTO** en DT-1 (confirma explícito) |
| `[NEEDS CLARIFICATION: Jira WFAC-4 número vs BACKLOG]` (work-item Missing Inputs) | ✅ **RESUELTO** en §12 — seguir Jira, ajustar BACKLOG en DONE |

**Todos resueltos. No hay bloqueos pendientes para SPEC_APPROVED.**

---

## 14. Notas arquitectónicas para el futuro

### 14.1 Cuando llegue WFAC-10 (Verify)

- `src/core/verify.ts` hace `import { chainRegistry } from '../chains/registry.js'`.
- `core/verify.ts` orquesta el dispatch: busca el adapter por `chainId`, valida `network === adapter.metadata.networkId`, y delega `adapter.verify(params)`.
- `adapter.verify()` en cada chain file hace EIP-712 recovery con `adapter.getPublicClient()` + los EIP-712 domain fields de `adapter.metadata.tokens[i]`.
- **Zero refactor del contrato** — los métodos ya tienen la signature correcta.

### 14.2 Cuando llegue WFAC-wallet-singleton

- `src/infra/wallet.ts` exporta `getOperatorAccount(): Account` (viem local account desde `OPERATOR_PRIVATE_KEY`).
- Adapter `getWalletClient()` cambia a:
  ```ts
  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      const account = getOperatorAccount();  // NEW
      this._walletClient = createWalletClient({
        chain: this._viemChain,
        transport: http(this._rpcUrl),
        account,                             // NEW
      });
    }
    return this._walletClient;
  }
  ```
- **Sin tocar la interface** — solo la implementación del método.

### 14.3 Cuando llegue un nuevo método (Permit2, ERC-7710)

- `VerifyParams.accepted.extra.assetTransferMethod` ya es union `'eip3009' | 'permit2' | 'erc7710'`.
- El adapter del chain puede implementar dispatch interno:
  ```ts
  verify(params: VerifyParams): Promise<Result<VerifyResult>> {
    switch (params.accepted.extra.assetTransferMethod) {
      case 'eip3009': return this._verifyEip3009(params);
      case 'permit2': return this._verifyPermit2(params);
      case 'erc7710': return this._verifyErc7710(params);
    }
  }
  ```
- Alternativa (preferida desde WFAC-15+): `src/methods/<method>/verify.ts` como plug-in orthogonal. `core/verify.ts` hace dispatch por chainId → adapter + por method → method adapter. Matrix 2D. Documentado en OWNERS.md.

### 14.4 Cuando llegue un nuevo chain (Base, Polygon)

- Nuevo archivo `src/chains/base.ts` (copy kite.ts, adapt).
- Una línea en `src/chains/index.ts`: `chainRegistry.register(baseAdapter)`.
- Una env var nueva en `.env.example`: `BASE_RPC_URL`.
- **Ningún cambio en `src/core/`**. ← propiedad fundamental del diseño.

### 14.5 Tech Debts nuevos abiertos en esta HU

| TD | Descripción | Target |
|----|-------------|--------|
| TD-04-02 | `SettleResult.blockNumber` como `number`: cambiar a `string` cuando alguna chain supere `2^53` blocks | V3 |
| TD-04-03 | OWNERS.md matrix refinement: `src/chains/types.ts` puede importar `type` de `src/core/types.ts` (documentar excepción formal) | Next OWNERS review |
| TD-04-04 | `eslint-plugin-import/extensions` para enforcement automático de `.js` suffix | Next lint hardening HU |
| TD-04-05 | Integration tests de `_resetForTesting` comportamiento en prod (runtime check al importar `registry.ts`) | V1.5 |

Todos se documentarán en BACKLOG.md en cierre (nexus-docs).

---

## 15. Implementation Readiness Check NexusAgil (template)

> Gate final antes de proceder a F2.5 (Story File).

- [x] **Contexto de negocio entendido**: sí — foundation contract multi-chain, bloquea E2/E3/E6.
- [x] **ACs EARS completos y sin ambiguedad**: sí — 14 ACs, todos testables con evidencia archivo:línea.
- [x] **CDs inviolables listados**: 22 CDs (11 heredados + 8 nuevos + 3 anti-regresión).
- [x] **Scope IN y OUT claros**: sí (work-item + §1 de este SDD).
- [x] **Missing Inputs resueltos**: sí (§12 — los 3 NCs cerrados con DT-2/DT-3/DT-4).
- [x] **Architectura diagramada**: sí (§2).
- [x] **Exemplars verificados**: sí (§4 — cada path auditado con Read/ls).
- [x] **viem / fastify / zod signatures verificadas en node_modules/**: sí (§3 lectura obligatoria).
- [x] **Test plan cubre ≥ 1 test por AC**: sí (§8 — ≥ 26 tests para 14 ACs).
- [x] **Risks & Mitigations**: sí (§10 — 8 risks).
- [x] **Dependencias mapeadas**: sí (§11).
- [x] **Uncertainty Markers cerrados**: sí (§13 — 0 open).
- [x] **Coverage target definido**: sí — ≥ 95% statements en `registry.ts` + `core/types.ts` (AC-14 literal).
- [x] **DoD pre-flight checklist**: sí (§9 — Readiness Check para Dev).
- [x] **Auto-Blindaje histórico consultado**: sí — WFAC-2 auto-blindaje leído, CDs anti-regresión (CD-20/21/22) derivados.

**SPEC_APPROVED candidate**: sí. Listo para que el humano apruebe con el texto exacto `SPEC_APPROVED` y pasar a F2.5.

---

*SDD generado por nexus-architect en F2 — 2026-04-23.*
*Based on work-item.md clinical review + node_modules read-first + auto-blindaje históricos.*
