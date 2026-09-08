// Dry-run the next boundary: would each payment and each audit actually succeed?
//
// Answers the question you cannot otherwise answer on an audit-only day — "my payment path
// is idle, is it still healthy?" — without spending anything. Nothing is signed, nothing is
// broadcast; every action is an `eth_call` executed AT the boundary timestamp using block
// overrides, which is the exact mechanism the bot's own pre-boundary simulation uses
// (simulateAtTimestamp in packages/backend/src/flashbots.ts).
//
// Why the timestamp override matters: a pre-boundary payment is priced for the NEXT epoch and
// is invalid until the boundary has passed. Simulated against "now" it reverts, which tells
// you nothing. Simulated at the boundary instant it reproduces the state the transaction will
// really execute in — including the case that cost a payment at the epoch-178 boundary, where
// a bundle mined one slot early and reverted.
//
// Usage:
//   npm run dry-run-boundary                 # next boundary, wallets from the keystore
//   npm run dry-run-boundary -- --epochs 2   # two boundaries ahead
//   npm run dry-run-boundary -- --tokens 2036,5852
//   RPC_HTTP_URL=... npm run dry-run-boundary
//
// Requires an RPC that supports eth_call block overrides (Alchemy does). If yours does not,
// the script says so rather than reporting a false pass.
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
const BASE_TAX_RATE_WEI = 690_000_000_000_000n; // 0.00069 ETH per epoch-unit
const AUDIT_COST_WEI = 690_000_000_000_000n;
const GAS_PER_PAYMENT = 120_000n;
const PRE_BOUNDARY_OFFENSE_GAS = 250_000n;
// Selectors
const SEL_CURRENT_EPOCH = "0x76671808";
const SEL_START_TIME = "0x78e97925";
const SEL_CITIZENS = "0x7c2e7201";
const SEL_LAST_EPOCH_PAID = "0x72e012d6";
const SEL_AUDIT_DUE = "0x6f9fb98a";
const SEL_AUDIT_LIMIT = "0x9f8a13d7";
const SEL_AUDITS_USED = "0x2f3b3d9e";
const SEL_PAY_TAXES = "0x58670017"; // payTaxes(uint256,uint256)
const SEL_AUDIT = "0x5daba7c0";     // audit(uint256,uint256)
const SEL_OWNER_OF = "0x6352211e";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const epochsAhead = BigInt(flag("epochs", "1"));
const tokensArg = flag("tokens", null);

function resolveRpc() {
  if (process.env.RPC_HTTP_URL) return process.env.RPC_HTTP_URL;
  const key =
    process.env.ALCHEMY_API_KEY ||
    (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).alchemyApiKey; } catch { return null; } })();
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
  if (j.error) throw Object.assign(new Error(j.error.message ?? "rpc error"), { rpcError: j.error });
  return j.result;
}
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16);
const eth = (wei) => (Number(wei) / 1e18).toFixed(5);
const call = async (data, block = "latest") => rpc("eth_call", [{ to: GAME, data }, block]);
const tryCall = async (data) => { try { return BigInt(await call(data)); } catch { return null; } };

/** Wallet addresses from the keystore. Only the `address` field is read — never a key. */
function walletsFromKeystore() {
  const out = [];
  for (const f of ["wallets.json", "wallet.keystore.json"]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
      // The keystore nests its entries under `wallets`; older shapes were a bare array or a
      // single object. Handle all three so this works on any vintage of data/ folder.
      const entries = Array.isArray(j) ? j : Array.isArray(j?.wallets) ? j.wallets : [j];
      for (const e of entries) if (e?.address) out.push(String(e.address).toLowerCase());
    } catch { /* absent */ }
  }
  return [...new Set(out)];
}

/** Citizens held by `owner`, via Alchemy's owner index (same source the bot uses). */
async function ownedTokens(citizens, owner) {
  const base = RPC.replace("/v2/", "/nft/v3/");
  const ids = [];
  let pageKey;
  for (let page = 0; page < 20; page++) {
    const u = new URL(`${base}/getNFTsForOwner`);
    u.searchParams.set("owner", owner);
    u.searchParams.set("contractAddresses[]", citizens);
    u.searchParams.set("withMetadata", "false");
    u.searchParams.set("pageSize", "100");
    if (pageKey) u.searchParams.set("pageKey", pageKey);
    const r = await fetch(u);
    if (!r.ok) return null; // NFT API unavailable — caller falls back to --tokens
    const j = await r.json();
    for (const n of j.ownedNfts ?? []) ids.push(BigInt(n.tokenId));
    pageKey = j.pageKey;
    if (!pageKey) break;
  }
  return ids;
}

/**
 * Run one action at `atTime` via block overrides. Returns null on success, or the revert.
 * Mirrors simulateAtTimestamp: state overrides are empty, so the wallet's REAL balance
 * applies and an underfunded wallet shows up as a failure rather than a false pass.
 */
async function simulateAt(from, data, valueWei, gas, atTime) {
  try {
    await rpc("eth_call", [
      { from, to: GAME, data, value: hex(valueWei), gas: hex(gas) },
      "latest",
      {},
      { time: hex(atTime) },
    ]);
    return null;
  } catch (err) {
    const e = err.rpcError ?? {};
    const sel = typeof e.data === "string" ? e.data.slice(0, 10) : null;
    // Distinguish "your RPC cannot do this" from "the contract said no" — reporting the
    // former as a revert would be a false alarm on a healthy setup.
    if (e.data === undefined && !/revert/i.test(err.message)) {
      return { unsupported: true, message: err.message };
    }
    return { selector: sel, message: err.message };
  }
}

const REVERTS = {
  "0x72030254": "NotDelinquent — the target is not (or no longer) auditable",
  "0x7e273289": "ERC721NonexistentToken — that token is burned",
  "0x042ee60a": "already under audit",
  "0xe72c6951": "not auditable yet at this timestamp",
};
const explain = (r) =>
  r.unsupported ? `RPC does not support block overrides (${r.message.slice(0, 60)})`
  : `${r.selector ?? "revert"}${REVERTS[r.selector] ? ` — ${REVERTS[r.selector]}` : ""}`;

async function main() {
  const startTime = BigInt(await call(SEL_START_TIME));
  const epochNow = BigInt(await call(SEL_CURRENT_EPOCH));
  const citizens = "0x" + (await call(SEL_CITIZENS)).slice(26);
  const targetEpoch = epochNow + epochsAhead;
  // Epoch N begins at startTime + (N-1)*EPOCH.
  const boundaryTs = startTime + (targetEpoch - 1n) * EPOCH_DURATION;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  console.log(`epoch now ${epochNow} -> simulating the boundary into epoch ${targetEpoch}`);
  console.log(`boundary   ${boundaryTs} (${new Date(Number(boundaryTs) * 1000).toISOString()}), ` +
    `${((Number(boundaryTs - nowSec)) / 3600).toFixed(2)}h away`);

  const wallets = walletsFromKeystore();
  if (wallets.length === 0) {
    console.error("\nNo wallet address found in data/. Pass --tokens and it will use the on-chain owner.");
  }

  // --- which citizens ---
  let owned = [];
  if (tokensArg) {
    owned = tokensArg.split(",").map((s) => BigInt(s.trim())).filter((x) => x > 0n);
  } else {
    for (const a of wallets) {
      const ids = await ownedTokens(citizens, a);
      if (ids === null) {
        console.error("\nAlchemy NFT API unavailable — rerun with --tokens 2036,5852");
        process.exit(1);
      }
      owned.push(...ids);
    }
    owned = [...new Set(owned.map(String))].map(BigInt);
  }
  if (owned.length === 0) { console.log("\nNo citizens found to simulate."); return; }

  // Resolve each citizen's owner so we simulate `from` the address that can actually sign.
  const ownerOf = new Map();
  for (const id of owned) {
    try { ownerOf.set(id, "0x" + (await rpc("eth_call", [{ to: citizens, data: SEL_OWNER_OF + w(id) }, "latest"])).slice(26)); }
    catch { ownerOf.set(id, null); }
  }

  console.log(`\n=== PAYMENT dry-run (${owned.length} citizen(s)) ===`);
  console.log("token | behind@target | would pay      | result");
  let payFail = 0, paySkip = 0;
  for (const id of owned) {
    const lep = await tryCall(SEL_LAST_EPOCH_PAID + w(id));
    const from = ownerOf.get(id);
    if (lep === null || !from) { console.log(`  #${String(id).padEnd(5)} | (unreadable — burned?)`); continue; }
    // Exactly what queuePreBoundaryPayments would send: skip if already current for the
    // target, else one epoch at the TARGET epoch's rate.
    if (lep >= targetEpoch) {
      console.log(`  #${String(id).padEnd(5)} | ${String(targetEpoch - lep).padEnd(13)} | —              | skipped: already current for epoch ${targetEpoch}`);
      paySkip++;
      continue;
    }
    const value = 1n * targetEpoch * BASE_TAX_RATE_WEI;
    const r = await simulateAt(from, SEL_PAY_TAXES + w(id) + w(1), value, GAS_PER_PAYMENT, boundaryTs);
    const verdict = r === null ? "WOULD SUCCEED" : `WOULD REVERT: ${explain(r)}`;
    if (r !== null) payFail++;
    console.log(`  #${String(id).padEnd(5)} | ${String(targetEpoch - lep).padEnd(13)} | ${eth(value)} ETH    | ${verdict}`);
  }

  // --- audits: eligible auditors x pinned/auditable targets ---
  let pinned = [];
  try { pinned = (JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).offenseTargetTokenIds ?? []).map(String); } catch {}
  console.log(`\n=== AUDIT dry-run (${pinned.length} pinned target(s)) ===`);
  if (pinned.length === 0) {
    console.log("  no pinned targets in data/config.json — nothing to simulate");
  } else {
    // One auditor is enough to prove the path; the bot deals slots round-robin.
    const auditor = owned.find((id) => ownerOf.get(id));
    const from = auditor ? ownerOf.get(auditor) : null;
    if (!auditor || !from) {
      console.log("  no usable auditor citizen");
    } else {
      const aDue = await tryCall(SEL_AUDIT_DUE + w(auditor));
      console.log(`  auditing from #${auditor}${aDue && aDue !== 0n ? "  (NOTE: itself under audit — the bot would skip it)" : ""}`);
      console.log("  target | result");
      for (const t of pinned) {
        const lep = await tryCall(SEL_LAST_EPOCH_PAID + w(t));
        if (lep === null) { console.log(`   #${String(t).padEnd(6)} | unreadable (burned/killed)`); continue; }
        const auditableAtTarget = lep + 2n <= targetEpoch;
        if (!auditableAtTarget) {
          console.log(`   #${String(t).padEnd(6)} | skipped: lastEpochPaid ${lep}, needs <= ${targetEpoch - 2n} at epoch ${targetEpoch}`);
          continue;
        }
        const r = await simulateAt(from, SEL_AUDIT + w(auditor) + w(t), AUDIT_COST_WEI, PRE_BOUNDARY_OFFENSE_GAS, boundaryTs);
        console.log(`   #${String(t).padEnd(6)} | ${r === null ? "WOULD SUCCEED" : `WOULD REVERT: ${explain(r)}`}`);
      }
    }
  }

  console.log("");
  console.log(payFail === 0
    ? `Payment path: healthy — ${owned.length - paySkip} simulated clean, ${paySkip} already current.`
    : `Payment path: ${payFail} citizen(s) WOULD REVERT — investigate before the boundary.`);
  console.log("Simulated at the boundary instant, against your real balance. Nothing was sent.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
