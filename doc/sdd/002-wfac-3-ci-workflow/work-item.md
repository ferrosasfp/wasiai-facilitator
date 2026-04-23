# Work Item — [WFAC-3] GitHub Actions CI — typecheck + lint + test + build + security scan

## Metadata

| Campo | Valor |
|-------|-------|
| **HU-ID** | WFAC-3 |
| **NNN** | 002 |
| **Slug** | `ci-workflow` |
| **Jira** | https://ferrosasfp.atlassian.net/browse/WFAC-3 |
| **Épica** | E1 — Core Infrastructure |
| **Fecha** | 2026-04-22 |
| **Branch sugerido** | `feat/002-wfac-3-ci-workflow` |
| **Autor** | nexus-analyst (F0+F1) |

---

## Resumen

Completar y consolidar el workflow de GitHub Actions CI para wasiai-facilitator. Existe un scaffold
en `.github/workflows/ci.yml` que ya cubre los pasos base (typecheck, lint, format:check, tests,
npm audit), pero tiene gaps críticos: no hay paso de `build` (TypeScript compile no validado en
CI), el paso de Snyk tiene `continue-on-error: true` (el security gate no es real), no hay
reporte de cobertura de tests, y el `dependabot.yml` para GitHub Actions usa intervalo mensual
que puede dejar vulnerabilidades de actions abiertas demasiado tiempo. Esta HU cierra todos los
gaps y deja el CI production-ready como gate de calidad automático para todas las HUs futuras
(E2–E8) de este servicio que mueve dinero.

---

## Contexto de negocio

wasiai-facilitator es un servicio financiero que ejecuta transferencias on-chain de stablecoins.
Un CI sólido no es infraestructura opcional — es la primera línea de defensa contra:

- Regresiones en la lógica de verify/settle que podrían resultar en pagos incorrectos
- Dependencias con vulnerabilidades conocidas (CVE) que comprometan el operador wallet
- Errores de TypeScript que silenciosamente generan comportamiento incorrecto en runtime
- Código que no buildea pero sí pasa typecheck (tsc --noEmit vs tsc real)

El outage de Pieverse (2026-04-13) fue un recordatorio de que la confiabilidad del servicio
importa. Un CI que detecta problemas antes del merge es la diferencia entre un bug en dev y un
bug en producción manejando fondos reales.

Adicionalmente, los jueces del hackathon Kite y futuros partners/integradores van a mirar el
repo — un CI verde con todos los checks activos señala seriedad operacional.

---

## Sizing

| Campo | Valor |
|-------|-------|
| **SDD_MODE** | mini |
| **Clasificación** | FAST+AR |
| **Estimación** | S |
| **Justificación** | Es infraestructura CI pura — YAML de workflow + validación de configuración existente. No hay código de aplicación nuevo. El scaffold ya tiene ~80% del trabajo hecho; esta HU cierra los gaps. AR obligatorio para validar que el security gate es real (no continue-on-error) y que el workflow no introduce secretos hardcodeados. |

---

## Acceptance Criteria (EARS)

### Triggers y estructura del workflow

**AC-1** — WHEN a push is made to `main` or a pull request targeting `main` is opened/updated,
the system SHALL trigger the CI workflow automatically with no manual intervention required.

**AC-2** — WHEN two CI runs for the same branch/PR are triggered concurrently, the system SHALL
cancel the older run (concurrency group per workflow+ref, `cancel-in-progress: true`), so that
stale runs do not consume unnecessary GitHub Actions minutes.

### Job: QA (typecheck + lint + format + tests)

**AC-3** — WHEN the QA job runs, the system SHALL execute the following steps in order, and SHALL
fail fast (exit non-zero) if any step fails:
1. `npm ci` — install dependencies from lockfile (reproducible, no network drift)
2. `npm run typecheck` — TypeScript strict check (`tsc --noEmit`)
3. `npm run lint` — ESLint with `--max-warnings 0` (includes eslint-plugin-security and eslint-plugin-no-secrets)
4. `npm run format:check` — Prettier check
5. `npm run build` — actual TypeScript compile to `dist/` (validates that tsc emits without errors, not just type-check)
6. `npm test` — vitest unit tests

**AC-4** — WHEN `npm run build` step runs in CI, it SHALL use the same `tsc` configuration as
local builds (`tsconfig.json`) and SHALL fail the job if any TypeScript compilation error is
found, even if `npm run typecheck` passed.

**AC-5** — WHEN `npm test` runs in CI, the system SHALL report test results inline in the GitHub
Actions log. IF any test fails, the job SHALL exit with a non-zero code and block the PR merge.

### Coverage

**AC-6** — WHEN the QA job runs, the system SHALL execute `npm run test:coverage` and SHALL upload
the coverage summary to the GitHub Actions job summary (via `actions/upload-artifact` or inline
summary), so that reviewers can see coverage trends in PRs without leaving GitHub. Coverage SHALL
NOT gate the build (no minimum threshold enforced in CI at this stage — tracked as TD-01-09).

### Security gate

**AC-7** — WHEN the security audit step runs, the system SHALL execute `npm audit --audit-level=high`
as a blocking gate (`continue-on-error: false`). IF any dependency has a vulnerability of severity
`high` or `critical`, the job SHALL fail and block the PR merge.

**AC-8** — WHEN the Snyk job runs on a pull_request event, it SHALL execute
`snyk/actions/node@master` with `--severity-threshold=high` using `secrets.SNYK_TOKEN`. The Snyk
job SHALL be configured as `continue-on-error: false` (blocking gate). IF `SNYK_TOKEN` is not
set in repository secrets, the Snyk job SHALL fail with a clear error message, not silently skip.

**AC-9** — WHILE the Snyk job is configured, it SHALL run on both `push` to `main` AND
`pull_request` events (not only on pull_request), so that direct pushes to main are also scanned.

### Node version and environment

**AC-10** — WHEN the QA job runs, the system SHALL use `actions/setup-node@v4` with
`node-version: '20'` (Node 20 LTS) and `cache: 'npm'` (built-in npm cache via actions/setup-node,
keyed on `package-lock.json` hash) to minimize install time on cache hits.

**AC-11** — WHEN `npm ci` runs in CI, the system SHALL pass with a clean install from
`package-lock.json` without network-fetching packages already cached, achieving install time
under 30 seconds on cache hit.

### Timeout and reliability

**AC-12** — WHEN the QA job is configured, it SHALL have `timeout-minutes: 10` to prevent runaway
jobs from consuming unlimited Actions minutes.

**AC-13** — WHEN the Snyk job is configured, it SHALL have `timeout-minutes: 5`.

### Dependabot

**AC-14** — WHILE `dependabot.yml` is configured, it SHALL update GitHub Actions dependencies on
a `weekly` schedule (not monthly), so that action vulnerabilities (e.g., compromised `@master`
pins) are addressed within 7 days.

---

## Scope IN

| Archivo / Módulo | Acción | Notas |
|-----------------|--------|-------|
| `.github/workflows/ci.yml` | MODIFY | Completar scaffold: agregar `build` step, fijar Snyk como blocking, agregar Snyk en push-to-main, agregar coverage step |
| `.github/dependabot.yml` | MODIFY | Cambiar `github-actions` schedule de `monthly` a `weekly` |

---

## Scope OUT

| Item | Razón |
|------|-------|
| `src/**` — ningún archivo de aplicación | Esta HU es CI-only; no toca código de aplicación |
| `package.json` scripts | Los scripts ya existen y son correctos; no requieren cambios |
| `tsconfig.json` | Ya configurado desde WFAC-1 scaffold; no se modifica aquí |
| `.eslintrc.json` / `eslint.config.*` | Lint config ya existe; no se modifica en esta HU |
| Snyk account creation / token provisioning | Es operacional (repo secret `SNYK_TOKEN`); fuera del código |
| CodeQL / SAST scanning | Fuera de scope — `npm audit` + Snyk cubren el need en V1. CodeQL es un TD futuro (TD-CI-01) |
| Deploy workflow (Railway) | Separado — WFAC-70 |
| Preview environments per PR | Separado — WFAC-71 |
| Branch protection rules (GitHub repo settings) | Operacional, no código; fuera del scope del workflow YAML |
| `act` CLI local testing | Herramienta de dev local; no se instala ni configura en repo |
| Coverage minimum threshold gate | TD-01-09 — diferido. AC-6 solo reporta, no bloquea |
| Node 22 matrix | Decisión DT-A: solo Node 20 LTS. Ver DT-A abajo |

---

## Decisiones técnicas (DT-N)

**DT-A — Node matrix: Node 20 LTS only (no matrix 20+22).**
El project-context especifica explícitamente "Node 20 LTS — stable, long support window". Node 22
no es LTS aún en la ventana de este proyecto. Correr una matrix 20+22 duplicaría el tiempo de CI
y consumiría Actions minutes sin valor diferencial real — el servicio no soporta múltiples Node
versions en producción. Decision: Node 20 exclusivo. Revisar cuando Node 22 entre a LTS window
(~2024-Q4, ya pasado), pero la actualización es un cambio de 1 línea sin riesgo — no justifica
matriz hoy.

**DT-B — Cache strategy: `actions/setup-node@v4` builtin cache (`cache: 'npm'`) sobre `actions/cache@v4` manual.**
`actions/setup-node@v4` con `cache: 'npm'` usa automáticamente `package-lock.json` como cache
key y maneja invalidación correctamente. Usar `actions/cache@v4` manualmente agrega complejidad
de configuración (key patterns, restore-keys, paths) sin beneficio medible. El scaffold ya usa
`setup-node@v4` con `cache: 'npm'` — confirmar este approach. Solo se cambia si en F3 el Dev
observa que la cache builtin no funciona en el runner `ubuntu-latest`.

**DT-C — `npm ci` vs `npm install --frozen-lockfile`.**
`npm ci` es el estándar para CI — borra `node_modules` y reinstala desde lockfile, sin modificar
`package-lock.json`. `--frozen-lockfile` es la bandera de Yarn/pnpm equivalente. Para npm puro
(este proyecto), `npm ci` es la opción correcta y ya está en el scaffold. No cambiar.

**DT-D — Coverage en CI: reportar pero no gatear en esta HU.**
`npm run test:coverage` existe en `package.json` pero no está en el scaffold actual. Decision:
agregar el paso para generar el reporte, uploadear el summary al GitHub Actions run summary
(usando `--reporter=verbose` o el output de `@vitest/coverage-v8`), pero NO setear un threshold
mínimo en esta HU. Razón: el codebase está en etapas iniciales (WFAC-2 done), y forzar un
threshold ahora podría bloquear HUs legítimas con cobertura baja en módulos no-críticos.
El threshold se define cuando haya base suficiente de tests (TD-01-09). AC-6 captura esto.

**DT-E — Security scan approach: `npm audit` (blocking) + Snyk (blocking) como capas.**
- `npm audit --audit-level=high`: blocking, rápido, cero configuración extra, corre en el job QA.
  Ya existe en el scaffold. Confirmar `continue-on-error: false` (actualmente ya es false en el scaffold).
- Snyk: análisis más profundo con base de datos CVE propia, también blocking. El scaffold tiene
  `continue-on-error: true` — esto DEBE cambiar a `false`. Sin SNYK_TOKEN el job falla con error
  claro (no silenciosa).
- CodeQL (GitHub Advanced Security): fuera de scope V1. Requiere configuración más pesada y
  licencia de GitHub (o repo público). Registrar como TD-CI-01 en BACKLOG.
- `eslint-plugin-security` + `eslint-plugin-no-secrets`: ya corren dentro de `npm run lint`.
  No necesitan paso separado en CI.

**DT-F — Snyk job trigger: push+PR (no solo PR).**
El scaffold actual tiene `if: github.event_name == 'pull_request'` en el Snyk job. Esto deja un
gap: un push directo a main (que puede ocurrir en el flujo de trabajo actual vía merge de PR)
no triggerea Snyk. Decision: remover la condición `if` para que Snyk corra en ambos eventos
declarados en el `on:` del workflow (push a main + PR targeting main).

---

## Constraint Directives (CD-N)

**CD-1** — PROHIBIDO hardcodear secretos, tokens, o credenciales en el YAML del workflow.
Todo secret DEBE referenciarse como `${{ secrets.NOMBRE }}`. Si un step requiere un secret que
no está configurado en el repo, el job DEBE fallar con error explícito, no con `continue-on-error: true`.

**CD-2** — OBLIGATORIO que el Snyk job tenga `continue-on-error: false`. Un security gate con
`continue-on-error: true` es un security gate ficticio — cualquier vulnerabilidad high/critical
pasaría silenciosamente. Esta fue la violación del scaffold original que esta HU corrige.

**CD-3** — OBLIGATORIO usar `actions/checkout@v4`, `actions/setup-node@v4`, y `snyk/actions/node@master`
(o una versión pinneada). PROHIBIDO usar versiones `@v1`, `@v2` de actions que no reciben
security patches.

**CD-4** — PROHIBIDO agregar steps que requieran servicios externos no disponibles en el entorno
CI estándar de GitHub Actions (sin Redis, sin Supabase, sin RPC de Kite). Los tests que requieran
estos servicios deben ser integration tests marcados como `skip` en CI hasta que se configuren
services/mocks en un job separado (WFAC-TBD).

**CD-5** — OBLIGATORIO que el job QA tenga `timeout-minutes: 10` y el job Snyk tenga
`timeout-minutes: 5`. Sin timeout, un job colgado consume minutes indefinidamente.

**CD-6** — OBLIGATORIO que `npm ci` (no `npm install`) sea el comando de instalación. `npm install`
puede modificar el lockfile — PROHIBIDO en CI.

**CD-7** — PROHIBIDO usar `@master` sin pinear para actions de terceros que no sean Snyk. Para
actions de GitHub (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`), usar
la versión mayor más reciente (`@v4`). Para Snyk action, `@master` es aceptable porque Snyk
lo mantiene activamente y no tiene un SHA release tagging confiable — documentar en el workflow
con comentario.

**CD-8** — OBLIGATORIO que el step `npm run build` use la misma `tsconfig.json` que el desarrollo
local (sin flags adicionales que relajen el strict mode). El objetivo es detectar errores de
compilación reales, no solo type-check.

**CD-9** — PROHIBIDO que el workflow CI tenga steps que escriban al repo (git push, git commit,
auto-fix). CI es read-only sobre el código. Si un step auto-fixea (ej. `lint:fix`), está
explícitamente PROHIBIDO en el workflow.

---

## Missing Inputs

| Item | Tipo | Estado |
|------|------|--------|
| `SNYK_TOKEN` repo secret | **Operacional** — necesario para que el Snyk job funcione. El Dev del workflow puede dejar el step configurado pero el token lo provisiona el operador del repo (ferrosasfp). | No bloqueante para F3. El workflow falla claramente si el secret no está; eso es el comportamiento esperado (CD-1, AC-8). |
| Versión pinneada para `snyk/actions/node` | **Decisión menor** — `@master` es aceptable según DT-F, pero si el Architect prefiere un SHA pin, puede hacerlo en F2. | `[TBD en F2]` — no bloqueante. |
| Coverage reporting mechanism | **Decisión de implementación** — `@vitest/coverage-v8` genera lcov + json. Uploadear lcov como artifact vs usar el GitHub Actions summary via echo. El Architect decide el approach en F2. | `[TBD en F2]` — AC-6 establece la intención, el mecanismo exacto se define en F2. |

---

## Skills Router

- **nexus-agile** (infra/DevOps): CI/CD workflow, GitHub Actions YAML, security scanning
- No se requiere skill adicional — esta HU no toca código de aplicación ni blockchain

---

## Análisis de paralelismo

- **Bloquea**: nada en el sentido duro. Ninguna HU futura requiere CI para ser implementada.
  Sin embargo, sin CI, cada PR de E2–E8 puede mergearse con regresiones no detectadas.
- **Es bloqueada por**: ninguna. WFAC-2 (bootstrap) ya está DONE. El CI puede completarse
  independientemente de cualquier otra HU en vuelo.
- **Puede correr en paralelo con**: WFAC-4 (Redis client), WFAC-5 si hubiera otra HU de infra.
  No hay colisión de archivos con ninguna HU de E2–E8 (no toca `src/`).
- **Dependencia soft**: idealmente WFAC-3 se completa antes de empezar WFAC-10 (verify logic)
  para que el security gate esté activo desde el primer PR de E2. No es un bloqueo duro pero
  sí una buena práctica.

---

## Waves preliminares (el Architect refina en F2)

| Wave | Descripción | Archivos |
|------|-------------|---------|
| **W0** | Auditar gaps del scaffold actual vs ACs — comparar `.github/workflows/ci.yml` vs esta lista | Lectura, no escritura |
| **W1** | Refactor `.github/workflows/ci.yml` — agregar `build` step, fijar Snyk blocking, remover condición PR-only en Snyk, agregar Snyk en push, agregar coverage step | `.github/workflows/ci.yml` |
| **W2** | Actualizar `.github/dependabot.yml` — cambiar `github-actions` schedule a `weekly` | `.github/dependabot.yml` |
| **W3** | Validar workflow — crear un PR de test o push a main para observar que todos los jobs pasan en GitHub Actions (evidencia requerida para F4 QA) | N/A (validación operacional) |

---

## Criterios de éxito no funcionales

- CI runtime total (QA job): bajo 3 minutos en cache hit, bajo 5 minutos en cache miss
- Security gate: activo y blocking — un PR con `npm audit --audit-level=high` failure NO puede mergearse
- Coverage: reportado en el job summary, visible para el reviewer sin instalar herramientas adicionales
- Snyk: blocking en PR y en push a main, no solo en PR
- `npm run build` en CI: cualquier error de compilación TS bloquea el merge
- Dependabot: PRs automáticas semanales para GitHub Actions + npm deps

---

## Tech Debt generado por esta HU

| TD ID | Descripción | Target |
|-------|-------------|--------|
| TD-CI-01 | CodeQL / SAST scanning — análisis estático más profundo que Snyk | V1.1 |
| TD-01-09 | Coverage minimum threshold gate en CI (% mínimo a definir cuando haya tests suficientes) | Post-E2 |
