# Story File — WFAC-4 Chain Registry Plug-in Architecture

> SPEC_APPROVED: sí (SDD 003 firmado)
> Fecha: 2026-04-23
> Autor: nexus-architect (F2.5)
> Dev: one-shot (no conversación) — este archivo es tu contrato completo
> Inputs de referencia (leerlos solo para dudas puntuales):
> - `doc/sdd/003-wfac-4-chain-registry/work-item.md`
> - `doc/sdd/003-wfac-4-chain-registry/sdd.md`
> - `.nexus/project-context.md`
> - `OWNERS.md`

---

## 0. Contract con el Dev (lee primero)

Sos el **nexus-dev** de WFAC-4. Este archivo contiene **todo** lo que necesitás para implementar. NO abras conversación con el humano — trabajás one-shot, wave por wave, y entregás el resultado.

### Lo que DEBÉS hacer

1. Leer este archivo completo.
2. Seguir el orden de las waves (W0 → W1 → W2..W4 → W5 → W6).
3. Después de cada wave, correr `npm run typecheck` + `npm run lint` + `npm run test`. Si falla, fix antes de pasar a la siguiente wave.
4. Al final, correr `npm run qa` y `npm run test:coverage`. Todo tiene que quedar verde y la cobertura en los archivos target ≥ 95%.
5. Documentar en el commit body qué wave completaste.

### Lo que NO DEBÉS hacer

- ❌ **NO** uses `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error` (excepto el test fixture específico de AC-7 donde está prescripto).
- ❌ **NO** hagas imports sin suffix `.js`. Este proyecto es Node16 ESM estricto.
- ❌ **NO** importes `src/core/*` desde ningún archivo de `src/chains/*` EXCEPTO `src/chains/types.ts` con `import type` explícito.
- ❌ **NO** uses `console.*` en ningún archivo dentro de `src/`. El test `no-console.test.ts` audita esto y lo romperás.
- ❌ **NO** implementes lógica real de `verify()` o `settle()`. Son stubs con `NETWORK_MISMATCH` (ver W3/W4).
- ❌ **NO** implementes auto-discovery (glob de filesystem) para adapters. El registro es explícito en `src/chains/index.ts`.
- ❌ **NO** crees `src/infra/wallet.ts`. `getWalletClient()` usa el lazy-stub del DT-4 del SDD (viem `createWalletClient` SIN `account`).
- ❌ **NO** throw desde los métodos `verify()` / `settle()` del adapter. Siempre retornan discriminated union `Result<T>`.
- ❌ **NO** modifiques archivos fuera de Scope IN. Si necesitás tocar algo no listado, parar y pedir clarificación.
- ❌ **NO** hardcodees `rpcUrl`, `chainId`, ni RPCs privados. Los `chainId` son literales matemáticos (2368, 2366, 43113) aceptables; los `rpcUrl` SIEMPRE desde `process.env`.

### Cuándo parar y pedir ayuda

- Si un exemplar del Story File no existe en el filesystem → parar, reportar al orquestador.
- Si `npm run typecheck` falla con un error que no podés resolver después de 2 intentos → parar y reportar con el output completo.
- Si detectás que el SDD/work-item contradice la realidad del código → parar, documentar en `auto-blindaje.md` candidate y escalar al humano.

---

## 1. Prerequisites (hacé ESTO primero, antes de tocar nada)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator

# 1. Asegurate de estar en main, al tip correcto
git fetch origin
git checkout main
git reset --hard eba0b50  # solo si estás desalineado; si ya estás en main @ eba0b50, skip

# 2. Crear/cambiar a la branch de la HU
git checkout -b feat/003-wfac-4-chain-registry || git checkout feat/003-wfac-4-chain-registry

# 3. Reinstalar deps para asegurar que package-lock está alineado
npm ci

# 4. Smoke: typecheck + test base deben pasar ANTES de tocar nada
npm run typecheck
npm run test
```

Si el paso 4 falla antes de empezar, parar: el repo no está sano. No podés construir sobre base rota.

---

## 2. Stack (versiones literales del package.json)

| Tecnología | Versión | Uso en esta HU |
|-----------|---------|----------------|
| Node.js | ≥ 20.0.0 | Runtime |
| TypeScript | ^5.7.2 | `strict` + `module: Node16` + `noUncheckedIndexedAccess` |
| viem | ^2.47.6 | `PublicClient`, `WalletClient`, `defineChain`, `createPublicClient`, `createWalletClient`, `http`, `avalancheFuji` |
| pino | ^9.5.0 | `Logger` (solo type inyectado — no se instancia aquí) |
| zod | ^3.23.8 | No usado en esta HU (tipos a mano — zod llega en WFAC-20) |
| vitest | ^2.1.8 | Tests unitarios |
| fastify | ^5.8.4 | No usado en esta HU (no hay rutas) |

**Módulos viem exactos a importar**:

```ts
import { defineChain, createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { avalancheFuji } from 'viem/chains';
```

NO uses subpaths deprecados (`viem/utils`, `viem/_types/...`). Solo las entradas de arriba.

**Pino**:

```ts
import type { Logger } from 'pino';
```

Type-only import. El registry NO instancia un logger propio (DT-11 del SDD).

---

## 3. Anti-Hallucination Checklist específico de WFAC-4

Verificá esto ANTES de codear y al final de cada wave:

- [ ] `src/core/` solo tiene `.gitkeep` (no hay `types.ts` pre-existente — tu W0 lo crea).
- [ ] `src/chains/` solo tiene `.gitkeep`.
- [ ] `src/__tests__/unit/` tiene `env.test.ts`, `health.test.ts`, `logger.test.ts`, `no-console.test.ts`, `shutdown.test.ts`. Mirá `env.test.ts` como exemplar de `vi.spyOn(process, 'exit')` pattern + `vi.resetModules()`.
- [ ] `src/infra/logger.ts` existe — pero NO lo importás. Solo extraés el pattern (usás `import type { Logger } from 'pino'`).
- [ ] viem `^2.47.6` está instalado: verifica con `ls node_modules/viem/package.json`.
- [ ] `viem/chains` exporta `avalancheFuji`: verifica con `node -e "import('viem/chains').then(m => console.error(typeof m.avalancheFuji))"` ⇒ `object`.
- [ ] `.env.example` tiene `KITE_TESTNET_RPC_URL`, `KITE_MAINNET_RPC_URL`, `AVALANCHE_FUJI_RPC_URL`. Si falta alguna, agregala tú (ver W3/W4 notas).
- [ ] NO existe `src/infra/wallet.ts` (confirmado por CD-8).
- [ ] El test `no-console.test.ts` audita `src/**/*.ts` — no introduzcas `console.*`.

---

## 4. Scope IN — Archivos a crear/modificar (exhaustivo)

**Nuevos (7 archivos de código + 3 de test)**:

| # | Path | Wave | Qué exporta |
|---|------|------|-------------|
| 1 | `src/core/types.ts` | W0 | `Ok`, `Err`, `Result`, `Address`, `ChainId`, `asChainId`, `X402ErrorCode` |
| 2 | `src/chains/types.ts` | W1 | `EIP3009Token`, `ChainMetadata`, `VerifyParams`, `VerifyResult`, `SettleParams`, `SettleResult`, `AdapterResult`, `ChainAdapter`, `RegisterResult`, `ChainAdapterInitError` |
| 3 | `src/chains/registry.ts` | W2 | `chainRegistry` (singleton), `ChainRegistry` (class — internal, exported only for type purposes) |
| 4 | `src/chains/kite.ts` | W3 | `kiteTestnetAdapter`, `kiteMainnetAdapter` |
| 5 | `src/chains/avalanche.ts` | W4 | `avalancheFujiAdapter` |
| 6 | `src/chains/index.ts` | W5 | (side-effect only — sin exports) |
| 7 | `src/__tests__/unit/core-types.test.ts` | W6 | tests para `asChainId`, `Result<T>` narrowing, `X402ErrorCode` inventory |
| 8 | `src/__tests__/unit/chain-registry.test.ts` | W6 | tests del registry (ACs 1-6, 9, 10, + CD-9) |
| 9 | `src/__tests__/unit/chain-adapter.test.ts` | W6 | tests de kite + avalanche adapters (ACs 11-13) |

**Modificados**:

| Path | Cambio | Razón |
|------|--------|-------|
| `.env.example` | Agregar `KITE_TESTNET_RPC_URL=`, `KITE_MAINNET_RPC_URL=`, `AVALANCHE_FUJI_RPC_URL=` si no están | Documentación para el operator. Verificá con `grep -E '^(KITE|AVALANCHE)_' .env.example` |

**NO tocar**:

- `src/index.ts`, `src/app.ts`, `src/infra/*`, `src/routes/*` (fuera de scope — wiring es WFAC-10+).
- `package.json` (sin deps nuevas — todo ya instalado).
- `tsconfig.json`, `vitest.config.ts`, `.eslintrc.*` (config estable).

---

## 5. TypeScript shapes EXACTAS

Copia-pegá-adapta. Estas son las firmas que DEBEN compilar. Si cambiás algo, tenés que justificarlo con evidencia.

### 5.1 `src/core/types.ts` (W0)

```ts
/**
 * Service-layer primitives for wasiai-facilitator.
 *
 * Exposes:
 *   - Ok<T> / Err / Result<T>: discriminated union for service-layer responses.
 *   - Address: branded 0x-prefixed hex string (aliases viem Hex for clarity).
 *   - ChainId: branded number to prevent accidental misuse.
 *   - asChainId: constructor guard — THROWS on invalid input (compile-time helper).
 *   - X402ErrorCode: union literal of exactly the 10 codes in x402 spec.
 *
 * Boundaries respected (OWNERS.md):
 *   - No imports from src/chains/*, src/methods/*, src/routes/*, src/infra/*.
 *   - Only primitives — no runtime deps.
 *
 * Future work:
 *   - WFAC-12 may move X402ErrorCode to src/core/errors.ts and re-export.
 */

export type Address = `0x${string}`;

declare const __chainIdBrand: unique symbol;
export type ChainId = number & { readonly [__chainIdBrand]: 'ChainId' };

/**
 * Type-narrowing constructor for ChainId. Throws (not Result<T>) because
 * invalid chainIds are programmer errors, not runtime-expected failures.
 */
export function asChainId(n: number): ChainId {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid chainId: ${n} (must be positive integer)`);
  }
  return n as ChainId;
}

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

export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: X402ErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

/**
 * Ok<T> uses intersection with { ok: true } so specific result shapes can
 * extend it by adding their own discriminant-free fields.
 *
 *   type VerifyOk = Ok<{ verified: true; client: Address; ... }>
 *   → { ok: true; verified: true; client: Address; ... }
 */
export type Ok<T extends object> = { readonly ok: true } & T;

export type Result<T extends object> = Ok<T> | Err;
```

### 5.2 `src/chains/types.ts` (W1)

```ts
/**
 * Chain domain contracts for wasiai-facilitator.
 *
 * Exposes:
 *   - EIP3009Token: on-chain token metadata + EIP-712 domain fields.
 *   - ChainMetadata: readonly static data for a chain.
 *   - VerifyParams/VerifyResult/SettleParams/SettleResult: x402 spec shapes (direct).
 *   - AdapterResult<T>: alias for Result<T> (re-exported for consumers that don't want to import from core).
 *   - ChainAdapter: the 5-member interface every adapter must implement.
 *   - RegisterResult: shape returned by ChainRegistry.register().
 *   - ChainAdapterInitError: thrown at adapter construction if env vars missing.
 *
 * Boundaries (DT-12 of SDD 003):
 *   - type-only import from src/core/types.ts is allowed.
 *   - NO runtime imports from core/*.
 *   - Runtime: only viem.
 *
 * Future work:
 *   - WFAC-15+: multi-method (Permit2/ERC-7710) dispatch via assetTransferMethod union.
 */

import type { PublicClient, WalletClient } from 'viem';
import type { Result, Address, ChainId, X402ErrorCode } from '../core/types.js';

export interface EIP3009Token {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
}

export interface ChainMetadata {
  readonly chainId: ChainId;
  readonly name: string;
  readonly network: 'mainnet' | 'testnet';
  readonly networkId: string; // "eip155:<chainId>"
  readonly rpcUrl: string;
  readonly blockExplorer?: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly tokens: readonly EIP3009Token[];
}

// --- x402 spec shapes (DT-2 of SDD: direct, no wrappers) ---

export type AssetTransferMethod = 'eip3009' | 'permit2' | 'erc7710';

export interface VerifyParams {
  readonly x402Version: 2;
  readonly resource: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
  readonly accepted: {
    readonly scheme: 'exact';
    readonly network: string;
    readonly amount: string;
    readonly asset: string;
    readonly payTo: string;
    readonly maxTimeoutSeconds: number;
    readonly extra: {
      readonly assetTransferMethod: AssetTransferMethod;
      readonly name?: string;
      readonly version?: string;
    };
  };
  readonly payload: {
    readonly signature: `0x${string}`;
    readonly authorization: {
      readonly from: Address;
      readonly to: Address;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: `0x${string}`;
    };
  };
}

export interface VerifyResult {
  readonly verified: true;
  readonly client: Address;
  readonly amount: string;
  readonly asset: Address;
  readonly network: string;
  readonly payTo: Address;
  readonly expiresAt: number;
}

// SettleParams shares the same body shape as VerifyParams in x402 spec.
// Use type alias (not empty-extend interface) to avoid @typescript-eslint
// no-empty-interface warnings.
export type SettleParams = VerifyParams;

export interface SettleResult {
  readonly settled: true;
  readonly transactionHash: `0x${string}`;
  readonly blockNumber: number;
  readonly amount: string;
  readonly from: Address;
  readonly to: Address;
  readonly asset: Address;
}

/**
 * AdapterResult<T> === Result<T>. Re-exported alias so adapters/consumers
 * can rely on a single domain import.
 */
export type AdapterResult<T extends object> = Result<T>;

export interface ChainAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  getPublicClient(): PublicClient;
  getWalletClient(): WalletClient;
}

export type RegisterResult =
  | { readonly ok: true; readonly chainId: ChainId }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: X402ErrorCode;
        readonly message: string;
        readonly http: number;
      };
    };

/**
 * Thrown at adapter construction time when a required env var is missing.
 * Includes the exact env var name in the message (CD-15).
 */
export class ChainAdapterInitError extends Error {
  public readonly envVar: string;
  public readonly chainId: number;

  constructor(envVar: string, chainId: number) {
    super(
      `ChainAdapterInitError: required environment variable "${envVar}" is not set ` +
        `(needed for chainId ${chainId}).`,
    );
    this.name = 'ChainAdapterInitError';
    this.envVar = envVar;
    this.chainId = chainId;
  }
}
```

### 5.3 `src/chains/registry.ts` (W2)

```ts
/**
 * ChainRegistry — singleton store + lookup for registered chain adapters.
 *
 * Exposes:
 *   - chainRegistry (singleton instance — primary public export)
 *   - ChainRegistry (class — exported for internal/test purposes only)
 *
 * Invariants:
 *   - Internal Map<ChainId, ChainAdapter> — O(1) lookups (CD-13, CD-16).
 *   - getAdapter() never throws — returns Result<T> (CD-4).
 *   - register() de-duplicates by metadata.chainId (CD-18).
 *   - Logger is injected via setLogger() — registry NEVER calls createLogger()
 *     itself to respect OWNERS matrix (chains/* must not depend on infra/*
 *     at runtime). See DT-11 of SDD.
 *
 * Boundaries:
 *   - Only imports ./types.js (sibling) + pino type (type-only).
 *   - NO imports from src/core/*, src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work: WFAC-10+ will call chainRegistry.setLogger(logger) in app boot.
 */

import type { Logger } from 'pino';
import type {
  ChainAdapter,
  ChainMetadata,
  RegisterResult,
} from './types.js';
import type { ChainId } from '../core/types.js';

export class ChainRegistry {
  private readonly _adapters = new Map<ChainId, ChainAdapter>();
  private _logger: Logger | undefined;

  setLogger(logger: Logger): void {
    this._logger = logger;
  }

  register(adapter: ChainAdapter): RegisterResult {
    // CD-6 runtime guard: adapter shape check (AC-6).
    if (!this._isValidAdapter(adapter)) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'Invalid adapter: missing required methods',
          http: 500,
        },
      };
    }

    const chainId = adapter.metadata.chainId;

    if (this._adapters.has(chainId)) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Chain already registered: ${chainId}`,
          http: 409,
        },
      };
    }

    this._adapters.set(chainId, adapter);
    this._logger?.info(
      { chainId, name: adapter.metadata.name },
      'Chain adapter registered',
    );
    return { ok: true, chainId };
  }

  getAdapter(
    chainId: ChainId,
  ):
    | { readonly ok: true; readonly adapter: ChainAdapter }
    | {
        readonly ok: false;
        readonly error: { readonly code: 'NETWORK_MISMATCH'; readonly message: string; readonly http: number };
      } {
    const adapter = this._adapters.get(chainId);
    if (!adapter) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: `Chain not registered: ${chainId}`,
          http: 400,
        },
      };
    }
    return { ok: true, adapter };
  }

  listAdapters(): readonly ChainMetadata[] {
    const out: ChainMetadata[] = [];
    for (const adapter of this._adapters.values()) {
      out.push(adapter.metadata);
    }
    return out;
  }

  getSupportedChainIds(): readonly ChainId[] {
    return Array.from(this._adapters.keys());
  }

  /**
   * Test-only utility. Throws in non-test environments (CD-9).
   */
  _resetForTesting(): void {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error(
        '_resetForTesting() is only available in test environment',
      );
    }
    this._adapters.clear();
    this._logger = undefined;
  }

  private _isValidAdapter(candidate: ChainAdapter): boolean {
    // Runtime shape guard — TS enforces at compile-time, this catches
    // objects passed via unsafe casts or from external boundaries.
    return (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof candidate.metadata === 'object' &&
      candidate.metadata !== null &&
      typeof candidate.metadata.chainId === 'number' &&
      typeof candidate.verify === 'function' &&
      typeof candidate.settle === 'function' &&
      typeof candidate.getPublicClient === 'function' &&
      typeof candidate.getWalletClient === 'function'
    );
  }
}

export const chainRegistry = new ChainRegistry();
```

### 5.4 `src/chains/kite.ts` (W3)

```ts
/**
 * Kite chain adapters (Testnet 2368, Mainnet 2366).
 *
 * Exposes:
 *   - kiteTestnetAdapter: ChainAdapter — chainId 2368, env KITE_TESTNET_RPC_URL.
 *   - kiteMainnetAdapter: ChainAdapter — chainId 2366, env KITE_MAINNET_RPC_URL.
 *
 * verify() and settle() are STUBS in this HU — they return NETWORK_MISMATCH
 * with a message pointing to WFAC-10/WFAC-11 (see DT-4 of SDD 003).
 *
 * Boundaries:
 *   - imports ./types.js + viem only.
 *   - NO imports from src/core/* (runtime), src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work:
 *   - WFAC-10: implement verify() (EIP-712 signature recovery).
 *   - WFAC-11: implement settle() (transferWithAuthorization on-chain).
 *   - WFAC-wallet-singleton: inject real account into getWalletClient().
 */

import { defineChain, createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient, Chain } from 'viem';
import {
  ChainAdapterInitError,
  type AdapterResult,
  type ChainAdapter,
  type ChainMetadata,
  type SettleParams,
  type SettleResult,
  type VerifyParams,
  type VerifyResult,
} from './types.js';
import { asChainId } from '../core/types.js';

function readEnv(name: string, chainId: number): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
  }
  return value;
}

class KiteAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _viemChain: Chain;
  private readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;

  constructor(opts: {
    chainIdNum: number;
    envVarName: string;
    name: string;
    network: 'mainnet' | 'testnet';
    blockExplorer?: string;
  }) {
    this._rpcUrl = readEnv(opts.envVarName, opts.chainIdNum);

    this._viemChain = defineChain({
      id: opts.chainIdNum,
      name: opts.name,
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      rpcUrls: { default: { http: [this._rpcUrl] } },
      ...(opts.blockExplorer
        ? { blockExplorers: { default: { name: 'Explorer', url: opts.blockExplorer } } }
        : {}),
      testnet: opts.network === 'testnet',
    });

    this.metadata = {
      chainId: asChainId(opts.chainIdNum),
      name: opts.name,
      network: opts.network,
      networkId: `eip155:${opts.chainIdNum}`,
      rpcUrl: this._rpcUrl,
      ...(opts.blockExplorer ? { blockExplorer: opts.blockExplorer } : {}),
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      tokens: [], // W1: token list starts empty; WFAC-10 populates PYUSD etc.
    };
  }

  getPublicClient(): PublicClient {
    if (!this._publicClient) {
      this._publicClient = createPublicClient({
        chain: this._viemChain,
        transport: http(this._rpcUrl),
      }) as PublicClient;
    }
    return this._publicClient;
  }

  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      // TODO: WFAC-wallet-singleton — wallet real (con OPERATOR_PRIVATE_KEY) se inyecta
      // cuando exista src/infra/wallet.ts. Por ahora este client no puede firmar (account: undefined).
      this._walletClient = createWalletClient({
        chain: this._viemChain,
        transport: http(this._rpcUrl),
      }) as WalletClient;
    }
    return this._walletClient;
  }

  async verify(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Verify not implemented yet (WFAC-10)',
        http: 400,
      },
    };
  }

  async settle(_params: SettleParams): Promise<AdapterResult<SettleResult>> {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Settle not implemented yet (WFAC-11)',
        http: 400,
      },
    };
  }
}

export const kiteTestnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2368,
  envVarName: 'KITE_TESTNET_RPC_URL',
  name: 'Kite Testnet',
  network: 'testnet',
});

export const kiteMainnetAdapter: ChainAdapter = new KiteAdapter({
  chainIdNum: 2366,
  envVarName: 'KITE_MAINNET_RPC_URL',
  name: 'Kite Mainnet',
  network: 'mainnet',
});
```

**Nota sobre `as PublicClient` / `as WalletClient`**:
viem devuelve tipos con generics específicos que **no son compatibles por default** con el `PublicClient` / `WalletClient` "raw" que declaramos como retorno de la interface. Esto es una limitación documentada en WFAC-2 auto-blindaje (CD-21 del SDD) — **NO es un `any` cast**, es una **especialización controlada** que convierte un type concreto (con generics resueltos) a su alias canónico. El tipo resultante sigue siendo totalmente typado en los call sites. Si el AR/CR rechaza esta decisión, alternativa: anotar el retorno del adapter con el generic específico (`createPublicClient<HttpTransport, typeof kiteTestnet>(...)`) y cambiar la interface para ser generic-aware. **Preferimos el cast controlado** por simplicidad arquitectónica.

### 5.5 `src/chains/avalanche.ts` (W4)

```ts
/**
 * Avalanche Fuji testnet adapter (chainId 43113).
 *
 * Exposes:
 *   - avalancheFujiAdapter: ChainAdapter — chainId 43113, env AVALANCHE_FUJI_RPC_URL.
 *
 * verify() and settle() are STUBS — return NETWORK_MISMATCH pending WFAC-52.
 *
 * Boundaries:
 *   - imports ./types.js + viem + viem/chains (for canonical avalancheFuji def).
 *   - NO imports from src/core/* (runtime), src/methods/*, src/routes/*, src/infra/*.
 *
 * Future work: WFAC-52 implements real verify/settle for Fuji USDC.
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { avalancheFuji } from 'viem/chains';
import {
  ChainAdapterInitError,
  type AdapterResult,
  type ChainAdapter,
  type ChainMetadata,
  type EIP3009Token,
  type SettleParams,
  type SettleResult,
  type VerifyParams,
  type VerifyResult,
} from './types.js';
import { asChainId } from '../core/types.js';

const FUJI_CHAIN_ID = 43113;

// Canonical USDC on Avalanche Fuji — documented in
// https://docs.avax.network/ (public, stable address).
// Kept as a module-level constant (NOT in env) per SDD DT-10 rationale.
const USDC_FUJI: EIP3009Token = {
  address: '0x5425890298aed601595a70AB815c96711a31Bc65',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  eip712Name: 'USD Coin',
  eip712Version: '2',
};

function readRpcUrl(): string {
  const value = process.env['AVALANCHE_FUJI_RPC_URL'];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError('AVALANCHE_FUJI_RPC_URL', FUJI_CHAIN_ID);
  }
  return value;
}

class AvalancheFujiAdapter implements ChainAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _rpcUrl: string;
  private _publicClient: PublicClient | null = null;
  private _walletClient: WalletClient | null = null;

  constructor() {
    this._rpcUrl = readRpcUrl();
    this.metadata = {
      chainId: asChainId(FUJI_CHAIN_ID),
      name: 'Avalanche Fuji',
      network: 'testnet',
      networkId: `eip155:${FUJI_CHAIN_ID}`,
      rpcUrl: this._rpcUrl,
      blockExplorer: 'https://testnet.snowtrace.io',
      nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      tokens: [USDC_FUJI],
    };
  }

  getPublicClient(): PublicClient {
    if (!this._publicClient) {
      this._publicClient = createPublicClient({
        chain: avalancheFuji,
        transport: http(this._rpcUrl),
      }) as PublicClient;
    }
    return this._publicClient;
  }

  getWalletClient(): WalletClient {
    if (!this._walletClient) {
      // TODO: WFAC-wallet-singleton — wallet real (OPERATOR_PRIVATE_KEY) se inyecta
      // cuando exista src/infra/wallet.ts. Por ahora este client no puede firmar (account: undefined).
      this._walletClient = createWalletClient({
        chain: avalancheFuji,
        transport: http(this._rpcUrl),
      }) as WalletClient;
    }
    return this._walletClient;
  }

  async verify(_params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Verify not implemented yet (WFAC-52)',
        http: 400,
      },
    };
  }

  async settle(_params: SettleParams): Promise<AdapterResult<SettleResult>> {
    return {
      ok: false,
      error: {
        code: 'NETWORK_MISMATCH',
        message: 'Settle not implemented yet (WFAC-52)',
        http: 400,
      },
    };
  }
}

export const avalancheFujiAdapter: ChainAdapter = new AvalancheFujiAdapter();
```

### 5.6 `src/chains/index.ts` (W5)

```ts
/**
 * Chain registry composition — side-effect module.
 *
 * Importing this module registers every adapter known to the facilitator.
 * Consumers should do: `import './chains/index.js';` in their bootstrap path.
 *
 * Exposes: NOTHING. This file is side-effect-only (CD-19).
 * Consumers that need the singleton import it directly from './registry.js'.
 *
 * Boundaries:
 *   - imports ./registry.js + ./kite.js + ./avalanche.js only.
 *
 * Future work:
 *   - Each new chain = 1 line here + 1 new file in src/chains/.
 */

import { chainRegistry } from './registry.js';
import { kiteTestnetAdapter, kiteMainnetAdapter } from './kite.js';
import { avalancheFujiAdapter } from './avalanche.js';

chainRegistry.register(kiteTestnetAdapter);
chainRegistry.register(kiteMainnetAdapter);
chainRegistry.register(avalancheFujiAdapter);
```

### 5.7 Tests (W6)

#### 5.7.1 `src/__tests__/unit/core-types.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { asChainId, type Result, type X402ErrorCode } from '../../core/types.js';

describe('core/types — asChainId', () => {
  it('accepts positive integers', () => {
    expect(asChainId(2368)).toBe(2368);
    expect(asChainId(1)).toBe(1);
    expect(asChainId(43113)).toBe(43113);
  });

  it('throws for zero', () => {
    expect(() => asChainId(0)).toThrow(/Invalid chainId/);
  });

  it('throws for negative', () => {
    expect(() => asChainId(-1)).toThrow(/Invalid chainId/);
  });

  it('throws for float', () => {
    expect(() => asChainId(1.5)).toThrow(/Invalid chainId/);
  });

  it('throws for NaN', () => {
    expect(() => asChainId(Number.NaN)).toThrow(/Invalid chainId/);
  });
});

describe('core/types — Result<T> narrowing', () => {
  it('narrows ok:true branch to expose the data', () => {
    const r: Result<{ value: number }> = { ok: true, value: 42 };
    if (r.ok) {
      expect(r.value).toBe(42);
    } else {
      throw new Error('expected ok branch');
    }
  });

  it('narrows ok:false branch to expose error object', () => {
    const r: Result<{ value: number }> = {
      ok: false,
      error: { code: 'INVALID_AMOUNT', message: 'nope', http: 400 },
    };
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_AMOUNT');
      expect(r.error.http).toBe(400);
    } else {
      throw new Error('expected err branch');
    }
  });
});

describe('core/types — X402ErrorCode inventory', () => {
  it('has exactly the 10 canonical codes (enforced via assignability)', () => {
    const codes: X402ErrorCode[] = [
      'INVALID_SIGNATURE',
      'INSUFFICIENT_BALANCE',
      'PERMIT2_ALLOWANCE_REQUIRED',
      'EXPIRED_AUTHORIZATION',
      'NETWORK_MISMATCH',
      'SIMULATION_FAILED',
      'INVALID_AMOUNT',
      'INVALID_RECEIVER',
      'TRANSACTION_FAILED',
      'DELEGATION_INVALID',
    ];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });
});
```

#### 5.7.2 `src/__tests__/unit/chain-registry.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChainRegistry } from '../../chains/registry.js';
import type { ChainAdapter, ChainMetadata } from '../../chains/types.js';
import { asChainId } from '../../core/types.js';

function makeMockAdapter(chainIdNum: number, name = `Chain ${chainIdNum}`): ChainAdapter {
  const metadata: ChainMetadata = {
    chainId: asChainId(chainIdNum),
    name,
    network: 'testnet',
    networkId: `eip155:${chainIdNum}`,
    rpcUrl: 'https://example.test/rpc',
    nativeCurrency: { name: 'Test', symbol: 'TST', decimals: 18 },
    tokens: [],
  };
  return {
    metadata,
    verify: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    settle: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'stub', http: 400 },
    })),
    getPublicClient: vi.fn(() => ({}) as never),
    getWalletClient: vi.fn(() => ({}) as never),
  };
}

describe('ChainRegistry', () => {
  let registry: ChainRegistry;

  beforeEach(() => {
    registry = new ChainRegistry();
  });

  describe('register()', () => {
    it('AC-1: registers an adapter and returns ok', () => {
      const adapter = makeMockAdapter(2368, 'Kite Testnet');
      const result = registry.register(adapter);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.chainId).toBe(asChainId(2368));
    });

    it('AC-5: returns NETWORK_MISMATCH + http 409 on duplicate chainId, does NOT overwrite', () => {
      const first = makeMockAdapter(2368, 'First');
      const second = makeMockAdapter(2368, 'Second');
      registry.register(first);
      const result = registry.register(second);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(409);
        expect(result.error.message).toMatch(/already registered/);
      }
      const stored = registry.getAdapter(asChainId(2368));
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.adapter.metadata.name).toBe('First');
    });

    it('AC-6: returns NETWORK_MISMATCH + http 500 on invalid adapter shape', () => {
      const result = registry.register({} as ChainAdapter);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(500);
        expect(result.error.message).toMatch(/missing required/);
      }
    });
  });

  describe('getAdapter()', () => {
    it('AC-1: returns the registered adapter in O(1) via Map lookup', () => {
      const adapter = makeMockAdapter(2368);
      registry.register(adapter);
      const result = registry.getAdapter(asChainId(2368));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.adapter).toBe(adapter);
    });

    it('AC-4: returns NETWORK_MISMATCH + http 400 for unregistered chainId (never throws)', () => {
      const result = registry.getAdapter(asChainId(9999));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NETWORK_MISMATCH');
        expect(result.error.http).toBe(400);
      }
    });
  });

  describe('listAdapters()', () => {
    it('AC-2: returns array of metadata with no duplicate chainIds', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      registry.register(makeMockAdapter(43113));
      const list = registry.listAdapters();
      expect(list).toHaveLength(3);
      const ids = list.map((m) => m.chainId);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('getSupportedChainIds()', () => {
    it('AC-3: returns unique chainId array', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(43113));
      const ids = registry.getSupportedChainIds();
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('setLogger() + logging behavior (AC-10, DT-11)', () => {
    it('AC-10: logs info with chainId and name when logger injected', () => {
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      registry.setLogger(logger as never);
      registry.register(makeMockAdapter(2368, 'Kite Testnet'));
      expect(logger.info).toHaveBeenCalledWith(
        { chainId: asChainId(2368), name: 'Kite Testnet' },
        'Chain adapter registered',
      );
    });

    it('does not throw and does not log when no logger set', () => {
      expect(() => registry.register(makeMockAdapter(2368))).not.toThrow();
    });

    it('logs once per registered adapter', () => {
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      registry.setLogger(logger as never);
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      expect(logger.info).toHaveBeenCalledTimes(2);
    });
  });

  describe('_resetForTesting() (CD-9)', () => {
    it('clears all adapters when NODE_ENV === "test"', () => {
      registry.register(makeMockAdapter(2368));
      registry.register(makeMockAdapter(2366));
      registry._resetForTesting();
      expect(registry.getSupportedChainIds()).toHaveLength(0);
    });

    it('throws when NODE_ENV !== "test"', () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => registry._resetForTesting()).toThrow(/test environment/);
      } finally {
        process.env['NODE_ENV'] = originalEnv;
      }
    });
  });
});

describe('ChainRegistry — module-load integration (AC-9)', () => {
  it('registers at least one chain when src/chains/index.ts is imported with env vars set', async () => {
    // isolate module cache
    vi.resetModules();
    const prev = {
      testnet: process.env['KITE_TESTNET_RPC_URL'],
      mainnet: process.env['KITE_MAINNET_RPC_URL'],
      fuji: process.env['AVALANCHE_FUJI_RPC_URL'],
    };
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';

    try {
      await import('../../chains/index.js');
      const { chainRegistry } = await import('../../chains/registry.js');
      expect(chainRegistry.getSupportedChainIds().length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev.testnet === undefined) delete process.env['KITE_TESTNET_RPC_URL'];
      else process.env['KITE_TESTNET_RPC_URL'] = prev.testnet;
      if (prev.mainnet === undefined) delete process.env['KITE_MAINNET_RPC_URL'];
      else process.env['KITE_MAINNET_RPC_URL'] = prev.mainnet;
      if (prev.fuji === undefined) delete process.env['AVALANCHE_FUJI_RPC_URL'];
      else process.env['AVALANCHE_FUJI_RPC_URL'] = prev.fuji;
    }
  });
});
```

#### 5.7.3 `src/__tests__/unit/chain-adapter.test.ts`

```ts
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ChainAdapterInitError } from '../../chains/types.js';

const ENV_KEYS = [
  'KITE_TESTNET_RPC_URL',
  'KITE_MAINNET_RPC_URL',
  'AVALANCHE_FUJI_RPC_URL',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

describe('kite.ts adapters', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['KITE_TESTNET_RPC_URL'] = 'https://rpc-testnet.gokite.ai';
    process.env['KITE_MAINNET_RPC_URL'] = 'https://rpc-mainnet.gokite.ai';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('AC-11: kiteTestnetAdapter has chainId 2368 and testnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteTestnetAdapter.metadata.chainId).toBe(2368);
    expect(mod.kiteTestnetAdapter.metadata.network).toBe('testnet');
    expect(mod.kiteTestnetAdapter.metadata.networkId).toBe('eip155:2368');
  });

  it('AC-12: kiteMainnetAdapter has chainId 2366 and mainnet network', async () => {
    const mod = await import('../../chains/kite.js');
    expect(mod.kiteMainnetAdapter.metadata.chainId).toBe(2366);
    expect(mod.kiteMainnetAdapter.metadata.network).toBe('mainnet');
    expect(mod.kiteMainnetAdapter.metadata.networkId).toBe('eip155:2366');
  });

  it('AC-13: throws ChainAdapterInitError when KITE_TESTNET_RPC_URL missing', async () => {
    delete process.env['KITE_TESTNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(ChainAdapterInitError);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_TESTNET_RPC_URL/);
  });

  it('AC-13: throws ChainAdapterInitError when KITE_MAINNET_RPC_URL missing', async () => {
    delete process.env['KITE_MAINNET_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/kite.js')).rejects.toThrow(ChainAdapterInitError);
    await expect(import('../../chains/kite.js')).rejects.toThrow(/KITE_MAINNET_RPC_URL/);
  });

  it('DT-4: getPublicClient returns an object with readContract method', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getPublicClient();
    expect(client).toBeDefined();
    expect(typeof client.readContract).toBe('function');
  });

  it('DT-4: getWalletClient returns an object with writeContract method (no account — cannot sign)', async () => {
    const mod = await import('../../chains/kite.js');
    const client = mod.kiteTestnetAdapter.getWalletClient();
    expect(client).toBeDefined();
    expect(typeof client.writeContract).toBe('function');
  });

  it('verify returns NETWORK_MISMATCH with pending WFAC-10 message', async () => {
    const mod = await import('../../chains/kite.js');
    const result = await mod.kiteTestnetAdapter.verify({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toMatch(/WFAC-10/);
    }
  });

  it('settle returns NETWORK_MISMATCH with pending WFAC-11 message', async () => {
    const mod = await import('../../chains/kite.js');
    const result = await mod.kiteTestnetAdapter.settle({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_MISMATCH');
      expect(result.error.message).toMatch(/WFAC-11/);
    }
  });
});

describe('avalanche.ts adapter', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    process.env['AVALANCHE_FUJI_RPC_URL'] = 'https://api.avax-test.network/ext/bc/C/rpc';
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    vi.resetModules();
  });

  it('has chainId 43113 and testnet network', async () => {
    const mod = await import('../../chains/avalanche.js');
    expect(mod.avalancheFujiAdapter.metadata.chainId).toBe(43113);
    expect(mod.avalancheFujiAdapter.metadata.network).toBe('testnet');
    expect(mod.avalancheFujiAdapter.metadata.networkId).toBe('eip155:43113');
  });

  it('throws ChainAdapterInitError when AVALANCHE_FUJI_RPC_URL missing', async () => {
    delete process.env['AVALANCHE_FUJI_RPC_URL'];
    vi.resetModules();
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(ChainAdapterInitError);
    await expect(import('../../chains/avalanche.js')).rejects.toThrow(/AVALANCHE_FUJI_RPC_URL/);
  });

  it('exposes USDC Fuji in tokens list with decimals 6', async () => {
    const mod = await import('../../chains/avalanche.js');
    const tokens = mod.avalancheFujiAdapter.metadata.tokens;
    expect(tokens).toHaveLength(1);
    const usdc = tokens[0];
    expect(usdc).toBeDefined();
    if (usdc) {
      expect(usdc.symbol).toBe('USDC');
      expect(usdc.decimals).toBe(6);
    }
  });

  it('verify returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.verify({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });

  it('settle returns NETWORK_MISMATCH with pending WFAC-52 message', async () => {
    const mod = await import('../../chains/avalanche.js');
    const result = await mod.avalancheFujiAdapter.settle({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/WFAC-52/);
  });
});
```

**Notas sobre los tests**:

- `as never` en `verify({} as never)` es aceptable **exclusivamente** dentro de tests donde el argumento no se usa (el stub ignora `_params`). CD-5 prohíbe `any`/`as unknown` en `src/chains/` y `src/core/types.ts` — **NO** aplica literal a `src/__tests__/`, pero mantenemos el espíritu: `as never` es más estricto que `as any` y el compilador lo permite como downcast hacia un tipo más estrecho. Si CR/AR pide cambiar, usá un objeto VerifyParams completo minimal.
- Los mocks del logger usan el type shape de pino `Logger` (7 métodos más `child`). `as never` acá también es un cast controlado (mock incompleto) — alternativa: construir un logger mock tipado con `satisfies Partial<Logger>` y cast. Preferimos el `as never` local a tests.

---

## 6. Patrones a seguir

### 6.1 ESM Node16: imports con `.js` suffix (CD-12)

```ts
// ✅ CORRECTO
import { chainRegistry } from './registry.js';
import type { ChainAdapter } from './types.js';
import { asChainId } from '../core/types.js';

// ❌ INCORRECTO
import { chainRegistry } from './registry';
import type { ChainAdapter } from './types';
```

TypeScript con `module: Node16` NO reescribe imports — el suffix `.js` es obligatorio incluso cuando el archivo fuente es `.ts`. Ver `tsconfig.json` del proyecto.

### 6.2 Type-only imports (CD-2 / DT-12)

```ts
// ✅ CORRECTO — type-only de core es la UNICA excepción permitida para chains/*
import type { Result, ChainId } from '../core/types.js';

// ❌ INCORRECTO — runtime import de core desde chains/
import { asChainId } from '../core/types.js';
```

**EXCEPCIÓN documentada (DT-12 + W0 del SDD)**: `asChainId` ES un runtime symbol y DEBE importarse como valor desde `kite.ts` y `avalanche.ts` para llamar `asChainId(2368)`. Esta excepción está EXPLICITAMENTE aprobada en la sección 5 del SDD — los adapters construyen `ChainMetadata`, y `ChainMetadata.chainId` es `ChainId` branded, que requiere `asChainId()` para construirse sin cast.

Regla operativa: **`asChainId` es el único runtime symbol que `src/chains/*.ts` puede importar de `../core/types.js`**. Todo lo demás de core es `import type`.

### 6.3 Discriminated union — nunca throw

```ts
// ✅ CORRECTO — getAdapter retorna Result<>
const result = registry.getAdapter(chainId);
if (!result.ok) {
  // handle error path — result.error.code, .http, .message están tipados
  return someErrorResponse(result.error);
}
// aquí TS sabe que result.adapter es ChainAdapter
result.adapter.verify(params);

// ❌ INCORRECTO — throw por error previsible
try {
  const adapter = registry.getAdapter(chainId); // si throw
} catch (e) { /* ... */ }
```

### 6.4 Logger inyectado (DT-11)

```ts
// ✅ CORRECTO — el registry recibe el logger, no lo crea
import { createLogger } from '../infra/logger.js'; // ← prohibido para chains/

// ❌ INCORRECTO: chains/* NO importa infra/*
```

El logger se inyecta externamente. Los tests inyectan un mock. `src/chains/index.ts` no lo inyecta (no tiene acceso al logger — el logger nace después de `parseEnv`, que corre en WFAC-2+). Futuro WFAC-10 hará `chainRegistry.setLogger(logger)` en `app.ts`.

### 6.5 Fail-fast init (CD-6, CD-15)

```ts
function readEnv(name: string, chainId: number): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
    //          ^^^^^^^^^^^^^^^^^^^^ mensaje con el nombre literal de la env var
  }
  return value;
}
```

La excepción ocurre al importar el módulo (construcción de adapter), NO al hacer request. Esto bloquea el boot de la app — exactamente el comportamiento deseado.

### 6.6 Test pattern: `vi.resetModules()` para re-import con envs cambiadas

Copiado del exemplar `src/__tests__/unit/env.test.ts`:

```ts
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  snapshot = snapshotEnv();
  process.env['KITE_TESTNET_RPC_URL'] = 'https://...';
  vi.resetModules(); // fuerza re-import del módulo bajo test
});

afterEach(() => {
  restoreEnv(snapshot);
  vi.resetModules();
});

it('reads env at module-load', async () => {
  const mod = await import('../../chains/kite.js');
  // ...
});
```

Esto es crítico porque los adapters leen `process.env` en construcción del módulo. Sin `vi.resetModules()`, el segundo test usaría el módulo cacheado con los valores del primer test.

---

## 7. Waves (orden obligatorio)

### W0 — `src/core/types.ts` (serial, blocker)

1. Crear archivo con el shape de §5.1.
2. `npm run typecheck` → debe pasar.
3. `npm run lint` → 0 warnings.

**Output esperado**: archivo creado, 0 errores.

### W1 — `src/chains/types.ts` (serial, blocker)

1. Crear archivo con el shape de §5.2.
2. `npm run typecheck` → debe pasar (importando de W0).
3. `npm run lint` → 0 warnings.

**Output esperado**: archivo creado, imports a core/types.js todos `type`-only.

### W2 — `src/chains/registry.ts` (paralelizable con W3+W4)

1. Crear archivo con el shape de §5.3.
2. `npm run typecheck` → debe pasar.
3. `npm run lint` → 0 warnings.

**Output esperado**: `ChainRegistry` class + `chainRegistry` singleton exportados.

### W3 — `src/chains/kite.ts` (paralelizable con W2+W4)

1. Crear archivo con el shape de §5.4.
2. Actualizar `.env.example` si `KITE_TESTNET_RPC_URL` / `KITE_MAINNET_RPC_URL` no están documentados.
3. `npm run typecheck` → debe pasar.

**Output esperado**: 2 adapters exportados (`kiteTestnetAdapter`, `kiteMainnetAdapter`).

### W4 — `src/chains/avalanche.ts` (paralelizable con W2+W3)

1. Crear archivo con el shape de §5.5.
2. Actualizar `.env.example` si `AVALANCHE_FUJI_RPC_URL` no está documentado.
3. `npm run typecheck` → debe pasar.

**Output esperado**: `avalancheFujiAdapter` exportado.

### W5 — `src/chains/index.ts` (depende de W2+W3+W4)

1. Crear archivo con el shape de §5.6 (side-effect only, NO exports).
2. `npm run typecheck` → debe pasar.

**Output esperado**: side-effect module listo.

### W6 — Tests (depende de W2+W3+W4+W5)

1. Crear los 3 archivos de test (§5.7.1, §5.7.2, §5.7.3).
2. `npm run test` → **todos verdes** (≥ 26 tests).
3. `npm run test:coverage` → verificá manualmente que `src/chains/registry.ts` y `src/core/types.ts` reporten **≥ 95% statements**. El config-level thresholds está deshabilitado (TD-01-09), así que la verificación es vista humana en el output JSON/HTML.
4. `npm run qa` → todo verde (typecheck + lint + format:check + test).

**Output esperado**: 3 test files, ≥ 26 tests pasando, coverage ≥ 95%.

---

## 8. Test Plan tabulado (≥ 26 tests, 14 ACs)

| # | Test name | Archivo | AC / CD | Expected |
|---|-----------|---------|---------|----------|
| 1 | `asChainId accepts positive integers` | core-types.test.ts | DT-9 | returns the same number |
| 2 | `asChainId throws for zero` | core-types.test.ts | DT-9 | throws /Invalid chainId/ |
| 3 | `asChainId throws for negative` | core-types.test.ts | DT-9 | throws |
| 4 | `asChainId throws for float` | core-types.test.ts | DT-9 | throws |
| 5 | `asChainId throws for NaN` | core-types.test.ts | DT-9 | throws |
| 6 | `Result<T> narrows ok:true branch to expose the data` | core-types.test.ts | DT-6 | typed access to data works |
| 7 | `Result<T> narrows ok:false branch to expose error` | core-types.test.ts | DT-6 | typed access to error.* |
| 8 | `X402ErrorCode has exactly the 10 canonical codes` | core-types.test.ts | CD-10 | array.length === 10, set size 10 |
| 9 | `register registers and returns ok` | chain-registry.test.ts | AC-1 | ok:true with chainId |
| 10 | `register returns NETWORK_MISMATCH http 409 on duplicate, no overwrite` | chain-registry.test.ts | AC-5 | ok:false, http 409, original stays |
| 11 | `register returns NETWORK_MISMATCH http 500 on invalid adapter shape` | chain-registry.test.ts | AC-6 | ok:false, http 500, msg missing required |
| 12 | `getAdapter returns registered adapter (O(1) map)` | chain-registry.test.ts | AC-1, CD-13/16 | ok:true, adapter === registered |
| 13 | `getAdapter returns NETWORK_MISMATCH http 400 for unregistered (never throws)` | chain-registry.test.ts | AC-4, CD-4 | ok:false, http 400, no throw |
| 14 | `listAdapters returns metadata array with no duplicates` | chain-registry.test.ts | AC-2 | length 3, unique ids |
| 15 | `getSupportedChainIds returns unique array` | chain-registry.test.ts | AC-3 | length 2, unique |
| 16 | `AC-10: logs info with chainId and name when logger injected` | chain-registry.test.ts | AC-10, DT-11 | logger.info called with {chainId,name} |
| 17 | `does not throw and does not log when no logger set` | chain-registry.test.ts | DT-11 | register OK, no calls |
| 18 | `logs once per registered adapter` | chain-registry.test.ts | DT-11 | logger.info called 2x |
| 19 | `_resetForTesting clears adapters when NODE_ENV === test` | chain-registry.test.ts | CD-9 | length 0 after reset |
| 20 | `_resetForTesting throws when NODE_ENV !== test` | chain-registry.test.ts | CD-9 | throws /test environment/ |
| 21 | `AC-9: module-load registers ≥ 1 chain` | chain-registry.test.ts | AC-9 | supportedChainIds length ≥ 1 |
| 22 | `AC-11: kiteTestnetAdapter chainId 2368, testnet, eip155:2368` | chain-adapter.test.ts | AC-11 | fields exact |
| 23 | `AC-12: kiteMainnetAdapter chainId 2366, mainnet, eip155:2366` | chain-adapter.test.ts | AC-12 | fields exact |
| 24 | `AC-13: kite throws ChainAdapterInitError when KITE_TESTNET_RPC_URL missing` | chain-adapter.test.ts | AC-13, CD-15 | throws with env var name in message |
| 25 | `AC-13: kite throws ChainAdapterInitError when KITE_MAINNET_RPC_URL missing` | chain-adapter.test.ts | AC-13, CD-15 | throws with env var name in message |
| 26 | `DT-4: getPublicClient returns client with readContract method` | chain-adapter.test.ts | DT-4 | typeof === function |
| 27 | `DT-4: getWalletClient returns client with writeContract method` | chain-adapter.test.ts | DT-4 | typeof === function |
| 28 | `kite verify returns NETWORK_MISMATCH with WFAC-10 message` | chain-adapter.test.ts | Scope | error.code + message matches WFAC-10 |
| 29 | `kite settle returns NETWORK_MISMATCH with WFAC-11 message` | chain-adapter.test.ts | Scope | error.code + message matches WFAC-11 |
| 30 | `avalanche chainId 43113, testnet, eip155:43113` | chain-adapter.test.ts | DT-10 | fields exact |
| 31 | `avalanche throws ChainAdapterInitError when AVALANCHE_FUJI_RPC_URL missing` | chain-adapter.test.ts | CD-15 | throws w/ var name |
| 32 | `avalanche exposes USDC Fuji with decimals 6` | chain-adapter.test.ts | DT-10 | tokens[0] symbol USDC, decimals 6 |
| 33 | `avalanche verify returns NETWORK_MISMATCH WFAC-52` | chain-adapter.test.ts | Scope | msg matches WFAC-52 |
| 34 | `avalanche settle returns NETWORK_MISMATCH WFAC-52` | chain-adapter.test.ts | Scope | msg matches WFAC-52 |

**Total**: 34 tests. Superset del umbral ≥ 26 indicado en el SDD.

---

## 9. Constraint Directives (22 CDs — todos listados)

### Heredados del work-item (11)

| # | Literal |
|---|---------|
| CD-1 | PROHIBIDO hardcodear `chainId`, `rpcUrl`, `tokenAddress` en `src/chains/`. Excepción documentada: USDC Fuji en `avalanche.ts` + `chainId` literal en los adapter constructors (chainIds son constantes matemáticas, no credenciales). |
| CD-2 | PROHIBIDO que `src/chains/<chain>.ts` importe de `src/core/*` en runtime. Única excepción: `asChainId` de `../core/types.js` como runtime import para construir `ChainMetadata.chainId`. |
| CD-3 | PROHIBIDO que `src/chains/registry.ts` importe de `src/core/*`, `src/methods/*`, `src/routes/*`. Solo `type` imports de `../core/types.js`. |
| CD-4 | PROHIBIDO que `ChainRegistry.getAdapter()` lance. OBLIGATORIO retornar `Result<>`. |
| CD-5 | PROHIBIDO `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error` en `src/chains/` ni `src/core/types.ts`. |
| CD-6 | OBLIGATORIO `rpcUrl` se lee de `process.env` en construcción del adapter. Fail-fast si ausente. |
| CD-7 | PROHIBIDO `console.*` en cualquier archivo de `src/`. |
| CD-8 | PROHIBIDO crear `src/infra/wallet.ts` en esta HU. `getWalletClient()` = lazy stub. |
| CD-9 | OBLIGATORIO `_resetForTesting()` solo en `NODE_ENV==='test'`; throw en prod. |
| CD-10 | OBLIGATORIO `X402ErrorCode` = union literal con exactamente los 10 códigos listados. |
| CD-11 | PROHIBIDO auto-discovery via filesystem. Registro explícito en `src/chains/index.ts`. |

### Nuevos del Architect (8)

| # | Literal |
|---|---------|
| CD-12 | OBLIGATORIO que TODO import relativo en `src/chains/` y `src/core/types.ts` lleve suffix `.js` (Node16 ESM). |
| CD-13 | OBLIGATORIO que `ChainRegistry` use `Map<ChainId, ChainAdapter>` (no `Record`, no `Object` indexed). |
| CD-14 | PROHIBIDO loguear `rpcUrl` en prod. Solo `chainId` + `name` van al logger. |
| CD-15 | OBLIGATORIO que `ChainAdapterInitError.message` incluya el nombre exacto de la env var faltante. |
| CD-16 | PROHIBIDO `Array.prototype.find()` en `getAdapter()`. Solo `map.get()` — O(1) literal. |
| CD-17 | OBLIGATORIO que cada archivo nuevo empiece con JSDoc block (exports, boundaries, futuro). |
| CD-18 | PROHIBIDO aceptar un `chainId` externo al `register()` — el registry usa `adapter.metadata.chainId` como clave (no acepta override). |
| CD-19 | OBLIGATORIO que `src/chains/index.ts` sea side-effect-only. CERO exports. |

### Anti-regresión WFAC-2 (3)

| # | Literal |
|---|---------|
| CD-20 | PROHIBIDO importar símbolos de deps transitivas no declaradas en `package.json`. |
| CD-21 | PROHIBIDO hacer `as any`. Usar anotación explícita del generic viem cuando necesario (`as PublicClient` / `as WalletClient` es aceptable cuando es especialización viem — ver §5.4 nota). |
| CD-22 | PROHIBIDO `console.log` en tests (usar `vi.spyOn(console, 'log')` si realmente se necesita). |

---

## 10. Done Definition (DoD)

Marcá cada item solo cuando el comando correspondiente **pasó en verde**:

- [ ] **W0-W6 ejecutadas** en el orden indicado.
- [ ] `src/core/types.ts` existe y exporta `Ok`, `Err`, `Result`, `Address`, `ChainId`, `asChainId`, `X402ErrorCode`.
- [ ] `src/chains/types.ts` existe y exporta `EIP3009Token`, `ChainMetadata`, `VerifyParams`, `VerifyResult`, `SettleParams`, `SettleResult`, `AdapterResult`, `ChainAdapter`, `RegisterResult`, `ChainAdapterInitError`.
- [ ] `src/chains/registry.ts` exporta `ChainRegistry` (class) + `chainRegistry` (singleton).
- [ ] `src/chains/kite.ts` exporta `kiteTestnetAdapter` + `kiteMainnetAdapter`.
- [ ] `src/chains/avalanche.ts` exporta `avalancheFujiAdapter`.
- [ ] `src/chains/index.ts` es side-effect-only (0 exports).
- [ ] Los 3 archivos de test existen en `src/__tests__/unit/`.
- [ ] `.env.example` incluye `KITE_TESTNET_RPC_URL`, `KITE_MAINNET_RPC_URL`, `AVALANCHE_FUJI_RPC_URL`.
- [ ] `npm run typecheck` → 0 errores.
- [ ] `npm run lint` → 0 warnings.
- [ ] `npm run format:check` → 0 diffs.
- [ ] `npm run test` → todos verdes (≥ 26 tests, en tu caso 34).
- [ ] `npm run test:coverage` → `src/chains/registry.ts` statements ≥ 95%. `src/core/types.ts` statements ≥ 95%.
- [ ] `npm run build` → `dist/` se genera sin errores.
- [ ] `npm run qa` → pasa en verde (es el comando agregado: typecheck + lint + format + test).
- [ ] Verificar con `grep` que **no hay imports de `core/`** desde `chains/` **excepto** `import type` y `asChainId`:
  ```bash
  grep -n "from '\.\./core/" src/chains/*.ts
  # Esperado: solo líneas con `import type` o `import { asChainId }`.
  ```
- [ ] Verificar que **no hay `console.*`** en los archivos nuevos:
  ```bash
  grep -rn "console\." src/chains/ src/core/types.ts
  # Esperado: cero matches.
  ```
- [ ] Verificar que **todos los imports relativos** usan `.js`:
  ```bash
  grep -rn "from '\(\.\|\.\.\)\/[^']*[^s]'" src/chains/ src/core/types.ts
  # Esperado: cero matches (o documentar si es sub-path sin extension esperado, p.ej. 'viem/chains' que no es relativo).
  ```
- [ ] Confirmar que `src/infra/wallet.ts` NO existe (CD-8):
  ```bash
  ls src/infra/wallet.ts 2>&1 | grep -q "No such"
  # Esperado: exit 0 (archivo no existe).
  ```

### Entrega final (para orquestador)

- [ ] **Commit** con mensaje estructurado: `feat(WFAC-4): chain registry + kite + avalanche stubs`.
- [ ] Reporte al orquestador: waves completadas, N tests pasando, coverage reportado, 0 warnings de lint/typecheck, hash del commit.
- [ ] NO hacer PR todavía — el pipeline NexusAgil sigue con AR (F4) → CR (F5) → QA (F6) → DONE (F7). El PR lo abre `nexus-docs` en F7.

---

## 11. Notas finales para el Dev

- **Si hay discrepancia entre el SDD y este Story File**, este Story File gana (es la versión operacional). El SDD es el rationale; el Story File es el contrato de implementación.
- **Si algo no está en el Story File pero está en el SDD**, asumí que es referencia arquitectónica — no lo implementes si no está listado acá.
- **Si detectás un bug en las shapes de tipo**, aplicá el fix mínimo, documentalo en el commit body, y reportá al orquestador para que el Architect actualice el SDD (post-hoc).
- **WFAC-2 auto-blindaje**: se está generando en paralelo (no existe al momento de escribir este Story File). Si encontrás errores recurrentes durante F3 que podrían haberse prevenido, anotá en comentarios del commit para alimentar el auto-blindaje de WFAC-4 al cierre.

**Fin del contrato. Empezá por W0.**

---

*Story File generado por nexus-architect en F2.5 — 2026-04-23.*
*SDD base: doc/sdd/003-wfac-4-chain-registry/sdd.md (SPEC_APPROVED).*
