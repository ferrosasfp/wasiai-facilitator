# SDD Addendum #025-A — Rectificación del ripple del `z.union` (AC-5 / W3.1)

> Fecha: 2026-07-21
> Autor: nexus-architect (F2 addendum, disparado por escalación del F3)
> HU: WKH-204 / HU-SOL-2
> Branch: `feat/025-hu-sol-f1-facilitator-multichain`
> Estado del árbol al momento del addendum: W0/W1/W2/W3.2(supported)/W4 implementadas y verdes
> (843 tests); **W3.1 (schema union / AC-5) revertida por el F3** por un GAP de análisis de ripple.
> Este addendum CORRIGE el `sdd.md` §4.3(d) y la §11 del Story File. Reemplaza el diseño del branch
> no-eip3009 y añade `src/core/ledger.ts` al Scope IN. Todo lo demás del `sdd.md` sigue vigente.

---

## A.1 Qué falló (root cause del GAP)

El `sdd.md` §4.3(d) + §3.3 + Story §3.3 afirmaban:

> "Tipo inferido `VerifyRequest` = union → **única ripple**: `settleCore` Step 0 lee
> `parsed.payload.authorization.value` → se resuelve con narrowing `in`."

**Es incompleto.** Hay una **segunda ripple** (y el diseño del branch no-eip3009 con `z.record`
además rompe la PRIMERA). Verificado por mí con `grep` + `tsc` (probes aisladas con la zod real del repo):

### Ripple real #1 — `src/core/ledger.ts` (el que reventó el F3)

`type SettleRequest = VerifyRequest` (alias, `schemas.ts:113`) fluye desde `routes/settle.ts` a
`buildLedgerEntry({ ..., parsed, ... })` en **3 call sites**: `routes/settle.ts:283`, `:335`, `:382`.
El parámetro `parsed` aterriza en `BuildLedgerEntryInput.parsed` (`src/core/ledger.ts:64-78`), cuyo
`payload.authorization: { from: string }` es **requerido**. El branch `NonEip3009` (payload permissivo)
NO garantiza `authorization` → el union NO es asignable a `BuildLedgerEntryInput.parsed` → `tsc` falla
**en el call site**, es decir en `routes/settle.ts:288/340/382`.

### Ripple real #2 — el cap-check `in` NO alcanza si el payload no-eip3009 es `z.record`

El diseño revertido usaba `payload: z.record(z.string(), z.unknown())` para el branch no-eip3009
(Story §W3.1 línea 342). Con eso, tras `'authorization' in parsed.payload` el tipo de
`parsed.payload.authorization` en el branch no-eip3009 es `unknown` (viene del index-signature del
record) → `parsed.payload.authorization.value` da **TS18046** en `core/settle.ts:77`. El narrowing `in`
por sí solo NO resuelve la ripple si el branch no-eip3009 tiene un index-signature (`z.record` /
`.passthrough()` sin `authorization` explícito).

**Conclusión del análisis de boundary:** consumidores de `buildLedgerEntry` / `BuildLedgerEntryInput`
(via `grep -rn`): definición en `src/core/ledger.ts`; 3 call sites en `src/routes/settle.ts`; el resto
son tests. **El boundary del ripple PARA en `src/core/*`** — ensanchar el **tipo de entrada** de
`buildLedgerEntry` (en `ledger.ts`) hace compilar `routes/settle.ts` **sin editarlo**. Confirmado con
`tsc` (probe: asignación `{ parsed: unionValue }` a `BuildLedgerEntryInput` con `authorization` opcional
→ compila). Los otros lectores de `payload.authorization` (`src/methods/eip3009/*`,
`src/chains/base-adapter.ts`, `src/chains/types.ts`) leen `params.payload.authorization` sobre
`VerifyParams`/`SettleParams` — están del lado adapter del cast `as unknown as`, **aislados** del union
del schema. No hay ripple ahí.

> **CD-2 respetado.** `src/core/ledger.ts` y `src/core/settle.ts` son `src/core/*`. CD-2 prohíbe
> `src/routes/*`, `src/middleware/*`, `src/infra/*` — NINGUNO se toca. **AC-5 es completable en esta HU**
> con `ledger.ts` en Scope IN; NO se reubica a HU-SOL-6.

---

## A.2 Scope IN ampliado (+1 archivo de producción)

Se AÑADE a la tabla `sdd.md` §4.1 / Story §2:

| Archivo | Acción | Justificación CD-2 |
|---------|--------|--------------------|
| `src/core/ledger.ts` | Modificar | Es `src/core/*` (NO `routes/`/`middleware/`/`infra/`). Ensanchar el tipo `BuildLedgerEntryInput` (input de `buildLedgerEntry`) es la forma de hacer compilar `routes/settle.ts` **sin tocar** `routes/settle.ts`. Blast-radius contenido en core. |

`src/core/settle.ts` YA estaba en Scope IN (W2.2). La corrección del cap-check vive ahí (core/*).

---

## A.3 Diseño rectificado del schema union (reemplaza `sdd.md` §4.3d y Story §W3.1)

Diseño **verificado con `tsc --strict` + zod runtime** (probes con la zod real del repo). Tres piezas
que van JUNTAS en W3.1 y dejan el árbol verde:

### (1) `src/core/schemas.ts` — union con branch no-eip3009 **tipado** (NO `z.record`)

El branch no-eip3009 NO puede ser `z.record`/`.passthrough()`-sin-authorization (rompe el cap-check por
index-signature). Declara `authorization` **explícita, opcional y tipada** con SOLO los dos campos que el
código lee (`from` para el ledger, `value` para el cap-check), con `.passthrough()` para tolerar los
campos extra del payload eip3009 que los tests T-V10/T-C5 le pasan (`to/validAfter/validBefore/nonce`) y
formas no-EVM futuras (AC-5). Es un **placeholder** — NO el shape final de Solana (CD-3).

```ts
// Branch eip3009 — BYTE-IDÉNTICO al schema actual.
const Eip3009RequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: AcceptedSchema.extend({
      extra: AcceptedExtraSchema.extend({ assetTransferMethod: z.literal('eip3009') }),
    }),
    payload: PayloadSchema,
  })
  .strict();

// Payload placeholder no-eip3009 — tipado mínimo por lo que el core LEE, permissivo por passthrough.
// NO es el shape final de Solana (CD-3).
const NonEip3009PayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u).optional(),
    // authorization opcional; `from`+`value` son lo único que ledger.ts / settle.ts leen.
    // `.passthrough()` tolera los campos eip3009 extra (to/validAfter/validBefore/nonce) que
    // T-V10/T-C5 inyectan al reusar VALID_BODY.payload, y campos no-EVM futuros.
    authorization: z
      .object({ from: AddressHexSchema, value: Uint256StringSchema })
      .passthrough()
      .optional(),
  })
  .passthrough();

const NonEip3009RequestSchema = z
  .object({
    x402Version: z.literal(2),
    resource: ResourceSchema,
    accepted: AcceptedSchema.extend({
      extra: AcceptedExtraSchema.extend({ assetTransferMethod: z.enum(['permit2', 'erc7710']) }),
    }),
    payload: NonEip3009PayloadSchema,
  })
  .strict();

// z.union (NO discriminatedUnion: el discriminante vive anidado en accepted.extra).
export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema]);
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const SettleRequestSchema = VerifyRequestSchema; // alias intacto
export type SettleRequest = VerifyRequest;
```

**Verificado runtime (zod real del repo):** body eip3009 → `success:true`; body permit2 con payload
eip3009-shaped → `success:true` (llega al method-guard, §4.5 caso 4); bad signature / amount `0100` /
unknown top-key / missing resource / x402Version=1 → `success:false`. `.extend()` **preserva `.strict()`**
(el "unknown top key" da `false`). Coincide con T-V1..T-V5 + el test de strict-mode + T-V10/T-C5.

### (2) `src/core/settle.ts` — cap-check con guard `!== undefined` (ripple #2)

El `'authorization' in parsed.payload` de W2.2 **NO alcanza** con `authorization` opcional: `tsc` da
**TS18048** (`authorization possibly undefined`). Añadir el guard de undefined. **Byte-idéntico para
eip3009** (donde `authorization` está siempre definido → el guard es siempre `true`):

```ts
if (
  options?.maxAmountAtomic !== undefined &&
  'authorization' in parsed.payload &&
  parsed.payload.authorization !== undefined
) {
  const capCheck = checkSettleAmountCap(parsed.payload.authorization.value, options.maxAmountAtomic);
  // ...resto idéntico...
}
```

### (3) `src/core/ledger.ts` — widening del input + guard (ripple #1)

Cambio **mínimo** de `BuildLedgerEntryInput`: `authorization` pasa a **opcional**. Y en la rama de fallo
(`buildLedgerEntry`, ~L137) se guardea el read con fallback fail-closed. **Byte-idéntico para eip3009**
(donde `authorization.from` siempre existe → mismo `payer`).

```ts
// src/core/ledger.ts — dentro de interface BuildLedgerEntryInput
readonly parsed: {
  readonly accepted: {
    readonly asset: string;
    readonly payTo: string;
    readonly amount: string;
  };
  readonly payload: {
    // WKH-204: opcional para aceptar el union VerifyRequest (branch no-eip3009 no
    // garantiza authorization). Para todo payload eip3009 (los reales de esta HU)
    // authorization.from está presente → payer byte-idéntico.
    readonly authorization?: { readonly from: string };
  };
};
```

```ts
// src/core/ledger.ts — buildLedgerEntry, rama de fallo (~L137)
// ANTES:  payer: input.parsed.payload.authorization.from,
// DESPUÉS:
payer: input.parsed.payload.authorization?.from ?? '',
```

**Fail-closed del branch no-eip3009 (inalcanzable esta HU — no hay adapter solana):** si algún día un
payload sin `authorization` llegara al ledger, `payer` queda `''` (string vacío, satisface la columna
`payer TEXT NOT NULL`) en vez de crashear. Nunca inventa un payer. La rama success NO cambia (lee
`input.result.from`, no el payload).

> **Por qué opcional y no "requerido en ambos branches":** requerir `authorization` en el branch
> no-eip3009 (para evitar el widening) sería MÁS especulativo — forzaría un shape eip3009-like sobre
> payloads no-EVM y rechazaría en Zod un permit2 sin `authorization` (contradice §4.5 caso 4). El
> widening a opcional + guard es el mínimo que honra "payload permissivo" (AC-5) y es byte-idéntico para
> eip3009. Verificado: los 3 cambios juntos → `tsc --strict` verde; ninguno solo alcanza.

---

## A.4 Resolución de los 2 `as unknown as` del branch solana (W2.1/W2.2)

Casts en cuestión: `src/core/verify.ts:63` (`parsed as unknown as VerifyParams`) y
`src/core/settle.ts:60` (`parsed as unknown as SettleParams`), ambos en la rama `solana` — dispatch al
adapter que es **inalcanzable en esta HU** (no hay adapter solana registrado).

**Decisión: SANCIONARLOS explícitamente.** Justificación:

1. **Espejan el cast ya sancionado** de `src/core/verify.ts:124` y `src/core/settle.ts:140`
   (`parsed as unknown as VerifyParams/SettleParams`), documentado en auto-blindaje (WFAC-20 W0 entry 2 /
   entry 4): Zod `.regex()` estrecha a `string`, no a los branded ``0x${string}`` de `VerifyParams`. La
   rama solana tiene el **mismo** gap de brand VerifyRequest→VerifyParams. Es el mismo patrón, no uno nuevo.
2. **Doble cast `as unknown as` (nunca `as any`, nunca cast simple)** — consistente con el patrón vigente.
3. **Branch inalcanzable** — no ejecuta lógica solana real (CD-3); es un dispatch tipado que sólo se
   activará cuando HU-SOL-6 registre el adapter.

**Aclaración a CD-4** (ver A.5): CD-4 prohíbe casts **para forzar el narrowing del discriminated union**
(eso se hace con `z.union`+`z.literal`+`in`, no con `as`). Los casts de **dispatch al adapter en el
boundary de namespace** (que espejan los eip155 sancionados) están **permitidos y documentados**. No son
"nuevos" en sentido de patrón: son la Nª instancia del mismo cast VerifyRequest→VerifyParams que ya vive
en verify.ts:124 / settle.ts:140.

---

## A.5 Cambios a Constraint Directives

- **CD-4 (aclarado)**: PROHIBIDO `any` / `as unknown as X` para forzar el **narrowing del schema union**
  (usar `z.union` + `z.literal` + narrowing por `in` + guard `!== undefined`). **EXCEPCIÓN documentada:**
  los casts de **dispatch al adapter** en el boundary de namespace (`verify.ts:63`, `settle.ts:60`)
  espejan el cast ya sancionado VerifyRequest→VerifyParams de `verify.ts:124`/`settle.ts:140` (Zod
  `.regex()` no produce branded hex) sobre una rama inalcanzable → **permitidos**.
- **CD-10 (nuevo)**: el widening de `BuildLedgerEntryInput.parsed.payload.authorization` a opcional debe
  ir **acompañado del guard** `?? ''` en la rama de fallo de `buildLedgerEntry` (fail-closed). PROHIBIDO
  dejar el read sin guard (rompe `tsc`, TS18048) o usar `!` non-null assertion (rompe la garantía
  fail-closed del branch no-eip3009).
- **CD-11 (nuevo)**: el branch no-eip3009 del union NO puede ser `z.record` ni `.passthrough()` sin un
  `authorization` explícito tipado — reintroduce el index-signature que rompe el narrowing `in` del
  cap-check (TS18046). Debe declarar `authorization?: { from, value }` explícito.

---

## A.6 Tests nuevos AC-5 (complementa Story §W4.2)

El test AC-5 (`core.schemas.discriminated.test.ts`) debe cubrir, además de lo ya listado:

- `safeParse(eip3009Body).success === true` (branch eip3009 byte-idéntico).
- `safeParse(permit2BodyConEip3009Payload).success === true` (reusa `VALID_BODY.payload`; el body llega
  al method-guard, NO se rechaza en Zod — protege §4.5 caso 4 / T-V10 / T-C5).
- `safeParse(eip3009BodyMalformado).success === false` (bad signature / amount no-canónico).
- `safeParse(bodyConUnknownTopKey).success === false` (`.strict()` preservado por `.extend()`).
- **No hay** tests nuevos en `ledger.test.ts`: el widening es byte-idéntico para eip3009 y los 843 tests
  (incl. `ledger.test.ts` T12/T13/T14 con `authorization.from` presente) DEBEN pasar sin tocar
  assertions (AC-1). Opcional: 1 test que arme un `BuildLedgerEntryInput` de fallo SIN `authorization` y
  verifique `payer === ''` (documenta el fail-closed).

---

## A.7 Readiness Check (addendum)

```
[x] Ripple boundary confirmado por grep + tsc: PARA en src/core/* (ledger.ts + settle.ts)
[x] routes/settle.ts compila SIN editarse (widening del input type en ledger.ts) → CD-2 respetado
[x] src/core/ledger.ts añadido a Scope IN con justificación CD-2 explícita (es core/*)
[x] Diseño del union verificado: tsc --strict verde (probe) + zod runtime (7 fixtures) coinciden con T-V1..V5/V10/C5
[x] Los 3 cambios (schema + cap-check guard + ledger widening) son byte-idénticos para eip3009 (AC-1)
[x] 2 casts solana sancionados (espejan verify.ts:124/settle.ts:140, branch inalcanzable) — CD-4 aclarado
[x] CD-10/CD-11 nuevos previenen la re-caída (guard obligatorio + no z.record en el branch)
[x] AC-5 completable EN esta HU (no se reubica a HU-SOL-6)
```

**AC-5 desbloqueado.** Story §W3.1 actualizado con las 3 instrucciones mecánicas.
