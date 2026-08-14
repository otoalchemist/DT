import type { Address } from "viem";
import {
  isEmigrated,
  EMIGRATION_CONTRACT_ADDRESS,
  type OwnedTokenStatus,
  type TargetTokenStatus,
  type DoNotTargetStatus,
  type EmigratedTokenStatus,
} from "@dat-bot/shared";
import { runtime, loadAllyTokens, loadDoNotTarget } from "./runtime.js";
import { getGameSnapshot, batchGetOwnedStatuses, batchGetTargetStatuses, filterLiveTokenIds } from "./contract.js";
import { fetchOwnedTokenIds, fetchCandidateTokenIds, fetchLiveCitizens } from "./index-tokens.js";
import { fetchEmigrationRoster } from "./emigration.js";
import { makeIdCache } from "./id-cache.js";
import { loadWallets } from "./keystore.js";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

// Read-only helpers used by the API for the dashboard (independent of the engine loop).

// The dashboard polls /api/tokens and /api/targets together every 20s, and the engine
// tick reads the same snapshot every block. Letting these read a snapshot up to 5s old
// collapses three identical multicalls per poll cycle into one, without affecting the
// engine (which always reads fresh — see getGameSnapshot).
const SNAPSHOT_TTL_MS = 5_000;

export async function readOwnedStatuses(): Promise<OwnedTokenStatus[]> {
  if (!runtime.unlocked) return [];
  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Union across every unlocked wallet, tagged with the one holding each citizen so the
  // dashboard can group them and the user can see which wallet needs funding.
  const per = await Promise.all(
    runtime.wallets.map(async (w) => ({
      w,
      ids: await fetchOwnedTokenIds(snap.citizensAddress, w.account.address as `0x${string}`),
    })),
  );
  const holder = new Map<string, { address: string; label: string }>();
  const ids: bigint[] = [];
  for (const { w, ids: list } of per) {
    for (const id of list) {
      const key = id.toString();
      if (holder.has(key)) continue;
      holder.set(key, { address: w.account.address, label: w.label });
      ids.push(id);
    }
  }
  // ONE multicall for every owned token's status, not a serial per-token round-trip.
  const rows = await batchGetOwnedStatuses(ids, snap.currentEpoch, nowSec, runtime.strategy.prepayEpochs);
  return rows.map((r) => ({
    ...r,
    walletAddress: holder.get(r.tokenId)?.address ?? null,
    walletLabel: holder.get(r.tokenId)?.label ?? null,
  }));
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
    const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
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
  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  const pinnedSet = new Set(runtime.strategy.offenseTargetTokenIds.map((x) => BigInt(x).toString()));
  // Normalised the same way pins are, so "0084" and "84" both match (see excludedTokenSet).
  const allySet = new Set(loadAllyTokens().map((x) => BigInt(x).toString()));
  // Big boys have their own panel section (readDoNotTarget), so listing them here too
  // showed the same citizens twice — and "Others" reads as a shortlist of things to
  // consider attacking, which is the opposite of what the roster means.
  const dntSet = new Set(loadDoNotTarget().tokenIds.map((x) => BigInt(x).toString()));

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
  // Every wallet we hold, so a citizen in ANY of them is filtered out of the rival list.
  // Falls back to the keystore's addresses when locked — they're stored in plaintext
  // there (only the keys are encrypted), so the panel doesn't change shape on unlock.
  const selfSet = new Set(
    (runtime.unlocked
      ? runtime.addresses
      : loadWallets(appConfig.dataDir).map((w) => w.address)
    ).map((a) => a.toLowerCase()),
  );
  const isOurs = (t: TargetTokenStatus) => selfSet.has(t.owner.toLowerCase());

  const pinned: TargetTokenStatus[] = [];
  const actionable: TargetTokenStatus[] = [];
  // Live rivals with nothing to act on (fully paid up). Returned so the pane can report a
  // count and reconcile against the live supply — see the else branch below.
  const current: TargetTokenStatus[] = [];
  let ownedSkipped = 0;
  let emigratedSkipped = 0;
  let allySkipped = 0;
  let dntSkipped = 0;
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
    // Allies aren't rivals. They get their own panel (readAllies) — listing a delinquent
    // ally here would read as a kill candidate. Filtered ahead of the pin check so a
    // stale pin on an ally can't drag it back into the rival list either.
    if (allySet.has(t.tokenId)) {
      allySkipped++;
      continue;
    }
    if (pinnedSet.has(t.tokenId)) {
      // Pin checked BEFORE the roster: the do-not-target list is advice, and an explicit
      // pin overrides it (the engine will audit a pinned big boy), so a pinned one still
      // belongs under "My rivals" rather than being filtered away.
      pinned.push(t);
    } else if (dntSet.has(t.tokenId)) {
      dntSkipped++;
    } else if (t.delinquent || t.killable || t.auditDueTimestamp !== "0") {
      actionable.push(t);
    } else {
      // Fully paid up: nothing to do about it, but it IS a live citizen. This branch used
      // to be absent, so a current unlisted rival fell out of every panel and the right-hand
      // pane could not be reconciled against "citizens left" — e.g. 81 live reading as 74.
      // Returned so the UI can COUNT them without rendering a row per token (they are not
      // actionable, so the rows would be noise). Kept out of the outputLimit accounting
      // below, so they can never displace an actionable rival.
      current.push(t);
    }
  }
  if (ownedSkipped > 0) {
    logger.debug(`readTargets: excluded ${ownedSkipped} token(s) we own from the rival list`);
  }
  if (dntSkipped > 0) {
    logger.debug(
      `readTargets: ${dntSkipped} do-not-target citizen(s) routed to their own section rather than Others`,
    );
  }
  if (emigratedSkipped > 0) {
    logger.debug(`readTargets: excluded ${emigratedSkipped} emigrated citizen(s) from the rival list`);
  }
  if (allySkipped > 0) {
    logger.debug(`readTargets: excluded ${allySkipped} allied citizen(s) from the rival list`);
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
  // Fully-current rivals are appended AFTER the cap so they can never displace an
  // actionable row. The UI renders no row for them; it counts them (they are identifiable
  // by !delinquent && !killable && auditDueTimestamp === "0").
  return [...pinned, ...actionable.slice(0, room), ...current];
}

/**
 * Allied citizens (data/ally-tokens.json) with live status, for their own dashboard
 * panel. Deliberately separate from readTargets: an ally is not a target, and a
 * delinquent one showing up under "Rival targets" reads as a kill candidate.
 *
 * Unlike rivals these are listed whatever their state — the point is to watch allies at
 * risk, so a healthy ally shouldn't vanish from the list. Sorted most-at-risk first
 * (killable > under audit > auditable > behind), so trouble surfaces at the top.
 * Allies that are dead/burned or have emigrated simply aren't in the live set.
 */
export async function readAllies(): Promise<TargetTokenStatus[]> {
  const ids = loadAllyTokens();
  if (ids.length === 0) return [];
  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const want = new Set(ids.map((x) => BigInt(x).toString()));
  const live = (await getLiveCandidates(snap.citizensAddress)).filter((t) => want.has(t.id.toString()));
  const rows = await batchGetTargetStatuses(live, snap.currentEpoch, nowSec);
  return rows.sort((a, b) => actionableRank(a) - actionableRank(b) || b.epochsBehind - a.epochsBehind);
}

/**
 * The "do not target" roster (data/do-not-target.json), each row tagged with the operator
 * who runs it. Same live-status read as the rivals panel — these ARE rivals, we just never
 * attack them — so the panel can still show how delinquent a big boy is getting without
 * inviting an audit that would only waste a slot.
 */
export async function readDoNotTarget(): Promise<DoNotTargetStatus[]> {
  const { tokenIds, owners } = loadDoNotTarget();
  if (tokenIds.length === 0) return [];
  const operatorOf = new Map<string, string>();
  for (const [name, ids] of Object.entries(owners)) {
    for (const id of ids) operatorOf.set(BigInt(id).toString(), name);
  }
  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const want = new Set(tokenIds.map((x) => BigInt(x).toString()));
  const live = (await getLiveCandidates(snap.citizensAddress)).filter((t) => want.has(t.id.toString()));
  const rows = await batchGetTargetStatuses(live, snap.currentEpoch, nowSec);
  return rows
    .map((r) => ({ ...r, operator: operatorOf.get(BigInt(r.tokenId).toString()) ?? "?" }))
    // Group by operator, then most-delinquent first within each group.
    .sort((a, b) => a.operator.localeCompare(b.operator) || b.epochsBehind - a.epochsBehind);
}

/**
 * Every citizen that has emigrated, in emigration order.
 *
 * The roster comes from the `Emigrated` event log, NOT from current ownership. An
 * emigrated citizen is held by the Emigration contract only until somebody kills it, and
 * the kill burns the ERC-721 — so it drops out of every ownership index. Filtering the
 * live set by owner therefore answers "how many emigrants are still alive" (5) when the
 * question is "who has emigrated" (13, with 8 already killed), and the list silently
 * shrinks over time, which reads as a bug. The log never shrinks.
 *
 * Liveness is layered on top from the live-citizen set we already cache, so a killed
 * emigrant stays listed with `alive: false`. Only the living ones get a status read —
 * the game contract has nothing meaningful to say about a burned token.
 */
export async function readEmigrated(): Promise<EmigratedTokenStatus[]> {
  const records = await fetchEmigrationRoster();
  if (records.length === 0) return [];

  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // Liveness for free: the cached live set is keyed on current ownership, so an emigrant
  // present in it still exists. This also covers the owner rescuing one back out
  // (rescueERC721) — it stays on the roster as history, while the owner change drops it
  // from the offense filter on its own, putting it back in play as a normal rival.
  const live = await getLiveCandidates(snap.citizensAddress);
  const liveIds = new Set(live.map((t) => t.id.toString()));

  const aliveRecords = records.filter((r) => liveIds.has(r.tokenId.toString()));
  const statuses = await batchGetTargetStatuses(
    // Owner is the route each citizen actually went to, not a single hard-coded address —
    // otherwise every ABBC emigrant would be labelled as held by the Governor contract.
    aliveRecords.map((r) => ({ id: r.tokenId, owner: r.destination as Address })),
    snap.currentEpoch,
    nowSec,
  );
  const statusById = new Map(statuses.map((s) => [s.tokenId, s]));

  const perRoute = new Map<string, number>();
  for (const r of records) perRoute.set(r.destinationLabel, (perRoute.get(r.destinationLabel) ?? 0) + 1);
  logger.debug(
    `readEmigrated: ${records.length} emigrated (${aliveRecords.length} alive, ` +
      `${records.length - aliveRecords.length} already killed) — ` +
      [...perRoute].map(([label, n]) => `${label}: ${n}`).join(", "),
  );

  return records.map((r, index) => {
    const key = r.tokenId.toString();
    const s = statusById.get(key);
    return {
      tokenId: key,
      emigratedBy: r.emigratedBy,
      index,
      destination: r.destination,
      destinationLabel: r.destinationLabel,
      alive: liveIds.has(key),
      epochsBehind: s?.epochsBehind ?? 0,
      auditDueTimestamp: s?.auditDueTimestamp ?? "0",
      killable: s?.killable ?? false,
    };
  });
}

/** Drop the cached live-citizen set (manual refresh). */
export function invalidateLiveCandidates(): void {
  liveCandidatesCache.invalidate();
}
