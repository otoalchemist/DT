// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
      builderIncentive: vi.fn(),
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
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  combinedBoundaryBundle: false,
  coinbaseBidEnabled: false,
  coinbaseBidEth: "0",
  coinbasePayerAddress: "",
  maxPaymentEth: 0,
};

const strategy: StrategySnapshot = { revision: 1, config };

function status(overrides: Partial<BotStatus> = {}): BotStatus {
  return {
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

function Harness({ initial }: { initial: StrategySnapshot }) {
  const [current, setCurrent] = useState(initial);
  return (
    <JitPanel
      status={status()}
      tokens={[token("7")]}
      strategy={current}
      onStatusChange={vi.fn()}
      onStrategyChange={setCurrent}
    />
  );
}

describe("JitPanel campaign scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.builderIncentive).mockResolvedValue({
      active: false,
      reason: "Direct builder incentives are disabled",
    });
  });

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
    const all = screen.getByRole("button", { name: "all" }) as HTMLButtonElement;
    const none = screen.getByRole("button", { name: "none" }) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    expect(none.disabled).toBe(true);
    fireEvent.click(all);
    fireEvent.click(none);
    expect(tokenSeven.checked).toBe(false);
    expect(tokenEight.checked).toBe(true);
    expect(screen.getByText("1 armed")).toBeTruthy();
    expect(screen.getByLabelText("Armed Citizen IDs").textContent).toContain("#8");
    expect(screen.getByText("ARMED · epoch 15")).toBeTruthy();
  });

  it("derives armed count, exposure, and ID display from the authoritative campaign", async () => {
    render(
      <JitPanel
        status={status({
          jitEnabled: true,
          jitState: "armed",
          jitTargetEpoch: 15,
          jitRevision: 8,
          jitTokenIds: ["8", "9"],
        })}
        tokens={[token("7"), token("8")]}
        strategy={strategy}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect((screen.getByLabelText("#7") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByLabelText("#8") as HTMLInputElement).checked).toBe(true);
    });
    expect(screen.getByText("2 armed")).toBeTruthy();
    expect(screen.getByText("0.0207 ETH")).toBeTruthy();
    expect(screen.getByLabelText("Armed Citizen IDs").textContent).toContain("#8, #9");
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

  it("shows irreversible-cost and no-guarantee warnings separately from backend state", async () => {
    render(
      <JitPanel
        status={status()}
        tokens={[token("7")]}
        strategy={{
          revision: 1,
          config: {
            ...config,
            coinbaseBidEnabled: true,
            coinbaseBidEth: "0.01",
            coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
            combinedBoundaryBundle: true,
          },
        }}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Builder incentive risk warning").textContent).toContain("Non-refundable ETH");
    expect(screen.getByLabelText("Builder incentive risk warning").textContent).toContain("does not guarantee");
    expect(screen.getByLabelText("Builder incentive risk warning").textContent).toContain("No bid-only submission");
    expect(await screen.findByText("Backend state: Direct builder incentives are disabled")).toBeTruthy();
    expect(screen.queryByText(/CONFIG \/ CHAIN \/ CODE VERIFIED/)).toBeNull();
  });

  it("labels only config, chain, and code capability after backend verification", async () => {
    vi.mocked(api.builderIncentive).mockResolvedValue({
      active: true,
      payer: "0x3333333333333333333333333333333333333333",
      bidWei: "10000000000000000",
      runtimeCodeHash: `0x${"44".repeat(32)}`,
    });
    render(
      <JitPanel
        status={status()}
        tokens={[token("7")]}
        strategy={{
          revision: 1,
          config: {
            ...config,
            coinbaseBidEnabled: true,
            coinbaseBidEth: "0.01",
            coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
            combinedBoundaryBundle: true,
          },
        }}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("CONFIG / CHAIN / CODE VERIFIED")).toBeTruthy();
    expect(screen.getByLabelText("Builder incentive backend state").textContent).toContain(
      "This is not an executable-now signal",
    );
    const requirements = screen.getByLabelText("Builder incentive execution requirements").textContent ?? "";
    expect(requirements).toContain("currently mainnet");
    expect(requirements).toContain("stopped");
    expect(requirements).toContain("unlocked");
    expect(requirements).toContain("healthy");
    expect(requirements).toContain("Dry Run is on");
    expect(requirements).toContain("due mandatory boundary payment");
  });

  it("refreshes builder capability when authoritative submission mode changes", async () => {
    vi.mocked(api.builderIncentive)
      .mockResolvedValueOnce({
        active: true,
        payer: "0x3333333333333333333333333333333333333333",
        bidWei: "10000000000000000",
        runtimeCodeHash: `0x${"44".repeat(32)}`,
      })
      .mockResolvedValueOnce({
        active: false,
        reason: "Direct builder incentives require mainnet private-bundle mode",
      });
    const enabledStrategy: StrategySnapshot = {
      revision: 1,
      config: {
        ...config,
        coinbaseBidEnabled: true,
        coinbaseBidEth: "0.01",
        coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
        combinedBoundaryBundle: true,
      },
    };
    const view = render(
      <JitPanel
        status={status({ mode: "mainnet" })}
        tokens={[token("7")]}
        strategy={enabledStrategy}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("CONFIG / CHAIN / CODE VERIFIED")).toBeTruthy();
    view.rerender(
      <JitPanel
        status={status({ mode: "public" })}
        tokens={[token("7")]}
        strategy={enabledStrategy}
        onStatusChange={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(
      "Backend state: Direct builder incentives require mainnet private-bundle mode",
    )).toBeTruthy();
    expect(api.builderIncentive).toHaveBeenCalledTimes(2);
  });

  it("refreshes builder capability after RPC settings are replaced", async () => {
    vi.mocked(api.builderIncentive)
      .mockResolvedValueOnce({
        active: true,
        payer: "0x3333333333333333333333333333333333333333",
        bidWei: "10000000000000000",
        runtimeCodeHash: `0x${"44".repeat(32)}`,
      })
      .mockResolvedValueOnce({
        active: false,
        reason: "Builder capability must be revalidated against the replacement RPC",
      });
    const enabledStrategy: StrategySnapshot = {
      revision: 1,
      config: {
        ...config,
        coinbaseBidEnabled: true,
        coinbaseBidEth: "0.01",
        coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
        combinedBoundaryBundle: true,
      },
    };
    const sharedProps = {
      status: status({ mode: "mainnet" as const }),
      tokens: [token("7")],
      strategy: enabledStrategy,
      onStatusChange: vi.fn(),
      onStrategyChange: vi.fn(),
    };
    const view = render(<JitPanel {...sharedProps} capabilityRefreshToken={0} />);

    expect(await screen.findByText("CONFIG / CHAIN / CODE VERIFIED")).toBeTruthy();
    view.rerender(<JitPanel {...sharedProps} capabilityRefreshToken={1} />);

    expect(await screen.findByText(
      "Backend state: Builder capability must be revalidated against the replacement RPC",
    )).toBeTruthy();
    expect(api.builderIncentive).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit confirmation and sends the API risk acknowledgement", async () => {
    const initial: StrategySnapshot = {
      revision: 1,
      config: {
        ...config,
        coinbaseBidEth: "0.01",
        coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
      },
    };
    vi.mocked(api.setConfig).mockImplementation(async (_revision, patch) => ({
      revision: 2,
      config: { ...initial.config, ...patch },
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness initial={initial} />);

    fireEvent.click(screen.getByLabelText(
      "Enable a direct builder incentive for eligible combined boundary cohorts",
    ));
    fireEvent.click(screen.getByLabelText(
      "Allow a combined boundary payment / audit private cohort",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledOnce();
      expect(api.setConfig).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          coinbaseBidEnabled: true,
          coinbaseBidEth: "0.01",
          coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
          combinedBoundaryBundle: true,
        }),
        true,
      );
    });
  });
});
