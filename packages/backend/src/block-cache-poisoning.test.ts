import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Block } from "viem";

/**
 * A bad WebSocket frame must not poison the block cache.
 *
 * The bug this exists for, in full: `primeBlockCache` took whatever `watchBlocks` handed its
 * `onBlock` callback and stored it unconditionally. A reconnect — or a provider mid-maintenance
 * — can deliver an undefined or partial header, and caching one makes `getLatestBlockCached`
 * return that value to EVERY reader for the whole 3s TTL. `refreshSnapshot` then runs
 * `runtime.lastBlock = latest.number` and throws
 *
 *     Tick error: Cannot read properties of undefined (reading 'number')
 *
 * on every tick until the entry ages out.
 *
 * Observed at the epoch-180 boundary. The crash itself was cheap; what it cost was that the
 * operator paused and restarted the engine 38 seconds before the boundary, and the restart is
 * what lost the race (see cold-start-boundary.test.ts for that half).
 *
 * The property under test is DROP-AND-KEEP, not drop: rejecting the frame has to leave the
 * last good block in place, because blanking the cache would send every reader back to HTTP at
 * exactly the moment the socket is unhealthy.
 */

vi.mock("./config.js", () => ({
  appConfig: { httpUrl: "http://localhost:8545", wsUrl: null, mode: "mainnet" },
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { primeBlockCache, getLatestBlockCached } = await import("./chain.js");
const { publicClient } = await import("./chain.js");
const { logger } = await import("./logger.js");

/** A header shaped like the ones the subscription really delivers. */
const header = (n: bigint, ts: bigint): Block =>
  ({ number: n, timestamp: ts, baseFeePerGas: 7n, gasUsed: 1n, gasLimit: 2n }) as unknown as Block;

const GOOD = header(100n, 1_000n);

describe("primeBlockCache rejects unusable subscription frames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Any HTTP fallback in these tests would mask the cache behaviour, so make it loud.
    vi.spyOn(publicClient, "getBlock").mockRejectedValue(new Error("must not re-read over HTTP"));
    primeBlockCache(GOOD);
  });

  it("keeps the last good block when the socket delivers undefined", async () => {
    primeBlockCache(undefined);
    // The exact call refreshSnapshot makes. Before the fix this threw on `.number`.
    expect((await getLatestBlockCached()).number).toBe(100n);
  });

  it("keeps the last good block when the socket delivers null", async () => {
    primeBlockCache(null);
    expect((await getLatestBlockCached()).number).toBe(100n);
  });

  it("rejects a header with no number — a PENDING block is unusable as 'latest'", async () => {
    primeBlockCache({ ...GOOD, number: null } as unknown as Block);
    expect((await getLatestBlockCached()).number).toBe(100n);
  });

  it("rejects a header with no timestamp, which raceTargetFrom needs", async () => {
    // Not academic: the race target is derived from the head's timestamp, and a partial
    // header that kept its number would compute a target from `undefined`.
    primeBlockCache({ ...GOOD, timestamp: undefined } as unknown as Block);
    const cached = await getLatestBlockCached();
    expect(cached.number).toBe(100n);
    expect(cached.timestamp).toBe(1_000n);
  });

  it("says so, rather than dropping frames silently", () => {
    primeBlockCache(undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no number/timestamp"),
    );
  });

  it("still accepts a healthy frame — the cache must not become write-only", async () => {
    primeBlockCache(header(101n, 1_012n));
    expect((await getLatestBlockCached()).number).toBe(101n);
  });

  it("recovers on the next good frame after a bad one", async () => {
    primeBlockCache(undefined);
    primeBlockCache(header(102n, 1_024n));
    expect((await getLatestBlockCached()).number).toBe(102n);
  });
});
