import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import type { StrategyConfig } from "@dat-bot/shared";

const h = vi.hoisted(() => ({
  appConfig: { mode: "mainnet" as "mainnet" | "public" | "local" },
  getBytecode: vi.fn(),
}));

vi.mock("./config.js", () => ({ appConfig: h.appConfig }));
vi.mock("./chain.js", () => ({
  publicClient: { getBytecode: h.getBytecode },
}));

const {
  COINBASE_PAYER_GAS,
  COINBASE_PAYER_RUNTIME_CODE_HASH,
  resolveBuilderIncentive,
  resolveBuilderIncentiveForMode,
} = await import("./builder-incentive.js");

const PAYER = "0x1111111111111111111111111111111111111111";

function config(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    coinbaseBidEnabled: true,
    coinbaseBidEth: "0.015",
    coinbasePayerAddress: PAYER,
    ...overrides,
  } as StrategyConfig;
}

describe("builder incentive capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.appConfig.mode = "mainnet";
  });

  it("is inert before explicit enablement without touching the chain", async () => {
    await expect(resolveBuilderIncentive(config({ coinbaseBidEnabled: false }), 1))
      .resolves.toEqual({ active: false, reason: "Direct builder incentive is disabled" });
    expect(h.getBytecode).not.toHaveBeenCalled();
  });

  it("requires private mainnet mode and a verified chain ID", async () => {
    h.appConfig.mode = "public";
    await expect(resolveBuilderIncentive(config(), 1)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("mainnet private-bundle mode"),
    });
    h.appConfig.mode = "mainnet";
    await expect(resolveBuilderIncentive(config(), null)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("has not been verified"),
    });
    await expect(resolveBuilderIncentive(config(), 31337)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("received 31337"),
    });
    expect(h.getBytecode).not.toHaveBeenCalled();
  });

  it("rejects non-canonical or zero amounts before checking bytecode", async () => {
    await expect(resolveBuilderIncentive(config({ coinbaseBidEth: "0.0150" }), 1))
      .resolves.toMatchObject({ active: false, reason: expect.stringContaining("canonical") });
    await expect(resolveBuilderIncentive(config({ coinbaseBidEth: "0" }), 1))
      .resolves.toMatchObject({ active: false, reason: expect.stringContaining("greater than zero") });
    expect(h.getBytecode).not.toHaveBeenCalled();
  });

  it("activates only for the exact pinned stateless runtime", async () => {
    const manifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../contracts/CoinbasePayer.build.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      runtimeBytecode: Hex;
    };
    h.getBytecode.mockResolvedValue(manifest.runtimeBytecode);

    await expect(resolveBuilderIncentive(config(), 1)).resolves.toEqual({
      active: true,
      payer: PAYER,
      bidWei: 15_000_000_000_000_000n,
      runtimeCodeHash: COINBASE_PAYER_RUNTIME_CODE_HASH,
    });
    expect(COINBASE_PAYER_GAS).toBe(100_000n);
    expect(h.getBytecode).toHaveBeenCalledWith({ address: PAYER });

    const candidateGetBytecode = vi.fn().mockResolvedValue(manifest.runtimeBytecode);
    h.appConfig.mode = "public";
    await expect(resolveBuilderIncentiveForMode(
      config(),
      1,
      "mainnet",
      { getBytecode: candidateGetBytecode } as Parameters<typeof resolveBuilderIncentiveForMode>[3],
    )).resolves.toMatchObject({ active: true, payer: PAYER });
    expect(candidateGetBytecode).toHaveBeenCalledWith({ address: PAYER });
  });

  it("rejects missing, mismatched, and unverifiable bytecode", async () => {
    h.getBytecode.mockResolvedValueOnce(undefined);
    await expect(resolveBuilderIncentive(config(), 1)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("no deployed bytecode"),
    });

    h.getBytecode.mockResolvedValueOnce("0x6000");
    await expect(resolveBuilderIncentive(config(), 1)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("does not match"),
    });

    h.getBytecode.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(resolveBuilderIncentive(config(), 1)).resolves.toMatchObject({
      active: false,
      reason: expect.stringContaining("RPC unavailable"),
    });
  });
});

describe("CoinbasePayer reviewed manifest constants", () => {
  it("pins the source hash, declared compiler settings, expected bytecodes, and runtime hash", () => {
    const contractsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../contracts",
    );
    const source = fs.readFileSync(path.join(contractsDir, "CoinbasePayer.sol"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(contractsDir, "CoinbasePayer.build.json"), "utf8"),
    ) as {
      compiler: string;
      sourceSha256: string;
      settings: {
        evmVersion: string;
        optimizer: { enabled: boolean; runs: number };
        metadata: object;
      };
      creationBytecode: Hex;
      runtimeBytecode: Hex;
      runtimeCodeHash: Hex;
    };

    expect(manifest.compiler).toBe("solcjs 0.8.20+commit.a1b79de6");
    expect(manifest.settings).toEqual({
      evmVersion: "shanghai",
      optimizer: { enabled: true, runs: 200 },
      metadata: { bytecodeHash: "none", appendCBOR: false },
    });
    expect(createHash("sha256").update(source).digest("hex")).toBe(manifest.sourceSha256);
    expect(manifest.creationBytecode).toMatch(/^0x[0-9a-f]+$/);
    expect(manifest.creationBytecode.endsWith(manifest.runtimeBytecode.slice(2))).toBe(true);
    expect(keccak256(manifest.runtimeBytecode)).toBe(manifest.runtimeCodeHash);
    expect(manifest.runtimeCodeHash).toBe(COINBASE_PAYER_RUNTIME_CODE_HASH);
    expect(source.toString()).not.toMatch(/function\s+withdraw|address\s+(public|private|internal)|constructor\s*\(/);
  });
});
