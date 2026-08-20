import type {
  BotStatus,
  TreasuryLedger,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  TargetTokenStatus,
  EmigratedTokenStatus,
  PostMortemResult,
  TargetScoresState,
  BigBoyStatus,
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
  keystore: () =>
    req<{ exists: boolean; address: string | null; wallets: { address: string; label: string }[] }>("/api/keystore"),
  // Extra hot wallets. Citizens can only be acted on by the wallet that owns them, so
  // each wallet needs its own key here. All share one passphrase.
  addWallet: (body: { mode: "import" | "generate"; privateKey?: string; passphrase: string; label?: string }) =>
    req<{ address: string; label: string; generated: boolean }>("/api/wallets", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeWallet: (address: string) =>
    req<{ ok: boolean; remaining: number }>(`/api/wallets/${address}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmAddress: address }),
    }),
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
  allies: () => req<TargetTokenStatus[]>("/api/allies"),
  // The big boys (data/big-boys.json), each tagged with the operator who runs it. They are
  // ordinary targets — the roster is for grouping and attribution.
  bigBoys: () => req<BigBoyStatus[]>("/api/big-boys"),
  // Force-refresh chain state: re-reads snapshot/balance/block into runtime (which
  // otherwise only updates inside an engine tick, so it never moves in away mode) and
  // drops the ownership caches so follow-up GETs refetch instead of serving SWR-stale.
  refreshChain: () => req<BotStatus>("/api/refresh", { method: "POST" }),
  // Re-pull the curated default lists (rivals, skippers, allies, big boys) from the
  // repo's master branch. The bot does this at startup; this is the no-restart path, for
  // when a list changes mid-session. `repointed` is true when the offense pins were moved
  // onto a refreshed skippers list (only happens if they were tracking the default).
  refreshLists: () =>
    req<{
      outcomes: { file: string; result: "updated" | "unchanged" | "local-edit" | "failed"; ids?: number; reason?: string }[];
      repointed: boolean;
    }>("/api/refresh-lists", { method: "POST" }),
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

  treasury: () => req<TreasuryLedger>("/api/treasury"),
  treasuryKeys: () => req<Record<string, string>>("/api/treasury/keys"),
  treasuryRefresh: () =>
    req<{ added: number; scannedTo: number; ledger: TreasuryLedger }>("/api/treasury/refresh", {
      method: "POST",
    }),
  treasuryParticipant: (body: {
    address: string;
    nickname?: string | null;
    optIn?: boolean;
    citizensOverride?: number | null;
    linked?: string[];
    remove?: boolean;
  }) => req<TreasuryLedger>("/api/treasury/participant", { method: "POST", body: JSON.stringify(body) }),
  treasuryMovement: (body: { key: string; excluded?: boolean; note?: string }) =>
    req<TreasuryLedger>("/api/treasury/movement", { method: "POST", body: JSON.stringify(body) }),
};
