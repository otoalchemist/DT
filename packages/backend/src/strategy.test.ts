import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

const EPOCH_SECONDS = 86_400n;
const BASE_TAX_RATE_WEI = 690_000_000_000_000n;
const START_TIME = 0n;

const testState = vi.hoisted(() => ({
  lastEpochPaid: 0n,
  auditDueTimestamp: 0n,
  estimatedPayWei: 1_000_000_000_000_000n,
  bribeBalance: 0n,
  submitOutcomes: [] as boolean[],
  submitTxHashes: [] as Hex[],
  submitReplacementUuids: [] as Array<string[] | undefined>,
  submitLineageIds: [] as Array<string | undefined>,
  submitRetryImmediately: [] as boolean[],
  submitGate: null as Promise<void> | null,
  blockGate: null as Promise<void> | null,
  candidateGate: null as Promise<bigint[]> | null,
  submitQueued: false,
  nextNonce: 0,
  confirmedNonce: 0,
  pendingNonce: 0,
  submittedMaxFeePerGas: 20n,
  submittedMaxPriorityFeePerGas: 2n,
  submittedGasWei: 0n,
  baseFeePerGas: 10_000_000_000n,
  signedCount: 0,
  balanceWei: 10_000_000_000_000_000_000n,
  balanceResponses: [] as bigint[],
  ownedIds: [1n] as bigint[],
  onChainOwnedIds: null as bigint[] | null,
  lastEpochPaidByToken: new Map<string, bigint>(),
  auditDueByToken: new Map<string, bigint>(),
  auditLimitByToken: new Map<string, bigint>(),
  auditsUsedByToken: new Map<string, bigint>(),
  ownerByToken: new Map<string, `0x${string}`>(),
  ownerOfFailures: new Set<string>(),
  multicallRejectFunctions: new Set<string>(),
  receipts: new Map<Hex, Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
  }>>(),
  flushResults: new Map<number, {
    ok: boolean;
    error?: string;
    uncertain?: boolean;
    retryImmediately?: boolean;
    txHash?: Hex;
    replacementUuids?: string[];
    lineageId?: string;
  }>(),
  candidateIds: [] as bigint[],
  liveTargets: [] as { id: bigint; owner: `0x${string}` }[],
  targetStatuses: [] as Array<{
    tokenId: string;
    owner: `0x${string}`;
    lastEpochPaid: string;
    delinquent: boolean;
    epochsBehind: number;
    auditable: boolean;
    auditDueTimestamp: string;
    killable: boolean;
  }>,
  nextActivityId: 0,
}));

function epochStart(epoch: number): bigint {
  return BigInt(epoch - 1) * EPOCH_SECONDS;
}

function currentEpochAt(nowSec: bigint): bigint {
  return 1n + (nowSec - START_TIME) / EPOCH_SECONDS;
}

vi.mock("./chain.js", () => ({
  publicClient: {
    getBlock: vi.fn(async () => ({
      baseFeePerGas: testState.baseFeePerGas,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    })),
    getBalance: vi.fn(async () => testState.balanceResponses.shift() ?? testState.balanceWei),
    getBlockNumber: vi.fn(async () => 1_000n),
    getTransactionCount: vi.fn(async () => testState.confirmedNonce),
    multicall: vi.fn(async ({ contracts }: { contracts: Array<{
      functionName?: string;
      args?: readonly unknown[];
    }> }) => {
      if (contracts.some((contract) =>
        contract.functionName !== undefined
        && testState.multicallRejectFunctions.has(contract.functionName))) {
        throw new Error("multicall RPC unavailable");
      }
      return contracts.map((contract) => {
      const tokenId = contract.args?.[0]?.toString();
      if (contract.functionName === "ownerOf" && tokenId !== undefined) {
        if (testState.ownerOfFailures.has(tokenId)) {
          return { status: "failure", error: new Error("ownerOf unavailable") };
        }
        const authoritativeOwned = testState.onChainOwnedIds ?? testState.ownedIds;
        const defaultOwner = authoritativeOwned.some((id) => id.toString() === tokenId)
          ? "0x1111111111111111111111111111111111111111"
          : testState.targetStatuses.find((target) => target.tokenId === tokenId)?.owner
            ?? testState.liveTargets.find((target) => target.id.toString() === tokenId)?.owner
            ?? "0x9999999999999999999999999999999999999999";
        return {
          status: "success",
          result: testState.ownerByToken.get(tokenId) ?? defaultOwner,
        };
      }
      if (contract.functionName === "currentEpoch") {
        return {
          status: "success",
          result: currentEpochAt(BigInt(Math.floor(Date.now() / 1000))),
        };
      }
      if (contract.functionName === "lastEpochPaid" && tokenId !== undefined) {
        const targetPaid = testState.targetStatuses.find(
          (target) => target.tokenId === tokenId,
        )?.lastEpochPaid;
        return {
          status: "success",
          result: testState.lastEpochPaidByToken.get(tokenId)
            ?? (targetPaid === undefined ? testState.lastEpochPaid : BigInt(targetPaid)),
        };
      }
      if (contract.functionName === "auditLimit" && tokenId !== undefined) {
        return {
          status: "success",
          result: testState.auditLimitByToken.get(tokenId) ?? testState.lastEpochPaid,
        };
      }
      if (contract.functionName === "auditsUsedInEpoch" && tokenId !== undefined) {
        return {
          status: "success",
          result: testState.auditsUsedByToken.get(tokenId) ?? 0n,
        };
      }
      if (contract.functionName === "auditDueTimestamp" && tokenId !== undefined) {
        const targetDue = testState.targetStatuses.find(
          (target) => target.tokenId === tokenId,
        )?.auditDueTimestamp;
        return {
          status: "success",
          result: testState.auditDueByToken.get(tokenId)
            ?? (targetDue === undefined ? testState.auditDueTimestamp : BigInt(targetDue)),
        };
      }
      if (contract.functionName === "bribeBalance" && tokenId !== undefined) {
        return { status: "success", result: testState.bribeBalance };
      }
      if (contract.functionName === "estimateTaxesToPay" && tokenId !== undefined) {
        return { status: "success", result: testState.estimatedPayWei };
      }
      return { status: "success", result: testState.lastEpochPaid };
      });
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = testState.receipts.get(hash);
      if (!receipt) throw new Error(`no mocked receipt for ${hash}`);
      return receipt;
    }),
  },
  getLatestBlockCached: vi.fn(async () => {
    if (testState.blockGate) await testState.blockGate;
    return {
      baseFeePerGas: testState.baseFeePerGas,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
      number: 100n,
    };
  }),
  wsClient: {
    watchBlocks: vi.fn(() => vi.fn()),
  },
}));

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "public",
    gameAddress: "0x00000000000000000000000000000000000000aa",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    httpUrl: "http://localhost",
    port: 8787,
    host: "127.0.0.1",
  },
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(),
  deriveUrlsFromKey: vi.fn(),
}));

vi.mock("./activity.js", () => ({
  activity: {
    add: vi.fn(() => ({ id: `test-${++testState.nextActivityId}` })),
    update: vi.fn(),
  },
}));

vi.mock("./nonce.js", () => ({
  nonceManager: {
    sync: vi.fn(async () => {}),
    reset: vi.fn(),
    hasInvisibleReservation: vi.fn(() => false),
    pendingNonce: vi.fn(() => testState.pendingNonce),
  },
}));

vi.mock("./index-tokens.js", () => ({
  fetchOwnedTokenIds: vi.fn(async () => testState.ownedIds),
  filterOwnedTokenIds: vi.fn(async (_citizens: unknown, tokenIds: bigint[]) => {
    const authoritative = testState.onChainOwnedIds ?? testState.ownedIds;
    const owned = new Set(authoritative.map((tokenId) => tokenId.toString()));
    return tokenIds.filter((tokenId) => owned.has(tokenId.toString()));
  }),
  fetchCandidateTokenIds: vi.fn(async () => testState.candidateGate ?? testState.candidateIds),
  ownershipIndexingAvailable: vi.fn(() => true),
}));

vi.mock("./flashbots.js", () => ({
  submitTx: vi.fn(async (
    intent: { value: bigint },
    opts: {
      dryRun: boolean;
      replacement?: { nonce: number };
      authorize?: (quote: {
        valueWei: bigint;
        gasWei: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }) => Promise<boolean | string | { ok: boolean; error?: string; stillValid?: () => boolean }>;
    },
  ) => {
    if (testState.submitGate) await testState.submitGate;
    if (!opts.dryRun && opts.authorize) {
      const raw = await opts.authorize({
        valueWei: intent.value,
        gasWei: testState.submittedGasWei,
        maxFeePerGas: testState.submittedMaxFeePerGas,
        maxPriorityFeePerGas: testState.submittedMaxPriorityFeePerGas,
      });
      const authorization = typeof raw === "object"
        ? raw
        : { ok: raw === true, error: typeof raw === "string" ? raw : undefined };
      if (!authorization.ok || (authorization.stillValid && !authorization.stillValid())) {
        return {
          ok: false,
          simulated: true,
          nonce: opts.replacement?.nonce ?? testState.nextNonce,
          valueWei: intent.value,
          gasWei: testState.submittedGasWei,
          maxFeePerGas: testState.submittedMaxFeePerGas,
          maxPriorityFeePerGas: testState.submittedMaxPriorityFeePerGas,
          error: authorization.error ?? "transaction authorization became stale",
        };
      }
    }
    const ok = testState.submitOutcomes.shift() ?? true;
    if (ok) testState.signedCount += 1;
    return {
      ok,
      simulated: true,
      nonce: opts.replacement?.nonce ?? testState.nextNonce++,
      valueWei: intent.value,
      gasWei: testState.submittedGasWei,
      maxFeePerGas: testState.submittedMaxFeePerGas,
      maxPriorityFeePerGas: testState.submittedMaxPriorityFeePerGas,
      txHash: ok ? testState.submitTxHashes.shift() : undefined,
      replacementUuids: testState.submitReplacementUuids.shift(),
      lineageId: testState.submitLineageIds.shift(),
      retryImmediately: testState.submitRetryImmediately.shift() || undefined,
      queued: testState.submitQueued || undefined,
    };
  }),
  beginBundle: vi.fn(),
  flushBundle: vi.fn(async () => new Map(testState.flushResults)),
  discardBundle: vi.fn(() => new Map()),
  waitForBundleFallbacks: vi.fn(async () => {}),
  reconcileSubmissionJournal: vi.fn(async () => ({
    confirmedNonce: 0,
    pendingNonce: 0,
    currentBlock: 100n,
    retained: [],
    consumed: [],
    expired: [],
  })),
  recoverPreparedSubmissions: vi.fn(async () => ({
    confirmedNonce: testState.confirmedNonce,
    pendingNonce: testState.pendingNonce,
    currentBlock: 100n,
    retained: [],
    consumed: [],
    expired: [],
  })),
}));

vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1,
    currentEpoch: currentEpochAt(BigInt(Math.floor(Date.now() / 1000))),
    startTime: START_TIME,
    citizensAddress: "0x00000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
  batchGetOwnedStatuses: vi.fn(
    async (tokenIds: bigint[], currentEpoch: bigint, nowSec: bigint) =>
      tokenIds.map((tokenId) => {
        const tokenLastEpochPaid = testState.lastEpochPaidByToken.get(tokenId.toString())
          ?? testState.lastEpochPaid;
        const underAudit = testState.auditDueTimestamp !== 0n;
        const secondsUntilKillable = underAudit
          ? Number(testState.auditDueTimestamp - nowSec)
          : null;
        const delinquent = tokenLastEpochPaid + 2n <= currentEpoch;
        return {
          tokenId: tokenId.toString(),
          lastEpochPaid: tokenLastEpochPaid.toString(),
          currentEpoch: currentEpoch.toString(),
          auditDueTimestamp: testState.auditDueTimestamp.toString(),
          secondsUntilKillable,
          bribeBalance: testState.bribeBalance.toString(),
          hasLifeInsurance: false,
          risk: underAudit ? "audited" : delinquent ? "delinquent" : "safe",
          estimatedPayWei: testState.estimatedPayWei.toString(),
        };
      }),
  ),
  batchGetTargetStatuses: vi.fn(async () => testState.targetStatuses),
  filterLiveTokenIds: vi.fn(async () => testState.liveTargets),
  estimateTaxes: vi.fn(async () => 1_000_000_000_000_000n),
  encodePayTaxes: vi.fn(() => "0xPAYTAXES"),
  encodeAudit: vi.fn(() => "0xAUDIT"),
  encodeKill: vi.fn(() => "0xKILL"),
  encodeUseBribe: vi.fn(() => "0xBRIBE"),
  gameContract: {
    address: "0x00000000000000000000000000000000000000aa",
    abi: [
      {
        type: "function",
        name: "payTaxes",
        stateMutability: "payable",
        inputs: [
          { name: "tokenId", type: "uint256" },
          { name: "epochs", type: "uint256" },
        ],
        outputs: [],
      },
      {
        type: "function",
        name: "useBribe",
        stateMutability: "nonpayable",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
      },
      {
        type: "function",
        name: "audit",
        stateMutability: "payable",
        inputs: [
          { name: "auditorTokenId", type: "uint256" },
          { name: "targetTokenId", type: "uint256" },
        ],
        outputs: [],
      },
      {
        type: "function",
        name: "kill",
        stateMutability: "nonpayable",
        inputs: [{ name: "targetTokenId", type: "uint256" }],
        outputs: [],
      },
    ],
  },
}));

const { submitTx, recoverPreparedSubmissions } = await import("./flashbots.js");
const { beginBundle, flushBundle, discardBundle } = await import("./flashbots.js");
const { reconcileSubmissionJournal } = await import("./flashbots.js");
const { nonceManager } = await import("./nonce.js");
const { getLatestBlockCached, wsClient } = await import("./chain.js");
const { appConfig } = await import("./config.js");
const { encodePayTaxes, encodeAudit, gameContract } = await import("./contract.js");
const { AtomicWriteCommittedError } = await import("./durability.js");
const { runtime, DEFAULT_STRATEGY } = await import("./runtime.js");
const {
  startEngine,
  stopEngine,
  waitForEngineIdle,
  resetJitState,
  resetPaymentTracking,
  preflightSubmissionRecovery,
  recoverAuthorizedSubmissions,
  schedulePreBoundaryPay,
} = await import("./strategy.js");

const saveJitCampaign = vi.spyOn(runtime, "saveJitCampaign").mockImplementation((next) => {
  runtime.jitCampaign = {
    ...runtime.jitCampaign,
    ...next,
    revision: runtime.jitCampaign.revision + 1,
  };
  return { ...runtime.jitCampaign, tokenIds: [...runtime.jitCampaign.tokenIds] };
});

const FAKE_ACCOUNT = {
  address: "0x1111111111111111111111111111111111111111",
} as unknown as PrivateKeyAccount;

const TX_HASH_0 = `0x${"01".repeat(32)}` as Hex;
const TX_HASH_1 = `0x${"02".repeat(32)}` as Hex;

function journalFlight(args: {
  nonce: number;
  to?: `0x${string}`;
  data: Hex;
  valueWei?: bigint;
  state?: "prepared" | "accepted" | "rejected" | "ambiguous" | "expired";
  attempts?: Array<{
    channel: "public" | "private";
    endpoint: string;
    state: "accepted" | "rejected" | "ambiguous";
  }>;
  updatedAtMs?: number;
  createdAtMs?: number;
  notBeforeTimestamp?: bigint;
  maxPrivateTargetBlock?: bigint;
  publicExposure?: boolean;
  publicAuthorized?: boolean;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}) {
  const byte = (args.nonce + 1).toString(16).padStart(2, "0");
  return {
    wallet: FAKE_ACCOUNT.address,
    nonce: args.nonce,
    rawSignedTx: `0x${byte.repeat(40)}` as Hex,
    txHash: `0x${byte.repeat(32)}` as Hex,
    obligation: {
      to: args.to ?? appConfig.gameAddress,
      data: args.data,
      valueWei: (args.valueWei ?? 0n).toString(),
      gasLimit: (args.gasLimit ?? 100n).toString(),
      maxFeePerGas: (args.maxFeePerGas ?? 2n).toString(),
      maxPriorityFeePerGas: (args.maxPriorityFeePerGas ?? 1n).toString(),
    },
    lineage: { id: `${FAKE_ACCOUNT.address.toLowerCase()}:${args.nonce}` },
    recovery: {
      publicAuthorized: args.publicAuthorized ?? true,
      ...(args.notBeforeTimestamp === undefined
        ? {}
        : { notBeforeTimestamp: args.notBeforeTimestamp.toString() }),
    },
    nonceConflict: false,
    state: args.state ?? "accepted",
    publicExposure: args.publicExposure ?? (args.attempts ?? []).some(
      (attempt) => attempt.channel === "public" && attempt.state !== "rejected",
    ),
    attempts: args.attempts ?? [{
      channel: "public" as const,
      endpoint: "mock",
      state: "accepted" as const,
    }],
    ...(args.maxPrivateTargetBlock === undefined
      ? {}
      : { maxPrivateTargetBlock: args.maxPrivateTargetBlock.toString() }),
    createdAtMs: args.createdAtMs ?? 1,
    updatedAtMs: args.updatedAtMs ?? 1,
  };
}

async function recoveryDecisionFor(
  flight: ReturnType<typeof journalFlight>,
): Promise<boolean> {
  let decision: boolean | undefined;
  vi.mocked(recoverPreparedSubmissions).mockImplementationOnce(async (
    _address,
    _signal,
    authorize,
  ) => {
    if (!authorize) throw new Error("missing recovery authorizer");
    decision = await authorize(flight);
    return {
      confirmedNonce: testState.confirmedNonce,
      pendingNonce: testState.pendingNonce,
      currentBlock: 100n,
      retained: [],
      consumed: [],
      expired: [],
    };
  });
  await recoverAuthorizedSubmissions(FAKE_ACCOUNT.address);
  return decision ?? false;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type TestStrategyOverrides = Partial<typeof DEFAULT_STRATEGY> & {
  enabled?: boolean;
  jitEnabled?: boolean;
  jitTargetEpoch?: number | null;
  jitTokenIds?: string[];
  jitAutoStopOnCompletion?: boolean;
};

function configure(overrides: TestStrategyOverrides = {}): void {
  const {
    enabled,
    jitEnabled = false,
    jitTargetEpoch = null,
    jitTokenIds = ["1"],
    jitAutoStopOnCompletion = false,
    ...strategyOverrides
  } = overrides;
  runtime.strategy = {
    ...DEFAULT_STRATEGY,
    defenseEnabled: enabled ?? true,
    proactivePay: true,
    dryRun: false,
    offenseEnabled: false,
    minBalanceEth: 0,
    maxPaymentEth: 0,
    maxBaseFeeGwei: 100,
    priorityFeeGwei: 2,
    ...strategyOverrides,
  };
  runtime.jitCampaign = jitEnabled && jitTargetEpoch !== null
    ? {
        revision: runtime.jitCampaign.revision + 1,
        state: "armed",
        targetEpoch: jitTargetEpoch,
        tokenIds: [...jitTokenIds],
        autoStopOnCompletion: jitAutoStopOnCompletion,
      }
    : {
        revision: runtime.jitCampaign.revision + 1,
        state: "cancelled",
        targetEpoch: null,
        tokenIds: [],
        autoStopOnCompletion: false,
      };
}

async function startAt(nowSec: bigint): Promise<void> {
  vi.setSystemTime(new Date(Number(nowSec) * 1000));
  startEngine();
  await vi.advanceTimersByTimeAsync(0);
}

describe("defensive payment scheduling and retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetJitState();
    resetPaymentTracking();
    runtime.setJournalHealth(true);
    testState.lastEpochPaid = 0n;
    testState.auditDueTimestamp = 0n;
    testState.estimatedPayWei = 1_000_000_000_000_000n;
    testState.bribeBalance = 0n;
    testState.submitOutcomes = [];
    testState.submitTxHashes = [];
    testState.submitReplacementUuids = [];
    testState.submitLineageIds = [];
    testState.submitRetryImmediately = [];
    testState.submitGate = null;
    testState.blockGate = null;
    testState.candidateGate = null;
    testState.submitQueued = false;
    testState.nextNonce = 0;
    testState.confirmedNonce = 0;
    testState.pendingNonce = 0;
    testState.submittedMaxFeePerGas = 20n;
    testState.submittedMaxPriorityFeePerGas = 2n;
    testState.submittedGasWei = 0n;
    testState.baseFeePerGas = 10_000_000_000n;
    testState.signedCount = 0;
    testState.balanceWei = 10_000_000_000_000_000_000n;
    testState.balanceResponses = [];
    testState.ownedIds = [1n];
    testState.onChainOwnedIds = null;
    testState.lastEpochPaidByToken = new Map();
    testState.auditDueByToken = new Map();
    testState.auditLimitByToken = new Map();
    testState.auditsUsedByToken = new Map();
    testState.ownerByToken = new Map();
    testState.ownerOfFailures = new Set();
    testState.multicallRejectFunctions = new Set();
    testState.receipts = new Map();
    testState.flushResults = new Map();
    testState.candidateIds = [];
    testState.liveTargets = [];
    testState.targetStatuses = [];
    testState.nextActivityId = 0;
    appConfig.mode = "public";
    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(false);

    runtime.account = FAKE_ACCOUNT;
    runtime.running = false;
    runtime.balanceWei = null;
    runtime.currentEpoch = null;
    runtime.gameState = null;
    runtime.citizensAddress = null;
    runtime.startTime = null;
    configure();
  });

  afterEach(() => {
    stopEngine();
    vi.useRealTimers();
  });

  it("pre-submits the recurring tax-skip payment when a one-behind citizen will become auditable next epoch", async () => {
    // Epoch 5, ten seconds before epoch 6. Paid through epoch 4 means the citizen
    // is safe now, but will be two behind at the epoch-6 boundary.
    testState.lastEpochPaid = 4n;
    await startAt(epochStart(6) - 10n);

    expect(submitTx).not.toHaveBeenCalled();

    // Public-mode pre-boundary lead is 3s, so the recurring payment fires 7s later.
    await vi.advanceTimersByTimeAsync(7_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
    const [intent, opts] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(6n * BASE_TAX_RATE_WEI);
    expect(opts.simTimestamp).toBe(epochStart(6));
  });

  it.each([true, false])(
    "gives a boundary payment nonce priority without coupling audit offense (accepted=%s)",
    async (paymentAccepted) => {
    if (!paymentAccepted) testState.submitOutcomes = [false];
    testState.lastEpochPaid = 4n;
    testState.ownedIds = [1n, 2n];
    testState.lastEpochPaidByToken = new Map([["1", 4n], ["2", 5n]]);
    testState.auditLimitByToken = new Map([["2", 1n]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "4",
      delinquent: false,
      epochsBehind: 1,
      auditable: false,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({ offenseEnabled: true, autoAudit: true, autoKill: false });

    await startAt(epochStart(6) - 10n);
    await vi.advanceTimersByTimeAsync(7_500);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xPAYTAXES"]);
    },
  );

  it("still runs a standalone boundary audit when no survival payment is due", async () => {
    testState.lastEpochPaid = 5n;
    testState.ownedIds = [2n];
    testState.lastEpochPaidByToken = new Map([["2", 5n]]);
    testState.auditLimitByToken = new Map([["2", 1n]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "4",
      delinquent: false,
      epochsBehind: 1,
      auditable: false,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: true,
    });

    await startAt(epochStart(6) - 10n);
    await vi.advanceTimersByTimeAsync(7_500);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xAUDIT"]);
  });

  it("fires a pre-boundary audit immediately when startup is already inside its lead window", async () => {
    const boundary = epochStart(6);
    testState.lastEpochPaid = 5n;
    testState.ownedIds = [2n];
    testState.lastEpochPaidByToken = new Map([["2", 5n]]);
    testState.auditLimitByToken = new Map([["2", 1n]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "4",
      delinquent: false,
      epochsBehind: 1,
      auditable: false,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: true,
    });

    // The normal audit fire time was 2.75s before the boundary. Starting one
    // second before it must enqueue the immutable epoch-6 plan immediately.
    await startAt(boundary - 1n);
    await vi.advanceTimersByTimeAsync(500);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xAUDIT"]);
    expect(vi.mocked(submitTx).mock.calls[0]![1].simTimestamp).toBe(boundary);
  });

  it("immediately pays a delinquent unaudited citizen on a regular tick after a missed boundary", async () => {
    // Start after the epoch-7 boundary with payment only through epoch 5.
    testState.lastEpochPaid = 5n;
    testState.estimatedPayWei = 7n * BASE_TAX_RATE_WEI;
    await startAt(epochStart(7) + 60n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(testState.estimatedPayWei);
  });

  it("keeps polling when the WebSocket subscription is silent", async () => {
    testState.lastEpochPaid = 5n;
    configure({ enabled: false, proactivePay: false });
    await startAt(epochStart(5) + 100n);

    expect(wsClient?.watchBlocks).toHaveBeenCalledTimes(1);
    expect(nonceManager.sync).toHaveBeenCalledTimes(1);
    // No mocked onBlock callback fires. The watchdog alone must trigger a tick.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(nonceManager.sync).toHaveBeenCalledTimes(2);
  });

  it("clears a fresh audit immediately using the full audit-first on-chain estimate", async () => {
    const now = epochStart(8) + 100n;
    testState.lastEpochPaid = 6n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 8n * BASE_TAX_RATE_WEI;

    await startAt(now);

    expect(DEFAULT_STRATEGY.auditSafetyBufferSeconds).toBe(Number(EPOCH_SECONDS));
    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(testState.estimatedPayWei);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
  });

  it("keeps JIT armed and retries when submitTx returns ok:false", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 9n * BASE_TAX_RATE_WEI;
    testState.submitOutcomes = [false, true];
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 9 });

    await startAt(epochStart(9) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(runtime.jitCampaign.state).toBe("armed");
    expect(saveJitCampaign).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(runtime.jitCampaign.state).toBe("armed");
    expect(saveJitCampaign).not.toHaveBeenCalled();

    // Relay/broadcast acceptance is not inclusion. JIT disarms only after the
    // next on-chain read confirms lastEpochPaid actually advanced.
    testState.lastEpochPaid = 9n;
    testState.confirmedNonce = testState.nextNonce;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
    expect(runtime.jitCampaign.state).toBe("completed");
  });

  it("runs an armed JIT payment even when continuous defense is disabled", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 9n * BASE_TAX_RATE_WEI;
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 9,
    });

    await startAt(epochStart(9) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 1);
  });

  it("auto-stops after terminal JIT only when no continuous strategy still needs the engine", async () => {
    testState.lastEpochPaid = 9n;
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: false,
      jitEnabled: true,
      jitTargetEpoch: 9,
      jitAutoStopOnCompletion: true,
    });

    await startAt(epochStart(9) + 100n);

    expect(runtime.jitCampaign.state).toBe("completed");
    expect(runtime.running).toBe(false);
  });

  it("keeps running after terminal JIT when continuous defense is enabled", async () => {
    testState.lastEpochPaid = 9n;
    configure({
      enabled: true,
      proactivePay: false,
      offenseEnabled: false,
      jitEnabled: true,
      jitTargetEpoch: 9,
      jitAutoStopOnCompletion: true,
    });

    await startAt(epochStart(9) + 100n);

    expect(runtime.jitCampaign.state).toBe("completed");
    expect(runtime.running).toBe(true);
  });

  it("pauses the engine when JIT terminal state committed but its atomic write was not durable", async () => {
    testState.lastEpochPaid = 9n;
    configure({
      enabled: true,
      proactivePay: false,
      offenseEnabled: false,
      jitEnabled: true,
      jitTargetEpoch: 9,
    });
    saveJitCampaign.mockImplementationOnce((next) => {
      runtime.jitCampaign = {
        ...runtime.jitCampaign,
        ...next,
        revision: runtime.jitCampaign.revision + 1,
      };
      throw new AtomicWriteCommittedError("jit-campaign.json", {
        cause: new Error("directory fsync failed"),
      });
    });

    await startAt(epochStart(9) + 100n);
    await waitForEngineIdle();

    expect(runtime.jitCampaign.state).toBe("completed");
    expect(runtime.running).toBe(false);
  });

  it("counts one confirmed deep-behind pre-boundary JIT payment and disarms without paying again", async () => {
    // The citizen is four epochs behind the target. JIT still promises exactly
    // one epoch, so confirmation means lastEpochPaid advances 5 -> 6, not -> 10.
    testState.lastEpochPaid = 5n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 10 });

    await startAt(epochStart(10) - 10n);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    testState.lastEpochPaid = 6n;
    testState.confirmedNonce = testState.nextNonce;
    await vi.advanceTimersByTimeAsync(3_500);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
    expect(runtime.jitCampaign.state).toBe("completed");

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("preserves the JIT target when audit defense replaces its pending payment", async () => {
    testState.lastEpochPaid = 5n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 10 });

    await startAt(epochStart(10) - 10n);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // At the boundary an audit forces an urgent same-nonce replacement. That
    // replacement still fulfills the one-epoch JIT obligation it superseded.
    testState.auditDueTimestamp = epochStart(10) + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 10n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(3_500);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    testState.lastEpochPaid = 6n;
    testState.auditDueTimestamp = 0n;
    testState.confirmedNonce = testState.nextNonce;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
  });

  it("preserves the JIT target when proactive recovery replaces its pending payment", async () => {
    testState.lastEpochPaid = 5n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 10,
    });

    await startAt(epochStart(10) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    runtime.strategy = { ...runtime.strategy, proactivePay: true };
    await vi.advanceTimersByTimeAsync(36_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    testState.lastEpochPaid = 6n;
    testState.confirmedNonce = testState.nextNonce;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
  });

  it("fails a missed JIT target instead of pricing a later, unauthorized epoch", async () => {
    testState.lastEpochPaid = 9n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 10,
    });

    // Waking in epoch 11 must not spend at epoch-11 pricing for an epoch-10 grant.
    await startAt(epochStart(11) + 100n);
    expect(submitTx).not.toHaveBeenCalled();
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed",
      message: expect.stringContaining("missed target epoch 10"),
    }));
    expect(runtime.jitCampaign.state).toBe("failed");
  });

  it("does not let a stopped stale tick terminalize its JIT campaign", async () => {
    const gate = deferred<void>();
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 9n;
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      dryRun: true,
      jitEnabled: true,
      jitTargetEpoch: 10,
      jitTokenIds: ["1"],
    });
    vi.setSystemTime(new Date(Number(epochStart(10) + 100n) * 1000));
    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledOnce());

    stopEngine();
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(runtime.jitCampaign.state).toBe("armed");
    expect(saveJitCampaign).not.toHaveBeenCalledWith(expect.objectContaining({
      state: "completed-dry-run",
    }));
  });

  it("retains pending-payment dedupe across an engine stop and restart", async () => {
    testState.lastEpochPaid = 12n;
    await startAt(epochStart(14) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    stopEngine();
    startEngine();
    await vi.advanceTimersByTimeAsync(0);

    expect(submitTx).toHaveBeenCalledTimes(1);

    // Confirm before leaving the test so retained run-scoped state cannot leak.
    testState.lastEpochPaid = 13n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("restores one max liability per nonce lineage from the durable journal", async () => {
    const wallet = FAKE_ACCOUNT.address;
    const journalFlight = (valueWei: bigint, hash: Hex, updatedAtMs: number) => ({
      wallet,
      nonce: 0,
      rawSignedTx: `0x${"ab".repeat(40)}` as Hex,
      txHash: hash,
      obligation: {
        to: appConfig.gameAddress,
        data: "0x1234" as Hex,
        valueWei: valueWei.toString(),
        gasLimit: "100",
        maxFeePerGas: "2",
        maxPriorityFeePerGas: "1",
      },
      lineage: { id: `${wallet.toLowerCase()}:0` },
      recovery: { publicAuthorized: true },
      nonceConflict: false,
      state: "accepted" as const,
      publicExposure: true,
      attempts: [{
        channel: "public" as const,
        endpoint: "mock",
        state: "accepted" as const,
      }],
      createdAtMs: 1,
      updatedAtMs,
    });
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [
        journalFlight(2_000n, TX_HASH_0, 1),
        journalFlight(1_000n, TX_HASH_1, 2),
      ],
      consumed: [],
      expired: [],
    });
    configure({ enabled: false, proactivePay: false, offenseEnabled: false });

    await preflightSubmissionRecovery(wallet);

    expect(runtime.status().pendingExposureWei).toBe("2200");
    expect(runtime.status().journalHealthy).toBe(true);
    expect(runtime.running).toBe(false);
  });

  it("reconstructs a rejected lower payment gap from calldata and replaces its exact nonce after restart", async () => {
    const payData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });
    const killData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "kill",
      args: [99n],
    });
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 2,
      currentBlock: 100n,
      retained: [
        journalFlight({
          nonce: 0,
          data: payData,
          valueWei: 20n * BASE_TAX_RATE_WEI,
          state: "ambiguous",
          attempts: [
            { channel: "public", endpoint: "public", state: "rejected" },
            { channel: "private", endpoint: "builder", state: "rejected" },
          ],
        }),
        journalFlight({ nonce: 1, data: killData, state: "accepted" }),
      ],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 18n;
    configure({ preBoundaryPay: false });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(epochStart(20) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement).toEqual(
      expect.objectContaining({ nonce: 0 }),
    );
    expect(testState.nextNonce).toBe(0);
  });

  it("retains payment semantics and max liability when a gap filler is the newest journal alternative", async () => {
    const payData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });
    const originalValue = 20n * BASE_TAX_RATE_WEI;
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [
        journalFlight({
          nonce: 0,
          data: payData,
          valueWei: originalValue,
          updatedAtMs: 1,
        }),
        journalFlight({
          nonce: 0,
          to: FAKE_ACCOUNT.address,
          data: "0x",
          valueWei: 0n,
          updatedAtMs: 2,
        }),
      ],
      consumed: [],
      expired: [],
    });
    const now = epochStart(20) + 100n;
    testState.lastEpochPaid = 19n;
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 19,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);

    // The accepted filler remains an unresolved payment nonce and therefore
    // fences higher best-effort offense. Its zero value must not erase the more
    // expensive mutually-exclusive tax alternative from the safety ledger.
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0]).toEqual(expect.objectContaining({
      to: FAKE_ACCOUNT.address,
      data: "0x",
      value: 0n,
    }));
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement?.nonce).toBe(0);
    expect(runtime.status().pendingExposureWei).toBe(
      (originalValue + 200n).toString(),
    );
  });

  it("uses createdAt as the deterministic tie-break when journal alternatives share updatedAt", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    const payData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });
    const timestamp = Date.now();
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [
        journalFlight({
          nonce: 0,
          data: payData,
          valueWei: 20n * BASE_TAX_RATE_WEI,
          createdAtMs: timestamp - 2,
          updatedAtMs: timestamp,
        }),
        journalFlight({
          nonce: 0,
          to: FAKE_ACCOUNT.address,
          data: "0x",
          createdAtMs: timestamp - 1,
          updatedAtMs: timestamp,
        }),
      ],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 19n;

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);
    expect(submitTx).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(36_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0x");
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement?.nonce).toBe(0);
  });

  it("immediately retries an accepted private-expired lower filler below a live higher nonce", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    const payData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });
    const killData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "kill",
      args: [99n],
    });
    const privateAccepted = [{
      channel: "private" as const,
      endpoint: "builder",
      state: "accepted" as const,
    }];
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 2,
      currentBlock: 100n,
      retained: [
        journalFlight({ nonce: 0, data: payData, valueWei: 20n * BASE_TAX_RATE_WEI }),
        journalFlight({
          nonce: 0,
          to: FAKE_ACCOUNT.address,
          data: "0x",
          attempts: privateAccepted,
          publicExposure: false,
          maxPrivateTargetBlock: 99n,
          createdAtMs: 2,
          updatedAtMs: Date.now(),
        }),
        journalFlight({ nonce: 1, data: killData }),
      ],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 19n;

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0x");
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement?.nonce).toBe(0);
  });

  it("rejects recovery of a stale multi-epoch defense raw after external progress made the token safe", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    testState.lastEpochPaid = 19n;
    testState.estimatedPayWei = 2n * 20n * BASE_TAX_RATE_WEI;
    configure({ prepayEpochs: 2, maxAutoPayEpochs: 2 });
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 2],
    });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      data,
      valueWei: testState.estimatedPayWei,
    }))).resolves.toBe(false);
  });

  it("rejects recovered payments after defense authority is withdrawn but retains inert cancellation authority", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    testState.lastEpochPaid = 18n;
    testState.estimatedPayWei = 20n * BASE_TAX_RATE_WEI;
    configure({ enabled: false, proactivePay: false });
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      data,
      valueWei: testState.estimatedPayWei,
    }))).resolves.toBe(false);
    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      to: FAKE_ACCOUNT.address,
      data: "0x",
    }))).resolves.toBe(true);
  });

  it("rejects recovery when the operator lowers the single-payment cap below the signed value", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    testState.lastEpochPaid = 18n;
    testState.estimatedPayWei = 20n * BASE_TAX_RATE_WEI;
    configure({ maxPaymentEth: 0.001 });
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      data,
      valueWei: testState.estimatedPayWei,
    }))).resolves.toBe(false);
  });

  it.each(["payment", "offense", "inert"] as const)(
    "never authorizes a recovered %s transaction while dry-run is enabled",
    async (kind) => {
      const now = epochStart(20) + 100n;
      vi.setSystemTime(new Date(Number(now) * 1000));
      configure({
        dryRun: true,
        offenseEnabled: true,
        autoKill: true,
        offenseTargetTokenIds: [],
      });
      const data = kind === "payment"
        ? encodeFunctionData({
            abi: gameContract.abi,
            functionName: "payTaxes",
            args: [1n, 1],
          })
        : kind === "offense"
          ? encodeFunctionData({
              abi: gameContract.abi,
              functionName: "kill",
              args: [99n],
            })
          : "0x" as Hex;

      await expect(recoveryDecisionFor(journalFlight({
        nonce: 0,
        to: kind === "inert" ? FAKE_ACCOUNT.address : undefined,
        data,
      }))).resolves.toBe(false);
    },
  );

  it.each([
    {
      name: "current base-fee cap",
      overrides: { maxBaseFeeGwei: 5 } as TestStrategyOverrides,
    },
    {
      name: "offense base-fee cap when its original gas class is unknown",
      overrides: {
        separateOffenseGas: true,
        offenseMaxBaseFeeGwei: 5,
      } as TestStrategyOverrides,
    },
    {
      name: "signed priority-fee ceiling",
      maxPriorityFeePerGas: 3_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
    {
      name: "signed max-fee ceiling",
      maxFeePerGas: 203_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
  ])("rejects an inert recovery outside the current $name", async ({
    overrides,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }) => {
    configure({
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
      dynamicTipEnabled: false,
      replacementPriorityFeeCapGwei: 2,
      ...overrides,
    });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      to: FAKE_ACCOUNT.address,
      data: "0x",
      maxFeePerGas,
      maxPriorityFeePerGas,
    }))).resolves.toBe(false);
  });

  it.each([
    {
      name: "payment current base-fee cap",
      kind: "payment" as const,
      overrides: { maxBaseFeeGwei: 5 } as TestStrategyOverrides,
    },
    {
      name: "offense current base-fee cap",
      kind: "offense" as const,
      overrides: { separateOffenseGas: true, offenseMaxBaseFeeGwei: 5 } as TestStrategyOverrides,
    },
    {
      name: "payment signed priority-fee ceiling",
      kind: "payment" as const,
      maxPriorityFeePerGas: 3_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
    {
      name: "offense signed priority-fee ceiling",
      kind: "offense" as const,
      maxPriorityFeePerGas: 3_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
    {
      name: "payment signed max-fee ceiling",
      kind: "payment" as const,
      maxFeePerGas: 203_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
    {
      name: "offense signed max-fee ceiling",
      kind: "offense" as const,
      maxFeePerGas: 203_000_000_000n,
      overrides: {} as TestStrategyOverrides,
    },
  ])("rejects recovery after withdrawal of the $name", async ({
    kind,
    overrides,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }) => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    testState.lastEpochPaid = 18n;
    testState.estimatedPayWei = 20n * BASE_TAX_RATE_WEI;
    testState.auditDueByToken.set("99", now - 1n);
    configure({
      enabled: kind === "payment",
      proactivePay: true,
      offenseEnabled: kind === "offense",
      autoKill: true,
      offenseTargetTokenIds: [],
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
      dynamicTipEnabled: false,
      replacementPriorityFeeCapGwei: 2,
      separateOffenseGas: true,
      offenseMaxBaseFeeGwei: 100,
      offensePriorityFeeGwei: 2,
      offenseDynamicTipEnabled: false,
      offenseReplacementPriorityFeeCapGwei: 2,
      ...overrides,
    });
    const data = kind === "payment"
      ? encodeFunctionData({
          abi: gameContract.abi,
          functionName: "payTaxes",
          args: [1n, 1],
        })
      : encodeFunctionData({
          abi: gameContract.abi,
          functionName: "kill",
          args: [99n],
        });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      data,
      valueWei: kind === "payment" ? testState.estimatedPayWei : 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    }))).resolves.toBe(false);
  });

  it.each([
    {
      name: "audit target allowlist",
      kind: "audit" as const,
      overrides: { offenseTargetTokenIds: ["100"] } as TestStrategyOverrides,
    },
    {
      name: "kill target allowlist",
      kind: "kill" as const,
      overrides: { offenseTargetTokenIds: ["100"] } as TestStrategyOverrides,
    },
    {
      name: "endgame window",
      kind: "kill" as const,
      overrides: { endgameOnlyWithin: 0 } as TestStrategyOverrides,
    },
    {
      name: "pre-boundary audit setting",
      kind: "audit" as const,
      boundary: true,
      overrides: { preBoundaryAudit: false } as TestStrategyOverrides,
    },
    {
      name: "pre-boundary kill setting",
      kind: "kill" as const,
      boundary: true,
      overrides: { preBoundaryKill: false } as TestStrategyOverrides,
    },
    {
      name: "mainnet public-mempool permission",
      kind: "kill" as const,
      mainnet: true,
      overrides: { racePublicMempool: false } as TestStrategyOverrides,
    },
  ])("rejects recovered offense after withdrawal of the $name", async ({
    kind,
    boundary,
    mainnet,
    overrides,
  }) => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    if (mainnet) appConfig.mode = "mainnet";
    const notBeforeTimestamp = boundary
      ? kind === "audit" ? epochStart(21) : now + 101n
      : undefined;
    testState.lastEpochPaidByToken.set("1", 20n);
    testState.lastEpochPaidByToken.set("99", boundary ? 19n : 18n);
    testState.auditLimitByToken.set("1", 1n);
    testState.auditDueByToken.set(
      "99",
      kind === "kill" ? (notBeforeTimestamp ?? now) - 1n : 0n,
    );
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: true,
      offenseTargetTokenIds: [],
      endgameOnlyWithin: null,
      preBoundaryAudit: true,
      preBoundaryKill: true,
      racePublicMempool: true,
      ...overrides,
    });
    const data = kind === "audit"
      ? encodeFunctionData({
          abi: gameContract.abi,
          functionName: "audit",
          args: [1n, 99n],
        })
      : encodeFunctionData({
          abi: gameContract.abi,
          functionName: "kill",
          args: [99n],
        });

    await expect(recoveryDecisionFor(journalFlight({
      nonce: 0,
      data,
      valueWei: kind === "audit" ? 1n : 0n,
      notBeforeTimestamp,
    }))).resolves.toBe(false);
  });

  it("replays only currently live action raws, treating per-call owner failure as retained and top-level RPC failure as blocking", async () => {
    const now = epochStart(20) + 100n;
    vi.setSystemTime(new Date(Number(now) * 1000));
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
    });
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "kill",
      args: [99n],
    });
    const raw = journalFlight({ nonce: 0, data });

    testState.auditDueByToken.set("99", 0n);
    await expect(recoveryDecisionFor(raw)).resolves.toBe(false);

    testState.auditDueByToken.set("99", now - 1n);
    await expect(recoveryDecisionFor(raw)).resolves.toBe(true);

    testState.ownerByToken.set("99", FAKE_ACCOUNT.address);
    await expect(recoveryDecisionFor(raw)).resolves.toBe(false);

    testState.ownerByToken.clear();
    testState.ownerOfFailures.add("99");
    await expect(recoveryDecisionFor(raw)).resolves.toBe(false);

    testState.ownerOfFailures.clear();
    testState.multicallRejectFunctions.add("auditDueTimestamp");
    await expect(recoveryDecisionFor(raw)).rejects.toThrow("multicall RPC unavailable");
  });

  it("keeps JIT armed until a recovered matching payment with null campaign fields is terminal", async () => {
    const now = epochStart(20) + 100n;
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "payTaxes",
      args: [1n, 1],
    });
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [journalFlight({
        nonce: 0,
        data,
        valueWei: 20n * BASE_TAX_RATE_WEI,
      })],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 20n;
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 20,
    });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0x");
    expect(runtime.jitCampaign.state).toBe("armed");
    expect(saveJitCampaign).not.toHaveBeenCalled();

    testState.confirmedNonce = 1;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runtime.jitCampaign.state).toBe("completed");
    expect(saveJitCampaign).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
  });

  it("reports an unhealthy journal and rejects paused recovery", async () => {
    vi.mocked(reconcileSubmissionJournal).mockRejectedValueOnce(new Error("journal checksum mismatch"));

    await expect(preflightSubmissionRecovery(FAKE_ACCOUNT.address)).rejects.toThrow(
      "submission recovery failed; refusing to allocate a nonce: journal checksum mismatch",
    );

    expect(runtime.status().journalHealthy).toBe(false);
    expect(runtime.status().journalError).toBe("journal checksum mismatch");
    expect(runtime.running).toBe(false);
  });

  it("discards a queued batch when stop is requested during submission", async () => {
    const gate = deferred<void>();
    appConfig.mode = "mainnet";
    testState.submitQueued = true;
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 12n;

    vi.setSystemTime(new Date(Number(epochStart(14) + 100n) * 1000));
    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));

    stopEngine();
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(discardBundle).toHaveBeenCalledTimes(1);
    expect(flushBundle).not.toHaveBeenCalled();
    expect(runtime.running).toBe(false);
  });

  it("flushes a queued mainnet payment using the mode captured when its batch opened", async () => {
    const gate = deferred<void>();
    appConfig.mode = "mainnet";
    testState.submitQueued = true;
    testState.submitGate = gate.promise;
    testState.flushResults = new Map([[0, { ok: true }]]);
    testState.lastEpochPaid = 12n;

    vi.setSystemTime(new Date(Number(epochStart(14) + 100n) * 1000));
    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));

    // Model a hostile live settings mutation. The API now stops/awaits first,
    // but the batch itself must also be immune to a changing global mode.
    appConfig.mode = "public";
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(flushBundle).toHaveBeenCalledTimes(1);
  });

  it("never pays a configured JIT token that the active wallet does not own", async () => {
    testState.ownedIds = [1n];
    testState.lastEpochPaid = 15n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 16,
      jitTokenIds: ["2"],
    });

    await startAt(epochStart(16) + 100n);

    expect(submitTx).not.toHaveBeenCalled();
    expect(encodePayTaxes).not.toHaveBeenCalledWith(2n, expect.any(Number));
    expect(runtime.jitCampaign.state).toBe("armed");
  });

  it("does not allocate a fresh payment above an unresolved private nonce", async () => {
    appConfig.mode = "mainnet";
    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(true);
    testState.lastEpochPaid = 15n;

    await startAt(epochStart(17) + 100n);
    expect(submitTx).not.toHaveBeenCalled();

    vi.mocked(nonceManager.hasInvisibleReservation).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("removes a failed proactive marker so the next regular tick retries", async () => {
    testState.lastEpochPaid = 8n;
    testState.estimatedPayWei = 10n * BASE_TAX_RATE_WEI;
    testState.submitOutcomes = [false, true];

    await startAt(epochStart(10) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);

    // A successful submission remains marked for the epoch, preventing duplicates.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("waits for the replacement threshold before replacing an accepted but unmined payment at the same nonce", async () => {
    testState.lastEpochPaid = 18n;
    testState.submitTxHashes = [TX_HASH_0];
    testState.submitReplacementUuids = [["fb-uuid-0", "fb-uuid-1"]];
    testState.submitLineageIds = ["payment-lineage-0"];
    await startAt(epochStart(20) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].replacement).toBeUndefined();

    // Polls at 12s and 24s must keep deduping the accepted transaction.
    await vi.advanceTimersByTimeAsync(24_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The first poll after the 30s threshold is at 36s. It must replace the
    // original transaction, not allocate a new nonce behind it.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement).toEqual(expect.objectContaining({
      nonce: 0,
      priorMaxFeePerGas: 20n,
      priorMaxPriorityFeePerGas: 2n,
      priorTxHash: TX_HASH_0,
      lineageId: "payment-lineage-0",
      replacementUuids: ["fb-uuid-0", "fb-uuid-1"],
    }));

    testState.lastEpochPaid = 19n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("immediately replaces a same-value payment when its priced epoch becomes stale", async () => {
    testState.lastEpochPaid = 18n;
    testState.estimatedPayWei = 1_000_000_000_000_000n;
    configure({ preBoundaryPay: false });

    await startAt(epochStart(21) - 5n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The next watchdog tick is in epoch 21 but uses the same mocked estimate.
    // Epoch authority alone is enough to force a same-nonce refresh under 30s.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
  });

  it("immediately fills a transport-reported lower nonce gap", async () => {
    testState.lastEpochPaid = 18n;
    testState.submitRetryImmediately = [true];
    await startAt(epochStart(20) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
  });

  it("fills an externally covered rejected lower payment with a zero-value same-nonce transfer", async () => {
    appConfig.mode = "mainnet";
    testState.submitQueued = true;
    testState.ownedIds = [1n, 2n];
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 1_000_000_000_000_000n;
    testState.flushResults = new Map([
      [0, {
        ok: true,
        uncertain: true,
        retryImmediately: true,
        error: "delivery rejected; retained to fill an exposed higher-nonce gap",
      }],
      [1, { ok: true }],
    ]);
    configure({ preBoundaryPay: false });

    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(testState.nextNonce).toBe(2);

    // A different payer advances only the lower token. Its original value must
    // remain reserved, but the bot now needs nonce 0 to be executable rather than
    // another tax payment or a fresh nonce 2.
    testState.lastEpochPaidByToken.set("1", 21n);
    testState.flushResults = new Map([[0, { ok: true }]]);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(3);
    const [gapIntent, gapOpts] = vi.mocked(submitTx).mock.calls[2]!;
    expect(gapIntent).toEqual(expect.objectContaining({
      to: FAKE_ACCOUNT.address,
      data: "0x",
      value: 0n,
      gas: 21_000n,
    }));
    expect(gapOpts.replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(2);
    expect(runtime.status().pendingExposureWei).toBe(
      (2n * testState.estimatedPayWei).toString(),
    );
  });

  it("does not submit another bribe-clear nonce while the first action is unresolved", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.auditDueTimestamp = now + 100n;
    testState.bribeBalance = 1n;
    configure({
      proactivePay: false,
      preBoundaryPay: false,
      autoUseBribe: true,
    });

    await startAt(now);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xBRIBE"]);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xBRIBE"]);
    expect(testState.nextNonce).toBe(1);

    await vi.advanceTimersByTimeAsync(24_000);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xBRIBE",
      "0xBRIBE",
    ]);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(1);
  });

  it("does not submit another kill nonce while the first action is unresolved", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await startAt(now);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xKILL"]);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xKILL"]);
    expect(testState.nextNonce).toBe(1);

    await vi.advanceTimersByTimeAsync(24_000);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xKILL",
      "0xKILL",
    ]);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(1);
  });

  it("rechecks the audit source owner immediately before signing", async () => {
    const now = epochStart(15) + 100n;
    const gate = deferred<void>();
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 15n;
    testState.auditLimitByToken.set("1", 1n);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: true,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });
    vi.setSystemTime(new Date(Number(now) * 1000));

    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));
    testState.ownerByToken.set("1", "0x9999999999999999999999999999999999999999");
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(testState.signedCount).toBe(0);
    expect(testState.nextNonce).toBe(0);
  });

  it("rechecks that an offense target is still rival-owned immediately before signing", async () => {
    const now = epochStart(15) + 100n;
    const gate = deferred<void>();
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 15n;
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });
    vi.setSystemTime(new Date(Number(now) * 1000));

    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));
    testState.ownerByToken.set("99", FAKE_ACCOUNT.address);
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(testState.signedCount).toBe(0);
    expect(testState.nextNonce).toBe(0);
  });

  it("replaces a live action at the same nonce under a tight floor without double-counting its old liability", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.submittedGasWei = 7_500_000_000_000_000n;
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      minBalanceEth: 9.991,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await startAt(now);
    await vi.advanceTimersByTimeAsync(36_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![0].data).toBe("0xKILL");
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(1);
  });

  it("reuses the originally reserved auditor for an aged same-nonce audit replacement", async () => {
    const now = epochStart(15) + 100n;
    testState.ownedIds = [1n, 2n];
    testState.lastEpochPaid = 15n;
    testState.auditLimitByToken = new Map([["1", 1n], ["2", 1n]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: true,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await startAt(now);
    expect(encodeAudit).toHaveBeenCalledTimes(1);
    const originalAuditor = vi.mocked(encodeAudit).mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(36_000);

    expect(encodeAudit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(encodeAudit).mock.calls[1]![0]).toBe(originalAuditor);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
  });

  it("neutralizes a lower optional action before the payment floor pre-guard can deadlock survival work", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.submittedGasWei = 8_000_000_000_000_000n;
    testState.auditLimitByToken.set("1", 1n);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: true,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      minBalanceEth: 9.976,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await startAt(now);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xAUDIT"]);

    // Payment alone fits the floor, but payment + the unresolved optional audit
    // does not. The cancellation must nevertheless be prepared before testing
    // payment affordability, or every later payment pass would deadlock here.
    runtime.strategy = {
      ...runtime.strategy,
      defenseEnabled: true,
      proactivePay: true,
      offenseEnabled: false,
    };
    testState.lastEpochPaid = 13n;
    testState.estimatedPayWei = 15n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xAUDIT",
      "0x",
    ]);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    testState.confirmedNonce = 1;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xAUDIT",
      "0x",
      "0xPAYTAXES",
    ]);
    expect(vi.mocked(submitTx).mock.calls[2]![1].replacement).toBeUndefined();
  });

  it("fills an obsolete lower action nonce so a higher accepted action can execute", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.candidateIds = [99n, 100n];
    testState.liveTargets = [99n, 100n].map((id) => ({
      id,
      owner: "0x9999999999999999999999999999999999999999" as const,
    }));
    testState.targetStatuses = [99n, 100n].map((id) => ({
      tokenId: id.toString(),
      owner: "0x9999999999999999999999999999999999999999" as const,
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }));
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await startAt(now);
    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xKILL",
      "0xKILL",
    ]);

    testState.targetStatuses = testState.targetStatuses.map((status) =>
      status.tokenId === "99"
        ? { ...status, auditDueTimestamp: "0", killable: false }
        : status);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual([
      "0xKILL",
      "0xKILL",
      "0x",
    ]);
    expect(vi.mocked(submitTx).mock.calls[2]![1].replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(2);
  });

  it("restores a future-valid kill timestamp and does not classify it obsolete before its boundary", async () => {
    const now = epochStart(15) + 100n;
    const due = now + 100n;
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "kill",
      args: [99n],
    });
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [journalFlight({
        nonce: 0,
        data,
        notBeforeTimestamp: due + 1n,
      })],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 15n;
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: due.toString(),
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);

    expect(submitTx).not.toHaveBeenCalled();
    expect(runtime.status().pendingExposureWei).toBe("200");
  });

  it("fills a restored action after a resolved ownerOf revert but retains it on top-level RPC uncertainty", async () => {
    const now = epochStart(15) + 100n;
    const data = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "kill",
      args: [99n],
    });
    const reconciliation = {
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [journalFlight({ nonce: 0, data })],
      consumed: [],
      expired: [],
    };
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce(reconciliation);
    testState.lastEpochPaid = 15n;
    testState.ownerOfFailures.add("99");
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0].data).toBe("0x");

    stopEngine();
    await waitForEngineIdle();
    resetPaymentTracking();
    vi.clearAllMocks();
    testState.ownerOfFailures.clear();
    testState.multicallRejectFunctions.add("auditDueTimestamp");
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce(reconciliation);
    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(now);

    expect(submitTx).not.toHaveBeenCalled();
    expect(runtime.status().pendingExposureWei).toBe("200");
  });

  it("reserves journal-restored auditor capacity across restart and later ticks", async () => {
    const auditData = encodeFunctionData({
      abi: gameContract.abi,
      functionName: "audit",
      args: [1n, 99n],
    });
    vi.mocked(reconcileSubmissionJournal).mockResolvedValueOnce({
      confirmedNonce: 0,
      pendingNonce: 1,
      currentBlock: 100n,
      retained: [journalFlight({ nonce: 0, data: auditData, valueWei: 1n })],
      consumed: [],
      expired: [],
    });
    testState.lastEpochPaid = 15n;
    testState.lastEpochPaidByToken.set("99", 1n);
    testState.auditLimitByToken.set("1", 1n);
    testState.auditsUsedByToken.set("1", 0n);
    testState.candidateIds = [100n];
    testState.liveTargets = [{
      id: 100n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "100",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: true,
      auditDueTimestamp: "0",
      killable: false,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      offenseEnabled: true,
      autoAudit: true,
      autoKill: false,
      preBoundaryAudit: false,
      preBoundaryKill: false,
    });

    await preflightSubmissionRecovery(FAKE_ACCOUNT.address);
    await startAt(epochStart(15) + 100n);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).not.toHaveBeenCalled();
    expect(runtime.status().pendingExposureWei).toBe("201");
  });

  it("never releases a public fee-capped flight from wall-clock age alone", async () => {
    testState.lastEpochPaid = 18n;
    testState.submittedMaxPriorityFeePerGas = 50_100_000_000n;
    testState.submittedMaxFeePerGas = 250_100_000_000n;
    await startAt(epochStart(20) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Replacement attempts are safely capped; no ever-higher transaction is
    // signed while the nonce reservation is still in its safety window.
    await vi.advanceTimersByTimeAsync(84_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Even after the old 90s threshold, an unconfirmed public transaction can
    // still be live in a remote txpool and remains a reserved liability.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("clears the current same-nonce flight when an older attempt reverts and retries with a fresh nonce", async () => {
    const originalReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    const replacementReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.receipts.set(TX_HASH_0, originalReceipt.promise);
    testState.receipts.set(TX_HASH_1, replacementReceipt.promise);
    testState.lastEpochPaid = 20n;
    const now = epochStart(22) + 100n;

    await startAt(now);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // Audit defense urgently replaces the proactive attempt at the same nonce.
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 22n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);

    // If the older hash mines reverted, nonce 0 is consumed. Its replacement
    // can no longer land, even though that newer attempt is the tracked flight.
    originalReceipt.resolve({ status: "reverted", blockNumber: 101n });
    await vi.advanceTimersByTimeAsync(0);
    testState.auditDueTimestamp = 0n;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(3);
    expect(vi.mocked(submitTx).mock.calls[2]![1].replacement).toBeUndefined();
    expect(vi.mocked(submitTx).mock.results[2]?.value).toBeDefined();

    const third = await vi.mocked(submitTx).mock.results[2]!.value;
    expect(third.nonce).toBe(1);

    testState.lastEpochPaid = 21n;
    await vi.advanceTimersByTimeAsync(12_000);
  });

  it("uses a fresh nonce when a missed receipt consumed the old nonce without advancing taxes", async () => {
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.lastEpochPaid = 20n;
    await startAt(epochStart(22) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    // Receipt tracking for TX_HASH_0 has already failed in the mock. A later
    // confirmed wallet nonce proves nonce 0 was mined/reverted elsewhere while
    // lastEpochPaid stayed unchanged.
    testState.confirmedNonce = 1;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    const second = vi.mocked(submitTx).mock.calls[1]![1];
    expect(second.replacement).toBeUndefined();
    const result = await vi.mocked(submitTx).mock.results[1]!.value;
    expect(result.nonce).toBe(1);
  });

  it("does not let a late receipt resurrect payment state after an identity reset", async () => {
    const oldReceipt = deferred<{ status: "success" | "reverted"; blockNumber: bigint }>();
    testState.submitTxHashes = [TX_HASH_0, TX_HASH_1];
    testState.receipts.set(TX_HASH_0, oldReceipt.promise);
    testState.lastEpochPaid = 20n;
    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    resetPaymentTracking();
    oldReceipt.resolve({ status: "success", blockNumber: 101n });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement).toBeUndefined();
  });

  it("reserves prior-tick pending exposure before allowing a different payment nonce", async () => {
    testState.ownedIds = [1n];
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 600_000_000_000_000_000n;
    configure({ minBalanceEth: 9, preBoundaryPay: false });

    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(BigInt(runtime.status().pendingExposureWei)).toBe(600_000_000_000_000_000n);

    // The node's mocked balance is still 10 ETH. Token #2 would independently
    // pass, but both unique nonce liabilities would breach the 9 ETH floor.
    testState.ownedIds = [2n];
    testState.ownerByToken.set("1", FAKE_ACCOUNT.address);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("retains nonce exposure when another payer covers the token obligation", async () => {
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 500_000_000_000_000_000n;

    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);
    const exposure = runtime.status().pendingExposureWei;
    expect(BigInt(exposure)).toBe(testState.estimatedPayWei);

    // Token state advances, but our nonce 0 remains unconsumed. This may have
    // been another payer; obligation coverage is not transaction terminality.
    testState.lastEpochPaid = 21n;
    testState.confirmedNonce = 0;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![0]).toEqual(expect.objectContaining({
      to: FAKE_ACCOUNT.address,
      data: "0x",
      value: 0n,
    }));
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    expect(runtime.status().pendingExposureWei).toBe(exposure);

    // Only explicit nonce consumption may release the retained liability.
    testState.confirmedNonce = 1;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runtime.status().pendingExposureWei).toBe("0");
  });

  it("cancels a pending payment at the same nonce when ownership transfers without tax progress", async () => {
    const now = epochStart(22) + 100n;
    testState.lastEpochPaid = 20n;

    await startAt(now);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(testState.signedCount).toBe(1);

    testState.ownerByToken.set("1", "0x9999999999999999999999999999999999999999");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![0]).toEqual(expect.objectContaining({
      to: FAKE_ACCOUNT.address,
      data: "0x",
      value: 0n,
    }));
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    // The inert replacement deliberately bypasses semantic ownerOf checks.
    expect(testState.signedCount).toBe(2);
  });

  it("cancels a multi-epoch raw after any coherent partial external progress", async () => {
    const now = epochStart(22) + 100n;
    testState.lastEpochPaid = 19n;
    testState.estimatedPayWei = 2n * 22n * BASE_TAX_RATE_WEI;
    configure({ prepayEpochs: 2, maxAutoPayEpochs: 2, preBoundaryPay: false });

    await startAt(now);
    expect(encodePayTaxes).toHaveBeenCalledWith(1n, 2);
    expect(submitTx).toHaveBeenCalledTimes(1);

    testState.lastEpochPaid = 20n;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![0].data).toBe("0x");
    expect(vi.mocked(submitTx).mock.calls[1]![1].replacement?.nonce).toBe(0);
    expect(testState.nextNonce).toBe(1);
  });

  it("retains a covered payment without allocating a fresh nonce when its filler fee cap is exhausted", async () => {
    const now = epochStart(22) + 100n;
    testState.lastEpochPaid = 20n;
    testState.submittedMaxPriorityFeePerGas = 50_100_000_000n;
    testState.submittedMaxFeePerGas = 250_100_000_000n;

    await startAt(now);
    expect(submitTx).toHaveBeenCalledTimes(1);
    const exposure = runtime.status().pendingExposureWei;

    testState.lastEpochPaid = 21n;
    await vi.advanceTimersByTimeAsync(24_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(testState.nextNonce).toBe(1);
    expect(runtime.status().pendingExposureWei).toBe(exposure);
  });

  it("rechecks payment ownership immediately before signing", async () => {
    const gate = deferred<void>();
    testState.submitGate = gate.promise;
    testState.lastEpochPaid = 20n;
    vi.setSystemTime(new Date(Number(epochStart(22) + 100n) * 1000));

    startEngine();
    await vi.waitFor(() => expect(submitTx).toHaveBeenCalledTimes(1));
    testState.ownerByToken.set("1", "0x9999999999999999999999999999999999999999");
    gate.resolve(undefined);
    await waitForEngineIdle();

    expect(testState.signedCount).toBe(0);
    expect(testState.nextNonce).toBe(0);
  });

  it("does not pay for an indexer-stale token no longer owned on-chain", async () => {
    testState.ownedIds = [1n];
    testState.onChainOwnedIds = [];
    testState.lastEpochPaid = 20n;

    await startAt(epochStart(22) + 100n);

    expect(submitTx).not.toHaveBeenCalled();
    expect(runtime.status().pendingExposureWei).toBe("0");
  });

  it("executes an explicitly armed JIT token despite a stale-negative indexer", async () => {
    testState.ownedIds = [];
    testState.onChainOwnedIds = [1n];
    testState.lastEpochPaid = 21n;
    configure({
      enabled: false,
      proactivePay: false,
      preBoundaryPay: false,
      jitEnabled: true,
      jitTargetEpoch: 22,
      jitTokenIds: ["1"],
    });

    await startAt(epochStart(22) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![0]).toMatchObject({ value: testState.estimatedPayWei });
  });

  it("refetches balance after terminal reconciliation before releasing spend headroom", async () => {
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 1_000_000_000_000_000_000n;
    configure({ minBalanceEth: 8.5, preBoundaryPay: false });

    await startAt(epochStart(22) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The tick's parallel snapshot sees the pre-confirmation 10 ETH balance.
    // Reconciliation then observes nonce 0 consumed; the post-reconciliation
    // balance is only 9 ETH, which cannot fund another 1 ETH payment above the
    // 8.5 ETH floor.
    testState.ownedIds = [2n];
    testState.confirmedNonce = 1;
    testState.balanceResponses = [
      10_000_000_000_000_000_000n,
      9_000_000_000_000_000_000n,
    ];
    await vi.advanceTimersByTimeAsync(12_000);

    expect(runtime.balanceWei).toBe(9_000_000_000_000_000_000n);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("rejects the exact transport gas quote before signing when it breaches the floor", async () => {
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 100_000_000_000_000_000n;
    testState.submittedGasWei = 1_000_000_000_000_000_000n;
    configure({ minBalanceEth: 9, preBoundaryPay: false });

    // The preliminary 200k estimate fits, but transport's exact quoted gas does
    // not. The last-moment authorization must reject before nonce/signature/WAL.
    await startAt(epochStart(22) + 100n);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(testState.signedCount).toBe(0);
    expect(runtime.status().pendingExposureWei).toBe("0");
  });

  it("moves pending exposure to confirmed spend using receipt gas, not submission estimates", async () => {
    const receipt = deferred<{
      status: "success" | "reverted";
      blockNumber: bigint;
      gasUsed?: bigint;
      effectiveGasPrice?: bigint;
    }>();
    testState.submitTxHashes = [TX_HASH_0];
    testState.receipts.set(TX_HASH_0, receipt.promise);
    testState.lastEpochPaid = 20n;
    testState.estimatedPayWei = 1_000_000_000_000_000n;

    await startAt(epochStart(22) + 100n);
    const before = BigInt(runtime.status().confirmedSpendThisEpochWei);
    expect(BigInt(runtime.status().pendingExposureWei)).toBe(testState.estimatedPayWei);

    receipt.resolve({
      status: "success",
      blockNumber: 101n,
      gasUsed: 21_000n,
      effectiveGasPrice: 3n,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.status().pendingExposureWei).toBe("0");
    expect(BigInt(runtime.status().confirmedSpendThisEpochWei) - before).toBe(
      testState.estimatedPayWei + 63_000n,
    );
  });

  it("does not duplicate a successful pre-boundary proactive payment while its on-chain state is still stale", async () => {
    testState.lastEpochPaid = 4n;
    testState.estimatedPayWei = 6n * BASE_TAX_RATE_WEI;
    await startAt(epochStart(6) - 10n);

    // Submit successfully three seconds before the boundary. The mocked chain
    // deliberately keeps lastEpochPaid at 4, representing a transaction in flight.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The 12-second regular poll lands two seconds into epoch 6. It must recognize
    // the pre-boundary submission as pending instead of submitting another payment.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending pre-boundary payment at the same nonce if an audit lands first", async () => {
    testState.lastEpochPaid = 4n;
    await startAt(epochStart(6) - 10n);

    await vi.advanceTimersByTimeAsync(7_000);
    expect(submitTx).toHaveBeenCalledTimes(1);

    // The audit changes the required payment while the nonce-0 transaction is
    // still pending. Defense must replace nonce 0, not queue nonce 1 behind a
    // payment that is now invalid at its original value.
    testState.auditDueTimestamp = epochStart(6) + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 6n * BASE_TAX_RATE_WEI;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submitTx).toHaveBeenCalledTimes(2);
    const [, replacementOpts] = vi.mocked(submitTx).mock.calls[1]!;
    expect(replacementOpts.replacement).toEqual(expect.objectContaining({
      nonce: 0,
      priorMaxFeePerGas: 20n,
      priorMaxPriorityFeePerGas: 2n,
      lineageId: `${FAKE_ACCOUNT.address.toLowerCase()}:0`,
    }));
  });

  it("submits only one payment when active-audit defense and armed JIT run in the same tick", async () => {
    const now = epochStart(11) + 100n;
    testState.lastEpochPaid = 9n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 11n * BASE_TAX_RATE_WEI;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 11 });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
  });

  it("uses the epoch captured by a delayed pre-boundary timer instead of recomputing an N+2 value", async () => {
    testState.lastEpochPaid = 4n;
    vi.setSystemTime(new Date(Number(epochStart(6) - 10n) * 1000));
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = 5n;
    runtime.startTime = START_TIME;
    runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n;

    schedulePreBoundaryPay();

    // Model another snapshot observing epoch 6 before the delayed callback runs.
    // The already-armed callback still belongs to the epoch-6 boundary.
    runtime.currentEpoch = 6n;
    await vi.advanceTimersByTimeAsync(7_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    const [intent, opts] = vi.mocked(submitTx).mock.calls[0]!;
    expect(intent.value).toBe(6n * BASE_TAX_RATE_WEI);
    expect(opts.simTimestamp).toBe(epochStart(6));
  });

  it("re-arms a capped long-delay pre-boundary timer instead of firing weeks early", async () => {
    testState.lastEpochPaid = 4n;
    vi.setSystemTime(new Date(Number(epochStart(5) + 100n) * 1000));
    runtime.running = true;
    runtime.gameState = 1;
    runtime.currentEpoch = 5n;
    runtime.startTime = START_TIME;
    runtime.citizensAddress = "0x00000000000000000000000000000000000000cc";
    runtime.balanceWei = 10_000_000_000_000_000_000n;
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 40 });

    schedulePreBoundaryPay();
    await vi.advanceTimersByTimeAsync(2_000_000_000);

    expect(submitTx).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("keeps a queued JIT payment armed and retryable when the mainnet bundle flush fails", async () => {
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 11n;
    testState.estimatedPayWei = 12n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: false, error: "no builder accepted" }]]);
    configure({ proactivePay: false, jitEnabled: true, jitTargetEpoch: 12 });

    await startAt(epochStart(12) + 100n);

    expect(flushBundle).toHaveBeenCalledTimes(1);
    expect(runtime.jitCampaign.state).toBe("armed");

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("retries a proactive payment after its queued mainnet bundle flush fails", async () => {
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 12n;
    testState.estimatedPayWei = 14n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: false, error: "no builder accepted" }]]);

    await startAt(epochStart(14) + 100n);
    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(flushBundle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
  });

  it("defers offense until the mainnet defense nonce confirms", async () => {
    const now = epochStart(15) + 100n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 13n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 15n * BASE_TAX_RATE_WEI;
    testState.submitQueued = true;
    testState.flushResults = new Map([
      [0, { ok: true }],
      [1, { ok: true }],
    ]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
    });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(beginBundle).toHaveBeenCalledTimes(1);
    expect(flushBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(flushBundle).mock.invocationCallOrder[0]!,
    );
  });

  it("defers offense when mandatory survival payment preparation is rejected", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 13n;
    testState.auditDueTimestamp = now + EPOCH_SECONDS;
    testState.estimatedPayWei = 2n * 15n * BASE_TAX_RATE_WEI;
    testState.submitOutcomes = [false];
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
    });

    await startAt(now);

    expect(vi.mocked(submitTx).mock.calls.map(([intent]) => intent.data)).toEqual(["0xPAYTAXES"]);
  });

  it("forces a public offense fallback while survival automation is active", async () => {
    const now = epochStart(15) + 100n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 15n; // owned Citizen is safe; no payment this tick
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: true }]]);
    testState.candidateIds = [99n];
    testState.liveTargets = [{
      id: 99n,
      owner: "0x9999999999999999999999999999999999999999",
    }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: "0x9999999999999999999999999999999999999999",
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: true,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      racePublicMempool: false,
    });

    await startAt(now);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].race).toBe(true);
  });

  it("never attacks a stale-negative candidate whose authoritative owner is this wallet", async () => {
    const now = epochStart(15) + 100n;
    testState.lastEpochPaid = 15n;
    testState.candidateIds = [99n];
    testState.liveTargets = [{ id: 99n, owner: FAKE_ACCOUNT.address }];
    testState.targetStatuses = [{
      tokenId: "99",
      owner: FAKE_ACCOUNT.address,
      lastEpochPaid: "1",
      delinquent: true,
      epochsBehind: 14,
      auditable: false,
      auditDueTimestamp: (now - 1n).toString(),
      killable: true,
    }];
    configure({
      enabled: false,
      proactivePay: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
    });

    await startAt(now);

    expect(submitTx).not.toHaveBeenCalled();
  });

  it("batches each pre-boundary kill deadline separately and re-arms the next cohort", async () => {
    const now = epochStart(15) + 100n;
    const firstDue = now + 10n;
    appConfig.mode = "mainnet";
    testState.lastEpochPaid = 15n;
    testState.submitQueued = true;
    testState.flushResults = new Map([[0, { ok: true }], [1, { ok: true }]]);
    testState.candidateIds = [99n, 100n];
    testState.liveTargets = [99n, 100n].map((id) => ({
      id,
      owner: "0x9999999999999999999999999999999999999999" as const,
    }));
    testState.targetStatuses = [
      {
        tokenId: "99",
        owner: "0x9999999999999999999999999999999999999999",
        lastEpochPaid: "1",
        delinquent: true,
        epochsBehind: 14,
        auditable: false,
        auditDueTimestamp: firstDue.toString(),
        killable: false,
      },
      {
        tokenId: "100",
        owner: "0x9999999999999999999999999999999999999999",
        lastEpochPaid: "1",
        delinquent: true,
        epochsBehind: 14,
        auditable: false,
        auditDueTimestamp: (firstDue + 1n).toString(),
        killable: false,
      },
    ];
    configure({
      enabled: false,
      offenseEnabled: true,
      autoAudit: false,
      autoKill: true,
      preBoundaryKill: true,
    });

    await startAt(now);
    expect(submitTx).not.toHaveBeenCalled();
    // Mainnet lead is 5s; the earliest deadline is 10s away.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submitTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitTx).mock.calls[0]![1].simTimestamp).toBe(firstDue + 1n);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitTx).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTx).mock.calls[1]![1].simTimestamp).toBe(firstDue + 2n);
  });
});
