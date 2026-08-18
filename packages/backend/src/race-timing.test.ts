import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Same idiom as the other backend tests: mock config so the env-schema parse never runs.
const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-racetiming-"));
vi.mock("./config.js", () => ({
  appConfig: { dataDir: tmpRoot },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));
// The outcome path looks the winning builder up on-chain; stub it out.
vi.mock("./chain.js", () => ({
  publicClient: { getBlock: vi.fn(async () => ({ extraData: "0x" + Buffer.from("Titan (titanbuilder.xyz)").toString("hex") })) },
}));

const { recordRaceSubmission, recordRaceOutcome, awaitRaceTimingWrites } = await import("./race-timing.js");

const FILE = nodePath.join(tmpRoot, "race-timing.jsonl");
// Real delay, not setImmediate: the writes are genuine async disk I/O (fs/promises), so
// microtask draining does not wait for them to land.
// Deterministic: waits for the actual writes rather than sleeping. A fixed 60ms sleep here
// failed roughly 1 run in 4 under a full parallel suite, which is worse than no test.
const flush = async () => { await awaitRaceTimingWrites(); };
const read = () => fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001";
const row = (over: Record<string, unknown> = {}) => ({
  submittedAtMs: 1_786_579_170_000,
  targetBlock: "25742364",
  boundaryTs: 1_786_579_175,
  leadMs: 5000,
  acceptedBy: ["rpc.titanbuilder.xyz"],
  builderCount: 10,
  txCount: 3,
  gasLimitTotal: "274284",
  tipGwei: 30.1,
  bidWei: "30000000000000000",
  txHashes: [HASH],
  ...over,
});

/**
 * The telemetry exists to answer a question on-chain data cannot: how early we sent versus
 * where we landed. That only works if the two halves actually join, so these pin the join
 * and the guarantee that a telemetry failure can never affect a submission.
 */
describe("race timing telemetry", () => {
  beforeEach(() => { try { fs.rmSync(FILE, { force: true }); } catch { /* fresh */ } });
  afterEach(() => { vi.clearAllMocks(); });

  it("appends a submission row", async () => {
    recordRaceSubmission(row());
    await flush();
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leadMs: 5000, targetBlock: "25742364", tipGwei: 30.1 });
    expect(rows[0].landedIndex).toBeUndefined(); // not resolved yet
  });

  it("joins the outcome onto the submission by tx hash", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome(HASH, { blockNumber: 25742364n, transactionIndex: 57, status: "included" });
    await flush();
    const [r] = read();
    expect(r.landedIndex).toBe(57);
    expect(r.landedBlock).toBe("25742364");
    expect(r.hitTarget).toBe(true);      // landed in the block we named
    expect(r.status).toBe("included");
  });

  it("marks hitTarget false when a later block took it — the race was lost", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome(HASH, { blockNumber: 25742365n, transactionIndex: 0, status: "included" });
    await flush();
    expect(read()[0].hitTarget).toBe(false);
  });

  it("ignores an outcome for a hash it never submitted", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome("0xdead000000000000000000000000000000000000000000000000000000000000",
      { blockNumber: 1n, transactionIndex: 1, status: "included" });
    await flush();
    expect(read()[0].landedIndex).toBeUndefined();
  });

  it("resolves the right row when several submissions are pending", async () => {
    const H2 = "0xabc0000000000000000000000000000000000000000000000000000000000002";
    recordRaceSubmission(row());
    recordRaceSubmission(row({ txHashes: [H2], leadMs: 9000 }));
    await flush();
    recordRaceOutcome(H2, { blockNumber: 25742364n, transactionIndex: 3, status: "included" });
    await flush();
    const rows = read();
    expect(rows.find((r) => r.leadMs === 9000)?.landedIndex).toBe(3);
    expect(rows.find((r) => r.leadMs === 5000)?.landedIndex).toBeUndefined();
  });

  it("does not re-resolve a row that already has an outcome", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome(HASH, { blockNumber: 25742364n, transactionIndex: 57, status: "included" });
    await flush();
    recordRaceOutcome(HASH, { blockNumber: 99n, transactionIndex: 1, status: "reverted" });
    await flush();
    expect(read()[0].landedIndex).toBe(57); // first outcome wins
  });

  it("never throws when the data dir is unwritable — telemetry must not break a race", async () => {
    const { appConfig } = await import("./config.js");
    const prior = (appConfig as { dataDir: string }).dataDir;
    (appConfig as { dataDir: string }).dataDir = "\0invalid";
    expect(() => recordRaceSubmission(row())).not.toThrow();
    expect(() => recordRaceOutcome(HASH, { blockNumber: 1n, transactionIndex: 1, status: "included" })).not.toThrow();
    await flush();
    (appConfig as { dataDir: string }).dataDir = prior;
  });
});
