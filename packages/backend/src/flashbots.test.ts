import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const PAYER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

vi.mock("./config.js", () => ({
  appConfig: {
    mode: "mainnet",
    dataDir: "C:/dat-bot-test-scratch-nonexistent",
    flashbotsRelayUrl: "https://relay.invalid",
    builderUrls: [],
  },
}));

vi.mock("./chain.js", () => ({
  ANVIL_CHAIN_ID: 31337,
  publicClient: {
    getCode: vi.fn(async () => "0x6001"),
    getBlockNumber: vi.fn(async () => 100n),
    estimateGas: vi.fn(async () => 21_000n),
    call: vi.fn(async () => ({})),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: string }) =>
      serializedTransaction === "0x01" ? "0xa1" : "0xb2"),
  },
  getLatestBlockCached: vi.fn(async () => ({
    number: 100n,
    baseFeePerGas: 10_000_000_000n,
    gasUsed: 30_000_000n,
    gasLimit: 30_000_000n,
  })),
}));

const reserve = vi.fn(() => 0);
const markEligibleThrough = vi.fn();
vi.mock("./nonce.js", () => ({
  nonces: { for: vi.fn(() => ({ peek: vi.fn(() => 0), reserve, markEligibleThrough })) },
}));

vi.mock("./logic.js", () => ({
  resolveGas: vi.fn(() => ({
    maxBaseFeeGwei: 1000,
    priorityFeeGwei: 2,
    dynamicTipEnabled: true,
    dynamicTipMaxGwei: 100,
  })),
  effectiveTipGwei: vi.fn(() => 100),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./runtime.js", () => ({
  runtime: {
    chainId: 1,
    strategy: {},
    primary: null,
  },
}));

const { appConfig } = await import("./config.js");
const { publicClient } = await import("./chain.js");
const { runtime } = await import("./runtime.js");
const { beginBundle, flushBundle, queueCoinbaseBid, submitTx } = await import("./flashbots.js");
const allowSpend = () => ({ ok: true });

const account = (address: `0x${string}`, signed: `0x${string}`) => ({
  address,
  signTransaction: vi.fn(async () => signed),
});

beforeEach(() => {
  (appConfig as { mode: string }).mode = "mainnet";
  (runtime as { chainId: number | null }).chainId = 1;
});

describe("exact pre-sign spend authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserve.mockReturnValue(0);
    vi.mocked(publicClient.sendRawTransaction).mockImplementation(async ({ serializedTransaction }) =>
      serializedTransaction === "0x01" ? "0xa1" : "0xb2");
    (appConfig as { mode: string }).mode = "mainnet";
    (runtime as { chainId: number | null }).chainId = 1;
  });

  it("uses the actual signer, gas limit, and dynamic max fee before reserving a nonce", async () => {
    beginBundle();
    const signer = account(ACCOUNT_B, "0x02");
    const authorize = vi.fn(() => ({ ok: false, reason: "secondary wallet floor" }));

    const result = await submitTx(
      { to: PAYER, data: "0x", value: 1_000n, gas: 100_000n },
      { account: signer as never, skipSim: true, authorizeSpend: authorize },
    );

    expect(result.ok).toBe(false);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT_B,
      gas: 100_000n,
      maxFeePerGas: 120_000_000_000n,
      gasWei: 12_000_000_000_000_000n,
      valueWei: 1_000n,
    }));
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("evaluates exact affordability at the final pre-sign decision point", async () => {
    beginBundle();
    const signer = account(ACCOUNT_B, "0x02");
    const authorize = vi.fn(() => ({ ok: false, reason: "headroom changed during simulation" }));

    const result = await submitTx(
      { to: PAYER, data: "0x", value: 1_000n, gas: 100_000n },
      { account: signer as never, skipSim: true, authorizeSpend: authorize },
    );

    expect(result).toMatchObject({ ok: false, error: "headroom changed during simulation" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when a caller omits the authoritative guard", async () => {
    beginBundle();
    const signer = account(ACCOUNT_B, "0x02");
    const result = await submitTx(
      { to: PAYER, data: "0x", value: 1_000n, gas: 100_000n },
      { account: signer as never, skipSim: true } as never,
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/requires.*authorization/i) });
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("sends no signature to a relay when durable nonce reservation refuses", async () => {
    const signer = account(ACCOUNT_B, "0x02");
    reserve.mockImplementationOnce(() => { throw new Error("Previous private nonce sequence is still unresolved"); });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(submitTx(
        { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
        { account: signer as never, authorizeSpend: allowSpend },
      )).rejects.toThrow(/previous private nonce sequence/i);
      expect(signer.signTransaction).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses to sign local-mode transactions unless the verified chain is Anvil", async () => {
    (appConfig as { mode: string }).mode = "local";
    (runtime as { chainId: number | null }).chainId = 1;
    const signer = account(ACCOUNT_B, "0x02");

    await expect(submitTx(
      { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
      { account: signer as never, skipSim: true, authorizeSpend: allowSpend },
    )).rejects.toThrow(/expected Anvil chain 31337/);
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("tracks the deterministic hash when sendRawTransaction errors after possible acceptance", async () => {
    (appConfig as { mode: string }).mode = "public";
    const signer = account(ACCOUNT_B, "0x02");
    vi.mocked(publicClient.sendRawTransaction).mockRejectedValueOnce(new Error("socket closed"));

    const result = await submitTx(
      { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
      { account: signer as never, skipSim: true, authorizeSpend: allowSpend },
    );

    expect(result).toMatchObject({
      ok: true,
      state: "relayed",
      txHash: keccak256("0x02"),
    });
  });

  it("keeps an ambiguous unbatched mainnet mirror live when every relay fails", async () => {
    // Earlier tests intentionally leave a batch open; overwrite/drain it so this covers
    // the standalone submission branch.
    beginBundle();
    await flushBundle();
    const signer = account(ACCOUNT_B, "0x02");
    vi.mocked(publicClient.sendRawTransaction).mockRejectedValueOnce(new Error("response lost"));

    const result = await submitTx(
      { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
      { account: signer as never, skipSim: true, race: true, authorizeSpend: allowSpend },
    );

    expect(result).toMatchObject({
      ok: true,
      state: "relayed",
      txHash: keccak256("0x02"),
      predictedTxHash: keccak256("0x02"),
    });
  });
});

describe("CoinbasePayer validation and affordability", () => {
  const signer = account(ACCOUNT_A, "0x01");
  const code = "0x6001" as const;
  const approved = [keccak256(code)];

  beforeEach(() => {
    vi.clearAllMocks();
    (runtime as { primary: unknown }).primary = { account: signer };
    (runtime as { chainId: number | null }).chainId = 1;
    vi.mocked(publicClient.getCode).mockResolvedValue(code);
    beginBundle();
  });

  it("rejects an EOA before signing or reserving a nonce", async () => {
    vi.mocked(publicClient.getCode).mockResolvedValue("0x");
    expect(await queueCoinbaseBid(PAYER, 1_000n, { approvedCodeHashes: approved, authorizeSpend: allowSpend })).toBe(false);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects deployed code whose runtime hash is not explicitly approved", async () => {
    expect(await queueCoinbaseBid(PAYER, 1_000n, {
      approvedCodeHashes: [keccak256("0x6002")],
      authorizeSpend: allowSpend,
    })).toBe(false);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when no approved runtime hash is configured", async () => {
    expect(await queueCoinbaseBid(PAYER, 1_000n, {
      approvedCodeHashes: [],
      authorizeSpend: allowSpend,
    })).toBe(false);
    expect(publicClient.getCode).not.toHaveBeenCalled();
  });

  it("fails closed when the exact-spend guard is omitted", async () => {
    expect(await queueCoinbaseBid(PAYER, 1_000n, {
      approvedCodeHashes: approved,
    } as never)).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("includes bid value and its signed gas in the payer-specific guard", async () => {
    const authorize = vi.fn(() => ({ ok: false, reason: "unaffordable bid" }));
    expect(await queueCoinbaseBid(PAYER, 5_000n, {
      approvedCodeHashes: approved,
      authorizeSpend: authorize,
    })).toBe(false);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT_A,
      valueWei: 5_000n,
      gas: 60_000n,
      gasWei: 7_200_000_000_000_000n,
    }));
    expect(reserve).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
});

describe("batched results remain unique across wallets with the same nonce", () => {
  it("keys flush results by signed transaction hash instead of nonce", async () => {
    beginBundle();
    const a = account(ACCOUNT_A, "0x01");
    const b = account(ACCOUNT_B, "0x02");
    await submitTx(
      { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
      { account: a as never, skipSim: true, race: true, authorizeSpend: allowSpend },
    );
    await submitTx(
      { to: PAYER, data: "0x", value: 0n, gas: 21_000n },
      { account: b as never, skipSim: true, race: true, authorizeSpend: allowSpend },
    );

    const results = await flushBundle();
    expect(markEligibleThrough).toHaveBeenCalledWith(102n);
    expect(results.size).toBe(2);
    expect(results.get(keccak256("0x01"))).toMatchObject({ state: "relayed", txHash: "0xa1" });
    expect(results.get(keccak256("0x02"))).toMatchObject({ state: "relayed", txHash: "0xb2" });
  });
});
