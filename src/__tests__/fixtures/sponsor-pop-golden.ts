/* eslint-disable no-secrets/no-secrets -- todos los literales base58 de este archivo son datos
   PÚBLICOS de test: un pubkey derivado de una seed publicada acá mismo (1..32), dos firmas ed25519
   sobre un mensaje que también está escrito acá, y el mint USDC devnet de Circle. Ninguno es un
   secreto: la seed está a la vista justamente para que cualquiera pueda regenerar el vector. */

/**
 * SDD 037 — VECTOR GOLDEN del mensaje canónico de patrocinio (AC-9, CD-7/CD-9).
 *
 * Este archivo existe para matar UN mutante concreto (M10): cambiar un byte del
 * builder **de un solo repo** — por ejemplo `network:` → `Network:`. Un mutante
 * así no rompe nada localmente (el repo mutado sigue siendo internamente
 * coherente) y sólo se manifiesta cuando una billetera real firma de un lado y
 * un servidor real verifica del otro. En producción eso se ve como "el
 * patrocinio dejó de andar", sin ninguna pista de dónde mirar.
 *
 * ⚠️ ESTE ARCHIVO ESTÁ DUPLICADO A PROPÓSITO. Su gemelo es
 * `chaski-v3/src/test-support/sponsor-pop-golden.ts` y tiene el MISMO contenido
 * byte a byte. La duplicación no es un descuido: son dos repos que no comparten
 * paquete, y un vector compartido por import dejaría de detectar la divergencia
 * que vino a detectar.
 *
 * ⚠️ `expectedMessage` es un LITERAL escrito a mano (CD-9). PROHIBIDO
 * reemplazarlo por una llamada a `buildSponsorPopMessage`: esa aserción se mueve
 * junto con el mutante y pasa siempre.
 *
 * Cómo se regenera (si alguna vez hay que cambiar el contrato del mensaje):
 *   1. `Keypair.fromSeed(Uint8Array.from([1,2,...,32]))` ⇒ `senderBase58`.
 *   2. `bs58.encode(new Uint8Array(64).fill(7))` ⇒ `txSignatureB58`.
 *   3. armar `expectedMessage` a mano según el §5 del Story File.
 *   4. firmar ese string utf8 con la key de (1) ⇒ `expectedSignature` en base58.
 *   5. pegar el resultado ACÁ y en el gemelo de chaski, y correr `T-G1` en los dos repos.
 */
export const GOLDEN = {
  /** `Keypair.fromSeed(Uint8Array.from([1..32])).publicKey.toBase58()`. */
  senderBase58: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',

  /** Los 32 bytes de seed, publicados para que el vector sea reproducible. */
  senderSeed: [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ] as const,

  networkId: 'solana:devnet',
  remittanceId: 'rem_037_golden',
  amountMinor: '10000000',

  /** USDC devnet de Circle (`chaski-v3/src/infrastructure/chain.ts:19`). */
  mintBase58: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',

  /** `bs58.encode(new Uint8Array(64).fill(7))` — una firma de tx sintética y reconocible. */
  txSignatureB58:
    '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8',

  /** LITERAL. 7 líneas, `\n` entre ellas, SIN newline final. */
  expectedMessage:
    'WasiAI Sponsor Request v1\n' +
    'sender: 9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj\n' +
    'network: solana:devnet\n' +
    'remittance: rem_037_golden\n' +
    'amount: 10000000\n' +
    'mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU\n' +
    'tx: 99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8',

  /** LITERAL. ed25519(seed 1..32, utf8(expectedMessage)) en base58. */
  expectedSignature:
    '2myRnASfTTyxx8ogA4BfLJLo5fK4cUaLVqgPoBE1oW64dVw2UEQpDdvo2Suxr2wVfjbweVT9HV8XbM8pFbctvuXQ',
} as const;
