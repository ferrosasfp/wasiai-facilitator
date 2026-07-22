/**
 * WKH-217 / HU-SOL-14 — reusable co-sign + broadcast primitive (CD-11).
 *
 * `cosignAndBroadcast` is GENERIC: it knows NOTHING about the `deposit`. It
 * parses a base64 legacy `Transaction`, asks an INJECTED structural validator
 * (`SponsorTxValidator`) whether the fee-payer may sign, and — ONLY if the
 * validator returns `{ ok:true }` — co-signs as fee-payer and broadcasts,
 * paying just the network fee.
 *
 * The `deposit`-specific logic lives entirely in `cr1.ts`
 * (`validateDepositForSponsor`), injected via `opts.validate`. HU-SOL-13
 * (release) reuses THIS primitive unchanged by injecting its own
 * `validateReleaseForSponsor`. Do NOT hardcode any instruction shape here.
 *
 * FAIL-CLOSED (CD-2/CD-3): the fee-payer NEVER signs an opaque blob. Every step
 * below is fail-closed; a parse error, a validator reject, a fee over the cap, a
 * daily-cap reject, or a stale blockhash all return WITHOUT signing.
 *
 * CONCURRENCY (AC-5): the sign+broadcast section runs inside
 * `runExclusive(FEE_PAYER_SENTINEL_ID, ...)` so concurrent sponsorships for the
 * single fee-payer Keypair serialize FIFO and never interleave signing state.
 *
 * Boundary: imports `@solana/web3.js` (runtime) + `src/chains/chain-mutex.ts`
 * (runtime). No EVM imports, no route/env imports.
 */

import {
  Connection,
  Transaction,
  VersionedTransaction,
  type Keypair,
  type PublicKey,
} from '@solana/web3.js';
import { runExclusive } from '../../chains/chain-mutex.js';

/**
 * Sentinel chainId reserved for the Solana fee-payer mutex. Solana has no EVM
 * chainId; `runExclusive` only needs a stable key to serialize the singleton
 * Keypair's sign/broadcast. `-1` never collides with real EVM chainIds (> 0).
 */
export const FEE_PAYER_SENTINEL_ID = -1;

/** Stable, PII-free error codes surfaced to the sponsorship route (§Contrato). */
export type SponsorErrorCode =
  | 'SPONSOR_REJECTED'
  | 'SPONSOR_UNSUPPORTED_TX'
  | 'SPONSOR_DAILY_CAP'
  | 'SPONSOR_BROADCAST_EXPIRED'
  | 'SPONSOR_BROADCAST_FAILED';

/**
 * Injected structural validator (CD-11). Generic contract reused by every
 * sponsored instruction (deposit today, release in HU-SOL-13). Receives the
 * PARSED legacy transaction + the fee-payer pubkey; returns the derived fee
 * upper bound (checks 1-5 OK) or a reject reason. STABLE — do not change.
 */
export type SponsorTxValidator = (
  tx: Transaction,
  feePayerPubkey: PublicKey,
) => { ok: true; feeUpperBoundLamports: bigint } | { ok: false; reason: string };

export interface CosignOpts {
  readonly feePayerKeypair: Keypair;
  /** CR-1 injected here; NEVER hardcode the deposit shape in this file. */
  readonly validate: SponsorTxValidator;
  /** Reuses SOLANA_RPC_URL (WKH-205). */
  readonly rpcUrl: string;
  /** SOLANA_SPONSOR_MAX_FEE_LAMPORTS. */
  readonly maxFeeLamports: bigint;
  /** SOLANA_SPONSOR_MAX_REBROADCASTS. */
  readonly maxRebroadcasts: number;
  /**
   * Daily-cap CHECK+INCR (fail-closed, AC-6). Called with the derived fee upper
   * bound BEFORE signing: the CHECK (already over the daily ceiling?) stays
   * pre-sign so we never over-spend, and the atomic INCR RESERVES the fee.
   */
  readonly onFeeEstimated?: (lamports: bigint) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * AR-MNR-1 compensation. Releases a fee previously RESERVED by `onFeeEstimated`
   * when signing/broadcast never produced an on-chain spend (stale/expired
   * blockhash, pre-sign reject). Best-effort; must never throw.
   */
  readonly onFeeReleased?: (lamports: bigint) => Promise<void>;
}

export type CosignResult =
  | { ok: true; signature: string }
  | { ok: false; code: SponsorErrorCode; reason: string };

/**
 * Parse a base64 legacy `Transaction`. Fail-closed:
 *   - decode/deserialize error → `{ ok:false, code:'SPONSOR_REJECTED' }`
 *   - a versioned (v0) transaction → `{ ok:false, code:'SPONSOR_UNSUPPORTED_TX' }`
 * NEVER throws — the caller relies on this (T10).
 */
export function parseSponsorTx(
  txBase64: string,
):
  | { ok: true; tx: Transaction }
  | { ok: false; code: 'SPONSOR_UNSUPPORTED_TX' | 'SPONSOR_REJECTED'; reason: string } {
  let buf: Buffer;
  try {
    buf = Buffer.from(txBase64, 'base64');
  } catch {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'BASE64_DECODE_FAILED' };
  }
  try {
    const tx = Transaction.from(buf);
    return { ok: true, tx };
  } catch {
    // Transaction.from throws on a versioned message. Disambiguate for an
    // accurate error code: a v0 tx deserializes as a VersionedTransaction.
    if (isVersionedTx(buf)) {
      return { ok: false, code: 'SPONSOR_UNSUPPORTED_TX', reason: 'VERSIONED_TX_NOT_SUPPORTED' };
    }
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'DESERIALIZE_FAILED' };
  }
}

/** True iff `buf` decodes as a NON-legacy (v0+) versioned transaction. */
function isVersionedTx(buf: Buffer): boolean {
  try {
    const vt = VersionedTransaction.deserialize(Uint8Array.from(buf));
    return vt.version !== 'legacy';
  } catch {
    return false;
  }
}

/** True iff `blockhash` is still processable by the cluster. */
async function isBlockhashFresh(connection: Connection, blockhash: string): Promise<boolean> {
  // CR-MNR-1: rely on the real `RpcResponseAndContext<boolean>` return type
  // (`.value` is a stable field) — no double-cast needed.
  const res = await connection.isBlockhashValid(blockhash);
  return res.value === true;
}

/**
 * Co-sign + broadcast a sponsored transaction after an injected validator
 * authorizes it. See file header. Never throws — always resolves a
 * `CosignResult`.
 */
export async function cosignAndBroadcast(
  txBase64: string,
  opts: CosignOpts,
): Promise<CosignResult> {
  // Step 1 — parse (fail-closed; versioned/corrupt handled by parseSponsorTx).
  const parsed = parseSponsorTx(txBase64);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, reason: parsed.reason };
  }
  const tx = parsed.tx;

  // Step 2 — INJECTED structural validation (CR-1). The primitive signs ONLY
  // if this returns { ok:true }. It knows nothing about the deposit itself.
  const v = opts.validate(tx, opts.feePayerKeypair.publicKey);
  if (!v.ok) {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: v.reason };
  }

  // Step 3 — fee upper bound must stay within the per-tx cap.
  if (v.feeUpperBoundLamports > opts.maxFeeLamports) {
    return { ok: false, code: 'SPONSOR_REJECTED', reason: 'FEE_ABOVE_MAX' };
  }

  // Step 4 — daily-cap CHECK+INCR (fail-closed, AC-6). A reject here means the
  // aggregate lamports ceiling was hit OR the counter store is down. On success
  // this RESERVES `feeUpperBoundLamports` (the CHECK stays PRE-SIGN so we never
  // over-spend); the reservation is released below if no on-chain spend occurs.
  let reserved = false;
  if (opts.onFeeEstimated) {
    const cap = await opts.onFeeEstimated(v.feeUpperBoundLamports);
    if (!cap.ok) {
      return { ok: false, code: 'SPONSOR_DAILY_CAP', reason: cap.reason ?? 'DAILY_CAP_EXCEEDED' };
    }
    reserved = true;
  }

  // Steps 5-6 — blockhash freshness + sign + broadcast, SERIALIZED per fee-payer.
  const result = await runExclusive(FEE_PAYER_SENTINEL_ID, async (): Promise<CosignResult> => {
    const connection = new Connection(opts.rpcUrl, 'confirmed');
    const blockhash = tx.recentBlockhash;
    if (blockhash === undefined || blockhash.length === 0) {
      return { ok: false, code: 'SPONSOR_REJECTED', reason: 'MISSING_BLOCKHASH' };
    }

    // Step 5 — blockhash fresh BEFORE signing (never sign a stale tx).
    let fresh: boolean;
    try {
      fresh = await isBlockhashFresh(connection, blockhash);
    } catch {
      // RPC error on the freshness probe → fail-closed, never sign.
      return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_CHECK_FAILED' };
    }
    if (!fresh) {
      return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'STALE_BLOCKHASH' };
    }

    // Step 6 — co-sign as fee-payer, then broadcast with bounded rebroadcast.
    tx.partialSign(opts.feePayerKeypair);
    const raw = tx.serialize();
    return broadcastWithRebroadcast(connection, raw, blockhash, opts.maxRebroadcasts);
  });

  // AR-MNR-1 (data-integrity / auto-DoS): the daily-cap INCR at step 4 RESERVED
  // the fee upper bound BEFORE any spend. Release it for every terminal outcome
  // that guarantees NO fee was charged on-chain (pre-sign reject, stale/expired
  // blockhash) so a tx that never landed cannot auto-exhaust the caller's daily
  // budget. The ONLY debit we KEEP is `SPONSOR_BROADCAST_FAILED`: there the tx
  // may have landed but we couldn't confirm it, so we conservatively keep the
  // charge to protect the fee-payer wallet. The CHECK stayed pre-sign — this
  // compensation only touches accounting, never weakening fail-closed.
  if (reserved && !result.ok && result.code !== 'SPONSOR_BROADCAST_FAILED' && opts.onFeeReleased) {
    await opts.onFeeReleased(v.feeUpperBoundLamports);
  }

  return result;
}

/**
 * Broadcast + confirm with bounded rebroadcast (AC-5). Up to
 * `maxRebroadcasts + 1` attempts. On exhaustion, distinguishes expiry (blockhash
 * no longer valid → SPONSOR_BROADCAST_EXPIRED) from a hard failure
 * (SPONSOR_BROADCAST_FAILED).
 */
async function broadcastWithRebroadcast(
  connection: Connection,
  raw: Uint8Array,
  blockhash: string,
  maxRebroadcasts: number,
): Promise<CosignResult> {
  const attempts = Math.max(1, maxRebroadcasts + 1);
  for (let i = 0; i < attempts; i++) {
    // Re-check freshness at the top of each (re)broadcast — the blockhash may
    // have expired between retries.
    let fresh: boolean;
    try {
      fresh = await isBlockhashFresh(connection, blockhash);
    } catch {
      return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_CHECK_FAILED' };
    }
    if (!fresh) {
      return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_EXPIRED' };
    }

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
    } catch {
      continue; // transient send error → rebroadcast
    }

    try {
      // CR-MNR-1: `RpcResponseAndContext<SignatureResult>` — `.value.err` is a
      // stable field (null on success); no double-cast needed.
      const conf = await connection.confirmTransaction(signature, 'confirmed');
      if (conf.value.err === null || conf.value.err === undefined) {
        return { ok: true, signature };
      }
    } catch {
      // confirmation error → retry
    }
  }

  // Exhausted retries. Expired blockhash → EXPIRED, otherwise a hard FAILED.
  let stillFresh: boolean;
  try {
    stillFresh = await isBlockhashFresh(connection, blockhash);
  } catch {
    return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_CHECK_FAILED' };
  }
  if (!stillFresh) {
    return { ok: false, code: 'SPONSOR_BROADCAST_EXPIRED', reason: 'BLOCKHASH_EXPIRED' };
  }
  return { ok: false, code: 'SPONSOR_BROADCAST_FAILED', reason: 'UNCONFIRMED_AFTER_REBROADCASTS' };
}
