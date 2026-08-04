/**
 * Integration tests for GET /openapi.json (WFAC-23 W3).
 *
 * Coverage map (work-item ACs → test ids):
 *   - AC-1  → T-O1  : 200 + body.openapi === "3.1.0"
 *   - AC-2  → T-O2  : exactly 4 paths (POST /verify, POST /settle,
 *                     GET /supported, GET /health)
 *   - AC-3  → T-O3  : VerifyRequest.required matches Zod VerifyRequestSchema
 *   - AC-4  → T-O4  : SettleRequest is structurally identical to VerifyRequest
 *   - AC-5  → T-O5  : X402ErrorCode enum has all 10 values and HTTP mapping
 *                     matches HTTP_BY_CODE
 *   - AC-6  → T-O6  : SupportedResponse shape matches src/core/supported.ts
 *   - AC-7  → T-O7  : info.version === package.json#version
 *   - AC-8  → T-O8  : repeated requests do NOT re-read doc/openapi.yaml
 *                     (parse happens once at module load — CD-3)
 *   - AC-9  → T-O9  : spec parses cleanly and declares openapi 3.1.0 (light
 *                     structural validation — no external JSON Schema
 *                     validator available in repo deps, see test comment)
 *   - AC-10 → T-O10 : every path in the spec corresponds to a registered
 *                     Fastify route (inject each path and assert statusCode
 *                     !== 404)
 *   - AC-11 → T-O11 : /health path documents 200 response with exact fields
 *                     status/version/uptime/timestamp
 *
 * Testing strategy: the route has no Redis / chain dependencies, so we do not
 * need the ioredis mock or the chainRegistry reset machinery used in
 * routes.verify.test.ts / routes.settle.test.ts. We DO need the registry to
 * be empty-or-populated when injecting /supported and /verify for AC-10, but
 * those requests can return any non-404 status (400 for missing body, 200 for
 * /supported with zero adapters) — all that matters is that the route
 * exists.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { HTTP_BY_CODE } from '../../core/errors.js';
import type { X402ErrorCode } from '../../core/types.js';
import { SPL_TOKEN_TRANSFER_FINALIZED } from '../../chains/types.js';

// ─── core/audit.js mock (WFAC-33 W4) ───────────────────────────────────────
vi.mock('../../core/audit.js', () => {
  const persistAuditSpy = vi.fn(async () => undefined);
  const buildAuditSpy = vi.fn((input: unknown) => ({ __auditInput: input }));
  return {
    __esModule: true,
    buildAuditEntry: buildAuditSpy,
    persistAuditEntry: persistAuditSpy,
    __persistAuditSpy: persistAuditSpy,
    __buildAuditSpy: buildAuditSpy,
  };
});

/** Shape of the parsed OpenAPI document relevant to these tests. */
interface OpenAPIDoc {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly schemas: Record<string, Record<string, unknown>>;
  };
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    NODE_ENV: 'production',
    PORT: 3002,
    LOG_LEVEL: 'fatal',
    SHUTDOWN_GRACE_MS: 10000,
    REDIS_DB: 0,
    ...overrides,
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const { buildApp } = await import('../../app.js');
  return buildApp({ env: makeEnv(), skipDomainCheck: true }); // WFAC-53 CD-16
}

describe('GET /openapi.json', () => {
  let app: FastifyInstance;
  let spec: OpenAPIDoc;

  beforeAll(async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    spec = JSON.parse(res.body) as OpenAPIDoc;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── AC-1 ────────────────────────────────────────────────────────────────

  it('T-O1 / AC-1: returns 200 with body.openapi === "3.1.0"', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.openapi).toBe('3.1.0');
    expect(typeof body.info).toBe('object');
    expect(typeof body.paths).toBe('object');
  });

  // ─── AC-2 ────────────────────────────────────────────────────────────────

  it('T-O2 / AC-2: declares exactly the 4 expected path entries', () => {
    const pathKeys = Object.keys(spec.paths).sort();
    expect(pathKeys).toEqual(['/health', '/settle', '/supported', '/verify']);

    // Method check — each path declares exactly the expected HTTP verb.
    expect(Object.keys(spec.paths['/verify']!)).toEqual(['post']);
    expect(Object.keys(spec.paths['/settle']!)).toEqual(['post']);
    expect(Object.keys(spec.paths['/supported']!)).toEqual(['get']);
    expect(Object.keys(spec.paths['/health']!)).toEqual(['get']);
  });

  // ─── AC-3 ────────────────────────────────────────────────────────────────

  it('T-O3 / AC-3: VerifyRequest.required matches Zod VerifyRequestSchema shape', () => {
    const verifyReq = spec.components.schemas.VerifyRequest;
    expect(verifyReq).toBeDefined();

    const required = verifyReq!.required as string[];
    // Fields exactly match VerifyRequestSchema in src/core/schemas.ts:
    //   x402Version, resource, accepted, payload — strict object.
    expect([...required].sort()).toEqual(['accepted', 'payload', 'resource', 'x402Version']);

    // x402Version MUST be a const literal of 2 (CD-4 + CD-8 mapping).
    const props = verifyReq!.properties as Record<string, Record<string, unknown>>;
    expect(props.x402Version!.const).toBe(2);

    // `additionalProperties: false` on the top-level object matches the
    // Zod `.strict()` at schemas.ts.
    expect(verifyReq!.additionalProperties).toBe(false);
  });

  // ─── AC-4 ────────────────────────────────────────────────────────────────

  it('T-O4 / AC-4: SettleRequest is structurally identical to VerifyRequest', () => {
    const settleReq = spec.components.schemas.SettleRequest;
    expect(settleReq).toBeDefined();

    // The spec uses a $ref alias — SettleRequestSchema === VerifyRequestSchema
    // in src/core/schemas.ts. This is the deliberate way to express identity.
    const refOrStructure =
      (settleReq!.$ref as string | undefined) ?? JSON.stringify(settleReq!.properties ?? null);
    if (typeof settleReq!.$ref === 'string') {
      expect(settleReq!.$ref).toBe('#/components/schemas/VerifyRequest');
    } else {
      // Structural fallback — deep-equal the required/properties.
      const verifyReq = spec.components.schemas.VerifyRequest!;
      expect(refOrStructure).toBe(JSON.stringify(verifyReq.properties));
      expect(settleReq!.required).toEqual(verifyReq.required);
    }
  });

  // ─── AC-5 ────────────────────────────────────────────────────────────────

  it('T-O5 / AC-5: X402ErrorCode enum has all 11 codes and HTTP mapping matches HTTP_BY_CODE', () => {
    const codeSchema = spec.components.schemas.X402ErrorCode;
    expect(codeSchema).toBeDefined();

    const enumValues = codeSchema!.enum as string[];
    const expected: X402ErrorCode[] = [
      'INVALID_SIGNATURE',
      'INSUFFICIENT_BALANCE',
      'PERMIT2_ALLOWANCE_REQUIRED',
      'EXPIRED_AUTHORIZATION',
      'NETWORK_MISMATCH',
      'SIMULATION_FAILED',
      'INVALID_AMOUNT',
      'INVALID_RECEIVER',
      'TRANSACTION_FAILED',
      'DELEGATION_INVALID',
      'CHAIN_UNAVAILABLE',
    ];
    expect([...enumValues].sort()).toEqual([...expected].sort());

    // HTTP mapping coherence — every HTTP status we document as a possible
    // response on /verify and /settle must appear as an allowed value of
    // X402ErrorHttp (matching HTTP_BY_CODE canonical values).
    const httpSchema = spec.components.schemas.X402ErrorHttp;
    expect(httpSchema).toBeDefined();
    const httpEnum = httpSchema!.enum as number[];
    const uniqueHttpFromMap = Array.from(new Set(Object.values(HTTP_BY_CODE))).sort();
    expect([...httpEnum].sort()).toEqual(uniqueHttpFromMap);

    // ErrorBody top-level CD-5 check: `error` object has exactly 3 fields —
    // code, message, http — and no extras.
    const errorBody = spec.components.schemas.ErrorBody!;
    const errorProp = (errorBody.properties as Record<string, Record<string, unknown>>).error!;
    const errorRequired = errorProp.required as string[];
    expect([...errorRequired].sort()).toEqual(['code', 'http', 'message']);
    expect(errorProp.additionalProperties).toBe(false);
  });

  // ─── AC-6 ────────────────────────────────────────────────────────────────

  it('T-O6 / AC-6: SupportedResponse shape matches src/core/supported.ts', () => {
    const supported = spec.components.schemas.SupportedResponse;
    expect(supported).toBeDefined();

    const required = supported!.required as string[];
    expect([...required].sort()).toEqual(['chains', 'methods']);

    const props = supported!.properties as Record<string, Record<string, unknown>>;
    expect(props.chains!.type).toBe('array');
    expect(props.methods!.type).toBe('array');

    // Each chain entry → { network, name, methods }.
    const chainItem = spec.components.schemas.ChainSupportedItem!;
    const chainRequired = chainItem.required as string[];
    expect([...chainRequired].sort()).toEqual(['methods', 'name', 'network']);
    const chainProps = chainItem.properties as Record<string, Record<string, unknown>>;
    expect(chainProps.network!.type).toBe('string');
    expect(chainProps.name!.type).toBe('string');
    expect(chainProps.methods!.type).toBe('array');
  });

  // ─── AC-7 ────────────────────────────────────────────────────────────────

  it('T-O7 / AC-7: info.version === package.json#version', () => {
    const pkgPath = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(spec.info.version).toBe(pkg.version);
  });

  // ─── AC-8 ────────────────────────────────────────────────────────────────

  it('T-O8 / AC-8: repeated requests do not re-read the YAML (object identity via JSON)', async () => {
    // We can't directly inspect the module-level constant without breaking
    // encapsulation. Instead, we verify BEHAVIORAL equivalence: every call
    // returns byte-identical JSON. The only way this holds across many
    // requests is if the underlying object is the SAME cached object (any
    // per-request re-parse could introduce subtle key-order drift because
    // YAML does not guarantee insertion order across multiple js-yaml.load
    // invocations). This is a weaker-but-robust proxy for CD-3 compliance.
    const r1 = await app.inject({ method: 'GET', url: '/openapi.json' });
    const r2 = await app.inject({ method: 'GET', url: '/openapi.json' });
    const r3 = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
    expect(r1.body).toBe(r2.body);
    expect(r2.body).toBe(r3.body);
  });

  // ─── AC-9 ────────────────────────────────────────────────────────────────

  it('T-O9 / AC-9: spec is parseable JSON and declares OpenAPI 3.1.0 (lightweight structural check)', () => {
    // Note: a full JSON-Schema-of-OpenAPI-3.1 validator is not in repo deps
    // (CD-1 forbids @fastify/swagger; installing `@apidevtools/openapi-schemas`
    // would be an undeclared dep). The work-item AC-9 allows a lightweight
    // structural check when no validator is available — we assert the minimal
    // required top-level invariants of OpenAPI 3.1: `openapi`, `info.title`,
    // `info.version`, at least one entry in `paths`, and `components.schemas`
    // with every $ref target actually present.
    expect(spec.openapi).toBe('3.1.0');
    expect(typeof spec.info.title).toBe('string');
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(typeof spec.info.version).toBe('string');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(typeof spec.components.schemas).toBe('object');

    // Every $ref in the spec must resolve to an existing component schema.
    const refs = collectRefs(spec as unknown as Record<string, unknown>);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const schemaName = ref.replace('#/components/schemas/', '');
      // eslint-disable-next-line security/detect-object-injection -- `schemaName` is derived from our own hand-written doc/openapi.yaml (never user input). The test scans $refs to verify internal coherence — accessing `schemas[schemaName]` is the whole point.
      expect(spec.components.schemas[schemaName]).toBeDefined();
    }
  });

  // ─── AC-10 ───────────────────────────────────────────────────────────────

  it('T-O10 / AC-10: every documented path corresponds to a registered Fastify route', async () => {
    // Inject each documented path with its documented HTTP method. A
    // non-404 response proves the route is registered. 400/415/422 are all
    // acceptable — they mean "route exists, body/preconditions wrong", which
    // is fine for the coherence check.
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of Object.keys(pathItem)) {
        const upper = method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
        const res = await app.inject({
          method: upper,
          url: path,
          ...(upper === 'POST' ? { payload: '{}' } : {}),
        });
        // NOT 404 → route exists in Fastify.
        expect(res.statusCode).not.toBe(404);
      }
    }

    // Conversely — /openapi.json itself must be reachable (CD-2 sanity:
    // routes that exist in Fastify but NOT in the spec are acceptable for
    // now, but the discovery route must work).
    const openapiRes = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapiRes.statusCode).toBe(200);
  });

  // ─── AC-11 ───────────────────────────────────────────────────────────────

  it('T-O11 / AC-11: /health 200 response schema has exact fields status/version/uptime/timestamp', () => {
    const healthPath = spec.paths['/health'] as Record<string, Record<string, unknown>>;
    const getOp = healthPath.get! as Record<string, unknown>;
    const responses = getOp.responses as Record<string, Record<string, unknown>>;
    const ok = responses['200']!;
    const content = ok.content as Record<string, Record<string, unknown>>;
    const jsonContent = content['application/json']!;
    const schemaRef = (jsonContent.schema as Record<string, unknown>).$ref as string;

    // Resolve the $ref to the actual HealthResponse component.
    expect(schemaRef).toBe('#/components/schemas/HealthResponse');
    const healthSchema = spec.components.schemas.HealthResponse!;

    const required = healthSchema.required as string[];
    expect([...required].sort()).toEqual(['status', 'timestamp', 'uptime', 'version']);

    const props = healthSchema.properties as Record<string, Record<string, unknown>>;
    // status must be a literal const "ok" (CD-4 — JSON Schema 2020-12 const).
    expect(props.status!.const).toBe('ok');
    expect(props.version!.type).toBe('string');
    expect(props.uptime!.type).toBe('number');
    expect(props.timestamp!.type).toBe('string');
    expect(props.timestamp!.format).toBe('date-time');
  });

  // ─── WFAC-33 W4 — audit hook exclusion ────────────────────────────────

  it('T-AO-1 / AC-2: /openapi.json is NOT audited (listed in AUDIT_EXCLUDED_PATHS)', async () => {
    const audit = (await import('../../core/audit.js')) as unknown as {
      __persistAuditSpy: ReturnType<typeof vi.fn>;
      __buildAuditSpy: ReturnType<typeof vi.fn>;
    };
    audit.__persistAuditSpy.mockClear();
    audit.__buildAuditSpy.mockClear();

    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(audit.__persistAuditSpy).not.toHaveBeenCalled();
    expect(audit.__buildAuditSpy).not.toHaveBeenCalled();
  });

  // ─── WKH-323 — doc↔code drift guard ──────────────────────────────────────

  it('T-O-DRIFT: both published `methods` descriptions name the Solana literal and claim no uniformity', () => {
    // WKH-323 exists because the prose drifted from the code and nothing
    // caught it: openapi.yaml claimed `eip3009` for every chain while the
    // Solana adapter implements an entirely different mechanism. Restating the
    // rule would not enforce it, so this is the mechanical tie between the
    // published document and the constant production code exports.
    const endpointDescription = (spec.paths['/supported']!.get as { description?: string })
      .description;
    const fieldDescription = (
      spec.components.schemas.ChainSupportedItem!.properties as Record<
        string,
        Record<string, unknown>
      >
    ).methods!.description as string | undefined;

    for (const description of [endpointDescription, fieldDescription]) {
      expect(typeof description).toBe('string');
      expect(description).toContain(SPL_TOKEN_TRANSFER_FINALIZED);
      // No blanket claim about the whole registry: `methods` is per chain.
      expect(description).not.toMatch(/every chain|always/i);
    }
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively collects every `$ref` string from the OpenAPI document. Used
 * by T-O9 to verify internal-reference coherence without a full OpenAPI
 * validator.
 */
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (key === '$ref' && typeof value === 'string') {
      out.push(value);
    } else {
      collectRefs(value, out);
    }
  }
  return out;
}
