# Auto-Blindaje — #027 / WKH-217 / HU-SOL-14 (Solana fee-payer sponsorship)

Errores cometidos durante F3 y su corrección, para blindar futuras HUs.

### [2026-07-22] W-1 — Base branch: `main` NO tiene WKH-205
- **Error**: la orden decía "branch desde `main`", pero `main` del facilitator NO tiene mergeado WKH-205 (branch `feat/026-wkh-205-solana-adapter`): faltan `@solana/web3.js` en `package.json`, `src/chains/solana-adapter.ts`, y el bloque Solana de `env.ts`. Todo el baseline del Story File asume que esos artefactos existen.
- **Causa raíz**: HU stacked/dependiente — WKH-217 se construye sobre WKH-205, que aún no está en prod (`main`).
- **Fix**: crear `feat/027-wkh-217-solana-feepayer-sponsorship` desde `feat/026-wkh-205-solana-adapter` (la dependencia real), no desde `main`. Baseline `npm run qa` verde (873 tests) confirmado antes de tocar código.
- **Aplicar en**: cualquier HU de la cadena Solana (SOL-13, SOL-6…) mientras 026 no esté en `main` — branchear desde la HU previa, no desde `main`. Al mergear, respetar el orden 026 → 027.

### [2026-07-22] W1 — `noUncheckedIndexedAccess` en CR-1
- **Error**: 10 errores TS2532/TS18048 en `cr1.ts` — `businessIx[0]`, `keys[INDEX]` son `T | undefined` bajo `noUncheckedIndexedAccess`.
- **Causa raíz**: el tsconfig tiene `noUncheckedIndexedAccess: true`; el acceso por índice a arrays nunca es "seguro" para el compilador aunque haya un `length` check antes.
- **Fix**: destructuring por nombre (`const [sender, , , , , tokenProgram, ataProgram, systemProgram] = keys`) + guards `=== undefined`, y `keys.slice()/.some()` para las remaining. Bonus: elimina también los warnings `security/detect-object-injection`.
- **Aplicar en**: todo parseo de arrays/instrucciones (SOL-13 `validateReleaseForSponsor`). Nunca `arr[i]` sin guard; preferir destructuring/`.slice`/`.at`.

### [2026-07-22] W2 — `request.auditMeta.errorCode` es un tipo compartido EVM-scoped
- **Error**: TS2322 al asignar `errorCode: 'SPONSOR_REJECTED'` — la unión `AuditMeta.errorCode` (en `src/core/audit.ts`) sólo admite códigos EVM/x402 + literales del settle.
- **Causa raíz**: `audit.ts` es un tipo compartido y NO está en el Scope IN de esta HU (CD-16: no widenizar tipos compartidos fuera de scope).
- **Fix**: NO setear `request.auditMeta.errorCode` desde la ruta sponsor. El warn estructurado propio ya lleva `error_code` para observabilidad; la fila de audit registra status+path. Evita tocar `audit.ts` (fuera de scope).
- **Aplicar en**: SOL-13 y cualquier ruta nueva no-EVM — no reusar el enum EVM de audit; loguear el código propio en el warn estructurado.

### [2026-07-22] W4 — ESLint `--max-warnings 0`: 3 clases de hallazgo
- **Error**: (a) `@typescript-eslint/consistent-type-imports` prohíbe `importActual<typeof import('x')>()`; (b) `security/detect-object-injection` en accesos `process.env[varKey]` y `obj[k]`; (c) `PublicKey` importado como valor pero usado sólo como tipo; (d) `no-secrets` disable "unused" sobre `'111…'` (baja entropía).
- **Causa raíz**: el gate es `eslint --max-warnings 0` — los WARNINGS también rompen.
- **Fix**: (a) `import type * as Web3 from '@solana/web3.js'` + `importActual<typeof Web3>()`; (b) acceso a `process.env` por dot-notation literal (`process.env.SOLANA_FEE_PAYER_PRIVATE_KEY`), destructuring en vez de índice variable, y save/restore de env explícito por-variable en tests; (c) split `import type { PublicKey }`; (d) quitar el disable innecesario del System program id.
- **Aplicar en**: todos los tests que mockeen módulos (patrón `import type * as Mod` + `vi.mock(..., importActual => importActual<typeof Mod>())`), y todo acceso a `process.env` — usar dot-notation con nombre literal, nunca `process.env[variable]`.

### [2026-07-22] W4 — Prettier format:check
- **Error**: 3 archivos con estilo no-Prettier (rompía `format:check`).
- **Causa raíz**: escribí líneas más largas que el `printWidth` del repo.
- **Fix**: `npx prettier --write` sobre los 3 archivos; re-check verde.
- **Aplicar en**: correr `npx prettier --check` (o `--write`) antes de dar por cerrada una wave; el gate `npm run qa` incluye `format:check`.
