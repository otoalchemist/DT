import type { Address, Hex } from "viem";
import { publicClient } from "./chain.js";

// Nonce state for the single hot wallet, held across engine ticks.
//
// In `public`/`local` mode our submitted txs land in the mempool, so
// `getTransactionCount(pending)` reflects them and is the source of truth each
// tick. In `mainnet` mode our txs go out as private Flashbots bundles the mempool
// never sees, so pending can lag what we've actually used — if we blindly re-synced
// to it we'd hand the same nonce to a *different* tx on the next tick and silently
// drop one of them. So in mainnet mode we hold our own reserved ceiling until the
// chain catches up (bundle mined) or the reservation goes stale (bundle dropped).

export type SubmitMode = "public" | "mainnet" | "local";

/** What we signed at a given nonce, so its fate can be looked up instead of guessed. */
interface SignedTx {
  hash: Hex;
  /** Highest block a bundle copy could still be included in. Meaningless for a mirrored
   *  tx, which sits in the mempool with no expiry. */
  lastTargetBlock: bigint;
  /** Also broadcast to the public mempool. A mirrored tx can land in ANY later block, so
   *  block expiry proves nothing about it — only its absence from the mempool does. */
  mirrored: boolean;
}

export class NonceManager {
  private next: number | null = null;
  private reservedCeil: number | null = null; // one past the highest nonce reserved this session
  /**
   * When we last reserved a nonce the chain has not caught up to yet.
   *
   * This — NOT the last time the chain's nonce moved — is what the staleness check below has
   * to measure, and getting it wrong cost a real payment at the epoch-176 boundary. Two fires
   * 2.4s apart both signed nonce 11946: the audit mined, the payment was permanently
   * invalidated, the citizen stayed 2 behind, a rival audited it in the same block, and
   * catching up cost double the taxes.
   *
   * The reason chain movement is the wrong clock: in away mode the engine sleeps between
   * boundaries, so when it wakes the wallet's nonce has been unchanged for hours. Judging our
   * reservation by that made every FIRST reservation of a session instantly "stale", and the
   * second fire of the same boundary reused its nonce. Reservation age has no such coupling —
   * a 2.4s-old reservation reads as 2.4s old no matter how long the wallet sat idle.
   *
   * Still only a BACKSTOP. `evidence()` below decides first, and this catches the cases it
   * cannot speak to: an untracked nonce, or an RPC that will not answer.
   */
  private reservedAtMs = 0;
  // If the chain hasn't advanced past our held reservation for this long, an un-mined bundle
  // has almost certainly been dropped (bundles expire after ~2 blocks), so we release the
  // nonce rather than stick behind a permanent gap. Only consulted when evidence is
  // unavailable — a wall clock cannot tell a dropped bundle from a slow one.
  private static readonly STALE_MS = 90_000;

  /** nonce -> what we signed there. Pruned as the chain advances past each entry. */
  private signed = new Map<number, SignedTx>();

  /**
   * Record what was signed at `nonce`, so a later sync can ask the chain about its fate
   * rather than time it out. Called from flashbots at signing time.
   */
  markSigned(nonce: number, info: SignedTx): void {
    this.signed.set(nonce, info);
  }

  /**
   * Is the transaction the chain is WAITING for still alive?
   *
   * The only nonce that can block us is `onchain` — the next one the account will execute.
   * Everything we hold above it is unreachable until that one resolves, so its fate decides
   * whether the whole held ceiling is real or a permanent gap.
   *
   *   still pending  -> ALIVE. Holding is mandatory: handing this nonce out again is exactly
   *                     the epoch-176 collision, where the second signature invalidated the
   *                     first and a citizen went unpaid.
   *   mined          -> ALIVE. The chain is about to advance past it on its own.
   *   unknown to the node:
   *     mirrored     -> DEAD. It was broadcast, so the node would know it if it existed;
   *                     absence means dropped.
   *     bundle-only  -> DEAD only once its last target block has passed. Before that the
   *                     bundle is simply private — the node has never seen it and never will.
   *
   * Returns null when it cannot tell (untracked nonce, RPC failure), which hands the
   * decision back to the STALE_MS backstop rather than guessing in either direction.
   */
  private async evidence(onchain: number): Promise<"alive" | "dead" | null> {
    const rec = this.signed.get(onchain);
    if (!rec) return null; // nothing signed here by us — nothing to reason about
    let tx: { blockNumber: bigint | null } | null;
    try {
      tx = await publicClient.getTransaction({ hash: rec.hash });
    } catch (err) {
      // viem throws TransactionNotFoundError rather than returning null. That IS the answer
      // we want, but an RPC outage throws too and must not be read as "dead" — so only a
      // not-found is treated as absence, and anything else defers to the backstop.
      if (!/not.*found|could not be found/i.test((err as Error).message)) return null;
      tx = null;
    }
    if (tx) return "alive"; // pending or mined; either way this nonce is genuinely taken
    if (rec.mirrored) return "dead";
    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      return head > rec.lastTargetBlock ? "dead" : "alive";
    } catch {
      return null;
    }
  }

  /** Re-sync at the start of a tick. `mode` decides whether to trust the mempool
   *  (public/local) or hold our own reserved ceiling (mainnet). */
  async sync(address: Address, mode: SubmitMode): Promise<void> {
    const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    const nowMs = Date.now();

    // Anything at or below the chain's next nonce is settled; stop tracking it so the map
    // cannot grow for the life of the process.
    for (const n of [...this.signed.keys()]) if (n < onchain) this.signed.delete(n);

    const holding = mode === "mainnet" && this.reservedCeil !== null && onchain < this.reservedCeil;
    let keep: boolean;
    if (!holding) {
      keep = false;
    } else {
      const verdict = await this.evidence(onchain);
      // Evidence first; the clock only where evidence is silent.
      keep = verdict === "alive" ? true
        : verdict === "dead" ? false
        : nowMs - this.reservedAtMs <= NonceManager.STALE_MS;
    }

    if (keep) {
      // Keep our reserved nonce — the chain just hasn't seen the bundle yet.
      this.next = Math.max(onchain, this.reservedCeil!);
    } else {
      // Chain is the truth: public/local always, or a mainnet reservation we've
      // now released (chain caught up, or it is provably dead). Self-heals a bad gap.
      this.next = onchain;
      this.reservedCeil = null;
      this.signed.clear();
    }
  }

  /** Peek at the next nonce without consuming it (for simulation). */
  peek(): number {
    if (this.next === null) throw new Error("NonceManager.peek called before sync");
    return this.next;
  }

  /** Reserve the next nonce (call only after simulation passes). */
  reserve(): number {
    if (this.next === null) throw new Error("NonceManager.reserve called before sync");
    const n = this.next;
    this.next = n + 1;
    if (this.reservedCeil === null || this.next > this.reservedCeil) {
      this.reservedCeil = this.next;
      // Stamped on every ceiling RAISE, so back-to-back fires in one boundary each refresh
      // the hold. Biased toward holding too long on purpose: an over-held nonce self-heals
      // the moment the chain advances (or after STALE_MS), while an under-held one silently
      // drops a transaction — which is the failure this exists to prevent.
      this.reservedAtMs = Date.now();
    }
    return n;
  }

  /** End-of-tick reset of the working nonce. The reserved ceiling persists so a
   *  mainnet bundle's nonce isn't reused next tick before it mines. */
  reset(): void {
    this.next = null;
  }
}

/**
 * One NonceManager per wallet address.
 *
 * Nonces are strictly per-account, so a single shared manager across several wallets
 * would hand wallet B a nonce derived from wallet A's chain state — the resulting tx is
 * either rejected outright or, worse, silently replaces one of A's pending bundle txs.
 * That failure is invisible until a payment or audit quietly doesn't land, which is why
 * this registry exists rather than a lazily-shared singleton.
 *
 * Keyed on the lowercased address so a checksummed and non-checksummed spelling of the
 * same wallet can never end up with two independent nonce counters.
 */
class NonceRegistry {
  private byAddress = new Map<string, NonceManager>();

  for(address: Address): NonceManager {
    const key = address.toLowerCase();
    let m = this.byAddress.get(key);
    if (!m) {
      m = new NonceManager();
      this.byAddress.set(key, m);
    }
    return m;
  }

  /** Re-sync every wallet we're about to submit from, in parallel. */
  async syncAll(addresses: Address[], mode: SubmitMode): Promise<void> {
    await Promise.all(addresses.map((a) => this.for(a).sync(a, mode)));
  }

  /** End-of-tick reset across every wallet. */
  resetAll(): void {
    for (const m of this.byAddress.values()) m.reset();
  }

  /** Drop state for wallets that are no longer unlocked, so a re-added wallet starts
   *  from chain truth rather than a stale reservation. */
  retain(addresses: Address[]): void {
    const keep = new Set(addresses.map((a) => a.toLowerCase()));
    for (const key of [...this.byAddress.keys()]) {
      if (!keep.has(key)) this.byAddress.delete(key);
    }
  }
}

export const nonces = new NonceRegistry();
