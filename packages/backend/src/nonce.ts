import type { Address } from "viem";
import fs from "node:fs";
import path from "node:path";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";
import { tightenPrivateFile, writePrivateFileAtomic } from "./private-file.js";

interface PersistedReservation {
  reservedCeil: number;
  updatedAtMs: number;
  /** Last block in which this private nonce sequence is eligible. Null means unknown. */
  eligibleThroughBlock: number | null;
}

type PersistedReservations = Record<string, PersistedReservation>;

const RESERVATION_FILE = path.join(appConfig.dataDir, "nonce-reservations.json");
const RESERVATION_STALE_MS = 90_000;
const RESERVATION_REORG_MARGIN_BLOCKS = 2n;

function readPersistedReservations(): PersistedReservations {
  if (!fs.existsSync(RESERVATION_FILE)) return {};
  try {
    tightenPrivateFile(RESERVATION_FILE);
    const value: unknown = JSON.parse(fs.readFileSync(RESERVATION_FILE, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("journal root is not an object");
    }
    const valid: PersistedReservations = {};
    for (const [address, entry] of Object.entries(value)) {
      if (!(
        /^0x[0-9a-f]{40}$/.test(address) && entry && typeof entry === "object" &&
        Number.isSafeInteger((entry as PersistedReservation).reservedCeil) &&
        (entry as PersistedReservation).reservedCeil >= 0 &&
        Number.isFinite((entry as PersistedReservation).updatedAtMs) &&
        (entry as PersistedReservation).updatedAtMs >= 0 &&
        (
          (entry as Partial<PersistedReservation>).eligibleThroughBlock === undefined ||
          (entry as PersistedReservation).eligibleThroughBlock === null ||
          (Number.isSafeInteger((entry as PersistedReservation).eligibleThroughBlock) &&
            (entry as PersistedReservation).eligibleThroughBlock! >= 0)
        )
      )) {
        throw new Error(`invalid reservation for ${address}`);
      }
      // Do not discard an old journal at load time. Its transaction may still be pending;
      // sync() must compare pending AND mined nonce before deciding it was dropped.
      valid[address] = {
        ...(entry as PersistedReservation),
        eligibleThroughBlock: (entry as Partial<PersistedReservation>).eligibleThroughBlock ?? null,
      };
    }
    return valid;
  } catch (err) {
    // Fail closed: silently ignoring a corrupt journal could reuse a private
    // bundle's nonce immediately after a crash or power loss.
    throw new Error(`Cannot safely read nonce reservation journal ${RESERVATION_FILE}: ${(err as Error).message}`);
  }
}

function writePersistedReservations(value: PersistedReservations): void {
  writePrivateFileAtomic(RESERVATION_FILE, JSON.stringify(value));
}

// Nonce state for the single hot wallet, held across engine ticks.
//
// In `public`/`local` mode our submitted txs land in the mempool, so
// `getTransactionCount(pending)` reflects them and is the source of truth each
// tick. In `mainnet` mode our txs go out as private Flashbots bundles the mempool
// never sees, so pending can lag what we've actually used — if we blindly re-synced
// to it we'd hand the same nonce to a *different* tx on the next tick and silently
// drop one of them. So in mainnet mode we hold our own reserved ceiling until the
// chain catches up (bundle mined) or its last eligible block plus reorg margin passes.

export type SubmitMode = "public" | "mainnet" | "local";

export class NonceManager {
  private next: number | null = null;
  private mode: SubmitMode | null = null;
  private reservedCeil: number | null = null; // one past the highest nonce reserved this session
  private reservationUpdatedAtMs: number | null = null;
  private eligibleThroughBlock: bigint | null = null;
  // A fresh sync may extend a sequence only when no older invisible nonce gap exists.
  // Once the first nonce is reserved, additional txs in that same batch remain allowed.
  private canExtendPrivateSequence = false;
  // A journal restored after process start proves that private nonces may still be live,
  // but it contains no corresponding value/gas commitment. Until chain nonce catches up
  // or block eligibility is authoritatively over, higher-nonce signing must fail closed.
  private restoredUnaccountedReservation = false;
  // On first sync after process start, pending > latest proves some signed transaction
  // may be live while this process has no spend/lifecycle record for it (notably public
  // mode, whose old implementation did not journal). Freeze signing until that gap mines
  // or disappears so a restart cannot prepare a duplicate logical action at nonce+1.
  private startupUnaccountedPending = false;
  private hasSynced = false;
  // Keep a private-bundle reservation beyond its last target block so stalled heads,
  // delayed RPC views, and short reorgs cannot make us reuse a live nonce. Wall-clock
  // age is an additional grace condition, never proof that block eligibility ended.
  static readonly STALE_MS = RESERVATION_STALE_MS;

  constructor(
    reservation?: PersistedReservation,
    private readonly onReservationChange?: (reservation: PersistedReservation | null) => void,
  ) {
    if (reservation) {
      this.reservedCeil = reservation.reservedCeil;
      this.reservationUpdatedAtMs = reservation.updatedAtMs;
      this.eligibleThroughBlock = reservation.eligibleThroughBlock === null
        ? null
        : BigInt(reservation.eligibleThroughBlock);
      this.restoredUnaccountedReservation = true;
    }
  }

  /** Re-sync at the start of a tick. `mode` decides whether to trust the mempool
   *  (public/local) or hold our own reserved ceiling (mainnet). */
  async sync(address: Address, mode: SubmitMode): Promise<void> {
    const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    const nowMs = Date.now();
    this.mode = mode;

    if (!this.hasSynced || this.startupUnaccountedPending) {
      const mined = await publicClient.getTransactionCount({ address, blockTag: "latest" });
      this.startupUnaccountedPending = onchain > mined;
    }
    this.hasSynced = true;

    const ageIsLive =
      this.reservedCeil !== null &&
      this.reservationUpdatedAtMs !== null &&
      nowMs - this.reservationUpdatedAtMs < NonceManager.STALE_MS;
    // Time is only a reorg/RPC grace period. It cannot prove bundle expiry when block
    // production stalls. Unknown legacy journals also fail closed until nonce catch-up.
    const headPastEligibility = this.reservedCeil === null
      ? true
      : this.eligibleThroughBlock === null
        ? false
        : (await publicClient.getBlockNumber()) >
          this.eligibleThroughBlock + RESERVATION_REORG_MARGIN_BLOCKS;
    const reservationIsLive = this.reservedCeil !== null && (ageIsLive || !headPastEligibility);

    if (
      this.restoredUnaccountedReservation &&
      this.reservedCeil !== null &&
      onchain >= this.reservedCeil
    ) {
      // Pending nonce can advance before any debit is reflected in latest balance. Only
      // a mined/latest nonce proves the fresh final balance includes the old spend.
      const mined = await publicClient.getTransactionCount({ address, blockTag: "latest" });
      if (mined >= this.reservedCeil) {
        this.restoredUnaccountedReservation = false;
      } else if (!reservationIsLive) {
        // Even beyond the age window, pending-only advancement means the signed tx can
        // still land. Retain the old journal and freeze all higher-nonce private sends.
        this.next = Math.max(onchain, this.reservedCeil);
        this.canExtendPrivateSequence = false;
        return;
      }
    }

    if (reservationIsLive) {
      // A mode switch must not erase a still-live private reservation. A public
      // transaction can safely follow the reserved ceiling, but cannot reuse a
      // nonce just because the private bundle is invisible to the mempool.
      this.next = Math.max(onchain, this.reservedCeil!);
      this.canExtendPrivateSequence = onchain >= this.reservedCeil!;
      return;
    }

    // No private bundle is still eligible. Release an expired gap and return to
    // chain truth. Public/local submissions are visible in this pending count.
    this.next = onchain;
    this.releaseReservation();
    this.canExtendPrivateSequence = true;
  }

  /** Peek at the next nonce without consuming it (for simulation). */
  peek(): number {
    if (this.next === null) throw new Error("NonceManager.peek called before sync");
    return this.next;
  }

  /** Reserve the next nonce (call only after simulation passes). */
  reserve(eligibleThroughBlock?: bigint): number {
    if (this.next === null) throw new Error("NonceManager.reserve called before sync");
    if (this.restoredUnaccountedReservation) {
      throw new Error("Private nonce reservation restored after restart is still unresolved");
    }
    if (this.startupUnaccountedPending) {
      throw new Error("Pre-restart pending transaction spend is still unresolved");
    }
    if (!this.canExtendPrivateSequence) {
      throw new Error("Previous private nonce sequence is still unresolved");
    }
    const n = this.next;
    const next = n + 1;
    if (this.mode === "mainnet") {
      // Missing eligibility is retained indefinitely rather than guessed from wall time.
      // Production submission paths always provide and later extend this block bound.
      const eligible = eligibleThroughBlock ?? this.eligibleThroughBlock;
      if (eligible !== null && (!Number.isSafeInteger(Number(eligible)) || eligible < 0n)) {
        throw new Error("Private nonce eligibility block is invalid");
      }
      // Renew the safety window whenever another transaction joins the private
      // sequence. Persist before handing the nonce to the signer: if durable
      // journaling fails, the submission fails closed instead of becoming unsafe
      // after a process restart.
      const reservation = {
        reservedCeil: Math.max(this.reservedCeil ?? 0, next),
        updatedAtMs: Date.now(),
        eligibleThroughBlock: eligible === null ? null : Number(eligible),
      };
      if (!this.onReservationChange) {
        throw new Error("Private nonce reservation requires durable journal storage");
      }
      this.onReservationChange(reservation);
      this.reservedCeil = reservation.reservedCeil;
      this.reservationUpdatedAtMs = reservation.updatedAtMs;
      this.eligibleThroughBlock = eligible;
    }
    this.next = next;
    return n;
  }

  /** Extend a queued sequence to the actual blocks selected immediately before relay. */
  markEligibleThrough(block: bigint): void {
    if (this.reservedCeil === null || this.reservationUpdatedAtMs === null) {
      throw new Error("Cannot extend a missing private nonce reservation");
    }
    if (!Number.isSafeInteger(Number(block)) || block < 0n) {
      throw new Error("Private nonce eligibility block is invalid");
    }
    const nextEligible = this.eligibleThroughBlock === null
      ? block
      : (block > this.eligibleThroughBlock ? block : this.eligibleThroughBlock);
    const reservation: PersistedReservation = {
      reservedCeil: this.reservedCeil,
      updatedAtMs: this.reservationUpdatedAtMs,
      eligibleThroughBlock: Number(nextEligible),
    };
    if (!this.onReservationChange) throw new Error("Private nonce reservation requires durable journal storage");
    this.onReservationChange(reservation);
    this.eligibleThroughBlock = nextEligible;
  }

  /** End-of-tick reset of the working nonce. The reserved ceiling persists so a
   *  mainnet bundle's nonce isn't reused next tick before it mines. */
  reset(): void {
    this.next = null;
    this.mode = null;
    this.canExtendPrivateSequence = false;
  }

  /** Whether a restored journal entry still carries unknown pre-restart spend/nonce state. */
  hasRestoredUnaccountedReservation(): boolean {
    return this.restoredUnaccountedReservation || this.startupUnaccountedPending;
  }

  /**
   * Wait until retrying a private transaction at `nonce` cannot create a nonce gap.
   *
   * The durable reservation stores the last eligible bundle block and remains quarantined
   * through a reorg margin and a minimum wall-clock grace. Logical suppression must follow
   * that longer window: otherwise nonce N is retried as N+1, which cannot execute while N
   * is absent. This method reconciles mined/pending nonce state before atomically releasing
   * the journal and allowing the strategy to prepare again.
   */
  async waitUntilPrivateRetrySafe(address: Address, nonce: number): Promise<"retry" | "consumed"> {
    for (;;) {
      const updatedAt = this.reservationUpdatedAtMs;
      if (this.reservedCeil !== null && updatedAt !== null) {
        const remaining = NonceManager.STALE_MS - (Date.now() - updatedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, remaining);
            timer.unref?.();
          });
          // A later private submission may have extended the shared reservation while this
          // callback slept. Re-read its deadline rather than releasing the newer sequence.
          continue;
        }
      }
      const expectedCeil = this.reservedCeil;
      const expectedUpdatedAt = this.reservationUpdatedAtMs;
      const expectedEligibleThrough = this.eligibleThroughBlock;
      if (expectedEligibleThrough === null) {
        // A pre-upgrade journal has no authoritative bundle expiry. It may represent a
        // still-valid signed tx, so only mined nonce advancement may release it below.
      } else {
        const head = await publicClient.getBlockNumber();
        if (head <= expectedEligibleThrough + RESERVATION_REORG_MARGIN_BLOCKS) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            timer.unref?.();
          });
          continue;
        }
      }
      const [pendingNonce, latestNonce] = await Promise.all([
        publicClient.getTransactionCount({ address, blockTag: "pending" }),
        publicClient.getTransactionCount({ address, blockTag: "latest" }),
      ]);
      // A tick may have opened/extended a new private sequence while the pending-nonce RPC
      // was in flight. Never let an old expiry callback erase that newer durable journal;
      // loop and reconcile against the new generation's own deadline instead.
      if (
        this.reservedCeil !== expectedCeil ||
        this.reservationUpdatedAtMs !== expectedUpdatedAt ||
        this.eligibleThroughBlock !== expectedEligibleThrough
      ) continue;

      if (expectedEligibleThrough === null && latestNonce <= nonce) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        });
        continue;
      }

      // Pending-only advancement is not an authoritative debit. In particular a
      // bundle's public mirror may have been accepted even when the broadcast response
      // was lost. Keep its unknown-spend reservation until the nonce is mined, or until
      // the pending view drops back and proves the private sequence is no longer live.
      if (pendingNonce > nonce && latestNonce <= nonce) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        });
        continue;
      }
      const consumed = latestNonce > nonce;
      this.releaseReservation();
      // A background receipt callback may race a working tick. Do not leave that tick with
      // a stale higher `next`; force its next operation to perform a fresh sync.
      this.next = null;
      this.mode = null;
      this.canExtendPrivateSequence = false;
      return consumed ? "consumed" : "retry";
    }
  }

  private releaseReservation(): void {
    const hadReservation = this.reservedCeil !== null || this.reservationUpdatedAtMs !== null;
    this.reservedCeil = null;
    this.reservationUpdatedAtMs = null;
    this.eligibleThroughBlock = null;
    this.restoredUnaccountedReservation = false;
    if (hadReservation) this.onReservationChange?.(null);
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
export class NonceRegistry {
  private byAddress = new Map<string, NonceManager>();
  private persisted = readPersistedReservations();

  for(address: Address): NonceManager {
    const key = address.toLowerCase();
    let m = this.byAddress.get(key);
    if (!m) {
      m = new NonceManager(this.persisted[key], (reservation) => {
        const previous = this.persisted[key];
        if (reservation) this.persisted[key] = reservation;
        else delete this.persisted[key];
        try {
          writePersistedReservations(this.persisted);
        } catch (err) {
          if (previous) this.persisted[key] = previous;
          else delete this.persisted[key];
          throw err;
        }
      });
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

  hasRestoredUnaccountedReservation(address: Address): boolean {
    return this.for(address).hasRestoredUnaccountedReservation();
  }

  waitUntilPrivateRetrySafe(address: Address, nonce: number): Promise<"retry" | "consumed"> {
    return this.for(address).waitUntilPrivateRetrySafe(address, nonce);
  }

  /** Drop state for wallets that are no longer unlocked, so a re-added wallet starts
   *  with a fresh manager. Its durable private reservation remains until expiry so
   *  locking and immediately re-adding a wallet cannot make a live nonce reusable. */
  retain(addresses: Address[]): void {
    const keep = new Set(addresses.map((a) => a.toLowerCase()));
    for (const key of [...this.byAddress.keys()]) {
      if (!keep.has(key)) this.byAddress.delete(key);
    }
  }
}

export const nonces = new NonceRegistry();
