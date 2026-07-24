import type { Address } from "viem";
import type { OwnedTokenStatus, TargetTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, getOwnedTokenStatus, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds } from "./index-tokens.js";
import { logger } from "./logger.js";

// Read-only helpers used by the API for the dashboard (independent of the engine loop).

export async function readOwnedStatuses(): Promise<OwnedTokenStatus[]> {
  if (!runtime.account) return [];
  const snap = await getGameSnapshot();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ids = await fetchOwnedTokenIds(snap.citizensAddress, runtime.account.address);
  const out: OwnedTokenStatus[] = [];
  for (const id of ids) {
    out.push(
      await getOwnedTokenStatus(id, snap.currentEpoch, nowSec, runtime.strategy.prepayEpochs),
    );
  }
  return out;
}

export async function readTargets(outputLimit = 50): Promise<TargetTokenStatus[]> {
  const snap = await getGameSnapshot();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  const pinnedIds = runtime.strategy.offenseTargetTokenIds.map((x) => BigInt(x));
  const pinnedSet = new Set(pinnedIds.map((x) => x.toString()));

  const candidates = await fetchCandidateTokenIds(snap.citizensAddress);
  const unionIds = dedupe([...pinnedIds, ...candidates]);
  const live = await filterLiveTokenIds(snap.citizensAddress, unionIds);

  // Fetch all statuses in ONE multicall instead of one per token.
  const allStatuses = await batchGetTargetStatuses(live, snap.currentEpoch, nowSec);

  // The dashboard "Rival targets" panel derives its rows (incl. "My rivals") from
  // this result, so an empty return renders as "No pinned rivals" even when pins are
  // configured — easy to misread as a config problem. Make the read's shape visible:
  // warn loudly for the telling failure (pins configured but none survived liveness —
  // a bad RPC/citizens address, or every pin genuinely burned), else a debug summary.
  const livePinned = live.reduce((n, t) => (pinnedSet.has(t.id.toString()) ? n + 1 : n), 0);
  if (pinnedIds.length > 0 && livePinned === 0) {
    logger.warn(
      `readTargets: ${pinnedIds.length} pinned target(s) configured but 0 survived the liveness check ` +
        `(union ${unionIds.length}, live ${live.length}) — check RPC / citizens address; pinned rivals won't show.`,
    );
  } else {
    logger.debug(
      `readTargets: pinned=${pinnedIds.length} candidates=${candidates.length} union=${unionIds.length} live=${live.length} livePinned=${livePinned}`,
    );
  }

  const pinned: TargetTokenStatus[] = [];
  const actionable: TargetTokenStatus[] = [];
  for (const t of allStatuses) {
    if (pinnedSet.has(t.tokenId)) {
      pinned.push(t);
    } else if (t.delinquent || t.killable || t.auditDueTimestamp !== "0") {
      actionable.push(t);
    }
  }

  // Pinned rivals always appear in full; non-pinned actionable tokens fill remaining slots.
  return [...pinned, ...actionable.slice(0, Math.max(0, outputLimit - pinned.length))];
}

function dedupe(ids: bigint[]): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const id of ids) {
    const k = id.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(id);
  }
  return out;
}
