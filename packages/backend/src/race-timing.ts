import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { publicClient } from "./chain.js";

/**
 * Race telemetry: how EARLY we submitted, against what position we got.
 *
 * Everything else about boundary position is measurable from public chain data — tips,
 * bids, gas, the resulting tx index. Submission TIMING is the one input that is not: only
 * the sending bot knows when it pressed send. That gap matters because a 21-boundary study
 * of Titan/BuilderNet blocks found price barely explains position at all (density→index
 * correlation −0.22; bidding past ~0.02 ETH bought nothing measurable), which leaves
 * arrival time as the main untested candidate.
 *
 * So each bundle flush appends one row here, and the resulting index is filled in later
 * from the receipt. The join key is the predicted tx hash — keccak of the signed tx —
 * because it is known for bundle-only txs that were never broadcast.
 *
 * Append-only JSONL, not the activity log: this is an experiment feeding an analysis
 * script, and it must not compete with the log the user actually reads. Writes are async
 * and best-effort — telemetry must never delay a race or break a submission.
 */

const FILE = "race-timing.jsonl";

export interface RaceTimingRow {
  /** ms since epoch when the bundle was handed to the builders. */
  submittedAtMs: number;
  /** Block the bundle named as its target. */
  targetBlock: string;
  /** Timestamp of the block we were racing into, when known (the epoch boundary). */
  boundaryTs: number | null;
  /** submittedAtMs -> boundary, in ms. Negative means we submitted AFTER the boundary. */
  leadMs: number | null;
  /** Builders that accepted the bundle, and how many were tried. */
  acceptedBy: string[];
  builderCount: number;
  /** Bundle shape: tx count, total gas limit, tip in gwei, flat bid in wei. */
  txCount: number;
  gasLimitTotal: string;
  tipGwei: number;
  bidWei: string;
  /** Predicted hashes, in bundle order — the join key for the outcome below. */
  txHashes: string[];
  /** Filled in once a receipt lands: where we actually ended up. */
  landedBlock?: string;
  landedIndex?: number;
  /** landedBlock === targetBlock. False means we won the NEXT block, which is a loss. */
  hitTarget?: boolean;
  /** Builder that actually built the block we landed in. */
  landedBuilder?: string;
  status?: "included" | "reverted";
}

function filePath(): string {
  return path.join(appConfig.dataDir, FILE);
}

/** Append one row. Fire-and-forget: a telemetry failure must never affect a submission. */
export function recordRaceSubmission(row: RaceTimingRow): void {
  void (async () => {
    try {
      await fsp.mkdir(appConfig.dataDir, { recursive: true });
      await fsp.appendFile(filePath(), JSON.stringify(row) + "\n");
    } catch (err) {
      logger.debug(`race timing: could not append: ${(err as Error).message}`);
    }
  })();
}

/**
 * Fill in the outcome for a submission, matched by any of its predicted tx hashes.
 *
 * Rewrites the whole file, which is fine at this size (one row per boundary, so a few
 * hundred rows a year) and keeps the format a plain readable JSONL rather than needing a
 * separate index. Async and best-effort for the same reason as above.
 */
export function recordRaceOutcome(txHash: string, landed: {
  blockNumber: bigint;
  transactionIndex: number;
  status: "included" | "reverted";
}): void {
  void (async () => {
    try {
      const p = filePath();
      if (!fs.existsSync(p)) return;
      const lines = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean);
      let changed = false;
      const want = txHash.toLowerCase();
      const out = lines.map((line) => {
        let row: RaceTimingRow;
        try { row = JSON.parse(line) as RaceTimingRow; } catch { return line; }
        if (row.landedIndex !== undefined) return line;              // already resolved
        if (!row.txHashes?.some((h) => h.toLowerCase() === want)) return line;
        row.landedBlock = landed.blockNumber.toString();
        row.landedIndex = landed.transactionIndex;
        row.hitTarget = row.targetBlock === landed.blockNumber.toString();
        row.status = landed.status;
        changed = true;
        return JSON.stringify(row);
      });
      if (!changed) return;
      await fsp.writeFile(p, out.join("\n") + "\n");
      // The builder that actually won is only knowable after the fact; fetch it lazily so
      // the analysis can attribute position to a builder without a second pass.
      void annotateBuilder(landed.blockNumber);
    } catch (err) {
      logger.debug(`race timing: could not record outcome: ${(err as Error).message}`);
    }
  })();
}

/** Stamp the winning builder onto any resolved rows for `blockNumber` that lack it. */
async function annotateBuilder(blockNumber: bigint): Promise<void> {
  try {
    const blk = await publicClient.getBlock({ blockNumber });
    const tag = Buffer.from((blk.extraData ?? "0x").slice(2), "hex")
      .toString("utf8").replace(/[^\x20-\x7e]/g, "").trim() || "(unknown)";
    const p = filePath();
    if (!fs.existsSync(p)) return;
    const lines = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean);
    let changed = false;
    const out = lines.map((line) => {
      let row: RaceTimingRow;
      try { row = JSON.parse(line) as RaceTimingRow; } catch { return line; }
      if (row.landedBlock !== blockNumber.toString() || row.landedBuilder) return line;
      row.landedBuilder = tag;
      changed = true;
      return JSON.stringify(row);
    });
    if (changed) await fsp.writeFile(p, out.join("\n") + "\n");
  } catch {
    /* best effort — the analysis can look the builder up itself */
  }
}
