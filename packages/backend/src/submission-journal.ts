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
  /** First coherent block where the account's latest nonce proved this nonce
   * consumed. The raw transaction and its maximum exposure remain durable until
   * that observation reaches the confirmation-depth threshold. A nonce
   * regression clears this marker. */
  observedConsumedAtBlock?: string;
  /** Canonical hash paired with observedConsumedAtBlock. Height alone is not
   * sufficient: a lateral reorg can keep the nonce advanced while replacing the
   * block that established the first observation. */
  observedConsumedAtBlockHash?: Hex;
  attempts: JournalDeliveryAttempt[];
  maxPrivateTargetBlock?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface LegacyJournalDocument {
  version: 1;
  flights: JournalFlight[];
}

interface JournalDocument {
  version: 2;
  chainId: number;
  flights: JournalFlight[];
}

export interface JournalReconciliation {
  confirmedNonce: number;
  pendingNonce: number;
  currentBlock: bigint;
  retained: JournalFlight[];
  /** Retained flights whose nonce is included at the current tip but has not
   * reached reorg-safe confirmation depth yet. */
  provisional?: JournalFlight[];
  consumed: JournalFlight[];
  expired: JournalFlight[];
}

/** Hashes on one explicitly selected canonical chain. Index zero is `number`,
 * index one is its parent, and so on. Reconciliation never infers continuity
 * from block height alone. */
export interface JournalBlockEvidence {
  number: bigint;
  canonicalHashes: readonly Hex[];
}

export type JournalFlightUpdate = Partial<Pick<JournalFlight,
  "state" | "publicExposure" | "nonceConflict" | "observedConsumedAtBlock"
  | "observedConsumedAtBlockHash"
  | "attempts" | "maxPrivateTargetBlock" | "updatedAtMs"
>>;

export interface JournalMutation {
  updates?: readonly { txHash: Hex; update: JournalFlightUpdate }[];
  remove?: readonly Hex[];
}

const DELIVERY_STATES = new Set<JournalDeliveryState>([
  "prepared", "accepted", "rejected", "ambiguous", "expired",
]);
const ATTEMPT_STATES = new Set(["accepted", "rejected", "ambiguous"]);

/** Two blocks after first tip inclusion (three observations including the
 * inclusion block) protects ordinary one-block reorgs without indefinitely
 * retaining settled raw transactions. */
export const JOURNAL_CONFIRMATION_DEPTH = 3n;

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
    && (
      flight.observedConsumedAtBlock === undefined
      || isDecimal(flight.observedConsumedAtBlock)
    )
    && (
      flight.observedConsumedAtBlockHash === undefined
      || isHex(flight.observedConsumedAtBlockHash, 32)
    )
    // Accept the height-only shape written by the first v2 implementation, but
    // never accept a hash with no height. Height-only evidence is restarted from
    // a coherent hash before it can become terminal.
    && !(
      flight.observedConsumedAtBlock === undefined
      && flight.observedConsumedAtBlockHash !== undefined
    )
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

function parsedTransactionChainId(flight: JournalFlight): number | null {
  try {
    const chainId = parseTransaction(flight.rawSignedTx).chainId;
    return Number.isSafeInteger(chainId) && (chainId ?? 0) > 0
      ? chainId!
      : null;
  } catch {
    return null;
  }
}

function signedTransactionMatches(flight: JournalFlight, chainId: number): boolean {
  try {
    const transaction = parseTransaction(flight.rawSignedTx);
    return keccak256(flight.rawSignedTx).toLowerCase() === flight.txHash.toLowerCase()
      && transaction.chainId === chainId
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

function mergeSameHashFlight(existing: JournalFlight, incoming: JournalFlight): JournalFlight {
  const attempts = [...existing.attempts];
  const seen = new Set(attempts.map((attempt) => JSON.stringify(attempt)));
  for (const attempt of incoming.attempts) {
    const key = JSON.stringify(attempt);
    if (!seen.has(key)) {
      attempts.push(attempt);
      seen.add(key);
    }
  }
  const matchingObservation = existing.observedConsumedAtBlock !== undefined
    && existing.observedConsumedAtBlockHash !== undefined
    && existing.observedConsumedAtBlock === incoming.observedConsumedAtBlock
    && existing.observedConsumedAtBlockHash.toLowerCase()
      === incoming.observedConsumedAtBlockHash?.toLowerCase();
  const incomingState = incoming.state === "prepared" && existing.state !== "prepared"
    ? existing.state
    : incoming.state;
  const notBeforeValues = [
    existing.recovery.notBeforeTimestamp,
    incoming.recovery.notBeforeTimestamp,
  ].flatMap((timestamp) => timestamp === undefined ? [] : [BigInt(timestamp)]);
  const notBeforeTimestamp = notBeforeValues.length === 0
    ? undefined
    : notBeforeValues.reduce((latest, timestamp) =>
        timestamp > latest ? timestamp : latest).toString();
  const privateTargets = [existing.maxPrivateTargetBlock, incoming.maxPrivateTargetBlock]
    .flatMap((block) => block === undefined ? [] : [BigInt(block)]);
  const maxPrivateTargetBlock = privateTargets.length === 0
    ? undefined
    : privateTargets.reduce((latest, block) => block > latest ? block : latest).toString();
  const merged: JournalFlight = {
    ...incoming,
    state: incomingState,
    publicExposure: existing.publicExposure || incoming.publicExposure,
    nonceConflict: existing.nonceConflict || incoming.nonceConflict,
    recovery: {
      publicAuthorized: existing.recovery.publicAuthorized
        || incoming.recovery.publicAuthorized,
      ...(notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp }),
    },
    ...(maxPrivateTargetBlock === undefined ? {} : { maxPrivateTargetBlock }),
    attempts,
    createdAtMs: Math.min(existing.createdAtMs, incoming.createdAtMs),
    updatedAtMs: Math.max(existing.updatedAtMs, incoming.updatedAtMs),
  };
  // Conflicting, missing, or legacy height-only observations cannot prove one
  // continuous canonical ancestry. Restart them on the next reconciliation.
  if (matchingObservation) {
    merged.observedConsumedAtBlock = existing.observedConsumedAtBlock;
    merged.observedConsumedAtBlockHash = existing.observedConsumedAtBlockHash;
  } else {
    delete merged.observedConsumedAtBlock;
    delete merged.observedConsumedAtBlockHash;
  }
  return merged;
}

export class JournalCorruptionError extends Error {
  constructor(readonly journalPath: string, cause?: unknown) {
    super(`submission journal is corrupt or incompatible: ${journalPath}`, { cause });
    this.name = "JournalCorruptionError";
  }
}

export class JournalChainUnavailableError extends Error {
  constructor() {
    super("submission journal requires a verified positive chain ID");
    this.name = "JournalChainUnavailableError";
  }
}

type ChainIdSource = number | (() => number | null);

/**
 * Small, account-scoped submission WAL. Writes use same-directory rename so a
 * crash exposes either the previous complete document or the next complete one.
 * The raw transaction is intentionally retained: recovery can rebroadcast the
 * identical hash without inventing a conflicting intent at the same nonce.
 */
export class SubmissionFlightJournal {
  readonly directory: string;

  constructor(
    dataDir: string,
    directory = "submission-flights",
    private readonly chainIdSource: ChainIdSource = 1,
  ) {
    this.directory = path.join(dataDir, directory);
  }

  private chainId(): number {
    const chainId = typeof this.chainIdSource === "function"
      ? this.chainIdSource()
      : this.chainIdSource;
    if (!Number.isSafeInteger(chainId) || (chainId ?? 0) <= 0) {
      throw new JournalChainUnavailableError();
    }
    return chainId!;
  }

  pathFor(wallet: Address): string {
    return this.pathForChain(wallet, this.chainId());
  }

  private pathForChain(wallet: Address, chainId: number): string {
    return path.join(this.directory, `chain-${chainId}`, `${wallet.toLowerCase()}.json`);
  }

  /** Location used before journals became chain-scoped. Exposed for migration
   * diagnostics and tests; new writes never target this path. */
  legacyPathFor(wallet: Address): string {
    return path.join(this.directory, `${wallet.toLowerCase()}.json`);
  }

  private parseDocument(
    filePath: string,
    contents: string,
    chainId: number,
    allowLegacy: boolean,
  ): JournalFlight[] {
    const parsed = JSON.parse(contents) as JournalDocument | LegacyJournalDocument;
    const validVersion = parsed.version === 2
      ? parsed.chainId === chainId
      : allowLegacy && parsed.version === 1;
    if (
      !validVersion
      || !Array.isArray(parsed.flights)
      || !parsed.flights.every(isJournalFlight)
      || !parsed.flights.every((flight) => signedTransactionMatches(flight, chainId))
    ) {
      throw new JournalCorruptionError(filePath);
    }
    return parsed.flights;
  }

  private migrateLegacy(wallet: Address, chainId: number): JournalFlight[] | null {
    const legacyPath = this.legacyPathFor(wallet);
    if (!fs.existsSync(legacyPath)) return null;
    let parsed: LegacyJournalDocument;
    try {
      parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as LegacyJournalDocument;
    } catch (error) {
      throw new JournalCorruptionError(legacyPath, error);
    }
    if (
      parsed.version !== 1
      || !Array.isArray(parsed.flights)
      || !parsed.flights.every(isJournalFlight)
    ) {
      throw new JournalCorruptionError(legacyPath);
    }
    const signedChainIds = new Set(parsed.flights.map(parsedTransactionChainId));
    if (signedChainIds.has(null) || signedChainIds.size > 1) {
      throw new JournalCorruptionError(legacyPath);
    }
    const legacyChainId = signedChainIds.size === 0
      ? chainId
      : [...signedChainIds][0]!;
    if (!parsed.flights.every((flight) => signedTransactionMatches(flight, legacyChainId))) {
      throw new JournalCorruptionError(legacyPath);
    }
    if (parsed.flights.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
      throw new JournalCorruptionError(legacyPath);
    }
    // Migrate according to the cryptographically signed chain, even when it is
    // not the currently active one. That makes the old WAL an isolated,
    // chain-scoped quarantine without ever replaying it on this network.
    const scopedPath = this.pathForChain(wallet, legacyChainId);
    const existing = fs.existsSync(scopedPath)
      ? this.parseDocument(
          scopedPath,
          fs.readFileSync(scopedPath, "utf8"),
          legacyChainId,
          false,
        )
      : [];
    if (existing.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
      throw new JournalCorruptionError(scopedPath);
    }
    const merged = [...existing];
    for (const flight of parsed.flights) {
      const index = merged.findIndex((candidate) => candidate.txHash === flight.txHash);
      if (index === -1) merged.push(flight);
      else merged[index] = mergeSameHashFlight(merged[index]!, flight);
    }
    const document: JournalDocument = {
      version: 2,
      chainId: legacyChainId,
      flights: merged,
    };
    writeFileAtomicDurableSync(scopedPath, JSON.stringify(document, null, 2));
    // Preserve migration evidence instead of deleting the legacy WAL. If the
    // rename fails, the committed scoped copy is still authoritative on the
    // next load, so recovery remains idempotent.
    const archiveBase = `${legacyPath}.migrated-chain-${legacyChainId}`;
    const archivePath = fs.existsSync(archiveBase)
      ? `${archiveBase}.${Date.now()}`
      : archiveBase;
    try {
      fs.renameSync(legacyPath, archivePath);
    } catch {
      // Best-effort archive only; never invalidate the newly durable scoped WAL.
    }
    return legacyChainId === chainId ? merged : [];
  }

  load(wallet: Address): JournalFlight[] {
    const chainId = this.chainId();
    const filePath = this.pathFor(wallet);
    try {
      const flights = fs.existsSync(filePath)
        ? this.parseDocument(filePath, fs.readFileSync(filePath, "utf8"), chainId, false)
        : this.migrateLegacy(wallet, chainId) ?? [];
      if (flights.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
        throw new JournalCorruptionError(filePath);
      }
      return flights;
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
    const chainId = this.chainId();
    if (additions.some((flight) => flight.wallet.toLowerCase() !== wallet.toLowerCase())) {
      throw new Error("submission journal batch contains another wallet");
    }
    if (additions.some((flight) => !signedTransactionMatches(flight, chainId))) {
      throw new Error(`submission journal batch contains a transaction outside chain ${chainId}`);
    }
    const flights = this.load(wallet);
    for (const flight of additions) {
      const index = flights.findIndex((item) => item.txHash === flight.txHash);
      if (index >= 0) flights[index] = mergeSameHashFlight(flights[index]!, flight);
      else flights.push(flight);
    }
    this.write(wallet, { version: 2, chainId, flights });
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
      Object.assign(flight, update, {
        // Once a node has shown same-nonce exposure, a later endpoint response
        // cannot disprove it. Only deep chain consumption removes the flight.
        nonceConflict: flight.nonceConflict || update.nonceConflict === true,
        updatedAtMs: update.updatedAtMs ?? Date.now(),
      });
    }
    const chainId = this.chainId();
    this.write(wallet, {
      version: 2,
      chainId,
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
   * Startup hook: latest-nonce consumption becomes terminal only after a short
   * confirmation window. A private-only flight expires only after its last
   * target block. Public or ambiguous flights never expire from wall-clock age
   * or hash absence.
   */
  reconcile(
    wallet: Address,
    confirmedNonce: number,
    pendingNonce: number,
    blockEvidence: JournalBlockEvidence,
  ): JournalReconciliation {
    if (
      blockEvidence.canonicalHashes.length === 0
      || blockEvidence.canonicalHashes.some((hash) => !isHex(hash, 32))
    ) {
      throw new Error("submission journal reconciliation requires canonical block hashes");
    }
    const currentBlock = blockEvidence.number;
    const currentBlockHash = blockEvidence.canonicalHashes[0]!;
    const all = this.load(wallet);
    const provisional: JournalFlight[] = [];
    const dispositions = all.map((flight): {
      flight: JournalFlight;
      state: "retained" | "consumed" | "expirable";
    } => {
      flight.publicExposure = flight.publicExposure ?? flight.attempts.some(
        (attempt) => attempt.channel === "public" && attempt.state !== "rejected",
      );
      if (flight.nonce < confirmedNonce) {
        const priorObservation = flight.observedConsumedAtBlock === undefined
          ? undefined
          : BigInt(flight.observedConsumedAtBlock);
        const priorHash = flight.observedConsumedAtBlockHash;
        const delta = priorObservation === undefined
          ? undefined
          : currentBlock - priorObservation;
        const canonicalObservedHash = delta !== undefined
          && delta >= 0n
          && delta < BigInt(blockEvidence.canonicalHashes.length)
          ? blockEvidence.canonicalHashes[Number(delta)]
          : undefined;
        // Missing legacy hash evidence, a replaced ancestor, a height regression,
        // or a skipped observation window all restart depth at this exact block.
        if (
          priorObservation === undefined
          || priorHash === undefined
          || canonicalObservedHash?.toLowerCase() !== priorHash.toLowerCase()
        ) {
          flight.observedConsumedAtBlock = currentBlock.toString();
          flight.observedConsumedAtBlockHash = currentBlockHash;
        }
        const observedAt = BigInt(flight.observedConsumedAtBlock!);
        const observedHash = flight.observedConsumedAtBlockHash!;
        const observedDelta = currentBlock - observedAt;
        if (
          observedDelta >= 0n
          && observedDelta < BigInt(blockEvidence.canonicalHashes.length)
          && blockEvidence.canonicalHashes[Number(observedDelta)]?.toLowerCase()
            === observedHash.toLowerCase()
          && observedDelta + 1n >= JOURNAL_CONFIRMATION_DEPTH
        ) {
          return { flight, state: "consumed" };
        }
        provisional.push(flight);
        return { flight, state: "retained" };
      }
      // The latest account nonce regressed before finality. Treat the prior tip
      // as reorged and restore the full live liability/replay fence.
      if (flight.observedConsumedAtBlock !== undefined) {
        delete flight.observedConsumedAtBlock;
        delete flight.observedConsumedAtBlockHash;
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
    this.write(wallet, {
      version: 2,
      chainId: this.chainId(),
      flights: retained,
    });
    return {
      confirmedNonce,
      pendingNonce,
      currentBlock,
      retained,
      provisional,
      consumed,
      expired,
    };
  }

  private write(wallet: Address, document: JournalDocument): void {
    const filePath = this.pathFor(wallet);
    writeFileAtomicDurableSync(filePath, JSON.stringify(document, null, 2));
  }
}
