# Story File — HU-20 POST /verify route (WFAC-20)

- **Work Item**: `doc/sdd/009-wfac-20-verify-route/work-item.md`
- **SDD**: `doc/sdd/009-wfac-20-verify-route/sdd.md`
- **Pipeline**: QUALITY · **Sizing**: L · **SDD_MODE**: full
- **Branch**: `feat/009-wfac-20-verify-route` (already created, currently clean)
- **Baseline commit (main)**: `03474d7 docs(WFAC-13): DONE report + _INDEX.md closure`
- **Baseline tests**: 218 passed (15 files) · **Target**: ~243 (218 + ~25 new)
- **Architect**: nexus-architect · **Fecha**: 2026-04-23

---

## 0. Pre-flight — READ BEFORE EACH WAVE

**Stop and read this before writing a single line of code per wave.**

### 0.1 Required reading

1. This file (`story-HU-20.md`) — **it is the only contract you MUST follow**.
2. The **exemplars** listed in §0.4 — consult ONLY the relevant ones for the wave you are on.
3. DO NOT read work-item.md or sdd.md unless you hit an ambiguity and suspect this story is wrong.

### 0.2 Environment check

```
pwd  # must be /home/ferdev/.openclaw/workspace/wasiai-facilitator
git rev-parse --abbrev-ref HEAD  # must be feat/009-wfac-20-verify-route
git status  # must be clean at start; after each wave, only scope IN files may appear
npm test -- --run  # must be 218/218 BEFORE W0, growing toward ~243 at end of W4
```

### 0.3 Anti-Hallucination Checklist (per wave)

Before starting a wave:

- [ ] Did you read THIS Story File end-to-end?
- [ ] Did you read the exemplar files listed for THIS wave (and only those)?
- [ ] Did you verify every import path with `ls` or `Read` before writing it?
- [ ] Did you confirm that **no file outside the Scope IN table (§0.5)** will be touched?
- [ ] Did you confirm that the **wave dependencies** (§0.6) are all green (build + tests)?

Before closing a wave:

- [ ] `npm run build` is green.
- [ ] `npm run lint` is green (`eslint.config.js` zero-warnings policy).
- [ ] `npm test -- --run` passes at least the baseline count (218) + any new tests from this wave.
- [ ] You did NOT modify any file outside the wave's declared "Files" list.
- [ ] You did NOT add a dependency in `package.json`. (There is NO dep change in this HU — if you think you need one, STOP and report.)

### 0.4 Exemplars verified in SDD §6 (paths confirmed to exist)

| # | Path | Read it for |
|---|------|-------------|
| E1 | `src/routes/health.ts` | Plugin pattern (`FastifyPluginAsync`, `app.post/get`, `config: { rateLimit: false }`). Used by W3. |
| E2 | `src/app.ts` | `buildApp` factory + `await app.register(...)` + `initRedis(env, logger)` + onClose. Used by W3 (modification). |
| E3 | `src/methods/eip3009/schemas.ts` | `AddressHexSchema`, `Bytes32HexSchema`, `Uint256StringSchema`, `Eip3009AuthorizationSchema`. **W0 RE-USES these — DO NOT duplicate**. |
| E4 | `src/methods/eip3009/verify.ts` | Adapter verify signature `(params, token, chainId) → Promise<AdapterResult<VerifyResult>>`. W2 CONSUMES via registry — does not import directly. |
| E5 | `src/chains/registry.ts` | `chainRegistry.getAdapter(chainId)` returns `Result<{ adapter }>`; `_resetForTesting()` for tests. |
| E6 | `src/chains/types.ts` | `VerifyParams`, `VerifyResult`, `AdapterResult<T>`, `ChainAdapter`. Type-only imports. |
| E7 | `src/core/errors.ts` | `buildX402Error(code, message?)`, `HTTP_BY_CODE`, `DEFAULT_MESSAGE_BY_CODE`. Pure, no deps. |
| E8 | `src/core/types.ts` | `asChainId()`, `X402ErrorCode`, `Result<T>`, `Err`. |
| E9 | `src/infra/redis.ts` | `getRedisClient() → Redis \| null`, `resetRedisClientForTests()`. |
| E10 | `src/infra/logger.ts` | `createLogger(env, destination?)`. W4 only (no modification). |
| E11 | `src/__tests__/unit/health.test.ts` | `CaptureStream` class + `app.inject()` + log line assertions. **W4 PATTERN SOURCE.** |
| E12 | `src/__tests__/unit/redis.test.ts` | `vi.mock('ioredis')` + `RedisMock` class + `__emit` helper. **W4 idempotency test pattern.** |
| E13 | `src/__tests__/unit/methods/eip3009/verify.test.ts` | EIP-3009 signature fixture helpers for AC-6/AC-7 scenarios. Do NOT re-implement signing. |

### 0.5 Scope IN — the ONLY files you may touch

| Path | Action | Wave |
|------|--------|------|
| `src/core/schemas.ts` | CREATE | W0 |
| `src/core/idempotency.ts` | CREATE | W1 |
| `src/core/verify.ts` | CREATE | W2 |
| `src/routes/verify.ts` | CREATE | W3 |
| `src/app.ts` | MODIFY (one line: register verifyRoute) | W3 |
| `src/__tests__/unit/routes.verify.test.ts` | CREATE | W4 |
| `src/__tests__/unit/core.verify.test.ts` | CREATE | W4 |
| `src/__tests__/unit/core.idempotency.test.ts` | CREATE | W4 |

**ANY edit to any other file = Story File violation. STOP AND REPORT.**

### 0.6 Wave dependency graph

```
W0 (schemas)    ──────────────┐
                              ├──► W2 (core/verify)
W1 (idempotency) ──────────────┘          │
                                          ▼
                              W3 (routes/verify + app.ts)
                                          │
                                          ▼
                              W4 (3 tests files)
```

- **W0 → W1**: W1 imports `VerifyRequest` type from W0.
- **W0 → W2**: W2 imports `VerifyRequest` type from W0.
- **W0, W1, W2, W3 → W4**: tests exercise everything.
- **No forward references**. If W1 needs something from W2, we have a design bug — STOP AND REPORT.

---

## 1. Waves

### Wave 0 — `src/core/schemas.ts` (Zod x402 schemas)

**Objective**: declare `VerifyRequestSchema` + subsidiary Zod schemas that are asignables to `VerifyParams` in `src/chains/types.ts`. **Single source of truth for x402 body shape validation.**

#### Files

- `src/core/schemas.ts` — **CREATE**.

#### Imports allowed (OWNERS boundary)

```ts
import { z } from 'zod';
import {
  AddressHexSchema,
  Bytes32HexSchema,
  Uint256StringSchema,
  Eip3009AuthorizationSchema,
} from '../methods/eip3009/schemas.js';
```

- Type-only imports from `../chains/types.js` are permitted ONLY if unavoidable (the schemas are structural — try to avoid this).

#### Imports PROHIBIDOS

- `src/routes/*`, `src/infra/*`, `src/chains/{registry,kite,avalanche}.ts` (any runtime import from chains/adapters).
- `src/methods/eip3009/verify.ts` or any non-`schemas.ts` file inside `src/methods/*`.

#### Skeleton

```ts
/**
 * Zod schemas for the x402 POST /verify request body (spec-literal).
 *
 * Exports:
 *   - ResourceSchema
 *   - AcceptedExtraSchema
 *   - AcceptedSchema (extends the method-local AcceptedSchema with the
 *     full x402 resource/accepted shape)
 *   - PayloadSchema
 *   - VerifyRequestSchema  ← TOP-LEVEL
 *   - type VerifyRequest = z.infer<typeof VerifyRequestSchema>
 *
 * Boundary: re-uses primitive validators from src/methods/eip3009/schemas.ts
 * (DO NOT duplicate Bytes32HexSchema/AddressHexSchema/Uint256StringSchema).
 *
 * CD-8 (heredado): x402Version MUST be z.literal(2), not z.number().
 */

import { z } from 'zod';
import {
  AddressHexSchema,
  Bytes32HexSchema,
  Uint256StringSchema,
  Eip3009AuthorizationSchema,
} from '../methods/eip3009/schemas.js';

export const ResourceSchema = z
  .object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .strict();

export const AcceptedExtraSchema = z
  .object({
    assetTransferMethod: z.enum(['eip3009', 'permit2', 'erc7710']),
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .strict();

export const AcceptedSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z.string().min(1),
    amount: Uint256StringSchema,
    asset: AddressHexSchema,
    payTo: AddressHexSchema,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: AcceptedExtraSchema,
  })
  .strict();

export const PayloadSchema = z
  .object({
    // Hex signature: 0x + at least 2 hex chars. Exact length guards are
    // adapter concern (EIP-3009 adapter enforces 65-byte / EIP-2098 64-byte
    // in src/methods/eip3009/verify.ts). Here we only enforce 0x-prefix.
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u, 'signature must be 0x-prefixed hex'),
    authorization: Eip3009AuthorizationSchema,
  })
  .strict();

export const VerifyRequestSchema = z
  .object({
    x402Version: z.literal(2),            // CD-8
    resource: ResourceSchema,
    accepted: AcceptedSchema,
    payload: PayloadSchema,
  })
  .strict();

export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
```

#### Wave 0 — dependencies

- Depends on NOTHING inside this HU. Reuses `src/methods/eip3009/schemas.ts` which is already in main.

#### Wave 0 — tests

- **None in this wave.** Schema tests are written in W4 inside `core.verify.test.ts` (see §2 AC-3 entry).

#### Wave 0 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 218/218 (no regression, no new tests).
- [ ] `VerifyRequest` is assignable to `VerifyParams` from `src/chains/types.ts` (verify via a throw-away TS `const _check: VerifyParams = {} as VerifyRequest;` in a scratch file if unsure — then **delete the scratch file**; DO NOT commit).
- [ ] `git status` shows ONLY `src/core/schemas.ts` as new.

---

### Wave 1 — `src/core/idempotency.ts` (SHA-256 canonical key + Redis cache)

**Objective**: compute a deterministic idempotency key from a parsed `VerifyRequest` and read/write a cached response from Redis with graceful fallback when Redis is unavailable.

#### Files

- `src/core/idempotency.ts` — **CREATE**.

#### Imports allowed

```ts
import { createHash } from 'node:crypto';
import { getRedisClient } from '../infra/redis.js';
import type { VerifyRequest } from './schemas.js';
```

#### Imports PROHIBIDOS

- `src/routes/*`, `src/chains/*`, `src/methods/*`.
- **Direct `ioredis` import**: always route through `getRedisClient()` from `../infra/redis.js` (preserves singleton + error handling).

#### Skeleton

```ts
/**
 * Idempotency cache for POST /verify (WFAC-20, DT-Idempotency of SDD).
 *
 * Key strategy: SHA-256 of canonical-JSON(parsed request body).
 *   - "Canonical" = keys sorted alphabetically recursively; arrays preserve order.
 *   - Parsed (post-Zod) → removes whitespace / key-order noise from raw body.
 *
 * Redis integration: optional + null-safe.
 *   - If getRedisClient() returns null, we act as "always cache miss" (AC-10).
 *   - If Redis is up but .get/.set throws → swallow, no propagation (graceful degradation).
 *
 * CD-7 (heredado): TTL declared ONCE as VERIFY_IDEMPOTENCY_TTL_SEC.
 * CD-11: canonicalStringify is deterministic across key-order permutations.
 * CD-12: toCacheable refuses to cache http >= 500 (caller must still respond).
 */

import { createHash } from 'node:crypto';
import { getRedisClient } from '../infra/redis.js';
import type { VerifyRequest } from './schemas.js';

export const VERIFY_IDEMPOTENCY_TTL_SEC = 120;                 // spec requirement
export const VERIFY_IDEMPOTENCY_KEY_PREFIX = 'verify:idempotency:';

/**
 * CachedVerifyResponse — what we persist into Redis.
 * Union tracks both success (200) and error (non-500) responses
 * so the route can replay the EXACT original HTTP shape.
 *
 * NOTE: by CD-12 we never cache `http >= 500` — the caller builds these
 * via toCacheable() which returns null for those.
 */
export type CachedVerifyResponse =
  | { readonly ok: true; readonly response: { /* exact VerifyResult shape (7 fields) */
        readonly verified: true;
        readonly client: `0x${string}`;
        readonly amount: string;
        readonly asset: `0x${string}`;
        readonly network: string;
        readonly payTo: `0x${string}`;
        readonly expiresAt: number;
      } }
  | { readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly http: number;  // always < 500 by CD-12
      } };

/**
 * Canonical JSON serialization: recursively sorts object keys. Arrays preserve
 * order. Primitives pass through JSON.stringify as-is.
 *
 * Determinism required by CD-11 — any false negative here would cause double
 * on-chain verify invocations (acceptable for /verify, but still a correctness
 * defect; /settle in a future HU would make this a MUST).
 */
export function canonicalStringify(value: unknown): string {
  // Pseudocode — Dev implements:
  //   if value is null/primitive → return JSON.stringify(value)
  //   if Array.isArray → return `[${value.map(canonicalStringify).join(',')}]`
  //   if object → sorted entries, `{"k":v,...}` joined, each v = canonicalStringify
  // Careful with:
  //   - undefined: JSON.stringify drops it — OK (matches spec semantics).
  //   - NaN/Infinity: should not appear in parsed Zod output.
  throw new Error('implement canonicalStringify');
}

/** Builds the full Redis key `verify:idempotency:<sha256-hex>`. */
export function buildIdempotencyKey(parsed: VerifyRequest): string {
  const canonical = canonicalStringify(parsed);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${VERIFY_IDEMPOTENCY_KEY_PREFIX}${hash}`;
}

/** CD-9 helper: lets the route emit AC-10 warn log without touching infra. */
export function isRedisAvailable(): boolean {
  return getRedisClient() !== null;
}

/**
 * Read the cached response.
 * Return value:
 *   - null  → cache miss (either Redis unavailable or genuine miss) → caller proceeds.
 *   - object → cache hit → caller replays without invoking the adapter (AC-9).
 */
export async function getCachedVerifyResponse(
  key: string,
): Promise<CachedVerifyResponse | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedVerifyResponse;
  } catch {
    // Swallow — AC-10 graceful degradation. DO NOT log here (logger is
    // route-owned); return null to pass-through.
    return null;
  }
}

/**
 * Write with TTL. Swallows all errors (CD-4 applies: never throw on expected failure).
 *
 * CD-12: caller must pre-filter via toCacheable(); this function trusts the payload.
 */
export async function setCachedVerifyResponse(
  key: string,
  payload: CachedVerifyResponse,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(payload), 'EX', VERIFY_IDEMPOTENCY_TTL_SEC);
  } catch {
    // Swallow — graceful degradation.
  }
}

/**
 * CD-12: convert a Result<VerifyResult> into a CachedVerifyResponse or null.
 * Returns null when http >= 500 (not cacheable — may be transient).
 */
export function toCacheable(
  result:
    | { readonly ok: true;
        readonly verified: true;
        readonly client: `0x${string}`;
        readonly amount: string;
        readonly asset: `0x${string}`;
        readonly network: string;
        readonly payTo: `0x${string}`;
        readonly expiresAt: number; }
    | { readonly ok: false;
        readonly error: { readonly code: string; readonly message: string; readonly http: number } },
): CachedVerifyResponse | null {
  if (result.ok) {
    const { ok: _ok, ...response } = result;
    return { ok: true, response };
  }
  if (result.error.http >= 500) return null;                   // CD-12
  return { ok: false, error: result.error };
}
```

#### Wave 1 — dependencies

- Depends on W0 (imports `VerifyRequest` type).

#### Wave 1 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 218/218.
- [ ] `git status` shows ONLY `src/core/schemas.ts` (from W0) + `src/core/idempotency.ts`.

---

### Wave 2 — `src/core/verify.ts` (orchestrator)

**Objective**: stateless orchestrator that parses `accepted.network`, validates method, looks up the adapter via `chainRegistry`, and dispatches. Always returns `Result<VerifyResult>` — never throws for foreseeable errors (CD-4).

#### Files

- `src/core/verify.ts` — **CREATE**.

#### Imports allowed

```ts
import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { VerifyParams, VerifyResult } from '../chains/types.js';   // TYPE-ONLY
```

#### Imports PROHIBIDOS (CD-10)

- `src/methods/*` directly. Dispatch goes via `chainRegistry.getAdapter(chainId).adapter.verify(params)`.
- `src/routes/*`, `src/infra/*`.

#### Skeleton

```ts
/**
 * POST /verify orchestrator — stateless, pure (no I/O except adapter call).
 *
 * Flow:
 *   1. Parse `accepted.network` with regex /^eip155:([1-9]\d*)$/ (CD-13).
 *      - Overflow guard (CD-14): if the numeric string exceeds safe integer
 *        range, return NETWORK_MISMATCH.
 *   2. Enforce assetTransferMethod === 'eip3009' (only method supported in v1).
 *   3. chainRegistry.getAdapter(chainId) → passthrough error if miss.
 *   4. adapter.verify(parsed as VerifyParams) → passthrough result.
 *
 * NEVER throws for foreseeable errors (CD-4). Adapter exceptions propagate
 * (route handles via L4 log + 500 response).
 */

import { asChainId } from './types.js';
import type { Result } from './types.js';
import { buildX402Error } from './errors.js';
import type { VerifyRequest } from './schemas.js';
import { chainRegistry } from '../chains/registry.js';
import type { VerifyParams, VerifyResult } from '../chains/types.js';

const EIP155_RE = /^eip155:([1-9]\d*)$/;                                        // CD-13

export async function verifyCore(
  parsed: VerifyRequest,
): Promise<Result<VerifyResult>> {
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
  // CD-14: don't trust Number() for chainId beyond MAX_SAFE_INTEGER
  if (digits.length > 16 || BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'chainId out of safe integer range'),
    };
  }
  let chainId;
  try {
    chainId = asChainId(Number(digits));
  } catch {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'invalid chainId'),
    };
  }

  // Step 2 — dispatch method
  if (parsed.accepted.extra.assetTransferMethod !== 'eip3009') {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'Method not supported: only eip3009 in v1'),
    };
  }

  // Step 3 — registry lookup
  const lookup = chainRegistry.getAdapter(chainId);
  if (!lookup.ok) {
    return { ok: false, error: lookup.error };
  }

  // Step 4 — dispatch to adapter.
  // VerifyRequest is structurally assignable to VerifyParams because:
  //   - x402Version: z.literal(2) → 2 (narrow)
  //   - accepted.extra.assetTransferMethod: z.enum → union of method strings
  //   - hex/address fields: strings that match the branded regex
  // If the type assertion below fails at build, STOP AND REPORT to the Architect
  // (our Zod schemas in W0 diverged from VerifyParams — do not fix it by
  // adding `as any`; the schemas must stay in sync).
  const params: VerifyParams = parsed as unknown as VerifyParams;

  // Adapter.verify is the single dispatch point — CD-10.
  // NO try/catch here: adapter exceptions propagate to the route (CD-4 intent:
  // "no throws for FORESEEABLE errors"; adapter throws = bug, handled by L4).
  return lookup.adapter.verify(params);
}
```

#### Wave 2 — dependencies

- Depends on W0 (`VerifyRequest` type).
- Does NOT depend on W1 (idempotency belongs to the route layer per SDD §3 W3).

#### Wave 2 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 218/218.
- [ ] `git status` shows W0+W1+`src/core/verify.ts` as new.

---

### Wave 3 — `src/routes/verify.ts` + `src/app.ts` (Fastify plugin + registration)

**Objective**: HTTP boundary. Zod validation → idempotency lookup → dispatch → map `Result<T>` to HTTP. Single file responsible for all logging per DT-Log.

#### Files

- `src/routes/verify.ts` — **CREATE**.
- `src/app.ts` — **MODIFY** (add `await app.register(verifyRoute);`).

#### Imports allowed in `src/routes/verify.ts`

```ts
import type { FastifyPluginAsync } from 'fastify';
import {
  VerifyRequestSchema,
  type VerifyRequest,
} from '../core/schemas.js';
import { verifyCore } from '../core/verify.js';
import {
  buildIdempotencyKey,
  getCachedVerifyResponse,
  setCachedVerifyResponse,
  isRedisAvailable,
  toCacheable,
} from '../core/idempotency.js';
```

#### Imports PROHIBIDOS in `src/routes/verify.ts` (CD-1, CD-9, CD-10)

- `src/chains/*` (any file).
- `src/methods/*` (any file).
- `src/infra/*` (any file) — CD-9: Redis access goes through `isRedisAvailable()` + `getCachedVerifyResponse()`.
- `viem` / `ioredis` / `node:crypto` — if you think you need these, the logic belongs in W1 or W2.

#### `src/routes/verify.ts` skeleton

```ts
/**
 * POST /verify — x402 HTTP API entry point (WFAC-20).
 *
 * Layers (top-down):
 *   1. Zod shape validation → INVALID_PAYLOAD 400 (DT-7 local literal).
 *   2. Idempotency cache lookup (CD-9 via isRedisAvailable helper).
 *   3. Core orchestrator dispatch (src/core/verify.ts).
 *   4. Cache successful/non-5xx response (CD-12 via toCacheable).
 *   5. Map Result<VerifyResult> → HTTP (CD-2 spec-literal on 200, CD-5 on errors).
 *
 * Logging (DT-Log): 4 line templates. NO PII — CD-3 applies to every line.
 *
 * CD-1/CD-10 observed: no imports from src/chains/*, src/methods/*, src/infra/*.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  VerifyRequestSchema,
  type VerifyRequest,
} from '../core/schemas.js';
import { verifyCore } from '../core/verify.js';
import {
  buildIdempotencyKey,
  getCachedVerifyResponse,
  setCachedVerifyResponse,
  isRedisAvailable,
  toCacheable,
  type CachedVerifyResponse,
} from '../core/idempotency.js';

/** Route-local union: X402ErrorCode + 'INVALID_PAYLOAD' literal (DT-7). */
type VerifyRouteErrorCode =
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
    readonly code: VerifyRouteErrorCode;
    readonly message: string;
    readonly http: number;
  };
}

export const verifyRoute: FastifyPluginAsync = async (app) => {
  app.post('/verify', async (request, reply) => {
    const startMs = Date.now();
    const requestId = request.id;

    // Step 1 — Zod validation
    const parseResult = VerifyRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : 'body';
      const rawMsg = issue?.message ?? 'invalid';
      const message = `${path}: ${rawMsg}`.slice(0, 200);                 // DT-Zod cap
      const body: ErrorBody = { error: { code: 'INVALID_PAYLOAD', message, http: 400 } };
      app.log.warn(
        { msg: 'verify failed', request_id: requestId, error_code: 'INVALID_PAYLOAD',
          http_status: 400, duration_ms: Date.now() - startMs },
        'verify failed',
      );
      return reply.code(400).send(body);
    }
    const parsed: VerifyRequest = parseResult.data;

    // Step 2 — idempotency lookup
    const idempotencyKey = buildIdempotencyKey(parsed);
    const redisUp = isRedisAvailable();
    if (redisUp) {
      const cached = await getCachedVerifyResponse(idempotencyKey);
      if (cached) {
        return sendCached(reply, cached, {
          requestId, startMs, network: parsed.accepted.network, app,
        });
      }
    } else {
      // AC-10 graceful degradation log — L2
      app.log.warn({ request_id: requestId }, 'idempotency cache miss — Redis unavailable');
    }

    // Step 3 — dispatch
    let result;
    try {
      result = await verifyCore(parsed);
    } catch (err: unknown) {
      // L4 — adapter threw (shouldn't happen per contract, defense-in-depth)
      app.log.error(
        { msg: 'verify adapter threw', request_id: requestId, err,
          duration_ms: Date.now() - startMs },
        'verify adapter threw',
      );
      const body: ErrorBody = {
        error: { code: 'TRANSACTION_FAILED', message: 'Internal adapter error', http: 500 },
      };
      return reply.code(500).send(body);
    }

    // Step 4 — cache (CD-12 filters 5xx inside toCacheable)
    if (redisUp) {
      const cacheable = toCacheable(result);
      if (cacheable) {
        await setCachedVerifyResponse(idempotencyKey, cacheable);
      }
    }

    // Step 5 — map to HTTP
    if (!result.ok) {
      // L3 — warn
      app.log.warn(
        { msg: 'verify failed', request_id: requestId, error_code: result.error.code,
          http_status: result.error.http, duration_ms: Date.now() - startMs },
        'verify failed',
      );
      return reply.code(result.error.http).send({ error: result.error } satisfies ErrorBody);
    }

    // Success — L1 info
    app.log.info(
      { msg: 'verify ok', request_id: requestId, network: parsed.accepted.network,
        method: 'eip3009', duration_ms: Date.now() - startMs },
      'verify ok',
    );
    // CD-2: spec-literal 200 body — strip the `ok` discriminant, return 7 fields.
    const { ok: _ok, ...spec } = result;
    return reply.code(200).send(spec);
  });
};

// ─── helpers (not exported) ─────────────────────────────────────────────────

function sendCached(
  reply: FastifyReply,
  cached: CachedVerifyResponse,
  ctx: { requestId: string; startMs: number; network: string; app: { log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } } },
): FastifyReply {
  const { requestId, startMs, network, app } = ctx;
  if (cached.ok) {
    app.log.info(
      { msg: 'verify ok', request_id: requestId, network, method: 'eip3009',
        duration_ms: Date.now() - startMs, cached: true },
      'verify ok',
    );
    return reply.code(200).send(cached.response);
  }
  app.log.warn(
    { msg: 'verify failed', request_id: requestId, error_code: cached.error.code,
      http_status: cached.error.http, duration_ms: Date.now() - startMs, cached: true },
    'verify failed',
  );
  return reply.code(cached.error.http).send({ error: cached.error });
}
```

#### `src/app.ts` — exact modification

```ts
// BEFORE (src/app.ts ~line 6):
import { healthRoute } from './routes/health.js';

// AFTER:
import { healthRoute } from './routes/health.js';
import { verifyRoute } from './routes/verify.js';   // <— NEW LINE

// BEFORE (src/app.ts ~line 54):
  await app.register(healthRoute);

// AFTER:
  await app.register(healthRoute);
  await app.register(verifyRoute);                   // <— NEW LINE
```

**Do NOT touch anything else in `src/app.ts`.** `initRedis(env, logger)` is already called at line 47 and satisfies our W1 requirement (`getRedisClient` will work because `initRedis` ran).

#### Wave 3 — dependencies

- Depends on W0, W1, W2.

#### Wave 3 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` still 218/218 (new tests come in W4).
- [ ] `git diff src/app.ts` shows exactly 2 added lines.
- [ ] `src/routes/verify.ts` imports ONLY from `fastify` + `../core/*`. Grep: `grep -nE "from '\\.\\./(chains|methods|infra)" src/routes/verify.ts` must return zero.

---

### Wave 4 — Tests (3 files, ~25 tests)

**Objective**: one test per AC + coverage tests for core units. Patterns inherited from `src/__tests__/unit/health.test.ts` (E11) and `src/__tests__/unit/redis.test.ts` (E12).

#### Files

- `src/__tests__/unit/routes.verify.test.ts` — **CREATE**. Integration via `app.inject`.
- `src/__tests__/unit/core.verify.test.ts` — **CREATE**. Unit tests for the orchestrator + schema regressions.
- `src/__tests__/unit/core.idempotency.test.ts` — **CREATE**. Unit tests for SHA-256 + cache helpers.

#### 4.1 — `core.idempotency.test.ts` skeleton

**Imports**:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// vi.mock('ioredis', ...) — mirror the mock from redis.test.ts (E12)
import { resetRedisClientForTests } from '../../infra/redis.js';
// ↑ this import is OK for TESTS only (tests can reach into infra)
```

**Mock strategy**:
- Copy the `vi.mock('ioredis', ...)` block from E12 (`redis.test.ts` lines 14-52). Extend the RedisMock class with `get` and `set` methods backed by a `Map<string, string>` + configurable TTL tracker.
- For "Redis throws" tests, override `get`/`set` per-test with `vi.fn().mockRejectedValue(new Error('boom'))`.
- `resetRedisClientForTests()` in `afterEach`.

**Tests (10)**:

| # | Test name | Asserts |
|---|-----------|---------|
| T-I1 | `VERIFY_IDEMPOTENCY_TTL_SEC is exactly 120` | Constant value; imported directly. |
| T-I2 | `canonicalStringify sorts keys recursively` | `canonicalStringify({b:1,a:{d:2,c:3}})` === `'{"a":{"c":3,"d":2},"b":1}'` |
| T-I3 | `canonicalStringify preserves array order` | `canonicalStringify({a:[3,1,2]})` === `'{"a":[3,1,2]}'` |
| T-I4 | `buildIdempotencyKey is stable across key order permutations` | Two `VerifyRequest` objects with same values but different root-key order yield equal keys. |
| T-I5 | `buildIdempotencyKey differs for distinct payloads` | Change `accepted.amount` → different key. |
| T-I6 | `buildIdempotencyKey prefix matches 'verify:idempotency:'` | Startswith check + 64-char hex suffix. |
| T-I7 | `isRedisAvailable returns false when redis client is null (test env no REDIS_URL)` | `resetRedisClientForTests()` + no `initRedis` call → `false`. |
| T-I8 | `getCachedVerifyResponse returns null when redis client is null` | Same context as T-I7. |
| T-I9 | `getCachedVerifyResponse returns null and does NOT throw when redis.get throws` | Mock `.get` to reject → assert null return, no unhandled rejection. |
| T-I10 | `setCachedVerifyResponse swallows set errors` | Mock `.set` to reject → assert `await setCached...(...)` resolves to undefined. |
| T-I11 | `toCacheable returns null for http >= 500 (CD-12)` | Input `{ ok: false, error: { code: 'TRANSACTION_FAILED', message: '...', http: 500 } }` → null. |
| T-I12 | `toCacheable preserves success payload shape` | Input Ok result with 7 fields → `{ ok: true, response: {...7 fields...} }`. |

#### 4.2 — `core.verify.test.ts` skeleton

**Imports**:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VerifyRequestSchema } from '../../core/schemas.js';
import { verifyCore } from '../../core/verify.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import type { ChainAdapter, VerifyParams } from '../../chains/types.js';
```

**Fake adapter pattern** (CD-15, CD-16: do NOT import `src/chains/kite.ts` / `avalanche.ts` — they throw if env missing):
```ts
function makeFakeAdapter(
  chainId: number,
  verifyImpl: (params: VerifyParams) => Promise<unknown>,
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
    verify: verifyImpl as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: vi.fn() as unknown as ChainAdapter['getPublicClient'],
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
  };
}
```

**Tests (12)**:

| # | Test name | Asserts |
|---|-----------|---------|
| T-V1 | `VerifyRequestSchema accepts the canonical fixture` | Valid body (see §4.4 fixture) → `safeParse().success === true`. |
| T-V2 | `VerifyRequestSchema rejects x402Version !== 2` | `{ x402Version: 1, ... }` → success false. |
| T-V3 | `VerifyRequestSchema rejects missing resource` | Missing `resource` → success false. |
| T-V4 | `VerifyRequestSchema rejects missing payload` | success false. |
| T-V5 | `VerifyRequestSchema rejects non-canonical uint256 (leading zero)` | `accepted.amount = "0100"` → success false. |
| T-V6 | `verifyCore returns NETWORK_MISMATCH when network regex fails` | `accepted.network = "solana:1"` → `{ ok: false, code: 'NETWORK_MISMATCH', http: 400 }`. |
| T-V7 | `verifyCore returns NETWORK_MISMATCH when network is eip155:0` | regex `[1-9]\d*` rejects leading zero. (CD-13) |
| T-V8 | `verifyCore returns NETWORK_MISMATCH when chainId overflows safe integer` | `"eip155:" + "9".repeat(20)` → NETWORK_MISMATCH (CD-14). |
| T-V9 | `verifyCore returns NETWORK_MISMATCH when chain is not registered` | registry empty, valid network `eip155:999999` → NETWORK_MISMATCH. |
| T-V10 | `verifyCore returns NETWORK_MISMATCH when assetTransferMethod !== 'eip3009'` | `extra.assetTransferMethod = 'permit2'` + fake adapter registered → NETWORK_MISMATCH, adapter.verify NOT called. |
| T-V11 | `verifyCore passes VerifyParams unchanged to adapter.verify and returns its Result verbatim` | Spy on fake adapter verify; assert called with `===` object; return value is passthrough. |
| T-V12 | `verifyCore does NOT catch adapter exceptions (propagates)` | Fake adapter throws → `expect(verifyCore(...)).rejects.toThrow('...')`. |

**`beforeEach`**: `chainRegistry._resetForTesting()` + register fake adapter(s) ad-hoc per test.

#### 4.3 — `routes.verify.test.ts` skeleton

**Imports**:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { resetRedisClientForTests } from '../../infra/redis.js';
import type { ChainAdapter, VerifyParams, VerifyResult } from '../../chains/types.js';
```

**CaptureStream**: copy verbatim from E11 (`health.test.ts` lines 12-25). Do NOT re-implement.

**Fake adapter registration**: same pattern as §4.2 (CD-15, CD-16 apply — NO real chain adapter imports).

**Tests (13 + 3 extras for full AC coverage = 16)**:

| # | AC | Test name | Strategy |
|---|----|-----------|----------|
| T-R1 | AC-1 | `POST /verify returns 200 with exact 7-field spec shape` | Fake adapter returns success fixture. Assert `Object.keys(body).sort()` === `['amount','asset','client','expiresAt','network','payTo','verified']`. |
| T-R2 | AC-2 | `emits info log 'verify ok' with {request_id, network, method, duration_ms} and no PII` | CaptureStream; find line `msg === 'verify ok'`; assert fields; assert `JSON.stringify(line)` does NOT contain `parsed.payload.signature` or `parsed.payload.authorization.nonce`. |
| T-R3 | AC-3 | `returns 400 INVALID_PAYLOAD when x402Version missing` | `body = { resource, accepted, payload }` (no x402Version). Assert `body.error.code === 'INVALID_PAYLOAD'`, `http === 400`, statusCode 400. Spy `chainRegistry.getAdapter` (vi.spyOn) NOT called. |
| T-R4 | AC-3 | `returns 400 INVALID_PAYLOAD when x402Version !== 2` | `x402Version: 1`. Same assertions. |
| T-R5 | AC-3 | `returns 400 INVALID_PAYLOAD when resource missing` | Same. |
| T-R6 | AC-4 | `returns 400 NETWORK_MISMATCH for malformed network "solana:1"` | Body valid except `accepted.network = "solana:1"`. Assert `code === 'NETWORK_MISMATCH'`, http 400. Fake adapter verify NOT called. |
| T-R7 | AC-4 | `returns 400 NETWORK_MISMATCH for "eip155:0"` | Leading-zero / zero chainId rejection (CD-13). |
| T-R8 | AC-5 | `returns 400 NETWORK_MISMATCH when chainId not registered` | `accepted.network = "eip155:999999"`; registry only has fake adapter on 2368. Assert 400 NETWORK_MISMATCH. |
| T-R9 | AC-6 | `passes through adapter error verbatim (code, message, http)` | Fake adapter returns `{ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'custom msg', http: 401 } }`. Assert response body === `{ error: { code: 'INVALID_SIGNATURE', message: 'custom msg', http: 401 } }`; statusCode 401. |
| T-R10 | AC-7 | `returns 400 EXPIRED_AUTHORIZATION when adapter reports expired (delegation)` | Fake adapter returns `EXPIRED_AUTHORIZATION` + 400. Pass-through assertion. |
| T-R11 | AC-8 | `returns 400 EXPIRED_AUTHORIZATION when adapter reports not-yet-valid (delegation)` | Same, different message. |
| T-R12 | AC-9 | `returns cached response on second identical request (idempotency hit)` | Mock ioredis via E12 pattern; fake adapter verify = `vi.fn()`. Two `app.inject` with IDENTICAL body → adapter called once. Both responses have same body. |
| T-R13 | AC-10 | `graceful degradation: logs warn and proceeds when Redis unavailable` | `resetRedisClientForTests()`; no `REDIS_URL`. Happy path injection. CaptureStream asserts line `msg: 'idempotency cache miss — Redis unavailable'` with `request_id`. Status 200. |
| T-R14 | AC-11 | `every response (200, INVALID_PAYLOAD 400, NETWORK_MISMATCH 400, INVALID_SIGNATURE 401) has a log line with {request_id, duration_ms}` | Loop 4 scenarios; for each, assert at least one captured log line has BOTH fields. |
| T-R15 | AC-12 | `error responses emit warn log with {error_code, http_status} and no PII` | For each error case (3 kinds), assert line level=40 (warn) with the two fields; JSON.stringify of line NOT contains signature or authorization.nonce. |
| T-R16 | AC-13 | `returns 415 or 400 when Content-Type is text/plain` | `app.inject({ headers: { 'content-type': 'text/plain' }, payload: '{}' })`. Assert `statusCode in [400, 415]`. |

#### 4.4 — Fixture (canonical happy-path body)

Put this at the top of `routes.verify.test.ts` + reuse in `core.verify.test.ts`:

```ts
const VALID_BODY = {
  x402Version: 2,
  resource: {
    url: 'https://example.com/api/resource',
    description: 'sample',
    mimeType: 'application/json',
  },
  accepted: {
    scheme: 'exact',
    network: 'eip155:2368',   // use the fake adapter chainId
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

const VALID_ADAPTER_RESULT = {
  ok: true as const,
  verified: true as const,
  client: '0x' + '33'.repeat(20) as `0x${string}`,
  amount: '1000000',
  asset: '0x' + '11'.repeat(20) as `0x${string}`,
  network: 'eip155:2368',
  payTo: '0x' + '22'.repeat(20) as `0x${string}`,
  expiresAt: 99999999999,
};
```

#### Wave 4 — completion criteria

- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run` green with ≥243 total (218 baseline + ≥25 new).
- [ ] Every AC (AC-1 … AC-13) has ≥1 test as per §2 matrix.
- [ ] `git status` shows ALL 8 scope-IN files (4 src + 3 test + 1 modified).
- [ ] No test file imports `src/chains/kite.ts` or `src/chains/avalanche.ts` (grep: zero hits) — CD-16.

---

## 2. Constraint Directives (full inherited + arch-added set)

**MANDATORY** — these are the contract. Each CD cites the file(s) where compliance is verified.

### Inherited from work-item (CD-1 … CD-8)

| CD | Rule | Verified in |
|----|------|-------------|
| CD-1 | **PROHIBIDO** que `src/routes/verify.ts` importe de `src/chains/*`, `src/methods/*`, o cualquier adapter. Entry único = `src/core/verify.ts`. | `src/routes/verify.ts` imports list; §1 W3 "Imports permitidos". |
| CD-2 | **OBLIGATORIO** response 200 spec-literal: 7 fields `{ verified, client, amount, asset, network, payTo, expiresAt }`. No wrappers. | `src/routes/verify.ts` — strip `ok` before `reply.send`. Test T-R1. |
| CD-3 | **PROHIBIDO** loggear `signature`, `authorization.nonce`, or any `authorization.*` field in plain text. | `src/routes/verify.ts` — log lines never include `parsed.payload.*`. Tests T-R2, T-R15. |
| CD-4 | **OBLIGATORIO** que `src/core/verify.ts` y `src/core/idempotency.ts` never throw for foreseeable errors. | §1 W1/W2 skeleton — every error path returns Result<T> or null. |
| CD-5 | **PROHIBIDO** `reply.send(result)` when `result.ok === false` without `reply.code(error.http)`. | `src/routes/verify.ts` Step 5. |
| CD-6 | **OBLIGATORIO** tests use `app.inject()` (no live ports). | §1 W4.3 — all T-R* use inject. |
| CD-7 | **PROHIBIDO** hardcoding idempotency TTL as numeric literal anywhere but `VERIFY_IDEMPOTENCY_TTL_SEC` in `src/core/idempotency.ts`. | Grep: `grep -n "120" src/core/ src/routes/` must find the constant def ONLY. |
| CD-8 | **OBLIGATORIO** `x402Version = z.literal(2)` in Zod (not `z.number()`). | `src/core/schemas.ts` line with `x402Version: z.literal(2)`. |

### Arch-added (CD-9 … CD-16) from SDD §5

| CD | Rule | Verified in |
|----|------|-------------|
| CD-9 | **PROHIBIDO** que `src/routes/verify.ts` invoque `getRedisClient()`. Solo vía `isRedisAvailable()` helper. | Grep `grep -n "getRedisClient" src/routes/verify.ts` = 0. |
| CD-10 | **PROHIBIDO** que `src/core/verify.ts` importe `src/methods/*`. Dispatch vía registry. | Grep `grep -n "from '../methods" src/core/verify.ts` = 0. |
| CD-11 | **OBLIGATORIO** `canonicalStringify` determinista across key-order permutations. | Tests T-I2, T-I3, T-I4. |
| CD-12 | **PROHIBIDO** cachear responses con `http >= 500`. | `src/core/idempotency.ts` — `toCacheable` returns null for >= 500. Test T-I11. |
| CD-13 | **OBLIGATORIO** regex network `/^eip155:([1-9]\d*)$/` (no leading zeros, no negatives, no zero). | `src/core/verify.ts` EIP155_RE. Tests T-V6, T-V7. |
| CD-14 | **PROHIBIDO** usar `Number()` for chainId overflow checks. Use BigInt + length guard. | `src/core/verify.ts` overflow block. Test T-V8. |
| CD-15 | **OBLIGATORIO** que tests usen fake adapters registered explicitly — no dependence on production adapters. | `src/__tests__/unit/routes.verify.test.ts` + `core.verify.test.ts` — no `src/chains/kite.ts` import. |
| CD-16 | **PROHIBIDO** importar `src/chains/kite.ts` o `src/chains/avalanche.ts` desde los 2 test files nuevos. | Grep: `grep -nE "from '.*/(kite\|avalanche)" src/__tests__/unit/{routes,core}.verify.test.ts` = 0. |

---

## 3. AC → Wave → Test matrix

| AC | Description | Satisfied by wave | Test id(s) |
|----|-------------|-------------------|------------|
| AC-1 | Happy path 200 with 7-field spec body | W3 | T-R1 |
| AC-2 | info log `verify ok` with required fields, no PII | W3 | T-R2 |
| AC-3 | 400 INVALID_PAYLOAD on Zod failure, adapter NOT called | W0 + W3 | T-R3, T-R4, T-R5 |
| AC-4 | 400 NETWORK_MISMATCH on malformed network string | W2 + W3 | T-R6, T-R7 |
| AC-5 | 400 NETWORK_MISMATCH when chainId not registered | W2 + W3 | T-R8 |
| AC-6 | Adapter error passthrough verbatim | W2 + W3 | T-R9 |
| AC-7 | EXPIRED_AUTHORIZATION delegation (past validBefore) | W3 | T-R10 |
| AC-8 | EXPIRED_AUTHORIZATION delegation (future validAfter) | W3 | T-R11 |
| AC-9 | Idempotency hit replays cached | W1 + W3 | T-R12 |
| AC-10 | Redis unavailable → warn log + proceed | W1 + W3 | T-R13 |
| AC-11 | Every response logs request_id + duration_ms | W3 | T-R14 |
| AC-12 | Error responses emit warn log, no PII | W3 | T-R15 |
| AC-13 | Non-JSON Content-Type → 415 / 400 | W3 (Fastify default) | T-R16 |

**Total mapped tests**: 16 route + 12 core/verify + 12 idempotency = **40 tests minimum**. Baseline 218 → target ≥258 (≥25 new is floor; 40 is stretch).

---

## 4. Guardrails anti-drift (Dev — read literally)

### 4.1 DO NOT

- **DO NOT** `request.body as any`. The Zod schema is the ONLY source of truth.
- **DO NOT** import `viem`, `ioredis`, or `node:crypto` in `src/routes/verify.ts`. If you think you need them, you're in the wrong layer.
- **DO NOT** create a "genericHttpError" helper across files. Each error emission is explicit with `buildX402Error(code, message)` or the local `{ error: { code: 'INVALID_PAYLOAD', ... } }`.
- **DO NOT** re-derive `validBefore`/`validAfter` timestamp checks in the route. The adapter is the source of truth (AC-7, AC-8). If you find yourself writing `Date.now() / 1000 > ...`, you're re-implementing the adapter — STOP.
- **DO NOT** duplicate `Bytes32HexSchema` / `AddressHexSchema` / `Uint256StringSchema` in `src/core/schemas.ts`. Import from `src/methods/eip3009/schemas.ts` (exemplar E3).
- **DO NOT** hardcode the TTL `120` outside `VERIFY_IDEMPOTENCY_TTL_SEC`. CD-7.
- **DO NOT** log `request.body`, `parsed.payload`, `parsed.payload.signature`, or `parsed.payload.authorization` fields. CD-3.
- **DO NOT** import `src/chains/kite.ts` / `src/chains/avalanche.ts` from any new test file. CD-16.
- **DO NOT** add a dependency to `package.json`. All deps already exist (`zod`, `fastify`, `ioredis`, `pino`).
- **DO NOT** modify `src/chains/*`, `src/methods/*`, `src/infra/*`. Scope IN enforces this.
- **DO NOT** try to "generalize" the route for /settle. WFAC-21 is a separate HU; extraction lives there.
- **DO NOT** swallow unexpected errors silently in the route. The adapter-throw path uses L4 log + 500 response — never bare `catch {}`.
- **DO NOT** modify `src/app.ts` beyond the two additions specified in W3.

### 4.2 IF you encounter discrepancy

**If the codebase reality contradicts this Story File, STOP AND REPORT. Examples:**

- `src/methods/eip3009/schemas.ts` doesn't export `Eip3009AuthorizationSchema` → STOP. (It does — verified in §0.4 E3.)
- `chainRegistry.getAdapter(chainId)` doesn't return a Result → STOP. (It does — verified in E5.)
- A test in `src/__tests__/unit/core-types.test.ts` fails after your W0 — STOP. Your schema is wrong.
- `VerifyRequest` is not structurally assignable to `VerifyParams` (W2 `as unknown as VerifyParams` flagged by TS) → STOP. Fix the schema in W0 to match `VerifyParams` shape exactly — do NOT use `as any` or widen a type.

Report template (paste into the PR / chat):

> **Story File discrepancy** at W[0-4]: expected `<path>` to `<expectation>`, but actual is `<observation>`. Cannot proceed without Architect clarification.

### 4.3 Pre-commit sanity checks

Before `git add` / commit at end of any wave:

```bash
npm run build          # must exit 0
npm run lint           # must exit 0
npm test -- --run      # must exit 0 (W0-W3: 218 baseline; W4: >=243)
git status             # only scope-IN files
git diff src/app.ts    # W3 only: exactly 2 added lines
grep -n "from '\\.\\./(chains|methods|infra)'" src/routes/verify.ts  # 0 matches
grep -n "getRedisClient" src/routes/verify.ts                         # 0 matches (CD-9)
grep -n "from '.*/methods/" src/core/verify.ts                         # 0 matches (CD-10)
```

---

## 5. Done Definition (how we know HU-20 is complete)

- [ ] All 8 files in Scope IN (§0.5) exist (or modified for app.ts).
- [ ] `npm run build` green.
- [ ] `npm run lint` green.
- [ ] `npm test -- --run`: baseline + new tests green (≥243 total).
- [ ] Every AC (AC-1 … AC-13) mapped to ≥1 test — §3 matrix.
- [ ] All 16 CDs verified via grep/test/inspection — §2 table.
- [ ] No files outside Scope IN changed — `git diff --name-only main` matches §0.5.
- [ ] Branch `feat/009-wfac-20-verify-route` has linear history rooted at main commit `03474d7`.

---

## 6. Historical Auto-Blindaje inheritance (from WFAC-6, WFAC-10, WFAC-13)

Lessons applied to this Story File:

| Lesson | From | Protection here |
|--------|------|-----------------|
| Regex `/^\d+$/` accepts leading zeros → use `/^(0\|[1-9]\d*)$/` | WFAC-6 BLQ-BAJO-1 | CD-13, `EIP155_RE` in W2. Test T-V7. |
| `Number(uint256)` loses precision → use BigInt for boundary checks | WFAC-6 BLQ-MED-1 | CD-14, BigInt overflow guard in W2. Test T-V8. |
| `BigInt("abc")` throws without Zod pre-validation → validate shape FIRST | WFAC-6 BLQ-ALTO-2 | W0 `VerifyRequestSchema` runs before W2 ever calls BigInt. Tests T-V1..T-V5. |
| Test fixtures generating signatures must use canonical helpers | WFAC-10 F3.1 | `routes.verify.test.ts` uses `VALID_ADAPTER_RESULT` fixture + fake adapter; no viem signing in tests. §1 W4.4. |
| viem `recoverTypedDataAddress` only accepts 65-byte canonical sigs | WFAC-13 | Not directly applicable (route delegates to adapter); but CD-16 prevents tests from depending on real adapters and WFAC-13 regressions. |

---

*Generated by nexus-architect · F2.5 Story File · 2026-04-23 · WFAC-20*
