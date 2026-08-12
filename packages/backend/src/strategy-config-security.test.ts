import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("./config.js", () => ({
  appConfig: { dataDir: `/tmp/dat-bot-strategy-config-tests-${process.pid}` },
}));
vi.mock("./activity.js", () => ({ activity: { add: vi.fn() } }));
vi.mock("./index-tokens.js", () => ({ ownershipIndexingAvailable: vi.fn(() => false) }));

const { DEFAULT_STRATEGY, DEFAULTS_VERSION, runtime, strategyConfigSchema, strategyPatchSchema } =
  await import("./runtime.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = `/tmp/dat-bot-strategy-config-tests-${process.pid}`;
const configPath = path.join(dataDir, "config.json");

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
}

afterEach(() => {
  fs.rmSync(configPath, { force: true });
  runtime.strategy = { ...DEFAULT_STRATEGY };
});

describe("strategy configuration security", () => {
  it("keeps spending and third-party payer behavior opt-in", () => {
    expect(DEFAULT_STRATEGY.enabled).toBe(false);
    expect(DEFAULT_STRATEGY.offenseEnabled).toBe(false);
    expect(DEFAULT_STRATEGY.autoDefendAudit).toBe(false);
    expect(DEFAULT_STRATEGY.coinbaseBidEth).toBe(0);
    expect(DEFAULT_STRATEGY.coinbaseBidAuditOnlyEth).toBe(0);
    expect(DEFAULT_STRATEGY.coinbasePayerAddress).toBe("");
  });

  it("canonicalizes and de-duplicates token ids", () => {
    const out = strategyPatchSchema.parse({ jitTokenIds: ["1", "2", "1"] });
    expect(out.jitTokenIds).toEqual(["1", "2"]);
  });

  it.each(["01", "-1", "1.5", (1n << 256n).toString()])(
    "rejects unsafe token id %s",
    (id) => {
      expect(() => strategyPatchSchema.parse({ offenseTargetTokenIds: [id] })).toThrow();
    },
  );

  it("rejects unknown fields and unbounded numeric controls", () => {
    expect(() => strategyPatchSchema.parse({ surpriseSpend: true })).toThrow();
    expect(() => strategyPatchSchema.parse({ maxAutoPayEpochs: 8 })).toThrow();
    expect(() => strategyPatchSchema.parse({ coinbaseBidEth: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => strategyPatchSchema.parse({ jitTokenIds: Array(10_001).fill("1") })).toThrow();
  });

  it("fails closed on unknown persisted fields instead of silently disabling a guard", () => {
    writeConfig({
      ...DEFAULT_STRATEGY,
      defaultsVersion: DEFAULTS_VERSION,
      maxPaymantEth: 100,
    });
    expect(() => runtime.loadStrategy()).toThrow(/refusing to start/);
  });

  it.each(["maxPaymentEth", "minBalanceEth", "excludedTokenIds"])(
    "fails closed when a current config omits safety field %s",
    (field) => {
      const config: Record<string, unknown> = {
        ...DEFAULT_STRATEGY,
        defaultsVersion: DEFAULTS_VERSION,
      };
      delete config[field];
      writeConfig(config);
      expect(() => runtime.loadStrategy()).toThrow(/refusing to start/);
    },
  );

  it("completes only explicitly introduced fields when migrating a v4 config", () => {
    const config: Record<string, unknown> = {
      ...DEFAULT_STRATEGY,
      defaultsVersion: 4,
      coinbaseBidEth: 0.005,
    };
    delete config.autoDefendAudit;
    delete config.awayMode;
    delete config.awayLeadMinutes;
    delete config.coinbaseBidAuditOnlyEth;
    writeConfig(config);

    expect(() => runtime.loadStrategy()).not.toThrow();
    expect(runtime.strategy.autoDefendAudit).toBe(false);
    expect(runtime.strategy.awayMode).toBe(false);
    expect(runtime.strategy.awayLeadMinutes).toBe(15);
    expect(runtime.strategy.coinbaseBidAuditOnlyEth).toBe(0.005);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(persisted.defaultsVersion).toBe(DEFAULTS_VERSION);
    expect(persisted.autoDefendAudit).toBe(false);
    expect(persisted.coinbaseBidAuditOnlyEth).toBe(0.005);
  });

  it("migrates the exact field shape shipped by the tracked v4 config example", () => {
    writeConfig({
      defaultsVersion: 4,
      enabled: false,
      proactivePay: true,
      prepayEpochs: 1,
      maxAutoPayEpochs: 1,
      jitEnabled: false,
      jitTargetEpoch: null,
      jitTokenIds: [],
      excludedTokenIds: [],
      preBoundaryPay: true,
      preBoundaryLeadMs: 3000,
      preBoundaryLeadMainnetMs: 5000,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      endgameOnlyWithin: null,
      offenseTargetTokenIds: ["206", "1612"],
      preBoundaryAudit: true,
      preBoundaryKill: true,
      combinedBoundaryBundle: true,
      maxBaseFeeGwei: 69.1,
      priorityFeeGwei: 20.1,
      minBalanceEth: 0.01,
      separateOffenseGas: true,
      offenseMaxBaseFeeGwei: 69.1,
      offensePriorityFeeGwei: 20.1,
      offenseDynamicTipEnabled: true,
      offenseDynamicTipMaxGwei: 69.1,
      racePublicMempool: true,
      dynamicTipEnabled: true,
      dynamicTipMaxGwei: 69.1,
      coinbaseBidEth: 0,
      coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
      maxPaymentEth: 0,
    });

    expect(() => runtime.loadStrategy()).not.toThrow();
    expect(runtime.strategy).toMatchObject({
      autoDefendAudit: false,
      awayMode: false,
      awayLeadMinutes: 15,
      coinbaseBidAuditOnlyEth: 0,
    });
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(persisted.defaultsVersion).toBe(DEFAULTS_VERSION);
    expect(Object.keys(persisted).sort()).toEqual(
      [...Object.keys(DEFAULT_STRATEGY), "defaultsVersion"].sort(),
    );
  });

  it("still rejects an established guardrail missing from a legacy config", () => {
    const config: Record<string, unknown> = {
      ...DEFAULT_STRATEGY,
      defaultsVersion: 4,
    };
    delete config.maxPaymentEth;
    writeConfig(config);
    expect(() => runtime.loadStrategy()).toThrow(/refusing to start/);
  });

  it("ships a complete, current and non-targeting example", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, "data/config.example.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw.defaultsVersion).toBe(DEFAULTS_VERSION);
    const { defaultsVersion: _meta, ...config } = raw;
    const parsed = strategyConfigSchema.parse(config);
    expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULT_STRATEGY).sort());
    expect(parsed.offenseEnabled).toBe(false);
    expect(parsed.offenseTargetTokenIds).toEqual([]);
    expect(parsed.coinbasePayerAddress).toBe("");
  });
});
