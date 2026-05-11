# Report — HU WFAC-53 Post-review hardening (multi-chain, multi-consumer)

**Status**: DONE
**Date Closed**: 2026-05-11
**Branch**: `fix/wfac-53-post-review-hardening`
**Base Commit**: `d6ccd5f` (main post-PR #34)

---

## Executive Summary

WFAC-53 successfully closed 6 code-review findings on the EIP-3009 facilitator service, which operates across 4 blockchains (Kite testnet/mainnet, Avalanche Fuji/mainnet) and serves 2 consumers (wasiai-v2 marketplace, wasiai-a2a orchestrator). Deliverables:

- **5 implementation commits** (CORS hardening, domain separator boot check, ESLint cleanup, fail-mode configuration)
- **570 tests PASS** (baseline 553 + 17 new ACs; 0 FAIL)
- **18/18 ACs verifiable PASS** (AC-14 external GitHub action pending operator merge)
- **16/16 CDs PASS** (constraint directives enforced)
- **Zero regressions** on production code paths
- **Auto-blindaje consolidated** (1 desviación justificada: settle.test.ts ABI length fix)

All pre-merge actions documented; no BLOQUEANTE findings remain. Ready for operator review and merge.

---

## Pipeline Execution Timeline

| Phase | Artifact | Start | End | Duration | Gate |
|-------|----------|-------|-----|----------|------|
| F0 | project-context (wasiai-facilitator) | 2026-04-22 | 2026-04-22 | — | automatic |
| F1 | work-item.md + ACs (EARS) | 2026-04-22 | 2026-04-23 | — | HU_APPROVED ✓ |
| F2 | sdd.md + constraint directives | 2026-04-23 | 2026-05-06 | — | SPEC_APPROVED ✓ |
| F2.5 | story-WFAC-53.md (5 waves) | 2026-05-06 | 2026-05-06 | — | auto (post-SPEC_APPROVED) |
| F3 | Implementation (W0→W3) | 2026-05-06 | 2026-05-11 | 5 days | — |
| AR | Adversarial Review | 2026-05-11 | 2026-05-11 | — | BLOQUEANTE-FREE ✓ |
| CR | Code Review | 2026-05-11 | 2026-05-11 | — | APROBADO ✓ |
| F4 | QA Validation + Drift | 2026-05-11 | 2026-05-11 | — | APROBADO ✓ |
| DONE | Final report + _INDEX update | 2026-05-11 | 2026-05-11 | — | — |

**Total elapsed**: 19 days (2026-04-22 to 2026-05-11, includes weekend + inter-phase reviews).

---

## Commits

| Hash | Wave | Fix | Message | Tests | Status |
|------|------|-----|---------|-------|--------|
| a283c67 | W0 | FIX-4 | refactor(chains): remove 5 eslint-disable by switching env access to literal switch | 553 PASS | ✓ |
| c584c38 | W0 | FIX-1 | fix(cors): wire CORS_ALLOWED_ORIGINS env to @fastify/cors registration | 560 PASS | ✓ |
| 0b3e67f | W1 | FIX-2 | fix(chains): assert DOMAIN_SEPARATOR matches expected at boot for all 4 chains | 567 PASS | ✓ |
| 70b7032 | W2 | FIX-3 | docs(security): document fail-open modes + multi-chain operator wallet guidance | 567 PASS | ✓ |
| ee58ed7 | W3 | FIX-6 | feat(anti-abuse): SETTLE_CAP_FAIL_MODE env (open\|closed) for daily cap fail-mode | **570 PASS** | ✓ |

**Key facts**:
- Baseline before HU: 553 PASS / 0 FAIL (post-PR #34 on `d6ccd5f`).
- Final: **570 PASS / 0 FAIL** (+17 new tests for FIX-1, FIX-2, FIX-6 ACs).
- All 5 commits individually green (CD-2 enforcement).
- FIX-5 (Dependabot PR #10) is external GitHub action — no local commit.

---

## Acceptance Criteria — Final Verdict

### FIX-1 — CORS Whitelist (`CORS_ALLOWED_ORIGINS`)

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-1 | Non-empty CSV → whitelist origins, 403 for blocked | PASS | `src/__tests__/unit/app.cors.test.ts:30` (T-CORS-1, T-CORS-2 PASS); `src/app.ts:119-138` callback. **Note (MNR-1)**: @fastify/cors returns 204 for blocked origin (no ACAO header), not 403. Security intent correct; spec text imprecision accepted as TD. |
| AC-2 | Absent/empty → `origin: true` (permissive) | PASS | `src/app.ts:125-126` conditional; `app.cors.test.ts:81` T-CORS-3 PASS. |
| AC-3 | CORS unit suite PASS 3 cases | PASS | 3 tests PASS (test file 570 total). |

### FIX-2 — Domain Separator Assertion per-chain at boot

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-4 | RPC reachable → call DOMAIN_SEPARATOR(), fatal+exit(1) on mismatch | PASS | `src/chains/init-domain-check.ts:134,165` (fatal + exit); `chains.kite.domain-check.test.ts:111` T-DOM-KITE-2 PASS. |
| AC-5 | RPC unreachable → warn (non-blocking) | PASS | `src/chains/init-domain-check.ts:151-158` (warn + no exit); `chains.kite.domain-check.test.ts:134` T-DOM-KITE-3 PASS. |
| AC-6 | DOMAIN_SEPARATOR() in FIAT_TOKEN_ABI + replicate in eip3009/abi.ts, T-SDD-1-ABI-SYNC PASS | PASS | `src/chains/abi/fiat-token.ts:72-76` + `src/methods/eip3009/abi.ts:58-64` byte-identical; `chain-adapter.test.ts:1052` "FIAT_TOKEN_ABI is byte-identical" PASS. |
| AC-7 | Kite suite PASS 3 cases (match/mismatch/RPC-fail) | PASS | `chains.kite.domain-check.test.ts`: T-DOM-KITE-1/2/3 PASS. |
| AC-8 | Avalanche suite PASS 3 cases (identical semantics) | PASS | `chains.avalanche.domain-check.test.ts`: T-DOM-AVAX-1/2/3 PASS. |

### FIX-3 — SECURITY.md Append

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-9 | "Failure modes" section (Redis, cap, domain-sep) | PASS | `doc/architecture/SECURITY.md:133-179` (sección nueva). |
| AC-10 | "Operator wallet" extended (V1 hot key, V2 rec, no-log list) | PASS | `doc/architecture/SECURITY.md:16-25` (V1/V2 notes, env var list). |
| AC-11 | "Reporting" section (email + SLA) | PASS | `doc/architecture/SECURITY.md:181-200` (security@wasiai.io + 48h). **TO-VERIFY-PRE-MERGE** (line 199): confirm mailbox with operator. |

### FIX-4 — Remove 5 `eslint-disable security/detect-object-injection`

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-12 | npm run lint exit 0, 0 disables in 5 locations | PASS | `npm run lint` exit 0; grep confirms 0 disables in kite.ts/avalanche.ts. |
| AC-13 | 553 baseline tests continue to PASS | PASS | 570 tests PASS (includes baseline). |

### FIX-5 — Dependabot PR #10 (external)

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-14 | Merge PR #10 (actions/upload-artifact 4→7) when CI green | NO VERIFICABLE | External GitHub UI action (see pre-merge actions §6). |

### FIX-6 — SETTLE_CAP_FAIL_MODE configuration

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-15 | fail-mode=closed + Redis error → HTTP 503 SERVICE_UNAVAILABLE | PASS | `src/core/settle-cap.ts:104-107` (503 return); `src/routes/settle.ts:140-159` (error handling); `core.settle-cap.test.ts:120` T-CAP-CLOSED PASS. |
| AC-16 | fail-mode=open (or absent) → preserve fail-open behavior | PASS | `src/infra/env.ts:140` default `'open'`; `core.settle-cap.test.ts:133` T-CAP-OPEN-EXPLICIT PASS. |
| AC-17 | settle-cap suite PASS 2 new cases | PASS | 2 new tests PASS (T-CAP-CLOSED, T-CAP-OPEN-EXPLICIT). |

### Zero-regression

| AC | Requirement (EARS) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-18 | npm test → ≥553 PASS / 0 FAIL | PASS | **570 PASS / 0 FAIL** (35 test files). |
| AC-19 | npm run lint → exit 0, no ESLint errors | PASS | Exit 0; 0 new eslint-disables. |

**Result: 18/18 ACs verifiable PASS. AC-14 (external) pending operator action.**

---

## Constraint Directives — Compliance

| CD | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| CD-1 | TypeScript strict (no `any` explicit) | PASS | `tsc --noEmit` exit 0. Cast `as unknown as Logger` documented (AB-WFAC-41-3). |
| CD-2 | Baseline NOT regressed after each commit | PASS | 570 PASS in HEAD; per-commit baselines tracked (W0:553→560→567→567→570). |
| CD-3 | ABI sync byte-for-byte (FIAT_TOKEN_ABI) | PASS | JSON.stringify comparison; both files identical (2 entries). |
| CD-4 | OWNERS.md boundaries (chains MAY import registry/abi, NOT methods/core/routes) | PASS | `init-domain-check.ts` imports: `pino`, `viem`, `./registry`, `./abi/fiat-token`, `./types`. Zero methods/core/routes imports. |
| CD-5 | Pipeline anchors untouched (CD-N, WFAC-N, DT-N, T-SDD-1-ABI-SYNC) | PASS | Marker T-SDD-1-ABI-SYNC in `chains/abi/fiat-token.ts:9` intact. |
| CD-6 | FIX-2 non-blocking on RPC fail, fatal ONLY on mismatch | PASS | `init-domain-check.ts:113-115` catch → no exit; line 162-165 exit only on mismatch. |
| CD-7 | Every AC ≥1 named test referencing AC number | PASS | All tests use explicit naming (T-CORS-1, T-DOM-KITE-2, T-CAP-CLOSED, etc.). |
| CD-8 | FIX-6 default `'open'` = zero breaking change | PASS | `env.ts:140` default; T-CAP-OPEN-EXPLICIT PASS. |
| CD-9 | Domain checks driven by chain registry (not static list) | PASS | `init-domain-check.ts:85-88` iterates `chainRegistry.listAdapters()`. |
| CD-10 | No eslint-disable security/detect-object-injection in 5 FIX-4 locations | PASS | 0 occurrences (refactored to `switch`). |
| CD-11 | CORS_ALLOWED_ORIGINS = `z.string().optional()` + manual CSV parse | PASS | `env.ts:129` type; `app.ts:119-122` parse logic. |
| CD-12 | FIX-3 APPEND ONLY (no truncate/recreate) | PASS | main: 121 lines; HEAD: 200 lines; removals: 0. |
| CD-13 | No `process.env[DYNAMIC]` in new/modified code | PASS | 0 occurrences of `process.env[` in kite.ts/avalanche.ts (only switch literals). |
| CD-14 | initDomainCheck uses Promise.allSettled (not Promise.all) | PASS | `init-domain-check.ts:108` allSettled. |
| CD-15 | SERVICE_UNAVAILABLE NOT added to X402ErrorCode | PASS | Added only to local `SettleRouteErrorCode` union in `settle.ts:54`. |
| CD-16 | skipDomainCheck test opt-out available | PASS | `app.ts:66,227` BuildAppOptions field; all tests migrated. |

**Result: 16/16 CDs PASS.**

---

## Findings & Triage

### BLOQUEANTE (0)
None. All critical findings from AR closed.

### MNRs (3) — Accepted as backlog TDs

| ID | Description | Category | Action |
|----|-------------|----------|--------|
| MNR-1 | AC-1 text says "HTTP 403" but @fastify/cors returns 204 for blocked origin | Spec text imprecision | Register as TD if needed; security intent (no ACAO header) correct. |
| MNR-2 | Multi-token support absent (only `tokens[0]` checked per chain) | Feature scope | Registrable in BACKLOG for V2+ (current scope: 1 token per chain). |
| MNR-3 | settle.test.ts modified (not in literal Scope IN, but justified by auto-blindaje) | Scope drift (justified) | Documented in auto-blindaje.md; ABI length assertion fix necessary. |

### OBS (6) — From CR, all backlog TDs
All 6 observations from Code Review categorized as backlog. No action required for DONE.

---

## Auto-Blindaje Consolidated

**Auto-Blindaje source**: `doc/sdd/019-wfac-53-post-review-hardening/auto-blindaje.md`

### [2026-05-11 12:39] Wave 1 (C3) — R-10 incomplete: FIAT_TOKEN_ABI length consumer unlisted

**Error**: After adding `DOMAIN_SEPARATOR()` entry to `FIAT_TOKEN_ABI` (required by AC-6 + CD-3), test `src/__tests__/unit/methods/eip3009/settle.test.ts` (line 398) failed with assertion on array length.

**Root cause**: Story §6 R-10 grep for consumers (`grep -rn "FIAT_TOKEN_ABI\[...`) did not catch `FIAT_TOKEN_ABI).toHaveLength(...)` (vitest syntax on array). A second pass with expanded regex revealed the stale assertion.

**Fix applied**: Updated test assertion from `toHaveLength(1)` to `toHaveLength(2)`, adding secondary entry check. File `settle.test.ts` not in literal Scope IN §0.6, but modification strictly required for CD-2 (no regression post-ABI extension mandated by CD-3).

**Lesson for future HUs**: When extending versioned ABIs, grep for consumers must use expanded pattern:
```regex
FIAT_TOKEN_ABI\s*[).\[]
```
This catches `.length`, `.toHaveLength()`, `[N]`, `.forEach`, `.map`, etc. CD-PROPOSED for next Story File: add this expanded pattern to R-10 grep directive.

---

## Multi-chain Coverage Matrix

| Chain | RPC | Domain (DOMAIN_SEPARATOR boot check) | Token Contract | Status |
|-------|-----|--------------------------------------|-----------------|--------|
| Kite testnet (2368) | Kakarot testnet RPC | `Circle PYUSD` + name/version/chainId | PYUSD (0x52...) | ✓ PASS |
| Kite mainnet (2366) | Kakarot mainnet RPC | `Circle PYUSD` + name/version/chainId | PYUSD (0x52...) | ✓ PASS |
| Avalanche Fuji (43113) | Avalanche testnet RPC | `USD Coin` / `version 2` + chainId | USDC.e (0xB9...) | ✓ PASS |
| Avalanche mainnet (43114) | Avalanche mainnet RPC | `USD Coin` / `version 2` + chainId | USDC (0xB9...) | ✓ PASS |

**Test coverage**: Kite and Avalanche each have separate domain-check test suite (3 cases each: match/mismatch/RPC-fail), total 6 domain-specific tests. `chains.domain-check.multi.test.ts` verifies all 4 chains boot concurrently (Promise.allSettled).

---

## Consumer Impact

### wasiai-v2 (marketplace)

- **CORS hardening**: marketplace can now set `CORS_ALLOWED_ORIGINS` to restrict facilitator API to known origins (e.g., marketplace.wasiai.io, staging.wasiai.io). Deployment optional; backward-compatible.
- **Domain separator boot check**: marketplace deployment will benefit from fatal exit if chain RPC returns mismatched domain separator (indicates chain misconfiguration or attack). Non-blocking on RPC timeout (graceful degradation).
- **Fail-mode config**: marketplace can opt-in to `SETTLE_CAP_FAIL_MODE=closed` for stricter anti-abuse posture (fail-closed on Redis outage instead of fail-open).

### wasiai-a2a (orchestrator)

- **Multi-chain consistency**: same 4 chains checked at boot with identical semantics. A2A consumers benefit from consistent domain separator across all facilitator instances.
- **Security signal**: domain separator fatal exit signals a2a clients that the chain adapter is in a critical state (misconfiguration or compromised RPC) — enables orchestrator to failover or alert.

---

## Pre-merge Actions

### 1. AC-14 — Dependabot PR #10 (external)

**Action**: Check GitHub UI and merge via GitHub when CI is green.

```bash
# Verify CI status
gh pr checks 10 --repo ferrosasfp/wasiai-facilitator

# If green, merge (squash recommended for dependency PR)
gh pr merge 10 --repo ferrosasfp/wasiai-facilitator --squash --auto
```

**Note**: Dependabot PRs #3–#7 (runtime major bumps) explicitly HOLD per AC-14 directive.

### 2. TO-VERIFY-PRE-MERGE — SECURITY.md Reporting section (line 199)

**Location**: `doc/architecture/SECURITY.md:199`

**Action**: Confirm with operator that `security@wasiai.io` is the correct contact point for security disclosures. If operator prefers a different email or SLA, update placeholder and stage as separate commit before merge.

**Current placeholder**:
```markdown
**Email**: security@wasiai.io
**SLA**: 48h acknowledgement
```

### 3. Smoke Test Checklist (for operator, post-merge to main)

Optional pre-production validation:

1. Deploy to staging with `CORS_ALLOWED_ORIGINS="https://staging.wasiai.io"`.
2. Send OPTIONS /health with `Origin: https://attacker.example` → verify Access-Control-Allow-Origin header absent (browser blocks).
3. Send OPTIONS /health with `Origin: https://staging.wasiai.io` → verify Access-Control-Allow-Origin header present.
4. Deploy with `SETTLE_CAP_FAIL_MODE=closed` + Redis simulated down → POST /settle → confirm 503 SERVICE_UNAVAILABLE.
5. Verify logs contain "settle daily cap check failed — fail-closed".
6. Confirm GitHub UI shows Dependabot PR #10 merged and CI green.

---

## Files Modified

### Production code (7 files)

- `src/infra/env.ts` — 2 new env vars (CORS_ALLOWED_ORIGINS, SETTLE_CAP_FAIL_MODE)
- `src/app.ts` — CORS plugin wiring + domain check injection + skipDomainCheck option
- `src/chains/kite.ts` — refactor 3 readEnv/readUsdcAddress/readEnabledFlag to switch literals
- `src/chains/avalanche.ts` — refactor 2 readRpcUrl/readEnabledFlag to switch literals
- `src/chains/abi/fiat-token.ts` — add DOMAIN_SEPARATOR() view entry
- `src/methods/eip3009/abi.ts` — replicate DOMAIN_SEPARATOR() entry (ABI sync)
- `src/chains/init-domain-check.ts` — NEW boot check module
- `src/core/settle-cap.ts` — add failMode branching for fail-closed mode
- `src/routes/settle.ts` — route handler for SERVICE_UNAVAILABLE + failMode passing

### Documentation (1 file)

- `doc/architecture/SECURITY.md` — APPEND 79 lines (failure modes, reporting section, operator wallet notes)

### Tests (9 files)

- `src/__tests__/unit/env.test.ts` — 5 new env parsing tests
- `src/__tests__/unit/app.cors.test.ts` — NEW, 3 CORS integration tests
- `src/__tests__/unit/chains.kite.domain-check.test.ts` — NEW, 3 Kite domain-check tests
- `src/__tests__/unit/chains.avalanche.domain-check.test.ts` — NEW, 3 Avalanche domain-check tests
- `src/__tests__/unit/chains.domain-check.multi.test.ts` — NEW, multi-chain boot test
- `src/__tests__/unit/core.settle-cap.test.ts` — 2 new fail-mode tests
- `src/__tests__/unit/health.test.ts`, `rate-limiting.test.ts`, `redis.test.ts`, `routes.*.test.ts`, `chains/init-breakers.test.ts` — updated with `skipDomainCheck: true` option (no logic changes)
- `src/__tests__/unit/methods/eip3009/settle.test.ts` — ABI length assertion updated (auto-blindaje fix)

**Total**: 16 modified, 5 created, 9 touched (test wiring).

---

## Lessons for Future HUs

1. **ABI consumer grep must be comprehensive**: When extending versioned ABIs (e.g., FIAT_TOKEN_ABI), use regex pattern `ABI_NAME\s*[).\[]` to catch `.length`, `.toHaveLength()`, `[N]`, `.forEach`, `.map` variants. A single grep pattern may miss vitest assertion syntax.

2. **Boot-init modules respect OWNERS.md boundaries**: New modules like `init-domain-check.ts` can safely import registry + abi + types, but crossing into methods/core/routes requires explicit boundary expansion (CD-4). Plan OWNERS.md updates early.

3. **Promise.allSettled for multi-chain boot checks**: Always use `allSettled` (not `all`) for multi-chain operations where partial failure (RPC timeout on one chain) should not block others. CD-14 codifies this.

4. **Test opt-outs (skipDomainCheck)**: When a new boot check is required, provide a `BuildAppOptions` field to opt-out in tests (default behavior on in production). This avoids littering tests with mock setup while keeping the actual behavior testable via dedicated test suites.

5. **Auto-blindaje scope drift is recoverable**: Modifying a file outside literal Scope IN (e.g., settle.test.ts) is acceptable if the modification is minimal, justified by a prior constraint (CD-2 baseline regression), and documented in auto-blindaje.md. The QA gate will catch unjustified drift.

6. **Fail-mode config should default to existing behavior**: When introducing opt-in fail-closed mode (FIX-6), default to the existing behavior (`'open'`) to avoid breaking changes. The enum default pattern (`z.enum(['open','closed']).default('open')`) is safer than implicit booleans.

---

## Recommendation

**APPROVED FOR MERGE TO `main`.**

All gates passed (F4 QA, AR BLOQUEANTE-FREE, CR APROBADO). Pre-merge actions (AC-14, TO-VERIFY-PRE-MERGE email) are operator-facing, not blocking. Auto-blindaje consolidated with actionable lessons for future HUs.

**Next step**: Operator reviews pre-merge checklist, confirms email contact, merges Dependabot PR #10, then merges WFAC-53 PR to main.
