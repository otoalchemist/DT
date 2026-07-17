// Build a versioned release zip: release/death-and-taxes-bot-v<VERSION>.zip
//
// The version comes from the single source of truth — VERSION in
// packages/shared/src/constants.ts — so the zip name always matches what the app
// shows in its header and startup log. The archive is produced with `git archive`,
// so it contains exactly the tracked files (no node_modules, no .env, no local
// data/settings.json or keystore) and reflects the last commit.
//
// Usage: npm run package
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// --- Read the canonical version from the shared constants ---
const constantsPath = path.join(root, "packages", "shared", "src", "constants.ts");
const constantsSrc = fs.readFileSync(constantsPath, "utf8");
const m = constantsSrc.match(/export const VERSION\s*=\s*"([^"]+)"/);
if (!m) fail(`Could not find VERSION in ${constantsPath}`);
const version = m[1];

// --- Sanity-check that package.json versions agree, so the metadata doesn't
//     drift from what the app actually reports. ---
const pkgFiles = [
  "package.json",
  "packages/shared/package.json",
  "packages/backend/package.json",
  "packages/web/package.json",
];
const mismatches = [];
for (const rel of pkgFiles) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
  if (v !== version) mismatches.push(`  ${rel}: ${v} (expected ${version})`);
}
if (mismatches.length > 0) {
  fail(
    `package.json version(s) don't match VERSION="${version}" in constants.ts:\n` +
      mismatches.join("\n") +
      `\nBump them to ${version} (or fix VERSION) and re-run.`,
  );
}

// --- Warn if the working tree is dirty: git archive packages the last commit,
//     so uncommitted edits won't be in the zip. ---
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (dirty) {
  console.warn(
    "⚠ Working tree has uncommitted changes — the zip reflects the last commit, not these edits:\n" +
      dirty
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
  );
}

// --- Produce the archive ---
const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });
const name = `death-and-taxes-bot-v${version}`;
const outFile = path.join(outDir, `${name}.zip`);

execFileSync(
  "git",
  ["archive", "--format=zip", `--prefix=${name}/`, "-o", outFile, "HEAD"],
  { cwd: root, stdio: "inherit" },
);

const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`\n✔ Wrote ${path.relative(root, outFile)} (${sizeMb} MB) — v${version}\n`);
