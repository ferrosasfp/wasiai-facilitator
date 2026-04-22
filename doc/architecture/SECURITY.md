# Security — Threat Model & Mitigations

**wasiai-facilitator handles signed authorizations that move real funds.** Security is the highest priority engineering concern.

## Attack surface

### 1. Operator wallet compromise
- **Threat:** `OPERATOR_PRIVATE_KEY` leak → attacker drains wallet + signs malicious txs
- **Mitigations:**
  - V1: Env var encrypted at rest (Railway/Vercel standard)
  - V2: AWS KMS / HashiCorp Vault integration
  - V2: Multi-sig Safe wallet (threshold signing)
  - V1: Scheduled balance monitoring + alerts (low balance = possible drain)
  - Never log the private key — `Pino` redaction config
  - ESLint `no-secrets` plugin prevents hardcoding

### 2. Signature replay / double-spend
- **Threat:** attacker submits same signed authorization twice → double transfer
- **Mitigations:**
  - **Idempotency cache 120s** (x402 spec) — rejects duplicate `paymentId`
  - **EIP-3009 `nonce` field** — token contract itself prevents replay (bytes32 nonce, one-time use)
  - **Audit log** — persistent record of every verify/settle attempt
  - **Simulate before settle** — catches already-used nonces pre-execution

### 3. Invalid signature / impersonation
- **Threat:** attacker submits signature claiming to be someone else
- **Mitigations:**
  - `recoverTypedDataAddress()` (viem) validates signer === `authorization.from`
  - ERC-1271 fallback for smart accounts (validates via on-chain `isValidSignature()`)
  - Reject smart accounts on EIP-3009 path (they can't transferWithAuthorization — explicit error)

### 4. Amount / Receiver manipulation
- **Threat:** client sends authorization for X tokens but `accepted` says Y
- **Mitigations:**
  - Strict Zod schema validation on both `authorization` and `accepted`
  - Cross-check: `authorization.value >= accepted.amount`
  - Cross-check: `authorization.to === accepted.payTo` (exact match, checksummed)

### 5. Network mismatch
- **Threat:** cross-chain replay (same signature valid on two chains due to chainId bug)
- **Mitigations:**
  - EIP-712 domain includes `chainId` — signature only valid for that specific chain
  - Explicit `accepted.network === "eip155:<chainId>"` check before processing
  - Chain registry validates chainId is supported

### 6. RPC failure / gas griefing
- **Threat:** attacker spams /settle endpoint to drain operator wallet gas budget
- **Mitigations:**
  - Rate limiting per IP + per API key
  - Circuit breaker per chain (disable after N consecutive RPC failures)
  - `simulateContract` before `writeContract` — no gas spent on certain-to-fail txs
  - Max gas limits per chain (explicit `gas` param)
  - Wallet balance alerts (if drops below threshold → rate-limit more aggressively)

### 7. Dependency supply chain attack
- **Threat:** malicious update to viem/zod/etc. → compromised facilitator
- **Mitigations:**
  - `package-lock.json` committed
  - Snyk + Dependabot in CI (auto-scan CVEs)
  - `npm audit --audit-level=high` in CI
  - Manual review of major version bumps
  - Pin exact versions for blockchain libs (`viem`, not `^2.x`)

### 8. SQL injection / DB compromise
- **Threat:** attacker abuses Supabase queries to read/corrupt settlement ledger
- **Mitigations:**
  - Supabase parameterized queries (never string concat)
  - Service role key scoped to facilitator tables only (RLS policies)
  - Audit log append-only (no UPDATE/DELETE allowed by policy)

### 9. DDoS / abuse
- **Threat:** volumetric attack saturates facilitator, denies service
- **Mitigations:**
  - Rate limiting (per IP + per key)
  - Cloudflare in front (V1.1 — free tier)
  - Fastify `@fastify/helmet` for HTTP headers hardening
  - Request body size limit (16 KB max per request)

### 10. Cross-chain nonce collision
- **Threat:** nonce collision across different chains on same wallet
- **Mitigations:**
  - Each EIP-712 domain includes `verifyingContract` (token address) — collision requires same token address on multiple chains, extremely unlikely
  - `paymentId` in our idempotency cache includes chainId as discriminator

## Defense in depth

1. **Network edge** — Cloudflare (V1.1), Railway built-in DDoS
2. **App gateway** — rate limiting, request validation (Zod), body size limits
3. **Business logic** — simulate-before-settle, idempotency cache, signature recovery
4. **Blockchain** — EIP-3009 nonce prevents double-spend at contract level
5. **Persistence** — append-only audit log, RLS policies, encrypted secrets
6. **Monitoring** — Prometheus metrics, log aggregation, wallet balance alerts

## Incident response

- **Operator wallet compromised**: rotate `OPERATOR_PRIVATE_KEY`, transfer funds to new wallet, update Railway env. Circuit break affected chain temporarily.
- **Critical spec bug**: put facilitator in maintenance mode (deny all /settle), investigate, fix + deploy, restore.
- **Chain RPC outage**: circuit breaker auto-disables chain. Monitor + restore when RPC back.

## Secret handling

- **Never commit secrets to git** — `.gitignore` includes `.env`, `.env.*`
- **ESLint `no-secrets` plugin** — catches base64-looking strings, private keys, API keys
- **Pino log redaction** — configured to strip `privateKey`, `signature`, `nonce` from logs
- **Railway/Vercel env vars** — encrypted at rest, scoped per environment

## Audit readiness

All settlements produce immutable records in:
- `facilitator_settlements` — one row per settle attempt
- `facilitator_audit_log` — append-only event log

These are exportable for compliance/accounting/dispute resolution.

## Future (V2+)

- SOC 2 Type II audit (if revenue justifies)
- Penetration testing (external firm)
- Bug bounty program
- OFAC sanctioned address screening
- Chainanalysis / elliptic integration for AML
