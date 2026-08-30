import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * The mid-epoch offense sweep: who it audits (sweepUnpinned) and what it pays (sweepNormalGas).
 *
 * Both settings exist because audit capacity is per-epoch and expires unused. Auditability can
 * only SHRINK as an epoch runs — currentEpoch is fixed while lastEpochPaid rises — so a slot
 * held back mid-epoch is a slot spent on nobody, and a mid-epoch audit is contesting nobody
 * either (the rivals who meant to cure did it at the boundary).
 *
 * Deliberately runs the REAL flashbots + nonce modules so every assertion reads the priority fee
 * off the WIRE in gwei, not a `normalGas: true` flag. The flag being plumbed through is not the
 * claim being made here — the price is.
 *
 * The invariants worth breaking a build over:
 *  - widening finds unpinned rivals, but PINNED targets still get the scarce slots first;
 *  - sweepUnpinned off means an unpinned rival is never touched (the pre-widening behaviour);
 *  - allies are never audited, by either path, at any width;
 *  - KILLS stay pinned-only even when the audit sweep is wide (a kill is a real race);
 *  - inside the pre-boundary quiet window the sweep reverts to race gas, because a cheap tx
 *    still pending at the boundary holds a nonce the payment cannot be mined ahead of.
 */

const GAME = "0x00000000000000000000000000000000000000aa" as const;
const ADDR = "0x1111111111111111111111111111111111111111" as const;
const RIVAL_OWNER = "0x00000000000000000000000000000000000000dd" as const;
const EPOCH_SECONDS = 86_400n;
const CURRENT_EPOCH = 200n;

const OWNED = [10n, 20n];
const ALLY = 900n;
const OFFENSE_TIP_GWEI = 131;
const SUGGESTED_TIP_GWEI = 3; // node's suggestion; normalFees adds +1

/** Per-test knobs, read at call time by the mocks below. */
let auditLimit = 1n;
let auditsUsed = 0n;
let candidateIds: bigint[] = [];
let auditableIds = new Set<string>();
let killableIds = new Set<string>();
let chainNonce = 500;

const sendRawTransaction = vi.fn(async () => "0xmirror" as `0x${string}`);

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 1_000n),
    getTransactionCount: vi.fn(async () => chainNonce),
    estimateGas: vi.fn(async () => 130_409n),
    estimateMaxPriorityFeePerGas: vi.fn(async () => BigInt(SUGGESTED_TIP_GWEI) * 1_000_000_000n),
    request: vi.fn(async () => "0x"),
    call: vi.fn(async () => ({ data: "0x" })),
    sendRawTransaction,
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1_001n, transactionIndex: 0 })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? auditLimit
          : c.functionName === "auditsUsedInEpoch" ? auditsUsed
          : c.functionName === "auditDueTimestamp" ? 0n
          : CURRENT_EPOCH, // lastEpochPaid: our own citizens are current, so they may audit
      })),
    ),
  },
  getLatestBlockCached: vi.fn(async () => ({
    baseFeePerGas: 1_000_000_000n, number: 1_000n, gasUsed: 0n, gasLimit: 30_000_000n,
  })),
  getBalanceCached: vi.fn(async () => 100_000_000_000_000_000_000n),
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
    state: 1, currentEpoch: CURRENT_EPOCH, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  // Maps over the candidates it was GIVEN, in order — so the order the sweep considers
  // targets in is observable, which is what the pinned-first assertion rests on.
  batchGetTargetStatuses: vi.fn(async (tokens: { id: bigint }[]) =>
    tokens.map(({ id }) => {
      const key = id.toString();
      return {
        tokenId: key, owner: RIVAL_OWNER,
        lastEpochPaid: (CURRENT_EPOCH - 2n).toString(),
        delinquent: true, epochsBehind: 2,
        auditable: auditableIds.has(key),
        auditDueTimestamp: "0",
        killable: killableIds.has(key),
      };
    }),
  ),
  filterLiveTokenIds: vi.fn(async (_c: unknown, ids: bigint[]) =>
    ids.map((id) => ({ id, owner: RIVAL_OWNER as `0x${string}` })),
  ),
  encodePayTaxes: vi.fn(() => "0x99999999"),
  // Encodes BOTH sides into the 4-byte selector slot so the wire says who audited whom:
  // "<auditor:2><target:6>". Real calldata carries them as args, which fakeSign truncates.
  encodeAudit: vi.fn((from: bigint, target: bigint) =>
    `0x${from.toString(16).padStart(2, "0")}${target.toString(16).padStart(6, "0")}`),
  encodeKill: vi.fn((target: bigint) => `0xdd${target.toString(16).padStart(6, "0")}`),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 0n),
  gameContract: { address: GAME, abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => OWNED),
  fetchCandidateTokenIds: vi.fn(async () => candidateIds),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
const warns: string[] = [];
const debugs: string[] = [];
vi.mock("./logger.js", () => ({
  logger: {
    warn: vi.fn((...a: unknown[]) => { warns.push(a.join(" ")); }),
    debug: vi.fn((...a: unknown[]) => { debugs.push(a.join(" ")); }),
    info: vi.fn(), error: vi.fn(),
  },
}));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));
// The ally roster is the one hard block on targeting, so it must be a real input here.
// loadAllyTokens reads data/ally-tokens.json from the (deliberately nonexistent) scratch
// dataDir, so it is overridden rather than faked through the filesystem. Spreading the real
// module keeps the `runtime` singleton identity strategy.ts shares with this test.
vi.mock("./runtime.js", async (orig) => ({
  ...(await orig<typeof import("./runtime.js")>()),
  loadAllyTokens: vi.fn(() => [ALLY.toString()]),
}));

// Deliberately NOT mocking ./flashbots.js or ./nonce.js — the price on the wire is the test.
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { startEngine, stopEngine } = await import("./strategy.js");

/** The fake signed payload carries selector + tip, so assertions read the wire. */
const fakeSign = (sel: string, tipGwei: number): `0x${string}` =>
  `0x${sel}${Math.round(tipGwei).toString(16).padStart(6, "0")}${"cd".repeat(23)}` as `0x${string}`;

/** Every tx that reached a builder, de-duplicated across the two-block fan-out. */
function wireTxs(): { auditor: string; target: string; tipGwei: number; kill: boolean }[] {
  const seen = new Map<string, { auditor: string; target: string; tipGwei: number; kill: boolean }>();
  for (const call of vi.mocked(globalThis.fetch).mock.calls) {
    let body: { method?: string; params?: { txs?: string[] }[] } | null = null;
    try { body = JSON.parse(String((call[1] as RequestInit).body)); } catch { continue; }
    if (body?.method !== "eth_sendBundle") continue; // skips the eth_callBundle simulations
    for (const t of body.params?.[0]?.txs ?? []) {
      const sel = t.slice(2, 10);
      seen.set(t, {
        auditor: String(parseInt(sel.slice(0, 2), 16)),
        target: String(parseInt(sel.slice(2, 8), 16)),
        tipGwei: parseInt(t.slice(10, 16), 16),
        kill: sel.startsWith("dd"),
      });
    }
  }
  return [...seen.values()];
}
const auditedTargets = () => wireTxs().filter((t) => !t.kill).map((t) => t.target).sort();

/** One immediate tick of the engine, which is what runs the sweep. */
async function sweep(): Promise<void> {
  startEngine();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 1h into epoch 200 (startTime 0) — far from any boundary, so the quiet window is off.
  vi.setSystemTime(Number(EPOCH_SECONDS * (CURRENT_EPOCH - 1n) + 3600n) * 1000);
  chainNonce += 50; // past any nonce ceiling a previous case reserved
  auditLimit = 1n;
  auditsUsed = 0n;
  warns.length = 0;
  debugs.length = 0;
  candidateIds = [501n, 502n, 503n, ALLY];
  auditableIds = new Set(["501", "502", "503", ALLY.toString()]);
  killableIds = new Set();

  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; maxPriorityFeePerGas: bigint }) =>
      fakeSign(tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "00000000",
        Number(tx.maxPriorityFeePerGas) / 1e9)),
    signMessage: vi.fn(async () => "0xsig"),
  } as unknown as PrivateKeyAccount;
  runtime.setWallets([{ account, label: "t", balanceWei: 100_000_000_000_000_000_000n }]);

  runtime.running = false;
  runtime.gameState = 1;
  runtime.currentEpoch = CURRENT_EPOCH;
  runtime.startTime = 0n;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.citizenSupply = 500n;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    enabled: false,        // defense off: this file is only about the offense sweep
    jitEnabled: false,
    offenseEnabled: true,
    autoAudit: true,
    autoKill: false,
    endgameOnlyWithin: null,
    offenseTargetTokenIds: ["501"],
    sweepUnpinned: true,
    sweepNormalGas: true,
    separateOffenseGas: true,
    offensePriorityFeeGwei: OFFENSE_TIP_GWEI,
    offenseDynamicTipEnabled: false,
    offenseMaxBaseFeeGwei: 305,
    minBalanceEth: 0,
    maxPaymentEth: 0,
    racePublicMempool: true,
  } as typeof runtime.strategy;
});

afterEach(() => {
  stopEngine();
  vi.useRealTimers();
  runtime.setWallets([]);
});

describe("sweepUnpinned — widening the mid-epoch sweep past the target list", () => {
  it("audits rivals that are NOT pinned once capacity allows", async () => {
    auditLimit = 2n; // 2 owned citizens x 2 = 4 slots for 3 auditable rivals
    await sweep();
    expect(auditedTargets()).toEqual(["501", "502", "503"]);
  });

  it("serves PINNED targets before anything the widening discovered", async () => {
    // The case that decides whether widening can cannibalise the list it was added to:
    // one slot, three auditable rivals, only one of them pinned.
    auditLimit = 1n;
    vi.mocked((await import("./index-tokens.js")).fetchOwnedTokenIds).mockResolvedValue([10n]);
    await sweep();
    expect(auditedTargets()).toEqual(["501"]);
  });

  it("touches nothing unpinned when sweepUnpinned is off (pre-widening behaviour)", async () => {
    runtime.strategy = { ...runtime.strategy, sweepUnpinned: false };
    auditLimit = 2n;
    await sweep();
    expect(auditedTargets()).toEqual(["501"]);
  });

  it("never audits an ALLY, however wide the sweep goes", async () => {
    auditLimit = 4n; // capacity for every candidate incl. the ally
    await sweep();
    expect(auditedTargets()).not.toContain(ALLY.toString());
    expect(auditedTargets()).toEqual(["501", "502", "503"]);
  });

  it("keeps KILLS pinned-only while the audit sweep is wide", async () => {
    // A kill is a genuine race against every other killer, so it keeps race gas — and
    // widening a race-gas action is a spend increase this feature is not.
    runtime.strategy = { ...runtime.strategy, autoKill: true };
    auditLimit = 2n;
    killableIds = new Set(["502"]); // killable, auditable, and NOT pinned
    await sweep();
    expect(wireTxs().filter((t) => t.kill)).toHaveLength(0);
  });

  it("still kills a PINNED target", async () => {
    runtime.strategy = { ...runtime.strategy, autoKill: true };
    killableIds = new Set(["501"]);
    await sweep();
    const kills = wireTxs().filter((t) => t.kill);
    expect(kills).toHaveLength(1);
    expect(kills[0]!.target).toBe("501");
  });
});

describe("sweepNormalGas — what a mid-epoch audit pays", () => {
  it("prices sweep audits at the node's suggestion PLUS 1 gwei, not the offense tip", async () => {
    await sweep();
    const audits = wireTxs().filter((t) => !t.kill);
    expect(audits.length).toBeGreaterThan(0);
    // The +1 is the point: priced exactly AT the suggestion a tx is a coin-flip per block,
    // and a sweep tx that lingers holds a nonce every later payment queues behind.
    expect(audits.every((a) => a.tipGwei === SUGGESTED_TIP_GWEI + 1)).toBe(true);
  });

  it("uses the offense race tip when sweepNormalGas is off", async () => {
    runtime.strategy = { ...runtime.strategy, sweepNormalGas: false };
    await sweep();
    const audits = wireTxs().filter((t) => !t.kill);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.tipGwei === OFFENSE_TIP_GWEI)).toBe(true);
  });

  it("reverts to race gas inside the pre-boundary quiet window", async () => {
    // 120s before the boundary that starts epoch 201. A cheap audit signed now could still
    // be pending when the boundary payment needs the next nonce from the same wallet, and
    // no tip on that payment can jump a lower nonce — so nothing cheap goes out here.
    //
    // 120 and not 60, because `sweep()` runs its tick through startEngine and a cold start
    // now DEFERS that tick within lead + 90s of an armed boundary (coldStartMustDeferTick) —
    // at 60s out there would be no sweep at all to price. 120s still sits inside the 180s
    // SWEEP_QUIET_WINDOW_SECONDS this test is about, so the property is unchanged; only the
    // vehicle moved. The bound from the other side is asserted by the next test.
    vi.setSystemTime(Number(EPOCH_SECONDS * CURRENT_EPOCH - 120n) * 1000);
    await sweep();
    const audits = wireTxs().filter((t) => !t.kill);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.tipGwei === OFFENSE_TIP_GWEI)).toBe(true);
  });

  it("is back to normal gas just outside the quiet window", async () => {
    // Bounds the window from the other side, so a mis-signed comparison that always
    // returns "in the window" can't pass the test above.
    vi.setSystemTime(Number(EPOCH_SECONDS * CURRENT_EPOCH - 600n) * 1000);
    await sweep();
    const audits = wireTxs().filter((t) => !t.kill);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.tipGwei === SUGGESTED_TIP_GWEI + 1)).toBe(true);
  });

  it("still mirrors a normal-gas sweep audit to the public mempool", async () => {
    // `race` is the mirror, not the tip. Cheapening the sweep must not silently drop the
    // path that lands an audit when no builder takes the bundle.
    await sweep();
    expect(sendRawTransaction).toHaveBeenCalled();
  });
});

/**
 * Widening the sweep to the whole field made the read cost matter: audit capacity is spent in
 * the first tick or two after a boundary, and the remaining ~7,000 ticks used to enumerate the
 * field and multicall a status for every rival only to find the auditor pool empty.
 */
describe("no-capacity short-circuit", () => {
  it("reads no candidates at all once capacity is spent and autoKill is off", async () => {
    auditsUsed = 1n; // limit 1, used 1 — every owned citizen is out of slots
    await sweep();
    const { fetchCandidateTokenIds } = await import("./index-tokens.js");
    const { batchGetTargetStatuses, filterLiveTokenIds } = await import("./contract.js");
    expect(fetchCandidateTokenIds).not.toHaveBeenCalled();
    expect(filterLiveTokenIds).not.toHaveBeenCalled();
    expect(batchGetTargetStatuses).not.toHaveBeenCalled();
    expect(wireTxs()).toHaveLength(0);
  });

  it("still reads candidates and kills when autoKill is on with no audit capacity", async () => {
    // The short-circuit's one dangerous failure mode: a kill needs no auditor, so skipping
    // the read on an empty pool must not skip kills — or an expired audit goes unpunished
    // for the rest of the epoch.
    auditsUsed = 1n;
    runtime.strategy = { ...runtime.strategy, autoKill: true };
    killableIds = new Set(["501"]);
    await sweep();
    const kills = wireTxs().filter((t) => t.kill);
    expect(kills).toHaveLength(1);
    expect(kills[0]!.target).toBe("501");
  });

  it("does not short-circuit while capacity remains", async () => {
    // Bounds the guard from the other side: an inverted comparison would skip every sweep.
    auditsUsed = 0n;
    await sweep();
    expect(auditedTargets().length).toBeGreaterThan(0);
  });
});

/**
 * The ally guard's REPORTING, which the widening broke.
 *
 * Widening the sweep past the pins makes the candidate set the whole live field, so it now
 * contains every teammate by construction. The guard still excluded them — but it warned
 * about it, once per tick, ~7,000 times a day, telling operators to "check your target list"
 * when their list was fine. That is worse than silence: it trains people to ignore a message
 * that DOES mean something when the ally is actually pinned.
 */
describe("reporting allied citizens the sweep skipped", () => {
  const allyWarning = () => warns.filter((w) => /ALLIED/i.test(w));

  it("does not warn when an ally merely turns up in the enumeration", async () => {
    auditLimit = 2n;
    await sweep();
    // Non-vacuity: the ally really was in the candidate set and really was excluded.
    expect(auditedTargets().length).toBeGreaterThan(0);
    expect(auditedTargets()).not.toContain(ALLY.toString());
    expect(allyWarning()).toEqual([]);
    // The skip is still recorded, just at debug level — silence would hide the guard working.
    expect(debugs.some((d) => /found by enumeration/i.test(d))).toBe(true);
  });

  it("DOES warn, naming the id, when an ally is on the target list", async () => {
    // The case the warning exists for: a teammate pinned as a target. Only this filter stops
    // the bot auditing them, so it has to be loud and it has to say which token.
    runtime.strategy = {
      ...runtime.strategy,
      offenseTargetTokenIds: ["501", ALLY.toString()],
    } as typeof runtime.strategy;
    auditLimit = 2n;
    await sweep();
    const w = allyWarning();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(new RegExp("#" + ALLY.toString()));
    expect(w[0]).toMatch(/remove them from the list/i);
    // Still never audited, warning or not.
    expect(auditedTargets()).not.toContain(ALLY.toString());
  });
});
