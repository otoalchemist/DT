import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";
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
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => ({
      status: "success", blockNumber: 101n, transactionHash: hash, blockHash: "0xblock" })),
    getTransaction: vi.fn(async () => null),
    getTransactionCount: vi.fn(async () => 0),
    // lastEpochPaid + auditDueTimestamp per owned token. Default: well-paid
    // (lastEpochPaid huge) and not under audit.
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result: c.functionName === "auditDueTimestamp" ? 0n : 1_000_000n,
      })),
    ) },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })), // 10 gwei
  // Balance is read through the cache now; mirror publicClient.getBalance's 10 ETH.
  getBalanceCached: vi.fn(async () => 10_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null, // force the 12s-poll fallback path, no block-watch subscription to simulate
}));

vi.mock("./config.js", () => ({
  appConfig: {
    gameAddress: "0x000000000000000000000000000000000000aa",
    dataDir: `/tmp/dat-bot-strategy-tests-${process.pid}`,
    httpUrl: "http://localhost",
    port: 8787,
    host: "127.0.0.1",
    coinbasePayerCodeHashes: ["0x1111111111111111111111111111111111111111111111111111111111111111"] },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn() }));

vi.mock("./activity.js", () => {
  // add() must return an entry with a stable id: flushBatch keys its status updates
  // (submitted -> included/reverted) off entry.id.
  let n = 0;
  return {
    activity: {
      add: vi.fn(() => ({ id: `entry-${++n}` })),
      update: vi.fn() } };
});

vi.mock("./nonce.js", () => ({
  // Per-address registry. The real one hands each wallet its own counter; the tests
  // only need the calls to be inert.
  nonces: {
    for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 0), reserve: vi.fn(() => 0) })),
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
    retain: vi.fn(),
    hasRestoredUnaccountedReservation: vi.fn(() => false),
    waitUntilPrivateRetrySafe: vi.fn(async () => "retry" as const) } }));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [1n]),
  ownershipIndexingAvailable: vi.fn(() => true) }));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (intent: { value: bigint }) => ({
    ok: true,
    simulated: false,
    txHash: "0xhash",
    nonce: 0,
    valueWei: intent.value,
    gasWei: 0n })),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false) }));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, // LIVE
    currentEpoch: currentEpochAt(BigInt(Math.floor(Date.now() / 1000))),
    startTime: START_TIME,
    citizensAddress: "0x000000000000000000000000000000000000cc",
    citizenSupply: 100n })),
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
      estimatedPayWei: "1000000000000000" })),
  ),
  estimateTaxes: vi.fn(async () => 1_000_000_000_000_000n),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  gameContract: { address: "0x000000000000000000000000000000000000aa", abi: [] } }));

const { submitTx, queueCoinbaseBid, flushBundle } = await import("./flashbots.js");
const { fetchOwnedTokenIds } = await import("./index-tokens.js");
const { batchGetOwnedStatuses, estimateTaxes } = await import("./contract.js");
const { publicClient, getBalanceCached } = await import("./chain.js");
const { appConfig } = await import("./config.js");
const { activity } = await import("./activity.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const defaultStrategyDataDir = `/tmp/dat-bot-strategy-tests-${process.pid}`;

/** Install a single unlocked wallet — the shape these tests were written against.
 *  Multi-wallet routing has its own describe below. */
function useWallet(account: unknown, balanceWei: bigint | null = null): void {
  runtime.setWallets([{ account: account as never, label: "test", balanceWei }]);
}
/** Set the balance on every installed test wallet. */
function setTestBalance(wei: bigint | null): void {
  for (const w of runtime.wallets) w.balanceWei = wei;
}
const { startEngine, stopEngine, beginEngineMaintenance, isEngineMaintenanceActive, firePreBoundaryPay, maybeAutoArmPayment, maybeAutoDefendAudit, resetDefenseState, resetTickBudget, jitPass, fetchOwnedAcrossWallets, manualPayToCurrent, resetJitState, scheduleAwayWake, clearAwayTimers } =
  await import("./strategy.js");

// Isolate exact-cost reservations and receipt callbacks that intentionally persist across
// production ticks. Each test begins from a freshly-read balance/state snapshot.
beforeEach(() => {
  fs.mkdirSync(defaultStrategyDataDir, { recursive: true });
  resetTickBudget();
  vi.mocked(publicClient.getBalance).mockResolvedValue(10_000_000_000_000_000_000n);
  // `clearAllMocks` does not clear a queued mockResolvedValueOnce. Restore the baseline
  // explicitly so a test whose guard correctly prevents submission cannot leak its
  // one-shot failure into the next test.
  vi.mocked(submitTx).mockReset().mockImplementation(async (intent: { value: bigint }) => ({
    ok: true,
    state: "relayed",
    simulated: false,
    txHash: "0xhash",
    nonce: 0,
    valueWei: intent.value,
    gasWei: 0n }));
});

afterAll(() => {
  fs.rmSync(defaultStrategyDataDir, { recursive: true, force: true });
});

describe("audited citizens are never auto-paid", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;

  beforeEach(() => {
    vi.clearAllMocks();
    // jitSubmitted is module-level and persists across tests at the same target epoch,
    // so clear it or a citizen marked by an earlier test leaks in and skews the disarm.
    resetJitState();
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    setTestBalance(10_000_000_000_000_000_000n);
    runtime.currentEpoch = 150n;
    runtime.startTime = 0n;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    // Owned token #1 is UNDER AUDIT and inside the safety buffer — the exact state that
    // previously triggered an automatic pay-to-clear.
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([
      {
        tokenId: "1",
        lastEpochPaid: "148",
        currentEpoch: "150",
        auditDueTimestamp: String(Math.floor(Date.now() / 1000) + 600), // expires in 10min
        secondsUntilKillable: 600,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "at-risk",
        estimatedPayWei: "1000000000000000" },
    ]);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    // Restore the module-factory behaviour rather than mockReset(), which strips the
    // implementation entirely and left later describes reading `undefined` statuses.
    vi.mocked(batchGetOwnedStatuses).mockImplementation(async (tokenIds: bigint[], currentEpoch: bigint) =>
      tokenIds.map((tokenId) => ({
        tokenId: tokenId.toString(),
        lastEpochPaid: LAST_EPOCH_PAID.toString(),
        currentEpoch: currentEpoch.toString(),
        auditDueTimestamp: "0",
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: isAuditableStub(LAST_EPOCH_PAID, currentEpoch) ? "delinquent" : "safe",
        estimatedPayWei: "1000000000000000" })) as never,
    );
  });

  it("there is no defense pass at all — nothing responds to an audit automatically", async () => {
    // Structural guarantee: re-introducing any automatic audit response would mean
    // exporting a defense pass again. If this fails, someone added one back.
    const strategy = await import("./strategy.js");
    expect("defensePass" in strategy).toBe(false);
    // ...and no bribe-spending flag exists to re-enable one via config.
    expect("autoUseBribe" in DEFAULT_STRATEGY).toBe(false);
  });

  it("JIT does not pay an audited citizen, even when checked and armed", async () => {
    // JIT is the path that pays a CHECKED citizen at the boundary, so it carries the
    // guarantee for citizens the user did NOT opt out of.
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [] };

    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES")).toHaveLength(0);
  });

  it("never spends a bribe automatically, for any citizen", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, enabled: true,
      jitEnabled: true, jitTargetEpoch: 150 };
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([
      {
        tokenId: "1", lastEpochPaid: "148", currentEpoch: "150",
        auditDueTimestamp: String(Math.floor(Date.now() / 1000) + 600),
        secondsUntilKillable: 600, bribeBalance: "5", hasLifeInsurance: false,
        risk: "at-risk", estimatedPayWei: "1000000000000000" },
    ]);

    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xBRIBE")).toHaveLength(0);
  });

  it("a failed JIT payment is NOT marked covered, so it retries and does not disarm", async () => {
    // Regression: act() returns the failed result object (truthy) on a submission
    // failure, and `if (res) jitSubmitted.add(key)` marked the citizen covered anyway.
    // Because the one-shot disarm fires once every selected citizen is marked, a single
    // failure ended the whole JIT session with that citizen unpaid — with several
    // citizens, one silently gets dropped.
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [] };
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([
      {
        tokenId: "1", lastEpochPaid: "149", currentEpoch: "150",
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" },
    ]);
    // Submission fails (e.g. sim revert): ok:false, but still a non-null result.
    vi.mocked(submitTx).mockResolvedValueOnce({
      ok: false, simulated: true, error: "sim revert", nonce: 0, valueWei: 0n, gasWei: 0n } as never);

    const saveSpy = vi.spyOn(runtime, "saveStrategy");
    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    // Must NOT have disarmed — the citizen still needs paying.
    const disarmed = saveSpy.mock.calls.some(([patch]) => (patch as any).jitEnabled === false);
    expect(disarmed).toBe(false);
    saveSpy.mockRestore();
  });

  it("a relayed JIT payment stays armed until a successful receipt confirms it", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000 };
    useWallet({ address: "0x1111111111111111111111111111111111111111" }, 10_000_000_000_000_000_000n);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([{
      tokenId: "1", lastEpochPaid: "149", currentEpoch: "150",
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" }]);
    let resolveReceipt!: (receipt: unknown) => void;
    vi.mocked(publicClient.waitForTransactionReceipt).mockImplementationOnce(
      () => new Promise((resolve) => { resolveReceipt = resolve; }) as never,
    );
    const saveSpy = vi.spyOn(runtime, "saveStrategy");

    await jitPass([1n], 150n, 0n);
    expect(saveSpy.mock.calls.some(([p]) => (p as any).jitEnabled === false)).toBe(false);

    resolveReceipt({ status: "success", blockNumber: 101n });
    await new Promise((resolve) => setImmediate(resolve));
    expect(saveSpy.mock.calls.some(([p]) => (p as any).jitEnabled === false)).toBe(true);
    saveSpy.mockRestore();
  });

  it("does not disarm from a latest-only payment that safe state has not confirmed", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [] };
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([{
      tokenId: "1", lastEpochPaid: "150", currentEpoch: "150",
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "safe", estimatedPayWei: "0" }]);
    vi.mocked(publicClient.multicall).mockResolvedValueOnce([
      { status: "success", result: 149n }, // latest inclusion is absent from safe state
    ] as never);
    const saveSpy = vi.spyOn(runtime, "saveStrategy");

    await jitPass([1n], 150n, 0n);
    expect(saveSpy.mock.calls.some(([p]) => (p as any).jitEnabled === false)).toBe(false);

    vi.mocked(publicClient.multicall).mockResolvedValueOnce([
      { status: "success", result: 150n },
    ] as never);
    await jitPass([1n], 150n, 1n);
    expect(saveSpy.mock.calls.some(([p]) => (p as any).jitEnabled === false)).toBe(true);
    saveSpy.mockRestore();
  });

  it("does not complete or duplicate a publicly relayed JIT payment before inclusion", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000 };
    useWallet({ address: "0x1111111111111111111111111111111111111111" }, 10_000_000_000_000_000_000n);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([{
      tokenId: "1", lastEpochPaid: "149", currentEpoch: "150",
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" }]);
    let resolveReceipt!: (receipt: unknown) => void;
    vi.mocked(publicClient.waitForTransactionReceipt).mockImplementationOnce(
      () => new Promise((resolve) => { resolveReceipt = resolve; }) as never,
    );
    const saveSpy = vi.spyOn(runtime, "saveStrategy");

    await jitPass([1n], 150n, 0n);
    await jitPass([1n], 150n, 1n);
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls.some(([p]) => (p as any).jitEnabled === false)).toBe(false);

    resolveReceipt({ status: "success", blockNumber: 101n });
    await new Promise((resolve) => setImmediate(resolve));
    saveSpy.mockRestore();
  });

  it("keeps public-tx suppression and spend reserved across a receipt wait timeout", async () => {
    vi.useFakeTimers();
    try {
      runtime.strategy = {
        ...DEFAULT_STRATEGY,
        enabled: true,
        jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [],
        minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000 };
      useWallet({ address: "0x1111111111111111111111111111111111111111" }, 10_000_000_000_000_000_000n);
      vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
      await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
      vi.mocked(batchGetOwnedStatuses).mockResolvedValue([{
        tokenId: "1", lastEpochPaid: "149", currentEpoch: "150",
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" }]);
      let resolveReceipt!: (receipt: unknown) => void;
      vi.mocked(publicClient.waitForTransactionReceipt)
        .mockRejectedValueOnce(new Error("timed out"))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveReceipt = resolve; }) as never);

      await jitPass([1n], 150n, 0n);
      await vi.advanceTimersByTimeAsync(0);
      await jitPass([1n], 150n, 1n);
      expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(1);

      // Let background tracking resume and terminate it cleanly with a real receipt.
      await vi.advanceTimersByTimeAsync(5_000);
      resolveReceipt({ status: "success", blockNumber: 101n });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending transaction's exact spend reserved across later ticks", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: ["10"], excludedTokenIds: [],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000 };
    useWallet({ address: "0x1111111111111111111111111111111111111111" }, 10_000_000_000_000_000n);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n, 20n]);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    vi.mocked(batchGetOwnedStatuses).mockImplementation(async (ids: bigint[]) => ids.map((id) => ({
      tokenId: id.toString(), lastEpochPaid: "149", currentEpoch: "150",
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" })) as never);
    let resolveReceipt!: (receipt: unknown) => void;
    vi.mocked(publicClient.waitForTransactionReceipt).mockImplementationOnce(
      () => new Promise((resolve) => { resolveReceipt = resolve; }) as never,
    );
    vi.mocked(submitTx).mockImplementation(async (intent: { value: bigint }) => ({
      ok: true, state: "relayed", simulated: false, txHash: "0xpending", nonce: 0,
      valueWei: intent.value, gasWei: 4_000_000_000_000_000n }));

    await jitPass([10n, 20n], 150n, 0n);
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(1);

    // A new tick targets a different citizen from the same wallet. Its cached balance is
    // unchanged, but the first tx already reserves 0.005 ETH; the second estimated spend
    // no longer fits and must not be submitted while the first receipt remains pending.
    runtime.strategy = { ...runtime.strategy, jitTokenIds: ["20"] };
    await jitPass([10n, 20n], 150n, 1n);
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(1);

    resolveReceipt({ status: "success", blockNumber: 101n });
    await new Promise((resolve) => setImmediate(resolve));
    resetJitState();
  });

  it("skips an excluded citizen on the JIT path", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, enabled: true,
      jitEnabled: true, jitTargetEpoch: 150, excludedTokenIds: ["1"] };

    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    expect(vi.mocked(submitTx)).not.toHaveBeenCalled();
  });
});

describe("proactive pay only fires at the epoch boundary, never on generic tick detection", () => {
  const FAKE_ACCOUNT = {
    address: "0x1111111111111111111111111111111111111111" } as unknown as PrivateKeyAccount;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Epoch 5 runs [345600, 432000). Start 300s before the epoch-6 boundary.
    // The citizen is already 2 epochs behind (delinquent) at this instant.
    vi.setSystemTime(new Date(431_700 * 1000));

    useWallet(FAKE_ACCOUNT);
    runtime.running = false;
    setTestBalance(null);
    runtime.currentEpoch = null;
    runtime.startTime = null;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      enabled: true,
      proactivePay: true,
      jitEnabled: false,
      minBalanceEth: 0,
      maxPaymentEth: 0,
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
      // maxAutoPayEpochs defaults to 1; proactive-pay pays the capped single epoch.
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


// Away mode keeps the engine stopped between epochs and wakes it on a timer, so the
// arming decision IS the feature: arm when there is boundary work, stay dark otherwise.
// Getting this wrong means either sleeping through a boundary or defeating the point.

describe("away mode arming", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const START = 0n;                    // matches START_TIME in this file's mocks
  const EPOCH = 86_400n;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 1h into epoch 151 -> next boundary is START + 151*EPOCH.
    vi.setSystemTime(Number(START + EPOCH * 150n + 3600n) * 1000);
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.startTime = START;
    runtime.running = false;
    runtime.awayNextWakeSec = null;
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true, awayLeadMinutes: 15, enabled: true, proactivePay: true, jitEnabled: false };
  });

  afterEach(() => {
    clearAwayTimers();
    vi.useRealTimers();
    runtime.setWallets([]);
  });

  it("arms exactly lead-minutes before the next boundary", () => {
    scheduleAwayWake();
    const boundary = Number(START + EPOCH * 151n);
    expect(runtime.awayNextWakeSec).toBe(boundary - 15 * 60);
  });

  it("respects a custom lead", () => {
    runtime.strategy = { ...runtime.strategy, awayLeadMinutes: 45 };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n) - 45 * 60);
  });

  it("stays dark when there is nothing to wake for", () => {
    runtime.strategy = { ...runtime.strategy, enabled: false, jitEnabled: false, proactivePay: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  // POST /api/jit sets `enabled` alongside jitEnabled, so that pairing is the real armed
  // state — and it has to be, since jitPass itself is gated on `enabled`.
  it("arms for an armed JIT payment", () => {
    runtime.strategy = { ...runtime.strategy, enabled: true, jitEnabled: true, jitTargetEpoch: 151, proactivePay: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).not.toBeNull();
  });

  // Away mode must wake for anything a RUNNING engine would do at the boundary. Proactive
  // pay is the standing pre-audit defense of owned citizens and survives a JIT disarm, so
  // missing it here would silently stop paying them the moment JIT disarmed.
  it("arms for proactive pay alone — no JIT armed", () => {
    runtime.strategy = {
      ...runtime.strategy,
      jitEnabled: false, jitTargetEpoch: null,
      enabled: true, proactivePay: true };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n) - 15 * 60);
  });

  it("stays dark when payment is off entirely", () => {
    runtime.strategy = {
      ...runtime.strategy,
      jitEnabled: false, jitTargetEpoch: null,
      enabled: false, proactivePay: true };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  it("does not arm while the wallet is locked — it could not submit anything anyway", () => {
    runtime.setWallets([]);
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  it("does not arm when away mode is off", () => {
    runtime.strategy = { ...runtime.strategy, awayMode: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  // Turning away mode ON while the engine is already running (the "Arm payment started
  // the bot, then I enabled away mode" flow). Away mode must take over the run window —
  // otherwise the engine polls forever and away mode is silently inert.
  it("stops a running engine when enabled OUTSIDE a boundary window", () => {
    runtime.running = true; // as if Arm payment had started it
    scheduleAwayWake();
    expect(runtime.running).toBe(false);
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n) - 15 * 60);
  });

  it("keeps a running engine when enabled INSIDE the lead window, and arms the stop", () => {
    vi.setSystemTime(Number(START + EPOCH * 151n - 5n * 60n) * 1000); // 5 min before boundary
    runtime.running = true;
    scheduleAwayWake();
    expect(runtime.running).toBe(true);          // still in the window it would have created
    expect(runtime.awayNextWakeSec).toBeNull();  // running, not counting down to a wake
  });

  it("keeps a running engine when enabled inside the post-boundary grace", () => {
    vi.setSystemTime(Number(START + EPOCH * 150n + 60n) * 1000); // 1 min after a boundary
    runtime.running = true;
    scheduleAwayWake();
    expect(runtime.running).toBe(true);
  });

  // The core promise of away mode: a STOPPED engine must actually start when the wake
  // fires. If this regressed, the bot would sleep straight through every boundary while
  // the dashboard cheerfully showed an AWAY badge counting down to a wake that does
  // nothing — a silent, total failure of the feature.
  it("STARTS a stopped engine when the wake fires", async () => {
    runtime.running = false;
    vi.setSystemTime(Number(START + EPOCH * 151n - 60n) * 1000); // inside the lead window
    scheduleAwayWake();
    expect(runtime.running).toBe(false); // armed, not yet fired
    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.running).toBe(true);
    stopEngine();
  });

  it("does NOT start when the wallet was locked before the wake fired", async () => {
    runtime.running = false;
    vi.setSystemTime(Number(START + EPOCH * 151n - 60n) * 1000);
    scheduleAwayWake();     // armed while unlocked
    runtime.setWallets([]); // locked in the meantime — nothing could be submitted anyway
    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.running).toBe(false);
  });

  it("wakes immediately when already inside the lead window", () => {
    vi.setSystemTime(Number(START + EPOCH * 151n - 60n) * 1000); // 1 min before boundary
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n - 60n)); // = now
  });
});

// The arming tests above prove away mode SCHEDULES correctly. These prove it actually
// runs the window: wakes early, stays up across the boundary, stops shortly after, and
// re-arms for the next epoch. A regression here is invisible on the dashboard — the
// badge still counts down — but either misses every boundary or never idles again.

describe("away mode run window (wake -> run -> stop)", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const START = 0n;
  const EPOCH = 86_400n;
  const BOUNDARY = START + EPOCH * 151n; // the boundary that starts epoch 152
  const LEAD = 15n * 60n;
  const GRACE = 5n * 60n;
  const at = (sec: bigint) => vi.setSystemTime(Number(sec) * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.startTime = START;
    runtime.running = false;
    runtime.awayNextWakeSec = null;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      awayMode: true,
      awayLeadMinutes: 15,
      enabled: true,
      proactivePay: true,
      jitEnabled: false,
    };
  });

  afterEach(() => {
    clearAwayTimers();
    stopEngine();
    vi.useRealTimers();
    runtime.setWallets([]);
    runtime.running = false;
  });

  it("wakes at lead, stays up across the boundary, stops after the grace, re-arms", async () => {
    at(BOUNDARY - 20n * 60n);
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(BOUNDARY - LEAD));
    expect(runtime.running).toBe(false);

    // 5 more minutes -> the wake fires at boundary - 15 min.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(runtime.running).toBe(true);
    // Running, so the badge shows the window, not a countdown to a wake already past.
    expect(runtime.awayNextWakeSec).toBeNull();

    // Across the boundary itself and into the grace: must still be up.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // now = boundary
    expect(runtime.running).toBe(true);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // boundary + 4 min
    expect(runtime.running).toBe(true);

    // Past boundary + 5 min: the window closes and the next one is armed.
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(runtime.running).toBe(false);
    expect(runtime.awayNextWakeSec).toBe(Number(BOUNDARY + EPOCH - LEAD));
  });

  it("does not hold the engine open for a whole epoch when the wake fires late", async () => {
    at(BOUNDARY - 20n * 60n);
    scheduleAwayWake();

    // The machine suspends. setTimeout does not fire while suspended, so by the time the
    // event loop runs again the boundary is already behind us and the grace has expired.
    at(BOUNDARY + GRACE + 2n * 60n);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // The boundary work is missed either way — but the engine must not sit up burning
    // ~22 req/min until the NEXT boundary 24h away.
    expect(runtime.running).toBe(false);
    expect(runtime.awayNextWakeSec).toBe(Number(BOUNDARY + EPOCH - LEAD));
  });

  it("honours what is left of the window when the wake fires just after the boundary", async () => {
    at(BOUNDARY - 20n * 60n);
    scheduleAwayWake();

    // Suspended through the lead, resuming 2 min PAST the boundary — still inside the
    // grace, so the window is real: a JIT payment for the new epoch can still land.
    at(BOUNDARY - 3n * 60n);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // fires at boundary + 2 min
    expect(runtime.running).toBe(true);

    // It ends at boundary + 5 min as always — not 5 min from the late wake, which would
    // stretch the window every time a wake slipped.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // boundary + 4 min
    expect(runtime.running).toBe(true);
    await vi.advanceTimersByTimeAsync(90 * 1000); // boundary + 5.5 min
    expect(runtime.running).toBe(false);
    expect(runtime.awayNextWakeSec).toBe(Number(BOUNDARY + EPOCH - LEAD));
  });
});

// Regression: a bundle-only tx sat on "submitted" in the activity log forever, even
// after it demonstrably landed on-chain. Payments mirror to the public mempool so they
// come back with a broadcast txHash and get receipt-tracked; a revertible audit riding
// the combined bundle is never broadcast, so it had no hash and nothing was polled.
// The hash is derivable without broadcasting (keccak of the signed tx — flushBundle
// already computes exactly that for revertingTxHashes), so both kinds must now resolve.

describe("queued JIT bundle lifecycle restores retry eligibility", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const TARGET_EPOCH = 200n;
  const PREDICTED_HASH = "0xpredicted" as const;
  let priorMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetJitState();
    priorMode = (appConfig as { mode?: string }).mode;
    (appConfig as { mode?: string }).mode = "mainnet";
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.currentEpoch = TARGET_EPOCH - 1n;
    runtime.startTime = 0n;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      preBoundaryPay: true, jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH),
      jitTokenIds: [], minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000,
      coinbaseBidEth: 0 };
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditDueTimestamp" ? 0n : TARGET_EPOCH - 1n }))) as never);
    vi.mocked(submitTx).mockImplementation(async (intent: { value: bigint }) => ({
      ok: true, state: "queued", simulated: true, queued: true, nonce: 0,
      predictedTxHash: PREDICTED_HASH, valueWei: intent.value, gasWei: 1n }));
    vi.mocked(queueCoinbaseBid).mockResolvedValue(false);
  });

  afterEach(() => {
    (appConfig as { mode?: string }).mode = priorMode;
    runtime.setWallets([]);
    runtime.running = false;
    resetJitState();
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(publicClient.getBlockNumber).mockResolvedValue(100n);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({ status: "success", blockNumber: 101n } as never);
  });

  it("retries after the batch flush throws", async () => {
    vi.mocked(flushBundle).mockRejectedValueOnce(new Error("relay unavailable"));
    await firePreBoundaryPay();
    await firePreBoundaryPay();
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(2);
  });

  it("retries when a queued transaction is missing from the flush result", async () => {
    vi.mocked(flushBundle).mockResolvedValue(new Map());
    await firePreBoundaryPay();
    await firePreBoundaryPay();
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(2);
  });

  it("retries after an accepted private bundle passes its last eligible block", async () => {
    vi.mocked(flushBundle).mockResolvedValue(new Map<number, any>([[0, {
      ok: true, state: "relayed", predictedTxHash: PREDICTED_HASH,
      bundleHash: "0xbundle", expiresAfterBlock: 101n }]]) as never);
    vi.mocked(publicClient.waitForTransactionReceipt).mockImplementation(
      () => new Promise(() => {}) as never,
    );
    vi.mocked(publicClient.getBlockNumber).mockResolvedValue(102n);

    await firePreBoundaryPay();
    await new Promise((resolve) => setImmediate(resolve));
    await firePreBoundaryPay();
    expect(vi.mocked(submitTx)).toHaveBeenCalledTimes(2);
  });
});

// Multi-wallet routing.
//
// payTaxes / audit / useBribe are owner-only on-chain — simulating each from a funded
// non-owner reverts, while the identical call from the owner succeeds — so an action has
// to be signed by the wallet that holds the citizen. Signing with the wrong wallet does
// not fail loudly: it reverts on-chain after burning gas and losing the boundary race.
// These pin that every action carries its owner's account.

describe("multi-wallet: actions are signed by the wallet that owns the citizen", () => {
  const A = "0xaaaa000000000000000000000000000000000001" as const;
  const B = "0xbbbb000000000000000000000000000000000002" as const;
  const acctA = { address: A } as unknown as PrivateKeyAccount;
  const acctB = { address: B } as unknown as PrivateKeyAccount;
  const TARGET_EPOCH = 200n;

  // Wallet A holds #10, wallet B holds #20.
  const OWNED: Record<string, bigint[]> = { [A.toLowerCase()]: [10n], [B.toLowerCase()]: [20n] };

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.setWallets([
      { account: acctA, label: "A", balanceWei: 100_000_000_000_000_000_000n },
      { account: acctB, label: "B", balanceWei: 100_000_000_000_000_000_000n },
    ]);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.citizenSupply = 500n;
    runtime.currentEpoch = TARGET_EPOCH - 1n;
    runtime.startTime = 0n;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      preBoundaryPay: true,
      jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: [],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000,
      coinbaseBidEth: 0,
    };

    // Ownership is per-address: each wallet sees only its own citizen.
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) =>
      OWNED[addr.toLowerCase()] ?? [],
    );
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditDueTimestamp" ? 0n : TARGET_EPOCH - 1n,
      })) ) as never);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditDueTimestamp" ? 0n : 1_000_000n,
      })) ) as never);
  });

  /** Signing account of each submitTx call, keyed by the tx's calldata. */
  const signersByData = () => {
    const out: { data: string; signer: string | undefined }[] = [];
    for (const [intent, opts] of vi.mocked(submitTx).mock.calls) {
      out.push({ data: (intent as { data: string }).data, signer: (opts as { account?: { address: string } })?.account?.address });
    }
    return out;
  };

  it("pays each citizen from the wallet that holds it", async () => {
    await firePreBoundaryPay();
    const pays = signersByData().filter((c) => c.data === "0xPAYTAXES");
    // One payment per wallet, each signed by that wallet — not both by the primary.
    expect(pays).toHaveLength(2);
    expect(new Set(pays.map((p) => p.signer))).toEqual(new Set([A, B]));
  });

  it("skips a citizen whose wallet is not unlocked rather than signing with another", async () => {
    // B is removed after ownership was observed — its citizen must simply go unactioned.
    runtime.setWallets([{ account: acctA, label: "A", balanceWei: 100_000_000_000_000_000_000n }]);
    await firePreBoundaryPay();
    const pays = signersByData().filter((c) => c.data === "0xPAYTAXES");
    expect(pays.every((p) => p.signer === A)).toBe(true);
    expect(pays.some((p) => p.signer === B)).toBe(false);
  });

  it("checks the min-balance floor against the paying wallet, not the total", async () => {
    // A is empty, B is flush. A shared total (100 ETH) would clear the floor and let A
    // send a tx it cannot pay for; per-wallet accounting must stop A and allow B.
    runtime.setWallets([
      { account: acctA, label: "A", balanceWei: 0n },
      { account: acctB, label: "B", balanceWei: 100_000_000_000_000_000_000n },
    ]);
    runtime.strategy = { ...runtime.strategy, minBalanceEth: 0.01 };
    await firePreBoundaryPay();
    const pays = signersByData().filter((c) => c.data === "0xPAYTAXES");
    expect(pays.some((p) => p.signer === B)).toBe(true);
    expect(pays.some((p) => p.signer === A)).toBe(false);
  });

  it("applies the final dynamic-fee guard to the actual secondary-wallet payer", async () => {
    runtime.setWallets([
      { account: acctA, label: "A", balanceWei: 100_000_000_000_000_000_000n },
      { account: acctB, label: "B", balanceWei: 10_000_000_000_000_000n },
    ]);
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) =>
      addr.toLowerCase() === B.toLowerCase() ? [20n] : [],
    );
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    runtime.strategy = {
      ...runtime.strategy,
      jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: ["20"],
      minBalanceEth: 0 };
    vi.mocked(publicClient.getBalance).mockImplementation(async ({ address }: any) =>
      address.toLowerCase() === B.toLowerCase()
        ? 10_000_000_000_000_000n
        : 100_000_000_000_000_000_000n,
    );
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([{
      tokenId: "20", lastEpochPaid: (TARGET_EPOCH - 1n).toString(), currentEpoch: TARGET_EPOCH.toString(),
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000" }]);
    const authorizations: { account: string; ok: boolean }[] = [];
    vi.mocked(submitTx).mockImplementation(async (intent: { value: bigint }, opts: any) => {
      const quote = {
        account: opts.account.address,
        valueWei: intent.value,
        gasWei: 20_000_000_000_000_000n,
        gas: 200_000n,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 80_000_000_000n,
        baseFee: 10_000_000_000n };
      const authorization = await opts.authorizeSpend(quote);
      authorizations.push({ account: quote.account, ok: authorization.ok });
      return {
        ok: authorization.ok, simulated: false, nonce: 0, valueWei: intent.value,
        gasWei: quote.gasWei, error: authorization.reason };
    });

    resetJitState();
    await jitPass([20n], TARGET_EPOCH, 0n);
    expect(authorizations).toEqual([{ account: B, ok: false }]);
    expect(vi.mocked(activity.add).mock.calls.some(([entry]) =>
      (entry as any).tokenId === "20" && (entry as any).status === "skipped" &&
      /exact signed cost/.test((entry as any).message ?? ""),
    )).toBe(true);
  });
});

// Manual "Pay to current" / "Use bribe" are the one path a user can trigger before the
// engine has ever ticked. That made them the worst place for the owner map to be empty:
// act() would fall back to the primary wallet, and payTaxes/useBribe are owner-only, so
// the tx reverts on-chain having already paid gas and lost the boundary. These pin that
// the path resolves ownership itself and refuses rather than guessing.

describe("multi-wallet: manual actions resolve the owning wallet before signing", () => {
  const A = "0xaaaa000000000000000000000000000000000001" as const;
  const B = "0xbbbb000000000000000000000000000000000002" as const;
  const acctA = { address: A } as unknown as PrivateKeyAccount;
  const acctB = { address: B } as unknown as PrivateKeyAccount;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.setWallets([
      { account: acctA, label: "A", balanceWei: 100_000_000_000_000_000_000n },
      { account: acctB, label: "B", balanceWei: 100_000_000_000_000_000_000n },
    ]);
    runtime.gameState = 1;
    runtime.running = false;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.currentEpoch = 200n;
    runtime.startTime = 0n;
    runtime.strategy = { ...DEFAULT_STRATEGY, minBalanceEth: 0 };
    // Wallet B holds #20; wallet A holds nothing.
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) =>
      addr.toLowerCase() === B.toLowerCase() ? [20n] : [],
    );
    vi.mocked(estimateTaxes).mockResolvedValue(1_000_000_000_000_000n);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.gameState = null;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(getBalanceCached).mockResolvedValue(10_000_000_000_000_000_000n);
  });

  it("signs with the holder even when the engine has never ticked", async () => {
    // No prior tick, so the owner map starts empty — the manual path has to populate it.
    const res = await manualPayToCurrent(20n);
    expect(res.ok).toBe(true);
    const call = vi.mocked(submitTx).mock.calls.at(-1);
    expect((call?.[1] as { account?: { address: string } })?.account?.address).toBe(B);
  });

  it("refuses a citizen no unlocked wallet holds, instead of signing with the primary", async () => {
    const res = await manualPayToCurrent(999n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no unlocked wallet holds/i);
    // Nothing was submitted — the old behaviour would have sent a doomed tx from A.
    expect(submitTx).not.toHaveBeenCalled();
  });

  it("checks the floor against the holder's balance, not the total across wallets", async () => {
    // B (the holder) is empty; A is flush. The sum would clear a 1 ETH floor and let a
    // tx go out that B cannot actually pay for. The balance mock has to be per-address
    // too, since refreshSnapshot re-reads every wallet before the floor is evaluated.
    vi.mocked(getBalanceCached).mockImplementation(async (addr: string) =>
      addr.toLowerCase() === B.toLowerCase() ? 0n : 100_000_000_000_000_000_000n,
    );
    runtime.setWallets([
      { account: acctA, label: "A", balanceWei: 100_000_000_000_000_000_000n },
      { account: acctB, label: "B", balanceWei: 0n },
    ]);
    runtime.strategy = { ...runtime.strategy, minBalanceEth: 1 };
    const res = await manualPayToCurrent(20n);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/B would breach/);
    expect(submitTx).not.toHaveBeenCalled();
  });
});

// The standalone (audit-only) pre-boundary fire, and the flag that decides how it fails.
//
// `revertible` does double duty: it marks the audit allowed-to-revert in the bundle AND
// makes it bundle-only (act() sets race:false for revertible txs). So the two settings
// are two different failure modes, and picking the wrong one cost a real epoch of audits:
// with a 0.022 ETH bid configured, ONE doomed audit invalidated the all-or-nothing
// bundle, the builder dropped it, the bundle-only coinbase bid died with it, and the
// audits trickled out through the mempool naked — landing at tx index 40 instead of 0 and
// every one reverting with AuditAlreadyActive.

describe("auto-arm: unattended JIT arming for the next boundary", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const EPOCH = 200n;
  const OWNED = [10n, 20n];

  /** lastEpochPaid / auditDueTimestamp per token, driving batchGetOwnedStatuses. */
  const stage = (rows: Record<string, { paid: bigint; auditDue?: string }>) => {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: (rows[id.toString()]?.paid ?? cur).toString(),
        currentEpoch: cur.toString(),
        auditDueTimestamp: rows[id.toString()]?.auditDue ?? "0",
        secondsUntilKillable: null,
        bribeBalance: "0",
        hasLifeInsurance: false,
        risk: "safe",
        estimatedPayWei: "1000000000000000" })) ) as never);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = EPOCH;
    runtime.startTime = 0n;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true, jitEnabled: false, jitTargetEpoch: null };
    stage({ "10": { paid: EPOCH - 1n } }); // #10 is a full epoch behind, #20 is current
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    runtime.strategy = { ...DEFAULT_STRATEGY };
    vi.mocked(batchGetOwnedStatuses).mockReset();
  });

  it("arms for the NEXT boundary when a citizen is behind", async () => {
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(true);
    // currentEpoch + 1: the boundary at which that citizen would become auditable. Arming
    // for the CURRENT epoch would be arming for a boundary that has already gone.
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(EPOCH + 1n));
    // jitPass is gated on `enabled`, so arming without it would be inert.
    expect(runtime.strategy.enabled).toBe(true);
  });

  it("does nothing when away mode is off", async () => {
    // Attended, arming stays a keypress: there is somebody there to decide, so the engine
    // must not start spending on its own. Away mode is the whole of the consent.
    runtime.strategy = { ...runtime.strategy, awayMode: false };
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("stays idle when every citizen is current", async () => {
    stage({}); // all paid up to the current epoch
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("never arms for a citizen that is UNDER AUDIT", async () => {
    // An audited citizen gets no automatic response — recovering one is a manual
    // decision. Auto-arm must not become a back door around that.
    stage({ "10": { paid: EPOCH - 1n, auditDue: "99999999999" } });
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("never arms for a citizen the user excluded from payment", async () => {
    runtime.strategy = { ...runtime.strategy, excludedTokenIds: ["10"] };
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("leaves an already-armed JIT alone", async () => {
    // Re-arming mid-flight would reset the submission bookkeeping and could double-pay.
    runtime.strategy = { ...runtime.strategy, jitEnabled: true, jitTargetEpoch: 999 };
    await maybeAutoArmPayment(OWNED, EPOCH, 0n);
    expect(runtime.strategy.jitTargetEpoch).toBe(999);
  });
});

// WHICH boundary auto-arm is aiming at, which is not the same in both halves of the away
// window and decides whether a citizen waits ~24h to be paid. The trigger is
// `lastEpochPaid < currentEpoch`, so everything turns on whether the debt already existed
// when the engine woke, or only appeared when the epoch rolled over.

describe("auto-arm timing: 15-min wake vs epoch crossover", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const N = 200n;

  const paidThrough = (lastEpochPaid: bigint) => {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(), lastEpochPaid: lastEpochPaid.toString(), currentEpoch: cur.toString(),
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "safe", estimatedPayWei: "1000000000000000" })) ) as never);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.startTime = 0n;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true, jitEnabled: false, jitTargetEpoch: null };
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    runtime.strategy = { ...DEFAULT_STRATEGY };
    vi.mocked(batchGetOwnedStatuses).mockReset();
  });

  it("ALREADY behind at the wake -> arms for the boundary 15 minutes away", async () => {
    // Owes epoch N as the engine wakes, so it turns auditable the instant the boundary
    // lands. This is the urgent case and it is caught before the crossover, not after.
    runtime.currentEpoch = N;
    paidThrough(N - 1n);
    await maybeAutoArmPayment([10n], N, 0n);
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(N + 1n));
  });

  it("current at the wake -> nothing arms, because nothing is owed yet", async () => {
    runtime.currentEpoch = N;
    paidThrough(N);
    await maybeAutoArmPayment([10n], N, 0n);
    expect(runtime.strategy.jitEnabled).toBe(false);
  });

  it("falls behind AT the crossover -> armed in the grace, for the NEXT boundary", async () => {
    // The steady state. The epoch rolled to N+1 and the citizen now owes one, which the
    // post-boundary grace tick sees. One behind is not auditable, so the deadline is the
    // FOLLOWING boundary — the engine sleeps the epoch out and wakes 15 min before it.
    runtime.currentEpoch = N + 1n;
    paidThrough(N);
    await maybeAutoArmPayment([10n], N + 1n, 0n);
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(N + 2n));
  });
});

// Benji (Defense) Mode inverts the bot's oldest safety rule — "an audited citizen gets no
// automatic response at all" — and is the only path that pays an UNBOUNDED amount without
// a keypress, since an audited citizen is 2+ epochs behind and payTaxes force-settles all
// of them at once. So these pin the boundaries of the exception as tightly as the feature:
// what it will spend, what it refuses to touch, and the limits it still answers to.

describe("benji (defense) mode: auto-paying an audited citizen", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const EPOCH = 200n;
  const OWNED = [10n];
  const DEBT = 3_000_000_000_000_000n; // 3 epochs' catch-up

  /** One owned citizen, audited or not, with a bribe balance and a quoted debt. */
  const stage = (o: { auditDue?: string; bribes?: bigint; owed?: bigint; behind?: bigint } = {}) => {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(),
        lastEpochPaid: (cur - (o.behind ?? 3n)).toString(),
        currentEpoch: cur.toString(),
        auditDueTimestamp: o.auditDue ?? "99999999999",
        secondsUntilKillable: 3600,
        bribeBalance: (o.bribes ?? 0n).toString(),
        hasLifeInsurance: false,
        risk: "audited",
        estimatedPayWei: (o.owed ?? DEBT).toString() })) ) as never);
  };

  const paid = () => vi.mocked(submitTx).mock.calls.filter(([i]) => (i as { data: string }).data === "0xPAYTAXES");

  beforeEach(async () => {
    vi.clearAllMocks();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = EPOCH;
    runtime.startTime = 0n;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    // maxAutoPayEpochs: 1 throughout — a 3-epoch debt is far over it, which is the point.
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      autoDefendAudit: true, maxAutoPayEpochs: 1, maxPaymentEth: 0,
      minBalanceEth: 0, maxBaseFeeGwei: 1000 };
    // payTaxes is owner-only, so the pass fails closed unless it can resolve the holding
    // wallet. tick() primes that by fetching ownership first; do the same here.
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    // Bookkeeping is module state keyed by audit, so without this a token paid in one
    // test is silently skipped in the next — which made a later assertion pass for the
    // wrong reason before this was added.
    resetDefenseState();
    stage();
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    runtime.strategy = { ...DEFAULT_STRATEGY };
    vi.mocked(batchGetOwnedStatuses).mockReset();
  });

  it("pays off an audited citizen that holds no bribes", async () => {
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(1);
    expect((paid()[0]?.[0] as { value: bigint }).value).toBe(DEBT);
  });

  it("does nothing when the toggle is off", async () => {
    runtime.strategy = { ...runtime.strategy, autoDefendAudit: false };
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
  });

  it("ignores a citizen that is not under audit", async () => {
    stage({ auditDue: "0" });
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
  });

  it("leaves an audited citizen alone while it still holds a bribe", async () => {
    // A bribe clears the audit for free, so paying tax instead would be strictly worse.
    // Which one to burn stays the user's call.
    stage({ bribes: 1n });
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
  });

  it("never rescues a citizen the user excluded from payment", async () => {
    // "Never pay this one" has to mean never, or this switch would quietly resurrect a
    // citizen the user had decided to let go.
    runtime.strategy = { ...runtime.strategy, excludedTokenIds: ["10"] };
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
  });

  it("pays a catch-up far over the Auto-Pay Limit, on purpose", async () => {
    // maxAutoPayEpochs is 1 and the debt is 3 epochs. Honouring that cap here would block
    // the feature in exactly the case it exists for, so it is deliberately not applied.
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(1);
  });

  it("still answers to Max single payment", async () => {
    // The one ceiling the user sets that this must NOT override, or "Benji (Defense) Mode" would
    // mean "no spending limit at all".
    runtime.strategy = { ...runtime.strategy, maxPaymentEth: 0.002 }; // debt is 0.003
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
  });

  it("retries after a refusal rather than giving up on the citizen", async () => {
    // A base-fee spike must not permanently abandon a citizen with a death clock running.
    runtime.strategy = { ...runtime.strategy, maxPaymentEth: 0.002 };
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(0);
    runtime.strategy = { ...runtime.strategy, maxPaymentEth: 0 }; // spike passes
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(1);
  });

  it("retries a defense payment after an authoritative reverted receipt", async () => {
    vi.mocked(publicClient.waitForTransactionReceipt)
      .mockResolvedValueOnce({ status: "reverted", blockNumber: 101n } as never)
      .mockResolvedValue({ status: "success", blockNumber: 102n } as never);

    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    await new Promise((resolve) => setImmediate(resolve));
    await maybeAutoDefendAudit(OWNED, EPOCH, 1n);
    expect(paid()).toHaveLength(2);
  });

  it("pays one audit once, but arms again for a NEW audit on the same citizen", async () => {
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(1); // same audit, no double-pay

    stage({ auditDue: "88888888888" }); // re-audited later: a different deadline
    await maybeAutoDefendAudit(OWNED, EPOCH, 0n);
    expect(paid()).toHaveLength(2);
  });
});

// Everything shipped today, exercised with a REAL roster rather than one citizen. Each of
// these paths loops per-citizen and spends per-citizen, so the single-token tests above
// can't see the failures that matter most here: cumulative spend against one balance,
// signing across wallets, and one shared coinbase bid covering a bundle of many.
