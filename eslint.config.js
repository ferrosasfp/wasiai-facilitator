// ESLint 9 flat config shim that loads the legacy .eslintrc.json via
// @eslint/eslintrc compatibility layer. This is a transitional config so the
// scaffold's existing rules keep working until a full flat-config migration
// is done in a dedicated HU. See doc/sdd/001-wfac-2-fastify-bootstrap for the
// DRIFT-1 note recorded during F3.

import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

export default [
  ...compat.config({
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: ['@typescript-eslint', 'security', 'no-secrets'],
    extends: [
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:security/recommended-legacy',
      'prettier',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-secrets/no-secrets': ['error', { tolerance: 4.5 }],
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
    ignorePatterns: ['dist/', 'node_modules/', '*.config.ts', '*.config.js'],
  }),
];
