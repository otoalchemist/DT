import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STRATEGY, Runtime } from "./runtime.js";
import { appConfig } from "./config.js";
import { AtomicWriteCommittedError } from "./durability.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function v2Config() {
  const {
    combinedBoundaryBundle: _combined,
    coinbaseBidEnabled: _bidEnabled,
    coinbaseBidEth: _bidEth,
    coinbasePayerAddress: _payer,
    ...prior
  } = DEFAULT_STRATEGY;
  return { ...prior, offenseBoundaryScheduling: true };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("versioned strategy persistence", () => {
  it("reports the backend's authoritative submission mode", () => {
    const previousMode = appConfig.mode;
    appConfig.mode = "public";
    try {
      expect(new Runtime(tempDir()).status().mode).toBe("public");
    } finally {
      appConfig.mode = previousMode;
    }
  });

  it("emits the updated confirmed-spend value immediately", () => {
    const runtime = new Runtime(tempDir());
    runtime.currentEpoch = 7n;
    let confirmed = "0";
    const unsubscribe = runtime.onStatus((status) => {
      confirmed = status.confirmedSpendThisEpochWei;
    });

    runtime.recordConfirmedSpend(123n);

    expect(confirmed).toBe("123");
    unsubscribe();
  });

  it("restores confirmed spend exactly and keeps it bound to its epoch", () => {
    const runtime = new Runtime(tempDir());
    runtime.currentEpoch = 7n;
    runtime.recordConfirmedSpend(999n);

    runtime.restoreConfirmedSpend(7n, 123n);
    runtime.restoreConfirmedSpend(7n, 123n);
    expect(runtime.status().confirmedSpendThisEpochWei).toBe("123");

    runtime.currentEpoch = 8n;
    expect(runtime.status().confirmedSpendThisEpochWei).toBe("0");
  });

  it("migrates the shipped 10800-second buffer and legacy enabled/JIT fields", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      enabled: true,
      dryRun: false,
      auditSafetyBufferSeconds: 10_800,
      minBalanceEth: 0.42,
      priorityFeeGwei: 7,
      dynamicTipEnabled: false,
      jitEnabled: true,
      jitTargetEpoch: 123,
      jitTokenIds: ["7", "008"],
    }));

    const runtime = new Runtime(dir);

    expect(runtime.strategy.defenseEnabled).toBe(true);
    expect(runtime.strategy.auditSafetyBufferSeconds).toBe(86_400);
    expect(runtime.strategy.minBalanceEth).toBe(0.42);
    expect(runtime.strategy.replacementPriorityFeeCapGwei).toBe(7);
    expect(runtime.jitCampaign).toMatchObject({
      revision: 1,
      state: "armed",
      targetEpoch: 123,
      tokenIds: ["7", "8"],
      autoStopOnCompletion: false,
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.strategy.config.enabled).toBeUndefined();
    expect(persisted.strategy.config.auditSafetyBufferSeconds).toBe(86_400);
  });

  it("does not grant kill authority when a partial legacy offense config omitted it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      offenseEnabled: true,
    }));

    const runtime = new Runtime(dir);

    expect(runtime.strategy.offenseEnabled).toBe(true);
    expect(runtime.strategy.autoAudit).toBe(true);
    expect(runtime.strategy.autoKill).toBe(false);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(persisted.strategy.config.autoKill).toBe(false);
  });

  it.each([
    ["an empty token list", 123, []],
    ["epoch zero", 0, ["7"]],
    ["a fractional epoch", 12.5, ["7"]],
    ["an unsafe epoch", Number.MAX_SAFE_INTEGER + 1, ["7"]],
  ])("disarms legacy JIT with %s", (_label, jitTargetEpoch, jitTokenIds) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      jitEnabled: true,
      jitTargetEpoch,
      jitTokenIds,
    }));

    const runtime = new Runtime(dir);

    expect(runtime.jitCampaign).toMatchObject({
      revision: 1,
      state: "cancelled",
      targetEpoch: null,
      tokenIds: [],
      autoStopOnCompletion: false,
    });
    expect(() => new Runtime(dir)).not.toThrow();
  });

  it("keeps packaged rival defaults when mutable state uses another DATA_DIR", async () => {
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir();
    vi.resetModules();
    try {
      const isolated = await import("./runtime.js");
      expect(isolated.DEFAULT_STRATEGY.offenseTargetTokenIds).toEqual(DEFAULT_STRATEGY.offenseTargetTokenIds);
      expect(isolated.DEFAULT_STRATEGY.offenseTargetTokenIds.length).toBeGreaterThan(0);
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      vi.resetModules();
    }
  });

  it("preserves custom audit buffers while deriving the prior effective dynamic caps", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      auditSafetyBufferSeconds: 7_777,
      priorityFeeGwei: 4,
      dynamicTipEnabled: true,
      dynamicTipMaxGwei: 12,
      offensePriorityFeeGwei: 3,
      offenseDynamicTipEnabled: true,
      offenseDynamicTipMaxGwei: 9,
    }));

    const runtime = new Runtime(dir);
    expect(runtime.strategy.auditSafetyBufferSeconds).toBe(7_777);
    expect(runtime.strategy.replacementPriorityFeeCapGwei).toBe(12);
    expect(runtime.strategy.offenseReplacementPriorityFeeCapGwei).toBe(9);
  });

  it("clamps the formerly unbounded legacy auto-pay cap and canonicalizes target IDs", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      maxAutoPayEpochs: 99,
      offenseTargetTokenIds: ["007", "7", "0008"],
    }));

    const runtime = new Runtime(dir);
    expect(runtime.strategy.maxAutoPayEpochs).toBe(7);
    expect(runtime.strategy.offenseTargetTokenIds).toEqual(["7", "8"]);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(persisted.strategy.config.maxAutoPayEpochs).toBe(7);
    expect(persisted.strategy.config.offenseTargetTokenIds).toEqual(["7", "8"]);
  });

  it("canonicalizes and deduplicates target IDs on revisioned saves", () => {
    const runtime = new Runtime(tempDir());
    const saved = runtime.saveStrategy({ offenseTargetTokenIds: ["007", "7", "0008"] }, 0);
    expect(saved.config.offenseTargetTokenIds).toEqual(["7", "8"]);
  });

  it("persists JIT engine ownership in the independently revisioned campaign", () => {
    const dir = tempDir();
    const runtime = new Runtime(dir);
    runtime.saveJitCampaign({
      state: "armed",
      targetEpoch: 22,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    }, 0);

    const restored = new Runtime(dir);
    expect(restored.jitCampaign).toMatchObject({
      revision: 1,
      state: "armed",
      targetEpoch: 22,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    });
  });

  it("migrates a strict v2 envelope without changing strategy or JIT revisions", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      schemaVersion: 2,
      strategy: { revision: 7, config: v2Config() },
      jitCampaign: {
        revision: 4,
        state: "armed",
        targetEpoch: 22,
        tokenIds: ["7"],
        autoStopOnCompletion: true,
      },
    }));

    const runtime = new Runtime(dir);

    expect(runtime.strategyRevision).toBe(7);
    expect(runtime.jitCampaign).toMatchObject({ revision: 4, state: "armed", tokenIds: ["7"] });
    expect(runtime.strategy).toMatchObject({
      combinedBoundaryBundle: false,
      coinbaseBidEnabled: false,
      coinbaseBidEth: "0",
      coinbasePayerAddress: "",
    });
    expect("offenseBoundaryScheduling" in runtime.strategy).toBe(false);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.strategy.revision).toBe(7);
    expect(persisted.jitCampaign.revision).toBe(4);
    expect(persisted.strategy.config.offenseBoundaryScheduling).toBeUndefined();
  });

  it("stages a flat upstream bid but revokes implicit financial and combined authority", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      coinbaseBidEth: 0.015,
      coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
      combinedBoundaryBundle: true,
      offenseBoundaryScheduling: true,
    }));

    const runtime = new Runtime(dir);

    expect(runtime.strategy.coinbaseBidEth).toBe("0.015");
    expect(runtime.strategy.coinbasePayerAddress).toBe("0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815");
    expect(runtime.strategy.coinbaseBidEnabled).toBe(false);
    expect(runtime.strategy.combinedBoundaryBundle).toBe(false);
    expect("offenseBoundaryScheduling" in runtime.strategy).toBe(false);
  });

  it("refuses to silently round a nonzero legacy bid below one wei to zero", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      coinbaseBidEth: 1e-19,
    }));

    expect(() => new Runtime(dir)).toThrow(/smaller than one wei/);
  });

  it("canonicalizes builder amounts and requires a positive bid and payer before enabling", () => {
    const blank = new Runtime(tempDir());
    expect(() => blank.saveStrategy({ coinbaseBidEnabled: true }, 0))
      .toThrow(/coinbaseBidEth/);

    const runtime = new Runtime(tempDir());
    const staged = runtime.saveStrategy({ coinbaseBidEth: "0.010000000000000000" }, 0);
    expect(staged.config.coinbaseBidEth).toBe("0.01");

    expect(() => runtime.saveStrategy({ coinbaseBidEnabled: true }, 1))
      .toThrow(/coinbasePayerAddress/);
    expect(() => runtime.saveStrategy({
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
    }, 1)).toThrow(/coinbasePayerAddress/);
    expect(() => runtime.saveStrategy({ coinbaseBidEth: "0.0000000000000000001" }, 1))
      .toThrow(/at most 18 decimal places/);
  });

  it("fails closed for an unsupported or corrupt versioned envelope", () => {
    const unsupported = tempDir();
    fs.writeFileSync(path.join(unsupported, "config.json"), JSON.stringify({ schemaVersion: 999 }));
    expect(() => new Runtime(unsupported)).toThrow(/Unsupported strategy schemaVersion 999/);

    const corrupt = tempDir();
    fs.writeFileSync(path.join(corrupt, "config.json"), JSON.stringify({ schemaVersion: 2, strategy: {} }));
    expect(() => new Runtime(corrupt)).toThrow(/Invalid strategy v2 envelope/);
  });

  it("does not mutate in-memory state when an atomic persistence write fails", () => {
    const dir = tempDir();
    const notDirectory = path.join(dir, "blocked");
    fs.writeFileSync(notDirectory, "not a directory");
    const runtime = new Runtime(notDirectory);

    expect(() => runtime.saveStrategy({ defenseEnabled: true }, 0)).toThrow();
    expect(runtime.strategyRevision).toBe(0);
    expect(runtime.strategy.defenseEnabled).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "keeps memory aligned with a rename that committed before directory fsync failed",
    () => {
      const dir = tempDir();
      const runtime = new Runtime(dir);
      const originalFsync = fs.fsyncSync.bind(fs);
      vi.spyOn(fs, "fsyncSync")
        .mockImplementationOnce(originalFsync)
        .mockImplementationOnce(() => { throw new Error("simulated directory fsync failure"); });

      expect(() => runtime.saveStrategy({ defenseEnabled: true }, 0))
        .toThrow(AtomicWriteCommittedError);
      expect(runtime.strategyRevision).toBe(1);
      expect(runtime.strategy.defenseEnabled).toBe(true);
      vi.restoreAllMocks();
      const restored = new Runtime(dir);
      expect(restored.strategyRevision).toBe(1);
      expect(restored.strategy.defenseEnabled).toBe(true);
    },
  );
});
