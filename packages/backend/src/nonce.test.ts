import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("./chain.js", () => ({
  publicClient: {
    getTransactionCount: vi.fn(),
    getBlockNumber: vi.fn(),
  },
}));

const { publicClient } = await import("./chain.js");
const { NonceManager } = await import("./nonce.js");
const getCount = vi.mocked(publicClient.getTransactionCount);
const getBlockNumber = vi.mocked(publicClient.getBlockNumber);
const ADDR = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"ab".repeat(32)}` as const;

describe("NonceManager flight model", () => {
  let manager: InstanceType<typeof NonceManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    getCount.mockResolvedValue(5);
    getBlockNumber.mockResolvedValue(100n);
    manager = new NonceManager();
  });

  it("fences an ambiguous delivery immediately inside reserve", async () => {
    await manager.sync(ADDR, "public");
    const nonce = manager.reserve();
    manager.markDelivery(nonce, "ambiguous", { txHash: HASH, publicExposure: true });

    expect(manager.hasInvisibleReservation()).toBe(true);
    expect(() => manager.reserve()).toThrow(/unresolved nonce flight/);
  });

  it("never age-expires a public flight", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 2_000_000_000 }),
      fc.boolean(),
      async (elapsedMs, visibleInPending) => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(0);
          const nm = new NonceManager();
          getCount.mockResolvedValue(5);
          await nm.sync(ADDR, "public");
          const nonce = nm.reserve();
          nm.markDelivery(nonce, "accepted", { txHash: HASH, publicExposure: true });
          nm.reset();

          vi.setSystemTime(elapsedMs);
          getCount.mockImplementation(async ({ blockTag }: { blockTag?: string }) =>
            blockTag === "pending" && visibleInPending ? 6 : 5,
          );
          await nm.sync(ADDR, "public");
          expect(nm.peek()).toBeGreaterThan(nonce);
          expect(nm.flightSnapshots()).toEqual([
            expect.objectContaining({ nonce, publicExposure: true }),
          ]);
        } finally {
          vi.useRealTimers();
        }
      },
    ), { numRuns: 40 });
  });

  it("expires private-only delivery strictly after its final target block", async () => {
    getCount.mockResolvedValue(5);
    getBlockNumber.mockResolvedValue(101n);
    await manager.sync(ADDR, "mainnet");
    const nonce = manager.reserve();
    manager.markDelivery(nonce, "accepted", {
      txHash: HASH,
      publicExposure: false,
      maxPrivateTargetBlock: 101n,
    });

    manager.reset();
    await manager.sync(ADDR, "mainnet");
    expect(manager.peek()).toBe(6);
    expect(manager.hasInvisibleReservation()).toBe(true);

    manager.reset();
    getBlockNumber.mockResolvedValue(102n);
    await manager.sync(ADDR, "mainnet");
    expect(manager.peek()).toBe(5);
    expect(manager.hasInvisibleReservation()).toBe(false);
  });

  it("expires an ambiguous private-only flight after its fixed target", async () => {
    await manager.sync(ADDR, "mainnet");
    const nonce = manager.reserve();
    manager.markDelivery(nonce, "ambiguous", {
      txHash: HASH,
      maxPrivateTargetBlock: 101n,
    });
    manager.reset();
    getBlockNumber.mockResolvedValue(1_000n);

    await manager.sync(ADDR, "mainnet");
    expect(manager.peek()).toBe(5);
    expect(manager.reserve()).toBe(5);
  });

  it("retains an expired private lower nonce while a higher recovered flight is live", async () => {
    getBlockNumber.mockResolvedValue(102n);
    manager.setRecoveryHook(async () => [{
      nonce: 5,
      txHash: HASH,
      state: "accepted",
      publicExposure: false,
      maxPrivateTargetBlock: 101n,
    }, {
      nonce: 6,
      txHash: `0x${"cd".repeat(32)}`,
      state: "accepted",
      publicExposure: true,
    }]);

    await manager.sync(ADDR, "mainnet");

    expect(manager.flightSnapshots().map((flight) => flight.nonce)).toEqual([5, 6]);
    expect(manager.peek()).toBe(7);
    expect(manager.hasInvisibleReservation()).toBe(true);
    expect(() => manager.reserve()).toThrow(/unresolved/);
  });

  it("retains nonce-conflict ambiguity beyond a private target", async () => {
    await manager.sync(ADDR, "mainnet");
    const nonce = manager.reserve();
    manager.markDelivery(nonce, "ambiguous", {
      txHash: HASH,
      maxPrivateTargetBlock: 101n,
      retainBeyondPrivateTarget: true,
    });
    manager.reset();
    getBlockNumber.mockResolvedValue(1_000n);
    await manager.sync(ADDR, "mainnet");
    expect(manager.peek()).toBe(6);
    expect(() => manager.reserve()).toThrow(/unresolved/);
  });

  it("restores restart flights before allocating a fresh nonce", async () => {
    manager.setRecoveryHook(async (_address, confirmedNonce, pendingNonce, currentBlock) => {
      expect(confirmedNonce).toBe(5);
      expect(pendingNonce).toBe(5);
      expect(currentBlock).toBe(100n);
      return [{
        nonce: 5,
        txHash: HASH,
        state: "ambiguous",
        publicExposure: true,
      }];
    });

    await manager.sync(ADDR, "public");
    expect(manager.peek()).toBe(6);
    expect(manager.flightSnapshots()).toEqual([
      expect.objectContaining({ nonce: 5, txHash: HASH }),
    ]);
    expect(() => manager.reserve()).toThrow(/unresolved/);
  });

  it("retains a pending-visible public liability while using pending only as the cursor", async () => {
    getCount.mockImplementation(async ({ blockTag }: { blockTag?: string }) =>
      blockTag === "pending" ? 6 : 5,
    );
    manager.setRecoveryHook(async () => [{
      nonce: 5,
      txHash: HASH,
      state: "accepted",
      publicExposure: true,
    }]);

    await manager.sync(ADDR, "public");
    expect(manager.pendingNonce()).toBe(6);
    expect(manager.peek()).toBe(6);
    expect(manager.flightSnapshots()).toHaveLength(1);
    expect(manager.hasInvisibleReservation()).toBe(false);
    expect(manager.reserve()).toBe(6);
  });

  it("does not re-fence a pending-visible public flight restored after sync", async () => {
    getCount.mockImplementation(async ({ blockTag }: { blockTag?: string }) =>
      blockTag === "pending" ? 6 : 5,
    );
    await manager.sync(ADDR, "public");
    manager.restoreFlight({
      nonce: 5,
      txHash: HASH,
      state: "accepted",
      publicExposure: true,
    });

    expect(manager.hasInvisibleReservation()).toBe(false);
    expect(manager.reserve()).toBe(6);
  });

  it("removes a flight only when the confirmed nonce consumes it", async () => {
    manager.setRecoveryHook(async () => [{
      nonce: 5,
      txHash: HASH,
      state: "accepted",
      publicExposure: true,
    }]);
    getCount.mockResolvedValue(6);
    await manager.sync(ADDR, "public");

    expect(manager.flightSnapshots()).toEqual([]);
    expect(manager.peek()).toBe(6);
  });

  it("never allocates below confirmed when a load-balanced pending response is stale", async () => {
    getCount.mockImplementation(async ({ blockTag }: { blockTag?: string }) =>
      blockTag === "pending" ? 5 : 7,
    );
    await manager.sync(ADDR, "public");
    expect(manager.pendingNonce()).toBe(7);
    expect(manager.reserve()).toBe(7);
  });

  it("rolls back only a fresh contiguous top reservation range", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 30 }),
      async (length) => {
        const nm = new NonceManager();
        getCount.mockResolvedValue(5);
        await nm.sync(ADDR, "mainnet");
        const reserved = Array.from({ length }, () => nm.reserve());
        expect(nm.releaseContiguous(reserved)).toBe(true);
        expect(nm.peek()).toBe(5);
      },
    ));
  });

  it("never carries a flight into another wallet", async () => {
    await manager.sync(ADDR, "mainnet");
    manager.reserve();
    getCount.mockResolvedValue(3);
    await manager.sync(OTHER, "mainnet");
    expect(manager.peek()).toBe(3);
    expect(manager.flightSnapshots()).toEqual([]);
  });
});
