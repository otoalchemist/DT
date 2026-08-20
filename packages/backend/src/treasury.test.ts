import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The treasury ledger splits real money, so these tests are mostly about arithmetic that
 * a float would get wrong and about the ways a re-scan could quietly corrupt the record.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dat-treasury-test-"));

vi.mock("./config.js", () => ({
  appConfig: { dataDir: DATA_DIR, httpUrl: "https://eth-mainnet.g.alchemy.com/v2/test-key" },
}));

const getBlockNumber = vi.fn(async () => 1_000n);
const getEnsName = vi.fn(async (_args?: unknown): Promise<string | null> => null);
vi.mock("./chain.js", () => ({
  publicClient: {
    getBlockNumber: () => getBlockNumber(),
    getEnsName: (a: unknown) => getEnsName(a),
  },
}));

let liveCitizens: { id: bigint; owner: string }[] = [];
vi.mock("./index-tokens.js", () => ({ fetchLiveCitizens: async () => liveCitizens }));

let emigrationRoster: { emigratedBy: string }[] = [];
vi.mock("./emigration.js", () => ({ fetchEmigrationRoster: async () => emigrationRoster }));

vi.mock("./contract.js", () => ({
  getGameSnapshot: async () => ({ citizensAddress: "0x00000000000000000000000000000000000000c1" }),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  syncTreasury,
  buildTreasuryLedger,
  upsertParticipant,
  annotateMovement,
  movementKeys,
  resetTreasuryCache,
  syncAvailable,
} = await import("./treasury.js");

const TREASURY = "0x9e5c3061910af922a8f60da430324e33cd364a79";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const PLAYER = "0x4444444444444444444444444444444444444444";

const eth = (n: string): string => {
  const [w = "0", f = ""] = n.split(".");
  return `0x${(BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"))).toString(16)}`;
};

/** One Alchemy transfer entry. */
const transfer = (o: {
  id: string; hash: string; from: string; to: string; wei: string; category?: string;
}) => ({
  uniqueId: o.id,
  hash: o.hash,
  from: o.from,
  to: o.to,
  value: 0.1,
  category: o.category ?? "external",
  blockNum: "0x64",
  rawContract: { value: o.wei },
  metadata: { blockTimestamp: "2026-08-01T00:00:00.000Z" },
});

let inbound: unknown[] = [];
let outbound: unknown[] = [];
let rpcError: { code?: number; message?: string } | null = null;
let badShape = false;

beforeEach(() => {
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  resetTreasuryCache();
  inbound = [];
  outbound = [];
  rpcError = null;
  badShape = false;
  liveCitizens = [];
  emigrationRoster = [];
  getEnsName.mockResolvedValue(null);

  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const params = body.params[0] as Record<string, unknown>;
    if (rpcError) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: rpcError }));
    const transfers = params.toAddress ? inbound : outbound;
    const result = badShape ? { transfers: [{ nope: true }] } : { transfers };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }));
});

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

/** Give Alice 5 citizens, Bob 3, Carol 2. */
function seedCitizens() {
  liveCitizens = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: BigInt(i), owner: ALICE })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: BigInt(10 + i), owner: BOB })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: BigInt(20 + i), owner: CAROL })),
  ];
}

describe("fair-share reconciliation", () => {
  it("splits the deployed total across every participant's citizens", async () => {
    seedCitizens();
    inbound = [
      transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") }),
      transfer({ id: "in-2", hash: "0xa2", from: CAROL, to: TREASURY, wei: eth("5") }),
    ];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("15") })];

    await syncTreasury();
    upsertParticipant({ address: BOB, optIn: true }); // pledged, has not paid

    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe((15n * 10n ** 18n).toString());
    expect(l.deployedWei).toBe((15n * 10n ** 18n).toString());
    expect(l.totalCitizens).toBe(10);
    expect(l.perCitizenWei).toBe((15n * 10n ** 17n).toString()); // 1.5 ETH

    const by = (a: string) => l.participants.find((p) => p.address === a)!;
    expect(by(ALICE).fairShareWei).toBe((75n * 10n ** 17n).toString()); // 7.5
    expect(by(ALICE).deltaWei).toBe((25n * 10n ** 17n).toString()); // +2.5
    expect(by(ALICE).position).toBe("credit");
    expect(by(BOB).fairShareWei).toBe((45n * 10n ** 17n).toString()); // 4.5
    expect(by(BOB).position).toBe("owes");
    expect(by(CAROL).position).toBe("credit");
  });

  it("keeps exact wei on an amount no float can hold", async () => {
    // 0.11661 ETH is the game's daily tax rate and is not representable in binary
    // floating point. Summed 3× it must land dead on 0.34983 ETH.
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [1, 2, 3].map((n) =>
      transfer({ id: `in-${n}`, hash: `0xa${n}`, from: ALICE, to: TREASURY, wei: eth("0.11661") }),
    );
    await syncTreasury();
    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe("349830000000000000");
  });

  it("nets every delta against the unspent balance", async () => {
    seedCitizens();
    inbound = [
      transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") }),
      transfer({ id: "in-2", hash: "0xa2", from: CAROL, to: TREASURY, wei: eth("5") }),
    ];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("12") })];
    await syncTreasury();
    upsertParticipant({ address: BOB, optIn: true });

    const l = await buildTreasuryLedger();
    const sum = l.participants.reduce((s, p) => s + BigInt(p.deltaWei ?? "0"), 0n);
    expect(sum).toBe(BigInt(l.onHandWei));
  });

  it("leaves a wallet we merely paid out of the divisor", async () => {
    seedCitizens();
    liveCitizens.push({ id: 99n, owner: PLAYER }); // the paid player holds a citizen too
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") })];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("5") })];
    await syncTreasury();

    const l = await buildTreasuryLedger();
    expect(l.participants.map((p) => p.address)).toEqual([ALICE]);
    expect(l.totalCitizens).toBe(5); // not 6 — the payee is not splitting the bill
  });

  it("reports no split at all before anything is deployed", async () => {
    seedCitizens();
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") })];
    await syncTreasury();
    const l = await buildTreasuryLedger();
    expect(l.perCitizenWei).toBe("0");
    expect(l.participants[0]!.fairShareWei).toBe("0");
  });
});

describe("operator annotations", () => {
  it("excludes a movement from the maths but keeps it on the record", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [
      transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") }),
      transfer({ id: "in-2", hash: "0xa2", from: ALICE, to: TREASURY, wei: eth("3") }),
    ];
    await syncTreasury();

    expect(annotateMovement("in-2", { excluded: true, note: "my own top-up" })).toBe(true);
    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe((10n * 10n ** 18n).toString());
    expect(l.movements).toHaveLength(2);
    expect(l.movements.find((m) => m.excluded)?.note).toBe("my own top-up");
  });

  it("survives a re-scan without losing the annotation", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") })];
    await syncTreasury();
    annotateMovement("in-1", { excluded: true, note: "refund" });

    await syncTreasury(); // the overlap window re-covers the same transfer
    const l = await buildTreasuryLedger();
    expect(l.movements).toHaveLength(1);
    expect(l.movements[0]!.excluded).toBe(true);
    expect(l.movements[0]!.note).toBe("refund");
    expect(l.raisedWei).toBe("0");
  });

  it("dedupes a re-scanned transfer on its uniqueId", async () => {
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") })];
    const first = await syncTreasury();
    const second = await syncTreasury();
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect((await buildTreasuryLedger()).movements).toHaveLength(1);
  });

  it("counts an internal transfer as real money", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [
      transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("2"), category: "internal" }),
    ];
    await syncTreasury();
    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe((2n * 10n ** 18n).toString());
    expect(l.movements[0]!.category).toBe("internal");
  });
});

describe("chain enrichment", () => {
  it("confirms a subsidy that actually bought a departure", async () => {
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("5") })];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("5") })];
    emigrationRoster = [{ emigratedBy: PLAYER }];
    await syncTreasury();
    upsertParticipant({ address: PLAYER, optIn: true });

    const l = await buildTreasuryLedger();
    expect(l.participants.find((p) => p.address === PLAYER)!.departuresConfirmed).toBe(1);
  });

  it("does not credit a departure that never happened", async () => {
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("5") })];
    emigrationRoster = [];
    await syncTreasury();
    upsertParticipant({ address: PLAYER, optIn: true });
    const l = await buildTreasuryLedger();
    expect(l.participants.find((p) => p.address === PLAYER)!.departuresConfirmed).toBe(0);
  });

  it("prefers a nickname over the ENS name", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    getEnsName.mockResolvedValue("alice.eth");
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    upsertParticipant({ address: ALICE, nickname: "The Banker" });

    const p = (await buildTreasuryLedger()).participants[0]!;
    expect(p.ens).toBe("alice.eth");
    expect(p.nickname).toBe("The Banker");
  });

  it("flags that citizen counts are missing rather than reporting zeroes as truth", async () => {
    liveCitizens = [];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    const l = await buildTreasuryLedger();
    expect(l.citizensAvailable).toBe(false);
    expect(l.totalCitizens).toBe(0);
  });
});

describe("RPC failure modes", () => {
  it("names the cause when the endpoint is not Alchemy", async () => {
    rpcError = { code: -32601, message: "method not found" };
    await expect(syncTreasury()).rejects.toThrow(/needs an Alchemy endpoint/);
  });

  it("refuses an unrecognised response instead of banking a wrong ledger", async () => {
    badShape = true;
    await expect(syncTreasury()).rejects.toThrow(/Unexpected alchemy_getAssetTransfers/);
  });

  it("leaves the stored ledger untouched when a sync fails", async () => {
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("7") })];
    await syncTreasury();
    const before = await buildTreasuryLedger();

    rpcError = { code: -32000, message: "upstream boom" };
    await expect(syncTreasury()).rejects.toThrow(/upstream boom/);

    resetTreasuryCache();
    const after = await buildTreasuryLedger();
    expect(after.raisedWei).toBe(before.raisedWei);
    expect(after.lastScannedBlock).toBe(before.lastScannedBlock);
  });

  it("tells an Alchemy endpoint apart from one that cannot auto-sync", () => {
    expect(syncAvailable("https://eth-mainnet.g.alchemy.com/v2/key")).toBe(true);
    expect(syncAvailable("https://rpc.ankr.com/eth")).toBe(false);
    expect(syncAvailable("")).toBe(false);
  });
});

describe("persistence", () => {
  it("reloads the ledger from disk", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("4") })];
    await syncTreasury();
    upsertParticipant({ address: BOB, optIn: true, nickname: "Bob" });

    resetTreasuryCache(); // forget everything in memory
    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe((4n * 10n ** 18n).toString());
    expect(l.participants.find((p) => p.address === BOB)!.nickname).toBe("Bob");
  });

  it("starts fresh when the file is corrupt rather than throwing on every read", async () => {
    fs.writeFileSync(path.join(DATA_DIR, "treasury.json"), "{ this is not json");
    resetTreasuryCache();
    const l = await buildTreasuryLedger();
    expect(l.raisedWei).toBe("0");
    expect(l.movements).toEqual([]);
  });

  it("pairs a movement back to its storage key for the UI", async () => {
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    const keys = movementKeys();
    expect(Object.values(keys)).toContain("in-1");
  });
});

describe("published-page bridge", () => {
  /**
   * The shareable page ingests this ledger verbatim (paste GET /api/treasury into its
   * import box). It reads a fixed set of fields, so renaming one here would silently
   * produce an empty public ledger rather than an error. Pin the contract.
   */
  it("exposes exactly the fields the published page reads", async () => {
    seedCitizens();
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("10") })];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("6") })];
    await syncTreasury();
    upsertParticipant({ address: BOB, optIn: true, nickname: "Bob" });

    const l = await buildTreasuryLedger();

    for (const field of ["wallet", "syncedAt", "movements", "participants"] as const) {
      expect(l).toHaveProperty(field);
    }
    for (const field of ["dir", "timestamp", "counterparty", "valueWei", "hash", "note", "excluded"] as const) {
      expect(l.movements[0]).toHaveProperty(field);
    }
    for (const field of ["address", "ens", "nickname", "citizens", "optIn"] as const) {
      expect(l.participants[0]).toHaveProperty(field);
    }
    // The page derives contributions from movements, so it must survive JSON transport
    // with every amount still an exact decimal-wei string.
    expect(typeof l.movements[0]!.valueWei).toBe("string");
    expect(JSON.parse(JSON.stringify(l)).movements[0].valueWei).toBe(l.movements[0]!.valueWei);
  });
});

describe("holders whose citizens live in another wallet", () => {
  const HOLDING = "0x6666666666666666666666666666666666666666";

  it("counts citizens from a linked wallet, not just the funding one", async () => {
    // Alice funds from her hot wallet but holds every citizen in a vault.
    liveCitizens = Array.from({ length: 4 }, (_, i) => ({ id: BigInt(i), owner: HOLDING }));
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("8") })];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("8") })];
    await syncTreasury();

    const before = await buildTreasuryLedger();
    expect(before.participants[0]!.citizens).toBe(0); // the bug this linkage fixes

    upsertParticipant({ address: ALICE, linked: [HOLDING] });
    const after = await buildTreasuryLedger();
    expect(after.participants[0]!.citizens).toBe(4);
    expect(after.participants[0]!.citizensSource).toBe("chain");
    expect(after.totalCitizens).toBe(4);
    expect(after.participants[0]!.deltaWei).toBe("0"); // paid 8, owes 8
  });

  it("folds a linked wallet's own contributions into one row", async () => {
    liveCitizens = [{ id: 1n, owner: HOLDING }];
    inbound = [
      transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("3") }),
      transfer({ id: "in-2", hash: "0xa2", from: HOLDING, to: TREASURY, wei: eth("2") }),
    ];
    await syncTreasury();
    upsertParticipant({ address: ALICE, linked: [HOLDING], nickname: "Alice" });

    const l = await buildTreasuryLedger();
    expect(l.participants).toHaveLength(1);
    expect(l.participants[0]!.contributedWei).toBe((5n * 10n ** 18n).toString());
  });

  it("never lists a linked wallet as its own participant", async () => {
    liveCitizens = [{ id: 1n, owner: HOLDING }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    upsertParticipant({ address: HOLDING, optIn: true }); // pledged in its own right...
    upsertParticipant({ address: ALICE, linked: [HOLDING] }); // ...then claimed by Alice

    const l = await buildTreasuryLedger();
    expect(l.participants.map((p) => p.address)).toEqual([ALICE]);
    expect(l.totalCitizens).toBe(1); // counted once, not twice
  });

  it("lets an explicit override beat the index", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    outbound = [transfer({ id: "out-1", hash: "0xb1", from: TREASURY, to: PLAYER, wei: eth("10") })];
    await syncTreasury();
    upsertParticipant({ address: ALICE, citizensOverride: 12 });

    const l = await buildTreasuryLedger();
    expect(l.participants[0]!.citizens).toBe(12);
    expect(l.participants[0]!.citizensSource).toBe("manual");
    expect(l.totalCitizens).toBe(12);
  });

  it("hands the count back to the index when the override is cleared", async () => {
    liveCitizens = [{ id: 1n, owner: ALICE }, { id: 2n, owner: ALICE }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    upsertParticipant({ address: ALICE, citizensOverride: 9 });
    expect((await buildTreasuryLedger()).participants[0]!.citizens).toBe(9);

    upsertParticipant({ address: ALICE, citizensOverride: null });
    const l = await buildTreasuryLedger();
    expect(l.participants[0]!.citizens).toBe(2);
    expect(l.participants[0]!.citizensSource).toBe("chain");
  });

  it("refuses to link a wallet to itself", async () => {
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    upsertParticipant({ address: ALICE, linked: [ALICE, HOLDING, HOLDING] });
    const l = await buildTreasuryLedger();
    expect(l.participants[0]!.linked).toEqual([HOLDING]); // self dropped, dupe collapsed
  });

  it("keeps a nickname, pledge and linkage across separate edits", async () => {
    liveCitizens = [{ id: 1n, owner: HOLDING }];
    inbound = [transfer({ id: "in-1", hash: "0xa1", from: ALICE, to: TREASURY, wei: eth("1") })];
    await syncTreasury();
    upsertParticipant({ address: ALICE, nickname: "Alice" });
    upsertParticipant({ address: ALICE, linked: [HOLDING] });
    upsertParticipant({ address: ALICE, optIn: true });

    const p = (await buildTreasuryLedger()).participants[0]!;
    expect(p.nickname).toBe("Alice");
    expect(p.linked).toEqual([HOLDING]);
    expect(p.optIn).toBe(true);
    expect(p.citizens).toBe(1);
  });
});
