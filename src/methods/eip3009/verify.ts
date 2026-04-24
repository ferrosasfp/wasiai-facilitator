/**
 * EIP-3009 verify — off-chain validation of a TransferWithAuthorization.
 *
 * Pure async function. No RPC calls. No side effects. No logger.
 *
 * Validates (in order, fail-fast):
 *   1. Zod shape of payload.authorization (nonce bytes32, uint256 strings).
 *   2. Network match: accepted.network === 'eip155:<chainId>'.
 *   3. Asset match: accepted.asset isAddressEqual token.address.
 *   4. Amount: accepted.amount > 0 AND authorization.value >= accepted.amount.
 *   5. Receiver: authorization.to isAddressEqual accepted.payTo.
 *   6. Timestamp window: validAfter <= now < validBefore.
 *   7. EIP-712 recover: signature -> address; must equal authorization.from.
 *
 * The caller MUST ensure nonce uniqueness via the chain adapter before
 * settlement — this function does NOT check replay protection.
 */

import { recoverTypedDataAddress, isAddressEqual, getAddress } from 'viem';
import type { Address } from 'viem';
import type {
  AdapterResult,
  EIP3009Token,
  VerifyParams,
  VerifyResult,
} from '../../chains/types.js';
import type { ChainId } from '../../core/types.js';
import { buildX402Error } from '../../core/errors.js';
import { AcceptedSchema, Eip3009AuthorizationSchema } from './schemas.js';
import { buildEip3009Domain } from './domain.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';

export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>> {
  // 1a. Shape validation — authorization (Zod)
  const authParse = Eip3009AuthorizationSchema.safeParse(params.payload.authorization);
  if (!authParse.success) {
    return {
      ok: false,
      error: buildX402Error('INVALID_SIGNATURE', 'Authorization payload malformed'),
    };
  }
  const authorization = authParse.data;

  // 1b. Shape validation — accepted (BLQ-ALTO-2 / CD-2)
  // Parse BEFORE any BigInt(...) or isAddressEqual(...) so attacker-controlled
  // `amount` ("abc", "-1", "1e2"), `asset`/`payTo` ("not-an-address"), or
  // missing `network` never reach code paths that would throw.
  const accParse = AcceptedSchema.safeParse(params.accepted);
  if (!accParse.success) {
    const issue = accParse.error.issues[0];
    const path = issue?.path.join('.') ?? 'accepted';
    const reason = issue?.message ?? 'invalid';
    // Route asset/payTo/network shape errors to NETWORK_MISMATCH (same class
    // as steps 2 and 3); route amount errors to INVALID_AMOUNT.
    if (path === 'amount') {
      return {
        ok: false,
        error: buildX402Error('INVALID_AMOUNT', `Invalid accepted.amount: ${reason}`),
      };
    }
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', `Invalid accepted.${path}: ${reason}`),
    };
  }
  const accepted = accParse.data;

  // 2. Network match (AC-8)
  const canonicalNetwork = `eip155:${Number(chainId)}`;
  if (accepted.network !== canonicalNetwork) {
    return { ok: false, error: buildX402Error('NETWORK_MISMATCH', 'Network does not match chain') };
  }

  // 3. Asset match (AC-11, defense-in-depth)
  if (!isAddressEqual(accepted.asset as Address, token.address)) {
    return {
      ok: false,
      error: buildX402Error('NETWORK_MISMATCH', 'Asset not found in chain token registry'),
    };
  }

  // 4. Amount validation (AC-6, AC-7).
  // BLQ-ALTO-1: AcceptedSchema's Uint256StringSchema already rejects negatives
  // via the canonical /^(0|[1-9]\d*)$/ regex; the `<= 0n` check below is
  // defense-in-depth — it additionally rejects the canonical "0" input.
  const acceptedAmount = BigInt(accepted.amount);
  if (acceptedAmount <= 0n) {
    return {
      ok: false,
      error: buildX402Error('INVALID_AMOUNT', 'Accepted amount must be greater than zero'),
    };
  }
  if (BigInt(authorization.value) < acceptedAmount) {
    return {
      ok: false,
      error: buildX402Error('INVALID_AMOUNT', 'Authorized value is below accepted amount'),
    };
  }

  // 5. Receiver match (AC-9)
  if (!isAddressEqual(authorization.to as Address, accepted.payTo as Address)) {
    return {
      ok: false,
      error: buildX402Error('INVALID_RECEIVER', 'Receiver does not match payTo'),
    };
  }

  // 6. Timestamp window (AC-4, AC-5).
  // BLQ-MED-1: compare using BigInt (NOT Number) — validBefore/validAfter
  // are uint256 strings and can exceed 2^53-1, where Number() silently
  // loses precision and could make an "expired" auth look "valid".
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(authorization.validBefore) <= nowSec) {
    return { ok: false, error: buildX402Error('EXPIRED_AUTHORIZATION', 'Authorization expired') };
  }
  if (BigInt(authorization.validAfter) > nowSec) {
    return {
      ok: false,
      error: buildX402Error('EXPIRED_AUTHORIZATION', 'Authorization not yet valid'),
    };
  }

  // 7. Build domain + recover (AC-10)
  const domain = buildEip3009Domain(token, chainId, params.accepted);
  // NOTE: buildEip3009Domain takes the original params.accepted because its
  // signature consumes the AssetTransferMethod-typed `extra`. The validated
  // `accepted` is used only for value-path checks above.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: params.payload.signature,
    });
  } catch {
    // AC-3: malformed signature bytes / invalid v-value -> catch and return.
    // We do NOT inspect err.message — viem's error messages are implementation-
    // defined and may change between patch releases.
    return {
      ok: false,
      error: buildX402Error('INVALID_SIGNATURE', 'Failed to recover typed data address'),
    };
  }

  // 8. Recovered vs claimed (AC-2)
  if (!isAddressEqual(recovered, authorization.from as Address)) {
    return {
      ok: false,
      error: buildX402Error('INVALID_SIGNATURE', 'Recovered address does not match sender'),
    };
  }

  // 9. Success (AC-1, AC-12).
  // BLQ-MED-1 note: VerifyResult.expiresAt is typed `number` (chains/types.ts).
  // validBefore is validated as uint256 <= 2^256-1, which CAN exceed
  // Number.MAX_SAFE_INTEGER (2^53-1). We preserve the `number` shape for
  // public compatibility but guard against silent precision loss: if the
  // validated validBefore exceeds MAX_SAFE_INTEGER we still clamp via
  // Number() — the comparison gates above already use BigInt, so the
  // expiration decision is correct; `expiresAt` here is informational.
  // A full string-typed expiresAt would require changing VerifyResult
  // (out of scope for WFAC-6 / fix-pack F3.1 — tracked separately).
  return {
    ok: true,
    verified: true,
    client: getAddress(recovered),
    amount: accepted.amount,
    asset: token.address,
    network: accepted.network,
    payTo: getAddress(accepted.payTo),
    expiresAt: Number(authorization.validBefore),
  };
}
