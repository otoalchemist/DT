import type { Address } from "viem";
import { citizenVaultAbi } from "@dat-bot/shared";
import { publicClient } from "./chain.js";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { activity } from "./activity.js";

/**
 * Is the configured vault actually usable, and wired to US?
 *
 * A misconfigured vault fails silently and TOTALLY, which is what makes this worth a
 * dedicated check rather than a comment in the setup notes. If `operator` was never
 * pointed at the bot wallet — the easiest step to forget, because deploying and
 * configuring are separate actions — then every batch reverts `NotAuthorised`. From the
 * outside that looks like the bot working: it builds, it submits, the transaction lands,
 * it reverted. Meanwhile nothing is being paid, and citizens become killable.
 *
 * There is also no fallback once citizens are inside. Signing an owner-only call from a
 * wallet that no longer owns the citizen reverts just the same, so "carry on without the
 * vault" is not a safer path — it is the same failure with extra gas. The right response
 * to a failed check is to refuse loudly and let the operator fix the wiring.
 */

export interface VaultCheck {
  address: string;
  /** Safe to route citizens through. False = do not act; fix the wiring first. */
  ok: boolean;
  owner: string | null;
  operator: string | null;
  game: string | null;
  citizens: string | null;
  /** Human-readable reasons it is not ok, in the order worth fixing them. */
  problems: string[];
  checkedAt: number;
}

let cached: VaultCheck | null = null;
let inFlight: Promise<VaultCheck | null> | null = null;

/** Re-check at most this often. The wiring only changes when someone deliberately changes
 *  it, so this is about not hammering the RPC on every tick. */
const TTL_MS = 5 * 60_000;

const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The last known result, without triggering a read. */
export function getVaultCheck(): VaultCheck | null {
  return cached;
}

/** Drop the cache so the next check re-reads — call when the vault address changes. */
export function invalidateVaultCheck(): void {
  cached = null;
}

/**
 * Read the vault's wiring and compare it against what this bot expects.
 *
 * Returns null when no vault is configured (the ordinary case — not an error). Cached for
 * TTL_MS; concurrent callers share one read.
 */
export async function refreshVaultCheck(
  vaultAddress: string,
  expected: { operator?: string | null; citizens?: string | null },
): Promise<VaultCheck | null> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) return null;
  if (cached && cached.address.toLowerCase() === vaultAddress.toLowerCase() && Date.now() - cached.checkedAt < TTL_MS) {
    return cached;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const problems: string[] = [];
    let owner: string | null = null;
    let operator: string | null = null;
    let game: string | null = null;
    let citizens: string | null = null;

    try {
      const code = await publicClient.getCode({ address: vaultAddress as Address });
      if (!code || code === "0x") {
        problems.push(`No contract at ${vaultAddress} — check the address in data/config.json.`);
      } else {
        const v = { address: vaultAddress as Address, abi: citizenVaultAbi } as const;
        const [o, op, g, c] = await publicClient.multicall({
          allowFailure: true,
          contracts: [
            { ...v, functionName: "owner" },
            { ...v, functionName: "operator" },
            { ...v, functionName: "game" },
            { ...v, functionName: "citizens" },
          ],
        });
        owner = o.status === "success" ? (o.result as string) : null;
        operator = op.status === "success" ? (op.result as string) : null;
        game = g.status === "success" ? (g.result as string) : null;
        citizens = c.status === "success" ? (c.result as string) : null;

        if (!owner || !operator || !game || !citizens) {
          problems.push(
            "The contract at this address does not answer owner/operator/game/citizens — " +
              "it is probably not a CitizenVault.",
          );
        } else {
          // The one that silently breaks everything.
          if (!same(operator, expected.operator)) {
            problems.push(
              `Vault operator is ${operator} but this bot signs as ${expected.operator ?? "(no wallet)"} — ` +
                "every batch would revert. Call setOperator from the vault's owner key.",
            );
          }
          if (!same(game, appConfig.gameAddress)) {
            problems.push(`Vault points at game ${game}, this bot uses ${appConfig.gameAddress}.`);
          }
          if (expected.citizens && !same(citizens, expected.citizens)) {
            problems.push(
              `Vault points at citizens ${citizens}, the live collection is ${expected.citizens} — ` +
                "withdrawals would target the wrong contract.",
            );
          }
        }
      }
    } catch (err) {
      // An RPC blip must not be reported as a broken vault: that would block a boundary
      // over a network hiccup. Say it is unknown and let the next tick retry.
      logger.warn(`vault preflight could not read ${vaultAddress}: ${(err as Error).message}`);
      inFlight = null;
      return cached;
    }

    const next: VaultCheck = {
      address: vaultAddress, ok: problems.length === 0,
      owner, operator, game, citizens, problems, checkedAt: Date.now(),
    };

    // Announce only on a change, so a standing misconfiguration does not spam the log but
    // a newly broken one is impossible to miss.
    const was = cached?.ok;
    if (was !== next.ok) {
      if (next.ok) {
        logger.info(`vault ${vaultAddress} ready — operator ${operator}, owner ${owner}`);
      } else {
        logger.error(`VAULT NOT USABLE: ${problems.join(" ")}`);
        activity.add({
          kind: "error",
          status: "skipped",
          message: `Vault not usable — ${problems.join(" ")}`,
        });
      }
    }
    cached = next;
    inFlight = null;
    return next;
  })();

  return inFlight;
}
