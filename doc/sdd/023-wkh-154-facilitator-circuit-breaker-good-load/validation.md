# Validation Report — WKH-154 Circuit breaker: transport vs business (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-07
**Branch**: fix/154-facilitator-cb-transport-vs-business (uncommitted)

## Runtime checks
- Suite completa: `npx vitest run` → **818/818 passed, 57 test files** (0 fallos).
- Clasificador + integración: `error-classifier.test.ts` (15) + `settle.breaker-classification.test.ts` (5) → **20/20 passed**.
- Guardianes de regresión (leídos + re-corridos puntuales, sin editar assertions):
  `circuit-breaker.test.ts` + `concurrency.settle.test.ts` (CC-12/13/14) + `chain-adapter.test.ts` (T-ADAPT-CB-6, T-CB-ACCOUNTING/AC-15) + `settle.failinjection.test.ts` → **4 files, 119/119 passed**. `chains.base.test.ts` cubierto dentro de los 818.
- Dry-run del crux (razonado sobre `src/chains/error-classifier.ts:221-234` + confirmado por EC-1/EC-12):
  `{name:'EstimateGasExecutionError', details:'gas required exceeds allowance (24468/11800/62584)'}` → `isBusinessNode` matchea substring `'gas required exceeds allowance'` (l.197-200, BUSINESS_SUBSTRINGS l.54-66) → `'business'`. Confirmado en vivo: `error-classifier.test.ts:21-28` (EC-1) PASS.
  `{name:'HttpRequestError', status:503}` → `isTransportNode` matchea `TRANSPORT_NAMES.has('HttpRequestError')` (l.205, set l.69-82) → `'transport'`. Confirmado en vivo: `error-classifier.test.ts:54-56` (EC-5) PASS.
- Scope: `git diff --stat` → **solo `src/chains/base-adapter.ts`** modificado (+32/-3) + 3 archivos nuevos (`error-classifier.ts`, `error-classifier.test.ts`, `settle.breaker-classification.test.ts`). `circuit-breaker.ts` y `chain-mutex.ts` **NO aparecen** en el diff (CD-2/CD-8 intactos).
- AR/CR: `ar-report.md`/`cr-report.md` no están en disco en `doc/sdd/023-.../` — no hay artefacto escrito para leer. El prompt de F4 afirma AR+CR APROBARON (0 bloqueantes, 2 NITs diferidos); no pude confirmar esto con evidencia de archivo. Gates (`tsc --noEmit`, `eslint --max-warnings 0`) re-ejecutados directamente por mí ante la ausencia del cr-report (ver Gates abajo) — no es re-trabajo redundante, es la única evidencia disponible.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (business no cuenta) | PASS | `base-adapter.ts:640-682` (tag en 3 catch de `_settleRaw`) + `error-classifier.test.ts` EC-1..4/EC-12 (5 tests) + `settle.breaker-classification.test.ts:159-179` BC-1 (N business sim-fails → `getBreakerState()==='CLOSED'`, 0 CHAIN_UNAVAILABLE) + BC-5 (`:240-...` tag invisible, shape idéntica) — todos PASS |
| AC-2 (transport SÍ cuenta, CRÍTICO) | PASS | `error-classifier.test.ts` EC-5..9/EC-13 (6 tests) + `settle.breaker-classification.test.ts:182-202` **BC-2**: N `HttpRequestError`/timeout → `getBreakerState()==='OPEN'` (l.195) → siguiente settle `error.code==='CHAIN_UNAVAILABLE'` (l.200) + `retryAfterMs>0` (l.202). Protección contra outage genuino intacta. |
| AC-3 (burst N-1 business + 1 ok, CRÍTICO) | PASS | `settle.breaker-classification.test.ts:206-238` **BC-3**: burst business + 1 settle bueno → `getBreakerState()==='CLOSED'` (l.238), settle bueno sin 503 |
| AC-4 (suite completa verde) | PASS | `npx vitest run` → 818/818 passed, 57 test files (baseline 798 + 20 nuevos = 818, exacto) |
| AC-5 (ambiguo → default transport fail-safe) | PASS | `error-classifier.ts:232-233` (`return 'transport'` default, comentario "NEVER default to business") + EC-10/EC-11 (`new Error('x')`, string, `undefined`, `null` → `'transport'` sin throw) + BC-4 (ambiguo → breaker OPEN) — todos PASS |

## Drift
- Scope: exacto a los 4 archivos del Scope IN del Story File (`base-adapter.ts` MODIFY + 3 CREATE). Ningún archivo fuera de scope tocado.
- `circuit-breaker.ts` / `chain-mutex.ts`: NO en el diff (CD-2/CD-8 respetados).
- `verify()` recibe el mismo gate por simetría (`base-adapter.ts:240-248`) — behavior-preserving, confirmado por lectura (comentario explícito + `_verifyRaw` no hace RPC hoy).
- Ningún test existente editado (confirmado: los únicos `??` (untracked) son los 2 archivos de test nuevos; `base-adapter.ts` es el único `M`).

## Gates (re-ejecutados por ausencia de cr-report.md en disco)
- `npx tsc --noEmit` → **0 errores**.
- `npm run lint` (`eslint --max-warnings 0`) → **0 warnings**.
- `npx vitest run` → **818/818 passed**.

## Nota honesta — fuera de alcance de CI
El smoke real (batch multi-settle contra Fuji, contención same-account, confirmando que el breaker NO abre y Chaski cobra) es **POST-DEPLOY**, no reproducible en CI (CD-4/CD-5 prohíben gastar fondos / RPC real en tests). No se simuló ni se declaró como evidencia — queda pendiente para el operador humano tras el merge+deploy.

**Listo para DONE.** (Con la salvedad de la falta de artefacto AR/CR en disco — recomendado a nexus-docs verificar que existan antes del cierre, o registrar la aprobación verbal como tal en el reporte final.)
