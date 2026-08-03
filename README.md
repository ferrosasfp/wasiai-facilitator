# wasiai-facilitator

> Self-hosted, multi-chain x402 facilitator. The settlement piece of WasiAI's neutral, open payment layer for the agent economy.

`wasiai-facilitator` turns a signed payment authorization into a settled on-chain payment. It implements the [HTTP 402 Payment Required](https://docs.x402.org) facilitator role: a caller sends a payment authorization, `/verify` says whether it is valid without touching the chain, and `/settle` makes it final on-chain.

The point of the service is that the caller does not need to know which chain it is talking about.

## Where this fits

WasiAI is a neutral, open, multi-chain payment layer for the agent economy, LATAM-first. The agent economy tends to fragment into walled gardens; WasiAI is the neutral ground: open standards, settlement on each agent's own chain, no lock-in.

This repo is one component of that layer, the settlement piece. It is infrastructure, not the whole layer and not an application. The gateway that routes and orchestrates agent-to-agent calls lives in [`wasiai-a2a-gateway`](https://github.com/ferrosasfp/wasiai-a2a-gateway) and consumes this facilitator to settle payments.

## The multi-chain part

Two HTTP endpoints, `/verify` and `/settle`, cover every supported network. The caller sends a CAIP-2 network id (`eip155:43113`, `solana:devnet`) and the facilitator routes to the adapter registered under it. There is no per-chain endpoint, no per-chain client, no branching in the caller.

That uniform surface hides a real asymmetry, and the asymmetry is the interesting part.

**On EVM chains the facilitator transmits the transaction.** The payer signs an EIP-3009 `TransferWithAuthorization` message off-chain: a signature, not a transaction. It cannot reach the chain on its own. The facilitator recovers the signer, checks the EIP-712 domain against the token's on-chain `DOMAIN_SEPARATOR()`, simulates the call, and then submits `transferWithAuthorization` from the operator wallet. The operator pays gas. The payer needs no native token at all, only USDC and a signature.

**On Solana the facilitator verifies a transaction the wallet already sent.** SPL transfers have no EIP-3009 equivalent, so there is nothing to relay: the wallet builds, signs and broadcasts its own transfer. The facilitator's job on `/settle` is to confirm it happened, and to confirm it honestly. It fetches the transaction at `finalized` commitment, pins the mint by exact pubkey and token-program id rather than by symbol or metadata, derives the amount as the net delta of pre/post token balances as a `BigInt` rather than from `uiAmount`, and records the signature behind a durable `UNIQUE` constraint so the same transfer cannot be claimed twice. That barrier is fail-closed: if the dedup store cannot be reached, the settlement is rejected rather than accepted.

**And on Solana the facilitator can also pay the fee for a user who has no SOL.** This is a separate path, `POST /solana/sponsor`. The client builds a transaction with the facilitator's fee-payer as `feePayer`, signs its own part, and sends the partially-signed transaction. The facilitator parses it, checks that the wallet named in the instruction actually authorized this sponsorship, runs a structural validator against the exact instruction shape it is willing to sponsor, and only then adds the fee-payer signature and broadcasts. It never signs an opaque blob on the strength of declared metadata: a signature that does not authorize the transaction, a parse failure, an unrecognized instruction, a fee above the cap, a daily-cap hit or a stale blockhash all return without signing. The authorization check runs first, before the per-caller rate counter, before the daily cap and before the fee-payer key is ever read, so a request that fails it reserves no budget and touches no key. It does consume one token of the transport-level rate limit, like every other request. Concurrent sponsorships serialize through a mutex, so the single fee-payer keypair never interleaves signing state.

So the same user-visible property, "you can pay without holding native gas", is delivered two different ways: on EVM by relaying a signature the user could not broadcast, on Solana by co-signing a transaction the user could not afford. One API, two mechanisms, and the adapter boundary is where the difference lives.

Adding a network means writing one adapter and registering it. Nothing in `core/` or `routes/` learns a new name.

```
                POST /verify          POST /settle
                     |                     |
                     +----------+----------+
                                |
                     core/verify.ts, core/settle.ts
                     idempotency, settle cap, ledger, audit log
                                |
                       ChainRegistry.getAdapterByNetworkId(...)
                                |
        +-----------------------+-----------------------+
        |                                               |
   eip155:*                                        solana:*
   ChainAdapter                                SettlementAdapter
   (verify + settle, broadcasts)               (verify-only, no broadcast)
        |                                               |
   BaseEip3009Adapter                            SolanaAdapter
   simulate -> transferWithAuthorization         getTransaction(finalized)
   operator wallet signs and pays gas            mint + program-id pin
        |                                        balance delta as BigInt
        |                                        UNIQUE(signature), fail-closed
        |                                               |
   kite.ts   avalanche.ts   base.ts              solana-adapter.ts
   (2368/2366) (43113/43114) (84532/8453)        (devnet/mainnet)

   Side paths, Solana only, opt-in and off by default:
     POST /solana/sponsor          fee-payer co-signs a validated tx and broadcasts
     POST /solana/escrow/release   release authority co-signs a validated release
```

## Supported chains

Chain adapters are opt-in. Kite Ozone testnet registers by default; every other network requires explicit env configuration. All mainnets are off unless a `*_ENABLED=true` flag and its RPC are set.

| Chain | Network id | Token | Default | Settlement | Status |
|---|---|---|---|---|---|
| Kite Ozone testnet | `eip155:2368` | PYUSD (18 dec) | On | EIP-3009, facilitator broadcasts | Runs on testnet, exercised end to end |
| Kite mainnet | `eip155:2366` | USDC.e | Off | EIP-3009, facilitator broadcasts | Adapter exists, ships disabled |
| Avalanche Fuji | `eip155:43113` | USDC | Off | EIP-3009, facilitator broadcasts | Runs on testnet |
| Avalanche C-Chain | `eip155:43114` | USDC | Off | EIP-3009, facilitator broadcasts | Adapter exists, ships disabled |
| Base Sepolia | `eip155:84532` | USDC (6 dec) | Off | EIP-3009, facilitator broadcasts | Runs on testnet |
| Base mainnet | `eip155:8453` | USDC (6 dec) | Off | EIP-3009, facilitator broadcasts | Adapter exists, ships disabled |
| Solana devnet | `solana:devnet` | SPL USDC | Off | Verify-only, wallet broadcasts | Runs on devnet |
| Solana mainnet | `solana:mainnet` | SPL USDC | Off | Verify-only, wallet broadcasts | Adapter exists, ships disabled |

A mainnet should only be enabled after the matching testnet has been validated and, for EVM, after the operator wallet holds that chain's native gas. Solana needs no operator gas for `/settle`, since it does not broadcast; the sponsorship path does need a funded fee-payer.

The Solana fee-payer sponsorship and the escrow release path are under active construction against devnet. Each is registered only when its flag is on and its key parses, so on a default deployment neither is present.

## API

x402 spec-compliant. `/verify` and `/settle` require a facilitator API key in production, sent as the `x-facilitator-key` header.

| Method | Path | Purpose | Signs on-chain |
|---|---|---|:---:|
| GET | `/health` | Liveness, version, per-chain RPC probe | No |
| GET | `/supported` | Registered networks and methods, read from the live registry | No |
| GET | `/openapi.json` | OpenAPI 3.1 spec | No |
| GET | `/metrics` | Prometheus metrics, token-gated | No |
| POST | `/verify` | Validate a payment authorization, no state change | No |
| POST | `/settle` | Settle: broadcast on EVM, confirm and record on Solana | EVM only |
| POST | `/solana/sponsor` | Co-sign a validated transaction as fee-payer and broadcast | Yes |
| POST | `/solana/escrow/release` | Co-sign a validated escrow release and broadcast | Yes |

The last two are registered only when explicitly enabled.

Quick check against the live deployment:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported
```

## Quick start

### Prerequisites

- Node.js 22 or newer
- Redis, local or hosted, for rate limiting, idempotency and the settle cap
- For EVM chains, an operator wallet holding native gas on each chain you enable
- Supabase project, optional, for the settlement ledger and the Solana dedup barrier

### Setup

```bash
git clone https://github.com/ferrosasfp/wasiai-facilitator.git
cd wasiai-facilitator
npm install
cp .env.example .env
# Set OPERATOR_PRIVATE_KEY, the RPC URLs for the chains you enable,
# REDIS_URL, and, in production, FACILITATOR_API_KEYS.
npm run dev
```

The server listens on port 3002 by default.

### Testing

```bash
npm test               # vitest, 1052 tests across 76 files
npm run test:coverage  # with coverage
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, zero warnings allowed
npm run qa             # typecheck + lint + format check + tests
```

Other scripts: `npm run build` (tsc), `npm start` (run the build), `npm run format`, `npm run security:audit` (`npm audit --audit-level=high`), `npm run ops:check-gas` (report the operator wallet balance on each enabled chain).

## Configuration

Everything is configured through environment variables. `.env.example` documents the EVM side in full. The essentials:

| Variable | Purpose |
|---|---|
| `OPERATOR_PRIVATE_KEY` | Signer that submits EVM settlements and pays gas |
| `FACILITATOR_API_KEYS` | Comma-separated caller keys, required in production, sent as `x-facilitator-key` |
| `<CHAIN>_RPC_URL` / `<CHAIN>_ENABLED` | Per-chain RPC endpoint and opt-in flag |
| `REDIS_URL` | Rate limits, idempotency and the daily settle cap |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list. Set an explicit list in production |
| `METRICS_TOKEN` | Gates `GET /metrics`. Unset makes the endpoint fail closed |
| `SETTLE_CAP_*`, `CB_*`, `RATE_LIMIT_*` | Daily settle cap, circuit breaker and rate-limit tuning |
| `SOLANA_RPC_URL`, `SOLANA_USDC_MINT` | Register the Solana adapter. Both are required, otherwise it does not register |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED`, `SOLANA_FEE_PAYER_PRIVATE_KEY`, `SOLANA_SPONSOR_*` | Fee-payer sponsorship: flag, key, per-transaction and daily caps |
| `SOLANA_ESCROW_RELEASE_ENABLED`, `SOLANA_ESCROW_PROGRAM_ID`, `SOLANA_ESCROW_RELEASE_*` | Escrow release path |

Private keys, operator addresses and secrets belong in the deployment environment, never in code and never in this repo.

## Security

The service signs transactions that move funds, so it is built to fail safe.

- **Simulate before settle.** Every EVM transaction goes through `simulateContract` before it is submitted.
- **Boot-time domain check.** Startup refuses to proceed if a locally computed EIP-712 domain separator drifts from the token's on-chain `DOMAIN_SEPARATOR()`.
- **Double-spend defense.** An idempotency cache and an in-flight lock reduce double dispatch. On EVM the on-chain EIP-3009 nonce is the definitive guard: a replay with the same nonce reverts. On Solana the guard is a durable `UNIQUE(signature)` barrier, and it is fail-closed.
- **The fee-payer never signs blind.** Sponsorship and escrow release both validate the exact instruction shape before the key touches the transaction, and both reject rather than sign when anything is off. The escrow beneficiary is always read from on-chain state, never from the request body.
- **Per-chain circuit breakers.** An RPC outage on one chain does not affect the others.
- **Caps and limits.** A daily settle cap, per-transaction and per-day sponsorship caps, and rate limiting per IP before auth and per key after auth.
- **Hardened defaults.** Helmet headers, CORS allow-list, token-gated metrics, and hex scrubbing in logs.
- **CI scanning.** `eslint-plugin-security`, `eslint-plugin-no-secrets` and `npm audit` run in the pipeline.

The threat model is written up in [`doc/architecture/SECURITY.md`](doc/architecture/SECURITY.md).

## Documentation

- [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md): the adapter and registry design, and how to add a network
- [`doc/architecture/X402-CONFORMANCE.md`](doc/architecture/X402-CONFORMANCE.md): what the service implements from the x402 spec, and where it deviates on purpose
- [`doc/architecture/SECURITY.md`](doc/architecture/SECURITY.md): threat model and mitigations
- [`doc/openapi.yaml`](doc/openapi.yaml): the API contract
- [`OWNERS.md`](OWNERS.md): module boundaries, which layer may import which

## Deployment

The reference deployment runs as a persistent Node process on Railway. Build with `npm run build`, run with `npm start`.

## Ecosystem

- [`wasiai-a2a-gateway`](https://github.com/ferrosasfp/wasiai-a2a-gateway): the neutral A2A payment gateway that consumes this facilitator
- [WasiAI](https://wasiai.io): project landing

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Fernando Rosas (OpenClaw).
