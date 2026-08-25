import type { Address } from "viem";
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
   */
  private reservedAtMs = 0;
  // If the chain hasn't advanced past our held reservation for this long, an un-mined bundle
  // has almost certainly been dropped (bundles expire after ~2 blocks), so we release the
  // nonce rather than stick behind a permanent gap.
  private static readonly STALE_MS = 90_000;

  /** Re-sync at the start of a tick. `mode` decides whether to trust the mempool
   *  (public/local) or hold our own reserved ceiling (mainnet). */
  async sync(address: Address, mode: SubmitMode): Promise<void> {
    const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    const nowMs = Date.now();

    const holding = mode === "mainnet" && this.reservedCeil !== null && onchain < this.reservedCeil;
    // Age of OUR reservation, not of the chain's last move — see reservedAtMs.
    if (holding && nowMs - this.reservedAtMs <= NonceManager.STALE_MS) {
      // Keep our reserved nonce — the chain just hasn't seen the bundle yet.
      this.next = Math.max(onchain, this.reservedCeil!);
    } else {
      // Chain is the truth: public/local always, or a mainnet reservation we've
      // now released (chain caught up, or it went stale). Self-heals a bad gap.
      this.next = onchain;
      this.reservedCeil = null;
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
