// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  racePublicMempool: true,
  dynamicTipEnabled: true,
  dynamicTipMaxGwei: 50.1,
  combinedBoundaryBundle: false,
  coinbaseBidEnabled: false,
  coinbaseBidEth: "0",
  coinbasePayerAddress: "",
  maxPaymentEth: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("rebases a stale edit on the authoritative server snapshot after a conflict", async () => {
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
    expect(defense.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith(authoritative);
  });

  it("preserves an unsaved strategy draft when payment settings advance the revision", async () => {
    const initial: StrategySnapshot = { revision: 1, config };
    const paymentSave: StrategySnapshot = {
      revision: 2,
      config: { ...config, priorityFeeGwei: 77, auditSafetyBufferSeconds: 43_200 },
    };
    const saved: StrategySnapshot = {
      revision: 3,
      config: { ...paymentSave.config, defenseEnabled: true },
    };
    vi.mocked(api.setConfig).mockResolvedValue(saved);
    const onChange = vi.fn();
    const view = render(<Config initial={initial} onChange={onChange} />);

    const defense = screen.getByLabelText("Enable continuous defense") as HTMLInputElement;
    fireEvent.click(defense);
    expect(defense.checked).toBe(true);

    view.rerender(<Config initial={paymentSave} onChange={onChange} />);

    expect(await screen.findByText(/unsaved strategy edits were preserved/)).toBeTruthy();
    expect(defense.checked).toBe(true);
    expect((screen.getByLabelText(
      "Clear audits with this many seconds remaining",
    ) as HTMLInputElement).value).toBe("43200");

    fireEvent.click(screen.getByRole("button", { name: "Save strategy" }));
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith(2, { defenseEnabled: true });
      expect(onChange).toHaveBeenCalledWith(saved);
    });
  });

  it("preserves edits made while an older strategy save is in flight", async () => {
    const initial: StrategySnapshot = { revision: 1, config };
    const firstSave = deferred<StrategySnapshot>();
    const firstSnapshot: StrategySnapshot = {
      revision: 2,
      config: { ...config, defenseEnabled: true },
    };
    vi.mocked(api.setConfig).mockReturnValueOnce(firstSave.promise);

    render(<Config initial={initial} onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Enable continuous defense"));
    fireEvent.click(screen.getByRole("button", { name: "Save strategy" }));
    await waitFor(() => expect(api.setConfig).toHaveBeenCalledWith(1, { defenseEnabled: true }));

    const floor = screen.getByLabelText("Min wallet balance floor (ETH)") as HTMLInputElement;
    fireEvent.change(floor, { target: { value: "0.25" } });
    firstSave.resolve(firstSnapshot);

    await waitFor(() => expect(floor.value).toBe("0.25"));
    expect((screen.getByRole("button", { name: "Save strategy" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("warns, confirms, and acknowledges a public-to-mainnet bid reactivation", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      alchemyKeySet: true,
      rpcConfigured: true,
      ownershipConfigured: true,
      setupReady: true,
      mode: "public",
      modeConfiguredByEnvironment: false,
      keyConfiguredByEnvironment: false,
    });
    vi.mocked(api.saveMode).mockResolvedValue({ ok: true, mode: "mainnet" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const initial: StrategySnapshot = {
      revision: 1,
      config: {
        ...config,
        combinedBoundaryBundle: true,
        coinbaseBidEnabled: true,
        coinbaseBidEth: "0.01",
        coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
      },
    };

    const onSettingsChange = vi.fn();

    render(<Config initial={initial} onChange={vi.fn()} onSettingsChange={onSettingsChange} />);
    expect(await screen.findByText(/Switching to mainnet can reactivate/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "mainnet" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("non-refundable payment"));
    await waitFor(() => expect(api.saveMode).toHaveBeenCalledWith("mainnet", true));
    expect(await screen.findByText("Mode switched to mainnet.")).toBeTruthy();
    expect(onSettingsChange).toHaveBeenCalledOnce();
  });

  it("announces a successful RPC replacement so capability state is refreshed", async () => {
    vi.mocked(api.saveAlchemyKey).mockResolvedValue({ ok: true });
    const onSettingsChange = vi.fn();

    render(
      <Config
        initial={{ revision: 1, config }}
        onChange={vi.fn()}
        onSettingsChange={onSettingsChange}
      />,
    );
    await screen.findByText("Submission mode");
    fireEvent.change(screen.getByLabelText("Update Alchemy API key"), {
      target: { value: "replacement-key-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update key" }));

    await waitFor(() => expect(api.saveAlchemyKey).toHaveBeenCalledWith("replacement-key-value"));
    expect(onSettingsChange).toHaveBeenCalledOnce();
  });

  it("does not request a reactivating mode switch when the operator declines", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      alchemyKeySet: true,
      rpcConfigured: true,
      ownershipConfigured: true,
      setupReady: true,
      mode: "public",
      modeConfiguredByEnvironment: false,
      keyConfiguredByEnvironment: false,
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const initial: StrategySnapshot = {
      revision: 1,
      config: {
        ...config,
        combinedBoundaryBundle: true,
        coinbaseBidEnabled: true,
        coinbaseBidEth: "0.01",
        coinbasePayerAddress: "0x3333333333333333333333333333333333333333",
      },
    };

    render(<Config initial={initial} onChange={vi.fn()} />);
    await screen.findByText(/Switching to mainnet can reactivate/);
    fireEvent.click(screen.getByRole("button", { name: "mainnet" }));

    expect(api.saveMode).not.toHaveBeenCalled();
  });
});
