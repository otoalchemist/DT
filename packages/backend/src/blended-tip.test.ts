import { describe, it, expect } from "vitest";
import { blendedTipGwei, bidToBeat, tipCostEth, GAS_PER_PAYMENT, GAS_PER_AUDIT, bundleGas } from "@dat-bot/shared";

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

/**
 * Batched gas, and the bid quoted off it.
 *
 * bundleGas used the STANDALONE per-action figures for a batch too, so it charged the 21,000
 * intrinsic once per action instead of once per transaction, and ignored that everything after
 * the first action hits warm storage. Since bidToBeat is (defense - tip) x gas, a vault
 * operator was quoted a bid inflated by the same 37-40%.
 *
 * The replacement is fitted on eight real batched transactions on mainnet. These pin its shape
 * and, above all, the direction it errs in: over, never under, because under-quoting a bid
 * loses the boundary while over-quoting only costs money.
 */
describe("batched bundle gas", () => {
  it("is cheaper than the same actions sent standalone", () => {
    // The whole reason for a vault. If these ever converge, batching has stopped paying.
    //
    // The threshold was 0.7 while the per-action figures were fitted on other operators'
    // large batches. Our own epoch-192 receipt measures the real saving at a two-call size:
    // 196,543 batched against 243,834 standalone, i.e. 0.806. The saving is smaller than the
    // borrowed fit implied because it is almost entirely the intrinsic gas we stop paying per
    // action - warm storage needs many calls to add much, and we do not send many.
    for (const [p, a] of [[1, 1], [9, 11], [11, 10]] as const) {
      expect(bundleGas(p, a, true)).toBeLessThan(bundleGas(p, a, false) * 0.85);
    }
  });

  it("matches our own live batch, and errs HIGH against it", () => {
    // The calibration point: epoch-192 boundary, tx 0x51586c79...43eb1e in block 25943258.
    // 1 payment + 1 audit, both calls succeeded, 196,543 gas on chain. This is the only batch
    // we have sent that carried a real payment and reverted nothing, so it is the only one
    // that measures what the model claims to predict.
    const modelled = bundleGas(1, 1, true);
    expect(modelled).toBeGreaterThan(196_543);        // never under-quote
    expect(modelled).toBeLessThan(196_543 * 1.05);    // but not by a wide margin

    // Guards the direction of the miss. The previous constants (46,000 / 82,000, fitted on
    // other operators' 2-to-21-action batches) said 159,100 for this receipt - 19% UNDER,
    // which is the direction that loses a boundary. Anything that drifts back below the
    // measured figure fails above; this pins that 159,100 specifically is not it.
    expect(modelled).toBeGreaterThan(159_100);
  });

  it("does not treat the reverted epoch-191 batch as a calibration point", () => {
    // 107,532 gas for 1 audit, but that audit REVERTED inside run(): it skipped the storage
    // writes a successful audit pays for. It bounds a successful audit from below and says
    // nothing about its actual cost, so the model must sit above it - not near it.
    expect(bundleGas(0, 1, true)).toBeGreaterThan(107_532);
  });

  it("charges intrinsic ONCE, not once per action", () => {
    // The actual defect. Two payments in a batch must not cost two lots of 21,000 more than
    // one — if the marginal ever approaches the standalone figure, the old model is back.
    const marginal = bundleGas(2, 0, true) - bundleGas(1, 0, true);
    expect(marginal).toBeLessThan(82_875 - 21_000 + 5_000);
  });

  it("leaves the unbatched path exactly as it was", () => {
    // Every operator without a vault must see identical numbers; this is the guard that the
    // batched work did not disturb them.
    expect(bundleGas(1, 1, false)).toBe(82_875 + 130_409 + 30_550);
    expect(bundleGas(9, 11, false)).toBe(9 * 82_875 + 11 * 130_409 + 30_550);
  });

  it("quotes a smaller bid for the same target once batched", () => {
    const unbatched = bidToBeat(216.6, 10, 9, 11, false);
    const batched = bidToBeat(216.6, 10, 9, 11, true);
    expect(batched).toBeLessThan(unbatched);
    expect(batched).toBeGreaterThan(0);
  });
});
