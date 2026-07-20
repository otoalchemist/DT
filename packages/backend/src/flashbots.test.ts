import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { parseEther, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeCoinbasePayment } from "./coinbase-payer.js";

const h = vi.hoisted(() => {
  const publicClient = {
    estimateGas: vi.fn(),
    getBalance: vi.fn(),
    getBlock: vi.fn(),
    getBlockNumber: vi.fn(),
    getTransactionCount: vi.fn(),
    call: vi.fn(),
    request: vi.fn(),
    sendRawTransaction: vi.fn(),
  };
  const nonceManager = {
    peek: vi.fn(),
    reserve: vi.fn(),
    ensureNextAbove: vi.fn(),
    releaseContiguous: vi.fn(),
    reset: vi.fn(),
    markDelivery: vi.fn(),
    restoreFlight: vi.fn(),
    initializeFromJournal: vi.fn(),
    releaseJournalExpired: vi.fn(),
    setRecoveryHook: vi.fn(),
  };
  const journal = {
    upsert: vi.fn(),
    upsertMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    mutate: vi.fn(),
    remove: vi.fn(),
    removeMany: vi.fn(),
    reconcile: vi.fn(),
    load: vi.fn(),
    pathFor: vi.fn(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    appConfig: {
      mode: "mainnet" as "mainnet" | "public" | "local",
      dataDir: "/tmp/unused-flashbots-test" as string,
      flashbotsRelayUrl: "https://relay.test",
      builderUrls: ["https://relay.test", "https://builder.test"],
    },
    runtime: {
      account: null as ReturnType<typeof privateKeyToAccount> | null,
      unlocked: true,
      chainId: 1 as number | null,
      strategy: {
        maxBaseFeeGwei: 100,
        priorityFeeGwei: 2,
        replacementPriorityFeeCapGwei: 10,
        dynamicTipEnabled: false,
        dynamicTipMaxGwei: 50,
        separateOffenseGas: false,
        minBalanceEth: 0,
      },
      setJournalHealth: vi.fn(),
    },
    publicClient,
    nonceManager,
    journal,
    logger,
    getLatestBlockCached: vi.fn(),
    reputationKey: `0x${"22".repeat(32)}` as string,
    reputationKeyExists: true,
    writeFileAtomicDurableSync: vi.fn(),
  };
});

vi.mock("node:fs", () => {
  const fs = {
    existsSync: vi.fn(() => h.reputationKeyExists),
    readFileSync: vi.fn(() => h.reputationKey),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { default: fs, ...fs };
});
vi.mock("./durability.js", async () => {
  const actual = await vi.importActual<typeof import("./durability.js")>("./durability.js");
  return {
    ...actual,
    writeFileAtomicDurableSync: h.writeFileAtomicDurableSync,
  };
});
vi.mock("./submission-journal.js", async () => {
  class JournalCorruptionError extends Error {}
  return {
    JOURNAL_CONFIRMATION_DEPTH: 3n,
    JournalCorruptionError,
    SubmissionFlightJournal: class {
      upsert = h.journal.upsert;
      upsertMany = h.journal.upsertMany;
      update = h.journal.update;
      updateMany = h.journal.updateMany;
      mutate = h.journal.mutate;
      remove = h.journal.remove;
      removeMany = h.journal.removeMany;
      reconcile = h.journal.reconcile;
      load = h.journal.load;
      pathFor = h.journal.pathFor;
    },
  };
});
vi.mock("./chain.js", () => ({
  publicClient: h.publicClient,
  getLatestBlockCached: h.getLatestBlockCached,
}));
vi.mock("./config.js", () => ({ appConfig: h.appConfig }));
vi.mock("./runtime.js", () => ({ runtime: h.runtime }));
vi.mock("./nonce.js", () => ({ nonceManager: h.nonceManager }));
vi.mock("./logic.js", async () => {
  const actual = await vi.importActual<typeof import("./logic.js")>("./logic.js");
  return {
    ...actual,
    resolveGas: () => ({
      maxBaseFeeGwei: h.runtime.strategy.maxBaseFeeGwei,
      priorityFeeGwei: h.runtime.strategy.priorityFeeGwei,
      replacementPriorityFeeCapGwei: h.runtime.strategy.replacementPriorityFeeCapGwei,
      dynamicTipEnabled: h.runtime.strategy.dynamicTipEnabled,
      dynamicTipMaxGwei: h.runtime.strategy.dynamicTipMaxGwei,
    }),
    effectiveTipGwei: () => 2,
  };
});
vi.mock("./logger.js", () => ({
  logger: h.logger,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_TXS,
  beginBundle,
  discardBundle,
  flushBundle,
  privateBundlePrefixLength,
  reconcileSubmissionJournal,
  BuilderNonceRetirementError,
  RecoveryFloorError,
  recoverPreparedSubmissions,
  submitTx,
  UntrackedPendingPrefixError,
} = await import("./flashbots.js");
const { AtomicWriteCommittedError } = await import("./durability.js");

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000aa" as const;
const BUILDER_NOT_BEFORE_TIMESTAMP = 2_000n;
const BUILDER_VALID_THROUGH_BLOCK = 102n;
const BUILDER_CALL = encodeCoinbasePayment(
  BUILDER_NOT_BEFORE_TIMESTAMP,
  BUILDER_VALID_THROUGH_BLOCK,
);
const BLOCK_100_HASH = `0x${"64".repeat(32)}` as Hex;
const BLOCK_99_HASH = `0x${"63".repeat(32)}` as Hex;
const BLOCK_98_HASH = `0x${"62".repeat(32)}` as Hex;

type RpcCall = { url: string; method: string; params: any[]; signal?: AbortSignal };
function rpcCall(url: string | URL | Request, init?: RequestInit): RpcCall {
  const body = JSON.parse(String(init?.body));
  return { url: String(url), method: body.method, params: body.params, signal: init?.signal ?? undefined };
}
function response(result: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ result }) } as Response;
}
function rejected(message: string): Response {
  return { ok: true, status: 200, json: async () => ({ error: { message } }) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function queue(count: number, options: { race?: boolean; simTimestamp?: bigint } = {}) {
  beginBundle();
  const results = [];
  for (let index = 0; index < count; index++) {
    results.push(await submitTx(
      { to: TO, data: `0x${(index % 255).toString(16).padStart(2, "0")}`, value: 0n, gas: 50_000n },
      { dryRun: false, race: options.race ?? true, simTimestamp: options.simTimestamp },
    ));
  }
  return results;
}

async function recoveredFlight(
  publicAuthorized: boolean,
  notBeforeTimestamp?: bigint,
  options: {
    nonce?: number;
    valueWei?: bigint;
    gasLimit?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    data?: Hex;
    createdAtMs?: number;
    updatedAtMs?: number;
  } = {},
) {
  const nonce = options.nonce ?? 7;
  const valueWei = options.valueWei ?? 0n;
  const gasLimit = options.gasLimit ?? 50_000n;
  const maxFeePerGas = options.maxFeePerGas ?? 4_000_000_000n;
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? 2_000_000_000n;
  const data = options.data ?? "0x01";
  const rawSignedTx = await ACCOUNT.signTransaction({
    chainId: 1,
    type: "eip1559",
    nonce,
    to: TO,
    data,
    value: valueWei,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return {
    wallet: ACCOUNT.address,
    nonce,
    rawSignedTx,
    txHash: (await import("viem")).keccak256(rawSignedTx),
    obligation: {
      to: TO,
      data,
      valueWei: valueWei.toString(),
      gasLimit: gasLimit.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    },
    lineage: { id: `${ACCOUNT.address.toLowerCase()}:${nonce}` },
    recovery: {
      publicAuthorized,
      notBeforeTimestamp: notBeforeTimestamp?.toString(),
    },
    state: "prepared" as const,
    publicExposure: false,
    nonceConflict: false,
    attempts: [],
    maxPrivateTargetBlock: publicAuthorized ? undefined : "102",
    createdAtMs: options.createdAtMs ?? 1,
    updatedAtMs: options.updatedAtMs ?? 1,
  };
}

async function recoveredBuilderFlight(options: {
  nonce?: number;
  valueWei?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  notBeforeTimestamp?: bigint;
  validThroughBlock?: bigint;
  updatedAtMs?: number;
} = {}) {
  const notBeforeTimestamp = options.notBeforeTimestamp ?? BUILDER_NOT_BEFORE_TIMESTAMP;
  const validThroughBlock = options.validThroughBlock ?? BUILDER_VALID_THROUGH_BLOCK;
  const base = await recoveredFlight(false, undefined, {
    nonce: options.nonce,
    valueWei: options.valueWei ?? 15_000_000_000_000_000n,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    data: encodeCoinbasePayment(notBeforeTimestamp, validThroughBlock),
    updatedAtMs: options.updatedAtMs,
  });
  return {
    ...base,
    purpose: "builder-incentive" as const,
    privateCohort: { id: "boundary-retirement", role: "builder-incentive" as const },
    recovery: {
      publicAuthorized: false,
      notBeforeTimestamp: notBeforeTimestamp.toString(),
      validThroughBlock: validThroughBlock.toString(),
    },
    maxPrivateTargetBlock: validThroughBlock.toString(),
  };
}

async function recoveredRetirementFlight(
  builder: Awaited<ReturnType<typeof recoveredBuilderFlight>>,
  state: "prepared" | "accepted" | "ambiguous" = "prepared",
  updatedAtMs = 2,
) {
  const maxFeePerGas = 5_000_000_000n;
  const maxPriorityFeePerGas = 3_000_000_000n;
  const rawSignedTx = await ACCOUNT.signTransaction({
    chainId: 1,
    type: "eip1559",
    nonce: builder.nonce,
    to: ACCOUNT.address,
    data: "0x",
    value: 0n,
    gas: 21_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return {
    wallet: ACCOUNT.address,
    nonce: builder.nonce,
    rawSignedTx,
    txHash: (await import("viem")).keccak256(rawSignedTx),
    purpose: "nonce-retirement" as const,
    obligation: {
      to: ACCOUNT.address,
      data: "0x" as Hex,
      valueWei: "0",
      gasLimit: "21000",
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    },
    lineage: { id: builder.lineage.id, replacesTxHash: builder.txHash },
    recovery: { publicAuthorized: true },
    state,
    publicExposure: state !== "prepared",
    nonceConflict: false,
    attempts: state === "prepared" ? [] : [{
      channel: "public" as const,
      endpoint: "public-rpc",
      state,
    }],
    createdAtMs: 2,
    updatedAtMs,
  };
}

function mockReconciliation(
  retained: readonly any[],
  options: { confirmedNonce?: number; pendingNonce?: number; currentBlock?: bigint } = {},
) {
  h.journal.load.mockReturnValue([...retained]);
  h.journal.reconcile.mockReturnValue({
    confirmedNonce: options.confirmedNonce ?? 7,
    pendingNonce: options.pendingNonce ?? 7,
    currentBlock: options.currentBlock ?? 104n,
    retained: [...retained],
    consumed: [],
    expired: [],
  });
}

beforeEach(() => {
  // Reset implementations as well as call history. Several crash-window tests
  // install one-shot durability failures; an intentionally uncalled mock must
  // never leak that queued behavior into a shuffled successor.
  vi.resetAllMocks();
  h.appConfig.mode = "mainnet";
  h.appConfig.dataDir = "/tmp/unused-flashbots-test";
  h.appConfig.builderUrls = ["https://relay.test", "https://builder.test"];
  h.runtime.account = ACCOUNT;
  h.runtime.unlocked = true;
  h.runtime.chainId = 1;
  h.runtime.strategy.maxBaseFeeGwei = 100;
  h.runtime.strategy.priorityFeeGwei = 2;
  h.runtime.strategy.replacementPriorityFeeCapGwei = 10;
  h.runtime.strategy.dynamicTipEnabled = false;
  h.runtime.strategy.dynamicTipMaxGwei = 50;
  h.runtime.strategy.minBalanceEth = 0;
  h.reputationKey = `0x${"22".repeat(32)}`;
  h.reputationKeyExists = true;
  h.writeFileAtomicDurableSync.mockImplementation(() => undefined);
  h.getLatestBlockCached.mockResolvedValue({
    number: 100n,
    baseFeePerGas: 1_000_000_000n,
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
  });
  h.publicClient.getBlockNumber.mockResolvedValue(100n);
  h.publicClient.getBlock.mockImplementation(async ({ blockHash }: { blockHash?: Hex } = {}) => {
    if (blockHash === BLOCK_99_HASH) {
      return { number: 99n, hash: BLOCK_99_HASH, parentHash: BLOCK_98_HASH };
    }
    return { number: 100n, hash: BLOCK_100_HASH, parentHash: BLOCK_99_HASH };
  });
  h.publicClient.getBalance.mockResolvedValue(parseEther("100"));
  h.publicClient.getTransactionCount.mockResolvedValue(7);
  h.publicClient.call.mockResolvedValue({ data: "0x" });
  h.publicClient.request.mockResolvedValue("0x");
  h.publicClient.sendRawTransaction.mockResolvedValue(`0x${"33".repeat(32)}`);
  h.nonceManager.peek.mockReturnValue(7);
  let nonce = 7;
  h.nonceManager.reserve.mockImplementation(() => nonce++);
  h.nonceManager.releaseContiguous.mockReturnValue(true);
  h.journal.upsert.mockImplementation(() => undefined);
  h.journal.upsertMany.mockImplementation(() => undefined);
  h.journal.update.mockImplementation(() => undefined);
  h.journal.updateMany.mockImplementation(() => []);
  h.journal.mutate.mockImplementation(() => []);
  h.journal.remove.mockImplementation(() => undefined);
  h.journal.removeMany.mockImplementation(() => undefined);
  h.journal.load.mockReturnValue([]);
  h.journal.pathFor.mockReturnValue("/tmp/mock-journal.json");
  h.journal.reconcile.mockImplementation((_wallet, confirmedNonce, pendingNonce, blockEvidence) => ({
    confirmedNonce,
    pendingNonce,
    currentBlock: blockEvidence.number,
    retained: [],
    consumed: [],
    expired: [],
  }));
  fetchMock.mockImplementation((url, init) => {
    const call = rpcCall(url, init);
    if (call.method === "eth_callBundle") {
      return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
    }
    return Promise.resolve(response({ bundleHash: "0xbundle" }));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Flashbots reputation identity durability", () => {
  it("rejects non-exact loaded keys and uses a committed atomic creation without regenerating", async () => {
    h.appConfig.mode = "mainnet";
    h.appConfig.dataDir = "/tmp/flashbots-auth-test";
    h.reputationKey = `0x${"22".repeat(32)}\n`;

    await expect(submitTx(
      { to: TO, data: "0xa1", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    )).rejects.toThrow("invalid Flashbots reputation private key");
    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.writeFileAtomicDurableSync).not.toHaveBeenCalled();

    h.reputationKeyExists = false;
    h.writeFileAtomicDurableSync.mockImplementationOnce((keyPath: string) => {
      throw new AtomicWriteCommittedError(keyPath, {
        cause: new Error("simulated identity directory fsync failure"),
      });
    });

    const result = await submitTx(
      { to: TO, data: "0xa2", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    expect(result.ok).toBe(true);
    expect(h.writeFileAtomicDurableSync).toHaveBeenCalledTimes(1);
    const [keyPath, privateKey, mode] = h.writeFileAtomicDurableSync.mock.calls[0]!;
    expect(keyPath).toBe(join(h.appConfig.dataDir, "flashbots-signer.key"));
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mode).toBe(0o600);
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(
      false,
      expect.stringContaining("directory durability could not be confirmed"),
    );
  });
});

describe("prepared delivery campaigns", () => {
  it.each(["public", "local"] as const)("prepares every %s tx before one batch flush", async (mode) => {
    h.appConfig.mode = mode;
    const prepared = await queue(2);
    expect(prepared.every((result) => result.queued && result.txHash)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();

    const result = await flushBundle();
    expect(h.journal.upsertMany).toHaveBeenCalledTimes(1);
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(2);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect([...result.values()].every((item) => item.ok && !item.uncertain)).toBe(true);
  });

  it("writes payment baseline and one-shot identity under the prepared WAL barrier", async () => {
    h.appConfig.mode = "public";
    beginBundle();
    await submitTx(
      { to: TO, data: "0x01", value: 7n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        payment: {
          tokenId: "1",
          startingLastEpochPaid: "1",
          expectedLastEpochPaid: "2",
          source: "jit",
          epochs: "1",
          pricedEpoch: "20",
          jitTargetEpoch: 20,
          jitCampaignRevision: 7,
          proactiveEpoch: "20",
          proactiveMarkerReserved: true,
        },
      },
    );
    await flushBundle();

    expect(h.journal.upsertMany.mock.calls[0]![1][0]).toMatchObject({
      recovery: {
        payment: {
          tokenId: "1",
          startingLastEpochPaid: "1",
          expectedLastEpochPaid: "2",
          source: "jit",
          epochs: "1",
          pricedEpoch: "20",
          jitTargetEpoch: 20,
          jitCampaignRevision: 7,
          proactiveEpoch: "20",
          proactiveMarkerReserved: true,
        },
      },
    });
  });

  it("signs local-mode transactions for the validated local chain", async () => {
    h.appConfig.mode = "local";
    h.runtime.chainId = 31_337;
    await queue(1);
    await flushBundle();

    const [{ serializedTransaction }] = h.publicClient.sendRawTransaction.mock.calls[0]!;
    expect(parseTransaction(serializedTransaction).chainId).toBe(31_337);
  });

  it("keeps a prepared batch fenced when its WAL rename committed but directory fsync failed", async () => {
    await queue(2);
    h.journal.upsertMany.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/mock-journal.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });

    await expect(flushBundle()).rejects.toThrow(AtomicWriteCommittedError);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(
      false,
      expect.stringContaining("directory durability could not be confirmed"),
    );
  });

  it("keeps a direct prepared nonce fenced after a committed WAL durability failure", async () => {
    h.appConfig.mode = "public";
    h.journal.upsert.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/mock-journal.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });

    await expect(submitTx(
      { to: TO, data: "0x01", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    )).rejects.toThrow(AtomicWriteCommittedError);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
  });

  it("removes the prepared WAL before releasing when stopped immediately after its barrier", async () => {
    h.appConfig.mode = "public";
    const controller = new AbortController();
    beginBundle();
    const prepared = await submitTx(
      { to: TO, data: "0x03", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: controller.signal },
    );
    const events: string[] = [];
    h.journal.upsertMany.mockImplementationOnce(() => { controller.abort(); });
    h.journal.removeMany.mockImplementationOnce(() => { events.push("remove"); });
    h.nonceManager.releaseContiguous.mockImplementationOnce(() => {
      events.push("release");
      return true;
    });

    const result = await flushBundle();

    expect(result.get(prepared.nonce)).toMatchObject({
      ok: false,
      error: "bundle submission aborted before delivery",
    });
    expect(events).toEqual(["remove", "release"]);
    expect(h.journal.removeMany).toHaveBeenCalledWith(ACCOUNT.address, [prepared.txHash]);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("applies the same post-barrier stop ordering to a direct submission", async () => {
    h.appConfig.mode = "public";
    const controller = new AbortController();
    const events: string[] = [];
    h.journal.upsert.mockImplementationOnce(() => { controller.abort(); });
    h.journal.removeMany.mockImplementationOnce(() => { events.push("remove"); });
    h.nonceManager.releaseContiguous.mockImplementationOnce(() => {
      events.push("release");
      return true;
    });

    const result = await submitTx(
      { to: TO, data: "0x0a", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "transaction submission aborted before delivery",
    });
    expect(events).toEqual(["remove", "release"]);
    expect(h.journal.removeMany).toHaveBeenCalledWith(ACCOUNT.address, [result.txHash]);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("stops a direct replacement after prior-bundle cancellation and before dispatch", async () => {
    h.appConfig.mode = "mainnet";
    const controller = new AbortController();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}] }));
      }
      if (call.method === "eth_cancelBundle") {
        controller.abort();
        return Promise.resolve(response(true));
      }
      return Promise.resolve(response({ bundleHash: "0xshould-not-send" }));
    });

    const result = await submitTx(
      { to: TO, data: "0x0b", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        signal: controller.signal,
        replacement: {
          nonce: 7,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 1_000_000_000n,
          priorTxHash: `0x${"55".repeat(32)}`,
          lineageId: `${ACCOUNT.address.toLowerCase()}:7`,
          replacementUuid: "prior-direct-uuid",
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "transaction submission aborted before delivery",
    });
    expect(h.journal.removeMany).toHaveBeenCalledWith(ACCOUNT.address, [result.txHash]);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url, init]) => rpcCall(url, init).method)).not.toContain("eth_sendBundle");
  });

  it("keeps the nonce fenced when prepared-WAL removal fails before rename", async () => {
    h.appConfig.mode = "public";
    const controller = new AbortController();
    beginBundle();
    await submitTx(
      { to: TO, data: "0x04", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: controller.signal },
    );
    h.journal.upsertMany.mockImplementationOnce(() => { controller.abort(); });
    h.journal.removeMany.mockImplementationOnce(() => { throw new Error("removal disk full"); });

    await expect(flushBundle()).rejects.toThrow("removal disk full");

    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(
      false,
      expect.stringContaining("failed to remove submission journal flights"),
    );
  });

  it("releases after a visible prepared-WAL removal whose directory fsync is uncertain", async () => {
    h.appConfig.mode = "public";
    const controller = new AbortController();
    beginBundle();
    const prepared = await submitTx(
      { to: TO, data: "0x05", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: controller.signal },
    );
    h.journal.upsertMany.mockImplementationOnce(() => { controller.abort(); });
    h.journal.removeMany.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/mock-journal.json", {
        cause: new Error("removal directory fsync failed"),
      });
    });

    const result = await flushBundle();

    expect(result.get(prepared.nonce)?.ok).toBe(false);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([prepared.nonce]);
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("stops new delivery but retains raws disclosed before prior-bundle cancellation", async () => {
    h.appConfig.mode = "mainnet";
    const controller = new AbortController();
    beginBundle();
    await submitTx(
      { to: TO, data: "0x06", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        signal: controller.signal,
        replacement: {
          nonce: 7,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 1_000_000_000n,
          priorTxHash: `0x${"44".repeat(32)}`,
          lineageId: `${ACCOUNT.address.toLowerCase()}:7`,
          replacementUuid: "prior-target-uuid",
        },
      },
    );
    h.nonceManager.peek.mockReturnValue(8);
    h.nonceManager.reserve.mockReturnValueOnce(8);
    const fresh = await submitTx(
      { to: TO, data: "0x07", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, signal: controller.signal },
    );
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, {}] }));
      }
      if (call.method === "eth_cancelBundle") {
        controller.abort();
        return Promise.resolve(response(true));
      }
      return Promise.resolve(response({ bundleHash: "0xshould-not-send" }));
    });

    const result = await flushBundle();

    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(result.get(fresh.nonce)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url, init]) => rpcCall(url, init).method)).not.toContain("eth_sendBundle");
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({ remove: [] }),
    );
  });

  it("uses distinct Flashbots UUIDs for direct target-block submissions", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.resolve(response({ bundleHash: "0xdirect" }));
    });

    const result = await submitTx(
      { to: TO, data: "0x11", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const relaySends = calls.filter(
      (call) => call.method === "eth_sendBundle" && call.url === "https://relay.test",
    );
    expect(relaySends).toHaveLength(2);
    expect(new Set(relaySends.map((call) => call.params[0].replacementUuid)).size).toBe(2);
    expect(result.replacementUuids).toEqual(
      expect.arrayContaining(relaySends.map((call) => call.params[0].replacementUuid)),
    );
  });

  it("runs the final authorization gate before reserving or signing", async () => {
    h.appConfig.mode = "public";
    const stillValid = vi.fn(() => false);
    const authorize = vi.fn(async () => ({ ok: true, stillValid }));
    const result = await submitTx(
      { to: TO, data: "0x12", value: 7n, gas: 50_000n },
      { dryRun: false, race: true, authorize },
    );

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ valueWei: 7n }));
    expect(stillValid).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, error: "transaction authorization became stale" });
    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not reserve or sign when final authorization crosses the submission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    h.appConfig.mode = "public";
    const authorizationGate = deferred<boolean>();
    const authorize = vi.fn(() => authorizationGate.promise);
    const submitting = submitTx(
      { to: TO, data: "0x1212", value: 7n, gas: 50_000n },
      { dryRun: false, race: true, deadlineMs: 2_000, authorize },
    );
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());

    vi.setSystemTime(2_000);
    authorizationGate.resolve(true);
    const result = await submitting;

    expect(result).toMatchObject({
      ok: false,
      error: "transaction authorization missed its submission deadline",
    });
    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("releases a fresh reservation without queueing when signing crosses the submission deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    h.appConfig.mode = "public";
    const signingGate = deferred<Hex>();
    vi.spyOn(ACCOUNT, "signTransaction").mockImplementationOnce(() => signingGate.promise);
    beginBundle();
    const submitting = submitTx(
      { to: TO, data: "0x1213", value: 7n, gas: 50_000n },
      { dryRun: false, race: true, deadlineMs: 2_000 },
    );
    await vi.waitFor(() => expect(h.nonceManager.reserve).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await submitting;
    signingGate.resolve("0x01");

    expect(result).toMatchObject({
      ok: false,
      nonce: 7,
      error: "transaction signing missed its submission deadline",
    });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("writes one prepared and one post-delivery atomic journal barrier", async () => {
    await queue(5);
    await flushBundle();

    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).toHaveBeenCalledTimes(1);
    expect(h.journal.mutate).toHaveBeenCalledTimes(1);
    expect(h.journal.update).not.toHaveBeenCalled();
  });

  it("persists opaque redacted builder attempts and logs only accepted counts", async () => {
    const secretBuilder = "https://tenant-secret.builder.test/private-api-key";
    h.appConfig.builderUrls = [h.appConfig.flashbotsRelayUrl, secretBuilder];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      if (call.method === "eth_sendBundle" && call.url === secretBuilder) {
        return Promise.resolve(rejected(`upstream ${secretBuilder} refused the request`));
      }
      return Promise.resolve(response({ bundleHash: "0xaccepted" }));
    });

    const [queued] = await queue(1);
    const result = await flushBundle();

    const mutation = h.journal.mutate.mock.calls[0]![1];
    const attempts = mutation.updates[0].update.attempts as Array<{
      channel: "private" | "public";
      endpoint: string;
      error?: string;
    }>;
    const privateAttempts = attempts.filter((attempt) => attempt.channel === "private");
    expect(new Set(privateAttempts.map((attempt) => attempt.endpoint))).toEqual(new Set([
      "flashbots-relay",
      "configured-builder",
    ]));
    expect(JSON.stringify(privateAttempts)).not.toContain("tenant-secret");
    expect(JSON.stringify(privateAttempts)).not.toContain("private-api-key");
    expect(privateAttempts.filter((attempt) => attempt.error !== undefined).every(
      (attempt) => attempt.error?.includes("REDACTED") === true,
    )).toBe(true);
    const resultError = result.get(queued!.nonce)?.error ?? "";
    expect(resultError).toContain("REDACTED_RPC_ENDPOINT");
    expect(resultError).not.toContain("tenant-secret");
    expect(resultError).not.toContain("private-api-key");

    const acceptedLog = h.logger.info.mock.calls.find(([message]) =>
      String(message).includes("accepted by"),
    );
    expect(acceptedLog?.[0]).toContain("accepted by 1/2 builders");
    expect(String(acceptedLog?.[0])).not.toContain("relay.test");
    expect(String(acceptedLog?.[0])).not.toContain("tenant-secret");
  });

  it("persists public recovery policy and provisional private expiry before dispatch", async () => {
    await queue(1, { race: false });
    await flushBundle();

    const prepared = h.journal.upsertMany.mock.calls[0]![1][0];
    expect(prepared).toMatchObject({
      recovery: { publicAuthorized: false },
      maxPrivateTargetBlock: "102",
    });
  });

  it("rejects revert allowances without an explicit private cohort before preparation", async () => {
    await expect(submitTx(
      { to: TO, data: "0x13", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, revertible: true },
    )).rejects.toThrow("require an explicit private cohort");

    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps builder-incentive dry runs free of signing, reservation, WAL, and delivery", async () => {
    beginBundle();
    const result = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: true,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "dry-run-cohort", role: "builder-incentive" },
      },
    );

    expect(result).toMatchObject({ ok: true, simulated: true });
    expect(result.txHash).toBeUndefined();
    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("rejects public authorization for builder incentives", async () => {
    beginBundle();
    await expect(submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: true,
        race: true,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "public-bid", role: "builder-incentive" },
      },
    )).rejects.toThrow("cannot authorize public delivery");

    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("rejects missing, mismatched, or overbroad builder block authorization before signing", async () => {
    beginBundle();
    const base = {
      dryRun: false,
      race: false,
      revertible: true,
      purpose: "builder-incentive" as const,
      simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
      privateCohort: { id: "expiry-validation", role: "builder-incentive" as const },
    };

    await expect(submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      base,
    )).rejects.toThrow("require an on-chain block deadline");
    await expect(submitTx(
      { to: TO, data: encodeCoinbasePayment(BUILDER_NOT_BEFORE_TIMESTAMP, 101n), value: 1n, gas: 50_000n },
      { ...base, validThroughBlock: BUILDER_VALID_THROUGH_BLOCK },
    )).rejects.toThrow("calldata does not match");
    await expect(submitTx(
      { to: TO, data: encodeCoinbasePayment(BUILDER_NOT_BEFORE_TIMESTAMP, 103n), value: 1n, gas: 50_000n },
      { ...base, validThroughBlock: 103n },
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("exceeds the two-block private horizon"),
    });

    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("allows public audit fallback while keeping the builder incentive private-only", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, { revert: "audit already complete" }, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xcohort" }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x15", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        privateCohort: { id: "combined-1", role: "mandatory" },
      },
    );
    const audit = await submitTx(
      { to: TO, data: "0x16", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        revertible: true,
        privateCohort: { id: "combined-1", role: "allowed-revert" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "combined-1", role: "builder-incentive" },
      },
    );

    const result = await flushBundle();

    expect([...result.values()].every((entry) => entry.ok)).toBe(true);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(h.publicClient.sendRawTransaction.mock.calls.map(([arg]) =>
      parseTransaction(arg.serializedTransaction).nonce,
    )).toEqual([payment.nonce, audit.nonce]);
    const privateSends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(privateSends).toHaveLength(4);
    expect(privateSends.every((call) => call.params[0].txs.length === 3)).toBe(true);
    expect(privateSends.every((call) =>
      JSON.stringify(call.params[0].revertingTxHashes)
        === JSON.stringify([audit.txHash, incentive.txHash]),
    )).toBe(true);

    const prepared = h.journal.upsertMany.mock.calls[0]![1];
    expect(prepared.find((flight: any) => flight.nonce === audit.nonce)).toMatchObject({
      privateCohort: { id: "combined-1", role: "allowed-revert" },
      recovery: { publicAuthorized: true },
    });
    expect(prepared.find((flight: any) => flight.nonce === incentive.nonce)).toMatchObject({
      purpose: "builder-incentive",
      privateCohort: { id: "combined-1", role: "builder-incentive" },
      recovery: {
        publicAuthorized: false,
        notBeforeTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP.toString(),
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK.toString(),
      },
      maxPrivateTargetBlock: "102",
    });
    const signedIncentive = parseTransaction(
      privateSends[0]!.params[0].txs[2] as Hex,
    );
    expect(signedIncentive.data).toBe(BUILDER_CALL);
  });

  it("never extends a signed builder payment beyond its last authorized target block", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(response({ bundleHash: "0xbounded" }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1701", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        privateCohort: { id: "bounded-bid", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "bounded-bid", role: "builder-incentive" },
      },
    );
    // Preparation authorized blocks 101-102. By flush time 102 is the first
    // fresh target, so transport may submit exactly that block and no later one.
    h.publicClient.getBlockNumber.mockResolvedValueOnce(101n);

    const result = await flushBundle();

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(result.get(incentive.nonce)?.ok).toBe(true);
    const privateSends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(privateSends).toHaveLength(2);
    expect(privateSends.every((call) => call.params[0].blockNumber === "0x66")).toBe(true);
    expect(h.journal.upsertMany.mock.calls[0]![1].find(
      (flight: any) => flight.nonce === incentive.nonce,
    )).toMatchObject({
      recovery: {
        notBeforeTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP.toString(),
        validThroughBlock: "102",
      },
      maxPrivateTargetBlock: "102",
    });
  });

  it("drops a builder payment that is stale before the first fresh private target", async () => {
    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1702", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        privateCohort: { id: "stale-bid", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "stale-bid", role: "builder-incentive" },
      },
    );
    h.publicClient.getBlockNumber.mockResolvedValueOnce(102n);

    const result = await flushBundle();

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(result.get(incentive.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("expired before private target block 103"),
    });
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("drops an expired optional cohort suffix without suppressing the mandatory public fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(response({ bundleHash: "0xmandatory" }));
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1710", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        deadlineMs: 2_000,
        privateCohort: { id: "expired-cohort", role: "mandatory" },
      },
    );
    const audit = await submitTx(
      { to: TO, data: "0x1711", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        revertible: true,
        deadlineMs: 2_000,
        privateCohort: { id: "expired-cohort", role: "allowed-revert" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        deadlineMs: 2_000,
        privateCohort: { id: "expired-cohort", role: "builder-incentive" },
      },
    );
    vi.setSystemTime(2_000);

    const result = await flushBundle();

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(result.get(audit.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("deadline expired"),
    });
    expect(result.get(incentive.nonce)).toMatchObject({
      ok: false,
      error: expect.stringContaining("deadline expired"),
    });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([
      audit.nonce,
      incentive.nonce,
    ]);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(parseTransaction(
      h.publicClient.sendRawTransaction.mock.calls[0]![0].serializedTransaction,
    ).nonce).toBe(payment.nonce);
    const privateSends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(privateSends).toEqual([]);
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(1);
  });

  it("fails open from a mandatory-only target-block deadline to the public fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const targetBlockGate = deferred<bigint>();
    h.publicClient.getBlockNumber.mockImplementationOnce(() => targetBlockGate.promise);
    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1713", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        deadlineMs: 2_000,
        privateCohort: { id: "target-timeout", role: "mandatory" },
      },
    );

    const flushing = flushBundle();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await flushing;
    targetBlockGate.resolve(100n);

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(parseTransaction(
      h.publicClient.sendRawTransaction.mock.calls[0]![0].serializedTransaction,
    ).nonce).toBe(payment.nonce);
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(1);
    const transportMethods = fetchMock.mock.calls.map(([url, init]) => rpcCall(url, init).method);
    expect(transportMethods).not.toContain("eth_callBundle");
    expect(transportMethods).not.toContain("eth_sendBundle");
  });

  it("removes an optional suffix whose deadline crosses during the prepared-WAL barrier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(response({ bundleHash: "0xpost-wal" }));
    });
    h.journal.upsertMany.mockImplementationOnce(() => {
      vi.setSystemTime(2_000);
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1720", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        deadlineMs: 2_000,
        privateCohort: { id: "wal-deadline", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        deadlineMs: 2_000,
        privateCohort: { id: "wal-deadline", role: "builder-incentive" },
      },
    );

    const result = await flushBundle();

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(result.get(incentive.nonce)?.ok).toBe(false);
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(2);
    expect(h.journal.removeMany).toHaveBeenCalledWith(ACCOUNT.address, [incentive.txHash]);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "eth_sendBundle").every((call) => {
      const txs = call.params[0].txs as Hex[];
      return txs.length === 1 && parseTransaction(txs[0]!).nonce === payment.nonce;
    })).toBe(true);
  });

  it("keeps an expired optional nonce fenced without suppressing mandatory delivery when WAL cleanup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    h.journal.upsertMany.mockImplementationOnce(() => {
      vi.setSystemTime(2_000);
    });
    h.journal.removeMany.mockImplementationOnce(() => {
      throw new Error("cleanup disk unavailable");
    });

    beginBundle();
    const payment = await submitTx(
      { to: TO, data: "0x1730", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        deadlineMs: 2_000,
        privateCohort: { id: "wal-cleanup-failure", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        deadlineMs: 2_000,
        privateCohort: { id: "wal-cleanup-failure", role: "builder-incentive" },
      },
    );

    const result = await flushBundle();

    expect(result.get(payment.nonce)?.ok).toBe(true);
    expect(result.get(incentive.nonce)).toMatchObject({
      ok: false,
      retained: true,
      error: expect.stringContaining("nonce remains fenced"),
    });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(
      false,
      expect.stringContaining("failed to remove submission journal flights"),
    );
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(parseTransaction(
      h.publicClient.sendRawTransaction.mock.calls[0]![0].serializedTransaction,
    ).nonce).toBe(payment.nonce);
    const privateSends = fetchMock.mock.calls
      .map(([url, init]) => rpcCall(url, init))
      .filter((call) => call.method === "eth_sendBundle");
    expect(privateSends).toEqual([]);
  });

  it("retains every disclosed raw when one cohort member fails relay simulation", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, { revert: "payment failed" }, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xprefix" }));
    });

    beginBundle();
    const ordinary = await submitTx(
      { to: TO, data: "0x18", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const mandatory = await submitTx(
      { to: TO, data: "0x19", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        privateCohort: { id: "failed-cohort", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "failed-cohort", role: "builder-incentive" },
      },
    );

    const result = await flushBundle();

    expect(result.get(ordinary.nonce)).toMatchObject({ ok: true, uncertain: true });
    expect(result.get(mandatory.nonce)).toMatchObject({
      ok: true,
      uncertain: true,
      error: expect.stringContaining("payment failed"),
    });
    expect(result.get(incentive.nonce)).toMatchObject({
      ok: true,
      uncertain: true,
      error: expect.stringContaining("payment failed"),
    });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    const privateSends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(privateSends).toHaveLength(0);
  });

  it("excludes an entire cohort when private gas limits would split it", async () => {
    h.getLatestBlockCached.mockResolvedValue({
      number: 100n,
      baseFeePerGas: 1_000_000_000n,
      gasUsed: 50_000n,
      gasLimit: 100_000n,
    });
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(response({ bundleHash: "0xlimit" }));
    });

    beginBundle();
    const ordinary = await submitTx(
      { to: TO, data: "0x1b", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const mandatory = await submitTx(
      { to: TO, data: "0x1c", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        privateCohort: { id: "oversize-cohort", role: "mandatory" },
      },
    );
    const incentive = await submitTx(
      { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
      {
        dryRun: false,
        race: false,
        revertible: true,
        purpose: "builder-incentive",
        simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
        privateCohort: { id: "oversize-cohort", role: "builder-incentive" },
      },
    );

    const result = await flushBundle();

    expect(result.get(ordinary.nonce)?.ok).toBe(true);
    expect(result.get(mandatory.nonce)?.ok).toBe(true);
    expect(result.get(incentive.nonce)?.ok).toBe(false);
    expect(h.publicClient.sendRawTransaction.mock.calls.map(([arg]) =>
      parseTransaction(arg.serializedTransaction).nonce,
    )).toEqual([ordinary.nonce, mandatory.nonce]);
    const privateCalls = calls.filter((call) =>
      call.method === "eth_callBundle" || call.method === "eth_sendBundle",
    );
    expect(privateCalls).toHaveLength(5);
    expect(privateCalls.every((call) => {
      const txs = call.params[0].txs as Hex[];
      return txs.length === 1 && parseTransaction(txs[0]!).nonce === ordinary.nonce;
    })).toBe(true);
    expect(h.journal.upsertMany.mock.calls[0]![1].find(
      (flight: any) => flight.nonce === incentive.nonce,
    )).toMatchObject({
      purpose: "builder-incentive",
      recovery: {
        publicAuthorized: false,
        notBeforeTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP.toString(),
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK.toString(),
      },
      maxPrivateTargetBlock: "102",
    });
  });

  it("retains the complete sequence when every remote route reports rejection", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(rejected("bundle validation rejected"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("insufficient funds"));
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => item.ok && item.uncertain)).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        remove: [],
        updates: expect.arrayContaining([...result.values()].map((item) =>
          expect.objectContaining({ txHash: item.txHash }))),
      }),
    );
  });

  it("marks every flight ambiguous immediately when all attempted transports are ambiguous", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.reject(new Error("builder connection reset"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("public connection reset"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "ambiguous",
      expect.objectContaining({ publicExposure: true }),
    );
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("fences a remotely rejected lower nonce when a higher nonce was accepted", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(rejected("bundle rejected"));
    });
    h.publicClient.sendRawTransaction
      .mockRejectedValueOnce(new Error("insufficient funds"))
      .mockResolvedValueOnce(`0x${"66".repeat(32)}`);
    await queue(2);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(result.get(7)?.error).toContain("bundle rejected");
    expect(result.get(8)?.ok).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "ambiguous",
      expect.objectContaining({ txHash: expect.any(String) }),
    );
  });

  it("retains a remotely rejected fresh top suffix", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(rejected("bundle rejected"));
    });
    h.publicClient.sendRawTransaction
      .mockResolvedValueOnce(`0x${"66".repeat(32)}`)
      .mockRejectedValueOnce(new Error("insufficient funds"));
    await queue(2);

    const result = await flushBundle();
    expect(result.get(7)?.ok).toBe(true);
    expect(result.get(8)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("retains a fresh nonce-conflict response after public/private dispatch", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.resolve(rejected("bundle rejected"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too high"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.reset).not.toHaveBeenCalled();
  });

  it("keeps private acceptance ambiguous when public nonce conflict proves another lineage", async () => {
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("replacement transaction underpriced"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        updates: [expect.objectContaining({
          update: expect.objectContaining({ state: "ambiguous" }),
        })],
      }),
    );
  });

  it("retains a nonce-too-high dispatched raw despite finite relay target metadata", async () => {
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too high"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true });
    expect(result.get(7)?.uncertain).toBeUndefined();
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        updates: [expect.objectContaining({
          update: expect.objectContaining({
            state: "accepted",
            nonceConflict: true,
            publicExposure: true,
          }),
        })],
      }),
    );
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "accepted",
      expect.objectContaining({ retainBeyondPrivateTarget: true, publicExposure: true }),
    );
  });

  it("sends nothing and releases safely when the prepared WAL barrier fails", async () => {
    h.journal.upsertMany.mockImplementation(() => { throw new Error("disk full"); });
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => !item.ok)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
  });

  it("marks every delivered flight ambiguous and releases none when outcome WAL commit fails", async () => {
    h.journal.mutate.mockImplementation(() => { throw new Error("fsync failed"); });
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => item.ok && item.uncertain)).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledTimes(2);
    expect(h.nonceManager.markDelivery.mock.calls.every(([, state]) => state === "ambiguous")).toBe(true);
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
  });

  it("preserves accepted batch state when the outcome rename committed but directory fsync failed", async () => {
    h.appConfig.mode = "public";
    h.journal.mutate.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/mock-journal.json", {
        cause: new Error("outcome directory fsync failed"),
      });
    });
    await queue(1);

    const result = await flushBundle();

    expect(result.get(7)).toMatchObject({ ok: true });
    expect(result.get(7)?.uncertain).toBeUndefined();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "accepted",
      expect.any(Object),
    );
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
  });

  it("retains a direct raw after remote rejection and a committed outcome update", async () => {
    h.appConfig.mode = "public";
    h.publicClient.sendRawTransaction.mockRejectedValueOnce(new Error("insufficient funds"));
    h.journal.mutate.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/mock-journal.json", {
        cause: new Error("terminal removal directory fsync failed"),
      });
    });

    const result = await submitTx(
      { to: TO, data: "0x08", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    expect(result).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "ambiguous",
      expect.objectContaining({ publicExposure: true }),
    );
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
  });

  it("keeps a direct accepted nonce ambiguous when its outcome WAL write fails before rename", async () => {
    h.appConfig.mode = "public";
    h.journal.mutate.mockImplementationOnce(() => { throw new Error("outcome disk full"); });

    const result = await submitTx(
      { to: TO, data: "0x09", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    expect(result).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "ambiguous",
      expect.objectContaining({ publicExposure: true }),
    );
    expect(h.runtime.setJournalHealth).toHaveBeenCalledWith(false, expect.any(String));
  });

  it("keeps an unknown public timeout ambiguous", async () => {
    vi.useFakeTimers();
    h.appConfig.mode = "public";
    h.publicClient.sendRawTransaction.mockImplementation(() => new Promise<Hex>(() => {}));
    await queue(1);
    const flushing = flushBundle();
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await flushing;
    expect(result.get(7)).toMatchObject({ ok: true, uncertain: true });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("sends nothing when deterministic future-timestamp simulation fails", async () => {
    h.appConfig.mode = "public";
    h.publicClient.request.mockRejectedValue(Object.assign(new Error("execution reverted"), { data: "0x01" }));
    beginBundle();
    const result = await submitTx(
      { to: TO, data: "0x77", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 2_000n },
    );

    expect(result).toMatchObject({ ok: false, simulated: true });
    expect(result.error).toContain("sim revert");
    expect(h.nonceManager.reserve).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(await flushBundle()).toEqual(new Map());
  });

  it("retains the whole WAL-fenced batch when relay simulation reports a failure", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: [{}, { revert: "second obligation failed" }, {}] }));
      }
      return Promise.resolve(response({ bundleHash: "0xprefix" }));
    });
    await queue(3);

    const result = await flushBundle();
    expect([...result.values()].every((item) => item.ok && item.uncertain)).toBe(true);
    expect([...result.values()].every((item) =>
      item.error?.includes("second obligation failed"))).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.method === "eth_sendBundle")).toHaveLength(0);
    expect(h.journal.upsertMany).toHaveBeenCalledTimes(1);
    expect(h.journal.upsertMany.mock.calls[0]![1]).toHaveLength(3);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("retains the whole queue when the first post-WAL relay simulation result reverts", async () => {
    fetchMock.mockResolvedValue(response({ results: [{ revert: "first obligation failed" }, {}] }));
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => item.ok && item.uncertain)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).toHaveBeenCalledTimes(1);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("preserves public delivery when relay simulation times out", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") {
        return new Promise<Response>((_resolve, rejectPromise) => {
          call.signal?.addEventListener("abort", () => rejectPromise(new Error("relay timeout")), { once: true });
        });
      }
      throw new Error("private send must remain disabled");
    });
    await queue(2);
    const flushing = flushBundle();
    await vi.advanceTimersByTimeAsync(500);

    const result = await flushing;
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect([...result.values()].every((item) => item.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", null],
    ["absent", {}],
    ["short", { results: [{}, {}] }],
    ["malformed", { results: [{}, null, {}] }],
  ] as const)(
    "treats %s cohort simulation results as unavailable and exposes only authorized public fallbacks",
    async (_label, simulationResult) => {
      const calls: RpcCall[] = [];
      fetchMock.mockImplementation((url, init) => {
        const call = rpcCall(url, init);
        calls.push(call);
        if (call.method === "eth_callBundle") {
          return Promise.resolve(response(simulationResult));
        }
        throw new Error("malformed simulation must disable private delivery");
      });

      beginBundle();
      const payment = await submitTx(
        { to: TO, data: "0x7810", value: 0n, gas: 50_000n },
        {
          dryRun: false,
          race: true,
          privateCohort: { id: "malformed-sim", role: "mandatory" },
        },
      );
      const audit = await submitTx(
        { to: TO, data: "0x7811", value: 0n, gas: 50_000n },
        {
          dryRun: false,
          race: true,
          revertible: true,
          privateCohort: { id: "malformed-sim", role: "allowed-revert" },
        },
      );
      const incentive = await submitTx(
        { to: TO, data: BUILDER_CALL, value: 1n, gas: 50_000n },
        {
          dryRun: false,
          race: false,
          revertible: true,
          purpose: "builder-incentive",
          simTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP,
          validThroughBlock: BUILDER_VALID_THROUGH_BLOCK,
          privateCohort: { id: "malformed-sim", role: "builder-incentive" },
        },
      );

      const result = await flushBundle();

      expect(result.get(payment.nonce)?.ok).toBe(true);
      expect(result.get(audit.nonce)?.ok).toBe(true);
      expect(result.get(incentive.nonce)).toMatchObject({ ok: true, uncertain: true });
      expect(h.publicClient.sendRawTransaction.mock.calls.map(([arg]) =>
        parseTransaction(arg.serializedTransaction).nonce,
      )).toEqual([payment.nonce, audit.nonce]);
      expect(calls.filter((call) => call.method === "eth_callBundle")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "eth_sendBundle")).toHaveLength(0);
      expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    },
  );

  it("uses only local simulation before direct private delivery", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        throw new Error("signed raw must never be sent for direct relay simulation");
      }
      throw new Error("private delivery is conservatively ambiguous");
    });

    const result = await submitTx(
      { to: TO, data: "0x7820", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );

    expect(result.ok).toBe(true);
    expect(h.publicClient.call).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "eth_callBundle")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "eth_sendBundle")).toHaveLength(4);
  });

  it("submits a 100-tx private prefix and all 101 prepared payments publicly", async () => {
    h.appConfig.builderUrls = ["https://relay.test"];
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") {
        return Promise.resolve(response({ results: call.params[0].txs.map(() => ({})) }));
      }
      return Promise.resolve(response({ bundleHash: "0xlarge" }));
    });
    await queue(MAX_BUNDLE_TXS + 1);

    const result = await flushBundle();
    const simulation = calls.find((call) => call.method === "eth_callBundle")!;
    const sends = calls.filter((call) => call.method === "eth_sendBundle");
    expect(simulation.params[0].txs).toHaveLength(100);
    expect(sends).toHaveLength(2);
    expect(sends.every((call) => call.params[0].txs.length === 100)).toBe(true);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(101);
    expect(result).toHaveLength(101);
    expect(result.get(107)).toMatchObject({ ok: true, bundleHash: undefined });
  }, 20_000);

  it("refills a 32-send public pool as soon as any slot frees while preserving launch order", async () => {
    h.appConfig.mode = "public";
    const gates: Array<() => void> = [];
    h.publicClient.sendRawTransaction.mockImplementation(() => new Promise<Hex>((resolve) => {
      gates.push(() => resolve(`0x${"44".repeat(32)}`));
    }));
    await queue(33);
    const flushing = flushBundle();
    await vi.waitFor(() => expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(32));
    gates[0]!();
    await vi.waitFor(() => expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(33));
    for (const release of gates) release();
    await flushing;
    const nonces = h.publicClient.sendRawTransaction.mock.calls.map(([arg]) =>
      parseTransaction(arg.serializedTransaction).nonce,
    );
    expect(nonces).toEqual(Array.from({ length: 33 }, (_, index) => 7 + index));
  });

  it("cancels a prior Flashbots UUID and sends a fresh UUID only to Flashbots", async () => {
    const calls: RpcCall[] = [];
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      calls.push(call);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.resolve(response({ bundleHash: "0xreplacement" }));
    });
    beginBundle();
    const prepared = await submitTx(
      { to: TO, data: "0x99", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 7,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 2_000_000_000n,
          maxFeePerGasCap: 20_000_000_000n,
          maxPriorityFeePerGasCap: 10_000_000_000n,
          priorTxHash: `0x${"55".repeat(32)}`,
          lineageId: "payment:1",
          replacementUuid: "00000000-0000-4000-8000-000000000001",
        },
      },
    );
    const result = await flushBundle();

    expect(calls.find((call) => call.method === "eth_cancelBundle")?.params[0]).toEqual({
      replacementUuid: "00000000-0000-4000-8000-000000000001",
    });
    const relaySends = calls.filter((call) => call.method === "eth_sendBundle" && call.url === "https://relay.test");
    const otherSends = calls.filter((call) => call.method === "eth_sendBundle" && call.url === "https://builder.test");
    const freshUuids = result.get(7)?.replacementUuids;
    expect(freshUuids).toHaveLength(2);
    expect(new Set(freshUuids).size).toBe(2);
    expect(freshUuids).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(relaySends.map((call) => call.params[0].replacementUuid).sort()).toEqual(
      [...freshUuids!].sort(),
    );
    expect(otherSends.every((call) => !("replacementUuid" in call.params[0]))).toBe(true);
    expect(prepared.lineageId).toBe("payment:1");
    expect(result.get(7)?.lineageId).toBe("payment:1");
  });

  it("continues replacement delivery when prior UUID cancellation is ambiguous", async () => {
    const priorHash = `0x${"55".repeat(32)}` as Hex;
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      if (call.method === "eth_cancelBundle") return Promise.reject(new Error("cancel timeout"));
      return Promise.resolve(response({ bundleHash: "0xreplacement" }));
    });
    beginBundle();
    await submitTx(
      { to: TO, data: "0x98", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 7,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 2_000_000_000n,
          maxFeePerGasCap: 20_000_000_000n,
          maxPriorityFeePerGasCap: 10_000_000_000n,
          priorTxHash: priorHash,
          lineageId: "payment:1",
          replacementUuid: "00000000-0000-4000-8000-000000000001",
        },
      },
    );
    const result = await flushBundle();

    expect(result.get(7)).toMatchObject({ ok: true, lineageId: "payment:1" });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    const mutation = h.journal.mutate.mock.calls[0]?.[1];
    expect(mutation?.remove ?? []).not.toContain(priorHash);
  });

  it("retains a remotely rejected replacement as ambiguous alongside its prior flight", async () => {
    const priorHash = `0x${"55".repeat(32)}` as Hex;
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      if (call.method === "eth_cancelBundle") return Promise.resolve(response(true));
      return Promise.resolve(rejected("replacement rejected"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("replacement transaction underpriced"));
    beginBundle();
    const prepared = await submitTx(
      { to: TO, data: "0x97", value: 0n, gas: 50_000n },
      {
        dryRun: false,
        race: true,
        replacement: {
          nonce: 7,
          priorMaxFeePerGas: 3_000_000_000n,
          priorMaxPriorityFeePerGas: 2_000_000_000n,
          maxFeePerGasCap: 20_000_000_000n,
          maxPriorityFeePerGasCap: 10_000_000_000n,
          priorTxHash: priorHash,
          lineageId: "payment:1",
          replacementUuid: "00000000-0000-4000-8000-000000000001",
        },
      },
    );
    const result = await flushBundle();

    expect(result.get(7)).toMatchObject({
      ok: true,
      uncertain: true,
      txHash: prepared.txHash,
      lineageId: "payment:1",
    });
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(7, "ambiguous", {
      maxPrivateTargetBlock: 102n,
      txHash: prepared.txHash,
      publicExposure: true,
      retainBeyondPrivateTarget: true,
      retainRejectedFence: false,
    });
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("aborts the one shared future wait as a definite pre-dispatch rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.appConfig.mode = "public";
    const controller = new AbortController();
    beginBundle();
    await submitTx(
      { to: TO, data: "0xaa", value: 0n, gas: 50_000n },
      { dryRun: false, race: true, simTimestamp: 2_000n, signal: controller.signal },
    );
    const flushing = flushBundle();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await flushing;
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.get(7)?.ok).toBe(false);
    expect(result.get(7)?.uncertain).toBeUndefined();
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
  });
});

describe("durable prepared-flight recovery", () => {
  it("keeps read-only reconcile free of delivery side effects", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });

    const result = await reconcileSubmissionJournal(ACCOUNT.address);
    expect(result.retained).toHaveLength(1);
    expect(h.publicClient.getTransactionCount).toHaveBeenCalledWith({
      address: ACCOUNT.address,
      blockHash: BLOCK_100_HASH,
      requireCanonical: true,
    });
    expect(h.journal.reconcile).toHaveBeenCalledWith(
      ACCOUNT.address,
      7,
      7,
      {
        number: 100n,
        canonicalHashes: [BLOCK_100_HASH, BLOCK_99_HASH, BLOCK_98_HASH],
      },
    );
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
    expect(h.nonceManager.restoreFlight).not.toHaveBeenCalled();
  });

  it("cold-initializes canonical nonce state and retires a mature builder through the public path", async () => {
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);
    beginBundle(); // Live strategy ticks open an empty preparation window first.

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.nonceManager.initializeFromJournal).toHaveBeenCalledWith(
      ACCOUNT.address,
      7,
      7,
      [expect.objectContaining({ nonce: 7, retainBeyondPrivateTarget: true })],
    );
    expect(h.nonceManager.initializeFromJournal.mock.invocationCallOrder[0])
      .toBeLessThan(h.nonceManager.ensureNextAbove.mock.invocationCallOrder[0]!);
    expect(h.journal.upsert).toHaveBeenCalledWith(expect.objectContaining({
      nonce: 7,
      purpose: "nonce-retirement",
      recovery: expect.objectContaining({ publicAuthorized: true }),
      lineage: expect.objectContaining({ replacesTxHash: builder.txHash }),
    }));
    const serialized = h.publicClient.sendRawTransaction.mock.calls[0]![0].serializedTransaction;
    const parsed = parseTransaction(serialized);
    expect(parsed.nonce).toBe(7);
    expect(parsed.to?.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(parsed.value ?? 0n).toBe(0n);
    expect(parsed.data ?? "0x").toBe("0x");
    expect(h.journal.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(h.publicClient.sendRawTransaction.mock.invocationCallOrder[0]!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(discardBundle()).toEqual(new Map());
  });

  it("keeps a remotely rejected retirement ambiguous and WAL-fenced", async () => {
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);
    h.publicClient.sendRawTransaction.mockRejectedValueOnce(
      new Error("replacement transaction underpriced"),
    );

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        updates: [expect.objectContaining({
          update: expect.objectContaining({
            state: "ambiguous",
            publicExposure: true,
          }),
        })],
      }),
    );
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.journal.removeMany).not.toHaveBeenCalled();
  });

  it("waits until every same-nonce builder deadline is canonically final", async () => {
    const early = await recoveredBuilderFlight({ updatedAtMs: 1 });
    const later = await recoveredBuilderFlight({
      notBeforeTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP + 1n,
      validThroughBlock: 105n,
      updatedAtMs: 2,
    });
    mockReconciliation([early, later], { currentBlock: 104n });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();

    mockReconciliation([early, later], { currentBlock: 107n });
    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.journal.upsert).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects recovery before any mutation when a live batch is non-empty", async () => {
    beginBundle();
    await submitTx(
      { to: TO, data: "0x79", value: 0n, gas: 50_000n },
      { dryRun: false, race: true },
    );
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);

    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toThrow(
      "submission recovery cannot interleave a non-empty transaction batch",
    );

    expect(h.journal.reconcile).not.toHaveBeenCalled();
    expect(h.nonceManager.initializeFromJournal).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    discardBundle();
  });

  it("exact-replays a crash-window prepared retirement before considering another bump", async () => {
    const builder = await recoveredBuilderFlight();
    const retirement = await recoveredRetirementFlight(builder, "prepared");
    mockReconciliation([builder, retirement]);
    const genericStrategyAuthorizer = vi.fn(async () => false);

    await recoverPreparedSubmissions(
      ACCOUNT.address,
      undefined,
      genericStrategyAuthorizer,
    );

    expect(genericStrategyAuthorizer).not.toHaveBeenCalled();
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: retirement.rawSignedTx,
    });
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({
        txHash: retirement.txHash,
        update: expect.objectContaining({ state: "accepted", publicExposure: true }),
      })],
    );
  });

  it("rejects prepared retirement replay above the explicit replacement cap", async () => {
    const builder = await recoveredBuilderFlight();
    const retirement = await recoveredRetirementFlight(builder, "prepared");
    mockReconciliation([builder, retirement]);
    h.runtime.strategy.dynamicTipEnabled = true;
    h.runtime.strategy.dynamicTipMaxGwei = 50;
    h.runtime.strategy.replacementPriorityFeeCapGwei = 2;

    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toThrow(
      "prepared retirement fees exceed current general cleanup caps",
    );

    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("fee-bumps an aged ambiguous retirement while retaining every prior lineage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const builder = await recoveredBuilderFlight();
    const retirement = await recoveredRetirementFlight(builder, "ambiguous", 1);
    mockReconciliation([builder, retirement]);

    await recoverPreparedSubmissions(ACCOUNT.address);

    const prepared = h.journal.upsert.mock.calls[0]![0];
    expect(prepared).toMatchObject({
      nonce: builder.nonce,
      purpose: "nonce-retirement",
      lineage: { id: builder.lineage.id, replacesTxHash: retirement.txHash },
    });
    expect(BigInt(prepared.obligation.maxFeePerGas))
      .toBeGreaterThan(BigInt(retirement.obligation.maxFeePerGas));
    expect(BigInt(prepared.obligation.maxPriorityFeePerGas))
      .toBeGreaterThan(BigInt(retirement.obligation.maxPriorityFeePerGas));
    expect(h.journal.removeMany).not.toHaveBeenCalled();
  });

  it("fails closed at replacement caps or the spend floor without exposing a new raw", async () => {
    const capBuilder = await recoveredBuilderFlight({
      maxFeePerGas: 210_000_000_000n,
      maxPriorityFeePerGas: 10_000_000_000n,
    });
    mockReconciliation([capBuilder]);
    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toBeInstanceOf(
      BuilderNonceRetirementError,
    );
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();

    vi.clearAllMocks();
    h.runtime.account = ACCOUNT;
    const floorBuilder = await recoveredBuilderFlight({ valueWei: parseEther("100") });
    mockReconciliation([floorBuilder]);
    h.publicClient.getBalance.mockResolvedValue(1n);
    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toThrow(
      "cannot cover",
    );
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("removes only a pre-dispatch retirement WAL when Stop lands after its barrier", async () => {
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);
    const controller = new AbortController();
    h.journal.upsert.mockImplementationOnce(() => controller.abort());

    await expect(recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    )).rejects.toBeInstanceOf(BuilderNonceRetirementError);

    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.removeMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.any(String)],
    );
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("keeps retirement WAL exposure when Stop lands after public dispatch starts", async () => {
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);
    const controller = new AbortController();
    const send = deferred<Hex>();
    h.publicClient.sendRawTransaction.mockImplementationOnce(() => send.promise);

    const recovering = recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    ).catch((error) => error as Error);
    await vi.waitFor(() => expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1));
    controller.abort();
    send.reject(new Error("transport dropped after dispatch"));
    await recovering;

    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        updates: [expect.objectContaining({
          update: expect.objectContaining({ state: "ambiguous", publicExposure: true }),
        })],
      }),
    );
    expect(h.journal.removeMany).not.toHaveBeenCalled();
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("retains the old builder fence when retirement WAL preparation fails", async () => {
    const builder = await recoveredBuilderFlight();
    mockReconciliation([builder]);
    h.journal.upsert.mockImplementationOnce(() => {
      throw new Error("retirement WAL unavailable");
    });

    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toThrow(
      "retirement WAL unavailable",
    );
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.removeMany).not.toHaveBeenCalled();
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("blocks retirement above an untracked pending prefix", async () => {
    const builder = await recoveredBuilderFlight({ nonce: 8 });
    mockReconciliation([builder], { confirmedNonce: 7, pendingNonce: 8 });

    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toBeInstanceOf(
      UntrackedPendingPrefixError,
    );
    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("releases a nonce only after the canonical journal returns final expiry", async () => {
    const expired = {
      ...await recoveredFlight(false),
      // Only undisclosed prepared work with no viable route can expire safely.
      maxPrivateTargetBlock: undefined,
    };
    h.journal.load.mockReturnValue([expired]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 104n,
      retained: [],
      consumed: [],
      expired: [{ ...expired, state: "expired" }],
    });

    await reconcileSubmissionJournal(ACCOUNT.address);

    expect(h.nonceManager.releaseJournalExpired).toHaveBeenCalledWith([expired.nonce]);
  });

  it("does not release an expired alternative while the nonce has a retained lineage", async () => {
    const expired = await recoveredFlight(false);
    const retained = await recoveredFlight(true, undefined, { data: "0x02" });
    h.journal.load.mockReturnValue([expired, retained]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 104n,
      retained: [retained],
      consumed: [],
      expired: [{ ...expired, state: "expired" }],
    });

    await reconcileSubmissionJournal(ACCOUNT.address);

    expect(h.nonceManager.releaseJournalExpired).toHaveBeenCalledWith([]);
  });

  it("fails closed when the provider rejects the canonical hash-bound nonce read", async () => {
    h.publicClient.getTransactionCount.mockImplementation(async (args: {
      blockHash?: Hex;
      blockTag?: string;
    }) => {
      if (args.blockHash !== undefined) throw new Error("block is not canonical");
      return 7;
    });

    await expect(reconcileSubmissionJournal(ACCOUNT.address)).rejects.toThrow(
      "block is not canonical",
    );

    expect(h.journal.reconcile).not.toHaveBeenCalled();
  });

  it("fails closed when the provider returns an incoherent parent block", async () => {
    h.publicClient.getBlock.mockImplementation(async ({ blockHash }: { blockHash?: Hex } = {}) => {
      if (blockHash === BLOCK_99_HASH) {
        return { number: 98n, hash: BLOCK_99_HASH, parentHash: BLOCK_98_HASH };
      }
      return { number: 100n, hash: BLOCK_100_HASH, parentHash: BLOCK_99_HASH };
    });

    await expect(reconcileSubmissionJournal(ACCOUNT.address)).rejects.toThrow(
      "could not verify canonical block ancestry",
    );

    expect(h.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(h.journal.reconcile).not.toHaveBeenCalled();
  });

  it("re-simulates and replays an authorized prepared hash only at not-before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const flight = await recoveredFlight(true, 1_005n);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });

    const recovering = recoverPreparedSubmissions(ACCOUNT.address);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await recovering;

    expect(h.publicClient.call).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: flight.rawSignedTx,
    });
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({
        txHash: flight.txHash,
        update: expect.objectContaining({ state: "accepted", publicExposure: true }),
      })],
    );
  });

  it("cancels a future not-before recovery without broadcasting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const flight = await recoveredFlight(true, 1_060n);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    const controller = new AbortController();
    const recovering = recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    ).catch((error) => error as Error);

    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    const error = await recovering;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("aborted");
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });

  it("does not start journal reconciliation with already-revoked recovery authority", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    )).rejects.toThrow("recovery aborted");

    expect(h.journal.load).not.toHaveBeenCalled();
    expect(h.publicClient.getBlock).not.toHaveBeenCalled();
    expect(h.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("honors recovery cancellation while semantic authorization is in flight", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    const authorizationGate = deferred<void>();
    const authorize = vi.fn(async () => {
      await authorizationGate.promise;
      return true;
    });
    const controller = new AbortController();

    const recovery = recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
      authorize,
    ).catch((error) => error as Error);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await recovery;
    authorizationGate.resolve();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("recovery aborted");
    expect(h.publicClient.getBalance).not.toHaveBeenCalled();
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("honors recovery cancellation while the exact-balance check is in flight", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    const balanceGate = deferred<bigint>();
    h.publicClient.getBalance.mockImplementationOnce(() => balanceGate.promise);
    const controller = new AbortController();

    const recovery = recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    ).catch((error) => error as Error);
    await vi.waitFor(() => expect(h.publicClient.getBalance).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await recovery;
    balanceGate.resolve(parseEther("100"));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("recovery aborted");
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("honors recovery cancellation while semantic simulation is in flight", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    const simulationGate = deferred<{ data: Hex }>();
    h.publicClient.call.mockImplementationOnce(() => simulationGate.promise);
    const controller = new AbortController();

    const recovery = recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    ).catch((error) => error as Error);
    await vi.waitFor(() => expect(h.publicClient.call).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await recovery;
    simulationGate.resolve({ data: "0x" });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("recovery aborted");
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("never starts a higher recovery replay after cancellation during a lower send", async () => {
    const first = await recoveredFlight(true, undefined, { nonce: 7, data: "0x7310" });
    const second = await recoveredFlight(true, undefined, { nonce: 8, data: "0x7311" });
    const retained = [first, second];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });
    const controller = new AbortController();
    h.publicClient.sendRawTransaction.mockImplementationOnce(async () => {
      controller.abort();
      return `0x${"44".repeat(32)}` as Hex;
    });

    const error = await recoverPreparedSubmissions(
      ACCOUNT.address,
      controller.signal,
    ).catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("recovery aborted");
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: first.rawSignedTx,
    });
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({ txHash: first.txHash })],
    );
  });

  it("never public-replays a private-only prepared offense", async () => {
    const flight = await recoveredFlight(false);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });

    await recoverPreparedSubmissions(ACCOUNT.address);
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });

  it("never public-replays a builder incentive even if recovery policy is tampered", async () => {
    const flight = {
      ...await recoveredFlight(true, undefined, {
        data: BUILDER_CALL,
        valueWei: 1n,
      }),
      purpose: "builder-incentive" as const,
      privateCohort: { id: "tampered-builder", role: "builder-incentive" as const },
      recovery: {
        publicAuthorized: true,
        notBeforeTimestamp: BUILDER_NOT_BEFORE_TIMESTAMP.toString(),
        validThroughBlock: BUILDER_VALID_THROUGH_BLOCK.toString(),
      },
      maxPrivateTargetBlock: BUILDER_VALID_THROUGH_BLOCK.toString(),
    };
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.getBalance).not.toHaveBeenCalled();
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });

  it("never replays a tip-included flight while confirmation is provisional", async () => {
    const flight = {
      ...await recoveredFlight(true),
      observedConsumedAtBlock: "100",
    };
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 8,
      pendingNonce: 8,
      currentBlock: 100n,
      retained: [flight],
      provisional: [flight],
      consumed: [],
      expired: [],
    });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.getBalance).not.toHaveBeenCalled();
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });

  it("authorizes every current candidate before replay and treats a denial as a nonce barrier", async () => {
    const denied = await recoveredFlight(true, undefined, { nonce: 7, data: "0x71" });
    const allowed = await recoveredFlight(true, undefined, { nonce: 8, data: "0x72" });
    const retained = [denied, allowed];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });
    const authorize = vi.fn(async (flight: { nonce: number }) => flight.nonce === 8);

    await recoverPreparedSubmissions(ACCOUNT.address, undefined, authorize);

    expect(authorize).toHaveBeenNthCalledWith(1, denied);
    expect(authorize).toHaveBeenNthCalledWith(2, allowed);
    expect(h.publicClient.getBalance).not.toHaveBeenCalled();
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(denied.state).toBe("prepared");
    expect(allowed.state).toBe("prepared");
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });

  it("does not recover across a nonce missing from the pending frontier", async () => {
    const first = await recoveredFlight(true, undefined, { nonce: 7, data: "0x75" });
    const aboveGap = await recoveredFlight(true, undefined, { nonce: 9, data: "0x79" });
    const retained = [first, aboveGap];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.call).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: first.rawSignedTx,
    });
    expect(first.state).toBe("accepted");
    expect(aboveGap.state).toBe("prepared");
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({ txHash: first.txHash })],
    );
  });

  it("blocks recovery above a pending nonce absent from durable journal state", async () => {
    const flight = await recoveredFlight(true, undefined, { nonce: 8, data: "0x78" });
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 8,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });

    await expect(recoverPreparedSubmissions(ACCOUNT.address)).rejects.toBeInstanceOf(
      UntrackedPendingPrefixError,
    );

    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("extends a pending prefix only when every lower nonce is durably represented", async () => {
    const knownPending = {
      ...await recoveredFlight(true, undefined, { nonce: 7, data: "0x77" }),
      state: "accepted" as const,
      publicExposure: true,
    };
    const extension = await recoveredFlight(true, undefined, { nonce: 8, data: "0x78" });
    const retained = [knownPending, extension];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 8,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: extension.rawSignedTx,
    });
  });

  it("replays only the contiguous simulated prefix before a failed nonce", async () => {
    const first = await recoveredFlight(true, undefined, { nonce: 7, data: "0x81" });
    const failed = await recoveredFlight(true, undefined, { nonce: 8, data: "0x82" });
    const higher = await recoveredFlight(true, undefined, { nonce: 9, data: "0x83" });
    const retained = [first, failed, higher];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });
    h.publicClient.call.mockImplementation(async (request: { data: Hex }) => {
      if (request.data === failed.obligation.data) {
        throw new Error("obligation no longer valid");
      }
      return { data: "0x" };
    });
    h.publicClient.sendRawTransaction.mockImplementation(async () => {
      // Read-only authorization and simulation finish before any prefix entry is
      // exposed, even though a later simulation result is unusable.
      expect(h.publicClient.call).toHaveBeenCalledTimes(3);
      return `0x${"33".repeat(32)}`;
    });

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: first.rawSignedTx,
    });
    expect(first.state).toBe("accepted");
    expect(failed.state).toBe("prepared");
    expect(higher.state).toBe("prepared");
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({ txHash: first.txHash })],
    );
  });

  it("stops the recovery prefix when a lower public delivery is not accepted", async () => {
    const failed = await recoveredFlight(true, undefined, { nonce: 7, data: "0x91" });
    const higher = await recoveredFlight(true, undefined, { nonce: 8, data: "0x92" });
    const retained = [failed, higher];
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });
    h.publicClient.sendRawTransaction.mockRejectedValueOnce(new Error("nonce too high"));

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.call).toHaveBeenCalledTimes(2);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: failed.rawSignedTx,
    });
    expect(failed.state).toBe("ambiguous");
    expect(failed.publicExposure).toBe(true);
    expect(higher.state).toBe("prepared");
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({ txHash: failed.txHash })],
    );
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("durably and monotonically records same-nonce conflict during recovery", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    h.publicClient.sendRawTransaction.mockRejectedValueOnce(
      new Error("replacement transaction underpriced"),
    );

    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(flight).toMatchObject({
      state: "ambiguous",
      publicExposure: true,
      nonceConflict: true,
    });
    expect(h.journal.updateMany).toHaveBeenCalledWith(ACCOUNT.address, [
      expect.objectContaining({
        txHash: flight.txHash,
        update: expect.objectContaining({ nonceConflict: true }),
      }),
    ]);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
  });

  it("fails recovery authorization errors before balance, simulation, or replay", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    const authorize = vi.fn(async () => { throw new Error("ownership RPC unavailable"); });

    await expect(recoverPreparedSubmissions(
      ACCOUNT.address,
      undefined,
      authorize,
    )).rejects.toThrow("submission recovery authorization failed closed");

    expect(h.publicClient.getBalance).not.toHaveBeenCalled();
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
    expect(flight.state).toBe("prepared");
  });

  it("blocks cumulative post-crash exposure below the current floor and retains it for retry", async () => {
    const prior = await recoveredFlight(true, undefined, {
      nonce: 7,
      valueWei: parseEther("2"),
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      updatedAtMs: 1,
    });
    const replacement = await recoveredFlight(true, undefined, {
      nonce: 7,
      valueWei: parseEther("3"),
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      updatedAtMs: 2,
    });
    const nextNonce = await recoveredFlight(true, undefined, {
      nonce: 8,
      valueWei: parseEther("4"),
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      updatedAtMs: 3,
    });
    const retained = [prior, replacement, nextNonce];
    const exposure = (flight: typeof prior) => BigInt(flight.obligation.valueWei)
      + BigInt(flight.obligation.gasLimit) * BigInt(flight.obligation.maxFeePerGas);
    // Same-nonce replacements reserve only their maximum, while nonce 8 is an
    // independent liability and must be added cumulatively.
    const maximumExposureWei = exposure(replacement) + exposure(nextNonce);
    const floorWei = parseEther("1");
    h.runtime.strategy.minBalanceEth = 1;
    h.journal.load.mockReturnValue(retained);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained,
      consumed: [],
      expired: [],
    });

    // Model an external withdrawal after the WAL was written, together with a
    // now-higher configured floor. Each nonce alone fits, but the two do not.
    h.publicClient.getBalance.mockResolvedValue(maximumExposureWei + floorWei - 1n);
    const blocked = await recoverPreparedSubmissions(ACCOUNT.address).catch((error) => error);

    expect(blocked).toBeInstanceOf(RecoveryFloorError);
    expect(blocked).toMatchObject({
      wallet: ACCOUNT.address,
      blockNumber: 100n,
      balanceWei: maximumExposureWei + floorWei - 1n,
      maximumExposureWei,
      floorWei,
    });
    expect(h.publicClient.getBalance).toHaveBeenCalledWith({
      address: ACCOUNT.address,
      blockNumber: 100n,
    });
    expect(h.publicClient.call).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
    expect(h.journal.remove).not.toHaveBeenCalled();
    expect(h.journal.removeMany).not.toHaveBeenCalled();
    expect(retained.every((flight) => flight.state === "prepared")).toBe(true);

    // Funding exactly the floor plus the deduplicated maximum is sufficient on
    // a later recovery pass. Replay only the newest alternative at nonce 7.
    h.publicClient.getBalance.mockResolvedValue(maximumExposureWei + floorWei);
    await recoverPreparedSubmissions(ACCOUNT.address);

    expect(h.publicClient.call).toHaveBeenCalledTimes(2);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    const replayed = h.publicClient.sendRawTransaction.mock.calls.map(
      ([request]) => request.serializedTransaction,
    );
    expect(replayed).toEqual(expect.arrayContaining([
      replacement.rawSignedTx,
      nextNonce.rawSignedTx,
    ]));
    expect(replayed).not.toContain(prior.rawSignedTx);
    const updates = h.journal.updateMany.mock.calls[0]![1];
    expect(updates).toHaveLength(2);
    expect(updates.map((update: { txHash: Hex }) => update.txHash)).toEqual(expect.arrayContaining([
      replacement.txHash,
      nextNonce.txHash,
    ]));
  });

  it("fails prepared replay closed when semantic re-simulation fails", async () => {
    const flight = await recoveredFlight(true);
    h.journal.load.mockReturnValue([flight]);
    h.journal.reconcile.mockReturnValue({
      confirmedNonce: 7,
      pendingNonce: 7,
      currentBlock: 100n,
      retained: [flight],
      consumed: [],
      expired: [],
    });
    h.publicClient.call.mockRejectedValue(new Error("obligation no longer valid"));

    await recoverPreparedSubmissions(ACCOUNT.address);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
  });
});

describe("private bundle limit model", () => {
  it("enforces the 300000-byte boundary exactly", () => {
    const one = `0x${"aa".repeat(150_000)}` as Hex;
    const two = `0x${"bb".repeat(150_000)}` as Hex;
    const overflow = "0xcc" as Hex;
    expect(privateBundlePrefixLength([
      { signed: one, gas: 1n },
      { signed: two, gas: 1n },
    ], 10n)).toBe(2);
    expect(privateBundlePrefixLength([
      { signed: one, gas: 1n },
      { signed: two, gas: 1n },
      { signed: overflow, gas: 1n },
    ], 10n)).toBe(2);
    expect(MAX_BUNDLE_BYTES).toBe(300_000);
  });

  it("never returns a prefix violating count, byte, or aggregate-gas limits", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        bytes: fc.integer({ min: 0, max: 10_000 }),
        gas: fc.integer({ min: 0, max: 100_000 }),
      }), { maxLength: 130 }),
      fc.integer({ min: 0, max: 3_000_000 }),
      (items, gasLimit) => {
        const transactions = items.map(({ bytes, gas }) => ({
          signed: `0x${"aa".repeat(bytes)}` as Hex,
          gas: BigInt(gas),
        }));
        const count = privateBundlePrefixLength(transactions, BigInt(gasLimit));
        const prefix = transactions.slice(0, count);
        expect(count).toBeLessThanOrEqual(MAX_BUNDLE_TXS);
        expect(prefix.reduce((sum, tx) => sum + (tx.signed.length - 2) / 2, 0)).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
        expect(prefix.reduce((sum, tx) => sum + tx.gas, 0n)).toBeLessThanOrEqual(BigInt(gasLimit));
      },
    ), { numRuns: 50 });
  });
});
