import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    results: [] as Array<
    | { status: "success"; result: `0x${string}` }
    | { status: "failure"; error: Error }
    >,
    multicall: vi.fn(),
    appConfig: {
      nftUrl: "" as string | undefined,
      ownedTokensOverride: [] as bigint[],
      targetTokensOverride: [] as bigint[],
      maxCandidates: 500,
    },
  };
  state.multicall.mockImplementation(async () => state.results);
  return state;
});

vi.mock("./chain.js", () => ({ publicClient: { multicall: h.multicall } }));
vi.mock("./config.js", () => ({ appConfig: h.appConfig }));
vi.mock("./logger.js", () => ({ logger: { warn: vi.fn() } }));

const { fetchOwnedTokenIds, filterOwnedTokenIds } = await import("./index-tokens.js");

describe("authoritative owned-token filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.results = [];
    h.appConfig.nftUrl = "";
    h.appConfig.ownedTokensOverride = [];
  });

  afterEach(() => vi.unstubAllGlobals());

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
      "0x4444444444444444444444444444444444444444",
    );

    expect(result).toHaveLength(525);
    expect(result.at(-1)).toBe(525n);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
