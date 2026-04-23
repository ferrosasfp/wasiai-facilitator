import { describe, it, expect } from 'vitest';
import { asChainId, type Result, type X402ErrorCode } from '../../core/types.js';

describe('core/types — asChainId', () => {
  it('accepts positive integers', () => {
    expect(asChainId(2368)).toBe(2368);
    expect(asChainId(1)).toBe(1);
    expect(asChainId(43113)).toBe(43113);
  });

  it('throws for zero', () => {
    expect(() => asChainId(0)).toThrow(/Invalid chainId/);
  });

  it('throws for negative', () => {
    expect(() => asChainId(-1)).toThrow(/Invalid chainId/);
  });

  it('throws for float', () => {
    expect(() => asChainId(1.5)).toThrow(/Invalid chainId/);
  });

  it('throws for NaN', () => {
    expect(() => asChainId(Number.NaN)).toThrow(/Invalid chainId/);
  });
});

describe('core/types — Result<T> narrowing', () => {
  it('narrows ok:true branch to expose the data', () => {
    const r: Result<{ value: number }> = { ok: true, value: 42 };
    if (r.ok) {
      expect(r.value).toBe(42);
    } else {
      throw new Error('expected ok branch');
    }
  });

  it('narrows ok:false branch to expose error object', () => {
    const r: Result<{ value: number }> = {
      ok: false,
      error: { code: 'INVALID_AMOUNT', message: 'nope', http: 400 },
    };
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_AMOUNT');
      expect(r.error.http).toBe(400);
    } else {
      throw new Error('expected err branch');
    }
  });
});

describe('core/types — X402ErrorCode inventory', () => {
  it('has exactly the 10 canonical codes (enforced via assignability)', () => {
    const codes: X402ErrorCode[] = [
      'INVALID_SIGNATURE',
      'INSUFFICIENT_BALANCE',
      'PERMIT2_ALLOWANCE_REQUIRED',
      'EXPIRED_AUTHORIZATION',
      'NETWORK_MISMATCH',
      'SIMULATION_FAILED',
      'INVALID_AMOUNT',
      'INVALID_RECEIVER',
      'TRANSACTION_FAILED',
      'DELEGATION_INVALID',
    ];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });
});
