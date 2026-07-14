// Race post-mortem: compare one or more of OUR transactions against rival
// transactions for the same epoch and explain, per pair, whether we lost on
// TIMING (landed in a later block) or on FEE (same block, out-priced).
//
// Reusable core: runPostMortem() returns structured PostMortemResult (used by
// the API + UI). The CLI wrapper below prints it as a table.
//
// Usage (run with tsx from packages/backend):
//   tsx src/postmortem.ts <ours> [<rival> ...]
//   tsx src/postmortem.ts --ours 0xabc... --rivals 0x111...,0x222...
//
// Requires an RPC endpoint (ALCHEMY_API_KEY or RPC_HTTP_URL), same as the bot.
import { formatGwei, decodeFunctionData, type Hex } from "viem";
import {
  deathAndTaxesAbi,
  type PostMortemTx,
  type PostMortemVerdict,
  type PostMortemResult,
} from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";

/** Decode the contract call into a human label; falls back to the raw selector. */
function describe(input: Hex): { action: string; args: string } {
  try {
    const { functionName, args } = decodeFunctionData({ abi: deathAndTaxesAbi, data: input });
    const argStr = (args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
    return { action: functionName, args: argStr };
  } catch {
    return { action: `unknown(${input.slice(0, 10)})`, args: "" };
  }
}

async function loadTx(hash: Hex, role: "ours" | "rival"): Promise<PostMortemTx> {
  const base: PostMortemTx = {
    hash, role, found: false, action: "-", args: "", from: "0x",
    blockNumber: null, txIndex: null, blockTs: null,
    baseFeeGwei: null, tipGwei: null, effectiveGwei: null, toGame: false,
  };
  const tx = await publicClient.getTransaction({ hash }).catch(() => null);
  if (!tx) return base;

  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  const block = tx.blockNumber !== null
    ? await publicClient.getBlock({ blockNumber: tx.blockNumber }).catch(() => null)
    : null;

  const baseFee = block?.baseFeePerGas ?? null;
  const effective = receipt?.effectiveGasPrice ?? tx.gasPrice ?? null;
  // Effective tip = effectiveGasPrice - baseFee, capped by maxPriorityFeePerGas.
  const tip = effective !== null && baseFee !== null ? effective - baseFee : (tx.maxPriorityFeePerGas ?? null);

  const { action, args } = describe(tx.input as Hex);
  return {
    ...base,
    found: true,
    action,
    args,
    from: tx.from,
    blockNumber: tx.blockNumber !== null ? tx.blockNumber.toString() : null,
    txIndex: tx.transactionIndex ?? null,
    blockTs: block ? Number(block.timestamp) : null,
    baseFeeGwei: baseFee !== null ? Number(formatGwei(baseFee)) : null,
    tipGwei: tip !== null ? Number(formatGwei(tip < 0n ? 0n : tip)) : null,
    effectiveGwei: effective !== null ? Number(formatGwei(effective)) : null,
    toGame: (tx.to ?? "").toLowerCase() === appConfig.gameAddress.toLowerCase(),
  };
}

function fmt(n: number | null, d = 2): string {
  return n === null ? "—" : n.toFixed(d);
}

/** Row-orders like the chain: earlier block wins; within a block, lower index wins. */
function seq(r: PostMortemTx): [number, number] {
  return [r.blockNumber === null ? Infinity : Number(r.blockNumber), r.txIndex ?? Infinity];
}

function judge(ours: PostMortemTx, rival: PostMortemTx): { outcome: PostMortemVerdict["outcome"]; detail: string } {
  if (!ours.found || !rival.found) {
    return { outcome: "unknown", detail: "cannot compare (tx not found / still pending)" };
  }
  const [ob, oi] = seq(ours);
  const [rb, ri] = seq(rival);

  if (ob < rb || (ob === rb && oi < ri)) {
    const margin = ob === rb ? `same block, ${ri - oi} slots ahead` : `${rb - ob} block(s) earlier`;
    return { outcome: "won", detail: `WE WON (${margin})` };
  }

  // We lost — classify why.
  if (ob > rb) {
    const blocks = ob - rb;
    const secs = ours.blockTs !== null && rival.blockTs !== null ? ours.blockTs - rival.blockTs : blocks * 12;
    const feeNote = rival.tipGwei !== null && ours.tipGwei !== null && ours.tipGwei >= rival.tipGwei
      ? " — our tip already ≥ theirs, so MORE GWEI WOULD NOT HELP; this is pure latency (we submitted too late for their block)"
      : ` — their tip was ${fmt(rival.tipGwei)} gwei vs our ${fmt(ours.tipGwei)}; higher tip *might* have helped only if we reached their block`;
    return { outcome: "lost-timing", detail: `WE LOST on TIMING: ${blocks} block(s) / ~${secs}s late${feeNote}` };
  }
  // Same block, they had a lower index than us → fee/ordering loss.
  return {
    outcome: "lost-fee",
    detail: `WE LOST on FEE/ORDERING (same block, they sat ${oi - ri} slots higher): their tip ${fmt(rival.tipGwei)} gwei vs our ${fmt(ours.tipGwei)} gwei`,
  };
}

/**
 * Resolve all supplied hashes on-chain and produce verdicts. `ours[0..]` are our
 * txs; `rivals` are compared against each of ours. Pure data — no console output.
 */
export async function runPostMortem(ours: Hex[], rivals: Hex[]): Promise<PostMortemResult> {
  const ourRows = await Promise.all(ours.map((h) => loadTx(h, "ours")));
  const rivalRows = await Promise.all(rivals.map((h) => loadTx(h, "rival")));

  const verdicts: PostMortemVerdict[] = [];
  for (const o of ourRows) {
    for (const r of rivalRows) {
      const { outcome, detail } = judge(o, r);
      verdicts.push({
        ourHash: o.hash,
        rivalHash: r.hash,
        ourLabel: `${o.action}(${o.args})`,
        rivalLabel: `${r.action}(${r.args})`,
        sameAction: o.action === r.action,
        outcome,
        detail,
      });
    }
  }

  let summary = "";
  const ourBlocks = ourRows.filter((r) => r.found && r.blockNumber !== null).map((r) => Number(r.blockNumber));
  const rivalBlocks = rivalRows.filter((r) => r.found && r.blockNumber !== null).map((r) => Number(r.blockNumber));
  if (ourBlocks.length && rivalBlocks.length) {
    const lateBy = Math.min(...ourBlocks) - Math.min(...rivalBlocks);
    if (lateBy > 0) summary = `Our earliest tx landed ${lateBy} block(s) after the rivals' earliest — a timing gap, not a fee gap.`;
    else if (lateBy < 0) summary = `Our earliest tx beat the rivals' earliest by ${-lateBy} block(s).`;
    else summary = "We shared the earliest block with a rival — ordering (tip) was the deciding factor.";
  } else if (rivalRows.length === 0) {
    summary = "No rival transactions supplied — pass rival hashes to get win/loss verdicts.";
  }

  return {
    txs: [...ourRows, ...rivalRows],
    verdicts,
    summary,
    gameAddress: appConfig.gameAddress,
    mode: appConfig.mode,
  };
}

// --- CLI wrapper ---

function parseArgs(argv: string[]): { ours: Hex[]; rivals: Hex[] } {
  const ours: Hex[] = [];
  const rivals: Hex[] = [];
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean) as Hex[];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--ours") ours.push(...split(argv[++i] ?? ""));
    else if (a === "--rivals") rivals.push(...split(argv[++i] ?? ""));
    else if (a.startsWith("0x")) {
      // First bare hash is ours; the rest are rivals.
      if (ours.length === 0) ours.push(a as Hex);
      else rivals.push(a as Hex);
    }
  }
  return { ours, rivals };
}

function printResult(result: PostMortemResult): void {
  console.log(`\n=== RACE POST-MORTEM (${result.mode} / ${result.gameAddress}) ===\n`);
  const header = ["role", "action(args)", "block", "idx", "tip gwei", "eff gwei", "base gwei", "hash"];
  console.log(header.join(" | "));
  console.log("-".repeat(header.join(" | ").length + 40));
  for (const r of result.txs) {
    const label = r.found ? `${r.action}(${r.args})` : "NOT FOUND / pending";
    console.log([
      r.role, label, r.blockNumber ?? "—", r.txIndex ?? "—",
      fmt(r.tipGwei), fmt(r.effectiveGwei), fmt(r.baseFeeGwei, 3), r.hash.slice(0, 12) + "…",
    ].join(" | "));
    if (r.found && !r.toGame) {
      console.log(`   ⚠ this tx's target is not the game contract (${result.gameAddress}) — not a game action`);
    }
  }

  if (result.verdicts.length > 0) {
    console.log("\n=== VERDICTS (each of our txs vs each rival) ===");
    for (const v of result.verdicts) {
      const tag = v.sameAction ? "[same action]" : "[different action — timing pattern only]";
      console.log(`\n• ${v.ourLabel}  vs  ${v.rivalLabel}  ${tag}`);
      console.log(`  ${v.detail}`);
    }
  }
  if (result.summary) console.log(`\n=== SUMMARY ===\n${result.summary}`);
}

// Only run the CLI when invoked directly (not when imported by the API).
// Matches both the tsx dev path (postmortem.ts) and a compiled run (postmortem.js);
// when imported by main/api the entrypoint is a different file, so this stays false.
const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
const invokedDirectly = /\/postmortem\.(ts|js)$/.test(entry);
if (invokedDirectly) {
  const { ours, rivals } = parseArgs(process.argv.slice(2));
  if (!appConfig.httpUrl) {
    console.error("No RPC configured. Set ALCHEMY_API_KEY or RPC_HTTP_URL in the environment.");
    process.exit(1);
  }
  if (ours.length === 0) {
    console.error("Usage: tsx src/postmortem.ts <ourTx> [rivalTx ...]");
    console.error("   or: tsx src/postmortem.ts --ours 0x.. --rivals 0x..,0x..");
    process.exit(1);
  }
  runPostMortem(ours, rivals)
    .then(printResult)
    .catch((err) => {
      console.error("post-mortem failed:", (err as Error).message);
      process.exit(1);
    });
}
