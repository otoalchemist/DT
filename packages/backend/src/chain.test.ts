import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  appConfig: { httpUrl: "", wsUrl: undefined },
}));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn() } }));

const { logger } = await import("./logger.js");
const { getChainId, publicClient, reinitClients } = await import("./chain.js");

describe("unconfigured RPC transport", () => {
  it("fails closed instead of inheriting viem's public default RPC", async () => {
    await expect(getChainId()).rejects.toThrow("RPC HTTP URL is not configured");
    await expect(publicClient.getBlockNumber()).rejects.toThrow("RPC HTTP URL is not configured");
  });

  it("never writes RPC credentials or path tokens to logs", () => {
    reinitClients("https://operator:password@rpc.example/v2/secret-api-key?token=also-secret");

    expect(logger.info).toHaveBeenCalledWith("RPC clients reinitialized (configured endpoint)");
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toMatch(
      /operator|password|secret-api-key|also-secret/,
    );
  });
});
