import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeFunctionData } from "viem";
import { citizenVaultAbi, applyThorMode } from "@dat-bot/shared";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * The batched boundary, asserted on the calldata actually handed to the signer.
 *
 * Same shape as multi-citizen-bundle.test.ts — five citizens owing, six auditable rivals —
 * but with a vault configured. The questions are different:
 *
 *  1. Does the whole boundary collapse to ONE transaction? That is the entire point: a
 *     failed audit then costs a few thousand gas of internal call instead of a whole
 *     ~81,000-gas transaction and a bundle slot.
 *  2. Is msg.value EXACTLY sum(values) + bid? The vault reverts otherwise, so an accounting
 *     slip here fails the boundary rather than overpaying quietly.
 *  3. Do payments still precede audits? Order inside the array IS execution order, so a
 *     citizen paid in the batch has to be current before it is used as an auditor.
 *  4. Is the bid inline rather than a separate CoinbasePayer transaction?
 *
 * encodeVaultRun / vaultCallValue are deliberately NOT mocked: the encoding is what the
 * contract will actually decode, so a mock would hide the only thing worth checking.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x00000000000000000000000000000000000000fe" as const;
const PAYER = "0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815" as const;
const GAME = "0x00000000000000000000000000000000000000aa" as const;
const TARGET_EPOCH = 200n;

const OWNED = [10n, 20n, 30n, 40n, 50n];
const RIVALS = ["501", "502", "503", "504", "505", "506"];

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    sendRawTransaction: vi.fn(async () => "0xmirror"),
    estimateGas: vi.fn(async () => 100_000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, transactionIndex: 0, logs: [] })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          c.functionName === "auditLimit" ? 1n
          : c.functionName === "auditDueTimestamp" ? 0n
          : c.functionName === "auditsUsedInEpoch" ? 0n
          : TARGET_EPOCH - 1n,
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

// Real encoders for the vault, stubs for the game calls — the game calldata only needs to
// be distinguishable, but the vault encoding must be the genuine article.
vi.mock("./contract.js", async () => {
  const actual = await vi.importActual<typeof import("./contract.js")>("./contract.js");
  return {
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
    encodeVaultRun: actual.encodeVaultRun,
    vaultCallValue: actual.vaultCallValue,
  };
});

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async (_c: unknown, owner: string) =>
    // The vault holds every citizen; the wallet holds none. This is the migrated state.
    owner.toLowerCase() === VAULT.toLowerCase() ? OWNED : [],
  ),
  fetchCandidateTokenIds: vi.fn(async () => []),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./activity.js", () => ({
  activity: { add: vi.fn(() => ({ id: "e1" })), update: vi.fn(), recent: vi.fn(() => []) },
}));

vi.mock("./race-timing.js", () => ({ recordRaceOutcome: vi.fn(), recordRaceSubmission: vi.fn() }));

let nonceCounter = 0;
vi.mock("./nonce.js", () => ({
  nonces: {
    syncAll: vi.fn(async () => {}),
    resetAll: vi.fn(),
    for: () => ({ reserve: () => nonceCounter++, peek: () => nonceCounter }),
  },
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const {
  firePreBoundaryBundle, combinedBundleActive,
  schedulePreBoundaryPay, schedulePreBoundaryAudit, schedulePreBoundaryBundle,
} = await import("./strategy.js");

/** Everything handed to the signer this fire — the real `to` / `data` / `value`. */
let signed: { to: string; data: string; value: bigint }[] = [];

/** The decoded vault batch: the calls array and the inline bid. */
function decodedBatch() {
  const vaultTx = signed.find((t) => t.to.toLowerCase() === VAULT.toLowerCase());
  expect(vaultTx, "no transaction was sent to the vault").toBeTruthy();
  const { functionName, args } = decodeFunctionData({ abi: citizenVaultAbi, data: vaultTx!.data as `0x${string}` });
  expect(functionName).toBe("run");
  const [calls, bidWei] = args as unknown as [
    { data: `0x${string}`; value: bigint; tolerate: boolean }[],
    bigint,
  ];
  return { calls, bidWei, msgValue: vaultTx!.value };
}

beforeEach(() => {
  nonceCounter = 0;
  signed = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { bundleHash: "0xbundle" } }),
    text: async () => "{}",
  })) as unknown as typeof fetch);

  const account = {
    address: ADDR,
    signTransaction: vi.fn(async (tx: { data?: string; nonce: number; to: string; value?: bigint }) => {
      signed.push({ to: tx.to, data: tx.data ?? "0x", value: tx.value ?? 0n });
      const sel = tx.data && tx.data !== "0x" ? tx.data.slice(2, 10) : "99999999";
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
    vaultAddress: VAULT,
    offenseTargetTokenIds: RIVALS,
  };
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
  vi.unstubAllGlobals();
});

describe("vault batch: the whole boundary as one transaction", () => {
  it("sends exactly one transaction, to the vault", async () => {
    await firePreBoundaryBundle();
    // Without a vault this same scenario produces 5 payments + audits + a bid tx.
    expect(signed).toHaveLength(1);
    expect(signed[0]!.to.toLowerCase()).toBe(VAULT.toLowerCase());
  });

  it("pays the bid inline instead of through the CoinbasePayer", async () => {
    await firePreBoundaryBundle();
    const { bidWei } = decodedBatch();
    expect(bidWei).toBe(30_000_000_000_000_000n); // 0.03 ETH, the payment-boundary bid
    // The forwarder must not appear at all — its ~30,550 gas is what going inline saves.
    expect(signed.some((t) => t.to.toLowerCase() === PAYER.toLowerCase())).toBe(false);
  });

  it("carries msg.value exactly equal to sum(values) + bid, as the vault requires", async () => {
    await firePreBoundaryBundle();
    const { calls, bidWei, msgValue } = decodedBatch();
    const sum = calls.reduce((acc, c) => acc + c.value, 0n);
    expect(msgValue).toBe(sum + bidWei);
  });

  it("orders payments before audits, so a citizen paid in the batch can audit", async () => {
    await firePreBoundaryBundle();
    const { calls } = decodedBatch();
    const kinds = calls.map((c) => c.data.slice(0, 10));
    const lastPayment = kinds.lastIndexOf("0x11111111");
    const firstAudit = kinds.indexOf("0x22222222");
    expect(lastPayment).toBeGreaterThanOrEqual(0);
    expect(firstAudit).toBeGreaterThan(lastPayment);
  });

  it("marks the speculative audits tolerate, so one lost race cannot drop the payments", async () => {
    await firePreBoundaryBundle();
    const { calls } = decodedBatch();
    const audits = calls.filter((c) => c.data.startsWith("0x22222222"));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((c) => c.tolerate)).toBe(true);
  });
});

/**
 * Fusion with a vault must be unconditional — the "foolproof" requirement.
 *
 * Split mode with a vault does not fail loudly; it quietly sends TWO run() calls, pays TWO
 * coinbase bids, and puts the audit call on a nonce above an unmined payment. Every one of
 * those is a regression against the reason the vault exists, and none of them announces itself.
 *
 * So these cases attack the fusion from each direction an operator could plausibly turn it off,
 * and assert on the transactions actually handed to the signer rather than on the predicate.
 */
describe("a vault boundary cannot be split", () => {
  it("stays one transaction with combinedBoundaryBundle explicitly OFF", async () => {
    runtime.strategy = { ...runtime.strategy, combinedBoundaryBundle: false };
    await firePreBoundaryBundle();
    const { calls } = decodedBatch();
    expect(calls.length).toBeGreaterThan(1); // non-vacuity: real work was batched
    expect(signed.filter((t) => t.to.toLowerCase() === VAULT.toLowerCase())).toHaveLength(1);
  });

  it("stays one transaction under Thor Mode, which used to force the split", async () => {
    // applyThorMode runs on every save, so this is the realistic path into the bad state:
    // the operator turns Thor Mode on and the toggle is rewritten under them.
    runtime.strategy = applyThorMode({ ...runtime.strategy, thorMode: true });
    expect(runtime.strategy.combinedBoundaryBundle).toBe(true); // withheld, not forced off
    await firePreBoundaryBundle();
    const { calls } = decodedBatch();
    expect(calls.length).toBeGreaterThan(1);
    expect(signed.filter((t) => t.to.toLowerCase() === VAULT.toLowerCase())).toHaveLength(1);
  });

  it("stays one transaction with NO coinbase bid configured", async () => {
    /**
     * Without a vault, no bid means split however the toggle is set — fusing buys nothing when
     * there is no bid to share. With one, fusing still buys a single transaction, so the bid
     * requirement must not gate it. run(calls, 0) is a perfectly good call.
     */
    runtime.strategy = { ...runtime.strategy, coinbaseBidEth: 0, coinbaseBidAuditOnlyEth: 0 };
    await firePreBoundaryBundle();
    const { calls, bidWei, msgValue } = decodedBatch();
    expect(calls.length).toBeGreaterThan(1);
    expect(bidWei).toBe(0n);
    expect(msgValue).toBe(calls.reduce((s, c) => s + c.value, 0n));
    expect(signed.filter((t) => t.to.toLowerCase() === VAULT.toLowerCase())).toHaveLength(1);
  });

  it("does not ARM the standalone schedulers, so nothing can fire twice", () => {
    /**
     * The double-fire hazard, tested where the guard actually is.
     *
     * `combinedBundleActive` is checked by the SCHEDULERS (schedulePreBoundaryPay:1191,
     * schedulePreBoundaryAudit:1825), not by the fire functions — so calling the fires directly
     * proves nothing about production, where only an armed timer invokes them. An earlier
     * version of this case did exactly that and "found" three transactions that no scheduler
     * would ever have caused.
     *
     * So: put the boundary in the FUTURE (the harness otherwise sits past it, where every
     * scheduler bails on deltaMs <= 0 and the test would pass for the wrong reason), then assert
     * that only the bundle scheduler arms a timer.
     */
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    runtime.startTime = nowSec + 3600n - runtime.currentEpoch! * 86400n; // boundary ~1h out
    runtime.strategy = { ...runtime.strategy, combinedBoundaryBundle: false };
    expect(combinedBundleActive(runtime.strategy)).toBe(true); // the vault fused it anyway

    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      schedulePreBoundaryPay();
      schedulePreBoundaryAudit();
      // Non-vacuity: the boundary really is reachable, so the bundle scheduler DOES arm. Without
      // this the two assertions above would also pass with the boundary in the past.
      expect(timer).not.toHaveBeenCalled();
      schedulePreBoundaryBundle();
      expect(timer).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
    }
  });
});

/**
 * Which bid a fused batch spends. There is one bundle, so there is exactly one bid, and the
 * choice is made from what actually got QUEUED rather than from what was configured.
 */
describe("a fused vault batch spends exactly one bid", () => {
  it("uses the PAYMENT bid when a payment is in the batch", async () => {
    await firePreBoundaryBundle();
    const { calls, bidWei, msgValue } = decodedBatch();
    expect(calls.some((c) => c.data.startsWith("0x11111111"))).toBe(true); // a payment is present
    expect(bidWei).toBe(30_000_000_000_000_000n); // 0.03 = coinbaseBidEth, not the 0.003 audit bid
    expect(msgValue).toBe(calls.reduce((s, c) => s + c.value, 0n) + bidWei);
  });

  it("uses the AUDIT bid on an audit-only boundary", async () => {
    // Nothing armed to pay, so no payment reaches the batch and the cheaper bid applies.
    runtime.strategy = { ...runtime.strategy, jitEnabled: false, jitTargetEpoch: null };
    await firePreBoundaryBundle();
    const { calls, bidWei } = decodedBatch();
    expect(calls.some((c) => c.data.startsWith("0x11111111"))).toBe(false); // no payment
    expect(calls.length).toBeGreaterThan(0);
    expect(bidWei).toBe(3_000_000_000_000_000n); // 0.003 = coinbaseBidAuditOnlyEth
  });

  it("pays that bid ONCE, not once per half", async () => {
    // The concrete cost of splitting: two bids for one boundary. Fused there is one bid tx-side
    // (inline) and one bid amount, and msgValue proves no second one was added.
    await firePreBoundaryBundle();
    const { calls, bidWei, msgValue } = decodedBatch();
    expect(msgValue - calls.reduce((s, c) => s + c.value, 0n)).toBe(bidWei);
  });
});
