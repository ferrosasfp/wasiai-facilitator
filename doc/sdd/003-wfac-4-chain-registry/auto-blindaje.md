# Auto-Blindaje — WFAC-4 Chain Registry

> Log of errors encountered during F3 Implementation and their remediations.
> Each entry documents root cause + fix + where else the pattern may appear.

---

### [2026-04-22 W3] Dynamic `process.env[name]` trips `security/detect-object-injection`

- **Error**: `npm run lint` failed with `security/detect-object-injection` warning at `src/chains/kite.ts:36` because `readEnv()` accesses `process.env[name]` with a string argument (required for the dual adapter factory pattern — Testnet vs Mainnet differ only by env var name).
- **Causa raíz**: `.eslintrc.json` sets `security/detect-object-injection: 'warn'`, combined with `--max-warnings 0`. The heuristic flags any dynamic index into an object, even when `name` is caller-controlled by our own code (never user input).
- **Fix**: Added a narrow `eslint-disable-next-line` with rationale comment targeting the single line. Kept the Story-specified shape (constructor receives `envVarName`) rather than hardcoding two branches (`if testnet → KITE_TESTNET_RPC_URL else KITE_MAINNET_RPC_URL`), preserving the "each new chain = one new file" DX goal.
- **Aplicar en**: Any future adapter that uses a factory + dynamic env-var lookup. For `avalanche.ts` the env var is hardcoded as a literal (`process.env['AVALANCHE_FUJI_RPC_URL']`), so it does not trigger the rule. If Fuji is later refactored to a factory (unlikely), the same disable comment pattern applies.

---

### [2026-04-22 W6] DRIFT-1 — `vi.resetModules()` invalidates `instanceof ChainAdapterInitError`

- **Error**: Story File §5.7.3 prescribes `await expect(import(...)).rejects.toThrow(ChainAdapterInitError)` (class reference). Tests 2/3 of that pattern failed with `AssertionError: expected error to be instance of ChainAdapterInitError`, even though the thrown error's `.name` and `.message` matched exactly.
- **Causa raíz**: The test file imports `ChainAdapterInitError` statically at top-level. Each test then calls `vi.resetModules()` to force re-evaluation of `src/chains/kite.js` / `src/chains/avalanche.js`. The fresh re-import also re-evaluates `src/chains/types.js`, producing a **new class constructor object** in memory. The thrown error instance is `instanceof` the NEW class, not the statically-imported one. Only the very first test passes because `resetModules()` hasn't yet invalidated the module graph shared with the static import. The rest fail the `instanceof` check even though they are the semantically-correct error.
- **Fix**: Removed the static `import { ChainAdapterInitError } from '../../chains/types.js'` and replaced `rejects.toThrow(ChainAdapterInitError)` with `rejects.toThrow(/ChainAdapterInitError/)` — matches by error name + message (which is stable across module reloads). Added an inline comment in the test file explaining the rationale. Behavior preserved: the test still validates that the thrown error is domain-specific (`ChainAdapterInitError`) with the correct env-var name in the message.
- **Aplicar en**: Any future test that combines `vi.resetModules()` with an `instanceof ClassFromReloadedModule` assertion. Either (a) re-import the class after `resetModules()` via `const { TheClass } = await import(...)` or (b) match by `.name` / regex. Option (b) is simpler and preferred unless the class hierarchy itself needs to be exercised.
- **Drift filed to orquestador**: Story File §5.7.3 uses the class-reference shape. This change preserves AC coverage but deviates from literal shape — flagged per Story File §11.
