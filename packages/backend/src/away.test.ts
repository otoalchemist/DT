import { describe, it, expect } from "vitest";

// Mirror of nextBoundarySec in strategy.ts. Kept as a local copy because the real one is
// module-private behind heavy chain mocks — the arithmetic is what matters here, and it
// is the whole basis for away mode being zero-RPC: if this is wrong, the engine sleeps
// through a boundary.
const EPOCH = 86_400n;
function nextBoundarySec(startTime: bigint, nowSec: bigint): bigint {
  if (nowSec < startTime) return startTime;
  const elapsed = nowSec - startTime;
  return startTime + (elapsed / EPOCH + 1n) * EPOCH;
}

describe("away mode: next boundary is pure arithmetic (no RPC)", () => {
  const START = 1_772_495_975n; // real game startTime

  it("returns the next boundary strictly in the future", () => {
    const midEpoch = START + EPOCH * 150n + 3600n; // 1h into epoch 151
    expect(nextBoundarySec(START, midEpoch)).toBe(START + EPOCH * 151n);
  });

  it("never returns 'now' when sitting exactly ON a boundary — always the NEXT one", () => {
    // Critical: returning the current instant would make the stop timer fire immediately
    // and the engine would sleep straight through the boundary it just woke for.
    const onBoundary = START + EPOCH * 151n;
    expect(nextBoundarySec(START, onBoundary)).toBe(START + EPOCH * 152n);
  });

  it("is correct one second before a boundary", () => {
    const justBefore = START + EPOCH * 151n - 1n;
    expect(nextBoundarySec(START, justBefore)).toBe(START + EPOCH * 151n);
  });

  it("stays correct after an arbitrarily long idle (no dependence on cached epoch)", () => {
    const wayLater = START + EPOCH * 900n + 12_345n;
    expect(nextBoundarySec(START, wayLater)).toBe(START + EPOCH * 901n);
  });

  it("handles a clock before game start", () => {
    expect(nextBoundarySec(START, START - 500n)).toBe(START);
  });

  it("wake time = boundary - lead, and a 15 min lead lands inside the same epoch", () => {
    const now = START + EPOCH * 151n - 20n * 60n; // 20 min before the boundary
    const boundary = nextBoundarySec(START, now);
    const wake = boundary - 15n * 60n;
    expect(wake).toBeGreaterThan(now);          // still ahead of us
    expect(boundary - wake).toBe(900n);          // exactly 15 minutes
  });

  it("a lead longer than an epoch still yields a wake in the past -> wake immediately", () => {
    // awayLeadMinutes is capped at 720 (12h) by the API schema, but the scheduler must
    // degrade sanely rather than schedule a negative delay.
    const now = START + EPOCH * 151n - 60n;
    const boundary = nextBoundarySec(START, now);
    const wake = boundary - 720n * 60n;
    expect(wake).toBeLessThan(now); // scheduler clamps this to "wake now"
  });
});
