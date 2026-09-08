// Check a CitizenVault is wired correctly — BEFORE any citizen goes into it.
//
// Reading a contract is free and changes nothing, so this is safe to run as often as you like
// and needs no wallet, no gas and no passphrase.
//
// Exists because the mistake it catches is silent and permanent. A vault whose `operator` is
// not this bot's wallet accepts citizens perfectly happily and then reverts every batch; a
// vault whose `game` is wrong would send tax to a dead address while reporting success. Once
// citizens are inside, only the cold owner key can get them out — so the moment to find this
// out is before the transfer, not after.
//
//   npm run vault-check -- 0xYourVaultAddress
//   npm run vault-check                        # uses vaultAddress from data/config.json
//
// RPC resolution matches the other scripts: RPC_HTTP_URL, then ALCHEMY_API_KEY, then
// data/settings.json (alchemyApiKey).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createPublicClient, http, getContractAddress, formatEther } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const { loadWallets } = await import(
  pathToFileURL(path.join(root, "packages/backend/dist/keystore.js")).href
);

const settings = fs.existsSync(path.join(dataDir, "settings.json")) ? readJson(path.join(dataDir, "settings.json")) : {};
const rpcUrl =
  process.env.RPC_HTTP_URL ||
  (process.env.ALCHEMY_API_KEY && `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) ||
  (settings.alchemyApiKey && `https://eth-mainnet.g.alchemy.com/v2/${settings.alchemyApiKey}`);
if (!rpcUrl) { console.error("No RPC. Set RPC_HTTP_URL or ALCHEMY_API_KEY, or add alchemyApiKey to data/settings.json."); process.exit(1); }

const cfgPath = path.join(dataDir, "config.json");
const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
const vault = (process.argv[2] || cfg.vaultAddress || "").trim();

if (!/^0x[a-fA-F0-9]{40}$/.test(vault)) {
  console.error(
    "Usage: npm run vault-check -- 0xYourVaultAddress\n\n" +
    "No address given, and data/config.json has no usable vaultAddress " +
    `(${JSON.stringify(cfg.vaultAddress ?? null)}).`,
  );
  process.exit(1);
}

const GAME = "0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F";
const pub = createPublicClient({ transport: http(rpcUrl) });
const addr = [{ type: "address" }];
const viewFn = (n, o = addr) => [{ type: "function", name: n, stateMutability: "view", inputs: [], outputs: o }];
const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const code = await pub.getCode({ address: vault }).catch(() => "0x");
if (!code || code === "0x") {
  /**
   * Almost always one specific mistake: the DEPLOYER WALLET was pasted instead of the contract
   * it created. Remix shows both, they are the same shape, and only one of them is the vault.
   *
   * So rather than stopping at "nothing here", derive what this address has deployed. A CREATE
   * address is keccak(rlp([sender, nonce])), so every contract an EOA has ever made is
   * computable from its nonce alone — no indexer, no API key. That turns a dead end into the
   * answer.
   */
  const nonce = await pub.getTransactionCount({ address: vault }).catch(() => 0);
  const bal = await pub.getBalance({ address: vault }).catch(() => 0n);
  console.error("FAIL  No contract at " + vault + " on mainnet.");
  console.error("      It has " + formatEther(bal) + " ETH and has sent " + nonce + " transaction(s),");
  console.error("      so this looks like a WALLET, not a contract.\n");

  const made = [];
  for (let n = 0; n < Math.min(nonce, 12); n++) {
    const addr = getContractAddress({ from: vault, nonce: BigInt(n), opcode: "CREATE" });
    const c = await pub.getCode({ address: addr }).catch(() => "0x");
    if (c && c !== "0x") made.push({ addr, size: (c.length - 2) / 2, nonce: n });
  }
  if (made.length) {
    console.error("      Contracts this wallet deployed — the newest is usually the one you want:");
    for (const m of made) console.error("        " + m.addr + "   " + m.size + " bytes   (nonce " + m.nonce + ")");
    console.error("\n      Re-run with one of those:  npm run vault-check -- " + made[made.length - 1].addr);
  } else {
    console.error("      It has never deployed a contract. Copy the address from Remix's");
    console.error("      'Deployed Contracts' panel — not the transaction hash, and not your wallet.");
  }
  process.exit(1);
}

const citizens = await pub.readContract({ address: GAME, abi: viewFn("citizens"), functionName: "citizens" });
const [vOwner, vOperator, vGame, vCitizens] = await Promise.all(
  ["owner", "operator", "game", "citizens"].map((n) =>
    pub.readContract({ address: vault, abi: viewFn(n), functionName: n }).catch(() => null)),
);
const wallets = loadWallets(dataDir);
const botAddresses = wallets.map((w) => w.address);

console.log(`vault      ${vault}   (${(code.length - 2) / 2} bytes of code)`);
console.log(`owner      ${vOwner ?? "— unreadable —"}`);
console.log(`operator   ${vOperator ?? "— unreadable —"}`);
console.log(`game       ${vGame ?? "— unreadable —"}`);
console.log(`citizens   ${vCitizens ?? "— unreadable —"}`);
console.log();
console.log(`this bot signs as   ${botAddresses.join(", ") || "(no wallet in keystore)"}`);
console.log(`live game           ${GAME}`);
console.log(`live collection     ${citizens}`);
console.log();

const problems = [];
const notes = [];

/**
 * Is the DEPLOYED code the audited build?
 *
 * Wiring being right is not the same as the CODE being right, and the second is what slipped
 * through: three deploys in a row had correct owner/operator/game/citizens and none of them
 * carried the audit fixes. Getters can tell you the addresses; nothing can tell you the logic
 * except compiling the source locally and comparing.
 *
 * Two things have to be normalised before comparing, and missing either one makes the check
 * cry wolf on a perfectly good deploy:
 *
 *  1. IMMUTABLES. `owner`, `game` and `citizens` are `immutable`, which solc implements by
 *     stamping the values directly into the runtime code at construction. solc's own
 *     deployedBytecode therefore has 32-byte holes of zeros where the deployed contract has
 *     real addresses — ten of them here. It reports the offsets as `immutableReferences`, so
 *     both sides get those windows blanked.
 *  2. METADATA. The trailing CBOR blob holds an IPFS hash of the source path and settings, so
 *     the same logic compiled in Remix and here differs in the last ~53 bytes.
 *
 * What is left is the actual logic, compared byte for byte.
 */
let localRuntime = null;
try {
  // Bare specifier: solc is hoisted to the workspace root by npm, not kept under
  // packages/backend, so a hand-built path to it misses.
  const solc = createRequire(import.meta.url)("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: {
      "CitizenVault.sol": {
        content: fs.readFileSync(path.join(root, "contracts/CitizenVault.sol"), "utf8"),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["evm.deployedBytecode"] } },
    },
  })));
  const fatal = (out.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length) throw new Error(fatal[0].formattedMessage);
  const dep = out.contracts["CitizenVault.sol"].CitizenVault.evm.deployedBytecode;
  localRuntime = { object: dep.object, immutables: dep.immutableReferences ?? {} };
  if (!solc.version().startsWith("0.8.26")) {
    notes.push("Local solc is " + solc.version() + ", not 0.8.26 — use 0.8.26 in Remix for a byte-exact match.");
  }
} catch (err) {
  notes.push("Could not compile contracts/CitizenVault.sol locally, so only the WIRING was checked, not the code. (" + String(err.message).split("\n")[0] + ")");
}

if (localRuntime) {
  const normalise = (hex) => {
    const chars = hex.split("");
    for (const refs of Object.values(localRuntime.immutables)) {
      for (const r of refs) {
        for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
      }
    }
    // Drop the 53-byte CBOR metadata plus its 2-byte length.
    return chars.slice(0, Math.max(0, chars.length - 110)).join("");
  };
  const onchain = code.slice(2);
  const a = normalise(onchain);
  const b = normalise(localRuntime.object);
  if (onchain.length === localRuntime.object.length && a === b) {
    console.log("code       matches contracts/CitizenVault.sol  (" + onchain.length / 2 + " bytes, immutables and metadata masked)");
  } else {
    let firstDiff = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { firstDiff = Math.floor(i / 2); break; }
    problems.push(
      "Deployed code is NOT the current contracts/CitizenVault.sol.\n" +
      "        on-chain " + onchain.length / 2 + " bytes, local build " + localRuntime.object.length / 2 + " bytes" +
      (firstDiff >= 0 ? ", first difference at byte " + firstDiff : "") + ".\n" +
      "        Usually a stale compile in the editor. Every wiring check above can pass on the\n" +
      "        wrong code, which is exactly why this check exists.",
    );
    if (!onchain.includes("61c350")) {
      problems.push("Missing the bounded coinbase gas (audit finding 1 — an unbounded forward can\n        revert a payment that already succeeded).");
    }
  }
}

if (!vOwner || !vOperator || !vGame || !vCitizens) {
  problems.push(
    "This contract does not answer owner/operator/game/citizens. It is probably not a\n" +
    "        CitizenVault — check the address.",
  );
} else {
  if (!eq(vGame, GAME)) problems.push(`game is ${vGame}, but the live game is ${GAME}.\n        Every payment would send ETH to the wrong place. Redeploy — game is immutable.`);
  if (!eq(vCitizens, citizens)) problems.push(`citizens is ${vCitizens}, but the live collection is ${citizens}.\n        withdrawCitizens would not be able to move your citizens. Redeploy — citizens is immutable.`);
  if (!botAddresses.some((a) => eq(a, vOperator))) {
    problems.push(
      `operator is ${vOperator}, which is NOT a wallet this bot holds.\n` +
      "        Every batch would revert NotAuthorised. Fix with setOperator(botWallet) called\n" +
      "        from the OWNER key — this one is fixable without redeploying.",
    );
  }
  if (botAddresses.some((a) => eq(a, vOwner))) {
    problems.push(
      `owner is ${vOwner}, which is a wallet THIS BOT holds.\n` +
      "        The key on disk can then call withdrawCitizens, so a stolen bot key means stolen\n" +
      "        citizens. owner is immutable — this needs a redeploy from a separate address.",
    );
  }
  if (eq(vOwner, vOperator)) {
    problems.push("owner and operator are the SAME address, so the split that protects your\n        citizens does not exist. Redeploy from a separate key.");
  }
}

if (!eq(cfg.vaultAddress ?? "", vault)) {
  notes.push(`data/config.json vaultAddress is ${JSON.stringify(cfg.vaultAddress ?? null)}, not this address.\n` +
    "        Set it in the dashboard (JIT panel -> Vault address) and Save before the boundary.");
}

if (problems.length === 0) {
  // Deliberately NOT "PASS" when the code could not be compared. An unverifiable code check
  // printing "safe to move a citizen in" is worse than printing nothing: the wiring checks all
  // passed on three deploys that carried none of the audit fixes.
  if (localRuntime) {
    console.log("PASS  Wiring is correct and the code matches. Safe to move a citizen in.");
  } else {
    console.log("PARTIAL  Wiring is correct, but the deployed CODE could not be verified (see note).");
    console.log("         Do not move a citizen in until the code check passes.");
    process.exitCode = 1;
  }
  for (const n of notes) console.log("NOTE  " + n);
} else {
  console.log(`FAIL  ${problems.length} problem(s) — do NOT move a citizen in yet:\n`);
  for (const p of problems) console.log("  - " + p);
  for (const n of notes) console.log("\nNOTE  " + n);
  process.exitCode = 1;
}
