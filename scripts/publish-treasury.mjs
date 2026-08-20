// Publish the emigration treasury as a static page.
//
// The bot is the authority on the ledger: it reads the wallet directly, counts citizens
// from the ownership index, and holds the operator's roster. This takes that ledger and
// bakes it into a standalone HTML file — no server, no API, nothing to keep running —
// which you upload wherever the public page lives.
//
// The published page is READ-ONLY by construction. Editing happens in the dashboard's
// Treasury panel; publishing is how the public copy catches up. That asymmetry is the
// point: a visitor cannot rewrite the record, because there is nothing there to write to.
//
//   npm run publish-treasury                     # from a running bot on :8787
//   npm run publish-treasury -- --in led.json    # ...or from a saved ledger
//   npm run publish-treasury -- --out /tmp/t.html
//
// Then upload the output. Any static host works (Cloudflare Pages, Netlify, GitHub
// Pages, S3) — it is one self-contained file whose only external request is the font.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apiBase = arg("api", "http://127.0.0.1:8787").replace(/\/$/, "");
const inFile = arg("in", null);
const outFile = path.resolve(root, arg("out", "site/dist/treasury.html"));
const template = path.resolve(root, arg("template", "site/treasury.html"));

function die(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

async function readLedger() {
  if (inFile) {
    const file = path.resolve(process.cwd(), inFile);
    if (!fs.existsSync(file)) die(`No such file: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const url = `${apiBase}/api/treasury`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    die(
      `Could not reach the bot at ${url} — ${err.message}`,
      "Start it with `npm run dev`, or pass a saved ledger with --in.",
    );
  }
  if (!res.ok) die(`${url} returned ${res.status}`, await res.text());
  return res.json();
}

const ledger = await readLedger();

// Refuse to publish something that is not a ledger: writing a broken page over a live one
// is worse than not publishing at all.
if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.participants) || !Array.isArray(ledger.movements)) {
  die("That doesn't look like a treasury ledger.", "Expected an object with participants and movements arrays.");
}
if (typeof ledger.wallet !== "string") die("The ledger has no wallet address.");

if (!fs.existsSync(template)) die(`No template at ${template}`);
const html = fs.readFileSync(template, "utf8");

const marker = /(<script type="application\/json" id="ledger">)[\s\S]*?(<\/script>)/;
if (!marker.test(html)) {
  die("The template has no ledger placeholder.", 'Expected <script type="application/json" id="ledger">…</script>.');
}

// Escaping "<" keeps a nickname or note containing "</script>" from ending the block.
const json = JSON.stringify(ledger).replace(/</g, "\\u003c");
const out = html.replace(marker, (_m, open, close) => `${open}${json}${close}`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);

const eth = (wei) => {
  if (wei == null) return "—";
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
};

console.log(`
  Published ${path.relative(root, outFile)}  (${(out.length / 1024).toFixed(1)} KB)

    raised     ${eth(ledger.raisedWei)} ETH
    deployed   ${eth(ledger.deployedWei)} ETH
    on hand    ${eth(ledger.onHandWei)} ETH
    split      ${ledger.perCitizenWei == null ? "—" : `${eth(ledger.perCitizenWei)} ETH`} per citizen across ${ledger.totalCitizens}
    holders    ${ledger.participants.length}
    movements  ${ledger.movements.length}
    synced     ${ledger.syncedAt ?? "never"}
${ledger.syncedAt ? "" : "\n  This ledger has never been synced — refresh it in the dashboard first.\n"}`);
