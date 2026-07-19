import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseGwei,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const port = 18_000 + (process.pid % 1_000);
const rpcUrl = `http://127.0.0.1:${port}`;
const chain = {
  id: 31_337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const account = privateKeyToAccount(ANVIL_KEY);
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

let anvil: ChildProcess;
let address: Address;
let abi: Abi;
let transportDataDir: string | null = null;

async function waitForRpc(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await publicClient.getChainId();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--silent", "--port", String(port), "--chain-id", "31337"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForRpc();

  const artifactPath = path.resolve(
    process.cwd(),
    "test/foundry/out/EpochPricedTaxes.sol/EpochPricedTaxes.json",
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  abi = artifact.abi;
  const deployment = await walletClient.deployContract({
    abi,
    bytecode: artifact.bytecode.object,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployment });
  address = receipt.contractAddress!;
});

afterAll(async () => {
  if (anvil && !anvil.killed) anvil.kill("SIGTERM");
  if (transportDataDir) fs.rmSync(transportDataDir, { recursive: true, force: true });
});

describe("epoch-priced payment replacement", () => {
  it("replaces the stale price at the same nonce and includes a prepared nonce-ordered prefix", async () => {
    const startTime = await publicClient.readContract({ address, abi, functionName: "startTime" }) as bigint;
    const boundary = startTime + 86_400n;
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const payOne = encodeFunctionData({ abi, functionName: "payTaxes", args: [1n, 1n] });
    const payTwo = encodeFunctionData({ abi, functionName: "payTaxes", args: [2n, 1n] });

    await publicClient.request({ method: "evm_setAutomine" as never, params: [false] as never });
    await publicClient.request({
      method: "evm_setNextBlockTimestamp" as never,
      params: [Number(boundary)] as never,
    });

    const stale = await account.signTransaction({
      chainId: chain.id,
      to: address,
      data: payOne,
      value: 690_000_000_000_000n,
      gas: 100_000n,
      nonce,
      maxFeePerGas: parseGwei("3"),
      maxPriorityFeePerGas: parseGwei("1"),
      type: "eip1559",
    });
    const replacement = await account.signTransaction({
      chainId: chain.id,
      to: address,
      data: payOne,
      value: 1_380_000_000_000_000n,
      gas: 100_000n,
      nonce,
      maxFeePerGas: parseGwei("6"),
      maxPriorityFeePerGas: parseGwei("2"),
      type: "eip1559",
    });
    const second = await account.signTransaction({
      chainId: chain.id,
      to: address,
      data: payTwo,
      value: 1_380_000_000_000_000n,
      gas: 100_000n,
      nonce: nonce + 1,
      maxFeePerGas: parseGwei("6"),
      maxPriorityFeePerGas: parseGwei("2"),
      type: "eip1559",
    });

    await publicClient.sendRawTransaction({ serializedTransaction: stale });
    await publicClient.sendRawTransaction({ serializedTransaction: replacement });
    await publicClient.sendRawTransaction({ serializedTransaction: second });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });

    const replacementReceipt = await publicClient.getTransactionReceipt({ hash: keccak256(replacement) });
    const secondReceipt = await publicClient.getTransactionReceipt({ hash: keccak256(second) });
    expect(replacementReceipt.status).toBe("success");
    expect(secondReceipt.status).toBe("success");
    expect(replacementReceipt.transactionIndex).toBeLessThan(secondReceipt.transactionIndex);
    await expect(publicClient.getTransactionReceipt({ hash: keccak256(stale) })).rejects.toThrow();
    expect(await publicClient.readContract({ address, abi, functionName: "currentEpoch" })).toBe(2n);
    expect(await publicClient.readContract({ address, abi, functionName: "lastEpochPaid", args: [1n] })).toBe(1n);
    expect(await publicClient.readContract({ address, abi, functionName: "lastEpochPaid", args: [2n] })).toBe(1n);
  });

  it("delivers through the production local transport with the Anvil chain ID and reconciles its WAL", async () => {
    await publicClient.request({ method: "evm_setAutomine" as never, params: [true] as never });
    transportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-anvil-transport-"));
    process.env.MODE = "local";
    process.env.RPC_HTTP_URL = rpcUrl;
    process.env.DATA_DIR = transportDataDir;
    process.env.GAME_ADDRESS = address;

    // Import only after the isolated local environment is installed: config,
    // runtime, the nonce recovery hook, and the WAL are module singletons.
    const [{ runtime }, { nonceManager }, transport, { reinitClients }] = await Promise.all([
      import("./runtime.js"),
      import("./nonce.js"),
      import("./flashbots.js"),
      import("./chain.js"),
    ]);
    runtime.account = account;
    runtime.chainId = chain.id;
    await nonceManager.sync(account.address, "local");

    const epoch = await publicClient.readContract({ address, abi, functionName: "currentEpoch" }) as bigint;
    const data = encodeFunctionData({ abi, functionName: "payTaxes", args: [3n, 1n] });
    transport.beginBundle();
    const prepared = await transport.submitTx(
      {
        to: address,
        data,
        value: epoch * 690_000_000_000_000n,
        gas: 100_000n,
      },
      {
        dryRun: false,
        race: true,
        authorize: async () => ({ ok: true, stillValid: () => true }),
      },
    );
    expect(prepared).toMatchObject({ ok: true, queued: true });

    const delivered = (await transport.flushBundle()).get(prepared.nonce);
    expect(delivered).toMatchObject({ ok: true, txHash: prepared.txHash });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: prepared.txHash! });
    expect(receipt.status).toBe("success");
    expect(await publicClient.readContract({ address, abi, functionName: "lastEpochPaid", args: [3n] })).toBe(1n);

    const journalPath = path.join(
      transportDataDir,
      "submission-flights",
      `${account.address.toLowerCase()}.json`,
    );
    expect(fs.existsSync(journalPath)).toBe(true);
    const document = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      flights: Array<{ nonce: number; state: string; publicExposure: boolean }>;
    };
    expect(document.flights).toHaveLength(1);
    expect(document.flights[0]).toMatchObject({
      nonce: prepared.nonce,
      state: "accepted",
      publicExposure: true,
    });
    // Replace the client to bypass viem's short block-number cache and emulate
    // the next ordinary reconciliation cycle without a multi-second test sleep.
    reinitClients(rpcUrl, null);
    const reconciliation = await transport.reconcileSubmissionJournal(account.address);
    expect(reconciliation.confirmedNonce).toBe(prepared.nonce + 1);
    expect(reconciliation.expired).toHaveLength(0);
    expect(reconciliation.consumed.map((flight) => flight.txHash)).toContain(prepared.txHash);
    expect(reconciliation.retained).toHaveLength(0);
    nonceManager.reset();
    runtime.lock();
  });
});
