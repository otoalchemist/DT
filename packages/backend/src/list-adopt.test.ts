import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

vi.mock("./config.js", () => ({
  // saveStrategy() emits a status, which reaches ownershipIndexingAvailable() — hence the
  // override arrays, which it reads for length.
  appConfig: {
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    ownedTokensOverride: [],
    targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => ({ activity: { add: vi.fn() } }));

const { appConfig } = await import("./config.js");
const { runtime, adoptRefreshedLists, DEFAULT_STRATEGY } = await import("./runtime.js");

/**
 * `DEFAULT_STRATEGY.offenseTargetTokenIds` is a SNAPSHOT of rival-skippers.json taken at
 * import time, which is before the startup list sync runs. Every other consumer reads the
 * list file live, so a refreshed list reaches them for free — the pinned offense targets
 * are the one place that needs explicitly re-pointing, and that's what this covers.
 *
 * The rule being pinned: re-point only pins that were still tracking the old default. A
 * user who curated their own target box owns it, and silently rewriting it would change
 * who the bot spends ETH attacking without them asking.
 */
const SKIPPERS = "rival-skippers.json";

let tmpDir: string;
let priorDataDir: string;
const writeSkippers = (arr: string[]) =>
  fs.writeFileSync(nodePath.join(tmpDir, SKIPPERS), JSON.stringify(arr, null, 2) + "\n");

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-adopt-"));
  priorDataDir = (appConfig as { dataDir: string }).dataDir;
  (appConfig as { dataDir: string }).dataDir = tmpDir;
  runtime.strategy = { ...DEFAULT_STRATEGY };
});

afterEach(() => {
  (appConfig as { dataDir: string }).dataDir = priorDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("adoptRefreshedLists", () => {
  it("re-points pins that were still tracking the old default", async () => {
    const before = ["206", "388"];
    runtime.strategy.offenseTargetTokenIds = [...before];
    writeSkippers(["206", "388", "553"]); // sync brought in a new skipper

    expect(adoptRefreshedLists(before)).toBe(true);
    expect(runtime.strategy.offenseTargetTokenIds).toEqual(["206", "388", "553"]);
    // Persisted, so the new pins survive the restart that follows.
    const saved = JSON.parse(fs.readFileSync(nodePath.join(tmpDir, "config.json"), "utf8"));
    expect(saved.offenseTargetTokenIds).toEqual(["206", "388", "553"]);
  });

  it("leaves a hand-curated target box alone", async () => {
    const before = ["206", "388"];
    runtime.strategy.offenseTargetTokenIds = ["999"]; // the user picked their own
    writeSkippers(["206", "388", "553"]);

    expect(adoptRefreshedLists(before)).toBe(false);
    expect(runtime.strategy.offenseTargetTokenIds).toEqual(["999"]);
  });

  it("does nothing when the list did not change", async () => {
    const before = ["206", "388"];
    runtime.strategy.offenseTargetTokenIds = [...before];
    writeSkippers(["206", "388"]);

    expect(adoptRefreshedLists(before)).toBe(false);
    expect(runtime.strategy.offenseTargetTokenIds).toEqual(["206", "388"]);
  });

  it("treats a formatting-only difference as tracking, not customising", async () => {
    // "0206" and "206" are the same token; a zero-padded pin must not read as a custom
    // list and strand the user on a stale roster.
    const before = ["206", "388"];
    runtime.strategy.offenseTargetTokenIds = ["0206", "388"];
    writeSkippers(["206", "388", "553"]);

    expect(adoptRefreshedLists(before)).toBe(true);
    expect(runtime.strategy.offenseTargetTokenIds).toEqual(["206", "388", "553"]);
  });

  it("refreshes DEFAULT_STRATEGY so a later fresh install gets the new list", async () => {
    writeSkippers(["1", "2", "3"]);
    adoptRefreshedLists(["206"]);
    expect(DEFAULT_STRATEGY.offenseTargetTokenIds).toEqual(["1", "2", "3"]);
  });

  it("does not throw on a non-numeric pin", async () => {
    runtime.strategy.offenseTargetTokenIds = ["not-a-number"];
    writeSkippers(["206"]);
    expect(() => adoptRefreshedLists(["206", "388"])).not.toThrow();
  });
});
