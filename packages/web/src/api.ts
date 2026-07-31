import type {
  BotStatus,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  TargetTokenStatus,
  EmigratedTokenStatus,
  PostMortemResult,
  TargetScoresState,
} from "@dat-bot/shared";

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
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
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
  getConfig: () => req<StrategyConfig>("/api/config"),
  defaultRivalTargets: () => req<{ tokenIds: string[] }>("/api/default-rival-targets"),
  rivalSkippers: () => req<{ tokenIds: string[] }>("/api/rival-skippers"),
  setConfig: (patch: Partial<StrategyConfig>) =>
    req<StrategyConfig>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
  start: () => req<BotStatus>("/api/start", { method: "POST" }),
  stop: () => req<BotStatus>("/api/stop", { method: "POST" }),
  jit: (body: { enable: boolean; targetEpoch?: number; tokenIds?: string[] }) =>
    req<BotStatus>("/api/jit", { method: "POST", body: JSON.stringify(body) }),
  tokens: () => req<OwnedTokenStatus[]>("/api/tokens"),
  // On-demand rival scoring. POST starts a background scan; GET polls for the result.
  targetScores: () => req<TargetScoresState>("/api/target-scores"),
  runTargetScores: () => req<TargetScoresState>("/api/target-scores", { method: "POST" }),
  // Manual per-token actions — normal network gas at press time, not the race tips.
  payToken: (tokenId: string) =>
    req<{ ok: boolean; message: string; txHash?: string; valueWei?: string }>("/api/token/pay", {
      method: "POST",
      body: JSON.stringify({ tokenId }),
    }),
  bribeToken: (tokenId: string) =>
    req<{ ok: boolean; message: string; txHash?: string }>("/api/token/bribe", {
      method: "POST",
      body: JSON.stringify({ tokenId }),
    }),
  targets: () => req<TargetTokenStatus[]>("/api/targets"),
  // Full emigration history from the contract's event log — never in `targets`.
  // Includes emigrants already killed (alive: false), so the count doesn't shrink.
  emigrated: () => req<EmigratedTokenStatus[]>("/api/emigrated"),
  activity: (limit = 200) => req<ActivityEntry[]>(`/api/activity?limit=${limit}`),
  getSettings: () => req<{ alchemyKeySet: boolean; mode: "mainnet" | "public" }>("/api/settings"),
  saveAlchemyKey: (alchemyApiKey: string) =>
    req<{ ok: boolean }>("/api/settings", { method: "POST", body: JSON.stringify({ alchemyApiKey }) }),
  saveMode: (mode: "mainnet" | "public") =>
    req<{ ok: boolean; mode: string }>("/api/settings", { method: "POST", body: JSON.stringify({ mode }) }),
  postMortem: (ours: string[], rivals: string[]) =>
    req<PostMortemResult>("/api/postmortem", { method: "POST", body: JSON.stringify({ ours, rivals }) }),
};
