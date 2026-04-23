import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/index.ts'],
      // NOTA: thresholds gate DESHABILITADO temporalmente por DT-D / AC-6 de WFAC-3.
      // Re-evaluar cuando haya base suficiente de tests (ver TD-01-09 en BACKLOG.md).
      // thresholds: {
      //   lines: 80,
      //   functions: 80,
      //   branches: 75,
      //   statements: 80,
      // },
    },
  },
});
