/**
 * Contract test (PROVIDER side) — WKH-227 / HU-SOL-24, Wave W2 (AC-1).
 *
 * Congela el body `/settle` EIP-3009 canónico contra los schemas REALES
 * (`VerifyRequestSchema` / `SettleRequestSchema`, todos `.strict()`):
 *   - Bloque A: el body canónico VALIDA (accept).
 *   - Bloque B: un campo extra o renombrado en un objeto `.strict()` ROMPE la
 *     validación → el drift del contrato se detecta en rojo.
 *
 * El fixture es el MISMO objeto que chaski (consumer, W3) captura de
 * `broadcastSettle()` y compara byte-a-byte — punto de encuentro cross-repo.
 */

import { describe, it, expect } from 'vitest';
import { VerifyRequestSchema, SettleRequestSchema } from '../core/schemas.js';
import { settleEip3009Body } from './settle-eip3009.body.fixture.js';

describe('WKH-227 AC-1 · contract test provider /settle (EIP-3009)', () => {
  // ─── Bloque A — accept ────────────────────────────────────────────────────
  it('acepta el body EIP-3009 canónico (VerifyRequestSchema)', () => {
    expect(() => VerifyRequestSchema.parse(settleEip3009Body)).not.toThrow();
    expect(VerifyRequestSchema.safeParse(settleEip3009Body).success).toBe(true);
  });

  it('acepta el body EIP-3009 canónico (SettleRequestSchema, alias)', () => {
    expect(SettleRequestSchema.safeParse(settleEip3009Body).success).toBe(true);
  });

  // ─── Bloque B — reject (drift) ────────────────────────────────────────────
  it('rechaza un campo EXTRA en accepted (.strict caza el drift)', () => {
    const withExtra = {
      ...settleEip3009Body,
      accepted: { ...settleEip3009Body.accepted, foo: 'bar' },
    };
    expect(VerifyRequestSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rechaza un campo RENOMBRADO en accepted (falta el requerido, sobra el nuevo)', () => {
    const { amount, ...restAccepted } = settleEip3009Body.accepted;
    const renamed = {
      ...settleEip3009Body,
      accepted: { ...restAccepted, amount2: amount },
    };
    expect(VerifyRequestSchema.safeParse(renamed).success).toBe(false);
  });

  it('rechaza x402Version distinto de 2 (z.literal(2) — CD-8)', () => {
    const wrongVersion = { ...settleEip3009Body, x402Version: 3 };
    expect(VerifyRequestSchema.safeParse(wrongVersion).success).toBe(false);
  });
});
