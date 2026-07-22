/**
 * WKH-217 / HU-SOL-14 — opt-in-off + EVM byte-identical (T20-T21, AC-9/CD-13).
 *
 * T20: without SOLANA_FEE_PAYER_SPONSOR_ENABLED / SOLANA_FEE_PAYER_PRIVATE_KEY,
 *      the sponsorship route is NOT registered → POST /solana/sponsor → 404.
 * T21: with sponsorship OFF, the rest of the app (health/supported) behaves
 *      normally; enabling sponsorship adds the route WITHOUT touching any EVM
 *      route. The full EVM suite running byte-identically is verified by
 *      `npm run qa` (all pre-existing suites unchanged); this file asserts the
 *      registration boundary that makes that guarantee hold.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@solana/web3.js';

interface SavedEnv {
  enabled?: string;
  key?: string;
  rpc?: string;
  mint?: string;
}
const saved: SavedEnv = {};

async function buildFreshApp(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  resetRedisClientForTests();
  resetFeePayerForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ skipDomainCheck: true });
}

function clearSponsorEnv(): void {
  saved.enabled = process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  saved.key = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  saved.rpc = process.env.SOLANA_RPC_URL;
  saved.mint = process.env.SOLANA_USDC_MINT;
  delete process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_USDC_MINT;
}

function restoreSponsorEnv(): void {
  if (saved.enabled === undefined) delete process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  else process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = saved.enabled;
  if (saved.key === undefined) delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  else process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = saved.key;
  if (saved.rpc === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = saved.rpc;
  if (saved.mint === undefined) delete process.env.SOLANA_USDC_MINT;
  else process.env.SOLANA_USDC_MINT = saved.mint;
}

describe('sponsorship opt-in-off (T20/T21)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    clearSponsorEnv();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreSponsorEnv();
  });

  // ── T20 — off by default ────────────────────────────────────────────────────
  it('T20a: no flag/key → POST /solana/sponsor → 404 (route not registered)', async () => {
    app = await buildFreshApp();
    const res = await app.inject({ method: 'POST', url: '/solana/sponsor', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('T20b: flag=true but NO key → still 404 (opt-in requires both)', async () => {
    process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'true';
    app = await buildFreshApp();
    const res = await app.inject({ method: 'POST', url: '/solana/sponsor', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('T20c: key present but flag=false → still 404', async () => {
    process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'false';
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = JSON.stringify(
      Array.from(Keypair.generate().secretKey),
    );
    app = await buildFreshApp();
    const res = await app.inject({ method: 'POST', url: '/solana/sponsor', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('T20d: malformed key + flag=true → 404 (isSponsorEnabled fails closed)', async () => {
    process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'true';
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = 'not-a-json-byte-array';
    app = await buildFreshApp();
    const res = await app.inject({ method: 'POST', url: '/solana/sponsor', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  // ── T20 positive — enabled → route present (not 404) ────────────────────────
  it('T20e: flag=true + valid key → route registered (not 404; 400 on empty body)', async () => {
    process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'true';
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = JSON.stringify(
      Array.from(Keypair.generate().secretKey),
    );
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    app = await buildFreshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(400); // Zod rejects the empty body
  });

  // ── T21 — EVM/other routes byte-identical with sponsorship off ──────────────
  it('T21: with sponsorship OFF, health + supported still respond normally', async () => {
    app = await buildFreshApp();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const supported = await app.inject({ method: 'GET', url: '/supported' });
    expect(supported.statusCode).toBe(200);
    // And the sponsor route is absent (does not shadow/alter existing routes).
    const sponsor = await app.inject({ method: 'POST', url: '/solana/sponsor', payload: {} });
    expect(sponsor.statusCode).toBe(404);
  });
});
