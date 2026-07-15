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
  private lastOnchain = -1;
  private lastOnchainChangeMs = 0;
  // If pending hasn't advanced past our held reservation for this long, an
  // un-mined bundle has almost certainly been dropped (bundles expire after ~2
  // blocks), so we release the nonce rather than stick behind a permanent gap.
  private static readonly STALE_MS = 90_000;

  /** Re-sync at the start of a tick. `mode` decides whether to trust the mempool
   *  (public/local) or hold our own reserved ceiling (mainnet). */
  async sync(address: Address, mode: SubmitMode): Promise<void> {
    const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    const nowMs = Date.now();
    if (onchain !== this.lastOnchain) {
      this.lastOnchain = onchain;
      this.lastOnchainChangeMs = nowMs;
    }

    const holding = mode === "mainnet" && this.reservedCeil !== null && onchain < this.reservedCeil;
    if (holding && nowMs - this.lastOnchainChangeMs <= NonceManager.STALE_MS) {
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
    if (this.reservedCeil === null || this.next > this.reservedCeil) this.reservedCeil = this.next;
    return n;
  }

  /** End-of-tick reset of the working nonce. The reserved ceiling persists so a
   *  mainnet bundle's nonce isn't reused next tick before it mines. */
  reset(): void {
    this.next = null;
  }
}

export const nonceManager = new NonceManager();
