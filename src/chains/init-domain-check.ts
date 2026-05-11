/**
 * WFAC-53 FIX-2 — boot-time DOMAIN_SEPARATOR() drift assertion.
 *
 * For each chain registered in chainRegistry, computes the EIP-712 domain
 * separator locally (viem.domainSeparator) and compares with the value returned
 * by the on-chain token contract via DOMAIN_SEPARATOR() view (added to ABI in
 * the same commit). Behavior:
 *   - match            → debug log, boot continues
 *   - mismatch         → logger.fatal + process.exit(1)  (AC-4)
 *   - RPC unreachable  → logger.warn, boot continues     (AC-5, CD-6)
 *
 * Uses Promise.allSettled (CD-14) so one chain with a down RPC does not block
 * the check on the other 3. All mismatches are logged before the exit(1).
 *
 * Called from buildApp() AFTER initChainBreakers and BEFORE route registration
 * (DT-I). Test-only opt-out via BuildAppOptions.skipDomainCheck (CD-16).
 *
 * Boundaries (OWNERS.md, CD-4):
 *   - MAY import: `pino` (type-only), `./registry.js`, `./abi/fiat-token.js`,
 *                 `./types.js` (sibling), `viem` (runtime: domainSeparator).
 *   - MUST NOT import: src/methods/*, src/core/*, src/routes/*, src/infra/*.
 */

import type { Logger } from 'pino';
import { domainSeparator } from 'viem';
import { chainRegistry } from './registry.js';
import { FIAT_TOKEN_ABI } from './abi/fiat-token.js';
import type { ChainAdapter, EIP3009Token } from './types.js';

type CheckOutcome =
  | { kind: 'match'; chainId: number; tokenAddress: string }
  | {
      kind: 'mismatch';
      chainId: number;
      tokenAddress: string;
      expected: string;
      actual: string;
    }
  | { kind: 'no-token'; chainId: number };

async function checkOneChain(adapter: ChainAdapter): Promise<CheckOutcome> {
  const metadata = adapter.metadata;
  const token: EIP3009Token | undefined = metadata.tokens[0];
  if (!token) {
    // No token to check — adapter skipped. (Not an error: 0-token adapters are
    // a possible future shape; we silently no-op consistent with init-breakers.ts.)
    return { kind: 'no-token', chainId: metadata.chainId };
  }

  // Local EIP-712 domain separator (offline, no RPC). EIP3009Token.eip712Name
  // and eip712Version are optional in the type; fall back to `token.name` and
  // '1' to mirror what existing adapters do in practice (both kite/avalanche
  // adapters always populate the optional fields, so this is defensive).
  const localSep = domainSeparator({
    domain: {
      name: token.eip712Name ?? token.name,
      version: token.eip712Version ?? '1',
      chainId: metadata.chainId,
      verifyingContract: token.address,
    },
  });

  // On-chain DOMAIN_SEPARATOR() read — may throw (RPC down). Caller (allSettled)
  // turns the throw into 'rejected' which the outer loop logs as warn (AC-5).
  const onChainSep = (await adapter.getPublicClient().readContract({
    address: token.address,
    abi: FIAT_TOKEN_ABI,
    functionName: 'DOMAIN_SEPARATOR',
  })) as `0x${string}`;

  const match = localSep.toLowerCase() === onChainSep.toLowerCase();
  return match
    ? { kind: 'match', chainId: metadata.chainId, tokenAddress: token.address }
    : {
        kind: 'mismatch',
        chainId: metadata.chainId,
        tokenAddress: token.address,
        expected: localSep,
        actual: onChainSep,
      };
}

export async function initDomainCheck(logger: Logger): Promise<void> {
  const adapters: ChainAdapter[] = [];
  for (const metadata of chainRegistry.listAdapters()) {
    const lookup = chainRegistry.getAdapter(metadata.chainId);
    if (lookup.ok) adapters.push(lookup.adapter);
  }

  if (adapters.length === 0) {
    // No adapters → no-op (test fixtures, early boot). Consistent w/ init-breakers.
    return;
  }

  // CD-14: Promise.allSettled (NOT Promise.all). One down RPC must not block
  // the check on the other N healthy chains; allSettled never rejects, so each
  // chain's outcome is independent.
  //
  // To avoid numeric-index access into parallel arrays (which triggers
  // security/detect-object-injection — CD-13 forbids inline disables), we pair
  // each adapter's chainId into its own task BEFORE awaiting. The task itself
  // never throws (returns a TaggedOutcome discriminated union); we still go
  // through Promise.allSettled to keep the CD-14 contract literal.
  type TaggedOutcome =
    | { kind: 'ok'; chainId: number; outcome: CheckOutcome }
    | { kind: 'err'; chainId: number; error: unknown };

  const settled = await Promise.allSettled(
    adapters.map(async (adapter): Promise<TaggedOutcome> => {
      try {
        const outcome = await checkOneChain(adapter);
        return { kind: 'ok', chainId: adapter.metadata.chainId, outcome };
      } catch (error) {
        return { kind: 'err', chainId: adapter.metadata.chainId, error };
      }
    }),
  );

  // The inner task never throws (try/catch above), so every settled entry is
  // fulfilled. Map back into a flat list of TaggedOutcome — the 'rejected'
  // arm is unreachable but typed defensively.
  const tagged: readonly TaggedOutcome[] = settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : ({ kind: 'err', chainId: -1, error: s.reason } as const),
  );

  let anyMismatch = false;
  for (const t of tagged) {
    if (t.kind === 'ok') {
      const outcome = t.outcome;
      if (outcome.kind === 'mismatch') {
        anyMismatch = true;
        logger.fatal(
          {
            chainId: outcome.chainId,
            tokenAddress: outcome.tokenAddress,
            expected: outcome.expected,
            actual: outcome.actual,
          },
          'WFAC-53: domain separator drift detected — refusing to boot',
        );
      } else if (outcome.kind === 'match') {
        logger.debug(
          { chainId: outcome.chainId, tokenAddress: outcome.tokenAddress },
          'WFAC-53: domain separator OK',
        );
      }
      // 'no-token' → silent skip (consistent with init-breakers behavior).
    } else {
      // RPC unreachable / timeout / other throw → warn + continue (AC-5, CD-6).
      logger.warn(
        {
          chainId: t.chainId,
          err: t.error instanceof Error ? t.error.message : String(t.error),
        },
        'WFAC-53: domain separator check skipped (RPC unreachable)',
      );
    }
  }

  if (anyMismatch) {
    // Mismatch on at least one chain with a reachable RPC → fatal exit. All
    // mismatches were already logged in the loop above (operator sees them all).
    process.exit(1);
  }
}
