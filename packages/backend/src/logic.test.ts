import { describe, it, expect } from "vitest";
import type { StrategyConfig } from "@dat-bot/shared";
import {
  isAuditable,
  isKillable,
  isEligibleAuditor,
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
  orderBySalt,
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

  it("eligible auditor: needs audit capacity and must not be auditable itself", () => {
    // currentEpoch = 10, normal token (auditLimit 1).
    expect(isEligibleAuditor(10n, 10n, 0n, 1n)).toBe(true); // current, unused
    expect(isEligibleAuditor(9n, 10n, 0n, 1n)).toBe(true); // 1 behind (grace) still audits
    expect(isEligibleAuditor(8n, 10n, 0n, 1n)).toBe(false); // 2 behind -> itself auditable
    expect(isEligibleAuditor(10n, 10n, 1n, 1n)).toBe(false); // capacity used up this epoch
    // auditor-role token (limit 3): can audit until it hits the limit.
    expect(isEligibleAuditor(10n, 10n, 2n, 3n)).toBe(true);
    expect(isEligibleAuditor(10n, 10n, 3n, 3n)).toBe(false);
  });

  // The combined bundle pays a token and then audits FROM it in the same atomic
  // bundle (the batch-auditor pattern). findPreBoundaryAuditors re-tests eligibility
  // with lastEpochPaid+1 for tokens paid earlier in that bundle, because the chain
  // still reads the pre-payment value. This pins that arithmetic.
  it("a token paid earlier in the same bundle becomes an eligible auditor", () => {
    // Real case: token 2036 sits at lastEpochPaid=140 racing into epoch 142.
    const lastEpochPaid = 140n;
    const targetEpoch = 142n;
    // As the chain reads it: 2 behind at 142 -> auditable itself -> cannot audit.
    expect(isEligibleAuditor(lastEpochPaid, targetEpoch, 0n, 1n)).toBe(false);
    // After the bundle's payTaxes(+1 epoch) lands first, it is current -> can audit.
    expect(isEligibleAuditor(lastEpochPaid + 1n, targetEpoch, 0n, 1n)).toBe(true);
    // One epoch of credit is not a blank cheque: 3 behind is still disqualified,
    // so we never queue an audit the payment can't actually rescue.
    expect(isEligibleAuditor(139n + 1n, targetEpoch, 0n, 1n)).toBe(false);
    // Capacity still applies to a just-paid auditor.
    expect(isEligibleAuditor(lastEpochPaid + 1n, targetEpoch, 1n, 1n)).toBe(false);
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

  describe("autoPayCapWei / withinAutoPayCap (per-payment SPEND cap)", () => {
    // Verified on-chain: estimateTaxesToPay(id, n) = (epochsBehind + n - 1) * epoch * base.
    // Probed at epoch 148 against mainnet: 1 behind -> 148 base units (0.10212 ETH),
    // 2 behind -> 296 units (0.20424 ETH). Clamping n cannot reduce the catch-up, so
    // the limit has to be enforced as a spend cap that DECLINES the payment.
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

describe("orderBySalt (per-engine rival sweep shuffle)", () => {
  const items = ["206", "257", "272", "382", "388", "401", "553", "711", "794", "831"];

  it("is a pure permutation — same elements, just reordered", () => {
    const result = orderBySalt(items, (x) => x, 12345);
    expect([...result].sort()).toEqual([...items].sort());
    expect(result).toHaveLength(items.length);
  });

  it("is deterministic for a given salt", () => {
    const a = orderBySalt(items, (x) => x, 42);
    const b = orderBySalt(items, (x) => x, 42);
    expect(a).toEqual(b);
  });

  it("produces a different order for different salts", () => {
    const a = orderBySalt(items, (x) => x, 1);
    const b = orderBySalt(items, (x) => x, 2);
    expect(a).not.toEqual(b);
  });

  it("does not mutate the input array", () => {
    const copy = [...items];
    orderBySalt(items, (x) => x, 7);
    expect(items).toEqual(copy);
  });

  it("handles an empty list", () => {
    expect(orderBySalt([], (x: string) => x, 99)).toEqual([]);
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
