import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * A JIT arm names ONE epoch, and only a completed payment or a manual disarm clears it.
 * So an arm that never pays — deferred by canSpend (base fee over cap, balance short), or
 * simply held while the engine is stopped — outlives its own epoch. Every consumer then
 * computes a boundary in the PAST, and each read that as "the boundary is here, go".
 *
 * Reported from the field: users saw a payment fire nowhere near a boundary ("as if the
 * bot armed itself and triggered the payment"), and a dashboard showing target epoch 166
 * while the chain was on 168 — an arm 65 hours dead.
 *
 * These pin the three paths that acted on a dead epoch, plus the boundary that MUST still
 * fire, so the fix can't be over-applied into never racing at all.
 */

const EPOCH_SECONDS = 86_400n;
const START_TIME = 0n;

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n })),
    getBalance: vi.fn(async () => 10_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })),
  getBalanceCached: vi.fn(async () => 10_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null,
}));

vi.mock("./config.js", () => ({
  appConfig: {
    gameAddress: "0x000000000000000000000000000000000000aa",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    httpUrl: "http://localhost",
    port: 8787,
    host: "127.0.0.1",
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => {
  let n = 0;
  return { activity: { add: vi.fn(() => ({ id: `entry-${++n}` })), update: vi.fn() } };
});

vi.mock("./nonce.js", () => ({
  nonces: {
    for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 0), reserve: vi.fn(() => 0) })),
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
    retain: vi.fn(),
  },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [1n]),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (intent: { value: bigint }) => ({
    ok: true, simulated: false, txHash: "0xhash", nonce: 0, valueWei: intent.value, gasWei: 0n,
  })),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false),
  setRaceBoundary: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  // The tick's first act is refreshSnapshot -> getGameSnapshot. That call is therefore the
  // observable for "a tick ran", which is what the stale scheduler must NOT do.
  getGameSnapshot: vi.fn(async () => ({
    state: 1,
    currentEpoch: 168n,
    startTime: START_TIME,
    citizensAddress: "0x000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
  batchGetOwnedStatuses: vi.fn(async (tokenIds: bigint[], currentEpoch: bigint) =>
    tokenIds.map((tokenId) => ({
      tokenId: tokenId.toString(),
      lastEpochPaid: (currentEpoch - 1n).toString(),
      currentEpoch: currentEpoch.toString(),
      auditDueTimestamp: "0",
      secondsUntilKillable: null,
      bribeBalance: "0",
      hasLifeInsurance: false,
      risk: "delinquent",
      estimatedPayWei: "1000000000000000",
    })),
  ),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async () => []),
  estimateTaxes: vi.fn(async () => 1_000_000_000_000_000n),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeAudit: vi.fn(() => "0xAUDIT"),
  encodeKill: vi.fn(() => "0xKILL"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  gameContract: { address: "0x000000000000000000000000000000000000aa", abi: [] },
}));

const { submitTx } = await import("./flashbots.js");
const { getGameSnapshot, encodePayTaxes, batchGetOwnedStatuses } = await import("./contract.js");
const { publicClient } = await import("./chain.js");
const { activity } = await import("./activity.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const {
  expireStaleJitArm, scheduleJitBoundary, schedulePreBoundaryPay, firePreBoundaryBundle,
  maybeAutoArmPayment, stopEngine, resetJitState,
} = await import("./strategy.js");

const ADDR = "0x0000000000000000000000000000000000000001";
const PAYER = "0x00000000000000000000000000000000000000b1";

/** The live chain state from the field report: epoch 168, boundaries every 24h from t=0. */
const LIVE_EPOCH = 168n;
/** What the user's dashboard was still showing — an arm whose epoch ended 65h earlier. */
const STALE_TARGET = 166;

function armFor(target: number, overrides: Record<string, unknown> = {}): void {
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    jitEnabled: true,
    jitTargetEpoch: target,
    jitTokenIds: [],
    preBoundaryPay: true,
    minBalanceEth: 0,
    maxPaymentEth: 0,
    maxBaseFeeGwei: 1000,
    ...overrides,
  } as typeof runtime.strategy;
}

/** Freeze "now" 17h into epoch 168 — mid-epoch, so no real boundary is nearby. */
function freezeMidEpoch(): void {
  const epochStart = Number(START_TIME + (LIVE_EPOCH - 1n) * EPOCH_SECONDS);
  vi.setSystemTime((epochStart + 17 * 3600) * 1000);
}

/**
 * The boundary paths read lastEpochPaid + auditDueTimestamp through ONE multicall.
 * Default: behind by an epoch and not under audit, i.e. a citizen that genuinely owes.
 * `owedThrough` lets a test say "this one is already current".
 */
function mockOwed(owedThrough: bigint = LIVE_EPOCH - 1n): void {
  vi.mocked(publicClient.multicall).mockImplementation(
    (async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : owedThrough, // lastEpochPaid
      }))) as never,
  );
}

describe("a JIT arm whose epoch has already passed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    freezeMidEpoch();
    useWalletLike();
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.citizenSupply = 100n;
    runtime.currentEpoch = LIVE_EPOCH;
    runtime.startTime = START_TIME;
    mockOwed();
    resetJitState();
  });

  afterEach(() => {
    stopEngine();
    runtime.running = false;
    vi.useRealTimers();
  });

  function useWalletLike(): void {
    runtime.setWallets([
      { account: { address: ADDR } as unknown as PrivateKeyAccount, label: "test", balanceWei: 100_000_000_000_000_000_000n },
    ]);
  }

  describe("expireStaleJitArm", () => {
    it("disarms an arm whose epoch is over, and says so", () => {
      armFor(STALE_TARGET);
      expect(expireStaleJitArm(LIVE_EPOCH)).toBe(true);
      expect(runtime.strategy.jitEnabled).toBe(false);
      expect(runtime.strategy.jitTargetEpoch).toBeNull();
      // Loud on purpose: a payment the user armed for did not happen. Silence here is what
      // let a 65h-stale arm sit on the dashboard looking live.
      const msg = vi.mocked(activity.add).mock.calls.map((c) => (c[0] as { message: string }).message).join("\n");
      expect(msg).toMatch(/stale JIT arm/i);
      expect(msg).toContain(String(STALE_TARGET));
      expect(msg).toContain(String(LIVE_EPOCH));
      expect(msg).toMatch(/No payment was sent/i);
    });

    it("KEEPS an arm for the epoch we are currently in — that one is still live", () => {
      // jitPass pays the moment the chain reaches the target, and a fire delayed past its
      // own boundary legitimately lands here. `>= currentEpoch` is the keep condition.
      armFor(Number(LIVE_EPOCH));
      expect(expireStaleJitArm(LIVE_EPOCH)).toBe(false);
      expect(runtime.strategy.jitEnabled).toBe(true);
      expect(runtime.strategy.jitTargetEpoch).toBe(Number(LIVE_EPOCH));
    });

    it("KEEPS a normal forward arm for the next boundary", () => {
      armFor(Number(LIVE_EPOCH + 1n));
      expect(expireStaleJitArm(LIVE_EPOCH)).toBe(false);
      expect(runtime.strategy.jitEnabled).toBe(true);
    });

    it("is inert when nothing is armed", () => {
      runtime.strategy = { ...DEFAULT_STRATEGY } as typeof runtime.strategy;
      expect(expireStaleJitArm(LIVE_EPOCH)).toBe(false);
      expect(activity.add).not.toHaveBeenCalled();
    });
  });

  describe("scheduleJitBoundary — the path that fired the early payment", () => {
    it("does NOT fire a tick for a dead epoch", async () => {
      // THE BUG: boundary(166) is 65h in the past, so deltaSec <= 0, and that branch ran
      // `void tick()` immediately. The tick's jitPass then paid, mid-epoch, for a boundary
      // days gone — exactly the "armed itself and paid early" report.
      armFor(STALE_TARGET);
      scheduleJitBoundary();
      await vi.advanceTimersByTimeAsync(50);
      expect(getGameSnapshot).not.toHaveBeenCalled(); // no tick ran
      expect(submitTx).not.toHaveBeenCalled(); // and so nothing was paid
      expect(encodePayTaxes).not.toHaveBeenCalled();
    });

    it("STILL fires immediately when the armed epoch has just begun", async () => {
      // The guard must not cost us the legitimate case: armed for the epoch we are in,
      // boundary just behind us, JIT should pay at once. This is the whole point of JIT.
      armFor(Number(LIVE_EPOCH));
      scheduleJitBoundary();
      await vi.advanceTimersByTimeAsync(50);
      expect(getGameSnapshot).toHaveBeenCalled();
    });

    it("schedules rather than fires when the boundary is still ahead", async () => {
      armFor(Number(LIVE_EPOCH + 1n));
      scheduleJitBoundary();
      await vi.advanceTimersByTimeAsync(50);
      expect(getGameSnapshot).not.toHaveBeenCalled(); // waiting, not firing
    });
  });

  describe("schedulePreBoundaryPay", () => {
    it("stays silent for a dead epoch instead of warning about a race it never entered", () => {
      armFor(STALE_TARGET);
      schedulePreBoundaryPay();
      const msgs = vi.mocked(activity.add).mock.calls.map((c) => (c[0] as { message: string }).message);
      expect(msgs.filter((m) => /missed/i.test(m))).toHaveLength(0);
    });
  });

  describe("firePreBoundaryBundle", () => {
    it("does not pay for a dead epoch even though the arm names one", async () => {
      // firePreBoundaryBundle deliberately trusts the ARM over live state (commit 5c92ffc,
      // which fixed a real dropped payment). That trust is bounded to one epoch of drift:
      // a stale arm must not become an instruction to pay now, against a boundary
      // timestamp days old.
      armFor(STALE_TARGET, {
        combinedBoundaryBundle: true,
        coinbaseBidEth: 0.02,
        coinbasePayerAddress: PAYER,
        preBoundaryAudit: false,
        offenseEnabled: false,
        autoAudit: false,
      });
      await firePreBoundaryBundle();
      expect(encodePayTaxes).not.toHaveBeenCalled();
    });

    it("still pays when the arm is for the epoch just entered (the 5c92ffc case)", async () => {
      // The delay this tolerates: the fire is held by `ticking`, a post-boundary tick
      // advances currentEpoch to the armed epoch, and the payment must still go.
      armFor(Number(LIVE_EPOCH), {
        combinedBoundaryBundle: true,
        coinbaseBidEth: 0.02,
        coinbasePayerAddress: PAYER,
        preBoundaryAudit: false,
        offenseEnabled: false,
        autoAudit: false,
      });
      mockOwed(LIVE_EPOCH - 1n); // behind, so it genuinely owes
      await firePreBoundaryBundle();
      expect(encodePayTaxes).toHaveBeenCalled();
    });

    it("does not pay a citizen already current for the target epoch", async () => {
      // The per-token guard that makes a wrongful payment impossible even inside a live
      // arm: `lastEpochPaid >= targetEpoch` skips before any value is computed.
      armFor(Number(LIVE_EPOCH), {
        combinedBoundaryBundle: true,
        coinbaseBidEth: 0.02,
        coinbasePayerAddress: PAYER,
        preBoundaryAudit: false,
        offenseEnabled: false,
        autoAudit: false,
      });
      mockOwed(LIVE_EPOCH); // already paid through the target epoch
      await firePreBoundaryBundle();
      expect(encodePayTaxes).not.toHaveBeenCalled();
      expect(submitTx).not.toHaveBeenCalled();
    });
  });
});

/**
 * The auto-arm knew which citizens were behind, then armed `jitTokenIds: []` — and every
 * consumer reads empty as "every owned citizen". Both fire paths re-check lastEpochPaid and
 * skip a current citizen, so this was not paying them; but it reported them as armed, and
 * made the one-shot disarm wait on tokens that never owed anything.
 */
describe("auto-arm covers only the delinquent citizens", () => {
  const OWNED = [10n, 20n, 30n];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    freezeMidEpoch();
    runtime.setWallets([
      { account: { address: ADDR } as unknown as PrivateKeyAccount, label: "test", balanceWei: 100_000_000_000_000_000_000n },
    ]);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.currentEpoch = LIVE_EPOCH;
    runtime.startTime = START_TIME;
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true } as typeof runtime.strategy;
    resetJitState();
  });

  afterEach(() => {
    stopEngine();
    runtime.running = false;
    vi.useRealTimers();
  });

  /** #10 is two epochs behind, #20 one behind, #30 fully current. */
  function mixedRoster(): void {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], epoch: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: (id === 10n ? epoch - 2n : id === 20n ? epoch - 1n : epoch).toString(),
        currentEpoch: epoch.toString(),
        auditDueTimestamp: "0",
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "delinquent",
        estimatedPayWei: "1000000000000000",
      }))) as never);
  }

  it("arms the behind citizens by id and leaves the current one out", async () => {
    mixedRoster();
    await maybeAutoArmPayment(OWNED, LIVE_EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(true);
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(LIVE_EPOCH + 1n));
    // Explicitly NOT [] — empty means "every owned citizen" to both fire paths.
    expect(runtime.strategy.jitTokenIds).toEqual(["10", "20"]);
    expect(runtime.strategy.jitTokenIds).not.toContain("30");
  });

  it("does not arm at all when every citizen is current", async () => {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], epoch: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: epoch.toString(), // all current
        currentEpoch: epoch.toString(),
        auditDueTimestamp: "0",
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "safe",
        estimatedPayWei: "0",
      }))) as never);
    await maybeAutoArmPayment(OWNED, LIVE_EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
    expect(runtime.strategy.jitTargetEpoch).toBeNull();
  });

  it("a citizen one epoch behind IS armed — it is the one that turns auditable", async () => {
    // Auditability is lastEpochPaid + 2 <= currentEpoch. Paid through 167 at epoch 168
    // means 2 behind the instant the boundary into 169 lands, so it must be covered.
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], epoch: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: (epoch - 1n).toString(),
        currentEpoch: epoch.toString(),
        auditDueTimestamp: "0",
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "delinquent",
        estimatedPayWei: "1000000000000000",
      }))) as never);
    await maybeAutoArmPayment(OWNED, LIVE_EPOCH, 0n);
    expect(runtime.strategy.jitTokenIds).toEqual(["10", "20", "30"]);
  });

  it("never arms a citizen that is under audit", async () => {
    // Recovering an audited citizen stays a manual decision on every path.
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], epoch: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: (epoch - 2n).toString(), // behind...
        currentEpoch: epoch.toString(),
        auditDueTimestamp: id === 20n ? "0" : "99999", // ...but only #20 is not under audit
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "delinquent",
        estimatedPayWei: "1000000000000000",
      }))) as never);
    await maybeAutoArmPayment(OWNED, LIVE_EPOCH, 0n);
    expect(runtime.strategy.jitTokenIds).toEqual(["20"]);
  });
});
