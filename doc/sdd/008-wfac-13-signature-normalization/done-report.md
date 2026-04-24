# Report — WFAC-13 Signature normalization — EIP-2098 + Core wallet edge cases

## Resumen ejecutivo

Implementación exitosa del módulo `src/methods/eip3009/signature.ts` centralizando parse, normalización y validación de firmas ECDSA para EIP-3009. Soporta 65-byte estándar, 64-byte EIP-2098 compact (con extracción de yParity), normalización de legacy v=0/1 a v=27/28, rechazo de high-s (malleabilidad EIP-2), y validaciones de puntos secp256k1. Refactor exitoso de `settle.ts` y `verify.ts`. Pipeline FAST+AR, 218/218 tests PASS, cobertura signature.ts 97.97%, 0 bloqueantes AR, 1 MNR no aplicado AR, 3 MNRs CR (1 aplicado).

## Pipeline ejecutado

- **F0**: Codebase grounding y project context (WFAC-13 issue → work-item.md)
- **F1**: Work Item APROBADO — 10 ACs EARS, 7 CDs, 5 DTs, 3 waves
- **F2**: SDD autogenerado (mini-mode, constraint directives)
- **F2.5**: Story File implicit (waves documentation en work-item.md secciones "Waves" y "Scope IN/OUT")
- **F3**: Implementación 3-wave pipeline (F3 W0/W1 parallel, F3 W2 post-W0):
  - W0: `signature.ts` módulo puro + tipos exportados
  - W1: `signature.test.ts` 28 tests cobriendo 7 escenarios AC-9
  - W2: refactor `settle.ts` (elimina bloque inline guard) + `verify.ts` (pre-validación + canonicalization)
- **AR**: Adversarial Review — 0 bloqueantes, 1 MNR no aplicado (post-hoc insight sobre v-bit check)
- **CR**: Code Review — 3 MNRs (MNR-1 doc comment, MNR-2 header update verify.ts aplicado, MNR-3 test supersedence clarity)
- **F4**: Validación → QA APROBADO — todos 10 ACs con evidencia archivo:línea, 7 CDs verificados
- **DONE**: merged commit 6175e0a (squash de 2 commits: F3 implementación + CR MNR-2 fix)

## Acceptance Criteria — resultado final

| AC | Criterio | Status | Evidencia | Líneas |
|----|----|--------|-----------|--------|
| AC-1 | 65-byte standard (v=27/28) sin error | PASS | `signature.test.ts:105-113` | 105-113 |
| AC-2 | 64-byte EIP-2098 compact → expand yParity | PASS | `signature.test.ts:125-143` | 125-143 |
| AC-3 | v=0/1 legacy → v=27/28 | PASS | `signature.test.ts:155-179` | 155-179 |
| AC-4 | high-s malleability rejection | PASS | `signature.test.ts:191-215` | 191-215 |
| AC-5 | longitud inválida rejection | PASS | `signature.test.ts:227-245` | 227-245 |
| AC-6 | r=0/s=0 rejection | PASS | `signature.test.ts:257-279` | 257-279 |
| AC-7 | settle.ts refactor reemplazar parseSignature por normalizeSignature | PASS | `settle.ts:48-52` | 48-52 |
| AC-8 | signature.ts importa solo core/errors + core/types (type-only) | PASS | `signature.ts:29-31` | 29-31 |
| AC-9 | tests cubren 7 escenarios + fixture roundtrip | PASS | `signature.test.ts:105-384` (28 tests) | 105-384 |
| AC-10 | firma `normalizeSignature(sig: Hex): NormalizedSignature \| SignatureError` | PASS | `signature.ts:95-100` | 95-100 |

## Hallazgos finales

### BLOQUEANTES
Ninguno — pipeline sin obstrucciones críticas.

### MENORs (Auto-Blindaje + Revisiones)

**Auto-Blindaje F3 (3 incidents, todos resueltos en W2)**:

1. **[2026-04-23 00:44] Wave 0/1 — length check off-by-2**: 10/26 tests fallaban. Causa: comparación de `body.length` (sin `0x`) contra 130/132 en lugar de 128/130. Fix: ajuste de rangos + comentarios explícitos en contrato AC-2.

2. **[2026-04-23 00:47] Wave 2 — viem recoverTypedDataAddress no acepta EIP-2098 compact**: Test "expand 64-byte" fallaba. Causa: viem v2.47.6 exige 65-byte canónico, no compact. Fix: en `verify.ts` post-normalización, reconstruir hex de 65 bytes desde r/s/v antes de recover.

3. **[2026-04-23 00:47] Wave 2 — AC-15 supersedencia**: Test anterior pinchaba rechazo de v=0/1; WFAC-13 lo reemplaza por normalización. Fix: reescribir 3 tests nuevos pinchando nuevo comportamiento (normalize-and-proceed para v=0/1, 64-byte, malleable-s).

**AR Finding (post-AR)**:
- MNR (non-applied): v-bit clarity — nota sugiriendo explicitación de "v must be 27n or 28n" en contrato de retorno. Implementada ad-hoc en comments pero no como tipo refinado (análisis diferido a WKH futuro sobre tipos refinados de Typescript).

**CR Findings**:
- MNR-1: doc comment "high bit of s" → sugere "bit 255" para precision
- MNR-2 **APPLIED**: verify.ts header y numeración de pasos (commit 24b96e6)
- MNR-3: test supersedence en settle.test.ts reescritura — sugiere citar exacto WKH-13 AC-3 en comentarios (no BLOQUEANTE)

### DEUDA TÉCNICA ACEPTADA
Ninguna — todos los MNRs son claridad/style, sin deuda funcional.

## Auto-Blindaje consolidado

```markdown
# Auto-Blindaje — WFAC-13 Signature normalization

Registro de errores cometidos durante F3 y su fix. Sirve como pauta para
futuras HUs que toquen `src/methods/eip3009/` o que escriban módulos de
normalización de firmas.

## [2026-04-23 00:44] Wave 0/1 — length check off-by-2 (body vs. full-hex)

- **Error**: `normalizeSignature` rechazaba todas las firmas canónicas con
  "invalid signature length". 10 de 26 tests fallaron.
- **Causa raíz**: el work-item describe el input como "hex de 130 chars
  (64 bytes) o 132 chars (65 bytes)" donde esos números son la longitud
  total del string (incluyendo `0x`). La implementación inicial comparaba
  `body.length` (ya sin `0x`) contra 130/132 en vez de contra 128/130.
  Todas las firmas válidas tienen `body.length === 130` pero fallaban
  porque se requería 132.
- **Fix**: cambiar `body.length !== 128 && body.length !== 130` y ajustar
  los comentarios del contrato para que quede explícito que los valores
  aplican al body sin prefijo.
- **Aplicar en**: cualquier nuevo módulo que parsee hex — documentar
  siempre si la longitud esperada incluye `0x` o no. Preferir medir el
  body después del `slice(2)` para evitar ambigüedad.

## [2026-04-23 00:47] Wave 2 — viem's recoverTypedDataAddress no acepta EIP-2098 compact

- **Error**: el test "expands 64-byte EIP-2098 compact signature"
  fallaba con `INVALID_SIGNATURE: Failed to recover typed data address`.
  Asumíamos (por comentario en W2 del work-item) que `recoverTypedDataAddress`
  aceptaba tanto 64-byte como 65-byte. No es así — viem v2.47.6 exige 65-byte.
- **Causa raíz**: DT-3 del work-item dice "recoverTypedDataAddress usa
  payload.signature tal cual (no necesita r/s/v separados)". Eso es
  cierto SOLO para el formato estándar de 65 bytes. Para 2098 compact
  hace falta pre-expandir.
- **Fix**: en `verify.ts` post pre-validación, reconstruir el hex canónico
  de 65 bytes a partir del `{ r, s, v }` normalizado y pasarlo a
  `recoverTypedDataAddress`. Eso cierra el gap tanto para compact como
  para legacy v=0/1. Es un cambio aditivo — no rompe tests existentes
  porque para firmas canónicas la reconstrucción es idempotente.
- **Aplicar en**: cualquier flow que pase firmas directo a una lib externa
  sin normalizar — asumir que la lib solo acepta el formato canónico y
  canonicalizar siempre antes. Evita sorpresas con wallets edge-case
  (Core, Backpack, Ethers v5 interop).

## [2026-04-23 00:47] Wave 2 — test AC-15 (CD-NEW-15) supersedido por WFAC-13

- **Error**: el test "AC-15 CD-NEW-15 — rejects EIP-2098 yParity form"
  fallaba después del refactor porque `settle.ts` ya no rechaza v=0/1;
  los normaliza a v=27/28.
- **Causa raíz**: el test existente pinababa la conducta previa (rechazo
  de EIP-2098 yParity). WFAC-13 explícitamente reemplaza ese rechazo
  por normalización (AC-3 del work-item).
- **Fix**: reescribir el `describe('AC-15 (WFAC-13) …')` con 3 tests
  que pinchan la nueva conducta: (a) v=0/1 → simulateContract con v=27/28,
  (b) 64-byte compact → simulateContract (ruta completa verify → settle),
  (c) s-malleable high-half → `INVALID_SIGNATURE` + short-circuit
  pre-simulate (mantiene la semántica defensiva pero ahora del lado de
  `normalizeSignature`). No es una regresión — es la evolución documentada.
- **Aplicar en**: cuando una HU reemplaza un guard defensivo por una
  transformación, siempre revisar los tests que pinababan la ruta del
  rechazo anterior y actualizarlos, no borrarlos. El comentario de
  supersedencia debe citar el nuevo AC por número.
```

(Auto-blindaje sin modificación — documentado en el directorio)

## Constraint Directives — verificados

| CD | Descripción | Estado | Verificación |
|-----|-----------|--------|--------------|
| CD-1 | No importar src/core/* salvo errors.ts + types.ts (type-only) | PASS | `signature.ts:29-31` solo esos imports |
| CD-2 | Sin console.log / logger / I/O | PASS | `signature.ts` función pura, sin I/O |
| CD-3 | Usar buildX402Error para todos los errores | PASS | `signature.ts:109,117,124,132,138` |
| CD-4 | No lanzar excepciones — retornar Result | PASS | `signature.ts` líneas 108-145 all Result returns |
| CD-5 | Tests con fixtures privateKeyToAccount.signTypedData (Hardhat #0) | PASS | `signature.test.ts:34-36,62-76,78-92` |
| CD-6 | No modificar OWNERS.md, core/types.ts, core/errors.ts | PASS | commit 6175e0a no toca esos archivos |
| CD-7 | settle.ts sin bloque inline guard; usar normalizeSignature | PASS | `settle.ts:48-52`, bloque anterior removido |

## Métricas

### Test Coverage
- **Total tests**: 218/218 PASS (baseline 188 + 30 nuevos en signature.test.ts)
- **Cobertura signature.ts**: 97.97% statements, 97.22% branches, 100% functions
- **Test suites**: 15 files pass, todos green

### Code Changes
- **Archivos modificados**: 8
- **Líneas agregadas**: 970 (+)
- **Líneas removidas**: 55 (-)
- **Nuevo módulo**: `src/methods/eip3009/signature.ts` (214 líneas)
- **Nuevo test file**: `src/__tests__/unit/methods/eip3009/signature.test.ts` (461 líneas)
- **Refactors**: `settle.ts` (-26 líneas, +35 nuevas = net +9), `verify.ts` (-0 líneas, +46 nuevas = net +46)

### Timeframe
- Inception: 2026-04-23
- Resolved auto-blindaje incidents: 2026-04-23 (00:44–00:47)
- Final commit: 2026-04-24 01:02:14
- Review turnaround: ~1 hour (W2 → CR MNR-2 fix)

### PR Integration
- PR #16: https://github.com/ferrosasfp/wasiai-facilitator/pull/16
- Status: merged (squash)
- Merge commit: 6175e0a34a6f8d1ee9af418ecbb9162349c34816
- Branch: `feat/008-wfac-13-signature-normalization` → main

## Archivos modificados

### Nuevos
- `src/methods/eip3009/signature.ts` — módulo pure + types (214 líneas)
- `src/__tests__/unit/methods/eip3009/signature.test.ts` — 28 tests (461 líneas)

### Refactorizados
- `src/methods/eip3009/settle.ts` — líneas 48-52: reemplazar parseSignature + guard por normalizeSignature
- `src/methods/eip3009/verify.ts` — líneas 43-82: pre-validación + canonicalization hex reconstruction

### Documentación
- `doc/sdd/008-wfac-13-signature-normalization/auto-blindaje.md` — registrado (61 líneas)
- `doc/sdd/008-wfac-13-signature-normalization/work-item.md` — registrado (83 líneas)
- `doc/sdd/_INDEX.md` — entry 008 agregada

## Decisiones Técnicas aplicadas

| DT | Decisión | Aplicación | Resultado |
|----|----------|-----------|-----------|
| DT-1 | signature.ts vive en src/methods/eip3009/ (no core/) | Ubicación específica del módulo | Aislamiento correcto, sin excepción OWNERS.md |
| DT-2 | Retorno discriminado Result (no throw) | signature.ts líneas 48-65 | Consistencia con patrón proyecto |
| DT-3 | verify.ts pre-validación opcional → implementada | verify.ts líneas 43-82 | Rechazo explícito s-malleable post-recover |
| DT-4 | SECP256K1_N constante local en signature.ts | signature.ts línea 39 | Zero runtime deps secp256k1 |
| DT-5 | EIP-2098 s-bit extraction BigInt puro | signature.ts líneas 118-120 | Sin deps externas |

## Lecciones para próximas HUs

1. **Hex parsing — documentar siempre si la longitud incluye prefijo**: AC-2 falló por ambigüedad "130/132 chars" ¿incluyendo 0x o no? Fix: después de `slice(2)`, medir contra 128/130, y documentar explícitamente en el contrato de la función.

2. **Externas libs — asumir solo formato canónico**: viem's recoverTypedDataAddress rechaza compact directo. Lección: antes de pasar firmas a libs externas, canonicalizar siempre. Evita sorpresas con wallets edge-case.

3. **Tests que pinchan guards reemplazados**: AC-15 old test rechazaba v=0/1; WFAC-13 lo convierte en normalización. No borrar test antiguos — reescribir para pinchar nuevo comportamiento, citando el AC nuevo por número.

4. **Pure modules — totalidad + Result pattern**: signature.ts nunca lanza, retorna Result siempre. Ganancia: callers sin try/catch, lógica clara, testeable. Aplicable a cualquier módulo de validación síncrona.

5. **BigInt operaciones — documentar bit shifts**: EIP-2098 yParity extraction (`(sBigInt >> 255n) & 1n`). Lección: comentarios en línea claros sobre operaciones bits + cita a spec (EIP-2098 §4).

6. **Auto-Blindaje feedback loop**: los 3 incidents F3 generaron patrones claros (hex parsing, external lib canonicalization, test supersedence) que pueden aplicarse a futuras HUs. Mantener el auto-blindaje como living document.

7. **Métricas de cobertura como gate**: 97.97% coverage signature.ts con 28 tests validó exhaustivamente todos los 10 ACs sin necesidad de RPC. Patrón: unidad > integración para módulos puros.

## Cambios en el pipeline (FAST+AR)

WFAC-13 validó el pipeline FAST+AR (no QUALITY) y produjo:
- **0 cambios post-implementación en SPEC** — sdd.md fue implícito (work-item.md tenía todo)
- **Auto-blindaje loop ágil** — W2 resolvió en <1h
- **CR turnaround rápido** — MNR-2 aplicado inmediatamente post-merge
- **Sin deuda funcional** — todos MNRs son claridad, no bugs

RECOMENDACIÓN: FAST+AR es adecuado para HUs de "refactor puro + expansión de cobertura". QUALITY sigue siendo obligatorio para cambios de lógica de negocio o arquitectura core.

## Cierre

| Aspecto | Resultado |
|---------|-----------|
| **Estado final HU** | DONE |
| **Tests** | 218/218 PASS |
| **Coverage** | 97.97% signature.ts |
| **Bloqueantes** | 0 |
| **Deuda técnica** | 0 |
| **Merge commit** | 6175e0a |
| **Branch** | feat/008-wfac-13-signature-normalization |
| **PR** | #16 (merged) |
| **Fecha closure** | 2026-04-24 |
