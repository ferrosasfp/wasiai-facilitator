/**
 * fix/health-probe-non-evm — `/health` per-chain RPC probe must be
 * chain-family-agnostic.
 *
 * BUG BEING FIXED: `src/core/health-status.ts#probeChain` resolved the adapter by
 * numeric chainId (`eip155:<id>` key) and probed it with two viem/EVM calls
 * (`getPublicClient().getChainId()`). The Solana adapter is non-EVM by design
 * (`solana:<cluster>` key, no viem client), so it was reported
 * `rpc: 'unreachable'` on EVERY refresh and prod `/health` answered
 * `degraded: true` permanently (5 EVM chains ok + Solana Devnet unreachable).
 *
 * MUTATION CONTRACT: restoring the EVM-only probe
 *   `const c = chainRegistry.getAdapter(meta.chainId); await c.getChainId();`
 * must turn HP-1 / HP-2 / HP-4 RED.
 *
 * NO NETWORK: the Solana `Connection` is injected via `opts.connection` DI
 * (solana-adapter.ts constructor) and every EVM adapter is a local fake, so no
 * test in this file opens a socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { chainRegistry } from '../../chains/registry.js';
import { SolanaAdapter } from '../../chains/solana-adapter.js';
import { kiteTestnetAdapter } from '../../chains/kite.js';
import type { ChainAdapter, ChainMetadata, SettlementAdapter } from '../../chains/types.js';
// `import type` (no `typeof import(...)` inline): `@typescript-eslint/consistent-type-imports`
// prohíbe la anotación inline, y el import de tipo se borra en runtime — no pelea con el mock.
import type * as RedisModule from '../../infra/redis.js';
import { asChainId } from '../../core/types.js';
import {
  getHealthStatus,
  refreshHealthStatusNow,
  resetHealthStatusForTesting,
  type ChainHealth,
  type HealthStatusDetail,
} from '../../core/health-status.js';
import {
  CHAIN_HEALTH_REQUIRED_FIELDS,
  HEALTH_DETAIL_FIELDS,
  compileHealthDetailValidator,
  loadOpenApiSpec,
} from '../helpers/health-shape.js';

/**
 * Cliente Redis falso, inyectado por `vi.hoisted` (no por una variable de módulo: el factory
 * del `vi.mock` se evalúa durante la fase de imports, antes del cuerpo de este archivo, y una
 * `let` normal estaría en TDZ si algún módulo llamara a `getRedisClient()` al importarse).
 *
 * Arranca en `null`, que es EXACTAMENTE lo que devuelve el real en el entorno de test (no hay
 * `REDIS_URL` en `vitest.config.ts` y `initRedis` no se llama), así que HP-1..HP-9 y
 * `T-H-CONF-2` corren igual que antes de este mock. Sólo HP-10 lo pone en no-nulo, y el
 * `afterEach` lo devuelve a `null`.
 *
 * Hace falta porque HP-10 necesita un Redis CONFIGURADO y CAÍDO: con `getRedisClient() === null`
 * el estado es 'disabled' en los dos snapshots y `redis.status` desaparecería del conjunto
 * derivado — el campo del AR-1 BLQ-BAJO-1 justamente. Un `new Redis()` real contra un puerto
 * muerto también serviría, pero rompería el invariante "ningún test de este archivo abre un
 * socket" del docblock de arriba.
 */
const redisFake = vi.hoisted(() => ({
  client: null as { ping: () => Promise<string> } | null,
}));

vi.mock('../../infra/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisModule>();
  return {
    ...actual,
    getRedisClient: (): { ping: () => Promise<string> } | null => redisFake.client,
  };
});

// ─── fixtures ──────────────────────────────────────────────────────────────

/** Base58 pubkeys generated at runtime (never a hardcoded literal → no-secrets). */
const MINT_58 = Keypair.generate().publicKey.toBase58();

/** The 4 EVM chains registered in the production facilitator + their names. */
const PROD_EVM_CHAINS: ReadonlyArray<readonly [number, string]> = [
  [2368, 'Kite Testnet'],
  [43113, 'Avalanche Fuji'],
  [43114, 'Avalanche'],
  [84532, 'Base Sepolia'],
];

function evmMetadata(chainId: number, name: string): ChainMetadata {
  return {
    chainId: asChainId(chainId),
    name,
    network: chainId === 43114 ? 'mainnet' : 'testnet',
    networkId: `eip155:${chainId}`,
    rpcUrl: 'http://127.0.0.1:0',
    nativeCurrency: { name: 'Native', symbol: 'NAT', decimals: 18 },
    tokens: [],
  };
}

interface EvmFake {
  readonly adapter: ChainAdapter;
  readonly getChainId: ReturnType<typeof vi.fn>;
  readonly getPublicClient: ReturnType<typeof vi.fn>;
}

/**
 * EVM fake shaped exactly like the real `BaseEip3009Adapter`: its `probeRpc()`
 * delegates to `getPublicClient().getChainId()`, so the EVM health path stays
 * observable through the same two spies the pre-fix code called directly.
 */
function makeEvmFake(chainId: number, name: string, chainIdImpl: () => Promise<number>): EvmFake {
  const getChainId = vi.fn(chainIdImpl);
  const getPublicClient = vi.fn(
    () => ({ getChainId }) as unknown as ReturnType<ChainAdapter['getPublicClient']>,
  );
  const adapter: ChainAdapter = {
    metadata: evmMetadata(chainId, name),
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient,
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
    probeRpc: async (): Promise<void> => {
      await getPublicClient().getChainId();
    },
  };
  return { adapter, getChainId, getPublicClient };
}

interface NonEvmFake {
  readonly adapter: SettlementAdapter;
  readonly probeRpc: ReturnType<typeof vi.fn>;
  /** Present ONLY as a tripwire: a chain-family-aware prober would call it. */
  readonly getPublicClient: ReturnType<typeof vi.fn>;
}

function makeNonEvmFake(opts: {
  chainId: number;
  name: string;
  networkId: string;
  probe: () => Promise<void>;
}): NonEvmFake {
  const probeRpc = vi.fn(opts.probe);
  const getPublicClient = vi.fn(() => {
    throw new Error('non-EVM adapter has no viem public client');
  });
  const adapter: SettlementAdapter = {
    metadata: {
      chainId: asChainId(opts.chainId),
      name: opts.name,
      network: 'testnet',
      networkId: opts.networkId,
      rpcUrl: 'http://127.0.0.1:0',
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      tokens: [],
    },
    verify: vi.fn() as unknown as SettlementAdapter['verify'],
    settle: vi.fn() as unknown as SettlementAdapter['settle'],
    probeRpc,
  };
  // Attached AFTER construction so the object keeps the verify-only type while
  // still exposing the tripwire spy at runtime.
  Object.assign(adapter, { getPublicClient });
  return { adapter, probeRpc, getPublicClient };
}

/** Real SolanaAdapter with an injected fake Connection (DT-9 DI, no network). */
function makeSolanaAdapter(getVersion: ReturnType<typeof vi.fn>): {
  adapter: SolanaAdapter;
  getTransaction: ReturnType<typeof vi.fn>;
} {
  const getTransaction = vi.fn(async () => null);
  const connection = { getVersion, getTransaction } as unknown as Connection;
  const adapter = new SolanaAdapter({
    rpcUrl: 'http://127.0.0.1:0/devnet',
    mint: MINT_58,
    cluster: 'devnet',
    connection,
  });
  return { adapter, getTransaction };
}

function chainOf(chains: readonly ChainHealth[], chainId: number): ChainHealth | undefined {
  return chains.find((c) => c.chainId === chainId);
}

describe('fix/health-probe-non-evm — probeChain is chain-family-agnostic', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
    resetHealthStatusForTesting();
  });

  afterEach(() => {
    chainRegistry._resetForTesting();
    resetHealthStatusForTesting();
    redisFake.client = null; // `vi.restoreAllMocks()` NO revierte un `vi.mock` de módulo.
    vi.restoreAllMocks();
  });

  // ─── HP-1: the real non-EVM adapter is probed OK, without any viem API ────

  it('HP-1: the real SolanaAdapter is probed via getVersion() and reported "ok" (MUTATION: red on the EVM-only probe)', async () => {
    const getVersion = vi.fn(async () => ({ 'solana-core': '1.18.26' }));
    const { adapter, getTransaction } = makeSolanaAdapter(getVersion);
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();
    const solana = chainOf(snap.chains, 103);

    expect(solana).toBeDefined();
    expect(solana?.network).toBe('solana:devnet');
    // THE regression assertion: this was 'unreachable' in production.
    expect(solana?.rpc).toBe('ok');
    // The probe is the cheapest node-config call, once per refresh...
    expect(getVersion).toHaveBeenCalledTimes(1);
    // ...and it never touches the money path (no tx reads on a health probe).
    expect(getTransaction).not.toHaveBeenCalled();
    // Structural proof there is nothing viem-shaped to probe on this adapter.
    expect('getPublicClient' in adapter).toBe(false);
    expect('getWalletClient' in adapter).toBe(false);
  });

  // ─── HP-2: no viem/EVM API is touched on a non-EVM adapter ───────────────

  it('HP-2: a non-EVM adapter is probed WITHOUT calling getPublicClient()/getChainId()', async () => {
    const fake = makeNonEvmFake({
      chainId: 101,
      name: 'Solana Mainnet',
      networkId: 'solana:mainnet',
      probe: async () => undefined,
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    expect(chainOf(snap.chains, 101)?.rpc).toBe('ok');
    expect(fake.probeRpc).toHaveBeenCalledTimes(1);
    // The EVM-only prober would have reached for a viem client here.
    expect(fake.getPublicClient).not.toHaveBeenCalled();
  });

  // ─── HP-3: the EVM path is unchanged ─────────────────────────────────────

  it('HP-3: the 4 EVM chains are still probed through getPublicClient().getChainId() and all report "ok"', async () => {
    const fakes = PROD_EVM_CHAINS.map(([chainId, name]) =>
      makeEvmFake(chainId, name, async () => chainId),
    );
    for (const f of fakes) expect(chainRegistry.register(f.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    for (const [chainId] of PROD_EVM_CHAINS) {
      expect(chainOf(snap.chains, chainId)?.rpc).toBe('ok');
    }
    for (const f of fakes) {
      expect(f.getPublicClient).toHaveBeenCalledTimes(1);
      expect(f.getChainId).toHaveBeenCalledTimes(1);
    }
  });

  it('HP-3b: the REAL EVM adapter implementation probes with eth_chainId via its viem public client', async () => {
    const getChainId = vi.fn(async () => 2368);
    const spy = vi
      .spyOn(kiteTestnetAdapter, 'getPublicClient')
      .mockReturnValue({ getChainId } as unknown as ReturnType<ChainAdapter['getPublicClient']>);

    await expect(kiteTestnetAdapter.probeRpc()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  // ─── HP-4: degraded is no longer stuck at true ────────────────────────────

  it('HP-4: degraded is false with the full prod chain set (4 EVM + Solana) healthy (MUTATION: red on the EVM-only probe)', async () => {
    for (const [chainId, name] of PROD_EVM_CHAINS) {
      const f = makeEvmFake(chainId, name, async () => chainId);
      expect(chainRegistry.register(f.adapter).ok).toBe(true);
    }
    const { adapter } = makeSolanaAdapter(vi.fn(async () => ({ 'solana-core': '1.18.26' })));
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    expect(snap.chains).toHaveLength(5);
    expect(snap.chains.every((c) => c.rpc === 'ok')).toBe(true);
    // wallet present (vitest env sets OPERATOR_PRIVATE_KEY) + redis 'disabled'
    // (no REDIS_URL in test) are both NON-degrading, so the only remaining
    // degradation source was the phantom Solana 'unreachable'.
    expect(snap.wallet.present).toBe(true);
    expect(snap.redis.status).toBe('disabled');
    expect(snap.degraded).toBe(false);
  });

  // ─── HP-5: the probe never throws ────────────────────────────────────────

  it('HP-5: probeChain never throws — rejecting, synchronously-throwing and probe-less adapters all degrade gracefully', async () => {
    const rejecting = makeNonEvmFake({
      chainId: 901,
      name: 'Rejects',
      networkId: 'solana:rejects',
      probe: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:0');
      },
    });
    const throwingSync: SettlementAdapter = {
      ...makeNonEvmFake({
        chainId: 902,
        name: 'ThrowsSync',
        networkId: 'solana:throws-sync',
        probe: async () => undefined,
      }).adapter,
      probeRpc: (): Promise<void> => {
        throw new Error('boom — synchronous explosion');
      },
    };
    // Adapter smuggled in through an unsafe cast, with NO probeRpc at all
    // (the TS contract makes this impossible in src/, but a bad cast could).
    const probeless = {
      metadata: {
        chainId: asChainId(903),
        name: 'NoProbe',
        network: 'testnet' as const,
        networkId: 'solana:no-probe',
        rpcUrl: 'http://127.0.0.1:0',
        nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
        tokens: [],
      },
      verify: vi.fn(),
      settle: vi.fn(),
    } as unknown as SettlementAdapter;

    expect(chainRegistry.register(rejecting.adapter).ok).toBe(true);
    expect(chainRegistry.register(throwingSync).ok).toBe(true);
    expect(chainRegistry.register(probeless).ok).toBe(true);

    // No rejection escapes the probe.
    const snap = await refreshHealthStatusNow();

    expect(chainOf(snap.chains, 901)?.rpc).toBe('unreachable');
    expect(chainOf(snap.chains, 902)?.rpc).toBe('unreachable');
    expect(chainOf(snap.chains, 903)?.rpc).toBe('unreachable');
    expect(snap.degraded).toBe(true);
  });

  // ─── HP-6/HP-7: rate-limit (429) hysteresis vs hard failures ─────────────

  it('HP-6: a single 429 from the rate-limiting public devnet RPC does NOT flip the chain (tolerated, but reported)', async () => {
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('failed to get version: Error: 429 Too Many Requests');
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const first = await refreshHealthStatusNow();
    const firstSolana = chainOf(first.chains, 103);
    expect(firstSolana?.rpc).toBe('ok'); // tolerated blip — no flapping
    expect(firstSolana?.consecutiveFailures).toBe(1); // but NEVER silent
    expect(firstSolana?.lastFailureKind).toBe('transient');
    expect(first.degraded).toBe(false);

    // A SECOND consecutive transient failure is no longer a blip.
    const second = await refreshHealthStatusNow();
    const secondSolana = chainOf(second.chains, 103);
    expect(secondSolana?.rpc).toBe('unreachable');
    expect(secondSolana?.consecutiveFailures).toBe(2);
    expect(second.degraded).toBe(true);
  });

  it('HP-6b: a successful probe resets the transient counter (and omits the additive fields)', async () => {
    let fail = true;
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        if (fail) throw new Error('429 Too Many Requests');
        return undefined;
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    expect(chainOf((await refreshHealthStatusNow()).chains, 103)?.consecutiveFailures).toBe(1);
    fail = false;
    const recovered = chainOf((await refreshHealthStatusNow()).chains, 103);
    expect(recovered?.rpc).toBe('ok');
    expect(recovered?.consecutiveFailures).toBeUndefined();
    expect(recovered?.lastFailureKind).toBeUndefined();

    // And a later 429 starts counting from 1 again (no accumulated history).
    fail = true;
    expect(chainOf((await refreshHealthStatusNow()).chains, 103)?.consecutiveFailures).toBe(1);
  });

  // NOTE: vitest 4 takes the options object as the SECOND argument (the
  // `it(name, fn, opts)` signature was removed in v4).
  it(
    'HP-6c: a hung RPC hits the short probe timeout, is classified transient and is bounded',
    { timeout: 10_000 },
    async () => {
      const fake = makeNonEvmFake({
        chainId: 103,
        name: 'Solana Devnet',
        networkId: 'solana:devnet',
        // Never resolves — exactly what a 429-retrying Connection looks like.
        probe: () => new Promise<void>(() => undefined),
      });
      expect(chainRegistry.register(fake.adapter).ok).toBe(true);

      const started = Date.now();
      const snap = await refreshHealthStatusNow();
      const elapsed = Date.now() - started;

      // Bounded by RPC_PROBE_TIMEOUT_MS (1500ms) — a health refresh never hangs.
      expect(elapsed).toBeLessThan(4000);
      const solana = chainOf(snap.chains, 103);
      expect(solana?.lastFailureKind).toBe('transient');
      expect(solana?.rpc).toBe('ok'); // first timeout tolerated
      expect(snap.degraded).toBe(false);
    },
  );

  it('HP-7: a hard connection failure is reported "unreachable" on the FIRST probe (no hysteresis)', async () => {
    const fake = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8899');
      },
    });
    expect(chainRegistry.register(fake.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();
    const solana = chainOf(snap.chains, 103);
    expect(solana?.rpc).toBe('unreachable');
    expect(solana?.consecutiveFailures).toBe(1);
    expect(solana?.lastFailureKind).toBe('connection');
    expect(snap.degraded).toBe(true);
  });

  // ─── HP-8: the /health response shape is unchanged (additive only) ────────

  it('HP-8: a healthy chain entry keeps EXACTLY the legacy keys (new fields are additive/omitted)', async () => {
    const f = makeEvmFake(2368, 'Kite Testnet', async () => 2368);
    expect(chainRegistry.register(f.adapter).ok).toBe(true);
    const { adapter } = makeSolanaAdapter(vi.fn(async () => ({ 'solana-core': '1.18.26' })));
    expect(chainRegistry.register(adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    // WKH-344 — las dos listas se DERIVAN del tipo (`../helpers/health-shape.ts`), no se
    // escriben acá: era el mismo defecto que dejó al contrato de `/health` divergir.
    // La segunda va contra `CHAIN_HEALTH_REQUIRED_FIELDS` y NO contra `CHAIN_HEALTH_FIELDS`:
    // lo que este assert mide es que una entrada SANA omite las dos aditivas, o sea el
    // SUBCONJUNTO no-opcional del tipo. Con las 6 claves se pondría rojo por el motivo
    // equivocado.
    expect(Object.keys(snap).sort()).toEqual([...HEALTH_DETAIL_FIELDS].sort());
    for (const chain of snap.chains) {
      expect(Object.keys(chain).sort()).toEqual([...CHAIN_HEALTH_REQUIRED_FIELDS].sort());
    }
  });

  // ─── HP-9: DNS no es UN caso, son DOS, y el contrato publicaba uno solo ───

  it('HP-9: un fallo TEMPORAL de resolución (EAI_AGAIN) se clasifica `transient` y conserva `rpc: ok`; uno PERMANENTE (ENOTFOUND) es `connection` en la primera sonda', async () => {
    // AR BLQ-BAJO-2. El contrato decía: "`connection` (refused, DNS, TLS, or a malformed
    // adapter) is reported at once". Falso para la mitad temporal del DNS: `EAI_AGAIN` —el
    // fallo de resolución RECUPERABLE de Node— está dentro de `TRANSIENT_PROBE_ERROR_RE`
    // (`src/core/health-status.ts:121-122`), así que `classifyProbeError`
    // (`src/core/health-status.ts:208-211`) lo devuelve
    // 'transient' y la histéresis lo tolera por debajo del umbral de 2: la chain sigue
    // publicando `rpc: 'ok'`.
    //
    // Antes de este test, `grep -rn "EAI_AGAIN\|ENOTFOUND\|getaddrinfo" src/__tests__/` daba
    // UN hit, y era de otro módulo (`chains/error-classifier.test.ts:65`): ningún test del
    // camino de `/health` afirmaba la clasificación que el contrato publica para DNS.
    //
    // Los mensajes son los que emite Node de verdad para cada caso, no una paráfrasis.
    const temporal = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('getaddrinfo EAI_AGAIN api.devnet.solana.example');
      },
    });
    const permanente = makeNonEvmFake({
      chainId: 104,
      name: 'Otra',
      networkId: 'solana:otra',
      probe: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.devnet.solana.example');
      },
    });
    expect(chainRegistry.register(temporal.adapter).ok).toBe(true);
    expect(chainRegistry.register(permanente.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    // (a) el caso que el contrato ponía en la casilla equivocada.
    const t = chainOf(snap.chains, 103);
    expect(t?.lastFailureKind).toBe('transient');
    expect(t?.rpc).toBe('ok'); // tolerado: NO se reporta "at once"
    expect(t?.consecutiveFailures).toBe(1);
    // (b) el caso que sí es inmediato, para que (a) no se lea como "DNS nunca es connection".
    const p = chainOf(snap.chains, 104);
    expect(p?.lastFailureKind).toBe('connection');
    expect(p?.rpc).toBe('unreachable');
    expect(p?.consecutiveFailures).toBe(1);
    // control anti-tautología: los dos códigos van a la MISMA función y salen distintos.
    expect(t?.lastFailureKind).not.toBe(p?.lastFailureKind);

    // (c) y el lazo con la prosa publicada: cada código tiene que estar del lado del valor
    //     que acaba de medirse. Posicional a propósito — que `EAI_AGAIN` aparezca en el
    //     documento no alcanza si aparece dentro de la oración de `connection`.
    const kindDesc = (
      (
        loadOpenApiSpec().components.schemas.ChainHealthItem!.properties as Record<
          string,
          Record<string, unknown>
        >
      ).lastFailureKind!.description as string
    ).replace(/\s+/g, ' ');
    //
    // ⚠️ SE CUENTAN TODAS LAS APARICIONES, no `indexOf` (AR-2 BLQ-BAJO-2). Con `indexOf` el
    // mutante que suma el código a la casilla equivocada SIN sacarlo de la buena sobrevive en
    // verde: "`connection` covers … any name-resolution failure (`EAI_AGAIN` as well as
    // `ENOTFOUND`)" deja el primer hit de EAI_AGAIN donde estaba (lado `transient`), y
    // `indexOf` no ve el segundo. Un duplicado en la casilla equivocada es invisible para el
    // primer hit; por eso el invariante es sobre CADA aparición.
    const allIndexesOf = (needle: string): number[] => {
      const out: number[] = [];
      for (let i = kindDesc.indexOf(needle); i !== -1; i = kindDesc.indexOf(needle, i + 1)) {
        out.push(i);
      }
      return out;
    };
    // El razonamiento posicional sólo cierra si cada etiqueta parte el texto UNA vez: con dos
    // `\`connection\`` no hay "después de connection" bien definido. Medido sobre el texto
    // publicado hoy: 1 y 1.
    const transientMarks = allIndexesOf('`transient`');
    const connectionMarks = allIndexesOf('`connection`');
    expect(transientMarks).toHaveLength(1);
    expect(connectionMarks).toHaveLength(1);
    const iTransient = transientMarks[0]!;
    const iConnection = connectionMarks[0]!;
    expect(iConnection).toBeGreaterThan(iTransient);
    const eaiAgainAt = allIndexesOf('EAI_AGAIN');
    const enotFoundAt = allIndexesOf('ENOTFOUND');
    expect(eaiAgainAt.length).toBeGreaterThanOrEqual(1);
    expect(enotFoundAt.length).toBeGreaterThanOrEqual(1);
    for (const i of eaiAgainAt) {
      expect(i, `EAI_AGAIN fuera de la oración de \`transient\` (offset ${i})`).toBeGreaterThan(
        iTransient,
      );
      expect(i, `EAI_AGAIN dentro de la oración de \`connection\` (offset ${i})`).toBeLessThan(
        iConnection,
      );
    }
    for (const i of enotFoundAt) {
      expect(i, `ENOTFOUND fuera de la oración de \`connection\` (offset ${i})`).toBeGreaterThan(
        iConnection,
      );
    }
  });

  // ─── HP-10: el conjunto de campos OPTIMISTAS se DERIVA del módulo corriendo ──

  it('HP-10 / AC-8: todo campo que el cuerpo pre-sonda reporta SIN medir está documentado con su descargo, y el conjunto se DERIVA de `initialSnapshot()`, no de una lista escrita a mano', async () => {
    // POR QUÉ EXISTE, y no es "un guard más": esta HU lleva cuatro rondas y CADA una encontró
    // una descripción optimista nueva (AR-1 dos, AR-2 la tercera, el fix-pack 2 la cuarta y la
    // quinta, `consecutiveFailures` y `lastFailureKind`). El problema no era la vista de nadie:
    // era que el conjunto se cazaba DE A UNO cuando es una CONSECUENCIA de una función.
    // `initialSnapshot()` es el único productor del cuerpo pre-sonda, así que "qué se reporta
    // sin haberlo medido" se puede derivar en vez de enumerar.
    //
    // CÓMO SE DERIVA, sin leer el fuente ni mantener una lista: se arma el escenario en el que
    // TODA dependencia sondeable está caída y se comparan los dos cuerpos que el módulo emite,
    // el pre-sonda y el post-sonda. Todo camino cuyo valor CAMBIA es, por definición, un campo
    // que el pre-sonda reportaba sin medirlo. Los que NO cambian se caen solos y por el motivo
    // correcto: `redis.configured`, `wallet.present` y `chains[].chainId|name|network` se leen
    // síncronos y son exactos a `probedAt: 0`. No hay lista de exclusión que mantener.
    //
    // ✅ EL CRITERIO QUE ESTE TEST COMPRA: agregar un campo optimista nuevo a
    //    `initialSnapshot()` sin documentarlo pone ESTO en rojo, sin que nadie toque el test.
    //    Medido con dos mutantes (ver el auto-blindaje de la HU): un `redisPingMs` optimista
    //    publicado CON descripción pero SIN el descargo → rojo acá y en ningún otro test; y el
    //    mismo campo sin declararlo en el schema → rojo acá (no resuelve) y en `T-H-CONF-1`.
    //
    // ⚠️ LO QUE NO ALCANZA, medido y declarado (tres residuos, ninguno silencioso):
    //   (a) un campo optimista cuyo valor COINCIDA en el escenario caído es invisible: p. ej.
    //       un `pingMs: 0` optimista que el post-sonda también deje en 0. La derivación mide
    //       "cambia cuando todo está caído", que es una APROXIMACIÓN de "no se midió", no la
    //       cosa misma. Cerrar eso exigiría instrumentar `initialSnapshot()` (no está exportada)
    //       o parsear el AST del módulo; con el escenario caído se cubren los 5 campos reales.
    //   (b) el `degraded` de NIVEL SUPERIOR (`HealthResponse`) queda afuera por construcción:
    //       la derivación recorre `details`. Lo cubre `T-O-DRIFT-4` (3), que exige el descargo
    //       en las DOS descripciones, con su mutante M-13.
    //   (c) el descargo se reconoce por una lista de TRES redacciones aceptadas (abajo). Un
    //       campo documentado con otra redacción da un FALSO ROJO, no un falso verde: la
    //       dirección segura. El arreglo es usar la redacción canónica o extender la lista a
    //       conciencia, no borrar el assert.
    const chainCaida = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
    });
    expect(chainRegistry.register(chainCaida.adapter).ok).toBe(true);
    // Redis CONFIGURADO y caído (ver el docblock de `redisFake`): sin esto `redis.status` es
    // 'disabled' en los dos cuerpos y se caería del conjunto derivado.
    redisFake.client = {
      ping: async (): Promise<string> => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    };
    // PRECONDICIÓN, y no es decorativa: sin `OPERATOR_PRIVATE_KEY` el wallet falta en los DOS
    // cuerpos, `degraded` vale `true` en ambos y DESAPARECE del conjunto derivado — que es
    // justo el campo del AR-2 BLQ-BAJO-3. Lo pone `vitest.config.ts`; si algún día se va, esto
    // se pone rojo acá en vez de vaciar la derivación en silencio.
    expect(typeof process.env['OPERATOR_PRIVATE_KEY']).toBe('string');

    const pre = await getHealthStatus();
    expect(pre.probedAt).toBe(0); // es el cuerpo pre-sonda, no otro
    const post = await refreshHealthStatusNow();
    expect(post.probedAt).toBeGreaterThan(0);

    // Hojas por camino. El índice del array se normaliza a `[]`: lo que se deriva es la FORMA
    // del cuerpo, no la instancia (hay una sola chain, así que no hay ambigüedad de valores).
    const leaves = (
      value: unknown,
      prefix: string,
      out: Map<string, string>,
    ): Map<string, string> => {
      if (Array.isArray(value)) {
        for (const item of value) leaves(item, `${prefix}[]`, out);
        return out;
      }
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          leaves(v, prefix === '' ? k : `${prefix}.${k}`, out);
        }
        return out;
      }
      out.set(prefix, JSON.stringify(value));
      return out;
    };
    const preLeaves = leaves(pre, '', new Map());
    const postLeaves = leaves(post, '', new Map());
    // `undefined` como valor de un `Map.get` de clave ausente ES la señal de "campo omitido",
    // y por eso las dos aditivas (ausentes pre-sonda, presentes post-sonda) entran al conjunto.
    const derived = [...new Set([...preLeaves.keys(), ...postLeaves.keys()])]
      .filter((path) => preLeaves.get(path) !== postLeaves.get(path))
      .sort();

    // Resolución camino → nodo del schema publicado. También mecánica: un campo nuevo se
    // resuelve solo, y si el schema no lo declara el `expect` de abajo dice cuál falta.
    const spec = loadOpenApiSpec();
    const schemas = new Map(Object.entries(spec.components.schemas));
    const deref = (node: Record<string, unknown>): Record<string, unknown> => {
      const ref = node.$ref;
      if (typeof ref !== 'string') return node;
      const target = schemas.get(ref.split('/').pop() ?? '');
      expect(target, `doc/openapi.yaml: \`$ref\` sin destino (${ref})`).toBeDefined();
      return target as Record<string, unknown>;
    };
    const resolveDoc = (path: string): Record<string, unknown> => {
      let node = deref(schemas.get('HealthDetail') as Record<string, unknown>);
      for (const rawSegment of path.split('.')) {
        const isArray = rawSegment.endsWith('[]');
        const segment = isArray ? rawSegment.slice(0, -2) : rawSegment;
        // `Map` y no `props[segment]`: indexar con variable dispara
        // `security/detect-object-injection` y `npm run lint` corre con `--max-warnings 0`.
        const props = new Map(
          Object.entries((node.properties ?? {}) as Record<string, Record<string, unknown>>),
        );
        const child = props.get(segment);
        expect(
          child,
          `doc/openapi.yaml no declara la propiedad \`${segment}\` del camino derivado \`${path}\`: el módulo emite un campo que el contrato no publica`,
        ).toBeDefined();
        node = deref(child as Record<string, unknown>);
        if (isArray) node = deref((node.items ?? {}) as Record<string, unknown>);
      }
      return node;
    };

    // Las TRES redacciones que cuentan como descargo. Es una lista ENUMERADA (residuo (c)), y
    // las tres están en uso hoy: `redis.status` dice "no PING has completed yet", `probedAt`
    // dice "no probe has completed yet", y el resto "before the first probe completes".
    const DESCARGO =
      /before the first probe completes|no probe has completed yet|no PING has completed yet/i;
    for (const path of derived) {
      const description = String(resolveDoc(path).description ?? '').replace(/\s+/g, ' ');
      expect(
        description,
        `\`${path}\` es optimista a \`probedAt: 0\` (derivado del módulo) y su descripción publicada no manda a leer \`probedAt\``,
      ).toMatch(/probedAt/);
      expect(
        description,
        `\`${path}\` es optimista a \`probedAt: 0\` (derivado del módulo) y su descripción publicada no trae el descargo del snapshot pre-sonda`,
      ).toMatch(DESCARGO);
    }

    // Control anti-vacío, en la dirección que la derivación NO cubre: si el escenario deja de
    // producir diferencia (un fake que no falla, el mock de Redis que vuelve a `null`, un
    // `probeAll` que no mide), el bucle de arriba pasaría por vacío en verde. Este piso es una
    // lista escrita a mano A PROPÓSITO, y es lo único de este test que lo es: NO es la
    // enumeración normativa —esa sale de `derived`— sino el testigo de que la derivación
    // derivó. Los 6 caminos son los medidos hoy; si aparece un séptimo, `derived` lo exige sin
    // que nadie toque esta lista.
    const PISO = [
      'chains[].consecutiveFailures',
      'chains[].lastFailureKind',
      'chains[].rpc',
      'degraded',
      'probedAt',
      'redis.status',
    ] as const;
    for (const path of PISO) {
      expect(
        derived,
        `la derivación dejó de derivar \`${path}\`: el escenario no está caído`,
      ).toContain(path);
    }
    // y que los campos síncronos sigan FUERA por el motivo correcto (no por un bug del walker).
    for (const path of ['redis.configured', 'wallet.present', 'chains[].chainId'] as const) {
      expect(
        derived,
        `\`${path}\` se lee síncrono: no puede estar en el conjunto optimista`,
      ).not.toContain(path);
    }
    // el tipo se usa: si `HealthStatusDetail` deja de tener `probedAt`, esto no compila.
    const _typed: HealthStatusDetail['probedAt'] = post.probedAt;
    expect(_typed).toBe(post.probedAt);
  });

  // ─── WKH-344: el subárbol `details` DEGRADADO contra su contrato publicado ─

  it('T-H-CONF-2 / AC-1+AC-3: un detail DEGRADADO, con los campos aditivos presentes, valida contra HealthDetail', async () => {
    // Este es el nivel que ningún testigo sano alcanza: `T-H-CONF-1` valida el cuerpo de
    // nivel superior con un inject real, pero con las chains en estado limpio, así que
    // `consecutiveFailures` / `lastFailureKind` nunca aparecen ahí. Armar el cuerpo de 6
    // campos a mano acá reintroduciría un espejo de `src/routes/health.ts:54-61`, que es la
    // clase de defecto de esta HU, así que este test valida `HealthDetail` a secas.
    //
    // (a) falla de conexión: unreachable + las dos aditivas.
    const dura = makeNonEvmFake({
      chainId: 103,
      name: 'Solana Devnet',
      networkId: 'solana:devnet',
      probe: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8899');
      },
    });
    expect(chainRegistry.register(dura.adapter).ok).toBe(true);
    // (b) 429 transitorio tolerado: rpc 'ok' CON las dos aditivas (la combinación que un
    //     testigo sano nunca produce). Sin sonda que cuelgue, así que no hace falta timeout.
    const blip = makeNonEvmFake({
      chainId: 104,
      name: 'Otra',
      networkId: 'solana:otra',
      probe: async () => {
        throw new Error('429 Too Many Requests');
      },
    });
    expect(chainRegistry.register(blip.adapter).ok).toBe(true);

    const snap = await refreshHealthStatusNow();

    // controles anti-vacío: el testigo TIENE lo que se quiere cubrir.
    const e1 = chainOf(snap.chains, 103);
    expect(e1?.rpc).toBe('unreachable');
    expect(e1?.consecutiveFailures).toBe(1);
    expect(e1?.lastFailureKind).toBe('connection');
    const e2 = chainOf(snap.chains, 104);
    expect(e2?.rpc).toBe('ok'); // tolerado: TRANSIENT_FAILURE_THRESHOLD es 2
    expect(e2?.lastFailureKind).toBe('transient');
    expect(e2?.consecutiveFailures).toBe(1);

    const validate = compileHealthDetailValidator(loadOpenApiSpec());
    const ok = validate(snap);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});
