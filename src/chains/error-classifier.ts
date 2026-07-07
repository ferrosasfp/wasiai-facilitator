/**
 * WKH-154 — Chain error classifier: transport (counts toward the circuit
 * breaker) vs business (does NOT count).
 *
 * PROBLEM: the per-chain circuit breaker (circuit-breaker.ts) counts EVERY
 * settle/verify business failure (SIMULATION_FAILED / TRANSACTION_FAILED) as a
 * failure. Under same-account contention on a healthy chain, viem's simulate
 * step legitimately fails ("gas required exceeds allowance", "nonce too low",
 * "execution reverted") — these are BUSINESS outcomes, not a chain outage. When
 * enough of them stack up, the breaker OPENS and starts 503-ing GOOD settles
 * (the Chaski-$0 symptom).
 *
 * FIX: classify the raw viem/RPC error. Only genuine TRANSPORT failures (RPC
 * unreachable, HTTP 5xx, timeouts, socket errors) should count toward the
 * breaker. Business failures are tagged (see `tagBusiness`) so the adapter
 * wrapper can resolve them as an outcome instead of throwing (which is what
 * cockatiel counts).
 *
 * DESIGN INVARIANTS:
 *   - Duck-typing only, never type-identity operators (CD-9): viem error classes
 *     are not a stable import contract and cross realms. We inspect
 *     name/code/status/text.
 *   - Business is matched BEFORE transport (CD-12): a `gas required exceeds
 *     allowance` carried inside an `RpcRequestError` must win as business.
 *   - Default is `'transport'` (CD-1 / AC-5 fail-safe): an unknown error counts,
 *     so a genuine outage is never silently ignored. NEVER default to business.
 *
 * Boundaries (OWNERS.md row `src/chains/<chain>.ts`): pure TS, no runtime
 * imports from core/routes/methods/infra. Consumed by base-adapter.ts.
 */

export type ChainErrorClass = 'transport' | 'business';

/** Max depth walked along `.cause` — guards against cyclic/adversarial chains. */
const MAX_CAUSE_DEPTH = 10;

/** viem/ethers error `name`s that are always BUSINESS (revert/nonce/fee). */
const BUSINESS_NAMES: ReadonlySet<string> = new Set([
  'ExecutionRevertedError',
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
  'InsufficientFundsError',
  'NonceTooLowError',
  'NonceTooHighError',
  'NonceMaxValueError',
  'IntrinsicGasTooLowError',
  'IntrinsicGasTooHighError',
  'TipAboveFeeCapError',
  'FeeCapTooLowError',
  'FeeCapTooHighError',
]);

/** Lowercased substrings that mark a BUSINESS failure. */
const BUSINESS_SUBSTRINGS: readonly string[] = [
  'gas required exceeds allowance',
  'execution reverted',
  'insufficient funds',
  'nonce too low',
  'nonce too high',
  'already known',
  'replacement transaction underpriced',
  'authorization is used',
  'authorization used',
  'transfer amount exceeds balance',
  'intrinsic gas too low',
];

/** viem/RPC error `name`s that are TRANSPORT (connectivity/RPC infra). */
const TRANSPORT_NAMES: ReadonlySet<string> = new Set([
  'HttpRequestError',
  'TimeoutError',
  'SocketClosedError',
  'WebSocketRequestError',
  'RpcRequestError',
  'InternalRpcError',
  'ResourceUnavailableRpcError',
  'LimitExceededRpcError',
  'ParseRpcError',
  'ProviderDisconnectedError',
  'ChainDisconnectedError',
  'UnknownRpcError',
]);

/** Node.js socket/DNS error codes that are TRANSPORT. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Lowercased substrings that mark a TRANSPORT failure. */
const TRANSPORT_SUBSTRINGS: readonly string[] = [
  'fetch failed',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'connection refused',
  'connection reset',
  'network error',
  'request timed out',
  'took too long',
  'timeout',
];

/** Duck-typed view of one node in the cause chain (all fields optional). */
interface ErrorNode {
  readonly name?: string;
  readonly code?: string | number;
  readonly status?: number;
  readonly blob: string;
}

/** Safe string read — returns the value only if it is a string. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Duck-typed error shape. Only literal-keyed access is used against it, so the
 * `security/detect-object-injection` sink is never touched.
 */
interface RawErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly shortMessage?: unknown;
  readonly details?: unknown;
  readonly metaMessages?: unknown;
  readonly cause?: unknown;
}

/**
 * Walk `err → err.cause → …` (cap MAX_CAUSE_DEPTH, cycle-safe) and project
 * each node into an `ErrorNode`. Non-object roots (string/number/null/undefined)
 * yield a single node carrying only their stringified `blob`.
 */
function collectNodes(err: unknown): ErrorNode[] {
  const nodes: ErrorNode[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;

    if (typeof current !== 'object') {
      // Primitive (string/number/etc.) — only its text is meaningful.
      nodes.push({ blob: String(current).toLowerCase() });
      break;
    }

    if (seen.has(current)) break;
    seen.add(current);

    const obj = current as RawErrorLike;

    const name = asString(obj.name);
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? obj.code : undefined;
    const status = typeof obj.status === 'number' ? obj.status : undefined;

    const parts: string[] = [];
    for (const s of [asString(obj.message), asString(obj.shortMessage), asString(obj.details)]) {
      if (s !== undefined) parts.push(s);
    }
    if (Array.isArray(obj.metaMessages)) {
      parts.push(obj.metaMessages.filter((m): m is string => typeof m === 'string').join(' '));
    }
    const blob = parts.join(' ').toLowerCase();

    nodes.push({
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      blob,
    });

    current = obj.cause;
  }

  return nodes;
}

function isBusinessNode(node: ErrorNode): boolean {
  if (node.name !== undefined && BUSINESS_NAMES.has(node.name)) return true;
  if (node.code === 3 || node.code === 'CALL_EXCEPTION') return true;
  if (node.blob.length > 0) {
    for (const sub of BUSINESS_SUBSTRINGS) {
      if (node.blob.includes(sub)) return true;
    }
  }
  return false;
}

function isTransportNode(node: ErrorNode): boolean {
  if (node.name !== undefined && TRANSPORT_NAMES.has(node.name)) return true;
  if (typeof node.status === 'number' && node.status >= 500) return true;
  if (typeof node.code === 'string' && TRANSPORT_CODES.has(node.code)) return true;
  if (node.blob.length > 0) {
    for (const sub of TRANSPORT_SUBSTRINGS) {
      if (node.blob.includes(sub)) return true;
    }
  }
  return false;
}

/**
 * Classify a raw chain/RPC error as `'transport'` (counts toward the breaker)
 * or `'business'` (does not). Business is evaluated across ALL nodes BEFORE
 * transport (CD-12). Unknown/undefined/null → `'transport'` (AC-5 fail-safe).
 */
export function classifyChainError(err: unknown): ChainErrorClass {
  const nodes = collectNodes(err);

  // Business first (CD-12) — global over the whole chain, not per-node.
  for (const node of nodes) {
    if (isBusinessNode(node)) return 'business';
  }
  for (const node of nodes) {
    if (isTransportNode(node)) return 'transport';
  }

  // AC-5 fail-safe: unknown → transport (counts). NEVER business.
  return 'transport';
}

// ─── Non-enumerable business tag (CD-10) ──────────────────────────────────
// The marker is a module-private `unique symbol`, applied non-enumerably so it
// is invisible to `toEqual` / `toMatchObject` / `JSON.stringify` / spread — the
// AdapterResult the caller sees is byte-identical to today.

const BREAKER_CLASS: unique symbol = Symbol('breakerClass');

/** Mark `result` as a business failure (mutates in place, returns it). */
export function tagBusiness<T extends object>(result: T): T {
  Object.defineProperty(result, BREAKER_CLASS, {
    value: 'business',
    enumerable: false,
    configurable: true,
  });
  return result;
}

/** True iff `result` was tagged by `tagBusiness`. Safe on any input. */
export function isTaggedBusiness(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  // BREAKER_CLASS is a module-private symbol, never attacker-controlled.
  // eslint-disable-next-line security/detect-object-injection -- fixed module-private unique symbol key
  return (result as Record<symbol, unknown>)[BREAKER_CLASS] === 'business';
}
