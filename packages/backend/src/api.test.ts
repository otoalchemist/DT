import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StrategyConfig } from "@dat-bot/shared";

const h = vi.hoisted(() => {
  class RevisionConflictError extends Error {
    constructor(public currentRevision: number) {
      super(`Revision conflict; current revision is ${currentRevision}`);
    }
  }
  const strategy = {
    defenseEnabled: false,
    offenseEnabled: false,
    dryRun: true,
    combinedBoundaryBundle: false,
    coinbaseBidEnabled: false,
    coinbaseBidEth: "0",
    coinbasePayerAddress: "",
  };
  const campaign = {
    revision: 0,
    state: "cancelled",
    targetEpoch: null,
    tokenIds: [] as string[],
    autoStopOnCompletion: false,
  };
  const runtime = {
    strategy,
    strategyRevision: 0,
    jitCampaign: campaign,
    unlocked: true,
    running: false,
    journalHealthy: true,
    account: null as { address: `0x${string}` } | null,
    walletClient: null as unknown,
    chainId: null as number | null,
    currentEpoch: 9n as bigint | null,
    startTime: 0n as bigint | null,
    gameState: 1 as number | null,
    citizenSupply: 100n as bigint | null,
    citizensAddress: "0x00000000000000000000000000000000000000cc" as `0x${string}` | null,
    balanceWei: null as bigint | null,
    strategySnapshot: vi.fn(() => ({ revision: runtime.strategyRevision, config: runtime.strategy })),
    saveStrategy: vi.fn((patch: Record<string, unknown>, expected: number) => {
      if (expected !== runtime.strategyRevision) throw new RevisionConflictError(runtime.strategyRevision);
      runtime.strategy = { ...runtime.strategy, ...patch } as typeof strategy;
      runtime.strategyRevision += 1;
      return { revision: runtime.strategyRevision, config: runtime.strategy };
    }),
    saveJitCampaign: vi.fn((patch: Record<string, unknown>, expected: number) => {
      if (expected !== runtime.jitCampaign.revision) throw new RevisionConflictError(runtime.jitCampaign.revision);
      runtime.jitCampaign = {
        ...runtime.jitCampaign,
        ...patch,
        revision: runtime.jitCampaign.revision + 1,
      } as typeof campaign;
      return runtime.jitCampaign;
    }),
    emitStatus: vi.fn(),
    status: vi.fn(() => ({
      mode: appConfig.mode,
      running: runtime.running,
      jitRevision: runtime.jitCampaign.revision,
      jitEnabled: runtime.jitCampaign.state === "armed",
      jitTargetEpoch: runtime.jitCampaign.targetEpoch,
      jitTokenIds: runtime.jitCampaign.tokenIds,
      journalHealthy: runtime.journalHealthy,
    })),
    lock: vi.fn(() => { runtime.unlocked = false; runtime.account = null; }),
    onStatus: vi.fn(() => () => {}),
  };
  const appConfig = {
    host: "127.0.0.1",
    mode: "mainnet" as "mainnet" | "public" | "local",
    dataDir: "/tmp/dat-api-test",
    httpUrl: "https://old.test",
    wsUrl: "wss://old.test" as string | undefined,
    nftUrl: "https://old-nft.test" as string | undefined,
    ownedTokensOverride: [] as bigint[],
    endpointOverrides: { http: false, ws: false, nft: false },
    modeConfiguredByEnvironment: false,
    keyConfiguredByEnvironment: false,
    gameAddress: "0x0000000000000000000000000000000000000001" as const,
  };
  return {
    RevisionConflictError,
    runtime,
    strategy,
    campaign,
    appConfig,
    startEngine: vi.fn(() => { runtime.running = true; }),
    stopEngine: vi.fn(() => { runtime.running = false; }),
    waitForEngineIdle: vi.fn(async () => {}),
    scheduleJitBoundary: vi.fn(),
    schedulePreBoundaryPay: vi.fn(),
    schedulePreBoundaryAudit: vi.fn(),
    resetJitState: vi.fn(),
    preflightSubmissionRecovery: vi.fn(async () => {}),
    recoverAuthorizedSubmissions: vi.fn(async (
      _address: `0x${string}`,
      _signal?: AbortSignal,
    ) => {}),
    hasUnresolvedJitCampaignWork: vi.fn(() => false),
    saveSettings: vi.fn(),
    validateRpc: vi.fn(async () => {}),
    reinitClients: vi.fn(),
    publicClient: { getBalance: vi.fn(async () => 0n) },
    loadKeystore: vi.fn((): Record<string, unknown> | null => null),
    keystoreExists: vi.fn(() => false),
    saveKeystore: vi.fn(),
    decryptPrivateKey: vi.fn(() => `0x${"11".repeat(32)}` as `0x${string}`),
    accountFromPrivateKey: vi.fn(() => ({ address: "0x2222222222222222222222222222222222222222" as const })),
    getChainId: vi.fn(async () => 1),
    resolveBuilderIncentive: vi.fn(async (): Promise<
      | { active: true; payer: `0x${string}`; bidWei: bigint; runtimeCodeHash: `0x${string}` }
      | { active: false; reason: string }
    > => ({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: 10_000_000_000_000_000n,
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    })),
    resolveBuilderIncentiveForMode: vi.fn(async (
      _config: unknown,
      _chainId: number | null,
      _mode: "mainnet" | "public" | "local",
      _client: unknown,
    ): Promise<
      | { active: true; payer: `0x${string}`; bidWei: bigint; runtimeCodeHash: `0x${string}` }
      | { active: false; reason: string }
    > => ({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: 10_000_000_000_000_000n,
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    })),
    readOwnedStatuses: vi.fn(async () => [{ tokenId: "7" }, { tokenId: "8" }]),
    filterOwnedTokenIds: vi.fn(async (
      _citizens: unknown,
      tokenIds: bigint[],
    ): Promise<bigint[]> => tokenIds.filter((tokenId) => tokenId === 7n || tokenId === 8n)),
  };
});

vi.mock("./config.js", () => ({
  appConfig: h.appConfig,
  API_LOOPBACK_HOSTS: ["127.0.0.1", "localhost", "::1"],
  loadSettings: vi.fn(() => ({})),
  saveSettings: h.saveSettings,
  deriveUrlsFromKey: vi.fn(() => ({ httpUrl: "https://new.test", wsUrl: "wss://new.test", nftUrl: "https://new-nft.test" })),
  validateMainnetRpcCandidate: h.validateRpc,
}));
vi.mock("./runtime.js", () => ({
  runtime: h.runtime,
  RevisionConflictError: h.RevisionConflictError,
  strategyConfigSchema: z.record(z.unknown()),
  strategyPatchSchema: z.record(z.unknown()),
}));
vi.mock("./builder-incentive.js", () => ({
  resolveBuilderIncentive: h.resolveBuilderIncentive,
  resolveBuilderIncentiveForMode: h.resolveBuilderIncentiveForMode,
}));
vi.mock("./strategy.js", () => ({
  startEngine: h.startEngine,
  stopEngine: h.stopEngine,
  waitForEngineIdle: h.waitForEngineIdle,
  scheduleJitBoundary: h.scheduleJitBoundary,
  schedulePreBoundaryPay: h.schedulePreBoundaryPay,
  schedulePreBoundaryAudit: h.schedulePreBoundaryAudit,
  resetJitState: h.resetJitState,
  preflightSubmissionRecovery: h.preflightSubmissionRecovery,
  recoverAuthorizedSubmissions: h.recoverAuthorizedSubmissions,
  hasUnresolvedJitCampaignWork: h.hasUnresolvedJitCampaignWork,
}));
vi.mock("./chain.js", () => ({
  publicClient: h.publicClient,
  reinitClients: h.reinitClients,
  accountFromPrivateKey: h.accountFromPrivateKey,
  makeWalletClient: vi.fn(),
  getChainId: h.getChainId,
}));
vi.mock("./activity.js", () => ({ activity: { recent: vi.fn(() => []), subscribe: vi.fn(() => () => {}) } }));
vi.mock("./keystore.js", () => ({
  encryptPrivateKey: vi.fn(() => ({ encrypted: true })),
  decryptPrivateKey: h.decryptPrivateKey,
  saveKeystore: h.saveKeystore,
  loadKeystore: h.loadKeystore,
  keystoreExists: h.keystoreExists,
  normalizePrivateKey: vi.fn(),
}));
vi.mock("./contract.js", () => ({
  getGameSnapshot: vi.fn(async () => ({
    state: 1,
    currentEpoch: 10n,
    startTime: 0n,
    citizensAddress: "0x00000000000000000000000000000000000000cc",
    citizenSupply: 100n,
  })),
}));
vi.mock("./service.js", () => ({ readOwnedStatuses: h.readOwnedStatuses, readTargets: vi.fn(async () => []) }));
vi.mock("./index-tokens.js", () => ({ filterOwnedTokenIds: h.filterOwnedTokenIds }));
vi.mock("./postmortem.js", () => ({ runPostMortem: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { buildServer, builderIncentiveRiskIncreases } = await import("./api.js");
const { AtomicWriteCommittedError } = await import("./durability.js");

describe("revisioned API lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.strategy, {
      defenseEnabled: false,
      offenseEnabled: false,
      dryRun: true,
      combinedBoundaryBundle: false,
      coinbaseBidEnabled: false,
      coinbaseBidEth: "0",
      coinbasePayerAddress: "",
    });
    h.runtime.strategy = h.strategy;
    h.runtime.strategyRevision = 0;
    Object.assign(h.campaign, {
      revision: 0,
      state: "cancelled",
      targetEpoch: null,
      tokenIds: [],
      autoStopOnCompletion: false,
    });
    h.runtime.jitCampaign = h.campaign;
    h.runtime.unlocked = true;
    h.runtime.running = false;
    h.runtime.journalHealthy = true;
    h.runtime.chainId = null;
    h.runtime.currentEpoch = 9n;
    h.runtime.account = { address: "0x2222222222222222222222222222222222222222" as const };
    h.appConfig.host = "127.0.0.1";
    h.appConfig.mode = "mainnet";
    h.appConfig.httpUrl = "https://old.test";
    h.appConfig.wsUrl = "wss://old.test";
    h.appConfig.nftUrl = "https://old-nft.test";
    h.appConfig.ownedTokensOverride = [];
    h.appConfig.endpointOverrides = { http: false, ws: false, nft: false };
    h.appConfig.modeConfiguredByEnvironment = false;
    h.appConfig.keyConfiguredByEnvironment = false;
    h.loadKeystore.mockReturnValue(null);
    h.keystoreExists.mockReturnValue(false);
    h.waitForEngineIdle.mockResolvedValue(undefined);
    h.preflightSubmissionRecovery.mockResolvedValue(undefined);
    h.recoverAuthorizedSubmissions.mockResolvedValue(undefined);
    h.hasUnresolvedJitCampaignWork.mockReturnValue(false);
    h.validateRpc.mockResolvedValue(undefined);
    h.getChainId.mockResolvedValue(1);
    h.resolveBuilderIncentive.mockResolvedValue({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: 10_000_000_000_000_000n,
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    });
    h.resolveBuilderIncentiveForMode.mockResolvedValue({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: 10_000_000_000_000_000n,
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    });
    h.filterOwnedTokenIds.mockImplementation(async (_citizens: unknown, tokenIds: bigint[]) =>
      tokenIds.filter((tokenId) => tokenId === 7n || tokenId === 8n));
  });

  it("recovers durable submission state before starting the engine", async () => {
    const account = { address: "0x2222222222222222222222222222222222222222" as const };
    h.runtime.account = account;
    const app = await buildServer();
    const response = await app.inject({ method: "POST", url: "/api/start", headers: { host: "localhost" } });

    expect(response.statusCode).toBe(200);
    expect(h.recoverAuthorizedSubmissions).toHaveBeenCalledWith(
      account.address,
      expect.any(AbortSignal),
    );
    expect(h.recoverAuthorizedSubmissions.mock.invocationCallOrder[0]).toBeLessThan(
      h.startEngine.mock.invocationCallOrder[0]!,
    );
    await app.close();
  });

  it("revokes an in-flight Start recovery when Stop arrives", async () => {
    const account = { address: "0x2222222222222222222222222222222222222222" as const };
    h.runtime.account = account;
    let observedSignal: AbortSignal | undefined;
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    h.recoverAuthorizedSubmissions.mockImplementationOnce(async (_address, signal) => {
      observedSignal = signal;
      markRecoveryStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("recovery aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new Error("recovery aborted")),
          { once: true },
        );
      });
    });
    const app = await buildServer();
    const startResponse = app.inject({
      method: "POST",
      url: "/api/start",
      headers: { host: "localhost" },
    });

    await recoveryStarted;
    const stopResponse = app.inject({
      method: "POST",
      url: "/api/stop",
      headers: { host: "localhost" },
    });

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    const [start, stop] = await Promise.all([startResponse, stopResponse]);
    expect(start.statusCode).toBe(503);
    expect(start.json().error).toContain("recovery aborted");
    expect(stop.statusCode).toBe(200);
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("keeps a running engine paused when a config rename commits without durability confirmation", async () => {
    h.runtime.running = true;
    h.runtime.saveStrategy.mockImplementationOnce((patch: Record<string, unknown>) => {
      h.runtime.strategy = { ...h.runtime.strategy, ...patch } as typeof h.strategy;
      h.runtime.strategyRevision += 1;
      throw new AtomicWriteCommittedError("/tmp/config.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: { expectedRevision: 0, patch: { defenseEnabled: true } },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ revision: 1, config: { defenseEnabled: true } });
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("keeps the engine paused when submission recovery fails", async () => {
    h.runtime.account = { address: "0x2222222222222222222222222222222222222222" as const };
    h.recoverAuthorizedSubmissions.mockRejectedValueOnce(new Error("journal checksum mismatch"));
    const app = await buildServer();
    const response = await app.inject({ method: "POST", url: "/api/start", headers: { host: "localhost" } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("journal checksum mismatch") });
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("waits for an auto-stopped old tick to unwind before recovery", async () => {
    let releaseIdle!: () => void;
    h.waitForEngineIdle.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseIdle = resolve;
    }));
    const app = await buildServer();
    const pending = app.inject({ method: "POST", url: "/api/start", headers: { host: "localhost" } });

    await vi.waitFor(() => expect(h.waitForEngineIdle).toHaveBeenCalledOnce());
    expect(h.recoverAuthorizedSubmissions).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();

    releaseIdle();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(h.recoverAuthorizedSubmissions).toHaveBeenCalledOnce();
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rebuilds submission state on unlock while leaving the engine paused", async () => {
    h.loadKeystore.mockReturnValue({ encrypted: true });
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(200);
    expect(h.preflightSubmissionRecovery).toHaveBeenCalledWith(
      "0x2222222222222222222222222222222222222222",
    );
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("reports unlock recovery failure as unavailable instead of bad credentials", async () => {
    h.loadKeystore.mockReturnValue({ encrypted: true });
    h.preflightSubmissionRecovery.mockRejectedValueOnce(new Error("corrupt journal JSON"));
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("corrupt journal JSON"),
      status: { running: false },
    });
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails unlock closed when the RPC chain ID cannot be verified", async () => {
    h.runtime.account = null;
    h.loadKeystore.mockReturnValue({ encrypted: true });
    h.getChainId.mockRejectedValueOnce(new Error("RPC unavailable"));
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("Could not verify RPC chain ID") });
    expect(h.runtime.account).toBeNull();
    expect(h.preflightSubmissionRecovery).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a non-mainnet RPC identity outside local mode", async () => {
    h.runtime.account = null;
    h.loadKeystore.mockReturnValue({ encrypted: true });
    h.getChainId.mockResolvedValueOnce(5);
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("requires Ethereum mainnet") });
    expect(h.runtime.account).toBeNull();
    expect(h.preflightSubmissionRecovery).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts the reported development chain identity in local mode", async () => {
    h.runtime.account = null;
    h.appConfig.mode = "local";
    h.loadKeystore.mockReturnValue({ encrypted: true });
    h.getChainId.mockResolvedValueOnce(31_337);
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.chainId).toBe(31_337);
    expect(h.preflightSubmissionRecovery).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses Ethereum mainnet identity in local direct-broadcast mode", async () => {
    h.runtime.account = null;
    h.appConfig.mode = "local";
    h.loadKeystore.mockReturnValue({ encrypted: true });
    h.getChainId.mockResolvedValueOnce(1);
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/unlock", headers: { host: "localhost" },
      payload: { passphrase: "correct horse" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("local mode refuses Ethereum mainnet");
    expect(h.runtime.account).toBeNull();
    expect(h.preflightSubmissionRecovery).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports a local explicit-RPC/owned-token setup as onboarding-ready", async () => {
    h.appConfig.mode = "local";
    h.appConfig.httpUrl = "http://127.0.0.1:8545";
    h.appConfig.nftUrl = undefined;
    h.appConfig.ownedTokensOverride = [7n];
    h.appConfig.modeConfiguredByEnvironment = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "GET", url: "/api/settings", headers: { host: "localhost" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rpcConfigured: true,
      ownershipConfigured: true,
      setupReady: true,
      mode: "local",
      modeConfiguredByEnvironment: true,
    });
    await app.close();
  });

  it("rejects cross-origin browser mutations on the loopback API", async () => {
    const app = await buildServer();
    const foreignOrigin = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "localhost", origin: "https://evil.example" },
    });
    const crossSite = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "localhost", "sec-fetch-site": "cross-site" },
    });

    expect(foreignOrigin.statusCode).toBe(403);
    expect(crossSite.statusCode).toBe(403);
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.preflightSubmissionRecovery).not.toHaveBeenCalled();
    expect(h.recoverAuthorizedSubmissions).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows local-dashboard origins as well as origin-less CLI requests", async () => {
    h.runtime.account = { address: "0x2222222222222222222222222222222222222222" as const };
    const app = await buildServer();
    const dashboard = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "localhost", origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" },
    });
    h.runtime.running = false;
    const cli = await app.inject({ method: "POST", url: "/api/start", headers: { host: "localhost" } });

    expect(dashboard.statusCode).toBe(200);
    expect(cli.statusCode).toBe(200);
    expect(h.startEngine).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects non-loopback Host and Origin headers", async () => {
    h.runtime.account = { address: "0x2222222222222222222222222222222222222222" as const };
    const app = await buildServer();
    const lanHost = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "192.168.1.20:8787" },
    });
    const lanOrigin = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "localhost", origin: "http://192.168.1.20:5173" },
    });
    const rebound = await app.inject({
      method: "POST", url: "/api/start",
      headers: { host: "attacker.example", origin: "https://attacker.example" },
    });

    expect(lanHost.statusCode).toBe(403);
    expect(lanOrigin.statusCode).toBe(403);
    expect(rebound.statusCode).toBe(403);
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("applies only a field-scoped strategy patch and does not auto-start a paused engine", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "PATCH", url: "/api/config", headers: { host: "localhost" },
      payload: { expectedRevision: 0, patch: { defenseEnabled: true } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revision: 1, config: { defenseEnabled: true, dryRun: true } });
    expect(h.runtime.saveStrategy).toHaveBeenCalledWith({ defenseEnabled: true }, 0);
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.runtime.saveJitCampaign).not.toHaveBeenCalled();
    expect(h.runtime.jitCampaign.state).toBe("cancelled");
    await app.close();
  });

  it("classifies every direct builder-incentive risk increase", () => {
    const current = {
      ...h.strategy,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    } as unknown as StrategyConfig;

    expect(builderIncentiveRiskIncreases(
      { ...current, coinbaseBidEnabled: false },
      current,
    )).toBe(true);
    expect(builderIncentiveRiskIncreases(
      current,
      { ...current, coinbaseBidEth: "0.02" },
    )).toBe(true);
    expect(builderIncentiveRiskIncreases(
      current,
      { ...current, coinbasePayerAddress: "0x4444444444444444444444444444444444444444" },
    )).toBe(true);
    expect(builderIncentiveRiskIncreases(
      current,
      { ...current, combinedBoundaryBundle: true },
    )).toBe(true);
    expect(builderIncentiveRiskIncreases(
      current,
      { ...current, coinbaseBidEth: "0.005" },
    )).toBe(false);
    expect(builderIncentiveRiskIncreases(
      current,
      { ...current, coinbaseBidEnabled: false, combinedBoundaryBundle: true },
    )).toBe(false);
  });

  it("requires explicit acknowledgement before enabling a builder incentive", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: {
        expectedRevision: 0,
        patch: {
          coinbaseBidEnabled: true,
          coinbaseBidEth: "0.01",
          coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("explicit acknowledgement");
    expect(h.resolveBuilderIncentive).not.toHaveBeenCalled();
    expect(h.runtime.saveStrategy).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates the deployed payer bytecode before persisting an acknowledged bid", async () => {
    const app = await buildServer();
    const patch = {
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
      combinedBoundaryBundle: true,
    };
    const response = await app.inject({
      method: "PATCH",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: { expectedRevision: 0, patch, acknowledgeCoinbaseBidRisk: true },
    });

    expect(response.statusCode).toBe(200);
    expect(h.resolveBuilderIncentive).toHaveBeenCalledWith(
      expect.objectContaining(patch),
      1,
    );
    expect(h.resolveBuilderIncentive.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.saveStrategy.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.saveStrategy).toHaveBeenCalledWith(patch, 0);
    await app.close();
  });

  it("rejects an acknowledged bid when the payer capability is inactive", async () => {
    h.resolveBuilderIncentive.mockResolvedValueOnce({
      active: false,
      reason: "CoinbasePayer runtime bytecode hash does not match the pinned artifact",
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/config",
      headers: { host: "localhost" },
      payload: {
        expectedRevision: 0,
        acknowledgeCoinbaseBidRisk: true,
        patch: {
          coinbaseBidEnabled: true,
          coinbaseBidEth: "0.01",
          coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("bytecode hash");
    expect(h.runtime.saveStrategy).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports only backend-verified builder-incentive capability as active", async () => {
    Object.assign(h.strategy, {
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
      combinedBoundaryBundle: false,
    });
    const app = await buildServer();
    const notCombined = await app.inject({
      method: "GET",
      url: "/api/builder-incentive",
      headers: { host: "localhost" },
    });
    expect(notCombined.json()).toEqual({
      active: false,
      reason: "Combined boundary bundles are disabled",
    });
    expect(h.resolveBuilderIncentive).not.toHaveBeenCalled();

    h.strategy.combinedBoundaryBundle = true;
    const active = await app.inject({
      method: "GET",
      url: "/api/builder-incentive",
      headers: { host: "localhost" },
    });

    expect(active.statusCode).toBe(200);
    expect(active.json()).toEqual({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: "10000000000000000",
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    });

    h.runtime.journalHealthy = false;
    const unhealthy = await app.inject({
      method: "GET",
      url: "/api/builder-incentive",
      headers: { host: "localhost" },
    });
    expect(unhealthy.json()).toEqual({
      active: false,
      reason: "Submission journal is unhealthy",
    });
    expect(h.resolveBuilderIncentive).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects a stale strategy write with 409 before stopping the engine", async () => {
    h.runtime.strategyRevision = 3;
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/config", headers: { host: "localhost" },
      payload: { expectedRevision: 2, patch: { dryRun: false } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ currentRevision: 3 });
    expect(h.stopEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves the running state while waiting for a live strategy save", async () => {
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "PATCH", url: "/api/config", headers: { host: "localhost" },
      payload: { expectedRevision: 0, patch: { dryRun: false } },
    });
    expect(response.statusCode).toBe(200);
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.waitForEngineIdle).toHaveBeenCalledOnce();
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("arms an explicit owned-token campaign without enabling defense", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["007"] },
    });
    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "armed",
        targetEpoch: 11,
        tokenIds: ["7"],
        autoStopOnCompletion: true,
      }),
      0,
    );
    expect(h.runtime.strategy.defenseEnabled).toBe(false);
    expect(response.json()).toMatchObject({ jitEnabled: true, jitTargetEpoch: 11, jitTokenIds: ["7"] });
    expect(h.filterOwnedTokenIds).toHaveBeenCalledWith(
      "0x00000000000000000000000000000000000000cc",
      [7n],
      "0x2222222222222222222222222222222222222222",
    );
    expect(h.readOwnedStatuses).not.toHaveBeenCalled();
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not claim auto-stop ownership when arming from an operator-run engine", async () => {
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["7"] },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ autoStopOnCompletion: false }),
      0,
    );
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("freezes a running engine before asynchronous JIT ownership validation", async () => {
    let release!: (tokenIds: bigint[]) => void;
    h.runtime.running = true;
    h.filterOwnedTokenIds.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const app = await buildServer();
    const pending = app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["7"] },
    });

    await vi.waitFor(() => expect(h.filterOwnedTokenIds).toHaveBeenCalledOnce());
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.runtime.running).toBe(false);
    expect(h.startEngine).not.toHaveBeenCalled();

    release([7n]);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("preserves auto-stop ownership when re-arming its running campaign", async () => {
    Object.assign(h.runtime.jitCampaign, {
      state: "armed",
      targetEpoch: 11,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    });
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["7"] },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ autoStopOnCompletion: true }),
      0,
    );
    expect(h.recoverAuthorizedSubmissions).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not persist or start a paused JIT campaign when recovery fails", async () => {
    h.recoverAuthorizedSubmissions.mockRejectedValueOnce(new Error("prepared WAL is corrupt"));
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["7"] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("prepared WAL is corrupt") });
    expect(h.runtime.saveJitCampaign).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("leaves the engine stopped when an auto-started campaign has no cancellation cleanup", async () => {
    Object.assign(h.runtime.jitCampaign, {
      state: "armed",
      targetEpoch: 10,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    });
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "cancelled",
        targetEpoch: null,
        tokenIds: [],
        autoStopOnCompletion: false,
      }),
      0,
    );
    expect(h.hasUnresolvedJitCampaignWork).toHaveBeenCalledWith(expect.objectContaining({
      targetEpoch: 10,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    }));
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("persists and restarts unresolved cleanup for a campaign-owned engine", async () => {
    Object.assign(h.runtime.jitCampaign, {
      state: "armed",
      targetEpoch: 10,
      tokenIds: ["7"],
      autoStopOnCompletion: true,
    });
    h.runtime.running = true;
    h.hasUnresolvedJitCampaignWork.mockReturnValueOnce(true);
    const app = await buildServer();

    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "cancelled",
        targetEpoch: 10,
        tokenIds: ["7"],
        autoStopOnCompletion: true,
        completedAt: undefined,
        message: expect.stringContaining("cleanup in progress"),
      }),
      0,
    );
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).toHaveBeenCalledOnce();
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("restarts unresolved cancellation without taking ownership from an operator-run engine", async () => {
    Object.assign(h.runtime.jitCampaign, {
      state: "armed",
      targetEpoch: 10,
      tokenIds: ["7"],
      autoStopOnCompletion: false,
    });
    h.runtime.running = true;
    h.hasUnresolvedJitCampaignWork.mockReturnValueOnce(true);
    const app = await buildServer();

    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "cancelled",
        targetEpoch: 10,
        tokenIds: ["7"],
        autoStopOnCompletion: false,
      }),
      0,
    );
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).toHaveBeenCalledOnce();
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("temporarily owns cleanup when cancelling unresolved work from a paused engine", async () => {
    Object.assign(h.runtime.jitCampaign, {
      state: "armed",
      targetEpoch: 10,
      tokenIds: ["7"],
      autoStopOnCompletion: false,
    });
    h.runtime.running = false;
    h.hasUnresolvedJitCampaignWork.mockReturnValueOnce(true);
    const app = await buildServer();

    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(h.runtime.saveJitCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEpoch: 10,
        tokenIds: ["7"],
        autoStopOnCompletion: true,
      }),
      0,
    );
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.startEngine).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects a JIT target using the fresh chain epoch, not stale runtime state", async () => {
    h.runtime.currentEpoch = 9n;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 10, tokenIds: ["7"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "targetEpoch must be after current epoch 10" });
    expect(h.runtime.saveJitCampaign).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects past, unowned, and stale JIT campaigns", async () => {
    const app = await buildServer();
    const past = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 9, tokenIds: ["7"] },
    });
    expect(past.statusCode).toBe(400);
    const unowned = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: true, expectedRevision: 0, targetEpoch: 11, tokenIds: ["999"] },
    });
    expect(unowned.statusCode).toBe(400);
    h.runtime.jitCampaign.revision = 2;
    const stale = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });

  it("keeps JIT paused when its campaign rename commits without durability confirmation", async () => {
    h.runtime.running = true;
    h.runtime.saveJitCampaign.mockImplementationOnce((patch: Record<string, unknown>) => {
      h.runtime.jitCampaign = {
        ...h.runtime.jitCampaign,
        ...patch,
        revision: h.runtime.jitCampaign.revision + 1,
      } as typeof h.campaign;
      throw new AtomicWriteCommittedError("/tmp/config.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/jit", headers: { host: "localhost" },
      payload: { enable: false, expectedRevision: 0 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("JIT campaign was applied"),
      status: { jitRevision: 1, jitEnabled: false },
    });
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates a candidate RPC before stopping and swapping clients", async () => {
    h.runtime.running = true;
    h.validateRpc.mockRejectedValueOnce(new Error(
      "wrong chain for invalid-key-value at https://tenant-secret.rpc.example/v2/invalid-key-value",
    ));
    const previous = {
      httpUrl: h.appConfig.httpUrl,
      wsUrl: h.appConfig.wsUrl,
      nftUrl: h.appConfig.nftUrl,
      mode: h.appConfig.mode,
    };
    const app = await buildServer();
    const failed = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { alchemyApiKey: "invalid-key-value" },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).toContain("REDACTED_CANDIDATE_KEY");
    expect(failed.body).toContain("REDACTED_RPC_ENDPOINT");
    expect(failed.body).not.toContain("invalid-key-value");
    expect(failed.body).not.toContain("tenant-secret");
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.reinitClients).not.toHaveBeenCalled();
    expect(h.appConfig).toMatchObject(previous);
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("lets Stop preempt slow settings validation and prevents a later restart", async () => {
    let releaseValidation!: () => void;
    h.runtime.running = true;
    h.validateRpc.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseValidation = resolve;
    }));
    const app = await buildServer();
    const settings = app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { alchemyApiKey: "replacement-key-value" },
    });

    await vi.waitFor(() => expect(h.validateRpc).toHaveBeenCalledOnce());
    const stopping = app.inject({ method: "POST", url: "/api/stop", headers: { host: "localhost" } });
    await vi.waitFor(() => expect(h.runtime.running).toBe(false));
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.waitForEngineIdle).not.toHaveBeenCalled();

    releaseValidation();
    const [settingsResponse, stopResponse] = await Promise.all([settings, stopping]);
    expect(settingsResponse.statusCode).toBe(200);
    expect(stopResponse.statusCode).toBe(200);
    expect(h.stopEngine).toHaveBeenCalledTimes(2);
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.running).toBe(false);
    await app.close();
  });

  it("lets Lock preempt slow settings validation before clearing the identity", async () => {
    let releaseValidation!: () => void;
    h.runtime.running = true;
    h.validateRpc.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseValidation = resolve;
    }));
    const app = await buildServer();
    const settings = app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { alchemyApiKey: "replacement-key-value" },
    });

    await vi.waitFor(() => expect(h.validateRpc).toHaveBeenCalledOnce());
    const locking = app.inject({ method: "POST", url: "/api/lock", headers: { host: "localhost" } });
    await vi.waitFor(() => expect(h.runtime.running).toBe(false));
    expect(h.runtime.lock).not.toHaveBeenCalled();

    releaseValidation();
    const [settingsResponse, lockResponse] = await Promise.all([settings, locking]);
    expect(settingsResponse.statusCode).toBe(200);
    expect(lockResponse.statusCode).toBe(200);
    expect(h.runtime.lock).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.runtime.unlocked).toBe(false);
    await app.close();
  });

  it("requires explicit risk acknowledgement before public-to-mainnet can reactivate a persisted bid", async () => {
    h.appConfig.mode = "public";
    h.runtime.strategy = {
      ...h.strategy,
      combinedBoundaryBundle: true,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    };
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "mainnet" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("explicit acknowledgement");
    expect(h.getChainId).not.toHaveBeenCalled();
    expect(h.resolveBuilderIncentiveForMode).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.appConfig.mode).toBe("public");
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("keeps an environment-owned submission mode immutable even with risk acknowledgement", async () => {
    h.appConfig.mode = "public";
    h.appConfig.modeConfiguredByEnvironment = true;
    h.runtime.strategy = {
      ...h.strategy,
      combinedBoundaryBundle: true,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    };
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "mainnet", acknowledgeCoinbaseBidRisk: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("fixed by the MODE environment variable");
    expect(h.getChainId).not.toHaveBeenCalled();
    expect(h.resolveBuilderIncentiveForMode).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.appConfig.mode).toBe("public");
    await app.close();
  });

  it("validates the candidate mainnet chain and payer before saving, then emits the authoritative mode", async () => {
    h.appConfig.mode = "public";
    h.runtime.strategy = {
      ...h.strategy,
      combinedBoundaryBundle: true,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    };
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "mainnet", acknowledgeCoinbaseBidRisk: true },
    });

    expect(response.statusCode).toBe(200);
    expect(h.resolveBuilderIncentiveForMode).toHaveBeenCalledWith(
      h.runtime.strategy,
      1,
      "mainnet",
      h.publicClient,
    );
    expect(h.resolveBuilderIncentiveForMode.mock.invocationCallOrder[0]).toBeLessThan(
      h.stopEngine.mock.invocationCallOrder[0]!,
    );
    expect(h.resolveBuilderIncentiveForMode.mock.invocationCallOrder[0]).toBeLessThan(
      h.saveSettings.mock.invocationCallOrder[0]!,
    );
    expect(h.appConfig.mode).toBe("mainnet");
    expect(h.runtime.chainId).toBe(1);
    expect(h.runtime.emitStatus).toHaveBeenCalledOnce();
    expect(h.startEngine).toHaveBeenCalledOnce();
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("rejects a public-to-mainnet transition when the pinned payer check fails", async () => {
    h.appConfig.mode = "public";
    h.runtime.strategy = {
      ...h.strategy,
      combinedBoundaryBundle: true,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    };
    h.runtime.running = true;
    h.resolveBuilderIncentiveForMode.mockResolvedValueOnce({
      active: false,
      reason: "CoinbasePayer bytecode does not match the approved stateless runtime",
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "mainnet", acknowledgeCoinbaseBidRisk: true },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("does not match");
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.appConfig.mode).toBe("public");
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("checks a reactivating payer against a replacement RPC candidate rather than the old client", async () => {
    h.appConfig.mode = "public";
    h.runtime.strategy = {
      ...h.strategy,
      combinedBoundaryBundle: true,
      coinbaseBidEnabled: true,
      coinbaseBidEth: "0.01",
      coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
    };
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: {
        alchemyApiKey: "replacement-key-value",
        mode: "mainnet",
        acknowledgeCoinbaseBidRisk: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(h.validateRpc).toHaveBeenCalledOnce();
    const candidateClient = h.resolveBuilderIncentiveForMode.mock.calls[0]![3];
    expect(candidateClient).not.toBe(h.publicClient);
    expect(candidateClient).toEqual(expect.objectContaining({ getBytecode: expect.any(Function) }));
    expect(h.resolveBuilderIncentiveForMode).toHaveBeenCalledWith(
      h.runtime.strategy,
      1,
      "mainnet",
      candidateClient,
    );
    expect(h.getChainId).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an incompatible mode before mutating or stopping a running engine", async () => {
    h.appConfig.mode = "local";
    h.runtime.running = true;
    h.getChainId.mockResolvedValueOnce(31_337);
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "public" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("requires Ethereum mainnet"),
    });
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();
    expect(h.appConfig.mode).toBe("local");
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("never replaces a local RPC when an Alchemy-key update is requested", async () => {
    h.appConfig.mode = "local";
    h.appConfig.httpUrl = "http://127.0.0.1:8545";
    h.appConfig.wsUrl = undefined;
    h.appConfig.nftUrl = undefined;
    h.appConfig.endpointOverrides = { http: true, ws: false, nft: false };
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { alchemyApiKey: "valid-looking-local-key" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("cannot be changed at runtime in local mode");
    expect(h.validateRpc).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(h.reinitClients).not.toHaveBeenCalled();
    expect(h.stopEngine).not.toHaveBeenCalled();
    expect(h.appConfig.httpUrl).toBe("http://127.0.0.1:8545");
    expect(h.runtime.running).toBe(true);
    await app.close();
  });

  it("preserves explicit RPC overrides while updating only key-derived endpoints", async () => {
    h.appConfig.mode = "public";
    h.appConfig.httpUrl = "https://operator-http.test";
    h.appConfig.wsUrl = "wss://operator-ws.test";
    h.appConfig.nftUrl = "https://old-nft.test";
    h.appConfig.endpointOverrides = { http: true, ws: true, nft: false };
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { alchemyApiKey: "valid-looking-mainnet-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(h.validateRpc).toHaveBeenCalledWith(expect.objectContaining({
      httpUrl: "https://operator-http.test",
      nftUrl: "https://new-nft.test",
    }));
    expect(h.appConfig).toMatchObject({
      httpUrl: "https://operator-http.test",
      wsUrl: "wss://operator-ws.test",
      nftUrl: "https://new-nft.test",
    });
    expect(h.reinitClients).toHaveBeenCalledWith(
      "https://operator-http.test",
      "wss://operator-ws.test",
    );
    await app.close();
  });

  it("fails start closed when no RPC URL is configured", async () => {
    h.appConfig.httpUrl = "";
    h.getChainId.mockRejectedValueOnce(new Error("RPC HTTP URL is not configured"));
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/start", headers: { host: "localhost" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("RPC HTTP URL is not configured");
    expect(h.recoverAuthorizedSubmissions).not.toHaveBeenCalled();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("redacts provider endpoints and serialized transactions from HTTP errors", async () => {
    const raw = `0X${"AB".repeat(100)}`;
    h.getChainId.mockRejectedValueOnce(new Error(
      `request failed URL: https://tenant-secret.rpc.example/v2/operator-key body=${raw}`,
    ));
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/start", headers: { host: "localhost" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("[REDACTED_RPC_ENDPOINT]");
    expect(response.body).toContain("[REDACTED_SERIALIZED_TRANSACTION]");
    expect(response.body).not.toContain("tenant-secret");
    expect(response.body).not.toContain("operator-key");
    expect(response.body).not.toContain(raw);
    await app.close();
  });

  it("applies committed settings but stays paused when durability is unconfirmed", async () => {
    h.runtime.running = true;
    h.saveSettings.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/settings.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/settings", headers: { host: "localhost" },
      payload: { mode: "public" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("Settings were applied"),
      mode: "public",
    });
    expect(h.appConfig.mode).toBe("public");
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("serializes a confirmed keystore overwrite and locks the old in-memory identity", async () => {
    h.keystoreExists.mockReturnValue(true);
    h.runtime.unlocked = true;
    h.runtime.running = true;
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/keystore", headers: { host: "localhost" },
      payload: { mode: "generate", passphrase: "correct horse", overwrite: true },
    });
    expect(response.statusCode).toBe(200);
    expect(h.stopEngine).toHaveBeenCalledOnce();
    expect(h.waitForEngineIdle).toHaveBeenCalledOnce();
    expect(h.saveKeystore).toHaveBeenCalledOnce();
    expect(h.runtime.lock).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("locks the old identity and stays paused when a keystore rename has committed", async () => {
    h.keystoreExists.mockReturnValue(true);
    h.runtime.unlocked = true;
    h.runtime.running = true;
    h.saveKeystore.mockImplementationOnce(() => {
      throw new AtomicWriteCommittedError("/tmp/wallet.keystore.json", {
        cause: new Error("simulated directory fsync failure"),
      });
    });
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/keystore", headers: { host: "localhost" },
      payload: { mode: "generate", passphrase: "correct horse", overwrite: true },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("Keystore was replaced"),
      address: "0x2222222222222222222222222222222222222222",
    });
    expect(h.runtime.lock).toHaveBeenCalledOnce();
    expect(h.startEngine).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues a concurrent lock behind an in-flight keystore overwrite", async () => {
    let releaseOverwrite!: () => void;
    h.keystoreExists.mockReturnValue(true);
    h.runtime.unlocked = true;
    h.runtime.running = true;
    h.waitForEngineIdle
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOverwrite = resolve; }))
      .mockResolvedValue(undefined);
    const app = await buildServer();

    const overwrite = app.inject({
      method: "POST", url: "/api/keystore", headers: { host: "localhost" },
      payload: { mode: "generate", passphrase: "correct horse", overwrite: true },
    });
    await vi.waitFor(() => expect(h.stopEngine).toHaveBeenCalledOnce());
    const lock = app.inject({ method: "POST", url: "/api/lock", headers: { host: "localhost" } });
    await Promise.resolve();
    expect(h.saveKeystore).not.toHaveBeenCalled();
    expect(h.runtime.lock).not.toHaveBeenCalled();

    releaseOverwrite();
    const [overwriteResponse, lockResponse] = await Promise.all([overwrite, lock]);
    expect(overwriteResponse.statusCode).toBe(200);
    expect(lockResponse.statusCode).toBe(200);
    expect(h.runtime.lock).toHaveBeenCalledTimes(2);
    expect(h.saveKeystore.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.lock.mock.invocationCallOrder[0]!,
    );
    expect(h.waitForEngineIdle).toHaveBeenCalledTimes(2);
    expect(h.runtime.running).toBe(false);
    await app.close();
  });
});
