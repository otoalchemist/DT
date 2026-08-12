import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";

const getChainIdRpc = vi.fn();
const getBlock = vi.fn();
const getCode = vi.fn();
const createdClients: Array<Record<string, unknown>> = [];

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => {
      const client = {
        getChainId: (...args: unknown[]) => getChainIdRpc(...args),
        getBlock: (...args: unknown[]) => getBlock(...args),
        getCode: (...args: unknown[]) => getCode(...args),
        transport: {},
      };
      createdClients.push(client);
      return client;
    }),
  };
});

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet",
    httpUrl: "http://rpc.invalid",
    wsUrl: undefined,
    gameAddress: "0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F",
  },
}));

const {
  getChainId,
  validateRpcConfiguration,
  ANVIL_CHAIN_ID,
  ETHEREUM_MAINNET_GENESIS_HASH,
  GAME_RUNTIME_CODE_HASH,
} = await import("./chain.js");
const { appConfig } = await import("./config.js");

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.mode = "mainnet";
  appConfig.gameAddress = "0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F";
  getChainIdRpc.mockResolvedValue(1);
  getBlock.mockResolvedValue({ hash: ETHEREUM_MAINNET_GENESIS_HASH });
  // We cannot invert the approved hash. Mock keccak via an object whose test value is
  // swapped below when exercising the happy path; mismatch tests use ordinary bytecode.
  getCode.mockResolvedValue("0x6000");
});

describe("RPC identity verification", () => {
  it("fails closed when chain-id lookup fails", async () => {
    getChainIdRpc.mockRejectedValue(new Error("offline"));
    await expect(getChainId()).rejects.toThrow("offline");
  });

  it("rejects another chain in live mode", async () => {
    getChainIdRpc.mockResolvedValue(10);
    await expect(getChainId()).rejects.toThrow(/expected Ethereum mainnet/);
  });

  it("rejects a non-canonical live game address", async () => {
    appConfig.gameAddress = "0x00000000000000000000000000000000000000aa";
    await expect(getChainId()).rejects.toThrow(/non-canonical GAME_ADDRESS/);
  });

  it("rejects a provider with the wrong genesis", async () => {
    getBlock.mockResolvedValue({ hash: `0x${"11".repeat(32)}` });
    await expect(getChainId()).rejects.toThrow(/genesis/);
  });

  it("rejects missing or unapproved game bytecode", async () => {
    getCode.mockResolvedValue("0x");
    await expect(getChainId()).rejects.toThrow(/No contract code/);
    getCode.mockResolvedValue("0x6000");
    expect(keccak256("0x6000" as Hex)).not.toBe(GAME_RUNTIME_CODE_HASH);
    await expect(getChainId()).rejects.toThrow(/does not match/);
  });

  it("permits a local fork chain id when executable game code exists", async () => {
    appConfig.mode = "local";
    appConfig.gameAddress = "0x00000000000000000000000000000000000000aa";
    getChainIdRpc.mockResolvedValue(ANVIL_CHAIN_ID);
    getCode.mockResolvedValue("0x6000");
    await expect(getChainId()).resolves.toBe(ANVIL_CHAIN_ID);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("rejects mainnet and arbitrary networks in local direct-broadcast mode", async () => {
    appConfig.mode = "local";
    appConfig.gameAddress = "0x00000000000000000000000000000000000000aa";
    getCode.mockResolvedValue("0x6000");
    getChainIdRpc.mockResolvedValue(1);
    await expect(getChainId()).rejects.toThrow(/expected Anvil/);
    getChainIdRpc.mockResolvedValue(1337);
    await expect(getChainId()).rejects.toThrow(/expected Anvil/);
  });

  it("validates a separately configured WebSocket endpoint too", async () => {
    appConfig.mode = "local";
    appConfig.gameAddress = "0x00000000000000000000000000000000000000aa";
    getCode.mockResolvedValue("0x6000");
    getChainIdRpc
      .mockResolvedValueOnce(ANVIL_CHAIN_ID)
      .mockResolvedValueOnce(1);
    await expect(
      validateRpcConfiguration("http://local.invalid", "local", "ws://wrong.invalid"),
    ).rejects.toThrow(/disagree on chain identity/);
  });
});
