/**
 * Pino redaction integration tests (audit hardening — SECURITY.md "Secret
 * handling"). Unlike logger.test.ts (which mocks pino to assert factory
 * options), this file uses the REAL pino with a capture stream to prove that
 * secret-bearing fields are actually replaced with `[Redacted]` in the
 * serialized output, and that non-secret fields survive.
 *
 * The facilitator holds the operator signing key — a leak via a logged object
 * is a high-impact incident. These tests are the regression guard.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import type { EnvConfig } from '../../infra/env.js';
import { createLogger } from '../../infra/logger.js';

function capture(): { sink: Writable; read: () => string } {
  let buf = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { sink, read: () => buf };
}

const ENV: EnvConfig = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  PORT: 3002,
  SHUTDOWN_GRACE_MS: 10000,
} as EnvConfig;

describe('createLogger — secret redaction', () => {
  it('redacts top-level secret-bearing fields', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    log.info(
      {
        privateKey: '0xPRIVATE_SECRET',
        api_key: 'API_SECRET',
        signature: '0xSIG_SECRET',
        nonce: '0xNONCE_SECRET',
        authorization: 'Bearer BEARER_SECRET',
      },
      'msg',
    );
    const out = read();
    for (const leak of [
      '0xPRIVATE_SECRET',
      'API_SECRET',
      '0xSIG_SECRET',
      '0xNONCE_SECRET',
      'BEARER_SECRET',
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('[Redacted]');
  });

  it('redacts secrets nested one level deep (e.g. under err / headers)', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    log.info(
      {
        err: { OPERATOR_PRIVATE_KEY: '0xNESTED_LEAK', message: 'keep-me' },
        headers: { authorization: 'Bearer NESTED_BEARER', 'content-type': 'application/json' },
      },
      'msg',
    );
    const out = read();
    expect(out).not.toContain('0xNESTED_LEAK');
    expect(out).not.toContain('NESTED_BEARER');
    // Non-secret siblings survive.
    expect(out).toContain('keep-me');
    expect(out).toContain('application/json');
  });

  it('preserves non-secret fields verbatim', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    log.info({ network: 'eip155:2368', tx_hash: '0xPUBLIC_TX', duration_ms: 12 }, 'settle ok');
    const out = read();
    expect(out).toContain('eip155:2368');
    expect(out).toContain('0xPUBLIC_TX');
    expect(out).toContain('settle ok');
  });
});
