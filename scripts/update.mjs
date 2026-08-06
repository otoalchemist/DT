// Self-update the bot from the repo's master branch, before the app starts.
//
// Why this exists: the game moves faster than people re-download bots. Getting a fix
// meant fetching a new ZIP from GitHub, extracting it, and hand-copying `data/` and
// `.env` across — enough friction that an operator can sit on a stale build for weeks
// without noticing. data/list-sync.ts solved this for the curated LISTS; this solves it
// for the CODE.
//
// It runs from the launchers (start.bat / start.command) BEFORE `npm run dev`, which is
// the whole trick: a Node process cannot safely swap the code it is currently executing,
// so updating in-process would need a restart dance and would leave a half-new tree if it
// died midway. Running before boot means the app only ever starts on one coherent tree.
//
// Dependency-free on purpose: it runs BEFORE `npm install`, so it cannot import anything
// from node_modules. Archive extraction is therefore hand-rolled on node:zlib (tar.gz is
// a trivial format — 512-byte headers and stored bodies, no per-file compression to get
// wrong) rather than shelling out to tar, whose flags differ between GNU tar, macOS bsdtar
// and Windows' System32 copy.
//
// Usage:
//   node scripts/update.mjs            # check, and update if a newer version exists
//   node scripts/update.mjs --check    # report only, change nothing (exit 10 = available)
//   node scripts/update.mjs --force    # reinstall even if versions match
//   BOT_AUTO_UPDATE=off                # skip entirely
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REPO = "otoalchemist/DT";
const BRANCH = "master";
// raw.githubusercontent, NOT the REST API: api.github.com allows only 60 unauthenticated
// requests per hour per IP, which a few restarts behind one NAT can exhaust — and the
// updater must not be the reason the bot won't start. raw has no such limit, and it's
// already the host list-sync.ts uses.
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;

const FETCH_TIMEOUT_MS = 20_000;
const MANIFEST = path.join(root, "data", ".update-manifest.json");
const BACKUP_DIR = path.join(root, ".update-backup");

/**
 * Never replaced by an update — everything here is the user's, not ours.
 *
 * `data/` holds the encrypted keystore and API key, `.env` the RPC config: losing either
 * is unrecoverable for the user, which makes this list the most safety-critical thing in
 * the file. node_modules is preserved because reinstalling it on every update would turn
 * a 2-second refresh into a multi-minute one for no gain (we reinstall only when the
 * lockfile actually changes).
 */
const PRESERVE = [
  "data",           // keystore, API key, config.json, activity log, synced lists
  ".env",           // secrets
  "node_modules",
  "release",        // locally-built release zips
  ".git",           // belt-and-braces; a checkout is refused outright below
  ".update-backup",
  ".update-staged",
];

/**
 * The launchers, which need special handling when THEY are what invoked us.
 *
 * Both cmd.exe and bash read a script incrementally from disk as they execute it — they
 * track position by byte offset rather than buffering the whole file. Overwriting a
 * running launcher therefore doesn't just take effect next time; the shell continues
 * reading at its old offset into the NEW bytes and executes whatever now happens to live
 * there. Windows makes this worse in both directions: it permits the overwrite (no lock to
 * stop us) and it refuses rename-over-an-open-file with EPERM, so there's no atomic swap
 * to fall back on.
 *
 * So a launcher change is STAGED rather than applied, and picked up by `npm run update`,
 * which runs with no shell holding the file. Launcher edits are rare — they're ~40 lines
 * of glue whose real work is delegated to node scripts — so the one extra step almost
 * never comes up.
 */
const LAUNCHERS = ["start.bat", "start.command"];
const STAGED_DIR = path.join(root, ".update-staged");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const force = args.includes("--force");

function log(msg) { console.log(`[update] ${msg}`); }
function warn(msg) { console.warn(`[update] ${msg}`); }

/** Preserved paths are matched on the FIRST path segment, so `data/anything` is covered. */
function isPreserved(relPath) {
  const top = relPath.split("/")[0];
  return PRESERVE.includes(top);
}

// --- version ---

/** VERSION from a constants.ts source string — the repo's single source of truth. */
function parseVersion(src) {
  const m = src.match(/export const VERSION\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

const CONSTANTS_REL = "packages/shared/src/constants.ts";

function localVersion() {
  try {
    return parseVersion(fs.readFileSync(path.join(root, CONSTANTS_REL), "utf8"));
  } catch {
    return null;
  }
}

/** Numeric semver compare. Returns >0 if a is newer than b. Non-numeric suffixes
 *  (e.g. "1.0.0-rc1") compare by their numeric prefix, which is enough to order
 *  releases; equal-prefix pre-releases are treated as equal rather than guessed at. */
function compareVersions(a, b) {
  const parts = (v) => v.split(/[.\-+]/).map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchWithTimeout(url, asBuffer = false) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    // Cache-bust: raw.githubusercontent serves up to ~5 minutes stale, long enough to
    // miss a version pushed just before a restart.
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}ts=${Date.now()}`, {
      signal: abort.signal,
      headers: { "cache-control": "no-cache" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// --- tar.gz extraction (no deps) ---

/**
 * Parse a tar buffer into `{ path, mode, body }` entries.
 *
 * Only regular files are returned: directories are implied by the paths we create, and
 * symlinks/devices/hardlinks are DROPPED rather than recreated — a symlink in an archive
 * is how an extract escapes its target directory, and the bot's tree has none.
 */
function parseTar(buf) {
  const out = [];
  let offset = 0;
  // A pax/GNU extended header carries the real name for the entry that FOLLOWS it.
  let pendingName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const str = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
    };
    const octal = (start, len) => parseInt(str(start, len).trim() || "0", 8) || 0;

    const name = str(0, 100);
    const size = octal(124, 12);
    const type = String.fromCharCode(header[156]) || "0";
    const prefix = str(345, 155);
    const bodyStart = offset + 512;
    const body = buf.subarray(bodyStart, bodyStart + size);
    // Bodies are padded to a 512-byte boundary.
    offset = bodyStart + Math.ceil(size / 512) * 512;

    if (type === "L" || type === "x" || type === "X") {
      // GNU longname ('L') is the raw path; pax ('x') is "<len> path=<value>\n" records.
      const text = body.toString("utf8");
      const m = type === "L" ? text.replace(/\0.*$/, "") : (text.match(/ path=([^\n]+)\n/)?.[1] ?? null);
      if (m) pendingName = m;
      continue;
    }
    if (type === "g") continue; // global pax header — not per-entry

    const full = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;

    if (type === "0" || type === "\0" || type === "") {
      out.push({ path: full, mode: octal(100, 8), body: Buffer.from(body) });
    }
    // types 1/2 (links), 5 (dir), 3/4/6/7: intentionally skipped
  }
  return out;
}

/** Strip the archive's single top-level directory (`DT-master/`) and reject any path
 *  that would escape the install root. */
function normalizeEntries(entries) {
  const out = [];
  for (const e of entries) {
    const idx = e.path.indexOf("/");
    if (idx === -1) continue; // the top-level dir entry itself
    const rel = e.path.slice(idx + 1);
    if (!rel) continue;
    // Path traversal / absolute paths / Windows drive letters — refuse outright.
    if (rel.startsWith("/") || rel.includes("..") || /^[a-zA-Z]:/.test(rel) || rel.includes("\0")) {
      throw new Error(`refusing suspicious archive path: ${e.path}`);
    }
    out.push({ ...e, path: rel });
  }
  return out;
}

/**
 * The downloaded tree has to look like this project before we let it overwrite anything.
 * A truncated download, an HTML error page, or the wrong repo would otherwise be written
 * straight over a working install.
 */
function verifyTree(entries) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const required = [
    "package.json",
    CONSTANTS_REL,
    "packages/backend/src/main.ts",
    "packages/web/package.json",
  ];
  for (const r of required) {
    if (!byPath.has(r)) throw new Error(`archive is missing ${r} — refusing to install it`);
  }
  const pkg = JSON.parse(byPath.get("package.json").body.toString("utf8"));
  if (pkg.name !== "death-and-taxes-bot") {
    throw new Error(`archive is a different project (${pkg.name}) — refusing to install it`);
  }
  const version = parseVersion(byPath.get(CONSTANTS_REL).body.toString("utf8"));
  if (!version) throw new Error("archive has no readable VERSION — refusing to install it");
  return { version, pkgVersion: pkg.version };
}

// --- apply ---

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    if (Array.isArray(m?.files)) return m;
  } catch { /* first update, or unreadable */ }
  return null;
}

/**
 * Write the new tree over the install, backing up every file we touch.
 *
 * Deletions are driven by the PREVIOUS manifest: a file the last update installed which
 * the new archive no longer has is removed, so a renamed or retired module doesn't linger
 * and get imported. With no manifest (first run) nothing is deleted — we can't tell a
 * retired file from one the user added, and leaving a stray file is harmless where
 * deleting the user's is not.
 */
function applyTree(entries, newVersion) {
  const prev = readManifest();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(STAGED_DIR, { recursive: true, force: true });

  let written = 0;
  let unchanged = 0;
  const installed = [];
  const staged = [];
  let lockChanged = false;
  // Set by the launchers, which are the shells whose own file we must not rewrite. When
  // the updater is run by hand (`npm run update`) no shell is executing them, so the
  // change can be applied directly.
  const launchedByShell = process.env.BOT_UPDATE_FROM_LAUNCHER === "1";

  for (const e of entries) {
    if (isPreserved(e.path)) continue; // never touch the user's own files
    installed.push(e.path);
    const dest = path.join(root, e.path);

    let current = null;
    try { current = fs.readFileSync(dest); } catch { /* new file */ }
    if (current && current.equals(e.body)) { unchanged++; continue; }

    // A launcher change can't be written under the shell that's running it — see LAUNCHERS.
    // Staged to disk instead, so nothing is lost and `npm run update` completes it.
    if (launchedByShell && LAUNCHERS.includes(e.path) && current) {
      const stagedPath = path.join(STAGED_DIR, e.path);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.writeFileSync(stagedPath, e.body);
      staged.push(e.path);
      continue;
    }

    if (current) {
      // Back up before overwriting, so a bad update is recoverable by hand.
      const bak = path.join(BACKUP_DIR, e.path);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.writeFileSync(bak, current);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.body);
    // Executable bit matters for the .command launcher on macOS; on Windows chmod is
    // a no-op, so this is safe to attempt either way.
    if (e.mode & 0o111) { try { fs.chmodSync(dest, 0o755); } catch { /* best effort */ } }
    written++;
    if (e.path === "package-lock.json" || e.path === "package.json") lockChanged = true;
  }

  let removed = 0;
  if (prev) {
    const nowHas = new Set(installed);
    for (const old of prev.files) {
      if (nowHas.has(old) || isPreserved(old)) continue;
      const p = path.join(root, old);
      if (!fs.existsSync(p)) continue;
      const bak = path.join(BACKUP_DIR, old);
      try {
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(p, bak);
        fs.rmSync(p);
        removed++;
      } catch (err) {
        warn(`could not remove retired file ${old}: ${err.message}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({ version: newVersion, updatedAt: new Date().toISOString(), files: installed }, null, 2) + "\n",
  );

  return { written, unchanged, removed, lockChanged, staged };
}

/**
 * Apply launcher updates staged by an earlier run (see LAUNCHERS). Safe here because
 * `npm run update` is not itself one of the launchers, so no shell holds the file.
 */
function applyStaged() {
  const applied = [];
  for (const name of LAUNCHERS) {
    const stagedPath = path.join(STAGED_DIR, name);
    if (!fs.existsSync(stagedPath)) continue;
    const dest = path.join(root, name);
    try {
      const body = fs.readFileSync(stagedPath);
      let current = null;
      try { current = fs.readFileSync(dest); } catch { /* absent */ }
      if (current && current.equals(body)) { fs.rmSync(stagedPath, { force: true }); continue; }
      if (current) {
        const bak = path.join(BACKUP_DIR, name);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.writeFileSync(bak, current);
      }
      fs.writeFileSync(dest, body);
      // The .command launcher must stay executable for Finder to run it on double-click.
      if (name.endsWith(".command")) { try { fs.chmodSync(dest, 0o755); } catch { /* best effort */ } }
      fs.rmSync(stagedPath, { force: true });
      applied.push(name);
    } catch (err) {
      warn(`could not apply staged ${name}: ${err.message}`);
    }
  }
  return applied;
}

/** True when running from a git clone — there `git pull` is the update mechanism and
 *  overwriting the working tree would destroy uncommitted work. */
function isGitCheckout() {
  return fs.existsSync(path.join(root, ".git"));
}

async function main() {
  const mode = process.env.BOT_AUTO_UPDATE ?? "on";
  if (mode === "off") { log("disabled (BOT_AUTO_UPDATE=off)"); return 0; }
  // A clone is refused even under --force: there `git pull` is the update path, and
  // overwriting the working tree would destroy uncommitted work. --force means "reinstall
  // the current version", not "overwrite my git checkout" — opting in takes the deliberate
  // BOT_AUTO_UPDATE=force, matching LIST_AUTO_UPDATE in list-sync.ts.
  if (isGitCheckout() && mode !== "force") {
    log("skipped: this is a git checkout — use `git pull` to update.");
    return 0;
  }

  const local = localVersion();
  if (!local) { warn("could not read the local version; skipping the update check."); return 0; }

  // Finish any launcher update a previous run had to stage. Done before the version check
  // so it completes even when the code is already current — otherwise a staged launcher
  // would sit there until the NEXT release happened to come along.
  if (!process.env.BOT_UPDATE_FROM_LAUNCHER && fs.existsSync(STAGED_DIR)) {
    const applied = applyStaged();
    if (applied.length > 0) log(`applied staged launcher update(s): ${applied.join(", ")}`);
  }

  let remote;
  try {
    remote = parseVersion(await fetchWithTimeout(`${RAW}/${CONSTANTS_REL}`));
  } catch (err) {
    // Offline is the common case here and must never block startup.
    warn(`could not check for updates (${err.message}); continuing on v${local}.`);
    return 0;
  }
  if (!remote) { warn("could not read the published version; continuing."); return 0; }

  const cmp = compareVersions(remote, local);
  if (cmp <= 0 && !force) {
    log(cmp === 0 ? `up to date (v${local}).` : `local v${local} is ahead of published v${remote}; nothing to do.`);
    return 0;
  }
  log(`update available: v${local} -> v${remote}`);
  if (checkOnly) return 10; // distinct exit code so a script can act on it

  let entries;
  try {
    const gz = await fetchWithTimeout(TARBALL, true);
    entries = normalizeEntries(parseTar(zlib.gunzipSync(gz)));
  } catch (err) {
    warn(`download failed (${err.message}); continuing on v${local}.`);
    return 0;
  }

  let info;
  try {
    info = verifyTree(entries);
  } catch (err) {
    warn(`${err.message}; continuing on v${local}.`);
    return 0;
  }
  // The archive is built from the branch tip, which may be newer than the version we
  // saw a moment ago; only a MISMATCH downward is suspicious.
  if (compareVersions(info.version, local) <= 0 && !force) {
    log(`downloaded tree is v${info.version}, not newer than v${local}; leaving the install alone.`);
    return 0;
  }

  log(`installing v${info.version} (keeping ${PRESERVE.filter((p) => fs.existsSync(path.join(root, p))).join(", ")})`);
  let result;
  try {
    result = applyTree(entries, info.version);
  } catch (err) {
    warn(`update FAILED partway: ${err.message}`);
    warn(`replaced files were backed up to ${path.relative(root, BACKUP_DIR)} — restore from there if the bot won't start.`);
    return 1;
  }

  log(`updated to v${info.version}: ${result.written} file(s) written, ${result.unchanged} unchanged, ${result.removed} removed.`);
  if (result.staged.length > 0) {
    // Say exactly what to do rather than leaving a silent half-update: the code is current,
    // only the launcher glue is pending.
    log(`${result.staged.join(", ")} changed but is running right now — run \`npm run update\` to finish it.`);
  }

  // Dependencies may have changed with the new code. Reinstall only when the manifest
  // actually moved — an unconditional install would add minutes to every launch.
  if (result.lockChanged && fs.existsSync(path.join(root, "node_modules"))) {
    log("dependencies changed — running npm install...");
    try {
      execFileSync("npm", ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    } catch {
      warn("npm install failed — if the bot won't start, run `npm install` by hand.");
    }
  }
  return 0;
}

// The pure, side-effect-free helpers are exported so the guards that matter most —
// path-traversal rejection, symlink dropping, project verification, the preserve list —
// are unit-tested in packages/backend/src/update-guards.test.ts rather than only exercised
// by running a real update. main() stays behind an entry-point check so importing this
// file for those tests doesn't kick off an update.
export { parseTar, normalizeEntries, verifyTree, compareVersions, isPreserved, parseVersion, PRESERVE, LAUNCHERS };

// `import.meta.main` is Node >=24 only; the argv[1] comparison is the portable form and
// the project supports Node 20+.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      // Any unforeseen error must still let the bot boot on the existing version.
      warn(`unexpected error: ${err.message}; continuing without updating.`);
      process.exitCode = 0;
    });
}
