import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * End-to-end audit of a MULTI-CITIZEN boundary bundle, asserted on the JSON actually POSTed
 * to the builders — the real contract, rather than internal state.
 *
 * Three questions this answers, all of which matter to a holder with several citizens:
 *
 *  1. Can one reverting tx take the bundle down? `eth_sendBundle` drops a bundle if any tx
 *     NOT listed in `revertingTxHashes` reverts. So the test is whether EVERY tx is listed.
 *  2. Are payments still prioritised? Within a bundle, order IS execution order, so the
 *     payments must precede the audits — otherwise a just-paid citizen isn't current yet
 *     when it's used as an auditor, and the audit reverts.
 *  3. If one payment fails, do the rest still get bundled? A failure at submit time must not
 *     abort the sweep for the remaining citizens.
 *
 * Deliberately NOT mocking ./flashbots.js: the whole point is to inspect the wire format that
 * flushBundle produces, which a mock would hide.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815" as const;
const GAME = "0x00000000000000000000000000000000000000aa" as const;
const TARGET_EPOCH = 200n;

// 5 citizens, all one epoch behind => 5 payments owed.
const OWNED = [10n, 20n, 30n, 40n, 50n];
// 6 auditable rivals, more than our auditor capacity (5 x limit 1).
const RIVALS = ["501", "502", "503", "504", "505", "506"];

const sendRawTransaction = vi.fn(async () => "0xmirror");
vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
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
          : TARGET_EPOCH - 1n, // lastEpochPaid: one behind => a payment is owed
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
    gameAddress: "0x00000000000000000000000000000000000000aa",
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
  // Distinct calldata per kind so the bundle can be classified from the wire bytes.
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

// Sequential nonces from a single wallet, as the real manager would hand out.
let nonceCounter = 0;
vi.mock("./nonce.js", () => ({
  nonces: {
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
    for: () => ({ reserve: () => nonceCounter++, peek: () => nonceCounter }),
  },
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { firePreBoundaryBundle } = await import("./strategy.js");

/** The single eth_sendBundle payload (first target block). */
function bundle(): { txs: `0x${string}`[]; revertingTxHashes?: string[] } {
  const bodies = vi.mocked(globalThis.fetch).mock.calls
    .map(([, init]) => { try { return JSON.parse(String((init as RequestInit).body)); } catch { return null; } })
    .filter((b) => b && b.method === "eth_sendBundle");
  return bodies[0]!.params[0];
}

/** Classify each bundle tx by the calldata embedded in the signed payload.
 *  The fake signer below encodes "<kind><nonce>" so the wire order is readable. */
function kinds(): string[] {
  return bundle().txs.map((t) => t.slice(2, 10));
}

beforeEach(() => {
  nonceCounter = 0;
  sendRawTransaction.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  // Signed payload = selector + nonce, so ordering and composition are inspectable and each
  // tx hashes differently (keccak collisions would break revertingTxHashes).
  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; nonce: number; to: string; value: bigint }) => {
      const sel = tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "99999999"; // bid has no data
      return `0x${sel}${tx.nonce.toString(16).padStart(4, "0")}${"cd".repeat(28)}` as `0x${string}`;
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
    minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000,
    endgameOnlyWithin: null,
    combinedBoundaryBundle: true,
    coinbaseBidEth: 0.03, coinbaseBidAuditOnlyEth: 0.003,
    coinbasePayerAddress: PAYER,
    offenseTargetTokenIds: RIVALS,
  };
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
  vi.unstubAllGlobals();
});

const PAY = "11111111", AUDIT = "22222222", BID = "99999999";

describe("multi-citizen boundary bundle: nothing can drop it", () => {
  it("declares EVERY tx allowed-to-revert, so no single revert invalidates the bundle", async () => {
    await firePreBoundaryBundle();
    const b = bundle();
    const { keccak256 } = await import("viem");
    const all = b.txs.map((t) => keccak256(t));
    // The whole point: payments, audits and the bid are all listed. A revert anywhere
    // reverts only that tx; the builder still includes the rest at the bought position.
    expect(b.revertingTxHashes ?? []).toHaveLength(b.txs.length);
    for (const h of all) expect(b.revertingTxHashes).toContain(h);
  });

  it("carries all 5 payments, the audits, and exactly one bid", async () => {
    await firePreBoundaryBundle();
    const k = kinds();
    expect(k.filter((x) => x === PAY)).toHaveLength(5);          // one per owing citizen
    expect(k.filter((x) => x === AUDIT).length).toBeGreaterThan(0);
    expect(k.filter((x) => x === BID)).toHaveLength(1);          // ONE bid for the whole bundle
  });

  it("orders every payment BEFORE every audit, so a just-paid citizen can audit", async () => {
    await firePreBoundaryBundle();
    const k = kinds();
    const lastPay = k.lastIndexOf(PAY);
    const firstAudit = k.indexOf(AUDIT);
    expect(lastPay).toBeGreaterThanOrEqual(0);
    expect(firstAudit).toBeGreaterThan(lastPay); // no audit precedes any payment
  });

  it("tails the bid LAST, so it only pays if the bundle is taken", async () => {
    await firePreBoundaryBundle();
    const k = kinds();
    expect(k[k.length - 1]).toBe(BID);
  });

  it("mirrors the payments to the mempool but not the audits or the bid", async () => {
    await firePreBoundaryBundle();
    // 5 payments mirrored. Audits are bundle-only here (a bid backs them), and the bid is
    // only meaningful in the block it wins.
    expect(sendRawTransaction).toHaveBeenCalledTimes(5);
  });
});

describe("one failed payment does not stop the others", () => {
  it("still queues the remaining payments when the 3rd fails to submit", async () => {
    // Simulated as a signing failure for one citizen: the sweep must carry on rather than
    // abandoning the boundary for every other citizen.
    const wallet = runtime.wallets[0]!;
    const real = wallet.account.signTransaction as unknown as (tx: { nonce: number; data?: string }) => Promise<string>;
    let paySeen = 0;
    (wallet.account as unknown as { signTransaction: unknown }).signTransaction =
      vi.fn(async (tx: { nonce: number; data?: string }) => {
        if (tx.data?.startsWith("0x11111111") && ++paySeen === 3) throw new Error("signing failed for this citizen");
        return real(tx);
      });

    await firePreBoundaryBundle();

    const k = kinds();
    // 4 of 5 payments made it; the failed one is simply absent.
    expect(k.filter((x) => x === PAY)).toHaveLength(4);
    // ...and the bundle still carries its audits and its bid.
    expect(k.filter((x) => x === AUDIT).length).toBeGreaterThan(0);
    expect(k.filter((x) => x === BID)).toHaveLength(1);
  });

  it("keeps the surviving payments revert-tolerant and mirrored", async () => {
    const wallet = runtime.wallets[0]!;
    const real = wallet.account.signTransaction as unknown as (tx: { nonce: number; data?: string }) => Promise<string>;
    let paySeen = 0;
    (wallet.account as unknown as { signTransaction: unknown }).signTransaction =
      vi.fn(async (tx: { nonce: number; data?: string }) => {
        if (tx.data?.startsWith("0x11111111") && ++paySeen === 1) throw new Error("nope");
        return real(tx);
      });

    await firePreBoundaryBundle();

    const b = bundle();
    expect(b.revertingTxHashes ?? []).toHaveLength(b.txs.length); // still all-tolerant
    expect(sendRawTransaction).toHaveBeenCalledTimes(4);          // 4 surviving payments mirrored
  });
});

describe("bundle stays structurally valid", () => {
  it("keeps txs in ascending nonce order", async () => {
    await firePreBoundaryBundle();
    // Each account's txs must ascend by nonce or the bundle is invalid on arrival.
    const nonces = bundle().txs.map((t) => parseInt(t.slice(10, 14), 16));
    expect(nonces).toEqual([...nonces].sort((a, b) => a - b));
  });

  it("uses a contiguous nonce run with no gaps", async () => {
    await firePreBoundaryBundle();
    const nonces = bundle().txs.map((t) => parseInt(t.slice(10, 14), 16));
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]! - nonces[i - 1]!).toBe(1);
  });
});
