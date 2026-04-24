# Work Item — [WFAC-50] Kite Testnet Adapter REAL (MVP chain)

## Resumen

Reemplazar los stubs de `_verifyRaw` y `_settleRaw` en `src/chains/kite.ts` por
implementaciones funcionales que llamen contratos on-chain en Kite Testnet (chainId
2368) usando viem. Incluye: recuperación real de firma EIP-712 via `recoverTypedDataAddress`,
balance check via `balanceOf`, simulate-before-write, `waitForTransactionReceipt` con timeout
de 60 s, y wallet operator real via `OPERATOR_PRIVATE_KEY`. También requiere crear
`src/infra/wallet.ts` (singleton de wallet client por chain) y un ABI local en
`src/chains/abi/fiat-token.ts` (por boundary OWNERS.md — kite.ts no puede importar
de `src/methods/*`).

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L
- **Pipeline**: QUALITY
- **Branch sugerido**: `feat/017-wfac-50-kite-testnet-adapter`

Justificación L: conecta a RPC real on-chain, maneja private key de operador,
incluye múltiples caminos de error (sig inválida, balance insuficiente, simulación
fallida, timeout de receipt, revert), requiere crear infra/wallet.ts desde cero,
y exige tests con viem mock (no RPC real en CI).

---

## Acceptance Criteria (EARS)

### Verify — Happy Path

- **AC-1**: WHEN `_verifyRaw` receives a well-formed VerifyParams with a valid
  EIP-712 signature over the correct domain (token address = KITE_USDC_ADDRESS,
  chainId = 2368), THEN the system SHALL return `{ ok: true, verified: true }`
  with `client` equal to the recovered signer address.

- **AC-2**: WHEN `_verifyRaw` calls `recoverTypedDataAddress`, the system SHALL
  first normalize the raw signature via `normalizeSignature` (existing utility in
  `src/methods/eip3009/signature.ts`) and reconstruct the canonical 65-byte hex
  before passing it to viem, matching the pattern already established in
  `src/methods/eip3009/verify.ts`.

### Verify — Error Paths

- **AC-3**: WHEN `_verifyRaw` receives a signature whose recovered address does
  not equal `authorization.from`, the system SHALL return
  `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }`.

- **AC-4**: WHEN `_verifyRaw` receives a signature whose `validBefore` timestamp
  is less than or equal to the current Unix time in seconds, the system SHALL
  return `{ ok: false, error: { code: 'EXPIRED_AUTHORIZATION', http: 400 } }`.

- **AC-5**: WHEN `_verifyRaw` receives a VerifyParams where `authorization.value`
  is strictly less than `accepted.amount`, the system SHALL return
  `{ ok: false, error: { code: 'INVALID_AMOUNT', http: 400 } }`.

- **AC-6**: IF `normalizeSignature` returns `{ ok: false }` for any reason
  (high-s, zero scalar, invalid length), THEN `_verifyRaw` SHALL return
  `{ ok: false, error: { code: 'INVALID_SIGNATURE', http: 401 } }` without
  calling `recoverTypedDataAddress`.

### Settle — Happy Path

- **AC-7**: WHEN `_settleRaw` is called with valid VerifyParams that pass
  `verifyEip3009` off-chain check, THEN the system SHALL call
  `publicClient.simulateContract` with `FIAT_TOKEN_ABI.transferWithAuthorization`,
  then `walletClient.writeContract(sim.request)`, then
  `publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })`,
  and return `{ ok: true, settled: true, transactionHash, blockNumber, amount, from, to, asset }`.

- **AC-8**: WHEN the wallet client is initialized for settlement, the system SHALL
  use `privateKeyToAccount(OPERATOR_PRIVATE_KEY)` from viem to create the account,
  loaded from `src/infra/wallet.ts` (new singleton), so that `walletClient.account`
  is always defined before calling `writeContract`.

- **AC-9**: WHEN `_settleRaw` completes a settlement successfully, the returned
  `SettleResult` SHALL contain `transactionHash` as a `0x${string}` returned by
  `writeContract` and `blockNumber` as `Number(receipt.blockNumber)`.

### Settle — Error Paths

- **AC-10**: WHEN `publicClient.simulateContract` throws for any reason (gas
  estimation failure, contract revert on dry-run, RPC error), the system SHALL
  return `{ ok: false, error: { code: 'SIMULATION_FAILED', http: 500 } }` with a
  sanitized error message (max 200 chars, no raw stack traces).

- **AC-11**: WHEN `walletClient.writeContract` throws after a successful simulation,
  the system SHALL return `{ ok: false, error: { code: 'TRANSACTION_FAILED', http: 500 } }`.

- **AC-12**: WHEN `waitForTransactionReceipt` throws a `WaitForTransactionReceiptTimeoutError`,
  the system SHALL return `{ ok: false, error: { code: 'TRANSACTION_FAILED',
  message: 'receipt timeout', http: 500 } }` — using the literal string
  `'receipt timeout'` as the message to match the existing pattern in
  `src/methods/eip3009/settle.ts`.

- **AC-13**: WHEN `receipt.status === 'reverted'`, the system SHALL return
  `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: 'transaction reverted on-chain', http: 500 } }`.

### Circuit Breaker Compatibility

- **AC-14**: WHILE the `KiteAdapter` circuit breaker is in OPEN state, the system
  SHALL return `{ ok: false, error: { code: 'CHAIN_UNAVAILABLE', http: 503,
  retryAfterMs: <remaining_ms> } }` from both `verify()` and `settle()` public
  methods, without invoking `_verifyRaw` or `_settleRaw`.

- **AC-15**: WHEN `_settleRaw` returns `{ ok: false, error: { code: 'SIMULATION_FAILED' } }`
  or `{ ok: false, error: { code: 'TRANSACTION_FAILED' } }`, the system SHALL
  count this as exactly one breaker failure via the `BusinessFailureError` throw
  pattern already established in `src/chains/kite.ts` (WFAC-41, AR-BLQ-ALTO-1 fix).

### Env Var Validation

- **AC-16**: WHEN the service starts and `OPERATOR_PRIVATE_KEY` is missing or empty,
  the system SHALL throw a `ChainAdapterInitError` (or equivalent startup error)
  BEFORE any request is processed, printing the missing var name to stderr.

- **AC-17**: WHEN the service starts and `KITE_USDC_ADDRESS` is missing or empty,
  the system SHALL throw a `ChainAdapterInitError` BEFORE any request is processed,
  with the env var name included in the error message.

### Token Registry

- **AC-18**: WHEN `kiteTestnetAdapter.metadata.tokens` is read after initialization,
  the system SHALL contain exactly one `EIP3009Token` entry with `address`
  equal to the value of `KITE_USDC_ADDRESS`, `symbol: 'USDC'`, `decimals: 6`,
  `eip712Name: 'USD Coin'`, `eip712Version: '2'`.

### Test Environment

- **AC-19**: WHILE `NODE_ENV === 'test'`, the system SHALL NOT make any real RPC calls
  to `https://rpc-testnet.gokite.ai` — all viem client calls SHALL be interceptable
  via vitest mock/spy on the `PublicClient` and `WalletClient` instances.

---

## Scope IN

| Artefacto | Acción |
|-----------|--------|
| `src/chains/kite.ts` | Reemplazar `_verifyRaw` y `_settleRaw` stubs con implementaciones reales; inyectar wallet account desde `src/infra/wallet.ts`; leer `KITE_USDC_ADDRESS` en constructor; poblar `metadata.tokens` |
| `src/chains/abi/fiat-token.ts` | Crear — ABI local para `transferWithAuthorization` + `balanceOf` (copia estructural de `src/methods/eip3009/abi.ts` limitada a los selectors necesarios, necesaria por boundary OWNERS.md) |
| `src/infra/wallet.ts` | Crear — singleton `getOperatorAccount(privateKey)` usando `privateKeyToAccount` de viem; NO un per-chain client, sino el account que cualquier chain adapter puede inyectar |
| `src/infra/env.ts` | Agregar `KITE_USDC_ADDRESS` y `OPERATOR_PRIVATE_KEY` al `EnvSchema` Zod con validaciones apropiadas (ambos requeridos en non-test) |
| `src/__tests__/unit/kite.test.ts` | Crear — tests unitarios con publicClient/walletClient mockeados (vitest vi.fn()); cobertura mínima: AC-1, AC-3, AC-4, AC-5, AC-7, AC-10, AC-12, AC-13, AC-15 |
| `.env.example` | Agregar `KITE_USDC_ADDRESS=0x...` con comentario indicando que requiere el address real de PYUSD/USDC en Kite Testnet |

---

## Scope OUT

| Fuera de scope | Razón |
|----------------|-------|
| `src/chains/avalanche.ts` — implementación real | HU separada (WFAC-52), stub se mantiene |
| Kite Mainnet (`chainId 2366`) | Riesgo mainnet — HU separada cuando testnet esté validada |
| Balance check via `balanceOf` | [NEEDS CLARIFICATION] — el AC no fue solicitado explícitamente; `simulateContract` ya detectará balance insuficiente; agregar un pre-check es mejora de DX pero no bloqueante |
| BullMQ retry queue integration | WFAC-42 — ya trackeado, esta HU no introduce cola |
| `src/infra/metrics.ts` — nuevas métricas de on-chain latency | Out of scope WFAC-50; puede ser WFAC-55 |
| Production env vars configurados en Railway | Ops task, no código |
| Smoke test contra testnet real en CI | CI no tiene acceso a testnet RPC; tests unitarios con mock son suficientes para F4 |
| `KITE_FACILITATOR_PRIVATE_KEY` como env var separada | El proyecto ya tiene `OPERATOR_PRIVATE_KEY` como nombre canónico (ver `.env.example`); usar el mismo nombre para no crear duplicados |

---

## Decisiones técnicas (DT-N)

- **DT-1 — ABI duplication por boundary**: `src/chains/kite.ts` no puede importar
  de `src/methods/eip3009/abi.ts` (OWNERS.md: chains cannot import methods).
  Solución: crear `src/chains/abi/fiat-token.ts` con el mismo `FIAT_TOKEN_ABI`
  y `RECEIPT_TIMEOUT_MS`. Este es el único lugar donde se permiten definiciones
  duplicadas y debe documentarse como TD. Alternativa rechazada: mover el ABI a
  `src/chains/abi/` y hacer que `src/methods/eip3009/abi.ts` reexporte desde allí
  — viable pero requiere refactor en HU separada (mayor scope).

- **DT-2 — wallet.ts como account factory, no client**: `src/infra/wallet.ts` expone
  `getOperatorAccount(privateKey): Account` usando `privateKeyToAccount`. Cada chain
  adapter crea su propio `WalletClient` con `chain` propio e inyecta el account.
  No centralizar el client porque cada chain necesita su propio `chain` definition.
  Esto resuelve los TODO `WFAC-wallet-singleton` en kite.ts y avalanche.ts.

- **DT-3 — verifyEip3009 reutilización**: `_verifyRaw` en kite.ts puede invocar
  directamente `verifyEip3009` de `src/methods/eip3009/verify.ts` — pero eso viola
  OWNERS.md (`chains` no puede importar de `methods`). La verificación off-chain
  debe reimplementarse inline en kite.ts (solo los checks que necesita verify),
  o el adapter puede delegar toda la lógica de verify al método ya existente usando
  el patrón del core. [NEEDS CLARIFICATION por Architect en F2] — el SDD debe
  proponer si `_verifyRaw` llama internamente a `verifyEip3009` via violación
  justificada, o si kite.ts solo hace `recoverTypedDataAddress` + checks mínimos
  (dejando la validación completa al core que ya llama `verifyEip3009` antes de
  llegar al adapter).

- **DT-4 — settleEip3009 reutilización**: Existe `settleEip3009` en
  `src/methods/eip3009/settle.ts` que ya implementa el flujo completo
  (simulate → write → receipt). Por la misma restricción de OWNERS.md, `_settleRaw`
  no puede importarlo. Solución: `_settleRaw` recibe los clientes ya construidos
  y llama directamente a viem — duplicando la lógica de `settleEip3009`. El Architect
  debe evaluar si esto es aceptable (duplicación controlada) o requiere refactor
  del boundary. [NEEDS CLARIFICATION en F2]

- **DT-5 — OPERATOR_PRIVATE_KEY en env.ts**: agregar al `EnvSchema` Zod con
  `z.string().regex(/^0x[0-9a-fA-F]{64}$/)` para validar formato de private key
  al inicio. En `NODE_ENV === 'test'` la validación debe ser `.optional()` para
  que los tests no requieran una clave real. Misma lógica que `REDIS_URL` (superRefine).

- **DT-6 — KITE_USDC_ADDRESS env vs hardcode**: A diferencia de Avalanche Fuji donde
  USDC address es pública y estable (hardcodeada en avalanche.ts como `USDC_FUJI`),
  Kite Testnet es un testnet con potencial de redeployment del token. La HU input
  especifica env var `KITE_USDC_ADDRESS`. Se mantiene como env var por flexibilidad.
  Añadir `z.string().regex(/^0x[0-9a-fA-F]{40}$/)` en EnvSchema.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO logear `OPERATOR_PRIVATE_KEY` en cualquier nivel de log
  (debug, trace, o error). El sanitize de errores DEBE usar la función `sanitize()`
  que trunca a 200 chars sin key materials.

- **CD-2**: PROHIBIDO usar la dirección del token (`KITE_USDC_ADDRESS`) hardcodeada
  en `kite.ts`. Siempre desde `process.env.KITE_USDC_ADDRESS` via `EnvSchema`.

- **CD-3**: OBLIGATORIO que los tests unitarios usen `vi.fn()` / `vi.spyOn()` para
  mockear `publicClient.simulateContract`, `publicClient.waitForTransactionReceipt`
  y `walletClient.writeContract`. PROHIBIDO hacer calls reales al RPC en tests que
  corren en CI (`NODE_ENV=test`).

- **CD-4**: OBLIGATORIO que `_settleRaw` llame `simulateContract` ANTES de `writeContract`.
  Cualquier path que llame `writeContract` sin simulación previa es BLOQUEANTE en AR.

- **CD-5**: PROHIBIDO usar `z.coerce.boolean()` en `EnvSchema` para nuevas vars
  (patrón prohibido existente, CD-12 de WFAC-40 — usar `z.enum(['true','false']).transform()`).

- **CD-6**: OBLIGATORIO que el `SettleResult.transactionHash` sea el hash retornado
  directamente por `writeContract` — no reconstruido ni derivado de otro campo.

- **CD-7**: OBLIGATORIO que los boundaries de OWNERS.md se mantengan. Si el Architect
  determina en F2 que la solución requiere cruzar un boundary, DEBE documentarlo como
  excepción explícita con número `[N]` en OWNERS.md antes del merge.

---

## Waves (referencia para Architect / Dev)

| Wave | Entregables |
|------|-------------|
| **W0** | `src/chains/abi/fiat-token.ts` (ABI local con `transferWithAuthorization` + `balanceOf`) + `src/infra/wallet.ts` (account factory) + `src/infra/env.ts` (agregar `OPERATOR_PRIVATE_KEY` + `KITE_USDC_ADDRESS`) + `.env.example` actualizado |
| **W1** | `src/chains/kite.ts` — implementar `_verifyRaw` real (EIP-712 recover + checks mínimos). Tests: AC-1, AC-3, AC-4, AC-5, AC-6 |
| **W2** | `src/chains/kite.ts` — implementar `_settleRaw` real (simulate → write → receipt). Tests: AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13 |
| **W3** | Tests restantes (AC-14, AC-15, AC-16, AC-17, AC-18, AC-19). `.env.example` verificado. Build limpio. |

---

## Missing Inputs

| Item | Tipo | Estado |
|------|------|--------|
| Address real del token PYUSD/USDC en Kite Testnet (`KITE_USDC_ADDRESS`) | Bloqueante para smoke test real; no bloqueante para CI con mock | [NEEDS CLARIFICATION — confirmar dirección en testnet antes de F3] |
| Decisión DT-3 / DT-4: ¿El adapter puede llamar `verifyEip3009` / `settleEip3009` de `src/methods/`? | Arquitectónico | [Resuelto en F2 por Architect — evaluar boundary exception o reimplementación inline] |
| Confirmar si `balanceOf` check pre-settle es requerido o es scope-out | Funcional | [NEEDS CLARIFICATION — marcado Scope OUT por ahora; si el humano lo requiere se agrega AC-20] |

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs conocidas (WFAC-52 Avalanche real es independiente).
- `src/infra/wallet.ts` creado en W0 desbloquea WFAC-52 (Avalanche también tiene
  el mismo TODO `WFAC-wallet-singleton`).
- WFAC-41 (016, circuit breaker) está marcado `in progress` en `_INDEX.md` —
  confirmar que está merged antes de iniciar F3. Si aún no está en main, esta HU
  depende de esa rama.
