import fs from "node:fs";
import path from "node:path";
import {
  keccak256,
  parseEther,
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
import { mainnet } from "viem/chains";
import { publicClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { nonceManager } from "./nonce.js";
import { cappedReplacementFees, effectiveTipGwei, nextReplacementFee, resolveGas } from "./logic.js";
import {
  JournalCorruptionError,
  SubmissionFlightJournal,
  type JournalDeliveryAttempt,
  type JournalFlight,
  type JournalReconciliation,
} from "./submission-journal.js";
import { logger } from "./logger.js";
import { AtomicWriteCommittedError, writeFileAtomicDurableSync } from "./durability.js";

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

const submissionJournal = new SubmissionFlightJournal(appConfig.dataDir);

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
    retainBeyondPrivateTarget: flight.nonceConflict,
  };
}

function reconcileAtCounts(
  address: Address,
  confirmedNonce: number,
  pendingNonce: number,
  currentBlock: bigint,
): JournalReconciliation {
  return submissionJournal.reconcile(address, confirmedNonce, pendingNonce, currentBlock);
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

/** Reconcile durable flights without mistaking txpool visibility for finality.
 * Only the latest/confirmed nonce consumes a flight; pending advances allocation
 * while every liability remains available to strategy recovery. */
export async function reconcileSubmissionJournal(address: Address): Promise<JournalReconciliation> {
  await validateJournalSigners(address);
  const currentBlock = await publicClient.getBlockNumber();
  const [confirmedNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({ address, blockNumber: currentBlock }),
    publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return reconcileAtCounts(address, confirmedNonce, pendingNonce, currentBlock);
}

/** Explicit, mutating recovery delivery. Call only from an operator-authorized
 * engine start/JIT-arm path; unlock/preflight reconciliation stays read-only. */
export async function recoverPreparedSubmissions(
  address: Address,
  signal?: AbortSignal,
  authorizeFlight?: (flight: JournalFlight) => Promise<boolean>,
): Promise<JournalReconciliation> {
  const reconciliation = await reconcileSubmissionJournal(address);
  return recoverJournalFlights(reconciliation, signal, authorizeFlight);
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
}).setRecoveryHook?.(async (address, confirmedNonce, pendingNonce, currentBlock) => {
  await validateJournalSigners(address);
  const coherentBlock = currentBlock ?? await publicClient.getBlockNumber();
  const reconciliation = reconcileAtCounts(address, confirmedNonce, pendingNonce, coherentBlock);
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
): Promise<any> {
  const signer = getAuthSigner();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  // Flashbots requires this reputation signature; other builders accept or ignore it.
  const signature = `${signer.address}:${await signer.signMessage({
    message: keccak256(toHex(body)),
  })}`;
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
    throw new Error(`${method} @${hostOf(url)} returned an unreadable response`, { cause: error });
  }
  if (json.error) throw new RpcRejectedError(`${method} @${hostOf(url)}: ${json.error.message}`);
  if (res.ok === false) throw new Error(`${method} @${hostOf(url)} returned HTTP ${res.status}`);
  return json.result;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
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
  const priority = BigInt(Math.round(tipGwei * 1e9));
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
    chainId: runtime.chainId ?? mainnet.id,
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
): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await flashbotsRpc(method, params, abort.signal, url);
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
  /** Deprecated compatibility flag. Delivery is always fail-closed and the
   * transport never couples an optional suffix to a mandatory obligation. */
  revertible?: boolean;
}
let bundleQueue: QueuedTx[] | null = null;

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

/** Extract the first failure. Mandatory automation always fails closed. */
function bundleSimulationIssue(sim: any): BundleSimulationIssue | null {
  if (sim?.error) return { failure: String(sim.error), index: null };
  const results = sim?.results ?? [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result?.error && !result?.revert) continue;
    return { failure: String(result.error ?? result.revert), index };
  }
  return null;
}

function bundleSimulationFailure(sim: any): string | null {
  return bundleSimulationIssue(sim)?.failure ?? null;
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

function isExplicitPublicRejection(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? String(err);
  return /insufficient funds|invalid sender|intrinsic gas|exceeds block gas|fee cap less than block base fee|transaction underpriced|replacement transaction underpriced|nonce too (?:low|high)|invalid transaction|gas required exceeds allowance/i.test(message);
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
  return flight.recovery.publicAuthorized
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

async function rebroadcastJournalFlight(flight: JournalFlight): Promise<DeliveryOutcome> {
  const endpoint = "public-rpc-recovery";
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
      state: isExplicitPublicRejection(error) ? "rejected" : "ambiguous",
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
  let reconciliation = initialReconciliation;
  let candidates = contiguousRecoveryCandidates(
    recoveryCandidates(reconciliation.retained, Date.now()),
    reconciliation.confirmedNonce,
    reconciliation.pendingNonce,
  );
  while (candidates.length > 0) {
    const notBefore = candidates.reduce((latest, flight) => {
      const candidate = flight.recovery.notBeforeTimestamp === undefined
        ? 0n
        : BigInt(flight.recovery.notBeforeTimestamp);
      return candidate > latest ? candidate : latest;
    }, 0n);
    if (notBefore * 1_000n <= BigInt(Date.now())) break;
    await waitUntilTimestamp(notBefore, signal);
    // The wait may span many blocks. Reconcile nonce terminality again before
    // authorizing spend, then bind the balance read to that exact block.
    reconciliation = await reconcileSubmissionJournal(candidates[0]!.wallet);
    candidates = contiguousRecoveryCandidates(
      recoveryCandidates(reconciliation.retained, Date.now()),
      reconciliation.confirmedNonce,
      reconciliation.pendingNonce,
    );
  }
  if (candidates.length === 0) return reconciliation;

  if (authorizeFlight) {
    let authorized: boolean[];
    try {
      // Finish every current-state authorization before the first simulation or
      // transport request. A callback RPC failure therefore cannot leave a
      // partially replayed recovery batch.
      authorized = await Promise.all(candidates.map((flight) => authorizeFlight(flight)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `submission recovery authorization failed closed: ${reason}`,
        { cause: error },
      );
    }
    const firstDenied = authorized.findIndex((allowed) => !allowed);
    if (firstDenied !== -1) candidates = candidates.slice(0, firstDenied);
    // An ordinary semantic denial leaves the exact prepared entry in the WAL so
    // strategy can replace it or fill its nonce without replaying stale work.
    // It is also a nonce barrier: never expose a higher recovered transaction
    // that could remain queued and execute after the denied intent becomes stale.
    if (candidates.length === 0) return reconciliation;
  }

  const wallet = candidates[0]!.wallet;
  const balanceWei = await publicClient.getBalance({
    address: wallet,
    blockNumber: reconciliation.currentBlock,
  });
  const maximumExposureWei = liveMaximumExposure(reconciliation.retained);
  const floorWei = parseEther(String(runtime.strategy.minBalanceEth));
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
      attempts: JournalDeliveryAttempt[];
      updatedAtMs: number;
    };
  }> = [];
  let prefixClosed = false;
  for (let start = 0; start < candidates.length; start += 32) {
    const chunk = candidates.slice(start, start + 32);
    const simulated = await Promise.all(chunk.map(async (flight) => {
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
    }));
    const firstFailedSimulation = simulated.findIndex((passed) => !passed);
    const simulatedPrefixLength = firstFailedSimulation === -1
      ? chunk.length
      : firstFailedSimulation;
    for (let index = 0; index < simulatedPrefixLength; index++) {
      const flight = chunk[index]!;
      const outcome = await rebroadcastJournalFlight(flight);
      const attempt = journalAttempt(outcome)!;
      flight.state = outcome.state === "accepted" ? "accepted" : "ambiguous";
      flight.publicExposure = outcome.state !== "rejected";
      flight.attempts = [...flight.attempts, attempt];
      flight.updatedAtMs = now;
      updates.push({
        txHash: flight.txHash,
        update: {
          state: flight.state,
          publicExposure: flight.publicExposure,
          attempts: flight.attempts,
          updatedAtMs: now,
        },
      });
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
    if (isExplicitPublicRejection(error)) {
      return { state: "rejected", channel: "public", endpoint, error: message };
    }
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
): Record<string, unknown> {
  const params: Record<string, unknown> = { txs, blockNumber: toHex(blockNumber) };
  if (minTimestamp !== undefined) params.minTimestamp = Number(minTimestamp);
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
  return {
    channel: outcome.channel,
    endpoint: outcome.endpoint,
    state: outcome.state,
    targetBlock: outcome.targetBlock?.toString(),
    replacementUuid: outcome.replacementUuid,
    cancellationSupported: outcome.channel === "private"
      && sameEndpoint(outcome.endpoint, appConfig.flashbotsRelayUrl),
    error: outcome.error,
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
): Promise<DeliveryOutcome> {
  try {
    const result = await flashbotsRpcWithTimeout(
      "eth_sendBundle",
      [sendBundleParams(txs, targetBlock, minTimestamp, replacementUuid, endpoint)],
      endpoint,
      SEND_BUNDLE_TIMEOUT_MS,
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
      state: error instanceof RpcRejectedError ? "rejected" : "ambiguous",
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

function requiresNonceReconciliation(outcomes: readonly DeliveryOutcome[]): boolean {
  return outcomes.some((outcome) =>
    /nonce too (?:low|high)|replacement transaction underpriced|already imported/i.test(outcome.error ?? ""),
  );
}

/** Evidence that this nonce (or an equivalent replacement) may remain live
 * after private bundle targets expire. `nonce too high` is deliberately absent:
 * it proves a lower gap, not exposure at the submitted nonce, and retaining the
 * higher flight forever would prevent the allocator from going back to fill it. */
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
    && !publicExposure(outcomes)
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
  const simulationTimestamps = [
    ...new Set(queue.flatMap((q) => q.simTimestamp === undefined ? [] : [q.simTimestamp.toString()])),
  ];
  if (simulationTimestamps.length > 1) {
    return failPreparedQueue(queue, out, "bundle contains conflicting simulation timestamps");
  }
  const simTimestamp = simulationTimestamps[0] === undefined
    ? undefined
    : BigInt(simulationTimestamps[0]);

  let targetBlock: bigint;
  try {
    targetBlock = (await publicClient.getBlockNumber()) + 1n;
  } catch (err) {
    failPreparedQueue(queue, out, `target block lookup failed: ${(err as Error).message}`);
    throw err;
  }
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  let privateQueue: QueuedTx[] = [];
  let privateDisabledReason: string | undefined;
  if (appConfig.mode === "mainnet") {
    let blockGasLimit: bigint | undefined;
    try {
      blockGasLimit = (await getLatestBlockCached()).gasLimit;
    } catch (error) {
      privateDisabledReason = `bundle gas validation unavailable: ${(error as Error).message}`;
    }
    if (blockGasLimit !== undefined) {
      privateQueue = queue.slice(0, privateBundlePrefixLength(queue, blockGasLimit));
      if (privateQueue.length < queue.length) {
        privateDisabledReason = `private bundle limited to nonce prefix ${privateQueue.length}/${queue.length}`;
        logger.warn(`${privateDisabledReason}; delivering the complete prepared sequence publicly`);
      }
    }

    // Simulate only the nonce prefix that can be submitted as a valid private
    // bundle. A deterministic failure suppresses the dependent sequence; relay
    // unavailability merely disables private delivery and preserves public safety.
    if (privateQueue.length > 0) {
      const privateSigned = privateQueue.map((q) => q.signed);
      const simParams: Record<string, unknown> = {
        txs: privateSigned,
        blockNumber: toHex(targetBlock),
        stateBlockNumber: "latest",
      };
      if (simTimestamp !== undefined) simParams.timestamp = Number(simTimestamp);
      try {
        const sim = await flashbotsRpcWithTimeout(
          "eth_callBundle",
          [simParams],
          undefined,
          BUNDLE_SIM_TIMEOUT_MS,
        );
        const issue = bundleSimulationIssue(sim);
        if (issue) {
          const error = `bundle simulation reverted: ${issue.failure}`;
          if (issue.index === null || issue.index <= 0 || issue.index >= privateQueue.length) {
            return failPreparedQueue(queue, out, error);
          }

          // The relay simulated this exact ordered sequence and reported clean
          // results for every lower nonce. Those transactions are independently
          // executable as a prefix. The failing nonce and every dependent higher
          // nonce have not crossed the WAL/delivery barrier, so release them as
          // one fresh top suffix and continue with only the validated prefix.
          const failedSuffix = queue.splice(issue.index);
          privateQueue = privateQueue.slice(0, issue.index);
          failPreparedQueue(failedSuffix, out, error);
          logger.warn(
            `${error}; delivering validated nonce prefix ${privateQueue.length}/${privateQueue.length + failedSuffix.length}`,
          );
        }
      } catch (err) {
          privateDisabledReason = `bundle simulation unavailable: ${(err as Error).message}`;
          privateQueue = [];
          logger.warn(`${privateDisabledReason}; continuing with individually simulated public delivery`);
      }
    }
  }
  for (const q of privateQueue) q.plannedMaxPrivateTargetBlock = targetBlock + 1n;
  // stopEngine may have invalidated this generation while getBlockNumber or the
  // whole-bundle simulation was in flight. No delivery request has started yet,
  // so cancellation remains definite and fresh reservations can be released.
  if (abortQueuedBeforeDelivery(queue, out)) return out;

  try {
    // No transaction is live before this point, so one wallet-scoped atomic
    // barrier covers the whole prepared campaign without O(n²) fsync churn.
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

  const priorReplacementUuids = [...new Set(queue.flatMap((q) => [
    ...(q.replacement?.replacementUuids ?? []),
    ...(q.replacement?.replacementUuid ? [q.replacement.replacementUuid] : []),
  ]))];
  const hasFlashbotsTarget = appConfig.builderUrls.some((endpoint) =>
    sameEndpoint(endpoint, appConfig.flashbotsRelayUrl),
  );
  const currentReplacementUuids = new Map<bigint, string>();
  if (appConfig.mode === "mainnet" && privateQueue.length > 0 && hasFlashbotsTarget) {
    currentReplacementUuids.set(targetBlock, globalThis.crypto.randomUUID());
    currentReplacementUuids.set(targetBlock + 1n, globalThis.crypto.randomUUID());
  }
  if (priorReplacementUuids.length > 0) {
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
        );
      } catch (error) {
        // Cancellation is capability-specific and best-effort. Old builder
        // lineages remain journaled until confirmation or their target expiry.
        logger.warn(`Flashbots cancellation for ${priorUuid} ambiguous:`, (error as Error).message);
      }
    });
    await Promise.all(cancellations);
  }
  // The engine can stop immediately after the WAL barrier or while a prior
  // Flashbots lineage is being cancelled. In both cases no new delivery has
  // started, so remove the prepared WAL before releasing its reservations.
  if (abortQueuedBeforeDelivery(queue, out)) return out;
  const privatePromise: Promise<DeliveryOutcome[]> = appConfig.mode === "mainnet" && privateQueue.length > 0
    ? Promise.all(appConfig.builderUrls.flatMap((endpoint) =>
      [targetBlock, targetBlock + 1n].map((block) =>
        sendPrivateBundle(
          endpoint,
          privateQueue.map((q) => q.signed),
          block,
          simTimestamp,
          sameEndpoint(endpoint, appConfig.flashbotsRelayUrl)
            ? currentReplacementUuids.get(block)
            : undefined,
        ),
      ),
    ))
    : Promise.resolve([]);
  const publicPromise = sendPublicBatch(queue, simTimestamp);
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
    privateOutcomes.filter((outcome) => outcome.state === "accepted").map((outcome) => hostOf(outcome.endpoint)),
  );
  if (acceptedBuilders.size > 0) {
    logger.info(
      `batched bundle (${queue.length} tx) accepted by ${acceptedBuilders.size}/${appConfig.builderUrls.length} builders: ${[...acceptedBuilders].join(", ")}`,
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
      retainFence: requiresNonceReconciliation(outcomes),
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
          nonceConflict: hasSameNonceExposureEvidence(outcomes),
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
        retainBeyondPrivateTarget: hasSameNonceExposureEvidence(outcomes),
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
    },
    state: "prepared",
    publicExposure: false,
    nonceConflict: false,
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
    /** Deprecated input retained for callers during migration. Every queued
     * transaction is mandatory; optional/revertible suffix coupling is removed. */
    revertible?: boolean;
    /** Absolute wall-clock cutoff for optional work riding a mandatory bundle. */
    deadlineMs?: number;
    /** Replace a previously signed transaction without consuming a new nonce. */
    replacement?: ReplacementOptions;
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
  // Authentication identity corruption is local fatal state, not relay
  // unavailability. Validate/create it before simulation fallbacks can
  // accidentally reinterpret the error as a tolerable network failure.
  if (appConfig.mode === "mainnet") getAuthSigner();
  const batching = bundleQueue !== null;

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
  } else if (appConfig.mode === "mainnet" && !batching) {
    // Flashbots bundle simulation needs a signed tx — use peeked nonce (not consumed yet).
    const simSigned = await signTx(account, intent, candidateNonce, gas, maxFeePerGas, maxPriorityFeePerGas);
    try {
      const sim = await flashbotsRpcWithTimeout("eth_callBundle", [
        { txs: [simSigned], blockNumber: toHex(targetBlock), stateBlockNumber: "latest" },
      ]);
      const failure = bundleSimulationFailure(sim);
      if (failure) {
        return { ...base, simulated: true, error: `sim revert: ${failure}`, targetBlock };
      }
      base.simulated = true;
    } catch (err) {
      // The relay being slow/down must NOT block a payment — that can cost a
      // citizen, and mainnet is the default mode. Fall back to a plain eth_call
      // against our own RPC instead of skipping the tx entirely.
      logger.warn(`relay sim unavailable (${(err as Error).message}); falling back to eth_call`);
      try {
        await publicClient.call({
          account: account.address,
          to: intent.to,
          data: intent.data,
          value: intent.value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        base.simulated = true;
      } catch (e2) {
        return { ...base, simulated: true, error: `sim revert: ${(e2 as Error).message}`, targetBlock };
      }
    }
  } else {
    // Plain eth_call — no nonce needed, no relay round-trip.
    // Batched transactions use this individual semantic check while they
    // are being assembled; flushBundle later simulates their signed nonce sequence
    // as one ordered eth_callBundle before private/public submission.
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
    const authorization = await opts.authorize({
      valueWei: intent.value,
      gasWei,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
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
    signed = await signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas);
  } catch (error) {
    if (reserved) nonceManager.releaseContiguous([nonce]);
    throw error;
  }
  const signedTxHash = keccak256(signed);
  const queued: QueuedTx = {
    wallet: account.address,
    signed,
    txHash: signedTxHash,
    lineageId: opts.replacement?.lineageId ?? `${account.address.toLowerCase()}:${nonce}`,
    nonce,
    race: appConfig.mode === "mainnet" ? opts.race ?? false : true,
    reserved,
    journaled: false,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    intent,
    simTimestamp: opts.simTimestamp,
    signal: opts.signal,
    replacement: opts.replacement,
    revertible: false,
  };
  // Every mode uses the same preparation batch. This guarantees all due nonces
  // are reserved and signed before the shared boundary wait starts.
  if (bundleQueue !== null) {
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

  const privateEligible = privateBundlePrefixLength([queued], latest.gasLimit) === 1;
  if (appConfig.mode === "mainnet" && privateEligible) {
    queued.plannedMaxPrivateTargetBlock = targetBlock + 1n;
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
  const retainRejectedFence = requiresNonceReconciliation(outcomes);
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
          nonceConflict: hasSameNonceExposureEvidence(outcomes),
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
      retainBeyondPrivateTarget: hasSameNonceExposureEvidence(outcomes),
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
