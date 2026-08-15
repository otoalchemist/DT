import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { GAME_CONTRACT_ADDRESS } from "@dat-bot/shared";
import { tightenPrivateFile, writePrivateFileAtomic } from "./private-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Walk up from packages/backend/src → monorepo root to find .env
const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) tightenPrivateFile(envPath);
loadEnv({ path: envPath });

// Load UI-saved settings (data/settings.json) as fallback for env vars.
const settingsPath = path.resolve(__dirname, "../../../data/settings.json");
export interface AppSettings {
  alchemyApiKey?: string;
  mode?: "mainnet" | "public";
}

export function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath)) {
      tightenPrivateFile(settingsPath);
      return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as AppSettings;
    }
  } catch {}
  return {};
}

export function saveSettings(s: AppSettings): void {
  writePrivateFileAtomic(settingsPath, JSON.stringify(s, null, 2), { backup: true });
}

// Inject settings into process.env before schema parse (env vars take priority).
const savedSettings = loadSettings();
if (savedSettings.alchemyApiKey && !process.env.ALCHEMY_API_KEY) {
  process.env.ALCHEMY_API_KEY = savedSettings.alchemyApiKey;
}
if (savedSettings.mode && !process.env.MODE) {
  process.env.MODE = savedSettings.mode;
}

const schema = z.object({
  /** "mainnet" (default) submits private bundles to the builders in BUILDER_URLS —
   *  bundles sit in the block's top region regardless of tip, which is what wins a
   *  boundary race; payments still mirror to the public mempool so they can't fail
   *  to land. "public" broadcasts only to the mempool (seated after all bundles).
   *  "local" targets an anvil fork. */
  MODE: z.enum(["mainnet", "public", "local"]).default("mainnet"),
  /** If set, HTTP/WS/NFT endpoints are derived from it unless explicitly overridden. */
  ALCHEMY_API_KEY: z.string().optional(),
  RPC_HTTP_URL: z.string().url().optional(),
  RPC_WS_URL: z.string().url().optional(),
  ALCHEMY_NFT_URL: z.string().url().optional(),
  GAME_ADDRESS: z.string().default(GAME_CONTRACT_ADDRESS),
  /** Default authenticated Flashbots endpoint used for private bundle submission. */
  FLASHBOTS_RELAY_URL: z.string().url().default("https://relay.flashbots.net"),
  /** Comma-separated builder endpoints for bundle SUBMISSION (eth_sendBundle).
   *  Only the builder that wins a slot can include your bundle, so submitting to
   *  many raises the odds. Defaults to DEFAULT_BUILDER_URLS below. */
  BUILDER_URLS: z.string().optional(),
  /** Approved keccak256 runtime-code hashes for the configured Coinbase payer. */
  COINBASE_PAYER_CODE_HASHES: z.string().default("").refine(
    (csv) => csv.split(",").map((s) => s.trim()).filter(Boolean)
      .every((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash)),
    "COINBASE_PAYER_CODE_HASHES must contain comma-separated 0x-prefixed 32-byte hashes",
  ),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default(path.resolve(__dirname, "../../../data")),
  LOG_LEVEL: z.string().optional(),
  /** Comma-separated owned tokenId overrides for local/anvil testing (no NFT API). */
  OWNED_TOKENS: z.string().optional(),
  /** Safety cap on owned-token pagination from the NFT API. */
  MAX_CANDIDATES: z.coerce.number().default(8000),
});

function parseIds(csv: string | undefined): bigint[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
}

function parseCodeHashes(csv: string): `0x${string}`[] {
  return [...new Set(
    csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  )] as `0x${string}`[];
}

export function deriveUrlsFromKey(key: string) {
  return {
    httpUrl: `https://eth-mainnet.g.alchemy.com/v2/${key}`,
    wsUrl: `wss://eth-mainnet.g.alchemy.com/v2/${key}`,
    nftUrl: `https://eth-mainnet.g.alchemy.com/nft/v3/${key}`,
  };
}

// Well-known builders that accept `eth_sendBundle` with an X-Flashbots-Signature
// header. A bundle can only be included by the builder that WINS the slot, so we
// fan out to all of them. Endpoints do change — override with BUILDER_URLS.
// Unreachable entries are tolerated: submission succeeds if ANY builder accepts.
// NOTE: rpc.buildernet.org rate-limits to ~3 req/IP/s; we send 2 per builder per
// tx (one per target block), so a burst of many tokens at once may get throttled.
// (rsync-builder.xyz was dropped — verified unreachable as of 2026-07; add it back
// via BUILDER_URLS if it returns.)
// Coverage is the binding constraint, not bid size. A bundle can only be included by the
// builder that WINS the slot, so a builder missing from this list is a slot we cannot win
// at any price. The epoch-160 boundary was lost exactly that way: the block went to
// Builder+, which was absent here, so a bundle carrying 113.6 gwei/gas — enough for index
// 1 in a block whose marginal included tx paid 0.0 — was never seen, and the citizen was
// audited instead.
//
// Share measured over 2,400 consecutive blocks (2026-08, ~8h):
//   Titan 40.3 · Quasar 22.8 · Eureka 15.7 · BuilderNet 6.3 · Builder+ 1.4 · beaver 0.1
//   bombora 1.4 · bobTheBuilder 1.1 · ultrasound 0.4 · bananabuild 0.2
//   solo / vanilla-client blocks 10.3  <- unreachable by ANY bundle, by anyone
// The list below covers ~89%. The ~11% remainder is structural, not a gap to close:
// those blocks are built by validators running stock geth/reth/besu/Nethermind, which
// accept no bundles. ultrasound.money is the only real builder still missing — it
// exposes no eth_sendBundle endpoint we could reach.
//
// Every entry was verified to answer eth_sendBundle with a protocol-level error (i.e.
// it speaks the method) rather than a transport failure. Re-check periodically: builder
// market share moves fast — Quasar and Eureka together took 38% of blocks here while
// winning none of the 15 boundaries before that, so they are recent and growing.
const DEFAULT_BUILDER_URLS = [
  "https://relay.flashbots.net",
  "https://rpc.buildernet.org", // BuilderNet — built 6 of the last 15 boundary blocks
  "https://rpc.beaverbuild.org",
  "https://rpc.titanbuilder.xyz", // Titan — built 8 of the last 15 boundary blocks
  "https://rpc.quasar.win", // Quasar
  "https://rpc.eurekabuilder.xyz", // Eureka
  "https://rpc.btcs.com", // Builder+ — built the boundary block that cost us #2036
  "https://rpc.bombora.build", // bombora
  "https://rpc.bobthebuilder.xyz", // bobTheBuilder
  "https://rpc.bananabuild.org", // bananabuild
];

function derive() {
  const raw = schema.parse(process.env);
  const key = raw.ALCHEMY_API_KEY;

  const httpUrl = raw.RPC_HTTP_URL ?? (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
  const wsUrl = raw.RPC_WS_URL ?? (key ? `wss://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
  const nftUrl = raw.ALCHEMY_NFT_URL ?? (key ? `https://eth-mainnet.g.alchemy.com/nft/v3/${key}` : undefined);

  return {
    mode: raw.MODE,
    httpUrl: httpUrl ?? "",   // empty until configured via UI
    wsUrl,
    nftUrl,
    gameAddress: raw.GAME_ADDRESS as `0x${string}`,
    flashbotsRelayUrl: raw.FLASHBOTS_RELAY_URL,
    builderUrls: raw.BUILDER_URLS
      ? raw.BUILDER_URLS.split(",").map((s) => s.trim()).filter(Boolean)
      : [...new Set([raw.FLASHBOTS_RELAY_URL, ...DEFAULT_BUILDER_URLS])],
    coinbasePayerCodeHashes: parseCodeHashes(raw.COINBASE_PAYER_CODE_HASHES),
    port: raw.PORT,
    host: raw.HOST,
    dataDir: raw.DATA_DIR,
    ownedTokensOverride: parseIds(raw.OWNED_TOKENS),
    maxCandidates: raw.MAX_CANDIDATES,
  };
}

export type AppConfig = ReturnType<typeof derive>;
export const appConfig: AppConfig = derive();
