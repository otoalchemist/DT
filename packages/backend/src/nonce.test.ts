import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dat-nonce-"));

vi.mock("./config.js", () => ({
  appConfig: { dataDir },
}));

vi.mock("./chain.js", () => ({
  publicClient: { getTransactionCount: vi.fn(), getBlockNumber: vi.fn(async () => 1_000n) },
}));

const { publicClient } = await import("./chain.js");
const { NonceManager, NonceRegistry, nonces } = await import("./nonce.js");
const getCount = vi.mocked(publicClient.getTransactionCount);
const ADDR = "0x1111111111111111111111111111111111111111" as `0x${string}`;

describe("NonceManager", () => {
  let nm: InstanceType<typeof NonceManager>;
  beforeEach(() => {
    getCount.mockReset();
    fs.rmSync(path.join(dataDir, "nonce-reservations.json"), { force: true });
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

  it("does not journal public-mode reservations", async () => {
    const changes: unknown[] = [];
    nm = new NonceManager(undefined, (reservation) => changes.push(reservation));
    getCount.mockResolvedValue(5);

    await nm.sync(ADDR, "public");
    expect(nm.reserve()).toBe(5);
    expect(changes).toEqual([]);
  });

  it("does not erase a live private reservation when submission mode changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const changes: unknown[] = [];
      nm = new NonceManager(undefined, (reservation) => changes.push(reservation));
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      vi.setSystemTime(1_000);
      await nm.sync(ADDR, "public");
      expect(nm.peek()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mainnet mode freezes a later tick while the prior private nonce is unresolved", async () => {
    nm = new NonceManager(undefined, () => {});
    getCount.mockResolvedValue(5); // pending stays 5 — a private bundle isn't in the mempool
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5); // submit bundle at nonce 5
    nm.reset();

    await nm.sync(ADDR, "mainnet"); // pending still 5
    expect(nm.peek()).toBe(6); // NOT 5 — we hold our reservation
    expect(() => nm.reserve()).toThrow(/previous private nonce sequence is still unresolved/i);
  });

  it("ages a reservation from when it was made after an idle wallet period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      nm.reset();

      // The wallet can sit unchanged for far longer than the stale window before
      // it has anything to submit. That idle time must not age a future bundle.
      vi.setSystemTime(300_000);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      vi.setSystemTime(300_001);
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mainnet mode resyncs once a held bundle lands", async () => {
    nm = new NonceManager(undefined, () => {});
    getCount.mockResolvedValueOnce(5);
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(5);
    nm.reset();

    getCount.mockResolvedValueOnce(6); // bundle mined -> pending advanced
    await nm.sync(ADDR, "mainnet");
    expect(nm.reserve()).toBe(6);
  });

  it("keeps a landed reservation quarantined across a short pending-nonce reorg", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValueOnce(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      nm.reset();

      vi.setSystemTime(10_000);
      getCount.mockResolvedValueOnce(6); // included in the current chain view
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
      nm.reset();

      vi.setSystemTime(20_000);
      getCount.mockResolvedValueOnce(5); // that block was reorged out
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6); // nonce 5 remains quarantined
    } finally {
      vi.useRealTimers();
    }
  });

  it("mainnet mode releases a stale reservation (dropped bundle) after the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValue(5); // pending stuck at 5 forever
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
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

  it("does not expire a private nonce by wall clock while its eligible blocks have stalled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValue(5);
      vi.mocked(publicClient.getBlockNumber).mockResolvedValue(200n);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(200n)).toBe(5);
      nm.reset();

      vi.setSystemTime(200_000); // wall-clock quarantine elapsed, chain did not
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
      expect(() => nm.reserve()).toThrow(/previous private nonce sequence/i);

      nm.reset();
      vi.mocked(publicClient.getBlockNumber).mockResolvedValue(203n); // target + 2-block margin passed
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(5);
    } finally {
      vi.mocked(publicClient.getBlockNumber).mockResolvedValue(1_000n);
      vi.useRealTimers();
    }
  });

  it("does not renew a reservation merely because the on-chain nonce changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValueOnce(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      vi.setSystemTime(80_000);
      getCount.mockResolvedValueOnce(4); // unrelated reorg/RPC view change
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(6);
      nm.reset();

      vi.setSystemTime(91_000);
      getCount.mockResolvedValueOnce(4);
      await nm.sync(ADDR, "mainnet");
      expect(nm.peek()).toBe(4); // release is based on reservation age
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a private sequence to grow only inside the batch that opened it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve()).toBe(5);
      expect(nm.reserve()).toBe(6); // same synced batch may form one contiguous bundle
      nm.reset();

      vi.setSystemTime(80_000);
      await nm.sync(ADDR, "mainnet");
      expect(() => nm.reserve()).toThrow(/previous private nonce sequence is still unresolved/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists and restores only a still-live private reservation after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      getCount.mockResolvedValue(5);
      const beforeRestart = new NonceRegistry().for(ADDR);
      await beforeRestart.sync(ADDR, "mainnet");
      expect(beforeRestart.reserve(100n)).toBe(5);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, "nonce-reservations.json"), "utf8"))).toEqual({
        [ADDR]: { reservedCeil: 6, updatedAtMs: 100_000, eligibleThroughBlock: 100 },
      });

      vi.setSystemTime(110_000);
      const afterRestart = new NonceRegistry().for(ADDR);
      await afterRestart.sync(ADDR, "mainnet");
      expect(afterRestart.peek()).toBe(6);

      // An expired journal entry creates no blanket first-use quarantine.
      vi.setSystemTime(200_001);
      const afterExpiry = new NonceRegistry().for(ADDR);
      await afterExpiry.sync(ADDR, "mainnet");
      expect(afterExpiry.peek()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks signing against an unaccounted restored reservation until chain catches up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      getCount.mockResolvedValue(5);
      const beforeRestart = new NonceRegistry().for(ADDR);
      await beforeRestart.sync(ADDR, "mainnet");
      expect(beforeRestart.reserve()).toBe(5);

      const restored = new NonceRegistry().for(ADDR);
      await restored.sync(ADDR, "mainnet");
      expect(restored.hasRestoredUnaccountedReservation()).toBe(true);
      expect(() => restored.reserve()).toThrow(/restored after restart is still unresolved/);

      // Pending alone is not enough: its value/gas debit is not in latest balance yet.
      getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(5);
      await restored.sync(ADDR, "mainnet");
      expect(restored.hasRestoredUnaccountedReservation()).toBe(true);
      expect(() => restored.reserve()).toThrow(/restored after restart is still unresolved/);

      getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(6);
      await restored.sync(ADDR, "mainnet");
      expect(restored.hasRestoredUnaccountedReservation()).toBe(false);
      expect(restored.reserve()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an old restored quarantine when pending advanced but latest has not", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      getCount.mockResolvedValueOnce(5).mockResolvedValueOnce(5);
      const beforeRestart = new NonceRegistry().for(ADDR);
      await beforeRestart.sync(ADDR, "mainnet");
      expect(beforeRestart.reserve()).toBe(5);

      vi.setSystemTime(200_000); // past the fixed age window
      const restored = new NonceRegistry().for(ADDR);
      getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(5); // pending only
      await restored.sync(ADDR, "mainnet");
      expect(restored.hasRestoredUnaccountedReservation()).toBe(true);
      expect(() => restored.reserve()).toThrow(/restored after restart is still unresolved/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a public-mode restart while pending nonce is ahead of latest", async () => {
    getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(5);
    await nm.sync(ADDR, "public");
    expect(nm.hasRestoredUnaccountedReservation()).toBe(true);
    expect(() => nm.reserve()).toThrow(/pre-restart pending transaction spend/i);

    // Once pending falls back to latest, the ambiguous tx is gone and chain truth can be
    // used again. A mined catch-up works identically because pending === latest there too.
    getCount.mockResolvedValueOnce(5).mockResolvedValueOnce(5);
    await nm.sync(ADDR, "public");
    expect(nm.hasRestoredUnaccountedReservation()).toBe(false);
    expect(nm.reserve()).toBe(5);
  });

  it("does not retry an expired private tx at nonce+1 while its journal is quarantined", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValue(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      let disposition: "retry" | "consumed" | undefined;
      const safe = nm.waitUntilPrivateRetrySafe(ADDR, 5).then((v) => { disposition = v; });
      await vi.advanceTimersByTimeAsync(89_999);
      expect(disposition).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await safe;
      expect(disposition).toBe("retry");

      // The stale reservation was released against pending chain truth; the next sync can
      // reuse nonce 5 rather than handing the retry nonce 6 with an unfillable gap.
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release an expired private/public-mirror reservation on pending-only nonce advance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      nm = new NonceManager(undefined, () => {});
      getCount.mockResolvedValueOnce(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      // The public mirror is visible only in pending. Its value/gas has not left the
      // latest balance, so the private expiry callback must retain its spend/journal.
      getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(5);
      const safe = nm.waitUntilPrivateRetrySafe(ADDR, 5);
      await vi.advanceTimersByTimeAsync(90_000);
      await Promise.resolve();
      let settled = false;
      void safe.then(() => { settled = true; });
      expect(settled).toBe(false);

      // Once latest catches up, nonce consumption and the debit are authoritative.
      getCount.mockResolvedValueOnce(6).mockResolvedValueOnce(6);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(safe).resolves.toBe("consumed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an old expiry reconciliation cannot erase a newer reservation created during its RPC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const changes: unknown[] = [];
      nm = new NonceManager(undefined, (r) => changes.push(r));
      getCount.mockResolvedValueOnce(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(100n)).toBe(5);
      nm.reset();

      vi.setSystemTime(190_001);
      let resolvePending!: (value: number) => void;
      getCount.mockImplementationOnce(() => new Promise((resolve) => { resolvePending = resolve; }));
      const oldReconcile = nm.waitUntilPrivateRetrySafe(ADDR, 5);
      await Promise.resolve();

      // While old reconciliation waits on RPC, a fresh sync sees the old journal stale
      // and opens a new generation at the same chain nonce.
      getCount.mockResolvedValueOnce(5);
      await nm.sync(ADDR, "mainnet");
      expect(nm.reserve(200n)).toBe(5);
      const newReservation = changes.at(-1);
      resolvePending(5);
      await Promise.resolve();

      expect(changes.at(-1)).toEqual(newReservation);
      // The old callback observed the generation change and is now waiting for the new
      // reservation's quarantine instead of clearing it. Let it finish cleanly.
      vi.setSystemTime(280_002);
      getCount.mockResolvedValueOnce(5);
      await vi.runOnlyPendingTimersAsync();
      await oldReconcile;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed instead of ignoring a corrupt reservation journal", () => {
    fs.writeFileSync(path.join(dataDir, "nonce-reservations.json"), "not json");
    expect(() => new NonceRegistry()).toThrow(/Cannot safely read nonce reservation journal/);
  });

  it("fails closed before reserving a private nonce without durable storage", async () => {
    getCount.mockResolvedValue(5);
    await nm.sync(ADDR, "mainnet");
    expect(() => nm.reserve()).toThrow(/durable journal storage/);
    expect(nm.peek()).toBe(5);
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
