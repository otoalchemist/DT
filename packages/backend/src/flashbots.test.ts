import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { parseEther, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const h = vi.hoisted(() => {
  const publicClient = {
    estimateGas: vi.fn(),
    getBalance: vi.fn(),
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
  return {
    appConfig: {
      mode: "mainnet" as "mainnet" | "public" | "local",
      dataDir: "/tmp/unused-flashbots-test" as string,
      flashbotsRelayUrl: "https://relay.test",
      builderUrls: ["https://relay.test", "https://builder.test"],
    },
    runtime: {
      account: null as ReturnType<typeof privateKeyToAccount> | null,
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
      maxBaseFeeGwei: 100,
      priorityFeeGwei: 2,
      replacementPriorityFeeCapGwei: 10,
      dynamicTipEnabled: false,
      dynamicTipMaxGwei: 50,
    }),
    effectiveTipGwei: () => 2,
  };
});
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_TXS,
  beginBundle,
  flushBundle,
  privateBundlePrefixLength,
  reconcileSubmissionJournal,
  RecoveryFloorError,
  recoverPreparedSubmissions,
  submitTx,
} = await import("./flashbots.js");
const { AtomicWriteCommittedError } = await import("./durability.js");

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000aa" as const;

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

beforeEach(() => {
  vi.clearAllMocks();
  h.appConfig.mode = "mainnet";
  h.appConfig.dataDir = "/tmp/unused-flashbots-test";
  h.appConfig.builderUrls = ["https://relay.test", "https://builder.test"];
  h.runtime.account = ACCOUNT;
  h.runtime.chainId = 1;
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
  h.journal.reconcile.mockImplementation((_wallet, confirmedNonce, pendingNonce, currentBlock) => ({
    confirmedNonce,
    pendingNonce,
    currentBlock,
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

  it("honors a stop during prior-bundle cancellation before starting new delivery", async () => {
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
    const events: string[] = [];
    h.journal.removeMany.mockImplementationOnce(() => { events.push("remove"); });
    h.nonceManager.releaseContiguous.mockImplementationOnce(() => {
      events.push("release");
      return true;
    });
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

    expect(result.get(fresh.nonce)?.ok).toBe(false);
    expect(events).toEqual(["remove", "release"]);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([8]);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url, init]) => rpcCall(url, init).method)).not.toContain("eth_sendBundle");
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

  it("writes one prepared and one post-delivery atomic journal barrier", async () => {
    await queue(5);
    await flushBundle();

    expect(h.journal.upsert).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).toHaveBeenCalledTimes(1);
    expect(h.journal.mutate).toHaveBeenCalledTimes(1);
    expect(h.journal.update).not.toHaveBeenCalled();
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

  it("releases the complete fresh sequence when every route explicitly rejects", async () => {
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
    expect([...result.values()].every((item) => !item.ok && !item.uncertain)).toBe(true);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        remove: expect.arrayContaining([...result.values()].map((item) => item.txHash)),
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

  it("fences a definitively rejected lower nonce when a higher nonce was accepted", async () => {
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
    expect(result.get(7)?.error).toContain("higher-nonce gap");
    expect(result.get(8)?.ok).toBe(true);
    expect(h.nonceManager.releaseContiguous).not.toHaveBeenCalled();
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "ambiguous",
      expect.objectContaining({ txHash: expect.any(String) }),
    );
  });

  it("releases a definitively rejected fresh top suffix", async () => {
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
    expect(result.get(8)?.ok).toBe(false);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([8]);
  });

  it("releases a fresh nonce-conflict rejection but forces a pending resync", async () => {
    fetchMock.mockImplementation((url, init) => {
      const call = rpcCall(url, init);
      if (call.method === "eth_callBundle") return Promise.resolve(response({ results: [{}] }));
      return Promise.resolve(rejected("bundle rejected"));
    });
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too high"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)?.ok).toBe(false);
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
    expect(h.nonceManager.reset).toHaveBeenCalledTimes(1);
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

  it("lets a nonce-too-high private flight expire instead of fencing the missing lower nonce forever", async () => {
    h.publicClient.sendRawTransaction.mockRejectedValue(new Error("nonce too high"));
    await queue(1);

    const result = await flushBundle();
    expect(result.get(7)).toMatchObject({ ok: true });
    expect(result.get(7)?.uncertain).toBeUndefined();
    expect(h.journal.mutate).toHaveBeenCalledWith(
      ACCOUNT.address,
      expect.objectContaining({
        updates: [expect.objectContaining({
          update: expect.objectContaining({ state: "accepted", nonceConflict: false }),
        })],
      }),
    );
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(
      7,
      "accepted",
      expect.objectContaining({ retainBeyondPrivateTarget: false }),
    );
  });

  it("sends nothing and releases safely when the prepared WAL barrier fails", async () => {
    h.journal.upsertMany.mockImplementation(() => { throw new Error("disk full"); });
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => !item.ok)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url, init]) => rpcCall(url, init).method)).toEqual(["eth_callBundle"]);
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

  it("releases a direct rejection whose terminal WAL removal visibly committed", async () => {
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

    expect(result).toMatchObject({ ok: false, uncertain: undefined });
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7]);
    expect(h.nonceManager.markDelivery).not.toHaveBeenCalled();
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

  it("fails a deterministic whole-prefix revert closed before any delivery", async () => {
    fetchMock.mockResolvedValue(response({ results: [{}, { revert: "second obligation failed" }] }));
    await queue(2);

    const result = await flushBundle();
    expect([...result.values()].every((item) => !item.ok)).toBe(true);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.upsertMany).not.toHaveBeenCalled();
    expect(h.nonceManager.releaseContiguous).toHaveBeenCalledWith([7, 8]);
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

  it("bounds public transport concurrency to 32 while preserving nonce-order chunks", async () => {
    h.appConfig.mode = "public";
    const gates: Array<() => void> = [];
    h.publicClient.sendRawTransaction.mockImplementation(() => new Promise<Hex>((resolve) => {
      gates.push(() => resolve(`0x${"44".repeat(32)}`));
    }));
    await queue(33);
    const flushing = flushBundle();
    await vi.waitFor(() => expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(32));
    for (const release of gates.splice(0)) release();
    await vi.waitFor(() => expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(33));
    for (const release of gates.splice(0)) release();
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

  it("returns a definitive failure for a rejected replacement while fencing the prior flight", async () => {
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
      ok: false,
      uncertain: undefined,
      txHash: prepared.txHash,
      lineageId: "payment:1",
    });
    expect(h.nonceManager.markDelivery).toHaveBeenCalledWith(7, "ambiguous", {
      txHash: priorHash,
      retainRejectedFence: true,
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
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.journal.updateMany).not.toHaveBeenCalled();
    expect(h.nonceManager.restoreFlight).not.toHaveBeenCalled();
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

  it("authorizes every current candidate before replay and retains semantic denials", async () => {
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
    h.publicClient.call.mockImplementation(async () => {
      expect(authorize).toHaveBeenCalledTimes(2);
      return { data: "0x" };
    });

    await recoverPreparedSubmissions(ACCOUNT.address, undefined, authorize);

    expect(authorize).toHaveBeenNthCalledWith(1, denied);
    expect(authorize).toHaveBeenNthCalledWith(2, allowed);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: allowed.rawSignedTx,
    });
    expect(denied.state).toBe("prepared");
    expect(h.journal.updateMany).toHaveBeenCalledWith(
      ACCOUNT.address,
      [expect.objectContaining({ txHash: allowed.txHash })],
    );
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
