/* eslint-disable security/detect-non-literal-fs-filename */
// This test intentionally walks the project's src/ tree via dynamic paths
// derived from import.meta.url to audit console.* usage. The non-literal fs
// warning does not apply to a test-only audit script.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'src');

const CONSOLE_REGEX = /\bconsole\.(log|warn|error|info|debug)\s*\(/;

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Skip the tests subtree — only source files must be console-free.
      if (full.endsWith('__tests__')) continue;
      results.push(...walk(full));
    } else if (stat.isFile() && full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('source files', () => {
  it('have no console.<log|warn|error|info|debug> usage', () => {
    const files = walk(SRC_DIR);
    const violations: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (CONSOLE_REGEX.test(line)) {
          violations.push({ file, line: idx + 1, match: line.trim() });
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
