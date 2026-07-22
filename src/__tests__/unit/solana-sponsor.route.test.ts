/**
 * WKH-217 / HU-SOL-14 — POST /solana/sponsor route (T17-T19).
 *
 * The route is exercised via `app.inject()` (no live port). The broadcast
 * primitive and the anti-abuse caps are mocked (CD-10/CD-14: `vi.mock` +
 * hoisted state) so no network/Redis is touched; PoP is REAL. The fee-payer key
 * + opt-in flag are set on `process.env` (the source `isSponsorEnabled()` and
 * `getFeePayerKeypair()` read directly), then restored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@solana/web3.js';
import type * as SponsorBroadcastModule from '../../methods/solana-sponsor/broadcast.js';
import { computeSponsorPop } from '../../methods/solana-sponsor/pop.js';

const h = vi.hoisted(() => ({
  cosignResult: {
    current: { ok: true, signature: 'SIGabc123' } as
      | { ok: true; signature: string }
      | { ok: false; code: string; reason: string },
  },
  cosignSpy: vi.fn(),
  rateResult: { current: { ok: true } as { ok: boolean; reason?: string } },
  dailyResult: { current: { ok: true } as { ok: boolean; reason?: string } },
}));

vi.mock('../../methods/solana-sponsor/broadcast.js', async (importActual) => {
  const actual = await importActual<typeof SponsorBroadcastModule>();
  return {
    ...actual,
    cosignAndBroadcast: (...args: unknown[]) => {
      h.cosignSpy(...args);
      return Promise.resolve(h.cosignResult.current);
    },
  };
});

vi.mock('../../core/solana-sponsor-cap.js', () => ({
  checkAndIncrSponsorRate: () => Promise.resolve(h.rateResult.current),
  checkAndIncrSponsorDailyLamports: () => Promise.resolve(h.dailyResult.current),
  releaseSponsorDailyLamports: () => Promise.resolve(),
}));

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

const feePayerKp = Keypair.generate();
const KEY_JSON = JSON.stringify(Array.from(feePayerKp.secretKey));
const POP_SECRET = 'test-pop-secret';
const SENDER = Keypair.generate().publicKey.toBase58();

interface SavedEnv {
  enabled?: string;
  key?: string;
  rpc?: string;
  mint?: string;
  pop?: string;
}
const savedEnv: SavedEnv = {};

function applySponsorEnv(): void {
  savedEnv.enabled = process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  savedEnv.key = process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  savedEnv.rpc = process.env.SOLANA_RPC_URL;
  savedEnv.mint = process.env.SOLANA_USDC_MINT;
  savedEnv.pop = process.env.SOLANA_SPONSOR_POP_SECRET;
  process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = 'true';
  process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = KEY_JSON;
  process.env.SOLANA_RPC_URL = 'http://mock-rpc';
  process.env.SOLANA_USDC_MINT = 'So11111111111111111111111111111111111111112';
  process.env.SOLANA_SPONSOR_POP_SECRET = POP_SECRET;
}

function restoreSponsorEnv(): void {
  if (savedEnv.enabled === undefined) delete process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED;
  else process.env.SOLANA_FEE_PAYER_SPONSOR_ENABLED = savedEnv.enabled;
  if (savedEnv.key === undefined) delete process.env.SOLANA_FEE_PAYER_PRIVATE_KEY;
  else process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = savedEnv.key;
  if (savedEnv.rpc === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = savedEnv.rpc;
  if (savedEnv.mint === undefined) delete process.env.SOLANA_USDC_MINT;
  else process.env.SOLANA_USDC_MINT = savedEnv.mint;
  if (savedEnv.pop === undefined) delete process.env.SOLANA_SPONSOR_POP_SECRET;
  else process.env.SOLANA_SPONSOR_POP_SECRET = savedEnv.pop;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    partialSignedTx: Buffer.from('deadbeef').toString('base64'),
    reference: Keypair.generate().publicKey.toBase58(),
    sender: SENDER,
    popProof: computeSponsorPop(SENDER, POP_SECRET),
    ...overrides,
  };
}

async function buildSponsorApp(capture?: CaptureStream): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  resetRedisClientForTests();
  resetFeePayerForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ loggerDestination: capture, skipDomainCheck: true });
}

describe('POST /solana/sponsor', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    applySponsorEnv();
    h.cosignResult.current = { ok: true, signature: 'SIGabc123' };
    h.cosignSpy.mockReset();
    h.rateResult.current = { ok: true };
    h.dailyResult.current = { ok: true };
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreSponsorEnv();
    vi.clearAllMocks();
  });

  // ── T18 — happy e2e (mocked) ────────────────────────────────────────────────
  it('T18: valid PoP + CR-1/broadcast mock → 200 { signature }', async () => {
    app = await buildSponsorApp();
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody()),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { signature: string };
    expect(body.signature).toBe('SIGabc123');
    expect(h.cosignSpy).toHaveBeenCalledTimes(1);
  });

  // ── T17 — PoP invalid/absent → 403 BEFORE CR-1 (AC-7) ───────────────────────
  it('T17a: missing popProof → 400 INVALID_PAYLOAD, CR-1 not invoked', async () => {
    app = await buildSponsorApp();
    const body = validBody();
    delete (body as Record<string, unknown>).popProof;
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(400);
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('★ T17b: wrong HMAC popProof → 403 SPONSOR_POP_INVALID, CR-1 not invoked', async () => {
    app = await buildSponsorApp();
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody({ popProof: 'deadbeef'.repeat(8) })),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('SPONSOR_POP_INVALID');
    expect(h.cosignSpy).not.toHaveBeenCalled();
  });

  it('maps SPONSOR_REJECTED → 422', async () => {
    h.cosignResult.current = { ok: false, code: 'SPONSOR_REJECTED', reason: 'BAD_DISCRIMINATOR' };
    app = await buildSponsorApp();
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody()),
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('SPONSOR_REJECTED');
  });

  it('maps SPONSOR_BROADCAST_EXPIRED → 409 and rate store fail-closed → 429', async () => {
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_BROADCAST_EXPIRED',
      reason: 'STALE_BLOCKHASH',
    };
    app = await buildSponsorApp();
    const expired = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody()),
    });
    expect(expired.statusCode).toBe(409);

    h.rateResult.current = { ok: false, reason: 'store_error_failclosed' };
    const limited = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody()),
    });
    expect(limited.statusCode).toBe(429);
  });

  // ── T19 — privkey never in logs/errors (AC-10) ──────────────────────────────
  it('★ T19: forced error → private key never appears in logs nor error body', async () => {
    const cap = new CaptureStream();
    h.cosignResult.current = {
      ok: false,
      code: 'SPONSOR_BROADCAST_FAILED',
      reason: 'UNCONFIRMED',
    };
    app = await buildSponsorApp(cap);
    const res = await app.inject({
      method: 'POST',
      url: '/solana/sponsor',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBody()),
    });
    expect(res.statusCode).toBe(502);
    // The 64-byte secret key JSON must NEVER appear in logs nor the response.
    expect(cap.text()).not.toContain(KEY_JSON);
    expect(res.body).not.toContain(KEY_JSON);
    // A couple of raw secret bytes as a sanity substring check.
    const secretHead = Array.from(feePayerKp.secretKey.slice(0, 8)).join(',');
    expect(cap.text()).not.toContain(secretHead);
  });
});
