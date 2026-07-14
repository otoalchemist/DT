import type { TokenRisk } from "@dat-bot/shared";

// Pure game/strategy logic — no I/O, so it can be unit-tested directly.

/** A token is auditable once it is >= 2 epochs behind (matches contract `_audit`). */
export function isAuditable(lastEpochPaid: bigint, currentEpoch: bigint): boolean {
  return lastEpochPaid + 2n <= currentEpoch;
}

/** A token can be killed once it is under audit and the deadline has passed. */
export function isKillable(auditDueTimestamp: bigint, nowSec: bigint): boolean {
  return auditDueTimestamp !== 0n && nowSec > auditDueTimestamp;
}

export interface RiskResult {
  risk: TokenRisk;
  secondsUntilKillable: number | null;
}

/** Classify an owned token's risk from on-chain fields. */
export function classifyRisk(
  lastEpochPaid: bigint,
  currentEpoch: bigint,
  auditDueTimestamp: bigint,
  nowSec: bigint,
): RiskResult {
  if (auditDueTimestamp !== 0n) {
    const secs = Number(auditDueTimestamp - nowSec);
    if (nowSec > auditDueTimestamp) return { risk: "at-risk", secondsUntilKillable: secs };
    return { risk: "audited", secondsUntilKillable: secs };
  }
  if (isAuditable(lastEpochPaid, currentEpoch)) {
    return { risk: "delinquent", secondsUntilKillable: null };
  }
  return { risk: "safe", secondsUntilKillable: null };
}


/** Would spending `total` drop the balance below the floor? */
export function wouldBreachFloor(
  balance: bigint,
  total: bigint,
  floorWei: bigint,
): boolean {
  return balance - total < floorWei;
}

/**
 * Scale the priority-fee tip by how full the latest block is. Blocks target 50%
 * fullness under EIP-1559; above that, inclusion is contested and a higher tip
 * helps. Returns `baseTipGwei` at/below 50% fill, ramping linearly to
 * `maxTipGwei` at 100% fill. Clamped so it never drops below the base or
 * exceeds the max. Degrades to `baseTipGwei` on missing/zero gas limit.
 */
export function dynamicTipGwei(
  baseTipGwei: number,
  maxTipGwei: number,
  gasUsed: bigint,
  gasLimit: bigint,
): number {
  if (gasLimit <= 0n) return baseTipGwei;
  const ceil = Math.max(baseTipGwei, maxTipGwei); // guard against maxGwei < base
  const fill = Number(gasUsed) / Number(gasLimit); // 0..1
  if (fill <= 0.5) return baseTipGwei;
  const t = (fill - 0.5) / 0.5; // 0 at half-full, 1 at full
  const scaled = baseTipGwei + (ceil - baseTipGwei) * Math.min(t, 1);
  return Math.min(scaled, ceil);
}
