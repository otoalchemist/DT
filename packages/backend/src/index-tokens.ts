import type { Address } from "viem";
import { citizensAbi } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { publicClient } from "./chain.js";
import { logger } from "./logger.js";
import { makeIdCache } from "./id-cache.js";

// Ownership indexing via the Alchemy NFT API against the Citizen collection.
// Falls back to config overrides (useful for local/anvil testing).

interface AlchemyNft {
  tokenId: string;
}

const NFT_REQUEST_TIMEOUT_MS = 10_000;
const NFT_OPERATION_TIMEOUT_MS = 30_000;

async function alchemyGet<T>(pathAndQuery: string, deadlineMs: number): Promise<T> {
  if (!appConfig.nftUrl) {
    throw new Error("Alchemy NFT API not configured (set ALCHEMY_API_KEY)");
  }
  const url = `${appConfig.nftUrl}${pathAndQuery}`;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("Alchemy NFT operation timed out");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(NFT_REQUEST_TIMEOUT_MS, remainingMs),
  );
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Alchemy NFT API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Alchemy NFT request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  const deadlineMs = Date.now() + NFT_OPERATION_TIMEOUT_MS;
  let pageKey: string | undefined;
  do {
    const q =
      `/getNFTsForOwner?owner=${owner}` +
      `&contractAddresses[]=${citizens}&withMetadata=false&pageSize=100` +
      (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
    const data = await alchemyGet<{ ownedNfts: AlchemyNft[]; pageKey?: string }>(q, deadlineMs);
    for (const nft of data.ownedNfts) ids.push(BigInt(nft.tokenId));
    pageKey = data.pageKey;
  } while (pageKey);
  // Survival scope must never inherit the rival-search cap. Return every page;
  // the authoritative ownerOf filter below still rejects stale index entries.
  return ids;
}

async function fetchCandidatesFromApi(citizens: Address): Promise<bigint[]> {
  const ids: bigint[] = [];
  const deadlineMs = Date.now() + NFT_OPERATION_TIMEOUT_MS;
  let pageKey: string | undefined;
  do {
    const q =
      `/getNFTsForContract?contractAddress=${citizens}` +
      `&withMetadata=false&limit=100` +
      (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
    const data = await alchemyGet<{ nfts: AlchemyNft[]; pageKey?: string }>(q, deadlineMs);
    for (const nft of data.nfts) ids.push(BigInt(nft.tokenId));
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

/** Filter cached/indexed ownership through authoritative on-chain ownerOf reads.
 * Indexers can lag transfers for the full cache TTL; no spending path may trust
 * that stale list when selecting a Citizen to pay for or act from. */
export async function filterOwnedTokenIds(
  citizens: Address,
  tokenIds: readonly bigint[],
  owner: Address,
): Promise<bigint[]> {
  const unique = [...new Map(tokenIds.map((tokenId) => [tokenId.toString(), tokenId])).values()];
  const owned: bigint[] = [];
  const normalizedOwner = owner.toLowerCase();
  const batchSize = 500;
  for (let start = 0; start < unique.length; start += batchSize) {
    const chunk = unique.slice(start, start + batchSize);
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: chunk.map((tokenId) => ({
        address: citizens,
        abi: citizensAbi,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      })),
    });
    for (let i = 0; i < chunk.length; i++) {
      const result = results[i];
      if (
        result?.status === "success"
        && typeof result.result === "string"
        && result.result.toLowerCase() === normalizedOwner
      ) {
        owned.push(chunk[i]!);
      }
    }
  }
  return owned;
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
