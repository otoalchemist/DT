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
  /** "mainnet" uses Flashbots; "public" broadcasts directly to mainnet mempool (faster, no frontrun protection); "local" targets an anvil fork. */
  MODE: z.enum(["mainnet", "public", "local"]).default("public"),
  /** If set, HTTP/WS/NFT endpoints are derived from it unless explicitly overridden. */
  ALCHEMY_API_KEY: z.string().optional(),
  RPC_HTTP_URL: z.string().url().optional(),
  RPC_WS_URL: z.string().url().optional(),
  ALCHEMY_NFT_URL: z.string().url().optional(),
  GAME_ADDRESS: z.string().default(GAME_CONTRACT_ADDRESS),
  FLASHBOTS_RELAY_URL: z.string().url().default("https://relay.flashbots.net"),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default(path.resolve(__dirname, "../../../data")),
  LOG_LEVEL: z.string().optional(),
  /** Comma-separated tokenId overrides for local/anvil testing (no NFT API). */
  OWNED_TOKENS: z.string().optional(),
  TARGET_TOKENS: z.string().optional(),
  /** Max citizen tokens to enumerate as audit/kill candidates per sweep. */
  MAX_CANDIDATES: z.coerce.number().default(500),
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
