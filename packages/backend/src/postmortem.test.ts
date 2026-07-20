import { describe, expect, it, vi } from "vitest";
import type { PostMortemTx } from "@dat-bot/shared";

vi.mock("./chain.js", () => ({ publicClient: {} }));
vi.mock("./config.js", () => ({
  appConfig: {
    gameAddress: "0x1111111111111111111111111111111111111111",
    mode: "mainnet",
    httpUrl: "",
  },
}));

const { describePostMortemTransaction, judgePostMortemPair } = await import("./postmortem.js");

function row(overrides: Partial<PostMortemTx> = {}): PostMortemTx {
  return {
    hash: "0x" + "11".repeat(32),
    role: "ours",
    found: true,
    action: "payTaxes",
    args: "1, 1",
    from: "0x2222222222222222222222222222222222222222",
    blockNumber: "100",
    txIndex: 5,
    blockTs: 1_700_000_000,
    baseFeeGwei: 1,
    tipGwei: 100,
    effectiveGwei: 101,
    toGame: true,
    ...overrides,
  };
}

describe("race post-mortem builder-economics interpretation", () => {
  it("does not claim that visible priority tip caused same-block ordering", () => {
    const verdict = judgePostMortemPair(
      row(),
      row({ role: "rival", txIndex: 0, tipGwei: 1 }),
    );

    expect(verdict.outcome).toBe("lost-fee");
    expect(verdict.detail).toContain("ORDERING/BUILDER ECONOMICS");
    expect(verdict.detail).toContain("Priority tip alone is not conclusive");
    expect(verdict.detail).toContain("direct coinbase transfer");
  });

  it("still identifies a later-block result as timing regardless of tip", () => {
    const verdict = judgePostMortemPair(
      row({ blockNumber: "101", blockTs: 1_700_000_012 }),
      row({ role: "rival", blockNumber: "100", txIndex: 9, tipGwei: 1 }),
    );

    expect(verdict.outcome).toBe("lost-timing");
    expect(verdict.detail).toContain("our tip already ≥ theirs");
  });

  it("flags an empty-data value transfer as a possible builder incentive", () => {
    expect(describePostMortemTransaction("0x", 15_000_000_000_000_000n)).toEqual({
      action: "value-transfer",
      args: "0.015 ETH; possible builder incentive",
    });
  });
});
