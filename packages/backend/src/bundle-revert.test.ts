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
vi.mock("./chain.js", () => ({
  publicClient: {
    getBlockNumber: vi.fn(async () => 100n),
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
    for: () => ({ reserve: () => nonceCounter++, peek: () => nonceCounter }),
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
  },
}));

const { submitTx, beginBundle, flushBundle } = await import("./flashbots.js");

/** Every eth_sendBundle body POSTed during a flush. */
function sentBundles(): { txs: `0x${string}`[]; revertingTxHashes?: `0x${string}`[]; blockNumber: string }[] {
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
