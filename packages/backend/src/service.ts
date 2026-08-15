import type { OwnedTokenStatus } from "@dat-bot/shared";
import { runtime } from "./runtime.js";
import { getGameSnapshot, batchGetOwnedStatuses } from "./contract.js";
import { fetchOwnedTokenIds } from "./index-tokens.js";

// Read-only helpers used by the API for the dashboard (independent of the engine loop).

// The dashboard polls /api/tokens every 20s, and the engine tick reads the same snapshot
// every block. Letting these read a snapshot up to 5s old collapses identical multicalls
// per poll cycle into one, without affecting the engine (which always reads fresh).
const SNAPSHOT_TTL_MS = 5_000;

export async function readOwnedStatuses(): Promise<OwnedTokenStatus[]> {
  if (!runtime.unlocked) return [];
  const snap = await getGameSnapshot(SNAPSHOT_TTL_MS);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // Union across every unlocked wallet, tagged with the one holding each citizen so the
  // dashboard can group them and the user can see which wallet needs funding.
  const per = await Promise.all(
    runtime.wallets.map(async (w) => ({
      w,
      ids: await fetchOwnedTokenIds(snap.citizensAddress, w.account.address as `0x${string}`),
    })),
  );
  const holder = new Map<string, { address: string; label: string }>();
  const ids: bigint[] = [];
  for (const { w, ids: list } of per) {
    for (const id of list) {
      const key = id.toString();
      if (holder.has(key)) continue;
      holder.set(key, { address: w.account.address, label: w.label });
      ids.push(id);
    }
  }
  // ONE multicall for every owned token's status, not a serial per-token round-trip.
  const rows = await batchGetOwnedStatuses(ids, snap.currentEpoch, nowSec, runtime.strategy.prepayEpochs);
  return rows.map((r) => ({
    ...r,
    walletAddress: holder.get(r.tokenId)?.address ?? null,
    walletLabel: holder.get(r.tokenId)?.label ?? null,
  }));
}
