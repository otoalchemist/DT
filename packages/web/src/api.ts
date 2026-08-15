import type {
  BotStatus,
  StrategyConfig,
  ActivityEntry,
  OwnedTokenStatus,
  PostMortemResult,
} from "@dat-bot/shared";

let sessionTokenPromise: Promise<string> | null = null;

export function invalidateSessionToken(): void {
  sessionTokenPromise = null;
}

export function getSessionToken(): Promise<string> {
  if (!sessionTokenPromise) {
    sessionTokenPromise = fetch("/api/session", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json() as { token?: string; error?: string };
        if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body.token;
      })
      .catch((error) => {
        sessionTokenPromise = null;
        throw error;
      });
  }
  return sessionTokenPromise;
}

async function req<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = await getSessionToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-dat-bot-session": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  // A backend restart rotates the per-process token. Refresh it once without making
  // every caller understand session lifecycle.
  if (res.status === 403 && !retried) {
    invalidateSessionToken();
    return req<T>(path, init, true);
  }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  status: () => req<BotStatus>("/api/status"),
  keystore: () =>
    req<{ exists: boolean; address: string | null; wallets: { address: string; label: string }[] }>("/api/keystore"),
  addWallet: (body: { mode: "import" | "generate"; privateKey?: string; passphrase: string; label?: string }) =>
    req<{ address: string; label: string; generated: boolean }>("/api/wallets", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeWallet: (address: string, passphrase: string) =>
    req<{ ok: boolean; remaining: number }>(`/api/wallets/${address}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmAddress: address, passphrase }),
    }),
  createKeystore: (body: { mode: "import" | "generate"; privateKey?: string; passphrase: string }) =>
    req<{ address: string }>("/api/keystore", { method: "POST", body: JSON.stringify(body) }),
  unlock: (passphrase: string) =>
    req<BotStatus>("/api/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }),
  lock: () => req<{ ok: boolean }>("/api/lock", { method: "POST" }),
  getConfig: () => req<StrategyConfig>("/api/config"),
  setConfig: (patch: Partial<StrategyConfig>) =>
    req<StrategyConfig>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
  start: () => req<BotStatus>("/api/start", { method: "POST" }),
  stop: () => req<BotStatus>("/api/stop", { method: "POST" }),
  jit: (body: { enable: boolean; targetEpoch?: number; tokenIds?: string[] }) =>
    req<BotStatus>("/api/jit", { method: "POST", body: JSON.stringify(body) }),
  tokens: () => req<OwnedTokenStatus[]>("/api/tokens"),
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
  refreshChain: () => req<BotStatus>("/api/refresh", { method: "POST" }),
  activity: (limit = 200) => req<ActivityEntry[]>(`/api/activity?limit=${limit}`),
  getSettings: () => req<{ alchemyKeySet: boolean; mode: "mainnet" | "public" }>("/api/settings"),
  saveAlchemyKey: (alchemyApiKey: string) =>
    req<{ ok: boolean }>("/api/settings", { method: "POST", body: JSON.stringify({ alchemyApiKey }) }),
  saveMode: (mode: "mainnet" | "public") =>
    req<{ ok: boolean; mode: string }>("/api/settings", { method: "POST", body: JSON.stringify({ mode }) }),
  postMortem: (ours: string[], rivals: string[]) =>
    req<PostMortemResult>("/api/postmortem", { method: "POST", body: JSON.stringify({ ours, rivals }) }),
};
