# 030 · Validación F3 (Dev) — sonda de health no-EVM

**Branch**: `fix/health-probe-non-evm` (desde `main` @ `ba425a0`, árbol limpio verificado antes de branchear)
**Tipo**: bugfix (observabilidad) · **Fecha**: 2026-07-26
**Alcance**: `src/chains/types.ts`, `src/chains/base-adapter.ts`, `src/chains/solana-adapter.ts`, `src/core/health-status.ts`, tests.
**NO tocado**: prod, envs, migraciones, credenciales, rutas, contratos, dependencias.

---

## 1. El bug

`GET /health` de `wasiai-facilitator-production.up.railway.app` reportaba
`degraded: true` de forma **permanente**:

```
chains: 2368 Kite ok · 43113 Fuji ok · 43114 Avalanche ok · 84532 Base Sepolia ok
        103 Solana Devnet → rpc: 'unreachable'
```

Dos suposiciones EVM-only en `probeChain` lo causaban, ambas estructurales (no
dependían del estado del RPC):

| # | Suposición (código pre-fix) | Por qué falla en Solana |
|---|-----------------------------|--------------------------|
| 1 | `chainRegistry.getAdapter(meta.chainId)` | resuelve sólo la clave `eip155:<chainId>` y narrowea a `ChainAdapter`; el adapter Solana se registra por `metadata.networkId` = `solana:<cluster>` (`src/chains/registry.ts:62`, `src/chains/solana-adapter.ts:120`) → **lookup fallido siempre** |
| 2 | `lookup.adapter.getPublicClient().getChainId()` | el adapter es no-EVM por diseño: *"Non-EVM: no viem clients, no operator broadcast wallet"* (`src/chains/solana-adapter.ts:6`), usa `Connection` de `@solana/web3.js` (`:112`, `:123`) → **no existe el método** |

Consecuencia de proceso: un `/health` siempre rojo entrena al equipo a ignorarlo.

---

## 2. El fix (archivo:línea)

### 2.1 El contrato — el adapter responde por su propia salud

`src/chains/types.ts:141-162`
(docstring `:142-161`, firma `:162`) — `probeRpc(): Promise<void>` **requerido** (no
`probeRpc?()`) en `SettlementAdapter`:

- resuelve si el RPC contestó, lanza si no;
- al ser obligatorio en el tipo, **un adapter nuevo no compila sin sonda** → no
  puede volver a quedar mal sondeado en silencio;
- `ChainAdapter extends SettlementAdapter` (`types.ts:185`) lo hereda, así que los
  6 adapters EVM y el Solana quedan cubiertos por el mismo contrato.

### 2.2 Las implementaciones

| Adapter | Implementación | archivo:línea |
|---------|----------------|---------------|
| EVM (Kite ×2, Avalanche ×2, Base ×2 vía `BaseEip3009Adapter`) | `await this.getPublicClient().getChainId()` | `src/chains/base-adapter.ts:284-286` |
| Solana (no-EVM) | `await this._connection.getVersion()` | `src/chains/solana-adapter.ts:378-380` |

**Por qué `getVersion()` para Solana** (justificación pedida, documentada también
en el docstring `solana-adapter.ts:357-377`):

- es el análogo más cercano a `eth_chainId`: el nodo lo contesta desde su propia
  config de build/features → **no lee ledger state**, no toma `commitment`, y no
  puede demorarse por lag de finalidad;
- `getSlot()` sí lee estado y toma commitment: con `'finalized'` la latencia de la
  sonda pasa a depender del consenso — más caro y más ruidoso para un liveness;
- `getLatestBlockhash()` es lo mismo pero con payload mayor: es una llamada para
  **construir transacciones**, no un ping;
- `getGenesisHash()` además fijaría identidad de cluster, pero la corrección de
  cluster ya está garantizada en el money-path por los pins exactos de mint +
  program-id (CD-1 de WKH-205); una sonda de liveness debe seguir siendo un ping.

### 2.3 El consumidor — health sin conocimiento de familias

`src/core/health-status.ts:167-197` (`probeChain`):

- `:177` resuelve por `chainRegistry.getAdapterByNetworkId(meta.networkId)` (clave
  family-agnostic, la misma que usa el registry);
- `:189` `await Promise.race([lookup.adapter.probeRpc(), timeout])` — cero
  referencias a viem / `getPublicClient` / `getChainId` en todo el módulo;
- se mantiene el timeout corto ya existente `RPC_PROBE_TIMEOUT_MS = 1500`
  (`:62`) y el patrón `setTimeout` + `clearTimeout` en `finally` (`:196`), o sea
  que la sonda de liveness **sigue desacoplada de la latencia de las dependencias**
  (restricción del docstring `:38-44`);
- `probeChain` **sigue sin lanzar nunca**: el `catch` (`:192`) cubre rechazo,
  throw sincrónico y adapter sin `probeRpc` (cast inseguro).

### 2.4 Rate-limit: cómo se evitó cambiar "miente en rojo" por "parpadea"

Dato operativo real: `api.devnet.solana.com` rate-limitea agresivo (429 observado
en vivo), y `Connection` **reintenta 429 internamente con backoff**
(`disableRetryOnRateLimit`, `node_modules/@solana/web3.js/lib/index.d.ts:3183`),
así que un 429 llega acá como **timeout de nuestra sonda**, no como error 429.

Decisión (implementada en `health-status.ts:67-84` y `:130-156`, documentada en el
docstring del módulo `:24-36`): **clasificar el fallo y aplicar histéresis sólo a
lo transitorio**.

| Clase | Qué matchea (`TRANSIENT_PROBE_ERROR_RE`, `:83-84`) | Comportamiento |
|-------|---------------------------------------------------|----------------|
| `connection` | todo lo demás: ECONNREFUSED, DNS/TLS, adapter roto | `unreachable` al **primer** fallo (idéntico al comportamiento pre-fix) |
| `transient` | `429`, `too many requests`, `rate limit`, `timeout`/`timed out`/`ETIMEDOUT`, `EAI_AGAIN`, `ECONNRESET`, `socket hang up`, `502/503/504` | se tolera **1** fallo (`TRANSIENT_FAILURE_THRESHOLD = 2`, `:72`); la chain sigue `ok` |

Anti-mentira-en-verde: tolerar **nunca es silencioso**. En un fallo tolerado la
entrada expone los campos **aditivos** `consecutiveFailures` y `lastFailureKind`
(`ChainHealth`, `:92-100`), así que un blip queda visible/grepeable aunque `rpc`
siga `ok`. Una caída real aterriza como `unreachable` en el refresh siguiente
(TTL 5s, `:65`). Cualquier sonda exitosa borra el contador de esa chain (`:190`).

### 2.5 Forma de la respuesta: sólo aditiva

- `HealthStatusDetail` sin cambios: `{degraded, redis, wallet, chains, probedAt}`.
- `ChainHealth`: los 4 campos originales intactos; `consecutiveFailures` y
  `lastFailureKind` son **opcionales y se omiten** en una sonda limpia → el JSON
  del camino feliz queda **byte-idéntico** al de hoy. Fijado por el test HP-8.
- Ni `rpc` ni `degraded` cambiaron de tipo (no se agregó un tercer valor al union,
  justamente para no romper consumidores que hagan switch exhaustivo).

---

## 3. Tests

Nuevo archivo: `src/__tests__/unit/health.probe-non-evm.test.ts` (11 tests).
Cero red: la `Connection` de Solana se inyecta por `opts.connection`
(`solana-adapter.ts:68-69`) y los adapters EVM son fakes locales.

| Test | archivo:línea | Qué fija |
|------|---------------|----------|
| HP-1 | `:159` | el **SolanaAdapter real** se sondea con `getVersion()` y da `ok`; `getTransaction` (money-path) nunca se llama; `'getPublicClient' in adapter === false` |
| HP-2 | `:182` | un adapter no-EVM se sondea **sin** llamar `getPublicClient()`/`getChainId()` (spy tripwire jamás invocado) |
| HP-3 | `:201` | el path EVM sigue igual: las 4 chains EVM de prod dan `ok` y siguen pasando por `getPublicClient().getChainId()` (1 llamada cada uno) |
| HP-3b | `:218` | la implementación EVM **real** (`kiteTestnetAdapter.probeRpc()`) usa el viem public client + `eth_chainId` |
| HP-4 | `:232` | `degraded` es **false** con el set completo de prod sano (4 EVM + Solana), con `wallet.present` y `redis: 'disabled'` verificados como no-degradantes |
| HP-5 | `:254` | `probeChain` **nunca lanza**: adapter que rechaza, que explota sincrónicamente y que no tiene `probeRpc` (cast inseguro) → los 3 `unreachable`, sin excepción escapada |
| HP-6 | `:305` | un 429 aislado **no** voltea la chain (`ok` + `consecutiveFailures: 1` + `lastFailureKind: 'transient'`, `degraded: false`); el **segundo** consecutivo sí (`unreachable`, `degraded: true`) |
| HP-6b | `:331` | una sonda exitosa resetea el contador y **omite** los campos aditivos; un 429 posterior vuelve a contar desde 1 |
| HP-6c | `:358` | un RPC colgado corta por el timeout corto (elapsed < 4s), se clasifica `transient` y el primer timeout se tolera |
| HP-7 | `:384` | error de conexión duro → `unreachable` en la **primera** sonda (sin histéresis) |
| HP-8 | `:405` | forma de respuesta: una chain sana conserva **exactamente** las claves legacy `[chainId, name, network, rpc]` y `HealthStatusDetail` sus 5 claves |

Tests existentes ajustados (los fakes ahora cumplen el contrato en vez de
depender de que el health supiera de viem):

- `src/__tests__/unit/observability.test.ts:185-214` (HS-5) — el fake delega
  `probeRpc` en un `getChainId` que lanza `ECONNREFUSED` (igual que el
  `BaseEip3009Adapter` real);
- `src/__tests__/unit/observability.test.ts:225-250` (HS-6) — ídem con éxito.
  Sin este ajuste HS-6 quedaba rojo, que es exactamente el efecto buscado del
  contrato obligatorio: un adapter sin sonda **no** se reporta sano.

---

## 4. Verificación por mutación (obligatoria)

Mutante aplicado sobre el fix (temporal, revertido después): volver `probeChain` a
la versión EVM-only —
`chainRegistry.getAdapter(meta.chainId)` + `lookup.adapter.getPublicClient().getChainId()`.

```
Failed Tests 7
 FAIL  HP-1 …reported "ok"          → AssertionError: expected 'unreachable' to be 'ok'
 FAIL  HP-2 …WITHOUT getPublicClient → AssertionError: expected 'unreachable' to be 'ok'
 FAIL  HP-4 …degraded is false       → AssertionError: expected false to be true
 FAIL  HP-6  / HP-6b                 → expected 'unreachable' to be 'ok'
 FAIL  HP-6c                         → expected 'connection' to be 'transient'
 FAIL  HP-8                          → expected ['chainId', …(5)] to deeply equal ['chainId','name','network','rpc']
 Test Files  1 failed | 1 passed (2)
      Tests  7 failed | 19 passed (26)
```

- **Resultado**: los 3 tests exigidos (HP-1, HP-2, HP-4) se ponen **ROJOS** con el
  mutante → el fix está realmente fijado por los tests, no por casualidad.
- HP-3 / HP-3b / HP-5 / HP-7 quedan verdes con el mutante, **por diseño**: son
  guards del path EVM y del "nunca lanza", que el mutante no rompe.
- Fix restaurado y verificado post-restauración (`getAdapterByNetworkId` en
  `health-status.ts:177`, `probeRpc()` en `:189`; ningún marcador `MUTANT` quedó
  en el archivo).

---

## 5. Gates

| Gate | Comando | Antes | Después |
|------|---------|-------|---------|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | pass | **pass** (sin output) |
| Build | `npm run build` (`tsc`) | pass | **pass** |
| Lint | `npm run lint` (`eslint src/ --max-warnings 0`) | pass | **pass** (0 warnings) |
| Format | `npm run format:check` (prettier) | pass | **pass** |
| Suite completa | `npm test` (`vitest run`) | **75 files / 1004 tests passed** | **76 files / 1015 tests passed** |

Conteo: +1 archivo, +11 tests, **0 tests perdidos**, 0 skips agregados.

Nota metodológica: `tsconfig.json:20` excluye `**/*.test.ts`, así que ningún gate
del repo typechequea los tests (ver Auto-Blindaje, observación 4). La garantía de
compilación del contrato obligatorio vale para `src/` (los adapters de producción).

---

## 6. Fuera de scope (observado, NO tocado)

`POST /solana/escrow/release` responde **404** en prod (ruta no registrada) y
`POST /solana/sponsor` responde **401** (registrada, exige auth) → faltan
`SOLANA_ESCROW_RELEASE_ENABLED` + `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`.
Tarea del founder; no se tocó nada.

Observación útil que deja este fix: `/health` reporta salud **por chain/RPC**, no
por **ruta/feature-flag**. Un adapter registrado con su ruta opt-in apagada se ve
`rpc: 'ok'` / `degraded: false`, así que el estado "registrado pero ruta apagada"
sigue siendo invisible en `/health`. Propuesta (no implementada) en el
Auto-Blindaje: sección aditiva `details.features` con los flags opt-in resueltos
como booleanos de presencia (nunca valores), al estilo de `wallet.present`.
