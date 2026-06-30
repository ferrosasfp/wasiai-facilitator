/**
 * payTo receiver allowlist (ECOSYSTEM-AUDIT TB-04).
 *
 * THREAT: any holder of a valid FACILITATOR_API_KEY can today call /settle with
 * an arbitrary `accepted.payTo`, so a leaked/over-broad key can drain authorized
 * funds to an attacker-controlled receiver. The matched key id is currently used
 * only for rate-limit bucketing, not authorization.
 *
 * MINIMAL FIX (backward-compatible): an OPTIONAL allowlist of permitted `payTo`
 * receivers, configured via `FACILITATOR_PAYTO_ALLOWLIST` (comma-separated
 * addresses). When the allowlist is NON-EMPTY, a /settle whose body `payTo` is
 * not in the list is rejected BEFORE any chain interaction. When it is EMPTY /
 * unset, behavior is unchanged (every receiver allowed) — so existing
 * deployments are unaffected until they opt in.
 *
 * SCOPE NOTE (per-key granularity → DEFER-TO-HU): the audit asked for a per-key
 * allowlist keyed by the facilitator key id. A GLOBAL allowlist already closes
 * the "settle to ANY receiver" gap with a one-line operator config and zero
 * key-management burden. Per-key keying requires the operator to maintain a
 * keyId→receivers map (and to derive each key's sha256 id), which is a
 * key-management feature, not a focused security patch. See the DEFER-TO-HU
 * note in the audit remediation report.
 *
 * Boundaries (OWNERS.md row `src/core/`): pure helper. No I/O, no logger, no
 * SDK clients (NO viem import — addresses are compared case-insensitively;
 * EVM addresses are case-insensitive at the protocol level, the EIP-55
 * checksum is display-only, so lowercase comparison is correct + sufficient).
 */

/** Matches a 20-byte EVM address (0x + 40 hex). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse the comma-separated `FACILITATOR_PAYTO_ALLOWLIST` env value into a Set
 * of LOWERCASED addresses. Invalid / empty entries are dropped. An unset or
 * all-blank value yields an EMPTY set → "no restriction" semantics.
 *
 * Pure: same input ⇒ same output. Never throws (invalid entries are skipped).
 */
export function parsePayToAllowlist(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (!ADDRESS_RE.test(trimmed)) continue; // skip malformed — defense-in-depth
    out.add(trimmed.toLowerCase()); // case-insensitive membership
  }
  return out;
}

/**
 * Decide whether `payTo` is permitted under `allowlist`.
 *
 *   - allowlist EMPTY  → ALWAYS allowed (feature disabled / backward-compatible).
 *   - allowlist NON-EMPTY → allowed only if `payTo` (lowercased) is a member.
 *
 * `payTo` that is not a syntactically valid address is REJECTED when an
 * allowlist is configured (it cannot match any member).
 */
export function isPayToAllowed(payTo: string, allowlist: ReadonlySet<string>): boolean {
  if (allowlist.size === 0) return true;
  if (!ADDRESS_RE.test(payTo)) return false;
  return allowlist.has(payTo.toLowerCase());
}
