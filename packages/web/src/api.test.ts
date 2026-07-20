import { describe, expect, it } from "vitest";
import { VERSION } from "@dat-bot/shared";
import { inspectBackendCompatibility } from "./api.js";

const compatibleStatus = {
  version: VERSION,
  unlocked: false,
  jitEnabled: false,
  jitRevision: 1,
  jitTokenIds: [],
  strategyRevision: 1,
  pendingExposureWei: "0",
  journalHealthy: true,
  nftConfigured: true,
};

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

  it("accepts the versioned bootstrap schema", () => {
    expect(inspectBackendCompatibility(compatibleStatus)).toMatchObject({
      compatible: true,
      backendVersion: VERSION,
      status: compatibleStatus,
    });
  });
});
