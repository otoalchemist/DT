import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { GAME_CONTRACT_ADDRESS, deathAndTaxesAbi } from "@dat-bot/shared";
import { writeFileAtomicDurableSync } from "./durability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Walk up from packages/backend/src → monorepo root to find .env
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

export const bundledDataDir = path.resolve(__dirname, "../../../data");
const configuredDataDir = path.resolve(process.env.DATA_DIR ?? bundledDataDir);
// UI-saved settings follow DATA_DIR so separately configured bot instances do not
// overwrite one another. The old repository-level path is read once for migration.
const settingsPath = path.join(configuredDataDir, "settings.json");
const legacySettingsPath = path.join(bundledDataDir, "settings.json");
// Capture operator-owned environment authority before persisted settings are
// copied into process.env below. A saved MODE is mutable from the dashboard; an
// explicit MODE in .env/the process is not and must not pretend otherwise.
const modeConfiguredByEnvironment = process.env.MODE !== undefined;
const keyConfiguredByEnvironment = Boolean(process.env.ALCHEMY_API_KEY?.trim());
const appSettingsSchema = z.object({
  alchemyApiKey: z.string().trim().min(10).optional(),
  mode: z.enum(["mainnet", "public"]).optional(),
}).strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomicDurableSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function secureSettingsOpenFlags(): number {
  const noFollow = process.platform === "win32"
    ? 0
    : (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  return fs.constants.O_RDONLY | noFollow;
}

/** Settings may contain an Alchemy credential. Older releases created these
 * files without an explicit mode, so tighten every retained copy. Descriptor-
 * based fstat/fchmod avoids following a swapped path between checking and
 * securing it; O_NOFOLLOW rejects symlinks on platforms that provide it. */
function hardenSettingsPermissions(filePath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, secureSettingsOpenFlags());
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("settings path is not a regular file");
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Could not secure settings permissions for ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`, { cause: error });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readSettings(filePath: string): AppSettings | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, secureSettingsOpenFlags());
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("settings path is not a regular file");
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
    return appSettingsSchema.parse(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not load settings from ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`, { cause: error });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function loadSettingsFromPaths(
  currentPath: string,
  legacyPath: string,
): AppSettings {
  const backupPath = path.join(path.dirname(currentPath), "settings.legacy.json");
  // Secure all copies even when the current file lets us return immediately.
  // A prior migration deliberately retains the repository-level source and an
  // explicit backup for other instances/operator recovery.
  for (const candidate of new Set([
    currentPath,
    ...(currentPath === legacyPath ? [] : [legacyPath, backupPath]),
  ])) hardenSettingsPermissions(candidate);
  const current = readSettings(currentPath);
  if (current) return current;
  if (currentPath !== legacyPath) {
    const legacy = readSettings(legacyPath);
    if (legacy) {
      // Copy rather than remove: another legacy/default instance may still use it.
      if (!fs.existsSync(backupPath)) writeJsonAtomic(backupPath, legacy);
      writeJsonAtomic(currentPath, legacy);
      return legacy;
    }
  }
  return {};
}

export function loadSettings(): AppSettings {
  return loadSettingsFromPaths(settingsPath, legacySettingsPath);
}

export function saveSettings(s: AppSettings): void {
  writeJsonAtomic(settingsPath, s);
}

// Inject settings into process.env before schema parse (env vars take priority).
const savedSettings = loadSettings();
if (savedSettings.alchemyApiKey && !process.env.ALCHEMY_API_KEY) {
  process.env.ALCHEMY_API_KEY = savedSettings.alchemyApiKey;
}
if (savedSettings.mode && !process.env.MODE) {
  process.env.MODE = savedSettings.mode;
}

export const API_LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;
const apiLoopbackHosts = new Set<string>(API_LOOPBACK_HOSTS);

/** The wallet-control API is intentionally local-only. Keep this validation at
 * configuration load so an unsafe bind fails before Fastify starts listening. */
export const apiBindSchema = z.object({
  HOST: z.string()
    .trim()
    .transform((host) => host.toLowerCase())
    .refine((host) => apiLoopbackHosts.has(host), {
      message: "HOST must be loopback-only for this release (127.0.0.1, localhost, or ::1)",
    })
    .default("127.0.0.1"),
  API_ALLOWED_HOSTS: z.string().optional().refine(
    (hosts) => hosts === undefined || hosts.trim() === "",
    "API_ALLOWED_HOSTS is no longer supported; remove it because the API is loopback-only",
  ),
});

const schema = z.object({
  ...apiBindSchema.shape,
  /** "mainnet" (default) submits private bundles to the builders in BUILDER_URLS;
   *  payments also mirror to the public mempool for independent inclusion
   *  coverage. Builders choose placement based on profitability and other
   *  orderflow, so neither route guarantees ordering or inclusion. "public"
   *  broadcasts only to the mempool.
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
  DATA_DIR: z.string().default(bundledDataDir),
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

/** Validate a candidate RPC without mutating the active clients or persisted
 * settings. `fetchImpl` is injectable so tests never need live network access. */
export async function validateMainnetRpcCandidate(
  candidate: { httpUrl: string; nftUrl: string; gameAddress: `0x${string}` },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const rpc = async (id: number, method: string, params: unknown[]) => {
      const response = await fetchImpl(candidate.httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? `RPC rejected ${method}`);
      return payload.result;
    };
    const currentEpochData = encodeFunctionData({
      abi: deathAndTaxesAbi,
      functionName: "currentEpoch",
    });
    const stateData = encodeFunctionData({ abi: deathAndTaxesAbi, functionName: "state" });
    const citizensData = encodeFunctionData({ abi: deathAndTaxesAbi, functionName: "citizens" });
    const [chainId, blockNumber, currentEpoch, gameState, citizensResult] = await Promise.all([
      rpc(1, "eth_chainId", []),
      rpc(2, "eth_blockNumber", []),
      rpc(3, "eth_call", [{ to: candidate.gameAddress, data: currentEpochData }, "latest"]),
      rpc(4, "eth_call", [{ to: candidate.gameAddress, data: stateData }, "latest"]),
      rpc(5, "eth_call", [{ to: candidate.gameAddress, data: citizensData }, "latest"]),
    ]);
    if (typeof chainId !== "string" || BigInt(chainId) !== 1n) {
      throw new Error(`Expected Ethereum mainnet chainId 1, received ${String(chainId)}`);
    }
    if (typeof blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(blockNumber)) {
      throw new Error("RPC did not return a latest block number");
    }
    if (typeof currentEpoch !== "string" || !/^0x[0-9a-f]{64}$/i.test(currentEpoch)) {
      throw new Error("Game contract currentEpoch call returned invalid data");
    }
    if (typeof gameState !== "string" || !/^0x[0-9a-f]{64}$/i.test(gameState)) {
      throw new Error("Game contract state call returned invalid data");
    }
    if (typeof citizensResult !== "string" || !/^0x[0-9a-f]{64}$/i.test(citizensResult)) {
      throw new Error("Game contract citizens call returned invalid data");
    }
    const citizensAddress = decodeFunctionResult({
      abi: deathAndTaxesAbi,
      functionName: "citizens",
      data: citizensResult as `0x${string}`,
    });

    const nftUrl = new URL(`${candidate.nftUrl.replace(/\/$/, "")}/getNFTsForOwner`);
    nftUrl.searchParams.set("owner", "0x000000000000000000000000000000000000dEaD");
    // Alchemy rejects unfiltered ownership enumeration for burn addresses. The
    // live collection read also proves that this API key can enumerate the
    // exact Citizens collection the bot will use after wallet unlock.
    nftUrl.searchParams.append("contractAddresses[]", citizensAddress);
    nftUrl.searchParams.set("withMetadata", "false");
    nftUrl.searchParams.set("pageSize", "1");
    const nftResponse = await fetchImpl(nftUrl, { signal: controller.signal });
    if (!nftResponse.ok) {
      let detail = "";
      try {
        detail = (await nftResponse.text()).replace(/\s+/g, " ").trim().slice(0, 300);
      } catch {
        // The HTTP status remains actionable even when the provider body cannot
        // be read. Candidate-key redaction is applied at the API boundary.
      }
      throw new Error(
        `NFT endpoint returned HTTP ${nftResponse.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const nftPayload = await nftResponse.json() as { ownedNfts?: unknown };
    if (!nftPayload || typeof nftPayload !== "object" || !Array.isArray(nftPayload.ownedNfts)) {
      throw new Error("NFT endpoint returned invalid JSON");
    }
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

// Well-known builders that accept `eth_sendBundle` with an X-Flashbots-Signature
// header. A bundle can only be included by the builder that WINS the slot, so we
// fan out to all of them. Endpoints do change — override with BUILDER_URLS.
// Unreachable entries are tolerated: submission succeeds if ANY builder accepts.
// NOTE: rpc.buildernet.org currently documents a 3-connection/10s limit and a
// 100-request/10s HTTP limit per client. Each private batch sends two requests
// there (one per target block), so back-to-back cohorts can still contend for
// connection slots; other builders and the public payment route continue independently.
// (rsync-builder.xyz was dropped — verified unreachable as of 2026-07; add it back
// via BUILDER_URLS if it returns.)
const DEFAULT_BUILDER_URLS = [
  "https://relay.flashbots.net",
  "https://rpc.buildernet.org", // BuilderNet — built the boundary blocks we lost
  "https://rpc.beaverbuild.org",
  "https://rpc.titanbuilder.xyz",
];

function derive() {
  // Vitest sets MODE=test for the process it owns. That is a test-runner
  // sentinel, not one of the bot's transport modes, so keep tests on the
  // local/non-broadcasting path unless a real mode was supplied.
  const source = process.env.VITEST === "true" && process.env.MODE === "test"
    ? { ...process.env, MODE: "local" }
    : process.env;
  const raw = schema.parse(source);
  const key = raw.ALCHEMY_API_KEY;

  const httpUrl = raw.RPC_HTTP_URL ?? (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
  // An explicit HTTP endpoint identifies a separately managed RPC environment.
  // Do not silently pair it with an Alchemy mainnet websocket: in local mode
  // that would make block notifications come from a different chain.
  const wsUrl = raw.RPC_WS_URL
    ?? (!raw.RPC_HTTP_URL && key ? `wss://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
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
    dataDir: path.resolve(raw.DATA_DIR),
    ownedTokensOverride: parseIds(raw.OWNED_TOKENS),
    targetTokensOverride: parseIds(raw.TARGET_TOKENS),
    maxCandidates: raw.MAX_CANDIDATES,
    endpointOverrides: {
      http: raw.RPC_HTTP_URL !== undefined,
      ws: raw.RPC_WS_URL !== undefined,
      nft: raw.ALCHEMY_NFT_URL !== undefined,
    },
    modeConfiguredByEnvironment,
    keyConfiguredByEnvironment,
  };
}

export type AppConfig = ReturnType<typeof derive>;
export const appConfig: AppConfig = derive();
