import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The ally-roster gate.
 *
 * As with access-code.test.ts, nothing here tests a security property — the gate is a
 * "members only" sign on code the user controls. What these tests pin is the DECISION TABLE,
 * and above all the fail-open half of it: every way the roster read can go wrong must still
 * let a real operator into their own bot. A regression that turns one of those branches into
 * a deny would be invisible until an RPC outage locked the team out mid-boundary.
 */

const ROSTER = ["100", "358", "2036"];
const MINE = "0xDE4B72239f6d6E2342cBc48Ca8fb04E05a25F1c7";
const THEIRS = "0x28eAd8F1a4b5B0A2D91E4Cf0b7D3aA9a1234ABCD";

type Live = { id: bigint; owner: string };

// Typed against the real signatures rather than cast: the point of these doubles is to keep
// the module honest about what it calls, and an `as any` here would switch that off.
const loadAllyTokens = vi.fn((): string[] => [...ROSTER]);
const resolveCitizensAddress = vi.fn(
  async (): Promise<string> => "0x4f249b2dc6cecbd549a0c354bbfc4919e8c5d3ae",
);
const filterLiveTokenIds = vi.fn(
  async (_citizens: string, _ids: bigint[]): Promise<Live[]> => [
    { id: 100n, owner: THEIRS },
    { id: 358n, owner: THEIRS },
    { id: 2036n, owner: MINE },
  ],
);

vi.mock("./runtime.js", () => ({ loadAllyTokens: () => loadAllyTokens() }));
vi.mock("./contract.js", () => ({
  resolveCitizensAddress: () => resolveCitizensAddress(),
  filterLiveTokenIds: (citizens: string, ids: bigint[]) => filterLiveTokenIds(citizens, ids),
}));

const { checkAllyHolding, allyGateRequired } = await import("./ally-gate.js");

const ORIGINAL = { ...process.env };

describe("ally-roster gate", () => {
  beforeEach(() => {
    delete process.env.BOT_ALLY_GATE_OFF;
    loadAllyTokens.mockReturnValue([...ROSTER]);
    filterLiveTokenIds.mockResolvedValue([
      { id: 100n, owner: THEIRS },
      { id: 358n, owner: THEIRS },
      { id: 2036n, owner: MINE },
    ]);
    resolveCitizensAddress.mockResolvedValue("0x4f249b2dc6cecbd549a0c354bbfc4919e8c5d3ae");
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.clearAllMocks();
  });

  it("admits a wallet holding a rostered citizen, and names which one", async () => {
    const v = await checkAllyHolding([MINE]);
    expect(v.ok).toBe(true);
    expect(v).toMatchObject({ reason: "held", tokenId: "2036" });
  });

  it("matches ignoring address case, since ownerOf and the keystore differ in checksum", async () => {
    expect((await checkAllyHolding([MINE.toLowerCase()])).ok).toBe(true);
    expect((await checkAllyHolding([MINE.toUpperCase().replace("0X", "0x")])).ok).toBe(true);
  });

  it("admits when ANY of several unlocked wallets holds one", async () => {
    const v = await checkAllyHolding(["0x0000000000000000000000000000000000000001", MINE]);
    expect(v).toMatchObject({ ok: true, reason: "held" });
  });

  it("denies a stranger, and reports how much roster it actually read", async () => {
    const v = await checkAllyHolding(["0x0000000000000000000000000000000000000001"]);
    expect(v).toEqual({ ok: false, reason: "not-held", checked: 3 });
  });

  it("denies a wallet that unlocked with no addresses at all", async () => {
    expect((await checkAllyHolding([])).ok).toBe(false);
  });

  // --- the fail-open half: none of these may deny ---

  it("allows when the RPC is down rather than locking the operator out", async () => {
    filterLiveTokenIds.mockRejectedValue(new Error("HTTP request failed"));
    const v = await checkAllyHolding(["0x0000000000000000000000000000000000000001"]);
    expect(v).toMatchObject({ ok: true, reason: "indeterminate", detail: "HTTP request failed" });
  });

  it("allows when the citizens address cannot be resolved", async () => {
    resolveCitizensAddress.mockRejectedValue(new Error("no rpc"));
    expect((await checkAllyHolding([THEIRS])).ok).toBe(true);
  });

  it("allows when the roster file is missing or empty", async () => {
    loadAllyTokens.mockReturnValue([]);
    const v = await checkAllyHolding(["0x0000000000000000000000000000000000000001"]);
    expect(v).toMatchObject({ ok: true, reason: "indeterminate" });
    // The roster is the input to the whole decision; not having it is not evidence.
    expect(filterLiveTokenIds).not.toHaveBeenCalled();
  });

  it("allows when the roster holds no parseable token ids", async () => {
    loadAllyTokens.mockReturnValue(["", "not-a-number"]);
    expect((await checkAllyHolding([MINE])).ok).toBe(true);
    expect(filterLiveTokenIds).not.toHaveBeenCalled();
  });

  it("allows when every rostered citizen reads as burned", async () => {
    // A roster that is entirely dead says the LIST is stale, not that the user is an outsider.
    filterLiveTokenIds.mockResolvedValue([]);
    const v = await checkAllyHolding(["0x0000000000000000000000000000000000000001"]);
    expect(v).toMatchObject({ ok: true, reason: "indeterminate" });
  });

  it("still judges on the good entries when one roster line is malformed", async () => {
    loadAllyTokens.mockReturnValue(["oops", "2036"]);
    expect((await checkAllyHolding([MINE])).ok).toBe(true);
    expect(filterLiveTokenIds).toHaveBeenCalledWith(expect.anything(), [2036n]);
  });

  it("a fork can switch the gate off entirely, without touching the chain", async () => {
    process.env.BOT_ALLY_GATE_OFF = "1";
    expect(allyGateRequired()).toBe(false);
    expect(await checkAllyHolding([])).toEqual({ ok: true, reason: "off" });
    expect(resolveCitizensAddress).not.toHaveBeenCalled();
  });

  it("reports the gate as required by default", () => {
    expect(allyGateRequired()).toBe(true);
  });
});
