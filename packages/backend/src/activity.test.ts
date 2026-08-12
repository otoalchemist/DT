import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Same idiom as the other backend tests: mock config so the real env-schema parse (which
// rejects vitest's MODE=test) never runs. dataDir points at a temp folder per test.
const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-activity-"));
vi.mock("./config.js", () => ({
  appConfig: { dataDir: tmpRoot },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

const { activity } = await import("./activity.js");

/**
 * The activity log's flush used to be a synchronous ~838 KB writeFileSync of the whole
 * 2000-entry log every 2 seconds — blocking the event loop in a process whose job is
 * winning sub-second boundary races, and `add()` is called while queueing a race bundle.
 *
 * It is async now, which introduces two new ways to lose data: a write in flight when a new
 * entry arrives, and a process exiting before a pending write gets a turn. These cover both,
 * plus the O(1) id index that replaced a linear scan over all 2000 entries in update().
 */
describe("activity log", () => {
  const logFile = nodePath.join(tmpRoot, "activity.json");

  beforeEach(() => {
    try { fs.rmSync(logFile, { force: true }); } catch { /* fresh anyway */ }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds and patches an entry by id", () => {
    const e = activity.add({ kind: "audit", status: "submitted", message: "test audit" });
    const updated = activity.update(e.id, { status: "included", targetBlock: "123" });
    expect(updated?.status).toBe("included");
    expect(updated?.targetBlock).toBe("123");
    // The patch lands on the stored entry, not a copy — recent() must show it.
    expect(activity.recent(10).find((x) => x.id === e.id)?.status).toBe("included");
  });

  it("returns null for an unknown id rather than throwing", () => {
    // Receipt tracking can fire after an entry was evicted from the ring buffer.
    expect(activity.update("no-such-id", { status: "included" })).toBeNull();
  });

  it("redacts provider credentials before an activity reaches memory or disk", () => {
    const entry = activity.add({
      kind: "error",
      status: "skipped",
      message: "RPC failed at https://eth-mainnet.g.alchemy.com/v2/secret-api-key",
    });
    expect(entry.message).not.toContain("secret-api-key");
    activity.flushSync();
    expect(fs.readFileSync(logFile, "utf8")).not.toContain("secret-api-key");
  });

  it("keeps update() working for an entry added much earlier", () => {
    const first = activity.add({ kind: "pay-taxes", status: "submitted", message: "early" });
    for (let i = 0; i < 200; i++) {
      activity.add({ kind: "info", status: "info", message: `filler ${i}` });
    }
    // Still resolvable: the index must track entries, not just the tail.
    expect(activity.update(first.id, { status: "included" })?.status).toBe("included");
  });

  it("persists to disk on flushSync, including the newest entry", () => {
    const e = activity.add({ kind: "kill", status: "submitted", message: "sync flush" });
    activity.flushSync();
    const onDisk = JSON.parse(fs.readFileSync(logFile, "utf8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.some((x: { id: string }) => x.id === e.id)).toBe(true);
  });

  it("does not lose an entry added while an async flush is in flight", async () => {
    // The ordering hazard: flush() clears `dirty` before awaiting the write. If it cleared
    // it after, an entry added mid-write would be marked clean and never persisted.
    activity.add({ kind: "info", status: "info", message: "before write" });
    const flushing = (activity as unknown as { flush: () => Promise<void> }).flush();
    const during = activity.add({ kind: "info", status: "info", message: "during write" });
    await flushing;
    // The in-flight write may not have contained it, but the log must be dirty again...
    await (activity as unknown as { flush: () => Promise<void> }).flush();
    const onDisk = JSON.parse(fs.readFileSync(logFile, "utf8"));
    expect(onDisk.some((x: { id: string }) => x.id === during.id)).toBe(true);
  });

  it("stays dirty when the write fails, so the log isn't silently lost", async () => {
    activity.add({ kind: "info", status: "info", message: "will fail to write" });
    const fsp = await import("node:fs/promises");
    const spy = vi.spyOn(fsp.default, "writeFile").mockRejectedValueOnce(new Error("EACCES"));
    await (activity as unknown as { flush: () => Promise<void> }).flush();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // A retry on the next interval must actually write, i.e. dirty was restored.
    await (activity as unknown as { flush: () => Promise<void> }).flush();
    expect(fs.existsSync(logFile)).toBe(true);
  });

  it("recovers from a corrupt log file instead of poisoning the hot path", async () => {
    // Previously the parsed value became `entries` verbatim, so a non-array made every
    // later push/slice throw — on the path that records every action the bot takes.
    fs.writeFileSync(logFile, JSON.stringify({ not: "an array" }));
    vi.resetModules();
    const { activity: fresh } = await import("./activity.js");
    expect(() => fresh.add({ kind: "info", status: "info", message: "after corrupt" })).not.toThrow();
    expect(fresh.recent(10).length).toBeGreaterThan(0);
  });
});
