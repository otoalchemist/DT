import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Routine ticks must stay out of an armed boundary race.
 *
 * The bug this exists for, in full: on the epoch-174 boundary an ally's four payments were
 * due to fire at :30 against a :35 boundary. A routine block tick that had STARTED at :23
 * was still holding the engine lock, so the fire's 150ms retry loop only got through at
 * :33 — two seconds before the boundary, but one block too late. The payments landed at
 * index 0-3 of the block AFTER the boundary block, by which time a rival's audits had
 * landed in the boundary block itself, and all four reverted with IncorrectPayment.
 *
 * The single property that makes the fix work is the WINDOW SIZING, so that is what these
 * assert hardest. The tick that costs the race does not start inside the lead — it starts
 * before it and runs in. A window that opened at "boundary - lead" would not have touched
 * the :23 tick and would have fixed nothing, while looking entirely correct.
 */

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n })),
    getBalance: vi.fn(async () => 10n ** 19n),
    getBlockNumber: vi.fn(async () => 100n),
    multicall: vi.fn(async () => []),
  },
  wsClient: null,
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n })),
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
  nonces: { syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn() },
}));
vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => []),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
  invalidateTokenCaches: vi.fn(),
}));
vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(), beginBundle: vi.fn(), flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false), setRaceBoundary: vi.fn(), setRaceLookBack: vi.fn(),
}));
vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({ state: 1, currentEpoch: 174n, startTime: 0n, citizensAddress: "0x00000000000000000000000000000000000000cc", citizenSupply: 78n })),
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

const { routineTickMustYield } = await import("./strategy.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");

// Epoch N begins at startTime + (N-1)*EPOCH. With startTime 0 and epoch 175 armed, the
// boundary is a round number, which keeps every offset below readable.
const EPOCH = 86_400n;
const ARMED_EPOCH = 175;
const BOUNDARY = BigInt(ARMED_EPOCH - 1) * EPOCH;
const LEAD_SEC = 5n; // preBoundaryLeadMainnetMs default, in mainnet mode

/** Seconds relative to the boundary: at(-12) is the block before the fire is due. */
const at = (offset: number | bigint) => BOUNDARY + BigInt(offset);

function arm(over: Record<string, unknown> = {}) {
  runtime.startTime = 0n;
  runtime.currentEpoch = BigInt(ARMED_EPOCH - 1);
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    preBoundaryPay: true, jitEnabled: true, jitTargetEpoch: ARMED_EPOCH,
    preBoundaryAudit: true, offenseEnabled: true, autoAudit: true,
    preBoundaryLeadMainnetMs: Number(LEAD_SEC) * 1000,
    ...over,
  } as typeof runtime.strategy;
}

describe("routine ticks yield inside an armed boundary window", () => {
  beforeEach(() => arm());

  it("yields for the tick that actually cost the epoch-174 race", () => {
    // The fire is due at boundary-5. The killer tick began at boundary-12, i.e. BEFORE the
    // lead even opened. This is the case a naive "suppress inside the lead" window misses.
    expect(routineTickMustYield(at(-12))).toBe(BOUNDARY);
  });

  it("opens a full slot before the fire is due, not at the fire", () => {
    // Anything from one slot ahead of the due time onward must yield, so at most one tick
    // is in flight when the window opens and it has a whole block to drain.
    const opensAt = -Number(LEAD_SEC) - 12;
    expect(routineTickMustYield(at(opensAt))).toBe(BOUNDARY);
    expect(routineTickMustYield(at(opensAt + 1))).toBe(BOUNDARY);
    // One second before it opens is still ordinary time.
    expect(routineTickMustYield(at(opensAt - 1))).toBeNull();
  });

  it("stays quiet across the whole lead and just past the boundary", () => {
    for (const o of [-16, -10, -5, -3, -1, 0, 1, 2]) {
      expect(routineTickMustYield(at(o))).toBe(BOUNDARY);
    }
  });

  it("reopens after the boundary so the JIT fallback and normal work resume", () => {
    expect(routineTickMustYield(at(3))).toBeNull();
    expect(routineTickMustYield(at(60))).toBeNull();
  });

  it("does not suppress anything mid-epoch", () => {
    expect(routineTickMustYield(at(-3600))).toBeNull();
    expect(routineTickMustYield(BOUNDARY - EPOCH / 2n)).toBeNull();
  });

  // --- it must only go quiet when there is actually a race to protect ---

  it("stays out of the way only when a fire is armed", () => {
    arm({ preBoundaryPay: false, jitEnabled: false, jitTargetEpoch: null,
          preBoundaryAudit: false, offenseEnabled: false, autoAudit: false });
    expect(routineTickMustYield(at(-6))).toBeNull();
  });

  it("an armed AUDIT alone is enough, with nothing owed", () => {
    // The audit-only boundary is the common case: most epochs owe nothing, and the offense
    // fire still has a race to win.
    arm({ preBoundaryPay: false, jitEnabled: false, jitTargetEpoch: null });
    expect(routineTickMustYield(at(-6))).toBe(BOUNDARY);
  });

  it("an armed PAYMENT alone is enough, with offense off", () => {
    arm({ preBoundaryAudit: false, offenseEnabled: false, autoAudit: false });
    expect(routineTickMustYield(at(-6))).toBe(BOUNDARY);
  });

  it("tracks the configured lead, so a longer lead opens the window earlier", () => {
    arm({ preBoundaryLeadMainnetMs: 20_000 });
    expect(routineTickMustYield(at(-31))).toBe(BOUNDARY); // 20s lead + 12s slot
    expect(routineTickMustYield(at(-33))).toBeNull();
  });

  it("returns null when the epoch grid is unknown, rather than suppressing forever", () => {
    // A bot that has not read startTime yet must keep ticking — that read is what a tick
    // does, so going quiet here would be self-sustaining.
    runtime.startTime = null;
    expect(routineTickMustYield(at(-6))).toBeNull();
  });
});

/**
 * Who the delay warning blames.
 *
 * The warning fired on a healthy boundary and said "a routine tick held the engine", which
 * sent an operator looking at tick duration. The holder was the PAYMENT fire, and the audit
 * fire waiting behind it is the architecture: the audit needs the paid-in-bundle credit the
 * payment produces, and the payment's lower nonce is what makes crediting it safe.
 */
describe("the delay warning names the real holder", () => {
  it("stays silent when the audit is waiting on its own payment fire", async () => {
    const { __setTickingOwnerForTest, __warnRaceLostToTickForTest, __resetRaceWarnForTest } =
      (await import("./strategy.js")) as unknown as {
        __setTickingOwnerForTest: (o: string | null) => void;
        __warnRaceLostToTickForTest: (kind: string, boundarySec: bigint) => void;
        __resetRaceWarnForTest: () => void;
      };
    const { activity } = await import("./activity.js");
    __resetRaceWarnForTest();
    vi.mocked(activity.add).mockClear();
    arm();
    __setTickingOwnerForTest("the payment fire");
    __warnRaceLostToTickForTest("audit", BOUNDARY);
    expect(activity.add).not.toHaveBeenCalled();
  });

  it("still reports when something unrelated holds the lock, and names it", async () => {
    const { __setTickingOwnerForTest, __warnRaceLostToTickForTest, __resetRaceWarnForTest } =
      (await import("./strategy.js")) as unknown as {
        __setTickingOwnerForTest: (o: string | null) => void;
        __warnRaceLostToTickForTest: (kind: string, boundarySec: bigint) => void;
        __resetRaceWarnForTest: () => void;
      };
    const { activity } = await import("./activity.js");
    __resetRaceWarnForTest();
    vi.mocked(activity.add).mockClear();
    arm();
    __setTickingOwnerForTest("a routine tick");
    __warnRaceLostToTickForTest("audit", BOUNDARY);
    expect(activity.add).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(activity.add).mock.calls[0]![0]!.message as string;
    expect(msg).toContain("a routine tick held the engine");
  });

  it("a payment race delayed by the payment fire is impossible, so it is never suppressed", async () => {
    // Only the AUDIT waits on the payment. Suppressing by owner alone would have hidden a
    // genuine payment delay if the same owner string ever appeared, so the kind is checked too.
    const { __setTickingOwnerForTest, __warnRaceLostToTickForTest, __resetRaceWarnForTest } =
      (await import("./strategy.js")) as unknown as {
        __setTickingOwnerForTest: (o: string | null) => void;
        __warnRaceLostToTickForTest: (kind: string, boundarySec: bigint) => void;
        __resetRaceWarnForTest: () => void;
      };
    const { activity } = await import("./activity.js");
    __resetRaceWarnForTest();
    vi.mocked(activity.add).mockClear();
    arm();
    __setTickingOwnerForTest("the payment fire");
    __warnRaceLostToTickForTest("payment", BOUNDARY);
    expect(activity.add).toHaveBeenCalledTimes(1);
  });
});
