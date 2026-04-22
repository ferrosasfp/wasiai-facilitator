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
- E5 (parcial) — rate limit + circuit breaker
- E6 — Kite Testnet como MVP
- E8 — Railway deploy

### Should-have V1.1
- E4 Observability full
- E5 full (BullMQ queue, wallet monitoring)
- E6 full (Avalanche + Kite Mainnet)
- E7 Spec Conformance tests
- E9 integrations (wasiai-a2a consumer)

### Nice-to-have V2
- E10, E11, E12, E13

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
