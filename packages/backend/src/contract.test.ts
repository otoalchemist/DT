import { describe, it, expect, vi, beforeEach } from "vitest";

// filterLiveTokenIds must split a large ID set into bounded multicall requests: a
// single whole-collection multicall gets coalesced by the http transport's batch:true
// into one JSON-RPC batch the RPC rejects wholesale, surfacing as EVERY call failing
// (observed: 6961 IDs -> 0 live). These tests pin the chunking so that regression
// can't reappear.

const multicall = vi.fn();

vi.mock("./chain.js", () => ({
  publicClient: { multicall: (...a: unknown[]) => multicall(...a) },
}));

vi.mock("./config.js", () => ({
  appConfig: { gameAddress: "0x00000000000000000000000000000000000000aa" },
}));

const { filterLiveTokenIds } = await import("./contract.js");

const CITIZENS = "0x00000000000000000000000000000000000000cc" as const;
const ownerOf = (id: bigint) => `0x${id.toString(16).padStart(40, "0")}` as const;

beforeEach(() => {
  multicall.mockReset();
});

describe("filterLiveTokenIds chunking", () => {
  it("returns [] without calling the RPC for an empty set", async () => {
    const live = await filterLiveTokenIds(CITIZENS, []);
    expect(live).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
  });

  it("splits a large set into multiple requests of at most the chunk size", async () => {
    // 2500 ids -> 3 requests (1000 + 1000 + 500) at the 1000 chunk size.
    const ids = Array.from({ length: 2500 }, (_, i) => BigInt(i + 1));
    multicall.mockImplementation(async ({ contracts }: { contracts: { args: [bigint] }[] }) =>
      contracts.map((c) => ({ status: "success", result: ownerOf(c.args[0]) })),
    );

    const live = await filterLiveTokenIds(CITIZENS, ids);

    expect(multicall).toHaveBeenCalledTimes(3);
    for (const [arg] of multicall.mock.calls as [{ contracts: unknown[] }][]) {
      expect(arg.contracts.length).toBeLessThanOrEqual(1000);
    }
    // All succeeded -> all live, order preserved across chunks.
    expect(live.map((l) => l.id)).toEqual(ids);
  });

  it("drops burned/killed ids (multicall failure) and concatenates across chunks", async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => BigInt(i + 1));
    // Odd ids revert (burned); even ids are live.
    multicall.mockImplementation(async ({ contracts }: { contracts: { args: [bigint] }[] }) =>
      contracts.map((c) =>
        c.args[0] % 2n === 0n
          ? { status: "success", result: ownerOf(c.args[0]) }
          : { status: "failure", error: new Error("nonexistent token") },
      ),
    );

    const live = await filterLiveTokenIds(CITIZENS, ids);

    expect(multicall).toHaveBeenCalledTimes(2); // 1000 + 500
    expect(live).toHaveLength(750); // half of 1500
    expect(live.every((l) => l.id % 2n === 0n)).toBe(true);
  });

  it("drops the zero address (defensive) even on multicall success", async () => {
    const ids = [1n, 2n];
    const zero = "0x0000000000000000000000000000000000000000";
    multicall.mockResolvedValue([
      { status: "success", result: zero },
      { status: "success", result: ownerOf(2n) },
    ]);

    const live = await filterLiveTokenIds(CITIZENS, ids);
    expect(live.map((l) => l.id)).toEqual([2n]);
  });
});
