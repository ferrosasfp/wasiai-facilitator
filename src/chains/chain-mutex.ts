/**
 * Per-chain in-process serialization mutex (ECOSYSTEM-AUDIT R-1 / OP-03).
 *
 * PROBLEM: the operator signs every settle on a chain with ONE viem account.
 * viem fetches the next nonce lazily ("pending" tx count) on each
 * `writeContract`. Two concurrent settles on the SAME chain can both read the
 * same pending nonce before either broadcasts → the second broadcast reverts
 * with "nonce too low" (the on-chain EIP-3009 nonce is per-authorization, NOT
 * the account tx nonce — so the in-flight idempotency lock does NOT cover this
 * case: it dedups IDENTICAL requests, but two DISTINCT settles still collide).
 *
 * FIX: serialize the simulate→write→receipt sequence per chainId with a tiny
 * promise-chain mutex. Concurrent settles on DIFFERENT chains run in parallel
 * (independent operator nonces per chain); concurrent settles on the SAME
 * chain run one-at-a-time, so each reads a fresh, already-incremented nonce.
 *
 * This is an in-PROCESS mutex. It does NOT coordinate across multiple
 * replicas. A cross-replica queue (BullMQ, referenced in code comments) is the
 * eventual fix for horizontal scaling — DEFER-TO-HU. Today the facilitator
 * runs single-instance, so in-process serialization closes the realistic
 * collision window. viem's `nonceManager` (wired on the operator account in
 * src/infra/wallet.ts) is the defense-in-depth second layer.
 *
 * Boundaries (OWNERS.md row `src/chains/<chain>.ts`): pure TS, no imports.
 * Consumed by src/chains/base-adapter.ts only.
 */

/** Per-chain tail of the serialization promise chain (keyed by chainId). */
const chainTails = new Map<number, Promise<unknown>>();

/**
 * Run `fn` exclusively with respect to other calls for the same `chainId`.
 *
 * Implementation: a per-chain promise chain. Each call appends itself to the
 * chain's tail and only starts once the previous call settled (success OR
 * failure — we chain off a `.then(..., ..)`-equivalent that never rejects the
 * tail, so one rejecting settle does NOT poison the queue for the next one).
 *
 * Ordering is FIFO by call arrival (synchronous `runExclusive` invocation
 * order), which is exactly the order viem would have assigned nonces in.
 */
export async function runExclusive<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const previous = chainTails.get(chainId) ?? Promise.resolve();

  // The work this call performs, gated behind the previous tail. We swallow the
  // previous result/error (`.catch`) so a failed predecessor cannot reject our
  // gate — we only care that it has SETTLED before we run.
  const run = previous.then(
    () => fn(),
    () => fn(),
  );

  // Advance the tail to a promise that resolves when THIS call settles,
  // regardless of outcome, so the next caller waits for us but is never
  // poisoned by our rejection.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chainTails.set(chainId, tail);

  // GC: once this is the last call in the chain, drop the map entry so the
  // Map does not grow unbounded across many chains over a long process life.
  void tail.finally(() => {
    if (chainTails.get(chainId) === tail) {
      chainTails.delete(chainId);
    }
  });

  return run;
}

/**
 * @internal — tests only. Clears all per-chain queues so each test starts
 * from a clean serialization state.
 */
export function resetChainMutexForTesting(): void {
  chainTails.clear();
}
