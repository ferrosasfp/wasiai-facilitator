# Work Item — [WFAC-53] Post-review hardening (multi-chain, multi-consumer)

## Resumen

Incorporar 6 fixes surgidos de un code review externo sobre el facilitator, que
opera en 4 chains (Kite testnet 2368, Kite mainnet 2366, Avalanche Fuji 43113,
Avalanche mainnet 43114) y sirve a 2 consumers (wasiai-v2 marketplace,
wasiai-a2a orchestrator). El baseline post-PR-#34 es 553/553 tests en verde.
Los fixes abordan seguridad (CORS restringido, domain-separator assertion en
boot, fail-mode configurable), deuda de lint (5 eslint-disable), y documentación
de security (SECURITY.md append). FIX-5 (Dependabot PR #10) es acción externa,
sin commit local.

## Sizing

- **SDD_MODE**: full
- **Estimación**: L
- **Categoría de riesgo**: ALTA — toca boot logic, multi-chain, security path
- **Smart Sizing**: QUALITY (security path + multi-chain + 553-test baseline a preservar)
- **Branch sugerido**: `fix/wfac-53-post-review-hardening`
- **Base commit**: `d6ccd5f` (main, PR #34 merged)

---

## Contexto del code review

PR #34 (mainnet adapters Kite+Avalanche) fue mergeado a main en `d6ccd5f`.
Un code review externo identificó 6 issues de seguridad y calidad. Esta HU
los resuelve de forma secuencial en 6 commits (1 por FIX, FIX-5 sin commit
local). Los 4 chains activos comparten el mismo token contract Circle
FiatTokenV2 (PYUSD/USDC/USDC.e), lo que hace el domain-separator check
aplicable y crítico en todos ellos.

---

## Acceptance Criteria (EARS)

### FIX-1 — CORS_ALLOWED_ORIGINS cableado

- **AC-1**: WHEN `CORS_ALLOWED_ORIGINS` is a non-empty comma-separated string
  in `EnvSchema`, the system SHALL configure `@fastify/cors` with a callback
  that returns `true` only for origins in the parsed list, and `false` with
  HTTP 403 for any origin not in the list.

- **AC-2**: WHEN `CORS_ALLOWED_ORIGINS` is absent or empty string, the system
  SHALL configure `@fastify/cors` with `origin: true` (reflect any origin),
  preserving the current development behavior without breaking change.

- **AC-3**: WHEN the CORS unit test suite runs (`app.cors.test.ts`), the system
  SHALL PASS 3 cases: (a) whitelisted origin allowed, (b) non-whitelisted origin
  blocked, (c) empty env var falls back to `origin: true`.

### FIX-2 — Domain separator assertion per-chain at boot

- **AC-4**: WHEN the service boots and a chain's RPC is reachable, the system
  SHALL call `DOMAIN_SEPARATOR()` on the token contract for each of the 4 enabled
  chains and compare the on-chain value against the locally computed EIP-712
  domain separator; IF they do not match, the system SHALL log a FATAL error and
  `process.exit(1)`.

- **AC-5**: IF a chain's RPC is unreachable or times out during the domain
  separator check, the system SHALL log a WARN (not fatal) and allow boot to
  continue (non-blocking check).

- **AC-6**: WHEN `DOMAIN_SEPARATOR()` is added to `FIAT_TOKEN_ABI` in
  `src/chains/abi/fiat-token.ts`, the system SHALL replicate the identical
  function entry in `src/methods/eip3009/abi.ts` in the same commit so that
  test `T-SDD-1-ABI-SYNC` continues to PASS.

- **AC-7**: WHEN the Kite domain-separator test suite runs
  (`chains.kite.domain-check.test.ts`), the system SHALL PASS 3 cases:
  (a) match → boot continues, (b) mismatch → fatal exit called, (c) RPC
  failure → warn logged, boot continues.

- **AC-8**: WHEN the Avalanche domain-separator test suite runs
  (`chains.avalanche.domain-check.test.ts`), the system SHALL PASS 3 cases
  with identical semantics to AC-7.

### FIX-3 — SECURITY.md append

- **AC-9**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit,
  the file SHALL contain a "Failure Modes" section documenting: (a) Redis outage
  causes rate-limit bypass (`skipOnError:true`), (b) Redis outage causes
  SETTLE_DAILY_GLOBAL_CAP fail-open (reference FIX-6 env var), (c) domain
  separator drift mitigated by FIX-2 boot check.

- **AC-10**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit,
  the existing "Operator Wallet" section SHALL be extended to include: (a) note
  that V1 uses a single hot key per chain, (b) V2 recommendation to use separate
  keys per chain, (c) list of env vars that MUST NOT be logged
  (`OPERATOR_PRIVATE_KEY`, `SUPABASE_SERVICE_KEY`).

- **AC-11**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit,
  the file SHALL contain a "Reporting" section with a security disclosure email
  address and SLA timeframe for acknowledgement. [NEEDS CLARIFICATION: exact
  email address and SLA values — use placeholder `security@wasiai.io` / 48h
  acknowledgement unless overridden by operator]

### FIX-4 — Remove eslint-disable security/detect-object-injection

- **AC-12**: WHEN `npm run lint` is executed after this commit, the system SHALL
  exit 0 with 0 instances of `eslint-disable security/detect-object-injection`
  in the following 5 locations: `src/chains/avalanche.ts:105` (readRpcUrl),
  `src/chains/avalanche.ts:120` (readEnabledFlag), `src/chains/kite.ts:69`
  (readEnv), `src/chains/kite.ts:587` (readUsdcAddress), `src/chains/kite.ts:603`
  (readEnabledFlag); each location replaced with a switch/ternary over literal
  env-var names.

- **AC-13**: WHILE FIX-4 is applied, the system SHALL continue to PASS all 553
  baseline tests without modification to test files.

### FIX-5 — Dependabot PR #10 merge (external action)

- **AC-14**: WHEN Dependabot PR #10 (`actions/upload-artifact` 4→7) CI is green,
  the system SHALL merge PR #10 into main without a local commit (GitHub UI
  merge). Dependabot PRs #3–#7 (runtime major bumps) SHALL receive a comment
  "Holding until manual smoke test" and remain open.

### FIX-6 — SETTLE_CAP_FAIL_MODE configurable

- **AC-15**: WHEN `SETTLE_CAP_FAIL_MODE=closed` is set, the system SHALL return
  HTTP 503 with error body `{ error: { code: 'SERVICE_UNAVAILABLE', message:
  'Settlement cap check failed — service unavailable', http: 503 } }` if the
  Redis `incr` call in `incrementAndCheckDailyCap` throws, instead of the
  current fail-open behavior.

- **AC-16**: WHEN `SETTLE_CAP_FAIL_MODE` is absent or set to `open`, the system
  SHALL preserve the existing fail-open behavior (request allowed through on
  Redis error), maintaining backward compatibility.

- **AC-17**: WHEN the settle-cap unit test suite runs
  (`core.settle-cap.test.ts`), the system SHALL PASS 2 new cases: (a)
  `SETTLE_CAP_FAIL_MODE=closed` + Redis error → returns `{ ok: false }` with
  503 hint, (b) `SETTLE_CAP_FAIL_MODE=open` + Redis error → returns
  `{ ok: true }` (existing behavior unchanged).

### Zero-regression

- **AC-18**: WHEN the full test suite (`npm test`) is executed after all 6
  commits, the system SHALL report ≥553 PASS and 0 FAIL.

- **AC-19**: WHEN `npm run lint` is executed after all 6 commits, the system
  SHALL exit 0 with no ESLint errors or warnings related to security rules.

---

## Scope IN

### FIX-1
- `src/infra/env.ts` — add `CORS_ALLOWED_ORIGINS: z.string().optional()` to EnvSchema
- `src/app.ts` lines 105-110 — replace `origin: true` with conditional callback
- `src/__tests__/unit/app.cors.test.ts` — NEW, 3 test cases

### FIX-2
- `src/chains/abi/fiat-token.ts` — add `DOMAIN_SEPARATOR()` view function to `FIAT_TOKEN_ABI`
- `src/methods/eip3009/abi.ts` — replicate same entry (ABI-SYNC constraint)
- `src/chains/init-domain-check.ts` — NEW, `Promise.allSettled`-based boot check
- `src/index.ts` or `src/app.ts` — call `initDomainCheck()` post-`initBreakers`
- `src/__tests__/unit/chains.kite.domain-check.test.ts` — NEW, 3 cases
- `src/__tests__/unit/chains.avalanche.domain-check.test.ts` — NEW, 3 cases

### FIX-3
- `doc/architecture/SECURITY.md` — APPEND only (file has 121 lines / 10 sections; do NOT recreate)

### FIX-4
- `src/chains/avalanche.ts` lines ~105, ~120 — replace dynamic env access with switch/ternary
- `src/chains/kite.ts` lines ~69, ~587, ~603 — replace dynamic env access with switch/ternary

### FIX-5
- GitHub UI action only — no local files

### FIX-6
- `src/infra/env.ts` — add `SETTLE_CAP_FAIL_MODE: z.enum(['open','closed']).default('open')`
- `src/core/settle-cap.ts` — branch in catch of `redis.incr` based on fail mode
- `src/__tests__/unit/core.settle-cap.test.ts` — extend with 2 new cases

---

## Scope OUT

- `src/core/*.ts` (except `settle-cap.ts`) — no changes to verify, settle, idempotency, errors
- `src/methods/**` (except `abi.ts` sync for FIX-2) — no logic changes
- `src/routes/**` — no changes
- `src/middleware/**` — no changes
- `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts` — no changes
- `OWNERS.md`, `CLAUDE.md`, project-context.md — no changes
- Dependabot PRs #3, #4, #5, #6, #7 (runtime major bumps) — explicitly HOLD
- `openapi.yaml` — no changes (no new public endpoints)
- `src/chains/registry.ts` — no changes (new file `init-domain-check.ts` does not modify registry)
- `BACKLOG.md` — no changes (no new TDs from this HU)
- Any test file not listed in Scope IN

---

## Decisiones técnicas (DT-N)

- **DT-A**: Pre-flight pull main + crear branch `fix/wfac-53-post-review-hardening` desde `d6ccd5f`.

- **DT-B**: 6 commits secuenciales, 1 por FIX. FIX-5 no genera commit local.
  Order: FIX-1 → FIX-2 → FIX-3 → FIX-4 → FIX-6 → (FIX-5 external).

- **DT-C**: FIX-2 aplicado a los 4 chains habilitados en runtime (testnet 2368,
  mainnet 2366, Fuji 43113, Avalanche mainnet 43114). `init-domain-check.ts`
  itera sobre las chains registradas en `chainRegistry`, no hardcodea IDs.

- **DT-D**: FIX-3 es APPEND únicamente. El archivo `doc/architecture/SECURITY.md`
  tiene 121 líneas y 10 secciones. Dev debe leer el archivo completo antes de
  editar para no duplicar ni sobreescribir.

- **DT-E**: FIX-6 default `'open'` = zero breaking change. El comportamiento
  existente en `src/core/settle-cap.ts` se preserva cuando la var no está seteada.

- **DT-F**: Pipeline NexusAgil QUALITY obligatorio. Riesgo medio-alto: security
  path (CORS, domain check, fail-mode) + multi-chain boot logic.

- **DT-G**: `DOMAIN_SEPARATOR()` ABI entry uses `stateMutability: 'view'`,
  `inputs: []`, `outputs: [{ type: 'bytes32' }]` — consistent with Circle
  FiatTokenV2 ABI. Both `src/chains/abi/fiat-token.ts` and
  `src/methods/eip3009/abi.ts` must receive the identical entry in the same
  commit so `T-SDD-1-ABI-SYNC` continues to pass.

- **DT-H**: FIX-4 replacement strategy: `readEnv`/`readRpcUrl`/`readEnabledFlag`/
  `readUsdcAddress` functions are called with caller-controlled string literals
  only. The fix uses a lookup table (Record object with literal keys) or a
  switch statement rather than `process.env[name]` dynamic indexing, eliminating
  the need for the eslint-disable comment. The exact approach (switch vs. Record)
  is deferred to Architect in F2.

- **DT-I**: `initDomainCheck` is called after `initBreakers` in `src/index.ts`
  (preferred) or `src/app.ts` (if test isolation requires it). Architect decides
  exact injection point in F2.

- **DT-J**: `SETTLE_CAP_FAIL_MODE` env var is read from the already-parsed `env`
  object (passed as argument or imported singleton), not via `process.env` directly,
  to stay consistent with the EnvSchema pattern.

---

## Constraint Directives (CD-N)

- **CD-1**: TypeScript strict — no `any`, no `as unknown` anywhere in modified files.

- **CD-2**: Baseline MUST NOT regress — `npm test` SHALL report ≥553 PASS, 0 FAIL
  after every individual commit (not just the final one).

- **CD-3**: ABI sync is byte-for-byte — `FIAT_TOKEN_ABI` in
  `src/chains/abi/fiat-token.ts` and `src/methods/eip3009/abi.ts` MUST be
  identical after FIX-2 commit. Test `T-SDD-1-ABI-SYNC` enforces this.

- **CD-4**: OWNERS.md boundaries are inviolable — `src/chains/init-domain-check.ts`
  MAY import `src/chains/registry.ts` and `src/chains/abi/fiat-token.ts`; it MUST
  NOT import `src/methods/*`, `src/core/*` (runtime), `src/routes/*`.

- **CD-5**: NexusAgil pipeline anchors untouched — no modification to comments
  containing `CD-N`, `WFAC-N`, `DT-N`, or `T-SDD-1-ABI-SYNC` markers in existing files.

- **CD-6**: FIX-2 boot check is non-blocking on RPC failure (warn + continue) and
  FATAL only on successful RPC response with mismatching separator. The process
  MUST NOT exit on network timeout/unreachable RPC.

- **CD-7**: Every AC listed above SHALL have at least 1 named test that covers it.
  Test names MUST reference the AC number (e.g., `'AC-4: domain separator match → boot continues'`).

- **CD-8**: FIX-6 default `'open'` preserves existing behavior exactly.
  `SETTLE_CAP_FAIL_MODE` absent == `SETTLE_CAP_FAIL_MODE=open`.

- **CD-9**: Per-chain domain checks apply to all 4 chains enabled at runtime.
  The check is driven by the chain registry, not a static list — if a chain is
  disabled via its feature flag, it is not checked.

- **CD-10**: `eslint-plugin-security/detect-object-injection` MUST NOT be
  suppressed via inline comments in the 5 locations listed in FIX-4 after this
  HU. The fix is structural (literal switch/lookup), not a comment suppress.

- **CD-11**: `CORS_ALLOWED_ORIGINS` in EnvSchema MUST use the same
  `z.enum(['true','false']).transform` pattern prohibition — specifically it
  SHALL be `z.string().optional()` (raw CSV string) parsed manually in `app.ts`
  into `string[]` by splitting on `,` and trimming whitespace. No Zod CSV
  transform that could silently swallow empty entries.

- **CD-12**: FIX-3 is an APPEND to `doc/architecture/SECURITY.md`. Dev MUST read
  the existing 121 lines before editing. Creating or truncating the file is a
  BLOQUEANTE violation.

---

## Missing Inputs

- **[NEEDS CLARIFICATION]** FIX-3 Reporting section: exact security disclosure
  email address and SLA acknowledgement window. Provisional: `security@wasiai.io`
  / 48h acknowledgement. If the operator has a different contact, update before
  F3.

- **[resolved in F2]** Exact injection point for `initDomainCheck()` (index.ts vs
  app.ts) — Architect decides in F2 based on test isolation analysis.

- **[resolved in F2]** FIX-4 replacement strategy (switch vs. Record lookup) —
  Architect specifies in SDD so Dev has unambiguous implementation path.

---

## Waves propuestas

| Wave | Fixes | Rationale |
|------|-------|-----------|
| W0 | FIX-4, FIX-1 | Low-risk: lint cleanup + CORS env wiring. No logic change on FIX-4; CORS change is backward-compatible. Establishes clean baseline for W1. |
| W1 | FIX-2 | Critical: domain separator boot check. Highest risk (touches both ABI files + new boot module). Isolated wave for focused AR. |
| W2 | FIX-3 | Docs-only append. Zero code risk. |
| W3 | FIX-6 | Optional-high: fail-mode config. Default 'open' = no breaking change. |
| DONE | FIX-5 | External GitHub action — no code commit. After W3 is merged. |

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs en el backlog (E7, E8, E9 son post-V1 y no
  dependen de estos fixes).
- FIX-2 y FIX-4 share `src/chains/kite.ts` and `src/chains/avalanche.ts` — they
  MUST be done in separate commits, not in parallel by the same dev session.
- FIX-3 (docs) y FIX-6 (core logic) son independientes entre sí pero FIX-3
  references FIX-6 behavior, so FIX-6 should be committed before FIX-3's
  "Failure Modes" section is written (or use provisional wording updated in same
  commit).
- Wave order W0 → W1 → W2 → W3 is mandatory (not parallelizable) to keep
  baseline green at each commit.

---

## Skills Router

- **security** — CORS origin whitelist, domain separator assertion, fail-mode
- **blockchain** — EIP-712 domain separator, ABI sync, multi-chain boot check
