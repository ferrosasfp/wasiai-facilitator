# BACKLOG — wasiai-facilitator

## Épicas

### E1: Core Infrastructure

Setup básico del servicio con Fastify, logging, health, CI.

- [ ] WFAC-1: Project scaffold (repo + config files + CI skeleton) ← **meta/done**
- [ ] WFAC-2: Fastify bootstrap + /health endpoint + structured logging (Pino)
- [ ] WFAC-3: Chain registry plug-in architecture (extensible multi-chain)
- [ ] WFAC-4: Redis client (idempotency cache foundation)
- [ ] WFAC-5: GitHub Actions CI (test + lint + security scan)

### E2: EIP-3009 Method Implementation

El method core que habilita transfers gasless de stablecoins EIP-3009 compliant.

- [ ] WFAC-10: Verify logic — recover EIP-712 signature, match authorization.from
- [ ] WFAC-11: Settle logic — simulateContract + transferWithAuthorization + receipt wait
- [ ] WFAC-12: Standard error codes mapping (10 x402 spec codes → HTTP)
- [ ] WFAC-13: Signature normalization (EIP-2098 v-value, Core wallet edge cases)

### E3: HTTP API — x402 Spec-Compliant

Endpoints públicos siguiendo el contrato x402.

- [ ] WFAC-20: POST /verify route + Zod schemas
- [ ] WFAC-21: POST /settle route + simulate + idempotency check
- [ ] WFAC-22: GET /supported route (chain + method registry)
- [ ] WFAC-23: OpenAPI 3.1 spec auto-generado desde Zod

### E4: Observability

Logs estructurados + metrics + audit trail.

- [ ] WFAC-30: Prometheus /metrics endpoint (prom-client)
- [ ] WFAC-31: Request correlation IDs (request-id middleware)
- [ ] WFAC-32: Settlement ledger (Supabase — tabla `facilitator_settlements`)
- [ ] WFAC-33: Audit log inmutable (append-only, por compliance futuro)

### E5: Security & Resilience

- [ ] WFAC-40: Rate limiting (Redis-backed, per-IP)
- [ ] WFAC-41: Circuit breaker per chain RPC
- [ ] WFAC-42: Settlement retry queue (BullMQ)
- [ ] WFAC-43: Wallet balance monitoring + alerts (low gas warnings)

### E6: Chain Adapters

Cada chain es un plug-in en `src/chains/`.

- [ ] WFAC-50: Kite Testnet (chainId 2368) + PYUSD
- [ ] WFAC-51: Kite Mainnet (chainId 2366) + token oficial TBD
- [ ] WFAC-52: Avalanche Fuji (chainId 43113) + USDC
- [ ] WFAC-53: Avalanche Mainnet (chainId 43114) + USDC

### E7: Spec Conformance

- [ ] WFAC-60: Contract tests que verifican shapes x402 exactos
- [ ] WFAC-61: Interop tests con x402 reference clients (Coinbase SDK, Pieverse format)
- [ ] WFAC-62: Conformance doc público (`X402-CONFORMANCE.md`)

### E8: Deployment & Operations

- [ ] WFAC-70: Railway deploy config (persistent process)
- [ ] WFAC-71: Environment scopes (dev, staging, production)
- [ ] WFAC-72: DNS cutover → `facilitator.wasiai.io`
- [ ] WFAC-73: Smoke test automation post-deploy

### E9: Integrations (post-V1)

- [ ] WFAC-80: wasiai-a2a consumes facilitator (migrate from Pieverse)
- [ ] WFAC-81: wasiai-v2 migrates from internal `usdcSettler.ts` to facilitator
- [ ] WFAC-82: Public integration guide + SDK client (npm package)

---

## Post-V1 / Roadmap

### E10: Method Extensions
- [ ] Permit2 adapter (any ERC-20)
- [ ] ERC-7710 delegation adapter
- [ ] EIP-2612 permit gas-sponsoring

### E11: Chain Extensions
- [ ] Base (USDC) — competitive with Coinbase CDP
- [ ] Polygon (USDC)
- [ ] Arbitrum (USDC)
- [ ] Solana (SPL tokens)
- [ ] Aptos fungible assets

### E12: Product Features
- [ ] API key management (public registration + revocation)
- [ ] Per-client fee model (optional 0.1-1% protocol fee)
- [ ] Multi-signer operator wallet (Safe multisig V2)
- [ ] Key rotation protocol (zero-downtime)
- [ ] Observability stack (Sentry, Datadog integration)
- [ ] Admin dashboard (settlement monitoring, wallet balances, rate limit stats)
- [ ] OFAC screening (compliance feature, enterprise)

### E13: Compliance
- [ ] Audit trail exportable (for accounting)
- [ ] Geo-blocking by IP (enterprise toggle)
- [ ] KYC hooks for high-value settlements

---

## Priorización

### Must-have V1 (hackathon + primera release production)
- E1 Core Infrastructure
- E2 EIP-3009 Method
- E3 HTTP API
- E4 (parcial) — **settlement ledger + audit log** (WFAC-32, WFAC-33) ← promovido desde V1.1 por compliance + zero-trust observability desde día 1
- E5 (parcial) — rate limit + circuit breaker (WFAC-40, WFAC-41)
- E6 — Kite Testnet como MVP (WFAC-50)
- E8 — Railway deploy (WFAC-70, WFAC-73)

### Should-have V1.1
- E4 full (metrics Prometheus + request-id correlation — WFAC-30, WFAC-31)
- E5 full (BullMQ queue, wallet monitoring — WFAC-42, WFAC-43)
- E6 full (Avalanche + Kite Mainnet — WFAC-51, WFAC-52, WFAC-53)
- E7 Spec Conformance tests
- E9 integrations (wasiai-a2a consumer — WFAC-80)

### Nice-to-have V2
- E10, E11, E12, E13

---

## Tech Debt — Tracking Formal

Formato `TD-NN-NN`: primer NN = épica afectada, segundo NN = secuencial dentro de la épica.

| TD ID | Descripción | Target | Ticket Jira |
|-------|-------------|--------|-------------|
| TD-01-04 | Pino redact config para auth headers (sensitive data masking) | V1.1 — WFAC-31 | WFAC-31 |
| TD-01-05 | shutdown.ts branch coverage: idempotency + reject paths (try/finally) | Next HU touching shutdown | WFAC-TBD |
| TD-01-06 | AC-9/12 wording refinement (literal vs semantic, consult Architect) | Pending decision | WFAC-TBD |
| TD-01-07 | try/finally wrapper en listening log suppression (refactor index.ts) | Next refactor opportunity | WFAC-TBD |
| TD-01-08 | Extract listening log wrapper a src/infra/logger.ts helper | Nice-to-have | WFAC-TBD |
| TD-02-01 | Permit2 method adapter (cualquier ERC-20, no solo EIP-3009) | V1.5 | WFAC-TBD |
| TD-02-02 | ERC-7710 delegation method adapter | V2 | WFAC-TBD |
| TD-03-01 | API key management público (registration + revocation) | V1.5 | WFAC-TBD |
| TD-04-01 | Sentry APM integration (error tracking + performance) | V1.1 | WFAC-TBD |
| TD-05-01 | Multi-sig operator wallet (Safe) — elimina single-key SPOF | V2 | WFAC-TBD |
| TD-05-02 | Wallet key rotation protocol (zero-downtime) | V2 | WFAC-TBD |
| TD-06-01 | Solana / non-EVM chain adapters | V2 | WFAC-TBD |
| TD-09-01 | wasiai-a2a migration from Pieverse → facilitator | Post-V1 | WFAC-80 |
| TD-09-02 | wasiai-v2 migration from internal `usdcSettler.ts` → facilitator | Post-V1 | WFAC-81 |
| TD-12-01 | Fee model opcional (0.1-1% protocol fee) | V2 | WFAC-TBD |
| TD-12-02 | Admin dashboard (settlement monitoring, wallet balances) | V1.5 | WFAC-TBD |
| TD-13-01 | OFAC screening + geo-blocking (enterprise) | V2 | WFAC-TBD |
| TD-SEC-LEDGER-01 | RLS en `facilitator_settlements` (defensa hoy app-layer via service role key; ALTER TABLE … ENABLE ROW LEVEL SECURITY + CREATE POLICY por role post-auditoría) | V1.5 / WFAC-SEC-01 | WFAC-TBD |
| TD-CHAINS-ABI-DUP | WFAC-50 introdujo duplicación de `FIAT_TOKEN_ABI` + `normalizeSignature` entre `src/methods/eip3009/` y `src/chains/abi/`. Refactor futuro: mover canónico a `src/chains/abi/` y re-exportar desde `src/methods/eip3009/` para unificar la fuente de verdad. Test de sync byte-for-byte (`T-SDD-1-ABI-SYNC`) protege hasta entonces. | V1.5 | WFAC-TBD |

### TD-SEC-LEDGER-01 — Habilitar RLS en `facilitator_settlements`

Hoy la defensa sobre `facilitator_settlements` es solo **app-layer** (service role key escribe directo).
Para V1.5 / post-auditoría: `ALTER TABLE facilitator_settlements ENABLE ROW LEVEL SECURITY` +
`CREATE POLICY` por service role. Mismo trade-off que WKH-53 en wasiai-a2a.

- Fuente: WFAC-32 SDD §7 Riesgos.
- Gate: WFAC-SEC-01 (cuando se agende una iteración de hardening).

**Reglas de TD** (adopción patrón luma-ai):
1. Todo TD debe tener ticket Jira creado antes del release V1 (aunque no esté ready)
2. El PR que introduce el TD debe referenciarlo en el mensaje: `Tech Debt: TD-NN-NN`
3. Revisión obligatoria en retros trimestrales (próxima: 2026-07)
4. TD sin target definido se defaultea a V2 y entra en backlog de revisión

---

## Dependencias externas conocidas

| Dep | Qué necesita | Status |
|-----|--------------|--------|
| Kite testnet RPC | `https://rpc-testnet.gokite.ai/` | ✅ live |
| PYUSD testnet | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | ✅ funded |
| Redis | Local dev + Upstash/Railway prod | ⏳ por configurar |
| Supabase dedicated project | Nuevo proyecto (no compartir con wasiai-a2a) | ⏳ por crear |
| Railway project | `wasiai-facilitator` service | ⏳ por crear |
| Sentry account | Error tracking V1.1 | ⏳ diferido a V1.1 |

---

*Última actualización: 2026-04-21 — scaffold inicial*
