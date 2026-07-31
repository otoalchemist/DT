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
