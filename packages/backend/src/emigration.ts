import { parseAbiItem, type Address } from "viem";
import { EMIGRATION_CONTRACT_ADDRESS, EMIGRATION_DEPLOY_BLOCK } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { makeIdCache } from "./id-cache.js";
import { logger } from "./logger.js";

/**
 * The permanent roster of citizens that have emigrated.
 *
 * Current ownership is the WRONG source for this list. An emigrated citizen is held by
 * the Emigration contract only until somebody kills it; the kill burns the ERC-721, so it
 * disappears from every ownership index and from `ownerOf`. Reading ownership therefore
 * answers "how many emigrants are still alive" (5 of 13 at epoch 149) when the question
 * is "who has emigrated" (13). The `Emigrated` event log is the record that never shrinks.
 *
 * Equivalent on-chain check: `Emigration.migrated(tokenId)`, but that's a mapping — it can
 * be probed, not enumerated — and `currentIndex` gives only the count. The log gives the
 * IDs, the emigrating wallet, and the order, which is what the roster needs.
 */

const emigratedEvent = parseAbiItem(
  "event Emigrated(address indexed newGovernor, uint256 indexed citizenTokenId)",
);

export interface EmigrationRecord {
  tokenId: bigint;
  /** Address the Governor NFT was minted to — the wallet that emigrated this citizen. */
  emigratedBy: Address;
  blockNumber: bigint;
  logIndex: number;
}

// Accumulated roster + how far the log has been scanned, so each refresh queries only
// the new blocks instead of re-scanning from deployment. Capped at 36 entries for the
// life of the game (the contract's `supply`), so holding it all in memory is free.
const roster = new Map<string, EmigrationRecord>();
let lastScannedBlock: bigint | null = null;

// Re-scan this many blocks below the last scanned height on every refresh. A reorg can
// unwind a block we already counted; overlapping the window and de-duplicating by
// tokenId (a citizen can only ever emigrate once — `migrated[tokenId]` enforces it)
// makes a replayed event idempotent instead of a duplicate row.
const REORG_OVERLAP_BLOCKS = 64n;

const ROSTER_TTL_MS = 30_000;
const rosterCache = makeIdCache<EmigrationRecord[]>({
  onError: (e) => logger.warn("Emigration roster refresh failed:", (e as Error).message),
});

function sortedRoster(): EmigrationRecord[] {
  return [...roster.values()].sort(
    (a, b) =>
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      a.logIndex - b.logIndex,
  );
}

/** The uncached delta scan. `fetchEmigrationRoster` is the cached entry point callers
 *  should use; this is exported so tests can drive successive scans directly instead of
 *  fighting the stale-while-revalidate window. */
export async function scanEmigrations(): Promise<EmigrationRecord[]> {
  const latest = await publicClient.getBlockNumber();
  const from =
    lastScannedBlock === null
      ? EMIGRATION_DEPLOY_BLOCK
      : lastScannedBlock > REORG_OVERLAP_BLOCKS
        ? lastScannedBlock - REORG_OVERLAP_BLOCKS
        : EMIGRATION_DEPLOY_BLOCK;
  if (from > latest) return sortedRoster(); // nothing new since the last scan

  const logs = await publicClient.getLogs({
    address: EMIGRATION_CONTRACT_ADDRESS,
    event: emigratedEvent,
    fromBlock: from,
    toBlock: latest,
  });

  let added = 0;
  for (const log of logs) {
    const tokenId = log.args.citizenTokenId;
    const emigratedBy = log.args.newGovernor;
    if (tokenId === undefined || emigratedBy === undefined) continue;
    const key = tokenId.toString();
    if (!roster.has(key)) added++;
    roster.set(key, {
      tokenId,
      emigratedBy,
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
    });
  }
  // Only advance the cursor on a successful scan; a throw above leaves it where it was
  // so the next attempt re-covers the same range rather than skipping past it.
  lastScannedBlock = latest;
  if (added > 0) {
    logger.info(`Emigration: ${added} new emigration(s) detected (${roster.size} total)`);
  }
  return sortedRoster();
}

/**
 * Every emigration to date, in emigration order (index 0 = first out).
 *
 * Stale-while-revalidate: the dashboard polls this every 20s and emigrations are rare, so
 * a cached roster is served instantly while the delta scan runs in the background. A
 * failed background refresh keeps the last good roster rather than blanking the panel.
 */
export async function fetchEmigrationRoster(): Promise<EmigrationRecord[]> {
  return rosterCache(EMIGRATION_CONTRACT_ADDRESS.toLowerCase(), ROSTER_TTL_MS, scanEmigrations);
}

/** Drop the accumulated roster and cursor. For tests, and for an RPC swap — a new
 *  client may talk to a different chain, where the old roster is meaningless. */
export function resetEmigrationRoster(): void {
  roster.clear();
  lastScannedBlock = null;
}

/** Drop the cached emigration roster (manual refresh). */
export function invalidateEmigrationRoster(): void {
  rosterCache.invalidate();
}
