import { decodeFunctionData, parseEther, formatEther, type Address, type Hex } from "viem";
import {
  AUDIT_COST_WEI,
  WINNERS,
  EPOCH_DURATION_SECONDS,
  BASE_TAX_RATE_WEI,
  citizensAbi,
} from "@dat-bot/shared";
import { publicClient, wsClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { activity } from "./activity.js";
import { nonceManager } from "./nonce.js";
import {
  getGameSnapshot,
  batchGetOwnedStatuses,
  batchGetTargetStatuses,
  filterLiveTokenIds,
  encodePayTaxes,
  encodeAudit,
  encodeKill,
  encodeUseBribe,
  gameContract,
} from "./contract.js";
import {
  fetchOwnedTokenIds,
  filterOwnedTokenIds,
  fetchCandidateTokenIds,
  ownershipIndexingAvailable,
} from "./index-tokens.js";
import {
  submitTx,
  beginBundle,
  flushBundle,
  discardBundle,
  waitForBundleFallbacks,
  reconcileSubmissionJournal,
  recoverPreparedSubmissions,
  type TxIntent,
  type SubmitResult,
} from "./flashbots.js";
import { resolveGas, effectiveTipGwei, cappedReplacementFees, canAffordSpend, isEligibleAuditor, isAuditable, isKillable, preBoundaryTaxWei, cappedAutoPayEpochs, orderBySalt } from "./logic.js";
import { logger } from "./logger.js";
import { AtomicWriteCommittedError } from "./durability.js";

const TICK_MS = 12_000; // fallback poll interval when WebSocket unavailable
// Preliminary guard uses at least the largest fixed campaign gas limit. The
// transport's post-estimation authorization below rechecks the exact quote.
const GAS_GUESS = 250_000n;

let timer: NodeJS.Timeout | null = null;
let boundaryTimer: NodeJS.Timeout | null = null;
let offenseBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryAuditTimer: NodeJS.Timeout | null = null;
let preBoundaryKillTimer: NodeJS.Timeout | null = null;
let unwatchBlocks: (() => void) | null = null;
let ticking = false;
let engineGeneration = 0;
let executingGeneration: number | null = null;
let engineAbortController: AbortController | null = null;
let idleWaiters: Array<() => void> = [];
let preBoundaryPaymentActive = false;
let survivalOffenseFenceUntilMs = 0;

function executionIsCurrent(generation: number): boolean {
  return runtime.running && generation === engineGeneration;
}

function finishExclusive(generation: number): void {
  if (executingGeneration === generation) executingGeneration = null;
  ticking = false;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
  // If a new run started while the old run was winding down, its immediate tick
  // was intentionally blocked by `ticking`; start it now under the new generation.
  if (runtime.running && generation !== engineGeneration) void tick(engineGeneration);
}

export async function waitForEngineIdle(): Promise<void> {
  if (ticking) {
    await new Promise<void>((resolve) => idleWaiters.push(resolve));
  }
  await waitForBundleFallbacks();
}
// Randomized once per engine start (see startEngine) and used to reorder the
// rival sweep (offensePass, firePreBoundaryAudit, firePreBoundaryKill) so every
// bot instance doesn't audit/kill candidates in the same identical order — the
// candidate list order itself is identical for everyone (same indexer, same
// on-chain order), so without this every user piles onto the same first few
// targets and starves the ones later in the list.
let engineSalt = 0;
// Total wei committed to spend so far in the current tick (value + gas of each
// submitted tx). Reset at the top of every tick; consulted by canSpend so the
// min-balance floor holds across all spends in a tick, not just each in isolation.
let committedThisTickWei = 0n;
let paymentWorkUnsafeThisTick = false;

type PaymentSource = "pre-boundary" | "defense" | "proactive" | "jit";

interface PaymentFlight {
  attemptId: number;
  account: Address;
  tokenId: string;
  startingLastEpochPaid: bigint | null;
  expectedLastEpochPaid: bigint;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  txHash?: Hex;
  lineageId: string;
  replacementUuids: string[];
  retryImmediately: boolean;
  obligationCovered: boolean;
  cancelRequired: boolean;
  inertFiller: boolean;
  recoveredGap: boolean;
  source: PaymentSource;
  /** Epoch whose tax schedule produced valueWei. */
  pricedEpoch: bigint;
  /** Target-scoped obligations carried across same-nonce replacements. */
  jitTargetEpoch: number | null;
  jitCampaignRevision: number | null;
  proactiveEpoch: bigint | null;
  proactiveMarkerReserved: boolean;
  submittedAtMs: number;
  delivery: "queued" | "submitted" | "included";
}

type SemanticActionKind = "use-bribe" | "audit" | "kill";
type ActionUrgency = "routine" | "survival" | "boundary";

interface ActionFlight {
  attemptId: number;
  key: string;
  kind: SemanticActionKind;
  account: Address;
  nonce: number;
  tokenId?: string;
  targetTokenId?: string;
  auditorTokenId?: string;
  valueWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  txHash?: Hex;
  lineageId: string;
  replacementUuids: string[];
  retryImmediately: boolean;
  obsolete: boolean;
  inertFiller: boolean;
  urgency: ActionUrgency;
  notBeforeTimestamp: bigint | null;
  submittedAtMs: number;
  delivery: "queued" | "submitted" | "included";
}

type ReplacementFlight = Pick<
  PaymentFlight | ActionFlight,
  | "account"
  | "nonce"
  | "valueWei"
  | "gasWei"
  | "maxFeePerGas"
  | "maxPriorityFeePerGas"
  | "txHash"
  | "lineageId"
  | "replacementUuids"
>;

interface BatchEntry {
  entryId: string;
  nonce: number;
  message: string;
  paymentAttemptId?: number;
  paymentTokenId?: string;
  previousPaymentFlight?: PaymentFlight;
  actionAttemptId?: number;
  actionKey?: string;
  previousActionFlight?: ActionFlight;
  liabilityAccount?: Address;
  liabilityNonce?: number;
  previousLiability?: PendingLiability;
}

/** Worst-case signed exposure for one wallet nonce. Replacements form one
 * mutually-exclusive lineage, so the liability is the maximum alternative in
 * that lineage rather than the sum of every signed replacement. */
interface PendingLiability {
  account: Address;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  maxExposureWei: bigint;
  txHash?: Hex;
  submittedAtMs: number;
  delivery: "queued" | "submitted";
}

// One shared guard covers every tax-payment path. The on-chain lastEpochPaid
// value remains authoritative; this map only prevents a still-pending tx from
// being duplicated by another pass while that value is necessarily stale.
const paymentFlights = new Map<string, PaymentFlight>();
let nextPaymentAttemptId = 0;
const actionFlights = new Map<string, ActionFlight>();
let nextActionAttemptId = 0;
let paymentFlightAccount: Address | null = null;
const pendingLiabilities = new Map<string, PendingLiability>();
let committedNoncesThisTick = new Set<string>();
let liabilitySettlementRevision = 0;
let spendableBalanceRevision = -1;
let balanceMustIncludeBlock: bigint | null = null;

function uniqueUuids(...groups: ReadonlyArray<readonly (string | undefined)[]>): string[] {
  return [...new Set(groups.flatMap((group) => group.filter((uuid): uuid is string => Boolean(uuid))))];
}

function semanticActionKey(
  kind: SemanticActionKind,
  tokenId?: string,
  targetTokenId?: string,
): string | null {
  if (kind === "use-bribe") return tokenId === undefined ? null : `use-bribe:${tokenId}`;
  return targetTokenId === undefined ? null : `${kind}:${targetTokenId}`;
}

function pendingActionFor(
  kind: SemanticActionKind,
  tokenId?: string,
  targetTokenId?: string,
  address: Address | undefined = runtime.account?.address,
): ActionFlight | undefined {
  const key = semanticActionKey(kind, tokenId, targetTokenId);
  if (key === null || address === undefined) return undefined;
  const flight = actionFlights.get(key);
  return flight?.account.toLowerCase() === address.toLowerCase() ? flight : undefined;
}

function reservePendingAuditorCapacity(auditors: bigint[], address: Address): bigint[] {
  const normalized = address.toLowerCase();
  const reserved = new Map<string, number>();
  for (const flight of actionFlights.values()) {
    if (
      flight.account.toLowerCase() !== normalized
      || flight.kind !== "audit"
      || flight.auditorTokenId === undefined
    ) continue;
    reserved.set(flight.auditorTokenId, (reserved.get(flight.auditorTokenId) ?? 0) + 1);
  }
  return auditors.filter((tokenId) => {
    const key = tokenId.toString();
    const count = reserved.get(key) ?? 0;
    if (count === 0) return true;
    reserved.set(key, count - 1);
    return false;
  });
}

function liabilityKey(account: Address, nonce: number): string {
  return `${account.toLowerCase()}:${nonce}`;
}

function publishPendingExposure(): void {
  const account = runtime.account?.address.toLowerCase();
  const total = account === undefined
    ? 0n
    : [...pendingLiabilities.values()]
        .filter((flight) => flight.account.toLowerCase() === account)
        .reduce((sum, flight) => sum + flight.maxExposureWei, 0n);
  runtime.setPendingExposure(total);
}

function setPendingLiability(flight: PendingLiability): PendingLiability | undefined {
  const key = liabilityKey(flight.account, flight.nonce);
  const previous = pendingLiabilities.get(key);
  pendingLiabilities.set(key, {
    ...flight,
    maxExposureWei: previous === undefined || flight.maxExposureWei > previous.maxExposureWei
      ? flight.maxExposureWei
      : previous.maxExposureWei,
  });
  publishPendingExposure();
  return previous;
}

function restorePendingLiability(previous: PendingLiability | undefined, account: Address, nonce: number): void {
  const key = liabilityKey(account, nonce);
  if (previous) pendingLiabilities.set(key, previous);
  else pendingLiabilities.delete(key);
  publishPendingExposure();
}

function settlePendingLiability(account: Address, nonce: number, terminalBlock?: bigint): boolean {
  const deleted = pendingLiabilities.delete(liabilityKey(account, nonce));
  if (deleted) {
    // Terminal nonce evidence may be newer than the balance snapshot used by
    // this execution. Fail closed until a post-settlement balance is fetched;
    // otherwise releasing the liability could manufacture spendable headroom.
    if (runtime.account?.address.toLowerCase() === account.toLowerCase()) {
      liabilitySettlementRevision += 1;
      spendableBalanceRevision = -1;
      if (
        terminalBlock !== undefined
        && (balanceMustIncludeBlock === null || terminalBlock > balanceMustIncludeBlock)
      ) {
        balanceMustIncludeBlock = terminalBlock;
      }
      runtime.balanceWei = null;
    }
    publishPendingExposure();
  }
  return deleted;
}

function outstandingLiabilityWei(address: Address, excludedNonce?: number): bigint {
  const normalized = address.toLowerCase();
  return [...pendingLiabilities.values()].reduce((sum, flight) => {
    if (flight.account.toLowerCase() !== normalized || flight.nonce === excludedNonce) return sum;
    if (committedNoncesThisTick.has(liabilityKey(flight.account, flight.nonce))) return sum;
    return sum + flight.maxExposureWei;
  }, 0n);
}

function hasUnresolvedPaymentFlight(address: Address): boolean {
  const normalized = address.toLowerCase();
  return [...paymentFlights.values()].some((flight) => flight.account.toLowerCase() === normalized);
}

function markPaymentWorkUnsafe(): void {
  paymentWorkUnsafeThisTick = true;
}

function offenseTemporarilyFenced(): boolean {
  return Date.now() < survivalOffenseFenceUntilMs;
}

// Activity entries whose tx was queued into the current bundle batch (mainnet).
// flushBatch fills in each one's txHash/bundleHash and reconciles provisional
// payment-flight state once the whole batch has actually been delivered.
let batchEntries: BatchEntry[] = [];
let batchOpened = false;

/** Open a submission batch in every mode. The transport fully prepares/signs the
 * sequence first, then flushes it with one common future-timestamp wait. */
function beginBatch(): void {
  batchEntries = [];
  batchOpened = true;
  beginBundle();
}

/** Release the prepared sequence and reconcile each activity entry. */
async function flushBatch(): Promise<void> {
  const entries = batchEntries;
  batchEntries = [];
  const wasOpen = batchOpened;
  batchOpened = false;
  if (!wasOpen) return;
  if (entries.length === 0) {
    discardBundle("empty batch");
    return;
  }
  let results: Awaited<ReturnType<typeof flushBundle>>;
  try {
    results = await flushBundle();
  } catch (err) {
    logger.error("bundle flush error:", (err as Error).message);
    for (const entry of entries) reconcileFailedBatchEntry(entry, "bundle flush error");
    return;
  }
  const uuidNonces = new Map<string, Set<number>>();
  for (const [nonce, result] of results) {
    for (const uuid of uniqueUuids(result.replacementUuids ?? [], [result.replacementUuid])) {
      const nonces = uuidNonces.get(uuid) ?? new Set<number>();
      nonces.add(nonce);
      uuidNonces.set(uuid, nonces);
    }
  }
  for (const entry of entries) {
    const { entryId, nonce } = entry;
    const r = results.get(nonce);
    if (!r || (!r.ok && !r.uncertain)) {
      reconcileFailedBatchEntry(entry, r?.error ?? "bundle was not delivered");
      continue;
    }
    activity.update(entryId, {
      status: r.uncertain ? "delivery-uncertain" : "submitted",
      txHash: r.txHash,
      bundleHash: r.bundleHash,
      message: r.uncertain
        ? `${entry.message} — delivery was not acknowledged; retaining the nonce and retrying safely`
        : entry.message,
    });
    const flight = currentBatchPaymentFlight(entry);
    if (flight) {
      flight.delivery = "submitted";
      flight.txHash = r.txHash ?? flight.txHash;
      flight.lineageId = r.lineageId ?? flight.lineageId;
      // Flashbots UUIDs cancel an entire target bundle, not one tx. Retain every
      // target UUID only when it protects this one live nonce lineage; otherwise
      // a later per-token replacement could cancel unrelated survival payments.
      const safeUuids = uniqueUuids(r.replacementUuids ?? [], [r.replacementUuid])
        .filter((uuid) => uuidNonces.get(uuid)?.size === 1);
      flight.replacementUuids = uniqueUuids(flight.replacementUuids, safeUuids);
      flight.retryImmediately = Boolean(r.retryImmediately);
    }
    const actionFlight = currentBatchActionFlight(entry);
    if (actionFlight) {
      actionFlight.delivery = "submitted";
      actionFlight.txHash = r.txHash ?? actionFlight.txHash;
      actionFlight.lineageId = r.lineageId ?? actionFlight.lineageId;
      const safeUuids = uniqueUuids(r.replacementUuids ?? [], [r.replacementUuid])
        .filter((uuid) => uuidNonces.get(uuid)?.size === 1);
      actionFlight.replacementUuids = uniqueUuids(actionFlight.replacementUuids, safeUuids);
      actionFlight.retryImmediately = Boolean(r.retryImmediately);
    }
    const liability = currentBatchLiability(entry);
    if (liability) {
      liability.delivery = "submitted";
      liability.txHash = r.txHash ?? liability.txHash;
    }
    if (r.txHash && liability) {
      void trackReceipt(entryId, r.txHash, liability, flight, actionFlight);
    }
  }
}

function discardBatch(reason = "engine stopped before bundle submission"): void {
  const entries = batchEntries;
  batchEntries = [];
  const wasOpen = batchOpened;
  batchOpened = false;
  const results = wasOpen ? discardBundle(reason) : new Map();
  for (const entry of entries) {
    const error = results.get(entry.nonce)?.error ?? reason;
    reconcileFailedBatchEntry(entry, error);
  }
}

async function flushOrDiscardBatch(generation: number): Promise<void> {
  if (executionIsCurrent(generation)) await flushBatch();
  else discardBatch();
}

function currentBatchPaymentFlight(entry: BatchEntry): PaymentFlight | undefined {
  if (entry.paymentTokenId === undefined || entry.paymentAttemptId === undefined) return undefined;
  const current = paymentFlights.get(entry.paymentTokenId);
  return current?.attemptId === entry.paymentAttemptId ? current : undefined;
}

function currentBatchActionFlight(entry: BatchEntry): ActionFlight | undefined {
  if (entry.actionKey === undefined || entry.actionAttemptId === undefined) return undefined;
  const current = actionFlights.get(entry.actionKey);
  return current?.attemptId === entry.actionAttemptId ? current : undefined;
}

function currentBatchLiability(entry: BatchEntry): PendingLiability | undefined {
  if (entry.liabilityAccount === undefined || entry.liabilityNonce === undefined) return undefined;
  return pendingLiabilities.get(liabilityKey(entry.liabilityAccount, entry.liabilityNonce));
}

function clearSourceMarker(flight: PaymentFlight): void {
  if (flight.proactiveMarkerReserved && proactivePaySubmittedEpoch === flight.proactiveEpoch) {
    proactivePaySubmitted.delete(flight.tokenId);
  }
}

function restoreSourceMarker(flight: PaymentFlight): void {
  if (flight.proactiveMarkerReserved && proactivePaySubmittedEpoch === flight.proactiveEpoch) {
    proactivePaySubmitted.add(flight.tokenId);
  }
}

function reconcileFailedBatchEntry(entry: BatchEntry, error: string): void {
  activity.update(entry.entryId, { status: "skipped", message: error });
  if (entry.liabilityAccount !== undefined && entry.liabilityNonce !== undefined) {
    restorePendingLiability(entry.previousLiability, entry.liabilityAccount, entry.liabilityNonce);
  }
  const flight = currentBatchPaymentFlight(entry);
  if (flight) {
    markPaymentWorkUnsafe();
    clearSourceMarker(flight);
    if (entry.previousPaymentFlight) {
      paymentFlights.set(flight.tokenId, entry.previousPaymentFlight);
      restoreSourceMarker(entry.previousPaymentFlight);
    } else {
      paymentFlights.delete(flight.tokenId);
    }
  }
  const actionFlight = currentBatchActionFlight(entry);
  if (actionFlight) {
    if (entry.previousActionFlight) actionFlights.set(actionFlight.key, entry.previousActionFlight);
    else actionFlights.delete(actionFlight.key);
  }
}

// NOTE: the pre-boundary races now simulate at the future boundary/expiry
// timestamp (see submitTx's simTimestamp), so they validate correctly in BOTH
// public mode (eth_call block overrides) and mainnet mode (eth_callBundle's
// timestamp field) — no mode gating needed.

/**
 * How early to pre-submit a boundary race, by submission path.
 *
 * public/local: build and simulate shortly before the boundary, but do not
 *   broadcast until the simulated timestamp so a prior block cannot consume the
 *   nonce with an overpayment revert.
 * mainnet: give builders a little more lead and set minTimestamp on the bundle;
 *   its public mirror is held to the same boundary timestamp. Keep the lead under
 *   a 12s slot so the intended target remains the next block in normal timing.
 */
function effectiveLeadMs(): number {
  const s = runtime.strategy;
  return appConfig.mode === "mainnet" ? s.preBoundaryLeadMainnetMs : s.preBoundaryLeadMs;
}

// A precisely-timed boundary tick (JIT / defense / offense) must not be silently
// dropped just because a routine block/poll tick happens to be running when its
// timer fires — that would push the payment/kill to the next ordinary tick and
// lose the boundary race. If a tick is in flight, retry shortly until it clears.
// Used ONLY for the setTimeout-driven boundary firings; the synchronous
// immediate-fire branches inside the schedulers keep dropping when nested in a
// tick, which is what avoids a re-entrant rerun loop.
const BOUNDARY_RETRY_MS = 250;
const PAYMENT_PRIORITY_OFFSET_MS = 250;
function fireBoundaryTick(generation = engineGeneration): void {
  if (!executionIsCurrent(generation)) return;
  if (ticking) {
    setTimeout(() => fireBoundaryTick(generation), BOUNDARY_RETRY_MS);
    return;
  }
  void tick(generation);
}

// Soonest future audit-expiry (kill deadline) seen in the last offense sweep, in
// unix seconds. Null when no rival token is currently under a pending audit.
let nextKillDeadlineSec: bigint | null = null;

function jitCampaignIsArmed(): boolean {
  return runtime.jitCampaign.state === "armed";
}

function paymentAutomationAuthorized(
  tokenId: string,
  pricedEpoch?: bigint,
  explicitTargetEpoch?: number | null,
): boolean {
  const inferredTarget = explicitTargetEpoch ?? (
    pricedEpoch !== undefined && pricedEpoch > 0n ? Number(pricedEpoch) : null
  );
  return runtime.strategy.defenseEnabled || (
    jitCampaignIsArmed()
    && runtime.jitCampaign.tokenIds.includes(tokenId)
    && runtime.jitCampaign.targetEpoch !== null
    && inferredTarget === runtime.jitCampaign.targetEpoch
    && (
      runtime.currentEpoch === null
      || runtime.currentEpoch <= BigInt(runtime.jitCampaign.targetEpoch)
    )
  );
}

// JIT one-shot bookkeeping: tokenIds confirmed for one exact campaign revision.
let jitSubmitted = new Set<string>();
let jitSubmittedRevision: number | null = null;

export function resetJitState(): void {
  jitSubmitted = new Set();
  jitSubmittedRevision = null;
}

function prepareJitBookkeeping(): void {
  const revision = jitCampaignIsArmed() ? runtime.jitCampaign.revision : null;
  if (revision !== null && jitSubmittedRevision !== revision) {
    jitSubmitted = new Set();
    jitSubmittedRevision = revision;
  }
}

// Proactive-pay bookkeeping: at most one successfully delivered automatic
// catch-up payment per token per epoch. The shared flight map handles pending
// deduplication; this cap prevents a deeply-behind Citizen from being drained by
// a new one-epoch payment on every 12-second tick.
let proactivePaySubmittedEpoch: bigint | null = null;
let proactivePaySubmitted = new Set<string>();
let journalReconciledGeneration = -1;

type RetainedJournalFlight = Awaited<ReturnType<typeof reconcileSubmissionJournal>>["retained"][number];
type JournalReconciliationResult = Awaited<ReturnType<typeof reconcileSubmissionJournal>>;

function signedFeesWithinCurrentLimits(
  flight: RetainedJournalFlight,
  offense: boolean,
  baseFeePerGas: bigint,
): boolean {
  const gas = resolveGas(runtime.strategy, offense);
  const maxBaseFeeWei = BigInt(Math.round(gas.maxBaseFeeGwei * 1e9));
  if (baseFeePerGas > maxBaseFeeWei) return false;

  // A recovered raw may be either the first signed attempt or a same-nonce
  // replacement. Honor every priority-fee source that can legitimately have
  // produced it, while retaining the current absolute replacement ceiling.
  const priorityCapGwei = Math.max(
    gas.priorityFeeGwei,
    gas.dynamicTipEnabled ? gas.dynamicTipMaxGwei : 0,
    gas.replacementPriorityFeeCapGwei ?? gas.priorityFeeGwei,
  );
  const priorityCapWei = BigInt(Math.round(priorityCapGwei * 1e9));
  const maxFeeCapWei = maxBaseFeeWei * 2n + priorityCapWei;
  return BigInt(flight.obligation.maxPriorityFeePerGas) <= priorityCapWei
    && BigInt(flight.obligation.maxFeePerGas) <= maxFeeCapWei;
}

function recoveredOffensePolicyAuthorized(
  kind: "audit" | "kill",
  targetTokenId: string,
  notBeforeTimestamp: bigint | null,
  citizenSupply: bigint,
): boolean {
  const strategy = runtime.strategy;
  if (
    strategy.offenseTargetTokenIds.length > 0
    && !strategy.offenseTargetTokenIds.includes(targetTokenId)
  ) return false;
  if (
    strategy.endgameOnlyWithin !== null
    && citizenSupply - WINNERS > BigInt(strategy.endgameOnlyWithin)
  ) return false;
  if (notBeforeTimestamp !== null) {
    if (kind === "audit" && !strategy.preBoundaryAudit) return false;
    if (kind === "kill" && !strategy.preBoundaryKill) return false;
  }
  // Recovery always uses sendRawTransaction. In mainnet mode, re-check the same
  // current authority that would let a fresh offense transaction leave the
  // private bundle path; a previously public-authorized WAL entry is not a
  // permanent grant after the operator withdraws that setting.
  if (
    appConfig.mode === "mainnet"
    && !strategy.racePublicMempool
    && !strategy.defenseEnabled
    && !jitCampaignIsArmed()
  ) return false;
  return true;
}

function createRecoveryFlightAuthorizer(address: Address) {
  let snapshotPromise: ReturnType<typeof getGameSnapshot> | null = null;
  const snapshot = () => {
    snapshotPromise ??= getGameSnapshot();
    return snapshotPromise;
  };
  return async (flight: RetainedJournalFlight): Promise<boolean> => {
    // Dry-run is an absolute execution boundary. This check deliberately comes
    // before the inert-filler fast path: nonce-clearing transactions still spend
    // gas and must never escape while the operator is simulating.
    if (runtime.strategy.dryRun || !flight.recovery.publicAuthorized) return false;
    const obligation = flight.obligation;
    const inert = obligation.to.toLowerCase() === address.toLowerCase()
      && obligation.data === "0x"
      && BigInt(obligation.valueWei) === 0n;
    if (inert) {
      const blockNumber = await publicClient.getBlockNumber();
      const block = await publicClient.getBlock({ blockNumber });
      const baseFeePerGas = (block as { baseFeePerGas?: bigint }).baseFeePerGas ?? 0n;
      // The WAL does not encode whether an inert nonce-clearing replacement came
      // from a payment or an offense. Conservatively require both current gas
      // profiles so a recovered filler cannot bypass either lowered operator cap.
      return signedFeesWithinCurrentLimits(
        flight,
        false,
        baseFeePerGas,
      ) && signedFeesWithinCurrentLimits(flight, true, baseFeePerGas);
    }
    if (obligation.to.toLowerCase() !== appConfig.gameAddress.toLowerCase()) return false;

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({
        abi: gameContract.abi,
        data: obligation.data,
      }) as { functionName: string; args?: readonly unknown[] };
    } catch {
      return false;
    }
    const args = decoded.args ?? [];
    if (decoded.functionName === "payTaxes") {
      const tokenId = (args[0] as bigint).toString();
      const epochs = BigInt(args[1] as bigint | number);
      const jitCouldAuthorize = runtime.jitCampaign.state === "armed"
        && runtime.jitCampaign.tokenIds.includes(tokenId)
        && epochs === 1n;
      if (!runtime.strategy.defenseEnabled && !jitCouldAuthorize) return false;
    } else if (
      decoded.functionName === "useBribe"
      && (!runtime.strategy.defenseEnabled || !runtime.strategy.autoUseBribe)
    ) {
      return false;
    } else if (
      decoded.functionName === "audit"
      && (!runtime.strategy.offenseEnabled || !runtime.strategy.autoAudit)
    ) {
      return false;
    } else if (
      decoded.functionName === "kill"
      && (!runtime.strategy.offenseEnabled || !runtime.strategy.autoKill)
    ) {
      return false;
    }
    const fresh = await snapshot();
    if (fresh.state !== 1) return false;
    const blockNumber = await publicClient.getBlockNumber();
    const block = await publicClient.getBlock({ blockNumber });
    const blockTimestamp = (block as { timestamp?: bigint }).timestamp;
    if (blockTimestamp === undefined) return false;
    const offense = decoded.functionName === "audit" || decoded.functionName === "kill";
    if (!signedFeesWithinCurrentLimits(
      flight,
      offense,
      (block as { baseFeePerGas?: bigint }).baseFeePerGas ?? 0n,
    )) return false;

    if (decoded.functionName === "payTaxes") {
      const tokenId = (args[0] as bigint).toString();
      const epochs = BigInt(args[1] as bigint | number);
      if (epochs <= 0n) return false;
      const divisor = epochs > 0n ? epochs * BASE_TAX_RATE_WEI : 0n;
      const valueWei = BigInt(obligation.valueWei);
      const pricedEpoch = divisor > 0n && valueWei % divisor === 0n
        ? valueWei / divisor
        : undefined;
      const maxPaymentWei = runtime.strategy.maxPaymentEth > 0
        ? parseEther(String(runtime.strategy.maxPaymentEth))
        : 0n;
      if (maxPaymentWei > 0n && valueWei > maxPaymentWei) return false;
      const results = await looseMulticall([
        {
          address: fresh.citizensAddress,
          abi: citizensAbi,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        },
        { ...gameContract, functionName: "lastEpochPaid", args: [BigInt(tokenId)] },
        { ...gameContract, functionName: "auditDueTimestamp", args: [BigInt(tokenId)] },
        { ...gameContract, functionName: "bribeBalance", args: [BigInt(tokenId)] },
        { ...gameContract, functionName: "estimateTaxesToPay", args: [BigInt(tokenId), epochs] },
      ], blockNumber);
      // Resolved per-contract failures are fail-closed but do not poison Start;
      // the transport retains the raw so reconciliation can cancel its nonce.
      if (results.some((result) => result.status !== "success")) return false;
      const values = results.map((result) => result.status === "success" ? result.result : undefined);
      if ((values[0] as Address).toLowerCase() !== address.toLowerCase()) return false;
      const lastEpochPaid = values[1] as bigint;
      const auditDue = values[2] as bigint;
      const bribes = values[3] as bigint;
      const estimated = values[4] as bigint;
      const notBefore = flight.recovery.notBeforeTimestamp === undefined
        ? null
        : BigInt(flight.recovery.notBeforeTimestamp);

      if (notBefore !== null && blockTimestamp < notBefore) {
        if (
          !runtime.strategy.preBoundaryPay
          || notBefore < fresh.startTime
          || epochs !== 1n
        ) return false;
        const targetEpoch = 1n + (notBefore - fresh.startTime) / EPOCH_DURATION_SECONDS;
        const exactBoundary = fresh.startTime + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
        if (
          notBefore !== exactBoundary
          || targetEpoch !== fresh.currentEpoch + 1n
          || valueWei !== targetEpoch * BASE_TAX_RATE_WEI
        ) return false;
        const jitDue = runtime.jitCampaign.state === "armed"
          && runtime.jitCampaign.targetEpoch === Number(targetEpoch)
          && runtime.jitCampaign.tokenIds.includes(tokenId)
          && lastEpochPaid < targetEpoch;
        const proactiveDue = runtime.strategy.defenseEnabled
          && runtime.strategy.proactivePay
          && lastEpochPaid + 2n <= targetEpoch;
        return jitDue || proactiveDue;
      }

      // A recovered current-epoch raw is replayable only when it is still the
      // exact payment the active strategy would request from fresh state. This
      // rejects stale multi-epoch raws after external progress made the citizen
      // safe, even though the contract would accept them as extra prepayment.
      if (valueWei !== estimated) return false;
      const jitDue = runtime.jitCampaign.state === "armed"
        && runtime.jitCampaign.targetEpoch === Number(fresh.currentEpoch)
        && runtime.jitCampaign.tokenIds.includes(tokenId)
        && epochs === 1n
        && lastEpochPaid < fresh.currentEpoch
        && (pricedEpoch === undefined || pricedEpoch === fresh.currentEpoch);
      const configuredEpochs = BigInt(cappedAutoPayEpochs(
        runtime.strategy.prepayEpochs,
        runtime.strategy.maxAutoPayEpochs,
      ));
      const auditedPaymentDue = auditDue !== 0n
        && Number(auditDue - blockTimestamp) <= runtime.strategy.auditSafetyBufferSeconds
        && !(runtime.strategy.autoUseBribe && bribes > 0n);
      const proactivePaymentDue = runtime.strategy.proactivePay
        && auditDue === 0n
        && isAuditable(lastEpochPaid, fresh.currentEpoch);
      const defenseDue = runtime.strategy.defenseEnabled
        && epochs === configuredEpochs
        && (auditedPaymentDue || proactivePaymentDue);
      return jitDue || defenseDue;
    }

    let kind: SemanticActionKind;
    let tokenId: string | undefined;
    let targetTokenId: string | undefined;
    if (decoded.functionName === "useBribe") {
      kind = "use-bribe";
      tokenId = (args[0] as bigint).toString();
    } else if (decoded.functionName === "audit") {
      kind = "audit";
      tokenId = (args[0] as bigint).toString();
      targetTokenId = (args[1] as bigint).toString();
    } else if (decoded.functionName === "kill") {
      kind = "kill";
      targetTokenId = (args[0] as bigint).toString();
    } else {
      return false;
    }
    const notBeforeTimestamp = flight.recovery.notBeforeTimestamp === undefined
      ? null
      : BigInt(flight.recovery.notBeforeTimestamp);
    if (
      (kind === "audit" || kind === "kill")
      && targetTokenId !== undefined
      && !recoveredOffensePolicyAuthorized(
        kind,
        targetTokenId,
        notBeforeTimestamp,
        fresh.citizenSupply,
      )
    ) return false;
    const assessment = await assessActionFlight({
      attemptId: 0,
      key: semanticActionKey(kind, tokenId, targetTokenId) ?? `recovery:${flight.nonce}`,
      kind,
      account: address,
      nonce: flight.nonce,
      tokenId,
      targetTokenId,
      auditorTokenId: kind === "audit" ? tokenId : undefined,
      valueWei: BigInt(obligation.valueWei),
      gasWei: BigInt(obligation.gasLimit) * BigInt(obligation.maxFeePerGas),
      maxFeePerGas: BigInt(obligation.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(obligation.maxPriorityFeePerGas),
      txHash: flight.txHash,
      lineageId: flight.lineage.id,
      replacementUuids: [],
      retryImmediately: false,
      obsolete: false,
      inertFiller: false,
      urgency: notBeforeTimestamp === null
        ? kind === "use-bribe" ? "survival" : "routine"
        : "boundary",
      notBeforeTimestamp,
      submittedAtMs: flight.updatedAtMs,
      delivery: "submitted",
    }, blockNumber, blockTimestamp, fresh.currentEpoch, {
      citizensAddress: fresh.citizensAddress,
      startTime: fresh.startTime,
      propagateRpcError: true,
    });
    return assessment === "live";
  };
}

/** Rebuild the safety ledger from the durable signed-transaction WAL. The nonce
 * manager has already restored its allocation fences by the time this runs. */
function restoreJournalFlights(
  address: Address,
  retained: readonly RetainedJournalFlight[],
  currentBlock?: bigint,
): void {
  const normalized = address.toLowerCase();
  const byNonce = new Map<number, RetainedJournalFlight[]>();
  const uuidNonces = new Map<string, Set<number>>();
  for (const flight of retained) {
    if (flight.wallet.toLowerCase() !== normalized) continue;
    const group = byNonce.get(flight.nonce) ?? [];
    group.push(flight);
    byNonce.set(flight.nonce, group);
    for (const uuid of new Set(flight.attempts.flatMap((attempt) =>
      attempt.replacementUuid ? [attempt.replacementUuid] : []))) {
      const nonces = uuidNonces.get(uuid) ?? new Set<number>();
      nonces.add(flight.nonce);
      uuidNonces.set(uuid, nonces);
    }
  }

  for (const [nonce, lineage] of byNonce) {
    const newestFirst = [...lineage].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs,
    );
    const latest = newestFirst[0]!;
    const retryImmediately = [...byNonce.keys()].some((higherNonce) => higherNonce > nonce)
      && lineage.some((flight) => {
        const rejectedGap = flight.state === "ambiguous"
          && flight.attempts.length > 0
          && flight.attempts.every((attempt) => attempt.state === "rejected");
        const expiredPrivateGap = currentBlock !== undefined
          && !flight.publicExposure
          && flight.maxPrivateTargetBlock !== undefined
          && currentBlock > BigInt(flight.maxPrivateTargetBlock);
        return rejectedGap || expiredPrivateGap;
      });
    const maxExposureWei = lineage.reduce((max, flight) => {
      const obligation = flight.obligation;
      const exposure = BigInt(obligation.valueWei)
        + BigInt(obligation.gasLimit) * BigInt(obligation.maxFeePerGas);
      return exposure > max ? exposure : max;
    }, 0n);
    const obligation = latest.obligation;
    const key = liabilityKey(address, nonce);
    const existing = pendingLiabilities.get(key);
    pendingLiabilities.set(key, {
      account: address,
      nonce,
      valueWei: BigInt(obligation.valueWei),
      gasWei: BigInt(obligation.gasLimit) * BigInt(obligation.maxFeePerGas),
      maxExposureWei: existing && existing.maxExposureWei > maxExposureWei
        ? existing.maxExposureWei
        : maxExposureWei,
      txHash: latest.txHash,
      submittedAtMs: latest.updatedAtMs,
      delivery: "submitted",
    });

    // Recover semantic identity from any alternative in the same-nonce lineage.
    // A zero-value gap filler may be the newest entry, but the older game call is
    // still the durable evidence needed for payment/action dedupe after restart.
    try {
      let semantic: {
        decoded: { functionName: string; args?: readonly unknown[] };
        obligation: RetainedJournalFlight["obligation"];
        flight: RetainedJournalFlight;
      } | undefined;
      for (const candidate of newestFirst) {
        if (candidate.obligation.to.toLowerCase() !== appConfig.gameAddress.toLowerCase()) continue;
        try {
          const decoded = decodeFunctionData({
            abi: gameContract.abi,
            data: candidate.obligation.data,
          }) as { functionName: string; args?: readonly unknown[] };
          if (!["payTaxes", "useBribe", "audit", "kill"].includes(decoded.functionName)) continue;
          semantic = { decoded, obligation: candidate.obligation, flight: candidate };
          break;
        } catch {
          // A later self-transfer or unrelated same-nonce alternative has no game
          // calldata. Continue back through the lineage to its semantic origin.
        }
      }
      if (!semantic) continue;
      const { decoded } = semantic;
      const common = {
        account: address,
        nonce,
        valueWei: BigInt(obligation.valueWei),
        gasWei: BigInt(obligation.gasLimit) * BigInt(obligation.maxFeePerGas),
        maxFeePerGas: BigInt(obligation.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(obligation.maxPriorityFeePerGas),
        txHash: latest.txHash,
        lineageId: latest.lineage.id,
        replacementUuids: uniqueUuids(
          ...lineage.map((journalFlight) => journalFlight.attempts.map((attempt) =>
            attempt.replacementUuid && uuidNonces.get(attempt.replacementUuid)?.size === 1
              ? attempt.replacementUuid
              : undefined)),
        ),
        retryImmediately,
        submittedAtMs: latest.updatedAtMs,
        delivery: "submitted" as const,
      };
      const args = decoded.args ?? [];
      if (decoded.functionName === "payTaxes") {
        const tokenId = args[0] as bigint;
        const epochs = BigInt(args[1] as bigint | number);
        const tokenKey = tokenId.toString();
        const current = paymentFlights.get(tokenKey);
        const divisor = epochs > 0n ? epochs * BASE_TAX_RATE_WEI : 0n;
        const semanticValueWei = BigInt(semantic.obligation.valueWei);
        const inferredPricedEpoch = divisor > 0n && semanticValueWei % divisor === 0n
          ? semanticValueWei / divisor
          : 0n;
        const durableGapFiller = latest.obligation.to.toLowerCase() === normalized
          && latest.obligation.data === "0x"
          && BigInt(latest.obligation.valueWei) === 0n;
        if (current && current.account.toLowerCase() === normalized && current.nonce === nonce) {
          current.retryImmediately = current.retryImmediately || retryImmediately;
          current.replacementUuids = uniqueUuids(current.replacementUuids, common.replacementUuids);
          current.cancelRequired = current.cancelRequired || durableGapFiller;
          current.inertFiller = current.inertFiller || durableGapFiller;
          current.recoveredGap = current.recoveredGap || retryImmediately || durableGapFiller;
          if (latest.updatedAtMs >= current.submittedAtMs) {
            current.valueWei = common.valueWei;
            current.gasWei = common.gasWei;
            current.maxFeePerGas = common.maxFeePerGas;
            current.maxPriorityFeePerGas = common.maxPriorityFeePerGas;
            current.txHash = common.txHash;
            current.lineageId = common.lineageId;
            current.submittedAtMs = common.submittedAtMs;
            current.delivery = common.delivery;
          }
          continue;
        }
        paymentFlights.set(tokenKey, {
          attemptId: ++nextPaymentAttemptId,
          tokenId: tokenKey,
          startingLastEpochPaid: null,
          // Exact pre-submission progress is not durable. A conservative sentinel
          // prevents false confirmation; recovered gap coverage is inferred only
          // when chain progress reaches the value-derived priced epoch below.
          expectedLastEpochPaid: (1n << 256n) - 1n,
          ...common,
          obligationCovered: false,
          cancelRequired: durableGapFiller,
          inertFiller: durableGapFiller,
          recoveredGap: retryImmediately || durableGapFiller,
          source: "defense",
          pricedEpoch: inferredPricedEpoch,
          jitTargetEpoch: null,
          jitCampaignRevision: null,
          proactiveEpoch: null,
          proactiveMarkerReserved: false,
        });
        continue;
      }

      let kind: SemanticActionKind;
      let tokenId: string | undefined;
      let targetTokenId: string | undefined;
      let auditorTokenId: string | undefined;
      if (decoded.functionName === "useBribe") {
        kind = "use-bribe";
        tokenId = (args[0] as bigint).toString();
      } else if (decoded.functionName === "audit") {
        kind = "audit";
        auditorTokenId = (args[0] as bigint).toString();
        tokenId = auditorTokenId;
        targetTokenId = (args[1] as bigint).toString();
      } else if (decoded.functionName === "kill") {
        kind = "kill";
        targetTokenId = (args[0] as bigint).toString();
      } else {
        continue;
      }
      const actionKey = semanticActionKey(kind, tokenId, targetTokenId);
      if (actionKey === null) continue;
      const currentAction = actionFlights.get(actionKey);
      const notBeforeTimestamp = semantic.flight.recovery.notBeforeTimestamp === undefined
        ? null
        : BigInt(semantic.flight.recovery.notBeforeTimestamp);
      const durableGapFiller = latest.obligation.to.toLowerCase() === normalized
        && latest.obligation.data === "0x"
        && BigInt(latest.obligation.valueWei) === 0n;
      if (
        currentAction
        && currentAction.account.toLowerCase() === normalized
        && currentAction.nonce === nonce
      ) {
        currentAction.retryImmediately = currentAction.retryImmediately || retryImmediately;
        currentAction.replacementUuids = uniqueUuids(
          currentAction.replacementUuids,
          common.replacementUuids,
        );
        currentAction.obsolete = currentAction.obsolete || durableGapFiller;
        currentAction.inertFiller = currentAction.inertFiller || durableGapFiller;
        if (notBeforeTimestamp !== null) {
          currentAction.notBeforeTimestamp ??= notBeforeTimestamp;
          currentAction.urgency = "boundary";
        }
        if (latest.updatedAtMs >= currentAction.submittedAtMs) {
          currentAction.valueWei = common.valueWei;
          currentAction.gasWei = common.gasWei;
          currentAction.maxFeePerGas = common.maxFeePerGas;
          currentAction.maxPriorityFeePerGas = common.maxPriorityFeePerGas;
          currentAction.txHash = common.txHash;
          currentAction.lineageId = common.lineageId;
          currentAction.submittedAtMs = common.submittedAtMs;
          currentAction.delivery = common.delivery;
        }
        continue;
      }
      actionFlights.set(actionKey, {
        attemptId: ++nextActionAttemptId,
        key: actionKey,
        kind,
        tokenId,
        targetTokenId,
        auditorTokenId,
        obsolete: durableGapFiller,
        inertFiller: durableGapFiller,
        urgency: notBeforeTimestamp === null
          ? kind === "use-bribe" ? "survival" : "routine"
          : "boundary",
        notBeforeTimestamp,
        ...common,
      });
    } catch (err) {
      logger.warn(`could not reconstruct journaled nonce ${nonce}:`, (err as Error).message);
    }
  }
  paymentFlightAccount = address;
  publishPendingExposure();
}

async function applyJournalTerminals(
  address: Address,
  reconciliation: JournalReconciliationResult,
): Promise<void> {
  const retainedNonces = new Set(reconciliation.retained.map((flight) => flight.nonce));
  const terminal = [...reconciliation.consumed, ...reconciliation.expired];
  const terminalNonces = new Set(terminal.map((flight) => flight.nonce));
  const getReceipt = (publicClient as unknown as {
    getTransactionReceipt?: (args: { hash: Hex }) => Promise<PricedReceipt>;
  }).getTransactionReceipt;

  for (const nonce of terminalNonces) {
    // A replacement lineage may contain an expired private alternative alongside
    // a retained public one. The nonce remains live until every route is terminal.
    if (retainedNonces.has(nonce)) continue;
    const key = liabilityKey(address, nonce);
    const liability = pendingLiabilities.get(key);
    const consumed = reconciliation.consumed.filter((flight) => flight.nonce === nonce);
    let accounted = false;
    if (liability && getReceipt && consumed.length > 0) {
      for (const flight of consumed) {
        try {
          const receipt = await getReceipt.call(publicClient, { hash: flight.txHash });
          const obligation = flight.obligation;
          accountForReceipt({
            ...liability,
            valueWei: BigInt(obligation.valueWei),
            gasWei: BigInt(obligation.gasLimit) * BigInt(obligation.maxFeePerGas),
          }, receipt);
          accounted = true;
          break;
        } catch {
          // Only the actually mined alternative has a receipt.
        }
      }
    }
    if (!accounted) settlePendingLiability(address, nonce, reconciliation.currentBlock);
    for (const [tokenId, flight] of paymentFlights) {
      if (flight.account.toLowerCase() !== address.toLowerCase() || flight.nonce !== nonce) continue;
      clearSourceMarker(flight);
      paymentFlights.delete(tokenId);
    }
    for (const [actionKey, flight] of actionFlights) {
      if (flight.account.toLowerCase() !== address.toLowerCase() || flight.nonce !== nonce) continue;
      actionFlights.delete(actionKey);
    }
  }
}

async function reconcileSubmissionTerminals(address: Address): Promise<void> {
  try {
    // This function is reached only from an explicitly running execution. In
    // addition to terminal reconciliation, let transport retry eligible exact
    // prepared hashes (including delayed lower-nonce gap fillers).
    const reconciliation = await recoverPreparedSubmissions(
      address,
      engineAbortController?.signal,
      createRecoveryFlightAuthorizer(address),
    );
    restoreJournalFlights(address, reconciliation.retained, reconciliation.currentBlock);
    await applyJournalTerminals(address, reconciliation);
    runtime.setJournalHealth(true);
  } catch (err) {
    runtime.setJournalHealth(false, (err as Error).message);
    throw err;
  }
}

/** Rebuild durable submission state before an engine is allowed to start.
 *
 * This is deliberately usable while the engine is paused so the API can expose
 * pending exposure and journal health immediately after unlock. A corrupt WAL
 * rejects the preflight; callers must not start the engine in that case.
 */
export async function preflightSubmissionRecovery(address: Address): Promise<void> {
  const normalized = address.toLowerCase();
  if (paymentFlightAccount !== null && paymentFlightAccount.toLowerCase() !== normalized) {
    // Flights and JIT completion markers are wallet-scoped. Do not let a newly
    // unlocked identity inherit either from the previous in-memory account.
    resetPaymentTracking();
    resetJitState();
  }
  paymentFlightAccount = address;

  try {
    const reconciliation = await reconcileSubmissionJournal(address);
    restoreJournalFlights(address, reconciliation.retained, reconciliation.currentBlock);
    await applyJournalTerminals(address, reconciliation);
    runtime.setJournalHealth(true);
  } catch (err) {
    const message = (err as Error).message;
    runtime.setJournalHealth(false, message);
    throw new Error(`submission recovery failed; refusing to allocate a nonce: ${message}`);
  }
}

/** Retry durable prepared hashes only under an explicit execution command.
 * Unlike the paused preflight, this may dispatch an already-signed transaction
 * and therefore must only be called by Start or a paused JIT arm request. */
export async function recoverAuthorizedSubmissions(address: Address): Promise<void> {
  const normalized = address.toLowerCase();
  if (paymentFlightAccount !== null && paymentFlightAccount.toLowerCase() !== normalized) {
    resetPaymentTracking();
    resetJitState();
  }
  paymentFlightAccount = address;
  try {
    const reconciliation = await recoverPreparedSubmissions(
      address,
      undefined,
      createRecoveryFlightAuthorizer(address),
    );
    restoreJournalFlights(address, reconciliation.retained, reconciliation.currentBlock);
    await applyJournalTerminals(address, reconciliation);
    runtime.setJournalHealth(true);
  } catch (err) {
    const message = (err as Error).message;
    runtime.setJournalHealth(false, message);
    throw new Error(`submission recovery failed; refusing to start: ${message}`);
  }
}

async function ensureSubmissionRecovery(address: Address, generation: number): Promise<void> {
  if (journalReconciledGeneration === generation) return;
  await preflightSubmissionRecovery(address);
  journalReconciledGeneration = generation;
}

/** Clear run-scoped payment state when the wallet identity changes. Exported so
 *  the API/tests can make an explicit identity reset; pausing the engine must not
 *  erase it while transactions may still be pending. */
export function resetPaymentTracking(): void {
  paymentFlights.clear();
  actionFlights.clear();
  pendingLiabilities.clear();
  committedNoncesThisTick = new Set();
  survivalOffenseFenceUntilMs = 0;
  nextPaymentAttemptId = 0;
  nextActionAttemptId = 0;
  proactivePaySubmittedEpoch = null;
  proactivePaySubmitted = new Set();
  liabilitySettlementRevision += 1;
  spendableBalanceRevision = -1;
  balanceMustIncludeBlock = null;
  runtime.resetWalletAccounting();
  paymentFlightAccount = runtime.account?.address ?? null;
  publishPendingExposure();
}

export function startEngine(): void {
  if (timer || unwatchBlocks) return;
  engineGeneration += 1;
  engineAbortController?.abort();
  engineAbortController = new AbortController();
  journalReconciledGeneration = -1;
  const accountAddress = runtime.account?.address ?? null;
  if (
    paymentFlightAccount !== null
    && accountAddress?.toLowerCase() !== paymentFlightAccount.toLowerCase()
  ) {
    resetPaymentTracking();
    resetJitState();
  }
  paymentFlightAccount = accountAddress;
  engineSalt = Math.floor(Math.random() * 0xffffffff);
  runtime.running = true;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine started" });
  if (!ownershipIndexingAvailable()) {
    activity.add({
      kind: "info",
      status: "info",
      message:
        "Ownership indexing unavailable — set ALCHEMY_API_KEY (or OWNED_TOKENS/TARGET_TOKENS) so the bot can find your tokens.",
    });
  }

  // Always keep a polling watchdog. WebSocket subscriptions can go quiet after
  // a provider disconnect without delivering another block or error; `ticking`
  // safely coalesces watchdog and block-triggered ticks.
  timer = setInterval(() => void tick(), TICK_MS);
  if (wsClient) {
    // React on every new block (~100-500ms latency vs up to 12s with polling).
    unwatchBlocks = wsClient.watchBlocks({
      onBlock: () => void tick(),
      onError: (err) => logger.warn("Block subscription error:", (err as Error).message),
    });
    activity.add({ kind: "info", status: "info", message: "Block subscription active (WebSocket + 12s polling watchdog)" });
  } else {
    activity.add({ kind: "info", status: "info", message: "Polling every 12s (no WebSocket configured)" });
  }
  void tick();
}

export function stopEngine(): void {
  // Invalidate every in-progress action before clearing timers. HTTP callers
  // await waitForEngineIdle(), so "stopped" is not reported while an old batch
  // can still be flushed afterward.
  engineGeneration += 1;
  engineAbortController?.abort();
  runtime.running = false;
  if (timer) clearInterval(timer);
  if (boundaryTimer) clearTimeout(boundaryTimer);
  if (offenseBoundaryTimer) clearTimeout(offenseBoundaryTimer);
  if (preBoundaryTimer) clearTimeout(preBoundaryTimer);
  if (preBoundaryAuditTimer) clearTimeout(preBoundaryAuditTimer);
  if (preBoundaryKillTimer) clearTimeout(preBoundaryKillTimer);
  if (unwatchBlocks) unwatchBlocks();
  timer = null;
  boundaryTimer = null;
  offenseBoundaryTimer = null;
  preBoundaryTimer = null;
  preBoundaryAuditTimer = null;
  preBoundaryKillTimer = null;
  unwatchBlocks = null;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine paused" });
}

/** Fire an extra tick precisely at the armed epoch's boundary (near-instant JIT pay). */
export function scheduleJitBoundary(): void {
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  const campaign = runtime.jitCampaign;
  if (!runtime.running || campaign.state !== "armed" || campaign.targetEpoch === null || runtime.startTime === null) {
    return;
  }
  // Epoch N begins at startTime + (N-1)*EPOCH_DURATION.
  const boundary = runtime.startTime + BigInt(campaign.targetEpoch - 1) * EPOCH_DURATION_SECONDS;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaSec = Number(boundary - nowSec);
  if (deltaSec <= 0) {
    void tick();
    return;
  }
  const delayMs = Math.min(deltaSec * 1000 + 500, 2_000_000_000);
  const generation = engineGeneration;
  boundaryTimer = setTimeout(() => fireBoundaryTick(generation), delayMs);
}

interface PreBoundaryPayPlan {
  targetEpoch: bigint;
  boundaryTs: bigint;
  includeJit: boolean;
  jitCampaignRevision: number | null;
  jitTokenIds: readonly string[];
  includeProactive: boolean;
}

function selectedOwnedJitTokenIds(
  ownedIds: bigint[],
  configured: readonly string[] = runtime.jitCampaign.tokenIds,
): bigint[] {
  // Campaigns are deliberately explicit. Empty never broadens to every owned
  // Citizen, even for a malformed or legacy in-memory campaign.
  if (configured.length === 0) return [];
  const ownedById = new Map(ownedIds.map((id) => [id.toString(), id]));
  return [...new Set(configured)].flatMap((id) => {
    if (!/^\d+$/.test(id)) return [];
    const owned = ownedById.get(BigInt(id).toString());
    return owned === undefined ? [] : [owned];
  });
}

/** Pick the next future epoch that needs a pre-boundary payment. In addition to
 * one-shot JIT, proactive defense recurs every epoch and only pays citizens that
 * will cross from the one-epoch grace period into auditable delinquency. */
function preBoundaryPayPlan(): PreBoundaryPayPlan | null {
  const s = runtime.strategy;
  const currentEpoch = runtime.currentEpoch;
  const startTime = runtime.startTime;
  if (currentEpoch === null || startTime === null) return null;

  const proactiveTarget = s.defenseEnabled && s.proactivePay ? currentEpoch + 1n : null;
  const campaign = runtime.jitCampaign;
  const configuredJitTarget = campaign.state === "armed" && campaign.targetEpoch !== null
    ? BigInt(campaign.targetEpoch)
    : null;
  const jitTarget = configuredJitTarget !== null && configuredJitTarget > currentEpoch
    ? configuredJitTarget
    : null;
  if (proactiveTarget === null && jitTarget === null) return null;

  const targetEpoch = proactiveTarget === null
    ? jitTarget!
    : jitTarget === null || proactiveTarget <= jitTarget
      ? proactiveTarget
      : jitTarget;
  return {
    targetEpoch,
    boundaryTs: startTime + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS,
    includeJit: jitTarget === targetEpoch,
    jitCampaignRevision: jitTarget === targetEpoch ? campaign.revision : null,
    jitTokenIds: jitTarget === targetEpoch ? [...campaign.tokenIds] : [],
    includeProactive: proactiveTarget === targetEpoch,
  };
}

/**
 * Arm a pre-submit ~preBoundaryLeadMs before the next defensive payment epoch.
 * This covers both one-shot JIT and recurring tax-skip defense, and validates the
 * upcoming-epoch value by simulating at the boundary timestamp before send.
 */
export function schedulePreBoundaryPay(): void {
  if (preBoundaryTimer) {
    clearTimeout(preBoundaryTimer);
    preBoundaryTimer = null;
  }
  const s = runtime.strategy;
  const plan = preBoundaryPayPlan();
  if (!runtime.running || !s.preBoundaryPay || plan === null) return;
  const nowMs = Date.now();
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  const deltaMs = Number(plan.boundaryTs) * 1000 - nowMs - effectiveLeadMs();
  if (deltaMs <= 0) {
    // Starting or waking inside the configured lead is still useful. Fire now
    // while the boundary is in the future; public delivery remains held until
    // the future-valid timestamp. Post-boundary ticks are the fallback.
    if (nowSec < plan.boundaryTs) {
      const generation = engineGeneration;
      preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(plan, generation), 0);
    }
    return;
  }
  const maxTimerDelayMs = 2_000_000_000;
  if (deltaMs > maxTimerDelayMs) {
    // Node timers cannot safely represent arbitrarily distant dates. Wake only
    // to recompute from fresh state; never mistake the clamp for the fire time.
    preBoundaryTimer = setTimeout(schedulePreBoundaryPay, maxTimerDelayMs);
    return;
  }
  // Capture the exact epoch this timer was armed for. Recomputing at callback
  // time can turn a delayed epoch-N timer into an early epoch-(N+1) payment.
  const generation = engineGeneration;
  preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(plan, generation), deltaMs);
}

// Fixed gas for a pre-boundary payTaxes — we can't eth_estimateGas it (the value
// is invalid against current state), so pass a generous fixed limit.
const PRE_BOUNDARY_GAS = 120_000n;

interface BoundaryPaymentCandidate {
  tokenId: bigint;
  tokenKey: string;
  lastEpochPaid: bigint;
  valueWei: bigint;
  jitDue: boolean;
  jitCampaignRevision: number | null;
  proactiveDue: boolean;
  replace?: PaymentFlight;
}

/**
 * Transport integration seam for a boundary payment batch. Discovery and
 * reconciliation finish for every token before this function is entered, so a
 * transport that supports prepare-then-release can prepare/sign the complete
 * nonce sequence and perform one boundary wait. Until that transport primitive is
 * available, submitTx remains the final per-intent adapter behind act().
 */
async function submitBoundaryPaymentBatch(
  candidates: readonly BoundaryPaymentCandidate[],
  targetEpoch: bigint,
  boundaryTs: bigint,
): Promise<void> {
  for (const candidate of candidates) {
    await act(
      {
        to: appConfig.gameAddress,
        data: encodePayTaxes(candidate.tokenId, 1),
        value: candidate.valueWei,
        gas: PRE_BOUNDARY_GAS,
      },
      "pay-taxes",
      {
        tokenId: candidate.tokenKey,
        message: `Pre-boundary ${candidate.jitDue ? "JIT" : "tax-skip"} pay #${candidate.tokenKey} for epoch ${targetEpoch} = ${formatEther(candidate.valueWei)} ETH (boundary race)`,
        race: true,
        simTimestamp: boundaryTs,
        payment: {
          startingLastEpochPaid: candidate.lastEpochPaid,
          expectedLastEpochPaid: candidate.lastEpochPaid + 1n,
          source: candidate.jitDue ? "jit" : "pre-boundary",
          replace: candidate.replace,
          pricedEpoch: targetEpoch,
          jitTargetEpoch: candidate.jitDue ? Number(targetEpoch) : undefined,
          jitCampaignRevision: candidate.jitCampaignRevision ?? undefined,
          proactiveEpoch: candidate.proactiveDue ? targetEpoch : undefined,
        },
      },
    );
  }
}

/**
 * Fire a pre-boundary payment for one-shot JIT tokens and/or owned citizens that
 * will become auditable in the upcoming epoch. A shared per-token flight prevents
 * duplicate sends while the normal on-chain-status pass remains authoritative.
 */
async function firePreBoundaryPay(plan: PreBoundaryPayPlan, generation = engineGeneration): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryPay) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;

  const includeJit = plan.includeJit
    && runtime.jitCampaign.state === "armed"
    && runtime.jitCampaign.revision === plan.jitCampaignRevision
    && runtime.jitCampaign.targetEpoch !== null
    && BigInt(runtime.jitCampaign.targetEpoch) === plan.targetEpoch;
  const includeProactive = plan.includeProactive && s.defenseEnabled && s.proactivePay;
  if (!includeJit && !includeProactive) return;
  if (includeJit) prepareJitBookkeeping();

  const nowMs = Date.now();
  const boundaryMs = Number(plan.boundaryTs) * 1000;
  if (nowMs < boundaryMs - effectiveLeadMs() - 1_000) {
    schedulePreBoundaryPay();
    return;
  }
  if (nowMs >= boundaryMs) {
    // The epoch already rolled while this timer was delayed. Let the normal
    // on-chain estimate path recover; never send a stale or N+1 price here.
    if (!ticking) void tick();
    return;
  }
  if (ticking) { setTimeout(() => void firePreBoundaryPay(plan, generation), 150); return; } // don't overlap nonce use
  ticking = true;
  executingGeneration = generation;
  preBoundaryPaymentActive = true;
  committedThisTickWei = 0n;
  paymentWorkUnsafeThisTick = false;
  committedNoncesThisTick = new Set();
  beginBatch();
  const address = runtime.account.address;
  const { targetEpoch, boundaryTs } = plan;
  try {
    await ensureSubmissionRecovery(address, generation);
    // These reads are independent. The fresh snapshot prevents a delayed timer
    // from signing for the wrong epoch before any nonce is reserved.
    const [fresh, , latest] = await Promise.all([
      getGameSnapshot(),
      nonceManager.sync(address, appConfig.mode),
      getLatestBlockCached(),
    ]);
    if (fresh.state !== 1 || fresh.currentEpoch + 1n !== targetEpoch) {
      logger.warn(`skip stale pre-boundary payment timer for epoch ${targetEpoch}; chain is at epoch ${fresh.currentEpoch}`);
      return;
    }
    const indexedOwnedIds = await fetchOwnedTokenIds(fresh.citizensAddress, address);
    const ownershipCandidates = [
      ...indexedOwnedIds,
      ...(includeJit ? plan.jitTokenIds.map((tokenId) => BigInt(tokenId)) : []),
    ];
    const ownedIds = await filterOwnedTokenIds(
      fresh.citizensAddress,
      ownershipCandidates,
      address,
    );
    await reconcileSubmissionTerminals(address);
    // A receipt watcher can miss a revert or another wallet transaction can
    // consume the nonce. Reconcile those terminal flights before dedupe so a stale
    // in-memory entry cannot suppress the last correct boundary attempt.
    await reconcilePaymentFlights(address, latest.number ?? null);
    await refreshSpendableBalance(address);

    const jitIds = includeJit ? selectedOwnedJitTokenIds(ownedIds, plan.jitTokenIds) : [];
    const byId = new Map<string, bigint>();
    if (includeProactive) for (const id of ownedIds) byId.set(id.toString(), id);
    for (const id of jitIds) byId.set(id.toString(), id);
    const selected = [...byId.values()];

    const owned = new Set(ownedIds.map((id) => id.toString()));
    const jit = new Set(jitIds.map((id) => id.toString()));

    // One multicall for lastEpochPaid across the selected tokens.
    const results = selected.length === 0
      ? []
      : await publicClient.multicall({
          allowFailure: true,
          contracts: selected.map((id) => ({ ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const })),
        });
    const candidates: BoundaryPaymentCandidate[] = [];
    for (let i = 0; i < selected.length; i++) {
      const r = results[i];
      if (r?.status !== "success") continue;
      const lastEpochPaid = r.result as bigint;
      const key = selected[i]!.toString();
      const jitDue = includeJit && jit.has(key) && lastEpochPaid < targetEpoch;
      const proactiveDue = includeProactive && owned.has(key) && lastEpochPaid + 2n <= targetEpoch;
      if (!jitDue && !proactiveDue) continue;
      const pending = pendingPaymentFor(key, lastEpochPaid);
      // JIT always pays exactly one epoch — one day (targetEpoch * base) — which
      // advances the citizen a single epoch regardless of how far behind it is. So
      // it fires even when the citizen is momentarily 2 behind at the boundary (the
      // tax-skip case); the auto-pay cap governs multi-epoch paths, not this one.
      const value = preBoundaryTaxWei(lastEpochPaid, targetEpoch, 1, BASE_TAX_RATE_WEI);
      if (value === 0n) continue;
      // A transaction priced for the previous epoch cannot succeed after this
      // boundary. Replace it at the same nonce instead of allowing generic pending
      // dedupe to suppress the correctly priced survival transaction.
      if (
        pending
        && (
          pending.cancelRequired
          || (
            pending.valueWei === value
            && pending.pricedEpoch === targetEpoch
          )
        )
      ) continue;
      candidates.push({
        tokenId: selected[i]!,
        tokenKey: key,
        lastEpochPaid,
        valueWei: value,
        jitDue,
        jitCampaignRevision: jitDue ? plan.jitCampaignRevision : null,
        proactiveDue,
        replace: pending,
      });
    }
    if (!executionIsCurrent(generation)) return;
    const campaignStillCurrent = !includeJit || (
      runtime.jitCampaign.state === "armed"
      && runtime.jitCampaign.revision === plan.jitCampaignRevision
      && runtime.jitCampaign.targetEpoch !== null
      && BigInt(runtime.jitCampaign.targetEpoch) === targetEpoch
    );
    const finalCandidates = campaignStillCurrent
      ? candidates
      : candidates.flatMap((candidate) => candidate.proactiveDue
          ? [{ ...candidate, jitDue: false, jitCampaignRevision: null }]
          : []);
    await submitBoundaryPaymentBatch(finalCandidates, targetEpoch, boundaryTs);
  } catch (err) {
    logger.error("pre-boundary pay error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary pay error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    if (paymentWorkUnsafeThisTick) {
      survivalOffenseFenceUntilMs = Math.max(survivalOffenseFenceUntilMs, boundaryMs);
    } else if (survivalOffenseFenceUntilMs <= boundaryMs) {
      survivalOffenseFenceUntilMs = 0;
    }
    preBoundaryPaymentActive = false;
    finishExclusive(generation);
  }
}

// Generous fixed gas for an unsimulated offense pre-submit (real audits used
// ~113–130k on-chain; we can't eth_estimateGas an action that isn't valid yet).
const PRE_BOUNDARY_OFFENSE_GAS = 250_000n;

/** Owned tokens usable as audit "from" tokens AT the upcoming epoch: not
 *  auditable at `targetEpoch` (so still current now) and with full capacity
 *  (the new epoch has 0 audits used). One audit per token. */
async function findPreBoundaryAuditors(ownedIds: bigint[], targetEpoch: bigint): Promise<bigint[]> {
  if (ownedIds.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditLimit" as const, args: [id] as const },
    ]),
  });
  const eligible: bigint[] = [];
  for (let i = 0; i < ownedIds.length; i++) {
    const lep = results[i * 2];
    const limit = results[i * 2 + 1];
    if (lep?.status !== "success" || limit?.status !== "success") continue;
    const limitV = limit.result as bigint;
    // 0n audits used because targetEpoch is a fresh epoch we haven't acted in yet,
    // so remaining capacity == auditLimit. Add one pool entry per available audit
    // so auditor-role tokens (limit > 1) can hit multiple rivals at the boundary.
    if (!isEligibleAuditor(lep.result as bigint, targetEpoch, 0n, limitV)) continue;
    for (let k = 0n; k < limitV; k++) eligible.push(ownedIds[i]!);
  }
  return eligible;
}

interface PreBoundaryAuditExecutionPlan {
  targetEpoch: bigint;
  boundaryTs: bigint;
}

/** Arm a standalone audit batch for one immutable upcoming epoch. Payments and
 * offense deliberately never share a batch or a discovery path. */
export function schedulePreBoundaryAudit(): void {
  if (preBoundaryAuditTimer) {
    clearTimeout(preBoundaryAuditTimer);
    preBoundaryAuditTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;
  const plan: PreBoundaryAuditExecutionPlan = {
    targetEpoch: runtime.currentEpoch + 1n,
    boundaryTs: runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS,
  };
  const nowMs = Date.now();
  // Survival payment gets first use of the wallet nonce. A standalone audit is
  // intentionally offset and never shares the payment's discovery/batch.
  const deltaMs = Number(plan.boundaryTs) * 1000 - nowMs - effectiveLeadMs()
    + PAYMENT_PRIORITY_OFFSET_MS;
  const generation = engineGeneration;
  if (deltaMs <= 0) {
    if (Number(plan.boundaryTs) * 1000 > nowMs) {
      preBoundaryAuditTimer = setTimeout(
        () => void firePreBoundaryAudit(plan, generation),
        0,
      );
    }
    return;
  }
  const maxTimerDelayMs = 2_000_000_000;
  preBoundaryAuditTimer = deltaMs > maxTimerDelayMs
    ? setTimeout(schedulePreBoundaryAudit, maxTimerDelayMs)
    : setTimeout(() => void firePreBoundaryAudit(plan, generation), deltaMs);
}

/** Pre-submit a standalone offense batch for exactly the epoch captured by its
 * scheduler. A delayed callback never rolls itself forward to the following day. */
async function firePreBoundaryAudit(
  plan: PreBoundaryAuditExecutionPlan,
  generation = engineGeneration,
): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (offenseTemporarilyFenced()) return;
  if (Date.now() >= Number(plan.boundaryTs) * 1000) {
    if (!ticking) void tick(generation);
    return;
  }
  if (preBoundaryPaymentActive || ticking) {
    setTimeout(() => void firePreBoundaryAudit(plan, generation), 150);
    return;
  }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n;
  paymentWorkUnsafeThisTick = false;
  committedNoncesThisTick = new Set();
  beginBatch();
  const address = runtime.account.address;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const { targetEpoch, boundaryTs } = plan;
  try {
    await ensureSubmissionRecovery(address, generation);
    const [fresh] = await Promise.all([
      getGameSnapshot(),
      nonceManager.sync(address, appConfig.mode),
    ]);
    if (fresh.state !== 1 || fresh.currentEpoch + 1n !== targetEpoch) {
      logger.warn(`skip stale pre-boundary audit timer for epoch ${targetEpoch}; chain is at epoch ${fresh.currentEpoch}`);
      return;
    }
    await reconcileSubmissionTerminals(address);
    await reconcileActionFlights(address, runtime.lastBlock, true);
    if (offenseTemporarilyFenced() || hasUnresolvedPaymentFlight(address)) return;
    await refreshSpendableBalance(address);
    const indexedOwnedIds = await fetchOwnedTokenIds(fresh.citizensAddress, address);
    const ownedIds = await filterOwnedTokenIds(fresh.citizensAddress, indexedOwnedIds, address);
    const auditors = reservePendingAuditorCapacity(
      await findPreBoundaryAuditors(ownedIds, targetEpoch),
      address,
    );

    const candidateIds = await fetchCandidateTokenIds(fresh.citizensAddress);
    const liveRaw = await filterLiveTokenIds(fresh.citizensAddress, candidateIds);
    const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
    // Auditable AT the target epoch, not already under audit.
    const statuses = await batchGetTargetStatuses(live, targetEpoch, nowSec);
    let idx = 0;
    for (const t of statuses) {
      if (t.owner.toLowerCase() === address.toLowerCase()) continue;
      if (owned.has(t.tokenId)) continue;
      if (pinned && !pinned.has(t.tokenId)) continue;
      if (t.auditDueTimestamp !== "0") continue; // already under audit
      if (!isAuditable(BigInt(t.lastEpochPaid), targetEpoch)) continue; // won't be auditable at the boundary
      const pendingAudit = pendingActionFor("audit", undefined, t.tokenId, address);
      if (pendingAudit?.obsolete) continue;
      if (pendingAudit && !actionReplacementDue(pendingAudit, "boundary")) continue;
      const from = pendingAudit?.auditorTokenId === undefined
        ? auditors[idx]
        : BigInt(pendingAudit.auditorTokenId);
      if (from === undefined) break;
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(from, BigInt(t.tokenId)), value: AUDIT_COST_WEI, gas: PRE_BOUNDARY_OFFENSE_GAS },
        "audit",
        { tokenId: from.toString(), targetTokenId: t.tokenId, message: `Pre-boundary audit #${t.tokenId} from #${from} for epoch ${targetEpoch} (boundary race)`, race: true, simTimestamp: boundaryTs, actionUrgency: "boundary", actionReplacement: pendingAudit, citizensAddress: fresh.citizensAddress },
      );
      if (res?.ok && !pendingAudit) idx++;
    }
  } catch (err) {
    logger.error("pre-boundary audit error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary audit error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
  }
}

/** Arm a pre-submit of kills ~preBoundaryLeadMs before the soonest audit-expiry. */
export function schedulePreBoundaryKill(): void {
  if (preBoundaryKillTimer) {
    clearTimeout(preBoundaryKillTimer);
    preBoundaryKillTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.preBoundaryKill || !s.offenseEnabled || !s.autoKill) return;
  if (nextKillDeadlineSec === null) return;
  const targetDeadline = nextKillDeadlineSec;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(targetDeadline - nowSec) * 1000 - effectiveLeadMs();
  const generation = engineGeneration;
  if (deltaMs <= 0) {
    if (targetDeadline > nowSec) {
      preBoundaryKillTimer = setTimeout(
        () => void firePreBoundaryKill(generation, targetDeadline),
        0,
      );
    }
    return; // already expired => normal offense handles it
  }
  const maxTimerDelayMs = 2_000_000_000;
  preBoundaryKillTimer = deltaMs > maxTimerDelayMs
    ? setTimeout(schedulePreBoundaryKill, maxTimerDelayMs)
    : setTimeout(() => void firePreBoundaryKill(generation, targetDeadline), deltaMs);
}

/** Pre-submit kills (skip-sim) for targets whose audit is about to expire, so the
 *  kill lands in the first eligible block instead of the one after. */
async function firePreBoundaryKill(
  generation = engineGeneration,
  targetDeadline: bigint | null = nextKillDeadlineSec,
): Promise<void> {
  const s = runtime.strategy;
  if (!executionIsCurrent(generation)) return;
  if (!s.preBoundaryKill || !s.offenseEnabled || !s.autoKill) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (offenseTemporarilyFenced()) return;
  if (ticking) { setTimeout(() => void firePreBoundaryKill(generation, targetDeadline), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n;
  paymentWorkUnsafeThisTick = false;
  committedNoncesThisTick = new Set();
  beginBatch();
  const address = runtime.account.address;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let followingDeadline: bigint | null = null;
  // Pre-submit kills for audits expiring within our lead + one slot of headroom.
  const windowSec = BigInt(Math.ceil(effectiveLeadMs() / 1000) + 12);
  try {
    await ensureSubmissionRecovery(address, generation);
    await nonceManager.sync(address, appConfig.mode);
    await reconcileSubmissionTerminals(address);
    await reconcileActionFlights(address, runtime.lastBlock, true);
    if (offenseTemporarilyFenced() || hasUnresolvedPaymentFlight(address)) return;
    await refreshSpendableBalance(address);
    const citizensAddress = runtime.citizensAddress as Address;
    const indexedOwnedIds = await fetchOwnedTokenIds(citizensAddress, address);
    const ownedIds = await filterOwnedTokenIds(citizensAddress, indexedOwnedIds, address);
    const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
    const liveRaw = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
    const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
    const statuses = await batchGetTargetStatuses(live, runtime.currentEpoch ?? 0n, nowSec);
    const imminent = statuses.flatMap((t) => {
      if (t.owner.toLowerCase() === address.toLowerCase()) return [];
      if (owned.has(t.tokenId)) return [];
      if (pinned && !pinned.has(t.tokenId)) return [];
      const due = BigInt(t.auditDueTimestamp);
      if (due === 0n || t.killable || due <= nowSec || due - nowSec > windowSec) return [];
      if (targetDeadline !== null && due < targetDeadline) return [];
      return [{ target: t, due }];
    });
    const earliestDue = imminent.reduce<bigint | null>(
      (earliest, item) => earliest === null || item.due < earliest ? item.due : earliest,
      null,
    );
    followingDeadline = imminent.reduce<bigint | null>((next, item) => {
      if (earliestDue === null || item.due <= earliestDue) return next;
      return next === null || item.due < next ? item.due : next;
    }, null);
    // A bundle has one execution timestamp. Batch only the earliest-deadline
    // cohort; mixing due+1 timestamps would invalidate and discard every kill.
    for (const { target: t, due } of imminent) {
      if (due !== earliestDue) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(BigInt(t.tokenId)), value: 0n, gas: PRE_BOUNDARY_OFFENSE_GAS },
        "kill",
        // Simulate one second past the audit-expiry, where kill() first becomes valid.
        { targetTokenId: t.tokenId, message: `Pre-boundary kill #${t.tokenId} (audit expiring, deadline race)`, race: true, simTimestamp: due + 1n, actionUrgency: "boundary", citizensAddress },
      );
    }
  } catch (err) {
    logger.error("pre-boundary kill error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary kill error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
    if (executionIsCurrent(generation) && followingDeadline !== null) {
      nextKillDeadlineSec = followingDeadline;
      schedulePreBoundaryKill();
    }
  }
}

// Lead time before an offense deadline at which we fire the pre-emptive tick, so
// the tx is built and submitted in time to compete in the first eligible block.
const OFFENSE_LEAD_MS = 1_500;

/**
 * Fire an extra tick just before the soonest offense deadline so kills/audits
 * land in the FIRST eligible block instead of the block after (the ~12s latency
 * gap seen in race post-mortems). Two kinds of deadline:
 *   - kill: the nearest pending audit's expiry (`nextKillDeadlineSec`) — after
 *     this instant, kill() succeeds.
 *   - audit: the next epoch boundary — a token 1 epoch behind becomes auditable
 *     (2+ behind) when the epoch rolls, and fresh delinquencies appear then too.
 * Picks whichever is sooner and schedules a tick ~OFFENSE_LEAD_MS before it.
 */
export function scheduleOffenseBoundary(): void {
  if (offenseBoundaryTimer) {
    clearTimeout(offenseBoundaryTimer);
    offenseBoundaryTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.offenseEnabled || !s.offenseBoundaryScheduling) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // Candidate 1: next epoch boundary. Epoch N begins at startTime + (N-1)*DUR,
  // so the boundary that starts epoch (current+1) is startTime + current*DUR.
  const nextEpochBoundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS;

  // Candidate 2: soonest pending audit expiry that is still in the future.
  const candidates = [nextEpochBoundary];
  if (nextKillDeadlineSec !== null && nextKillDeadlineSec > nowSec) {
    candidates.push(nextKillDeadlineSec);
  }
  const soonest = candidates.filter((c) => c > nowSec).sort((a, b) => (a < b ? -1 : 1))[0];
  if (soonest === undefined) return;

  const deltaMs = Number(soonest - nowSec) * 1000 - OFFENSE_LEAD_MS;
  if (deltaMs <= 0) {
    void tick();
    return;
  }
  const delayMs = Math.min(deltaMs, 2_000_000_000);
  const generation = engineGeneration;
  offenseBoundaryTimer = setTimeout(() => fireBoundaryTick(generation), delayMs);
}

async function refreshSnapshot(address: Address): Promise<void> {
  // Fetch the full latest block (not just its number) so it warms the shared
  // block cache: every canSpend/computeFees later in this tick then reuses it
  // instead of each re-reading the block for the base fee.
  const [snap, balance, latest] = await Promise.all([
    getGameSnapshot(),
    publicClient.getBalance({ address }),
    getLatestBlockCached(),
  ]);
  runtime.gameState = snap.state;
  runtime.currentEpoch = snap.currentEpoch;
  runtime.citizenSupply = snap.citizenSupply;
  runtime.citizensAddress = snap.citizensAddress;
  runtime.startTime = snap.startTime;
  runtime.balanceWei = balance;
  runtime.lastBlock = latest.number;
  runtime.emitStatus();
  scheduleJitBoundary();
  schedulePreBoundaryPay();
  schedulePreBoundaryAudit();
}

/** Refresh the balance after nonce/journal terminality has been reconciled.
 * Balance reads performed in parallel with reconciliation are not safe for
 * spending because a newly confirmed transaction can both consume a liability
 * and reduce the real balance between those reads. */
async function refreshSpendableBalance(address: Address): Promise<bigint> {
  for (;;) {
    const revision = liabilitySettlementRevision;
    const requiredBlock = balanceMustIncludeBlock;
    const blockNumber = await publicClient.getBlockNumber();
    if (requiredBlock !== null && blockNumber < requiredBlock) {
      throw new Error(
        `balance RPC is behind terminal block ${requiredBlock} (latest ${blockNumber})`,
      );
    }
    const balance = await publicClient.getBalance({ address, blockNumber });
    if (runtime.account?.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error("wallet identity changed while refreshing spendable balance");
    }
    // A receipt may settle while the balance request is in flight. Discard that
    // response and retry at a block that includes the newer terminal evidence.
    if (
      revision !== liabilitySettlementRevision
      || requiredBlock !== balanceMustIncludeBlock
    ) continue;
    runtime.balanceWei = balance;
    spendableBalanceRevision = revision;
    runtime.emitStatus();
    return balance;
  }
}

function minBalanceFloorFailure(
  balanceWei: bigint,
  valueWei: bigint,
  gasWei: bigint,
  replacement?: ReplacementFlight,
): string | undefined {
  const address = runtime.account?.address;
  const excludedNonce = replacement?.nonce;
  const reserved = address ? outstandingLiabilityWei(address, excludedNonce) : 0n;
  const priorLineageExposure = address && excludedNonce !== undefined
    ? pendingLiabilities.get(liabilityKey(address, excludedNonce))?.maxExposureWei ?? 0n
    : 0n;
  const candidateExposure = valueWei + gasWei;
  const mutuallyExclusiveExposure = priorLineageExposure > candidateExposure
    ? priorLineageExposure
    : candidateExposure;
  const floor = parseEther(String(runtime.strategy.minBalanceEth));
  return canAffordSpend(
    balanceWei,
    committedThisTickWei + reserved,
    mutuallyExclusiveExposure,
    0n,
    floor,
  )
    ? undefined
    : "would breach min-balance floor";
}

async function authorizeExactSpend(
  quote: { valueWei: bigint; gasWei: bigint },
  replacement?: ReplacementFlight,
  ownership: OwnershipAuthorizationScope = {
    citizensAddress: null,
    mustOwnTokenIds: [],
    mustNotOwnTokenIds: [],
  },
): Promise<{ ok: boolean; error?: string; stillValid: () => boolean }> {
  const address = runtime.account?.address;
  const generation = executingGeneration;
  if (!address || generation === null || !executionIsCurrent(generation)) {
    return { ok: false, error: "engine stopped before transaction authorization", stillValid: () => false };
  }
  const needsOwnership = ownership.mustOwnTokenIds.length > 0
    || ownership.mustNotOwnTokenIds.length > 0;
  if (needsOwnership && ownership.citizensAddress === null) {
    return {
      ok: false,
      error: "citizens contract unavailable for final ownership authorization",
      stillValid: () => false,
    };
  }
  for (;;) {
    const revision = liabilitySettlementRevision;
    const requiredBlock = balanceMustIncludeBlock;
    const blockNumber = await publicClient.getBlockNumber();
    if (requiredBlock !== null && blockNumber < requiredBlock) {
      return {
        ok: false,
        error: `authorization RPC is behind terminal block ${requiredBlock} (latest ${blockNumber})`,
        stillValid: () => false,
      };
    }
    const ownershipContracts = needsOwnership
      ? [...ownership.mustOwnTokenIds, ...ownership.mustNotOwnTokenIds].map((tokenId) => ({
          address: ownership.citizensAddress!,
          abi: citizensAbi,
          functionName: "ownerOf" as const,
          args: [BigInt(tokenId)] as const,
        }))
      : [];
    const [balance, owners] = await Promise.all([
      publicClient.getBalance({ address, blockNumber }),
      ownershipContracts.length === 0
        ? Promise.resolve([])
        : publicClient.multicall({
            allowFailure: true,
            contracts: ownershipContracts,
            blockNumber,
          }),
    ]);
    if (runtime.account?.address.toLowerCase() !== address.toLowerCase()) {
      return { ok: false, error: "wallet identity changed during authorization", stillValid: () => false };
    }
    if (revision !== liabilitySettlementRevision || requiredBlock !== balanceMustIncludeBlock) continue;

    let ownershipError: string | undefined;
    for (let i = 0; i < ownership.mustOwnTokenIds.length; i++) {
      const result = owners[i];
      if (result?.status !== "success") {
        ownershipError = `ownerOf(${ownership.mustOwnTokenIds[i]}) unavailable at block ${blockNumber}`;
        break;
      }
      if ((result.result as Address).toLowerCase() !== address.toLowerCase()) {
        ownershipError = `wallet no longer owns token #${ownership.mustOwnTokenIds[i]}`;
        break;
      }
    }
    const targetOffset = ownership.mustOwnTokenIds.length;
    if (!ownershipError) {
      for (let i = 0; i < ownership.mustNotOwnTokenIds.length; i++) {
        const result = owners[targetOffset + i];
        if (result?.status !== "success") {
          ownershipError = `ownerOf(${ownership.mustNotOwnTokenIds[i]}) unavailable at block ${blockNumber}`;
          break;
        }
        if ((result.result as Address).toLowerCase() === address.toLowerCase()) {
          ownershipError = `wallet now owns offense target #${ownership.mustNotOwnTokenIds[i]}`;
          break;
        }
      }
    }

    runtime.balanceWei = balance;
    spendableBalanceRevision = revision;
    runtime.emitStatus();
    const floorError = minBalanceFloorFailure(balance, quote.valueWei, quote.gasWei, replacement);
    const error = ownershipError ?? floorError;
    return {
      ok: error === undefined,
      error,
      // Transport calls this synchronously immediately before nonce reservation
      // and signing, closing the receipt-settlement microtask gap after the await.
      stillValid: () => liabilitySettlementRevision === revision
        && spendableBalanceRevision === revision
        && runtime.account?.address.toLowerCase() === address.toLowerCase()
        && executionIsCurrent(generation),
    };
  }
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors?
 *  `offense` selects the audit/kill gas profile so the base-fee cap and gas
 *  estimate match what `submitTx` will actually bid. */
async function canSpend(
  valueWei: bigint,
  offense: boolean,
  replacement?: ReplacementFlight,
): Promise<{ ok: boolean; reason?: string }> {
  const s = runtime.strategy;
  const gas = resolveGas(s, offense);
  const block = await getLatestBlockCached();
  const baseFee = block.baseFeePerGas ?? 0n;
  const maxBase = BigInt(Math.round(gas.maxBaseFeeGwei * 1e9));
  if (baseFee > maxBase) {
    return { ok: false, reason: `base fee ${formatEther(baseFee * 1_000_000_000n)} gwei over cap` };
  }
  // Runaway-payment backstop: never send a single tx whose value exceeds the
  // cap. Guards against a bad tax estimate or a token being many epochs behind
  // draining the wallet in one shot. 0 disables the cap.
  if (s.maxPaymentEth > 0) {
    const cap = parseEther(String(s.maxPaymentEth));
    if (valueWei > cap) {
      return {
        ok: false,
        reason: `payment ${formatEther(valueWei)} ETH exceeds max-payment cap ${s.maxPaymentEth} ETH`,
      };
    }
  }

  let priorityFee = BigInt(Math.round(effectiveTipGwei(gas, block.gasUsed, block.gasLimit) * 1e9));
  let maxFeePerGas = baseFee * 2n + priorityFee;
  if (replacement) {
    const fees = cappedReplacementFees(
      maxFeePerGas,
      priorityFee,
      replacement.maxFeePerGas,
      replacement.maxPriorityFeePerGas,
      gas,
    );
    if (!fees) return { ok: false, reason: "replacement fee ceiling reached" };
    priorityFee = fees.maxPriorityFeePerGas;
    maxFeePerGas = fees.maxFeePerGas;
  }
  const gasWei = GAS_GUESS * maxFeePerGas;

  const address = runtime.account?.address;
  const bal = address && (
    runtime.balanceWei === null
    || spendableBalanceRevision !== liabilitySettlementRevision
  )
    ? await refreshSpendableBalance(address)
    : runtime.balanceWei ?? 0n;
  // Reserve every signed nonce lineage from prior ticks in addition to this
  // tick's fresh commitments. Replacing one nonce swaps alternatives, so only
  // that lineage's maximum is counted.
  const floorFailure = minBalanceFloorFailure(bal, valueWei, gasWei, replacement);
  if (floorFailure) return { ok: false, reason: floorFailure };

  return { ok: true };
}

// How long to wait for a submitted tx's receipt before giving up. A tx that
// never lands (dropped, replaced, or a bundle that lost) times out and is left
// as "submitted" rather than being force-marked one way or the other.
const RECEIPT_TIMEOUT_MS = 3 * 60_000;

interface PricedReceipt {
  status: "success" | "reverted";
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

function accountForReceipt(liability: PendingLiability, receipt: PricedReceipt): void {
  if (!settlePendingLiability(liability.account, liability.nonce, receipt.blockNumber)) return;
  const actualGasWei = receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined
    ? receipt.gasUsed * receipt.effectiveGasPrice
    : liability.gasWei;
  const transferredValue = receipt.status === "success" ? liability.valueWei : 0n;
  runtime.recordConfirmedSpend(transferredValue + actualGasWei);
}

/** Resolve a terminal payment discovered by chain-state reconciliation. A cold
 * restart has no receipt watcher, so query the known hash once; confirmed nonce
 * consumption still clears pending exposure if the receipt RPC is unavailable. */
async function settleTerminalFlightLiability(
  flight: ReplacementFlight,
  terminalBlock?: bigint,
): Promise<void> {
  const liability = pendingLiabilities.get(liabilityKey(flight.account, flight.nonce));
  if (!liability) return;
  const getReceipt = (publicClient as unknown as {
    getTransactionReceipt?: (args: { hash: Hex }) => Promise<PricedReceipt>;
  }).getTransactionReceipt;
  if (flight.txHash && getReceipt) {
    try {
      const receipt = await getReceipt.call(publicClient, { hash: flight.txHash });
      accountForReceipt(liability, receipt);
      return;
    } catch {
      // The confirmed nonce/state is authoritative even if this provider pruned
      // the receipt; clear exposure below without inventing confirmed gas spend.
    }
  }
  settlePendingLiability(flight.account, flight.nonce, terminalBlock);
}

/**
 * Poll for a submitted tx's receipt and flip its activity entry from "submitted"
 * to "included" (mined OK) or "reverted" (mined but failed). Fire-and-forget:
 * never awaited by the tick loop, and swallows errors/timeouts so a stuck poll
 * can't wedge the engine.
 */
async function trackReceipt(
  entryId: string | undefined,
  txHash: `0x${string}`,
  liability: PendingLiability,
  receiptFlight?: PaymentFlight,
  receiptActionFlight?: ActionFlight,
): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const block = receipt.blockNumber?.toString();
    if (entryId) {
      activity.update(entryId, {
        status: receipt.status === "success" ? "included" : "reverted",
        targetBlock: block,
      });
    }
    accountForReceipt(liability, receipt as PricedReceipt);
    if (receiptFlight) {
      const current = paymentFlights.get(receiptFlight.tokenId);
      // Every alternative signed with this nonce is terminal once any one of
      // them mines. Never resurrect a flight cleared by an account switch, and
      // preserve the current replacement's obligations if an older hash wins.
      if (
        current
        && current.account === receiptFlight.account
        && current.nonce === receiptFlight.nonce
      ) {
        if (receipt.status === "success") {
          current.delivery = "included";
        } else {
          clearSourceMarker(current);
          paymentFlights.delete(receiptFlight.tokenId);
        }
      }
    }
    if (receiptActionFlight) {
      const current = actionFlights.get(receiptActionFlight.key);
      if (
        current
        && current.account.toLowerCase() === receiptActionFlight.account.toLowerCase()
        && current.nonce === receiptActionFlight.nonce
      ) {
        actionFlights.delete(receiptActionFlight.key);
      }
    }
  } catch (err) {
    // Timed out or RPC error — leave the entry as "submitted".
    logger.warn(`receipt tracking for ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}

interface PaymentActContext {
  startingLastEpochPaid: bigint | null;
  expectedLastEpochPaid: bigint;
  source: PaymentSource;
  pricedEpoch: bigint;
  replace?: PaymentFlight;
  jitTargetEpoch?: number;
  jitCampaignRevision?: number;
  proactiveEpoch?: bigint;
  reserveProactiveMarker?: boolean;
  obligationCovered?: boolean;
  cancelRequired?: boolean;
  inertFiller?: boolean;
  recoveredGap?: boolean;
}

interface OwnershipAuthorizationScope {
  citizensAddress: Address | null;
  mustOwnTokenIds: string[];
  mustNotOwnTokenIds: string[];
}

interface ActContext {
  tokenId?: string;
  targetTokenId?: string;
  message: string;
  race?: boolean;
  simTimestamp?: bigint;
  payment?: PaymentActContext;
  actionReplacement?: ActionFlight;
  actionUrgency?: ActionUrgency;
  inert?: boolean;
  citizensAddress?: Address;
}

function ownershipScopeForAct(
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: ActContext,
): OwnershipAuthorizationScope {
  const citizensAddress = ctx.citizensAddress ?? runtime.citizensAddress as Address | null;
  if (ctx.inert) {
    return { citizensAddress, mustOwnTokenIds: [], mustNotOwnTokenIds: [] };
  }
  if (kind === "pay-taxes" || kind === "use-bribe") {
    return {
      citizensAddress,
      mustOwnTokenIds: ctx.tokenId === undefined ? [] : [ctx.tokenId],
      mustNotOwnTokenIds: [],
    };
  }
  if (kind === "audit") {
    return {
      citizensAddress,
      mustOwnTokenIds: ctx.tokenId === undefined ? [] : [ctx.tokenId],
      mustNotOwnTokenIds: ctx.targetTokenId === undefined ? [] : [ctx.targetTokenId],
    };
  }
  return {
    citizensAddress,
    mustOwnTokenIds: [],
    mustNotOwnTokenIds: ctx.targetTokenId === undefined ? [] : [ctx.targetTokenId],
  };
}

function markPaymentObligationCovered(flight: PaymentFlight): void {
  flight.obligationCovered = true;
  flight.cancelRequired = true;
  const tokenId = flight.tokenId;
  if (
    flight.jitTargetEpoch !== null
    && flight.jitCampaignRevision !== null
    && runtime.jitCampaign.state === "armed"
    && runtime.jitCampaign.revision === flight.jitCampaignRevision
    && runtime.jitCampaign.targetEpoch === flight.jitTargetEpoch
    && runtime.jitCampaign.tokenIds.includes(tokenId)
  ) {
    prepareJitBookkeeping();
    if (jitSubmittedRevision === flight.jitCampaignRevision) jitSubmitted.add(tokenId);
  }
  if (flight.proactiveEpoch !== null && runtime.currentEpoch === flight.proactiveEpoch) {
    if (proactivePaySubmittedEpoch !== flight.proactiveEpoch) {
      proactivePaySubmittedEpoch = flight.proactiveEpoch;
      proactivePaySubmitted = new Set();
    }
    proactivePaySubmitted.add(tokenId);
  }
}

function pendingPaymentFor(tokenId: string, observedLastEpochPaid: bigint): PaymentFlight | undefined {
  const flight = paymentFlights.get(tokenId);
  if (!flight) return undefined;
  const observedCovered = flight.obligationCovered
    || observedLastEpochPaid >= flight.expectedLastEpochPaid
    || (
      flight.recoveredGap
      && flight.pricedEpoch > 0n
      && observedLastEpochPaid >= flight.pricedEpoch
    );
  // This status read suppresses another semantic payment immediately, but only
  // reconcilePaymentFlights pairs progress with the confirmed nonce at one
  // explicit block and gains authority to sign an inert cancellation.
  if (observedCovered && flight.delivery === "included") paymentFlights.delete(tokenId);
  return flight.delivery === "included" ? undefined : flight;
}

/** A definitively rejected lower transaction cannot simply be forgotten once a
 * higher nonce has escaped to a remote txpool. If somebody else satisfies the
 * tax obligation first, replace that exact lower nonce with the cheapest
 * semantically inert transaction so the accepted suffix can become executable. */
async function fillCoveredPaymentGap(flight: PaymentFlight): Promise<void> {
  const current = paymentFlights.get(flight.tokenId);
  if (
    !current
    || current.attemptId !== flight.attemptId
    || !current.cancelRequired
    || current.delivery === "queued"
  ) return;
  if (
    current.inertFiller
    && !current.retryImmediately
    && Date.now() - current.submittedAtMs < PAYMENT_REPLACEMENT_AFTER_MS
  ) return;
  await act(
    { to: current.account, data: "0x", value: 0n, gas: 21_000n },
    "pay-taxes",
    {
      tokenId: current.tokenId,
      message: `Fill covered payment nonce ${current.nonce} for #${current.tokenId}`,
      inert: true,
      payment: {
        expectedLastEpochPaid: current.expectedLastEpochPaid,
        startingLastEpochPaid: current.startingLastEpochPaid,
        source: current.source,
        pricedEpoch: current.pricedEpoch,
        replace: current,
        jitTargetEpoch: current.jitTargetEpoch ?? undefined,
        jitCampaignRevision: current.jitCampaignRevision ?? undefined,
        proactiveEpoch: current.proactiveEpoch ?? undefined,
        reserveProactiveMarker: current.proactiveMarkerReserved,
        obligationCovered: current.obligationCovered,
        cancelRequired: true,
        inertFiller: true,
        recoveredGap: current.recoveredGap,
      },
    },
  );
}

/** Reconcile payment flights at one explicit block. A receipt watcher can time
 * out, and another wallet transaction (or a reverted payment) can consume the
 * nonce without advancing lastEpochPaid. Once the confirmed nonce is beyond a
 * flight, stale tax state proves the flight is terminal and the next pass must
 * use a fresh nonce instead of replacing an impossible one forever. */
async function reconcilePaymentFlights(
  address: Address,
  atBlockNumber: bigint | null = runtime.lastBlock,
): Promise<void> {
  const flights = [...paymentFlights.values()].filter((flight) => flight.account === address);
  if (flights.length === 0) return;
  const blockNumber = atBlockNumber;
  try {
    const citizensAddress = runtime.citizensAddress as Address | null;
    const [confirmedNonce, results, auditResults, owners] = await Promise.all([
      blockNumber === null
        ? publicClient.getTransactionCount({ address, blockTag: "latest" })
        : publicClient.getTransactionCount({ address, blockNumber }),
      publicClient.multicall({
        allowFailure: true,
        contracts: flights.map((flight) => ({
          ...gameContract,
          functionName: "lastEpochPaid" as const,
          args: [BigInt(flight.tokenId)] as const,
        })),
        ...(blockNumber === null ? {} : { blockNumber }),
      }),
      publicClient.multicall({
        allowFailure: true,
        contracts: flights.map((flight) => ({
          ...gameContract,
          functionName: "auditDueTimestamp" as const,
          args: [BigInt(flight.tokenId)] as const,
        })),
        ...(blockNumber === null ? {} : { blockNumber }),
      }),
      citizensAddress === null
        ? Promise.resolve([])
        : publicClient.multicall({
            allowFailure: true,
            contracts: flights.map((flight) => ({
              address: citizensAddress,
              abi: citizensAbi,
              functionName: "ownerOf" as const,
              args: [BigInt(flight.tokenId)] as const,
            })),
            ...(blockNumber === null ? {} : { blockNumber }),
          }),
    ]);
    for (let i = 0; i < flights.length; i++) {
      const snapshot = flights[i]!;
      const current = paymentFlights.get(snapshot.tokenId);
      if (!current || current.attemptId !== snapshot.attemptId) continue;
      const result = results[i];
      const observed = result?.status === "success" ? result.result as bigint : null;
      let obligationCovered = current.obligationCovered;
      if (observed !== null) {
        const coldRecovered = current.startingLastEpochPaid === null && !current.inertFiller;
        obligationCovered = obligationCovered
          || observed >= current.expectedLastEpochPaid
          || (
            current.recoveredGap
            && current.pricedEpoch > 0n
            && observed >= current.pricedEpoch
          );
        if (obligationCovered) markPaymentObligationCovered(current);
        const auditResult = auditResults[i];
        const auditDue = auditResult?.status === "success"
          ? auditResult.result as bigint
          : null;
        const matchingCurrentJit = runtime.jitCampaign.state === "armed"
          && runtime.jitCampaign.targetEpoch === Number(current.pricedEpoch)
          && runtime.jitCampaign.tokenIds.includes(current.tokenId)
          && observed < current.pricedEpoch;
        if (
          coldRecovered
          && (
            observed >= current.pricedEpoch
            || (
              runtime.currentEpoch !== null
              && current.pricedEpoch <= runtime.currentEpoch
              && auditDue === 0n
              && !isAuditable(observed, runtime.currentEpoch)
              && !matchingCurrentJit
            )
          )
        ) {
          current.cancelRequired = true;
        }
        if (
          current.startingLastEpochPaid !== null
          && observed > current.startingLastEpochPaid
        ) {
          // Any external partial advance changes the meaning of an n-epoch call:
          // if the old raw later lands it would pay n more epochs from the new
          // baseline and exceed the target originally authorized by the operator.
          current.cancelRequired = true;
        } else if (current.startingLastEpochPaid === null && !current.inertFiller) {
          // Cold WAL recovery cannot reconstruct the signing-time baseline. Anchor
          // the first coherent observation so any later advance is still caught.
          current.startingLastEpochPaid = observed;
        }
      }
      const owner = owners[i];
      const ownerProvesTransfer = owner?.status === "success"
        && (owner.result as Address).toLowerCase() !== current.account.toLowerCase();
      const scopeDisabled = !paymentAutomationAuthorized(
        current.tokenId,
        current.pricedEpoch,
        current.jitTargetEpoch,
      );
      if (ownerProvesTransfer || scopeDisabled) current.cancelRequired = true;
      if (confirmedNonce > current.nonce) {
        await settleTerminalFlightLiability(current, blockNumber ?? undefined);
        if (!obligationCovered) clearSourceMarker(current);
        paymentFlights.delete(current.tokenId);
        if (!obligationCovered) {
          activity.add({
            kind: "info",
            status: "info",
            tokenId: current.tokenId,
            message: `Payment nonce ${current.nonce} was consumed without advancing #${current.tokenId}; retrying with fresh chain state`,
          });
        }
      } else if (current.cancelRequired) {
        await fillCoveredPaymentGap(current);
      }
    }
  } catch (err) {
    // Retain the existing flight and let the ordinary safety passes continue;
    // this check is retried on the next tick.
    logger.warn("payment-flight reconciliation failed:", (err as Error).message);
  }
}

type ActionAssessment = "live" | "obsolete" | "unknown";

interface ActionAssessmentContext {
  citizensAddress?: Address | null;
  startTime?: bigint | null;
  propagateRpcError?: boolean;
}

type LooseMulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error?: unknown };

/** Viem's ABI inference becomes prohibitively deep for the deliberately mixed
 * ERC-721/game calls used by semantic reconciliation. Keep the type erasure at
 * this one RPC boundary; every result is status-checked before being decoded. */
async function looseMulticall(
  contracts: readonly unknown[],
  blockNumber: bigint,
): Promise<LooseMulticallResult[]> {
  const multicall = publicClient.multicall as unknown as (args: {
    allowFailure: true;
    contracts: readonly unknown[];
    blockNumber: bigint;
  }) => Promise<LooseMulticallResult[]>;
  return multicall({ allowFailure: true, contracts, blockNumber });
}

function actionAutomationAuthorized(flight: ActionFlight): boolean {
  if (flight.kind === "use-bribe") {
    return runtime.strategy.defenseEnabled && runtime.strategy.autoUseBribe;
  }
  if (flight.kind === "audit") {
    return runtime.strategy.offenseEnabled && runtime.strategy.autoAudit;
  }
  return runtime.strategy.offenseEnabled && runtime.strategy.autoKill;
}

async function assessActionFlight(
  flight: ActionFlight,
  blockNumber: bigint,
  blockTimestamp: bigint,
  currentEpoch: bigint | null,
  context: ActionAssessmentContext = {},
): Promise<ActionAssessment> {
  if (flight.obsolete || flight.inertFiller) return "obsolete";
  if (!actionAutomationAuthorized(flight)) return "obsolete";
  const citizensAddress = context.citizensAddress === undefined
    ? runtime.citizensAddress as Address | null
    : context.citizensAddress;
  if (citizensAddress === null || currentEpoch === null) return "unknown";
  const ownerCall = (tokenId: string) => ({
    address: citizensAddress,
    abi: citizensAbi,
    functionName: "ownerOf" as const,
    args: [BigInt(tokenId)] as const,
  });
  const gameCall = (functionName: string, args: readonly bigint[]) => ({
    ...gameContract,
    functionName,
    args,
  });
  try {
    if (flight.kind === "use-bribe") {
      if (flight.tokenId === undefined) return "unknown";
      const results = await looseMulticall(
        [
          ownerCall(flight.tokenId),
          gameCall("auditDueTimestamp", [BigInt(flight.tokenId)]),
          gameCall("bribeBalance", [BigInt(flight.tokenId)]),
        ],
        blockNumber,
      );
      if (results[0]?.status !== "success") return "obsolete";
      if (results.slice(1).some((result) => result.status !== "success")) return "unknown";
      const values = results.map((result) => result.status === "success" ? result.result : undefined);
      const owner = values[0] as Address;
      const auditDue = values[1] as bigint;
      const bribes = values[2] as bigint;
      return owner.toLowerCase() === flight.account.toLowerCase()
        && auditDue !== 0n
        && bribes > 0n
        ? "live"
        : "obsolete";
    }

    if (flight.kind === "kill") {
      if (flight.targetTokenId === undefined) return "unknown";
      const results = await looseMulticall(
        [
          ownerCall(flight.targetTokenId),
          gameCall("auditDueTimestamp", [BigInt(flight.targetTokenId)]),
        ],
        blockNumber,
      );
      if (results[0]?.status !== "success") return "obsolete";
      if (results.slice(1).some((result) => result.status !== "success")) return "unknown";
      const values = results.map((result) => result.status === "success" ? result.result : undefined);
      const owner = values[0] as Address;
      const auditDue = values[1] as bigint;
      if (owner.toLowerCase() === flight.account.toLowerCase()) return "obsolete";
      if (flight.notBeforeTimestamp !== null && blockTimestamp < flight.notBeforeTimestamp) {
        return auditDue !== 0n && flight.notBeforeTimestamp === auditDue + 1n
          ? "live"
          : "obsolete";
      }
      return isKillable(auditDue, blockTimestamp) ? "live" : "obsolete";
    }

    if (
      flight.auditorTokenId === undefined
      || flight.targetTokenId === undefined
    ) return "unknown";
    const source = BigInt(flight.auditorTokenId);
    const target = BigInt(flight.targetTokenId);
    const results = await looseMulticall(
      [
        ownerCall(flight.auditorTokenId),
        ownerCall(flight.targetTokenId),
        gameCall("lastEpochPaid", [source]),
        gameCall("auditsUsedInEpoch", [source, currentEpoch]),
        gameCall("auditLimit", [source]),
        gameCall("lastEpochPaid", [target]),
        gameCall("auditDueTimestamp", [target]),
      ],
      blockNumber,
    );
    if (results[0]?.status !== "success" || results[1]?.status !== "success") return "obsolete";
    if (results.slice(2).some((result) => result.status !== "success")) return "unknown";
    const values = results.map((result) => result.status === "success" ? result.result : undefined);
    const sourceOwner = values[0] as Address;
    const targetOwner = values[1] as Address;
    if (
      sourceOwner.toLowerCase() !== flight.account.toLowerCase()
      || targetOwner.toLowerCase() === flight.account.toLowerCase()
    ) return "obsolete";
    const sourcePaid = values[2] as bigint;
    const used = values[3] as bigint;
    const limit = values[4] as bigint;
    const targetPaid = values[5] as bigint;
    const targetAuditDue = values[6] as bigint;
    if (targetAuditDue !== 0n) return "obsolete";
    if (flight.notBeforeTimestamp !== null && blockTimestamp < flight.notBeforeTimestamp) {
      const startTime = context.startTime === undefined ? runtime.startTime : context.startTime;
      if (startTime === null || flight.notBeforeTimestamp < startTime) return "unknown";
      const targetEpoch = 1n
        + (flight.notBeforeTimestamp - startTime) / EPOCH_DURATION_SECONDS;
      const exactBoundary = startTime + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
      if (flight.notBeforeTimestamp !== exactBoundary) return "obsolete";
      return isEligibleAuditor(sourcePaid, targetEpoch, 0n, limit)
        && isAuditable(targetPaid, targetEpoch)
        ? "live"
        : "obsolete";
    }
    return isEligibleAuditor(sourcePaid, currentEpoch, used, limit)
      && isAuditable(targetPaid, currentEpoch)
      ? "live"
      : "obsolete";
  } catch (err) {
    if (context.propagateRpcError) throw err;
    logger.warn(`action semantic reconciliation failed for ${flight.key}:`, (err as Error).message);
    return "unknown";
  }
}

async function fillObsoleteAction(flight: ActionFlight): Promise<boolean> {
  const current = actionFlights.get(flight.key);
  if (
    !current
    || current.attemptId !== flight.attemptId
    || !current.obsolete
    || current.delivery === "queued"
  ) return Boolean(current?.inertFiller);
  if (
    current.inertFiller
    && !current.retryImmediately
    && Date.now() - current.submittedAtMs < ACTION_REPLACEMENT_AFTER_MS
  ) return true;
  const result = await act(
    { to: current.account, data: "0x", value: 0n, gas: 21_000n },
    current.kind,
    {
      tokenId: current.tokenId,
      targetTokenId: current.targetTokenId,
      message: `Fill obsolete ${current.kind} nonce ${current.nonce}`,
      actionReplacement: current,
      actionUrgency: current.urgency,
      inert: true,
    },
  );
  return Boolean(result && (result.ok || result.uncertain));
}

async function prepareActionPrefixForPayment(
  address: Address,
  paymentNonce: number | undefined,
): Promise<"none" | "prepared" | "failed"> {
  const ceiling = paymentNonce ?? Number.MAX_SAFE_INTEGER;
  const lowerActions = [...actionFlights.values()]
    .filter((flight) =>
      flight.account.toLowerCase() === address.toLowerCase()
      && flight.nonce < ceiling)
    .sort((left, right) => left.nonce - right.nonce);
  for (const flight of lowerActions) {
    const current = actionFlights.get(flight.key);
    if (!current || current.attemptId !== flight.attemptId) continue;
    // Survival work must not depend on optional game semantics. Force one
    // public-authorized inert replacement into the payment prefix even when the
    // prior action was still live or its last filler was not yet age-due.
    current.obsolete = true;
    current.retryImmediately = true;
    if (!await fillObsoleteAction(current)) return "failed";
  }
  return lowerActions.length === 0 ? "none" : "prepared";
}

/** Receipt polling is best-effort. Confirmed account nonce progress is the
 * terminal fallback for every semantic action, including journal-restored ones
 * that have no live receipt watcher in this process. */
async function reconcileActionFlights(
  address: Address,
  atBlockNumber: bigint | null = runtime.lastBlock,
  submitOffenseFillers = false,
): Promise<void> {
  const normalized = address.toLowerCase();
  const flights = [...actionFlights.values()].filter(
    (flight) => flight.account.toLowerCase() === normalized,
  );
  if (flights.length === 0) return;
  try {
    const blockNumber = atBlockNumber ?? await publicClient.getBlockNumber();
    const [confirmedNonce, block, epochResult] = await Promise.all([
      publicClient.getTransactionCount({ address, blockNumber }),
      publicClient.getBlock({ blockNumber }),
      publicClient.multicall({
        allowFailure: true,
        contracts: [{ ...gameContract, functionName: "currentEpoch" as const }],
        blockNumber,
      }),
    ]);
    const blockTimestamp = (block as { timestamp?: bigint }).timestamp;
    const currentEpoch = epochResult[0]?.status === "success"
      ? epochResult[0].result as bigint
      : null;
    for (const snapshot of flights) {
      const current = actionFlights.get(snapshot.key);
      if (!current || current.attemptId !== snapshot.attemptId) continue;
      if (confirmedNonce > current.nonce) {
        await settleTerminalFlightLiability(current, blockNumber);
        actionFlights.delete(current.key);
        continue;
      }
      if (blockTimestamp === undefined) continue;
      const assessment = await assessActionFlight(
        current,
        blockNumber,
        blockTimestamp,
        currentEpoch,
      );
      if (assessment === "obsolete") current.obsolete = true;
      if (
        current.obsolete
        && (current.kind === "use-bribe" || submitOffenseFillers)
      ) {
        await fillObsoleteAction(current);
      }
    }
  } catch (err) {
    logger.warn("action-flight reconciliation failed:", (err as Error).message);
  }
}

const PAYMENT_REPLACEMENT_AFTER_MS = 30_000;
const ACTION_REPLACEMENT_AFTER_MS = 30_000;

function actionUrgencyRank(urgency: ActionUrgency): number {
  return urgency === "routine" ? 0 : urgency === "survival" ? 1 : 2;
}

function actionReplacementDue(flight: ActionFlight, requestedUrgency: ActionUrgency): boolean {
  if (flight.delivery === "queued") return false;
  if (flight.retryImmediately) return true;
  if (actionUrgencyRank(requestedUrgency) > actionUrgencyRank(flight.urgency)) return true;
  return Date.now() - flight.submittedAtMs >= ACTION_REPLACEMENT_AFTER_MS;
}

function replacementDue(
  flight: PaymentFlight,
  requiredValueWei: bigint,
  requiredEpoch: bigint,
  urgent: boolean,
): boolean {
  if (flight.delivery === "queued") return false;
  if (flight.cancelRequired) return false;
  if (flight.retryImmediately) return true;
  // A stale value or tax epoch can no longer satisfy the current obligation and
  // must be refreshed immediately at the same nonce, independent of age.
  if (requiredValueWei !== flight.valueWei || requiredEpoch !== flight.pricedEpoch) return true;
  if (urgent && flight.source !== "defense") return true;
  return Date.now() - flight.submittedAtMs >= PAYMENT_REPLACEMENT_AFTER_MS;
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: ActContext,
): Promise<SubmitResult | null> {
  const dryRun = runtime.strategy.dryRun;
  const offense = kind === "audit" || kind === "kill";
  const payment = kind === "pay-taxes";
  const semanticKind = payment ? undefined : kind as SemanticActionKind;
  const actionKey = semanticKind === undefined
    ? null
    : semanticActionKey(semanticKind, ctx.tokenId, ctx.targetTokenId);
  const existingAction = actionKey === null ? undefined : actionFlights.get(actionKey);
  const accountAddress = runtime.account?.address;
  const pendingAction = existingAction
    && accountAddress
    && existingAction.account.toLowerCase() === accountAddress.toLowerCase()
      ? existingAction
      : undefined;
  const requestedUrgency = ctx.actionUrgency
    ?? (ctx.simTimestamp !== undefined ? "boundary" : kind === "use-bribe" ? "survival" : "routine");
  const requestedActionReplacement = ctx.actionReplacement;
  const replacementIsCurrent = requestedActionReplacement === undefined || (
    pendingAction?.attemptId === requestedActionReplacement.attemptId
    && pendingAction.key === requestedActionReplacement.key
  );
  const actionReplacement = pendingAction && replacementIsCurrent && (
    ctx.inert
    || actionReplacementDue(pendingAction, requestedUrgency)
  )
    ? pendingAction
    : undefined;
  const replacement: ReplacementFlight | undefined = ctx.payment?.replace ?? actionReplacement;
  if (
    executingGeneration === null
    || !executionIsCurrent(executingGeneration)
  ) {
    if (payment) markPaymentWorkUnsafe();
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — cancelled because the engine stopped`,
    });
    return null;
  }
  let paymentPrefixPrepared = false;
  if (payment && !ctx.inert && accountAddress) {
    const prefix = await prepareActionPrefixForPayment(
      accountAddress,
      ctx.payment?.replace?.nonce,
    );
    paymentPrefixPrepared = prefix === "prepared";
    if (prefix === "failed") {
      markPaymentWorkUnsafe();
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        tokenId: ctx.tokenId,
        message: `${ctx.message} — could not neutralize a lower optional action nonce`,
      });
      return null;
    }
  }
  if (ctx.inert && !payment && !pendingAction) return null;
  if (pendingAction && !actionReplacement) {
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — an unresolved ${pendingAction.kind} submission already reserves nonce ${pendingAction.nonce}`,
    });
    return null;
  }
  if (
    actionReplacement?.kind === "audit"
    && !ctx.inert
    && ctx.tokenId !== actionReplacement.auditorTokenId
  ) {
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — replacement must reuse auditor #${actionReplacement.auditorTokenId}`,
    });
    return null;
  }
  if (
    nonceManager.hasInvisibleReservation()
    && !replacement
    && !paymentPrefixPrepared
  ) {
    if (payment) markPaymentWorkUnsafe();
    activity.add({
      kind: "info",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — waiting for a prior unacknowledged nonce to land or expire`,
    });
    return null;
  }
  const guard = await canSpend(intent.value, offense, replacement);
  if (!guard.ok) {
    if (payment) markPaymentWorkUnsafe();
    activity.add({
      kind,
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — ${guard.reason}`,
    });
    return null;
  }
  try {
    const ownership = ownershipScopeForAct(kind, ctx);
    const result = await submitTx(intent, {
      dryRun,
      // In mainnet mode a bundle only lands if a builder we sent it to wins the
      // slot — so PAYMENTS always mirror to the public mempool as a fallback: one
      // that never lands can cost a citizen, and a tax payment isn't meaningfully
      // front-runnable (rivals already see the delinquency on-chain).
      // While any survival automation is active, offense also gets a public
      // fallback so a private-only offense nonce cannot invisibly fence a later
      // emergency payment. Offense is nevertheless submitted only after the
      // payment prefix has been safely released by tick().
      race: ctx.inert
        ? true
        : offense
          ? Boolean(ctx.race && (
            runtime.strategy.racePublicMempool
            || runtime.strategy.defenseEnabled
            || jitCampaignIsArmed()
          ))
          : true,
      offense,
      simTimestamp: ctx.simTimestamp,
      signal: engineAbortController?.signal,
      authorize: (quote) => authorizeExactSpend(quote, replacement, ownership),
      replacement: replacement
        ? {
            nonce: replacement.nonce,
            priorMaxFeePerGas: replacement.maxFeePerGas,
            priorMaxPriorityFeePerGas: replacement.maxPriorityFeePerGas,
            priorTxHash: replacement.txHash,
            lineageId: replacement.lineageId,
            replacementUuids: replacement.replacementUuids,
          }
        : undefined,
    });
    if (!result.ok && !result.uncertain) {
      if (payment) markPaymentWorkUnsafe();
      activity.add({
        kind,
        status: result.simulated ? "reverted" : "skipped",
        tokenId: ctx.tokenId,
        targetTokenId: ctx.targetTokenId,
        targetBlock: result.targetBlock?.toString(),
        message: `${ctx.message} — ${result.error ?? "failed"}`,
      });
      return result;
    }
    // Count it against this tick's budget so later canSpend checks in the same
    // tick see the reduced headroom (applies in dry-run too, to simulate faithfully).
    committedThisTickWei += result.valueWei + result.gasWei;
    let liability: PendingLiability | undefined;
    let previousLiability: PendingLiability | undefined;
    if (!dryRun) {
      liability = {
        account: runtime.account!.address,
        nonce: result.nonce,
        valueWei: result.valueWei,
        gasWei: result.gasWei,
        maxExposureWei: result.valueWei + result.gasWei,
        txHash: result.txHash,
        submittedAtMs: Date.now(),
        delivery: result.queued ? "queued" : "submitted",
      };
      previousLiability = setPendingLiability(liability);
      liability = pendingLiabilities.get(liabilityKey(liability.account, liability.nonce))!;
      committedNoncesThisTick.add(liabilityKey(liability.account, liability.nonce));
      const submittedExposure = result.valueWei + result.gasWei;
      if (liability.maxExposureWei > submittedExposure) {
        committedThisTickWei += liability.maxExposureWei - submittedExposure;
      }
    }
    let paymentFlight: PaymentFlight | undefined;
    let previousPaymentFlight: PaymentFlight | undefined;
    if (!dryRun && kind === "pay-taxes" && ctx.tokenId !== undefined && ctx.payment) {
      previousPaymentFlight = paymentFlights.get(ctx.tokenId);
      const nextPaymentFlight: PaymentFlight = {
        attemptId: ++nextPaymentAttemptId,
        account: runtime.account!.address,
        tokenId: ctx.tokenId,
        startingLastEpochPaid:
          ctx.payment.inertFiller
            ? previousPaymentFlight?.startingLastEpochPaid ?? ctx.payment.startingLastEpochPaid
            : ctx.payment.startingLastEpochPaid,
        expectedLastEpochPaid: ctx.payment.expectedLastEpochPaid,
        nonce: result.nonce,
        valueWei: result.valueWei,
        gasWei: result.gasWei,
        maxFeePerGas: result.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: result.maxPriorityFeePerGas ?? 0n,
        txHash: result.txHash,
        lineageId: result.lineageId
          ?? previousPaymentFlight?.lineageId
          ?? `${runtime.account!.address.toLowerCase()}:${result.nonce}`,
        replacementUuids: uniqueUuids(
          previousPaymentFlight?.replacementUuids ?? [],
          result.replacementUuids ?? [],
          [result.replacementUuid],
        ),
        retryImmediately: Boolean(result.retryImmediately),
        obligationCovered:
          Boolean(ctx.payment.obligationCovered)
          || Boolean(previousPaymentFlight?.obligationCovered),
        cancelRequired:
          Boolean(ctx.payment.cancelRequired)
          || Boolean(previousPaymentFlight?.cancelRequired),
        inertFiller: Boolean(ctx.payment.inertFiller),
        recoveredGap:
          Boolean(ctx.payment.recoveredGap)
          || Boolean(previousPaymentFlight?.recoveredGap),
        source: ctx.payment.source,
        pricedEpoch: ctx.payment.pricedEpoch,
        jitTargetEpoch: ctx.payment.jitTargetEpoch ?? previousPaymentFlight?.jitTargetEpoch ?? null,
        jitCampaignRevision:
          ctx.payment.jitCampaignRevision
          ?? previousPaymentFlight?.jitCampaignRevision
          ?? null,
        proactiveEpoch: ctx.payment.proactiveEpoch ?? previousPaymentFlight?.proactiveEpoch ?? null,
        proactiveMarkerReserved:
          Boolean(ctx.payment.reserveProactiveMarker)
          || Boolean(previousPaymentFlight?.proactiveMarkerReserved),
        submittedAtMs: Date.now(),
        delivery: result.queued ? "queued" : "submitted",
      };
      paymentFlight = nextPaymentFlight;
      paymentFlights.set(ctx.tokenId, nextPaymentFlight);
    }
    let actionFlight: ActionFlight | undefined;
    let previousActionFlight: ActionFlight | undefined;
    if (!dryRun && semanticKind !== undefined && actionKey !== null) {
      previousActionFlight = actionFlights.get(actionKey);
      actionFlight = {
        attemptId: ++nextActionAttemptId,
        key: actionKey,
        kind: semanticKind,
        account: runtime.account!.address,
        nonce: result.nonce,
        tokenId: ctx.tokenId,
        targetTokenId: ctx.targetTokenId,
        auditorTokenId: semanticKind === "audit" ? ctx.tokenId : undefined,
        valueWei: result.valueWei,
        gasWei: result.gasWei,
        maxFeePerGas: result.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: result.maxPriorityFeePerGas ?? 0n,
        txHash: result.txHash,
        lineageId: result.lineageId
          ?? previousActionFlight?.lineageId
          ?? `${runtime.account!.address.toLowerCase()}:${result.nonce}`,
        replacementUuids: uniqueUuids(
          previousActionFlight?.replacementUuids ?? [],
          result.replacementUuids ?? [],
          [result.replacementUuid],
        ),
        retryImmediately: Boolean(result.retryImmediately),
        obsolete: Boolean(ctx.inert) || Boolean(previousActionFlight?.obsolete),
        inertFiller: Boolean(ctx.inert),
        urgency: requestedUrgency,
        notBeforeTimestamp:
          previousActionFlight?.notBeforeTimestamp
          ?? ctx.simTimestamp
          ?? null,
        submittedAtMs: Date.now(),
        delivery: result.queued ? "queued" : "submitted",
      };
      actionFlights.set(actionKey, actionFlight);
    }
    const entry = activity.add({
      kind,
      status: dryRun
        ? "dry-run"
        : result.uncertain
          ? "delivery-uncertain"
          : result.queued
            ? "prepared"
            : "submitted",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      txHash: result.txHash,
      bundleHash: result.bundleHash,
      targetBlock: result.targetBlock?.toString(),
      valueWei: result.valueWei.toString(),
      gasWei: result.gasWei.toString(),
      message: dryRun ? `[dry-run] ${ctx.message}` : ctx.message,
    });
    runtime.emitStatus();
    // Queued into a bundle batch (mainnet): the tx isn't sent yet, so its hashes
    // and receipt tracking are reconciled by flushBatch at end of tick.
    if (result.queued) {
      batchEntries.push({
        entryId: entry.id,
        nonce: result.nonce,
        message: ctx.message,
        paymentAttemptId: paymentFlight?.attemptId,
        paymentTokenId: paymentFlight?.tokenId,
        previousPaymentFlight,
        actionAttemptId: actionFlight?.attemptId,
        actionKey: actionFlight?.key,
        previousActionFlight,
        liabilityAccount: liability?.account,
        liabilityNonce: liability?.nonce,
        previousLiability,
      });
      return result;
    }
    // Watch for the receipt so the entry flips submitted -> included/reverted.
    // Only public-mempool submissions expose a tx hash; pure Flashbots bundles
    // (bundleHash only) stay "submitted" since there's nothing to poll.
    if (!dryRun && result.txHash && liability) {
      void trackReceipt(entry.id, result.txHash, liability, paymentFlight, actionFlight);
    }
    return result;
  } catch (err) {
    if (payment) markPaymentWorkUnsafe();
    activity.add({
      kind: "error",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — error: ${(err as Error).message}`,
    });
    return null;
  }
}

async function defensePass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  // Cap how many epochs a single auto payment covers (the on-chain estimate is
  // read for this many). Default cap 1 = pay one day to clear, as before.
  const epochs = cappedAutoPayEpochs(s.prepayEpochs, s.maxAutoPayEpochs);
  const statuses = await batchGetOwnedStatuses(ownedIds, currentEpoch, nowSec, epochs);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(st.tokenId, lastEpochPaid);
    const underAudit = st.auditDueTimestamp !== "0";
    const bribes = BigInt(st.bribeBalance);

    // 1) Under audit and within safety buffer -> clear it.
    if (underAudit && (st.secondsUntilKillable ?? 0) <= s.auditSafetyBufferSeconds) {
      // Only spend a bribe if the user opted in — a bribe clears the audit for free
      // but is consumed and leaves the token delinquent (re-auditable), so by
      // default we pay taxes to clear instead and never auto-consume bribes.
      if (!pending && s.autoUseBribe && bribes > 0n) {
        // Bribe is free (value 0) but still costs gas — apply the same guardrail
        // as the pay-to-clear path below so the base-fee cap holds consistently.
        await act(
          { to: appConfig.gameAddress, data: encodeUseBribe(tokenId), value: 0n },
          "use-bribe",
          { tokenId: st.tokenId, message: `Clear audit on #${st.tokenId} with bribe`, actionUrgency: "survival" },
        );
        continue;
      }
      const value = BigInt(st.estimatedPayWei); // estimate for `epochs` (capped)
      if (pending && !replacementDue(pending, value, currentEpoch, true)) continue;
      await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, epochs), value },
        "pay-taxes",
        {
          tokenId: st.tokenId,
          message: `${pending ? "Replace pending payment and clear" : "Pay taxes on"} audited #${st.tokenId} (${epochs} epoch) = ${formatEther(value)} ETH`,
          payment: {
            startingLastEpochPaid: lastEpochPaid,
            expectedLastEpochPaid: lastEpochPaid + BigInt(epochs),
            source: "defense",
            pricedEpoch: currentEpoch,
            replace: pending,
          },
        },
      );
      continue;
    }
  }
}

/**
 * Pay delinquent-but-not-yet-audited citizens. This runs on every tick as the
 * reliable fallback when a pre-boundary tax-skip payment was missed or lost.
 */
async function proactivePayPass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (proactivePaySubmittedEpoch !== currentEpoch) {
    proactivePaySubmittedEpoch = currentEpoch;
    proactivePaySubmitted = new Set();
  }
  // Cap how many epochs a single auto payment covers (so it can't spend a large
  // multi-day catch-up in one shot); the on-chain estimate is read for that many.
  const epochs = cappedAutoPayEpochs(s.prepayEpochs, s.maxAutoPayEpochs);
  const statuses = await batchGetOwnedStatuses(ownedIds, currentEpoch, nowSec, epochs);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(key, lastEpochPaid);

    const underAudit = st.auditDueTimestamp !== "0";
    if (underAudit || st.risk !== "delinquent") continue;

    const value = BigInt(st.estimatedPayWei); // estimate for `epochs` (capped)
    if (value === 0n) continue;
    if (pending && !replacementDue(pending, value, currentEpoch, false)) continue;
    if (!pending && proactivePaySubmitted.has(key)) continue;
    proactivePaySubmitted.add(key); // reserve locally while the async submission is in flight
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, epochs), value },
      "pay-taxes",
      {
        tokenId: st.tokenId,
        message: `${pending ? "Replace pending" : "Proactive"} pay #${st.tokenId} (${epochs} epoch) = ${formatEther(value)} ETH`,
        payment: {
          startingLastEpochPaid: lastEpochPaid,
          expectedLastEpochPaid: lastEpochPaid + BigInt(epochs),
          source: "proactive",
          pricedEpoch: currentEpoch,
          replace: pending,
          proactiveEpoch: currentEpoch,
          reserveProactiveMarker: true,
        },
      },
    );
    if ((!res || (!res.ok && !res.uncertain)) && !pending) {
      proactivePaySubmitted.delete(key); // a definite failed first send must be retryable next tick
    }
  }
}

/**
 * Just-in-time single-epoch payment. When armed for a target epoch, pays exactly
 * one epoch for each selected token the moment the chain reaches that epoch, then
 * auto-disarms. Reads the exact owed amount on-chain so the value is always correct.
 */
function terminalizeJitCampaign(
  campaign: typeof runtime.jitCampaign,
  state: "completed" | "completed-dry-run" | "failed",
  message: string,
): boolean {
  if (
    executingGeneration === null
    || !executionIsCurrent(executingGeneration)
    || runtime.jitCampaign.state !== "armed"
    || runtime.jitCampaign.revision !== campaign.revision
    || runtime.jitCampaign.targetEpoch !== campaign.targetEpoch
  ) return false;
  try {
    runtime.saveJitCampaign({ state, message, completedAt: Date.now() });
  } catch (err) {
    if (!(err instanceof AtomicWriteCommittedError)) throw err;
    // The terminal campaign is already committed in-process, but crash
    // durability is uncertain. Pause every automation mode unconditionally so
    // no later transaction is authorized from state whose persistence is unclear.
    stopEngine();
    activity.add({
      kind: "error",
      status: "skipped",
      message: `JIT campaign state committed but durability is uncertain; engine paused: ${err.message}`,
    });
    logger.error("JIT terminal durability failure:", err.message);
    throw err;
  }
  activity.add({ kind: "info", status: "info", message });
  if (
    campaign.autoStopOnCompletion
    && !runtime.strategy.defenseEnabled
    && !runtime.strategy.offenseEnabled
  ) stopEngine();
  return true;
}

function hasUnresolvedJitCampaignFlight(
  campaign: typeof runtime.jitCampaign,
  target: number,
): boolean {
  const account = runtime.account?.address.toLowerCase();
  if (account === undefined) return false;
  return [...paymentFlights.values()].some((flight) =>
    flight.account.toLowerCase() === account
    && campaign.tokenIds.includes(flight.tokenId)
    && (
      (
        flight.jitTargetEpoch === target
      )
      || (
        flight.jitCampaignRevision === null
        && flight.jitTargetEpoch === null
        && flight.pricedEpoch === BigInt(target)
      )
    ));
}

async function jitPass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const campaign = runtime.jitCampaign;
  if (campaign.state !== "armed" || campaign.targetEpoch === null) return;
  const target = campaign.targetEpoch;
  const campaignRevision = campaign.revision;
  if (currentEpoch < BigInt(target)) return; // target epoch hasn't begun yet
  if (currentEpoch > BigInt(target)) {
    // A stale target is terminal only after every already-authorized raw for the
    // campaign has either consumed its nonce or been inert-filled. Auto-stopping
    // sooner would discard the cancellation work and leave a live old payment.
    if (hasUnresolvedJitCampaignFlight(campaign, target)) return;
    terminalizeJitCampaign(
      campaign,
      "failed",
      `JIT campaign missed target epoch ${target}; chain is already at epoch ${currentEpoch}`,
    );
    return;
  }

  prepareJitBookkeeping();

  const selected = selectedOwnedJitTokenIds(ownedIds, campaign.tokenIds);
  if (selected.length === 0) return; // nothing owned yet — stay armed

  const statuses = await batchGetOwnedStatuses(selected, currentEpoch, nowSec, 1);
  for (const st of statuses) {
    if (
      runtime.jitCampaign.state !== "armed"
      || runtime.jitCampaign.revision !== campaignRevision
      || runtime.jitCampaign.targetEpoch !== target
    ) return;
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    const lastEpochPaid = BigInt(st.lastEpochPaid);
    const pending = pendingPaymentFor(key, lastEpochPaid);
    if (jitSubmitted.has(key)) continue;

    if (lastEpochPaid >= currentEpoch) {
      jitSubmitted.add(key); // confirmed current for this epoch
      continue;
    }
    // JIT pays exactly one epoch — one day — which advances the citizen a single
    // epoch no matter how far behind, so it always fires (even when momentarily 2
    // behind at the boundary). It never pays a multi-day catch-up; if one 1-day
    // payment isn't enough to make a deeply-behind citizen safe, the rest is left
    // for the user (this pays once and marks the token handled below).
    const value = BigInt(st.estimatedPayWei); // estimateTaxesToPay(tokenId, 1) = one day
    if (value === 0n) {
      jitSubmitted.add(key);
      continue;
    }
    if (pending && !replacementDue(pending, value, currentEpoch, false)) continue;
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, 1), value },
      "pay-taxes",
      {
        tokenId: key,
        message: `${pending ? "Replace pending JIT" : "JIT"} pay #${key} for epoch ${currentEpoch} = ${formatEther(value)} ETH`,
        payment: {
          startingLastEpochPaid: lastEpochPaid,
          expectedLastEpochPaid: lastEpochPaid + 1n,
          source: "jit",
          pricedEpoch: currentEpoch,
          replace: pending,
          jitTargetEpoch: target,
          jitCampaignRevision: campaignRevision,
        },
      },
    );
    // Stay armed until a fresh on-chain read confirms lastEpochPaid advanced.
    // A relay/bundle acknowledgement is delivery, not inclusion.
    if (!res || (!res.ok && !res.uncertain)) continue;
    if (runtime.strategy.dryRun) jitSubmitted.add(key);
  }

  // One-shot: disarm once every selected token has been submitted/covered.
  const unresolvedCampaignFlight = hasUnresolvedJitCampaignFlight(campaign, target);
  if (
    selected.every((t) => jitSubmitted.has(t.toString()))
    && !unresolvedCampaignFlight
    && runtime.jitCampaign.state === "armed"
    && runtime.jitCampaign.revision === campaignRevision
    && runtime.jitCampaign.targetEpoch === target
  ) {
    terminalizeJitCampaign(
      campaign,
      runtime.strategy.dryRun ? "completed-dry-run" : "completed",
      `JIT payment complete for epoch ${target}; campaign is terminal`,
    );
  }
}

/**
 * Build the pool of owned tokens usable as audit "from" tokens this tick — each
 * not itself auditable and still under its per-epoch audit limit. Reading
 * auditsUsedInEpoch on-chain means audits already spent earlier this epoch (even
 * in a prior tick) are excluded, so we never exceed a token's limit and hit
 * AuditLimitReached. A token may audit up to `auditLimit` DISTINCT targets per
 * epoch (auditor-role citizens have limit > 1), so it is added to the pool once
 * per *remaining* audit — `auditLimit - auditsUsedInEpoch` times — and each entry
 * backs one audit of a different rival.
 */
async function findEligibleAuditors(ownedIds: bigint[], currentEpoch: bigint): Promise<bigint[]> {
  if (ownedIds.length === 0) return [];
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditsUsedInEpoch" as const, args: [id, currentEpoch] as const },
      { ...gameContract, functionName: "auditLimit" as const, args: [id] as const },
    ]),
  });
  const eligible: bigint[] = [];
  for (let i = 0; i < ownedIds.length; i++) {
    const lep = results[i * 3];
    const used = results[i * 3 + 1];
    const limit = results[i * 3 + 2];
    if (lep?.status !== "success" || used?.status !== "success" || limit?.status !== "success") continue;
    const lepV = lep.result as bigint;
    const usedV = used.result as bigint;
    const limitV = limit.result as bigint;
    if (!isEligibleAuditor(lepV, currentEpoch, usedV, limitV)) continue;
    // Remaining capacity this epoch (>= 1 given isEligibleAuditor); one pool entry each.
    for (let k = usedV; k < limitV; k++) eligible.push(ownedIds[i]!);
  }
  return eligible;
}

async function offensePass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.offenseEnabled) return;

  // Endgame gate.
  if (s.endgameOnlyWithin !== null) {
    const supply = runtime.citizenSupply ?? 0n;
    if (supply - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  }

  const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
  const liveRaw = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
  const live = orderBySalt(liveRaw, (t) => t.id.toString(), engineSalt);
  const owned = new Set(ownedIds.map((x) => x.toString()));
  const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;

  // Narrow to tokens we could actually act on BEFORE reading their status, then
  // fetch all their statuses in ONE multicall — a serial getTargetStatus per
  // token was hundreds/thousands of sequential RPC round-trips when offense
  // targets the whole field (viem's http batching can't coalesce awaited calls).
  const candidates = live.filter(({ id }) => {
    const key = id.toString();
    if (owned.has(key)) return false; // never audit our own
    if (pinned && !pinned.has(key)) return false; // not on the target list
    return true;
  });

  // The auditor pool (owned tokens usable as an audit "from" this tick — each
  // backs one audit, since a token audits at most `auditLimit` times/epoch) and
  // the target statuses are independent reads, so fetch them concurrently. We hand
  // auditors out one per target so multiple rivals can be audited in a single
  // epoch instead of reusing one token and reverting with AuditLimitReached.
  const [candidateAuditors, statuses] = await Promise.all([
    findEligibleAuditors(ownedIds, currentEpoch),
    batchGetTargetStatuses(candidates, currentEpoch, nowSec),
  ]);
  const auditors = reservePendingAuditorCapacity(
    candidateAuditors,
    runtime.account!.address,
  );
  let auditorIdx = 0;
  let noAuditorSkips = 0;

  // Track the soonest not-yet-expired audit deadline so the boundary scheduler
  // can pre-empt the exact moment a kill becomes valid. Reset each sweep.
  let soonestKillDeadline: bigint | null = null;

  for (const t of statuses) {
    if (t.owner.toLowerCase() === runtime.account?.address.toLowerCase()) continue;
    const tokenId = BigInt(t.tokenId);

    // Note the nearest future kill deadline (token under audit, not yet expired).
    const due = BigInt(t.auditDueTimestamp);
    if (due > nowSec && (soonestKillDeadline === null || due < soonestKillDeadline)) {
      soonestKillDeadline = due;
    }

    if (s.autoKill && t.killable) {
      await act(
        { to: appConfig.gameAddress, data: encodeKill(tokenId), value: 0n },
        "kill",
        { targetTokenId: t.tokenId, message: `Kill expired-audit #${t.tokenId}`, race: true },
      );
      continue;
    }

    if (s.autoAudit && t.auditable) {
      const pendingAudit = pendingActionFor("audit", undefined, t.tokenId);
      if (pendingAudit?.obsolete) continue;
      if (pendingAudit && !actionReplacementDue(pendingAudit, "routine")) continue;
      const auditFrom = pendingAudit?.auditorTokenId === undefined
        ? auditors[auditorIdx]
        : BigInt(pendingAudit.auditorTokenId);
      if (auditFrom === undefined) { noAuditorSkips++; continue; }
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(auditFrom, tokenId), value: AUDIT_COST_WEI },
        "audit",
        { tokenId: auditFrom.toString(), targetTokenId: t.tokenId, message: `Audit delinquent #${t.tokenId} from #${auditFrom}`, race: true, actionReplacement: pendingAudit },
      );
      if (res?.ok && !pendingAudit) auditorIdx++; // consume fresh capacity only for a new audit
    }
  }

  if (noAuditorSkips > 0) {
    activity.add({
      kind: "info",
      status: "info",
      message: `Audited ${auditorIdx} rival(s) this sweep; ${noAuditorSkips} more auditable but no eligible auditor token left (each audits up to its per-epoch limit).`,
    });
  }

  // Publish the nearest kill deadline and (re)arm the pre-emptive boundary tick.
  nextKillDeadlineSec = soonestKillDeadline;
  scheduleOffenseBoundary();
  schedulePreBoundaryKill();
}

async function tick(generation = engineGeneration): Promise<void> {
  if (ticking) return;
  if (!executionIsCurrent(generation) || !runtime.unlocked || !runtime.account) return;
  ticking = true;
  executingGeneration = generation;
  committedThisTickWei = 0n; // fresh spend budget for this tick
  paymentWorkUnsafeThisTick = false;
  committedNoncesThisTick = new Set();
  beginBatch();
  const address = runtime.account.address;
  try {
    await ensureSubmissionRecovery(address, generation);
    // Snapshot + nonce sync are independent RPC reads — run them together so the
    // boundary tick shaves a round-trip before it can submit anything.
    await Promise.all([
      refreshSnapshot(address),
      nonceManager.sync(address, appConfig.mode),
    ]);
    await reconcileSubmissionTerminals(address);

    if (runtime.gameState !== 1) {
      // Not LIVE — nothing to do.
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const currentEpoch = runtime.currentEpoch ?? 0n;

    const citizensAddress = runtime.citizensAddress as Address;
    const indexedOwnedIds = await fetchOwnedTokenIds(citizensAddress, address);
    const ownershipCandidates = [
      ...indexedOwnedIds,
      ...(jitCampaignIsArmed() ? runtime.jitCampaign.tokenIds.map((tokenId) => BigInt(tokenId)) : []),
    ];
    const ownedIds = await filterOwnedTokenIds(citizensAddress, ownershipCandidates, address);
    await reconcilePaymentFlights(address);
    await reconcileActionFlights(address);
    await refreshSpendableBalance(address);

    if (runtime.strategy.defenseEnabled) {
      prepareJitBookkeeping();
      await defensePass(ownedIds, currentEpoch, nowSec);
      if (runtime.strategy.proactivePay) {
        await proactivePayPass(ownedIds, currentEpoch, nowSec);
      }
    }
    // JIT is independently armable through the config API and must continue even
    // when continuous defense is disabled.
    await jitPass(ownedIds, currentEpoch, nowSec);

    // Survival payments and best-effort offense must never share one atomic
    // bundle: a raced/stale audit or kill can legitimately revert and must not
    // suppress otherwise-valid defensive payments.
    if (!executionIsCurrent(generation)) return;
    await flushBatch();
    if (!executionIsCurrent(generation)) return;
    // A payment nonce that has not yet advanced on-chain is a hard fence for
    // best-effort offense. Deferring offense avoids constructing a second private
    // bundle above that nonce (which cannot execute independently).
    if (paymentWorkUnsafeThisTick || hasUnresolvedPaymentFlight(address)) return;
    beginBatch();
    await reconcileActionFlights(address, runtime.lastBlock, true);
    await offensePass(ownedIds, currentEpoch, nowSec);
  } catch (err) {
    logger.error("tick error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Tick error: ${(err as Error).message}` });
  } finally {
    await flushOrDiscardBatch(generation);
    nonceManager.reset();
    finishExclusive(generation);
  }
}
