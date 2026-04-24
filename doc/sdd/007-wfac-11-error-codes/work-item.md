# Work Item — [WKH-007 / WFAC-11] Standard error codes — `src/core/errors.ts`

## Resumen

Centralizar los 10 códigos de error del x402 spec en un módulo dedicado
`src/core/errors.ts` que exponga: (a) la tabla canónica de HTTP status por code,
(b) mensajes default spec-literal por code, y (c) una función pura `buildX402Error`
que construya el objeto `Err.error` tipado, eliminando la duplicación de los
`err()` helpers inline en `methods/eip3009/verify.ts` y `settle.ts`.

Target: spec-conformance y DRY, sin cambiar comportamiento observable.

---

## Sizing

- SDD_MODE: mini
- Estimación: S
- Flow: FAST+AR
- Branch sugerido: `feat/007-wfac-11-error-codes`

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `buildX402Error(code, message)` is called with any valid
  `X402ErrorCode`, the system SHALL return an object of shape
  `{ code: X402ErrorCode; message: string; http: number }` where `http` matches
  the canonical mapping defined in `HTTP_BY_CODE`.

- **AC-2**: WHEN `buildX402Error(code, message)` is called WITHOUT a `message`
  argument, the system SHALL use the default message from `DEFAULT_MESSAGE_BY_CODE`
  for that code.

- **AC-3**: WHEN `buildX402Error(code, message)` is called WITH an explicit
  `message` string, the system SHALL use that string verbatim (overrides default).

- **AC-4**: the system SHALL export a `HTTP_BY_CODE` record that maps every
  `X402ErrorCode` to its spec-defined HTTP status, with exhaustive coverage:
  `INVALID_SIGNATURE → 401`, `INSUFFICIENT_BALANCE → 402`,
  `PERMIT2_ALLOWANCE_REQUIRED → 412`, `EXPIRED_AUTHORIZATION → 400`,
  `NETWORK_MISMATCH → 400`, `SIMULATION_FAILED → 500`,
  `INVALID_AMOUNT → 400`, `INVALID_RECEIVER → 400`,
  `TRANSACTION_FAILED → 500`, `DELEGATION_INVALID → 401`.

- **AC-5**: the system SHALL export a `DEFAULT_MESSAGE_BY_CODE` record that maps
  every `X402ErrorCode` to a non-empty spec-literal default message string, with
  exhaustive TypeScript coverage (type `Record<X402ErrorCode, string>`).

- **AC-6**: WHILE TypeScript strict mode is enabled, the system SHALL produce a
  compile-time error if a new `X402ErrorCode` variant is added to `src/core/types.ts`
  without a corresponding entry in `HTTP_BY_CODE` or `DEFAULT_MESSAGE_BY_CODE`
  (enforced by `Record<X402ErrorCode, …>` exhaustive typing).

- **AC-7**: WHEN `src/methods/eip3009/verify.ts` or `settle.ts` use
  `buildX402Error`, the system SHALL NOT contain a local `err()` helper
  function in those files (dead code removed as part of this HU).

- **AC-8**: IF `buildX402Error` is called with a TypeScript-invalid code
  (e.g. a string not in `X402ErrorCode`), THEN the system SHALL produce a
  compile-time type error (no runtime guard needed — enforced by TypeScript).

---

## Scope IN

- `src/core/errors.ts` — nuevo módulo (greenfield)
- `src/core/types.ts` — solo lectura; el comment `// WFAC-12 may move…` se elimina
  una vez `errors.ts` exista (cleanup, sin cambio de exports)
- `src/methods/eip3009/verify.ts` — reemplazar `err()` helper local por
  `buildX402Error` importado
- `src/methods/eip3009/settle.ts` — ídem
- `src/__tests__/unit/core/errors.test.ts` — nuevo test file (W1 = mismo wave que W0)
- `doc/sdd/_INDEX.md` — entrada 007

## Scope OUT

- `src/core/index.ts` — no existe, y su creación está fuera de esta HU
  (DT-D: se re-exporta vía `src/core/errors.ts` standalone; barril opcional en
  HU futura)
- `src/routes/*.ts` — no se tocan; siguen usando `result.error` directamente
- Cualquier cambio en `X402ErrorCode` union — esa es la fuente de verdad en
  `src/core/types.ts`; WFAC-11 la consume, no la modifica
- Tests de integración / conformance (fuera de alcance)
- Permit2 / ERC-7710 methods (V1.5, V2)

---

## Decisiones Técnicas

- **DT-A — HTTP mapping**: la tabla `HTTP_BY_CODE` se tipea como
  `Record<X402ErrorCode, number>` (no `as const`) para forzar que el compilador
  detecte variantes faltantes. Los valores numéricos replican exactamente la tabla
  de `doc/architecture/X402-CONFORMANCE.md`.
  Nota: el spec dice `PERMIT2_ALLOWANCE_REQUIRED → 412`; la conformance doc
  tiene `412` (no `402`). Se adopta `412` por spec-literal.

- **DT-B — Message defaults**: `DEFAULT_MESSAGE_BY_CODE` tipado como
  `Record<X402ErrorCode, string>`. Los mensajes deben ser spec-literal (sin PII,
  sin addresses), descriptivos, en inglés.

- **DT-C — `buildX402Error` pure vs logger**: la función es PURA (no recibe ni
  invoca logger). El logger lo maneja el caller (route layer o method adapter).
  Firma: `buildX402Error(code: X402ErrorCode, message?: string): Err['error']`.
  Justificación: mantiene `src/core/errors.ts` sin dependencias de runtime
  (igual que `src/core/types.ts`), facilita tests sin mocks.

- **DT-D — Re-export vs standalone**: `errors.ts` es standalone (no barril
  `core/index.ts`). Los callers importan directamente desde `'../../core/errors.js'`.
  Un barril futuro puede re-exportarlo sin tocar esta HU.

---

## Constraint Directives

- **CD-1**: PROHIBIDO importar desde `src/chains/*`, `src/methods/*`, `src/routes/*`,
  `src/infra/*` dentro de `src/core/errors.ts` (boundary `OWNERS.md`).

- **CD-2**: PROHIBIDO usar `any` explícito o `as unknown` en `errors.ts`.

- **CD-3**: OBLIGATORIO que `HTTP_BY_CODE` y `DEFAULT_MESSAGE_BY_CODE` sean
  `Record<X402ErrorCode, …>` — NO `Partial<…>`, NO object literal con type
  assertion. TypeScript debe rechazar un objeto incompleto en compile-time.

- **CD-4**: PROHIBIDO logger, side effects o I/O en `buildX402Error`.
  La función es pura: mismo input → mismo output, sin excepciones.

- **CD-5**: OBLIGATORIO eliminar los `err()` helpers locales en
  `methods/eip3009/verify.ts` y `methods/eip3009/settle.ts` como parte de este
  PR. No se admite code path duplicado después del merge.

- **CD-6**: PROHIBIDO modificar el tipo `X402ErrorCode` en `src/core/types.ts`
  dentro de esta HU. Si hay discrepancia entre el spec y el type actual, debe
  documentarse como `[NEEDS CLARIFICATION]` y bloquearse en AR.

---

## Waves

- **W0** (`errors.ts` + refactor methods): implementación del módulo, eliminación
  de helpers locales, tipos exhaustivos.
- **W1** (tests — combinado con W0 en este PR): `errors.test.ts` con cobertura de
  los 10 codes, mensajes default, override, y type-level checks de exhaustividad.

Los waves son pequeños — se entregan en un único PR.

---

## Missing Inputs

- `[resuelto en F2]` — DT-A: la conformance doc dice `PERMIT2_ALLOWANCE_REQUIRED → 412`.
  El spec original (docs.x402.org) lista `402` para `INSUFFICIENT_BALANCE` y `412`
  para `PERMIT2_ALLOWANCE_REQUIRED`. Alinear en SDD F2 revisando spec literal.
- `[resuelto en F2]` — DT-C: firmar si `Err['error']` como tipo de retorno es
  suficiente o si se necesita un type alias nombrado `X402ErrorPayload`.

---

## Análisis de paralelismo

- Esta HU NO bloquea a otras HUs actualmente en backlog (verify/settle ya
  funcionan con el helper local inline).
- WFAC-12 (si trackea mover `X402ErrorCode` a `errors.ts`) puede ir en paralelo
  pero debe respetar que esta HU establece `errors.ts` como dueño de la tabla
  HTTP y mensajes — coordinar en Jira antes de merge.
- WFAC-6 y WFAC-10 (ya DONE) no son afectados en su comportamiento — solo se
  limpia el código.
