# Auto-Blindaje — #026 / WKH-205 (HU-SOL-6, Solana adapter)

Errores cometidos durante F3 y su corrección. Protege futuras HUs del mismo fallo.

### [2026-07-21 20:30] Wave 4 — `import type * as X` usado como valor en runtime
- **Error**: en `solana-adapter.test.ts` importé el módulo mockeado con
  `import type * as SolanaDedup from '.../solana-dedup.js'` (siguiendo CD-11) y luego
  lo referencié como valor: `const dedup = SolanaDedup as unknown as {...}`. Al correr
  vitest: `SolanaDedup is not defined` → el test-file no cargaba (0 tests).
- **Causa raíz**: `import type` se BORRA en tiempo de compilación. CD-11 exige tipar
  el módulo dinámico con `import type * as X`, pero eso es SOLO para tipos — no da un
  binding de runtime. Para acceder a los spies mockeados se necesita un import de valor.
- **Fix**: cambiar a `import * as solanaDedupModule from '.../solana-dedup.js'` (runtime)
  + `const dedup = vi.mocked(solanaDedupModule)`. `vi.mocked` aporta el tipado de Mock sin
  violar CD-11 (no hay `typeof import()` inline). Los `.mockResolvedValue(...)` quedan tipados.
- **Aplicar en**: cualquier test que mockee un módulo con `vi.mock(...)` y necesite manipular
  los spies. Usar `import * as mod` (runtime) + `vi.mocked(mod)`. CD-11 (`import type * as X`)
  aplica cuando SOLO se necesitan los TIPOS del módulo, no sus valores/spies.

### [2026-07-21 20:45] Wave 4 — `no-secrets/no-secrets` sobre pubkeys base58 públicas
- **Error**: eslint `--max-warnings 0` marcó 5 errores `no-secrets/no-secrets` sobre los
  program-ids/mints base58 (SPL Token `Tokenkeg…`, Token-2022 `Tokenz…`, USDC `EPjF…`).
- **Causa raíz**: base58 de 32 bytes tiene entropía ~5.0, sobre el umbral del plugin.
  Los 0x-address hex EVM del repo no lo disparaban (menor entropía) → sin precedente de disable.
- **Fix**: `// eslint-disable-next-line no-secrets/no-secrets -- <reason>` en cada literal,
  con la razón explícita (identificador público on-chain, NO secreto). En `env.ts` el disable
  va sobre la línea `.default('Tokenkeg…')`.
- **Aplicar en**: cualquier código/test futuro que embeba pubkeys Solana base58 (mints,
  program-ids, ATAs). Anteponer el disable con `-- reason`. No usar vars de entorno para
  constantes públicas de protocolo (no son secretos).

### [2026-07-21 21:30] Fix-pack (3 MENORes AR/CR) — fidelidad del path de verificación
Resueltos en este fix-pack:
- **FIX-1 (CR-MNR-1)** `solana-adapter.ts` — el destino se seleccionaba con
  `post.find(e => e.owner === payTo)` (owner solo) → falso-negativo si el `payTo` tenía
  varios token-balances tocados. Ahora se busca por owner + mint (`this._mint`) + program-id
  pineado; fallback a first-by-owner SOLO para preservar los NETWORK_MISMATCH accionables
  (mint mismatch / unsupported program) sin debilitar el fail-safe. INVALID_RECEIVER si no
  hay ninguna entrada del owner.
- **FIX-2 (AR-MNR-1)** `solana-adapter.ts` — el ledger persistía `expectedAmount` pero la
  columna es "delta neto" (migrations/003:17,31). Ahora persiste el `delta` real
  (`postAmt - preAmt`). Gate de verificación intacto (`delta >= expectedAmount`).
- **FIX-3 (CR-MNR-3)** `solana-adapter.test.ts` — nuevo T-SOL-5b: `delta = expected-1` cerca
  de 2^53 (expected `9007199254740993`, delta `9007199254740992`) → RECHAZA (shortfall). Ejerce
  el borde de precisión BigInt del path del delta (un `Number()` accidental redondearía → pasaría).

### FOLLOW-UPS DIFERIDOS — resolver en la HU de wire-format (NO en este fix-pack)
- **CR-MNR-2** — el cluster se infiere por substring `'mainnet'` del RPC URL
  (`solana-adapter.ts` factory). Frágil (un RPC devnet con 'mainnet' en el host mal-clasifica).
  Resolver con env explícita `SOLANA_CLUSTER` en la HU de wire-format.
- **AR-MNR-2** — el flag `degraded` global (health/`anyChainDown`) incluiría al adapter Solana
  cuando esté opt-in-ON, sin probe real. Excluir adapters no-EVM de `anyChainDown` (o agregar
  probe real por adapter) en la HU de wire-format.
