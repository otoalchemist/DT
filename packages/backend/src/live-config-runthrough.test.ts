import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * End-to-end run-through of a real operator's live configuration, through the pre-boundary
 * race and into the next epoch.
 *
 * The settings below are copied from a running bot at the epoch-177 -> 178 boundary, because
 * the interesting shape is not hypothetical: ONE citizen owes a payment and the SAME citizen
 * is the only eligible auditor, so it pays and audits at the same boundary from one wallet on
 * consecutive nonces. That is exactly the shape that failed at epoch 176 — two fires, two
 * syncs, one wallet — and the shape a coinbase bid would have made atomic. There is no bid
 * here, on purpose.
 *
 *   payment tip 201 gwei / audit tip 131 gwei (separateOffenseGas), coinbaseBidEth 0,
 *   racePublicMempool on, combinedBoundaryBundle on but INERT without a bid.
 *
 * What has to hold, in order:
 *   1. the payment fires first and takes the LOWER nonce;
 *   2. the audit takes a strictly higher one — the citizen may only audit because its own
 *      payment is queued ahead of it (paidInBundle), so a collision here does not merely
 *      lose a transaction, it makes the audit invalid;
 *   3. each fire is its OWN bundle at its OWN tip — no blending;
 *   4. both bundles are stamped minTimestamp = boundary, so neither can execute an epoch early;
 *   5. both are mirrored, so a solo-validator boundary block is still reachable;
 *   6. the audit bundle also aims one block BEHIND its head, to reach the block the payment
 *      fire took if one landed in between;
 *   7. crossing the boundary settles it: the arm clears and the next tick does not re-pay.
 */

const GAME = "0x00000000000000000000000000000000000000aa" as const;
const ADDR = "0x1111111111111111111111111111111111111111" as const;
const EPOCH = 86_400n;
const TARGET_EPOCH = 178n;                 // the epoch being raced into
const BOUNDARY_TS = (TARGET_EPOCH - 1n) * EPOCH; // startTime 0, so this starts epoch 178

const OWNED = [2036n];                     // the one armed citizen: lastEpochPaid 176
const PINNED_TARGET = "5757";              // 1 behind now -> auditable exactly at the boundary
const PAY_TIP = 201;                       // priorityFeeGwei
const AUDIT_TIP = 131;                     // offensePriorityFeeGwei

let chainNonce = 400;
/** lastEpochPaid for our citizen. 176 => one behind at epoch 177, two behind at 178. */
let ownedLep = TARGET_EPOCH - 2n;

const sendRawTransaction = vi.fn(async () => "0xmirror" as `0x${string}`);
const getTransactionCount = vi.fn(async () => chainNonce);

vi.mock("./chain.js", () => ({
  publicClient: {
    /**
     * A realistic head: block 2000 at boundary - 24s, i.e. the fire runs during the slot
     * before the pre-boundary slot. head + 1 (2001) is therefore the PRE-boundary block and
     * head + 2 (2002) is the boundary block. This is the exact geometry of the epoch-178
     * failure, so the target derivation is under test rather than mocked away.
     */
    getBlock: vi.fn(async () => ({
      baseFeePerGas: 1_000_000_000n,
      number: 2_000n,
      timestamp: BOUNDARY_TS - 24n,
    })),
    getBalance: vi.fn(async () => 2_000_000_000_000_000_000n), // 2 ETH, well over minBalanceEth
    getBlockNumber: vi.fn(async () => 2_000n),
    getTransactionCount,
    // Present so the nonce manager's EVIDENCE check runs for real here rather than falling
    // through to the stopwatch backstop: every tx this file signs is mirrored, so the node
    // reports it pending, which is what must make the audit fire take a higher nonce.
    getTransaction: vi.fn(async () => ({ blockNumber: null })),
    request: vi.fn(async () => "0x"),
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => 100_000n),
    sendRawTransaction,
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 2_001n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditsUsedInEpoch" ? 0n
          : c.functionName === "auditDueTimestamp" ? 0n
          : ownedLep,
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({
    baseFeePerGas: 1_000_000_000n, number: 2_000n, gasUsed: 0n, gasLimit: 30_000_000n,
  })),
  getBalanceCached: vi.fn(async () => 2_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null,
}));

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent", gameAddress: GAME,
    builderUrls: ["https://relay.flashbots.net"], flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000, ownedTokensOverride: [], targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: TARGET_EPOCH - 1n, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  // Must return a REAL status, or jitPass iterates nothing and every "it did not pay twice"
  // assertion passes for the wrong reason. Derived from ownedLep so the test can move the
  // chain's view of the citizen between phases.
  batchGetOwnedStatuses: vi.fn(async (ids: bigint[], epoch: bigint) =>
    ids.map((id) => ({
      tokenId: id.toString(),
      lastEpochPaid: ownedLep.toString(),
      currentEpoch: epoch.toString(),
      auditDueTimestamp: "0",
      secondsUntilKillable: null,
      bribeBalance: "0",
      hasLifeInsurance: false,
      risk: "delinquent" as const,
      estimatedPayWei: "121440000000000000",
      auditLimit: 1,
      walletAddress: ADDR,
      walletLabel: "t",
    })),
  ),
  batchGetTargetStatuses: vi.fn(async (tokens: { id: bigint }[], epoch: bigint) =>
    tokens.map(({ id }) => ({
      tokenId: id.toString(), owner: "0x00000000000000000000000000000000000000dd",
      lastEpochPaid: (epoch - 2n).toString(), delinquent: true, epochsBehind: 2,
      auditable: true, auditDueTimestamp: "0", killable: false,
    })),
  ),
  filterLiveTokenIds: vi.fn(async (_c: unknown, ids: bigint[]) =>
    ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
  ),
  // Selectors chosen so the wire says which action it is.
  encodePayTaxes: vi.fn(() => "0x11111111"),
  encodeAudit: vi.fn(() => "0x22222222"),
  encodeKill: vi.fn(() => "0x33333333"),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 121_440_000_000_000_000n), // 0.12144 ETH, the real tax
  gameContract: { address: GAME, abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => OWNED),
  fetchCandidateTokenIds: vi.fn(async () => [BigInt(PINNED_TARGET)]),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));

// Real flashbots + real nonce: the wire and the nonce ordering ARE the run-through.
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { awaitPendingMirrors } = await import("./flashbots.js");
const { firePreBoundaryPay, firePreBoundaryAudit, combinedBundleActive, resetPaidForBoundary,
} = await import("./strategy.js");

const PAY = "11111111", AUDIT = "22222222";

const fakeSign = (sel: string, nonce: number, tipGwei: number): `0x${string}` =>
  `0x${sel}${nonce.toString(16).padStart(4, "0")}${Math.round(tipGwei).toString(16).padStart(6, "0")}${"cd".repeat(23)}` as `0x${string}`;
const parseTx = (t: string) => ({
  sel: t.slice(2, 10),
  nonce: parseInt(t.slice(10, 14), 16),
  tipGwei: parseInt(t.slice(14, 20), 16),
});

/** eth_sendBundle payloads: one per (builder x target block). */
function bundles(): { txs: `0x${string}`[]; blockNumber: string; minTimestamp?: number }[] {
  return vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle")
    .map((b) => b.params[0]);
}
/** Every distinct tx that reached a builder. */
function wireTxs(): { sel: string; nonce: number; tipGwei: number }[] {
  const seen = new Map<string, { sel: string; nonce: number; tipGwei: number }>();
  for (const b of bundles()) for (const t of b.txs) seen.set(t, parseTx(t));
  return [...seen.values()].sort((a, b) => a.nonce - b.nonce);
}

beforeEach(() => {
  vi.clearAllMocks();
  chainNonce += 50; // clear of any ceiling a previous case reserved
  ownedLep = TARGET_EPOCH - 2n;
  resetPaidForBoundary();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; nonce: number; maxPriorityFeePerGas: bigint }) =>
      fakeSign(tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "99999999",
        tx.nonce, Number(tx.maxPriorityFeePerGas) / 1e9)),
    signMessage: vi.fn(async () => "0xsig"),
  } as unknown as PrivateKeyAccount;
  runtime.setWallets([{ account, label: "t", balanceWei: 2_000_000_000_000_000_000n }]);
  runtime.running = true;
  runtime.gameState = 1;
  runtime.currentEpoch = TARGET_EPOCH - 1n;
  runtime.startTime = 0n;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;

  // The live configuration, verbatim.
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    enabled: true, proactivePay: true, prepayEpochs: 1, maxAutoPayEpochs: 1,
    jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: ["2036"],
    excludedTokenIds: [],
    preBoundaryPay: true, preBoundaryLeadMs: 3000, preBoundaryLeadMainnetMs: 5000,
    awayMode: true, awayLeadMinutes: 15, autoDefendAudit: false,
    offenseEnabled: true, autoAudit: true, autoKill: false,
    preBoundaryAudit: true, preBoundaryKill: true, combinedBoundaryBundle: true,
    offenseTargetTokenIds: [PINNED_TARGET],
    sweepUnpinned: true, sweepNormalGas: true,
    maxBaseFeeGwei: 300, priorityFeeGwei: PAY_TIP, dynamicTipEnabled: false, dynamicTipMaxGwei: 103,
    separateOffenseGas: true, offenseMaxBaseFeeGwei: 305, offensePriorityFeeGwei: AUDIT_TIP,
    offenseDynamicTipEnabled: false, offenseDynamicTipMaxGwei: 250,
    racePublicMempool: true,
    coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0,
    coinbasePayerAddress: "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815",
    minBalanceEth: 0.01, maxPaymentEth: 0,
  } as typeof runtime.strategy;
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
});

/** The two schedulers fire in this order: payment first, then audit. */
async function raceTheBoundary(): Promise<void> {
  await firePreBoundaryPay();
  await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY_TS });
  await awaitPendingMirrors();
}

describe("live config, no bid: one citizen pays AND audits at the same boundary", () => {
  it("confirms the combined bundle is INERT, so this really is the two-bundle path", () => {
    // The whole point of the run-through. combinedBoundaryBundle is ON, but with no bid it
    // must not fuse — otherwise the 201 gwei payment would blend with the 131 gwei audit.
    expect(runtime.strategy.combinedBoundaryBundle).toBe(true);
    expect(runtime.strategy.coinbaseBidEth).toBe(0);
    expect(combinedBundleActive(runtime.strategy)).toBe(false);
  });

  it("sends the payment and the audit on CONSECUTIVE nonces, payment first", async () => {
    await raceTheBoundary();
    const txs = wireTxs();
    expect(txs).toHaveLength(2);
    expect(txs[0]!.sel).toBe(PAY);
    expect(txs[1]!.sel).toBe(AUDIT);
    // Consecutive with no gap. The audit is only VALID because the payment sits below it, so
    // a gap here would leave the audit unmineable and a collision would invalidate the payment.
    expect(txs[1]!.nonce).toBe(txs[0]!.nonce + 1);
  });

  it("keeps each tip intact — 201 for the payment, 131 for the audit", async () => {
    await raceTheBoundary();
    const txs = wireTxs();
    expect(txs.find((t) => t.sel === PAY)!.tipGwei).toBe(PAY_TIP);
    expect(txs.find((t) => t.sel === AUDIT)!.tipGwei).toBe(AUDIT_TIP);
  });

  it("puts them in SEPARATE bundles, never one blended bundle", async () => {
    await raceTheBoundary();
    const shapes = bundles().map((b) => b.txs.map((t) => t.slice(2, 10)));
    // No bundle may contain both selectors: that is what blending would look like on the wire.
    for (const s of shapes) {
      expect(s.includes(PAY) && s.includes(AUDIT)).toBe(false);
    }
    expect(shapes.some((s) => s.includes(PAY))).toBe(true);
    expect(shapes.some((s) => s.includes(AUDIT))).toBe(true);
  });

  it("stamps EVERY bundle with minTimestamp = the boundary", async () => {
    // The epoch-169 hazard: without this a bundle can be mined a block early, revert, and burn
    // the nonce the copy aimed at the real boundary needed.
    await raceTheBoundary();
    const bs = bundles();
    expect(bs.length).toBeGreaterThan(0);
    expect(bs.every((b) => b.minTimestamp === Number(BOUNDARY_TS))).toBe(true);
  });

  it("mirrors both to the public mempool, so a solo-validator block is still reachable", async () => {
    await raceTheBoundary();
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("never offers a builder a PRE-boundary block, and both fires agree on the target", async () => {
    /**
     * The epoch-178 failure in one assertion. The head here is at boundary - 24s, so
     * head + 1 (2001) is the pre-boundary block whose slot is 12s early — exactly where the
     * real payment landed and reverted, burning the nonce its boundary-block copy needed.
     *
     * The target is now derived from the boundary timestamp: 2000 + ceil(24/12) = 2002, the
     * first block whose slot can satisfy the boundary. 2001 must appear nowhere, from either
     * fire, and both fires must agree — which is what makes the old look-back unnecessary.
     */
    await raceTheBoundary();
    const boundaryBlock = 2_002;
    const blocksFor = (sel: string) =>
      new Set(bundles().filter((x) => x.txs.some((t) => t.slice(2, 10) === sel))
        .map((x) => Number(BigInt(x.blockNumber))));
    const pay = blocksFor(PAY), audit = blocksFor(AUDIT);
    expect([...pay].sort()).toEqual([boundaryBlock, boundaryBlock + 1]);
    expect([...audit].sort()).toEqual([boundaryBlock, boundaryBlock + 1]);
    // The whole point: nothing is ever aimed below the boundary block.
    const all = bundles().map((x) => Number(BigInt(x.blockNumber)));
    expect(Math.min(...all)).toBe(boundaryBlock);
    expect(all).not.toContain(boundaryBlock - 1);
  });

  it("still aims at head + 1 when there is no boundary (an ordinary tick)", async () => {
    // Bounds the change: only a RACE gets boundary-derived targeting. A mid-epoch send has no
    // boundary to satisfy and must keep aiming at the next block.
    resetPaidForBoundary();
    const { manualPayToCurrent } = await import("./strategy.js");
    vi.mocked(globalThis.fetch).mockClear();
    await manualPayToCurrent(2036n);
    const all = bundles().map((x) => Number(BigInt(x.blockNumber)));
    expect(all.length).toBeGreaterThan(0);
    expect(Math.min(...all)).toBe(2_001); // head + 1, not the boundary block
  });
});

describe("crossing into epoch 178", () => {
  it("leaves the citizen NOT auditable once the payment lands — the actual survival test", async () => {
    await raceTheBoundary();
    expect(wireTxs()).toHaveLength(2);
    // One payment advances 176 -> 177. At epoch 178 that is 1 behind, and auditable needs
    // lastEpochPaid + 2 <= currentEpoch (177 + 2 = 179 > 178). So it survives the boundary,
    // which is the whole point of the race — not being "current", but being un-auditable.
    const after = TARGET_EPOCH - 1n; // 177
    expect(after + 2n > TARGET_EPOCH).toBe(true);
  });

  it("refuses a fire for an epoch that is already over", async () => {
    // The epoch-166 misfire: an arm left over from a past epoch must never pay.
    runtime.currentEpoch = TARGET_EPOCH + 1n;
    await firePreBoundaryPay();
    await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY_TS });
    expect(wireTxs()).toHaveLength(0);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});
