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
    // Used by findPreBoundaryAuditors (lastEpochPaid + auditLimit per owned token).
    // Default: every owned token is well-paid (lastEpochPaid huge, so never itself
    // auditable at any realistic targetEpoch) with auditLimit 1 — i.e. an eligible
    // auditor with one slot. Tests needing a different pool override this.
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n, // lastEpochPaid huge (current), auditLimit=1
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })), // 10 gwei
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
  queueCoinbaseBid: vi.fn(async () => false),
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
const { fetchOwnedTokenIds, fetchCandidateTokenIds } = await import("./index-tokens.js");
const { filterLiveTokenIds, batchGetTargetStatuses } = await import("./contract.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { startEngine, stopEngine, combinedBundleActive, fetchOffenseCandidates, queuePreBoundaryAudits } =
  await import("./strategy.js");

// combinedBundleActive is the single predicate that routes every pre-boundary
// pathway: true -> one fused pay+audit bundle (firePreBoundaryBundle), false ->
// the separate pay/audit schedulers (each keeps its mempool mirror). It must only
// fuse when a coinbase bid will actually fire, else bundle-only audits have no
// fallback. This truth table pins that so a refactor can't quietly re-introduce the
// no-bid footgun or flip the safe default.
describe("combinedBundleActive routing predicate", () => {
  const base = { ...DEFAULT_STRATEGY, coinbasePayerAddress: "0x00000000000000000000000000000000000000b1" };

  it("is false for the shipped default (combine on, no bid) — the safe no-op state", () => {
    expect(DEFAULT_STRATEGY.combinedBoundaryBundle).toBe(true); // on by default...
    expect(DEFAULT_STRATEGY.coinbaseBidEth).toBe(0); // ...but inert without a bid
    expect(combinedBundleActive(DEFAULT_STRATEGY)).toBe(false);
  });

  it("is true only when combine is on AND a bid is set AND a payer is present", () => {
    expect(combinedBundleActive({ ...base, combinedBoundaryBundle: true, coinbaseBidEth: 0.01 })).toBe(true);
  });

  it("is false when the bid is zero even if combine is on", () => {
    expect(combinedBundleActive({ ...base, combinedBoundaryBundle: true, coinbaseBidEth: 0 })).toBe(false);
  });

  it("is false when combine is off even if a bid is set", () => {
    expect(combinedBundleActive({ ...base, combinedBoundaryBundle: false, coinbaseBidEth: 0.01 })).toBe(false);
  });

  it("is false when a bid is set but no payer address is configured", () => {
    expect(combinedBundleActive({ ...base, combinedBoundaryBundle: true, coinbaseBidEth: 0.01, coinbasePayerAddress: "" })).toBe(false);
  });
});

// Regression: a pinned offense target whose tokenId sits past the enumeration cap
// (fetchCandidateTokenIds is tokenId-ordered and capped at maxCandidates) used to be
// sliced off BEFORE the pinned filter ran, so it was never scanned for audit — the
// token-1612-at-epoch-144 miss. fetchOffenseCandidates must scan pinned IDs directly,
// independent of what the (capped) full enumeration returns.
describe("fetchOffenseCandidates: pinned targets bypass the enumeration cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.strategy = { ...DEFAULT_STRATEGY };
    // Simulate a capped enumeration that only returns low IDs (as if the cap sliced
    // off everything past ~500). A high-ID pin must NOT depend on this set.
    vi.mocked(fetchCandidateTokenIds).mockResolvedValue([1n, 2n, 3n]);
    // filterLiveTokenIds echoes whatever IDs it's handed as live (owner = zero-ish).
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
  });

  it("scans exactly the pinned IDs (including ones past the cap) when a target list is set", async () => {
    runtime.strategy.offenseTargetTokenIds = ["1612", "6953"]; // both past the low enumeration
    const out = await fetchOffenseCandidates();
    const ids = out.map((t) => t.id.toString()).sort();
    expect(ids).toEqual(["1612", "6953"]);
    // Must NOT have fallen back to the capped full enumeration.
    expect(fetchCandidateTokenIds).not.toHaveBeenCalled();
  });

  it("falls back to the full enumeration when no targets are pinned", async () => {
    runtime.strategy.offenseTargetTokenIds = [];
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString()).sort()).toEqual(["1", "2", "3"]);
    expect(fetchCandidateTokenIds).toHaveBeenCalledTimes(1);
  });

  it("drops burned/killed pins (filterLiveTokenIds omits them) without error", async () => {
    runtime.strategy.offenseTargetTokenIds = ["1612", "9999"];
    // 9999 is burned: filterLiveTokenIds returns only the live one.
    vi.mocked(filterLiveTokenIds).mockResolvedValueOnce([
      { id: 1612n, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` },
    ]);
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString())).toEqual(["1612"]);
  });

  it("normalizes non-canonical pin strings so they still resolve to a live token", async () => {
    // Leading zero and hex forms must canonicalize to the same decimal ID the rest
    // of the pipeline speaks — otherwise they'd be scanned but skipped by the filter.
    runtime.strategy.offenseTargetTokenIds = ["01612", "0x64"]; // -> 1612 and 100
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString()).sort()).toEqual(["100", "1612"]);
  });

  it("ignores an unparseable pin without aborting the sweep", async () => {
    runtime.strategy.offenseTargetTokenIds = ["1612", "not-a-number"];
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString())).toEqual(["1612"]); // bad entry dropped, good one kept
  });
});

// End-to-end regression for the token-1612 miss: a pinned, high-ID rival that is
// delinquent LEADING INTO the next epoch (lastEpochPaid == targetEpoch-2, i.e. 2
// behind at the boundary) must actually get an audit QUEUED through the real
// pre-boundary path — not merely appear in the candidate list. This is the assertion
// that a future refactor of the enumeration/filter wiring can't silently re-break.
describe("queuePreBoundaryAudits: pinned high-ID delinquent rival gets an audit queued", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const TARGET_EPOCH = 144n;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.account = { address: ADDR } as unknown as PrivateKeyAccount;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n; // 10 ETH, well above the floor
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      dryRun: false,
      offenseEnabled: true,
      autoAudit: true,
      preBoundaryAudit: true,
      minBalanceEth: 0,
      maxPaymentEth: 0,
      offenseTargetTokenIds: ["1612"], // the pinned high-ID rival
    };
    // We own token #1 (our auditor). fetchOwnedTokenIds default mock returns [1n].
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    // #1612 is live.
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    // #1612 reads as 2-behind at the target epoch (auditable), not under audit.
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([
      {
        tokenId: "1612",
        owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (TARGET_EPOCH - 2n).toString(),
        delinquent: true,
        epochsBehind: 2,
        auditable: true,
        auditDueTimestamp: "0",
        killable: false,
      },
    ]);
  });

  it("queues exactly one audit of #1612 from our owned auditor token", async () => {
    const queued = await queuePreBoundaryAudits(ADDR, TARGET_EPOCH, 0n, 0n, { revertible: false });
    expect(queued).toBe(true);
    // The audit tx was actually submitted (encodeAudit calldata), value == AUDIT_COST_WEI.
    const auditCalls = vi.mocked(submitTx).mock.calls.filter(([intent]) => intent.data === "0xAUDIT");
    expect(auditCalls).toHaveLength(1);
  });

  it("does NOT queue when #1612 is paid up (not auditable at the boundary)", async () => {
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([
      {
        tokenId: "1612",
        owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: TARGET_EPOCH.toString(), // current -> not auditable
        delinquent: false,
        epochsBehind: 0,
        auditable: false,
        auditDueTimestamp: "0",
        killable: false,
      },
    ]);
    const queued = await queuePreBoundaryAudits(ADDR, TARGET_EPOCH, 0n, 0n, { revertible: false });
    expect(queued).toBe(false);
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT")).toHaveLength(0);
  });
});

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
