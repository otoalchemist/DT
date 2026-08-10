import { describe, it, expect, vi, beforeEach } from "vitest";

// The roster must be sourced from the Emigrated event log, not from current ownership.
// An emigrated citizen is burned when somebody kills it, so it leaves every ownership
// index — an ownership-based list showed 5 when 13 had actually emigrated. These tests
// pin the properties that make the log-based roster permanent and idempotent.
//
// They drive `scanEmigrations` (the uncached delta scan) rather than the cached
// `fetchEmigrationRoster`, so successive scans actually re-query instead of being served
// from the 30s stale-while-revalidate window. The cache itself is covered by id-cache.test.

const getLogs = vi.fn();
const getBlockNumber = vi.fn(async () => 25_650_000n);

vi.mock("./chain.js", () => ({
  publicClient: {
    getLogs: (...args: unknown[]) => getLogs(...args),
    getBlockNumber: () => getBlockNumber(),
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { scanEmigrations, resetEmigrationRoster } = await import("./emigration.js");
const {
  isEmigrated,
  emigrationDestinationOf,
  EMIGRATION_CONTRACT_ADDRESS: GOVERNOR_ADDRESS,
  EMIGRATION_DEPLOY_BLOCK: GOVERNOR_DEPLOY,
  ABBC_EMIGRATION_CONTRACT_ADDRESS: ABBC_ADDRESS,
  ABBC_EMIGRATION_DEPLOY_BLOCK: ABBC_DEPLOY,
  ABBC_TOKEN_CONTRACT_ADDRESS,
} = await import("@dat-bot/shared");

const DEPLOY_BLOCK = 25_640_893n;

function log(tokenId: bigint, blockNumber: bigint, logIndex: number, who = "0xaaaa") {
  return {
    args: { citizenTokenId: tokenId, newGovernor: who as `0x${string}` },
    blockNumber,
    logIndex,
  };
}

describe("emigration roster (event-log sourced)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmigrationRoster();
    getBlockNumber.mockResolvedValue(25_650_000n);
  });

  it("returns every emigration in event order, regardless of token ID", async () => {
    // Real mainnet ordering: emigration order is NOT token-ID order, and the index it
    // produces is the Governor's metadata index, so the roster has to follow the log.
    getLogs.mockResolvedValue([
      log(4230n, 25_640_900n, 0),
      log(3557n, 25_640_950n, 2),
      log(829n, 25_641_000n, 1),
    ]);
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["4230", "3557", "829"]);
  });

  it("orders two events in the same block by logIndex", async () => {
    getLogs.mockResolvedValue([
      log(200n, 25_640_900n, 7),
      log(100n, 25_640_900n, 3),
    ]);
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["100", "200"]);
  });

  it("keeps an emigrant on the roster after it is killed — the log never shrinks", async () => {
    getLogs.mockResolvedValue([log(87n, 25_640_900n, 0), log(134n, 25_640_901n, 0)]);
    expect(await scanEmigrations()).toHaveLength(2);

    // A later scan returns no NEW events (both citizens have since been killed and
    // burned). Nothing may drop off: liveness is layered on in readEmigrated, not here.
    getLogs.mockResolvedValue([]);
    getBlockNumber.mockResolvedValue(25_660_000n);
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["87", "134"]);
  });

  it("scans incrementally, overlapping the tail to survive a reorg", async () => {
    getLogs.mockResolvedValue([log(87n, 25_649_990n, 0)]);
    await scanEmigrations();
    const first = getLogs.mock.calls[0]![0] as { fromBlock: bigint; toBlock: bigint };
    expect(first.fromBlock).toBe(DEPLOY_BLOCK); // cold start: the deploy block
    expect(first.toBlock).toBe(25_650_000n);

    getBlockNumber.mockResolvedValue(25_660_000n);
    getLogs.mockResolvedValue([]);
    await scanEmigrations();
    const second = getLogs.mock.calls[1]![0] as { fromBlock: bigint };
    // Re-covers the last 64 blocks rather than resuming exactly at the old height.
    expect(second.fromBlock).toBe(25_650_000n - 64n);
  });

  it("de-duplicates a replayed event instead of double-listing the token", async () => {
    getLogs.mockResolvedValue([log(87n, 25_649_990n, 0)]);
    expect(await scanEmigrations()).toHaveLength(1);

    // The overlap window replays the same event after a reorg. A citizen can only ever
    // emigrate once (`migrated[tokenId]`), so the replay must collapse onto the same row.
    getBlockNumber.mockResolvedValue(25_660_000n);
    getLogs.mockResolvedValue([log(87n, 25_649_990n, 0)]);
    const out = await scanEmigrations();
    expect(out).toHaveLength(1);
    expect(out[0]!.tokenId.toString()).toBe("87");
  });

  it("does not advance the scan cursor when the log query fails", async () => {
    getLogs.mockRejectedValueOnce(new Error("RPC exploded"));
    await expect(scanEmigrations()).rejects.toThrow("RPC exploded");

    // The retry must re-cover the same range from the deploy block, not skip past it —
    // otherwise one transient failure loses every emigration in the missed window.
    getLogs.mockResolvedValue([log(87n, 25_640_900n, 0)]);
    const out = await scanEmigrations();
    const retry = getLogs.mock.calls[1]![0] as { fromBlock: bigint };
    expect(retry.fromBlock).toBe(DEPLOY_BLOCK);
    expect(out).toHaveLength(1);
  });

  it("skips the query entirely when no new blocks have been produced", async () => {
    getLogs.mockResolvedValue([log(87n, 25_640_900n, 0)]);
    await scanEmigrations();
    expect(getLogs).toHaveBeenCalledTimes(1);

    // Chain height went BACKWARDS past the overlap window (a deep reorg or an RPC
    // serving a lagging node). from > latest, so there is nothing to ask for.
    getBlockNumber.mockResolvedValue(25_640_800n);
    const out = await scanEmigrations();
    expect(getLogs).toHaveBeenCalledTimes(1); // no second query
    expect(out).toHaveLength(1); // roster preserved
  });
});

/**
 * Emigration has more than one destination now: the original Governor contract and ABBC
 * ("anti bot bot club", deployed ~86k blocks later). Both emit the identical
 * `Emigrated(address indexed, uint256 indexed)` event — verified on-chain against ABBC tx
 * 0x76b0389c…47a4, citizen #4632 — so the risk isn't decoding, it's bookkeeping: each route
 * needs its own scan cursor, and anything that means "has this citizen left the game" has
 * to consult BOTH. Getting that wrong means paying taxes for a citizen we no longer own and
 * spending audit slots on one nobody defends.
 */
describe("emigration roster: multiple destinations", () => {
  // Past both deploy blocks (Governor 25_640_893, ABBC 25_727_232), so both are in range.
  const HEAD = 25_730_000n;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEmigrationRoster();
    getBlockNumber.mockResolvedValue(HEAD);
  });

  it("queries each destination from its OWN deploy block", async () => {
    getLogs.mockResolvedValue([]);
    await scanEmigrations();
    expect(getLogs).toHaveBeenCalledTimes(2);
    const ranges = getLogs.mock.calls.map(([a]) => a as { address: string; fromBlock: bigint });
    // A single shared cursor would either re-scan ~86k pointless blocks for ABBC or skip
    // history for Governor. Each route starts where its contract actually exists.
    expect(ranges.map((r) => r.fromBlock)).toEqual([GOVERNOR_DEPLOY, ABBC_DEPLOY]);
    expect(ranges.map((r) => r.address.toLowerCase())).toEqual([
      GOVERNOR_ADDRESS.toLowerCase(),
      ABBC_ADDRESS.toLowerCase(),
    ]);
  });

  it("merges both routes into one roster, tagged with where each went", async () => {
    getLogs
      .mockResolvedValueOnce([log(829n, 25_640_900n, 0)])   // Governor
      .mockResolvedValueOnce([log(4632n, 25_727_403n, 1)]); // ABBC (the real tx)
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["829", "4632"]);
    expect(out.map((r) => r.destinationLabel)).toEqual(["Governor", "ABBC"]);
  });

  it("orders the merged roster chronologically, not by route", async () => {
    // ABBC is newer, but ordering must follow block/logIndex — a route-major sort would
    // misreport who left first, which is what the panel's index column means.
    getLogs
      .mockResolvedValueOnce([log(100n, 25_640_900n, 0), log(300n, 25_728_000n, 0)])
      .mockResolvedValueOnce([log(200n, 25_727_403n, 0)]);
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["100", "200", "300"]);
  });

  it("keeps one route's results when the OTHER route's query fails", async () => {
    getLogs
      .mockResolvedValueOnce([log(829n, 25_640_900n, 0)])       // Governor OK
      .mockRejectedValueOnce(new Error("ABBC RPC exploded"));   // ABBC fails
    // Partial data beats none: the Governor emigrants are real and must still be listed,
    // or one flaky route blanks a panel that drives "don't audit these" decisions.
    const out = await scanEmigrations();
    expect(out.map((r) => r.tokenId.toString())).toEqual(["829"]);
  });

  it("does not advance the failed route's cursor while advancing the healthy one", async () => {
    getLogs
      .mockResolvedValueOnce([log(829n, 25_640_900n, 0)])
      .mockRejectedValueOnce(new Error("ABBC RPC exploded"));
    await scanEmigrations();

    getLogs.mockResolvedValue([]);
    await scanEmigrations();
    // Calls 3 and 4 are the second sweep. Governor resumes near HEAD (minus the reorg
    // overlap); ABBC must re-cover from its deploy block, or the emigrations in the missed
    // window are lost forever.
    const second = getLogs.mock.calls.slice(2).map(([a]) => a as { fromBlock: bigint });
    expect(second[0]!.fromBlock).toBe(HEAD - 64n); // Governor: overlap window
    expect(second[1]!.fromBlock).toBe(ABBC_DEPLOY); // ABBC: full re-cover
  });

  it("throws when EVERY route fails, rather than reporting an empty roster", async () => {
    // Returning [] here would render as "nobody has emigrated" on a broken RPC, and the
    // caller's cache would adopt that emptiness as the new truth.
    getLogs.mockRejectedValue(new Error("RPC down"));
    await expect(scanEmigrations()).rejects.toThrow("RPC down");
  });

  it("treats a citizen at either destination as emigrated", async () => {
    // The offense engine and every payment path gate on this predicate, so a hard-coded
    // single-address comparison would silently put ABBC emigrants back in play as rivals.
    expect(isEmigrated(GOVERNOR_ADDRESS)).toBe(true);
    expect(isEmigrated(ABBC_ADDRESS)).toBe(true);
    // Case-insensitive: Alchemy's owner index is lowercase, ownerOf returns checksummed.
    expect(isEmigrated(ABBC_ADDRESS.toLowerCase())).toBe(true);
    expect(isEmigrated(ABBC_ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isEmigrated("0x000000000000000000000000000000000000dead")).toBe(false);
    expect(isEmigrated(null)).toBe(false);
    expect(isEmigrated(undefined)).toBe(false);
  });

  it("does not treat the ABBC TOKEN contract as an emigration destination", async () => {
    // The membership NFT is minted by a separate 45-byte proxy that never holds a citizen.
    // Watching it finds zero emigrations — the wrong-address mistake this guards against.
    expect(isEmigrated(ABBC_TOKEN_CONTRACT_ADDRESS)).toBe(false);
  });

  it("resolves which route an owner belongs to, for labelling", async () => {
    expect(emigrationDestinationOf(GOVERNOR_ADDRESS)?.label).toBe("Governor");
    expect(emigrationDestinationOf(ABBC_ADDRESS)?.label).toBe("ABBC");
    expect(emigrationDestinationOf("0x000000000000000000000000000000000000dead")).toBeNull();
  });
});
