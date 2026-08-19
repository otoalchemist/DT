import { describe, it, expect } from "vitest";
import { densityTrend, type DensityPoint } from "@dat-bot/shared";

/**
 * Direction is the whole point of the trend, and it decides an operator's price for the next
 * boundary: "rising" means trust the peak, "falling" means recent behaviour is cheaper than the
 * peak suggests. So the cases that matter are the ones where a naive first-vs-last read gives
 * the wrong answer — a rival paying 0.6 gwei mid-epoch when nothing is at risk is normal, and
 * one such point at either end must not flip the verdict.
 */
const pts = (...d: number[]): DensityPoint[] => d.map((density, i) => ({ epoch: 160 + i, density }));

describe("densityTrend", () => {
  it("needs two points — one observation is not a trend", () => {
    expect(densityTrend([])).toBeNull();
    expect(densityTrend(pts(100))).toBeNull();
  });

  it("calls a steady escalation rising", () => {
    const t = densityTrend(pts(90, 120, 200, 364))!;
    expect(t.direction).toBe("rising");
    expect(t.slopePerEpoch).toBeGreaterThan(0);
    expect(Math.round(t.changePct)).toBe(304); // 90 -> 364
  });

  it("calls a retreat falling", () => {
    const t = densityTrend(pts(448, 300, 100, 2))!;
    expect(t.direction).toBe("falling");
    expect(t.slopePerEpoch).toBeLessThan(0);
  });

  it("calls a steady defender flat, at any scale", () => {
    // Same verdict for a 2 gwei rival and a 450 gwei one: the threshold is relative to the mean.
    expect(densityTrend(pts(100, 101, 99, 100))!.direction).toBe("flat");
    expect(densityTrend(pts(2, 2.1, 1.9, 2))!.direction).toBe("flat");
    expect(densityTrend(pts(448, 450, 446, 449))!.direction).toBe("flat");
  });

  it("is not swung by ONE cheap mid-epoch payment, at either end", () => {
    // The pattern that broke a least-squares version: four hard epochs and one 0.6 gwei
    // payment made when nothing was at risk. Wherever that point sits, the LEVEL has not
    // moved, and the median of pairwise slopes says so.
    const late = densityTrend(pts(360, 364, 366, 364, 0.6))!;
    expect(late.direction).toBe("flat");
    // ...while the raw endpoints still record what happened, for a reader who wants it.
    expect(late.changePct).toBeLessThan(-99);
    const early = densityTrend(pts(364, 0.6, 366, 364, 365))!;
    expect(early.direction).toBe("flat");
    // Least squares scored this one at +12.5% of the mean and called it "rising".
    expect(Math.abs(early.slopePerEpoch) / 291.9).toBeLessThan(0.05);
  });

  it("ignores gaps — epochs are x-values, not array positions", () => {
    // A rival that pays every OTHER epoch (Hedo does) must not have its slope inflated by
    // treating consecutive observations as consecutive epochs.
    const sparse: DensityPoint[] = [
      { epoch: 163, density: 2.1 },
      { epoch: 165, density: 95.7 },
      { epoch: 167, density: 35.8 },
      { epoch: 169, density: 98.0 },
    ];
    const dense: DensityPoint[] = sparse.map((p, i) => ({ epoch: 163 + i, density: p.density }));
    expect(densityTrend(sparse)!.slopePerEpoch).toBeLessThan(densityTrend(dense)!.slopePerEpoch);
    expect(densityTrend(sparse)!.direction).toBe("rising");
  });

  it("sorts by epoch, so an unordered series reads the same", () => {
    const ordered = densityTrend(pts(90, 120, 200, 364))!;
    const shuffled = densityTrend([
      { epoch: 162, density: 200 },
      { epoch: 160, density: 90 },
      { epoch: 163, density: 364 },
      { epoch: 161, density: 120 },
    ])!;
    expect(shuffled.direction).toBe(ordered.direction);
    expect(shuffled.first).toBe(90);
    expect(shuffled.last).toBe(364);
  });

  it("survives a zero-density series without dividing by zero", () => {
    const t = densityTrend(pts(0, 0, 0))!;
    expect(t.direction).toBe("flat");
    expect(t.changePct).toBe(0);
    expect(Number.isFinite(t.slopePerEpoch)).toBe(true);
  });

  it("reports how many epochs were observed, so a 2-point trend can be discounted", () => {
    expect(densityTrend(pts(10, 20))!.points).toBe(2);
    expect(densityTrend(pts(10, 20, 30, 40, 50))!.points).toBe(5);
  });
});
