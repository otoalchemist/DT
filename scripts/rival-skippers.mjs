// Regenerate data/rival-skippers.json from recent on-chain history.
//
// A "skipper" is a rival that repeatedly lets a token go 2+ epochs behind by the
// epoch boundary — i.e. it pays on a ~2-epoch cadence and is therefore auditable at
// (nearly) every second boundary. This is the exact pattern that lets the bot's
// pre-boundary audit catch it (see fetchOffenseCandidates / queuePreBoundaryAudits).
//
// Heuristic: for each of the last N epoch boundaries, read every candidate rival's
// lastEpochPaid at the LAST BLOCK OF THE PRIOR EPOCH (before anyone can pay in the
// new epoch — so it doesn't matter whether they pay in block 1 or block 500). A
// token "crossed delinquent" into epoch E when lastEpochPaid + 2 <= E. We then score
// by how often it crossed AND how regular the cadence is:
//   - crossings >= MIN_CROSSINGS over the window, OR
//   - same-parity streak (crossed on boundaries of one parity) >= MIN_PARITY_STREAK, OR
//   - total crossings >= STRONG_CROSSINGS (frequent even if slightly irregular).
// Both thresholds are tunable below. Tokens are drawn from data/rival-targets.json
// (the pinned universe) so skippers are always a subset of what you already target.
//
// Usage:
//   node scripts/rival-skippers.mjs                 # scan, print, and WRITE the file
//   node scripts/rival-skippers.mjs --dry-run       # scan and print, write nothing
//   node scripts/rival-skippers.mjs --epochs 20     # widen the look-back window
//   RPC_HTTP_URL=... node scripts/rival-skippers.mjs
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
const SEL_LAST_EPOCH_PAID = "0x72e012d6"; // lastEpochPaid(uint256)
const SEL_CURRENT_EPOCH = "0x76671808";   // currentEpoch()
const SEL_START_TIME = "0x78e97925";      // startTime()
const SEL_CITIZENS = "0x7c2e7201";        // citizens()
const SEL_OWNER_OF = "0x6352211e";        // ownerOf(uint256)

// --- tunable thresholds ---
// A rival qualifies if it crossed delinquent >= MIN_CROSSINGS times in the window.
// Set to 2 so the mixed-signal tier (rivals that skipped on 2-3 boundaries) folds in
// alongside the strong 4-5x cadence payers — a single crossing is treated as noise,
// two or more as an intentional pattern worth targeting. MIN_PARITY_STREAK /
// STRONG_CROSSINGS remain as the ORed "clean-cadence" and "frequent" shortcuts, but
// with MIN_CROSSINGS at 2 they no longer gate anything extra; kept for easy tightening.
const DEFAULT_EPOCHS = 10;   // how many recent boundaries to inspect
const MIN_CROSSINGS = 2;     // must cross this many times in the window to qualify
const MIN_PARITY_STREAK = 4; // ...OR cross this many times on one parity (clean 2-epoch cadence)
const STRONG_CROSSINGS = 4;  // ...OR cross this many times total (frequent, cadence allowed to wobble)

// --- args ---
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
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
        const s = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
        return s.alchemyApiKey;
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
const enc = (t) => t.toString(16).padStart(64, "0");
const callData = (sel, tokenId) => sel + enc(tokenId);

async function ethCall(to, data, block = "latest") {
  return rpc("eth_call", [{ to, data }, block]);
}
async function blockTs(n) {
  const b = await rpc("eth_getBlockByNumber", [hexBlk(n), false]);
  return BigInt(b.timestamp);
}
// Largest block whose timestamp is strictly before `ts` (the last block of the
// prior epoch). Bounded binary search over a recent window.
async function lastBlockBefore(ts, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await blockTs(mid)) < ts) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

async function main() {
  const rivals = JSON.parse(
    fs.readFileSync(path.join(dataDir, "rival-targets.json"), "utf8"),
  ).map((x) => BigInt(x));

  const currentEpoch = BigInt(await ethCall(GAME, SEL_CURRENT_EPOCH));
  const startTime = BigInt(await ethCall(GAME, SEL_START_TIME));
  const citizens = "0x" + (await ethCall(GAME, SEL_CITIZENS)).slice(26);
  const latest = BigInt(parseInt(await rpc("eth_blockNumber", []), 16));

  const firstEpoch = currentEpoch - epochsArg + 1n > 1n ? currentEpoch - epochsArg + 1n : 2n;
  console.error(
    `Scanning boundaries into epochs ${firstEpoch}..${currentEpoch} ` +
      `(${rivals.length} rivals, citizens ${citizens})`,
  );

  // token -> array of epochs it crossed delinquent into
  const crossings = {};
  for (let E = firstEpoch; E <= currentEpoch; E++) {
    const boundaryTs = startTime + (E - 1n) * EPOCH_DURATION;
    // last block of epoch E-1: search a generous window behind `latest`.
    const lastB = await lastBlockBefore(boundaryTs, latest - 90000n > 1n ? latest - 90000n : 1n, latest);

    // one batched request: lastEpochPaid (game) + ownerOf (citizens) per rival
    const reqs = [];
    const map = [];
    let lid = 0;
    for (const t of rivals) {
      reqs.push({ jsonrpc: "2.0", id: ++lid, method: "eth_call", params: [{ to: GAME, data: callData(SEL_LAST_EPOCH_PAID, t) }, hexBlk(lastB)] });
      map.push({ token: t.toString(), kind: "lep", id: lid });
      reqs.push({ jsonrpc: "2.0", id: ++lid, method: "eth_call", params: [{ to: citizens, data: callData(SEL_OWNER_OF, t) }, hexBlk(lastB)] });
      map.push({ token: t.toString(), kind: "own", id: lid });
    }
    const res = await rpcBatch(reqs);
    const byId = new Map(res.map((r) => [r.id, r]));
    const state = {};
    for (const t of rivals) state[t.toString()] = { lep: null, alive: false };
    for (const m of map) {
      const r = byId.get(m.id);
      if (m.kind === "lep") {
        if (r && r.result && r.result !== "0x") state[m.token].lep = BigInt(r.result);
      } else {
        state[m.token].alive = !!(r && r.result && !r.error);
      }
    }

    let n = 0;
    for (const t of rivals) {
      const { lep, alive } = state[t.toString()];
      if (lep === null || !alive) continue;
      if (lep + 2n <= E) {
        (crossings[t.toString()] ??= []).push(Number(E));
        n++;
      }
    }
    console.error(`  into epoch ${E} (last block ${lastB} of ${E - 1n}): ${n} crossed`);
  }

  // Score: qualify a token as a skipper if it crossed often and/or on a clean
  // same-parity cadence.
  const parityStreak = (epochs) => {
    const even = epochs.filter((e) => e % 2 === 0).length;
    const odd = epochs.length - even;
    return Math.max(even, odd);
  };
  const skippers = [];
  const detail = [];
  for (const [token, epochs] of Object.entries(crossings)) {
    const total = epochs.length;
    const streak = parityStreak(epochs);
    // Primary gate is crossing count. The parity/frequency shortcuts still qualify a
    // token on their own, so tightening MIN_CROSSINGS later can't silently drop a
    // clean-cadence or high-frequency skipper.
    const qualifies =
      total >= MIN_CROSSINGS || streak >= MIN_PARITY_STREAK || total >= STRONG_CROSSINGS;
    if (qualifies) {
      skippers.push(BigInt(token));
      detail.push({ token, total, streak, epochs });
    }
  }
  skippers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = skippers.map((x) => x.toString());

  console.error("\nQualified skippers (token: crossings, best same-parity streak):");
  detail
    .sort((a, b) => Number(a.token) - Number(b.token))
    .forEach((d) => console.error(`  #${d.token}: ${d.total}x, parity ${d.streak}  [${d.epochs.join(",")}]`));
  console.error(`\n${out.length} skippers`);

  if (dryRun) {
    console.error("(--dry-run: not writing the file)");
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const target = path.join(dataDir, "rival-skippers.json");
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.error(`Wrote ${target}`);
}

main().catch((err) => {
  console.error("rival-skippers scan failed:", err.message);
  process.exit(1);
});
