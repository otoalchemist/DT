import { encodeFunctionData, type Address } from "viem";
import {
  deathAndTaxesAbi,
  citizensAbi,
  EPOCH_DURATION_SECONDS,
  type OwnedTokenStatus,
  type TargetTokenStatus,
} from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";
import { classifyRisk, isAuditable, isKillable } from "./logic.js";

const game = { address: appConfig.gameAddress, abi: deathAndTaxesAbi } as const;

export interface GameSnapshot {
  state: number;
  currentEpoch: bigint;
  startTime: bigint;
  citizensAddress: Address;
  citizenSupply: bigint;
}

let cachedCitizens: Address | null = null;

export async function resolveCitizensAddress(): Promise<Address> {
  if (cachedCitizens) return cachedCitizens;
  const addr = (await publicClient.readContract({
    ...game,
    functionName: "citizens",
  })) as Address;
  cachedCitizens = addr;
  return addr;
}

export async function getGameSnapshot(): Promise<GameSnapshot> {
  const citizensAddress = await resolveCitizensAddress();
  const [state, currentEpoch, startTime, citizenSupply] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...game, functionName: "state" },
        { ...game, functionName: "currentEpoch" },
        { ...game, functionName: "startTime" },
        {
          address: citizensAddress,
          abi: citizensAbi,
          functionName: "totalSupply",
        },
      ],
    });
  return {
    state: Number(state),
    currentEpoch: currentEpoch as bigint,
    startTime: startTime as bigint,
    citizensAddress,
    citizenSupply: citizenSupply as bigint,
  };
}

/** Full status for a token the wallet owns. */
export async function getOwnedTokenStatus(
  tokenId: bigint,
  currentEpoch: bigint,
  nowSec: bigint,
  prepayEpochs = 1,
): Promise<OwnedTokenStatus> {
  const [lastEpochPaid, auditDue, bribeBalance, hasLifeInsurance, estimate] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...game, functionName: "lastEpochPaid", args: [tokenId] },
        { ...game, functionName: "auditDueTimestamp", args: [tokenId] },
        { ...game, functionName: "bribeBalance", args: [tokenId] },
        { ...game, functionName: "hasLifeInsurance", args: [tokenId] },
        {
          ...game,
          functionName: "estimateTaxesToPay",
          args: [tokenId, prepayEpochs],
        },
      ],
    });
  const { risk, secondsUntilKillable } = classifyRisk(
    lastEpochPaid as bigint,
    currentEpoch,
    auditDue as bigint,
    nowSec,
  );
  return {
    tokenId: tokenId.toString(),
    lastEpochPaid: (lastEpochPaid as bigint).toString(),
    currentEpoch: currentEpoch.toString(),
    auditDueTimestamp: (auditDue as bigint).toString(),
    secondsUntilKillable,
    bribeBalance: (bribeBalance as bigint).toString(),
    hasLifeInsurance: hasLifeInsurance as boolean,
    risk,
    estimatedPayWei: (estimate as bigint).toString(),
  };
}

/** Lightweight status for a rival token (audit/kill candidate). */
export async function getTargetStatus(
  tokenId: bigint,
  owner: Address,
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<TargetTokenStatus> {
  const [lastEpochPaid, auditDue] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...game, functionName: "lastEpochPaid", args: [tokenId] },
      { ...game, functionName: "auditDueTimestamp", args: [tokenId] },
    ],
  });
  const due = auditDue as bigint;
  const lep = lastEpochPaid as bigint;
  const auditable = due === 0n && isAuditable(lep, currentEpoch);
  const killable = isKillable(due, nowSec);
  const delinquent = lep < currentEpoch;
  const epochsBehind = delinquent ? Number(currentEpoch - lep) : 0;
  return {
    tokenId: tokenId.toString(),
    owner,
    lastEpochPaid: lep.toString(),
    delinquent,
    epochsBehind,
    auditable,
    auditDueTimestamp: due.toString(),
    killable,
  };
}

/**
 * Fetch lastEpochPaid + auditDueTimestamp for a batch of tokens in ONE multicall,
 * then classify each result in memory. Much faster than calling getTargetStatus()
 * in a serial loop when there are hundreds of candidates.
 */
export async function batchGetTargetStatuses(
  tokens: { id: bigint; owner: Address }[],
  currentEpoch: bigint,
  nowSec: bigint,
): Promise<TargetTokenStatus[]> {
  if (tokens.length === 0) return [];

  // Build a flat contract call list: [lep(0), adt(0), lep(1), adt(1), ...]
  const contracts = tokens.flatMap(({ id }) => [
    { ...game, functionName: "lastEpochPaid" as const, args: [id] as const },
    { ...game, functionName: "auditDueTimestamp" as const, args: [id] as const },
  ]);

  const results = await publicClient.multicall({ allowFailure: true, contracts });

  const out: TargetTokenStatus[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const lepResult = results[i * 2];
    const adtResult = results[i * 2 + 1];
    if (!lepResult || !adtResult) continue;
    if (lepResult.status === "failure" || adtResult.status === "failure") continue;

    const lep = lepResult.result as bigint;
    const due = adtResult.result as bigint;
    const { id, owner } = tokens[i]!;
    const auditable = due === 0n && isAuditable(lep, currentEpoch);
    const killable = isKillable(due, nowSec);
    const delinquent = lep < currentEpoch;
    const epochsBehind = delinquent ? Number(currentEpoch - lep) : 0;
    out.push({
      tokenId: id.toString(),
      owner,
      lastEpochPaid: lep.toString(),
      delinquent,
      epochsBehind,
      auditable,
      auditDueTimestamp: due.toString(),
      killable,
    });
  }
  return out;
}

/**
 * Full status for many owned tokens in ONE multicall, instead of a serial
 * getOwnedTokenStatus per token (N RPC round-trips). Used by the defense/proactive/
 * JIT sweeps, which each iterate every owned token every tick. Preserves input
 * order; a token whose reads fail is omitted (its status can't be classified).
 */
export async function batchGetOwnedStatuses(
  tokenIds: bigint[],
  currentEpoch: bigint,
  nowSec: bigint,
  prepayEpochs = 1,
): Promise<OwnedTokenStatus[]> {
  if (tokenIds.length === 0) return [];
  const PER = 5; // lastEpochPaid, auditDueTimestamp, bribeBalance, hasLifeInsurance, estimateTaxesToPay
  const contracts = tokenIds.flatMap((tokenId) => [
    { ...game, functionName: "lastEpochPaid" as const, args: [tokenId] as const },
    { ...game, functionName: "auditDueTimestamp" as const, args: [tokenId] as const },
    { ...game, functionName: "bribeBalance" as const, args: [tokenId] as const },
    { ...game, functionName: "hasLifeInsurance" as const, args: [tokenId] as const },
    { ...game, functionName: "estimateTaxesToPay" as const, args: [tokenId, prepayEpochs] as const },
  ]);

  const results = await publicClient.multicall({ allowFailure: true, contracts });

  const out: OwnedTokenStatus[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const slice = results.slice(i * PER, i * PER + PER);
    if (slice.some((r) => !r || r.status === "failure")) continue;
    const [lastEpochPaid, auditDue, bribeBalance, hasLifeInsurance, estimate] = slice.map(
      (r) => r!.result,
    ) as [bigint, bigint, bigint, boolean, bigint];
    const { risk, secondsUntilKillable } = classifyRisk(lastEpochPaid, currentEpoch, auditDue, nowSec);
    out.push({
      tokenId: tokenIds[i]!.toString(),
      lastEpochPaid: lastEpochPaid.toString(),
      currentEpoch: currentEpoch.toString(),
      auditDueTimestamp: auditDue.toString(),
      secondsUntilKillable,
      bribeBalance: bribeBalance.toString(),
      hasLifeInsurance,
      risk,
      estimatedPayWei: estimate.toString(),
    });
  }
  return out;
}

export async function estimateTaxes(
  tokenId: bigint,
  numEpochs: number,
): Promise<bigint> {
  return (await publicClient.readContract({
    ...game,
    functionName: "estimateTaxesToPay",
    args: [tokenId, numEpochs],
  })) as bigint;
}

// --- calldata encoders ---

export function encodePayTaxes(tokenId: bigint, numEpochs: number): `0x${string}` {
  return encodeFunctionData({
    abi: deathAndTaxesAbi,
    functionName: "payTaxes",
    args: [tokenId, numEpochs],
  });
}

export function encodeAudit(
  fromTokenId: bigint,
  targetTokenId: bigint,
): `0x${string}` {
  return encodeFunctionData({
    abi: deathAndTaxesAbi,
    functionName: "audit",
    args: [fromTokenId, targetTokenId],
  });
}

export function encodeKill(tokenId: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: deathAndTaxesAbi,
    functionName: "kill",
    args: [tokenId],
  });
}

export function encodeUseBribe(tokenId: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: deathAndTaxesAbi,
    functionName: "useBribe",
    args: [tokenId],
  });
}

// Max ownerOf calls per multicall request. viem already chunks a multicall
// internally, but the http transport's request batching (batch:true) then coalesces
// those chunks into ONE JSON-RPC batch. A union spanning the whole minted range
// (thousands of IDs) makes that batch large enough for the RPC to reject wholesale —
// and with allowFailure:true the rejection surfaces as EVERY call failing, so NOT ONE
// token reads as live (observed against Alchemy: 6961 IDs -> 0 live, while 3000 IDs
// worked). Splitting into bounded, sequentially-awaited requests keeps each batch
// under that limit and scales as the collection grows. Sequential (not Promise.all)
// on purpose: concurrent multicalls would be re-coalesced by batch:true into the same
// oversized request this is avoiding.
const LIVENESS_MULTICALL_CHUNK = 1_000;

/** Strip burned/killed token IDs by batch-checking ownerOf on the citizens contract.
 *  ownerOf reverts for burned ERC-721 tokens; allowFailure:true lets us catch that.
 *  Chunked so a whole-collection sweep can't overflow the RPC batch (see above). */
export async function filterLiveTokenIds(
  citizens: Address,
  ids: bigint[],
): Promise<{ id: bigint; owner: Address }[]> {
  if (ids.length === 0) return [];
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const live: { id: bigint; owner: Address }[] = [];
  for (let start = 0; start < ids.length; start += LIVENESS_MULTICALL_CHUNK) {
    const chunk = ids.slice(start, start + LIVENESS_MULTICALL_CHUNK);
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: chunk.map((id) => ({
        address: citizens,
        abi: citizensAbi,
        functionName: "ownerOf" as const,
        args: [id],
      })),
    });
    for (let i = 0; i < chunk.length; i++) {
      const r = results[i];
      const id = chunk[i];
      if (!r || id === undefined) continue;
      if (r.status === "failure") continue; // burned / killed
      const owner = r.result as Address;
      if (!owner || owner === zero) continue;
      live.push({ id, owner });
    }
  }
  return live;
}

export const EPOCH_SECONDS = EPOCH_DURATION_SECONDS;
export const gameContract = game;
