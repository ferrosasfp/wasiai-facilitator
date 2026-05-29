/**
 * Unit tests for src/core/network.ts (WFAC-40).
 *
 * Pure function tests — no Fastify app, no inject, no mocks. Build a minimal
 * fake `FastifyRequest` with only the two fields the helper consumes
 * (`headers`, `ip`).
 */

import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../../../core/network.js';

function makeReq(headers: Record<string, string | string[]>, ip?: string): FastifyRequest {
  return { headers, ip: ip ?? '' } as unknown as FastifyRequest;
}

describe('extractClientIp (WFAC-40)', () => {
  // WFAC-AUDIT AC-2 (R-1 — INTENTIONAL semantic change, NOT a regression):
  // extractClientIp no longer parses the raw X-Forwarded-For element (that was
  // the rate-limit spoofing vector). It now trusts Fastify's resolved
  // request.ip exclusively. Under trustProxy, request.ip is already derived
  // from the correct XFF hop, so callers keep getting the real client IP — but
  // a forged raw XFF can no longer override it here.
  it('T-NET-1 (AC-2): ignores raw X-Forwarded-For, returns request.ip', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5' }, '10.0.0.1');
    expect(extractClientIp(req)).toBe('10.0.0.1');
  });

  it('T-NET-2 (AC-2): a forged XFF list cannot override request.ip', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.16.0.1' }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-3 (AC-2): array XFF variant is likewise ignored in favor of request.ip', () => {
    const req = makeReq({ 'x-forwarded-for': ['203.0.113.6, 10.0.0.2'] }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-4 (AC-8 XFF absent → request.ip fallback)', () => {
    const req = makeReq({}, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-5 (empty XFF string → request.ip fallback)', () => {
    const req = makeReq({ 'x-forwarded-for': '' }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-6 (XFF whitespace-only → request.ip fallback)', () => {
    const req = makeReq({ 'x-forwarded-for': '   ' }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-7 (XFF array empty → request.ip fallback)', () => {
    const req = makeReq({ 'x-forwarded-for': [] }, '127.0.0.1');
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('T-NET-8 (both absent → null)', () => {
    const req = makeReq({}, '');
    expect(extractClientIp(req)).toBeNull();
  });

  it('T-NET-9 (CD-9 pure): repeated invocation never throws', () => {
    const cases: Array<[Record<string, string | string[]>, string | undefined]> = [
      [{ 'x-forwarded-for': '1.1.1.1' }, '2.2.2.2'],
      [{ 'x-forwarded-for': '' }, '2.2.2.2'],
      [{}, '3.3.3.3'],
      [{ 'x-forwarded-for': [] }, ''],
      [{ 'x-forwarded-for': ['5.5.5.5'] }, undefined],
    ];
    for (const [h, ip] of cases) {
      expect(() => extractClientIp(makeReq(h, ip))).not.toThrow();
    }
  });
});
