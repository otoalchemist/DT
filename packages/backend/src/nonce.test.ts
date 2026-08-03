import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./chain.js", () => ({
  publicClient: { getTransactionCount: vi.fn() },
}));

const { publicClient } = await import("./chain.js");
const { NonceManager, nonces } = await import("./nonce.js");
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

// Nonces are strictly per-account. A shared counter across wallets hands wallet B a nonce
// derived from wallet A's chain state — the tx is rejected, or worse silently replaces one
// of A's pending bundle txs, and nothing surfaces until a payment quietly doesn't land.
describe("multi-wallet: nonce state is per address", () => {
  it("gives each address an independent manager, and the same address a stable one", () => {
    const a = "0xaaaa000000000000000000000000000000000001" as const;
    const b = "0xbbbb000000000000000000000000000000000002" as const;
    const ma = nonces.for(a);
    const mb = nonces.for(b);
    expect(ma).not.toBe(mb);
    expect(nonces.for(a)).toBe(ma);
    // Case-insensitive: a checksummed spelling must not spawn a second counter for the
    // same wallet, which would hand out duplicate nonces.
    expect(nonces.for(a.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(ma);
  });

  it("drops managers for wallets that are no longer unlocked", () => {
    const a = "0xaaaa000000000000000000000000000000000003" as const;
    const b = "0xbbbb000000000000000000000000000000000004" as const;
    const ma = nonces.for(a);
    nonces.for(b);
    nonces.retain([a]);
    expect(nonces.for(a)).toBe(ma); // kept
    // b was dropped, so it comes back fresh rather than carrying a stale reservation.
    expect(nonces.for(b)).not.toBe(ma);
  });
});
