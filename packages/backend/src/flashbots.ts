import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { mainnet } from "viem/chains";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { nonceManager } from "./nonce.js";
import { effectiveTipGwei, resolveGas } from "./logic.js";
import { logger } from "./logger.js";

export interface TxIntent {
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional gas override; estimated if omitted. */
  gas?: bigint;
}

export interface SubmitResult {
  ok: boolean;
  simulated: boolean;
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  nonce: number;
  valueWei: bigint;
  gasWei: bigint;
  error?: string;
}

// --- Flashbots reputation signer (identity only; holds no funds) ---

function reputationSigner(): PrivateKeyAccount {
  const p = path.join(appConfig.dataDir, "flashbots-signer.key");
  let pk: Hex;
  if (fs.existsSync(p)) {
    pk = fs.readFileSync(p, "utf8").trim() as Hex;
  } else {
    pk = generatePrivateKey();
    fs.mkdirSync(appConfig.dataDir, { recursive: true });
    fs.writeFileSync(p, pk, { mode: 0o600 });
    logger.info("Generated a new Flashbots reputation key.");
  }
  return privateKeyToAccount(pk);
}
// Lazily initialized so switching mode from public→mainnet at runtime works.
let _signer: PrivateKeyAccount | null = null;
function getSigner(): PrivateKeyAccount {
  if (!_signer) _signer = reputationSigner();
  return _signer;
}

/** POST a bundle RPC to one builder/relay. `url` defaults to the Flashbots relay
 *  (the only endpoint that implements eth_callBundle for simulation). */
async function flashbotsRpc(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  url: string = appConfig.flashbotsRelayUrl,
): Promise<any> {
  const signer = getSigner();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  // Flashbots requires this reputation signature; other builders accept or ignore it.
  const signature = `${signer.address}:${await signer.signMessage({
    message: keccak256(toHex(body)),
  })}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "X-Flashbots-Signature": signature,
    },
    body,
  });
  const json = (await res.json()) as { error?: { message: string }; result?: any };
  if (json.error) throw new Error(`${method} @${hostOf(url)}: ${json.error.message}`);
  return json.result;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

// --- fee + gas ---

async function computeFees(offense: boolean): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
}> {
  const gas = resolveGas(runtime.strategy, offense);
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 0n;

  // Priority tip: static by default, or scaled up by block fullness when the
  // dynamic-tip edge is enabled (helps win inclusion in contested blocks).
  const tipGwei = effectiveTipGwei(gas, block.gasUsed, block.gasLimit);
  const priority = BigInt(Math.round(tipGwei * 1e9));
  const maxFeePerGas = baseFee * 2n + priority;
  return { maxFeePerGas, maxPriorityFeePerGas: priority, baseFee };
}

async function estimateGas(account: Address, intent: TxIntent): Promise<bigint> {
  if (intent.gas) return intent.gas;
  const est = await publicClient.estimateGas({
    account,
    to: intent.to,
    data: intent.data,
    value: intent.value,
  });
  return (est * 12n) / 10n; // +20% buffer
}

async function signTx(
  account: PrivateKeyAccount,
  intent: TxIntent,
  nonce: number,
  gas: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<Hex> {
  return account.signTransaction({
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: mainnet.id,
    type: "eip1559",
  });
}

/**
 * Build, (optionally simulate), and submit a single tx.
 * - dryRun: builds + simulates, never sends.
 * - mainnet: submits as a Flashbots bundle (block+1, block+2) after eth_callBundle sim.
 * - local: broadcasts the raw tx to the node (anvil).
 */
const RELAY_TIMEOUT_MS = 10_000;
// Bundle submission is time-critical and fans out to several builders: a slow or
// dead endpoint must not hold up the caller (submitTx awaits all attempts, so a
// 10s hang would stall every later token in a boundary race). Healthy builders
// ack in <1s, and one that can't answer before the block is built is useless to us.
const SEND_BUNDLE_TIMEOUT_MS = 3_000;

async function flashbotsRpcWithTimeout(
  method: string,
  params: unknown[],
  url?: string,
  timeoutMs: number = RELAY_TIMEOUT_MS,
): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await flashbotsRpc(method, params, abort.signal, url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Simulate an intent whose validity depends on a FUTURE block timestamp (the
 * pre-boundary races: the epoch hasn't rolled / the audit hasn't expired yet, so a
 * normal sim against "now" would wrongly revert). We re-run the call at `atTime`
 * via eth_call block overrides, which reproduces the exact context the tx will
 * execute in. Returns null when the sim passed, a revert message when the contract
 * rejected it, or throws if the RPC can't do block overrides (caller decides).
 */
async function simulateAtTimestamp(
  from: Address,
  intent: TxIntent,
  gas: bigint,
  atTime: bigint,
): Promise<string | null> {
  try {
    await (publicClient as unknown as {
      request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
    }).request({
      method: "eth_call",
      params: [
        { from, to: intent.to, data: intent.data, value: toHex(intent.value), gas: toHex(gas) },
        "latest",
        {}, // no state overrides — the wallet's real balance applies
        { time: toHex(atTime) }, // block overrides: run at the boundary/expiry instant
      ],
    });
    return null; // simulated clean
  } catch (err) {
    const e = err as { message?: string; data?: unknown; code?: number };
    const msg = e.message ?? String(err);
    // A contract revert => the action is genuinely invalid: report it.
    if (e.data !== undefined || /revert|execution reverted/i.test(msg)) return msg;
    // Anything else (RPC lacks block-override support, transport error) => rethrow
    // so the caller can decide whether to proceed unsimulated.
    throw err;
  }
}

export async function submitTx(
  intent: TxIntent,
  opts: {
    dryRun: boolean;
    race?: boolean;
    offense?: boolean;
    /** Simulate at this future unix-second timestamp (pre-boundary races). */
    simTimestamp?: bigint;
  },
): Promise<SubmitResult> {
  const account = runtime.account;
  if (!account) throw new Error("Wallet locked");

  const { maxFeePerGas, maxPriorityFeePerGas } = await computeFees(opts.offense ?? false);
  const gas = await estimateGas(account.address, intent);
  const gasWei = gas * maxFeePerGas;
  const targetBlock = (await publicClient.getBlockNumber()) + 1n;

  // Nonce is only reserved after simulation passes to avoid burning nonces on reverts.
  const base: SubmitResult = {
    ok: false,
    simulated: false,
    nonce: nonceManager.peek(), // placeholder; updated if we reserve
    valueWei: intent.value,
    gasWei,
  };

  // --- Simulation ---
  if (opts.simTimestamp !== undefined) {
    // Future-timestamp race (pre-boundary pay/audit/kill): validate at the instant
    // the tx will actually execute. Always uses eth_call block overrides against
    // OUR OWN RPC — verified working, and deliberately not the relay's
    // eth_callBundle `timestamp`, so the race doesn't depend on relay behaviour we
    // can't test. Works identically in public and mainnet mode.
    try {
      const revert = await simulateAtTimestamp(account.address, intent, gas, opts.simTimestamp);
      if (revert) return { ...base, simulated: true, error: `sim revert @${opts.simTimestamp}: ${revert}`, targetBlock };
      base.simulated = true;
    } catch (err) {
      logger.warn(`timestamp-override sim unavailable (${(err as Error).message}); sending unsimulated`);
    }
  } else if (appConfig.mode === "mainnet") {
    // Flashbots bundle simulation needs a signed tx — use peeked nonce (not consumed yet).
    const simSigned = await signTx(account, intent, nonceManager.peek(), gas, maxFeePerGas, maxPriorityFeePerGas);
    try {
      const sim = await flashbotsRpcWithTimeout("eth_callBundle", [
        { txs: [simSigned], blockNumber: toHex(targetBlock), stateBlockNumber: "latest" },
      ]);
      const results = sim?.results ?? [];
      const failed = results.find((r: any) => r.error || r.revert);
      if (failed) {
        return { ...base, simulated: true, error: `sim revert: ${failed.error ?? failed.revert}`, targetBlock };
      }
      base.simulated = true;
    } catch (err) {
      // The relay being slow/down must NOT block a payment — that can cost a
      // citizen, and mainnet is the default mode. Fall back to a plain eth_call
      // against our own RPC instead of skipping the tx entirely.
      logger.warn(`relay sim unavailable (${(err as Error).message}); falling back to eth_call`);
      try {
        await publicClient.call({
          account: account.address,
          to: intent.to,
          data: intent.data,
          value: intent.value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        base.simulated = true;
      } catch (e2) {
        return { ...base, simulated: true, error: `sim revert: ${(e2 as Error).message}`, targetBlock };
      }
    }
  } else if (appConfig.mode === "public") {
    // Plain eth_call — no nonce needed, no relay round-trip.
    try {
      await publicClient.call({
        account: account.address,
        to: intent.to,
        data: intent.data,
        value: intent.value,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      base.simulated = true;
    } catch (err) {
      return { ...base, simulated: true, error: `sim revert: ${(err as Error).message}`, targetBlock };
    }
  }

  if (opts.dryRun) {
    return { ...base, ok: true, targetBlock };
  }

  // Simulation passed — now officially consume the nonce and sign for real.
  const nonce = nonceManager.reserve();
  base.nonce = nonce;
  const signed = await signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas);

  // --- Submission ---
  if (appConfig.mode === "local" || appConfig.mode === "public") {
    const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
    return { ...base, ok: true, txHash, targetBlock };
  }

  // mainnet: fan the bundle out to EVERY configured builder for the next two
  // blocks. Only the builder that wins a slot can include us, so submitting to one
  // relay means only winning when that relay's builder wins. All attempts run in
  // parallel; unreachable builders are tolerated — we succeed if ANY accepts.
  const bundleHashes: string[] = [];
  const acceptedBy = new Set<string>();
  const attempts = appConfig.builderUrls.flatMap((url) =>
    [targetBlock, targetBlock + 1n].map(async (blk) => {
      const r = await flashbotsRpcWithTimeout(
        "eth_sendBundle",
        [{ txs: [signed], blockNumber: toHex(blk) }],
        url,
        SEND_BUNDLE_TIMEOUT_MS,
      );
      return { url, bundleHash: r?.bundleHash as string | undefined };
    }),
  );

  // Public-mempool copy (identical tx: same nonce/sig, so only one can ever land
  // and the loser is dropped as a duplicate). Fire it CONCURRENTLY with the
  // bundles — awaiting relay round-trips first would delay the broadcast by
  // 100-200ms+ per builder, which is exactly the margin a boundary race runs on.
  const broadcast: Promise<Hex | undefined> = opts.race
    ? publicClient.sendRawTransaction({ serializedTransaction: signed }).catch((err) => {
        // "nonce too low"/"already known" just means a bundle landed first — not fatal.
        logger.warn("public broadcast failed:", (err as Error).message);
        return undefined;
      })
    : Promise.resolve(undefined);

  const [txHash, settled] = await Promise.all([broadcast, Promise.allSettled(attempts)]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      acceptedBy.add(hostOf(s.value.url));
      if (s.value.bundleHash) bundleHashes.push(s.value.bundleHash);
    } else {
      logger.warn("sendBundle failed:", (s.reason as Error).message);
    }
  }
  if (acceptedBy.size > 0) {
    logger.info(`bundle accepted by ${acceptedBy.size}/${appConfig.builderUrls.length} builders: ${[...acceptedBy].join(", ")}`);
  }

  return {
    ...base,
    ok: bundleHashes.length > 0 || txHash !== undefined,
    bundleHash: bundleHashes[0],
    txHash,
    targetBlock,
    error: bundleHashes.length === 0 && txHash === undefined ? "no bundle accepted" : undefined,
  };
}
