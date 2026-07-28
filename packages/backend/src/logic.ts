import type { StrategyConfig, TokenRisk } from "@dat-bot/shared";

// Pure game/strategy logic — no I/O, so it can be unit-tested directly.

/** The gas knobs that apply to a single transaction. */
export interface GasSettings {
  maxBaseFeeGwei: number;
  priorityFeeGwei: number;
  dynamicTipEnabled: boolean;
  dynamicTipMaxGwei: number;
}

/**
 * Resolve the gas settings for a transaction. Audit/kill (`offense`) use the
 * dedicated `offense*` fields when `separateOffenseGas` is on; everything else —
 * and offense when the split is off — uses the shared base settings. Keeping
 * this in one pure function guarantees the guardrail check (`canSpend`) and the
 * fee builder (`computeFees`) always agree on which numbers apply.
 */
export function resolveGas(s: StrategyConfig, offense: boolean): GasSettings {
  if (offense && s.separateOffenseGas) {
    return {
      maxBaseFeeGwei: s.offenseMaxBaseFeeGwei,
      priorityFeeGwei: s.offensePriorityFeeGwei,
      dynamicTipEnabled: s.offenseDynamicTipEnabled,
      dynamicTipMaxGwei: s.offenseDynamicTipMaxGwei,
    };
  }
  return {
    maxBaseFeeGwei: s.maxBaseFeeGwei,
    priorityFeeGwei: s.priorityFeeGwei,
    dynamicTipEnabled: s.dynamicTipEnabled,
    dynamicTipMaxGwei: s.dynamicTipMaxGwei,
  };
}

/** A token is auditable once it is >= 2 epochs behind (matches contract `_audit`). */
export function isAuditable(lastEpochPaid: bigint, currentEpoch: bigint): boolean {
  return lastEpochPaid + 2n <= currentEpoch;
}

/** A token can be killed once it is under audit and the deadline has passed. */
export function isKillable(auditDueTimestamp: bigint, nowSec: bigint): boolean {
  return auditDueTimestamp !== 0n && nowSec > auditDueTimestamp;
}

/**
 * Whether an owned token can be used as an audit "from" token right now. The
 * contract requires the from-token to not itself be delinquent/auditable and to
 * still have audit capacity this epoch. On-chain evidence: a token one epoch
 * behind can still audit (so it need not be strictly current — up to 1 behind is
 * fine), and each token may audit `auditLimit` times per epoch (1 for a normal
 * token, higher for auditor-role tokens).
 */
export function isEligibleAuditor(
  lastEpochPaid: bigint,
  currentEpoch: bigint,
  auditsUsedThisEpoch: bigint,
  auditLimit: bigint,
): boolean {
  return !isAuditable(lastEpochPaid, currentEpoch) && auditsUsedThisEpoch < auditLimit;
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


/**
 * Wei to send for a **pre-boundary / just-in-time** payTaxes that will execute in
 * `targetEpoch` (the first block of the new epoch), computed off-chain because our
 * reads only see the current epoch.
 *
 * JIT pays exactly **one upcoming epoch's amount** — `numEpochs * targetEpoch *
 * baseTaxRateWei` — regardless of how many epochs the token is behind. This
 * matches the game's JIT semantics (arm for epoch N -> pay `N * 0.00069`) and the
 * observed boundary-block behaviour: every payTaxes that succeeded in the epoch-137
 * boundary block sent exactly `1 * 137 * base` (0.09453 ETH), while a catch-up
 * amount (`2 * 137`) was rejected with `IncorrectPayment`.
 *
 * Returns 0 if the token is already current for the target (nothing to pre-pay).
 * If the value is wrong when the tx lands, payTaxes reverts — wasted gas, no fund
 * loss (the contract refunds on revert).
 */
export function preBoundaryTaxWei(
  lastEpochPaid: bigint,
  targetEpoch: bigint,
  numEpochs: number,
  baseTaxRateWei: bigint,
): bigint {
  if (lastEpochPaid >= targetEpoch) return 0n; // already current for the target epoch
  return BigInt(numEpochs) * targetEpoch * baseTaxRateWei;
}

/**
 * How many epochs a single automatic payTaxes should request: the requested count,
 * clamped to the global `maxAutoPayEpochs` cap and to at least 1.
 *
 * NOTE: clamping `n` does NOT by itself cap the ETH spent. Verified on-chain,
 * estimateTaxesToPay(id, n) = (epochsBehind + n - 1) * currentEpoch * base — the
 * contract force-settles every delinquent epoch, so a token 2 behind is quoted 2x
 * even at n=1 (mainnet tx 0x90cdbae4… paid 0.20424 ETH = 2 * 148 * base with n=1).
 * `n` only controls how much is PREPAID on top of that mandatory catch-up.
 * Use `autoPayCapWei` to bound the actual spend.
 */
export function cappedAutoPayEpochs(requestedEpochs: number, maxAutoPayEpochs: number): number {
  return Math.max(1, Math.min(requestedEpochs, maxAutoPayEpochs));
}

/**
 * The most ETH a single automatic payment may cost, derived from the same
 * `maxAutoPayEpochs` ("Auto-Pay Limit") field the UI exposes: N epochs' worth of
 * tax at the current rate, i.e. N * currentEpoch * base.
 *
 * Since the contract cannot be asked to partially settle a delinquent token (see
 * `cappedAutoPayEpochs`), the only way to honour the limit is to DECLINE a payment
 * that would exceed it and leave the token delinquent. That is the intended
 * trade-off: the cap is a spend guardrail, not a liveness guarantee — a token left
 * unpaid stays auditable and can eventually be killed.
 *
 * With the default limit of 1 at epoch 148: a token 1 behind quotes 1x (0.10212
 * ETH) and is paid; a token 2 behind quotes 2x (0.20424 ETH) and is skipped.
 */
export function autoPayCapWei(
  maxAutoPayEpochs: number,
  currentEpoch: bigint,
  baseTaxRateWei: bigint,
): bigint {
  return BigInt(Math.max(1, maxAutoPayEpochs)) * currentEpoch * baseTaxRateWei;
}

/** Whether a quoted payment fits under the Auto-Pay Limit. A zero/absent quote is
 *  allowed through (nothing to spend); the caller still applies its own guardrails. */
export function withinAutoPayCap(
  quotedWei: bigint,
  maxAutoPayEpochs: number,
  currentEpoch: bigint,
  baseTaxRateWei: bigint,
): boolean {
  return quotedWei <= autoPayCapWei(maxAutoPayEpochs, currentEpoch, baseTaxRateWei);
}

/**
 * Resolve (and validate) the epoch a JIT arm should target.
 *
 * JIT pays a **future** epoch the instant it begins on-chain, so the target must be
 * strictly greater than the current epoch. The default is `currentEpoch + 1` (the
 * upcoming boundary); an explicit `requestedTarget` overrides it but is still held to
 * the same future-only rule.
 *
 * CRITICAL: `currentEpoch` MUST be a freshly-read chain value, not a cached one. The
 * caller (`/api/jit`) previously defaulted off `runtime.currentEpoch`, which is only
 * refreshed while the engine is RUNNING — frozen at its unlock-time value while
 * paused. If it had gone stale by an epoch, `currentEpoch + 1` resolved to an epoch
 * that had ALREADY begun, and `jitPass` fires a current/past target on the very next
 * block instead of at a boundary, spending immediately. The future-only guard here is
 * the second line of defence: even if a stale or explicit value slips through, a
 * target that isn't strictly future is rejected rather than paid.
 */
export function resolveJitTarget(
  currentEpoch: number | null,
  requestedTarget?: number,
): { ok: true; target: number } | { ok: false; error: string } {
  if (currentEpoch === null) {
    return { ok: false, error: "Unknown current epoch — start the bot once so it can read chain state" };
  }
  const target = requestedTarget ?? currentEpoch + 1;
  if (target <= currentEpoch) {
    return {
      ok: false,
      error:
        `Target epoch ${target} has already begun (current epoch is ${currentEpoch}). ` +
        `JIT pays a future epoch at its boundary — arm for ${currentEpoch + 1} or later.`,
    };
  }
  return { ok: true, target };
}

/**
 * Deterministically order items by a salted hash of their key.
 *
 * Every bot enumerates rival candidates in the same order (the NFT API returns a
 * stable list), so without this every user sweeps the same tokens first — piling
 * onto identical targets and colliding on the same races, while tokens late in the
 * list are never reached when the auditor pool runs out. Salting per engine start
 * gives each run a stable but distinct order, spreading coverage across users.
 *
 * Stable for a given salt (so a run doesn't reshuffle mid-flight) and a pure
 * permutation — same elements, just reordered.
 */
export function orderBySalt<T>(items: T[], keyOf: (item: T) => string, salt: number): T[] {
  const hash = (key: string): number => {
    let h = salt >>> 0;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0; // FNV-1a style
    }
    return h >>> 0;
  };
  return [...items]
    .map((item) => ({ item, h: hash(keyOf(item)) }))
    // Tie-break on the key so equal hashes still order deterministically.
    .sort((a, b) => a.h - b.h || keyOf(a.item).localeCompare(keyOf(b.item)))
    .map((x) => x.item);
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
 * Whether a spend of `value` (plus `gasWei` gas) is affordable without dropping
 * the wallet below `floorWei`. `committedWei` is spend already decided but not
 * yet reflected in `balanceWei` — e.g. earlier payments made in the same engine
 * tick, which the on-chain balance (read once at tick start) doesn't show yet.
 * Subtracting it makes the floor guard hold across *all* spends in a tick, not
 * just each one in isolation.
 */
export function canAffordSpend(
  balanceWei: bigint,
  committedWei: bigint,
  value: bigint,
  gasWei: bigint,
  floorWei: bigint,
): boolean {
  return (balanceWei - committedWei) - (value + gasWei) >= floorWei;
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

/**
 * The priority tip (gwei) to actually bid for a transaction given its resolved
 * gas profile and the latest block's fullness. Returns the static
 * `priorityFeeGwei` unless the profile's dynamic tip is enabled, in which case it
 * scales with block fullness up to the profile's ceiling. Applies to whichever
 * profile `resolveGas` selected — tax payments included — so it's the single
 * source of truth `computeFees` uses for every action.
 */
export function effectiveTipGwei(gas: GasSettings, gasUsed: bigint, gasLimit: bigint): number {
  if (!gas.dynamicTipEnabled) return gas.priorityFeeGwei;
  return dynamicTipGwei(gas.priorityFeeGwei, gas.dynamicTipMaxGwei, gasUsed, gasLimit);
}
