import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnv } from '../../infra/env.js';

describe('parseEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults PORT to 3002 when PORT is missing', () => {
    const result = parseEnv({});
    expect(result.PORT).toBe(3002);
  });

  it('respects PORT from env var', () => {
    const result = parseEnv({ PORT: '4001' });
    expect(result.PORT).toBe(4001);
  });

  it('exits with code 1 on invalid NODE_ENV', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow('__exit__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const firstCall = stderrSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall?.[0])).toContain('NODE_ENV');
  });

  it('exits with code 1 on PORT out of range', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => parseEnv({ PORT: '99999' })).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
