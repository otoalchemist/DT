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
import { nonces } from "./nonce.js";
import { effectiveTipGwei, resolveGas } from "./logic.js";
import { logger } from "./logger.js";
import { recordRaceSubmission } from "./race-timing.js";

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
 * Added on top of the node's suggested priority fee for every `normalGas` submission.
 *
 * The suggestion is a percentile of recent blocks, so a tx priced exactly AT it is a
 * coin-flip for the next block and can sit for several. That matters beyond latency:
 * these txs come from the same wallet the boundary fires use, so one stuck at a low
 * tip holds a nonce that every later payment queues behind (a higher nonce cannot be
 * mined before a lower one, no matter what it pays). One gwei over the suggestion is
 * a rounding error on cost — ~0.00013 ETH on a 130k-gas audit — and buys out of that
 * whole failure mode.
 */
const NORMAL_GAS_TIP_BUMP_WEI = 1_000_000_000n; // +1 gwei

/**
 * "Normal" network gas, read at submit time — the node's own suggested priority fee
 * (plus NORMAL_GAS_TIP_BUMP_WEI) rather than any of the configured race/offense tips.
 * Used by manual, user-initiated actions (pay-to-current / use-bribe / audit from the
 * dashboard) and by the mid-epoch offense sweep — none of which are racing anyone, and
 * so shouldn't inherit boundary-race pricing. Falls back to 1 gwei if the node has no
 * suggestion.
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
  priority += NORMAL_GAS_TIP_BUMP_WEI;
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
/**
 * How long to wait for one builder to acknowledge a bundle.
 *
 * Bundle submission is time-critical and fans out to every builder: a slow or dead endpoint
 * must not hold up the caller. The attempts run concurrently, so the cost of this is max()
 * and not sum() — but that means ONE slow builder sets the floor for the whole fan-out, and
 * the caller holds the engine lock throughout.
 *
 * Cut from 3s. At the epoch-178 boundary a payment fire held the lock for about four seconds
 * after its last transaction was queued, and the audit fire that queues behind it did not run
 * until three seconds PAST the boundary — by which time a rival had taken both of its targets
 * inside the boundary block. Ten builders at three target blocks is thirty posts, and at 3s
 * any one of them could buy that outcome on its own.
 *
 * Healthy builders ack in well under a second. One that cannot answer in 1.2s was not going to
 * have our bundle in the block it is racing for, so waiting on it trades a certain delay for a
 * submission that is already too late to matter — and we still have nine others.
 */
const SEND_BUNDLE_TIMEOUT_MS = 1_200;

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
  /** Which wallet signed it. Nonces are per-account, so fate-tracking a multi-wallet bundle
   *  needs this to reach the right NonceManager rather than the primary's. */
  from: Address;
  race: boolean;
  /** Allowed to revert without invalidating the bundle (eth_sendBundle
   *  revertingTxHashes). Used for the coinbase bid so a misconfigured payer can
   *  never drop the payment from the bundle. */
  revertible?: boolean;
  /** Bundle shape, for race telemetry only (see race-timing.ts). Recorded so the
   *  analysis can separate "what we paid" from "when we sent it" — never used to
   *  build or submit the bundle. */
  gasLimit?: bigint;
  priorityFeeWei?: bigint;
  /** Set only on the coinbase-bid tx, so the flat bid is distinguishable from a
   *  payment's value. */
  bidWei?: bigint;
}
let bundleQueue: QueuedTx[] | null = null;

/**
 * The boundary this batch is racing into, in unix seconds. Set by the pre-boundary fires,
 * which are the only callers that know it; null for an ordinary tick's batch.
 *
 * No longer telemetry-only: it also becomes the bundle's `minTimestamp`, which is what stops
 * a builder executing a pre-boundary race in a block before the boundary (see flushBundle).
 * So a WRONG value here now costs inclusion rather than just a mis-reported lead — hence
 * beginBundle clearing it, and only the fires setting it.
 */
let raceBoundaryTs: bigint | null = null;

/** Tell the open batch which boundary it is racing into: bounds the bundle (minTimestamp)
 *  and measures the lead in race telemetry. */
export function setRaceBoundary(ts: bigint | null): void {
  raceBoundaryTs = ts;
}

/**
 * Also aim this bundle one block EARLIER than the head says.
 *
 * Set only by the audit fire, and only when a payment shared the same boundary. The two
 * fires flush separately and each reads the head fresh at flush time (see targetBlock
 * below), so a block landing in the gap between them leaves the payment aimed at
 * [N+1, N+2] and the audit at [N+2, N+3]. The payment then takes the boundary block and
 * the audit CANNOT — its window starts one block too late, which on a boundary is the
 * whole race. The gap is the audit fire's own work plus up to 150ms of retry, call it
 * ~0.6-1.0s against 12s slots, so roughly one boundary in twelve to twenty.
 *
 * Looking back is safe precisely BECAUSE minTimestamp exists. A block earlier than the
 * boundary cannot satisfy it, so the extra shot is either the payment's block — the one we
 * want — or simply ineligible. Without minTimestamp this would be the epoch-169 hazard
 * deliberately: a bundle mined an epoch early, reverting and burning the nonce.
 *
 * Not set for the payment fire, which runs FIRST and would spend the extra shot on a block
 * already mined, nor for an audit-only boundary, where there is no earlier fire to catch up
 * to. That keeps the cost at one extra post per builder, once per boundary that needs it —
 * worth minding because buildernet rate-limits at ~3 req/IP/s.
 */
let raceLookBack = false;

/** Ask the open batch to also aim one block earlier — see raceLookBack. */
export function setRaceLookBack(on: boolean): void {
  raceLookBack = on;
}

/** Open a batching window: subsequent mainnet submitTx calls queue their signed
 *  tx instead of sending, until flushBundle() emits them as one bundle. */
export function beginBundle(): void {
  bundleQueue = [];
  raceBoundaryTs = null; // a stale boundary must not leak into the next batch
  raceLookBack = false; // ...and neither may a stale look-back
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
 * Gated race mirrors that have not been sent yet. Detached from the flush on purpose (see
 * below), so this is the only handle on them — exported for tests, which would otherwise be
 * asserting against a send that may or may not have happened yet.
 */
const pendingMirrors: Promise<void>[] = [];

/** Forget any still-pending gated mirror without awaiting it. For tests: a gate left
 *  deliberately unresolved would otherwise make a later awaitPendingMirrors hang. */
export function resetPendingMirrors(): void {
  pendingMirrors.length = 0;
}

/** Wait for every gated mirror to have been attempted. For tests. */
export async function awaitPendingMirrors(): Promise<void> {
  while (pendingMirrors.length > 0) await pendingMirrors.shift();
}

/** One Ethereum slot. Boundaries are slot-aligned (86,400 / 12 = 7,200 exactly). */
const SLOT_SECONDS = 12n;

/**
 * Hold a race mirror until the slot BEFORE the boundary has produced a block.
 *
 * `minTimestamp` protects the bundle copy, but a public-mempool transaction carries no such
 * field — nothing stops a builder putting it in a pre-boundary block, where the epoch has not
 * advanced and a payment or audit reverts. That is a real loss, not a hypothetical: audit
 * 0x44ce0008…b496 reverted at index 5 of the pre-boundary block with `NotDelinquent()`,
 * burning 0.024 ETH and its nonce, which killed the copy aimed at the boundary block.
 *
 * Once the pre-boundary block EXISTS it is sealed, so the next block must be the boundary
 * block — and a transaction broadcast after that point cannot be mined too early. Waiting on
 * the block rather than on the clock is what makes this robust to the actual failure: that
 * slot was published ~8 seconds LATE, so any wall-clock lead would still have been swept in.
 *
 * Normally this makes the mirror go out EARLIER than before, not later: the pre-boundary slot
 * starts a full 12s ahead of the boundary, so its block usually exists by boundary-11s,
 * against the old fixed boundary-5s. It only delays when the slot is late, which is exactly
 * when delay is the point.
 *
 * Deliberately gives up after the boundary passes: from then on every new block is at or past
 * it, so broadcasting is safe regardless.
 */
async function preBoundarySlotSettled(boundaryTs: bigint): Promise<void> {
  const deadlineMs = Number(boundaryTs) * 1000 + 2_000;
  for (;;) {
    try {
      const b = await publicClient.getBlock({ blockTag: "latest" });
      if (b.timestamp >= boundaryTs - SLOT_SECONDS) return;
    } catch {
      // Transient read failure: fall through to the wait and try again.
    }
    if (Date.now() >= deadlineMs) return;
    await new Promise((r) => setTimeout(r, 400));
  }
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
  /**
   * Which block to aim a RACE at: the first one whose slot can satisfy the boundary.
   *
   * `head + 1` is the wrong answer and cost real money. The fire runs ~3-4s before the
   * boundary, so `head + 1` is the block for the CURRENT slot — whose timestamp is still
   * BEFORE the boundary. A payment priced for the next epoch cannot execute there: it
   * reverts, and the revert still consumes the nonce, which kills the copy aimed at the real
   * boundary block. Measured over 10 boundaries: every race that landed in its own first
   * target reverted, and every race that succeeded did so in `target + 1`.
   *
   * `minTimestamp` was supposed to make the too-early block harmless, and it does not
   * reliably: at the epoch-178 boundary a bundle carrying minTimestamp = 23:59:35 was
   * included by Titan in a block stamped 23:59:23 and reverted. With a 10-builder fan-out
   * the likeliest route is orderflow sharing — a partner treating the bundle's transaction
   * as ordinary flow, which drops the constraint. So the guard cannot be the only defence:
   * we simply never offer a builder a block that is too early.
   *
   * Derived from the SAME block we read the number from, so a stale head is self-correcting:
   * an older block has a proportionally larger gap to the boundary and the arithmetic lands
   * on the same absolute block either way.
   *
   * A MISSED slot makes this overshoot (fewer blocks than slots), so we aim one block late
   * and lose the race while still succeeding. That is the cheap direction — undershooting
   * reverts and burns a nonce; overshooting only costs position.
   */
  function raceTargetFrom(headNumber: bigint, headTs: bigint, boundaryTs: bigint): bigint {
    if (boundaryTs <= headTs) return headNumber + 1n; // boundary already passed
    const slotsAway = (boundaryTs - headTs + SLOT_SECONDS - 1n) / SLOT_SECONDS; // ceil
    return headNumber + (slotsAway < 1n ? 1n : slotsAway);
  }

  /**
   * Fresh head, deliberately uncached.
   *
   * viem caches `getBlockNumber` for `cacheTime`, which defaults to `pollingInterval`
   * (4,000 ms) — and this fires ~3-5 s before a boundary, so a cached head can be a whole
   * block stale. That is not hypothetical: at the epoch-169 boundary the head read 25778246
   * when 25778247 already existed, so the bundle was aimed at [25778247, 25778248] where
   * 25778247 was ALREADY MINED. One of the two target blocks was spent on a block that could
   * never include us, halving the fan-out that exists to survive a missed slot.
   *
   * On a race we need the head's TIMESTAMP as well as its number, so this reads the block
   * rather than just the number — one call either way.
   */
  let targetBlock: bigint;
  if (raceBoundaryTs !== null) {
    const head = await publicClient.getBlock({ blockTag: "latest" });
    // Only trust the derivation when the head actually carried both fields. A block with no
    // number or timestamp would otherwise compute a target near zero and send the bundle
    // nowhere — silently losing the race it was meant to win.
    targetBlock =
      head?.number != null && head?.timestamp != null
        ? raceTargetFrom(head.number, head.timestamp, raceBoundaryTs)
        : (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  } else {
    targetBlock = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  }

  // Stamped here, immediately before the fan-out, so it measures OUR send time and not
  // how long the builders took to acknowledge (telemetry only — see race-timing.ts).
  const submittedAtMs = Date.now();

  /**
   * One multi-tx bundle, fanned out to every builder for the target block and the next.
   *
   * The look-back (a third shot at `targetBlock - 1`) is NOT used on a race any more. It
   * existed so an audit fire could reach the block a payment fire had already aimed at, back
   * when each derived its own target from its own head and they could disagree. Both now
   * derive the target from the boundary timestamp, so they agree by construction — and on a
   * race `targetBlock - 1` is precisely the pre-boundary block that reverts.
   */
  const targetBlocks =
    raceBoundaryTs === null && raceLookBack && targetBlock > 1n
      ? [targetBlock - 1n, targetBlock, targetBlock + 1n]
      : [targetBlock, targetBlock + 1n];
  /**
   * Tell each wallet's NonceManager what it signed at which nonce, so a later sync can look
   * up whether that tx is still alive instead of timing the reservation out. Done here rather
   * than at sign time because the LAST reachable block is only known once the fan-out shape
   * is decided (a look-back bundle spans three blocks, not two).
   */
  const lastTargetBlock = targetBlocks[targetBlocks.length - 1]!;
  for (const q of queue) {
    nonces.for(q.from).markSigned(q.nonce, {
      hash: keccak256(q.signed),
      lastTargetBlock,
      mirrored: q.race,
    });
  }

  const acceptedBy = new Set<string>();
  const bundleHashes: string[] = [];
  const attempts = appConfig.builderUrls.flatMap((url) =>
    targetBlocks.map(async (blk) => {
      const params: Record<string, unknown> = { txs: signedList, blockNumber: toHex(blk) };
      if (revertingTxHashes.length > 0) params.revertingTxHashes = revertingTxHashes;
      /**
       * Never let this bundle execute BEFORE the boundary it is racing into.
       *
       * A bundle is constrained by block NUMBER, but everything it does is gated on block
       * TIMESTAMP: the epoch only advances when a block's timestamp crosses the boundary, and
       * a pre-boundary audit is invalid until then. We simulate against that timestamp
       * (`simTimestamp`) and pass — then the transaction can still be mined a block early and
       * revert. Which is exactly what happened at the epoch-169 boundary: slot 23:59:23 was
       * published ~8 s late, after our 23:59:31.578 submission, so `targetBlock` pointed at a
       * PRE-boundary block. A builder took the audit there, the epoch was still 168, and it
       * reverted — burning the gas and the nonce, which killed the copy aimed at the real
       * boundary block. The audit was correct; it just ran one epoch early.
       *
       * `minTimestamp` is the matching unit, so the pre-boundary block simply becomes
       * ineligible and the fan-out spends both shots on blocks that can actually work.
       * Boundaries are slot-aligned (86,400 / 12 = 7,200 exactly), so the boundary block's
       * timestamp equals `raceBoundaryTs` and an inclusive minimum admits it.
       *
       * Only set for a race — `beginBundle` clears `raceBoundaryTs`, so an ordinary tick's
       * batch carries no constraint and behaves exactly as before.
       */
      if (raceBoundaryTs !== null) params.minTimestamp = Number(raceBoundaryTs);
      const r = await flashbotsRpcWithTimeout("eth_sendBundle", [params], url, SEND_BUNDLE_TIMEOUT_MS);
      return { url, bundleHash: r?.bundleHash as string | undefined };
    }),
  );

  // Public-mempool mirror per race-flagged tx (identical tx: same nonce/sig, so
  // only one copy of each can ever land).
  //
  // On a RACE the mirror is held behind preBoundarySlotSettled and fired detached, because
  // waiting here would hold `ticking` and push the following fire (the audit bundle) past the
  // boundary it is racing into. Off a race — an ordinary tick — it goes out immediately and
  // concurrently with the bundle, exactly as before.
  // Local const so TS narrows it inside the closures below.
  const raceTs = raceBoundaryTs;
  const gate = raceTs !== null ? preBoundarySlotSettled(raceTs) : null;
  const broadcasts = queue.map((q) => {
    if (!q.race) return Promise.resolve({ nonce: q.nonce, txHash: undefined as Hex | undefined });
    const send = () =>
      publicClient
        .sendRawTransaction({ serializedTransaction: q.signed })
        .then((h) => ({ nonce: q.nonce, txHash: h as Hex | undefined }))
        .catch((err) => {
          logger.warn(`public broadcast (nonce ${q.nonce}) failed:`, (err as Error).message);
          return { nonce: q.nonce, txHash: undefined as Hex | undefined };
        });
    if (gate === null) return send();
    // Detached: resolve now so the flush is not blocked, and let the gate fire the send.
    // Tracked so tests (and a shutdown) can wait for it — see awaitPendingMirrors.
    pendingMirrors.push(gate.then(send).then(() => undefined));
    return Promise.resolve({ nonce: q.nonce, txHash: undefined as Hex | undefined });
  });

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

  // Race telemetry: WHEN we sent, against the position we end up with. `submittedAtMs` is
  // stamped before the fan-out above, so it measures our own send time rather than how long
  // the builders took to ack. The outcome is filled in later from the receipt (see
  // race-timing.ts) — this is the one input into boundary position that is invisible to
  // on-chain analysis, because only the sender knows it.
  const bidWeiTotal = queue.reduce((s, q) => s + (q.bidWei ?? 0n), 0n);
  const gasTotal = queue.reduce((s, q) => s + (q.gasLimit ?? 0n), 0n);
  // Tip is uniform across a batch (one computeFees per tick), so the max is the tip.
  const tipWei = queue.reduce((s, q) => (q.priorityFeeWei ?? 0n) > s ? (q.priorityFeeWei ?? 0n) : s, 0n);
  recordRaceSubmission({
    submittedAtMs,
    targetBlock: targetBlock.toString(),
    boundaryTs: raceBoundaryTs === null ? null : Number(raceBoundaryTs),
    leadMs: raceBoundaryTs === null ? null : Number(raceBoundaryTs) * 1000 - submittedAtMs,
    acceptedBy: [...acceptedBy],
    builderCount: appConfig.builderUrls.length,
    txCount: queue.length,
    gasLimitTotal: gasTotal.toString(),
    tipGwei: Number(tipWei) / 1e9,
    bidWei: bidWeiTotal.toString(),
    txHashes: queue.map((q) => keccak256(q.signed)),
  });

  const txHashByNonce = new Map(mirrors.map((m) => [m.nonce, m.txHash]));
  for (const q of queue) {
    const txHash = txHashByNonce.get(q.nonce);
    /**
     * A gated race mirror has not been sent yet, so it reports no hash — but it IS a live
     * path and must count as one. `ok` gates whether the caller marks a citizen handled
     * (jitPass) or paid (queuePreBoundaryPayments); reporting false here would make it retry
     * on a fresh nonce and pay the same citizen twice once the mirror lands. Biasing toward
     * ok is the safe direction: the nonce is already committed and either the bundle or the
     * pending mirror will carry it.
     */
    const mirrorPending = gate !== null && q.race;
    out.set(q.nonce, {
      ok: bundleOk || txHash !== undefined || mirrorPending,
      txHash,
      // Known for every tx whether or not it was broadcast — see BundleTxResult.
      predictedTxHash: keccak256(q.signed),
      bundleHash,
      error: !bundleOk && txHash === undefined && !mirrorPending ? "no bundle accepted" : undefined,
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
/**
 * `offense` selects the gas profile for the bid transaction ITSELF — not the bid amount,
 * which the caller has already resolved.
 *
 * It exists because this was hardcoded to `false`, and that is a real misconfiguration on an
 * audit-only boundary. The audits in the bundle get offense gas (act() derives it from the
 * action kind), but the bid is queued outside act(), so it silently kept the PAYMENT tip and
 * the payment dynamic-tip settings. An operator running the common shape — an expensive
 * payment tip, a cheap audit tip — paid the payment rate on every audit-only night. At the
 * observed 201/131 split that is 70 gwei over COINBASE_BID_GAS of a transaction they had
 * explicitly priced cheaper, and it ignored offenseDynamicTip* entirely on the way past.
 *
 * The caller passes the same distinction it already uses to pick the amount, so the bid tx
 * and the bid value can never disagree about which kind of boundary this is.
 */
export async function queueCoinbaseBid(
  payer: Address,
  bidWei: bigint,
  offense = false,
): Promise<boolean> {
  if (bundleQueue === null || appConfig.mode !== "mainnet" || bidWei <= 0n) return false;
  // One bid buys position for the WHOLE bundle however many wallets contributed txs to
  // it, so it comes from the primary wallet rather than being split or duplicated.
  const account = runtime.primary?.account;
  if (!account) return false;
  try {
    const latest = await getLatestBlockCached();
    const { maxFeePerGas, maxPriorityFeePerGas } = computeFees(offense, latest);
    const nonce = nonces.for(account.address).reserve();
    const signed = await signTx(
      account,
      { to: payer, data: "0x", value: bidWei },
      nonce,
      COINBASE_BID_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    );
    bundleQueue.push({ signed, nonce, from: account.address, race: false, revertible: true,
      gasLimit: COINBASE_BID_GAS, priorityFeeWei: maxPriorityFeePerGas, bidWei });
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
  // Used for sim context + reporting, and — when no batch is open — as this single-tx
  // bundle's actual target. On a pre-boundary race (`simTimestamp` is the boundary) that
  // must be the block whose slot can satisfy the boundary, NOT head + 1: head + 1 is the
  // current slot, still in the old epoch, where the tx reverts and burns its nonce. Same
  // reasoning as flushBundle's raceTargetFrom — see the long note there.
  const headNumber = latest.number ?? (await publicClient.getBlockNumber());
  let targetBlock = headNumber + 1n;
  if (opts.simTimestamp !== undefined && latest.number != null && latest.timestamp != null) {
    const boundaryTs = opts.simTimestamp;
    if (boundaryTs > latest.timestamp) {
      const slotsAway = (boundaryTs - latest.timestamp + SLOT_SECONDS - 1n) / SLOT_SECONDS;
      targetBlock = headNumber + (slotsAway < 1n ? 1n : slotsAway);
    }
  }

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
    bundleQueue.push({ signed, nonce, from: account.address, race: opts.race ?? false,
      revertible: opts.revertible ?? false, gasLimit: gas, priorityFeeWei: maxPriorityFeePerGas });
    return { ...base, ok: true, queued: true, targetBlock };
  }

  // No batch open: fan this single-tx bundle out to EVERY configured builder for
  // the next two blocks. Only the builder that wins a slot can include us, so
  // submitting to one relay means only winning when that relay's builder wins. All
  // attempts run in parallel; unreachable builders are tolerated — succeed if ANY
  // accepts.
  // Same fate-tracking as the batched path; this bundle spans exactly two blocks.
  nonceManager.markSigned(nonce, {
    hash: keccak256(signed),
    lastTargetBlock: targetBlock + 1n,
    mirrored: opts.race ?? false,
  });

  const bundleHashes: string[] = [];
  const acceptedBy = new Set<string>();
  const attempts = appConfig.builderUrls.flatMap((url) =>
    [targetBlock, targetBlock + 1n].map(async (blk) => {
      const params: Record<string, unknown> = { txs: [signed], blockNumber: toHex(blk) };
      // Same boundary guard as the batched path: a pre-boundary block must not be able to
      // execute this. Keyed off simTimestamp, which IS the boundary timestamp when a
      // pre-boundary fire queued this tx, so no module state is involved here.
      if (opts.simTimestamp !== undefined) params.minTimestamp = Number(opts.simTimestamp);
      const r = await flashbotsRpcWithTimeout(
        "eth_sendBundle",
        [params],
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
