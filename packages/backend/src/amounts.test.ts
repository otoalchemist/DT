import { describe, expect, it } from "vitest";
import {
  configuredEthToWei,
  configuredGweiToWei,
  numberToPlainDecimal,
} from "./amounts.js";
import { DEFAULT_STRATEGY, strategyConfigSchema } from "./runtime.js";

describe("number-backed amount configuration", () => {
  it("expands supported scientific notation before ETH authorization conversion", () => {
    expect(numberToPlainDecimal(1e-7)).toBe("0.0000001");
    expect(configuredEthToWei(1e-7)).toBe(100_000_000_000n);
    expect(configuredGweiToWei(1e-7)).toBe(100n);

    const parsed = strategyConfigSchema.parse({
      ...DEFAULT_STRATEGY,
      minBalanceEth: 1e-7,
      maxPaymentEth: 1e-7,
      priorityFeeGwei: 1e-7,
    });
    expect(configuredEthToWei(parsed.minBalanceEth)).toBe(100_000_000_000n);
    expect(configuredEthToWei(parsed.maxPaymentEth)).toBe(100_000_000_000n);
    expect(configuredGweiToWei(parsed.priorityFeeGwei)).toBe(100n);
  });

  it.each([
    "maxBaseFeeGwei",
    "priorityFeeGwei",
    "replacementPriorityFeeCapGwei",
    "offenseMaxBaseFeeGwei",
    "offensePriorityFeeGwei",
    "offenseDynamicTipMaxGwei",
    "offenseReplacementPriorityFeeCapGwei",
    "dynamicTipMaxGwei",
  ] as const)("rejects an unsafe %s value before persistence", (field) => {
    expect(strategyConfigSchema.safeParse({
      ...DEFAULT_STRATEGY,
      [field]: 1e308,
    }).success).toBe(false);
  });

  it.each(["minBalanceEth", "maxPaymentEth"] as const)(
    "rejects an unrepresentable %s value before persistence",
    (field) => {
      expect(strategyConfigSchema.safeParse({
        ...DEFAULT_STRATEGY,
        [field]: 1e308,
      }).success).toBe(false);
      expect(strategyConfigSchema.safeParse({
        ...DEFAULT_STRATEGY,
        [field]: 1e-19,
      }).success).toBe(false);
    },
  );

  it("rejects a builder bid whose wei value cannot fit a transaction uint256", () => {
    expect(strategyConfigSchema.safeParse({
      ...DEFAULT_STRATEGY,
      coinbaseBidEth: `1${"0".repeat(60)}`,
    }).success).toBe(false);
  });
});
