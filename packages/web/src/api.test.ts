import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "@dat-bot/shared";
import { api, inspectBackendCompatibility } from "./api.js";

const compatibleStatus = {
  version: VERSION,
  mode: "mainnet",
  unlocked: false,
  jitEnabled: false,
  jitRevision: 1,
  jitTokenIds: [],
  strategyRevision: 1,
  pendingExposureWei: "0",
  journalHealthy: true,
  nftConfigured: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("backend bootstrap compatibility", () => {
  it.each(["0.2.9", "0.4.0"])("rejects backend v%s", (version) => {
    expect(inspectBackendCompatibility({ ...compatibleStatus, version })).toEqual({
      compatible: false,
      backendVersion: version,
      reason: `Dashboard v${VERSION} cannot use backend v${version}.`,
    });
  });

  it("rejects an unversioned legacy backend", () => {
    expect(inspectBackendCompatibility({ unlocked: false })).toMatchObject({
      compatible: false,
      backendVersion: null,
    });
  });

  it("rejects a same-version backend with an incompatible status schema", () => {
    const { jitTokenIds: _missing, ...incomplete } = compatibleStatus;
    expect(inspectBackendCompatibility(incomplete)).toEqual({
      compatible: false,
      backendVersion: VERSION,
      reason: `Backend v${VERSION} returned an incompatible status schema.`,
    });
  });

  it("rejects a same-version backend without an authoritative submission mode", () => {
    const { mode: _missing, ...incomplete } = compatibleStatus;
    expect(inspectBackendCompatibility(incomplete)).toMatchObject({
      compatible: false,
      backendVersion: VERSION,
    });
  });

  it("accepts the versioned bootstrap schema", () => {
    expect(inspectBackendCompatibility(compatibleStatus)).toMatchObject({
      compatible: true,
      backendVersion: VERSION,
      status: compatibleStatus,
    });
  });
});

describe("strategy mutation transport", () => {
  it("sends explicit builder-risk acknowledgement only when requested", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ revision: 4, config: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setConfig(3, { coinbaseBidEnabled: true }, true);
    const acknowledged = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(acknowledged.body as string)).toEqual({
      expectedRevision: 3,
      patch: { coinbaseBidEnabled: true },
      acknowledgeCoinbaseBidRisk: true,
    });

    await api.setConfig(4, { dryRun: false });
    const ordinary = fetchMock.mock.calls[1]![1]!;
    expect(JSON.parse(ordinary.body as string)).toEqual({
      expectedRevision: 4,
      patch: { dryRun: false },
    });
  });

  it("sends mode reactivation acknowledgement only when requested", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, mode: "mainnet" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.saveMode("mainnet", true);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      mode: "mainnet",
      acknowledgeCoinbaseBidRisk: true,
    });

    await api.saveMode("public");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ mode: "public" });
  });
});
