import { spawn } from "node:child_process";
import path from "node:path";
import { appConfig } from "./config.js";
import { runtime } from "./runtime.js";
import { logger } from "./logger.js";
import type { TargetScoreRow, TargetScoresState } from "@dat-bot/shared";

/**
 * On-demand rival scoring for the dashboard, driven by scripts/target-scores.mjs.
 *
 * The scoring logic (owner balances, runway, skip cadence, defense strength, payment
 * timing, the weak-link score) lives in that script and is deliberately NOT duplicated
 * here — the dashboard and the CLI must never disagree about who the best target is.
 * We shell out with --json and cache the parsed result.
 *
 * The scan is slow (binary-searching epoch boundaries + hundreds of batched reads, ~1-3
 * min) and read-only, so it runs in the background on request and the UI polls this
 * state rather than blocking an HTTP request for minutes.
 */


let running = false;
let computedAtEpoch: number | null = null;
let computedAt: number | null = null;
let hoursToNextBoundary: number | null = null;
let epochTaxEth: number | null = null;
let rows: TargetScoreRow[] | null = null;
let error: string | null = null;

/** Scripts live next to data/ at the repo root, wherever DATA_DIR points. */
function scriptPath(): string {
  return path.resolve(appConfig.dataDir, "..", "scripts", "target-scores.mjs");
}

export function getTargetScores(): TargetScoresState {
  const cur = runtime.currentEpoch === null ? null : Number(runtime.currentEpoch);
  return {
    running,
    computedAtEpoch,
    computedAt,
    hoursToNextBoundary,
    epochTaxEth,
    rows,
    error,
    // Stale once a new epoch has begun since the scan: every rival's "behind" count
    // shifted, so the ranking is describing the previous epoch.
    stale: computedAtEpoch !== null && cur !== null && cur > computedAtEpoch,
  };
}

/** Kick off a scan unless one is already in flight. Returns the current state. */
export function startTargetScores(): TargetScoresState {
  if (running) return getTargetScores();
  running = true;
  error = null;

  const script = scriptPath();
  logger.info(`target-scores: scanning (${script})`);
  // Inherit env so the script resolves the same RPC/NFT credentials the app uses.
  const child = spawn(process.execPath, [script, "--json"], {
    cwd: path.resolve(appConfig.dataDir, ".."),
    env: process.env,
  });

  let out = "";
  let errOut = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  // The script logs progress to stderr; keep only the tail for diagnostics.
  child.stderr.on("data", (d) => { errOut = (errOut + d.toString()).slice(-2000); });

  child.on("error", (e) => {
    running = false;
    error = `Could not start scan: ${e.message}`;
    logger.warn(`target-scores: ${error}`);
  });

  child.on("close", (code) => {
    running = false;
    if (code !== 0) {
      error = `Scan failed (exit ${code}): ${errOut.trim().split("\n").slice(-2).join(" ") || "no output"}`;
      logger.warn(`target-scores: ${error}`);
      return;
    }
    try {
      const parsed = JSON.parse(out);
      rows = parsed.rows as TargetScoreRow[];
      computedAtEpoch = parsed.epoch as number;
      hoursToNextBoundary = parsed.hoursToNextBoundary as number;
      epochTaxEth = parsed.epochTaxEth as number;
      computedAt = Date.now();
      error = null;
      logger.info(`target-scores: scored ${rows?.length ?? 0} rivals at epoch ${computedAtEpoch}`);
    } catch (e) {
      error = `Could not parse scan output: ${(e as Error).message}`;
      logger.warn(`target-scores: ${error}`);
    }
  });

  return getTargetScores();
}
