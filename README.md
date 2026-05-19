# wasiai-facilitator

> Self-hosted x402 facilitator for EVM chains. Part of the WasiAI ecosystem.

## 🏆 Kite Hackathon 2026 submission

The wasiai-facilitator is the self-hosted x402 relayer that powers gasless settlement on Kite and Avalanche for the **WasiAI A2A** agent commerce gateway. Together with [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a) (the gateway) and [`wasiai-agentshop`](https://github.com/ferrosasfp/wasiai-agentshop) (the use case demo), it forms our Kite Hackathon 2026 submission.

| Resource | Link |
|---|---|
| 🌐 **Use case demo** | https://wasiai-agentshop.vercel.app/ |
| 🎬 **Demo video (3 min)** | https://www.youtube.com/watch?v=Ydh_sEJXgt4 |
| 🔗 **Sample on-chain tx** | [`0xf3eaa00a…0f1d674`](https://testnet.kitescan.ai/tx/0xf3eaa00a7e83c41b2b9d8247e39d32f564b36cd8745f91e3c080ff23f0f1d674) — PYUSD settle on Kite Ozone via this facilitator |
| 📦 **A2A gateway repo** | https://github.com/ferrosasfp/wasiai-a2a |
| 📦 **Use case repo** | https://github.com/ferrosasfp/wasiai-agentshop |
| 🎤 **Pitch deck** | https://wasiai.io/pitch-v6/ |

Built by Fernando Rosas and Elizabeth Palacios.

---

## What is this?

A [HTTP 402 Payment Required](https://docs.x402.org) protocol facilitator — verifies payment signatures off-chain and settles EIP-3009 `transferWithAuthorization` transactions on-chain, enabling gasless stablecoin micropayments between autonomous agents.

**Live URL**: `https://wasiai-facilitator-production.up.railway.app`

**👉 Integrating as a client?** See **[doc/HACKATHON.md](doc/HACKATHON.md)** for a full guide with code examples, error codes, and limits.

**Currently supported chains:**
| Chain              | chainId | Token | Status |
|--------------------|---------|-------|--------|
| Kite Ozone Testnet  | 2368    | PYUSD (18 dec) | ✅ Live + E2E tested |
| Kite Mainnet       | 2366    | USDC.e | Staged (env-gated) |
| Avalanche Fuji     | 43113   | USDC  | ✅ Live |
| Avalanche C-Chain Mainnet | 43114 | USDC | ✅ Live (mainnet hybrid mode) |
| Base Sepolia       | 84532   | USDC (6 dec) | Staged (env-gated, WKH-105) |
| Base Mainnet       | 8453    | USDC (6 dec) | Staged (env-gated, WKH-105) |

**Method:** EIP-3009 `TransferWithAuthorization`

**Roadmap:** Permit2, ERC-7710 delegations, Solana, Aptos, Stellar.

---

## API (x402 spec-compliant)

| Method | Path              | Purpose                                              | On-chain |
|--------|-------------------|------------------------------------------------------|:--------:|
| GET    | `/health`         | Liveness + version                                   | No       |
| GET    | `/supported`      | Supported chains + methods (reads live registry)     | No       |
| GET    | `/openapi.json`   | Full OpenAPI 3.1 spec                                | No       |
| POST   | `/verify`         | Validate EIP-3009 signed authorization (read-only)   | No       |
| POST   | `/settle`         | Verify + execute `transferWithAuthorization`         | **Yes**  |

Quick check:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported
```

Full integration guide: **[doc/HACKATHON.md](doc/HACKATHON.md)**.

---

## Supported Networks: Base

Base support (WKH-105) is implemented as an opt-in chain adapter pair following the same chain-adaptive pattern as Avalanche and Kite. Both Base networks are **disabled by default** — operators must explicitly opt in.

### Base Sepolia (chainId 84532)

Testnet — Circle USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals, EIP-712 domain `name="USDC"` v2). Use this for integration testing without spending real funds.

To enable on Railway / local:

```bash
BASE_SEPOLIA_ENABLED=true
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # or your Alchemy/Infura endpoint
```

Operator wallet must hold Base Sepolia ETH for gas — [Coinbase faucet](https://www.coinbase.com/faucets/base-sepolia-faucet).

### Base Mainnet (chainId 8453)

Production — native Circle USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals, EIP-712 domain `name="USD Coin"` v2). Mainnet moves real money — only enable after Sepolia validation and explicit operator approval.

```bash
BASE_MAINNET_ENABLED=true
BASE_MAINNET_RPC_URL=https://mainnet.base.org
```

Operator wallet must hold Base ETH (L2 native gas) before flipping the flag.

### Notes

- The EIP-712 `name` field on **Base Sepolia USDC literally returns `"USDC"`** (not `"USD Coin"` like the other Circle USDC deployments). This is verified on-chain via `cast call ... "name()(string)"`. The adapter encodes both variants — boot-time `initDomainCheck` (WFAC-53) will refuse to start if the local domain separator drifts from the on-chain `DOMAIN_SEPARATOR()`.
- Both Base networks reuse the existing per-chain `ChainCircuitBreaker` (CB_FAILURE_THRESHOLD, CB_ROLLING_WINDOW_MS, etc.) — RPC outages on one chain do not affect the others.
- A single `OPERATOR_PRIVATE_KEY` signs across all chains today (V1 multi-key story is a separate epic).

---

## Development

### Prerequisites
- Node.js 20+
- Redis (local or Upstash)
- Operator wallet with native gas token on each target chain
- Supabase project (optional, for settlement ledger)

### Setup

```bash
git clone git@github.com:ferrosasfp/wasiai-facilitator.git
cd wasiai-facilitator
npm install
cp .env.example .env
# Edit .env with OPERATOR_PRIVATE_KEY, RPCs, REDIS_URL
npm run dev
```

Server starts on port 3002.

### Testing

```bash
npm test                # unit tests
npm run test:coverage   # with coverage report
npm run qa              # typecheck + lint + format check + tests
```

### Deployment

Production deploy target: Railway (persistent Node process).

```bash
# Requires RAILWAY_TOKEN env var
railway up
```

---

## Security

This facilitator handles signed payment authorizations that move real funds. Security is paramount:

- **Simulate before settle** — every on-chain tx is `simulateContract`ed first
- **Idempotency cache** — 120s per-payload cache prevents double-spends (x402 spec)
- **Operator wallet** — single signer per chain; key rotation planned V2
- **Rate limiting** — per-IP + per-API-key (V1.5)
- **Security scanning** — Snyk, Dependabot, `eslint-plugin-security` in CI

See `doc/architecture/SECURITY.md` for threat model.

---

## Ecosystem

- [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a) — A2A Protocol gateway (consumes this facilitator)
- [`wasiai-agentshop`](https://github.com/ferrosasfp/wasiai-agentshop) — first use case on the stack (LATAM remittances on Kite, settled via this facilitator)
- [`wasiai-v2`](https://github.com/ferrosasfp/wasiai-v2) — Agent marketplace
- [WasiAI](https://wasiai.io) — Landing

---

## License

MIT © 2026 Fernando Rosas (OpenClaw)
