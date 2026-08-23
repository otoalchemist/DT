import type { Address } from "viem";
import { EPOCH_DURATION_SECONDS, WINNERS, type TreasuryEpochRow, type TreasuryState } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { gameContract, getGameSnapshot } from "./contract.js";
import { logger } from "./logger.js";

/**
 * Where the tax actually goes, and how much of the eventual prize pool each epoch added.
 *
 * WHY BALANCE DELTAS AND NOT TRANSFER LOGS
 *
 * The obvious route is `alchemy_getAssetTransfers` against the treasury. This does not use it,
 * for two reasons. It is provider-specific, so anyone on a non-Alchemy RPC would get an empty
 * panel rather than a number; and it returns `value` as a JSON float, which loses precision on
 * a balance already past 1,000 ETH. Reading the balance at two blocks is exact in wei, costs
 * two calls instead of paging ~500 transfers, and works on every RPC.
 *
 * Cross-checked against the transfer route over epochs 163-173: every epoch agreed to within
 * 4e-6 ETH, and that residue is the float error in the transfer API, not in this.
 *
 * The one thing a delta cannot see is money flowing OUT, which would net against inflow and
 * understate what was collected. Measured over that same window the treasury made ZERO
 * outbound transfers; and for this panel's question the net figure is the right one anyway,
 * because the pool is worth what the balance says it is.
 *
 * THE OFF-BY-ONE THAT MAKES THIS SUBTLE
 *
 * Balances are read at `boundaryBlock - 1`, not at the boundary block. Tax paid IN the
 * boundary block pays for the epoch that is BEGINNING, and most of an epoch's revenue lands
 * exactly there since the whole boundary race is people paying in that one block. Measuring
 * at the boundary block itself credits all of it to the epoch that just ended, which showed
 * up as the live epoch reporting 0.00000 ETH while its boundary block had just collected over
 * an ETH. Reading one block earlier attributes it to the epoch it actually paid for.
 */

/** The two payees, read once from the contract - they cannot change without a redeploy. */
let cachedPayees: { treasury: Address; project: Address } | null = null;
async function resolvePayees(): Promise<{ treasury: Address; project: Address }> {
  if (cachedPayees) return cachedPayees;
  const [treasury, project] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...gameContract, functionName: "treasury" },
      { ...gameContract, functionName: "project" },
    ],
  });
  cachedPayees = { treasury: treasury as Address, project: project as Address };
  return cachedPayees;
}

/**
 * First block whose timestamp is at or after `targetTs`.
 *
 * Interpolated rather than bisected. Blocks sit ~12s apart and regularly enough that dividing
 * the time gap by 12 lands within a few blocks, so this converges in ~3-4 reads where a
 * bisection over a day of blocks takes ~17. That matters because a cold load resolves eleven
 * boundaries at once.
 */
const SLOT_SECONDS = 12n;
async function firstBlockAtOrAfter(targetTs: bigint, hint: bigint): Promise<bigint> {
  const tsOf = async (n: bigint): Promise<bigint> =>
    BigInt((await publicClient.getBlock({ blockNumber: n })).timestamp);

  let probe = hint;
  let ts = await tsOf(probe);
  // Converge on the neighbourhood. Iteration-capped so irregular spacing cannot spin here.
  for (let i = 0; i < 12; i++) {
    const drift = (ts - targetTs) / SLOT_SECONDS;
    if (drift === 0n) break;
    const next = probe - drift;
    if (next < 1n || next === probe) break;
    probe = next;
    ts = await tsOf(probe);
  }
  // Walk to the exact edge. Only a few steps after interpolation, and it is the walk rather
  // than the estimate that makes the answer exact.
  if (ts < targetTs) {
    while (ts < targetTs) {
      probe += 1n;
      ts = await tsOf(probe);
    }
    return probe;
  }
  while (probe > 1n) {
    const prev = await tsOf(probe - 1n);
    if (prev < targetTs) break;
    probe -= 1n;
  }
  return probe;
}

/** Boundary blocks never move once found, and neither do historical balances. */
const boundaryBlocks = new Map<string, bigint>();
const balancesAt = new Map<string, { treasury: bigint; project: bigint }>();

async function balancesAtBlock(
  block: bigint,
  payees: { treasury: Address; project: Address },
): Promise<{ treasury: bigint; project: bigint }> {
  const key = block.toString();
  const hit = balancesAt.get(key);
  if (hit) return hit;
  const [treasury, project] = await Promise.all([
    publicClient.getBalance({ address: payees.treasury, blockNumber: block }),
    publicClient.getBalance({ address: payees.project, blockNumber: block }),
  ]);
  const v = { treasury, project };
  balancesAt.set(key, v);
  return v;
}

let cached: { at: number; state: TreasuryState } | null = null;
const TTL_MS = 60_000;

/** Drop every cache, so the next read hits the chain. Used by the manual refresh. */
export function invalidateTreasuryCache(): void {
  boundaryBlocks.clear();
  balancesAt.clear();
  cached = null;
}

/**
 * The last `epochs` epochs of prize-pool growth, oldest first, ending with the one in progress.
 *
 * Never throws: this panel is informational and must not be the reason a dashboard poll fails,
 * so a bad RPC surfaces as `error` on an otherwise empty state.
 */
export async function getTreasuryHistory(epochs = 10): Promise<TreasuryState> {
  if (cached && Date.now() - cached.at <= TTL_MS) return cached.state;
  try {
    const [payees, snap, head] = await Promise.all([
      resolvePayees(),
      getGameSnapshot(30_000),
      publicClient.getBlockNumber(),
    ]);
    const current = snap.currentEpoch;
    const first = current - BigInt(epochs) > 1n ? current - BigInt(epochs) : 1n;

    // Resolve boundaries newest first, so each search starts from a block already known to be
    // past it - the hint that keeps interpolation at a few reads per boundary.
    let hint = head;
    for (let e = current; e >= first; e--) {
      const key = e.toString();
      if (!boundaryBlocks.has(key)) {
        // Epoch N begins at startTime + (N-1) * EPOCH.
        const ts = snap.startTime + (e - 1n) * EPOCH_DURATION_SECONDS;
        boundaryBlocks.set(key, await firstBlockAtOrAfter(ts, hint));
      }
      hint = boundaryBlocks.get(key) ?? hint;
    }

    const rows: TreasuryEpochRow[] = [];
    for (let e = first; e <= current; e++) {
      const start = boundaryBlocks.get(e.toString());
      if (start === undefined) continue;
      const live = e === current;
      const nextStart = boundaryBlocks.get((e + 1n).toString());
      const from = await balancesAtBlock(start - 1n, payees);
      const to = live
        ? {
            treasury: await publicClient.getBalance({ address: payees.treasury }),
            project: await publicClient.getBalance({ address: payees.project }),
          }
        : await balancesAtBlock((nextStart ?? head + 1n) - 1n, payees);
      rows.push({
        epoch: Number(e),
        boundaryBlock: start.toString(),
        treasuryWei: (to.treasury - from.treasury).toString(),
        projectWei: (to.project - from.project).toString(),
        live,
      });
    }

    const [treasuryTotal, projectTotal] = await Promise.all([
      publicClient.getBalance({ address: payees.treasury }),
      publicClient.getBalance({ address: payees.project }),
    ]);
    const state: TreasuryState = {
      treasuryAddress: payees.treasury,
      projectAddress: payees.project,
      treasuryTotalWei: treasuryTotal.toString(),
      projectTotalWei: projectTotal.toString(),
      winners: Number(WINNERS),
      rows,
      computedAt: Date.now(),
      error: null,
    };
    cached = { at: Date.now(), state };
    return state;
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn("treasury history failed:", msg);
    return {
      treasuryAddress: "",
      projectAddress: "",
      treasuryTotalWei: "0",
      projectTotalWei: "0",
      winners: Number(WINNERS),
      rows: [],
      computedAt: Date.now(),
      error: msg,
    };
  }
}
