import fs from "node:fs";
import path from "node:path";
import { keccak256, toHex, formatEther, type Address, type Block, type Hex } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { mainnet } from "viem/chains";
import { ANVIL_CHAIN_ID, publicClient, getLatestBlockCached } from "./chain.js";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { nonces } from "./nonce.js";
import { effectiveTipGwei, resolveGas } from "./logic.js";
import { logger } from "./logger.js";
import {
  ensurePrivateDirectory,
  tightenPrivateFile,
  writePrivateFileAtomic,
} from "./private-file.js";

export interface TxIntent {
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional gas override; estimated if omitted. */
  gas?: bigint;
}

export interface SubmitResult {
  ok: boolean;
  /** Submission lifecycle at return time. A queued tx has only been prepared locally;
   *  relayed means a builder or public RPC accepted it. Neither is confirmation. */
  state?: "queued" | "relayed";
  simulated: boolean;
  txHash?: Hex;
  bundleHash?: string;
  targetBlock?: bigint;
  /** Private-bundle eligibility ends after this block. Absent when public broadcast can
   *  remain pending beyond the bundle window. */
  expiresAfterBlock?: bigint;
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

/** Exact worst-case cost of the transaction that is about to be signed. */
export interface SpendQuote {
  account: Address;
  valueWei: bigint;
  gasWei: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint;
}

export type SpendAuthorization = (
  quote: SpendQuote,
) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };

// --- Flashbots reputation signer (identity only; holds no funds) ---

function reputationSigner(): PrivateKeyAccount {
  ensurePrivateDirectory(appConfig.dataDir);
  const p = path.join(appConfig.dataDir, "flashbots-signer.key");
  let pk: Hex;
  if (fs.existsSync(p)) {
    tightenPrivateFile(p);
    const loaded = fs.readFileSync(p, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(loaded)) {
      throw new Error(`Invalid Flashbots reputation key at ${p}`);
    }
    pk = loaded as Hex;
  } else {
    pk = generatePrivateKey();
    writePrivateFileAtomic(p, pk);
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

/** POST an authenticated bundle RPC to one builder/relay. */
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
  assertSigningChain();
  const chainId = runtime.chainId!;
  return account.signTransaction({
    to: intent.to,
    data: intent.data,
    value: intent.value,
    gas,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId,
    type: "eip1559",
  });
}

function assertSigningChain(): void {
  const chainId = runtime.chainId;
  if (chainId === null) throw new Error("Chain identity has not been verified");
  if (appConfig.mode === "local" && chainId !== ANVIL_CHAIN_ID) {
    throw new Error(
      `Refusing to sign a local transaction for chain ${chainId}; expected Anvil chain ${ANVIL_CHAIN_ID}`,
    );
  }
  if (appConfig.mode !== "local" && chainId !== mainnet.id) {
    throw new Error(`Refusing to sign a live transaction for chain ${chainId}; expected chain 1`);
  }
}

/**
 * Build, simulate, authorize, and submit a single tx.
 * - mainnet: simulates unsigned against the verified HTTP RPC, then submits a signed
 *   bundle for block+1/block+2 (and, where requested, an identical public mirror).
 * - public/local: broadcasts the raw transaction to the configured node.
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
  account: Address;
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
  state: "relayed" | "failed";
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
  /** Last block for which the private bundle remains eligible. */
  expiresAfterBlock?: bigint;
}

/**
 * Send everything queued since beginBundle() as a single atomic multi-tx bundle
 * (txs in ascending-nonce order) per target block, mirroring each race-flagged tx
 * to the public mempool as a fallback. Returns a per-nonce result map so the
 * caller can fill in each activity entry's hashes and start receipt tracking.
 * Always closes the batching window, even on error.
 */
export async function flushBundle(): Promise<Map<Hex, BundleTxResult>> {
  const queue = bundleQueue;
  bundleQueue = null;
  const out = new Map<Hex, BundleTxResult>();
  if (!queue || queue.length === 0) return out;

  // A bundle executes its txs in the given order, and each ACCOUNT's txs must appear in
  // ascending nonce order. Sorting the whole queue by nonce value satisfies that even
  // with several wallets in one bundle: for any two txs of the same wallet, n1 < n2 puts
  // n1 first, and Array#sort is stable (ES2019) so equal nonces from different wallets
  // keep insertion order. Cross-wallet interleaving is arbitrary but harmless — a token
  // is paid and audited by the SAME wallet (both calls are owner-only), so a payment
  // always precedes the audit that depends on it within that wallet's own sequence.
  queue.sort((a, b) => a.nonce - b.nonce);
  const signedList = queue.map((q) => q.signed);
  // Txs allowed to revert without invalidating the bundle (audits riding a payment
  // bundle, and the coinbase bid), so a defended target or misconfigured payer can
  // never drop a mandatory payment. A tx hash is keccak(signed tx).
  const revertingTxHashes = queue.filter((q) => q.revertible).map((q) => keccak256(q.signed));
  const targetBlock = (await publicClient.getBlockNumber()) + 1n;
  // The batched target is chosen later than each tx's preliminary quote. Extend every
  // payer's durable journal to the actual final eligible block before any signed bytes
  // are exposed to a builder or public RPC.
  for (const address of new Set(queue.map((q) => q.account.toLowerCase() as Address))) {
    nonces.for(address).markEligibleThrough(targetBlock + 1n);
  }

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
          .then((h) => ({ predictedTxHash: keccak256(q.signed), txHash: h as Hex | undefined }))
          .catch((err) => {
            // The node may accept and gossip raw bytes before the HTTP response is lost.
            // Its hash is deterministic, so retain that hash as an ambiguous public send
            // and receipt-track it rather than preparing a duplicate logical action.
            const predictedTxHash = keccak256(q.signed);
            logger.warn(
              `public broadcast (nonce ${q.nonce}) response failed; tracking ${predictedTxHash.slice(0, 10)}…:`,
              (err as Error).message,
            );
            return { predictedTxHash, txHash: predictedTxHash as Hex | undefined };
          })
      : Promise.resolve({ predictedTxHash: keccak256(q.signed), txHash: undefined as Hex | undefined }),
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

  const txHashBySignedHash = new Map(mirrors.map((m) => [m.predictedTxHash, m.txHash]));
  for (const q of queue) {
    const predictedTxHash = keccak256(q.signed);
    const txHash = txHashBySignedHash.get(predictedTxHash);
    out.set(predictedTxHash, {
      ok: bundleOk || txHash !== undefined,
      state: bundleOk || txHash !== undefined ? "relayed" : "failed",
      txHash,
      // Known for every tx whether or not it was broadcast — see BundleTxResult.
      predictedTxHash,
      bundleHash,
      expiresAfterBlock: targetBlock + 1n,
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
export async function queueCoinbaseBid(
  payer: Address,
  bidWei: bigint,
  opts: {
    /** Runtime bytecode hashes explicitly approved by the operator. Empty fails closed. */
    approvedCodeHashes?: readonly Hex[];
    /** Mandatory final payer-specific guard over the exact value and signed gas. */
    authorizeSpend: SpendAuthorization;
    onQueued?: (queued: SpendQuote & { nonce: number; predictedTxHash: Hex }) => void;
  },
): Promise<boolean> {
  if (bundleQueue === null || appConfig.mode !== "mainnet" || bidWei <= 0n) return false;
  // One bid buys position for the WHOLE bundle however many wallets contributed txs to
  // it, so it comes from the primary wallet rather than being split or duplicated.
  const account = runtime.primary?.account;
  if (!account) return false;
  try {
    const approved = new Set((opts.approvedCodeHashes ?? []).map((h) => h.toLowerCase()));
    if (approved.size === 0) throw new Error("no approved CoinbasePayer code hash configured");
    const code = await publicClient.getCode({ address: payer });
    if (!code || code === "0x") throw new Error("CoinbasePayer address has no deployed code");
    const codeHash = keccak256(code);
    if (!approved.has(codeHash.toLowerCase())) {
      throw new Error(`CoinbasePayer code hash ${codeHash} is not approved`);
    }

    const latest = await getLatestBlockCached();
    const { maxFeePerGas, maxPriorityFeePerGas, baseFee } = computeFees(false, latest);
    const quote: SpendQuote = {
      account: account.address,
      valueWei: bidWei,
      gasWei: COINBASE_BID_GAS * maxFeePerGas,
      gas: COINBASE_BID_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
      baseFee,
    };
    if (typeof opts.authorizeSpend !== "function") {
      throw new Error("Coinbase bid requires an exact spending authorization");
    }
    const authorization = await opts.authorizeSpend(quote);
    if (!authorization.ok) {
      throw new Error(authorization.reason ?? "Coinbase bid rejected by spending guardrail");
    }
    assertSigningChain();
    const provisionalTarget = (latest.number ?? (await publicClient.getBlockNumber())) + 1n;
    const nonce = nonces.for(account.address).reserve(provisionalTarget + 1n);
    const signed = await signTx(
      account,
      { to: payer, data: "0x", value: bidWei },
      nonce,
      COINBASE_BID_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    );
    bundleQueue.push({ signed, nonce, account: account.address, race: false, revertible: true });
    opts.onQueued?.({ ...quote, nonce, predictedTxHash: keccak256(signed) });
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
    /** Wallet that must sign. payTaxes/audit/kill/useBribe are owner-only on-chain, so
     *  this has to be the wallet holding the citizen involved — not simply "the" wallet.
     *  Defaults to the primary for wallet-agnostic sends (e.g. the coinbase bid). */
    account?: PrivateKeyAccount;
    /** Final payer-specific guard, evaluated with the exact gas and dynamic fee fields
     *  immediately before any transaction is signed. */
    authorizeSpend: SpendAuthorization;
  },
): Promise<SubmitResult> {
  const account = opts.account ?? runtime.primary?.account;
  if (!account) throw new Error("Wallet locked");
  const nonceManager = nonces.for(account.address);

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

  if (typeof opts.authorizeSpend !== "function") {
    return { ...base, error: "transaction requires an exact spending authorization", targetBlock };
  }
  const quote: SpendQuote = {
    account: account.address,
    valueWei: intent.value,
    gasWei,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    baseFee: latest.baseFeePerGas ?? 0n,
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
    // Never hand a relay an externally usable signature before the exact spend guard and
    // durable nonce reservation pass. Simulate unsigned against our verified HTTP RPC;
    // future-timestamp/dependent bundle actions use their dedicated paths above.
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

  // Simulation can take seconds and receipt callbacks/balance refreshes may change the
  // payer's available headroom while it runs. Authorize the exact quote once, at the
  // final decision point immediately before consuming a nonce and signing for relay.
  const finalAuthorization = await opts.authorizeSpend(quote);
  if (!finalAuthorization.ok) {
    return {
      ...base,
      error: finalAuthorization.reason ?? "rejected by final spending guardrail",
      targetBlock,
    };
  }

  // Simulation passed — now officially consume the nonce and sign for real.
  assertSigningChain();
  const nonce = nonceManager.reserve(
    appConfig.mode === "mainnet" ? targetBlock + 1n : undefined,
  );
  base.nonce = nonce;
  const signed = await signTx(account, intent, nonce, gas, maxFeePerGas, maxPriorityFeePerGas);

  // --- Submission ---
  if (appConfig.mode === "local" || appConfig.mode === "public") {
    const predictedTxHash = keccak256(signed);
    let txHash: Hex;
    try {
      txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      // A transport error does not prove the node rejected the raw bytes; it can fail
      // after acceptance/gossip. Keep the deterministic hash live so strategy suppresses
      // duplicates and tracks the possible receipt until mined nonce state resolves it.
      logger.warn(
        `raw transaction response failed; tracking ${predictedTxHash.slice(0, 10)}… as ambiguously broadcast:`,
        (err as Error).message,
      );
      txHash = predictedTxHash;
    }
    return { ...base, ok: true, state: "relayed", txHash, targetBlock };
  }

  // mainnet: if a batching window is open (beginBundle), queue this tx so the
  // whole tick's txs go out as ONE atomic multi-tx bundle with valid sequential
  // nonces (see flushBundle). Hashes are filled in by the caller after flush.
  if (bundleQueue !== null) {
    bundleQueue.push({
      signed,
      nonce,
      account: account.address,
      race: opts.race ?? false,
      revertible: opts.revertible ?? false,
    });
    return {
      ...base,
      ok: true,
      state: "queued",
      queued: true,
      predictedTxHash: keccak256(signed),
      targetBlock,
    };
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
  const predictedTxHash = keccak256(signed);
  const broadcast: Promise<Hex | undefined> = opts.race
    ? publicClient.sendRawTransaction({ serializedTransaction: signed }).catch((err) => {
        // The RPC can fail after accepting/gossiping the exact bytes. Retain the
        // deterministic hash so lifecycle/spend suppression continues even if every
        // relay response also fails.
        logger.warn(
          `public broadcast response failed; tracking ${predictedTxHash.slice(0, 10)}…:`,
          (err as Error).message,
        );
        return predictedTxHash;
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
    state: bundleHashes.length > 0 || txHash !== undefined ? "relayed" : undefined,
    bundleHash: bundleHashes[0],
    txHash,
    predictedTxHash,
    targetBlock,
    expiresAfterBlock: txHash === undefined && bundleHashes.length > 0 ? targetBlock + 1n : undefined,
    error: bundleHashes.length === 0 && txHash === undefined ? "no bundle accepted" : undefined,
  };
}
