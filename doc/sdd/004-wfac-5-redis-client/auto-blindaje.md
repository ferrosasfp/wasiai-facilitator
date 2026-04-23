# Auto-Blindaje — WFAC-5 Redis Client

Este archivo documenta errores cometidos durante la implementación y sus correcciones,
para proteger futuras HUs de incurrir en el mismo error.

---

### [2026-04-22 10:28] W0 — Existing env.test cases broken by new superRefine rule

- **Error**: After adding the `superRefine` that requires `REDIS_URL` when
  `NODE_ENV !== 'test'`, two pre-existing tests in `src/__tests__/unit/env.test.ts`
  started failing with `process.exit unexpectedly called with "1"`:
  - `defaults PORT to 3002 when PORT is missing` (calls `parseEnv({})`)
  - `respects PORT from env var` (calls `parseEnv({ PORT: '4001' })`)

  Both omit `NODE_ENV`, so it defaults to `'development'` — which now requires
  `REDIS_URL`.
- **Causa raíz**: The Story File §5.5 only added NEW tests but did not prescribe
  updating the 2 existing `parseEnv` tests that implicitly relied on `development`
  env being valid with zero vars. The new `superRefine` cross-field rule is a
  behavior change that those pre-existing tests now collide with.
- **Fix**: Minimal-scope edit — added `NODE_ENV: 'test'` to the two pre-existing
  cases so they continue asserting ONLY what they were asserting (PORT default
  / PORT override), without requiring `REDIS_URL`. This preserves intent: the
  tests target PORT logic, not env-wide validation. Alternative would have
  been to add `REDIS_URL`, but using `NODE_ENV: 'test'` is cleaner (matches
  the test environment real behavior — see AC-3).
- **Aplicar en**: Anywhere a schema gains a new cross-field `superRefine`:
  audit ALL existing tests that build partial env objects without NODE_ENV
  and ensure they target a valid branch of the new rule. Grep for
  `parseEnv\(\{` when introducing such rules.

---

### [2026-04-22 10:32] W1 — `import Redis from 'ioredis'` fails under Node16 + CJS namespace

- **Error**: Story File §5.2 prescribes `import Redis from 'ioredis'` as the
  default import. Under this repo's tsconfig (`module: "Node16"`,
  `esModuleInterop: true`) + ioredis 5.10.1's CJS shape (`module.exports =
  require("./Redis").default` plus an explicit `default` property on the
  namespace), TypeScript reports:
  - `TS2709: Cannot use namespace 'Redis' as a type`
  - `TS2351: This expression is not constructable. Type 'typeof
    import("...ioredis/built/index")' has no construct signatures`
- **Causa raíz**: Node16 module resolution treats the CJS default-import
  pattern as importing the namespace object, not the `.default` property —
  this is the documented Node16 ESM/CJS interop semantics. The Story File
  anti-hallucination checklist even hints at it: "`export default Redis`
  (default export). `export { default as Redis } from './Redis'` (también
  named). Tu import va a ser: `import Redis from 'ioredis'`." — but the named
  import is the one that actually compiles here.
- **Fix**: Swapped to `import { Redis } from 'ioredis'` (the named re-export
  of the same class). Functionally identical — `new Redis(url, opts)` works
  and all type positions resolve to the class. Added an inline comment on the
  import explaining why this deviates from the conventional default-import.
- **Aplicar en**: Any future NexusAgil SDD/Story File prescribing CJS default
  imports in a Node16 project — either (a) validate with a `typecheck`
  sandbox first, or (b) standardize on the named import form for CJS libs
  with both default and named exports. Candidates to watch: `pino`,
  `bullmq` (if it ships with CJS), `zod` sub-paths.

---
