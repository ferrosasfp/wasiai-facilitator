/**
 * Multi-key caller auth tests (AUDIT — key versioning / rotation, additive).
 *
 * Verifies the ADDITIVE multi-key behavior of `requireFacilitatorKey`:
 *   - The legacy single FACILITATOR_API_KEY still authenticates.
 *   - Any key in FACILITATOR_API_KEYS (comma-separated) also authenticates.
 *   - Both work simultaneously (rotation grace period).
 *   - Wrong / missing keys still 401.
 *   - `resolveConfiguredKeys` parsing (trim, empty-filter, de-dup).
 *
 * Unit-level: exercises `resolveConfiguredKeys` directly + the preHandler via a
 * minimal Fastify app (no chain adapters / Redis needed — auth runs before the
 * route body).
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { requireFacilitatorKey, resolveConfiguredKeys } from '../../middleware/auth.js';

function appWith(env: Partial<EnvConfig>): FastifyInstance {
  const app = Fastify();
  app.decorate('env', {
    FACILITATOR_API_KEY: undefined,
    FACILITATOR_API_KEYS: undefined,
    ...env,
  } as EnvConfig);
  app.post('/settle', { preHandler: requireFacilitatorKey }, async (req) => ({
    ok: true,
    keyId: req.facilitatorKeyId ?? null,
  }));
  return app;
}

async function inject(app: FastifyInstance, bearer?: string) {
  return app.inject({
    method: 'POST',
    url: '/settle',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: '{}',
  });
}

describe('resolveConfiguredKeys', () => {
  it('returns single key only', () => {
    expect(resolveConfiguredKeys('k1', undefined)).toEqual(['k1']);
  });
  it('merges single + CSV, trims, filters empties, de-dups', () => {
    expect(resolveConfiguredKeys('k1', ' k2 , ,k3,k1 ')).toEqual(['k1', 'k2', 'k3']);
  });
  it('returns CSV-only when single is undefined', () => {
    expect(resolveConfiguredKeys(undefined, 'a,b')).toEqual(['a', 'b']);
  });
  it('returns empty when nothing configured (test bypass)', () => {
    expect(resolveConfiguredKeys(undefined, undefined)).toEqual([]);
    expect(resolveConfiguredKeys('', '')).toEqual([]);
  });
});

describe('requireFacilitatorKey — multi-key (additive)', () => {
  it('legacy single key still authenticates', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'legacy-key' });
    const res = await inject(app, 'legacy-key');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('a key from FACILITATOR_API_KEYS authenticates', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'old-key', FACILITATOR_API_KEYS: 'new-key-1,new-key-2' });
    const res = await inject(app, 'new-key-2');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('both the single key AND a rotated key work simultaneously (grace period)', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'old-key', FACILITATOR_API_KEYS: 'new-key' });
    const a = await inject(app, 'old-key');
    const b = await inject(app, 'new-key');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    await app.close();
  });

  it('wrong key → 401', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'k', FACILITATOR_API_KEYS: 'k2' });
    const res = await inject(app, 'nope');
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('missing header → 401', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'k' });
    const res = await inject(app);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('no key configured (test bypass) → request proceeds, no keyId', async () => {
    const app = appWith({});
    const res = await inject(app);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).keyId).toBeNull();
    await app.close();
  });

  it('distinct matched keys yield distinct non-secret keyIds; the raw key is never echoed', async () => {
    const app = appWith({ FACILITATOR_API_KEY: 'key-A', FACILITATOR_API_KEYS: 'key-B' });
    const a = await inject(app, 'key-A');
    const b = await inject(app, 'key-B');
    const idA = JSON.parse(a.body).keyId as string;
    const idB = JSON.parse(b.body).keyId as string;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
    // keyId is a sha256 prefix, NOT the raw key.
    expect(idA).not.toContain('key-A');
    expect(idB).not.toContain('key-B');
    await app.close();
  });
});
