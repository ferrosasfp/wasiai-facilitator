# product-context.md — Contexto de Negocio

> Contenido definido por Fernando Rosas (founder/CTO, OpenClaw).
> El analyst lo lee en F0 antes de cada HU para entender el dominio.
> El detalle tecnico vive en `project-context.md`. Este doc es solo negocio.
>
> **Limite: ~200 lineas.**

---

## Producto

| Campo | Valor |
|-------|-------|
| **Nombre** | WasiAI Facilitator |
| **Que resuelve** | Los agentes autonomos necesitan pagar y cobrar stablecoins on-chain entre plataformas, pero depender de un facilitator externo (Pieverse, Coinbase CDP) genera single point of failure + limita las chains soportadas. WasiAI Facilitator es la capa de settlement self-hosted, multi-chain, production-grade. |
| **Para quien** | Marketplaces de agentes, protocolos A2A, desarrolladores que necesitan x402-compliant payment settlement |
| **Estado** | V0 — scaffold inicial (2026-04-21). V1 planificado: hackathon Kite post-extension |
| **Empresa** | OpenClaw (Fernando Rosas, Eli) |

---

## Personas

| Persona | Objetivo | Pain point | Comportamiento tipico |
|---------|----------|------------|----------------------|
| **Agent Developer** | Cobrar micropagos en stablecoins sin que el usuario pague gas | Facilitators externos (Pieverse) caen + no cubren la chain que necesita | Integra x402, descubre que /v2/verify esta 500, queda bloqueado |
| **Marketplace Operator** | Settlement confiable para millones de micropagos | Depender de un facilitator externo = SPOF; cada outage = perdida de revenue | Busca alternativas self-hosted pero escribir uno desde cero es costoso y riesgoso (dinero) |
| **Protocol Integrator** | Consumir un facilitator con interfaz estandar (x402 spec) en chains emergentes | Coinbase solo cubre Base/Polygon/Arbitrum. Kite, Monad, nuevos chains no tienen cobertura | Termina rodando su propio settler, duplicando trabajo |
| **DevOps / SRE** | Monitorear settlements + debug payment failures | Falta observabilidad estandar en facilitators existentes | Grep logs, abre tickets al proveedor, debug lento |

---

## Vision del producto

WasiAI Facilitator es a los pagos de agentes lo que Stripe es a los pagos de e-commerce: **infrastructure invisible, confiable, multi-rail**.

**Diferenciadores clave:**
- **Spec-compliant** al 100% con docs.x402.org → drop-in replacement de Pieverse/Coinbase CDP
- **Multi-chain nativo** — plug-in architecture para agregar chain nueva sin tocar core
- **Production-grade desde V1** — simulate-before-settle, idempotency cache, rate limit, circuit breaker, audit trail
- **Cobertura chains que Coinbase no tiene** — Kite es el primer diferenciador (Coinbase no cubre Kite)
- **Self-hosted con option de hosted** — cualquiera puede forkear + deployar; WasiAI opera la instancia publica

---

## Flujos principales

### 1. Settlement x402 (el core del producto)

1. Un client (agente, marketplace) hace `POST /settle` con firma EIP-712 del usuario
2. Facilitator valida off-chain: signature recovery, balance, timing, amount, network
3. Chequea idempotency cache (no procesar el mismo payload 2 veces)
4. `simulateContract` en blockchain para pre-validar la tx
5. Ejecuta `transferWithAuthorization` on-chain (operator paga gas)
6. Espera receipt + registra en ledger Supabase
7. Devuelve `{settled, transactionHash, blockNumber, ...}`

### 2. Verify-only (pre-flight check)

1. Client hace `POST /verify` — quiere confirmar que la firma es valida sin settlear aun
2. Facilitator hace solo las validaciones off-chain
3. Devuelve `{verified, client, amount, ...}` sin tocar on-chain
4. Util para cacheo de validaciones + separar auth de settlement

### 3. Discovery (chain + method listing)

1. Client consulta `GET /supported`
2. Facilitator devuelve catalogo de chains, methods y tokens soportados
3. Client usa info para construir `accepted` object en su 402 response

---

## Modelo de negocio

| Revenue stream | Como funciona | Estado |
|----------------|---------------|--------|
| **Free public infrastructure** (V1) | Sin fees. Operamos el facilitator publico como bien comun del ecosistema | V1 — hackathon narrative |
| **Protocol fee (optional 0.1-1%)** | Fee configurable por chain o per-API-key | V2 (post-hackathon) |
| **Enterprise SLA** | SaaS para empresas que requieren 99.9% uptime + soporte | V2+ |
| **Self-hosted license** | MIT, OSS. Cualquiera puede forkear. Monetiza via soporte/consulting | Baseline |

**Decision estrategica**: V1 es free publico — alineamiento con filosofia "free infrastructure" del x402 ecosystem (Coinbase CDP tambien tiene tier gratis de 1000 tx/mes). Diferenciamos en chains cubiertas + DX.

---

## Restricciones de negocio

- **Hackathon Kite AI Global 2026** — track Agentic Commerce, deadline extendido ≥2 semanas sobre 2026-05-06. Jueces: Kite team. Narrativa clave: "operamos nuestro propio facilitator x402 en Kite testnet, independiente de Pieverse"
- **Filosofia fundacional**: "Producto para produccion, no software para hackathon" — calidad real, tests, observability, arquitectura extensible
- **Multi-chain obligatorio desde arquitectura** — V1 arranca con Kite, pero core code ya soporta agregar Avalanche/Base/Polygon/etc. en semanas, no meses
- **Money-moving service** — cada decision de codigo evalua impacto en seguridad de fondos. AR obligatorio en changes que tocan settle path
- **Dependencia externa: Kite RPC** — uptime del RPC Kite impacta directo. Circuit breaker mitiga. No controlamos el RPC.
- **Dependencia externa: Token contracts** — PYUSD, USDC. Si cambian implementacion rompemos. Monitoreo + version pinning del ABI.

---

## Decisiones de producto

- **Self-hosted sobre depender de Pieverse** — Pieverse outage 2026-04-13 enseno que terceros no son confiables para payment infrastructure
- **Multi-chain plug-in sobre single-chain** — desde dia 1 el core es chain-agnostic. Agregar chain = 1 archivo en `src/chains/`, zero cambios a core
- **x402 spec-literal sobre custom interfaces** — 100% compatible con clientes x402 existentes (Pieverse format, Coinbase SDK format)
- **Persistent server sobre serverless** — facilitators son money-moving infrastructure. Spec requiere in-memory cache 120s. Industry pattern (Pieverse, Coinbase) es persistent
- **Fastify sobre Hono/NestJS** — Fastify es battle-tested en fintech, consistency con wasiai-a2a, rich plugin ecosystem
- **Simulate-then-settle obligatorio** — cada tx on-chain se simula primero. Si simulacion falla, HTTP 500 SIMULATION_FAILED antes de gastar gas real
- **Idempotency Redis-backed con fallback in-memory** — spec requires 120s cache. Redis para multi-instance. In-memory fallback si Redis down (graceful degradation)
- **EIP-3009 primero, Permit2/ERC-7710 despues** — cobertura de 80% de use cases con menor complejidad inicial

---

## Competidores / Landscape

| Proyecto | Que hace | Diferencia con WasiAI Facilitator |
|----------|----------|-----------------------------------|
| **Pieverse** | x402 facilitator publico, cubre varias EVM chains | No controlan su uptime (bug /v2/verify abril 2026 nos enseño la leccion). Nosotros somos self-hosted |
| **Coinbase CDP x402 facilitator** | Facilitator oficial para Base/Polygon/Arbitrum/World/Solana | No cubre Kite. Nosotros si. Ademas, vendor lock-in a Coinbase CDP |
| **x402.org reference implementation** | SDKs Go/TypeScript/Python para correr facilitator propio | Codigo starter, no servicio hosted. Nosotros somos servicio + codigo abierto |
| **Stripe Machine Payments Protocol (MPP)** | Alternativa a x402 de Stripe + Paradigm (Tempo L1) | Protocolo diferente. Post-V1 podriamos agregar adapter MPP para ser neutral |
| **Circle CCTP** | Cross-chain USDC transfers | Diferente dominio (bridge, no settlement-as-a-service). Complementario |

---

## Equipo

| Rol | Persona | Foco |
|-----|---------|------|
| Founder / CTO | Fernando Rosas | Arquitectura, desarrollo core, integracion chains |
| Co-founder | Eli | Pitch, narrativa facilitator-as-product, presentacion |
| Contacto Kite | Rebecca (hackathon), Stephen A (tech) | Soporte ecosystem, token launches |

---

## Backlog priorizado (V0 → V1)

**V0 (actual — 2026-04-21)**: scaffold + NexusAgil infra + repos + Jira

**V1 (hackathon — target 2 semanas)**:
- E1 Core Infrastructure (Fastify bootstrap, chain registry, Redis)
- E2 EIP-3009 Method (verify + settle con spec compliance)
- E3 HTTP API (verify, settle, supported, health)
- E6 Chains: Kite Testnet (primer chain live)
- E8 Railway deploy
- Smoke tests E2E contra prod

**V1.1 (post-hackathon, 1-2 semanas mas)**:
- E4 Observability (Sentry, Datadog)
- E5 Security full (BullMQ retry, wallet monitoring, rate limit avanzado)
- E7 Spec Conformance tests
- E6 mas chains (Avalanche, Kite Mainnet)

**V2 (roadmap 1-3 meses)**:
- Permit2 method adapter
- Multi-sig operator wallet
- Key rotation
- API key management publico
- Protocol fee configurable
- Admin dashboard

---

## KPIs clave

- **Uptime** `/verify` + `/settle` — objetivo 99.9% V1.1
- **p95 latency** `/verify` — < 500ms (off-chain only)
- **p95 latency** `/settle` — < 10s en Kite testnet (incluye tx confirm)
- **Settlement success rate** — % tx que completan on-chain sin error — objetivo > 98%
- **Duplicate detection rate** — % requests rechazados por idempotency cache (indica abuse o bugs de clientes)
- **Wallet balance alerting** — operator wallet con gas < 10% del minimo → alerta

---

## Dependencias criticas que monitorear

- Kite RPC uptime (https://rpc-testnet.gokite.ai)
- PYUSD contract (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`) ABI stability
- Redis uptime (Upstash o Railway add-on)
- Supabase uptime (para ledger/audit)
- Operator wallet balance — gas token per chain
