import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { GAME_CONTRACT_ADDRESS } from "@dat-bot/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Walk up from packages/backend/src → monorepo root to find .env
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

// Load UI-saved settings (data/settings.json) as fallback for env vars.
const settingsPath = path.resolve(__dirname, "../../../data/settings.json");
export interface AppSettings {
  alchemyApiKey?: string;
  mode?: "mainnet" | "public";
}

export function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as AppSettings;
    }
  } catch {}
  return {};
}

export function saveSettings(s: AppSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
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
  /** Used for bundle SIMULATION (eth_callBundle is Flashbots-specific). */
  FLASHBOTS_RELAY_URL: z.string().url().default("https://relay.flashbots.net"),
  /** Comma-separated builder endpoints for bundle SUBMISSION (eth_sendBundle).
   *  Only the builder that wins a slot can include your bundle, so submitting to
   *  many raises the odds. Defaults to DEFAULT_BUILDER_URLS below. */
  BUILDER_URLS: z.string().optional(),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default(path.resolve(__dirname, "../../../data")),
  LOG_LEVEL: z.string().optional(),
  /** Comma-separated tokenId overrides for local/anvil testing (no NFT API). */
  OWNED_TOKENS: z.string().optional(),
  TARGET_TOKENS: z.string().optional(),
  /** Max citizen tokens to enumerate as audit/kill candidates per sweep. Enumeration
   *  is tokenId-ordered, so this is effectively "scan IDs up to N". The collection
   *  mints IDs well past the old 500 default (7000+), which meant high-ID rivals were
   *  never scanned for the un-pinned "other delinquent rivals" view. Pinned offense
   *  targets bypass this cap entirely (see fetchOffenseCandidates); this only bounds
   *  the broad sweep. Raised to cover the current ID range with headroom. */
  MAX_CANDIDATES: z.coerce.number().default(8000),
});

function parseIds(csv: string | undefined): bigint[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
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
const DEFAULT_BUILDER_URLS = [
  "https://relay.flashbots.net",
  "https://rpc.buildernet.org", // BuilderNet — built the boundary blocks we lost
  "https://rpc.beaverbuild.org",
  "https://rpc.titanbuilder.xyz",
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
    port: raw.PORT,
    host: raw.HOST,
    dataDir: raw.DATA_DIR,
    ownedTokensOverride: parseIds(raw.OWNED_TOKENS),
    targetTokensOverride: parseIds(raw.TARGET_TOKENS),
    maxCandidates: raw.MAX_CANDIDATES,
  };
}

export type AppConfig = ReturnType<typeof derive>;
export const appConfig: AppConfig = derive();
