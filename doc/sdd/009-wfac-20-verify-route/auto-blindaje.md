# Auto-Blindaje — WFAC-20 (POST /verify route)

Running log of small corrections applied during F3 (Dev) that deviate from
the Story File skeleton but stay inside the Story's contractual intent.
Architect should review and fold back into the next HU's Story File.

---

### [2026-04-23 01:22] W0 — `Bytes32HexSchema` import pruned

- **Error**: `npm run lint` fails with
  `'Bytes32HexSchema' is defined but never used` (`@typescript-eslint/no-unused-vars`).
- **Causa raíz**: The Story skeleton §W0 lists 4 primitive validators to
  import from `src/methods/eip3009/schemas.ts`
  (`AddressHexSchema`, `Bytes32HexSchema`, `Uint256StringSchema`,
  `Eip3009AuthorizationSchema`), but at the top-level `VerifyRequestSchema`
  only 3 are referenced directly. `Bytes32HexSchema` is only reachable
  *transitively* (it composes `authorization.nonce` inside
  `Eip3009AuthorizationSchema`). The zero-warnings lint policy (DT-8 of
  prior HUs) rejects the unused import.
- **Fix**: Removed `Bytes32HexSchema` from the import list + added a
  comment documenting the transitive availability. All 3 remaining
  primitives are directly consumed by the schema.
- **Aplicar en**: If future HUs add a bytes32 field at the top-level
  (e.g. WFAC-21 /settle maybe), re-add the import then.

---

### [2026-04-23 01:23] W1 — `_ok` rest-destructuring lint error

- **Error**: `const { ok: _ok, ...response } = result;` triggers
  `@typescript-eslint/no-unused-vars` — the ESLint config uses only
  `argsIgnorePattern: '^_'`, not `varsIgnorePattern`, so `_`-prefixed
  variable bindings are still flagged.
- **Causa raíz**: The Story §W1 skeleton at line 390 used the destructure
  pattern to strip the `ok` discriminant. That pattern requires
  `varsIgnorePattern` to be set in ESLint, which it isn't.
- **Fix**: Replaced the destructure with an explicit object build (lists
  the 7 fields by name). Safer anyway — TS now verifies each field is
  present on the input type.
- **Aplicar en**: Same pattern will appear in `src/routes/verify.ts` W3
  skeleton (line 708 of the Story). Use the same explicit-build pattern
  there.

---

### [2026-04-23 01:32] W4 — Removed unreachable defensive branches in `verifyCore` to hit ≥90% coverage

- **Error**: Initial W2 skeleton had two defensive branches marked
  "unreachable" by comment:
  1. `if (digits === undefined)` after `EIP155_RE.exec()` returned non-null.
  2. `try/catch` around `asChainId(Number(digits))`.
  This caused `src/core/verify.ts` to report 79.59% statement coverage —
  below the ≥90% target mandated by the Story §5 Done Definition.
- **Causa raíz**: Both branches are truly unreachable by input:
  - The regex `/^eip155:([1-9]\d*)$/u` guarantees `m[1]` is a non-empty
    match of `[1-9]\d*` when `m !== null`. Zero code path can produce
    `m !== null && m[1] === undefined`.
  - By the time we call `asChainId(Number(digits))`, `digits` has
    already passed: (a) regex `[1-9]\d*` (positive integer) AND
    (b) the BigInt overflow guard (≤ MAX_SAFE_INTEGER). So
    `Number(digits)` is always a positive integer in safe range;
    `asChainId` cannot throw.
- **Fix**: Collapsed the `m === null` + `m[1] === undefined` guard into
  one branch (compiler still narrows `digits` to `string` via the
  short-circuit), and removed the unreachable `try/catch` around
  `asChainId`. Code shrank ~14 lines; coverage rose from 79.59% →
  100%. Semantics unchanged.
- **Aplicar en**: Future orchestrators should declare defense-in-depth
  branches only where input actually *can* produce them (e.g. after
  boundaries that weaken types, not after regex + BigInt guards that
  narrow them). Overly defensive code lowers coverage without adding
  protection.

---

### [2026-04-23 01:26] W0 — `VerifyRequest` not structurally assignable to `VerifyParams` (signature branded type)

- **Error**: W2 build will fail when writing `const params: VerifyParams = parsed as unknown as VerifyParams;`
  because `VerifyRequest.payload.signature` is `string` (Zod `z.string().regex(...)`)
  but `VerifyParams.payload.signature` is `` `0x${string}` ``.
- **Causa raíz**: Zod `.regex()` does NOT narrow the inferred type to a
  template literal type. The `as unknown as VerifyParams` cast in the
  Story §W2 skeleton is the sanctioned bridge. This is expected — see
  Story §W2 line 516: "VerifyRequest is structurally assignable to
  VerifyParams because … hex/address fields: strings that match the
  branded regex". The `as unknown as VerifyParams` cast is allowed at
  this single boundary.
- **Fix**: None needed at W0 — the schema is correct. Just noting the
  expected type-gap for W2.
- **Aplicar en**: W2 will use `as unknown as VerifyParams` exactly once,
  with a comment citing this entry.

---
