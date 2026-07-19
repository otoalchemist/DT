import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  appConfig: { httpUrl: "", wsUrl: undefined },
}));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn() } }));

const { getChainId, publicClient } = await import("./chain.js");

describe("unconfigured RPC transport", () => {
  it("fails closed instead of inheriting viem's public default RPC", async () => {
    await expect(getChainId()).rejects.toThrow("RPC HTTP URL is not configured");
    await expect(publicClient.getBlockNumber()).rejects.toThrow("RPC HTTP URL is not configured");
  });
});
