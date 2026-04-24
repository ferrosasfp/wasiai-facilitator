# Auto-Blindaje — WFAC-50 Kite Testnet Adapter

### [2026-04-23] Wave 0 — Pre-existing env tests break when new superRefine enforces new prod-required vars
- **Error**: WFAC-5 AC-1 + WFAC-32 T1/T3 tests failed after extending `.superRefine` with OPERATOR_PRIVATE_KEY + KITE_USDC_ADDRESS required checks. Those pre-existing tests pass `NODE_ENV: 'production'` but provide neither var, so the new checks fail.
- **Causa raíz**: superRefine runs on every parse; adding two new required keys for non-test NODE_ENV inevitably breaks prior test fixtures that only supplied `REDIS_URL` for prod.
- **Fix**: Update the 3 impacted tests in `env.test.ts` to also pass `OPERATOR_PRIVATE_KEY` + `KITE_USDC_ADDRESS` dummy values. Not a test expansion — just keeping the fixtures aligned with the new required env-in-prod contract. The tests retain their original assertion focus (Redis, Supabase).
- **Aplicar en**: cualquier HU futura que agregue una superRefine prod-required a EnvSchema — actualizar fixtures existentes en el mismo commit.

### [2026-04-23] Wave 0 — Unused eslint-disable in wallet.ts
- **Error**: ESLint reported `Unused eslint-disable directive (no problems were reported from 'security/detect-object-injection')` on the line inside `getOperatorAccount()`.
- **Causa raíz**: The Story suggested to add an `eslint-disable-next-line security/detect-object-injection` comment, but `process.env['OPERATOR_PRIVATE_KEY']` uses a literal string key and ESLint's detector does not flag it. The eslint-plugin-security rule only triggers on variable/dynamic index access.
- **Fix**: Remove the directive (it was orphaned; `--max-warnings 0` rejects unused directives).
- **Aplicar en**: solo agregar `eslint-disable-next-line security/detect-object-injection` cuando la key es una VARIABLE (dynamic index), no cuando es un LITERAL string. Verificar con `npm run lint` post-edit siempre.

