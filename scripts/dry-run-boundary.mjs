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
// The rest of this script speaks raw JSON-RPC with no dependencies, deliberately. viem is
// imported for ONE job: ABI-encoding CitizenVault.run(Call[], uint256). Hand-rolling a dynamic
// struct array is exactly where a subtle offset bug produces a plausible-looking FALSE PASS,
// which is the one outcome a dry-run tool must never produce.
import { encodeFunctionData } from "viem";

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
// CitizenVault.operator() — who will sign run() for a vault-held citizen.
const SEL_OPERATOR = "0x570ca735";
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
 * Mirrors simulateAtTimestamp: state overrides are empty, so the signer's REAL balance
 * applies and an underfunded wallet shows up as a failure rather than a false pass.
 *
 * `to` is a parameter rather than always GAME because a vault-held citizen is not reached by
 * calling the game directly — see routeAction.
 */
async function simulateAt(from, to, data, valueWei, gas, atTime, stateOverride = {}) {
  try {
    await rpc("eth_call", [
      { from, to, data, value: hex(valueWei), gas: hex(gas) },
      "latest",
      stateOverride,
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
    return { selector: sel, data: typeof e.data === "string" ? e.data : null, message: err.message };
  }
}

/** Mirrors VAULT_CALL_OVERHEAD_GAS / VAULT_PER_CALL_GAS in strategy.ts. */
const VAULT_OVERHEAD_GAS = 60_000n;
const VAULT_PER_CALL_GAS = 145_000n;

/**
 * Where a single action should actually be sent from and to.
 *
 * A vault-held citizen is the whole reason this exists. Simulating `payTaxes` FROM the vault
 * reproduces nothing the bot will ever send, and it fails for the wrong reason: the vault holds
 * no ETH by design — every boundary is funded from the operator's `msg.value` — so a direct
 * call from it reverts OutOfFunds and reads as a broken payment path on a perfectly healthy
 * setup. That false alarm is what prompted this.
 *
 * What the bot really sends is ONE `vault.run([call], bidWei)` signed by the operator, with the
 * value attached to that outer call. Simulating exactly that also covers the vault's own guards
 * (authorisation, the selector allowlist, `msg.value == sum + bid`), none of which a direct
 * game call would touch.
 *
 * `tolerate: false` here on purpose: a tolerated call that reverts INSIDE the batch still lets
 * `run` succeed, so the simulation would report success for an action that did nothing. Marking
 * it intolerant makes an internal revert surface as an outer revert, which is what we want to
 * see.
 */
function routeAction(holder, gameData, valueWei, gas, vault, operator) {
  const viaVault = vault && holder && holder.toLowerCase() === vault.toLowerCase();
  if (!viaVault) return { from: holder, to: GAME, data: gameData, value: valueWei, gas };
  return {
    from: operator,
    to: vault,
    data: encodeFunctionData({
      abi: [{
        type: "function", name: "run", stateMutability: "payable", outputs: [],
        inputs: [
          { name: "calls", type: "tuple[]", components: [
            { name: "data", type: "bytes" }, { name: "value", type: "uint256" }, { name: "tolerate", type: "bool" },
          ] },
          { name: "bidWei", type: "uint256" },
        ],
      }],
      functionName: "run",
      args: [[{ data: gameData, value: valueWei, tolerate: false }], 0n],
    }),
    value: valueWei,
    gas: VAULT_OVERHEAD_GAS + VAULT_PER_CALL_GAS,
    viaVault: true,
  };
}

const REVERTS = {
  "0x72030254": "NotDelinquent — the target is not (or no longer) auditable",
  "0x7e273289": "ERC721NonexistentToken — that token is burned",
  "0x042ee60a": "already under audit",
  "0xe72c6951": "not auditable yet at this timestamp",
  // CitizenVault's own errors. Worth naming because they mean something quite different from a
  // game revert: the batch never reached the game at all.
  "0xc589ca3c": "SelectorNotAllowed — the vault refused this call (not one of its four selectors)",
  "0x626ade30": "ValueMismatch — msg.value did not equal the calls plus the bid",
  "0x1648fd01": "NotAuthorised — the signer is neither the vault's owner nor its operator",
  "0xf0c49d44": "RefundFailed — the vault could not return a tolerated call's value",
};
/** The vault's "an inner call reverted" error, which HIDES the game's own reason. */
const SEL_CALL_FAILED = "0x3f9a3b48";

const explain = (r) =>
  r.unsupported ? `RPC does not support block overrides (${r.message.slice(0, 60)})`
  : r.inner ? `${explain(r.inner)}  (inside vault.run)`
  : r.selector === SEL_CALL_FAILED ? "CallFailed inside vault.run — inner reason unavailable"
  : `${r.selector ?? "revert"}${REVERTS[r.selector] ? ` — ${REVERTS[r.selector]}` : ""}`;

/**
 * Recover the real reason behind the vault's CallFailed.
 *
 * `tolerate: false` makes an inner revert bubble up as CitizenVault's own `CallFailed(index)`,
 * which is useless diagnostically — "the audit failed" without saying whether the target cured,
 * is burned, or was already under audit. Routing through the vault therefore made this tool
 * WORSE at explaining failures than it was before, which is not a trade worth making.
 *
 * So on CallFailed, re-simulate the bare game call directly from the vault, with a balance
 * override so it does not just fail OutOfFunds. The override is diagnosis-only and never used
 * for the verdict itself — the verdict already came from the accurate vault-routed run above.
 */
async function innerReason(vault, gameData, valueWei, gas, atTime) {
  const funded = { [vault]: { balance: hex(10n ** 18n) } };
  return simulateAt(vault, GAME, gameData, valueWei, gas, atTime, funded);
}

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

  /**
   * The vault is a HOLDER, not a wallet, so keystore enumeration alone misses everything inside
   * it. Once a citizen is migrated the tool reported "No citizens found to simulate" — which
   * reads as "nothing to do" on the very night you most want a dry run.
   *
   * `operator` is read off the vault rather than assumed to be the first keystore entry: it is
   * the address that will actually sign `run`, and if it is not one of ours the simulation would
   * be signed by an account that cannot authorise the call.
   */
  let vault = null, operator = null;
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).vaultAddress ?? "").trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
      const code = await rpc("eth_getCode", [v, "latest"]);
      if (code && code !== "0x") {
        vault = v.toLowerCase();
        operator = "0x" + (await rpc("eth_call", [{ to: v, data: SEL_OPERATOR }, "latest"])).slice(26);
        const known = wallets.includes(operator.toLowerCase());
        console.log(`vault      ${vault}  operator ${operator}${known ? "" : "  (NOT in this keystore — the bot could not sign)"}`);
      } else {
        console.log(`vault      ${v} has no code — ignoring it`);
      }
    }
  } catch { /* no config, or unreadable — carry on walletless */ }

  const holders = vault ? [...wallets, vault] : wallets;
  if (holders.length === 0) {
    console.error("\nNo wallet address found in data/. Pass --tokens and it will use the on-chain owner.");
  }

  // --- which citizens ---
  let owned = [];
  if (tokensArg) {
    owned = tokensArg.split(",").map((s) => BigInt(s.trim())).filter((x) => x > 0n);
  } else {
    for (const a of holders) {
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
    const route = routeAction(from, SEL_PAY_TAXES + w(id) + w(1), value, GAS_PER_PAYMENT, vault, operator);
    if (route.viaVault && !operator) {
      console.log(`  #${String(id).padEnd(5)} | ${String(targetEpoch - lep).padEnd(13)} | ${eth(value)} ETH    | skipped: vault operator unreadable`);
      continue;
    }
    const r = await simulateAt(route.from, route.to, route.data, route.value, route.gas, boundaryTs);
    // Unmask the vault: CallFailed alone would not say WHY the payment failed.
    if (r && r.selector === SEL_CALL_FAILED && route.viaVault) {
      r.inner = await innerReason(vault, SEL_PAY_TAXES + w(id) + w(1), value, GAS_PER_PAYMENT, boundaryTs);
    }
    const verdict = r === null ? "WOULD SUCCEED" : `WOULD REVERT: ${explain(r)}`;
    if (r !== null) payFail++;
    console.log(`  #${String(id).padEnd(5)} | ${String(targetEpoch - lep).padEnd(13)} | ${eth(value)} ETH    | ${verdict}${route.viaVault ? "  [via vault.run]" : ""}`);
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
      const aRoute = routeAction(from, "0x", 0n, 0n, vault, operator);
      console.log(`  auditing from #${auditor}${aRoute.viaVault ? " (held in the vault, so via vault.run)" : ""}` +
        `${aDue && aDue !== 0n ? "  (NOTE: itself under audit — the bot would skip it)" : ""}`);
      console.log("  target | result");
      for (const t of pinned) {
        const lep = await tryCall(SEL_LAST_EPOCH_PAID + w(t));
        if (lep === null) { console.log(`   #${String(t).padEnd(6)} | unreadable (burned/killed)`); continue; }
        const auditableAtTarget = lep + 2n <= targetEpoch;
        if (!auditableAtTarget) {
          console.log(`   #${String(t).padEnd(6)} | skipped: lastEpochPaid ${lep}, needs <= ${targetEpoch - 2n} at epoch ${targetEpoch}`);
          continue;
        }
        const route = routeAction(from, SEL_AUDIT + w(auditor) + w(t), AUDIT_COST_WEI, PRE_BOUNDARY_OFFENSE_GAS, vault, operator);
        if (route.viaVault && !operator) { console.log(`   #${String(t).padEnd(6)} | skipped: vault operator unreadable`); continue; }
        const r = await simulateAt(route.from, route.to, route.data, route.value, route.gas, boundaryTs);
        if (r && r.selector === SEL_CALL_FAILED && route.viaVault) {
          r.inner = await innerReason(vault, SEL_AUDIT + w(auditor) + w(t), AUDIT_COST_WEI, PRE_BOUNDARY_OFFENSE_GAS, boundaryTs);
        }
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
