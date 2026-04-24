# Auto-Blindaje — WFAC-33

## [2026-04-23] W4 — Test assumption about idempotencyKey shape

- **Error**: T-AR-1, T-AR-2, T-AR-4 asserting that `idempotencyKey` is a 64-char hex string via `/^[0-9a-f]{64}$/` / `.length === 64`.
- **Causa raíz**: `buildSettleIdempotencyKey(parsed)` returns the **full Redis key** `settle:idempotency:<sha256-hex>` (length 83), not the raw hex. This is the value propagated into `request.auditMeta.idempotencyKey` by the route and therefore into the audit row. The Story File's DDL `COMMENT ON COLUMN facilitator_audit_log.idempotency_key` claim that it is "sha256 hex (64 chars)" describes the intended semantic but the **implementation stores the prefixed key** (matching the existing settle flow). This is not a CD violation — it mirrors the Redis cache lookup key used elsewhere.
- **Fix**: tests assert the prefix (`settle:idempotency:`) + 64-hex suffix instead of the bare hex. Production audit rows will contain the prefixed key; downstream consumers that want to JOIN with `facilitator_settlements.idempotency_key` must apply the same transformation on both sides (or the ledger service also stores the prefixed key — confirmed via `ledger.ts` line ~111 where `idempotency_key: input.idempotencyKey` gets the same prefixed value).
- **Aplicar en**: future HUs touching audit/ledger linkage. If a follow-up requires a clean 64-char hex for JOIN purposes, strip the prefix at the builder layer, NOT in the DB. Document in the SDD before changing.

## [2026-04-23] W4 — light-my-request injects default user-agent

- **Error**: T-AR-8 asserting `userAgentRaw === null` when `user-agent` header omitted from `app.inject({...})`.
- **Causa raíz**: `light-my-request` (Fastify's inject transport) injects the literal default UA `'lightMyRequest'` when no explicit header is provided. There is no way to `app.inject()` a genuinely empty UA short of passing `headers: { 'user-agent': '' }` explicitly.
- **Fix**: use `headers: { 'user-agent': '' }` to exercise the empty-string coerces-to-null path. The production path (no UA header at all) is already covered by the pure `buildAuditEntry` unit tests (T-A8).
- **Aplicar en**: any future route test that wants to exercise the null-UA branch via `app.inject`. Prefer the builder unit test for null-header semantics; use injection only to validate propagation when a UA IS present or when simulating an empty string.
