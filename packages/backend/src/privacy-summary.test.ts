import { describe, it, expect, vi } from "vitest";
import { mempoolPrivacySummary, applyThorMode, THOR_OVERRIDES } from "@dat-bot/shared";

// runtime.js validates the process env through config.js on import, and MODE is "test" under
// vitest. Mocked exactly as every other suite here does, so DEFAULT_STRATEGY can be read.
vi.mock("./config.js", () => ({
  appConfig: { mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent",
    gameAddress: "0x00000000000000000000000000000000000000aa", httpUrl: "http://localhost",
    builderUrls: [], ownedTokensOverride: [], targetTokensOverride: [], maxCandidates: 100 },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));

const { DEFAULT_STRATEGY } = await import("./runtime.js");

/**
 * The label on the collapsed mempool-privacy section.
 *
 * Worth its own coverage precisely BECAUSE the section is collapsed: a wrong summary here is
 * worse than no summary, since nothing prompts the operator to open the panel and discover it.
 * The panel's standing rule is that it must never show a value the engine is not using, and a
 * collapsed section keeps that rule only if this line is right.
 */
const cfg = (over: Partial<typeof DEFAULT_STRATEGY> = {}) => ({ ...DEFAULT_STRATEGY, ...over });

describe("mempoolPrivacySummary", () => {
  it("describes the shipped default", () => {
    // Everything private and all-or-nothing now, so the shipped summary and the Thor Mode
    // summary agree — the preset differs only in racePublicMempool, which has no clause here.
    expect(mempoolPrivacySummary(DEFAULT_STRATEGY)).toBe(
      "audits private, payments private, audits all-or-nothing, payments all-or-nothing, split",
    );
  });

  it("describes Thor Mode, payments included", () => {
    // The whole point of extending the preset: the summary has to SAY that payments went
    // private, or the riskiest setting in the bot is invisible behind a collapsed section.
    const on = applyThorMode(cfg({ thorMode: true }));
    expect(mempoolPrivacySummary(on)).toBe(
      "audits private, payments private, audits all-or-nothing, payments all-or-nothing, split",
    );
  });

  it("describes the fully public, fully tolerant, fused config", () => {
    expect(mempoolPrivacySummary(cfg({
      mirrorAudits: true, mirrorPayments: true,
      auditBundleAllOrNothing: false, paymentBundleAllOrNothing: false,
      combinedBoundaryBundle: true,
    }))).toBe("fused");
  });

  it("never returns empty — a blank line would read as a broken render", () => {
    // fused/split always contributes, so there is no config that summarises to nothing.
    for (const combined of [true, false]) {
      for (const mirror of [true, false]) {
        const out = mempoolPrivacySummary(cfg({
          combinedBoundaryBundle: combined, mirrorAudits: mirror, mirrorPayments: mirror,
          auditBundleAllOrNothing: false, paymentBundleAllOrNothing: false,
        }));
        expect(out.length, `combined=${combined} mirror=${mirror}`).toBeGreaterThan(0);
      }
    }
  });

  it("names every field Thor Mode touches, so none can go dark behind the collapse", () => {
    // Derived from THOR_OVERRIDES rather than hardcoded: a seventh override added later
    // without a matching summary clause fails here instead of silently disappearing.
    const on = applyThorMode(cfg({ thorMode: true }));
    const summary = mempoolPrivacySummary(on);
    const words: Record<keyof typeof THOR_OVERRIDES, string | null> = {
      mirrorAudits: "audits private",
      mirrorPayments: "payments private",
      auditBundleAllOrNothing: "audits all-or-nothing",
      paymentBundleAllOrNothing: "payments all-or-nothing",
      combinedBoundaryBundle: "split",
      racePublicMempool: null, // mid-epoch race: no boundary-shape clause of its own
    };
    for (const k of Object.keys(THOR_OVERRIDES) as (keyof typeof THOR_OVERRIDES)[]) {
      const w = words[k];
      if (w === null) continue;
      expect(summary, `${k} is unrepresented in the collapsed summary`).toContain(w);
    }
  });
});
