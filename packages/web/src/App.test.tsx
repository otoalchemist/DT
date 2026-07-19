// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { App } from "./App.js";

vi.mock("./api.js", () => ({
  api: {
    getSettings: vi.fn(),
    keystore: vi.fn(),
    saveAlchemyKey: vi.fn(),
  },
}));

vi.mock("./useSocket.js", () => ({
  useSocket: () => ({
    status: { unlocked: false },
    activity: [],
    connected: true,
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

afterEach(cleanup);

describe("App setup readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
