// Analyse race timing: does submitting EARLIER buy a better position?
//
// Reads data/race-timing.jsonl, which the bot appends to on every bundle flush
// (packages/backend/src/race-timing.ts). Each row pairs how early we sent — leadMs, the
// gap between our send and the epoch boundary — with where we actually landed.
//
// Why this exists: a 21-boundary study of Titan/BuilderNet blocks found price barely
// explains position. Density→index correlated at only -0.22, high-tip and bid-backed
// players were statistically tied (Mann-Whitney p=0.52), and bidding past ~0.02 ETH bought
// nothing measurable. Submission timing is the remaining candidate, and it is the one input
// no on-chain analysis can see: only the sender knows when it pressed send.
//
// Usage: node scripts/race-timing.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "data", "race-timing.jsonl");

if (!fs.existsSync(file)) {
  console.log(`No telemetry yet at data/race-timing.jsonl.
It is written on every bundle flush in mainnet mode, so run the bot through at least a few
epoch boundaries first. Each boundary produces one row.`);
  process.exit(0);
}

const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const resolved = rows.filter((r) => r.landedIndex !== undefined);
const races = resolved.filter((r) => r.leadMs !== null);

console.log(`rows: ${rows.length} total · ${resolved.length} with a known outcome · ${races.length} boundary races\n`);
if (races.length === 0) {
  console.log("Nothing to analyse yet: rows appear once a receipt lands, and only");
  console.log("pre-boundary fires carry a leadMs (an ordinary tick has no boundary).");
  process.exit(0);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// --- the headline question ---
const c = corr(races.map((r) => r.leadMs), races.map((r) => r.landedIndex));
console.log("=== does sending earlier buy a better position? ===");
console.log(`  corr(leadMs, landedIndex) = ${c === null ? "n/a (need >=3 races)" : c.toFixed(2)}`);
console.log("  NEGATIVE means more lead -> earlier index (timing helps).");
console.log("  Near zero means timing does not explain position either.\n");

// --- did we even hit the block we aimed at? ---
const hit = races.filter((r) => r.hitTarget).length;
console.log("=== target block ===");
console.log(`  landed in the block we named: ${hit}/${races.length} (${(100 * hit / races.length).toFixed(0)}%)`);
console.log("  A miss means the bundle lost its slot and a later block took it — the");
console.log("  failure mode that costs a boundary race outright.\n");

// --- lead-time bands ---
console.log("=== position by how early we sent ===");
console.log("  lead band      |  n | median idx | mean idx | hit target");
const bands = [[-1e9, 0], [0, 1000], [1000, 3000], [3000, 6000], [6000, 12000], [12000, 1e9]];
for (const [lo, hi] of bands) {
  const g = races.filter((r) => r.leadMs >= lo && r.leadMs < hi);
  if (!g.length) continue;
  const label = lo < 0 ? "after boundary" : `${lo / 1000}-${hi === 1e9 ? "+" : hi / 1000}s`;
  console.log(`  ${label.padEnd(14)} | ${String(g.length).padStart(2)} | ${String(med(g.map((r) => r.landedIndex))).padStart(10)} | ${mean(g.map((r) => r.landedIndex)).toFixed(1).padStart(8)} | ${(100 * g.filter((r) => r.hitTarget).length / g.length).toFixed(0)}%`);
}

// --- controls: the price levers, on the same rows ---
console.log("\n=== the price levers, for comparison on the SAME races ===");
const withBid = races.filter((r) => BigInt(r.bidWei || "0") > 0n);
const bidEth = (r) => Number(BigInt(r.bidWei || "0")) / 1e18;
const cTip = corr(races.map((r) => r.tipGwei), races.map((r) => r.landedIndex));
const cBid = withBid.length >= 3 ? corr(withBid.map(bidEth), withBid.map((r) => r.landedIndex)) : null;
console.log(`  corr(tipGwei, landedIndex) = ${cTip === null ? "n/a" : cTip.toFixed(2)}  (n=${races.length})`);
console.log(`  corr(bidEth,  landedIndex) = ${cBid === null ? "n/a" : cBid.toFixed(2)}  (n=${withBid.length})`);
console.log("  Whichever correlates most strongly is the lever that actually moves position.");

// --- builder breakdown: ordering policy differs per builder ---
console.log("\n=== by winning builder ===");
const byBuilder = new Map();
for (const r of races) {
  const k = r.landedBuilder ?? "(unknown)";
  byBuilder.set(k, [...(byBuilder.get(k) ?? []), r]);
}
for (const [b, g] of [...byBuilder].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`  ${b.slice(0, 26).padEnd(26)} n=${String(g.length).padStart(2)} median idx ${String(med(g.map((r) => r.landedIndex))).padStart(3)} · hit target ${(100 * g.filter((r) => r.hitTarget).length / g.length).toFixed(0)}%`);
}

// --- acceptance: did the builder that won even have our bundle? ---
console.log("\n=== did the winning builder receive our bundle? ===");
let matched = 0, unmatched = 0;
for (const r of races) {
  if (!r.landedBuilder) continue;
  const tag = r.landedBuilder.toLowerCase();
  const got = (r.acceptedBy ?? []).some((h) => {
    const stem = h.toLowerCase().replace(/^rpc\.|^relay\./, "").split(".")[0];
    return stem && tag.includes(stem);
  });
  if (got) matched++; else unmatched++;
}
console.log(`  winner had our bundle: ${matched} · winner did NOT: ${unmatched}`);
console.log("  A high 'did NOT' count means the loss is COVERAGE, not price or timing:");
console.log("  we simply weren't in the winning builder's book.");

if (races.length < 10) {
  console.log(`\nNOTE: only ${races.length} race(s). Treat every figure above as provisional —`);
  console.log("correlations on <10 points move wildly with one more sample.");
}
