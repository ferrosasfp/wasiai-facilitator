# x402 Protocol Conformance — wasiai-facilitator

This document tracks our conformance with the [x402 protocol specification](https://docs.x402.org) and documents any deliberate deviations.

## Spec version

We target **x402Version: 2** (current as of 2026-04-21).

## Endpoints

| Endpoint | Spec requirement | Our implementation | Conformance |
|----------|------------------|--------------------|-----|
| `POST /verify` | MUST validate signature + pre-conditions off-chain | `src/routes/verify.ts` → `src/core/verify.ts` | ✅ Full |
| `POST /settle` | MUST execute on-chain settlement + wait receipt | `src/routes/settle.ts` → `src/core/settle.ts` | ✅ Full |
| `GET /supported` | SHOULD list supported networks/schemes | `src/routes/supported.ts` → `src/chains/registry.ts` | ✅ Full |
| `GET /health` | SHOULD provide liveness | `src/routes/health.ts` | ✅ Extra |
| `GET /metrics` | Optional (Prometheus) | `src/routes/metrics.ts` | ✅ Extra |

## Schemes

| Scheme | Status | Location |
|--------|--------|----------|
| `exact` + EIP-3009 | ✅ V1 | `src/methods/eip3009/` |
| `exact` + Permit2 | 🔜 V1.5 | `src/methods/permit2/` |
| `exact` + ERC-7710 | 🔜 V2 | `src/methods/erc7710/` |

## Verification checks (EIP-3009, spec-literal)

For each request to `/verify` or `/settle`, we perform in order:

1. ✅ **Signature recovery** — `recoverTypedDataAddress()` matches `authorization.from`
2. ✅ **Client balance** — client has sufficient asset balance (read `balanceOf`)
3. ✅ **Amount validation** — `auth.value >= accepted.amount`
4. ✅ **Timestamp window** — `validAfter <= now <= validBefore`
5. ✅ **Token + network match** — asset address + chainId match `accepted`
6. ✅ **simulateContract** — simulate `transferWithAuthorization` before settling on mainnet

## Standard error codes (spec)

Mapped in `src/core/errors.ts`:

| Spec code | HTTP status | Trigger |
|-----------|-------------|---------|
| `INVALID_SIGNATURE` | 401 | Sig recovery fails |
| `INSUFFICIENT_BALANCE` | 402 | `balanceOf` < amount |
| `PERMIT2_ALLOWANCE_REQUIRED` | 412 | (Permit2 method only) |
| `EXPIRED_AUTHORIZATION` | 400 | `now` outside window |
| `NETWORK_MISMATCH` | 400 | `chainId` not supported |
| `SIMULATION_FAILED` | 500 | `simulateContract` throws |
| `INVALID_AMOUNT` | 400 | Amount too small/zero |
| `INVALID_RECEIVER` | 400 | `payTo` mismatch |
| `TRANSACTION_FAILED` | 500 | On-chain exec reverts |
| `DELEGATION_INVALID` | 401 | (ERC-7710 only) |

## Idempotency

**Spec requirement:** short-lived in-memory cache (120s) to reject duplicate settlements.

**Our implementation:** `src/core/idempotency.ts`
- Primary: Redis with TTL 120s (key: `idempotency:<paymentIdHash>`)
- Fallback: in-memory `Map` with interval cleanup (if Redis down)
- Persistence: Supabase `facilitator_idempotency` table (audit trail only, not enforcement)

## Security additions beyond spec

These are our additions that go beyond the minimum spec:

- **Circuit breaker per chain** — auto-disable a chain if RPC fails N times
- **Rate limiting** — per-IP + per-API-key (planned V1.5)
- **Audit log** — append-only log of every verify/settle attempt
- **Wallet balance monitoring** — alerts when operator wallet low on gas
- **Security scanning in CI** — Snyk + Dependabot + ESLint security plugins

## Known deviations / intentional differences

*(To be populated as implementation progresses)*

## Conformance testing

See `src/__tests__/contract/` — tests that verify our shapes match the spec fixtures.

Future: interoperability test suite with:
- Coinbase CDP x402 reference clients (via `x402-fetch` npm package)
- Pieverse-format payloads (for backward compatibility)

## References

- [x402.org — Protocol Introduction](https://www.x402.org)
- [docs.x402.org — Full docs index](https://docs.x402.org/llms.txt)
- [docs.x402.org/core-concepts/facilitator](https://docs.x402.org/core-concepts/facilitator.md)
- [github.com/coinbase/x402 — Reference implementations](https://github.com/coinbase/x402)
- [EIP-3009 — transferWithAuthorization](https://eips.ethereum.org/EIPS/eip-3009)
- [EIP-712 — Typed data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)
