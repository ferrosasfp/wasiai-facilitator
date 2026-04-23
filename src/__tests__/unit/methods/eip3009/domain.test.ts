import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { buildEip3009Domain } from '../../../../methods/eip3009/domain.js';
import type { EIP3009Token, VerifyParams } from '../../../../chains/types.js';
import { asChainId } from '../../../../core/types.js';

describe('buildEip3009Domain', () => {
  const token: EIP3009Token = {
    address: '0x00000000000000000000000000000000000000ff' as Address,
    symbol: 'TEST',
    decimals: 6,
    name: 'Fallback Token Name',
  };

  const accepted = (extra?: { name?: string; version?: string }): VerifyParams['accepted'] => ({
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1',
    asset: token.address,
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', ...extra },
  });

  it('DT-B-1: uses token.eip712Name when present', () => {
    const t: EIP3009Token = { ...token, eip712Name: 'Canonical Name' };
    const d = buildEip3009Domain(t, asChainId(2368), accepted({ name: 'ignored' }));
    expect(d.name).toBe('Canonical Name');
  });

  it('DT-B-2: falls back to accepted.extra.name when eip712Name absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted({ name: 'From Extra' }));
    expect(d.name).toBe('From Extra');
  });

  it('DT-B-3: falls back to token.name when both absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.name).toBe('Fallback Token Name');
  });

  it('DT-B-4: version defaults to "1" when all absent', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.version).toBe('1');
  });

  it('DT-B-5: chainId is numeric (not eip155: string)', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.chainId).toBe(2368);
    expect(typeof d.chainId).toBe('number');
  });

  it('DT-B-6: verifyingContract is token.address verbatim', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d.verifyingContract).toBe(token.address);
  });

  it('DT-B-7: salt is NOT included (EIP-3009 canonical)', () => {
    const d = buildEip3009Domain(token, asChainId(2368), accepted());
    expect(d).not.toHaveProperty('salt');
  });
});
