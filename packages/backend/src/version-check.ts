/**
 * Tell a running bot when it is behind the released version.
 *
 * scripts/update.mjs already checks at launch, but that leaves two gaps a long-running
 * bot falls straight into: it only runs at startup, so a bot left up for a week never
 * learns anything; and it refuses outright on a git checkout, where the remedy is `git
 * pull` rather than a self-install. Either way the operator is looking at a dashboard
 * that cannot tell them they are stale — which is how a fixed bug keeps costing epochs.
 *
 * Deliberately advisory only. It reports; it never installs, and it never blocks
 * startup or a boundary. Every failure path leaves the bot exactly as it was.
 */
import { VERSION } from "@dat-bot/shared";
import { logger } from "./logger.js";
import { activity } from "./activity.js";
import { isGitCheckout } from "./list-sync.js";

/** Same source of truth the updater reads: the VERSION constant on master. */
const RAW_CONSTANTS =
  "https://raw.githubusercontent.com/otoalchemist/DT/master/packages/shared/src/constants.ts";

/** Bounded so a slow network can never delay the engine. */
const FETCH_TIMEOUT_MS = 8_000;

/** Re-check cadence. Releases are occasional; this is not a polling loop worth tuning. */
const RECHECK_MS = 6 * 60 * 60 * 1000; // 6h

export interface VersionState {
  /** Released version on master, or null if it has never been read successfully. */
  latest: string | null;
  /** True only when `latest` is strictly newer than what we are running. */
  behind: boolean;
  /** Unix ms of the last SUCCESSFUL check; null if we have never had one. */
  checkedAt: number | null;
}

let state: VersionState = { latest: null, behind: false, checkedAt: null };
let timer: ReturnType<typeof setInterval> | null = null;
/** So the activity log gets one line per new release, not one every 6 hours. */
let announced: string | null = null;

export function versionState(): VersionState {
  return state;
}

/** VERSION from a constants.ts source string. Mirrors scripts/update.mjs. */
export function parseVersion(src: string): string | null {
  const m = src.match(/export const VERSION\s*=\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

/**
 * Numeric semver compare; >0 when `a` is newer. Non-numeric suffixes ("1.0.0-rc1")
 * compare on their numeric prefix, which is enough to order releases — equal-prefix
 * pre-releases are treated as equal rather than guessed at.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.split(/[.\-+]/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** One check. Never throws — a failed check must look like "no information", not an error. */
export async function checkLatestVersion(): Promise<VersionState> {
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    // Cache-bust: raw.githubusercontent serves up to ~5 minutes stale, which would
    // otherwise make a fresh release look absent for the first check after it lands.
    const res = await fetch(`${RAW_CONSTANTS}?cb=${Date.now()}`, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = parseVersion(await res.text());
    if (!latest) throw new Error("no VERSION in upstream constants.ts");

    const behind = compareVersions(latest, VERSION) > 0;
    state = { latest, behind, checkedAt: Date.now() };

    if (behind && announced !== latest) {
      announced = latest;
      // One activity line per release, because the dashboard badge is easy to miss and
      // this is the log an operator actually reads back through.
      activity.add({
        kind: "info",
        status: "info",
        message:
          `Update available: v${latest} (running v${VERSION}). ` +
          (isGitCheckout()
            ? "This is a git checkout — run `git pull` to update."
            : "Restart the bot to install it automatically."),
      });
      logger.warn(`update available: v${latest} (running v${VERSION})`);
    }
  } catch (err) {
    // Advisory only: keep whatever we last knew rather than clearing it, so one flaky
    // fetch does not make a known-stale bot look current.
    logger.debug(`version check skipped: ${(err as Error).message}`);
  } finally {
    clearTimeout(t);
  }
  return state;
}

/** Check now, then every RECHECK_MS. Safe to call twice — the timer is replaced. */
export function startVersionChecks(): void {
  stopVersionChecks();
  void checkLatestVersion();
  timer = setInterval(() => void checkLatestVersion(), RECHECK_MS);
  // Never hold the process open for a check that is only ever advisory.
  timer.unref?.();
}

export function stopVersionChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: reset module state between cases. */
export function resetVersionState(): void {
  state = { latest: null, behind: false, checkedAt: null };
  announced = null;
}
