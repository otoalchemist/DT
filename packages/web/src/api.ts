import type {
  BotStatus,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  TargetTokenStatus,
  PostMortemResult,
  StrategySnapshot,
} from "@dat-bot/shared";

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
  status: () => req<BotStatus>("/api/status"),
  keystore: () => req<{ exists: boolean; address: string | null }>("/api/keystore"),
  createKeystore: (body: { mode: "import" | "generate"; privateKey?: string; passphrase: string }) =>
    req<{ address: string }>("/api/keystore", { method: "POST", body: JSON.stringify(body) }),
  unlock: (passphrase: string) =>
    req<BotStatus>("/api/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }),
  lock: () => req<{ ok: boolean }>("/api/lock", { method: "POST" }),
  getConfig: () => req<StrategySnapshot>("/api/config"),
  setConfig: (expectedRevision: number, patch: Partial<StrategyConfig>) =>
    req<StrategySnapshot>("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision, patch }),
    }),
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
  saveMode: (mode: "mainnet" | "public") =>
    req<{ ok: boolean; mode: string }>("/api/settings", { method: "POST", body: JSON.stringify({ mode }) }),
  postMortem: (ours: string[], rivals: string[]) =>
    req<PostMortemResult>("/api/postmortem", { method: "POST", body: JSON.stringify({ ours, rivals }) }),
};
