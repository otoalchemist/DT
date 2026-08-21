import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * The audit fire must race the boundary it was ARMED for, not the one derived when it finally
 * runs.
 *
 * This reproduces a team-wide outage: every audit failed for every member on the same boundary
 * while every payment landed. Cause, and it was mine:
 *
 *   - both pre-boundary fires are scheduled for the same instant and contend for one tick lock,
 *     so the audit fire retries every 150ms behind the payment fire;
 *   - it then re-derived its target as `currentEpoch + 1` and its boundary as
 *     `startTime + currentEpoch * EPOCH`;
 *   - once the epoch rolled, currentEpoch advanced, so those pointed a full DAY ahead;
 *   - minTimestamp (v1.5.6) stamps that boundary onto the bundle, and no block in the window can
 *     satisfy a timestamp 24h in the future — so every audit was dropped with no error, while
 *     payments (which pin their armed epoch) were unaffected.
 *
 * The asymmetry is the tell: audits 0%, payments 100%, everyone at once.
 */

const EPOCH = 86_400n;
const START = 0n;
const TARGET_EPOCH = 200n;
const BOUNDARY = (TARGET_EPOCH - 1n) * EPOCH; // epoch 200 begins here

const sendBundleParams: Record<string, unknown>[] = [];

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ timestamp: BOUNDARY - 12n, baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 5),
    sendRawTransaction: vi.fn(async () => "0xmirror"),
    estimateGas: vi.fn(async () => 100_000n),
    request: vi.fn(async () => "0x"),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : c.functionName === "auditsUsedInEpoch" ? 0n
          : 1_000_000n, // auditor paid far ahead => eligible
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })),
  getBalanceCached: vi.fn(async () => 100_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null,
}));

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    builderUrls: ["https://relay.flashbots.net"],
    flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000,
    ownedTokensOverride: [],
    targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: TARGET_EPOCH, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: START,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () =>
    ["501", "502"].map((tokenId) => ({
      tokenId, owner: "0x00000000000000000000000000000000000000dd",
      lastEpochPaid: (TARGET_EPOCH - 3n).toString(), delinquent: true, epochsBehind: 3,
      auditable: true, auditDueTimestamp: "0", killable: false,
    })),
  ),
  filterLiveTokenIds: vi.fn(async (_c: unknown, ids: bigint[]) =>
    ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
  ),
  encodePayTaxes: vi.fn(() => "0x11111111"),
  encodeAudit: vi.fn(() => "0x22222222"),
  encodeKill: vi.fn(() => "0x33333333"),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 0n),
  gameContract: { address: "0x00000000000000000000000000000000000000aa", abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [10n, 20n]),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));
vi.mock("./nonce.js", () => ({
  nonces: {
    for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 5), reserve: vi.fn(() => 5) })),
    syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn(),
  },
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { firePreBoundaryAudit } = await import("./strategy.js");
const { awaitPendingMirrors } = await import("./flashbots.js");

const ADDR = "0x1111111111111111111111111111111111111111";
const AUDIT = "22222222";

/** eth_sendBundle payloads actually POSTed. */
function bundles(): { txs: `0x${string}`[]; minTimestamp?: number }[] {
  return vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle")
    .map((b) => b.params[0]);
}
const auditTxs = () => bundles().flatMap((b) => b.txs).filter((t) => t.slice(2, 10) === AUDIT);

beforeEach(() => {
  vi.clearAllMocks();
  sendBundleParams.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  runtime.setWallets([{
    account: {
      address: ADDR,
      signTransaction: vi.fn(async (tx: { data?: string; nonce: number }) =>
        `0x${(tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "99999999")}${tx.nonce.toString(16).padStart(4, "0")}${"cd".repeat(28)}` as `0x${string}`),
      signMessage: vi.fn(async () => "0xsig"),
    } as unknown as PrivateKeyAccount,
    label: "t",
    balanceWei: 100_000_000_000_000_000_000n,
  }]);
  runtime.running = true;
  runtime.gameState = 1;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.startTime = START;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    preBoundaryAudit: true, offenseEnabled: true, autoAudit: true,
    preBoundaryPay: false,
    coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: "",
    separateOffenseGas: true, offensePriorityFeeGwei: 250, offenseDynamicTipEnabled: false,
    offenseMaxBaseFeeGwei: 100_000, maxBaseFeeGwei: 100_000,
    minBalanceEth: 0, maxPaymentEth: 0, endgameOnlyWithin: null,
    offenseTargetTokenIds: ["501", "502"],
  } as typeof runtime.strategy;
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a delayed audit fire still races the boundary it was armed for", () => {
  it("stamps the ARMED boundary, not tomorrow's, when currentEpoch has already advanced", async () => {
    // The exact production state: the fire was armed for the epoch-200 boundary, waited behind
    // the payment fire, and by the time it ran the chain had rolled into epoch 200.
    vi.setSystemTime(Number(BOUNDARY + 3n) * 1000); // 3s past the boundary
    runtime.currentEpoch = TARGET_EPOCH;            // already advanced

    await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY });
    await awaitPendingMirrors();

    expect(auditTxs().length).toBeGreaterThan(0);
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY));
    // The regression: currentEpoch + 1 would have produced the NEXT boundary, a day out.
    for (const b of bundles()) expect(b.minTimestamp).not.toBe(Number(BOUNDARY + EPOCH));
  });

  it("derives the same boundary from the clock when called without armed values", async () => {
    // Direct callers (and the retry path before the fix) have no armed values. Within the grace
    // window the clock must still resolve to the boundary just passed, not the next one.
    vi.setSystemTime(Number(BOUNDARY + 30n) * 1000);
    runtime.currentEpoch = TARGET_EPOCH;

    await firePreBoundaryAudit();
    await awaitPendingMirrors();

    expect(auditTxs().length).toBeGreaterThan(0);
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY));
  });

  it("races the NEXT boundary when it is genuinely early, as before", async () => {
    // The normal case must be unchanged: armed 5s ahead of the boundary it is racing into.
    vi.setSystemTime(Number(BOUNDARY - 5n) * 1000);
    runtime.currentEpoch = TARGET_EPOCH - 1n;

    await firePreBoundaryAudit();
    await awaitPendingMirrors();

    expect(auditTxs().length).toBeGreaterThan(0);
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY));
  });

  it("moves on to the next boundary once the grace window has passed", async () => {
    // Hours later there is no race left to run for the old boundary, and pretending otherwise
    // would stamp a timestamp already in the past on every future bundle.
    vi.setSystemTime(Number(BOUNDARY + 3600n) * 1000);
    runtime.currentEpoch = TARGET_EPOCH;

    await firePreBoundaryAudit();
    // Deliberately NOT awaiting the mirrors here: with the boundary an hour away the mirror gate
    // is correctly still holding them (it waits for the pre-boundary block to exist), so awaiting
    // would hang. The claim under test is what got stamped on the bundle, which is already sent.
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY + EPOCH));
  });
});
