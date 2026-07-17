import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

// EPOCH_DURATION_SECONDS from @dat-bot/shared is 24h; duplicated here as a
// plain literal since vi.mock factories are hoisted and can't close over
// outer bindings imported from elsewhere.
const EPOCH_SECONDS = 86_400n;
const START_TIME = 0n;
const LAST_EPOCH_PAID = 3n; // already 2+ epochs behind at test start -> "delinquent" from minute one

function currentEpochAt(nowSec: bigint): bigint {
  return 1n + (nowSec - START_TIME) / EPOCH_SECONDS;
}

function isAuditableStub(lastEpochPaid: bigint, currentEpoch: bigint): boolean {
  return lastEpochPaid + 2n <= currentEpoch;
}

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n })), // 10 gwei
    getBalance: vi.fn(async () => 10_000_000_000_000_000_000n), // 10 ETH
    getBlockNumber: vi.fn(async () => 100n),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n })), // 10 gwei
  wsClient: null, // force the 12s-poll fallback path, no block-watch subscription to simulate
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

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({})) },
}));

vi.mock("./nonce.js", () => ({
  nonceManager: { sync: vi.fn(async () => {}), reset: vi.fn() },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [1n]),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (intent: { value: bigint }) => ({
    ok: true,
    simulated: false,
    txHash: "0xhash",
    nonce: 0,
    valueWei: intent.value,
    gasWei: 0n,
  })),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map()),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, // LIVE
    currentEpoch: currentEpochAt(BigInt(Math.floor(Date.now() / 1000))),
    startTime: START_TIME,
    citizensAddress: "0x000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
  batchGetOwnedStatuses: vi.fn(async (tokenIds: bigint[], currentEpoch: bigint) =>
    tokenIds.map((tokenId) => ({
      tokenId: tokenId.toString(),
      lastEpochPaid: LAST_EPOCH_PAID.toString(),
      currentEpoch: currentEpoch.toString(),
      auditDueTimestamp: "0", // never under audit in this scenario
      secondsUntilKillable: null,
      bribeBalance: "0",
      hasLifeInsurance: false,
      risk: isAuditableStub(LAST_EPOCH_PAID, currentEpoch) ? "delinquent" : "safe",
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
const { fetchOwnedTokenIds } = await import("./index-tokens.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { startEngine, stopEngine } = await import("./strategy.js");

describe("proactive pay only fires at the epoch boundary, never on generic tick detection", () => {
  const FAKE_ACCOUNT = {
    address: "0x1111111111111111111111111111111111111111",
  } as unknown as PrivateKeyAccount;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Epoch 5 runs [345600, 432000). Start 300s before the epoch-6 boundary.
    // The citizen is already 2 epochs behind (delinquent) at this instant.
    vi.setSystemTime(new Date(431_700 * 1000));

    runtime.account = FAKE_ACCOUNT;
    runtime.running = false;
    runtime.balanceWei = null;
    runtime.currentEpoch = null;
    runtime.startTime = null;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      proactivePay: true,
      dryRun: false,
      offenseEnabled: false,
      jitEnabled: false,
      minBalanceEth: 0,
      maxPaymentEth: 0,
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
    };
  });

  afterEach(() => {
    stopEngine();
    vi.useRealTimers();
  });

  it("leaves an already-delinquent citizen unpaid on start and through regular ticks, then pays right at the next epoch boundary", async () => {
    startEngine();
    await vi.advanceTimersByTimeAsync(0); // flush the immediate tick() fired by startEngine

    expect(submitTx).not.toHaveBeenCalled();

    // Advance to just shy of the boundary. Several 12s poll ticks fire along the
    // way (all with fireProactivePay=false) — none of them should pay.
    await vi.advanceTimersByTimeAsync(298_000);
    expect(submitTx).not.toHaveBeenCalled();
    expect(vi.mocked(fetchOwnedTokenIds).mock.calls.length).toBeGreaterThan(1); // proves regular ticks actually ran

    // Cross the boundary — the precisely-scheduled defense-boundary tick fires
    // (~1.5s lead) and pays immediately.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.data).toBe("0xPAYTAXES");
  });
});
