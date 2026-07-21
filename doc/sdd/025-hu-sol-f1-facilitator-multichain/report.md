# Report — HU-SOL-2 / WKH-204: Facilitator orquestador multichain por namespace

> **Status**: DONE (branch HELD — no merge a main; prod/Railway, decisión founder)
> **Fecha de cierre**: 2026-07-21
> **Commit**: `50922c4` (facilitator orquestador multichain por namespace)
> **Branch**: `feat/025-hu-sol-f1-facilitator-multichain` (HELD)
> **Test coverage**: 849 tests (833 baseline + 6 nuevos AC-5 discriminated union)

---

## Resumen ejecutivo

WKH-204 completó la abstracción namespace-agnóstica del core del facilitator (`verify`, `settle`, `registry`, `schemas`, `supported`, `types`, `ledger`) de "EVM-only, keyed por `chainId` numérico" a "multi-red, keyed por namespace (`eip155:` | `solana:` | futuros)". El refactor garantiza:

- **EVM 100% byte-idéntico** (833 tests sin tocar assertions; cuerpo eip155 textualmente intacto)
- **Slot no-EVM abierto** (`solana:devnet`/`solana:mainnet` rutea a `CHAIN_UNAVAILABLE` 503 estructurado)
- **Generalización contenida en core/** (CD-2: rutas, middleware, infra intactas)
- **Discriminación de payload por método** (schema `z.union` + narrowing tipado, ledger fail-closed)
- **Registry generalizado in-place** (Map key `ChainId`→`networkId: string`, `getAdapter` wrapper O(1))

**Resultado**: 6/6 ACs PASS + 849 tests verde + AR/CR APROBADOS + F4 QA APROBADO (drift NONE).

---

## Pipeline ejecutado

| Fase | Status | Veredicto |
|------|--------|-----------|
| F0 | ✓ | Project context + grounding |
| F1 | ✓ | HU_APPROVED (work-item.md: 6 ACs EARS) |
| F2 | ✓ | SPEC_APPROVED (SDD: 426 líneas, 3 clarifications resueltas) |
| F2-addendum | ✓ | SPEC_APPROVED (SDD addendum: rectificación AC-5 ripple, CD-10/CD-11 nuevos) |
| F2.5 | ✓ | Story File (539 líneas, W0–W4) |
| F3 W0–W4 | ✓ | Implementación (13 archivos: 9 producción + 4 tests + OWNERS.md) |
| AR | ✓ | APROBADO (8 vectores de ataque cerrados) |
| CR | ✓ | APROBADO (7 ítems checklist) |
| F4 QA | ✓ | APROBADO (6/6 ACs PASS, 849 tests, drift NONE) |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|---|--------|-----------|
| **AC-1** (regresión EVM) | PASS | 833 tests baseline sin tocar assertions. `verify.ts:48-150` + `settle.ts:48-160` textualmente intacto. Rama solana (early-return) antepuesta; fall-through preserva cuerpo eip155 byte-idéntico |
| **AC-2** (namespace routing) | PASS | `verify.ts:37-47` rama solana con dispatcher `namespace.substring(0, indexOf(':'))`. EIP155_RE vigente. `network:'eip155:2368'` → cuerpo intacto → `getAdapter(2368)` |
| **AC-3** (slot no-EVM) | PASS | `solana:devnet`/`mainnet` → cluster válido → `CHAIN_UNAVAILABLE` 503. `solana:1` → cluster inválido → `NETWORK_MISMATCH` 400 (byte-idéntico). Nunca throw/undefined |
| **AC-4** (interfaz verify-only) | PASS | `SettlementAdapter` base (metadata, verify, settle, getBreakerState?, setLogger?). `ChainAdapter extends SettlementAdapter` + viem clients. Tipado compilable. No implementado (CD-3) |
| **AC-5** (schema discrimina) | PASS | `z.union([Eip3009RequestSchema, NonEip3009RequestSchema])`. Branch eip3009 byte-idéntico. Branch non-eip3009 tipado (NO `z.record`). Narrowing `in` + guard `!== undefined` en settle cap-check. Ledger widening `authorization?` + guard `?? ''` |
| **AC-6** (registry por networkId) | PASS | Map key `string` (networkId). `getAdapterByNetworkId` primario. `getAdapter(chainId)` wrapper O(1). `getSupportedChainIds()` desde metadata. De-dup por networkId |

---

## Hallazgos finales

### BLOQUEANTEs (AR — 8 vectores cerrados)

1. **Byte-identidad EVM** — Cuerpo eip155 intacto; rama solana early-return. ✓
2. **Bypass de schema imposible** — `z.union` + `z.literal` + `z.enum` tipados. Index-signature evitada (CD-11). ✓
3. **Ledger fail-closed** — Widening `authorization?` + guard `?? ''`. Nunca inventa payer. ✓
4. **CD-2 respetado** — Ripple contenido en `src/core/*`. Ensanchamiento en ledger.ts INPUT hace compilar routes/settle.ts sin editarlo. ✓
5. **Registry consistency** — `getSupportedChainIds()` preserva ChainId[]. Wrapper `getAdapter` preserva mensaje miss. O(1). ✓
6. **Dispatch consistente** — Rama solana usa `buildX402Error()`, nunca throw. Patrón = cuerpo eip155. ✓
7. **X402ErrorCode acotado** — Reusar `CHAIN_UNAVAILABLE` (503). NO nuevo valor. Route-local unions NO precisan edits (CD-2). ✓
8. **Casts sancionados** — `as unknown as VerifyParams/SettleParams` en rama solana espejan cast ya documentado (verify.ts:124/settle.ts:140). Rama inalcanzable. CD-4 aclarado. ✓

### MENOREs

- Ninguno. Addendum rectificó gap AC-5.

---

## Auto-Blindaje consolidado

| Lección | Aplicar en | Prioridad |
|---------|-----------|-----------|
| **Union ripple a ledger** — Widening de `z.infer<union>` ripplea a TODOS consumidores, no solo el site visible. Grep obligatorio. Boundary para en `src/core/*`. | AC-5 + futuras generalizaciones | **CRÍTICA** |
| **Index-signature rompe narrowing** — Branch non-EVM NO puede ser `z.record` sin `authorization` explícito. Reintroduce `unknown` → TS18046. | Futuras ramas schema union | **CRÍTICA** |
| **Guard `!== undefined` obligatorio** — Narrowing `in` solo chequea presencia; agregar `&& field !== undefined` para optional. | Payload opcional + logic read | **ALTA** |
| **Excepción refactor namespace-agnóstico** — Cambios ESTRUCTURALES que abstraigan EVM-specific (aquí: `ChainId` → `networkId`) son excepciones a regla #1 OWNERS.md. Documentar en nota [N]. | Futuras generalizaciones | **MEDIA** |
| **Tsc + eslint completos** — `npm run qa` no es solo typecheck; ESLint caza patrones adicionales. Gate F3 completo. | F3 antes de AR | **MEDIA** |
| **CD-10** — Widening struct money-adjacent DEBE acompañarse de guard en rama fallo. PROHIBIDO: sin guard (TS18048) o `!` non-null (rompe fail-closed). | Ledger + widening | **CRÍTICA** |
| **CD-11** — Branch no-eip3009 NO puede tener index-signature sin `authorization` explícito. | Schema union futuras | **CRÍTICA** |

---

## Archivos modificados

### Producción (9 archivos)
- `src/core/types.ts`: +NetworkId/NetworkNamespace
- `src/chains/types.ts`: +SettlementAdapter, ChainAdapter extends, +supportedMethods?
- `src/chains/registry.ts`: Generalizar Map key, +getAdapterByNetworkId, getAdapter wrapper
- `src/core/verify.ts`: +rama solana (early-return, cuerpo eip155 intacto)
- `src/core/settle.ts`: +rama solana, cap-check narrowing + guard
- `src/core/schemas.ts`: z.union discriminado, branch non-eip3009 tipado
- `src/core/supported.ts`: Fallback supportedMethods
- `src/core/ledger.ts`: Widening authorization? + guard fail-closed
- `OWNERS.md`: Nota [4] — excepción refactor namespace-agnóstico

### Tests (4 archivos, 287 líneas nuevas)
- `src/__tests__/unit/core.verify.test.ts`: +3 dispatch solana tests
- `src/__tests__/unit/core.settle.test.ts`: +3 dispatch solana tests
- `src/__tests__/unit/chain-registry.test.ts`: +4 getAdapterByNetworkId tests
- `src/__tests__/unit/core.schemas.discriminated.test.ts`: CREAR (124 líneas, 6 fixtures)

### Artefactos (doc/sdd/025-hu-sol-f1-facilitator-multichain/)
- `work-item.md` (200 líneas): 6 ACs, DT-4, CD-9
- `sdd.md` (426 líneas): diseño, 3 clarifications resueltas
- `sdd-addendum.md` (265 líneas): rectificación AC-5, CD-10/CD-11
- `story-HU-SOL-2.md` (539 líneas): W0–W4 + checklist
- `auto-blindaje.md` (12 líneas): escalación F3

---

## Notas de trazabilidad

- **AR / CR sin archivos separados**: Reportados al orquestador; evidencia archivo:línea vive en commit + este reporte
- **Branch HELD**: NO mergeada a main (facilitator prod/Railway; merge/deploy = decisión founder)

---

## Decisiones diferidas

- Ninguna. Todas las ACs en esta HU. HU-SOL-6 (adapter Solana real) desbloqueada.

---

## Lecciones para próximas HUs

1. **Widening de tipos comunes requiere auditoría transversal** — ripple no solo en site visible sino en todos los constructores del tipo inferido (aquí: `buildLedgerEntry` en 3 call sites de `routes/settle.ts`). Grep obligatorio.

2. **Index-signature vs typed members** — `z.record` o `.passthrough()` sin members explícitos reintroduce `unknown` y rompe narrowing. Declarar explícitamente (`authorization: { from, value }?`).

3. **Guard `!== undefined` acompaña a `optional`** — operador `in` chequea presencia, no que valor no sea undefined. Agregar guard después del `in` check cuando miembro pasa a optional.

4. **Refactorings namespace-agnósticos = excepciones documentadas** — cambios ESTRUCTURALES que abstraigan concepto EVM-specific son excepciones a regla #1 OWNERS.md. Documentar nota [N] con origen HU.

5. **Reusar error codes evita ripple** — error code nuevo en `X402ErrorCode` fuerza actualizar route-local unions. Reusar existente con mensaje distinto evita violación CD-2.

6. **Tsc --strict + eslint --max-warnings 0 son gates independientes** — ESLint caza patrones adicionales. Correr `npm run qa` completo en F3.

---

## Confirmación final

✓ 6/6 ACs PASS + 849 tests verde
✓ AR/CR APROBADOS (8 vectores + 7 ítems checklist)
✓ F4 QA APROBADO (drift NONE)
✓ Auto-Blindaje consolidado (CD-10/CD-11 nuevos)
✓ Branch HELD en `feat/025-hu-sol-f1-facilitator-multichain` (50922c4)
✓ HU-SOL-6 (adapter Solana) desbloqueada
