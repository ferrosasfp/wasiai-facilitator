/**
 * CasperAdapter — verify-only wCSPR (CEP-18) settlement adapter, delegated over
 * HTTP to the Casper x402 facilitator.
 *
 * Casper is a non-EVM rail: there is no viem client, no operator broadcast
 * wallet and no EVM circuit breaker. It therefore implements the verify-only
 * `SettlementAdapter` (not the EVM `ChainAdapter`) exactly like
 * `solana-adapter.ts`, and registers by `metadata.networkId`
 * (`casper:casper` mainnet / `casper:casper-test` testnet).
 *
 * verify/settle are delegated to the Casper facilitator
 * (https://x402-facilitator.cspr.cloud by default, overridable with
 * `CASPER_FACILITATOR_URL`) using the x402 v2 `{ x402Version, paymentPayload,
 * paymentRequirements }` body shape. The adapter owns input validation, amount
 * math and error mapping; the facilitator owns chain access and broadcast.
 *
 * Opt-in-off by default: the factories return `null` unless the corresponding
 * `CASPER_*_ENABLED` flag is `true` AND the wCSPR contract hash is set (mirror
 * of the Solana `SOLANA_RPC_URL` + `SOLANA_USDC_MINT` gate), so every existing
 * deployment and the existing suite boot byte-identically.
 *
 * Boundaries (OWNERS.md):
 *   - imports `./types.js` and `../core/types.js` (asChainId — pure branded
 *     ctor, same runtime import as base-adapter.ts / solana-adapter.ts).
 *   - Reads `process.env` DIRECTLY (does NOT import `../infra/env.ts`), same as
 *     solana-adapter.ts (CD-6).
 *   - MUST NOT import `src/core/*` (runtime, except asChainId), `src/methods/*`,
 *     `src/routes/*`, `src/infra/*`.
 *
 * Anti-hallucination pins:
 *   - CD-1: wCSPR contract hash compared by EXACT hash (never symbol/metadata).
 *   - CD-2: amounts are motes (9 decimals) parsed as BigInt — never Number.
 *   - CD-3: sub-mote precision THROWS (`CasperAmountPrecisionError`); the
 *     adapter never silently truncates a decimal CSPR amount.
 *   - CD-4: any non-2xx / malformed facilitator response is a REJECT, never a
 *     silent pass (fail-CLOSED).
 */

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

/** Public Casper x402 facilitator (verify + settle). Override: CASPER_FACILITATOR_URL. */
const CASPER_FACILITATOR_URL_DEFAULT = 'https://x402-facilitator.cspr.cloud';

/** CSPR has 9 decimals; the base unit is the "mote". */
export const CSPR_DECIMALS = 9;

/** Default HTTP timeout for a facilitator round-trip, in milliseconds. */
const FACILITATOR_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Casper public key: 1-byte algorithm tag + key bytes, lowercase/uppercase hex.
 *   - `01` + ed25519   (32 bytes → 64 hex chars) → 66 chars total.
 *   - `02` + secp256k1 (33 bytes → 66 hex chars) → 68 chars total.
 */
const CASPER_PUBLIC_KEY_RE = /^(01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/u;

/** Casper account hash, as emitted by the SDK: `account-hash-<32 bytes hex>`. */
const CASPER_ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/u;

/** Casper contract hash: `hash-<32 bytes hex>` or the bare 32-byte hex form. */
const CASPER_CONTRACT_HASH_RE = /^(hash-)?[0-9a-fA-F]{64}$/u;

/** Casper deploy/transaction hash: 32 bytes hex. */
const CASPER_DEPLOY_HASH_RE = /^[0-9a-fA-F]{64}$/u;

/** Canonical non-negative integer string (no sign, no leading zeros, no 1e3). */
const UINT_STRING_RE = /^(0|[1-9]\d*)$/u;

/** Decimal amount string, e.g. "1", "1.5", "0.000000001". */
const DECIMAL_STRING_RE = /^(0|[1-9]\d*)(\.\d+)?$/u;

/** Casper networks this adapter supports (CAIP-2 style chain names). */
export type CasperNetwork = 'casper' | 'casper-test';

/**
 * Synthetic chainId per network. Casper has no EVM chainId — these are the
 * SLIP-44 coin type for Casper (506) for mainnet and 506+1 for testnet.
 * Required only to satisfy the numeric `ChainMetadata.chainId` shape; the
 * registry keys the adapter by `metadata.networkId` (`casper:<network>`),
 * never by this number.
 */
function syntheticChainId(network: CasperNetwork): number {
  return network === 'casper' ? 506 : 507;
}

/**
 * Thrown when a decimal CSPR amount carries more precision than one mote
 * (10^-9 CSPR). Truncating here would silently under-pay the payee, so the
 * conversion FAILS LOUD instead (CD-3).
 */
export class CasperAmountPrecisionError extends Error {
  public readonly amount: string;

  constructor(amount: string) {
    super(
      `CasperAmountPrecisionError: amount "${amount}" has more than ${CSPR_DECIMALS} ` +
        `decimal places (sub-mote precision would be lost).`,
    );
    this.name = 'CasperAmountPrecisionError';
    this.amount = amount;
  }
}

/**
 * Exact decimal-CSPR → motes conversion (CD-2, CD-3).
 *
 * Pure integer/string math — NEVER `Number(...) * 1e9`, which loses precision
 * above 2^53 and introduces binary-float drift (e.g. `0.07 * 1e9`).
 * Throws `CasperAmountPrecisionError` on sub-mote precision and `RangeError`
 * on a malformed amount.
 */
export function csprToMotes(amount: string): bigint {
  if (!DECIMAL_STRING_RE.test(amount)) {
    throw new RangeError(`Invalid CSPR amount: "${amount}"`);
  }
  const dot = amount.indexOf('.');
  if (dot === -1) return BigInt(amount) * 10n ** BigInt(CSPR_DECIMALS);

  const whole = amount.slice(0, dot);
  const frac = amount.slice(dot + 1);
  if (frac.length > CSPR_DECIMALS) {
    // Only a trailing run of zeros beyond the 9th decimal is lossless.
    if (/[^0]/u.test(frac.slice(CSPR_DECIMALS))) throw new CasperAmountPrecisionError(amount);
  }
  const padded = frac.slice(0, CSPR_DECIMALS).padEnd(CSPR_DECIMALS, '0');
  return BigInt(whole) * 10n ** BigInt(CSPR_DECIMALS) + BigInt(padded);
}

/** Exact motes → decimal-CSPR rendering (inverse of `csprToMotes`, no rounding). */
export function motesToCspr(motes: bigint): string {
  const base = 10n ** BigInt(CSPR_DECIMALS);
  const neg = motes < 0n;
  const abs = neg ? -motes : motes;
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(CSPR_DECIMALS, '0').replace(/0+$/u, '');
  const rendered = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${rendered}` : rendered;
}

export function isCasperPublicKey(value: string): boolean {
  return CASPER_PUBLIC_KEY_RE.test(value);
}

export function isCasperAccountHash(value: string): boolean {
  return CASPER_ACCOUNT_HASH_RE.test(value);
}

/** A payee may be addressed by public key or by account hash. */
export function isCasperPayTo(value: string): boolean {
  return isCasperPublicKey(value) || isCasperAccountHash(value);
}

export function isCasperContractHash(value: string): boolean {
  return CASPER_CONTRACT_HASH_RE.test(value);
}

/** Normalizes `hash-<hex>` and bare `<hex>` to the bare lowercase hex form. */
function normalizeContractHash(value: string): string {
  return value.replace(/^hash-/u, '').toLowerCase();
}

export interface CasperAdapterOpts {
  /** `casper` (mainnet) | `casper-test` (testnet). */
  readonly network: CasperNetwork;
  /** wCSPR CEP-18 contract hash (`hash-<hex>` or bare hex). */
  readonly wcsprContractHash: string;
  /** Facilitator base URL; defaults to https://x402-facilitator.cspr.cloud. */
  readonly facilitatorUrl?: string;
  /** Optional bearer token for a private facilitator deployment. */
  readonly facilitatorApiKey?: string;
  /** Per-request timeout in ms (default 10_000). */
  readonly timeoutMs?: number;
  /** DI (mirrors SolanaAdapterOpts.connection): tests inject a fake fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Parsed + validated inputs for a Casper verify/settle. */
interface CasperInput {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly from: string;
  readonly signature: string;
}

/** Minimal x402 v2 facilitator responses this adapter consumes. */
interface FacilitatorVerifyResponse {
  readonly isValid?: unknown;
  readonly invalidReason?: unknown;
  readonly payer?: unknown;
}

interface FacilitatorSettleResponse {
  readonly success?: unknown;
  readonly errorReason?: unknown;
  readonly transaction?: unknown;
  readonly payer?: unknown;
  readonly blockHeight?: unknown;
}

export class CasperAdapter implements SettlementAdapter {
  public readonly metadata: ChainMetadata;
  private readonly _network: CasperNetwork;
  private readonly _networkId: string;
  private readonly _wcspr: string;
  private readonly _facilitatorUrl: string;
  private readonly _facilitatorApiKey: string | undefined;
  private readonly _timeoutMs: number;
  private readonly _fetch: typeof fetch;

  constructor(opts: CasperAdapterOpts) {
    if (!isCasperContractHash(opts.wcsprContractHash)) {
      throw new RangeError(`Invalid wCSPR contract hash: "${opts.wcsprContractHash}"`);
    }
    this._network = opts.network;
    this._networkId = `casper:${opts.network}`;
    this._wcspr = normalizeContractHash(opts.wcsprContractHash);
    // Trailing slashes are stripped so `${base}/verify` never becomes `//verify`.
    this._facilitatorUrl = (opts.facilitatorUrl ?? CASPER_FACILITATOR_URL_DEFAULT).replace(
      /\/+$/u,
      '',
    );
    this._facilitatorApiKey = opts.facilitatorApiKey;
    this._timeoutMs = opts.timeoutMs ?? FACILITATOR_TIMEOUT_MS_DEFAULT;
    this._fetch = opts.fetchImpl ?? fetch;

    this.metadata = {
      chainId: asChainId(syntheticChainId(opts.network)),
      name: opts.network === 'casper' ? 'Casper Mainnet' : 'Casper Testnet',
      network: opts.network === 'casper' ? 'mainnet' : 'testnet',
      networkId: this._networkId,
      // The facilitator is this rail's only remote dependency — there is no
      // node RPC of our own, so it doubles as the adapter's "rpcUrl".
      rpcUrl: this._facilitatorUrl,
      blockExplorer:
        opts.network === 'casper' ? 'https://cspr.live' : 'https://testnet.cspr.live',
      nativeCurrency: { name: 'Casper', symbol: 'CSPR', decimals: CSPR_DECIMALS },
      tokens: [
        {
          address: `0x${this._wcspr}` as Address,
          symbol: 'WCSPR',
          decimals: CSPR_DECIMALS,
          name: 'Wrapped CSPR',
        },
      ],
    };
  }

  /**
   * Parse + validate the request. The x402 `VerifyParams` shape carries Casper
   * public keys / account hashes / contract hashes (not 0x-hex EVM addresses)
   * for the casper namespace, read through ONE sanctioned boundary cast — the
   * same pattern as solana-adapter.ts `_parseSolanaInput`.
   */
  private _parseCasperInput(params: VerifyParams): AdapterResult<CasperInput> {
    const invalid = {
      ok: false as const,
      error: { code: 'NETWORK_MISMATCH' as const, message: 'invalid casper request', http: 400 },
    };
    try {
      const accepted = params.accepted;
      const payload = params.payload as unknown as {
        signature?: unknown;
        authorization?: { from?: unknown; to?: unknown; value?: unknown };
      };

      const network = accepted.network;
      const asset = accepted.asset;
      const payTo = accepted.payTo;
      const signature = payload.signature;
      const from = payload.authorization?.from;

      if (
        typeof network !== 'string' ||
        typeof asset !== 'string' ||
        typeof payTo !== 'string' ||
        typeof signature !== 'string' ||
        typeof from !== 'string'
      ) {
        return invalid;
      }
      if (network !== this._networkId) {
        return {
          ok: false,
          error: { code: 'NETWORK_MISMATCH', message: 'network mismatch', http: 400 },
        };
      }
      // CD-1: the settlement asset is pinned to the CONFIGURED wCSPR contract
      // hash — a caller cannot substitute a look-alike CEP-18 via accepted.asset.
      if (!isCasperContractHash(asset) || normalizeContractHash(asset) !== this._wcspr) {
        return {
          ok: false,
          error: { code: 'NETWORK_MISMATCH', message: 'asset mismatch', http: 400 },
        };
      }
      if (!isCasperPayTo(payTo)) {
        return {
          ok: false,
          error: { code: 'INVALID_RECEIVER', message: 'invalid payTo address', http: 400 },
        };
      }
      if (!isCasperPublicKey(from)) {
        return invalid;
      }
      if (signature.length === 0) return invalid;

      // CD-2: `accepted.amount` is ALWAYS motes (atomic units), like every other
      // x402 amount in this facilitator. Canonical uint string only.
      if (!UINT_STRING_RE.test(accepted.amount)) {
        return {
          ok: false,
          error: { code: 'INVALID_AMOUNT', message: 'amount must be motes (uint string)', http: 400 },
        };
      }
      const amount = BigInt(accepted.amount);
      if (amount <= 0n) {
        return {
          ok: false,
          error: { code: 'INVALID_AMOUNT', message: 'amount must be positive', http: 400 },
        };
      }

      return { ok: true, network, asset, payTo, amount, from, signature };
    } catch {
      return invalid;
    }
  }

  /** Builds the x402 v2 facilitator body (`paymentPayload` + `paymentRequirements`). */
  private _facilitatorBody(params: VerifyParams, input: CasperInput): unknown {
    return {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: params.accepted.scheme,
        network: input.network,
        payload: params.payload,
      },
      paymentRequirements: {
        scheme: params.accepted.scheme,
        network: input.network,
        maxAmountRequired: input.amount.toString(),
        asset: params.accepted.asset,
        payTo: input.payTo,
        resource: params.resource.url,
        description: params.resource.description ?? '',
        mimeType: params.resource.mimeType ?? '',
        maxTimeoutSeconds: params.accepted.maxTimeoutSeconds,
        extra: params.accepted.extra,
      },
    };
  }

  /**
   * One facilitator round-trip. NEVER throws — transport failures, non-2xx
   * responses and malformed JSON all collapse to a REJECT (CD-4, fail-CLOSED).
   */
  private async _post<T>(path: string, body: unknown): Promise<AdapterResult<{ data: T }>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this._facilitatorApiKey !== undefined) {
      headers['authorization'] = `Bearer ${this._facilitatorApiKey}`;
    }

    let response: Response;
    try {
      response = await this._fetch(`${this._facilitatorUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch {
      // Transport error / timeout — the rail is unreachable, not the payment
      // invalid. Mirrors the EVM breaker-open semantics (503).
      return {
        ok: false,
        error: {
          code: 'CHAIN_UNAVAILABLE',
          message: 'casper facilitator unreachable',
          http: 503,
        },
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status >= 500 ? 'CHAIN_UNAVAILABLE' : 'TRANSACTION_FAILED',
          message: `casper facilitator error (HTTP ${response.status})`,
          http: response.status >= 500 ? 503 : 400,
        },
      };
    }

    try {
      const data = (await response.json()) as T;
      if (typeof data !== 'object' || data === null) {
        return {
          ok: false,
          error: {
            code: 'TRANSACTION_FAILED',
            message: 'malformed casper facilitator response',
            http: 500,
          },
        };
      }
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'malformed casper facilitator response',
          http: 500,
        },
      };
    }
  }

  /**
   * `SettlementAdapter.probeRpc()` — Casper liveness sonda (non-EVM).
   *
   * The facilitator's `/supported` endpoint is the cheapest round-trip that
   * proves the rail answers: it is served from the facilitator's own static
   * configuration (no ledger read, no finality wait), so it is the analogue of
   * `eth_chainId` on EVM and `getVersion()` on Solana. The caller
   * (`src/core/health-status.ts`) bounds it with a short timeout, so no
   * retry/backoff is added here.
   */
  async probeRpc(): Promise<void> {
    const response = await this._fetch(`${this._facilitatorUrl}/supported`, {
      method: 'GET',
      signal: AbortSignal.timeout(this._timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`casper facilitator probe failed (HTTP ${response.status})`);
    }
  }

  async verify(params: VerifyParams): Promise<AdapterResult<VerifyResult>> {
    const parsed = this._parseCasperInput(params);
    if (!parsed.ok) return parsed;

    const res = await this._post<FacilitatorVerifyResponse>(
      '/verify',
      this._facilitatorBody(params, parsed),
    );
    if (!res.ok) return res;

    // CD-4: only an explicit `isValid === true` passes. `undefined`/absent is a
    // reject, never an implicit accept.
    if (res.data.isValid !== true) {
      const reason =
        typeof res.data.invalidReason === 'string' && res.data.invalidReason.length > 0
          ? res.data.invalidReason
          : 'payment rejected by casper facilitator';
      return { ok: false, error: { code: 'INVALID_SIGNATURE', message: reason, http: 400 } };
    }

    const payer = typeof res.data.payer === 'string' ? res.data.payer : parsed.from;
    return {
      ok: true,
      verified: true,
      // Casper keys/hashes ride the branded Address fields via ONE sanctioned
      // boundary cast — the same pattern solana-adapter.ts uses for base58.
      client: payer as unknown as Address,
      amount: parsed.amount.toString(),
      asset: parsed.asset as unknown as Address,
      network: parsed.network,
      payTo: parsed.payTo as unknown as Address,
      // Point-in-time answer from the facilitator (mirror of the Solana adapter).
      expiresAt: 0,
    };
  }

  async settle(params: SettleParams): Promise<AdapterResult<SettleResult>> {
    const parsed = this._parseCasperInput(params);
    if (!parsed.ok) return parsed;

    const res = await this._post<FacilitatorSettleResponse>(
      '/settle',
      this._facilitatorBody(params, parsed),
    );
    if (!res.ok) return res;

    if (res.data.success !== true) {
      const reason =
        typeof res.data.errorReason === 'string' && res.data.errorReason.length > 0
          ? res.data.errorReason
          : 'settlement rejected by casper facilitator';
      return { ok: false, error: { code: 'TRANSACTION_FAILED', message: reason, http: 500 } };
    }

    const deployHash = typeof res.data.transaction === 'string' ? res.data.transaction : '';
    if (!CASPER_DEPLOY_HASH_RE.test(deployHash)) {
      // A "success" without a usable deploy hash is unauditable → fail-CLOSED.
      return {
        ok: false,
        error: {
          code: 'TRANSACTION_FAILED',
          message: 'malformed casper facilitator response',
          http: 500,
        },
      };
    }

    const payer = typeof res.data.payer === 'string' ? res.data.payer : parsed.from;
    const blockHeight =
      typeof res.data.blockHeight === 'number' && Number.isInteger(res.data.blockHeight)
        ? res.data.blockHeight
        : 0;

    return {
      ok: true,
      settled: true,
      transactionHash: deployHash as unknown as `0x${string}`,
      blockNumber: blockHeight,
      amount: parsed.amount.toString(),
      from: payer as unknown as Address,
      to: parsed.payTo as unknown as Address,
      asset: parsed.asset as unknown as Address,
    };
  }

  /** Exposed for `/supported` introspection and tests. */
  get casperNetwork(): CasperNetwork {
    return this._network;
  }
}

/**
 * Opt-in-off factory (mirror of `solanaAdapter`). Returns `null` unless the
 * network's `*_ENABLED` flag is `true` AND its wCSPR contract hash is set, so
 * existing deployments boot identically to before this adapter landed.
 */
function buildCasperAdapter(network: CasperNetwork): CasperAdapter | null {
  const prefix = network === 'casper' ? 'CASPER_MAINNET' : 'CASPER_TESTNET';
  if (process.env[`${prefix}_ENABLED`] !== 'true') return null;
  const wcsprContractHash = process.env[`${prefix}_WCSPR_CONTRACT_HASH`];
  if (!wcsprContractHash) return null;
  const facilitatorUrl = process.env['CASPER_FACILITATOR_URL'] ?? CASPER_FACILITATOR_URL_DEFAULT;
  const facilitatorApiKey = process.env['CASPER_FACILITATOR_API_KEY'];
  try {
    return new CasperAdapter({
      network,
      wcsprContractHash,
      facilitatorUrl,
      ...(facilitatorApiKey === undefined ? {} : { facilitatorApiKey }),
    });
  } catch {
    return null;
  }
}

export const casperMainnetAdapter: CasperAdapter | null = buildCasperAdapter('casper');
export const casperTestnetAdapter: CasperAdapter | null = buildCasperAdapter('casper-test');
