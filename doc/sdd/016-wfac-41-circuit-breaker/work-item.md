# Work Item — [WFAC-41] Circuit Breaker per Chain RPC

## Resumen

Proteger el facilitator contra RPCs lentos o caídos agregando un circuit breaker
por cadena. Hoy, cuando un nodo RPC no responde, cada request llama al RPC y
cuelga hasta el timeout de viem (~30 s), acumulando conexiones bloqueadas y
agotando el pool de workers. El circuit breaker interrumpe ese ciclo: después
de `CB_FAILURE_THRESHOLD` fallos en `CB_ROLLING_WINDOW_MS` ms, el breaker se
abre y responde 503 sin tocar el RPC hasta que el `CB_RESET_TIMEOUT_MS` expire
y el primer probe pruebe recuperación.

## Sizing

- SDD_MODE: full
- Estimación: M
- Pipeline: QUALITY (resiliencia crítica, nueva librería, afecta prod reliability)
- Branch sugerido: `feat/016-wfac-41-circuit-breaker`
- Skills: backend-resiliency, platform-infra

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a chain adapter's `verify` or `settle` call results in an RPC
  error and the failure count within `CB_ROLLING_WINDOW_MS` exceeds
  `CB_FAILURE_THRESHOLD`, THEN the system SHALL transition the breaker for that
  chain to OPEN state and SHALL NOT forward subsequent calls to the RPC until
  the OPEN timeout expires.

- **AC-2**: WHILE the circuit breaker for a chain is in OPEN state, the system
  SHALL return immediately with
  `{ ok: false, error: { code: 'CHAIN_UNAVAILABLE', message: 'Chain RPC temporarily unavailable', http: 503 } }`
  without issuing any RPC call to viem.

- **AC-3**: WHEN `CB_RESET_TIMEOUT_MS` elapses after entering OPEN state, the
  system SHALL transition to HALF_OPEN and SHALL allow exactly one probe request
  to reach the RPC.

- **AC-4**: WHEN a probe request in HALF_OPEN state succeeds, the system SHALL
  transition the breaker back to CLOSED state and resume normal request forwarding.

- **AC-5**: WHEN a probe request in HALF_OPEN state fails, the system SHALL
  transition back to OPEN state and restart the `CB_RESET_TIMEOUT_MS` timer.

- **AC-6**: WHILE `CB_ENABLED=false` is set in the environment, the system SHALL
  bypass all circuit breaker logic and forward every call directly to the chain
  adapter with no state transitions or fast-fail behavior.

- **AC-7**: WHEN the circuit breaker for chain A opens, the system SHALL NOT
  affect the circuit breaker state of any other chain (breakers are independent
  per chain adapter instance).

- **AC-8**: WHEN a circuit breaker transitions state (CLOSED→OPEN, OPEN→HALF_OPEN,
  HALF_OPEN→CLOSED, HALF_OPEN→OPEN), the system SHALL emit a structured `warn`
  log entry containing at minimum `chainId`, `fromState`, `toState`, and
  `failureCount` (or `probeResult`).

- **AC-9**: WHEN the `GET /supported` or any administrative endpoint queries
  chain metadata, the system SHALL expose the current circuit breaker state
  (`CLOSED`, `OPEN`, or `HALF_OPEN`) for each registered chain as a field in
  the adapter metadata or via a `/status/circuit-breakers` endpoint
  — exact shape deferred to F2.

- **AC-10**: IF `CB_FAILURE_THRESHOLD`, `CB_RESET_TIMEOUT_MS`, or
  `CB_ROLLING_WINDOW_MS` env vars are set to non-positive integer values, THEN
  the system SHALL fail at startup (Zod parse fails in `parseEnv`) with a
  human-readable error on stderr and exit code 1.

- **AC-11**: WHEN a circuit-breaker 503 response is sent for a `/verify` or
  `/settle` route, the system SHALL include a `Retry-After` header whose value
  is the remaining seconds until the breaker transitions from OPEN to HALF_OPEN,
  rounded up to the nearest integer.

- **AC-12**: WHILE the circuit breaker is in any state, the system SHALL expose
  current failure count, last failure timestamp, and current state via an
  in-process metrics surface (prom-client gauge/enum — exact metric names
  deferred to F2), without requiring an external scraper to query the RPC.

- **AC-13**: WHEN a `verify` or `settle` call returns `ok: false` with code
  `SIMULATION_FAILED` or `TRANSACTION_FAILED` (i.e., the RPC responded but
  returned an error), the system SHALL count that as a failure toward the
  circuit breaker threshold (RPC errors regardless of response content count
  as failures).

---

## Scope IN

- `src/infra/env.ts` — add 4 new env vars to `EnvSchema`:
  `CB_ENABLED`, `CB_FAILURE_THRESHOLD`, `CB_RESET_TIMEOUT_MS`,
  `CB_ROLLING_WINDOW_MS`
- `src/chains/circuit-breaker.ts` (new) — `ChainCircuitBreaker` class wrapping
  a chosen library instance per chain, exposing `execute(fn)`, `getState()`,
  `getMetrics()`. Lives in `src/chains/` per OWNERS boundary (chains/* may
  not import from `src/core/*` runtime, but `src/infra/` is allowed as a
  type-only import).
- `src/chains/kite.ts` — wrap `verify` and `settle` with the circuit breaker
- `src/chains/avalanche.ts` — wrap `verify` and `settle` with the circuit breaker
- `src/chains/types.ts` — optionally extend `ChainAdapter` with
  `getBreakerState?(): BreakerState` (non-breaking optional method, deferred to F2)
- `src/infra/env.ts` — 4 new vars (see above)
- Unit tests: state machine transitions, fast-fail in OPEN, probe in HALF_OPEN,
  independence across chains, `CB_ENABLED=false` bypass, env validation

## Scope OUT

- Retry queue / dead-letter queue (tracked as WFAC-42 BullMQ queue)
- Adaptive thresholds (dynamic adjustment based on latency percentiles)
- Distributed circuit breaker state via Redis (in-process only — single replica
  scope; Redis-backed state deferred to future HU)
- Per-method granularity (circuit breaker is per-chain, not per `verify`/`settle`
  separately)
- Fallback chain routing (if Kite testnet fails, do NOT auto-route to mainnet)
- Bulkhead / thread-pool isolation (out of scope for Node.js single-threaded model)
- Changes to `src/core/errors.ts` or `src/core/types.ts` (see DT-3 for error
  code decision)
- Integration with external APM (DataDog, Sentry) — out of scope for this HU

---

## Decisiones Técnicas

- **DT-1 — Library choice: cockatiel v3.x vs opossum v8.x**

  Both are viable. Decision: **cockatiel** (v3.x).

  Rationale:
  - TypeScript-first with full generic types — no `@types/` overhead.
  - Built-in `ConsecutiveBreaker` and `SamplingBreaker` matching our rolling-window
    requirements without manual wiring.
  - `ExponentialBackoff` policy composable alongside the breaker for HALF_OPEN probe
    scheduling (future-proof for WFAC-42 retry HU).
  - Active maintenance (2024 releases); opossum v8 requires `require()` shim under
    ESM (`"type":"module"` project) and its TS types are community-maintained.
  - `opossum` was excluded: the project is `"type":"module"` (package.json line 5);
    opossum's CJS default export creates ESM interop friction under Node 20 + tsx.

  [NEEDS CLARIFICATION — F2] Architect MUST verify `cockatiel` v3 ESM export
  compatibility with `tsx` watch mode and `vitest` test runner before committing.
  If ESM compat fails, fallback to **custom implementation** (state machine ~80 LOC)
  — NOT opossum. Custom code is simpler than opossum ESM shim.

- **DT-2 — Wrap point: adapter-level vs registry-level**

  Decision: **wrap inside each adapter** (`KiteAdapter.verify/settle`,
  `AvalancheFujiAdapter.verify/settle`), NOT inside `ChainRegistry.getAdapter()`.

  Rationale:
  - Registry wrap would require modifying `ChainRegistry` to understand the breaker
    protocol — couples infrastructure concern into the routing/dispatch layer.
  - Adapter-level wrap keeps the breaker co-located with the RPC call it protects.
    The adapter already owns the viem clients; the breaker belongs next to them.
  - `ChainAdapter` interface remains unchanged for callers — transparent to
    `src/methods/eip3009/settle.ts` and `verify.ts`.
  - Each adapter instance owns one breaker instance → natural per-chain isolation
    (AC-7) without shared mutable state.

- **DT-3 — Error code for circuit open response: Opción B (CHAIN_UNAVAILABLE)**

  Three options were evaluated:
  - **Opción A**: reuse `TRANSACTION_FAILED` with http=503 — rejected: contradicts
    `HTTP_BY_CODE['TRANSACTION_FAILED'] = 500` (compile-time exhaustive Record),
    would require special-casing a canonical mapping.
  - **Opción B**: add `CHAIN_UNAVAILABLE` to `X402ErrorCode` union — selected.
    Justification: the circuit-open condition IS a spec-relevant error (the
    facilitator is declaring "I cannot reach this network right now"), not an
    infrastructure-only error like `RATE_LIMITED`. Adding it to the union extends
    the spec in a defined way and allows `HTTP_BY_CODE` / `DEFAULT_MESSAGE_BY_CODE`
    to be kept exhaustive by the compiler. `CHAIN_UNAVAILABLE → 503`.
  - **Opción C**: literal local in circuit breaker (pattern DT-7 of WFAC-40) —
    rejected: inconsistent with response contract. Routes that receive
    `AdapterResult<T>` today rely on `X402ErrorCode` typing; a literal outside
    the union breaks the typed pipeline.

  Impact: `src/core/types.ts` gains one union member. `src/core/errors.ts`
  `HTTP_BY_CODE` and `DEFAULT_MESSAGE_BY_CODE` gain one entry each. The compiler
  will catch missing coverage.

- **DT-4 — Metrics exposure via prom-client**

  `prom-client` is already in `package.json` (prod dependency). Circuit breaker
  metrics (state, failure count, last failure ts) SHALL be exposed as:
  - `cb_state` — Gauge with labels `chain` and `state` (0=CLOSED, 1=HALF_OPEN, 2=OPEN)
  - `cb_failures_total` — Counter with label `chain`

  Exact metric names and label conventions deferred to Architect (F2).
  No new dependency required.

- **DT-5 — OWNERS boundary for `ChainCircuitBreaker`**

  `src/chains/circuit-breaker.ts` must respect the `src/chains/<chain>.ts` boundary:
  - MAY import: `cockatiel` (or custom state machine), `./types.ts` (sibling).
  - MAY import `src/infra/env.ts` type-only for `EnvConfig` shape (the breaker
    constructor receives thresholds as plain numbers — NOT the full `env` object).
  - MUST NOT import: `src/core/*` runtime, `src/methods/*`, `src/routes/*`,
    `src/infra/logger.ts`.
  - Logger injected by caller (same pattern as `ChainRegistry.setLogger()`).

---

## Constraint Directives

- **CD-1 — OBLIGATORIO wrap both `verify` and `settle`**: the circuit breaker MUST
  wrap both methods in every adapter. Wrapping only `settle` is PROHIBITED.

- **CD-2 — PROHIBIDO cross-chain state contamination**: breaker state for chain A
  MUST NOT affect chain B. Each adapter holds its own `ChainCircuitBreaker`
  instance. Shared singleton breaker is PROHIBITED.

- **CD-3 — OBLIGATORIO `CHAIN_UNAVAILABLE` in `HTTP_BY_CODE` and
  `DEFAULT_MESSAGE_BY_CODE`**: adding the union member without updating both
  Records will fail TypeScript compilation. PROHIBITED to use `as any` or
  `Partial<Record>` to avoid this.

- **CD-4 — PROHIBIDO hardcode thresholds**: all numeric thresholds in adapter
  constructors MUST come from env-validated config (`CB_FAILURE_THRESHOLD`,
  `CB_RESET_TIMEOUT_MS`, `CB_ROLLING_WINDOW_MS`). Magic numbers are PROHIBITED.

- **CD-5 — OBLIGATORIO `Retry-After` header when returning 503**: routes that
  receive `CHAIN_UNAVAILABLE` MUST add `Retry-After` to the response headers
  (AC-11). The value is computed from breaker state at response time.

- **CD-6 — OBLIGATORIO fail-fast on invalid CB env vars**: `parseEnv` MUST reject
  non-positive integers for `CB_FAILURE_THRESHOLD`, `CB_RESET_TIMEOUT_MS`,
  `CB_ROLLING_WINDOW_MS` at startup (AC-10), same pattern as rate-limit vars.

- **CD-7 — PROHIBIDO `CB_ENABLED=false` side-effects**: when disabled, the adapter
  MUST call the original viem-backed method unmodified. No logging, no state
  tracking, no metric increments.

- **CD-8 — OBLIGATORIO `CB_ENABLED` boolean transform**: use
  `.enum(['true','false']).transform(v => v === 'true')` pattern (same as
  `RATE_LIMIT_ENABLED` in WFAC-40 CD-12). `z.coerce.boolean()` is PROHIBITED.

- **CD-9 — OWNERS boundary respected**: `src/chains/circuit-breaker.ts` MUST NOT
  import `src/core/*` at runtime (except type-only imports). Violation = AR BLOQUEANTE.

---

## Waves

- **Wave 1 — Env vars + `CHAIN_UNAVAILABLE` error code**:
  Extend `EnvSchema` with the 4 CB vars. Add `CHAIN_UNAVAILABLE` to
  `X402ErrorCode`, `HTTP_BY_CODE` (503), and `DEFAULT_MESSAGE_BY_CODE`.
  Tests: env parsing valid/invalid, error code exhaustiveness.

- **Wave 2 — `ChainCircuitBreaker` class**:
  Implement `src/chains/circuit-breaker.ts` wrapping cockatiel (or custom state
  machine). State machine: CLOSED→OPEN after threshold, OPEN→HALF_OPEN after
  timeout, HALF_OPEN→CLOSED/OPEN on probe result. Constructor accepts thresholds
  as numbers + optional logger. `execute(fn)` intercepts failures. `getState()`
  returns `BreakerState`. Tests: full state machine transitions, independence
  across two instances, `execute` fast-fail in OPEN, `execute` probe in HALF_OPEN.

- **Wave 3 — Adapter integration**:
  Wrap `verify` and `settle` in `KiteAdapter` and `AvalancheFujiAdapter` using
  the breaker. Inject thresholds from env at adapter construction. Tests: adapter
  returns `CHAIN_UNAVAILABLE` 503 when breaker OPEN, breaker recovers on success.

- **Wave 4 — Route layer + Retry-After + metrics**:
  Routes (`/verify`, `/settle`) detect `CHAIN_UNAVAILABLE` in `AdapterResult` and
  add `Retry-After` header. Register prom-client gauges/counters via breaker
  callbacks. Log state transitions (AC-8). Integration test: request in OPEN state
  → HTTP 503 with `Retry-After` header.

---

## Missing Inputs

- **[NEEDS CLARIFICATION — F2, DT-1]** ESM compatibility of `cockatiel` v3 with
  `tsx` and `vitest`. Architect must verify or fall back to custom state machine.
  This is the only external blocker before implementation.
- **[NEEDS CLARIFICATION — F2, AC-9]** Exact shape of circuit breaker state in
  `/supported` response or new `/status/circuit-breakers` endpoint. Does the
  x402 spec allow extending the `GET /supported` response body?
- **[RESUELTO — DT-3]** Error code for 503 response: `CHAIN_UNAVAILABLE` added to
  `X402ErrorCode` union (Opción B).
- **[RESUELTO — DT-2]** Wrap point: adapter-level (inside each adapter class).
- **[RESUELTO — DT-1]** Library: cockatiel v3 (with ESM-compat caveat in F2).

---

## Análisis de paralelismo

- WFAC-41 depends on WFAC-40 (rate limiting) being stable — both touch `src/infra/env.ts`.
  WFAC-40 must merge before WFAC-41 branches from main to avoid `EnvSchema` conflicts.
- WFAC-41 does NOT block WFAC-42 (BullMQ retry queue) — they are complementary.
  WFAC-42 handles retry-after-failure; WFAC-41 handles fail-fast-while-failing.
  They can be designed in parallel but WFAC-41 should merge first (WFAC-42 may
  want to react to `CHAIN_UNAVAILABLE` code).
- WFAC-41 does NOT block WFAC-52 (Avalanche Fuji real settle) — the CB wrapping
  stubs is valid (stubs return `NETWORK_MISMATCH`, which will NOT be counted as
  CB failures — see AC-13 scope: only `SIMULATION_FAILED` / `TRANSACTION_FAILED`
  trigger the counter).
- Can go in parallel with any HU that does not touch `src/chains/kite.ts`,
  `src/chains/avalanche.ts`, `src/infra/env.ts`, or `src/core/types.ts`.
