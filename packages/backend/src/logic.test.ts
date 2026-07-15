import { describe, it, expect } from "vitest";
import type { StrategyConfig } from "@dat-bot/shared";
import {
  isAuditable,
  isKillable,
  classifyRisk,
  wouldBreachFloor,
  dynamicTipGwei,
  resolveGas,
  effectiveTipGwei,
} from "./logic.js";

describe("delinquency / audit math", () => {
  it("is not auditable until 2 epochs behind", () => {
    // currentEpoch = 10
    expect(isAuditable(10n, 10n)).toBe(false); // current
    expect(isAuditable(9n, 10n)).toBe(false); // 1 behind (grace)
    expect(isAuditable(8n, 10n)).toBe(true); // 2 behind
    expect(isAuditable(3n, 10n)).toBe(true);
  });

  it("is killable only after the audit deadline passes", () => {
    expect(isKillable(0n, 1000n)).toBe(false); // not under audit
    expect(isKillable(1000n, 999n)).toBe(false); // before deadline
    expect(isKillable(1000n, 1000n)).toBe(false); // exactly at deadline (> required)
    expect(isKillable(1000n, 1001n)).toBe(true); // past deadline
  });
});

describe("risk classification", () => {
  const now = 2000n;
  it("safe when current and not audited", () => {
    expect(classifyRisk(10n, 10n, 0n, now).risk).toBe("safe");
  });
  it("delinquent when >=2 behind and not audited", () => {
    expect(classifyRisk(8n, 10n, 0n, now).risk).toBe("delinquent");
  });
  it("audited with countdown when under active audit", () => {
    const r = classifyRisk(5n, 10n, 3000n, now);
    expect(r.risk).toBe("audited");
    expect(r.secondsUntilKillable).toBe(1000);
  });
  it("at-risk once audit expired", () => {
    const r = classifyRisk(5n, 10n, 1500n, now);
    expect(r.risk).toBe("at-risk");
    expect(r.secondsUntilKillable).toBe(-500);
  });
});

describe("spend guardrails", () => {
  it("floor: blocks spend that would drop below the balance floor", () => {
    expect(wouldBreachFloor(100n, 95n, 10n)).toBe(true); // 5 left < 10
    expect(wouldBreachFloor(100n, 80n, 10n)).toBe(false); // 20 left >= 10
  });
});

describe("dynamic priority tip", () => {
  const base = 2, max = 50;
  const half = 15_000_000n, full = 30_000_000n; // limit 30M

  it("returns base at or below 50% fill", () => {
    expect(dynamicTipGwei(base, max, 0n, full)).toBe(base);
    expect(dynamicTipGwei(base, max, half, full)).toBe(base); // exactly 50%
    expect(dynamicTipGwei(base, max, 10_000_000n, full)).toBe(base); // 33%
  });

  it("ramps linearly toward max above 50% fill", () => {
    // 75% fill => halfway from base to max = (2 + 50)/2 = 26
    expect(dynamicTipGwei(base, max, 22_500_000n, full)).toBeCloseTo(26, 5);
  });

  it("reaches max at a full block and never exceeds it", () => {
    expect(dynamicTipGwei(base, max, full, full)).toBeCloseTo(max, 5);
    expect(dynamicTipGwei(base, max, full * 2n, full)).toBeLessThanOrEqual(max);
  });

  it("degrades to base when gas limit is missing/zero", () => {
    expect(dynamicTipGwei(base, max, full, 0n)).toBe(base);
  });

  it("never returns below base even if max is misconfigured below base", () => {
    expect(dynamicTipGwei(10, 5, full, full)).toBe(10);
  });
});

describe("resolveGas (per-category gas split)", () => {
  // resolveGas only reads the 9 gas fields; cast a minimal fixture so this stays
  // a pure unit test (importing runtime would pull in env-parsing config).
  const base = {
    maxBaseFeeGwei: 30,
    priorityFeeGwei: 2,
    dynamicTipEnabled: false,
    dynamicTipMaxGwei: 50,
    offenseMaxBaseFeeGwei: 80,
    offensePriorityFeeGwei: 25,
    offenseDynamicTipEnabled: true,
    offenseDynamicTipMaxGwei: 120,
  } as StrategyConfig;

  it("uses base settings for payments regardless of the split flag", () => {
    for (const separateOffenseGas of [false, true]) {
      expect(resolveGas({ ...base, separateOffenseGas }, false)).toEqual({
        maxBaseFeeGwei: 30,
        priorityFeeGwei: 2,
        dynamicTipEnabled: false,
        dynamicTipMaxGwei: 50,
      });
    }
  });

  it("offense inherits base settings when the split is off", () => {
    expect(resolveGas({ ...base, separateOffenseGas: false }, true)).toEqual({
      maxBaseFeeGwei: 30,
      priorityFeeGwei: 2,
      dynamicTipEnabled: false,
      dynamicTipMaxGwei: 50,
    });
  });

  it("offense uses its own settings when the split is on", () => {
    expect(resolveGas({ ...base, separateOffenseGas: true }, true)).toEqual({
      maxBaseFeeGwei: 80,
      priorityFeeGwei: 25,
      dynamicTipEnabled: true,
      dynamicTipMaxGwei: 120,
    });
  });
});

describe("effectiveTipGwei (what computeFees actually bids)", () => {
  const full = 30_000_000n;
  const threeQuarters = 22_500_000n; // 75% fill -> halfway from base to max

  it("returns the static priority fee when dynamic tip is off", () => {
    const gas = { maxBaseFeeGwei: 30, priorityFeeGwei: 15.1, dynamicTipEnabled: false, dynamicTipMaxGwei: 50 };
    expect(effectiveTipGwei(gas, full, full)).toBe(15.1);
    expect(effectiveTipGwei(gas, 0n, full)).toBe(15.1);
  });

  it("scales the tip by block fullness when dynamic tip is on", () => {
    const gas = { maxBaseFeeGwei: 30, priorityFeeGwei: 2, dynamicTipEnabled: true, dynamicTipMaxGwei: 50 };
    expect(effectiveTipGwei(gas, 10_000_000n, full)).toBe(2); // 33% -> base
    expect(effectiveTipGwei(gas, threeQuarters, full)).toBeCloseTo(26, 5); // 75% -> (2+50)/2
    expect(effectiveTipGwei(gas, full, full)).toBeCloseTo(50, 5); // full -> ceiling
  });

  it("applies dynamic tip to the TAX-PAYMENT profile (offense=false) end to end", () => {
    // A payments config with dynamic tip on — exactly the real-world case where a
    // payTaxes tx bid a scaled-up tip. resolveGas(false) picks the base profile,
    // and effectiveTipGwei scales it, proving the payment path is covered.
    const strategy = {
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 15.1,
      dynamicTipEnabled: true,
      dynamicTipMaxGwei: 50,
      separateOffenseGas: true, // even with the split on, payments use the base profile
      offenseMaxBaseFeeGwei: 100,
      offensePriorityFeeGwei: 2,
      offenseDynamicTipEnabled: false,
      offenseDynamicTipMaxGwei: 50,
    } as StrategyConfig;

    const payGas = resolveGas(strategy, false);
    // 75% full: 15.1 + (50 - 15.1) * 0.5 = 32.55 gwei — scaled above the static 15.1.
    expect(effectiveTipGwei(payGas, threeQuarters, full)).toBeCloseTo(32.55, 5);

    // Offense here has dynamic tip off, so it stays flat at its static tip.
    const offGas = resolveGas(strategy, true);
    expect(effectiveTipGwei(offGas, threeQuarters, full)).toBe(2);
  });
});
