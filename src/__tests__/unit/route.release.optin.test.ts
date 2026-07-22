/**
 * WKH-216 / HU-SOL-13 — Wave 13c: opt-in-off registration (TF8, CD-2/CD-5).
 *
 * Without a parseable `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` + the flag on,
 * `POST /solana/escrow/release` is NOT registered → 404, and the EVM/testnet boot
 * is byte-identical (/health still 200, /settle path untouched). This is the same
 * opt-in-off contract as the HU-SOL-14 sponsor route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@solana/web3.js';

const saved: { enabled?: string; key?: string; attest?: string } = {};

function clearReleaseEnv(): void {
  saved.enabled = process.env.SOLANA_ESCROW_RELEASE_ENABLED;
  saved.key = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  saved.attest = process.env.SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET;
  delete process.env.SOLANA_ESCROW_RELEASE_ENABLED;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY;
  delete process.env.SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET;
}
function restoreReleaseEnv(): void {
  restore('SOLANA_ESCROW_RELEASE_ENABLED', saved.enabled);
  restore('SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY', saved.key);
  restore('SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET', saved.attest);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    // eslint-disable-next-line security/detect-object-injection -- fixed env name from a literal call site, not user input.
    delete process.env[name];
  } else {
    // eslint-disable-next-line security/detect-object-injection -- fixed env name from a literal call site, not user input.
    process.env[name] = value;
  }
}

async function buildFreshApp(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetReleaseAuthorityForTesting } =
    await import('../../infra/solana-release-authority.js');
  resetRedisClientForTests();
  resetReleaseAuthorityForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ skipDomainCheck: true });
}

async function postRelease(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/solana/escrow/release',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ remittanceId: 'r', sender: 's', attestation: 'a' }),
  });
}

describe('POST /solana/escrow/release — opt-in-off (TF8)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(clearReleaseEnv);
  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreReleaseEnv();
  });

  it('TF8: no release-authority key configured → route NOT registered → 404', async () => {
    app = await buildFreshApp();
    const res = await postRelease(app);
    expect(res.statusCode).toBe(404);
  });

  it('TF8: flag on but key absent → still opt-in-off → 404', async () => {
    process.env.SOLANA_ESCROW_RELEASE_ENABLED = 'true';
    app = await buildFreshApp();
    const res = await postRelease(app);
    expect(res.statusCode).toBe(404);
  });

  it('TF8: key present but flag off → still opt-in-off → 404', async () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = JSON.stringify(
      Array.from(Keypair.generate().secretKey),
    );
    app = await buildFreshApp();
    const res = await postRelease(app);
    expect(res.statusCode).toBe(404);
  });

  it('TF8: EVM boot byte-identical — /health still 200 with release off', async () => {
    app = await buildFreshApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
