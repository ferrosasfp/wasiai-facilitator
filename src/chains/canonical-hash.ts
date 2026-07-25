/**
 * Canonical JSON + SHA-256 helper (test-scope) — WKH-227 / HU-SOL-24, Wave W2.
 *
 * Algoritmo canónico (idéntico byte-a-byte al del consumer W3): sort recursivo
 * de keys → JSON string canónico → SHA-256 hex. Se usa para pinnear el hash del
 * IDL vendoreado (`escrow-idl.ts`) y compararlo contra la fuente de verdad
 * (`solana-programs/target/idl/escrow.json`) sin depender del orden de keys.
 */

import { createHash } from 'node:crypto';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        // eslint-disable-next-line security/detect-object-injection -- `k` is from Object.keys(obj); finite set derived from the object itself.
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

export function canonicalSha256(obj: unknown): string {
  return createHash('sha256').update(canonicalJson(obj), 'utf8').digest('hex');
}
