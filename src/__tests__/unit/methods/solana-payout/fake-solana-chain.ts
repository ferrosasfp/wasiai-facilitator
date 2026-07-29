/**
 * WKH-302 — the chain double that measures MONEY, not calls.
 *
 * Every payout test asserts on a BALANCE BOOK (`Map<ataBase58, bigint>`), never on
 * `expect(sendRawTransaction).toHaveBeenCalledTimes(1)`. A call counter cannot tell
 * "did not pay" from "paid twice and one reverted"; a book can. `sendRawTransaction`
 * DECODES the transaction and applies the `TransferChecked` to the book, so a tx
 * broadcast twice is applied twice and a double broadcast shows up as a WRONG
 * BALANCE.
 *
 * Canonical money assertion (mandatory in every money test):
 *   expect(chain.balanceOf(agentAta)).toBe(3_000_000n);
 *   expect(chain.balanceOf(operatorAta)).toBe(before - 3_000_000n);
 *
 * Wiring: `cosignAndBroadcast` and the route build their own
 * `new Connection(rpcUrl)`, so each test file mocks `@solana/web3.js` with a tiny
 * inline class delegating to the active `FakeSolanaChain` (the pattern already used
 * by `solana-sponsor.broadcast.test.ts`). The delegation is mechanical because the
 * method names here match `Connection`'s exactly.
 *
 * ALL keys in tests are `Keypair.generate()` — zero real material (CD-4/AC-7).
 */

import { Transaction, type PublicKey } from '@solana/web3.js';
import { deriveAta } from '../../../../chains/solana-escrow.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ATA_CREATE_IDEMPOTENT_TAG,
  SPL_TRANSFER_CHECKED_TAG,
  TOKEN_PROGRAM_ID,
  encodeSignatureBase58,
} from '../../../../methods/solana-payout/payout-shape.js';

/** A token account as the cluster would know it. */
interface TokenAccount {
  readonly owner: string; // base58 wallet that owns the ATA
  readonly mint: string; // base58
  readonly decimals: number;
  amount: bigint;
}

/** Snapshot entry shaped like the RPC `pre/postTokenBalances` element. */
export interface TokenBalanceEntry {
  readonly accountIndex: number;
  readonly owner: string;
  readonly mint: string;
  readonly programId: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

interface RecordedTx {
  readonly err: unknown;
  readonly pre: TokenBalanceEntry[];
  readonly post: TokenBalanceEntry[];
  readonly staticKeys: string[];
}

/** Decoded `TransferChecked` payload. */
interface DecodedTransfer {
  readonly source: string;
  readonly mint: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: bigint;
  readonly decimals: number;
}

/** Decoded ATA `CreateIdempotent` payload. */
interface DecodedAtaCreate {
  readonly ata: string;
  readonly owner: string;
  readonly mint: string;
}

export class FakeSolanaChain {
  /** ATA base58 → token account. THE book. */
  private readonly _accounts = new Map<string, TokenAccount>();
  /** wallet base58 → native lamports. */
  private readonly _lamports = new Map<string, bigint>();
  /** signature base58 → recorded tx (for getTransaction / getParsedTransaction). */
  private readonly _txs = new Map<string, RecordedTx>();

  // Must be REAL base58 that decodes to 32 bytes: `Transaction.recentBlockhash`
  // is decoded on serialize, so a pretty-but-invalid literal fails everything.
  private _blockhash = '11111111111111111111111111111111';
  // Validity is tracked PER HASH, not by one global flag. A single flag would make
  // "the old blockhash died" also kill the FRESH one the retry fetches — which
  // silently turns a re-sign test into an expiry test.
  private _validBlockhashes = new Set<string>(['11111111111111111111111111111111']);

  // ── injectable failure controls ───────────────────────────────────────────
  /** Number of upcoming `sendRawTransaction` calls that throw a transient error. */
  failNextSend = 0;
  /** `confirmTransaction` reports an error even though the tx WAS applied. */
  dropConfirmation = false;
  /** The process "dies" right after signing: send throws and NO money moves. */
  crashAfterSign = false;
  /** Balance reads throw (RPC unavailable) — must NOT be read as funding-low. */
  failBalanceRead = false;
  /**
   * AR BLQ-1 — la sonda de frescura del blockhash falla SÓLO después de que un
   * envío ya salió. Reproduce el caso real que el veredicto "expirado" describía
   * mal: el cluster aceptó la tx y el nodo deja de contestar la sonda, así que el
   * `catch` significa "no pude preguntar" y NO "no se gastó".
   */
  failBlockhashProbeAfterSend = false;
  /**
   * Sólo la CONSULTA de la tx (`getParsedTransaction`) falla. Separado de
   * `failBalanceRead` a propósito: si el pre-check de fondeo también fallara, la
   * request se cortaría antes de enviar nada y el escenario post-envío nunca se
   * alcanzaría.
   */
  failTxLookup = false;
  /**
   * R-3 — guion de la sonda de frescura, consumido en orden por cada llamada a
   * `isBlockhashValid`. Permite alcanzar DETERMINÍSTICAMENTE los cinco puntos de
   * retorno de `broadcastWithRebroadcast` (sonda que tira o blockhash vencido,
   * dentro del bucle y después de él, más el agotamiento de reintentos), que es lo
   * que hace falta para ejercitar la propiedad "si el libro se movió, la respuesta
   * no puede ser un código de no-gasto". Vacío ⇒ comportamiento normal.
   */
  blockhashProbeScript: ('ok' | 'expired' | 'throw')[] = [];
  /**
   * R-1 — el envío APLICA la tx y DESPUÉS tira. Modela lo único que el flag `sent`
   * tiene que capturar: un timeout o un socket caído posteriores a que el nodo ya
   * aceptó la tx y la reenvió al cluster. El agente cobra, y el cliente ve una
   * excepción. Distinto de `failNextSend`, que tira ANTES de aplicar nada.
   */
  throwAfterApplying = false;

  // ── setup helpers ─────────────────────────────────────────────────────────

  /** Register an ATA with a starting balance and return its pubkey. */
  registerAta(owner: PublicKey, mint: PublicKey, decimals: number, amount: bigint): PublicKey {
    const ata = deriveAta(owner, mint);
    this._accounts.set(ata.toBase58(), {
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      decimals,
      amount,
    });
    return ata;
  }

  setLamports(pubkey: PublicKey, lamports: bigint): void {
    this._lamports.set(pubkey.toBase58(), lamports);
  }

  /** THE assertion surface. Unknown ATA ⇒ `null` (distinct from a zero balance). */
  balanceOf(ata: PublicKey | string): bigint | null {
    const key = typeof ata === 'string' ? ata : ata.toBase58();
    return this._accounts.get(key)?.amount ?? null;
  }

  hasAta(ata: PublicKey | string): boolean {
    const key = typeof ata === 'string' ? ata : ata.toBase58();
    return this._accounts.has(key);
  }

  /** Signatures applied to the book, in order. For ordering assertions only. */
  get appliedSignatures(): readonly string[] {
    return [...this._txs.keys()];
  }

  /** Offer `blockhash` as the current one, valid from now on. */
  setBlockhash(blockhash: string): void {
    this._blockhash = blockhash;
    this._validBlockhashes.add(blockhash);
  }

  /**
   * Kill EVERY blockhash, including the current one, and offer nothing fresh:
   * no transaction can land. Models a cluster we cannot get a usable hash from.
   */
  expireBlockhash(): void {
    this._validBlockhashes.clear();
  }

  /**
   * Time passes: every previously issued blockhash dies and the cluster starts
   * offering a NEW, valid one. This is the realistic shape of "the old tx can
   * never land, but a retry can sign a fresh one".
   */
  rotateBlockhash(next: string): void {
    this._validBlockhashes.clear();
    this._blockhash = next;
    this._validBlockhashes.add(next);
  }

  // ── Connection surface ────────────────────────────────────────────────────

  getLatestBlockhash(_commitment?: string): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return Promise.resolve({ blockhash: this._blockhash, lastValidBlockHeight: 1000 });
  }

  isBlockhashValid(blockhash: string): Promise<{ value: boolean }> {
    if (this.blockhashProbeScript.length > 0) {
      const step = this.blockhashProbeScript.shift();
      if (step === 'throw') return Promise.reject(new Error('BLOCKHASH_PROBE_UNAVAILABLE'));
      return Promise.resolve({ value: step === 'ok' });
    }
    if (this.failBlockhashProbeAfterSend && this._txs.size > 0) {
      // Ya hubo al menos un envío aplicado: a partir de acá el nodo no contesta.
      return Promise.reject(new Error('BLOCKHASH_PROBE_UNAVAILABLE'));
    }
    return Promise.resolve({ value: this._validBlockhashes.has(blockhash) });
  }

  getBalance(pubkey: PublicKey): Promise<number> {
    if (this.failBalanceRead) return Promise.reject(new Error('RPC_UNAVAILABLE'));
    return Promise.resolve(Number(this._lamports.get(pubkey.toBase58()) ?? 0n));
  }

  getTokenAccountBalance(
    pubkey: PublicKey,
  ): Promise<{ value: { amount: string; decimals: number; uiAmount: number } }> {
    if (this.failBalanceRead) return Promise.reject(new Error('RPC_UNAVAILABLE'));
    const acc = this._accounts.get(pubkey.toBase58());
    if (acc === undefined) {
      // Matches the real RPC: reading a non-existent token account is an ERROR,
      // not a zero balance. The route must map this to PAYOUT_FUNDING_LOW and
      // must NEVER create the source ATA (AC-8d).
      return Promise.reject(new Error('could not find account'));
    }
    // `uiAmount` is deliberately a LIE (always 0): nothing in the payout path may
    // read it (CD-10). Any code that does will produce an obviously wrong result
    // instead of an almost-right one.
    return Promise.resolve({
      value: { amount: acc.amount.toString(), decimals: acc.decimals, uiAmount: 0 },
    });
  }

  /**
   * Decode the raw tx and APPLY it to the book. A tx sent twice is applied twice —
   * that is the whole point: a double broadcast becomes a wrong balance.
   */
  sendRawTransaction(raw: Uint8Array | Buffer, _opts?: unknown): Promise<string> {
    if (this.crashAfterSign) {
      // The process died between signing and the network accepting the tx: the
      // signature exists (and is persisted, by I2) but NO money moved.
      return Promise.reject(new Error('CRASH_AFTER_SIGN'));
    }
    if (this.failNextSend > 0) {
      this.failNextSend -= 1;
      return Promise.reject(new Error('TRANSIENT_SEND_ERROR'));
    }
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(raw));
    } catch {
      return Promise.reject(new Error('DESERIALIZE_FAILED'));
    }

    // The cluster rejects a tx whose OWN blockhash is dead — checked against the
    // tx's hash, not against a global flag.
    const txBlockhash = tx.recentBlockhash;
    if (txBlockhash === undefined || !this._validBlockhashes.has(txBlockhash)) {
      return Promise.reject(new Error('BLOCKHASH_NOT_FOUND'));
    }

    const sigEntry = tx.signatures.at(0);
    if (sigEntry?.signature === null || sigEntry?.signature === undefined) {
      return Promise.reject(new Error('TX_NOT_SIGNED'));
    }
    const signature = encodeSignatureBase58(Uint8Array.from(sigEntry.signature));

    // FIDELIDAD: re-transmitir la MISMA tx firmada es idempotente en Solana — la
    // red dedupea por firma. Aplicarla de nuevo inventaría plata que en la realidad
    // no se mueve, y hacía que un rebroadcast legítimo (confirmación caída) se
    // leyera como triple pago. El doble pago REAL que estos tests cazan es el de
    // dos txs DISTINTAS (re-firmadas), que sí producen dos firmas y dos efectos.
    if (this._txs.has(signature)) {
      return Promise.resolve(signature);
    }

    const creates: DecodedAtaCreate[] = [];
    const transfers: DecodedTransfer[] = [];
    for (const ix of tx.instructions) {
      const programId = ix.programId.toBase58();
      if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
        const create = decodeAtaCreate(ix.keys, ix.data);
        if (create !== null) creates.push(create);
      } else if (programId === TOKEN_PROGRAM_ID) {
        const transfer = decodeTransferChecked(ix.keys, ix.data);
        if (transfer !== null) transfers.push(transfer);
      }
    }

    // Snapshot BEFORE mutating so pre/postTokenBalances are coherent (verify path).
    const touched = new Set<string>();
    for (const t of transfers) {
      touched.add(t.source);
      touched.add(t.destination);
    }
    const pre = this._snapshot(touched);

    for (const c of creates) {
      if (!this._accounts.has(c.ata)) {
        const decimals = this._decimalsOfMint(c.mint);
        this._accounts.set(c.ata, { owner: c.owner, mint: c.mint, decimals, amount: 0n });
      }
    }

    for (const t of transfers) {
      const src = this._accounts.get(t.source);
      const dst = this._accounts.get(t.destination);
      if (src === undefined) return Promise.reject(new Error('SOURCE_ATA_NOT_FOUND'));
      if (dst === undefined) return Promise.reject(new Error('DESTINATION_ATA_NOT_FOUND'));
      // TransferChecked semantics: the runtime rejects a mint/decimals mismatch.
      if (src.mint !== t.mint || dst.mint !== t.mint) {
        return Promise.reject(new Error('MINT_MISMATCH'));
      }
      if (src.decimals !== t.decimals) return Promise.reject(new Error('DECIMALS_MISMATCH'));
      if (src.amount < t.amount) return Promise.reject(new Error('INSUFFICIENT_FUNDS'));
      src.amount -= t.amount;
      dst.amount += t.amount;
    }

    const post = this._snapshot(touched);
    this._txs.set(signature, {
      err: null,
      pre,
      post,
      staticKeys: tx.instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())),
    });
    if (this.throwAfterApplying) {
      // El nodo YA la tomó (el libro se movió y la firma quedó registrada), pero el
      // cliente ve una excepción. Ése es el caso que `sent` tiene que capturar.
      return Promise.reject(new Error('SOCKET_HANGUP_AFTER_SUBMIT'));
    }
    return Promise.resolve(signature);
  }

  confirmTransaction(
    _signature: string,
    _commitment?: string,
  ): Promise<{
    value: { err: unknown };
  }> {
    if (this.dropConfirmation) {
      return Promise.resolve({ value: { err: 'CONFIRMATION_DROPPED' } });
    }
    return Promise.resolve({ value: { err: null } });
  }

  getParsedTransaction(
    signature: string,
    _opts?: unknown,
  ): Promise<{
    meta: {
      err: unknown;
      preTokenBalances: TokenBalanceEntry[];
      postTokenBalances: TokenBalanceEntry[];
    };
  } | null> {
    if (this.failBalanceRead || this.failTxLookup) {
      return Promise.reject(new Error('RPC_UNAVAILABLE'));
    }
    const rec = this._txs.get(signature);
    if (rec === undefined) return Promise.resolve(null);
    return Promise.resolve({
      meta: { err: rec.err, preTokenBalances: rec.pre, postTokenBalances: rec.post },
    });
  }

  getTransaction(
    signature: string,
    opts?: unknown,
  ): Promise<{
    meta: {
      err: unknown;
      preTokenBalances: TokenBalanceEntry[];
      postTokenBalances: TokenBalanceEntry[];
    };
  } | null> {
    return this.getParsedTransaction(signature, opts);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private _snapshot(atas: ReadonlySet<string>): TokenBalanceEntry[] {
    const out: TokenBalanceEntry[] = [];
    let index = 0;
    for (const ata of atas) {
      const acc = this._accounts.get(ata);
      if (acc === undefined) {
        index += 1;
        continue;
      }
      out.push({
        accountIndex: index,
        owner: acc.owner,
        mint: acc.mint,
        programId: TOKEN_PROGRAM_ID,
        uiTokenAmount: { amount: acc.amount.toString(), decimals: acc.decimals },
      });
      index += 1;
    }
    return out;
  }

  private _decimalsOfMint(mint: string): number {
    for (const acc of this._accounts.values()) {
      if (acc.mint === mint) return acc.decimals;
    }
    return 6;
  }
}

/** Decode a `TransferChecked` (tag 12). Returns null when it is another ix. */
function decodeTransferChecked(
  keys: readonly { pubkey: PublicKey }[],
  data: Buffer,
): DecodedTransfer | null {
  if (data.length < 10 || data.readUInt8(0) !== SPL_TRANSFER_CHECKED_TAG) return null;
  const [source, mint, destination, authority] = keys;
  if (
    source === undefined ||
    mint === undefined ||
    destination === undefined ||
    authority === undefined
  ) {
    return null;
  }
  return {
    source: source.pubkey.toBase58(),
    mint: mint.pubkey.toBase58(),
    destination: destination.pubkey.toBase58(),
    authority: authority.pubkey.toBase58(),
    amount: data.readBigUInt64LE(1),
    decimals: data.readUInt8(9),
  };
}

/** Decode an ATA `CreateIdempotent` (tag 1). Returns null when it is another ix. */
function decodeAtaCreate(
  keys: readonly { pubkey: PublicKey }[],
  data: Buffer,
): DecodedAtaCreate | null {
  if (data.length < 1 || data.readUInt8(0) !== ATA_CREATE_IDEMPOTENT_TAG) return null;
  const [, ata, owner, mint] = keys;
  if (ata === undefined || owner === undefined || mint === undefined) return null;
  return {
    ata: ata.pubkey.toBase58(),
    owner: owner.pubkey.toBase58(),
    mint: mint.pubkey.toBase58(),
  };
}
