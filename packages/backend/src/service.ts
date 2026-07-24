import type { Address } from "viem";
import type { OwnedTokenStatus, TargetTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, batchGetOwnedStatuses, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds, fetchLiveCitizens } from "./index-tokens.js";
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

// The live-citizen set changes only when a citizen is killed/burned, so cache it (SWR,
// 60s) — the first load pays for it, the rest serve instantly with a background
// refresh. Token STATUS (delinquency / audit) is deliberately NOT cached here: it's
// re-read fresh each call over the small live set (cheap) and must stay current.
const LIVE_CANDIDATES_TTL_MS = 60_000;
const liveCandidatesCache = makeIdCache<{ id: bigint; owner: Address }[]>({
  onError: (e) => logger.warn("Live-candidate refresh failed:", (e as Error).message),
});

/**
 * Live citizen tokens (with owners), cached SWR. Primary path is Alchemy's owner index
 * (getOwnersForContract) — keyed on current ownership, so it returns ONLY live tokens
 * (~1 page, no ownerOf sweep). Falls back to enumerate-then-liveness (getNFTsForContract
 * + ownerOf) when the NFT owner index is unavailable, e.g. local/anvil TARGET_TOKENS
 * overrides, so testing without Alchemy still works.
 */
async function getLiveCandidates(citizens: Address): Promise<{ id: bigint; owner: Address }[]> {
  return liveCandidatesCache(citizens.toLowerCase(), LIVE_CANDIDATES_TTL_MS, async () => {
    const live = await fetchLiveCitizens(citizens);
    if (live.length > 0) return live;
    // No owner index (unconfigured NFT API / override mode): enumerate + on-chain liveness.
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

  const pinnedSet = new Set(runtime.strategy.offenseTargetTokenIds.map((x) => BigInt(x).toString()));

  // The cached live set already contains EVERY live token (Alchemy owner index), so a
  // live pinned rival is included by definition — no separate pin liveness check needed.
  const live = await getLiveCandidates(snap.citizensAddress);

  // Fetch all statuses in ONE multicall instead of one per token.
  const allStatuses = await batchGetTargetStatuses(live, snap.currentEpoch, nowSec);

  // The dashboard "Rival targets" panel derives its rows (incl. "My rivals") from this
  // result, so an empty return renders as "No pinned rivals" even when pins are
  // configured — easy to misread as a config problem. Make the read's shape visible:
  // warn loudly for the telling failure (pins configured but none are live — a bad
  // RPC/citizens address, or every pin genuinely burned), else a debug summary.
  const livePinned = live.reduce((n, t) => (pinnedSet.has(t.id.toString()) ? n + 1 : n), 0);
  if (pinnedSet.size > 0 && livePinned === 0) {
    logger.warn(
      `readTargets: ${pinnedSet.size} pinned target(s) configured but 0 are live ` +
        `— check RPC / citizens address; pinned rivals won't show.`,
    );
  } else {
    logger.debug(`readTargets: pinned=${pinnedSet.size} live=${live.length} livePinned=${livePinned}`);
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
