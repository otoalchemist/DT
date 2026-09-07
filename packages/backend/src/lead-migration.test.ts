import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Raising the mainnet pre-boundary lead 5s -> 8s on an EXISTING install.
 *
 * Why this is a migration and not a DEFAULTS_VERSION bump, which is the only interesting
 * thing about it: preBoundaryLeadMainnetMs is a RECOMMENDED_FIELD, so bumping the version
 * would ALSO overwrite priorityFeeGwei, offensePriorityFeeGwei, both base-fee caps, both
 * dynamic-tip ceilings and the curated target list. Every operator who needs the longer lead
 * is running a tip they chose on purpose — 200 to 369 gwei against a shipped 120 — so the
 * bump would cut their tip to a third on the very boundary it was supposed to help.
 *
 * So the property that actually matters here is a NEGATIVE one: the raise must move the lead
 * and nothing else. A test that only checked 5000 -> 8000 would pass just as happily against
 * the version bump that quietly resets a user's gas tuning.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dat-lead-mig-"));

vi.mock("./config.js", () => ({
  appConfig: { mode: "mainnet", dataDir: DATA_DIR, gameAddress: "0x00000000000000000000000000000000000000aa",
    httpUrl: "http://localhost", builderUrls: [], ownedTokensOverride: [], targetTokensOverride: [],
    maxCandidates: 100 },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));

const { runtime, DEFAULT_STRATEGY, DEFAULTS_VERSION, MIGRATIONS_VERSION } = await import("./runtime.js");

const CONFIG = path.join(DATA_DIR, "config.json");
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));

/** A saved config from an operator already on the current defaults version. */
function saveConfig(over: Record<string, unknown>) {
  fs.writeFileSync(CONFIG, JSON.stringify({
    ...DEFAULT_STRATEGY,
    defaultsVersion: DEFAULTS_VERSION, // NOT due a recommended-defaults refresh
    ...over,
  }, null, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(CONFIG)) fs.rmSync(CONFIG);
});

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe("pre-boundary lead migration, 5s -> 8s", () => {
  it("ships 8000 as the default", () => {
    expect(DEFAULT_STRATEGY.preBoundaryLeadMainnetMs).toBe(8000);
  });

  it("raises an install still on the old shipped 5000", () => {
    saveConfig({ preBoundaryLeadMainnetMs: 5000 });
    runtime.loadStrategy();
    expect(runtime.strategy.preBoundaryLeadMainnetMs).toBe(8000);
  });

  it("touches NOTHING else — the reason this is not a defaults bump", () => {
    // A real operator's tuning: a tip they chose deliberately, well above the shipped 120.
    saveConfig({
      preBoundaryLeadMainnetMs: 5000,
      priorityFeeGwei: 244, offensePriorityFeeGwei: 131,
      maxBaseFeeGwei: 300, offenseMaxBaseFeeGwei: 305,
      dynamicTipMaxGwei: 103, offenseDynamicTipMaxGwei: 250,
    });
    runtime.loadStrategy();
    expect(runtime.strategy.preBoundaryLeadMainnetMs).toBe(8000);
    // If any of these move, the migration has become the version bump it exists to avoid.
    expect(runtime.strategy.priorityFeeGwei).toBe(244);
    expect(runtime.strategy.offensePriorityFeeGwei).toBe(131);
    expect(runtime.strategy.maxBaseFeeGwei).toBe(300);
    expect(runtime.strategy.offenseMaxBaseFeeGwei).toBe(305);
    expect(runtime.strategy.dynamicTipMaxGwei).toBe(103);
    expect(runtime.strategy.offenseDynamicTipMaxGwei).toBe(250);
  });

  it("reaches existing users WITHOUT a defaults-version bump", () => {
    /**
     * The mechanism matters here, not just the outcome, and the test above cannot tell the
     * two apart — a mutation proved it. Its fixture stamps whatever DEFAULTS_VERSION
     * currently is, so bumping that constant moves the fixture with it and the refresh never
     * fires. It would pass just as happily against the change that resets every operator's
     * tip to the shipped 120.
     *
     * So pin the decision itself. A future change may legitimately need to bump
     * DEFAULTS_VERSION, but that has to be a deliberate act by someone who has re-read what
     * it does to a live operator's gas tuning mid-race. Editing this line is how they say so.
     */
    expect(DEFAULTS_VERSION).toBe(4);
    expect(MIGRATIONS_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("leaves a lead the user chose for themselves alone", () => {
    for (const lead of [3000, 6500, 10_000, 11_000]) {
      saveConfig({ preBoundaryLeadMainnetMs: lead });
      runtime.loadStrategy();
      expect(runtime.strategy.preBoundaryLeadMainnetMs, `lead ${lead}`).toBe(lead);
    }
  });

  it("never walks a longer lead back down", () => {
    saveConfig({ preBoundaryLeadMainnetMs: 11_000 });
    runtime.loadStrategy();
    expect(runtime.strategy.preBoundaryLeadMainnetMs).toBe(11_000);
  });

  it("persists the raise, so 5000 stays SETTABLE afterwards", () => {
    // Without the write, the raise re-applies on every start and the user can never choose
    // 5000 again — their setting would be silently reverted at each restart.
    saveConfig({ preBoundaryLeadMainnetMs: 5000 });
    runtime.loadStrategy();
    expect(readConfig().preBoundaryLeadMainnetMs).toBe(8000);

    runtime.saveStrategy({ preBoundaryLeadMainnetMs: 5000 }); // the user deliberately picks 5s
    runtime.loadStrategy();
    expect(runtime.strategy.preBoundaryLeadMainnetMs, "a deliberate 5s must survive").toBe(5000);
  });

  it("says so in the activity log rather than moving the lead silently", async () => {
    const { activity } = await import("./activity.js");
    saveConfig({ preBoundaryLeadMainnetMs: 5000 });
    runtime.loadStrategy();
    expect(activity.add).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("pre-boundary lead raised") }),
    );
  });

  it("is quiet when there is nothing to raise", async () => {
    const { activity } = await import("./activity.js");
    saveConfig({ preBoundaryLeadMainnetMs: 8000 });
    runtime.loadStrategy();
    expect(activity.add).not.toHaveBeenCalled();
  });
});

/**
 * Migration 2 — the private, all-or-nothing, split offense defaults.
 *
 * Same vehicle as migration 1 and for the same reason: mirrorAudits and
 * auditBundleAllOrNothing are not RECOMMENDED_FIELDS (a saved config keeps them forever), and
 * combinedBoundaryBundle IS one, so the only alternative route would be a DEFAULTS_VERSION
 * bump that also resets every operator's tip.
 *
 * Unlike migration 1 these are booleans, so this DOES override a deliberate choice. That is
 * accepted and one-shot — the stamp is what makes it one-shot, and that is the property most
 * worth pinning here.
 */
describe("offense defaults migration", () => {
  const OLD = { mirrorAudits: true, auditBundleAllOrNothing: false, combinedBoundaryBundle: true };

  it("ships all four of the requested defaults", () => {
    expect(DEFAULT_STRATEGY.thorMode).toBe(false);
    expect(DEFAULT_STRATEGY.mirrorAudits).toBe(false);
    expect(DEFAULT_STRATEGY.auditBundleAllOrNothing).toBe(true);
    expect(DEFAULT_STRATEGY.combinedBoundaryBundle).toBe(false);
  });

  it("moves an existing install off all three old values", () => {
    saveConfig({ ...OLD, migrationsVersion: 1 });
    runtime.loadStrategy();
    expect(runtime.strategy.mirrorAudits).toBe(false);
    expect(runtime.strategy.auditBundleAllOrNothing).toBe(true);
    expect(runtime.strategy.combinedBoundaryBundle).toBe(false);
  });

  it("leaves the PAYMENT mirror alone — this is an offense change only", () => {
    // The distinction the whole default rests on: a mirrored payment protects a citizen,
    // a mirrored audit names a target. Thor Mode kills both; this must not.
    saveConfig({ ...OLD, racePublicMempool: true, migrationsVersion: 1 });
    runtime.loadStrategy();
    expect(runtime.strategy.racePublicMempool).toBe(true);
    expect(runtime.strategy.thorMode).toBe(false);
  });

  it("does not touch gas tuning, same as migration 1", () => {
    saveConfig({ ...OLD, migrationsVersion: 1, priorityFeeGwei: 244, offensePriorityFeeGwei: 131 });
    runtime.loadStrategy();
    expect(runtime.strategy.priorityFeeGwei).toBe(244);
    expect(runtime.strategy.offensePriorityFeeGwei).toBe(131);
  });

  it("runs ONCE — the settings stay settable afterwards", () => {
    saveConfig({ ...OLD, migrationsVersion: 1 });
    runtime.loadStrategy();
    expect(readConfig().migrationsVersion).toBe(MIGRATIONS_VERSION);
    // An operator who wants the old offense behaviour back must be able to keep it.
    runtime.saveStrategy(OLD);
    runtime.loadStrategy();
    expect(runtime.strategy.mirrorAudits, "a deliberate re-enable must survive").toBe(true);
    expect(runtime.strategy.auditBundleAllOrNothing).toBe(false);
    expect(runtime.strategy.combinedBoundaryBundle).toBe(true);
  });

  it("is quiet when there is nothing left to move", async () => {
    const { activity } = await import("./activity.js");
    saveConfig({ mirrorAudits: false, auditBundleAllOrNothing: true,
                 combinedBoundaryBundle: false, migrationsVersion: 1 });
    runtime.loadStrategy();
    expect(activity.add).not.toHaveBeenCalled();
  });
});
