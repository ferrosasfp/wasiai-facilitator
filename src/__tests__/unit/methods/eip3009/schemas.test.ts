/**
 * Unit tests for EIP-3009 Zod schemas.
 *
 * Covers the F3.1 fix-pack hardening on `Uint256StringSchema` (canonical
 * regex) and the newly-introduced `AcceptedSchema` (CD-2: no throws on
 * attacker-controlled `params.accepted`).
 *
 * Scope note: these tests exercise the SCHEMAS in isolation — end-to-end
 * behavior through `verifyEip3009` is already covered in verify.test.ts
 * (T-H9..T-H14).
 */

import { describe, it, expect } from 'vitest';
import {
  AcceptedSchema,
  AddressHexSchema,
  Bytes32HexSchema,
  Uint256StringSchema,
} from '../../../../methods/eip3009/schemas.js';

const VALID_ADDR = '0x1111111111111111111111111111111111111111';
const VALID_ADDR_2 = '0x2222222222222222222222222222222222222222';

describe('Uint256StringSchema (canonical form)', () => {
  it('accepts "0"', () => {
    expect(Uint256StringSchema.safeParse('0').success).toBe(true);
  });

  it('accepts "1"', () => {
    expect(Uint256StringSchema.safeParse('1').success).toBe(true);
  });

  it('accepts a large canonical value', () => {
    expect(Uint256StringSchema.safeParse('1000000000000000000').success).toBe(true);
  });

  it('accepts 2^256 - 1 (max uint256)', () => {
    const max = (2n ** 256n - 1n).toString();
    expect(Uint256StringSchema.safeParse(max).success).toBe(true);
  });

  it('rejects 2^256 (overflow, one past max)', () => {
    const over = (2n ** 256n).toString();
    expect(Uint256StringSchema.safeParse(over).success).toBe(false);
  });

  it('rejects leading zero "01000" (BLQ-BAJO-1)', () => {
    expect(Uint256StringSchema.safeParse('01000').success).toBe(false);
  });

  it('rejects "00" (non-canonical zero)', () => {
    expect(Uint256StringSchema.safeParse('00').success).toBe(false);
  });

  it('rejects negative "-1"', () => {
    expect(Uint256StringSchema.safeParse('-1').success).toBe(false);
  });

  it('rejects explicit plus "+1"', () => {
    expect(Uint256StringSchema.safeParse('+1').success).toBe(false);
  });

  it('rejects non-numeric "abc"', () => {
    expect(Uint256StringSchema.safeParse('abc').success).toBe(false);
  });

  it('rejects scientific notation "1e2"', () => {
    expect(Uint256StringSchema.safeParse('1e2').success).toBe(false);
  });

  it('rejects hex prefix "0x10"', () => {
    expect(Uint256StringSchema.safeParse('0x10').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(Uint256StringSchema.safeParse('').success).toBe(false);
  });

  it('rejects whitespace " 1 "', () => {
    expect(Uint256StringSchema.safeParse(' 1 ').success).toBe(false);
  });

  it('rejects non-string input (number)', () => {
    expect(Uint256StringSchema.safeParse(42).success).toBe(false);
  });
});

describe('AddressHexSchema', () => {
  it('accepts 20-byte hex', () => {
    expect(AddressHexSchema.safeParse(VALID_ADDR).success).toBe(true);
  });

  it('accepts mixed case (shape only, no checksum)', () => {
    expect(AddressHexSchema.safeParse('0xAbCdEf0123456789012345678901234567890123').success).toBe(
      true,
    );
  });

  it('rejects missing 0x prefix', () => {
    expect(AddressHexSchema.safeParse('1111111111111111111111111111111111111111').success).toBe(
      false,
    );
  });

  it('rejects 19-byte (too short)', () => {
    expect(AddressHexSchema.safeParse(`0x${'11'.repeat(19)}`).success).toBe(false);
  });

  it('rejects 21-byte (too long)', () => {
    expect(AddressHexSchema.safeParse(`0x${'11'.repeat(21)}`).success).toBe(false);
  });

  it('rejects "not-an-address"', () => {
    expect(AddressHexSchema.safeParse('not-an-address').success).toBe(false);
  });
});

describe('Bytes32HexSchema', () => {
  it('accepts 32-byte hex', () => {
    expect(Bytes32HexSchema.safeParse(`0x${'ab'.repeat(32)}`).success).toBe(true);
  });

  it('rejects 31-byte (too short)', () => {
    expect(Bytes32HexSchema.safeParse(`0x${'ab'.repeat(31)}`).success).toBe(false);
  });

  it('rejects non-hex chars', () => {
    expect(Bytes32HexSchema.safeParse(`0x${'ZZ'.repeat(32)}`).success).toBe(false);
  });
});

describe('AcceptedSchema (BLQ-ALTO-2 / CD-2)', () => {
  const validAccepted = {
    scheme: 'exact',
    network: 'eip155:2368',
    amount: '1000',
    asset: VALID_ADDR,
    payTo: VALID_ADDR_2,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009' },
  };

  it('accepts a fully-valid accepted payload', () => {
    expect(AcceptedSchema.safeParse(validAccepted).success).toBe(true);
  });

  it('passthrough: preserves optional fields (scheme, maxTimeoutSeconds, extra)', () => {
    const parsed = AcceptedSchema.safeParse(validAccepted);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // passthrough retains unknown keys
      expect((parsed.data as Record<string, unknown>).scheme).toBe('exact');
      expect((parsed.data as Record<string, unknown>).maxTimeoutSeconds).toBe(300);
    }
  });

  it('rejects amount = "-1" (BLQ-ALTO-1)', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, amount: '-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('amount');
    }
  });

  it('rejects amount = "abc" (BLQ-ALTO-2: prevents BigInt() throw)', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, amount: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('amount');
    }
  });

  it('rejects amount = "1e2" (scientific notation)', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, amount: '1e2' });
    expect(result.success).toBe(false);
  });

  it('rejects amount = "01000" (non-canonical leading zero)', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, amount: '01000' });
    expect(result.success).toBe(false);
  });

  it('rejects asset = "not-an-address"', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, asset: 'not-an-address' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('asset');
    }
  });

  it('rejects payTo with wrong length', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, payTo: '0x1234' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('payTo');
    }
  });

  it('rejects network = "" (empty string)', () => {
    const result = AcceptedSchema.safeParse({ ...validAccepted, network: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('network');
    }
  });

  it('rejects missing required field (amount)', () => {
    const { amount: _amount, ...withoutAmount } = validAccepted;
    void _amount;
    const result = AcceptedSchema.safeParse(withoutAmount);
    expect(result.success).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(AcceptedSchema.safeParse('string').success).toBe(false);
    expect(AcceptedSchema.safeParse(null).success).toBe(false);
    expect(AcceptedSchema.safeParse(undefined).success).toBe(false);
  });
});
