/**
 * WKH-217 / HU-SOL-14 — anti-abuse caps (T15-T16), fail-CLOSED (AC-6, CD-6).
 *
 * Redis INCR/INCRBY mocked via `vi.mock('../../infra/redis.js')` (same pattern
 * as core.settle-cap.test.ts). The critical assertion vs the EVM settle-cap:
 * a null client OR a Redis error → REJECT (fail-closed), never fail-open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  incr: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  expire: vi.fn(async () => 1),
};

const h = vi.hoisted(() => ({ clientOrNull: { current: null as unknown } }));

vi.mock('../../infra/redis.js', () => ({
  getRedisClient: () => h.clientOrNull.current,
}));

import {
  checkAndIncrSponsorRate,
  checkAndIncrSponsorDailyLamports,
  releaseSponsorDailyLamports,
} from '../../core/solana-sponsor-cap.js';

const logger = { warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  mockClient.incr.mockReset();
  mockClient.incrby.mockReset();
  mockClient.decrby.mockReset();
  mockClient.expire.mockReset();
  mockClient.expire.mockImplementation(async () => 1);
  logger.warn.mockReset();
  logger.debug.mockReset();
  h.clientOrNull.current = mockClient;
});

afterEach(() => vi.clearAllMocks());

describe('checkAndIncrSponsorRate (T15 — rate-limit fail-closed)', () => {
  it('T15a: under the max → ok', async () => {
    mockClient.incr.mockResolvedValue(1);
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incr).toHaveBeenCalledTimes(1);
  });

  it('T15b: exceeding the max → rate_exceeded reject', async () => {
    mockClient.incr.mockResolvedValue(21);
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_exceeded');
  });

  it('★ T15c: Redis throws → FAIL-CLOSED (reject, not fail-open)', async () => {
    mockClient.incr.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('★ T15d: no Redis client (null) → FAIL-CLOSED (reject)', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('sets TTL only on the first increment (count === 1)', async () => {
    mockClient.incr.mockResolvedValue(1);
    await checkAndIncrSponsorRate(20, 60, logger, 'caller1');
    expect(mockClient.expire).toHaveBeenCalledTimes(1);
  });
});

describe('checkAndIncrSponsorDailyLamports (T16 — daily lamports fail-closed)', () => {
  it('T16a: accumulated <= cap → ok', async () => {
    mockClient.incrby.mockResolvedValue(30_000);
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incrby).toHaveBeenCalledWith(expect.any(String), '5000');
  });

  it('★ T16b: accumulated > cap → daily_exceeded reject', async () => {
    mockClient.incrby.mockResolvedValue(500_000_001);
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('daily_exceeded');
  });

  it('★ T16c: Redis throws → FAIL-CLOSED (reject)', async () => {
    mockClient.incrby.mockRejectedValue(new Error('redis down'));
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('★ T16d: no Redis client (null) → FAIL-CLOSED (reject)', async () => {
    h.clientOrNull.current = null;
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store_error_failclosed');
  });

  it('cap <= 0 disables the ceiling (ok without touching Redis)', async () => {
    const r = await checkAndIncrSponsorDailyLamports(5_000n, 0n, logger, 'caller1');
    expect(r.ok).toBe(true);
    expect(mockClient.incrby).not.toHaveBeenCalled();
  });

  it('BigInt comparison is precise for large accumulations (WKH-196 lesson)', async () => {
    // 500000000 exactly equals cap → allowed (not > cap).
    mockClient.incrby.mockResolvedValue(500_000_000);
    const r = await checkAndIncrSponsorDailyLamports(1_000n, 500_000_000n, logger, 'caller1');
    expect(r.ok).toBe(true);
  });
});

describe('releaseSponsorDailyLamports (AR-MNR-1 — compensating decrement)', () => {
  it('decrements the same daily counter by the reserved fee', async () => {
    mockClient.decrby.mockResolvedValue(0);
    await releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1');
    expect(mockClient.decrby).toHaveBeenCalledWith(expect.stringContaining('caller1'), '5000');
  });

  it('cap <= 0 (ceiling disabled) → no-op, never touches Redis', async () => {
    await releaseSponsorDailyLamports(5_000n, 0n, logger, 'caller1');
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });

  it('non-positive fee → no-op', async () => {
    await releaseSponsorDailyLamports(0n, 500_000_000n, logger, 'caller1');
    expect(mockClient.decrby).not.toHaveBeenCalled();
  });

  it('best-effort: Redis error is swallowed (does not throw)', async () => {
    mockClient.decrby.mockRejectedValue(new Error('redis down'));
    await expect(
      releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1'),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('best-effort: null client → no-op (does not throw)', async () => {
    h.clientOrNull.current = null;
    await expect(
      releaseSponsorDailyLamports(5_000n, 500_000_000n, logger, 'caller1'),
    ).resolves.toBeUndefined();
  });
});

describe('HU 071 · W0-P8 — que ve, exactamente, el contador diario', () => {
  /*
   * La premisa: el contador diario incrementa SOLO por `feeLamports`, y lo unico que le llega
   * desde la ruta es el `feeUpperBound` (routes/solana-sponsor.ts, callback `onFeeEstimated`). Si
   * el alquiler que la HU 071 va a adelantar entrara por otro lado, el contador quedaria ciego a
   * el. Este `it` no opina sobre eso: MIDE el termino y la clave, ejecutandolos.
   *
   * Lo que NO prueba: que nadie mas incremente esa clave. Eso vive en la ruta, y su mutante
   * (M-P8) no tiene guard: ver el reporte de W0.
   */
  it('W0-P8: el contador diario incrementa EXACTAMENTE por feeLamports, y el release devuelve el MISMO termino', async () => {
    const fee = 4_321n;
    const cap = 1_000_000n;

    // 1. El incremento es el termino EXACTO, ni un lamport mas.
    mockClient.incrby.mockResolvedValue(Number(fee));
    const r = await checkAndIncrSponsorDailyLamports(fee, cap, logger, 'keyW0P8');
    expect(r.ok).toBe(true);
    expect(mockClient.incrby).toHaveBeenCalledTimes(1);
    const llamadaIncr = mockClient.incrby.mock.calls[0];
    expect(llamadaIncr?.[1], 'el incremento es feeLamports, textual').toBe(fee.toString());

    // 2. El release decrementa el MISMO termino sobre la MISMA clave. El docblock de
    // `releaseSponsorDailyLamports` dice que la derivacion de la clave la espeja EXACTAMENTE;
    // esto lo ejecuta en vez de citarlo.
    await releaseSponsorDailyLamports(fee, cap, logger, 'keyW0P8');
    expect(mockClient.decrby).toHaveBeenCalledTimes(1);
    const llamadaDecr = mockClient.decrby.mock.calls[0];
    expect(llamadaDecr?.[1], 'el decremento es el mismo termino').toBe(fee.toString());
    expect(llamadaDecr?.[0], 'y sobre la MISMA clave').toBe(llamadaIncr?.[0]);

    // 3. CONTROL POSITIVO: con fee = 0 el incremento es '0' y el release es no-op; y con el techo
    // desactivado ninguna de las dos toca Redis. Sin esto, un mock que registrara cualquier cosa
    // pasaria los pasos 1 y 2.
    mockClient.incrby.mockReset();
    mockClient.decrby.mockReset();
    mockClient.incrby.mockResolvedValue(0);
    await checkAndIncrSponsorDailyLamports(0n, cap, logger, 'keyW0P8');
    expect(mockClient.incrby.mock.calls[0]?.[1], 'fee 0 incrementa en 0').toBe('0');
    await releaseSponsorDailyLamports(0n, cap, logger, 'keyW0P8');
    expect(mockClient.decrby, 'fee 0 no decrementa nada').not.toHaveBeenCalled();

    mockClient.incrby.mockReset();
    await checkAndIncrSponsorDailyLamports(fee, 0n, logger, 'keyW0P8');
    expect(mockClient.incrby, 'con el techo desactivado no se toca Redis').not.toHaveBeenCalled();
    await releaseSponsorDailyLamports(fee, 0n, logger, 'keyW0P8');
    expect(mockClient.decrby, 'ni el release').not.toHaveBeenCalled();
  });
});
