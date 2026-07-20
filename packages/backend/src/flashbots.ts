import fs from "node:fs";
import path from "node:path";
import {
  keccak256,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Block,
  type Hex,
} from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { publicClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { nonceManager } from "./nonce.js";
import { cappedReplacementFees, effectiveTipGwei, nextReplacementFee, resolveGas } from "./logic.js";
import {
  JOURNAL_CONFIRMATION_DEPTH,
  JournalCorruptionError,
  SubmissionFlightJournal,
  type JournalBlockEvidence,
  type JournalConfirmedSpend,
  type JournalDeliveryAttempt,
  type JournalFlight,
  type JournalPaymentMetadata,
  type JournalReconciliation,
  type PrivateCohortMetadata,
  type SubmissionPurpose,
} from "./submission-journal.js";
import { logger } from "./logger.js";
import { AtomicWriteCommittedError, writeFileAtomicDurableSync } from "./durability.js";
import { redactSensitiveText } from "./redaction.js";
import { decodeCoinbasePayment } from "./coinbase-payer.js";
import { configuredEthToWei, configuredGweiToWei } from "./amounts.js";

export type {
  JournalConfirmedSpend,
  JournalPaymentMetadata,
  PrivateCohortMetadata,
  PrivateCohortRole,
  SubmissionPurpose,
} from "./submission-journal.js";

export interface TxIntent {
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional gas override; estimated if omitted. */
  gas?: bigint;
}

export interface SubmitResult {
  ok: boolean;
  /** A signed transaction was handed to at least one delivery path, but no path
   * acknowledged it. The nonce/hash must be retained because transport failure
   * is ambiguous: the remote endpoint may have accepted the request. */
  uncertain?: boolean;
  simulated: boolean;
  txHash?: Hex;
  replacementUuid?: string;
  replacementUuids?: string[];
  lineageId?: string;
  maxPrivateTargetBlock?: bigint;
  replacementUuidCohortSize?: number;
  retryImmediately?: boolean;
  bundleHash?: string;
  targetBlock?: bigint;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  error?: string;
  /** The tx was prepared + queued into an open all-mode batch rather
   *  than sent immediately. Its deterministic txHash is already known; delivery
   *  success and bundleHash are reconciled later by flushBundle. */
  queued?: boolean;
}

export interface ReplacementOptions {
  nonce: number;
  priorMaxFeePerGas: bigint;
  priorMaxPriorityFeePerGas: bigint;
  priorTxHash?: Hex;
  lineageId?: string;
  /** Explicit operator-approved ceilings for replacement escalation. */
  maxFeePerGasCap?: bigint;
  maxPriorityFeePerGasCap?: bigint;
  /** Stable UUID for Flashbots relay replacement/cancellation. Other builders
   * receive ordinary bundles unless they gain an explicit capability adapter. */
  replacementUuid?: string;
  replacementUuids?: readonly string[];
}

export type DeliveryState = "accepted" | "rejected" | "ambiguous" | "untouched";

export interface DeliveryOutcome {
  state: DeliveryState;
  channel: "public" | "private";
  endpoint: string;
  error?: string;
  bundleHash?: string;
  targetBlock?: bigint;
  replacementUuid?: string;
  replacementUuids?: string[];
}

export class RpcRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcRejectedError";
  }
}

/** Recovery must never turn a previously affordable signed obligation into an
 * under-collateralized replay after the wallet balance or configured floor has
 * changed. The WAL remains intact so an operator can fund the wallet or lower
 * the floor and retry the exact signed hashes later. */
export class RecoveryFloorError extends Error {
  constructor(
    readonly wallet: Address,
    readonly blockNumber: bigint,
    readonly balanceWei: bigint,
    readonly maximumExposureWei: bigint,
    readonly floorWei: bigint,
  ) {
    super(
      `submission recovery blocked at block ${blockNumber}: balance ${balanceWei} wei `
      + `cannot cover ${maximumExposureWei} wei of live maximum exposure plus `
      + `${floorWei} wei configured floor`,
    );
    this.name = "RecoveryFloorError";
  }
}

export class BuilderNonceRetirementError extends Error {
  constructor(readonly nonce: number, reason: string) {
    super(`builder-incentive nonce ${nonce} retirement blocked: ${reason}`);
    this.name = "BuilderNonceRetirementError";
  }
}

export class UntrackedPendingPrefixError extends Error {
  constructor(readonly wallet: Address, readonly nonce: number) {
    super(
      `submission recovery blocked: pending nonce ${nonce} for ${wallet} is not represented in the durable journal`,
    );
    this.name = "UntrackedPendingPrefixError";
  }
}

class SubmissionRecoveryAbortedError extends Error {
  constructor() {
    super("submission recovery aborted before delivery");
    this.name = "SubmissionRecoveryAbortedError";
  }
}

function throwIfRecoveryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SubmissionRecoveryAbortedError();
}

/** Make cancellation responsive while a read-only recovery prerequisite is in
 * flight. The losing RPC remains observed, but its eventual result cannot reopen
 * delivery authority after Stop has returned. */
async function beforeRecoveryAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfRecoveryAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(new SubmissionRecoveryAbortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

const submissionJournal = new SubmissionFlightJournal(
  appConfig.dataDir,
  "submission-flights",
  () => runtime.chainId,
);

function verifiedChainId(): number {
  const chainId = runtime.chainId;
  if (!Number.isSafeInteger(chainId) || (chainId ?? 0) <= 0) {
    throw new Error("transaction signing requires a verified positive chain ID");
  }
  return chainId!;
}

function nonceSnapshot(flight: JournalFlight) {
  const boundedPrivateAmbiguity = flight.state === "ambiguous"
    && !flight.publicExposure
    && !flight.nonceConflict
    && flight.maxPrivateTargetBlock !== undefined;
  return {
    nonce: flight.nonce,
    txHash: flight.txHash,
    state: flight.state === "prepared"
      ? "prepared" as const
      : flight.state === "accepted"
        ? "accepted" as const
        : boundedPrivateAmbiguity
          ? "accepted" as const
          : "ambiguous" as const,
    publicExposure: flight.publicExposure || Boolean(
      flight.state === "prepared" && flight.recovery.publicAuthorized,
    ),
    maxPrivateTargetBlock: flight.maxPrivateTargetBlock === undefined
      ? undefined
      : BigInt(flight.maxPrivateTargetBlock),
    // Only the hash-bound journal may release a durable private target. A
    // height-only NonceManager sync cannot detect a lateral reorg that replaces
    // the last authorized block.
    retainBeyondPrivateTarget: flight.nonceConflict
      || flight.maxPrivateTargetBlock !== undefined
      || flight.recovery.validThroughBlock !== undefined,
    observedConsumedAtBlock: flight.observedConsumedAtBlock === undefined
      ? undefined
      : BigInt(flight.observedConsumedAtBlock),
  };
}

function reconcileAtCounts(
  address: Address,
  confirmedNonce: number,
  pendingNonce: number,
  blockEvidence: JournalBlockEvidence,
): JournalReconciliation {
  const reconciliation = submissionJournal.reconcile(
    address,
    confirmedNonce,
    pendingNonce,
    blockEvidence,
  );
  const retainedNonces = new Set(reconciliation.retained.map((flight) => flight.nonce));
  nonceManager.releaseJournalExpired([
    ...new Set(reconciliation.expired.flatMap((flight) =>
      // A signed builder deadline ends value transfer, not nonce validity. An
      // old reverting payer raw must be retired by confirmed same-nonce
      // consumption and can never enter the ordinary expiry-release path.
      retainedNonces.has(flight.nonce) || flight.purpose === "builder-incentive"
        ? []
        : [flight.nonce])),
  ]);
  return reconciliation;
}

/** Select one canonical tip and retain the bounded parent-hash chain needed for
 * the journal's three-observation finality proof. All account state used below is
 * queried by this tip hash, never merely by a reusable block height. */
async function journalBlockEvidence(): Promise<JournalBlockEvidence> {
  let cursor = await publicClient.getBlock({ blockTag: "latest" });
  if (cursor.number === null || cursor.hash === null) {
    throw new Error("journal reconciliation requires a mined canonical block");
  }
  const number = cursor.number;
  const canonicalHashes: Hex[] = [cursor.hash];
  const required = Number(JOURNAL_CONFIRMATION_DEPTH);
  while (canonicalHashes.length < required && cursor.number > 0n) {
    canonicalHashes.push(cursor.parentHash);
    if (canonicalHashes.length >= required || cursor.number === 1n) break;
    const expectedNumber = cursor.number - 1n;
    const parent = await publicClient.getBlock({ blockHash: cursor.parentHash });
    if (
      parent.number !== expectedNumber
      || parent.hash?.toLowerCase() !== cursor.parentHash.toLowerCase()
    ) {
      throw new Error("journal reconciliation could not verify canonical block ancestry");
    }
    cursor = parent;
  }
  return { number, canonicalHashes };
}

async function validateJournalSigners(address: Address): Promise<void> {
  const flights = submissionJournal.load(address);
  try {
    const signers = await Promise.all(flights.map((flight) =>
      recoverTransactionAddress({
        serializedTransaction: flight.rawSignedTx as Parameters<
          typeof recoverTransactionAddress
        >[0]["serializedTransaction"],
      }),
    ));
    if (signers.some((signer) => signer.toLowerCase() !== address.toLowerCase())) {
      throw new Error("signed transaction wallet does not match journal wallet");
    }
  } catch (error) {
    throw new JournalCorruptionError(submissionJournal.pathFor(address), error);
  }
}

/** Reconcile durable flights without mistaking txpool visibility or one tip for
 * finality. Pending/latest advance allocation immediately, while raw exposure is
 * retained through the journal's confirmation window for strategy accounting. */
export async function reconcileSubmissionJournal(address: Address): Promise<JournalReconciliation> {
  await validateJournalSigners(address);
  const blockEvidence = await journalBlockEvidence();
  const currentBlockHash = blockEvidence.canonicalHashes[0]!;
  const [confirmedNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({
      address,
      blockHash: currentBlockHash,
      requireCanonical: true,
    }),
    publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return reconcileAtCounts(address, confirmedNonce, pendingNonce, blockEvidence);
}

/**
 * Remove finalized WAL tombstones only after the strategy has made their
 * one-shot bookkeeping durable (or their authorization scope has ended).
 */
export function acknowledgeFinalizedSubmissionFlights(
  address: Address,
  txHashes: readonly Hex[],
): void {
  if (txHashes.length === 0) return;
  submissionJournal.removeMany(address, txHashes);
}

/** Bind receipt-priced spend to the exact finalized raw before any in-memory
 * metric is changed. A conflicting retry is corruption, not an additive spend. */
export function annotateFinalizedSubmissionSpend(
  address: Address,
  txHash: Hex,
  confirmedSpend: JournalConfirmedSpend,
): void {
  const flight = submissionJournal.load(address).find((candidate) =>
    candidate.txHash.toLowerCase() === txHash.toLowerCase());
  if (!flight || flight.state !== "confirmed") {
    throw new Error(`cannot annotate non-final submission ${txHash}`);
  }
  if (
    flight.confirmedSpend !== undefined
    && (
      flight.confirmedSpend.epoch !== confirmedSpend.epoch
      || flight.confirmedSpend.spendWei !== confirmedSpend.spendWei
    )
  ) {
    throw new Error(`submission journal confirmed-spend conflict for ${txHash}`);
  }
  if (flight.confirmedSpend !== undefined) return;
  submissionJournal.update(address, txHash, { confirmedSpend });
}

function builderDeadlineCanonicallyFinal(
  flight: JournalFlight,
  currentBlock: bigint,
): boolean {
  if (
    flight.purpose !== "builder-incentive"
    || flight.recovery.validThroughBlock === undefined
    || flight.observedConsumedAtBlock !== undefined
  ) return false;
  const deadline = BigInt(flight.recovery.validThroughBlock);
  return currentBlock >= deadline
    && currentBlock - deadline + 1n >= JOURNAL_CONFIRMATION_DEPTH;
}

function isInertSelfTransfer(flight: JournalFlight, address: Address): boolean {
  return (flight.purpose === "nonce-retirement" || flight.purpose === undefined)
    && flight.recovery.publicAuthorized
    && flight.obligation.to.toLowerCase() === address.toLowerCase()
    && flight.obligation.data === "0x"
    && BigInt(flight.obligation.valueWei) === 0n;
}

function signedGeneralFeesWithinCurrentLimits(
  flight: JournalFlight,
  baseFeePerGas: bigint,
): boolean {
  const gas = resolveGas(runtime.strategy, false);
  const maxBaseFeeWei = configuredGweiToWei(gas.maxBaseFeeGwei);
  if (baseFeePerGas > maxBaseFeeWei) return false;
  const priorityCapGwei = Math.max(
    gas.priorityFeeGwei,
    gas.replacementPriorityFeeCapGwei ?? gas.priorityFeeGwei,
  );
  const priorityCapWei = configuredGweiToWei(priorityCapGwei);
  const maxFeeCapWei = maxBaseFeeWei * 2n + priorityCapWei;
  return BigInt(flight.obligation.maxPriorityFeePerGas) <= priorityCapWei
    && BigInt(flight.obligation.maxFeePerGas) <= maxFeeCapWei;
}

interface BuilderRetirementCandidate {
  builder: JournalFlight;
  prior: JournalFlight;
}

function retirementBuilderByNonce(
  reconciliation: JournalReconciliation,
): Map<number, BuilderRetirementCandidate> {
  const byNonce = new Map<number, JournalFlight[]>();
  for (const flight of reconciliation.retained) {
    const group = byNonce.get(flight.nonce) ?? [];
    group.push(flight);
    byNonce.set(flight.nonce, group);
  }
  const out = new Map<number, BuilderRetirementCandidate>();
  for (const [nonce, lineage] of byNonce) {
    const builders = lineage.filter((flight) => flight.purpose === "builder-incentive");
    // Every signed builder alternative at this nonce can preempt the filler.
    // Retiring after only the oldest deadline would race a newer still-live bid.
    if (
      builders.length === 0
      || !builders.every((flight) =>
        builderDeadlineCanonicallyFinal(flight, reconciliation.currentBlock))
    ) continue;
    const eligible = builders;
    const inert = lineage
      .filter((flight) => isInertSelfTransfer(flight, eligible[0]!.wallet))
      .sort((left, right) =>
        right.updatedAtMs - left.updatedAtMs || right.createdAtMs - left.createdAtMs);
    const conflicting = lineage.find((flight) =>
      flight.purpose !== "builder-incentive"
      && !isInertSelfTransfer(flight, eligible[0]!.wallet));
    if (conflicting) {
      throw new BuilderNonceRetirementError(
        nonce,
        "same nonce already has a non-retirement signed alternative; retaining every lineage",
      );
    }
    eligible.sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs || right.createdAtMs - left.createdAtMs);
    const latestRetirement = inert[0];
    if (latestRetirement?.state === "prepared") continue;
    if (
      latestRetirement !== undefined
      && Date.now() - latestRetirement.updatedAtMs < RECOVERY_REBROADCAST_AFTER_MS
    ) continue;
    out.set(nonce, {
      builder: eligible[0]!,
      prior: latestRetirement ?? eligible[0]!,
    });
  }
  return out;
}

async function retirementSpendAuthorized(
  address: Address,
  nonce: number,
  quote: { valueWei: bigint; gasWei: bigint },
  signal?: AbortSignal,
): Promise<true | string> {
  throwIfRecoveryAborted(signal);
  if (runtime.strategy.dryRun) return "dry-run mode forbids nonce-retirement delivery";
  if (!runtime.unlocked || runtime.account?.address.toLowerCase() !== address.toLowerCase()) {
    return "wallet is locked or changed before nonce-retirement authorization";
  }
  const block = await beforeRecoveryAbort(
    publicClient.getBlock({ blockTag: "latest" }),
    signal,
  );
  if (block.number === null) return "latest block is not mined";
  const balanceWei = await beforeRecoveryAbort(
    publicClient.getBalance({ address, blockNumber: block.number }),
    signal,
  );
  throwIfRecoveryAborted(signal);
  const live = submissionJournal.load(address);
  const totalExposure = liveMaximumExposure(live);
  const priorNonceExposure = live
    .filter((flight) => flight.nonce === nonce)
    .reduce((maximum, flight) => {
      const exposure = journalFlightMaximumExposure(flight);
      return exposure > maximum ? exposure : maximum;
    }, 0n);
  const replacementExposure = quote.valueWei + quote.gasWei;
  const nextNonceExposure = replacementExposure > priorNonceExposure
    ? replacementExposure
    : priorNonceExposure;
  const maximumExposureWei = totalExposure - priorNonceExposure + nextNonceExposure;
  const floorWei = configuredEthToWei(runtime.strategy.minBalanceEth);
  return balanceWei >= maximumExposureWei + floorWei
    ? true
    : `balance ${balanceWei} wei cannot cover ${maximumExposureWei} wei of live maximum exposure plus ${floorWei} wei configured floor`;
}

async function retireFinalizedBuilderNonces(
  reconciliation: JournalReconciliation,
  signal?: AbortSignal,
): Promise<boolean> {
  const candidates = retirementBuilderByNonce(reconciliation);
  if (candidates.size === 0) return false;
  assertPendingPrefixIsTracked(reconciliation);
  if (bundleQueue !== null && bundleQueue.length > 0) {
    throw new BuilderNonceRetirementError(
      Math.min(...candidates.keys()),
      "an active transaction batch already contains prepared work",
    );
  }
  const account = runtime.account;
  if (
    !account
    || account.address.toLowerCase()
      !== candidates.values().next().value?.builder.wallet.toLowerCase()
  ) {
    throw new BuilderNonceRetirementError(
      Math.min(...candidates.keys()),
      "wallet is locked or changed",
    );
  }
  for (const [nonce, candidate] of [...candidates].sort(([left], [right]) => left - right)) {
    throwIfRecoveryAborted(signal);
    const { builder, prior } = candidate;
    const result = await submitTx(
      { to: account.address, data: "0x", value: 0n, gas: 21_000n },
      {
        dryRun: false,
        race: true,
        purpose: "nonce-retirement",
        publicOnly: true,
        signal,
        replacement: {
          nonce,
          priorMaxFeePerGas: BigInt(prior.obligation.maxFeePerGas),
          priorMaxPriorityFeePerGas: BigInt(prior.obligation.maxPriorityFeePerGas),
          priorTxHash: prior.txHash,
          lineageId: builder.lineage.id,
        },
        authorize: async (quote) => {
          const authorized = await retirementSpendAuthorized(account.address, nonce, quote, signal);
          return authorized === true
            ? { ok: true, stillValid: () => !signal?.aborted
                && runtime.unlocked
                && runtime.account?.address.toLowerCase() === account.address.toLowerCase() }
            : { ok: false, error: authorized };
        },
      },
    );
    if (!result.ok) {
      throw new BuilderNonceRetirementError(
        nonce,
        result.error ?? "same-nonce inert replacement was not delivered",
      );
    }
    logger.warn(
      `builder-incentive nonce ${nonce} remains fenced while its public inert replacement confirms`,
    );
  }
  return true;
}

/** Explicit, mutating recovery delivery. Call only from an operator-authorized
 * engine start/JIT-arm path; unlock/preflight reconciliation stays read-only. */
export async function recoverPreparedSubmissions(
  address: Address,
  signal?: AbortSignal,
  authorizeFlight?: (flight: JournalFlight) => Promise<boolean>,
): Promise<JournalReconciliation> {
  // Hash-bound recovery replaces the NonceManager's in-memory snapshot and may
  // expire undisclosed WAL entries. Neither mutation may interleave work that
  // has already been reserved/signed in the current live batch.
  if (bundleQueue !== null && bundleQueue.length > 0) {
    throw new Error("submission recovery cannot interleave a non-empty transaction batch");
  }
  throwIfRecoveryAborted(signal);
  let reconciliation = await beforeRecoveryAbort(
    reconcileSubmissionJournal(address),
    signal,
  );
  nonceManager.initializeFromJournal(
    address,
    reconciliation.confirmedNonce,
    reconciliation.pendingNonce,
    reconciliation.retained.map(nonceSnapshot),
  );
  const retired = await retireFinalizedBuilderNonces(reconciliation, signal);
  if (retired) {
    reconciliation = await beforeRecoveryAbort(
      reconcileSubmissionJournal(address),
      signal,
    );
    nonceManager.initializeFromJournal(
      address,
      reconciliation.confirmedNonce,
      reconciliation.pendingNonce,
      reconciliation.retained.map(nonceSnapshot),
    );
  }
  const builderNonces = new Set(reconciliation.retained
    .filter((flight) => flight.purpose === "builder-incentive")
    .map((flight) => flight.nonce));
  let feeBlock: Promise<Block> | undefined;
  const authorizeWithRetirementPolicy = async (flight: JournalFlight): Promise<boolean> => {
    if (builderNonces.has(flight.nonce) && isInertSelfTransfer(flight, address)) {
      throwIfRecoveryAborted(signal);
      if (
        runtime.strategy.dryRun
        || !runtime.unlocked
        || runtime.account?.address.toLowerCase() !== address.toLowerCase()
      ) {
        throw new BuilderNonceRetirementError(
          flight.nonce,
          "wallet authority was withdrawn before prepared retirement replay",
        );
      }
      feeBlock ??= publicClient.getBlock({ blockNumber: reconciliation.currentBlock });
      const block = await beforeRecoveryAbort(feeBlock, signal);
      if (!signedGeneralFeesWithinCurrentLimits(flight, block.baseFeePerGas ?? 0n)) {
        throw new BuilderNonceRetirementError(
          flight.nonce,
          "prepared retirement fees exceed current general cleanup caps",
        );
      }
      return true;
    }
    if (authorizeFlight && !(await authorizeFlight(flight))) return false;
    return true;
  };
  return recoverJournalFlights(reconciliation, signal, authorizeWithRetirementPolicy);
}

// NonceManager can also recover independently when callers sync it before the
// strategy layer has rebuilt semantic payment state.
(nonceManager as unknown as {
  setRecoveryHook?: (hook: (
    address: Address,
    confirmedNonce: number,
    pendingNonce: number,
    currentBlock?: bigint,
  ) => Promise<readonly ReturnType<typeof nonceSnapshot>[]>) => void;
}).setRecoveryHook?.(async (address) => {
  // NonceManager's ordinary number-based sync cannot establish canonical
  // continuity. Rebuild its initial snapshots only from the hash-bound journal.
  const reconciliation = await reconcileSubmissionJournal(address);
  return reconciliation.retained.map(nonceSnapshot);
});

// --- Flashbots reputation signer (identity only; holds no funds) ---

function parseAuthSignerKey(contents: string, keyPath: string): PrivateKeyAccount {
  if (!/^0x[0-9a-fA-F]{64}$/.test(contents)) {
    throw new Error(`invalid Flashbots reputation private key: ${keyPath}`);
  }
  try {
    return privateKeyToAccount(contents as Hex);
  } catch (error) {
    throw new Error(`invalid Flashbots reputation private key: ${keyPath}`, { cause: error });
  }
}

function loadOrCreateAuthSigner(keyPath: string): PrivateKeyAccount {
  if (fs.existsSync(keyPath)) {
    // Do not trim: accepting a prefix/suffix would make a malformed identity
    // file look valid and hide partial/manual writes.
    return parseAuthSignerKey(fs.readFileSync(keyPath, "utf8"), keyPath);
  }

  const privateKey = generatePrivateKey();
  const signer = parseAuthSignerKey(privateKey, keyPath);
  try {
    writeFileAtomicDurableSync(keyPath, privateKey, 0o600);
  } catch (error) {
    if (!(error instanceof AtomicWriteCommittedError)) throw error;
    // The rename is visible and this process has the exact usable identity.
    // Surface the unconfirmed crash durability without regenerating or
    // truncating the key that was already committed.
    runtime.setJournalHealth(false, error.message);
    logger.error(error.message);
  }
  logger.info("Generated a new Flashbots reputation key.");
  return signer;
}
// Lazily initialized so switching mode from public→mainnet at runtime works.
let _signer: PrivateKeyAccount | null = null;
let _signerPath: string | null = null;
function getAuthSigner(): PrivateKeyAccount {
  const keyPath = path.join(appConfig.dataDir, "flashbots-signer.key");
  if (!_signer || _signerPath !== keyPath) {
    const signer = loadOrCreateAuthSigner(keyPath);
    _signer = signer;
    _signerPath = keyPath;
  }
  return _signer;
}

/** POST a bundle RPC to one builder/relay. `url` defaults to the Flashbots relay
 *  (the only endpoint that implements eth_callBundle for simulation). */
async function flashbotsRpc(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  url: string = appConfig.flashbotsRelayUrl,
  deadlineMs?: number,
): Promise<any> {
  const signer = getAuthSigner();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  // Flashbots requires this reputation signature; other builders accept or ignore it.
  const signature = `${signer.address}:${await signer.signMessage({
    message: keccak256(toHex(body)),
  })}`;
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new SubmissionDeadlineError(`${method} missed its submission deadline`);
  }
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "X-Flashbots-Signature": signature,
    },
    body,
  });
  let json: { error?: { message: string }; result?: any };
  try {
    json = (await res.json()) as { error?: { message: string }; result?: any };
  } catch (error) {
    throw new Error(`${method} @${builderEndpointLabel(url)} returned an unreadable response`, { cause: error });
  }
  if (json.error) {
    throw new RpcRejectedError(
      `${method} @${builderEndpointLabel(url)}: ${redactSensitiveText(json.error.message)}`,
    );
  }
  if (res.ok === false) {
    throw new Error(`${method} @${builderEndpointLabel(url)} returned HTTP ${res.status}`);
  }
  return json.result;
}

// --- fee + gas ---

// Pure — takes an already-fetched block so the caller can share one read across
// the fee calc, the gas estimate, and the target-block derivation.
function computeFees(offense: boolean, block: Block): {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
} {
  const gas = resolveGas(runtime.strategy, offense);
  const baseFee = block.baseFeePerGas ?? 0n;

  // Priority tip: static by default, or scaled up by block fullness when the
  // dynamic-tip edge is enabled (helps win inclusion in contested blocks).
  const tipGwei = effectiveTipGwei(gas, block.gasUsed, block.gasLimit);
  const priority = configuredGweiToWei(tipGwei);
  const maxFeePerGas = baseFee * 2n + priority;
  return { maxFeePerGas, maxPriorityFeePerGas: priority, baseFee };
}

async function estimateGas(account: Address, intent: TxIntent): Promise<bigint> {
  if (intent.gas) return intent.gas;
  const est = await publicClient.estimateGas({
    account,
    to: intent.to,
    data: intent.data,
    value: intent.value,
  });
  return (est * 12n) / 10n; // +20% buffer
}

async function signTx(
  account: PrivateKeyAccount,
  intent: TxIntent,
  nonce: number,
  gas: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<Hex> {
  return account.signTransaction({
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: verifiedChainId(),
    type: "eip1559",
  });
}

/**
 * Build, (optionally simulate), and submit a single tx.
 * - dryRun: builds + simulates, never sends.
 * - mainnet: submits as a Flashbots bundle (block+1, block+2) after eth_callBundle sim.
 * - local: broadcasts the raw tx to the node (anvil).
 */
const RELAY_TIMEOUT_MS = 10_000;
// Bundle submission is time-critical and fans out to several builders: a slow or
// dead endpoint must not hold up the caller (submitTx awaits all attempts, so a
// 10s hang would stall every later token in a boundary race). Healthy builders
// ack in <1s, and one that can't answer before the block is built is useless to us.
const SEND_BUNDLE_TIMEOUT_MS = 3_000;
// Whole-bundle validation is valuable, but it sits directly in front of both
// private fanout and the public safety mirror. Give the relay a sub-slot budget,
// then fail open to the per-transaction checks if it is unavailable.
const BUNDLE_SIM_TIMEOUT_MS = 500;

class SubmissionDeadlineError extends Error {}

async function beforeSubmissionDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number | undefined,
  label: string,
): Promise<T> {
  if (deadlineMs === undefined) return promise;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new SubmissionDeadlineError(`${label} missed its submission deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SubmissionDeadlineError(`${label} missed its submission deadline`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function flashbotsRpcWithTimeout(
  method: string,
  params: unknown[],
  url?: string,
  timeoutMs: number = RELAY_TIMEOUT_MS,
  deadlineMs?: number,
): Promise<any> {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new SubmissionDeadlineError(`${method} missed its submission deadline`);
  }
  const abort = new AbortController();
  const effectiveTimeoutMs = deadlineMs === undefined
    ? timeoutMs
    : Math.max(0, Math.min(timeoutMs, deadlineMs - Date.now()));
  const timer = setTimeout(() => abort.abort(), effectiveTimeoutMs);
  try {
    return await flashbotsRpc(method, params, abort.signal, url, deadlineMs);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Simulate an intent whose validity depends on a FUTURE block timestamp (the
 * pre-boundary races: the epoch hasn't rolled / the audit hasn't expired yet, so a
 * normal sim against "now" would wrongly revert). We re-run the call at `atTime`
 * via eth_call block overrides, which reproduces the exact context the tx will
 * execute in. Returns null when the sim passed, a revert message when the contract
 * rejected it, or throws if the RPC can't do block overrides (caller decides).
 */
async function simulateAtTimestamp(
  from: Address,
  intent: TxIntent,
  gas: bigint,
  atTime: bigint,
): Promise<string | null> {
  try {
    await (publicClient as unknown as {
      request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
    }).request({
      method: "eth_call",
      params: [
        { from, to: intent.to, data: intent.data, value: toHex(intent.value), gas: toHex(gas) },
        "latest",
        {}, // no state overrides — the wallet's real balance applies
        { time: toHex(atTime) }, // block overrides: run at the boundary/expiry instant
      ],
    });
    return null; // simulated clean
  } catch (err) {
    const e = err as { message?: string; data?: unknown; code?: number };
    const msg = e.message ?? String(err);
    // A contract revert => the action is genuinely invalid: report it.
    if (e.data !== undefined || /revert|execution reverted/i.test(msg)) return msg;
    // Anything else (RPC lacks block-override support, transport error) => rethrow
    // so the caller can decide whether to proceed unsimulated.
    throw err;
  }
}

// --- Prepared submission batching (all modes) ---
// Every Citizen you hold is owned by the same wallet, so multiple payments/audits
// in one tick share a single nonce sequence. Sent as independent single-tx
// bundles, only the first (nonce == chain nonce) is independently executable; the
// rest carry a nonce gap and cannot execute unless a builder also includes all
// preceding nonces. Collecting a tick's txs into ONE
// atomic multi-tx bundle keeps the nonces valid in order and gives builders one
// coherent sequence to consider. Public/local use the same preparation window so
// every due transaction is signed before one shared future-timestamp wait.
interface QueuedTx {
  wallet: Address;
  signed: Hex;
  txHash: Hex;
  lineageId: string;
  nonce: number;
  race: boolean;
  reserved: boolean;
  journaled: boolean;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  intent: TxIntent;
  simTimestamp?: bigint;
  signal?: AbortSignal;
  replacement?: ReplacementOptions;
  plannedMaxPrivateTargetBlock?: bigint;
  /** Only explicit optional private-cohort roles may be allowlisted to revert. */
  revertible: boolean;
  purpose?: SubmissionPurpose;
  privateCohort?: PrivateCohortMetadata;
  /** Payment baseline/campaign identity written under the same WAL barrier as
   * the signed transaction. */
  payment?: JournalPaymentMetadata;
  /** Last block authorized by the calldata of a private builder payment. */
  validThroughBlock?: bigint;
  /** Conservative WAL fence for signed private raws with no on-chain expiry.
   * Set before the first external disclosure so a crash cannot downgrade it. */
  unboundedPrivateExposure?: boolean;
  /** Optional cohort work must cross the delivery-start barrier before this
   * wall-clock instant. Mandatory members intentionally ignore this at flush so
   * an expired suffix can never suppress their public safety fallback. */
  deadlineMs?: number;
}
let bundleQueue: QueuedTx[] | null = null;

function validateSubmissionMetadata(intent: TxIntent, opts: {
  race?: boolean;
  simTimestamp?: bigint;
  revertible?: boolean;
  purpose?: SubmissionPurpose;
  privateCohort?: PrivateCohortMetadata;
  payment?: JournalPaymentMetadata;
  validThroughBlock?: bigint;
  deadlineMs?: number;
  replacement?: ReplacementOptions;
  publicOnly?: boolean;
}): void {
  if (
    opts.deadlineMs !== undefined
    && (!Number.isSafeInteger(opts.deadlineMs) || opts.deadlineMs < 0)
  ) {
    throw new Error("submission deadline must be a non-negative safe-integer timestamp");
  }
  const cohort = opts.privateCohort;
  if (opts.validThroughBlock !== undefined && opts.validThroughBlock < 0n) {
    throw new Error("builder-incentive block deadline must be non-negative");
  }
  if (opts.payment !== undefined && opts.purpose === "builder-incentive") {
    throw new Error("builder incentives cannot carry payment recovery metadata");
  }
  if (opts.purpose === "nonce-retirement") {
    if (
      opts.publicOnly !== true
      || opts.race !== true
      || opts.replacement === undefined
      || opts.privateCohort !== undefined
      || opts.revertible === true
      || opts.payment !== undefined
      || opts.validThroughBlock !== undefined
      || opts.simTimestamp !== undefined
      || intent.to.toLowerCase() !== runtime.account?.address.toLowerCase()
      || intent.data !== "0x"
      || intent.value !== 0n
    ) {
      throw new Error("nonce retirement requires one public-only zero-value same-nonce self-transfer");
    }
    return;
  }
  if (cohort === undefined) {
    if (
      opts.revertible === true
      || opts.purpose !== undefined
      || opts.validThroughBlock !== undefined
    ) {
      throw new Error("revertible/purpose submissions require an explicit private cohort");
    }
    return;
  }
  if (cohort.id.trim().length === 0 || cohort.id.length > 256) {
    throw new Error("private cohort id must contain 1-256 characters");
  }
  if (
    cohort.role !== "mandatory"
    && cohort.role !== "allowed-revert"
    && cohort.role !== "builder-incentive"
  ) {
    throw new Error(`unsupported private cohort role: ${String(cohort.role)}`);
  }
  if (cohort.role === "mandatory") {
    if (
      opts.revertible === true
      || opts.purpose !== undefined
      || opts.validThroughBlock !== undefined
    ) {
      throw new Error("mandatory private cohort members cannot be revertible or carry a purpose");
    }
    return;
  }
  if (opts.revertible !== true) {
    throw new Error(`${cohort.role} private cohort members must be explicitly revertible`);
  }
  if (cohort.role === "builder-incentive") {
    if (opts.race === true) {
      throw new Error("builder-incentive private cohort members cannot authorize public delivery");
    }
    if (opts.purpose !== "builder-incentive") {
      throw new Error("builder-incentive cohort role requires builder-incentive purpose");
    }
    if (opts.validThroughBlock === undefined) {
      throw new Error("builder-incentive submissions require an on-chain block deadline");
    }
    if (opts.simTimestamp === undefined) {
      throw new Error("builder-incentive submissions require an on-chain not-before timestamp");
    }
    const signedWindow = decodeCoinbasePayment(intent.data);
    if (
      signedWindow?.validThroughBlock !== opts.validThroughBlock
      || signedWindow.notBeforeTimestamp !== opts.simTimestamp
    ) {
      throw new Error("builder-incentive calldata does not match its on-chain validity window");
    }
  } else if (opts.purpose !== undefined || opts.validThroughBlock !== undefined) {
    throw new Error("allowed-revert cohort members cannot carry builder-incentive purpose");
  }
}

/** Validate the atomic structure before any WAL barrier or delivery request.
 * Optional roles form the batch tail: allowed-revert audits may retain their
 * hardened public fallback, while the final builder incentive is private-only. */
function validatePrivateCohorts(queue: readonly QueuedTx[]): string | undefined {
  const byId = new Map<string, Array<{ q: QueuedTx; index: number }>>();
  for (let index = 0; index < queue.length; index++) {
    const q = queue[index]!;
    if (!q.privateCohort) {
      if (q.revertible || q.purpose !== undefined) {
        return `nonce ${q.nonce} has private metadata without a cohort`;
      }
      continue;
    }
    const members = byId.get(q.privateCohort.id) ?? [];
    members.push({ q, index });
    byId.set(q.privateCohort.id, members);
  }
  for (const [id, members] of byId) {
    const first = members[0]!.index;
    const last = members[members.length - 1]!.index;
    if (last - first + 1 !== members.length) {
      return `private cohort ${id} must occupy one contiguous nonce range`;
    }
    if (!members.some(({ q }) => q.privateCohort?.role === "mandatory")) {
      return `private cohort ${id} has no mandatory member`;
    }
    const optionalIndex = members.findIndex(({ q }) => q.privateCohort?.role !== "mandatory");
    if (
      optionalIndex !== -1
      && members.slice(optionalIndex).some(({ q }) => q.privateCohort?.role === "mandatory")
    ) {
      return `private cohort ${id} must place mandatory members before optional members`;
    }
    const incentives = members.filter(({ q }) => q.privateCohort?.role === "builder-incentive");
    if (incentives.length > 1) return `private cohort ${id} has multiple builder incentives`;
    if (incentives.length === 1 && incentives[0]!.index !== last) {
      return `private cohort ${id} must place its builder incentive last`;
    }
    if (optionalIndex !== -1 && last !== queue.length - 1) {
      return `private cohort ${id} optional members must be the batch suffix`;
    }
  }
  return undefined;
}

/** A private limit may cut ordinary work, but never a declared atomic cohort.
 * If the raw prefix would contain only part of a cohort, cut before its first
 * member and repeat until every selected cohort is complete. */
function cohortSafePrivatePrefixLength(queue: readonly QueuedTx[], blockGasLimit: bigint): number {
  let limit = privateBundlePrefixLength(queue, blockGasLimit);
  for (;;) {
    let next = limit;
    const indicesByCohort = new Map<string, number[]>();
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!.privateCohort?.id;
      if (id === undefined) continue;
      const indices = indicesByCohort.get(id) ?? [];
      indices.push(index);
      indicesByCohort.set(id, indices);
    }
    for (const indices of indicesByCohort.values()) {
      const included = indices.filter((index) => index < limit).length;
      if (included > 0 && included < indices.length) next = Math.min(next, indices[0]!);
    }
    if (next === limit) return limit;
    limit = next;
  }
}

function optionalCohortDeadline(q: QueuedTx): number | undefined {
  return q.privateCohort?.role !== undefined
    && q.privateCohort.role !== "mandatory"
    ? q.deadlineMs
    : undefined;
}

function earliestOptionalCohortDeadline(queue: readonly QueuedTx[]): number | undefined {
  const deadlines = queue.flatMap((q) => {
    const deadline = optionalCohortDeadline(q);
    return deadline === undefined ? [] : [deadline];
  });
  return deadlines.length === 0
    ? undefined
    : deadlines.reduce((earliest, deadline) => deadline < earliest ? deadline : earliest);
}

/** Mandatory work ignores expiry for retention/public fallback, but its cutoff
 * still bounds every private-only prerequisite and dispatch attempt. */
function earliestQueuedDeadline(queue: readonly QueuedTx[]): number | undefined {
  const deadlines = queue.flatMap((q) => q.deadlineMs === undefined ? [] : [q.deadlineMs]);
  return deadlines.length === 0
    ? undefined
    : deadlines.reduce((earliest, deadline) => deadline < earliest ? deadline : earliest);
}

function privateTargetBlocksFor(
  queue: readonly QueuedTx[],
  firstTargetBlock: bigint,
): bigint[] {
  const candidates = [firstTargetBlock, firstTargetBlock + 1n];
  const signedDeadlines = queue.flatMap((q) =>
    q.validThroughBlock === undefined ? [] : [q.validThroughBlock]);
  if (signedDeadlines.length === 0) return candidates;
  const validThroughBlock = signedDeadlines.reduce((earliest, deadline) =>
    deadline < earliest ? deadline : earliest);
  return candidates.filter((block) => block <= validThroughBlock);
}

/** A builder payment that cannot execute in even the first fresh target block
 * has not crossed the WAL/delivery barrier. Drop that private-only suffix; the
 * mandatory/public-authorized prefix remains independently deliverable. */
function omitBuilderIncentivePastTarget(
  queue: QueuedTx[],
  out: Map<number, BundleTxResult>,
  firstTargetBlock: bigint,
): void {
  const cutoff = queue.findIndex((q) =>
    q.purpose === "builder-incentive"
    && q.validThroughBlock !== undefined
    && q.validThroughBlock < firstTargetBlock);
  if (cutoff === -1) return;
  failPreparedQueue(
    queue.splice(cutoff),
    out,
    `builder incentive expired before private target block ${firstTargetBlock}`,
  );
}

/** Optional cohort roles are a validated nonce suffix. Once any member misses
 * its cutoff, remove that member and every dependent higher nonce as one fresh
 * suffix. Mandatory members remain queued and retain their public fallback. */
function omitExpiredOptionalSuffix(
  queue: QueuedTx[],
  out: Map<number, BundleTxResult>,
  phase: string,
): boolean {
  const now = Date.now();
  const cutoff = queue.findIndex((q) => {
    const deadline = optionalCohortDeadline(q);
    return deadline !== undefined && now >= deadline;
  });
  if (cutoff === -1) return false;
  const omitted = queue.splice(cutoff);
  const deadlineError = `optional private cohort deadline expired before ${phase}`;
  try {
    failPreparedQueue(omitted, out, deadlineError);
  } catch (error) {
    // A pre-rename removal failure leaves the optional WAL entries live. Keep
    // their nonces fenced and never dispatch them, but do not let a cleanup I/O
    // failure suppress the retained mandatory payment/public fallback.
    const cleanupError = `${deadlineError}; journal cleanup failed and nonce remains fenced: ${(error as Error).message}`;
    for (const q of omitted) {
      out.set(q.nonce, {
        ok: false,
        retained: true,
        txHash: q.txHash,
        lineageId: q.lineageId,
        error: cleanupError,
      });
    }
    logger.error(cleanupError);
  }
  return true;
}

/** Open a batching window for every submission mode. */
export function beginBundle(): void {
  if (bundleQueue !== null) throw new Error("submission batch already open");
  bundleQueue = [];
}

export interface BundleTxResult {
  ok: boolean;
  /** Delivery was attempted but not acknowledged; retain and reconcile this
   * deterministic hash rather than recycling its nonce. */
  uncertain?: boolean;
  /** The prepared WAL entry remains fenced but no delivery request was started.
   * Strategy must preserve its queued liability without receipt tracking. */
  retained?: boolean;
  txHash?: Hex;
  bundleHash?: string;
  replacementUuid?: string;
  replacementUuids?: string[];
  lineageId?: string;
  maxPrivateTargetBlock?: bigint;
  replacementUuidCohortSize?: number;
  retryImmediately?: boolean;
  error?: string;
}

/** Close an open batch that is known not to have left this process. Unlike an
 * attempted flush, discarding is a definite pre-send failure, so fresh contiguous
 * reservations can be released safely and callers can reconcile every entry. */
export function discardBundle(error = "bundle discarded before submission"): Map<number, BundleTxResult> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<number, BundleTxResult>();
  if (!queue || queue.length === 0) return out;
  queue.sort((a, b) => a.nonce - b.nonce);
  removeJournalFlights(queue);
  releaseQueuedReservations(queue);
  for (const q of queue) out.set(q.nonce, { ok: false, error });
  return out;
}

interface BundleSimulationIssue {
  failure: string;
  /** Null means the relay reported a bundle-wide error rather than a tx result. */
  index: number | null;
}

class BundleSimulationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleSimulationUnavailableError";
  }
}

/** Extract the first non-allowlisted failure. Bundle-wide errors and every
 * ordinary/mandatory transaction always fail closed. */
function bundleSimulationIssue(
  sim: any,
  allowedRevertIndices: ReadonlySet<number> = new Set(),
  expectedResultCount?: number,
): BundleSimulationIssue | null {
  if (sim?.error) return { failure: String(sim.error), index: null };
  const results = sim?.results;
  if (
    !Array.isArray(results)
    || (expectedResultCount !== undefined && results.length !== expectedResultCount)
    || results.some((result) => !result || typeof result !== "object" || Array.isArray(result))
  ) {
    const actual = Array.isArray(results) ? results.length.toString() : "missing";
    throw new BundleSimulationUnavailableError(
      `bundle simulation returned ${actual} valid result(s); expected ${expectedResultCount ?? "an array"}`,
    );
  }
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result?.error && !result?.revert) continue;
    if (allowedRevertIndices.has(index)) continue;
    return { failure: String(result.error ?? result.revert), index };
  }
  return null;
}

function bundleHashFromResult(result: any): string | undefined {
  if (typeof result === "string") return result;
  return typeof result?.bundleHash === "string" ? result.bundleHash : undefined;
}

function releaseQueuedReservations(queue: readonly QueuedTx[]): void {
  const reservedNonces = queue.filter((q) => q.reserved).map((q) => q.nonce);
  if (reservedNonces.length > 0) nonceManager.releaseContiguous(reservedNonces);
}

function abortQueuedBeforeDelivery(
  queue: readonly QueuedTx[],
  out: Map<number, BundleTxResult>,
): boolean {
  if (!queue.some((q) => q.signal?.aborted)) return false;
  const error = "bundle submission aborted before delivery";
  for (const q of queue) out.set(q.nonce, { ok: false, error });
  removeJournalFlights(queue);
  releaseQueuedReservations(queue);
  return true;
}

function isAlreadyKnownError(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? String(err);
  return /already known|known transaction|already imported/i.test(message);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("delay aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("delay aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait until a future-valid transaction can safely enter the public mempool.
 * Chunking keeps very distant timestamps within Node's timer range; AbortSignal
 * makes outstanding waits cancellable and deterministic under fake timers. */
async function waitUntilTimestamp(atTime: bigint | undefined, signal?: AbortSignal): Promise<void> {
  if (atTime === undefined) return;
  const targetMs = atTime * 1_000n;
  while (targetMs > BigInt(Date.now())) {
    const remaining = targetMs - BigInt(Date.now());
    const chunk = Number(remaining > 2_000_000_000n ? 2_000_000_000n : remaining);
    await abortableDelay(chunk, signal);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const RECOVERY_REBROADCAST_AFTER_MS = 30_000;

function journalFlightMaximumExposure(flight: JournalFlight): bigint {
  return BigInt(flight.obligation.valueWei)
    + BigInt(flight.obligation.gasLimit) * BigInt(flight.obligation.maxFeePerGas);
}

/** Replacements at one wallet nonce are mutually exclusive. Reserve the most
 * expensive alternative once, but add every distinct nonce cumulatively. */
function liveMaximumExposure(flights: readonly JournalFlight[]): bigint {
  const maximumByNonce = new Map<string, bigint>();
  for (const flight of flights) {
    const key = `${flight.wallet.toLowerCase()}:${flight.nonce}`;
    const exposure = journalFlightMaximumExposure(flight);
    const current = maximumByNonce.get(key) ?? 0n;
    if (exposure > current) maximumByNonce.set(key, exposure);
  }
  return [...maximumByNonce.values()].reduce((sum, exposure) => sum + exposure, 0n);
}

function isRecoveryCandidate(flight: JournalFlight, now: number): boolean {
  return flight.observedConsumedAtBlock === undefined
    && flight.purpose !== "builder-incentive"
    && flight.recovery.publicAuthorized
    && (flight.state === "prepared"
      || (
        flight.state === "ambiguous"
        && !flight.publicExposure
        && flight.attempts.length > 0
        && flight.attempts.every((attempt) => attempt.state === "rejected")
        && now - flight.updatedAtMs >= RECOVERY_REBROADCAST_AFTER_MS
      ));
}

/** Only the newest retained alternative at a nonce is eligible for replay.
 * Replaying an older prepared replacement after its successor was accepted
 * would manufacture a same-nonce conflict on every later recovery pass. */
function recoveryCandidates(
  flights: readonly JournalFlight[],
  now: number,
): JournalFlight[] {
  const latestByNonce = new Map<string, JournalFlight>();
  for (const flight of flights) {
    const key = `${flight.wallet.toLowerCase()}:${flight.nonce}`;
    const current = latestByNonce.get(key);
    if (
      !current
      || flight.updatedAtMs > current.updatedAtMs
      || (
        flight.updatedAtMs === current.updatedAtMs
        && flight.createdAtMs >= current.createdAtMs
      )
    ) {
      latestByNonce.set(key, flight);
    }
  }
  return [...latestByNonce.values()]
    .filter((flight) => isRecoveryCandidate(flight, now))
    .sort((left, right) => left.nonce - right.nonce);
}

/** Keep exact replays already covered by the node's pending sequence, then only
 * extend that sequence one nonce at a time. `pendingNonce` is the first nonce
 * not represented by the executable txpool prefix; broadcasting above it would
 * create a queued transaction whose authorization could be stale when the gap
 * is eventually repaired. Clamp against confirmed for inconsistent RPC views. */
function contiguousRecoveryCandidates(
  candidates: readonly JournalFlight[],
  confirmedNonce: number,
  pendingNonce: number,
): JournalFlight[] {
  let nextNonce = Math.max(confirmedNonce, pendingNonce);
  let prefixLength = 0;
  for (const flight of candidates) {
    if (flight.nonce > nextNonce) break;
    prefixLength++;
    if (flight.nonce === nextNonce) nextNonce++;
  }
  return candidates.slice(0, prefixLength);
}

function assertPendingPrefixIsTracked(reconciliation: JournalReconciliation): void {
  const represented = new Set(reconciliation.retained.map((flight) => flight.nonce));
  const end = Math.max(reconciliation.confirmedNonce, reconciliation.pendingNonce);
  for (let nonce = reconciliation.confirmedNonce; nonce < end; nonce++) {
    if (!represented.has(nonce)) {
      const wallet = reconciliation.retained[0]?.wallet ?? runtime.account?.address;
      if (!wallet) {
        throw new Error(
          `submission recovery blocked: pending nonce ${nonce} is not represented in the durable journal`,
        );
      }
      throw new UntrackedPendingPrefixError(wallet, nonce);
    }
  }
}

async function rebroadcastJournalFlight(
  flight: JournalFlight,
  signal?: AbortSignal,
): Promise<DeliveryOutcome> {
  const endpoint = "public-rpc-recovery";
  // This is the last synchronous gate before the external side effect. Once
  // sendRawTransaction has started, its outcome remains conservatively exposed.
  throwIfRecoveryAborted(signal);
  try {
    await withTimeout(
      publicClient.sendRawTransaction({ serializedTransaction: flight.rawSignedTx }),
      RELAY_TIMEOUT_MS,
      `journal recovery broadcast (nonce ${flight.nonce})`,
    );
    return { state: "accepted", channel: "public", endpoint };
  } catch (error) {
    if (isAlreadyKnownError(error)) return { state: "accepted", channel: "public", endpoint };
    const message = (error as Error).message;
    return {
      // Once sendRawTransaction is invoked, even a deterministic-looking RPC
      // error cannot prove the endpoint discarded the signed bytes.
      state: "ambiguous",
      channel: "public",
      endpoint,
      error: message,
    };
  }
}

/** Close the fsync→dispatch crash window by retrying the exact signed hash. A
 * deterministic RPC rejection still cannot prove that no private endpoint saw
 * the pre-crash request, so it remains fenced and is retried conservatively. */
async function recoverJournalFlights(
  initialReconciliation: JournalReconciliation,
  signal?: AbortSignal,
  authorizeFlight?: (flight: JournalFlight) => Promise<boolean>,
): Promise<JournalReconciliation> {
  throwIfRecoveryAborted(signal);
  let reconciliation = initialReconciliation;
  let candidates = contiguousRecoveryCandidates(
    recoveryCandidates(reconciliation.retained, Date.now()),
    reconciliation.confirmedNonce,
    reconciliation.pendingNonce,
  );
  if (candidates.length > 0) assertPendingPrefixIsTracked(reconciliation);
  while (candidates.length > 0) {
    const notBefore = candidates.reduce((latest, flight) => {
      const candidate = flight.recovery.notBeforeTimestamp === undefined
        ? 0n
        : BigInt(flight.recovery.notBeforeTimestamp);
      return candidate > latest ? candidate : latest;
    }, 0n);
    if (notBefore * 1_000n <= BigInt(Date.now())) break;
    await waitUntilTimestamp(notBefore, signal);
    throwIfRecoveryAborted(signal);
    // The wait may span many blocks. Reconcile nonce terminality again before
    // authorizing spend, then bind the balance read to that exact block.
    reconciliation = await beforeRecoveryAbort(
      reconcileSubmissionJournal(candidates[0]!.wallet),
      signal,
    );
    candidates = contiguousRecoveryCandidates(
      recoveryCandidates(reconciliation.retained, Date.now()),
      reconciliation.confirmedNonce,
      reconciliation.pendingNonce,
    );
    if (candidates.length > 0) assertPendingPrefixIsTracked(reconciliation);
  }
  throwIfRecoveryAborted(signal);
  if (candidates.length === 0) return reconciliation;

  if (authorizeFlight) {
    let authorized: boolean[];
    try {
      // Finish every current-state authorization before the first simulation or
      // transport request. A callback RPC failure therefore cannot leave a
      // partially replayed recovery batch.
      authorized = await beforeRecoveryAbort(
        Promise.all(candidates.map((flight) => authorizeFlight(flight))),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `submission recovery authorization failed closed: ${reason}`,
        { cause: error },
      );
    }
    throwIfRecoveryAborted(signal);
    const firstDenied = authorized.findIndex((allowed) => !allowed);
    if (firstDenied !== -1) candidates = candidates.slice(0, firstDenied);
    // An ordinary semantic denial leaves the exact prepared entry in the WAL so
    // strategy can replace it or fill its nonce without replaying stale work.
    // It is also a nonce barrier: never expose a higher recovered transaction
    // that could remain queued and execute after the denied intent becomes stale.
    if (candidates.length === 0) return reconciliation;
  }

  const wallet = candidates[0]!.wallet;
  const balanceWei = await beforeRecoveryAbort(
    publicClient.getBalance({
      address: wallet,
      blockNumber: reconciliation.currentBlock,
    }),
    signal,
  );
  throwIfRecoveryAborted(signal);
  const maximumExposureWei = liveMaximumExposure(reconciliation.retained);
  const floorWei = configuredEthToWei(runtime.strategy.minBalanceEth);
  if (balanceWei < maximumExposureWei + floorWei) {
    throw new RecoveryFloorError(
      wallet,
      reconciliation.currentBlock,
      balanceWei,
      maximumExposureWei,
      floorWei,
    );
  }

  const now = Date.now();
  const updates: Array<{
    txHash: Hex;
    update: {
      state: "accepted" | "ambiguous";
      publicExposure: boolean;
      nonceConflict: boolean;
      attempts: JournalDeliveryAttempt[];
      updatedAtMs: number;
    };
  }> = [];
  let prefixClosed = false;
  for (let start = 0; start < candidates.length; start += 32) {
    throwIfRecoveryAborted(signal);
    const chunk = candidates.slice(start, start + 32);
    const simulated = await beforeRecoveryAbort(
      Promise.all(chunk.map(async (flight) => {
        try {
          await publicClient.call({
            account: flight.wallet,
            to: flight.obligation.to,
            data: flight.obligation.data,
            value: BigInt(flight.obligation.valueWei),
            gas: BigInt(flight.obligation.gasLimit),
            maxFeePerGas: BigInt(flight.obligation.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(flight.obligation.maxPriorityFeePerGas),
          });
          return true;
        } catch (error) {
          logger.warn(`journal recovery simulation (nonce ${flight.nonce}) failed closed:`, (error as Error).message);
          return false;
        }
      })),
      signal,
    );
    throwIfRecoveryAborted(signal);
    const firstFailedSimulation = simulated.findIndex((passed) => !passed);
    const simulatedPrefixLength = firstFailedSimulation === -1
      ? chunk.length
      : firstFailedSimulation;
    for (let index = 0; index < simulatedPrefixLength; index++) {
      const flight = chunk[index]!;
      const outcome = await rebroadcastJournalFlight(flight, signal);
      const attempt = journalAttempt(outcome)!;
      flight.state = outcome.state === "accepted" ? "accepted" : "ambiguous";
      flight.publicExposure = outcome.state !== "rejected";
      flight.nonceConflict = flight.nonceConflict
        || hasSameNonceExposureEvidence([outcome]);
      flight.attempts = [...flight.attempts, attempt];
      flight.updatedAtMs = now;
      updates.push({
        txHash: flight.txHash,
        update: {
          state: flight.state,
          publicExposure: flight.publicExposure,
          nonceConflict: flight.nonceConflict,
          attempts: flight.attempts,
          updatedAtMs: now,
        },
      });
      if (signal?.aborted) {
        // The current request may already have left the process. Persist that
        // conservative outcome, but never start the next nonce after Stop.
        prefixClosed = true;
        break;
      }
      // A timeout or deterministic rejection does not establish that the lower
      // nonce is currently executable. Retain the rest of the prefix in the WAL
      // instead of exposing transactions that could execute much later.
      if (outcome.state !== "accepted") {
        prefixClosed = true;
        break;
      }
    }
    if (prefixClosed || firstFailedSimulation !== -1) break;
  }
  if (updates.length > 0) submissionJournal.updateMany(candidates[0]!.wallet, updates);
  throwIfRecoveryAborted(signal);
  return reconciliation;
}

async function sendPublic(q: QueuedTx): Promise<DeliveryOutcome> {
  const endpoint = "public-rpc";
  if (q.signal?.aborted) {
    return { state: "rejected", channel: "public", endpoint, error: "public broadcast aborted before delivery" };
  }
  try {
    await withTimeout(
      publicClient.sendRawTransaction({ serializedTransaction: q.signed }),
      RELAY_TIMEOUT_MS,
      `public broadcast (nonce ${q.nonce})`,
    );
    return { state: "accepted", channel: "public", endpoint };
  } catch (error) {
    if (isAlreadyKnownError(error)) return { state: "accepted", channel: "public", endpoint };
    const message = (error as Error).message;
    // The request crossed the external side-effect boundary. A compromised or
    // non-conforming RPC can retain the raw transaction even while returning a
    // deterministic JSON-RPC rejection, so every post-dispatch error is exposed.
    logger.warn(`public broadcast (nonce ${q.nonce}) ambiguous:`, message);
    return { state: "ambiguous", channel: "public", endpoint, error: message };
  }
}

async function sendPublicBatch(
  queue: readonly QueuedTx[],
  simTimestamp: bigint | undefined,
): Promise<Map<number, DeliveryOutcome>> {
  const out = new Map<number, DeliveryOutcome>();
  for (const q of queue) {
    out.set(q.nonce, { state: "untouched", channel: "public", endpoint: "public-rpc" });
  }
  const publicQueue = queue.filter((q) => q.race);
  if (publicQueue.length === 0) return out;

  const waitAbort = new AbortController();
  const signals = publicQueue.flatMap((q) => q.signal ? [q.signal] : []);
  const abortIfCampaignStopped = () => {
    if (
      signals.length === publicQueue.length
      && publicQueue.every((q) => q.signal?.aborted)
    ) waitAbort.abort();
  };
  for (const signal of signals) signal.addEventListener("abort", abortIfCampaignStopped, { once: true });
  abortIfCampaignStopped();

  // Preparation is complete for the whole nonce sequence before this one shared
  // wait. Once the boundary arrives, start sends in nonce order and keep every
  // transport slot occupied so one slow RPC cannot hold up all later nonces.
  try {
    await waitUntilTimestamp(simTimestamp, waitAbort.signal);
  } catch (error) {
    for (const q of publicQueue) {
      out.set(q.nonce, {
        state: "rejected",
        channel: "public",
        endpoint: "public-rpc",
        error: (error as Error).message,
      });
    }
    return out;
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", abortIfCampaignStopped);
  }

  const PUBLIC_SEND_CONCURRENCY = 32;
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(PUBLIC_SEND_CONCURRENCY, publicQueue.length) },
    async () => {
      while (nextIndex < publicQueue.length) {
        // This claim happens synchronously before the await, so transactions are
        // launched in ascending-nonce order even when workers finish out of order.
        const q = publicQueue[nextIndex++]!;
        out.set(q.nonce, await sendPublic(q));
      }
    },
  );
  await Promise.all(workers);
  return out;
}

const lifecycleJobs = new Set<Promise<unknown>>();

/** Compatibility lifecycle hook. Every tracked operation is itself bounded. */
export async function waitForBundleFallbacks(): Promise<void> {
  while (lifecycleJobs.size > 0) {
    await Promise.allSettled([...lifecycleJobs]);
  }
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return left === right;
  }
}

function builderEndpointLabel(endpoint: string): string {
  return sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
    ? "flashbots-relay"
    : "configured-builder";
}

function flashbotsCancellationIsSafe(
  wallet: Address,
  priorUuid: string,
  replacementQueue: readonly QueuedTx[],
  currentBlock: bigint,
): boolean {
  const load = (submissionJournal as unknown as {
    load?: (address: Address) => JournalFlight[];
  }).load;
  if (!load) return true;
  const currentHashes = new Set(replacementQueue.map((q) => q.txHash));
  const related = load.call(submissionJournal, wallet).filter(
    (flight) => !currentHashes.has(flight.txHash)
      && flight.attempts.some((attempt) => attempt.replacementUuid === priorUuid),
  );
  if (related.length === 0) return true;
  const replacingLineages = new Set(replacementQueue.map((q) => q.lineageId));
  return related.every((flight) => {
    const expired = flight.maxPrivateTargetBlock !== undefined
      && currentBlock > BigInt(flight.maxPrivateTargetBlock);
    return expired || replacingLineages.has(flight.lineage.id);
  });
}

function sendBundleParams(
  txs: readonly Hex[],
  blockNumber: bigint,
  minTimestamp?: bigint,
  replacementUuid?: string,
  endpoint?: string,
  revertingTxHashes: readonly Hex[] = [],
): Record<string, unknown> {
  const params: Record<string, unknown> = { txs, blockNumber: toHex(blockNumber) };
  if (minTimestamp !== undefined) params.minTimestamp = Number(minTimestamp);
  if (revertingTxHashes.length > 0) params.revertingTxHashes = [...revertingTxHashes];
  if (
    replacementUuid !== undefined
    && endpoint !== undefined
    && sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
  ) {
    params.replacementUuid = replacementUuid;
  }
  return params;
}

export const MAX_BUNDLE_TXS = 100;
export const MAX_BUNDLE_BYTES = 300_000;

function bundleBytes(txs: readonly Hex[]): number {
  return txs.reduce((total, tx) => total + Math.max(0, (tx.length - 2) / 2), 0);
}

export function privateBundlePrefixLength(
  transactions: readonly { signed: Hex; gas: bigint }[],
  blockGasLimit: bigint,
): number {
  let count = 0;
  let bytes = 0;
  let gas = 0n;
  for (const transaction of transactions) {
    const nextBytes = bytes + bundleBytes([transaction.signed]);
    const nextGas = gas + transaction.gas;
    if (
      count === MAX_BUNDLE_TXS
      || nextBytes > MAX_BUNDLE_BYTES
      || nextGas > blockGasLimit
    ) break;
    count++;
    bytes = nextBytes;
    gas = nextGas;
  }
  return count;
}

function journalAttempt(outcome: DeliveryOutcome): JournalDeliveryAttempt | null {
  if (outcome.state === "untouched") return null;
  const privateEndpoint = outcome.channel === "private";
  const endpoint = privateEndpoint
    ? builderEndpointLabel(outcome.endpoint)
    : outcome.endpoint;
  return {
    channel: outcome.channel,
    endpoint,
    state: outcome.state,
    targetBlock: outcome.targetBlock?.toString(),
    replacementUuid: outcome.replacementUuid,
    cancellationSupported: outcome.channel === "private"
      && sameEndpoint(outcome.endpoint, appConfig.flashbotsRelayUrl),
    error: outcome.error === undefined ? undefined : redactSensitiveText(outcome.error),
  };
}

function removeJournalFlights(queue: readonly QueuedTx[]): void {
  const journaled = queue.filter((q) => q.journaled);
  if (journaled.length === 0) return;
  try {
    submissionJournal.removeMany(journaled[0]!.wallet, journaled.map((q) => q.txHash));
  } catch (error) {
    const message = `failed to remove submission journal flights: ${(error as Error).message}`;
    runtime.setJournalHealth(false, message);
    logger.error(message);
    // Rename completion makes the removal visible in this process. It is safe
    // to release the matching reservation, but the engine remains unhealthy
    // because crash persistence of that removal was not confirmed.
    if (error instanceof AtomicWriteCommittedError) return;
    // Before-rename failure leaves the prepared WAL live. Its nonce must remain
    // fenced and the caller must fail rather than silently recycle it.
    throw error;
  }
}

function failPreparedQueue(
  queue: readonly QueuedTx[],
  out: Map<number, BundleTxResult>,
  error: string,
): Map<number, BundleTxResult> {
  removeJournalFlights(queue);
  releaseQueuedReservations(queue);
  for (const q of queue) out.set(q.nonce, { ok: false, txHash: q.txHash, error });
  return out;
}

async function sendPrivateBundle(
  endpoint: string,
  txs: readonly Hex[],
  targetBlock: bigint,
  minTimestamp: bigint | undefined,
  replacementUuid: string | undefined,
  revertingTxHashes: readonly Hex[] = [],
  deadlineMs?: number,
): Promise<DeliveryOutcome> {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    return {
      state: "rejected",
      channel: "private",
      endpoint,
      targetBlock,
      replacementUuid: sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
        ? replacementUuid
        : undefined,
      error: "optional private cohort deadline expired before delivery",
    };
  }
  try {
    const result = await flashbotsRpcWithTimeout(
      "eth_sendBundle",
      [sendBundleParams(
        txs,
        targetBlock,
        minTimestamp,
        replacementUuid,
        endpoint,
        revertingTxHashes,
      )],
      endpoint,
      SEND_BUNDLE_TIMEOUT_MS,
      deadlineMs,
    );
    const bundleHash = bundleHashFromResult(result);
    if (!bundleHash) {
      return {
        state: "ambiguous",
        channel: "private",
        endpoint,
        targetBlock,
        replacementUuid: sameEndpoint(endpoint, appConfig.flashbotsRelayUrl) ? replacementUuid : undefined,
        error: "relay response did not include a bundle hash",
      };
    }
    return {
      state: "accepted",
      channel: "private",
      endpoint,
      targetBlock,
      replacementUuid: sameEndpoint(endpoint, appConfig.flashbotsRelayUrl) ? replacementUuid : undefined,
      bundleHash,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      // The signed bundle was handed to an external endpoint. JSON-RPC
      // rejection is not cryptographic deletion and must remain exposed.
      state: "ambiguous",
      channel: "private",
      endpoint,
      targetBlock,
      replacementUuid: sameEndpoint(endpoint, appConfig.flashbotsRelayUrl) ? replacementUuid : undefined,
      error: message,
    };
  }
}

function deliveryState(outcomes: readonly DeliveryOutcome[]): Exclude<DeliveryState, "untouched"> {
  if (outcomes.some((outcome) => outcome.state === "accepted")) return "accepted";
  if (outcomes.some((outcome) => outcome.state === "ambiguous")) return "ambiguous";
  return "rejected";
}

function maxPrivateTarget(outcomes: readonly DeliveryOutcome[]): bigint | undefined {
  let maximum: bigint | undefined;
  for (const outcome of outcomes) {
    if (
      outcome.channel !== "private"
      || outcome.targetBlock === undefined
      || (outcome.state !== "accepted" && outcome.state !== "ambiguous")
    ) continue;
    if (maximum === undefined || outcome.targetBlock > maximum) maximum = outcome.targetBlock;
  }
  return maximum;
}

function publicExposure(outcomes: readonly DeliveryOutcome[]): boolean {
  return outcomes.some(
    (outcome) => outcome.channel === "public"
      && (outcome.state === "accepted" || outcome.state === "ambiguous"),
  );
}

function hasUnboundedPrivateRawExposure(
  q: Pick<QueuedTx, "validThroughBlock">,
  outcomes: readonly DeliveryOutcome[],
): boolean {
  return q.validThroughBlock === undefined && outcomes.some((outcome) =>
    outcome.channel === "private"
      && (outcome.state === "accepted" || outcome.state === "ambiguous"));
}

function requiresNonceReconciliation(outcomes: readonly DeliveryOutcome[]): boolean {
  return outcomes.some((outcome) =>
    /nonce too (?:low|high)|replacement transaction underpriced|already imported/i.test(outcome.error ?? ""),
  );
}

/** Evidence that this nonce (or an equivalent replacement) may remain live.
 * `nonce too high` is deliberately absent: it proves a lower gap, not another
 * same-nonce lineage. The dispatched raw is still retained through ordinary
 * public/private exposure bookkeeping. */
function hasSameNonceExposureEvidence(outcomes: readonly DeliveryOutcome[]): boolean {
  return outcomes.some((outcome) =>
    /nonce too low|replacement transaction underpriced|already imported/i.test(outcome.error ?? ""),
  );
}

function reconciledDeliveryState(
  outcomes: readonly DeliveryOutcome[],
): Exclude<DeliveryState, "untouched"> {
  const state = deliveryState(outcomes);
  if (
    state === "accepted"
    && hasSameNonceExposureEvidence(outcomes)
  ) return "ambiguous";
  return state;
}

function nonceFlightState(
  state: Exclude<DeliveryState, "untouched">,
  outcomes: readonly DeliveryOutcome[],
): "accepted" | "rejected" | "ambiguous" {
  if (
    state === "ambiguous"
    && !publicExposure(outcomes)
    && !requiresNonceReconciliation(outcomes)
    && maxPrivateTarget(outcomes) !== undefined
  ) return "accepted";
  return state;
}

/**
 * Send everything queued since beginBundle() as a single atomic multi-tx bundle
 * (txs in ascending-nonce order) per target block, mirroring each race-flagged tx
 * to the public mempool as a fallback. Returns a per-nonce result map so the
 * caller can fill in each activity entry's hashes and start receipt tracking.
 * Always closes the batching window, even on error.
 */
export async function flushBundle(): Promise<Map<number, BundleTxResult>> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<number, BundleTxResult>();
  if (!queue || queue.length === 0) return out;
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  // A bundle executes its txs in the given order, so nonces must ascend.
  queue.sort((a, b) => a.nonce - b.nonce);
  const cohortError = validatePrivateCohorts(queue);
  if (cohortError) return failPreparedQueue(queue, out, cohortError);
  omitExpiredOptionalSuffix(queue, out, "bundle preparation");
  if (queue.length === 0) return out;
  const simulationTimestamps = [
    ...new Set(queue.flatMap((q) => q.simTimestamp === undefined ? [] : [q.simTimestamp.toString()])),
  ];
  if (simulationTimestamps.length > 1) {
    return failPreparedQueue(queue, out, "bundle contains conflicting simulation timestamps");
  }
  let simTimestamp = simulationTimestamps[0] === undefined
    ? undefined
    : BigInt(simulationTimestamps[0]);

  let targetBlock = 0n;
  let privateTargetAvailable = true;
  try {
    targetBlock = (await beforeSubmissionDeadline(
      publicClient.getBlockNumber(),
      earliestQueuedDeadline(queue),
      "private target block lookup",
    )) + 1n;
  } catch (err) {
    privateTargetAvailable = false;
    const error = `private target block lookup unavailable: ${(err as Error).message}`;
    logger.warn(`${error}; preserving the authorized public nonce prefix`);
    const firstPrivateOnly = queue.findIndex((q) => !q.race);
    if (firstPrivateOnly !== -1) {
      failPreparedQueue(queue.splice(firstPrivateOnly), out, error);
    }
  }
  if (queue.length === 0) return out;
  if (privateTargetAvailable) {
    omitBuilderIncentivePastTarget(queue, out, targetBlock);
  }
  if (queue.length === 0) return out;
  if (abortQueuedBeforeDelivery(queue, out)) return out;
  omitExpiredOptionalSuffix(queue, out, "private validation");
  if (queue.length === 0) return out;

  let privateQueue: QueuedTx[] = [];
  let privateDisabledReason: string | undefined;
  let privateSimulationOutcome: DeliveryOutcome | undefined;
  let privateDeliveryEnabled = false;
  let suppressDelivery = false;
  if (appConfig.mode === "mainnet" && privateTargetAvailable) {
    let blockGasLimit: bigint | undefined;
    try {
      blockGasLimit = (await beforeSubmissionDeadline(
        getLatestBlockCached(),
        earliestQueuedDeadline(queue),
        "private gas validation",
      )).gasLimit;
    } catch (error) {
      privateDisabledReason = `bundle gas validation unavailable: ${(error as Error).message}`;
    }
    if (blockGasLimit !== undefined) {
      const rawPrivateLength = privateBundlePrefixLength(queue, blockGasLimit);
      const cohortSafeLength = cohortSafePrivatePrefixLength(queue, blockGasLimit);
      privateQueue = queue.slice(0, cohortSafeLength);
      if (cohortSafeLength < rawPrivateLength) {
        logger.warn(
          `private bundle limit would split a declared cohort; excluding that cohort from private delivery`,
        );
      }
      if (privateQueue.length < queue.length) {
        privateDisabledReason = `private bundle limited to nonce prefix ${privateQueue.length}/${queue.length}`;
        logger.warn(`${privateDisabledReason}; preserving every authorized public fallback`);
      }
    }

  }
  if (omitExpiredOptionalSuffix(queue, out, "the prepared-WAL barrier")) {
    const retained = new Set(queue);
    privateQueue = privateQueue.filter((q) => retained.has(q));
  }
  if (queue.length === 0) return out;
  const plannedPrivateTargets = privateTargetBlocksFor(privateQueue, targetBlock);
  const plannedPrivateMax = plannedPrivateTargets[plannedPrivateTargets.length - 1];
  for (const q of queue) {
    if (privateQueue.includes(q) || q.purpose === "builder-incentive") {
      // A builder incentive that is excluded by cohort sizing has no delivery
      // route, but still receives its signed finite WAL horizon. Recovery never
      // replays it independently or releases its nonce by height: once the
      // window is canonically final, the normal same-nonce retirement path
      // consumes the fence safely.
      q.plannedMaxPrivateTargetBlock = q.validThroughBlock === undefined
        ? plannedPrivateMax ?? targetBlock + 1n
        : q.validThroughBlock < targetBlock + 1n
          ? q.validThroughBlock
          : targetBlock + 1n;
    }
    q.unboundedPrivateExposure = privateQueue.includes(q)
      && q.validThroughBlock === undefined;
  }
  // stopEngine may have invalidated this generation during local target/gas
  // validation. No external endpoint has received signed bytes yet, so this
  // cancellation remains definite and fresh reservations can be released.
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  try {
    // Establish one wallet-scoped barrier before any external endpoint receives
    // signed raw bytes, including relay simulation.
    persistPreparedBatch(queue);
    for (const q of queue) q.journaled = true;
  } catch (error) {
    if (error instanceof AtomicWriteCommittedError) {
      for (const q of queue) q.journaled = true;
      runtime.setJournalHealth(false, error.message);
      // The WAL rename is visible, so these nonces stay fenced even though the
      // final directory flush could not be confirmed.
      throw error;
    }
    if (error instanceof JournalCorruptionError) {
      releaseQueuedReservations(queue);
      throw error;
    }
    return failPreparedQueue(queue, out, `submission journal write failed: ${(error as Error).message}`);
  }

  // This is the last definite-abort point. Once eth_callBundle starts, the relay
  // can retain every raw transaction regardless of its simulation response.
  if (abortQueuedBeforeDelivery(queue, out)) return out;
  if (omitExpiredOptionalSuffix(queue, out, "the prepared-WAL barrier")) {
    const retained = new Set(queue);
    privateQueue = privateQueue.filter((q) => retained.has(q));
    const remainingTimestamps = [
      ...new Set(queue.flatMap((q) =>
        q.simTimestamp === undefined ? [] : [q.simTimestamp.toString()])),
    ];
    simTimestamp = remainingTimestamps[0] === undefined
      ? undefined
      : BigInt(remainingTimestamps[0]);
  }
  if (queue.length === 0) return out;

  // Simulate only the nonce prefix that can be submitted as a valid private
  // bundle. The prepared WAL above already covers the disclosure. A deterministic
  // failure suppresses further delivery but cannot release the disclosed raws;
  // relay unavailability disables private sends and preserves public fallback.
  if (appConfig.mode === "mainnet" && privateTargetAvailable && privateQueue.length > 0) {
    const simulationTargetBlock = privateTargetBlocksFor(privateQueue, targetBlock)[0];
    if (simulationTargetBlock === undefined) {
      throw new Error("private queue has no target within its signed block deadline");
    }
    const simParams: Record<string, unknown> = {
      txs: privateQueue.map((q) => q.signed),
      blockNumber: toHex(simulationTargetBlock),
      stateBlockNumber: "latest",
    };
    if (simTimestamp !== undefined) simParams.timestamp = Number(simTimestamp);
    privateSimulationOutcome = {
      state: "ambiguous",
      channel: "private",
      endpoint: appConfig.flashbotsRelayUrl,
      targetBlock: simulationTargetBlock,
    };
    try {
      const sim = await flashbotsRpcWithTimeout(
        "eth_callBundle",
        [simParams],
        undefined,
        BUNDLE_SIM_TIMEOUT_MS,
        earliestQueuedDeadline(queue),
      );
      const allowedRevertIndices = new Set(
        privateQueue.flatMap((q, index) => q.revertible ? [index] : []),
      );
      const issue = bundleSimulationIssue(
        sim,
        allowedRevertIndices,
        privateQueue.length,
      );
      if (issue) {
        privateDisabledReason = `bundle simulation reverted: ${issue.failure}`;
        privateSimulationOutcome.error = privateDisabledReason;
        suppressDelivery = true;
        logger.warn(`${privateDisabledReason}; retaining every disclosed nonce under the WAL`);
      } else {
        privateDeliveryEnabled = true;
      }
    } catch (err) {
      privateDisabledReason = `bundle simulation unavailable: ${(err as Error).message}`;
      privateSimulationOutcome.error = privateDisabledReason;
      logger.warn(`${privateDisabledReason}; continuing with individually simulated public delivery`);
    }
  }

  const priorReplacementUuids = [...new Set(queue.flatMap((q) => [
    ...(q.replacement?.replacementUuids ?? []),
    ...(q.replacement?.replacementUuid ? [q.replacement.replacementUuid] : []),
  ]))];
  const hasFlashbotsTarget = appConfig.builderUrls.some((endpoint) =>
    sameEndpoint(endpoint, appConfig.flashbotsRelayUrl),
  );
  const currentReplacementUuids = new Map<bigint, string>();
  if (privateTargetAvailable && priorReplacementUuids.length > 0) {
    const cancellationDeadlineMs = earliestQueuedDeadline(queue);
    const cancellations = priorReplacementUuids.map(async (priorUuid) => {
      if (!flashbotsCancellationIsSafe(queue[0]!.wallet, priorUuid, queue, targetBlock - 1n)) {
        logger.warn(`preserving live shared Flashbots bundle ${priorUuid}; not every lineage is being replaced`);
        return;
      }
      try {
        await flashbotsRpcWithTimeout(
          "eth_cancelBundle",
          [{ replacementUuid: priorUuid }],
          appConfig.flashbotsRelayUrl,
          SEND_BUNDLE_TIMEOUT_MS,
          cancellationDeadlineMs,
        );
      } catch (error) {
        // Cancellation is capability-specific and best-effort. Every disclosed
        // lineage remains journaled until canonical nonce consumption is confirmed.
        logger.warn(`Flashbots cancellation for ${priorUuid} ambiguous:`, (error as Error).message);
      }
    });
    await Promise.all(cancellations);
  }
  if (queue.some((q) => q.signal?.aborted) && privateSimulationOutcome !== undefined) {
    // The relay already received the signed private prefix for simulation. Stop
    // prevents any additional send request, but cannot turn that disclosure into
    // a definite abort or release its nonce/WAL fence.
    suppressDelivery = true;
    privateDisabledReason ??= "bundle submission stopped after signed relay disclosure";
    privateSimulationOutcome.error ??= privateDisabledReason;
  }
  const livePrivateTargetBlocks = privateTargetBlocksFor(privateQueue, targetBlock);
  if (
    appConfig.mode === "mainnet"
    && privateTargetAvailable
    && privateQueue.length > 0
    && privateDeliveryEnabled
    && !suppressDelivery
    && !queue.some((q) => q.signal?.aborted)
    && hasFlashbotsTarget
  ) {
    for (const block of livePrivateTargetBlocks) {
      currentReplacementUuids.set(block, globalThis.crypto.randomUUID());
    }
  }
  const revertingTxHashes = privateQueue.flatMap((q) => q.revertible ? [q.txHash] : []);
  const privateDeadlineMs = earliestQueuedDeadline(queue);
  // Start the authorized public fallback while still inside the checked
  // delivery-start window. Its future-timestamp wait may intentionally finish
  // at the boundary; the private builder transfer itself may not start late.
  const publicPromise = suppressDelivery
    ? Promise.resolve(new Map(queue.map((q) => [q.nonce, {
        state: "rejected" as const,
        channel: "public" as const,
        endpoint: "public-rpc",
        error: privateDisabledReason,
      }])))
    : sendPublicBatch(queue, simTimestamp);
  const privatePromise: Promise<DeliveryOutcome[]> = appConfig.mode === "mainnet"
    && privateTargetAvailable
    && privateQueue.length > 0
    && privateDeliveryEnabled
    && !suppressDelivery
    && !queue.some((q) => q.signal?.aborted)
    ? Promise.all(appConfig.builderUrls.flatMap((endpoint) =>
      livePrivateTargetBlocks.map((block) =>
        sendPrivateBundle(
          endpoint,
          privateQueue.map((q) => q.signed),
          block,
          simTimestamp,
          sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
            ? currentReplacementUuids.get(block)
            : undefined,
          revertingTxHashes,
          privateDeadlineMs,
        ),
      ),
    )).then((outcomes) => privateSimulationOutcome === undefined
      ? outcomes
      : [privateSimulationOutcome, ...outcomes])
    : Promise.resolve(privateSimulationOutcome === undefined ? [] : [privateSimulationOutcome]);
  const deliveryJob = Promise.all([privatePromise, publicPromise]);
  lifecycleJobs.add(deliveryJob);
  let privateOutcomes: DeliveryOutcome[];
  let publicOutcomes: Map<number, DeliveryOutcome>;
  try {
    [privateOutcomes, publicOutcomes] = await deliveryJob;
  } finally {
    lifecycleJobs.delete(deliveryJob);
  }

  const bundleHash = privateOutcomes.find((outcome) => outcome.bundleHash)?.bundleHash;
  const activeReplacementUuids = [...currentReplacementUuids.values()];
  const acceptedBuilders = new Set(
    privateOutcomes
      .filter((outcome) => outcome.state === "accepted")
      .map((outcome) => outcome.endpoint),
  );
  if (acceptedBuilders.size > 0) {
    logger.info(
      `batched bundle (${queue.length} tx) accepted by ${acceptedBuilders.size}/${appConfig.builderUrls.length} builders`,
    );
  }

  const resolved = queue.map((q) => {
    const outcomes = [
      ...(privateQueue.includes(q) ? privateOutcomes : []),
      publicOutcomes.get(q.nonce)!,
    ];
    return {
      q,
      outcomes,
      state: reconciledDeliveryState(outcomes),
      retainFence: requiresNonceReconciliation(outcomes)
        || hasUnboundedPrivateRawExposure(q, outcomes),
      retryImmediately: false,
      retryReason: undefined as string | undefined,
      journalError: undefined as string | undefined,
    };
  });
  // Definitive rejections may release only a fresh contiguous top suffix. Mixed
  // lower rejections remain fenced because an accepted higher nonce may already
  // exist in a remote txpool.
  const releasable: number[] = [];
  for (let index = resolved.length - 1; index >= 0; index--) {
    const item = resolved[index]!;
    if (item.state !== "rejected" || !item.q.reserved) break;
    releasable.unshift(item.q.nonce);
  }
  const releasableSet = new Set(releasable);
  for (const item of resolved) {
    if (item.state !== "rejected" || !item.q.reserved || releasableSet.has(item.q.nonce)) continue;
    // This tx was rejected, but a higher nonce was accepted/ambiguous and may be
    // queued remotely. Retain the obligation as retryable same-nonce work; a
    // fresh nonce would strand the higher sequence forever.
    item.state = "ambiguous";
    item.retryImmediately = true;
    item.retryReason = "delivery rejected; retained to fill an exposed higher-nonce gap";
  }
  const terminalHashes = resolved.flatMap(({ q, state }) =>
    releasableSet.has(q.nonce) || (state === "rejected" && !q.reserved) ? [q.txHash] : [],
  );
  let journalCommitted = false;
  try {
    const terminal = new Set(terminalHashes);
    submissionJournal.mutate(queue[0]!.wallet, {
      updates: resolved.flatMap(({ q, outcomes, state }) => terminal.has(q.txHash) ? [] : [{
        txHash: q.txHash,
        update: {
          state,
          publicExposure: publicExposure(outcomes),
          nonceConflict: hasSameNonceExposureEvidence(outcomes)
            || hasUnboundedPrivateRawExposure(q, outcomes),
          attempts: outcomes.map(journalAttempt).filter(
            (attempt): attempt is JournalDeliveryAttempt => attempt !== null,
          ),
          maxPrivateTargetBlock: maxPrivateTarget(outcomes)?.toString(),
          updatedAtMs: Date.now(),
        },
      }]),
      remove: terminalHashes,
    });
    journalCommitted = true;
  } catch (error) {
    const journalError = `submission journal update failed: ${(error as Error).message}`;
    logger.error(journalError);
    runtime.setJournalHealth(false, journalError);
    if (error instanceof AtomicWriteCommittedError) {
      // Rename completed: preserve the exact delivery states/removals now
      // visible in the WAL and allow any matching terminal nonce release.
      journalCommitted = true;
      for (const item of resolved) item.journalError = journalError;
    } else {
      // The old prepared document remains authoritative. Delivery already
      // happened, so every affected nonce stays conservatively ambiguous.
      for (const item of resolved) {
        item.state = "ambiguous";
        item.journalError = journalError;
      }
    }
  }
  const released = new Set<number>();
  if (
    journalCommitted
    && releasable.length > 0
    && nonceManager.releaseContiguous(releasable)
  ) {
    for (const nonce of releasable) released.add(nonce);
    if (resolved.some((item) => released.has(item.q.nonce) && item.retainFence)) {
      nonceManager.reset();
    }
  }

  for (const item of resolved) {
    const { q, outcomes } = item;
    let state = item.state;
    if (released.has(q.nonce)) {
      // releaseContiguous already removed the in-memory flight.
    } else if (state === "rejected" && !q.reserved) {
      // The rejected replacement did not invalidate the prior same-nonce flight.
      // Preserve that lineage fence until chain/journal reconciliation resolves it.
      nonceManager.markDelivery(q.nonce, "ambiguous", {
        txHash: q.replacement?.priorTxHash ?? q.txHash,
        retainRejectedFence: true,
      });
    } else if (!released.has(q.nonce)) {
      nonceManager.markDelivery(q.nonce, nonceFlightState(state, outcomes), {
        txHash: q.txHash,
        publicExposure: publicExposure(outcomes),
        maxPrivateTargetBlock: maxPrivateTarget(outcomes),
        retainBeyondPrivateTarget: hasSameNonceExposureEvidence(outcomes)
          || hasUnboundedPrivateRawExposure(q, outcomes)
          || maxPrivateTarget(outcomes) !== undefined
          || q.validThroughBlock !== undefined,
        retainRejectedFence: state === "rejected",
      });
    }

    const error = item.journalError
      ?? item.retryReason
      ?? outcomes.find((outcome) => outcome.error)?.error
      ?? (state === "ambiguous" ? "delivery unacknowledged" : undefined);
    out.set(q.nonce, {
      ok: state !== "rejected",
      uncertain: state === "ambiguous" ? true : undefined,
      txHash: q.txHash,
      bundleHash: privateQueue.includes(q) ? bundleHash : undefined,
      replacementUuid: privateQueue.includes(q) && activeReplacementUuids.length === 1
        ? activeReplacementUuids[0]
        : undefined,
      replacementUuids: privateQueue.includes(q) && activeReplacementUuids.length > 0
        ? activeReplacementUuids
        : undefined,
      lineageId: q.lineageId,
      maxPrivateTargetBlock: maxPrivateTarget(outcomes),
      replacementUuidCohortSize: privateQueue.includes(q) && activeReplacementUuids.length > 0
        ? privateQueue.length
        : undefined,
      retryImmediately: item.retryImmediately || undefined,
      error,
    });
  }
  return out;
}

function preparedFlight(q: QueuedTx): JournalFlight {
  const now = Date.now();
  return {
    wallet: q.wallet,
    nonce: q.nonce,
    rawSignedTx: q.signed,
    txHash: q.txHash,
    purpose: q.purpose,
    privateCohort: q.privateCohort,
    obligation: {
      to: q.intent.to,
      data: q.intent.data,
      valueWei: q.intent.value.toString(),
      gasLimit: q.gas.toString(),
      maxFeePerGas: q.maxFeePerGas.toString(),
      maxPriorityFeePerGas: q.maxPriorityFeePerGas.toString(),
    },
    lineage: {
      id: q.lineageId,
      replacesTxHash: q.replacement?.priorTxHash,
    },
    recovery: {
      publicAuthorized: q.race,
      notBeforeTimestamp: q.simTimestamp?.toString(),
      ...(q.payment === undefined ? {} : { payment: { ...q.payment } }),
      ...(q.validThroughBlock === undefined
        ? {}
        : { validThroughBlock: q.validThroughBlock.toString() }),
    },
    state: "prepared",
    publicExposure: false,
    nonceConflict: q.unboundedPrivateExposure === true,
    attempts: [],
    maxPrivateTargetBlock: q.plannedMaxPrivateTargetBlock?.toString(),
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function persistPreparedFlight(q: QueuedTx): void {
  submissionJournal.upsert(preparedFlight(q));
}

function persistPreparedBatch(queue: readonly QueuedTx[]): void {
  if (queue.length === 0) return;
  const wallet = queue[0]!.wallet;
  submissionJournal.upsertMany(wallet, queue.map(preparedFlight));
}

export async function submitTx(
  intent: TxIntent,
  opts: {
    dryRun: boolean;
    race?: boolean;
    offense?: boolean;
    /** Simulate at this future unix-second timestamp (pre-boundary races). */
    simTimestamp?: bigint;
    /** Allow this private-bundle member to revert without invalidating mandatory
     * cohort members. Ignored for public delivery. */
    revertible?: boolean;
    /** Durable special-purpose delivery semantics. */
    purpose?: SubmissionPurpose;
    /** Declares the all-or-none private-delivery cohort and member role. */
    privateCohort?: {
      id: string;
      role: "mandatory" | "allowed-revert" | "builder-incentive";
    };
    /** Strategy identity for crash-safe one-shot payment deduplication. */
    payment?: JournalPaymentMetadata;
    /** Last block encoded into a private-only CoinbasePayer call. */
    validThroughBlock?: bigint;
    /** Absolute wall-clock cutoff for optional work riding a mandatory bundle. */
    deadlineMs?: number;
    /** Replace a previously signed transaction without consuming a new nonce. */
    replacement?: ReplacementOptions;
    /** Internal recovery path: deliver an inert same-nonce retirement only to
     * the public RPC, never back to a builder that retained the old raw. */
    publicOnly?: boolean;
    /** Cancel a delayed public broadcast when this engine generation stops. */
    signal?: AbortSignal;
    /** Last-moment exact affordability/revision gate. */
    authorize?: (quote: {
      valueWei: bigint;
      gasWei: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }) => Promise<
      boolean
      | string
      | { ok: boolean; error?: string; stillValid?: () => boolean }
    >;
  },
): Promise<SubmitResult> {
  const account = runtime.account;
  if (!account) throw new Error("Wallet locked");
  validateSubmissionMetadata(intent, opts);
  if (opts.privateCohort !== undefined && bundleQueue === null) {
    throw new Error("private cohort submissions require an open batch");
  }
  if (opts.publicOnly && bundleQueue !== null && bundleQueue.length > 0) {
    throw new Error("public-only nonce retirement cannot interleave a non-empty preparation batch");
  }
  if (opts.purpose === "builder-incentive" && appConfig.mode !== "mainnet") {
    throw new Error("builder incentives require mainnet private-bundle mode");
  }
  // Authentication identity corruption is local fatal state, not relay
  // unavailability. Validate/create it before simulation fallbacks can
  // accidentally reinterpret the error as a tolerable network failure.
  if (appConfig.mode === "mainnet" && !opts.publicOnly) getAuthSigner();
  // Independent pre-submission reads — run together (viem batches them, and the
  // block is usually already cached from the pass's canSpend), instead of three
  // serial round-trips per tx. Pre-boundary races pass explicit gas, so estimateGas
  // is instant there and this whole block costs zero extra round-trips.
  const [gas, latest] = await beforeSubmissionDeadline(
    Promise.all([
      estimateGas(account.address, intent),
      getLatestBlockCached(),
    ]),
    opts.deadlineMs,
    "transaction preparation",
  );
  const offense = opts.offense ?? false;
  let { maxFeePerGas, maxPriorityFeePerGas } = computeFees(offense, latest);
  let replacementFeeError: string | undefined;
  if (opts.replacement) {
    let replacement = cappedReplacementFees(
      maxFeePerGas,
      maxPriorityFeePerGas,
      opts.replacement.priorMaxFeePerGas,
      opts.replacement.priorMaxPriorityFeePerGas,
      resolveGas(runtime.strategy, offense),
    );
    if (
      !replacement
      && opts.replacement.maxFeePerGasCap !== undefined
      && opts.replacement.maxPriorityFeePerGasCap !== undefined
    ) {
      const bumpedMax = nextReplacementFee(opts.replacement.priorMaxFeePerGas);
      const bumpedPriority = nextReplacementFee(opts.replacement.priorMaxPriorityFeePerGas);
      const candidateMax = maxFeePerGas > bumpedMax ? maxFeePerGas : bumpedMax;
      const candidatePriority = maxPriorityFeePerGas > bumpedPriority
        ? maxPriorityFeePerGas
        : bumpedPriority;
      if (
        candidateMax <= opts.replacement.maxFeePerGasCap
        && candidatePriority <= opts.replacement.maxPriorityFeePerGasCap
      ) {
        replacement = {
          maxFeePerGas: candidateMax,
          maxPriorityFeePerGas: candidatePriority,
        };
      }
    }
    if (replacement) {
      ({ maxFeePerGas, maxPriorityFeePerGas } = replacement);
    } else {
      replacementFeeError = "replacement fee ceiling reached";
    }
  }
  const gasWei = gas * maxFeePerGas;
  // Reuse the block's own number instead of a separate getBlockNumber round-trip.
  // Only used for sim context + reporting here; the actual bundle target block is
  // re-derived fresh at flush time (see flushBundle).
  const latestNumber = latest.number ?? await beforeSubmissionDeadline(
    publicClient.getBlockNumber(),
    opts.deadlineMs,
    "target block lookup",
  );
  const targetBlock = latestNumber + 1n;

  // Nonce is only reserved after simulation passes to avoid burning nonces on reverts.
  const candidateNonce = opts.replacement?.nonce ?? nonceManager.peek();
  const base: SubmitResult = {
    ok: false,
    simulated: false,
    nonce: candidateNonce,
    valueWei: intent.value,
    gasWei,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  if (replacementFeeError) {
    return { ...base, error: replacementFeeError, targetBlock };
  }
  if (opts.validThroughBlock !== undefined) {
    if (opts.validThroughBlock < targetBlock) {
      return {
        ...base,
        error: `builder-incentive block deadline ${opts.validThroughBlock} is before first target ${targetBlock}`,
        targetBlock,
      };
    }
    if (opts.validThroughBlock > targetBlock + 1n) {
      return {
        ...base,
        error: `builder-incentive block deadline ${opts.validThroughBlock} exceeds the two-block private horizon`,
        targetBlock,
      };
    }
  }

  // --- Simulation ---
  if (opts.simTimestamp !== undefined) {
    // Future-timestamp race (pre-boundary pay/audit/kill): validate at the instant
    // the tx will actually execute. Always uses eth_call block overrides against
    // OUR OWN RPC — verified working, and deliberately not the relay's
    // eth_callBundle `timestamp`, so the race doesn't depend on relay behaviour we
    // can't test. Works identically in public and mainnet mode.
    try {
      const revert = await beforeSubmissionDeadline(
        simulateAtTimestamp(account.address, intent, gas, opts.simTimestamp),
        opts.deadlineMs,
        "future transaction simulation",
      );
      if (revert) return { ...base, simulated: true, error: `sim revert @${opts.simTimestamp}: ${revert}`, targetBlock };
      base.simulated = true;
    } catch (err) {
      if (err instanceof SubmissionDeadlineError) {
        return { ...base, error: err.message, targetBlock };
      }
      return {
        ...base,
        error: `timestamp-override simulation unavailable: ${(err as Error).message}`,
        targetBlock,
      };
    }
  } else {
    // Plain eth_call — no nonce or signed raw bytes leave this process. Batched
    // transactions later get ordered relay simulation only after the WAL; a
    // direct mainnet transaction relies on this local semantic check before its
    // own WAL and delivery barrier.
    try {
      await beforeSubmissionDeadline(
        publicClient.call({
          account: account.address,
          to: intent.to,
          data: intent.data,
          value: intent.value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        }),
        opts.deadlineMs,
        "transaction simulation",
      );
      base.simulated = true;
    } catch (err) {
      if (err instanceof SubmissionDeadlineError) {
        return { ...base, error: err.message, targetBlock };
      }
      return { ...base, simulated: true, error: `sim revert: ${(err as Error).message}`, targetBlock };
    }
  }

  if (opts.dryRun) {
    return { ...base, ok: true, targetBlock };
  }

  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
    return { ...base, error: "transaction preparation missed its submission deadline", targetBlock };
  }

  if (opts.authorize) {
    let authorization: Awaited<ReturnType<NonNullable<typeof opts.authorize>>>;
    try {
      authorization = await beforeSubmissionDeadline(
        opts.authorize({
          valueWei: intent.value,
          gasWei,
          maxFeePerGas,
          maxPriorityFeePerGas,
        }),
        opts.deadlineMs,
        "transaction authorization",
      );
    } catch (error) {
      if (error instanceof SubmissionDeadlineError) {
        return { ...base, error: error.message, targetBlock };
      }
      throw error;
    }
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      return { ...base, error: "transaction authorization missed its submission deadline", targetBlock };
    }
    const normalized = typeof authorization === "object"
      ? authorization
      : { ok: authorization === true, error: typeof authorization === "string" ? authorization : undefined };
    if (!normalized.ok) {
      return { ...base, error: normalized.error ?? "transaction authorization rejected", targetBlock };
    }
    if (normalized.stillValid && !normalized.stillValid()) {
      return { ...base, error: "transaction authorization became stale", targetBlock };
    }
  }

  // Simulation passed — now officially consume the nonce and sign for real.
  const reserved = opts.replacement === undefined;
  let nonce: number;
  if (opts.replacement) {
    nonce = opts.replacement.nonce;
    // Reuse the old nonce, but fence it from a later ordinary reserve() in this
    // same tick in case its former private reservation already went stale.
    nonceManager.ensureNextAbove(nonce);
  } else {
    nonce = nonceManager.reserve();
  }
  base.nonce = nonce;
  let signed: Hex;
  try {
    signed = await beforeSubmissionDeadline(
      signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas),
      opts.deadlineMs,
      "transaction signing",
    );
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      throw new SubmissionDeadlineError("transaction signing missed its submission deadline");
    }
  } catch (error) {
    if (reserved) nonceManager.releaseContiguous([nonce]);
    if (error instanceof SubmissionDeadlineError) {
      return { ...base, error: error.message, targetBlock };
    }
    throw error;
  }
  const signedTxHash = keccak256(signed);
  const queued: QueuedTx = {
    wallet: account.address,
    signed,
    txHash: signedTxHash,
    lineageId: opts.replacement?.lineageId ?? `${account.address.toLowerCase()}:${nonce}`,
    nonce,
    race: opts.purpose === "builder-incentive"
      ? false
      : appConfig.mode === "mainnet"
        ? opts.race ?? false
        : true,
    reserved,
    journaled: false,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    intent,
    simTimestamp: opts.simTimestamp,
    signal: opts.signal,
    replacement: opts.replacement,
    revertible: opts.revertible === true,
    purpose: opts.purpose,
    privateCohort: opts.privateCohort === undefined ? undefined : { ...opts.privateCohort },
    payment: opts.payment === undefined ? undefined : { ...opts.payment },
    validThroughBlock: opts.validThroughBlock,
    deadlineMs: opts.deadlineMs,
  };
  // Every mode uses the same preparation batch. This guarantees all due nonces
  // are reserved and signed before the shared boundary wait starts.
  if (bundleQueue !== null && !opts.publicOnly) {
    bundleQueue.push(queued);
    return {
      ...base,
      ok: true,
      queued: true,
      txHash: signedTxHash,
      lineageId: queued.lineageId,
      targetBlock,
    };
  }

  const privateEligible = !opts.publicOnly
    && privateBundlePrefixLength([queued], latest.gasLimit) === 1;
  if (appConfig.mode === "mainnet" && privateEligible) {
    queued.plannedMaxPrivateTargetBlock = targetBlock + 1n;
    queued.unboundedPrivateExposure = queued.validThroughBlock === undefined;
  }

  try {
    // A direct submission has no preparation window, so establish its durable
    // barrier immediately before any transport request.
    persistPreparedFlight(queued);
    queued.journaled = true;
  } catch (error) {
    if (error instanceof AtomicWriteCommittedError) {
      queued.journaled = true;
      runtime.setJournalHealth(false, error.message);
    } else if (reserved) {
      nonceManager.releaseContiguous([nonce]);
    }
    throw error;
  }

  const abortDirectBeforeDelivery = (): SubmitResult | null => {
    const aborted = new Map<number, BundleTxResult>();
    if (!abortQueuedBeforeDelivery([queued], aborted)) return null;
    return {
      ...base,
      txHash: signedTxHash,
      lineageId: queued.lineageId,
      targetBlock,
      error: "transaction submission aborted before delivery",
    };
  };
  const abortedAfterBarrier = abortDirectBeforeDelivery();
  if (abortedAfterBarrier) return abortedAfterBarrier;

  const directReplacementUuids = new Map<bigint, string>();
  if (appConfig.mode === "mainnet"
    && privateEligible
    && appConfig.builderUrls.some((endpoint) => sameEndpoint(endpoint, appConfig.flashbotsRelayUrl))) {
    directReplacementUuids.set(targetBlock, globalThis.crypto.randomUUID());
    directReplacementUuids.set(targetBlock + 1n, globalThis.crypto.randomUUID());
  }
  const priorReplacementUuids = [...new Set([
    ...(opts.replacement?.replacementUuids ?? []),
    ...(opts.replacement?.replacementUuid ? [opts.replacement.replacementUuid] : []),
  ])];
  for (const priorUuid of priorReplacementUuids) {
    if (opts.signal?.aborted) break;
    if (!flashbotsCancellationIsSafe(account.address, priorUuid, [queued], targetBlock - 1n)) continue;
    try {
      await flashbotsRpcWithTimeout(
        "eth_cancelBundle",
        [{ replacementUuid: priorUuid }],
        appConfig.flashbotsRelayUrl,
        SEND_BUNDLE_TIMEOUT_MS,
      );
    } catch (error) {
      logger.warn(`Flashbots cancellation for ${priorUuid} ambiguous:`, (error as Error).message);
    }
  }
  const abortedAfterCancellation = abortDirectBeforeDelivery();
  if (abortedAfterCancellation) return abortedAfterCancellation;
  const privatePromise: Promise<DeliveryOutcome[]> = appConfig.mode === "mainnet" && privateEligible
    ? Promise.all(appConfig.builderUrls.flatMap((endpoint) =>
      [targetBlock, targetBlock + 1n].map((block) => sendPrivateBundle(
        endpoint,
        [signed],
        block,
        opts.simTimestamp,
        sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
          ? directReplacementUuids.get(block)
          : undefined,
      )),
    ))
    : Promise.resolve([]);
  const [privateOutcomes, publicResults] = await Promise.all([
    privatePromise,
    sendPublicBatch([queued], opts.simTimestamp),
  ]);
  const outcomes = [...privateOutcomes, publicResults.get(nonce)!];
  let state = reconciledDeliveryState(outcomes);
  const retainRejectedFence = requiresNonceReconciliation(outcomes)
    || hasUnboundedPrivateRawExposure(queued, outcomes);
  const terminal = state === "rejected";
  let journalError: string | undefined;
  let journalCommitted = false;
  try {
    submissionJournal.mutate(account.address, terminal ? {
      remove: [signedTxHash],
    } : {
      updates: [{
        txHash: signedTxHash,
        update: {
          state,
          publicExposure: publicExposure(outcomes),
          nonceConflict: hasSameNonceExposureEvidence(outcomes)
            || hasUnboundedPrivateRawExposure(queued, outcomes),
          attempts: outcomes.map(journalAttempt).filter(
            (attempt): attempt is JournalDeliveryAttempt => attempt !== null,
          ),
          maxPrivateTargetBlock: maxPrivateTarget(outcomes)?.toString(),
          updatedAtMs: Date.now(),
        },
      }],
    });
    journalCommitted = true;
  } catch (error) {
    journalError = `submission journal update failed: ${(error as Error).message}`;
    logger.error(journalError);
    runtime.setJournalHealth(false, journalError);
    if (error instanceof AtomicWriteCommittedError) {
      // The visible WAL already contains the outcome/removal. Preserve that
      // state so nonce bookkeeping matches it, while reporting unhealthy
      // durability for operator intervention.
      journalCommitted = true;
    } else {
      state = "ambiguous";
    }
  }

  if (
    state === "rejected"
    && reserved
    && journalCommitted
    && nonceManager.releaseContiguous([nonce])
  ) {
    if (retainRejectedFence) nonceManager.reset();
  } else if (state === "rejected" && !reserved) {
    nonceManager.markDelivery(nonce, "ambiguous", {
      txHash: opts.replacement?.priorTxHash ?? signedTxHash,
      retainRejectedFence: true,
    });
  } else {
    nonceManager.markDelivery(nonce, nonceFlightState(state, outcomes), {
      txHash: signedTxHash,
      publicExposure: publicExposure(outcomes),
      maxPrivateTargetBlock: maxPrivateTarget(outcomes),
      retainBeyondPrivateTarget: hasSameNonceExposureEvidence(outcomes)
        || hasUnboundedPrivateRawExposure(queued, outcomes)
        || maxPrivateTarget(outcomes) !== undefined
        || opts.validThroughBlock !== undefined,
      retainRejectedFence: state === "rejected",
    });
  }
  const bundleHash = privateOutcomes.find((outcome) => outcome.bundleHash)?.bundleHash;
  const activeDirectReplacementUuids = [...directReplacementUuids.values()];
  const error = journalError
    ?? outcomes.find((outcome) => outcome.error)?.error
    ?? (state === "ambiguous" ? "delivery unacknowledged" : undefined);
  return {
    ...base,
    ok: state !== "rejected",
    uncertain: state === "ambiguous" ? true : undefined,
    bundleHash,
    replacementUuid: activeDirectReplacementUuids.length === 1
      ? activeDirectReplacementUuids[0]
      : undefined,
    replacementUuids: activeDirectReplacementUuids.length > 0
      ? activeDirectReplacementUuids
      : undefined,
    lineageId: queued.lineageId,
    maxPrivateTargetBlock: maxPrivateTarget(outcomes),
    replacementUuidCohortSize: activeDirectReplacementUuids.length > 0 ? 1 : undefined,
    txHash: signedTxHash,
    targetBlock,
    error,
  };
}
