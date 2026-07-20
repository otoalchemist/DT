// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION, type BotStatus } from "@dat-bot/shared";
import { api } from "./api.js";
import { App } from "./App.js";

vi.mock("./api.js", () => ({
  inspectBackendCompatibility: vi.fn((payload: BotStatus) => ({
    compatible: true,
    backendVersion: payload.version,
    status: payload,
  })),
  api: {
    compatibility: vi.fn(),
    status: vi.fn(),
    getSettings: vi.fn(),
    keystore: vi.fn(),
    saveAlchemyKey: vi.fn(),
  },
}));

vi.mock("./useSocket.js", () => ({
  useSocket: () => ({
    status: null,
    activity: [],
    connected: false,
    pushStatus: vi.fn(),
  }),
}));

vi.mock("./Setup.js", () => ({ Setup: () => <div>Wallet setup</div> }));
vi.mock("./Dashboard.js", () => ({ Dashboard: () => <div>Dashboard</div> }));

const baseSettings = {
  alchemyKeySet: false,
  rpcConfigured: true,
  ownershipConfigured: true,
  setupReady: true,
  mode: "local" as const,
  modeConfiguredByEnvironment: true,
  keyConfiguredByEnvironment: false,
};

const bootstrapStatus: BotStatus = {
  version: VERSION,
  running: false,
  unlocked: false,
  dryRun: true,
  address: null,
  balanceWei: null,
  chainId: 31_337,
  currentEpoch: null,
  gameState: null,
  citizenSupply: null,
  citizensAddress: null,
  lastBlock: null,
  spentThisEpochWei: "0",
  confirmedSpendThisEpochWei: "0",
  pendingExposureWei: "0",
  journalHealthy: true,
  journalError: null,
  startTime: null,
  jitEnabled: false,
  jitState: "cancelled",
  jitTargetEpoch: null,
  jitRevision: 0,
  jitTokenIds: [],
  jitMessage: null,
  jitCompletedAt: null,
  strategyRevision: 0,
  nftConfigured: true,
};

afterEach(cleanup);

describe("App setup readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.compatibility).mockResolvedValue({
      compatible: true,
      backendVersion: VERSION,
      status: bootstrapStatus,
    });
    vi.mocked(api.keystore).mockResolvedValue({ exists: false, address: null });
  });

  it("bypasses Alchemy onboarding for a complete local RPC/OWNED_TOKENS setup", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(baseSettings);
    render(<App />);

    expect(await screen.findByText("Wallet setup")).toBeTruthy();
    expect(screen.queryByText("Connect to Alchemy")).toBeNull();
  });

  it("shows local environment instructions instead of an unusable key form", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...baseSettings,
      ownershipConfigured: false,
      setupReady: false,
    });
    render(<App />);

    expect(await screen.findByText("Complete local setup")).toBeTruthy();
    expect(screen.getByText(/OWNED_TOKENS/)).toBeTruthy();
    expect(screen.queryByLabelText("Alchemy API key")).toBeNull();
  });

  it.each(["0.2.9", "0.4.0"])(
    "blocks backend v%s before consuming release-coupled settings",
    async (backendVersion) => {
      vi.mocked(api.compatibility).mockResolvedValue({
        compatible: false,
        backendVersion,
        reason: `Dashboard v${VERSION} cannot use backend v${backendVersion}.`,
      });

      render(<App />);

      expect(await screen.findByText("Dashboard/backend mismatch")).toBeTruthy();
      expect(screen.getByText(new RegExp(`Backend: v${backendVersion.replaceAll(".", "\\.")}`))).toBeTruthy();
      expect(api.getSettings).not.toHaveBeenCalled();
      expect(api.keystore).not.toHaveBeenCalled();
      expect(screen.queryByText("Wallet setup")).toBeNull();
    },
  );

  it("blocks when compatibility cannot be verified", async () => {
    vi.mocked(api.compatibility).mockRejectedValue(new Error("status endpoint unavailable"));

    render(<App />);

    expect(await screen.findByText("Cannot verify backend compatibility")).toBeTruthy();
    expect(screen.getByText("status endpoint unavailable")).toBeTruthy();
    expect(api.getSettings).not.toHaveBeenCalled();
    expect(api.keystore).not.toHaveBeenCalled();
  });
});
