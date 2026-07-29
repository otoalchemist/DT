import type { Address } from "viem";
import { isEmigrated, type OwnedTokenStatus, type TargetTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, batchGetOwnedStatuses, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds, fetchLiveCitizens } from "./index-tokens.js";
import { makeIdCache } from "./id-cache.js";
import { loadKeystore } from "./keystore.js";
import { appConfig } from "./config.js";
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

/**
 * Rank an actionable (non-pinned) rival by how much it deserves a slot when the
 * output is capped: killable first, then under audit, then auditable, then merely
 * delinquent — most-behind first within the last group.
 *
 * This has to run BEFORE the slice below. The dashboard sorts rows by the same
 * priority, but it can only sort what it received: slicing in the raw owner-index
 * order that Alchemy returns (which has nothing to do with actionability) could drop
 * a killable rival at position 100 before the UI ever saw it.
 */
function actionableRank(t: TargetTokenStatus): number {
  if (t.killable) return 0;
  if (t.auditDueTimestamp !== "0") return 1;
  if (t.auditable) return 2;
  return 3;
}

/**
 * Rival tokens for the dashboard panel. Pinned targets always come back in full;
 * remaining slots go to the most actionable non-pinned rivals.
 *
 * `outputLimit` bounds only the non-pinned tail. The default is generous because the
 * live citizen set shrinks as the game is played (~105 at epoch 149, from a minted
 * range in the thousands) — the old limit of 50 was sized for the collection, not the
 * survivors, and was quietly truncating ~12 of 62 delinquent rivals.
 */
export async function readTargets(outputLimit = 250): Promise<TargetTokenStatus[]> {
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

  // Our own citizens are not rivals: the offense engine already refuses to audit a
  // token we own (see offensePass / queuePreBoundaryAudits), so listing them here is
  // only noise — and a delinquent one reads alarmingly like a kill target. Filter on
  // the owner already carried by the live set, so this costs no extra lookup. Applies
  // to pinned entries too: a self-pin is a mistake, not a target.
  //
  // Falls back to the keystore's address when the wallet is locked — it's stored in
  // plaintext there (only the key is encrypted), so the panel doesn't change shape
  // the moment you unlock.
  const self = (runtime.account?.address ?? loadKeystore(appConfig.dataDir)?.address ?? null)?.toLowerCase() ?? null;
  const isOurs = (t: TargetTokenStatus) => self !== null && t.owner.toLowerCase() === self;

  const pinned: TargetTokenStatus[] = [];
  const actionable: TargetTokenStatus[] = [];
  let ownedSkipped = 0;
  let emigratedSkipped = 0;
  for (const t of allStatuses) {
    if (isOurs(t)) {
      ownedSkipped++;
      continue;
    }
    // Emigrated citizens aren't rivals either — they've left the main game and the
    // offense engine won't touch them (see fetchOffenseCandidates). They get their own
    // panel, fed by readEmigrated. Filtered ahead of the pin check for the same reason
    // self-owned tokens are: a stale pin on an emigrant is dead weight, not a target.
    if (isEmigrated(t.owner)) {
      emigratedSkipped++;
      continue;
    }
    if (pinnedSet.has(t.tokenId)) {
      pinned.push(t);
    } else if (t.delinquent || t.killable || t.auditDueTimestamp !== "0") {
      actionable.push(t);
    }
  }
  if (ownedSkipped > 0) {
    logger.debug(`readTargets: excluded ${ownedSkipped} token(s) we own from the rival list`);
  }
  if (emigratedSkipped > 0) {
    logger.debug(`readTargets: excluded ${emigratedSkipped} emigrated citizen(s) from the rival list`);
  }

  // Pinned rivals always appear in full; the most actionable non-pinned tokens fill
  // the remaining slots. Sort BEFORE slicing so the cap sheds the least interesting
  // rivals rather than whatever happened to sit late in the owner index.
  actionable.sort((a, b) => actionableRank(a) - actionableRank(b) || b.epochsBehind - a.epochsBehind);
  const room = Math.max(0, outputLimit - pinned.length);
  if (actionable.length > room) {
    logger.debug(
      `readTargets: ${actionable.length - room} actionable rival(s) beyond the ${outputLimit}-row cap ` +
        `(lowest priority dropped first)`,
    );
  }
  return [...pinned, ...actionable.slice(0, room)];
}

/**
 * Citizens that have emigrated — currently owned by the Emigration contract.
 *
 * These are excluded from `readTargets` and from every offense sweep, so this is the
 * only place they surface. They're still live ERC-721s and still accrue delinquency, so
 * the same status fields apply and the panel can show how far behind each one is; the
 * difference is that nothing will ever be done about it by us or by them. The contract
 * has no way to pay taxes or spend a bribe, so an emigrant's `epochsBehind` only grows
 * until somebody else kills it.
 *
 * Sorted by token ID: this is a roster, not a work queue, so a stable order beats an
 * actionability ranking that would reshuffle rows on every poll.
 */
export async function readEmigrated(): Promise<TargetTokenStatus[]> {
  const snap = await getGameSnapshot();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const live = await getLiveCandidates(snap.citizensAddress);
  const emigrants = live.filter((t) => isEmigrated(t.owner));
  if (emigrants.length === 0) return [];
  const statuses = await batchGetTargetStatuses(emigrants, snap.currentEpoch, nowSec);
  return statuses.sort((a, b) => (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
}
