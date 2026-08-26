import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Evidence-based nonce release.
 *
 * A held reservation must be let go when its transaction is dead, and never while it is alive.
 * The old rule was a 90-second wall clock, which cannot tell a dropped bundle from a slow one
 * — and got it wrong at the epoch-176 boundary, releasing a 2.4-second-old reservation whose
 * payment was still pending. The audit re-used that nonce, the payment was invalidated, and a
 * citizen went unpaid and got audited.
 *
 * The replacement asks the chain about the ONE nonce that can block us: `onchain`, the next
 * the account will execute. Everything held above it is unreachable until it resolves, so its
 * fate decides whether the ceiling is a real hold or a permanent gap.
 *
 * The asymmetry that drives every case below: releasing a LIVE nonce silently destroys a
 * transaction, while holding a DEAD one wedges the wallet until the backstop fires. The first
 * is worse, so anything ambiguous must hold.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const HASH = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;

let pendingNonce = 100;
let head = 1_000n;
/** What the node says about HASH: a tx object (pending/mined), or the not-found throw. */
let txLookup: (() => unknown) | null = null;

const getTransaction = vi.fn(async () => {
  if (!txLookup) throw new Error("Transaction could not be found");
  return txLookup();
});

vi.mock("./chain.js", () => ({
  publicClient: {
    getTransactionCount: vi.fn(async () => pendingNonce),
    getBlockNumber: vi.fn(async () => head),
    getTransaction,
  },
}));

const { NonceManager } = await import("./nonce.js");

/** Reserve `count` nonces and record each as signed, the way flashbots does at flush. */
async function reserveAndSign(
  m: InstanceType<typeof NonceManager>,
  count: number,
  opts: { mirrored: boolean; lastTargetBlock?: bigint },
): Promise<number[]> {
  await m.sync(ADDR, "mainnet");
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = m.reserve();
    m.markSigned(n, {
      hash: HASH,
      lastTargetBlock: opts.lastTargetBlock ?? head + 1n,
      mirrored: opts.mirrored,
    });
    out.push(n);
  }
  m.reset();
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  pendingNonce = 100;
  head = 1_000n;
  txLookup = () => ({ blockNumber: null }); // pending by default
});
afterEach(() => vi.useRealTimers());

describe("a reservation whose transaction is still alive", () => {
  it("is HELD even after the old 90s staleness window has passed", async () => {
    // The epoch-176 shape, with the clock pushed far past what used to release it. A mirrored
    // payment sitting in the mempool is alive no matter how long it has been there.
    const m = new NonceManager();
    const [payNonce] = await reserveAndSign(m, 1, { mirrored: true });
    expect(payNonce).toBe(100);

    vi.advanceTimersByTime(10 * 60_000); // 10 minutes: the clock would have released this
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(101); // held — the audit fire gets the NEXT nonce, not 100
  });

  it("is held when the transaction is already mined but the count has not caught up", async () => {
    const m = new NonceManager();
    await reserveAndSign(m, 1, { mirrored: true });
    txLookup = () => ({ blockNumber: 1_001n }); // mined; pending count lags
    vi.advanceTimersByTime(5 * 60_000);
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(101);
  });

  it("holds a bundle-only reservation while its target blocks are still reachable", async () => {
    // Not in the mempool because it was never broadcast — absence proves nothing yet.
    const m = new NonceManager();
    await reserveAndSign(m, 1, { mirrored: false, lastTargetBlock: 1_005n });
    txLookup = null; // node has never seen it
    vi.advanceTimersByTime(10 * 60_000);
    head = 1_004n; // still within reach
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(101);
  });
});

describe("a reservation whose transaction is provably dead", () => {
  it("releases a mirrored transaction the node no longer knows about", async () => {
    // Broadcast, so the node would have it if it existed. Absence means dropped, and holding
    // would wedge every later transaction behind a gap that can never fill.
    const m = new NonceManager();
    await reserveAndSign(m, 3, { mirrored: true });
    txLookup = null;
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(100); // back to chain truth, gap reusable
  });

  it("releases a bundle-only transaction once its last target block has passed", async () => {
    const m = new NonceManager();
    await reserveAndSign(m, 2, { mirrored: false, lastTargetBlock: 1_005n });
    txLookup = null;
    head = 1_006n; // bundle expired unmined
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(100);
  });

  it("releases without waiting out the old 90s window", async () => {
    // The other half of the improvement: evidence releases FASTER than the clock too, so a
    // genuinely dropped bundle no longer blocks the wallet for a minute and a half.
    const m = new NonceManager();
    await reserveAndSign(m, 1, { mirrored: true });
    txLookup = null;
    vi.advanceTimersByTime(1_000); // nowhere near STALE_MS
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(100);
  });
});

describe("when the chain cannot answer", () => {
  it("falls back to the clock and HOLDS a fresh reservation", async () => {
    const m = new NonceManager();
    await reserveAndSign(m, 1, { mirrored: true });
    getTransaction.mockRejectedValueOnce(new Error("rpc timeout")); // not a not-found
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(101); // ambiguity must hold, never release
  });

  it("falls back to the clock and releases an ancient reservation", async () => {
    // The backstop still has to exist, or an RPC outage during a dropped bundle would wedge
    // the wallet permanently.
    const m = new NonceManager();
    await reserveAndSign(m, 1, { mirrored: true });
    getTransaction.mockRejectedValue(new Error("rpc timeout"));
    vi.advanceTimersByTime(120_000); // past STALE_MS
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(100);
  });

  it("holds when the nonce was never tracked but the reservation is fresh", async () => {
    // Any path that reserves without marking (or a nonce below what we recorded) has no
    // evidence to offer; the clock governs, exactly as before.
    const m = new NonceManager();
    await m.sync(ADDR, "mainnet");
    m.reserve(); // no markSigned
    m.reset();
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(101);
    expect(getTransaction).not.toHaveBeenCalled(); // nothing to look up
  });
});

describe("bookkeeping", () => {
  it("stops tracking nonces the chain has passed, so the map cannot grow forever", async () => {
    const m = new NonceManager();
    await reserveAndSign(m, 5, { mirrored: true }); // 100..104
    pendingNonce = 105; // all mined
    await m.sync(ADDR, "mainnet");
    expect(m.peek()).toBe(105);
    // Nothing left to probe: the ceiling is satisfied, so no lookup should happen at all.
    getTransaction.mockClear();
    await m.sync(ADDR, "mainnet");
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("never probes in public mode, where the mempool is already the truth", async () => {
    const m = new NonceManager();
    await m.sync(ADDR, "public");
    const n = m.reserve();
    m.markSigned(n, { hash: HASH, lastTargetBlock: head, mirrored: true });
    m.reset();
    getTransaction.mockClear();
    await m.sync(ADDR, "public");
    expect(getTransaction).not.toHaveBeenCalled();
    expect(m.peek()).toBe(100); // pending count governs
  });
});
