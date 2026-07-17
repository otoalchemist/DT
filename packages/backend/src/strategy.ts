import { parseEther, formatEther, type Address } from "viem";
import { AUDIT_COST_WEI, WINNERS, EPOCH_DURATION_SECONDS, BASE_TAX_RATE_WEI } from "@dat-bot/shared";
import { publicClient, wsClient } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { activity } from "./activity.js";
import { nonceManager } from "./nonce.js";
import {
  getGameSnapshot,
  getOwnedTokenStatus,
  getTargetStatus,
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
  fetchCandidateTokenIds,
  ownershipIndexingAvailable,
} from "./index-tokens.js";
import { submitTx, type TxIntent, type SubmitResult } from "./flashbots.js";
import { resolveGas, canAffordSpend, isEligibleAuditor, isAuditable, preBoundaryTaxWei } from "./logic.js";
import { logger } from "./logger.js";

const TICK_MS = 12_000; // fallback poll interval when WebSocket unavailable
const GAS_GUESS = 200_000n; // for pre-flight spend-cap checks only

let timer: NodeJS.Timeout | null = null;
let boundaryTimer: NodeJS.Timeout | null = null;
let offenseBoundaryTimer: NodeJS.Timeout | null = null;
let defenseBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryTimer: NodeJS.Timeout | null = null;
let preBoundaryAuditTimer: NodeJS.Timeout | null = null;
let preBoundaryKillTimer: NodeJS.Timeout | null = null;
let unwatchBlocks: (() => void) | null = null;
let ticking = false;
// Total wei committed to spend so far in the current tick (value + gas of each
// submitted tx). Reset at the top of every tick; consulted by canSpend so the
// min-balance floor holds across all spends in a tick, not just each in isolation.
let committedThisTickWei = 0n;

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
    // React on every new block (~100-500ms latency vs up to 12s with polling).
    unwatchBlocks = wsClient.watchBlocks({
      onBlock: () => void tick(),
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
  if (offenseBoundaryTimer) clearTimeout(offenseBoundaryTimer);
  if (defenseBoundaryTimer) clearTimeout(defenseBoundaryTimer);
  if (preBoundaryTimer) clearTimeout(preBoundaryTimer);
  if (preBoundaryAuditTimer) clearTimeout(preBoundaryAuditTimer);
  if (preBoundaryKillTimer) clearTimeout(preBoundaryKillTimer);
  if (unwatchBlocks) unwatchBlocks();
  timer = null;
  boundaryTimer = null;
  offenseBoundaryTimer = null;
  defenseBoundaryTimer = null;
  preBoundaryTimer = null;
  preBoundaryAuditTimer = null;
  preBoundaryKillTimer = null;
  unwatchBlocks = null;
  runtime.running = false;
  runtime.emitStatus();
  activity.add({ kind: "info", status: "info", message: "Engine paused" });
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
 * Fire the opt-in pre-boundary JIT payment: for each armed token still behind on
 * the target epoch, submit payTaxes with a value computed off-chain for that
 * epoch, skipping simulation, aiming to land in the boundary block. Best-effort —
 * it does NOT mark jitSubmitted, so the ordinary +500ms JIT tick (with real
 * simulation + on-chain value) remains the authoritative fallback if a pre-submit
 * reverts or loses the race.
 */
async function firePreBoundaryPay(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryPay || !s.jitEnabled || s.jitTargetEpoch === null) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryPay(), 150); return; } // don't overlap nonce use
  ticking = true;
  committedThisTickWei = 0n;
  const address = runtime.account.address;
  const targetEpoch = BigInt(s.jitTargetEpoch);
  // The instant the target epoch begins — we simulate there so the value is
  // validated against the epoch the tx will actually execute in.
  const boundaryTs = (runtime.startTime ?? 0n) + (targetEpoch - 1n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const selected = s.jitTokenIds.length > 0 ? s.jitTokenIds.map((x) => BigInt(x)) : ownedIds;
    if (selected.length === 0) return;

    // One multicall for lastEpochPaid across the selected tokens.
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: selected.map((id) => ({ ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const })),
    });
    for (let i = 0; i < selected.length; i++) {
      const r = results[i];
      if (r?.status !== "success") continue;
      const lastEpochPaid = r.result as bigint;
      if (lastEpochPaid >= targetEpoch) continue; // already current for the target
      const value = preBoundaryTaxWei(lastEpochPaid, targetEpoch, 1, BASE_TAX_RATE_WEI);
      if (value === 0n) continue;
      const key = selected[i]!.toString();
      const guard = await canSpend(value, false); // enforces max-base-fee, floor, max-payment caps
      if (!guard.ok) {
        activity.add({ kind: "pay-taxes", status: "skipped", tokenId: key, message: `Defer pre-boundary pay #${key}: ${guard.reason}` });
        continue;
      }
      await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(selected[i]!, 1), value, gas: PRE_BOUNDARY_GAS },
        "pay-taxes",
        { tokenId: key, message: `Pre-boundary pay #${key} for epoch ${targetEpoch} = ${formatEther(value)} ETH (boundary race)`, race: true, simTimestamp: boundaryTs },
      );
    }
  } catch (err) {
    logger.error("pre-boundary pay error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary pay error: ${(err as Error).message}` });
  } finally {
    nonceManager.reset();
    ticking = false;
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
    // 0n audits used because targetEpoch is a fresh epoch we haven't acted in yet.
    if (isEligibleAuditor(lep.result as bigint, targetEpoch, 0n, limit.result as bigint)) {
      eligible.push(ownedIds[i]!);
    }
  }
  return eligible;
}

/** Arm a pre-submit of audits ~preBoundaryLeadMs before the next epoch boundary. */
export function schedulePreBoundaryAudit(): void {
  if (preBoundaryAuditTimer) {
    clearTimeout(preBoundaryAuditTimer);
    preBoundaryAuditTimer = null;
  }
  const s = runtime.strategy;
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
async function firePreBoundaryAudit(): Promise<void> {
  const s = runtime.strategy;
  if (!s.preBoundaryAudit || !s.offenseEnabled || !s.autoAudit) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  if (runtime.gameState !== 1) return; // only act while the game is LIVE
  if (ticking) { setTimeout(() => void firePreBoundaryAudit(), 150); return; }
  if (s.endgameOnlyWithin !== null && (runtime.citizenSupply ?? 0n) - WINNERS > BigInt(s.endgameOnlyWithin)) return;
  ticking = true;
  committedThisTickWei = 0n;
  const address = runtime.account.address;
  const targetEpoch = (runtime.currentEpoch ?? 0n) + 1n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Simulate at the boundary instant, where the target actually becomes auditable.
  const boundaryTs = (runtime.startTime ?? 0n) + (runtime.currentEpoch ?? 0n) * EPOCH_DURATION_SECONDS;
  try {
    await nonceManager.sync(address, appConfig.mode);
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const auditors = await findPreBoundaryAuditors(ownedIds, targetEpoch);
    if (auditors.length === 0) return;

    const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
    const live = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
    // Auditable AT the target epoch, not already under audit.
    const statuses = await batchGetTargetStatuses(live, targetEpoch, nowSec);
    let idx = 0;
    for (const t of statuses) {
      if (idx >= auditors.length) break;
      if (owned.has(t.tokenId)) continue;
      if (pinned && !pinned.has(t.tokenId)) continue;
      if (t.auditDueTimestamp !== "0") continue; // already under audit
      if (!isAuditable(BigInt(t.lastEpochPaid), targetEpoch)) continue; // won't be auditable at the boundary
      const guard = await canSpend(AUDIT_COST_WEI, true);
      if (!guard.ok) continue;
      const from = auditors[idx]!;
      const res = await act(
        { to: appConfig.gameAddress, data: encodeAudit(from, BigInt(t.tokenId)), value: AUDIT_COST_WEI, gas: PRE_BOUNDARY_OFFENSE_GAS },
        "audit",
        { tokenId: from.toString(), targetTokenId: t.tokenId, message: `Pre-boundary audit #${t.tokenId} from #${from} for epoch ${targetEpoch} (boundary race)`, race: true, simTimestamp: boundaryTs },
      );
      if (res?.ok) idx++;
    }
  } catch (err) {
    logger.error("pre-boundary audit error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary audit error: ${(err as Error).message}` });
  } finally {
    nonceManager.reset();
    ticking = false;
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
  const address = runtime.account.address;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Pre-submit kills for audits expiring within our lead + one slot of headroom.
  const windowSec = BigInt(Math.ceil(effectiveLeadMs() / 1000) + 12);
  try {
    await nonceManager.sync(address, appConfig.mode);
    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);
    const candidateIds = await fetchCandidateTokenIds(runtime.citizensAddress as Address);
    const live = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
    const owned = new Set(ownedIds.map((x) => x.toString()));
    const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;
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
    }
  } catch (err) {
    logger.error("pre-boundary kill error:", (err as Error).message);
    activity.add({ kind: "error", status: "skipped", message: `Pre-boundary kill error: ${(err as Error).message}` });
  } finally {
    nonceManager.reset();
    ticking = false;
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
  offenseBoundaryTimer = setTimeout(() => fireBoundaryTick(false), delayMs);
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
  const [snap, balance, block] = await Promise.all([
    getGameSnapshot(),
    publicClient.getBalance({ address }),
    publicClient.getBlockNumber(),
  ]);
  runtime.gameState = snap.state;
  runtime.currentEpoch = snap.currentEpoch;
  runtime.citizenSupply = snap.citizenSupply;
  runtime.citizensAddress = snap.citizensAddress;
  runtime.startTime = snap.startTime;
  runtime.balanceWei = balance;
  runtime.lastBlock = block;
  runtime.emitStatus();
  scheduleJitBoundary();
  schedulePreBoundaryPay();
  schedulePreBoundaryAudit();
  scheduleDefenseBoundary();
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors?
 *  `offense` selects the audit/kill gas profile so the base-fee cap and gas
 *  estimate match what `submitTx` will actually bid. */
async function canSpend(valueWei: bigint, offense: boolean): Promise<{ ok: boolean; reason?: string }> {
  const s = runtime.strategy;
  const gas = resolveGas(s, offense);
  const block = await publicClient.getBlock({ blockTag: "latest" });
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
async function trackReceipt(entryId: string, txHash: `0x${string}`): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const block = receipt.blockNumber?.toString();
    activity.update(entryId, {
      status: receipt.status === "success" ? "included" : "reverted",
      targetBlock: block,
    });
  } catch (err) {
    // Timed out or RPC error — leave the entry as "submitted".
    logger.warn(`receipt tracking for ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: { tokenId?: string; targetTokenId?: string; message: string; race?: boolean; simTimestamp?: bigint },
): Promise<SubmitResult | null> {
  const dryRun = runtime.strategy.dryRun;
  const offense = kind === "audit" || kind === "kill";
  try {
    const result = await submitTx(intent, {
      dryRun,
      // In mainnet mode a bundle only lands if a builder we sent it to wins the
      // slot — so PAYMENTS always mirror to the public mempool as a fallback: one
      // that never lands can cost a citizen, and a tax payment isn't meaningfully
      // front-runnable (rivals already see the delinquency on-chain).
      // OFFENSE stays opt-in (racePublicMempool): a visible pending audit lets the
      // target escape by paying first, so privacy is worth something there.
      race: offense ? (ctx.race && runtime.strategy.racePublicMempool) : true,
      offense,
      simTimestamp: ctx.simTimestamp,
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
    if (!dryRun) runtime.recordSpend(result.valueWei + result.gasWei);
    // Count it against this tick's budget so later canSpend checks in the same
    // tick see the reduced headroom (applies in dry-run too, to simulate faithfully).
    committedThisTickWei += result.valueWei + result.gasWei;
    const entry = activity.add({
      kind,
      status: dryRun ? "dry-run" : "submitted",
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
    // Watch for the receipt so the entry flips submitted -> included/reverted.
    // Only public-mempool submissions expose a tx hash; pure Flashbots bundles
    // (bundleHash only) stay "submitted" since there's nothing to poll.
    if (!dryRun && result.txHash) void trackReceipt(entry.id, result.txHash);
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

async function defensePass(
  ownedIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<void> {
  const s = runtime.strategy;
  for (const tokenId of ownedIds) {
    const st = await getOwnedTokenStatus(tokenId, currentEpoch, nowSec, s.prepayEpochs);
    const underAudit = st.auditDueTimestamp !== "0";
    const bribes = BigInt(st.bribeBalance);

    // 1) Under audit and within safety buffer -> clear it.
    if (underAudit && (st.secondsUntilKillable ?? 0) <= s.auditSafetyBufferSeconds) {
      if (bribes > 0n) {
        // Bribe is free (value 0) but still costs gas — apply the same guardrail
        // as the pay-to-clear path below so the base-fee cap holds consistently.
        const guard = await canSpend(0n, false);
        if (!guard.ok) {
          activity.add({ kind: "use-bribe", status: "skipped", tokenId: st.tokenId, message: `Defer bribe clear #${st.tokenId}: ${guard.reason}` });
          continue;
        }
        await act(
          { to: appConfig.gameAddress, data: encodeUseBribe(tokenId), value: 0n },
          "use-bribe",
          { tokenId: st.tokenId, message: `Clear audit on #${st.tokenId} with bribe` },
        );
        continue;
      }
      const value = BigInt(st.estimatedPayWei); // already fetched by getOwnedTokenStatus (same epochs)
      const guard = await canSpend(value, false);
      if (!guard.ok) {
        activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer pay #${st.tokenId}: ${guard.reason}` });
        continue;
      }
      await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, s.prepayEpochs), value },
        "pay-taxes",
        { tokenId: st.tokenId, message: `Pay taxes on audited #${st.tokenId} (${s.prepayEpochs} epoch) = ${formatEther(value)} ETH` },
      );
      continue;
    }
  }
}

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
  for (const tokenId of ownedIds) {
    const key = tokenId.toString();
    if (proactivePaySubmitted.has(key)) continue;

    const st = await getOwnedTokenStatus(tokenId, currentEpoch, nowSec, s.prepayEpochs);
    const underAudit = st.auditDueTimestamp !== "0";
    if (underAudit || st.risk !== "delinquent") continue;

    const value = BigInt(st.estimatedPayWei); // already fetched by getOwnedTokenStatus (same epochs)
    if (value === 0n) continue;
    const guard = await canSpend(value, false);
    if (!guard.ok) {
      activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer proactive pay #${st.tokenId}: ${guard.reason}` });
      continue;
    }
    proactivePaySubmitted.add(key); // mark before awaiting so a rapid re-fire can't double-submit
    await act(
      { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, s.prepayEpochs), value },
      "pay-taxes",
      { tokenId: st.tokenId, message: `Proactive pay #${st.tokenId} (${s.prepayEpochs} epoch) = ${formatEther(value)} ETH` },
    );
  }
}

/**
 * Just-in-time single-epoch payment. When armed for a target epoch, pays exactly
 * one epoch for each selected token the moment the chain reaches that epoch, then
 * auto-disarms. Reads the exact owed amount on-chain so the value is always correct.
 */
async function jitPass(
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

  const selected = s.jitTokenIds.length > 0 ? s.jitTokenIds.map((x) => BigInt(x)) : ownedIds;
  if (selected.length === 0) return; // nothing owned yet — stay armed

  for (const tokenId of selected) {
    const key = tokenId.toString();
    if (jitSubmitted.has(key)) continue;

    const st = await getOwnedTokenStatus(tokenId, currentEpoch, nowSec, 1);
    if (BigInt(st.lastEpochPaid) >= currentEpoch) {
      jitSubmitted.add(key); // already current for this epoch
      continue;
    }
    const value = BigInt(st.estimatedPayWei); // already fetched by getOwnedTokenStatus (1 epoch)
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
    if (res) jitSubmitted.add(key);
  }

  // One-shot: disarm once every selected token has been submitted/covered.
  if (selected.every((t) => jitSubmitted.has(t.toString()))) {
    runtime.saveStrategy({ jitEnabled: false, jitTargetEpoch: null });
    activity.add({ kind: "info", status: "info", message: `JIT payment complete for epoch ${target}; disarmed.` });
  }
}

/**
 * Build the pool of owned tokens usable as audit "from" tokens this tick — each
 * not itself auditable and still under its per-epoch audit limit. Reading
 * auditsUsedInEpoch on-chain means a token already used earlier this epoch (even
 * in a prior tick) is excluded, so we never reuse one and hit AuditLimitReached.
 * Each entry can back exactly one audit (a normal token audits once/epoch).
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
    if (isEligibleAuditor(lep.result as bigint, currentEpoch, used.result as bigint, limit.result as bigint)) {
      eligible.push(ownedIds[i]!);
    }
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
  const live = await filterLiveTokenIds(runtime.citizensAddress as Address, candidateIds);
  const owned = new Set(ownedIds.map((x) => x.toString()));
  const pinned = s.offenseTargetTokenIds.length > 0 ? new Set(s.offenseTargetTokenIds) : null;

  // Pool of owned tokens we can audit FROM this tick (each backs one audit,
  // since a token audits at most `auditLimit` times per epoch). We hand them out
  // one per target so multiple rivals can be audited in a single epoch instead
  // of reusing one token and reverting on the second with AuditLimitReached.
  const auditors = await findEligibleAuditors(ownedIds, currentEpoch);
  let auditorIdx = 0;
  let noAuditorSkips = 0;

  // Track the soonest not-yet-expired audit deadline so the boundary scheduler
  // can pre-empt the exact moment a kill becomes valid. Reset each sweep.
  let soonestKillDeadline: bigint | null = null;

  for (const { id: tokenId, owner } of live) {
    if (owned.has(tokenId.toString())) continue;
    if (pinned && !pinned.has(tokenId.toString())) continue; // not on the target list
    const t = await getTargetStatus(tokenId, owner, currentEpoch, nowSec);

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

  // Publish the nearest kill deadline and (re)arm the pre-emptive boundary tick.
  nextKillDeadlineSec = soonestKillDeadline;
  scheduleOffenseBoundary();
  schedulePreBoundaryKill();
}

// `fireProactivePay` is true only for the tick armed by scheduleDefenseBoundary
// at the next epoch boundary — every other tick (block watch, poll, JIT/offense
// boundary ticks) leaves already-delinquent citizens alone.
async function tick(fireProactivePay = false): Promise<void> {
  if (ticking) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  ticking = true;
  committedThisTickWei = 0n; // fresh spend budget for this tick
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
      await defensePass(ownedIds, currentEpoch, nowSec);
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
    nonceManager.reset();
    ticking = false;
  }
}
