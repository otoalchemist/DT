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

const { checkAllyHolding, allyGateRequired, vaultAddressToStore } = await import("./ally-gate.js");

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

/**
 * A vault-held citizen must still count as yours.
 *
 * This is the lockout that actually happened: an operator moved their LAST citizen into the
 * CitizenVault, and the next unlock denied them. The gate asks "does one of these addresses
 * own a rostered citizen", and a vaulted citizen is owned by the CONTRACT — so a wallet-only
 * check reads a fully paid-up member as a stranger.
 *
 * The gate itself needs no change; it takes a list of addresses. What matters is that the
 * caller includes the vault, and that the vault address is saved BEFORE the gate runs. The
 * unlock endpoint owns both halves; these pin the gate's side of the contract.
 */
describe("ally gate with a vault", () => {
  const VAULT = "0xD00B158B8644B1FE387508Ceb2De021E87926D6E";

  beforeEach(() => {
    delete process.env.BOT_ALLY_GATE_OFF;
    // The realistic shape after migration: nothing left in the wallet, #2036 in the vault.
    filterLiveTokenIds.mockResolvedValue([
      { id: 100n, owner: THEIRS },
      { id: 358n, owner: THEIRS },
      { id: 2036n, owner: VAULT },
    ]);
  });
  afterEach(() => { filterLiveTokenIds.mockReset(); });

  it("denies a wallet-only check once the last citizen is vaulted", async () => {
    // The bug, reproduced: this is what locked the operator out.
    const v = await checkAllyHolding([MINE]);
    expect(v.ok).toBe(false);
  });

  it("allows it when the vault is among the addresses", async () => {
    const v = await checkAllyHolding([MINE, VAULT]);
    expect(v.ok).toBe(true);
    if (v.ok && v.reason === "held") {
      expect(v.tokenId).toBe("2036");
      expect(v.address.toLowerCase()).toBe(VAULT.toLowerCase());
    }
  });

  it("matches the vault case-insensitively, since config and chain disagree on casing", async () => {
    // The address is typed by a human into the unlock box and compared against whatever
    // casing the chain returns. A case-sensitive match would deny on a checksummed paste.
    const v = await checkAllyHolding([MINE, VAULT.toLowerCase()]);
    expect(v.ok).toBe(true);
  });
});

/**
 * What an unlock should do with the vault address it was handed.
 *
 * Extracted from the endpoint so it can be tested at all: a mutation that stopped the endpoint
 * saving the address entirely still passed the whole suite, because nothing covered the wiring.
 *
 * The rule that earns these tests is the negative one. Omitting the field must LEAVE THE
 * STORED ADDRESS ALONE, never clear it — an operator unlocking from an older client, or just
 * not touching the box, would otherwise silently lose a vault that is holding their citizens,
 * and the bot would stop seeing them and stop paying them without a word.
 */
describe("vaultAddressToStore", () => {
  const V = "0xD00B158B8644B1FE387508Ceb2De021E87926D6E";
  const OTHER = "0x1111111111111111111111111111111111111111";

  it("stores a newly supplied address", () => {
    expect(vaultAddressToStore(V, "")).toBe(V);
    expect(vaultAddressToStore(V, undefined)).toBe(V);
  });

  it("NEVER clears a stored vault when the field is omitted or blank", () => {
    for (const supplied of [undefined, "", "   "]) {
      expect(vaultAddressToStore(supplied, V), `supplied ${JSON.stringify(supplied)}`).toBeNull();
    }
  });

  it("ignores a malformed value rather than storing or clearing it", () => {
    // A half-pasted address must not overwrite a working one.
    for (const bad of ["0x123", "not-an-address", V.slice(0, -1), V + "ff"]) {
      expect(vaultAddressToStore(bad, V), `supplied ${bad}`).toBeNull();
    }
  });

  it("is a no-op when the supplied address already matches, whatever the casing", () => {
    expect(vaultAddressToStore(V, V)).toBeNull();
    expect(vaultAddressToStore(V.toLowerCase(), V)).toBeNull();
    expect(vaultAddressToStore(V, V.toLowerCase())).toBeNull();
  });

  it("does repoint when a DIFFERENT valid address is supplied", () => {
    // Deliberate: this request carries the passphrase, so whoever sent it is the owner.
    expect(vaultAddressToStore(OTHER, V)).toBe(OTHER);
  });

  it("trims, because the address arrives from a paste into a text box", () => {
    expect(vaultAddressToStore(`  ${V}  `, "")).toBe(V);
  });
});
