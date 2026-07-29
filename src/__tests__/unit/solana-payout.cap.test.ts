/**
 * WKH-302 — payout anti-abuse caps, fail-CLOSED (unit level).
 *
 * Redis is mocked at the infra wrapper (same pattern as solana-sponsor.cap.test.ts).
 * The assertion that matters: a null client OR a Redis error must REJECT — the
 * opposite of the EVM `settle-cap.ts`, which is fail-open on purpose. Fail-open on a
 * treasury route means paying while unable to count.
 *
 * The route-level `T-CAP-1`/`T-CAP-2`/`T-CAP-3` (money book unchanged) live in
 * `solana-payout.route.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  incr: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  set: vi.fn(async () => 'OK'),
  expire: vi.fn(async () => 1),
};

const h = vi.hoisted(() => ({ clientOrNull: { current: null as unknown } }));

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => h.clientOrNull.current,
}));

import {
  checkAndIncrPayoutRate,
  checkAndIncrPayoutDailyAtomic,
  releasePayoutDailyAtomic,
} from '../../core/solana-payout-cap.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  mockClient.incr.mockReset();
  mockClient.incrby.mockReset();
  mockClient.decrby.mockReset();
  mockClient.expire.mockReset();
  mockClient.expire.mockImplementation(async () => 1);
  mockClient.set.mockReset();
  mockClient.set.mockImplementation(async () => 'OK');
  logger.warn.mockReset();
  logger.debug.mockReset();
  h.clientOrNull.current = mockClient;
});

afterEach(() => vi.clearAllMocks());

describe('checkAndIncrPayoutRate — per-caller rate limit (fail-CLOSED)', () => {
  it('under the max → ok', async () => {
    mockClient.incr.mockResolvedValue(1);
    expect(await checkAndIncrPayoutRate(20, 60, logger, 'caller1')).toEqual({ ok: true });
  });

  it('over the max → rate_exceeded', async () => {
    mockClient.incr.mockResolvedValue(21);
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_exceeded');
  });

  it('★ Redis throws → FAIL-CLOSED', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ null client → FAIL-CLOSED', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ uses its OWN Redis prefix — never the sponsor bucket', async () => {
    mockClient.incr.mockResolvedValue(1);
    await checkAndIncrPayoutRate(20, 60, logger, 'caller1');
    const key = String(mockClient.incr.mock.calls.at(0)?.at(0));
    expect(key).toContain('solana:payout:rate:');
    expect(key).not.toContain('solana:sponsor:');
  });
});

describe('checkAndIncrPayoutDailyAtomic — daily ceiling (fail-CLOSED)', () => {
  it('accumulated <= cap → ok, increment sent as a decimal STRING', async () => {
    mockClient.incrby.mockResolvedValue(3_000_000);
    expect(
      await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'caller1'),
    ).toMatchObject({ ok: true });
    expect(mockClient.incrby).toHaveBeenCalledWith(expect.any(String), '3000000');
  });

  it('★ accumulated > cap → daily_exceeded', async () => {
    mockClient.incrby.mockResolvedValue(1_000_000_001);
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('exactly at the cap is allowed (comparison is >, not >=)', async () => {
    mockClient.incrby.mockResolvedValue(1_000_000_000);
    expect(
      await checkAndIncrPayoutDailyAtomic(1_000n, 1_000_000_000n, logger, 'caller1'),
    ).toMatchObject({ ok: true });
  });

  it('★ Redis throws → FAIL-CLOSED', async () => {
    mockClient.incrby.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ null client → FAIL-CLOSED', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrPayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('★ precision above 2^53 is exact (BigInt, WKH-196 lesson)', async () => {
    // A total one unit over a cap beyond Number.MAX_SAFE_INTEGER must still reject.
    const cap = 9_007_199_254_740_992n; // 2^53
    mockClient.incrby.mockResolvedValue('9007199254740993'); // 2^53 + 1, as a string
    const r = await checkAndIncrPayoutDailyAtomic(1n, cap, logger, 'c1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('cap <= 0 disables the ceiling without touching Redis', async () => {
    expect(await checkAndIncrPayoutDailyAtomic(3_000_000n, 0n, logger, 'c1')).toEqual({ ok: true });
    expect(mockClient.incrby).not.toHaveBeenCalled();
  });

  it('★ uses its OWN daily prefix — never the sponsor bucket', async () => {
    mockClient.incrby.mockResolvedValue(1);
    await checkAndIncrPayoutDailyAtomic(1n, 1_000_000_000n, logger, 'caller1');
    const key = String(mockClient.incrby.mock.calls.at(0)?.at(0));
    expect(key).toContain('solana:payout:daily:');
    expect(key).not.toContain('solana:sponsor:');
  });
});

describe('releasePayoutDailyAtomic — compensating decrement', () => {
  it('releases the exact counter the reservation returned', async () => {
    mockClient.decrby.mockResolvedValue(0);
    await releasePayoutDailyAtomic(
      3_000_000n,
      1_000_000_000n,
      logger,
      'solana:payout:daily:caller1:2026-07-29',
    );
    expect(mockClient.decrby).toHaveBeenCalledWith(
      'solana:payout:daily:caller1:2026-07-29',
      '3000000',
    );
  });

  it('never throws on a Redis error (best-effort)', async () => {
    mockClient.decrby.mockRejectedValue(new Error('redis down'));
    await expect(
      releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'k'),
    ).resolves.toBeUndefined();
  });

  it('never throws with a null client', async () => {
    h.clientOrNull.current = null;
    await expect(
      releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, 'k'),
    ).resolves.toBeUndefined();
  });

  it('no-op when the ceiling is disabled, the amount is non-positive, or no key', async () => {
    await releasePayoutDailyAtomic(3_000_000n, 0n, logger, 'k');
    await releasePayoutDailyAtomic(0n, 1_000_000_000n, logger, 'k');
    await releasePayoutDailyAtomic(3_000_000n, 1_000_000_000n, logger, undefined);
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });

  it('★ un contador que quedaría NEGATIVO se normaliza a 0', async () => {
    // `decrby` sobre una clave inexistente la CREA en negativo, y un contador
    // negativo es tope evadido durante todo ese día.
    mockClient.decrby.mockResolvedValue(-40_000_000);
    mockClient.set.mockResolvedValue('OK');
    await releasePayoutDailyAtomic(40_000_000n, 1_000_000_000n, logger, 'k');
    expect(mockClient.set).toHaveBeenCalledWith('k', '0');
  });
});

describe('AR BLQ-4 — la clave del contador se congela en la RESERVA', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ reservar 23:59:50 y liberar 00:00:05 devuelve el crédito al MISMO día', async () => {
    vi.useFakeTimers();
    // Reserva justo antes de la medianoche UTC.
    vi.setSystemTime(new Date('2026-07-29T23:59:50.000Z'));
    mockClient.incrby.mockResolvedValue(40_000_000);
    const reserved = await checkAndIncrPayoutDailyAtomic(
      40_000_000n,
      1_000_000_000n,
      logger,
      'caller1',
    );
    expect(reserved.ok).toBe(true);
    const reservedKey = String(mockClient.incrby.mock.calls.at(0)?.at(0));
    expect(reservedKey).toContain('2026-07-29');

    // Entre reservar y liberar hay claim, blockhash, firma, broadcast con
    // reintentos y confirmaciones: la ventana cruza la medianoche sin esfuerzo.
    vi.setSystemTime(new Date('2026-07-30T00:00:05.000Z'));
    mockClient.decrby.mockResolvedValue(0);
    await releasePayoutDailyAtomic(
      40_000_000n,
      1_000_000_000n,
      logger,
      reserved.ok ? reserved.dailyKey : undefined,
    );

    // El crédito vuelve a la clave del 29, NO a la del 30.
    const releasedKey = String(mockClient.decrby.mock.calls.at(0)?.at(0));
    expect(releasedKey).toBe(reservedKey);
    expect(releasedKey).toContain('2026-07-29');
    expect(releasedKey).not.toContain('2026-07-30');
  });

  it('control: dentro del mismo día la clave coincide igual (el test de arriba no es vacuo)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    mockClient.incrby.mockResolvedValue(1);
    const reserved = await checkAndIncrPayoutDailyAtomic(1n, 1_000_000_000n, logger, 'caller1');
    mockClient.decrby.mockResolvedValue(0);
    await releasePayoutDailyAtomic(
      1n,
      1_000_000_000n,
      logger,
      reserved.ok ? reserved.dailyKey : undefined,
    );
    expect(String(mockClient.decrby.mock.calls.at(0)?.at(0))).toBe(
      String(mockClient.incrby.mock.calls.at(0)?.at(0)),
    );
  });
});
