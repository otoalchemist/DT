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
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n })),
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
  // Balance is read through the cache now; mirror publicClient.getBalance's 10 ETH.
  getBalanceCached: vi.fn(async () => 10_000_000_000_000_000_000n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
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

vi.mock("./activity.js", () => {
  // add() must return an entry with a stable id: flushBatch keys its status updates
  // (submitted -> included/reverted) off entry.id.
  let n = 0;
  return {
    activity: {
      add: vi.fn(() => ({ id: `entry-${++n}` })),
      update: vi.fn(),
    },
  };
});

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

const { submitTx, queueCoinbaseBid, beginBundle, flushBundle } = await import("./flashbots.js");
const { fetchOwnedTokenIds, fetchCandidateTokenIds } = await import("./index-tokens.js");
const { filterLiveTokenIds, batchGetTargetStatuses, batchGetOwnedStatuses, encodeAudit, encodePayTaxes } = await import("./contract.js");
const { publicClient } = await import("./chain.js");
const { appConfig } = await import("./config.js");
const { activity } = await import("./activity.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { startEngine, stopEngine, combinedBundleActive, fetchOffenseCandidates, fetchOffenseCandidatesWithSkips, queuePreBoundaryAudits, firePreBoundaryBundle, resetJitState, scheduleAwayWake, clearAwayTimers } =
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

// Emigrated citizens (owner == the Emigration contract) have left the main game: they
// were swapped for a Governor NFT and the holding contract has no payTaxes/useBribe path,
// so they can neither defend nor act. Auditing one spends the 0.00069 ETH fee for nothing.
// fetchOffenseCandidates is the ONE chokepoint every offense sweep shares (offensePass,
// queuePreBoundaryAudits, firePreBoundaryKill), so filtering there is what keeps all three
// off them — these tests pin that, including the case where a pin emigrates mid-game.
describe("fetchOffenseCandidates: emigrated citizens leave the target set", () => {
  const EMIGRATION = "0xE56d011262d4738dC8307fb8a4Ae48B2bFc20E7C" as `0x${string}`;
  const RIVAL = "0x00000000000000000000000000000000000000dd" as `0x${string}`;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.strategy = { ...DEFAULT_STRATEGY };
    vi.mocked(fetchCandidateTokenIds).mockResolvedValue([1n, 2n, 3n]);
  });

  it("excludes tokens held by the Emigration contract from the enumerated sweep", async () => {
    vi.mocked(filterLiveTokenIds).mockResolvedValue([
      { id: 1n, owner: RIVAL },
      { id: 2n, owner: EMIGRATION }, // emigrated — still a live ERC-721, but out of the game
      { id: 3n, owner: RIVAL },
    ]);
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString()).sort()).toEqual(["1", "3"]);
  });

  it("excludes a PINNED target that has emigrated, and reports it as such", async () => {
    runtime.strategy.offenseTargetTokenIds = ["1612", "6953"];
    vi.mocked(filterLiveTokenIds).mockResolvedValue([
      { id: 1612n, owner: EMIGRATION }, // this pin left the game
      { id: 6953n, owner: RIVAL },
    ]);
    const { candidates, emigrated } = await fetchOffenseCandidatesWithSkips();
    expect(candidates.map((t) => t.id.toString())).toEqual(["6953"]);
    // Reported separately so the pinned-audit diagnostic can say "emigrated" rather
    // than blaming liveness ("burned/killed"), which would send you hunting a bug.
    expect([...emigrated]).toEqual(["1612"]);
  });

  it("matches the Emigration address case-insensitively", async () => {
    // Alchemy's owner index returns lowercase; ownerOf returns checksummed. A raw
    // string compare would silently keep emigrants in the target set for one of them.
    vi.mocked(filterLiveTokenIds).mockResolvedValue([
      { id: 1n, owner: EMIGRATION.toLowerCase() as `0x${string}` },
      { id: 2n, owner: RIVAL },
    ]);
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString())).toEqual(["2"]);
  });

  it("leaves the candidate set untouched when nothing has emigrated", async () => {
    vi.mocked(filterLiveTokenIds).mockResolvedValue([
      { id: 1n, owner: RIVAL },
      { id: 2n, owner: RIVAL },
    ]);
    const { candidates, emigrated } = await fetchOffenseCandidatesWithSkips();
    expect(candidates.map((t) => t.id.toString()).sort()).toEqual(["1", "2"]);
    expect(emigrated.size).toBe(0);
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

  it("an EXCLUDED citizen still audits — payment opt-out is not an offense opt-out", async () => {
    // excludedTokenIds means "never PAY this citizen". It must not remove it from the
    // auditor pool: an unchecked citizen should still spend its full auditLimit on
    // rivals. (Its eligibility still lapses on its own once it drifts 2+ epochs behind,
    // because the contract forbids an auditable token from auditing — but that's the
    // game's rule, not an exclusion effect.)
    runtime.strategy = { ...runtime.strategy, excludedTokenIds: ["1"] };
    const queued = await queuePreBoundaryAudits(ADDR, TARGET_EPOCH, 0n, 0n, { revertible: false });
    expect(queued).toBe(true);
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT")).toHaveLength(1);
    // ...and it audited FROM the excluded token #1.
    expect(vi.mocked(encodeAudit).mock.calls.map(([from]) => String(from))).toContain("1");
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

// A multi-citizen wallet is the case where the combined boundary bundle has the most
// to get wrong: payments and audits share one bundle and one nonce sequence, audit
// capacity is PER citizen (auditLimit), and the coinbase bid must be paid ONCE for
// the whole bundle rather than once per tx. This pins all three together.
describe("combined boundary bundle with multiple citizens", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const TARGET_EPOCH = 200n;
  const PAYER = "0x00000000000000000000000000000000000000b1";

  // Owned citizens and their per-token audit capacity. Total capacity = 2+1+1 = 4.
  // Each is 1 epoch behind at the target epoch: still an ELIGIBLE auditor (only 2+
  // behind disqualifies) AND owing a payment, so every citizen exercises both halves
  // of the bundle at once.
  const LIMITS: Record<string, bigint> = { "10": 2n, "20": 1n, "30": 1n };
  const OWNED = [10n, 20n, 30n];
  const TOTAL_CAPACITY = 4;

  // More auditable rivals than we have capacity for, so the capacity cap is what
  // bounds the audits (not simply running out of targets).
  const RIVALS = ["501", "502", "503", "504", "505", "506"];

  beforeEach(() => {
    vi.clearAllMocks();
    // `unlocked` is a getter derived from `account`, so setting the account is what
    // makes the wallet read as unlocked.
    runtime.account = { address: ADDR } as unknown as PrivateKeyAccount;
    runtime.running = true;
    runtime.gameState = 1; // LIVE
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.balanceWei = 100_000_000_000_000_000_000n; // 100 ETH
    runtime.citizenSupply = 500n;
    runtime.currentEpoch = TARGET_EPOCH - 1n;
    runtime.startTime = 0n;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      offenseEnabled: true,
      autoAudit: true,
      preBoundaryAudit: true,
      preBoundaryPay: true,
      jitEnabled: true,
      jitTargetEpoch: Number(TARGET_EPOCH),
      jitTokenIds: [],
      minBalanceEth: 0,
      maxPaymentEth: 0,
      maxBaseFeeGwei: 1000,
      endgameOnlyWithin: null,
      // Combined bundle requires a bid + payer to actually fuse.
      combinedBoundaryBundle: true,
      coinbaseBidEth: 0.02,
      coinbasePayerAddress: PAYER,
      offenseTargetTokenIds: RIVALS,
    };

    vi.mocked(fetchOwnedTokenIds).mockResolvedValue(OWNED);
    // Per-token multicall: auditLimit from LIMITS, lastEpochPaid = 1 behind the target.
    // lastEpochPaid = 1 behind (owes a payment, still auditor-eligible), auditLimit per
    // LIMITS, and auditDueTimestamp 0 = NOT under audit (an audited citizen is never
    // auto-paid, so a nonzero value here would correctly suppress every payment).
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit"
            ? (LIMITS[String(c.args[0])] ?? 1n)
            : c.functionName === "auditDueTimestamp"
              ? 0n
              : TARGET_EPOCH - 1n,
      })) ) as never);
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    // Every rival is 2 behind at the target epoch -> auditable, none under audit.
    vi.mocked(batchGetTargetStatuses).mockResolvedValue(
      RIVALS.map((tokenId) => ({
        tokenId,
        owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (TARGET_EPOCH - 2n).toString(),
        delinquent: true,
        epochsBehind: 2,
        auditable: true,
        auditDueTimestamp: "0",
        killable: false,
      })),
    );
  });

  afterEach(() => {
    runtime.account = null;
    runtime.running = false;
    // Restore the module-level mock behaviour. vi.clearAllMocks() (used by later
    // describes) resets call history but NOT implementations, so without this the
    // rivals/auditors staged here leak forward and make unrelated tests submit audits.
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
      })) ) as never);
  });

  it("fuses payments for every citizen and audits into ONE bundle with ONE coinbase bid", async () => {
    await firePreBoundaryBundle();

    const pays = vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES");
    const audits = vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT");

    // One payment per owned citizen (each is 1 epoch behind).
    expect(pays).toHaveLength(OWNED.length);
    // Audits are bounded by total auditor capacity, not by the 6 available rivals.
    expect(audits).toHaveLength(TOTAL_CAPACITY);

    // Exactly ONE coinbase bid for the whole bundle — not one per payment, per audit,
    // or per citizen. This is the property that makes a multi-citizen boundary
    // affordable: the bid buys position for everything fused into the bundle.
    expect(vi.mocked(queueCoinbaseBid)).toHaveBeenCalledTimes(1);
    // ...for the configured amount, once.
    expect(vi.mocked(queueCoinbaseBid).mock.calls[0]?.[1]).toBe(20_000_000_000_000_000n); // 0.02 ETH
  });

  it("respects each citizen's auditLimit — no token audits more than its capacity", async () => {
    await firePreBoundaryBundle();

    // encodeAudit(fromTokenId, targetTokenId) records which auditor backed each audit.
    const usedBy: Record<string, number> = {};
    for (const [from] of vi.mocked(encodeAudit).mock.calls) {
      usedBy[String(from)] = (usedBy[String(from)] ?? 0) + 1;
    }
    for (const [tokenId, limit] of Object.entries(LIMITS)) {
      expect(usedBy[tokenId] ?? 0).toBeLessThanOrEqual(Number(limit));
    }
    // The multi-slot citizen actually used BOTH of its slots — capacity is spent, not
    // capped at one audit per token.
    expect(usedBy["10"]).toBe(2);
    // Total across all auditors equals the pool.
    expect(Object.values(usedBy).reduce((a, b) => a + b, 0)).toBe(TOTAL_CAPACITY);
  });

  it("audits distinct rivals — capacity is never spent twice on the same target", async () => {
    await firePreBoundaryBundle();
    const targets = vi.mocked(encodeAudit).mock.calls.map(([, target]) => String(target));
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toHaveLength(TOTAL_CAPACITY);
  });

  it("pays every citizen BEFORE any audit, so a just-paid auditor is current on-chain", async () => {
    await firePreBoundaryBundle();
    const order = vi
      .mocked(submitTx)
      .mock.calls.map(([i]) => i.data)
      .filter((d) => d === "0xPAYTAXES" || d === "0xAUDIT");
    const lastPay = order.lastIndexOf("0xPAYTAXES");
    const firstAudit = order.indexOf("0xAUDIT");
    expect(firstAudit).toBeGreaterThan(lastPay);
  });

  it("still fires ONE bid when there is nothing to pay (audit-only boundary)", async () => {
    // Every citizen already current for the target epoch -> no payments owed.
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? (LIMITS[String(c.args[0])] ?? 1n) : c.functionName === "auditDueTimestamp" ? 0n : TARGET_EPOCH,
      })) ) as never);

    await firePreBoundaryBundle();

    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES")).toHaveLength(0);
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT")).toHaveLength(TOTAL_CAPACITY);
    expect(vi.mocked(queueCoinbaseBid)).toHaveBeenCalledTimes(1);
  });

  it("does NOT bid when the bundle ends up empty (no payments, no audits)", async () => {
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]); // no auditable rivals
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : c.functionName === "auditDueTimestamp" ? 0n : TARGET_EPOCH, // current -> nothing owed
      })) ) as never);

    await firePreBoundaryBundle();

    expect(vi.mocked(submitTx)).not.toHaveBeenCalled();
    expect(vi.mocked(queueCoinbaseBid)).not.toHaveBeenCalled();
  });
});

// An audited citizen must NEVER be paid automatically — catching up after an audit is
// the user's decision (the manual "Pay to current" button). Regression guard: this used
// to auto-pay any audited owned token within a safety buffer, ignoring the JIT
// checkboxes entirely, which paid a citizen the user had unchecked.
describe("audited citizens are never auto-paid", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;

  beforeEach(() => {
    vi.clearAllMocks();
    // jitSubmitted is module-level and persists across tests at the same target epoch,
    // so clear it or a citizen marked by an earlier test leaks in and skews the disarm.
    resetJitState();
    runtime.account = { address: ADDR } as unknown as PrivateKeyAccount;
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n;
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
        estimatedPayWei: "1000000000000000",
      },
    ]);
  });

  afterEach(() => {
    runtime.account = null;
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
        estimatedPayWei: "1000000000000000",
      })) as never,
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
      enabled: true, offenseEnabled: false,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [],
    };
    const { jitPass } = await import("./strategy.js");
    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES")).toHaveLength(0);
  });

  it("never spends a bribe automatically, for any citizen", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, enabled: true, offenseEnabled: false,
      jitEnabled: true, jitTargetEpoch: 150,
    };
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([
      {
        tokenId: "1", lastEpochPaid: "148", currentEpoch: "150",
        auditDueTimestamp: String(Math.floor(Date.now() / 1000) + 600),
        secondsUntilKillable: 600, bribeBalance: "5", hasLifeInsurance: false,
        risk: "at-risk", estimatedPayWei: "1000000000000000",
      },
    ]);
    const { jitPass } = await import("./strategy.js");
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
      enabled: true, offenseEnabled: false,
      jitEnabled: true, jitTargetEpoch: 150, jitTokenIds: [], excludedTokenIds: [],
    };
    vi.mocked(batchGetOwnedStatuses).mockResolvedValue([
      {
        tokenId: "1", lastEpochPaid: "149", currentEpoch: "150",
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000",
      },
    ]);
    // Submission fails (e.g. sim revert): ok:false, but still a non-null result.
    vi.mocked(submitTx).mockResolvedValueOnce({
      ok: false, simulated: true, error: "sim revert", nonce: 0, valueWei: 0n, gasWei: 0n,
    } as never);
    const { jitPass } = await import("./strategy.js");
    const saveSpy = vi.spyOn(runtime, "saveStrategy");
    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    // Must NOT have disarmed — the citizen still needs paying.
    const disarmed = saveSpy.mock.calls.some(([patch]) => (patch as any).jitEnabled === false);
    expect(disarmed).toBe(false);
    saveSpy.mockRestore();
  });

  it("skips an excluded citizen on the JIT path", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, enabled: true, offenseEnabled: false,
      jitEnabled: true, jitTargetEpoch: 150, excludedTokenIds: ["1"],
    };
    const { jitPass } = await import("./strategy.js");
    await jitPass([1n], 150n, BigInt(Math.floor(Date.now() / 1000)));
    expect(vi.mocked(submitTx)).not.toHaveBeenCalled();
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
    runtime.account = { address: ADDR } as unknown as PrivateKeyAccount;
    runtime.startTime = START;
    runtime.running = false;
    runtime.awayNextWakeSec = null;
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true, awayLeadMinutes: 15, offenseEnabled: true, jitEnabled: false };
  });

  afterEach(() => {
    clearAwayTimers();
    vi.useRealTimers();
    runtime.account = null;
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

  it("stays dark when there is nothing to wake for (no JIT armed, offense off)", () => {
    runtime.strategy = { ...runtime.strategy, offenseEnabled: false, jitEnabled: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  it("arms for an armed JIT payment even with offense off", () => {
    runtime.strategy = { ...runtime.strategy, offenseEnabled: false, jitEnabled: true, jitTargetEpoch: 151 };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).not.toBeNull();
  });

  it("does not arm while the wallet is locked — it could not submit anything anyway", () => {
    runtime.account = null;
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
    runtime.account = null; // locked in the meantime — nothing could be submitted anyway
    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.running).toBe(false);
  });

  it("wakes immediately when already inside the lead window", () => {
    vi.setSystemTime(Number(START + EPOCH * 151n - 60n) * 1000); // 1 min before boundary
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n - 60n)); // = now
  });
});

// Regression: a bundle-only tx sat on "submitted" in the activity log forever, even
// after it demonstrably landed on-chain. Payments mirror to the public mempool so they
// come back with a broadcast txHash and get receipt-tracked; a revertible audit riding
// the combined bundle is never broadcast, so it had no hash and nothing was polled.
// The hash is derivable without broadcasting (keccak of the signed tx — flushBundle
// already computes exactly that for revertingTxHashes), so both kinds must now resolve.
describe("bundle-only txs still resolve submitted -> included", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const TARGET_EPOCH = 200n;
  const PAYER = "0x00000000000000000000000000000000000000b1";
  const MIRRORED_HASH = "0xbroadcast" as const;
  const PREDICTED_HASH = "0xpredicted" as const;

  let priorMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    priorMode = (appConfig as { mode?: string }).mode;
    // flushBatch is a no-op outside mainnet — batching (and thus bundle-only txs)
    // only exists there.
    (appConfig as { mode?: string }).mode = "mainnet";

    runtime.account = { address: ADDR } as unknown as PrivateKeyAccount;
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.balanceWei = 100_000_000_000_000_000_000n;
    runtime.citizenSupply = 500n;
    runtime.currentEpoch = TARGET_EPOCH - 1n;
    runtime.startTime = 0n;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      offenseEnabled: true,
      autoAudit: true,
      preBoundaryAudit: true,
      preBoundaryPay: true,
      jitEnabled: true,
      jitTargetEpoch: Number(TARGET_EPOCH),
      jitTokenIds: [],
      minBalanceEth: 0,
      maxPaymentEth: 0,
      maxBaseFeeGwei: 1000,
      endgameOnlyWithin: null,
      combinedBoundaryBundle: true,
      coinbaseBidEth: 0.02,
      coinbasePayerAddress: PAYER,
      offenseTargetTokenIds: ["501"],
    };

    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : TARGET_EPOCH - 1n,
      })) ) as never);
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([
      {
        tokenId: "501",
        owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (TARGET_EPOCH - 2n).toString(),
        delinquent: true,
        epochsBehind: 2,
        auditable: true,
        auditDueTimestamp: "0",
        killable: false,
      },
    ]);

    // Every tx defers into the batch, each on its own nonce.
    let nonce = 0;
    vi.mocked(submitTx).mockImplementation((async (intent: { value: bigint }) => ({
      ok: true, simulated: false, queued: true, nonce: nonce++, valueWei: intent.value, gasWei: 0n,
    })) as never);
    vi.mocked(queueCoinbaseBid).mockResolvedValue(true);
  });

  afterEach(() => {
    (appConfig as { mode?: string }).mode = priorMode;
    runtime.account = null;
    runtime.running = false;
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(queueCoinbaseBid).mockResolvedValue(false);
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({ status: "success", blockNumber: 101n } as never);
    vi.mocked(submitTx).mockImplementation((async (intent: { value: bigint }) => ({
      ok: true, simulated: false, txHash: "0xhash", nonce: 0, valueWei: intent.value, gasWei: 0n,
    })) as never);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
      })) ) as never);
  });

  // Let the fire-and-forget trackReceipt promises settle.
  const settle = () => new Promise((r) => setImmediate(r));

  it("polls the locally-derived hash for a tx that was never broadcast", async () => {
    // nonce 0 mirrored (a payment), nonce 1 bundle-only (the audit): no txHash, but a
    // predictedTxHash is always present.
    vi.mocked(flushBundle).mockResolvedValue(
      new Map<number, any>([
        [0, { ok: true, txHash: MIRRORED_HASH, predictedTxHash: MIRRORED_HASH, bundleHash: "0xbundle" }],
        [1, { ok: true, predictedTxHash: PREDICTED_HASH, bundleHash: "0xbundle" }],
      ]) as never,
    );

    await firePreBoundaryBundle();
    await settle();

    const polled = vi.mocked(publicClient.waitForTransactionReceipt).mock.calls.map(([a]: any) => a.hash);
    expect(polled).toContain(MIRRORED_HASH);
    // The regression: this used to be absent, so the entry never left "submitted".
    expect(polled).toContain(PREDICTED_HASH);
  });

  it("flips the bundle-only entry to included and only then attaches its tx hash", async () => {
    vi.mocked(flushBundle).mockResolvedValue(
      new Map<number, any>([
        [1, { ok: true, predictedTxHash: PREDICTED_HASH, bundleHash: "0xbundle" }],
      ]) as never,
    );

    await firePreBoundaryBundle();
    await settle();

    const patches = vi.mocked(activity.update).mock.calls.map(([, p]) => p);

    // The first patch marks it submitted and carries NO txHash — the derived hash is
    // only a prediction until a builder wins the slot, so linking it that early would
    // point at a tx that may never exist.
    const submitted = patches.find((p) => p.status === "submitted");
    expect(submitted).toBeDefined();
    expect(submitted?.txHash).toBeUndefined();

    // Once the receipt confirms it landed, the hash is real and gets attached.
    expect(patches.at(-1)).toMatchObject({ status: "included", txHash: PREDICTED_HASH, targetBlock: "101" });
  });

  it("marks it reverted when the receipt says the tx failed", async () => {
    vi.mocked(flushBundle).mockResolvedValue(
      new Map<number, any>([
        [1, { ok: true, predictedTxHash: PREDICTED_HASH, bundleHash: "0xbundle" }],
      ]) as never,
    );
    vi.mocked(publicClient.waitForTransactionReceipt).mockResolvedValue({ status: "reverted", blockNumber: 101n } as never);

    await firePreBoundaryBundle();
    await settle();

    expect(vi.mocked(activity.update).mock.calls.at(-1)?.[1]).toMatchObject({ status: "reverted" });
  });

  it("leaves the entry submitted when the bundle never lands (receipt times out)", async () => {
    vi.mocked(flushBundle).mockResolvedValue(
      new Map<number, any>([
        [1, { ok: true, predictedTxHash: PREDICTED_HASH, bundleHash: "0xbundle" }],
      ]) as never,
    );
    vi.mocked(publicClient.waitForTransactionReceipt).mockRejectedValue(new Error("timed out"));

    await firePreBoundaryBundle();
    await settle();

    // No status past "submitted" — and crucially no txHash was ever attached, so the UI
    // cannot link to a tx that was never mined.
    for (const [, patch] of vi.mocked(activity.update).mock.calls) {
      expect(patch.status).not.toBe("included");
      expect(patch.txHash).toBeUndefined();
    }
  });
});
