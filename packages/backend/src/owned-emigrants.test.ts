import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * An emigrated citizen must leave the owned set: it is out of the main game, so it owes no
 * tax and can serve as no auditor. It can still appear as owned because ownership comes
 * from the NFT owner INDEX, which lags the chain.
 *
 * Measured on mainnet while writing this: 25 emigrations across both routes, of which 23
 * are BURNED (ownerOf reverts) and 2 are still held by the ABBC contract. That is why the
 * filter reads the Emigrated EVENT roster and not current ownership — an
 * `isEmigrated(ownerOf(id))` test can only classify the 2.
 */

vi.mock("./chain.js", () => ({
  publicClient: { multicall: vi.fn(async () => []) },
  getLatestBlockCached: vi.fn(async () => ({ baseFeePerGas: 10_000_000_000n, number: 100n, gasUsed: 0n, gasLimit: 30_000_000n })),
  getBalanceCached: vi.fn(async () => 0n),
  invalidateBalanceCache: vi.fn(),
  primeBlockCache: vi.fn(),
  wsClient: null,
}));

vi.mock("./config.js", () => ({
  appConfig: { gameAddress: "0x000000000000000000000000000000000000aa", dataDir: "C:/dat-bot-test-scratch-nonexistent", httpUrl: "http://localhost", port: 8787, host: "127.0.0.1" },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => {
  let n = 0;
  return { activity: { add: vi.fn(() => ({ id: `entry-${++n}` })), update: vi.fn() } };
});

vi.mock("./nonce.js", () => ({
  nonces: { for: vi.fn(() => ({ sync: vi.fn(async () => {}), reset: vi.fn(), peek: vi.fn(() => 0), reserve: vi.fn(() => 0), markSigned: vi.fn() })), syncAll: vi.fn(async () => {}), resetAll: vi.fn(), retain: vi.fn() },
}));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async () => ({ ok: true, simulated: false, txHash: "0xhash", nonce: 0, valueWei: 0n, gasWei: 0n })),
  beginBundle: vi.fn(), flushBundle: vi.fn(async () => new Map()), queueCoinbaseBid: vi.fn(async () => false), setRaceBoundary: vi.fn(), setRaceLookBack: vi.fn(),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({ state: 1, currentEpoch: 168n, startTime: 0n, citizensAddress: "0x000000000000000000000000000000000000cc", citizenSupply: 100n })),
  batchGetOwnedStatuses: vi.fn(async () => []),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async () => []),
  estimateTaxes: vi.fn(async () => 0n),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeAudit: vi.fn(() => "0xAUDIT"),
  encodeKill: vi.fn(() => "0xKILL"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  gameContract: { address: "0x000000000000000000000000000000000000aa", abi: [] },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => [] as bigint[]),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./emigration.js", () => ({
  emigratedTokenIdSet: vi.fn(async () => new Set<string>()),
}));

const { fetchOwnedTokenIds } = await import("./index-tokens.js");
const { emigratedTokenIdSet } = await import("./emigration.js");
const { activity } = await import("./activity.js");
const { runtime } = await import("./runtime.js");
const { fetchOwnedAcrossWallets, resetOwnedEmigrantNotice } = await import("./strategy.js");

const CITIZENS = "0x000000000000000000000000000000000000cc" as const;
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";

function messages(): string[] {
  return vi.mocked(activity.add).mock.calls.map((c) => (c[0] as { message?: string }).message ?? "");
}

describe("emigrated citizens leave the owned token list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOwnedEmigrantNotice(); // per-change notice state is module-level; it leaks across cases
    runtime.setWallets([
      { account: { address: W1 } as unknown as PrivateKeyAccount, label: "w1", balanceWei: 0n },
    ]);
  });

  it("drops emigrated ids and keeps the rest", async () => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([100n, 1000n, 200n, 5347n]);
    // #1000 and #5347 are real ABBC emigrants, taken from the on-chain scan.
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000", "5347"]));
    expect(await fetchOwnedAcrossWallets(CITIZENS)).toEqual([100n, 200n]);
  });

  it("says which citizens it excluded, so a vanished citizen has an explanation", async () => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([100n, 1000n]);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000"]));
    await fetchOwnedAcrossWallets(CITIZENS);
    const note = messages().find((m) => /emigrated/i.test(m));
    expect(note).toBeDefined();
    expect(note).toContain("#1000");
  });

  it("reports once per changed set, not once per tick", async () => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([100n, 1000n]);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000"]));
    await fetchOwnedAcrossWallets(CITIZENS);
    await fetchOwnedAcrossWallets(CITIZENS);
    await fetchOwnedAcrossWallets(CITIZENS);
    // This runs on every sweep; repeating the notice would bury the log.
    expect(messages().filter((m) => /emigrated/i.test(m))).toHaveLength(1);
  });

  it("reports again when a NEW citizen emigrates", async () => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([100n, 1000n, 5347n]);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000"]));
    await fetchOwnedAcrossWallets(CITIZENS);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000", "5347"]));
    await fetchOwnedAcrossWallets(CITIZENS);
    expect(messages().filter((m) => /emigrated/i.test(m))).toHaveLength(2);
  });

  it("fails OPEN: an unavailable roster keeps every citizen", async () => {
    // Wrongly keeping an emigrant wastes a reverting call; wrongly dropping a live citizen
    // skips its payment and can cost the citizen. So an empty set must change nothing.
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([100n, 1000n]);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set());
    expect(await fetchOwnedAcrossWallets(CITIZENS)).toEqual([100n, 1000n]);
    expect(messages().filter((m) => /emigrated/i.test(m))).toHaveLength(0);
  });

  it("filters across every wallet, and an emigrant claims no wallet slot", async () => {
    runtime.setWallets([
      { account: { address: W1 } as unknown as PrivateKeyAccount, label: "w1", balanceWei: 0n },
      { account: { address: W2 } as unknown as PrivateKeyAccount, label: "w2", balanceWei: 0n },
    ]);
    vi.mocked(fetchOwnedTokenIds).mockImplementation((async (_c: string, owner: string) =>
      owner === W1 ? [100n, 1000n] : [5347n, 200n]) as never);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000", "5347"]));
    expect((await fetchOwnedAcrossWallets(CITIZENS)).sort((a, b) => Number(a - b))).toEqual([100n, 200n]);
  });

  it("returns an empty list when every citizen has emigrated", async () => {
    vi.mocked(fetchOwnedTokenIds).mockResolvedValue([1000n, 5347n]);
    vi.mocked(emigratedTokenIdSet).mockResolvedValue(new Set(["1000", "5347"]));
    expect(await fetchOwnedAcrossWallets(CITIZENS)).toEqual([]);
  });
});
