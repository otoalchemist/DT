import type {
  BotStatus,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  TargetTokenStatus,
  PostMortemResult,
  StrategySnapshot,
} from "@dat-bot/shared";
import { VERSION } from "@dat-bot/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AppSettingsStatus {
  alchemyKeySet: boolean;
  rpcConfigured: boolean;
  ownershipConfigured: boolean;
  setupReady: boolean;
  mode: "mainnet" | "public" | "local";
  modeConfiguredByEnvironment: boolean;
  keyConfiguredByEnvironment: boolean;
}

export type BackendCompatibility =
  | { compatible: true; backendVersion: string; status: BotStatus }
  | { compatible: false; backendVersion: string | null; reason: string };

export type BuilderIncentiveCapability =
  | {
      active: true;
      payer: string;
      bidWei: string;
      runtimeCodeHash: string;
    }
  | { active: false; reason: string };

/**
 * `/api/status` is the bootstrap compatibility envelope. Keep this check small
 * and independent from strategy/settings parsing so a stale dashboard never
 * consumes a newer schema (and a newer dashboard never consumes a legacy one).
 */
export function inspectBackendCompatibility(payload: unknown): BackendCompatibility {
  if (!payload || typeof payload !== "object") {
    return {
      compatible: false,
      backendVersion: null,
      reason: "The backend returned an unreadable status document.",
    };
  }

  const status = payload as Record<string, unknown>;
  const backendVersion = typeof status.version === "string" ? status.version : null;
  if (backendVersion !== VERSION) {
    return {
      compatible: false,
      backendVersion,
      reason: backendVersion === null
        ? "The backend does not expose a compatible versioned status schema."
        : `Dashboard v${VERSION} cannot use backend v${backendVersion}.`,
    };
  }

  const schemaCompatible = typeof status.unlocked === "boolean"
    && (status.mode === "mainnet" || status.mode === "public" || status.mode === "local")
    && typeof status.jitEnabled === "boolean"
    && typeof status.jitRevision === "number"
    && Array.isArray(status.jitTokenIds)
    && status.jitTokenIds.every((tokenId) => typeof tokenId === "string")
    && typeof status.strategyRevision === "number"
    && typeof status.pendingExposureWei === "string"
    && typeof status.journalHealthy === "boolean"
    && typeof status.nftConfigured === "boolean";
  if (!schemaCompatible) {
    return {
      compatible: false,
      backendVersion,
      reason: `Backend v${backendVersion} returned an incompatible status schema.`,
    };
  }

  return { compatible: true, backendVersion, status: payload as BotStatus };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status, json.currentRevision);
  return json as T;
}

export const api = {
  compatibility: async () => inspectBackendCompatibility(await req<unknown>("/api/status")),
  status: () => req<BotStatus>("/api/status"),
  keystore: () => req<{ exists: boolean; address: string | null }>("/api/keystore"),
  createKeystore: (body: { mode: "import" | "generate"; privateKey?: string; passphrase: string }) =>
    req<{ address: string }>("/api/keystore", { method: "POST", body: JSON.stringify(body) }),
  unlock: (passphrase: string) =>
    req<BotStatus>("/api/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }),
  lock: () => req<{ ok: boolean }>("/api/lock", { method: "POST" }),
  getConfig: () => req<StrategySnapshot>("/api/config"),
  setConfig: (
    expectedRevision: number,
    patch: Partial<StrategyConfig>,
    acknowledgeCoinbaseBidRisk = false,
  ) =>
    req<StrategySnapshot>("/api/config", {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision,
        patch,
        ...(acknowledgeCoinbaseBidRisk ? { acknowledgeCoinbaseBidRisk: true } : {}),
      }),
    }),
  builderIncentive: () => req<BuilderIncentiveCapability>("/api/builder-incentive"),
  start: () => req<BotStatus>("/api/start", { method: "POST" }),
  stop: () => req<BotStatus>("/api/stop", { method: "POST" }),
  jit: (body: { enable: boolean; expectedRevision: number; targetEpoch?: number; tokenIds?: string[] }) =>
    req<BotStatus>("/api/jit", { method: "POST", body: JSON.stringify(body) }),
  tokens: () => req<OwnedTokenStatus[]>("/api/tokens"),
  targets: () => req<TargetTokenStatus[]>("/api/targets"),
  activity: (limit = 200) => req<ActivityEntry[]>(`/api/activity?limit=${limit}`),
  getSettings: () => req<AppSettingsStatus>("/api/settings"),
  saveAlchemyKey: (alchemyApiKey: string) =>
    req<{ ok: boolean }>("/api/settings", { method: "POST", body: JSON.stringify({ alchemyApiKey }) }),
  saveMode: (mode: "mainnet" | "public", acknowledgeCoinbaseBidRisk = false) =>
    req<{ ok: boolean; mode: "mainnet" | "public" | "local" }>("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        mode,
        ...(acknowledgeCoinbaseBidRisk ? { acknowledgeCoinbaseBidRisk: true } : {}),
      }),
    }),
  postMortem: (ours: string[], rivals: string[]) =>
    req<PostMortemResult>("/api/postmortem", { method: "POST", body: JSON.stringify({ ours, rivals }) }),
};
