# Auto-Blindaje — WKH-148 (operator-funding-low)

### [2026-07-07] Wave 1 — Adding `getBalance` on the settle path broke existing mocks
- **Error**: After inserting the read-only `getBalance` pre-check in `_settleRaw`,
  4 existing test files that drive the REAL adapter with a mocked `publicClient`
  started failing (10 tests). Their mock `publicClient` objects only stubbed
  `simulateContract`/`waitForTransactionReceipt`, so `publicClient.getBalance`
  was `undefined` → the pre-check threw a TypeError → caught → returned
  `SIMULATION_FAILED` instead of the expected happy path / TRANSACTION_FAILED.
  Affected: `chain-adapter.test.ts`, `chains.base.test.ts`,
  `settle.breaker-classification.test.ts`, `settle.failinjection.test.ts`,
  `settle.nonce-serialization.test.ts`.
- **Causa raíz**: Adding a NEW viem client call on an existing code path makes
  every test that stubs that client (but not the new method) incomplete. The
  mocks are partial `as unknown as PublicClient` objects, so TS does not catch
  the missing method — it only surfaces at runtime.
- **Fix**: Added `getBalance: vi.fn(async () => 10n ** 20n)` (healthy balance,
  well above the 0.01-token default) to each affected mock so the pre-check
  passes and the on-chain flow runs byte-identically. Happy-path assertions
  unchanged.
- **Aplicar en**: Any future HU that adds a new `publicClient`/`walletClient`
  method call on the verify/settle path MUST grep for every test that mocks
  `getPublicClient`/`getWalletClient` and add the new method to those partial
  mocks. Route/core tests that stub the whole `adapter.settle` are NOT affected
  (they never reach `_settleRaw`).

### [2026-07-07] Wave 0 — `X402ErrorCode` widening compile-breaks the verify route union
- **Error**: Adding `OPERATOR_FUNDING_LOW` to `X402ErrorCode` broke `verify.ts`
  compilation: its route-local `VerifyRouteErrorCode` union manually lists the
  codes, and `result.error.code` (now widened) is assigned to it at the HTTP
  mapping step.
- **Causa raíz**: Two route-local unions (`settle.ts`, `verify.ts`) shadow
  `X402ErrorCode`. Widening the source union forces exhaustive coverage in both,
  even though `/verify` never emits the new code.
- **Fix**: Added `OPERATOR_FUNDING_LOW` to `VerifyRouteErrorCode` for
  type-completeness ONLY, with a comment that verify never emits it (the
  pre-check lives in `_settleRaw`, not `_verifyRaw`). Mirrors how
  `CHAIN_UNAVAILABLE` (WFAC-41) was added to both unions.
- **Aplicar en**: Any new `X402ErrorCode` value must be added to BOTH
  `src/routes/settle.ts` and `src/routes/verify.ts` route-local unions plus the
  two exhaustive Records in `src/core/errors.ts`, regardless of which route
  actually produces it.

### [2026-07-07] Tests — `typeof import()` annotation forbidden by ESLint
- **Error**: `npx eslint src/ --max-warnings 0` failed with
  `@typescript-eslint/consistent-type-imports` — an inline
  `mod: typeof import('../../../chains/kite.js')` parameter annotation.
- **Causa raíz**: The repo's ESLint config forbids `import()` type annotations;
  they must be top-level `import type` statements.
- **Fix**: Replaced with a top-level `import type * as KiteModule from
  '../../../chains/kite.js';` and typed the param `mod: typeof KiteModule`.
- **Aplicar en**: In tests that dynamically `await import()` a module and pass it
  to a helper, type the helper param via a top-level `import type * as X`, never
  `typeof import('...')` inline.

### [2026-07-07] Gate — biome is NOT the linter in this repo
- **Error**: The task's Auto-Blindaje note said run
  `./node_modules/.bin/biome check src/`; that binary does not exist here
  (exit 127).
- **Causa raíz**: `wasiai-facilitator` uses ESLint + Prettier (see
  `package.json` `qa` script: `typecheck && lint && format:check && test`);
  biome belongs to a different repo. The note was stale/generic.
- **Fix**: Ran the real static gate — `npx eslint src/ --max-warnings 0`
  (0 errors) + `npx prettier --check "src/**/*.ts"` (all formatted).
- **Aplicar en**: Confirm the actual lint/format toolchain from `package.json`
  scripts before running a gate; do not assume biome.
