import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * The NO-BID boundary race for a multi-citizen holder: 5 payments + 5 audits, coinbase bid 0,
 * and a payment tip deliberately HIGHER than the audit tip.
 *
 * With `coinbaseBidEth: 0` the combined fire never runs (`combinedBundleActive` requires a
 * bid), so payments and audits go out as TWO SEPARATE bundles from the same wallet, each
 * priced from its own gas profile. Three things have to hold for that to be a real strategy
 * rather than a foot-gun, and none of them is obvious:
 *
 *  1. NONCES MUST NOT COLLIDE ACROSS THE TWO FIRES. Each fire calls nonces.syncAll() and the
 *     payments are still unmined private bundles when the audits are prepared, so a naive
 *     re-sync to the chain's pending count would hand the audits the SAME nonces as the
 *     payments — silently dropping one whole set. The real NonceManager is used here, not a
 *     counter mock, because that holding behaviour IS the property under test.
 *  2. Each set must carry ITS OWN tip: payments at priorityFeeGwei, audits at
 *     offensePriorityFeeGwei (which requires separateOffenseGas).
 *  3. Every tx must keep its public-mempool mirror. Nothing is revertible without a bid, and
 *     the mirror is the only copy that can land in the ~1 boundary in 10 built by a solo
 *     validator, which ignores coinbase transfers outright.
 *
 * Asserted on the JSON actually POSTed plus the signed tx fields, not internal state.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const GAME = "0x00000000000000000000000000000000000000aa" as const;
const TARGET_EPOCH = 200n;
// Epoch N begins at startTime + (N-1)*EPOCH, so epoch 200 starts at 199 days.
const BOUNDARY_TS = (TARGET_EPOCH - 1n) * 86_400n;

const OWNED = [10n, 20n, 30n, 40n, 50n];          // 5 citizens, all one epoch behind
const RIVALS = ["501", "502", "503", "504", "505"]; // 5 auditable rivals, 5 auditor slots

/**
 * The chain's pending nonce. Held constant DURING a test — private bundles are unmined while
 * both fires run, which is what makes the cross-fire collision possible — but advanced far
 * ahead BETWEEN tests, so the real NonceManager releases its held ceiling (onchain >=
 * reservedCeil) and every case starts from a known number instead of inheriting the previous
 * one's reservations.
 */
let chainNonce = 100;
/** lastEpochPaid for OWNED citizens. One behind by default (a payment is owed); a test can
 *  set it current to model an audit-only boundary. Read at call time by the multicall mock. */
let ownedLep = TARGET_EPOCH - 1n;
const PAY_TIP_GWEI = 300;
const AUDIT_TIP_GWEI = 150;

const sendRawTransaction = vi.fn(async () => "0xmirror");
const getTransactionCount = vi.fn(async () => chainNonce);
/**
 * The timestamp-override simulation each pre-boundary tx runs (simulateAtTimestamp). Mocked
 * as SUCCEEDING so the real sim path is exercised — leaving it off made every tx fall back to
 * "sending unsimulated", which both skipped the code under test and hid 10 round-trips from
 * the timing budget below.
 */
const request = vi.fn(async () => "0x");
vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount,
    request,
    sendRawTransaction,
    estimateGas: vi.fn(async () => 100_000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : c.functionName === "auditsUsedInEpoch" ? 0n
          : ownedLep, // lastEpochPaid for owned citizens (see ownedLep)
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
    gameAddress: GAME,
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
    state: 1, currentEpoch: TARGET_EPOCH - 1n, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () =>
    RIVALS.map((tokenId) => ({
      tokenId, owner: "0x00000000000000000000000000000000000000dd",
      lastEpochPaid: (TARGET_EPOCH - 2n).toString(), delinquent: true, epochsBehind: 2,
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
  gameContract: { address: GAME, abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => OWNED),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));

vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));

vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));

// Deliberately NOT mocking ./nonce.js or ./flashbots.js — both are under test.
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { awaitPendingMirrors } = await import("./flashbots.js");
const { firePreBoundaryPay, firePreBoundaryAudit, combinedBundleActive } = await import("./strategy.js");
const { fetchOwnedTokenIds } = await import("./index-tokens.js");
const { batchGetTargetStatuses } = await import("./contract.js");
const { publicClient } = await import("./chain.js");

const PAY = "11111111", AUDIT = "22222222";



/**
 * The fake signed payload encodes selector + nonce + tip so every assertion can read the
 * WIRE rather than the signing calls. That distinction matters: simulation also signs a tx
 * (with a placeholder nonce), so signing calls are a superset of what actually gets bundled
 * and would show phantom duplicate nonces.
 */
function fakeSign(sel: string, nonce: number, tipGwei: number): `0x${string}` {
  return `0x${sel}${nonce.toString(16).padStart(4, "0")}${Math.round(tipGwei).toString(16).padStart(6, "0")}${"cd".repeat(23)}` as `0x${string}`;
}
const parseTx = (t: string) => ({
  sel: t.slice(2, 10),
  nonce: parseInt(t.slice(10, 14), 16),
  tipGwei: parseInt(t.slice(14, 20), 16),
});
/** Every tx that actually reached a builder, de-duplicated across the fan-out. */
function wireTxs(): { sel: string; nonce: number; tipGwei: number }[] {
  const seen = new Map<string, { sel: string; nonce: number; tipGwei: number }>();
  for (const b of bundles()) for (const t of b.txs) seen.set(t, parseTx(t));
  return [...seen.values()].sort((a, b2) => a.nonce - b2.nonce);
}

/** eth_sendBundle payloads, one per (builder x target block). */
function bundles(): { txs: `0x${string}`[]; revertingTxHashes?: string[]; blockNumber: string; minTimestamp?: number }[] {
  return vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle")
    .map((b) => b.params[0]);
}
/** Selector of each tx in a bundle, read back off the wire. */
const kindsOf = (b: { txs: `0x${string}`[] }) => b.txs.map((t) => t.slice(2, 10));

/** Run the two separate fires the way the schedulers do: payments first, then audits. */
async function runBothFires(): Promise<void> {
  await firePreBoundaryPay();
  await firePreBoundaryAudit();
}

beforeEach(() => {
  // Clear call history first (implementations survive), so per-test counts are per-test.
  // Without this the round-trip measurement below silently accumulated the whole file.
  vi.clearAllMocks();
  chainNonce += 50; // past any ceiling the previous case reserved
  ownedLep = TARGET_EPOCH - 1n; // default: a payment is owed
  vi.mocked(fetchOwnedTokenIds).mockResolvedValue(OWNED);
  sendRawTransaction.mockClear();
  getTransactionCount.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; nonce: number; maxPriorityFeePerGas: bigint }) => {
      const sel = tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "99999999";
      return fakeSign(sel, tx.nonce, Number(tx.maxPriorityFeePerGas) / 1e9);
    }),
    signMessage: vi.fn(async () => "0xsig"),
  } as unknown as PrivateKeyAccount;

  runtime.setWallets([{ account, label: "t", balanceWei: 100_000_000_000_000_000_000n }]);
  runtime.running = true;
  runtime.gameState = 1;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.currentEpoch = TARGET_EPOCH - 1n;
  runtime.startTime = 0n;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    preBoundaryPay: true, preBoundaryAudit: true,
    jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: [],
    offenseEnabled: true, autoAudit: true,
    minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 100_000,
    endgameOnlyWithin: null,
    // The configuration under test: no bid at all, and payments priced above audits.
    combinedBoundaryBundle: true, // on, but inert without a bid
    coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0, coinbasePayerAddress: "",
    separateOffenseGas: true,
    priorityFeeGwei: PAY_TIP_GWEI, dynamicTipEnabled: false,
    offensePriorityFeeGwei: AUDIT_TIP_GWEI, offenseDynamicTipEnabled: false,
    offenseMaxBaseFeeGwei: 100_000,
    offenseTargetTokenIds: RIVALS,
  };
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
  vi.unstubAllGlobals();
});

describe("no-bid boundary race: payments and audits as two separate bundles", () => {
  it("does not use the combined fire at all when the bid is 0", () => {
    // combinedBoundaryBundle is ON, so this is what routes to the separate schedulers.
    expect(combinedBundleActive(runtime.strategy)).toBe(false);
  });

  it("sends 5 payments and 5 audits in SEPARATE bundles, with no bid tx", async () => {
    await runBothFires();
    const groups = bundles().map(kindsOf);
    const payBundles = groups.filter((k) => k.includes(PAY));
    const auditBundles = groups.filter((k) => k.includes(AUDIT));
    expect(payBundles.length).toBeGreaterThan(0);
    expect(auditBundles.length).toBeGreaterThan(0);
    // Separate means separate: no bundle carries both kinds.
    expect(groups.some((k) => k.includes(PAY) && k.includes(AUDIT))).toBe(false);
    expect(payBundles[0]).toHaveLength(5);
    expect(auditBundles[0]).toHaveLength(5);
    // No CoinbasePayer tx anywhere.
    expect(groups.flat()).not.toContain("99999999");
  });

  it("prices payments at the payment tip and audits at the audit tip", async () => {
    await runBothFires();
    const pays = wireTxs().filter((s) => s.sel === PAY);
    const audits = wireTxs().filter((s) => s.sel === AUDIT);
    expect(pays).toHaveLength(5);
    expect(audits).toHaveLength(5);
    expect(pays.every((s) => s.tipGwei === PAY_TIP_GWEI)).toBe(true);
    expect(audits.every((s) => s.tipGwei === AUDIT_TIP_GWEI)).toBe(true);
    // The asymmetry the user configured must survive: payments outrank their own audits.
    expect(Math.min(...pays.map((s) => s.tipGwei))).toBeGreaterThan(Math.max(...audits.map((s) => s.tipGwei)));
  });

  it("never reuses a nonce across the two fires", async () => {
    // THE hazard of splitting the race. The payments are unmined private bundles when the
    // audits are prepared, so the chain's pending count still reads ONCHAIN_NONCE for both
    // fires; only the reserved-ceiling hold keeps the audits off the payments' nonces.
    await runBothFires();
    const nonces = wireTxs().map((s) => s.nonce);
    expect(new Set(nonces).size).toBe(nonces.length); // no duplicates at all
    // Contiguous from wherever this run started, rather than a fixed 100: the manager holds
    // its reserved ceiling for as long as the chain nonce lags, which is exactly the
    // behaviour being relied on here, and it carries across earlier cases in this file.
    expect(nonces).toEqual([...Array(10).keys()].map((i) => chainNonce + i));
    // ...and specifically: audits continue after payments rather than restarting on them.
    const lastPay = Math.max(...wireTxs().filter((s) => s.sel === PAY).map((s) => s.nonce));
    const firstAudit = Math.min(...wireTxs().filter((s) => s.sel === AUDIT).map((s) => s.nonce));
    expect(firstAudit).toBe(lastPay + 1);
  });

  it("mirrors every tx to the public mempool, which is the only lever on a solo block", async () => {
    // Nothing is revertible without a bid, and revertible is what makes a tx bundle-only.
    // The mirror is what can land in a vanilla-built boundary block.
    await runBothFires();
    await awaitPendingMirrors();
    expect(sendRawTransaction).toHaveBeenCalledTimes(10);
  });

  it("stamps both bundles with the boundary so neither can execute pre-boundary", async () => {
    // The epoch-169 failure applies to each fire independently once they are separate.
    await runBothFires();
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY_TS));
  });

  it("keeps the 5 payments revert-tolerant, so one AlreadyCurrent cannot drop the others", async () => {
    // Splitting the race has an underrated benefit: the payments now sit ALONE in their
    // bundle, so a doomed audit cannot drop them at all — and among themselves they are
    // declared revertible because 2+ citizens owe.
    await runBothFires();
    const payBundle = bundles().find((b) => kindsOf(b).includes(PAY))!;
    expect(payBundle.txs).toHaveLength(5);
    expect(payBundle.revertingTxHashes ?? []).toHaveLength(5);
    expect(kindsOf(payBundle).every((k) => k === PAY)).toBe(true); // no audit can poison it
  });

  it("makes all 5 audits revert-tolerant AND mirrored, so one stale target costs only itself", async () => {
    // The weakness this file used to document. Without a bid the audits were mandatory, so a
    // single target cured before execution dropped all five from the bundle. Nothing shares
    // this bundle — the payments have their own — so revert-tolerance is free here, and the
    // mirror is kept because it is the only copy that can land in a solo-built boundary block.
    await runBothFires();
    const auditBundle = bundles().find((b) => kindsOf(b).includes(AUDIT))!;
    expect(auditBundle.txs).toHaveLength(5);
    expect(auditBundle.revertingTxHashes ?? []).toHaveLength(5);
    await awaitPendingMirrors();
    expect(sendRawTransaction).toHaveBeenCalledTimes(10); // payments + audits, all mirrored
  });

  it("keeps each bundle in ascending nonce order", async () => {
    await runBothFires();
    for (const b of bundles()) {
      const order = b.txs.map((t) => parseInt(t.slice(10, 14), 16));
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
  });
});

describe("what actually forces the payment ahead of the audit", () => {
  it("puts every audit on a HIGHER nonce than every payment", async () => {
    // Worth being precise about, because the intuition "set the payment tip higher so it
    // lands first" is not the mechanism. Both sets come from ONE wallet, and a block must
    // order a sender's txs by ascending nonce — so the payments are ahead of the audits by
    // construction, whatever the tips are.
    await runBothFires();
    const pay = wireTxs().filter((s) => s.sel === PAY).map((s) => s.nonce);
    const audit = wireTxs().filter((s) => s.sel === AUDIT).map((s) => s.nonce);
    expect(Math.max(...pay)).toBeLessThan(Math.min(...audit));
  });

  it("makes the audits UNMINEABLE unless the payments land, which is the real reason to price payments higher", async () => {
    // The flip side of that nonce ordering, and the thing to actually worry about: the audit
    // bundle sits on nonces that do not exist yet until the payment bundle lands. A builder
    // taking the audit bundle alone would be taking txs with a nonce gap, so they simply
    // cannot be included. Pricing payments ABOVE audits is what keeps the unblocking bundle
    // the more attractive of the two — not a way to order them within a block.
    await runBothFires();
    const payBundle = bundles().find((b) => kindsOf(b).includes(PAY))!;
    const auditBundle = bundles().find((b) => kindsOf(b).includes(AUDIT))!;
    const firstAuditNonce = Math.min(...auditBundle.txs.map((t) => parseTx(t).nonce));
    const payNonces = payBundle.txs.map((t) => parseTx(t).nonce);
    // The audit bundle does NOT carry the payments that unblock it...
    expect(payNonces.some((n) => n >= firstAuditNonce)).toBe(false);
    expect(kindsOf(auditBundle).every((k) => k === AUDIT)).toBe(true);
    // ...and its lowest nonce is exactly one past the payments' highest.
    expect(firstAuditNonce).toBe(Math.max(...payNonces) + 1);
    // ...while the payment bundle is self-contained: it starts at the chain's own nonce.
    expect(Math.min(...payNonces)).toBe(chainNonce);
  });
});

describe("audit-only boundary (nothing owed) — no bid, tip only", () => {
  beforeEach(() => { ownedLep = TARGET_EPOCH; }); // every citizen already current

  it("sends the audits alone, with no payment bundle and no bid", async () => {
    await runBothFires();
    const groups = bundles().map(kindsOf);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.flat()).not.toContain(PAY);       // nothing was owed
    expect(groups.flat()).not.toContain("99999999"); // and no CoinbasePayer tx
    expect(groups[0]).toHaveLength(5);
    expect(groups.every((k) => k.every((x) => x === AUDIT))).toBe(true);
  });

  it("prices them at the audit tip and mirrors every one", async () => {
    await runBothFires();
    const audits = wireTxs();
    expect(audits).toHaveLength(5);
    expect(audits.every((s) => s.tipGwei === AUDIT_TIP_GWEI)).toBe(true);
    await awaitPendingMirrors();
    expect(sendRawTransaction).toHaveBeenCalledTimes(5);
  });

  it("has NO nonce dependency, so an audit-only boundary cannot be blocked by a payment", async () => {
    // The audit-only case is strictly simpler: the audits start at the chain's own nonce
    // instead of queuing behind a payment bundle that has to land first.
    await runBothFires();
    expect(Math.min(...wireTxs().map((s) => s.nonce))).toBe(chainNonce);
  });

  it("still refuses to execute before the boundary", async () => {
    await runBothFires();
    for (const b of bundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY_TS));
  });
});

describe("single-citizen holder, no bid", () => {
  beforeEach(() => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([10n]);
    runtime.strategy = { ...runtime.strategy, offenseTargetTokenIds: ["501"] };
  });

  it("still splits into a payment bundle and an audit bundle, each at its own tip", async () => {
    // One citizen, one auditor slot, one target: the degenerate case must not collapse into
    // a single bundle or silently drop the audit.
    await runBothFires();
    const pays = wireTxs().filter((s) => s.sel === PAY);
    const audits = wireTxs().filter((s) => s.sel === AUDIT);
    expect(pays).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(pays[0]!.tipGwei).toBe(PAY_TIP_GWEI);
    expect(audits[0]!.tipGwei).toBe(AUDIT_TIP_GWEI);
    expect(audits[0]!.nonce).toBe(pays[0]!.nonce + 1);
  });

  it("does NOT make a lone payment revert-tolerant — there is no sibling to protect", async () => {
    // With one payment there is nothing to save by tolerating its revert, and a bundle whose
    // only payment reverted would land having achieved nothing.
    await runBothFires();
    const payBundle = bundles().find((b) => kindsOf(b).includes(PAY))!;
    expect(payBundle.txs).toHaveLength(1);
    expect(payBundle.revertingTxHashes ?? []).toHaveLength(0);
  });
});

/**
 * Will it hold up in the 5s lead, with both schedulers live?
 *
 * The two fires contend for the same `ticking` lock — whichever timer fires first takes it and
 * the other retries every 150ms — so "both bundles were produced" is not enough. What matters
 * is that the second fire still gets in, and that the number of SERIAL round-trips fits the
 * lead: every payment and every audit is queued in a sequential loop, each with its own
 * timestamp-override simulation.
 */
describe("both fires inside the lead, with the real scheduler contention", () => {
  /** Count RPC-ish round-trips a fire makes, to price it against the lead. */
  function rpcCalls(): number {
    return (
      vi.mocked(publicClient.multicall).mock.calls.length +
      vi.mocked(publicClient.getBlock).mock.calls.length +
      vi.mocked(publicClient.getBlockNumber).mock.calls.length +
      vi.mocked(getTransactionCount).mock.calls.length +
      vi.mocked(request).mock.calls.length
    );
  }

  it("the audit fire still runs when the payment fire holds the tick lock", async () => {
    // Fire them CONCURRENTLY, which is what the two timers do at the same boundary. The
    // loser must not silently give up — it retries behind `ticking`.
    const both = Promise.all([firePreBoundaryPay(), firePreBoundaryAudit()]);
    await vi.waitFor(async () => {
      await both.catch(() => {});
      const kinds = bundles().map(kindsOf).flat();
      expect(kinds).toContain(PAY);
      expect(kinds).toContain(AUDIT);
    }, { timeout: 5_000, interval: 25 });
    // ...and the two sets still occupy separate bundles with no shared nonce.
    const nonces = wireTxs().map((s) => s.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("costs few enough serial round-trips to fit a 5s lead", async () => {
    await runBothFires();
    const calls = rpcCalls();
    // Measured for 5 payments + 5 audits, no bid (one builder in this harness):
    //   2 nonce syncs · 2 state multicalls · 10 timestamp-override sims (one per tx, SERIAL)
    //   2 uncached head reads · 4 eth_sendBundle posts · 10 mirrors (detached, off this path)
    // ~16 serial round-trips, so ~1.0s at a pessimistic 60ms each against a 5,000ms lead.
    // 10 game actions, each simulated and signed. At a pessimistic 60ms per round-trip this
    // is the wall-clock budget the 5,000ms lead has to absorb; assert it stays well inside.
    const worstCaseMs = calls * 60;
    expect(worstCaseMs).toBeLessThan(4_000);
    // Recorded so a regression that adds a per-citizen round-trip is visible as a number,
    // not as a mysteriously missed boundary in production.
    expect(calls).toBeLessThanOrEqual(40);
  });

  it("produces exactly two bundles per builder per target block — no duplicate submissions", async () => {
    // A retry loop that re-queued would double-submit the same nonces to the same builder.
    await runBothFires();
    const perBlock = new Map<string, number>();
    for (const b of bundles()) perBlock.set(b.blockNumber, (perBlock.get(b.blockNumber) ?? 0) + 1);
    // 1 builder x 2 target blocks x 2 fires = 4 posts, 2 per block.
    expect([...perBlock.values()].every((n) => n === 2)).toBe(true);
    expect(bundles()).toHaveLength(4);
  });
});

describe("a large holder: 10 payments + 10 audits, no bid", () => {
  const BIG = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n];
  const BIG_RIVALS = ["501", "502", "503", "504", "505", "506", "507", "508", "509", "510"];

  beforeEach(() => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue(BIG);
    vi.mocked(batchGetTargetStatuses).mockResolvedValue(
      BIG_RIVALS.map((tokenId) => ({
        tokenId, owner: "0x00000000000000000000000000000000000000dd",
        lastEpochPaid: (TARGET_EPOCH - 2n).toString(), delinquent: true, epochsBehind: 2,
        auditable: true, auditDueTimestamp: "0", killable: false,
      })) as never,
    );
    runtime.strategy = { ...runtime.strategy, offenseTargetTokenIds: BIG_RIVALS };
  });

  it("queues all 20 actions, each at its own tip, on 20 distinct sequential nonces", async () => {
    await runBothFires();
    const pays = wireTxs().filter((s) => s.sel === PAY);
    const audits = wireTxs().filter((s) => s.sel === AUDIT);
    expect(pays).toHaveLength(10);
    expect(audits).toHaveLength(10);
    expect(pays.every((s) => s.tipGwei === PAY_TIP_GWEI)).toBe(true);
    expect(audits.every((s) => s.tipGwei === AUDIT_TIP_GWEI)).toBe(true);
    const nonces = wireTxs().map((s) => s.nonce);
    expect(nonces).toEqual([...Array(20).keys()].map((i) => chainNonce + i));
    // Payments still entirely ahead of audits, so the nonce chain unblocks in the right order.
    expect(Math.max(...pays.map((p) => p.nonce))).toBeLessThan(Math.min(...audits.map((a) => a.nonce)));
  });

  it("still fits the lead at double the roster", async () => {
    // The per-citizen cost is one timestamp-override simulation each, run serially. This is
    // the number that would eat a 5s lead if it ever grew per-citizen round-trips.
    await runBothFires();
    const serial =
      vi.mocked(publicClient.multicall).mock.calls.length +
      vi.mocked(publicClient.getBlockNumber).mock.calls.length +
      vi.mocked(getTransactionCount).mock.calls.length +
      vi.mocked(request).mock.calls.length;
    expect(serial * 60).toBeLessThan(4_000); // pessimistic 60ms per round-trip
  });

  it("mirrors all 20, so a solo-built boundary block is still reachable", async () => {
    await runBothFires();
    await awaitPendingMirrors();
    expect(sendRawTransaction).toHaveBeenCalledTimes(20);
  });

  it("keeps all 10 payments revert-tolerant so one bad payment cannot drop the other nine", async () => {
    await runBothFires();
    const payBundle = bundles().find((b) => kindsOf(b).includes(PAY))!;
    expect(payBundle.txs).toHaveLength(10);
    expect(payBundle.revertingTxHashes ?? []).toHaveLength(10);
  });
});
