/**
 * Derivación de la forma de `/health` para los guards del contrato publicado (WKH-344).
 *
 * POR QUÉ ESTE ARCHIVO EXISTE, y por qué NO es un `*.test.ts`:
 * `tsconfig.json:20` excluye `**\/*.test.ts`, así que una afirmación de tipos escrita dentro
 * de un test NO la evalúa `npm run typecheck` (sólo `npm run typecheck:tests`). Las tablas de
 * abajo son el guard: si `HealthResponse` gana un campo y nadie agrega su fila, TS2741 rompe
 * `npm run typecheck`, que es un gate no-test. Verificado con `tsc --noEmit --listFiles`:
 * los archivos no-`*.test.ts` de `src/__tests__/` SÍ entran.
 *
 * CONSECUENCIA DECLARADA: por estar bajo `src/`, este archivo se emite a `dist/` en
 * `npm run build` (igual que `src/__tests__/fixtures/sponsor-pop-golden.ts`) e importa
 * devDependencies. Nada de `src/` que no sea un test debe importarlo.
 */
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { load as yamlLoad } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthResponse } from '../../routes/health.js';
import type { ChainHealth, HealthStatusDetail } from '../../core/health-status.js';

// ─── (a) tablas exhaustivas, atadas por `npm run typecheck` ─────────────────
//
// El patrón es el de `DEDICATED_ROUTE_PROBES` (`src/routes/supported.ts:58-67`): un
// `Record` SOBRE EL UNION de claves, no un array. Falta una fila → TS2741, no compila.
// Mutante de una línea que lo desarma, y esta HU NO lo cierra (R-2): `Partial<Record<…>>`.

const HEALTH_RESPONSE_FIELD_SET: Readonly<Record<keyof HealthResponse, true>> = {
  status: true,
  degraded: true,
  version: true,
  uptime: true,
  timestamp: true,
  details: true,
};

/** Las 6 claves que `GET /health` emite, derivadas del tipo `HealthResponse`. */
export const HEALTH_RESPONSE_FIELDS = Object.keys(HEALTH_RESPONSE_FIELD_SET) as ReadonlyArray<
  keyof HealthResponse
>;

const HEALTH_DETAIL_FIELD_SET: Readonly<Record<keyof HealthStatusDetail, true>> = {
  degraded: true,
  redis: true,
  wallet: true,
  chains: true,
  probedAt: true,
};

/** Las 5 claves de `details`, derivadas del tipo `HealthStatusDetail`. */
export const HEALTH_DETAIL_FIELDS = Object.keys(HEALTH_DETAIL_FIELD_SET) as ReadonlyArray<
  keyof HealthStatusDetail
>;

const HEALTH_DETAIL_REDIS_FIELD_SET: Readonly<Record<keyof HealthStatusDetail['redis'], true>> = {
  configured: true,
  status: true,
};

/** Claves de `details.redis` (tipo inline anónimo en TS, inline en el schema). */
export const HEALTH_DETAIL_REDIS_FIELDS = Object.keys(
  HEALTH_DETAIL_REDIS_FIELD_SET,
) as ReadonlyArray<keyof HealthStatusDetail['redis']>;

const HEALTH_DETAIL_WALLET_FIELD_SET: Readonly<Record<keyof HealthStatusDetail['wallet'], true>> = {
  present: true,
};

/** Claves de `details.wallet`. Es un booleano de presencia: nunca lleva el valor. */
export const HEALTH_DETAIL_WALLET_FIELDS = Object.keys(
  HEALTH_DETAIL_WALLET_FIELD_SET,
) as ReadonlyArray<keyof HealthStatusDetail['wallet']>;

// ⚠️ `keyof ChainHealth` INCLUYE las opcionales, y `Record` las vuelve obligatorias: las 6
//    filas son necesarias. Las opcionales se separan abajo, derivadas de la opcionalidad.
const CHAIN_HEALTH_FIELD_SET: Readonly<Record<keyof ChainHealth, true>> = {
  chainId: true,
  name: true,
  network: true,
  rpc: true,
  consecutiveFailures: true,
  lastFailureKind: true,
};

/** Las 6 claves declaradas por `ChainHealth`, opcionales incluidas. */
export const CHAIN_HEALTH_FIELDS = Object.keys(CHAIN_HEALTH_FIELD_SET) as ReadonlyArray<
  keyof ChainHealth
>;

// ─── (b) las opcionales, DERIVADAS de la opcionalidad del tipo ──────────────
//
// Sin esto, la lista de claves de una entrada SANA volvería a escribirse a mano (L-5),
// que es la clase de defecto que esta HU corrige un nivel más arriba.

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

const CHAIN_HEALTH_OPTIONAL_FIELD_SET: Readonly<Record<OptionalKeys<ChainHealth>, true>> = {
  consecutiveFailures: true,
  lastFailureKind: true,
};

/** Las claves ADITIVAS: presentes sólo cuando la última sonda de esa chain falló. */
export const CHAIN_HEALTH_OPTIONAL_FIELDS = Object.keys(
  CHAIN_HEALTH_OPTIONAL_FIELD_SET,
) as ReadonlyArray<keyof ChainHealth>;

/** Las claves que una entrada SANA trae siempre. Es lo que `required` del schema debe declarar. */
export const CHAIN_HEALTH_REQUIRED_FIELDS = CHAIN_HEALTH_FIELDS.filter(
  (f) => !(CHAIN_HEALTH_OPTIONAL_FIELDS as readonly string[]).includes(f),
);

/**
 * Control de la maquinaria, no del schema: si `OptionalKeys` deja de clasificar bien (devuelve
 * `never`, o devuelve TODAS las claves), esto rompe `npm run typecheck` con TS2322.
 * Que se ponga rojo al agregar una 3ª opcional es DELIBERADO: publicar un campo opcional nuevo
 * tiene que forzar una decisión humana, no colarse.
 */
type _AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _OPTIONAL_KEYS_OK: _AssertEq<
  OptionalKeys<ChainHealth>,
  'consecutiveFailures' | 'lastFailureKind'
> = true;
void _OPTIONAL_KEYS_OK;

// ─── (c) el spec publicado y los validadores ajv ────────────────────────────

/** La porción del documento OpenAPI que estos guards leen. */
export interface OpenApiDoc {
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly schemas: Record<string, Record<string, unknown>>;
  };
}

/**
 * Carga `doc/openapi.yaml` con **js-yaml** (CD-6): es el parser que corre en producción
 * (`src/routes/openapi.ts:33`, `:50`), así que un YAML que este loader rechaza es un YAML
 * que tira el arranque del servicio.
 *
 * Los `../../../` son tres niveles: desde `src/__tests__/helpers/` hasta la raíz del paquete.
 */
export function loadOpenApiSpec(): OpenApiDoc {
  const specPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../doc/openapi.yaml');
  return yamlLoad(readFileSync(specPath, 'utf-8')) as OpenApiDoc;
}

function schemaOf(spec: OpenApiDoc, name: 'HealthResponse' | 'HealthDetail' | 'ChainHealthItem') {
  const schemas = spec.components.schemas;
  const schema =
    name === 'HealthResponse'
      ? schemas.HealthResponse
      : name === 'HealthDetail'
        ? schemas.HealthDetail
        : schemas.ChainHealthItem;
  // Un componente ausente tiene que ser un error ruidoso, no un validador vacío que
  // aprueba cualquier cuerpo (ése sería un falso verde, el defecto de esta HU).
  if (!schema) throw new Error(`doc/openapi.yaml: falta components.schemas.${name}`);
  return schema;
}

/**
 * ajv 8 con `ajv-formats`.
 *
 * - `strict: false` es necesario: el documento trae keywords que no son de JSON Schema.
 * - `ajv-formats` NO es opcional: sin él ajv ignora `format: date-time` con un warning y
 *   nadie valida el `timestamp` publicado.
 * - EL INTEROP, MEDIDO, NO SUPUESTO: las dos librerías son CJS y este paquete es
 *   `"type": "module"`. Sobre la 8.18.0 / 3.0.1 instaladas, `module.exports` ES la función
 *   (constructora / plugin) y ADEMÁS lleva `.default` (`__esModule: true`). Bajo
 *   `module: Node16` TS tipa el default import como el NAMESPACE del módulo CJS, no como la
 *   clase: `import Ajv from 'ajv'; new Ajv()` no compila (TS2351, "has no construct
 *   signatures"). Por eso se toma `.default`, que es lo correcto para el tipo y lo que existe
 *   en runtime en los dos interops (Node y vitest/esbuild). Gates que lo evalúan:
 *   `npm run typecheck` el tipo, `npm test` el runtime.
 * - La clave de `addSchema` ES el puntero literal del `$ref` del documento.
 */
function makeAjv(spec: OpenApiDoc): InstanceType<typeof AjvModule.default> {
  const Ajv = AjvModule.default;
  const addFormats = addFormatsModule.default;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schemaOf(spec, 'ChainHealthItem'), '#/components/schemas/ChainHealthItem');
  ajv.addSchema(schemaOf(spec, 'HealthDetail'), '#/components/schemas/HealthDetail');
  return ajv;
}

/** Validador del cuerpo completo de `GET /health` contra el `HealthResponse` publicado. */
export function compileHealthResponseValidator(spec: OpenApiDoc): ValidateFunction {
  return makeAjv(spec).compile(schemaOf(spec, 'HealthResponse'));
}

/** Validador del subárbol `details` contra el `HealthDetail` publicado. */
export function compileHealthDetailValidator(spec: OpenApiDoc): ValidateFunction {
  return makeAjv(spec).compile(schemaOf(spec, 'HealthDetail'));
}
