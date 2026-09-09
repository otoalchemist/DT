import { parseEventLogs } from "viem";
import { citizenVaultAbi } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { activity } from "./activity.js";
import { logger } from "./logger.js";
import { recordRaceOutcome } from "./race-timing.js";

/**
 * Per-action reporting for a batched boundary.
 *
 * Sending the whole boundary as one transaction costs the thing that made the activity log
 * worth reading: with one tx per action, a receipt per action said exactly which audit
 * landed and which reverted. Inside a batch there is one receipt for everything, and — the
 * part that matters — a call that reverts emits NO game event at all. So the game's own
 * TaxesPaid/Audited logs cannot distinguish "this audit was never attempted" from "it was
 * attempted and lost the race", which are the two things an operator actually needs to tell
 * apart when diagnosing a boundary.
 *
 * CitizenVault emits `CallResult(index, selector, ok)` for every call whether it succeeded
 * or not, and `index` is the position in the array we submitted. That is the join key, and
 * it is why the event exists.
 */

/** One collected action, enough to reconcile its activity row. */
export interface VaultActionRef {
  entryId: string;
  kind: "pay-taxes" | "use-bribe" | "audit" | "kill";
  tokenId?: string;
  targetTokenId?: string;
}

/** Matches RECEIPT_TIMEOUT_MS in strategy.ts — a boundary resolves in a block or two, and
 *  a poll that outlives the epoch is worse than no answer. */
const RECEIPT_TIMEOUT_MS = 180_000;

function describe(a: VaultActionRef): string {
  if (a.kind === "audit") return `audit #${a.targetTokenId ?? "?"} from #${a.tokenId ?? "?"}`;
  if (a.kind === "pay-taxes") return `payment for #${a.tokenId ?? "?"}`;
  if (a.kind === "use-bribe") return `bribe clear for #${a.tokenId ?? "?"}`;
  return `kill #${a.tokenId ?? "?"}`;
}

/**
 * Wait for the batch's receipt and flip each collected action to its real outcome.
 *
 * Fire-and-forget, like trackReceipt: never awaited by the tick loop, and it swallows
 * errors so a stuck poll cannot wedge the engine.
 */
export async function reconcileVaultReceipt(
  txHash: `0x${string}`,
  actions: VaultActionRef[],
  containerEntryId: string,
): Promise<void> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    const block = receipt.blockNumber?.toString();

    recordRaceOutcome(txHash, {
      blockNumber: receipt.blockNumber,
      transactionIndex: Number(receipt.transactionIndex),
      status: receipt.status === "success" ? "included" : "reverted",
    });

    // The outer call reverted, so nothing inside it happened. This is the intolerant-call
    // case: one action that was not allowed to fail took the batch down with it.
    if (receipt.status !== "success") {
      activity.update(containerEntryId, {
        status: "reverted",
        targetBlock: block,
        txHash,
        message: "Vault batch REVERTED — an action marked must-land failed, so none were applied",
      });
      for (const a of actions) {
        activity.update(a.entryId, { status: "reverted", targetBlock: block, message: `${describe(a)} — batch reverted` });
      }
      return;
    }

    const results = parseEventLogs({ abi: citizenVaultAbi, eventName: "CallResult", logs: receipt.logs });
    const okByIndex = new Map<number, boolean>();
    for (const l of results) okByIndex.set(Number(l.args.index), l.args.ok);

    let landed = 0;
    let failed = 0;
    actions.forEach((a, i) => {
      const ok = okByIndex.get(i);
      if (ok === undefined) {
        // No CallResult for this index. Should not happen — the vault emits one per call —
        // so report it as unknown rather than guessing a verdict either way.
        activity.update(a.entryId, {
          status: "submitted",
          targetBlock: block,
          message: `${describe(a)} — no result logged at index ${i}; check the tx`,
        });
        return;
      }
      if (ok) landed++;
      else failed++;
      activity.update(a.entryId, {
        status: ok ? "included" : "reverted",
        targetBlock: block,
        message: ok ? describe(a) : `${describe(a)} — reverted inside the batch (target cured or taken first)`,
      });
    });

    activity.update(containerEntryId, {
      status: "included",
      targetBlock: block,
      txHash,
      message: `Vault batch landed: ${landed} of ${actions.length} action(s) applied${failed > 0 ? `, ${failed} reverted harmlessly` : ""}`,
    });
  } catch (err) {
    // Timed out, or the bundle never landed. Leave the rows as "submitted" rather than
    // inventing a verdict — the same choice trackReceipt makes.
    logger.warn(`vault batch receipt ${txHash.slice(0, 10)}… failed: ${(err as Error).message}`);
  }
}
