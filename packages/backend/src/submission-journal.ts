import fs from "node:fs";
import path from "node:path";
import { keccak256, parseTransaction, type Address, type Hex } from "viem";
import { writeFileAtomicDurableSync } from "./durability.js";

export type JournalDeliveryState = "prepared" | "accepted" | "rejected" | "ambiguous" | "expired";

export interface JournalDeliveryAttempt {
  channel: "public" | "private";
  endpoint: string;
  state: Exclude<JournalDeliveryState, "prepared" | "expired">;
  targetBlock?: string;
  replacementUuid?: string;
  cancellationSupported?: boolean;
  error?: string;
}

export interface JournalFlight {
  wallet: Address;
  nonce: number;
  rawSignedTx: Hex;
  txHash: Hex;
  obligation: {
    to: Address;
    data: Hex;
    valueWei: string;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
  lineage: {
    id: string;
    replacesTxHash?: Hex;
  };
  recovery: {
    /** The original campaign explicitly allowed public-mempool delivery. */
    publicAuthorized: boolean;
    /** Do not replay a future-valid tx before this unix-second boundary. */
    notBeforeTimestamp?: string;
  };
  state: JournalDeliveryState;
  /** True once a public dispatch is accepted or ambiguous. Kept explicitly so
   * recovery callers do not need to reinterpret endpoint-specific attempts. */
  publicExposure: boolean;
  /** Endpoint evidence shows another same-nonce lineage may exist. */
  nonceConflict: boolean;
  attempts: JournalDeliveryAttempt[];
  maxPrivateTargetBlock?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface JournalDocument {
  version: 1;
  flights: JournalFlight[];
}

export interface JournalReconciliation {
  confirmedNonce: number;
  pendingNonce: number;
  currentBlock: bigint;
  retained: JournalFlight[];
  consumed: JournalFlight[];
  expired: JournalFlight[];
}

export type JournalFlightUpdate = Partial<Pick<JournalFlight,
  "state" | "publicExposure" | "nonceConflict" | "attempts" | "maxPrivateTargetBlock" | "updatedAtMs"
>>;

export interface JournalMutation {
  updates?: readonly { txHash: Hex; update: JournalFlightUpdate }[];
  remove?: readonly Hex[];
}

const DELIVERY_STATES = new Set<JournalDeliveryState>([
  "prepared", "accepted", "rejected", "ambiguous", "expired",
]);
const ATTEMPT_STATES = new Set(["accepted", "rejected", "ambiguous"]);

function isHex(value: unknown, bytes?: number): value is Hex {
  return typeof value === "string"
    && /^0x[0-9a-f]*$/i.test(value)
    && (bytes === undefined || value.length === 2 + bytes * 2);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isJournalFlight(value: unknown): value is JournalFlight {
  if (!value || typeof value !== "object") return false;
  const flight = value as Partial<JournalFlight>;
  const obligation = flight.obligation;
  const lineage = flight.lineage;
  return isHex(flight.wallet, 20)
    && Number.isSafeInteger(flight.nonce)
    && (flight.nonce ?? -1) >= 0
    && isHex(flight.rawSignedTx)
    && isHex(flight.txHash, 32)
    && Boolean(obligation)
    && isHex(obligation?.to, 20)
    && isHex(obligation?.data)
    && isDecimal(obligation?.valueWei)
    && isDecimal(obligation?.gasLimit)
    && isDecimal(obligation?.maxFeePerGas)
    && isDecimal(obligation?.maxPriorityFeePerGas)
    && Boolean(lineage)
    && typeof lineage?.id === "string"
    && (lineage?.replacesTxHash === undefined || isHex(lineage.replacesTxHash, 32))
    && Boolean(flight.recovery)
    && typeof flight.recovery?.publicAuthorized === "boolean"
    && (
      flight.recovery?.notBeforeTimestamp === undefined
      || isDecimal(flight.recovery.notBeforeTimestamp)
    )
    && typeof flight.state === "string"
    && DELIVERY_STATES.has(flight.state as JournalDeliveryState)
    && typeof flight.publicExposure === "boolean"
    && typeof flight.nonceConflict === "boolean"
    && Array.isArray(flight.attempts)
    && flight.attempts.every((attempt) =>
      (attempt.channel === "public" || attempt.channel === "private")
      && typeof attempt.endpoint === "string"
      && ATTEMPT_STATES.has(attempt.state)
      && (attempt.targetBlock === undefined || isDecimal(attempt.targetBlock))
      && (attempt.replacementUuid === undefined || typeof attempt.replacementUuid === "string")
      && (attempt.cancellationSupported === undefined || typeof attempt.cancellationSupported === "boolean")
      && (attempt.error === undefined || typeof attempt.error === "string"),
    )
    && (flight.maxPrivateTargetBlock === undefined || isDecimal(flight.maxPrivateTargetBlock))
    && typeof flight.createdAtMs === "number"
    && Number.isFinite(flight.createdAtMs)
    && typeof flight.updatedAtMs === "number"
    && Number.isFinite(flight.updatedAtMs);
}

function signedTransactionMatches(flight: JournalFlight): boolean {
  try {
    const transaction = parseTransaction(flight.rawSignedTx);
    return keccak256(flight.rawSignedTx).toLowerCase() === flight.txHash.toLowerCase()
      && transaction.nonce === flight.nonce
      && transaction.to?.toLowerCase() === flight.obligation.to.toLowerCase()
      && (transaction.data ?? "0x").toLowerCase() === flight.obligation.data.toLowerCase()
      && (transaction.value ?? 0n) === BigInt(flight.obligation.valueWei)
      && transaction.gas === BigInt(flight.obligation.gasLimit)
      && transaction.maxFeePerGas === BigInt(flight.obligation.maxFeePerGas)
      && transaction.maxPriorityFeePerGas === BigInt(flight.obligation.maxPriorityFeePerGas);
  } catch {
    return false;
  }
}

export class JournalCorruptionError extends Error {
  constructor(readonly journalPath: string, cause?: unknown) {
    super(`submission journal is corrupt or incompatible: ${journalPath}`, { cause });
    this.name = "JournalCorruptionError";
  }
}

/**
 * Small, account-scoped submission WAL. Writes use same-directory rename so a
 * crash exposes either the previous complete document or the next complete one.
 * The raw transaction is intentionally retained: recovery can rebroadcast the
 * identical hash without inventing a conflicting intent at the same nonce.
 */
export class SubmissionFlightJournal {
  readonly directory: string;

  constructor(dataDir: string, directory = "submission-flights") {
    this.directory = path.join(dataDir, directory);
  }

  pathFor(wallet: Address): string {
    return path.join(this.directory, `${wallet.toLowerCase()}.json`);
  }

  load(wallet: Address): JournalFlight[] {
    const filePath = this.pathFor(wallet);
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as JournalDocument;
      if (
        parsed.version !== 1
        || !Array.isArray(parsed.flights)
        || !parsed.flights.every(isJournalFlight)
        || !parsed.flights.every(signedTransactionMatches)
      ) {
        throw new JournalCorruptionError(filePath);
      }
      if (parsed.flights.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
        throw new JournalCorruptionError(filePath);
      }
      return parsed.flights;
    } catch (error) {
      if (error instanceof JournalCorruptionError) throw error;
      throw new JournalCorruptionError(filePath, error);
    }
  }

  upsert(flight: JournalFlight): void {
    this.upsertMany(flight.wallet, [flight]);
  }

  /** One durable barrier for a prepared batch; avoids O(n²) journal rewrites. */
  upsertMany(wallet: Address, additions: readonly JournalFlight[]): void {
    if (additions.length === 0) return;
    if (additions.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
      throw new Error("submission journal batch contains another wallet");
    }
    const flights = this.load(wallet);
    for (const flight of additions) {
      const index = flights.findIndex((item) => item.txHash === flight.txHash);
      if (index >= 0) flights[index] = flight;
      else flights.push(flight);
    }
    this.write(wallet, { version: 1, flights });
  }

  update(wallet: Address, txHash: Hex, update: JournalFlightUpdate): JournalFlight | undefined {
    return this.updateMany(wallet, [{ txHash, update }])[0];
  }

  /** Apply every post-delivery state transition under one atomic rename/fsync. */
  updateMany(
    wallet: Address,
    updates: readonly { txHash: Hex; update: JournalFlightUpdate }[],
  ): Array<JournalFlight | undefined> {
    if (updates.length === 0) return [];
    return this.mutate(wallet, { updates });
  }

  /** Apply delivery transitions and terminal removals in one crash-consistent
   * document replacement. */
  mutate(wallet: Address, mutation: JournalMutation): Array<JournalFlight | undefined> {
    const updates = mutation.updates ?? [];
    const removals = new Set(mutation.remove ?? []);
    if (updates.length === 0 && removals.size === 0) return [];
    const flights = this.load(wallet);
    const changed: Array<JournalFlight | undefined> = [];
    for (const { txHash, update } of updates) {
      const flight = flights.find((item) => item.txHash === txHash);
      changed.push(flight);
      if (!flight) throw new Error(`submission journal flight not found: ${txHash}`);
      Object.assign(flight, update, { updatedAtMs: update.updatedAtMs ?? Date.now() });
    }
    this.write(wallet, {
      version: 1,
      flights: flights.filter((flight) => !removals.has(flight.txHash)),
    });
    return changed;
  }

  remove(wallet: Address, txHash: Hex): void {
    this.removeMany(wallet, [txHash]);
  }

  removeMany(wallet: Address, txHashes: readonly Hex[]): void {
    this.mutate(wallet, { remove: txHashes });
  }

  /**
   * Startup hook: confirmed nonce consumption is authoritative. A private-only
   * flight expires only after its last target block. Public or ambiguous flights
   * never expire from wall-clock age or hash absence.
   */
  reconcile(
    wallet: Address,
    confirmedNonce: number,
    pendingNonce: number,
    currentBlock: bigint,
  ): JournalReconciliation {
    const all = this.load(wallet);
    const dispositions = all.map((flight): {
      flight: JournalFlight;
      state: "retained" | "consumed" | "expirable";
    } => {
      flight.publicExposure = flight.publicExposure ?? flight.attempts.some(
        (attempt) => attempt.channel === "public" && attempt.state !== "rejected",
      );
      if (flight.nonce < confirmedNonce) {
        return { flight, state: "consumed" };
      }
      // A crash can leave the WAL at `prepared` after the public request left but
      // before its outcome commit. Public-authorized prepared work is therefore
      // potential exposure and never block-expires.
      const hasPublicExposure = flight.publicExposure
        || (flight.state === "prepared" && flight.recovery.publicAuthorized);
      const maxTarget = flight.maxPrivateTargetBlock === undefined
        ? undefined
        : BigInt(flight.maxPrivateTargetBlock);
      if (
        flight.state === "prepared"
        && !flight.recovery.publicAuthorized
        && maxTarget === undefined
      ) {
        // The private route was disabled before the WAL barrier and no public
        // route was authorized, so no request could have left this process.
        return { flight, state: "expirable" };
      }
      if (
        !hasPublicExposure
        && !flight.nonceConflict
        && maxTarget !== undefined
        && currentBlock > maxTarget
      ) {
        return { flight, state: "expirable" };
      }
      return { flight, state: "retained" };
    });

    const highestLiveNonce = dispositions.reduce((highest, disposition) =>
      disposition.state === "retained" && disposition.flight.nonce > highest
        ? disposition.flight.nonce
        : highest, -1);
    const retained: JournalFlight[] = [];
    const consumed: JournalFlight[] = [];
    const expired: JournalFlight[] = [];
    for (const disposition of dispositions) {
      const { flight } = disposition;
      if (disposition.state === "consumed") {
        consumed.push(flight);
      } else if (
        disposition.state === "retained"
        || highestLiveNonce > flight.nonce
      ) {
        // An expired/undelivered private lower nonce is still required gap
        // evidence while a higher durable flight survives. Keep its exact
        // calldata and lineage so restart recovery can replace it with a capped
        // inert filler; public recovery remains disabled by its policy.
        retained.push(flight);
      } else {
        expired.push({ ...flight, state: "expired", updatedAtMs: Date.now() });
      }
    }
    this.write(wallet, { version: 1, flights: retained });
    return { confirmedNonce, pendingNonce, currentBlock, retained, consumed, expired };
  }

  private write(wallet: Address, document: JournalDocument): void {
    const filePath = this.pathFor(wallet);
    writeFileAtomicDurableSync(filePath, JSON.stringify(document, null, 2));
  }
}
