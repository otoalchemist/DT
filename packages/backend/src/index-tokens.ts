import type { Address } from "viem";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

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

/** Enumerate tokenIds of the Citizen collection owned by `owner`. */
export async function fetchOwnedTokenIds(
  citizens: Address,
  owner: Address,
): Promise<bigint[]> {
  if (appConfig.ownedTokensOverride.length > 0) {
    return appConfig.ownedTokensOverride;
  }
  if (!appConfig.nftUrl) return []; // unconfigured: degrade quietly, engine idles
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

/** Enumerate up to `maxCandidates` tokenIds in the Citizen collection. */
export async function fetchCandidateTokenIds(
  citizens: Address,
): Promise<bigint[]> {
  if (appConfig.targetTokensOverride.length > 0) {
    return appConfig.targetTokensOverride;
  }
  const ids: bigint[] = [];
  let pageKey: string | undefined;
  try {
    do {
      const q =
        `/getNFTsForContract?contractAddress=${citizens}` +
        `&withMetadata=false&limit=100` +
        (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
      const data = await alchemyGet<{ nfts: AlchemyNft[]; pageKey?: string }>(q);
      for (const nft of data.nfts) ids.push(BigInt(nft.tokenId));
      pageKey = data.pageKey;
    } while (pageKey && ids.length < appConfig.maxCandidates);
  } catch (err) {
    logger.warn("Candidate enumeration failed:", (err as Error).message);
  }
  return ids.slice(0, appConfig.maxCandidates);
}
