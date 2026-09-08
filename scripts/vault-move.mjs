// Move ONE citizen between a wallet you hold and the CitizenVault — the step the bot has no
// path for.
//
// The vault is the citizen's on-chain owner once it is inside, so migrating is an ERC721
// transfer, not a bot action. Nothing in packages/backend ever calls safeTransferFrom (by
// design: the bot's hot key must never be able to move a citizen), and the bot's key lives in
// an encrypted keystore rather than in MetaMask — so without this there is no way to do the
// deposit except exporting a hot private key into a browser wallet, which is a worse idea than
// a one-off script.
//
// The key is decrypted in memory for exactly one signature and never written anywhere. The
// passphrase is read from a hidden prompt, not from argv (argv lands in shell history) and not
// from a file.
//
//   IN  (deposit):  npm run vault-move -- --token 2036 --to-vault
//   OUT (withdraw): use the vault's own withdrawCitizens from the OWNER key, not this script.
//                   Only `owner` can withdraw, and `owner` is a cold key that is deliberately
//                   not in this keystore. This script refuses the outbound direction rather
//                   than pretending it can do it.
//
//   --dry-run   simulate via eth_call and print the outcome without signing
//   --token N   the citizen to move (required)
//
// RPC resolution matches the other scripts: RPC_HTTP_URL, then ALCHEMY_API_KEY, then
// data/settings.json (alchemyApiKey).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, encodeFunctionData, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

// pathToFileURL, not the bare path: a Windows absolute path ("c:\…") is read by the ESM loader
// as a URL scheme and rejected outright.
const { loadWallets, decryptPrivateKey } = await import(
  pathToFileURL(path.join(root, "packages/backend/dist/keystore.js")).href
);

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const tokenId = val("--token");
const dryRun = flag("--dry-run");

if (!tokenId || !/^\d+$/.test(tokenId)) {
  console.error("Usage: npm run vault-move -- --token <id> --to-vault [--dry-run]");
  process.exit(1);
}
if (!flag("--to-vault")) {
  console.error(
    "Refusing to run without --to-vault.\n\n" +
    "This script only moves citizens INTO the vault. Getting them out is\n" +
    "withdrawCitizens([id], to) called from the vault's OWNER key — a cold key that is not in\n" +
    "this keystore, and should not be. Do that from MetaMask/Etherscan.",
  );
  process.exit(1);
}

// --- config -----------------------------------------------------------------
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const settings = fs.existsSync(path.join(dataDir, "settings.json")) ? readJson(path.join(dataDir, "settings.json")) : {};
const rpcUrl =
  process.env.RPC_HTTP_URL ||
  (process.env.ALCHEMY_API_KEY && `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) ||
  (settings.alchemyApiKey && `https://eth-mainnet.g.alchemy.com/v2/${settings.alchemyApiKey}`);
if (!rpcUrl) { console.error("No RPC. Set RPC_HTTP_URL or ALCHEMY_API_KEY, or add alchemyApiKey to data/settings.json."); process.exit(1); }

const cfgPath = path.join(dataDir, "config.json");
const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
const vault = (cfg.vaultAddress || "").trim();
if (!/^0x[a-fA-F0-9]{40}$/.test(vault)) {
  console.error(`No usable vaultAddress in data/config.json (got ${JSON.stringify(cfg.vaultAddress ?? null)}).\n` +
    "Set it in the dashboard (JIT panel -> Vault address) and Save first — the field shows\n" +
    "'vault ready' once the bot has checked the wiring.");
  process.exit(1);
}

const GAME = "0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F";
const pub = createPublicClient({ transport: http(rpcUrl) });

const addrOut = [{ type: "address" }];
const viewFn = (name, inputs, outputs) =>
  [{ type: "function", name, stateMutability: "view", inputs, outputs }];

// --- preflight: refuse on positive evidence of bad wiring -------------------
// Same principle as vault-preflight.ts. A transfer into a mis-wired vault is not recoverable
// by the bot, so every one of these is checked BEFORE anything is signed.
const citizens = await pub.readContract({ address: GAME, abi: viewFn("citizens", [], addrOut), functionName: "citizens" });
const [vGame, vCitizens, vOperator, vOwner] = await Promise.all(
  ["game", "citizens", "operator", "owner"].map((n) =>
    pub.readContract({ address: vault, abi: viewFn(n, [], addrOut), functionName: n }).catch(() => null)),
);
const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

const owner = await pub.readContract({
  address: citizens, abi: viewFn("ownerOf", [{ type: "uint256" }], addrOut), functionName: "ownerOf", args: [BigInt(tokenId)],
});

const wallets = loadWallets(dataDir);
const holder = wallets.find((w) => eq(w.address, owner));

console.log(`citizen        #${tokenId}`);
console.log(`held by        ${owner}${holder ? "  (in this keystore)" : "  (NOT in this keystore)"}`);
console.log(`vault          ${vault}`);
console.log(`vault.owner    ${vOwner ?? "unreadable"}`);
console.log(`vault.operator ${vOperator ?? "unreadable"}`);
console.log();

const problems = [];
if (!vGame || !vCitizens || !vOperator || !vOwner) problems.push("Vault does not answer owner/operator/game/citizens — is that address really a CitizenVault?");
if (vGame && !eq(vGame, GAME)) problems.push(`Vault points at game ${vGame}, expected ${GAME}.`);
if (vCitizens && !eq(vCitizens, citizens)) problems.push(`Vault points at citizens ${vCitizens}, live collection is ${citizens}.`);
if (vOperator && !wallets.some((w) => eq(w.address, vOperator))) problems.push(`Vault operator ${vOperator} is not a wallet in this keystore — the bot could never batch. Fix with setOperator from the owner key.`);
if (vOwner && wallets.some((w) => eq(w.address, vOwner))) problems.push(`Vault owner ${vOwner} IS a wallet in this keystore, so the hot key can withdraw citizens. That defeats the owner/operator split — deploy from a cold key instead.`);
if (eq(owner, vault)) problems.push(`#${tokenId} is ALREADY held by the vault. Nothing to do.`);
if (!holder && !eq(owner, vault)) problems.push(`#${tokenId} is held by ${owner}, which is not in data/wallet.keystore.json — this script cannot sign for it.`);

if (problems.length) {
  console.error("Refusing to move anything:\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}

const data = encodeFunctionData({
  abi: [{ type: "function", name: "safeTransferFrom", stateMutability: "nonpayable",
          inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }],
  functionName: "safeTransferFrom",
  args: [owner, vault, BigInt(tokenId)],
});

// eth_call first, always. The vault's onERC721Received rejects any collection that is not
// `citizens`, so a wrong-vault or wrong-collection mistake surfaces here for free.
try {
  await pub.call({ account: owner, to: citizens, data });
  console.log("simulation     OK — the vault accepts this citizen");
} catch (err) {
  console.error("simulation     FAILED — not sending.\n  " + (err.shortMessage || err.message));
  process.exit(1);
}

const gas = await pub.estimateGas({ account: owner, to: citizens, data }).catch(() => 120_000n);
const fees = await pub.estimateFeesPerGas();
console.log(`gas            ~${gas} @ ${(Number(fees.maxFeePerGas) / 1e9).toFixed(2)} gwei max`);
console.log(`cost           ~${formatEther(gas * fees.maxFeePerGas)} ETH`);

if (dryRun) { console.log("\n--dry-run: nothing signed."); process.exit(0); }

// --- confirm, then sign -----------------------------------------------------
const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.question(q, (a) => { rl.close(); res(a); });
});

/**
 * Read a secret without echoing it.
 *
 * Raw mode, character by character, rather than readline with its output muted. The muted
 * variant is the common recipe and it silently breaks PASTE: a pasted passphrase arrives as one
 * multi-byte chunk, and readline with a stubbed `output.write` mishandles it — the paste appears
 * to do nothing, which is indistinguishable from a dead terminal.
 *
 * In raw mode the whole chunk lands in one `data` event, so iterating over its characters
 * handles paste and typing identically. Two details that matter:
 *
 *  - Bracketed paste. Terminals wrap pasted text in \x1b[200~ … \x1b[201~; those markers have
 *    to be stripped or they end up INSIDE the passphrase, which fails decryption with no clue
 *    as to why.
 *  - Ctrl+C. Raw mode disables the default SIGINT, so it is handled explicitly — otherwise the
 *    prompt cannot be escaped.
 */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Piped input (e.g. `echo pass | npm run vault-move …`). Read it straight through.
      let piped = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => { piped += d; });
      process.stdin.on("end", () => resolve(piped.replace(/[\r\n]+$/, "")));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8").replace(/\x1b\[20[01]~/g, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") { cleanup(); process.stdout.write("\n"); return resolve(buf); }
        if (ch === "\u0003") { cleanup(); process.stdout.write("\n"); return reject(new Error("cancelled")); }
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch < " ") continue; // drop stray control/escape bytes
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const confirm = await ask(`\nMove #${tokenId} into ${vault}? Only the vault's cold owner can move it back. [type the token id to confirm] `);
if (confirm.trim() !== tokenId) { console.log("Aborted."); process.exit(0); }

/**
 * KEYSTORE_PASSPHRASE is honoured as an escape hatch for terminals where hidden input still
 * misbehaves. Documented rather than encouraged: an inline `VAR=secret command` lands in shell
 * history, so the safe form is `read -rs KEYSTORE_PASSPHRASE` first, then export it.
 */
let passphrase = process.env.KEYSTORE_PASSPHRASE ?? null;
if (passphrase) {
  console.log("Keystore passphrase: (taken from KEYSTORE_PASSPHRASE)");
} else {
  passphrase = await askHidden("Keystore passphrase (paste works; nothing will appear): ")
    .catch(() => { console.log("Cancelled."); process.exit(0); });
}
if (!passphrase) { console.error("Empty passphrase — aborting."); process.exit(1); }
let pk;
try { pk = decryptPrivateKey(holder, passphrase); }
catch { console.error("Incorrect passphrase."); process.exit(1); }

const account = privateKeyToAccount(pk);
if (!eq(account.address, owner)) { console.error("Decrypted key does not match the holder — aborting."); process.exit(1); }

const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });
const hash = await wallet.sendTransaction({ to: citizens, data, gas: (gas * 12n) / 10n });
console.log(`\nsent           ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status         ${receipt.status}  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);

const nowOwner = await pub.readContract({
  address: citizens, abi: viewFn("ownerOf", [{ type: "uint256" }], addrOut), functionName: "ownerOf", args: [BigInt(tokenId)],
});
console.log(`#${tokenId} owner   ${nowOwner}${eq(nowOwner, vault) ? "  <- in the vault" : "  <- NOT in the vault"}`);
if (eq(nowOwner, vault)) {
  console.log("\nNext: the bot finds vault-held citizens through the NFT index, which can lag a fresh");
  console.log("transfer by a minute or two. Confirm the dashboard lists it before the boundary.");
}
