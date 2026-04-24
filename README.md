# wasiai-facilitator

> Self-hosted x402 facilitator for EVM chains. Part of the WasiAI ecosystem.

## What is this?

A [HTTP 402 Payment Required](https://docs.x402.org) protocol facilitator — verifies payment signatures off-chain and settles EIP-3009 `transferWithAuthorization` transactions on-chain, enabling gasless stablecoin micropayments between autonomous agents.

**Live URL**: `https://wasiai-facilitator-production.up.railway.app`

**👉 Integrating as a client?** See **[doc/HACKATHON.md](doc/HACKATHON.md)** for a full guide with code examples, error codes, and limits.

**Currently supported (V1):**
| Chain              | chainId | Token | Status |
|--------------------|---------|-------|--------|
| Kite Testnet       | 2368    | PYUSD (18 dec) | ✅ Live + E2E tested |
| Kite Mainnet       | 2366    | —     | Opt-in (env-gated) |
| Avalanche Fuji     | 43113   | USDC  | Stub (WFAC-52 pending) |

**Method:** EIP-3009 `TransferWithAuthorization`

**Roadmap:** Permit2, ERC-7710 delegations, Solana/Aptos/Stellar, Avalanche real.

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

- [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a) — A2A Protocol gateway (consumes facilitator)
- [`wasiai-v2`](https://github.com/ferrosasfp/wasiai-v2) — Agent marketplace
- [WasiAI](https://wasiai.io) — Landing

---

## License

MIT © 2026 Fernando Rosas (OpenClaw)
