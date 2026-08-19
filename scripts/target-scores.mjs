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
//   beat2ep   coinbase bid (ETH) to out-rank its defense over the LAST 2 EPOCHS — the
//   beatMax   likely cost at the next boundary — and the same against its PEAK over the
//             whole window, i.e. the most it has ever mounted and so can mount again.
//             Read them together: equal means a steady defender and the number is
//             reliable; a gap means it escalates, and beatMax is what you must be
//             willing to pay to be sure. #5347 reads "-" / 0.0471 — nothing needed today,
//             but it has bid its way to 192 gwei/gas and could again.
//             Both price THE BUNDLE YOU PLAN TO SEND (--payments / --audits / --tip,
//             default 1+1 at the configured tip) against DENSITY — (coinbase bid +
//             priority tips) / gas, the value-per-gas a builder actually sorts on, not
//             the tip: #6749 tips 0.5 gwei but bids to ~149. A bid buys position for the
//             WHOLE bundle, so carrying 7 audits instead of 1 costs ~5x the bid to reach
//             the same density — set the flags to match what you will actually send.
//             A shared bid is spread over the whole bundle it bought position for.
//             "-" = nothing needed, our tip already out-ranks it. "·" = no payment seen
//             in that window. "?" and "!" both mean no price can be quoted, for two
//             DIFFERENT reasons — do not read them as the same thing:
//               "?" it reached top-of-block while measuring below our tip, but nothing
//                   denser was present to out-rank. Usually "it was the only bidder that
//                   block". The price is unknown; the model still holds.
//               "!" a block was seen ordering its bundle AHEAD of a materially denser one.
//                   That falsifies the density ordering the whole beat column rests on, so
//                   out-bidding may not be the lever here at all. This is the one to act on.
//             Measured over 10 boundary blocks (647 sender-groups): density predicts
//             ordering 87% of the time when computed per contiguous SENDER GROUP, and only
//             75% per individual tx — the group is the unit builders sort on. Accuracy is
//             very uneven by builder: BuilderNet 99%, solo geth 100%, Titan 80%,
//             Builder+ 79%. So a "!" concentrated on Titan/Builder+ blocks is expected
//             noise; one on BuilderNet is a real anomaly.
//             A bundle router earns "!" for a structural reason: batching 11 game actions
//             into ~1.05M gas divides its bid across 12x the gas of a lone payment, so it
//             reads WEAK here while still taking the slot.
//             A ceiling, not a forecast: off-chain builder deals are invisible at any
//             window length, and a peak from 8 epochs ago may never be repeated.
//   aud       times ANY player successfully audited it in the window (proven catchable)
//   theirBid  the RIVAL own coinbase bid, as now/-1/max in ETH (leading zero dropped, so
//             .042 = 0.042 ETH; "-" in a slot means no bid there). Not to be confused with
//             bid2ep/bidMax/bidBnd, which are what YOU would have to bid.
//             Three fields because one number cannot distinguish escalating from holding from
//             gone quiet: ".042/.042/.042" is a steady bidder you must price for every time,
//             "-/-/.042" is one that has stopped, and "-/.038/.042" is one that just did.
//             "now" is the CURRENT epoch, because the boundary for epoch N happens when epoch
//             N BEGINS — a rival's freshest defense lands in the current epoch, and labelling
//             it "-1" would hide it.
//             Read it next to beatMax, because it is usually the EXPLANATION for it. #2711
//             tips only 90 gwei yet costs 448 gwei to beat, which looks impossible until you
//             see the 0.0420 ETH bid it sends in a second transaction: over its small
//             110,820-gas group that bid alone is 379 gwei/gas, i.e. 85% of the 448.
//             This column deliberately reports the PEAK rather than a recent sum. It used to
//             show only the last 2 epochs, so a rival that bid hard four epochs ago and
//             coasted since read "-" while beatMax quoted a figure built from exactly that
//             bid — which reads as a bug in the tool rather than a lull in their defense.
//             A bid buys transaction position outright, so a bidder cures at index 0 and is
//             near-unauditable however strapped it looks. Shared when one operator co-pays
//             several citizens in a block. "?" = RPC has no trace_block.
//   score     composite audit-attractiveness (higher = better target). 0 = under audit,
//             bid-backed top-of-block. NOTE a 0 can also
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
//   node scripts/target-scores.mjs --payments 6 --audits 7   # price the bundle you'll send
//   node scripts/target-scores.mjs --audits 2 --tip 120      # ...and at a different tip
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
// Citizens held by ANY of these have left the main game. There are two routes now, and
// scoring only the first meant ABBC emigrants were still ranked as live targets — #1000
// came out 3rd-best on a scan while it was already out of the game, where an audit can only
// revert. Keep in sync with EMIGRATION_DESTINATIONS in shared/constants.ts (duplicated
// because this script runs standalone and cannot import the package).
const EMIGRATION_CONTRACTS = [
  "0xe56d011262d4738dc8307fb8a4ae48b2bfc20e7c", // Governor
  "0xbfffc99fa75a0fea45b765d11d8e52f8e1114f8c", // ABBC
];
const isEmigratedOwner = (owner) => owner != null && EMIGRATION_CONTRACTS.includes(owner.toLowerCase());
const EPOCH_DURATION = 86400n;
// Our own bundle shape, for pricing what it costs to out-rank a rival's defense.
// Gas MEASURED from real on-chain txs: payTaxes ~82,875, audit ~130,409, CoinbasePayer
// 27,895–30,550 over 21 samples (max used — under-pricing a bid loses the boundary,
// over-pricing it is a rounding error). Deliberately NOT the 60,000 gas LIMIT the bid tx
// is signed with: builders simulate and order on gas USED, so pricing against the limit
// inflated every bundle by ~30,000 gas. Keep in sync with GAS_* in shared/constants.ts —
// duplicated because this script runs standalone and cannot import the package.
const GAS_PER_PAYMENT = 82_875;
const GAS_PER_AUDIT = 130_409;
const GAS_BID_TX = 30_550;
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

/** Numeric flag: `--name 5`. Returns `dflt` when absent or unparseable. */
function numArg(name, dflt, { min = 0 } = {}) {
  const i = args.indexOf(name);
  if (i < 0 || args[i + 1] === undefined) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v >= min ? v : dflt;
}

// THE BUNDLE WE PLAN TO SEND. A coinbase bid buys position for the WHOLE bundle, so what
// it costs to out-rank a rival scales with the gas we are carrying — the same rival that
// costs 0.03 ETH to beat on a 1-pay/1-audit bundle costs ~0.24 on a 9-pay/11-audit one.
// Pricing every operator against a fixed 1+1 shape was therefore wrong for anyone holding
// more than one citizen, which is most of them. Mirrors the payments/audits fields the
// dashboard already exposes (TargetScores.tsx), so the CLI and the panel agree.
//
// Defaults stay 1+1 so existing invocations print what they always did.
const PLAN_PAYMENTS = numArg("--payments", 1);
const PLAN_AUDITS = numArg("--audits", 1);
const OUR_BUNDLE_GAS = PLAN_PAYMENTS * GAS_PER_PAYMENT + PLAN_AUDITS * GAS_PER_AUDIT + GAS_BID_TX;
// Same bundle WITHOUT the bid tx: the tip route never sends one, so charging a tip for its
// ~30,550 gas would overstate the tip lever by exactly that. Keep in sync with
// tipOnlyBundleGas / tipCostEth in shared/constants.ts.
const OUR_TIP_GAS = PLAN_PAYMENTS * GAS_PER_PAYMENT + PLAN_AUDITS * GAS_PER_AUDIT;
/** What a `gwei` priority fee costs in ETH for the planned bundle. Marginal cost of the tip
 *  only — base fee is paid either way, so this is what compares against a bid figure. */
const tipEth = (gwei) => (gwei === null ? null : (gwei * OUR_TIP_GAS) / 1e9);
// The tip we would actually bid on an audit. Mirrors resolveGas(): the offense tip only
// applies when separateOffenseGas is on, otherwise audits ride the payment tip. Read from
// the live config rather than hardcoded, because pricing against a tip the bot won't bid
// misstates every beat figure — the difference is charged across the whole bundle gas.
// `--tip` overrides it, for asking "what would this cost if I tipped differently?".
const OUR_TIP_GWEI = (() => {
  const override = numArg("--tip", null);
  if (override !== null) return override;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    const tip = c.separateOffenseGas ? c.offensePriorityFeeGwei : c.priorityFeeGwei;
    if (typeof tip === "number" && tip >= 0) return tip;
  } catch {}
  return 20.1; // DEFAULT_STRATEGY.offensePriorityFeeGwei
})();
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
  const bigBoyOwners = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, "big-boys.json"), "utf8")).owners ?? {}; }
    catch { return {}; }
  })();
  const bigBoyOwnerOf = new Map();
  for (const [name, ids] of Object.entries(bigBoyOwners)) for (const id of ids) bigBoyOwnerOf.set(String(id), name);

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
  const universe = [...ownerOf.keys()].filter((t) => !isEmigratedOwner(ownerOf.get(t)) && !allySet.has(t));
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
  for (const l of payLogs) { const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue; const tipG = Number(m.eff - (bf.get(m.blk.toString()) ?? 0n)) / 1e9; const dd = (defense[tok] ??= { maxTip: 0, bestIdx: Infinity, pays: 0, byEpoch: new Map() }); dd.pays++; dd.maxTip = Math.max(dd.maxTip, tipG); dd.bestIdx = Math.min(dd.bestIdx, m.idx); }

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


  /** Which epoch a block falls in, off the sampled epoch grid. null if before the window.
   *  Declared here because everything that buckets by epoch needs it, and epochFirstBlock —
   *  which it reads — is only complete after the loop above. */
  const epochOfBlock = (blk) => {
    for (let E = ce; E >= firstEpoch; E--) {
      const fb = epochFirstBlock.get(E.toString());
      if (fb !== undefined && blk >= fb) return E;
    }
    return null;
  };

  /**
   * Per-epoch TIP buckets, so the def column can show -2/-1/max instead of a lone peak that
   * cannot distinguish a rival still defending at that level from one that defended once.
   *
   * A second pass on purpose: the epoch grid (epochFirstBlock) is only built by the loop above,
   * and epochOfBlock reads it — folding this into the earlier tip loop threw
   * "Cannot access 'epochOfBlock' before initialization" at runtime, which node --check does
   * not catch.
   */
  for (const l of payLogs) {
    const tok = BigInt(l.topics[1]).toString();
    const m = meta.get(l.transactionHash);
    const dd = defense[tok];
    if (!m || !dd) continue;
    const tipG = Number(m.eff - (bf.get(m.blk.toString()) ?? 0n)) / 1e9;
    const tE = epochOfBlock(m.blk);
    if (tE !== null) dd.byEpoch.set(tE.toString(), Math.max(dd.byEpoch.get(tE.toString()) ?? 0, tipG));
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
  /** Blocks after that epoch's boundary a block sits, or null if before the window. */
  const blockOffset = (blk) => {
    for (let E = ce; E >= firstEpoch; E--) {
      const fb = epochFirstBlock.get(E.toString());
      if (fb !== undefined && blk >= fb) { const off = Number(blk - fb); return off >= 0 ? off : null; }
    }
    return null;
  };
  const payOff = {}; // token -> [offsets]
  for (const l of payLogs) {
    const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue;
    const off = blockOffset(m.blk);
    if (off !== null) (payOff[tok] ??= []).push(off);
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2); };

  // Coinbase bids. A bid is an internal ETH transfer to block.coinbase riding the
  // payment's bundle — it buys transaction position outright, independent of the priority
  // fee, so it is the thing you actually have to outspend.
  //
  // Traced over the FULL window, not the last 2 epochs. The short window was chosen
  // because tracing is the expensive part of this scan, but it made the headline number
  // wrong in the dangerous direction: #5347 bid its way to 192 gwei/gas six epochs ago and
  // read "no bid needed" here, while sitting 6th in the recommended-targets list. Pricing
  // a live bid off a figure that misses most bidding loses the race and the slot. So the
  // peak over the whole window drives beatBid, and the last 2 epochs are kept separately
  // as the "are they bidding right now" signal (the Bid 2ep column).
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
  const bidBlocks = [...new Set(payLogs.map((l) => BigInt(l.blockNumber).toString()))].map(BigInt);
  if (!asJson && bidBlocks.length > 0) {
    console.error(`tracing ${bidBlocks.length} payment blocks for coinbase bids…`);
  }
  const bidByToken = {}; // token -> { wei, pays } over the RECENT 2 epochs
  const bidPeakByToken = {}; // token -> { wei, recent } — biggest single bid over the WHOLE window
  const bidHistByToken = {}; // token -> { e2, e1 } — biggest bid two epochs ago / one epoch ago
  // Hoisted: the density calculation below needs the per-(block, sender) coinbase totals,
  // not just the per-token sums.
  const cbByBlockSender = new Map();
  /** "blk:sender" -> Set of tx hashes that paid the coinbase, so a separate payer tx can
   *  be counted into the bundle gas its bid actually bought. */
  const cbTxByBlockSender = new Map();
  /** blk -> Set of tx hashes that touched the game or paid the builder, i.e. everyone who
   *  was racing. Used only to falsify the density model, never to price a bid. */
  const competitorTxs = new Map();
  /** "blk:sender" for senders that actually touched the game in that block. */
  const gameSenders = new Set();
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
      // Everyone who was RACING in this block, not just the rivals we score. The
      // falsification check below compares a rival's bundle against whatever actually beat
      // it, and the bundle that beats it often makes no tax payment at all — a pure audit
      // bundle emits no TaxesPaid, so it never reaches payLogs and would be invisible.
      // That is exactly the case that motivated this: in block 25749548 a router at 95.7
      // gwei/gas took index 8 ahead of a 296.9 gwei/gas bundle of seven audits and no
      // payments. Collect any tx that touched the game or paid the builder.
      for (const tr of traces) {
        if (!tr.transactionHash) continue;
        const dst = (tr.action?.to || "").toLowerCase();
        if (dst !== GAME && dst !== miner) continue;
        (competitorTxs.get(b.toString()) ?? competitorTxs.set(b.toString(), new Set()).get(b.toString()))
          .add(tr.transactionHash);
        // Only a sender that actually touched the GAME is racing us. A coinbase-paying tx
        // alone is not enough: an unrelated MEV searcher deep in the block pays the builder
        // too, and comparing against one flagged #553 — a 0.1 gwei rival already audited
        // three times — as "unknown defense", which is the opposite of the truth.
        if (dst === GAME) gameSenders.add(`${b}:${senderOfTx.get(tr.transactionHash) || (tr.action?.from || "").toLowerCase()}`);
      }
      for (const tr of traces) {
        if (tr.type !== "call" || !tr.transactionHash) continue;
        const to = (tr.action?.to || "").toLowerCase(); const val = tr.action?.value ? BigInt(tr.action.value) : 0n;
        if (to !== miner || val <= 0n) continue;
        const s = senderOfTx.get(tr.transactionHash) || (tr.action?.from || "").toLowerCase();
        const k = `${b}:${s}`;
        cbByBlockSender.set(k, (cbByBlockSender.get(k) ?? 0n) + val);
        // Remember WHICH tx carried the bid. When a rival bids from a separate payer tx
        // (rather than inside the payTaxes call), that tx's gas is part of the bundle the
        // bid bought position for — but it emits no TaxesPaid, so the density denominator
        // below would miss it and overstate how hard the rival is to beat.
        (cbTxByBlockSender.get(k) ?? cbTxByBlockSender.set(k, new Set()).get(k)).add(tr.transactionHash);
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
      /**
       * The PEAK bid over the WHOLE window, separately from the recent-2-epoch sum above.
       *
       * Without this a rival that bid hard four epochs ago and coasted since reads "-" in the
       * bid column while beatMax quotes a number built from exactly that bid — the density
       * calculation uses the full window, the column did not. #2711 is the case: 0.042 ETH at
       * epochs 163 and 165 taking index 0 both times, nothing since, and a beat figure of 448
       * gwei that looks unexplainable next to a blank bid column and a 90 gwei tip. 85% of
       * that 448 IS the bid.
       */
      for (const l of payLogs) {
        const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue;
        const wei = cbByBlockSender.get(`${m.blk}:${m.from}`) ?? 0n;
        if (wei <= 0n) continue;
        const e = (bidPeakByToken[tok] ??= { wei: 0n, recent: false });
        if (wei > e.wei) e.wei = wei;
        if (BigInt(l.blockNumber) >= bidWindowStart) e.recent = true;
        /**
         * Per-epoch buckets for the two most recent epochs, so the column can show a trend
         * (`now/-1/max`) instead of one number that hides whether they are escalating,
         * holding, or have gone quiet.
         *
         * `now` is the CURRENT epoch, not "one ago", and that matters: the boundary for epoch
         * N happens when epoch N BEGINS, so a rival's most recent boundary defense lands in
         * the current epoch. Bucketing at -1/-2 would hide the freshest defense there is —
         * the same class of blind spot the peak column was added to fix.
         */
        const bE = epochOfBlock(BigInt(l.blockNumber));
        if (bE !== null) {
          const h = (bidHistByToken[tok] ??= { e2: 0n, e1: 0n });
          if (bE === ce - 2n && wei > h.e2) h.e2 = wei;
          else if (bE === ce - 1n && wei > h.e1) h.e1 = wei;
        }
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
  // Defense density per payment, then the peak per token over TWO windows:
  //   bidDensity    — the whole window: the ceiling, what it has ever mounted.
  //   recentDensity — the last 2 epochs: what it is doing now.
  // Both are needed. The ceiling is what you must be willing to pay to be sure of winning;
  // the recent figure is what it will probably cost at the next boundary. #5347 peaks at
  // 192 gwei/gas but has not bid in two epochs — pricing only off the ceiling overpays as
  // badly as pricing only off the recent number underpays.
  //
  // Density is computed for EVERY payment, not just bid-backed ones: with no bid it
  // reduces to the effective tip, so one formula covers both and the two windows stay
  // directly comparable.
  const bidDensity = {};    // token -> peak gwei/gas, whole window
  const recentDensity = {}; // token -> peak gwei/gas, last 2 epochs
  const bidWindow = {};     // token -> { wei, pays } over the whole window
  // token -> true when a block was observed ordering this token's bundle AHEAD of a
  // higher-density one, i.e. the density model was falsified where this token was racing.
  const densityContradicted = {};
  // token -> peak density on BOUNDARY-BLOCK payments only (offset 0). bidDensity peaks over
  // every payment in the window, but a mid-epoch payment is not a race — nobody is
  // contesting position at offset 30, so a high tip there says nothing about what the rival
  // will mount when it matters. This is the same measurement narrowed to the block that
  // actually decides whether an audit lands.
  const boundaryDensity = {};
  const densityByEpoch = {}; // token -> Map(epoch -> peak gwei/gas in that epoch)
  // The bar to LEAD a boundary block: the strongest bundle present in each race, whoever
  // it belonged to. Distinct from any single rival's defense — out-ranking one rival is
  // not the same as winning the slot, and in the race we studied a bundle measuring 95.7
  // took index 8 while a 296.9 one took index 9. Percentiles of this are what a coinbase
  // bid should actually be sized against.
  const raceBars = []; // one peak density per boundary block observed
  if (tracingOk) {
    const group = new Map(); // "blk:sender" -> { gas, tips, txs, minIdx }
    for (const l of payLogs) {
      const m = meta.get(l.transactionHash);
      if (!m) continue;
      const k = `${m.blk}:${m.from}`;
      const g = group.get(k) ?? { gas: 0n, tips: 0n, txs: new Set(), minIdx: Infinity };
      if (!g.txs.has(l.transactionHash)) {
        g.txs.add(l.transactionHash);
        g.gas += m.gasUsed;
        g.tips += (m.eff - (bf.get(m.blk.toString()) ?? 0n)) * m.gasUsed;
      }
      // Best position this group reached, for the falsification check below.
      g.minIdx = Math.min(g.minIdx, m.idx);
      group.set(k, g);
    }
    // Fold in each bundle's separate payer tx. Without this the bid is measured over the
    // whole bundle while the gas is measured over only the payTaxes calls, which inflates
    // every separate-payer bidder: #2711 at blk 25735198 read 596.8 gwei/gas (0.042 over
    // 82,875) when the bundle it actually bought was 110,820 gas — 469.0 gwei/gas. That is
    // a 28% overstatement of the bid needed to beat it. Rivals who bid from INSIDE the
    // payTaxes call are unaffected: their gas was already whole.
    const extraHashes = [];
    for (const [k, g] of group) {
      for (const h of cbTxByBlockSender.get(k) ?? []) if (!g.txs.has(h)) extraHashes.push([k, h]);
    }
    if (extraHashes.length > 0) {
      const rcs = new Map();
      for (let i = 0; i < extraHashes.length; i += 60) {
        const slice = extraHashes.slice(i, i + 60);
        const m = await batch(slice.map(([, h], j) => ({ jsonrpc: "2.0", id: i + j, method: "eth_getTransactionReceipt", params: [h] })));
        for (const r of m) if (r.result) rcs.set(r.result.transactionHash, r.result);
      }
      for (const [k, h] of extraHashes) {
        const rc = rcs.get(h); if (!rc) continue;
        const g = group.get(k); if (!g || g.txs.has(h)) continue;
        g.txs.add(h);
        const gas = BigInt(rc.gasUsed);
        g.gas += gas;
        // Its priority fee is builder revenue too, so it belongs in the numerator.
        g.tips += (BigInt(rc.effectiveGasPrice) - (bf.get(BigInt(rc.blockNumber).toString()) ?? 0n)) * gas;
      }
    }
    // Where the block itself FALSIFIES the density model.
    //
    // beatBid assumes builders order by density, so "measures below our tip" is reported as
    // "free to out-rank" (a "-" in the beat columns). Block 25749548 is the counter-example:
    // a router bundle measuring 95.7 gwei/gas took index 8 while a 296.9 gwei/gas bundle
    // took index 9 — 3.1x the density, one slot later, same block, same builder. The
    // operator behind the losing bundle paid 0.1 ETH and had all seven of its audits revert
    // against targets the router had already cured.
    //
    // A "-" priced off a model the block just falsified is worse than no number at all, so
    // flag any group that landed AHEAD of another group in the same block with strictly
    // higher density. That is observed contradiction, not assumption, and it drives the
    // same "?" the top-of-block heuristic below already produces.
    //
    // Deliberately NOT keyed on absolute tx index: the old `bestIdx <= 1` test was
    // calibrated on whole-block position and silently missed this router at index 8 of a
    // 395-tx block, which was third among game participants and first among audit
    // competitors. Rank against the rivals actually racing you, not against the block.
    // Build every racer's bundle from receipts, independently of the rival-payment view
    // above. Kept separate on purpose: `group` defines the DENSITY we price bids against
    // and its semantics are settled, so this must not move those numbers — it only decides
    // whether to trust them.
    const compHashes = [];
    for (const [blk, set] of competitorTxs) for (const h of set) compHashes.push([blk, h]);
    const compRc = new Map();
    for (let i = 0; i < compHashes.length; i += 60) {
      const slice = compHashes.slice(i, i + 60);
      const res = await batch(slice.map(([, h], j) => ({ jsonrpc: "2.0", id: i + j, method: "eth_getTransactionReceipt", params: [h] })));
      for (const r of res) if (r.result) compRc.set(r.result.transactionHash.toLowerCase(), r.result);
    }
    const comp = new Map(); // "blk:sender" -> { gas, tips, cb, minIdx }
    for (const rc of compRc.values()) {
      const blk = BigInt(rc.blockNumber).toString();
      const k = `${blk}:${(rc.from || "").toLowerCase()}`;
      const c = comp.get(k) ?? { gas: 0n, tips: 0n, cb: 0n, minIdx: Infinity };
      const gas = BigInt(rc.gasUsed);
      c.gas += gas;
      c.tips += (BigInt(rc.effectiveGasPrice) - (bf.get(blk) ?? 0n)) * gas;
      c.minIdx = Math.min(c.minIdx, Number(BigInt(rc.transactionIndex)));
      comp.set(k, c);
    }
    for (const [k, wei] of cbByBlockSender) { const c = comp.get(k); if (c) c.cb = wei; }

    const compDensity = new Map();
    const byBlock = new Map(); // blk -> ["blk:sender"], game participants only
    for (const [k, c] of comp) {
      if (c.gas === 0n || c.minIdx === Infinity || !gameSenders.has(k)) continue;
      compDensity.set(k, Number(((c.cb + c.tips) * 1000n) / c.gas) / 1000 / 1e9);
      const blk = k.slice(0, k.indexOf(":"));
      (byBlock.get(blk) ?? byBlock.set(blk, []).get(blk)).push(k);
    }
    // MARGIN keeps this to real evidence: near-ties are not falsification, only a
    // materially denser bundle LOSING position is, and 1.5x is well outside the rounding in
    // these figures. Restricting to game participants does the rest of the work — an
    // earlier revision compared against every coinbase-paying tx and flagged five easy
    // rivals (#553 tips 0.1 gwei, sits at index 88, already audited three times) purely
    // because some unrelated searcher deep in the block out-priced them. A "?" on a target
    // like that hides a free kill behind a warning, which is worse than the wrong number
    // it replaced.
    //
    // Deliberately NOT also gated on finishing in the top N of the block: that guard turned
    // out inert on 8 epochs of real data once non-game senders were excluded, and its only
    // live effect would have been to suppress a genuine winner that placed 4th or later.
    const MARGIN = 1.5;
    const contradicted = new Set();
    for (const [, keys] of byBlock) {
      if (keys.length < 2) continue;
      for (const a of keys) {
        const ca = comp.get(a), da = compDensity.get(a);
        for (const b of keys) {
          if (a === b) continue;
          if (ca.minIdx < comp.get(b).minIdx && compDensity.get(b) > da * MARGIN) { contradicted.add(a); break; }
        }
      }
    }

    // The lead bar, one figure per BOUNDARY block: the strongest bundle anyone brought.
    // Only offset-0 blocks count — a mid-epoch payment block has no race in it, so its
    // peak would drag the percentiles down and understate what winning costs. Two
    // participants minimum, otherwise "strongest" is just "the only one".
    for (const [blkStr, keys] of byBlock) {
      if (keys.length < 2 || blockOffset(BigInt(blkStr)) !== 0) continue;
      raceBars.push(Math.max(...keys.map((k) => compDensity.get(k))));
    }

    for (const l of payLogs) {
      const tok = BigInt(l.topics[1]).toString();
      const m = meta.get(l.transactionHash);
      if (!m) continue;
      const k = `${m.blk}:${m.from}`;
      const g = group.get(k);
      if (!g || g.gas === 0n) continue;
      const bidWei = cbByBlockSender.get(k) ?? 0n;
      const gweiPerGas = Number(((bidWei + g.tips) * 1000n) / g.gas) / 1000 / 1e9;
      bidDensity[tok] = Math.max(bidDensity[tok] ?? 0, gweiPerGas);
      // Per-epoch peak density: what it actually mounted at THAT boundary, which is what the
      // -2/-1 beat columns are priced against.
      const dE = epochOfBlock(m.blk);
      if (dE !== null) {
        const byE = (densityByEpoch[tok] ??= new Map());
        byE.set(dE.toString(), Math.max(byE.get(dE.toString()) ?? 0, gweiPerGas));
      }
      if (contradicted.has(k)) densityContradicted[tok] = true;
      if (m.blk >= bidWindowStart) {
        recentDensity[tok] = Math.max(recentDensity[tok] ?? 0, gweiPerGas);
      }
      if (blockOffset(m.blk) === 0) {
        boundaryDensity[tok] = Math.max(boundaryDensity[tok] ?? 0, gweiPerGas);
      }
      if (bidWei > 0n) {
        const w = (bidWindow[tok] ??= { wei: 0n, pays: 0 });
        w.wei += bidWei;
        w.pays++;
      }
    }
  }

  /**
   * The coinbase bid our PLANNED bundle needs to reach `gwei` gwei/gas.
   *
   * Our density is bid/gas + tip, so matching a bar costs (bar - tip) * gas. Returns 0 when
   * the tip alone already clears it — which is a real answer, not a missing one: against a
   * rival defending below our tip there is nothing to buy. Whether that also WINS is a
   * separate question, and the reason the lead bar below exists.
   */
  const priceBid = (gwei) =>
    gwei > OUR_TIP_GWEI ? +(((gwei - OUR_TIP_GWEI) * OUR_BUNDLE_GAS) / 1e9).toFixed(4) : 0;

  /**
   * The same bar expressed as a TIP instead of a bid — the other lever, and the one that
   * works everywhere.
   *
   * Density is tip + bid/gas, so a bundle carrying no bid has density equal to its tip: the
   * bar in gwei/gas IS the priority fee that clears it, and unlike the bid it does not scale
   * with bundle size. It also survives the ~10% of boundaries built by a solo validator on
   * vanilla geth/reth, which order by priority fee and ignore coinbase transfers outright —
   * on those blocks a bid buys literally nothing and only the tip counts.
   *
   * +1 gwei because clearing the bar means going PAST it, not matching it.
   */
  const priceTip = (gwei) => (gwei === null ? null : Math.ceil(gwei) + 1);

  // Score each live, non-emigrated rival.
  const rows = [];
  for (const t of rivals) {
    const owner = ownerOf.get(t) ?? null;
    if (!owner || isEmigratedOwner(owner)) continue; // dead/burned or emigrated: not a target
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
    // Big boys are SCORED like any other rival now. The roster used to be do-not-target and
    // forced score 0; the team attacks them, so suppressing their score would hide the very
    // targets being pushed on. The operator tag is attribution only.
    const bigBoyOwner = bigBoyOwnerOf.get(t) ?? null;
    // Retired flag, always false. The evidence-based "can't catch it" veto used to grey rows
    // that topped the block and had never been audited; BeatMax prices that as a cost instead.
    // Still emitted so a dashboard holding an older cached scan keeps parsing.
    const uncatchable = false;

    let score = 0;
    if (!under) {
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
    // then let our own tip cover what it can. Sized for the bundle actually planned
    // (--payments / --audits, default 1+1) using the MEASURED gas of each action, not the
    // 60,000 gas LIMIT the payer tx is signed with: builders order on gas used, so pricing
    // against the limit inflated every figure here by ~30,000 gas.
    //
    // Rough by nature — it cannot see off-chain builder deals, a bid observed in the
    // 2-epoch window may not be repeated, and `densityContradicted` above marks the blocks
    // where the ordering assumption underneath all of this did not hold at all.
    //
    // (Defined once above the loop — the lead-bar pricing after it needs the same formula.)
    // Ceiling: the strongest defense seen anywhere in the window. maxTip is the floor
    // here so a tip-only defender is still priced when tracing is unavailable.
    const defenseGwei = Math.max(dd.maxTip, bidDensity[t] ?? 0);
    const beatBidEth = priceBid(defenseGwei);
    // Recent: the last 2 epochs only — likely cost at the NEXT boundary. null when it made
    // no payment in that span, which is a different statement from "it defends weakly".
    const defenseRecentGwei = recentDensity[t] ?? null;
    const beatBidRecentEth = defenseRecentGwei === null ? null : priceBid(defenseRecentGwei);
    // The measurement is contradicted by the outcome, so "no bid needed" would be a lie and
    // the column says unknown instead. Two independent ways that happens:
    //
    //   1. It reached the TOP OF THE BLOCK while measuring below our own tip, which cannot
    //      happen on merit. Something bought that position where we can't see it — a bid
    //      older than the trace window (the roster's 0.08 ETH bidders read 3.1 gwei here for
    //      exactly that reason), or an off-chain builder deal.
    //   2. A block was observed placing its bundle AHEAD of a higher-density one. That is
    //      the density model failing directly, and it is not rare: over 8 epochs the density
    //      rank matched the actual rank in 27% of cases. Case 1 alone missed the router at
    //      index 8 of a 395-tx block that beat a 3.1x denser bundle, because index 8 is not
    //      "top of block" by any absolute threshold — it was simply first among the rivals
    //      that mattered.
    const defenseUnexplained =
      beatBidEth === 0 && ((bestIdx !== null && bestIdx <= 1) || densityContradicted[t] === true);
    /**
     * WHY the measurement and the outcome disagree. These collapsed into one "?" before, and
     * they call for opposite responses:
     *
     *  "outranked-denser" — a block was observed placing its bundle AHEAD of a materially
     *    denser one. The density model failed outright, so out-bidding is NOT reliably the
     *    lever. This is the one worth acting on. Hedo is the case in point: their router's
     *    0.1 ETH in-call payment IS traced and their density genuinely measures ~96 gwei/gas,
     *    below a 130 gwei tip — and they still took position ahead of a 297 gwei/gas bundle.
     *  "reached-top" — it hit index 0/1 while measuring below our tip, but nothing denser was
     *    present to out-rank. Often just "it was the only bidder that block", so it is a much
     *    weaker signal than the first.
     */
    const unexplainedReason = !defenseUnexplained
      ? null
      : densityContradicted[t] === true ? "outranked-denser" : "reached-top";
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
      tipE2: dd.byEpoch?.has((ce - 2n).toString()) ? +dd.byEpoch.get((ce - 2n).toString()).toFixed(1) : null,
      tipE1: dd.byEpoch?.has((ce - 1n).toString()) ? +dd.byEpoch.get((ce - 1n).toString()).toFixed(1) : null,
      defenseE2Gwei: densityByEpoch[t]?.has((ce - 2n).toString()) ? +densityByEpoch[t].get((ce - 2n).toString()).toFixed(1) : null,
      defenseE1Gwei: densityByEpoch[t]?.has((ce - 1n).toString()) ? +densityByEpoch[t].get((ce - 1n).toString()).toFixed(1) : null,
      beatBidE2Eth: densityByEpoch[t]?.has((ce - 2n).toString()) ? priceBid(densityByEpoch[t].get((ce - 2n).toString())) : null,
      beatBidE1Eth: densityByEpoch[t]?.has((ce - 1n).toString()) ? priceBid(densityByEpoch[t].get((ce - 1n).toString())) : null,
      beatTipE2Gwei: densityByEpoch[t]?.has((ce - 2n).toString()) ? priceTip(densityByEpoch[t].get((ce - 2n).toString())) : null,
      beatTipE1Gwei: densityByEpoch[t]?.has((ce - 1n).toString()) ? priceTip(densityByEpoch[t].get((ce - 1n).toString())) : null,
      payBlkMin, payBlkMed, audited: aud,
      beatBidEth, defenseUnexplained, unexplainedReason,
      // The two levers, per rival. Same bar, priced both ways: a tip that needs no builder
      // cooperation, or a flat bid that costs MORE at equal density (it also tips the payer tx) and is dead on a
      // solo-built block.
      beatTipGwei: priceTip(defenseGwei),
      beatTipRecentGwei: priceTip(defenseRecentGwei),
      beatTipBoundaryGwei: priceTip(boundaryDensity[t] ?? null),
      beatBidRecentEth, defenseRecentGwei: defenseRecentGwei === null ? null : +defenseRecentGwei.toFixed(1),
      // Defense measured ONLY on boundary-block payments — what it mounts in the block that
      // decides an audit, rather than its peak across quiet mid-epoch payments. null = it
      // was never seen paying in a boundary block in this window.
      defenseBoundaryGwei: boundaryDensity[t] === undefined ? null : +boundaryDensity[t].toFixed(1),
      beatBoundaryEth: boundaryDensity[t] === undefined ? null : priceBid(boundaryDensity[t]),
      // The density that beatBidEth is priced against, in gwei/gas — max(tip, bid density).
      defenseGwei: +defenseGwei.toFixed(1),
      bigBoyOwner, uncatchable,
      score: +score.toFixed(2),
      // Coinbase bidding over the last 2 epochs — the "are they bidding right now"
      // signal. null = RPC has no tracing (unknown).
      bidEth: tracingOk ? +eth(bidByToken[t]?.wei ?? 0n).toFixed(6) : null,
      bidPays: tracingOk ? (bidByToken[t]?.pays ?? 0) : null,
      // Peak bid over the whole window + whether it is still recent. This is what explains a
      // large beat figure on a rival that has not bid lately.
      bidPeakEth: tracingOk ? +eth(bidPeakByToken[t]?.wei ?? 0n).toFixed(6) : null,
      bidE2Eth: tracingOk ? +eth(bidHistByToken[t]?.e2 ?? 0n).toFixed(6) : null,
      bidE1Eth: tracingOk ? +eth(bidHistByToken[t]?.e1 ?? 0n).toFixed(6) : null,
      bidPeakRecent: tracingOk ? (bidPeakByToken[t]?.recent ?? false) : null,
      // ...and over the WHOLE window, which is what beatBid is priced against.
      bidWindowEth: tracingOk ? +eth(bidWindow[t]?.wei ?? 0n).toFixed(6) : null,
      bidWindowPays: tracingOk ? (bidWindow[t]?.pays ?? 0) : null,
    });
  }

  const hoursToBoundary = Number(nextBoundary - nowSec) / 3600;

  // What it costs to LEAD a boundary block with the planned bundle, rather than to
  // out-rank one named rival. beat2ep/beatMax answer "can my tip alone beat this rival's
  // own defense" — a different and much weaker question: in the race we studied, matching
  // the rival that actually won cost 0.0000 (its density was below our tip) and would have
  // lost anyway, because the slot went to the strongest bundle in the block, not to the
  // rival we were chasing. This prices that bar instead.
  //
  // Calibration, deliberately stated rather than implied: over 14 observed races the
  // densest bundle took index 0 only about half the time. p50 is "typical block", p90 is
  // "most blocks"; neither is a guarantee, and no bid figure can be.
  const bars = [...raceBars].sort((a, b) => a - b);
  const pctile = (p) => (bars.length === 0 ? null : bars[Math.min(bars.length - 1, Math.floor((bars.length - 1) * p))]);
  const leadBar = bars.length === 0 ? null : {
    blocks: bars.length,
    p50: +pctile(0.5).toFixed(1), p75: +pctile(0.75).toFixed(1),
    p90: +pctile(0.9).toFixed(1), max: +pctile(1).toFixed(1),
  };
  const leadBidEth = leadBar === null ? null : {
    p50: priceBid(leadBar.p50), p75: priceBid(leadBar.p75),
    p90: priceBid(leadBar.p90), max: priceBid(leadBar.max),
  };
  if (asJson) {
    // The beat* figures are only meaningful alongside the bundle they were priced for, so
    // emit it rather than leaving a consumer to assume the old fixed 1+1 shape.
    const plan = {
      payments: PLAN_PAYMENTS, audits: PLAN_AUDITS,
      tipGwei: OUR_TIP_GWEI, bundleGas: OUR_BUNDLE_GAS,
    };
    console.log(JSON.stringify({
      epoch: Number(ce), hoursToNextBoundary: +hoursToBoundary.toFixed(1),
      epochTaxEth: eth(epochTax), plan, leadBar, leadBidEth, rows,
    }, null, 2));
    return;
  }

  /**
   * The bid to LEAD a boundary block, as opposed to out-ranking one named rival.
   *
   * Printed in both table modes because it is the figure `coinbaseBidEth` should actually
   * be set from: beat2ep/beatMax say what it costs to out-price a specific target, and a
   * rival can win the slot while measuring below your tip (observed: 95.7 gwei/gas took
   * index 8 against a 296.9 bundle at index 9). Leading the block is the thing that makes
   * an audit land.
   */
  function printLead() {
    if (leadBar === null || leadBidEth === null) {
      console.log(`lead = (no boundary races with 2+ participants in this window — widen --epochs)`);
      return;
    }
    /**
     * Total ETH for the BID route: the bid itself plus the tip still charged across the whole
     * bundle, payer transaction included.
     *
     * Printing the bare bid next to a tip cost invites the wrong conclusion — 0.0772 looks
     * cheaper than 0.0956 — because the bid figure is an increment on top of a tip that is
     * still being paid. Totalled honestly, the tip route wins at equal density.
     */
    const bidRouteTotal = (bidEth) => bidEth + (OUR_TIP_GWEI * OUR_BUNDLE_GAS) / 1e9;
    const leadLine = (label, bar, bidEth) =>
      `  ${label}: tip ${priceTip(bar)} gwei = ${tipEth(priceTip(bar)).toFixed(4)} ETH  OR  ` +
      `bid ${bidEth.toFixed(4)} + ${((OUR_TIP_GWEI * OUR_BUNDLE_GAS) / 1e9).toFixed(4)} tip = ${bidRouteTotal(bidEth).toFixed(4)} ETH`;
    console.log(
      `lead = what it takes for YOUR bundle to be the densest in a boundary block, over ${leadBar.blocks} observed race(s):\n` +
        leadLine("typical block (p50)", leadBar.p50, leadBidEth.p50) + `
` +
      leadLine("most blocks  (p90)", leadBar.p90, leadBidEth.p90) + `
` +
      leadLine("strongest seen    ", leadBar.max, leadBidEth.max),
    );
    console.log(
      `  the tip column works on EVERY builder, including the ~1 boundary in 10 built by a solo
` +
      `  validator on vanilla geth/reth — those order by priority fee and ignore coinbase transfers
` +
      `  outright, so a bid buys nothing there. The tip column is also CHEAPER at equal density: the
` +
      `  bid route also sends and tips the CoinbasePayer tx, so it runs ~0.011-0.014 ETH dearer at
  any bundle size. The bid only looks smaller because it is quoted on top of a tip you still
  pay; what it buys is scope (one boundary) rather than a discount.
` +
      `  Either way this is the bar to CLEAR, not a guarantee: across the same races the densest
` +
      `  bundle took index 0 about half the time, so treat p90 as buying margin against that noise.`,
    );
  }

  // Skips as clean/caught out of attempted. "3/1 of 4" = crossed delinquent 4 times,
  // got away with 3, was audited during 1. 0 attempts prints as "-".
  const skipCol = (r) =>
    (r.crossings === 0 ? "-" : `${r.skipClean}/${r.skipCaught} of ${r.crossings}`).padStart(11);
  const payBlkCol = (r) => (r.payBlkMin === null ? "-" : `${r.payBlkMin}/${r.payBlkMed}`).padStart(9);
  // What a coinbase bid must cover to out-rank this rival's best observed defense.
  // "-" = nothing needed, our tip already out-ranks it · "·" = no payment seen in that
  // window · "?" / "!" = no price can be quoted, for two DIFFERENT reasons worth telling
  // apart (see unexplainedReason): "?" it reached top-of-block with nothing denser present
  // to out-rank, so the price is merely unknown; "!" a block was seen ordering its bundle
  // AHEAD of a denser one, so the density model itself is falsified here and out-bidding
  // may not be the lever at all. "!" is the one to act on.
  const beatCol = (r) =>
    (r.beatBidEth > 0
      ? r.beatBidEth.toFixed(4)
      : !r.defenseUnexplained ? "-"
      : r.unexplainedReason === "outranked-denser" ? "!" : "?").padStart(7);
  /**
   * Beat-by-bid for a SPECIFIC past epoch. "·" means no payment was observed in that epoch, which
   * is genuinely different from "-" (a payment whose defense our tip already clears): one is
   * missing data, the other is a priced answer.
   */
  const perEpochCol = (v) =>
    (v === null || v === undefined ? "·" : v > 0 ? v.toFixed(4) : "-").padStart(6);
  const e2Col = (r) => perEpochCol(r.beatBidE2Eth);
  const e1Col = (r) => perEpochCol(r.beatBidE1Eth);
  const beatNowCol = (r) =>
    (r.beatBidRecentEth === null ? "·" : r.beatBidRecentEth > 0 ? r.beatBidRecentEth.toFixed(4) : "-").padStart(7);
  /**
   * The rival OWN bid, peak over the window. "*" means the peak is older than the last 2
   * epochs — they have bid this hard before and could again, but are not doing it right now.
   * Shown as the peak rather than a recent sum so it can never read "-" while beatMax quotes
   * a figure that the bid is what produced.
   */
  /**
   * The rival OWN bid as now/-1/max, in ETH with the leading zero dropped for width.
   *
   * Three fields because one number could not say whether a bidder is escalating, holding or
   * has gone quiet, and those imply different things about the next boundary. The slots are
   * two epochs ago and one epoch ago; a bid made in the CURRENT epoch shows only in `max`.
   *
   * `max` is the whole window, so this can never read all-dashes while beatMax quotes a
   * figure that a bid produced — the blind spot that made #2711 look unexplainable.
   */
  const bidCol = (r) => {
    if (r.bidPeakEth === null && r.bidEth === null) return "?".padStart(15);
    const f = (x) => (x > 0 ? x.toFixed(3).replace(/^0/, "") : "-");
    const peak = r.bidPeakEth ?? 0;
    if (peak <= 0) return "-".padStart(15);
    return `${f(r.bidE2Eth ?? 0)}/${f(r.bidE1Eth ?? 0)}/${f(peak)}`.padStart(15);
  };
  /** A tip bar in gwei, or "·" when the rival was never observed defending in that window. */
  const tipCol = (g) => (g === null || g === undefined ? "·" : String(g)).padStart(6);
  /**
   * Their OWN priority tip as -2/-1/max, matching the shape of theirBid and the beat columns.
   * A single peak could not say whether a rival is still defending at that level; three can.
   * "·" in a slot means no payment observed in that epoch at all, which is different from a
   * payment that carried no tip.
   */
  const defCol = (r) => {
    const f = (x) => (x === null || x === undefined ? "·" : x.toFixed(0));
    return `${f(r.tipE2)}/${f(r.tipE1)}/${f(r.maxTip)}`.padStart(14);
  };
  /** Lowest tx index reached, its own column now — position is a different axis from price. */
  const idxCol = (r) => String(r.bestIdx ?? "-").padStart(4);
  /** Bid priced against boundary-block defence only — the block that actually decides an audit. */
  const bndCol = (r) =>
    (r.beatBoundaryEth === null || r.beatBoundaryEth === undefined
      ? "·"
      : r.beatBoundaryEth > 0 ? r.beatBoundaryEth.toFixed(4) : "-").padStart(6);
  const fmt = (r) =>
    `#${r.token.padEnd(5)} ${String(r.behind).padStart(3)} ${r.under ? "A" : "-"} ${skipCol(r)} ${String(r.bribes).padStart(2)}  ${r.ins ? "Y" : "-"}  ` +
    `${r.ownerBalEth.toFixed(4).padStart(8)} ${String(r.cits).padStart(3)} ${(r.runwayEpochs === null ? "inf" : r.runwayEpochs.toFixed(1)).padStart(6)}  ` +
    `${r.owesNextEth.toFixed(4)} ${(r.affordNext ? "yes" : "NO").padStart(4)}  ${defCol(r)} ${idxCol(r)} ${payBlkCol(r)} ${bidCol(r)}` +
    ` | ${tipCol(r.beatTipE2Gwei)} ${tipCol(r.beatTipE1Gwei)} ${tipCol(r.beatTipGwei)}` +
    ` | ${e2Col(r)} ${e1Col(r)} ${beatCol(r)} | ${String(r.audited).padStart(3)}  ${r.score.toFixed(2).padStart(5)}`;
  // The two right-hand groups are the point of the report: BEAT-BY-TIP is the priority fee
  // that out-densities them with no bid at all (works on every builder, including the ~10% of
  // boundaries built by a solo validator that ignores coinbase transfers); BEAT-BY-BID is the
  // flat bid that gets there at YOUR configured tip instead.
  const header =
    "tok    beh A  clean/caught br ins  ownerBal cit runway  owesNxt afrd    def -2/-1/max  idx    payBlk    theirBid -2/-1/max" +
    " | tip-2  tip-1 tipMax | bid-2  bid-1 bidMax | aud  score";
  // beh column doubles as the timing cue: 1 = becomes auditable next boundary, 2+ = already auditable.

  // --auditable-next keeps only rows that will be auditable when the epoch rolls: 1+
  // behind and not already under audit. behind 1 -> 2 behind next -> newly auditable;
  // behind 2+ (and not under audit) is already auditable and stays so.
  const pool = auditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows;
  // Listed "do not target" rivals get their own section and are removed from the two
  // target sections entirely — they are not candidates, so ranking them among candidates
  // only invites a misread. Evidence-flagged rows STAY in place (greyed by a 0 score):
  // that flag is a judgement the data might revise, not a standing instruction.
  // Follows the same --auditable-next filter as the sections above. It was built from
  // `rows` on the reasoning that the roster is reference material, but that listed paid-up
  // Follows the same --auditable-next filter as the sections above, so the header reports
  // how many of the roster that filter hides.
  const listedAll = rows.filter((r) => r.bigBoyOwner !== null)
    .sort((a, b) => a.bigBoyOwner.localeCompare(b.bigBoyOwner) || Number(a.token) - Number(b.token));
  const listedSet = new Set(pool);
  const listed = listedAll.filter((r) => listedSet.has(r));
  // Big boys are kept OUT of the two ranked sections and shown only in their own, below.
  // They are still full offense targets — this is presentation: mixing a 6-citizen operator
  // defending at ~100 gwei/gas into a list sorted by weak-link score buries the genuinely
  // weak rivals the score exists to surface.
  const targetable = pool.filter((r) => r.bigBoyOwner === null);
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

  // BIG BOYS — the heavyweight operators, kept in their own section rather than mixed into
  // the ranked lists above. They ARE targets and the engine will audit them; separating them
  // is about readability, since their scores sit low (deep reserves, hard defense) and would
  // otherwise pad the lists that are meant to surface weak links.
  if (listed.length > 0) {
    const hidden = listedAll.length - listed.length;
    console.log(
      `\n=== BIG BOYS (${listed.length}${hidden > 0 ? ` of ${listedAll.length}` : ""})` +
        ` — full targets, kept separate from the ranked sections above ===`,
    );
    console.log("operator     " + header);
    for (const r of listed) console.log(`${r.bigBoyOwner.padEnd(12)} ` + fmt(r));
  }

  // Rivals this scan saw skipping that the saved list doesn't know about yet. The list is
  // a snapshot — only as current as the last regeneration — so a rival that started
  // skipping recently sits in the wrong section until someone notices. Surface them every
  // run, and let --promote write them in.
  const newlyObserved = rows
    .filter((r) => r.skipperSource === "observed" && r.bigBoyOwner === null)
    .sort((a, b) => b.crossings - a.crossings || Number(a.token) - Number(b.token));
  if (newlyObserved.length > 0) {
    console.log(`\n--- newly observed skippers (${newlyObserved.length}) — attempted a skip, not yet on data/rival-skippers.json ---`);
    for (const r of newlyObserved) {
      console.log(`  #${r.token.padEnd(5)} ${r.skipClean}/${r.skipCaught} of ${r.crossings} skips · score ${r.score.toFixed(2)}`);
    }
    if (promote) {
      const candidates = [...new Set([...skipperSet, ...newlyObserved.map((r) => r.token)])];
      /**
       * Prune on the way through, and SAY what was pruned.
       *
       * The merge carries the existing file forward, so entries that have since left the
       * game survived every promote — the list was holding #1000, #1417 and #6028 (all
       * emigrated, two of them burned) as live audit targets. Same predicate the scan uses
       * for a rival row: no owner = burned, emigration contract = out of the game. Neither
       * can be audited, so both are dead weight crowding the paste list.
       *
       * Printed rather than dropped quietly: this rewrites a file the user curates by hand,
       * and silently deleting ids from it would be indistinguishable from losing them.
       */
      const pruned = [];
      const merged = candidates
        .filter((t) => {
          if (bigBoyOwnerOf.has(t) || allySet.has(t)) return false;
          const owner = ownerOf.get(t) ?? null;
          if (!owner) { pruned.push(`#${t} (burned/not in the collection)`); return false; }
          if (isEmigratedOwner(owner)) { pruned.push(`#${t} (emigrated)`); return false; }
          return true;
        })
        .sort((a, b) => Number(a) - Number(b));
      fs.writeFileSync(path.join(dataDir, "rival-skippers.json"), JSON.stringify(merged, null, 2) + "\n");
      console.log(`  -> promoted ${newlyObserved.length}; data/rival-skippers.json now holds ${merged.length}`);
      if (pruned.length > 0) {
        console.log(`  -> dropped ${pruned.length} that can no longer be audited: ${pruned.join(", ")}`);
      }
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
  // just copied out to compare against data/big-boys.json.
  console.log(`big boys   : ${listed.map((r) => r.token).join(",") || "(none)"}`);

  if (auditableNext) {
    const best = pool.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    console.log(`\nTop weak links for epoch ${ce + 1n}: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none catchable"}`);
    console.log("beh 1 = becomes auditable next boundary · beh 2+ = already auditable · afrd NO = owner can't cover the catch-up · score 0 = uncatchable");
    console.log("clean/caught of N = skips (boundaries crossed 2+ behind) survived / caught by an audit, out of attempted — all-clean = proven-safe cadence, caught often = soft target");
    console.log("beat2ep = bid to out-rank its defense over the LAST 2 EPOCHS (likely cost next boundary) · beatMax = same against its PEAK over the whole window (what it can mount again)");
    console.log("  '?' = the density model was falsified where this rival races (it out-ran a denser bundle, or tops the block while measuring below our tip) — out-bidding may not be the lever");
    console.log(`  '-' = no bid needed, our ${OUR_TIP_GWEI} gwei tip already out-ranks it · '?' = tops the block anyway, so something unobservable buys that position · '·' = no payment seen in that window`);
    console.log(`  both price YOUR bundle — ${PLAN_PAYMENTS} payment(s) + ${PLAN_AUDITS} audit(s) + payer = ${OUR_BUNDLE_GAS.toLocaleString()} gas @ ${OUR_TIP_GWEI} gwei tip — against DENSITY ((bid + tips)/gas, what builders sort on); a bidder's tip can be ~0 while its density is hundreds of gwei/gas`);
    console.log(`  change the shape with --payments N --audits M --tip G: the bid buys position for the WHOLE bundle, so carrying more costs proportionally more to reach the same density`);
    printLead();
    console.log("payBlk = blocks after the epoch boundary they paid (fastest / median) — the audit window; 0 = pays in the boundary block, '-' = no payment seen in window");
    console.log("bid = coinbase bid over the LAST 2 EPOCHS (ETH x bid-backed payments) — buys top-of-block, so a bidder is near-unauditable; shared when one operator co-pays several citizens; '?' = RPC has no tracing");
  }

  if (!auditableNext) {
    const best = [...rows].filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    console.log(`\nTop targets right now: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none auditable"}`);
    console.log("A = under audit · clean/caught of N = skips survived / skips that drew an audit, out of skips attempted");
    console.log("def -2/-1/max = THEIR priority tip in gwei, two epochs ago / one epoch ago / peak · '·' = no payment observed in that epoch");
    console.log("idx = lowest tx index they ever reached (position, not price) · theirBid -2/-1/max = their OWN coinbase bid in ETH over the same windows, leading zero dropped");
    console.log("tip-2/tip-1/tipMax = PRIORITY FEE (gwei) that out-densities them with no bid, priced against what they mounted TWO epochs ago / ONE epoch ago / at their peak");
    // Levers quoted in different units cannot be compared as printed, so convert. The tip is
    // charged over OUR_TIP_GAS (no bid tx on this route), which is what makes a flat bid the
    // cheaper lever on a small bundle even when the gwei figure looks modest.
    console.log(
      `  tip -> ETH on this plan (${OUR_TIP_GAS.toLocaleString()} gas, no bid tx): 1 gwei = ${tipEth(1).toFixed(6)} ETH` +
        ` · 100 gwei = ${tipEth(100).toFixed(4)} · 200 gwei = ${tipEth(200).toFixed(4)} · 400 gwei = ${tipEth(400).toFixed(4)}`,
    );
    console.log("bid-2/bid-1/bidMax = the same three bars priced as a FLAT BID at your configured tip instead · '-' = your tip already clears it · '·' = no payment observed in that epoch (missing data, not a priced answer)");
    console.log("read the three across: rising means they are escalating and only Max is safe to trust; a big Max beside two dashes means they CAN defend hard but did not lately");
    // The beat columns are meaningless without the bundle they were priced for, and this
    // is the default output — most runs never see the fuller legend under --auditable-next.
    console.log(`bid-2/bid-1/bidMax priced for ${PLAN_PAYMENTS} payment(s) + ${PLAN_AUDITS} audit(s) + payer = ${OUR_BUNDLE_GAS.toLocaleString()} gas @ ${OUR_TIP_GWEI} gwei tip (that tip costs ${((OUR_TIP_GWEI * OUR_BUNDLE_GAS) / 1e9).toFixed(4)} ETH across this bundle, on top of any bid below) · change with --payments N --audits M --tip G`);
    printLead();
  }
}
main().catch((e) => { console.error("target-scores failed:", e.message); process.exit(1); });
