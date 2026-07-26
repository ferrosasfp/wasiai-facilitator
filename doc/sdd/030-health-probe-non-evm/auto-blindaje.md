# Auto-Blindaje — 030 · sonda de health no-EVM (`fix/health-probe-non-evm`)

Registro de errores cometidos/encontrados durante F3 y cómo blindarlos. NO es
opcional: es lo que protege a las próximas HUs del mismo error.

---

### [2026-07-26] Wave 0 — El módulo de health sabía de familias de chains (el bug original)

- **Error**: `src/core/health-status.ts#probeChain` sondeaba **todos** los adapters
  registrados con dos llamadas viem/EVM (`getPublicClient().getChainId()`) y
  resolvía el adapter por chainId numérico (`chainRegistry.getAdapter(meta.chainId)`,
  que sólo busca la clave `eip155:<id>`). El adapter Solana es no-EVM por diseño
  (clave `solana:<cluster>`, sin viem client, docstring `solana-adapter.ts:6`), así
  que **fallaba por construcción** en los DOS puntos: no se encontraba en el
  registry y, si se hubiera encontrado, no tiene `getPublicClient`.
- **Impacto medido en prod** (`GET /health` de wasiai-facilitator-production):
  `degraded: true` permanente — 5 chains EVM `ok` + `103 Solana Devnet` →
  `rpc: 'unreachable'`. Un health siempre rojo entrena al equipo a ignorarlo, así
  que el día que se caiga algo real nadie lo ve.
- **Causa raíz**: el conocimiento de "cómo se sondea una chain" vivía en el
  consumidor (health) en vez del dueño (el adapter). Cuando WKH-205 agregó el
  primer rail no-EVM, el contrato `SettlementAdapter` no obligaba a nada, así que
  el adapter nuevo quedó mal sondeado **en silencio** (compiló perfecto).
- **Fix**: `probeRpc(): Promise<void>` **obligatorio** en `SettlementAdapter`
  (`src/chains/types.ts:141-162`), implementado por cada adapter
  (`src/chains/base-adapter.ts:271-286` EVM `eth_chainId`,
  `src/chains/solana-adapter.ts:357-380` `getVersion`), y `probeChain` resuelve
  por `metadata.networkId` y sólo llama `adapter.probeRpc()`
  (`src/core/health-status.ts:167-197`, lookup en `:177`, sonda en `:189`). El
  health ya no menciona viem ni familias de chains.
- **Aplicar en**: cualquier módulo transversal que itere `chainRegistry.listAdapters()`
  y después haga algo EVM-específico. Los sospechosos vivos hoy:
  `src/chains/init-domain-check.ts:41` (recibe `ChainAdapter` y hace `readContract`)
  y `src/core/supported.ts`. **Regla**: si un consumidor necesita comportamiento
  por-chain, se agrega un método REQUERIDO al contrato del adapter; nunca un `if`
  por familia ni un método opcional (`probeRpc?()`), porque lo opcional se olvida
  sin romper el build.

---

### [2026-07-26] Wave 2 — Curar un health que miente en rojo con uno que parpadea

- **Error potencial** (evitado, no cometido): la versión ingenua del fix marcaba
  `unreachable` al primer fallo de sonda. El RPC público de Solana devnet
  (`api.devnet.solana.com`) rate-limitea agresivo (429 verificado en vivo pidiendo
  airdrops) y `Connection` **reintenta 429 internamente** con backoff
  (`disableRetryOnRateLimit`, `@solana/web3.js/lib/index.d.ts:3183`), así que un
  429 se manifiesta acá como timeout de nuestra sonda. Con refresh cada 5s eso
  hace flapear `degraded` — el mismo problema con otro signo.
- **Fix**: clasificación + histéresis en `src/core/health-status.ts:67-84`
  (umbral + regex) y `:130-156` (contadores + `reportFailure`):
  - `'connection'` (ECONNREFUSED / DNS / TLS / adapter roto) → `unreachable` al
    PRIMER fallo (comportamiento igual al de antes).
  - `'transient'` (429 / rate limit / timeout / 502-504 / socket reset) → se
    tolera 1 fallo (`TRANSIENT_FAILURE_THRESHOLD = 2`); la chain sigue `ok` pero
    los campos **aditivos** `consecutiveFailures` + `lastFailureKind` exponen el
    blip, así que tolerar nunca es silencioso. Una caída real igual aterriza como
    `unreachable` al refresh siguiente (~1 TTL = 5s).
  - Cualquier sonda exitosa resetea el contador de esa chain.
- **Aplicar en**: cualquier señal binaria derivada de una dependencia remota con
  rate-limit. Tolerar sin exponer el contador es la trampa: quedás con un health
  que miente en verde. Exponer y tolerar es lo aceptable.

---

### [2026-07-26] Wave 3 — `it(name, fn, opts)` fue removido en vitest 4

- **Error**: escribí el test del timeout con `it('...', async () => {...}, { timeout: 10_000 })`
  y el archivo entero falló al cargar: *"Signature `test(name, fn, {...})` was
  deprecated in Vitest 3 and removed in Vitest 4"*. 0 tests corridos (falso verde
  peligroso si sólo se mira "no hay fallos rojos" en un grep).
- **Causa raíz**: asumí la firma de vitest 2/3 sin verificar la versión instalada
  (`vitest ^4.1.8`, `package.json`).
- **Fix**: opciones como SEGUNDO argumento — `it('...', { timeout: 10_000 }, fn)`
  (`src/__tests__/unit/health.probe-non-evm.test.ts:357-360`).
- **Aplicar en**: cualquier test nuevo que necesite `timeout`/`retry`/`skip` por
  test en este repo. Y regla general: un "Failed Suites" con `(0 test)` **no** es
  un pass; hay que leer el conteo de tests, no sólo buscar `FAIL`.

---

### [2026-07-26] Observación — `tsc --noEmit` NO typechequea los tests de este repo

- **Hallazgo**: `tsconfig.json:16` tiene `"exclude": ["node_modules", "dist", "**/*.test.ts"]`
  y eslint corre sin `project` (config sin type-aware rules, `eslint.config.js`).
  Vitest transpila con esbuild (sin chequeo de tipos). Consecuencia: **ningún gate
  del repo typechequea `src/__tests__/`**.
- **Por qué importa acá**: la garantía "si `probeRpc` es obligatorio en el tipo, no
  compila sin él" es real para `src/` (los adapters de producción) pero **no** para
  los fakes de test. Hay ~16 factories `(): ChainAdapter` en tests que hoy no
  implementan `probeRpc` y nadie se queja. Se detectan en runtime igual: la sonda
  los reporta `unreachable` (fue exactamente lo que rompió HS-6 en
  `observability.test.ts`, y por eso ese fake se actualizó).
- **Aplicar en**: no confiar en "compile-time assertions" escritas dentro de tests
  (ej. `core.settle.test.ts:428` `const verifyOnly: SettlementAdapter = {...}`):
  ningún gate las verifica. Si se quiere esa garantía, el assert de tipos tiene que
  vivir en un archivo de `src/` incluido en el typecheck (o habilitar
  `vitest --typecheck`, TD aparte).

---

### [2026-07-26] Observación operativa (NO tocado — tarea del founder)

- `POST /solana/escrow/release` devuelve **404** en prod (ruta no registrada)
  mientras `POST /solana/sponsor` devuelve **401** (registrada, pide auth) →
  faltan `SOLANA_ESCROW_RELEASE_ENABLED` + `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`.
- **Lo que este fix NO cubre**: el health reporta salud **por chain/RPC**
  (`ChainHealth`), no por **ruta/feature-flag**. Un adapter registrado con su ruta
  opt-in apagada se ve `rpc: 'ok'` y `degraded: false` — o sea que el estado
  "registrado pero ruta apagada" sigue siendo **invisible** en `/health` y sólo se
  descubre haciendo un POST y mirando 404-vs-401.
- **Gap propuesto (no implementado, fuera de scope)**: una sección aditiva
  `details.features` con los flags opt-in resueltos (`escrowRelease`, `sponsor`,
  `solana`) como booleanos SET/NOT-SET — sin valores, sólo presencia, igual que
  `wallet.present`. Es la única forma de que un `/health` verde signifique "las
  rutas que creés prendidas están prendidas".
