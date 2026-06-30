/**
 * P2 — OP-11: free-text hex-secret scrubber in pino redaction.
 *
 * `redact.paths` masks STRUCTURED fields only. A 0x+64hex secret (private key,
 * EIP-712 signature half, 32-byte nonce) that leaks into a FREE-TEXT message
 * string — e.g. a viem/RPC error whose `.message` embedded it — is NOT covered
 * by path redaction. The `logMethod` hook scrubs such blobs out of the message.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import type { EnvConfig } from '../../infra/env.js';
import { createLogger, scrubHexSecrets } from '../../infra/logger.js';

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

const SECRET_64 = `0x${'ab'.repeat(32)}`; // 0x + 64 hex chars (32 bytes)
const SECRET_64_UPPER = `0x${'AB'.repeat(32)}`;

describe('P2 OP-11 — scrubHexSecrets (pure)', () => {
  it('HX-1: replaces a single 64-hex blob with [Redacted-hex]', () => {
    const out = scrubHexSecrets(`leaked key ${SECRET_64} here`);
    expect(out).not.toContain(SECRET_64);
    expect(out).toContain('[Redacted-hex]');
  });

  it('HX-2: replaces MULTIPLE blobs and is case-insensitive', () => {
    const out = scrubHexSecrets(`${SECRET_64} and ${SECRET_64_UPPER}`);
    expect(out).not.toContain(SECRET_64);
    expect(out).not.toContain(SECRET_64_UPPER);
    expect(out.match(/\[Redacted-hex\]/g)).toHaveLength(2);
  });

  it('HX-3: leaves short hex (e.g. a tx-hash fragment) and non-hex text intact', () => {
    // 8-hex is NOT 64-hex → untouched.
    expect(scrubHexSecrets('0xPUBLIC_TX path=eip155:2368')).toBe('0xPUBLIC_TX path=eip155:2368');
  });
});

describe('P2 OP-11 — logger scrubs free-text messages', () => {
  it('HX-4: a 64-hex secret inside the free-text msg is scrubbed in output', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    // Simulate a viem error message that embedded an operator key / signature.
    log.error(`settle failed: signature ${SECRET_64} rejected`);
    const out = read();
    expect(out).not.toContain(SECRET_64);
    expect(out).toContain('[Redacted-hex]');
  });

  it('HX-5: secret in an interpolation arg is also scrubbed', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    log.info('detail %s', `key=${SECRET_64}`);
    const out = read();
    expect(out).not.toContain(SECRET_64);
  });

  it('HX-6: a structured PUBLIC field (tx_hash) is NOT mangled by the scrubber', () => {
    // A real tx hash IS 64-hex but lives in a STRUCTURED field we intentionally
    // log. The hook only scrubs free-text STRING args, so the structured value
    // is preserved verbatim (it is on-chain public data, not a secret).
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    const txHash = `0x${'cd'.repeat(32)}`;
    log.info({ tx_hash: txHash, network: 'eip155:2368' }, 'settle ok');
    const out = read();
    expect(out).toContain(txHash);
    expect(out).toContain('settle ok');
  });

  it('HX-7: a plain message with no 0x is passed through unchanged', () => {
    const { sink, read } = capture();
    const log = createLogger(ENV, sink);
    log.info('supported ok');
    expect(read()).toContain('supported ok');
  });
});
