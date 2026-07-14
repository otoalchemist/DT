import type { Address } from "viem";
import { publicClient } from "./chain.js";

// Nonce manager for the single hot wallet. Defense and offense txs are built
// sequentially in one engine tick, so we hand out monotonically increasing
// nonces from a locally-tracked value, re-syncing to chain each tick.

class NonceManager {
  private next: number | null = null;

  /** Re-sync to the pending nonce on chain. Call once at the start of a tick. */
  async sync(address: Address): Promise<void> {
    const onchain = await publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
    // Never move backwards within a tick if we already reserved higher.
    this.next = this.next === null ? onchain : Math.max(this.next, onchain);
  }

  /** Peek at the next nonce without consuming it (for simulation). */
  peek(): number {
    if (this.next === null) throw new Error("NonceManager.peek called before sync");
    return this.next;
  }

  /** Reserve the next nonce (call only after simulation passes). */
  reserve(): number {
    if (this.next === null) {
      throw new Error("NonceManager.reserve called before sync");
    }
    const n = this.next;
    this.next += 1;
    return n;
  }

  reset(): void {
    this.next = null;
  }
}

export const nonceManager = new NonceManager();
