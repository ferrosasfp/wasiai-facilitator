# wasiai-facilitator

> Production-grade self-hosted x402 facilitator for EVM chains. Part of the WasiAI ecosystem.

## What is this?

A [HTTP 402 Payment Required](https://docs.x402.org) protocol facilitator — verifies payment signatures off-chain and settles ERC-3009 `transferWithAuthorization` transactions on-chain, enabling gasless stablecoin micropayments between autonomous agents.

**Currently supported chains (V1):**
- Kite Testnet (chainId 2368) — PYUSD
- Kite Mainnet (chainId 2366) — *planned*
- Avalanche Fuji (chainId 43113) — USDC
- Avalanche Mainnet (chainId 43114) — USDC

**Currently supported methods (V1):**
- EIP-3009 (`transferWithAuthorization`)

**Coming soon:**
- Permit2
- ERC-7710 delegations
- Solana / Aptos / Stellar adapters

---

## API (x402 spec-compliant)

### `POST /verify`

Verify an EIP-712 signed payment authorization off-chain.

```bash
curl -X POST https://facilitator.wasiai.io/verify \
  -H "Content-Type: application/json" \
  -d @payment.json
```

### `POST /settle`

Verify + execute on-chain. Facilitator operator wallet pays gas; user pays zero gas.

```bash
curl -X POST https://facilitator.wasiai.io/settle \
  -H "Content-Type: application/json" \
  -d @payment.json
```

### `GET /supported`

List supported networks, schemes, and tokens.

```bash
curl https://facilitator.wasiai.io/supported
```

### `GET /health`

Liveness + readiness check. Returns status of each configured chain.

```bash
curl https://facilitator.wasiai.io/health
```

### `GET /metrics`

Prometheus-format metrics.

See `openapi.yaml` for complete API reference.

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
