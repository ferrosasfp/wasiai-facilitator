/**
 * GET /supported — facilitator discovery endpoint (WFAC-22).
 *
 * Read-only. No body. No auth. No idempotency (no side effects — CD-4).
 * Consumers (wasiai-v2, wasiai-a2a, third-party integrators) hit this before
 * invoking /verify or /settle to learn which chains and methods are live.
 *
 * Layers (top-down):
 *   1. Measure start time.
 *   2. Resolve the dedicated-route signal against the live router (`app.hasRoute`)
 *      and build the response via `getSupportedResponse(signal)` (pure, reads
 *      chainRegistry; the signal enters by parameter — WKH-342).
 *   3. Emit structured info log (L1) with `request_id`, `chain_count`,
 *      `duration_ms`. No PII (CD-3).
 *   4. Return 200 with an EXPLICIT field-by-field body build (CD-2) —
 *      never `reply.send(response)` directly.
 *
 * Boundary (OWNERS / CD-1):
 *   - MAY import: fastify, ../core/supported.js.
 *   - MUST NOT import: src/chains/* (any), src/methods/* (any),
 *     src/infra/* (any). The route stays pure orchestration + HTTP.
 *
 * HTTP method coverage (AC-6): Fastify's default for unregistered methods on
 * a matched path is 404. We only register `.get('/supported', ...)`; POST/
 * PUT/DELETE/PATCH fall through to the default handler → 404, no side effects.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getSupportedResponse } from '../core/supported.js';
import type { DedicatedRouteId } from '../core/supported.js';

/**
 * WKH-342 — las tres rutas de transporte opt-in, con el método y el path EXACTOS que
 * `app.ts` registra, y el id que se publica por cada una.
 *
 * Las tres, no sólo payout: comparten el mismo mecanismo de invisibilidad —
 * `app.register` bajo un `if` de gate (`app.ts:411`, `:416`, `:422`) y ninguna es un
 * adaptador de cadena, así que ninguna aparecía en `chains` ni en `methods`.
 *
 * ⚠️ Esta tabla NO es la respuesta: es la lista de PREGUNTAS. El valor publicado sale
 * de `app.hasRoute` contra el router vivo (abajo). Hardcodear acá la respuesta —
 * publicar los tres ids sin consultar el router— pone `T-A2` en rojo: ese test levanta
 * la app con el gate de payout NO satisfecho y exige que el id no salga y que un POST
 * al path dé 404.
 *
 * El `method`/`url` de cada fila tiene que coincidir con el `app.post(...)` de la ruta
 * (`routes/solana-payout.ts:259`, `routes/solana-sponsor.ts:216`,
 * `routes/solana-escrow.ts:200`). Si divergen, `hasRoute` devuelve `false` para una
 * ruta que sí está registrada y `T-A1` se pone rojo.
 */
const DEDICATED_ROUTES: readonly {
  readonly id: DedicatedRouteId;
  readonly method: 'POST';
  readonly url: string;
}[] = [
  { id: 'POST /solana/payout', method: 'POST', url: '/solana/payout' },
  { id: 'POST /solana/sponsor', method: 'POST', url: '/solana/sponsor' },
  { id: 'POST /solana/escrow/release', method: 'POST', url: '/solana/escrow/release' },
];

export const supportedRoute: FastifyPluginAsync = async (app) => {
  // WFAC-40 — per-route rate-limit config (DT-6 + DT-13 SDD).
  const env = app.env;
  app.get(
    '/supported',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SUPPORTED_MAX,
          timeWindow: env.RATE_LIMIT_WINDOW_SEC * 1000,
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const requestId = request.id;

      // WKH-342 — la señal se resuelve ACÁ, dentro del handler, y no en el cuerpo del
      // plugin. No es estilo: `app.register(solanaPayoutRoute)` está en `app.ts:423` y
      // `app.register(supportedRoute)` en `:425`, y el registro de plugins es diferido
      // hasta `ready()`. Leer `hasRoute` en el cuerpo del plugin lo evaluaría antes de
      // que la ruta de payout exista en el router y publicaría un falso "no está".
      //
      // `hasRoute` atraviesa la encapsulación del plugin: el `router` de find-my-way es
      // uno solo por servidor (`node_modules/fastify/lib/route.js:175-182` cierra sobre
      // la instancia creada una vez), así que este handler ve rutas registradas en
      // scopes hermanos. T-A2b lo verifica de punta a punta contra la app real (antes de
      // ese test la afirmación era DERIVADA de leer find-my-way, no medida).
      const dedicatedRoutes: readonly DedicatedRouteId[] = DEDICATED_ROUTES.filter((route) =>
        app.hasRoute({ method: route.method, url: route.url }),
      ).map((route) => route.id);

      const response = getSupportedResponse(dedicatedRoutes);

      // L1 — success info log. Authorized fields only: request_id, chain_count,
      // duration_ms (CD-3). No request.ip, no request.headers, no user-agent.
      app.log.info(
        {
          request_id: requestId,
          chain_count: response.chains.length,
          duration_ms: Date.now() - startMs,
        },
        'supported ok',
      );

      // CD-2: explicit field-by-field body build. Even though `response` already
      // has the right shape, a future refactor of SupportedResponse could
      // accidentally leak extra fields if we did `reply.send(response)` directly.
      return reply.code(200).send({
        chains: response.chains,
        methods: response.methods,
        dedicatedRoutes: response.dedicatedRoutes,
      });
    },
  );
};
