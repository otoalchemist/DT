// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, BotStatus, StrategyConfig, StrategySnapshot } from "@dat-bot/shared";
import { ApiError, api } from "./api.js";
import { Dashboard } from "./Dashboard.js";

vi.mock("./api.js", () => {
  class MockApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly currentRevision?: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }

  return {
    ApiError: MockApiError,
    api: {
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      tokens: vi.fn(),
      targets: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      lock: vi.fn(),
    },
  };
});

vi.mock("./Config.js", () => ({
  Config: ({
    initial,
    onChange,
  }: {
    initial: StrategySnapshot;
    onChange: (snapshot: StrategySnapshot) => void;
  }) => (
    <>
      <div data-testid="strategy-snapshot">
        revision {initial.revision} / {initial.config.dryRun ? "dry-run" : "live"}
      </div>
      <button onClick={() => onChange({
        revision: 5,
        config: { ...initial.config, dryRun: false },
      })}>accept revision 5</button>
      <button onClick={() => onChange({
        revision: 4,
        config: { ...initial.config, dryRun: true },
      })}>accept stale revision 4</button>
    </>
  ),
}));

vi.mock("./JitPanel.js", () => ({ JitPanel: () => null }));
vi.mock("./PostMortem.js", () => ({ PostMortem: () => null }));

const config: StrategyConfig = {
  defenseEnabled: false,
  dryRun: true,
  auditSafetyBufferSeconds: 86_400,
  proactivePay: true,
  prepayEpochs: 1,
  autoUseBribe: false,
  maxAutoPayEpochs: 1,
  preBoundaryPay: true,
  preBoundaryLeadMs: 3_000,
  preBoundaryLeadMainnetMs: 5_000,
  offenseEnabled: false,
  autoAudit: true,
  autoKill: true,
  endgameOnlyWithin: null,
  offenseTargetTokenIds: [],
  preBoundaryAudit: true,
  preBoundaryKill: true,
  maxBaseFeeGwei: 69.1,
  priorityFeeGwei: 15.1,
  minBalanceEth: 0.01,
  replacementPriorityFeeCapGwei: 50.1,
  separateOffenseGas: true,
  offenseMaxBaseFeeGwei: 25.1,
  offensePriorityFeeGwei: 10.1,
  offenseDynamicTipEnabled: true,
  offenseDynamicTipMaxGwei: 20.1,
  offenseReplacementPriorityFeeCapGwei: 20.1,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  combinedBoundaryBundle: false,
  coinbaseBidEnabled: false,
  coinbaseBidEth: "0",
  coinbasePayerAddress: "",
  maxPaymentEth: 0,
};

const initialStrategy: StrategySnapshot = { revision: 1, config };

const status: BotStatus = {
  version: "0.3.0",
  mode: "mainnet",
  running: false,
  unlocked: true,
  dryRun: true,
  address: "0x1111111111111111111111111111111111111111",
  balanceWei: "1000000000000000000",
  chainId: 1,
  currentEpoch: "9",
  gameState: 1,
  citizenSupply: "2",
  citizensAddress: "0x2222222222222222222222222222222222222222",
  lastBlock: "100",
  spentThisEpochWei: "0",
  confirmedSpendThisEpochWei: "0",
  pendingExposureWei: "0",
  journalHealthy: true,
  journalError: null,
  startTime: "1",
  jitEnabled: false,
  jitState: "cancelled",
  jitTargetEpoch: null,
  jitRevision: 3,
  jitTokenIds: [],
  jitMessage: null,
  jitCompletedAt: null,
  strategyRevision: 1,
  nftConfigured: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Dashboard dry-run revision conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.tokens).mockResolvedValue([]);
    vi.mocked(api.targets).mockResolvedValue([]);
  });

  it("applies the authoritative snapshot and asks for an explicit retry without repeating the mutation", async () => {
    const authoritative: StrategySnapshot = {
      revision: 2,
      config: { ...config, dryRun: false },
    };
    vi.mocked(api.getConfig)
      .mockResolvedValueOnce(initialStrategy)
      .mockResolvedValueOnce(authoritative);
    vi.mocked(api.setConfig).mockRejectedValue(new ApiError("Revision conflict", 409, 2));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <Dashboard
        status={status}
        activity={[]}
        connected={true}
        pushStatus={vi.fn()}
      />,
    );

    expect((await screen.findByTestId("strategy-snapshot")).textContent).toContain("revision 1 / dry-run");
    fireEvent.click(screen.getByRole("button", { name: "DRY-RUN" }));

    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledOnce();
      expect(api.setConfig).toHaveBeenCalledWith(1, { dryRun: false });
      expect(api.getConfig).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText(/Configuration changed elsewhere; refreshed it/)).toBeTruthy();
    expect(screen.getByTestId("strategy-snapshot").textContent).toContain("revision 2 / live");
    expect(screen.getByRole("button", { name: "⚠ LIVE FIRE" })).toBeTruthy();
    expect(api.setConfig).toHaveBeenCalledOnce();
  });

  it("renders delivery-uncertain activity with its dedicated state and complete message", async () => {
    vi.mocked(api.getConfig).mockResolvedValue(initialStrategy);
    const message = "Builder delivery is uncertain; preserve nonce 42 until reconciliation confirms the complete transaction outcome.";
    const activity: ActivityEntry[] = [{
      id: "uncertain-1",
      ts: Date.now(),
      kind: "pay-taxes",
      status: "delivery-uncertain",
      txHash: `0x${"ab".repeat(32)}`,
      message,
    }];

    const { container } = render(
      <Dashboard
        status={status}
        activity={activity}
        connected={true}
        pushStatus={vi.fn()}
      />,
    );

    expect(await screen.findByText("delivery-uncertain")).toBeTruthy();
    expect(container.querySelector(".log-row > span:last-child")?.textContent).toContain(message);
    expect(container.querySelector(".pill.delivery-uncertain")?.textContent).toBe("delivery-uncertain");
  });

  it("never lets a late lower-revision panel response regress the shared snapshot", async () => {
    vi.mocked(api.getConfig).mockResolvedValue(initialStrategy);
    render(
      <Dashboard
        status={status}
        activity={[]}
        connected={false}
        pushStatus={vi.fn()}
      />,
    );

    expect((await screen.findByTestId("strategy-snapshot")).textContent)
      .toContain("revision 1 / dry-run");
    fireEvent.click(screen.getByRole("button", { name: "accept revision 5" }));
    await waitFor(() => {
      expect(screen.getByTestId("strategy-snapshot").textContent)
        .toContain("revision 5 / live");
    });

    fireEvent.click(screen.getByRole("button", { name: "accept stale revision 4" }));
    expect(screen.getByTestId("strategy-snapshot").textContent)
      .toContain("revision 5 / live");
    expect(screen.getByRole("button", { name: "⚠ LIVE FIRE" })).toBeTruthy();
  });
});
