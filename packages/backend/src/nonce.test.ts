import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./chain.js", () => ({
  publicClient: { getTransactionCount: vi.fn() },
}));

const { publicClient } = await import("./chain.js");
const { NonceManager } = await import("./nonce.js");
const getCount = vi.mocked(publicClient.getTransactionCount);
const ADDR = "0x1111111111111111111111111111111111111111" as `0x${string}`;

describe("NonceManager", () => {
  let nm: InstanceType<typeof NonceManager>;
  beforeEach(() => {
    getCount.mockReset();
    nm = new NonceManager();
  });

  it("public mode trusts the mempool each tick (self-heals if a tx drops)", async () => {
    getCount.mockResolvedValueOnce(5);
    await nm.sync(ADDR, "public");
    expect(nm.reserve()).toBe(5);
    nm.reset();

    getCount.mockResolvedValueOnce(6); // our tx entered the mempool
    await nm.sync(ADDR, "public");
    expect(nm.peek()).toBe(6);
    nm.reset();

    getCount.mockResolvedValueOnce(6); // dropped back below is trusted too (self-heal)
    await nm.sync(ADDR, "public");
    expect(nm.reserve()).toBe(6);
  });

  it("mainnet mode holds the reserved ceiling so a bundle's nonce isn't reused", async () => {
    getCount.mockResolvedValue(5); // pending stays 5 — a private bundle isn't in the mempool
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5); // submit bundle at nonce 5
    nm.reset();

    await nm.sync(ADDR, "mainnet"); // pending still 5
    expect(nm.peek()).toBe(6); // NOT 5 — we hold our reservation
    expect(nm.reserve()).toBe(6);
    nm.reset();

    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(7); // keeps advancing, no reuse
  });

  it("mainnet mode resyncs once a held bundle lands", async () => {
    getCount.mockResolvedValueOnce(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5);
    nm.reset();

    getCount.mockResolvedValueOnce(6); // bundle mined -> pending advanced
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(6);
  });

  it("mainnet mode releases a stale reservation (dropped bundle) after the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      getCount.mockResolvedValue(5); // pending stuck at 5 forever
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(30_000); // within the stale window -> still holding
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
      nm.reset();

      vi.setSystemTime(200_000); // past it -> bundle assumed dropped, nonce released
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
