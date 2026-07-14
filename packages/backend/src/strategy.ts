import { parseEther, formatEther, type Address } from "viem";
import { AUDIT_COST_WEI, WINNERS, EPOCH_DURATION_SECONDS } from "@dat-bot/shared";
import { publicClient, wsClient } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { activity } from "./activity.js";
import { nonceManager } from "./nonce.js";
import {
  getGameSnapshot,
  getOwnedTokenStatus,
  getTargetStatus,
  filterLiveTokenIds,
  estimateTaxes,
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
import { logger } from "./logger.js";

const TICK_MS = 12_000; // fallback poll interval when WebSocket unavailable
const GAS_GUESS = 200_000n; // for pre-flight spend-cap checks only

let timer: NodeJS.Timeout | null = null;
let boundaryTimer: NodeJS.Timeout | null = null;
let offenseBoundaryTimer: NodeJS.Timeout | null = null;
let unwatchBlocks: (() => void) | null = null;
let ticking = false;

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
  if (unwatchBlocks) unwatchBlocks();
  timer = null;
  boundaryTimer = null;
  offenseBoundaryTimer = null;
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
  boundaryTimer = setTimeout(() => void tick(), delayMs);
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
  offenseBoundaryTimer = setTimeout(() => void tick(), delayMs);
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
}

/** Pre-flight guardrail: can we afford this spend without breaching caps/floors? */
async function canSpend(valueWei: bigint): Promise<{ ok: boolean; reason?: string }> {
  const s = runtime.strategy;
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 0n;
  const maxBase = BigInt(Math.round(s.maxBaseFeeGwei * 1e9));
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

  const gasWei = GAS_GUESS * (baseFee * 2n + BigInt(Math.round(s.priorityFeeGwei * 1e9)));
  const total = valueWei + gasWei;

  const bal = runtime.balanceWei ?? 0n;
  const floor = parseEther(String(s.minBalanceEth));
  if (bal - total < floor) return { ok: false, reason: "would breach min-balance floor" };

  return { ok: true };
}

async function act(
  intent: TxIntent,
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill",
  ctx: { tokenId?: string; targetTokenId?: string; message: string; race?: boolean },
): Promise<SubmitResult | null> {
  const dryRun = runtime.strategy.dryRun;
  try {
    const result = await submitTx(intent, { dryRun, race: ctx.race && runtime.strategy.racePublicMempool });
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
    activity.add({
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
        await act(
          { to: appConfig.gameAddress, data: encodeUseBribe(tokenId), value: 0n },
          "use-bribe",
          { tokenId: st.tokenId, message: `Clear audit on #${st.tokenId} with bribe` },
        );
        continue;
      }
      const value = await estimateTaxes(tokenId, s.prepayEpochs);
      const guard = await canSpend(value);
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

    // 2) Proactively pay if delinquent (auditable) but not yet audited.
    if (s.proactivePay && !underAudit && st.risk === "delinquent") {
      const value = await estimateTaxes(tokenId, s.prepayEpochs);
      if (value === 0n) continue;
      const guard = await canSpend(value);
      if (!guard.ok) {
        activity.add({ kind: "pay-taxes", status: "skipped", tokenId: st.tokenId, message: `Defer proactive pay #${st.tokenId}: ${guard.reason}` });
        continue;
      }
      await act(
        { to: appConfig.gameAddress, data: encodePayTaxes(tokenId, s.prepayEpochs), value },
        "pay-taxes",
        { tokenId: st.tokenId, message: `Proactive pay #${st.tokenId} (${s.prepayEpochs} epoch) = ${formatEther(value)} ETH` },
      );
    }
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
    const value = await estimateTaxes(tokenId, 1);
    if (value === 0n) {
      jitSubmitted.add(key);
      continue;
    }
    const guard = await canSpend(value);
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

async function findEligibleAuditor(ownedIds: bigint[], currentEpoch: bigint): Promise<bigint | undefined> {
  if (ownedIds.length === 0) return undefined;
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: ownedIds.map((id) => ({ ...gameContract, functionName: "lastEpochPaid" as const, args: [id] as const })),
  });
  for (let i = 0; i < ownedIds.length; i++) {
    const r = results[i];
    if (r?.status === "success" && (r.result as bigint) >= currentEpoch) return ownedIds[i];
  }
  return undefined;
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

  // Find an owned token that is current (lastEpochPaid >= currentEpoch) to use as the auditor.
  // Auditing from a delinquent token reverts on-chain.
  const auditFrom = await findEligibleAuditor(ownedIds, currentEpoch);

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
      const guard = await canSpend(0n);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeKill(tokenId), value: 0n },
        "kill",
        { targetTokenId: t.tokenId, message: `Kill expired-audit #${t.tokenId}`, race: true },
      );
      continue;
    }

    if (s.autoAudit && t.auditable && auditFrom !== undefined) {
      const guard = await canSpend(AUDIT_COST_WEI);
      if (!guard.ok) continue;
      await act(
        { to: appConfig.gameAddress, data: encodeAudit(auditFrom, tokenId), value: AUDIT_COST_WEI },
        "audit",
        { tokenId: auditFrom.toString(), targetTokenId: t.tokenId, message: `Audit delinquent #${t.tokenId} from #${auditFrom}`, race: true },
      );
    }
  }

  // Publish the nearest kill deadline and (re)arm the pre-emptive boundary tick.
  nextKillDeadlineSec = soonestKillDeadline;
  scheduleOffenseBoundary();
}

async function tick(): Promise<void> {
  if (ticking) return;
  if (!runtime.running || !runtime.unlocked || !runtime.account) return;
  ticking = true;
  const address = runtime.account.address;
  try {
    await refreshSnapshot(address);

    if (runtime.gameState !== 1) {
      // Not LIVE — nothing to do.
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const currentEpoch = runtime.currentEpoch ?? 0n;

    await nonceManager.sync(address);

    const ownedIds = await fetchOwnedTokenIds(runtime.citizensAddress as Address, address);

    if (runtime.strategy.enabled) {
      await defensePass(ownedIds, currentEpoch, nowSec);
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
