import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Classifying a transaction that never produced a receipt.
 *
 * "Lost the race" and "can never land" are indistinguishable at the point the receipt wait
 * times out, and the difference is the whole story. Before this, both left the activity row
 * at "submitted" with a logger.warn — which is how the epoch-176 nonce collision went
 * unnoticed: a payment sat at "submitted" while the citizen it covered went unpaid, fell two
 * epochs behind, got audited, and cost double the tax to rescue by hand. Nothing in the feed
 * said the payment was dead.
 *
 * The chain can tell them apart. If it has moved PAST our nonce and our hash still has no
 * receipt, something else consumed that nonce and this transaction is permanently dead. If
 * the nonce is unconsumed, it is a dropped bundle that may yet land, and guessing either way
 * would be worse than saying nothing.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const GAME = "0x00000000000000000000000000000000000000aa" as const;
const HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const;

let chainNonce = 100;
const added: { kind?: string; status?: string; message?: string }[] = [];
const updated: { id: string; patch: Record<string, unknown> }[] = [];

vi.mock("./chain.js", () => ({
  publicClient: {
    // Never resolves to a receipt — the case under test is the timeout path.
    waitForTransactionReceipt: vi.fn(async () => { throw new Error("timed out"); }),
    getTransactionCount: vi.fn(async () => chainNonce),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 10_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    multicall: vi.fn(async () => []),
  },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })),
  getBalanceCached: vi.fn(async () => 10_000_000_000_000_000_000n),
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
    state: 1, currentEpoch: 200n, citizenSupply: 500n,
    citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async () => []),
  encodePayTaxes: vi.fn(() => "0x11111111"),
  encodeAudit: vi.fn(() => "0x22222222"),
  encodeKill: vi.fn(() => "0x33333333"),
  encodeUseBribe: vi.fn(() => "0x44444444"),
  estimateTaxes: vi.fn(async () => 100_000_000_000_000_000n), // 0.1 ETH owed
  gameContract: { address: GAME, abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [10n]),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: {
    add: vi.fn((e: Record<string, unknown>) => { added.push(e); return { id: "e1" }; }),
    update: vi.fn((id: string, patch: Record<string, unknown>) => { updated.push({ id, patch }); }),
    recent: vi.fn(() => []),
  },
}));
vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));
vi.mock("./emigration.js", () => ({ emigratedTokenIdSet: vi.fn(async () => new Set<string>()) }));
vi.mock("./nonce.js", () => ({
  nonces: {
    for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 100), reserve: vi.fn(() => 100), markSigned: vi.fn() })),
    syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn(),
  },
}));

// A submit that "succeeds" into a bundle but whose tx never mines — the shape both users saw.
vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async () => ({
    ok: true, simulated: true, txHash: HASH, nonce: 100,
    valueWei: 0n, gasWei: 0n, predictedTxHash: HASH,
  })),
  beginBundle: vi.fn(), flushBundle: vi.fn(async () => new Map()),
  queueCoinbaseBid: vi.fn(async () => false), setRaceBoundary: vi.fn(),
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { manualPayToCurrent } = await import("./strategy.js");
const { publicClient } = await import("./chain.js");
const { submitTx } = await import("./flashbots.js");

/** The receipt watcher is fire-and-forget (`void trackReceipt(...)`), so give its
 *  microtasks a turn before asserting on what it reported. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  vi.clearAllMocks();
  added.length = 0;
  updated.length = 0;
  chainNonce = 100;
  runtime.setWallets([{
    account: { address: ADDR } as unknown as PrivateKeyAccount,
    label: "t", balanceWei: 10_000_000_000_000_000_000n,
  }]);
  runtime.gameState = 1;
  runtime.currentEpoch = 200n;
  runtime.startTime = 0n;
  runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
  runtime.strategy = { ...DEFAULT_STRATEGY, minBalanceEth: 0, maxPaymentEth: 0 } as typeof runtime.strategy;
});
afterEach(() => { runtime.setWallets([]); });

describe("a submitted tx that never lands", () => {
  it("is reported as permanently dead when the chain moved past its nonce", async () => {
    chainNonce = 101; // something else consumed nonce 100
    await manualPayToCurrent(10n);
    await settle();

    const err = added.find((e) => e.kind === "error" && /can never land/i.test(e.message ?? ""));
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/nonce 100 was consumed by a different transaction/i);
    expect(err!.message).toMatch(/did NOT happen/i);
    // And the row must stop claiming it is still in flight.
    expect(updated.some((u) => u.patch.status === "skipped")).toBe(true);
  });

  it("stays 'submitted' and raises nothing when the nonce is still unconsumed", async () => {
    chainNonce = 100; // our nonce is next up — a dropped bundle, not a dead tx
    await manualPayToCurrent(10n);
    await settle();

    // Guard against passing vacuously: a tx must actually have been submitted, or "no alarm
    // was raised" is trivially true because nothing ever happened.
    expect(submitTx).toHaveBeenCalled();
    expect(added.some((e) => /can never land/i.test(e.message ?? ""))).toBe(false);
    // Force-marking a tx that may still land would be a guess, so nothing is downgraded.
    expect(updated.some((u) => u.patch.status === "skipped")).toBe(false);
  });

  it("says nothing rather than guessing when the nonce probe itself fails", async () => {
    // An RPC hiccup must not manufacture a "your payment is dead" alarm — that would send
    // someone to pay a citizen by hand that was already covered.
    chainNonce = 101;
    vi.mocked(publicClient.getTransactionCount).mockRejectedValueOnce(new Error("rpc down"));
    await manualPayToCurrent(10n);
    await settle();
    expect(submitTx).toHaveBeenCalled(); // not vacuous
    expect(added.some((e) => /can never land/i.test(e.message ?? ""))).toBe(false);
  });
});
