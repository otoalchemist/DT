import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex, formatEther, type Address, type Block, type Hex } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { mainnet } from "viem/chains";
import { publicClient, getLatestBlockCached } from "./chain.js";
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
  /** mainnet only: the tx was prepared + queued into an open bundle batch rather
   *  than sent immediately. txHash/bundleHash are filled in later by flushBundle. */
  queued?: boolean;
  /** keccak256 of the signed tx — the hash it will have if it lands. Known even for a
   *  bundle-only tx that was never broadcast, so its receipt can still be polled. */
  predictedTxHash?: Hex;
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

// Pure — takes an already-fetched block so the caller can share one read across
// the fee calc, the gas estimate, and the target-block derivation.
/**
 * "Normal" network gas, read at submit time — the node's own suggested priority fee
 * rather than any of the configured race/offense tips. Used by manual, user-initiated
 * actions (pay-to-current / use-bribe from the dashboard), which aren't racing anyone
 * and shouldn't inherit boundary-race pricing. Falls back to 1 gwei if the node has
 * no suggestion.
 */
async function normalFees(block: Block): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
}> {
  const baseFee = block.baseFeePerGas ?? 0n;
  let priority: bigint;
  try {
    priority = await publicClient.estimateMaxPriorityFeePerGas();
  } catch {
    priority = 1_000_000_000n; // 1 gwei
  }
  return { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority, baseFee };
}

function computeFees(offense: boolean, block: Block): {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
} {
  const gas = resolveGas(runtime.strategy, offense);
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
 * Build, simulate, and submit a single tx.
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

// --- Bundle batching (mainnet only) ---
// Every Citizen you hold is owned by the same wallet, so multiple payments/audits
// in one tick share a single nonce sequence. Sent as independent single-tx
// bundles, only the first (nonce == chain nonce) is a self-valid bundle; the rest
// carry a nonce gap and won't be placed top-of-block by builders (bundle merging
// across independent bundles is best-effort). Collecting a tick's txs into ONE
// atomic multi-tx bundle keeps the nonces valid in order and wins top-of-block
// for ALL of them together — exactly what's needed to out-order a batch-auditor
// hitting several of your citizens at once. Only meaningful in mainnet mode;
// public/local always send immediately.
interface QueuedTx {
  signed: Hex;
  nonce: number;
  race: boolean;
  /** Allowed to revert without invalidating the bundle (eth_sendBundle
   *  revertingTxHashes). Used for the coinbase bid so a misconfigured payer can
   *  never drop the payment from the bundle. */
  revertible?: boolean;
}
let bundleQueue: QueuedTx[] | null = null;

/** Open a batching window: subsequent mainnet submitTx calls queue their signed
 *  tx instead of sending, until flushBundle() emits them as one bundle. */
export function beginBundle(): void {
  bundleQueue = [];
}

export interface BundleTxResult {
  ok: boolean;
  txHash?: Hex;
  bundleHash?: string;
  error?: string;
  /**
   * The hash this tx WILL have if it lands — keccak256 of the signed tx, so it's known
   * without broadcasting. Set for every queued tx, including bundle-only ones that are
   * never mirrored to the mempool (a revertible audit riding a payment bundle).
   *
   * Those have no `txHash` because nothing was broadcast, which used to mean no receipt
   * could be polled and the activity entry sat on "submitted" forever even after the
   * bundle landed. Polling this hash resolves them.
   */
  predictedTxHash?: Hex;
}

/**
 * Send everything queued since beginBundle() as a single atomic multi-tx bundle
 * (txs in ascending-nonce order) per target block, mirroring each race-flagged tx
 * to the public mempool as a fallback. Returns a per-nonce result map so the
 * caller can fill in each activity entry's hashes and start receipt tracking.
 * Always closes the batching window, even on error.
 */
export async function flushBundle(): Promise<Map<number, BundleTxResult>> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<number, BundleTxResult>();
  if (!queue || queue.length === 0) return out;

  // A bundle executes its txs in the given order, so nonces must ascend.
  queue.sort((a, b) => a.nonce - b.nonce);
  const signedList = queue.map((q) => q.signed);
  // Txs allowed to revert without invalidating the bundle (audits riding a payment
  // bundle, and the coinbase bid), so a defended target or misconfigured payer can
  // never drop a mandatory payment. A tx hash is keccak(signed tx).
  const revertingTxHashes = queue.filter((q) => q.revertible).map((q) => keccak256(q.signed));
  const targetBlock = (await publicClient.getBlockNumber()) + 1n;

  // One multi-tx bundle, fanned out to every builder for the next two blocks.
  const acceptedBy = new Set<string>();
  const bundleHashes: string[] = [];
  const attempts = appConfig.builderUrls.flatMap((url) =>
    [targetBlock, targetBlock + 1n].map(async (blk) => {
      const params: Record<string, unknown> = { txs: signedList, blockNumber: toHex(blk) };
      if (revertingTxHashes.length > 0) params.revertingTxHashes = revertingTxHashes;
      const r = await flashbotsRpcWithTimeout("eth_sendBundle", [params], url, SEND_BUNDLE_TIMEOUT_MS);
      return { url, bundleHash: r?.bundleHash as string | undefined };
    }),
  );

  // Public-mempool mirror per race-flagged tx (identical tx: same nonce/sig, so
  // only one copy of each can ever land). Fired concurrently with the bundle.
  const broadcasts = queue.map((q) =>
    q.race
      ? publicClient
          .sendRawTransaction({ serializedTransaction: q.signed })
          .then((h) => ({ nonce: q.nonce, txHash: h as Hex | undefined }))
          .catch((err) => {
            logger.warn(`public broadcast (nonce ${q.nonce}) failed:`, (err as Error).message);
            return { nonce: q.nonce, txHash: undefined as Hex | undefined };
          })
      : Promise.resolve({ nonce: q.nonce, txHash: undefined as Hex | undefined }),
  );

  const [settled, mirrors] = await Promise.all([
    Promise.allSettled(attempts),
    Promise.all(broadcasts),
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      acceptedBy.add(hostOf(s.value.url));
      if (s.value.bundleHash) bundleHashes.push(s.value.bundleHash);
    } else {
      logger.warn("sendBundle failed:", (s.reason as Error).message);
    }
  }
  const bundleHash = bundleHashes[0];
  const bundleOk = bundleHashes.length > 0;
  if (acceptedBy.size > 0) {
    logger.info(
      `batched bundle (${queue.length} tx) accepted by ${acceptedBy.size}/${appConfig.builderUrls.length} builders: ${[...acceptedBy].join(", ")}`,
    );
  }

  const txHashByNonce = new Map(mirrors.map((m) => [m.nonce, m.txHash]));
  for (const q of queue) {
    const txHash = txHashByNonce.get(q.nonce);
    out.set(q.nonce, {
      ok: bundleOk || txHash !== undefined,
      txHash,
      // Known for every tx whether or not it was broadcast — see BundleTxResult.
      predictedTxHash: keccak256(q.signed),
      bundleHash,
      error: !bundleOk && txHash === undefined ? "no bundle accepted" : undefined,
    });
  }
  return out;
}

// Enough gas for CoinbasePayer.receive(): one CALL forwarding value to coinbase.
const COINBASE_BID_GAS = 60_000n;

/**
 * Queue a bundle-only tx that forwards `bidWei` ETH to the block's builder, to bid
 * for top-of-block placement with a FLAT payment (independent of gas — unlike a
 * priority tip). It sends the ETH to the user-deployed CoinbasePayer `payer`, whose
 * receive() forwards it to `block.coinbase`, so it lands with whichever builder
 * wins the slot. Queued into the CURRENT open bundle (mainnet only), placed after
 * the payments, marked allowed-to-revert (a misconfigured payer can never drop a
 * payment), and never mirrored to the mempool (coinbase is only meaningful in the
 * winning block). Returns whether it queued.
 */
export async function queueCoinbaseBid(payer: Address, bidWei: bigint): Promise<boolean> {
  if (bundleQueue === null || appConfig.mode !== "mainnet" || bidWei <= 0n) return false;
  const account = runtime.account;
  if (!account) return false;
  try {
    const latest = await getLatestBlockCached();
    const { maxFeePerGas, maxPriorityFeePerGas } = computeFees(false, latest);
    const nonce = nonceManager.reserve();
    const signed = await signTx(
      account,
      { to: payer, data: "0x", value: bidWei },
      nonce,
      COINBASE_BID_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    );
    bundleQueue.push({ signed, nonce, race: false, revertible: true });
    logger.info(`coinbase bid queued: ${formatEther(bidWei)} ETH to builder via ${payer.slice(0, 10)}… (nonce ${nonce})`);
    return true;
  } catch (err) {
    logger.warn(`coinbase bid failed to queue: ${(err as Error).message}`);
    return false;
  }
}

export async function submitTx(
  intent: TxIntent,
  opts: {
    race?: boolean;
    offense?: boolean;
    /** Simulate at this future unix-second timestamp (pre-boundary races). */
    simTimestamp?: bigint;
    /** Skip simulation entirely. Only for a tx whose validity depends on ANOTHER tx
     *  earlier in the same bundle (an audit from a token paid by that same bundle):
     *  every sim runs it standalone against pre-bundle state and would wrongly
     *  reject it. Such a tx must also be `revertible` so it can never invalidate
     *  the bundle. */
    skipSim?: boolean;
    /** Mark this tx allowed-to-revert in the bundle (revertingTxHashes) so it can
     *  never invalidate the bundle / drop a mandatory tx. Used for audits riding a
     *  payment bundle in combined mode. */
    revertible?: boolean;
    /** Price with the node's current suggested fee instead of the configured
     *  race/offense tips. For manual, user-initiated actions (see normalFees). */
    normalGas?: boolean;
  },
): Promise<SubmitResult> {
  const account = runtime.account;
  if (!account) throw new Error("Wallet locked");

  // Independent pre-submission reads — run together (viem batches them, and the
  // block is usually already cached from the pass's canSpend), instead of three
  // serial round-trips per tx. Pre-boundary races pass explicit gas, so estimateGas
  // is instant there and this whole block costs zero extra round-trips.
  const [gas, latest] = await Promise.all([
    estimateGas(account.address, intent),
    getLatestBlockCached(),
  ]);
  const { maxFeePerGas, maxPriorityFeePerGas } = opts.normalGas
    ? await normalFees(latest)
    : computeFees(opts.offense ?? false, latest);
  const gasWei = gas * maxFeePerGas;
  // Reuse the block's own number instead of a separate getBlockNumber round-trip.
  // Only used for sim context + reporting here; the actual bundle target block is
  // re-derived fresh at flush time (see flushBundle).
  const targetBlock = (latest.number ?? (await publicClient.getBlockNumber())) + 1n;

  // Nonce is only reserved after simulation passes to avoid burning nonces on reverts.
  const base: SubmitResult = {
    ok: false,
    simulated: false,
    nonce: nonceManager.peek(), // placeholder; updated if we reserve
    valueWei: intent.value,
    gasWei,
  };

  // --- Simulation ---
  if (opts.skipSim) {
    // Depends on an earlier tx in this bundle; any standalone sim would misjudge it.
    logger.info("skipping simulation: tx depends on an earlier tx in the same bundle");
  } else if (opts.simTimestamp !== undefined) {
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

  // Simulation passed — now officially consume the nonce and sign for real.
  const nonce = nonceManager.reserve();
  base.nonce = nonce;
  const signed = await signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas);

  // --- Submission ---
  if (appConfig.mode === "local" || appConfig.mode === "public") {
    const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
    return { ...base, ok: true, txHash, targetBlock };
  }

  // mainnet: if a batching window is open (beginBundle), queue this tx so the
  // whole tick's txs go out as ONE atomic multi-tx bundle with valid sequential
  // nonces (see flushBundle). Hashes are filled in by the caller after flush.
  if (bundleQueue !== null) {
    bundleQueue.push({ signed, nonce, race: opts.race ?? false, revertible: opts.revertible ?? false });
    return { ...base, ok: true, queued: true, targetBlock };
  }

  // No batch open: fan this single-tx bundle out to EVERY configured builder for
  // the next two blocks. Only the builder that wins a slot can include us, so
  // submitting to one relay means only winning when that relay's builder wins. All
  // attempts run in parallel; unreachable builders are tolerated — succeed if ANY
  // accepts.
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
    predictedTxHash: keccak256(signed),
    targetBlock,
    error: bundleHashes.length === 0 && txHash === undefined ? "no bundle accepted" : undefined,
  };
}
