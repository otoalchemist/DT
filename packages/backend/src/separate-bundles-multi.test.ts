import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keccak256 } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Multi-citizen boundary with SEPARATE payment and audit bundles, each carrying its own
 * coinbase bid — and the nonce guarantees that make it safe.
 *
 * This is the configuration being considered to stop a low audit tip diluting a high payment
 * tip: `combinedBoundaryBundle` off, so the two fires flush independently and each is ranked
 * by builders on its own density with its own bid. The question it has to answer is whether
 * two independent fires over several citizens can ever hand the same nonce to two different
 * transactions — which is exactly what cost a payment at the epoch-176 boundary.
 *
 * Runs the REAL flashbots and nonce modules. A mocked nonce manager would make every
 * assertion here vacuous, because the collision this file exists to rule out lives in that
 * module's hold/release logic.
 *
 * The invariants, in the order they matter:
 *   1. every transaction across BOTH bundles has a distinct nonce — no collision, ever;
 *   2. the nonces form one unbroken run — a gap would strand the audit bundle;
 *   3. every payment sits below every audit;
 *   4. neither bundle contains a transaction from the other — no blended density;
 *   5. each bundle carries its OWN bid at its OWN amount.
 */

const GAME = "0x00000000000000000000000000000000000000aa" as const;
const ADDR = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815" as const;
const EPOCH = 86_400n;
const TARGET_EPOCH = 300n;
const BOUNDARY_TS = (TARGET_EPOCH - 1n) * EPOCH;

/** Five citizens, all one behind: every one owes a payment AND can audit. */
const OWNED = [11n, 22n, 33n, 44n, 55n];
const RIVALS = ["901", "902", "903", "904", "905"];
const PAY_TIP = 250;
const AUDIT_TIP = 40; // deliberately far below the payment tip — the case that motivates this
const PAY_BID = 0.02;
const AUDIT_BID = 0.005;

let chainNonce = 900;
let ownedLep = TARGET_EPOCH - 1n;

const sendRawTransaction = vi.fn(async () => "0xmirror" as `0x${string}`);

vi.mock("./chain.js", () => ({
  publicClient: {
    // Head one slot before the pre-boundary slot, so the boundary block is head + 2 and the
    // boundary-derived targeting is exercised rather than falling back to head + 1.
    getBlock: vi.fn(async () => ({
      baseFeePerGas: 1_000_000_000n, number: 5_000n, timestamp: BOUNDARY_TS - 24n,
    })),
    getBalance: vi.fn(async () => 50_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 5_000n),
    getTransactionCount: vi.fn(async () => chainNonce),
    // Every tx here is mirrored, so the node reports it pending. This is what the nonce
    // manager's evidence check reads to decide the payment's nonce is still live.
    getTransaction: vi.fn(async () => ({ blockNumber: null })),
    request: vi.fn(async () => "0x"),
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => 100_000n),
    sendRawTransaction,
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 5_002n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditsUsedInEpoch" ? 0n
          : c.functionName === "auditDueTimestamp" ? 0n // none under audit
          : ownedLep,
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({
    baseFeePerGas: 1_000_000_000n, number: 5_000n, gasUsed: 0n, gasLimit: 30_000_000n,
  })),
  getBalanceCached: vi.fn(async () => 50_000_000_000_000_000_000n),
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
  batchGetOwnedStatuses: vi.fn(async (ids: bigint[], epoch: bigint) =>
    ids.map((id) => ({
      tokenId: id.toString(), lastEpochPaid: ownedLep.toString(), currentEpoch: epoch.toString(),
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "delinquent" as const,
      estimatedPayWei: "120000000000000000", auditLimit: 1,
      walletAddress: ADDR, walletLabel: "t",
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
  encodePayTaxes: vi.fn(() => "0x11111111"),
  encodeAudit: vi.fn(() => "0x22222222"),
  encodeKill: vi.fn(() => "0x33333333"),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 120_000_000_000_000_000n),
  gameContract: { address: GAME, abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => OWNED),
  fetchCandidateTokenIds: vi.fn(async () => RIVALS.map((r) => BigInt(r))),
  ownershipIndexingAvailable: vi.fn(() => true),
}));
vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));

// Deliberately NOT mocking ./flashbots.js or ./nonce.js — the collision this file rules out
// lives in the nonce manager, so mocking it would make every assertion meaningless.
const contract = await import("./contract.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { awaitPendingMirrors } = await import("./flashbots.js");
const { applyThorMode, thorModeSettled, THOR_OVERRIDES } = await import("@dat-bot/shared");
const {
  firePreBoundaryPay, firePreBoundaryAudit, firePreBoundaryBundle,
  combinedBundleActive, resetPaidForBoundary,
} = await import("./strategy.js");

const PAY = "11111111", AUDIT = "22222222", BID = "";

const fakeSign = (sel: string, nonce: number, tipGwei: number, valWei: bigint): `0x${string}` =>
  `0x${sel.padEnd(8, "0")}${nonce.toString(16).padStart(4, "0")}${Math.round(tipGwei).toString(16).padStart(6, "0")}${valWei.toString(16).padStart(20, "0")}${"cd".repeat(9)}` as `0x${string}`;
const parseTx = (t: string) => ({
  sel: t.slice(2, 10),
  nonce: parseInt(t.slice(10, 14), 16),
  tipGwei: parseInt(t.slice(14, 20), 16),
  valueEth: Number(BigInt("0x" + t.slice(20, 40))) / 1e18,
});
const kindOf = (sel: string) => (sel === PAY ? "pay" : sel === AUDIT ? "audit" : "bid");

/** One entry per eth_sendBundle post, with its txs decoded.
 *
 *  `revertKinds` maps each entry of the bundle's `revertingTxHashes` back to what KIND of
 *  transaction it permits to revert, by re-hashing the bundle's own raw txs. That indirection is
 *  the point: the wire format is a list of opaque hashes, so an assertion on the raw list could
 *  pass while permitting the wrong transaction. `revertingTxHashes` absent is reported as an
 *  empty list, which is the same thing to a builder — nothing in this bundle may revert. */
function bundles(): {
  txs: ReturnType<typeof parseTx>[];
  revertKinds: string[];
  blockNumber: number;
  minTimestamp?: number;
}[] {
  return vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle")
    .map((b) => {
      const raw = b.params[0].txs as string[];
      const byHash = new Map(raw.map((t) => [keccak256(t as `0x${string}`), t]));
      return {
        txs: raw.map(parseTx),
        revertKinds: ((b.params[0].revertingTxHashes as string[] | undefined) ?? []).map((h) => {
          const t = byHash.get(h as `0x${string}`);
          // A hash naming a tx that is not in this bundle would be a real bug, so surface it
          // rather than quietly dropping it.
          return t ? kindOf(parseTx(t).sel) : "FOREIGN";
        }),
        blockNumber: Number(BigInt(b.params[0].blockNumber)),
        minTimestamp: b.params[0].minTimestamp,
      };
    });
}
/** Every distinct tx that reached a builder, de-duplicated across the fan-out. */
function wireTxs(): ReturnType<typeof parseTx>[] {
  const seen = new Map<string, ReturnType<typeof parseTx>>();
  for (const call of vi.mocked(globalThis.fetch).mock.calls) {
    let body: { method?: string; params?: { txs?: string[] }[] } | null = null;
    try { body = JSON.parse(String((call[1] as RequestInit).body)); } catch { continue; }
    if (body?.method !== "eth_sendBundle") continue;
    for (const t of body.params?.[0]?.txs ?? []) seen.set(t, parseTx(t));
  }
  return [...seen.values()].sort((a, b) => a.nonce - b.nonce);
}

beforeEach(() => {
  vi.clearAllMocks();
  chainNonce += 100; // clear of any ceiling a previous case reserved
  ownedLep = TARGET_EPOCH - 1n;
  resetPaidForBoundary();
  // Restore the target-status implementation every time. vi.clearAllMocks() clears CALLS but
  // not IMPLEMENTATIONS, so a case that stubs this to [] (the payment-only boundary) would
  // otherwise silently starve every later case of targets — which is exactly what happened.
  vi.mocked(contract.batchGetTargetStatuses).mockImplementation(async (tokens, epoch) =>
    (tokens as { id: bigint }[]).map(({ id }) => ({
      tokenId: id.toString(), owner: "0x00000000000000000000000000000000000000dd",
      lastEpochPaid: ((epoch as bigint) - 2n).toString(), delinquent: true, epochsBehind: 2,
      auditable: true, auditDueTimestamp: "0", killable: false,
    })) as never,
  );
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; nonce: number; maxPriorityFeePerGas: bigint; value?: bigint }) =>
      fakeSign(
        tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : BID,
        tx.nonce, Number(tx.maxPriorityFeePerGas) / 1e9, tx.value ?? 0n,
      )),
    signMessage: vi.fn(async () => "0xsig"),
  } as unknown as PrivateKeyAccount;
  runtime.setWallets([{ account, label: "t", balanceWei: 50_000_000_000_000_000_000n }]);
  runtime.running = true;
  runtime.gameState = 1;
  runtime.currentEpoch = TARGET_EPOCH - 1n;
  runtime.startTime = 0n;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    // These cases cover the MIRRORED, revert-tolerant path, which is no longer the
    // shipped default (see DEFAULT_STRATEGY). Pinned explicitly so they keep testing
    // the behaviour rather than whatever the default happens to be.
    mirrorAudits: true, auditBundleAllOrNothing: false,
    enabled: true, jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH),
    jitTokenIds: OWNED.map(String),
    preBoundaryPay: true, preBoundaryAudit: true,
    offenseEnabled: true, autoAudit: true, autoKill: false,
    offenseTargetTokenIds: RIVALS,
    // The configuration under test: a bid on BOTH halves, but fusion OFF so each bundle is
    // ranked on its own density.
    combinedBoundaryBundle: false,
    coinbaseBidEth: PAY_BID,
    coinbaseBidAuditOnlyEth: AUDIT_BID,
    coinbasePayerAddress: PAYER,
    separateOffenseGas: true,
    priorityFeeGwei: PAY_TIP, offensePriorityFeeGwei: AUDIT_TIP,
    dynamicTipEnabled: false, offenseDynamicTipEnabled: false,
    maxBaseFeeGwei: 500, offenseMaxBaseFeeGwei: 500,
    minBalanceEth: 0, maxPaymentEth: 0,
    racePublicMempool: true,
    auditWhileBehind: true,
  } as typeof runtime.strategy;
});

afterEach(() => { runtime.setWallets([]); runtime.running = false; });

async function raceTheBoundary(): Promise<void> {
  await firePreBoundaryPay();
  await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY_TS });
  await awaitPendingMirrors();
}

/** The FUSED boundary: one fire that queues payments, then audits, then the bid into a single
 *  bundle. A different entry point from the split path's two fires, which is the whole point —
 *  calling firePreBoundaryPay with fusion configured would just exercise the split path again. */
async function raceTheBoundaryFused(): Promise<void> {
  await firePreBoundaryBundle();
  await awaitPendingMirrors();
}

/** Clear the wire between two boundaries inside ONE test, so a before/after comparison is
 *  possible. Mirrors the reset that beforeEach does — including the chain-nonce bump, which is
 *  what lets the nonce manager release the reservations the first boundary took. */
function resetWire(): void {
  vi.mocked(globalThis.fetch).mockClear();
  sendRawTransaction.mockClear();
  chainNonce += 100;
  resetPaidForBoundary();
}

const kindsIn = (b: { txs: ReturnType<typeof parseTx>[] }) => b.txs.map((t) => kindOf(t.sel));
const auditBundles = () => bundles().filter((b) => kindsIn(b).includes("audit"));
const payBundles = () => bundles().filter((b) => kindsIn(b).includes("pay"));
const mirroredKinds = () =>
  (sendRawTransaction.mock.calls as unknown as { serializedTransaction: string }[][])
    .map((c) => kindOf(parseTx(c[0]!.serializedTransaction).sel));

describe("5 citizens, separate bundles, a bid on each", () => {
  it("confirms fusion really is OFF, so this is the two-bundle path", () => {
    expect(runtime.strategy.coinbaseBidEth).toBeGreaterThan(0);
    expect(runtime.strategy.combinedBoundaryBundle).toBe(false);
    expect(combinedBundleActive(runtime.strategy)).toBe(false);
  });

  it("gives every transaction across BOTH bundles a distinct nonce", async () => {
    // The headline guarantee. A repeat here is the epoch-176 collision: one signature
    // invalidates the other and a citizen silently goes unpaid.
    await raceTheBoundary();
    const nonces = wireTxs().map((t) => t.nonce);
    expect(nonces.length).toBeGreaterThanOrEqual(10); // 5 payments + 5 audits, plus bids
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("leaves NO nonce gap — the run is unbroken", async () => {
    // A gap would strand the audit bundle: its first nonce would not exist yet, so no
    // builder could include it.
    await raceTheBoundary();
    const nonces = wireTxs().map((t) => t.nonce).sort((a, b) => a - b);
    expect(nonces[nonces.length - 1]! - nonces[0]!).toBe(nonces.length - 1);
  });

  it("puts all 5 payments below all 5 audits", async () => {
    await raceTheBoundary();
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay").map((t) => t.nonce);
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit").map((t) => t.nonce);
    expect(pay).toHaveLength(5);
    expect(audit).toHaveLength(5);
    expect(Math.max(...pay)).toBeLessThan(Math.min(...audit));
  });

  it("never mixes payments and audits in one bundle — no blended density", async () => {
    await raceTheBoundary();
    const shapes = bundles().map((b) => b.txs.map((t) => kindOf(t.sel)));
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) {
      expect(s.includes("pay") && s.includes("audit")).toBe(false);
    }
    expect(shapes.some((s) => s.includes("pay"))).toBe(true);
    expect(shapes.some((s) => s.includes("audit"))).toBe(true);
  });

  it("keeps each tip intact — 250 on payments, 40 on audits", async () => {
    // The whole reason to split: a 40 gwei audit must not drag the 250 gwei payment down.
    await raceTheBoundary();
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay");
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit");
    expect(pay.every((t) => t.tipGwei === PAY_TIP)).toBe(true);
    expect(audit.every((t) => t.tipGwei === AUDIT_TIP)).toBe(true);
  });

  it("gives each bundle its OWN bid at its own amount", async () => {
    await raceTheBoundary();
    const payBundle = bundles().find((b) => b.txs.some((t) => kindOf(t.sel) === "pay"));
    const auditBundle = bundles().find((b) => b.txs.some((t) => kindOf(t.sel) === "audit"));
    const bidIn = (b?: { txs: ReturnType<typeof parseTx>[] }) =>
      b?.txs.filter((t) => kindOf(t.sel) === "bid") ?? [];
    expect(bidIn(payBundle)).toHaveLength(1);
    expect(bidIn(auditBundle)).toHaveLength(1);
    expect(bidIn(payBundle)[0]!.valueEth).toBeCloseTo(PAY_BID, 6);
    expect(bidIn(auditBundle)[0]!.valueEth).toBeCloseTo(AUDIT_BID, 6);
  });

  it("shares no transaction between the two bundles", async () => {
    // If a tx appeared in both, whichever landed first would invalidate the other bundle.
    await raceTheBoundary();
    const payTxs = new Set(
      bundles().filter((b) => b.txs.some((t) => kindOf(t.sel) === "pay"))
        .flatMap((b) => b.txs.map((t) => `${t.nonce}`)),
    );
    const auditTxs = new Set(
      bundles().filter((b) => b.txs.some((t) => kindOf(t.sel) === "audit"))
        .flatMap((b) => b.txs.map((t) => `${t.nonce}`)),
    );
    for (const n of auditTxs) expect(payTxs.has(n)).toBe(false);
  });

  it("mirrors every payment and audit, so a solo-validator block is still reachable", async () => {
    await raceTheBoundary();
    // 10 game txs mirrored; the bid tx is bundle-only by design.
    expect(sendRawTransaction).toHaveBeenCalledTimes(10);
  });

  it("stamps BOTH bundles with minTimestamp = the boundary", async () => {
    /**
     * The guard that stops either bundle executing an epoch early, and it has to be on BOTH.
     * A payment priced for the next epoch reverts in the old one and burns its nonce; an audit
     * reverts with "not auditable yet". This was unasserted for the split path even though the
     * whole point of the path is a pre-boundary race.
     */
    await raceTheBoundary();
    const bs = bundles();
    expect(bs.length).toBeGreaterThan(0);
    expect(bs.every((b) => b.minTimestamp === Number(BOUNDARY_TS))).toBe(true);
    // And specifically on each half, so a bundle carrying only audits cannot slip through
    // unstamped while the payment bundle carries the flag.
    for (const kind of ["pay", "audit"]) {
      const half = bs.filter((b) => b.txs.some((t) => kindOf(t.sel) === kind));
      expect(half.length).toBeGreaterThan(0);
      expect(half.every((b) => b.minTimestamp === Number(BOUNDARY_TS))).toBe(true);
    }
  });

  it("aims BOTH bundles at the boundary block, never at the pre-boundary one", async () => {
    // Head is at boundary - 24s, so head + 1 (5001) is the PRE-boundary block and head + 2
    // (5002) is the boundary block. Two independent fires must agree, or the audit lands in a
    // block the payment never reached — the ally's 2-of-7 audit record.
    await raceTheBoundary();
    const blocksFor = (kind: string) =>
      [...new Set(bundles().filter((b) => b.txs.some((t) => kindOf(t.sel) === kind))
        .map((b) => b.blockNumber))].sort((a, b) => a - b);
    expect(blocksFor("pay")).toEqual([5_002, 5_003]);
    expect(blocksFor("audit")).toEqual([5_002, 5_003]);
    expect(bundles().map((b) => b.blockNumber)).not.toContain(5_001);
  });

  it("keeps each coinbase bid BUNDLE-ONLY — a mirrored bid is ETH thrown away", async () => {
    /**
     * The bid buys position inside a bundle. Broadcast to the mempool it is just an ETH
     * transfer to the payer contract with no bundle to advantage, so the money is spent for
     * nothing — and with two bids in split mode there are two chances to leak one.
     *
     * Ten mirrors for ten game transactions; the two bids must not be among them.
     */
    await raceTheBoundary();
    expect(sendRawTransaction).toHaveBeenCalledTimes(10);
    const mirrored = (sendRawTransaction.mock.calls as unknown as { serializedTransaction: string }[][])
      .map((c) => parseTx(c[0]!.serializedTransaction));
    expect(mirrored.every((t) => kindOf(t.sel) !== "bid")).toBe(true);
    // Both bids DID go out, just only inside bundles.
    const bidsInBundles = bundles().flatMap((b) => b.txs.filter((t) => kindOf(t.sel) === "bid"));
    expect(bidsInBundles.length).toBeGreaterThan(0);
  });

  it("an AUDIT-ONLY boundary uses the audit bid and has no nonce gap at all", async () => {
    /**
     * Nothing owed, so no payment bundle exists. Worth its own case because it is the ONE
     * shape where the split path has no structural weakness: the audit's nonces start at the
     * chain's own next nonce, so the bundle is standalone-valid and does not depend on a
     * builder having placed anything first.
     */
    ownedLep = TARGET_EPOCH; // current: nothing to pay
    await raceTheBoundary();
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay");
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit");
    expect(pay).toHaveLength(0);
    expect(audit.length).toBeGreaterThan(0);
    // First nonce is the chain's next — no gap for a builder to trip over.
    expect(Math.min(...wireTxs().map((t) => t.nonce))).toBe(chainNonce);
    // And it bids the AUDIT amount, not the payment one.
    const bids = bundles().flatMap((b) => b.txs.filter((t) => kindOf(t.sel) === "bid"));
    expect(bids.length).toBeGreaterThan(0);
    expect(bids.every((b) => Math.abs(b.valueEth - AUDIT_BID) < 1e-9)).toBe(true);
  });

  it("a PAYMENT-ONLY boundary bids the payment amount and sends no audit", async () => {
    // No auditable rival, so the audit fire has nothing to do. The payment must still go out
    // with its own bid — widening or narrowing the offense half must never gate a payment.
    vi.mocked(contract.batchGetTargetStatuses).mockResolvedValue([] as never);
    await raceTheBoundary();
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay");
    expect(pay).toHaveLength(5);
    expect(wireTxs().filter((t) => kindOf(t.sel) === "audit")).toHaveLength(0);
    const bids = bundles().flatMap((b) => b.txs.filter((t) => kindOf(t.sel) === "bid"));
    expect(bids.length).toBeGreaterThan(0);
    expect(bids.every((b) => Math.abs(b.valueEth - PAY_BID) < 1e-9)).toBe(true);
  });

  it("does not collide when the payments are PRIVATE and the node has never seen them", async () => {
    /**
     * The epoch-184 collision, reproduced.
     *
     * On a race the mirror is held behind the pre-boundary gate, so between the two fires the
     * payments exist ONLY inside private bundles — getTransaction finds nothing. The nonce
     * manager used to be told those txs were "mirrored", so absence read as DEAD and it handed
     * the payment nonce straight back to the audit fire. Nonce 11969 was signed twice and the
     * audit died (0x56bf216e...).
     *
     * A gated race tx is now recorded as private, so absence proves nothing until its target
     * blocks have passed, and the reservation holds.
     */
    const { publicClient } = await import("./chain.js");
    vi.mocked(publicClient.getTransaction).mockRejectedValue(
      new Error("Transaction could not be found"),
    );

    await firePreBoundaryPay();
    await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY_TS });
    await awaitPendingMirrors();

    const nonces = wireTxs().map((t) => t.nonce);
    // Non-vacuity: both halves must actually have gone out, or "no collision" is trivial.
    expect(wireTxs().filter((t) => kindOf(t.sel) === "pay")).toHaveLength(5);
    expect(wireTxs().filter((t) => kindOf(t.sel) === "audit")).toHaveLength(5);
    expect(new Set(nonces).size).toBe(nonces.length);
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay").map((t) => t.nonce);
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit").map((t) => t.nonce);
    expect(Math.max(...pay)).toBeLessThan(Math.min(...audit));
  });

  it("does not collide when the audit fire is delayed well past the payment", async () => {
    // The epoch-176 shape: a gap between the two fires long enough that a stopwatch-based
    // nonce release would have let go of the payment's reservation. Evidence-based release
    // must hold it because the mirrored payments read as pending.
    await firePreBoundaryPay();
    await new Promise((r) => setTimeout(r, 60));
    await firePreBoundaryAudit({ targetEpoch: TARGET_EPOCH, boundaryTs: BOUNDARY_TS });
    await awaitPendingMirrors();
    const nonces = wireTxs().map((t) => t.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay").map((t) => t.nonce);
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit").map((t) => t.nonce);
    expect(Math.max(...pay)).toBeLessThan(Math.min(...audit));
  });
});


/**
 * `auditBundleAllOrNothing` — an empty `revertingTxHashes` on the AUDIT bundle.
 *
 * The advice this implements was "send with 0 reverting hashes so you never pay gas for a
 * reverting audit", and it is right about the economics: a reverted audit costs gas AND raises
 * the block's value to the builder that ordered you last. It is only safe scoped to a bundle
 * with no payment in it, which is why every case here also pins down what the PAYMENT bundle
 * looks like — that half must be provably untouched.
 *
 * `revertingTxHashes` is a list of transactions ALLOWED to revert, so the assertions are about
 * what is absent from it. Hence revertKinds: an assertion on raw hashes could pass while naming
 * the wrong transaction.
 */
describe("auditBundleAllOrNothing", () => {
  it("SHIPS on — the audit bundle is all-or-nothing unless an operator turns it off", () => {
    // This block's fixture pins the setting off (see the note at the top of the file), so
    // the case below tests the OFF behaviour rather than the default. Assert the default
    // separately, or the rename would quietly lose the only check on which way it ships.
    expect(DEFAULT_STRATEGY.auditBundleAllOrNothing).toBe(true);
    expect(DEFAULT_STRATEGY.mirrorAudits).toBe(false);
  });

  it("off, every audit is named as allowed to revert", async () => {
    await raceTheBoundary();
    expect(auditBundles().length).toBeGreaterThan(0);
    for (const b of auditBundles()) {
      expect(kindsIn(b).filter((k) => k === "audit")).toHaveLength(5); // non-vacuity
      expect(b.revertKinds.filter((k) => k === "audit")).toHaveLength(5);
    }
  });

  it("on, the audit bundle permits no audit to revert at all", async () => {
    runtime.strategy = { ...runtime.strategy, auditBundleAllOrNothing: true };
    await raceTheBoundary();
    expect(auditBundles().length).toBeGreaterThan(0);
    for (const b of auditBundles()) {
      // Non-vacuity first: the audits must actually be in the bundle, or "none may revert" is
      // trivially true of an empty bundle.
      expect(kindsIn(b).filter((k) => k === "audit")).toHaveLength(5);
      expect(b.revertKinds).not.toContain("audit");
      // A hash naming a tx outside this bundle would let a builder include a reverting audit.
      expect(b.revertKinds).not.toContain("FOREIGN");
    }
  });

  it("still lets the audit bundle's own coinbase bid revert", async () => {
    /**
     * The one carve-out, and it is deliberate: the bid is a plain ETH transfer from a payer
     * contract the operator configures separately. Making it mandatory would mean a funding or
     * payer mistake drops five healthy audits, which is a failure mode the setting is not for.
     * So the bid stays the only permitted revert, and the audits are the mandatory part.
     */
    runtime.strategy = { ...runtime.strategy, auditBundleAllOrNothing: true };
    await raceTheBoundary();
    for (const b of auditBundles()) {
      expect(kindsIn(b).filter((k) => k === "bid")).toHaveLength(1);
      expect(b.revertKinds).toEqual(["bid"]);
    }
  });

  it("does not change the PAYMENT bundle's revert list", async () => {
    /**
     * The assertion the whole feature rests on, run as a real before/after rather than an
     * inspection: two boundaries in one test, identical but for the flag, comparing the payment
     * half of each. The standing requirement is that nothing here reaches the payment pathway.
     */
    await raceTheBoundary();
    const before = payBundles().map((b) => [...b.revertKinds].sort().join(","));
    const paymentsBefore = payBundles().map((b) => kindsIn(b).filter((k) => k === "pay").length);

    resetWire();
    runtime.strategy = { ...runtime.strategy, auditBundleAllOrNothing: true };
    await raceTheBoundary();
    const after = payBundles().map((b) => [...b.revertKinds].sort().join(","));

    expect(before.length).toBeGreaterThan(0);
    expect(paymentsBefore.every((n) => n === 5)).toBe(true); // non-vacuity
    expect(after).toEqual(before);
    // And the audit half DID change, or the comparison above proves nothing about scoping.
    expect(auditBundles().length).toBeGreaterThan(0);
    for (const b of auditBundles()) expect(b.revertKinds).not.toContain("audit");
  });
});

/**
 * The scoping guarantee: `auditBundleAllOrNothing` must never reach a bundle carrying a payment.
 *
 * Fused, the audits ride the SAME bundle as the payments. All-or-nothing there would mean one
 * rival curing inside the boundary block drops every payment — gas on a failed audit traded for
 * citizens going unpaid, at the one block where that is most expensive. So the fused path ignores
 * the setting entirely, and the audits stay named as allowed-to-revert.
 *
 * This exists because a mutation that wired the setting into the fused branch survived the entire
 * suite. The property was believed, documented, and untested.
 */
describe("auditBundleAllOrNothing never reaches a bundle with a payment in it", () => {
  /** Fusion needs the toggle ON and a funded bid; both bids are funded in this file already. */
  const fuse = (extra: Partial<typeof runtime.strategy> = {}) => {
    runtime.strategy = { ...runtime.strategy, combinedBoundaryBundle: true, ...extra };
    expect(combinedBundleActive(runtime.strategy)).toBe(true); // guard: this really is fused
  };

  it("keeps the audits revert-tolerant in a fused bundle, even with the setting on", async () => {
    fuse({ auditBundleAllOrNothing: true });
    await raceTheBoundaryFused();
    const fused = bundles().filter((b) => kindsIn(b).includes("pay") && kindsIn(b).includes("audit"));
    // Non-vacuity: there must BE a fused bundle, with both halves in it, or the assertion below
    // is about nothing. This is the shape the setting must not affect.
    expect(fused.length).toBeGreaterThan(0);
    for (const b of fused) {
      expect(kindsIn(b).filter((k) => k === "pay")).toHaveLength(5);
      const audits = kindsIn(b).filter((k) => k === "audit").length;
      expect(audits).toBeGreaterThan(0);
      // Every audit sharing the bundle is allowed to revert, so none of them can drop a payment.
      expect(b.revertKinds.filter((k) => k === "audit")).toHaveLength(audits);
    }
  });

  it("is identical fused whether the setting is on or off", async () => {
    // A direct before/after on the wire: if the setting had any effect on a fused boundary, the
    // permitted-revert lists would differ.
    fuse({ auditBundleAllOrNothing: false });
    await raceTheBoundaryFused();
    const off = bundles().map((b) => [...b.revertKinds].sort().join(","));
    expect(off.length).toBeGreaterThan(0);

    resetWire();
    fuse({ auditBundleAllOrNothing: true });
    await raceTheBoundaryFused();
    expect(bundles().map((b) => [...b.revertKinds].sort().join(","))).toEqual(off);
  });
});

/**
 * `mirrorAudits` — whether offense is announced in the public mempool before the block is built.
 *
 * On, the mempool copy is the only thing that can land in a boundary block built by a solo
 * validator (~1 in 10 — no such block accepts bundles from anyone). Off, a defender reading the
 * mempool cannot see the target list in advance.
 *
 * What must NOT change is the payment mirror. Payments mirror unconditionally, because that copy
 * is the fallback that keeps citizens alive when no builder takes the bundle.
 */
describe("mirrorAudits", () => {
  it("off, no audit reaches the mempool but every payment still does", async () => {
    runtime.strategy = { ...runtime.strategy, mirrorAudits: false };
    await raceTheBoundary();
    expect(mirroredKinds()).toEqual(["pay", "pay", "pay", "pay", "pay"]);
    // The audits still went out — privately. Without this the case would also pass if the
    // audit fire had simply done nothing.
    expect(wireTxs().filter((t) => kindOf(t.sel) === "audit")).toHaveLength(5);
  });

  it("on, both halves mirror — the behaviour it defaults to", async () => {
    runtime.strategy = { ...runtime.strategy, mirrorAudits: true };
    await raceTheBoundary();
    const k = mirroredKinds();
    expect(k.filter((x) => x === "pay")).toHaveLength(5);
    expect(k.filter((x) => x === "audit")).toHaveLength(5);
  });
});

/**
 * "Thor Mode" — one switch for a fully private, fully split boundary.
 *
 * Named for the case it exists to answer: an operator whose targets are cured inside the boundary
 * block, boundary after boundary, by someone reading the mempool. It is a preset, not a mode the
 * engine branches on — the overrides are folded into the stored config, so `runtime.strategy` is
 * always the effective config and no reader has to know Thor Mode exists. That is also what stops
 * the dashboard showing a ticked box the engine is ignoring.
 */
describe("Thor Mode", () => {
  it("is the identity when off, and forces all four when on", () => {
    const base = {
      ...DEFAULT_STRATEGY, thorMode: false, mirrorAudits: true,
      racePublicMempool: true, combinedBoundaryBundle: true, auditBundleAllOrNothing: false,
    };
    expect(applyThorMode(base)).toBe(base); // same object: cheap and safe to call on every save
    const on = applyThorMode({ ...base, thorMode: true });
    // Spelled out rather than compared against THOR_OVERRIDES. Asserting the output against the
    // table that produced it is tautological — a mutation dropping mirrorAudits from the table
    // changed both sides of the comparison and the test still passed.
    expect(on.mirrorAudits).toBe(false);
    expect(on.racePublicMempool).toBe(false);
    expect(on.combinedBoundaryBundle).toBe(false);
    expect(on.auditBundleAllOrNothing).toBe(true);
    expect(thorModeSettled(on)).toBe(true);
    expect(thorModeSettled(base)).toBe(false);
    // Untouched: the payment path has no business in this preset.
    expect(on.preBoundaryPay).toBe(base.preBoundaryPay);
    expect(on.priorityFeeGwei).toBe(base.priorityFeeGwei);
  });

  it("pins the override table itself — exactly six fields, exactly these values", () => {
    expect(THOR_OVERRIDES).toEqual({
      mirrorAudits: false,
      racePublicMempool: false,
      combinedBoundaryBundle: false,
      auditBundleAllOrNothing: true,
      mirrorPayments: false,
      paymentBundleAllOrNothing: true,
    });
    // No seventh field can be added silently: Thor Mode writes whatever is in here, so a stray
    // entry would change a boundary without anything else in the codebase mentioning it. The
    // two payment entries are the ones that make this check matter rather than tidy — they are
    // the only flags in the table that can cost a citizen instead of an audit.
    expect(Object.keys(THOR_OVERRIDES).sort()).toEqual([
      "auditBundleAllOrNothing", "combinedBoundaryBundle", "mirrorAudits", "mirrorPayments",
      "paymentBundleAllOrNothing", "racePublicMempool",
    ]);
  });

  it("overrides a fused bundle even when the operator left fusion ticked on", () => {
    runtime.strategy = applyThorMode({
      ...runtime.strategy, thorMode: true, combinedBoundaryBundle: true,
      coinbaseBidEth: PAY_BID, coinbasePayerAddress: PAYER,
    });
    // A funded bid plus fusion ON would normally fuse. Thor Mode splits it, and the engine's own
    // predicate has to agree — a preset the engine disagreed with would be worse than no preset.
    expect(combinedBundleActive(runtime.strategy)).toBe(false);
  });

  it("saveStrategy folds the overrides in, so the stored config IS the effective one", () => {
    runtime.strategy = {
      ...runtime.strategy, thorMode: false, mirrorAudits: true,
      racePublicMempool: true, combinedBoundaryBundle: true, auditBundleAllOrNothing: false,
    };
    const saved = runtime.saveStrategy({ thorMode: true });
    for (const cfg of [saved, runtime.strategy]) {
      expect(cfg.mirrorAudits).toBe(false);
      expect(cfg.racePublicMempool).toBe(false);
      expect(cfg.combinedBoundaryBundle).toBe(false);
      expect(cfg.auditBundleAllOrNothing).toBe(true);
    }
    expect(thorModeSettled(runtime.strategy)).toBe(true);
  });

  it("produces a split, offense-private, all-or-nothing boundary on the wire", async () => {
    /**
     * The end-to-end shape, because the three settings are only worth one switch if they compose.
     * Asserted on what a builder and the mempool actually receive, not on the config.
     */
    runtime.strategy = applyThorMode({ ...runtime.strategy, thorMode: true });
    await raceTheBoundary();

    // 1. Split: no bundle carries both halves, so audit density cannot dilute the payment's.
    expect(bundles().length).toBeGreaterThan(0);
    for (const b of bundles()) {
      expect(kindsIn(b).includes("pay") && kindsIn(b).includes("audit")).toBe(false);
    }
    // 2. NOTHING is mirrored — payments included. This is the escalation: the mode used to
    //    close the offense leak only, and payments kept a fallback that could still land them
    //    when no builder we sent to won the slot. Now a lost slot means no payment at all.
    expect(mirroredKinds()).toEqual([]);
    // 3. The audit bundle is all-or-nothing (bid excepted), so a cured target costs nothing.
    expect(auditBundles().length).toBeGreaterThan(0);
    for (const b of auditBundles()) {
      expect(kindsIn(b).filter((k) => k === "audit")).toHaveLength(5);
      expect(b.revertKinds).not.toContain("audit");
    }
    // 3b. And so is the PAYMENT bundle, which is only coherent because of (2): while payments
    //     mirror, dropping the bundle saves nothing because the mirrored copy still reverts.
    const payBundles = bundles().filter((b) => kindsIn(b).includes("pay"));
    expect(payBundles.length).toBeGreaterThan(0);
    for (const b of payBundles) {
      expect(kindsIn(b).filter((k) => k === "pay")).toHaveLength(5); // non-vacuity
      expect(b.revertKinds).not.toContain("pay");
    }
    // 4. Still no nonce collision and no gap — the guarantees the rest of this file establishes
    //    have to survive the preset, since it changes which txs are mirrored and that is exactly
    //    what the nonce manager's evidence check reads.
    const nonces = wireTxs().map((t) => t.nonce).sort((a, b) => a - b);
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(nonces[nonces.length - 1]! - nonces[0]!).toBe(nonces.length - 1);
    const pay = wireTxs().filter((t) => kindOf(t.sel) === "pay").map((t) => t.nonce);
    const audit = wireTxs().filter((t) => kindOf(t.sel) === "audit").map((t) => t.nonce);
    expect(Math.max(...pay)).toBeLessThan(Math.min(...audit));
  });
});

/**
 * The payment half of Thor Mode.
 *
 * These two settings are the only ones in the preset that can cost a CITIZEN rather than an
 * audit, so they get their own coverage rather than riding on the end-to-end shape test.
 *
 * The property that matters most is the DEPENDENCY between them: all-or-nothing on a bundle
 * whose transactions are also being broadcast is not a safety feature, it is a way to pay the
 * gas twice over. If a refactor ever lets paymentBundleAllOrNothing take effect while payments
 * still mirror, the setting silently becomes worse than useless.
 */
describe("payment privacy and revert economics", () => {
  const payBundles = () => bundles().filter((b) => kindsIn(b).includes("pay"));

  it("defaults leave the payment path exactly as it was", () => {
    expect(DEFAULT_STRATEGY.mirrorPayments).toBe(true);
    expect(DEFAULT_STRATEGY.paymentBundleAllOrNothing).toBe(false);
  });

  it("mirrors payments and keeps them revert-tolerant by default", async () => {
    await raceTheBoundary();
    expect(mirroredKinds().filter((k) => k === "pay")).toHaveLength(5);
    for (const b of payBundles()) {
      expect(b.revertKinds.filter((k) => k === "pay")).toHaveLength(5);
    }
  });

  it("mirrorPayments off makes the payment bundle the only copy", async () => {
    runtime.strategy = { ...runtime.strategy, mirrorPayments: false };
    await raceTheBoundary();
    expect(mirroredKinds().filter((k) => k === "pay")).toHaveLength(0);
    // Non-vacuity: the payments must still be REACHING a builder, or "not mirrored" is
    // indistinguishable from "never sent".
    expect(payBundles().length).toBeGreaterThan(0);
    for (const b of payBundles()) {
      expect(kindsIn(b).filter((k) => k === "pay")).toHaveLength(5);
    }
  });

  it("paymentBundleAllOrNothing drops every payment from the permitted-revert list", async () => {
    runtime.strategy = {
      ...runtime.strategy, mirrorPayments: false, paymentBundleAllOrNothing: true,
    };
    await raceTheBoundary();
    expect(payBundles().length).toBeGreaterThan(0);
    for (const b of payBundles()) {
      expect(kindsIn(b).filter((k) => k === "pay")).toHaveLength(5); // non-vacuity
      expect(b.revertKinds).not.toContain("pay");
    }
  });

  it("leaves the payment bundle's own coinbase bid revert-tolerant", async () => {
    // Same carve-out the audit bundle gets: a misconfigured payer must never be able to drop
    // five healthy payments. The bid is the one tx in the bundle that is allowed to fail.
    runtime.strategy = {
      ...runtime.strategy, mirrorPayments: false, paymentBundleAllOrNothing: true,
    };
    await raceTheBoundary();
    const withBid = payBundles().filter((b) => kindsIn(b).includes("bid"));
    expect(withBid.length).toBeGreaterThan(0);
    for (const b of withBid) expect(b.revertKinds).toContain("bid");
  });

  it("Thor Mode turns both on together, never one without the other", () => {
    // The dependency, asserted on the preset rather than on prose. All-or-nothing while
    // mirroring is the failure mode this pairing exists to make unreachable.
    const on = applyThorMode({ ...DEFAULT_STRATEGY, thorMode: true });
    expect(on.mirrorPayments).toBe(false);
    expect(on.paymentBundleAllOrNothing).toBe(true);
    expect(THOR_OVERRIDES.paymentBundleAllOrNothing && !THOR_OVERRIDES.mirrorPayments).toBe(true);
  });
});
