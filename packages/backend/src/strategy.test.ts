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
  // Per-address registry. The real one hands each wallet its own counter; the tests
  // only need the calls to be inert.
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
  // Telemetry hook (race-timing.ts) — a no-op here, but it must exist on the mock or every
  // pre-boundary fire throws before doing any work.
  setRaceBoundary: vi.fn(),
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
const { filterLiveTokenIds, batchGetTargetStatuses, batchGetOwnedStatuses, encodeAudit, encodePayTaxes, estimateTaxes } = await import("./contract.js");
const { publicClient, getBalanceCached } = await import("./chain.js");
const { appConfig } = await import("./config.js");
const { activity } = await import("./activity.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");

/** Install a single unlocked wallet — the shape these tests were written against.
 *  Multi-wallet routing has its own describe below. */
function useWallet(account: unknown, balanceWei: bigint | null = null): void {
  runtime.setWallets([{ account: account as never, label: "test", balanceWei }]);
}
/** Set the balance on every installed test wallet. */
function setTestBalance(wei: bigint | null): void {
  for (const w of runtime.wallets) w.balanceWei = wei;
}
const { startEngine, stopEngine, combinedBundleActive, coinbaseBidActive, firePreBoundaryAudit, fetchOffenseCandidates, fetchOffenseCandidatesWithSkips, queuePreBoundaryAudits, firePreBoundaryBundle, firePreBoundaryPay, maybeAutoArmPayment, maybeAutoDefendAudit, resetDefenseState, resetTickBudget, jitPass, fetchOwnedAcrossWallets, schedulePreBoundaryBundle, manualPayToCurrent, resetJitState, scheduleAwayWake, clearAwayTimers } =
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

// The "do not target" roster (data/do-not-target.json) is ADVICE, not a prohibition — the
// opposite of the ally list. It keeps big-boy operators out of auto-discovery, where an
// audit slot would be wasted on a target that cures at index 0, but an explicit pin in the
// Strategy targets box has to override it: deciding a big boy is worth attacking today is
// the user's call, and the roster can't make it. Getting this backwards would silently
// swallow a deliberate order.
describe("fetchOffenseCandidates: do-not-target is advice, pins override it", () => {
  const RIVAL = "0x00000000000000000000000000000000000000dd" as `0x${string}`;
  const LISTED = "4335";   // Graveyard
  const UNLISTED = "1612";
  let tmpDir: string;
  let priorDataDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dat-dnt-"));
    fs.writeFileSync(
      nodePath.join(tmpDir, "do-not-target.json"),
      JSON.stringify({ owners: { Graveyard: [LISTED, "909"] } }),
    );
    priorDataDir = (appConfig as { dataDir: string }).dataDir;
    (appConfig as { dataDir: string }).dataDir = tmpDir;

    useWallet({ address: "0x1111111111111111111111111111111111111111" } as unknown as PrivateKeyAccount);
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.strategy = { ...DEFAULT_STRATEGY, offenseEnabled: true, offenseTargetTokenIds: [] };
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: RIVAL })),
    );
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    (appConfig as { dataDir: string }).dataDir = priorDataDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    runtime.setWallets([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(fetchCandidateTokenIds).mockResolvedValue([]);
  });

  it("drops a listed rival that only turns up through auto-discovery", async () => {
    vi.mocked(fetchCandidateTokenIds).mockResolvedValue([BigInt(LISTED), BigInt(UNLISTED)]);
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString())).toEqual([UNLISTED]);
  });

  it("KEEPS a listed rival that the user pinned by hand", async () => {
    runtime.strategy.offenseTargetTokenIds = [LISTED];
    const out = await fetchOffenseCandidates();
    // The whole point: an explicit pin still gets audited.
    expect(out.map((t) => t.id.toString())).toEqual([LISTED]);
  });

  it("keeps pinned listed rivals alongside unlisted ones", async () => {
    runtime.strategy.offenseTargetTokenIds = [LISTED, UNLISTED];
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString()).sort()).toEqual([UNLISTED, LISTED].sort());
  });

  it("still drops an ALLY even when pinned — that block is absolute", async () => {
    // Contrast with the roster: attacking a teammate is never an intended instruction, so
    // a pin must not be able to authorise it.
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    fs.writeFileSync(nodePath.join(tmpDir, "ally-tokens.json"), JSON.stringify([UNLISTED]));
    runtime.strategy.offenseTargetTokenIds = [UNLISTED, LISTED];
    const out = await fetchOffenseCandidates();
    expect(out.map((t) => t.id.toString())).toEqual([LISTED]);
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
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    setTestBalance(10_000_000_000_000_000_000n); // 10 ETH, well above the floor
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
    const queued = await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
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
    const queued = await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
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
    const queued = await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
    expect(queued).toBe(false);
    expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT")).toHaveLength(0);
  });

  // The base fee being over cap is a property of the BLOCK, so it fails identically for
  // every candidate. It used to be re-checked once per target, which meant the loop awaited
  // its way through the whole list submitting nothing — hundreds of sequential awaits per
  // tick with offense unpinned, and in this pre-boundary path it burned the very lead
  // window the race depends on. The guard now reports `fatal` so the loop stops at the
  // first one.
  //
  // The fee override has to be undone: getLatestBlockCached is a module-level mock shared
  // by every test in this file, so leaving it at 500 gwei makes every later spend check
  // fail. Restored to the 10 gwei default in a local afterEach.
  describe("base-fee cap short-circuits the sweep", () => {
    const NORMAL_BLOCK = {
      baseFeePerGas: 10_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n,
    };

    afterEach(async () => {
      const { getLatestBlockCached } = await import("./chain.js");
      vi.mocked(getLatestBlockCached).mockResolvedValue(
        NORMAL_BLOCK as unknown as Awaited<ReturnType<typeof getLatestBlockCached>>,
      );
    });

    it("stops at the first target when the base fee is over cap, instead of scanning them all", async () => {
      const { getLatestBlockCached } = await import("./chain.js");
      // 500 gwei, far above the 69.1 default cap.
      vi.mocked(getLatestBlockCached).mockResolvedValue({
        ...NORMAL_BLOCK, baseFeePerGas: 500_000_000_000n,
      } as unknown as Awaited<ReturnType<typeof getLatestBlockCached>>);

      // Ten auditable pinned rivals, and enough auditor slots that capacity isn't the limit.
      const many = Array.from({ length: 10 }, (_, i) => `${2000 + i}`);
      runtime.strategy = { ...runtime.strategy, offenseTargetTokenIds: many };
      vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n, 2n, 3n]);
      vi.mocked(batchGetTargetStatuses).mockResolvedValue(
        many.map((tokenId) => ({
          tokenId,
          owner: "0x00000000000000000000000000000000000000dd" as `0x${string}`,
          lastEpochPaid: (TARGET_EPOCH - 2n).toString(),
          delinquent: true,
          epochsBehind: 2,
          auditable: true,
          auditDueTimestamp: "0",
          killable: false,
        })),
      );

      const queued = await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
      expect(queued).toBe(false);
      // Nothing submitted (the point of the cap) ...
      expect(vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xAUDIT")).toHaveLength(0);
      // ...and the block was read ONCE, not once per rival. Before the fix this was 10.
      expect(vi.mocked(getLatestBlockCached).mock.calls.length).toBe(1);
    });

    it("still considers every candidate when the failure is per-wallet, not per-block", async () => {
      // Contrast with the fee cap: an unaffordable wallet says nothing about the next
      // candidate, which may be held by a funded one — so the sweep must NOT stop.
      const { getLatestBlockCached } = await import("./chain.js");
      vi.mocked(getLatestBlockCached).mockResolvedValue(
        NORMAL_BLOCK as unknown as Awaited<ReturnType<typeof getLatestBlockCached>>,
      );
      setTestBalance(0n); // below the floor
      runtime.strategy = { ...runtime.strategy, minBalanceEth: 1, offenseTargetTokenIds: ["1612", "1613"] };
      vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n, 2n]);
      vi.mocked(batchGetTargetStatuses).mockResolvedValue(
        ["1612", "1613"].map((tokenId) => ({
          tokenId,
          owner: "0x00000000000000000000000000000000000000dd" as `0x${string}`,
          lastEpochPaid: (TARGET_EPOCH - 2n).toString(),
          delinquent: true,
          epochsBehind: 2,
          auditable: true,
          auditDueTimestamp: "0",
          killable: false,
        })),
      );
      await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
      // Both candidates were considered — the loop continued rather than breaking out.
      expect(vi.mocked(getLatestBlockCached).mock.calls.length).toBe(2);
    });
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
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.running = true;
    runtime.gameState = 1; // LIVE
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    setTestBalance(100_000_000_000_000_000_000n); // 100 ETH
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
      // Deliberately different so a test can tell WHICH bid fired, not just that one did.
      coinbaseBidAuditOnlyEth: 0.005,
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
    runtime.setWallets([]);
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

// The whole reason payments and audits may share a bundle: a Flashbots bundle is
  // atomic, so a reverting audit would normally invalidate it and take the PAYMENT down
  // too — losing a citizen its tax at the exact boundary it needed it. flushBundle builds
  // revertingTxHashes from the `revertible` flag, so this is the flag that decides it.
  it("keeps a failed audit from dropping the payments, and one bad payment from dropping its siblings", async () => {
    await firePreBoundaryBundle();

    const opts = (data: string) =>
      vi.mocked(submitTx).mock.calls
        .filter(([i]) => (i as { data: string }).data === data)
        .map(([, o]) => o as { revertible?: boolean; race?: boolean });

    const pays = opts("0xPAYTAXES");
    const audits = opts("0xAUDIT");
    expect(pays.length).toBeGreaterThan(1); // 3 citizens here, so siblings exist
    expect(audits.length).toBeGreaterThan(0);

    // Audits ARE revertible -> a defended or already-audited target reverts harmlessly
    // beside the payments instead of invalidating the bundle. Unchanged guarantee.
    for (const a of audits) expect(a.revertible).toBe(true);

    // Payments are ALSO revertible once there are siblings to protect. This used to assert
    // the opposite: payments were mandatory, so ONE citizen reverting in-block
    // (AlreadyCurrent, or audited earlier in the same block) dropped the whole bundle and
    // sent every healthy payment to the mempool — missing the boundary block, which is
    // where ~10 rival audits land against citizens exactly 2 epochs behind.
    for (const p of pays) expect(p.revertible).toBe(true);

    // ...and they KEEP the mempool mirror, which is what makes that safe. Revert-tolerant
    // WITHOUT a mirror would turn "lands a block late" into "never lands".
    for (const p of pays) expect(p.race).toBe(true);
  });

  it("orders payments BEFORE audits, so a paid citizen is current when it audits", async () => {
    await firePreBoundaryBundle();

    // A bundle executes in nonce order (flushBundle sorts on it), so the payment's nonce
    // must be lower than every audit's. This is also what lets a just-paid token serve as
    // an auditor in the same bundle while the chain still reads it as behind.
    const order = vi.mocked(submitTx).mock.calls.map(([i]) => (i as { data: string }).data);
    const lastPay = order.lastIndexOf("0xPAYTAXES");
    const firstAudit = order.indexOf("0xAUDIT");
    expect(lastPay).toBeGreaterThanOrEqual(0);
    expect(firstAudit).toBeGreaterThanOrEqual(0);
    expect(lastPay).toBeLessThan(firstAudit);
  });

  it("keeps audits revert-tolerant even when NO payment is due", async () => {
    // Nothing to pay this boundary (JIT not armed for it), so there is no payment to
    // protect — but a coinbase bid still rides the bundle, and a doomed audit must not
    // invalidate it and take the bid down. Same failure that cost an ally an epoch.
    runtime.strategy = { ...runtime.strategy, jitEnabled: false, jitTargetEpoch: null };
    await firePreBoundaryBundle();

    const audits = vi.mocked(submitTx).mock.calls
      .filter(([i]) => (i as { data: string }).data === "0xAUDIT")
      .map(([, o]) => o as { revertible?: boolean });
    const pays = vi.mocked(submitTx).mock.calls.filter(([i]) => (i as { data: string }).data === "0xPAYTAXES");

    expect(pays).toHaveLength(0);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a.revertible).toBe(true);
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
    // ...and it must be the AUDIT-ONLY bid (0.005), not the payment bid (0.02). Which
    // amount fires is decided by what actually got queued, not by what was configured.
    expect(vi.mocked(queueCoinbaseBid).mock.calls[0]?.[1]).toBe(5_000_000_000_000_000n);
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

  // REGRESSION (epoch 162, tx 0x2090097f…494c): the payment landed at index 0 of the block
  // AFTER the boundary instead of in the boundary block, and the activity log showed no
  // pre-boundary entry at all — not even a failure.
  //
  // Cause: the bundle fire derives its target from LIVE state at fire time
  // (`runtime.currentEpoch + 1`), but the payment gate compares that against the epoch the
  // JIT arm was made FOR. The fire is delayed whenever a tick is in flight
  // (`if (ticking) retry in 150ms`), and a WS tick runs on every ~12s block, so a fire armed
  // for boundary-5s can slip past the boundary. Once a post-boundary tick refreshes
  // currentEpoch, targetEpoch becomes jitTargetEpoch+1 and the equality gate silently
  // drops the payment — the one thing the race existed to send.
  it("still pays the ARMED epoch when the fire slips past the boundary", async () => {
    // The engine has already seen the new epoch: currentEpoch advanced to the epoch that
    // JIT is armed FOR, so `currentEpoch + 1` is now one PAST the armed target.
    runtime.currentEpoch = TARGET_EPOCH;
    runtime.strategy = { ...runtime.strategy, jitTargetEpoch: Number(TARGET_EPOCH) };

    await firePreBoundaryBundle();

    // The armed payment must still go out. Before the fix this was 0: the gate compared
    // 162 === 163 and dropped it without a word.
    const pays = vi.mocked(submitTx).mock.calls.filter(([i]) => i.data === "0xPAYTAXES");
    expect(pays.length).toBeGreaterThan(0);
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
        estimatedPayWei: "1000000000000000",
      },
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

    useWallet(FAKE_ACCOUNT);
    runtime.running = false;
    setTestBalance(null);
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
    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.startTime = START;
    runtime.running = false;
    runtime.awayNextWakeSec = null;
    runtime.strategy = { ...DEFAULT_STRATEGY, awayMode: true, awayLeadMinutes: 15, offenseEnabled: true, jitEnabled: false };
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

  it("stays dark when there is nothing to wake for (no JIT armed, offense off)", () => {
    runtime.strategy = { ...runtime.strategy, offenseEnabled: false, jitEnabled: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBeNull();
  });

  // POST /api/jit sets `enabled` alongside jitEnabled, so that pairing is the real armed
  // state — and it has to be, since jitPass itself is gated on `enabled`.
  it("arms for an armed JIT payment even with offense off", () => {
    runtime.strategy = { ...runtime.strategy, offenseEnabled: false, enabled: true, jitEnabled: true, jitTargetEpoch: 151, proactivePay: false };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).not.toBeNull();
  });

  // Away mode must wake for anything a RUNNING engine would do at the boundary. Proactive
  // pay is the standing pre-audit defense of owned citizens and survives a JIT disarm, so
  // missing it here would silently stop paying them the moment offense was switched off.
  it("arms for proactive pay alone — no JIT armed, offense off", () => {
    runtime.strategy = {
      ...runtime.strategy,
      offenseEnabled: false, jitEnabled: false, jitTargetEpoch: null,
      enabled: true, proactivePay: true,
    };
    scheduleAwayWake();
    expect(runtime.awayNextWakeSec).toBe(Number(START + EPOCH * 151n) - 15 * 60);
  });

  it("stays dark when payment is off entirely", () => {
    runtime.strategy = {
      ...runtime.strategy,
      offenseEnabled: false, jitEnabled: false, jitTargetEpoch: null,
      enabled: false, proactivePay: true,
    };
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
      offenseEnabled: true,
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

    useWallet({ address: ADDR } as unknown as PrivateKeyAccount);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    setTestBalance(100_000_000_000_000_000_000n);
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
    runtime.setWallets([]);
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
      offenseEnabled: true, autoAudit: true, preBoundaryAudit: true, preBoundaryPay: true,
      jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: [],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, endgameOnlyWithin: null,
      combinedBoundaryBundle: false, coinbaseBidEth: 0,
      offenseTargetTokenIds: ["501"],
    };

    // Ownership is per-address: each wallet sees only its own citizen.
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) =>
      OWNED[addr.toLowerCase()] ?? [],
    );
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
        tokenId: "501", owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (TARGET_EPOCH - 2n).toString(), delinquent: true, epochsBehind: 2,
        auditable: true, auditDueTimestamp: "0", killable: false,
      },
    ]);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
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

  it("signs an audit with the wallet holding the AUDITOR token, not the primary", async () => {
    // Only wallet B's citizen is an eligible auditor, so the audit must come from B even
    // though A is primary. Getting this wrong reverts on-chain: audit is owner-only on
    // the auditor token.
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) =>
      addr.toLowerCase() === B.toLowerCase() ? [20n] : [],
    );
    await queuePreBoundaryAudits(TARGET_EPOCH, 0n, 0n, { revertible: false });
    const audits = signersByData().filter((c) => c.data === "0xAUDIT");
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a.signer).toBe(B);
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
describe("pre-boundary audit-only fire: revert-tolerance follows the coinbase bid", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const PAYER = "0x00000000000000000000000000000000000000b1";
  const CURRENT = 200n;

  const base = {
    ...DEFAULT_STRATEGY,
    offenseEnabled: true,
    autoAudit: true,
    preBoundaryAudit: true,
    racePublicMempool: true,
    minBalanceEth: 0,
    maxBaseFeeGwei: 1000,
    endgameOnlyWithin: null,
    offenseTargetTokenIds: ["501"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.citizenSupply = 500n;
    runtime.currentEpoch = CURRENT;
    runtime.startTime = 0n;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : CURRENT, // auditor is current -> eligible
      })) ) as never);
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([
      {
        tokenId: "501", owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (CURRENT - 1n).toString(), delinquent: true, epochsBehind: 1,
        auditable: false, auditDueTimestamp: "0", killable: false,
      },
    ]);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
      })) ) as never);
  });

  const auditOpts = () =>
    vi.mocked(submitTx).mock.calls
      .filter(([i]) => (i as { data: string }).data === "0xAUDIT")
      .map(([, o]) => o as { revertible?: boolean; race?: boolean });

  it("is a no-op predicate without a payer, however large the bid", () => {
    expect(coinbaseBidActive({ ...base, coinbaseBidAuditOnlyEth: 0.05, coinbasePayerAddress: "" }, "audit")).toBe(false);
    expect(coinbaseBidActive({ ...base, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: PAYER }, "audit")).toBe(false);
    expect(coinbaseBidActive({ ...base, coinbaseBidAuditOnlyEth: 0.05, coinbasePayerAddress: PAYER }, "audit")).toBe(true);
    // The two bids are independent: a payment bid says nothing about an audit-only night.
    expect(coinbaseBidActive({ ...base, coinbaseBidEth: 0.05, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: PAYER }, "audit")).toBe(false);
    expect(coinbaseBidActive({ ...base, coinbaseBidEth: 0.05, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: PAYER }, "payment")).toBe(true);
  });

  it("WITH a bid: audits are revert-tolerant so one stale target can't drop the bundle", async () => {
    runtime.strategy = { ...base, coinbaseBidAuditOnlyEth: 0.022, coinbasePayerAddress: PAYER };
    await firePreBoundaryAudit();
    const opts = auditOpts();
    expect(opts.length).toBeGreaterThan(0);
    // revertible => it survives a doomed sibling, and the bid it rode with survives too.
    for (const o of opts) expect(o.revertible).toBe(true);
  });

  it("WITHOUT a bid: audits stay all-or-nothing and keep the mempool mirror", async () => {
    // No bid means the bundle is unlikely to win top-of-block at all, so the mirror is
    // the only copy that will realistically land — losing it would be strictly worse.
    runtime.strategy = { ...base, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: PAYER };
    await firePreBoundaryAudit();
    const opts = auditOpts();
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o.revertible).toBe(false);
  });

  it("a bid amount with no payer configured does NOT switch to bundle-only", async () => {
    // maybeQueueCoinbaseBid is a no-op without a payer, so treating this as "bidding"
    // would drop the mempool mirror while buying no position whatsoever.
    runtime.strategy = { ...base, coinbaseBidAuditOnlyEth: 0.05, coinbasePayerAddress: "" };
    await firePreBoundaryAudit();
    for (const o of auditOpts()) expect(o.revertible).toBe(false);
  });
});

// A missed pre-boundary race used to produce NOTHING in the log — the scheduler bailed on
// `deltaMs <= 0` in silence, so an engine that started seconds too late, or a laptop that
// slept through the window, looked identical to a boundary where there was simply nothing
// to do. That is the hardest failure to diagnose from an activity log.
//
// The warning has to be precise in both directions: silent when the race was armed in
// time (these schedulers re-run every tick, and the last seconds before a boundary hit the
// same branch AFTER the race has already fired), and exactly once when it truly was not.
describe("pre-boundary race: a missed window is reported, once", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const PAYER = "0x00000000000000000000000000000000000000b1";
  const EPOCH = 86_400n;
  const boundaryOf = (epoch: bigint) => epoch * EPOCH; // startTime 0; epoch E starts at E*EPOCH
  const at = (sec: bigint) => vi.setSystemTime(Number(sec) * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.startTime = 0n;
    runtime.citizenSupply = 500n;
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      offenseEnabled: true, autoAudit: true, preBoundaryAudit: true, preBoundaryPay: true,
      combinedBoundaryBundle: true, coinbaseBidEth: 0.02, coinbasePayerAddress: PAYER,
      endgameOnlyWithin: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.setWallets([]);
    runtime.running = false;
  });

  const missedWarnings = () =>
    vi.mocked(activity.add).mock.calls
      .map(([e]) => (e as { message?: string }).message ?? "")
      .filter((m) => m.includes("Missed the epoch"));

  it("says nothing when the race is armed with time to spare", () => {
    runtime.currentEpoch = 300n;
    at(boundaryOf(300n) - 60n); // a minute of lead left
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(0);
  });

  it("stays silent on later ticks inside the lead window, once armed", () => {
    runtime.currentEpoch = 301n;
    at(boundaryOf(301n) - 60n);
    schedulePreBoundaryBundle(); // armed in time

    // Ticks keep running as the boundary approaches and re-enter the same branch. The
    // race is already scheduled (or has fired), so warning here would cry wolf every 12s.
    at(boundaryOf(301n) - 1n);
    schedulePreBoundaryBundle();
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(0);
  });

  it("reports a genuinely missed window exactly once, however many ticks follow", () => {
    // Engine comes up INSIDE the lead window — the case a sleeping laptop produces.
    runtime.currentEpoch = 302n;
    at(boundaryOf(302n) - 1n);
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(1);
    expect(missedWarnings()[0]).toMatch(/epoch 303 pre-boundary bundle race/);

    // Every subsequent tick in the same window must stay quiet.
    schedulePreBoundaryBundle();
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(1);
  });

  it("says the boundary already passed when it has, not just that lead ran out", () => {
    runtime.currentEpoch = 304n;
    at(boundaryOf(304n) + 30n); // half a minute past it
    schedulePreBoundaryBundle();
    expect(missedWarnings()[0]).toMatch(/boundary passed 30s ago/);
  });

  it("warns again for a NEW boundary — it is per-epoch, not once per process", () => {
    runtime.currentEpoch = 305n;
    at(boundaryOf(305n) - 1n);
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(1);

    runtime.currentEpoch = 306n;
    at(boundaryOf(306n) - 1n);
    schedulePreBoundaryBundle();
    expect(missedWarnings()).toHaveLength(2);
  });
});

// Auto-arm is the only path that commits real ETH with no keypress, and it exists to close
// the autonomy gap in away mode: JIT is one-shot (it disarms after paying) and proactive
// pay only acts on citizens ALREADY 2+ behind — which under a 1-epoch auto-pay cap are
// quoted above the cap and skipped. So an unattended bot had no route from "a citizen fell
// behind" to "that citizen got paid". Gated on away mode itself, which IS the consent to
// run unattended; these pin that it fires, and the cases where it must stay out of the way.
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
        estimatedPayWei: "1000000000000000",
      })) ) as never);
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
        hasLifeInsurance: false, risk: "safe", estimatedPayWei: "1000000000000000",
      })) ) as never);
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
        estimatedPayWei: (o.owed ?? DEBT).toString(),
      })) ) as never);
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
      minBalanceEth: 0, maxBaseFeeGwei: 1000,
    };
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
describe("multi-citizen: today's paths under a real roster", () => {
  const A = "0xaaaa000000000000000000000000000000000001" as const;
  const B = "0xbbbb000000000000000000000000000000000002" as const;
  const acctA = { address: A } as unknown as PrivateKeyAccount;
  const acctB = { address: B } as unknown as PrivateKeyAccount;
  const EPOCH = 200n;
  const DEBT = 3_000_000_000_000_000n; // 0.003 — an audited citizen's catch-up

  type Row = { audited?: boolean; bribes?: bigint; behind?: bigint };
  /** Per-token status, so a roster can mix audited / bribed / current citizens. */
  const roster = (rows: Record<string, Row>) => {
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => {
        const r = rows[id.toString()] ?? {};
        return {
          tokenId: id.toString(),
          lastEpochPaid: (cur - (r.behind ?? 0n)).toString(),
          currentEpoch: cur.toString(),
          auditDueTimestamp: r.audited ? "99999999999" : "0",
          secondsUntilKillable: r.audited ? 3600 : null,
          bribeBalance: (r.bribes ?? 0n).toString(),
          hasLifeInsurance: false,
          risk: r.audited ? "audited" : r.behind ? "delinquent" : "safe",
          estimatedPayWei: DEBT.toString(),
        };
      }) ) as never);
  };

  const paidTokens = () =>
    vi.mocked(activity.add).mock.calls
      .map(([e]) => e as { kind: string; status: string; tokenId?: string })
      .filter((e) => e.kind === "pay-taxes" && e.status === "submitted")
      .map((e) => e.tokenId);
  const payCount = () =>
    vi.mocked(submitTx).mock.calls.filter(([i]) => (i as { data: string }).data === "0xPAYTAXES").length;
  const signersByData = () =>
    vi.mocked(submitTx).mock.calls.map(([intent, opts]) => ({
      data: (intent as { data: string }).data,
      signer: (opts as { account?: { address: string } })?.account?.address,
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = EPOCH;
    runtime.startTime = 0n;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.citizenSupply = 500n;
    resetDefenseState();
    resetJitState();
    // These tests call passes directly, where production only ever reaches them through
    // tick(). tick() clears the per-tick spend budget on the way in; without doing the
    // same, spend from an earlier test still counts against this one's balance.
    resetTickBudget();
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    runtime.strategy = { ...DEFAULT_STRATEGY };
    resetDefenseState();
    resetJitState();
    vi.mocked(batchGetOwnedStatuses).mockReset();
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(queueCoinbaseBid).mockResolvedValue(false);
  });

  /** One wallet holding `ids`, with ownership primed the way tick() does. */
  const oneWallet = async (ids: bigint[], balanceWei: bigint) => {
    runtime.setWallets([{ account: acctA as never, label: "A", balanceWei }]);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue(ids);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
  };

  it("Benji: rescues every audited citizen in the roster, not just the first", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, autoDefendAudit: true,
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    await oneWallet([10n, 20n, 30n], 100_000_000_000_000_000_000n);
    roster({ "10": { audited: true, behind: 3n }, "20": { audited: true, behind: 2n }, "30": { audited: true, behind: 4n } });

    await maybeAutoDefendAudit([10n, 20n, 30n], EPOCH, 0n);
    expect(paidTokens().sort()).toEqual(["10", "20", "30"]);
  });

  it("Benji: sorts a mixed roster — pays only the audited, unbribed, non-excluded", async () => {
    runtime.strategy = {
      ...DEFAULT_STRATEGY, autoDefendAudit: true, excludedTokenIds: ["40"],
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    await oneWallet([10n, 20n, 30n, 40n], 100_000_000_000_000_000_000n);
    roster({
      "10": { audited: true, behind: 3n },              // rescue
      "20": { audited: true, behind: 3n, bribes: 1n },  // holds a bribe — free fix, stays manual
      "30": { behind: 1n },                             // behind but not audited — pre-audit paths own it
      "40": { audited: true, behind: 3n },              // excluded — "never pay" means never
    });

    await maybeAutoDefendAudit([10n, 20n, 30n, 40n], EPOCH, 0n);
    expect(paidTokens()).toEqual(["10"]);
  });

  it("Benji: several rescues in one tick cannot cumulatively breach the balance floor", async () => {
    // The failure single-citizen tests cannot see. Each rescue passes canSpend on its own;
    // only the running total says no. Balance 0.012, each rescue costs 0.003 + 0.004 gas,
    // so exactly two fit and the third must be refused rather than overdrawing.
    runtime.strategy = {
      ...DEFAULT_STRATEGY, autoDefendAudit: true,
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    await oneWallet([10n, 20n, 30n], 12_000_000_000_000_000n);
    roster({ "10": { audited: true, behind: 3n }, "20": { audited: true, behind: 3n }, "30": { audited: true, behind: 3n } });

    await maybeAutoDefendAudit([10n, 20n, 30n], EPOCH, 0n);
    expect(payCount()).toBe(2);
    // And the one it could not save is reported, not dropped silently — a citizen about to
    // die is the last thing that should fail quietly.
    const skips = vi.mocked(activity.add).mock.calls
      .map(([e]) => e as { kind: string; status: string; message?: string })
      .filter((e) => e.kind === "pay-taxes" && e.status === "skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.message).toMatch(/could NOT save/);
  });

  it("Benji: rescues each citizen from the wallet that actually holds it", async () => {
    // payTaxes is owner-only, so signing #20 with wallet A is a guaranteed revert that
    // still burns gas — and would leave that citizen to die.
    runtime.setWallets([
      { account: acctA as never, label: "A", balanceWei: 100_000_000_000_000_000_000n },
      { account: acctB as never, label: "B", balanceWei: 100_000_000_000_000_000_000n },
    ]);
    const OWNED: Record<string, bigint[]> = { [A.toLowerCase()]: [10n], [B.toLowerCase()]: [20n] };
    vi.mocked(fetchOwnedTokenIds).mockImplementation(async (_c: unknown, addr: string) => OWNED[addr.toLowerCase()] ?? []);
    await fetchOwnedAcrossWallets("0x000000000000000000000000000000000000cc");
    runtime.strategy = {
      ...DEFAULT_STRATEGY, autoDefendAudit: true,
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    roster({ "10": { audited: true, behind: 3n }, "20": { audited: true, behind: 3n } });

    await maybeAutoDefendAudit([10n, 20n], EPOCH, 0n);
    const pays = signersByData().filter((c) => c.data === "0xPAYTAXES");
    expect(pays).toHaveLength(2);
    expect(new Set(pays.map((p) => p.signer))).toEqual(new Set([A, B]));
  });

  it("auto-arm: one citizen falling behind arms the whole roster, and JIT pays only those behind", async () => {
    // jitTokenIds stays empty (= all owned) on purpose, so a roster that drifts apart over
    // several epochs is caught by one arm. jitPass is what filters to the ones that owe.
    runtime.strategy = {
      ...DEFAULT_STRATEGY, awayMode: true, jitEnabled: false, jitTargetEpoch: null,
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    await oneWallet([10n, 20n, 30n], 100_000_000_000_000_000_000n);
    roster({ "10": { behind: 1n }, "20": { behind: 2n }, "30": {} }); // #30 is current

    await maybeAutoArmPayment([10n, 20n, 30n], EPOCH, 0n);
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(EPOCH + 1n));
    expect(runtime.strategy.jitTokenIds).toEqual([]); // every owned citizen, not a snapshot

    // Now run the boundary the arm was for: only the two that owe should be paid.
    resetJitState();
    await jitPass([10n, 20n, 30n], EPOCH + 1n, 0n);
    expect(paidTokens().sort()).toEqual(["10", "20"]);
  });

  it("Benji: says so when a citizen's status could not be read, instead of silently skipping", async () => {
    // batchGetOwnedStatuses drops a token whose multicall slice partly failed. On other
    // passes that is a missed opportunity; here an unread citizen can be killed while the
    // log shows nothing wrong, so a short read has to be visible.
    runtime.strategy = {
      ...DEFAULT_STRATEGY, autoDefendAudit: true,
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
    };
    await oneWallet([10n, 20n, 30n], 100_000_000_000_000_000_000n);
    roster({ "10": { audited: true, behind: 3n }, "20": { audited: true, behind: 3n }, "30": { audited: true, behind: 3n } });
    // #30's read comes back short, exactly as a partial multicall failure looks.
    const full = vi.mocked(batchGetOwnedStatuses).getMockImplementation()!;
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], ...rest: never[]) =>
      (await (full as never as (...a: unknown[]) => Promise<{ tokenId: string }[]>)(ids, ...rest))
        .filter((st) => st.tokenId !== "30")) as never);

    await maybeAutoDefendAudit([10n, 20n, 30n], EPOCH, 0n);
    expect(paidTokens().sort()).toEqual(["10", "20"]);
    const notes = vi.mocked(activity.add).mock.calls
      .map(([e]) => e as { message?: string })
      .filter((e) => /could not read/.test(e.message ?? ""));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("#30");
  });

  it("split bid: a bundle of many payments and audits still buys position ONCE", async () => {
    // The bid is per-BUNDLE, not per-citizen. Queuing one per token would multiply the
    // spend by the roster size, and paying the audit-only rate on a night that carries
    // payments would underbid the boundary that actually matters.
    const PAY_BID = 20_000_000_000_000_000n;
    runtime.currentEpoch = EPOCH - 1n;
    runtime.setWallets([{ account: acctA as never, label: "A", balanceWei: 100_000_000_000_000_000_000n }]);
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n, 20n, 30n]);
    runtime.strategy = {
      ...DEFAULT_STRATEGY,
      offenseEnabled: true, autoAudit: true, preBoundaryAudit: true, preBoundaryPay: true,
      combinedBoundaryBundle: true, jitEnabled: true, jitTargetEpoch: Number(EPOCH), jitTokenIds: [],
      coinbaseBidEth: 0.02, coinbaseBidAuditOnlyEth: 0.005,
      coinbasePayerAddress: "0x00000000000000000000000000000000000000b1",
      minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, priorityFeeGwei: 0,
      endgameOnlyWithin: null, offenseTargetTokenIds: ["501", "502"],
    };
    // Every owned citizen still owes the target epoch; auditLimit 1 each.
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : EPOCH - 1n,
      })) ) as never);
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    vi.mocked(batchGetTargetStatuses).mockResolvedValue(
      ["501", "502"].map((tokenId) => ({
        tokenId, owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (EPOCH - 2n).toString(), delinquent: true, epochsBehind: 2,
        auditable: true, auditDueTimestamp: "0", killable: false,
      })),
    );
    vi.mocked(queueCoinbaseBid).mockResolvedValue(true);

    await firePreBoundaryBundle();

    const data = signersByData().map((c) => c.data);
    expect(data.filter((d) => d === "0xPAYTAXES").length).toBeGreaterThan(1); // several citizens
    expect(data).toContain("0xAUDIT");
    expect(vi.mocked(queueCoinbaseBid)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queueCoinbaseBid).mock.calls[0]?.[1]).toBe(PAY_BID); // payment rate, not audit-only
  });
});

// The three boundary shapes, and which bid each one buys position with. This is the whole
// point of splitting the bid: a payment boundary is defensive and must land, an audit-only
// boundary is speculative and smaller. Getting the routing wrong would silently spend the
// expensive bid on quiet epochs, or the cheap one on the boundary that actually matters.
describe("boundary pathways: payment, audit, and both", () => {
  const ADDR = "0x1111111111111111111111111111111111111111" as const;
  const PAYER = "0x00000000000000000000000000000000000000b1";
  const TARGET = 200n;
  const PAY_BID = 20_000_000_000_000_000n;   // 0.02
  const AUDIT_BID = 5_000_000_000_000_000n;  // 0.005

  const base = {
    ...DEFAULT_STRATEGY,
    offenseEnabled: true, autoAudit: true, preBoundaryAudit: true, preBoundaryPay: true,
    combinedBoundaryBundle: true,
    coinbaseBidEth: 0.02, coinbaseBidAuditOnlyEth: 0.005, coinbasePayerAddress: PAYER,
    minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000, endgameOnlyWithin: null,
    offenseTargetTokenIds: ["501"],
  };

  /** owedByUs: whether our citizen still owes the target epoch. */
  const stage = (owedByUs: boolean, auditableRival: boolean) => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : owedByUs ? TARGET - 1n : TARGET,
      })) ) as never);
    vi.mocked(filterLiveTokenIds).mockImplementation(async (_c: unknown, ids: bigint[]) =>
      ids.map((id) => ({ id, owner: "0x00000000000000000000000000000000000000dd" as `0x${string}` })),
    );
    vi.mocked(batchGetTargetStatuses).mockResolvedValue(
      auditableRival
        ? [{
            tokenId: "501", owner: "0x00000000000000000000000000000000000000dd",
            lastEpochPaid: (TARGET - 2n).toString(), delinquent: true, epochsBehind: 2,
            auditable: true, auditDueTimestamp: "0", killable: false,
          }]
        : [],
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useWallet({ address: ADDR }, 100_000_000_000_000_000_000n);
    runtime.running = true;
    runtime.gameState = 1;
    runtime.citizensAddress = "0x000000000000000000000000000000000000cc";
    runtime.citizenSupply = 500n;
    runtime.currentEpoch = TARGET - 1n;
    runtime.startTime = 0n;
    vi.mocked(queueCoinbaseBid).mockResolvedValue(true);
  });

  afterEach(() => {
    runtime.setWallets([]);
    runtime.running = false;
    runtime.strategy = { ...DEFAULT_STRATEGY };
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1n]);
    vi.mocked(batchGetTargetStatuses).mockResolvedValue([]);
    vi.mocked(filterLiveTokenIds).mockResolvedValue([]);
    vi.mocked(queueCoinbaseBid).mockResolvedValue(false);
    vi.mocked(publicClient.multicall).mockImplementation((async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: "success" as const,
        result: c.functionName === "auditLimit" ? 1n : 1_000_000n,
      })) ) as never);
  });

  const sent = (data: string) => vi.mocked(submitTx).mock.calls.filter(([i]) => (i as { data: string }).data === data);
  const bidAmount = () => vi.mocked(queueCoinbaseBid).mock.calls[0]?.[1];

  it("BOTH: payment + audit fuse into one bundle on the PAYMENT bid", async () => {
    runtime.strategy = { ...base, jitEnabled: true, jitTargetEpoch: Number(TARGET), jitTokenIds: [] };
    stage(true, true);
    await firePreBoundaryBundle();

    expect(sent("0xPAYTAXES").length).toBeGreaterThan(0);
    expect(sent("0xAUDIT").length).toBeGreaterThan(0);
    expect(vi.mocked(queueCoinbaseBid)).toHaveBeenCalledTimes(1); // one bid for the whole bundle
    expect(bidAmount()).toBe(PAY_BID);
  });

  it("PAYMENT ONLY: no auditable rival, still the payment bid", async () => {
    runtime.strategy = { ...base, jitEnabled: true, jitTargetEpoch: Number(TARGET), jitTokenIds: [] };
    stage(true, false);
    await firePreBoundaryBundle();

    expect(sent("0xPAYTAXES").length).toBeGreaterThan(0);
    expect(sent("0xAUDIT")).toHaveLength(0);
    expect(bidAmount()).toBe(PAY_BID);
  });

  it("AUDIT ONLY: nothing owed, so the cheaper audit bid buys position", async () => {
    runtime.strategy = { ...base, jitEnabled: false, jitTargetEpoch: null };
    stage(false, true);
    await firePreBoundaryBundle();

    expect(sent("0xPAYTAXES")).toHaveLength(0);
    expect(sent("0xAUDIT").length).toBeGreaterThan(0);
    expect(bidAmount()).toBe(AUDIT_BID);
  });

  it("AUDIT ONLY via the standalone fire also uses the audit bid", async () => {
    // combinedBoundaryBundle off -> the separate audit scheduler owns the boundary.
    runtime.strategy = { ...base, combinedBoundaryBundle: false, jitEnabled: false, jitTargetEpoch: null };
    stage(false, true);
    await firePreBoundaryAudit();

    expect(sent("0xAUDIT").length).toBeGreaterThan(0);
    expect(bidAmount()).toBe(AUDIT_BID);
  });

  it("end to end: auto-arm turns a quiet boundary into a payment boundary", async () => {
    // Sit just before the epoch-200 boundary on the test's own grid (startTime 0), so the
    // arming re-schedules a FUTURE boundary the way it would in production. Left on the
    // real clock, that boundary is decades past, scheduleJitBoundary fires an immediate
    // catch-up tick, and the in-flight guard then defers the bundle we are asserting on.
    vi.useFakeTimers();
    vi.setSystemTime(Number((TARGET - 1n) * 86_400n - 600n) * 1000);
    // The autonomy loop. Citizen falls behind, nothing is armed, nobody is at the keyboard.
    runtime.strategy = { ...base, awayMode: true, jitEnabled: false, jitTargetEpoch: null };
    stage(true, true);
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(), lastEpochPaid: (cur - 1n).toString(), currentEpoch: cur.toString(),
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "safe", estimatedPayWei: "1000000000000000",
      })) ) as never);

    await maybeAutoArmPayment([10n], TARGET - 1n, 0n);
    expect(runtime.strategy.jitEnabled).toBe(true);
    expect(runtime.strategy.jitTargetEpoch).toBe(Number(TARGET));

    // Hand the owned-status read back to the file's default before firing: the override
    // above exists only to make the auto-arm see a citizen behind, and leaving it in place
    // would have it answering the payment pass's questions too.
    vi.mocked(batchGetOwnedStatuses).mockImplementation((async (ids: bigint[], cur: bigint) =>
      ids.map((id) => ({
        tokenId: id.toString(), lastEpochPaid: "3", currentEpoch: cur.toString(),
        auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
        hasLifeInsurance: false, risk: "delinquent", estimatedPayWei: "1000000000000000",
      })) ) as never);

    // ...and the boundary that follows is now a PAYMENT boundary, priced accordingly.
    await firePreBoundaryBundle();
    expect(sent("0xPAYTAXES").length).toBeGreaterThan(0);
    expect(bidAmount()).toBe(PAY_BID);
    vi.useRealTimers();
  });
});
