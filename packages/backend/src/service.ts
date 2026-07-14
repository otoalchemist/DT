import type { Address } from "viem";
import type { OwnedTokenStatus, TargetTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, getOwnedTokenStatus, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds } from "./index-tokens.js";

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
