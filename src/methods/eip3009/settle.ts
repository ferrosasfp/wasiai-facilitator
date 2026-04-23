/**
 * EIP-3009 settle — on-chain transferWithAuthorization execution.
 *
 * Flow:
 *   1. Re-verify payload (off-chain checks; NO RPC).
 *   2. Parse signature into v/r/s. Reject EIP-2098 compact (WFAC-13).
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

import { parseSignature } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  SettleParams,
  SettleResult,
} from '../../chains/types.js';
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { FIAT_TOKEN_ABI, RECEIPT_TIMEOUT_MS } from './abi.js';
import { verifyEip3009 } from './verify.js';

function err(code: X402ErrorCode, message: string, http: number): AdapterResult<SettleResult> {
  return { ok: false, error: { code, message, http } };
}

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

  // 2. Parse signature into v/r/s (reject EIP-2098 compact — CD-NEW-15).
  // MNR-3 (AR F3.1): defense-in-depth — `parseSignature` can throw for malformed
  // bytes or invalid v (e.g. v=29). Today this branch is unreachable because
  // verify.ts catches the same cases first via `recoverTypedDataAddress`, but if
  // the flow is ever reordered (e.g. settle reused without verify), a throw here
  // would reject the Promise instead of returning an AdapterResult (violates
  // AC-14 invariant "never throws for foreseeable conditions").
  let parsed;
  try {
    parsed = parseSignature(params.payload.signature);
  } catch (e) {
    return err('INVALID_SIGNATURE', sanitize(e), 401);
  }
  if (!('v' in parsed) || parsed.v === undefined) {
    return err(
      'INVALID_SIGNATURE',
      'EIP-2098 compact signatures not supported in V1 (WFAC-13)',
      401,
    );
  }
  const { r, s } = parsed;
  const vNum = Number(parsed.v); // v ∈ {27, 28} — safe Number conversion

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
    return err('SIMULATION_FAILED', sanitize(e), 500);
  }

  // 4. Write (AC-3, AC-4, CD-9). Use sim.request opaque — do NOT reconstruct.
  let hash: `0x${string}`;
  try {
    hash = await walletClient.writeContract(sim.request);
  } catch (e) {
    return err('TRANSACTION_FAILED', sanitize(e), 500);
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
    return err('TRANSACTION_FAILED', msg, 500);
  }

  // 6. Check status (AC-7).
  if (receipt.status === 'reverted') {
    return err('TRANSACTION_FAILED', 'transaction reverted on-chain', 500);
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
