import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Bundle wire format: which txs are declared allowed-to-revert, and which get a public
 * mempool mirror.
 *
 * These two properties are what decide whether ONE bad payment costs a multi-citizen
 * holder their whole boundary. `eth_sendBundle` drops a bundle when any tx NOT listed in
 * `revertingTxHashes` reverts, so with payments unlisted, a single `AlreadyCurrent` takes
 * every healthy payment down with it — measured stakes: boundary blocks carry ~10 rival
 * audits (~4.7 at index <= 20), and a payment that misses the boundary block leaves its
 * citizen 2 epochs behind and auditable inside exactly that window. 28% of holders run 2+
 * citizens, so this is not an edge case.
 *
 * The fix cannot be "mark payments revertible", because `revertible` currently means two
 * things at once: allowed-to-revert AND bundle-only-never-mirrored. Payments need the
 * first and MUST keep the mirror — without it a payment that loses its slot never lands at
 * all, which is worse than the problem. So the two concepts are separated, and these tests
 * pin both halves independently.
 *
 * Asserted at the wire level (the eth_sendBundle params actually POSTed) rather than
 * through internal state, because that JSON is the contract with the builders.
 */

const BUILDERS = ["https://relay.flashbots.net", "https://rpc.titanbuilder.xyz"];

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    builderUrls: BUILDERS,
    flashbotsRelayUrl: "https://relay.flashbots.net",
    gameAddress: "0x00000000000000000000000000000000000000aa",
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

const sendRawTransaction = vi.fn(async () => "0xmirror");
/** Timestamp the mocked chain head reports. Drives the mirror gate. */
let headTs = 0n;
vi.mock("./chain.js", () => ({
  publicClient: {
    getBlockNumber: vi.fn(async () => 100n),
    getBlock: vi.fn(async () => ({ timestamp: headTs, baseFeePerGas: 1_000_000_000n })),
    sendRawTransaction,
    estimateGas: vi.fn(async () => 100_000n),
  },
  getLatestBlockCached: vi.fn(async () => ({
    baseFeePerGas: 1_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n,
  })),
}));

// Telemetry is fire-and-forget and irrelevant here; stub so it can't touch the disk.
vi.mock("./race-timing.js", () => ({ recordRaceSubmission: vi.fn() }));

const account = {
  address: "0x1111111111111111111111111111111111111111",
  // Signed payload must differ per nonce, or keccak collides and revertingTxHashes
  // can't distinguish the txs — which is the whole thing under test.
  signTransaction: vi.fn(async (tx: { nonce: number }) => `0x${"ab".repeat(31)}${tx.nonce.toString(16).padStart(2, "0")}` as `0x${string}`),
  signMessage: vi.fn(async () => "0xsig"),
} as unknown as PrivateKeyAccount;

vi.mock("./runtime.js", () => ({
  runtime: {
    strategy: {
      maxBaseFeeGwei: 1000, priorityFeeGwei: 30.1, dynamicTipEnabled: false, dynamicTipMaxGwei: 69.1,
      separateOffenseGas: false, offenseMaxBaseFeeGwei: 1000, offensePriorityFeeGwei: 20.1,
      offenseDynamicTipEnabled: false, offenseDynamicTipMaxGwei: 69.1,
    },
    primary: { account },
  },
}));

let nonceCounter = 0;
vi.mock("./nonce.js", () => ({
  nonces: {
    for: () => ({ reserve: () => nonceCounter++, peek: () => nonceCounter, markSigned: () => {} }),
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
  },
}));

const { submitTx, beginBundle, flushBundle, setRaceBoundary, awaitPendingMirrors, resetPendingMirrors } = await import("./flashbots.js");
const { publicClient } = await import("./chain.js");

/** Every eth_sendBundle body POSTed during a flush. */
function sentBundles(): { txs: `0x${string}`[]; revertingTxHashes?: `0x${string}`[]; blockNumber: string; minTimestamp?: number }[] {
  return vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle")
    .map((b) => b.params[0]);
}

const INTENT = {
  to: "0x00000000000000000000000000000000000000aa" as `0x${string}`,
  data: "0xdead" as `0x${string}`,
  value: 1n,
  gas: 100_000n,
};

/** Queue one tx into the open bundle. skipSim avoids the simulation round-trip, which
 *  is not what these tests are about. */
async function queue(opts: { revertible?: boolean; race?: boolean }) {
  return submitTx(INTENT, { account, skipSim: true, ...opts });
}

beforeEach(() => {
  nonceCounter = 0;
  sendRawTransaction.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("revertingTxHashes: only txs explicitly allowed to revert are listed", () => {
  it("lists nothing when every tx is mandatory", async () => {
    beginBundle();
    await queue({ race: true });
    await queue({ race: true });
    await flushBundle();
    const b = sentBundles()[0]!;
    expect(b.txs).toHaveLength(2);
    // Absent or empty both mean "all mandatory"; the param is omitted when empty.
    expect(b.revertingTxHashes ?? []).toHaveLength(0);
  });

  it("lists exactly the revertible txs, not all of them", async () => {
    beginBundle();
    await queue({ race: true });                      // mandatory
    await queue({ revertible: true, race: false }); // allowed to revert
    await flushBundle();
    const b = sentBundles()[0]!;
    expect(b.txs).toHaveLength(2);
    expect(b.revertingTxHashes ?? []).toHaveLength(1);
  });

  it("lists every tx when all are revertible, so the bundle can never be dropped", async () => {
    // The multi-payment case: with all payments revert-tolerant, one AlreadyCurrent no
    // longer takes the healthy payments down with it.
    beginBundle();
    await queue({ revertible: true, race: true });
    await queue({ revertible: true, race: true });
    await queue({ revertible: true, race: true });
    await flushBundle();
    const b = sentBundles()[0]!;
    expect(b.txs).toHaveLength(3);
    expect(b.revertingTxHashes ?? []).toHaveLength(3);
  });
});

// The decoupling. At THIS layer the two are already independent — `race` controls the
// mirror and `revertible` controls revert-tolerance, and flushBundle honours each on its
// own. These pin that, because the coupling lives one level up in strategy.ts's act(),
// which derives `race` FROM `revertible` and so cannot express "revert-tolerant but still
// mirrored" — exactly what a payment needs.
describe("mirror and revert-tolerance are independent at the bundle layer", () => {
  it("mirrors a revertible tx that asked to race — the payment case", async () => {
    beginBundle();
    await queue({ revertible: true, race: true });
    await flushBundle();
    expect(sentBundles()[0]?.revertingTxHashes ?? []).toHaveLength(1); // revert-tolerant
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);               // ...and still mirrored
  });

  it("does NOT mirror a revertible tx that did not race — the audit/bid case", async () => {
    beginBundle();
    await queue({ revertible: true, race: false });
    await flushBundle();
    expect(sentBundles()[0]?.revertingTxHashes ?? []).toHaveLength(1);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("mirrors a mandatory tx that asked to race", async () => {
    beginBundle();
    await queue({ race: true });
    await flushBundle();
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not mirror a tx that did not ask to race", async () => {
    beginBundle();
    await queue({ race: false });
    await flushBundle();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("mirrors only the racing txs in a mixed bundle", async () => {
    beginBundle();
    await queue({ revertible: true, race: true });   // payment: revert-tolerant + mirrored
    await queue({ revertible: true, race: false });  // audit: bundle-only
    await queue({ revertible: true, race: false });  // bid: bundle-only
    await flushBundle();
    expect(sentBundles()[0]?.revertingTxHashes ?? []).toHaveLength(3);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("bundle integrity is preserved by the change", () => {
  it("keeps txs in ascending nonce order", async () => {
    // A bundle executes in the given order and each account's txs must ascend by nonce.
    beginBundle();
    await queue({ race: true });
    await queue({ race: true });
    await queue({ race: true });
    await flushBundle();
    const b = sentBundles()[0]!;
    const nonceOf = (signed: string) => parseInt(signed.slice(-2), 16);
    const order = b.txs.map(nonceOf);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("fans the same bundle out to every configured builder", async () => {
    beginBundle();
    await queue({ race: true });
    await flushBundle();
    // Two builders x two target blocks.
    expect(sentBundles()).toHaveLength(BUILDERS.length * 2);
  });

  it("every listed reverting hash is a tx actually in the bundle", async () => {
    // A hash the bundle doesn't contain is meaningless to a builder and could mask a
    // signing/ordering mistake.
    beginBundle();
    await queue({ revertible: true, race: true });
    await queue({ race: true });
    await flushBundle();
    const b = sentBundles()[0]!;
    const { keccak256 } = await import("viem");
    const present = new Set(b.txs.map((t) => keccak256(t)));
    for (const h of b.revertingTxHashes ?? []) expect(present.has(h)).toBe(true);
  });
});

/**
 * `minTimestamp`: a pre-boundary race must not be executable before the boundary.
 *
 * A bundle is constrained by block NUMBER, but epoch advance — and therefore whether an
 * audit is valid at all — is a function of block TIMESTAMP. At the epoch-169 boundary that
 * gap cost a real audit: slot 23:59:23 was published ~8s LATE, after the 23:59:31.578
 * submission, so `targetBlock` named a PRE-boundary block. Quasar included the audit there
 * at index 5, the epoch was still 168, and it reverted — 0.024 ETH of gas plus the nonce,
 * which killed the copy aimed at the real boundary block one slot later.
 *
 * Asserted on the POSTed JSON because that is the contract with the builders.
 */
describe("minTimestamp: a race can never execute before its boundary", () => {
  const BOUNDARY = 1787011175n; // the epoch-169 boundary, 2026-08-17T23:59:35Z

  it("stamps the boundary on the bundle", async () => {
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    for (const b of sentBundles()) expect(b.minTimestamp).toBe(Number(BOUNDARY));
  });

  it("stamps BOTH target blocks, since the fan-out is what spans the boundary", async () => {
    // The pre-boundary block is only excluded if the constraint rides every copy — the
    // whole failure was one of the two target blocks being on the wrong side of it.
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    const blocks = new Set(sentBundles().map((b) => b.blockNumber));
    expect(blocks.size).toBe(2); // targetBlock and targetBlock + 1
    expect(sentBundles().every((b) => b.minTimestamp === Number(BOUNDARY))).toBe(true);
  });

  it("leaves an ordinary tick's batch unconstrained", async () => {
    // Only a race knows a boundary. Constraining a routine bundle would delay work that
    // has no timing requirement at all.
    beginBundle();
    await queue({ race: true });
    await flushBundle();
    for (const b of sentBundles()) expect(b.minTimestamp).toBeUndefined();
  });

  it("does not leak a stale boundary into the next batch", async () => {
    // beginBundle clears it. Now that the value bounds INCLUSION and not just telemetry, a
    // leaked one would silently hold a later bundle out of every block it could have won.
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();

    beginBundle(); // next tick, no race
    await queue({ race: true });
    await flushBundle();
    const second = sentBundles().slice(BUILDERS.length * 2);
    expect(second.length).toBeGreaterThan(0);
    for (const b of second) expect(b.minTimestamp).toBeUndefined();
  });

  it("reads the head UNCACHED when choosing the target block", async () => {
    // viem caches getBlockNumber for `cacheTime` (default = pollingInterval, 4s). This
    // fires ~3-5s before a boundary, so a cached head can be a block stale — which is how
    // the primary target came to name a block that was already mined.
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    expect(publicClient.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });
});

/**
 * The mempool mirror cannot carry `minTimestamp`, so the bundle guard does not protect it: a
 * builder is free to put a mirrored payment or audit in a PRE-boundary block, where the epoch
 * has not advanced and it reverts. Audit 0x44ce0008…b496 died exactly that way.
 *
 * So a race mirror is held until a block AT OR PAST the boundary exists. Waiting on the BLOCK
 * rather than the clock is the point: a late slot would sweep in any wall-clock lead.
 *
 * The threshold used to be one slot lower — release as soon as the PRE-boundary block appeared,
 * on the reasoning that a published block is sealed so the next must be the boundary block. The
 * epoch-184 boundary disproved it: payment 0xcdbc4cf6…8177 was aimed correctly at boundary block
 * 25885876 (the fan-out offered nothing lower) and still landed in 25885875 at boundary-12s,
 * where it reverted. Only the mirror is unconstrained by block number. Seeing a block does not
 * mean every builder has stopped competing for its slot.
 */
describe("mirror gate: a race mirror waits for a block at or past the boundary", () => {
  const BOUNDARY = 1787011175n; // 2026-08-17T23:59:35Z

  beforeEach(() => {
    // Controlled clock: the gate gives up once the boundary has passed, so with the real
    // clock (now well past this boundary) it would resolve instantly and prove nothing.
    vi.useFakeTimers();
    vi.setSystemTime(Number(BOUNDARY - 5n) * 1000); // mid-race, 5s out
    resetPendingMirrors(); // a gate left pending by a previous case must not be awaited here
  });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT broadcast while the head is still two slots back", async () => {
    // Precisely the epoch-169 situation: submitted with the pre-boundary slot unfilled.
    headTs = BOUNDARY - 24n;
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does NOT broadcast once the PRE-BOUNDARY block exists — it used to, and that cost a payment", async () => {
    /**
     * This case is inverted from what it originally asserted, and the inversion is the fix.
     *
     * The gate used to release here, reasoning that a published pre-boundary block is sealed so
     * the next block must be the boundary block. Payment 0xcdbc4cf6…8177 disproved it at the
     * epoch-184 boundary: the bundle fan-out correctly offered only 25885876 and up, yet the
     * transaction landed in 25885875 — stamped boundary-12s — and reverted. Only the mirror is
     * unconstrained by block number, so only the mirror could put it there. Seeing a block does
     * not mean every builder has stopped competing for that slot.
     */
    headTs = BOUNDARY - 12n;
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("holds through the whole pre-boundary slot — the epoch-184 regression", async () => {
    /**
     * Walks the head forward one slot at a time across the boundary, asserting the mirror stays
     * held for every pre-boundary state and goes out exactly once a block at or past the
     * boundary exists.
     *
     * A single-point check would not have caught the original bug: boundary-24s was already
     * asserted and passed, while boundary-12s — the state that actually cost the payment — was
     * asserted to broadcast.
     */
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();

    for (const offset of [-24n, -12n]) {
      headTs = BOUNDARY + offset;
      await vi.advanceTimersByTimeAsync(500);
      expect(sendRawTransaction, `must stay held at boundary${offset}s`).not.toHaveBeenCalled();
    }
    // The boundary block appears: now it is provably safe.
    headTs = BOUNDARY;
    await vi.advanceTimersByTimeAsync(500);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("gives up two slots past the boundary rather than stranding the mirror", async () => {
    // The backstop, raised from boundary+2s. It must not fire while the pre-boundary slot could
    // still be won — that is the same sweep the gate exists to prevent — but it must eventually
    // release so a stalled chain cannot hold the mirror forever.
    headTs = BOUNDARY - 12n; // boundary block never appears
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();

    vi.setSystemTime(Number(BOUNDARY + 12n) * 1000); // one slot past: still held
    await vi.advanceTimersByTimeAsync(500);
    expect(sendRawTransaction).not.toHaveBeenCalled();

    vi.setSystemTime(Number(BOUNDARY + 24n) * 1000); // two slots: the deadline
    await vi.advanceTimersByTimeAsync(500);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("gates the SINGLE-TX path too, not just the batched one", async () => {
    /**
     * Same guard, other code path. A pre-boundary race outside an open batch used to broadcast
     * its mirror immediately, so nothing stopped a builder taking the payment into a
     * pre-boundary block where it reverts with IncorrectPayment() and burns its nonce.
     *
     * A latent hole rather than an observed loss — every pre-boundary fire opens a batch, so
     * payments normally take the queued path — but the guard belongs with the broadcast, not
     * with whichever caller happens to reach it.
     *
     * No beginBundle() here: that is what routes submitTx down the single-tx path.
     */
    headTs = BOUNDARY - 12n; // pre-boundary: must stay held
    const r = await submitTx(INTENT, { account, skipSim: true, race: true, simTimestamp: BOUNDARY });
    expect(sendRawTransaction).not.toHaveBeenCalled();
    // ...and the caller must still see a live path, or it would retry and sign a second tx.
    expect(r.ok).toBe(true);

    headTs = BOUNDARY; // boundary block appears
    // The gate polls on a timer, and this describe runs on fake timers — step them rather
    // than awaiting, or the poll never fires and the test hangs instead of failing.
    await vi.advanceTimersByTimeAsync(500);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("still broadcasts the single-tx path immediately when it is NOT a boundary race", async () => {
    // Bounds the change: an ordinary race with no boundary to satisfy keeps its concurrent
    // broadcast, since delaying it buys nothing and costs latency.
    const r = await submitTx(INTENT, { account, skipSim: true, race: true });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("broadcasts when the boundary itself has already arrived", async () => {
    // Past the boundary every new block is at or after it, so holding buys nothing.
    headTs = BOUNDARY;
    beginBundle();
    setRaceBoundary(BOUNDARY);
    await queue({ race: true });
    await flushBundle();
    await awaitPendingMirrors();
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not gate an ordinary tick — no race, no wait", async () => {
    // beginBundle clears the boundary, so a routine bundle mirrors immediately as before.
    headTs = BOUNDARY - 24n;
    beginBundle();
    await queue({ race: true });
    await flushBundle();
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("still reports ok for a gated mirror, so the caller cannot double-pay", async () => {
    // ok gates whether jitPass marks a citizen handled. Reporting false for a mirror that has
    // merely not been SENT yet would make it retry on a fresh nonce and pay twice.
    headTs = BOUNDARY - 24n;
    beginBundle();
    setRaceBoundary(BOUNDARY);
    const r = await queue({ race: true });
    const out = await flushBundle();
    expect(sendRawTransaction).not.toHaveBeenCalled();       // genuinely still held
    expect(out.get(r.nonce)?.ok).toBe(true);
    expect(out.get(r.nonce)?.error).toBeUndefined();
    expect(out.get(r.nonce)?.predictedTxHash).toBeDefined(); // receipt is still trackable
  });
});
