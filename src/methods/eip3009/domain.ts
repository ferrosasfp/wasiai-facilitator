/**
 * Pure builder for the EIP-712 domain used by EIP-3009 TransferWithAuthorization.
 *
 * Resolution precedence (see SDD §5 DT-B):
 *   name:    token.eip712Name ?? accepted.extra.name ?? token.name
 *   version: token.eip712Version ?? accepted.extra.version ?? '1'
 *   chainId: Number(chainId)  — numeric, NOT the eip155:<id> string
 *   verifyingContract: token.address
 *
 * No side effects. No I/O. No async. No logger.
 */

import type { TypedDataDomain } from 'viem';
import type { EIP3009Token, VerifyParams } from '../../chains/types.js';
import type { ChainId } from '../../core/types.js';

export function buildEip3009Domain(
  token: EIP3009Token,
  chainId: ChainId,
  accepted: VerifyParams['accepted'],
): TypedDataDomain {
  return {
    name: token.eip712Name ?? accepted.extra.name ?? token.name,
    version: token.eip712Version ?? accepted.extra.version ?? '1',
    chainId: Number(chainId),
    verifyingContract: token.address,
  };
}
