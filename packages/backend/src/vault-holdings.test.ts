import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * readOwnedStatuses must include citizens held by the CitizenVault.
 *
 * This is the dashboard's holdings list, and it is not merely cosmetic: the JIT Arm button is
 * disabled on `nSelected === 0`, so a vault-held citizen missing from here makes it impossible
 * to arm a payment through the UI at all — on the one night it matters. The engine enumerates
 * the vault separately (fetchOwnedAcrossWallets), so the two had drifted: the bot would have
 * paid a citizen the dashboard claimed it did not hold.
 */

const GAME = "0x00000000000000000000000000000000000000aa" as const;
const CITIZENS = "0x00000000000000000000000000000000000000cc" as const;
const WALLET = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0xD00B158B8644B1FE387508Ceb2De021E87926D6E" as const;

/** tokenId -> holder. The NFT index is keyed by owner address, so this mirrors it. */
const heldBy: Record<string, bigint[]> = {
  [WALLET.toLowerCase()]: [11n],
  [VAULT.toLowerCase()]: [2036n],
};

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent", gameAddress: GAME,
    builderUrls: [], flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000, ownedTokensOverride: [], targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));
vi.mock("./chain.js", () => ({
  publicClient: {}, getLatestBlockCached: vi.fn(), getBalanceCached: vi.fn(),
  invalidateBalanceCache: vi.fn(), primeBlockCache: vi.fn(), wsClient: null,
}));
vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1, currentEpoch: 190n, citizenSupply: 500n, citizensAddress: CITIZENS, startTime: 0n,
  })),
  batchGetOwnedStatuses: vi.fn(async (ids: bigint[]) =>
    ids.map((id) => ({
      tokenId: id.toString(), lastEpochPaid: "190", currentEpoch: "190",
      auditDueTimestamp: "0", secondsUntilKillable: null, bribeBalance: "0",
      hasLifeInsurance: false, risk: "ok" as const,
      estimatedPayWei: "0", auditLimit: 1,
    })),
  ),
  batchGetTargetStatuses: vi.fn(async () => []),
  filterLiveTokenIds: vi.fn(async (_c: unknown, ids: bigint[]) => ids.map((id) => ({ id, owner: WALLET }))),
}));
vi.mock("./index-tokens.js", () => ({
  // Keyed by the address asked for — the whole question is WHICH addresses get asked.
  fetchOwnedTokenIds: vi.fn(async (_c: unknown, owner: string) => heldBy[owner.toLowerCase()] ?? []),
  fetchCandidateTokenIds: vi.fn(async () => []),
  fetchLiveCitizens: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));
vi.mock("./emigration.js", () => ({
  fetchEmigrationRoster: vi.fn(async () => []), emigratedTokenIdSet: vi.fn(async () => new Set<string>()),
}));
vi.mock("./keystore.js", () => ({ loadWallets: vi.fn(() => []) }));

const { runtime } = await import("./runtime.js");
const { readOwnedStatuses } = await import("./service.js");

beforeEach(() => {
  // `unlocked` is a getter over wallets.length, so setWallets is what unlocks it.
  runtime.setWallets([{ account: { address: WALLET }, label: "hot", balanceWei: 0n }] as never);
  runtime.strategy = { ...runtime.strategy, vaultAddress: VAULT };
});

describe("readOwnedStatuses includes vault-held citizens", () => {
  it("returns both the wallet's and the vault's citizens", async () => {
    const rows = await readOwnedStatuses();
    expect(rows.map((r) => r.tokenId).sort()).toEqual(["11", "2036"]);
  });

  it("tags the vaulted one as held by the vault, at the vault's address", async () => {
    // The dashboard renders this, and "vault" is the exact string it keys its tooltip off.
    const row = (await readOwnedStatuses()).find((r) => r.tokenId === "2036")!;
    expect(row.walletLabel).toBe("vault");
    expect(row.walletAddress?.toLowerCase()).toBe(VAULT.toLowerCase());
  });

  it("leaves wallet-held citizens tagged with their own wallet", async () => {
    const row = (await readOwnedStatuses()).find((r) => r.tokenId === "11")!;
    expect(row.walletLabel).toBe("hot");
    expect(row.walletAddress?.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it("returns only wallet citizens when no vault is configured", async () => {
    // Non-vacuity for every case above: with the vault unset, #2036 must disappear. Otherwise
    // these would pass even if the vault address were being ignored and #2036 came from
    // somewhere else.
    runtime.strategy = { ...runtime.strategy, vaultAddress: "" };
    const rows = await readOwnedStatuses();
    expect(rows.map((r) => r.tokenId)).toEqual(["11"]);
  });

  it("ignores a malformed vault address rather than querying it", async () => {
    /**
     * Asserted on the CALLS, not just the result. Checking the returned rows passes either way,
     * because the index has nothing under a junk address anyway — mutation testing caught that:
     * loosening the regex to `!== ""` left this case green. What matters is that a malformed
     * address never reaches the NFT index at all.
     */
    const { fetchOwnedTokenIds } = await import("./index-tokens.js");
    vi.mocked(fetchOwnedTokenIds).mockClear();
    runtime.strategy = { ...runtime.strategy, vaultAddress: "0xnope" };
    const rows = await readOwnedStatuses();
    expect(rows.map((r) => r.tokenId)).toEqual(["11"]);
    const asked = vi.mocked(fetchOwnedTokenIds).mock.calls.map((c) => String(c[1]).toLowerCase());
    expect(asked).toEqual([WALLET.toLowerCase()]);
    expect(asked).not.toContain("0xnope");
  });

  it("prefers the WALLET when a stale index reports a citizen in both places", async () => {
    /**
     * Mid-transfer the NFT index can briefly list the same citizen under both holders. The
     * wallet must win: claiming a citizen is vaulted before it really is would route an
     * owner-only call through a contract that does not hold it yet, and every such call
     * reverts. The engine orders its own holders the same way for the same reason.
     */
    heldBy[VAULT.toLowerCase()] = [11n, 2036n];
    try {
      const row = (await readOwnedStatuses()).find((r) => r.tokenId === "11")!;
      expect(row.walletLabel).toBe("hot");
      expect((await readOwnedStatuses()).map((r) => r.tokenId).sort()).toEqual(["11", "2036"]);
    } finally {
      heldBy[VAULT.toLowerCase()] = [2036n];
    }
  });
});
