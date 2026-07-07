/**
 * WKH-154 W1 — Unit tests for the chain error classifier (in isolation).
 *
 * Pure duck-typed objects, NO real RPC (CD-4). Every case pins one branch of
 * `classifyChainError` plus the non-enumerable business tag (`tagBusiness` /
 * `isTaggedBusiness`).
 *
 * AC map: AC-1 (business) → EC-1..EC-4, EC-12; AC-2 (transport) → EC-5..EC-9,
 * EC-13; AC-5 (fail-safe transport default) → EC-10, EC-11; CD-10 (invisible
 * tag) → EC-TAG-1, EC-TAG-2.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyChainError,
  tagBusiness,
  isTaggedBusiness,
} from '../../../chains/error-classifier.js';

describe('classifyChainError — business (does NOT count toward the breaker)', () => {
  it('EC-1 (AC-1): EstimateGasExecutionError "gas required exceeds allowance" → business (crux Chaski)', () => {
    expect(
      classifyChainError({
        name: 'EstimateGasExecutionError',
        details: 'gas required exceeds allowance (24468/11800/62584)',
      }),
    ).toBe('business');
  });

  it('EC-2 (AC-1): ContractFunctionRevertedError "authorization is used" → business', () => {
    expect(
      classifyChainError({
        name: 'ContractFunctionRevertedError',
        message: 'execution reverted: FiatTokenV2: authorization is used',
      }),
    ).toBe('business');
  });

  it('EC-3 (AC-1): InsufficientFundsError → business', () => {
    expect(
      classifyChainError({ name: 'InsufficientFundsError', message: 'insufficient funds' }),
    ).toBe('business');
  });

  it('EC-4 (AC-1): NonceTooLowError and bare "already known" → business', () => {
    expect(classifyChainError({ name: 'NonceTooLowError', message: 'nonce too low' })).toBe(
      'business',
    );
    expect(classifyChainError({ message: 'already known' })).toBe('business');
  });
});

describe('classifyChainError — transport (COUNTS toward the breaker)', () => {
  it('EC-5 (AC-2): HttpRequestError status 503 → transport', () => {
    expect(classifyChainError({ name: 'HttpRequestError', status: 503 })).toBe('transport');
  });

  it('EC-6 (AC-2): TimeoutError "took too long" → transport', () => {
    expect(classifyChainError({ name: 'TimeoutError', message: 'took too long' })).toBe(
      'transport',
    );
  });

  it('EC-7 (AC-2): socket codes on .cause → transport', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
      expect(classifyChainError({ cause: { code } })).toBe('transport');
    }
  });

  it('EC-8 (AC-2): "fetch failed" → transport', () => {
    expect(classifyChainError({ message: 'fetch failed' })).toBe('transport');
  });

  it('EC-9 (AC-2): RpcRequestError with no business substring → transport', () => {
    expect(
      classifyChainError({ name: 'RpcRequestError', message: 'internal error', code: -32603 }),
    ).toBe('transport');
  });
});

describe('classifyChainError — fail-safe default (AC-5, counts, never throws)', () => {
  it('EC-10 (AC-5): unknown Error → transport', () => {
    expect(classifyChainError(new Error('some weird thing'))).toBe('transport');
  });

  it('EC-11 (AC-5): raw string / undefined / null → transport (no throw)', () => {
    expect(classifyChainError('raw string')).toBe('transport');
    expect(classifyChainError(undefined)).toBe('transport');
    expect(classifyChainError(null)).toBe('transport');
  });
});

describe('classifyChainError — cause-chain precedence (CD-12: business before transport)', () => {
  it('EC-12 (AC-1 / CD-12): transport-named wrapper with business cause → business', () => {
    expect(
      classifyChainError({
        name: 'EstimateGasExecutionError',
        cause: { name: 'RpcRequestError', message: 'gas required exceeds allowance' },
      }),
    ).toBe('business');
  });

  it('EC-13 (AC-2): wrapper with a genuine transport cause → transport', () => {
    expect(
      classifyChainError({
        name: 'EstimateGasExecutionError',
        cause: { name: 'TimeoutError', message: 'took too long' },
      }),
    ).toBe('transport');
  });
});

describe('tagBusiness / isTaggedBusiness — non-enumerable marker (CD-10)', () => {
  it('EC-TAG-1: tag is set yet invisible to keys / JSON / spread', () => {
    const r = { ok: false, error: { code: 'SIMULATION_FAILED' } };
    const returned = tagBusiness(r);

    expect(returned).toBe(r); // mutates and returns the same ref
    expect(isTaggedBusiness(r)).toBe(true);

    // Invisible to enumeration / serialization / spread.
    expect(Object.keys(r)).toEqual(['ok', 'error']);
    expect(JSON.parse(JSON.stringify(r))).toEqual({
      ok: false,
      error: { code: 'SIMULATION_FAILED' },
    });
    expect({ ...r }).toEqual(r);
    expect(isTaggedBusiness({ ...r })).toBe(false); // spread drops the symbol
  });

  it('EC-TAG-2: untagged / non-object inputs → false without throwing', () => {
    expect(isTaggedBusiness({ ok: false })).toBe(false);
    expect(isTaggedBusiness(undefined)).toBe(false);
    expect(isTaggedBusiness('x')).toBe(false);
    expect(isTaggedBusiness(null)).toBe(false);
  });
});
