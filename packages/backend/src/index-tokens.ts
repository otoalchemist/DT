import type { Address } from "viem";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { makeIdCache } from "./id-cache.js";

// Ownership indexing via the Alchemy NFT API against the Citizen collection.
// Falls back to config overrides (useful for local/anvil testing).

interface AlchemyNft {
  tokenId: string;
}

async function alchemyGet<T>(pathAndQuery: string): Promise<T> {
  if (!appConfig.nftUrl) {
    throw new Error("Alchemy NFT API not configured (set ALCHEMY_API_KEY)");
  }
  const url = `${appConfig.nftUrl}${pathAndQuery}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Alchemy NFT API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** True when we can enumerate ownership (NFT API configured or overrides set). */
export function ownershipIndexingAvailable(): boolean {
  return !!appConfig.nftUrl || appConfig.ownedTokensOverride.length > 0;
}

// Ownership changes rarely. Cache so the Alchemy NFT API stays off the hot path of
// the boundary tick — the cached list is served instantly and refreshed in the
// background once stale.
const OWNED_TTL_MS = 30_000;
const ownedCache = makeIdCache<bigint[]>({
  onError: (e) => logger.warn("Owned-token refresh failed:", (e as Error).message),
});

async function fetchOwnedFromApi(citizens: Address, owner: Address): Promise<bigint[]> {
  const ids: bigint[] = [];
  let pageKey: string | undefined;
  do {
    const q =
      `/getNFTsForOwner?owner=${owner}` +
      `&contractAddresses[]=${citizens}&withMetadata=false&pageSize=100` +
      (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
    const data = await alchemyGet<{ ownedNfts: AlchemyNft[]; pageKey?: string }>(q);
    for (const nft of data.ownedNfts) ids.push(BigInt(nft.tokenId));
    pageKey = data.pageKey;
  } while (pageKey && ids.length < appConfig.maxCandidates);
  return ids.slice(0, appConfig.maxCandidates);
}

/** Enumerate tokenIds of the Citizen collection owned by `owner` (cached). */
export async function fetchOwnedTokenIds(
  citizens: Address,
  owner: Address,
): Promise<bigint[]> {
  if (appConfig.ownedTokensOverride.length > 0) {
    return appConfig.ownedTokensOverride;
  }
  if (!appConfig.nftUrl) return []; // unconfigured: degrade quietly, engine idles
  const key = `${owner.toLowerCase()}:${citizens.toLowerCase()}`;
  return ownedCache(key, OWNED_TTL_MS, () => fetchOwnedFromApi(citizens, owner));
}

/** Drop cached ownership so the next read hits the API. Used by the dashboard's
 *  manual "Refresh data" — otherwise SWR would serve the same stale set. */
export function invalidateTokenCaches(): void {
  ownedCache.invalidate();
}
