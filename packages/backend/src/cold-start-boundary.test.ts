import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem";

/**
 * Restarting the engine near a boundary must not cost the race.
 *
 * The bug this exists for, in full: `startEngine` ended with an unconditional `void tick()`,
 * and that opening tick is a COLD one — snapshot, per-wallet balances, owned tokens,
 * emigration rosters, target statuses, all uncached — holding the engine lock throughout.
 * `routineTickMustYield` cannot stop it: that window opens at `boundary - lead - 12s`, sized
 * for a tick that begins at most one block early.
 *
 * Measured at the epoch-180 boundary (1787961575). An ally hit a tick crash, paused at
 * boundary-57s and restarted at boundary-38s — 21 seconds before the quiet window even opens.
 * The opening tick still held the lock when the payment fire came due, so the payments queued
 * at boundary-0.9s instead of boundary-5s. By flush the boundary block already existed,
 * raceTargetFrom correctly aimed at the block AFTER it, and both payments reverted against a
 * rival audit that had landed in the block they were meant to be in. Index 1 and 2 at 369
 * gwei: first in the wrong block.
 *
 * TWO properties, and the second is the load-bearing one. Deferring the tick is easy; a fix
 * that defers it and forgets to arm the timers would be silently worse than the bug, because
 * the race would not fire at all. So these assert that the fire STILL HAPPENS.
 */

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, timestamp: 1_787_961_563n })),
    getBalance: vi.fn(async () => 10n ** 19n),
    getBlockNumber: vi.fn(async () => 100n),
    multicall: vi.fn(async () => []),
  },
  wsClient: null,
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, timestamp: 1_787_961_563n })),
  getBalanceCached: vi.fn(async () => 10n ** 19n),
  primeBlockCache: vi.fn(),
  invalidateBalanceCache: vi.fn(),
  getChainId: vi.fn(async () => 1),
  reinitClients: vi.fn(),
}));
vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    httpUrl: "http://localhost",
    builderUrls: [],
    ownedTokensOverride: [],
    targetTokensOverride: [],
    maxCandidates: 100,
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./nonce.js", () => ({
  nonces: { syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn(), for: vi.fn(() => ({ reserve: () => 1, peek: () => 1 })) },
}));
vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => []),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
  invalidateTokenCaches: vi.fn(),
  invalidateLiveCandidates: vi.fn(),
}));
vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(), beginBundle: vi.fn(), flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false), setRaceBoundary: vi.fn(), setRaceLookBack: vi.fn(),
}));
vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: 179n, startTime: 1_772_495_975n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", citizenSupply: 78n,
  })),
  gameContract: { address: "0x00000000000000000000000000000000000000aa", abi: [] },
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async () => []),
  estimateTaxes: vi.fn(async () => 0n),
  encodePayTaxes: vi.fn(() => "0x"),
  encodeAudit: vi.fn(() => "0x"),
  encodeKill: vi.fn(() => "0x"),
  encodeUseBribe: vi.fn(() => "0x"),
  resolveCitizensAddress: vi.fn(async () => "0x00000000000000000000000000000000000000cc"),
  EPOCH_SECONDS: 86_400n,
}));

const { startEngine, stopEngine, routineTickMustYield, coldStartMustDeferTick } = await import("./strategy.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { getGameSnapshot } = await import("./contract.js");
const { setRaceBoundary } = await import("./flashbots.js");

// The real epoch-180 numbers, so the offsets below are the ones that actually happened.
const START = 1_772_495_975n;
const ARMED_EPOCH = 180;
const BOUNDARY_SEC = 1_787_961_575; // START + 179 * 86400
const RESTART_OFFSET = -38; // where the ally restarted, 21s before the quiet window opens

/** Park the fake clock `offset` seconds from the epoch-180 boundary. */
const clockAt = (offset: number) => vi.setSystemTime(new Date((BOUNDARY_SEC + offset) * 1000));

/** Did the OPENING refresh run? refreshSnapshot is the only caller of getGameSnapshot here. */
const openingTickRan = () => (getGameSnapshot as ReturnType<typeof vi.fn>).mock.calls.length > 0;

/** Did the payment fire actually go? setRaceBoundary is unique to the pre-boundary fires. */
const fireRan = () => (setRaceBoundary as ReturnType<typeof vi.fn>).mock.calls.length > 0;

function arm(over: Record<string, unknown> = {}) {
  runtime.startTime = START;
  runtime.currentEpoch = BigInt(ARMED_EPOCH - 1);
  runtime.gameState = 1;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    preBoundaryPay: true, jitEnabled: true, jitTargetEpoch: ARMED_EPOCH,
    preBoundaryAudit: true, offenseEnabled: true, autoAudit: true,
    preBoundaryLeadMainnetMs: 5000,
    ...over,
  } as typeof runtime.strategy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  runtime.setWallets([{
    account: {
      address: "0x00000000000000000000000000000000000000b1",
      signTransaction: vi.fn(async () => "0xsigned" as `0x${string}`),
      signMessage: vi.fn(async () => "0xsig"),
    } as unknown as PrivateKeyAccount,
    label: "t",
    balanceWei: 100_000_000_000_000_000_000n,
  }]);
  arm();
});

afterEach(() => {
  stopEngine();
  runtime.setWallets([]);
  runtime.running = false;
  vi.useRealTimers();
});

describe("a cold start must not hold the engine through an armed boundary", () => {
  it("holds back the opening refresh at the exact offset that lost epoch 180", async () => {
    clockAt(RESTART_OFFSET);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(false);
  });

  it("but STILL arms the payment fire it declined to tick for", async () => {
    clockAt(RESTART_OFFSET);
    startEngine();
    // Run out the 33s to the fire (boundary - 5s lead). Nothing else may have taken the lock.
    await vi.advanceTimersByTimeAsync(34_000);
    expect(fireRan()).toBe(true);
  });

  it("arms it from the deferred branch ALONE, with no tick available to do it", async () => {
    /**
     * The test above is not sufficient on its own, and a mutation proved it: deleting the
     * schedulers from the deferred branch still passed, because a restart at -38s is outside
     * the ROUTINE window, so the 12s poll at -26s ran a tick and re-armed everything behind
     * the fix. Comfortable, and completely untested.
     *
     * Starting at -16s removes that crutch. It is inside routineTickMustYield's window
     * (which opens at -17s), so every poll tick yields and the deferred branch's own
     * schedulers are the only thing that can arm the fire. If they go, the race never fires —
     * which is strictly worse than the bug this all started from.
     */
    clockAt(-16);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan(), "no tick may run here").toBe(false);
    await vi.advanceTimersByTimeAsync(12_000); // past the fire at -5s
    expect(openingTickRan(), "and none may run before the fire either").toBe(false);
    expect(fireRan(), "so only the deferred branch can have armed this").toBe(true);
  });

  it("stays quiet across the whole approach, not just at one offset", async () => {
    for (const offset of [-38, -30, -20, -17, -6]) {
      vi.clearAllMocks();
      clockAt(offset);
      startEngine();
      await vi.advanceTimersByTimeAsync(0);
      expect(openingTickRan(), `restart at boundary${offset}s`).toBe(false);
      stopEngine();
    }
  });

  it("ticks normally when the boundary is not close", async () => {
    clockAt(-3600);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(true);
  });

  it("has a budget WIDER than the routine window, which could not have caught this", async () => {
    // The point of the whole fix. routineTickMustYield opens at boundary - lead(5) - 12 = -17,
    // so at the -38s restart it returns null and would have permitted the tick that lost the
    // race. If these two ever agree again, the guard has silently reverted to useless.
    clockAt(RESTART_OFFSET);
    expect(routineTickMustYield(BigInt(BOUNDARY_SEC + RESTART_OFFSET))).toBeNull();
    expect(coldStartMustDeferTick(BigInt(BOUNDARY_SEC + RESTART_OFFSET))).not.toBeNull();
  });

  it("opens exactly at lead + 90s, and not a second earlier", async () => {
    // Budget opens at boundary - lead(5) - 90 = -95. The edge is asserted from both sides so
    // a budget quietly widened to "always" cannot pass.
    expect(coldStartMustDeferTick(BigInt(BOUNDARY_SEC - 95))).not.toBeNull();
    expect(coldStartMustDeferTick(BigInt(BOUNDARY_SEC - 96))).toBeNull();
    clockAt(-96);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(true);
  });

  it("ticks when nothing is armed — an unarmed boundary has no race to protect", async () => {
    arm({ preBoundaryPay: false, jitEnabled: false, jitTargetEpoch: null,
          preBoundaryAudit: false, offenseEnabled: false, autoAudit: false });
    clockAt(RESTART_OFFSET);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(true);
  });

  it("ticks when startTime is unknown, rather than deferring forever", async () => {
    // A genuinely cold process has never read the chain, and the tick is what reads it.
    // Going quiet here would be self-sustaining: no tick, no startTime, no tick.
    runtime.startTime = null;
    clockAt(RESTART_OFFSET);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(true);
  });

  it("resumes routine ticking once the boundary has passed", async () => {
    clockAt(RESTART_OFFSET);
    startEngine();
    await vi.advanceTimersByTimeAsync(0);
    expect(openingTickRan()).toBe(false);
    // Past the boundary + the 2s tail, the 12s poll must find the engine free again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openingTickRan()).toBe(true);
  });
});
