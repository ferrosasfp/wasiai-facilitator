/**
 * WFAC-50 — Operator account singleton.
 *
 * Exposes `getOperatorAccount(): Account` — lazily builds (and caches) a viem
 * `Account` from `OPERATOR_PRIVATE_KEY`. All chain adapters inject this into
 * their `WalletClient` to get signing capability:
 *
 *   const wallet = createWalletClient({ account: getOperatorAccount(), chain, transport });
 *
 * Security:
 *   - The private key hex is read ONCE from process.env and discarded.
 *   - The returned `Account` object does NOT expose the private key.
 *   - Validation: /^0x[0-9a-fA-F]{64}$/ (defense-in-depth over EnvSchema).
 *   - On missing/invalid: throws `ChainAdapterInitError` with env var name
 *     (but NOT the value — the value is absent or malformed).
 *
 * Boundary (OWNERS.md row `src/chains/<chain>.ts` updated in WFAC-50 W3):
 *   `src/chains/*` MAY import this module (DT-J). No other consumer uses it.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';
import { ChainAdapterInitError } from '../chains/types.js';

const OPERATOR_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;
let _cached: Account | null = null;

/**
 * Return the singleton operator `Account`, building it lazily on first call.
 *
 * Throws `ChainAdapterInitError('OPERATOR_PRIVATE_KEY', 0)` when the env var
 * is missing or malformed. chainId 0 is a documented sentinel — wallet.ts is
 * chain-agnostic, but `ChainAdapterInitError` requires a numeric chainId.
 */
export function getOperatorAccount(): Account {
  if (_cached) return _cached;
  const pk = process.env['OPERATOR_PRIVATE_KEY'];
  if (!pk || !OPERATOR_KEY_REGEX.test(pk)) {
    // chainId 0 as sentinel — error is not chain-specific here.
    throw new ChainAdapterInitError('OPERATOR_PRIVATE_KEY', 0);
  }
  _cached = privateKeyToAccount(pk as `0x${string}`);
  return _cached;
}

/**
 * @internal — tests only. Resets the cached Account so subsequent calls
 * re-read `process.env.OPERATOR_PRIVATE_KEY`. Used by tests that swap the
 * env var between `describe` blocks.
 */
export function resetOperatorAccountForTesting(): void {
  _cached = null;
}
