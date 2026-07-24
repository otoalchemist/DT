import type { Address } from "viem";
import type { OwnedTokenStatus, TargetTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, batchGetOwnedStatuses, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds } from "./index-tokens.js";
import { makeIdCache } from "./id-cache.js";
import { logger } from "./logger.js";

// Read-only helpers used by the API for the dashboard (independent of the engine loop).

export async function readOwnedStatuses(): Promise<OwnedTokenStatus[]> {
  if (!runtime.account) return [];
  const snap = await getGameSnapshot();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ids = await fetchOwnedTokenIds(snap.citizensAddress, runtime.account.address);
  // ONE multicall for every owned token's status, not a serial per-token round-trip.
  return batchGetOwnedStatuses(ids, snap.currentEpoch, nowSec, runtime.strategy.prepayEpochs);
}

// The live-citizen set (full-collection enumeration + ownerOf liveness) is the slow
// part of readTargets — ~15s cold, because the collection isn't ERC721Enumerable and
// Alchemy pages the whole minted range (thousands, ~99% burned) 100 at a time — but
// it changes only when a citizen is killed/burned. Cache it (SWR, 60s) so only the
// first load pays the cost and the rest serve instantly with a background refresh.
// Token STATUS (delinquency / audit) is deliberately NOT cached here: it's re-read
// fresh each call over the small live set (cheap) and must stay current.
const LIVE_CANDIDATES_TTL_MS = 60_000;
const liveCandidatesCache = makeIdCache<{ id: bigint; owner: Address }[]>({
  onError: (e) => logger.warn("Live-candidate refresh failed:", (e as Error).message),
});

/** Live (non-burned) citizen tokens from the full-collection enumeration, cached SWR. */
async function getLiveCandidates(citizens: Address): Promise<{ id: bigint; owner: Address }[]> {
  return liveCandidatesCache(citizens.toLowerCase(), LIVE_CANDIDATES_TTL_MS, async () => {
    const candidates = await fetchCandidateTokenIds(citizens);
    return filterLiveTokenIds(citizens, candidates);
  });
}

/** Warm the candidate + live-set caches up front (fire-and-forget) so the first
 *  dashboard load doesn't pay the ~15s cold enumeration. Needs no unlocked wallet. */
export async function prewarmTargets(): Promise<void> {
  try {
    const snap = await getGameSnapshot();
    await getLiveCandidates(snap.citizensAddress);
    logger.debug("target cache prewarmed");
  } catch (err) {
    logger.warn("target prewarm failed:", (err as Error).message);
  }
}

export async function readTargets(outputLimit = 50): Promise<TargetTokenStatus[]> {
  const snap = await getGameSnapshot();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  const pinnedIds = runtime.strategy.offenseTargetTokenIds.map((x) => BigInt(x));
  const pinnedSet = new Set(pinnedIds.map((x) => x.toString()));

  // "Others" come from the cached live set. Pins are liveness-checked directly (cheap,
  // just the configured IDs) and unioned in, so a pin outside the cached candidate set
  // — or one just added — shows immediately without waiting for the 60s refresh.
  const [liveCandidates, livePins] = await Promise.all([
    getLiveCandidates(snap.citizensAddress),
    filterLiveTokenIds(snap.citizensAddress, pinnedIds),
  ]);
  const liveById = new Map<string, { id: bigint; owner: Address }>();
  for (const t of liveCandidates) liveById.set(t.id.toString(), t);
  for (const t of livePins) liveById.set(t.id.toString(), t);
  const live = [...liveById.values()];

  // Fetch all statuses in ONE multicall instead of one per token.
  const allStatuses = await batchGetTargetStatuses(live, snap.currentEpoch, nowSec);

  // The dashboard "Rival targets" panel derives its rows (incl. "My rivals") from this
  // result, so an empty return renders as "No pinned rivals" even when pins are
  // configured — easy to misread as a config problem. Make the read's shape visible:
  // warn loudly for the telling failure (pins configured but none survived liveness —
  // a bad RPC/citizens address, or every pin genuinely burned), else a debug summary.
  if (pinnedIds.length > 0 && livePins.length === 0) {
    logger.warn(
      `readTargets: ${pinnedIds.length} pinned target(s) configured but 0 survived the liveness check ` +
        `— check RPC / citizens address; pinned rivals won't show.`,
    );
  } else {
    logger.debug(
      `readTargets: pinned=${pinnedIds.length} livePins=${livePins.length} liveCandidates=${liveCandidates.length} live=${live.length}`,
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
