import { describe, it, expect } from "vitest";
import { blendedTipGwei, bidToBeat, tipCostEth, GAS_PER_PAYMENT, GAS_PER_AUDIT } from "@dat-bot/shared";

/**
 * The blended tip the target-analysis panel prices against when payments and audits carry
 * different priority fees — which is the configuration the bot actually runs whenever
 * `separateOffenseGas` is on.
 *
 * The property that matters is not the arithmetic, it is that the blend is EXACT rather than
 * an approximation: keeping it gas-weighted is what lets every existing pricing formula stay
 * untouched and still produce the true combined figure. If someone ever "simplifies" this to
 * an arithmetic mean those formulas start lying, quietly, by the ratio of audit gas to payment
 * gas — so that identity is asserted directly below.
 */
describe("blendedTipGwei", () => {
  it("is the gas-weighted mean, so an audit's larger gas pulls it harder", () => {
    // 1 payment at 100 and 1 audit at 200. An arithmetic mean would say 150; the honest
    // answer leans to the audit, because it carries ~130k gas against the payment's ~83k.
    const blend = blendedTipGwei(1, 1, 100, 200);
    const expected = (100 * GAS_PER_PAYMENT + 200 * GAS_PER_AUDIT) / (GAS_PER_PAYMENT + GAS_PER_AUDIT);
    expect(blend).toBeCloseTo(expected, 9);
    expect(blend).toBeGreaterThan(150); // NOT the arithmetic mean
  });

  it("keeps tipCostEth exact: blend x total gas == the two tips priced separately", () => {
    // This identity is the whole reason for weighting by gas. It must hold at every shape,
    // including lopsided ones, or the cost figure under each Beat column is wrong.
    const shapes = [[1, 1], [5, 5], [9, 11], [1, 20], [20, 1], [3, 0], [0, 7]] as const;
    for (const [p, a] of shapes) {
      const blend = blendedTipGwei(p, a, 130, 375);
      const viaBlend = tipCostEth(blend, p, a);
      const separately = (130 * p * GAS_PER_PAYMENT + 375 * a * GAS_PER_AUDIT) / 1e9;
      expect(viaBlend).toBeCloseTo(separately, 12);
    }
  });

  it("collapses to a single tip when only one kind is present", () => {
    expect(blendedTipGwei(4, 0, 120, 999)).toBe(120); // no audits -> payment tip
    expect(blendedTipGwei(0, 4, 999, 300)).toBe(300); // no payments -> audit tip
  });

  it("returns the payment tip for an empty bundle rather than dividing by zero", () => {
    expect(blendedTipGwei(0, 0, 150, 400)).toBe(150);
    expect(Number.isNaN(blendedTipGwei(0, 0, 150, 400))).toBe(false);
  });

  it("equals either tip when both are the same, at any bundle shape", () => {
    expect(blendedTipGwei(7, 3, 200, 200)).toBeCloseTo(200, 9);
  });

  it("raising only the audit tip lowers the bid still needed, and never raises it", () => {
    // The panel's headline behaviour: a bigger tip is a bigger share of the bar already
    // cleared, so the residual bid must fall. Monotonic, so a user dragging the field up
    // never sees the required bid jump.
    const bids = [100, 200, 300, 400].map((auditTip) =>
      bidToBeat(450, blendedTipGwei(2, 2, 130, auditTip), 2, 2),
    );
    for (let i = 1; i < bids.length; i++) expect(bids[i]!).toBeLessThan(bids[i - 1]!);
  });

  it("a blend above the rival's density needs no bid at all", () => {
    const blend = blendedTipGwei(1, 1, 400, 500);
    expect(blend).toBeGreaterThan(300);
    expect(bidToBeat(300, blend, 1, 1)).toBe(0);
  });
});
