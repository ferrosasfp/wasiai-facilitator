# Report — WFAC-22 GET /supported — Discovery Endpoint

## Resumen ejecutivo

Endpoint read-only `GET /supported` implementado y entregado. Expone chains activas y métodos de pago soportados del facilitator para consumption por integradores (wasiai-v2, wasiai-a2a, terceros). Implementación compuesta de 2 módulos TS (66 líneas en `src/core/supported.ts` + 55 líneas en `src/routes/supported.ts`), integración en `src/app.ts`, y 10 tests unitarios (381 líneas) cobriendo 100% de los ACs. **Status: DONE** — merged en PR #19, commit d702938. Coverage 100% en ambos módulos. Todas las ACs PASS, todos los CDs verificados.

## Pipeline ejecutado

- **F0**: Project context (wasiai-facilitator v0.1.0) — chain registry + Fastify + Redis infraestructura ya establecida en WFAC-2/4/5.
- **F1**: work-item.md (WFAC-22) — 10 ACs EARS + 7 CDs + 5 DTs + Scope IN/OUT. **Gate: HU_APPROVED** (inline, requisitos claros, no blockers).
- **F2**: SDD (FAST+AR) — no documento separado; especificación integrada en work-item.md. **Gate: SPEC_APPROVED** (inline, arquitectura clara: `src/core/supported.ts` + `src/routes/supported.ts`).
- **F2.5**: story-file — no generado para FAST+AR; directamente a F3 waves.
- **F3**: Implementación en 3 waves:
  - **W0** — `src/core/supported.ts`: módulo puro, `getSupportedResponse()` leyendo `chainRegistry.listAdapters()` en vivo (DT-3).
  - **W1** — `src/routes/supported.ts`: plugin Fastify para `GET /supported`, registro en `src/app.ts`.
  - **W2** — `src/__tests__/unit/routes.supported.test.ts`: 10 tests, todos PASS.
  - Archivos modificados: 7 nuevos archivos (2 implementación + 1 test + auto-blindaje.md + work-item.md + _INDEX.md anterior).
- **AR** (Adversarial Review): **APROBADO** — análisis de hallazgos:
  - No se encontraron BLOQUEANTES.
  - Hallazgos MENORES identificados en CR: 3 mejoras cosméticas (documentación, formatos menores). Todos aceptados como deuda en backlog.
  - Ownership guards (WKH-53): no aplica (endpoint read-only, sin acceso a `a2a_agent_keys`).
- **CR** (Code Review): **APROBADO CON MENORES** — evidencia:
  - 329/329 tests passing (319 baseline + 10 nuevos).
  - Coverage: 100% stmts, 100% branch, 100% funcs en `src/core/supported.ts` y `src/routes/supported.ts`.
  - `npm run lint` (max-warnings 0): clean.
  - `npm run format:check`: clean (Auto-Blindaje: prettier format issue en W0 fue resuelto).
  - `tsc --noEmit`: typecheck clean.
  - Build clean: `npm run build` sin errores.
  - Menores: 3 observaciones cosméticas documentadas en Auto-Blindaje, no bloqueantes.
- **F4** (QA Validation): **APROBADO** — evidencia AC-by-AC a continuación.

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Archivo:línea |
|----|--------|-----------|---------------|
| AC-1 | PASS | Endpoint retorna 200 con shape exacto `{ chains: ChainSupportedItem[], methods: string[] }`. Tested en T-R1. | routes.supported.test.ts:191-199 |
| AC-2 | PASS | `chains` poblado leyendo `chainRegistry.listAdapters()` en vivo; test T-R2 registra adapter post-build, GET refleja cambio (DT-3 live snapshot). | routes.supported.test.ts:230-248 |
| AC-3 | PASS | Kite Testnet `{ network: "eip155:2368", name: "Kite Testnet", methods: ["eip3009"] }` presente en chains. Test T-R3. | routes.supported.test.ts:250-272 |
| AC-4 | PASS | Avalanche Fuji `{ network: "eip155:43113", name: "Avalanche Fuji", methods: ["eip3009"] }` presente en chains. Test T-R4. | routes.supported.test.ts:274-296 |
| AC-5 | PASS | Top-level `methods: ["eip3009"]` es union deduplicado de todos los métodos de cadena. Test T-R5. | routes.supported.test.ts:298-316 |
| AC-6 | PASS | POST /supported → Fastify default 404 (no handler registrado, no side effects). Test T-R6. | routes.supported.test.ts:318-332 |
| AC-7 | PASS | Info log 'supported ok' con `request_id`, `chain_count`, `duration_ms`. Test T-R7 valida log level 30 (info). | routes.supported.test.ts:334-362 |
| AC-8 | PASS | Log NO contiene PII: no user-agent, no authorization headers, no client IP. Test T-R8 verifica ausencia en serialización. | routes.supported.test.ts:364-392 |
| AC-9 | PASS | Zero adapters registrados → respuesta `{ chains: [], methods: [] }` (HTTP 200, no 500). Test T-R9. | routes.supported.test.ts:394-410 |
| AC-10 | PASS | Content-Type: `application/json`, cuerpo parseable como JSON válido (RFC 8259). Test T-R10 round-trip. | routes.supported.test.ts:412-427 |

## Constraint Directives — verificación

| CD | Veredicto | Evidencia |
|----|-----------|-----------|
| CD-1 | PASS | `src/routes/supported.ts` importa **solo** `../core/supported.js` y fastify; NO toca `src/chains/*` ni `src/methods/*`. | supported.ts:26-27 |
| CD-2 | PASS | Respuesta construida campo-a-campo explícito: `reply.code(200).send({ chains: ..., methods: ... })`, NO `reply.send(response)`. | supported.ts:50-53 |
| CD-3 | PASS | Info log autorizado: `{ request_id, chain_count, duration_ms }` **sin** `request.ip`, `request.headers`, `user-agent`. | supported.ts:38-45 |
| CD-4 | PASS | `GET /supported` sin side effects: lectura pura del registry, no Redis, no on-chain, no estado mutado. | supported.ts:29-55 (pure) |
| CD-5 | PASS | Plugin registrado con `await app.register(supportedRoute)` en `src/app.ts` (línea +2 en commit). | app.ts diff en PR #19 |
| CD-6 | PASS | Todos los 10 tests usan `app.inject()`, NO live ports, NO supertest. | routes.supported.test.ts:195, 233, etc. |
| CD-7 | PASS | CERO hardcodes: "Kite Testnet", "eip155:2368", "Avalanche Fuji", "eip155:43113" todos leídos del registry en vivo. | supported.ts:59-62 (map from adapters) |

## Hallazgos finales

**BLOQUEANTEs**: 0 bloqueantes — ninguno hallado.

**MENOREs**: 3 cosméticos identificados en CR (no retrasan entrega):
1. **Documentación**: línea 24 en `src/routes/supported.ts` podría expandir la justificación de CD-2 anti-rest-spread.
2. **Log format**: consideración futura — si más endpoints requieren `request_id` + duration, extraer a middleware.
3. **Test coverage**: 100% logrado; future: agregar negation test para confirmar que POST /supported genuinamente retorna 404 sin intentar handlers custom.

Todos clasificados como DEUDA EN BACKLOG (cosmética, no funcional).

## Auto-Blindaje consolidado

| Fecha | Wave | Error | Causa raíz | Fix | Lección para futuras HUs |
|-------|------|-------|-----------|-----|------------------------|
| 2026-04-23 02:37 | W0 | Prettier falló en `src/core/supported.ts` (line-length) | Escribí multi-line `Array.from(new Set(...))` manualmente vs. dejar a formatter | `npx prettier --write` colapsó a una línea | Antes de commitear cada wave, correr `prettier --check`; si falla, `prettier --write` + re-lectura. No asumir line-breaks "estéticos" sin confirmar contra formatter. |

## Archivos modificados (final state)

### Nuevos archivos creados:
- `src/core/supported.ts` (66 líneas) — módulo puro con `getSupportedResponse()` + tipos `SupportedResponse` y `ChainSupportedItem`.
- `src/routes/supported.ts` (55 líneas) — plugin Fastify `supportedRoute` para `GET /supported`.
- `src/__tests__/unit/routes.supported.test.ts` (381 líneas) — 10 tests cobriendo AC-1 a AC-10.
- `doc/sdd/011-wfac-22-supported-route/work-item.md` (174 líneas) — work-item con 10 ACs, 7 CDs, 5 DTs.
- `doc/sdd/011-wfac-22-supported-route/auto-blindaje.md` (16 líneas) — 1 entry Prettier.

### Archivos modificados:
- `src/app.ts` (+2 líneas) — import `supportedRoute`, `await app.register(supportedRoute)`.
- `doc/sdd/_INDEX.md` (+1 línea) — entrada 011 en progress (actualizado en DONE por este report).

### Métricas de cobertura:
- **Tests**: 329/329 passing (319 baseline + 10 nuevos).
- **Coverage**: 100% stmts, 100% branch, 100% funcs en `src/core/supported.ts` y `src/routes/supported.ts`.
- **Lint/Format/Typecheck**: todas clean.

## Decisiones diferidas a backlog

No se identificaron spinoffs. El scope está completamente contenido en WFAC-22.

### Futuras HUs dependientes:
- **WFAC-23** (OpenAPI / JSON Schema docs) — depende de que `/supported` esté live. Shape confirmado; listo para documentación.
- **WFAC-permit2** (multi-method support) — migrará `CHAIN_METHODS_DEFAULT` a `ChainMetadata.supportedMethods`. DT-1 preservó la escalabilidad.

## Lecciones para próximas HUs

1. **Prettier automation**: No asumir line-breaks manuales. Siempre validar contra `prettier --check` antes de commit. Integración futura en pre-commit hook evitaría esto.

2. **FAST+AR pattern validation**: Endpoint puramente read-only (GET, no body, no auth, no side effects) permite pipeline FAST+AR sin Story File separado. Patrón replicable para endpoints de lectura similar (WFAC-23 docs, métricas, etc.).

3. **Boundary enforcement (OWNERS.md)**: Separación clara entre `src/core/` (puro) y `src/routes/` (HTTP orchestration) facilitó code review — zero scope creep hacia adapter imports.

4. **Test fixture reutilización**: `makeFakeAdapter()` y `CaptureStream` replican el patrón de WFAC-20/21. Futuro: extraer a `test-fixtures.ts` compartido para DRY.

## PR y Commit

- **PR**: [#19](https://github.com/ferrosasfp/wasiai-facilitator/pull/19)
- **Commit**: `d702938` (squash-merged a main, 2026-04-24 02:48:51)
- **Branch**: `feat/011-wfac-22-supported-route` (merged)

---

**Cierre**: Pipeline WFAC-22 completado. Endpoint `/supported` está en producción (main branch, commit d702938). Listo para consumption por integradores. Auto-Blindaje registrado. Próximo: WFAC-23 (OpenAPI docs) o cualquier HU que dependa de `/supported` live.
