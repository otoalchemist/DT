import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    results: [] as Array<
    | { status: "success"; result: `0x${string}` }
    | { status: "failure"; error: Error }
    >,
    multicall: vi.fn(),
    readContract: vi.fn(),
    warn: vi.fn(),
    appConfig: {
      nftUrl: "" as string | undefined,
      ownedTokensOverride: [] as bigint[],
      targetTokensOverride: [] as bigint[],
      maxCandidates: 500,
    },
  };
  state.multicall.mockImplementation(async () => state.results);
  state.readContract.mockResolvedValue(0n);
  return state;
});

vi.mock("./chain.js", () => ({
  publicClient: { multicall: h.multicall, readContract: h.readContract },
}));
vi.mock("./config.js", () => ({ appConfig: h.appConfig }));
vi.mock("./logger.js", () => ({ logger: { warn: h.warn } }));

const { fetchOwnedTokenIds, filterOwnedTokenIds } = await import("./index-tokens.js");

describe("authoritative owned-token filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.results = [];
    h.multicall.mockImplementation(async () => h.results);
    h.readContract.mockResolvedValue(0n);
    h.appConfig.nftUrl = "";
    h.appConfig.ownedTokensOverride = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps only deduplicated token IDs whose current ownerOf matches the wallet", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as const;
    h.results = [
      { status: "success", result: wallet },
      { status: "success", result: "0x2222222222222222222222222222222222222222" },
      { status: "failure", error: new Error("burned token") },
    ];

    const result = await filterOwnedTokenIds(
      "0x3333333333333333333333333333333333333333",
      [1n, 2n, 2n, 3n],
      wallet,
    );

    expect(result).toEqual([1n]);
    expect(h.multicall).toHaveBeenCalledWith(expect.objectContaining({
      allowFailure: true,
      contracts: expect.arrayContaining([
        expect.objectContaining({ functionName: "ownerOf", args: [1n] }),
        expect.objectContaining({ functionName: "ownerOf", args: [2n] }),
        expect.objectContaining({ functionName: "ownerOf", args: [3n] }),
      ]),
    }));
  });

  it("paginates every owned Citizen without applying the rival candidate cap", async () => {
    h.appConfig.nftUrl = "https://nft.example";
    const wallet = "0x4444444444444444444444444444444444444444" as const;
    h.readContract.mockResolvedValue(525n);
    h.multicall.mockImplementation(async ({ contracts }: { contracts: unknown[] }) =>
      contracts.map(() => ({ status: "success", result: wallet })));
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const current = page++;
      const count = current < 5 ? 100 : 25;
      return new Response(JSON.stringify({
        ownedNfts: Array.from({ length: count }, (_value, index) => ({
          tokenId: String(current * 100 + index + 1),
        })),
        ...(current < 5 ? { pageKey: `page-${current + 1}` } : {}),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await fetchOwnedTokenIds(
      "0x3333333333333333333333333333333333333333",
      wallet,
    );

    expect(result).toHaveLength(525);
    expect(result.at(-1)).toBe(525n);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("recovers an owned Citizen when Alchemy's owner index incorrectly returns empty", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-21T19:00:00Z") });
    h.appConfig.nftUrl = "https://nft.example";
    const citizens = "0x5555555555555555555555555555555555555555" as const;
    const wallet = "0x6666666666666666666666666666666666666666" as const;
    h.readContract.mockResolvedValue(1n);
    h.multicall.mockImplementation(async ({ contracts }: { contracts: Array<{ args: [bigint] }> }) =>
      contracts.map((contract) => ({
        status: "success",
        result: contract.args[0] === 707n
          ? wallet
          : "0x7777777777777777777777777777777777777777",
      })));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/getNFTsForOwner")) {
        return new Response(JSON.stringify({ ownedNfts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        nfts: [{ tokenId: "101" }, { tokenId: "707" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOwnedTokenIds(citizens, wallet)).resolves.toEqual([707n]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("owner index mismatch"));

    // Once the stale owner index is reconciled, a later cache refresh verifies
    // the remembered token on-chain instead of scanning every collection page
    // again. The immediate caller receives the stale-while-revalidate value.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(fetchOwnedTokenIds(citizens, wallet)).resolves.toEqual([707n]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input).includes("/getNFTsForContract"),
    )).toHaveLength(1);
  });

  it("fails visibly when neither Alchemy index can account for balanceOf", async () => {
    h.appConfig.nftUrl = "https://nft.example";
    const citizens = "0x8888888888888888888888888888888888888888" as const;
    const wallet = "0x9999999999999999999999999999999999999999" as const;
    h.readContract.mockResolvedValue(1n);
    h.multicall.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("/getNFTsForOwner")
        ? { ownedNfts: [] }
        : { nfts: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(fetchOwnedTokenIds(citizens, wallet)).rejects.toThrow(
      /balanceOf reports 1, but only 0 token ID\(s\) were verified/,
    );
  });
});
