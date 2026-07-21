# Work Item — [WKH-204 / HU-SOL-2] (alias interno: WFAC-TBD / HU-SOL-F1) Facilitator multi-red: generalizar dispatch EVM-only → orquestador por namespace de red

> **Nota de trazabilidad (2026-07-21, nexus-analyst)**: este work-item fue creado 2026-07-20 bajo el
> alias local `HU-SOL-F1` / `WFAC-TBD`. El orquestador re-referencia la misma HU como `WKH-204` /
> `HU-SOL-2` (Sprint 1 — Fundación del roadmap Solana LATAM Labs). Es la MISMA pieza de trabajo — se
> verificó por grounding (archivo:línea) que el contenido de este work-item sigue matchando byte-a-byte
> el estado actual de `src/core/verify.ts`, `src/core/settle.ts`, `src/chains/registry.ts`,
> `src/chains/types.ts`, `src/core/schemas.ts`, `OWNERS.md` — CERO drift desde su redacción. Por eso NO
> se creó un NNN duplicado (`026-...`): habría forkeado el estado de una misma HU en dos IDs distintos
> y arriesgado que dos pipelines toquen `src/core/*` en paralelo sobre el mismo refactor. Este archivo
> queda como la única fuente de verdad F1 para WKH-204/HU-SOL-2. `doc/sdd/_INDEX.md` fila 025 fue
> actualizada con el alias.

## Resumen

Generalizamos el core del facilitator (`verify`/`settle`/`registry`/`schemas`/`supported`) de
"EVM-only, keyed por `chainId` numérico vía `eip155:<chainId>`" a "multi-red, keyed por
namespace de red (`eip155:` | `solana:` | futuros)". Es la fundación de abstracción para el
programa Solana LATAM Labs: portamos la arquitectura no-custodial de remesa (ya validada en EVM)
a Solana como nueva red. Esta HU **NO** implementa el adapter Solana concreto (eso es HU-SOL-F2 /
HU-SOL-6) — solo abre el slot y prueba que un `network: "solana:..."` rutea sin crashear, con el
path EVM 100% byte-idéntico (regresión cero).

## Sizing

- SDD_MODE: full
- Modo NexusAgil: QUALITY
- Estimación: M
- Branch sugerido: `feat/025-hu-sol-f1-facilitator-multichain` (ya usado; alternativa equivalente
  `feat/204-wkh-facilitator-multichain` si el orquestador prefiere el prefijo WKH — mismo contenido)

## Acceptance Criteria (EARS)

- **AC-1 (regresión EVM — CENTRAL)**: WHILE el path de red `eip155:<chainId>` con método
  `eip3009` se ejecuta contra `verifyCore`/`settleCore`, the system SHALL producir exactamente
  el mismo comportamiento observable (mismos códigos de error x402, mismos HTTP status, mismo
  `Result<T>` shape, mismo orden de checks: regex → overflow guard → method guard → registry
  lookup → dispatch a adapter) que antes de esta HU. Toda la suite de tests existente
  (`src/__tests__/unit/core.verify.test.ts`, `core.settle.test.ts`, `chain-registry.test.ts`,
  `routes.verify.test.ts`, `routes.settle.test.ts`, `routes.supported.test.ts`,
  `chains.kite.domain-check.test.ts`, `chains.avalanche.domain-check.test.ts`,
  `chains.domain-check.multi.test.ts`, `core/network.test.ts`, y el resto de
  `src/__tests__/unit/**` — 55 archivos de test verificados vía Glob el 2026-07-21) SHALL pasar
  **sin modificar sus expectativas** (edits permitidos solo si son mecánicos por el refactor de
  tipos, ej. imports; CERO cambio de assertion de comportamiento).

- **AC-2 (namespace routing genérico)**: WHEN `verifyCore`/`settleCore` recibe un
  `accepted.network` que matchea el namespace `eip155:` (regex vigente,
  `src/core/verify.ts:37` / `src/core/settle.ts:33`), the system SHALL rutear por el mismo path
  numérico `ChainId` que hoy (chain-adaptive intacto, `src/chains/registry.ts`).

- **AC-3 (slot no-EVM sin crash)**: WHEN `verifyCore`/`settleCore` recibe un `accepted.network`
  con namespace `solana:<algo>` (formato exacto a definir en F2, ej. `solana:<genesisHash>` por
  CAIP-2), the system SHALL retornar un `Result<T>` con `ok: false` y un código de error x402
  existente (ver Missing Inputs — el código exacto es decisión de F2) con `http` en el rango
  4xx/5xx apropiado — **NUNCA** un throw sin capturar, `undefined` de un `.get()` no chequeado, ni
  un 500 no estructurado. El mensaje SHALL indicar claramente que la red es reconocida pero no
  tiene adapter registrado (no confundir con "network inválida").

- **AC-4 (interfaz verify-only)**: the system SHALL exponer una interfaz de adapter (nueva o
  variante de `ChainAdapter`) que permita implementar `verify()` sin requerir `getPublicClient()`
  / `getWalletClient()` (viem-shaped) — redes donde la wallet del cliente auto-envía la
  transacción (ej. Solana) no tienen un "operator wallet que hace broadcast" en el mismo sentido
  EVM. Esta HU define y tipa la interfaz; NO la implementa con un adapter real.

- **AC-5 (schema discrimina por método)**: WHEN `src/core/schemas.ts` valida un payload con
  `accepted.extra.assetTransferMethod !== 'eip3009'`, the system SHALL permitir (a nivel de tipo
  y de validación Zod) formas de `payload` no-EVM (ej. sin `signature: 0x...` / sin
  `authorization` EIP-3009 shape) sin romper el narrowing existente del path `eip3009`. Esta HU
  discrimina el schema; NO define el payload shape final de Solana (eso es HU-SOL-F2).

- **AC-6 (registry indexable por networkId string)**: the system SHALL permitir que
  `ChainRegistry` (o un registry hermano) indexe adapters por un identificador de red que NO sea
  necesariamente un `ChainId` numérico (ej. `networkId: string` tipo `"solana:<hash>"`), sin
  romper el `getSupportedChainIds()` / `listAdapters()` / `/supported` existentes para EVM.

## Scope IN

- `src/core/verify.ts` — generalizar el parsing de `accepted.network` de regex EVM-only a
  dispatch por namespace (prefijo antes de `:`).
- `src/core/settle.ts` — espejo del cambio anterior (hoy duplica el regex a propósito, ver
  comentario `src/core/settle.ts:29-32`).
- `src/chains/registry.ts` — generalizar el keying (hoy `Map<ChainId, ChainAdapter>`) para
  soportar un identificador de red no-numérico, preservando compat EVM.
- `src/chains/types.ts` — nueva interfaz `SettlementAdapter` (o variante) verify-only, sin
  `getPublicClient`/`getWalletClient` obligatorios; posible ajuste de `ChainAdapter` a interfaz
  base + extensión EVM.
- `src/core/schemas.ts` — discriminar el Zod schema del `payload` por
  `accepted.extra.assetTransferMethod` (hoy fuerza shape EIP-3009 siempre).
- `src/core/supported.ts` — dejar de asumir `CHAIN_METHODS_DEFAULT = ['eip3009']` global; los
  métodos soportados deben poder variar por adapter/red (aunque en esta HU solo exista el adapter
  EVM real).
- `src/core/types.ts` — si aplica, tipos compartidos nuevos (`NetworkId`, namespace union, etc.)
  SIN romper `ChainId` existente.
- `OWNERS.md` — agregar la nota explícita del refactor único autorizado de `core/` (namespace-
  agnóstico) como excepción documentada a la regla #1, con origen en esta HU.
- Tests: extender/crear tests unitarios para los nuevos paths de dispatch (namespace `solana:`
  → NOT_IMPLEMENTED-equivalente; regresión EVM byte-idéntica).

## Scope OUT

- **El adaptador Solana concreto** (verify/settle real, RPC Solana, wallet Solana) — HU-SOL-F2 /
  HU-SOL-6.
- Cualquier lógica de verificación de transacción Solana (parsing de tx, SPL-token transfer
  checks, firma ed25519, etc.) — HU-SOL-F2 / HU-SOL-6.
- Verificación on-chain real de Solana — HU-SOL-6.
- Gasless fee-payer de Solana — HU-SOL-14.
- Cambios a `src/routes/*`, `src/middleware/*`, `src/infra/*` — capas transversales (auth,
  rate-limit, idempotencia, audit, ledger, métricas) quedan intactas; cualquier adapter que entre
  por `POST /settle` las hereda sin cambios.
- Nuevo `X402ErrorCode` definitivo para "adapter no implementado" — se decide en F2 (puede
  reusar `NETWORK_MISMATCH` o agregar uno nuevo; ver Missing Inputs).
- Formato final del CAIP-2 / networkId de Solana (`solana:<genesisHash>` vs otro esquema) — F2.
- Documentación pública (`openapi.yaml`, `doc/architecture/X402-CONFORMANCE.md`) — se actualiza
  cuando el adapter Solana real exista (HU-SOL-6), no en esta HU de abstracción pura.
- Cualquier chain EVM nueva (Solana no es EVM) o método EVM nuevo (Permit2, ERC-7710) — fuera de
  alcance, no relacionado.

## Decisiones técnicas (DT-N)

- **DT-1**: El refactor toca `src/core/*` deliberadamente, lo cual choca con la regla general de
  OWNERS.md #1 ("agregar chain = 1 archivo + 1 línea en registry, si tocás core parar y
  reevaluar"). Justificación: `ChainId` (number) y el regex `eip155:` son EVM-specific *por
  diseño actual* de `core/`; para que Solana (y cualquier red no-EVM futura) entre sin tocar
  `core/` de nuevo, `core/` debe volverse namespace-agnostic **una vez, en esta HU**. Después de
  esta HU, agregar una tercera red (EVM o no) NO debe requerir tocar `core/` — ese es el criterio
  de éxito de la abstracción (verificable en F4). Esta HU es, por definición del propio
  `OWNERS.md`, el único refactor de `core/` autorizado — el Architect DEBE agregar la nota
  correspondiente en `OWNERS.md` (ver Scope IN).
- **DT-2**: El path EVM se preserva mediante regresión de test suite completa (AC-1), no
  reescritura — el objetivo es "mismo output, mecanismo de dispatch generalizado por debajo",
  no "reescribir la lógica EVM".
- **DT-3**: La interfaz `SettlementAdapter` (AC-4) se define como adición, no como reemplazo de
  `ChainAdapter` — el detalle de si es una interfaz hermana, una interfaz base con extensión EVM,
  o un union type queda para el diseño de F2 (SDD). Esta HU solo fija el *requisito funcional*:
  debe existir un adapter shape que no obligue a `getPublicClient`/`getWalletClient`.
- **DT-4**: `ChainRegistry` (AC-6) — la decisión entre "generalizar el Map existente a
  `Map<string, ChainAdapter>` con `ChainId` como subtipo string-serializable" vs "registry
  hermano para adapters no-EVM" es de F2 (Architect). Constraint no negociable: `getAdapter()`
  para el path EVM debe seguir siendo O(1) y el `_isValidAdapter` guard no debe regresionar.

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIO)**: EVM byte-idéntico — cero cambios de comportamiento observable en el
  path `eip3009`. Ningún test existente cambia su assertion. Cualquier PR que rompa un test
  existente para "hacerlo pasar" (en vez de que el refactor preserve el comportamiento) es
  BLOQUEANTE en AR.
- **CD-2 (OBLIGATORIO)**: PROHIBIDO tocar `src/routes/*`, `src/middleware/*`, `src/infra/*` en
  esta HU. El dispatch multi-red se resuelve enteramente dentro de `src/core/*` +
  `src/chains/registry.ts` + `src/chains/types.ts`. Las capas transversales (auth, rate-limit,
  idempotencia, audit, ledger, métricas) no deben enterarse de que existe una red no-EVM.
- **CD-3 (OBLIGATORIO)**: PROHIBIDO implementar lógica real de verificación/settlement Solana
  (ed25519, SPL-token, RPC Solana, wallet Solana) en esta HU — es fundación de abstracción
  únicamente. El "adapter Solana" de esta HU, si existe como stub, SHALL responder de forma
  determinística y no-crasheante (AC-3), nunca simular un settle exitoso.
- **CD-4**: PROHIBIDO introducir `any` o `as unknown as X` nuevos para forzar el discriminated
  union del schema (AC-5) — TypeScript strict se mantiene; si el narrowing por
  `assetTransferMethod` requiere un Zod discriminated union (`z.discriminatedUnion`), es la
  solución preferida sobre casts.
- **CD-5 (OBLIGATORIO)**: PROHIBIDO romper la API pública `/verify` `/settle` (shapes de request/
  response x402-literal descritas en `.nexus/project-context.md`) — el refactor es puramente
  interno a `core/`+`chains/`; ningún consumidor HTTP externo (wasiai-a2a, wasiai-v2, terceros)
  debe notar el cambio.
- **CD-6**: Todo cambio en `src/chains/registry.ts` y `src/chains/types.ts` requiere Adversarial
  Review obligatorio (regla de proceso ya vigente en CLAUDE.md: `src/chains/*` es money-moving-
  adjacent).

## Missing Inputs

- **[NEEDS CLARIFICATION — resuelto en F2]** Formato exacto del `networkId` no-EVM: ¿CAIP-2
  literal `solana:<primer 32 chars del genesis hash>` (ej. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
  para mainnet-beta) o un identificador simplificado (`solana:mainnet` / `solana:devnet`)? Afecta
  el regex/parsing en `core/verify.ts` y `core/settle.ts`.
- **[NEEDS CLARIFICATION — resuelto en F2]** Código de error x402 para "namespace reconocido,
  sin adapter registrado" (AC-3): ¿reusar `NETWORK_MISMATCH` (ya existe, mensaje puede
  diferenciar) o agregar un 13er código nuevo tipo `CHAIN_UNAVAILABLE`-sibling? Impacta
  `X402ErrorCode` en `src/core/types.ts` y las tablas exhaustivas de `src/core/errors.ts`.
- **[NEEDS CLARIFICATION — resuelto en F2]** ¿`ChainRegistry` se generaliza in-place (mismo
  archivo, tipo de key más amplio) o se introduce un registry hermano
  (`src/chains/network-registry.ts`) que delega en el `ChainRegistry` EVM existente? Impacta
  boundaries de OWNERS.md.
- **[bloqueante — NO bloquea esta HU, sí bloquea HU-SOL-6]** Ninguna decisión de negocio/legal
  de Solana (custodia, rail de settlement, KYC) está en el alcance de esta HU — son inputs para
  HU-SOL-6 en adelante, no para F1.

## Análisis de paralelismo

- **Bloquea**: HU-SOL-6 (adapter Solana concreto) depende 100% de que esta HU cierre — el
  adapter Solana se implementa contra la interfaz `SettlementAdapter` + el registry generalizado
  que esta HU define. No puede arrancar F2 de HU-SOL-6 sin `HU_APPROVED` + merge de esta HU.
- **No bloquea**: cualquier HU EVM-only en curso en `wasiai-facilitator` (ej. WFAC-148 en
  `doc/sdd/_INDEX.md` fila 024, "in progress") — el refactor es aditivo/interno a `core/` y
  `chains/`, y AC-1 garantiza que el comportamiento EVM no cambia. Recomendado: si WFAC-148 sigue
  abierta cuando esta HU entra a F3, coordinar el merge order para minimizar conflictos en
  `src/chains/base-adapter.ts` / `src/core/settle.ts` (ambas tocan `settle.ts`, aunque en zonas
  distintas — WFAC-148 es sobre `OPERATOR_FUNDING_LOW` en `base-adapter.ts`, esta HU es sobre
  dispatch en `settle.ts`).
- **Puede ir en paralelo con**: cualquier trabajo en `wasiai-a2a` o `wasiai-v2` — son consumidores
  HTTP del facilitator, no ven este refactor interno hasta que el adapter Solana real (HU-SOL-6)
  esté expuesto en `/supported`.
