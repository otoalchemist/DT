import { parseAbiItem, type Address } from "viem";
import { EMIGRATION_DESTINATIONS } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { makeIdCache } from "./id-cache.js";
import { logger } from "./logger.js";

/**
 * The permanent roster of citizens that have emigrated, across EVERY emigration route.
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
 *
 * There are now TWO destinations (Governor and ABBC) and the design assumes more may
 * follow: each is scanned independently with its own cursor, because they were deployed at
 * different heights and one shared cursor would either re-scan ~86k pointless blocks for
 * the newer route or skip history for the older. Both emit the identical
 * `Emigrated(address indexed, uint256 indexed)` signature — verified on-chain against
 * ABBC tx 0x76b0389c…47a4 — so one event definition covers both.
 */

const emigratedEvent = parseAbiItem(
  "event Emigrated(address indexed newGovernor, uint256 indexed citizenTokenId)",
);

export interface EmigrationRecord {
  tokenId: bigint;
  /** Address the Governor/ABBC token was minted to — the wallet that emigrated this citizen. */
  emigratedBy: Address;
  blockNumber: bigint;
  logIndex: number;
  /** Which contract it emigrated to (checksummed, as in EMIGRATION_DESTINATIONS). */
  destination: Address;
  /** Human label for that route, e.g. "Governor" or "ABBC". */
  destinationLabel: string;
}

/**
 * Per-destination roster and scan cursor, keyed by lowercased contract address.
 *
 * Kept separate rather than merged into one map so each route keeps its own scan progress.
 * Capped by each contract's own supply for the life of the game, so holding it all in
 * memory is free.
 */
interface DestinationState {
  roster: Map<string, EmigrationRecord>;
  lastScannedBlock: bigint | null;
}
const states = new Map<string, DestinationState>();

function stateFor(address: string): DestinationState {
  const key = address.toLowerCase();
  let s = states.get(key);
  if (!s) {
    s = { roster: new Map(), lastScannedBlock: null };
    states.set(key, s);
  }
  return s;
}

// Re-scan this many blocks below the last scanned height on every refresh. A reorg can
// unwind a block we already counted; overlapping the window and de-duplicating by
// tokenId (a citizen can only ever emigrate once per route — `migrated[tokenId]` enforces
// it) makes a replayed event idempotent instead of a duplicate row.
const REORG_OVERLAP_BLOCKS = 64n;

const ROSTER_TTL_MS = 30_000;
const rosterCache = makeIdCache<EmigrationRecord[]>({
  onError: (e) => logger.warn("Emigration roster refresh failed:", (e as Error).message),
});

/** Every route's records, merged and ordered by when they happened. */
function sortedRoster(): EmigrationRecord[] {
  const all: EmigrationRecord[] = [];
  for (const s of states.values()) all.push(...s.roster.values());
  return all.sort(
    (a, b) =>
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      a.logIndex - b.logIndex,
  );
}

/** The uncached delta scan across every destination. `fetchEmigrationRoster` is the cached
 *  entry point callers should use; this is exported so tests can drive successive scans
 *  directly instead of fighting the stale-while-revalidate window. */
export async function scanEmigrations(): Promise<EmigrationRecord[]> {
  const latest = await publicClient.getBlockNumber();

  // Sequential, not Promise.all: the http transport batches concurrent requests, and two
  // wide getLogs ranges coalesced into one request is the oversized-batch shape that RPCs
  // reject wholesale (see the chunking note in contract.ts). Two round-trips behind a 30s
  // TTL costs nothing.
  let attempted = 0;
  const failures: Error[] = [];
  for (const dest of EMIGRATION_DESTINATIONS) {
    const state = stateFor(dest.address);
    const from =
      state.lastScannedBlock === null
        ? dest.deployBlock
        : state.lastScannedBlock > dest.deployBlock + REORG_OVERLAP_BLOCKS
          ? state.lastScannedBlock - REORG_OVERLAP_BLOCKS
          : dest.deployBlock;
    if (from > latest) continue; // nothing new since the last scan
    attempted++;

    let logs;
    try {
      logs = await publicClient.getLogs({
        address: dest.address,
        event: emigratedEvent,
        fromBlock: from,
        toBlock: latest,
      });
    } catch (err) {
      // One route failing must not blank the others, so this is caught per destination and
      // the cursor is left where it was, letting the next attempt re-cover the range.
      // But a failure is NOT nothing: see the rethrow below.
      logger.warn(`Emigration scan failed for ${dest.label}:`, (err as Error).message);
      failures.push(err as Error);
      continue;
    }

    let added = 0;
    for (const log of logs) {
      const tokenId = log.args.citizenTokenId;
      const emigratedBy = log.args.newGovernor;
      if (tokenId === undefined || emigratedBy === undefined) continue;
      const key = tokenId.toString();
      if (!state.roster.has(key)) added++;
      state.roster.set(key, {
        tokenId,
        emigratedBy,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        destination: dest.address,
        destinationLabel: dest.label,
      });
    }
    // Only advance the cursor on a successful scan; the catch above leaves it where it was
    // so the next attempt re-covers the same range rather than skipping past it.
    state.lastScannedBlock = latest;
    if (added > 0) {
      logger.info(
        `Emigration (${dest.label}): ${added} new emigration(s) detected (${state.roster.size} on this route)`,
      );
    }
  }

  // Every attempted route failed -> the scan learned nothing, so THROW rather than return
  // a roster that looks authoritative. Returning [] here would render as "nobody has
  // emigrated" on a broken RPC, and would let the caller's cache adopt that emptiness as
  // the new truth. A PARTIAL failure still returns, because the routes that did succeed
  // are real data and are better than nothing.
  if (attempted > 0 && failures.length === attempted) throw failures[0];
  return sortedRoster();
}

/**
 * Every emigration to date across all routes, in emigration order (index 0 = first out).
 *
 * Stale-while-revalidate: the dashboard polls this every 20s and emigrations are rare, so
 * a cached roster is served instantly while the delta scan runs in the background. A
 * failed background refresh keeps the last good roster rather than blanking the panel.
 */
export async function fetchEmigrationRoster(): Promise<EmigrationRecord[]> {
  // One cache key: the value is the merged roster, so a single entry covers every route.
  return rosterCache("all-emigration-destinations", ROSTER_TTL_MS, scanEmigrations);
}

/** Drop the accumulated rosters and cursors. For tests, and for an RPC swap — a new
 *  client may talk to a different chain, where the old roster is meaningless. */
export function resetEmigrationRoster(): void {
  states.clear();
}

/** Drop the cached emigration roster (manual refresh). */
export function invalidateEmigrationRoster(): void {
  rosterCache.invalidate();
}
