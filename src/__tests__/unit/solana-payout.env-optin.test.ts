/**
 * WKH-302 — opt-in-off + EVM byte-identical boot (T-ENV-1, T-ENV-2, T-AC6).
 *
 * T-ENV-1: with every SOLANA_PAYOUT_* unset, the route is NOT registered →
 *          POST /solana/payout → 404, and the rest of the app is untouched.
 * T-ENV-2: SOLANA_PAYOUT_ENABLED='false' (the STRING) enables nothing — the
 *          proof that the flag is an enum-transform and not `z.coerce.boolean()`,
 *          which reads 'false' as truthy.
 * T-AC6:   the money-path (EVM) routes are present and behave the same whether the
 *          payout feature is off or on; enabling a treasury route must not add,
 *          remove or shadow a single x402 route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@solana/web3.js';

const PAYOUT_ENVS = [
  'SOLANA_PAYOUT_ENABLED',
  'SOLANA_PAYOUT_OPERATOR_SECRET_KEY',
  'SOLANA_PAYOUT_MAX_AMOUNT_ATOMIC',
  'SOLANA_PAYOUT_DAILY_MAX_ATOMIC',
  'SOLANA_PAYOUT_MIN_SOL_LAMPORTS',
  'SOLANA_PAYOUT_RATE_LIMIT_MAX',
  'SOLANA_PAYOUT_RATE_LIMIT_WINDOW_SEC',
  'SOLANA_PAYOUT_LEASE_MS',
  'SOLANA_RPC_URL',
  'SOLANA_USDC_MINT',
  'SOLANA_FEE_PAYER_PRIVATE_KEY',
  'SOLANA_FEE_PAYER_SPONSOR_ENABLED',
  'SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY',
] as const;

const saved = new Map<string, string | undefined>();

function clearPayoutEnv(): void {
  const env = new Map(Object.entries(process.env));
  for (const k of PAYOUT_ENVS) {
    saved.set(k, env.get(k));
    delete process.env[k as keyof NodeJS.ProcessEnv];
  }
}

function restoreEnv(): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k as keyof NodeJS.ProcessEnv];
    else process.env[k as keyof NodeJS.ProcessEnv] = v;
  }
  saved.clear();
}

async function buildFreshApp(): Promise<FastifyInstance> {
  const { resetRedisClientForTests } = await import('../../infra/redis.js');
  const { resetPayoutOperatorForTesting } = await import('../../infra/solana-payout-operator.js');
  const { resetFeePayerForTesting } = await import('../../infra/solana-fee-payer.js');
  const { resetReleaseAuthorityForTesting } =
    await import('../../infra/solana-release-authority.js');
  resetRedisClientForTests();
  resetPayoutOperatorForTesting();
  resetFeePayerForTesting();
  resetReleaseAuthorityForTesting();
  const { buildApp } = await import('../../app.js');
  return buildApp({ skipDomainCheck: true });
}

const validKey = (): string => JSON.stringify(Array.from(Keypair.generate().secretKey));

const hit = (app: FastifyInstance) =>
  app.inject({
    method: 'POST',
    url: '/solana/payout',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({}),
  });

describe('T-ENV-1 / T-ENV-2 — payout is opt-in and OFF', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => clearPayoutEnv());

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreEnv();
  });

  it('★ T-ENV-1: every SOLANA_PAYOUT_* unset → POST /solana/payout is 404', async () => {
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it('T-ENV-1: with the feature off, health and supported are unaffected', async () => {
    app = await buildFreshApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/supported' })).statusCode).toBe(200);
  });

  it("★ T-ENV-2: SOLANA_PAYOUT_ENABLED='false' (string) enables NOTHING", async () => {
    process.env.SOLANA_PAYOUT_ENABLED = 'false';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = validKey();
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    process.env.SOLANA_USDC_MINT = Keypair.generate().publicKey.toBase58();
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it("★ T-ENV-2b: other truthy strings ('1','TRUE') REFUSE the boot, never enable", async () => {
    // The flag is an enum-transform, so an unrecognised value is a hard config
    // error: env validation exits the process rather than starting with the
    // treasury route in an undefined state. Either way it is NEVER enabled —
    // which is the property that `z.coerce.boolean()` would have broken.
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = validKey();
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    const { isSolanaPayoutEnabled, resetPayoutOperatorForTesting } =
      await import('../../infra/solana-payout-operator.js');
    for (const v of ['1', 'TRUE', 'yes', '']) {
      process.env.SOLANA_PAYOUT_ENABLED = v;
      resetPayoutOperatorForTesting();
      expect(isSolanaPayoutEnabled()).toBe(false);
      await expect(buildFreshApp()).rejects.toThrow();
    }
  });

  it('flag=true but NO key → still 404 (opt-in needs both)', async () => {
    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it('★ malformed key + flag=true → 404, and the boot does NOT throw', async () => {
    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = 'not-a-json-byte-array';
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it('★ AC-11: key == the fee-payer key → 404 (a misconfig disables, never merges)', async () => {
    const shared = validKey();
    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = shared;
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = shared;
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it('★ AC-11: key == the release-authority key → 404', async () => {
    const shared = validKey();
    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = shared;
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = shared;
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    app = await buildFreshApp();
    expect((await hit(app)).statusCode).toBe(404);
  });

  it('★ the positive control: distinct keys + flag=true → the route EXISTS', async () => {
    // Without this, every 404 above would also pass if the route simply never
    // registered for an unrelated reason. Disarming the scenario must turn it green.
    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = validKey();
    process.env.SOLANA_FEE_PAYER_PRIVATE_KEY = validKey();
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = validKey();
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    process.env.SOLANA_USDC_MINT = Keypair.generate().publicKey.toBase58();
    app = await buildFreshApp();
    const res = await hit(app);
    expect(res.statusCode).not.toBe(404);
  });
});

describe('T-AC6 — the EVM money path is untouched by this feature', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => clearPayoutEnv());

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    restoreEnv();
  });

  /** Probe the x402 routes and return a comparable fingerprint. */
  async function evmFingerprint(a: FastifyInstance): Promise<Record<string, number>> {
    const settle = await a.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    const verify = await a.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    const supported = await a.inject({ method: 'GET', url: '/supported' });
    const health = await a.inject({ method: 'GET', url: '/health' });
    return {
      settle: settle.statusCode,
      verify: verify.statusCode,
      supported: supported.statusCode,
      health: health.statusCode,
    };
  }

  it('★ the x402 routes answer identically with payout OFF and with payout ON', async () => {
    app = await buildFreshApp();
    const off = await evmFingerprint(app);
    await app.close();

    process.env.SOLANA_PAYOUT_ENABLED = 'true';
    process.env.SOLANA_PAYOUT_OPERATOR_SECRET_KEY = validKey();
    process.env.SOLANA_RPC_URL = 'http://mock-rpc';
    process.env.SOLANA_USDC_MINT = Keypair.generate().publicKey.toBase58();
    app = await buildFreshApp();
    const on = await evmFingerprint(app);

    expect(on).toEqual(off);
    // And the payout route only exists in the second app.
    expect((await hit(app)).statusCode).not.toBe(404);
  });

  it('★ no PAYOUT_* code leaked into the shared x402 error catalogue', async () => {
    const errors = await import('../../core/errors.js');
    const codes = Object.keys(errors.HTTP_BY_CODE);
    expect(codes.filter((c) => c.startsWith('PAYOUT_'))).toEqual([]);
    // Control: prove we really read the catalogue. Without this, the assertion
    // above would also pass against an empty object.
    expect(codes).toContain('INVALID_SIGNATURE');
  });
});
