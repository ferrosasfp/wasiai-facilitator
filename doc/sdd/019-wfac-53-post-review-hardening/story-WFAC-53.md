# Story File — WFAC-53 Post-review hardening (multi-chain, multi-consumer)

> Contrato self-contained para `nexus-dev` (F3).
> Si algo NO está en este archivo, el Dev no lo va a hacer.
> Si detectás drift entre este Story File y `main`, STOP y reportá al orquestador.

---

- **Work Item**: `doc/sdd/019-wfac-53-post-review-hardening/work-item.md`
- **SDD**: `doc/sdd/019-wfac-53-post-review-hardening/sdd.md`
- **Pipeline**: QUALITY · **Sizing**: L · **SDD_MODE**: full
- **Branch**: `fix/wfac-53-post-review-hardening` (NEW, desde `d6ccd5f`)
- **Base commit (main)**: `d6ccd5f` (post-PR #34)
- **Architect**: nexus-architect · **Fecha**: 2026-05-11
- **Test baseline pre-HU**: **553/553 passed** (CD-2 enforcement target)
- **Test target post-HU**: **≥569 passed, 0 failed** (553 + 16 new + 1 cross-chain)
- **Commits planificados**: 5 locales (C1..C5) + 1 acción externa (FIX-5 GitHub UI)

---

## 0. Pre-flight (verifiable hoy, antes de tocar código)

### 0.1 Required reading (orden estricto)

1. **Este archivo (`story-WFAC-53.md`)** — único contrato self-contained.
2. **Solo si encontrás drift entre este Story File y `main`** → leé el `sdd.md` y `work-item.md` para reconciliar, luego **STOP** y reportá al orquestador.
3. Exemplars (§0.5) — leé los archivos referenciados ANTES de modificar/crear los archivos correspondientes.

### 0.2 Environment gate (verifiable)

```bash
pwd
# esperado: /home/ferdev/.openclaw/workspace/wasiai-facilitator

git status
# esperado: clean tree

git rev-parse HEAD
# esperado: d6ccd5f (o un descendiente en main que NO modifique los Scope IN files)

git log --oneline -1
# esperado: d6ccd5f (o "Merge pull request #34" head)

npm test -- --run 2>&1 | tail -3
# esperado: Tests  553 passed (553)

npm run lint
# esperado: exit 0 (puede haber warnings security/detect-object-injection pre-FIX-4 — esos son los que vamos a remover)

npm run typecheck
# esperado: exit 0
```

### 0.3 Branch creation (DT-A)

```bash
git checkout main
git pull --ff-only origin main           # confirmar HEAD == d6ccd5f o descendiente sin cambios en Scope IN
git checkout -b fix/wfac-53-post-review-hardening
```

> Si `git pull` introduce commits que tocan `src/chains/*`, `src/core/settle-cap.ts`, `src/routes/settle.ts`, `src/app.ts`, `src/infra/env.ts`, `src/chains/abi/fiat-token.ts`, `src/methods/eip3009/abi.ts` o `doc/architecture/SECURITY.md` → **STOP**. El SDD asume baseline `d6ccd5f` y detectó drift → reportá al orquestador.

### 0.4 Anti-Hallucination Checklist (validá ANTES de cada wave)

- [ ] Estoy en branch `fix/wfac-53-post-review-hardening`, NO en `main`.
- [ ] El stack es Fastify + Zod + viem + pino + ioredis + Supabase (TypeScript strict). NO ethers, NO Express.
- [ ] **NO voy a tocar** `src/chains/registry.ts`, `src/chains/circuit-breaker.ts`, `src/chains/init-breakers.ts`, `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/middleware/**`, `src/core/*` (excepto `settle-cap.ts` + 1 línea en `audit.ts` DT-O), `src/methods/**` (excepto `eip3009/abi.ts` ABI sync), `src/routes/*` (excepto `settle.ts` FIX-6 wiring), `openapi.yaml`, `BACKLOG.md`, `OWNERS.md`, `CLAUDE.md`, `project-context.md`.
- [ ] **NO voy a agregar dependencias** (`viem`, `zod`, `pino`, `fastify`, `@fastify/cors`, `ioredis-mock`, `vitest` ya están instalados).
- [ ] **NO voy a usar `process.env[VARIABLE]` con variable dinámica** en código nuevo o modificado (CD-13).
- [ ] **NO voy a agregar `eslint-disable security/detect-object-injection`** en ningún archivo de esta HU (CD-10, CD-13).
- [ ] **NO voy a tocar `X402ErrorCode`** en `src/core/types.ts` (CD-15 — `SERVICE_UNAVAILABLE` es route-local).
- [ ] **NO voy a usar `Promise.all` en `initDomainCheck`** — DEBE ser `Promise.allSettled` (CD-14).
- [ ] **NO voy a usar `console.log/info/warn/error`** en código de producción (regla existente `no-console`).
- [ ] **NO voy a mergear Dependabot PRs #3–#7** (HOLD explícito).
- [ ] **NO voy a crear/truncar `doc/architecture/SECURITY.md`** — es APPEND ONLY al archivo existente de 121 líneas (CD-12).
- [ ] **NO voy a crear un helper compartido** entre `kite.ts` y `avalanche.ts` para FIX-4 (rompería OWNERS "agregar nueva chain = 1 archivo").
- [ ] **NO voy a saltearme commits** — son 5 commits secuenciales (C1..C5), uno por FIX. Tras cada commit, `npm test` + `npm run lint` deben pasar (CD-2).
- [ ] **NO voy a modificar `T-SDD-1-ABI-SYNC`** en `chain-adapter.test.ts` — el test ya cubre cualquier entry nueva del ABI por byte-comparison (DT-K).
- [ ] **`DOMAIN_SEPARATOR()` ABI entry se agrega en EL MISMO COMMIT a ambos** `src/chains/abi/fiat-token.ts` Y `src/methods/eip3009/abi.ts` (CD-3, byte-for-byte idéntico).
- [ ] Todos los AC tests usan naming `'AC-N: …'` o `T-X-Y` con referencia explícita al AC cubierto (CD-7).

### 0.5 Exemplars verificados (paths confirmados con Read)

| # | Path | Razón | Wave usado |
|---|------|-------|------------|
| E1 | `src/chains/init-breakers.ts` (31 líneas) | Boot-init module exemplar. OWNERS-compliant: importa solo `pino` (type-only) + `./registry.js`. Llamado desde `src/app.ts:187`. `initDomainCheck` sigue patrón idéntico. | W1 |
| E2 | `src/app.ts:105-110` | CORS register actual (`origin: true` permissive). FIX-1 reemplaza este bloque por callback conditional. | W0 (C2) |
| E3 | `src/app.ts:116-178` | Conditional plugin registration pattern (`if (env.RATE_LIMIT_ENABLED) { await app.register(...) }`). Referencia estructural para FIX-1 + FIX-2 wrapping. | W0 (C2), W1 (C3) |
| E4 | `src/app.ts:41-56` | `BuildAppOptions` interface. FIX-2 agrega `skipDomainCheck?: boolean`. Pattern: campos opcionales con default implícito. | W1 (C3) |
| E5 | `src/app.ts:185-187` | `initChainBreakers(app.log as unknown as Logger)` cast pino documentado (AB-WFAC-41-3). `initDomainCheck` usa el MISMO cast (CD-1 excepción documentada). | W1 (C3) |
| E6 | `src/infra/env.ts:21` | Pattern `z.string().min(1).optional()` para vars opcionales. FIX-1: `CORS_ALLOWED_ORIGINS: z.string().optional()`. | W0 (C2) |
| E7 | `src/infra/env.ts:42-45` | Pattern `z.enum(['true','false']).default('true').transform(...)` para booleans desde env. NO aplica a FIX-6 (es enum literal, no boolean). | W0 (C2) |
| E8 | `src/infra/env.ts:122-146` | `.superRefine()` cross-field validation. **NO usar para FIX-1 ni FIX-6** (ambas son optional/default sin cross-field). | (referencia negativa) |
| E9 | `src/chains/kite.ts:60-66` | `sanitize(e: unknown)` helper truncado a 200 chars. **NO confundir con FIX-4** (es otro helper). | (contexto) |
| E10 | `src/chains/kite.ts:68-75` | `readEnv` con `eslint-disable security/detect-object-injection`. FIX-4 location #1. | W0 (C1) |
| E11 | `src/chains/kite.ts:586-593` | `readUsdcAddress` con disable. FIX-4 location #2. | W0 (C1) |
| E12 | `src/chains/kite.ts:602-606` | `readEnabledFlag` con disable. FIX-4 location #3. | W0 (C1) |
| E13 | `src/chains/avalanche.ts:104-111` | `readRpcUrl` con disable. FIX-4 location #4. | W0 (C1) |
| E14 | `src/chains/avalanche.ts:119-123` | `readEnabledFlag` con disable. FIX-4 location #5. | W0 (C1) |
| E15 | `src/chains/avalanche.ts:95-102` | `USDC_AVALANCHE_MAINNET` token metadata (`name: 'USD Coin'`, `eip712Name: 'USD Coin'`, `eip712Version: '2'`, decimals: 6) — input para domain separator local. | W1 (C3, test) |
| E16 | `src/chains/kite.ts:122-128` | Token metadata default + override (PYUSD testnet vs USDC.e mainnet). Input domain separator local Kite. | W1 (C3, test) |
| E17 | `src/chains/registry.ts:90` | `chainRegistry.listAdapters(): readonly ChainMetadata[]` — driver de FIX-2 iteration (CD-9). | W1 (C3) |
| E18 | `src/chains/registry.ts:66` | `chainRegistry.getAdapter(chainId)` returns `Result<{ adapter }>`. Usado para acceder `adapter.getPublicClient()`. | W1 (C3) |
| E19 | `src/chains/types.ts` (185 líneas) | `ChainMetadata`, `EIP3009Token` (campos `eip712Name`, `eip712Version`, `address`), `ChainAdapter` interface. | W1 (C3) |
| E20 | `src/chains/abi/fiat-token.ts:53-71` | `FIAT_TOKEN_ABI` actual con 1 entry (`transferWithAuthorization`). FIX-2 agrega 2ª entry `DOMAIN_SEPARATOR()`. | W1 (C3) |
| E21 | `src/methods/eip3009/abi.ts` (67 líneas) | ABI sync target — byte-for-byte espejo. CD-3 enforcement via `T-SDD-1-ABI-SYNC` test (existente, no se modifica). | W1 (C3) |
| E22 | `src/__tests__/unit/chain-adapter.test.ts:1046-1100` | `T-SDD-1-ABI-SYNC` test family: `JSON.stringify(chainsAbi.FIAT_TOKEN_ABI) === JSON.stringify(methodAbi.FIAT_TOKEN_ABI)`. **NO modificar** — cubre `DOMAIN_SEPARATOR` automáticamente. | W1 (verification) |
| E23 | `src/__tests__/unit/chains/init-breakers.test.ts` (155 líneas) | Pattern para tests de `initDomainCheck`: `chainRegistry._resetForTesting()` + `makeAdapterWithBreaker()` + `vi.mock('ioredis')`. | W1 (C3) |
| E24 | `src/__tests__/unit/env.test.ts:170-246` | Pattern T-ENV-RL-* + T-ENV-CB-* para tests Zod de env vars (defaults, transforms, exits con stderr). FIX-1 y FIX-6 agregan T-ENV-CORS-* y T-ENV-FAIL-*. | W0 (C2), W3 (C5) |
| E25 | `src/__tests__/unit/rate-limiting.test.ts` (~400 líneas) | Pattern integration Fastify: `buildApp({ rawEnv })` + `app.inject({ method, url, headers })`. Modelo para `app.cors.test.ts`. | W0 (C2) |
| E26 | `src/core/settle-cap.ts` (103 líneas) | `incrementAndCheckDailyCap(cap, logger)` actual. FIX-6 extiende firma con `failMode: 'open' \| 'closed'` y agrega variante `{ ok: false, reason: 'redis_error_failclosed' }`. | W3 (C5) |
| E27 | `src/__tests__/unit/core.settle-cap.test.ts` (111 líneas) | Pattern `vi.mock('../../infra/redis.js', () => ({ getRedisClient: () => mockClient }))`. FIX-6 extiende con 2 tests + fixture update para `failMode` arg. | W3 (C5) |
| E28 | `src/routes/settle.ts:39-53` | `SettleRouteErrorCode` union actual (12 codes). FIX-6 agrega `'SERVICE_UNAVAILABLE'` (CD-15). | W3 (C5) |
| E29 | `src/routes/settle.ts:130-154` | `incrementAndCheckDailyCap` call + handling actual (RATE_LIMITED branch). FIX-6 ramifica el `if (!dailyCap.ok)` por `dailyCap.reason`. | W3 (C5) |
| E30 | `src/core/audit.ts:48-54` | `AuditMeta.errorCode` union actual. DT-O agrega `\| 'SERVICE_UNAVAILABLE'` (1 línea). | W3 (C5) |
| E31 | `doc/architecture/SECURITY.md` (121 líneas, 10 secciones) | Estructura ## H2 + bullets. CD-12 APPEND ONLY: 2 secciones nuevas AL FINAL + extender §1 "Operator wallet" in-place. | W2 (C4) |

### 0.6 Scope IN — los **únicos** archivos a modificar/crear

| # | Path | Acción | Wave | Verificable post-commit con |
|---|------|--------|------|-----------------------------|
| 1 | `src/chains/kite.ts` | MODIFY (refactor `readEnv`/`readUsdcAddress`/`readEnabledFlag` a switch literal; remover 3 `eslint-disable`) | W0 C1 | `git diff d6ccd5f -- src/chains/kite.ts \| grep -c "eslint-disable security"` → 0 |
| 2 | `src/chains/avalanche.ts` | MODIFY (refactor `readRpcUrl`/`readEnabledFlag` a switch literal; remover 2 `eslint-disable`) | W0 C1 | `git diff d6ccd5f -- src/chains/avalanche.ts \| grep -c "eslint-disable security"` → 0 |
| 3 | `src/infra/env.ts` | MODIFY (agregar `CORS_ALLOWED_ORIGINS: z.string().optional()` + `SETTLE_CAP_FAIL_MODE: z.enum(['open','closed']).default('open')`) | W0 C2 (CORS) + W3 C5 (FAIL_MODE) | `grep -n "CORS_ALLOWED_ORIGINS\|SETTLE_CAP_FAIL_MODE" src/infra/env.ts` → 2 entries |
| 4 | `src/__tests__/unit/env.test.ts` | MODIFY (agregar 5 tests: T-ENV-CORS-1..2 + T-ENV-FAIL-1..3) | W0 C2 + W3 C5 | `grep -n "T-ENV-CORS\|T-ENV-FAIL" src/__tests__/unit/env.test.ts` → 5 entries |
| 5 | `src/app.ts` | MODIFY (líneas 105-110: CORS conditional callback) + (post-187: `await initDomainCheck(app.log as unknown as Logger)` wrapped por `skipDomainCheck`) + (BuildAppOptions: agregar `skipDomainCheck?: boolean`) | W0 C2 (CORS) + W1 C3 (domain check + flag) | `grep -n "CORS_ALLOWED_ORIGINS\|initDomainCheck\|skipDomainCheck" src/app.ts` → 3+ entries |
| 6 | `src/__tests__/unit/app.cors.test.ts` | **CREATE NEW** (3 tests AC-1/AC-2/AC-3 vía `buildApp` + `app.inject`) | W0 C2 | `ls src/__tests__/unit/app.cors.test.ts` |
| 7 | `src/chains/abi/fiat-token.ts` | MODIFY (agregar 2ª entry `DOMAIN_SEPARATOR()` al `FIAT_TOKEN_ABI as const`) | W1 C3 | `grep -n "DOMAIN_SEPARATOR" src/chains/abi/fiat-token.ts` → 1 entry |
| 8 | `src/methods/eip3009/abi.ts` | MODIFY (replicar **byte-for-byte** la misma entry de (7)) | W1 C3 (MISMO COMMIT que #7) | `diff <(node -e "console.log(JSON.stringify(require('./dist/chains/abi/fiat-token.js').FIAT_TOKEN_ABI))") <(node -e "...methods/eip3009/abi.js...")` → 0 lines |
| 9 | `src/chains/init-domain-check.ts` | **CREATE NEW** (export `async function initDomainCheck(logger: Logger): Promise<void>`, `Promise.allSettled` over `chainRegistry.listAdapters()`) | W1 C3 | `ls src/chains/init-domain-check.ts` |
| 10 | `src/__tests__/unit/chains.kite.domain-check.test.ts` | **CREATE NEW** (3 tests T-DOM-KITE-1/2/3 cubriendo AC-4/5/7) | W1 C3 | `ls src/__tests__/unit/chains.kite.domain-check.test.ts` |
| 11 | `src/__tests__/unit/chains.avalanche.domain-check.test.ts` | **CREATE NEW** (3 tests T-DOM-AVAX-1/2/3 cubriendo AC-4/5/8) | W1 C3 | `ls src/__tests__/unit/chains.avalanche.domain-check.test.ts` |
| 12 | `src/__tests__/unit/chains.domain-check.multi.test.ts` | **CREATE NEW** (1 cross-chain integration T-DOM-MULTI cubriendo CD-14) | W1 C3 | `ls src/__tests__/unit/chains.domain-check.multi.test.ts` |
| 13 | (Tests existentes que llaman `buildApp({ env })`) | MODIFY (agregar `skipDomainCheck: true` donde no se quiera disparar la check) — lista preliminar en §6 R-4 | W1 C3 | `grep -rn "buildApp({" src/__tests__/ \| grep -v "skipDomainCheck"` → solo tests nuevos de FIX-2 |
| 14 | `doc/architecture/SECURITY.md` | MODIFY (**APPEND ONLY**: 2 secciones nuevas AL FINAL + extender §1 in-place) | W2 C4 | `wc -l doc/architecture/SECURITY.md` → ≥160 (~40 líneas agregadas, sin líneas eliminadas) |
| 15 | `src/core/settle-cap.ts` | MODIFY (extender firma `incrementAndCheckDailyCap` con `failMode: 'open' \| 'closed'`; ramificar `catch`) | W3 C5 | `grep -n "failMode\|redis_error_failclosed" src/core/settle-cap.ts` → ≥2 |
| 16 | `src/routes/settle.ts` | MODIFY (línea 39-53: agregar `'SERVICE_UNAVAILABLE'` al union local; línea 131: pasar `env.SETTLE_CAP_FAIL_MODE`; línea 132+: ramificar branch por `reason`) | W3 C5 | `grep -n "SERVICE_UNAVAILABLE\|redis_error_failclosed" src/routes/settle.ts` → ≥3 |
| 17 | `src/core/audit.ts` | MODIFY (línea 52: agregar `\| 'SERVICE_UNAVAILABLE'` al `errorCode` union) — **DT-O Scope IN extension justificada por observability del fail-closed branch** | W3 C5 | `grep -n "SERVICE_UNAVAILABLE" src/core/audit.ts` → 1 |
| 18 | `src/__tests__/unit/core.settle-cap.test.ts` | MODIFY (agregar T-CAP-CLOSED + T-CAP-OPEN-EXPLICIT; fixture update — todos los `incrementAndCheckDailyCap(...)` calls existentes ahora pasan `'open'` o `'closed'` como 2º arg) | W3 C5 | `grep -n "T-CAP-CLOSED\|T-CAP-OPEN-EXPLICIT\|'closed'\|'open'" src/__tests__/unit/core.settle-cap.test.ts` |

**Cualquier edit fuera de estos 18 archivos = violación de Scope IN.** Archivos CONGELADOS:

- `src/chains/registry.ts`, `src/chains/circuit-breaker.ts`, `src/chains/init-breakers.ts`, `src/chains/types.ts`, `src/chains/index.ts`, `src/chains/abi/signature.ts` — sin cambios.
- `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts` — sin cambios.
- `src/middleware/**` — sin cambios.
- `src/core/types.ts`, `src/core/errors.ts`, `src/core/verify.ts`, `src/core/settle.ts`, `src/core/idempotency.ts`, `src/core/ledger.ts` — sin cambios (sólo `settle-cap.ts` + 1 línea en `audit.ts`).
- `src/methods/eip3009/verify.ts`, `src/methods/eip3009/settle.ts`, `src/methods/eip3009/signature.ts`, `src/methods/eip3009/domain.ts` — sin cambios (sólo `abi.ts` sync).
- `src/routes/verify.ts`, `src/routes/health.ts`, `src/routes/supported.ts`, `src/routes/openapi.ts` — sin cambios.
- `src/index.ts` — sin cambios (DT-I decidió `initDomainCheck` vive en `buildApp`, NO en `index.ts`).
- `openapi.yaml`, `BACKLOG.md`, `OWNERS.md`, `CLAUDE.md`, `project-context.md`, `package.json`, `.env.example` — sin cambios.
- `supabase/migrations/*.sql` — N/A.

### 0.7 Wave dependency graph

```
W0 (low-risk baseline cleanup)
 ├── C1: FIX-4   (kite.ts + avalanche.ts switch refactor — 0 new tests, lint cleanup)
 └── C2: FIX-1   (CORS env + wiring + 3 cors tests + 2 env tests)
     |
W1 (domain separator boot check)
 └── C3: FIX-2   (ABI sync 2 files + init-domain-check.ts + buildApp wiring + skipDomainCheck flag
                  + 6 domain-check tests + 1 cross-chain test + migration de existing buildApp callers)
     |
W2 (docs append)
 └── C4: FIX-3   (SECURITY.md APPEND — 2 nuevas secciones + extender §1)
     |
W3 (fail-mode opt-in)
 └── C5: FIX-6   (env var + settle-cap.ts signature + route handler + audit.ts 1 línea
                  + 2 settle-cap tests + 3 env tests + fixture updates)
     |
DONE
 └── FIX-5 acción externa (GitHub UI merge Dependabot PR #10 + comentario en #3–#7)
```

**Serial obligatorio**: W0 → W1 → W2 → W3 → DONE. CD-2 enforza: tras CADA commit, `npm test` ≥553 PASS + `npm run lint` exit 0.

---

## 1. Acceptance Criteria (EARS) — heredados verbatim del work-item

### FIX-1 — CORS_ALLOWED_ORIGINS cableado

- **AC-1**: WHEN `CORS_ALLOWED_ORIGINS` is a non-empty comma-separated string in `EnvSchema`, the system SHALL configure `@fastify/cors` with a callback that returns `true` only for origins in the parsed list, and `false` with HTTP 403 for any origin not in the list.
- **AC-2**: WHEN `CORS_ALLOWED_ORIGINS` is absent or empty string, the system SHALL configure `@fastify/cors` with `origin: true` (reflect any origin), preserving the current development behavior without breaking change.
- **AC-3**: WHEN the CORS unit test suite runs (`app.cors.test.ts`), the system SHALL PASS 3 cases: (a) whitelisted origin allowed, (b) non-whitelisted origin blocked, (c) empty env var falls back to `origin: true`.

### FIX-2 — Domain separator assertion per-chain at boot

- **AC-4**: WHEN the service boots and a chain's RPC is reachable, the system SHALL call `DOMAIN_SEPARATOR()` on the token contract for each of the 4 enabled chains and compare the on-chain value against the locally computed EIP-712 domain separator; IF they do not match, the system SHALL log a FATAL error and `process.exit(1)`.
- **AC-5**: IF a chain's RPC is unreachable or times out during the domain separator check, the system SHALL log a WARN (not fatal) and allow boot to continue (non-blocking check).
- **AC-6**: WHEN `DOMAIN_SEPARATOR()` is added to `FIAT_TOKEN_ABI` in `src/chains/abi/fiat-token.ts`, the system SHALL replicate the identical function entry in `src/methods/eip3009/abi.ts` in the same commit so that test `T-SDD-1-ABI-SYNC` continues to PASS.
- **AC-7**: WHEN the Kite domain-separator test suite runs (`chains.kite.domain-check.test.ts`), the system SHALL PASS 3 cases: (a) match → boot continues, (b) mismatch → fatal exit called, (c) RPC failure → warn logged, boot continues.
- **AC-8**: WHEN the Avalanche domain-separator test suite runs (`chains.avalanche.domain-check.test.ts`), the system SHALL PASS 3 cases with identical semantics to AC-7.

### FIX-3 — SECURITY.md append

- **AC-9**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit, the file SHALL contain a "Failure Modes" section documenting: (a) Redis outage causes rate-limit bypass (`skipOnError:true`), (b) Redis outage causes SETTLE_DAILY_GLOBAL_CAP fail-open (reference FIX-6 env var), (c) domain separator drift mitigated by FIX-2 boot check.
- **AC-10**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit, the existing "Operator Wallet" section SHALL be extended to include: (a) note that V1 uses a single hot key per chain, (b) V2 recommendation to use separate keys per chain, (c) list of env vars that MUST NOT be logged (`OPERATOR_PRIVATE_KEY`, `SUPABASE_SERVICE_KEY`).
- **AC-11**: WHEN `doc/architecture/SECURITY.md` is inspected after this commit, the file SHALL contain a "Reporting" section with a security disclosure email address and SLA timeframe for acknowledgement. **Provisional aceptado**: `security@wasiai.io` + 48h SLA. To-verify-pre-merge con operador.

### FIX-4 — Remove eslint-disable security/detect-object-injection

- **AC-12**: WHEN `npm run lint` is executed after this commit, the system SHALL exit 0 with 0 instances of `eslint-disable security/detect-object-injection` in the following 5 locations: `src/chains/avalanche.ts:105` (readRpcUrl), `src/chains/avalanche.ts:120` (readEnabledFlag), `src/chains/kite.ts:69` (readEnv), `src/chains/kite.ts:587` (readUsdcAddress), `src/chains/kite.ts:603` (readEnabledFlag); each location replaced with a switch/ternary over literal env-var names.
- **AC-13**: WHILE FIX-4 is applied, the system SHALL continue to PASS all 553 baseline tests without modification to test files.

### FIX-5 — Dependabot PR #10 merge (external action)

- **AC-14**: WHEN Dependabot PR #10 (`actions/upload-artifact` 4→7) CI is green, the system SHALL merge PR #10 into main without a local commit (GitHub UI merge). Dependabot PRs #3–#7 (runtime major bumps) SHALL receive a comment "Holding until manual smoke test" and remain open.

### FIX-6 — SETTLE_CAP_FAIL_MODE configurable

- **AC-15**: WHEN `SETTLE_CAP_FAIL_MODE=closed` is set, the system SHALL return HTTP 503 with error body `{ error: { code: 'SERVICE_UNAVAILABLE', message: 'Settlement cap check failed — service unavailable', http: 503 } }` if the Redis `incr` call in `incrementAndCheckDailyCap` throws, instead of the current fail-open behavior.
- **AC-16**: WHEN `SETTLE_CAP_FAIL_MODE` is absent or set to `open`, the system SHALL preserve the existing fail-open behavior (request allowed through on Redis error), maintaining backward compatibility.
- **AC-17**: WHEN the settle-cap unit test suite runs (`core.settle-cap.test.ts`), the system SHALL PASS 2 new cases: (a) `SETTLE_CAP_FAIL_MODE=closed` + Redis error → returns `{ ok: false }` with 503 hint, (b) `SETTLE_CAP_FAIL_MODE=open` + Redis error → returns `{ ok: true }` (existing behavior unchanged).

### Zero-regression

- **AC-18**: WHEN the full test suite (`npm test`) is executed after all 6 commits, the system SHALL report ≥553 PASS and 0 FAIL.
- **AC-19**: WHEN `npm run lint` is executed after all 6 commits, the system SHALL exit 0 with no ESLint errors or warnings related to security rules.

---

## 2. Constraint Directives — 16 totales (12 heredados + 4 nuevos)

> Cada CD se aplica a TODA la HU. Una violación = BLOQUEANTE en AR/CR.

### Heredados del work-item

- **CD-1**: TypeScript strict — **no `any`, no `as unknown`** EXCEPTO el cast documentado `app.log as unknown as Logger` (heredado de WFAC-41 AB-WFAC-41-3) en la invocación de `initDomainCheck`. Mismo cast usado para `initChainBreakers` en `src/app.ts:187`.
- **CD-2**: Baseline MUST NOT regress — `npm test` ≥553 PASS, 0 FAIL **después de cada commit individual** (no sólo el final).
- **CD-3**: ABI sync byte-for-byte — `FIAT_TOKEN_ABI` en `src/chains/abi/fiat-token.ts` y `src/methods/eip3009/abi.ts` MUST be identical después del commit C3. Test `T-SDD-1-ABI-SYNC` (chain-adapter.test.ts:1051-1056) enforza con `JSON.stringify(a) === JSON.stringify(b)`.
- **CD-4**: OWNERS.md boundaries inviolables — `src/chains/init-domain-check.ts` MAY importar `./registry.js`, `./abi/fiat-token.js`, `viem`, `pino` (type-only). MUST NOT importar `src/methods/*`, `src/core/*` (runtime), `src/routes/*`, `src/infra/*`.
- **CD-5**: NexusAgil pipeline anchors untouched — no modificar comentarios con `CD-N`, `WFAC-N`, `DT-N`, `T-SDD-1-ABI-SYNC` en archivos existentes (excepto la extensión obvia con códigos de este SDD).
- **CD-6**: FIX-2 boot check **non-blocking en RPC failure** (warn + continue) y **FATAL only on successful RPC response with mismatching separator**. El proceso MUST NOT exit en network timeout/unreachable RPC.
- **CD-7**: Cada AC SHALL tener ≥1 test que lo cubre. Test names MUST reference AC number (e.g., `'AC-4: domain separator match → boot continues'` o `'T-DOM-KITE-1 (AC-4, AC-7a): match → boot continues'`).
- **CD-8**: FIX-6 default `'open'` preserva comportamiento exacto. `SETTLE_CAP_FAIL_MODE` ausente ≡ `SETTLE_CAP_FAIL_MODE=open`.
- **CD-9**: Per-chain domain check sobre todas las chains REGISTRADAS en runtime — driven by `chainRegistry.listAdapters()`, **no hardcodea chain IDs**.
- **CD-10**: `eslint-plugin-security/detect-object-injection` MUST NOT be suppressed via inline comments en las 5 ubicaciones FIX-4 (refactor estructural switch literal, no comment suppress).
- **CD-11**: `CORS_ALLOWED_ORIGINS` es `z.string().optional()` (raw CSV) parseado manualmente en `app.ts` por `String.prototype.split(',').map(trim).filter(nonEmpty)`. **NO Zod CSV transform** (riesgo de silently-swallowed empty entries).
- **CD-12**: FIX-3 SECURITY.md es **APPEND ONLY**. Dev MUST leer las 121 líneas existentes antes de editar. Crear/truncar el archivo = **BLOQUEANTE**.

### Nuevos identificados por Architect en F2

- **CD-13** (NEW, lección AB-WFAC-50-2 + AB-WFAC-41-2): **NO agregar `eslint-disable security/detect-object-injection`** en NINGÚN archivo modificado por esta HU. Si tras el refactor FIX-4 alguna línea aún dispara la regla, **el refactor está incompleto** — el approach correcto es seguir convirtiendo a switch/literal access (NUNCA agregar un disable nuevo). `npm run lint -- --max-warnings 0` debe pasar.
- **CD-14** (NEW): `initDomainCheck` MUST usar `Promise.allSettled` (no `Promise.all`) para que UNA chain con RPC down no bloquee el check de las otras 3. `Promise.all` rejecta al primer error → violación AC-5.
- **CD-15** (NEW): `SERVICE_UNAVAILABLE` se agrega SOLO al union local `SettleRouteErrorCode` en `src/routes/settle.ts`. **NUNCA** se agrega a `X402ErrorCode` en `src/core/types.ts` (no es spec x402). Patrón consistente con `'RATE_LIMITED'` (WFAC-40) y `'INVALID_PAYLOAD'`.
- **CD-16** (NEW): `BuildAppOptions.skipDomainCheck?: boolean` default `false`. Tests existentes que importen `buildApp` y NO configuren chain adapters realistas deben pasar `skipDomainCheck: true` para evitar warns/fatals espurios. Lista preliminar en §6 R-4.

### Prohibido (explícito)

- ❌ NO agregar dependencias nuevas (viem/zod/pino/fastify-cors ya instalados).
- ❌ NO modificar `openapi.yaml` — el 503 SERVICE_UNAVAILABLE es comportamiento condicional documentado en SECURITY.md, no schema obligatorio.
- ❌ NO modificar `src/middleware/**`, `src/infra/wallet.ts`, `src/infra/redis.ts`, `src/infra/supabase.ts`, `src/chains/registry.ts`.
- ❌ NO crear `src/chains/util/*` u otro helper compartido entre kite.ts y avalanche.ts para FIX-4.
- ❌ NO usar `process.env[VARIABLE]` con variable dinámica en código nuevo o modificado.
- ❌ NO mergear Dependabot PRs #3–#7 (HOLD explícito).
- ❌ NO escribir `console.log/info/warn/error` en código de producción (regla `no-console` existente).
- ❌ NO commitear FIX-2 sin haber actualizado AMBOS archivos ABI en el MISMO commit (CD-3).
- ❌ NO usar `--no-verify`, `--no-gpg-sign` ni `--amend` en commits.

---

## 3. Risks inventory (10 riesgos del SDD §9 con mitigaciones Dev-actionable)

| # | Riesgo | Prob | Impacto | Acción Dev |
|---|--------|------|---------|------------|
| **R-1** | FIX-2 mismatch falso positivo por desalineación de metadata (eip712Version o eip712Name) → fatal exit en boot | M | A | Antes de C3 commit, leé `src/chains/kite.ts:124-128` y `src/chains/avalanche.ts:95-102` y confirmá que la metadata token usada en los TESTS coincide con la usada en los ADAPTERS reales. Si hay mismatch real en prod, lo va a detectar el smoke E2E post-merge — NO es scope del Dev. |
| **R-2** | `Promise.allSettled` swallows errores fuera del RPC (e.g., excepción en `domainSeparator()` local compute) | B | M | En `checkOneChain()`, envolvé el bloque `localSep = viem.domainSeparator(...)` en su propio try/catch → reject explícito con el error original. Cualquier error no-mismatch se loguea como warn (consistente AC-5). |
| **R-3** | Nuevas env vars (FIX-1, FIX-6) violan AB-WFAC-50-1 si requieren superRefine prod-required → rompe T-ENV-WFAC50 | M | M | **Ambas vars son optional**: FIX-1 = `z.string().optional()` (default `undefined`); FIX-6 = `z.enum(['open','closed']).default('open')`. **NO agregar `.superRefine()`** que las haga required-en-prod. Verificación: post-C2 + post-C5 correr `npm test src/__tests__/unit/env.test.ts -- --run` debe pasar igual que antes. |
| **R-4** | Tests existentes que llaman `buildApp({ env })` sin adapters realistas → `initDomainCheck` itera 0 → OK. PERO si algún test registra fake adapter sin `getPublicClient().readContract` mock → fatal exit | **A** | **A** | **Mitigación dual obligatoria:** (a) `BuildAppOptions.skipDomainCheck` default `false` → todos los buildApp callers default-on. Tests con adapters mock sin readContract DEBEN pasar `skipDomainCheck: true`. (b) Durante C3, ejecutá `grep -rn "await buildApp\|buildApp(" src/__tests__/` y revisá uno por uno (~9 archivos). Lista preliminar a auditar en C3: `init-breakers.test.ts`, `routes.openapi.test.ts`, `routes.settle.test.ts`, `routes.verify.test.ts`, `routes.supported.test.ts`, `rate-limiting.test.ts`, `audit.test.ts`, `health.test.ts`, `shutdown.test.ts`. Para CADA uno: si el test NO registra adapter realista con `getPublicClient`, agregá `skipDomainCheck: true` al `buildApp({...})` call. |
| **R-5** | FIX-4 switch refactor rompe edge case (e.g., trimmed empty string) | B | M | Cada `case` retorna `process.env.LITERAL` (`string \| undefined`); el check `!value \|\| value.trim() === ''` se preserva igual. Tests existentes para `ChainAdapterInitError` (en `chain-adapter.test.ts`) capturan regresiones. NO modificar los call-sites: `readEnv('KITE_TESTNET_RPC_URL', 2368)` queda igual; sólo se restringe el TYPE del parámetro `name`. |
| **R-6** | `SERVICE_UNAVAILABLE` route-local conflict con audit code typing | B | B | DT-O resuelto: agregar `\| 'SERVICE_UNAVAILABLE'` al union `AuditMeta.errorCode` en `src/core/audit.ts:52`. 1 línea, mismo pattern que `'RATE_LIMITED'` (WFAC-40). Esta 1 línea SUMA `audit.ts` al Scope IN (justificación: observability del fail-closed branch). Si Adversary lo bloquea, fallback: NO setear `request.auditMeta.errorCode` en el branch fail-closed (degrada observability pero cumple AC literales). **Default action**: agregar la línea — es el patrón establecido. |
| **R-7** | FIX-2 introduce latencia de boot (4 RPC reads) | B | B | `Promise.allSettled` paraleliza las 4 reads. Latencia bounded por chain más lenta (~1-2s testnet). Aceptable boot-time (one-time). NO optimizar (out of scope). |
| **R-8** | Dev olvida actualizar `src/methods/eip3009/abi.ts` al editar `src/chains/abi/fiat-token.ts` | M | A | `T-SDD-1-ABI-SYNC` (chain-adapter.test.ts:1051-1056) corre en CI y rompe el commit. **REGLA**: editar AMBOS archivos en el MISMO commit C3. Verificación local: `npm test src/__tests__/unit/chain-adapter.test.ts` antes del commit. |
| **R-9** | FIX-3 APPEND choca con merge conflicts si otro PR toca SECURITY.md | B | B | Baseline `d6ccd5f` tiene SECURITY.md estable. Sin otros PRs abiertos tocándolo. Si pasa en review → rebase manual + reaplicar APPEND. |
| **R-10** | `DOMAIN_SEPARATOR()` entry en FIAT_TOKEN_ABI rompe consumers que iteran el array | B | B | Verificado: ningún consumer itera `FIAT_TOKEN_ABI.length` o `[0]`. Usado sólo con viem `simulateContract`/`writeContract`/`readContract` que matchean por `functionName`. Agregar 1 entry es seguro. Verificación: `grep -rn "FIAT_TOKEN_ABI\[\|FIAT_TOKEN_ABI\.length" src/` → 0 hits. |

---

## 4. Waves de implementación

> **Regla absoluta**: después de cada commit C1..C5, antes de continuar a la siguiente wave, validar `npm test -- --run` ≥553 PASS + `npm run lint` exit 0 + `npm run typecheck` exit 0. Si algo falla → fix-forward (NO `--amend`, NO `--no-verify`).

---

### W0 — Low-risk baseline cleanup

#### Commit C1 — FIX-4 (5 ESLint refactors)

**Archivos**: `src/chains/kite.ts`, `src/chains/avalanche.ts`.
**Tests nuevos**: 0 (CD-2 baseline + CD-19 lint cubren).
**Estrategia**: switch literal sobre union de literales (DT-H). NO Record lookup. NO helper compartido entre kite/avalanche (CD respeta OWNERS "1 chain = 1 archivo").

##### Snippet ejemplar — kite.ts `readEnv` (location 1)

```ts
// ─────────── ANTES (src/chains/kite.ts:68-75) ───────────
function readEnv(name: string, chainId: number): string {
  // eslint-disable-next-line security/detect-object-injection -- caller-controlled literal...
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
  }
  return value;
}

// ─────────── DESPUÉS ───────────
type KiteRpcEnvName = 'KITE_TESTNET_RPC_URL' | 'KITE_MAINNET_RPC_URL';

function readEnv(name: KiteRpcEnvName, chainId: number): string {
  let value: string | undefined;
  switch (name) {
    case 'KITE_TESTNET_RPC_URL':
      value = process.env.KITE_TESTNET_RPC_URL;
      break;
    case 'KITE_MAINNET_RPC_URL':
      value = process.env.KITE_MAINNET_RPC_URL;
      break;
  }
  if (!value || value.trim() === '') {
    throw new ChainAdapterInitError(name, chainId);
  }
  return value;
}
```

**Aplicar el MISMO patrón** a las otras 4 ubicaciones (mismo shape, cambia el union y los cases):

| Location | Función | Union para el parámetro | Cases en switch |
|----------|---------|-------------------------|-----------------|
| `kite.ts:586` | `readUsdcAddress(envVarName, chainIdNum)` | `'KITE_USDC_ADDRESS' \| 'KITE_MAINNET_USDC_ADDRESS'` | 2 cases con `process.env.KITE_USDC_ADDRESS` / `process.env.KITE_MAINNET_USDC_ADDRESS` |
| `kite.ts:602` | `readEnabledFlag(envVarName)` | (probable) `'KITE_MAINNET_ENABLED'` (única chain Kite con flag — verificar call-site) | 1 case (o 2 si verificación de call-sites detecta más). **VERIFICAR antes del commit**: `grep -n "readEnabledFlag(" src/chains/kite.ts` |
| `avalanche.ts:104` | `readRpcUrl(envVarName, chainIdNum)` | `'AVALANCHE_FUJI_RPC_URL' \| 'AVALANCHE_MAINNET_RPC_URL'` | 2 cases |
| `avalanche.ts:119` | `readEnabledFlag(envVarName)` | `'AVALANCHE_MAINNET_ENABLED'` (única chain Avax con flag — verificar) | 1+ case (`grep -n "readEnabledFlag(" src/chains/avalanche.ts` antes del commit) |

> **NO crear helper compartido**. El switch vive inline en cada file. Si Adversary sugiere "DRY", explicá que rompe OWNERS "agregar nueva chain = 1 archivo".

##### Verificación post-C1

```bash
# 1. Cero eslint-disable security en kite.ts + avalanche.ts:
grep -n "eslint-disable.*security/detect-object-injection" src/chains/kite.ts src/chains/avalanche.ts
# esperado: 0 hits

# 2. Lint clean:
npm run lint -- --max-warnings 0
# esperado: exit 0

# 3. Baseline preservada:
npm test -- --run 2>&1 | tail -3
# esperado: Tests  553 passed (553)

# 4. Typecheck:
npm run typecheck
# esperado: exit 0
```

##### Commit message C1

```
fix(WFAC-53): remove eslint-disable security/detect-object-injection (FIX-4)

Refactor readEnv/readUsdcAddress/readEnabledFlag in kite.ts and
readRpcUrl/readEnabledFlag in avalanche.ts to use switch over literal
env-var-name unions (DT-H). Static literal indexing eliminates the
need for the eslint-disable comment (CD-10, CD-13).

Zero behavior change. All 553 baseline tests still passing.

Refs: WFAC-53 AC-12, AC-13, CD-10, CD-13
```

---

#### Commit C2 — FIX-1 (CORS env + wiring + 5 tests)

**Archivos**:
- `src/infra/env.ts` (add `CORS_ALLOWED_ORIGINS`)
- `src/app.ts` (líneas 105-110: cors register condicional)
- `src/__tests__/unit/env.test.ts` (+2 tests T-ENV-CORS-1/2)
- `src/__tests__/unit/app.cors.test.ts` (NEW, +3 tests T-CORS-1/2/3)

##### Snippet — env.ts addition

```ts
// Dentro del z.object({...}) en src/infra/env.ts, sumar (orden libre, pero
// junto a otros optional strings como REDIS_URL/SUPABASE_URL):

  /**
   * WFAC-53 FIX-1 — CORS origin whitelist. Raw CSV string (NO Zod transform per
   * CD-11). When absent or empty → @fastify/cors uses `origin: true` (reflect
   * any). When non-empty → callback returns true only for listed origins.
   * Examples: 'https://a2a.wasiai.io,https://app.wasiai.io'
   */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
```

##### Snippet — app.ts CORS wiring (reemplazo líneas 105-110)

```ts
// ─────────── ANTES (src/app.ts:102-110) ───────────
// CORS — permissive origin: true (reflects Origin header)...
await app.register(cors, {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400,
});

// ─────────── DESPUÉS ───────────
// WFAC-53 FIX-1 — CORS origin policy.
//   - CORS_ALLOWED_ORIGINS absent or empty → origin: true (legacy permissive).
//   - CORS_ALLOWED_ORIGINS = "https://a,https://b" → callback whitelist.
// CD-11: manual CSV parse (split + trim + filter), NO Zod transform.
const corsAllowedOrigins: readonly string[] = (env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

const corsOriginPolicy = corsAllowedOrigins.length === 0
  ? true
  : (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void => {
      // CORS spec: same-origin requests have no Origin header → reflect (cb true).
      if (!origin) return cb(null, true);
      if (corsAllowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false); // @fastify/cors emits 403 + no ACAO header
    };

await app.register(cors, {
  origin: corsOriginPolicy,
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 86400,
});
```

> **Confirmá los tipos exactos del callback** mirando los types de `@fastify/cors` (`node_modules/@fastify/cors/types/index.d.ts`). Ajustá `cb: (err: Error | null, allow: boolean) => void` al type real de `FastifyCorsOptions['origin']` si difiere — la idea conceptual no cambia.

##### Snippet — env.test.ts (+2 tests)

```ts
// En src/__tests__/unit/env.test.ts, sumar bajo describe('parseEnv', ...):

it('T-ENV-CORS-1 (FIX-1 AC-2): CORS_ALLOWED_ORIGINS defaults undefined when missing', () => {
  const result = parseEnv({ NODE_ENV: 'test' });
  expect(result.CORS_ALLOWED_ORIGINS).toBeUndefined();
});

it('T-ENV-CORS-2 (FIX-1 AC-1): parses CSV string as-is (no Zod transform — CD-11)', () => {
  const result = parseEnv({
    NODE_ENV: 'test',
    CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io,https://app.wasiai.io',
  });
  expect(result.CORS_ALLOWED_ORIGINS).toBe('https://a2a.wasiai.io,https://app.wasiai.io');
  expect(typeof result.CORS_ALLOWED_ORIGINS).toBe('string'); // raw, not transformed
});
```

##### Snippet — app.cors.test.ts NEW (+3 tests)

```ts
/**
 * WFAC-53 FIX-1 — CORS_ALLOWED_ORIGINS unit tests.
 *
 * Pattern: buildApp({ rawEnv }) + app.inject({ method, url, headers }) — mirrors
 * src/__tests__/unit/rate-limiting.test.ts. Each test exercises a different
 * CORS_ALLOWED_ORIGINS configuration end-to-end through @fastify/cors.
 *
 * Refs: AC-1, AC-2, AC-3, CD-11.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

describe('CORS_ALLOWED_ORIGINS — FIX-1 (WFAC-53)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    // Reset Redis singleton between tests (rate-limit plugin reads it on boot).
    const { resetRedisClientForTests } = await import('../../infra/redis.js');
    resetRedisClientForTests();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('T-CORS-1 (AC-1): whitelisted Origin returns Access-Control-Allow-Origin header', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io,https://app.wasiai.io',
        // RATE_LIMIT_ENABLED=false to isolate CORS-only path:
        RATE_LIMIT_ENABLED: 'false',
      },
      skipDomainCheck: true, // CD-16 — no chain adapters configured here
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://a2a.wasiai.io',
        'access-control-request-method': 'GET',
      },
    });

    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers['access-control-allow-origin']).toBe('https://a2a.wasiai.io');
  });

  it('T-CORS-2 (AC-1): non-whitelisted Origin gets 403 / no ACAO header', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        CORS_ALLOWED_ORIGINS: 'https://a2a.wasiai.io',
        RATE_LIMIT_ENABLED: 'false',
      },
      skipDomainCheck: true,
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'GET',
      },
    });

    // @fastify/cors responds 403 + omits Access-Control-Allow-Origin
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('T-CORS-3 (AC-2, AC-3): empty/absent env → origin:true (reflect)', async () => {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      rawEnv: {
        NODE_ENV: 'test',
        // CORS_ALLOWED_ORIGINS intentionally absent
        RATE_LIMIT_ENABLED: 'false',
      },
      skipDomainCheck: true,
    });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://any-marketplace.example',
        'access-control-request-method': 'GET',
      },
    });

    // Permissive: origin reflected
    expect(res.headers['access-control-allow-origin']).toBe('https://any-marketplace.example');
  });
});
```

> Si todavía no implementaste W1 cuando llegás acá, el `skipDomainCheck: true` no existe en `BuildAppOptions` aún — está bien, agregalo recién en C3. **Pero**: si C3 todavía no introdujo el flag, en C2 los tests CORS NO necesitan `skipDomainCheck` (el chain registry está vacío en test → `initDomainCheck` futuro iterará 0 → no-op). Trade-off: el flag se agrega en C3, así que en C2 omitilo del payload `buildApp({...})` y agregalo cuando C3 introduzca el flag. **Decisión recomendada**: dejá los tests CORS sin `skipDomainCheck` en C2 y agregá el flag a TODOS los `buildApp` callers cuando C3 lo introduzca (incluyendo estos 3 CORS tests). Esto mantiene C2 mínimo.

##### Verificación post-C2

```bash
# 1. Tests CORS pasan:
npm test -- --run src/__tests__/unit/app.cors.test.ts src/__tests__/unit/env.test.ts
# esperado: 8 nuevos tests PASS (3 CORS + 2 env CORS + 3 env existentes para FAIL_MODE vendrán en C5)

# Atención: en C2 todavía no hay tests T-ENV-FAIL-*. Esos llegan en C5.
# Después de C2 el total esperado es 553 (W0 baseline) + 5 nuevos (3 CORS + 2 env CORS) = 558.

# 2. Baseline preservada:
npm test -- --run 2>&1 | tail -3
# esperado: Tests  558 passed (558)

# 3. Lint + typecheck:
npm run lint -- --max-warnings 0 && npm run typecheck
# esperado: exit 0 ambos
```

##### Commit message C2

```
feat(WFAC-53): wire CORS_ALLOWED_ORIGINS whitelist (FIX-1)

Add CORS_ALLOWED_ORIGINS env var (z.string().optional(), CD-11 raw CSV)
to EnvSchema. When set, @fastify/cors uses a callback that allows only
listed origins; when absent/empty, falls back to origin: true (legacy
permissive) preserving wasiai-a2a + wasiai-v2 backward compatibility.

Tests: 3 new in app.cors.test.ts (AC-1/2/3) + 2 new in env.test.ts
(T-ENV-CORS-1/2). Baseline 553 → 558.

Refs: WFAC-53 AC-1, AC-2, AC-3, CD-11
```

---

### W1 — Domain separator boot check

#### Commit C3 — FIX-2 (ABI sync + init-domain-check + buildApp wiring + 7 tests + skipDomainCheck flag)

**Archivos**:
- `src/chains/abi/fiat-token.ts` (agregar entry DOMAIN_SEPARATOR)
- `src/methods/eip3009/abi.ts` (replicar byte-for-byte la misma entry — CD-3, mismo commit)
- `src/chains/init-domain-check.ts` (NEW)
- `src/app.ts` (agregar `skipDomainCheck` a `BuildAppOptions`; llamar `initDomainCheck` post-`initChainBreakers`)
- `src/__tests__/unit/chains.kite.domain-check.test.ts` (NEW, 3 tests)
- `src/__tests__/unit/chains.avalanche.domain-check.test.ts` (NEW, 3 tests)
- `src/__tests__/unit/chains.domain-check.multi.test.ts` (NEW, 1 cross-chain test)
- (Existing tests calling `buildApp`) — agregar `skipDomainCheck: true` a 9 archivos (ver R-4)

##### Snippet — ABI entry (idéntico en AMBOS archivos)

```ts
// src/chains/abi/fiat-token.ts — agregar como SEGUNDA entry del `FIAT_TOKEN_ABI as const`:
// (mismo bloque debe copiarse byte-for-byte a src/methods/eip3009/abi.ts en este MISMO commit)

export const FIAT_TOKEN_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    // ... entry existente sin cambios ...
  },
  {
    // WFAC-53 FIX-2 — DOMAIN_SEPARATOR() view for boot-time drift assertion.
    // Source: Circle FiatTokenV2 (canonical USDC/PYUSD).
    // Returns the EIP-712 domain separator hash for this contract.
    type: 'function',
    name: 'DOMAIN_SEPARATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;
```

> **CD-3 enforcement**: tras agregar la entry, correr `npm test -- --run src/__tests__/unit/chain-adapter.test.ts -t "T-SDD-1-ABI-SYNC"`. Si falla → los dos archivos difieren byte-for-byte → corregir antes del commit. **NO modificar el test**; el JSON.stringify byte-compare ya cubre la entry nueva automáticamente (DT-K).

##### Snippet — `src/chains/init-domain-check.ts` NEW

```ts
/**
 * WFAC-53 FIX-2 — boot-time DOMAIN_SEPARATOR() drift assertion.
 *
 * For each chain registered in chainRegistry, computes the EIP-712 domain
 * separator locally (viem.domainSeparator) and compares with the value returned
 * by the on-chain token contract via DOMAIN_SEPARATOR() view (added to ABI in
 * this same commit). Behavior:
 *   - match            → debug log, boot continues
 *   - mismatch         → logger.fatal + process.exit(1)  (AC-4)
 *   - RPC unreachable  → logger.warn, boot continues     (AC-5, CD-6)
 *
 * Uses Promise.allSettled (CD-14) so one chain with a down RPC does not block
 * the check on the other 3. All mismatches are logged before the exit(1).
 *
 * Called from buildApp() AFTER initChainBreakers and BEFORE route registration
 * (DT-I). Test-only opt-out via BuildAppOptions.skipDomainCheck (CD-16).
 *
 * Boundaries (OWNERS.md, CD-4):
 *   - MAY import: `pino` (type-only), `./registry.js`, `./abi/fiat-token.js`,
 *                 `viem` (runtime SOTA: domainSeparator).
 *   - MUST NOT import: src/methods/*, src/core/*, src/routes/*, src/infra/*.
 */

import type { Logger } from 'pino';
import { domainSeparator } from 'viem';
import { chainRegistry } from './registry.js';
import { FIAT_TOKEN_ABI } from './abi/fiat-token.js';
import type { ChainAdapter, EIP3009Token } from './types.js';

type CheckOutcome =
  | { kind: 'match'; chainId: number; tokenAddress: string }
  | { kind: 'mismatch'; chainId: number; tokenAddress: string; expected: string; actual: string };

async function checkOneChain(
  adapter: ChainAdapter,
  logger: Pick<Logger, 'warn' | 'debug'>,
): Promise<CheckOutcome> {
  const metadata = adapter.metadata;
  const token: EIP3009Token | undefined = metadata.tokens[0];
  if (!token) {
    // No token to check — adapter skipped. (Not an error: 0-token adapters are
    // a possible future shape; we silently no-op consistent with init-breakers.ts.)
    return { kind: 'match', chainId: metadata.chainId, tokenAddress: '0x' };
  }

  // Local EIP-712 domain separator (offline, no RPC).
  const localSep = domainSeparator({
    domain: {
      name: token.eip712Name,
      version: token.eip712Version,
      chainId: metadata.chainId,
      verifyingContract: token.address,
    },
  });

  // On-chain DOMAIN_SEPARATOR() read — may throw (RPC down). Caller (allSettled)
  // turns the throw into 'rejected' which the outer loop logs as warn (AC-5).
  const onChainSep = await adapter.getPublicClient().readContract({
    address: token.address,
    abi: FIAT_TOKEN_ABI,
    functionName: 'DOMAIN_SEPARATOR',
  });

  const match = localSep.toLowerCase() === (onChainSep as string).toLowerCase();
  return match
    ? { kind: 'match', chainId: metadata.chainId, tokenAddress: token.address }
    : {
        kind: 'mismatch',
        chainId: metadata.chainId,
        tokenAddress: token.address,
        expected: localSep,
        actual: onChainSep as string,
      };
}

export async function initDomainCheck(logger: Logger): Promise<void> {
  const adapters: ChainAdapter[] = [];
  for (const metadata of chainRegistry.listAdapters()) {
    const lookup = chainRegistry.getAdapter(metadata.chainId);
    if (lookup.ok) adapters.push(lookup.adapter);
  }

  if (adapters.length === 0) {
    // No adapters → no-op (test fixtures, early boot). Consistent w/ init-breakers.
    return;
  }

  // CD-14: allSettled, NOT all. One down RPC must not block 3 healthy chains.
  const settled = await Promise.allSettled(adapters.map((a) => checkOneChain(a, logger)));

  let anyMismatch = false;
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const chainId = adapters[i]!.metadata.chainId;
    if (result.status === 'fulfilled') {
      const outcome = result.value;
      if (outcome.kind === 'mismatch') {
        anyMismatch = true;
        logger.fatal(
          {
            chainId: outcome.chainId,
            tokenAddress: outcome.tokenAddress,
            expected: outcome.expected,
            actual: outcome.actual,
          },
          'WFAC-53: domain separator drift detected — refusing to boot',
        );
      } else {
        logger.debug(
          { chainId: outcome.chainId, tokenAddress: outcome.tokenAddress },
          'WFAC-53: domain separator OK',
        );
      }
    } else {
      // RPC unreachable / timeout / other throw → warn + continue (AC-5, CD-6).
      logger.warn(
        { chainId, err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        'WFAC-53: domain separator check skipped (RPC unreachable)',
      );
    }
  }

  if (anyMismatch) {
    // Mismatch on at least one chain with a reachable RPC → fatal exit. All
    // mismatches were already logged in the loop above (operator sees them all).
    process.exit(1);
  }
}
```

> **Notas de implementación**:
> 1. El `EIP3009Token` interface debe exponer `eip712Name`, `eip712Version`, `address` (confirmá leyendo `src/chains/types.ts` antes del commit).
> 2. El cast del `domainSeparator` return type: viem retorna `Hex` (`0x${string}`). Comparación con `(onChainSep as string).toLowerCase()` — viem `readContract` con outputs `[{ type: 'bytes32' }]` retorna `Hex`. Si TS pide un cast más estricto, usá `as `0x${string}`` o ajustá el tipo. **NO usar `as any`** (CD-1).
> 3. El parámetro `logger: Pick<Logger, 'warn' | 'debug'>` en `checkOneChain` no se usa actualmente (todos los logs viven en `initDomainCheck`). Lo dejé en la firma por simetría con `core/settle-cap.ts` — si el linter se queja por unused parameter, removelo de la firma de `checkOneChain` y dejá sólo el outer logger.

##### Snippet — `src/app.ts` wiring

```ts
// 1. Agregar import al inicio del archivo (junto a otros imports de chains):
import { initDomainCheck } from './chains/init-domain-check.js';

// 2. Extender BuildAppOptions (líneas 41-56). Agregar campo opcional:
export interface BuildAppOptions {
  env?: EnvConfig;
  rawEnv?: NodeJS.ProcessEnv;
  loggerDestination?: DestinationStream;
  /**
   * WFAC-53 FIX-2 — opt-out flag for tests that build the app without
   * configuring chain adapters with real RPC mocks. When true, the
   * DOMAIN_SEPARATOR() boot-time drift check is skipped entirely.
   *
   * Default `false`: production code path always runs the check.
   * Test files that register fake adapters without `readContract` mock
   * MUST set this to true to avoid spurious warn/fatal logs.
   */
  skipDomainCheck?: boolean;
}

// 3. Insertar la llamada DESPUÉS de initChainBreakers (línea 187) y ANTES de
//    healthRoute (línea 189):

  // WFAC-41 — inject the app logger into per-chain circuit breakers ...
  initChainBreakers(app.log as unknown as Logger);

  // WFAC-53 FIX-2 — boot-time DOMAIN_SEPARATOR() drift assertion (DT-I, CD-14).
  // Test-only opt-out via skipDomainCheck (CD-16). Production path always runs.
  // Cast pattern matches initChainBreakers above (AB-WFAC-41-3).
  if (!options.skipDomainCheck) {
    await initDomainCheck(app.log as unknown as Logger);
  }

  await app.register(healthRoute);
  // ... resto sin cambios ...
```

##### Snippet — `chains.kite.domain-check.test.ts` NEW (3 tests)

```ts
/**
 * WFAC-53 FIX-2 — Kite domain separator boot check tests.
 *
 * Pattern mirrors src/__tests__/unit/chains/init-breakers.test.ts:
 * chainRegistry._resetForTesting + register fake KiteAdapter w/ mocked
 * getPublicClient().readContract.
 *
 * Refs: AC-4, AC-5, AC-7, CD-14.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { chainRegistry } from '../../chains/registry.js';
import { asChainId } from '../../core/types.js';
import { initDomainCheck } from '../../chains/init-domain-check.js';
import type { ChainAdapter } from '../../chains/types.js';
import { domainSeparator } from 'viem';

// Compute the canonical Kite Testnet PYUSD domain separator (same shape used
// by the adapter at runtime — see src/chains/kite.ts:124-128).
const KITE_TESTNET_TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const KITE_TESTNET_LOCAL_SEP = domainSeparator({
  domain: {
    name: 'PYUSD',
    version: '1',
    chainId: 2368,
    verifyingContract: KITE_TESTNET_TOKEN_ADDRESS,
  },
});

function makeFakeKiteAdapter(opts: {
  readContractImpl: (params: unknown) => Promise<unknown>;
}): ChainAdapter {
  return {
    metadata: {
      chainId: asChainId(2368),
      name: 'Kite Testnet',
      network: 'testnet',
      networkId: 'eip155:2368',
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Kite', symbol: 'KITE', decimals: 18 },
      tokens: [
        {
          address: KITE_TESTNET_TOKEN_ADDRESS,
          symbol: 'PYUSD',
          decimals: 18,
          name: 'PYUSD',
          eip712Name: 'PYUSD',
          eip712Version: '1',
        },
      ],
    },
    verify: vi.fn() as unknown as ChainAdapter['verify'],
    settle: vi.fn() as unknown as ChainAdapter['settle'],
    getPublicClient: () =>
      ({
        readContract: vi.fn().mockImplementation(opts.readContractImpl),
      }) as unknown as ReturnType<ChainAdapter['getPublicClient']>,
    getWalletClient: vi.fn() as unknown as ChainAdapter['getWalletClient'],
  };
}

function makeStubLogger(): Logger & {
  fatal: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger & {
    fatal: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

describe('initDomainCheck — Kite (WFAC-53 FIX-2)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DOM-KITE-1 (AC-4, AC-7a): match → boot continues, debug log', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => KITE_TESTNET_LOCAL_SEP,
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 2368 }),
      expect.stringContaining('domain separator OK'),
    );
  });

  it('T-DOM-KITE-2 (AC-4, AC-7b): mismatch → fatal log + process.exit(1)', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 2368,
        expected: KITE_TESTNET_LOCAL_SEP,
      }),
      expect.stringContaining('drift detected'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('T-DOM-KITE-3 (AC-5, AC-7c): RPC throws → warn log, no fatal, no exit', async () => {
    const adapter = makeFakeKiteAdapter({
      readContractImpl: async () => {
        throw new Error('ECONNREFUSED kite-rpc.test');
      },
    });
    chainRegistry.register(adapter);
    const logger = makeStubLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 2368, err: expect.stringContaining('ECONNREFUSED') }),
      expect.stringContaining('RPC unreachable'),
    );
  });
});
```

##### Snippet — `chains.avalanche.domain-check.test.ts` NEW (3 tests)

Estructura **idéntica** al Kite test pero con chainId 43113 y metadata Avalanche (`name: 'USD Coin'`, `version: '2'`, `decimals: 6`, address mock `0x2222...2222`). 3 tests T-DOM-AVAX-1/2/3 con MISMA semántica AC-4/AC-5/AC-8 que T-DOM-KITE-1/2/3. **Copiá el archivo Kite, renombrá las constantes y la metadata, mantené la estructura.**

##### Snippet — `chains.domain-check.multi.test.ts` NEW (cross-chain test CD-14)

```ts
/**
 * WFAC-53 FIX-2 — cross-chain Promise.allSettled semantics (CD-14).
 *
 * Verifies that one chain with a down RPC does NOT block the check on the
 * other chains. Registers 2 fake adapters: one returns a matching separator,
 * the other throws. Expected: no fatal, no exit, warn for the broken one,
 * debug for the healthy one.
 *
 * Refs: CD-14, AC-5.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ... (same helpers `makeFakeKiteAdapter`, `makeStubLogger` — extracted into a
//      local helper OR copied from the kite/avalanche test files. To minimize
//      cross-file dependencies, COPY the helpers inline here.) ...

describe('initDomainCheck — multi-chain allSettled (WFAC-53 CD-14)', () => {
  beforeEach(() => {
    chainRegistry._resetForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-DOM-MULTI (CD-14, AC-5): RPC down on 1 chain + match on 1 chain → warn + debug, no fatal', async () => {
    const matchAdapter = makeFakeKiteAdapter({
      readContractImpl: async () => KITE_TESTNET_LOCAL_SEP,
    });
    const downAdapter = makeFakeAvalancheAdapter({
      readContractImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    chainRegistry.register(matchAdapter);
    chainRegistry.register(downAdapter);

    const logger = makeStubLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined) as never);

    await initDomainCheck(logger);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    // 1 warn (for the down chain) + 1 debug (for the healthy chain)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
```

##### Migration de tests existentes (CD-16, R-4) — pasada explícita

**Antes** del commit C3, ejecutá:

```bash
grep -rn "buildApp(" src/__tests__/ | grep -v "skipDomainCheck"
```

Para CADA hit, abrí el archivo, mirá si el test registra adapters con `getPublicClient().readContract` realista. Si **NO** lo hace → agregá `skipDomainCheck: true` al objeto de opciones de `buildApp({...})`.

Lista preliminar (verificar uno por uno):

| Test file | Probable necesidad | Acción |
|-----------|--------------------|--------|
| `src/__tests__/unit/chains/init-breakers.test.ts` | Sí — registra `makeAdapterWithBreaker` sin readContract realista | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/routes.openapi.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/routes.settle.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/routes.verify.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/routes.supported.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/rate-limiting.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/audit.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/health.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |
| `src/__tests__/unit/shutdown.test.ts` | Probable sí | Agregar `skipDomainCheck: true` |

> Si `chainRegistry` está vacío en un test, `initDomainCheck` itera 0 adapters → no-op. En ese caso `skipDomainCheck` es opcional. Pero para robustez y consistencia, agregalo en TODOS los `buildApp` callers de tests; el costo es 1 línea por test.

##### Verificación post-C3

```bash
# 1. ABI sync test pasa (CD-3):
npm test -- --run src/__tests__/unit/chain-adapter.test.ts -t "T-SDD-1-ABI-SYNC"
# esperado: PASS

# 2. Domain-check tests pasan (7 nuevos):
npm test -- --run \
  src/__tests__/unit/chains.kite.domain-check.test.ts \
  src/__tests__/unit/chains.avalanche.domain-check.test.ts \
  src/__tests__/unit/chains.domain-check.multi.test.ts
# esperado: 7 PASS

# 3. Full suite + lint + typecheck:
npm test -- --run 2>&1 | tail -3
# esperado: Tests  565 passed (565)   [553 baseline + 5 W0 + 7 W1]
npm run lint -- --max-warnings 0 && npm run typecheck
# esperado: exit 0 ambos
```

##### Commit message C3

```
feat(WFAC-53): boot-time DOMAIN_SEPARATOR() drift assertion (FIX-2)

Add per-chain EIP-712 domain separator check at boot:
  - DOMAIN_SEPARATOR() entry added byte-for-byte to FIAT_TOKEN_ABI in
    both src/chains/abi/fiat-token.ts and src/methods/eip3009/abi.ts
    (CD-3 enforced by T-SDD-1-ABI-SYNC).
  - New src/chains/init-domain-check.ts uses Promise.allSettled (CD-14)
    to check each registered chain; mismatch → fatal+exit(1) (AC-4),
    RPC failure → warn+continue (AC-5, CD-6).
  - buildApp() calls initDomainCheck after initChainBreakers; tests
    opt-out via BuildAppOptions.skipDomainCheck (CD-16).
  - 7 new tests: 3 Kite + 3 Avalanche + 1 cross-chain.
  - 9 existing test files updated with skipDomainCheck:true.

Refs: WFAC-53 AC-4..AC-8, CD-3, CD-4, CD-6, CD-9, CD-14, CD-16
```

---

### W2 — Docs append

#### Commit C4 — FIX-3 (SECURITY.md APPEND ONLY)

**Archivos**: `doc/architecture/SECURITY.md` (APPEND ONLY al archivo existente de 121 líneas).
**Tests nuevos**: 0 (verificación por grep manual).

##### Estructura — 3 cambios DENTRO del archivo existente

> **CD-12 enforcement**: `git diff d6ccd5f -- doc/architecture/SECURITY.md` debe mostrar ÚNICAMENTE adiciones (líneas `+`), CERO eliminaciones (`-`). Si hay eliminaciones (excepto whitespace al final del file), abortá el commit y revisá.

**Cambio 1 (AC-10): extender `### 1. Operator wallet compromise` in-place (línea ~7-15)**

Agregar AL FINAL de los bullets de Mitigations existentes (no reemplazar nada):

```markdown
### 1. Operator wallet compromise
- **Threat:** `OPERATOR_PRIVATE_KEY` leak → attacker drains wallet + signs malicious txs
- **Mitigations:**
  - V1: Env var encrypted at rest (Railway/Vercel standard)
  - V2: AWS KMS / HashiCorp Vault integration
  - V2: Multi-sig Safe wallet (threshold signing)
  - V1: Scheduled balance monitoring + alerts (low balance = possible drain)
  - Never log the private key — `Pino` redaction config
  - ESLint `no-secrets` plugin prevents hardcoding
  - **V1 — single hot key per chain (WFAC-53 FIX-3):** the facilitator uses a
    single `OPERATOR_PRIVATE_KEY` env var across all 4 enabled chains. Blast
    radius of a key compromise = all 4 chains drained simultaneously.
  - **V2 recommendation:** separate hot keys per chain (e.g.
    `OPERATOR_PRIVATE_KEY_KITE`, `OPERATOR_PRIVATE_KEY_AVAX`) so a single-chain
    compromise does not drain the full operator fleet.
  - **Env vars that MUST NOT be logged** (Pino redaction list, enforced via
    `no-console` + log redaction config):
      - `OPERATOR_PRIVATE_KEY`
      - `SUPABASE_SERVICE_KEY`
```

**Cambio 2 (AC-9): agregar `## Failure modes` AL FINAL del archivo**

Después de `## Future (V2+)` (línea 115-120):

```markdown
## Failure modes (WFAC-53 FIX-3)

The facilitator integrates 3 dependencies whose outage degrades security
posture in different ways. This section documents the graceful-degradation
choices and how to tighten them in production.

### Redis outage → rate-limit bypass
- **Mechanism:** `@fastify/rate-limit` is configured with `skipOnError: true`
  (`src/app.ts` line ~127, WFAC-40 DT-10). If Redis is unreachable or throws on
  `INCR`, the plugin allows the request through (fail-open).
- **Surface:** during a Redis outage, per-IP rate limits are not enforced.
  Burst-from-single-IP attacks become viable until Redis recovers.
- **Why fail-open here:** rate-limit is a defense-in-depth signal, not the
  authoritative budget. The authoritative budget (operator wallet balance)
  is enforced by `SETTLE_DAILY_GLOBAL_CAP` (see below).
- **Mitigation:** operators that need strict per-IP enforcement during Redis
  outages can swap to a `failOpen: false` rate-limit config in V2.

### Redis outage → SETTLE_DAILY_GLOBAL_CAP fail-open (default) or fail-closed (opt-in)
- **Mechanism:** `incrementAndCheckDailyCap` in `src/core/settle-cap.ts` does
  `client.incr(key)` to enforce a global daily settle cap. The behavior on
  Redis throw is configurable via `SETTLE_CAP_FAIL_MODE` (WFAC-53 FIX-6):
    - `SETTLE_CAP_FAIL_MODE=open` (default, preserves V1 behavior): request
      allowed through. Surface = unbounded settle count until Redis recovers.
    - `SETTLE_CAP_FAIL_MODE=closed` (opt-in): HTTP 503 SERVICE_UNAVAILABLE.
      Surface = service degrades protectively; legitimate clients see 503 but
      operator wallet is safe.
- **Recommendation:** set `SETTLE_CAP_FAIL_MODE=closed` in any production
  deployment where the operator wallet balance is significant (>$1k).
- **Trade-off:** fail-closed degrades availability during Redis outages; fail-
  open trades availability for protection against budget overrun. There is no
  free lunch — operators choose.

### EIP-712 Domain separator drift → boot refused (WFAC-53 FIX-2)
- **Mechanism:** at boot, `initDomainCheck` (`src/chains/init-domain-check.ts`)
  calls `DOMAIN_SEPARATOR()` on each chain's token contract and compares with
  the locally computed EIP-712 separator. If they differ on a chain with a
  reachable RPC, the process logs FATAL and exits(1).
- **Why fatal:** a separator mismatch means the metadata in
  `src/chains/<chain>.ts` (`eip712Name`, `eip712Version`, token `address`) has
  drifted from the live token contract — every signature the facilitator
  verifies would be against the wrong domain → silent acceptance of
  cross-chain replays or forged signatures. Refusing to boot is the only safe
  outcome.
- **RPC unreachable handling:** if a chain's RPC is unreachable or times out,
  the check logs WARN and allows boot to continue (non-blocking — the check
  retries implicitly on the next deployment).

## Reporting (WFAC-53 FIX-3)

If you discover a vulnerability affecting wasiai-facilitator, please disclose
responsibly via:

- **Email:** `security@wasiai.io`
- **Acknowledgement SLA:** 48 hours for first response (business days).
- **Public disclosure:** coordinated, after a fix is shipped (90-day default
  embargo).
- **Scope:** signature verification, settle execution, idempotency, audit log,
  rate limiting, circuit breaker, domain separator drift, dependency CVEs,
  any reachable secret leak.
- **Out of scope:** social-engineering of operators, DoS by overwhelming a
  third-party RPC, theoretical attacks requiring control of the chain itself.

For non-security bug reports use GitHub Issues; for security reports use email
only (do NOT open public Issues for unpatched vulnerabilities).
```

**Cambio 3 (CD-12 verification)**: `git diff d6ccd5f -- doc/architecture/SECURITY.md` debe mostrar:
- Adiciones: ~50 líneas (los 3 cambios anteriores).
- Eliminaciones: 0 (excepto whitespace trailing si lo había).

##### Verificación post-C4

```bash
# 1. APPEND-only check:
git diff d6ccd5f..HEAD -- doc/architecture/SECURITY.md | grep "^-" | grep -v "^---"
# esperado: 0 lines (no removals)

# 2. Grep verification de las strings clave (AC-9, AC-10, AC-11):
grep -n "Failure modes\|Reporting\|security@wasiai.io\|48 hours\|OPERATOR_PRIVATE_KEY\|SUPABASE_SERVICE_KEY\|SETTLE_CAP_FAIL_MODE\|domain separator drift" doc/architecture/SECURITY.md
# esperado: ≥8 hits

# 3. wc -l:
wc -l doc/architecture/SECURITY.md
# esperado: ≥160 (era 121, sumamos ~50)

# 4. Tests pasan (no debería verse afectado — doc only):
npm test -- --run 2>&1 | tail -3
# esperado: Tests  565 passed (565)
```

##### Commit message C4

```
docs(WFAC-53): SECURITY.md failure modes + reporting + operator wallet update (FIX-3)

APPEND ONLY to doc/architecture/SECURITY.md (CD-12):
  - Extend §1 "Operator wallet compromise" with V1 single-key note,
    V2 per-chain key recommendation, env vars never to log (AC-10).
  - New "## Failure modes" section: Redis→rate-limit bypass, Redis→
    SETTLE_CAP fail-open/closed (refs FIX-6), domain separator drift
    (refs FIX-2) (AC-9).
  - New "## Reporting" section: security@wasiai.io + 48h SLA + scope (AC-11).

Provisional email/SLA — to-verify-pre-merge with operator.

Refs: WFAC-53 AC-9, AC-10, AC-11, CD-12
```

---

### W3 — Fail-mode opt-in

#### Commit C5 — FIX-6 (settle-cap fail-mode + audit union + 2 settle-cap tests + 3 env tests + route wiring)

**Archivos**:
- `src/infra/env.ts` (agregar `SETTLE_CAP_FAIL_MODE`)
- `src/core/settle-cap.ts` (extender firma + ramificar catch)
- `src/routes/settle.ts` (pasar `env.SETTLE_CAP_FAIL_MODE` + ramificar branch + agregar `SERVICE_UNAVAILABLE` al union)
- `src/core/audit.ts` (1 línea: agregar `\| 'SERVICE_UNAVAILABLE'` al `errorCode` union — DT-O)
- `src/__tests__/unit/env.test.ts` (+3 tests T-ENV-FAIL-1/2/3)
- `src/__tests__/unit/core.settle-cap.test.ts` (+2 tests + fixture update — todos los `incrementAndCheckDailyCap` calls ahora pasan `'open'` o `'closed'` como 2º arg)

##### Snippet — `src/infra/env.ts` addition

```ts
// Dentro del z.object({...}) en src/infra/env.ts, junto a SETTLE_DAILY_GLOBAL_CAP
// (ya existente para WFAC-40 anti-abuse):

  /**
   * WFAC-53 FIX-6 — failure mode for incrementAndCheckDailyCap.
   *   - 'open'   (default, V1 backward-compatible): Redis throw → allow request
   *   - 'closed' (opt-in hardening): Redis throw → return { ok: false, ... }
   *     → route returns HTTP 503 SERVICE_UNAVAILABLE.
   * CD-8: default 'open' preserves V1 behavior exactly.
   */
  SETTLE_CAP_FAIL_MODE: z.enum(['open', 'closed']).default('open'),
```

##### Snippet — `src/core/settle-cap.ts` (extender firma + ramificar catch)

```ts
// ─────────── DailyCapResult union — agregar 3ª variante ───────────
export type DailyCapResult =
  | { ok: true; count: number; cap: number }
  | { ok: false; reason: 'cap_exceeded'; count: number; cap: number; retryAfterSeconds: number }
  | { ok: false; reason: 'redis_error_failclosed' }; // WFAC-53 FIX-6

// ─────────── Firma extendida con failMode ───────────
// ANTES: incrementAndCheckDailyCap(cap, logger)
// DESPUÉS: incrementAndCheckDailyCap(cap, failMode, logger)

export async function incrementAndCheckDailyCap(
  cap: number,
  failMode: 'open' | 'closed',           // ← NUEVO
  logger: Pick<Logger, 'warn' | 'debug'>,
): Promise<DailyCapResult> {
  if (cap <= 0) return { ok: true, count: 0, cap: 0 };

  const client = getRedisClient();
  if (!client) return { ok: true, count: 0, cap };

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const key = `${DAILY_CAP_KEY_PREFIX}${dateKey}`;

  try {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, DAILY_CAP_TTL_SECONDS).catch(() => undefined);
    }
    if (count > cap) {
      const retryAfterSeconds = secondsUntilNextUtcMidnight(now);
      // WFAC-53 FIX-6: add `reason: 'cap_exceeded'` discriminator.
      return { ok: false, reason: 'cap_exceeded', count, cap, retryAfterSeconds };
    }
    return { ok: true, count, cap };
  } catch (err) {
    if (failMode === 'closed') {
      // WFAC-53 FIX-6 — fail-closed: route surfaces HTTP 503 SERVICE_UNAVAILABLE.
      logger.warn({ err, cap }, 'settle daily cap check failed — fail-closed');
      return { ok: false, reason: 'redis_error_failclosed' };
    }
    // failMode === 'open' (default, CD-8 preserves V1 behavior).
    logger.warn({ err, cap }, 'settle daily cap check failed — fail-open');
    return { ok: true, count: 0, cap };
  }
}
```

> **Atención**: la 2ª variante `{ ok: false, reason: 'cap_exceeded', ... }` agrega un discriminator `reason` que **antes no existía**. Eso es un breaking change al consumer (`src/routes/settle.ts`) que va a chequear `dailyCap.reason`. **Asegurate de actualizar el consumer en el MISMO commit** (CD-2 enforce: tras el commit `npm test` debe pasar entero).

##### Snippet — `src/routes/settle.ts` (3 cambios)

```ts
// CAMBIO 1: línea 39-53 — agregar 'SERVICE_UNAVAILABLE' al union (CD-15)
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
  | 'CHAIN_UNAVAILABLE'
  | 'INVALID_PAYLOAD'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE';                // ← WFAC-53 FIX-6 (CD-15)

// CAMBIO 2: línea 131 — pasar env.SETTLE_CAP_FAIL_MODE como 2º arg
// ANTES:
const dailyCap = await incrementAndCheckDailyCap(env.SETTLE_DAILY_GLOBAL_CAP, app.log);
// DESPUÉS:
const dailyCap = await incrementAndCheckDailyCap(
  env.SETTLE_DAILY_GLOBAL_CAP,
  env.SETTLE_CAP_FAIL_MODE,                // ← WFAC-53 FIX-6
  app.log,
);

// CAMBIO 3: línea 132-154 — ramificar el if (!dailyCap.ok) branch por reason
if (!dailyCap.ok) {
  if (dailyCap.reason === 'redis_error_failclosed') {
    // WFAC-53 FIX-6 fail-closed → HTTP 503 SERVICE_UNAVAILABLE
    const body: ErrorBody = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Settlement cap check failed — service unavailable',
        http: 503,
      },
    };
    app.log.warn(
      {
        request_id: requestId,
        error_code: 'SERVICE_UNAVAILABLE',
        http_status: 503,
        duration_ms: Date.now() - startMs,
      },
      'settle failed — fail-closed',
    );
    request.auditMeta = { ...request.auditMeta, errorCode: 'SERVICE_UNAVAILABLE' };
    return reply.code(503).send(body);
  }
  // dailyCap.reason === 'cap_exceeded' — original RATE_LIMITED branch preserved:
  const body: ErrorBody = {
    error: {
      code: 'RATE_LIMITED',
      message: `daily global settle cap reached (${dailyCap.cap}); try again tomorrow`,
      http: 429,
    },
  };
  app.log.warn(
    {
      request_id: requestId,
      error_code: 'RATE_LIMITED',
      http_status: 429,
      daily_count: dailyCap.count,
      daily_cap: dailyCap.cap,
      retry_after_seconds: dailyCap.retryAfterSeconds,
      duration_ms: Date.now() - startMs,
    },
    'settle failed',
  );
  request.auditMeta = { ...request.auditMeta, errorCode: 'RATE_LIMITED' };
  return reply.code(429).header('Retry-After', String(dailyCap.retryAfterSeconds)).send(body);
}
```

##### Snippet — `src/core/audit.ts:52` (DT-O — 1 línea)

```ts
// ANTES:
readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD' | 'RATE_LIMITED';

// DESPUÉS (WFAC-53 FIX-6 DT-O):
readonly errorCode?: X402ErrorCode | 'INVALID_PAYLOAD' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE';
```

> Si Adversary marca esto BLOQUEANTE (Scope IN extension), fallback: **NO** setear `request.auditMeta.errorCode = 'SERVICE_UNAVAILABLE'` en el branch fail-closed del route (eliminá esa 1 línea). Los AC literales hablan del response body, no de auditMeta, así que el fallback cumple AC-15..17.

##### Snippet — `env.test.ts` (+3 tests)

```ts
it('T-ENV-FAIL-1 (FIX-6 AC-16, CD-8): SETTLE_CAP_FAIL_MODE defaults "open"', () => {
  const result = parseEnv({ NODE_ENV: 'test' });
  expect(result.SETTLE_CAP_FAIL_MODE).toBe('open');
});

it('T-ENV-FAIL-2 (FIX-6 AC-15): SETTLE_CAP_FAIL_MODE accepts "closed"', () => {
  const result = parseEnv({ NODE_ENV: 'test', SETTLE_CAP_FAIL_MODE: 'closed' });
  expect(result.SETTLE_CAP_FAIL_MODE).toBe('closed');
});

it('T-ENV-FAIL-3 (CD-8 defense): SETTLE_CAP_FAIL_MODE rejects arbitrary strings → exit 1', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
    throw new Error('__exit__');
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  expect(() => parseEnv({ NODE_ENV: 'test', SETTLE_CAP_FAIL_MODE: 'maybe' })).toThrow('__exit__');

  expect(exitSpy).toHaveBeenCalledWith(1);
  const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  expect(allWrites).toContain('SETTLE_CAP_FAIL_MODE');
});
```

##### Snippet — `core.settle-cap.test.ts` (+2 tests + fixture update)

```ts
// FIXTURE UPDATE: todos los tests existentes que llaman incrementAndCheckDailyCap
// ahora deben pasar 'open' (o 'closed') como 2º arg. Ejemplo:
//
// ANTES: await incrementAndCheckDailyCap(0, nullLogger);
// DESPUÉS: await incrementAndCheckDailyCap(0, 'open', nullLogger);
//
// Aplicar a TODOS los call-sites en este file. 5 tests existentes pre-FIX-6.

// NUEVOS TESTS (al final del describe('incrementAndCheckDailyCap (Redis INCR)')):

it('T-CAP-CLOSED (AC-15, AC-17a): failMode="closed" + Redis throw → { ok: false, reason: "redis_error_failclosed" }', async () => {
  mockClient.incr.mockRejectedValue(new Error('redis down'));
  const r = await incrementAndCheckDailyCap(10, 'closed', nullLogger);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('redis_error_failclosed');
  }
  expect(nullLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ cap: 10 }),
    expect.stringContaining('fail-closed'),
  );
});

it('T-CAP-OPEN-EXPLICIT (AC-16, AC-17b, CD-8): failMode="open" + Redis throw → { ok: true } (preserve V1)', async () => {
  mockClient.incr.mockRejectedValue(new Error('redis down'));
  const r = await incrementAndCheckDailyCap(10, 'open', nullLogger);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.count).toBe(0);
    expect(r.cap).toBe(10);
  }
  expect(nullLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ cap: 10 }),
    expect.stringContaining('fail-open'),
  );
});
```

> Además: los 3 tests existentes que asertan `r.ok = false` (e.g., el test `'passes until count > cap, then rejects'`) ahora deben aceptar la nueva 2ª variante `reason: 'cap_exceeded'`. Si los tests originales hacían `expect(overflow.ok).toBe(false)` + accedían a `overflow.count`, agregar `expect(overflow.reason).toBe('cap_exceeded')` para validar el discriminator. **Esto es una fixture update, no test nuevo.**

##### Verificación post-C5

```bash
# 1. Tests env nuevos pasan:
npm test -- --run src/__tests__/unit/env.test.ts -t "T-ENV-FAIL"
# esperado: 3 PASS

# 2. Tests settle-cap pasan (existentes + 2 nuevos):
npm test -- --run src/__tests__/unit/core.settle-cap.test.ts
# esperado: 5 existentes + 2 nuevos = 7 PASS

# 3. Full suite:
npm test -- --run 2>&1 | tail -3
# esperado: Tests  570 passed (570)   [565 post-W2 + 3 env FAIL + 2 settle-cap = 570]

# 4. Lint + typecheck:
npm run lint -- --max-warnings 0 && npm run typecheck
# esperado: exit 0 ambos

# 5. Grep audit.ts cambio (DT-O):
grep -n "SERVICE_UNAVAILABLE" src/core/audit.ts
# esperado: 1 hit (línea ~52)

# 6. Grep settle.ts cambios (3 hits):
grep -n "SERVICE_UNAVAILABLE\|SETTLE_CAP_FAIL_MODE\|redis_error_failclosed" src/routes/settle.ts
# esperado: ≥3 hits
```

##### Commit message C5

```
feat(WFAC-53): SETTLE_CAP_FAIL_MODE opt-in fail-closed (FIX-6)

Add SETTLE_CAP_FAIL_MODE env var (z.enum(['open','closed']).default('open'),
CD-8 preserves V1 backward-compat). When 'closed':
  - Redis throw in incrementAndCheckDailyCap → returns
    { ok: false, reason: 'redis_error_failclosed' }
  - /settle route returns HTTP 503 with code SERVICE_UNAVAILABLE
    (route-local, NOT added to X402ErrorCode — CD-15)
When 'open' (default): preserves V1 fail-open behavior exactly.

DailyCapResult union extended with `reason` discriminator:
  - 'cap_exceeded'             (existing path)
  - 'redis_error_failclosed'   (new fail-closed path)

DT-O: SERVICE_UNAVAILABLE added to src/core/audit.ts errorCode union for
auditMeta observability (1 line, mirrors WFAC-40 RATE_LIMITED pattern).

Tests: 3 new env + 2 new settle-cap + fixture update of 5 existing.
Baseline 565 → 570.

Refs: WFAC-53 AC-15, AC-16, AC-17, CD-8, CD-15
```

---

### DONE — FIX-5 external action (no commit local)

**Acciones** (vía GitHub UI, NO commit local):

1. Mergear Dependabot PR #10 (`actions/upload-artifact` 4→7) si CI verde.
2. En cada Dependabot PR #3, #4, #5, #6, #7 (runtime major bumps), comentar:
   > "Holding until manual smoke test after WFAC-53 lands."
3. Documentar en `cr-report.md` o en `done-report.md` (que escribe nexus-docs) la URL del merge de PR #10 y la lista de comentarios en #3–#7.

**NO** es scope del Dev hacer estas acciones — el orquestador las documenta tras DONE.

---

## 5. Test plan — AC → Test mapping

| AC | Test name | Test file | Wave | Cubierto |
|----|-----------|-----------|------|----------|
| AC-1 | T-CORS-1: whitelisted Origin returns ACAO header | `app.cors.test.ts` | W0 C2 | ✅ |
| AC-1 | T-CORS-2: non-whitelisted Origin gets 403 / no ACAO | `app.cors.test.ts` | W0 C2 | ✅ |
| AC-1 | T-ENV-CORS-2: parses CSV string as-is | `env.test.ts` | W0 C2 | ✅ |
| AC-2 | T-CORS-3: empty env → origin:true (reflect) | `app.cors.test.ts` | W0 C2 | ✅ |
| AC-2 | T-ENV-CORS-1: defaults undefined when missing | `env.test.ts` | W0 C2 | ✅ |
| AC-3 | (T-CORS-1/2/3 collectively) | `app.cors.test.ts` | W0 C2 | ✅ |
| AC-4 | T-DOM-KITE-1: match → boot continues | `chains.kite.domain-check.test.ts` | W1 C3 | ✅ |
| AC-4 | T-DOM-KITE-2: mismatch → fatal + exit | `chains.kite.domain-check.test.ts` | W1 C3 | ✅ |
| AC-4 | T-DOM-AVAX-1: match → boot continues | `chains.avalanche.domain-check.test.ts` | W1 C3 | ✅ |
| AC-4 | T-DOM-AVAX-2: mismatch → fatal + exit | `chains.avalanche.domain-check.test.ts` | W1 C3 | ✅ |
| AC-5 | T-DOM-KITE-3: RPC throws → warn, no exit | `chains.kite.domain-check.test.ts` | W1 C3 | ✅ |
| AC-5 | T-DOM-AVAX-3: RPC throws → warn, no exit | `chains.avalanche.domain-check.test.ts` | W1 C3 | ✅ |
| AC-5 | T-DOM-MULTI: 1 down + 1 match → warn + debug | `chains.domain-check.multi.test.ts` | W1 C3 | ✅ |
| AC-6 | T-SDD-1-ABI-SYNC (existing, no test change) | `chain-adapter.test.ts:1051-1056` | W1 C3 | ✅ (auto via JSON.stringify byte-compare, DT-K) |
| AC-7 | T-DOM-KITE-1/2/3 collectively | `chains.kite.domain-check.test.ts` | W1 C3 | ✅ |
| AC-8 | T-DOM-AVAX-1/2/3 collectively | `chains.avalanche.domain-check.test.ts` | W1 C3 | ✅ |
| AC-9 | Grep verification "Failure modes" + 3 mecanismos | `doc/architecture/SECURITY.md` | W2 C4 | ✅ (manual grep) |
| AC-10 | Grep verification operator wallet V1/V2 + env vars | `doc/architecture/SECURITY.md` | W2 C4 | ✅ (manual grep) |
| AC-11 | Grep verification "security@wasiai.io" + "48 hours" | `doc/architecture/SECURITY.md` | W2 C4 | ✅ (manual grep) |
| AC-12 | `npm run lint -- --max-warnings 0` exit 0 | (CI) | W0 C1 + final | ✅ |
| AC-13 | `npm test` 553/553 post-C1 | (CI) | W0 C1 | ✅ |
| AC-14 | (External GitHub action) | — | DONE | manual |
| AC-15 | T-CAP-CLOSED: failMode='closed' + Redis throw | `core.settle-cap.test.ts` | W3 C5 | ✅ |
| AC-15 | T-ENV-FAIL-2: accepts 'closed' | `env.test.ts` | W3 C5 | ✅ |
| AC-16 | T-CAP-OPEN-EXPLICIT: failMode='open' + Redis throw → ok | `core.settle-cap.test.ts` | W3 C5 | ✅ |
| AC-16 | T-ENV-FAIL-1: defaults 'open' | `env.test.ts` | W3 C5 | ✅ |
| AC-17 | T-CAP-CLOSED + T-CAP-OPEN-EXPLICIT | `core.settle-cap.test.ts` | W3 C5 | ✅ |
| AC-18 | Final `npm test` ≥570 PASS, 0 FAIL | (CI) | Final | ✅ |
| AC-19 | Final `npm run lint -- --max-warnings 0` exit 0 | (CI) | Final | ✅ |

**Totales esperados**:
- Tests nuevos: 16 (5 env + 3 cors + 7 domain-check + 2 settle-cap — el "1 cross-chain" cuenta en los 7 domain-check) + fixture update sobre 5 tests existentes de settle-cap (no son tests nuevos, sólo mantienen su PASS).
- Tests modificados (skipDomainCheck): ~9 archivos, sin cambio de PASS count.
- **Baseline post-HU**: ≥569 PASS, 0 FAIL (553 + 16). Cifra exacta: **570** (553 + 5 W0 + 7 W1 + 5 W3 = 570 — coincide con el cálculo de verificación post-C5).

---

## 6. Auto-Blindaje histórico aplicado (referencia)

Las lecciones de las últimas HUs DONE estuvieron incorporadas en los CDs y waves. Resumen:

| Lección | Origen | Aplicación en WFAC-53 |
|---------|--------|------------------------|
| **AB-WFAC-50-1**: superRefine prod-required rompe tests con `NODE_ENV: 'production'` | WFAC-50 auto-blindaje | **R-3 mitigación**: AMBAS env vars nuevas son optional (CORS_ALLOWED_ORIGINS) o tienen default (SETTLE_CAP_FAIL_MODE='open'). **NO** se agrega `.superRefine()`. |
| **AB-WFAC-50-2**: `eslint-disable security/detect-object-injection` sólo en la línea del acceso (nunca en línea declaración) | WFAC-50 auto-blindaje | **CD-13**: FIX-4 elimina los 5 disables completamente vía switch literal estructural — **NUNCA agregar disables nuevos**. |
| **AB-WFAC-50-3**: env var required-at-module-load impacta tests que importan ese módulo | WFAC-50 auto-blindaje | `init-domain-check.ts` exporta FUNCIÓN (no require-at-load); sólo se ejecuta dentro de `buildApp()`. Tests que no llaman `buildApp` no se ven afectados. |
| **AB-WFAC-41-1**: extender `X402ErrorCode` rompe `VerifyRouteErrorCode`/`SettleRouteErrorCode` locales | WFAC-41 auto-blindaje | **CD-15** + **DT-L resuelto**: `SERVICE_UNAVAILABLE` SOLO en union local `SettleRouteErrorCode`. **NO** se toca `X402ErrorCode`. |
| **AB-WFAC-41-2**: eslint-disable en línea correcta | WFAC-41 auto-blindaje | **CD-13** trivializa — 0 disables permitidos. |
| **AB-WFAC-41-3**: `FastifyBaseLogger` no es estructuralmente compatible con `pino.Logger` → cast `as unknown as Logger` | WFAC-41 auto-blindaje | **CD-1 excepción documentada**: `initDomainCheck(app.log as unknown as Logger)` usa el MISMO cast que `initChainBreakers` (heredado). |
| **Patrón recurrente (≥2 HUs)**: ESLint `Unused eslint-disable directive` cuando el disable se aplica al lugar equivocado | WFAC-50 + WFAC-41 | **CD-13 explícito** captura el patrón — la refactorización estructural a switch elimina la trampa. |

---

## 7. Verification commands — checklist completo

### 7.1 Por wave

```bash
# ─── Post-C1 (W0 FIX-4) ───
grep -n "eslint-disable.*security/detect-object-injection" src/chains/kite.ts src/chains/avalanche.ts
# esperado: 0 hits
npm run lint -- --max-warnings 0
npm run typecheck
npm test -- --run 2>&1 | tail -3
# esperado: 553 passed

# ─── Post-C2 (W0 FIX-1) ───
grep -n "CORS_ALLOWED_ORIGINS" src/infra/env.ts src/app.ts src/__tests__/unit/env.test.ts src/__tests__/unit/app.cors.test.ts
# esperado: 4+ hits
npm run lint -- --max-warnings 0
npm run typecheck
npm test -- --run 2>&1 | tail -3
# esperado: 558 passed   [553 + 3 cors + 2 env-cors]

# ─── Post-C3 (W1 FIX-2) ───
npm test -- --run src/__tests__/unit/chain-adapter.test.ts -t "T-SDD-1-ABI-SYNC"
# esperado: PASS (ABI sync)
ls src/chains/init-domain-check.ts \
   src/__tests__/unit/chains.kite.domain-check.test.ts \
   src/__tests__/unit/chains.avalanche.domain-check.test.ts \
   src/__tests__/unit/chains.domain-check.multi.test.ts
# esperado: 4 archivos existen
grep -n "skipDomainCheck" src/app.ts
# esperado: ≥2 hits (interface + use)
npm run lint -- --max-warnings 0
npm run typecheck
npm test -- --run 2>&1 | tail -3
# esperado: 565 passed   [558 + 6 domain-check + 1 cross-chain]

# ─── Post-C4 (W2 FIX-3) ───
git diff d6ccd5f..HEAD -- doc/architecture/SECURITY.md | grep "^-" | grep -v "^---"
# esperado: 0 lines (APPEND only)
grep -c "Failure modes\|Reporting\|security@wasiai.io\|48 hours\|OPERATOR_PRIVATE_KEY\|SUPABASE_SERVICE_KEY\|SETTLE_CAP_FAIL_MODE\|domain separator drift" doc/architecture/SECURITY.md
# esperado: ≥8
npm test -- --run 2>&1 | tail -3
# esperado: 565 passed (no test change)

# ─── Post-C5 (W3 FIX-6) ───
grep -n "SETTLE_CAP_FAIL_MODE" src/infra/env.ts src/routes/settle.ts
# esperado: ≥2 hits
grep -n "SERVICE_UNAVAILABLE" src/routes/settle.ts src/core/audit.ts
# esperado: ≥3 hits (route union + route branch + audit union)
grep -n "redis_error_failclosed" src/core/settle-cap.ts src/routes/settle.ts
# esperado: ≥2 hits
grep -nE "T-ENV-FAIL|T-CAP-CLOSED|T-CAP-OPEN-EXPLICIT" src/__tests__/unit/env.test.ts src/__tests__/unit/core.settle-cap.test.ts
# esperado: 5+ hits (3 env + 2 settle-cap)
npm run lint -- --max-warnings 0
npm run typecheck
npm test -- --run 2>&1 | tail -3
# esperado: 570 passed
```

### 7.2 Final (antes de pasar a Adversary AR — F4)

```bash
# 1. Suite completa:
npm test -- --run 2>&1 | tail -5
# esperado: Tests  ≥569 passed (≥569), 0 failed

# 2. Lint strict + typecheck:
npm run lint -- --max-warnings 0
npm run typecheck
# esperado: exit 0 ambos

# 3. Build (smoke):
npm run build
# esperado: exit 0

# 4. Cero eslint-disable security en files de chains:
grep -rn "eslint-disable.*security" src/chains/
# esperado: 0 hits

# 5. ABI sync byte-for-byte:
node -e "const a=require('./dist/chains/abi/fiat-token.js').FIAT_TOKEN_ABI; const b=require('./dist/methods/eip3009/abi.js').FIAT_TOKEN_ABI; console.log(JSON.stringify(a)===JSON.stringify(b) ? 'SYNC OK' : 'DRIFT')"
# esperado: SYNC OK

# 6. Branch state:
git log --oneline d6ccd5f..HEAD
# esperado: exactamente 5 commits (C1 FIX-4, C2 FIX-1, C3 FIX-2, C4 FIX-3, C5 FIX-6)

# 7. Diff stat:
git diff --stat d6ccd5f..HEAD
# esperado: ~18 archivos tocados (ver §0.6 Scope IN)
```

---

## 8. Done Definition (criterios verificables al cierre de F3)

El Dev considera F3 DONE cuando **TODOS** estos criterios pasan:

- [ ] 5 commits creados en branch `fix/wfac-53-post-review-hardening` (C1..C5) — `git log --oneline d6ccd5f..HEAD` muestra exactamente 5.
- [ ] **Ningún commit usa `--no-verify`, `--no-gpg-sign`, `--amend`**.
- [ ] Tras cada commit individual, `npm test -- --run` reporta:
  - C1: 553 passed
  - C2: 558 passed
  - C3: 565 passed
  - C4: 565 passed (sin cambio — docs only)
  - C5: 570 passed (target final ≥569)
- [ ] Tras cada commit, `npm run lint -- --max-warnings 0` exit 0.
- [ ] Tras cada commit, `npm run typecheck` exit 0.
- [ ] Suite final: 570 passed, 0 failed (`AC-18`).
- [ ] Lint final: 0 warnings security (`AC-19`).
- [ ] Cero `eslint-disable security/detect-object-injection` en `src/chains/kite.ts` y `src/chains/avalanche.ts` (`AC-12`).
- [ ] `FIAT_TOKEN_ABI` byte-idéntico entre `src/chains/abi/fiat-token.ts` y `src/methods/eip3009/abi.ts` (`AC-6`, CD-3).
- [ ] `src/chains/init-domain-check.ts` existe y exporta `initDomainCheck`.
- [ ] `BuildAppOptions.skipDomainCheck?: boolean` declarado en `src/app.ts`.
- [ ] `CORS_ALLOWED_ORIGINS` y `SETTLE_CAP_FAIL_MODE` declarados en `EnvSchema`.
- [ ] `SERVICE_UNAVAILABLE` agregado SOLO al union local `SettleRouteErrorCode` y al union `AuditMeta.errorCode` — **NUNCA** a `X402ErrorCode` (CD-15).
- [ ] `doc/architecture/SECURITY.md` APPEND ONLY: `git diff d6ccd5f..HEAD -- doc/architecture/SECURITY.md \| grep ^- \| grep -v ^---` retorna 0 líneas.
- [ ] Las 3 secciones nuevas existen en SECURITY.md: "Failure modes" (con 3 sub-secciones), "Reporting" (con email + SLA), y la extensión de §1 "Operator wallet compromise".
- [ ] El push del branch SE HACE (`git push -u origin fix/wfac-53-post-review-hardening`) — el orquestador abre el PR vía gh CLI.
- [ ] FIX-5 (Dependabot PR #10 GitHub UI merge + comentarios en #3–#7) **NO** lo hace el Dev — lo documenta el orquestador en `done-report.md`.

---

## 9. Observaciones / handoff a Adversary (AR)

Al cierre de F3, dejar para AR estos hilos:

1. **Smoke E2E recomendado pre-merge**: spin up el facilitator contra cada RPC real (Kite Testnet, Kite Mainnet, Fuji, Avalanche) y verificar logs `domain separator OK` para las 4 chains. Si fatal en prod → metadata mismatch en `kite.ts` / `avalanche.ts` (R-1).
2. **DT-O ruling**: agregar `'SERVICE_UNAVAILABLE'` al union `AuditMeta.errorCode` extiende Scope IN del work-item (que explícitamente excluía `src/core/*` except settle-cap). **Architect ruling**: justificado por observability del fail-closed branch, mismo patrón que WFAC-40 `'RATE_LIMITED'`. Si AR lo marca BLOQUEANTE → fallback documentado en R-6 (omitir `auditMeta.errorCode` en branch fail-closed).
3. **FIX-3 Reporting placeholder**: `security@wasiai.io` + 48h SLA son provisionales. To-verify-pre-merge con operador. **NO es bloqueante** para AR — sí es bloqueante para merge a prod (humano confirma).
4. **R-4 buildApp callers migration**: durante C3, el Dev debe leer 9 test files y agregar `skipDomainCheck: true`. Lista exacta en §6 R-4. Si algún file se olvida → ese test va a romper con fatal o warn. AR debe pedir grep verification: `grep -rn "await buildApp\|buildApp(" src/__tests__/ | grep -v "skipDomainCheck"` → solo tests nuevos de FIX-2 deberían quedar sin el flag.

---

*Story File generado por NexusAgil F2.5 — Architect — 2026-05-11.*
*Contrato self-contained: el Dev consume EXCLUSIVAMENTE este archivo en F3.*
