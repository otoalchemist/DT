// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StrategyConfig, StrategySnapshot } from "@dat-bot/shared";
import { ApiError, api } from "./api.js";
import { Config } from "./Config.js";

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
      getSettings: vi.fn(),
      getConfig: vi.fn(),
      setConfig: vi.fn(),
      saveAlchemyKey: vi.fn(),
      saveMode: vi.fn(),
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

describe("Config revision conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue({
      alchemyKeySet: true,
      rpcConfigured: true,
      ownershipConfigured: true,
      setupReady: true,
      mode: "mainnet",
      modeConfiguredByEnvironment: false,
      keyConfiguredByEnvironment: false,
    });
  });

  it("discards a stale edit and applies the authoritative server snapshot", async () => {
    const initial: StrategySnapshot = { revision: 1, config };
    const authoritative: StrategySnapshot = {
      revision: 2,
      config: { ...config, auditSafetyBufferSeconds: 43_200 },
    };
    vi.mocked(api.setConfig).mockRejectedValue(new ApiError("Revision conflict", 409, 2));
    vi.mocked(api.getConfig).mockResolvedValue(authoritative);
    const onChange = vi.fn();

    render(<Config initial={initial} onChange={onChange} />);
    const defense = screen.getByLabelText("Enable continuous defense") as HTMLInputElement;
    fireEvent.click(defense);
    expect(defense.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save strategy" }));

    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith(1, { defenseEnabled: true });
      expect(api.getConfig).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText(/Configuration changed elsewhere/)).toBeTruthy();
    expect(defense.checked).toBe(false);
    expect(onChange).toHaveBeenCalledWith(authoritative);
  });
});
