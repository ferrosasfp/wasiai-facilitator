# Story File — HU-SOL-2 / WKH-204: Facilitator multi-red (dispatch por namespace)

> Contrato autocontenido para el Dev. Fuente de verdad = este archivo + el SDD `sdd.md` + **`sdd-addendum.md`**.
> Repo: `/home/ferdev/.openclaw/workspace/wasiai-facilitator/`
> Branch: `feat/025-hu-sol-f1-facilitator-multichain`
> SPEC_APPROVED: SI (clinical review autónomo — RATIFICADA la decisión de reusar `CHAIN_UNAVAILABLE`; NO se agrega código nuevo a `X402ErrorCode`; honra CD-2/CD-7).
> Waves: 5 (W0→W4), cada una con gate de verificación. Entre waves NO hay gate humano.
>
> **⚠️ ADDENDUM 025-A (2026-07-21) — LEER.** W3.1 (schema union / AC-5) fue revertida por un GAP de
> análisis de ripple. El diseño corregido está en `sdd-addendum.md` y en la **§W3.1 de este archivo
> (reescrita)**. Cambios clave: `src/core/ledger.ts` entra al Scope IN (es `core/*`, NO viola CD-2); el
> branch no-eip3009 del union NO es `z.record`; el cap-check de settle.ts necesita un guard `!== undefined`;
> el ledger widena `authorization` a opcional + guard. Los otros waves (W0/W1/W2/W3.2/W4) están OK y verdes.

---

## 0. Contexto compacto (qué se construye y por qué)

Generalizamos el core del facilitator de **EVM-only** (keyed por `chainId` numérico vía `eip155:<chainId>`)
a **multi-red por namespace** (`eip155:` | `solana:` | futuros). Es fundación de abstracción pura:

- **NO** se implementa el adapter Solana real (eso es HU-SOL-6). CD-3.
- Un `network: "solana:devnet"` / `"solana:mainnet"` debe rutear a un error x402 estructurado y
  **no-crasheante** (`CHAIN_UNAVAILABLE`, HTTP 503), NUNCA a un throw ni a un settle simulado.
- El path EVM (`eip155:*` + método `eip3009`) queda **100% byte-idéntico** — regresión cero.

Resultado: 833 tests existentes verdes **sin tocar assertions** + tests nuevos de dispatch/registry/schema.

---

## 1. Anti-Hallucination Header (LEER ANTES DE TOCAR NADA)

### 1.1 Baseline a verificar ANTES de empezar

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npm run qa
```

Debe dar: **833 tests verde** (58 archivos) + **typecheck 0 errores** + **eslint --max-warnings 0** +
**prettier --check** limpio. Si el baseline NO está verde, PARAR y escalar — no empieces sobre un árbol roto.

`npm run qa` = `typecheck && lint && format:check && test` (ver `package.json`).

### 1.2 REGLA DE ORO (CD-1 / CD-8)

Los 833 tests existentes pasan **SIN tocar una sola assertion**. Los únicos edits permitidos en tests
existentes son **mecánicos por el refactor de tipos** (imports). **Si un `expect` de un test EVM cambia
para compilar/pasar → PARAR y ESCALAR.** Eso significa que el refactor rompió el comportamiento observable
EVM, que es exactamente lo que esta HU prohíbe.

### 1.3 Toolchain gotchas (auto-blindaje WFAC-148 / WKH-154 — OBLIGATORIO respetar)

- **NO biome.** El toolchain es **eslint + prettier**. Formateá con lo que ya usa el repo; el gate es
  `npm run qa`.
- **NO `typeof import('...')` inline en tests.** ESLint `consistent-type-imports` lo rechaza. Usar
  `import type * as X from '...'` top-level.
- **NO acceso member por clave variable en duck-typing.** ESLint `security/detect-object-injection` lo
  rechaza. Usar claves **literales** sobre una interfaz tipada (ver el patrón ya existente en
  `supported.ts:80-87`, que usa `BreakerGetter` tipado + claves literales).
- **NO `any` / `as unknown as X` NUEVOS para forzar el narrowing del discriminated union** (CD-4). Usar
  `z.union` + `z.literal` + narrowing por operador `in` + guard `!== undefined`. **EXCEPCIÓN sancionada
  (addendum 025-A):** los 2 casts de **dispatch al adapter** en la rama solana (`verify.ts` y `settle.ts`,
  `parsed as unknown as VerifyParams/SettleParams`) están PERMITIDOS — espejan el cast ya sancionado
  VerifyRequest→VerifyParams de `verify.ts` / `settle.ts` (Zod `.regex()` no produce branded ``0x${string}``)
  sobre una rama inalcanzable esta HU. NO son "nuevos" en sentido de patrón; son la Nª instancia del mismo
  cast que ya vive en el cuerpo eip155. Los `as unknown as` del cuerpo eip155 tampoco se tocan.

### 1.4 Anti-Hallucination Checklist específico de esta HU

- [ ] `CHAIN_UNAVAILABLE` YA existe en `X402ErrorCode` (`src/core/types.ts:47`) + tablas exhaustivas
      `HTTP_BY_CODE`/`DEFAULT_MESSAGE_BY_CODE` de `src/core/errors.ts` + manejo Retry-After en ambas rutas.
      **Se REUSA. NO se agrega ningún valor nuevo al union.**
- [ ] `ChainMetadata.networkId: string` (`"eip155:<chainId>"`) YA existe (`src/chains/types.ts:49`). Es la
      clave string del registry generalizado.
- [ ] `buildX402Error(code, message?)` (`src/core/errors.ts`) es la ÚNICA forma de construir errores nuevos.
      NO armar objetos `{code,message,http}` a mano en `verify.ts`/`settle.ts`.
- [ ] PROHIBIDO tocar `src/routes/*`, `src/middleware/*`, `src/infra/*` (CD-2). El dispatch multi-red vive
      solo en `src/core/*` + `src/chains/registry.ts` + `src/chains/types.ts`.
- [ ] **(addendum 025-A)** `src/core/ledger.ts` SÍ está en Scope IN — es `src/core/*`, NO viola CD-2. El
      widening de su `BuildLedgerEntryInput` es lo que hace compilar `routes/settle.ts` **sin editarlo**.
      Si te encontrás por editar `routes/settle.ts` → PARAR: no hace falta, y viola CD-2.
- [ ] **(addendum 025-A)** El branch no-eip3009 del union NO es `z.record` ni `.passthrough()` sin
      `authorization`: eso reintroduce un index-signature que rompe el narrowing `in` del cap-check
      (TS18046). Declarar `authorization?: { from, value }` explícito (ver W3.1).
- [ ] PROHIBIDO crear `src/chains/<solana>.ts`, `src/core/network.ts`, o cualquier adapter concreto.
- [ ] PROHIBIDO agregar dependencias (viem/solana-web3.js/etc.). Ninguna.
- [ ] `_isValidAdapter` (`registry.ts:113-127`) NO se toca (DT-4).

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

**Producción (9):**
1. `src/core/types.ts` — añadir `NetworkId` / `NetworkNamespace` (aditivo).
2. `src/chains/types.ts` — añadir `SettlementAdapter` + `ChainAdapter extends SettlementAdapter` + campo opcional `ChainMetadata.supportedMethods?`.
3. `src/chains/registry.ts` — Map key `ChainId`→`string`, `getAdapterByNetworkId`, `getAdapter` wrapper O(1), de-dup por `networkId`, `getSupportedChainIds` desde metadata. `_isValidAdapter` INTACTO.
4. `src/core/verify.ts` — rama `solana:` ANTES del cuerpo eip155 (intacto).
5. `src/core/settle.ts` — espejo + cap check Step 0 con narrowing `'authorization' in parsed.payload` **+ guard `!== undefined`** (ver W3.1 / addendum 025-A).
6. `src/core/schemas.ts` — `z.union` discriminado por `assetTransferMethod`; branch eip3009 byte-idéntico, branch no-eip3009 tipado (NO `z.record` — ver W3.1 reescrita).
7. `src/core/supported.ts` — métodos por-adapter con fallback a `CHAIN_METHODS_DEFAULT` (output byte-idéntico).
8. **`src/core/ledger.ts`** — **(NUEVO, addendum 025-A)** widening de `BuildLedgerEntryInput.parsed.payload.authorization` a opcional + guard `?? ''` en la rama de fallo. Es `src/core/*` → NO viola CD-2; hace compilar `routes/settle.ts` (3 call sites de `buildLedgerEntry`) **sin editar `routes/settle.ts`**.
9. `OWNERS.md` — nota `[4]`.

**Tests (4):**
9. `src/__tests__/unit/core.verify.test.ts` — + dispatch solana.
10. `src/__tests__/unit/core.settle.test.ts` — + dispatch solana.
11. `src/__tests__/unit/chain-registry.test.ts` — + `getAdapterByNetworkId` / registro por networkId.
12. `src/__tests__/unit/core.schemas.discriminated.test.ts` — CREAR (o extender un test existente).

> Nota: si preferís un archivo `*.solana.test.ts` nuevo en vez de extender los existentes, OK — siempre que
> los tests existentes NO cambien sus assertions (CD-1).

**Scope OUT:** adapter Solana real, lógica Solana (ed25519/SPL/RPC/wallet), `routes/*`, `middleware/*`,
`infra/*`, `openapi.yaml`, `X402-CONFORMANCE.md`, chains/métodos EVM nuevos, `src/core/network.ts` compartido.

---

## 3. Invariante byte-idéntico (CD-1 / CD-8) — el corazón de la HU

1. **El cuerpo eip155 de `verifyCore` y `settleCore` queda TEXTUALMENTE INTACTO.** No se reescribe ni una
   línea de: `EIP155_RE.exec`, el overflow guard `MAX_CHAINID_DIGITS`, el method guard
   `assetTransferMethod !== 'eip3009'`, `chainRegistry.getAdapter(chainId)`, el dispatch al adapter, los dos
   `as unknown as`. La rama solana se **ANTEPONE** como early-return; todo lo que no empieza con `solana:`
   cae por fall-through al cuerpo actual sin cambios.

2. **`solana:1`** (único string solana en los tests existentes: T-V6 verify:146, T-C2 settle:118, T-R6
   route:360) NO matchea `/^solana:(devnet|mainnet)$/u` → cluster inválido → `NETWORK_MISMATCH` HTTP 400,
   **indistinguible byte-a-byte** del comportamiento actual. Esos asserts NO cambian.

3. **`settleCore` Step 0 (cap check)** — CORREGIDO por addendum 025-A: el schema pasa a un union, así que
   `parsed.payload` deja de tener `authorization` garantizado. El narrowing `in` **por sí solo NO alcanza**
   con `authorization` opcional (`tsc` da TS18048). Se protege con `in` **+ guard `!== undefined`**:
   ```ts
   if (
     options?.maxAmountAtomic !== undefined &&
     'authorization' in parsed.payload &&
     parsed.payload.authorization !== undefined
   ) {
     const capCheck = checkSettleAmountCap(parsed.payload.authorization.value, options.maxAmountAtomic);
     ...
   }
   ```
   Para TODO fixture eip3009 (todos los existentes) `authorization` está definido → el cap check corre
   **idéntico** (byte-idéntico; el guard es siempre `true`). NO uses `as` para forzar el acceso.
   Si un test de precedencia cap-vs-method con método no-eip3009 rompe por esto → PARAR y ESCALAR.

---

## Wave 0 — Tipos base (SERIAL GATE)

**Objetivo:** abrir los tipos sin romper `ChainId` / `ChainAdapter` / `X402ErrorCode`.

### W0.1 — `src/core/types.ts` (aditivo)
Agregar debajo del bloque `ChainId` (sin tocar `ChainId`, `asChainId`, `X402ErrorCode`, `Err`, `Result`):
```ts
/** Network namespace prefix (before the first ':' in a networkId). */
export type NetworkNamespace = 'eip155' | 'solana';

/** Full network identifier string, e.g. "eip155:2368" | "solana:devnet". */
export type NetworkId = string;
```
PROHIBIDO en W0.1: tocar `X402ErrorCode` (no agregar valores — CD-7), tocar `ChainId`/`asChainId`.

### W0.2 — `src/chains/types.ts`
1. Añadir campo opcional a `ChainMetadata` (después de `tokens` o donde sea coherente):
   ```ts
   /** WKH-204 — optional per-adapter method override; falls back to CHAIN_METHODS_DEFAULT. */
   readonly supportedMethods?: readonly string[];
   ```
2. Extraer `SettlementAdapter` como interfaz BASE verify-only y hacer que `ChainAdapter` la extienda con la
   parte viem. `ChainAdapter` conserva EXACTAMENTE sus miembros actuales (addition, no reemplazo — DT-3):
   ```ts
   /**
    * WKH-204 (AC-4) — verify-only settlement contract. Money-moving methods that
    * do NOT require viem clients (getPublicClient/getWalletClient). Non-EVM rails
    * (Solana) auto-broadcast from the client wallet and have no operator broadcast
    * wallet in the EVM sense. This HU defines/types the interface; it does NOT
    * implement a real non-EVM adapter (CD-3).
    */
   export interface SettlementAdapter {
     readonly metadata: ChainMetadata;
     verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
     settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
     getBreakerState?(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
     setLogger?(logger: Logger): void;
   }

   export interface ChainAdapter extends SettlementAdapter {
     getPublicClient(): PublicClient;
     getWalletClient(): WalletClient;
   }
   ```
   Mové los JSDoc de `getBreakerState`/`setLogger` a `SettlementAdapter`. El resto de `chains/types.ts`
   (shapes `VerifyParams`, `SettleParams`, `RegisterResult`, `ChainAdapterInitError`) NO cambia.

PROHIBIDO en W0.2: cambiar `ChainMetadata.chainId` (sigue `ChainId` numérico EVM — el metadata no-EVM se
difiere a HU-SOL-6); registrar/construir ningún adapter no-EVM; tocar `viem` imports salvo que queden como
están (siguen usándose en `ChainAdapter`).

**GATE W0:** `npm run typecheck` verde.

---

## Wave 1 — Registry in-place (depende de W0)

**Archivo:** `src/chains/registry.ts`. Decisión §10.3 RATIFICADA: **in-place**, key `ChainId`→`string`.

Cambios exactos:
1. **Map key** → `string` (networkId):
   ```ts
   private readonly _adapters = new Map<string, ChainAdapter>();
   ```
2. **`register`**: de-dup y set por `metadata.networkId` (no `chainId`). El mensaje de "already registered"
   puede seguir citando `chainId` para no cambiar assertions — pero la KEY del Map es `networkId`:
   ```ts
   const networkId = adapter.metadata.networkId;
   if (this._adapters.has(networkId)) {
     return { ok: false, error: { code: 'NETWORK_MISMATCH',
       message: `Chain already registered: ${adapter.metadata.chainId}`, http: 409 } };
   }
   this._adapters.set(networkId, adapter);
   ```
   (Para EVM, `networkId` es 1:1 con `chainId`, así que el de-dup se comporta idéntico. El test AC-5 dup→409
   sigue pasando.)
3. **`getAdapterByNetworkId` (NUEVO)** — mismo Result-shape que `getAdapter`:
   ```ts
   getAdapterByNetworkId(networkId: string):
     | { readonly ok: true; readonly adapter: ChainAdapter }
     | { readonly ok: false; readonly error: {
         readonly code: 'NETWORK_MISMATCH'; readonly message: string; readonly http: number } } {
     const adapter = this._adapters.get(networkId);
     if (!adapter) {
       return { ok: false, error: { code: 'NETWORK_MISMATCH',
         message: `Network not registered: ${networkId}`, http: 400 } };
     }
     return { ok: true, adapter };
   }
   ```
4. **`getAdapter(chainId)` → wrapper O(1)** que preserva TEXTUALMENTE el mensaje de miss:
   ```ts
   getAdapter(chainId: ChainId): /* mismo tipo de retorno que hoy */ {
     const lookup = this.getAdapterByNetworkId(`eip155:${chainId}`);
     if (!lookup.ok) {
       return { ok: false, error: { code: 'NETWORK_MISMATCH',
         message: `Chain not registered: ${chainId}`, http: 400 } };
     }
     return lookup;
   }
   ```
   El mensaje `Chain not registered: ${chainId}` se preserva byte-a-byte (los tests no lo assertan, pero se
   mantiene por seguridad). Concat string O(1) + `Map.get` O(1) = O(1) — cumple DT-4.
5. **`getSupportedChainIds()`** ahora deriva de `metadata.chainId` (las keys ya no son ChainId):
   ```ts
   getSupportedChainIds(): readonly ChainId[] {
     const out: ChainId[] = [];
     for (const adapter of this._adapters.values()) out.push(adapter.metadata.chainId);
     return out;
   }
   ```
6. **`listAdapters()`** NO cambia (ya itera `.values()`).
7. **`_isValidAdapter`** NO se toca (DT-4). Sigue exigiendo `getPublicClient`/`getWalletClient` — porque en
   esta HU el registry solo almacena adapters EVM (`ChainAdapter`). AC-6 es sobre el tipo de la KEY, no del
   value.

PROHIBIDO en W1: cambiar el value-type del Map a `SettlementAdapter` (eso es HU-SOL-6); relajar
`_isValidAdapter`; tocar `_resetForTesting`.

**GATE W1:** `npm run typecheck` + `chain-registry.test.ts` verde.

---

## Wave 2 — Dispatch por namespace (depende de W1)

### W2.1 — `src/core/verify.ts`
Anteponer la rama solana AL INICIO de `verifyCore`, ANTES de `const m = EIP155_RE.exec(...)`. El resto del
cuerpo queda INTACTO (CD-8). Import de `chainRegistry` ya existe.
```ts
// WKH-204 — namespace dispatch. Non-eip155 rails route here BEFORE the EVM body.
const network = parsed.accepted.network;
const namespace = network.substring(0, network.indexOf(':'));
if (namespace === 'solana') {
  if (!/^solana:(devnet|mainnet)$/u.test(network)) {
    return { ok: false, error: buildX402Error('NETWORK_MISMATCH',
      'network must be solana:<devnet|mainnet>') };
  }
  const lookup = chainRegistry.getAdapterByNetworkId(network);
  if (!lookup.ok) {
    return { ok: false, error: buildX402Error('CHAIN_UNAVAILABLE',
      'Network namespace recognized but no adapter registered') };
  }
  return lookup.adapter.verify(parsed as unknown as VerifyParams);
}
// ── fall-through: cuerpo eip155 ACTUAL (EIP155_RE → overflow → method → getAdapter → dispatch) SIN TOCAR.
```
- El `buildX402Error('CHAIN_UNAVAILABLE', ...)` NO pasa `retryAfterMs` → la ruta no emite Retry-After (503
  limpio). Decisión §10.2 RATIFICADA.
- `indexOf(':')` para `network` sin `:` devuelve `-1` → `substring(0,-1)` = `''` ≠ `'solana'` → fall-through
  (comportamiento EVM idéntico). `foo:bar` → namespace `'foo'` ≠ `'solana'` → fall-through → `EIP155_RE`
  miss → `NETWORK_MISMATCH` (idéntico a hoy).

### W2.2 — `src/core/settle.ts`
Espejo de W2.1. Anteponer la misma rama solana AL INICIO de `settleCore` (antes del Step 0 cap check), y
aplicar el narrowing `in` del §3.3 al cap check:
```ts
// WKH-204 — namespace dispatch (mirror of verify.ts).
const network = parsed.accepted.network;
const namespace = network.substring(0, network.indexOf(':'));
if (namespace === 'solana') {
  if (!/^solana:(devnet|mainnet)$/u.test(network)) {
    return { ok: false, error: buildX402Error('NETWORK_MISMATCH',
      'network must be solana:<devnet|mainnet>') };
  }
  const lookup = chainRegistry.getAdapterByNetworkId(network);
  if (!lookup.ok) {
    return { ok: false, error: buildX402Error('CHAIN_UNAVAILABLE',
      'Network namespace recognized but no adapter registered') };
  }
  return lookup.adapter.settle(parsed as unknown as SettleParams);
}
// ── Step 0 cap check (con narrowing 'in') → Step 1..4 eip155 ACTUAL SIN TOCAR.
```
Y el cap check Step 0 pasa a (con el guard `!== undefined` de addendum 025-A — necesario porque en W3.1
`authorization` es opcional en el branch no-eip3009):
```ts
if (
  options?.maxAmountAtomic !== undefined &&
  'authorization' in parsed.payload &&
  parsed.payload.authorization !== undefined
) {
  const capCheck = checkSettleAmountCap(parsed.payload.authorization.value, options.maxAmountAtomic);
  if (!capCheck.ok) { /* ...idéntico... */ }
}
```
> Nota de orden: si implementás W2.2 ANTES de W3.1, el schema aún es objeto único y `authorization` está
> siempre presente → el guard `!== undefined` es inocuo (siempre true). Al llegar a W3.1 el guard se vuelve
> necesario para `tsc`. Dejalo puesto desde W2.2 para no re-tocar el archivo.

La duplicación deliberada del regex/dispatch entre verify.ts y settle.ts se MANTIENE (patrón settle.ts:29-32).
NO crear `src/core/network.ts`.

PROHIBIDO en W2: reescribir el cuerpo eip155; usar `as` en vez de narrowing `in` para el cap check; llamar
lógica Solana real (la rama `lookup.adapter.settle/verify` es inalcanzable en esta HU porque no hay adapter
solana registrado — es correcto que quede así).

**GATE W2:** `npm run typecheck` + `core.verify.test.ts` + `core.settle.test.ts` + `routes.*.test.ts` verde.

---

## Wave 3 — Schema discriminado + supported (depende de W0)

### W3.1 — schema union + ledger widening + cap-check guard (AC-5) — REESCRITA POR ADDENDUM 025-A

> ⚠️ Esta wave toca **3 archivos JUNTOS** (`schemas.ts` + `settle.ts` + `ledger.ts`). Los 3 cambios van
> en el mismo commit: ninguno solo deja `tsc` verde. Diseño **verificado con `tsc --strict` + zod runtime**
> (probes con la zod real del repo). NO improvises el branch no-eip3009 con `z.record` — reventó el F3.

#### W3.1.a — `src/core/schemas.ts`: `z.union` con branch no-eip3009 **tipado**

Usar `z.union` (NO `z.discriminatedUnion`: el discriminante `assetTransferMethod` vive anidado en
`accepted.extra`). Los imports ya presentes (`AddressHexSchema`, `Uint256StringSchema` desde
`../methods/eip3009/schemas.js`) alcanzan; no agregues imports nuevos salvo esos dos si no estuvieran.

```ts
// Branch eip3009 — BYTE-IDÉNTICO al schema actual (literal + PayloadSchema estricto).
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

// Payload placeholder no-eip3009: tipado por lo que el core LEE (from→ledger, value→cap-check),
// permissivo por passthrough. NO es el shape final de Solana (CD-3). NO usar z.record (CD-11).
const NonEip3009PayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u).optional(),
    authorization: z
      .object({ from: AddressHexSchema, value: Uint256StringSchema })
      .passthrough() // tolera to/validAfter/validBefore/nonce que T-V10/T-C5 inyectan
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

export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema]);
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
```

- `SettleRequestSchema = VerifyRequestSchema` y `type SettleRequest = VerifyRequest` se mantienen (alias intacto).
- `.extend({ extra: ... })` sobre un objeto `.strict()` **preserva `.strict()`** (verificado runtime: un body
  con unknown top-key da `success:false`). El `.extend` sobre `AcceptedExtraSchema` sobre-escribe solo
  `assetTransferMethod`.
- **Runtime verificado (7 fixtures):** body eip3009 → `true`; permit2 con payload eip3009-shaped → `true`
  (llega al method-guard, §4.5 caso 4 / T-V10 / T-C5); bad signature → `false`; amount `0100` → `false`
  (T-V5); unknown top-key → `false`; missing resource → `false` (T-V3); x402Version=1 → `false` (T-V2).
- CD-4: sin `any` ni `as unknown as` para el union. Solo `z.union` + `z.literal` + `z.enum` + `.passthrough()`.
- CD-11: PROHIBIDO `z.record` / `.passthrough()`-sin-`authorization` en el branch no-eip3009 (rompe el `in`).

#### W3.1.b — `src/core/settle.ts`: guard `!== undefined` en el cap-check

Si aún no lo dejaste puesto en W2.2, el cap-check Step 0 DEBE ser (byte-idéntico para eip3009):
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
Sin el `!== undefined`, `tsc` da **TS18048** (`authorization possibly undefined`) porque en el branch
no-eip3009 `authorization` es opcional.

#### W3.1.c — `src/core/ledger.ts`: widening del input + guard fail-closed

Es `src/core/*` (Scope IN, NO viola CD-2). Este cambio hace compilar `routes/settle.ts` (los 3 call sites de
`buildLedgerEntry` en `:283/:335/:382`) **SIN editar `routes/settle.ts`**.

1. En `interface BuildLedgerEntryInput`, `parsed.payload.authorization` pasa a **opcional**:
```ts
readonly payload: {
  // WKH-204 (addendum 025-A): opcional para aceptar el union VerifyRequest (el branch
  // no-eip3009 no garantiza authorization). Para todo payload eip3009 (los reales de esta
  // HU) authorization.from está presente → payer byte-idéntico.
  readonly authorization?: { readonly from: string };
};
```
2. En `buildLedgerEntry`, rama de fallo (~L137), guardear el read con fallback fail-closed:
```ts
// ANTES:  payer: input.parsed.payload.authorization.from,
payer: input.parsed.payload.authorization?.from ?? '',
```
- CD-10: PROHIBIDO dejar el read sin guard (TS18048) o usar `!` non-null. El `?? ''` es fail-closed: un
  payload sin `authorization` (inalcanzable esta HU) da `payer:''` (satisface `payer TEXT NOT NULL`) en vez
  de crashear; nunca inventa un payer. La rama success NO cambia (lee `input.result.from`).
- **AC-1:** los 843 tests (incl. `ledger.test.ts` T12/T13/T14 con `authorization.from` presente) DEBEN pasar
  sin tocar assertions. El widening es puramente aditivo a nivel de tipo; el comportamiento eip3009 es idéntico.

**Ripple a validar:** los route tests de rechazo de schema (`routes.verify.test.ts:316,335,354`) solo assertan
`code==='INVALID_PAYLOAD'` + http 400, NO el mensaje Zod exacto. Un body eip3009 malformado matchea primero
el branch `z.literal('eip3009')` → falla ahí → sigue INVALID_PAYLOAD. Correr `npm run qa` completo tras W3.1.
Si un test que asserta un MENSAJE Zod exacto rompe → PARAR y ESCALAR (no cambiar el assert).

### W3.2 — `src/core/supported.ts`
`getSupportedResponse()` lee métodos por-adapter con fallback:
```ts
methods: [...(meta.supportedMethods ?? CHAIN_METHODS_DEFAULT)],
```
Ningún adapter EVM setea `supportedMethods` → output **byte-idéntico** (`routes.supported.test.ts` verde por
AC-1). El resto de `supported.ts` (ducktype `getBreakerState` vía `getAdapter(meta.chainId)`) NO cambia — y
sigue funcionando porque `getAdapter` es el wrapper O(1) de W1.

PROHIBIDO en W3: setear `supportedMethods` en ningún adapter concreto; definir el payload shape final de
Solana; usar `z.discriminatedUnion`.

**GATE W3:** `npm run qa` completo.

---

## Wave 4 — Docs + tests nuevos (final)

### W4.1 — `OWNERS.md` nota `[4]`
Agregar nota `[4]` (siguiendo el formato de `[1]`/`[2]`/`[3]`) documentando el refactor namespace-agnóstico
autorizado de `core/` como excepción a la regla #1, origen **WKH-204 / HU-SOL-2**. Contenido clave: la KEY del
`ChainRegistry` ahora es `networkId: string` (no `ChainId` numérico); agregar una red = 1 archivo
`src/chains/<red>.ts` + 1 línea en registry con su `metadata.networkId`, SIN volver a tocar `core/`.

### W4.2 — Tests nuevos (mapeados 1:1 al SDD §11)

Patrón de fixtures/registro: `chainRegistry._resetForTesting()` + `chainRegistry.register(makeFakeAdapter(...))`
en `beforeEach`/`afterEach` (ver `core.verify.test.ts:73,138-144`). Test-first para la lógica de negocio.

| Test nuevo | AC | Archivo | Assertion exacta |
|-----------|----|---------|------------------|
| `solana:devnet` → `CHAIN_UNAVAILABLE` http 503 + message contiene "no adapter registered" | AC-3 | `core.verify.test.ts` (extender) | `res.ok===false`, `code==='CHAIN_UNAVAILABLE'`, `http===503` |
| `solana:mainnet` → `CHAIN_UNAVAILABLE` http 503 | AC-3 | `core.verify.test.ts` | idem |
| `solana:1` → `NETWORK_MISMATCH` http 400 (byte-idéntico) | AC-3 | ya cubierto por T-V6 — **NO tocar** | — |
| `solana:foo` → `NETWORK_MISMATCH` http 400 (cluster inválido) | AC-3 | `core.verify.test.ts` (nuevo) | `code==='NETWORK_MISMATCH'`, `http===400` |
| Mismos 3 casos para `settleCore` | AC-3 | `core.settle.test.ts` (extender) | idem; usar fixture eip3009 con `network` override |
| `SettlementAdapter` tipa `verify`/`settle` sin viem clients (type test / compilación) | AC-4 | `core.settle.test.ts` o test-types nuevo | objeto que implementa solo `metadata`+`verify`+`settle` es asignable a `SettlementAdapter`; `ChainAdapter extends SettlementAdapter` compila |
| Body método `permit2` con payload no-eip3009 valida OK; body eip3009 valida idéntico | AC-5 | `core.schemas.discriminated.test.ts` (CREAR) | `safeParse(eip3009Body).success===true`; `safeParse(permit2BodyConPayloadEip3009).success===true` (reusa `VALID_BODY.payload` — protege §4.5 caso4 / T-V10 / T-C5); body eip3009 malformado (bad sig / amount `0100`) `.success===false`; body con unknown top-key `.success===false` (`.strict()` preservado por `.extend`) |
| (opcional) ledger fail-closed sin `authorization` | AC-5/addendum | `ledger.test.ts` (extender) o el discriminated | `buildLedgerEntry` con `parsed.payload` SIN `authorization` (rama fallo) → `entry.payer===''` (documenta el guard `?? ''`). NO obligatorio; los T12/T13/T14 existentes NO se tocan (AC-1) |
| `getAdapterByNetworkId('eip155:2368')` hit; registro por networkId; `getAdapter(chainId)` O(1) equivalente; miss→400 | AC-6 | `chain-registry.test.ts` (extender) | `getAdapterByNetworkId` devuelve el mismo adapter que `getAdapter(asChainId(2368))`; miss → `code==='NETWORK_MISMATCH'` http 400 |

- Para AC-4 type test: recordá `import type * as X` (NO `typeof import()` inline — WFAC-148).
- Para el fixture solana en settle/verify: clonar `VALID_BODY` con `accepted.network` override (el resto del
  body eip3009 es irrelevante porque la rama solana retorna antes de tocar payload).

**GATE W4:** `npm run qa` completo — **833 tests existentes verde sin assertions tocadas + los nuevos**.

---

## 4. Decisión CHAIN_UNAVAILABLE (RATIFICADA — el Dev NO re-decide)

- Rama solana con cluster **válido** (`devnet`/`mainnet`) + sin adapter → `buildX402Error('CHAIN_UNAVAILABLE',
  'Network namespace recognized but no adapter registered')` → HTTP 503, **sin `retryAfterMs`** (sin
  Retry-After header).
- **NO agregar valores a `X402ErrorCode`.** Un código nuevo forzaría editar las route-local unions
  `VerifyRouteErrorCode`/`SettleRouteErrorCode` en `src/routes/*` → viola CD-2/CD-7. `CHAIN_UNAVAILABLE` ya
  existe y es semánticamente correcto.
- Cluster **inválido** (`solana:1`, `solana:foo`) → `NETWORK_MISMATCH` HTTP 400 (byte-idéntico a hoy).

---

## 5. Definition of Done

- [ ] `npm run qa` verde: `typecheck` strict 0 errores + `eslint --max-warnings 0` + `prettier --check`
      limpio + `vitest run`.
- [ ] Los **833 tests existentes pasan SIN una sola assertion tocada** (solo edits mecánicos de imports).
- [ ] Tests nuevos presentes y verdes: dispatch solana (verify+settle), `SettlementAdapter` type test,
      schema discriminado, `getAdapterByNetworkId`.
- [ ] `X402ErrorCode` NO tiene valores nuevos; `src/routes/*`, `src/middleware/*`, `src/infra/*` SIN cambios
      (CD-2). **`src/core/ledger.ts` SÍ tocado (widening del input + guard) — es `core/*`, permitido.**
- [ ] Cero código Solana real (ed25519/SPL/RPC/wallet) — CD-3. Cero dependencias nuevas.
- [ ] `_isValidAdapter` intacto; cuerpo eip155 de verify/settle textualmente intacto (CD-8).
- [ ] `OWNERS.md` con nota `[4]`.
- [ ] Branch no-eip3009 del union es **tipado** (`authorization?: {from,value}` + passthrough), NO `z.record`
      (CD-11); cap-check con guard `!== undefined` (CD del addendum); ledger widened + guard `?? ''` (CD-10).
- [ ] Ningún `any` / `as unknown as` NUEVO **para forzar el narrowing del union**. Los `as unknown as` de
      **dispatch al adapter** (2 en la rama solana de verify/settle + los 2 del cuerpo eip155) están
      sancionados (espejan el patrón VerifyRequest→VerifyParams existente; addendum 025-A §A.4).

> `src/chains/registry.ts` y `src/chains/types.ts` son money-moving-adjacent → **AR obligatorio** (CD-6) tras F3.
