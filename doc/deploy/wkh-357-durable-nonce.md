# WKH-357 / HU-064 — despliegue del durable nonce (paso manual)

> **Este documento NO se ejecutó.** El código está en la rama `feat/wkh-357-durable-nonce` y
> **no se desplegó** (CD-2). El flip de la bandera es del founder, nunca del agente.
>
> Escrito el 2026-08-17 contra el commit `d8e8a6f` de esa rama, y **actualizado el mismo día con el
> fix-pack del AR** (§4 tenía tres verificaciones que no detectaban un rechazo del 100%, y §5
> describía una aserción de `n6` que se removió por ese motivo).

---

## 1. Qué se agregó y qué NO cambia

Una sola variable de entorno:

```
SOLANA_SPONSOR_DURABLE_NONCE_ENABLED = false | true      (default: false)
```

Con la bandera en `false`, el comportamiento es el de antes de esta HU **para toda entrada**,
incluida una transacción que traiga un `AdvanceNonceAccount` en la instrucción 0 — que se rechaza.
Eso no es una promesa de prosa: lo miden

- `src/__tests__/unit/solana-sponsor.durable-nonce.test.ts` (el bloque T-20, diferencial
  bandera-prendida contra bandera-apagada sobre 6 formas de tx sin nonce, más la tx con nonce **en
  sus DOS formas**: con y sin `register_escrow`, que rechazan con enums distintos), y
- los **1417** tests de `npm run qa` en verde (eran 1412 antes del fix-pack del AR), de los cuales
  los preexistentes no cambiaron de color al agregar el campo `durableNonceEnabled` a `Cr1Config`.

⛔ **Ningún tope se movió.** `SOLANA_SPONSOR_MAX_COMPUTE_UNITS`,
`SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` y `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` quedan como
están. Si un depósito con nonce no entra en los topes actuales, la respuesta es rediseñar la
transacción, no aflojar el guard.

---

## 2. El ORDEN. No es una preferencia.

```
  1. Desplegar con la bandera en `false`  (o sin setearla: el default es `false`)
  2. Verificar que NADA cambió            (§4)
  3. Recién entonces, prenderla           (§5)
```

**Por qué en ese orden y no al revés**: el paso 1 mete en producción código nuevo en el camino
caliente del patrocinio (`cr1.ts`, `broadcast.ts`, `sponsor-claims.ts`). Con la bandera apagada ese
código está presente pero no se ejecuta, así que el paso 2 mide una cosa distinta y más barata que
el paso 3: que **el despliegue en sí** no rompió nada. Si se prende en el mismo movimiento, un fallo
no se puede atribuir — no se sabe si fue el deploy o la bandera.

### El comando

```bash
# Build y arranque son los del README (§Deployment): proceso Node persistente en Railway.
npm run build && npm start
```

En Railway el despliegue lo dispara el push a la rama configurada; este cambio vive en
`feat/wkh-357-durable-nonce` y **no está mergeado a `main`**, así que hoy no llega a producción por
sí solo.

---

## 3. ⚠️ Prender la bandera SOLA no cambia NADA observable

Esto es lo primero que hay que saber antes de tocarla, porque si no, el paso 3 parece fallido:

| Estado | Qué pasa con un depósito por enlace |
|---|---|
| facilitator con la bandera **apagada**, chaski **sin** el camino por enlace | nada: nadie manda tx con nonce. Es el estado de HOY |
| facilitator con la bandera **prendida**, chaski **sin** el camino por enlace | **nada tampoco**: sigue sin haber quien mande una tx con nonce |
| facilitator con la bandera **apagada**, chaski **con** el camino por enlace | **todo depósito por enlace recibe 403** (`SPONSOR_SENDER_PROOF_INVALID`, marcador `SHORT_DEPOSIT_DATA`) |
| los dos puestos | el depósito por enlace puede cerrar |

⇒ **La feature existe cuando los DOS repos la reconocen.** "La rama del facilitator está lista" no
es "la feature funciona". Y el orden seguro entre repos es **facilitator primero**: prender la
bandera antes de que chaski mande nonces es inofensivo, mientras que lo contrario deja el depósito
por enlace roto con un 403 que apunta al guard equivocado.

---

## 4. Cómo verificar el paso 2 (bandera apagada, nada cambió)

```bash
# a) las rutas siguen registradas — el array sale del router vivo, no de una constante
curl https://wasiai-facilitator-production.up.railway.app/supported
#    esperado: dedicatedRoutes incluye "POST /solana/sponsor"

# b) la ruta responde lo de siempre a un request sin credencial
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://wasiai-facilitator-production.up.railway.app/solana/sponsor
#    esperado: 401 (leído en el README el 2026-08-15 para el deployment de referencia)
```

**c) el log de arranque.** La bandera se anuncia en las DOS ramas, a propósito, para que "no veo el
aviso" signifique "está apagada" y no "no miré bien":

| Bandera | Nivel | Qué buscar en el log |
|---|---|---|
| `false` | `info` | `check: 'CR1_DURABLE_NONCE'`, `value: false` |
| `true` | `warn` | `setting: 'SOLANA_SPONSOR_DURABLE_NONCE_ENABLED'`, `value: true` |

⚠️ **Y ése es el ÚNICO lugar donde el estado de la bandera se ve.** No hay endpoint que lo publique:
`/supported` lista rutas, no banderas, y esta HU no agregó nada ahí. Si el log de arranque no está
disponible, el estado de la bandera **no es observable desde afuera** — lo más cerca que se llega es
inferirlo mandando una tx con nonce y mirando si el rechazo es 403 (apagada) o un 422 con un
marcador `NONCE_*` (prendida), que es un experimento, no una consulta.

### 🔴 QUÉ **NO** PRUEBAN (a), (b) y (c) — leer antes de marcar el paso 2 como hecho

**(a), (b) y (c) verifican el DESPLIEGUE, no la FEATURE.** Los tres siguen dando exactamente lo
mismo si el camino del nonce está **completamente roto**: `/supported` lista rutas, el 401 es de la
auth, y la línea de arranque sólo repite el valor de la variable que uno acaba de setear. Ninguno
ejecuta una sola línea de Check 2n.

Esto no es una precaución teórica, **ya pasó**: la primera versión de esta rama exigía en `n6` que la
authority del nonce fuera **no-writable**, y eso rechaza el **100%** de los depósitos con nonce que
chaski produce (la meta de esa cuenta colapsa a la unión al reconstruir el mensaje, así que en el
cable llega siempre writable). Los 1412 tests estaban en verde, y las tres verificaciones de arriba
también lo habrían estado. El resultado sería: **el founder prende la bandera, ve el `warn`
esperado, y la HU queda declarada viva estando muerta.**

### (d) La sonda que SÍ ejercita el camino del nonce — sin gastar un lamport

La idea es mandar una tx **con la `nonceAdvance` canónica** y un `deposit` deliberadamente inválido
en un check **posterior** a Check 2n. El marcador que aparezca en el log dice si el nonce pasó:

```
tx = [ nonceAdvance(nonce=<cualquier pubkey>, sysvar, authority=<sender>),
       SetComputeUnitLimit(200000), SetComputeUnitPrice(1000),
       deposit(sender, mint=<UN MINT QUE NO ES EL CONFIGURADO>, …) ]
feePayer = <el fee-payer del facilitator>
firmada por <sender>   (un keypair descartable; NO necesita fondos)
POST /solana/sponsor   con una credencial válida
```

| Marcador en el log (`guard`) | Qué significa |
|---|---|
| `MINT_MISMATCH` | ✅ **Check 2n aceptó la `nonceAdvance`.** `n1..n6` completos pasaron — incluida la parte 2 de `n6`, que compara la authority contra `deposit.keys[0]` — y el rechazo vino de Check 4c, mucho después. La feature está viva |
| `NONCE_IX_ACCOUNTS_INVALID` | 🔴 **la clase del BLQ-ALTO.** Check 2n rechazó la forma canónica: con la bandera prendida ningún depósito por enlace va a entrar |
| `PROGRAM_NOT_WHITELISTED` o `NOT_EXACTLY_ONE_BUSINESS_IX` | la bandera está **apagada** en el proceso vivo (ver §6: quizá no reinició). Cuál de los dos depende de si la tx lleva `register_escrow` |
| `SHORT_DEPOSIT_DATA` con un **403** | cortó Guard A, antes de CR-1 ⇒ la bandera está apagada también en el punto de cableado de Guard A |

**Por qué no gasta nada**: los cuatro veredictos son **previos a la co-firma**. Ninguno llega a
`sendRawTransaction`, así que no hay fee ni tx en cadena, y el `deposit` nunca ejecuta. Por eso la
cuenta de nonce puede ser una pubkey cualquiera y el sender puede no tener fondos.

⚠️ **El marcador NO viaja en el body de la respuesta** (CD-12 no-oracle): el cliente ve
`{ error: { code: 'SPONSOR_REJECTED', http: 422 } }` para los tres primeros casos, que son
indistinguibles desde afuera. **Esta sonda requiere acceso al log del servicio**, igual que (c).
Si no hay acceso al log, el paso 2 **no se puede marcar como verificado** para la feature; sólo
para el despliegue.

⚠️ **[NO VERIFICADO]** — esta sonda **no se ejecutó**: requiere una credencial de facilitator y el
log de producción, los dos fuera del alcance del agente. Lo que **sí** está medido es el mapeo
marcador ⇄ significado de la tabla, y está medido offline: es el mismo árbol de decisión que
ejercitan `T-30`, `T-31` y el bloque `T-20` de `solana-sponsor.durable-nonce.test.ts`, con los
fixtures pasando por `Transaction.from` igual que el cable.

---

## 5. Prender la bandera (paso 3 — decisión del founder)

```
SOLANA_SPONSOR_DURABLE_NONCE_ENABLED = true
```

Qué habilita, exactamente:

- CR-1 deja de rechazar una tx cuya instrucción 0 es un `AdvanceNonceAccount` y la valida contra una
  forma pinneada (Check 2n, `n1..n6`): posición 0 absoluta, `data` de exactamente 4 bytes `[4,0,0,0]`,
  exactamente 3 cuentas, el sysvar correcto, la cuenta de nonce writable y no-signer, y la
  **authority signer y `.equals(deposit.keys[0])`** — el mismo sender del depósito.

  ⛔ **La authority NO se exige no-writable, y eso es deliberado.** En un mensaje legacy las
  banderas son del MENSAJE, no de cada instrucción, así que al reconstruirlo la meta de cada pubkey
  colapsa a la UNIÓN sobre todas las ix. La authority ES el sender, y el `deposit` lo marca
  signer+writable, con lo cual la authority llega writable **siempre**. Exigirla no-writable
  rechazaba el 100% de los depósitos con nonce; es lo que corrigió el fix-pack del AR y lo que
  clava `T-30`.
- `extractSponsorClaims` (Guard A) saltea esa instrucción para localizar el `deposit`.
- Las 3 sondas de frescura de blockhash se saltean **sólo** para esas tx.

Qué **no** habilita:

- ⛔ No talla ninguna excepción en Check 5: el fee-payer sigue sin poder estar referenciado por
  **ninguna** instrucción, la del nonce incluida. Es lo que fuerza que la authority del nonce sea el
  remitente y **no** el facilitator, y `T-14` lo clava con una tx cuyo fee-payer aparece **sólo** en
  la instrucción del nonce.

  ⚠️ Con una precisión que `T-14` ahora deja escrita: ese vector vive **en memoria**, porque en el
  cable es inalcanzable. El fee-payer es `accountKeys[0]`, o sea signer siempre, así que si se lo
  pone como cuenta de nonce la unión de metas lo devuelve `isSigner: true` y lo rechaza **`n5`**
  (`NONCE_IX_ACCOUNTS_INVALID`) antes de que Check 5 lo vea. Los dos caminos son fail-closed y
  ninguno firma; lo que cambia es el marcador del log. El vector se conserva en memoria porque es
  el único que muere si alguien cambia `instructions` por `businessIx` en el bucle de Check 5.
- ⛔ No sube ningún tope.
- ⛔ No acepta nada que se desvíe de la forma pinneada: todo desvío es un rechazo fail-closed con su
  propio marcador.

---

## 6. Cómo volver atrás

```
SOLANA_SPONSOR_DURABLE_NONCE_ENABLED = false
```

y volver a desplegar. El camino de vuelta es completo y sin migración: la bandera no persiste nada,
no toca la base y no cambia ninguna forma de request. Un depósito con nonce que estuviera en vuelo
recibe un 403 y **no se co-firma ni gasta gas** (el rechazo de Guard A es previo a la firma).

### ⚠️ ¿Alcanza con cambiar la variable, o hay que forzar el deploy?

**[NO VERIFICADO]** — y es deliberado no adivinarlo.

- **Motivo por el que no lo verifiqué**: requiere observar el comportamiento del dashboard/CLI de
  Railway sobre este servicio, que es una acción sobre producción. No tengo acceso al proyecto de
  Railway desde acá, y el repo no documenta el comportamiento en ninguna parte (`README.md`
  §Deployment sólo dice "proceso Node persistente en Railway").
- **Por qué NO asumir que alcanza**: en este mismo ecosistema hay un caso registrado en el que
  setear la variable **no bastó** y hubo que forzar el despliegue para que el proceso la tomara
  (el settle-guard de Cobraya). Como acá la bandera se lee **una sola vez en el arranque**
  (`parseEnv` → `app.env`, y el log del §4.c se emite al registrar la ruta), un proceso que no
  reinició **sigue con el valor viejo aunque la variable ya diga otra cosa**.
- **La sonda que lo resuelve, para quien tenga el acceso**: cambiar la variable y **sin** forzar
  nada, buscar en el log una línea de arranque NUEVA con el `check: 'CR1_DURABLE_NONCE'` y su
  `value` esperado. Si no aparece una línea nueva, el proceso no reinició y la bandera **no** está
  aplicada. Ésa es la precondición a medir, no la consecuencia.

---

## 7. Lo que este documento NO cubre

- **El lado de chaski-v3.** Sin su camino por enlace desplegado, prender esto no produce ningún
  depósito con nonce (§3).
- **La creación de la cuenta de nonce.** No es de esta HU: hasta que exista, un remitente por enlace
  corta con `deeplink_nonce_ausente` **sin firmar ni borrar nada**. El facilitator no participa de
  esa creación y **no puede patrocinarla** (`createAccountWithSeed` + `nonceInitialize` caerían en
  `businessIx`, que está capado en 1 o 2, y ensanchar eso es exactamente la superficie que Check 5
  existe para no tener).
- **Cualquier afirmación sobre un teléfono real.** No se probó en un dispositivo.
