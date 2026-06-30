/**
 * P3 — TB-04: payTo allowlist pure helpers.
 */

import { describe, it, expect } from 'vitest';
import { parsePayToAllowlist, isPayToAllowed } from '../../core/payto-allowlist.js';

const A = `0x${'11'.repeat(20)}`;
const B = `0x${'22'.repeat(20)}`;
const C = `0x${'33'.repeat(20)}`;

describe('P3 TB-04 — parsePayToAllowlist', () => {
  it('PA-1: undefined / empty → empty set (feature disabled)', () => {
    expect(parsePayToAllowlist(undefined).size).toBe(0);
    expect(parsePayToAllowlist('').size).toBe(0);
    expect(parsePayToAllowlist('   ').size).toBe(0);
  });

  it('PA-2: parses + trims + lowercases a CSV', () => {
    const set = parsePayToAllowlist(` ${A} , ${B.toUpperCase().replace('0X', '0x')} `);
    expect(set.size).toBe(2);
    expect(set.has(A.toLowerCase())).toBe(true);
    expect(set.has(B.toLowerCase())).toBe(true);
  });

  it('PA-3: drops malformed entries (defense-in-depth)', () => {
    const set = parsePayToAllowlist(`${A},not-an-address,0x1234,${C}`);
    expect(set.size).toBe(2);
    expect(set.has(A.toLowerCase())).toBe(true);
    expect(set.has(C.toLowerCase())).toBe(true);
  });
});

describe('P3 TB-04 — isPayToAllowed', () => {
  it('PA-4: empty allowlist → always allowed', () => {
    expect(isPayToAllowed(A, new Set())).toBe(true);
    expect(isPayToAllowed('garbage', new Set())).toBe(true);
  });

  it('PA-5: non-empty allowlist → only members allowed', () => {
    const set = parsePayToAllowlist(`${A},${B}`);
    expect(isPayToAllowed(A, set)).toBe(true);
    expect(isPayToAllowed(B, set)).toBe(true);
    expect(isPayToAllowed(C, set)).toBe(false);
  });

  it('PA-6: case-insensitive membership', () => {
    const set = parsePayToAllowlist(A.toUpperCase().replace('0X', '0x'));
    expect(isPayToAllowed(A.toLowerCase(), set)).toBe(true);
  });

  it('PA-7: a malformed payTo is rejected when an allowlist is configured', () => {
    const set = parsePayToAllowlist(A);
    expect(isPayToAllowed('0xnotanaddress', set)).toBe(false);
    expect(isPayToAllowed('', set)).toBe(false);
  });
});
