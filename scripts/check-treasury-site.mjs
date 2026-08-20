// Check the published treasury site.
//
// Publishing has a handful of quiet failure modes that all look fine in a browser: the
// _headers file not applied (so the CSP never ships), a header that no longer matches the
// page it guards, or — the common one — a deploy that silently didn't happen, leaving an
// old ledger up while you believe it is current. This checks all of them from outside.
//
//   npm run check-treasury                              # defaults to https://gubnah.xyz
//   npm run check-treasury -- --url https://x.pages.dev
//
// Exit code is non-zero if anything fails, so it can gate a deploy script.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const url = argOf("url", "https://gubnah.xyz").replace(/\/$/, "");

let failed = 0;
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, detail) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${detail ? `\n        ${detail}` : ""}`); };
const note = (m) => console.log(`        ${m}`);

console.log(`\n  Checking ${url}\n`);

let res;
try {
  res = await fetch(`${url}/`, { redirect: "follow" });
} catch (err) {
  console.error(`  Could not reach ${url} — ${err.message}\n`);
  process.exit(1);
}

if (res.ok) ok(`responds ${res.status}`);
else bad(`responds ${res.status}`, "Expected 200. A 404 usually means the deploy has not landed yet.");

const html = await res.text();

// --- headers --------------------------------------------------------------
const csp = res.headers.get("content-security-policy");
if (!csp) {
  bad("Content-Security-Policy is served", "The _headers file was not applied — check it sits at the root of the uploaded directory.");
} else {
  ok("Content-Security-Policy is served");
  const declared = csp.match(/script-src\s+'sha256-([^']+)'/);
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!declared) {
    bad("CSP pins the page's script by hash", "script-src has no sha256 — an injected script could run.");
  } else if (!inline) {
    bad("the served page has an inline script to pin");
  } else {
    // Mirrors the hash the publisher writes; a mismatch means the page and its header
    // were deployed from different builds, and the page will be blank in a browser.
    const actual = crypto.createHash("sha256").update(inline[1], "utf8").digest("base64");
    if (actual === declared[1]) ok("CSP hash matches the served script");
    else bad("CSP hash matches the served script", "Header and page are from different builds — republish and redeploy together.");
  }
}

for (const [header, expected] of [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
]) {
  const got = res.headers.get(header);
  if (got && got.toLowerCase() === expected.toLowerCase()) ok(`${header}: ${got}`);
  else bad(`${header}: ${expected}`, `got ${got ?? "nothing"}`);
}

// --- content --------------------------------------------------------------
const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
if (title === "Gubnah Treasury") ok(`title is "${title}"`);
else bad('title is "Gubnah Treasury"', `got "${title ?? "nothing"}"`);

if (/<input|<button|<form/i.test(html)) {
  bad("the published page is read-only", "It contains an input, button or form — that should never reach the public copy.");
} else ok("the published page is read-only");

const embedded = html.match(/<script type="application\/json" id="ledger">([\s\S]*?)<\/script>/);
let live = null;
if (!embedded) {
  bad("carries a ledger");
} else {
  try {
    live = JSON.parse(embedded[1].replace(/\\u003c/g, "<"));
    ok("carries a ledger");
  } catch {
    bad("carries a ledger", "The embedded JSON did not parse.");
  }
}

// --- freshness ------------------------------------------------------------
if (live) {
  const eth = (w) => {
    if (w == null) return "—";
    const v = BigInt(w);
    const f = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
    return `${v / 10n ** 18n}${f ? `.${f}` : ""}`;
  };
  note("");
  note(`live: ${eth(live.raisedWei)} raised · ${eth(live.deployedWei)} deployed · ${live.participants?.length ?? 0} holders`);
  note(`synced: ${live.syncedAt ?? "never"}`);

  const localFile = path.join(root, "site/dist/index.html");
  if (fs.existsSync(localFile)) {
    const localMatch = fs.readFileSync(localFile, "utf8")
      .match(/<script type="application\/json" id="ledger">([\s\S]*?)<\/script>/);
    if (localMatch) {
      try {
        const local = JSON.parse(localMatch[1].replace(/\\u003c/g, "<"));
        if (local.syncedAt && live.syncedAt && local.syncedAt > live.syncedAt) {
          bad("the live page is current", `Your local build is newer (${local.syncedAt}). Deploy it.`);
        } else if (local.syncedAt === live.syncedAt) {
          ok("the live page matches your local build");
        }
      } catch { /* a local build we cannot read tells us nothing */ }
    }
  }
}

console.log(failed === 0 ? "\n  All checks passed.\n" : `\n  ${failed} check${failed === 1 ? "" : "s"} failed.\n`);
process.exit(failed ? 1 : 0);
