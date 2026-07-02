/**
 * ⚠️ DEAD CODE — NOT wired into runtime.
 *
 * The LIVE settle path is `src/chains/base-adapter.ts` (BaseEip3009Adapter),
 * consumed by the chain adapters (base/kite). Nothing in runtime imports this
 * module: the only production consumer of `methods/eip3009/*` is
 * `src/core/schemas.ts`, which imports `./schemas.js` ONLY.
 *
 * Do NOT re-wire this into the settle flow without a full re-audit: it re-runs
 * `verifyEip3009` (off-chain recover + `from`-match) before writing, which the
 * live adapter does NOT do — the live path delegates authenticity to the
 * on-chain `transferWithAuthorization`. Re-cabling the wrong path here would
 * silently change the trust model.
 *
 * Kept on purpose as a referenced semantic spec: `base-adapter.ts` notes it
 * "Mirrors src/methods/eip3009/settle.ts" and `errors.test.ts` reads it by
 * path. Covered by `settle.test.ts`.
 *
 * EIP-3009 settle — on-chain transferWithAuthorization execution.
 *
 * Flow:
 *   1. Re-verify payload (off-chain checks; NO RPC).
 *   2. Normalize signature via `normalizeSignature` (WFAC-13) — accepts 65-byte
 *      standard, 64-byte EIP-2098 compact, legacy v=0/1; rejects high-s.
 *   3. simulateContract — if throws → SIMULATION_FAILED.
 *   4. writeContract(sim.request) — if throws → TRANSACTION_FAILED.
 *   5. waitForTransactionReceipt — timeout or throw → TRANSACTION_FAILED.
 *   6. If receipt.status === 'reverted' → TRANSACTION_FAILED.
 *   7. Return SettleResult with fields from input params (NOT re-read on-chain).
 *
 * Never throws for foreseeable conditions — always returns AdapterResult.
 *
 * @remarks
 * TOCTOU gap: simulateContract succeeds at block N; writeContract executes at
 * block N+k. If nonce is consumed in that window (e.g. user settled elsewhere),
 * writeContract or the on-chain receipt will surface the failure as
 * TRANSACTION_FAILED. This function does NOT retry — the core/settle orchestrator
 * (WFAC-21) + BullMQ queue (WFAC-42) handle retries.
 *
 * @remarks
 * `blockNumber` returned is `Number(receipt.blockNumber)` — may lose precision
 * if the chain ever exceeds 2^53-1 blocks (not a concern for decades). Tracked
 * as TD in WFAC-6 auto-blindaje BLQ-MED-1.
 */

import type { PublicClient, WalletClient } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  SettleParams,
  SettleResult,
} from '../../chains/types.js';
import type { ChainId } from '../../core/types.js';
import { buildX402Error } from '../../core/errors.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
import { normalizeSignature } from './signature.js';
import { verifyEip3009 } from './verify.js';

/** Extract a safe, bounded-length string from an unknown error. */
function sanitize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.slice(0, 200);
}

export async function settleEip3009(
  params: SettleParams,
  token: EIP3009Token,
  chainId: ChainId,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<AdapterResult<SettleResult>> {
  // 1. Re-verify (AC-9) — propagate error unchanged.
  const v = await verifyEip3009(params, token, chainId);
  if (!v.ok) {
    return { ok: false, error: v.error };
  }

  // 2. Normalize signature (WFAC-13 — CD-7). `normalizeSignature` is pure, total,
  // and never throws — it accepts 65-byte standard, 64-byte EIP-2098 compact,
  // legacy v ∈ {0,1}, and rejects high-s malleability. Returns an Err['error']
  // on failure that we propagate unchanged (always INVALID_SIGNATURE, http 401).
  const parsed = normalizeSignature(params.payload.signature);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const { r, s } = parsed;
  const vNum = Number(parsed.v); // v ∈ {27n, 28n} — safe Number conversion

  // 3. Simulate (AC-1, AC-2, CD-2). Must run BEFORE write.
  // Pass walletClient.account to simulateContract so the returned sim.request
  // carries the correct Account in its type — viem's WriteContractParameters
  // requires `account` to be non-undefined when the client generic is
  // `WalletClient` (not `WalletClient<..., Account>`). This keeps sim.request
  // opaque (CD-9): we still pass it unchanged to writeContract.
  const auth = params.payload.authorization;
  let sim;
  try {
    sim = await publicClient.simulateContract({
      account: walletClient.account,
      address: token.address,
      abi: FIAT_TOKEN_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        auth.from,
        auth.to,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        vNum,
        r,
        s,
      ],
    });
  } catch (e) {
    return { ok: false, error: buildX402Error('SIMULATION_FAILED', sanitize(e)) };
  }

  // 4. Write (AC-3, AC-4, CD-9). Use sim.request opaque — do NOT reconstruct.
  let hash: `0x${string}`;
  try {
    hash = await walletClient.writeContract(sim.request);
  } catch (e) {
    return { ok: false, error: buildX402Error('TRANSACTION_FAILED', sanitize(e)) };
  }

  // 5. Wait receipt (AC-5, AC-6, CD-4).
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
  } catch (e) {
    // viem throws WaitForTransactionReceiptTimeoutError on timeout.
    // All errors here map to TRANSACTION_FAILED. If it's a timeout, use
    // the literal 'receipt timeout' message (AC-6 spec); otherwise
    // preserve sanitized message.
    const msg =
      e instanceof Error && e.name === 'WaitForTransactionReceiptTimeoutError'
        ? 'receipt timeout'
        : sanitize(e);
    return { ok: false, error: buildX402Error('TRANSACTION_FAILED', msg) };
  }

  // 6. Check status (AC-7).
  if (receipt.status === 'reverted') {
    return {
      ok: false,
      error: buildX402Error('TRANSACTION_FAILED', 'transaction reverted on-chain'),
    };
  }

  // 7. Success (AC-8). Fields from input params, NOT re-read from chain.
  return {
    ok: true,
    settled: true,
    transactionHash: hash,
    blockNumber: Number(receipt.blockNumber),
    amount: params.accepted.amount,
    from: auth.from,
    to: auth.to,
    asset: token.address,
  };
}
