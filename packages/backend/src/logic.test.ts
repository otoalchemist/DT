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
  canAffordSpend,
  preBoundaryTaxWei,
  cappedAutoPayEpochs,
  autoPayCapWei,
  withinAutoPayCap,
  excludedTokenSet,
  resolveJitTarget,
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

  describe("preBoundaryTaxWei (JIT pays one upcoming epoch's amount)", () => {
    const BASE = 690_000_000_000_000n; // 0.00069 ETH

    it("matches the real fast tx: target epoch 136 -> 1 x 136 x base", () => {
      // fast #1 paid payTaxes(272,1) with 0.09384 ETH landing in epoch 136.
      expect(preBoundaryTaxWei(135n, 136n, 1, BASE)).toBe(136n * BASE); // 0.09384 ETH
    });

    it("pays only the target epoch's amount even when 2 epochs behind", () => {
      // Regression: #2036 (lastEpochPaid 135) at target epoch 137 must send
      // 1 x 137 x base = 0.09453 — the amount every successful payer used in the
      // boundary block. The old catch-up value (2 x 137 = 0.18906) reverted with
      // IncorrectPayment.
      expect(preBoundaryTaxWei(135n, 137n, 1, BASE)).toBe(137n * BASE); // 0.09453 ETH
      expect(preBoundaryTaxWei(135n, 137n, 1, BASE)).not.toBe(2n * 137n * BASE);
    });

    it("is the same amount regardless of how far behind the token is", () => {
      const oneBehind = preBoundaryTaxWei(137n, 138n, 1, BASE); // 1 behind at 138
      const twoBehind = preBoundaryTaxWei(136n, 138n, 1, BASE); // 2 behind at 138
      expect(oneBehind).toBe(138n * BASE); // 0.09522 ETH
      expect(twoBehind).toBe(oneBehind);
    });

    it("scales with numEpochs", () => {
      expect(preBoundaryTaxWei(135n, 136n, 2, BASE)).toBe(2n * 136n * BASE);
    });

    it("returns 0 when already current for the target epoch", () => {
      expect(preBoundaryTaxWei(136n, 136n, 1, BASE)).toBe(0n);
      expect(preBoundaryTaxWei(137n, 136n, 1, BASE)).toBe(0n);
    });
  });

  describe("cappedAutoPayEpochs (per-payment epoch cap)", () => {
    it("default cap 1: a JIT single-epoch request stays 1 regardless of delinquency", () => {
      expect(cappedAutoPayEpochs(1, 1)).toBe(1);
    });
    it("clamps a multi-epoch prepay request down to the cap", () => {
      expect(cappedAutoPayEpochs(7, 1)).toBe(1); // prepay 7 but cap 1 -> pay 1
      expect(cappedAutoPayEpochs(5, 2)).toBe(2); // prepay 5, cap 2 -> pay 2
    });
    it("does not reduce a request already within the cap", () => {
      expect(cappedAutoPayEpochs(2, 5)).toBe(2);
    });
    it("never returns less than 1", () => {
      expect(cappedAutoPayEpochs(0, 1)).toBe(1);
      expect(cappedAutoPayEpochs(1, 0)).toBe(1);
    });
  });

  describe("excludedTokenSet (never-pay opt-out)", () => {
    it("normalizes ids so padded/hex forms still match", () => {
      // An exclusion entry that didn't string-match its
      // canonical form was silently skipped. Here a miss would PAY a citizen the user
      // deliberately abandoned, so every form must collapse to the same key.
      const { set } = excludedTokenSet(["206", "0206", "0x00ce", "1612"]);
      expect(set.has("206")).toBe(true);
      expect(set.has("1612")).toBe(true);
      expect(set.size).toBe(2); // 206 / 0206 / 0xce are one citizen
    });

    it("reports unparseable entries instead of silently dropping them", () => {
      const { set, invalid } = excludedTokenSet(["206", "not-a-token", ""]);
      expect(set.has("206")).toBe(true);
      expect(invalid).toEqual(["not-a-token", ""]);
    });

    it("is empty for an empty list, so nothing is excluded by default", () => {
      const { set, invalid } = excludedTokenSet([]);
      expect(set.size).toBe(0);
      expect(invalid).toEqual([]);
    });
  });

  describe("autoPayCapWei / withinAutoPayCap (per-payment SPEND cap)", () => {
    // What the chain quotes depends on whether the citizen is UNDER AUDIT — the single
    // most misread fact in this codebase, and worth pinning because getting it backwards
    // once already produced a false "the payment will revert" alarm.
    //
    //   not audited -> n * epoch * base. One epoch's price advances a citizen to current
    //     however far behind it is. Verified: #2711 went lastEpochPaid 157 -> 159 paying
    //     1 * 159 * base (blk 25706529), and unaudited 2-behind citizens (#988, #99,
    //     #113 at blk 25713687) were each quoted exactly 1x.
    //   under audit -> (epochsBehind + n - 1) * epoch * base. Verified: #794 and #2036
    //     were quoted 2x while 2 behind, and paying 1x reverted IncorrectPayment().
    //
    // Consequence for this cap: a 1-epoch limit does NOT block curing an unaudited
    // citizen that is several epochs behind, because the quote is still one epoch. It
    // only bites once the citizen is audited. Clamping n cannot reduce a settle quote,
    // so the limit is enforced as a spend cap that DECLINES the payment.
    const BASE = 690_000_000_000_000n; // BASE_TAX_RATE_WEI
    const EPOCH = 148n;
    const oneEpoch = 148n * BASE; // 0.10212 ETH — a token 1 behind
    const twoEpochs = 296n * BASE; // 0.20424 ETH — a token 2 behind (mainnet tx 0x90cdbae4…)

    it("caps at N epochs of tax at the current rate", () => {
      expect(autoPayCapWei(1, EPOCH, BASE)).toBe(oneEpoch);
      expect(autoPayCapWei(2, EPOCH, BASE)).toBe(twoEpochs);
    });

    it("limit 1 admits a 1-behind token and rejects the 2-behind catch-up", () => {
      expect(withinAutoPayCap(oneEpoch, 1, EPOCH, BASE)).toBe(true);
      expect(withinAutoPayCap(twoEpochs, 1, EPOCH, BASE)).toBe(false);
    });

    it("limit 1 still admits an UNAUDITED citizen many epochs behind", () => {
      // The correction that matters operationally. An unaudited citizen 2, 3 or 10
      // epochs behind is quoted ONE epoch (the skip), so a 1-epoch limit lets the bot
      // cure it. Reading the quote as always-Nx is what made this look blocked, and
      // would argue for raising the cap — spending more, for no reason.
      expect(withinAutoPayCap(oneEpoch, 1, EPOCH, BASE)).toBe(true);
      // ...and the 2x quote it rejects is specifically the AUDITED case, where the
      // skip is revoked. That rejection is correct: it is the runaway-spend backstop.
      expect(withinAutoPayCap(twoEpochs, 1, EPOCH, BASE)).toBe(false);
    });

    it("raising the limit to 2 admits the same 2-behind catch-up", () => {
      expect(withinAutoPayCap(twoEpochs, 2, EPOCH, BASE)).toBe(true);
    });

    it("is inclusive at the boundary and rejects one wei over", () => {
      expect(withinAutoPayCap(oneEpoch, 1, EPOCH, BASE)).toBe(true);
      expect(withinAutoPayCap(oneEpoch + 1n, 1, EPOCH, BASE)).toBe(false);
    });

    it("treats a zero quote (already current) as within the cap", () => {
      expect(withinAutoPayCap(0n, 1, EPOCH, BASE)).toBe(true);
    });

    it("cap scales with the epoch, since tax is priced at the current rate", () => {
      expect(autoPayCapWei(1, 200n, BASE)).toBe(200n * BASE);
      // A 2-behind quote at epoch 100 (200 units) still exceeds a limit-1 cap there.
      expect(withinAutoPayCap(200n * BASE, 1, 100n, BASE)).toBe(false);
    });
  });

  describe("canAffordSpend (cumulative floor within a tick)", () => {
    it("allows a single spend that keeps the balance at/above the floor", () => {
      // 100 balance, floor 10; spend value 80 + gas 10 -> 10 left == floor.
      expect(canAffordSpend(100n, 0n, 80n, 10n, 10n)).toBe(true);
      // one wei more of value drops below the floor.
      expect(canAffordSpend(100n, 0n, 81n, 10n, 10n)).toBe(false);
    });

    it("blocks a later spend once earlier same-tick spend has eaten the headroom", () => {
      // Balance 100, floor 10. First payment (value 50 + gas 5 = 55) already
      // committed this tick. A second value-40 + gas-5 payment would leave
      // 100 - 55 - 45 = 0 < floor 10 -> must be blocked, even though on its own
      // (against the untouched 100 balance) it looks affordable.
      expect(canAffordSpend(100n, 0n, 40n, 5n, 10n)).toBe(true); // in isolation: fine
      expect(canAffordSpend(100n, 55n, 40n, 5n, 10n)).toBe(false); // cumulative: blocked
    });

    it("still allows a second spend when there is enough headroom for both", () => {
      expect(canAffordSpend(100n, 30n, 40n, 5n, 10n)).toBe(true); // 100-30-45 = 25 >= 10
    });
  });
});

describe("resolveJitTarget (arm-time epoch validation)", () => {
  it("defaults to the upcoming epoch when no target is given", () => {
    expect(resolveJitTarget(143)).toEqual({ ok: true, target: 144 });
  });

  it("accepts an explicit future target", () => {
    expect(resolveJitTarget(143, 200)).toEqual({ ok: true, target: 200 });
  });

  it("rejects an explicit target that has already begun (current epoch)", () => {
    const r = resolveJitTarget(143, 143);
    expect(r.ok).toBe(false);
  });

  it("rejects an explicit target in the past", () => {
    expect(resolveJitTarget(143, 140).ok).toBe(false);
  });

  it("rejects when the current epoch is unknown", () => {
    expect(resolveJitTarget(null).ok).toBe(false);
  });

  // The stale-epoch incident: the engine sat paused across the 142->143 boundary, so
  // runtime.currentEpoch was frozen at 142 while the chain was really in 143. Arming
  // off the STALE value defaulted the target to 143 — an epoch already underway — and
  // jitPass paid it on the next block instead of waiting for a boundary. The fix reads
  // the epoch fresh before resolving; these two cases pin the before/after so a refactor
  // can't reintroduce the footgun.
  it("off a STALE epoch (142) it defaults to 143 — the already-current epoch (the bug)", () => {
    // Demonstrates why the caller MUST refresh: with a stale 142 the default is 143,
    // which is <= the true current epoch and fires immediately.
    expect(resolveJitTarget(142)).toEqual({ ok: true, target: 143 });
  });

  it("off the FRESH epoch (143) it defaults to 144 — a real future boundary (the fix)", () => {
    expect(resolveJitTarget(143)).toEqual({ ok: true, target: 144 });
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

describe("resolveGas (payment gas)", () => {
  const base = {
    maxBaseFeeGwei: 30,
    priorityFeeGwei: 2,
    dynamicTipEnabled: false,
    dynamicTipMaxGwei: 50,
  } as StrategyConfig;

  it("returns the payment gas knobs", () => {
    expect(resolveGas(base)).toEqual({
      maxBaseFeeGwei: 30,
      priorityFeeGwei: 2,
      dynamicTipEnabled: false,
      dynamicTipMaxGwei: 50,
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

  it("applies dynamic tip to tax payments end to end", () => {
    const strategy = {
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 15.1,
      dynamicTipEnabled: true,
      dynamicTipMaxGwei: 50,
    } as StrategyConfig;

    const payGas = resolveGas(strategy);
    // 75% full: 15.1 + (50 - 15.1) * 0.5 = 32.55 gwei — scaled above the static 15.1.
    expect(effectiveTipGwei(payGas, threeQuarters, full)).toBeCloseTo(32.55, 5);
  });
});
