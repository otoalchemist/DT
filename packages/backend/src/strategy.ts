import { parseEther, formatEther, type Address } from "viem";
import { AUDIT_COST_WEI, WINNERS, EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI, isEmigrated, type StrategyConfig } from "@dat-bot/shared";
import { publicClient, wsClient, getLatestBlockCached, primeBlockCache, getBalanceCached, invalidateBalanceCache } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime, loadAllyTokens, type Wallet } from "./runtime.js";
import { activity } from "./activity.js";
import { nonces } from "./nonce.js";
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
import { emigratedTokenIdSet } from "./emigration.js";
import { submitTx, beginBundle, flushBundle, queueCoinbaseBid, setRaceBoundary, setRaceLookBack, type TxIntent, type SubmitResult } from "./flashbots.js";
import { resolveGas, canAffordSpend, isEligibleAuditor, isAuditable, preBoundaryTaxWei, cappedAutoPayEpochs, autoPayCapWei, withinAutoPayCap, excludedTokenSet, orderBySalt } from "./logic.js";
import { logger } from "./logger.js";
import { recordRaceOutcome } from "./race-timing.js";

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
/**
 * WHICH work holds `ticking`, in words fit for an activity entry.
 *
 * Exists because the delay warning was blaming the wrong thing. The audit fire ALWAYS waits
 * behind the payment fire on a boundary where a payment is due — that is the architecture,
 * not a fault: the audit needs the paid-in-bundle credit the payment fire produces, and a
 * lower nonce is what makes crediting it safe. Reporting that expected wait as "a routine
 * tick held the engine" sent an operator hunting for tick duration when nothing was wrong
 * with the tick at all.
 */
let tickingOwner: string | null = null;
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
// Keyed by lowercased wallet address: each wallet pays its own gas from its own balance,
// so one wallet's spending must not consume another's headroom.
let committedThisTickWei = new Map<string, bigint>();
const committedFor = (addr: string): bigint => committedThisTickWei.get(addr.toLowerCase()) ?? 0n;
const commitFor = (addr: string, wei: bigint): void => {
  const k = addr.toLowerCase();
  committedThisTickWei.set(k, (committedThisTickWei.get(k) ?? 0n) + wei);
};

/**
 * Which wallet holds each owned citizen, refreshed every time owned tokens are fetched.
 *
 * payTaxes / audit / useBribe are owner-only on-chain (confirmed by simulating each from
 * a funded non-owner: all revert, while the same call from the owner succeeds), so an
 * action has to be signed by the wallet that holds the citizen involved. Signing with the
 * wrong wallet doesn't fail loudly — it reverts on-chain after burning the gas and losing
 * the boundary race — so routing is resolved here, once, rather than at each call site.
 */
let ownedBy = new Map<string, Wallet>();

/** The wallet holding `tokenId`, or null if none of ours does. */
function walletForToken(tokenId: bigint | string): Wallet | null {
  return ownedBy.get(tokenId.toString()) ?? null;
}

/**
 * Owned citizens across EVERY unlocked wallet, and the wallet holding each.
 *
 * Replaces the single `fetchOwnedTokenIds(citizens, address)`: with several wallets the
 * owned set is their union, and every downstream pass needs to know which wallet a token
 * came from in order to sign for it.
 */
// Exported for tests: it is what populates `ownedBy`, and every owner-only path fails
// closed without it — so a test that submits for an owned token has to prime it the same
// way tick() does, rather than assuming a wallet.
export async function fetchOwnedAcrossWallets(citizens: Address): Promise<bigint[]> {
  const [per, emigrated] = await Promise.all([
    Promise.all(
      runtime.wallets.map(async (w) => ({
        w,
        ids: await fetchOwnedTokenIds(citizens, w.account.address as Address),
      })),
    ),
    // Cheap: cached and stale-while-revalidate, so this is a Map read on almost every tick.
    emigratedTokenIdSet(),
  ]);
  const next = new Map<string, Wallet>();
  const ids: bigint[] = [];
  const dropped: string[] = [];
  for (const { w, ids: list } of per) {
    for (const id of list) {
      const key = id.toString();
      // A token can only be in one wallet; if the index is momentarily stale during a
      // transfer, first-seen wins rather than the entry silently flipping mid-tick.
      if (next.has(key)) continue;
      /**
       * An emigrated citizen leaves the owned set entirely: it is out of the main game, so
       * it owes no tax and can serve as no auditor. Keeping it meant the payment paths saw
       * a citizen that could never be current (payTaxes on a burned token reverts) and the
       * auditor pool offered a "from" token the game would reject.
       *
       * It can still show up here at all because ownership comes from the NFT owner INDEX,
       * which lags the chain — emigrating transfers the citizen away, but the index serves
       * the old answer for a while. The event roster is authoritative and immediate.
       */
      if (emigrated.has(key)) {
        dropped.push(key);
        continue;
      }
      next.set(key, w);
      ids.push(id);
    }
  }
  // Once per changed set, not once per tick: this fires on every sweep and would otherwise
  // bury the log. Worth saying at all because "my citizen vanished from the bot" needs an
  // explanation that names the reason.
  const fingerprint = dropped.join(",");
  if (dropped.length > 0 && fingerprint !== reportedEmigrantDrop) {
    activity.add({
      kind: "info",
      status: "info",
      message:
        `Excluded ${dropped.length} emigrated citizen(s) from the owned list: #${dropped.join(", #")}. ` +
        `They have left the main game (Governor/ABBC), so they owe no tax and cannot audit.`,
    });
  }
  reportedEmigrantDrop = fingerprint;
  ownedBy = next;
  return ids;
}

/** Fingerprint of the last emigrant set reported, so the notice is per-change not per-tick. */
let reportedEmigrantDrop = "";

/** Forget which emigrant set was last reported, so the next sweep announces it again.
 *  For tests — this is module state that otherwise leaks across cases in file order. */
export function resetOwnedEmigrantNotice(): void {
  reportedEmigrantDrop = "";
}

// Activity entries whose tx was queued into the current bundle batch (mainnet).
// flushBatch fills in each one's txHash/bundleHash and starts receipt tracking
// once the whole tick's txs are sent together as one atomic bundle.
let batchEntries: { entryId: string; nonce: number; address: Address }[] = [];

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
  for (const { entryId, nonce, address } of entries) {
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
    const dead = { address, nonce };
    if (r.txHash) void trackReceipt(entryId, r.txHash, true, dead);
    else if (r.predictedTxHash) void trackReceipt(entryId, r.predictedTxHash, false, dead);
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

/** Clear the per-tick spend budget. Every entry point that can reach act() already does
 *  this on the way in (firePreBoundaryPay/Audit/Bundle/Kill, runManualAction, tick), which
 *  is what stops committed spend accumulating across ticks and eventually blocking all
 *  spending. Exported so a test calling a pass directly can stand in for its caller. */
export function resetTickBudget(): void {
  committedThisTickWei = new Map();
}

/** Clear defense-mode bookkeeping. Deliberately NOT called from stopEngine: away mode
 *  stops the engine every epoch, and forgetting a submitted-but-not-yet-mined payment
 *  across that gap would pay the same audit twice. Entries expire on their own once the
 *  audit clears (see the prune in maybeAutoDefendAudit). Exported for tests. */
export function resetDefenseState(): void {
  defendSubmitted = new Set();
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
        void tick(false, true);
      },
      onError: (err) => logger.warn("Block subscription error:", (err as Error).message),
    });
    activity.add({ kind: "info", status: "info", message: "Block subscription active (WebSocket)" });
  } else {
    // Fallback: poll every 12s if no WebSocket URL is configured.
    timer = setInterval(() => void tick(false, true), TICK_MS);
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

/**
 * How long before a boundary the mid-epoch sweep stops using cheap gas.
 *
 * Not about the sweep's own inclusion — it's about the nonce. Sweep audits sign from the
 * same wallets the boundary payment does, and nonces are consumed in order: a cheap audit
 * still pending when the boundary fires holds a nonce the payment sits behind, and no tip
 * on the payment can jump it. Three minutes is ~15 blocks, far more than a
 * suggestion-plus-1-gwei tx needs, and costs at most a handful of race-priced audits per
 * epoch (the boundary path is what audits at a boundary anyway).
 */
const SWEEP_QUIET_WINDOW_SECONDS = 180n;

/**
 * How late a fire may be and still be racing the boundary it was armed for.
 *
 * The pre-boundary fires contend for one tick lock and retry every 150ms, so an audit fire
 * routinely starts after the payment fire has finished — and sometimes after the boundary has
 * passed. Two minutes is generous: past that the race is lost regardless, and what matters is
 * that we do not silently switch to racing TOMORROW's boundary.
 */
const RACE_GRACE_SECONDS = 120n;

/**
 * The boundary this fire is racing, derived from the CLOCK rather than from runtime.currentEpoch.
 *
 * currentEpoch is refreshed by ticks, so reading it after a delay gives the epoch we are now IN
 * rather than the one we were armed for — and `currentEpoch + 1` then points a full day ahead.
 * That was survivable until minTimestamp: a bundle stamped with tomorrow's boundary cannot be
 * included in any block of this window, so every audit died silently while payments (which pin
 * the armed epoch) landed. This is the same class of bug fixed for the combined fire in 5c92ffc;
 * the standalone audit path was left re-deriving.
 *
 * Just past a boundary we are still racing THAT boundary, not the next one — hence the grace.
 */
function racedBoundary(startTime: bigint, nowSec: bigint, currentEpoch: bigint | null): { targetEpoch: bigint; boundaryTs: bigint } {
  // No epoch known yet (pre-first-snapshot): fall back to the clock grid alone.
  if (currentEpoch === null) {
    const next = nextBoundarySec(startTime, nowSec);
    const previous = next - EPOCH_DURATION_SECONDS;
    const boundaryTs = nowSec >= previous && nowSec - previous <= RACE_GRACE_SECONDS ? previous : next;
    return { targetEpoch: (boundaryTs - startTime) / EPOCH_DURATION_SECONDS + 1n, boundaryTs };
  }
  // Epoch N begins at startTime + (N-1)*EPOCH, so this is the boundary that STARTED the epoch
  // we are in, and the next one is a day later.
  const startedThisEpoch = startTime + (currentEpoch - 1n) * EPOCH_DURATION_SECONDS;
  const nextBoundary = startTime + currentEpoch * EPOCH_DURATION_SECONDS;
  // Just past the boundary that started this epoch? Then that is the race we are in — the fire
  // was armed before it and only ran after, which is the normal consequence of waiting behind
  // the payment fire's tick lock. Anything else is racing the next one.
  const justRolled = nowSec >= startedThisEpoch && nowSec - startedThisEpoch <= RACE_GRACE_SECONDS;
  return justRolled
    ? { targetEpoch: currentEpoch, boundaryTs: startedThisEpoch }
    : { targetEpoch: currentEpoch + 1n, boundaryTs: nextBoundary };
}


/**
 * Is the epoch a JIT arm names already OVER? Answered from the CLOCK when it can be,
 * because that works when `runtime.currentEpoch` is still null.
 *
 * That null case is the dangerous one, and it is exactly the start/unlock path: the
 * strategy — including a persisted arm — is loaded from data/config.json before any chain
 * read, so for the first moments of a run the bot knows what it is armed for but not what
 * epoch it is. A guard written only as `target < runtime.currentEpoch` silently passes
 * there, which is how a four-day-old arm could still reach a scheduler.
 *
 * Epoch N runs from startTime + (N-1)*EPOCH to startTime + N*EPOCH, so the armed epoch is
 * over once now >= startTime + N*EPOCH.
 *
 * `currentEpoch` is checked FIRST when it is known, because it comes from the chain and the
 * clock does not: a wrong local clock, or a startTime that has not been read yet, must never
 * be able to retire a live arm. The clock is strictly the fallback for the boot window.
 * Answers `false` when neither is available — nothing may be expired on a guess, since
 * wrongly dropping a live arm skips a payment the user asked for.
 */
function armedEpochIsOver(targetEpoch: number, nowSec = BigInt(Math.floor(Date.now() / 1000))): boolean {
  if (runtime.currentEpoch !== null) return BigInt(targetEpoch) < runtime.currentEpoch;
  if (runtime.startTime !== null) {
    return nowSec >= runtime.startTime + BigInt(targetEpoch) * EPOCH_DURATION_SECONDS;
  }
  return false;
}

/**
 * Whether there is anything worth waking up for.
 *
 * This must mirror what a RUNNING engine would actually do at a boundary (see tick()),
 * or away mode silently disables work the user still has switched on. The three boundary
 * actions and their gates:
 *   - proactive pay  : enabled && proactivePay      (pre-audit defense of owned citizens)
 *   - JIT payment    : enabled && jitEnabled && a target epoch
 *   - offense        : offenseEnabled
 * `enabled` stays true after a JIT arm is released, which is deliberate: proactive pay is
 * the standing defense and should keep waking us even with nothing else armed.
 */
function awayHasWork(): boolean {
  const s = runtime.strategy;
  const jitArmed = s.enabled && s.jitEnabled && s.jitTargetEpoch !== null;
  const proactive = s.enabled && s.proactivePay;
  return jitArmed || proactive || s.offenseEnabled;
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
        // Clears a dead arm as a side effect: without that, awayHasWork() above keeps
        // seeing it and away mode wakes the engine every boundary for impossible work.
        runtime.applyChainSnapshot(snap);
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
    // Spell out the autonomy, and the bid it will spend to get it. Away mode now arms
    // payments by itself, so someone who only ever wanted "idle between epochs" would
    // otherwise be opted into unattended spending without being told.
    const bid = runtime.strategy.coinbaseBidEth;
    activity.add({
      kind: "info",
      status: "info",
      message:
        "Away/Autonomous mode enabled — going idle until the next boundary window. It will " +
        "arm payments itself when a citizen falls behind" +
        (bid > 0 ? `, bidding up to ${bid} ETH to the builder without a keypress.` : "."),
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

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const graceSec = BigInt(AWAY_STOP_GRACE_MS / 1000);
  const leadSec = BigInt(Math.max(1, s.awayLeadMinutes)) * 60n;
  const boundary = runtime.startTime !== null ? nextBoundarySec(runtime.startTime, nowSec) : nowSec;
  const prevBoundary = boundary - EPOCH_DURATION_SECONDS;

  // A wake can fire LATE: a suspended machine runs no timers, so by the time the event
  // loop resumes the boundary this wake was armed for may already be behind us. Decide
  // which window we are actually in before arming the stop — nextBoundarySec(now) rolls
  // to TOMORROW's boundary the moment `now` passes one, so using it unconditionally
  // would hold the engine open for a full epoch at ~22 req/min.
  let stopAt: bigint;
  if (nowSec <= prevBoundary + graceSec) {
    // Late, but still inside the window the previous boundary opened — honour what's
    // left of it (a JIT payment for that epoch can still land) and close on schedule.
    stopAt = prevBoundary + graceSec;
  } else if (nowSec >= boundary - leadSec) {
    // The normal case: we are in the lead-up to the next boundary.
    stopAt = boundary + graceSec;
  } else {
    // Too late to be useful and too early for the next boundary. Idling is the whole
    // point of away mode, so go back to sleep instead of running until tomorrow.
    logger.warn(
      `away mode: wake fired ${((Number(nowSec - prevBoundary)) / 60).toFixed(1)} min after the ` +
        `boundary, past the ${AWAY_STOP_GRACE_MS / 60000} min window — idling until the next one`,
    );
    activity.add({
      kind: "info",
      status: "info",
      message: "Away mode: missed the boundary window (machine asleep?) — idling until the next epoch",
    });
    awaySleep();
    return;
  }

  if (!runtime.running) {
    awayStartedEngine = true;
    activity.add({
      kind: "info",
      status: "info",
      message: `Away mode: waking ${s.awayLeadMinutes} min before the epoch boundary`,
    });
    startEngine();
  }
  armAwayStop(stopAt, nowSec);
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

/**
 * Report a pre-boundary race we never got to arm.
 *
 * Every pre-boundary scheduler bails with `deltaMs <= 0` when it runs inside (or past)
 * the lead window, and it used to do so silently — so an engine that started a few
 * seconds too late, or a machine that suspended across the boundary, simply produced no
 * race and no explanation. That is the single hardest failure to diagnose from the
 * activity log, because nothing appears in it at all.
 *
 * Only warns when we never ARMED a timer for that boundary. These schedulers re-run on
 * every tick, so the last few seconds before a boundary legitimately hit the same branch
 * after the race had already fired — warning on that would cry wolf every 12s and after
 * every successful race.
 */
const armedRaceFor = new Map<string, bigint>();
function noteRaceArmed(kind: string, targetEpoch: bigint): void {
  armedRaceFor.set(kind, targetEpoch);
}
function warnRaceMissed(kind: string, targetEpoch: bigint, boundarySec: bigint): void {
  if (armedRaceFor.get(kind) === targetEpoch) return; // armed in time; this call is just a later tick
  armedRaceFor.set(kind, targetEpoch); // report once per boundary, not once per tick
  const lateSec = Number(BigInt(Math.floor(Date.now() / 1000)) - boundarySec);
  const where = lateSec >= 0
    ? `the boundary passed ${lateSec}s ago`
    : `only ${-lateSec}s of the ${(effectiveLeadMs() / 1000).toFixed(1)}s lead remained`;
  const msg =
    `Missed the epoch ${targetEpoch} pre-boundary ${kind} race — ${where} when the engine ` +
    `armed, so nothing was pre-submitted. Usually means the engine started late or the ` +
    `machine was asleep through the window.`;
  logger.warn(msg);
  activity.add({ kind: "info", status: "info", message: msg });
}

/**
 * The boundary an armed pre-boundary fire is racing into, or null when nothing is armed.
 *
 * Keyed off the ARMED epoch rather than `currentEpoch + 1`, for the same reason the fire
 * itself is: once the boundary passes, `currentEpoch + 1` points at the epoch AFTER the one
 * we were racing into, so it can no longer tell us whether we are late.
 */
function boundaryForArmedFire(): bigint | null {
  const s = runtime.strategy;
  if (runtime.startTime === null) return null;
  const epoch =
    s.jitEnabled && s.jitTargetEpoch !== null
      ? BigInt(s.jitTargetEpoch)
      : runtime.currentEpoch !== null
        ? runtime.currentEpoch + 1n
        : null;
  if (epoch === null) return null;
  return runtime.startTime + (epoch - 1n) * EPOCH_DURATION_SECONDS;
}

/**
 * How long before an armed pre-boundary fire routine ticks stop taking the lock, and how
 * long after the boundary they stay out.
 *
 * BEFORE is a full slot, not a token margin, and that sizing is the whole point. The tick
 * that costs a race does not START inside the lead — it starts on the block BEFORE and runs
 * into it. Measured on the epoch-174 boundary: the fire was due at :30 against a :35
 * boundary, and the tick that held the lock had begun at :23. A window that opened at :30
 * would not have touched it. Opening a slot earlier means at most one tick is ever in
 * flight when the window opens, and it has a whole block to drain.
 *
 * AFTER is short: the post-boundary JIT tick is a BOUNDARY tick and exempt anyway, so this
 * only stops a routine tick grabbing the lock in the same second the boundary lands.
 */
const RACE_QUIET_BEFORE_SEC = 12n;
const RACE_QUIET_AFTER_SEC = 2n;

/**
 * The boundary a routine tick must keep out of the way of, or null when there is none.
 *
 * Only suppresses when a fire is actually ARMED — with offense off and nothing owed there is
 * no race to protect, and going quiet then would just stop work for no reason.
 *
 * What a skipped tick costs is nothing that cannot wait ~15s: proactive pay, auto-defend
 * (a 24h clock), the kill sweep and mid-epoch offense all resume on the next block. What it
 * BUYS is the boundary race itself, plus a second effect worth having — a routine tick is
 * what advances currentEpoch mid-window, which is the root the epoch-shift bugs grew from.
 */
// Exported for tests: the window SIZING is the fix, and getting it wrong is silent — a
// window that opens too late looks identical to one that works until a boundary is lost.
export function routineTickMustYield(nowSec: bigint): bigint | null {
  const s = runtime.strategy;
  const payArmed = s.preBoundaryPay && s.jitEnabled && s.jitTargetEpoch !== null;
  const auditArmed = s.preBoundaryAudit && s.offenseEnabled && s.autoAudit;
  if (!payArmed && !auditArmed) return null;
  const boundary = boundaryForArmedFire();
  if (boundary === null) return null;
  const leadSec = BigInt(Math.ceil(effectiveLeadMs() / 1000));
  const opens = boundary - leadSec - RACE_QUIET_BEFORE_SEC;
  const closes = boundary + RACE_QUIET_AFTER_SEC;
  return nowSec >= opens && nowSec <= closes ? boundary : null;
}

/** A pre-boundary fire was ready but blocked by an in-flight tick until the boundary had
 *  already passed. Distinct from warnRaceMissed (armed too late): here the timer fired ON
 *  TIME and the engine's own tick is what cost the race, which is actionable — it points at
 *  tick duration, not at a sleeping machine. Reported once per boundary. */
const tickLostRaceFor = new Map<string, bigint>();

/**
 * How late a fire has to be before it is worth reporting.
 *
 * Two seconds, because that is what it actually costs. The old threshold was "the boundary
 * has already passed", which is ~12s of slip — and MISSING THE BOUNDARY BLOCK only needs a
 * couple. That gap swallowed a real failure: on the epoch-174 boundary four payments fired
 * at :33 against a :35 boundary, missed the block by one, and every one of them reverted
 * with IncorrectPayment once a rival's audits landed first. The boundary had not passed, so
 * nothing was logged at all and the operator saw only the reverts.
 */
const RACE_DELAY_WARN_SEC = 2n;

/** Report a pre-boundary fire that was ready on time but is being held off by a routine
 *  tick. Distinct from warnRaceMissed (armed too late): here the timer fired ON TIME and the
 *  engine's own tick is what is costing the race, which points at tick duration rather than
 *  at a sleeping machine. Reported once per boundary per kind. */
function warnRaceLostToTick(kind: string, boundarySec: bigint): void {
  if (tickLostRaceFor.get(kind) === boundarySec) return;
  /**
   * The audit fire waiting on the PAYMENT fire is the design, not a fault.
   *
   * They are scheduled for the same instant and share one lock, so on any boundary where a
   * payment is due the audit ALWAYS queues behind it — and must, because it needs the
   * paid-in-bundle credit the payment fire produces, and the payment's lower nonce is what
   * makes crediting it safe at all. Reporting that as "a routine tick held the engine" fired
   * on a perfectly healthy boundary and pointed the operator at tick duration, which was
   * never the problem. Same for the combined fire, which owns both halves by definition.
   */
  if (kind === "audit" && (tickingOwner === "the payment fire" || tickingOwner === "the combined pay+audit fire")) return;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Due when the scheduler armed it, which is one lead before the boundary — NOT at the
  // boundary itself. Measuring against the boundary is what made this silent.
  const dueSec = boundarySec - BigInt(Math.ceil(effectiveLeadMs() / 1000));
  const lateSec = nowSec - dueSec;
  if (lateSec < RACE_DELAY_WARN_SEC) return;
  tickLostRaceFor.set(kind, boundarySec);
  const past = nowSec >= boundarySec;
  const msg =
    `Pre-boundary ${kind} race was ready on time but ${tickingOwner ?? "other work"} held the engine ` +
    `for ${lateSec}s` +
    (past
      ? `, and the boundary has now passed. It will go out on the next tick, a block late.`
      : `. It still went out before the boundary, but late enough to risk missing the ` +
        `boundary BLOCK — which is what decides the race, not the second on the clock.`) +
    ` Routine ticks are supposed to stay out of this window (see routineTickMustYield); if ` +
    `this repeats, a tick is overrunning a full slot — pin fewer offense targets, or raise ` +
    `the pre-boundary lead so the window opens earlier.`;
  logger.warn(msg);
  activity.add({ kind: "info", status: "info", message: msg });
}

/**
 * Say when the endgame gate is what stopped an offense sweep. Once per boundary: the audit
 * fire can be re-entered by its own retry loop, and a line per retry would bury the point.
 */
const endgameSkipFor = new Map<string, bigint>();
function noteEndgameGateSkip(boundarySec: bigint | null): void {
  const key = "audit";
  if (boundarySec !== null && endgameSkipFor.get(key) === boundarySec) return;
  if (boundarySec !== null) endgameSkipFor.set(key, boundarySec);
  const s = runtime.strategy;
  const left = (runtime.citizenSupply ?? 0n) - WINNERS;
  const msg =
    `Pre-boundary audit skipped: endgame-only mode is set to ${s.endgameOnlyWithin} and ` +
    `${left} citizen(s) are still above the ${WINNERS} that win, so offense stays off until ` +
    `the field is closer. Payments are unaffected. Clear "Endgame only within" to audit now.`;
  logger.info(msg);
  activity.add({ kind: "info", status: "skipped", message: msg });
}

// Exported for tests ONLY: the suppression rule is a behaviour ("do not blame a tick for a
// wait that is architectural") with no other observable, and driving it through two real
// fires would test the scheduler rather than the rule.
export function __setTickingOwnerForTest(o: string | null): void { tickingOwner = o; }
export function __warnRaceLostToTickForTest(kind: string, boundarySec: bigint): void {
  warnRaceLostToTick(kind, boundarySec);
}
export function __resetRaceWarnForTest(): void { tickLostRaceFor.clear(); endgameSkipFor.clear(); }

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
  // A target epoch that has fully elapsed is STALE, not imminent. Without this the
  // deltaSec <= 0 branch below fired a tick instantly — and that tick's jitPass paid,
  // mid-epoch, for a boundary days gone (see expireStaleJitArm). tick() expires the arm
  // itself, but this scheduler is reachable before/independently of a tick — every arm
  // path calls it directly — so it has to refuse on its own rather than trusting that.
  if (armedEpochIsOver(s.jitTargetEpoch, nowSec)) return;
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
  // Stale arm: say nothing and arm nothing. Reporting "race missed" for an epoch that
  // ended days ago would be a fresh warning every reschedule about a race never entered.
  if (armedEpochIsOver(s.jitTargetEpoch, nowSec)) return;
  if (deltaMs <= 0) {
    // The +500ms JIT tick still pays, just a block later instead of racing into the
    // boundary block — worth saying so rather than leaving the log empty.
    warnRaceMissed("payment", BigInt(s.jitTargetEpoch ?? 0), boundary);
    return;
  }
  noteRaceArmed("payment", BigInt(s.jitTargetEpoch ?? 0));
  preBoundaryTimer = setTimeout(() => void firePreBoundaryPay(), Math.min(deltaMs, 2_000_000_000));
}

/**
 * Tokens the payment fire queued for THIS boundary, so the audit fire that follows can count
 * them as current.
 *
 * Without this a single-citizen holder on the no-bid path can pay OR audit at a boundary, never
 * both: the chain still reads the citizen as behind when the audit sweep runs, so it is not an
 * eligible auditor and the sweep reports "0 auditor slot(s)". Observed alternating exactly with
 * whether a payment was due — epoch 169 audited, 170 did not, 171 audited, 172 did not.
 *
 * Safe across two separate bundles for one reason: both come from the SAME wallet on sequential
 * nonces (payTaxes is owner-only, so the payer IS the auditor token's owner, which is the wallet
 * that signs the audit). A block must order a sender's transactions by ascending nonce, so the
 * audit can only ever execute AFTER that wallet's payment executes. If the payment does not land,
 * the audit cannot land either — there is a nonce gap — so crediting it can never produce an
 * audit running against an unpaid auditor. Same guarantee the combined bundle relies on, just
 * spanning two bundles instead of one.
 *
 * Keyed by epoch so a stale set from an earlier boundary is ignored rather than trusted.
 */
let paidForBoundary: { epoch: string; tokens: Set<string> } | null = null;

/** Forget the paid-this-boundary set. For tests. */
export function resetPaidForBoundary(): void {
  paidForBoundary = null;
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
// No address parameter: payments are queued for every owned citizen across every wallet,
// each signed by its holder. A single address here read as "which wallet pays", which is
// not a choice that exists — payTaxes is owner-only.
async function queuePreBoundaryPayments(targetEpoch: bigint, boundaryTs: bigint): Promise<Set<string>> {
  const s = runtime.strategy;
  const paid = new Set<string>();
  const ownedIds = await fetchOwnedAcrossWallets(runtime.citizensAddress as Address);
  const selected = applyExclusions(
    s.jitTokenIds.length > 0 ? s.jitTokenIds.map((x) => BigInt(x)) : ownedIds,
    "pre-boundary pay",
  );
  if (selected.length === 0) return paid;

  // Two passes: decide WHO owes a payment first, because whether a payment may be
  // revert-tolerant depends on how many siblings share the bundle (see tolerateReverts).
  const owing: { id: bigint; key: string; value: bigint }[] = [];

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
    owing.push({ id: selected[i]!, key, value });
  }

  /**
   * Whether a reverting payment is allowed to keep the bundle alive.
   *
   * `eth_sendBundle` drops a bundle when any tx NOT in `revertingTxHashes` reverts, so with
   * payments mandatory ONE citizen reverting in-block (`AlreadyCurrent`, or audited earlier
   * in the same block) takes every healthy sibling payment down with it. Those siblings then
   * fall to the mempool and miss the boundary block — which is where ~10 rival audits land,
   * against citizens that are exactly 2 epochs behind and therefore auditable.
   *
   * Only worth it with SIBLINGS to protect. With a single payment there is nothing to save,
   * and revert-tolerance would instead land a bundle whose only payment reverted — paying the
   * coinbase bid on a boundary that today costs nothing, because a dropped bundle takes the
   * bundle-only bid with it. So below two payments, mandatory is strictly better.
   *
   * Payments keep their mempool mirror either way (`bundleOnly` is never set for them): that
   * is what makes this safe rather than a trade of one failure mode for a worse one.
   */
  const tolerateReverts = owing.length >= 2;

  for (const { id, key, value } of owing) {
    const guard = await canSpend(value, false, walletForToken(key)); // max-base-fee, floor, max-payment caps
    if (guard.fatal) {
      // Fee over cap fails identically for every remaining citizen, so stop re-awaiting the
      // same verdict. But say WHICH citizens went unpaid, in ONE entry rather than a debug
      // line: an unpaid citizen at a boundary is auditable, and the operator needs to know
      // exactly who. (The offense sweeps can stay silent here — a skipped audit costs an
      // opportunity; a skipped payment can cost a citizen.)
      const remaining = owing.slice(owing.findIndex((o) => o.key === key)).map((o) => o.key);
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        message:
          `Deferred ${remaining.length} pre-boundary payment(s) for epoch ${targetEpoch} — ${guard.reason}. ` +
          `Unpaid: #${remaining.join(", #")}. They are auditable at this boundary until paid.`,
      });
      break;
    }
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer pre-boundary pay #${key}: ${guard.reason}` });
      continue;
    }
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(id, 1), value, gas: PRE_BOUNDARY_GAS },
      "pay-taxes",
      {
        tokenId: key,
        message:
          `Pre-boundary pay #${key} for epoch ${targetEpoch} = ${formatEther(value)} ETH (boundary race)` +
          (tolerateReverts ? ` (1 of ${owing.length}, revert-tolerant)` : ""),
        race: true,
        simTimestamp: boundaryTs,
        revertible: tolerateReverts,
      },
    );
    if (res?.ok) paid.add(key);
  }
  return paid;
}

/** Fire the opt-in pre-boundary JIT payment as its own bundle (+ optional coinbase
 *  bid). Used when combinedBoundaryBundle is OFF; the combined fire uses the helper
 *  directly. Best-effort — the ordinary post-boundary JIT tick remains the fallback. */
export async function firePreBoundaryPay(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryPay || !s.jitEnabled || s.jitTargetEpoch === null) return;
  // Its scheduler already refuses a dead epoch, so this is belt-and-braces — but the timer
  // could have been armed before the arm went stale, and this function computes a payment
  // value from the armed epoch. Cheaper to make the property local than to rely on callers.
  if (armedEpochIsOver(s.jitTargetEpoch)) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  // Same tick-contention report as the combined fire — see warnRaceLostToTick.
  if (ticking) {
    const b = boundaryForArmedFire();
    if (b !== null) warnRaceLostToTick("payment", b);
    setTimeout(() => void firePreBoundaryPay(), 150);
    return;
  }
  ticking = true;
  tickingOwner = "the payment fire";
  committedThisTickWei = new Map();
  beginBatch();
  const targetEpoch = BigInt(s.jitTargetEpoch);
  const boundaryTs = (runtime.startTime ?? 0n) + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
  // Telemetry only: lets the flush record how early this race was sent (race-timing.ts).
  setRaceBoundary(boundaryTs);
  try {
    await nonces.syncAll(runtime.addresses as Address[], appConfig.mode);
    const paid = await queuePreBoundaryPayments(targetEpoch, boundaryTs);
    // Hand these to the audit fire, which runs next and would otherwise see them as behind.
    paidForBoundary = { epoch: targetEpoch.toString(), tokens: paid };
    if (paid.size > 0) await maybeQueueCoinbaseBid("payment");
  } catch (err) {
    logger.error("pre-boundary pay error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary pay error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
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

async function maybeQueueCoinbaseBid(kind: BidKind): Promise<void> {
  const s = runtime.strategy;
  const amount = coinbaseBidFor(s, kind);
  if (amount <= 0 || !s.coinbasePayerAddress) return;
  const bidWei = parseEther(String(amount));
  const queued = await queueCoinbaseBid(s.coinbasePayerAddress as Address, bidWei);
  if (!queued) return;
  // The bid is real ETH but it does NOT go through act(), so it was invisible to every
  // spend accounting path: "spent this epoch" under-reported it, the cumulative
  // min-balance check for the rest of the tick didn't see it, and the cached balance
  // stayed pre-bid. At one bid per boundary that silently understated spend every day
  // and could let a later payment slip under the floor. Account for it the same way
  // act() does.
  runtime.recordSpend(bidWei);
  // The bid is paid by the primary wallet, so it consumes that wallet's headroom.
  if (runtime.primary) commitFor(runtime.primary.account.address, bidWei);
  invalidateBalanceCache();
}

/** Whether the combined pay+audit fire should actually fuse the two into one bundle.
 *  It only does so when a coinbase bid will fire: without a bid, the bundle-only
 *  audits have no mempool fallback and can silently fail if the bundle loses the
 *  slot, so we fall back to SEPARATE bundles (where the audit keeps its mirror).
 *  The toggle is thus a no-op — behaviourally identical to separate — until a bid
 *  is set, which makes it safe to leave on by default. */
/** Whether a coinbase bid will actually fire: an amount to pay AND a payer to route it
 *  through. Without both, `maybeQueueCoinbaseBid` is a no-op and a bundle competes on
 *  priority fee alone — which decides whether bundle-only submission is safe. */
/**
 * Which bid funds a given boundary.
 *
 * "payment" = a payment shares the bundle (or is the bundle). Defensive, must land, and
 * bigger — every payment adds ~82,875 gas, so the same position costs more to buy.
 * "audit"   = offense only. Speculative: losing it costs the audit fee and nothing else,
 * and the bundle is far smaller, so a given density is cheaper.
 *
 * Splitting them is what lets a quiet epoch run cheap while the one boundary that
 * actually has a payment on it bids properly.
 */
export type BidKind = "payment" | "audit";

export function coinbaseBidFor(s: StrategyConfig, kind: BidKind): number {
  return kind === "payment" ? s.coinbaseBidEth : s.coinbaseBidAuditOnlyEth;
}

export function coinbaseBidActive(s: StrategyConfig, kind: BidKind = "payment"): boolean {
  return coinbaseBidFor(s, kind) > 0 && !!s.coinbasePayerAddress;
}

/**
 * Whether the fused pay+audit fire owns the boundary. Either bid qualifies: which one
 * actually fires is decided at fire time by whether a payment made it into the bundle,
 * so routing must not depend on guessing that in advance.
 */
export function combinedBundleActive(s: StrategyConfig): boolean {
  return s.combinedBoundaryBundle && (coinbaseBidActive(s, "payment") || coinbaseBidActive(s, "audit"));
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
 *  explaining a skip. Same work, one return value richer.
 *
 *  `includeUnpinned` unions the pins with the capped enumeration instead of scanning
 *  only the pins, for the mid-epoch sweep (see sweepUnpinned). Pins stay FIRST in the
 *  returned order so a caller handing out scarce auditor slots serves them before
 *  anything discovered this way. Opt-in per call site on purpose: the boundary paths
 *  spend race gas and must stay narrow. */
export async function fetchOffenseCandidatesWithSkips(
  opts: { includeUnpinned?: boolean } = {},
): Promise<{
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
  // Pinned mode: the pins ARE the candidate set (bypass the enumeration cap). Widened
  // mode unions both — the pins still bypass the cap (that's why they're listed first
  // and deduped, rather than trusting the enumeration to contain them).
  let ids: bigint[];
  if (pinnedIds.length === 0) {
    ids = await fetchCandidateTokenIds(citizens);
  } else if (opts.includeUnpinned) {
    const seen = new Set(pinnedIds.map((x) => x.toString()));
    ids = [...pinnedIds];
    for (const id of await fetchCandidateTokenIds(citizens)) {
      if (!seen.has(id.toString())) ids.push(id);
    }
  } else {
    ids = pinnedIds;
  }
  const liveRaw = await filterLiveTokenIds(citizens, ids);
  // Allies are never offense candidates. The rival lists shouldn't contain one, but this
  // is the last line of defence: a stale pin, a hand-edited target list or a regenerated
  // skippers file must never get us auditing or killing a teammate's citizen.
  const allySet = new Set(loadAllyTokens().map((x) => BigInt(x).toString()));
  // The big-boy roster (data/big-boys.json) is NOT consulted here any more. It used to be
  // do-not-target and kept those operators out of auto-discovery; the team now attacks them
  // in a coordinated push, so they are ordinary candidates and the roster survives only to
  // tag and group them in the dashboard. Allies remain the one hard block.
  const pinnedSet = new Set(pinnedIds.map((x) => x.toString()));
  const emigrated = new Set<string>();
  const inGame: { id: bigint; owner: Address }[] = [];
  /**
   * Allies are counted in TWO buckets, because only one of them is a problem.
   *
   * A PINNED ally is a real config error: someone put a teammate on the target list, and the
   * only reason nothing bad happened is this filter. That deserves a warning naming the ids.
   *
   * An ENUMERATED ally is completely normal once the sweep is widened past the pins
   * (sweepUnpinned) — the candidate set is then the whole live field, which of course
   * contains every teammate. Warning about it fired ~7,000 times a day telling operators to
   * "check your target list" when their list was fine, which is worse than saying nothing:
   * it trains people to ignore a message that does mean something when it names pins.
   */
  const pinnedAllies: string[] = [];
  let enumeratedAllies = 0;
  for (const t of liveRaw) {
    const key = t.id.toString();
    if (isEmigrated(t.owner)) emigrated.add(key);
    else if (allySet.has(key)) {
      if (pinnedSet.has(key)) pinnedAllies.push(key);
      else enumeratedAllies++;
    } else inGame.push(t);
  }
  if (emigrated.size > 0) {
    logger.debug(
      `offense candidates: skipped ${emigrated.size} emigrated citizen(s) — out of the main game`,
    );
  }
  if (pinnedAllies.length > 0) {
    logger.warn(
      `offense candidates: your target list contains ${pinnedAllies.length} ALLIED citizen(s) ` +
        `— #${pinnedAllies.join(", #")}. They were skipped; remove them from the list.`,
    );
  }
  if (enumeratedAllies > 0) {
    logger.debug(
      `offense candidates: skipped ${enumeratedAllies} allied citizen(s) found by enumeration ` +
        `(expected when the sweep is widened past the pins)`,
    );
  }
  // Salt-order within each group, but keep pins ahead of everything discovered by
  // enumeration. Auditor slots are finite and handed out in list order, so without this
  // a widened sweep could spend the last slot on a random rival and skip a pinned one.
  // Two separate orderBySalt calls rather than one plus a sort: the salt ordering is the
  // anti-collision mechanism (it staggers which target each ally hits first), and a
  // stable sort over one shuffled list would preserve it inside each group anyway — this
  // just makes the grouping explicit instead of implicit in sort stability.
  const ordered = orderBySalt(inGame, (t) => t.id.toString(), engineSalt);
  if (pinnedSet.size === 0) return { candidates: ordered, emigrated };
  const pins: { id: bigint; owner: Address }[] = [];
  const rest: { id: bigint; owner: Address }[] = [];
  for (const t of ordered) (pinnedSet.has(t.id.toString()) ? pins : rest).push(t);
  return { candidates: [...pins, ...rest], emigrated };
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
      // REACHABLE, and load-bearing — an earlier note here claimed the opposite, that a
      // 2-behind token could never land in paidInBundle because payTaxes(id,1) would underpay
      // and the sim would reject it. Measured on mainnet across three consecutive boundaries
      // (#2036 at blocks 25771071 / 25785422 / 25799777), that is wrong twice over: the flat
      // one-epoch amount at the CURRENT rate is accepted, and it advances lastEpochPaid by TWO
      // epochs (170 -> 172), i.e. it makes the citizen fully current rather than one epoch
      // less behind.
      //
      // This is exactly the case that silently cost audits: a single-citizen holder sits 2
      // behind at every other boundary, isEligibleAuditor refuses it, and the sweep logs
      // "1 auditable target(s), 0 auditor slot(s), queued 0" — alternating with whether a
      // payment was due (epoch 169 audited, 170 did not, 171 audited, 172 did not).
      //
      // +1n rather than targetEpoch is deliberate: the on-chain effect is at least +1, and
      // crediting the smaller advance cannot over-qualify a token.
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
  const auditTarget = (runtime.currentEpoch ?? 0n) + 1n;
  if (deltaMs <= 0) {
    // Normal offense still audits after the roll, but a block or more later — usually
    // too late to beat a rival's cure, which is the whole point of the race.
    warnRaceMissed("audit", auditTarget, boundary);
    return;
  }
  noteRaceArmed("audit", auditTarget);
  preBoundaryAuditTimer = setTimeout(
    () => void firePreBoundaryAudit({ targetEpoch: auditTarget, boundaryTs: boundary }),
    Math.min(deltaMs, 2_000_000_000),
  );
}

/** Pre-submit audits (skip-sim) for rivals that will be auditable in the FIRST
 *  block of the upcoming epoch, so we compete with a batch-auditor rather than
 *  landing a block later. Best-effort; normal offensePass remains the fallback. */
/**
 * Queue pre-boundary audits into the CURRENTLY OPEN batch (caller opened beginBatch
 * and synced the nonce). Targets rivals auditable in the first block of `targetEpoch`,
 * one per eligible auditor token.
 *
 * `opts.revertible` marks each audit allowed-to-revert, so one stale target (already audited,
 * auditor out of capacity) cannot invalidate the whole bundle and take its siblings with it.
 *
 * `opts.bundleOnly` separately decides whether each audit is withheld from the public mempool,
 * and the two are NOT the same question — conflating them is what made the useful combination
 * unrepresentable. It matters which caller is asking:
 *
 *   COMBINED bundle (payments + audits share one bundle) -> bundleOnly MUST be true. Payments
 *     and audits there hold sequential nonces of the same wallet, so if a mirrored audit
 *     landed it would consume its nonce and make the bundle containing that nonce invalid —
 *     the builder drops it and the PAYMENTS go down with the audit. That is the "mirroring an
 *     audit demotes the payment" hazard, and it is specific to sharing a bundle.
 *   STANDALONE audit bundle (no bid, payments in their OWN bundle) -> bundleOnly false is
 *     safe and strictly better. A mirror landing can only invalidate the audit bundle, and by
 *     then the audit has landed; nothing else rides with it. That buys revert-tolerance AND
 *     keeps the only copy that can land in the ~1 boundary in 10 built by a solo validator,
 *     which accepts no bundles at all.
 *
 * The cost of mirroring an audit is strategic, not mechanical: a visible pending audit lets
 * the target cure first. That is the same exposure payments already carry, and it stays gated
 * behind `racePublicMempool` (see act()).
 *
 * Returns whether any queued.
 */
// Exported for tests: this is the audit-queue unit that a boundary miss like
// token 1612 flows through, so an integration test drives it directly.
export async function queuePreBoundaryAudits(
  targetEpoch: bigint,
  nowSec: bigint,
  boundaryTs: bigint,
  opts: { revertible: boolean; bundleOnly: boolean; paidInBundle?: Set<string> },
): Promise<boolean> {
  const s = runtime.strategy;
  const ownedIds = await fetchOwnedAcrossWallets(runtime.citizensAddress as Address);
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
  /**
   * Why nothing was sent, when nothing was sent.
   *
   * The sweep already reports the COUNT unconditionally, so a zero is never invisible — but
   * it never said the reason, and "queued 0" with targets and slots available reads as a
   * broken bot. The payment path names its blocker; this one dropped it to logger.debug,
   * which is not in the activity feed the operator actually reads.
   *
   * The realistic trigger is the SEPARATE offense base-fee cap: payments and audits carry
   * independent ceilings, so a base fee between them sends every payment and silently stops
   * every audit. Boundary blocks run at ~0.05 gwei against a 69.1 default, so it is rare —
   * but rare and silent is the combination that costs a whole boundary before anyone looks.
   */
  let blockedBy: string | null = null;
  let deferred = 0;
  for (const t of auditable) {
    if (idx >= auditors.length) break; // out of auditor capacity this epoch
    // Pick the auditor first: the audit is signed by whichever wallet holds it, so the
    // affordability check has to be against THAT wallet's balance, not the primary's.
    const from = auditors[idx]!;
    const guard = await canSpend(AUDIT_COST_WEI, true, walletForToken(from));
    // Fee over cap fails for every remaining target too, and here the wasted awaits eat
    // the pre-boundary lead window itself — stop rather than scan on.
    if (guard.fatal) {
      blockedBy = guard.reason ?? "spend guard";
      logger.debug(`pre-boundary audit stopped early: ${blockedBy}`);
      break;
    }
    if (!guard.ok) {
      deferred++;
      blockedBy ??= guard.reason ?? null;
      continue;
    }
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
          (viaBundlePayment ? " (auditor paid in this bundle, unsimulated)" : opts.bundleOnly ? " (in payment bundle)" : " (boundary race)"),
        race: true,
        simTimestamp: boundaryTs,
        skipSim: viaBundlePayment,
        revertible: opts.revertible,
        // The caller decides, because only the caller knows whether a payment shares this
        // bundle — see the note on this function. Deriving it from `revertible` forced
        // revert-tolerance and the mempool mirror to be the same choice, which cost the
        // no-bid path one of them for no reason.
        bundleOnly: opts.bundleOnly,
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
    message:
      `Pre-boundary audit (epoch ${targetEpoch}): ${auditable.length} auditable target(s), ` +
      `${auditors.length} auditor slot(s), queued ${queued}` +
      (deferred > 0 ? `, ${deferred} deferred` : "") +
      // Only when nothing went out: with something queued the blocker cost an opportunity,
      // not the boundary, and naming it every time would bury the counts that matter.
      (queued === 0 && blockedBy ? ` — none sent: ${blockedBy}` : ""),
  });
  return queued > 0;
}

/** Standalone pre-boundary audit bundle. Used when combinedBoundaryBundle is OFF. */
export async function firePreBoundaryAudit(armed?: { targetEpoch: bigint; boundaryTs: bigint }): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) {
    const b = boundaryForArmedFire();
    if (b !== null) warnRaceLostToTick("audit", b);
    // Carry the armed boundary through the retry, or a delayed fire re-derives it and lands
    // on the wrong day — which is the bug this whole path exists to avoid.
    setTimeout(() => void firePreBoundaryAudit(armed), 150);
    return;
  }
  /**
   * The endgame gate, which used to return in total silence.
   *
   * That silence cost a diagnosis: an operator saw the delay warning above, then nothing at
   * all, and no audits — indistinguishable from "the sweep ran and found no targets". Supply
   * is what decides this, so with 78 citizens and 69 winners any endgameOnlyWithin under 9
   * switches every pre-boundary audit off while payments carry on normally.
   */
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) {
    noteEndgameGateSkip(boundaryForArmedFire());
    return;
  }
  ticking = true;
  tickingOwner = "the audit fire";
  committedThisTickWei = new Map();
  beginBatch();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  /**
   * Pinned to the boundary passed in by the scheduler, or derived from the clock — never from
   * currentEpoch + 1. See racedBoundary: this fire waits behind the payment fire's tick lock, so
   * by the time it runs currentEpoch may already have advanced, and the old derivation then
   * stamped the bundle with TOMORROW's boundary. minTimestamp made that fatal rather than merely
   * late: no block in the window can satisfy it, so every audit vanished without an error while
   * payments landed normally.
   */
  const armedRace = armed ?? racedBoundary(runtime.startTime ?? 0n, nowSec, runtime.currentEpoch);
  const targetEpoch = armedRace.targetEpoch;
  const boundaryTs = armedRace.boundaryTs;
  // Bounds the bundle (minTimestamp) and measures the lead in race telemetry.
  setRaceBoundary(boundaryTs);
  try {
    await nonces.syncAll(runtime.addresses as Address[], appConfig.mode);
    // Allowed-to-revert ONLY when a coinbase bid will fire, because `revertible` also
    // turns off the public-mempool mirror (see act()) and the two failure modes trade
    // against each other:
    //
    //   revertible + bid  — bundle-only, revert-tolerant. A stale target (already
    //     audited, auditor out of capacity) reverts harmlessly inside the bundle instead
    //     of invalidating it, so the bundle still lands at the position the bid bought.
    //   not revertible, no bid — all-or-nothing, but each audit keeps its mempool copy.
    //     Without a bid the bundle rarely wins top-of-block anyway, so the mirror is the
    //     only thing likely to land at all.
    //
    // Getting this wrong the other way is what cost an epoch of audits: with a 0.022 ETH
    // bid configured, ONE doomed audit invalidated the whole all-or-nothing bundle, the
    // builder dropped it, and the bid — which is bundle-only and never mirrored — died
    // with it. The audits then trickled out through the mempool naked, landed at tx index
    // 40+ instead of 0, and every one reverted with AuditAlreadyActive because faster
    // bundles had already taken the targets.
    const bidding = coinbaseBidActive(s, "audit");
    /**
     * Standalone audit bundle: revert-tolerant EITHER WAY, and never bundle-only.
     *
     * Revert-tolerance used to be tied to bidding, which left the no-bid config — the one
     * most people run — with an all-or-nothing bundle: one stale target dropped every audit
     * from it and they all fell back to their mirrors, losing the placement the tip paid for.
     * There is no payment in THIS bundle to protect, so tolerating a revert costs nothing.
     *
     * bundleOnly stays false because the payments are in their own separate bundle here, so a
     * mirror that lands can only invalidate this one — by which point the audit has landed.
     * That keeps the mempool copy, which is the only thing that can land in the ~1 boundary
     * in 10 built by a solo validator.
     */
    /**
     * Credit citizens the payment fire just queued for this same boundary. They still read as
     * behind on-chain, but their payment carries a LOWER nonce from the same wallet, so the audit
     * cannot execute before it (see paidForBoundary). Those auditors go out unsimulated and
     * revert-tolerant, because simulating one against pre-payment state would wrongly fail.
     */
    const paidInBundle =
      paidForBoundary?.epoch === targetEpoch.toString() ? paidForBoundary.tokens : new Set<string>();
    /**
     * Aim one block earlier as well, but ONLY when a payment shared this boundary.
     *
     * The payment fire flushed first and read its own head; if a block landed between that
     * flush and this one, it is aimed a block ahead of us and we cannot reach the block it
     * took. Looking back covers that. On an audit-only boundary there is no earlier fire to
     * catch up to, so the extra post per builder would buy nothing.
     */
    setRaceLookBack(paidInBundle.size > 0);
    const queuedAudit = await queuePreBoundaryAudits(targetEpoch, nowSec, boundaryTs, {
      revertible: true,
      bundleOnly: false,
      paidInBundle,
    });
    // Tail a coinbase bid so the audit bundle wins the slot (no-op unless configured).
    if (queuedAudit) await maybeQueueCoinbaseBid("audit");
  } catch (err) {
    logger.error("pre-boundary audit error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary audit error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
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
  // A tick is holding the nonce sequence, so wait it out rather than interleaving. But say
  // so if the wait is what costs us the race: a WebSocket tick runs on every ~12s block and
  // an offense sweep inside it can take seconds, so this retry loop can spin right through
  // the boundary. Before, it did that in total silence — the only symptom being a payment
  // that turned up a block late (the epoch-162 miss), with nothing in the log to say why.
  if (ticking) {
    const boundarySec = boundaryForArmedFire();
    if (boundarySec !== null) warnRaceLostToTick("bundle", boundarySec);
    setTimeout(() => void firePreBoundaryBundle(), 150);
    return;
  }
  ticking = true;
  tickingOwner = "the combined pay+audit fire";
  committedThisTickWei = new Map();
  beginBatch();
  /**
   * The epoch this fire is racing into.
   *
   * Derived from what JIT is ARMED for, falling back to `currentEpoch + 1` when nothing is
   * armed (an audit-only boundary). It deliberately does NOT read `currentEpoch + 1`
   * unconditionally: this fire can be delayed past the boundary — it retries every 150ms
   * while a tick holds `ticking`, and a WebSocket tick runs on every ~12s block — after
   * which a post-boundary tick advances `currentEpoch` and `currentEpoch + 1` points one
   * epoch too far. The payment gate below then compared armed-162 against derived-163 and
   * dropped the payment silently.
   *
   * That is the epoch-162 miss (tx 0x2090097f…494c): the payment left via the ordinary
   * post-boundary JIT tick instead, landing at index 0 of the block AFTER the boundary
   * block, with no pre-boundary entry in the activity log to explain it.
   *
   * BOUNDED to `armedEpoch >= currentEpoch`, because "trust the arm over live state" only
   * needs to absorb ONE epoch of drift — the delay above advances currentEpoch to the
   * armed epoch, never past it. An arm older than that is stale (expireStaleJitArm), and
   * honouring it here meant paying for a dead epoch against a boundary timestamp days in
   * the past. Falling back to null makes the payment gate below skip, which is right: a
   * stale arm is not an instruction to pay now.
   */
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const armedEpoch =
    s.jitEnabled &&
    s.jitTargetEpoch !== null &&
    BigInt(s.jitTargetEpoch) >= (runtime.currentEpoch ?? 0n) &&
    !armedEpochIsOver(s.jitTargetEpoch, nowSec)
      ? BigInt(s.jitTargetEpoch)
      : null;
  const targetEpoch = armedEpoch ?? (runtime.currentEpoch ?? 0n) + 1n;
  const boundaryTs = (runtime.startTime ?? 0n) + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
  // Telemetry only: lets the flush record how early this race was sent (race-timing.ts).
  setRaceBoundary(boundaryTs);
  try {
    await nonces.syncAll(runtime.addresses as Address[], appConfig.mode);
    let paidInBundle = new Set<string>();
    let auditQueued = false;
    // Payment first (lowest nonces): its amount is only valid top-of-block, and a
    // just-paid auditor token is current before it audits. `targetEpoch` IS the armed
    // epoch when a payment is armed, so no equality check is needed — the arm is the
    // instruction, and re-deriving the target from live state is what dropped it before.
    if (s.preBoundaryPay && armedEpoch !== null) {
      paidInBundle = await queuePreBoundaryPayments(targetEpoch, boundaryTs);
    }
    // Audits next (higher nonces), always allowed-to-revert here. Two independent reasons,
    // and this fire always has at least the second:
    //   - a payment shares the bundle -> a reverting audit must not be able to drop it,
    //     and no extra mempool nonce may demote it;
    //   - a coinbase bid is queued below (this fire only runs when combinedBundleActive,
    //     which requires one) -> a doomed audit must not invalidate the bundle and take
    //     the bid down with it. That is what cost an ally a whole epoch of audits on the
    //     standalone path: one stale target killed the bundle, the bundle-only bid died
    //     with it, and the mempool mirrors landed naked at tx index 40 and reverted.
    // Bundle-only costs us the mirror, but with a bid backing the bundle the mirror was
    // never the copy that was going to win position anyway.
    if (
      s.preBoundaryAudit && s.offenseEnabled && s.autoAudit &&
      !(s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin))
    ) {
      auditQueued = await queuePreBoundaryAudits(targetEpoch, nowSec, boundaryTs, {
        revertible: paidInBundle.size > 0 || coinbaseBidActive(s, "audit"),
        // MUST stay true here: payments share this bundle on sequential nonces, so a mirrored
        // audit that lands would consume its nonce, invalidate the bundle, and take the
        // payments with it. Unchanged from before — only the standalone path moved.
        bundleOnly: true,
        // Tokens paid above are current by the time the audit executes, so they can
        // serve as audit "from" tokens even though the chain still reads them behind.
        paidInBundle,
      });
    }
    // Coinbase bid tails the bundle to win the slot. This fire only runs when a bid is
    // active (combinedBundleActive), so the audits always have the bid backing them —
    // no-bid falls back to the separate schedulers, where audits keep their mempool mirror.
    // Which bid this is depends on what actually got queued, not on what was configured:
    // a payment in the bundle makes it a must-land defensive boundary, otherwise it is an
    // ordinary offense night on the cheaper bid.
    const bidKind: BidKind = paidInBundle.size > 0 ? "payment" : "audit";
    if (paidInBundle.size > 0 || auditQueued) await maybeQueueCoinbaseBid(bidKind);
  } catch (err) {
    logger.error("pre-boundary bundle error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary bundle error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
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
  const targetEpoch = runtime.currentEpoch + 1n;
  if (deltaMs <= 0) { warnRaceMissed("bundle", targetEpoch, boundary); return; }
  noteRaceArmed("bundle", targetEpoch);
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
  tickingOwner = "the kill fire";
  committedThisTickWei = new Map();
  beginBatch();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Pre-submit kills for audits expiring within our lead + one slot of headroom.
  const windowSec = BigInt(Math.ceil(effectiveLeadMs() / 1000) + 12);
  let queuedKill = false;
  try {
    await nonces.syncAll(runtime.addresses as Address[], appConfig.mode);
    const ownedIds = await fetchOwnedAcrossWallets(runtime.citizensAddress as Address);
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
      if (guard.fatal) { logger.debug(`pre-boundary kill stopped early: ${guard.reason}`); break; }
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
    // A kill race carries no payment, so it prices as offense.
    if (queuedKill) await maybeQueueCoinbaseBid("audit");
  } catch (err) {
    logger.error("pre-boundary kill error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary kill error: ${(err as Error).message}` });
  } finally {
    await flushBatch();
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
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

/** Refresh chain state and every wallet's balance. Takes no address: it covers the whole
 *  wallet set, and a single-address parameter was exactly the assumption that left
 *  non-primary balances frozen at their unlock-time value. */
async function refreshSnapshot(): Promise<void> {
  // Fetch the full latest block (not just its number) so it warms the shared
  // block cache: every canSpend/computeFees later in this tick then reuses it
  // instead of each re-reading the block for the base fee.
  // Balances for EVERY wallet, not just the primary: each wallet's floor is checked
  // against its own balance, so a wallet whose balance never refreshed would keep
  // passing the floor on a number that predates all of its own spending.
  // getBalanceCached is per-address and 30s-lived, so this is one read per wallet per
  // 30s, not per tick.
  const [snap, balances, latest] = await Promise.all([
    getGameSnapshot(),
    Promise.all(
      runtime.wallets.map(async (w) => ({
        address: w.account.address,
        wei: await getBalanceCached(w.account.address as Address),
      })),
    ),
    getLatestBlockCached(),
  ]);
  runtime.applyChainSnapshot(snap);
  for (const b of balances) runtime.setBalance(b.address, b.wei);
  runtime.lastBlock = latest.number;
  // applyChainSnapshot retires a dead arm as part of applying the epoch, so it must run
  // BEFORE the schedulers below — each of them reads the arm.
  runtime.applyChainSnapshot(snap);
  runtime.emitStatus();
  scheduleJitBoundary();
  schedulePreBoundaryPay();
  schedulePreBoundaryAudit();
  schedulePreBoundaryBundle();
  scheduleDefenseBoundary();
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors?
 *  `offense` selects the audit/kill gas profile so the base-fee cap and gas
 *  estimate match what `submitTx` will actually bid.
 *
 *  `fatal` marks a failure that is a property of the BLOCK, not of this candidate — the
 *  base fee being over cap. Every remaining candidate in the sweep would fail it
 *  identically, so a loop should stop rather than re-await the same verdict per target.
 *  Without it, a fee spike made the offense loop walk the entire target list (hundreds of
 *  rivals when unpinned), awaiting once each and submitting nothing — and in the
 *  pre-boundary path that burned the lead window the race depends on. Per-wallet failures
 *  (min-balance floor) are NOT fatal: another candidate may be held by a funded wallet. */
async function canSpend(
  valueWei: bigint,
  offense: boolean,
  // The wallet that will actually pay. The floor is per-wallet because each wallet funds
  // its own gas: checking a shared total would let a rich wallet mask an empty one and
  // send a tx that cannot pay for itself.
  wallet: Wallet | null = runtime.primary,
): Promise<{ ok: boolean; reason?: string; fatal?: boolean }> {
  const s = runtime.strategy;
  const gas = resolveGas(s, offense);
  const block = await getLatestBlockCached();
  const baseFee = block.baseFeePerGas ?? 0n;
  const maxBase = BigInt(Math.round(gas.maxBaseFeeGwei * 1e9));
  if (baseFee > maxBase) {
    return {
      ok: false,
      reason: `base fee ${formatEther(baseFee * 1_000_000_000n)} gwei over cap`,
      fatal: true,
    };
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

  if (!wallet) return { ok: false, reason: "wallet locked" };
  const bal = wallet.balanceWei ?? 0n;
  const floor = parseEther(String(s.minBalanceEth));
  // Account for spend already committed earlier in this tick — the on-chain
  // balance is read once per tick and doesn't yet reflect those payments, so
  // without this several payments in one tick could cumulatively breach the floor.
  if (!canAffordSpend(bal, committedFor(wallet.account.address), valueWei, gasWei, floor)) {
    return {
      ok: false,
      reason: `would breach min-balance floor on ${wallet.label} (${wallet.account.address.slice(0, 10)}…)`,
    };
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
  // Who signed it and at what nonce. Optional only because older callers predate the
  // check below; supply it wherever you can — it is what turns "no receipt" from a
  // shrug into a verdict.
  signer?: { address: Address; nonce: number },
): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const block = receipt.blockNumber?.toString();
    // Race telemetry: the position half of the timing experiment. Joined to the submission
    // row by tx hash, so "how early did we send" can be regressed against "where did we
    // land" — the one variable on-chain analysis cannot see (see race-timing.ts).
    recordRaceOutcome(txHash, {
      blockNumber: receipt.blockNumber,
      transactionIndex: Number(receipt.transactionIndex),
      status: receipt.status === "success" ? "included" : "reverted",
    });
    activity.update(entryId, {
      status: receipt.status === "success" ? "included" : "reverted",
      targetBlock: block,
      ...(broadcast ? {} : { txHash }),
    });
  } catch (err) {
    /**
     * No receipt inside the window. "Lost the race" and "this transaction can never land"
     * look identical here, and the difference is the whole story — so ask the chain which
     * one it is instead of leaving the row at "submitted" forever.
     *
     * The test is the nonce. If the chain has moved PAST our nonce and our hash still has no
     * receipt, then something else consumed that nonce and this transaction is permanently
     * dead. That is the exact signature of the epoch-176 collision, where a payment sat at
     * "submitted" while the citizen it was meant to save went unpaid, fell 2 epochs behind,
     * and got audited — and nothing in the feed said so. A dropped bundle, by contrast,
     * leaves the nonce unconsumed and is genuinely just a lost race.
     *
     * Deliberately an ERROR, not info: a payment that can never land is the most expensive
     * silent failure this bot has, and it needs to survive a glance at the feed.
     */
    if (signer) {
      try {
        const chainNonce = await publicClient.getTransactionCount({
          address: signer.address,
          blockTag: "latest",
        });
        if (chainNonce > signer.nonce) {
          activity.update(entryId, { status: "skipped" });
          activity.add({
            kind: "error",
            status: "skipped",
            message:
              `Transaction ${txHash.slice(0, 10)}… can never land: nonce ${signer.nonce} was ` +
              `consumed by a different transaction (wallet is now at ${chainNonce}). ` +
              `Whatever this was meant to do did NOT happen — check the citizen it covered.`,
          });
          logger.error(
            `dead tx ${txHash.slice(0, 10)}…: nonce ${signer.nonce} consumed by another tx ` +
              `(chain at ${chainNonce})`,
          );
          return;
        }
      } catch (probeErr) {
        logger.warn(`could not classify stuck tx ${txHash.slice(0, 10)}…: ${(probeErr as Error).message}`);
      }
    }
    // Nonce not yet consumed: a dropped bundle or a slow chain. Leave it as "submitted" —
    // it may still land, and force-marking it either way would be a guess.
    logger.warn(`receipt tracking for ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: { tokenId?: string; targetTokenId?: string; message: string; race?: boolean; simTimestamp?: bigint; revertible?: boolean; bundleOnly?: boolean; skipSim?: boolean; normalGas?: boolean; wallet?: Wallet },
): Promise<SubmitResult | null> {
  const offense = kind === "audit" || kind === "kill";
  // Which wallet signs. `ctx.tokenId` is always the citizen WE own in the action — the one
  // being paid, or the auditor doing the auditing — so its holder is the required signer.
  // kill() takes no owned token and is callable by anyone, so it falls back to the primary.
  // Fail closed for owner-only calls. payTaxes / useBribe / audit all revert unless
  // msg.sender owns the citizen named in ctx.tokenId, so falling back to the primary
  // when we can't resolve the holder isn't a graceful degradation — it's a guaranteed
  // revert that still costs gas and still loses the boundary race. kill() names no owned
  // token (ctx.tokenId is unset) and is callable by anyone, so it keeps the fallback.
  const resolved = ctx.wallet ?? (ctx.tokenId ? walletForToken(ctx.tokenId) : runtime.primary);
  const signer = resolved ?? (ctx.tokenId ? null : runtime.primary);
  if (!signer) {
    activity.add({
      kind: "error",
      status: "skipped",
      tokenId: ctx.tokenId,
      targetTokenId: ctx.targetTokenId,
      message: `${ctx.message} — skipped: no unlocked wallet holds #${ctx.tokenId ?? "?"}`,
    });
    return null;
  }
  try {
    const result = await submitTx(intent, {
      account: signer.account,
      // In mainnet mode a bundle only lands if a builder we sent it to wins the
      // slot — so PAYMENTS always mirror to the public mempool as a fallback: one
      // that never lands can cost a citizen, and a tax payment isn't meaningfully
      // front-runnable (rivals already see the delinquency on-chain).
      // OFFENSE stays opt-in (racePublicMempool): a visible pending audit lets the
      // target escape by paying first, so privacy is worth something there.
      // Whether this tx also goes to the public mempool.
      //
      // Derived from `bundleOnly`, NOT from `revertible` — those are different questions and
      // conflating them made one unrepresentable: a PAYMENT needs to be revert-tolerant (so
      // one bad citizen can't drop its siblings from the bundle) while KEEPING its mirror
      // (so losing the slot still lands it, a block late). Deriving the mirror from
      // `revertible` forced a choice between those, and the wrong one costs a citizen.
      //
      // Audits riding a payment bundle and the coinbase bid stay bundle-only: mirroring an
      // audit adds a second mempool nonce that can demote the payment, and a bundle-only bid
      // is only meaningful in the block it wins.
      race: ctx.bundleOnly ? false : offense ? (ctx.race && runtime.strategy.racePublicMempool) : true,
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
    commitFor(signer.account.address, result.valueWei + result.gasWei);
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
      batchEntries.push({ entryId: entry.id, nonce: result.nonce, address: signer.account.address });
      return result;
    }
    // Watch for the receipt so the entry flips submitted -> included/reverted. A pure
    // Flashbots submission has no broadcast txHash, but the hash it will have if it lands
    // is just keccak of the signed tx — poll that so bundle-only sends resolve too.
    const dead = { address: signer.account.address, nonce: result.nonce };
    if (result.txHash) void trackReceipt(entry.id, result.txHash, true, dead);
    else if (result.predictedTxHash) void trackReceipt(entry.id, result.predictedTxHash, false, dead);
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

// By default there is NO defense pass.
//
// The bot takes ZERO automatic action once one of your citizens is audited — it will not
// pay taxes to clear the audit, and it will not spend a held bribe. Recovering an audited
// citizen is the user's decision, via the manual "Pay to current" / "Clear audit (bribe)"
// buttons on the token row (see manualPayToCurrent / manualUseBribe).
//
// What is always automatic is only PRE-audit protection: proactivePayPass and the JIT
// payment keep a citizen current so it never becomes auditable in the first place. Both
// skip any citizen that is already under audit, and both honour `excludedTokenIds`.
//
// Consequence, stated plainly: an audited citizen you do not pay yourself will be
// killable when its 24h audit expires, and nothing here will stop that — UNLESS the
// user opts in to `autoDefendAudit` below, which is the single exception.

/** Tokens already defended, keyed `tokenId:auditDueTimestamp` so that a *new* audit on
 *  the same token arms again while a retry of the same one does not double-pay. */
let defendSubmitted = new Set<string>();

/**
 * Latest audit deadline among owned citizens Benji still intends to pay off, or null.
 *
 * Exists so away mode cannot idle into a running death clock. When the boundary bundle
 * loses its block, a citizen can be audited seconds later; the away window then closes
 * five minutes after the boundary and the engine sleeps ~23h40m, leaving one retry about
 * fifteen minutes before the 24h deadline. That is far too thin a margin for the one
 * failure mode that permanently loses a citizen.
 *
 * Only counts citizens Benji would actually act on — audited, unbribed, not excluded —
 * so a held bribe or an opt-out never keeps the engine awake for nothing. Cleared as soon
 * as the audit clears, and never held past the deadline itself, so it cannot wedge away
 * mode open: once the deadline passes the citizen is killable and there is nothing left
 * to do about it.
 */
let defensePendingUntilSec: bigint | null = null;

/** The deadline Benji is still working against, or null when there is nothing pending. */
export function defensePendingUntil(): bigint | null {
  return defensePendingUntilSec;
}

/**
 * "Benji (Defense) Mode": pay off an audited citizen to clear the audit — the ONE automatic
 * response to an audit.
 *
 * Opt-in and off by default, because it inverts the rule above and spends an unbounded
 * amount: an audited citizen is 2+ epochs behind by definition, and BEING AUDITED revokes
 * the one-epoch skip — it must settle every delinquent epoch at once, so the bill is a
 * multiple of a normal day's tax. (Unaudited, the same citizen would owe 1x; see
 * cappedAutoPayEpochs for both branches.) That is
 * also why it deliberately ignores `maxAutoPayEpochs` — that cap sizes ROUTINE auto-pay,
 * and honouring it here would block this in exactly the case it exists for, letting the
 * citizen die with the feature switched on. The hard limits still apply: `maxPaymentEth`,
 * the base-fee cap and the per-wallet balance floor are all enforced via canSpend, so
 * there is still a ceiling the user controls.
 *
 * Only acts on a citizen with NO bribes. A held bribe clears the audit for free, which is
 * strictly cheaper than paying the tax, and choosing to burn one stays a manual decision.
 *
 * Timing note: under away mode the engine only ticks in the boundary window, but a 24h
 * kill deadline cannot outrun a window that recurs every 24h — see the test.
 */
// Exported for tests: this pays an unbounded amount with no keypress.
export async function maybeAutoDefendAudit(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.autoDefendAudit) return;
  // The per-citizen payment opt-out wins: "never pay this one" has to mean never, or the
  // switch would quietly resurrect a citizen the user had decided to let go.
  const candidates = applyExclusions(ownedIds, "auto-defend");
  if (candidates.length === 0) return;
  // n=1 is enough to price the whole debt: every citizen this pass acts on is audited,
  // and for an audited citizen estimateTaxesToPay(id, 1) already quotes the full
  // catch-up rather than the one-epoch skip price.
  const statuses = await batchGetOwnedStatuses(candidates, currentEpoch, nowSec, 1);
  // batchGetOwnedStatuses DROPS any token whose multicall slice partly failed. On the
  // other passes that costs an opportunity; here it would let a citizen be killed with
  // nothing said, so a short read is surfaced rather than swallowed. Not fatal — the next
  // tick re-reads — but it must be visible if it keeps happening.
  if (statuses.length < candidates.length) {
    const got = new Set(statuses.map((st) => st.tokenId));
    const missing = candidates.map((id) => id.toString()).filter((id) => !got.has(id));
    activity.add({
      kind: "info",
      status: "info",
      message:
        `Benji (Defense) Mode could not read #${missing.join(", #")} this tick — audit status ` +
        `unknown, so they were not checked. Retrying next tick.`,
    });
  }

  const audited = statuses.filter((st) => st.auditDueTimestamp !== "0");
  // Drop bookkeeping for audits that are over, so the set can't grow without bound.
  const liveKeys = new Set(audited.map((st) => `${st.tokenId}:${st.auditDueTimestamp}`));
  for (const k of defendSubmitted) if (!liveKeys.has(k)) defendSubmitted.delete(k);

  // Publish the deadline away mode must not sleep through: the citizens Benji still
  // intends to pay off. A bribed one is excluded because Benji leaves it alone, and an
  // expired deadline is excluded because the citizen is already killable — neither is a
  // reason to hold the engine open. Recomputed every pass, so it clears itself.
  const actionable = audited
    .filter((st) => BigInt(st.bribeBalance) === 0n && BigInt(st.auditDueTimestamp) > nowSec)
    .map((st) => BigInt(st.auditDueTimestamp));
  defensePendingUntilSec = actionable.length > 0 ? actionable.reduce((a, b) => (a > b ? a : b)) : null;

  for (const st of audited) {
    const key = `${st.tokenId}:${st.auditDueTimestamp}`;
    if (defendSubmitted.has(key)) continue;
    if (BigInt(st.bribeBalance) > 0n) continue; // free fix available; stays the user's call

    const value = BigInt(st.estimatedPayWei);
    if (value === 0n) continue;
    const tokenId = BigInt(st.tokenId);
    const wallet = walletForToken(tokenId);
    const guard = await canSpend(value, false, wallet);
    if (!guard.ok) {
      // Not marked submitted: retry next tick. A base-fee spike or a temporary floor
      // breach must not permanently give up on a citizen that is about to be killed.
      activity.add({
        kind: "pay-taxes",
        status: "skipped",
        tokenId: st.tokenId,
        message:
          `Benji (Defense) Mode could NOT save #${st.tokenId}: ${guard.reason}. It is under audit ` +
          `with no bribes and will be killable in ${st.secondsUntilKillable ?? 0}s.`,
      });
      continue;
    }
    defendSubmitted.add(key); // before awaiting, so a rapid re-fire can't double-pay
    const res = await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, 1), value },
      "pay-taxes",
      {
        tokenId: st.tokenId,
        // canSpend already refused a null wallet above, so this is set in practice; act()
        // re-resolves from the tokenId and fails closed anyway if it somehow isn't.
        wallet: wallet ?? undefined,
        message:
          `Benji (Defense) Mode: paying off audited #${st.tokenId} = ${formatEther(value)} ETH ` +
          `(${Number(currentEpoch - BigInt(st.lastEpochPaid))} epoch(s) behind, no bribes held) — clears the audit`,
      },
    );
    // act() returns null when nothing was submitted (sim revert, no signer, send failed).
    // Elsewhere leaving the token marked is fine; here it would mean one failed send is
    // the difference between a citizen living and dying, so release it and retry next
    // tick. A submission that DID go out stays marked, so this can't double-pay.
    if (!res) defendSubmitted.delete(key);
  }
}

/**
 * Pay delinquent-but-not-yet-audited citizens. Only invoked from the
 * boundary-timed tick armed by `scheduleDefenseBoundary` (see DEFENSE_LEAD_MS),
 * never from a regular poll/block tick — so a citizen that's already delinquent
 * is left alone until the next epoch boundary, then paid immediately.
 */
/**
 * Self-arm a JIT payment when an owned citizen would be auditable at the next boundary.
 *
 * This is the piece that makes away mode autonomous. Without it the bot wakes, finds
 * nothing armed, and idles while a citizen drifts — because JIT is one-shot (it disarms
 * itself after paying) and proactivePay only acts on citizens ALREADY 2+ behind, which by
 * then are auditable and, under a 1-epoch auto-pay cap, quoted above the cap and skipped.
 * So an unattended bot had no path from "citizen fell behind" to "citizen paid".
 *
 * Arms on 1+ behind, i.e. BEFORE the boundary that would make it auditable — the whole
 * point of a just-in-time payment. Deliberately skips:
 *   - citizens under audit — an audited citizen gets no automatic response at all, by
 *     explicit instruction; recovering one stays a manual decision
 *   - excluded citizens — the per-citizen opt-out means never pay, including here
 *   - an already-armed JIT — re-arming would reset its bookkeeping mid-flight
 *
 * Tied to away mode, which is what makes away mode autonomous rather than merely idle:
 * nobody is at the keyboard to arm, so without this the engine wakes, finds nothing armed
 * and idles while a citizen drifts. Running attended, arming stays a deliberate keypress.
 */
// Exported for tests: this is the one path that spends ETH with no keypress.
export async function maybeAutoArmPayment(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  if (!s.awayMode) return;
  if (s.jitEnabled && s.jitTargetEpoch !== null) return; // already armed; leave it alone
  const candidates = applyExclusions(ownedIds, "auto-arm");
  if (candidates.length === 0) return;

  const statuses = await batchGetOwnedStatuses(candidates, currentEpoch, nowSec, 1);
  const behind = statuses.filter(
    (st) => st.auditDueTimestamp === "0" && BigInt(st.lastEpochPaid) < currentEpoch,
  );
  if (behind.length === 0) return;

  const target = Number(currentEpoch + 1n);
  /**
   * Arm EXACTLY the citizens that are behind — not `[]`, which every consumer reads as
   * "every owned citizen" (see the `jitTokenIds.length > 0 ? ... : ownedIds` fallbacks).
   *
   * A current citizen does not need this boundary. Auditability is `lastEpochPaid + 2 <=
   * currentEpoch`, so at the boundary into epoch E+1 a citizen paid through E is only 1
   * behind — inside its grace epoch and not auditable. The ones actually at risk are
   * exactly those with `lastEpochPaid < currentEpoch`, which is `behind` here: they cross
   * to 2 behind and become auditable the moment the boundary lands.
   *
   * Both fire paths do re-check `lastEpochPaid` on-chain and skip a citizen that is already
   * current, so this is not what stops a wrongful payment — that guard is in
   * queuePreBoundaryPayments and jitPass. What arming the narrow set fixes is everything
   * around it: the panel no longer reports current citizens as armed to pay, the boundary
   * multicall stops carrying tokens whose answer cannot matter, and the one-shot disarm
   * settles on the set that actually owed rather than waiting on tokens that never did.
   *
   * Audit capacity is untouched: findPreBoundaryAuditors draws its auditor pool from owned
   * tokens, never from jitTokenIds, so an unarmed citizen still audits.
   */
  const armedIds = behind.map((b) => b.tokenId);
  runtime.saveStrategy({ enabled: true, jitEnabled: true, jitTargetEpoch: target, jitTokenIds: armedIds });
  resetJitState();
  activity.add({
    kind: "info",
    status: "info",
    message:
      `Auto-armed JIT payment for epoch ${target}: ${behind.length} citizen(s) behind ` +
      `(#${behind.map((b) => b.tokenId).join(", #")}). The boundary bundle will pay and audit ` +
      `together on the payment bid; JIT disarms itself once they are paid.`,
  });
  // The boundary timers were armed for an unarmed engine — re-arm them now that a payment
  // is due, or this boundary passes with the audit-only path still scheduled.
  scheduleJitBoundary();
  schedulePreBoundaryPay();
  schedulePreBoundaryAudit();
  schedulePreBoundaryBundle();
  // Always in away mode to reach here, and the wake window is picked from what is armed —
  // so it has to be recomputed now that a payment is due.
  scheduleAwayWake();
}

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
    // Auto-Pay Limit as a SPEND cap on whatever the chain actually quoted. For an
    // unaudited citizen that is one epoch's price however far behind it is (the skip),
    // so a 1-epoch cap does NOT block curing one — it only bites once the citizen is
    // audited and the quote becomes the full settle. See cappedAutoPayEpochs.
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
 * Retire a JIT arm whose target epoch is already OVER, before anything acts on it.
 *
 * An arm names exactly one epoch, and the only paths that clear it are a completed
 * jitPass and a manual disarm. So any arm that fails to pay — a `canSpend` deferral
 * (base fee over cap, balance short) leaves the token unmarked on purpose, and an arm
 * held while the engine is stopped never runs at all — survives into later epochs. From
 * that point every consumer of `jitTargetEpoch` computes a boundary that is in the PAST,
 * and each one reads that as "the boundary is here, go":
 *
 *   - scheduleJitBoundary saw deltaSec <= 0 and fired `tick()` IMMEDIATELY — so a stale
 *     arm paid mid-epoch, nowhere near a boundary. This is the "bot armed itself and
 *     triggered the payment early" report: the payment was real, the boundary was not.
 *   - firePreBoundaryBundle derived targetEpoch from the arm and simulated against a
 *     boundary timestamp days old.
 *   - the dashboard showed the stale epoch as the live target (166 while the chain was
 *     on 168), which is how this became visible at all.
 *   - maybeAutoArmPayment bails out on `already armed`, so in away mode a stale arm also
 *     BLOCKED re-arming for the real next boundary while citizens kept drifting.
 *
 * Expiring it is what makes away mode self-heal: the auto-arm immediately below this call
 * in tick() then arms for currentEpoch + 1 on the same pass. Deliberately loud — a
 * payment the user armed for did not happen, and going quiet here is what let a 65-hour-
 * stale arm sit on a dashboard looking active.
 *
 * `>= currentEpoch` is the keep condition, not `> currentEpoch`: an arm for the epoch we
 * are IN is still live and correct (jitPass pays the moment the chain reaches the target,
 * and a fire delayed past its own boundary lands here legitimately). Only an epoch that
 * has fully elapsed is stale.
 */
export function expireStaleJitArm(currentEpoch: bigint | null = runtime.currentEpoch): boolean {
  const s = runtime.strategy;
  if (!s.jitEnabled || s.jitTargetEpoch === null) return false;
  // Chain epoch when we have one, clock only as the boot-window fallback (armedEpochIsOver).
  const known = currentEpoch ?? runtime.currentEpoch;
  const over = known !== null ? BigInt(s.jitTargetEpoch) < known : armedEpochIsOver(s.jitTargetEpoch);
  if (!over) return false;
  const stale = s.jitTargetEpoch;
  const nowEpoch = currentEpoch ?? runtime.currentEpoch;
  runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
  resetJitState();
  activity.add({
    kind: "info",
    status: "skipped",
    message:
      `Disarmed a stale JIT payment arm: it was armed for epoch ${stale}` +
      (nowEpoch !== null ? `, but the chain is now on epoch ${nowEpoch}` : "") +
      `, so that boundary has passed and nothing it names can still be raced. No payment ` +
      `was sent for it. Re-arm if those citizens still owe — away mode re-arms for the ` +
      `next boundary on its own.`,
  });
  return true;
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

  const pinned = pinnedTargetSet(s);
  // Widen the AUDIT half of the sweep past the pins when asked. Kills are deliberately
  // left narrow (see the kill branch below), and the boundary paths call
  // fetchOffenseCandidates() without the flag, so this affects the mid-epoch sweep only.
  const wide = pinned !== null && s.sweepUnpinned && s.autoAudit;

  /**
   * Read the auditor pool FIRST, and bail before touching the candidate set if there is
   * nothing it could do with one.
   *
   * Audit capacity is per-epoch, so the sweep spends it in the first tick or two after a
   * boundary and then has none for the remaining ~7,000 ticks of the epoch. Those ticks
   * used to enumerate the field, multicall ownerOf over it, and multicall a status for
   * every rival — all to discover the pool was empty. That was already wasteful at pinned
   * width; with sweepUnpinned it is the whole live field, twice per tick.
   *
   * Costs one round-trip of concurrency on the ticks that DO have capacity (auditors and
   * statuses used to be fetched together). Worth it: the sweep is mid-epoch work with no
   * deadline — the boundary paths are what race — and the trade is one extra round-trip on
   * a handful of ticks against two large multicalls on thousands of them.
   *
   * Only safe to skip when autoKill is off, since a kill needs no auditor. With it on,
   * nextKillDeadlineSec also has to stay fresh for schedulePreBoundaryKill.
   */
  const auditors = s.autoAudit ? await findEligibleAuditors(ownedIds, currentEpoch) : [];
  if (auditors.length === 0 && !s.autoKill) {
    logger.debug("offense sweep: no audit capacity left this epoch and autoKill is off — skipping");
    return;
  }

  const live = (await fetchOffenseCandidatesWithSkips({ includeUnpinned: wide })).candidates;
  const owned = new Set(ownedIds.map((x) => x.toString()));

  /**
   * Price mid-epoch sweep audits at normal gas rather than the offense race tip.
   *
   * A mid-epoch audit contests nobody: the rivals who intended to cure did it at the
   * boundary, and if one does front-run us the revert refunds BOTH the 0.00069 fee and
   * the audit slot, so a lost cheap audit costs only gas. At a 131 gwei offense tip an
   * audit is ~0.0178 ETH against ~0.0010 at normal gas — 17x for a race that isn't
   * happening.
   *
   * The exception is the quiet window before a boundary. These txs come from the same
   * wallets the boundary fires use, so a cheap one still pending when the boundary
   * arrives holds a nonce the payment queues behind — and a higher nonce cannot be mined
   * before a lower one no matter what it pays. Inside the window we pay race gas so
   * nothing lingers. (The +1 gwei bump in normalFees is the other half of this: priced
   * exactly AT the node's suggestion, a tx is a coin-flip per block.)
   */
  const untilBoundary =
    runtime.startTime === null ? null : nextBoundarySec(runtime.startTime, nowSec) - nowSec;
  const inBoundaryQuietWindow =
    untilBoundary !== null && untilBoundary <= SWEEP_QUIET_WINDOW_SECONDS;
  const sweepNormalGas = s.sweepNormalGas && !inBoundaryQuietWindow;

  // Narrow to tokens we could actually act on BEFORE reading their status, then
  // fetch all their statuses in ONE multicall — a serial getTargetStatus per
  // token was hundreds/thousands of sequential RPC round-trips when offense
  // targets the whole field (viem's http batching can't coalesce awaited calls).
  const candidates = live.filter(({ id }) => {
    const key = id.toString();
    if (owned.has(key)) return false; // never audit our own
    // Unpinned tokens are in the set only when `wide`, and then only the audit branch
    // may act on them — the kill branch re-checks the pin itself.
    if (pinned && !pinned.has(key) && !wide) return false; // not on the target list
    return true;
  });
  const statuses = await batchGetTargetStatuses(candidates, currentEpoch, nowSec);

  // Auditors are handed out one per target so multiple rivals can be audited in a single
  // epoch instead of reusing one token and reverting with AuditLimitReached. The pool was
  // read above, before the candidate set, so an epoch with no capacity left costs nothing.
  let auditorIdx = 0;
  let noAuditorSkips = 0;
  // How many of this sweep's audits hit a rival that is NOT on the pinned list, so the
  // activity line can say the widening is what found them.
  let unpinnedAudits = 0;
  // Set when the sweep stopped early because the guardrail failed for a reason that
  // applies to the whole block (base fee over cap). Reported below so an offense pass
  // that did nothing is never silent about why.
  let fatalGuard: string | null = null;

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
      // Kills stay PINNED-ONLY even when the audit sweep is widened. A kill is a race
      // against every other killer for the same reward, so it needs race gas — and
      // widening a race-gas action is a spend increase the sweep widening deliberately
      // isn't. `wide` is the only way an unpinned token reaches this loop.
      if (pinned && !pinned.has(t.tokenId)) continue;
      const guard = await canSpend(0n, true);
      // A fee spike fails identically for every remaining target — stop the sweep
      // instead of re-awaiting the same verdict once per rival.
      if (guard.fatal) { fatalGuard = guard.reason ?? null; break; }
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
      // Auditor first, then afford-check against the wallet that actually holds it.
      const auditFrom = auditors[auditorIdx]!;
      const guard = await canSpend(AUDIT_COST_WEI, true, walletForToken(auditFrom));
      if (guard.fatal) { fatalGuard = guard.reason ?? null; break; }
      if (!guard.ok) continue;
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(auditFrom, tokenId), value: AUDIT_COST_WEI },
        "audit",
        {
          tokenId: auditFrom.toString(),
          targetTokenId: t.tokenId,
          message: `Audit delinquent #${t.tokenId} from #${auditFrom}`,
          // `race` is the mempool mirror, not the tip — keep it either way so the audit
          // lands without depending on a builder. Only the PRICE changes below.
          race: true,
          normalGas: sweepNormalGas,
        },
      );
      if (res?.ok) {
        auditorIdx++; // consume this auditor only if the audit actually went out
        if (pinned && !pinned.has(t.tokenId)) unpinnedAudits++;
      }
    }
  }

  if (noAuditorSkips > 0) {
    activity.add({
      kind: "info",
      status: "info",
      message: `Audited ${auditorIdx} rival(s) this sweep; ${noAuditorSkips} more auditable but no eligible auditor token left (each audits up to its per-epoch limit).`,
    });
  }

  // Debug, not activity: the sweep runs every block, so an entry per sweep would flood
  // the feed. What's worth recording is that the widening spent slots on rivals the pin
  // list wouldn't have reached — otherwise those audits read as pins the user forgot.
  if (unpinnedAudits > 0) {
    logger.debug(
      `offense sweep: ${unpinnedAudits} of ${auditorIdx} audit(s) went to unpinned rivals ` +
        `(sweepUnpinned) at ${sweepNormalGas ? "normal" : "race"} gas`,
    );
  }
  if (inBoundaryQuietWindow && s.sweepNormalGas) {
    logger.debug(
      `offense sweep: within ${SWEEP_QUIET_WINDOW_SECONDS}s of the boundary — using race gas ` +
        `so no cheap tx is left holding a nonce the boundary payment would queue behind`,
    );
  }

  // Debug, not activity: a fee spike lasts many blocks and the sweep runs every block, so
  // an activity entry here would flood the feed with the same line. The guardrail working
  // as configured isn't an event worth 50 rows.
  if (fatalGuard) {
    logger.debug(`offense sweep stopped early: ${fatalGuard}`);
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
  kind: "pay-taxes" | "use-bribe" | "audit",
  /**
   * May return an `actingTokenId` when the token that must SIGN differs from the token the
   * action is about. An audit is the case: it is owner-only on the AUDITOR, while the id the
   * user clicked is the rival being audited. Without this the holder lookup would run against a
   * token we do not own, and the call would be signed by the wrong wallet and revert on-chain
   * after paying gas.
   */
  build: () => Promise<{ intent: TxIntent; message: string; actingTokenId?: bigint } | { error: string }>,
): Promise<ManualActionResult> {
  if (!runtime.unlocked || !runtime.account) return { ok: false, message: "Unlock the wallet first" };
  if (runtime.gameState !== 1) return { ok: false, message: "Game is not live" };
  if (!(await waitForIdle())) return { ok: false, message: "Bot is busy submitting; try again in a moment" };

  ticking = true;
  tickingOwner = "a manual action from the dashboard";
  committedThisTickWei = new Map();
  beginBatch();
  try {
    await Promise.all([
      refreshSnapshot(),
      nonces.syncAll(runtime.addresses as Address[], appConfig.mode),
      // Resolve ownership BEFORE acting. A manual press can be the first thing that
      // happens after unlock, with the engine never having ticked — the owner map would
      // then be empty, act() would fall back to the primary, and an owner-only call
      // signed by the wrong wallet reverts on-chain after paying gas.
      fetchOwnedAcrossWallets(runtime.citizensAddress as Address),
    ]);
    const built = await build();
    if ("error" in built) return { ok: false, message: built.error };

    const acting = built.actingTokenId ?? tokenId;
    const holder = walletForToken(acting);
    if (!holder) {
      return { ok: false, message: `No unlocked wallet holds #${acting} — add its key to act on it` };
    }
    // Min-balance floor applies to the wallet that will actually pay, not the total
    // across wallets: a funded wallet must not let an empty one send a tx it cannot
    // cover. (gas is estimated generously here)
    const bal = holder.balanceWei ?? 0n;
    const floor = parseEther(String(runtime.strategy.minBalanceEth));
    const latest = await getLatestBlockCached();
    const gasWei = GAS_GUESS * ((latest.baseFeePerGas ?? 0n) * 2n + 2_000_000_000n);
    if (!canAffordSpend(bal, 0n, built.intent.value, gasWei, floor)) {
      return {
        ok: false,
        message: `${holder.label} would breach the ${runtime.strategy.minBalanceEth} ETH min-balance floor`,
      };
    }

    const res = await act(built.intent, kind, {
      tokenId: tokenId.toString(),
      wallet: holder, // owner-only call — sign with the wallet that holds it
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
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
  }
}

/**
 * Pay a token's outstanding tax so it becomes current (and any active audit is cleared).
 * Quotes on-chain with numEpochs=1 and sends exactly that, which is right either way:
 * one epoch's price for an unaudited citizen (the skip), or the full N x settle once it
 * is audited and the skip is revoked. Deliberately NOT subject to the Auto-Pay Limit —
 * that cap governs automatic payments only, and this is the manual rescue.
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

/**
 * Audit ONE rival now, on the network's normal gas — the manual counterpart to the boundary
 * race.
 *
 * Deliberately not a race: there is no bid, no boundary timestamp and no dynamic tip, just
 * `estimateMaxPriorityFeePerGas` like every other manual action. Pressing a button mid-epoch is
 * not competing for a slot, and inheriting the configured race tip would spend several hundred
 * gwei to do something nobody is contesting.
 *
 * The auditor is chosen for the user, because it is not a meaningful choice: any owned citizen
 * that is itself current and has an audit left this epoch does the same job. It is picked fresh
 * from `findEligibleAuditors`, which reads `auditsUsedInEpoch` on-chain, so a slot already spent
 * by an automatic sweep earlier in the epoch cannot be double-booked into `AuditLimitReached`.
 */
export async function manualAudit(targetTokenId: bigint): Promise<ManualActionResult> {
  return runManualAction(targetTokenId, "audit", async () => {
    const epoch = runtime.currentEpoch ?? 0n;
    /**
     * Through filterLiveTokenIds first, for two reasons: batchGetTargetStatuses needs the owner,
     * and a BURNED token still answers lastEpochPaid from a surviving mapping. Auditing one of
     * those reverts with ERC721NonexistentToken after paying gas, so a dead id must be refused
     * here rather than diagnosed from a failed transaction.
     */
    const live = await filterLiveTokenIds(runtime.citizensAddress as Address, [targetTokenId]);
    if (live.length === 0) return { error: `#${targetTokenId} no longer exists (killed and burned)` };
    const [target] = await batchGetTargetStatuses(live, epoch, BigInt(Math.floor(Date.now() / 1000)));
    if (!target) return { error: `Could not read #${targetTokenId}` };
    if (!target.auditable) {
      return {
        error:
          `#${targetTokenId} is not auditable right now (${target.epochsBehind} epoch(s) behind — ` +
          `needs 2). Nothing was sent.`,
      };
    }
    if (target.auditDueTimestamp !== "0") {
      return { error: `#${targetTokenId} is already under audit — a second audit would revert` };
    }
    const owned = await fetchOwnedAcrossWallets(runtime.citizensAddress as Address);
    const auditors = await findEligibleAuditors(owned, epoch);
    const from = auditors[0];
    if (from === undefined) {
      return {
        error:
          "No audit capacity left: every citizen you hold is either behind on taxes or has " +
          "already used its audits this epoch.",
      };
    }
    return {
      intent: { to: appConfig.gameAddress, data: encodeAudit(from, targetTokenId), value: AUDIT_COST_WEI },
      message: `Manual audit #${targetTokenId} from #${from} (normal gas)`,
      actingTokenId: from,
    };
  });
}

/** What a mass audit did, per target, so the UI can report partial success honestly. */
export interface MassAuditResult {
  ok: boolean;
  message: string;
  audited: { target: string; from: string; txHash?: string }[];
  skipped: { target: string; reason: string }[];
  /** Audit slots still unused after this run. */
  capacityLeft: number;
}

/**
 * Audit every auditable rival, up to the audit slots currently available.
 *
 * One batch, so on mainnet they go out as a single bundle and share one nonce run rather than
 * racing each other. Normal gas throughout, same reasoning as the single audit.
 *
 * Capacity is the binding constraint and it is reported rather than silently hit: a user with 3
 * slots and 8 auditable rivals should be told 5 were left alone, not left wondering. Targets are
 * taken in the order the panel shows them, so the result matches what was on screen.
 */
export async function manualAuditAll(): Promise<MassAuditResult> {
  const empty = { audited: [], skipped: [], capacityLeft: 0 };
  if (!runtime.unlocked || !runtime.account) return { ok: false, message: "Unlock the wallet first", ...empty };
  if (runtime.gameState !== 1) return { ok: false, message: "Game is not live", ...empty };
  if (!(await waitForIdle())) return { ok: false, message: "Bot is busy submitting; try again in a moment", ...empty };

  ticking = true;
  tickingOwner = "a manual audit-all";
  committedThisTickWei = new Map();
  beginBatch();
  const audited: { target: string; from: string; txHash?: string }[] = [];
  const skipped: { target: string; reason: string }[] = [];
  let capacityLeft = 0;
  try {
    const [owned] = await Promise.all([
      fetchOwnedAcrossWallets(runtime.citizensAddress as Address),
      refreshSnapshot(),
      nonces.syncAll(runtime.addresses as Address[], appConfig.mode),
    ]);
    const epoch = runtime.currentEpoch ?? 0n;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const auditors = await findEligibleAuditors(owned, epoch);
    capacityLeft = auditors.length;
    if (auditors.length === 0) {
      return {
        ok: false,
        message:
          "No audit capacity: every citizen you hold is either behind on taxes or has already " +
          "used its audits this epoch.",
        audited, skipped, capacityLeft: 0,
      };
    }

    // Same candidate set the offense sweep uses, so allies and emigrants are already excluded
    // and this cannot audit a teammate.
    const { candidates } = await fetchOffenseCandidatesWithSkips();
    const statuses = await batchGetTargetStatuses(candidates, epoch, nowSec);
    const auditable = statuses.filter((t) => t.auditable && t.auditDueTimestamp === "0");
    if (auditable.length === 0) {
      return { ok: false, message: "No rival is auditable right now", audited, skipped, capacityLeft };
    }

    let slot = 0;
    for (const t of auditable) {
      const from = auditors[slot];
      if (from === undefined) {
        skipped.push({ target: t.tokenId, reason: "no audit slots left" });
        continue;
      }
      const holder = walletForToken(from);
      if (!holder) {
        skipped.push({ target: t.tokenId, reason: `no unlocked wallet holds auditor #${from}` });
        continue;
      }
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(from, BigInt(t.tokenId)), value: AUDIT_COST_WEI },
        "audit",
        {
          tokenId: t.tokenId,
          wallet: holder,
          message: `Mass audit #${t.tokenId} from #${from} (normal gas)`,
          race: true,
          normalGas: true,
        },
      );
      if (res?.ok) {
        audited.push({ target: t.tokenId, from: from.toString(), txHash: res.txHash });
        slot++;
      } else {
        skipped.push({ target: t.tokenId, reason: res?.error ?? "failed to submit" });
      }
    }
    capacityLeft = Math.max(0, auditors.length - slot);
    const tail = skipped.length > 0 ? `, ${skipped.length} skipped` : "";
    return {
      ok: audited.length > 0,
      message:
        audited.length > 0
          ? `Audited ${audited.length} rival(s)${tail}. ${capacityLeft} audit slot(s) left this epoch.`
          : `Nothing audited${tail}`,
      audited, skipped, capacityLeft,
    };
  } catch (err) {
    const message = (err as Error).message;
    activity.add({ kind: "error", status: "skipped", message: `Mass audit failed: ${message}` });
    return { ok: false, message, audited, skipped, capacityLeft };
  } finally {
    await flushBatch();
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
  }
}

// `fireProactivePay` is true only for the tick armed by scheduleDefenseBoundary
// at the next epoch boundary — every other tick (block watch, poll, JIT/offense
// boundary ticks) leaves already-delinquent citizens alone.
async function tick(fireProactivePay = false, routine = false): Promise<void> {
  if (ticking) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  /**
   * Stay out of an armed boundary race.
   *
   * `routine` defaults to FALSE so this fails safe: a boundary-timed tick that forgot to
   * identify itself still runs. Only the block subscription and the poll opt in.
   */
  if (routine) {
    const boundary = routineTickMustYield(BigInt(Math.floor(Date.now() / 1000)));
    if (boundary !== null) {
      logger.debug(`routine tick skipped: inside the armed boundary window for ${boundary}`);
      return;
    }
  }
  ticking = true;
  tickingOwner = routine ? "a routine tick" : "a boundary tick";
  committedThisTickWei = new Map(); // fresh spend budget for this tick
  beginBatch();
  try {
    // Snapshot + nonce sync are independent RPC reads — run them together so the
    // boundary tick shaves a round-trip before it can submit anything.
    await Promise.all([
      refreshSnapshot(),
      nonces.syncAll(runtime.addresses as Address[], appConfig.mode),
    ]);

    if (runtime.gameState !== 1) {
      // Not LIVE — nothing to do.
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const currentEpoch = runtime.currentEpoch ?? 0n;

    const ownedIds = await fetchOwnedAcrossWallets(runtime.citizensAddress as Address);
    // A stale arm is already gone by here: refreshSnapshot above expires it as soon as the
    // epoch is known. That ordering matters — maybeAutoArmPayment bails on "already armed",
    // so the dead arm has to clear BEFORE it runs or away mode never re-arms for the real
    // next boundary.
    await maybeAutoArmPayment(ownedIds, currentEpoch, nowSec);

    if (runtime.strategy.enabled) {
      // The only automatic response to an audit, and off unless opted in. Runs before the
      // pre-audit passes because it is the one with a death clock on it, and every tick
      // rather than only on boundary ticks — an audit expires 24h after it was cast, not
      // on a boundary, so waiting for one could be waiting past the deadline.
      await maybeAutoDefendAudit(ownedIds, currentEpoch, nowSec);
      // Otherwise: pre-audit protection only (see the note above proactivePayPass).
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
    nonces.resetAll();
    ticking = false;
    tickingOwner = null;
  }
}

/**
 * Wire the stale-arm check into runtime.applyChainSnapshot, so EVERY path that learns the
 * epoch retires a dead JIT arm — the engine tick, the unlock handler, the away-mode read and
 * POST /api/refresh alike. Registered here rather than imported by runtime.ts because that
 * would be an import cycle (this module already imports runtime), and because the expiry
 * needs this module's JIT bookkeeping via resetJitState.
 *
 * Module side effect on purpose: any future caller of applyChainSnapshot inherits the guard
 * without knowing it exists, which is the property that the previous per-call-site version
 * failed to provide.
 */
runtime.registerStaleArmCheck((currentEpoch) => {
  expireStaleJitArm(currentEpoch);
});
