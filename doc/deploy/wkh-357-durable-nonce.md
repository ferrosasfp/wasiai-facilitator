# WKH-357 / HU-064 — despliegue del durable nonce (paso manual)

> **Este documento NO se ejecutó.** El código está en la rama `feat/wkh-357-durable-nonce` y
> **no se desplegó** (CD-2). El flip de la bandera es del founder, nunca del agente.
>
> Escrito el 2026-08-17 contra el commit `d8e8a6f` de esa rama.

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
  bandera-prendida contra bandera-apagada sobre 6 formas de tx sin nonce, más la tx con nonce), y
- los **1412** tests de `npm run qa` en verde, de los cuales los preexistentes no cambiaron de
  color al agregar el campo `durableNonceEnabled` a `Cr1Config`.

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

---

## 5. Prender la bandera (paso 3 — decisión del founder)

```
SOLANA_SPONSOR_DURABLE_NONCE_ENABLED = true
```

Qué habilita, exactamente:

- CR-1 deja de rechazar una tx cuya instrucción 0 es un `AdvanceNonceAccount` y la valida contra una
  forma pinneada (Check 2n, `n1..n6`): posición 0 absoluta, `data` de exactamente 4 bytes `[4,0,0,0]`,
  exactamente 3 cuentas, el sysvar correcto, la cuenta de nonce writable y no-signer, y la
  **authority signer, no-writable y `.equals(deposit.keys[0])`** — el mismo sender del depósito.
- `extractSponsorClaims` (Guard A) saltea esa instrucción para localizar el `deposit`.
- Las 3 sondas de frescura de blockhash se saltean **sólo** para esas tx.

Qué **no** habilita:

- ⛔ No talla ninguna excepción en Check 5: el fee-payer sigue sin poder estar referenciado por
  **ninguna** instrucción, la del nonce incluida. Es lo que fuerza que la authority del nonce sea el
  remitente y **no** el facilitator, y `T-14` lo clava con una tx cuyo fee-payer aparece **sólo** en
  la instrucción del nonce.
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
