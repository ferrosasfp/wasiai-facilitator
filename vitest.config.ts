import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Shared test fixtures — required at module-load for chains/kite.ts.
      // Tests that need DIFFERENT values override them via `process.env.X = ...`
      // before `await import('../app.js')` (see env.test.ts for the pattern).
      // These defaults use the real Kite Testnet PYUSD address so tests that
      // exercise domain separator logic match production.
      KITE_USDC_ADDRESS: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      KITE_TESTNET_RPC_URL: 'http://127.0.0.1:0',
      // AVALANCHE_FUJI_RPC_URL intentionally NOT set → adapter becomes null
      // (opt-in via PR #28). Tests that want it register the env var per-test
      // before `vi.resetModules()` + import.
      // Dummy operator PK (valid 0x + 64 hex format, NOT a real wallet).
      OPERATOR_PRIVATE_KEY:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
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
