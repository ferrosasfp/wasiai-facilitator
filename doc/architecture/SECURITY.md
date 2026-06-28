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
- **Mechanism:** `@fastify/rate-limit`'s `skipOnError` is wired to the
  `RATE_LIMIT_FAIL_OPEN` env (`src/app.ts`, AUDIT). **Default `true`** (legacy
  behavior): if Redis is unreachable or throws on `INCR`, the plugin allows the
  request through (fail-open).
- **Surface:** with `RATE_LIMIT_FAIL_OPEN=true`, during a Redis outage per-IP /
  per-key rate limits are not enforced. Burst-from-single-IP attacks become
  viable until Redis recovers.
- **Why fail-open is the DEFAULT (not flipped to closed):** a transient Redis
  blip must not hard-break the whole service. The authoritative budget
  protection is `SETTLE_DAILY_GLOBAL_CAP`, which is **fail-closed by default**
  (`SETTLE_CAP_FAIL_MODE=closed`, see below) — so wallet-drain is already
  bounded even when rate-limit is fail-open.
- **Prod recommendation:** set `RATE_LIMIT_FAIL_OPEN=false` for strict
  enforcement, **but only with Redis HA** — a sustained outage will then reject
  all rate-limited requests. The app logs a loud `warn` at boot when running in
  production with `RATE_LIMIT_FAIL_OPEN=true`.
- **Two rate-limit layers (AUDIT / BLQ-MED-1):** the money-path routes
  (`/verify`, `/settle`) are protected by TWO independent `@fastify/rate-limit`
  registrations (`src/app.ts`):
    - **Layer 1 — global, `onRequest`, per-IP.** Runs BEFORE caller auth, so
      unauthenticated / wrong-bearer floods are throttled per client IP (a bad
      bearer is counted by this layer, then rejected 401 by auth; once the IP
      exceeds the cap it gets 429, not unbounded 401s). This is the pre-auth
      DoS/brute-force guard.
    - **Layer 2 — per-key, `preHandler`, keyed by `facilitatorKeyId`.** Runs
      AFTER `requireFacilitatorKey` has matched a caller key and stamped
      `facilitatorKeyId = sha256(matched key)[:16]` (non-secret). Distinct
      rotated keys behind one shared IP get independent budgets, so one key
      cannot exhaust another's allowance. Raw keys are never used as Redis keys
      nor logged.
  Both layers read the same per-route cap (`RATE_LIMIT_VERIFY_MAX` /
  `RATE_LIMIT_SETTLE_MAX`); Layer 2 only ever ADDS a per-key bound and never
  weakens the per-IP guarantee of Layer 1.

### Redis outage → SETTLE_DAILY_GLOBAL_CAP fail-closed (default) or fail-open (opt-in)
- **Mechanism:** `incrementAndCheckDailyCap` in `src/core/settle-cap.ts` does
  `client.incr(key)` to enforce a global daily settle cap. The behavior on
  Redis throw is configurable via `SETTLE_CAP_FAIL_MODE`:
    - `SETTLE_CAP_FAIL_MODE=closed` (**DEFAULT, AUDIT** — secure-by-default):
      HTTP 503 SERVICE_UNAVAILABLE. Surface = service degrades protectively;
      legitimate clients see 503 but the operator wallet is safe from
      unbounded settlement during a Redis outage.
    - `SETTLE_CAP_FAIL_MODE=open` (opt-in, availability-first): request allowed
      through. Surface = unbounded settle count until Redis recovers
      (wallet-drain risk).
- **AUDIT change:** the default flipped from `open` to `closed`. For a payment
  service a missing/unset env must be the SECURE choice. The app logs a loud
  `warn` at boot when running in production with `SETTLE_CAP_FAIL_MODE=open`.
- **Trade-off:** fail-closed degrades availability during Redis outages; fail-
  open trades availability for protection against budget overrun. There is no
  free lunch — operators who prefer availability can opt into `open`.

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
