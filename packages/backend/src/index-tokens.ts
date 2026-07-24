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
  return (
    !!appConfig.nftUrl ||
    appConfig.ownedTokensOverride.length > 0 ||
    appConfig.targetTokensOverride.length > 0
  );
}

// Ownership changes rarely; the candidate set (mints/kills) even more rarely.
// Cache both so the Alchemy NFT API stays off the hot path of the boundary tick —
// the cached list is served instantly and refreshed in the background once stale.
const OWNED_TTL_MS = 30_000;
const CANDIDATES_TTL_MS = 5 * 60_000;
const ownedCache = makeIdCache<bigint[]>({
  onError: (e) => logger.warn("Owned-token refresh failed:", (e as Error).message),
});
const candidateCache = makeIdCache<bigint[]>({
  onError: (e) => logger.warn("Candidate enumeration failed:", (e as Error).message),
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

async function fetchCandidatesFromApi(citizens: Address): Promise<bigint[]> {
  const ids: bigint[] = [];
  let pageKey: string | undefined;
  do {
    const q =
      `/getNFTsForContract?contractAddress=${citizens}` +
      `&withMetadata=false&limit=100` +
      (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
    const data = await alchemyGet<{ nfts: AlchemyNft[]; pageKey?: string }>(q);
    for (const nft of data.nfts) ids.push(BigInt(nft.tokenId));
    pageKey = data.pageKey;
  } while (pageKey && ids.length < appConfig.maxCandidates);
  return ids.slice(0, appConfig.maxCandidates);
}

interface AlchemyOwnerEntry {
  ownerAddress: string;
  tokenBalances: { tokenId: string }[];
}

/**
 * Live citizen tokens with their current owners, via Alchemy's owner index
 * (getOwnersForContract). This index is keyed on CURRENT ownership, so it already
 * excludes burned/killed tokens — the exact live set, in ~1 page (~105 tokens here),
 * with no separate ownerOf sweep. Far cheaper than getNFTsForContract, which returns
 * the whole minted range (thousands, ~99% burned) and then needs an ownerOf pass.
 * Returns [] when the NFT API isn't configured so the caller can fall back to the
 * enumerate-then-liveness path (local/anvil overrides).
 */
export async function fetchLiveCitizens(
  citizens: Address,
): Promise<{ id: bigint; owner: Address }[]> {
  if (!appConfig.nftUrl) return [];
  const out: { id: bigint; owner: Address }[] = [];
  let pageKey: string | undefined;
  do {
    const q =
      `/getOwnersForContract?contractAddress=${citizens}&withTokenBalances=true` +
      (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
    const data = await alchemyGet<{ owners: AlchemyOwnerEntry[]; pageKey?: string }>(q);
    for (const o of data.owners) {
      for (const b of o.tokenBalances ?? []) {
        out.push({ id: BigInt(b.tokenId), owner: o.ownerAddress as Address });
      }
    }
    pageKey = data.pageKey;
  } while (pageKey && out.length < appConfig.maxCandidates);
  return out.slice(0, appConfig.maxCandidates);
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

/** Enumerate up to `maxCandidates` tokenIds in the Citizen collection (cached). */
export async function fetchCandidateTokenIds(
  citizens: Address,
): Promise<bigint[]> {
  if (appConfig.targetTokensOverride.length > 0) {
    return appConfig.targetTokensOverride;
  }
  // Preserve the old "never throw" contract: a cold-miss error degrades to [].
  return candidateCache(citizens.toLowerCase(), CANDIDATES_TTL_MS, () =>
    fetchCandidatesFromApi(citizens),
  ).catch(() => []);
}
