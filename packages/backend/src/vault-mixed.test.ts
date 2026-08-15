import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeFunctionData } from "viem";
import { citizenVaultAbi } from "@dat-bot/shared";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Migration is incremental, so BOTH holders exist at once.
 *
 * The recommended way to adopt a vault is to move one citizen, run an epoch, then move the
 * rest — which means a deliberate period where some citizens are in the vault and some are
 * still in the wallet. Routing has to follow the TOKEN, not the config flag: a wallet-held
 * citizen wrapped in a vault that does not own it reverts owner-only, so getting this wrong
 * silently breaks payments for everything not yet migrated — during the exact window the
 * operator is least likely to be watching for it.
 */

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x00000000000000000000000000000000000000fe" as const;
const GAME = "0x00000000000000000000000000000000000000aa" as const;
const TARGET_EPOCH = 200n;

const IN_WALLET = [10n, 20n];
const IN_VAULT = [30n, 40n, 50n];

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 1_000_000_000n })),
    getBalance: vi.fn(async () => 100_000_000_000_000_000_000n),
    getBlockNumber: vi.fn(async () => 100n),
    sendRawTransaction: vi.fn(async () => "0xmirror"),
    estimateGas: vi.fn(async () => 100_000n),
    getCode: vi.fn(async () => "0x60006000"),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, transactionIndex: 0, logs: [] })),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result:
          // Vault preflight reads — wired correctly so it does not block.
          c.functionName === "operator" ? ADDR
          : c.functionName === "owner" ? "0x9999999999999999999999999999999999999999"
          : c.functionName === "game" ? GAME
          : c.functionName === "citizens" ? "0x00000000000000000000000000000000000000cc"
          : c.functionName === "auditLimit" ? 1n
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
    mode: "mainnet", dataDir: "C:/dat-bot-test-scratch-nonexistent", gameAddress: GAME,
    builderUrls: ["https://relay.flashbots.net"], flashbotsRelayUrl: "https://relay.flashbots.net",
    maxCandidates: 8000, ownedTokensOverride: [], targetTokensOverride: [],
  },
  loadSettings: vi.fn(() => ({})), saveSettings: vi.fn(), deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./contract.js", async () => {
  const actual = await vi.importActual<typeof import("./contract.js")>("./contract.js");
  return {
    getGameSnapshot: vi.fn(async () => ({
      state: 1, currentEpoch: TARGET_EPOCH - 1n, citizenSupply: 500n,
      citizensAddress: "0x00000000000000000000000000000000000000cc", startTime: 0n,
    })),
    batchGetOwnedStatuses: vi.fn(async () => []),
    batchGetTargetStatuses: vi.fn(async () => []),
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
    owner.toLowerCase() === VAULT.toLowerCase() ? IN_VAULT : IN_WALLET,
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
  nonces: { syncAll: vi.fn(async () => {}), resetAll: vi.fn(), for: () => ({ reserve: () => nonceCounter++, peek: () => nonceCounter }) },
}));

const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const { firePreBoundaryBundle } = await import("./strategy.js");

let signed: { to: string; data: string; value: bigint }[] = [];

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
    preBoundaryPay: true, preBoundaryAudit: false,
    jitEnabled: true, jitTargetEpoch: Number(TARGET_EPOCH), jitTokenIds: [],
    offenseEnabled: false, autoAudit: false,
    minBalanceEth: 0, maxPaymentEth: 0, maxBaseFeeGwei: 1000,
    endgameOnlyWithin: null,
    combinedBoundaryBundle: true,
    coinbaseBidEth: 0.03, coinbaseBidAuditOnlyEth: 0,
    coinbasePayerAddress: "",
    vaultAddress: VAULT,
  };
});

afterEach(() => {
  runtime.setWallets([]);
  runtime.running = false;
  vi.unstubAllGlobals();
});

describe("half-migrated: vault-held batched, wallet-held still direct", () => {
  it("routes each citizen by who actually holds it", async () => {
    await firePreBoundaryBundle();

    const direct = signed.filter((t) => t.to.toLowerCase() === GAME.toLowerCase());
    const vaultTxs = signed.filter((t) => t.to.toLowerCase() === VAULT.toLowerCase());

    // The citizens still in the wallet keep going straight to the game — wrapping them
    // would revert owner-only and cost those citizens their payment.
    expect(direct).toHaveLength(IN_WALLET.length);
    // Everything the vault holds collapses into exactly one call.
    expect(vaultTxs).toHaveLength(1);

    const { args } = decodeFunctionData({ abi: citizenVaultAbi, data: vaultTxs[0]!.data as `0x${string}` });
    const [calls] = args as unknown as [{ data: `0x${string}`; value: bigint; tolerate: boolean }[], bigint];
    expect(calls).toHaveLength(IN_VAULT.length);
  });

  it("still bills msg.value for the batch as sum(values) + bid", async () => {
    await firePreBoundaryBundle();
    const vaultTx = signed.find((t) => t.to.toLowerCase() === VAULT.toLowerCase())!;
    const { args } = decodeFunctionData({ abi: citizenVaultAbi, data: vaultTx.data as `0x${string}` });
    const [calls, bidWei] = args as unknown as [{ value: bigint }[], bigint];
    expect(vaultTx.value).toBe(calls.reduce((s, c) => s + c.value, bidWei));
  });
});
