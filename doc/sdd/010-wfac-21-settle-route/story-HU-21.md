# Story File — HU-21 POST /settle route (WFAC-21)

- **Work Item**: `doc/sdd/010-wfac-21-settle-route/work-item.md`
- **SDD**: `doc/sdd/010-wfac-21-settle-route/sdd.md`
- **Pipeline**: QUALITY (on-chain write — AR + CR obligatorios) · **Sizing**: M · **SDD_MODE**: full
- **Branch**: `feat/010-wfac-21-settle-route` (already created from `main@1b5be9b`)
- **Baseline commit (main)**: `1b5be9b docs(WFAC-20): DONE — _INDEX.md closure`
- **Baseline tests**: **273 passed (18 files)** · **Target**: ≥310 (273 + ≥37 new)
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — READ BEFORE EACH WAVE

**Stop and read this before writing a single line of code per wave.**

### 0.1 Required reading

1. This file (`story-HU-21.md`) — **it is the only contract you MUST follow**.
2. The **exemplars** listed in §0.4 — consult ONLY the relevant ones for the wave you are on.
3. DO NOT read `work-item.md` or `sdd.md` unless you hit an ambiguity and suspect this story is wrong.

### 0.2 Environment check

```
pwd                                    # must be /home/ferdev/.openclaw/workspace/wasiai-facilitator
git rev-parse --abbrev-ref HEAD        # must be feat/010-wfac-21-settle-route
git status                             # must be clean at start; after each wave, only scope IN files may appear
npm test -- --run                      # must be 273/273 BEFORE W0, growing toward ≥310 at end of W3
```

### 0.3 Anti-Hallucination Checklist (per wave)

**Before starting a wave:**

- [ ] Did you read THIS Story File end-to-end?
- [ ] Did you read the exemplar files listed for THIS wave (and only those)?
- [ ] Did you verify every import path with `ls` or `Read` before writing it?
- [ ] Did you confirm that **no file outside the Scope IN table (§0.5)** will be touched?
- [ ] Did you confirm that the **wave dependencies** (§0.6) are all green (build + tests)?

**Before closing a wave:**

- [ ] `npm run build` is green.
- [ ] `npm run lint` is green (`eslint.config.js` zero-warnings policy).
- [ ] `npm test -- --run` passes at least the baseline count (273) + any new tests from this wave.
- [ ] You did NOT modify any file outside the wave's declared "Files" list.
- [ ] You did NOT add a dependency in `package.json`. (There is NO dep change in this HU — if you think you need one, STOP and report.)
- [ ] **CD-14 check**: `npm test -- --run core.idempotency.test.ts` passes with all existing WFAC-20 tests green.
- [ ] **CD-14 check**: `npm test -- --run routes.verify.test.ts` passes with all existing WFAC-20 tests green.

### 0.4 Exemplars verified in SDD §7 (paths confirmed to exist)

| # | Path | Read it for |
|---|------|-------------|
| E1 | `src/core/schemas.ts` | W0: layout of existing `VerifyRequestSchema` + `VerifyRequest`. You will add the alias block at the END of this file. |
| E2 | `src/core/idempotency.ts` | W0: layout of existing verify helpers (`VERIFY_IDEMPOTENCY_*`, `canonicalStringify`, `buildIdempotencyKey`, `getCachedVerifyResponse`, `setCachedVerifyResponse`, `toCacheable`, `isRedisAvailable`, `CachedVerifyResponse`). You will add the settle helpers at the END — **no renames, no signature changes** (CD-14). |
| E3 | `src/core/verify.ts` | W1: exact flow to MIRROR in `src/core/settle.ts` (EIP155_RE, BigInt overflow, assetTransferMethod guard, registry lookup, dispatch). |
| E4 | `src/routes/verify.ts` | W2: exact flow to MIRROR in `src/routes/settle.ts` (5-step pipeline, `sendCached` helper, L1-L4 log templates, CD-2 explicit object build). |
| E5 | `src/app.ts` | W2 modify: `buildApp` factory + `await app.register(...)`. The new line goes **immediately after** `await app.register(verifyRoute);` (CD-15). |
| E6 | `src/chains/types.ts` | `SettleParams`, `SettleResult`, `AdapterResult<T>`, `ChainAdapter`. **Type-only imports.** `SettleResult` has 7 fields: `{ settled, transactionHash, blockNumber, amount, from, to, asset }`. |
| E7 | `src/methods/eip3009/settle.ts` | Confirms `settleEip3009` returns `AdapterResult<SettleResult>` with the 7 fields. **Do NOT import from this file** (CD-1 / CD-9). |
| E8 | `src/__tests__/unit/routes.verify.test.ts` | W3 pattern source: `vi.mock('ioredis')` + `RedisMock` + `CaptureStream` + `makeFakeAdapter` + `VALID_BODY` fixture + `buildAppWithAdapter` helper. **Copy the scaffold verbatim**, swap `verify` → `settle`. |
| E9 | `src/__tests__/unit/core.verify.test.ts` | W3 pattern source for orchestrator tests. |
| E10 | `src/__tests__/unit/core.idempotency.test.ts` | W3 pattern source for idempotency unit tests. Must stay green (CD-14). |
| E11 | `src/core/errors.ts` | `buildX402Error(code, message?)`. Pure, no deps. Used in `settleCore`. |
| E12 | `src/core/types.ts` | `asChainId()`, `X402ErrorCode`, `Result<T>`, `Err`. |
| E13 | `OWNERS.md` | Boundary matrix. **Excepción [1]** is NOT applicable to this HU (no `methods → core/errors.ts` edge). |

### 0.5 Scope IN — the ONLY files you may touch

| Path | Action | Wave |
|------|--------|------|
| `src/core/schemas.ts` | **MODIFY** (append alias + type) | W0 |
| `src/core/idempotency.ts` | **MODIFY** (append settle helpers — no edits to verify code) | W0 |
| `src/core/settle.ts` | **CREATE** | W1 |
| `src/routes/settle.ts` | **CREATE** | W2 |
| `src/app.ts` | **MODIFY** (one import + one `await app.register`) | W2 |
| `src/__tests__/unit/core.idempotency.settle.test.ts` | **CREATE** | W3 |
| `src/__tests__/unit/core.settle.test.ts` | **CREATE** | W3 |
| `src/__tests__/unit/routes.settle.test.ts` | **CREATE** | W3 |

**ANY edit to any other file = Story File violation. STOP AND REPORT.**

In particular, the following files are **FROZEN** for this HU (they ship as-is from WFAC-20):

- `src/core/verify.ts` — do NOT refactor `EIP155_RE` / `MAX_CHAINID_DIGITS` to a shared helper now. Even if you feel the DRY urge. (See §4.1 "DO NOT".)
- `src/routes/verify.ts` — no changes.
- `src/__tests__/unit/core.idempotency.test.ts`, `core.verify.test.ts`, `routes.verify.test.ts` — no changes. CI enforces they stay green (CD-14).

### 0.6 Wave dependency graph

```
W0 (schemas + idempotency settle helpers)  ──────────┐
                                                     ├──► W1 (core/settle)
                                                     │           │
                                                     │           ▼
                                                     └──► W2 (routes/settle + app.ts)
                                                                 │
                                                                 ▼
                                                     W3 (3 test files)
```

- **W0 → W1**: W1 imports `SettleRequest` (= `VerifyRequest`) type from `core/schemas.ts`.
- **W0 → W2**: W2 imports `SettleRequestSchema`, `buildSettleIdempotencyKey`, `getCachedSettleResponse`, `setCachedSettleResponse`, `toCacheableSettle`, `isRedisAvailable`, `CachedSettleResponse`.
- **W1 → W2**: W2 imports `settleCore` from `core/settle.ts`.
- **W0, W1, W2 → W3**: tests exercise everything.
- **No forward references**. If W1 needs something from W2, we have a design bug — STOP AND REPORT.

---

## 1. Waves

### Wave 0 — `src/core/schemas.ts` + `src/core/idempotency.ts` (both MODIFY, append-only)

**Objective**: expose `SettleRequestSchema` (alias of `VerifyRequestSchema`) and add a full settle variant of the idempotency helpers, **without touching** any existing verify export.

#### 0.A — `src/core/schemas.ts` change

**Action**: append at the end of the file (after the existing `export type VerifyRequest = z.infer<typeof VerifyRequestSchema>`).

**Imports**: **NONE new**. `VerifyRequestSchema` and `VerifyRequest` are already declared locally.

**Skeleton**:

```ts
// ─── WFAC-21 extension ──────────────────────────────────────────────────
/**
 * Alias of VerifyRequestSchema — x402 spec declares the settle body shape
 * identical to verify (see src/chains/types.ts: `SettleParams = VerifyParams`).
 * Export under a distinct name for route-layer clarity (SDD §DT-1).
 *
 * If the spec ever diverges (e.g. settle adds an optional `tip` field), this
 * alias MUST be forked to its own Zod object in an explicit SDD — not drifted
 * silently.
 */
export const SettleRequestSchema = VerifyRequestSchema;
export type SettleRequest = VerifyRequest;
```

**Completion criteria**:

- [ ] `tsc --noEmit` green.
- [ ] Zero changes to the existing verify exports (CD-14).
- [ ] `npm test -- --run` still 273/273 (no new tests in this sub-wave).

---

#### 0.B — `src/core/idempotency.ts` change

**Action**: append at the end of the file (after the existing `toCacheable` function). **DO NOT edit, rename, or refactor any existing export** (CD-14).

**Imports**: **NONE new**. `createHash` from `node:crypto`, `getRedisClient` from `../infra/redis.js`, and `VerifyRequest` from `./schemas.js` are already imported.

**Skeleton** (append verbatim, adjust comments if needed):

```ts
// ─── WFAC-21 settle helpers ─────────────────────────────────────────────
//
// All settle-related exports live alongside the verify helpers so the
// route layer imports from ONE façade (`src/core/idempotency.ts`). We do
// NOT create a separate file (SDD §DT-2).
//
// Naming convention: every new symbol is prefixed with `Settle*` or
// `SETTLE_*` so auditors can grep the two concepts apart.

/** Spec x402: 120 s window for idempotency replay. */
export const SETTLE_IDEMPOTENCY_TTL_SEC = 120;

/** Distinct prefix from VERIFY_IDEMPOTENCY_KEY_PREFIX (CD-6, CD-11 SDD nuevo). */
export const SETTLE_IDEMPOTENCY_KEY_PREFIX = 'settle:idempotency:';

/**
 * Cached settle success — 7 spec-literal fields of SettleResult.
 * NOTE: structural (no `SettleResult` import from src/chains/types.ts) to
 * keep the OWNERS boundary `core/idempotency.ts → infra + crypto + schemas`
 * intact. Mirrors the pattern used by CachedVerifyResponse.
 */
export interface CachedSettleResponseOk {
  readonly ok: true;
  readonly response: {
    readonly settled: true;
    readonly transactionHash: `0x${string}`;
    readonly blockNumber: number;
    readonly amount: string;
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    readonly asset: `0x${string}`;
  };
}

/** Cached settle error — always `http < 500` (CD-12 enforced by toCacheableSettle). */
export interface CachedSettleResponseErr {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly http: number;
  };
}

export type CachedSettleResponse =
  | CachedSettleResponseOk
  | CachedSettleResponseErr;

/**
 * Structural input for toCacheableSettle — matches `Result<SettleResult>`
 * without importing the concrete type (OWNERS: core/idempotency.ts does
 * NOT import src/chains/*). Same pattern as ToCacheableInput.
 */
export type ToCacheableSettleInput =
  | {
      readonly ok: true;
      readonly settled: true;
      readonly transactionHash: `0x${string}`;
      readonly blockNumber: number;
      readonly amount: string;
      readonly from: `0x${string}`;
      readonly to: `0x${string}`;
      readonly asset: `0x${string}`;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly http: number;
      };
    };

/**
 * Builds the full Redis key `settle:idempotency:<sha256-hex>`.
 * Reuses `canonicalStringify` — no duplication (CD-8 heredado).
 */
export function buildSettleIdempotencyKey(parsed: VerifyRequest): string {
  const canonical = canonicalStringify(parsed);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${SETTLE_IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

/**
 * Read the cached settle response.
 * Return value:
 *   - null  → cache miss (Redis unavailable or genuine miss) → caller proceeds.
 *   - object → cache hit → caller replays WITHOUT invoking the adapter
 *              (CRITICAL: prevents double-spend when the original tx is
 *              in-flight mempool or already mined).
 */
export async function getCachedSettleResponse(
  key: string,
): Promise<CachedSettleResponse | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedSettleResponse;
  } catch {
    // Swallow — graceful degradation (AC-10). Do NOT log here (logger is
    // route-owned). Return null to pass-through.
    return null;
  }
}

/**
 * Write settle cache entry with TTL.
 * Swallows all errors (CD-4 applies: never throw on expected failure).
 * CD-12: caller must pre-filter via toCacheableSettle().
 */
export async function setCachedSettleResponse(
  key: string,
  payload: CachedSettleResponse,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(
      key,
      JSON.stringify(payload),
      'EX',
      SETTLE_IDEMPOTENCY_TTL_SEC,
    );
  } catch {
    // Swallow — graceful degradation.
  }
}

/**
 * Convert a Result<SettleResult> into a CachedSettleResponse or null.
 * Returns null when http >= 500 (not cacheable — transient/permanent 5xx
 * must NOT block future retries — CD-12 heredado de WFAC-20).
 *
 * CD-11 (new): success branch builds the response object EXPLICITLY with
 * the 7 spec-literal fields (no rest-spread destructure). This is the
 * "explicit object build" lesson from WFAC-20 auto-blindaje W1.
 */
export function toCacheableSettle(
  result: ToCacheableSettleInput,
): CachedSettleResponse | null {
  if (result.ok) {
    return {
      ok: true,
      response: {
        settled: result.settled,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        amount: result.amount,
        from: result.from,
        to: result.to,
        asset: result.asset,
      },
    };
  }
  if (result.error.http >= 500) return null; // CD-12
  return { ok: false, error: result.error };
}
```

**CD-14 enforcement (critical)**:

- [ ] `git diff src/core/idempotency.ts` shows **only appended lines** (no deletions, no mid-file edits).
- [ ] `grep -nE "export (const|function|type|interface) (VERIFY_|Cached(Verify|Response)|canonicalStringify|buildIdempotencyKey|getCachedVerifyResponse|setCachedVerifyResponse|isRedisAvailable|toCacheable)" src/core/idempotency.ts` returns **the same exports** as before the change.
- [ ] `npm test -- --run core.idempotency.test.ts` is green (0 regressions).

**OWNERS audit**:

- [ ] `grep -nE "from '\\.\\./(chains|methods|routes)" src/core/idempotency.ts` returns **zero** matches.

#### Wave 0 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 273/273 (no new tests in W0; tests arrive in W3).
- [ ] `git status` shows ONLY `src/core/schemas.ts` and `src/core/idempotency.ts` as modified (no new files).
- [ ] All 9 new settle exports are accessible from `../core/idempotency.js` + 2 from `../core/schemas.js`.
- [ ] Existing WFAC-20 test files still green (CD-14 literal).

---

### Wave 1 — `src/core/settle.ts` (orchestrator — NEW)

**Objective**: stateless orchestrator that mirrors `verifyCore` exactly. Parses `accepted.network`, validates `assetTransferMethod`, looks up the adapter via `chainRegistry`, and dispatches via `adapter.settle(params)`. Always returns `Result<SettleResult>` — never throws for foreseeable errors (CD-4).

#### Files

- `src/core/settle.ts` — **CREATE**.

#### Imports allowed (OWNERS `core → core + chains/types + chains/registry`)

```ts
import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js'; // alias by value = SettleRequest
import { chainRegistry } from '../chains/registry.js';
import type { SettleParams, SettleResult } from '../chains/types.js'; // TYPE-ONLY
```

#### Imports PROHIBIDOS

- `src/methods/*` — dispatch exclusivo vía `chainRegistry.getAdapter(chainId).adapter.settle(params)` (CD-9 del WI).
- `src/routes/*` — core no conoce HTTP.
- `src/infra/*` — core no toca I/O directo.

#### Skeleton

```ts
/**
 * POST /settle orchestrator — stateless, pure (no I/O except adapter call).
 *
 * Flow (espejo exacto de src/core/verify.ts):
 *   1. Parse `accepted.network` with regex /^eip155:([1-9]\d*)$/ (CD-13 heredado).
 *      - Overflow guard (CD-14 heredado): if the numeric string exceeds safe
 *        integer range, return NETWORK_MISMATCH.
 *   2. Enforce assetTransferMethod === 'eip3009' (only method supported in v1).
 *   3. chainRegistry.getAdapter(chainId) → passthrough error if miss.
 *   4. adapter.settle(parsed as SettleParams) → passthrough result.
 *
 * NEVER throws for foreseeable errors (CD-4). Adapter exceptions propagate
 * (route handles via L4 log + 500 response).
 *
 * Boundary (OWNERS):
 *   - MAY import: ./types.js, ./errors.js, ./schemas.js (type-only),
 *     ../chains/registry.js (runtime), ../chains/types.js (type-only).
 *   - MUST NOT import: src/routes/*, src/methods/*, src/infra/*.
 */

import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { SettleParams, SettleResult } from '../chains/types.js';

// CD-13 heredado. NOTE: this regex and the MAX_CHAINID_DIGITS constant are
// duplicated from src/core/verify.ts ON PURPOSE for WFAC-21. Factoring them
// to a shared `src/core/network.ts` is OUT OF SCOPE (§4.1 "DO NOT"). Open a
// follow-up HU if a third consumer appears.
const EIP155_RE = /^eip155:([1-9]\d*)$/u;
const MAX_CHAINID_DIGITS = 16; // matches verify.ts

export async function settleCore(
  parsed: VerifyRequest, // alias by value: SettleRequest (SDD §DT-1)
): Promise<Result<SettleResult>> {
  // Step 1 — parse network
  const m = EIP155_RE.exec(parsed.accepted.network);
  if (!m) {
    return {
      ok: false,
      error: buildX402Error(
        'NETWORK_MISMATCH',
        'network must be eip155:<chainId> with a positive integer',
      ),
    };
  }
  const digits = m[1]!;
  // CD-14 heredado: don't trust Number() for chainId beyond MAX_SAFE_INTEGER.
  if (
    digits.length > MAX_CHAINID_DIGITS ||
    BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'chainId out of safe integer range'),
    };
  }
  // asChainId is safe here — digits passed both guards (positive int, within
  // MAX_SAFE_INTEGER). If you find yourself needing a try/catch around it,
  // you're adding unreachable code (WFAC-20 auto-blindaje W4 lesson).
  const chainId = asChainId(Number(digits));

  // Step 2 — method guard (SDD §DT-6)
  if (parsed.accepted.extra.assetTransferMethod !== 'eip3009') {
    return {
      ok: false,
      error: buildX402Error(
        'NETWORK_MISMATCH',
        'Method not supported: only eip3009 in v1',
      ),
    };
  }

  // Step 3 — registry lookup
  const lookup = chainRegistry.getAdapter(chainId);
  if (!lookup.ok) {
    return { ok: false, error: lookup.error };
  }

  // Step 4 — dispatch to adapter.settle
  // SettleRequest is structurally assignable to SettleParams (= VerifyParams)
  // with the same caveat as verifyCore: Zod `.regex()` narrows a string, not
  // a template literal type. The cast `as unknown as SettleParams` is the
  // sanctioned workaround (WFAC-20 auto-blindaje entry 4).
  //
  // If this cast breaks at build time, STOP AND REPORT — do NOT widen to
  // `any`. The schemas in W0 must stay in sync with SettleParams.
  const params: SettleParams = parsed as unknown as SettleParams;

  // NO try/catch here: adapter throws propagate to the route (CD-4 intent +
  // SDD §DT-8: "throws = bug; caught as defense-in-depth in the route L4").
  return lookup.adapter.settle(params);
}
```

#### Wave 1 — dependencies

- Depends on W0 (imports `VerifyRequest` type from `./schemas.js`).
- Does NOT depend on W2 / W3.

#### Wave 1 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 273/273 (no new tests; tests arrive in W3).
- [ ] `grep -nE "from '\\.\\./methods" src/core/settle.ts` returns **zero** matches (CD-9 del WI).
- [ ] `grep -nE "from '\\.\\./(routes|infra)" src/core/settle.ts` returns **zero** matches.
- [ ] `git status` shows `src/core/schemas.ts`, `src/core/idempotency.ts` (from W0) + `src/core/settle.ts` (new).

---

### Wave 2 — `src/routes/settle.ts` + `src/app.ts` (Fastify plugin + registration)

**Objective**: HTTP boundary for `POST /settle`. Mirrors `src/routes/verify.ts` exactly, with these diffs:
1. Endpoint path `/settle` (not `/verify`).
2. 200 body emits the 7-field `SettleResult` shape (`settled, transactionHash, blockNumber, amount, from, to, asset`) — CD-2 adaptado.
3. Success log includes `tx_hash: result.transactionHash` (CD-12 nuevo).
4. Idempotency uses the `settle:idempotency:` prefix — `buildSettleIdempotencyKey`, `getCachedSettleResponse`, `setCachedSettleResponse`, `toCacheableSettle` (CD-6 heredado).
5. Cached hit replay reconstructs the 7-field body explicitly (CD-11 nuevo).

#### Files

- `src/routes/settle.ts` — **CREATE**.
- `src/app.ts` — **MODIFY** (1 import line + 1 `await app.register(settleRoute);`). CD-15 nuevo: register **immediately after** `verifyRoute`.

#### 2.A — `src/routes/settle.ts`

##### Imports allowed

```ts
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  SettleRequestSchema,
  type SettleRequest,
} from '../core/schemas.js';
import { settleCore } from '../core/settle.js';
import {
  buildSettleIdempotencyKey,
  getCachedSettleResponse,
  setCachedSettleResponse,
  isRedisAvailable,
  toCacheableSettle,
  type CachedSettleResponse,
} from '../core/idempotency.js';
```

##### Imports PROHIBIDOS (CD-1 del WI, CD-9 / CD-10 heredados)

- `src/chains/*` (any file).
- `src/methods/*` (any file).
- `src/infra/*` (any file) — Redis access goes through `isRedisAvailable()` + `getCachedSettleResponse()`.
- `viem` / `ioredis` / `node:crypto`. If you think you need these, the logic belongs in W0 or W1.

##### Skeleton

```ts
/**
 * POST /settle — x402 HTTP API settlement endpoint (WFAC-21).
 *
 * Critical difference vs /verify: this endpoint triggers an on-chain write
 * (transferWithAuthorization via EIP-3009). Idempotency is a CORRECTNESS
 * mechanism — if the client re-sends the same body while the tx is in-flight
 * or already mined, we MUST return the cached response without invoking the
 * adapter a second time (double-spend prevention).
 *
 * Layers (top-down, mirrors routes/verify.ts):
 *   1. Zod shape validation → INVALID_PAYLOAD 400.
 *   2. Idempotency cache lookup (CD-9 via isRedisAvailable helper).
 *   3. Core orchestrator dispatch (src/core/settle.ts).
 *   4. Cache successful/non-5xx response (CD-12 via toCacheableSettle).
 *   5. Map Result<SettleResult> → HTTP (CD-2 spec-literal on 200, CD-5 on errors).
 *
 * Logging (SDD §DT-7): 4 line templates. NO PII — CD-3 applies to every line.
 *   tx_hash is AUTHORIZED on success lines (public on-chain data — CD-12 nuevo).
 *
 * CD-1/CD-10 observed: no imports from src/chains/*, src/methods/*, src/infra/*.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  SettleRequestSchema,
  type SettleRequest,
} from '../core/schemas.js';
import { settleCore } from '../core/settle.js';
import {
  buildSettleIdempotencyKey,
  getCachedSettleResponse,
  setCachedSettleResponse,
  isRedisAvailable,
  toCacheableSettle,
  type CachedSettleResponse,
} from '../core/idempotency.js';

/** DT-Zod cap: error.message is capped at 200 chars to keep logs tidy. */
const ZOD_MESSAGE_MAX_LEN = 200;

/** Route-local union: X402ErrorCode + 'INVALID_PAYLOAD' literal. */
type SettleRouteErrorCode =
  | 'INVALID_SIGNATURE'
  | 'INSUFFICIENT_BALANCE'
  | 'PERMIT2_ALLOWANCE_REQUIRED'
  | 'EXPIRED_AUTHORIZATION'
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECEIVER'
  | 'TRANSACTION_FAILED'
  | 'DELEGATION_INVALID'
  | 'INVALID_PAYLOAD';

interface ErrorBody {
  readonly error: {
    readonly code: SettleRouteErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

export const settleRoute: FastifyPluginAsync = async (app) => {
  app.post('/settle', async (request, reply) => {
    const startMs = Date.now();
    const requestId = request.id;

    // Step 1 — Zod validation
    const parseResult = SettleRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : 'body';
      const rawMsg = issue?.message ?? 'invalid';
      const message = `${path}: ${rawMsg}`.slice(0, ZOD_MESSAGE_MAX_LEN);
      const body: ErrorBody = {
        error: { code: 'INVALID_PAYLOAD', message, http: 400 },
      };
      app.log.warn(
        {
          msg: 'settle failed',
          request_id: requestId,
          error_code: 'INVALID_PAYLOAD',
          http_status: 400,
          duration_ms: Date.now() - startMs,
        },
        'settle failed',
      );
      return reply.code(400).send(body);
    }
    const parsed: SettleRequest = parseResult.data;

    // Step 2 — idempotency lookup
    const idempotencyKey = buildSettleIdempotencyKey(parsed);
    const redisUp = isRedisAvailable();
    if (redisUp) {
      const cached = await getCachedSettleResponse(idempotencyKey);
      if (cached) {
        return sendCachedSettle(reply, cached, {
          requestId,
          startMs,
          network: parsed.accepted.network,
          app,
        });
      }
    } else {
      // AC-10 graceful degradation — L2 warn
      app.log.warn(
        { request_id: requestId },
        'idempotency cache miss — Redis unavailable',
      );
    }

    // Step 3 — dispatch to core
    let result;
    try {
      result = await settleCore(parsed);
    } catch (err: unknown) {
      // L4 — adapter threw. Defense-in-depth (CD-4 + SDD §DT-8).
      app.log.error(
        {
          msg: 'settle adapter threw',
          request_id: requestId,
          error_code: 'TRANSACTION_FAILED',
          http_status: 500,
          err_type: (err as Error)?.name ?? 'UnknownError',
          duration_ms: Date.now() - startMs,
        },
        'settle adapter threw',
      );
      const body: ErrorBody = {
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'Internal adapter error',
          http: 500,
        },
      };
      return reply.code(500).send(body);
    }

    // Step 4 — cache (CD-12 filters 5xx inside toCacheableSettle)
    if (redisUp) {
      const cacheable = toCacheableSettle(result);
      if (cacheable) {
        await setCachedSettleResponse(idempotencyKey, cacheable);
      }
    }

    // Step 5 — map Result<SettleResult> → HTTP
    if (!result.ok) {
      // L3 — warn
      app.log.warn(
        {
          msg: 'settle failed',
          request_id: requestId,
          error_code: result.error.code,
          http_status: result.error.http,
          duration_ms: Date.now() - startMs,
        },
        'settle failed',
      );
      return reply
        .code(result.error.http)
        .send({ error: result.error } satisfies ErrorBody);
    }

    // Success — L1 info with tx_hash (CD-12 nuevo; tx_hash is public on-chain).
    app.log.info(
      {
        msg: 'settle ok',
        request_id: requestId,
        network: parsed.accepted.network,
        method: 'eip3009',
        duration_ms: Date.now() - startMs,
        tx_hash: result.transactionHash,
      },
      'settle ok',
    );

    // CD-2 adaptado: spec-literal 200 body — 7 fields, EXPLICIT object build
    // (NO rest-spread destructure — WFAC-20 auto-blindaje W1 lesson).
    return reply.code(200).send({
      settled: result.settled,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      amount: result.amount,
      from: result.from,
      to: result.to,
      asset: result.asset,
    });
  });
};

// ─── helpers (not exported) ─────────────────────────────────────────────────

interface SendCachedCtx {
  readonly requestId: string;
  readonly startMs: number;
  readonly network: string;
  readonly app: {
    readonly log: {
      readonly info: (...a: unknown[]) => void;
      readonly warn: (...a: unknown[]) => void;
    };
  };
}

/**
 * CD-11 nuevo: cached-hit replay reconstructs the 7-field body EXPLICITLY
 * from cached.response. Do NOT `reply.send(cached.response)` — even though
 * the object already has the right shape, an explicit rebuild guarantees
 * that a future refactor of CachedSettleResponseOk cannot leak extra fields
 * into the HTTP response.
 */
function sendCachedSettle(
  reply: FastifyReply,
  cached: CachedSettleResponse,
  ctx: SendCachedCtx,
): FastifyReply {
  const { requestId, startMs, network, app } = ctx;
  if (cached.ok) {
    // CD-12 nuevo: cached success also logs tx_hash.
    app.log.info(
      {
        msg: 'settle ok',
        request_id: requestId,
        network,
        method: 'eip3009',
        duration_ms: Date.now() - startMs,
        tx_hash: cached.response.transactionHash,
        cached: true,
      },
      'settle ok',
    );
    return reply.code(200).send({
      settled: cached.response.settled,
      transactionHash: cached.response.transactionHash,
      blockNumber: cached.response.blockNumber,
      amount: cached.response.amount,
      from: cached.response.from,
      to: cached.response.to,
      asset: cached.response.asset,
    });
  }
  app.log.warn(
    {
      msg: 'settle failed',
      request_id: requestId,
      error_code: cached.error.code,
      http_status: cached.error.http,
      duration_ms: Date.now() - startMs,
      cached: true,
    },
    'settle failed',
  );
  return reply.code(cached.error.http).send({ error: cached.error });
}
```

##### Log templates (reference — adapted from WFAC-20 §DT-Log)

| Line | Level | Trigger | Exact fields |
|------|-------|---------|--------------|
| L1 | info (30) | 200 settle ok (fresh or cached) | `{ msg: "settle ok", request_id, network, method: "eip3009", duration_ms, tx_hash }` — `cached: true` added on cached-hit |
| L2 | warn (40) | Redis unavailable | `{ request_id, msg: "idempotency cache miss — Redis unavailable" }` |
| L3 | warn (40) | 4xx/5xx error (validation or adapter) | `{ msg: "settle failed", request_id, error_code, http_status, duration_ms }` — `cached: true` added on cached-hit |
| L4 | error (50) | Adapter threw (defense) | `{ msg: "settle adapter threw", request_id, error_code: "TRANSACTION_FAILED", http_status: 500, err_type, duration_ms }` |

**CD-3 audit**: no log line includes `parsed.payload.signature`, `parsed.payload.authorization.*`, `parsed.accepted.asset`, `parsed.accepted.payTo`. Only `tx_hash` (public) and structural metadata.

#### 2.B — `src/app.ts` exact modification

**Action**: add one import + one `await app.register(settleRoute);` **immediately after** `await app.register(verifyRoute);` (CD-15 nuevo).

```ts
// ADD to the imports block, AFTER `import { verifyRoute } from './routes/verify.js';`:
import { settleRoute } from './routes/settle.js';

// ADD inside buildApp(), IMMEDIATELY AFTER `await app.register(verifyRoute);`:
await app.register(settleRoute);
```

**Do NOT touch anything else in `src/app.ts`**. The `onClose` Redis hook already covers settle (Redis client is singleton global).

**Verification grep** (run after saving):

```bash
grep -n "verifyRoute\|settleRoute" src/app.ts
# Expected:
#   import { verifyRoute } from './routes/verify.js';
#   import { settleRoute } from './routes/settle.js';
#   await app.register(verifyRoute);
#   await app.register(settleRoute);
```

#### Wave 2 — dependencies

- Depends on W0 (`SettleRequestSchema`, settle idempotency helpers) + W1 (`settleCore`).

#### Wave 2 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 273/273 (new tests come in W3).
- [ ] `git diff src/app.ts` shows exactly **2 added lines** (1 import, 1 `await app.register`).
- [ ] `grep -nE "from '\\.\\./(chains|methods|infra)" src/routes/settle.ts` returns **zero** matches (CD-1 del WI).
- [ ] `grep -n "getRedisClient" src/routes/settle.ts` returns **zero** matches (CD-9 heredado).
- [ ] `grep -n "'/settle'" src/routes/settle.ts` returns exactly **one** match (the `app.post` line).
- [ ] The line order in `src/app.ts` is `healthRoute → verifyRoute → settleRoute` (CD-15 nuevo).

---

### Wave 3 — Tests (3 files NEW, ≥37 tests)

**Objective**: one test per AC (1..14) + tests for every new CD + orchestrator + idempotency helpers. Patterns copied verbatim from WFAC-20 test scaffolds.

#### Files

- `src/__tests__/unit/core.idempotency.settle.test.ts` — **CREATE** (covers W0 settle helpers).
- `src/__tests__/unit/core.settle.test.ts` — **CREATE** (covers W1 `settleCore`).
- `src/__tests__/unit/routes.settle.test.ts` — **CREATE** (covers W2 route, end-to-end per AC).

#### 3.A — Shared test infrastructure (copy from WFAC-20)

All three test files reuse the following patterns. **Copy-paste** from `src/__tests__/unit/routes.verify.test.ts` (E8) and `src/__tests__/unit/core.idempotency.test.ts` (E10):

1. **`vi.mock('ioredis')` with `RedisMock` class**: copy lines 36-86 of `routes.verify.test.ts`. Map-backed get/set with TTL tracker. Add `resetRedisClientForTests()` call in `afterEach`.
2. **`CaptureStream` class**: copy lines 89-102 of `routes.verify.test.ts` verbatim. Writable stream that buffers log lines for assertions.
3. **`makeFakeAdapter(chainIdNum, settleImpl)` helper**: mirror the `makeFakeAdapter` helper from `routes.verify.test.ts`, but swap `verify` and `settle` implementations:

   ```ts
   function makeFakeAdapter(
     chainId: number,
     settleImpl: (params: SettleParams) => Promise<unknown>,
   ): ChainAdapter {
     return {
       metadata: {
         chainId: asChainId(chainId),
         name: `fake-${chainId}`,
         network: 'testnet',
         networkId: `eip155:${chainId}`,
         rpcUrl: 'http://localhost',
         nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
         tokens: [],
       },
       verify: vi.fn() as unknown as ChainAdapter['verify'],
       settle: settleImpl as ChainAdapter['settle'],
       getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
       getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
     };
   }
   ```

4. **`beforeEach` hygiene** (every test file):

   ```ts
   beforeEach(() => {
     chainRegistry._resetForTesting();
     resetRedisClientForTests();
   });
   ```

5. **Fixtures** (put at the top of each test file that needs them):

   ```ts
   // Reuse the WFAC-20 fixture verbatim — the body shape is identical.
   const VALID_BODY = {
     x402Version: 2,
     resource: { url: 'https://example.com/api/resource' },
     accepted: {
       scheme: 'exact',
       network: 'eip155:2368', // fake adapter chainId
       amount: '1000000',
       asset: '0x' + '11'.repeat(20),
       payTo: '0x' + '22'.repeat(20),
       maxTimeoutSeconds: 300,
       extra: { assetTransferMethod: 'eip3009', name: 'PYUSD', version: '1' },
     },
     payload: {
       signature: '0x' + 'ab'.repeat(65),
       authorization: {
         from: '0x' + '33'.repeat(20),
         to: '0x' + '22'.repeat(20),
         value: '1000000',
         validAfter: '0',
         validBefore: '99999999999',
         nonce: '0x' + 'cd'.repeat(32),
       },
     },
   } as const;

   /** CD-13 nuevo: deterministic settle result (no viem, no live calls). */
   const VALID_SETTLE_RESULT = {
     ok: true as const,
     settled: true as const,
     transactionHash: ('0x' + 'de'.repeat(32)) as `0x${string}`, // 66 chars
     blockNumber: 12345,
     amount: '1000000',
     from: ('0x' + '33'.repeat(20)) as `0x${string}`,
     to: ('0x' + '22'.repeat(20)) as `0x${string}`,
     asset: ('0x' + '11'.repeat(20)) as `0x${string}`,
   };
   ```

6. **`buildAppWithAdapter(adapter, opts)` helper** (only in `routes.settle.test.ts`): mirror the helper from `routes.verify.test.ts`. Registers the fake adapter + builds the Fastify app with a `CaptureStream` logger.

---

#### 3.B — `core.idempotency.settle.test.ts` (≥13 tests)

**Imports**:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SETTLE_IDEMPOTENCY_TTL_SEC,
  SETTLE_IDEMPOTENCY_KEY_PREFIX,
  buildSettleIdempotencyKey,
  getCachedSettleResponse,
  setCachedSettleResponse,
  toCacheableSettle,
  isRedisAvailable,
  type CachedSettleResponse,
  type ToCacheableSettleInput,
  // Also pull VERIFY_IDEMPOTENCY_KEY_PREFIX + buildIdempotencyKey to verify
  // the separation invariant (T-I4).
  VERIFY_IDEMPOTENCY_KEY_PREFIX,
  buildIdempotencyKey,
} from '../../core/idempotency.js';
import { resetRedisClientForTests } from '../../infra/redis.js';
```

**Mock strategy**: copy the `vi.mock('ioredis', ...)` block from `core.idempotency.test.ts` (E10). Extend with `get` / `set` / `__throwOnNext` toggles as needed.

**Tests (13 minimum)**:

| # | Test name | Asserts |
|---|-----------|---------|
| T-I1 | `SETTLE_IDEMPOTENCY_TTL_SEC === 120` | Constant equality. |
| T-I2 | `SETTLE_IDEMPOTENCY_KEY_PREFIX === 'settle:idempotency:'` and differs from `VERIFY_IDEMPOTENCY_KEY_PREFIX` | String equality + inequality. |
| T-I3 | `buildSettleIdempotencyKey` is stable across key-order permutations | Two `VerifyRequest` objects with identical values but different root-key order yield equal keys. |
| T-I4 | `buildSettleIdempotencyKey(x) !== buildIdempotencyKey(x)` — prefixes keep verify and settle separated (CD-6) | For the same payload, both keys are distinct strings. |
| T-I5 | `buildSettleIdempotencyKey` differs for distinct payloads | Change `accepted.amount` → different key. |
| T-I6 | `getCachedSettleResponse` returns null when Redis client is null | `resetRedisClientForTests()` + no `initRedis` call → `null`. |
| T-I7 | `getCachedSettleResponse` returns null and does NOT throw when `redis.get` throws | Mock `.get` to reject → assert null return, no unhandled rejection. |
| T-I8 | `setCachedSettleResponse` swallows `.set` errors (CD-4) | Mock `.set` to reject → assert `await setCached...(...)` resolves to undefined. |
| T-I9 | `setCachedSettleResponse` uses `EX` TTL = `SETTLE_IDEMPOTENCY_TTL_SEC` | Spy on mock `.set` — 4th argument is `120`. |
| T-I10 | `setCachedSettleResponse` is a no-op when Redis client is null | No spy invocation; no throw. |
| T-I11 | `toCacheableSettle(http=500)` returns null (CD-12) | Input `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: '...', http: 500 } }` → `null`. |
| T-I12 | `toCacheableSettle(http=502)` returns null (CD-12) | Same, different code/http. |
| T-I13 | `toCacheableSettle(http=4xx)` returns `{ ok: false, error }` verbatim | e.g. http 401 → cached. |
| T-I14 | `toCacheableSettle(ok=success)` preserves the 7 spec-literal fields and NOTHING else | Input success `ToCacheableSettleInput` → output `.response` has exactly `['amount','asset','blockNumber','from','settled','to','transactionHash']` when sorted. |
| T-I15 | `getCachedSettleResponse` round-trips with `setCachedSettleResponse` via RedisMock | set → get → deepEqual the CachedSettleResponse. |

#### 3.C — `core.settle.test.ts` (≥12 tests)

**Imports**:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settleCore } from '../../core/settle.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, SettleParams, SettleResult } from '../../chains/types.js';
// Import VALID_BODY helper + SettleRequest from schemas — NO chains/{kite,avalanche}.
import type { VerifyRequest } from '../../core/schemas.js';
```

**Tests (12 minimum)**:

| # | Test name | Asserts |
|---|-----------|---------|
| T-C1 | `settleCore` accepts canonical body and returns passthrough `settled: true` | Fake adapter `settle` returns `VALID_SETTLE_RESULT`. `settleCore(VALID_BODY)` → same object. |
| T-C2 | `settleCore` returns NETWORK_MISMATCH for malformed network `'solana:1'` | CD-13 heredado. Assert `code === 'NETWORK_MISMATCH'`, `http === 400`. Adapter `settle` NOT called (use `vi.fn()` spy). |
| T-C3 | `settleCore` returns NETWORK_MISMATCH for `'eip155:0'` | Leading-zero / zero chainId rejection. |
| T-C4 | `settleCore` returns NETWORK_MISMATCH when chainId overflows MAX_SAFE_INTEGER | `'eip155:' + '9'.repeat(20)` → NETWORK_MISMATCH (CD-14). |
| T-C5 | `settleCore` returns NETWORK_MISMATCH when `assetTransferMethod !== 'eip3009'` | `extra.assetTransferMethod = 'permit2'` + fake adapter registered → NETWORK_MISMATCH. Adapter `settle` NOT called. |
| T-C6 | `settleCore` returns `lookup.error` (CHAIN_NOT_SUPPORTED) when chainId not registered | Empty registry + valid `'eip155:999999'` → passthrough of registry error. |
| T-C7 | `settleCore` passes `VerifyRequest` → `SettleParams` reference to `adapter.settle` unchanged | Spy fake adapter; assert `settleSpy.mock.calls[0][0]` has the same 7 accepted fields. |
| T-C8 | `settleCore` returns the Result verbatim on adapter success | Fake adapter returns `{ ok: true, ...VALID_SETTLE_RESULT }` → `settleCore` returns the same. |
| T-C9 | `settleCore` returns the Result verbatim on adapter error | Fake adapter returns `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: '...', http: 401 } }` → passthrough. |
| T-C10 | `settleCore` does NOT catch adapter exceptions (CD-4 + SDD §DT-8) | Fake adapter `settle` throws `new Error('adapter boom')` → `await expect(settleCore(...)).rejects.toThrow('adapter boom')`. |
| T-C11 | `settleCore` does NOT invoke `adapter.verify` (dispatches to `.settle` only) | Assert `verifySpy.not.toHaveBeenCalled()`, `settleSpy.toHaveBeenCalledOnce()`. Prevents typo regression (R2 in SDD §9). |
| T-C12 | `settleCore` accepts `'eip155:2368'` fake chain and returns success | Happy path end-to-end of the orchestrator alone. |

#### 3.D — `routes.settle.test.ts` (≥15 tests — 14 ACs + CD extras + app.ts integration)

**Imports**:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { resetRedisClientForTests } from '../../infra/redis.js';
import type { ChainAdapter, SettleParams, SettleResult } from '../../chains/types.js';
// CD-16 heredado: NO imports from src/chains/kite.ts or src/chains/avalanche.ts.
```

**Tests (15 minimum — 14 AC mappings + 4 CD mappings)**:

| # | AC / CD | Test name | Strategy |
|---|---------|-----------|----------|
| T-R1 | AC-1 | `POST /settle returns 200 with exact 7-field SettleResult body` | Fake adapter returns `VALID_SETTLE_RESULT`. `app.inject({ method: 'POST', url: '/settle', payload: VALID_BODY })`. Assert statusCode 200. Assert `Object.keys(body).sort()` === `['amount','asset','blockNumber','from','settled','to','transactionHash']`. Assert `body.settled === true`, `body.transactionHash === VALID_SETTLE_RESULT.transactionHash`. |
| T-R2 | AC-2 | `returns 400 INVALID_PAYLOAD on malformed body and does NOT invoke adapter.settle` | 3 sub-cases: missing `x402Version`, `x402Version = 1`, missing `resource`. Spy on `fakeAdapter.settle`. Assert `settleSpy.not.toHaveBeenCalled()`. Assert `body.error.code === 'INVALID_PAYLOAD'`, `body.error.http === 400`. |
| T-R3 | AC-3 | `returns 400 NETWORK_MISMATCH for bad network format or unregistered chain` | 3 sub-cases: `network = 'solana:1'`, `network = 'eip155:0'`, `network = 'eip155:999999'` (not registered). Assert each returns 400 with code NETWORK_MISMATCH. |
| T-R4 | AC-4 | `returns 401 INVALID_SIGNATURE passthrough from adapter` | Fake adapter `settle` returns `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 } }`. Assert statusCode 401, body === `{ error: { code: 'INVALID_SIGNATURE', message: 'bad sig', http: 401 } }`. |
| T-R5 | AC-5 | `returns 402 INSUFFICIENT_BALANCE passthrough from adapter` | Adapter returns http 402. Assert statusCode 402, body.error.code. |
| T-R6 | AC-6 | `returns 500 SIMULATION_FAILED and does NOT cache (two calls → adapter called twice)` | Fake adapter returns http 500 with code SIMULATION_FAILED. First inject 500, second inject 500. Assert `settleSpy.toHaveBeenCalledTimes(2)` (CD-12 heredado — no 5xx caching). |
| T-R7 | AC-7 | `returns 500 TRANSACTION_FAILED and does NOT cache` | Same as T-R6 with code TRANSACTION_FAILED. |
| T-R8 | AC-8 | `idempotency hit on success — second identical request returns cached body, adapter called once` | Fake adapter returns `VALID_SETTLE_RESULT`. First inject caches in RedisMock. Second inject reads cache. Assert `settleSpy.toHaveBeenCalledTimes(1)`, `r1.body === r2.body` (byte-exact), statusCode 200 twice. |
| T-R9 | AC-9 | `idempotency hit on 4xx — cached error replays verbatim` | Fake adapter returns http 401. First inject caches. Second inject reads cache. Assert `settleSpy.toHaveBeenCalledTimes(1)`, both responses identical (statusCode 401, same body). |
| T-R10 | AC-10 | `Redis unavailable → warn log + proceeds` | `resetRedisClientForTests()` + no `initRedis`. Happy-path inject. Assert statusCode 200. Assert CaptureStream contains a line with `msg: 'idempotency cache miss — Redis unavailable'` and `request_id`. |
| T-R11 | AC-11 | `adapter throws → 500 TRANSACTION_FAILED + error log` | Fake adapter `settle` throws `new Error('boom')`. Assert statusCode 500, body === `{ error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 } }`. Assert error log line `msg: 'settle adapter threw'` with `err_type: 'Error'`, `http_status: 500`, `duration_ms` is a number. |
| T-R12 | AC-12 | `success log contains tx_hash and NO PII` | Happy path. Find info log `msg: 'settle ok'`. Assert fields: `request_id`, `network: 'eip155:2368'`, `method: 'eip3009'`, `duration_ms` (number), `tx_hash === VALID_SETTLE_RESULT.transactionHash`. Assert `JSON.stringify(logLine)` does NOT contain `VALID_BODY.payload.signature`, `VALID_BODY.payload.authorization.nonce`, `VALID_BODY.payload.authorization.from`, `VALID_BODY.payload.authorization.to`. |
| T-R13 | AC-13 | `error log has error_code + http_status + duration_ms and NO PII` | Loop 3 error cases (INVALID_PAYLOAD, NETWORK_MISMATCH, INVALID_SIGNATURE via adapter). For each: find warn log `msg: 'settle failed'`. Assert the 3 fields present + `request_id`. Assert `JSON.stringify(logLine)` does NOT contain signature/nonce/from/to raw values. |
| T-R14 | AC-14 | `non-JSON Content-Type → 415 or 400 (Fastify default)` | `app.inject({ method: 'POST', url: '/settle', headers: { 'content-type': 'text/plain' }, payload: '{}' })`. Assert `res.statusCode in [400, 415]`. |
| T-R15 | CD-11 nuevo | `cached 200 replay → body is byte-exact identical to fresh response` | Two happy-path injects. Assert `r1.payload === r2.payload` (string comparison). Assert `r2.payload` does NOT contain extra keys beyond the 7 spec-literal fields. |
| T-R16 | CD-12 nuevo | `cached-hit success log ALSO contains tx_hash` | Second inject (cached path). Find info log with `cached: true`. Assert `tx_hash === VALID_SETTLE_RESULT.transactionHash`. |
| T-R17 | CD-15 nuevo | `buildApp() registers both verifyRoute and settleRoute — both injects succeed in same instance` | Build app once. Inject POST `/verify` → statusCode ∈ [400,401,500] (without a valid fake verify adapter, any non-200 is fine — just asserting the route exists; optionally register a fake verify too). Inject POST `/settle` → 200 with valid body. Both routes respond. |
| T-R18 | CD-6 heredado | `same body sent to /verify and /settle does NOT produce a key collision` | Sanity-check against the prefix separation. Send one POST `/settle` (happy path). Use `buildIdempotencyKey(VALID_BODY)` + `buildSettleIdempotencyKey(VALID_BODY)` from `core/idempotency.ts` directly (imported in the test) — assert the two strings start with different prefixes. (No HTTP call needed; this is a prefix-hygiene guard.) |

**Total expected**: 15 (idempotency settle) + 12 (core.settle) + 18 (routes.settle) = **45 tests minimum** (≥ 37 target).

#### Wave 3 — dependencies

- Depends on W0, W1, W2.

#### Wave 3 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` green with **≥310 total** (273 baseline + ≥37 new).
- [ ] Every AC (AC-1 … AC-14) has ≥1 test as per §3 matrix.
- [ ] `grep -nE "from '.*/(kite|avalanche)" src/__tests__/unit/{routes,core,core}.settle{,idempotency.settle}.test.ts 2>/dev/null` returns **zero** matches (CD-16 heredado — no production adapter imports).
- [ ] `grep -n "writeContract\|simulateContract" src/__tests__/unit/routes.settle.test.ts` returns **zero** matches (CD-13 nuevo — fake adapter only).
- [ ] Test coverage for `src/core/settle.ts` + `src/routes/settle.ts` ≥ 90% (auto-blindaje WFAC-20 mandate).

---

## 2. Constraint Directives (inherited WFAC-20 + WFAC-21-specific)

**MANDATORY** — these are the contract. Each CD cites the file(s) where compliance is verified.

### Inherited from work-item WFAC-21 (CD-1 … CD-10 del WI)

| CD | Rule | Verified in |
|----|------|-------------|
| CD-1 (WI) | **PROHIBIDO** que `src/routes/settle.ts` importe de `src/chains/*`, `src/methods/*`, `src/infra/*` (salvo vía helpers de `src/core/idempotency.ts`). | `src/routes/settle.ts` imports list; §1 W2 "Imports permitidos". |
| CD-2 (WI) | **OBLIGATORIO** response 200 spec-literal: 7 fields `{ settled, transactionHash, blockNumber, amount, from, to, asset }` — NO `ok` discriminant, NO extra fields. | `src/routes/settle.ts` explicit object build. Tests T-R1, T-R15. |
| CD-3 (WI) | **PROHIBIDO** loggear `payload.signature`, `payload.authorization.*` in any log level. | `src/routes/settle.ts` — no log includes `parsed.payload.*`. Tests T-R12, T-R13. |
| CD-4 (WI) | **OBLIGATORIO** que `src/core/settle.ts` never throws for foreseeable errors. | §1 W1 skeleton — every error path returns `Result<T>`. Test T-C10. |
| CD-5 (WI) | **OBLIGATORIO** error responses use `{ error: { code, message, http } }` spec-literal. | `src/routes/settle.ts` — every `reply.send({ error: ... })` matches. Tests T-R4, T-R5, T-R11. |
| CD-6 (WI) | **OBLIGATORIO** idempotency key prefix `'settle:idempotency:'` distinct from verify. | `src/core/idempotency.ts` — `SETTLE_IDEMPOTENCY_KEY_PREFIX`. Tests T-I2, T-I4, T-R18. |
| CD-7 (WI) | **PROHIBIDO** hardcoding TTL `120` anywhere except `SETTLE_IDEMPOTENCY_TTL_SEC`. | `grep -n "120" src/core/settle.ts src/routes/settle.ts` returns **zero** matches outside the constant def. Test T-I1, T-I9. |
| CD-8 (WI) | **OBLIGATORIO** reuse `canonicalStringify` from `src/core/idempotency.ts` — no duplication. | `src/core/idempotency.ts` — `buildSettleIdempotencyKey` calls `canonicalStringify` directly. |
| CD-9 (WI) | **PROHIBIDO** `src/core/settle.ts` imports from `src/methods/*` — dispatch vía registry only. | `grep -n "from '../methods" src/core/settle.ts` returns **zero**. |
| CD-10 (WI) | **OBLIGATORIO** `src/app.ts` registers `settleRoute` with `await app.register(settleRoute)` — no `.then()` without await. | `src/app.ts` — explicit `await`. Test T-R17. |

### Inherited from WFAC-20 SDD (CD-11 … CD-16 heredados)

| CD | Rule | Verified in |
|----|------|-------------|
| CD-11 (WFAC-20) | **OBLIGATORIO** `canonicalStringify` deterministic across key-order permutations. | Test T-I3. |
| CD-12 (WFAC-20) | **PROHIBIDO** cachear responses con `http >= 500`. | `src/core/idempotency.ts` — `toCacheableSettle` returns null for >= 500. Tests T-I11, T-I12, T-R6, T-R7. |
| CD-13 (WFAC-20) | **OBLIGATORIO** regex network `/^eip155:([1-9]\d*)$/u` (no leading zeros, no zero, no negatives). | `src/core/settle.ts` `EIP155_RE`. Tests T-C2, T-C3, T-R3. |
| CD-14 (WFAC-20) | **PROHIBIDO** `Number()` for chainId overflow. Use BigInt + length guard. | `src/core/settle.ts` overflow block. Test T-C4. |
| CD-15 (WFAC-20) | **OBLIGATORIO** tests use fake adapters registered explicitly. | `src/__tests__/unit/*.settle.test.ts` — `makeFakeAdapter` helper; no production adapter imports. |
| CD-16 (WFAC-20) | **PROHIBIDO** importar `src/chains/kite.ts` / `src/chains/avalanche.ts` from any new test file. | Grep enforcement in §3 completion criteria. |

### WFAC-21-specific architectural CDs (CD-11 … CD-15 nuevos — del SDD §4)

| CD | Rule | Verified in |
|----|------|-------------|
| CD-11 (new) | **OBLIGATORIO** cached-hit replay reconstructs the 7-field body EXPLICITLY from `cached.response` — no `reply.send(cached.response)` directly. | `src/routes/settle.ts` `sendCachedSettle`. Test T-R15. |
| CD-12 (new) | **OBLIGATORIO** success log includes `tx_hash: result.transactionHash`. For cached-hit, `cached.response.transactionHash`. | `src/routes/settle.ts` L1 template. Tests T-R12, T-R16. |
| CD-13 (new) | **OBLIGATORIO** route tests use a fake adapter whose `settle()` returns a deterministic `SettleResult`. **PROHIBIDO** que el fake adapter invoque `viem` (`writeContract`, `simulateContract`, etc.). | `src/__tests__/unit/routes.settle.test.ts` — `VALID_SETTLE_RESULT` fixture, `makeFakeAdapter` stubs `getWalletClient`/`getPublicClient` with `vi.fn()`. Grep: no `writeContract` / `simulateContract` strings. |
| CD-14 (new) | **PROHIBIDO** que la extensión de `src/core/idempotency.ts` rompa los tests existentes de WFAC-20 en `src/__tests__/unit/core.idempotency.test.ts`. | CI: `npm run test -- core.idempotency.test.ts` green post-W0. Also `routes.verify.test.ts` must stay green. |
| CD-15 (new) | **OBLIGATORIO** `src/app.ts` registra `settleRoute` INMEDIATAMENTE DESPUÉS de `verifyRoute`. Orden: `healthRoute → verifyRoute → settleRoute`. **PROHIBIDO** `.register(...).then(...)` sin `await`. | `src/app.ts` — grep verification in W2 completion. Test T-R17. |

---

## 3. AC → Wave → Test matrix

| AC | Description | Satisfied by wave | Test id(s) |
|----|-------------|-------------------|------------|
| AC-1 | Happy path 200 with 7-field SettleResult body | W2 | T-R1 |
| AC-2 | 400 INVALID_PAYLOAD on Zod failure, adapter NOT called | W0 + W2 | T-R2 |
| AC-3 | 400 NETWORK_MISMATCH on malformed network or unregistered chain | W1 + W2 | T-R3 |
| AC-4 | 401 INVALID_SIGNATURE passthrough | W1 + W2 | T-R4 |
| AC-5 | 402 INSUFFICIENT_BALANCE passthrough | W1 + W2 | T-R5 |
| AC-6 | 500 SIMULATION_FAILED + NOT cached | W1 + W2 | T-R6 |
| AC-7 | 500 TRANSACTION_FAILED + NOT cached | W1 + W2 | T-R7 |
| AC-8 | Idempotency hit on success — adapter called once, bodies identical | W0 + W2 | T-R8, T-R15 |
| AC-9 | Idempotency hit on 4xx — cached error replays | W0 + W2 | T-R9 |
| AC-10 | Redis unavailable → warn log + proceed | W0 + W2 | T-R10 |
| AC-11 | Adapter throws → 500 + error log | W2 | T-R11 |
| AC-12 | Success log with `tx_hash`, no PII | W2 | T-R12, T-R16 |
| AC-13 | Error log with `error_code` + `http_status` + `duration_ms`, no PII | W2 | T-R13 |
| AC-14 | Non-JSON Content-Type → 415 or 400 (Fastify default) | W2 | T-R14 |

**Total AC-tests**: 14 ACs mapped to ≥14 test cases (some ACs have multiple sub-cases in one test). Full suite target: **≥37 new tests**, **≥310 total** after merge.

---

## 4. Guardrails anti-drift (Dev — read literally)

### 4.1 DO NOT

- **DO NOT** touch `src/core/verify.ts`. It is frozen for this HU. Even if you feel the DRY urge to factor `EIP155_RE` + `MAX_CHAINID_DIGITS` to a shared helper, **DO NOT**. Open a follow-up HU if a third consumer appears later. (Auto-blindaje WFAC-21 lesson.)
- **DO NOT** touch `src/routes/verify.ts`. Same reason.
- **DO NOT** touch `src/__tests__/unit/core.idempotency.test.ts`, `core.verify.test.ts`, `routes.verify.test.ts`. They stay green as-is (CD-14 nuevo).
- **DO NOT** duplicate `canonicalStringify` or `isRedisAvailable`. Reuse from `src/core/idempotency.ts` (CD-8 del WI).
- **DO NOT** hardcode `120` outside `SETTLE_IDEMPOTENCY_TTL_SEC`. CD-7 del WI.
- **DO NOT** hardcode the prefix `'settle:idempotency:'` outside `SETTLE_IDEMPOTENCY_KEY_PREFIX`.
- **DO NOT** `request.body as any` in the route. Zod is the only source of truth.
- **DO NOT** import `viem`, `ioredis`, or `node:crypto` in `src/routes/settle.ts`. Wrong layer.
- **DO NOT** import `src/chains/kite.ts` or `src/chains/avalanche.ts` from any test file. They throw on load if env missing (CD-16 heredado).
- **DO NOT** call `viem.writeContract` or `viem.simulateContract` from tests (CD-13 nuevo). Fake adapter returns pre-computed `SettleResult`.
- **DO NOT** log `request.body`, `parsed.payload`, `parsed.payload.signature`, or `parsed.payload.authorization.*` fields (CD-3 del WI).
- **DO NOT** log wallet addresses (`from`, `to`, `asset`, `payTo`) in WARN/ERROR lines. Only `tx_hash` is authorized — and ONLY on info-level success lines (CD-12 nuevo).
- **DO NOT** add a dependency to `package.json`. All deps exist already.
- **DO NOT** modify `src/chains/*`, `src/methods/*`, `src/infra/*`. Scope IN enforces this.
- **DO NOT** try to "generalize" the route into a `src/routes/_common.ts`. WFAC-21 is scoped to /settle; extraction lives in a future refactor HU.
- **DO NOT** swallow unexpected errors silently in the route. The adapter-throw path uses L4 log + 500 response — never bare `catch {}`.
- **DO NOT** modify `src/app.ts` beyond the two additions (1 import + 1 `await app.register`). Preserve the onClose Redis hook.
- **DO NOT** add try/catch around `asChainId(Number(digits))` in `settleCore`. The regex + BigInt guards make the cast unreachable-fail. Adding a defensive catch creates dead branches that tank coverage (WFAC-20 auto-blindaje W4 lesson).
- **DO NOT** pre-process EIP-2098 compact signatures in the route or core. viem's internal signature-recovery path handles 64-byte + 65-byte forms correctly (verified in WFAC-13). The adapter is the source of truth.

### 4.2 IF you encounter discrepancy

**If the codebase reality contradicts this Story File, STOP AND REPORT. Examples:**

- A WFAC-20 test fails after W0 → **STOP**. You modified verify exports (CD-14 nuevo violation). Revert and re-read §1 W0.
- `settleEip3009` returns a shape that is not `{ ok, settled, transactionHash, blockNumber, amount, from, to, asset }` → **STOP**. The adapter contract changed; Architect must review. Do NOT adapt the route shape silently.
- `chainRegistry.getAdapter(chainId)` does not return a `Result<{ adapter }>` → **STOP**. (It does — see E6/exemplars.)
- `SettleRequest` is not structurally assignable to `SettleParams` (W1 `as unknown as SettleParams` flagged by TS build) → **STOP**. Your W0 schema alias is wrong. Do NOT use `as any`.
- The first cached-hit test (T-R8) shows `settleSpy.toHaveBeenCalledTimes(2)` instead of 1 → **STOP**. Either the Redis mock is broken OR the route is bypassing the cache branch. Check `isRedisAvailable()` + `getCachedSettleResponse` return value + `sendCachedSettle` early return.

**Report template** (paste into the PR / chat):

> **Story File discrepancy** at W[0-3]: expected `<path>` to `<expectation>`, but actual is `<observation>`. Cannot proceed without Architect clarification.

### 4.3 Pre-commit sanity checks (run after EVERY wave)

```bash
# Mandatory before git add:
npm run build                                                        # exit 0
npm run lint                                                         # exit 0
npm test -- --run                                                    # exit 0 (≥273 pre-W3; ≥310 post-W3)

# Scope + boundary grep checks:
git status                                                           # only scope-IN files
git diff src/app.ts                                                  # W2 only: exactly 2 added lines

grep -nE "from '\\.\\./(chains|methods|infra)" src/routes/settle.ts   # 0 matches (CD-1 del WI)
grep -n "getRedisClient" src/routes/settle.ts                         # 0 matches (CD-9 heredado)
grep -n "from '../methods" src/core/settle.ts                         # 0 matches (CD-9 del WI)
grep -nE "from '.*/(kite|avalanche)" src/__tests__/unit/*.settle*.test.ts  # 0 matches (CD-16)
grep -n "writeContract\|simulateContract" src/__tests__/unit/routes.settle.test.ts  # 0 matches (CD-13 nuevo)
grep -c "120" src/core/idempotency.ts                                 # exactly 2 (VERIFY_IDEMPOTENCY_TTL_SEC + SETTLE_IDEMPOTENCY_TTL_SEC)

# CD-14 regression guard (critical):
npm test -- --run core.idempotency.test.ts                            # green
npm test -- --run routes.verify.test.ts                               # green
npm test -- --run core.verify.test.ts                                 # green

# CD-15 order guard:
grep -n "app.register" src/app.ts                                     # verifyRoute before settleRoute
```

---

## 5. Done Definition (how we know HU-21 is complete)

- [ ] All 8 Scope IN files (§0.5) exist / modified as specified.
- [ ] `npm run build` green.
- [ ] `npm run lint` green (zero warnings).
- [ ] `npm test -- --run`: **≥310 tests green** (273 baseline + ≥37 new).
- [ ] Every AC (AC-1 … AC-14) mapped to ≥1 test — §3 matrix.
- [ ] All 21 CDs verified via grep/test/inspection — §2 tables (10 CDs del WI + 6 heredados WFAC-20 + 5 nuevos arquitectónicos).
- [ ] No files outside Scope IN changed — `git diff --name-only main` matches §0.5.
- [ ] CD-14 regression guard: all 4 WFAC-20 test files (`core.idempotency.test.ts`, `core.verify.test.ts`, `routes.verify.test.ts`, `chain-adapter.test.ts`) remain green post-changes.
- [ ] Branch `feat/010-wfac-21-settle-route` has linear history rooted at main commit `1b5be9b`.

---

## 6. Historical Auto-Blindaje inheritance (from WFAC-6, WFAC-10, WFAC-13, WFAC-20)

Lessons applied to this Story File:

| Lesson | From | Protection here |
|--------|------|-----------------|
| Regex `/^\d+$/` accepts leading zeros → use `/^(0\|[1-9]\d*)$/` | WFAC-6 BLQ-BAJO-1 | CD-13 heredado; `EIP155_RE` in W1. Tests T-C3, T-R3. |
| `Number(uint256)` loses precision → use BigInt for boundary checks | WFAC-6 BLQ-MED-1 | CD-14 heredado; BigInt overflow guard in W1. Test T-C4. |
| `BigInt("abc")` throws without Zod pre-validation → validate shape FIRST | WFAC-6 BLQ-ALTO-2 | W0 `SettleRequestSchema` runs before W1 invokes BigInt. Tests T-V1 (via VALID_BODY fixture). |
| Test fixtures generating signatures must use canonical helpers | WFAC-10 F3.1 | `routes.settle.test.ts` uses `VALID_SETTLE_RESULT` fixture + fake adapter; no viem signing. §3.A. |
| viem `recoverTypedDataAddress` only accepts 65-byte canonical sigs | WFAC-13 | Not directly applicable — route delegates to adapter. CD-13 nuevo keeps fake adapter deterministic. |
| ESLint `no-unused-vars` rejects `const { ok: _ok, ...rest } = result` | WFAC-20 W1 auto-blindaje | **Applied**: CD-11 nuevo mandates EXPLICIT object build. Route 200 body + `sendCachedSettle` + `toCacheableSettle` all use `{ settled, transactionHash, ... }` literal. |
| Unreachable defensive branches tank coverage | WFAC-20 W4 auto-blindaje | **Applied**: §1 W1 "NO try/catch around `asChainId`". §4.1 "DO NOT". |
| `VerifyRequest` not structurally assignable to `VerifyParams` (Zod regex narrowing) | WFAC-20 W0 auto-blindaje | **Applied**: `as unknown as SettleParams` cast in `settleCore` (§1 W1) with comment citing the auto-blindaje entry. |
| Auto-blindaje WFAC-21 **new lesson**: don't refactor shared regex across verify/settle in this HU | This HU | **Applied**: §4.1 "DO NOT touch `src/core/verify.ts`". §1 W1 inline comment. |

---

## 7. Reporting template (use at end of each wave)

After closing a wave, post in the PR / chat:

> **Wave N complete — WFAC-21**
> - Files: <list of files changed/created>
> - Tests: <new count> passing (<delta> new) · total <total>
> - Grep checks: ALL 0 or expected
> - CD-14 regression guard: <verify.ts + idempotency.ts WFAC-20 test files green>
> - Ready for Wave <N+1> / ready for AR

---

*Generated by nexus-architect · F2.5 Story File · 2026-04-23 · WFAC-21*
