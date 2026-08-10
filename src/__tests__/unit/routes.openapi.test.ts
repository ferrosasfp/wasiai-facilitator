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
 *   - AC-11 → T-O11 : /health 200 response schema declares EXACTLY the keys the
 *                     route emits, derived from a real inject + the
 *                     `tsc`-tied table in `../helpers/health-shape.ts` (WKH-344;
 *                     it used to compare against a list written inside this
 *                     file, see the comment on the test)
 *
 * WKH-344 — `/health` contract guards (the `/supported` defect, one endpoint over):
 *   - T-O11-DETAIL : `HealthDetail` / `redis` / `wallet` / `ChainHealthItem`
 *                    derive their KEYS and their ENUMS from the code.
 *   - T-H-CONF-1   : the REAL 200 body validates against `HealthResponse` with
 *                    ajv (0 `additionalProperties` errors).
 *   - T-H-KEEP     : `degraded` stays in the body and stays the summary of
 *                    `details.degraded` (AC-4 forbids removing it).
 *   - T-O-DRIFT-3  : the endpoint description describes the snapshot mechanism
 *                    instead of denying the probe.
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
import { asChainId } from '../../core/types.js';
import { SPL_TOKEN_TRANSFER_FINALIZED } from '../../chains/types.js';
import type { SettlementAdapter } from '../../chains/types.js';
import {
  CHAIN_HEALTH_FIELDS,
  CHAIN_HEALTH_OPTIONAL_FIELDS,
  CHAIN_HEALTH_REQUIRED_FIELDS,
  HEALTH_DETAIL_FIELDS,
  HEALTH_DETAIL_REDIS_FIELDS,
  HEALTH_DETAIL_WALLET_FIELDS,
  HEALTH_RESPONSE_FIELDS,
  compileHealthResponseValidator,
  loadOpenApiSpec,
} from '../helpers/health-shape.js';

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
    // Deliberately partial (repo idiom, cf. routes.settle.failopen.test.ts): this
    // fixture sets only the fields the unit under test reads. The cast is what lets
    // it stand in for EnvConfig — every field NOT listed above reaches the code as
    // `undefined` even though EnvConfig declares it required.
  } as EnvConfig;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const { buildApp } = await import('../../app.js');
  return buildApp({ env: makeEnv(), skipDomainCheck: true }); // WFAC-53 CD-16
}

/**
 * AR BLQ-BAJO-2 — testigo mínimo para derivar `ChainSupportedItem` del código real.
 *
 * Deliberadamente SIN `getBreakerState` (como el adaptador Solana real), así que la entrada
 * que produce el serializador trae `breakerStateAbsentReason` y NO `breakerState` — que es
 * la mitad del invariante XOR que este test puede medir con un solo testigo.
 * CD-15/CD-16 observado: no importa `src/chains/kite.ts` ni `avalanche.ts`.
 */
function makeOpenapiFakeAdapter(): SettlementAdapter {
  return {
    metadata: {
      chainId: asChainId(2368),
      name: 'Kite Testnet',
      network: 'testnet',
      networkId: 'eip155:2368',
      rpcUrl: 'http://localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: [],
    },
    verify: vi.fn() as unknown as SettlementAdapter['verify'],
    settle: vi.fn() as unknown as SettlementAdapter['settle'],
    probeRpc: vi.fn() as unknown as SettlementAdapter['probeRpc'],
  };
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

  // ⚠️ AR BLQ-BAJO-2 — ESTE TEST SE COMPARABA CONTRA EL SPEC, NO CONTRA EL TIPO.
  //
  // Su nombre dice "matches src/core/supported.ts" y lo que hacía era leer
  // `spec.…required` y compararlo con una lista escrita a mano EN EL MISMO TEST. O sea:
  // el guard se aplaudía solo. Consecuencia medida: WKH-342 agregó `dedicatedRoutes` al
  // tipo y a la respuesta, el spec quedó con `additionalProperties: false` y
  // `properties [chains, methods]`, y `GET /supported` pasó a servir en TODO 200 un cuerpo
  // que su propio contrato publicado rechaza (`ajv`: "should NOT have additional
  // properties: dedicatedRoutes") — con este test en VERDE. Y peor: documentar el campo
  // ponía este test en rojo, o sea que el guard bloqueaba su propio arreglo.
  //
  // Ahora el lado izquierdo de la comparación se DERIVA del código: se llama a la función
  // real y se leen las claves que emite. No hay lista escrita a mano de la que el spec
  // pueda divergir.
  it('T-O6 / AC-6: SupportedResponse shape matches src/core/supported.ts (derivado del tipo, no del spec)', async () => {
    const { getSupportedResponse, DEDICATED_ROUTE_IDS } = await import('../../core/supported.js');
    const { chainRegistry } = await import('../../chains/registry.js');

    const supported = spec.components.schemas.SupportedResponse;
    expect(supported).toBeDefined();
    const props = supported!.properties as Record<string, Record<string, unknown>>;
    const required = supported!.required as string[];

    // ── Testigo REAL del cuerpo de nivel superior. Con el registry vacío las claves de
    //    `SupportedResponse` son igual las tres: ninguna es opcional en el tipo.
    chainRegistry._resetForTesting();
    const witness = getSupportedResponse(['POST /solana/payout']) as unknown as Record<
      string,
      unknown
    >;
    const emitted = Object.keys(witness).sort();

    // (1) Todo lo que el código EMITE está declarado. Es exactamente lo que
    //     `additionalProperties: false` hace cumplir en un validador, y es la dirección
    //     que estaba rota.
    expect(Object.keys(props).sort()).toEqual(emitted);
    // (2) Y todo lo que el spec exige, el código lo manda. Sin esto, el spec podría pedir
    //     un campo que nunca sale.
    expect([...required].sort()).toEqual(emitted);
    // (3) El control que impide que (1) y (2) pasen por vacío o por tautología: el campo
    //     de WKH-342 tiene que estar en las tres partes.
    expect(emitted).toContain('dedicatedRoutes');
    expect(required).toContain('dedicatedRoutes');
    expect(props.chains!.type).toBe('array');
    expect(props.methods!.type).toBe('array');
    expect(props.dedicatedRoutes!.type).toBe('array');

    // ── CR MNR-1 — LA COMPARACIÓN BAJA HASTA `items`, que era el residuo.
    //
    // Con las claves derivadas pero el `items` escrito a mano, dos inputs MEDIDOS dejaban
    // este test en 14 passed y `tsc` en 0 mientras `ajv` rechazaba el cuerpo real:
    //   (a) `items.type: string` → `integer` en el yaml;
    //   (b) un cuarto `DedicatedRouteId` en `core/supported.ts` (el `enum` del yaml no lo
    //       tenía, así que el 200 real quedaba fuera de su propio contrato).
    // Ahora los dos lados salen del MISMO array de runtime.
    const items = props.dedicatedRoutes!.items as Record<string, unknown>;
    expect([...(items.enum as string[])].sort()).toEqual([...DEDICATED_ROUTE_IDS].sort());
    // `items.type` también se DERIVA: es el `typeof` real de los valores publicados, no un
    // literal escrito acá. Si el union pasara a ser de otro tipo, esto se mueve solo.
    const idTypes = [...new Set(DEDICATED_ROUTE_IDS.map((id) => typeof id))];
    expect(idTypes).toEqual(['string']);
    expect(items.type).toBe(idTypes[0]);
    // Control de que (b) no pase por vacío: el enum no está vacío y trae la ruta de dinero.
    expect((items.enum as string[]).length).toBe(DEDICATED_ROUTE_IDS.length);
    expect(items.enum as string[]).toContain('POST /solana/payout');

    // ── Misma disciplina un nivel adentro: `ChainSupportedItem`, con un testigo real.
    const chainItem = spec.components.schemas.ChainSupportedItem!;
    const chainProps = chainItem.properties as Record<string, Record<string, unknown>>;
    const chainRequired = chainItem.required as string[];

    chainRegistry._resetForTesting();
    try {
      chainRegistry.register(makeOpenapiFakeAdapter());
      const entry = (
        getSupportedResponse([]) as unknown as {
          chains: Array<Record<string, unknown>>;
        }
      ).chains[0];
      expect(entry).toBeDefined();
      const entryKeys = Object.keys(entry!).sort();

      // Toda clave emitida por una entrada está declarada en el spec.
      for (const key of entryKeys) expect(Object.keys(chainProps)).toContain(key);
      // Y toda clave `required` del spec sale en la entrada. `breakerState` /
      // `breakerStateAbsentReason` NO son required (exactamente-uno-de-los-dos, y el tipo
      // los declara opcionales), así que este testigo alcanza para las tres constantes.
      for (const key of chainRequired) expect(entryKeys).toContain(key);
      expect([...chainRequired].sort()).toEqual(['methods', 'name', 'network']);
      // El invariante XOR sigue vivo en el testigo, y el spec declara las dos mitades.
      expect(Object.keys(chainProps)).toContain('breakerState');
      expect(Object.keys(chainProps)).toContain('breakerStateAbsentReason');
      expect(entryKeys).toContain('breakerStateAbsentReason');
      expect(entryKeys).not.toContain('breakerState');
    } finally {
      chainRegistry._resetForTesting();
    }

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

  // ⚠️ WKH-344 — ESTE TEST TAMBIÉN SE COMPARABA CONSIGO MISMO, Y BLOQUEABA SU PROPIO ARREGLO.
  //
  // Su lista de claves estaba escrita a mano acá adentro (`['status', 'timestamp', 'uptime',
  // 'version']`), así que el spec podía declarar 4 campos mientras la ruta emitía 6 y este
  // test seguía verde. Medido en fc5be87 con js-yaml + ajv 8 sobre el 200 real: `valid?
  // false`, dos errores `additionalProperties` (`degraded`, `details`) — o sea que TODO 200
  // de producción violaba su propio contrato publicado, con este test en verde. Y al
  // documentar los dos campos que faltaban, ESTE test se puso rojo: el guard bloqueaba el
  // arreglo que debía exigir.
  //
  // Ahora las tres partes se comparan contra un testigo REAL (`app.inject`) y contra la tabla
  // de `../helpers/health-shape.ts`, que `npm run typecheck` ata al tipo `HealthResponse`.
  it('T-O11 / AC-2: HealthResponse deriva sus claves del código real (testigo + tabla exhaustiva), no de una lista escrita acá', async () => {
    const healthPath = spec.paths['/health'] as Record<string, Record<string, unknown>>;
    const responses = healthPath.get!.responses as Record<string, Record<string, unknown>>;
    const content = responses['200']!.content as Record<string, Record<string, unknown>>;
    const schemaRef = (content['application/json']!.schema as Record<string, unknown>).$ref;
    expect(schemaRef).toBe('#/components/schemas/HealthResponse');

    const healthSchema = spec.components.schemas.HealthResponse!;
    const props = healthSchema.properties as Record<string, Record<string, unknown>>;
    const required = healthSchema.required as string[];

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const witness = JSON.parse(res.body) as Record<string, unknown>;
    const emitted = Object.keys(witness).sort();

    // (1) todo lo EMITIDO está declarado — la dirección que estaba rota.
    expect(Object.keys(props).sort()).toEqual(emitted);
    // (2) todo lo `required` se emite.
    expect([...required].sort()).toEqual(emitted);
    // (3) y la tabla atada por tsc coincide con las dos.
    expect([...HEALTH_RESPONSE_FIELDS].sort()).toEqual(emitted);
    expect(healthSchema.additionalProperties).toBe(false);

    // controles anti-tautología: los dos campos de ESTA HU, en las tres partes.
    for (const f of ['degraded', 'details'] as const) {
      expect(emitted).toContain(f);
      expect(required).toContain(f);
      expect(Object.keys(props)).toContain(f);
    }

    // el `type` de cada escalar se DERIVA del typeof del testigo (patrón T-O6).
    expect(props.status!.const).toBe(witness.status);
    expect(props.version!.type).toBe(typeof witness.version);
    expect(props.uptime!.type).toBe(typeof witness.uptime);
    expect(props.timestamp!.type).toBe(typeof witness.timestamp);
    expect(props.timestamp!.format).toBe('date-time');
    expect(props.degraded!.type).toBe(typeof witness.degraded);
    expect(props.details!.$ref).toBe('#/components/schemas/HealthDetail');
  });

  // ─── WKH-344 ─────────────────────────────────────────────────────────────

  it('T-O11-DETAIL / AC-3: HealthDetail, redis, wallet y ChainHealthItem derivan del código (claves Y enums)', async () => {
    const { REDIS_HEALTH_STATUSES, CHAIN_RPC_STATUSES, PROBE_FAILURE_KINDS } =
      await import('../../core/health-status.js');

    const detail = spec.components.schemas.HealthDetail!;
    const dProps = detail.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(dProps).sort()).toEqual([...HEALTH_DETAIL_FIELDS].sort());
    expect([...(detail.required as string[])].sort()).toEqual([...HEALTH_DETAIL_FIELDS].sort());
    expect(detail.additionalProperties).toBe(false);

    // redis / wallet: inline en TS, inline en el schema.
    const redis = dProps.redis!;
    expect(Object.keys(redis.properties as object).sort()).toEqual(
      [...HEALTH_DETAIL_REDIS_FIELDS].sort(),
    );
    expect(redis.additionalProperties).toBe(false);
    const wallet = dProps.wallet!;
    expect(Object.keys(wallet.properties as object).sort()).toEqual(
      [...HEALTH_DETAIL_WALLET_FIELDS].sort(),
    );
    expect(wallet.additionalProperties).toBe(false);

    const item = spec.components.schemas.ChainHealthItem!;
    const iProps = item.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(iProps).sort()).toEqual([...CHAIN_HEALTH_FIELDS].sort());
    // `required` del schema === las claves NO opcionales del tipo. Ata las dos nociones.
    expect([...(item.required as string[])].sort()).toEqual(
      [...CHAIN_HEALTH_REQUIRED_FIELDS].sort(),
    );
    expect(item.additionalProperties).toBe(false);
    for (const f of CHAIN_HEALTH_OPTIONAL_FIELDS) {
      expect(item.required as string[]).not.toContain(f); // el bug con el signo invertido
      expect(Object.keys(iProps)).toContain(f);
    }
    expect(dProps.chains!.type).toBe('array');
    expect((dProps.chains!.items as Record<string, unknown>).$ref).toBe(
      '#/components/schemas/ChainHealthItem',
    );

    // Los TRES enums salen de las tuplas de runtime, no de una copia (CD-15).
    const enumOf = (s: Record<string, unknown>): string[] => [...(s.enum as string[])].sort();
    expect(enumOf((redis.properties as Record<string, Record<string, unknown>>).status!)).toEqual(
      [...REDIS_HEALTH_STATUSES].sort(),
    );
    expect(enumOf(iProps.rpc!)).toEqual([...CHAIN_RPC_STATUSES].sort());
    expect(enumOf(iProps.lastFailureKind!)).toEqual([...PROBE_FAILURE_KINDS].sort());
    // controles anti-vacío de los enums.
    expect(REDIS_HEALTH_STATUSES.length).toBe(3);
    expect((iProps.rpc!.enum as string[]).length).toBe(CHAIN_RPC_STATUSES.length);
    expect(enumOf(iProps.rpc!)).toContain('unreachable');
  });

  it('T-H-CONF-1 / AC-1: el 200 real de /health valida contra HealthResponse con ajv (0 additionalProperties)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;

    const validate = compileHealthResponseValidator(loadOpenApiSpec());
    const ok = validate(body);
    expect(validate.errors ?? []).toEqual([]); // primero los errores: el mensaje es el que sirve
    expect(ok).toBe(true);

    // control anti-vacío: no está validando `{}`.
    expect(Object.keys(body).length).toBe(HEALTH_RESPONSE_FIELDS.length);
    expect(Object.keys(body)).toContain('details');
  });

  it('T-H-KEEP / AC-4: `degraded` sigue en el cuerpo y es el resumen de details.degraded', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body) as { degraded: unknown; details: { degraded: unknown } };
    expect(typeof body.degraded).toBe('boolean');
    expect(body.degraded).toBe(body.details.degraded); // src/routes/health.ts:56
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

  it('T-O-DRIFT-2: the top-level `methods` union is described as a label, not as a value to put on the wire', () => {
    // Third edited description (CR BLQ-BAJO-1). The guard above cannot cover
    // it: this text legitimately says "every chain's `methods` array" (it IS
    // the union), so /every chain|always/ would match its own honest wording —
    // which is exactly why the false sentence landed here and nowhere else.
    //
    // The assert that applies here is the one that sentence broke. There is no
    // wire slot for `spl-token-transfer-finalized`: the only documented one is
    // `AcceptedExtra.assetTransferMethod` (enum eip3009/permit2/erc7710,
    // `required`, `additionalProperties: false`), and the Solana branch of
    // `src/core/schemas.ts` is `.strict()` with no `extra`, so a body carrying
    // it is rejected by Zod. `src/core/verify.ts` dispatches on
    // `accepted.network`, which is what the description must point at.
    const endpointDescription = (spec.paths['/supported']!.get as { description?: string })
      .description;
    const fieldDescription = (
      spec.components.schemas.ChainSupportedItem!.properties as Record<
        string,
        Record<string, unknown>
      >
    ).methods!.description as string | undefined;
    const unionDescription = (
      spec.components.schemas.SupportedResponse!.properties as Record<
        string,
        Record<string, unknown>
      >
    ).methods!.description as string | undefined;

    expect(typeof unionDescription).toBe('string');
    expect(unionDescription).toMatch(/accepted\.network/);
    // Catches the reintroduction of an instruction to transmit the value
    // ("which method to send" / "submit this method"), in the three edited
    // descriptions at once.
    for (const description of [endpointDescription, fieldDescription, unionDescription]) {
      expect(description).not.toMatch(/\b(send|sends|sending|submit|submits)\b/i);
    }
  });

  // ─── WKH-344 — la descripción publicada de GET /health ────────────────────

  it('T-O-DRIFT-3 / AC-8: la descripción de GET /health describe el mecanismo del snapshot, sin negar el sondeo ni prometer que es por request', async () => {
    // La frase vieja ("alive — does NOT probe Redis, RPC, or downstream dependencies") era
    // falsa: se sondea RPC y se hace un PING real a Redis. Pero invertirla ("sí sondea") es
    // el error simétrico y también falso: el sondeo corre en un refresco de fondo que la
    // request no awaitea. Este guard exige las DOS mitades a la vez.
    const { SNAPSHOT_TTL_MS } = await import('../../core/health-status.js');
    const raw = (spec.paths['/health']!.get as { description?: string }).description;
    expect(typeof raw).toBe('string');
    // ⚠️ APLANAR ANTES DE MATCHEAR, y no es cosmético: `description: |` es un block scalar
    // LITERAL, así que los saltos de línea del YAML sobreviven al parseo. La primera versión
    // de este guard matcheaba contra el texto crudo y el experimento de mutación lo pasó en
    // verde: la frase falsa reinsertada quedó cortada como `up\nto 5000 ms stale`, y
    // `/up to /` no matchea a través del salto. Un re-wrap del párrafo alcanzaba para
    // desarmar el assert sin cambiar una palabra.
    const desc = raw!.replace(/\s+/g, ' ');
    // la afirmación falsa que esta HU saca.
    expect(desc).not.toMatch(/does\s+not\s+probe/i);
    // y el error simétrico: tiene que quedar claro que es de fondo y no awaiteado.
    expect(desc).toMatch(/background/i);
    expect(desc).toMatch(/never awaits/i);
    // El número sale de la constante de PRODUCCIÓN, no de una copia en el yaml: sin este
    // lazo, el mutante de una línea `SNAPSHOT_TTL_MS = 30000` dejaría la frase publicada
    // falsa sin poner nada rojo.
    expect(desc).toContain(`${SNAPSHOT_TTL_MS} ms`);
    expect(desc).toMatch(/probedAt/);
    // ⚠️ EL EJE CUANTITATIVO — el que este guard NO miraba (AR BLQ-MED-1).
    //
    // Tener el número no dice NADA sobre qué se afirma con él, y lo que se afirmaba era
    // falso: "`details.probedAt` may be up to 5000 ms stale". `SNAPSHOT_TTL_MS` no es un
    // techo: es el umbral a partir del cual una request DISPARA el refresco de fondo, y esa
    // misma request se contesta con el snapshot anterior: el `if (… > SNAPSHOT_TTL_MS) {
    // kickRefresh(); }` seguido de `return _snapshot` dentro de `getHealthStatus()`
    // (`health-status.ts:359-362`). No hay `setInterval` en `src/` y `getHealthStatus()`
    // tiene un solo llamador de producción (`src/routes/health.ts:53`), así que la antigüedad
    // servida la fija la CADENCIA de requests. Medido con `tsx` sobre el módulo real, dos
    // cadencias: con llamadas cada 7000 ms se sirvieron 7308/7005/7007 ms; cada 15000 ms,
    // 15307/15016/15015 ms. La edad sigue al hueco entre llamadas, no al TTL.
    //
    // ⚠️ ALCANCE REAL DEL ASSERT DE ABAJO — leelo antes de apoyarte en su verde.
    //
    // Es una LISTA NEGRA ENUMERADA de 10 redacciones, NO un detector de "la forma techo".
    // Cualquier sinónimo que no esté en la lista pasa en verde. La versión anterior de este
    // comentario decía lo contrario ("prohíbe la FORMA «techo»; cualquier redacción con la que
    // un lector pueda calcular una antigüedad máxima lo pone rojo") y era falsa con cuatro
    // inputs que el AR-2 midió sobrevivientes: "at worst 5000 ms old", "never more than
    // 5000 ms old", "bounded by 5000 ms and cannot exceed it", "capped at 5 seconds". Las
    // cuatro publicaban de vuelta el techo que esta HU saca, con la suite en verde. Un
    // comentario que promete exhaustividad es el mecanismo exacto por el que el bloqueante
    // original pasó el gate: tranquiliza al revisor sobre una cobertura que no existe.
    //
    // Las 10 que hoy prohíbe, y nada más:
    //   1. `up to … stale`   2. `never stale`      3. `at most`
    //   4. `no older than`   5. `maximum age` / `maximum staleness`
    //   6. `bounded by`      7. `cannot` / `can't exceed`
    //   8. `capped at`       9. `at worst`        10. `never more than`
    // Las 1-5 venían del fix-pack 1; las 6-10 son exactamente las que el AR-2 nombró. Cerrar
    // la CLASE entera con una regex no se puede: lo que este assert compra es que una
    // redacción YA VISTA no vuelva. Una nueva la tiene que cazar un humano en el CR.
    //
    // Control de falso positivo: medido contra el texto honesto actual, que dice "it is not a
    // ceiling", "no upper bound in the code" y "older than 5000 ms" — ninguna de las 10
    // matchea, así que la lista no está en verde por vacuidad ni pelea con la prosa buena.
    expect(desc).not.toMatch(
      /up to .{0,40}stale|never stale|at\s+most|no\s+older\s+than|maximum\s+(age|staleness)|bounded\s+by|can(?:not|'t)\s+exceed|capped\s+at|at\s+worst|never\s+more\s+than/i,
    );
    // CD-9: sin imperativos al integrador.
    expect(desc).not.toMatch(/\b(send|submit|set|pass)\b/i);
  });

  it('T-O-DRIFT-4: las descripciones optimistas de `details` (`redis.status`, `lastFailureKind`, `degraded`, `rpc`, `consecutiveFailures`) publican el descargo del snapshot pre-probe', () => {
    // AR-1 BLQ-BAJO-1/BLQ-BAJO-2 + AR-2 BLQ-BAJO-3: tres frases de campo que afirmaban de
    // más, y que el descargo de `probedAt` NO cubría (ese párrafo acotaba lo "optimista" a
    // las entradas de `chains`, y ninguna de las tres frases es sobre `chains`). Son CINCO:
    // las dos aditivas de `ChainHealthItem` salieron al escribir el bloque (4) y no las había
    // listado ningún AR (ver (5)).
    //
    // ⚠️ QUÉ MIRA ESTE TEST, para que el título no prometa más de lo que hace: mira TEXTO
    // PUBLICADO. Ningún assert de acá ejecuta `health-status.ts`, así que ninguno prueba por
    // sí mismo que el comportamiento descrito sea el real; exige que el descargo esté
    // escrito. El comportamiento lo miden otros: `HP-9` en `health.probe-non-evm.test.ts`
    // (clasificación real de EAI_AGAIN vs ENOTFOUND, con el módulo corriendo) y las
    // mediciones con `tsx` citadas abajo. El título anterior decía "no afirman una medición
    // que no ocurrió", que se lee como si ACÁ se midiera algo: no se mide nada acá.
    //
    // Y el alcance de cada assert es PRESENCIA/AUSENCIA de tokens, no corrección de la
    // frase: un texto que conserve los tokens exigidos y afirme de más en otra oración pasa
    // en verde. Es el mismo límite que el guard de la lista negra de T-O-DRIFT-3.
    const detail = spec.components.schemas.HealthDetail!;
    const dProps = detail.properties as Record<string, Record<string, unknown>>;
    const redisStatusDesc = (
      (dProps.redis!.properties as Record<string, Record<string, unknown>>).status!
        .description as string
    ).replace(/\s+/g, ' ');

    // (1) `redis.status: 'ok'` se sirve SIN PING en el snapshot pre-probe:
    //     `initialSnapshot()` hace `status: redisConfigured ? 'ok' : 'disabled'`
    //     (`health-status.ts:326`) y NO llama a `isRedisReachable()` — ese llamado existe
    //     una sola vez, en `probeAll()` (`health-status.ts:279`). Medido con el mock de
    //     `getRedisClient`:
    //     `{configured:true,status:"ok"}` con `probedAt: 0`. El PING del refresco de fondo
    //     puede estar EN VUELO (se lo vio llamado 1 vez), pero su resultado no está en el
    //     cuerpo servido: de ahí que lo exigido sea "completado", no "ocurrió".
    expect(redisStatusDesc).toMatch(/completed/i);
    expect(redisStatusDesc).toMatch(/probedAt/);
    // ⚠️ EL ASSERT QUE HACE EL TRABAJO (AR-2 BLQ-BAJO-2). Con sólo `completed` + `probedAt` +
    // el negativo de abajo, el mutante "``ok`` means the PING completed successfully, …, read
    // together with `probedAt`" sobrevive en VERDE: conserva los dos tokens, no usa la forma
    // exacta que el negativo prohíbe, y publica igual el PING como hecho consumado. Lo que
    // distingue al texto honesto es que dice el caso SIN PING, así que eso es lo que se exige.
    expect(redisStatusDesc).toMatch(/no PING/i);
    // la forma que afirmaba el PING como hecho consumado, sin calificar.
    expect(redisStatusDesc).not.toMatch(/`ok` \(PING succeeded\)/i);

    // (2) DNS no se reporta "at once": `EAI_AGAIN` (fallo TEMPORAL de resolución en Node)
    //     está en `TRANSIENT_PROBE_ERROR_RE` (`health-status.ts:121-122`), así que se tolera por
    //     debajo del umbral. La clasificación real de los dos códigos se MIDE en
    //     `health.probe-non-evm.test.ts` (HP-9); acá se exige que el contrato no vuelva a
    //     meter "DNS" entero bajo `connection`.
    const kindDesc = (
      (
        spec.components.schemas.ChainHealthItem!.properties as Record<
          string,
          Record<string, unknown>
        >
      ).lastFailureKind!.description as string
    ).replace(/\s+/g, ' ');
    expect(kindDesc).not.toMatch(/reported at once/i);
    expect(kindDesc).toMatch(/EAI_AGAIN/);
    expect(kindDesc).toMatch(/ENOTFOUND/);

    // (3) `degraded` es la TERCERA descripción optimista (AR-2 BLQ-BAJO-3) y la única con
    //     consumidor productivo: es el campo que lee el monitor. `initialSnapshot()` lo
    //     calcula como `degraded: !walletPresent` (`health-status.ts:322`) — no mira Redis ni
    //     las chains.
    //     MEDIDO con `tsx` sobre el módulo real (REDIS_URL a un puerto muerto → configured
    //     true / PING falla, un adapter que rechaza `connect ECONNREFUSED`, wallet presente):
    //       PRE-PROBE : {"degraded":false,"redis":{"configured":true,"status":"ok"},
    //                    "chains":[{...,"rpc":"ok"}],"probedAt":0}
    //       POST-PROBE: {"degraded":true, "redis":{...,"status":"unreachable"},
    //                    "chains":[{...,"rpc":"unreachable"}]}
    //     O sea que a `probedAt: 0` la frase publicada ("True when ANY tracked dependency is
    //     not in its healthy state") era falsa en los DOS `degraded` (el de `HealthResponse` y
    //     el de `HealthDetail`), que es donde estaba escrita. Contraprueba del otro lado: sin
    //     OPERATOR_PRIVATE_KEY el pre-probe ya da `degraded:true`, así que el eje del wallet SÍ
    //     se evalúa y el campo no es una constante. Y con todo sano y Redis 'disabled', el
    //     cuerpo pre-probe y el post-probe salieron IDÉNTICOS salvo `probedAt` (medido en esa
    //     configuración): de ahí que el descargo mande a leer `probedAt`.
    const hrProps = spec.components.schemas.HealthResponse!.properties as Record<
      string,
      Record<string, unknown>
    >;
    const flat = (s: unknown): string => String(s).replace(/\s+/g, ' ');
    const degradedDescs: ReadonlyArray<readonly [string, string]> = [
      ['HealthResponse.degraded', flat(hrProps.degraded!.description)],
      ['HealthDetail.degraded', flat(dProps.degraded!.description)],
    ];
    // Cuatro tokens, en las DOS descripciones. El mutante que las devuelve a la frase
    // universal de una línea pierde los cuatro. Un mutante que los conserve y afirme de más
    // en otra oración NO lo caza esto (ver el aviso de alcance arriba).
    for (const [where, text] of degradedDescs) {
      expect(text, `${where}: sin el descargo de probedAt`).toMatch(/probedAt/);
      expect(text, `${where}: sin la condición pre-probe`).toMatch(/before the first probe/i);
      expect(text, `${where}: no dice de qué depende a probedAt: 0`).toMatch(/wallet\.present/);
      expect(text, `${where}: no dice que ese eje es el ÚNICO`).toMatch(/\balone\b/i);
    }

    // (4) COHERENCIA de la enumeración de "lo no medido a `probedAt: 0`". Estaba partida en
    //     tres versiones distintas (AR-2 BLQ-BAJO-3): el endpoint decía "`chains` y
    //     `redis.status`", `probedAt` decía sólo "`chains`", y `degraded` no figuraba en
    //     ninguna de las dos.
    //
    //     La comparación es contra una cadena CANÓNICA literal, no "que aparezcan los tres
    //     nombres en algún lado". La versión por tokens la medí y era falsa: el mutante que
    //     saca `degraded` de la lista del endpoint pasaba en VERDE, porque la oración
    //     siguiente dice `degraded` por otro motivo ("so `degraded` there is
    //     `!details.wallet.present` ALONE") y el token seguía presente. Comparar la cadena
    //     entera además es lo que la HU necesita: el defecto era que los dos lugares
    //     enumeraran DISTINTO, así que re-redactar uno solo tiene que ponerse rojo aunque la
    //     redacción nueva sea correcta.
    const CANONICAL_OPTIMISTIC = "`degraded`, `redis.status`, and the `chains` entries' `rpc`";
    // Segunda cadena canónica, por el eje que se me pasó al escribir la primera: la lista de
    // arriba decía "THREE fields" y era una afirmación de EXHAUSTIVIDAD falsa. A `probedAt: 0`
    // los dos campos aditivos de cada chain están AUSENTES igual que en una sonda limpia, así
    // que también son optimistas. Ver (5).
    const CANONICAL_ADDITIVE =
      '`consecutiveFailures` and `lastFailureKind` are absent then too, exactly as on a ' +
      'clean probe, so their absence does not mean a probe succeeded.';
    const ANCHOR = /before the first probe completes/i;
    const enumerating: ReadonlyArray<readonly [string, string]> = [
      [
        'GET /health description',
        flat((spec.paths['/health']!.get as { description?: string }).description),
      ],
      ['HealthDetail.probedAt', flat(dProps.probedAt!.description)],
    ];
    for (const [where, text] of enumerating) {
      expect(
        text.search(ANCHOR),
        `${where}: no dice qué pasa antes de la primera sonda`,
      ).toBeGreaterThanOrEqual(0);
      expect(text, `${where}: la enumeración no es la canónica`).toContain(CANONICAL_OPTIMISTIC);
      expect(text, `${where}: falta la aclaración canónica de los campos aditivos`).toContain(
        CANONICAL_ADDITIVE,
      );
    }

    // (5) LOS DOS CAMPOS ADITIVOS — el eje que se me pasó escribiendo (4), y que ningún AR
    //     había listado. A `probedAt: 0` `consecutiveFailures` y `lastFailureKind` están
    //     ausentes exactamente como en una sonda limpia, así que lo que publicaba
    //     `consecutiveFailures` ("Its absence means the last probe succeeded.") era falso
    //     cuando NO hubo ninguna sonda: misma clase que BLQ-BAJO-3, en dos descripciones más.
    //     `rpc` tenía el mismo defecto local ("`ok` means the adapter's own probe answered"),
    //     aunque la enumeración de `probedAt` ya lo marcaba como optimista.
    //     Medido (mismo `tsx` que en (3)): el cuerpo pre-probe con una chain que rechaza
    //     ECONNREFUSED fue `{"chainId":103,...,"rpc":"ok"}` — sin las dos aditivas — y el
    //     post-probe `{...,"rpc":"unreachable","consecutiveFailures":2,"lastFailureKind":
    //     "connection"}`.
    //     `Map` y no indexado por variable: `props[field]` dispara
    //     `security/detect-object-injection` y `npm run lint` corre con `--max-warnings 0`
    //     (mismo footgun que ya está anotado en `T-O11-TREE`).
    const chainItemProps = new Map(
      Object.entries(
        spec.components.schemas.ChainHealthItem!.properties as Record<
          string,
          Record<string, unknown>
        >,
      ),
    );
    for (const field of ['rpc', 'consecutiveFailures', 'lastFailureKind'] as const) {
      expect(
        flat(chainItemProps.get(field)!.description),
        `ChainHealthItem.${field}: sin el descargo del snapshot pre-probe`,
      ).toMatch(/before the first probe completes|no probe has completed yet/i);
    }
    // el que mata la vuelta a la frase falsa concreta.
    expect(
      flat(chainItemProps.get('consecutiveFailures')!.description),
      'consecutiveFailures: su ausencia sigue publicada como prueba de una sonda exitosa',
    ).toMatch(/no probe has completed yet/i);
  });

  it('T-O11-TREE: TODO nodo objeto del subárbol de /health es cerrado (`additionalProperties: false` + `properties` no vacío)', () => {
    // AR MNR-1. `T-O11-DETAIL` chequea `additionalProperties === false` en CUATRO nodos
    // nombrados a mano, así que un QUINTO objeto —un nivel de anidamiento que no existía
    // cuando se escribió ese test— no tiene quién lo mire: el AR lo midió publicando un
    // objeto nuevo opaco y los cuatro gates quedaron verdes. Este assert recorre el
    // subárbol en vez de enumerarlo, así que un objeto ANIDADO nuevo bajo estos tres roots
    // ya no queda sin dueño.
    //
    // ⚠️ DOS PUNTOS CIEGOS MEDIDOS (AR-2 MNR-1), porque el título dice "TODO nodo objeto" y
    // el filtro no lo es:
    //   (a) una bolsa sin `type` ni `properties` — p. ej. `{additionalProperties: true}` —
    //       no entra a `isObjectNode` y pasa en VERDE, aunque sea justamente un objeto
    //       abierto;
    //   (b) `type: ['object', 'null']` tampoco entra, porque la comparación es
    //       `rec.type === 'object'`; y esa forma es legal en 3.1.0, que es la versión que
    //       este documento declara (`openapi: 3.1.0`).
    // Ninguna de las dos formas existe hoy en el documento. Cuando aparezca alguna, este
    // test NO va a avisar: hay que extender el filtro a mano.
    //
    // "Objeto" acá es `type: object` **O** "tiene `properties`": un nodo anidado sin
    // `type` explícito es igual de opaco si no cierra sus claves, y el filtro estrecho
    // (`type === 'object'`) lo dejaría pasar.
    // `Map` y no el objeto crudo: `schemas[name]` con `name` dinámico dispara
    // `security/detect-object-injection` y `npm run lint` corre con `--max-warnings 0`.
    const schemas = new Map(Object.entries(spec.components.schemas));
    const seen = new Set<string>();
    const objectNodes: Array<{ path: string; node: Record<string, unknown> }> = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      const ref = rec.$ref;
      if (typeof ref === 'string') {
        const name = ref.split('/').pop()!;
        if (seen.has(name)) return;
        seen.add(name);
        const target = schemas.get(name);
        // Un `$ref` roto tiene que ser ruidoso, no un subárbol que nadie recorre.
        expect(target, `$ref sin destino: ${ref}`).toBeDefined();
        walk(target, `${path}→${name}`);
        return;
      }
      const isObjectNode = rec.type === 'object' || typeof rec.properties === 'object';
      if (isObjectNode) objectNodes.push({ path, node: rec });
      for (const [key, value] of Object.entries(rec)) {
        if (key === 'description' || key === 'enum' || key === 'required') continue;
        walk(value, `${path}/${key}`);
      }
    };

    for (const root of ['HealthResponse', 'HealthDetail', 'ChainHealthItem'] as const) {
      if (seen.has(root)) continue;
      seen.add(root);
      walk(schemas.get(root), root);
    }

    // El invariante, nodo por nodo. Reemplaza el "12 de 12" de DT-1 (una foto) por algo que
    // se recalcula en cada corrida.
    for (const { path, node } of objectNodes) {
      expect(node.additionalProperties, `${path}: objeto abierto`).toBe(false);
      expect(
        Object.keys((node.properties ?? {}) as object).length,
        `${path}: objeto sin claves declaradas (opaco)`,
      ).toBeGreaterThan(0);
    }

    // Controles anti-vacío: que el recorrido HAYA recorrido. Los dos primeros salen de
    // tablas atadas por `tsc`, no de listas escritas acá, y son los que prueban que el walk
    // entró de verdad (el segundo, además, que siguió el `$ref`).
    //
    // El `>= 5` de abajo NO sale de ninguna tabla: es un PISO escrito a mano, y hoy coincide
    // exactamente con la cuenta del árbol. Medido: 5 nodos — `HealthResponse`, `HealthDetail`
    // (vía `$ref`), `details.redis`, `details.wallet` y `ChainHealthItem` (vía
    // `chains.items.$ref`). O sea que agregar un objeto lo deja igual de verde y sacar uno lo
    // pone rojo: sirve para que el bucle de arriba no pase por vacío, no para fijar la forma
    // del árbol. La forma la fijan los dos `toContain`.
    const keysOf = (n: Record<string, unknown>): string[] =>
      Object.keys((n.properties ?? {}) as object).sort();
    const shapes = objectNodes.map(({ node }) => keysOf(node).join(','));
    expect(shapes).toContain([...HEALTH_RESPONSE_FIELDS].sort().join(','));
    expect(shapes).toContain([...CHAIN_HEALTH_FIELDS].sort().join(',')); // probó que siguió el `$ref`
    expect(objectNodes.length).toBeGreaterThanOrEqual(5);
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
