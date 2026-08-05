import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { activity } from "./activity.js";

/**
 * Startup auto-update for the curated default lists.
 *
 * The four list files (rival-targets, rival-skippers, ally-tokens, do-not-target) ship
 * in git and are the bot's shared game intelligence — they change as the game is played,
 * far more often than the code does. But a user's `data/` folder survives every update
 * (it holds the keystore and the API key), so a new list only reached them by
 * re-downloading the whole bot and hand-merging. `DEFAULTS_VERSION` doesn't close the gap
 * either: it re-pushes `offenseTargetTokenIds` from rival-skippers.json, so it can only
 * propagate a list the local file already contains.
 *
 * So at startup we fetch each list from the repo's master branch and refresh the local
 * copy. Best-effort and fully non-blocking: any failure leaves the shipped file in place,
 * because a stale ally list is survivable and a missing one is not.
 *
 * Three properties this has to get right, all of which are about NOT destroying data:
 *
 *  1. **A git checkout is never touched.** In a clone the lists are curated through git,
 *    and an uncommitted edit is real work. `.git` present => skip entirely.
 *  2. **A hand-edited file is never overwritten.** We record the hash of what we wrote in
 *    `data/.list-sync.json`; if the file on disk no longer matches, the user edited it and
 *    it becomes theirs. Their curation outranks ours.
 *  3. **An empty list is never adopted.** A truncated response that parsed as `[]` would
 *    disarm the ally block (the bot would audit teammates) and empty the do-not-target
 *    roster (wasted audit slots). Upstream can change a list; it cannot clear one.
 */

/** Raw master-branch base. Cache-busted per request — raw.githubusercontent caches ~5m. */
const RAW_BASE = "https://raw.githubusercontent.com/otoalchemist/DT/master/data";

/** Whole sync is bounded: startup must not hang on a slow network. */
const FETCH_TIMEOUT_MS = 8_000;

/** Manifest of hashes we last wrote, so a local edit is detectable. Lives in data/. */
const MANIFEST_FILE = ".list-sync.json";

/**
 * The lists we sync, and how to validate a fetched payload.
 *
 * `validate` is what stands between a malformed/partial response and the offense engine.
 * It must reject anything that isn't a well-formed, NON-EMPTY list of decimal token ids —
 * see property 3 above.
 */
interface SyncedList {
  file: string;
  label: string;
  validate: (parsed: unknown) => boolean;
}

/** A non-empty array of decimal-digit token ids (the shape of the three flat lists). */
function isIdArray(parsed: unknown): boolean {
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((x) => typeof x === "string" && /^\d+$/.test(x))
  );
}

/** `{ owners: { <operator>: [ids] } }` with at least one id — the do-not-target shape. */
function isOwnerMap(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const owners = (parsed as { owners?: unknown }).owners;
  if (!owners || typeof owners !== "object" || Array.isArray(owners)) return false;
  const groups = Object.values(owners as Record<string, unknown>);
  if (groups.length === 0) return false;
  if (!groups.every((ids) => Array.isArray(ids) && ids.every((x) => typeof x === "string" && /^\d+$/.test(x)))) {
    return false;
  }
  return groups.some((ids) => (ids as string[]).length > 0);
}

const SYNCED_LISTS: SyncedList[] = [
  { file: "rival-targets.json", label: "rival targets", validate: isIdArray },
  { file: "rival-skippers.json", label: "rival skippers", validate: isIdArray },
  { file: "ally-tokens.json", label: "ally tokens", validate: isIdArray },
  { file: "do-not-target.json", label: "do-not-target roster", validate: isOwnerMap },
];

type Manifest = Record<string, string>;

function manifestPath(): string {
  return path.join(appConfig.dataDir, MANIFEST_FILE);
}

function readManifest(): Manifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Manifest;
  } catch {
    /* absent or unreadable -> no record of us having written anything */
  }
  return {};
}

function writeManifest(m: Manifest): void {
  try {
    fs.mkdirSync(appConfig.dataDir, { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2) + "\n");
  } catch (err) {
    // Non-fatal, but it costs us edit detection next start, so say so.
    logger.warn("Could not write list-sync manifest:", (err as Error).message);
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** True when the bot is running from a git checkout rather than an extracted archive. */
export function isGitCheckout(): boolean {
  // data/ is a sibling of .git in the repo layout, so check the parent of dataDir.
  return fs.existsSync(path.join(path.dirname(appConfig.dataDir), ".git"));
}

/**
 * Why a single list was or wasn't updated. Returned so the caller can log one honest
 * summary instead of the sync being invisible.
 */
type ListOutcome =
  | { file: string; result: "updated"; ids: number }
  | { file: string; result: "unchanged" }
  | { file: string; result: "local-edit" }
  | { file: string; result: "failed"; reason: string };

async function fetchList(file: string, signal: AbortSignal): Promise<string> {
  // `?ts=` defeats the raw.githubusercontent CDN cache, which otherwise serves a list
  // up to ~5 minutes stale — long enough to miss an update pushed just before a restart.
  const res = await fetch(`${RAW_BASE}/${file}?ts=${Date.now()}`, {
    signal,
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** Count of ids in a validated payload, for the log line. */
function countIds(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  const owners = (parsed as { owners?: Record<string, string[]> }).owners ?? {};
  return new Set(Object.values(owners).flat()).size;
}

async function syncOne(spec: SyncedList, manifest: Manifest, signal: AbortSignal): Promise<ListOutcome> {
  const localPath = path.join(appConfig.dataDir, spec.file);
  let localText: string | null = null;
  try {
    localText = fs.readFileSync(localPath, "utf8");
  } catch {
    // Missing entirely (a data/ folder carried over from before the list existed) — then
    // there is no user curation to protect and fetching it is pure gain.
  }

  // Property 2: only a file we wrote ourselves, still byte-identical, is ours to replace.
  // A file we've never synced is the SHIPPED copy, which we may replace — the manifest is
  // absent on a fresh extract, and refusing there would defeat the whole feature.
  if (localText !== null && manifest[spec.file] && manifest[spec.file] !== hash(localText)) {
    return { file: spec.file, result: "local-edit" };
  }

  const text = await fetchList(spec.file, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("remote payload is not valid JSON");
  }
  // Property 3: an empty or malformed list is rejected, never adopted.
  if (!spec.validate(parsed)) throw new Error("remote payload failed validation (empty or malformed)");

  // Written VERBATIM, not re-serialized: raw.githubusercontent serves the exact committed
  // bytes, so the local file stays byte-identical to master. Re-serializing would reflow
  // the hand-maintained formatting (and the `_comment` block in do-not-target.json),
  // which then reads as a change on every first sync even when nothing moved.
  if (localText === text) {
    manifest[spec.file] = hash(text); // adopt it so later edits are detectable
    return { file: spec.file, result: "unchanged" };
  }

  fs.mkdirSync(appConfig.dataDir, { recursive: true });
  fs.writeFileSync(localPath, text);
  manifest[spec.file] = hash(text);
  return { file: spec.file, result: "updated", ids: countIds(parsed) };
}

/**
 * Refresh every synced list from master. Never throws and never blocks startup on a
 * failure — the shipped/local copy is always a usable fallback.
 *
 * Returns the per-list outcomes (for tests and the manual-refresh endpoint).
 */
export async function syncDefaultLists(): Promise<ListOutcome[]> {
  const mode = process.env.LIST_AUTO_UPDATE ?? "on";
  if (mode === "off") {
    logger.info("Default-list auto-update disabled (LIST_AUTO_UPDATE=off).");
    return [];
  }
  // Property 1: in a clone the lists are git-managed. `force` opts in for testing the
  // sync itself against a checkout.
  if (isGitCheckout() && mode !== "force") {
    logger.debug("Default-list auto-update skipped: running from a git checkout (use git pull).");
    return [];
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  const manifest = readManifest();
  try {
    const outcomes = await Promise.all(
      SYNCED_LISTS.map(async (spec): Promise<ListOutcome> => {
        try {
          return await syncOne(spec, manifest, abort.signal);
        } catch (err) {
          const reason = abort.signal.aborted ? `timed out after ${FETCH_TIMEOUT_MS}ms` : (err as Error).message;
          return { file: spec.file, result: "failed", reason };
        }
      }),
    );
    writeManifest(manifest);
    report(outcomes);
    return outcomes;
  } finally {
    clearTimeout(timer);
  }
}

/** One honest summary line. An update is surfaced to the activity feed too, since it
 *  changes who the bot will attack — that should never be a silent change. */
function report(outcomes: ListOutcome[]): void {
  const updated = outcomes.filter((o) => o.result === "updated") as Extract<ListOutcome, { result: "updated" }>[];
  const failed = outcomes.filter((o) => o.result === "failed") as Extract<ListOutcome, { result: "failed" }>[];
  const edited = outcomes.filter((o) => o.result === "local-edit");

  if (updated.length > 0) {
    const detail = updated.map((o) => `${o.file} (${o.ids} ids)`).join(", ");
    const msg = `Default lists updated from master: ${detail}.`;
    logger.info(msg);
    activity.add({ kind: "info", status: "info", message: msg });
  } else if (failed.length === 0 && edited.length === 0) {
    logger.info("Default lists are already up to date.");
  }

  if (edited.length > 0) {
    logger.info(
      `Default lists kept as-is (edited locally): ${edited.map((o) => o.file).join(", ")}. ` +
        `Delete the file and restart to take the master copy again.`,
    );
  }
  for (const f of failed) {
    // A failure is expected offline and must not read as an error — the local list works.
    logger.warn(`Could not update ${f.file} from master (${f.reason}); keeping the local copy.`);
  }
}
