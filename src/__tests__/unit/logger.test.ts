import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EnvConfig } from '../../infra/env.js';

// Mock pino default export so we can spy on the factory invocation.
// The mock factory is hoisted; it must not close over external state.
vi.mock('pino', () => {
  const factory = vi.fn(() => ({
    level: 'info',
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
  }));
  return { default: factory };
});

interface PinoFactoryOptions {
  level?: string;
  transport?: { target?: string };
}

describe('createLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('in development uses pino-pretty transport', async () => {
    const pinoModule = await import('pino');
    const pinoFactory = vi.mocked(pinoModule.default);
    const { createLogger } = await import('../../infra/logger.js');

    // Deliberately partial (repo idiom, cf. logger.redact.test.ts): createLogger
    // reads only NODE_ENV + LOG_LEVEL. The cast is what lets a 4-field object
    // stand in for EnvConfig.
    const env: EnvConfig = {
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 3002,
      SHUTDOWN_GRACE_MS: 10000,
    } as EnvConfig;

    createLogger(env);

    expect(pinoFactory).toHaveBeenCalledTimes(1);
    const opts = pinoFactory.mock.calls[0]?.[0] as PinoFactoryOptions;
    expect(opts.transport?.target).toBe('pino-pretty');
  });

  it('in production returns JSON logger without transport', async () => {
    const pinoModule = await import('pino');
    const pinoFactory = vi.mocked(pinoModule.default);
    const { createLogger } = await import('../../infra/logger.js');

    // Deliberately partial (repo idiom, cf. logger.redact.test.ts): createLogger
    // reads only NODE_ENV + LOG_LEVEL. The cast is what lets a 4-field object
    // stand in for EnvConfig.
    const env: EnvConfig = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      PORT: 3002,
      SHUTDOWN_GRACE_MS: 10000,
    } as EnvConfig;

    createLogger(env);

    expect(pinoFactory).toHaveBeenCalledTimes(1);
    const opts = pinoFactory.mock.calls[0]?.[0] as PinoFactoryOptions;
    expect(opts.transport).toBeUndefined();
  });

  it('respects LOG_LEVEL env var', async () => {
    const pinoModule = await import('pino');
    const pinoFactory = vi.mocked(pinoModule.default);
    const { createLogger } = await import('../../infra/logger.js');

    // Deliberately partial (repo idiom, cf. logger.redact.test.ts): createLogger
    // reads only NODE_ENV + LOG_LEVEL. The cast is what lets a 4-field object
    // stand in for EnvConfig.
    const env: EnvConfig = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: 3002,
      SHUTDOWN_GRACE_MS: 10000,
    } as EnvConfig;

    createLogger(env);

    const opts = pinoFactory.mock.calls[0]?.[0] as PinoFactoryOptions;
    expect(opts.level).toBe('warn');
  });
});
