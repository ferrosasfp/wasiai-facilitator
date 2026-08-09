/**
 * Supported discovery module (WFAC-22).
 *
 * Exposes:
 *   - SupportedResponse: top-level response shape served by GET /supported.
 *   - ChainSupportedItem: one entry per registered chain (network, name, methods,
 *     and EXACTLY ONE of `breakerState` / `breakerStateAbsentReason`).
 *   - BreakerStateAbsentReason: por qué una entrada no trae `breakerState`. Ver el
 *     bloque sobre el tipo — la entrada Solana no lo trae porque ese adaptador no
 *     tiene breaker, y no corresponde que lo tenga.
 *   - CHAIN_METHODS_DEFAULT: module-level FALLBACK, applied only to adapters
 *     that do not declare their own methods. Do NOT read it as "every
 *     registered chain supports eip3009": `getSupportedResponse()` below reads
 *     `ChainMetadata.supportedMethods` (field added by WKH-204) and only falls
 *     back here when that field is absent. Live case: `SolanaAdapter` declares
 *     `spl-token-transfer-finalized` (WKH-323) and never reaches this default.
 *   - DedicatedRouteId: the three opt-in Solana transport routes that are NOT
 *     chain adapters and therefore never appeared in `chains`/`methods`.
 *   - getSupportedResponse(): pure function that maps `chainRegistry.listAdapters()`
 *     to the response shape at request time (DT-3, live snapshot), plus the
 *     dedicated-route ids handed in BY PARAMETER (see the block on the type).
 *
 * Boundaries (OWNERS.md row `src/core/`, DT-4):
 *   - MAY import: `../chains/registry.js` (via registry singleton, allowed
 *     "salvo vía registry"), `../chains/types.js` (type-only).
 *   - MUST NOT import: `../chains/<chain>.js` directly, `../methods/*`,
 *     `../routes/*`, `../infra/*` (pure — no logger, no I/O).
 *
 * Purity (CD-4): no side effects, no logger, no I/O. Same registry state =>
 * same response. `O(N)` over registered adapters (`N < 20` in practice).
 */

import type { ChainMetadata } from '../chains/types.js';
import { chainRegistry } from '../chains/registry.js';

/**
 * Default methods for adapters that do NOT declare their own
 * `ChainMetadata.supportedMethods`. Today that is the EVM adapters, for which
 * `eip3009` is accurate (they settle a signed EIP-3009 authorization).
 *
 * This is not a statement about the whole registry: an adapter that declares
 * its own methods never reaches this default — see `SolanaAdapter`, which
 * declares `spl-token-transfer-finalized` (WKH-323).
 */
export const CHAIN_METHODS_DEFAULT: readonly string[] = ['eip3009'];

/**
 * POR QUÉ `breakerState` NO ESTÁ — el motivo, no el hueco.
 *
 * Hasta acá la ausencia del campo era muda: `solana:devnet` no lo trae y las cuatro
 * entradas `eip155:*` sí, y desde afuera "esta cadena no tiene breaker" se veía
 * IDÉNTICO a "el campo se perdió en el camino" o a "estoy hablando con un facilitator
 * viejo". Son cosas distintas y un consumidor no podía separarlas. Este campo las
 * separa SIN inventar un estado: no dice cómo está el breaker, dice por qué no hay uno
 * que reportar.
 *
 * ⚠️ LO QUE NO SE HIZO Y POR QUÉ: no se agregó `breakerState: 'CLOSED'` a la entrada
 * Solana. El `SolanaAdapter` NO tiene circuit breaker (lo declara su propio header, y
 * no hay ninguna otra ocurrencia de "breaker" en `chains/solana-adapter.ts`): un
 * 'CLOSED' ahí sería un campo verde que nada sostiene.
 *
 * ⚠️ Y NO CORRESPONDE QUE LO TENGA, que es la pregunta de fondo. El breaker envuelve
 * `_verifyRaw`/`_settleRaw` del adaptador EVM (`chains/base-adapter.ts`), donde el
 * facilitator SIMULA y TRANSMITE una autorización EIP-3009 con su propia wallet y paga
 * el gas: abrirlo evita seguir quemando gas contra una cadena que está fallando, y el
 * caller puede irse a otra cadena ANTES de pagar. En el riel Solana de `/verify` +
 * `/settle` el facilitator es TESTIGO, no emisor: lee una tx que el pagador YA
 * transmitió, a commitment `finalized` (está escrito en `chains/types.ts`, WKH-323).
 * No hay gas nuestro que proteger ni transmisión que frenar, y un breaker abierto sólo
 * convertiría una caída de NUESTRO lector en un rechazo de pagos que ya están finales
 * en la cadena — sobre los que el caller no puede "probar otra cadena", porque el pago
 * ya ocurrió. Las rutas Solana que SÍ transmiten (payout/sponsor/release) no son
 * adaptadores, no salen en `/supported`, y tienen sus propios topes y reintentos.
 *
 * INVARIANTE que hace útil todo esto, y es lo único que un consumidor tiene que
 * recordar: en cada entrada está presente EXACTAMENTE UNO de `breakerState` o
 * `breakerStateAbsentReason`. Si no viene ninguno de los dos, la respuesta está
 * incompleta o el facilitator es anterior a este cambio — que es justo lo que antes no
 * se podía distinguir.
 */
export type BreakerStateAbsentReason =
  /** El adaptador no expone `getBreakerState`: esta cadena no tiene breaker (Solana, stubs). */
  | 'NO_BREAKER'
  /** Lo expone y devolvió `undefined`: tiene breaker, está en passthrough (`CB_ENABLED=false`). */
  | 'BREAKER_DISABLED'
  /**
   * El registry no devolvió el adaptador de una metadata que él mismo acaba de listar.
   * Inalcanzable por construcción — `listAdapters()` recorre `_adapters.values()` y el
   * lookup de abajo lee `_adapters.get(networkId)` del MISMO Map, cuya clave es el
   * `networkId` del adaptador guardado (`chains/registry.ts`). Existe porque el tipo no
   * lo garantiza y porque colapsarlo en `NO_BREAKER` sería afirmar "esta cadena no tiene
   * breaker" cuando lo cierto sería "no pude preguntarle". Si aparece en una respuesta,
   * el registry está inconsistente.
   */
  | 'ADAPTER_LOOKUP_FAILED';

export interface ChainSupportedItem {
  readonly network: string;
  readonly name: string;
  readonly methods: readonly string[];
  /**
   * WFAC-41 (AC-9, DT-7) — current circuit breaker state per chain.
   * Omitted (field absent from the JSON) when there is no live state to report;
   * `breakerStateAbsentReason` then says which of the reasons it was.
   * Integrators can branch on `breakerState === 'OPEN'` to try an
   * alternate chain.
   */
  readonly breakerState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /**
   * Presente EXACTAMENTE cuando `breakerState` está ausente. Ver el bloque de arriba.
   * NO es un estado del breaker y no debe tratarse como tal: 'NO_BREAKER' no significa
   * "sano", significa "acá no hay nada que mirar".
   */
  readonly breakerStateAbsentReason?: BreakerStateAbsentReason;
}

/**
 * WKH-342 — id de una ruta de transporte DEDICADA: las tres rutas Solana opt-in que
 * `app.ts` registra bajo su propio gate (`app.ts:411` sponsor, `:416` release,
 * `:422` payout) y que, al no ser adaptadores, nunca aparecieron en `chains` ni en
 * `methods` (está dicho arriba, en el bloque de `BreakerStateAbsentReason`).
 *
 * El id es el par método+path tal cual lo ve un cliente HTTP, no un alias nuestro:
 * `'POST /solana/payout'` corresponde al `app.post('/solana/payout', …)` de
 * `routes/solana-payout.ts:259`. Si alguien cambia el path de la ruta y no este
 * literal, `T-A1` se pone rojo (deriva el valor del router vivo con `hasRoute`, no
 * de esta lista).
 *
 * ⚠️ Lo que este cambio NO es: no es un filtro y no saca ningún string de la
 * respuesta. `/supported` no anunciaba estas rutas de ninguna forma —el único método
 * de la entrada Solana es `spl-token-transfer-finalized` (`chains/solana-adapter.ts`),
 * que es el riel testigo de `/verify`+`/settle` y sí existe—, así que acá no había
 * nada que corregir: hay un campo nuevo donde antes no había información.
 */
export type DedicatedRouteId =
  | 'POST /solana/payout'
  | 'POST /solana/sponsor'
  | 'POST /solana/escrow/release';

export interface SupportedResponse {
  readonly chains: readonly ChainSupportedItem[];
  readonly methods: readonly string[];
  /**
   * WKH-342 — las rutas de `DedicatedRouteId` que ESTA instancia tiene registradas
   * ahora mismo. Siempre presente y siempre un array (posiblemente vacío) en toda
   * respuesta servida por esta versión.
   *
   * LOS TRES DESENLACES que un consumidor puede leer, y son tres, no dos:
   *   - campo ausente del JSON  ⟹ **NO SÉ**. Este facilitator es anterior a WKH-342,
   *     o algo en el medio reescribió la respuesta. NO significa "no tiene la ruta".
   *   - presente y CONTIENE el id ⟹ la ruta está registrada: un POST a ese path no va
   *     a caer en el 404 por defecto de Fastify.
   *   - presente y NO contiene el id ⟹ la ruta NO está registrada. Un `[]` es esta
   *     respuesta, no una ausencia: dice "ninguna de las tres".
   *
   * Por eso el discriminante del lado del consumidor tiene que ser
   * `Array.isArray(body.dedicatedRoutes)` y nunca truthiness ni `.length`: `[]` es
   * falsy y `undefined` también, y son desenlaces opuestos.
   *
   * Lo que el campo NO dice: nada sobre si la ruta va a AUTORIZAR la llamada. Un
   * `'POST /solana/payout'` presente y un 403 por tope diario conviven sin
   * contradicción; esto es existencia del transporte, no permiso.
   */
  readonly dedicatedRoutes: readonly DedicatedRouteId[];
}

/**
 * Build the discovery response from the live chain registry.
 *
 * - `chains`: one entry per registered adapter; `network` is `ChainMetadata.networkId`
 *   ("eip155:<chainId>" on EVM rails, "solana:<cluster>" on the Solana rail since
 *   WKH-205), `name` is `ChainMetadata.name`, and `methods` is the adapter's own
 *   `ChainMetadata.supportedMethods` WHEN it declares one — a copy of
 *   `CHAIN_METHODS_DEFAULT` only when it does not (see the `??` below). WKH-323:
 *   the Solana entry reports `spl-token-transfer-finalized` through that branch.
 * - `methods`: deduped union of every chain's methods array. When there are
 *   zero registered adapters this naturally evaluates to `[]`, satisfying AC-9
 *   (`{ chains: [], methods: [] }`).
 *
 * - `dedicatedRoutes`: copia del argumento, en su orden. NO se deriva del registry:
 *   estas rutas no son adaptadores y su registro depende de un gate que vive en
 *   `infra/solana-payout-operator.ts` — y este módulo tiene PROHIBIDO importar
 *   `infra/*` (ver "Boundaries" arriba). De ahí que la señal entre por parámetro.
 *
 * ⚠️ El parámetro es REQUERIDO a propósito, sin default. Un `= []` haría que un
 * llamador que se olvide de pasarlo publique "ninguna de las tres rutas existe",
 * que es una AFIRMACIÓN NEGATIVA, y el consumidor la leería como definitiva (§ el
 * bloque de `SupportedResponse.dedicatedRoutes`). Requerido convierte ese olvido en
 * un error de compilación. `T-A4` lo fija; la parte de tipos sólo la evalúa
 * `npm run typecheck:tests`, porque el `exclude` de `tsconfig.json` deja afuera todo
 * archivo `.test.ts`.
 *
 * Zero-adapter edge case (AC-9): `adapters = []` => `chains = []` =>
 * `flatMap(...)` yields `[]` => `methods = []`.
 */
export function getSupportedResponse(
  dedicatedRoutes: readonly DedicatedRouteId[],
): SupportedResponse {
  const adapters: readonly ChainMetadata[] = chainRegistry.listAdapters();
  const chains: readonly ChainSupportedItem[] = adapters.map((meta) => {
    // WFAC-41 (DT-7, CD-NEW-CB-SUPPORTED-DUCKTYPE) — ducktype lookup of
    // getBreakerState via registry. chainRegistry.getAdapter returns the
    // adapter instance which MAY expose getBreakerState (KiteAdapter,
    // AvalancheFujiAdapter) or MAY NOT (stubs / future adapters). Spread
    // keeps the field OMITTED when absent — cleaner JSON contract than
    // emitting `undefined`.
    //
    // AR-BLQ-BAJO-1 fix: the adapter's getBreakerState itself may now return
    // `undefined` when CB_ENABLED=false (ChainCircuitBreaker.getState in
    // passthrough mode). `breakerState` stays OMITTED in that case too — an
    // integrator must never see a misleading 'CLOSED' for a chain whose breaker
    // is disabled — but the two absences are NO LONGER indistinguishable from
    // outside: `breakerStateAbsentReason` says which one it was.
    //
    // ⚠️ EL LOOKUP CAMBIÓ DE CLAVE, y sin eso la razón de abajo sería una mentira.
    // Acá se llamaba `chainRegistry.getAdapter(meta.chainId)`, que internamente busca
    // `eip155:${chainId}` (`chains/registry.ts`). Para la entrada Solana
    // (`networkId: 'solana:devnet'`, `chainId` sintético 103) ese lookup NO ENCUENTRA
    // NADA: el campo se omitía porque no se encontró el adaptador, no porque se le
    // hubiera preguntado y no tuviera breaker. O sea que decir 'NO_BREAKER' desde el
    // camino viejo habría sido cierto por afuera y no derivado del código — y además
    // el bug estaba latente: si el adaptador Solana tuviera un breaker, `/supported`
    // tampoco lo habría reportado nunca. `getAdapterByNetworkId(meta.networkId)` es la
    // clave REAL del Map para los dos rieles (`register()` guarda por `networkId`), así
    // que ahora la pregunta se le hace al adaptador de verdad. Para las entradas
    // `eip155:*` devuelve el mismo objeto que antes; lo único que se pierde es el
    // narrowing a `ChainAdapter` (exige `getPublicClient`/`getWalletClient`), que este
    // ducktype no necesita.
    type BreakerGetter = () => 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
    const lookup = chainRegistry.getAdapterByNetworkId(meta.networkId);
    const getter = lookup.ok
      ? (lookup.adapter as { getBreakerState?: BreakerGetter }).getBreakerState
      : undefined;
    const state =
      lookup.ok && typeof getter === 'function' ? getter.call(lookup.adapter) : undefined;
    const absentReason: BreakerStateAbsentReason | undefined =
      state !== undefined
        ? undefined
        : !lookup.ok
          ? 'ADAPTER_LOOKUP_FAILED'
          : typeof getter === 'function'
            ? 'BREAKER_DISABLED'
            : 'NO_BREAKER';
    return {
      network: meta.networkId,
      name: meta.name,
      methods: [...(meta.supportedMethods ?? CHAIN_METHODS_DEFAULT)],
      // Exactamente uno de los dos, siempre: el ternario de arriba deja `absentReason`
      // en `undefined` si y sólo si hay `state`.
      ...(state !== undefined ? { breakerState: state } : {}),
      ...(absentReason !== undefined ? { breakerStateAbsentReason: absentReason } : {}),
    };
  });
  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
  // Copia, no alias: el llamador arma el array por request (`routes/supported.ts`), y
  // un alias haría que una mutación posterior del suyo cambiara una respuesta ya
  // devuelta. La copia mantiene la pureza declarada arriba (mismo argumento => misma
  // respuesta, verificado por T-A4).
  return { chains, methods, dedicatedRoutes: [...dedicatedRoutes] };
}
