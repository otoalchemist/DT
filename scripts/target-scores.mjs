// Rank rival citizens by how attractive they are to AUDIT.
//
// The strongest audit target is a rival whose owner can't afford to catch it up (so an
// audit may lead to a kill), that defends weakly (so you can actually land the audit),
// and that isn't shielded by a bribe. This scores every rival in data/rival-targets.json
// on those axes and ranks them — splitting the curated skippers (data/rival-skippers.json)
// from the rest, since you asked to see the non-skippers too.
//
// Columns:
//   beh       epochs behind now (2+ = auditable this instant; 1 = grace)
//   und       under audit already (can't be re-audited)
//   x/N       skip cadence: boundaries crossed delinquent / boundaries sampled over the
//             window — how CONSISTENTLY it lets itself go 2+ behind
//   bribe     bribe balance (each is one free audit-escape; lowers attractiveness)
//   ins       has life insurance (bailout risk — an audit may be undone by a bailout)
//   ownerBal  owner's ETH balance
//   cits      how many live citizens that owner holds (portfolio; thin = fragile)
//   runway    ownerBal / (cits * one-epoch tax) — epochs the owner can sustain
//   owesNext  what THIS token owes to catch up at the NEXT boundary
//   afford    can the owner cover owesNext right now?
//   tip/idx   defense strength from payment history: best (max) tip gwei, best (lowest)
//             tx index reached. idx 0 + never-audited = tops the block, ~uncatchable
//   aud       times ANY player successfully audited it in the window (proven catchable)
//   score     composite audit-attractiveness (higher = better target). 0 = effectively
//             uncatchable (always tops the block, never audited) or already under audit.
//
// Detection is on-chain only; it cannot see off-chain builder deals or pending mempool
// payments. An audit only STARTS a 24h timer — a bailout or a late payment can still
// save the target, so "strapped" is a probability, not a guarantee.
//
// Usage:
//   node scripts/target-scores.mjs                    # score every rival, ranked table
//   node scripts/target-scores.mjs --auditable-next   # only weak links auditable next boundary
//   node scripts/target-scores.mjs --epochs 20        # widen the cadence look-back
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
  const rivals = JSON.parse(fs.readFileSync(path.join(dataDir, "rival-targets.json"), "utf8")).map(String);
  const skipperSet = new Set(JSON.parse(fs.readFileSync(path.join(dataDir, "rival-skippers.json"), "utf8")).map(String));

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
    slice.forEach((t, k) => { const rc = m2.get((i + k) * 2 + 1)?.result; if (rc) meta.set(t, { gasUsed: BigInt(rc.gasUsed), eff: BigInt(rc.effectiveGasPrice), idx: Number(BigInt(rc.transactionIndex)), blk: BigInt(rc.blockNumber) }); });
  }
  const blks = [...new Set([...meta.values()].map((m) => m.blk.toString()))];
  const bf = new Map();
  for (let i = 0; i < blks.length; i += 60) { const slice = blks.slice(i, i + 60); const m2 = new Map((await batch(slice.map((b, k) => ({ jsonrpc: "2.0", id: i + k, method: "eth_getBlockByNumber", params: [hb(BigInt(b)), false] })))).map((r) => [r.id, r])); slice.forEach((b, k) => { const bl = m2.get(i + k)?.result; if (bl) bf.set(b, BigInt(bl.baseFeePerGas ?? "0x0")); }); }
  const defense = {};
  for (const l of payLogs) { const tok = BigInt(l.topics[1]).toString(); const m = meta.get(l.transactionHash); if (!m) continue; const tipG = Number(m.eff - (bf.get(m.blk.toString()) ?? 0n)) / 1e9; const dd = (defense[tok] ??= { maxTip: 0, bestIdx: Infinity, pays: 0 }); dd.pays++; dd.maxTip = Math.max(dd.maxTip, tipG); dd.bestIdx = Math.min(dd.bestIdx, m.idx); }

  // Skip cadence: sample lastEpochPaid at the last block of each prior epoch (same method
  // as rival-skippers.mjs). crossings = boundaries the token was 2+ behind entering.
  const firstEpoch = ce - epochsArg + 1n > 2n ? ce - epochsArg + 1n : 2n;
  const crossings = {}; const sampled = {}; for (const t of rivals) { crossings[t] = 0; sampled[t] = 0; }
  for (let E = firstEpoch; E <= ce; E++) {
    const bts = startTime + (E - 1n) * EPOCH_DURATION;
    const lastB = await lastBlockBefore(bts, latest - 100000n > 1n ? latest - 100000n : 1n, latest);
    const rq = rivals.map((t, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: GAME, data: SEL.lastEpochPaid + enc(t) }, hb(lastB)] }));
    const m2 = new Map((await batch(rq)).map((r) => [r.id, r]));
    rivals.forEach((t, i) => { const r = m2.get(i + 1); if (r && r.result && r.result !== "0x") { sampled[t]++; if (BigInt(r.result) + 2n <= E) crossings[t]++; } });
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
    // Effectively uncatchable: reaches top-of-block and no one has ever audited it.
    const uncatchable = bestIdx !== null && bestIdx <= 1 && aud === 0;

    let score = 0;
    if (!under && !uncatchable) {
      if (!affordNext) score += 3;                                  // can't cover next catch-up
      score += Math.max(0, Math.min(1, (10 - runway) / 10)) * 2;    // low runway
      score += Math.max(0, Math.min(1, (30 - dd.maxTip) / 30)) * 1.5; // weak tip
      if (bestIdx !== null) score += Math.min(1, bestIdx / 50);     // lands late in the block
      if (aud > 0) score += 1;                                      // proven catchable
      if (bribes > 0) score -= 1;                                   // free escape
      score = Math.max(0, score);
    }
    rows.push({
      token: t, skipper: skipperSet.has(t), behind, under, killable: under && due <= nowSec,
      crossings: crossings[t], sampled: sampled[t], bribes, ins,
      ownerBalEth: +eth(bal).toFixed(4), cits, runwayEpochs: runway === Infinity ? null : +runway.toFixed(1),
      owesNextEth: +eth(owesNext).toFixed(4), affordNext, maxTip: +dd.maxTip.toFixed(1), bestIdx, audited: aud,
      uncatchable, score: +score.toFixed(2),
    });
  }

  const hoursToBoundary = Number(nextBoundary - nowSec) / 3600;
  if (asJson) { console.log(JSON.stringify({ epoch: Number(ce), hoursToNextBoundary: +hoursToBoundary.toFixed(1), epochTaxEth: eth(epochTax), rows }, null, 2)); return; }

  const fmt = (r) =>
    `#${r.token.padEnd(5)} ${String(r.behind).padStart(3)} ${r.under ? "A" : "-"}  ${String(r.crossings)}/${String(r.sampled).padEnd(2)} ${String(r.bribes).padStart(2)}  ${r.ins ? "Y" : "-"}  ` +
    `${r.ownerBalEth.toFixed(4).padStart(8)} ${String(r.cits).padStart(3)} ${(r.runwayEpochs === null ? "inf" : r.runwayEpochs.toFixed(1)).padStart(6)}  ` +
    `${r.owesNextEth.toFixed(4)} ${(r.affordNext ? "yes" : "NO").padStart(4)}  ${r.maxTip.toFixed(1).padStart(5)} ${String(r.bestIdx ?? "-").padStart(4)} ${String(r.audited).padStart(3)}  ${r.score.toFixed(2).padStart(5)}`;
  const header = "tok    beh A  x/N  br ins  ownerBal cit runway  owesNxt afrd  tip  idx aud  score";
  // beh column doubles as the timing cue: 1 = becomes auditable next boundary, 2+ = already auditable.

  // --auditable-next keeps only rows that will be auditable when the epoch rolls: 1+
  // behind and not already under audit. behind 1 -> 2 behind next -> newly auditable;
  // behind 2+ (and not under audit) is already auditable and stays so.
  const pool = auditableNext ? rows.filter((r) => r.behind >= 1 && !r.under) : rows;
  const skippers = pool.filter((r) => r.skipper).sort((a, b) => b.score - a.score);
  const others = pool.filter((r) => !r.skipper).sort((a, b) => b.score - a.score);
  const scope = auditableNext
    ? `weak-link candidates becoming auditable at epoch ${ce + 1n}`
    : `ranked by audit-attractiveness`;
  console.log(`epoch ${ce} · next boundary in ${hoursToBoundary.toFixed(1)}h · one epoch of tax = ${eth(epochTax).toFixed(5)} ETH · window ${firstEpoch}..${ce}\n`);
  console.log(`=== RIVAL SKIPPERS (${skippers.length}) — ${scope} ===`);
  console.log(header); skippers.forEach((r) => console.log(fmt(r)));
  console.log(`\n=== OTHER RIVALS (${others.length}) — not on the skippers list, ${scope} ===`);
  console.log(header); others.forEach((r) => console.log(fmt(r)));

  // Paste-ready target lists: catchable only (score > 0, drops uncatchable/under-audit),
  // ranked best-first, comma-separated for the offense target box.
  const ids = (list) => list.filter((r) => r.score > 0).map((r) => r.token).join(",");
  console.log(`\n--- paste (ranked, catchable only) ---`);
  console.log(`skippers    : ${ids(skippers) || "(none)"}`);
  console.log(`non-skippers: ${ids(others) || "(none)"}`);

  if (auditableNext) {
    const best = pool.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    console.log(`\nTop weak links for epoch ${ce + 1n}: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none catchable"}`);
    console.log("beh 1 = becomes auditable next boundary · beh 2+ = already auditable · afrd NO = owner can't cover the catch-up · score 0 = uncatchable");
  }

  if (!auditableNext) {
    const best = [...rows].filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    console.log(`\nTop targets right now: ${best.length ? best.map((r) => `#${r.token} (${r.score})`).join(", ") : "none auditable"}`);
    console.log("A = under audit · x/N = boundaries crossed delinquent / sampled · score 0 = uncatchable or under audit");
  }
}
main().catch((e) => { console.error("target-scores failed:", e.message); process.exit(1); });
