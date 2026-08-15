# wasiai-facilitator

> Self-hosted, multi-chain x402 facilitator. The settlement piece of WasiAI's neutral, open payment layer for the agent economy.

`wasiai-facilitator` turns a signed payment authorization into a settled on-chain payment. It implements the [HTTP 402 Payment Required](https://docs.x402.org) facilitator role: a caller sends a payment authorization, `/verify` says whether it is valid without touching the chain, and `/settle` makes it final on-chain.

The point of the service is that the caller does not need to know which chain it is talking about.

## Where this fits

WasiAI is a neutral, open, multi-chain payment layer for the agent economy, LATAM-first. The agent economy tends to fragment into walled gardens; WasiAI is the neutral ground: open standards, settlement on each agent's own chain, no lock-in.

This repo is one component of that layer, the settlement piece. It is infrastructure, not the whole layer and not an application. The gateway that routes and orchestrates agent-to-agent calls lives in [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a) and consumes this facilitator to settle payments.

⚠️ **If you were sent to `wasiai-a2a-gateway`, that is the wrong repo.** It still exists and still
resolves, so nothing reports it as broken, but it was last pushed on 2026-07-03 and predates every
Solana change described below. The live gateway is `wasiai-a2a` (last push 2026-08-15). The check is
`gh api repos/<owner>/<repo> --jq .pushed_at` on both, not whether the link opens.

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

   Side paths, Solana only, opt-in and off by default (three, not two):
     POST /solana/sponsor          fee-payer co-signs a validated tx and broadcasts
     POST /solana/escrow/release   release authority co-signs a validated release
     POST /solana/payout           facilitator ORIGINATES a transfer from its own ATA
```

The third one is not a variant of the other two. On `/settle` and on the first two side paths the
facilitator is a **witness or a co-signer** of a payment somebody else originated. On
`POST /solana/payout` it is the **treasurer**: it builds the transfer, signs it with its own key and
spends from its own token account. That is why it is a dedicated route with its own key and its own
caps, and never a mode of `/settle` — the head of `src/routes/solana-payout.ts` argues the point.

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

⚠️ **The `Default` column describes the shipped defaults, not the reference deployment.** On
2026-08-11 the two disagreed: the `curl .../supported` returned `eip155:43114` — Avalanche C-Chain
mainnet, not Fuji — with `rpc: ok` and breaker `CLOSED`. That meant `AVALANCHE_MAINNET_ENABLED=true`
was set while the table said "ships disabled". Both statements were true of different things.
On 2026-08-14 the flag was disabled in production. Read again on 2026-08-15, `43114` is gone and
`/supported` returns **four** networks, none of them mainnet: `eip155:2368` Kite Testnet,
`eip155:43113` Avalanche Fuji, `eip155:84532` Base Sepolia and `solana:devnet`. The claim that
matters is "no mainnet is registered", and it is the one to re-check — an earlier version of this
paragraph said `/supported` returned "only Fuji", which was never true of the response, only of the
Avalanche pair. The table and the deployment now align. **This paragraph is a dated reading, not a
property**: re-run the command rather than trusting it. When Avalanche mainnet was enabled, this README did not measure
whether the operator wallet held AVAX on 43114, or whether the destination gate would accept a settle
there. Those facts decide whether disabling the flag matters.

A mainnet should only be enabled after the matching testnet has been validated and, for EVM, after the operator wallet holds that chain's native gas. Solana needs no operator gas for `/settle`, since it does not broadcast. The side paths do: sponsorship needs a funded fee-payer, and payout needs both SOL for fees and a token balance to spend, which it pre-checks read-only before it claims anything.

The Solana fee-payer sponsorship, the escrow release path and the payout path are under active construction against devnet. Each is registered only when its flag is on and its key parses, so on a default deployment none of the three is present. `POST /solana/payout` has one gate more than the other two: its key must also be a *different* key from the fee-payer's and the release authority's, and a collision turns the route off rather than merging the two powers (`src/infra/solana-payout-operator.ts`).

## API

x402 spec-compliant. `/verify` and `/settle` require a facilitator API key in production, sent as `Authorization: Bearer <key>`. That is the only header the server reads (`src/middleware/auth.ts`); a request that carries the key anywhere else gets a 401.

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
| POST | `/solana/payout` | Originate an SPL transfer from the facilitator's own account | Yes |

That is the whole surface: nine routes, and `src/routes/` registers no others. The last three are
registered only when explicitly enabled, so on any given deployment a POST to them may 404 — which
is the intended answer for "off", not a bug.

Rather than trust the list, ask the deployment. `/supported` publishes `dedicatedRoutes`, and that
array is derived from the live router, not from a hand-kept constant:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported
```

Read on 2026-08-15 it returned `["POST /solana/sponsor","POST /solana/escrow/release"]` — so on the
reference deployment sponsorship and escrow release are on and **payout is off**, which a probe
confirms: `POST /solana/payout` there answers 404 while `POST /solana/sponsor` answers 401. Note the
three outcomes, not two: the field *absent* means the facilitator is older than this feature and is
not telling you anything, which is different from an empty array.

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
npm test               # vitest, whole suite (the run prints the file/test counts)
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
| `FACILITATOR_API_KEYS` | Comma-separated caller keys, required in production, sent as `Authorization: Bearer <key>` |
| `<CHAIN>_RPC_URL` / `<CHAIN>_ENABLED` | Per-chain RPC endpoint and opt-in flag |
| `REDIS_URL` | Rate limits, the "did we already handle this one?" checks, and the spending caps. **What breaks when it is unreachable is not the same everywhere, and each rail breaks in its own direction** — see the table below |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list. Set an explicit list in production |
| `METRICS_TOKEN` | Gates `GET /metrics`. Unset makes the endpoint fail closed |
| `SETTLE_CAP_*`, `CB_*`, `RATE_LIMIT_*` | Daily settle cap, circuit breaker and rate-limit tuning |
| `SOLANA_RPC_URL`, `SOLANA_USDC_MINT` | Register the Solana adapter. Both are required, otherwise it does not register |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED`, `SOLANA_FEE_PAYER_PRIVATE_KEY`, `SOLANA_SPONSOR_*` | Fee-payer sponsorship: flag, key, per-transaction and daily caps |
| `SOLANA_ESCROW_RELEASE_ENABLED`, `SOLANA_ESCROW_PROGRAM_ID`, `SOLANA_ESCROW_RELEASE_*` | Escrow release path |
| `SOLANA_PAYOUT_ENABLED`, `SOLANA_PAYOUT_OPERATOR_SECRET_KEY`, `SOLANA_PAYOUT_*` | Payout path: flag, its own operator key (which must differ from the other two), per-payout and daily caps, funding floor, rate limit and claim lease. All eight are documented in `.env.example` |

Private keys, operator addresses and secrets belong in the deployment environment, never in code and never in this repo.

### What a Redis outage does, per rail

Redis is best-effort for this service, but "best-effort" resolves in **opposite directions**
depending on the rail, and that asymmetry is deliberate. Measured 2026-08-11 by reading each
module rather than trusting the comment above it:

| Mechanism | Store | With Redis unreachable |
|---|---|---|
| Solana signature dedup (`infra/solana-dedup.ts`) | **Supabase**, `UNIQUE(signature)` | Unaffected. Does not use Redis at all |
| Solana sponsor cap (`core/solana-sponsor-cap.ts`) | Redis | **Fails CLOSED** (CD-6) → route returns 429 |
| Solana payout cap (`core/solana-payout-cap.ts`) | Redis | **Fails CLOSED** → rejects |
| EVM inflight settle lock (`core/idempotency.ts`) | Redis | Fails open (CD-7). Safe because the EIP-3009 on-chain nonce is the real backstop |
| EVM amount cap (`core/settle-cap.ts`, #1) | none | Fails CLOSED |
| EVM daily cap (`core/settle-cap.ts`, #2) | Redis | **Fails OPEN by default**; a caller may opt into `failMode: 'closed'` (WFAC-53) |

Two things follow, and the second is the one that costs a debugging session.

**The replay question has a durable answer on both rails, and they are different answers.** On
EVM it is the on-chain nonce: a second `transferWithAuthorization` with the same nonce reverts.
On Solana there is no such backstop, because the facilitator only verifies a transaction the
wallet already sent, so replay protection is a Postgres `UNIQUE(signature)` constraint that
does not depend on Redis and fails closed on any error. `infra/solana-dedup.ts` says so at the
top of the file. Do not read the CD-7 fail-open comment in `idempotency.ts` as covering
Solana: it is scoped to the EVM inflight lock and its safety argument is the EVM nonce.

⚠️ **And because the Solana caps fail closed, a Redis outage does not leak money, it stops the
sponsored deposit.** `POST /solana/sponsor` starts returning 429 while Redis is down, and
`POST /solana/payout` does the same on the rail below it. (An earlier version of this line called
the route `POST /methods/solana-sponsor`, which does not exist and answers 404 — the path in the
API table above is the real one, and the two disagreed inside this same file.)
On 2026-08-11 this was observed live: `/health` reported `degraded: true` with
`redis: unreachable`, and about twenty minutes later the same probe reported `degraded: false`
with `redis: ok`, so it comes and goes rather than staying down. **Nobody using the app is told
any of this**: the only sign is a run that fails at the deposit step. So when a sponsored deposit
gets rejected for no obvious reason, check `GET /health` first.

## Security

The service signs transactions that move funds, so it is built to fail safe.

- **Simulate before settle.** Every EVM transaction goes through `simulateContract` before it is submitted.
- **Boot-time domain check.** Startup refuses to proceed if a locally computed EIP-712 domain separator drifts from the token's on-chain `DOMAIN_SEPARATOR()`.
- **Double-spend defense.** An idempotency cache and an in-flight lock reduce double dispatch. On EVM the on-chain EIP-3009 nonce is the definitive guard: a replay with the same nonce reverts. On Solana the guard is a durable `UNIQUE(signature)` barrier, and it is fail-closed.
- **No key ever signs blind.** All three Solana signing paths — sponsorship, escrow release and payout — validate the exact instruction shape before the key touches the transaction, and all three reject rather than sign when anything is off. The escrow beneficiary is always read from on-chain state, never from the request body.
- **Separated instruments.** The sponsorship fee-payer, the escrow release authority and the payout operator are three distinct keys, and the separation is enforced in code, not asked for in a comment: if two of them resolve to the same pubkey, the payout route does not register. The blast radius is the reason — the fee-payer holds cents of SOL and co-signs network cost, while the payout operator owns the account holding the settlement balance.
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

- [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a): the neutral A2A payment gateway that consumes this facilitator. It is the caller of `POST /solana/payout` (`src/adapters/solana/facilitator-settle.ts` on that side). The older `wasiai-a2a-gateway` repo is not it — see the warning under [Where this fits](#where-this-fits)
- [WasiAI](https://wasiai.io): project landing

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Fernando Rosas (OpenClaw).
