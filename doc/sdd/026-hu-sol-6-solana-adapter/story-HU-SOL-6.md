# Story File — #026: Facilitator adaptador Solana (verify + dedup) [WKH-205 / HU-SOL-6]

> SDD: `doc/sdd/026-hu-sol-6-solana-adapter/sdd.md`
> Work Item: `doc/sdd/026-hu-sol-6-solana-adapter/work-item.md`
> Fecha: 2026-07-21
> Branch: `feat/026-wkh-205-solana-adapter`
> Modo: QUALITY + AR (money-adjacent: dedup durable + registry money-path)

---

## Goal

Registrar detrás de la interfaz `SettlementAdapter` (ya existe, WKH-204) un adaptador concreto
Solana (`src/chains/solana-adapter.ts`) que verifica una tx Solana ya **finalizada** sobre USDC-SPL:
compara el **mint por pubkey exacta**, deriva el monto del **delta neto de `pre/postTokenBalances`**
en `bigint`, exige `commitment:'finalized'`, y bloquea replays con un **`UNIQUE(signature)` durable
en Postgres fail-CLOSED**. El adapter es **opt-in-off por default** (sin env → no se registra), por lo
que la suite EVM completa debe quedar byte-idéntica en verde.

> Esta HU entrega el ADAPTER + dedup + registry generalizado, **unit-testeado vía `adapter.verify(...)`
> directo** (mock `Connection.getTransaction`). Solana NO es HTTP-reachable end-to-end todavía (el
> wire-format HTTP Zod está FUERA de scope, ver "Out of Scope"). Los 6 ACs son todos adapter-internos.

---

## 🛡️ Anti-Hallucination Header — LEER PRIMERO

### Baseline (verificado en F2.5)
- Gate del repo = `npm run qa` = `typecheck && lint (eslint --max-warnings 0) && format:check (prettier) && test (vitest run)`.
  **NO hay biome** (gotcha WFAC-148/024#gate). El único toolchain es ESLint + Prettier + tsc + Vitest.
- Baseline de tests: **~849 tests verdes** (843+ previos). Corré `npm run qa` ANTES de tocar nada (Wave -1).
- `@solana/web3.js` **NO** está en `package.json` hoy (confirmado F0). Se agrega en esta HU (Wave 0).

### REGLA DE ORO (AC-6 — no-regresión EVM)
1. **La suite EVM debe quedar verde SIN tocar assertions existentes.** El adapter es **opt-in-off**:
   sin `SOLANA_RPC_URL` + `SOLANA_USDC_MINT` no se registra → toda la suite EVM corre idéntica.
2. **`getAdapter(chainId)` DEBE seguir devolviendo `ChainAdapter`** (con `getPublicClient`/`getWalletClient`).
   Si tras Wave 0 el typecheck rompe CUALQUIER archivo fuera de `src/chains/registry.ts` (ej.
   `core/health-status.ts`, `chains/init-domain-check.ts`, `core/supported.ts`, `chains/init-breakers.ts`,
   `routes/*`) → **PARAR y ESCALAR** (lección 025#W3). No editar esos archivos.

### Prohibiciones globales (heredadas del SDD — inviolables)
- **CD-1**: PROHIBIDO comparar el asset Solana por símbolo/nombre/metadata. SOLO pubkey EXACTA del mint + program-id pin exacto.
- **CD-2**: PROHIBIDO derivar el monto de "contar instrucciones Transfer". SOLO delta neto de `pre/postTokenBalances` del destino.
- **CD-3**: PROHIBIDO `Number()`/`uiAmount` (float) en cualquier punto del cálculo de monto. SOLO `BigInt`/string decimal (u64 > 2^53).
- **CD-4**: PROHIBIDO fail-OPEN en el dedup Solana. `UNIQUE(signature)` es la barrera dura + `ok:false` del store → RECHAZO.
  **NO copiar** el fail-open EVM (`SETTLE_CAP_FAIL_MODE`/inflight-lock): el nonce on-chain que lo justifica en EVM NO existe aquí.
- **CD-5**: OBLIGATORIO `commitment:'finalized'` en toda lectura de tx Solana. Prohibido `confirmed`/`processed`.
- **CD-6**: OBLIGATORIO respetar OWNERS. El adapter lee `process.env` DIRECTO (NO importa `infra/env.ts`) y accede a Postgres
  SOLO vía `src/infra/solana-dedup.ts` (excepción `[5]`, NO importa `infra/supabase` directo).
- **CD-8**: PROHIBIDO agregar valores a `X402ErrorCode`. Solo REUSO (tabla de errores abajo). Si creés que hace falta uno nuevo → ESCALAR.
- **CD-9**: cualquier `select` supabase-js de `facilitator_solana_settlements.amount` DEBE castear `::text`. Reads de RPC `uiTokenAmount.amount` → `BigInt(...)` siempre (WKH-196).
- **CD-10**: iterar `pre/postTokenBalances` por acceso literal-keyed sobre interfaz tipada (`entry.owner`, `entry.mint`, `entry.uiTokenAmount.amount`) o `.find(...)/.filter(...)` sobre campos literales. NUNCA index dinámico `arr[i]` con `i` variable como sink (`security/detect-object-injection`, 023#W0).
- **CD-11**: en tests, tipar módulos dinámicos vía top-level `import type * as X from '...'`, nunca `typeof import('...')` inline.
- **DT-8**: `@solana/web3.js` **v1.x** (`^1`), NO v2. API classic `new Connection(url, 'finalized')` + `getTransaction(sig, { commitment, maxSupportedTransactionVersion:0 })`. Node >=22 (fetch global, sin polyfill).

---

## Acceptance Criteria (EARS — copiados del SDD/work-item)

- **AC-1** (mint-pubkey exacto + program-id pin): al verificar una tx Solana, comparar el mint pubkey de la ATA destino contra `SOLANA_USDC_MINT` por **igualdad EXACTA de pubkey** (nunca símbolo/nombre/metadata) Y validar que el program-id de la cuenta de token es el SPL Token Program clásico (`SOLANA_TOKEN_PROGRAM_ID`). Rechazar cualquier mint o program-id distinto (incl. mint falso mismo símbolo/decimales, o Token-2022).
- **AC-2** (monto por delta de balance): derivar el monto del **delta entre `meta.preTokenBalances` y `meta.postTokenBalances`** de la ATA destino (`payTo`) para el mint configurado. NUNCA asumir "exactamente una instrucción Transfer". Si una instrucción posterior vacía/retira fondos (transferencia compensatoria) → rechazar con el **delta neto real**, no con el crédito aislado.
- **AC-3** (precisión bigint): todo monto (`expectedAmount`, deltas, `accepted.amount`) como `bigint`/string decimal en TODO el pipeline. Al leer `pre/postTokenBalances[i].uiTokenAmount.amount` (strings de RPC) parsear con `BigInt(...)`, NUNCA `Number(...)` ni `uiAmount` (u64 > 2^53).
- **AC-4** (dedup durable fail-CLOSED): rechazar el replay leyendo de un **unique index Postgres** (no solo Redis) ANTES de aceptar. Redis/Postgres caído/latente → RECHAZO, NUNCA aceptación silenciosa de un duplicado.
- **AC-5** (commitment finalized): consultar la tx con `commitment:'finalized'` explícito. Tx no finalizada → no verificable (rechazo, sin reintento con commitment más débil).
- **AC-6** (no-crash / no-regresión EVM): registrar el adapter Solana junto a los EVM sin cambiar el comportamiento verify/settle de ningún `eip155:*` (suite EVM verde). Si `SOLANA_RPC_URL` o `SOLANA_USDC_MINT` no están seteados → omitir el registro (boot silencioso), no fallar el arranque.

---

## Contratos internos ⚠️ BLOQUEANTE

> Esta HU cruza el boundary adapter (`src/chains/*`) ↔ capa dedup (`src/infra/solana-dedup.ts`) ↔ Postgres.
> Estos contratos son load-bearing. Dev NO puede improvisar la forma del `Result`.

### `SolanaAdapter` implementa `SettlementAdapter` (de `src/chains/types.ts:137-161`)
```ts
interface SettlementAdapter {
  readonly metadata: ChainMetadata;
  verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>>;
  settle(params: SettleParams): Promise<AdapterResult<SettleResult>>;
  getBreakerState?(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined; // OMITIR (no hay CB Solana)
  setLogger?(logger: Logger): void;                                 // OMITIR o no-op
}
```
- `verify`/`settle` **NUNCA lanzan**: todo error → `AdapterResult` `{ ok:false, error:{ code, message, http } }` (contrato core/*).
- `VerifyResult`/`SettleResult` **NO se modifican** (shapes en `types.ts:99-122`). Los campos branded `Address`
  (`client`/`asset`/`payTo`/`from`/`to`) transportan pubkeys base58 para el namespace solana vía UN único
  `as unknown as Address` en el boundary de retorno (mismo patrón sancionado que `core/verify.ts:63`
  `parsed as unknown as VerifyParams`). `expiresAt = 0` (Solana verify es point-in-time). `signature` NO se
  agrega al shape público.

### `src/infra/solana-dedup.ts` — contrato fail-CLOSED (INVIERTE el null-handling del ledger EVM)
```ts
isSolanaSignatureSettled(signature: string): Promise<
  | { ok: true; settled: boolean }   // consulta OK (settled=true → ya settleada)
  | { ok: false }                    // no client / db error / timeout → EL CALLER DEBE RECHAZAR
>

recordSolanaSignature(entry: {
  signature: string; network: string; reference: string | null;
  mint: string; payTo: string; amount: string; // amount = decimal string atomic
}): Promise<
  | { ok: true; inserted: true }     // INSERT OK (primer settle)
  | { ok: true; inserted: false }    // UNIQUE violation (Postgres 23505) → DUPLICADO
  | { ok: false }                    // no client / db error → EL CALLER DEBE RECHAZAR
>
```
- `ok:false` **NUNCA** se traduce a "permitir". Es lo OPUESTO al swallow-to-allow del ledger EVM
  (`src/core/ledger.ts` trata `getSupabaseClient()===null` como no-op fail-open — Solana NO).
- El adapter mapea `ok:false` → `TRANSACTION_FAILED` (fail-closed) y `inserted:false`/`settled:true` → `TRANSACTION_FAILED` (duplicado).

---

## Tabla de mapeo de errores (REUSO puro — CERO valores nuevos en `X402ErrorCode`)

| Condición | Código X402 (existente) | HTTP | `message` (override) |
|-----------|------------------------|------|---------------------|
| mint ≠ `SOLANA_USDC_MINT` | `NETWORK_MISMATCH` | 400 | `"mint mismatch"` |
| program-id ≠ SPL Token classic (Token-2022, etc.) | `NETWORK_MISMATCH` | 400 | `"unsupported token program"` |
| reference ausente en la tx | `NETWORK_MISMATCH` | 400 | `"payment reference not found in tx"` |
| input malformado (base58/campos) | `NETWORK_MISMATCH` | 400 | `"invalid solana request"` |
| delta neto < monto esperado | `INVALID_AMOUNT` | 400 | `"net delta below accepted amount"` |
| payTo/ATA no coincide (owner destino) | `INVALID_RECEIVER` | 400 | `"receiver ATA mismatch"` |
| tx no encontrada / no finalizada | `TRANSACTION_FAILED` | 500 | `"tx not found or not finalized"` |
| tx on-chain `err ≠ null` | `TRANSACTION_FAILED` | 500 | `"on-chain tx failed"` |
| **duplicado / replay** (UNIQUE 23505 o SELECT settled) | `TRANSACTION_FAILED` | 500 | `"duplicate transaction — replay rejected"` |
| **dedup store no disponible** (fail-CLOSED) | `TRANSACTION_FAILED` | 500 | `"dedup store unavailable"` |

> Todos estos códigos YA existen en `X402ErrorCode` + ambas uniones route-local + ambos `Record` de `core/errors.ts`.
> → **CERO edits en `core/types.ts`, `core/errors.ts`, `routes/verify.ts`, `routes/settle.ts`.**

---

## Files to Modify/Create (Scope IN exhaustivo)

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `package.json` | Modificar | `npm install @solana/web3.js@^1` (v1.x, DT-8). Pinear versión resuelta (no `^` flotante en lockfile). | — |
| 2 | `src/infra/env.ts` | Modificar | Agregar 3 vars opt-in al schema Zod (ver Wave 0). NINGUNA en `.superRefine`. | `src/infra/env.ts:161-175` (`KITE_MAINNET_*`) |
| 3 | `src/chains/registry.ts` | Modificar | Generalizar Map→`SettlementAdapter`; `_isValidAdapter` base-shape; `getAdapter` con narrowing `_isChainAdapter` (ver Wave 0). | (self) |
| 4 | `OWNERS.md` | Modificar | Agregar excepción `[5]` (chains/solana-adapter ↔ infra/solana-dedup). | `OWNERS.md` nota `[4]` |
| 5 | `supabase/migrations/003_facilitator_solana_dedup.sql` | Crear | DDL tabla `facilitator_solana_settlements` + `UNIQUE(signature)` (ver Wave 1). | `supabase/migrations/001_facilitator_settlements.sql` |
| 6 | `src/infra/solana-dedup.ts` | Crear | `isSolanaSignatureSettled` + `recordSolanaSignature` fail-CLOSED, `::text` cast, detección `23505`. | `src/infra/supabase.ts`, `src/core/ledger.ts` |
| 7 | `src/chains/solana-adapter.ts` | Crear | `class SolanaAdapter implements SettlementAdapter` + `parseSolanaInput` + `verify()` + `settle()` + factory `solanaAdapter \| null`. | `src/chains/base-adapter.ts`, `src/chains/kite.ts` |
| 8 | `src/chains/index.ts` | Modificar | `if (solanaAdapter !== null) chainRegistry.register(solanaAdapter);`. | `src/chains/index.ts:36-40` |
| 9 | `src/__tests__/unit/chains/solana-adapter.test.ts` | Crear | Matriz T-SOL-1..13 + T-REG-1..4 (ver Wave 4). | `src/__tests__/unit/chain-registry.test.ts` |
| 10 | `src/__tests__/unit/solana-dedup.test.ts` | Crear | T-DEDUP-1..4 (mock supabase). | `src/__tests__/unit/supabase.test.ts`, `ledger.test.ts` |
| 11 | `src/__tests__/unit/chain-registry.test.ts` | Modificar (solo si rompe) | Ajustar SOLO asserts que dependían del shape viejo de `_isValidAdapter` (viem checks). NO relajar otros. | (self) |

**Cualquier otro archivo → FUERA DE SCOPE. Si necesitás tocarlo, PARÁ y escalá.**

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
node -v                 # debe ser >=22
npm run qa              # baseline: ~849 tests VERDE. Si rojo → PARAR y escalar (no arrancar sobre entorno roto)
ls src/chains/registry.ts src/chains/base-adapter.ts src/chains/index.ts \
   src/infra/supabase.ts src/core/ledger.ts src/infra/env.ts \
   supabase/migrations/001_facilitator_settlements.sql OWNERS.md   # todos deben existir
```
Si algo falla → PARAR y reportar al orquestador.

---

### Wave 0 — Deps + env + registry generalizado (SERIAL; EVM 100% verde, Solana AÚN NO registrado)

**W0.1 — `package.json`**: `npm install @solana/web3.js@^1`. Confirmá que resolvió a `1.x` (NO 2.x).

**W0.2 — `src/infra/env.ts`** (dentro del `z.object({...})`, junto a las otras opt-in ~línea 161-175):
```ts
    // WKH-205 — Solana adapter (opt-in). El adapter se registra en
    // src/chains/index.ts solo si SOLANA_RPC_URL y SOLANA_USDC_MINT están
    // presentes. NINGUNA en .superRefine (opt-in, no rompe boot testnet-only).
    SOLANA_RPC_URL: z.string().min(1).optional(),
    SOLANA_USDC_MINT: z.string().min(1).optional(),
    SOLANA_TOKEN_PROGRAM_ID: z
      .string()
      .min(1)
      .default('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token classic
```
> PROHIBIDO `z.coerce.boolean()`. PROHIBIDO agregarlas a cualquier `.superRefine`. El adapter NO importa este schema
> (boundary CD-6) — estas entradas son validación/documentación/fail-fast de formato.

**W0.3 — `src/chains/registry.ts`** (generalización sin ripple, DT-3 + CD-7):
- Cambiar el Map interno a `Map<string, SettlementAdapter>` (línea 28).
- `register(adapter: SettlementAdapter): RegisterResult` (acepta EVM y no-EVM).
- `_isValidAdapter` → validar SOLO shape base; **ELIMINAR** los checks `getPublicClient`/`getWalletClient`:
```ts
  private _isValidAdapter(candidate: SettlementAdapter): boolean {
    return (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof candidate.metadata === 'object' &&
      candidate.metadata !== null &&
      typeof candidate.metadata.chainId === 'number' &&
      typeof candidate.verify === 'function' &&
      typeof candidate.settle === 'function'
    );
  }
```
- `getAdapterByNetworkId(networkId)` → return type ensanchado a `{ ok:true; adapter: SettlementAdapter }` (rama error idéntica).
- `getAdapter(chainId)` → **conserva su contrato `{ ok:true; adapter: ChainAdapter }` byte-idéntico** vía narrowing
  duck-typed (NO un `as` a ciegas):
```ts
  private _isChainAdapter(a: SettlementAdapter): a is ChainAdapter {
    return (
      typeof (a as ChainAdapter).getPublicClient === 'function' &&
      typeof (a as ChainAdapter).getWalletClient === 'function'
    );
  }

  getAdapter(chainId: ChainId): /* { ok:true; adapter: ChainAdapter } | { ok:false; error } */ {
    const lookup = this.getAdapterByNetworkId(`eip155:${chainId}`);
    if (!lookup.ok) {
      return { ok: false, error: { code: 'NETWORK_MISMATCH', message: `Chain not registered: ${chainId}`, http: 400 } };
    }
    if (!this._isChainAdapter(lookup.adapter)) {
      // Jamás ocurre: un eip155:* siempre es ChainAdapter. Guard duck-typed → cast SANO + O(1).
      return { ok: false, error: { code: 'NETWORK_MISMATCH', message: `Chain not registered: ${chainId}`, http: 400 } };
    }
    return { ok: true, adapter: lookup.adapter };
  }
```
- Ajustar los `import type` (agregar `SettlementAdapter`).

**W0.4 — `OWNERS.md`**: agregar la excepción `[5]` (espejo del precedente `src/infra/wallet.ts` para `src/chains/*`):
> `[5]` `src/chains/solana-adapter.ts` MAY import `src/infra/solana-dedup.ts` (dedup durable Postgres del money-path
> no-EVM, análogo a `infra/wallet.ts` para el broadcast EVM). El adapter NO importa `infra/supabase` directo. Origen: WKH-205.

Y actualizá la fila de `src/chains/<chain>.ts` de la matriz para reflejar la nueva excepción.

**Gate W0**:
```bash
npm run typecheck   # DEBE pasar SIN editar archivos fuera de registry.ts. Si rompe health-status/init-domain-check/
                    # supported/init-breakers/routes → PARAR y ESCALAR (CD-7 / 025#W3). NO editar esos archivos.
npm run test        # suite EVM verde. chain-registry.test.ts: ajustar SOLO asserts del shape viejo de _isValidAdapter.
```
**PROHIBIDO en W0**: crear el adapter todavía; agregar Solana al registro; tocar `core/*`, `routes/*`.

---

### Wave 1 — Migración dedup + capa `infra/solana-dedup.ts`

**W1.1 — `supabase/migrations/003_facilitator_solana_dedup.sql`** (copiá literal del SDD §7):
```sql
-- supabase/migrations/003_facilitator_solana_dedup.sql
-- WKH-205 / HU-SOL-6 — Durable anti-replay + settlement ledger para Solana verify-only.
-- Idempotente: safe to re-run. Do NOT edit once pushed — create follow-up migration.
--
-- Barrera dura anti-double-spend: UNIQUE(signature). A diferencia de EVM (nonce
-- on-chain revierte el replay), Solana verify-only NO tiene backstop on-chain →
-- este UNIQUE es la única línea de defensa (CD-4, fail-CLOSED en app-layer).
-- La tabla es DUAL: dedup mark + settlement ledger Solana (DT-5). Sin PII.

CREATE TABLE IF NOT EXISTS facilitator_solana_settlements (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  signature   TEXT          NOT NULL UNIQUE,   -- firma base58 de la tx (id inmutable on-chain)
  network     TEXT          NOT NULL,          -- 'solana:devnet' | 'solana:mainnet'
  reference   TEXT          NULL,              -- Solana Pay reference (pubkey base58), opcional
  mint        TEXT          NOT NULL,          -- SPL mint pubkey base58 (== SOLANA_USDC_MINT)
  pay_to      TEXT          NOT NULL,          -- owner/ATA destino (pubkey base58)
  amount      NUMERIC(78,0) NOT NULL,          -- delta neto atomic u64 (uint256-safe; leer con ::text — CD-9)
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fss_created_at ON facilitator_solana_settlements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fss_network    ON facilitator_solana_settlements (network);
CREATE INDEX IF NOT EXISTS idx_fss_reference  ON facilitator_solana_settlements (reference)
  WHERE reference IS NOT NULL;

COMMENT ON TABLE  facilitator_solana_settlements IS
  'WKH-205: dedup durable (UNIQUE signature) + settlement ledger Solana verify-only. Fail-CLOSED app-layer. No PII.';
COMMENT ON COLUMN facilitator_solana_settlements.signature IS
  'Firma base58 de la tx Solana. UNIQUE = barrera anti-replay (no hay nonce on-chain que la sustituya).';
COMMENT ON COLUMN facilitator_solana_settlements.amount IS
  'Delta neto atomic (u64). NUMERIC(78,0). Leer SIEMPRE con ::text cast (precision-loss >2^53 — WKH-196).';
```

**W1.2 — `src/infra/solana-dedup.ts`** (capa infra → PUEDE importar `getSupabaseClient` de `infra/supabase`).
Contrato exacto en "Contratos internos" arriba. Reglas:
- `isSolanaSignatureSettled(signature)`: `getSupabaseClient()` → si `null` → `{ ok:false }` (**fail-CLOSED**, invierte ledger EVM).
  `SELECT signature FROM facilitator_solana_settlements WHERE signature = ...` (`.maybeSingle()`). Error de query → `{ ok:false }`.
  fila presente → `{ ok:true, settled:true }`; ausente → `{ ok:true, settled:false }`.
  Si algún `select` futuro lee `amount` → castear `::text` (CD-9); este SELECT NO lo lee.
- `recordSolanaSignature(entry)`: `getSupabaseClient()` → `null` → `{ ok:false }`. `INSERT` (NO upsert-ignore) de la fila
  (`amount` como string decimal). Detectar UNIQUE violation por **Postgres code `23505`** (en el `error.code` de supabase-js)
  → `{ ok:true, inserted:false }`. Insert OK → `{ ok:true, inserted:true }`. Cualquier otro error → `{ ok:false }` (fail-CLOSED).
- Boundary: este archivo (`src/infra/*`) puede importar `infra/supabase`. NO importa `src/chains/*` ni `src/core/*`.
- Logger opcional inyectable estilo `Pick<Logger,'warn'|'debug'>` (como `ledger.ts`), sin PII en stdout.

**Gate W1**:
```bash
npm run typecheck && npm run test   # + los T-DEDUP-1..4 nuevos verdes. EVM verde.
```

---

### Wave 2 — `SolanaAdapter.verify()`

**W2.1 — `src/chains/solana-adapter.ts`**. Estructura (seguir `base-adapter.ts` + `kite.ts`):
- `import { Connection, PublicKey } from '@solana/web3.js';` + `import type { AdapterResult, ChainMetadata, SettlementAdapter, VerifyParams, VerifyResult, SettleParams, SettleResult } from './types.js';` + `import { asChainId } from '../core/types.js';` (type-only OK) + `import { isSolanaSignatureSettled, recordSolanaSignature } from '../infra/solana-dedup.js';` (excepción `[5]`).
- **NO importar** `infra/env.ts` ni `infra/supabase.ts` (CD-6).
- **Config por `process.env` DIRECTO** dentro del factory/constructor (patrón `base-adapter.ts:99-105`):
  `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`, `SOLANA_TOKEN_PROGRAM_ID` (default `'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'`).
- **DI (DT-9)**: constructor recibe `connection?: Connection`. En prod construye `new Connection(rpcUrl, 'finalized')`.
  Tests inyectan un fake con `getTransaction` mockeado. NUNCA red en tests.
- `metadata: ChainMetadata`: `networkId = 'solana:' + cluster` (`devnet`/`mainnet`), `chainId` sintético documentado
  (número — requerido por el shape; documentá que no es un chainId EVM), `network: cluster==='mainnet'?'mainnet':'testnet'`,
  `tokens: []` o `[{ address: mint as unknown as Address, ... }]` (documentá el cast; el mint es base58, no 0x).
- `parseSolanaInput(params): AdapterResult<SolanaInput>`: extrae `network` (`params.accepted.network`),
  `expectedMint` (`params.accepted.asset`), `payTo` (`params.accepted.payTo`), `expectedAmount = BigInt(params.accepted.amount)`,
  `signature` y `reference` (de `params.payload`). Validar base58 (`new PublicKey(x)` en try/catch, o regex base58).
  Malformado → `NETWORK_MISMATCH` `"invalid solana request"`.

**`verify()` — algoritmo (§4 del SDD, pasos 1-9). Devuelve `AdapterResult`, NUNCA lanza:**
1. `const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });`
   `tx === null` → `TRANSACTION_FAILED` `"tx not found or not finalized"`. **PROHIBIDO** reintentar con `confirmed`/`processed` (CD-5).
2. `tx.meta?.err !== null` → `TRANSACTION_FAILED` `"on-chain tx failed"`.
3. **program-id pin** (AC-1, CD-1): el `programId` del token-balance destino DEBE `=== SOLANA_TOKEN_PROGRAM_ID`
   (igualdad exacta de pubkey). Token-2022/otro → `NETWORK_MISMATCH` `"unsupported token program"`.
4. **mint exacto** (AC-1, CD-1): el `mint` del token-balance destino DEBE `=== expectedMint` por igualdad EXACTA
   (`PublicKey.equals` o string base58 exacto). NUNCA símbolo/nombre/decimales. Mismatch → `NETWORK_MISMATCH` `"mint mismatch"`.
5. **delta neto** (AC-2, AC-3, CD-2, CD-3, CD-10): de `meta.preTokenBalances` y `meta.postTokenBalances` seleccionar
   (con `.find(...)` sobre campos literales `entry.owner === payTo && entry.mint === expectedMint && entry.programId === SOLANA_TOKEN_PROGRAM_ID`,
   NUNCA `arr[i]` dinámico) el entry destino. `const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;`
   `const postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n;` `const delta = postAmt - preAmt;`.
   **`delta` es neto sobre TODA la tx** (una ix compensatoria posterior ya se refleja). NUNCA "contar Transfers", NUNCA `Number`/`uiAmount`.
   Si no hay ningún token-balance destino (owner===payTo) → `INVALID_RECEIVER` `"receiver ATA mismatch"`.
6. **monto suficiente** (AC-2): `delta < expectedAmount` → `INVALID_AMOUNT` `"net delta below accepted amount"`.
7. **reference match**: `reference` DEBE aparecer en las account keys de la tx
   (`tx.transaction.message.getAccountKeys()` / `staticAccountKeys`). Ausente → `NETWORK_MISMATCH` `"payment reference not found in tx"`.
8. **dedup SELECT** (AC-4, CD-4): `const d = await isSolanaSignatureSettled(signature);`
   `d.ok === false` → **fail-CLOSED** → `TRANSACTION_FAILED` `"dedup store unavailable"`.
   `d.settled === true` → replay → `TRANSACTION_FAILED` `"duplicate transaction — replay rejected"`.
   `settled === false` → continuar. **verify NO inserta** (repetible para firmas no-settled).
9. **éxito**: devolver `VerifyResult` con base58 en campos string (UN único `as unknown as Address` en el retorno),
   `amount: expectedAmount.toString()`, `network`, `expiresAt: 0`, `verified: true`, `client`/`payTo`/`asset` = pubkeys base58.

- **SIN circuit breaker** (el CB actual es EVM-específico vía `ChainCircuitBreaker`; extenderlo es Scope OUT).
- Acceso a `preTokenBalances/postTokenBalances`: tipar el shape (o usar los tipos de `@solana/web3.js`) y acceder por
  campo literal (CD-10). Si hace falta un `eslint-disable` para una clave FIJA no atacante-controlada, agregá el `-- reason`.

**W2.2 — factory opt-in (DT-11)** al final del archivo (patrón `kite.ts:202-220`):
```ts
export const solanaAdapter: SolanaAdapter | null = (() => {
  const rpcUrl = process.env['SOLANA_RPC_URL'];
  const mint = process.env['SOLANA_USDC_MINT'];
  if (!rpcUrl || !mint) return null; // opt-in-off por default (AC-6)
  try {
    return new SolanaAdapter({ rpcUrl, mint, /* programId con default, cluster */ });
  } catch {
    return null;
  }
})();
```
> Sin `SOLANA_RPC_URL` **y** `SOLANA_USDC_MINT` → `null` → no se registra → suite EVM idéntica.

**Gate W2**: `npm run typecheck && npm run test` + tests `verify` (T-SOL-1/2/3/4/5/6/7/8/12/13). EVM verde.
**PROHIBIDO en W2**: registrar el adapter todavía (eso es W3); implementar `settle()` todavía.

---

### Wave 3 — `settle()` + registro opt-in

**W3.1 — `SolanaAdapter.settle()`** (DT-5): la tabla dedup ES el ledger.
1. Corre la validación completa de `verify()` (pasos 1-9). Si verify falla → devolver ese error verbatim (no persiste).
2. Si verify OK → `const r = await recordSolanaSignature({ signature, network, reference, mint: expectedMint, payTo, amount: expectedAmount.toString() });`
   - `r.ok && r.inserted` → éxito → devolver `SettleResult` (shape reusado): `settled:true`, `transactionHash` = signature
     (`as unknown as \`0x${string}\``, documentado), `blockNumber` (de `tx.slot`/`0`), `amount`, `from`/`to`/`asset` base58 base58.
   - `r.ok && !r.inserted` (UNIQUE 23505) → **duplicado** → `TRANSACTION_FAILED` `"duplicate transaction — replay rejected"`.
   - `r.ok === false` → **fail-CLOSED** → `TRANSACTION_FAILED` `"dedup store unavailable"`.
- La barrera atómica real es el INSERT en `settle` (serializa dos settles concurrentes: el 2º choca con UNIQUE).
- NO tocar `core/ledger.ts` ni `facilitator_settlements` (EVM).

**W3.2 — `src/chains/index.ts`**: agregar el import + la línea de registro opt-in (patrón línea 36-40):
```ts
import { solanaAdapter } from './solana-adapter.js';
// ...
if (solanaAdapter !== null) chainRegistry.register(solanaAdapter);
```

**Gate W3**: `npm run typecheck && npm run test` + tests `settle` (T-SOL-9/10/11) + registro simultáneo EVM+Solana
(`getAdapter(43113)` intacto → `ChainAdapter` con `getPublicClient`; `getAdapterByNetworkId('solana:devnet')` resuelve). EVM verde.

---

### Wave 4 — Matriz de tests por AC + regresión EVM

**W4.1 — `src/__tests__/unit/chains/solana-adapter.test.ts`** (mock `Connection.getTransaction` vía DI;
mock `infra/solana-dedup` vía `vi.mock('../../../infra/solana-dedup.js')`, ajustá la profundidad relativa real).
Tipar el módulo mockeado con `import type * as SolanaDedup from '...'` top-level (CD-11), nunca `typeof import()` inline.

| Test | AC/CD | Vector | Espera |
|------|-------|--------|--------|
| T-SOL-1 happy verify | AC-1,2,3,5 | tx finalizada, mint correcto, delta≥monto, reference presente, no-settled | `ok:true`, amount correcto |
| T-SOL-2 mint falso mismo símbolo | AC-1, CD-1 | token-balance con mint distinto (símbolo "USDC" clonado) | `NETWORK_MISMATCH` `"mint mismatch"` |
| T-SOL-3 program-id Token-2022 | AC-1, CD-1 | `programId` = `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `NETWORK_MISMATCH` `"unsupported token program"` |
| T-SOL-4 delta neto con compensatoria | AC-2, CD-2 | crédito X + débito posterior de la ATA → delta neto < monto | `INVALID_AMOUNT` (rechaza con el neto real, no el crédito aislado) |
| T-SOL-5 u64 > 2^53 | AC-3, CD-3 | `uiTokenAmount.amount = "18446744073709551615"` (u64 max) | parseo BigInt exacto, sin pérdida; comparación correcta |
| T-SOL-6 no finalizada / null | AC-5, CD-5 | `getTransaction` → null; y variante `meta.err ≠ null`; assert que se pidió `commitment:'finalized'` | `TRANSACTION_FAILED` |
| T-SOL-7 replay (SELECT settled) | AC-4, CD-4 | `isSolanaSignatureSettled` → `{ok:true,settled:true}` | `TRANSACTION_FAILED` `"duplicate transaction — replay rejected"` |
| T-SOL-8 dedup store outage (verify) | AC-4, CD-4 | `isSolanaSignatureSettled` → `{ok:false}` | fail-CLOSED → `TRANSACTION_FAILED` `"dedup store unavailable"` (NUNCA acepta) |
| T-SOL-9 settle happy | AC-4, DT-5 | verify OK + `recordSolanaSignature` → `{ok:true,inserted:true}` | `SettleResult` ok |
| T-SOL-10 settle replay UNIQUE | AC-4, CD-4, DT-5 | `recordSolanaSignature` → `{ok:true,inserted:false}` (23505) | `TRANSACTION_FAILED` duplicado |
| T-SOL-11 settle store outage | AC-4, CD-4 | `recordSolanaSignature` → `{ok:false}` | fail-CLOSED reject |
| T-SOL-12 reference ausente | binding | reference no está en accountKeys | `NETWORK_MISMATCH` `"payment reference not found in tx"` |
| T-SOL-13 payTo/ATA mismatch | receiver | ningún token-balance con owner===payTo | `INVALID_RECEIVER` `"receiver ATA mismatch"` |
| T-REG-1 registry base-shape | AC-6, DT-3 | `_isValidAdapter` acepta `SettlementAdapter` puro (sin viem clients) | `register` ok |
| T-REG-2 getAdapter EVM intacto | AC-6, CD-7 | `getAdapter(43113)` con Fuji registrado | devuelve `ChainAdapter` con `getPublicClient` |
| T-REG-3 EVM+Solana simultáneos | AC-6 | registrar Fuji + Solana; `getAdapterByNetworkId('solana:devnet')` | resuelve Solana; EVM sin cambio |
| T-REG-4 regresión suite EVM | AC-6 | toda la suite previa | verde byte-idéntica (Solana opt-in-off por default) |

**W4.2 — `src/__tests__/unit/solana-dedup.test.ts`** (mock supabase, patrón `supabase.test.ts`/`ledger.test.ts`):

| Test | Vector | Espera |
|------|--------|--------|
| T-DEDUP-1 insert OK | `getSupabaseClient` mock, insert sin error | `{ok:true,inserted:true}` |
| T-DEDUP-2 UNIQUE violation | error con code `23505` | `{ok:true,inserted:false}` |
| T-DEDUP-3 null client | `getSupabaseClient` → `null` | `{ok:false}` (fail-CLOSED) para ambas funciones |
| T-DEDUP-4 db error genérico | error code ≠ 23505 | `{ok:false}` (fail-CLOSED); y SELECT settled/not-settled OK |

**W4.3 — `src/__tests__/unit/chain-registry.test.ts`**: agregar T-REG con ambos rails; ajustar SOLO asserts que
dependían del shape viejo de `_isValidAdapter` (si un test asertaba que un adapter SIN viem clients era inválido, ya no aplica).

**Gate W4 (FINAL)**:
```bash
npm run qa   # typecheck + lint (--max-warnings 0) + format:check + test — TODO VERDE
```

---

## Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W-1 | `npm run qa` baseline verde (~849) |
| W0 | `npm run typecheck` sin ripple fuera de `registry.ts` + `npm run test` EVM verde |
| W1 | `npm run typecheck && npm run test` + T-DEDUP-* verde |
| W2 | `npm run typecheck && npm run test` + T-SOL verify verde |
| W3 | `npm run typecheck && npm run test` + T-SOL settle + registro simultáneo verde |
| W4 | `npm run qa` completo verde |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- **Wire-format HTTP Solana** (`src/core/schemas.ts` / `VerifyRequestSchema` / `AcceptedSchema`): FUERA de scope (SDD §8).
  `asset`/`payTo` exigen `AddressHexSchema` (0x-hex) hoy; extenderlo ripplea a `routes/settle.ts` vía `buildLedgerEntry`
  (bug de 025#W3). Solana NO es HTTP-reachable e2e en esta HU — se testea vía `adapter.verify(...)` directo.
- `src/core/verify.ts`, `src/core/settle.ts` (la rama `solana:` YA existe — NO se modifica).
- `src/core/types.ts`, `src/core/errors.ts` (`X402ErrorCode` — CERO valores nuevos, CD-8).
- `src/routes/verify.ts`, `src/routes/settle.ts` (uniones route-local ya tienen los 4 códigos reusados).
- `src/core/ledger.ts`, `facilitator_settlements`, `src/core/idempotency.ts` (Redis EVM — se conserva como cache).
- `src/chains/base-adapter.ts`, `kite.ts`, `avalanche.ts`, `base.ts`, `circuit-breaker.ts` (EVM intactos).
- `core/health-status.ts`, `chains/init-domain-check.ts`, `core/supported.ts`, `chains/init-breakers.ts` (si el
  typecheck los toca → ES un ripple → PARAR y ESCALAR, NO editarlos).
- NO agregar dependencias fuera de `@solana/web3.js@^1`. NO "mejorar" código adyacente. NO refactors no pedidos.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar, no asumir, no improvisar.**

Escalá inmediatamente si:
- Tras W0 el `npm run typecheck` rompe CUALQUIER archivo fuera de `src/chains/registry.ts` (ripple de tipos — 025#W3).
- Sentís la necesidad de agregar un valor a `X402ErrorCode` (CD-8).
- La API de `@solana/web3.js` v1 que necesitás (`getTransaction`, `getAccountKeys`, `preTokenBalances`) no matchea lo
  documentado acá, o `npm install` resuelve a 2.x.
- El shape de `preTokenBalances`/`postTokenBalances` del tipo de `@solana/web3.js` no expone `owner`/`mint`/`programId`/`uiTokenAmount.amount` como se asume.
- Un exemplar referenciado ya no existe o cambió.
- Cualquier cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

## Done Definition

- [ ] `npm run qa` VERDE: `typecheck` + `lint (--max-warnings 0)` + `format:check` + `test` (vitest).
- [ ] Suite EVM byte-idéntica en verde (AC-6) — sin tocar assertions EVM; Solana opt-in-off por default.
- [ ] Migración `003_facilitator_solana_dedup.sql` creada con `UNIQUE(signature)` + `amount NUMERIC(78,0)`.
- [ ] `getAdapter(chainId)` sigue devolviendo `ChainAdapter` (narrowing `_isChainAdapter`, O(1) EVM preservado).
- [ ] `X402ErrorCode` SIN cambios (reuso puro — tabla de errores).
- [ ] `OWNERS.md` con excepción `[5]` (chains/solana-adapter ↔ infra/solana-dedup).
- [ ] Dedup fail-CLOSED verificado por tests (T-SOL-8/11, T-DEDUP-3/4): `ok:false` → RECHAZO, nunca aceptar.
- [ ] Mint por pubkey EXACTA (T-SOL-2/3), monto por delta BigInt (T-SOL-4/5), `commitment:'finalized'` (T-SOL-6), replay bloqueado (T-SOL-7/10).
- [ ] ≥1 test por AC + los 6 vectores de ataque (mint falso, tx compensatoria, u64 max, replay, store-outage, sin finalized).

---

*Story File generado por NexusAgil — F2.5 (Architect). Dev ejecuta wave por wave SIN re-decidir arquitectura.*
