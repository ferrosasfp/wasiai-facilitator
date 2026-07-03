# wasiai-facilitator

> Self-hosted, multi-chain x402 facilitator. The settlement piece of WasiAI's neutral, open payment layer for the agent economy.

`wasiai-facilitator` is the relayer that turns a signed payment authorization into an on-chain settlement. It implements the [HTTP 402 Payment Required](https://docs.x402.org) facilitator role: it verifies EIP-3009 signatures off-chain (`verify`) and executes `transferWithAuthorization` on-chain (`settle`), so agents and their counterparts can move stablecoins without the payer ever holding native gas.

## Where this fits

WasiAI is a neutral, open, multi-chain payment layer for the agent economy, LATAM-first. The agent economy tends to fragment into walled gardens; WasiAI is the neutral ground: open standards, settlement on each agent's own chain, no lock-in.

This repo is one component of that layer, the settlement relayer. It is infrastructure, not the whole layer and not an application. The neutral gateway that routes and orchestrates lives in [`wasiai-a2a-gateway`](https://github.com/ferrosasfp/wasiai-a2a-gateway) and consumes this facilitator to settle payments.

## What it does

- **Verify off-chain.** Validates an EIP-3009 signed `TransferWithAuthorization` (signature, domain, amount, expiry) with no state change.
- **Settle on-chain.** Simulates and then submits `transferWithAuthorization`. The operator wallet pays gas, so the payer settles gaslessly.
- **Multi-chain by design.** Each network is a self-contained chain adapter. Adding a chain is one adapter module plus one line in the registry.
- **Fail-safe.** Per-chain circuit breakers, a daily settle cap, boot-time EIP-712 domain-separator drift checks, idempotency guards, and per-IP plus per-key rate limiting.

## Supported chains

Chain adapters are opt-in. Kite Ozone testnet registers by default; every other network requires explicit env configuration (mainnets and Base Sepolia are OFF unless a `*_ENABLED=true` flag and its RPC are set).

| Chain | chainId | Token | Default | Notes |
|---|---|---|---|---|
| Kite Ozone testnet | 2368 | PYUSD (18 dec) | On | Live, E2E tested |
| Kite mainnet | 2366 | USDC.e | Off | Env-gated (`KITE_MAINNET_ENABLED`) |
| Avalanche Fuji | 43113 | USDC | Off | Registers when its RPC is set |
| Avalanche C-Chain | 43114 | USDC | Off | Env-gated (`AVALANCHE_MAINNET_ENABLED`) |
| Base Sepolia | 84532 | USDC (6 dec) | Off | Env-gated (`BASE_SEPOLIA_ENABLED`) |
| Base mainnet | 8453 | USDC (6 dec) | Off | Env-gated (`BASE_MAINNET_ENABLED`) |

Settlement method: EIP-3009 `TransferWithAuthorization`. A single `OPERATOR_PRIVATE_KEY` signs across all enabled chains today.

Mainnet adapters exist in code but ship disabled. Only enable a mainnet after validating on its testnet and funding the operator wallet with that chain's native gas.

## API

x402 spec-compliant. `/verify` and `/settle` require a facilitator API key in production (sent as the `x-facilitator-key` header).

| Method | Path | Purpose | On-chain |
|---|---|---|:---:|
| GET | `/health` | Liveness and version | No |
| GET | `/supported` | Enabled chains and methods (live registry) | No |
| GET | `/openapi.json` | OpenAPI 3.1 spec | No |
| GET | `/metrics` | Prometheus metrics (token-gated) | No |
| POST | `/verify` | Validate a signed authorization (read-only) | No |
| POST | `/settle` | Verify, then execute `transferWithAuthorization` | Yes |

Quick check against the live deployment:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported
```

## Quick start

### Prerequisites

- Node.js 22+
- Redis (local or hosted) for rate limiting, idempotency, and the settle cap
- An operator wallet holding native gas on each chain you enable
- Supabase project (optional, for the settlement audit ledger)

### Setup

```bash
git clone git@github.com:ferrosasfp/wasiai-facilitator.git
cd wasiai-facilitator
npm install
cp .env.example .env
# Set OPERATOR_PRIVATE_KEY, the RPC URLs for the chains you enable,
# REDIS_URL, and (in production) FACILITATOR_API_KEYS.
npm run dev
```

The server listens on port 3002 by default.

### Testing

```bash
npm test               # unit tests (vitest)
npm run test:coverage  # with coverage
npm run qa             # typecheck + lint + format check + tests
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full, documented list. The essentials:

| Variable | Purpose |
|---|---|
| `OPERATOR_PRIVATE_KEY` | Signer that submits settlements and pays gas. Never commit this. |
| `FACILITATOR_API_KEYS` | Comma-separated caller keys. Required in production; sent as `x-facilitator-key`. |
| `<CHAIN>_RPC_URL` / `<CHAIN>_ENABLED` | Per-chain RPC endpoint and opt-in flag. |
| `REDIS_URL` | Redis for rate limits, idempotency, and the settle cap. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list. Unset reflects any origin (dev only). |
| `METRICS_TOKEN` | Gates `GET /metrics`. Unset makes the endpoint fail-closed. |
| `SETTLE_CAP_*`, `CB_*`, `RATE_LIMIT_*` | Daily settle cap, circuit-breaker, and rate-limit tuning. |

Never place private keys, operator addresses, or any secret in code or in this repo. They belong only in your deployment environment.

## Security

This service signs transactions that move funds, so it is built to fail safe:

- **Simulate before settle.** Every on-chain transaction is `simulateContract`ed first.
- **Double-spend defense.** A short-lived idempotency cache and in-flight lock reduce double dispatch, and the on-chain EIP-3009 nonce is the definitive guard: a replay with the same nonce reverts on-chain.
- **Per-chain circuit breakers.** An RPC outage on one chain does not affect the others.
- **Boot-time domain check.** Startup refuses to proceed if a local EIP-712 domain separator drifts from the on-chain `DOMAIN_SEPARATOR()`.
- **Rate limiting.** Per-IP (pre-auth) plus per-key (post-auth), backed by Redis.
- **Hardened defaults.** Helmet security headers, CORS allow-list, token-gated metrics, and loud production warnings when a config is weaker than recommended.
- **CI scanning.** `eslint-plugin-security`, `eslint-plugin-no-secrets`, and `npm audit` in the pipeline.

## Deployment

The reference deployment runs as a persistent Node process on Railway. Build with `npm run build`, run with `npm start`.

## Ecosystem

- [`wasiai-a2a-gateway`](https://github.com/ferrosasfp/wasiai-a2a-gateway): the neutral A2A payment gateway that consumes this facilitator
- [WasiAI](https://wasiai.io): project landing

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Fernando Rosas (OpenClaw).
