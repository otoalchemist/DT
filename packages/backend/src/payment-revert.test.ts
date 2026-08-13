import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Payment revert-tolerance in the boundary bundle.
 *
 * `eth_sendBundle` drops a bundle when any tx NOT in `revertingTxHashes` reverts. Payments
 * are currently always mandatory, so ONE citizen whose payment reverts in-block (e.g.
 * `AlreadyCurrent`, or it got audited earlier in the same block) takes every healthy
 * payment in that bundle down with it.
 *
 * That is expensive for a multi-citizen holder. Measured: boundary blocks carry ~10 rival
 * audits (~4.7 at index <= 20), and a payment that misses the boundary block leaves its
 * citizen 2 epochs behind — auditable — inside exactly that window. 28% of holders run 2+
 * citizens (up to 9), so the healthy payments being dropped is a real loss, not a corner.
 *
 * Two things make this safe, and both are load-bearing:
 *
 *  1. The mirror MUST survive. `act()` derives `race` from `revertible`, so naively marking
 *     payments revertible would strip their public-mempool copy — turning "lands a block
 *     late" into "never lands", which is worse than the problem. The two must be decoupled.
 *  2. It only helps with 2+ payments. With ONE payment there are no others to protect, and
 *     the bundle would land carrying nothing but a reverted tx — so we'd pay the coinbase
 *     bid on a boundary that today costs nothing (a dropped bundle takes the bundle-only
 *     bid with it). Below 2 payments, mandatory is strictly better.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815" as const;
const TARGET_EPOCH = 200n;

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string; args: unknown[] }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        // Owned tokens: current enough to audit from, never under audit, limit 1.
        result: c.functionName === "auditLimit" ? 1n : c.functionName === "auditDueTimestamp" ? 0n : 1_000_000n,
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

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (intent: { value: bigint }) => ({
    ok: true, simulated: true, txHash: "0xhash", nonce: 0, valueWei: intent.value, gasWei: 0n,
  })),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => true),
  setRaceBoundary: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: TARGET_EPOCH - 1n, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async () => []),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeAudit: vi.fn(() => "0xAUDIT"),
  encodeKill: vi.fn(() => "0xKILL"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  estimateTaxes: vi.fn(async () => 0n),
  gameContract: { address: "0x00000000000000000000000000000000000000aa", abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => []),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

// Without this, nonces.syncAll() hits an unmocked RPC and throws — and the fire swallows
// the error, so the symptom is silently zero payments rather than a visible failure.
vi.mock("./nonce.js", () => ({
  nonces: {
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
    for: () => ({ reserve: () => 0, peek: () => 0 }),
  },
}));

vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));

const { submitTx, queueCoinbaseBid } = await import("./flashbots.js");
const { fetchOwnedTokenIds } = await import("./index-tokens.js");
const { publicClient } = await import("./chain.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { firePreBoundaryBundle } = await import("./strategy.js");

/** Every queued payment's submitTx options. */
const paymentCalls = () =>
  vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES").map(([, o]) => o);

/** Owned tokens all one epoch behind the target, so each owes exactly one payment. */
function ownCitizens(n: number): void {
  const ids = Array.from({ length: n }, (_, i) => BigInt(1000 + i));
  vi.mocked(fetchOwnedTokenIds).mockResolvedValue(ids);
  vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
    contracts.map((c: any) => ({
      status: "success" as const,
      result:
        c.functionName === "auditLimit" ? 1n
        : c.functionName === "auditDueTimestamp" ? 0n
        // lastEpochPaid one behind the target => a payment is owed for every citizen.
        : c.functionName === "lastEpochPaid" ? TARGET_EPOCH - 1n
        : 1_000_000n,
    }))) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(submitTx).mockImplementation(async (intent: { value: bigint }) => ({
    ok: true, simulated: true, txHash: "0xhash", nonce: 0, valueWei: intent.value, gasWei: 0n,
  }) as never);
  vi.mocked(queueCoinbaseBid).mockResolvedValue(true);
  runtime.setWallets([{ account: { address: ADDR } as unknown as PrivateKeyAccount, label: "t", balanceWei: 100_000_000_000_000_000_000n }]);
  runtime.running = true;
  runtime.gameState = 1;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.currentEpoch = TARGET_EPOCH - 1n;
  runtime.startTime = 0n;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    preBoundaryPay: true,
    jitEnabled: true,
    jitTargetEpoch: Number(TARGET_EPOCH),
    jitTokenIds: [],
    // Offense off so only payments are queued — isolates the payment flags.
    offenseEnabled: false,
    autoAudit: false,
    preBoundaryAudit: false,
    minBalanceEth: 0,
    maxPaymentEth: 0,
    maxBaseFeeGwei: 1000,
    combinedBoundaryBundle: true,
    coinbaseBidEth: 0.03,
    coinbaseBidAuditOnlyEth: 0.003,
    coinbasePayerAddress: PAYER,
  };
});
afterEach(() => { runtime.setWallets([]); runtime.running = false; });


describe("payments are revert-tolerant when several share a bundle", () => {
  it("marks every payment allowed-to-revert with 5 citizens", async () => {
    ownCitizens(5);
    await firePreBoundaryBundle();
    const pays = paymentCalls();
    expect(pays).toHaveLength(5);
    // One AlreadyCurrent must not drop the other four.
    for (const o of pays) expect(o?.revertible).toBe(true);
  });

  it("KEEPS the mempool mirror on those revert-tolerant payments", async () => {
    // The regression that would matter most: revert-tolerant but unmirrored means a
    // payment that loses its slot never lands at all.
    ownCitizens(5);
    await firePreBoundaryBundle();
    for (const o of paymentCalls()) expect(o?.race).toBe(true);
  });

  it("marks payments revert-tolerant at exactly 2 citizens (the threshold)", async () => {
    ownCitizens(2);
    await firePreBoundaryBundle();
    const pays = paymentCalls();
    expect(pays).toHaveLength(2);
    for (const o of pays) expect(o?.revertible).toBe(true);
  });

  it("keeps a LONE payment mandatory, so a dropped bundle still refunds the bid", async () => {
    // With one payment there is nothing to protect; revert-tolerance would only buy a
    // landed bundle containing a reverted tx, and we'd pay the bid for it.
    ownCitizens(1);
    await firePreBoundaryBundle();
    const pays = paymentCalls();
    expect(pays).toHaveLength(1);
    expect(pays[0]?.revertible).toBeFalsy();
    expect(pays[0]?.race).toBe(true); // still mirrored, as today
  });

  it("counts only citizens that actually OWE a payment, not all owned", async () => {
    // Four owned but three already current => one payment => must stay mandatory.
    const ids = [1000n, 1001n, 1002n, 1003n];
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue(ids);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => {
        if (c.functionName === "auditLimit") return { status: "success" as const, result: 1n };
        if (c.functionName === "auditDueTimestamp") return { status: "success" as const, result: 0n };
        // Only token 1000 is behind; the rest are current for the target epoch.
        const id = c.args?.[0] as bigint;
        return { status: "success" as const, result: id === 1000n ? TARGET_EPOCH - 1n : TARGET_EPOCH };
      })) as never);
    await firePreBoundaryBundle();
    const pays = paymentCalls();
    expect(pays).toHaveLength(1);
    expect(pays[0]?.revertible).toBeFalsy();
  });

  it("still queues one payment per owing citizen", async () => {
    // Revert-tolerance must not change WHAT gets paid, only how a failure is contained.
    ownCitizens(4);
    await firePreBoundaryBundle();
    expect(paymentCalls()).toHaveLength(4);
  });
});
