// Which Citizen tokens changed hands recently — and specifically, whose.
//
// Written to answer one question: after a suspected leak of this bot, did anyone move their
// Citizens out of the wallet that holds them? A holder who thinks they have been identified
// moves assets; that shows up on chain as an ERC-721 Transfer between two non-zero addresses.
//
// READ THE CAVEATS. This script reports transfers. It cannot report MOTIVE, and there are
// several innocent reasons a Citizen moves:
//
//   - a sale or OTC trade (the new owner is usually a marketplace/aggregator contract, or the
//     transfer is one of several in the same tx);
//   - EMIGRATION into ABBC / Governors, which is a transfer to the emigration contract and is
//     labelled separately here because it is a game action, not a wallet rotation;
//   - a holder consolidating or rotating wallets for their own reasons, at any time;
//   - a mint (from 0x0) or a burn/kill (to 0x0), both excluded below.
//
// The signal worth looking for is a SWEEP: one address moving several Citizens to one fresh
// address in a short window, where the destination has no prior Citizen history. A single
// token moving to a marketplace is noise.
//
// Usage:
//   node scripts/token-moves.mjs                    # last 24h
//   node scripts/token-moves.mjs --hours 48
//   node scripts/token-moves.mjs --all              # include allies + unlisted, not just rivals
//   node scripts/token-moves.mjs --json
//   RPC_HTTP_URL=... node scripts/token-moves.mjs
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
const SEL_CITIZENS = "0x7c2e7201"; // citizens()
// ERC-721 Transfer(address,address,uint256) — indexed from, to, tokenId.
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
// Emigration destinations: a Citizen sent here left the main game (see packages/backend/src/emigration.ts
// and EMIGRATION_CONTRACTS in scripts/target-scores.mjs — duplicated because this script is standalone).
const EMIGRATION = {
  "0xe56d011262d4738dc8307fb8a4ae48b2bfc20e7c": "Governor",
  "0xbfffc99fa75a0fea45b765d11d8e52f8e1114f8c": "ABBC",
};

const LOG_RANGE = 8000n; // getLogs block-range chunk, matching the other scripts
const SECONDS_PER_BLOCK = 12;

// --- args ---
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showAll = args.includes("--all");
const hours = (() => {
  const i = args.indexOf("--hours");
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 24;
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
    console.error("No RPC configured. Set RPC_HTTP_URL or ALCHEMY_API_KEY, or save an Alchemy key in the app first.");
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
const hexBlk = (n) => "0x" + n.toString(16);
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Token id lists the team maintains, so each move can be attributed. */
function loadList(file, key) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    const ids = Array.isArray(j) ? j : (key ? j[key] : null) ?? [];
    return new Set(ids.map((x) => String(BigInt(x))));
  } catch {
    return new Set();
  }
}

async function main() {
  const citizens = "0x" + (await rpc("eth_call", [{ to: GAME, data: SEL_CITIZENS }, "latest"])).slice(26);
  const head = BigInt(await rpc("eth_blockNumber", []));
  const span = BigInt(Math.round((hours * 3600) / SECONDS_PER_BLOCK));
  const from = head > span ? head - span : 0n;

  const rivals = loadList("rival-targets.json");
  const skippers = loadList("rival-skippers.json");
  const allies = loadList("ally-tokens.json");
  const bigBoys = loadList("big-boys.json", "tokenIds");

  if (!asJson) {
    console.log(`Citizens ${citizens}`);
    console.log(`Scanning blocks ${from}..${head} (~${hours}h) for Transfer events\n`);
  }

  // --- collect transfers ---
  const moves = [];
  for (let start = from; start <= head; start += LOG_RANGE) {
    const end = start + LOG_RANGE - 1n > head ? head : start + LOG_RANGE - 1n;
    const logs = await rpc("eth_getLogs", [
      { address: citizens, topics: [TOPIC_TRANSFER], fromBlock: hexBlk(start), toBlock: hexBlk(end) },
    ]);
    for (const l of logs) {
      // Non-indexed-tokenId ERC721s would put it in data; this collection indexes all three,
      // so a 4-topic log is the only shape we can attribute a token from.
      if (!l.topics || l.topics.length < 4) continue;
      const fromA = addrOf(l.topics[1]);
      const toA = addrOf(l.topics[2]);
      const tokenId = String(BigInt(l.topics[3]));
      if (fromA === ZERO || toA === ZERO) continue; // mint / burn-kill, not a wallet move
      moves.push({
        tokenId,
        from: fromA,
        to: toA,
        block: Number(BigInt(l.blockNumber)),
        txHash: l.transactionHash,
        emigration: EMIGRATION[toA] ?? null,
      });
    }
  }

  // --- label + filter ---
  const label = (id) =>
    allies.has(id) ? "ALLY"
    : skippers.has(id) ? "skipper"
    : rivals.has(id) ? "rival"
    : bigBoys.has(id) ? "big-boy"
    : "unlisted";
  const listed = moves.map((m) => ({ ...m, tag: label(m.tokenId) }));
  const shown = showAll ? listed : listed.filter((m) => m.tag !== "unlisted");

  if (asJson) {
    console.log(JSON.stringify({ citizens, fromBlock: Number(from), toBlock: Number(head), hours, moves: listed }, null, 2));
    return;
  }

  if (moves.length === 0) {
    console.log("No Citizen changed wallets in this window (no non-mint, non-burn Transfer at all).");
    return;
  }

  // --- group by sender: a wallet ROTATION is several tokens leaving one address together,
  // which is the only pattern here that means anything. One token to a marketplace is noise.
  const bySender = new Map();
  for (const m of shown) {
    if (!bySender.has(m.from)) bySender.set(m.from, []);
    bySender.get(m.from).push(m);
  }

  console.log(`${moves.length} wallet-to-wallet transfer(s); ${shown.length} involve a token on our lists\n`);
  const rows = [...bySender.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [sender, ms] of rows) {
    const dests = [...new Set(ms.map((m) => m.to))];
    const emi = ms.filter((m) => m.emigration).length;
    console.log(
      `${short(sender)} -> ${dests.length === 1 ? short(dests[0]) : `${dests.length} addresses`}` +
        `  ${ms.length} token(s)${emi ? ` (${emi} EMIGRATION, not a wallet move)` : ""}`,
    );
    for (const m of ms.sort((a, b) => a.block - b.block)) {
      console.log(
        `    #${m.tokenId.padEnd(6)} ${m.tag.padEnd(8)} block ${m.block}` +
          `${m.emigration ? `  -> ${m.emigration}` : ""}  ${m.txHash}`,
      );
    }
    console.log("");
  }

  const sweeps = rows.filter(([, ms]) => ms.length >= 2 && !ms.every((m) => m.emigration));
  console.log(
    sweeps.length === 0
      ? "No multi-token sweep from a single wallet — nothing that looks like someone clearing out."
      : `${sweeps.length} wallet(s) moved 2+ Citizens — the only pattern here worth a closer look.`,
  );
  console.log(
    "\nA transfer is not a motive: sales, OTC trades, emigration and ordinary wallet rotation\n" +
      "look identical on chain. Check the destination's history before reading anything into it.",
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
