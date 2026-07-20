import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as Address;
const account = privateKeyToAccount(ANVIL_KEY);

function createAnvilChain(rpcUrl: string) {
  return {
    id: 31_337,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
}

function createAnvilClients(rpcUrl: string) {
  const chain = createAnvilChain(rpcUrl);
  return {
    chain,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  };
}

type AnvilClients = ReturnType<typeof createAnvilClients>;

type AnvilHandle = {
  child: ChildProcess;
  closed: Promise<void>;
  output: { stdout: string; stderr: string };
};

let rpcUrl: string;
let chain: AnvilClients["chain"];
let publicClient: AnvilClients["publicClient"];
let walletClient: AnvilClients["walletClient"];
let anvil: AnvilHandle | null = null;
let address: Address;
let abi: Abi;
let transportDataDir: string | null = null;

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.unref();

  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const allocated = server.address();
      if (!allocated || typeof allocated === "string") {
        server.close();
        reject(new Error("Could not determine the allocated Anvil port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(allocated.port);
      });
    });
  });
}

function retainOutput(previous: string, chunk: unknown): string {
  const next = previous + String(chunk);
  return next.length > 16_384 ? next.slice(-16_384) : next;
}

function anvilDiagnostics(handle: AnvilHandle): string {
  const stderr = handle.output.stderr.trim();
  const stdout = handle.output.stdout.trim();
  return [
    stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
    stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
  ].join("\n");
}

function spawnAnvil(port: number): AnvilHandle {
  const child = spawn("anvil", [
    "--silent",
    "--port",
    String(port),
    "--chain-id",
    "31337",
    // Production clients use mainnet's canonical Multicall3 metadata, whose
    // deployment block is 14,353,601. Start beyond it so explicit historical
    // block reads exercise the same path instead of failing viem's chain guard.
    "--number",
    "14353601",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    output.stdout = retainOutput(output.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr = retainOutput(output.stderr, chunk);
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  return { child, closed, output };
}

async function pollRpc(): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
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

async function waitForRpc(handle: AnvilHandle): Promise<void> {
  let processFailed = false;
  let onError!: (error: Error) => void;
  let onExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  const earlyFailure = new Promise<never>((_resolve, reject) => {
    onError = (error) => {
      processFailed = true;
      reject(new Error(`Anvil failed to spawn: ${error.message}`));
    };
    onExit = (code, signal) => {
      processFailed = true;
      reject(new Error(
        `Anvil exited before RPC became ready (code=${String(code)}, signal=${String(signal)})`,
      ));
    };
    handle.child.once("error", onError);
    handle.child.once("exit", onExit);
  });

  try {
    await Promise.race([pollRpc(), earlyFailure]);
  } catch (error) {
    // Let the stdio streams drain so an early bind/spawn error includes Anvil's
    // own explanation instead of only the child-process exit code.
    if (processFailed) {
      await Promise.race([
        handle.closed,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${anvilDiagnostics(handle)}`);
  } finally {
    handle.child.off("error", onError);
    handle.child.off("exit", onExit);
  }
}

async function stopAnvil(handle: AnvilHandle): Promise<void> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGTERM");
  }
  const graceful = await Promise.race([
    handle.closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (graceful) return;

  handle.child.kill("SIGKILL");
  const forced = await Promise.race([
    handle.closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!forced) {
    throw new Error(`Anvil did not exit after SIGKILL\n${anvilDiagnostics(handle)}`);
  }
}

beforeAll(async () => {
  const port = await allocateLoopbackPort();
  rpcUrl = `http://127.0.0.1:${port}`;
  ({ chain, publicClient, walletClient } = createAnvilClients(rpcUrl));
  anvil = spawnAnvil(port);
  try {
    await waitForRpc(anvil);
  } catch (error) {
    await stopAnvil(anvil);
    anvil = null;
    throw error;
  }

  const artifactDirectory = path.resolve(
    process.cwd(),
    "test/foundry/out/EpochPricedTaxes.sol",
  );
  const multicallArtifact = JSON.parse(
    fs.readFileSync(path.join(artifactDirectory, "MockMulticall3.json"), "utf8"),
  ) as { deployedBytecode: { object: Hex } };
  await publicClient.request({
    method: "anvil_setCode" as never,
    params: [MULTICALL3_ADDRESS, multicallArtifact.deployedBytecode.object] as never,
  });

  const artifact = JSON.parse(
    fs.readFileSync(path.join(artifactDirectory, "EpochPricedTaxes.json"), "utf8"),
  ) as {
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

  transportDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-anvil-transport-"));
  process.env.MODE = "local";
  process.env.RPC_HTTP_URL = rpcUrl;
  process.env.DATA_DIR = transportDataDir;
  process.env.GAME_ADDRESS = address;
  process.env.OWNED_TOKENS = "1,2";
}, 30_000);

afterAll(async () => {
  try {
    if (anvil) await stopAnvil(anvil);
  } finally {
    if (transportDataDir) fs.rmSync(transportDataDir, { recursive: true, force: true });
  }
}, 15_000);

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
      transportDataDir!,
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

  it("runs API configuration through the production engine for two owned Citizens and reconciles both", async () => {
    // Establish the exact delinquency baseline instead of relying on payments
    // made by another test in this file.
    for (const tokenId of [1n, 2n, 3n]) {
      const hash = await walletClient.writeContract({
        address,
        abi,
        functionName: "setLastEpochPaidForTest",
        args: [tokenId, 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    const startTime = await publicClient.readContract({ address, abi, functionName: "startTime" }) as bigint;
    const thirdEpoch = startTime + 2n * 86_400n;
    await publicClient.request({
      method: "evm_setNextBlockTimestamp" as never,
      params: [Number(thirdEpoch)] as never,
    });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });

    const [api, runtimeModule, transport, chainModule, strategy] = await Promise.all([
      import("./api.js"),
      import("./runtime.js"),
      import("./flashbots.js"),
      import("./chain.js"),
      import("./strategy.js"),
    ]);
    const { runtime } = runtimeModule;
    chainModule.reinitClients(rpcUrl, null);
    const app = await api.buildServer();

    try {
      const keystore = await app.inject({
        method: "POST",
        url: "/api/keystore",
        payload: {
          mode: "import",
          privateKey: ANVIL_KEY,
          passphrase: "disposable-anvil-wallet",
        },
      });
      expect(keystore.statusCode).toBe(200);
      expect(keystore.json()).toMatchObject({ address: account.address });

      const unlock = await app.inject({
        method: "POST",
        url: "/api/unlock",
        payload: { passphrase: "disposable-anvil-wallet" },
      });
      expect(unlock.statusCode).toBe(200);
      expect(unlock.json()).toMatchObject({ unlocked: true, running: false });

      const currentConfig = await app.inject({ method: "GET", url: "/api/config" });
      expect(currentConfig.statusCode).toBe(200);
      const revision = (currentConfig.json() as { revision: number }).revision;
      const configured = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: {
          expectedRevision: revision,
          patch: {
            defenseEnabled: true,
            proactivePay: true,
            preBoundaryPay: false,
            dryRun: false,
            minBalanceEth: 0,
            maxBaseFeeGwei: 1_000,
            priorityFeeGwei: 1,
            dynamicTipEnabled: false,
          },
        },
      });
      expect(configured.statusCode).toBe(200);

      const started = await app.inject({ method: "POST", url: "/api/start" });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ unlocked: true, running: true, dryRun: false });

      const deadline = Date.now() + 15_000;
      let paidOne = 0n;
      let paidTwo = 0n;
      while (Date.now() < deadline) {
        [paidOne, paidTwo] = await Promise.all([
          publicClient.readContract({ address, abi, functionName: "lastEpochPaid", args: [1n] }) as Promise<bigint>,
          publicClient.readContract({ address, abi, functionName: "lastEpochPaid", args: [2n] }) as Promise<bigint>,
        ]);
        if (paidOne === 2n && paidTwo === 2n) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect([paidOne, paidTwo]).toEqual([2n, 2n]);

      const stopped = await app.inject({ method: "POST", url: "/api/stop" });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toMatchObject({ running: false });

      // Recreate the client to bypass the short block cache, then prove both
      // engine-created transactions are terminal in the durable wallet journal.
      chainModule.reinitClients(rpcUrl, null);
      const reconciliation = await transport.reconcileSubmissionJournal(account.address);
      expect(reconciliation.retained).toHaveLength(0);
      expect(reconciliation.consumed).toHaveLength(2);
      expect(reconciliation.consumed.map((flight) => flight.nonce)).toEqual([
        reconciliation.confirmedNonce - 2,
        reconciliation.confirmedNonce - 1,
      ]);

      // Recreate the WAL-before-dispatch crash window, switch to dry-run through
      // the API, and prove Start retains the signed flight without broadcasting
      // it. This is the live-funds regression that prompted the recovery fix.
      const dryRunNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      const dryRunData = encodeFunctionData({
        abi,
        functionName: "payTaxes",
        args: [3n, 1],
      });
      const dryRunRaw = await account.signTransaction({
        chainId: chain.id,
        to: address,
        data: dryRunData,
        value: 3n * 690_000_000_000_000n,
        gas: 100_000n,
        nonce: dryRunNonce,
        maxFeePerGas: parseGwei("3"),
        maxPriorityFeePerGas: parseGwei("1"),
        type: "eip1559",
      });
      const dryRunHash = keccak256(dryRunRaw);
      const { SubmissionFlightJournal } = await import("./submission-journal.js");
      const recoveryJournal = new SubmissionFlightJournal(transportDataDir!);
      const recordedAt = Date.now();
      recoveryJournal.upsert({
        wallet: account.address,
        nonce: dryRunNonce,
        rawSignedTx: dryRunRaw,
        txHash: dryRunHash,
        obligation: {
          to: address,
          data: dryRunData,
          valueWei: (3n * 690_000_000_000_000n).toString(),
          gasLimit: "100000",
          maxFeePerGas: parseGwei("3").toString(),
          maxPriorityFeePerGas: parseGwei("1").toString(),
        },
        lineage: { id: `payment:3:${dryRunNonce}` },
        recovery: { publicAuthorized: true },
        state: "prepared",
        publicExposure: false,
        nonceConflict: false,
        attempts: [],
        createdAtMs: recordedAt,
        updatedAtMs: recordedAt,
      });

      const liveConfig = await app.inject({ method: "GET", url: "/api/config" });
      const liveRevision = (liveConfig.json() as { revision: number }).revision;
      const enabledDryRun = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { expectedRevision: liveRevision, patch: { dryRun: true } },
      });
      expect(enabledDryRun.statusCode).toBe(200);

      const dryStarted = await app.inject({ method: "POST", url: "/api/start" });
      expect(dryStarted.statusCode).toBe(200);
      expect(dryStarted.json()).toMatchObject({ running: true, dryRun: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      })).toBe(dryRunNonce);
      expect(await publicClient.readContract({
        address,
        abi,
        functionName: "lastEpochPaid",
        args: [3n],
      })).toBe(1n);
      expect(recoveryJournal.load(account.address)).toEqual([
        expect.objectContaining({ txHash: dryRunHash, state: "prepared" }),
      ]);

      const dryStopped = await app.inject({ method: "POST", url: "/api/stop" });
      expect(dryStopped.statusCode).toBe(200);
    } finally {
      strategy.stopEngine();
      await strategy.waitForEngineIdle();
      runtime.lock();
      await app.close();
    }
  }, 30_000);
});
