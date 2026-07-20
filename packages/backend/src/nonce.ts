import type { Address, Hex } from "viem";
import { publicClient } from "./chain.js";

export type SubmitMode = "public" | "mainnet" | "local";
export type NonceDeliveryState = "prepared" | "accepted" | "rejected" | "ambiguous";

export interface NonceFlightSnapshot {
  nonce: number;
  txHash?: Hex;
  state: NonceDeliveryState;
  publicExposure: boolean;
  maxPrivateTargetBlock?: bigint;
  retainBeyondPrivateTarget?: boolean;
  /** Durable journal observation metadata. The allocator may advance
   * immediately, but never uses number-only sync to declare this snapshot
   * terminal. */
  observedConsumedAtBlock?: bigint;
}

interface NonceFlight extends NonceFlightSnapshot {
  replacement: boolean;
}

/**
 * Account-scoped nonce allocator. It deliberately has no time-based expiry:
 * public/ambiguous transactions can remain live in a remote txpool for hours.
 * A private-only flight is released only when the chain has passed its explicit
 * final target block. Definite pre-dispatch failures are released explicitly.
 */
export class NonceManager {
  private address: Address | null = null;
  private next: number | null = null;
  private lastConfirmed = -1;
  private lastPending = -1;
  private invisibleReservation = false;
  private readonly flights = new Map<number, NonceFlight>();
  private recoveryHook?: (
    address: Address,
    confirmedNonce: number,
    pendingNonce: number,
    currentBlock?: bigint,
  ) => Promise<readonly NonceFlightSnapshot[]>;
  private recoveredAddress: string | null = null;

  setRecoveryHook(
    hook: (
      address: Address,
      confirmedNonce: number,
      pendingNonce: number,
      currentBlock?: bigint,
    ) => Promise<readonly NonceFlightSnapshot[]>,
  ): void {
    this.recoveryHook = hook;
  }

  async sync(address: Address, _mode: SubmitMode): Promise<void> {
    if (this.address !== null && this.address.toLowerCase() !== address.toLowerCase()) {
      this.clearAccountState();
    }
    this.address = address;
    const getBlockNumber = (publicClient as unknown as { getBlockNumber?: () => Promise<bigint> }).getBlockNumber;
    const currentBlock = getBlockNumber ? await getBlockNumber.call(publicClient) : undefined;
    const [confirmedNonce, pendingNonce] = await Promise.all([
      currentBlock === undefined
        ? publicClient.getTransactionCount({ address, blockTag: "latest" })
        : publicClient.getTransactionCount({ address, blockNumber: currentBlock }),
      publicClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    const effectivePendingNonce = Math.max(confirmedNonce, pendingNonce);
    this.lastConfirmed = confirmedNonce;
    this.lastPending = effectivePendingNonce;
    const normalizedAddress = address.toLowerCase();
    if (this.recoveryHook && this.recoveredAddress !== normalizedAddress) {
      const recovered = await this.recoveryHook(address, confirmedNonce, effectivePendingNonce, currentBlock);
      for (const snapshot of recovered) this.restoreFlight(snapshot);
      this.recoveredAddress = normalizedAddress;
    }

    for (const [nonce, flight] of this.flights) {
      // Number-based nonce sync is allocation evidence, not canonical finality.
      // Keep every consumed snapshot in memory: it is ignored while confirmed is
      // above it, but becomes an immediate reservation fence if the nonce regresses.
      // Only the hash-bound durable journal is allowed to discard the raw flight.
      if (nonce >= confirmedNonce) delete flight.observedConsumedAtBlock;
    }

    const expirable = [...this.flights.values()].filter(
      (flight) => flight.nonce >= confirmedNonce
        && flight.observedConsumedAtBlock === undefined
        && !flight.publicExposure
        && !flight.retainBeyondPrivateTarget
        && flight.maxPrivateTargetBlock !== undefined,
    );
    if (expirable.length > 0) {
      if (currentBlock !== undefined) {
        const expiredCandidates = expirable.filter(
          (flight) => currentBlock > flight.maxPrivateTargetBlock!,
        );
        const expiredNonces = new Set(expiredCandidates.map((flight) => flight.nonce));
        const highestStillLiveNonce = [...this.flights.values()].reduce((highest, flight) =>
          !expiredNonces.has(flight.nonce) && flight.nonce > highest
            ? flight.nonce
            : highest, -1);
        for (const flight of expiredCandidates) {
          // Match durable-journal reconciliation: an expired private lower
          // nonce remains a gap fence while any higher flight is still live.
          // Otherwise sync could discard the recovered lower snapshot even
          // though strategy still needs to replace/fill it before the suffix.
          if (highestStillLiveNonce <= flight.nonce) this.flights.delete(flight.nonce);
        }
      }
    }

    const ceiling = this.reservationCeiling();
    this.next = Math.max(effectivePendingNonce, ceiling);
    this.invisibleReservation = [...this.flights.values()].some(
      (flight) => flight.nonce >= confirmedNonce
        && (!flight.publicExposure || flight.nonce >= effectivePendingNonce),
    );
  }

  peek(): number {
    if (this.next === null) throw new Error("NonceManager.peek called before sync");
    return this.next;
  }

  reserve(): number {
    if (this.next === null) throw new Error("NonceManager.reserve called before sync");
    if (this.invisibleReservation) {
      throw new Error("NonceManager.reserve blocked by an unresolved nonce flight");
    }
    const nonce = this.next++;
    this.flights.set(nonce, {
      nonce,
      state: "prepared",
      publicExposure: false,
      replacement: false,
    });
    return nonce;
  }

  ensureNextAbove(nonce: number): void {
    if (this.next === null) throw new Error("NonceManager.ensureNextAbove called before sync");
    if (this.next <= nonce) this.next = nonce + 1;
    const existing = this.flights.get(nonce);
    if (!existing) {
      this.flights.set(nonce, {
        nonce,
        state: "prepared",
        publicExposure: false,
        replacement: true,
      });
    }
  }

  /** Record delivery immediately; ambiguous/private-only states fence this tick. */
  markDelivery(
    nonce: number,
    state: NonceDeliveryState,
    options: {
      txHash?: Hex;
      publicExposure?: boolean;
      maxPrivateTargetBlock?: bigint;
      retainRejectedFence?: boolean;
      retainBeyondPrivateTarget?: boolean;
    } = {},
  ): void {
    const existing = this.flights.get(nonce) ?? {
      nonce,
      state: "prepared" as const,
      publicExposure: false,
      replacement: true,
    };
    const flight: NonceFlight = {
      ...existing,
      state,
      txHash: options.txHash ?? existing.txHash,
      publicExposure: options.publicExposure ?? existing.publicExposure,
      maxPrivateTargetBlock: options.maxPrivateTargetBlock ?? existing.maxPrivateTargetBlock,
      retainBeyondPrivateTarget: options.retainBeyondPrivateTarget
        ?? existing.retainBeyondPrivateTarget,
    };
    if (state === "rejected" && !options.retainRejectedFence && !flight.publicExposure && flight.maxPrivateTargetBlock === undefined) {
      this.flights.delete(nonce);
    } else {
      this.flights.set(nonce, flight);
    }
    if (
      state === "ambiguous"
      || options.retainRejectedFence
      || (state === "accepted" && !flight.publicExposure)
    ) {
      this.invisibleReservation = true;
    } else {
      this.invisibleReservation = [...this.flights.values()].some(
        (item) => item.state === "ambiguous"
          || (item.state === "accepted" && !item.publicExposure),
      );
    }
  }

  /** Restore a durable flight before fresh allocation on process startup. */
  restoreFlight(snapshot: NonceFlightSnapshot): void {
    this.flights.set(snapshot.nonce, { ...snapshot, replacement: false });
    this.invisibleReservation = this.lastConfirmed < 0 || [...this.flights.values()].some(
      (flight) => flight.nonce >= this.lastConfirmed
        && (!flight.publicExposure || flight.nonce >= this.lastPending),
    );
  }

  flightSnapshots(): NonceFlightSnapshot[] {
    return [...this.flights.values()].map(({ replacement: _replacement, ...flight }) => ({ ...flight }));
  }

  hasInvisibleReservation(): boolean {
    return this.invisibleReservation;
  }

  pendingNonce(): number {
    if (this.lastPending < 0) throw new Error("NonceManager.pendingNonce called before sync");
    return this.lastPending;
  }

  releaseContiguous(nonces: readonly number[]): boolean {
    if (this.next === null || nonces.length === 0) return false;
    const sorted = [...nonces].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) return false;
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index] !== sorted[index - 1]! + 1) return false;
    }
    const start = sorted[0]!;
    const end = sorted[sorted.length - 1]! + 1;
    if (this.next !== end || this.reservationCeiling() !== end) return false;
    for (const nonce of sorted) this.flights.delete(nonce);
    this.next = start;
    this.invisibleReservation = [...this.flights.values()].some(
      (flight) => flight.nonce >= this.lastConfirmed
        && (!flight.publicExposure || flight.nonce >= this.lastPending),
    );
    return true;
  }

  reset(): void {
    this.next = null;
  }

  private reservationCeiling(): number {
    let ceiling = Math.max(0, this.lastPending);
    for (const nonce of this.flights.keys()) ceiling = Math.max(ceiling, nonce + 1);
    return ceiling;
  }

  private clearAccountState(): void {
    this.next = null;
    this.lastConfirmed = -1;
    this.lastPending = -1;
    this.invisibleReservation = false;
    this.flights.clear();
    this.recoveredAddress = null;
  }
}

export const nonceManager = new NonceManager();
