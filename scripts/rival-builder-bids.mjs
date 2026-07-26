// Which rivals pay the block builder directly, and are they actually auditable?
//
// A "builder bid" (coinbase bid) is an internal ETH transfer to block.coinbase — the
// same mechanic this bot's CoinbasePayer forwarder uses (contracts/CoinbasePayer.sol).
// It buys transaction position independently of the priority fee, so a rival that bids
// can land its tax payment at index 0 of the epoch's first block and self-cure BEFORE
// anyone can audit it.
//
// Why this matters: scripts/rival-skippers.mjs samples lastEpochPaid at the LAST BLOCK
// OF THE PRIOR EPOCH, where such a rival correctly reads 2+ behind — so it qualifies as
// a "skipper" even though its real auditable window is ~zero blocks. Pinning one wastes
// a scarce auditor slot (an owned token audits at most `auditLimit` times per epoch) on
// a race that cannot be won. This script finds them so they can be added to the EXCLUDED
// list in scripts/rival-skippers.mjs.
//
// The decisive column is AUDITED: how many times ANY player successfully audited that
// token in the window. A rival that bids AND was never audited is structurally immune —
// exclude it. A rival that bids but still gets audited is merely expensive, not immune.
//
// Detection is on-chain only. It cannot see off-chain/private builder deals (a rival
// paying a builder out-of-band shows up here as "no bid").
//
// Usage:
//   node scripts/rival-builder-bids.mjs                 # last 10 epochs
//   node scripts/rival-builder-bids.mjs --epochs 20     # widen the window
//   node scripts/rival-builder-bids.mjs --json          # machine-readable summary
//   RPC_HTTP_URL=... node scripts/rival-builder-bids.mjs
//
// Requires a tracing-capable RPC (trace_block). Alchemy's standard mainnet endpoint
// works. Cost scales with the number of blocks containing rival payments (~140 blocks
// over 10 epochs => ~140 trace_block calls), so narrow --epochs if you are rate limited.
//
// The RPC URL is taken from (in order): RPC_HTTP_URL env, ALCHEMY_API_KEY env,
// data/settings.json (alchemyApiKey) — the same key the app already uses.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

// --- constants (mirror packages/shared/src/constants.ts) ---
const GAME = "0xa448c7f618087dda1a3b128cad8a424fbae4b71f";
const EPOCH_DURATION = 86400n;
const SEL_CURRENT_EPOCH = "0x76671808"; // currentEpoch()
const SEL_START_TIME = "0x78e97925";    // startTime()
// Event topic0s (keccak of the signature; hardcoded so this script stays dependency-free).
const TOPIC_TAXES_PAID = "0xa13146c03f92fd93f0bccebeff87928581da5e13079c83238adc89e466ebfaca"; // TaxesPaid(uint256,uint256)
const TOPIC_AUDITED = "0xee1e30708b892ceb30b2a542bccb9a10c605f220dd821cc582226d1fbeea4f6f";    // Audited(uint256,uint256,uint256)

const DEFAULT_EPOCHS = 10;
const LOG_RANGE = 8000n; // getLogs block-range chunk (keeps each request under RPC caps)

// --- args ---
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const epochsArg = (() => {
  const i = args.indexOf("--epochs");
  return i >= 0 && args[i + 1] ? BigInt(args[i + 1]) : BigInt(DEFAULT_EPOCHS);
})();

// --- resolve RPC URL ---
function resolveRpc() {
  if (process.env.RPC_HTTP_URL) return process.env.RPC_HTTP_URL;
  const key =
    process.env.ALCHEMY_API_KEY ||
    (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).alchemyApiKey;
      } catch {
        return null;
      }
    })();
  if (!key) {
    console.error(
      "No RPC configured. Set RPC_HTTP_URL or ALCHEMY_API_KEY, or save an Alchemy key in the app first.",
    );
    process.exit(1);
  }
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}
const RPC = resolveRpc();

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function rpcBatch(reqs) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqs),
  });
  return r.json();
}

const hexBlk = (n) => "0x" + n.toString(16);
const topicOf = (t) => "0x" + BigInt(t).toString(16).padStart(64, "0");
const eth = (wei) => (Number(wei) / 1e18).toFixed(6);

async function ethCall(to, data, block = "latest") {
  return rpc("eth_call", [{ to, data }, block]);
}
async function blockTs(n) {
  return BigInt((await rpc("eth_getBlockByNumber", [hexBlk(n), false])).timestamp);
}
/** First block whose timestamp is >= ts. Bounded binary search behind `latest`. */
async function firstBlockAtOrAfter(ts, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await blockTs(mid)) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Chunked eth_getLogs over [from, to] so a wide window can't blow the range cap. */
async function getLogsChunked(from, to, topics) {
  const out = [];
  for (let f = from; f <= to; f += LOG_RANGE) {
    const t = f + LOG_RANGE - 1n > to ? to : f + LOG_RANGE - 1n;
    out.push(...(await rpc("eth_getLogs", [{ address: GAME, fromBlock: hexBlk(f), toBlock: hexBlk(t), topics }])));
  }
  return out;
}

async function main() {
  const rivals = JSON.parse(fs.readFileSync(path.join(dataDir, "rival-targets.json"), "utf8"));
  const skippers = new Set(JSON.parse(fs.readFileSync(path.join(dataDir, "rival-skippers.json"), "utf8")));
  const rivalTopics = rivals.map(topicOf);

  const latest = BigInt(parseInt(await rpc("eth_blockNumber", []), 16));
  const currentEpoch = BigInt(await ethCall(GAME, SEL_CURRENT_EPOCH));
  const startTime = BigInt(await ethCall(GAME, SEL_START_TIME));
  const firstEpoch = currentEpoch - epochsArg + 1n > 2n ? currentEpoch - epochsArg + 1n : 2n;
  const windowTs = startTime + (firstEpoch - 1n) * EPOCH_DURATION;
  const startBlock = await firstBlockAtOrAfter(windowTs, latest - 100000n > 1n ? latest - 100000n : 1n, latest);

  console.error(
    `Scanning epochs ${firstEpoch}..${currentEpoch} — blocks ${startBlock}..${latest} ` +
      `(${latest - startBlock} blocks, ${rivals.length} rivals)`,
  );

  // 1) Rival tax payments, and every successful audit in the window.
  const payLogs = await getLogsChunked(startBlock, latest, [TOPIC_TAXES_PAID, rivalTopics]);
  const auditLogs = await getLogsChunked(startBlock, latest, [TOPIC_AUDITED]);
  const auditedCount = {};
  for (const l of auditLogs) {
    const target = BigInt(l.topics[2]).toString();
    auditedCount[target] = (auditedCount[target] || 0) + 1;
  }
  const payments = payLogs.map((l) => ({
    token: BigInt(l.topics[1]).toString(),
    tx: l.transactionHash,
    block: BigInt(l.blockNumber),
  }));
  const blocks = [...new Set(payments.map((p) => p.block.toString()))].map(BigInt);
  console.error(`Found ${payments.length} rival payments across ${blocks.length} blocks; tracing…`);
  if (payments.length === 0) {
    console.log("No rival payments in window.");
    return;
  }

  // 2) Sender + gas tip per payment tx; miner + baseFee per block.
  const txs = [...new Set(payments.map((p) => p.tx))];
  const txMeta = new Map();
  const blockMeta = new Map();
  for (let i = 0; i < txs.length; i += 80) {
    const slice = txs.slice(i, i + 80);
    const reqs = [];
    slice.forEach((t, k) => {
      reqs.push({ jsonrpc: "2.0", id: (i + k) * 2 + 1, method: "eth_getTransactionByHash", params: [t] });
      reqs.push({ jsonrpc: "2.0", id: (i + k) * 2 + 2, method: "eth_getTransactionReceipt", params: [t] });
    });
    const by = new Map((await rpcBatch(reqs)).map((r) => [r.id, r]));
    slice.forEach((t, k) => {
      const tx = by.get((i + k) * 2 + 1)?.result;
      const rc = by.get((i + k) * 2 + 2)?.result;
      if (tx && rc) {
        txMeta.set(t, {
          from: tx.from.toLowerCase(),
          to: (tx.to || "").toLowerCase(),
          gasUsed: BigInt(rc.gasUsed),
          effGasPrice: BigInt(rc.effectiveGasPrice),
          txIndex: Number(BigInt(rc.transactionIndex)),
        });
      }
    });
  }
  for (let i = 0; i < blocks.length; i += 80) {
    const slice = blocks.slice(i, i + 80);
    const reqs = slice.map((b, k) => ({ jsonrpc: "2.0", id: i + k, method: "eth_getBlockByNumber", params: [hexBlk(b), false] }));
    const by = new Map((await rpcBatch(reqs)).map((r) => [r.id, r]));
    slice.forEach((b, k) => {
      const bl = by.get(i + k)?.result;
      if (bl) blockMeta.set(b.toString(), { miner: bl.miner.toLowerCase(), baseFee: BigInt(bl.baseFeePerGas ?? "0x0") });
    });
  }

  // 3) Trace each payment block: sum internal ETH sent to that block's coinbase, keyed by
  //    (block, top-level sender). Keying by sender — not just by tx — also catches a bid
  //    paid by a bundle-mate tx from the same EOA rather than inside the payTaxes tx.
  const cbByBlockSender = new Map();
  let traced = 0;
  for (const b of blocks) {
    const bkey = b.toString();
    const miner = blockMeta.get(bkey)?.miner;
    if (!miner) continue;
    let traces;
    try {
      traces = await rpc("trace_block", [hexBlk(b)]);
    } catch (err) {
      console.error(
        `\ntrace_block unavailable (${err.message}).\n` +
          "This script needs a tracing-capable RPC; bid detection cannot run without it.",
      );
      process.exit(1);
    }
    const senderOfTx = new Map();
    for (const tr of traces) {
      if (tr.type === "call" && (tr.traceAddress?.length ?? 0) === 0 && tr.transactionHash) {
        senderOfTx.set(tr.transactionHash, (tr.action?.from || "").toLowerCase());
      }
    }
    for (const tr of traces) {
      if (tr.type !== "call" || !tr.transactionHash) continue;
      const to = (tr.action?.to || "").toLowerCase();
      const val = tr.action?.value ? BigInt(tr.action.value) : 0n;
      if (to !== miner || val <= 0n) continue;
      const sender = senderOfTx.get(tr.transactionHash) || (tr.action?.from || "").toLowerCase();
      const k = `${bkey}:${sender}`;
      cbByBlockSender.set(k, (cbByBlockSender.get(k) || 0n) + val);
    }
    if (++traced % 25 === 0) console.error(`  traced ${traced}/${blocks.length} blocks…`);
  }

  // 4) Aggregate per token. `bidPays` counts this token's payments that rode a
  //    coinbase-paying bundle; `bidWei` is the operator's coinbase spend in those
  //    (block, sender) groups — SHARED across every token co-paid in the same group,
  //    so it is operator spend, not per-token spend.
  const perToken = new Map();
  for (const p of payments) {
    const meta = txMeta.get(p.tx);
    const bmeta = blockMeta.get(p.block.toString());
    const m =
      perToken.get(p.token) ||
      { pays: 0, bidPays: 0, bidWei: 0n, tipWei: 0n, gasUsed: 0n, bestIdx: Infinity, senders: new Set(), payTo: new Set(), groups: new Set() };
    m.pays++;
    if (meta && bmeta) {
      const tip = (meta.effGasPrice - bmeta.baseFee) * meta.gasUsed;
      m.tipWei += tip > 0n ? tip : 0n;
      m.gasUsed += meta.gasUsed;
      m.senders.add(meta.from);
      m.payTo.add(meta.to);
      m.bestIdx = Math.min(m.bestIdx, meta.txIndex);
      const gkey = `${p.block}:${meta.from}`;
      const cb = cbByBlockSender.get(gkey) || 0n;
      if (cb > 0n) {
        m.bidPays++;
        if (!m.groups.has(gkey)) {
          m.bidWei += cb;
          m.groups.add(gkey);
        }
      }
    }
    perToken.set(p.token, m);
  }

  const rows = [...perToken.entries()]
    .map(([token, m]) => ({
      token,
      pays: m.pays,
      bidPays: m.bidPays,
      bidEth: eth(m.bidWei),
      audited: auditedCount[token] || 0,
      tipGwei: m.gasUsed > 0n ? Number(m.tipWei) / Number(m.gasUsed) / 1e9 : 0,
      bestIdx: m.bestIdx === Infinity ? null : m.bestIdx,
      pinnedSkipper: skippers.has(token),
      senders: [...m.senders],
      payTo: [...m.payTo],
      // Bids on every payment AND never successfully audited by anyone => structurally
      // immune, not merely expensive. These are the EXCLUDED candidates.
      immune: m.bidPays === m.pays && m.bidPays > 0 && (auditedCount[token] || 0) === 0,
    }))
    .sort((a, b) => b.bidPays - a.bidPays || Number(b.bidEth) - Number(a.bidEth) || b.tipGwei - a.tipGwei);

  if (asJson) {
    console.log(JSON.stringify({ firstEpoch: Number(firstEpoch), currentEpoch: Number(currentEpoch), rows }, null, 2));
    return;
  }

  console.log(`\n=== Rival builder-payment usage, epochs ${firstEpoch}..${currentEpoch} (${payments.length} payments) ===`);
  console.log("bidPays = payments that rode a coinbase-paying bundle · bidETH = operator coinbase spend (shared across co-paid tokens)");
  console.log("audited = times ANY player successfully audited this token in the window · idx = best (lowest) tx index achieved\n");
  console.log("token      pays  bidPays      bidETH  audited  tipGwei  idx  skipper");
  for (const r of rows) {
    console.log(
      `#${r.token.padEnd(7)} ${String(r.pays).padStart(4)}  ${String(r.bidPays).padStart(7)}  ${r.bidEth.padStart(10)}  ` +
        `${String(r.audited).padStart(7)}  ${r.tipGwei.toFixed(1).padStart(7)}  ${String(r.bestIdx ?? "—").padStart(3)}  ` +
        `${r.pinnedSkipper ? "yes" : "-"}${r.immune ? "   <== IMMUNE" : ""}`,
    );
  }

  const immune = rows.filter((r) => r.immune);
  const immunePinned = immune.filter((r) => r.pinnedSkipper);
  console.log(`\nBuilder-bidding tokens: ${rows.filter((r) => r.bidPays > 0).map((r) => "#" + r.token).join(", ") || "none"}`);
  console.log(
    `Structurally immune (bid on every payment, never audited): ${immune.length ? immune.map((r) => "#" + r.token).join(", ") : "none"}`,
  );
  if (immunePinned.length > 0) {
    console.log(
      `\n⚠ ${immunePinned.length} immune token(s) are STILL on the skippers list — they will waste auditor slots.\n` +
        `  Add to EXCLUDED in scripts/rival-skippers.mjs and drop from data/rival-skippers.json:\n` +
        `  ${immunePinned.map((r) => `"${r.token}"`).join(", ")}`,
    );
  } else if (immune.length > 0) {
    console.log("\nAll immune tokens are already excluded from the skippers list. ✓");
  }
}

main().catch((err) => {
  console.error("rival-builder-bids scan failed:", err.message);
  process.exit(1);
});
