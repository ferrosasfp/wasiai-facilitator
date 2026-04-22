# WasiAI Facilitator — Project Context (Technical)

> Este archivo es cargado por los agentes NexusAgil antes de operar.
> Contiene las reglas criticas, patrones y contexto que cualquier IA necesita para trabajar correctamente en este proyecto.
> Complemento de `.nexus/product-context.md` (contexto de negocio).

---

## Qué es wasiai-facilitator

Servicio HTTP production-grade que implementa el contrato de [facilitator del protocolo x402](https://docs.x402.org) — verifica firmas EIP-712 off-chain y ejecuta settlements on-chain vía `transferWithAuthorization` (EIP-3009). Permite micropagos gasless en stablecoins entre agentes autonomos.

**Posicionamiento:** alternativa self-hosted a Pieverse/Coinbase CDP, multi-chain (Kite, Avalanche extensible), público (cualquier x402 client puede consumirlo).

**Repo:** github.com/ferrosasfp/wasiai-facilitator
**Jira:** WFAC (ferrosasfp.atlassian.net)
**Puerto:** 3002 (dev). Prod: Railway asigna.
**Stack:** Fastify v5 + viem v2 + Redis + Supabase + BullMQ + TypeScript strict

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│  x402 Client (wasiai-a2a, wasiai-v2, terceros)           │
│                                                          │
│    POST /verify  { x402Version, resource, accepted,      │
│                     payload: {signature, authorization} }│
│                                                          │
│    POST /settle  (same shape, triggers on-chain tx)      │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  wasiai-facilitator (este servicio)                      │
│  ──────────────────────────────────                      │
│                                                          │
│  Routes (Fastify)                                        │
│    /verify   /settle   /supported   /health   /metrics   │
│                                                          │
│  Middleware                                              │
│    cors, helmet, rate-limit, request-id,                 │
│    circuit-breaker, validation (Zod)                     │
│                                                          │
│  Core                                                    │
│    verify.ts   settle.ts   idempotency.ts                │
│    errors.ts   schemas.ts                                │
│                                                          │
│  Methods (plug-ins)                                      │
│    eip3009/verify+settle   permit2 (V1.5)   erc7710 (V2) │
│                                                          │
│  Chains (plug-ins)                                       │
│    kite.ts (testnet+mainnet)   avalanche.ts              │
│    registry.ts (extensible)                              │
│                                                          │
│  Infra                                                   │
│    wallet (viem wallet client per chain, singleton)      │
│    redis (Upstash REST o Railway add-on)                 │
│    logger (Pino structured JSON)                         │
│    metrics (prom-client counters/histograms)             │
│                                                          │
│  Persistence                                             │
│    Supabase Postgres → facilitator_settlements           │
│                                                          │
│  Queue (V1.5)                                            │
│    BullMQ → settlement retry queue                       │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼ (on-chain tx: transferWithAuthorization)
┌──────────────────────────────────────────────────────────┐
│  EVM chain (Kite, Avalanche, ...)                        │
│  Token contract: executes transfer from user → merchant  │
└──────────────────────────────────────────────────────────┘
```

---

## Golden Path — Stack inmutable

### Runtime
- **Node 20 LTS** — stable, long support window
- **TypeScript strict** — noImplicitAny, strictNullChecks, noUncheckedIndexedAccess
- **ES Modules** (package.json `"type": "module"`)

### Framework & HTTP
- **Fastify v5** — mismo que wasiai-a2a (consistency ecosystem)
- **@fastify/cors, @fastify/helmet, @fastify/rate-limit** — security baseline
- **Zod** — validación de schemas + tipos inferidos
- **Pino** — structured JSON logs (Fastify native)

### Blockchain
- **viem v2** — SOTA 2026, PROHIBIDO ethers.js
  - `recoverTypedDataAddress` para EIP-712 recovery
  - `simulateContract` antes de `writeContract` (spec security)
  - `createWalletClient` + `privateKeyToAccount` (operator)
  - `createPublicClient` (read + receipt wait)

### State
- **Redis** (Upstash REST o Railway add-on) — idempotency cache 120s, rate limit distribuido, BullMQ backend
- **Supabase Postgres** — settlement ledger dedicado (NO compartir con wasiai-a2a)
- **In-memory fallback** — si Redis down, degradar a in-memory con warning (graceful)

### Async & Queues (V1.5)
- **BullMQ** — settlement retry queue cuando RPC flakee
- **Dead-letter queue** — settlements que agotaron retries

### Observability
- **prom-client** — métricas Prometheus en `/metrics`
- **pino-http** — logs correlacionados con request IDs
- **V1.1 Sentry** — error tracking (ticket WFAC-X futuro)

### Testing
- **vitest** — unit + integration
- **Conformance tests** — verifican shapes x402 exactos (para asegurar spec compliance)
- **Integration tests** — contra testnet real (Kite + Fuji)

### Lint / Format
- **ESLint 9 flat config** + **Prettier** + `eslint-plugin-security` + `eslint-plugin-no-secrets`
- Estándar fintech: preferimos ESLint security plugins sobre Biome solo

### CI / CD
- **GitHub Actions** — test + lint + security scan + deploy
- **Snyk** — dependency vulnerability scanning
- **Dependabot** — auto-PRs para deps

### Deploy
- **Railway (production)** — persistent Node process
- **Railway branches preview** — preview env per PR
- **Cloudflare (front)** — DDoS mitigation (V1.1)

---

## Reglas absolutas (nunca violar)

1. **Sin hardcodes** — URLs, addresses, chain IDs, keys siempre desde env vars o chain registry
2. **Sin secrets en código** — `OPERATOR_PRIVATE_KEY`, `SUPABASE_SERVICE_KEY`, etc. siempre env vars
3. **Sin ethers.js** — viem exclusivo
4. **x402 spec-literal** — shapes de request/response deben matchear docs.x402.org EXACTAMENTE
5. **Simulate antes de settle** — cada tx on-chain hace `simulateContract` primero
6. **Idempotency cache 120s** — spec requires, Redis-backed (o in-memory fallback si Redis down)
7. **Chain-adaptive** — agregar chain NUNCA toca `src/core/`, solo `src/chains/`
8. **Method-adaptive** — agregar method NUNCA toca `src/core/`, solo `src/methods/`
9. **TypeScript strict** — no `any`, no `as unknown`
10. **Logs JSON estructurados** — prohibido `console.log` salvo scripts
11. **Tests obligatorios** — cada route, cada method adapter, cada chain adapter
12. **AR obligatorio para money-moving changes** — `src/core/settle.ts`, `src/methods/*`, `src/chains/*`
13. **Service layer returns discriminated union, nunca throw** — ver seccion siguiente
14. **Module boundaries respetados** — ver `OWNERS.md` (cross-layer imports prohibidos)

---

## Service Layer — Response Contract

**Regla**: `src/core/*.ts` y `src/methods/**/*.ts` NUNCA lanzan excepciones por errores
previstos. Siempre retornan un discriminated union tipado:

```ts
// src/core/types.ts (stub — lo implementa Dev en WFAC-2)
export type Ok<T> = { ok: true } & T;
export type Err = {
  ok: false;
  error: {
    code: X402ErrorCode;    // uno de los 10 codigos del spec
    message: string;         // human-readable, SIN PII (no addresses en clear si es sensible)
    http: number;            // HTTP status code que debe mapear el route layer
  };
};
export type Result<T> = Ok<T> | Err;
```

**Ejemplo correcto:**

```ts
// core/verify.ts
export async function verify(params: VerifyParams): Promise<Result<VerifyOk>> {
  const recovered = await recoverTypedDataAddress({ ... });
  if (recovered !== params.authorization.from) {
    return {
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Signature does not match sender', http: 401 }
    };
  }
  return { ok: true, client: recovered, amount: ..., asset: ..., network: ..., payTo: ..., expiresAt: ... };
}
```

**Anti-patron (PROHIBIDO):**

```ts
// NO hacer esto en core/ ni methods/
throw new Error('Invalid signature');  // rompe el tipado exhaustivo del caller
```

**Por que esta regla:**
- `throw` pierde el tipo del error — el caller debe hacer try/catch + asumir `unknown`
- x402 spec requiere mapping preciso a 10 codigos especificos — el union forza exhaustividad
- `throws` quedan reservados para bugs inesperados (ej. invariante rota); los atrapa el
  `error-handler` middleware en el boundary HTTP
- En el route layer el mapping es trivial:
  ```ts
  const result = await core.verify(...);
  if (!result.ok) return reply.code(result.error.http).send({ error: result.error });
  return reply.send(result);
  ```

**Excepcion permitida**: middleware (rate-limit, CORS) puede throw porque el handler global
los captura como parte del flujo HTTP estandar de Fastify. En `core/` y `methods/` no.

---

## x402 Protocol — Referencia rápida

### Endpoints facilitator (nosotros implementamos)

| Method | Path | Runtime | Max duration | Purpose |
|--------|------|---------|-------------|---------|
| POST | `/verify` | persistent | 30s | Off-chain validation + pre-flight checks |
| POST | `/settle` | persistent | 300s | Execute on-chain tx + wait receipt |
| GET | `/supported` | persistent | 5s | List chains + methods + tokens |
| GET | `/health` | persistent | 5s | Liveness + chain RPC probes |
| GET | `/metrics` | persistent | 30s | Prometheus scrape |

### Request shape `/verify` (x402 spec)

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://...",
    "description": "...",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:<chainId>",
    "amount": "<uint256 atomic>",
    "asset": "<token address>",
    "payTo": "<merchant address>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "<EIP-712 domain name>",
      "version": "<EIP-712 domain version>"
    }
  },
  "payload": {
    "signature": "0x<65 bytes hex>",
    "authorization": {
      "from": "<address>",
      "to": "<address>",
      "value": "<uint256>",
      "validAfter": "<uint256 timestamp>",
      "validBefore": "<uint256 timestamp>",
      "nonce": "0x<bytes32>"
    }
  }
}
```

### Response shape `/verify` (success 200)

```json
{
  "verified": true,
  "client": "<recovered signer address>",
  "amount": "<uint256>",
  "asset": "<address>",
  "network": "eip155:<chainId>",
  "payTo": "<address>",
  "expiresAt": 1234567890
}
```

### Response shape `/settle` (success 200)

```json
{
  "settled": true,
  "transactionHash": "0x<tx hash>",
  "blockNumber": 20985000,
  "amount": "<uint256>",
  "from": "<address>",
  "to": "<address>",
  "asset": "<address>"
}
```

### 10 Standard error codes (spec)

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_SIGNATURE` | 401 | Signature doesn't recover to claimed address |
| `INSUFFICIENT_BALANCE` | 402 | Client lacks asset balance |
| `PERMIT2_ALLOWANCE_REQUIRED` | 412 | User must approve Permit2 (one-time) |
| `EXPIRED_AUTHORIZATION` | 400 | Timestamp outside valid window |
| `NETWORK_MISMATCH` | 400 | Network doesn't match requirements |
| `SIMULATION_FAILED` | 500 | Transaction simulation failed |
| `INVALID_AMOUNT` | 400 | Amount doesn't meet requirements |
| `INVALID_RECEIVER` | 400 | Receiver address mismatch |
| `TRANSACTION_FAILED` | 500 | On-chain execution failed |
| `DELEGATION_INVALID` | 401 | ERC-7710 delegation invalid/expired |

---

## Estructura de directorios

```
wasiai-facilitator/
├── src/
│   ├── index.ts              ← Entry point (Fastify bootstrap)
│   ├── app.ts                ← App factory (for tests + prod)
│   ├── core/
│   │   ├── verify.ts         ← Method-agnostic verify orchestration
│   │   ├── settle.ts         ← Method-agnostic settle orchestration
│   │   ├── idempotency.ts    ← 120s cache (Redis-backed)
│   │   ├── schemas.ts        ← Zod schemas x402-compliant
│   │   ├── errors.ts         ← 10 standard codes → HTTP
│   │   └── types.ts          ← Shared types
│   ├── methods/
│   │   ├── eip3009/
│   │   │   ├── verify.ts     ← EIP-712 recover + checks
│   │   │   ├── settle.ts     ← transferWithAuthorization
│   │   │   ├── abi.ts        ← Minimal ERC-3009 ABI
│   │   │   └── index.ts
│   │   ├── permit2/          ← V1.5
│   │   └── erc7710/          ← V2
│   ├── chains/
│   │   ├── registry.ts       ← Plug-in registry
│   │   ├── types.ts          ← ChainConfig interface
│   │   ├── kite.ts           ← Kite testnet + mainnet
│   │   └── avalanche.ts      ← Fuji + mainnet
│   ├── routes/
│   │   ├── verify.ts
│   │   ├── settle.ts
│   │   ├── supported.ts
│   │   ├── health.ts
│   │   └── metrics.ts
│   ├── middleware/
│   │   ├── cors.ts
│   │   ├── rate-limit.ts
│   │   ├── validation.ts
│   │   ├── circuit-breaker.ts
│   │   ├── request-id.ts
│   │   └── error-handler.ts
│   ├── infra/
│   │   ├── wallet.ts         ← viem wallet singleton per chain
│   │   ├── redis.ts          ← ioredis client
│   │   ├── supabase.ts       ← Supabase client (ledger)
│   │   ├── logger.ts         ← Pino setup
│   │   └── metrics.ts        ← prom-client counters
│   └── __tests__/
│       ├── setup.ts
│       ├── contract/         ← x402 spec conformance
│       ├── integration/      ← testnet E2E
│       └── unit/             ← per-module unit tests
├── .claude/                  ← NexusAgil infra
│   ├── agents/               (tracked)
│   └── commands/             (tracked)
├── .nexus/
│   ├── project-context.md    ← ESTE ARCHIVO
│   └── product-context.md    ← contexto negocio
├── doc/
│   ├── sdd/                  ← SDDs por HU
│   │   └── _INDEX.md
│   ├── architecture/
│   │   ├── CHAIN-ADAPTIVE.md
│   │   ├── SECURITY.md
│   │   └── X402-CONFORMANCE.md
│   └── INTEGRATION.md        ← guía para integrators
├── scripts/
│   ├── smoke-test.sh
│   ├── demo-facilitator.ts
│   └── doctor-*.sh
├── openapi.yaml              ← OpenAPI 3.1
├── .env.example
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc.json
├── vitest.config.ts
├── railway.json
├── CLAUDE.md
├── BACKLOG.md
├── README.md
└── LICENSE
```

---

## Variables de entorno requeridas (production)

```bash
# Server
NODE_ENV=production
PORT=3002
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=https://a2a.wasiai.io,https://app.wasiai.io

# Operator wallet (CRITICAL — needs gas on each chain)
OPERATOR_PRIVATE_KEY=0x...

# Chain RPCs (per chain)
KITE_TESTNET_RPC_URL=https://rpc-testnet.gokite.ai/
KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
AVALANCHE_FUJI_RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com
AVALANCHE_MAINNET_RPC_URL=...

# Redis
REDIS_URL=redis://...

# Supabase (dedicated project)
SUPABASE_URL=https://<new-project>.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...

# Rate limit
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_VERIFY_MAX=120
RATE_LIMIT_SETTLE_MAX=30
```

---

## Tablas DB (Supabase dedicated — prefix `facilitator_`)

```sql
-- Settlement ledger (cada tx settled)
facilitator_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id TEXT UNIQUE NOT NULL,      -- idempotency key (hash of payload)
  client_address TEXT NOT NULL,
  merchant_address TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  network TEXT NOT NULL,                 -- 'eip155:2368' etc.
  amount NUMERIC(38, 0) NOT NULL,        -- atomic units
  method TEXT NOT NULL,                  -- 'eip3009' | 'permit2' | 'erc7710'
  status TEXT NOT NULL,                  -- 'pending' | 'settled' | 'failed'
  tx_hash TEXT,
  block_number BIGINT,
  error_message TEXT,
  gas_used NUMERIC(38, 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Audit log inmutable (append-only, cumplimiento)
facilitator_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,              -- 'verify_ok' | 'verify_fail' | 'settle_ok' | etc.
  payment_id TEXT,
  request_id TEXT,
  client_ip TEXT,
  payload_hash TEXT,                     -- sha256 of request body
  response_code INTEGER,
  error_code TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

-- Idempotency tracking (optional persistence beyond Redis 120s)
facilitator_idempotency (
  payment_id TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT NOW()
)
```

---

## Deuda tecnica

Gestionada en formato `TD-NN-NN` en `BACKLOG.md` → seccion "Tech Debt — Tracking Formal".
Cada TD tiene ticket Jira asignado antes del release V1. Revisada trimestralmente en retros.

Regla: el PR que introduce nueva TD debe referenciarla en el commit message
(`Tech Debt: TD-NN-NN`) y asegurar que exista la entrada en `BACKLOG.md` antes del merge.

---

*Ultima actualizacion: 2026-04-21 | Version: 0.1.0 | Scaffold inicial*
