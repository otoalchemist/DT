import { parseEther, formatEther, type Address } from "viem";
import { AUDIT_COST_WEI, WINNERS, EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI, isEmigrated, type StrategyConfig } from "@dat-bot/shared";
import { publicClient, wsClient, getLatestBlockCached, primeBlockCache, getBalanceCached, invalidateBalanceCache } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime, loadAllyTokens } from "./runtime.js";
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
  estimateTaxes,
  gameContract,
} from "./contract.js";
import {
  fetchOwnedTokenIds,
  fetchCandidateTokenIds,
  ownershipIndexingAvailable,
} from "./index-tokens.js";
import { submitTx, beginBundle, flushBundle, queueCoinbaseBid, type TxIntent, type SubmitResult } from "./flashbots.js";
import { resolveGas, canAffordSpend, isEligibleAuditor, isAuditable, preBoundaryTaxWei, cappedAutoPayEpochs, autoPayCapWei, withinAutoPayCap, excludedTokenSet, orderBySalt } from "./logic.js";
import { logger } from "./logger.js";

const TICK_MS = 12_000; // fallback poll interval when WebSocket unavailable
const GAS_GUESS = 200_000n; // for pre-flight spend-cap checks only

let timer: NodeJS.Timeout | null = null;
let boundaryTimer: NodeJS.Timeout | null = null;
let defenseBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryAuditTimer: NodeJS.Timeout | null = null;
let preBoundaryKillTimer: NodeJS.Timeout | null = null;
// Away mode: a wake timer (start the engine before a boundary) and a stop timer (shut it
// down once the boundary work is done). Both are plain setTimeouts — no polling.
let awayWakeTimer: NodeJS.Timeout | null = null;
let awayStopTimer: NodeJS.Timeout | null = null;
let awayNextWakeSec: bigint | null = null;
// True only when AWAY MODE started the engine. A manual Start must never be cut short by
// the away stop timer — the user asked for the engine, so they decide when it stops.
let awayStartedEngine = false;
let preBoundaryBundleTimer: NodeJS.Timeout | null = null;
let unwatchBlocks: (() => void) | null = null;
let ticking = false;
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

// Activity entries whose tx was queued into the current bundle batch (mainnet).
// flushBatch fills in each one's txHash/bundleHash and starts receipt tracking
// once the whole tick's txs are sent together as one atomic bundle.
let batchEntries: { entryId: string; nonce: number }[] = [];

/** Open a bundle batch for a tick so all its txs go out as one atomic multi-tx
 *  bundle (mainnet only; public/local send each tx immediately as before). */
function beginBatch(): void {
  batchEntries = [];
  if (appConfig.mode === "mainnet") beginBundle();
}

/** Send the tick's queued txs as one bundle and reconcile each activity entry
 *  with its resulting hashes / status. No-op in public/local mode. */
async function flushBatch(): Promise<void> {
  const entries = batchEntries;
  batchEntries = [];
  if (appConfig.mode !== "mainnet" || entries.length === 0) return;
  let results: Awaited<ReturnType<typeof flushBundle>>;
  try {
    results = await flushBundle();
  } catch (err) {
    logger.error("bundle flush error:", (err as Error).message);
    return;
  }
  for (const { entryId, nonce } of entries) {
    const r = results.get(nonce);
    if (!r) continue;
    activity.update(entryId, {
      status: r.ok ? "submitted" : "skipped",
      txHash: r.txHash,
      bundleHash: r.bundleHash,
    });
    // Flip submitted -> included/reverted once it lands. A bundle-only tx (a revertible
    // audit riding a payment bundle) was never broadcast so it has no `txHash`, but its
    // hash is derivable from the signed tx — poll that instead of leaving it stuck.
    if (r.txHash) void trackReceipt(entryId, r.txHash);
    else if (r.predictedTxHash) void trackReceipt(entryId, r.predictedTxHash, false);
  }
}

// NOTE: the pre-boundary races now simulate at the future boundary/expiry
// timestamp (see submitTx's simTimestamp), so they validate correctly in BOTH
// public mode (eth_call block overrides) and mainnet mode (eth_callBundle's
// timestamp field) — no mode gating needed.

/**
 * How early to pre-submit a boundary race, by submission path.
 *
 * public/local: a tx that lands in the block BEFORE the boundary carries a
 *   next-epoch value and overpay-reverts, so the lead is held tight (~3s).
 * mainnet: a bundle names its target `blockNumber`, so it cannot land in the
 *   wrong block, and a bundle that would revert is DROPPED rather than mined —
 *   pre-submitting earlier costs nothing and gives builders more time to weigh
 *   it. Default ~5s, kept under a 12s slot so `currentBlock + 1` still resolves
 *   to the boundary block.
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
function fireBoundaryTick(fireProactivePay: boolean): void {
  if (!runtime.running) return;
  if (ticking) {
    setTimeout(() => fireBoundaryTick(fireProactivePay), BOUNDARY_RETRY_MS);
    return;
  }
  void tick(fireProactivePay);
}

// Soonest future audit-expiry (kill deadline) seen in the last offense sweep, in
// unix seconds. Null when no rival token is currently under a pending audit.
let nextKillDeadlineSec: bigint | null = null;

// JIT one-shot bookkeeping: tokenIds already submitted for the active target epoch.
let jitSubmitted = new Set<string>();
let jitSubmittedTarget: number | null = null;

export function resetJitState(): void {
  jitSubmitted = new Set();
  jitSubmittedTarget = null;
}

// Proactive-pay bookkeeping: tokenIds already submitted for the current epoch.
// DEFENSE_LEAD_MS's pre-boundary fire converges through a short second re-arm
// (deltaMs shrinks from ~1.5s to a few hundred ms before finally hitting the
// immediate-fire branch), which would otherwise call proactivePayPass twice in
// quick succession — before the first tx has a chance to confirm and clear the
// "delinquent" classification — and double-submit the same payment.
let proactivePaySubmittedEpoch: bigint | null = null;
let proactivePaySubmitted = new Set<string>();

export function startEngine(): void {
  if (timer || unwatchBlocks) return;
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

  if (wsClient) {
    // React on every new block (~100-500ms latency vs up to 12s with polling). The
    // subscription already carries the full header, so hand it to the block cache
    // instead of letting the tick re-fetch the same block over HTTP.
    unwatchBlocks = wsClient.watchBlocks({
      onBlock: (block) => {
        primeBlockCache(block);
        void tick();
      },
      onError: (err) => logger.warn("Block subscription error:", (err as Error).message),
    });
    activity.add({ kind: "info", status: "info", message: "Block subscription active (WebSocket)" });
  } else {
    // Fallback: poll every 12s if no WebSocket URL is configured.
    timer = setInterval(() => void tick(), TICK_MS);
    activity.add({ kind: "info", status: "info", message: "Polling every 12s (no WebSocket configured)" });
  }
  void tick();
}

export function stopEngine(): void {
  if (timer) clearInterval(timer);
  if (boundaryTimer) clearTimeout(boundaryTimer);
  if (defenseBoundaryTimer) clearTimeout(defenseBoundaryTimer);
  if (preBoundaryTimer) clearTimeout(preBoundaryTimer);
  if (preBoundaryAuditTimer) clearTimeout(preBoundaryAuditTimer);
  if (preBoundaryKillTimer) clearTimeout(preBoundaryKillTimer);
  if (preBoundaryBundleTimer) clearTimeout(preBoundaryBundleTimer);
  if (unwatchBlocks) unwatchBlocks();
  timer = null;
  boundaryTimer = null;
  defenseBoundaryTimer = null;
  preBoundaryTimer = null;
  preBoundaryAuditTimer = null;
  preBoundaryKillTimer = null;
  preBoundaryBundleTimer = null;
  unwatchBlocks = null;
  runtime.running = false;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine paused" });
}

// --- away mode ---------------------------------------------------------------
//
// The engine costs ~22 provider requests/minute while running, but every automatic
// action (proactive pay, JIT, pre-boundary audit) fires only AT an epoch boundary. Away
// mode therefore keeps the engine stopped and wakes it just before each boundary.
//
// Idling costs ZERO requests: boundaries are startTime + N * EPOCH_DURATION, so the next
// one is arithmetic on the wall clock, not a poll. startTime is a contract constant read
// once and cached on runtime.

/** Engine runs this long past the boundary before away mode stops it again — enough for
 *  the boundary tick, the JIT/audit submissions and their receipts to settle. */
const AWAY_STOP_GRACE_MS = 5 * 60_000;

/** Unix seconds of the first epoch boundary strictly after `nowSec`. Pure arithmetic —
 *  independent of runtime.currentEpoch, so it stays correct after a long idle. */
function nextBoundarySec(startTime: bigint, nowSec: bigint): bigint {
  if (nowSec < startTime) return startTime;
  const elapsed = nowSec - startTime;
  return startTime + (elapsed / EPOCH_DURATION_SECONDS + 1n) * EPOCH_DURATION_SECONDS;
}

/** Whether there is anything worth waking up for: an armed JIT payment, or offense. */
function awayHasWork(): boolean {
  const s = runtime.strategy;
  return (s.jitEnabled && s.jitTargetEpoch !== null) || s.offenseEnabled;
}

export function awayNextWake(): number | null {
  return awayNextWakeSec === null ? null : Number(awayNextWakeSec);
}

/**
 * (Re)arm the away-mode wake timer. Safe to call repeatedly — every call clears and
 * recomputes, so a config change or an epoch roll just re-schedules.
 *
 * Needs startTime, which is normally already cached from a previous tick. When it isn't
 * (fresh boot straight into away mode) we pay for exactly ONE snapshot read to learn it,
 * then never poll again.
 */
export function scheduleAwayWake(): void {
  if (awayWakeTimer) { clearTimeout(awayWakeTimer); awayWakeTimer = null; }
  awayNextWakeSec = null;
  runtime.awayNextWakeSec = null;

  const s = runtime.strategy;
  if (!s.awayMode || !runtime.unlocked) { runtime.emitStatus(); return; }
  if (!awayHasWork()) {
    // Nothing armed. Stay dark rather than waking to do nothing; re-arms as soon as JIT
    // is armed or offense is switched on (both call back into here).
    runtime.emitStatus();
    return;
  }

  if (runtime.startTime === null) {
    // One-off read to learn the epoch grid, then schedule offline from here on.
    void getGameSnapshot()
      .then((snap) => {
        runtime.startTime = snap.startTime;
        runtime.currentEpoch = snap.currentEpoch;
        scheduleAwayWake();
      })
      .catch((err) => logger.warn(`away mode: could not read startTime: ${(err as Error).message}`));
    return;
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const boundary = nextBoundarySec(runtime.startTime, nowSec);
  const leadSec = BigInt(Math.max(1, s.awayLeadMinutes)) * 60n;
  const graceSec = BigInt(AWAY_STOP_GRACE_MS / 1000);
  const prevBoundary = boundary - EPOCH_DURATION_SECONDS;

  // Turning away mode ON while the engine is already running (e.g. Arm payment started
  // it) hands the run window over to away mode — otherwise the engine would keep polling
  // forever and away mode would be silently inert.
  if (runtime.running) {
    // Inside a boundary window? Then this IS the window away mode would have created:
    // keep running and just arm the stop. Otherwise idle now and wait for the next one.
    const inLead = nowSec >= boundary - leadSec;
    const inGrace = nowSec <= prevBoundary + graceSec;
    if (inLead || inGrace) {
      awayStartedEngine = true; // away mode now owns this window, so it may end it
      armAwayStop((inGrace ? prevBoundary : boundary) + graceSec, nowSec);
      runtime.emitStatus();
      return;
    }
    activity.add({
      kind: "info",
      status: "info",
      message: "Away mode enabled — going idle until the next boundary window",
    });
    stopEngine();
  }

  let wakeAt = boundary - leadSec;
  // Already inside the lead window (or past the boundary): wake now.
  if (wakeAt <= nowSec) wakeAt = nowSec;
  awayNextWakeSec = wakeAt;
  runtime.awayNextWakeSec = Number(wakeAt);

  const delayMs = Number(wakeAt - nowSec) * 1000;
  awayWakeTimer = setTimeout(() => void awayWake(), Math.min(Math.max(delayMs, 0), 2_000_000_000));
  logger.info(
    `away mode: idle until ${new Date(Number(wakeAt) * 1000).toISOString()} ` +
      `(${(delayMs / 60000).toFixed(1)} min), then running through boundary + ${AWAY_STOP_GRACE_MS / 60000} min`,
  );
  runtime.emitStatus();
}

/** Arm the timer that ends the current away window at `stopAtSec`. */
function armAwayStop(stopAtSec: bigint, nowSec: bigint): void {
  if (awayStopTimer) clearTimeout(awayStopTimer);
  // While the window is open there is no pending wake — the badge should read "running",
  // not count down to a wake that already happened.
  awayNextWakeSec = null;
  runtime.awayNextWakeSec = null;
  const delayMs = Math.max(0, Number(stopAtSec - nowSec) * 1000);
  awayStopTimer = setTimeout(() => awaySleep(), Math.min(delayMs, 2_000_000_000));
  logger.info(`away mode: running until ${new Date(Number(stopAtSec) * 1000).toISOString()}`);
}

/** Start the engine for this boundary and arm the stop that ends the window. */
function awayWake(): void {
  awayWakeTimer = null;
  const s = runtime.strategy;
  if (!s.awayMode || !runtime.unlocked || !awayHasWork()) { scheduleAwayWake(); return; }

  if (!runtime.running) {
    awayStartedEngine = true;
    activity.add({
      kind: "info",
      status: "info",
      message: `Away mode: waking ${s.awayLeadMinutes} min before the epoch boundary`,
    });
    startEngine();
  }

  // Stop once the boundary is `AWAY_STOP_GRACE_MS` behind us. Recomputed from the clock
  // rather than the lead, so a late wake still gets the full post-boundary grace.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const boundary = runtime.startTime !== null ? nextBoundarySec(runtime.startTime, nowSec) : nowSec;
  armAwayStop(boundary + BigInt(AWAY_STOP_GRACE_MS / 1000), nowSec);
}

/** End the away window: stop the engine (only if away mode started it) and re-arm. */
function awaySleep(): void {
  awayStopTimer = null;
  if (!runtime.strategy.awayMode) { awayStartedEngine = false; return; }
  if (runtime.running && awayStartedEngine) {
    activity.add({ kind: "info", status: "info", message: "Away mode: boundary done, going idle" });
    stopEngine();
  }
  awayStartedEngine = false;
  scheduleAwayWake();
}

/** Cancel away timers — used when away mode is switched off. */
export function clearAwayTimers(): void {
  if (awayWakeTimer) { clearTimeout(awayWakeTimer); awayWakeTimer = null; }
  if (awayStopTimer) { clearTimeout(awayStopTimer); awayStopTimer = null; }
  awayNextWakeSec = null;
  runtime.awayNextWakeSec = null;
  awayStartedEngine = false;
  runtime.emitStatus();
}

/** Fire an extra tick precisely at the armed epoch's boundary (near-instant JIT pay). */
export function scheduleJitBoundary(): void {
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.jitEnabled || s.jitTargetEpoch === null || runtime.startTime === null) {
    return;
  }
  // Epoch N begins at startTime + (N-1)*EPOCH_DURATION.
  const boundary = runtime.startTime + BigInt(s.jitTargetEpoch - 1) * EPOCH_DURATION_SECONDS;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaSec = Number(boundary - nowSec);
  if (deltaSec <= 0) {
    void tick();
    return;
  }
  const delayMs = Math.min(deltaSec * 1000 + 500, 2_000_000_000);
  boundaryTimer = setTimeout(() => fireBoundaryTick(false), delayMs);
}

/**
 * ADVANCED (opt-in): arm a pre-submit ~preBoundaryLeadMs BEFORE the armed epoch
 * boundary, so the JIT payment lands in the FIRST block of the epoch (ahead of a
 * batch-auditor) rather than the block after. Requires an off-chain value for the
 * upcoming epoch, validated by simulating AT the boundary timestamp before send.
 */
export function schedulePreBoundaryPay(): void {
  if (preBoundaryTimer) {
    clearTimeout(preBoundaryTimer);
    preBoundaryTimer = null;
  }
  const s = runtime.strategy;
  if (combinedBundleActive(s)) return; // combined fire handles payment + audit together
  if (!runtime.running || !s.preBoundaryPay || !s.jitEnabled || s.jitTargetEpoch === null || runtime.startTime === null) {
    return;
  }
  const boundary = runtime.startTime + BigInt(s.jitTargetEpoch - 1) * EPOCH_DURATION_SECONDS;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(boundary - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) return; // too late to pre-submit; the +500ms JIT tick covers it
  preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(), Math.min(deltaMs, 2_000_000_000));
}

// Fixed gas for a pre-boundary payTaxes — we can't eth_estimateGas it (the value
// is invalid against current state), so pass a generous fixed limit.
const PRE_BOUNDARY_GAS = 120_000n;

/**
 * Queue the pre-boundary JIT payments into the CURRENTLY OPEN batch (caller opened
 * beginBatch and synced the nonce). For each armed token still behind on the target
 * epoch, submit payTaxes with the off-chain value, simulated at the boundary. These
 * are mandatory bundle txs and are mirrored to the mempool (race:true).
 *
 * Returns the token IDs a payment was queued for. The combined fire feeds these to
 * the audit sweep: a token paid EARLIER in the same bundle is current by the time the
 * audit executes, so it can serve as an audit "from" token even though the chain
 * still reads it as behind (see `paidInBundle` in findPreBoundaryAuditors).
 */
async function queuePreBoundaryPayments(address: Address, targetEpoch: bigint, boundaryTs: bigint): Promise<Set<string>> {
  const s = runtime.strategy;
  const paid = new Set<string>();
  const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
  const selected = applyExclusions(
    s.jitTokenIds.length > 0 ? s.jitTokenIds.map((x) => BigInt(x)) : ownedIds,
    "pre-boundary pay",
  );
  if (selected.length === 0) return paid;

  const results = await publicClient.multicall({
    allowFailure: true,
    // auditDueTimestamp rides the SAME multicall as lastEpochPaid, so guarding against
    // an audited citizen costs no extra round-trip in this boundary race.
    contracts: selected.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditDueTimestamp" as const, args: [id] as const },
    ]),
  });
  for (let i = 0; i < selected.length; i++) {
    const r = results[i * 2];
    const due = results[i * 2 + 1];
    if (r?.status !== "success" || due?.status !== "success") continue;
    const lastEpochPaid = r.result as bigint;
    if (lastEpochPaid >= targetEpoch) continue; // already current for the target
    const key = selected[i]!.toString();
    // Never pay a citizen that is already under audit — catching up after an audit is
    // the user's decision alone (manual "Pay to current"), on every path including JIT.
    if ((due.result as bigint) > 0n) {
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        tokenId: key,
        message: `Skip pre-boundary pay #${key}: under audit — automatic payment after an audit is disabled; pay it manually if you want to catch up`,
      });
      continue;
    }
    // JIT always pays exactly one epoch — one day (targetEpoch * base) — which
    // advances the citizen a single epoch regardless of how far behind it is.
    const value = preBoundaryTaxWei(lastEpochPaid, targetEpoch, 1, BASE_TAX_RATE_WEI);
    if (value === 0n) continue;
    const guard = await canSpend(value, false); // enforces max-base-fee, floor, max-payment caps
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer pre-boundary pay #${key}: ${guard.reason}` });
      continue;
    }
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(selected[i]!, 1), value, gas: PRE_BOUNDARY_GAS },
      "pay-taxes",
      { tokenId: key, message: `Pre-boundary pay #${key} for epoch ${targetEpoch} = ${formatEther(value)} ETH (boundary race)`, race: true, simTimestamp: boundaryTs },
    );
    if (res?.ok) paid.add(key);
  }
  return paid;
}

/** Fire the opt-in pre-boundary JIT payment as its own bundle (+ optional coinbase
 *  bid). Used when combinedBoundaryBundle is OFF; the combined fire uses the helper
 *  directly. Best-effort — the ordinary post-boundary JIT tick remains the fallback. */
async function firePreBoundaryPay(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryPay || !s.jitEnabled || s.jitTargetEpoch === null) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryPay(), 150); return; } // don't overlap nonce use
  ticking = true;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const targetEpoch = BigInt(s.jitTargetEpoch);
  const boundaryTs = (runtime.startTime ?? 0n) + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    const paid = await queuePreBoundaryPayments(address, targetEpoch, boundaryTs);
    if (paid.size > 0) await maybeQueueCoinbaseBid();
  } catch (err) {
    logger.error("pre-boundary pay error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary pay error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}

/** Queue the coinbase bid into the open batch if configured. Shared by the payment
 *  and combined fires. No-op unless coinbaseBidEth > 0 and a payer is set. */
/**
 * Drop citizens the user has excluded from ALL automatic payment. Every payment path
 * funnels through here so "unchecked" means the same thing everywhere — defense,
 * proactive-pay and both JIT paths — rather than only scoping a single JIT arm (the
 * behaviour that previously paid a citizen the user had unchecked).
 *
 * A malformed entry is logged once per pass rather than silently ignored: a typo that
 * failed to match would pay a citizen the user meant to abandon.
 */
function applyExclusions(ids: bigint[], context: string): bigint[] {
  const s = runtime.strategy;
  if (s.excludedTokenIds.length === 0) return ids;
  const { set, invalid } = excludedTokenSet(s.excludedTokenIds);
  if (invalid.length > 0) {
    logger.warn(`${context}: ignoring unparseable excluded token id(s): ${invalid.join(", ")}`);
  }
  const kept = ids.filter((id) => !set.has(id.toString()));
  const dropped = ids.length - kept.length;
  if (dropped > 0) {
    logger.debug(`${context}: skipped ${dropped} excluded citizen(s)`);
  }
  return kept;
}

async function maybeQueueCoinbaseBid(): Promise<void> {
  const s = runtime.strategy;
  if (s.coinbaseBidEth <= 0 || !s.coinbasePayerAddress) return;
  const bidWei = parseEther(String(s.coinbaseBidEth));
  const queued = await queueCoinbaseBid(s.coinbasePayerAddress as Address, bidWei);
  if (!queued) return;
  // The bid is real ETH but it does NOT go through act(), so it was invisible to every
  // spend accounting path: "spent this epoch" under-reported it, the cumulative
  // min-balance check for the rest of the tick didn't see it, and the cached balance
  // stayed pre-bid. At one bid per boundary that silently understated spend every day
  // and could let a later payment slip under the floor. Account for it the same way
  // act() does.
  runtime.recordSpend(bidWei);
  committedThisTickWei += bidWei;
  invalidateBalanceCache();
}

/** Whether the combined pay+audit fire should actually fuse the two into one bundle.
 *  It only does so when a coinbase bid will fire: without a bid, the bundle-only
 *  audits have no mempool fallback and can silently fail if the bundle loses the
 *  slot, so we fall back to SEPARATE bundles (where the audit keeps its mirror).
 *  The toggle is thus a no-op — behaviourally identical to separate — until a bid
 *  is set, which makes it safe to leave on by default. */
export function combinedBundleActive(s: StrategyConfig): boolean {
  return s.combinedBoundaryBundle && s.coinbaseBidEth > 0 && !!s.coinbasePayerAddress;
}

// Generous fixed gas for an unsimulated offense pre-submit (real audits used
// ~113–130k on-chain; we can't eth_estimateGas an action that isn't valid yet).
const PRE_BOUNDARY_OFFENSE_GAS = 250_000n;

/**
 * Canonical set of pinned offense target IDs, or null when none are pinned.
 *
 * Membership is tested against a token's `t.tokenId`, which is always the canonical
 * decimal form (`bigint.toString()`) produced by batchGetTargetStatuses. A raw config
 * value that isn't already in that form ("01612", "0x64", " 100 ") would be scanned by
 * fetchOffenseCandidates (which normalizes via BigInt) but then MISS this filter and be
 * silently skipped — the same class of silent-skip bug as the token-1612 miss. Normalize
 * every pin through BigInt so both sides speak the same string. Non-parseable entries are
 * dropped (with a warning) rather than poisoning the whole set.
 */
function pinnedTargetSet(s: StrategyConfig): Set<string> | null {
  if (s.offenseTargetTokenIds.length === 0) return null;
  const out = new Set<string>();
  for (const raw of s.offenseTargetTokenIds) {
    try {
      out.add(BigInt(raw).toString());
    } catch {
      logger.warn(`offense target #${raw} is not a valid token ID; ignoring it`);
    }
  }
  return out;
}

/**
 * Live token IDs an offense sweep should consider, salt-ordered.
 *
 * When a pinned target list (offenseTargetTokenIds) is set, scan EXACTLY those IDs.
 * The full-collection enumeration (fetchCandidateTokenIds) is ID-ordered and capped
 * at appConfig.maxCandidates, so a pinned rival whose ID sits past the cap was being
 * sliced off BEFORE the pinned filter ran — invisible to every offense path even
 * though it showed up in the dashboard (readTargets already unions the pins). Since
 * the list is small and explicit, there's no reason to discover it by paging the
 * whole collection: feed the IDs straight in. With no pins we fall back to the capped
 * enumeration. `filterLiveTokenIds` drops any burned/killed IDs, so stale pins are harmless.
 *
 * Emigrated citizens (owner == the Emigration contract) are dropped here, which is the
 * single chokepoint every offense path shares — offensePass, queuePreBoundaryAudits and
 * firePreBoundaryKill all source their candidates from this function. They're still live
 * ERC-721s so `filterLiveTokenIds` keeps them, but they've left the main game: auditing
 * one burns the 0.00069 ETH fee on a token nobody is defending, for a kill that hands the
 * emigrant exactly the outcome they bought. Pins are filtered too — a pin that emigrates
 * stops being a target rather than silently soaking up auditor slots.
 */
export async function fetchOffenseCandidates(): Promise<{ id: bigint; owner: Address }[]> {
  return (await fetchOffenseCandidatesWithSkips()).candidates;
}

/** `fetchOffenseCandidates` plus the IDs it dropped as emigrated, so a caller can
 *  tell "this pin left the game" apart from "this pin was burned/killed" when
 *  explaining a skip. Same work, one return value richer. */
export async function fetchOffenseCandidatesWithSkips(): Promise<{
  candidates: { id: bigint; owner: Address }[];
  emigrated: Set<string>;
}> {
  const s = runtime.strategy;
  const citizens = runtime.citizensAddress as Address;
  // Drop any non-parseable entries so a single bad pin can't abort the whole sweep.
  const pinnedIds: bigint[] = [];
  for (const raw of s.offenseTargetTokenIds) {
    try {
      pinnedIds.push(BigInt(raw));
    } catch {
      logger.warn(`offense target #${raw} is not a valid token ID; ignoring it`);
    }
  }
  // Pinned mode: the pins ARE the candidate set (bypass the enumeration cap).
  const ids =
    pinnedIds.length > 0
      ? pinnedIds
      : await fetchCandidateTokenIds(citizens);
  const liveRaw = await filterLiveTokenIds(citizens, ids);
  // Allies are never offense candidates. The rival lists shouldn't contain one, but this
  // is the last line of defence: a stale pin, a hand-edited target list or a regenerated
  // skippers file must never get us auditing or killing a teammate's citizen.
  const allySet = new Set(loadAllyTokens().map((x) => BigInt(x).toString()));
  const emigrated = new Set<string>();
  const inGame: { id: bigint; owner: Address }[] = [];
  let allySkipped = 0;
  for (const t of liveRaw) {
    if (isEmigrated(t.owner)) emigrated.add(t.id.toString());
    else if (allySet.has(t.id.toString())) allySkipped++;
    else inGame.push(t);
  }
  if (emigrated.size > 0) {
    logger.debug(
      `offense candidates: skipped ${emigrated.size} emigrated citizen(s) — out of the main game`,
    );
  }
  if (allySkipped > 0) {
    logger.warn(`offense candidates: skipped ${allySkipped} ALLIED citizen(s) — check your target list`);
  }
  return { candidates: orderBySalt(inGame, (t) => t.id.toString(), engineSalt), emigrated };
}

/** Owned tokens usable as audit "from" tokens AT the upcoming epoch: not
 *  auditable at `targetEpoch` (so still current now) and with full capacity
 *  (the new epoch has 0 audits used). One audit per token. */
async function findPreBoundaryAuditors(
  ownedIds: bigint[],
  targetEpoch: bigint,
  paidInBundle: Set<string> = new Set(),
): Promise<{ auditors: bigint[]; needsPayment: Set<string> }> {
  if (ownedIds.length === 0) return { auditors: [], needsPayment: new Set() };
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.flatMap((id) => [
      { ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const },
      { ...gameContract, functionName: "auditLimit" as const, args: [id] as const },
    ]),
  });
  const eligible: bigint[] = [];
  // Auditors that only qualify BECAUSE a payment precedes them in this bundle. The
  // chain still reads them as behind, so their audit can't be simulated (the sim
  // can't see the queued payment) — the caller sends those unsimulated, riding
  // allowed-to-revert so they can never drop the payment.
  const needsPayment = new Set<string>();
  for (let i = 0; i < ownedIds.length; i++) {
    const lep = results[i * 2];
    const limit = results[i * 2 + 1];
    if (lep?.status !== "success" || limit?.status !== "success") continue;
    const limitV = limit.result as bigint;
    const key = ownedIds[i]!.toString();
    // 0n audits used because targetEpoch is a fresh epoch we haven't acted in yet,
    // so remaining capacity == auditLimit. Add one pool entry per available audit
    // so auditor-role tokens (limit > 1) can hit multiple rivals at the boundary.
    let ok = isEligibleAuditor(lep.result as bigint, targetEpoch, 0n, limitV);
    if (!ok && paidInBundle.has(key)) {
      // Paid one epoch earlier in THIS bundle -> current by the time it audits.
      //
      // NOTE: unreachable while JIT sends the flat one-epoch amount. Rescuing a token
      // into eligibility requires it to be 2+ behind at targetEpoch, but on-chain
      // payTaxes(id,1) then costs epochsBehind * epoch * base (verified: a 2-behind
      // token quotes 2x), so preBoundaryTaxWei's 1x underpays and the boundary sim
      // rejects it — such a token never lands in paidInBundle. A token that IS paid
      // successfully was exactly 1 behind, which already passes the check above.
      // Kept because it is the correct rule and activates the moment the pre-boundary
      // payment learns to quote catch-up amounts (which costs 2x, so it is gated on
      // maxAutoPayEpochs by design).
      ok = isEligibleAuditor((lep.result as bigint) + 1n, targetEpoch, 0n, limitV);
      if (ok) needsPayment.add(key);
    }
    if (!ok) continue;
    for (let k = 0n; k < limitV; k++) eligible.push(ownedIds[i]!);
  }
  return { auditors: eligible, needsPayment };
}

/** Arm a pre-submit of audits ~preBoundaryLeadMs before the next epoch boundary. */
export function schedulePreBoundaryAudit(): void {
  if (preBoundaryAuditTimer) {
    clearTimeout(preBoundaryAuditTimer);
    preBoundaryAuditTimer = null;
  }
  const s = runtime.strategy;
  if (combinedBundleActive(s)) return; // combined fire handles payment + audit together
  if (!runtime.running || !s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;
  const boundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS; // starts current+1
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(boundary - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) return; // too late; normal offense picks it up after the roll
  preBoundaryAuditTimer = setTimeout(() => void firePreBoundaryAudit(), Math.min(deltaMs, 2_000_000_000));
}

/** Pre-submit audits (skip-sim) for rivals that will be auditable in the FIRST
 *  block of the upcoming epoch, so we compete with a batch-auditor rather than
 *  landing a block later. Best-effort; normal offensePass remains the fallback. */
/**
 * Queue pre-boundary audits into the CURRENTLY OPEN batch (caller opened beginBatch
 * and synced the nonce). Targets rivals auditable in the first block of `targetEpoch`,
 * one per eligible auditor token. `opts.revertible` marks each audit allowed-to-revert
 * and bundle-only (never mirrored) — used when riding a payment bundle in combined
 * mode so a defended target can never drop the payment. When not revertible (the
 * standalone fire) audits mirror per racePublicMempool. Returns whether any queued.
 */
// Exported for tests: this is the audit-queue unit that a boundary miss like
// token 1612 flows through, so an integration test drives it directly.
export async function queuePreBoundaryAudits(
  address: Address,
  targetEpoch: bigint,
  nowSec: bigint,
  boundaryTs: bigint,
  opts: { revertible: boolean; paidInBundle?: Set<string> },
): Promise<boolean> {
  const s = runtime.strategy;
  const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
  const { auditors, needsPayment } = await findPreBoundaryAuditors(ownedIds, targetEpoch, opts.paidInBundle);

  const { candidates: live, emigrated } = await fetchOffenseCandidatesWithSkips();
  const owned = new Set(ownedIds.map((x) => x.toString()));
  const pinned = pinnedTargetSet(s);
  const statuses = await batchGetTargetStatuses(live, targetEpoch, nowSec);
  // Rivals that will be auditable AT the target epoch (2+ behind) and aren't already
  // under audit — the full set, independent of how many auditor slots we have.
  const auditable = statuses.filter(
    (t) =>
      !owned.has(t.tokenId) &&
      (!pinned || pinned.has(t.tokenId)) &&
      t.auditDueTimestamp === "0" &&
      isAuditable(BigInt(t.lastEpochPaid), targetEpoch),
  );

  // Per-pin diagnostics: when a target list is set, explain any pin that WON'T be
  // audited this fire, so a miss (like token 1612 at epoch 144) is never silent.
  // A pin can drop out for three reasons: it emigrated (left the game — a permanent,
  // expected skip, so say so rather than blaming liveness), it's not in the live status
  // set (burned, killed, or — the old bug — sliced off by the enumeration cap), or it's
  // live but not auditable at targetEpoch (paid up, or already under audit).
  if (pinned) {
    const statusById = new Map(statuses.map((t) => [t.tokenId, t]));
    const reasons: string[] = [];
    for (const id of pinned) {
      if (owned.has(id)) continue; // never audit our own token
      if (emigrated.has(id)) { reasons.push(`#${id}: emigrated (left the main game)`); continue; }
      const t = statusById.get(id);
      if (!t) { reasons.push(`#${id}: not in live set (burned/killed)`); continue; }
      if (t.auditDueTimestamp !== "0") { reasons.push(`#${id}: already under audit`); continue; }
      if (!isAuditable(BigInt(t.lastEpochPaid), targetEpoch)) {
        reasons.push(`#${id}: not auditable (lastEpochPaid=${t.lastEpochPaid}, needs <=${targetEpoch - 2n} at epoch ${targetEpoch})`);
      }
    }
    if (reasons.length > 0) {
      activity.add({
        kind: "info",
        status: "info",
        message: `Pre-boundary audit (epoch ${targetEpoch}): pinned targets skipped — ${reasons.join("; ")}`,
      });
    }
  }

  let idx = 0;
  let queued = 0;
  for (const t of auditable) {
    if (idx >= auditors.length) break; // out of auditor capacity this epoch
    const guard = await canSpend(AUDIT_COST_WEI, true);
    if (!guard.ok) continue;
    const from = auditors[idx]!;
    // An auditor that only qualifies via a payment earlier in THIS bundle can't be
    // simulated: the sim runs the audit alone against pre-payment state and would
    // wrongly revert. Send it unsimulated — it rides allowed-to-revert, so the worst
    // case is gas on a reverted audit and the payment is never endangered.
    const viaBundlePayment = needsPayment.has(from.toString());
    const res = await act(
      { to: appConfig.gameAddress, data: encodeAudit(from, BigInt(t.tokenId)), value: AUDIT_COST_WEI, gas: PRE_BOUNDARY_OFFENSE_GAS },
      "audit",
      {
        tokenId: from.toString(),
        targetTokenId: t.tokenId,
        message:
          `Pre-boundary audit #${t.tokenId} from #${from} for epoch ${targetEpoch}` +
          (viaBundlePayment ? " (auditor paid in this bundle, unsimulated)" : opts.revertible ? " (in payment bundle)" : " (boundary race)"),
        race: true,
        simTimestamp: boundaryTs,
        skipSim: viaBundlePayment,
        revertible: opts.revertible,
      },
    );
    if (res?.ok) { idx++; queued++; }
  }

  // One-line decision summary each fire, so a silent no-op is diagnosable: e.g.
  // "3 auditable target(s), 0 auditor slot(s)" tells you it had targets but no
  // paid-current token to audit from.
  activity.add({
    kind: "info",
    status: "info",
    message: `Pre-boundary audit (epoch ${targetEpoch}): ${auditable.length} auditable target(s), ${auditors.length} auditor slot(s), queued ${queued}`,
  });
  return queued > 0;
}

/** Standalone pre-boundary audit bundle. Used when combinedBoundaryBundle is OFF. */
async function firePreBoundaryAudit(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryAudit(), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const targetEpoch = (runtime.currentEpoch ?? 0n) + 1n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const boundaryTs = (runtime.startTime ?? 0n) + (runtime.currentEpoch ?? 0n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    const queuedAudit = await queuePreBoundaryAudits(address, targetEpoch, nowSec, boundaryTs, { revertible: false });
    // Tail a coinbase bid so the audit bundle wins the slot (no-op unless configured).
    if (queuedAudit) await maybeQueueCoinbaseBid();
  } catch (err) {
    logger.error("pre-boundary audit error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary audit error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}

/**
 * Combined pre-boundary fire (runs when `combinedBundleActive`): payment + audit in
 * ONE atomic bundle from your wallet, so they land consecutively top-of-block and
 * can't demote each other. Payment is mandatory (mirrored). Audits ride
 * allowed-to-revert and bundle-only WHEN a payment shares the bundle (to protect it);
 * when it's audit-only, they instead mirror per racePublicMempool so the bid bids for
 * the slot with the mempool as a fallback. An optional coinbase bid tails the bundle
 * to win the slot. Includes whichever of preBoundaryPay / preBoundaryAudit are enabled
 * (payment-only, audit-only, or both). Fires at the NEXT epoch boundary.
 */
// Exported for tests: this is the atomic pay+audit+bid path, where per-citizen audit
// capacity and the single shared coinbase bid have to hold together.
export async function firePreBoundaryBundle(): Promise<void> {
  const s = runtime.strategy;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return;
  if (ticking) { setTimeout(() => void firePreBoundaryBundle(), 150); return; }
  ticking = true;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const targetEpoch = (runtime.currentEpoch ?? 0n) + 1n; // the boundary we're racing into
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const boundaryTs = (runtime.startTime ?? 0n) + (runtime.currentEpoch ?? 0n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    let paidInBundle = new Set<string>();
    let auditQueued = false;
    // Payment first (lowest nonces): its amount is only valid top-of-block, and a
    // just-paid auditor token is current before it audits. Only if JIT is armed for
    // THIS boundary (jitTargetEpoch === currentEpoch + 1).
    if (s.preBoundaryPay && s.jitEnabled && s.jitTargetEpoch !== null && BigInt(s.jitTargetEpoch) === targetEpoch) {
      paidInBundle = await queuePreBoundaryPayments(address, targetEpoch, boundaryTs);
    }
    // Audits next (higher nonces). They ride allowed-to-revert (bundle-only, no mempool
    // mirror) ONLY when a payment shares the bundle — so a reverting audit can't drop the
    // payment and no extra mempool nonce demotes it. With no payment to protect (audit-only
    // boundary), send them revertible:false so they ALSO mirror to the mempool per
    // racePublicMempool: the bid still bids for the slot, and the mirror is a fallback if
    // the bundle loses it.
    if (
      s.preBoundaryAudit && s.offenseEnabled && s.autoAudit &&
      !(s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin))
    ) {
      auditQueued = await queuePreBoundaryAudits(address, targetEpoch, nowSec, boundaryTs, {
        revertible: paidInBundle.size > 0,
        // Tokens paid above are current by the time the audit executes, so they can
        // serve as audit "from" tokens even though the chain still reads them behind.
        paidInBundle,
      });
    }
    // Coinbase bid tails the bundle to win the slot. This fire only runs when a bid is
    // active (combinedBundleActive), so the audits always have the bid backing them —
    // no-bid falls back to the separate schedulers, where audits keep their mempool mirror.
    if (paidInBundle.size > 0 || auditQueued) await maybeQueueCoinbaseBid();
  } catch (err) {
    logger.error("pre-boundary bundle error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary bundle error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}

/** Arm the combined pre-boundary fire at the next epoch boundary (when enabled). */
export function schedulePreBoundaryBundle(): void {
  if (preBoundaryBundleTimer) {
    clearTimeout(preBoundaryBundleTimer);
    preBoundaryBundleTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !combinedBundleActive(s)) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;
  // Fires only if some pre-boundary action could be due at the next boundary.
  const payDue = s.preBoundaryPay && s.jitEnabled && s.jitTargetEpoch !== null && BigInt(s.jitTargetEpoch) === runtime.currentEpoch + 1n;
  const auditDue = s.preBoundaryAudit && s.offenseEnabled && s.autoAudit;
  if (!payDue && !auditDue) return;
  const boundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS; // starts current+1
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(boundary - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) return;
  preBoundaryBundleTimer = setTimeout(() => void firePreBoundaryBundle(), Math.min(deltaMs, 2_000_000_000));
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
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(nextKillDeadlineSec - nowSec) * 1000 - effectiveLeadMs();
  if (deltaMs <= 0) return; // too late; normal offense kills it right after expiry
  preBoundaryKillTimer = setTimeout(() => void firePreBoundaryKill(), Math.min(deltaMs, 2_000_000_000));
}

/** Pre-submit kills (skip-sim) for targets whose audit is about to expire, so the
 *  kill lands in the first eligible block instead of the one after. */
async function firePreBoundaryKill(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryKill || !s.offenseEnabled || !s.autoKill) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryKill(), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  committedThisTickWei = 0n;
  beginBatch();
  const address = runtime.account.address;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Pre-submit kills for audits expiring within our lead + one slot of headroom.
  const windowSec = BigInt(Math.ceil(effectiveLeadMs() / 1000) + 12);
  let queuedKill = false;
  try {
    await nonceManager.sync(address, appConfig.mode);
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const live = await fetchOffenseCandidates();
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = pinnedTargetSet(s);
    const statuses = await batchGetTargetStatuses(live, runtime.currentEpoch ?? 0n, nowSec);
    for (const t of statuses) {
      if (owned.has(t.tokenId)) continue;
      if (pinned && !pinned.has(t.tokenId)) continue;
      const due = BigInt(t.auditDueTimestamp);
      if (due === 0n || t.killable) continue; // not under audit, or already killable (normal path handles it)
      if (due <= nowSec || due - nowSec > windowSec) continue; // not imminent
      const guard = await canSpend(0n, true);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(BigInt(t.tokenId)), value: 0n, gas: PRE_BOUNDARY_OFFENSE_GAS },
        "kill",
        // Simulate one second past the audit-expiry, where kill() first becomes valid.
        { targetTokenId: t.tokenId, message: `Pre-boundary kill #${t.tokenId} (audit expiring, deadline race)`, race: true, simTimestamp: due + 1n },
      );
      queuedKill = true;
    }
    // Tail a coinbase bid so the kill bundle wins the slot (no-op unless configured).
    if (queuedKill) await maybeQueueCoinbaseBid();
  } catch (err) {
    logger.error("pre-boundary kill error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary kill error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}


// Lead time before the next epoch boundary at which we fire the proactive-pay
// tick, so the tx is built and broadcast right as the new epoch begins instead
// of waiting for the next lazy poll/block tick to notice.
const DEFENSE_LEAD_MS = 1_500;

/**
 * Arm a precise tick at the next epoch boundary to run proactive-pay. Proactive
 * pay never fires from a regular tick — only from this boundary-timed one — so
 * an already-delinquent citizen is left alone until the *next* epoch rolls,
 * then paid as fast as possible rather than instantly on detection.
 */
export function scheduleDefenseBoundary(): void {
  if (defenseBoundaryTimer) {
    clearTimeout(defenseBoundaryTimer);
    defenseBoundaryTimer = null;
  }
  const s = runtime.strategy;
  if (!runtime.running || !s.enabled || !s.proactivePay) return;
  if (runtime.startTime === null || runtime.currentEpoch === null) return;

  // Epoch boundary that starts epoch (current+1) is startTime + current*DURATION.
  const nextEpochBoundary = runtime.startTime + runtime.currentEpoch * EPOCH_DURATION_SECONDS;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deltaMs = Number(nextEpochBoundary - nowSec) * 1000 - DEFENSE_LEAD_MS;
  if (deltaMs <= 0) {
    void tick(true);
    return;
  }
  const delayMs = Math.min(deltaMs, 2_000_000_000);
  defenseBoundaryTimer = setTimeout(() => fireBoundaryTick(true), delayMs);
}

async function refreshSnapshot(address: Address): Promise<void> {
  // Fetch the full latest block (not just its number) so it warms the shared
  // block cache: every canSpend/computeFees later in this tick then reuses it
  // instead of each re-reading the block for the base fee.
  const [snap, balance, latest] = await Promise.all([
    getGameSnapshot(),
    getBalanceCached(address),
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
  schedulePreBoundaryBundle();
  scheduleDefenseBoundary();
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors?
 *  `offense` selects the audit/kill gas profile so the base-fee cap and gas
 *  estimate match what `submitTx` will actually bid. */
async function canSpend(valueWei: bigint, offense: boolean): Promise<{ ok: boolean; reason?: string }> {
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

  const gasWei = GAS_GUESS * (baseFee * 2n + BigInt(Math.round(gas.priorityFeeGwei * 1e9)));

  const bal = runtime.balanceWei ?? 0n;
  const floor = parseEther(String(s.minBalanceEth));
  // Account for spend already committed earlier in this tick — the on-chain
  // balance is read once per tick and doesn't yet reflect those payments, so
  // without this several payments in one tick could cumulatively breach the floor.
  if (!canAffordSpend(bal, committedThisTickWei, valueWei, gasWei, floor)) {
    return { ok: false, reason: "would breach min-balance floor" };
  }

  return { ok: true };
}

// How long to wait for a submitted tx's receipt before giving up. A tx that
// never lands (dropped, replaced, or a bundle that lost) times out and is left
// as "submitted" rather than being force-marked one way or the other.
const RECEIPT_TIMEOUT_MS = 3 * 60_000;

/**
 * Poll for a submitted tx's receipt and flip its activity entry from "submitted"
 * to "included" (mined OK) or "reverted" (mined but failed). Fire-and-forget:
 * never awaited by the tick loop, and swallows errors/timeouts so a stuck poll
 * can't wedge the engine.
 */
/**
 * Poll for `txHash`'s receipt and flip the activity entry submitted -> included/reverted.
 *
 * `broadcast` is false for a bundle-only tx, whose hash we derived locally (keccak of the
 * signed tx) rather than getting back from a broadcast. That hash is still the real one IF
 * the bundle lands — but if no builder wins the slot it never exists on chain, so we only
 * write it onto the entry once a receipt actually comes back. That keeps the "tx ↗" link
 * from ever pointing at a tx that was never mined.
 */
async function trackReceipt(
  entryId: string,
  txHash: `0x${string}`,
  broadcast = true,
): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const block = receipt.blockNumber?.toString();
    activity.update(entryId, {
      status: receipt.status === "success" ? "included" : "reverted",
      targetBlock: block,
      ...(broadcast ? {} : { txHash }),
    });
  } catch (err) {
    // Timed out or RPC error — leave the entry as "submitted".
    logger.warn(`receipt tracking for ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: { tokenId?: string; targetTokenId?: string; message: string; race?: boolean; simTimestamp?: bigint; revertible?: boolean; skipSim?: boolean; normalGas?: boolean },
): Promise<SubmitResult | null> {
  const offense = kind === "audit" || kind === "kill";
  try {
    const result = await submitTx(intent, {
      // In mainnet mode a bundle only lands if a builder we sent it to wins the
      // slot — so PAYMENTS always mirror to the public mempool as a fallback: one
      // that never lands can cost a citizen, and a tax payment isn't meaningfully
      // front-runnable (rivals already see the delinquency on-chain).
      // OFFENSE stays opt-in (racePublicMempool): a visible pending audit lets the
      // target escape by paying first, so privacy is worth something there.
      // A `revertible` tx (an audit riding a payment bundle in combined mode) never
      // mirrors — mirroring would add a second mempool nonce that demotes the
      // payment, and the audit only wants to ride the winning bundle.
      race: ctx.revertible ? false : offense ? (ctx.race && runtime.strategy.racePublicMempool) : true,
      offense,
      simTimestamp: ctx.simTimestamp,
      revertible: ctx.revertible,
      skipSim: ctx.skipSim,
      normalGas: ctx.normalGas,
    });
    if (!result.ok) {
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
    runtime.recordSpend(result.valueWei + result.gasWei);
    // The cached balance now predates a spend — drop it so the next tick's
    // min-balance check reads the real post-spend balance rather than stale headroom.
    invalidateBalanceCache();
    // Count it against this tick's budget so later canSpend checks in the same
    // tick see the reduced headroom.
    committedThisTickWei += result.valueWei + result.gasWei;
    const entry = activity.add({
      kind,
      status: "submitted",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      txHash: result.txHash,
      bundleHash: result.bundleHash,
      targetBlock: result.targetBlock?.toString(),
      valueWei: result.valueWei.toString(),
      gasWei: result.gasWei.toString(),
      message: ctx.message,
    });
    runtime.emitStatus();
    // Queued into a bundle batch (mainnet): the tx isn't sent yet, so its hashes
    // and receipt tracking are reconciled by flushBatch at end of tick.
    if (result.queued) {
      batchEntries.push({ entryId: entry.id, nonce: result.nonce });
      return result;
    }
    // Watch for the receipt so the entry flips submitted -> included/reverted. A pure
    // Flashbots submission has no broadcast txHash, but the hash it will have if it lands
    // is just keccak of the signed tx — poll that so bundle-only sends resolve too.
    if (result.txHash) void trackReceipt(entry.id, result.txHash);
    else if (result.predictedTxHash) void trackReceipt(entry.id, result.predictedTxHash, false);
    return result;
  } catch (err) {
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

// There is deliberately NO defense pass.
//
// The bot takes ZERO automatic action once one of your citizens is audited — it will not
// pay taxes to clear the audit, and it will not spend a held bribe. Recovering an audited
// citizen is entirely the user's decision, via the manual "Pay to current" / "Clear audit
// (bribe)" buttons on the token row (see manualPayToCurrent / manualUseBribe).
//
// What remains automatic is only PRE-audit protection: proactivePayPass and the JIT
// payment keep a citizen current so it never becomes auditable in the first place. Both
// skip any citizen that is already under audit, and both honour `excludedTokenIds`.
//
// Consequence, stated plainly: an audited citizen you do not pay yourself will be
// killable when its 24h audit expires, and nothing here will stop that.

/**
 * Pay delinquent-but-not-yet-audited citizens. Only invoked from the
 * boundary-timed tick armed by `scheduleDefenseBoundary` (see DEFENSE_LEAD_MS),
 * never from a regular poll/block tick — so a citizen that's already delinquent
 * is left alone until the next epoch boundary, then paid immediately.
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
  const payable = applyExclusions(ownedIds, "proactive pay");
  if (payable.length === 0) return;
  const statuses = await batchGetOwnedStatuses(payable, currentEpoch, nowSec, epochs);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    if (proactivePaySubmitted.has(key)) continue;

    const underAudit = st.auditDueTimestamp !== "0";
    if (underAudit || st.risk !== "delinquent") continue;

    const value = BigInt(st.estimatedPayWei); // estimate for `epochs` (capped)
    if (value === 0n) continue;
    // Auto-Pay Limit as a SPEND cap: the contract force-settles every delinquent epoch,
    // so a token N behind is quoted Nx even at n=1 and cannot be partially paid.
    if (!withinAutoPayCap(value, s.maxAutoPayEpochs, currentEpoch, BASE_TAX_RATE_WEI)) {
      const cap = autoPayCapWei(s.maxAutoPayEpochs, currentEpoch, BASE_TAX_RATE_WEI);
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        tokenId: st.tokenId,
        message:
          `Skip proactive pay #${st.tokenId}: ${formatEther(value)} ETH exceeds Auto-Pay Limit ` +
          `(${s.maxAutoPayEpochs} epoch = ${formatEther(cap)} ETH) — token is ${Number(currentEpoch - BigInt(st.lastEpochPaid))} epoch(s) behind and stays delinquent`,
      });
      continue;
    }
    const guard = await canSpend(value, false);
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer proactive pay #${st.tokenId}: ${guard.reason}` });
      continue;
    }
    proactivePaySubmitted.add(key); // mark before awaiting so a rapid re-fire can't double-submit
    await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, epochs), value },
      "pay-taxes",
      { tokenId: st.tokenId, message: `Proactive pay #${st.tokenId} (${epochs} epoch) = ${formatEther(value)} ETH` },
    );
  }
}

/**
 * Just-in-time single-epoch payment. When armed for a target epoch, pays exactly
 * one epoch for each selected token the moment the chain reaches that epoch, then
 * auto-disarms. Reads the exact owed amount on-chain so the value is always correct.
 */
// Exported for tests: "never auto-pay an audited citizen" has to hold on the JIT path,
// since that is the path that pays a CHECKED citizen.
export async function jitPass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.jitEnabled || s.jitTargetEpoch === null) return;
  const target = s.jitTargetEpoch;
  if (Number(currentEpoch) < target) return; // target epoch hasn't begun yet

  // Reset bookkeeping if the target changed.
  if (jitSubmittedTarget !== target) {
    jitSubmitted = new Set();
    jitSubmittedTarget = target;
  }

  const selected = applyExclusions(
    s.jitTokenIds.length > 0 ? s.jitTokenIds.map((x) => BigInt(x)) : ownedIds,
    "JIT pay",
  );
  if (selected.length === 0) return; // nothing owned yet — stay armed

  const statuses = await batchGetOwnedStatuses(selected, currentEpoch, nowSec, 1);
  for (const st of statuses) {
    const tokenId = BigInt(st.tokenId);
    const key = st.tokenId;
    if (jitSubmitted.has(key)) continue;

    if (BigInt(st.lastEpochPaid) >= currentEpoch) {
      jitSubmitted.add(key); // already current for this epoch
      continue;
    }
    // Never pay a citizen that is already under audit — on ANY path. Recovering an
    // audited citizen is a deliberate user action (manual "Pay to current"), so mark it
    // handled and leave it alone rather than retrying every tick.
    if (st.auditDueTimestamp !== "0") {
      jitSubmitted.add(key);
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        tokenId: key,
        message: `Skip JIT pay #${key}: under audit — automatic payment after an audit is disabled; pay it manually if you want to catch up`,
      });
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
    const guard = await canSpend(value, false);
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer JIT pay #${key}: ${guard.reason}` });
      continue; // retry next tick — do not mark submitted
    }
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, 1), value },
      "pay-taxes",
      { tokenId: key, message: `JIT pay #${key} for epoch ${currentEpoch} = ${formatEther(value)} ETH` },
    );
    // Only a SUCCESSFUL submission counts as covered. act() returns the failed result
    // object (truthy) when submission/simulation fails, so `if (res)` marked a citizen
    // done even though nothing was sent — and because the disarm below fires once every
    // selected token is marked, one failure ended the whole JIT session with that
    // citizen unpaid and no retry. With several citizens that silently loses one of
    // them. A pre-submission failure consumes no nonce and no gas, so retrying next
    // tick is free and matches the canSpend guard above ("do not mark submitted").
    if (res?.ok) jitSubmitted.add(key);
  }

  // One-shot: disarm once every selected token has actually been paid/covered.
  if (selected.every((t) => jitSubmitted.has(t.toString()))) {
    runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
    activity.add({ kind: "info", status: "info", message: `JIT payment complete for epoch ${target}; disarmed.` });
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

  const live = await fetchOffenseCandidates();
  const owned = new Set(ownedIds.map((x) => x.toString()));
  const pinned = pinnedTargetSet(s);

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
  const [auditors, statuses] = await Promise.all([
    findEligibleAuditors(ownedIds, currentEpoch),
    batchGetTargetStatuses(candidates, currentEpoch, nowSec),
  ]);
  let auditorIdx = 0;
  let noAuditorSkips = 0;

  // Track the soonest not-yet-expired audit deadline so the boundary scheduler
  // can pre-empt the exact moment a kill becomes valid. Reset each sweep.
  let soonestKillDeadline: bigint | null = null;

  for (const t of statuses) {
    const tokenId = BigInt(t.tokenId);

    // Note the nearest future kill deadline (token under audit, not yet expired).
    const due = BigInt(t.auditDueTimestamp);
    if (due > nowSec && (soonestKillDeadline === null || due < soonestKillDeadline)) {
      soonestKillDeadline = due;
    }

    if (s.autoKill && t.killable) {
      const guard = await canSpend(0n, true);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(tokenId), value: 0n },
        "kill",
        { targetTokenId: t.tokenId, message: `Kill expired-audit #${t.tokenId}`, race: true },
      );
      continue;
    }

    if (s.autoAudit && t.auditable) {
      if (auditorIdx >= auditors.length) { noAuditorSkips++; continue; } // out of usable auditor tokens
      const guard = await canSpend(AUDIT_COST_WEI, true);
      if (!guard.ok) continue;
      const auditFrom = auditors[auditorIdx]!;
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(auditFrom, tokenId), value: AUDIT_COST_WEI },
        "audit",
        { tokenId: auditFrom.toString(), targetTokenId: t.tokenId, message: `Audit delinquent #${t.tokenId} from #${auditFrom}`, race: true },
      );
      if (res?.ok) auditorIdx++; // consume this auditor only if the audit actually went out
    }
  }

  if (noAuditorSkips > 0) {
    activity.add({
      kind: "info",
      status: "info",
      message: `Audited ${auditorIdx} rival(s) this sweep; ${noAuditorSkips} more auditable but no eligible auditor token left (each audits up to its per-epoch limit).`,
    });
  }

  // Publish the nearest kill deadline and (re)arm the pre-emptive kill tick.
  nextKillDeadlineSec = soonestKillDeadline;
  schedulePreBoundaryKill();
}

// --- manual, user-initiated token actions (dashboard buttons) ---

export interface ManualActionResult {
  ok: boolean;
  message: string;
  txHash?: string;
  valueWei?: string;
}

/** Wait out an in-flight tick so a manual tx can't collide with the tick's nonce
 *  reservation / open bundle. Resolves false if the tick never clears in time. */
async function waitForIdle(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ticking) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/**
 * Run a single user-initiated tx outside the tick loop, priced with NORMAL network
 * gas (see normalFees) rather than the configured race tips. These bypass the
 * automatic-payment guardrails on purpose — `maxAutoPayEpochs` and the base-fee cap
 * exist to bound what the bot does on its own, and the user pressing a button IS the
 * decision. The min-balance floor is still honoured so a manual action can't empty
 * the wallet.
 */
async function runManualAction(
  tokenId: bigint,
  kind: "pay-taxes" | "use-bribe",
  build: () => Promise<{ intent: TxIntent; message: string } | { error: string }>,
): Promise<ManualActionResult> {
  if (!runtime.unlocked || !runtime.account) return { ok: false, message: "Unlock the wallet first" };
  if (runtime.gameState !== 1) return { ok: false, message: "Game is not live" };
  if (!(await waitForIdle())) return { ok: false, message: "Bot is busy submitting; try again in a moment" };

  const address = runtime.account.address;
  ticking = true;
  committedThisTickWei = 0n;
  beginBatch();
  try {
    await Promise.all([refreshSnapshot(address), nonceManager.sync(address, appConfig.mode)]);
    const built = await build();
    if ("error" in built) return { ok: false, message: built.error };

    // Min-balance floor still applies (gas is estimated generously here).
    const bal = runtime.balanceWei ?? 0n;
    const floor = parseEther(String(runtime.strategy.minBalanceEth));
    const latest = await getLatestBlockCached();
    const gasWei = GAS_GUESS * ((latest.baseFeePerGas ?? 0n) * 2n + 2_000_000_000n);
    if (!canAffordSpend(bal, 0n, built.intent.value, gasWei, floor)) {
      return { ok: false, message: `Would breach the ${runtime.strategy.minBalanceEth} ETH min-balance floor` };
    }

    const res = await act(built.intent, kind, {
      tokenId: tokenId.toString(),
      message: built.message,
      race: true, // mirror to the mempool so a manual action lands even if no builder wins
      normalGas: true,
    });
    if (!res?.ok) return { ok: false, message: res?.error ?? "Transaction failed to submit" };
    return {
      ok: true,
      message: built.message,
      txHash: res.txHash,
      valueWei: res.valueWei.toString(),
    };
  } catch (err) {
    const message = (err as Error).message;
    activity.add({ kind: "error", status: "skipped", tokenId: tokenId.toString(), message: `Manual ${kind} #${tokenId} failed: ${message}` });
    return { ok: false, message };
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}

/**
 * Pay a token's full outstanding tax so it becomes current (and any active audit is
 * cleared). Quotes on-chain with numEpochs=1, which force-settles every delinquent
 * epoch — so a token N behind costs N x the current epoch rate. Deliberately NOT
 * subject to the Auto-Pay Limit: that cap governs automatic payments only.
 */
export async function manualPayToCurrent(tokenId: bigint): Promise<ManualActionResult> {
  return runManualAction(tokenId, "pay-taxes", async () => {
    const value = await estimateTaxes(tokenId, 1);
    if (value === 0n) return { error: `#${tokenId} is already current — nothing to pay` };
    return {
      intent: { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, 1), value },
      message: `Manual pay #${tokenId} to current = ${formatEther(value)} ETH (normal gas)`,
    };
  });
}

/**
 * Spend one of a token's bribes to clear its active audit. NOTE: a bribe clears the
 * AUDIT only — it does not pay tax, so the token stays delinquent and can be audited
 * again immediately. Use `manualPayToCurrent` to actually become current.
 */
export async function manualUseBribe(tokenId: bigint): Promise<ManualActionResult> {
  return runManualAction(tokenId, "use-bribe", async () => {
    const [status] = await batchGetOwnedStatuses(
      [tokenId],
      runtime.currentEpoch ?? 0n,
      BigInt(Math.floor(Date.now() / 1000)),
      1,
    );
    if (!status) return { error: `Could not read #${tokenId}` };
    if (BigInt(status.bribeBalance) === 0n) return { error: `#${tokenId} has no bribes to spend` };
    if (status.auditDueTimestamp === "0") return { error: `#${tokenId} is not under audit` };
    return {
      intent: { to: appConfig.gameAddress, data: encodeUseBribe(tokenId), value: 0n },
      message: `Manual bribe clear of audit on #${tokenId} (still delinquent afterwards, normal gas)`,
    };
  });
}

// `fireProactivePay` is true only for the tick armed by scheduleDefenseBoundary
// at the next epoch boundary — every other tick (block watch, poll, JIT/offense
// boundary ticks) leaves already-delinquent citizens alone.
async function tick(fireProactivePay = false): Promise<void> {
  if (ticking) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  ticking = true;
  committedThisTickWei = 0n; // fresh spend budget for this tick
  beginBatch();
  const address = runtime.account.address;
  try {
    // Snapshot + nonce sync are independent RPC reads — run them together so the
    // boundary tick shaves a round-trip before it can submit anything.
    await Promise.all([
      refreshSnapshot(address),
      nonceManager.sync(address, appConfig.mode),
    ]);

    if (runtime.gameState !== 1) {
      // Not LIVE — nothing to do.
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const currentEpoch = runtime.currentEpoch ?? 0n;

    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);

    if (runtime.strategy.enabled) {
      // No defense pass: an audited citizen gets no automatic response at all. Only
      // pre-audit protection runs here (see the note above proactivePayPass).
      if (fireProactivePay && runtime.strategy.proactivePay) {
        await proactivePayPass(ownedIds, currentEpoch, nowSec);
      }
      await jitPass(ownedIds, currentEpoch, nowSec);
    }
    await offensePass(ownedIds, currentEpoch, nowSec);
  } catch (err) {
    logger.error("tick error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Tick error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonceManager.reset();
    ticking = false;
  }
}
