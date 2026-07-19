// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotStatus,
  OwnedTokenStatus,
  StrategyConfig,
  StrategySnapshot,
} from "@dat-bot/shared";
import { ApiError, api } from "./api.js";
import { JitPanel } from "./JitPanel.js";

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
      status: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      jit: vi.fn(),
    },
  };
});

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
  offenseBoundaryScheduling: false,
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  maxPaymentEth: 0,
};

const strategy: StrategySnapshot = { revision: 1, config };

function status(overrides: Partial<BotStatus> = {}): BotStatus {
  return {
    version: "0.3.0",
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
    ...overrides,
  };
}

function token(tokenId: string): OwnedTokenStatus {
  return {
    tokenId,
    lastEpochPaid: "9",
    currentEpoch: "9",
    auditDueTimestamp: "0",
    secondsUntilKillable: null,
    bribeBalance: "0",
    hasLifeInsurance: false,
    risk: "safe",
    estimatedPayWei: "0",
  };
}

afterEach(cleanup);

describe("JitPanel campaign scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("arms the displayed epoch and exact selected IDs, then applies the mutation response", async () => {
    const initialStatus = status();
    const mutationStatus = status({
      running: true,
      jitEnabled: true,
      jitState: "armed",
      jitTargetEpoch: 12,
      jitRevision: 4,
      jitTokenIds: ["7"],
    });
    vi.mocked(api.jit).mockResolvedValue(mutationStatus);
    vi.mocked(api.getConfig).mockResolvedValue(strategy);
    const onStatusChange = vi.fn();
    const onStrategyChange = vi.fn();

    render(
      <JitPanel
        status={initialStatus}
        tokens={[token("7"), token("8")]}
        strategy={strategy}
        onStatusChange={onStatusChange}
        onStrategyChange={onStrategyChange}
      />,
    );

    const target = screen.getByLabelText("JIT target epoch") as HTMLInputElement;
    await waitFor(() => expect(target.value).toBe("10"));
    fireEvent.change(target, { target: { value: "12" } });
    const tokenEight = screen.getByLabelText("#8") as HTMLInputElement;
    await waitFor(() => expect(tokenEight.checked).toBe(true));
    fireEvent.click(tokenEight);
    fireEvent.click(screen.getByRole("button", { name: "Arm payment for epoch 12" }));

    await waitFor(() => {
      expect(api.jit).toHaveBeenCalledWith({
        enable: true,
        expectedRevision: 3,
        targetEpoch: 12,
        tokenIds: ["7"],
      });
      expect(onStatusChange).toHaveBeenCalledWith(mutationStatus);
      expect(onStrategyChange).toHaveBeenCalledWith(strategy);
    });
    // Arming is a campaign mutation only. It must never PATCH strategy or
    // implicitly broaden continuous defense.
    expect(api.setConfig).not.toHaveBeenCalled();
    expect(strategy.config.defenseEnabled).toBe(false);
  });

  it("restores the exact authoritative subset after a reload", async () => {
    render(
      <JitPanel
        status={status({
          jitEnabled: true,
          jitState: "armed",
          jitTargetEpoch: 15,
          jitRevision: 8,
          jitTokenIds: ["8"],
        })}
        tokens={[token("7"), token("8")]}
        strategy={strategy}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    const tokenSeven = screen.getByLabelText("#7") as HTMLInputElement;
    const tokenEight = screen.getByLabelText("#8") as HTMLInputElement;
    await waitFor(() => {
      expect(tokenSeven.checked).toBe(false);
      expect(tokenEight.checked).toBe(true);
    });
    expect(tokenSeven.disabled).toBe(true);
    expect(tokenEight.disabled).toBe(true);
    expect(screen.getByText("ARMED · epoch 15")).toBeTruthy();
  });

  it("refetches authoritative campaign and strategy state after a 409", async () => {
    const freshStatus = status({
      jitEnabled: true,
      jitState: "armed",
      jitTargetEpoch: 11,
      jitRevision: 4,
      jitTokenIds: ["8"],
    });
    const freshStrategy = { revision: 2, config: { ...config, dryRun: false } };
    vi.mocked(api.jit).mockRejectedValue(new ApiError("Revision conflict", 409, 4));
    vi.mocked(api.status).mockResolvedValue(freshStatus);
    vi.mocked(api.getConfig).mockResolvedValue(freshStrategy);
    const onStatusChange = vi.fn();
    const onStrategyChange = vi.fn();

    render(
      <JitPanel
        status={status()}
        tokens={[token("7"), token("8")]}
        strategy={strategy}
        onStatusChange={onStatusChange}
        onStrategyChange={onStrategyChange}
      />,
    );
    await waitFor(() => {
      expect((screen.getByLabelText("#7") as HTMLInputElement).checked).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Arm payment for epoch 10" }));

    await waitFor(() => {
      expect(api.status).toHaveBeenCalledOnce();
      expect(api.getConfig).toHaveBeenCalledOnce();
      expect(onStatusChange).toHaveBeenCalledWith(freshStatus);
      expect(onStrategyChange).toHaveBeenCalledWith(freshStrategy);
    });
    expect(await screen.findByText(/Campaign changed elsewhere/)).toBeTruthy();
  });
});
