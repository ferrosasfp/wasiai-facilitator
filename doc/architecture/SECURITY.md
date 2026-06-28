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
  - **V1 — single hot key per chain (WFAC-53 FIX-3):** the facilitator uses a
    single `OPERATOR_PRIVATE_KEY` env var across all 4 enabled chains. Blast
    radius of a key compromise = all 4 chains drained simultaneously.
  - **V2 recommendation:** separate hot keys per chain (e.g.
    `OPERATOR_PRIVATE_KEY_KITE`, `OPERATOR_PRIVATE_KEY_AVAX`) so a single-chain
    compromise does not drain the full operator fleet.
  - **Env vars that MUST NOT be logged** (Pino redaction list, enforced via
    `no-console` + log redaction config):
      - `OPERATOR_PRIVATE_KEY`
      - `SUPABASE_SERVICE_KEY`

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
- **Pino log redaction** — `redact` is configured on the logger
  (`src/infra/logger.ts`) and applied in every mode (dev/test/prod). It replaces
  secret-bearing fields with `[Redacted]` BEFORE serialization, both at the top
  level and one level deep (`*.<field>`). Covered fields include
  `privateKey` / `OPERATOR_PRIVATE_KEY`, `apiKey` / `FACILITATOR_API_KEY`,
  `SUPABASE_SERVICE_KEY`, `secret`, `token`, `password`, `signature`, `nonce`,
  and `authorization` / `cookie` / `set-cookie` headers. Regression-guarded by
  `src/__tests__/unit/logger.redact.test.ts`.
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

## Failure modes (WFAC-53 FIX-3)

The facilitator integrates 3 dependencies whose outage degrades security
posture in different ways. This section documents the graceful-degradation
choices and how to tighten them in production.

### Redis outage → rate-limit bypass
- **Mechanism:** `@fastify/rate-limit` is configured with `skipOnError: true`
  (`src/app.ts` line ~127, WFAC-40 DT-10). If Redis is unreachable or throws on
  `INCR`, the plugin allows the request through (fail-open).
- **Surface:** during a Redis outage, per-IP rate limits are not enforced.
  Burst-from-single-IP attacks become viable until Redis recovers.
- **Why fail-open here:** rate-limit is a defense-in-depth signal, not the
  authoritative budget. The authoritative budget (operator wallet balance)
  is enforced by `SETTLE_DAILY_GLOBAL_CAP` (see below).
- **Mitigation:** operators that need strict per-IP enforcement during Redis
  outages can swap to a `failOpen: false` rate-limit config in V2.

### Redis outage → SETTLE_DAILY_GLOBAL_CAP fail-open (default) or fail-closed (opt-in)
- **Mechanism:** `incrementAndCheckDailyCap` in `src/core/settle-cap.ts` does
  `client.incr(key)` to enforce a global daily settle cap. The behavior on
  Redis throw is configurable via `SETTLE_CAP_FAIL_MODE` (WFAC-53 FIX-6):
    - `SETTLE_CAP_FAIL_MODE=open` (default, preserves V1 behavior): request
      allowed through. Surface = unbounded settle count until Redis recovers.
    - `SETTLE_CAP_FAIL_MODE=closed` (opt-in): HTTP 503 SERVICE_UNAVAILABLE.
      Surface = service degrades protectively; legitimate clients see 503 but
      operator wallet is safe.
- **Recommendation:** set `SETTLE_CAP_FAIL_MODE=closed` in any production
  deployment where the operator wallet balance is significant (>$1k).
- **Trade-off:** fail-closed degrades availability during Redis outages; fail-
  open trades availability for protection against budget overrun. There is no
  free lunch — operators choose.

### EIP-712 Domain separator drift → boot refused (WFAC-53 FIX-2)
- **Mechanism:** at boot, `initDomainCheck` (`src/chains/init-domain-check.ts`)
  calls `DOMAIN_SEPARATOR()` on each chain's token contract and compares with
  the locally computed EIP-712 separator. If they differ on a chain with a
  reachable RPC, the process logs FATAL and exits(1).
- **Why fatal:** a separator mismatch means the metadata in
  `src/chains/<chain>.ts` (`eip712Name`, `eip712Version`, token `address`) has
  drifted from the live token contract — every signature the facilitator
  verifies would be against the wrong domain → silent acceptance of
  cross-chain replays or forged signatures. Refusing to boot is the only safe
  outcome.
- **RPC unreachable handling:** if a chain's RPC is unreachable or times out,
  the check logs WARN and allows boot to continue (non-blocking — the check
  retries implicitly on the next deployment).

## Reporting (WFAC-53 FIX-3)

If you discover a vulnerability affecting wasiai-facilitator, please disclose
responsibly via:

- **Email:** `fernando@wasiai.io` _(temporary direct contact; will migrate to `security@wasiai.io` group inbox in V1.1)_
- **Acknowledgement SLA:** 48 hours for first response (business days).
- **Public disclosure:** coordinated, after a fix is shipped (90-day default
  embargo).
- **Scope:** signature verification, settle execution, idempotency, audit log,
  rate limiting, circuit breaker, domain separator drift, dependency CVEs,
  any reachable secret leak.
- **Out of scope:** social-engineering of operators, DoS by overwhelming a
  third-party RPC, theoretical attacks requiring control of the chain itself.

For non-security bug reports use GitHub Issues; for security reports use email
only (do NOT open public Issues for unpatched vulnerabilities).

> **Status (2026-05-12):** `fernando@wasiai.io` confirmed as temporary contact
> by operator. Migration to `security@wasiai.io` group inbox tracked as V1.1
> (no specific ticket — operational, not code).
