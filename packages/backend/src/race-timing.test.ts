import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Same idiom as the other backend tests: mock config so the env-schema parse never runs.
//
// dataDir is MUTABLE and repointed per test (see beforeEach). race-timing.ts resolves its
// path on every call, so giving each test its own directory gives each its own log file.
// That matters more than it looks: the writes are fire-and-forget, so a pending write from
// one test could otherwise land after the next test wiped the shared file, recreating it
// with rows that test never wrote — which surfaced as assertions failing on state they had
// not created, intermittently and only when the machine was busy. Isolation removes the
// shared resource instead of trying to time around it.
const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-racetiming-"));
const cfg = { dataDir: tmpRoot };
vi.mock("./config.js", () => ({
  appConfig: cfg,
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));
// The outcome path looks the winning builder up on-chain; stub it out.
vi.mock("./chain.js", () => ({
  publicClient: { getBlock: vi.fn(async () => ({ extraData: "0x" + Buffer.from("Titan (titanbuilder.xyz)").toString("hex") })) },
}));

const { recordRaceSubmission, recordRaceOutcome } = await import("./race-timing.js");

/** This test's own log file — repointed by beforeEach, so tests never share one. */
const file = () => nodePath.join(cfg.dataDir, "race-timing.jsonl");
const read = () => fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * Wait for the fire-and-forget write to land — by watching for it, not by guessing how
 * long it takes.
 *
 * These are genuine async disk writes (fs/promises), so draining microtasks does not wait
 * for them. This used to be a flat 60ms sleep, which is really the assertion "a disk write
 * finishes within 60ms on this machine right now". That holds when the box is idle and
 * fails when it is not: adding a CPU-heavy test elsewhere in the suite (solc compiling a
 * contract in a parallel worker) made this file fail roughly one run in three, with nothing
 * wrong in the code under test.
 *
 * Polling asserts on the condition instead of on the clock, so it returns as soon as the
 * write lands — usually faster than the old sleep — and tolerates a busy machine. On
 * timeout it returns quietly and lets the real assertion report the real failure, rather
 * than throwing something less informative from in here.
 */
// Below vitest's 5s per-test timeout on purpose: if a condition never arrives, the test
// should fail on its own assertion (which says what was wrong) rather than on a timeout
// (which says only that something was slow).
const until = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (cond()) return; } catch { /* file not written yet */ }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Wait until the log holds `n` rows. */
const flush = async (n = 1) => until(() => read().length >= n);
/** Wait until row 0 satisfies `cond` — used for the outcome join, which UPDATES a row
 *  rather than appending one, so row count alone cannot tell you it has happened. */
const flushUpdate = async (cond: (r: Record<string, unknown>) => boolean) =>
  until(() => cond(read()[0] as Record<string, unknown>));

/**
 * Settle for the cases that assert something did NOT happen.
 *
 * There is no condition to wait for when the expected result is "no write", so this is the
 * one place a fixed delay is unavoidable. It is generous rather than tight: too short only
 * risks passing a test that should fail, never the reverse, and a slow machine must not be
 * able to turn "nothing happened" into a false pass by simply not having got there yet.
 */
const settle = async () => { await new Promise((r) => setTimeout(r, 250)); };

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
  // A fresh directory per test rather than a wiped shared file: nothing to leak, so no
  // draining or timing assumptions are needed to keep tests independent.
  beforeEach(() => { cfg.dataDir = fs.mkdtempSync(nodePath.join(tmpRoot, "t-")); });
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
    await flushUpdate((r) => r.landedIndex !== undefined);
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
    await flushUpdate((r) => r.landedIndex !== undefined);
    expect(read()[0].hitTarget).toBe(false);
  });

  it("ignores an outcome for a hash it never submitted", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome("0xdead000000000000000000000000000000000000000000000000000000000000",
      { blockNumber: 1n, transactionIndex: 1, status: "included" });
    await settle(); // asserting a non-event: there is no write to wait for
    expect(read()[0].landedIndex).toBeUndefined();
  });

  it("resolves the right row when several submissions are pending", async () => {
    const H2 = "0xabc0000000000000000000000000000000000000000000000000000000000002";
    recordRaceSubmission(row());
    recordRaceSubmission(row({ txHashes: [H2], leadMs: 9000 }));
    await flush(2);
    recordRaceOutcome(H2, { blockNumber: 25742364n, transactionIndex: 3, status: "included" });
    await until(() => read().some((r) => r.landedIndex === 3));
    const rows = read();
    expect(rows.find((r) => r.leadMs === 9000)?.landedIndex).toBe(3);
    expect(rows.find((r) => r.leadMs === 5000)?.landedIndex).toBeUndefined();
  });

  it("does not re-resolve a row that already has an outcome", async () => {
    recordRaceSubmission(row());
    await flush();
    recordRaceOutcome(HASH, { blockNumber: 25742364n, transactionIndex: 57, status: "included" });
    await flushUpdate((r) => r.landedIndex !== undefined);
    recordRaceOutcome(HASH, { blockNumber: 99n, transactionIndex: 1, status: "reverted" });
    await settle(); // asserting the second outcome is ignored — again, no write to await
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
