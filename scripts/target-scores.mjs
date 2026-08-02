// Rank rival citizens by how attractive they are to AUDIT.
//
// The strongest audit target is a rival whose owner can't afford to catch it up (so an
// audit may lead to a kill), that defends weakly (so you can actually land the audit),
// and that isn't shielded by a bribe. This scores EVERY LIVE RIVAL on those axes and ranks
// them — the full citizen set minus emigrants and minus allies, not just the curated
// data/rival-targets.json the bot pins for offense. Results are split into the known
// skippers (data/rival-skippers.json) and everyone else, so the non-skipper side shows
// every delinquent rival rather than only the handful that made the curated list.
//
// Columns:
//   beh       epochs behind now (2+ = auditable this instant; 1 = grace)
//   und       under audit already (can't be re-audited)
//   clean/caught  outcome of its skips: a "skip" is a boundary crossed 2+ behind, which
//             leaves the token auditable until it cures. clean = got away with it,
//             caught = an audit landed during that epoch, "of N" = skips attempted over
//             the window. 4 skips all clean = a proven-safe cadence and a hard target;
//             the same 4 with 3 caught = one that keeps getting punished, so punishing
//             it again is cheap. "-" = never crossed delinquent in the window.
//   bribe     bribe balance (each is one free audit-escape; lowers attractiveness)
//   ins       has life insurance (bailout risk — an audit may be undone by a bailout)
//   ownerBal  owner's ETH balance
//   cits      how many live citizens that owner holds (portfolio; thin = fragile)
//   runway    ownerBal / (cits * one-epoch tax) — epochs the owner can sustain
//   owesNext  what THIS token owes to catch up at the NEXT boundary
//   afford    can the owner cover owesNext right now?
//   tip/idx   defense strength from payment history: best (max) tip gwei, best (lowest)
//             tx index reached. Reaching idx 0 on TIP ALONE is expensive, not unbeatable
//             — see beatBid. Only a bid-backed idx 0 is genuinely out of reach.
//   beatBid   coinbase bid (ETH) needed to out-rank this rival's best observed DEFENSE
//             DENSITY — (coinbase bid + priority tips) / gas, the value-per-gas a builder
//             actually sorts on. Priced for a 1-payment + 1-audit bundle at our 20.1 gwei
//             tip. Density matters rather than the tip: #6749 tips 0.5 gwei but bid
//             0.0226 ETH, putting it at ~104 gwei/gas — pricing off the tip said it was
//             free to beat. A shared bid is spread over the whole bundle it bought
//             position for. "-" = its defense is already at or below our tip.
//   aud       times ANY player successfully audited it in the window (proven catchable)
//   bid       coinbase bid over the LAST 2 EPOCHS, as ETH x number of bid-backed payments.
//             A bid buys transaction position outright, so a bidder cures at index 0 and is
//             near-unauditable however strapped it looks. Shared when one operator co-pays
//             several citizens in a block. "?" = RPC has no trace_block.
//   score     composite audit-attractiveness (higher = better target). 0 = under audit,
//             on the do-not-target roster, or bid-backed top-of-block. NOTE a 0 can also
//             mean simply "catchable but not weak" (rich, defends hard, never yet
//             audited) — those stay in the paste lists, ranked last.
//
// Detection is on-chain only; it cannot see off-chain builder deals or pending mempool
// payments. An audit only STARTS a 24h timer — a bailout or a late payment can still
// save the target, so "strapped" is a probability, not a guarantee.
//
// Usage:
//   node scripts/target-scores.mjs                    # score every rival, ranked table
//   node scripts/target-scores.mjs --auditable-next   # only weak links auditable next boundary
//   node scripts/target-scores.mjs --epochs 20        # widen the cadence look-back
//   node scripts/target-scores.mjs --curated          # only data/rival-targets.json (old scope)
//   node scripts/target-scores.mjs --promote          # add newly-observed skippers to the list
//   node scripts/target-scores.mjs --json             # machine-readable dump (full set)
//   RPC_HTTP_URL=... node scripts/target-scores.mjs
//
// RPC URL resolves from: RPC_HTTP_URL env, ALCHEMY_API_KEY env, then data/settings.json
// (alchemyApiKey) — the same key the app uses. Needs the Alchemy NFT API for ownership.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

const GAME = "0xa448c7f618087dda1a3b128cad8a424fbae4b71f";
const EMIGRATION = "0xe56d011262d4738dc8307fb8a4ae48b2bfc20e7c"; // citizens here have left the game
const EPOCH_DURATION = 86400n;
// Our own bundle shape, for pricing what it costs to out-rank a rival's defense.
// Gas measured from real on-chain game txs: payTaxes ~82,875, audit ~130,409, plus the
// fixed 60,000 for the CoinbasePayer tx.
const OUR_BUNDLE_GAS = 82_875 + 130_409 + 60_000;
const OUR_TIP_GWEI = 20.1; // DEFAULT_STRATEGY.offensePriorityFeeGwei
const BASE = 690_000_000_000_000n; // BASE_TAX_RATE_WEI, 0.00069 ETH
const TAXES_PAID = "0xa13146c03f92fd93f0bccebeff87928581da5e13079c83238adc89e466ebfaca";
const AUDITED = "0xee1e30708b892ceb30b2a542bccb9a10c605f220dd821cc582226d1fbeea4f6f";
// selectors
const SEL = {
  currentEpoch: "0x76671808", startTime: "0x78e97925", citizens: "0x7c2e7201",
  lastEpochPaid: "0x72e012d6", auditDue: "0x608cf06b", bribeBalance: "0xca58643b",
  hasInsurance: "0x866ec147", auditLimit: "0xa1d726d9",
};

const args = process.argv.slice(2);
const asJson = args.includes("--json");
// --auditable-next: restrict to weak-link candidates that become auditable at the NEXT
// boundary — currently 1+ epoch behind and not already under audit, so they hit 2+
// behind (auditable) when the epoch rolls. Ranked by weak-link score, split skipper /
// non-skipper. Filtering happens after scoring, so --json still emits the full set.
const auditableNext = args.includes("--auditable-next");
// --curated: score only data/rival-targets.json instead of the full live rival set.
const curatedOnly = args.includes("--curated");
// --promote: persist newly-observed skippers into data/rival-skippers.json. The scan is
// otherwise strictly read-only, and that file feeds the bot's default target list, so
// writing it stays an explicit opt-in rather than a side effect of looking at the data.
const promote = args.includes("--promote");
const epochsArg = (() => { const i = args.indexOf("--epochs"); return i >= 0 && args[i + 1] ? BigInt(args[i + 1]) : 10n; })();

function resolveRpc() {
  if (process.env.RPC_HTTP_URL) return { rpc: process.env.RPC_HTTP_URL, nft: null };
  const key = process.env.ALCHEMY_API_KEY || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).alchemyApiKey; } catch { return null; }
  })();
  if (!key) { console.error("No RPC configured. Set RPC_HTTP_URL or ALCHEMY_API_KEY, or save an Alchemy key in the app."); process.exit(1); }
  return { rpc: `https://eth-mainnet.g.alchemy.com/v2/${key}`, nft: `https://eth-mainnet.g.alchemy.com/nft/v3/${key}` };
}
const { rpc: RPC, nft: NFT } = resolveRpc();

let id = 0;
async function rpc(m, p) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: m, params: p }) });
  const j = await r.json();
  if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function batch(reqs) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqs) });
  return r.json();
}
const hb = (n) => "0x" + n.toString(16);
const enc = (t) => BigInt(t).toString(16).padStart(64, "0");
const pad = (t) => "0x" + enc(t);
const eth = (w) => Number(w) / 1e18;
const call = (sel, t, blk = "latest") => rpc("eth_call", [{ to: GAME, data: sel + enc(t) }, blk]);

async function getLogsChunked(from, to, topics) {
  const out = [];
  for (let f = from; f <= to; f += 8000n) {
    const t = f + 7999n > to ? to : f + 7999n;
    out.push(...(await rpc("eth_getLogs", [{ address: GAME, fromBlock: hb(f), toBlock: hb(t), topics }])));
  }
  return out;
}
async function blockTs(n) { return BigInt((await rpc("eth_getBlockByNumber", [hb(n), false])).timestamp); }
async function lastBlockBefore(ts, lo, hi) { while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if ((await blockTs(mid)) < ts) lo = mid; else hi = mid - 1n; } return lo; }

async function main() {
  if (!NFT) { console.error("This script needs the Alchemy NFT API for ownership — set ALCHEMY_API_KEY, not just RPC_HTTP_URL."); process.exit(1); }
  const skipperSet = new Set(JSON.parse(fs.readFileSync(path.join(dataDir, "rival-skippers.json"), "utf8")).map(String));
  const allySet = new Set(JSON.parse(fs.readFileSync(path.join(dataDir, "ally-tokens.json"), "utf8")).map(String));
  const curatedSet = new Set(JSON.parse(fs.readFileSync(path.join(dataDir, "rival-targets.json"), "utf8")).map(String));
  // "Do not target" — big-boy operators we never audit, grouped by who runs them.
  const dntOwners = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, "do-not-target.json"), "utf8")).owners ?? {}; }
    catch { return {}; }
  })();
  const dntOwnerOf = new Map();
  for (const [name, ids] of Object.entries(dntOwners)) for (const id of ids) dntOwnerOf.set(String(id), name);

  const ce = BigInt(await call(SEL.currentEpoch, 0n).then((x) => x));
  const startTime = BigInt(await rpc("eth_call", [{ to: GAME, data: SEL.startTime }, "latest"]));
  const citizens = "0x" + (await rpc("eth_call", [{ to: GAME, data: SEL.citizens }, "latest"])).slice(26);
  const latest = BigInt(parseInt(await rpc("eth_blockNumber", []), 16));
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const epochTax = ce * BASE;
  const nextBoundary = startTime + ce * EPOCH_DURATION;

  // Ownership for the whole live set (one owner index page).
  const d = await (await fetch(`${NFT}/getOwnersForContract?contractAddress=${citizens}&withTokenBalances=true`)).json();
  const ownerOf = new Map(); const portfolio = new Map();
  for (const o of d.owners ?? []) {
    const a = o.ownerAddress.toLowerCase();
    for (const b of o.tokenBalances ?? []) { ownerOf.set(BigInt(b.tokenId).toString(), a); portfolio.set(a, (portfolio.get(a) ?? 0) + 1); }
  }

  // The scan universe is EVERY live rival — the whole citizen set minus emigrants (they've
  // left the game) and minus allies. It is deliberately NOT data/rival-targets.json: that
  // list is a curated subset the bot pins for offense, so scoring only it made the analysis
  // blind to any delinquent rival outside it (and, since most of the curated list is on the
  // skippers roster, made "non-skippers" look far smaller than it is). --curated restores
  // the old narrow behaviour.
  const universe = [...ownerOf.keys()].filter((t) => ownerOf.get(t) !== EMIGRATION.toLowerCase() && !allySet.has(t));
  const rivals = (curatedOnly ? universe.filter((t) => curatedSet.has(t)) : universe).sort((a, b) => Number(a) - Number(b));
  if (!asJson) {
    const extra = rivals.filter((t) => !curatedSet.has(t)).length;
    console.log(`Scanning ${rivals.length} live rivals (${ownerOf.size} citizens − emigrants − allies)${extra ? `, ${extra} beyond the curated rival list` : ""}.\n`);
  }

  // Per-token state, batched.
  const reqs = []; const map = []; let lid = 0;
  for (const t of rivals) for (const [k, sel] of [["lep", SEL.lastEpochPaid], ["due", SEL.auditDue], ["bribe", SEL.bribeBalance], ["ins", SEL.hasInsurance]]) {
    reqs.push({ jsonrpc: "2.0", id: ++lid, method: "eth_call", params: [{ to: GAME, data: sel + enc(t) }, "latest"] }); map.push({ t, k, id: lid });
  }
  const byId = new Map((await batch(reqs)).map((r) => [r.id, r]));
  const st = {}; for (const t of rivals) st[t] = {};
  for (const m of map) { const r = byId.get(m.id); if (r && r.result && r.result !== "0x") st[m.t][m.k] = BigInt(r.result); }

  // Owner balances.
  const owners = [...new Set(rivals.map((t) => ownerOf.get(t)).filter(Boolean))];
  const balById = new Map((await batch(owners.map((a, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_getBalance", params: [a, "latest"] })))).map((r) => [r.id, r]));
  const balance = new Map(); owners.forEach((a, i) => balance.set(a, BigInt(balById.get(i + 1)?.result ?? "0x0")));

  // Payment history: defense strength (max tip, best index) + audited count over window.
  const from = latest - epochsArg * 6600n - 2000n; // ~epochs * 1 day of blocks
  const payLogs = await getLogsChunked(from, latest, [TAXES_PAID, rivals.map(pad)]);
  const auditLogs = await getLogsChunked(from, latest, [AUDITED, null, rivals.map(pad)]);
  const auditedCount = {}; for (const l of auditLogs) { const k = BigInt(l.topics[2]).toString(); auditedCount[k] = (auditedCount[k] ?? 0) + 1; }
  const txs = [...new Set(payLogs.map((l) => l.transactionHash))];
  const meta = new Map();
  for (let i = 0; i < txs.length; i += 60) {
    const slice = txs.slice(i, i + 60); const rq = [];
    slice.forEach((t, k) => { rq.push({ jsonrpc: "2.0", id: (i + k) * 2 + 1, method: "eth_getTransactionReceipt", params: [t] }); rq.push({ jsonrpc: "2.0", id: (i + k) * 2 + 2, method: "eth_getTransactionByHash", params: [t] }); });
    const m2 = new Map((await batch(rq)).map((r) => [r.id, r]));
    slice.forEach((t, k) => { const rc = m2.get((i + k) * 2 + 1)?.result; if (rc) meta.set(t, { gasUsed: BigInt(rc.gasUsed), eff: BigInt(rc.effectiveGasPrice), idx: Number(BigInt(rc.transactionIndex)), blk: BigInt(rc.blockNumber), from: (rc.from || "").toLowerCase() }); });
  }
  const blks = [...new Set([...meta.values()].map((m) => m.blk.toString()))];
  const bf = new Map();
  for (let i = 0; i < blks.length; i += 60) { const slice = blks.slice(i, i + 60); const m2 = new Map((await batch(slice.map((b, k) => ({ jsonrpc: "2.0", id: i + k, method: "eth_getBlockByNumber", params: [hb(BigInt(b)), false] })))).map((r) => [r.id, r])); slice.forEach((b, k) => { const bl = m2.get(i + k)?.result; if (bl) bf.set(b, BigInt(bl.baseFeePerGas ?? "0x0")); }); }
  const defense = {};
  for (const l of payLogs) { const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue; const tipG = Number(m.eff - (bf.get(m.blk.toString()) ?? 0n)) / 1e9; const dd = (defense[tok] ??= { maxTip: 0, bestIdx: Infinity, pays: 0 }); dd.pays++; dd.maxTip = Math.max(dd.maxTip, tipG); dd.bestIdx = Math.min(dd.bestIdx, m.idx); }

  // Skip cadence: sample lastEpochPaid at the last block of each prior epoch (same method
  // as rival-skippers.mjs). crossings = boundaries the token was 2+ behind entering.
  const firstEpoch = ce - epochsArg + 1n > 2n ? ce - epochsArg + 1n : 2n;
  const crossings = {}; const sampled = {}; const crossedIn = {};
  for (const t of rivals) { crossings[t] = 0; sampled[t] = 0; crossedIn[t] = new Set(); }
  const epochFirstBlock = new Map(); // epoch -> first block of that epoch
  for (let E = firstEpoch; E <= ce; E++) {
    const bts = startTime + (E - 1n) * EPOCH_DURATION;
    const lastB = await lastBlockBefore(bts, latest - 100000n > 1n ? latest - 100000n : 1n, latest);
    epochFirstBlock.set(E.toString(), lastB + 1n); // first block of epoch E = block after the last of E-1
    const rq = rivals.map((t, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: GAME, data: SEL.lastEpochPaid + enc(t) }, hb(lastB)] }));
    const m2 = new Map((await batch(rq)).map((r) => [r.id, r]));
    rivals.forEach((t, i) => {
      const r = m2.get(i + 1);
      if (r && r.result && r.result !== "0x") {
        sampled[t]++;
        // Remember WHICH epochs it skipped into, not just how many — the outcome of each
        // skip is decided by what happened during that specific epoch.
        if (BigInt(r.result) + 2n <= E) { crossings[t]++; crossedIn[t].add(E.toString()); }
      }
    });
  }

  // Did each skip actually get away with it?
  //
  // Crossing a boundary 2+ behind is a deliberate bet: the token is auditable from that
  // instant until it cures, and it either slips through or gets caught. A raw crossing
  // count can't tell those apart — a rival with 5/10 that was never audited is running a
  // proven-safe cadence (hard target), while 5/10 with 4 audits is one that keeps getting
  // punished (soft target, and cheap to punish again). Attribute every Audited event to
  // the epoch it landed in and match it against that token's crossings.
  const auditedInEpoch = {}; // token -> Set(epoch)
  for (const l of auditLogs) {
    const tok = BigInt(l.topics[2]).toString();
    const blk = BigInt(l.blockNumber);
    for (let E = ce; E >= firstEpoch; E--) {
      const fb = epochFirstBlock.get(E.toString());
      if (fb !== undefined && blk >= fb) { (auditedInEpoch[tok] ??= new Set()).add(E.toString()); break; }
    }
  }
  const skipCaught = {};
  for (const t of rivals) {
    let caught = 0;
    for (const E of crossedIn[t]) if (auditedInEpoch[t]?.has(E)) caught++;
    skipCaught[t] = caught;
  }

  // Payment timing: for each tax payment, how many blocks AFTER that epoch's boundary it
  // landed (offset 0 = paid in the boundary block itself). This is the audit window — a
  // rival that always pays at +0/+1 can only be caught in the boundary block; one that
  // pays 30+ blocks in is catchable comfortably mid-epoch. Reported as fastest / median.
  const payOff = {}; // token -> [offsets]
  for (const l of payLogs) {
    const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue;
    let off = null;
    for (let E = ce; E >= firstEpoch; E--) { const fb = epochFirstBlock.get(E.toString()); if (fb !== undefined && m.blk >= fb) { off = Number(m.blk - fb); break; } }
    if (off !== null && off >= 0) (payOff[tok] ??= []).push(off);
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2); };

  // Coinbase bids over the LAST 2 EPOCHS. A bid is an internal ETH transfer to
  // block.coinbase riding the payment's bundle — it buys transaction position outright,
  // so a rival that bids can cure at index 0 and is effectively unauditable regardless of
  // how strapped it looks. Deliberately a short window: current behaviour is what matters
  // for the upcoming boundary, and tracing is the expensive part of this scan.
  //
  // Attribution is by (block, top-level sender), so a bid paid by a bundle-mate tx counts
  // for its sender. When one operator pays several citizens in a single block the bid is
  // SHARED — each co-paid token reports the same operator spend, not a per-token cost.
  //
  // Degrades to null (shown "?") if the RPC has no trace_block: this scan backs the
  // dashboard, so a missing premium method must not fail the whole run.
  const bidEpochStart = ce - 1n > firstEpoch ? ce - 1n : firstEpoch;
  const bidWindowStart = epochFirstBlock.get(bidEpochStart.toString()) ?? latest;
  const recentPays = payLogs.filter((l) => BigInt(l.blockNumber) >= bidWindowStart);
  const bidBlocks = [...new Set(recentPays.map((l) => BigInt(l.blockNumber).toString()))].map(BigInt);
  const bidByToken = {}; // token -> { wei, pays }
  // Hoisted: the density calculation below needs the per-(block, sender) coinbase totals,
  // not just the per-token sums.
  const cbByBlockSender = new Map();
  let tracingOk = true;
  if (bidBlocks.length > 0) {
    const minerOf = new Map();
    for (let i = 0; i < bidBlocks.length; i += 60) {
      const slice = bidBlocks.slice(i, i + 60);
      const m = new Map((await batch(slice.map((b, k) => ({ jsonrpc: "2.0", id: i + k, method: "eth_getBlockByNumber", params: [hb(b), false] })))).map((r) => [r.id, r]));
      slice.forEach((b, k) => { const bl = m.get(i + k)?.result; if (bl) minerOf.set(b.toString(), bl.miner.toLowerCase()); });
    }
    for (const b of bidBlocks) {
      const miner = minerOf.get(b.toString()); if (!miner) continue;
      let traces;
      try { traces = await rpc("trace_block", [hb(b)]); }
      catch { tracingOk = false; break; } // no tracing on this RPC — report unknown
      const senderOfTx = new Map();
      for (const tr of traces) if (tr.type === "call" && (tr.traceAddress?.length ?? 0) === 0 && tr.transactionHash) senderOfTx.set(tr.transactionHash, (tr.action?.from || "").toLowerCase());
      for (const tr of traces) {
        if (tr.type !== "call" || !tr.transactionHash) continue;
        const to = (tr.action?.to || "").toLowerCase(); const val = tr.action?.value ? BigInt(tr.action.value) : 0n;
        if (to !== miner || val <= 0n) continue;
        const s = senderOfTx.get(tr.transactionHash) || (tr.action?.from || "").toLowerCase();
        const k = `${b}:${s}`;
        cbByBlockSender.set(k, (cbByBlockSender.get(k) ?? 0n) + val);
      }
    }
    if (tracingOk) {
      for (const l of recentPays) {
        const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue;
        const wei = cbByBlockSender.get(`${m.blk}:${m.from}`) ?? 0n;
        if (wei <= 0n) continue;
        const e = (bidByToken[tok] ??= { wei: 0n, pays: 0 });
        e.wei += wei; e.pays++;
      }
    }
  }

  // Defense DENSITY in gwei per gas — the number a builder actually sorts on, and so the
  // real bar to clear.
  //
  // For a tip-only payer this is simply its priority tip (tips / gas === tip). For a
  // BIDDER it is (coinbase bid + priority tips) / gas, which can be orders of magnitude
  // higher: #6749 tips 0.5 gwei but paid a 0.0226 ETH bid on one ~83k-gas payment, i.e.
  // ~270 gwei/gas. Pricing off the tip alone said that rival was free to out-rank, which
  // is the opposite of the truth — the bid is precisely what makes it hard.
  //
  // Gas is summed per (block, sender) so a shared bid is spread over the whole bundle it
  // actually bought position for, matching how the bid itself is attributed. A batch
  // payment emits one TaxesPaid per citizen from ONE tx, so gas is counted once per tx.
  const bidDensity = {}; // token -> max gwei/gas observed on a bid-backed payment
  if (tracingOk) {
    const group = new Map(); // "blk:sender" -> { gas, tips, txs }
    for (const l of recentPays) {
      const m = meta.get(l.transactionHash);
      if (!m) continue;
      const k = `${m.blk}:${m.from}`;
      const g = group.get(k) ?? { gas: 0n, tips: 0n, txs: new Set() };
      if (!g.txs.has(l.transactionHash)) {
        g.txs.add(l.transactionHash);
        g.gas += m.gasUsed;
        g.tips += (m.eff - (bf.get(m.blk.toString()) ?? 0n)) * m.gasUsed;
      }
      group.set(k, g);
    }
    for (const l of recentPays) {
      const tok = BigInt(l.topics[1]).toString();
      const m = meta.get(l.transactionHash);
      if (!m) continue;
      const k = `${m.blk}:${m.from}`;
      const bidWei = cbByBlockSender.get(k) ?? 0n;
      const g = group.get(k);
      if (bidWei <= 0n || !g || g.gas === 0n) continue;
      const gweiPerGas = Number(((bidWei + g.tips) * 1000n) / g.gas) / 1000 / 1e9;
      bidDensity[tok] = Math.max(bidDensity[tok] ?? 0, gweiPerGas);
    }
  }

  // Score each live, non-emigrated rival.
  const rows = [];
  for (const t of rivals) {
    const owner = ownerOf.get(t) ?? null;
    if (!owner || owner === EMIGRATION) continue; // dead/burned or emigrated: not a target
    const s = st[t]; const lep = s.lep ?? 0n;
    const behind = ce > lep ? Number(ce - lep) : 0;
    const due = s.due ?? 0n;
    const under = due > 0n;
    const bribes = Number(s.bribe ?? 0n);
    const ins = (s.ins ?? 0n) !== 0n;
    const bal = balance.get(owner) ?? 0n;
    const cits = portfolio.get(owner) ?? 0;
    const runway = cits > 0 ? eth(bal) / eth(BigInt(cits) * epochTax) : Infinity;
    const behindNext = (ce + 1n) > lep ? (ce + 1n) - lep : 0n;
    const owesNext = behindNext * (ce + 1n) * BASE;
    const affordNext = bal >= owesNext;
    const dd = defense[t] ?? { maxTip: 0, bestIdx: Infinity, pays: 0 };
    const bestIdx = dd.bestIdx === Infinity ? null : dd.bestIdx;
    const aud = auditedCount[t] ?? 0;
    // DO NOT TARGET. Two independent reasons, both meaning an audit slot spent here is
    // wasted: it is on the curated roster of big-boy operators, or the history shows it
    // reaches top-of-block and nobody has ever audited it. The curated list is the wider
    // net — several listed tokens land at index 2-15 and HAVE been audited, so evidence
    // alone would never have flagged them.
    const dntOwner = dntOwnerOf.get(t) ?? null;
    // Evidence-based "can't catch it": tops the block, never been audited, AND buys that
    // position with a coinbase bid. The bid clause matters — a token that reaches index 0
    // on PRIORITY FEE alone is not uncatchable, just expensive: builders order by value
    // per gas, so a coinbase bid outranks any tip you care to name. Flagging those hid
    // genuinely reachable targets (#2711 defends at 90 gwei with no bid — about 0.019 ETH
    // of bid beats it). Only a rival already paying for position is out of reach.
    const bidBacked = (bidByToken[t]?.pays ?? 0) > 0;
    const uncatchable = bestIdx !== null && bestIdx <= 1 && aud === 0 && bidBacked;
    const doNotTarget = dntOwner !== null || uncatchable;
    const dntReason = dntOwner !== null ? "listed" : uncatchable ? "evidence" : null;

    let score = 0;
    if (!under && !doNotTarget) {
      if (!affordNext) score += 3;                                  // can't cover next catch-up
      score += Math.max(0, Math.min(1, (10 - runway) / 10)) * 2;    // low runway
      score += Math.max(0, Math.min(1, (30 - dd.maxTip) / 30)) * 1.5; // weak tip
      if (bestIdx !== null) score += Math.min(1, bestIdx / 50);     // lands late in the block
      if (aud > 0) score += 1;                                      // proven catchable
      if (bribes > 0) score -= 1;                                   // free escape
      score = Math.max(0, score);
    }
    // What a coinbase bid would have to cover to out-rank this token's best observed
    // defense. The bar is its DENSITY, not its tip: a bidder's tip can be near zero while
    // the bid puts it hundreds of gwei/gas ahead. Take the stronger of the two signals,
    // then let our own tip cover what it can. Sized for one payment + one audit + the
    // payer tx (measured on-chain: 82,875 + 130,409 + 60,000 gas) at the default 20.1 gwei
    // tip. Rough by nature — it cannot see off-chain builder deals, and a bid observed in
    // the 2-epoch window may not be repeated.
    const defenseGwei = Math.max(dd.maxTip, bidDensity[t] ?? 0);
    const beatBidEth = defenseGwei > OUR_TIP_GWEI
      ? +(((defenseGwei - OUR_TIP_GWEI) * OUR_BUNDLE_GAS) / 1e9).toFixed(4)
      : 0;
    // The measurement is contradicted by the outcome: it reached the top of the block
    // while measuring BELOW our own tip, which cannot happen on merit. Something bought
    // that position where we can't see it — a bid older than the 2-epoch trace window
    // (the roster's 0.08 ETH bidders read 3.1 gwei here for exactly that reason), or an
    // off-chain builder deal. Reporting "no bid needed" for these would be a lie, so the
    // column says unknown instead.
    const defenseUnexplained = bestIdx !== null && bestIdx <= 1 && beatBidEth === 0;
    const offs = payOff[t] ?? [];
    const payBlkMin = offs.length ? Math.min(...offs) : null; // fastest cure after a boundary
    const payBlkMed = median(offs);                            // typical audit window
    rows.push({
      token: t,
      // A skipper is anything that has ATTEMPTED a skip in the window — crossed a
      // boundary 2+ behind, whether or not it got away with it. Derived from the scan
      // rather than read from data/rival-skippers.json, so a rival that started skipping
      // yesterday is classified correctly the moment anyone runs this, with no list to
      // regenerate and no per-user setup. The file still counts (a token may have skipped
      // outside this window), so it's a union, and `skipperSource` says which.
      skipper: skipperSet.has(t) || crossings[t] > 0,
      skipperSource: crossings[t] > 0 ? (skipperSet.has(t) ? "both" : "observed") : "listed",
      behind, under, killable: under && due <= nowSec,
      crossings: crossings[t], sampled: sampled[t],
      // Outcome of those crossings: caught = a skip that drew an audit that same epoch.
      skipCaught: skipCaught[t], skipClean: crossings[t] - skipCaught[t],
      bribes, ins,
      ownerBalEth: +eth(bal).toFixed(4), cits, runwayEpochs: runway === Infinity ? null : +runway.toFixed(1),
      owesNextEth: +eth(owesNext).toFixed(4), affordNext, maxTip: +dd.maxTip.toFixed(1), bestIdx,
      payBlkMin, payBlkMed, audited: aud, beatBidEth, defenseUnexplained,
      // The density that beatBidEth is priced against, in gwei/gas — max(tip, bid density).
      defenseGwei: +defenseGwei.toFixed(1),
      doNotTarget, dntReason, dntOwner, uncatchable,
      score: +score.toFixed(2),
      // Coinbase bidding over the last 2 epochs. null = RPC has no tracing (unknown).
      bidEth: tracingOk ? +eth(bidByToken[t]?.wei ?? 0n).toFixed(6) : null,
      bidPays: tracingOk ? (bidByToken[t]?.pays ?? 0) : null,
    });
  }

  const hoursToBoundary = Number(nextBoundary - nowSec) / 3600;
  if (asJson) { console.log(JSON.stringify({ epoch: Number(ce), hoursToNextBoundary: +hoursToBoundary.toFixed(1), epochTaxEth: eth(epochTax), rows }, null, 2)); return; }

  // Skips as clean/caught out of attempted. "3/1 of 4" = crossed delinquent 4 times,
  // got away with 3, was audited during 1. 0 attempts prints as "-".
  const skipCol = (r) =>
    (r.crossings === 0 ? "-" : `${r.skipClean}/${r.skipCaught} of ${r.crossings}`).padStart(11);
  const payBlkCol = (r) => (r.payBlkMin === null ? "-" : `${r.payBlkMin}/${r.payBlkMed}`).padStart(9);
  // What a coinbase bid must cover to out-rank this rival's best observed defense.
  const beatCol = (r) =>
    (r.beatBidEth > 0 ? r.beatBidEth.toFixed(4) : r.defenseUnexplained ? "?" : "-").padStart(7);
  const bidCol = (r) => (r.bidEth === null ? "?" : r.bidEth > 0 ? `${r.bidEth.toFixed(4)}×${r.bidPays}` : "-").padStart(8);
  const fmt = (r) =>
    `#${r.token.padEnd(5)} ${String(r.behind).padStart(3)} ${r.under ? "A" : "-"} ${skipCol(r)} ${String(r.bribes).padStart(2)}  ${r.ins ? "Y" : "-"}  ` +
    `${r.ownerBalEth.toFixed(4).padStart(8)} ${String(r.cits).padStart(3)} ${(r.runwayEpochs === null ? "inf" : r.runwayEpochs.toFixed(1)).padStart(6)}  ` +
    `${r.owesNextEth.toFixed(4)} ${(r.affordNext ? "yes" : "NO").padStart(4)}  ${r.maxTip.toFixed(1).padStart(5)} ${String(r.bestIdx ?? "-").padStart(4)} ${payBlkCol(r)} ${bidCol(r)} ${beatCol(r)} ${String(r.audited).padStart(3)}  ${r.score.toFixed(2).padStart(5)}`;
  const header = "tok    beh A  clean/caught br ins  ownerBal cit runway  owesNxt afrd  tip  idx    payBlk      bid beatBid aud  score";
  // beh column doubles as the timing cue: 1 = becomes auditable next boundary, 2+ = already auditable.

  // --auditable-next keeps only rows that will be auditable when the epoch rolls: 1+
  // behind and not already under audit. behind 1 -> 2 behind next -> newly auditable;
  // behind 2+ (and not under audit) is already auditable and stays so.
  const pool = auditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows;
  // Listed "do not target" rivals get their own section and are removed from the two
  // target sections entirely — they are not candidates, so ranking them among candidates
  // only invites a misread. Evidence-flagged rows STAY in place (greyed by a 0 score):
  // that flag is a judgement the data might revise, not a standing instruction.
  // Deliberately built from `rows`, not `pool`: this section is a reference roster, so
  // --auditable-next must not hide the big boys that happen not to be delinquent today.
  const listed = rows.filter((r) => r.dntOwner !== null)
    .sort((a, b) => a.dntOwner.localeCompare(b.dntOwner) || Number(a.token) - Number(b.token));
  const targetable = pool.filter((r) => r.dntOwner === null);
  const skippers = targetable.filter((r) => r.skipper).sort((a, b) => b.score - a.score);
  const others = targetable.filter((r) => !r.skipper).sort((a, b) => b.score - a.score);
  const scope = auditableNext
    ? `weak-link candidates becoming auditable at epoch ${ce + 1n}`
    : `ranked by audit-attractiveness`;
  console.log(`epoch ${ce} · next boundary in ${hoursToBoundary.toFixed(1)}h · one epoch of tax = ${eth(epochTax).toFixed(5)} ETH · window ${firstEpoch}..${ce}\n`);
  console.log(`=== RIVAL SKIPPERS (${skippers.length}) — ${scope} ===`);
  console.log(header); skippers.forEach((r) => console.log(fmt(r)));
  console.log(`\n=== OTHER RIVALS (${others.length}) — not on the skippers list, ${scope} ===`);
  console.log(header); others.forEach((r) => console.log(fmt(r)));

  // DO NOT TARGET — the curated big-boy roster, always shown in full. Their live state
  // still matters (a big boy drifting delinquent is worth knowing about), they are just
  // never offered as candidates. Pinning one by hand in the Strategy targets box still
  // audits it: the roster keeps them out of auto-discovery, it does not veto the user.
  if (listed.length > 0) {
    console.log(`\n=== DO NOT TARGET (${listed.length}) — big boys, excluded from the sections above ===`);
    console.log("operator     " + header);
    for (const r of listed) console.log(`${r.dntOwner.padEnd(12)} ` + fmt(r));
  }

  // Rivals this scan saw skipping that the saved list doesn't know about yet. The list is
  // a snapshot — only as current as the last regeneration — so a rival that started
  // skipping recently sits in the wrong section until someone notices. Surface them every
  // run, and let --promote write them in.
  const newlyObserved = rows
    .filter((r) => r.skipperSource === "observed" && r.dntOwner === null)
    .sort((a, b) => b.crossings - a.crossings || Number(a.token) - Number(b.token));
  if (newlyObserved.length > 0) {
    console.log(`\n--- newly observed skippers (${newlyObserved.length}) — attempted a skip, not yet on data/rival-skippers.json ---`);
    for (const r of newlyObserved) {
      console.log(`  #${r.token.padEnd(5)} ${r.skipClean}/${r.skipCaught} of ${r.crossings} skips · score ${r.score.toFixed(2)}`);
    }
    if (promote) {
      const merged = [...new Set([...skipperSet, ...newlyObserved.map((r) => r.token)])]
        .filter((t) => !dntOwnerOf.has(t) && !allySet.has(t))
        .sort((a, b) => Number(a) - Number(b));
      fs.writeFileSync(path.join(dataDir, "rival-skippers.json"), JSON.stringify(merged, null, 2) + "\n");
      console.log(`  -> promoted ${newlyObserved.length}; data/rival-skippers.json now holds ${merged.length}`);
    } else {
      console.log(`  (re-run with --promote to add them to data/rival-skippers.json)`);
    }
  }

  // Paste-ready target lists: catchable only (score > 0, drops uncatchable/under-audit),
  // ranked best-first, comma-separated for the offense target box.
  const ids = (list) => list.filter((r) => r.score > 0).map((r) => r.token).join(",");
  console.log(`\n--- paste (ranked, catchable only) ---`);
  console.log(`skippers    : ${ids(skippers) || "(none)"}`);
  console.log(`non-skippers: ${ids(others) || "(none)"}`);
  // Big boys as a paste too. Not a target list — it's there so the roster can be dropped
  // into the targets box deliberately (the roster is advice, and a pin overrides it), or
  // just copied out to compare against data/do-not-target.json.
  console.log(`big boys   : ${listed.map((r) => r.token).join(",") || "(none)"}`);

  if (auditableNext) {
    const best = pool.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    console.log(`\nTop weak links for epoch ${ce + 1n}: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none catchable"}`);
    console.log("beh 1 = becomes auditable next boundary · beh 2+ = already auditable · afrd NO = owner can't cover the catch-up · score 0 = uncatchable");
    console.log("clean/caught of N = skips (boundaries crossed 2+ behind) survived / caught by an audit, out of attempted — all-clean = proven-safe cadence, caught often = soft target");
    console.log("beatBid '-' = no bid needed, our 20.1 gwei tip already out-ranks its observed defense · '?' = it reaches top-of-block anyway, so something we cannot see is buying that position");
    console.log("beatBid = coinbase bid (ETH) to out-rank its best observed DENSITY ((bid + tips)/gas, what builders sort on) for a 1-pay + 1-audit bundle at our 20.1 gwei tip — a bidder's tip can be ~0 while its density is hundreds of gwei/gas");
    console.log("payBlk = blocks after the epoch boundary they paid (fastest / median) — the audit window; 0 = pays in the boundary block, '-' = no payment seen in window");
    console.log("bid = coinbase bid over the LAST 2 EPOCHS (ETH x bid-backed payments) — buys top-of-block, so a bidder is near-unauditable; shared when one operator co-pays several citizens; '?' = RPC has no tracing");
  }

  if (!auditableNext) {
    const best = [...rows].filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    console.log(`\nTop targets right now: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none auditable"}`);
    console.log("A = under audit · clean/caught of N = skips survived / skips that drew an audit, out of skips attempted · score 0 = uncatchable or under audit");
  }
}
main().catch((e) => { console.error("target-scores failed:", e.message); process.exit(1); });
