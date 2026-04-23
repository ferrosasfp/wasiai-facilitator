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
import type { ChainId, X402ErrorCode } from '../../core/types.js';
import { Eip3009AuthorizationSchema } from './schemas.js';
import { buildEip3009Domain } from './domain.js';
import { EIP3009_TYPES, EIP3009_PRIMARY_TYPE } from './abi.js';

function err(code: X402ErrorCode, message: string, http: number): AdapterResult<VerifyResult> {
  return { ok: false, error: { code, message, http } };
}

export async function verifyEip3009(
  params: VerifyParams,
  token: EIP3009Token,
  chainId: ChainId,
): Promise<AdapterResult<VerifyResult>> {
  // 1. Shape validation (Zod)
  const authParse = Eip3009AuthorizationSchema.safeParse(params.payload.authorization);
  if (!authParse.success) {
    return err('INVALID_SIGNATURE', 'Authorization payload malformed', 401);
  }
  const authorization = authParse.data;

  // 2. Network match (AC-8)
  const canonicalNetwork = `eip155:${Number(chainId)}`;
  if (params.accepted.network !== canonicalNetwork) {
    return err('NETWORK_MISMATCH', 'Network does not match chain', 400);
  }

  // 3. Asset match (AC-11, defense-in-depth)
  if (!isAddressEqual(params.accepted.asset as Address, token.address)) {
    return err('NETWORK_MISMATCH', 'Asset not found in chain token registry', 400);
  }

  // 4. Amount validation (AC-6, AC-7)
  const acceptedAmount = BigInt(params.accepted.amount);
  if (acceptedAmount === 0n) {
    return err('INVALID_AMOUNT', 'Accepted amount must be greater than zero', 400);
  }
  if (BigInt(authorization.value) < acceptedAmount) {
    return err('INVALID_AMOUNT', 'Authorized value is below accepted amount', 400);
  }

  // 5. Receiver match (AC-9)
  if (!isAddressEqual(authorization.to as Address, params.accepted.payTo as Address)) {
    return err('INVALID_RECEIVER', 'Receiver does not match payTo', 400);
  }

  // 6. Timestamp window (AC-4, AC-5)
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(authorization.validBefore) <= nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization expired', 400);
  }
  if (Number(authorization.validAfter) > nowSec) {
    return err('EXPIRED_AUTHORIZATION', 'Authorization not yet valid', 400);
  }

  // 7. Build domain + recover (AC-10)
  const domain = buildEip3009Domain(token, chainId, params.accepted);
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
    return err('INVALID_SIGNATURE', 'Failed to recover typed data address', 401);
  }

  // 8. Recovered vs claimed (AC-2)
  if (!isAddressEqual(recovered, authorization.from as Address)) {
    return err('INVALID_SIGNATURE', 'Recovered address does not match sender', 401);
  }

  // 9. Success (AC-1, AC-12)
  return {
    ok: true,
    verified: true,
    client: getAddress(recovered),
    amount: params.accepted.amount,
    asset: token.address,
    network: params.accepted.network,
    payTo: getAddress(params.accepted.payTo),
    expiresAt: Number(authorization.validBefore),
  };
}
