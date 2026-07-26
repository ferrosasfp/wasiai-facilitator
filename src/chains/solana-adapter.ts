/**
 * SolanaAdapter — verify-only SPL-USDC settlement adapter (WKH-205 / HU-SOL-6).
 *
 * Verifies a FINALIZED Solana transaction that credits an SPL USDC transfer to
 * `payTo`, and blocks replays with a durable `UNIQUE(signature)` barrier
 * (fail-CLOSED). Non-EVM: no viem clients, no operator broadcast wallet, no
 * circuit breaker. Implements the verify-only `SettlementAdapter` (not the EVM
 * `ChainAdapter`), so it registers by `metadata.networkId` (`solana:<cluster>`).
 *
 * Opt-in-off by default: the `solanaAdapter` factory returns `null` unless BOTH
 * `SOLANA_RPC_URL` and `SOLANA_USDC_MINT` are set (AC-6) — so the EVM suite is
 * byte-identical when Solana is unconfigured.
 *
 * Boundaries (OWNERS.md [5]):
 *   - imports `./types.js`, `../core/types.js` (asChainId — pure branded ctor,
 *     same runtime import as base-adapter.ts), `../infra/solana-dedup.js`
 *     (durable dedup — excepción [5]), `@solana/web3.js` (v1).
 *   - Reads `process.env` DIRECTLY (does NOT import `../infra/env.ts`, CD-6).
 *   - MUST NOT import `../infra/supabase.ts` directly, `src/core/*` (runtime,
 *     except asChainId), `src/methods/*`, `src/routes/*`.
 *
 * Anti-hallucination pins:
 *   - CD-1: mint compared by EXACT pubkey + program-id pin (never symbol/metadata).
 *   - CD-2/CD-3: amount = NET delta of pre/postTokenBalances, BigInt (never Number/uiAmount).
 *   - CD-4: dedup fail-CLOSED (`{ok:false}` → reject).
 *   - CD-5: `commitment:'finalized'` explicit, never confirmed/processed.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type {
  AdapterResult,
  ChainMetadata,
  SettlementAdapter,
  SettleParams,
  SettleResult,
  VerifyParams,
  VerifyResult,
} from './types.js';
import type { Address } from '../core/types.js';
import { asChainId } from '../core/types.js';
import { isSolanaSignatureSettled, recordSolanaSignature } from '../infra/solana-dedup.js';

/** SPL Token classic program id (default; overridable via SOLANA_TOKEN_PROGRAM_ID). */
// eslint-disable-next-line no-secrets/no-secrets -- public on-chain SPL Token program id (base58 pubkey), not a secret.
const SPL_TOKEN_PROGRAM_ID_DEFAULT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Base58 alphabet (Bitcoin/Solana) — no 0, O, I, l. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Solana clusters this adapter supports (matches core/* namespace dispatch). */
type SolanaCluster = 'devnet' | 'mainnet';

/**
 * Synthetic chainId per cluster. Solana has no EVM chainId — these are the
 * informal SPL cluster indices (mainnet-beta=101, devnet=103). Required only to
 * satisfy the numeric `ChainMetadata.chainId` shape; the registry keys the
 * adapter by `metadata.networkId` (`solana:<cluster>`), never by this number.
 */
function syntheticChainId(cluster: SolanaCluster): number {
  return cluster === 'mainnet' ? 101 : 103;
}

export interface SolanaAdapterOpts {
  readonly rpcUrl: string;
  readonly mint: string;
  readonly programId?: string;
  readonly cluster: SolanaCluster;
  /** DI (DT-9): tests inject a fake Connection; prod builds `new Connection(rpcUrl, 'finalized')`. */
  readonly connection?: Connection;
}

/** Parsed + validated inputs for a Solana verify/settle. */
interface SolanaInput {
  readonly network: string;
  readonly expectedMint: string;
  readonly payTo: string;
  readonly expectedAmount: bigint;
  readonly signature: string;
  readonly reference: string | null;
}

/** Internal verify result: VerifyResult fields + the settle-only context. */
interface CoreVerifyOk {
  readonly verifyResult: VerifyResult;
  readonly signature: string;
  readonly reference: string | null;
  readonly mint: string;
  readonly payTo: string;
  readonly amount: string;
  readonly slot: number;
}

function isBase58Pubkey(value: string): boolean {
  try {
    // PublicKey ctor validates base58 + 32-byte length (throws otherwise).
    // Constructing solely for validation; the string form is the source of truth.
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function isBase58Signature(value: string): boolean {
  // Solana tx signature = 64 bytes → base58 length ~86-88. Range-bound to reject
  // obviously malformed input without asserting an exact length.
  return BASE58_RE.test(value) && value.length >= 64 && value.length <= 120;
}

export class SolanaAdapter implements SettlementAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _connection: Connection;
  private readonly _mint: string;
  private readonly _tokenProgramId: string;
  private readonly _networkId: string;

  constructor(opts: SolanaAdapterOpts) {
    this._mint = opts.mint;
    this._tokenProgramId = opts.programId ?? SPL_TOKEN_PROGRAM_ID_DEFAULT;
    this._networkId = `solana:${opts.cluster}`;
    // CD-5 — the Connection default commitment is 'finalized'; every read below
    // ALSO passes `commitment:'finalized'` explicitly.
    this._connection = opts.connection ?? new Connection(opts.rpcUrl, 'finalized');

    this.metadata = {
      chainId: asChainId(syntheticChainId(opts.cluster)),
      name: opts.cluster === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet',
      network: opts.cluster === 'mainnet' ? 'mainnet' : 'testnet',
      networkId: this._networkId,
      rpcUrl: opts.rpcUrl,
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      tokens: [],
    };
  }

  /**
   * Parse + validate the request. The x402 `VerifyParams` shape carries base58
   * pubkeys (not 0x-hex) for the solana namespace; `payload` also carries the
   * base58 `signature` + optional Solana Pay `reference`. Read via ONE sanctioned
   * boundary cast (same pattern as core/verify.ts `parsed as unknown as ...`).
   */
  private _parseSolanaInput(params: VerifyParams): AdapterResult<SolanaInput> {
    const invalid = {
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'invalid solana request', http: 400 },
    };
    try {
      const accepted = params.accepted;
      const payload = params.payload as unknown as {
        signature?: unknown;
        reference?: unknown;
      };

      const network = accepted.network;
      const expectedMint = accepted.asset;
      const payTo = accepted.payTo;
      const signature = payload.signature;
      const reference = payload.reference;

      if (
        typeof network !== 'string' ||
        typeof expectedMint !== 'string' ||
        typeof payTo !== 'string' ||
        typeof signature !== 'string'
      ) {
        return invalid;
      }
      if (
        !isBase58Pubkey(expectedMint) ||
        !isBase58Pubkey(payTo) ||
        !isBase58Signature(signature)
      ) {
        return invalid;
      }

      let ref: string | null = null;
      if (typeof reference === 'string' && reference.length > 0) {
        if (!isBase58Pubkey(reference)) return invalid;
        ref = reference;
      }

      const expectedAmount = BigInt(accepted.amount); // throws on non-integer → catch

      return {
        ok: true,
        network,
        expectedMint,
        payTo,
        expectedAmount,
        signature,
        reference: ref,
      };
    } catch {
      return invalid;
    }
  }

  /**
   * Core verify (§4 steps 1-9). NEVER throws — every path returns AdapterResult.
   * Returns the internal context so `settle()` can persist without re-parsing.
   */
  private async _verifyCore(params: VerifyParams): Promise<AdapterResult<CoreVerifyOk>> {
    const parsed = this._parseSolanaInput(params);
    if (!parsed.ok) return parsed;
    const { network, expectedMint, payTo, expectedAmount, signature, reference } = parsed;

    let tx;
    try {
      // Step 1 (CD-5): finalized only. NO retry with confirmed/processed.
      tx = await this._connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: 'tx not found or not finalized', http: 500 },
      };
    }

    if (tx === null || tx.meta === null) {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: 'tx not found or not finalized', http: 500 },
      };
    }

    // Step 2: on-chain execution error.
    if (tx.meta.err !== null) {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: 'on-chain tx failed', http: 500 },
      };
    }

    const post = tx.meta.postTokenBalances ?? [];
    const pre = tx.meta.preTokenBalances ?? [];

    // Locate the destination USDC ATA by owner + mint + program-id (Story
    // contract, CD-10: literal fields via .find, never dynamic index). Pinning
    // all three picks the right USDC balance when `payTo` has several token
    // balances touched in the tx (eliminates the false-negative of first-by-owner).
    // Fall back to first-by-owner ONLY to keep the actionable NETWORK_MISMATCH
    // errors (steps 3/4) when no exact USDC ATA exists — still fail-safe.
    const destPost =
      post.find(
        (e) => e.owner === payTo && e.mint === this._mint && e.programId === this._tokenProgramId,
      ) ?? post.find((e) => e.owner === payTo);
    if (destPost === undefined) {
      return {
        ok: false,
        error: { code: 'INVALID_RECEIVER', message: 'receiver ATA mismatch', http: 400 },
      };
    }

    // Step 3 (AC-1, CD-1): program-id pin — exact equality (rejects Token-2022).
    if (destPost.programId !== this._tokenProgramId) {
      return {
        ok: false,
        error: { code: 'NETWORK_MISMATCH', message: 'unsupported token program', http: 400 },
      };
    }

    // Step 4 (AC-1, CD-1): mint pubkey EXACT equality (never symbol/decimals).
    // AC-1 pins the reference to the configured SOLANA_USDC_MINT (`this._mint`):
    // the destination mint AND the accepted asset must both equal it exactly, so
    // a caller cannot substitute a fake same-symbol mint via `accepted.asset`.
    if (destPost.mint !== expectedMint || expectedMint !== this._mint) {
      return {
        ok: false,
        error: { code: 'NETWORK_MISMATCH', message: 'mint mismatch', http: 400 },
      };
    }

    // Step 5 (AC-2, AC-3, CD-2, CD-3): NET delta over the WHOLE tx. A later
    // compensating instruction is already reflected in the post balance.
    const destPre = pre.find(
      (e) => e.owner === payTo && e.mint === expectedMint && e.programId === this._tokenProgramId,
    );
    const postAmt = BigInt(destPost.uiTokenAmount.amount);
    const preAmt = destPre ? BigInt(destPre.uiTokenAmount.amount) : 0n;
    const delta = postAmt - preAmt;

    // Step 6 (AC-2): sufficient amount.
    if (delta < expectedAmount) {
      return {
        ok: false,
        error: { code: 'INVALID_AMOUNT', message: 'net delta below accepted amount', http: 400 },
      };
    }

    // Step 7: reference must appear in the tx static account keys (Solana Pay
    // correlation). Static keys cover the read-only reference pubkey.
    const staticKeys = tx.transaction.message.staticAccountKeys;
    const referencePresent =
      reference !== null && staticKeys.some((k) => k.toBase58() === reference);
    if (!referencePresent) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_MISMATCH',
          message: 'payment reference not found in tx',
          http: 400,
        },
      };
    }

    // Step 8 (AC-4, CD-4): durable replay check — fail-CLOSED. verify does NOT
    // insert (repeatable for not-yet-settled signatures); settle() inserts.
    const dedup = await isSolanaSignatureSettled(signature);
    if (!dedup.ok) {
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: 'dedup store unavailable', http: 500 },
      };
    }
    if (dedup.settled) {
      return {
        ok: false,
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'duplicate transaction — replay rejected',
          http: 500,
        },
      };
    }

    // Step 9: success. Base58 pubkeys transported in the branded Address fields
    // via ONE `as unknown as Address` at the boundary (sanctioned, per SDD).
    // client = fee payer (first static account key). expiresAt = 0 (point-in-time).
    const client = (staticKeys[0]?.toBase58() ?? payTo) as unknown as Address;
    const verifyResult: VerifyResult = {
      verified: true,
      client,
      amount: expectedAmount.toString(),
      asset: expectedMint as unknown as Address,
      network,
      payTo: payTo as unknown as Address,
      expiresAt: 0,
    };

    return {
      ok: true,
      verifyResult,
      signature,
      reference,
      mint: expectedMint,
      payTo,
      // Ledger column is the NET delta actually received on-chain (≥ expected),
      // not the accepted amount (migrations/003:17,31). Verify gate stays
      // `delta >= expectedAmount` (step 6); this only records the real credit.
      amount: delta.toString(),
      slot: tx.slot,
    };
  }

  /**
   * `SettlementAdapter.probeRpc()` — Solana liveness sonda (non-EVM).
   *
   * WHY `getVersion()`: it is the closest analogue to EVM `eth_chainId` — the
   * node answers it from its own build/feature config, so it reads NO ledger
   * state, takes NO commitment argument and cannot be delayed by finality lag.
   * The alternatives are all strictly heavier or noisier for a liveness check:
   *   - `getSlot()`  → reads ledger state and takes a commitment; a lagging
   *     'finalized' slot makes the probe latency depend on consensus.
   *   - `getLatestBlockhash()` → same plus a bigger payload; it is a
   *     transaction-building call, not a ping.
   *   - `getGenesisHash()` → would also pin the cluster identity, but cluster
   *     correctness is already enforced on the money path by the exact-mint +
   *     program-id pins (CD-1); a liveness sonda must stay a ping.
   *
   * The caller (`src/core/health-status.ts`) bounds this with a short timeout,
   * so no retry/backoff is added here. NOTE: `Connection` retries HTTP 429 with
   * backoff internally (`disableRetryOnRateLimit` option, web3.js v1), so a
   * rate-limited public devnet RPC surfaces as the caller's probe timeout — which
   * the caller classifies as TRANSIENT and tolerates once (anti-flapping).
   */
  async probeRpc(): Promise<void> {
    await this._connection.getVersion();
  }

  async verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    const core = await this._verifyCore(params);
    if (!core.ok) return core;
    return { ok: true, ...core.verifyResult };
  }

  async settle(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    // Step 1: full verify (§4 steps 1-9). On failure → return verbatim (no persist).
    const core = await this._verifyCore(params);
    if (!core.ok) return core;

    // Step 2: durable INSERT — the atomic anti-replay barrier (serializes two
    // concurrent settles; the loser hits UNIQUE 23505 → inserted:false).
    const rec = await recordSolanaSignature({
      signature: core.signature,
      network: core.verifyResult.network,
      reference: core.reference,
      mint: core.mint,
      payTo: core.payTo,
      amount: core.amount,
    });

    if (!rec.ok) {
      // Fail-CLOSED (CD-4): store unavailable → reject, never settle.
      return {
        ok: false,
        error: { code: 'TRANSACTION_FAILED', message: 'dedup store unavailable', http: 500 },
      };
    }
    if (!rec.inserted) {
      // UNIQUE violation (23505) → replay.
      return {
        ok: false,
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'duplicate transaction — replay rejected',
          http: 500,
        },
      };
    }

    // Success. The dedup table IS the Solana settlement ledger (DT-5).
    // transactionHash carries the base58 signature via ONE sanctioned cast.
    return {
      ok: true,
      settled: true,
      transactionHash: core.signature as unknown as `0x${string}`,
      blockNumber: core.slot,
      amount: core.amount,
      from: core.verifyResult.client,
      to: core.payTo as unknown as Address,
      asset: core.mint as unknown as Address,
    };
  }
}

/**
 * WKH-205 (DT-11) — opt-in-off factory. Returns `null` unless BOTH SOLANA_RPC_URL
 * and SOLANA_USDC_MINT are set → the adapter is NOT registered → the EVM suite
 * runs byte-identically (AC-6). Cluster is inferred from the RPC URL (mainnet
 * substring → mainnet, else devnet), matching the core/* namespace dispatch.
 */
export const solanaAdapter: SolanaAdapter | null = (() => {
  const rpcUrl = process.env['SOLANA_RPC_URL'];
  const mint = process.env['SOLANA_USDC_MINT'];
  if (!rpcUrl || !mint) return null; // opt-in-off por default (AC-6)
  const programId = process.env['SOLANA_TOKEN_PROGRAM_ID'] ?? SPL_TOKEN_PROGRAM_ID_DEFAULT;
  const cluster: SolanaCluster = rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet';
  try {
    return new SolanaAdapter({ rpcUrl, mint, programId, cluster });
  } catch {
    return null;
  }
})();
